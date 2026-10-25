/**
 * LAN Relay Hub 内核 —— 可被 DSH 插件在进程内嵌入的局域网消息总线（零依赖）
 *
 * 与旧版独立进程 hub.mjs 的行为完全一致：
 *   - HTTP API：/api/health /api/peers /api/inbox /api/wait /api/send
 *   - 鉴权：x-relay-token + crypto.timingSafeEqual
 *   - 消息：{seq, from, from_session, to, to_session, text, thread, ts}
 *   - 落盘：messages.jsonl 追加，最多 5000 条，8MB 轮转
 *   - 在线窗口 120s、长轮询 notifyWaiters、256KB body 上限、慢请求日志
 *
 * 用法：
 *   import { createHub } from './lib/hub-server.mjs';
 *   const hub = createHub({ host: '0.0.0.0', port: 8787, token, dataDir });
 *   await hub.start();      // 监听失败会 reject（错误对象保留 code，如 EADDRINUSE），绝不 process.exit
 *   hub.status();           // { running, host, port, messages, latestSeq }
 *   await hub.stop();       // 结束长轮询 waiter、关闭 server，可重复调用
 *
 * 本模块不注册任何进程级信号处理，也不调用 process.exit —— 退出策略由宿主决定。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { RelayError, ensureDir } from './config.mjs';

export const VERSION = '0.1.0';
export const MAX_MESSAGES = 5000;
export const ROTATE_BYTES = 8 * 1024 * 1024;
export const MAX_BODY_BYTES = 256 * 1024;
export const ONLINE_WINDOW_MS = 120_000;

function defaultDataDir() {
  return path.join(os.homedir(), '.dsh', 'lan-relay', 'hub');
}

/** 局域网 IPv4 候选地址（与旧版 banner 一致，不含内部/回环地址） */
function lanUrls(port) {
  const seen = new Set();
  const urls = [];
  for (const item of Object.values(os.networkInterfaces()).flat()) {
    if (!item || item.family !== 'IPv4' || item.internal) continue;
    if (seen.has(item.address)) continue;
    seen.add(item.address);
    urls.push(`http://${item.address}:${port}`);
  }
  return urls;
}

function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(num)));
}

/**
 * 创建一个 hub 内核实例（构造时不监听、不读盘，start() 时才真正启动）。
 *
 * @param {{
 *   host?: string,
 *   port?: number,
 *   token?: string,
 *   dataDir?: string,
 *   logger?: (...args: any[]) => void,
 *   name?: string,
 * }} [options]
 * @returns {{
 *   start: () => Promise<{host:string, port:number, urls:string[], dataDir:string, messages:number, latestSeq:number}>,
 *   stop: () => Promise<void>,
 *   status: () => {running:boolean, host:string, port:number, messages:number, latestSeq:number},
 *   readonly server: import('node:http').Server | null,
 * }}
 */
