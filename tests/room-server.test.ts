import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertSafeBindHost,
  MAX_JSON_BODY_BYTES,
  MAX_MESSAGE_QUERY_LIMIT,
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

describe("RoomHub capacity", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-room-capacity-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reserves room capacity across concurrent cold starts and keeps existing rooms usable", async () => {
    const store = new BlockingRoomStore(dir);
    const hub = new RoomHub(store, { maxLoadedRooms: 1 });

    const firstLoad = hub.snapshot("first");
    await expect(hub.snapshot("second")).rejects.toThrow(
      "loaded room capacity reached (1); existing rooms remain available",
    );

    store.release();
    await expect(firstLoad).resolves.toMatchObject({ room: "first" });
    await expect(hub.snapshot("first")).resolves.toMatchObject({ room: "first" });
  });

  it("retains only the newest in-memory messages and events without truncating JSONL", async () => {
    const store = new JsonlRoomStore(dir);
    const options = {
      maxMessagesPerRoom: 2,
      maxEventsPerRoom: 2,
    };
    const hub = new RoomHub(store, options);

    for (const content of ["one", "two", "three"]) {
      await hub.sendMessage("dev", {
        senderId: "p_human",
        senderName: "human",
        senderType: "human",
        content,
      });
    }

    expect((await hub.snapshot("dev")).messages.map((message) => message.content)).toEqual([
      "two",
      "three",
    ]);
    expect((await hub.events("dev")).map((event) => event.type)).toEqual([
      "message",
      "message",
    ]);
    expect(await store.load("dev")).toHaveLength(3);

    const reloaded = new RoomHub(store, options);
    expect((await reloaded.snapshot("dev")).messages.map((message) => message.content)).toEqual([
      "two",
      "three",
    ]);
    expect(await reloaded.events("dev")).toHaveLength(2);
  });

  it("serializes concurrent appends so live and reloaded retention order match", async () => {
    const store = new BlockingAppendStore(dir);
    const options = { maxMessagesPerRoom: 1, maxEventsPerRoom: 1 };
    const hub = new RoomHub(store, options);

    const first = hub.sendMessage("dev", messageInput("first"));
    const second = hub.sendMessage("dev", messageInput("second"));
    await store.firstAppendStarted;
    expect(store.appendedContents).toEqual(["first"]);

    store.releaseFirstAppend();
    await Promise.all([first, second]);
    expect(store.appendedContents).toEqual(["first", "second"]);
    expect((await hub.snapshot("dev")).messages.map((message) => message.content)).toEqual([
      "second",
    ]);

    const reloaded = new RoomHub(store, options);
    expect((await reloaded.snapshot("dev")).messages.map((message) => message.content)).toEqual([
      "second",
    ]);
  });

  it("does not retain or evict records when an append fails", async () => {
    const store = new FailNextAppendStore(dir);
    const options = { maxMessagesPerRoom: 2, maxEventsPerRoom: 2 };
    const hub = new RoomHub(store, options);
    await hub.sendMessage("dev", messageInput("one"));
    await hub.sendMessage("dev", messageInput("two"));

    store.failNextAppend();
    await expect(hub.sendMessage("dev", messageInput("failed"))).rejects.toThrow(
      "simulated append failure",
    );
    expect((await hub.snapshot("dev")).messages.map((message) => message.content)).toEqual([
      "one",
      "two",
    ]);

    await hub.sendMessage("dev", messageInput("three"));
    const live = (await hub.snapshot("dev")).messages.map((message) => message.content);
    const reloaded = new RoomHub(store, options);
    const afterReload = (await reloaded.snapshot("dev")).messages.map((message) => message.content);
    expect(live).toEqual(["two", "three"]);
    expect(afterReload).toEqual(live);
  });

  it("cold-loads through streaming replay rather than materializing the full log", async () => {
    const store = new ReplayTrackingStore(dir);
    for (const content of ["one", "two", "three"]) {
      await store.append(messageEvent(content));
    }
    const hub = new RoomHub(store, { maxMessagesPerRoom: 2, maxEventsPerRoom: 2 });

    expect((await hub.snapshot("dev")).messages.map((message) => message.content)).toEqual([
      "two",
      "three",
    ]);
    expect(store.replayCalls).toBe(1);
    expect(store.loadCalls).toBe(0);
  });

  it("rejects invalid capacity configuration", () => {
    const store = new JsonlRoomStore(dir);
    expect(() => new RoomHub(store, { maxLoadedRooms: 0 })).toThrow(
      "maxLoadedRooms must be a positive integer",
    );
    expect(() => new RoomHub(store, { maxMessagesPerRoom: Number.NaN })).toThrow(
      "maxMessagesPerRoom must be a positive integer",
    );
  });
});

