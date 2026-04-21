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

  async events(since?: string): Promise<RoomEvent[]> {
    const query = since ? `?since=${encodeURIComponent(since)}` : "";
    return this.request<RoomEvent[]>("GET", `/events${query}`);
  }

  async stream(onEvent: (event: RoomEvent) => void, signal?: AbortSignal): Promise<void> {
    let since: string | undefined;
    let attempts = 0;
    const seen = new Set<string>();

    const handleEvent = (event: RoomEvent) => {
      if (seen.has(event.id)) return;
      seen.add(event.id);
      if (seen.size > 1000) {
        const oldest = seen.values().next().value;
        if (oldest) seen.delete(oldest);
      }
      since = event.createdAt;
      onEvent(event);
    };

    while (!signal?.aborted) {
      try {
        if (since) {
          const missed = await this.events(since);
          for (const event of missed) handleEvent(event);
        }
        await this.openStream(handleEvent, signal);
        attempts = 0;
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) return;
        attempts += 1;
      }
      if (!signal?.aborted) {
        await sleep(Math.min(5000, 500 * Math.max(1, attempts)), signal);
      }
    }
  }

  private async openStream(onEvent: (event: RoomEvent) => void, signal?: AbortSignal): Promise<void> {
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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
