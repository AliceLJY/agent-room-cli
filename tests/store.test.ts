import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonlRoomStore } from "../src/store.js";
import type { RoomEvent } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-room-store-"));
  tempDirs.push(dir);
  return dir;
}

function event(overrides: Partial<RoomEvent> = {}): RoomEvent {
  return {
    id: "evt_1",
    room: "dev",
    type: "message",
    createdAt: "2026-04-21T00:00:00.000Z",
    message: {
      id: "msg_1",
      room: "dev",
      senderId: "p_alice",
      senderName: "Alice",
      senderType: "human",
      content: "hello",
      mentions: [],
      createdAt: "2026-04-21T00:00:00.000Z",
    },
    ...overrides,
  };
}

describe("JsonlRoomStore", () => {
  it("round-trips appended events through load", async () => {
    const root = await tempRoot();
    const store = new JsonlRoomStore(root);
    const first = event();
    const second = event({
      id: "evt_2",
      message: {
        ...event().message,
        id: "msg_2",
        content: "second",
      },
    });

    await store.append(first);
    await store.append(second);

    await expect(store.load("dev")).resolves.toEqual([first, second]);
  });

  it("returns [] when the room file is missing", async () => {
    const root = await tempRoot();
    const store = new JsonlRoomStore(root);

    await expect(store.load("missing")).resolves.toEqual([]);
  });

  it("skips corrupted lines and warns with the line number", async () => {
    const root = await tempRoot();
    const good = event();
    await writeFile(
      join(root, "dev.jsonl"),
      `${JSON.stringify(good)}\n{bad json}\n\n`,
      "utf8",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new JsonlRoomStore(root);

    await expect(store.load("dev")).resolves.toEqual([good]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("dev.jsonl:2");
  });
});
