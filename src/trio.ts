import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { slugifyName } from "./ids.js";
import { startAgentInTarget } from "./launcher.js";
import { assertSafeBindHost } from "./room-server.js";
import {
  tmuxAttach,
  tmuxAvailable,
  tmuxCreateSessionWithCommand,
  tmuxKillSession,
  tmuxRenamePane,
  tmuxSelectPane,
  tmuxSessionExists,
  tmuxSetOption,
  tmuxSplitPane,
} from "./tmux.js";
import type { EngagementMode } from "./types.js";

export interface TrioOptions {
  room: string;
  name: string;
  host: string;
  unsafeNoAuth: boolean;
  port: number;
  dataDir: string;
  ccName: string;
  codexName: string;
  ccMode: EngagementMode;
  codexMode: EngagementMode;
  ccArgs: string[];
  codexArgs: string[];
  session?: string;
  attach: boolean;
  keep: boolean;
  fresh: boolean;
}

export async function runTrio(options: TrioOptions): Promise<void> {
  assertSafeBindHost(options.host, options.unsafeNoAuth);
  if (!tmuxAvailable()) {
    throw new Error("tmux is required. Install it first: brew install tmux");
  }
  ensureCliAvailable("claude");
  ensureCliAvailable("codex");

  const session = options.session || `agent_room_${slugifyName(options.room)}_trio`;
  if (tmuxSessionExists(session)) {
    if (!options.fresh) {
      console.log(`tmux session already exists: ${session}`);
      console.log(`Attach with: tmux attach -t ${session}`);
      console.log(`Recreate it with: agent-room trio --room ${options.room} --fresh`);
      return;
    }
    tmuxKillSession(session);
  }

  const serverUrl = `http://${options.host}:${options.port}`;
  const hostPane = tmuxCreateSessionWithCommand(session, hostCommand(options));
  tmuxRenamePane(hostPane, `you: ${options.name}`);
  tmuxSetOption(session, "status", "off");
  tmuxSetOption(session, "mouse", "on");
  tmuxSetOption(session, "pane-border-status", "top");
  tmuxSetOption(session, "pane-border-format", " #{pane_title} ");

  const ccPane = tmuxSplitPane(hostPane, "horizontal");
  tmuxRenamePane(ccPane, `@${slugifyName(options.ccName)}: Claude Code`);
  const codexPane = tmuxSplitPane(ccPane, "vertical");
  tmuxRenamePane(codexPane, `@${slugifyName(options.codexName)}: Codex`);
  tmuxSelectPane(hostPane);

  const handles = [];
  try {
    await waitForHealth(serverUrl);
    handles.push(await startAgentInTarget({
      client: "claude",
      name: options.ccName,
      identifier: slugifyName(options.ccName),
      serverUrl,
      room: options.room,
      mode: options.ccMode,
      target: ccPane,
      extraArgs: options.ccArgs,
    }));
    handles.push(await startAgentInTarget({
      client: "codex",
      name: options.codexName,
      identifier: slugifyName(options.codexName),
      serverUrl,
      room: options.room,
      mode: options.codexMode,
      target: codexPane,
      extraArgs: options.codexArgs,
    }));

    console.log(`agent-room trio is starting: ${serverUrl}`);
    console.log(`tmux session: ${session}`);
    console.log("Use @cc, @codex, or @all from the left pane.");
    console.log("Agents are still launching — the left pane prints '[room] @… connected' when each one can actually hear you. /who shows connection state.");
    console.log("Switch panes with mouse click, Ctrl-b + arrow keys, or Ctrl-b q then pane number.");

    if (options.attach) {
      await tmuxAttach(session);
    } else {
      console.log(`Attach manually with: tmux attach -t ${session}`);
      await waitForSignal();
    }
  } finally {
    for (const handle of handles.reverse()) {
      await handle.stop();
    }
    if (!options.keep && tmuxSessionExists(session)) {
      tmuxKillSession(session);
    }
  }
}

function hostCommand(options: TrioOptions): string {
  const args = [
    shellQuote(process.execPath),
    shellQuote(fileURLToPath(new URL("./cli.js", import.meta.url))),
    "host",
    "--room",
    shellQuote(options.room),
    "--name",
    shellQuote(options.name),
    "--host",
    shellQuote(options.host),
    "--port",
    shellQuote(String(options.port)),
    "--data-dir",
    shellQuote(options.dataDir),
  ];
  if (options.unsafeNoAuth) args.push("--unsafe-no-auth");
  return args.join(" ");
}

async function waitForHealth(serverUrl: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${serverUrl}/health`);
      if (response.ok) return;
    } catch {
      // keep waiting
    }
    await delay(150);
  }
  throw new Error(`room server did not become ready: ${serverUrl}`);
}

function ensureCliAvailable(client: "claude" | "codex"): void {
  try {
    execFileSync(client, ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error(`${client} CLI is required but was not found in PATH`);
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}
