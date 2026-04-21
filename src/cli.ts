#!/usr/bin/env node
import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { join } from "node:path";
import { homedir } from "node:os";
import { RoomClient } from "./client.js";
import { slugifyName, stableId } from "./ids.js";
import { JsonlRoomStore } from "./store.js";
import { RoomHub, startRoomServer } from "./room-server.js";
import { runAgent } from "./launcher.js";
import type { EngagementMode } from "./types.js";

const program = new Command();

program
  .name("agent-room")
  .description("Local CLI room for humans, Claude Code, and Codex")
  .version("0.1.0");

program.command("host")
  .description("Start a local room server and join as a human")
  .option("-r, --room <name>", "room name", "main")
  .option("-n, --name <name>", "your display name", process.env.USER || "human")
  .option("-p, --port <port>", "port", "43110")
  .option("--host <host>", "bind host", "127.0.0.1")
  .option("--data-dir <path>", "JSONL store directory", join(homedir(), ".agent-room"))
  .action(async (opts) => {
    const room = String(opts.room);
    const hub = new RoomHub(new JsonlRoomStore(String(opts.dataDir)));
    const server = await startRoomServer({
      hub,
      port: Number(opts.port),
      host: String(opts.host),
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
    console.log("Type messages. Use @cc, @codex, or @all. Commands: /who, /history, /exit");

    const abort = new AbortController();
    let closed = false;
    const streamClient = new RoomClient(server.url, room);
    const streamTask = streamClient.stream((event) => {
      if (event.type !== "message") return;
      if (event.message.senderId === participant.id) return;
      output.write(`\n${event.message.senderName}> ${event.message.content}\n`);
      if (!closed && input.isTTY) output.write("you> ");
    }, abort.signal).catch((error) => {
      if (!abort.signal.aborted) {
        console.error(`room stream stopped: ${error.message}`);
      }
    });

    if (!input.isTTY) {
      console.log("stdin is not interactive; server will run until SIGINT or SIGTERM.");
      await waitForSignal();
      closed = true;
      abort.abort();
      await streamTask;
      await server.close();
      return;
    }

    const rl = createInterface({ input, output, prompt: "you> " });
    rl.prompt();
    rl.on("line", async (line) => {
      const text = line.trim();
      let shouldPrompt = true;
      try {
        if (!text) {
          return;
        }
        if (text === "/exit" || text === "/quit") {
          shouldPrompt = false;
          rl.close();
          return;
        }
        if (text === "/who") {
          const snapshot = await hub.snapshot(room);
          for (const p of snapshot.participants) {
            console.log(`@${p.identifier} (${p.name}) — ${p.type}/${p.client}, mode=${p.mode}`);
          }
          rl.prompt();
          return;
        }
        if (text === "/history") {
          const messages = await hub.messages(room, 50);
          for (const message of messages) {
            console.log(`${message.senderName}> ${message.content}`);
          }
          rl.prompt();
          return;
        }
        const message = await hub.sendMessage(room, {
          senderId: participant.id,
          senderName: participant.name,
          senderType: "human",
          content: text,
        });
        void message;
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
      } finally {
        if (shouldPrompt) rl.prompt();
      }
    });

    await new Promise<void>((resolve) => rl.on("close", resolve));
    closed = true;
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
