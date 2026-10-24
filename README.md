# dsh-lan-relay

> **English summary** — A zero-dependency message bus for multiple **DeepSeek Harness (DSH)** agents on the same LAN.
> One `hub` process keeps an on-disk queue; every machine talks to it over plain HTTP through an **MCP (stdio) server**,
> plus an optional **DSH plugin** that wakes the target session automatically — including a session that is not currently open
> (the plugin resumes it). No cloud, no third-party packages, no dependency on DSH internals.
>
> **Status:** v0.4.0 · **License:** MIT · **Requirements:** Node.js ≥ 18 (push plugin ≥ 22.19).
> Docs: [two-machine setup](docs/TWO-MACHINE-SETUP.md) · CLI / MCP usage below.

让**局域网内两台（或多台）机器上的 DSH Agent 互相通信**：发消息、离线补投、长轮询等回复、查看谁在线。

零第三方依赖（只用 Node 内置模块），不绑定 DSH 内部插件 API —— 通过标准 **MCP（stdio）** 接入，DSH 升级时不易失效。

---

## 0. 为什么是这个方案

| 方案 | 问题 |
|---|---|
| 现成插件 `dsh-agent-message` | 声明支持 `dsh < 0.2.0`，而当前 DSH 是 `0.2.1-rc.2`，装不上 |
| 现成插件 `dsh-team-rooms` | npm 上已标记 **RETIRED**（官方内置了 Agent Teams），且是进程内跨会话 |
| 现成插件 `@awiki/dsh-plugin` | peer 精确锁 `0.1.5-rc.2`，与 0.2.1-rc.2 不兼容 |
| 两台机器 MCP 直连（A 的 server 调 B 的 server） | B 侧没有"收件"概念，消息只能被主动调用，且 B 不在线就丢 |
| 用 IM（微信/QQ/Telegram）中转 | 依赖第三方账号与公网，本质是"人机"而不是 "agent↔agent" |
| **中心 hub + 两端 MCP 客户端（本方案）** | 单向依赖、消息落盘、离线可补投、局域网内网速、MCP 协议稳定 |

核心取舍：**默认是「拉」而不是「推」** —— Agent 不会凭空被唤醒，需要显式 `relay_inbox` / `relay_wait`；这样不依赖 DSH 内部 API，最稳。

需要「消息一到就自动开一轮」时，另装 `push-plugin/`（见 3.1 节）：它在 DSH 进程内长轮询 hub，把消息投递到指定会话并唤醒 agent，**目标会话没打开也能 resume**。两者共用同一份配置与同一条 HTTP 通道。

---

## 1. 架构

```
       机器 A（hub 机器）                                机器 B（peer 机器）
┌──────────────────────────────┐              ┌──────────────────────────────┐
│  DSH 会话                     │              │  DSH 会话                     │
│    │ MCP stdio               │              │    │ MCP stdio               │
│    ▼                          │              │    ▼                          │
│  mcp-server.mjs ──HTTP──┐     │              │  mcp-server.mjs ──HTTP──┐     │
│                          ▼     │              │                          ▼     │
│                    hub.mjs :8787 ◄───────────┼──────────────────────────┘     │
│                    （消息队列 + 长轮询 + 落盘） │                              │
└──────────────────────────────┘              └──────────────────────────────┘
```

- `hub.mjs`：只跑在一台机器上，TCP `8787`，提供 `/api/send`、`/api/inbox`、`/api/wait`、`/api/peers`、`/api/health`；消息追加写入 `messages.jsonl`，最多保留 5000 条/轮转 8MB。
- `mcp-server.mjs`：每台 DSH 由 MCP 客户端按需拉起（进程随 DSH 生命周期），把上面 4 个能力包装成 5 个 Agent 工具。
- `relay-cli.mjs`：不开 DSH 也能收发/排障，也可用于脚本和"没有 MCP 连接器"的机器（配 `examples/skill-lan-relay`）。

目录结构：

