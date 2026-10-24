/**
 * dsh-lan-relay-push —— 核心逻辑（不依赖 DSH 内部包，便于单元测试）
 *
 * 职责：
 *   1. 长轮询局域网 hub，收到发给自己的消息后，投递到指定 session 并唤醒该会话的 agent
 *   2. 注册 Agent 工具：lan_relay_send / lan_relay_sessions / lan_relay_status
 *
 * 配置读取 ~/.dsh/lan-relay/config.json（与 MCP server / CLI 共用）：
 *   relay_url, token, self, state_dir
 *   push: { enabled, default_session, wake, poll_timeout_seconds }
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const CONFIG_DIR = path.join(os.homedir(), '.dsh', 'lan-relay');
export const DEFAULT_CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
export const VERSION = '0.1.0';

export function loadRelayConfig(configPath = process.env.LAN_RELAY_CONFIG || DEFAULT_CONFIG_PATH) {
  let file = {};
  try {
    const text = fs.readFileSync(configPath, 'utf8').trim();
    if (text) file = JSON.parse(text);
  } catch {
    file = {};
  }
  const relayUrl = String(process.env.LAN_RELAY_URL || file.relay_url || '').trim().replace(/\/+$/, '');
  const token = String(process.env.LAN_RELAY_TOKEN || file.token || '').trim();
  const self = String(file.self || os.hostname()).trim().toLowerCase();
  const stateDir = String(file.state_dir || path.join(CONFIG_DIR, 'state'));
  const push = file.push && typeof file.push === 'object' ? file.push : {};
  return {
    configPath,
    relayUrl,
    token,
    self,
    stateDir,
    push: {
      enabled: push.enabled !== false,
      default_session: typeof push.default_session === 'string' ? push.default_session : '',
      wake: push.wake !== false,
      poll_timeout_seconds: Number(push.poll_timeout_seconds) > 0 ? Number(push.poll_timeout_seconds) : 25,
      // 目标 to_session 不在线时是否兜底改投其它会话（默认 false：不投递，只记日志）
      offline_fallback: push.offline_fallback === true,
      // 没有 to_session 的消息是否直接拒收（默认 false：按默认会话投递并打标记）
      require_session: push.require_session === true,
      // 目标会话不在线时：'prompt' = 用 sessionController.prompt 冷启动投递（自动 resume）；'drop' = 放弃
      cold_session: push.cold_session === 'drop' ? 'drop' : 'prompt',
    },
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RelayError extends Error {
  constructor(message, hint = '') {
    super(message);
    this.name = 'RelayError';
    this.hint = hint;
  }
  toString() {
    return this.hint ? `${this.message}\n提示：${this.hint}` : this.message;
  }
}

const NETWORK_HINT = '检查 hub 是否在运行（node hub.mjs）、relay_url 是否正确、两台机器是否同网段、防火墙是否放行端口';

export class RelayHttp {
  constructor(config) {
    this.url = String(config.relayUrl || '').replace(/\/+$/, '');
    this.token = config.token || '';
    this.self = config.self || '';
  }

  assertReady() {
    if (!this.url || !this.token || !this.self) {
      throw new RelayError('LAN relay 未配置', '请先在 ~/.dsh/lan-relay/config.json 填 relay_url / token / self（或运行 scripts/setup.ps1）');
    }
  }

  headers() {
    return {
      'content-type': 'application/json',
      'x-relay-token': this.token,
      'x-relay-peer': this.self,
    };
  }

  async request(pathname, { method = 'GET', query, body, timeoutMs = 15000, signal } = {}) {
    this.assertReady();
    const url = new URL(this.url + pathname);
    for (const [key, value] of Object.entries(query || {})) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted && signal?.aborted) {
        throw new RelayError('请求已取消');
      }
      throw new RelayError(
        error?.name === 'AbortError' ? `请求超时：${url.origin}${url.pathname}` : `连不上中继 ${url.origin}（${error?.message || '网络错误'}）`,
        NETWORK_HINT,
      );
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (response.status === 401) {
      throw new RelayError('中继拒绝访问：token 不匹配', '两台机器必须使用同一个 token');
    }
    if (!response.ok) {
      throw new RelayError(`中继返回 ${response.status}：${payload?.error || response.statusText}`);
    }
    return payload || {};
  }

  async send({ to, text, toSession = '', fromSession = '', thread = '' }) {
    return this.request('/api/send', {
      method: 'POST',
      body: {
        from: this.self,
        from_session: fromSession,
        to,
        to_session: toSession,
        text,
        thread,
      },
    });
  }

  async wait({ since = 0, timeoutSeconds = 25, signal } = {}) {
    return this.request('/api/wait', {
      query: { peer: this.self, since, timeout: Math.min(120, Math.max(1, timeoutSeconds)) },
      timeoutMs: (Math.min(120, Math.max(1, timeoutSeconds)) + 15) * 1000,
      signal,
    });
  }

  async health() {
    return this.request('/api/health');
  }

  async peers() {
    return this.request('/api/peers');
  }
}

/**
 * 插件独立游标：避免与 MCP 的 relay_inbox/relay_wait 共用同一个游标文件
 * （共用时手动拉取会把消息"抢走"，插件就再也不会投递了）。
 * 文件名故意用 push- 前缀，与 MCP 的 <self>.cursor.json 区分。
 */
