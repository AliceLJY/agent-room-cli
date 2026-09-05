import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomClient } from "./client.js";
import { buildInjectionPrompt, classifyEvent } from "./engagement.js";
import { stableId } from "./ids.js";
import type { AgentRuntimeOptions, EngagementMode, RoomMessage } from "./types.js";
import {
  AgentTmuxBridge,
  tmuxAttach,
  tmuxAvailable,
  tmuxCreateSession,
  tmuxKillSession,
  tmuxSendCommand,
  tmuxSessionExists,
} from "./tmux.js";

export interface AgentTargetRuntimeOptions {
  client: "claude" | "codex";
  name: string;
  identifier: string;
  serverUrl: string;
  room: string;
  mode: EngagementMode;
  target: string;
  extraArgs: string[];
}

export interface AgentTargetHandle {
  participantId: string;
  stop: () => Promise<void>;
}

export async function runAgent(options: AgentRuntimeOptions): Promise<void> {
  if (!tmuxAvailable()) {
    throw new Error("tmux is required. Install it first: brew install tmux");
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "agent-room-"));
  const session = `agent_room_${options.identifier}`;
  let handle: AgentTargetHandle | null = null;

  try {
    if (tmuxSessionExists(session)) tmuxKillSession(session);
    tmuxCreateSession(session);

    handle = await startAgentInTarget({
      client: options.client,
      name: options.name,
      identifier: options.identifier,
      serverUrl: options.serverUrl,
      room: options.room,
      mode: options.mode,
      target: session,
      extraArgs: options.extraArgs,
    }, tmpDir);

    console.log(`Launching @${options.identifier} (${options.client}) into room ${options.room}.`);
    console.log("The room host prints '[room] @… connected' once the agent can actually hear it; /who shows connection state.");
    console.log(`tmux session: ${session}`);
    console.log(`mode: ${options.mode}`);

    if (options.attach) {
      await tmuxAttach(session);
    } else {
      console.log(`Attach manually with: tmux attach -t ${session}`);
      await waitForSignal();
    }
  } finally {
    try {
      if (handle) {
        await handle.stop();
      } else {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    } finally {
      // --keep applies only after a successful launch. A failed startup must
      // not leave an empty tmux session or its temporary MCP config behind.
      if (!handle || !options.keep) tmuxKillSession(session);
    }
  }
}

export async function startAgentInTarget(
  options: AgentTargetRuntimeOptions,
  tmpDir = mkdtempSync(join(tmpdir(), "agent-room-")),
): Promise<AgentTargetHandle> {
  ensureCliAvailable(options.client);

  const client = new RoomClient(options.serverUrl, options.room);
  const participant = await client.register({
    id: stableId(`${options.room}:${options.identifier}`, "p"),
    name: options.name,
    identifier: options.identifier,
    type: "agent",
    client: options.client,
    mode: options.mode,
  });

  const mcpArgs = [
    mcpServerPath(),
    "--server",
    options.serverUrl,
    "--room",
    options.room,
    "--id",
    participant.id,
    "--name",
    options.name,
    "--identifier",
    options.identifier,
  ];

  if (options.client === "claude") {
    const configPath = writeClaudeMcpConfig(tmpDir, mcpArgs);
    tmuxSendCommand(options.target, [
      "claude",
      "--mcp-config",
      shellQuote(configPath),
      ...quoteArgs(options.extraArgs),
    ].join(" "));
  } else {
    tmuxSendCommand(options.target, [
      "codex",
      ...quoteArgs(codexMcpConfigArgs(mcpArgs)),
      ...quoteArgs(options.extraArgs),
    ].join(" "));
  }

  const bridge = new AgentTmuxBridge(options.target, options.client, (droppedCount) => {
    const plural = droppedCount === 1 ? "message" : "messages";
    client.send({
      senderId: "system",
      senderName: "agent-room",
      senderType: "agent",
      content: `@${options.identifier} (${options.name}) is no longer running an agent in its pane — dropped ${droppedCount} pending ${plural} instead of typing them into a shell. Relaunch it before mentioning it again.`,
    }).catch((error) => {
      console.warn(
        `[agent-room] failed to notify room that @${options.identifier} is gone: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  });
  const abort = new AbortController();
  const buffer: BufferState = { messages: [], dropped: 0 };
  const streamTask = client.stream((event) => {
    const disposition = classifyEvent(event, participant.id, options.mode);
    if (event.type !== "message" || disposition === "drop") return;
    if (disposition === "content") {
      buffer.messages.push(event.message);
      trimBuffer(buffer);
      return;
    }

    const context = buffer.messages.splice(0, buffer.messages.length);
    const droppedBefore = buffer.dropped;
    buffer.dropped = 0;
    const prompt = buildInjectionPrompt({
      room: options.room,
      agentName: options.name,
      agentIdentifier: options.identifier,
      context,
      trigger: event.message,
      droppedBefore,
    });
    bridge.deliver(prompt);
  }, abort.signal).catch((error) => {
    if (!abort.signal.aborted) {
      console.error(`[agent-room] event stream stopped: ${error.message}`);
    }
  });

  return {
    participantId: participant.id,
    async stop() {
      try {
        await client.leave(participant.id);
      } catch (error) {
        console.warn(
          `[agent-room] failed to leave room: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      abort.abort();
      bridge.stop();
      await streamTask;
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}

function mcpServerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "mcp-server.js");
}

function writeClaudeMcpConfig(tmpDir: string, args: string[]): string {
  const configPath = join(tmpDir, "mcp.json");
  writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      agent_room: {
        type: "stdio",
        command: process.execPath,
        args,
      },
    },
  }, null, 2));
  return configPath;
}

function codexMcpConfigArgs(args: string[]): string[] {
  const quotedArgs = args.map((arg) => JSON.stringify(arg)).join(", ");
  return [
    "-c",
    'mcp_servers.agent_room.type="stdio"',
    "-c",
    `mcp_servers.agent_room.command=${JSON.stringify(process.execPath)}`,
    "-c",
    `mcp_servers.agent_room.args=[${quotedArgs}]`,
    "-c",
    "mcp_servers.agent_room.startup_timeout_sec=15",
    "-c",
    "mcp_servers.agent_room.tool_timeout_sec=60",
  ];
}

function ensureCliAvailable(client: "claude" | "codex"): void {
  try {
    execFileSync(client, ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error(`${client} CLI is required but was not found in PATH`);
  }
}

interface BufferState {
  messages: RoomMessage[];
  /** Messages dropped since the last trigger, surfaced in the next prompt. */
  dropped: number;
}

// Buffer cap for non-triggered messages between consecutive triggers.
// Keeping the number small protects small-context agents (Codex especially)
// from a burst of room chatter arriving in one injected prompt. Dropped
// messages remain on the server and can be retrieved via agent_room.catch_up.
const BUFFER_MAX_MESSAGES = 30;

function trimBuffer(buffer: BufferState): void {
  while (buffer.messages.length > BUFFER_MAX_MESSAGES) {
    buffer.messages.shift();
    buffer.dropped += 1;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function quoteArgs(args: string[]): string[] {
  return args.map(shellQuote);
}

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}
