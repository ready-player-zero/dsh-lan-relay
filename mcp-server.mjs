#!/usr/bin/env node
/**
 * LAN Relay MCP Server —— 把局域网消息总线暴露成 Agent 工具（stdio / JSON-RPC）
 *
 * 由 DSH 的 MCP 客户端按需拉起，进程生命周期跟随 DSH，不需要手动启动。
 * 配置全部来自 ~/.dsh/lan-relay/config.json（或 LAN_RELAY_* 环境变量）。
 *
 * 工具：
 *   relay_send    给另一台机器上的 Agent 发消息
 *   relay_inbox   取自己的新消息（推进游标，同一条只返回一次）
 *   relay_wait    长轮询等新消息（≤50 秒，避免超出 MCP 工具调用超时）
 *   relay_peers   看谁在线
 *   relay_status  看自己的配置与连通性
 */
import readline from 'node:readline';
import { loadConfig, RelayError } from './lib/config.mjs';
import { RelayClient } from './lib/relay-client.mjs';

const VERSION = '0.1.0';
const SERVER_INFO = { name: 'dsh-lan-relay', version: VERSION };

let client;
let configError = null;
try {
  client = new RelayClient(loadConfig());
} catch (error) {
  configError = error;
  console.error(`[lan-relay] 配置错误：${error.message}`);
}

function textResult(payload) {
  return {
    content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }],
  };
}

function errorResult(error) {
  const detail = error instanceof RelayError
    ? { error: error.message, hint: error.hint || undefined }
    : { error: String(error?.message || error) };
  return {
    content: [{ type: 'text', text: JSON.stringify(detail, null, 2) }],
    isError: true,
  };
}

function requireClient() {
  if (client) return client;
  throw new RelayError(
    `LAN relay 配置不可用：${configError?.message || '未知原因'}`,
    { hint: '运行 scripts/setup.ps1 生成 ~/.dsh/lan-relay/config.json，然后重启 DSH 或重连 MCP。' },
  );
}

function decorateMessages(result) {
  const now = Date.now();
  return {
    ...result,
    messages: result.messages.map((message) => ({
      seq: message.seq,
      from: message.from,
      from_session: message.from_session || '',
      to: message.to,
      to_session: message.to_session || '',
      thread: message.thread || '',
      text: message.text,
      sent_at: new Date(message.ts).toISOString(),
      age_seconds: Math.max(0, Math.round((now - message.ts) / 1000)),
    })),
  };
}

