---
name: lan-relay
description: 在没有 MCP 连接器（或 MCP 工具未启用）的机器上，用命令行与局域网内另一台 DSH 互发消息时使用。发送、收件、等消息、查看在线 peer、排障。
---

# 局域网 Agent 通信（LAN Relay CLI）

通过命令行调用本机的 `dsh-lan-relay` 项目，与另一台机器上的 DSH 互发消息。
所有命令都读取 `~/.dsh/lan-relay/config.json`（relay_url / token / self）。

项目目录（按实际部署改）：`D:\tools\dsh-lan-relay`

## 1. 先确认连通

```bash
node "F:/work/dsh/dsh_workspace/dsh-lan-relay/relay-cli.mjs" status
```

- `可达=是` 说明 hub 正常；`可达=否` 看输出里的错误与提示（hub 没开 / IP 不对 / 防火墙 / token 不一致）。

## 2. 发消息

```bash
node "F:/work/dsh/dsh_workspace/dsh-lan-relay/relay-cli.mjs" send --to pc2 --text "帮我看下 X，回我 Y"
```

- `--to` 填对方 peer 名；`--to "*"` 广播给所有其他 peer。
- 对方离线也会入队，上线后能补收。

## 3. 收消息

```bash
node "F:/work/dsh/dsh_workspace/dsh-lan-relay/relay-cli.mjs" inbox --limit 10
```

同一条消息只会出现一次（本地游标）；想重读历史加 `--from-seq 0 --no-mark-read`。

## 4. 等消息（长轮询）

```bash
node "F:/work/dsh/dsh_workspace/dsh-lan-relay/relay-cli.mjs" wait --timeout 25
```

- 最多阻塞 25~50 秒，有新消息立即返回；超时返回空。
- 循环调用会持续消耗模型调用，建议只在明确的"等对方回复"场景用。

## 5. 查看在线 peer

```bash
node "F:/work/dsh/dsh_workspace/dsh-lan-relay/relay-cli.mjs" peers
```

120 秒内有过请求的 peer 视为在线。

## 6. 给 Agent 的使用约定

- 消息里写清：背景、你要对方做什么、期望的回复格式、是否需要 `relay_wait` 继续等。
- 对方是另一个 Agent，不要假设它有你的上下文。
- 任务结束用一句话总结回执，避免两边无止境互相等待。
