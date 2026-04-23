import type { EngagementMode, EventDisposition, RoomEvent } from "./types.js";

export function classifyEvent(
  event: RoomEvent,
  selfId: string,
  mode: EngagementMode,
): EventDisposition {
  if (event.type !== "message") return "content";
  const message = event.message;
  if (message.senderId === selfId) return "drop";

  switch (mode) {
    case "everyone":
      return "trigger";
    case "people":
      return message.senderType === "human" ? "trigger" : "content";
    case "agents":
      return message.senderType === "agent" ? "trigger" : "content";
    case "silent":
      return "content";
    case "mentioned":
    default:
      return message.senderType === "human" && isMentioned(message.mentions, selfId) ? "trigger" : "content";
  }
}

function isMentioned(mentions: string[], selfId: string): boolean {
  return mentions.includes(selfId) || mentions.includes("@all");
}

export function buildInjectionPrompt(payload: {
  room: string;
  agentName: string;
  agentIdentifier: string;
  context: Array<{ senderName: string; content: string; createdAt: string }>;
  trigger: { senderName: string; content: string; createdAt: string };
  /**
   * Messages silently dropped from the buffer before the retained ones
   * (e.g. because the per-agent buffer hit its cap). Surfacing the count
   * keeps design-principles §4 pull-by-reference honest: the relay does
   * not auto-inject the dropped content, but it does tell the agent those
   * messages exist so it can choose to pull them via agent_room.catch_up.
   */
  droppedBefore?: number;
}): string {
  const contextParts: string[] = [];
  const dropped = Math.max(0, payload.droppedBefore ?? 0);
  if (dropped > 0) {
    const noun = dropped === 1 ? "message" : "messages";
    contextParts.push(
      `- [agent-room] ${dropped} earlier ${noun} dropped to keep buffer small; call agent_room.catch_up if you need them.`,
    );
  }
  if (payload.context.length) {
    for (const m of payload.context) {
      contextParts.push(`- [${m.senderName}] ${oneLine(m.content)}`);
    }
  } else if (dropped === 0) {
    contextParts.push("- (no buffered context)");
  }

  return [
    "[agent-room event]",
    `You are ${payload.agentName} (@${payload.agentIdentifier}) in room "${payload.room}".`,
    "Use the agent_room.send_message MCP tool to reply to the room when a reply is useful.",
    "Do not reply to this room event only in plain terminal text; send the room-facing answer through the MCP tool.",
    "",
    "Buffered context since your last trigger:",
    contextParts.join("\n"),
    "",
    `Triggered message from ${payload.trigger.senderName}:`,
    oneLine(payload.trigger.content),
    "",
    "If the message asks you to respond, send one concise room message. If no response is needed, do nothing.",
    "[/agent-room event]",
  ].join("\n");
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