const TOOLS = [
  {
    name: 'relay_send',
    description:
      '给局域网内另一台机器上的 DSH Agent 发一条消息。to 填对方 peer 名（如 "pc1" / "b"），'
      + '或填 "*" 广播给所有其他 peer。to_session 可指定对方某个会话（如 session-a37a161f-...），'
      + '不填则由对方的 relay 插件投递到它配置的默认会话。消息会落盘在中继 hub 上，对方离线也会在下次上线时收到。'
      + '发送成功返回 seq，可用于引用/排障。',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '收件 peer 名（小写字母/数字/._-，≤32 字符），或 "*" 表示广播' },
        text: { type: 'string', description: '消息正文（≤32000 字符，建议写清背景与期望回复，因为对方是另一个 Agent）' },
        thread: { type: 'string', description: '可选话题标签，方便双方按 thread 归档（≤64 字符）' },
        to_session: { type: 'string', description: '可选：对方会话 id（如 session-a37a161f-...），用于精确投递/唤醒' },
        from_session: { type: 'string', description: '可选：你的会话 id，便于对方回复到同一会话' },
      },
      required: ['to', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'relay_inbox',
    description:
      '读取发给自己的新消息。默认会推进本地游标，所以同一条消息不会重复返回；'
      + '若想重读历史，可显式传 from_seq=0。返回 messages 数组（含 from/text/seq/age_seconds）和 has_more。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, description: '本次最多取多少条，默认 20' },
        from_seq: { type: 'integer', minimum: 0, description: '可选：从这个 seq 之后开始读（不传则用本地游标）' },
        mark_read: { type: 'boolean', description: '是否推进游标，默认 true；调试时可传 false' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'relay_wait',
    description:
      '长轮询等待新消息：没有消息时会阻塞到超时（最多 50 秒），有新消息立即返回。'
      + '典型用法：对方说"等我 30 秒"，你就调用 relay_wait(timeout_seconds=30)；'
      + '想持续在线可以循环调用，但每轮都会消耗一次模型调用。',
    inputSchema: {
      type: 'object',
      properties: {
        timeout_seconds: { type: 'number', minimum: 1, maximum: 50, description: '等待秒数，默认 25，上限 50' },
        after_seq: { type: 'integer', minimum: 0, description: '可选：从这个 seq 之后等（不传则用本地游标）' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'relay_peers',
    description: '查看同一中继上还有哪些 peer，以及各自是否在线（120 秒内有请求即视为在线）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'relay_status',
    description:
      '查看本机 relay 配置（self、relay_url、游标）与 hub 连通性。首次使用或通信失败时先调它排障。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const HANDLERS = {
  relay_send: async (args) => {
    const result = await requireClient().send({
      to: args?.to,
      text: args?.text,
      thread: args?.thread || '',
      toSession: args?.to_session || '',
      fromSession: args?.from_session || '',
    });
    return {
      ok: true,
      seq: result.message.seq,
      from: result.message.from,
      from_session: result.message.from_session || '',
      to: result.message.to,
      to_session: result.message.to_session || '',
      sent_at: new Date(result.message.ts).toISOString(),
      latest: result.latest,
      hub: result.hub,
    };
  },
  relay_inbox: async (args) => {
    const result = await requireClient().inbox({
      limit: Number.isInteger(args?.limit) ? args.limit : 20,
      fromSeq: Number.isInteger(args?.from_seq) ? args.from_seq : null,
      markRead: args?.mark_read !== false,
    });
    return decorateMessages(result);
  },
  relay_wait: async (args) => {
    const result = await requireClient().wait({
      timeoutSeconds: Number.isFinite(args?.timeout_seconds) ? args.timeout_seconds : 25,
      afterSeq: Number.isInteger(args?.after_seq) ? args.after_seq : null,
    });
    return decorateMessages(result);
  },
  relay_peers: async () => {
    const peers = await requireClient().peers();
    return {
      self: requireClient().self,
      relay_url: requireClient().relayUrl,
      peers: peers.peers || [],
      online_window_seconds: peers.online_window_seconds,
      latest: peers.latest,
    };
  },
  relay_status: async () => {
    const instance = requireClient();
    return instance.status();
  },
};

// ---------- MCP stdio 传输（换行分隔的 JSON-RPC 2.0） ----------
function writeMessage(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function fail(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } };
}

const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];

async function handleRequest(message) {
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : '2024-11-05';
      return ok(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          '这是两台机器之间的局域网通信通道。用 relay_send 给对面发消息，用 relay_inbox / relay_wait 收消息。'
          + '对方是另一个 DSH Agent，消息要写清楚背景、你要什么、期望的回复格式。',
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/roots/list_changed':
      return undefined;
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params?.name;
      const handler = HANDLERS[name];
      if (!handler) return fail(id, -32602, `未知工具：${name}`);
      try {
        const payload = await handler(params?.arguments || {});
        return ok(id, textResult(payload));
      } catch (error) {
        console.error(`[lan-relay] 工具 ${name} 失败：${error?.message || error}`);
        return ok(id, errorResult(error));
      }
    }
    case 'resources/list':
      return ok(id, { resources: [] });
    case 'prompts/list':
      return ok(id, { prompts: [] });
    default:
      if (isNotification) return undefined;
      return fail(id, -32601, `未实现的方法：${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    console.error(`[lan-relay] 收到非 JSON 行：${trimmed.slice(0, 200)}`);
    return;
  }
  Promise.resolve()
    .then(() => handleRequest(message))
    .then((response) => {
      if (response) writeMessage(response);
    })
    .catch((error) => {
      console.error(`[lan-relay] 处理请求异常：${error?.stack || error}`);
      if (message?.id !== undefined) {
        writeMessage(fail(message.id, -32603, String(error?.message || error)));
      }
    });
});

rl.on('close', () => process.exit(0));
process.on('uncaughtException', (error) => {
  console.error(`[lan-relay] uncaught: ${error?.stack || error}`);
});
process.on('unhandledRejection', (error) => {
  console.error(`[lan-relay] unhandledRejection: ${error?.stack || error}`);
});

console.error(`[lan-relay] MCP server v${VERSION} 已启动（self=${client?.self || '?'}，relay=${client?.relayUrl || '未配置'}）`);
