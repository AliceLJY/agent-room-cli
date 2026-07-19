import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { URL } from "node:url";
import type {
  EngagementMode,
  Participant,
  RegisterParticipantInput,
  RoomEvent,
  RoomMessage,
  RoomSnapshot,
  SendMessageInput,
} from "./types.js";
import { JsonlRoomStore } from "./store.js";
import { newId, slugifyName, stableId } from "./ids.js";
import { redactSecrets } from "./redaction.js";

interface RoomState {
  participants: Map<string, Participant>;
  messages: RetainedBuffer<RoomMessage>;
  messageIds: Set<string>;
  events: RetainedBuffer<RoomEvent>;
  streams: Set<ServerResponse>;
  mutationTail: Promise<void>;
}

class RetainedBuffer<T> {
  private readonly items: T[] = [];
  private next = 0;

  constructor(private readonly capacity: number) {}

  append(item: T): T | undefined {
    if (this.items.length < this.capacity) {
      this.items.push(item);
      return undefined;
    }
    const evicted = this.items[this.next];
    this.items[this.next] = item;
    this.next = (this.next + 1) % this.capacity;
    return evicted;
  }

  values(): T[] {
    if (this.items.length < this.capacity || this.next === 0) return this.items.slice();
    return [...this.items.slice(this.next), ...this.items.slice(0, this.next)];
  }
}

export const MAX_JSON_BODY_BYTES = 64 * 1024;
export const DEFAULT_MESSAGE_QUERY_LIMIT = 50;
export const MAX_MESSAGE_QUERY_LIMIT = 100;
export const DEFAULT_MAX_LOADED_ROOMS = 100;
export const DEFAULT_MAX_MESSAGES_PER_ROOM = 10_000;
export const DEFAULT_MAX_EVENTS_PER_ROOM = 20_000;

export interface RoomHubOptions {
  maxLoadedRooms?: number;
  maxMessagesPerRoom?: number;
  maxEventsPerRoom?: number;
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === "localhost") return true;
  if (isIP(normalized) === 4) return normalized.startsWith("127.");
  if (isIP(normalized) === 6) {
    return normalized === "::1" || normalized === "0:0:0:0:0:0:0:1";
  }
  return false;
}

export function assertSafeBindHost(host: string, unsafeNoAuth = false): void {
  if (isLoopbackHost(host) || unsafeNoAuth) return;
  throw new Error(
    `refusing unauthenticated non-loopback bind "${host}"; use 127.0.0.1 or pass --unsafe-no-auth only when every network peer is trusted`,
  );
}

export class RoomHub {
  private readonly rooms = new Map<string, RoomState>();
  private readonly roomLoads = new Map<string, Promise<RoomState>>();
  private readonly maxLoadedRooms: number;
  private readonly maxMessagesPerRoom: number;
  private readonly maxEventsPerRoom: number;

  constructor(
    private readonly store: JsonlRoomStore,
    options: RoomHubOptions = {},
  ) {
    this.maxLoadedRooms = resolvePositiveInteger(
      options.maxLoadedRooms,
      process.env.AGENT_ROOM_MAX_LOADED_ROOMS,
      DEFAULT_MAX_LOADED_ROOMS,
      "maxLoadedRooms",
    );
    this.maxMessagesPerRoom = resolvePositiveInteger(
      options.maxMessagesPerRoom,
      process.env.AGENT_ROOM_MAX_MESSAGES_PER_ROOM,
      DEFAULT_MAX_MESSAGES_PER_ROOM,
      "maxMessagesPerRoom",
    );
    this.maxEventsPerRoom = resolvePositiveInteger(
      options.maxEventsPerRoom,
      process.env.AGENT_ROOM_MAX_EVENTS_PER_ROOM,
      DEFAULT_MAX_EVENTS_PER_ROOM,
      "maxEventsPerRoom",
    );
  }