export function cursorPath(stateDir, self) {
  return path.join(stateDir, `push-${self}.json`);
}

export function readCursorState(stateDir, self) {
  try {
    const raw = JSON.parse(fs.readFileSync(cursorPath(stateDir, self), 'utf8'));
    if (Number.isInteger(raw.cursor) && raw.cursor >= 0) return { found: true, cursor: raw.cursor };
    return { found: true, cursor: 0 };
  } catch {
    return { found: false, cursor: 0 };
  }
}

export function readCursor(stateDir, self) {
  return readCursorState(stateDir, self).cursor;
}

export function writeCursor(stateDir, self, cursor) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      cursorPath(stateDir, self),
      JSON.stringify({ cursor, updated_at: Date.now() }, null, 2),
    );
  } catch {
    /* 游标写失败不阻塞通信 */
  }
}

/** 从 agent 上尽力取 session id / 标题 / 工作目录（不同版本字段名有差异） */
export function describeAgent(agent) {
  const header = agent?.session?.header || {};
  const id = header.id || agent?.session?.id || agent?.id || '';
  return {
    id: String(id || ''),
    title: String(header.title || ''),
    cwd: String(header.cwd || ''),
    status: String(agent?.status || ''),
    updatedAt: Number(header.updatedAt || header.createdAt || 0),
  };
}

/** 把收到的 hub 消息格式化成模型可见的 user 文本 */
export function formatIncoming(message, config) {
  const lines = [];
  const from = message.from || 'unknown';
  const seq = message.seq ?? '?';
  const when = message.ts ? new Date(message.ts).toISOString() : '';
  lines.push(`[LAN relay] 收到来自 peer="${from}" 的消息（seq=${seq}${message.from_session ? `，会话 ${message.from_session}` : ''}${when ? `，${when}` : ''}${message.thread ? `，thread=${message.thread}` : ''}）`);
  lines.push('');
  lines.push(String(message.text ?? ''));
  lines.push('');
  if (message.from_session) {
    lines.push(`回复：调用 lan_relay_send(to="${from}", to_session="${message.from_session}", text="...")；对方是另一台机器上的 DSH Agent，写清背景与期望。`);
  } else {
    lines.push(`回复：调用 lan_relay_send(to="${from}", text="...")。`);
  }
  if (config?.self) lines.push(`（本机 peer=${config.self}）`);
  return lines.join('\n');
}

/** 选择一个"默认会话"：配置优先，否则最近活跃的会话 */
export function pickDefaultAgent(agents) {
  const list = agents.filter((a) => {
    const status = String(a?.status || '');
    return status !== 'stopped' && status !== 'dead';
  });
  if (!list.length) return null;
  const scored = list.map((agent) => ({ agent, info: describeAgent(agent) }));
  scored.sort((a, b) => b.info.updatedAt - a.info.updatedAt);
  return scored[0].agent;
}

/**
 * 根据消息决定投递目标。返回 { agent, target, note }：
 *   - agent 非空：直接投递给在线 agent（note 非空时正文加 [注意] 前缀）
 *   - agent 为空 + cold=true：目标会话不在线，可走冷启动投递（sessionController.prompt）
 *   - agent 为空 + cold=false：按策略丢弃
 */
