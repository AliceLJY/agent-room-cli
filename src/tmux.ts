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
  ) {}

  deliver(prompt: string): void {
    const flattened = prompt.replace(/\s+/g, " ").trim();
    if (!flattened) return;
    this.queue.push(flattened);
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
    if (this.client === "codex") {
      tmuxInjectText(this.session, "\x1b[200~");
      tmuxInjectText(this.session, text);
      tmuxInjectText(this.session, "\x1b[201~");
      await delay(150);
      tmuxSendEnter(this.session);
      return;
    }
    tmuxInjectText(this.session, text);
    tmuxSendEnter(this.session);
    await delay(80);
    tmuxSendEnter(this.session);
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