  async registerParticipant(room: string, input: RegisterParticipantInput): Promise<Participant> {
    const state = await this.getRoom(room);
    return this.runMutation(state, async () => {
      const requestedIdentifier = slugifyName(input.identifier || input.name);
      const id = input.id || stableId(`${room}:${requestedIdentifier}`, "p");
      const now = new Date().toISOString();
      const existing = state.participants.get(id);
      const identifier = slugifyName(input.identifier || existing?.identifier || input.name);
      // Re-registration (e.g. the agent's MCP server confirming readiness) must
      // merge with the existing record, not reset mode/client back to defaults.
      const participant: Participant = {
        id,
        room,
        name: input.name,
        identifier,
        type: input.type || existing?.type || "human",
        client: input.client || existing?.client || (input.type === "agent" ? "unknown" : "human"),
        mode: input.mode || existing?.mode || "mentioned",
        joinedAt: existing?.joinedAt || now,
        lastSeenAt: now,
        status: "online",
        confirmed: input.confirmed ?? existing?.confirmed ?? false,
      };

      const event: RoomEvent = {
        id: newId("evt"),
        room,
        type: "participant_joined",
        participant,
        createdAt: now,
      };
      await this.recordEvent(state, event);
      return participant;
    });
  }

  async setMode(room: string, participantId: string, mode: EngagementMode): Promise<Participant | null> {
    const state = await this.getRoom(room);
    return this.runMutation(state, async () => {
      const participant = state.participants.get(participantId);
      if (!participant) return null;
      const updated: Participant = {
        ...participant,
        mode,
        lastSeenAt: new Date().toISOString(),
      };
      state.participants.set(participantId, updated);
      return updated;
    });
  }

  async leave(room: string, participantId: string): Promise<boolean> {
    const state = await this.getRoom(room);
    return this.runMutation(state, async () => {
      const existing = state.participants.get(participantId);
      if (!existing) return false;
      const participant: Participant = {
        ...existing,
        status: "offline",
        lastSeenAt: new Date().toISOString(),
      };
      const event: RoomEvent = {
        id: newId("evt"),
        room,
        type: "participant_left",
        participant,
        createdAt: participant.lastSeenAt,
      };
      await this.recordEvent(state, event);
      return true;
    });
  }

  async sendMessage(room: string, input: SendMessageInput): Promise<RoomMessage> {
    const state = await this.getRoom(room);
    return this.runMutation(state, async () => {
      const sender = state.participants.get(input.senderId);
      const now = new Date().toISOString();

      // Redact secrets on the write path (design-principles §3a). This runs
      // before the content hits the transcript, SSE stream, or catch_up
      // buffer, so downstream readers never see the raw credential.
      const { content: redactedContent, hits } = redactSecrets(input.content);
      if (hits.length > 0) {
        const summary = hits.map((h) => h.type).join(", ");
        console.warn(
          `[agent-room] redacted ${hits.length} secret-like token(s) from message in room="${room}" types=[${summary}]`,
        );
      }

      const message: RoomMessage = {
        id: newId("msg"),
        room,
        senderId: input.senderId,
        senderName: input.senderName || sender?.name || input.senderId,
        senderType: input.senderType || sender?.type || "human",
        content: redactedContent,
        mentions: detectMentions(redactedContent, [...state.participants.values()]),
        createdAt: now,
      };
      const event: RoomEvent = {
        id: newId("evt"),
        room,
        type: "message",
        message,
        createdAt: now,
      };
      await this.recordEvent(state, event);
      if (sender) state.participants.set(sender.id, { ...sender, lastSeenAt: now });
      return message;
    });
  }

  async snapshot(room: string): Promise<RoomSnapshot> {
    const state = await this.getRoom(room);
    return {
      room,
      participants: [...state.participants.values()],
      messages: state.messages.values(),
    };
  }

  async messages(room: string, limit = DEFAULT_MESSAGE_QUERY_LIMIT): Promise<RoomMessage[]> {
    assertMessageQueryLimit(limit);
    const state = await this.getRoom(room);
    return state.messages.values().slice(-limit);
  }

