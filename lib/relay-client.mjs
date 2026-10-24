/**
 * 中继客户端：HTTP 调用 hub + 本地游标持久化。
 * 零依赖，Node 18+（内置 fetch）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { RelayError, ensureDir } from './config.mjs';

const NETWORK_HINT =
  '检查顺序：① hub 机器上 relay-hub 是否在运行（node hub.mjs --config <配置>）'
  + ' ② 两台机器是否同一局域网、relay_url 里的 IP 是否正确'
  + ' ③ hub 机器的 Windows 防火墙是否放行该端口'
  + ' ④ 用浏览器打开 <relay_url>/api/health 看是否有响应';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RelayClient {
  /**
   * @param {{relayUrl:string, token:string, self:string, stateDir:string, requestTimeoutMs?:number}} config
   */
  constructor(config) {
    this.relayUrl = String(config.relayUrl || '').replace(/\/+$/, '');
    this.token = config.token || '';
    this.self = config.self || '';
    this.stateDir = config.stateDir;
    this.configPath = config.configPath || '';
    this.requestTimeoutMs = config.requestTimeoutMs || 15000;
    this._cursor = null;
  }

  assertConfigured() {
    const missing = [];
    if (!this.relayUrl) missing.push('relay_url');
    if (!this.token) missing.push('token');
    if (!this.self) missing.push('self');
    if (missing.length) {
      throw new RelayError(`LAN relay 未配置：缺少 ${missing.join('、')}`, {
        hint: `请先运行 scripts/setup.ps1，或在 ~/.dsh/lan-relay/config.json 填写 relay_url / token / self。`,
      });
    }
  }

  get cursorPath() {
    return path.join(this.stateDir, `${this.self}.cursor.json`);
  }

  get cursor() {
    if (this._cursor && Number.isInteger(this._cursor.cursor)) return this._cursor.cursor;
    let cursor = 0;
    try {
      const raw = JSON.parse(fs.readFileSync(this.cursorPath, 'utf8'));
      if (Number.isInteger(raw.cursor) && raw.cursor >= 0) cursor = raw.cursor;
    } catch {
      /* 首次使用没有游标文件 */
    }
    this._cursor = { cursor };
    return cursor;
  }

  set cursor(value) {
    const next = Math.max(0, Number(value) || 0);
    this._cursor = { cursor: next };
    try {
      ensureDir(this.stateDir);
      fs.writeFileSync(this.cursorPath, JSON.stringify({ cursor: next, updated_at: Date.now() }, null, 2));
    } catch {
      /* 游标只是便利功能，写失败不阻塞通信 */
    }
  }

  headers() {
    return {
      'content-type': 'application/json',
      'x-relay-token': this.token,
      'x-relay-peer': this.self,
    };
  }

  async request(pathname, { method = 'GET', query, body, timeoutMs } = {}) {
    this.assertConfigured();
    const url = new URL(this.relayUrl + pathname);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        url.searchParams.set(key, String(value));
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      timeoutMs || this.requestTimeoutMs,
    );
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new RelayError(
        error?.name === 'AbortError'
          ? `请求超时：${url.origin}${url.pathname}`
          : `连不上中继 ${url.origin}（${error?.cause?.code || error?.message || '网络错误'}）`,
        { hint: NETWORK_HINT, cause: error },
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401) {
      throw new RelayError('中继拒绝访问：token 不匹配', {
        hint: '两台机器必须使用同一个 token（hub 机器上的 ~/.dsh/lan-relay/config.json 与 token.txt）。',
        status: 401,
      });
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const detail = payload?.error || payload?.message || response.statusText;
      throw new RelayError(`中继返回 ${response.status}：${detail}`, { status: response.status });
    }
    return payload ?? {};
  }

  async health() {
    return this.request('/api/health');
  }

  async peers() {
    return this.request('/api/peers');
  }

  /**
   * 发送消息。to 可以是 peer 名，或 "*" 表示广播给所有其他 peer。
   * toSession 指定对方哪个会话收（不填则由对方插件投递到默认会话）。
   */
  async send({ to, text, thread = '', toSession = '', fromSession = '' }) {
    const content = String(text ?? '');
    if (!content.trim()) throw new RelayError('消息内容为空');
    if (content.length > 32000) throw new RelayError(`消息过长（${content.length} 字符，上限 32000）`);
    const target = String(to || '').trim().toLowerCase();
    if (!target) throw new RelayError('缺少收件人 to（peer 名，或 "*" 广播）');
    if (target !== '*' && !/^[a-z0-9._-]{1,32}$/.test(target)) {
      throw new RelayError(`收件人名字不合法：${to}`);
    }
    return this.request('/api/send', {
      method: 'POST',
      body: {
        from: this.self,
        from_session: String(fromSession || '').trim(),
        to: target,
        to_session: String(toSession || '').trim(),
        text: content,
        thread: thread ? String(thread).slice(0, 64) : '',
      },
    });
  }

  async _fetchInbox({ since, limit }) {
    return this.request('/api/inbox', {
      query: { peer: this.self, since, limit },
    });
  }

  /**
   * 拉取新消息。默认推进游标（mark_read=true），因此同一条消息只会返回一次。
   */
  async inbox({ limit = 20, fromSeq = null, markRead = true } = {}) {
    const explicit = Number.isInteger(fromSeq) && fromSeq >= 0;
    let since = explicit ? fromSeq : this.cursor;

    let data = await this._fetchInbox({ since, limit });
    // hub 数据被清空/重建时，本地游标可能超前：自动归零重拉一次
    let cursorReset = false;
    if (Number.isInteger(data.latest) && data.latest < since) {
      since = 0;
      cursorReset = true;
      data = await this._fetchInbox({ since, limit });
    }

    const messages = Array.isArray(data.messages) ? data.messages : [];
    const newest = messages.reduce((max, m) => Math.max(max, m.seq || 0), since);
    if (markRead) this.cursor = Math.max(this.cursor, newest);

    return {
      self: this.self,
      messages,
      count: messages.length,
      cursor: markRead ? this.cursor : since,
      latest: data.latest ?? newest,
      has_more: Number.isInteger(data.latest) ? data.latest > newest : false,
      cursor_reset: cursorReset,
      hub: data.hub || null,
    };
  }

  /**
   * 长轮询等待新消息。超时返回空数组，不会抛错。
   * timeout 上限 50 秒：DSH MCP 工具调用默认 60 秒超时。
   */
  async wait({ timeoutSeconds = 25, afterSeq = null } = {}) {
    const timeout = Math.min(50, Math.max(1, Number(timeoutSeconds) || 25));
    const since = Number.isInteger(afterSeq) && afterSeq >= 0 ? afterSeq : this.cursor;
    const data = await this.request('/api/wait', {
      query: { peer: this.self, since, timeout },
      timeoutMs: (timeout + 15) * 1000,
    });
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const newest = messages.reduce((max, m) => Math.max(max, m.seq || 0), since);
    if (messages.length) this.cursor = Math.max(this.cursor, newest);
    return {
      self: this.self,
      messages,
      count: messages.length,
      timed_out: Boolean(data.timed_out) && messages.length === 0,
      waited_seconds: timeout,
      cursor: this.cursor,
      latest: data.latest ?? newest,
      hub: data.hub || null,
    };
  }

  async status() {
    const info = {
      self: this.self,
      relay_url: this.relayUrl,
      config_path: this.configPath,
      state_dir: this.stateDir,
      cursor: this.cursor,
      reachable: false,
      hub: null,
      peers: [],
      error: '',
    };
    try {
      const health = await this.health();
      const peers = await this.peers();
      info.reachable = true;
      info.hub = health.hub || null;
      info.latest = health.latest;
      info.peers = (peers.peers || []).map((p) => ({
        name: p.name,
        online: p.online,
        last_seen_seconds: p.last_seen_seconds,
      }));
    } catch (error) {
      info.error = String(error?.message || error);
      info.hint = error?.hint || NETWORK_HINT;
    }
    return info;
  }
}

export { sleep };
