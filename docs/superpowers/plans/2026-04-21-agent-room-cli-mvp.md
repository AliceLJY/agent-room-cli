# Agent Room CLI MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local CLI room where a human, Claude Code, and Codex can share one room transcript while agents only answer when mentioned.

**Architecture:** A local HTTP/SSE room server stores participants and messages. `agent-room run claude|codex` launches the original CLI in tmux, injects room events when policy says to wake the agent, and gives the agent MCP tools for sending messages and catching up. Non-triggering messages are buffered and included on the next trigger.

**Tech Stack:** Node.js, TypeScript, npm, tmux, Model Context Protocol SDK, JSONL persistence.

---

### Task 1: Project Shell

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `README.md`

- [x] Create npm package metadata, TypeScript config, and docs.
- [x] Prefer npm tooling and avoid Bun-specific runtime assumptions.

### Task 2: Room Core

**Files:**
- Create: `src/types.ts`
- Create: `src/store.ts`
- Create: `src/room-server.ts`
- Test: `tests/engagement.test.ts`

- [x] Define participant, message, event, and engagement types.
- [x] Implement JSONL-backed room state and SSE fanout.
- [x] Detect `@name`, `@identifier`, and `@all` mentions.

### Task 3: CLI Host

**Files:**
- Create: `src/cli.ts`
- Create: `src/client.ts`

- [x] Implement `agent-room host` for human room input.
- [x] Implement `agent-room send` for scripted messages.

### Task 4: Agent Runtime

**Files:**
- Create: `src/engagement.ts`
- Create: `src/tmux.ts`
- Create: `src/launcher.ts`
- Create: `src/mcp-server.ts`

- [x] Implement mention-first engagement policy.
- [x] Launch original `claude` or `codex` in tmux.
- [x] Configure MCP tools for agent room messaging.
- [x] Subscribe to room SSE, buffer context, and inject trigger prompts.

### Task 5: Verification and Release

**Files:**
- Modify: `README.md`

- [x] Run `npm install`.
- [x] Run `npm test`.
- [x] Run `npm run typecheck`.
- [x] Run `npm run build`.
- [x] Run `npm pack --dry-run`.
- [x] Smoke-test local host/send flow.
- [x] Initialize git, create GitHub repo, push `main`.
