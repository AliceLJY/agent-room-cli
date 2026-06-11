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

> The package also exposes an `agent-room-mcp` bin. This is an **internal** MCP server launched automatically by `agent-room run`; it is not meant to be invoked directly.

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

Pane creation is not readiness. The left pane prints `[room] launching @cc (claude)…` when an agent launch is attempted, and `[room] @cc connected (claude)` once that agent's MCP server is actually attached to the room. Wait for `connected` before mentioning an agent; `/who` also shows per-agent connection state.

Multi-line pastes into the `you>` prompt are aggregated into one message instead of one message per line, and prompts injected into agent panes use bracketed paste — pasted code and diffs keep their formatting end to end.

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

Inside `agent-room host` (you type these at the `you>` prompt while the room is running):

- `/who` lists participants and per-agent connection state
- `/history` prints recent transcript
- `/exit` archives the current transcript automatically and stops the host

Rule of thumb: commands that start with `/` are room commands (typed inside the host). Commands that start with `agent-room` are shell commands (typed in any terminal, no room needed).

## Finding Past Discussions

When you `/exit`, the host writes a markdown archive of the whole room at `~/.agent-room/archives/<room>/<yyyy-mm-dd-HHMMSS>.md`. To browse past rooms later, open any terminal — you do not need to be in a room:

```bash
agent-room list
```

Each entry prints the last-activity time (when the discussion last had a message — not when the file was archived, so re-archiving a stale room cannot make it look fresh), the room name, message count, size, and the full archive path. Open the `.md` file with any markdown reader (or `cat`, `less`, your editor).

To continue a past discussion in a fresh room, paste the archive path into your first mention:

```text
you> @cc @codex carrying on from ~/.agent-room/archives/dev/2026-04-22-012638.md — next question is...
```

The agents read the archive on demand. The relay never force-injects past context — only what you explicitly reference enters an agent's context. See [docs/design-principles.md](docs/design-principles.md) for why this is intentional.

## Secret Redaction on Write

Every message sent through the room passes a conservative pattern-based redactor before it reaches the JSONL transcript, the SSE stream, or any `catch_up` buffer. The redactor targets PEM blocks, JWTs, common API keys (OpenAI, Anthropic, GitHub, AWS, Google, Slack), bearer tokens, and full `Authorization:` header lines. Matches are replaced with `[REDACTED:<type>]` and the server logs a short summary.

This is the write-side guard promised by design-principles §3a — once secrets enter a persistent transcript they are reachable in multiple places and effectively unrecoverable, so filtering happens before the first write. The pattern set is intentionally narrow; extend it with new tests rather than entropy heuristics.

## Buffer Drop Sentinel

Non-triggering messages are buffered per-agent until the next mention. The buffer is capped at 30 messages to keep injected prompts small (especially for Codex). When the cap is exceeded, the oldest messages are dropped and the count is surfaced in the next injected prompt as a single sentinel line that points the agent at `agent_room.catch_up`. This preserves the pull-by-reference model from design-principles §4 — the relay never re-injects dropped content on its own.

## Design Notes

Before changing routing, transcript schema, or anything that lets an agent trigger another agent without a human mention, read [docs/design-principles.md](docs/design-principles.md). It captures the invariants the rest of this repo depends on: why `mentioned` is the default, what a real agent-to-agent handoff would need (dedup, ack, TTL, single-consumption), and what transcript resume would require beyond message order.

Release steps live in [docs/release-checklist.md](docs/release-checklist.md).

## Relation to trio

The upstream protocol this room implements is `~/.claude/skills/trio/SKILL.md` (mirrored to `~/.codex/skills/trio/SKILL.md` via symlink). `trio` defines the three-person collaboration model — the roles, the default flow, the trigger phrases (`预读 brief`, `反向产品经理`, `借鉴审计`, `盲点扫描`, `三角制衡`). `agent-room-cli` is the runtime that makes those phrases executable inside a shared terminal room instead of living only as a mental model.

If you are reading this repo to borrow ideas: read the trio skill first for the protocol, then this repo for how a thin relay turns that protocol into something you can type.

## Borrowed Ideas

- Stoops: terminal room, MCP tools, tmux injection, engagement modes
- squad: simple command semantics and persistent transcript idea
- claude-code-studio: task/team framing and agent identity
- telegram-ai-bridge: loop-awareness and mention-first routing

This project intentionally starts smaller: local-only, one room server, Claude/Codex first.
