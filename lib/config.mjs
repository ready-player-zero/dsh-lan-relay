/**
 * 配置解析：命令行 > 环境变量 > 配置文件 > 默认值
 *
 * 默认配置文件：~/.dsh/lan-relay/config.json
 * 两份 DSH（两台机器）只需要各自的这份配置即可，MCP server 不需要额外参数。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_DIR = path.join(os.homedir(), '.dsh', 'lan-relay');
export const DEFAULT_CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

/** 中继/通信相关的错误，带排障提示，方便直接展示给 Agent */
export class RelayError extends Error {
  constructor(message, { hint = '', cause = null, status = 0 } = {}) {
    super(message);
    this.name = 'RelayError';
    this.hint = hint;
    this.cause = cause;
    this.status = status;
  }
  toString() {
    return this.hint ? `${this.message}\n提示：${this.hint}` : this.message;
  }
}

function pick(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    return value;
  }
  return '';
}

export function readConfigFile(configPath = DEFAULT_CONFIG_PATH) {
  try {
    if (!fs.existsSync(configPath)) return {};
    const text = fs.readFileSync(configPath, 'utf8').trim();
    if (!text) return {};
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    throw new RelayError(`配置文件解析失败：${configPath}`, {
      hint: '请确认该文件是合法 JSON；可以直接用 examples/config.hub.json 覆盖重写。',
      cause: error,
    });
  }
}

export function normalizeRelayUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new RelayError(`relay_url 不是合法 URL：${raw}`, {
      hint: '示例：http://192.168.0.105:8787',
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RelayError(`relay_url 只支持 http/https：${raw}`);
  }
  return url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, ''));
}

export function normalizePeerName(value) {
  const name = String(value || '').trim().toLowerCase();
  if (!name) return '';
  if (!/^[a-z0-9._-]{1,32}$/.test(name)) {
    throw new RelayError(`peer 名不合法：${JSON.stringify(value)}`, {
      hint: '只允许小写字母、数字、点、下划线、短横线，长度 1-32。例如：pc1 / office-pc / b',
    });
  }
  return name;
}

/**
 * 读取本机 LAN relay 配置。
 * @param {{config?: string, url?: string, token?: string, self?: string, state?: string}} cli
 */
export function loadConfig(cli = {}) {
  const configPath = pick(cli.config, process.env.LAN_RELAY_CONFIG, DEFAULT_CONFIG_PATH);
  const file = readConfigFile(configPath);

  const relayUrl = normalizeRelayUrl(
    pick(cli.url, process.env.LAN_RELAY_URL, file.relay_url, file.url, ''),
  );
  const token = String(
    pick(cli.token, process.env.LAN_RELAY_TOKEN, file.token, ''),
  ).trim();
  const self = normalizePeerName(
    pick(cli.self, process.env.LAN_RELAY_SELF, file.self, os.hostname()),
  );
  const stateDir = pick(
    cli.state,
    process.env.LAN_RELAY_STATE,
    file.state_dir,
    path.join(CONFIG_DIR, 'state'),
  );
  const requestTimeoutMs = Number(
    pick(process.env.LAN_RELAY_TIMEOUT_MS, file.request_timeout_ms, 15000),
  );

  return {
    configPath,
    file,
    relayUrl,
    token,
    self,
    stateDir,
    requestTimeoutMs: Number.isFinite(requestTimeoutMs) ? requestTimeoutMs : 15000,
    hub: file.hub && typeof file.hub === 'object' ? file.hub : {},
  };
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