class BlockingRoomStore extends JsonlRoomStore {
  loadCalls = 0;
  private releaseGate!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.releaseGate = resolve;
  });

  override async replay(
    room: string,
    onEvent: Parameters<JsonlRoomStore["replay"]>[1],
  ): Promise<void> {
    this.loadCalls += 1;
    await this.gate;
    await super.replay(room, onEvent);
  }

  release(): void {
    this.releaseGate();
  }
}

class BlockingAppendStore extends JsonlRoomStore {
  readonly appendedContents: string[] = [];
  private markFirstAppendStarted!: () => void;
  readonly firstAppendStarted = new Promise<void>((resolve) => {
    this.markFirstAppendStarted = resolve;
  });
  private releaseFirst!: () => void;
  private readonly firstGate = new Promise<void>((resolve) => {
    this.releaseFirst = resolve;
  });

  override async append(event: Parameters<JsonlRoomStore["append"]>[0]): Promise<void> {
    const content = event.type === "message" ? event.message.content : event.type;
    this.appendedContents.push(content);
    if (this.appendedContents.length === 1) {
      this.markFirstAppendStarted();
      await this.firstGate;
    }
    await super.append(event);
  }

  releaseFirstAppend(): void {
    this.releaseFirst();
  }
}

class FailNextAppendStore extends JsonlRoomStore {
  private shouldFail = false;

  failNextAppend(): void {
    this.shouldFail = true;
  }

  override async append(event: Parameters<JsonlRoomStore["append"]>[0]): Promise<void> {
    if (this.shouldFail) {
      this.shouldFail = false;
      throw new Error("simulated append failure");
    }
    await super.append(event);
  }
}

class ReplayTrackingStore extends JsonlRoomStore {
  replayCalls = 0;
  loadCalls = 0;

  override async replay(
    room: string,
    onEvent: Parameters<JsonlRoomStore["replay"]>[1],
  ): Promise<void> {
    this.replayCalls += 1;
    await super.replay(room, onEvent);
  }

  override async load(room: string) {
    this.loadCalls += 1;
    return super.load(room);
  }
}

function messageInput(content: string) {
  return {
    senderId: "p_human",
    senderName: "human",
    senderType: "human" as const,
    content,
  };
}

function messageEvent(content: string): Parameters<JsonlRoomStore["append"]>[0] {
  const createdAt = new Date().toISOString();
  return {
    id: `evt_${content}`,
    room: "dev",
    type: "message",
    message: {
      id: `msg_${content}`,
      room: "dev",
      senderId: "p_human",
      senderName: "human",
      senderType: "human",
      content,
      mentions: [],
      createdAt,
    },
    createdAt,
  };
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

  it("validates message limits instead of treating zero or NaN as all messages", async () => {
    const contents = Array.from({ length: 51 }, (_value, index) => `message-${index + 1}`);
    for (const content of contents) {
      await hub.sendMessage("dev", {
        senderId: "p_human",
        senderName: "human",
        senderType: "human",
        content,
      });
    }
    server = await startRoomServer({ hub, port: 0, host: "127.0.0.1" });
    const endpoint = `${server.url}/rooms/dev/messages`;

    for (const invalid of ["0", "NaN", "1.5", String(MAX_MESSAGE_QUERY_LIMIT + 1)]) {
      const response = await fetch(`${endpoint}?limit=${invalid}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: `limit must be an integer from 1 to ${MAX_MESSAGE_QUERY_LIMIT}`,
      });
    }

    const valid = await fetch(`${endpoint}?limit=2`);
    expect(valid.status).toBe(200);
    expect((await valid.json() as Array<{ content: string }>).map((message) => message.content))
      .toEqual(["message-50", "message-51"]);

    const defaulted = await fetch(endpoint);
    expect(defaulted.status).toBe(200);
    const defaultedMessages = await defaulted.json() as Array<{ content: string }>;
    expect(defaultedMessages).toHaveLength(50);
    expect(defaultedMessages[0].content).toBe("message-2");

    await expect(hub.messages("dev", 0)).rejects.toThrow("limit must be an integer");
    await expect(hub.messages("dev", Number.NaN)).rejects.toThrow("limit must be an integer");
  });

  it("returns 503 for a new room after loaded-room capacity is reached", async () => {
    hub = new RoomHub(new JsonlRoomStore(dir), { maxLoadedRooms: 1 });
    await hub.snapshot("first");
    server = await startRoomServer({ hub, port: 0, host: "127.0.0.1" });

    const response = await fetch(`${server.url}/rooms/second`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "loaded room capacity reached (1); existing rooms remain available",
    });
    expect((await fetch(`${server.url}/rooms/first`)).status).toBe(200);
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
