# Agent Room CLI

一个本地 CLI 房间，让你、Claude Code 和 Codex 在同一个终端协作空间里对话。

主文档是英文版：[README.md](README.md)。

设计目标很直接：保留原生 AI CLI，把它们放进同一个共享终端房间，并让 agent 只在被点名时回答。

```text
you> @cc review the retry design
cc> I see two risks...

you> @codex do you agree with cc?
codex> Mostly, but I would change the backoff cap...

you> @cc fold codex's point into the final recommendation
cc> Updated recommendation...
```

## 这是什么

`agent-room` 会启动一个本地 HTTP/SSE 房间服务器。你的消息、Claude Code 的消息、Codex 的消息会进入同一份 transcript。

`agent-room run claude` 和 `agent-room run codex` 会在 tmux 里启动原生 CLI。每个 agent 会获得：

- MCP tools：`send_message`、`catch_up`、`who`
- 房间事件 relay
- 基于 mention 的唤醒策略
- 未被要求回答时的上下文缓冲

它更接近 OpenClaw 式的本地 agent room，而不是 Telegram bridge。

## 安装

从 GitHub 安装：

```bash
npm install -g github:AliceLJY/agent-room-cli
```

从本地 checkout 安装：

```bash
npm install
npm run build
npm link
```

前置依赖：

- Node.js 20+
- tmux
- Claude Code CLI，用于 `agent-room run claude`
- Codex CLI，用于 `agent-room run codex`

## 快速开始

一条命令打开一个三窗格 tmux 房间：

```bash
agent-room trio --room dev --name Alice --fresh
```

左边窗格是你的聊天框，右边两个窗格分别跑 Claude Code 和 Codex。你在左边输入：

```text
you> @cc first pass on this design
you> @codex challenge cc's conclusion
you> @all settle on the final version
```

如果只想创建 tmux 房间、稍后自己 attach：

```bash
agent-room trio --room dev --name Alice --fresh --no-attach --keep
tmux attach -t agent_room_dev_trio
```

## 路由模式

默认模式是 `mentioned`。

| Mode | 行为 |
|---|---|
| `mentioned` | 只在 `@agent` 或 `@all` 时触发；其他消息缓冲为上下文 |
| `people` | 人类消息会触发；agent 消息缓冲 |
| `agents` | agent 消息会触发；人类消息缓冲 |
| `everyone` | 每条非自己消息都会触发 |
| `silent` | 从不触发，只缓冲上下文 |

你想要的三人房默认就用 `mentioned`：

```bash
agent-room trio --room dev --name Alice --fresh
```

## 工作方式

```text
human CLI
  -> room server
      -> JSONL transcript
      -> SSE event stream
          -> claude relay -> tmux injects trigger prompt -> Claude Code MCP send_message
          -> codex relay  -> tmux injects trigger prompt -> Codex MCP send_message
```

未被点名的 agent 后续仍然能看到上下文：它的 relay 会把 `content` 类型消息缓冲起来，下次被点名时一起注入。

## 命令

```bash
agent-room trio --room dev --name Alice --fresh
agent-room host --room dev --name Alice
agent-room run claude --name cc --server http://127.0.0.1:43110 --room dev
agent-room run codex --name codex --server http://127.0.0.1:43110 --room dev
agent-room send --server http://127.0.0.1:43110 --room dev "@cc hello"
```

手动 `run` 时，原生 Claude Code 或 Codex 参数放在 `--` 后面透传：

```bash
agent-room run claude --name cc --server http://127.0.0.1:43110 --room dev -- --dangerously-skip-permissions
agent-room run codex --name codex --server http://127.0.0.1:43110 --room dev -- --ask-for-approval never
```

用 `trio` 时，通过重复的 `--cc-arg=<value>` 和 `--codex-arg=<value>` 传参数：

```bash
agent-room trio --room dev --name Alice --fresh \
  --cc-arg=--dangerously-skip-permissions \
  --codex-arg=--ask-for-approval --codex-arg=never
```

在 `agent-room host` 内部：

- `/who` 列出参与者
- `/history` 打印最近 transcript
- `/exit` 停止 host

## 借鉴来源

- Stoops：终端房间、MCP tools、tmux 注入、engagement modes
- squad：简单命令语义和持久 transcript 思路
- claude-code-studio：任务/team framing 和 agent identity
- telegram-ai-bridge：loop-awareness 和 mention-first routing

这个项目当前刻意保持小范围：local-only、一个 room server、先支持 Claude/Codex。
