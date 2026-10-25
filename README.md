# dsh-lan-relay

> **让不同机器上的 DeepSeek Harness Agent 直接对话。**
> 一个标准 DSH 插件：一台机器在 DSH 进程内当 hub，其余机器粘贴**加入码**即可加入；
> 消息离线补投、长轮询等回复、收到消息自动唤醒目标会话。
>
> MIT · DSH ≥ 0.2.1-rc.2 · Windows / macOS / Linux

---

## 1. 特性

- **一个包、一次安装**：标准 DSH bundle（Host 半 + Web 半），在「插件 → 添加插件」里输入包名即可装好。
- **零外部依赖**：只用 Node 内置模块，不拉第三方包，不依赖 DSH 内部 API 的私有实现。
- **进程内 hub**：服务端不需要额外进程、不需要开机自启项；hub 跟着 DSH 启动和退出。
- **加入码配对**：服务端一键生成一行 `dshrelay1.…`，内含地址 + token；对端粘贴即可，不用抄 IP。
- **离线队列 + 长轮询**：消息落盘，接收方下次在线时补投；`lan_relay_wait` 最多等 50 秒。
- **自动唤醒**：消息到达后投递到指定会话并让 Agent 跑一轮；目标会话没打开也能冷启动。
- **全图形化配置**：设置 → 局域网中继：角色、端口、token、加入码、在线 peer、连接测试、防火墙放行。
- **原生 Agent 工具**：7 个 `lan_relay_*` 工具，装好即可调用，无需额外配置。
- **对话式配置**：不想点界面时，让 Agent 调 `lan_relay_configure` 就能切角色/加入。

---

## 2. 快速开始

前置：两台机器都装了 DSH（≥ 0.2.1-rc.2），在同一局域网、能互相 ping 通。
更详细的分步说明（含换 token / 换端口 / 换机器）见 [docs/TWO-MACHINE-SETUP.md](docs/TWO-MACHINE-SETUP.md)。

### 第一步：两台机器都安装插件

**图形界面**：侧边栏 → **插件** → **添加插件** → 输入 `dsh-lan-relay` → 安装。

**或命令行**：

```powershell
dsh plugin --profile desktop add dsh-lan-relay
```

### 第二步：服务端机器

1. 打开 **设置 → 局域网中继**。
2. **运行角色** 选 **服务端** → **保存**。
3. 页面会显示：`Hub 状态：运行中`、端口 `8787`、**Token**、**加入码**（`dshrelay1.…`）、本机地址。
4. 防火墙开着的话，点 **一键放行防火墙** → 在 UAC 里点「是」。
5. 点加入码旁边的 **复制**，把这一行发给另一台机器。

### 第三步：客户端机器

1. **设置 → 局域网中继** → **运行角色** 选 **客户端**。
2. 把加入码粘贴到 **加入码** 输入框（会显示识别预览）。
3. **保存**。顶部显示 **客户端已连接**，`在线 peer` 里出现两台机器。

### 第四步：验证

在任意一台机器的会话里说：

> 用 lan_relay_peers 看下在线机器，然后给 pc1 发消息："ping from pc2"，并等 30 秒看回复。

对端 Agent 会自动被唤醒并回复。

---

## 3. 工作原理

```
             机器 A（服务端）                                机器 B（客户端）
┌────────────────────────────────────────┐    ┌────────────────────────────────────────┐
│ DSH 进程                                │    │ DSH 进程                                │
│  ┌─ Host 半 ─────────────────────────┐  │    │  ┌─ Host 半 ─────────────────────────┐  │
│  │ 内嵌 hub  0.0.0.0:8787             │  │    │  │ 中继客户端（HTTP 长轮询）          │  │
│  │ 中继客户端 127.0.0.1:8787          │◄─┼────┼──┤ 7 个 Agent 工具                    │  │
│  │ 7 个工具 + 自动唤醒                 │  │    │  │ 7 个工具 + 自动唤醒                 │  │
│  └───────────────────────────────────┘  │    │  └───────────────────────────────────┘  │
│  ┌─ Web 半 ──────────────────────────┐  │    │  ┌─ Web 半 ──────────────────────────┐  │
│  │ 设置 → 局域网中继                  │  │    │  │ 设置 → 局域网中继                  │  │
│  └───────────────────────────────────┘  │    │  └───────────────────────────────────┘  │
└────────────────────────────────────────┘    └────────────────────────────────────────┘
                    └───────────── 明文 HTTP + x-relay-token（仅局域网）──────────────┘
```

