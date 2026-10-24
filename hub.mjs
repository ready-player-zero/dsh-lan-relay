#!/usr/bin/env node
/**
 * LAN Relay Hub —— 局域网消息总线（零依赖）
 *
 * 职责：给局域网内的多台 DSH 提供「离线队列 + 长轮询」的消息中转。
 * 只跑在其中一台机器上；另一台（以及未来更多台）只做客户端。
 *
 * 启动：
 *   node hub.mjs --config <路径>          # 推荐：复用 ~/.dsh/lan-relay/config.json
 *   node hub.mjs --port 8787 --token xxx  # 也可完全命令行指定
 *
 * HTTP API（全部需要 x-relay-token；可选 x-relay-peer 上报在线状态）：
 *   GET  /api/health
 *   GET  /api/peers
 *   GET  /api/inbox?peer=<name>&since=<seq>&limit=<n>
 *   GET  /api/wait?peer=<name>&since=<seq>&timeout=<sec>
 *   POST /api/send  {from, to, text, thread}
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { RelayError, readConfigFile, ensureDir } from './lib/config.mjs';

const VERSION = '0.1.0';
const MAX_MESSAGES = 5000;
const ROTATE_BYTES = 8 * 1024 * 1024;
const MAX_BODY_BYTES = 256 * 1024;
const ONLINE_WINDOW_MS = 120_000;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const startedAt = Date.now();
const args = parseArgs(process.argv.slice(2));

// ---------- 配置 ----------
let fileConfig = {};
if (args.config) {
  try {
    fileConfig = readConfigFile(String(args.config));
  } catch (error) {
    console.error(`[hub] 读取配置失败：${error.message}`);
    process.exit(1);
  }
}

const dataDir = ensureDir(
  path.resolve(
    String(args.data || process.env.LAN_RELAY_HUB_DATA || fileConfig.hub?.data_dir
      || path.join(os.homedir(), '.dsh', 'lan-relay', 'hub')),
  ),
);

// --log <文件>：隐藏窗口启动时把日志落盘，方便排障
const hubLogPath = typeof args.log === 'string'
  ? path.resolve(args.log)
  : (process.env.LAN_RELAY_HUB_LOG ? path.resolve(process.env.LAN_RELAY_HUB_LOG) : '');
if (hubLogPath) {
  try {
    ensureDir(path.dirname(hubLogPath));
    const original = console.error.bind(console);
    const write = (line) => {
      try {
        fs.appendFileSync(hubLogPath, `${new Date().toISOString()} ${line}\n`);
      } catch {
        /* 写日志失败不影响服务 */
      }
    };
    write(`=== hub start (pid=${process.pid}) ===`);
    console.error = (...parts) => {
      const line = parts.map((p) => (typeof p === 'string' ? p : String(p))).join(' ');
      write(line);
      try {
        original(...parts);
      } catch {
        /* 隐藏窗口下 stderr 可能不可写 */
      }
    };
  } catch {
    /* 忽略日志初始化失败 */
  }
}

const tokenPath = path.join(dataDir, 'token.txt');

function resolveToken() {
  if (args.token) return { token: String(args.token), source: '命令行 --token' };
  if (process.env.LAN_RELAY_TOKEN) return { token: process.env.LAN_RELAY_TOKEN, source: '环境变量 LAN_RELAY_TOKEN' };
  if (fileConfig.token) return { token: String(fileConfig.token), source: '配置文件 token 字段' };
  if (fs.existsSync(tokenPath)) {
    const saved = fs.readFileSync(tokenPath, 'utf8').trim();
    if (saved) return { token: saved, source: 'token.txt' };
  }
  const generated = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(tokenPath, `${generated}\n`, { mode: 0o600 });
  return { token: generated, source: '自动生成（已写入 token.txt，请在两台机器配置中填同一个值）' };
}

const { token, source: tokenSource } = resolveToken();
if (!token) {
  console.error('[hub] 未能确定 token');
  process.exit(1);
}

const host = String(args.host || process.env.LAN_RELAY_HUB_HOST || fileConfig.hub?.host || '0.0.0.0');
const port = Number(args.port || process.env.LAN_RELAY_PORT || fileConfig.hub?.port || 8787);
const hubName = path.basename(os.hostname()).toLowerCase() || 'hub';
const logPath = path.join(dataDir, 'messages.jsonl');

// ---------- 消息存储 ----------
/** @type {Array<{seq:number, from:string, to:string, text:string, thread:string, ts:number}>} */
let messages = [];
let seqCounter = 0;

function loadMessages() {
  if (!fs.existsSync(logPath)) return;
  const text = fs.readFileSync(logPath, 'utf8');
  const lines = text.split('\n');
  const loaded = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const item = JSON.parse(trimmed);
      if (Number.isInteger(item?.seq) && item.seq > 0 && typeof item.text === 'string') loaded.push(item);
    } catch {
      /* 跳过损坏行 */
    }
  }
  loaded.sort((a, b) => a.seq - b.seq);
  messages = loaded.slice(-MAX_MESSAGES);
  seqCounter = messages.reduce((max, item) => Math.max(max, item.seq), 0);
}

