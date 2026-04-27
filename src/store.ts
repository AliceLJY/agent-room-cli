import { mkdir, readFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RoomEvent } from "./types.js";

export class JsonlRoomStore {
  constructor(private readonly rootDir: string) {}

  private eventFile(room: string): string {
    return join(this.rootDir, `${safeRoomName(room)}.jsonl`);
  }

  async append(event: RoomEvent): Promise<void> {
    const file = this.eventFile(event.room);
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, JSON.stringify(event) + "\n", "utf8");
  }

  async load(room: string): Promise<RoomEvent[]> {
    const file = this.eventFile(room);
    let raw = "";
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const events: RoomEvent[] = [];
    for (const [index, line] of raw.split("\n").entries()) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        events.push(JSON.parse(trimmed) as RoomEvent);
      } catch (error) {
        console.warn(
          `[agent-room] skipped invalid event JSON in ${file}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return events;
  }
}

function safeRoomName(room: string): string {
  return room.replace(/[^a-zA-Z0-9._-]+/g, "_") || "main";
}
