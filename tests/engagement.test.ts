import { describe, expect, it } from "vitest";
import { classifyEvent } from "../src/engagement.js";
import { detectMentions } from "../src/room-server.js";
import type { Participant, RoomEvent } from "../src/types.js";

const cc: Participant = {
  id: "p_cc",
  room: "dev",
  name: "Claude",
  identifier: "cc",
  type: "agent",
  client: "claude",
  mode: "mentioned",
  joinedAt: "2026-04-21T00:00:00.000Z",
  lastSeenAt: "2026-04-21T00:00:00.000Z",
  status: "online",
};

const codex: Participant = {
  ...cc,
  id: "p_codex",
  name: "Codex",
  identifier: "codex",
  client: "codex",
};

function message(content: string, mentions: string[], senderType: "human" | "agent" = "human"): RoomEvent {
  return {
    id: "evt_1",
    room: "dev",
    type: "message",
    createdAt: "2026-04-21T00:00:00.000Z",
    message: {
      id: "msg_1",
      room: "dev",
      senderId: "p_human",
      senderName: "Alice",
      senderType,
      content,
      mentions,
      createdAt: "2026-04-21T00:00:00.000Z",
    },
  };
}

describe("mention detection", () => {
  it("matches identifiers and @all", () => {
    expect(detectMentions("@cc and @all please", [cc, codex])).toEqual(["p_cc", "@all"]);
  });

  it("matches display names case-insensitively", () => {
    expect(detectMentions("@codex @CLAUDE", [cc, codex])).toEqual(["p_codex", "p_cc"]);
  });
});

describe("engagement policy", () => {
  it("triggers mentioned agent", () => {
    expect(classifyEvent(message("@cc look", ["p_cc"]), "p_cc", "mentioned")).toBe("trigger");
  });

  it("buffers non-mentioned messages in mentioned mode", () => {
    expect(classifyEvent(message("@cc look", ["p_cc"]), "p_codex", "mentioned")).toBe("content");
  });

  it("triggers everyone on @all", () => {
    expect(classifyEvent(message("@all settle this", ["@all"]), "p_codex", "mentioned")).toBe("trigger");
  });

  it("buffers agent messages in mentioned mode even if they mention another agent", () => {
    expect(classifyEvent(message("@codex please add your view", ["p_codex"], "agent"), "p_codex", "mentioned")).toBe("content");
  });

  it("buffers agent @all messages in mentioned mode", () => {
    expect(classifyEvent(message("@all I have replied", ["@all"], "agent"), "p_codex", "mentioned")).toBe("content");
  });

  it("drops self messages", () => {
    const event = message("my own reply", []);
    event.message.senderId = "p_cc";
    expect(classifyEvent(event, "p_cc", "everyone")).toBe("drop");
  });

  it("can trigger on people messages", () => {
    expect(classifyEvent(message("human asks", []), "p_cc", "people")).toBe("trigger");
  });

  it("buffers human messages in agents mode", () => {
    expect(classifyEvent(message("human asks", []), "p_cc", "agents")).toBe("content");
  });
});