function rotateLogIfNeeded() {
  try {
    const stat = fs.statSync(logPath);
    if (stat.size <= ROTATE_BYTES) return;
    const backup = path.join(dataDir, `messages-${Date.now()}.jsonl`);
    fs.renameSync(logPath, backup);
    fs.writeFileSync(logPath, messages.map((m) => JSON.stringify(m)).join('\n') + '\n');
    console.error(`[hub] 日志轮转：${path.basename(backup)}`);
  } catch {
    /* 轮转失败不影响主流程 */
  }
}

function matchesFor(peer, since, limit = 200) {
  const result = [];
  for (const message of messages) {
    if (message.seq <= since) continue;
    if (message.from === peer) continue;
    if (message.to !== peer && message.to !== '*') continue;
    result.push(message);
    if (result.length >= limit) break;
  }
  return result;
}

/** @type {Set<{peer:string, since:number, timer:NodeJS.Timeout, finish:(msgs:any[], timedOut:boolean)=>void}>} */
const waiters = new Set();

function notifyWaiters() {
  for (const waiter of [...waiters]) {
    const found = matchesFor(waiter.peer, waiter.since, 100);
    if (found.length) waiter.finish(found, false);
  }
}

function appendMessage(message) {
  messages.push(message);
  if (messages.length > MAX_MESSAGES) messages = messages.slice(-MAX_MESSAGES);
  try {
    fs.appendFileSync(logPath, `${JSON.stringify(message)}\n`);
    rotateLogIfNeeded();
  } catch (error) {
    console.error(`[hub] 写日志失败：${error.message}`);
  }
}

// ---------- 在线状态 ----------
/** @type {Map<string, number>} */
const peers = new Map();

function touchPeer(req) {
  const name = String(req.headers['x-relay-peer'] || '').trim().toLowerCase();
  if (name) peers.set(name, Date.now());
  return name;
}