```
dsh-lan-relay/
├─ hub.mjs                  # 消息总线（跑在 hub 机器）
├─ mcp-server.mjs           # MCP stdio server（两端都跑，由 DSH 拉起）
├─ relay-cli.mjs            # 命令行客户端
├─ lib/config.mjs           # 配置解析（命令行 > env > ~/.dsh/lan-relay/config.json）
├─ lib/relay-client.mjs     # HTTP 客户端 + 本地游标
├─ push-plugin/             # ★ 阶段 2：DSH bundle 插件（自动唤醒，零外部 import）
│  ├─ index.js              #   插件入口（apply + inject）
│  ├─ lib/core.mjs          #   长轮询、按 session 投递、3 个原生工具
│  ├─ cordis.patch.yml      #   bundle patch（insert 一个插件行）
│  └─ test/core.test.mjs    #   9 项单测 + 真实 hub 端到端测试
├─ scripts/setup.ps1        # 一键写配置 + 打印 MCP 配置片段
├─ scripts/allow-firewall.ps1   # 放行 8787（需管理员）
├─ scripts/install-autostart.ps1 # 开机自启 + 崩溃自动重启（计划任务/启动文件夹/Run 键）
├─ start-hub.cmd            # 双击启动 hub（前台，便于看日志）
├─ examples/                # 配置样例 / MCP 导入 JSON / 无 MCP 时的 skill
└─ test/smoke.mjs           # 端到端冒烟测试（31 项断言）
```

---

## 2. 部署（两台机器，约 5 分钟）

### 2.0 准备

1. 两台机器都装 **Node.js 18+**（`node -v` 能看到版本；DSH 自带的运行时不能直接给外部脚本用）。
2. 把整个 `dsh-lan-relay` 文件夹复制到两台机器（路径可以不同，MCP 配置里写绝对路径）。
3. 选一台机器做 **hub**（建议选开机时间长的；关掉 hub 时 peer 之间就发不出新消息，但已入队的消息不丢）。
4. 确认两台机器互相能 ping 通，且在同一子网（跨网段要改防火墙的 `-RemoteAddress`）。

### 2.1 hub 机器

```powershell
cd dsh-lan-relay
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1 -Role hub -Self dw1
```

脚本会：生成/复用 token，写 `~/.dsh/lan-relay/config.json`，自动挑一个局域网 IP 作为 `relay_url`，
并在 `~/.dsh/lan-relay/mcp-connector.json` 生成可直接导入的 MCP 配置。
**记下输出里的 `relay_url` 和 `token`，peer 机器要用。**

启动 hub（任选一种）：

```powershell
# 前台（推荐先这样看日志）
node hub.mjs --config "$env:USERPROFILE\.dsh\lan-relay\config.json"

# 或双击 start-hub.cmd

# 或一条命令装成开机自启 + 崩溃自动重启（推荐长期使用，见第 2.1.1 节）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
```

放行防火墙（**管理员** PowerShell 执行一次）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\allow-firewall.ps1 -Port 8787
```

规则只放行 **Private 配置文件 + 本地子网 + TCP 8787**，不会暴露到公网。

### 2.1.1 开机自启（推荐）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
```

脚本会按顺序尝试三种方式，装上一种就停：

| 顺序 | 方式 | 说明 |
|---|---|---|
| 1 | 计划任务 `DSH-LAN-Relay-Hub` | 最稳（登录自启 + 异常重启），但**注册计划任务需要管理员权限**；没有权限会报 `Access is denied`，自动跳过 |
| 2 | 启动文件夹快捷方式 `DSH LAN Relay.lnk` | 不需要管理员，登录时由 Explorer 启动**隐藏窗口**的 `wscript.exe launch-hub.vbs` |
| 3 | 注册表 `HKCU\...\Run\DSH-LAN-Relay` | 兜底，同样不需要管理员 |

实际装出来的东西：

