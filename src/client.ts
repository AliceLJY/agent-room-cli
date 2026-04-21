import type {
  EngagementMode,
  Participant,
  RegisterParticipantInput,
  RoomEvent,
  RoomMessage,
  RoomSnapshot,
  SendMessageInput,
} from "./types.js";

export class RoomClient {
  constructor(
    private readonly serverUrl: string,
    private readonly room: string,
  ) {}

  async register(input: RegisterParticipantInput): Promise<Participant> {
    return this.request<Participant>("POST", `/participants`, input);
  }

  async setMode(participantId: string, mode: EngagementMode): Promise<Participant> {
    return this.request<Participant>("PATCH", `/participants/${participantId}/mode`, { mode });
  }

  async send(input: SendMessageInput): Promise<RoomMessage> {
    return this.request<RoomMessage>("POST", "/messages", input);
  }

  async messages(limit = 50): Promise<RoomMessage[]> {
    return this.request<RoomMessage[]>("GET", `/messages?limit=${limit}`);
  }

  async snapshot(): Promise<RoomSnapshot> {
    return this.request<RoomSnapshot>("GET", "");
  }

  async stream(onEvent: (event: RoomEvent) => void, signal?: AbortSignal): Promise<void> {
    const url = `${this.baseUrl()}/stream`;
    const res = await fetch(url, { signal });
    if (!res.ok || !res.body) {
      throw new Error(`stream failed: ${res.status} ${res.statusText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() || "";
      for (const block of blocks) {
        const data = block
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6);
        if (data) onEvent(JSON.parse(data) as RoomEvent);
      }
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl()}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) {
      throw new Error(json?.error || `${method} ${path} failed: ${res.status}`);
    }
    return json as T;
  }

  private baseUrl(): string {
    return `${this.serverUrl.replace(/\/$/, "")}/rooms/${encodeURIComponent(this.room)}`;
  }
}
