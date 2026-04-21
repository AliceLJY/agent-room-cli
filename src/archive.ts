import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, extname, join } from "node:path";
import type { Participant, RoomMessage, RoomSnapshot } from "./types.js";

export interface ArchiveLocation {
  dataDir: string;
  room: string;
  file: string;
}

export interface ArchiveEntry {
  file: string;
  room: string;
  createdAt: string;
  messageCount: number;
  participantCount: number;
  sizeBytes: number;
}

export function archiveDir(dataDir: string, room: string): string {
  return join(dataDir, "archives", safeName(room));
}

export function resolveArchivePath(dataDir: string, room: string, now: Date = new Date()): ArchiveLocation {
  const dir = archiveDir(dataDir, room);
  const stamp = timestampSlug(now);
  return { dataDir, room, file: join(dir, `${stamp}.md`) };
}

export async function writeArchive(location: ArchiveLocation, snapshot: RoomSnapshot, now: Date = new Date()): Promise<string> {
  await mkdir(dirname(location.file), { recursive: true });
  const body = renderArchiveMarkdown(snapshot, now);
  const ext = extname(location.file) || ".md";
  const base = location.file.slice(0, location.file.length - ext.length);
  let target = location.file;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await writeFile(target, body, { encoding: "utf8", flag: "wx" });
      return target;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") throw error;
      target = `${base}-${shortId()}${ext}`;
    }
  }
  throw new Error(`archive write failed: collision retries exhausted at ${location.file}`);
}

function shortId(): string {
  return randomBytes(3).toString("hex");
}

export function renderArchiveMarkdown(snapshot: RoomSnapshot, now: Date = new Date()): string {
  const messages = snapshot.messages;
  const first = messages[0]?.createdAt ?? now.toISOString();
  const last = messages[messages.length - 1]?.createdAt ?? now.toISOString();

  const idToHandle = new Map<string, string>();
  for (const p of snapshot.participants) idToHandle.set(p.id, p.identifier);

  const participantLines = snapshot.participants.length
    ? snapshot.participants.map((p) => `  - ${p.name} (@${p.identifier}, ${p.type}/${p.client})`).join("\n")
    : "  - (none)";

  const frontmatter = [
    "---",
    `room: ${snapshot.room}`,
    `archived_at: ${now.toISOString()}`,
    `message_count: ${messages.length}`,
    `participant_count: ${snapshot.participants.length}`,
    `first_message_at: ${first}`,
    `last_message_at: ${last}`,
    "participants:",
    participantLines,
    "---",
    "",
  ].join("\n");

  const header = [
    `# Room archive: ${snapshot.room}`,
    "",
    `Archived at ${now.toISOString()}.`,
    "",
    `This is a point-in-time export of the \`${snapshot.room}\` room transcript. It is the pull-by-reference companion to the live JSONL store: paste the path to this file into a new room when you want agents to read the prior discussion on demand.`,
    "",
    "## Transcript",
    "",
  ].join("\n");

  const body = messages.length
    ? messages.map((m) => renderMessage(m, idToHandle)).join("\n\n")
    : "_(no messages)_";

  return `${frontmatter}${header}${body}\n`;
}

function renderMessage(message: RoomMessage, idToHandle: Map<string, string>): string {
  const handle = idToHandle.get(message.senderId);
  const handleSuffix = handle ? ` (@${handle})` : "";
  const mentionTargets = message.mentions
    .map((m) => (m === "@all" ? "@all" : idToHandle.get(m) ? `@${idToHandle.get(m)}` : m))
    .join(", ");
  const mentionBlock = mentionTargets ? ` → ${mentionTargets}` : "";
  const header = `### ${message.senderName}${handleSuffix}${mentionBlock}`;
  const meta = `_${message.createdAt} · ${message.senderType}_`;
  return [header, meta, "", message.content.trimEnd()].join("\n");
}

export async function listArchives(dataDir: string): Promise<ArchiveEntry[]> {
  const root = join(dataDir, "archives");
  let rooms: string[] = [];
  try {
    rooms = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const entries: ArchiveEntry[] = [];
  for (const room of rooms) {
    const roomDir = join(root, room);
    let files: string[] = [];
    try {
      files = await readdir(roomDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const full = join(roomDir, file);
      try {
        const info = await stat(full);
        if (!info.isFile()) continue;
        entries.push(await readEntry(full, room, info.size));
      } catch {
        continue;
      }
    }
  }
  entries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return entries;
}

async function readEntry(file: string, room: string, sizeBytes: number): Promise<ArchiveEntry> {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(file, "utf8");
  const front = parseFrontmatter(raw);
  return {
    file,
    room,
    createdAt: front.archived_at ?? "",
    messageCount: Number(front.message_count ?? 0),
    participantCount: Number(front.participant_count ?? 0),
    sizeBytes,
  };
}

function parseFrontmatter(raw: string): Record<string, string> {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!out[key]) out[key] = value;
  }
  return out;
}

export interface RoomStats {
  room: string;
  participantCount: number;
  messageCount: number;
  transcriptFile: string;
  archiveDir: string;
  latestArchive?: string;
}

export async function collectRoomStats(
  dataDir: string,
  snapshot: RoomSnapshot,
): Promise<RoomStats> {
  const safeRoom = safeName(snapshot.room);
  const transcriptFile = join(dataDir, `${safeRoom}.jsonl`);
  const aDir = archiveDir(dataDir, snapshot.room);
  const archives = await listArchives(dataDir);
  const latest = archives.find((entry) => entry.room === safeRoom);
  return {
    room: snapshot.room,
    participantCount: snapshot.participants.length,
    messageCount: snapshot.messages.length,
    transcriptFile,
    archiveDir: aDir,
    latestArchive: latest?.file,
  };
}

function timestampSlug(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
  ].join("-") + "-" + [
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_") || "main";
}

export function formatParticipants(participants: Participant[]): string {
  return participants.map((p) => `@${p.identifier}`).join(", ");
}
