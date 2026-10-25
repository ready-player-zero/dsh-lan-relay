/**
 * dsh-lan-relay —— 标准 DSH 插件（Host 半）
 *
 * 一个包解决全部事情，装完即可用，不需要再跑 hub 进程 / 配 MCP 连接器 / 加计划任务：
 *   1. 角色开关（设置 → 局域网中继）：server = 在 DSH 进程内起 hub 并自动生成 token；
 *      client = 粘贴加入码连接另一台机器的 hub；off = 停用（工具仍在，调用时提示未启用）。
 *   2. 注册原生 Agent 工具：lan_relay_send / lan_relay_inbox / lan_relay_wait /
 *      lan_relay_peers / lan_relay_status / lan_relay_sessions（不再需要 MCP 连接器）。
 *   3. 后台长轮询 hub，把消息投递到会话并唤醒 agent（复用 lib/core.mjs，与旧 push 插件同一套逻辑）。
 *   4. 随 DSH 启动/退出：hub 与轮询都在 Host 进程生命周期内，无需额外自启项。
 *   5. 给设置页提供同源管理 API（/lan-relay/api/*，仅回环地址可访问）。
 *
 * 配置文件仍是 `~/.dsh/lan-relay/config.json`（与旧 hub/MCP/CLI 完全兼容），
 * 只是多了 `role` 字段；旧链路可以继续读同一份文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createHub } from './lib/hub-server.mjs';
import { encodeJoinCode, decodeJoinCode } from './lib/join-code.mjs';
import { createRuntime, makeLogger, describeAgent } from './lib/core.mjs';
import { RelayClient } from './lib/relay-client.mjs';
import { RelayError } from './lib/config.mjs';
import {
  CONFIG_DIR,
  DEFAULT_CONFIG_PATH,
  DEFAULT_PORT,
  ROLES,
  ConfigError,
  readRawConfig,
  normalizeConfig,
  saveConfig,
  regenerateToken,
  advertiseUrl,
  hubUrls,
} from './lib/plugin-config.mjs';

const VERSION = '1.0.0';
const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROUTE_PREFIX = '/lan-relay';
const MAX_BODY_BYTES = 64 * 1024;
const PROBE_INTERVAL_MS = 5000;

export const name = 'dsh-lan-relay';
/** 服务全部按需注入（工具/agents/webServer 缺失时插件仍能加载，不阻塞 DSH 启动）。 */
export const inject = [];

function safeFileLog(prefix, message) {
  try {
    // 测试/多实例时用 LAN_RELAY_CONFIG 的目录，避免污染真实状态目录
    const base = process.env.LAN_RELAY_CONFIG ? path.dirname(process.env.LAN_RELAY_CONFIG) : CONFIG_DIR;
    const dir = path.join(base, 'state');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'plugin.log'), `${new Date().toISOString()} [${prefix}] ${message}\n`);
  } catch {
    /* 日志失败不影响主流程 */
  }
}

