import { describe, expect, it } from "vitest";
import { buildInjectionPrompt } from "../src/engagement.js";

const baseArgs = {
  room: "dev",
  agentName: "Claude",
  agentIdentifier: "cc",
  trigger: {
    senderName: "Alice",
    content: "@cc please review",
    createdAt: "2026-04-23T10:00:00Z",
  },
};

describe("buildInjectionPrompt", () => {
  it("marks buffer empty when no context and no drops", () => {
    const prompt = buildInjectionPrompt({
      ...baseArgs,
      context: [],
    });
    expect(prompt).toContain("- (no buffered context)");
    expect(prompt).not.toContain("[agent-room]");
    expect(prompt).toContain("@cc please review");
  });

  it("surfaces buffered context without the empty placeholder", () => {
    const prompt = buildInjectionPrompt({
      ...baseArgs,
      context: [
        { senderName: "Bob", content: "earlier thought", createdAt: "2026-04-23T09:59:00Z" },
      ],
    });
    expect(prompt).toContain("- [Bob] earlier thought");
    expect(prompt).not.toContain("- (no buffered context)");
  });

  it("includes a dropped-count sentinel pointing at catch_up", () => {
    const prompt = buildInjectionPrompt({
      ...baseArgs,
      context: [],
      droppedBefore: 5,
    });
    expect(prompt).toContain("5 earlier messages dropped");
    expect(prompt).toContain("agent_room.catch_up");
    expect(prompt).not.toContain("- (no buffered context)");
  });

  it("uses singular noun when exactly one message was dropped", () => {
    const prompt = buildInjectionPrompt({
      ...baseArgs,
      context: [],
      droppedBefore: 1,
    });
    expect(prompt).toContain("1 earlier message dropped");
  });

  it("treats missing/zero droppedBefore as no-drop", () => {
    const prompt = buildInjectionPrompt({
      ...baseArgs,
      context: [],
      droppedBefore: 0,
    });
    expect(prompt).not.toContain("dropped");
    expect(prompt).toContain("- (no buffered context)");
  });

  it("lists dropped sentinel above surviving buffered messages", () => {
    const prompt = buildInjectionPrompt({
      ...baseArgs,
      context: [
        { senderName: "Bob", content: "still here", createdAt: "2026-04-23T09:59:30Z" },
      ],
      droppedBefore: 3,
    });
    const droppedIndex = prompt.indexOf("3 earlier messages dropped");
    const survivingIndex = prompt.indexOf("still here");
    expect(droppedIndex).toBeGreaterThan(-1);
    expect(survivingIndex).toBeGreaterThan(-1);
    expect(droppedIndex).toBeLessThan(survivingIndex);
  });
});