- 启动器：`~/.dsh/lan-relay/launch-hub.vbs`（隐藏窗口运行 node，**崩溃后 3 秒自动重启**；连续 3 次启动失败才放弃；已有实例时退出码 2，不会重复起）
- 日志：`~/.dsh/lan-relay/hub/hub.log`（启动器传 `--log`，隐藏进程也能排障）
- 关闭自启：`scripts\install-autostart.ps1 -Remove`（会删快捷方式/注册表/计划任务，并停掉启动器；已运行的 hub 不受影响）
- 指定方式：`-Method task|startup|runkey`；只装但先不启动：`-NoStart`

验证（重启电脑后最直观）：

```powershell
node relay-cli.mjs status                 # 应显示 🟢
Get-Content "$env:USERPROFILE\.dsh\lan-relay\hub\hub.log" -Tail 10
```

> **两个注意点**
> 1. 机器有多块网卡（比如同时有 `192.168.*` 和 `172.*`）时，脚本只会挑一个地址写进 `relay_url`。
>    请确认另一台机器在哪个网段：不在同一网段就改 `~/.dsh/lan-relay/config.json` 里的 `relay_url`（端口不变）。
> 2. 计划任务需要管理员；在 **DSH 的沙箱终端**里注册计划任务会被拒绝（`Access is denied`），
>    此时脚本会自动退回“启动文件夹快捷方式”，不需要管理员也能生效。想用计划任务就用管理员 PowerShell 重跑一次。



### 2.2 peer 机器

```powershell
cd dsh-lan-relay
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1 -Role peer -Self dw2 `
  -HubUrl http://10.0.0.10:8787 -Token <hub 机器输出的 token>
