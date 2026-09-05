import { execFileSync, spawn } from "node:child_process";

export function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function tmuxSessionExists(session: string): boolean {
  try {
    execFileSync("tmux", ["has-session", "-t", safeSession(session)], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function tmuxCreateSession(session: string): void {
  const name = safeSession(session);
  execFileSync("tmux", ["new-session", "-d", "-s", name]);
  execFileSync("tmux", ["set", "-t", name, "status", "off"]);
}

export function tmuxCreateSessionWithCommand(session: string, command: string): string {
  const output = execFileSync("tmux", [
    "new-session",
    "-d",
    "-s",
    safeSession(session),
    "-P",
    "-F",
    "#{pane_id}",
    command,
  ], { encoding: "utf8" });
  return output.trim();
}

export function tmuxSplitPane(target: string, direction: "horizontal" | "vertical", command?: string): string {
  const args = [
    "split-window",
    direction === "horizontal" ? "-h" : "-v",
    "-t",
    safeSession(target),
    "-P",
    "-F",
    "#{pane_id}",
  ];
  if (command) args.push(command);
  const output = execFileSync("tmux", args, { encoding: "utf8" });
  return output.trim();
}

export function tmuxRenamePane(target: string, title: string): void {
  execFileSync("tmux", ["select-pane", "-t", safeSession(target), "-T", title]);
}

export function tmuxSelectPane(target: string): void {
  execFileSync("tmux", ["select-pane", "-t", safeSession(target)]);
}

export function tmuxSetOption(target: string, option: string, value: string): void {
  execFileSync("tmux", ["set-option", "-t", safeSession(target), option, value]);
}

export function tmuxKillSession(session: string): void {
  if (!tmuxSessionExists(session)) return;
  execFileSync("tmux", ["kill-session", "-t", safeSession(session)], { stdio: "ignore" });
}

export function tmuxSendCommand(session: string, command: string): void {
  const name = safeSession(session);
  execFileSync("tmux", ["send-keys", "-t", name, "-l", command]);
  execFileSync("tmux", ["send-keys", "-t", name, "Enter"]);
}

export function tmuxInjectText(session: string, text: string): void {
  execFileSync("tmux", ["send-keys", "-t", safeSession(session), "-l", text]);
}

export function tmuxSendEnter(session: string): void {
  execFileSync("tmux", ["send-keys", "-t", safeSession(session), "Enter"]);
}

export function tmuxCapturePane(session: string): string[] {
  try {
    const output = execFileSync("tmux", ["capture-pane", "-t", safeSession(session), "-p"], {
      encoding: "utf8",
    });
    return output.split("\n");
  } catch {
    return [];
  }
}

// The command currently running in the foreground of a pane, e.g. "claude",
// "codex", "zsh", "node". Returns "" when it cannot be determined (pane/session
// gone, tmux unavailable) — callers must not treat "" as "it's a shell".
export function tmuxPaneCurrentCommand(target: string): string {
  try {
    const output = execFileSync(
      "tmux",
      ["display-message", "-p", "-t", safeSession(target), "#{pane_current_command}"],
      { encoding: "utf8" },
    );
    return output.trim();
  } catch {
    return "";
  }
}

// Shells a pane falls back to once the agent CLI running inside it exits.
// tmux's pane_current_command already strips a login shell's leading "-",
// but normalizeShellName() strips it too in case that ever changes upstream.
const SHELL_FOREGROUND_COMMANDS = new Set(["sh", "bash", "zsh", "fish", "login"]);

function normalizeShellName(command: string): string {
  return command.startsWith("-") ? command.slice(1) : command;
}

// True once the agent CLI that used to run in this pane has exited and the
// pane fell back to an interactive shell prompt. An empty (undeterminable)
// result is treated as "not a shell" — a transient tmux hiccup should not be
// read as "the agent is gone".
export function isPaneBackAtShell(target: string): boolean {
  const current = tmuxPaneCurrentCommand(target);
  if (!current) return false;
  return SHELL_FOREGROUND_COMMANDS.has(normalizeShellName(current));
}

export function tmuxAttach(session: string): Promise<void> {
  const name = safeSession(session);
  if (process.env.TMUX) {
    execFileSync("tmux", ["switch-client", "-t", name], { stdio: "ignore" });
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        if (!tmuxSessionExists(name)) {
          clearInterval(timer);
          resolve();
        }
      }, 500);
    });
  }
  return new Promise((resolve) => {
    const child = spawn("tmux", ["attach", "-t", name], { stdio: "inherit" });
    child.on("exit", () => resolve());
  });
}

