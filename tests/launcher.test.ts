import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  sessionExists: false,
  created: [] as string[],
  killed: [] as string[],
  removed: [] as string[],
}));

vi.mock("node:child_process", () => ({
  execFileSync: () => {
    throw new Error("CLI missing");
  },
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    mkdtempSync: () => "/tmp/agent-room-startup-test",
    rmSync: (path: string) => {
      state.removed.push(path);
    },
  };
});

vi.mock("../src/tmux.js", () => ({
  AgentTmuxBridge: class {},
  tmuxAttach: async () => undefined,
  tmuxAvailable: () => true,
  tmuxCreateSession: (session: string) => {
    state.sessionExists = true;
    state.created.push(session);
  },
  tmuxKillSession: (session: string) => {
    state.sessionExists = false;
    state.killed.push(session);
  },
  tmuxSendCommand: () => undefined,
  tmuxSessionExists: () => state.sessionExists,
}));

import { runAgent } from "../src/launcher.js";

describe("runAgent startup cleanup", () => {
  beforeEach(() => {
    state.sessionExists = false;
    state.created.length = 0;
    state.killed.length = 0;
    state.removed.length = 0;
  });

  it("removes the temp directory and partial tmux session when startup fails", async () => {
    await expect(runAgent({
      client: "claude",
      name: "Claude",
      identifier: "cc",
      serverUrl: "http://127.0.0.1:4310",
      room: "dev",
      mode: "mentioned",
      attach: false,
      keep: true,
      extraArgs: [],
    })).rejects.toThrow("claude CLI is required");

    expect(state.created).toEqual(["agent_room_cc"]);
    expect(state.killed).toEqual(["agent_room_cc"]);
    expect(state.removed).toEqual(["/tmp/agent-room-startup-test"]);
  });
});
