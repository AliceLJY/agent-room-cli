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

## 安全边界

- 房间默认只绑定 `127.0.0.1`，并且**没有应用层鉴权**。`host` 和 `trio` 遇到非 loopback 的 `--host` 会拒绝启动，除非同时显式传入 `--unsafe-no-auth`。
- `--unsafe-no-auth` 只是明确接受风险的逃生口，不是安全的远程模式：任何能连到该端口的设备都能读取 transcript、订阅 SSE、注册参与者和发送消息。远程使用应优先走保留 loopback 监听的鉴权隧道。
- API 不开放跨域浏览器读取，JSON 请求体上限为 64 KiB。这些只是收窄暴露面的措施，不能代替鉴权。
- `~/.agent-room/` 下的 JSONL transcript 和 markdown 归档仍是敏感明文。pattern 脱敏只能尽力而为，不能保证剔除所有凭据或隐私内容。

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

默认已开启鼠标切 pane。Codex 要登录时，可以直接点右下角 Codex 窗格处理；也可以按 `Ctrl-b` 再按方向键切换，或者 `Ctrl-b q` 显示 pane 编号后按数字。

窗格出现不等于 agent 就绪。左边窗格会先打印 `[room] launching @cc (claude)…`（表示开始启动），等该 agent 的 MCP 真正接上房间后才打印 `[room] @cc connected (claude)`。@ 一个 agent 之前先等它的 `connected`；`/who` 也能看每个 agent 的连接状态。

在 `you>` 提示符里粘贴多行文本会聚合成一条消息（不再一行变一条）；注入到 agent 窗格的 prompt 走 bracketed paste，贴进去的代码和 diff 全程保留格式。

Codex 会复用你正常的 `~/.codex` 登录态。`agent-room` 只会通过临时 CLI 参数传入房间 MCP 配置，所以重开房间不应该要求重新登录 Codex。

如果只想创建 tmux 房间、稍后自己 attach：

```bash
agent-room trio --room dev --name Alice --fresh --no-attach --keep
tmux attach -t agent_room_dev_trio
```

## 路由模式

默认模式是 `mentioned`。

| Mode | 行为 |
|---|---|
| `mentioned` | 只在人类发出 `@agent` 或 `@all` 时触发；agent 消息只缓冲为上下文 |
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

在 `agent-room host` 里（房间开着时，在 `you>` 提示符后面敲）：

- `/who` 列出参与者和每个 agent 的连接状态
- `/history` 打印最近 transcript
- `/exit` 自动归档当前 transcript 并停止 host

记一个规律就不会混：`/` 开头的是房间命令（在 host 里敲），`agent-room` 开头的是系统命令（在任何终端里敲，不用进房间）。

## 回头查以前的聊天

`/exit` 时 host 会把整个房间写成一份 markdown，路径是 `~/.agent-room/archives/<房间名>/<年-月-日-时分秒>.md`。以后想翻旧账，打开任何终端——不用在房间里——敲：

```bash
agent-room list
```

每条输出的时间是该讨论的最后活动时间（最后一条消息的时间，不是归档时间——重复归档旧 transcript 不会让它看起来像新讨论），后面是房间名、消息数、文件大小和完整路径。用任何 markdown 阅读器（或 `cat`、编辑器）打开 `.md` 文件即可。

想在新房间接着以前的讨论聊，首次 @ 时贴上 archive 路径：

```text
you> @cc @codex 接上 ~/.agent-room/archives/dev/2026-04-22-012638.md 的讨论，下个问题是……
```

agent 会自己 Read 那份 markdown。relay 不会主动把旧上下文塞进新会话——只有你显式引用的内容才进入 agent 上下文。这么设计的原因见 [docs/design-principles.md](docs/design-principles.md)（英文）。

## 写入时的密钥剔除

每一条进入房间的消息在落到 JSONL transcript、推上 SSE 流、进入 `catch_up` buffer 之前，都会先过一层保守的 pattern 匹配。目前覆盖 PEM block、JWT、常见 API key（OpenAI / Anthropic / GitHub / AWS / Google / Slack）、bearer token，以及整行 `Authorization:` header。命中的部分会替换成 `[REDACTED:<type>]`，服务端会 warn 一行命中摘要。

这一层对应 design-principles §3a 的写入侧防线——secret 一旦进入 transcript，在归档 / catch_up 里也可能被读出来，撤回成本极高，所以过滤必须在第一次写入之前发生。pattern 集合刻意保守，要扩也优先新增 pattern + 测试，而不是加熵启发；即使没有出现脱敏警告，也要把 transcript 当敏感内容看待。

## Buffer 截断提示

每个 agent 在两次 mention 之间会把其它消息缓冲在本地。buffer 上限是 30 条，防止下一次 mention 注入时 prompt 炸掉（Codex 上下文尤其窄）。超过上限时最早的消息会被丢弃，丢弃条数会在下一次注入的 prompt 里作为一行 sentinel 出现，并指向 `agent_room.catch_up`。这保留了 design-principles §4 的 pull-by-reference 原则——relay 不主动把被丢弃的内容再塞回来，只告诉 agent "有这回事，需要自己拉"。

## 设计约束

改动路由、transcript schema，或任何让 agent 在没有人类 @ 的情况下触发另一个 agent 的路径之前，请先读 [docs/design-principles.md](docs/design-principles.md)（英文）。里面写清楚了这个 repo 依赖的几条不变式：为什么 `mentioned` 是默认、真正要做 agent-to-agent handoff 的话需要同时设计什么（dedup / ack / TTL / 单次消费），以及要让 transcript 支持跨 session resume 需要哪些现在还没有的字段。

发布步骤见 [docs/release-checklist.md](docs/release-checklist.md)。

## 与 trio 的关系

这个房间实现的是 `~/.claude/skills/trio/SKILL.md` 这份协议（通过 symlink 同步到 `~/.codex/skills/trio/SKILL.md` 给 Codex 侧看）。`trio` 定义了 Alice × Claude × Codex 三人协作的角色分工、默认流程、触发短语（`预读 brief` / `反向产品经理` / `借鉴审计` / `盲点扫描` / `三角制衡`）。`agent-room-cli` 是让这些短语真的能在共享终端里被"说出来并触发"的 runtime，不再只是一份心智模型。

想借鉴这个 repo 的人：先读 trio skill 拿协议，再回来看这个 repo 是怎么用薄 relay 把协议变成可以敲的命令。

## 借鉴来源

- Stoops：终端房间、MCP tools、tmux 注入、engagement modes
- squad：简单命令语义和持久 transcript 思路
- claude-code-studio：任务/team framing 和 agent identity
- telegram-ai-bridge：loop-awareness 和 mention-first routing

这个项目当前刻意保持小范围：默认只绑定 loopback、一个 room server、先支持 Claude/Codex。
