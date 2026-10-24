# 两台机器之间同步（hub → peer）与升级自动唤醒插件

> 适用：`dsh-lan-relay` **0.4.x**。
> 场景：hub 机器（跑 `hub.mjs`）已经升级，peer 机器还是旧版本，需要把新版文件与 `push-plugin` 同步过去，并让自动唤醒生效。
> peer 机器**不跑 hub**（两台各跑一个 hub 会把消息队列劈成两半）。

---

## 一、要同步哪些文件

### 方案 A（推荐）：整个目录覆盖

把 `dsh-lan-relay` 整个目录同步到 peer 机器的同一位置即可。里面已包含全部更新：

```
dsh-lan-relay/
├─ hub.mjs                    # hub 机器专用（peer 带上保持一致，但不启动）
├─ mcp-server.mjs             # ★ MCP stdio server
├─ relay-cli.mjs              # ★ 命令行工具
├─ lib/
│  ├─ config.mjs              #   配置解析
│  └─ relay-client.mjs        # ★ HTTP 客户端
├─ push-plugin/               # ★ DSH 插件（自动唤醒），整个目录
├─ scripts/
│  ├─ setup.ps1               # ★ 写配置（含 push 段）
│  ├─ allow-firewall.ps1      #   hub 机器用
│  └─ install-autostart.ps1   #   hub 机器用
├─ start-hub.cmd              # hub 机器用
├─ examples/                  # 配置样例
└─ test/                      # 自测
```

**不要同步的东西**：`~/.dsh/lan-relay/config.json` 与 `~/.dsh/lan-relay/state/` 是每台机器自己的，必须各用各的 `self` / `default_session`。

### 方案 B：最小集

最少覆盖这 5 项：

1. `lib/relay-client.mjs`
2. `mcp-server.mjs`
3. `relay-cli.mjs`
4. `push-plugin/`（整个目录）
5. `scripts/setup.ps1`

---

## 二、peer 机器上的操作

### 0. 拿到本机会话 id（可选但推荐）

在 peer 的 DSH 会话里让 Agent 执行：

```powershell
$env:DSH_SESSION_ID
```

形如 `session-xxxxxxxx-...`。记下来填 `-DefaultSession`。

> 不填也行：不带 `to_session` 的消息会投递到"最近活跃会话"，只是不够精确。

### 1. 先把文件放到 peer 上

SMB / 共享盘能通就直接拷；不通的两种常用办法：

- **临时 HTTP**（推荐）：在 hub 机器上 `python -m http.server 8899`（或任意静态服务），peer 侧 `Invoke-WebRequest` 拉取后校验 SHA256；
- **中继分段**：把文件 base64 后按段经 relay 发送。**注意**：装了 `push-plugin` 后，每一段都会被当成普通消息各唤醒一轮，噪声极大，非必要不用。

### 2. 覆盖项目目录

解压/覆盖到 peer 的项目目录。建议先备份旧目录。

### 3. 写 peer 自己的配置

```powershell
cd <peer 的项目目录>
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1 -Role peer -Self <peer名> `
  -HubUrl http://<hub-ip>:8787 `
  -Token <共享 token> `
  -DefaultSession <peer 的会话 id>
```

脚本会写 `~/.dsh/lan-relay/config.json`，其中 `push` 段：

```json
"push": {
  "enabled": true,
  "default_session": "<你填的会话 id>",
  "wake": true,
  "poll_timeout_seconds": 25,
  "offline_fallback": false,
  "require_session": false,
  "cold_session": "prompt"
}
```

再次运行会**保留**已有的 `push` 配置，不会重置。

### 4. 安装 / 更新自动唤醒插件

```powershell
# 更新时先移除旧版
& "<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop remove dsh-lan-relay-push

# 再安装
& "<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add `
  "file:<peer 的项目目录>\push-plugin"
```

输出里出现 `+ dsh-lan-relay-push` 就是成功。

> 部分 DSH 版本加装后即可热生效；稳妥起见重启一次 DSH（新 bundle 需要加载）。
> 重启会中断正在进行的会话，自己挑时机。

### 5. 验证

```powershell
node relay-cli.mjs status    # 应显示 🟢 可达=是
node relay-cli.mjs peers     # hub 与 peer 都应在线
```

从 hub 发一条定向消息：

```powershell
node relay-cli.mjs send --to <peer名> --to-session <peer 的会话 id> --text "自动唤醒测试：收到请回一句"
```

peer 的会话应在 25 秒内自动出现这条消息并开始回复，回复会自动带 `from_session`。

---

## 三、注意事项

| 事项 | 说明 |
|---|---|
| **不要在 peer 启动 hub** | 不要跑 `start-hub.cmd` / `install-autostart.ps1`；两台各一个 hub 会把队列劈成两半 |
| token 必须一致 | 两台机器 `config.json` 里的 `token` 相同 |
| `relay_url` 指向 hub | 形如 `http://<hub-ip>:8787` |
| 插件工具不显示 | 若会话里看不到 `lan_relay_*` 原生工具，用 MCP 的 `relay_send`（支持 `to_session`）或 CLI，功能不受影响 |
| 改了 MCP server 代码 | **必须让 MCP 进程重启**（重连连接器），否则旧 schema 会静默吞掉 `to_session` 之类的新参数 |
| 回滚 | `dsh.cmd plugin --profile desktop remove dsh-lan-relay-push`，并把 `config.json` 的 `push.enabled` 改 `false` |

---

## 四、版本对照（0.3 → 0.4）

| 文件 | 变更 |
|---|---|
| `hub.mjs` | 消息带 `from_session` / `to_session` |
| `mcp-server.mjs` | `relay_send` 支持 `to_session` / `from_session` |
| `relay-cli.mjs` | `send` 支持 `--to-session` / `--from-session` |
| `lib/relay-client.mjs` | `send()` 透传 session 字段 |
| `push-plugin/` | 冷会话唤醒（目标会话不在线时自动 resume）、独立游标、策略开关、诊断日志 |
| `scripts/setup.ps1` | 新增 `-DefaultSession` / `-DisablePush`，写并保留 `push` 段 |