export function selectTarget(agents, message, config) {
  const push = config?.push || {};
  const wanted = String(message.to_session || '').trim();

  if (wanted) {
    const hit = agents.find((a) => describeAgent(a).id === wanted);
    if (hit) return { agent: hit, target: wanted, note: '' };
    return { agent: null, target: wanted, cold: true, note: `目标会话 ${wanted} 不在线` };
  }

  if (push.require_session === true) {
    return { agent: null, target: '', cold: false, note: '消息未指定 to_session，按 require_session 策略拒收' };
  }

  const defaultId = String(push.default_session || '').trim();
  if (defaultId) {
    const hit = agents.find((a) => describeAgent(a).id === defaultId);
    if (hit) {
      return { agent: hit, target: defaultId, note: '发送方未指定 to_session，已按默认会话投递' };
    }
    return { agent: null, target: defaultId, cold: true, note: `默认会话 ${defaultId} 未打开` };
  }
  const fallback = pickDefaultAgent(agents);
  if (!fallback) return { agent: null, target: '', cold: false, note: '本机没有活跃会话' };
  return { agent: fallback, target: '', cold: false, note: '发送方未指定 to_session，已投递到最近活跃会话' };
}

/** 兼容 ctx.logger(name) 与 ctx.logger.info() 两种形态，失败时退回 console.error */
export function makeLogger(ctx) {
  let sink = null;
  try {
    if (typeof ctx?.logger === 'function') {
      const logger = ctx.logger('lan-relay-push');
      if (logger) {
        sink = (msg, level = 'info') => {
          try {
            const fn = logger[level] || logger.info;
            if (typeof fn === 'function') fn.call(logger, msg);
          } catch {
            /* ignore */
          }
        };
      }
    } else if (ctx?.logger && typeof ctx.logger.info === 'function') {
      sink = (msg) => {
        try {
          ctx.logger.info(`[lan-relay-push] ${msg}`);
        } catch {
          /* ignore */
        }
      };
    }
  } catch {
    sink = null;
  }
  return (msg, level = 'info') => {
    if (sink) {
      sink(msg, level);
      return;
    }
    try {
      console.error(`[lan-relay-push] ${msg}`);
    } catch {
      /* 隐藏窗口下 stderr 可能不可写 */
    }
  };
}

/** 把 spec 包成 registry 接受的原始工具定义（与 MCP 工具同一形态，零外部依赖） */
function rawTool(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      // 宽松对象 schema：执行期返回任意 JSON 对象
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      if (typeof exec?.signal?.throwIfAborted === 'function') exec.signal.throwIfAborted();
      return spec.execute(args || {}, exec);
    },
  };
}

/**
 * 运行时：在 DSH 进程内注册工具并开始长轮询。
 * @param {{ctx: any, defineTool: Function, log?: Function, config?: any, toolsService?: any}} options
 */
export class RelayRuntime {
  constructor({ ctx, defineTool, log, config, toolsService }) {
    this.ctx = ctx;
    this.defineTool = defineTool;
    this.log = log || makeLogger(ctx);
    this.tools = toolsService || null;
    this.config = config || loadRelayConfig();
    this.http = new RelayHttp(this.config);
    // 独立游标：找不到游标文件时先置 null，由 loop 首次轮询时初始化为 hub 最新值（跳过历史，避免重放）
    const cursorState = readCursorState(this.config.stateDir, this.config.self);
    this.cursor = cursorState.found ? cursorState.cursor : null;
    this.stopped = false;
    this.stats = { started_at: Date.now(), delivered: 0, cold: 0, skipped: 0, failed: 0, last_error: '' };
    this.debug(
      `apply: self=${this.config.self} hub=${this.config.relayUrl} toolsService=${this.tools ? 'yes' : 'no'}`
      + ` offline_fallback=${this.config.push.offline_fallback} require_session=${this.config.push.require_session}`
      + ` cursor=${this.cursor === null ? '(init-on-start)' : this.cursor}`,
    );
  }