export class AgentTmuxBridge {
  private readonly queue: string[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private injecting = false;
  private stopped = false;

  constructor(
    private readonly session: string,
    private readonly client: "claude" | "codex",
    // Called when queued messages are dropped because the agent CLI is no
    // longer running in this pane. Lets the caller tell the room why the
    // mention went nowhere instead of injecting it into a bare shell.
    private readonly onAgentGone?: (droppedCount: number) => void,
  ) {}

  deliver(prompt: string): void {
    // Do not collapse whitespace here: injection uses bracketed paste, so
    // multi-line prompts arrive as one paste block in both CLIs, and pasted
    // code/diff content keeps its formatting.
    const text = prompt.trim();
    if (!text) return;
    this.queue.push(text);
    void this.drain();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.queue.length = 0;
  }

  private startPolling(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.drain(), 250);
  }

  private async drain(): Promise<void> {
    if (this.injecting || this.stopped) return;
    if (this.queue.length === 0) {
      this.stopPolling();
      return;
    }
    if (isPaneBackAtShell(this.session)) {
      // The agent CLI exited and the pane fell back to an interactive shell.
      // Retrying would eventually type the queued chat text as shell input
      // (bracketed paste + Enter), so drop the backlog instead of polling
      // forever and tell the room why, rather than injecting it silently.
      const dropped = this.queue.length;
      this.queue.length = 0;
      this.stopPolling();
      this.onAgentGone?.(dropped);
      return;
    }
    if (!this.isSafeToInject()) {
      this.startPolling();
      return;
    }
    const next = this.queue.shift();
    if (!next) return;
    this.injecting = true;
    try {
      await this.inject(next);
    } finally {
      this.injecting = false;
    }
    if (this.queue.length > 0) {
      void this.drain();
    } else {
      this.stopPolling();
    }
  }

  private isSafeToInject(): boolean {
    // The pane must still be running the agent CLI, not a bare shell left
    // behind after it exited (see the drain() check above, which handles the
    // drop + notify behavior for that case specifically).
    if (isPaneBackAtShell(this.session)) return false;
    const tail = tmuxCapturePane(this.session).slice(-20).join("\n");
    if (!tail.trim()) return false;
    if (this.client === "claude") {
      return ![
        "Enter to select",
        "Esc to cancel",
        "Allow ",
        "Deny ",
        "Yes / No",
      ].some((needle) => tail.includes(needle)) && !containsSpinner(tail);
    }
    return ![
      "Would you like to",
      "needs your approval",
      "Press Enter to confirm",
      "esc to interrupt",
    ].some((needle) => tail.includes(needle)) && !/Working\s*(\(|$)/.test(tail) && !containsSpinner(tail);
  }

  private async inject(text: string): Promise<void> {
    // Bracketed paste for both CLIs: multi-line text must arrive as one paste
    // block, not raw keystrokes where every newline submits a fragment.
    tmuxInjectText(this.session, "\x1b[200~");
    tmuxInjectText(this.session, text);
    tmuxInjectText(this.session, "\x1b[201~");
    await delay(150);
    tmuxSendEnter(this.session);
    if (this.client === "claude") {
      // Claude Code sometimes needs a second Enter to submit after a paste;
      // a second Enter on an already-empty composer is a no-op.
      await delay(80);
      tmuxSendEnter(this.session);
    }
  }

  private stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function containsSpinner(text: string): boolean {
  return /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(text);
}

function safeSession(session: string): string {
  return session.replace(/[^a-zA-Z0-9_.:%-]/g, "_");
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
