/**
 * DSH 插件形态的配置管理（与 hub / MCP server / CLI 共用同一份
 * `~/.dsh/lan-relay/config.json`，格式向后兼容）。
 *
 * 角色语义：
 *   role = 'server'  → 本机在 DSH 进程内启动 hub；自身作为客户端走 127.0.0.1 连本地 hub
 *   role = 'client'  → 只做客户端，用 relay_url + token 连另一台机器的 hub
 *   role = 'off'     → 不启动 hub、不轮询（仍注册工具，调用时会提示未启用）
 *
 * 除角色外的既有字段（relay_url / token / self / state_dir / hub / push）全部保留原语义，
 * 因此旧版 hub.mjs、mcp-server.mjs、relay-cli.mjs 仍然能读同一份配置。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const CONFIG_DIR = path.join(os.homedir(), '.dsh', 'lan-relay');
export const DEFAULT_CONFIG_PATH = process.env.LAN_RELAY_CONFIG || path.join(CONFIG_DIR, 'config.json');
export const DEFAULT_PORT = 8787;
export const ROLES = ['server', 'client', 'off'];
export const ROLE_LABELS = { server: '服务端', client: '客户端', off: '关闭' };

export class ConfigError extends Error {
  constructor(message, hint = '') {
    super(message);
    this.name = 'ConfigError';
    this.hint = hint;
  }
  toString() {
    return this.hint ? `${this.message}\n提示：${this.hint}` : this.message;
  }
}

/** 读取原始配置对象；文件不存在返回 {}，JSON 损坏抛 ConfigError。 */
export function readRawConfig(configPath = DEFAULT_CONFIG_PATH) {
  let text = '';
  try {
    text = fs.readFileSync(configPath, 'utf8').trim();
  } catch (error) {
    if (error && error.code === 'ENOENT') return {};
    throw new ConfigError(`读取配置失败：${configPath}`, String(error?.message || error));
  }
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    throw new ConfigError(`配置文件不是合法 JSON：${configPath}`, '修好该文件，或在设置页重新保存一次即可覆盖。');
  }
}

export function normalizeRelayUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`relay_url 不是合法 URL：${raw}`, '示例：http://192.168.0.105:8787');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`relay_url 只支持 http/https：${raw}`);
  }
  return url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, ''));
}

export function normalizePeerName(value) {
  const name = String(value || '').trim().toLowerCase();
  if (!name) return '';
  if (!/^[a-z0-9._-]{1,32}$/.test(name)) {
    throw new ConfigError(
      `peer 名不合法：${JSON.stringify(value)}`,
      '只允许小写字母、数字、点、下划线、短横线，长度 1-32。例如：pc1 / office-pc / b',
    );
  }
  return name;
}

export function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`端口不合法：${JSON.stringify(value)}`, '端口范围 1-65535，默认 8787。');
  }
  return port;
}

export function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/** 根据原始配置推断角色（未显式设置 role 时保持旧部署可用）。 */
export function inferRole(raw = {}) {
  if (ROLES.includes(raw.role)) return raw.role;
  if (raw.hub && typeof raw.hub === 'object' && raw.hub.enabled === true) return 'server';
  if (String(raw.token || '').trim() && String(raw.relay_url || raw.url || '').trim()) return 'client';
  return 'off';
}