function peersSnapshot() {
  const now = Date.now();
  return [...peers.entries()]
    .map(([name, lastSeen]) => ({
      name,
      online: now - lastSeen < ONLINE_WINDOW_MS,
      last_seen_seconds: Math.round((now - lastSeen) / 1000),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- HTTP 工具 ----------
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function authOk(req) {
  const given = req.headers['x-relay-token'];
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new RelayError('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new RelayError('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(num)));
}

// ---------- 路由 ----------
loadMessages();

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url || '/', 'http://localhost');
  } catch {
    return sendJson(res, 400, { ok: false, error: 'bad url' });
  }
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  if (!pathname.startsWith('/api/')) {
    return sendJson(res, 404, { ok: false, error: 'not found', hint: '健康检查：GET /api/health（需 x-relay-token 头）' });
  }
  if (!authOk(req)) {
    return sendJson(res, 401, { ok: false, error: 'unauthorized', hint: '请求头 x-relay-token 与 hub 不一致' });
  }

  touchPeer(req);

  try {
    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        hub: {
          name: hubName,
          version: VERSION,
          hostname: os.hostname(),
          port,
          uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
          started_at: new Date(startedAt).toISOString(),
          data_dir: dataDir,
        },
        latest: seqCounter,
        message_count: messages.length,
        peers: peersSnapshot(),
      });
    }

    if (req.method === 'GET' && pathname === '/api/peers') {
      return sendJson(res, 200, {
        ok: true,
        latest: seqCounter,
        peers: peersSnapshot(),
        online_window_seconds: Math.round(ONLINE_WINDOW_MS / 1000),
      });
    }

    if (req.method === 'GET' && pathname === '/api/inbox') {
      const peer = String(url.searchParams.get('peer') || '').trim().toLowerCase();
      if (!peer) return sendJson(res, 400, { ok: false, error: '缺少 peer 参数' });
      const since = clampInt(url.searchParams.get('since'), 0, Number.MAX_SAFE_INTEGER, 0);
      const limit = clampInt(url.searchParams.get('limit'), 1, 200, 50);
      return sendJson(res, 200, {
        ok: true,
        self: peer,
        messages: matchesFor(peer, since, limit),
        latest: seqCounter,
        hub: { name: hubName, version: VERSION },
      });
    }

    if (req.method === 'GET' && pathname === '/api/wait') {
      const peer = String(url.searchParams.get('peer') || '').trim().toLowerCase();
      if (!peer) return sendJson(res, 400, { ok: false, error: '缺少 peer 参数' });
      const since = clampInt(url.searchParams.get('since'), 0, Number.MAX_SAFE_INTEGER, 0);
      const timeout = clampInt(url.searchParams.get('timeout'), 1, 120, 25);

      const existing = matchesFor(peer, since, 100);
      if (existing.length) {
        return sendJson(res, 200, {
          ok: true, self: peer, messages: existing, latest: seqCounter, timed_out: false,
          hub: { name: hubName, version: VERSION },
        });
      }

      let settled = false;
      const waiter = {
        peer,
        since,
        timer: null,
        finish: (found, timedOut) => {
          if (settled) return;
          settled = true;
          clearTimeout(waiter.timer);
          waiters.delete(waiter);
          if (res.writableEnded || res.destroyed) return;
          sendJson(res, 200, {
            ok: true,
            self: peer,
            messages: found,
            latest: seqCounter,
            timed_out: timedOut,
            hub: { name: hubName, version: VERSION },
          });
        },
      };
      waiter.timer = setTimeout(() => waiter.finish([], true), timeout * 1000);
      waiters.add(waiter);
      res.on('close', () => {
        if (settled) return;
        settled = true;
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
      });
      return undefined;
    }

    if (req.method === 'POST' && pathname === '/api/send') {
      const body = await readJsonBody(req);
      const from = String(body.from || req.headers['x-relay-peer'] || '').trim().toLowerCase();
      const to = String(body.to || '').trim().toLowerCase();
      const text = String(body.text ?? '');
      const thread = String(body.thread || '').slice(0, 64);
      const fromSession = String(body.from_session || req.headers['x-relay-session'] || '').trim();
      const toSession = String(body.to_session || '').trim();
      if (!from) return sendJson(res, 400, { ok: false, error: '缺少 from（发送方 peer 名）' });
      if (!to) return sendJson(res, 400, { ok: false, error: '缺少 to（收件人 peer 名，或 "*" 广播）' });
      if (!text.trim()) return sendJson(res, 400, { ok: false, error: '消息内容为空' });
      if (text.length > 32000) return sendJson(res, 400, { ok: false, error: '消息过长，上限 32000 字符' });
      if (to !== '*' && !/^[a-z0-9._-]{1,32}$/.test(to)) {
        return sendJson(res, 400, { ok: false, error: '收件人名字不合法' });
      }
      if ((fromSession && !/^[A-Za-z0-9._:-]{1,80}$/.test(fromSession))
        || (toSession && !/^[A-Za-z0-9._:-]{1,80}$/.test(toSession))) {
        return sendJson(res, 400, { ok: false, error: 'session id 不合法（只允许字母数字与 . _ : -，≤80 字符）' });
      }

      const message = {
        seq: seqCounter + 1,
        from,
        from_session: fromSession,
        to,
        to_session: toSession,
        text,
        thread,
        ts: Date.now(),
      };
      seqCounter = message.seq;
      appendMessage(message);
      notifyWaiters();
      console.error(`[hub] #${message.seq} ${from}${fromSession ? `/${fromSession}` : ''} -> ${to}${toSession ? `/${toSession}` : ''} (${text.length}B)`);
      return sendJson(res, 200, {
        ok: true,
        message: { ...message, seq: message.seq },
        latest: seqCounter,
        hub: { name: hubName, version: VERSION },
      });
    }

    return sendJson(res, 404, { ok: false, error: `未知接口：${req.method} ${pathname}` });
  } catch (error) {
    console.error(`[hub] 处理 ${req.method} ${pathname} 失败：${error?.message || error}`);
    if (!res.writableEnded) {
      sendJson(res, 500, { ok: false, error: String(error?.message || error) });
    }
    return undefined;
  } finally {
    const cost = Date.now() - started;
    if (cost > 2000) console.error(`[hub] 慢请求 ${req.method} ${pathname} ${cost}ms`);
  }
});

server.on('clientError', (error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  console.error(`[hub] clientError: ${error.message}`);
});

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.error(`[hub] 端口 ${port} 已被占用：很可能已经有一个 hub 在运行（这通常是正常的，不用重复启动）。`);
    // 退出码 2 通知自启动器：已有实例，不要再循环重启
    process.exit(2);
  }
  console.error(`[hub] 监听失败：${error?.message || error}`);
  process.exit(1);
});

server.listen(port, host, () => {
  const lanIps = Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === 'IPv4' && !item.internal)
    .map((item) => item.address);
  console.error('');
  console.error(`  LAN Relay Hub v${VERSION} 已启动`);
  console.error(`  监听      : http://${host}:${port}`);
  console.error(`  本机地址  : ${lanIps.map((ip) => `http://${ip}:${port}`).join('  ') || '(未检测到局域网 IP)'}`);
  console.error(`  数据目录  : ${dataDir}`);
  console.error(`  消息数    : ${messages.length}（最新 seq=${seqCounter}）`);
  console.error(`  token     : ${token}  （来源：${tokenSource}）`);
  console.error(`  另一台机器配置 relay_url 时请使用上面的局域网地址，token 填同一个值`);
  console.error('');
});

function shutdown(signal) {
  console.error(`[hub] 收到 ${signal}，正在关闭…`);
  for (const waiter of [...waiters]) waiter.finish([], true);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
  console.error(`[hub] 未捕获异常：${error?.stack || error}`);
});

export { VERSION, server };