  async events(room: string, since?: string): Promise<RoomEvent[]> {
    const state = await this.getRoom(room);
    const events = state.events.values();
    if (!since) return events;
    return events.filter((event) => event.createdAt >= since);
  }

  async stream(room: string, res: ServerResponse): Promise<void> {
    const state = await this.getRoom(room);
    state.streams.add(res);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Content-Type-Options": "nosniff",
    });
    res.write(": connected\n\n");
    const keepAlive = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, 15_000);
    res.on("close", () => {
      clearInterval(keepAlive);
      state.streams.delete(res);
    });
  }

  private async getRoom(room: string): Promise<RoomState> {
    const existing = this.rooms.get(room);
    if (existing) return existing;

    let loading = this.roomLoads.get(room);
    if (!loading) {
      // roomLoads counts reservations made by concurrent cold starts. Checking
      // both maps before registering the promise keeps the limit race-free.
      let reservedRoomCount = this.rooms.size;
      for (const loadingRoom of this.roomLoads.keys()) {
        // A resolved load can appear in both maps until getRoom's finally
        // handler runs. Count that room once, while still reserving true loads.
        if (!this.rooms.has(loadingRoom)) reservedRoomCount += 1;
      }
      if (reservedRoomCount >= this.maxLoadedRooms) {
        throw new HttpError(
          503,
          `loaded room capacity reached (${this.maxLoadedRooms}); existing rooms remain available`,
        );
      }
      loading = this.loadRoom(room);
      this.roomLoads.set(room, loading);
    }
    try {
      return await loading;
    } finally {
      if (this.roomLoads.get(room) === loading) this.roomLoads.delete(room);
    }
  }

  private async loadRoom(room: string): Promise<RoomState> {
    const state: RoomState = {
      participants: new Map(),
      messages: new RetainedBuffer(this.maxMessagesPerRoom),
      messageIds: new Set(),
      events: new RetainedBuffer(this.maxEventsPerRoom),
      streams: new Set(),
      mutationTail: Promise.resolve(),
    };
    await this.store.replay(room, (event) => {
      applyEvent(state, event);
      state.events.append(event);
    });
    this.rooms.set(room, state);
    return state;
  }

  private async recordEvent(state: RoomState, event: RoomEvent): Promise<void> {
    await this.store.append(event);
    applyEvent(state, event);
    state.events.append(event);
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const stream of state.streams) {
      stream.write(payload);
    }
  }

  private async runMutation<T>(state: RoomState, operation: () => Promise<T>): Promise<T> {
    const result = state.mutationTail.then(operation);
    // A failed append rejects its caller but must not poison later operations.
    state.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export async function startRoomServer(options: {
  hub: RoomHub;
  port: number;
  host?: string;
  unsafeNoAuth?: boolean;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const host = (options.host || "127.0.0.1").trim();
  assertSafeBindHost(host, options.unsafeNoAuth);
  const server = createServer((req, res) => {
    handleRequest(options.hub, req, res).catch((error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const statusCode = error instanceof HttpError ? error.statusCode : 500;
      sendJson(res, statusCode, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  server.timeout = 0;
  server.requestTimeout = 0;
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;

  await new Promise<void>((resolve) => server.listen(options.port, host, resolve));
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : options.port;
  const urlHost = isIP(host) === 6 ? `[${host}]` : host;
  return {
    url: `http://${urlHost}:${actualPort}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function handleRequest(hub: RoomHub, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!req.url) return sendJson(res, 404, { error: "missing URL" });
  const url = new URL(req.url, "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, { ok: true });
  }

  if (parts[0] !== "rooms" || !parts[1]) {
    return sendJson(res, 404, { error: "not found" });
  }

  const room = decodeURIComponent(parts[1]);

  if (req.method === "GET" && parts.length === 2) {
    return sendJson(res, 200, await hub.snapshot(room));
  }

  if (req.method === "POST" && parts[2] === "participants" && parts.length === 3) {
    const body = await readJson<RegisterParticipantInput>(req);
    return sendJson(res, 200, await hub.registerParticipant(room, body));
  }

  if (req.method === "PATCH" && parts[2] === "participants" && parts[3] && parts[4] === "mode") {
    const body = await readJson<{ mode: EngagementMode }>(req);
    const participant = await hub.setMode(room, parts[3], body.mode);
    if (!participant) return sendJson(res, 404, { error: "participant not found" });
    return sendJson(res, 200, participant);
  }

  if (req.method === "DELETE" && parts[2] === "participants" && parts[3]) {
    return sendJson(res, 200, { ok: await hub.leave(room, parts[3]) });
  }

  if (req.method === "POST" && parts[2] === "messages") {
    const body = await readJson<SendMessageInput>(req);
    return sendJson(res, 200, await hub.sendMessage(room, body));
  }

  if (req.method === "GET" && parts[2] === "messages") {
    const limit = parseMessageQueryLimit(url.searchParams.get("limit"));
    return sendJson(res, 200, await hub.messages(room, limit));
  }

  if (req.method === "GET" && parts[2] === "events") {
    return sendJson(res, 200, await hub.events(room, url.searchParams.get("since") || undefined));
  }

  if (req.method === "GET" && parts[2] === "stream") {
    return hub.stream(room, res);
  }

  return sendJson(res, 404, { error: "not found" });
}

function applyEvent(state: RoomState, event: RoomEvent): void {
  if (event.type === "participant_joined") {
    state.participants.set(event.participant.id, event.participant);
  }
  if (event.type === "participant_left") {
    state.participants.delete(event.participant.id);
  }
  if (event.type === "message") {
    if (!state.messageIds.has(event.message.id)) {
      const evicted = state.messages.append(event.message);
      if (evicted) state.messageIds.delete(evicted.id);
      state.messageIds.add(event.message.id);
    }
  }
}

function parseMessageQueryLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_MESSAGE_QUERY_LIMIT;
  if (!/^\d+$/.test(raw)) {
    throw new HttpError(
      400,
      `limit must be an integer from 1 to ${MAX_MESSAGE_QUERY_LIMIT}`,
    );
  }
  const limit = Number(raw);
  assertMessageQueryLimit(limit);
  return limit;
}

function assertMessageQueryLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MESSAGE_QUERY_LIMIT) {
    throw new HttpError(
      400,
      `limit must be an integer from 1 to ${MAX_MESSAGE_QUERY_LIMIT}`,
    );
  }
}

function resolvePositiveInteger(
  optionValue: number | undefined,
  envValue: string | undefined,
  defaultValue: number,
  name: string,
): number {
  const candidate = optionValue ?? (envValue === undefined ? defaultValue : Number(envValue));
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return candidate;
}

export function detectMentions(content: string, participants: Participant[]): string[] {
  const mentions = new Set<string>();
  const pattern = /@([a-zA-Z0-9_-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[1].toLowerCase();
    if (token === "all") {
      mentions.add("@all");
      continue;
    }
    for (const participant of participants) {
      if (
        participant.identifier.toLowerCase() === token ||
        participant.name.toLowerCase() === token
      ) {
        mentions.add(participant.id);
      }
    }
  }
  return [...mentions];
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const contentType = req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    req.resume();
    throw new HttpError(415, "Content-Type must be application/json");
  }

  const declaredLength = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
    req.resume();
    throw new HttpError(413, `JSON body exceeds ${MAX_JSON_BODY_BYTES} bytes`);
  }

  return new Promise<T>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(error);
    };

    req.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buffer.length;
      if (received > MAX_JSON_BODY_BYTES) {
        fail(new HttpError(413, `JSON body exceeds ${MAX_JSON_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      if (chunks.length === 0) {
        resolve({} as T);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
      } catch {
        reject(new HttpError(400, "invalid JSON body"));
      }
    });
    req.on("aborted", () => fail(new HttpError(400, "request body was aborted")));
    req.on("error", (error) => fail(error));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}