- **Host 半**（`index.js`）：读配置 → 按角色启停内嵌 hub → 注册工具 → 后台长轮询并唤醒会话 → 给设置页提供同源管理 API。
- **Web 半**（`client.js`）：只渲染设置页；所有读写都走 Host 半的 `/lan-relay/api/*`（仅回环地址可访问）。
- **配置**：`~/.dsh/lan-relay/config.json`；**消息落盘**：`~/.dsh/lan-relay/hub/messages.jsonl`（最多 5000 条 / 8MB 轮转）。
- 协议：`/api/health`、`/api/peers`、`/api/inbox`、`/api/wait`、`/api/send`，全部要 `x-relay-token`（定长比较）。

---

## 4. 设置页：局域网中继

| 区块 | 内容 |
|---|---|
| 顶部 | 运行状态徽标（服务端运行中 / 客户端已连接 / 未启用 / 异常）、刷新 |
| 运行角色 | **服务端**（本机起 hub）/ **客户端**（连别人的 hub）/ **关闭** |
| 服务端 | 端口、本机名称、Token（显示/复制/重新生成）、加入码（复制）、本机地址、Hub 状态/消息数/最新序号/数据目录、一键放行防火墙 |
| 客户端 | 加入码粘贴（自动解析）、或手填地址 + token、连接测试、在线 peer 列表、自动唤醒统计 |
| 底部 | 保存（只在点保存时写入）、每 3 秒自动刷新状态 |

所有改动都是**本地草稿**，只有点「保存」才生效；保存后 hub/轮询会按新配置立即重启，不需要重启 DSH。

---

## 5. Agent 工具

| 工具 | 说明 |
|---|---|
| `lan_relay_send` | 给另一台机器发消息：`to`（peer 名或 `"*"`）、`text`、可选 `to_session`、`thread` |
| `lan_relay_inbox` | 拉取新消息（推进游标；`from_seq=0` 可重读历史） |
| `lan_relay_wait` | 长轮询等消息（≤50 秒；超时返回空数组，不报错） |
| `lan_relay_peers` | 谁在线（120 秒内有请求即在线）+ hub 是否可达 |
| `lan_relay_sessions` | 本机活跃会话列表（用于回复时指定对方 `to_session`） |
| `lan_relay_status` | 总览：角色、hub、连通性、peer、唤醒统计；排障先调它 |
| `lan_relay_configure` | 对话式配置：`role`、`join_code`、`relay_url`、`token`、`self`、`port`、`regenerate_token` |

---

## 6. 投递与自动唤醒规则

1. 消息带 `to_session` 且该会话在线 → 精确投递并唤醒。
2. 目标会话不在线 → `push.cold_session=prompt`（默认）用 `sessionController.prompt()` 自动 resume 并投递。
3. 没带 `to_session` → 投给 `push.default_session`，留空则投最近活跃会话。
4. `push.wake=false` → 只注入背景，不主动跑一轮。
5. 冷启动失败 → 记日志；只有 `push.offline_fallback=true` 才改投其它在线会话。
6. 插件与手动 `lan_relay_inbox` / `lan_relay_wait` 使用**独立游标**，不会互相抢消息。

> **成本提示**：一次投递 = 自动跑一轮模型调用。不需要自动唤醒时把 `push.enabled` 设为 `false`，改用工具手动拉取。

---

## 7. 加入码与安全

- 加入码 = `dshrelay1.` + base64url(`{u: 地址, t: token, n: 机器名}`)，**不加密**，等同明文 token。
- 服务端「重新生成 token」后旧加入码失效，需要把新加入码发给所有客户端。
- 明文 HTTP 只适合**可信局域网**；不要把 8787 暴露到公网。跨不可信网络请用 Tailscale / WireGuard 等隧道，再把地址填进加入码。
- 管理 API 只接受回环地址请求；消息正文会明文落盘，不要把密钥当消息发。

---

## 8. 防火墙与网络

- hub 监听 `0.0.0.0:8787`，端口可在设置页修改（改完重新生成加入码）。
- Windows 防火墙开启时，服务端需要放行入站 TCP 8787（一次即可）：
  - 设置页 **一键放行防火墙**（UAC 授权；规则限定 Private + 本地子网）；
  - 或管理员 PowerShell：
    ```powershell
    New-NetFirewallRule -DisplayName "DSH LAN Relay 8787" -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow -Profile Private -RemoteAddress LocalSubnet
    ```
  - 精简版 Windows 没有 NetSecurity 模块时，脚本会自动退回 `netsh advfirewall firewall add rule ...`。
- 两台机器需在同一子网；跨网段把 `LocalSubnet` 换成对方网段。
- 多网卡时加入码默认用第一个局域网 IPv4；连不上就在「本机地址」里换一个，手动填到对端。

---

## 9. 配置参考

一般不用手改（设置页会写）。排查或脚本化时可编辑 `~/.dsh/lan-relay/config.json`：

