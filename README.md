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

One command opens a three-pane tmux room:

```bash
agent-room trio --room dev --name Alice --fresh
```

The left pane is the human room. The right panes run Claude Code and Codex. In the left pane:

```text
you> @cc first pass on this design
you> @codex challenge cc's conclusion
you> @all settle on the final version
```

Mouse pane switching is enabled. You can click the Codex pane to finish login, or use `Ctrl-b` then an arrow key. `Ctrl-b q` shows pane numbers.

Codex uses your normal `~/.codex` login state. `agent-room` only passes the room MCP config as temporary CLI overrides, so restarting the room should not require a fresh Codex login.

To create the tmux room without attaching immediately:

```bash
agent-room trio --room dev --name Alice --fresh --no-attach --keep
tmux attach -t agent_room_dev_trio
```

## Routing Modes

Default mode is `mentioned`.

| Mode | Behavior |
|---|---|
| `mentioned` | Trigger only on human `@agent` or `@all`; buffer agent messages as context |
| `people` | Trigger on human messages; buffer agent messages |
| `agents` | Trigger on agent messages; buffer human messages |
| `everyone` | Trigger on every non-self message |
| `silent` | Never trigger; only buffer context |

For the three-person room you described, use the default:

```bash
agent-room trio --room dev --name Alice --fresh
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
agent-room trio --room dev --name Alice --fresh
agent-room host --room dev --name Alice
agent-room run claude --name cc --server http://127.0.0.1:43110 --room dev
agent-room run codex --name codex --server http://127.0.0.1:43110 --room dev
agent-room send --server http://127.0.0.1:43110 --room dev "@cc hello"
```

For manual `run` commands, pass native Claude Code or Codex flags after `--`:

```bash
agent-room run claude --name cc --server http://127.0.0.1:43110 --room dev -- --dangerously-skip-permissions
agent-room run codex --name codex --server http://127.0.0.1:43110 --room dev -- --ask-for-approval never
```

For `trio`, pass repeated agent args with `--cc-arg=<value>` and `--codex-arg=<value>`:

```bash
agent-room trio --room dev --name Alice --fresh \
  --cc-arg=--dangerously-skip-permissions \
  --codex-arg=--ask-for-approval --codex-arg=never
```

Inside `agent-room host`:

- `/who` lists participants
- `/history` prints recent transcript
- `/archive` writes a markdown archive of the room right now
- `/where` prints the transcript JSONL path and the archive directory
- `/stats` prints participant and message counts plus storage paths
- `/exit` archives the current transcript automatically and stops the host

## Pull-by-Reference Continuity

Archives are the intended way to continue a prior discussion in a fresh room. When you exit a room, the host writes a markdown archive next to the JSONL transcript. Browse them later:

```bash
agent-room list
agent-room list --room dev
```

To resume a topic in a new room, start fresh and paste the archive path into your first mention:

```text
you> @cc @codex carrying on from ~/.agent-room/archives/dev/2026-04-21-180000.md — next question is...
```

The agents read the markdown on demand. The relay never force-injects the archive; only what you explicitly reference enters the agent's context. This keeps startup context small (important for Codex) and lets you combine multiple archives into one new discussion without changing the transcript schema.

Archive layout: `<data-dir>/archives/<room>/<yyyy-mm-dd-HHMMSS>.md`. Each archive has a frontmatter block (room, counts, participant list, time range) and then the full transcript as readable sections.

This is "pull by reference" on purpose. See [docs/design-principles.md](docs/design-principles.md) for why the relay does not push archives into new sessions automatically.

## Design Notes

Before changing routing, transcript schema, or anything that lets an agent trigger another agent without a human mention, read [docs/design-principles.md](docs/design-principles.md). It captures the invariants the rest of this repo depends on: why `mentioned` is the default, what a real agent-to-agent handoff would need (dedup, ack, TTL, single-consumption), and what transcript resume would require beyond message order.

Release steps live in [docs/release-checklist.md](docs/release-checklist.md).

## Borrowed Ideas

- Stoops: terminal room, MCP tools, tmux injection, engagement modes
- squad: simple command semantics and persistent transcript idea
- claude-code-studio: task/team framing and agent identity
- telegram-ai-bridge: loop-awareness and mention-first routing

This project intentionally starts smaller: local-only, one room server, Claude/Codex first.
