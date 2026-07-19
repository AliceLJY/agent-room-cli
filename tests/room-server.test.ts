import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertSafeBindHost,
  MAX_JSON_BODY_BYTES,
  RoomHub,
  startRoomServer,
} from "../src/room-server.js";
import { JsonlRoomStore } from "../src/store.js";

describe("RoomHub.registerParticipant", () => {
  let dir: string;
  let hub: RoomHub;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-room-test-"));
    hub = new RoomHub(new JsonlRoomStore(dir));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("initial agent registration is unconfirmed (launch attempted ≠ ready)", async () => {
    const p = await hub.registerParticipant("dev", {
      id: "p_cc",
      name: "cc",
      identifier: "cc",
      type: "agent",
      client: "claude",
      mode: "mentioned",
    });
    expect(p.confirmed).toBe(false);
  });

  it("MCP re-registration confirms without resetting mode/client/joinedAt", async () => {
    const first = await hub.registerParticipant("dev", {
      id: "p_cc",
      name: "Claude",
      identifier: "cc",
      type: "agent",
      client: "claude",
      mode: "everyone",
    });
    // Legacy/internal clients may re-register with only id + name; preserve the alias.
    const second = await hub.registerParticipant("dev", {
      id: "p_cc",
      name: "Claude",
      type: "agent",
      confirmed: true,
    });
    expect(second.confirmed).toBe(true);
    expect(second.mode).toBe("everyone");
    expect(second.client).toBe("claude");
    expect(second.identifier).toBe("cc");
    expect(second.joinedAt).toBe(first.joinedAt);
  });

  it("shares one cold-start load across concurrent first registrations", async () => {
    const store = new BlockingRoomStore(dir);
    const coldHub = new RoomHub(store);

    const first = coldHub.registerParticipant("cold", {
      id: "p_cc",
      name: "Claude",
      identifier: "cc",
      type: "agent",
    });
    const second = coldHub.registerParticipant("cold", {
      id: "p_codex",
      name: "Codex",
      identifier: "codex",
      type: "agent",
    });

    store.release();
    await Promise.all([first, second]);

    const snapshot = await coldHub.snapshot("cold");
    expect(store.loadCalls).toBe(1);
    expect(snapshot.participants.map((p) => p.id).sort()).toEqual(["p_cc", "p_codex"]);
  });

  it("confirmed survives a later unconfirmed re-registration", async () => {
    await hub.registerParticipant("dev", {
      id: "p_codex",
      name: "codex",
      type: "agent",
      client: "codex",
      confirmed: true,
    });
    const again = await hub.registerParticipant("dev", {
      id: "p_codex",
      name: "codex",
      type: "agent",
    });
    expect(again.confirmed).toBe(true);
    expect(again.client).toBe("codex");
  });
});

class BlockingRoomStore extends JsonlRoomStore {
  loadCalls = 0;
  private releaseGate!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.releaseGate = resolve;
  });

  override async load(room: string) {
    this.loadCalls += 1;
    await this.gate;
    return super.load(room);
  }

  release(): void {
    this.releaseGate();
  }
}

describe("room HTTP server safety", () => {
  let dir: string;
  let hub: RoomHub;
  let server: Awaited<ReturnType<typeof startRoomServer>> | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-room-http-test-"));
    hub = new RoomHub(new JsonlRoomStore(dir));
  });

  afterEach(async () => {
    await server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses non-loopback binds unless the caller explicitly accepts no auth", async () => {
    await expect(startRoomServer({ hub, port: 0, host: "0.0.0.0" })).rejects.toThrow(
      "refusing unauthenticated non-loopback bind",
    );
    expect(() => assertSafeBindHost("192.168.1.10")).toThrow(
      "refusing unauthenticated non-loopback bind",
    );
    expect(() => assertSafeBindHost("0.0.0.0", true)).not.toThrow();
    expect(() => assertSafeBindHost("127.9.8.7")).not.toThrow();
    expect(() => assertSafeBindHost("::1")).not.toThrow();
    expect(() => assertSafeBindHost("localhost")).not.toThrow();
  });

  it("serves real loopback HTTP and SSE without wildcard CORS", async () => {
    server = await startRoomServer({ hub, port: 0, host: "127.0.0.1" });
    const participantResponse = await fetch(`${server.url}/rooms/dev/participants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "p_human", name: "human", type: "human" }),
    });
    expect(participantResponse.status).toBe(200);
    expect(participantResponse.headers.get("access-control-allow-origin")).toBeNull();

    const controller = new AbortController();
    const streamResponse = await fetch(`${server.url}/rooms/dev/stream`, {
      signal: controller.signal,
    });
    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get("access-control-allow-origin")).toBeNull();
    const reader = streamResponse.body!.getReader();

    try {
      expect(await readStreamUntil(reader, ": connected")).toContain(": connected");
      const messageResponse = await fetch(`${server.url}/rooms/dev/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          senderId: "p_human",
          senderName: "human",
          senderType: "human",
          content: "hello",
        }),
      });
      expect(messageResponse.status).toBe(200);
      expect(await readStreamUntil(reader, "event: message")).toContain("event: message");
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }
  });

  it("rejects oversized, non-JSON, and malformed request bodies", async () => {
    server = await startRoomServer({ hub, port: 0, host: "127.0.0.1" });
    const endpoint = `${server.url}/rooms/dev/messages`;

    const oversized = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x".repeat(MAX_JSON_BODY_BYTES) }),
    });
    expect(oversized.status).toBe(413);

    const wrongType = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ content: "hello" }),
    });
    expect(wrongType.status).toBe(415);

    const malformed = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
  });
});

async function readStreamUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  marker: string,
  timeoutMs = 2_000,
): Promise<string> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let text = "";
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const result = await readWithTimeout(reader, remaining);
    if (result.done) break;
    text += decoder.decode(result.value, { stream: true });
    if (text.includes(marker)) return text;
  }
  throw new Error(`SSE marker not received: ${marker}`);
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("SSE read timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
