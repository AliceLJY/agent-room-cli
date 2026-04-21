import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  listArchives,
  renderArchiveMarkdown,
  resolveArchivePath,
  writeArchive,
} from "../src/archive.js";
import type { Participant, RoomMessage, RoomSnapshot } from "../src/types.js";

const alice: Participant = {
  id: "p_alice",
  room: "dev",
  name: "Alice",
  identifier: "alice",
  type: "human",
  client: "human",
  mode: "mentioned",
  joinedAt: "2026-04-21T08:00:00.000Z",
  lastSeenAt: "2026-04-21T09:00:00.000Z",
  status: "online",
};

const cc: Participant = {
  ...alice,
  id: "p_cc",
  name: "Claude",
  identifier: "cc",
  type: "agent",
  client: "claude",
};

function snapshotFixture(messages: RoomMessage[]): RoomSnapshot {
  return { room: "dev", participants: [alice, cc], messages };
}

function message(overrides: Partial<RoomMessage>): RoomMessage {
  return {
    id: "msg_1",
    room: "dev",
    senderId: "p_alice",
    senderName: "Alice",
    senderType: "human",
    content: "hello",
    mentions: [],
    createdAt: "2026-04-21T08:05:00.000Z",
    ...overrides,
  };
}

describe("renderArchiveMarkdown", () => {
  const now = new Date("2026-04-21T10:00:00.000Z");

  it("includes frontmatter with counts and participants", () => {
    const out = renderArchiveMarkdown(snapshotFixture([]), now);
    expect(out).toMatch(/^---\n/);
    expect(out).toContain("room: dev");
    expect(out).toContain("message_count: 0");
    expect(out).toContain("participant_count: 2");
    expect(out).toContain("Alice (@alice, human/human)");
    expect(out).toContain("Claude (@cc, agent/claude)");
  });

  it("resolves mention ids to @handles", () => {
    const out = renderArchiveMarkdown(
      snapshotFixture([
        message({ content: "@cc thoughts?", mentions: ["p_cc"] }),
      ]),
      now,
    );
    expect(out).toContain("→ @cc");
    expect(out).not.toContain("→ p_cc");
  });

  it("shows sender handle from participant map", () => {
    const out = renderArchiveMarkdown(
      snapshotFixture([
        message({ senderId: "p_cc", senderName: "Claude", senderType: "agent", content: "sure" }),
      ]),
      now,
    );
    expect(out).toContain("Claude (@cc)");
    expect(out).not.toContain("@p_cc");
  });

  it("keeps @all unexpanded", () => {
    const out = renderArchiveMarkdown(
      snapshotFixture([message({ content: "@all", mentions: ["@all"] })]),
      now,
    );
    expect(out).toContain("→ @all");
  });

  it("shows empty marker when no messages", () => {
    const out = renderArchiveMarkdown(snapshotFixture([]), now);
    expect(out).toContain("_(no messages)_");
  });
});

describe("listArchives + writeArchive round-trip", () => {
  const root = mkdtemp(join(tmpdir(), "agent-room-archive-"));

  afterAll(async () => {
    const dir = await root;
    await rm(dir, { recursive: true, force: true });
  });

  it("returns [] on missing archive root", async () => {
    const missing = await mkdtemp(join(tmpdir(), "agent-room-archive-empty-"));
    try {
      const entries = await listArchives(missing);
      expect(entries).toEqual([]);
    } finally {
      await rm(missing, { recursive: true, force: true });
    }
  });

  it("writes an archive and lists it with metadata", async () => {
    const dir = await root;
    const now = new Date("2026-04-21T11:00:00.000Z");
    const loc = resolveArchivePath(dir, "dev", now);
    await writeArchive(loc, snapshotFixture([message({ content: "first" })]), now);

    const entries = await listArchives(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0].room).toBe("dev");
    expect(entries[0].messageCount).toBe(1);
    expect(entries[0].participantCount).toBe(2);
    expect(entries[0].createdAt).toBe("2026-04-21T11:00:00.000Z");
    expect(entries[0].file).toBe(loc.file);

    const raw = await readFile(loc.file, "utf8");
    expect(raw).toContain("first");
  });
});
