export type ParticipantType = "human" | "agent";
export type AgentClient = "claude" | "codex" | "human" | "unknown";

export type EngagementMode =
  | "mentioned"
  | "people"
  | "agents"
  | "everyone"
  | "silent";

export type EventDisposition = "trigger" | "content" | "drop";

export interface Participant {
  id: string;
  room: string;
  name: string;
  identifier: string;
  type: ParticipantType;
  client: AgentClient;
  mode: EngagementMode;
  joinedAt: string;
  lastSeenAt: string;
  status: "online" | "offline";
  /**
   * For agents: true once the agent's own MCP server re-registered, i.e. the
   * CLI really spawned and can hear the room. The launcher's initial
   * registration leaves this false ("launch attempted" is not "ready").
   */
  confirmed?: boolean;
}

export interface RoomMessage {
  id: string;
  room: string;
  senderId: string;
  senderName: string;
  senderType: ParticipantType;
  content: string;
  mentions: string[];
  createdAt: string;
}

export type RoomEvent =
  | {
      id: string;
      room: string;
      type: "participant_joined";
      participant: Participant;
      createdAt: string;
    }
  | {
      id: string;
      room: string;
      type: "participant_left";
      participant: Participant;
      createdAt: string;
    }
  | {
      id: string;
      room: string;
      type: "message";
      message: RoomMessage;
      createdAt: string;
    };

export interface RoomSnapshot {
  room: string;
  participants: Participant[];
  messages: RoomMessage[];
}

export interface RegisterParticipantInput {
  id?: string;
  name: string;
  identifier?: string;
  type?: ParticipantType;
  client?: AgentClient;
  mode?: EngagementMode;
  confirmed?: boolean;
}

export interface SendMessageInput {
  senderId: string;
  senderName?: string;
  senderType?: ParticipantType;
  content: string;
}

export interface AgentRuntimeOptions {
  client: "claude" | "codex";
  name: string;
  identifier: string;
  serverUrl: string;
  room: string;
  mode: EngagementMode;
  attach: boolean;
  keep: boolean;
  extraArgs: string[];
}

export interface InjectionPayload {
  room: string;
  agentName: string;
  agentIdentifier: string;
  context: RoomMessage[];
  trigger: RoomMessage;
}
