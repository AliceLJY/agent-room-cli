import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  if (tmuxSessionExists(session)) tmuxKillSession(session);
  tmuxCreateSession(session);

  const handle = await startAgentInTarget({
    client: options.client,
    name: options.name,
    identifier: options.identifier,
    serverUrl: options.serverUrl,
    room: options.room,
    mode: options.mode,
    target: session,
    extraArgs: options.extraArgs,
  }, tmpDir);

  try {
    console.log(`Joined room ${options.room} as @${options.identifier} (${options.client}).`);
    console.log(`tmux session: ${session}`);
    console.log(`mode: ${options.mode}`);

    if (options.attach) {
      await tmuxAttach(session);
    } else {
      console.log(`Attach manually with: tmux attach -t ${session}`);
      await waitForSignal();
    }
  } finally {
    await handle.stop();
    if (!options.keep) tmuxKillSession(session);
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
    const codexHome = writeCodexHome(tmpDir, mcpArgs);
    tmuxSendCommand(options.target, [
      `CODEX_HOME=${shellQuote(codexHome)}`,
      "codex",
      ...quoteArgs(options.extraArgs),
    ].join(" "));
  }

  const bridge = new AgentTmuxBridge(options.target, options.client);
  const abort = new AbortController();
  const buffered: RoomMessage[] = [];
  const streamTask = client.stream((event) => {
    const disposition = classifyEvent(event, participant.id, options.mode);
    if (event.type !== "message" || disposition === "drop") return;
    if (disposition === "content") {
      buffered.push(event.message);
      trimBuffer(buffered);
      return;
    }

    const context = buffered.splice(0, buffered.length);
    const prompt = buildInjectionPrompt({
      room: options.room,
      agentName: options.name,
      agentIdentifier: options.identifier,
      context,
      trigger: event.message,
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

function writeCodexHome(tmpDir: string, args: string[]): string {
  const codexHome = join(tmpDir, ".codex");
  mkdirSync(codexHome, { recursive: true });
  const quotedArgs = args.map((arg) => JSON.stringify(arg)).join(", ");
  writeFileSync(join(codexHome, "config.toml"), [
    "[mcp_servers.agent_room]",
    'type = "stdio"',
    `command = ${JSON.stringify(process.execPath)}`,
    `args = [${quotedArgs}]`,
    "startup_timeout_sec = 15",
    "tool_timeout_sec = 60",
    "",
  ].join("\n"));
  return codexHome;
}

function ensureCliAvailable(client: "claude" | "codex"): void {
  try {
    execFileSync(client, ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error(`${client} CLI is required but was not found in PATH`);
  }
}

function trimBuffer(messages: RoomMessage[]): void {
  while (messages.length > 30) messages.shift();
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
