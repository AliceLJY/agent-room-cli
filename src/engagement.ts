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
}): string {
  const contextLines = payload.context.length
    ? payload.context.map((m) => `- [${m.senderName}] ${oneLine(m.content)}`).join("\n")
    : "- (no buffered context)";

  return [
    "[agent-room event]",
    `You are ${payload.agentName} (@${payload.agentIdentifier}) in room "${payload.room}".`,
    "Use the agent_room.send_message MCP tool to reply to the room when a reply is useful.",
    "Do not reply to this room event only in plain terminal text; send the room-facing answer through the MCP tool.",
    "",
    "Buffered context since your last trigger:",
    contextLines,
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
