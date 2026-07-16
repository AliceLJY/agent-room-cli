#!/usr/bin/env node
import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { clearLine, cursorTo } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { RoomClient } from "./client.js";
import { slugifyName, stableId } from "./ids.js";
import { LineAggregator } from "./line-aggregator.js";
import { JsonlRoomStore } from "./store.js";
import { RoomHub, startRoomServer } from "./room-server.js";
import { runAgent } from "./launcher.js";
import { runTrio } from "./trio.js";
import {
  listArchives,
  matchRoomFilter,
  resolveArchivePath,
  writeArchive,
} from "./archive.js";
import type { EngagementMode } from "./types.js";

const program = new Command();

export const packageVersion: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

program
  .name("agent-room")
  .description("Local CLI room for humans, Claude Code, and Codex")
  .version(packageVersion);

program.command("host")
  .description("Start a local room server and join as a human")
  .option("-r, --room <name>", "room name", "main")
  .option("-n, --name <name>", "your display name", process.env.USER || "human")
  .option("-p, --port <port>", "port", "43110")
  .option("--host <host>", "bind host", "127.0.0.1")
  .option("--unsafe-no-auth", "allow an unauthenticated non-loopback bind")
  .option("--data-dir <path>", "JSONL store directory", join(homedir(), ".agent-room"))
  .action(async (opts) => {
    const room = String(opts.room);
    const hub = new RoomHub(new JsonlRoomStore(String(opts.dataDir)));
    const server = await startRoomServer({
      hub,
      port: Number(opts.port),
      host: String(opts.host),
      unsafeNoAuth: Boolean(opts.unsafeNoAuth),
    });
    const identifier = slugifyName(String(opts.name));
    const participant = await hub.registerParticipant(room, {
      id: stableId(`${room}:${identifier}`, "p"),
      name: String(opts.name),
      identifier,
      type: "human",
      client: "human",
      mode: "mentioned",
    });

    console.log(`agent-room listening: ${server.url}`);
    console.log(`room: ${room}`);
    console.log(`you: @${participant.identifier}`);
    console.log("");
    console.log("Launch agents in other terminals:");
    console.log(`  agent-room run claude --name cc --server ${server.url} --room ${room}`);
    console.log(`  agent-room run codex --name codex --server ${server.url} --room ${room}`);
    console.log("");
    console.log("Type messages. Use @cc, @codex, or @all.");
    console.log("Commands: /who, /history, /exit");
    console.log("Archives on /exit. Browse past rooms with: agent-room list");

    const abort = new AbortController();
    let closed = false;
    let rlRef: ReturnType<typeof createInterface> | null = null;

    // Print an incoming line above the prompt without corrupting whatever the
    // human is currently typing (the old direct output.write was the likely
    // cause of the "first line keeps repeating" report from 2026-04-23).
    const printAbove = (line: string) => {
      if (rlRef && !closed && input.isTTY) {
        clearLine(output, 0);
        cursorTo(output, 0);
        output.write(`${line}\n`);
        rlRef.prompt(true);
      } else {
        output.write(`${line}\n`);
        if (!closed && input.isTTY) output.write("you> ");
      }
    };

    const streamClient = new RoomClient(server.url, room);
    const streamTask = streamClient.stream((event) => {
      // Surface real agent readiness: the launcher's registration only means
      // "launch attempted"; confirmed=true comes from the agent's own MCP
      // server and is the honest "this agent can hear the room" signal.
      if (event.type === "participant_joined" && event.participant.type === "agent") {
        const p = event.participant;
        printAbove(p.confirmed
          ? `[room] @${p.identifier} connected (${p.client})`
          : `[room] launching @${p.identifier} (${p.client})…`);
        return;
      }
      if (event.type === "participant_left" && event.participant.type === "agent") {
        printAbove(`[room] @${event.participant.identifier} left`);
        return;
      }
      if (event.type !== "message") return;
      if (event.message.senderId === participant.id) return;
      printAbove(`${event.message.senderName}> ${event.message.content}`);
    }, abort.signal).catch((error) => {
      if (!abort.signal.aborted) {
        console.error(`room stream stopped: ${error.message}`);
      }
    });

    const autosave = async (): Promise<string | null> => {
      try {
        const snapshot = await hub.snapshot(room);
        if (snapshot.messages.length === 0) return null;
        const loc = resolveArchivePath(String(opts.dataDir), room);
        return await writeArchive(loc, snapshot);
      } catch (error) {
        console.error(`archive failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    };

    if (!input.isTTY) {
      console.log("stdin is not interactive; server will run until SIGINT or SIGTERM.");
      await waitForSignal();
      closed = true;
      const saved = await autosave();
      if (saved) console.log(`archived: ${saved}`);
      abort.abort();
      await streamTask;
      await server.close();
      return;
    }

    const rl = createInterface({ input, output, prompt: "you> " });
    rlRef = rl;
    // Ask the terminal to bracket pastes (DEC mode 2004) so paste bounds are
    // explicit; disabled again before we leave.
    output.write("\x1b[?2004h");
    rl.prompt();

    const handleSubmit = async (text: string) => {
      // Commands are single-line only; a pasted block that happens to contain
      // "/exit" on some line is content, not a command.
      const isCommand = !text.includes("\n") && text.startsWith("/");
      let shouldPrompt = true;
      try {
        if (isCommand && (text === "/exit" || text === "/quit")) {
          shouldPrompt = false;
          const saved = await autosave();
          if (saved) console.log(`archived: ${saved}`);
          rl.close();
          return;
        }
        if (isCommand && text === "/who") {
          const snapshot = await hub.snapshot(room);
          for (const p of snapshot.participants) {
            const ready = p.type === "agent" ? (p.confirmed ? ", connected" : ", not confirmed") : "";
            console.log(`@${p.identifier} (${p.name}) — ${p.type}/${p.client}, mode=${p.mode}${ready}`);
          }
          return;
        }
        if (isCommand && text === "/history") {
          const messages = await hub.messages(room, 50);
          for (const message of messages) {
            console.log(`${message.senderName}> ${message.content}`);
          }
          return;
        }
        await hub.sendMessage(room, {
          senderId: participant.id,
          senderName: participant.name,
          senderType: "human",
          content: text,
        });
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
      } finally {
        if (shouldPrompt) rl.prompt();
      }
    };

    // readline emits one `line` per pasted line; aggregate paste bursts into
    // one multi-line message instead of N fragments (2026-04-23 report).
    //
    // The final pasted line has no trailing newline, so readline never fires a
    // `line` event for it — it stays in the edit buffer (rl.line) and used to
    // be stranded at the prompt (2026-06-20 report). Hand that tail to the
    // aggregator at flush time and wipe the buffer so the whole paste is sent.
    // `rl.write(null, key)` throws on node v25, so reset the buffer state
    // directly (verified writable + clean: a later Enter yields "", not a
    // resend). The tail is already echoed on the current line; commit it with
    // a newline so it stays on screen exactly like the earlier pasted lines
    // (readline ended those with \r\n). Clearing the line instead made the last
    // line visually vanish even though the full message was sent (2026-06-20
    // follow-up: "内容进去了，但最后一行显示消失了").
    const drainResidual = (): string | null => {
      const tail = rl.line;
      if (!tail) return null;
      const editable = rl as unknown as { line: string; cursor: number };
      editable.line = "";
      editable.cursor = 0;
      output.write("\r\n");
      return tail;
    };
    const aggregator = new LineAggregator(
      (text) => {
        void handleSubmit(text);
      },
      undefined,
      drainResidual,
      (count) => {
        // Pasted content is staged, not sent — hint that Enter sends it and
        // that more can be pasted first.
        output.write(`\x1b[2m  ⏎ 已暂存 ${count} 行 · 回车发送 · 可继续粘\x1b[0m\n`);
        rl.prompt();
      },
    );
    rl.on("line", (line) => aggregator.push(line));

    // Bracketed-paste markers arrive as keypress events without polluting the
    // line content (verified) — use them as the authoritative paste boundary
    // so a block stays whole however large or slowly chunked it is. Terminals
    // that don't emit them fall back to the aggregator's 25ms window.
    input.on("keypress", (_str: string | undefined, key: { sequence?: string } | undefined) => {
      if (key?.sequence === "\x1b[200~") aggregator.beginPaste();
      else if (key?.sequence === "\x1b[201~") aggregator.endPaste();
    });

    let signalShutdown: Promise<void> | null = null;
    const onSignal = (signal: NodeJS.Signals) => {
      if (signalShutdown) return;
      signalShutdown = (async () => {
        output.write(`\nreceived ${signal}, archiving before exit...\n`);
        const saved = await autosave();
        if (saved) output.write(`archived: ${saved}\n`);
        rl.close();
      })();
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    process.once("SIGHUP", onSignal);

    await new Promise<void>((resolve) => rl.on("close", resolve));
    closed = true;
    output.write("\x1b[?2004l"); // stop bracketed paste before leaving
    aggregator.stop();
    if (signalShutdown) await signalShutdown;
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
    abort.abort();
    await streamTask;
    await server.close();
  });

program.command("run")
  .description("Run an original AI CLI in tmux and connect it to a room")
  .argument("<client>", "claude or codex")
  .requiredOption("-n, --name <name>", "agent display name")
  .requiredOption("-s, --server <url>", "room server URL, e.g. http://127.0.0.1:43110")
  .option("-r, --room <name>", "room name", "main")
  .option("--id <identifier>", "mention identifier, defaults to --name")
  .option("--mode <mode>", "mentioned, people, agents, everyone, silent", "mentioned")
  .option("--no-attach", "do not attach to tmux")
  .option("--keep", "keep tmux session after this process exits")
  .allowUnknownOption(true)
  .action(async (clientName, opts, command) => {
    if (clientName !== "claude" && clientName !== "codex") {
      throw new Error("client must be claude or codex");
    }
    const extraArgs = command.args.slice(1);
    await runAgent({
      client: clientName,
      name: String(opts.name),
      identifier: slugifyName(String(opts.id || opts.name)),
      serverUrl: String(opts.server),
      room: String(opts.room),
      mode: parseMode(String(opts.mode)),
      attach: opts.attach,
      keep: Boolean(opts.keep),
      extraArgs,
    });
  });

program.command("trio")
  .description("Start a three-pane tmux room with a human host, Claude Code, and Codex")
  .option("-r, --room <name>", "room name", "main")
  .option("-n, --name <name>", "your display name", process.env.USER || "human")
  .option("-p, --port <port>", "port", "43110")
  .option("--host <host>", "bind host", "127.0.0.1")
  .option("--unsafe-no-auth", "allow an unauthenticated non-loopback bind")
  .option("--data-dir <path>", "JSONL store directory", join(homedir(), ".agent-room"))
  .option("--cc-name <name>", "Claude Code display name and mention identifier", "cc")
  .option("--codex-name <name>", "Codex display name and mention identifier", "codex")
  .option("--cc-mode <mode>", "Claude Code mode", "mentioned")
  .option("--codex-mode <mode>", "Codex mode", "mentioned")
  .option("--cc-arg <arg>", "extra Claude Code arg; repeat with --cc-arg=<value>", collect, [])
  .option("--codex-arg <arg>", "extra Codex arg; repeat with --codex-arg=<value>", collect, [])
  .option("--session <name>", "tmux session name")
  .option("--fresh", "kill an existing trio tmux session before starting")
  .option("--keep", "keep the tmux session after this process exits")
  .option("--no-attach", "create the tmux session but do not attach immediately")
  .action(async (opts) => {
    await runTrio({
      room: String(opts.room),
      name: String(opts.name),
      host: String(opts.host),
      unsafeNoAuth: Boolean(opts.unsafeNoAuth),
      port: Number(opts.port),
      dataDir: String(opts.dataDir),
      ccName: String(opts.ccName),
      codexName: String(opts.codexName),
      ccMode: parseMode(String(opts.ccMode)),
      codexMode: parseMode(String(opts.codexMode)),
      ccArgs: opts.ccArg ?? [],
      codexArgs: opts.codexArg ?? [],
      session: opts.session ? String(opts.session) : undefined,
      attach: opts.attach,
      keep: Boolean(opts.keep),
      fresh: Boolean(opts.fresh),
    });
  });

program.command("send")
  .description("Send one message to an existing room")
  .requiredOption("-s, --server <url>", "room server URL")
  .option("-r, --room <name>", "room name", "main")
  .option("-n, --name <name>", "sender name", process.env.USER || "human")
  .argument("<message...>", "message text")
  .action(async (parts: string[], opts) => {
    const name = String(opts.name);
    const identifier = slugifyName(name);
    const room = String(opts.room);
    const client = new RoomClient(String(opts.server), room);
    const participant = await client.register({
      id: stableId(`${room}:${identifier}`, "p"),
      name,
      identifier,
      type: "human",
      client: "human",
    });
    const message = await client.send({
      senderId: participant.id,
      senderName: participant.name,
      senderType: "human",
      content: parts.join(" "),
    });
    console.log(`sent ${message.id}`);
  });

program.command("list")
  .description("List archived room transcripts")
  .option("--data-dir <path>", "JSONL store directory", join(homedir(), ".agent-room"))
  .option("--room <name>", "filter by room")
  .action(async (opts) => {
    const entries = await listArchives(String(opts.dataDir));
    const filtered = opts.room ? entries.filter((e) => matchRoomFilter(e, String(opts.room))) : entries;
    if (filtered.length === 0) {
      console.log("(no archives)");
      return;
    }
    for (const entry of filtered) {
      const when = entry.createdAt || "?";
      const kb = Math.max(1, Math.round(entry.sizeBytes / 1024));
      console.log(`last-activity=${when}  room=${entry.room}  messages=${entry.messageCount}  ${kb}KB`);
      console.log(`  ${entry.file}`);
    }
  });

await program.parseAsync(process.argv);

function parseMode(value: string): EngagementMode {
  const modes = new Set(["mentioned", "people", "agents", "everyone", "silent"]);
  if (!modes.has(value)) {
    throw new Error(`invalid mode: ${value}`);
  }
  return value as EngagementMode;
}

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}