```

### 2.3 两台都挂上 MCP

**方式 A：GUI**
设置 → MCP 连接器（`dsh-mcp-connector`）→ 自定义连接：
- 名称：`lan-relay`
- 传输方式：`stdio`
- 命令：`node`
- 参数：`D:\tools\dsh-lan-relay\mcp-server.mjs`（写实际路径）
- 环境变量：`LAN_RELAY_CONFIG = C:\Users\<你>\.dsh\lan-relay\config.json`

**方式 B：JSON 导入**
把 `~/.dsh/lan-relay/mcp-connector.json` 的内容交给 `mcp_connector_import_json`（或在设置页粘贴导入）。
样例见 `examples/mcp-connector.json`。

**方式 C：`mcp_connector_configure`**
```
name: "lan-relay"
transport: "stdio"
command: "node"
args: ["<绝对路径>\\mcp-server.mjs"]
envJson: {"LAN_RELAY_CONFIG":"C:\\Users\\<你>\\.dsh\\lan-relay\\config.json"}
serverName: "lan_relay"
```

连接成功后工具名形如 `mcp__lan_relay__relay_send`。
如果连接设成了「按会话启用」，需要在当前会话里激活这些工具（`mcp_connector_session_tools`）。

### 2.4 验证

两台分别执行：

```powershell
node relay-cli.mjs status
node relay-cli.mjs peers
```

A 机器：

```powershell
node relay-cli.mjs send --to dw2 --text "ping from dw1"
```

B 机器：

```powershell
node relay-cli.mjs wait --timeout 20
```

能在 B 看到 `ping from dw1`，链路就通了。

---

## 3. 工具速查（Agent 侧）

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `relay_send` | 给另一台机器发消息（MCP 版） | `to`（peer 名或 `"*"` 广播）、`text`、可选 `to_session` / `from_session` / `thread` |
| `relay_inbox` | 取新消息（推进游标，不重复） | `limit`、`from_seq`（重读历史）、`mark_read` |
| `relay_wait` | 长轮询等消息（≤50s） | `timeout_seconds`（默认 25，上限 50） |
| `relay_peers` | 谁在线（120s 内有请求即在线） | — |
| `relay_status` | 配置 + hub 连通性，排障先看它 | — |

装阶段 2 的 push 插件后，还会多出 3 个原生工具：`lan_relay_send` / `lan_relay_sessions` / `lan_relay_status`（见 3.1）。

消息结构：`{seq, from, from_session, to, to_session, thread, text, sent_at, age_seconds}`。
离线补投：消息落盘，接收方下次 `relay_inbox`/`relay_wait` 时拿到；`seq` 全局递增，可用于对账。

### 典型对话

机器 A：

> 帮我给 dw2 发消息，让它把 `logs/app.log` 最后 50 行贴回来，然后等它 60 秒。

Agent A：`relay_send(to="dw2", text="请把 logs/app.log 最后 50 行贴回来…")` → `relay_wait(timeout_seconds=50)` → 可能再等一轮 → 把回复转述给你。

机器 B（你或另一个 Agent 触发它查看）：

> 看下 dw1 有没有消息。

Agent B：`relay_inbox()` → 执行 → `relay_send(to="dw1", text="<结果>")`。

### 关于"拉"与"等"

- 不调用 `relay_inbox` / `relay_wait` 就永远看不到消息；这是有意设计（不让后台进程偷偷花 token）。
- `relay_wait` 每轮最多 50 秒（DSH MCP 工具调用默认 60 秒超时），需要更久就多轮循环。
- 想让 B 一直在线等，可以在 B 会话里让它循环 `relay_wait`，但每轮都是一次模型调用，注意成本。
- 更省的方式：约定双方"发完就等一轮"，或由人把两边串起来（A 发完，人让 B 看 inbox）。

---

## 3.1 阶段 2：自动唤醒插件（dsh-lan-relay-push）

装了 `push-plugin/` 之后**不再需要手动调 `relay_inbox`**：插件在 DSH 进程内长轮询 hub，收到消息就注入指定会话并唤醒 agent。

### 机制

- 后台 `/api/wait` 长轮询（25 秒一轮；网络错误 3 秒重试，插件卸载自动停止）
- **按 session 投递**：消息带 `to_session` → 精确投递；不带 → `push.default_session` → 最近活跃会话；目标不在线 → 改投默认会话并在正文加 `[注意]`
- **唤醒**：`agent.followup()`（排队一轮并唤醒 driver）；`push.wake=false` 时改用 `agent.inject()`（只加背景、不唤醒）
- 注入正文自带 `peer` / `session` 与一行回复示例；`lan_relay_send` 自动填 `from_session`
- 与 MCP 共用游标 `<state_dir>/<self>.cursor.json`，同一条消息不会被插件和 `relay_inbox` 各投一次

### 安装 / 更新

```powershell
$dsh = "<DSH_INSTALL>\resources\runtime\cli\bin\dsh.cmd"
& cmd.exe /c "`"$dsh`" plugin --profile desktop add `"file:D:\tools\dsh-lan-relay\push-plugin`""
```

更新已装版本时先 `remove dsh-lan-relay-push` 再 `add`（pnpm 对同名 `file:` 目录不会自动重新拷贝）。

**新增 bundle 必须重启 DSH 才生效。** 重启后会话 id 不变（同一 session 日志），旧会话重新打开即恢复。

> 另一台机器（dw2）同步最新版本 + 装插件的完整步骤见 **[SYNC-DW2.md](SYNC-DW2.md)**（含要复制哪些文件、分步命令、注意事项）。

### 配置（`~/.dsh/lan-relay/config.json` 的 `push` 段）

```json
"push": {
  "enabled": true,
  "default_session": "session-00000000-0000-0000-0000-000000000000",
  "wake": true,
  "poll_timeout_seconds": 25
}
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | `false` 时只注册工具，不后台轮询 |
| `default_session` | `""` | 没有 `to_session` 的消息投递到哪个会话；留空则投最近活跃会话 |
| `wake` | `true` | `false` = 只 `inject()` 当背景，不主动跑一轮 |
| `poll_timeout_seconds` | `25` | 每轮长轮询秒数 |
| `offline_fallback` | `false` | **冷启动失败后是否兜底改投其它会话**。默认 `false`：不投递，只记日志（`stats.skipped++`），避免误投到无关会话 |
| `require_session` | `false` | `true` 时，**没有 `to_session` 的消息直接拒收**（只记日志）；默认 `false`：按默认会话投递并在正文打 `[注意] 发送方未指定 to_session` |
| `cold_session` | `prompt` | 目标 `to_session` 不在线时：`prompt` = 用 `sessionController.prompt()` 自动 resume 并投递；`drop` = 放弃 |

