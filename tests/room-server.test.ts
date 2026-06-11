import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RoomHub } from "../src/room-server.js";
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
      name: "cc",
      identifier: "cc",
      type: "agent",
      client: "claude",
      mode: "everyone",
    });
    // The MCP server only knows id + name; the merge must keep the rest.
    const second = await hub.registerParticipant("dev", {
      id: "p_cc",
      name: "cc",
      type: "agent",
      confirmed: true,
    });
    expect(second.confirmed).toBe(true);
    expect(second.mode).toBe("everyone");
    expect(second.client).toBe("claude");
    expect(second.joinedAt).toBe(first.joinedAt);
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