  /** 落盘调试日志：~/.dsh/lan-relay/state/push-debug.log（宿主在 dsh web 下没有日志 sink） */
  debug(msg) {
    try {
      fs.mkdirSync(this.config.stateDir, { recursive: true });
      fs.appendFileSync(
        path.join(this.config.stateDir, 'push-debug.log'),
        `${new Date().toISOString()} ${msg}\n`,
      );
    } catch {
      /* ignore */
    }
  }

  /** 当前活跃 agents（失败时返回空数组，绝不抛错） */
  liveAgents() {
    try {
      const list = this.ctx?.agents?.list?.();
      return Array.isArray(list) ? list : [];
    } catch (error) {
      this.log(`枚举会话失败：${error?.message || error}`);
      return [];
    }
  }

  sessionIdOf(agent) {
    return describeAgent(agent).id || '';
  }

  installTools(toolsService) {
    if (toolsService) this.tools = toolsService;
    const register = this.tools?.register;
    this.debug(`installTools: service=${this.tools ? 'yes' : 'no'} register=${typeof register}`);
    if (typeof register !== 'function') {
      this.log('tools 服务不可用，跳过工具注册', 'warn');
      return false;
    }
    const runtime = this;
    const regOne = (spec) => {
      try {
        register.call(this.tools, rawTool(spec));
        this.debug(`registered tool ${spec.name}`);
        return true;
      } catch (error) {
        this.debug(`register tool ${spec.name} FAILED: ${error?.stack || error}`);
        return false;
      }
    };

    let ok = 0;
    if (regOne({
      name: 'lan_relay_send',
      description:
        '给局域网内另一台机器上的 DSH Agent 发消息，可指定对方会话（to_session）以实现精确投递并唤醒该会话。'
        + '不填 to_session 时由对方 relay 插件投递到它配置的默认会话。',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '对方 peer 名（小写字母/数字/._-），或 "*" 广播' },
          text: { type: 'string', description: '消息正文；对方是另一个 Agent，写清背景、要什么、期望回复格式' },
          to_session: { type: 'string', description: '可选：对方会话 id（如 session-a37a161f-...）' },
          thread: { type: 'string', description: '可选：话题标签' },
        },
        required: ['to', 'text'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const fromSession = runtime.sessionIdOf(exec?.agent);
        const result = await runtime.http.send({
          to: args.to,
          text: args.text,
          toSession: args.to_session || '',
          fromSession,
          thread: args.thread || '',
        });
        return {
          ok: true,
          seq: result.message?.seq,
          from: runtime.config.self,
          from_session: fromSession,
          to: result.message?.to,
          to_session: result.message?.to_session || '',
          sent_at: result.message?.ts ? new Date(result.message.ts).toISOString() : '',
        };
      },
    })) ok += 1;

    if (regOne({
      name: 'lan_relay_sessions',
      description: '列出本机当前活跃的 DSH 会话（id / 标题 / 状态 / 工作目录），用于指定 to_session 投递或回复。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        const sessions = runtime.liveAgents().map((agent) => describeAgent(agent));
        return {
          self: runtime.config.self,
          default_session: runtime.config.push.default_session || '',
          sessions,
        };
      },
    })) ok += 1;

    if (regOne({
      name: 'lan_relay_status',
      description: '查看本机 relay 插件状态：peer、hub 连通性、游标、默认会话、最近投递统计。收不到消息时先调它。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        const status = {
          self: runtime.config.self,
          relay_url: runtime.config.relayUrl,
          default_session: runtime.config.push.default_session || '',
          policy: {
            offline_fallback: runtime.config.push.offline_fallback,
            require_session: runtime.config.push.require_session,
            cold_session: runtime.config.push.cold_session,
            wake: runtime.config.push.wake,
          },
          cursor: runtime.cursor,
          reachable: false,
          hub: null,
          peers: [],
          agents: runtime.liveAgents().map((agent) => describeAgent(agent)),
          stats: runtime.stats,
          error: '',
        };
        try {
          const health = await runtime.http.health();
          const peers = await runtime.http.peers();
          status.reachable = true;
          status.hub = health.hub || null;
          status.latest = health.latest;
          status.peers = peers.peers || [];
        } catch (error) {
          status.error = String(error?.message || error);
          status.hint = error?.hint || '';
        }
        return status;
      },
    })) ok += 1;

    try {
      const schemas = typeof this.tools.schemas === 'function' ? this.tools.schemas() : null;
      if (Array.isArray(schemas)) {
        const mine = schemas
          .map((schema) => schema?.name)
          .filter((toolName) => typeof toolName === 'string' && toolName.startsWith('lan_relay_'));
        this.debug(`visible schemas=${schemas.length} mine=[${mine.join(',')}]`);
      }
    } catch (error) {
      this.debug(`schemas() failed: ${error?.message || error}`);
    }

    this.log(`已注册工具 ${ok}/3（lan_relay_send / lan_relay_sessions / lan_relay_status）`);
    if (ok === 3) this.toolsRegistered = true;
    return ok === 3;
  }

  async dispatch(message) {
    const agents = this.liveAgents();
    const { agent, target, note, cold } = selectTarget(agents, message, this.config);

    if (agent) {
      await this.deliverToAgent(agent, message, note);
      return;
    }

    // 目标会话不在线：优先冷启动投递（sessionController.prompt 会自动 resume 会话）
    if (cold && target && this.config.push.cold_session !== 'drop') {
      const delivered = await this.promptColdSession(target, message, note);
      if (delivered) return;
    }

    // 兜底：只有显式开启 offline_fallback 才改投其它活跃会话
    if (cold && this.config.push.offline_fallback === true) {
      const fallback = pickDefaultAgent(agents);
      if (fallback) {
        await this.deliverToAgent(fallback, message, `${note || '目标会话未打开'}；已按 offline_fallback 改投`);
        return;
      }
    }

    this.stats.skipped += 1;
    this.stats.last_error = note || '无可投递会话';
    this.debug(`skip seq=${message.seq}: ${note}`);
    this.log(`跳过 seq=${message.seq}：${note}`);
  }

  /** 投递给在线 agent（followup 唤醒 / inject 只加背景） */
  async deliverToAgent(agent, message, note) {
    const info = describeAgent(agent);
    let text = formatIncoming(message, this.config);
    if (note) text = `[注意] ${note}\n\n${text}`;

    const body = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      // 会话格式 V4 要求每条 user 消息带 producer-owned source；
      // kind:'plugin' 会被拒绝，'user' 最稳妥（IM 插件也用它做 steering）。
      source: { kind: 'user' },
    };
    try {
      if (this.config.push.wake === false && typeof agent.inject === 'function') {
        await agent.inject(body);
      } else if (typeof agent.followup === 'function') {
        await agent.followup(body);
      } else if (typeof agent.steer === 'function') {
        await agent.steer(body);
      } else if (typeof agent.inject === 'function') {
        await agent.inject(body);
      } else {
        throw new Error('agent 没有 followup/steer/inject 方法');
      }
      this.stats.delivered += 1;
      this.debug(`delivered seq=${message.seq} -> ${info.id || '?'}${note ? ` (${note})` : ''}`);
      this.log(`已投递 seq=${message.seq} → 会话 ${info.id || '(未知)'}（${note || '精确匹配'}）`);
    } catch (error) {
      this.stats.failed += 1;
      this.stats.last_error = String(error?.message || error);
      this.debug(`deliver seq=${message.seq} FAILED: ${this.stats.last_error}`);
      this.log(`投递 seq=${message.seq} 失败：${this.stats.last_error}`);
    }
  }

  /**
   * 冷会话投递：调用 Host 的 sessionController.prompt()。
   * 它会自动 resume 一个没打开的会话、把消息排进队并唤醒 agent。
   * 这是“本机一次只能打开一个会话”时的关键路径（否则目标会话永远不在线）。
   */
  async promptColdSession(sessionId, message, note) {
    let controller = null;
    try {
      controller = (typeof this.ctx?.get === 'function' ? this.ctx.get('sessionController') : null) ?? null;
    } catch (error) {
      this.debug(`get('sessionController') failed: ${error?.message || error}`);
      controller = null;
    }
    if (!controller || typeof controller.prompt !== 'function') {
      this.debug('cold delivery unavailable: sessionController.prompt missing');
      this.log('冷启动投递不可用：缺少 sessionController.prompt 服务', 'warn');
      return false;
    }

    const requestId = randomUUID();
    let text = formatIncoming(message, this.config);
    if (note) text = `[注意] ${note}（已冷启动投递）\n\n${text}`;
    try {
      const signal = typeof AbortSignal?.timeout === 'function'
        ? AbortSignal.timeout(60000)
        : new AbortController().signal;
      await controller.prompt(
        { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] },
        signal,
      );
      this.stats.delivered += 1;
      this.stats.cold = (this.stats.cold || 0) + 1;
      this.debug(`cold delivered seq=${message.seq} -> ${sessionId}`);
      this.log(`已冷启动投递 seq=${message.seq} → 会话 ${sessionId}`);
      return true;
    } catch (error) {
      this.stats.failed += 1;
      this.stats.last_error = String(error?.message || error);
      this.debug(`cold deliver seq=${message.seq} -> ${sessionId} FAILED: ${this.stats.last_error}`);
      this.log(`冷启动投递失败 seq=${message.seq} → ${sessionId}：${this.stats.last_error}`);
      return false;
    }
  }

  /** 开始长轮询；用 ctx.effect 注册清理，插件卸载时自动停止 */
  start() {
    if (!this.config.push.enabled) {
      this.log('push.enabled=false，不启动长轮询');
      return;
    }
    if (!this.config.relayUrl || !this.config.token) {
      this.log('relay 未配置，不启动长轮询（补齐 ~/.dsh/lan-relay/config.json 后重启 DSH）');
      return;
    }
    const timeoutSeconds = this.config.push.poll_timeout_seconds;
    const ctx = this.ctx;
    let retryTimer = null;
    const dispose = () => {
      this.stopped = true;
      this.controller?.abort();
      if (retryTimer) clearInterval(retryTimer);
    };
    if (typeof ctx?.effect === 'function') {
      ctx.effect(() => {
        this.controller = new AbortController();
        this.loop(timeoutSeconds).catch((error) => this.log(`长轮询退出：${error?.message || error}`));
        return dispose;
      });
    } else {
      this.controller = new AbortController();
      this.loop(timeoutSeconds).catch((error) => this.log(`长轮询退出：${error?.message || error}`));
    }
    this.log(`长轮询已启动：peer=${this.config.self} hub=${this.config.relayUrl}`);

    // 工具服务若晚于本插件就绪，自动重试注册（不影响唤醒）
    if (!this.toolsRegistered) {
      retryTimer = setInterval(() => {
        if (this.toolsRegistered || this.stopped) {
          clearInterval(retryTimer);
          return;
        }
        try {
          const service = typeof ctx?.get === 'function' ? ctx.get('tools') : null;
          this.debug(`tools retry: ${service ? 'found' : 'still unavailable'}`);
          if (service) this.installTools(service);
        } catch (error) {
          this.debug(`tools retry failed: ${error?.message || error}`);
        }
      }, 20000);
      retryTimer.unref?.();
    }
  }

  async loop(timeoutSeconds) {
    // 首次启动没有游标文件：从 hub 最新位置开始，避免把所有历史消息重放一遍
    if (this.cursor === null) {
      try {
        const health = await this.http.health();
        this.cursor = Number.isInteger(health?.latest) ? health.latest : 0;
        writeCursor(this.config.stateDir, this.config.self, this.cursor);
        this.debug(`cursor 初始化到 hub latest=${this.cursor}（跳过历史消息）`);
      } catch (error) {
        this.stats.last_error = String(error?.message || error);
        this.log(`游标初始化失败，3 秒后重试：${this.stats.last_error}`);
        await sleep(3000);
        return this.loop(timeoutSeconds);
      }
    }

    while (!this.stopped) {
      try {
        const result = await this.http.wait({
          since: this.cursor,
          timeoutSeconds,
          signal: this.controller?.signal,
        });
        const messages = Array.isArray(result.messages) ? result.messages : [];
        for (const message of messages) {
          this.cursor = Math.max(this.cursor, Number(message.seq) || 0);
          writeCursor(this.config.stateDir, this.config.self, this.cursor);
          await this.dispatch(message);
        }
      } catch (error) {
        if (this.stopped) break;
        this.stats.last_error = String(error?.message || error);
        this.log(`轮询失败：${this.stats.last_error}`);
        await sleep(3000);
      }
    }
  }
}

export function createRuntime(options) {
  return new RelayRuntime(options);
}