### 投递策略（0.1.7 起）

1. **精确优先**：`to_session` 指向的会话在线 → 直接投给它
2. **目标离线 → 冷启动投递**：`cold_session='prompt'`（默认）→ 调 Host 的 `sessionController.prompt()`，它会**自动 resume 该会话**并排入消息、唤醒 agent。**不需要在 GUI 里打开目标会话**（解决“一次只能开一个会话”的限制）
   - `cold_session='drop'` 时退化为不投递
   - 冷启动失败（会话不存在/归档/模型不可用等）→ 记日志；只有 `offline_fallback=true` 才改投其它在线会话
3. **无 `to_session`**：`require_session=true` → 拒收；否则投 `default_session`（在线时），正文带 `[注意] 发送方未指定 to_session`
4. **独立游标**：插件用 `state/push-<self>.json`，不再与 MCP 的 `<self>.cursor.json` 共用，手动 `relay_inbox`/`relay_wait` 不会再把消息“抢走”
5. 首次启动没有游标文件时，游标初始化为 hub 最新 seq（跳过历史，不会重放旧消息）

> 冷启动投递会真正把会话 resume 起来跑一轮（消耗 token）；如果那个会话的审批策略是 `ask` 且 GUI 没打开，需要审批的操作会 fail-closed，属预期行为。

### 验证

1. 重启 DSH（目标会话**不需要**提前打开）
2. 另一台机器执行：
   ```powershell
   node relay-cli.mjs send --to dw1 --to-session session-00000000-0000-0000-0000-000000000000 --text "自动唤醒测试"
   ```
3. 目标会话应**自动开始回复**（不需要人说话）；`lan_relay_status` 里 `stats.cold` / `stats.delivered` 会递增
4. 想确认冷启动：`stats.cold >= 1`，日志里有 `cold delivered seq=… -> session-…`

### 注意

- 插件只能投递到**本机 live 会话**（GUI 里打开着）；未打开的会话默认**不投递**（0.1.6 起），避免误投到无关会话。冷会话自动 `resume` 属于后续增强（涉及 agent 所有权，风险更高）。
- 一次投递 = 自动跑一轮模型，注意成本；不需要时可把 `push.enabled` 设为 `false`（改完重启生效）。
- 卸载：`dsh plugin --profile desktop remove dsh-lan-relay-push`，再重启。

---

## 4. 安全

- 所有 `/api/*` 都要 `x-relay-token`，两台机器 token 必须一致；hub 用**定长比较**（`timingSafeEqual`）。
- hub 默认监听 `0.0.0.0:8787`，只建议在**可信局域网**使用；防火墙规则限制为私有网络 + 本地子网。
- 不要在公网暴露 8787。需要跨公网时用 Tailscale / WireGuard 之类的隧道，再把 `relay_url` 指向隧道地址。
- 明文 HTTP：局域网内可接受；如果要跨不可信网络，请用隧道而不是自己上 TLS。
- 消息正文会落盘到 `~/.dsh/lan-relay/hub/messages.jsonl`（明文），注意别把密钥当消息发；文件轮转上限 8MB。

---

## 5. 排障