export function createHub(options = {}) {
  const host = String(options.host || '0.0.0.0');
  const configuredPort = Number(options.port ?? 8787);
  const token = String(options.token ?? '');
  const dataDir = path.resolve(String(options.dataDir || defaultDataDir()));
  const logPath = path.join(dataDir, 'messages.jsonl');
  const logger = typeof options.logger === 'function'
    ? options.logger
    : (...args) => console.error(...args);
  const hubName = String(options.name || path.basename(os.hostname()) || 'hub').toLowerCase();

  /** @type {Array<{seq:number, from:string, from_session:string, to:string, to_session:string, text:string, thread:string, ts:number}>} */
  let messages = [];
  let seqCounter = 0;
  let messagesLoaded = false;
  /** @type {Map<string, number>} */
  const peers = new Map();
  /** @type {Set<{peer:string, since:number, timer:NodeJS.Timeout|null, finish:(msgs:any[], timedOut:boolean)=>void}>} */
  const waiters = new Set();
  /** @type {import('node:http').Server | null} */
  let currentServer = null;
  let running = false;
  let startedAt = Date.now();
  let boundPort = configuredPort;

  function log(line) {
    try {
      logger(line);
    } catch {
      /* 日志函数失败不影响服务 */
    }
  }

  // ---------- 消息存储 ----------
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
      log(`[hub] 日志轮转：${path.basename(backup)}`);
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
      log(`[hub] 写日志失败：${error.message}`);
    }
  }

  // ---------- 在线状态 ----------
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

  // ---------- 路由 ----------
  async function handleRequest(req, res) {
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
            port: boundPort,
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
          timer: /** @type {NodeJS.Timeout|null} */ (null),
          finish: (found, timedOut) => {
            if (settled) return;
            settled = true;
            if (waiter.timer) clearTimeout(waiter.timer);
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
          if (waiter.timer) clearTimeout(waiter.timer);
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
        log(`[hub] #${message.seq} ${from}${fromSession ? `/${fromSession}` : ''} -> ${to}${toSession ? `/${toSession}` : ''} (${text.length}B)`);
        return sendJson(res, 200, {
          ok: true,
          message: { ...message },
          latest: seqCounter,
          hub: { name: hubName, version: VERSION },
        });
      }

      return sendJson(res, 404, { ok: false, error: `未知接口：${req.method} ${pathname}` });
    } catch (error) {
      log(`[hub] 处理 ${req.method} ${pathname} 失败：${error?.message || error}`);
      if (!res.writableEnded) {
        sendJson(res, 500, { ok: false, error: String(error?.message || error) });
      }
      return undefined;
    } finally {
      const cost = Date.now() - started;
      if (cost > 2000) log(`[hub] 慢请求 ${req.method} ${pathname} ${cost}ms`);
    }
  }

  // ---------- 启停 ----------
  /** @type {Promise<any>|null} */
  let starting = null;
  /** @type {Promise<void>|null} */
  let stopping = null;

  function info() {
    return {
      host,
      port: boundPort,
      urls: lanUrls(boundPort),
      dataDir,
      messages: messages.length,
      latestSeq: seqCounter,
    };
  }

  function status() {
    return {
      running,
      host,
      port: boundPort,
      messages: messages.length,
      latestSeq: seqCounter,
    };
  }

  async function startInternal() {
    if (!token) {
      throw new RelayError('hub 缺少 token', {
        hint: '创建 hub 时必须提供 token；两台机器需要使用同一个 token。',
      });
    }
    if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65535) {
      throw new RelayError(`hub 端口不合法：${JSON.stringify(configuredPort)}`, {
        hint: '端口应为 0-65535 的整数，例如 8787。',
      });
    }

    ensureDir(dataDir);
    if (!messagesLoaded) {
      loadMessages();
      messagesLoaded = true;
    }
    startedAt = Date.now();

    const httpServer = http.createServer((req, res) => {
      handleRequest(req, res).catch((error) => {
        log(`[hub] 未处理的请求异常：${error?.stack || error}`);
        try {
          if (!res.writableEnded) sendJson(res, 500, { ok: false, error: String(error?.message || error) });
        } catch {
          /* 响应可能已销毁 */
        }
      });
    });

    httpServer.on('clientError', (error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      log(`[hub] clientError: ${error.message}`);
    });

    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          httpServer.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          httpServer.off('error', onError);
          resolve();
        };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        try {
          httpServer.listen(configuredPort, host);
        } catch (error) {
          httpServer.off('error', onError);
          httpServer.off('listening', onListening);
          reject(error);
        }
      });
    } catch (error) {
      // 监听失败：把半开状态的 server 收干净，再把原始错误抛给调用方（保留 err.code）
      await new Promise((resolve) => {
        try {
          httpServer.close(() => resolve());
        } catch {
          resolve();
        }
      });
      throw error;
    }

    const address = httpServer.address();
    boundPort = address && typeof address === 'object' ? address.port : configuredPort;
    currentServer = httpServer;
    running = true;
    httpServer.on('error', (error) => {
      log(`[hub] 监听错误：${error?.message || error}`);
    });
    return info();
  }

  async function start() {
    if (running && currentServer) return info();
    if (starting) return starting;
    starting = startInternal().finally(() => {
      starting = null;
    });
    return starting;
  }

  async function stop() {
    if (stopping) return stopping;
    const httpServer = currentServer;
    if (!httpServer) {
      running = false;
      return undefined;
    }
    stopping = (async () => {
      // 1) 先让所有长轮询 waiter 立刻返回（写回响应），避免关闭时挂住
      for (const waiter of [...waiters]) {
        try {
          waiter.finish([], true);
        } catch {
          /* 单个 waiter 失败不影响其它 */
        }
      }
      waiters.clear();
      running = false;
      currentServer = null;

      // 2) 关闭 server：优先断开空闲 keep-alive 连接，兜底 1s 强制断开
      await new Promise((resolve) => {
        let settled = false;
        let timer = null;
        const done = () => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve();
        };
        timer = setTimeout(() => {
          try {
            httpServer.closeAllConnections?.();
          } catch {
            /* 忽略 */
          }
          done();
        }, 1000);
        timer.unref?.();
        try {
          httpServer.closeIdleConnections?.();
          httpServer.close(() => done());
        } catch {
          done();
        }
      });
    })().finally(() => {
      stopping = null;
    });
    return stopping;
  }

  return {
    start,
    stop,
    status,
    get server() {
      return currentServer;
    },
  };
}