/** 局域网 IPv4 地址候选（排除回环/虚拟网卡常见前缀交给上层过滤）。 */
export function lanAddresses() {
  const out = [];
  try {
    for (const [name, items] of Object.entries(os.networkInterfaces())) {
      for (const item of items || []) {
        if (!item || item.family !== 'IPv4' || item.internal) continue;
        out.push({ name, address: item.address });
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

export function hubUrls(port) {
  return lanAddresses().map(({ address }) => `http://${address}:${port}`);
}

/**
 * 解析成运行时视图。shape 与 lib/core.mjs 的 loadRelayConfig 保持一致，
 * 便于直接传给 createRuntime({ config })。
 */
export function normalizeConfig(raw = {}, configPath = DEFAULT_CONFIG_PATH) {
  const role = inferRole(raw);
  const hubRaw = raw.hub && typeof raw.hub === 'object' ? raw.hub : {};
  const pushRaw = raw.push && typeof raw.push === 'object' ? raw.push : {};
  const port = normalizePort(hubRaw.port ?? DEFAULT_PORT);
  const self = normalizePeerName(raw.self || os.hostname()) || 'dsh';
  let token = String(raw.token || '').trim();
  if (role === 'server' && !token) token = generateToken();

  let relayUrl = normalizeRelayUrl(raw.relay_url || raw.url || '');
  if (role === 'server') relayUrl = `http://127.0.0.1:${port}`;
  else if (role === 'client' && !relayUrl) relayUrl = '';

  return {
    role,
    configPath,
    self,
    token,
    relayUrl,
    stateDir: String(raw.state_dir || path.join(CONFIG_DIR, 'state')),
    requestTimeoutMs: Number(raw.request_timeout_ms) > 0 ? Number(raw.request_timeout_ms) : 15000,
    hub: {
      enabled: role === 'server',
      host: String(hubRaw.host || '0.0.0.0'),
      port,
      dataDir: String(hubRaw.data_dir || path.join(CONFIG_DIR, 'hub')),
    },
    push: {
      enabled: pushRaw.enabled !== false,
      default_session: typeof pushRaw.default_session === 'string' ? pushRaw.default_session : '',
      wake: pushRaw.wake !== false,
      poll_timeout_seconds: Number(pushRaw.poll_timeout_seconds) > 0 ? Number(pushRaw.poll_timeout_seconds) : 25,
      offline_fallback: pushRaw.offline_fallback === true,
      require_session: pushRaw.require_session === true,
      cold_session: pushRaw.cold_session === 'drop' ? 'drop' : 'prompt',
    },
  };
}

function atomicWrite(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 保存配置（合并到现有文件，保留未知字段），返回规范化后的运行时视图。
 * @param {object} patch 允许字段：role / port / relay_url / token / self / joinCode 已由上层解码
 */
export function saveConfig(patch = {}, configPath = DEFAULT_CONFIG_PATH) {
  const raw = readRawConfig(configPath);
  const role = ROLES.includes(patch.role) ? patch.role : inferRole(raw);
  const port = normalizePort(patch.port ?? raw.hub?.port ?? DEFAULT_PORT);
  const self = normalizePeerName(patch.self ?? raw.self ?? os.hostname()) || 'dsh';

  let token = String(patch.token ?? raw.token ?? '').trim();
  if (role === 'server' && !token) token = generateToken();

  let relayUrl = '';
  if (role === 'client') {
    relayUrl = normalizeRelayUrl(patch.relay_url ?? raw.relay_url ?? raw.url ?? '');
    if (!relayUrl) {
      throw new ConfigError('作为客户端加入前需要填写 hub 地址（或粘贴加入码）', '地址形如 http://192.168.0.105:8787');
    }
    if (!token) {
      throw new ConfigError('作为客户端加入前需要填写 token（或粘贴加入码）', 'token 由服务端机器生成，可在那台机器的设置页复制加入码。');
    }
  } else if (role === 'server') {
    relayUrl = `http://127.0.0.1:${port}`;
  } else {
    relayUrl = normalizeRelayUrl(patch.relay_url ?? raw.relay_url ?? '');
  }

  const hubRaw = raw.hub && typeof raw.hub === 'object' ? raw.hub : {};
  const next = {
    ...raw,
    role,
    self,
    token,
    relay_url: relayUrl,
    hub: {
      ...hubRaw,
      enabled: role === 'server',
      host: String(hubRaw.host || '0.0.0.0'),
      port,
      data_dir: String(hubRaw.data_dir || path.join(CONFIG_DIR, 'hub')),
    },
    push: {
      enabled: true,
      default_session: '',
      wake: true,
      poll_timeout_seconds: 25,
      offline_fallback: false,
      require_session: false,
      cold_session: 'prompt',
      ...(raw.push && typeof raw.push === 'object' ? raw.push : {}),
    },
  };
  if (!next.state_dir) next.state_dir = path.join(CONFIG_DIR, 'state');
  atomicWrite(configPath, `${JSON.stringify(next, null, 2)}\n`);
  return normalizeConfig(next, configPath);
}

/** 重新生成 token 并落盘（服务端换 token 后旧客户端需重新加入）。 */
export function regenerateToken(configPath = DEFAULT_CONFIG_PATH) {
  const raw = readRawConfig(configPath);
  const token = generateToken();
  return saveConfig({ ...raw, token, role: inferRole(raw) === 'off' ? 'server' : inferRole(raw) }, configPath);
}

/** 服务端对外可用的 hub 地址（用于加入码）。优先显式 relay_url，其次第一个局域网地址。 */
export function advertiseUrl(runtime, raw = {}) {
  const explicit = normalizeRelayUrl(raw.relay_url || '');
  if (explicit && !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(explicit)) return explicit;
  const urls = hubUrls(runtime?.hub?.port || DEFAULT_PORT);
  return urls[0] || `http://127.0.0.1:${runtime?.hub?.port || DEFAULT_PORT}`;
}