| 现象 | 原因 / 处理 |
|---|---|
| `连不上中继 http://…` | hub 没启动；或 IP 填错；或防火墙拦了。先在 hub 机器 `node relay-cli.mjs status` |
| `中继拒绝访问：token 不匹配` | 两台机器 token 不一致，改 `~/.dsh/lan-relay/config.json` 或重跑 setup |
| `relay_status` 报"未配置" | 配置文件不存在或字段缺失，跑 `scripts/setup.ps1` |
| 端口被占用 | `Get-NetTCPConnection -LocalPort 8787 -State Listen`；换端口要同时改两台机器 `relay_url` 和 hub 的 `hub.port` |
| MCP 工具没出现 | 连接没启用 / serverName 不同 / 需要重启 DSH；先看 MCP 连接器里该连接的启动日志 |
| MCP 启动失败 ENOENT | `node` 不在 DSH 的 PATH 里，把命令写成 node.exe 的绝对路径（如 `F:\work\software\nodedjs\node.exe`） |
| 收不到历史消息 | 同一条消息只返回一次；用 `relay_inbox(from_seq=0, mark_read=false)` 重读 |
| hub 数据被删/重建 | 本地游标可能超前，客户端会自动归零重拉（返回里 `cursor_reset: true`） |
| 两台不在同一子网 | 改防火墙 `-RemoteAddress` 为对方网段，或在路由器上放行 |
| 自启注册报 `Access is denied` | 计划任务需要管理员。脚本会自动退回启动文件夹方式；想用计划任务就用管理员 PowerShell 重跑，或加 `-Method startup` 直接走快捷方式 |
| 机器有多个网卡、对方连不上 | 确认 `relay_url` 的 IP 与对方同网段；改 `~/.dsh/lan-relay/config.json` 后重启 hub |

---

## 6. 不用 MCP 连接器时的兜底

把 `examples/skill-lan-relay/SKILL.md` 复制到 `~/.dsh/skills/lan-relay/SKILL.md`，
Agent 就会用 `relay-cli.mjs` 的 shell 命令来收发，不依赖 `dsh-mcp-connector`。

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\skills\lan-relay" | Out-Null
Copy-Item examples\skill-lan-relay\SKILL.md "$env:USERPROFILE\.dsh\skills\lan-relay\SKILL.md"
```

---

## 7. 自测

```powershell
node test/smoke.mjs
```

覆盖 31 项断言：hub 鉴权、MCP 握手、工具清单、点对点、长轮询、游标去重、广播、离线补投、hub 重启持久化、错误 token、参数校验、未配置提示。

---

## 8. 与 DSH 内置 Agent Teams 的关系

- **同一台机器、同一 DSH 实例内**的多 Agent 协作：用内置 Agent Teams（`spawn_teammate` / `send_message` / 共享任务板），不需要本项目。
- **不同机器**之间：Agent Teams 不跨进程/跨主机，本项目补的就是这个缺口。
- 两者可以叠加：本机 Agent Teams 里某个成员负责 `relay_send` 与远端对接。

---

## 9. 限制与升级路线

**阶段 2（自动唤醒）已实现**：见 3.1 的 `dsh-lan-relay-push` 插件（`agent.followup()` 注入 + 唤醒）。

**0.4 / 插件 0.1.7 起支持冷会话唤醒**：目标会话**不是 live 会话也能收**——插件调用 Host 的 `sessionController.prompt()` 自动 `resume` 目标会话、排队并唤醒它。这一条让"发给一个没打开的会话"从兜底投递变成正常路径。

仍存在的限制：

1. 冷会话唤醒依赖宿主提供 `sessionController`（DSH 0.2.x 桌面端已具备）；宿主版本不提供时会退回"默认会话兜底"，此时仍只对 live 会话可靠。
2. 投递即消耗一轮模型调用；`push.enabled=false` 可退回纯手动模式。
3. 附件/图片不走插件路径（agent 进程内路径不做附件准入），大内容请落盘后发路径；传输建议用临时 HTTP + SHA256 校验，不要把二进制塞进消息正文。
4. 改了 `mcp-server.mjs` 后必须让 MCP 进程重启（重连连接器），否则旧 schema 会静默吞掉新增参数（例如 `to_session`）。

如果想要更强的能力（冷会话唤醒、附件、流式回传），可升级到宿主 RPC `session.prompt` 路径（`@xmanrui/dsh-im` 就是这么做的），代价是依赖更多内部接口。