| 字段 | 默认 | 说明 |
|---|---|---|
| `role` | 自动推断 | `server` / `client` / `off` |
| `self` | 主机名 | 本机 peer 名（小写字母/数字/`._-`，≤32） |
| `relay_url` | — | 客户端要连的 hub 地址；服务端自动写成 `http://127.0.0.1:<port>` |
| `token` | 服务端生成 | 两台机器必须一致 |
| `hub.host` / `hub.port` | `0.0.0.0` / `8787` | 服务端监听地址与端口 |
| `hub.data_dir` | `~/.dsh/lan-relay/hub` | 消息落盘目录 |
| `state_dir` | `~/.dsh/lan-relay/state` | 游标与调试日志 |
| `push.enabled` | `true` | 是否后台长轮询并自动唤醒 |
| `push.wake` | `true` | `false` = 只注入背景 |
| `push.default_session` | `""` | 没指定 `to_session` 的消息投给哪个会话 |
| `push.poll_timeout_seconds` | `25` | 每轮长轮询秒数 |
| `push.cold_session` | `prompt` | 目标会话未打开时自动 resume（`drop` = 放弃） |
| `push.offline_fallback` | `false` | 冷启动失败后是否改投其它会话 |
| `push.require_session` | `false` | `true` 时拒收没有 `to_session` 的消息 |

---

## 10. 故障排查

| 现象 | 处理 |
|---|---|
| 设置页「未启用」 | 选「服务端」或「客户端」并保存 |
| 客户端连不上 hub | 服务端 DSH 是否在运行；加入码里的 IP 是否正确；防火墙是否放行；点「连接测试」看具体错误 |
| 服务端「端口已被占用」 | 8787 上已有 hub（同一台机器的另一个 DSH 实例）在跑；停掉它或换端口后重新生成加入码 |
| token 不匹配 | 两台机器 token 不一致；重新复制加入码，或在服务端重新生成 token |
| 消息到了不唤醒 | 目标会话是否存在/归档；检查 `push.wake`、`push.cold_session`；`lan_relay_status` 看 `stats` 与 `last_error`；日志在 `~/.dsh/lan-relay/state/plugin.log` |
| 收不到历史消息 | 同一条消息只投一次；`lan_relay_inbox(from_seq=0, mark_read=false)` 重读 |
| hub 数据被重建 | 客户端游标可能超前，会自动归零重拉（返回 `cursor_reset: true`） |
| 界面入口找不到 | 自定义侧边栏模式（如 DS Bot）可能替换了设置入口；直接让 Agent 用 `lan_relay_configure` 配置，或在经典模式下打开设置 |

---

## 11. 开发

```powershell
npm test   # 9 项 node:test：hub 内核 / 插件集成（含真实 hub + 唤醒投递）/ Web 半结构
```

| 路径 | 作用 |
|---|---|
| `index.js` | Host 半：角色开关、内嵌 hub、工具、自动唤醒、管理 API |
| `client.js` | Web 半：设置 → 局域网中继 |
| `lib/hub-server.mjs` | 可内嵌 hub 内核（`createHub()`，无进程副作用） |
| `lib/join-code.mjs` | 加入码编解码 |
| `lib/core.mjs` | 长轮询、按会话投递、冷启动唤醒 |
| `lib/relay-client.mjs` | HTTP 客户端 + 游标 |
| `lib/plugin-config.mjs` | 配置读写、角色推断、token 生成 |
| `cordis.patch.yml` | bundle patch（插入 `lan-relay` 行） |
| `locale/` · `icon.svg` | 插件卡片标题/描述与图标 |
| `test/` | 内核 / 插件集成 / Web 半结构测试 |

发布：

```powershell
npm publish --access public   # package.json 的 files 白名单已包含运行所需文件
```

> 修改 `scripts/*.ps1` 时要保留 UTF-8 BOM（PowerShell 5.1 会按 ANSI 读取无 BOM 文件，中文会解析出错）。

---

## 12. 限制

1. hub 在 DSH 进程内：服务端机器的 DSH 关闭后，其他机器发不出新消息（已入队的不丢）。需要 7×24 就让服务端 DSH 常驻。
2. 同一台机器同一端口只能有一个 hub；多个 DSH 实例都选服务端时，后来的会报端口占用（预期保护）。
3. 明文 HTTP + 明文 token，只适合可信局域网。
4. 冷启动唤醒会真的 resume 会话并跑一轮（消耗 token）；审批策略为 `ask` 且 GUI 没打开时，需要审批的操作会 fail-closed。
5. 消息正文上限 32000 字符；大文件请落盘后发路径，或走临时 HTTP + 校验和。

---

## License

MIT © ready-player-zero
