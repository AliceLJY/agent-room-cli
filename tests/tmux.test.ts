import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same mocking approach as tests/launcher.test.ts: stub node:child_process so
// no real tmux process is required, and inspect the argv tmux.ts would have
// passed to decide what to hand back.
const calls = vi.hoisted(() => ({
  args: [] as string[][],
  paneCurrentCommand: "claude",
  capturedTail: "",
}));

vi.mock("node:child_process", () => ({
  execFileSync: (_file: string, args: string[]) => {
    calls.args.push(args);
    if (args[0] === "display-message") return calls.paneCurrentCommand;
    if (args[0] === "capture-pane") return calls.capturedTail;
    return "";
  },
  spawn: () => {
    throw new Error("spawn should not be called in this test");
  },
}));

const { AgentTmuxBridge, isPaneBackAtShell } = await import("../src/tmux.js");

describe("isPaneBackAtShell", () => {
  beforeEach(() => {
    calls.args.length = 0;
  });

  it("treats every shell in the whitelist as 'agent gone'", () => {
    for (const shell of ["sh", "bash", "zsh", "fish", "login"]) {
      calls.paneCurrentCommand = shell;
      expect(isPaneBackAtShell("pane")).toBe(true);
    }
  });

  it("strips a login shell's leading '-' before matching", () => {
    calls.paneCurrentCommand = "-zsh";
    expect(isPaneBackAtShell("pane")).toBe(true);
  });

  it("treats the agent CLI itself as present", () => {
    calls.paneCurrentCommand = "claude";
    expect(isPaneBackAtShell("pane")).toBe(false);
  });

  it("does not treat an undeterminable pane as 'agent gone'", () => {
    calls.paneCurrentCommand = "";
    expect(isPaneBackAtShell("pane")).toBe(false);
  });
});

describe("AgentTmuxBridge", () => {
  beforeEach(() => {
    calls.args.length = 0;
    calls.paneCurrentCommand = "claude";
    calls.capturedTail = "some normal chat output\n";
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("injects the prompt when the pane is still running the agent", async () => {
    const bridge = new AgentTmuxBridge("pane", "codex");
    bridge.deliver("hello from the room");
    await vi.advanceTimersByTimeAsync(500);

    const sendKeys = calls.args.filter((a) => a[0] === "send-keys");
    expect(sendKeys.length).toBeGreaterThan(0);
    expect(sendKeys.some((a) => a.includes("hello from the room"))).toBe(true);
  });

  it("drops the message and reports it instead of injecting into a bare shell", async () => {
    calls.paneCurrentCommand = "zsh";
    const onAgentGone = vi.fn();
    const bridge = new AgentTmuxBridge("pane", "claude", onAgentGone);
    bridge.deliver("this would have been typed into zsh");
    await vi.advanceTimersByTimeAsync(500);

    expect(onAgentGone).toHaveBeenCalledTimes(1);
    expect(onAgentGone).toHaveBeenCalledWith(1);
    const sendKeys = calls.args.filter((a) => a[0] === "send-keys");
    expect(sendKeys.length).toBe(0);
  });
});
