/**
 * 加入码（join code）编解码 —— 零第三方依赖
 *
 * 格式：`dshrelay1.` + base64url(JSON.stringify({u: relayUrl, t: token, n: self?}))
 *   u = 中继地址（http/https），t = token，n = 可选的本机 peer 名
 *
 * 典型用途：hub 机器在设置页生成一行文本，另一台机器粘贴即可完成配对，
 * 省去手工抄 IP / token。
 *
 * 注意：加入码本身不加密，等同于明文传送 token，只适合在可信的局域网内传递。
 */
import { RelayError } from './config.mjs';

export const JOIN_CODE_PREFIX = 'dshrelay1.';

const PEER_PATTERN = /^[a-z0-9._-]{1,32}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function fail(message, hint) {
  return new RelayError(message, { hint });
}

/**
 * 规范化中继地址：只保留 http/https，去掉末尾多余的斜杠。
 * @param {unknown} raw
 * @param {{empty: [string, string], invalid: [string, string], scheme: [string, string]}} errors
 *   empty/invalid/scheme 分别为「缺少地址」「地址解析失败」「协议不支持」的 [message, hint]
 */
function normalizeRelayUrl(raw, errors) {
  const text = String(raw || '').trim();
  if (!text) throw fail(...errors.empty);
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw fail(...errors.invalid);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw fail(...errors.scheme);
  }
  const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
  return parsed.origin + pathname;
}

const URL_ERRORS_ENCODE = {
  empty: ['生成加入码需要中继地址', '示例：http://192.168.0.105:8787'],
  invalid: ['地址不是合法 URL', '示例：http://192.168.0.105:8787'],
  scheme: ['地址只支持 http/https', '示例：http://192.168.0.105:8787'],
};

const URL_ERRORS_DECODE = {
  empty: ['加入码里没有地址', '请让对端在设置页重新生成加入码。'],
  invalid: ['加入码里的地址不合法', '示例：http://192.168.0.105:8787'],
  scheme: ['加入码里的地址只支持 http/https', '示例：http://192.168.0.105:8787'],
};

/**
 * @param {{url?: string, token?: string, self?: string}} input
 * @returns {string} 加入码
 */
export function encodeJoinCode({ url, token, self } = {}) {
  if (!String(url || '').trim()) {
    throw fail('生成加入码需要中继地址', '示例：http://192.168.0.105:8787');
  }
  const relayUrl = normalizeRelayUrl(url, URL_ERRORS_ENCODE);
  const normalizedToken = String(token ?? '').trim();
  if (!normalizedToken) {
    throw fail('生成加入码需要 token', 'token 是两台机器通信的凭据，不能为空。');
  }

  const payload = { u: relayUrl, t: normalizedToken };
  const rawSelf = String(self ?? '').trim().toLowerCase();
  if (rawSelf) {
    if (!PEER_PATTERN.test(rawSelf)) {
      throw fail(`本机名不合法：${JSON.stringify(self)}`, '只允许小写字母、数字、点、下划线、短横线，长度 1-32。');
    }
    payload.n = rawSelf;
  }

  return JOIN_CODE_PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * @param {string} code
 * @returns {{url: string, token: string, self: string}}
 */
export function decodeJoinCode(code) {
  const raw = String(code ?? '').trim();
  if (!raw) throw fail('加入码格式不对', '加入码是一行以 dshrelay1. 开头的文本，请完整复制。');
  if (!raw.startsWith(JOIN_CODE_PREFIX)) {
    throw fail('加入码格式不对', `加入码应以 ${JOIN_CODE_PREFIX} 开头，请从对端设置页重新复制。`);
  }

  const body = raw.slice(JOIN_CODE_PREFIX.length).trim();
  if (!body || !BASE64URL_PATTERN.test(body)) {
    throw fail('加入码格式不对', 'dshrelay1. 后面应为 base64url 文本，可能复制时少了字符。');
  }

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw fail('加入码内容无法解析', '加入码可能已损坏，请让对端重新生成。');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw fail('加入码格式不对', '加入码内容应为 JSON 对象，请让对端重新生成。');
  }

  if (!String(parsed.u || '').trim()) {
    throw fail('加入码里没有地址', '请让对端在设置页重新生成加入码。');
  }
  const url = normalizeRelayUrl(parsed.u, URL_ERRORS_DECODE);

  const token = String(parsed.t ?? '').trim();
  if (!token) {
    throw fail('加入码里没有 token', '请让对端在设置页重新生成加入码。');
  }

  const self = String(parsed.n ?? '').trim().toLowerCase();
  if (self && !PEER_PATTERN.test(self)) {
    throw fail(`加入码里的本机名不合法：${JSON.stringify(parsed.n)}`, '只允许小写字母、数字、点、下划线、短横线，长度 1-32。');
  }

  return { url, token, self };
}
