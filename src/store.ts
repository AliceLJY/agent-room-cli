import { appendFile, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
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
    const events: RoomEvent[] = [];
    await this.replay(room, (event) => events.push(event));
    return events;
  }

  async replay(room: string, onEvent: (event: RoomEvent) => void): Promise<void> {
    const file = this.eventFile(room);
    let fileHandle: Awaited<ReturnType<typeof open>>;
    try {
      fileHandle = await open(file, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    const input = fileHandle.createReadStream({ encoding: "utf8", autoClose: false });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let index = 0;
    try {
      for await (const line of lines) {
        index += 1;
        const trimmed = line.trim();
        if (!trimmed) continue;

        let event: RoomEvent;
        try {
          event = JSON.parse(trimmed) as RoomEvent;
        } catch (error) {
          console.warn(
            `[agent-room] skipped invalid event JSON in ${file}:${index}: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
        onEvent(event);
      }
    } finally {
      lines.close();
      input.destroy();
      await fileHandle.close();
    }
  }
}

function safeRoomName(room: string): string {
  return room.replace(/[^a-zA-Z0-9._-]+/g, "_") || "main";
}
