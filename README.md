# Agent Room CLI

Local CLI room for a human, Claude Code, and Codex.

Chinese documentation: [README.zh-CN.md](README.zh-CN.md).

The design goal is simple: keep the original AI CLIs, put them in one shared terminal room, and make agents answer only when they are mentioned.

```text
you> @cc review the retry design
cc> I see two risks...

you> @codex do you agree with cc?
codex> Mostly, but I would change the backoff cap...

you> @cc fold codex's point into the final recommendation
cc> Updated recommendation...
```

## What This Is

`agent-room` starts a local HTTP/SSE room server. Human messages, Claude Code, and Codex messages share one transcript.

`agent-room run claude` and `agent-room run codex` launch the original CLI inside tmux. Each agent gets:

- MCP tools for `send_message`, `catch_up`, and `who`
- a room event relay
- mention-based trigger policy
- buffered context for messages it did not need to answer immediately

This is closer to an OpenClaw-style local agent room than a Telegram bridge.

## Install

From GitHub:

```bash
npm install -g github:AliceLJY/agent-room-cli
```

From a local checkout:

```bash
npm install
npm run build
npm link
```

Prerequisites:

- Node.js 20+
- tmux
- Claude Code CLI for `agent-room run claude`
- Codex CLI for `agent-room run codex`

## Quick Start

Terminal 1:

```bash
agent-room host --room dev --name Alice
```

Terminal 2:

```bash
agent-room run claude --name cc --server http://127.0.0.1:43110 --room dev
```

Terminal 3:

```bash
agent-room run codex --name codex --server http://127.0.0.1:43110 --room dev
```

Back in Terminal 1:

```text
you> @cc first pass on this design
you> @codex challenge cc's conclusion
you> @all settle on the final version
```

## Routing Modes

Default mode is `mentioned`.

| Mode | Behavior |
|---|---|
| `mentioned` | Trigger only on `@agent` or `@all`; buffer other messages as context |
| `people` | Trigger on human messages; buffer agent messages |
| `agents` | Trigger on agent messages; buffer human messages |
| `everyone` | Trigger on every non-self message |
| `silent` | Never trigger; only buffer context |

For the three-person room you described, use the default:

```bash
agent-room run claude --name cc --server http://127.0.0.1:43110 --room dev
agent-room run codex --name codex --server http://127.0.0.1:43110 --room dev
```

## How It Works

```text
human CLI
  -> room server
      -> JSONL transcript
      -> SSE event stream
          -> claude relay -> tmux injects trigger prompt -> Claude Code MCP send_message
          -> codex relay  -> tmux injects trigger prompt -> Codex MCP send_message
```

The non-mentioned agent still receives context later: its relay buffers messages that classify as `content`, then includes them in the next injected trigger prompt.

## Commands

```bash
agent-room host --room dev --name Alice
agent-room run claude --name cc --server http://127.0.0.1:43110 --room dev
agent-room run codex --name codex --server http://127.0.0.1:43110 --room dev
agent-room send --server http://127.0.0.1:43110 --room dev "@cc hello"
```

Pass native Claude Code or Codex flags after `--`:

```bash
agent-room run claude --name cc --server http://127.0.0.1:43110 --room dev -- --dangerously-skip-permissions
agent-room run codex --name codex --server http://127.0.0.1:43110 --room dev -- --ask-for-approval never
```

Inside `agent-room host`:

- `/who` lists participants
- `/history` prints recent transcript
- `/exit` stops the host

## Borrowed Ideas

- Stoops: terminal room, MCP tools, tmux injection, engagement modes
- squad: simple command semantics and persistent transcript idea
- claude-code-studio: task/team framing and agent identity
- telegram-ai-bridge: loop-awareness and mention-first routing

This project intentionally starts smaller: local-only, one room server, Claude/Codex first.
