# dsh-lan-relay-push

DSH 插件（bundle）：**局域网消息自动唤醒**。

- 后台长轮询 `dsh-lan-relay` 的 hub（`/api/wait`），收到发给本机 peer 的消息后：
  - 消息带 `to_session` → 精确投递到该会话；
  - 不带 → 投递到配置的 `push.default_session`，再退回“最近活跃会话”；
  - 目标会话不在线 → 改投默认会话并在正文加 `[注意]` 说明；
  - 通过 `agent.followup()` 投递并**唤醒**该会话（不是 `inject()`，后者不唤醒）。
- 注册 3 个工具：
  - `lan_relay_send(to, text, to_session?, thread?)`：会自动带上本会话 id（`from_session`）
  - `lan_relay_sessions()`：列出本机活跃会话（id/标题/状态/工作目录）
  - `lan_relay_status()`：peer/hub 连通性/游标/默认会话/投递统计

配置复用 `~/.dsh/lan-relay/config.json`（与 hub/MCP/CLI 共用）：

```json
{
  "relay_url": "http://10.0.0.10:8787",
  "token": "...",
  "self": "dw1",
  "push": {
    "enabled": true,
    "default_session": "",
    "wake": true,
    "poll_timeout_seconds": 25
  }
}
```

- `push.enabled=false`：只注册工具，不后台轮询
- `push.default_session`：没有 `to_session` 的消息投递到哪个会话（建议填你最常用的会话 id）
- `push.wake=false`：只 `inject()` 作为上下文，不主动唤醒

安装（DSH 自带 CLI，装完需重启 DSH 才载入新 bundle）：

```powershell
& "<DSH_INSTALL>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "file:D:\tools\dsh-lan-relay\push-plugin"
```

测试：

```powershell
node --test push-plugin/test/
```
