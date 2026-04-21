# Design Principles

These are invariants, not features. They exist because the value of this repo is what it *refuses* to do: it stays a thin relay between native agent CLIs, and pushes every richer behavior back onto the agents themselves.

Read this before adding routing logic, transcript fields, or agent-to-agent automation.

## 1. Mention-first is a default, not an implementation detail

The `mentioned` engagement mode is the designed default for the trio room. It is the single mechanism that prevents agent-to-agent trigger loops.

Before changing the default, or before adding any path where an agent reply can trigger another agent without a human mention, you must show how bot-loop prevention is preserved by some other mechanism (turn budgets, explicit acks, dedup keys, etc.).

"The user probably wants it" is not a substitute for a loop-prevention argument.

## 2. Agent-to-agent handoff needs delivery semantics, not just routing

A future `handoff: { next: codex }` hint on a message is tempting — it would let `cc` declare "Codex should reply next" without a human mention. Do not ship this as a routing-only field.

If agent-to-agent handoff is added, the same change must specify:

- **Dedup key** — each handoff is identified so replays or reconnects don't double-fire. See the existing SSE reconnect logic in `src/client.ts` for prior art on replay risk.
- **Ack** — the receiving agent signals consumption; without this, transient failures silently drop handoffs or cause retries.
- **TTL** — a handoff that is not consumed within a bounded window expires, not accumulates.
- **Single-consumption semantics** — at-most-once per target, explicitly documented; if at-least-once is chosen instead, the receiver must be idempotent by design.

A handoff without these four is just a new way to reintroduce the bot-loop that mention-first currently blocks.

## 3. Transcript resume needs causal schema, not just message order

Today `RoomMessage` (see `src/types.ts`) records `senderId`, `content`, `mentions`, and `createdAt`. This is enough for live replay and `catch_up` buffering. It is **not** enough to support "come back tomorrow and pick up the thread."

If session resume is added, the schema must grow to capture:

- **`parentId` / `causedBy`** — the message that caused this one (a human prompt, an agent reply, a mention-trigger). A flat timeline cannot reconstruct why a reply happened.
- **`triggerSource`** — which mention, which relay, which engagement rule fired the agent. Without this, resumed context looks complete but is semantically lossy.
- **`visibility`** — which agents were in scope at send time. Agents join and leave; a resumed transcript must know who could have seen what.
- **Tool / result summaries** — when an agent ran tools before replying, a short summary is persisted alongside the reply. Raw tool logs are out of scope; a one-line summary that makes the reply legible tomorrow is in scope.

Until these fields exist, resume remains explicitly unsupported, and features that *assume* resume (multi-day channels, cross-session pins, persistent handoffs) should not land.

### 3a. Tool / result summaries require a redaction policy, not an afterthought

The `tool / result summaries` field above is the most dangerous item on that list. MCP tool arguments routinely carry tokens, API keys, cookies, auth headers, and local file paths. The transcript is persistent JSONL (see `src/store.ts` and the `/history` command in `agent-room host`), it is replayed over SSE, and it can be pulled into `catch_up` buffers — once sensitive content enters it, it is reachable in multiple places and effectively unrecoverable.

For that reason, the PR that adds tool/result summaries to the schema must land together with its redaction policy. Specifically:

- **Allowlist, not truncation** — define which fields of a tool call/result are summarizable. Mechanical truncation ("first 200 chars") leaks headers and secrets verbatim.
- **Type-based drops** — arguments typed as credential-like (`token`, `apiKey`, `authorization`, `cookie`, `password`, file paths outside the room's working dir) are dropped, not truncated.
- **Pattern matching on values** — regardless of field name, values matching known secret patterns (bearer tokens, JWTs, PEM blocks, high-entropy base64) are dropped.
- **Opt-in per tool** — a tool's summary format is registered explicitly; unknown tools summarize to `"<tool_name> called"` only.
- **No "log first, redact later"** — the redaction runs before the summary touches the transcript, not after.

This mirrors the mention-first principle: both are "default conservative, require explicit justification to widen." Retrofitting redaction onto an already-persisted transcript is strictly harder than gating writes from day one.

## 4. Continuity across rooms is pull-by-reference, not push-by-default

When you need a new room to benefit from a prior discussion, the flow is: archive the prior room to markdown, start a fresh room, and reference the archive path explicitly in your first mention. The agent reads the archive on demand through its own file-reading tools. The relay does not force-inject prior archives into new sessions.

This is a deliberate choice and not a limitation to be "fixed" with auto-resume. The push model (relay loads N prior messages at agent startup) has three problems that pull-by-reference avoids:

- **Every startup pays for the discussion**, even when the user did not need to continue it. This is especially hostile to Codex, whose context window is smaller than Claude Code's.
- **The relay has to decide what is relevant.** It cannot, without re-implementing the summarization and causal-replay problems that section 3 defers.
- **Cross-discussion composition is unnatural.** Combining references to two or three prior archives in one new mention (`"carrying on from A.md and B.md..."`) is trivial with pull-by-reference and awkward with push.

Operationally: `/exit` in `agent-room host` autosaves a markdown archive; `agent-room list` indexes them; the archive format is a frontmatter block plus the transcript in human-readable sections. The archive is the user's artifact — they can edit it, annotate it, delete it, or merge archives by hand before referencing.

The redaction rules in section 3a still apply to archives the moment tool/result summaries enter `RoomMessage`. An archive that includes unredacted tool calls is as dangerous as a transcript that does. Archive generation must route through the same redaction path.

## 5. When in doubt, keep the relay thin

The room server is a transport and a transcript. It is not a chat UI, not an orchestration layer, not an agent framework.

If a proposed feature would be equally well expressed as:

- an agent-side skill or prompt,
- an external tool the agent calls via MCP,
- a convention in how humans structure their mentions,

prefer those over adding it to the relay. The native CLIs already have skills, memory, and auth. Duplicating any of that here is how this project stops being small.

## Prior decisions that embody these principles

- `src/engagement.ts` — mention-first routing is centralized here; changes to it are load-bearing.
- Commit `1a1f0ee` (`keep agent replies passive by default`) — hardened the default after observing that agent replies were being treated as triggers.
- Commit `365a37f` (`preserve codex login state`) — the relay does not touch native auth; it passes MCP config through CLI args only.
- Commit `ace4721` (`reconnect room event streams`) — replay/reconnect correctness is a relay concern; agents must not re-act on replayed events.