class LanRelayPlugin {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = makeLogger(ctx);
    this.configPath = process.env.LAN_RELAY_CONFIG || DEFAULT_CONFIG_PATH;
    this.config = null;
    this.hub = null;
    this.hubError = '';
    this.hubInfo = null;
    this.wake = null;
    this.wakeDispose = null;
    this.client = { relayUrl: '', reachable: false, error: '', hint: '', peers: [], checkedAt: 0 };
    this.startedAt = Date.now();
    this.disposed = false;
    this.reloading = null;
    this.lastError = '';
    this.toolDisposers = [];
    this.toolNames = [];
    this.probeTimer = null;
  }

  debug(message) {
    this.log(`[debug] ${message}`, 'debug');
    safeFileLog('debug', message);
  }

  /** 插件加载：注册管理 API、注册工具、应用配置。任何一步失败都不抛给宿主。 */
  init() {
    try {
      this.installAdminRoutes();
    } catch (error) {
      this.lastError = `管理 API 注册失败：${error?.message || error}`;
      safeFileLog('error', this.lastError);
    }
    try {
      this.installTools();
    } catch (error) {
      this.lastError = `工具注册失败：${error?.message || error}`;
      safeFileLog('error', this.lastError);
    }
    this.reload('startup').catch((error) => {
      this.lastError = `初始化失败：${error?.message || error}`;
      safeFileLog('error', this.lastError);
    });
    this.probeTimer = setInterval(() => {
      this.probe().catch(() => {});
    }, PROBE_INTERVAL_MS);
    this.probeTimer.unref?.();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = null;
    this.stopWake();
    this.stopHub();
    for (const dispose of this.toolDisposers.splice(0)) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
    this.log('插件已卸载：hub 与轮询已停止');
  }

  // ------------------------------------------------------------------ 配置/生命周期

  readConfigOrPrev() {
    let raw = {};
    try {
      raw = readRawConfig(this.configPath);
    } catch (error) {
      this.lastError = error?.message || String(error);
      this.log(this.lastError, 'warn');
      raw = {};
    }
    try {
      return normalizeConfig(raw, this.configPath);
    } catch (error) {
      this.lastError = error?.message || String(error);
      this.log(`配置无效，退回未配置状态：${this.lastError}`, 'warn');
      return normalizeConfig({ role: 'off' }, this.configPath);
    }
  }

  /** 应用配置：server 起 hub，client/server 起唤醒轮询；停用则全部停掉。 */
  async reload(reason = 'manual') {
    if (this.disposed) return this.config;
    if (this.reloading) await this.reloading.catch(() => {});
    this.reloading = (async () => {
      this.stopWake();
      this.stopHub();

      let raw = {};
      try {
        raw = readRawConfig(this.configPath);
      } catch (error) {
        this.lastError = error?.message || String(error);
      }
      let runtime;
      try {
        runtime = normalizeConfig(raw, this.configPath);
      } catch (error) {
        this.lastError = error?.message || String(error);
        runtime = normalizeConfig({ role: 'off' }, this.configPath);
      }
      this.config = runtime;

      // 服务端首次启用：token 必须落盘（加入码/客户端要用同一个值）
      if (runtime.role === 'server' && !String(raw.token || '').trim()) {
        try {
          saveConfig({ role: 'server', token: runtime.token }, this.configPath);
          runtime = normalizeConfig(readRawConfig(this.configPath), this.configPath);
          this.config = runtime;
          this.log('已自动生成 token（服务端首次启用）');
        } catch (error) {
          this.lastError = `token 落盘失败：${error?.message || error}`;
          safeFileLog('error', this.lastError);
        }
      }

      this.hubError = '';
      if (runtime.role === 'server') {
        const hub = createHub({
          host: runtime.hub.host || '0.0.0.0',
          port: runtime.hub.port,
          token: runtime.token,
          dataDir: runtime.hub.dataDir,
          logger: (line) => this.debug(String(line)),
        });
        try {
          this.hubInfo = await hub.start();
          this.hub = hub;
          this.log(`hub 已启动：${runtime.hub.host}:${runtime.hub.port}（${(this.hubInfo?.urls || []).join(' ') || '无局域网地址'}）`);
        } catch (error) {
          this.hub = null;
          this.hubInfo = null;
          this.hubError = this.describeHubError(error, runtime);
          this.log(this.hubError, 'warn');
          safeFileLog('error', this.hubError);
        }
      }

      if (runtime.role !== 'off' && runtime.relayUrl && runtime.token) {
        try {
          this.wake = createRuntime({ ctx: this.ctx, log: this.log, config: this.wakeConfig(runtime) });
          this.wakeDispose = this.wake.start();
          if (typeof this.wakeDispose === 'function') this.log(`消息自动唤醒已启动（peer=${runtime.self}）`);
        } catch (error) {
          this.wake = null;
          this.wakeDispose = null;
          this.lastError = `唤醒轮询启动失败：${error?.message || error}`;
          safeFileLog('error', this.lastError);
        }
      }

      this.log(`配置已应用（${reason}）：role=${runtime.role} self=${runtime.self} relay=${runtime.relayUrl || '(无)'}`);
      await this.probe(true);
      return this.config;
    })();
    try {
      return await this.reloading;
    } finally {
      this.reloading = null;
    }
  }

  /** lib/core.mjs 期望的配置形态（与旧 push 插件一致）。 */
  wakeConfig(runtime) {
    return {
      configPath: runtime.configPath,
      relayUrl: runtime.relayUrl,
      token: runtime.token,
      self: runtime.self,
      stateDir: runtime.stateDir,
      requestTimeoutMs: runtime.requestTimeoutMs,
      push: runtime.push,
    };
  }

  describeHubError(error, runtime) {
    const code = error?.code || '';
    if (code === 'EADDRINUSE') {
      return `端口 ${runtime.hub.port} 已被占用：可能已有一个 hub（旧 hub.mjs 或另一个 DSH 实例）在运行。`
        + '如果那是你要用的 hub，请把本机切到「客户端」角色并填它的加入码；否则换一个端口。';
    }
    if (code === 'EACCES') return `没有权限监听端口 ${runtime.hub.port}（换一个 >1024 的端口试试）。`;
    return `hub 启动失败：${error?.message || error}`;
  }

  stopHub() {
    const hub = this.hub;
    this.hub = null;
    this.hubInfo = null;
    if (!hub) return;
    try {
      Promise.resolve(hub.stop()).catch((error) => this.debug(`hub 停止失败：${error?.message || error}`));
    } catch (error) {
      this.debug(`hub 停止失败：${error?.message || error}`);
    }
  }

  stopWake() {
    const dispose = this.wakeDispose;
    this.wakeDispose = null;
    this.wake = null;
    if (typeof dispose === 'function') {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
  }

  // ------------------------------------------------------------------ 探测 hub 连通性

  async probe(force = false) {
    const now = Date.now();
    if (!force && now - this.client.checkedAt < PROBE_INTERVAL_MS - 500) return this.client;
    const runtime = this.config;
    if (!runtime || runtime.role === 'off' || !runtime.relayUrl || !runtime.token) {
      this.client = {
        relayUrl: runtime?.relayUrl || '',
        reachable: false,
        error: runtime?.role === 'off' ? '未启用' : '未配置地址或 token',
        hint: '',
        peers: [],
        checkedAt: now,
      };
      return this.client;
    }
    try {
      const client = new RelayClient(runtime);
      const health = await client.health();
      const peers = await client.peers();
      this.client = {
        relayUrl: runtime.relayUrl,
        reachable: true,
        error: '',
        hint: '',
        hub: health.hub || null,
        latest: health.latest,
        peers: Array.isArray(peers.peers) ? peers.peers : [],
        checkedAt: now,
      };
    } catch (error) {
      this.client = {
        relayUrl: runtime.relayUrl,
        reachable: false,
        error: error?.message || String(error),
        hint: error?.hint || '',
        peers: [],
        checkedAt: now,
      };
    }
    return this.client;
  }

  // ------------------------------------------------------------------ 状态（设置页数据源）

  async state() {
    const runtime = this.config || this.readConfigOrPrev();
    const raw = (() => {
      try {
        return readRawConfig(this.configPath);
      } catch {
        return {};
      }
    })();
    const port = runtime.hub.port || DEFAULT_PORT;
    const hubStatus = this.hub && typeof this.hub.status === 'function' ? this.hub.status() : null;
    const joinCode = runtime.role === 'server' && runtime.token
      ? encodeJoinCode({ url: advertiseUrl(runtime, raw), token: runtime.token, self: runtime.self })
      : '';
    const client = await this.probe();
    return {
      api: 1,
      version: VERSION,
      role: runtime.role,
      self: runtime.self,
      token: runtime.token,
      joinCode,
      configPath: this.configPath,
      hub: {
        enabled: runtime.role === 'server',
        running: Boolean(hubStatus?.running),
        host: runtime.hub.host || '0.0.0.0',
        port,
        urls: hubUrls(port),
        dataDir: runtime.hub.dataDir,
        messages: hubStatus?.messages ?? 0,
        latestSeq: hubStatus?.latestSeq ?? 0,
        error: this.hubError || '',
      },
      client: {
        relayUrl: client.relayUrl || runtime.relayUrl,
        reachable: Boolean(client.reachable),
        error: client.error || '',
        hint: client.hint || '',
        peers: client.peers || [],
        wake: {
          enabled: runtime.role !== 'off' && runtime.push.enabled,
          stats: this.wake?.stats ?? null,
        },
      },
      firewall: { port, supported: process.platform === 'win32' },
      tools: this.toolNames || [],
      startedAt: this.startedAt,
      lastError: this.lastError,
    };
  }

  // ------------------------------------------------------------------ 配置写入（设置页调用）

  async applyConfig(body = {}) {
    const patch = {};
    if (body.joinCode) {
      const decoded = decodeJoinCode(body.joinCode);
      patch.relay_url = decoded.url;
      patch.token = decoded.token;
      if (decoded.self) patch.self = decoded.self;
      if (!body.role) patch.role = 'client';
    }
    if (typeof body.role === 'string' && body.role) patch.role = body.role;
    if (body.port !== undefined && body.port !== null && body.port !== '') patch.port = body.port;
    if (body.relay_url !== undefined) patch.relay_url = body.relay_url;
    if (body.token !== undefined) patch.token = body.token;
    if (body.self !== undefined) patch.self = body.self;
    if (!ROLES.includes(patch.role)) {
      throw new ConfigError(`role 不合法：${JSON.stringify(patch.role)}`, '可选值：server / client / off。');
    }
    saveConfig(patch, this.configPath);
    await this.reload('settings');
    return this.state();
  }

  async applyToken(body = {}) {
    if (body.regenerate !== true) throw new ConfigError('缺少 regenerate:true');
    regenerateToken(this.configPath);
    await this.reload('token');
    return this.state();
  }

  // ------------------------------------------------------------------ 防火墙

  firewallCommand() {
    const port = this.config?.hub?.port || DEFAULT_PORT;
    const script = path.join(PKG_DIR, 'scripts', 'allow-firewall.ps1');
    return `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" -Port ${port}`;
  }

  async allowFirewall() {
    const command = this.firewallCommand();
    if (process.platform !== 'win32') {
      return { ok: false, method: 'failed', command, error: '一键放行仅支持 Windows；其它系统请自行放行端口。' };
    }
    const port = this.config?.hub?.port || DEFAULT_PORT;
    const script = path.join(PKG_DIR, 'scripts', 'allow-firewall.ps1');
    try {
      const inner = [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        `"${script}"`,
        '-Port',
        String(port),
      ].join(' ');
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-Command', `Start-Process powershell.exe -Verb RunAs -ArgumentList '${inner.replace(/'/g, "''")}'`],
        { detached: true, stdio: 'ignore', windowsHide: true },
      );
      child.unref();
      return { ok: true, method: 'uac', command };
    } catch (error) {
      return { ok: false, method: 'failed', command, error: String(error?.message || error) };
    }
  }

  // ------------------------------------------------------------------ 同源管理 API

  installAdminRoutes() {
    const ctx = this.ctx;
    if (typeof ctx?.inject !== 'function') return;
    try {
      ctx.inject(['webServer'], (wctx) => {
        try {
          const dispose = wctx.webServer.register({
            kind: 'prefix',
            path: `${ROUTE_PREFIX}/api`,
            handler: (req, res) => this.handleApi(req, res),
          });
          if (typeof wctx.effect === 'function') wctx.effect(() => dispose);
          this.debug(`管理 API 已挂载：${ROUTE_PREFIX}/api`);
        } catch (error) {
          this.lastError = `管理 API 挂载失败：${error?.message || error}`;
          safeFileLog('error', this.lastError);
        }
      });
    } catch (error) {
      this.lastError = `等待 webServer 失败：${error?.message || error}`;
      safeFileLog('error', this.lastError);
    }
  }

  async handleApi(req, res) {
    const write = (status, payload) => {
      if (res.writableEnded) return;
      const text = JSON.stringify(payload);
      res.statusCode = status;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(text);
    };
    try {
      if (!isLoopbackRequest(req)) {
        write(403, { ok: false, error: 'forbidden' });
        return;
      }
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const route = url.pathname.replace(/\/+$/, '');
      if (req.method === 'GET' && (route === `${ROUTE_PREFIX}/api/state` || route === `${ROUTE_PREFIX}/api`)) {
        write(200, await this.state());
        return;
      }
      if (req.method !== 'POST') {
        res.setHeader('allow', 'GET, POST');
        write(405, { ok: false, error: 'method not allowed' });
        return;
      }
      const body = await readJsonBody(req);
      if (route === `${ROUTE_PREFIX}/api/config`) {
        const state = await this.applyConfig(body);
        write(200, { ok: true, ...state });
        return;
      }
      if (route === `${ROUTE_PREFIX}/api/token`) {
        const state = await this.applyToken(body);
        write(200, { ok: true, ...state });
        return;
      }
      if (route === `${ROUTE_PREFIX}/api/test`) {
        const client = await this.probe(true);
        write(200, {
          ok: Boolean(client.reachable),
          hub: client.hub || null,
          relay_url: client.relayUrl || '',
          peers: client.peers || [],
          error: client.reachable ? null : client.error || '连不上 hub',
          hint: client.hint || '',
        });
        return;
      }
      if (route === `${ROUTE_PREFIX}/api/firewall`) {
        write(200, await this.allowFirewall());
        return;
      }
      write(404, { ok: false, error: `未知接口：${req.method} ${route}` });
    } catch (error) {
      const known = error instanceof ConfigError || error instanceof RelayError;
      const payload = {
        ok: false,
        error: error?.message || String(error),
        hint: error?.hint || '',
      };
      if (!known) {
        safeFileLog('error', `管理 API 失败：${error?.stack || error}`);
      }
      write(known ? 400 : 500, payload);
    }
  }

  // ------------------------------------------------------------------ Agent 工具

  ensureClient() {
    const runtime = this.config || normalizeConfig(readRawConfig(this.configPath), this.configPath);
    this.config = runtime;
    if (runtime.role === 'off') {
      throw new RelayError('局域网中继未启用', {
        hint: '打开 DSH 设置 → 局域网中继，选择「服务端」或「客户端」并保存。',
      });
    }
    if (!runtime.relayUrl || !runtime.token) {
      throw new RelayError('局域网中继未配置完整', {
        hint: '服务端请确认 hub 已启动；客户端请粘贴服务端生成的加入码。',
      });
    }
    return new RelayClient(runtime);
  }

  installTools() {
    const ctx = this.ctx;
    const registerAll = (toolsService) => {
      if (!toolsService || typeof toolsService.register !== 'function') return;
      this.toolNames = [];
      const register = (spec) => {
        try {
          const dispose = toolsService.register(rawTool(spec));
          if (typeof dispose === 'function') this.toolDisposers.push(dispose);
          this.toolNames.push(spec.name);
        } catch (error) {
          safeFileLog('error', `注册工具 ${spec.name} 失败：${error?.message || error}`);
        }
      };
      register({
        name: 'lan_relay_send',
        description:
          '给局域网内另一台机器上的 DSH Agent 发消息。to=对方 peer 名（或 "*" 广播）；'
          + '可选 to_session 精确投递并唤醒指定会话（不知道就用 lan_relay_peers / 对方的 lan_relay_sessions 查）。',
        parameters: {
          type: 'object',
          properties: {
            to: { type: 'string', description: '对方 peer 名（小写字母/数字/._-），或 "*" 广播' },
            text: { type: 'string', description: '消息正文；对方是另一个 Agent，写清背景、要什么、期望回复格式' },
            to_session: { type: 'string', description: '可选：对方会话 id（如 session-a37a161f-...），会在对方机器上唤醒该会话' },
            thread: { type: 'string', description: '可选：话题标签' },
          },
          required: ['to', 'text'],
          additionalProperties: false,
        },
        async execute(args, exec) {
          const client = thisPlugin.ensureClient();
          const fromSession = sessionIdOf(exec?.agent);
          const result = await client.send({
            to: args.to,
            text: args.text,
            toSession: args.to_session || '',
            fromSession,
            thread: args.thread || '',
          });
          return {
            ok: true,
            seq: result.message?.seq,
            from: thisPlugin.config?.self || '',
            from_session: fromSession,
            to: result.message?.to,
            to_session: result.message?.to_session || '',
            sent_at: result.message?.sent_at || '',
          };
        },
      });
      register({
        name: 'lan_relay_inbox',
        description: '拉取发给本机的局域网消息（默认推进游标，同一条只返回一次；from_seq=0 可重读历史）。',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: '最多返回条数，默认 20，上限 200' },
            from_seq: { type: 'number', description: '可选：从哪个 seq 之后开始读（不填则用本地游标）' },
            mark_read: { type: 'boolean', description: '是否推进游标，默认 true' },
          },
          additionalProperties: false,
        },
        async execute(args) {
          const client = thisPlugin.ensureClient();
          return client.inbox({
            limit: clampInt(args.limit, 1, 200, 20),
            fromSeq: Number.isInteger(args.from_seq) ? args.from_seq : null,
            markRead: args.mark_read !== false,
          });
        },
      });
      register({
        name: 'lan_relay_wait',
        description: '长轮询等待发给本机的局域网消息（最长 50 秒；超时返回空数组，不报错）。收到后会自动推进游标。',
        parameters: {
          type: 'object',
          properties: {
            timeout_seconds: { type: 'number', description: '等待秒数，默认 25，上限 50' },
            after_seq: { type: 'number', description: '可选：从哪个 seq 之后开始等（不填则用本地游标）' },
          },
          additionalProperties: false,
        },
        async execute(args) {
          const client = thisPlugin.ensureClient();
          return client.wait({
            timeoutSeconds: clampInt(args.timeout_seconds, 1, 50, 25),
            afterSeq: Number.isInteger(args.after_seq) ? args.after_seq : null,
          });
        },
      });
      register({
        name: 'lan_relay_peers',
        description: '查看局域网内谁在线（120 秒内有请求即视为在线），以及 hub 是否可达。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        async execute() {
          const client = thisPlugin.ensureClient();
          const status = await client.status();
          return status;
        },
      });
      register({
        name: 'lan_relay_sessions',
        description: '列出本机当前活跃的 DSH 会话（id / 标题 / 状态 / 工作目录），用于回复时指定对方的 to_session。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        async execute() {
          const agents = liveAgents(thisPlugin.ctx);
          const runtime = thisPlugin.config || {};
          return {
            self: runtime.self || '',
            default_session: runtime.push?.default_session || '',
            sessions: agents.map((agent) => describeAgent(agent)),
          };
        },
      });
      register({
        name: 'lan_relay_status',
        description: '局域网中继总览：角色、hub 是否在跑、连通性、在线 peer、游标、自动唤醒统计。排障先调它。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        async execute() {
          const runtime = thisPlugin.config || thisPlugin.readConfigOrPrev();
          const state = await thisPlugin.state();
          return {
            role: state.role,
            self: state.self,
            relay_url: state.client.relayUrl,
            reachable: state.client.reachable,
            hub: state.hub,
            client: state.client,
            peers: state.client.peers,
            config_path: state.configPath,
            sessions: liveAgents(thisPlugin.ctx).map((agent) => describeAgent(agent)),
            hint: state.client.reachable
              ? ''
              : '服务端：确认角色是 server 且没有端口占用；客户端：确认加入码正确、两台机器同网段、服务端防火墙已放行。',
            version: VERSION,
            started_at: runtime?.self ? state.startedAt : state.startedAt,
          };
        },
      });
      register({
        name: 'lan_relay_configure',
        description:
          '配置局域网中继（等价于 设置 → 局域网中继 页面）：切换角色（server/client/off）、粘贴加入码、'
          + '改地址/token/本机名/端口、重新生成 token。用户说"把本机设成服务端 / 用这个加入码加入"时直接调它。',
        parameters: {
          type: 'object',
          properties: {
            role: { type: 'string', enum: ['server', 'client', 'off'], description: '运行角色：server=本机起 hub；client=连别人的 hub；off=停用' },
            join_code: { type: 'string', description: '服务端生成的加入码（dshrelay1.…），客户端加入时粘贴；填了它就不用手填地址和 token' },
            relay_url: { type: 'string', description: '客户端要连的 hub 地址，如 http://192.168.0.105:8787' },
            token: { type: 'string', description: '共享 token（一般由加入码带入，不用手填）' },
            self: { type: 'string', description: '本机 peer 名（小写字母/数字/._-，≤32）' },
            port: { type: 'number', description: '服务端 hub 端口，默认 8787' },
            regenerate_token: { type: 'boolean', description: 'true 时重新生成 token（旧加入码会失效）' },
          },
          additionalProperties: false,
        },
        async execute(args) {
          const body = {};
          if (args.role) body.role = args.role;
          if (args.join_code) body.joinCode = args.join_code;
          if (args.relay_url) body.relay_url = args.relay_url;
          if (args.token) body.token = args.token;
          if (args.self) body.self = args.self;
          if (args.port !== undefined) body.port = args.port;
          if (args.regenerate_token === true) {
            await thisPlugin.applyToken({ regenerate: true });
          }
          if (Object.keys(body).length) {
            if (!body.role && !body.joinCode) body.role = thisPlugin.config?.role || 'client';
            await thisPlugin.applyConfig(body);
          }
          const state = await thisPlugin.state();
          return {
            ok: true,
            role: state.role,
            self: state.self,
            hub: { running: state.hub.running, port: state.hub.port, urls: state.hub.urls, error: state.hub.error },
            client: {
              relay_url: state.client.relayUrl,
              reachable: state.client.reachable,
              error: state.client.error,
              peers: state.client.peers,
            },
            join_code: state.joinCode || '',
            config_path: state.configPath,
            next: state.role === 'server'
              ? '服务端已生效：把 join_code 发给对端，对端用 role=client + join_code 加入；如果对端连不上，检查防火墙 8787。'
              : state.role === 'client'
                ? '客户端已生效：状态里 reachable=true 即连通。'
                : '中继已关闭（工具仍可用，但会提示未启用）。',
          };
        },
      });
      this.log(`已注册 ${this.toolDisposers.length} 个局域网中继工具`);
    };

    const thisPlugin = this;
    let tools = null;
    try {
      tools = typeof ctx.get === 'function' ? ctx.get('tools') : null;
    } catch {
      tools = null;
    }
    if (tools) {
      registerAll(tools);
      return;
    }
    try {
      ctx.inject(['tools'], (tctx) => {
        let service = null;
        try {
          service = tctx.get('tools') ?? tctx.tools ?? null;
        } catch {
          service = null;
        }
        registerAll(service);
      });
    } catch (error) {
      safeFileLog('error', `等待 tools 服务失败：${error?.message || error}`);
    }
  }
}

// -------------------------------------------------------------------- helpers

function rawTool(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      try {
        return await spec.execute(args || {}, exec);
      } catch (error) {
        if (error instanceof RelayError || error instanceof ConfigError) {
          throw new Error(error.hint ? `${error.message}（提示：${error.hint}）` : error.message);
        }
        throw error;
      }
    },
  };
}

function sessionIdOf(agent) {
  try {
    return describeAgent(agent).id || '';
  } catch {
    return '';
  }
}

function liveAgents(ctx) {
  try {
    const list = ctx?.agents?.list?.();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function isLoopbackRequest(req) {
  const host = String(req.headers?.host || '').toLowerCase();
  if (!host) return true;
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}

async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new ConfigError(`请求体过大（上限 ${limit} 字节）`);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new ConfigError('请求体不是合法 JSON');
  }
}

export function apply(ctx) {
  const plugin = new LanRelayPlugin(ctx);
  try {
    plugin.init();
  } catch (error) {
    safeFileLog('error', `插件初始化异常：${error?.stack || error}`);
  }
  if (typeof ctx?.effect === 'function') {
    try {
      ctx.effect(() => () => plugin.dispose());
    } catch (error) {
      safeFileLog('error', `注册卸载清理失败：${error?.message || error}`);
    }
  }
  // 供同进程测试/排障读取（不影响 DSH）
  try {
    ctx.lanRelay = plugin;
  } catch {
    /* ignore */
  }
}
