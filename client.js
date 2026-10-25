/**
 * dsh-lan-relay — Web half.
 *
 * Registers one Settings section ("局域网中继" / "LAN Relay") that drives the
 * Host half over same-origin JSON endpoints under /lan-relay/api:
 *
 *   GET  /lan-relay/api/state    -> { api, version, role, self, token, joinCode, configPath, hub, client, firewall }
 *   POST /lan-relay/api/config   -> state | 400 { ok:false, error, hint }
 *   POST /lan-relay/api/token    -> state
 *   POST /lan-relay/api/test     -> { ok, hub, error }
 *   POST /lan-relay/api/firewall -> { ok, method:'uac'|'failed', command, error }
 *
 * Hand-written browser module: no build step, no JSX, no third-party imports.
 * Every request failure is rendered in-page; nothing here assumes the Host half
 * is present (it may 404 during development), so the page always renders.
 */
window.__ModuleLoader__.load({
  id: 'dsh-lan-relay',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace registered with the Client locale service. */
    const NS = 'lan-relay';
    /** Same-origin API root served by the Host half. */
    const API_BASE = '/lan-relay/api';
    /** Join-code version prefix; payload is base64url(JSON { u, t, n }). */
    const JOIN_PREFIX = 'dshrelay1.';

    // #region dictionaries

    const zh = {
      nav: '局域网中继',
      title: '局域网中继',
      subtitle: '跨机器 DSH Agent 消息互通 · 内嵌 hub · 自动唤醒',

      'common.loading': '加载中…',
      'common.refreshing': '刷新中…',
      'common.refresh': '刷新',
      'common.copy': '复制',
      'common.copied': '已复制',
      'common.copyFailed': '复制失败，已选中文本，请按 Ctrl+C',
      'common.show': '显示',
      'common.hide': '隐藏',
      'common.save': '保存',
      'common.saving': '保存中…',
      'common.or': '或',
      'common.unknown': '未知',
      'common.none': '（无）',

      'badge.server.running': '服务端运行中',
      'badge.server.error': '服务端异常',
      'badge.server.stopped': '服务端未运行',
      'badge.client.reachable': '客户端已连接',
      'badge.client.error': '客户端连接失败',
      'badge.client.offline': '客户端未连接',
      'badge.off': '未启用',
      'badge.unavailable': 'Host 接口不可用',

      'error.hostUnavailable': '无法连接 Host 接口',
      'error.http': '请求失败（HTTP {status}）',
      'error.network': '网络请求失败',
      'error.badResponse': 'Host 返回的响应不是合法 JSON',
      'error.saveFailed': '保存失败：{error}',
      'error.tokenFailed': '生成新 token 失败：{error}',
      'error.firewallFailed': '放行请求失败：{error}',
      'error.staleData': '下面显示的是上一次成功获取的状态，可能是旧数据。',

      'warn.apiMismatch': 'Host 接口版本为 {api}，本页按 api=1 渲染，部分字段可能缺失。',

      'role.legend': '运行角色',
      'role.server': '服务端',
      'role.client': '客户端',
      'role.off': '关闭',
      'role.hint': '服务端在本机启动消息总线；客户端连接对端服务端；关闭则完全不启用。',
      'role.offDesc': '已关闭：插件不启动 hub、不连接中继、也不监听消息唤醒，已有配置保留。',

      'server.section': '服务端',
      'server.state': 'Hub 状态',
      'server.running': '运行中',
      'server.stopped': '未运行',
      'server.error': '错误',
      'server.port': '端口',
      'server.port.hint': '1-65535，默认 8787',
      'server.port.invalid': '端口必须是 1 到 65535 之间的整数',
      'server.self': '本机名称',
      'server.self.placeholder': '例如 pc1',
      'server.self.hint': '对端 peer 列表里显示的名字',
      'server.token': 'Token',
      'server.token.hint': '对端连接本机时使用；重新生成后需要把新的加入码发给对方。',
      'server.token.regenerate': '重新生成',
      'server.token.regenerating': '生成中…',
      'server.joinCode': '加入码',
      'server.joinCode.hint': '复制给对方，对端粘贴即可自动填入地址与 token。',
      'server.joinCode.empty': '暂无加入码（Host 接口可能未就绪）。',
      'server.joinCode.needServer': '当前不是服务端：切到「服务端」并保存后才会生成加入码。',
      'server.addresses': '本机地址',
      'server.addresses.empty': '暂无可用地址（hub 未运行时无法探测）。',
      'server.dataDir': '数据目录',
      'server.messages': '消息数',
      'server.latestSeq': '最新序号',
      'server.firewall': '一键放行防火墙',
      'server.firewall.running': '正在请求…',
      'server.firewall.uac': '已弹出管理员授权窗口，请点「是」。',
      'server.firewall.failed': '自动放行失败。',
      'server.firewall.unsupported': '当前系统不支持一键放行，请手动放行端口。',
      'server.firewall.hint': '放行 TCP {port} 端口（可能需要管理员权限）。',
      'server.firewall.ok': '已放行 TCP {port} 端口。',
      'server.firewall.command': '可复制的命令（以管理员身份运行）',

      'client.section': '客户端',
      'client.joinCode': '加入码',
      'client.joinCode.placeholder': '粘贴对端给的加入码（dshrelay1.…）',
      'client.joinCode.preview': '已识别 {url} · Token 末 4 位 {tail}',
      'client.joinCode.invalid': '加入码格式不正确：应以 dshrelay1. 开头且内容完整。',
      'client.joinCode.priority': '填写加入码后，下面的地址与 token 会被忽略。',
      'client.relayUrl': '中继地址',
      'client.relayUrl.placeholder': 'http://192.168.1.10:8787',
      'client.relayUrl.required': '请填写中继地址，或粘贴对端的加入码。',
      'client.relayUrl.invalid': '地址必须以 http:// 或 https:// 开头。',
      'client.token': 'Token',
      'client.token.placeholder': '对端服务端的 token',
      'client.token.hint': '留空则沿用当前 token。',
      'client.test': '连接测试',
      'client.testing': '测试中…',
      'client.test.ok': '连接成功：{name} {version}',
      'client.test.okNoHub': '连接成功',
      'client.test.fail': '连接失败：{error}',
      'client.reachable': '中继可达',
      'client.unreachable': '中继不可达',
      'client.peers': '在线 peer',
      'client.peers.empty': '暂无在线 peer。',
      'client.peers.online': '在线',
      'client.peers.offline': '离线',
      'client.peers.seen': '最后活动 {ago}',
      'client.peers.count': '在线 {online} / 共 {total}',
      'client.wake': '消息唤醒',
      'client.wake.on': '已开启',
      'client.wake.off': '未开启',
      'client.wake.stats': '统计',
      'client.error': '连接错误',

      'notice.saved': '已保存，新配置已生效。',
      'notice.savedRoleOff': '已保存：局域网中继已关闭。',
      'notice.tokenRegenerated': '已生成新 token，请把新的加入码发给对端。',
      'notice.dirty': '有未保存的修改',

      'config.path': '配置文件',
      'foot.version': '版本 {version}',
      'foot.hint': '修改只在点击「保存」后提交；页面每 3 秒自动刷新状态。',

      'time.seconds': '{n} 秒前',
      'time.minutes': '{n} 分钟前',
      'time.hours': '{n} 小时前',
      'time.days': '{n} 天前',
    };

    const en = {
      nav: 'LAN Relay',
      title: 'LAN Relay',
      subtitle: 'DSH agent messaging across machines · embedded hub · wake on message',

      'common.loading': 'Loading…',
      'common.refreshing': 'Refreshing…',
      'common.refresh': 'Refresh',
      'common.copy': 'Copy',
      'common.copied': 'Copied',
      'common.copyFailed': 'Copy failed: text selected, press Ctrl+C',
      'common.show': 'Show',
      'common.hide': 'Hide',
      'common.save': 'Save',
      'common.saving': 'Saving…',
      'common.or': 'or',
      'common.unknown': 'unknown',
      'common.none': '(none)',

      'badge.server.running': 'Server running',
      'badge.server.error': 'Server error',
      'badge.server.stopped': 'Server stopped',
      'badge.client.reachable': 'Client connected',
      'badge.client.error': 'Client connection failed',
      'badge.client.offline': 'Client not connected',
      'badge.off': 'Disabled',
      'badge.unavailable': 'Host API unavailable',

      'error.hostUnavailable': 'Cannot reach the Host API',
      'error.http': 'Request failed (HTTP {status})',
      'error.network': 'Network request failed',
      'error.badResponse': 'The Host response was not valid JSON',
      'error.saveFailed': 'Save failed: {error}',
      'error.tokenFailed': 'Token generation failed: {error}',
      'error.firewallFailed': 'Firewall request failed: {error}',
      'error.staleData': 'The status below was fetched earlier and may be stale.',

      'warn.apiMismatch': 'Host API version is {api}; this page renders api=1, so some fields may be missing.',

      'role.legend': 'Role',
      'role.server': 'Server',
      'role.client': 'Client',
      'role.off': 'Off',
      'role.hint': 'Server starts the message hub on this machine; Client connects to a peer server; Off disables everything.',
      'role.offDesc': 'Disabled: no hub, no relay connection, no wake on message. Existing configuration is kept.',

      'server.section': 'Server',
      'server.state': 'Hub status',
      'server.running': 'running',
      'server.stopped': 'stopped',
      'server.error': 'Error',
      'server.port': 'Port',
      'server.port.hint': '1-65535, default 8787',
      'server.port.invalid': 'Port must be an integer between 1 and 65535',
      'server.self': 'This machine name',
      'server.self.placeholder': 'e.g. pc1',
      'server.self.hint': 'Name peers see in their peer list',
      'server.token': 'Token',
      'server.token.hint': 'Peers use it to connect here; regenerate it and share the new join code.',
      'server.token.regenerate': 'Regenerate',
      'server.token.regenerating': 'Generating…',
      'server.joinCode': 'Join code',
      'server.joinCode.hint': 'Copy it to the other machine; pasting it fills address and token.',
      'server.joinCode.empty': 'No join code yet (the Host API may not be ready).',
      'server.joinCode.needServer': 'Not the server right now: switch to “Server” and save to generate a join code.',
      'server.addresses': 'Local addresses',
      'server.addresses.empty': 'No address available (the hub is not running).',
      'server.dataDir': 'Data directory',
      'server.messages': 'Messages',
      'server.latestSeq': 'Latest seq',
      'server.firewall': 'Allow through firewall',
      'server.firewall.running': 'Requesting…',
      'server.firewall.uac': 'An administrator consent prompt was opened; click Yes.',
      'server.firewall.failed': 'Automatic rule creation failed.',
      'server.firewall.unsupported': 'This system cannot add the rule automatically; allow the port manually.',
      'server.firewall.hint': 'Allow TCP port {port} (may need administrator rights).',
      'server.firewall.ok': 'TCP port {port} is now allowed.',
      'server.firewall.command': 'Copyable command (run as administrator)',

      'client.section': 'Client',
      'client.joinCode': 'Join code',
      'client.joinCode.placeholder': 'Paste the join code from the peer (dshrelay1.…)',
      'client.joinCode.preview': 'Parsed {url} · token ends with {tail}',
      'client.joinCode.invalid': 'Invalid join code: it must start with dshrelay1. and be complete.',
      'client.joinCode.priority': 'When a join code is filled in, the address and token below are ignored.',
      'client.relayUrl': 'Relay URL',
      'client.relayUrl.placeholder': 'http://192.168.1.10:8787',
      'client.relayUrl.required': 'Enter the relay URL, or paste the peer join code.',
      'client.relayUrl.invalid': 'The URL must start with http:// or https://.',
      'client.token': 'Token',
      'client.token.placeholder': 'Token of the peer server',
      'client.token.hint': 'Leave empty to keep the current token.',
      'client.test': 'Test connection',
      'client.testing': 'Testing…',
      'client.test.ok': 'Connected: {name} {version}',
      'client.test.okNoHub': 'Connected',
      'client.test.fail': 'Connection failed: {error}',
      'client.reachable': 'Relay reachable',
      'client.unreachable': 'Relay unreachable',
      'client.peers': 'Online peers',
      'client.peers.empty': 'No peer online yet.',
      'client.peers.online': 'online',
      'client.peers.offline': 'offline',
      'client.peers.seen': 'last seen {ago}',
      'client.peers.count': '{online} online / {total} total',
      'client.wake': 'Wake on message',
      'client.wake.on': 'enabled',
      'client.wake.off': 'disabled',
      'client.wake.stats': 'Stats',
      'client.error': 'Connection error',

      'notice.saved': 'Saved. The new configuration is in effect.',
      'notice.savedRoleOff': 'Saved: LAN relay is now disabled.',
      'notice.tokenRegenerated': 'New token generated; send the new join code to the peer.',
      'notice.dirty': 'Unsaved changes',

      'config.path': 'Config file',
      'foot.version': 'Version {version}',
      'foot.hint': 'Changes are submitted only when you click Save; status refreshes every 3 seconds.',

      'time.seconds': '{n}s ago',
      'time.minutes': '{n}m ago',
      'time.hours': '{n}h ago',
      'time.days': '{n}d ago',
    };

    // #endregion

    // #region locale seats

    /**
     * Dictionary picked by the document language. Used only while the locale
     * service seat is unwired, so the page still speaks Chinese/English.
     */
    function fallbackDictionary() {
      const lang =
        typeof document !== 'undefined' && document.documentElement
          ? String(document.documentElement.lang || '')
          : 'zh';
      return lang.toLowerCase().indexOf('en') === 0 ? en : zh;
    }

    let runtimeTranslate;

    /** Wire the locale-service translate seat; pass undefined to restore fallback. */
    function setRuntimeTranslate(translate) {
      runtimeTranslate = translate;
    }

    /** Translate a key with optional `{name}` params; a missing key degrades to the key. */
    function t(key, params) {
      try {
        if (typeof runtimeTranslate === 'function') {
          const translated = runtimeTranslate(key, params);
          if (typeof translated === 'string' && translated !== '') return translated;
        }
      } catch (error) {
        /* fall through to the local dictionary */
      }
      const dictionary = fallbackDictionary();
      let text = dictionary[key];
      if (text === undefined) text = zh[key];
      if (text === undefined) return key;
      if (params !== undefined && params !== null) {
        Object.keys(params).forEach((name) => {
          text = text.split('{' + name + '}').join(String(params[name]));
        });
      }
      return text;
    }

    // #endregion

    // #region pure helpers

    function asObj(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }

    function asArr(value) {
      return Array.isArray(value) ? value : [];
    }

    function str(value) {
      if (typeof value === 'string') return value;
      if (value === null || value === undefined) return '';
      try {
        return String(value);
      } catch (error) {
        return '';
      }
    }

    function normRole(value) {
      return value === 'server' || value === 'client' || value === 'off' ? value : 'off';
    }

    function isPort(value) {
      return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
    }

    function isHttpUrl(value) {
      if (typeof value !== 'string') return false;
      const text = value.trim();
      if (!/^https?:\/\//i.test(text)) return false;
      try {
        const parsed = new URL(text);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch (error) {
        return /^https?:\/\/[^\s]+$/i.test(text);
      }
    }

    function maskToken(value) {
      const text = str(value);
      if (!text) return '';
      if (text.length <= 4) return '••••';
      return '••••' + text.slice(-4);
    }

    function tailOf(value) {
      const text = str(value);
      return text ? text.slice(-4) : '----';
    }

    function errorText(error) {
      if (error === null || error === undefined) return '';
      if (typeof error === 'string') return error;
      if (typeof error.message === 'string' && error.message) return error.message;
      return str(error);
    }

    function hintOf(error) {
      return error && typeof error.hint === 'string' ? error.hint : '';
    }

    function agoText(value) {
      if (value === null || value === undefined || value === '') return t('common.unknown');
      const seconds = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(seconds) || seconds < 0) return str(value);
      if (seconds < 60) return t('time.seconds', { n: Math.round(seconds) });
      if (seconds < 3600) return t('time.minutes', { n: Math.round(seconds / 60) });
      if (seconds < 86400) return t('time.hours', { n: Math.round(seconds / 3600) });
      return t('time.days', { n: Math.round(seconds / 86400) });
    }

    /** Compact one-line summary of the wake stats object; never throws. */
    function wakeStatsText(stats) {
      try {
        const value = asObj(stats);
        const keys = Object.keys(value);
        const parts = [];
        for (let index = 0; index < keys.length && parts.length < 4; index += 1) {
          const key = keys[index];
          const item = value[key];
          if (item === null || item === undefined) continue;
          if (typeof item === 'object') continue;
          parts.push(key + ' ' + str(item));
        }
        return parts.join(' · ').slice(0, 160);
      } catch (error) {
        return '';
      }
    }

    /** Decode base64url(JSON) the way join codes encode it: JSON in UTF-8. */
    function decodeBase64UrlJson(payload) {
      if (typeof atob !== 'function') return null;
      const normalized = str(payload).replace(/-/g, '+').replace(/_/g, '/');
      const padding = (4 - (normalized.length % 4)) % 4;
      const binary = atob(normalized + '='.repeat(padding));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      let text;
      if (typeof TextDecoder === 'function') {
        text = new TextDecoder('utf-8').decode(bytes);
      } else {
        let escaped = '';
        for (let index = 0; index < binary.length; index += 1) {
          escaped += '%' + ('0' + binary.charCodeAt(index).toString(16)).slice(-2);
        }
        text = decodeURIComponent(escaped);
      }
      return JSON.parse(text);
    }

    /**
     * Parse a join code into { url, token, name } or null.
     * Tolerates both the documented short keys (u/t/n) and long ones.
     */
    function decodeJoinCode(input) {
      try {
        if (typeof input !== 'string') return null;
        const text = input.trim();
        if (!text) return null;
        if (text.slice(0, JOIN_PREFIX.length).toLowerCase() !== JOIN_PREFIX) return null;
        const payload = text.slice(JOIN_PREFIX.length).trim();
        if (!payload) return null;
        const data = decodeBase64UrlJson(payload);
        if (data === null || typeof data !== 'object') return null;
        const url = typeof data.u === 'string' ? data.u : typeof data.url === 'string' ? data.url : '';
        const token = typeof data.t === 'string' ? data.t : typeof data.token === 'string' ? data.token : '';
        const name = typeof data.n === 'string' ? data.n : typeof data.self === 'string' ? data.self : '';
        if (!isHttpUrl(url) || !token) return null;
        return { url: url.trim(), token: token.trim(), name: name.trim() };
      } catch (error) {
        return null;
      }
    }

    /**
     * Validate the local draft and build the POST /config body.
     * Returns { errors, body }; any entry in errors blocks the save.
     */
    function buildValidation(draft, joinCodeText, parsedJoin) {
      const errors = {};
      const body = { role: normRole(draft.role) };
      const self = str(draft.self).trim();
      if (self) body.self = self;

      if (body.role === 'server') {
        const portText = str(draft.port).trim();
        const port = Number(portText);
        if (!/^\d+$/.test(portText) || !isPort(port)) errors.port = t('server.port.invalid');
        else body.port = port;
        const token = str(draft.token).trim();
        if (token) body.token = token;
      } else if (body.role === 'client') {
        const joinCode = str(joinCodeText).trim();
        if (joinCode) {
          if (parsedJoin) body.joinCode = joinCode;
          else errors.joinCode = t('client.joinCode.invalid');
        } else {
          const relayUrl = str(draft.relay_url).trim();
          if (!relayUrl) errors.relayUrl = t('client.relayUrl.required');
          else if (!isHttpUrl(relayUrl)) errors.relayUrl = t('client.relayUrl.invalid');
          else body.relay_url = relayUrl;
          const token = str(draft.token).trim();
          if (token) body.token = token;
        }
      }
      return { errors: errors, body: body };
    }

    /** Header badge describing the running role, tolerant of missing state. */
    function statusOf(stateValue, stateError) {
      if (!stateValue) {
        return stateError
          ? { tone: 'err', text: t('badge.unavailable') }
          : { tone: 'neutral', text: t('common.loading') };
      }
      const role = normRole(stateValue.role);
      if (role === 'server') {
        const hub = asObj(stateValue.hub);
        if (hub.running) return { tone: 'ok', text: t('badge.server.running') };
        if (str(hub.error)) return { tone: 'err', text: t('badge.server.error') };
        return { tone: 'warn', text: t('badge.server.stopped') };
      }
      if (role === 'client') {
        const client = asObj(stateValue.client);
        if (client.reachable) return { tone: 'ok', text: t('badge.client.reachable') };
        if (str(client.error)) return { tone: 'err', text: t('badge.client.error') };
        return { tone: 'warn', text: t('badge.client.offline') };
      }
      return { tone: 'neutral', text: t('badge.off') };
    }

    /** One-line result of POST /test. */
    function testSummary(result) {
      if (!result) return '';
      if (result.ok) {
        const hubInfo = asObj(result.hub);
        const name = str(hubInfo.name);
        const version = str(hubInfo.version);
        if (name || version) return t('client.test.ok', { name: name, version: version });
        return t('client.test.okNoHub');
      }
      return t('client.test.fail', { error: str(result.error) || t('common.unknown') });
    }

    // #endregion

    // #region request layer

    function apiRequest(method, path, body) {
      const init = {
        method: method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { accept: 'application/json' },
      };
      if (method !== 'GET') {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body === undefined || body === null ? {} : body);
      }
      return fetch(API_BASE + path, init).then(
        (response) =>
          response.text().then((text) => {
            let data = null;
            if (text) {
              try {
                data = JSON.parse(text);
              } catch (error) {
                data = null;
              }
            }
            if (!response.ok) {
              const candidate = asObj(data);
              const message =
                str(candidate.error) ||
                str(candidate.message) ||
                t('error.http', { status: String(response.status) });
              const failure = new Error(message);
              if (typeof candidate.hint === 'string') failure.hint = candidate.hint;
              failure.status = response.status;
              throw failure;
            }
            if (data === null) throw new Error(t('error.badResponse'));
            return data;
          }),
        (cause) => {
          const failure = new Error(t('error.network'));
          failure.hint = errorText(cause);
          throw failure;
        }
      );
    }

    function apiGet(path) {
      return apiRequest('GET', path, undefined);
    }

    function apiPost(path, body) {
      return apiRequest('POST', path, body);
    }

    // #endregion

    // #region stylesheet (scoped to the section root; removed with the component)

    const CSS =
      '[data-lan-relay]{display:flex;flex-direction:column;gap:12px;max-width:820px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary,#1f2328)}' +
      '[data-lan-relay],[data-lan-relay] *{box-sizing:border-box}' +
      '[data-lan-relay] .lr-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}' +
      '[data-lan-relay] .lr-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}' +
      '[data-lan-relay] .lr-headline{display:flex;flex-direction:column;gap:1px;min-width:0;margin-right:auto}' +
      '[data-lan-relay] .lr-title{margin:0;font-size:15px;font-weight:600;line-height:1.3}' +
      '[data-lan-relay] .lr-sub{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary,#57606a)}' +
      '[data-lan-relay] .lr-badge{display:inline-flex;align-items:center;border:1px solid transparent;border-radius:999px;padding:1px 9px;font-size:12px;font-weight:500;white-space:nowrap;color:var(--dsw-alias-label-secondary,#57606a)}' +
      '[data-lan-relay] .lr-badge-ok{color:var(--dsw-alias-state-success-primary,#2f8f46);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2f8f46) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2f8f46) 32%,transparent)}' +
      '[data-lan-relay] .lr-badge-warn{color:var(--dsw-alias-state-warn-primary,#a15c00);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#a15c00) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#a15c00) 32%,transparent)}' +
      '[data-lan-relay] .lr-badge-err{color:var(--dsw-alias-state-error-primary,#d64545);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d64545) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d64545) 32%,transparent)}' +
      '[data-lan-relay] .lr-badge-neutral{color:var(--dsw-alias-label-secondary,#57606a);background:color-mix(in srgb,var(--dsw-alias-label-secondary,#57606a) 10%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-label-secondary,#57606a) 26%,transparent)}' +
      '[data-lan-relay] .lr-card{display:flex;flex-direction:column;gap:10px;padding:14px;border:1px solid var(--dsw-alias-border-l2,#d0d7de);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff)}' +
      '[data-lan-relay] .lr-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px}' +
      '[data-lan-relay] .lr-card-title{margin:0;font-size:13px;font-weight:600}' +
      '[data-lan-relay] .lr-field{display:flex;flex-direction:column;gap:4px;min-width:0}' +
      '[data-lan-relay] .lr-label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary,#57606a)}' +
      '[data-lan-relay] .lr-req{color:var(--dsw-alias-state-error-primary,#d64545)}' +
      '[data-lan-relay] .lr-input{width:100%;max-width:440px;padding:5px 9px;border:1px solid var(--dsw-alias-border-l2,#d0d7de);border-radius:8px;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:13px;line-height:1.5}' +
      '[data-lan-relay] .lr-input::placeholder{color:var(--dsw-alias-label-tertiary,#8b949e)}' +
      '[data-lan-relay] .lr-input:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,#4a6cf7);outline-offset:1px;border-color:transparent}' +
      '[data-lan-relay] .lr-input[aria-invalid="true"]{border-color:var(--dsw-alias-state-error-primary,#d64545)}' +
      '[data-lan-relay] .lr-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:12px}' +
      '[data-lan-relay] .lr-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2,#d0d7de);border-radius:8px;background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,#1f2328);padding:4px 12px;font:inherit;font-size:13px;line-height:1.5;white-space:nowrap;cursor:pointer}' +
      '[data-lan-relay] .lr-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}' +
      '[data-lan-relay] .lr-btn:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,#4a6cf7);outline-offset:1px}' +
      '[data-lan-relay] .lr-btn:disabled{opacity:.45;cursor:default}' +
      '[data-lan-relay] .lr-btn-sm{padding:2px 9px;font-size:12px}' +
      '[data-lan-relay] .lr-btn-primary{background:var(--dsw-alias-button-primary-fill,#4a6cf7);border-color:transparent;color:var(--dsw-alias-label-primary-inverted,#fff)}' +
      '[data-lan-relay] .lr-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-fill,#4a6cf7);filter:brightness(1.06)}' +
      '[data-lan-relay] .lr-seg{display:inline-flex;gap:2px;align-self:flex-start;padding:2px;border:1px solid var(--dsw-alias-border-l2,#d0d7de);border-radius:9px;background:var(--dsw-alias-bg-layer-2,transparent)}' +
      '[data-lan-relay] .lr-seg .lr-btn{border-color:transparent;border-radius:7px;background:transparent;padding:3px 16px}' +
      '[data-lan-relay] .lr-seg .lr-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}' +
      '[data-lan-relay] .lr-seg .lr-btn[aria-pressed="true"]{background:var(--dsw-alias-button-primary-fill,#4a6cf7);color:var(--dsw-alias-label-primary-inverted,#fff)}' +
      '[data-lan-relay] .lr-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}' +
      '[data-lan-relay] .lr-row-top{align-items:flex-start}' +
      '[data-lan-relay] .lr-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}' +
      '[data-lan-relay] .lr-hint{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary,#8b949e);word-break:break-word}' +
      '[data-lan-relay] .lr-err{margin:0;font-size:12px;color:var(--dsw-alias-state-error-primary,#d64545);word-break:break-word}' +
      '[data-lan-relay] .lr-ok{margin:0;font-size:12px;color:var(--dsw-alias-state-success-primary,#2f8f46);word-break:break-word}' +
      '[data-lan-relay] .lr-banner{display:flex;flex-direction:column;gap:2px;padding:7px 10px;border:1px solid transparent;border-radius:8px;font-size:12px;word-break:break-word}' +
      '[data-lan-relay] .lr-banner-err{color:var(--dsw-alias-state-error-primary,#d64545);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d64545) 32%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d64545) 10%,transparent)}' +
      '[data-lan-relay] .lr-banner-warn{color:var(--dsw-alias-state-warn-primary,#a15c00);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#a15c00) 32%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#a15c00) 10%,transparent)}' +
      '[data-lan-relay] .lr-banner-ok{color:var(--dsw-alias-state-success-primary,#2f8f46);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2f8f46) 32%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2f8f46) 10%,transparent)}' +
      '[data-lan-relay] .lr-code{display:block;max-width:100%;padding:3px 7px;border:1px solid var(--dsw-alias-border-l1,#e4e8ee);border-radius:6px;background:var(--dsw-alias-bg-layer-2,transparent);word-break:break-all;user-select:all;color:var(--dsw-alias-label-primary,#1f2328)}' +
      '[data-lan-relay] .lr-list{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}' +
      '[data-lan-relay] .lr-item{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l1,#e4e8ee)}' +
      '[data-lan-relay] .lr-item:first-child{padding-top:0;border-top:0}' +
      '[data-lan-relay] .lr-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary,#8b949e)}' +
      '[data-lan-relay] .lr-dot-on{background:var(--dsw-alias-state-success-primary,#2f8f46)}' +
      '[data-lan-relay] .lr-kv{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:var(--dsw-alias-label-secondary,#57606a)}' +
      '[data-lan-relay] .lr-kv b{font-weight:500;color:var(--dsw-alias-label-primary,#1f2328);word-break:break-all}' +
      '[data-lan-relay] .lr-foot{display:flex;flex-direction:column;gap:4px}' +
      '[data-lan-relay] .lr-or-row{display:flex;align-items:center;gap:8px}';

    // #endregion

    // #region presentational components

    function Badge(props) {
      return h('span', { className: 'lr-badge lr-badge-' + (props.tone || 'neutral') }, props.children);
    }

    function Card(props) {
      // React.Children.toArray assigns stable keys, so card bodies can be
      // written as child lists without per-element key bookkeeping.
      const children = React.Children.toArray(props.children);
      return h(
        'section',
        { className: 'lr-card' },
        h(
          'div',
          { className: 'lr-card-head' },
          h('h3', { className: 'lr-card-title' }, props.title),
          props.extra ? props.extra : null
        ),
        children
      );
    }

    function Field(props) {
      return h(
        'div',
        { className: 'lr-field' },
        h(
          'label',
          { className: 'lr-label', htmlFor: props.id },
          props.label,
          props.required ? h('span', { className: 'lr-req', 'aria-hidden': 'true' }, ' *') : null
        ),
        props.children,
        props.error ? h('p', { className: 'lr-err' }, props.error) : null,
        props.hint ? h('p', { className: 'lr-hint' }, props.hint) : null
      );
    }

    function TextInput(props) {
      const inputProps = {
        id: props.id,
        className: 'lr-input' + (props.mono ? ' lr-mono' : ''),
        type: props.type || 'text',
        value: props.value === undefined || props.value === null ? '' : String(props.value),
        placeholder: props.placeholder || '',
        autoComplete: 'off',
        spellCheck: false,
        'aria-invalid': props.invalid ? 'true' : 'false',
        disabled: props.disabled ? true : false,
        onChange: (event) => {
          if (typeof props.onChange === 'function') props.onChange(event.target.value);
        },
      };
      if (props.type === 'number') {
        inputProps.min = 1;
        inputProps.max = 65535;
        inputProps.inputMode = 'numeric';
      }
      return h('input', inputProps);
    }

    // #endregion

    // #region page

    function Page() {
      const [state, setState] = React.useState(null);
      const [stateError, setStateError] = React.useState(null);
      const [draft, setDraft] = React.useState({
        role: 'off',
        port: '8787',
        relay_url: '',
        token: '',
        self: '',
      });
      const [dirty, setDirty] = React.useState(false);
      const [attempted, setAttempted] = React.useState(false);
      const [clientJoinCode, setClientJoinCode] = React.useState('');
      const [tokenVisible, setTokenVisible] = React.useState(false);
      const [clientTokenVisible, setClientTokenVisible] = React.useState(false);
      const [busy, setBusy] = React.useState({});
      const [notice, setNotice] = React.useState(null);
      const [testResult, setTestResult] = React.useState(null);
      const [firewallResult, setFirewallResult] = React.useState(null);
      const [copyState, setCopyState] = React.useState(null);

      const dirtyRef = React.useRef(false);
      const mountedRef = React.useRef(true);
      const inFlightRef = React.useRef(false);
      const copyTimerRef = React.useRef(null);
      const refs = React.useRef({});

      // Track mount state so late responses never touch an unmounted tree.
      React.useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
        };
      }, []);

      // Clear the transient "copied" timer on unmount.
      React.useEffect(
        () => () => {
          if (copyTimerRef.current !== null) {
            clearTimeout(copyTimerRef.current);
            copyTimerRef.current = null;
          }
        },
        []
      );

      const syncDraft = React.useCallback((next) => {
        if (!next || typeof next !== 'object') return;
        setDraft((previous) => {
          if (dirtyRef.current) return previous;
          const hub = asObj(next.hub);
          const client = asObj(next.client);
          const port = Number(hub.port);
          return {
            role: normRole(next.role),
            port: hub.port !== undefined && hub.port !== null && Number.isFinite(port) ? String(port) : previous.port,
            relay_url: typeof client.relayUrl === 'string' ? client.relayUrl : previous.relay_url,
            token: typeof next.token === 'string' ? next.token : previous.token,
            self: typeof next.self === 'string' ? next.self : previous.self,
          };
        });
      }, []);

      const pullState = React.useCallback(async () => {
        // A slow Host probe must not pile up requests: skip while one is open.
        if (inFlightRef.current) return;
        inFlightRef.current = true;
        try {
          const next = await apiGet('/state');
          if (!mountedRef.current) return;
          setState(next);
          setStateError(null);
          syncDraft(next);
        } catch (error) {
          if (!mountedRef.current) return;
          setStateError(errorText(error) || t('error.network'));
        } finally {
          inFlightRef.current = false;
        }
      }, [syncDraft]);

      // Poll /state every 3s while the page is mounted and visible.
      React.useEffect(() => {
        pullState();
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return;
          pullState();
        }, 3000);
        const onVisibility = () => {
          if (typeof document !== 'undefined' && !document.hidden) pullState();
        };
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('visibilitychange', onVisibility);
        }
        return () => {
          clearInterval(timer);
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', onVisibility);
          }
        };
      }, [pullState]);

      // #region derived values

      const hub = asObj(state && state.hub);
      const client = asObj(state && state.client);
      const firewall = asObj(state && state.firewall);
      const viewRole = normRole(draft.role);
      const parsedJoin = React.useMemo(() => decodeJoinCode(clientJoinCode), [clientJoinCode]);
      const validation = buildValidation(draft, clientJoinCode, parsedJoin);
      const errors = validation.errors;
      const reveal = dirty || attempted;
      const shown = (key) => (reveal || key === 'relayUrl' || key === 'joinCode' ? errors[key] : undefined);
      const canSave = !busy.save && Object.keys(errors).length === 0;

      const hubRunning = !!hub.running;
      const hubError = str(hub.error);
      const clientError = str(client.error);
      const clientHint = str(client.hint);
      const reachable = !!client.reachable;
      const serverToken = str(draft.token);
      const joinCodeText = str(state && state.joinCode);
      const urls = asArr(hub.urls).filter((item) => typeof item === 'string' && item);
      const peers = asArr(client.peers).map((item) => asObj(item));
      const onlinePeers = peers.filter((peer) => !!peer.online).length;
      const wake = asObj(client.wake);
      const configPath = str(state && state.configPath);
      const status = statusOf(state, stateError);
      const fwSupported = firewall.supported !== false;
      const fwPort = Number.isFinite(Number(firewall.port)) ? Number(firewall.port) : Number(draft.port) || 8787;

      // #endregion

      // #region handlers

      const markDirty = () => {
        dirtyRef.current = true;
        setDirty(true);
      };

      const edit = (field, value) => {
        markDirty();
        setDraft((previous) => {
          const next = Object.assign({}, previous);
          next[field] = value;
          return next;
        });
      };

      const editJoinCode = (value) => {
        markDirty();
        setClientJoinCode(value);
      };

      // Role switch restores role-specific fields from the last server state,
      // so what the page shows is exactly what Save would submit.
      const selectRole = (role) => {
        markDirty();
        setDraft((previous) => {
          const next = Object.assign({}, previous, { role: role });
          if (state) {
            const hubNow = asObj(state.hub);
            const clientNow = asObj(state.client);
            if (role === 'server') {
              if (hubNow.port !== undefined && hubNow.port !== null) next.port = String(hubNow.port);
            } else if (role === 'client') {
              if (typeof clientNow.relayUrl === 'string') next.relay_url = clientNow.relayUrl;
            }
            if (role === 'server' || role === 'client') {
              if (typeof state.token === 'string') next.token = state.token;
              if (typeof state.self === 'string') next.self = state.self;
            }
          }
          return next;
        });
        setNotice(null);
        setTestResult(null);
        setFirewallResult(null);
      };

      const bind = (key) => (element) => {
        if (element) refs.current[key] = element;
        else delete refs.current[key];
      };

      const selectRefText = (key) => {
        const element = refs.current[key];
        if (!element || typeof window === 'undefined') return false;
        try {
          const selection = window.getSelection ? window.getSelection() : null;
          if (!selection) return false;
          const range = document.createRange();
          range.selectNodeContents(element);
          selection.removeAllRanges();
          selection.addRange(range);
          return true;
        } catch (error) {
          return false;
        }
      };

      const copyText = async (key, text) => {
        const value = str(text);
        if (!value) return;
        let ok = false;
        try {
          if (
            typeof navigator !== 'undefined' &&
            navigator.clipboard &&
            typeof navigator.clipboard.writeText === 'function'
          ) {
            await navigator.clipboard.writeText(value);
            ok = true;
          }
        } catch (error) {
          ok = false;
        }
        if (!ok) ok = selectRefText(key);
        if (!mountedRef.current) return;
        setCopyState({ key: key, ok: ok });
        if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => {
          copyTimerRef.current = null;
          if (mountedRef.current) setCopyState(null);
        }, 2400);
      };

      const copyLabel = (key) => {
        if (copyState && copyState.key === key) {
          return copyState.ok ? t('common.copied') : t('common.copyFailed');
        }
        return t('common.copy');
      };

      const manualRefresh = async () => {
        if (busy.refresh) return;
        setBusy((previous) => Object.assign({}, previous, { refresh: true }));
        await pullState();
        if (mountedRef.current) setBusy((previous) => Object.assign({}, previous, { refresh: false }));
      };

      const onSave = async () => {
        setAttempted(true);
        const check = buildValidation(draft, clientJoinCode, parsedJoin);
        const keys = Object.keys(check.errors);
        if (keys.length > 0) {
          setNotice({ kind: 'err', text: check.errors[keys[0]] });
          return;
        }
        if (busy.save) return;
        setBusy((previous) => Object.assign({}, previous, { save: true }));
        setNotice(null);
        try {
          const next = await apiPost('/config', check.body);
          if (!mountedRef.current) return;
          const hubNext = asObj(next.hub);
          const clientNext = asObj(next.client);
          dirtyRef.current = false;
          setDirty(false);
          setState(next);
          setStateError(null);
          setDraft({
            role: normRole(next.role),
            port: hubNext.port !== undefined && hubNext.port !== null ? String(hubNext.port) : draft.port,
            relay_url: typeof clientNext.relayUrl === 'string' ? clientNext.relayUrl : draft.relay_url,
            token: typeof next.token === 'string' ? next.token : draft.token,
            self: typeof next.self === 'string' ? next.self : draft.self,
          });
          setNotice({
            kind: 'ok',
            text: normRole(next.role) === 'off' ? t('notice.savedRoleOff') : t('notice.saved'),
          });
        } catch (error) {
          if (!mountedRef.current) return;
          setNotice({
            kind: 'err',
            text: t('error.saveFailed', { error: errorText(error) }),
            hint: hintOf(error),
          });
        } finally {
          if (mountedRef.current) setBusy((previous) => Object.assign({}, previous, { save: false }));
        }
      };

      const onRegenerate = async () => {
        if (busy.token) return;
        setBusy((previous) => Object.assign({}, previous, { token: true }));
        try {
          const next = await apiPost('/token', { regenerate: true });
          if (!mountedRef.current) return;
          setState(next);
          setStateError(null);
          const token = str(next.token);
          if (token) setDraft((previous) => Object.assign({}, previous, { token: token }));
          setTokenVisible(true);
          setNotice({ kind: 'ok', text: t('notice.tokenRegenerated') });
        } catch (error) {
          if (!mountedRef.current) return;
          setNotice({
            kind: 'err',
            text: t('error.tokenFailed', { error: errorText(error) }),
            hint: hintOf(error),
          });
        } finally {
          if (mountedRef.current) setBusy((previous) => Object.assign({}, previous, { token: false }));
        }
      };

      const onTest = async () => {
        if (busy.test) return;
        setBusy((previous) => Object.assign({}, previous, { test: true }));
        setTestResult(null);
        try {
          const raw = await apiPost('/test', {});
          if (!mountedRef.current) return;
          const result = asObj(raw);
          setTestResult({ ok: !!result.ok, hub: asObj(result.hub), error: str(result.error) });
        } catch (error) {
          if (!mountedRef.current) return;
          setTestResult({ ok: false, hub: {}, error: errorText(error) });
        } finally {
          if (mountedRef.current) setBusy((previous) => Object.assign({}, previous, { test: false }));
        }
      };

      const onFirewall = async () => {
        if (busy.firewall) return;
        setBusy((previous) => Object.assign({}, previous, { firewall: true }));
        setFirewallResult(null);
        try {
          const raw = await apiPost('/firewall', {});
          if (!mountedRef.current) return;
          const result = asObj(raw);
          const method = str(result.method) || 'failed';
          setFirewallResult({
            ok: !!result.ok,
            method: method,
            command: str(result.command),
            error: str(result.error),
          });
          if (method === 'uac') {
            setNotice({ kind: 'ok', text: t('server.firewall.uac') });
          } else if (!result.ok) {
            setNotice({
              kind: 'err',
              text: t('server.firewall.failed') + (str(result.error) ? ' ' + str(result.error) : ''),
            });
          } else {
            setNotice({ kind: 'ok', text: t('server.firewall.ok', { port: fwPort }) });
          }
        } catch (error) {
          if (!mountedRef.current) return;
          setNotice({
            kind: 'err',
            text: t('error.firewallFailed', { error: errorText(error) }),
            hint: hintOf(error),
          });
        } finally {
          if (mountedRef.current) setBusy((previous) => Object.assign({}, previous, { firewall: false }));
        }
      };

      // #endregion

      // #region live region text

      const liveParts = [];
      if (stateError) liveParts.push(t('error.hostUnavailable') + '：' + stateError);
      if (copyState) liveParts.push(copyState.ok ? t('common.copied') : t('common.copyFailed'));
      if (notice) liveParts.push(notice.text);
      if (testResult) liveParts.push(testSummary(testResult));
      const liveText = liveParts.join('；');

      // #endregion

      const roleSelector = h(
        'div',
        { className: 'lr-seg', role: 'group', 'aria-label': t('role.legend') },
        ['server', 'client', 'off'].map((value) =>
          h(
            'button',
            {
              key: value,
              type: 'button',
              className: 'lr-btn',
              'aria-pressed': viewRole === value ? 'true' : 'false',
              onClick: () => selectRole(value),
              disabled: !!busy.save,
            },
            t('role.' + value)
          )
        )
      );

      const banners = [];
      if (stateError) {
        banners.push(
          h(
            'div',
            { className: 'lr-banner lr-banner-err', key: 'banner-host' },
            h('span', null, t('error.hostUnavailable') + '：' + stateError),
            state ? h('span', { className: 'lr-hint' }, t('error.staleData')) : null
          )
        );
      }
      if (state && state.api !== undefined && state.api !== null && Number(state.api) !== 1) {
        banners.push(
          h(
            'div',
            { className: 'lr-banner lr-banner-warn', key: 'banner-api' },
            t('warn.apiMismatch', { api: str(state.api) })
          )
        );
      }
      if (notice) {
        const tone = notice.kind === 'ok' ? 'ok' : notice.kind === 'warn' ? 'warn' : 'err';
        banners.push(
          h(
            'div',
            { className: 'lr-banner lr-banner-' + tone, key: 'banner-notice' },
            h('span', null, notice.text),
            notice.hint ? h('span', { className: 'lr-hint' }, notice.hint) : null
          )
        );
      }

      const serverBlock = h(
        Card,
        {
          title: t('server.section'),
          extra: h(
            Badge,
            { tone: hubRunning ? 'ok' : hubError ? 'err' : 'warn' },
            hubRunning ? t('server.running') : hubError ? t('server.error') : t('server.stopped')
          ),
        },
        h(
          Field,
          { id: 'lr-port', label: t('server.port'), hint: t('server.port.hint'), error: shown('port'), required: true },
          h(TextInput, {
            id: 'lr-port',
            type: 'number',
            value: draft.port,
            onChange: (value) => edit('port', value),
            invalid: !!errors.port,
            disabled: !!busy.save,
            mono: true,
          })
        ),
        h(
          Field,
          { id: 'lr-self', label: t('server.self'), hint: t('server.self.hint') },
          h(TextInput, {
            id: 'lr-self',
            value: draft.self,
            onChange: (value) => edit('self', value),
            placeholder: t('server.self.placeholder'),
            disabled: !!busy.save,
          })
        ),
        h(
          'div',
          { className: 'lr-field' },
          h('span', { className: 'lr-label', id: 'lr-token-label' }, t('server.token')),
          h(
            'div',
            { className: 'lr-row' },
            h(
              'code',
              {
                ref: bind('server-token'),
                className: 'lr-code lr-mono',
                'aria-labelledby': 'lr-token-label',
              },
              serverToken ? (tokenVisible ? serverToken : maskToken(serverToken)) : t('common.none')
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'lr-btn lr-btn-sm',
                'aria-pressed': tokenVisible ? 'true' : 'false',
                onClick: () => setTokenVisible((value) => !value),
                disabled: !serverToken,
              },
              tokenVisible ? t('common.hide') : t('common.show')
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'lr-btn lr-btn-sm',
                onClick: () => copyText('server-token', serverToken),
                disabled: !serverToken,
              },
              copyLabel('server-token')
            ),
            h(
              'button',
              { type: 'button', className: 'lr-btn lr-btn-sm', onClick: onRegenerate, disabled: !!busy.token },
              busy.token ? t('server.token.regenerating') : t('server.token.regenerate')
            )
          ),
          h('p', { className: 'lr-hint' }, t('server.token.hint'))
        ),
        h(
          'div',
          { className: 'lr-field' },
          h('span', { className: 'lr-label' }, t('server.joinCode')),
          joinCodeText
            ? h(
                'div',
                { className: 'lr-row' },
                h('code', { ref: bind('join-code'), className: 'lr-code lr-mono' }, joinCodeText),
                h(
                  'button',
                  { type: 'button', className: 'lr-btn lr-btn-sm', onClick: () => copyText('join-code', joinCodeText) },
                  copyLabel('join-code')
                )
              )
            : h(
                'p',
                { className: 'lr-hint' },
                t(viewRole === 'server' ? 'server.joinCode.empty' : 'server.joinCode.needServer')
              ),
          h('p', { className: 'lr-hint' }, t('server.joinCode.hint'))
        ),
        h(
          'div',
          { className: 'lr-field' },
          h('span', { className: 'lr-label' }, t('server.addresses')),
          urls.length
            ? h(
                'ul',
                { className: 'lr-list' },
                urls.map((url, index) => {
                  const key = 'address-' + index;
                  return h(
                    'li',
                    { className: 'lr-item', key: key },
                    h('code', { ref: bind(key), className: 'lr-code lr-mono' }, url),
                    h(
                      'button',
                      { type: 'button', className: 'lr-btn lr-btn-sm', onClick: () => copyText(key, url) },
                      copyLabel(key)
                    )
                  );
                })
              )
            : h('p', { className: 'lr-hint' }, t('server.addresses.empty'))
        ),
        h(
          'div',
          { className: 'lr-kv' },
          h('span', null, t('server.state') + '：', h('b', null, hubRunning ? t('server.running') : t('server.stopped'))),
          hub.messages !== undefined && hub.messages !== null
            ? h('span', null, t('server.messages') + '：', h('b', null, str(hub.messages)))
            : null,
          hub.latestSeq !== undefined && hub.latestSeq !== null
            ? h('span', null, t('server.latestSeq') + '：', h('b', null, str(hub.latestSeq)))
            : null,
          str(hub.dataDir) ? h('span', null, t('server.dataDir') + '：', h('b', null, str(hub.dataDir))) : null
        ),
        hubError ? h('p', { className: 'lr-err' }, t('server.error') + '：' + hubError) : null,
        h(
          'div',
          { className: 'lr-field' },
          h(
            'div',
            { className: 'lr-actions' },
            h(
              'button',
              { type: 'button', className: 'lr-btn', onClick: onFirewall, disabled: !!busy.firewall },
              busy.firewall ? t('server.firewall.running') : t('server.firewall')
            ),
            h('span', { className: 'lr-hint' }, fwSupported ? t('server.firewall.hint', { port: fwPort }) : t('server.firewall.unsupported'))
          ),
          firewallResult && firewallResult.command
            ? h(
                'div',
                { className: 'lr-field' },
                h('span', { className: 'lr-label' }, t('server.firewall.command')),
                h(
                  'div',
                  { className: 'lr-row lr-row-top' },
                  h('code', { ref: bind('firewall-command'), className: 'lr-code lr-mono' }, firewallResult.command),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'lr-btn lr-btn-sm',
                      onClick: () => copyText('firewall-command', firewallResult.command),
                    },
                    copyLabel('firewall-command')
                  )
                )
              )
            : null
        )
      );

      const joinHint = parsedJoin
        ? t('client.joinCode.preview', { url: parsedJoin.url, tail: tailOf(parsedJoin.token) })
        : clientJoinCode.trim()
          ? t('client.joinCode.invalid')
          : t('client.joinCode.priority');

      const clientBlock = h(
        Card,
        {
          title: t('client.section'),
          extra: h(
            Badge,
            { tone: reachable ? 'ok' : clientError ? 'err' : 'warn' },
            reachable ? t('client.reachable') : t('client.unreachable')
          ),
        },
        h(
          Field,
          { id: 'lr-join-code', label: t('client.joinCode'), hint: joinHint, error: shown('joinCode') },
          h(TextInput, {
            id: 'lr-join-code',
            value: clientJoinCode,
            onChange: editJoinCode,
            placeholder: t('client.joinCode.placeholder'),
            invalid: !!errors.joinCode,
            disabled: !!busy.save,
            mono: true,
          })
        ),
        h('div', { className: 'lr-or-row' }, h('span', { className: 'lr-hint' }, '— ' + t('common.or') + ' —')),
        h(
          Field,
          { id: 'lr-relay-url', label: t('client.relayUrl'), error: shown('relayUrl') },
          h(TextInput, {
            id: 'lr-relay-url',
            value: draft.relay_url,
            onChange: (value) => edit('relay_url', value),
            placeholder: t('client.relayUrl.placeholder'),
            invalid: !!errors.relayUrl,
            disabled: !!busy.save || !!parsedJoin,
            mono: true,
          })
        ),
        h(
          Field,
          { id: 'lr-client-token', label: t('client.token'), hint: t('client.token.hint') },
          h(
            'div',
            { className: 'lr-row' },
            h(TextInput, {
              id: 'lr-client-token',
              value: draft.token,
              onChange: (value) => edit('token', value),
              placeholder: t('client.token.placeholder'),
              type: clientTokenVisible ? 'text' : 'password',
              disabled: !!busy.save || !!parsedJoin,
              mono: true,
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'lr-btn lr-btn-sm',
                'aria-pressed': clientTokenVisible ? 'true' : 'false',
                onClick: () => setClientTokenVisible((value) => !value),
              },
              clientTokenVisible ? t('common.hide') : t('common.show')
            )
          )
        ),
        h(
          'div',
          { className: 'lr-actions' },
          h(
            'button',
            { type: 'button', className: 'lr-btn', onClick: onTest, disabled: !!busy.test },
            busy.test ? t('client.testing') : t('client.test')
          ),
          h('span', { className: 'lr-hint' }, reachable ? t('client.reachable') : t('client.unreachable'))
        ),
        testResult ? h('p', { className: testResult.ok ? 'lr-ok' : 'lr-err' }, testSummary(testResult)) : null,
        h(
          'div',
          { className: 'lr-field' },
          h(
            'div',
            { className: 'lr-row' },
            h('span', { className: 'lr-label' }, t('client.peers')),
            peers.length
              ? h(
                  'span',
                  { className: 'lr-hint' },
                  t('client.peers.count', { online: String(onlinePeers), total: String(peers.length) })
                )
              : null
          ),
          peers.length
            ? h(
                'ul',
                { className: 'lr-list' },
                peers.map((peer, index) =>
                  h(
                    'li',
                    { className: 'lr-item', key: 'peer-' + index },
                    h('span', {
                      className: 'lr-dot' + (peer.online ? ' lr-dot-on' : ''),
                      'aria-hidden': 'true',
                    }),
                    h('code', { className: 'lr-mono' }, str(peer.name) || t('common.unknown')),
                    h('span', { className: 'lr-hint' }, peer.online ? t('client.peers.online') : t('client.peers.offline')),
                    peer.last_seen_ago !== undefined && peer.last_seen_ago !== null
                      ? h('span', { className: 'lr-hint' }, t('client.peers.seen', { ago: agoText(peer.last_seen_ago) }))
                      : null
                  )
                )
              )
            : h('p', { className: 'lr-hint' }, t('client.peers.empty'))
        ),
        h(
          'div',
          { className: 'lr-kv' },
          h('span', null, t('client.wake') + '：', h('b', null, wake.enabled ? t('client.wake.on') : t('client.wake.off'))),
          wakeStatsText(wake.stats)
            ? h('span', null, t('client.wake.stats') + '：', h('b', null, wakeStatsText(wake.stats)))
            : null
        ),
        clientError ? h('p', { className: 'lr-err' }, t('client.error') + '：' + clientError) : null,
        clientHint && !clientError ? h('p', { className: 'lr-hint' }, clientHint) : null
      );

      const offBlock = h(Card, { title: t('role.off') }, h('p', { className: 'lr-hint' }, t('role.offDesc')));

      const footer = h(
        'div',
        { className: 'lr-foot' },
        h(
          'div',
          { className: 'lr-actions' },
          h(
            'button',
            { type: 'button', className: 'lr-btn lr-btn-primary', onClick: onSave, disabled: !canSave },
            busy.save ? t('common.saving') : t('common.save')
          ),
          dirty ? h('span', { className: 'lr-hint' }, t('notice.dirty')) : null
        ),
        h('p', { className: 'lr-hint' }, t('foot.hint')),
        h('p', { className: 'lr-hint' }, t('foot.version', { version: str(state && state.version) || t('common.unknown') })),
        configPath ? h('p', { className: 'lr-hint' }, t('config.path') + '：' + configPath) : null
      );

      return h(
        'div',
        { 'data-lan-relay': '1', className: 'lr-root' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h('div', { className: 'lr-sr', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }, liveText),
        h(
          'div',
          { className: 'lr-head' },
          h(
            'div',
            { className: 'lr-headline' },
            h('h2', { className: 'lr-title' }, t('title')),
            h('span', { className: 'lr-sub' }, t('subtitle'))
          ),
          h(Badge, { tone: status.tone }, status.text),
          h(
            'button',
            { type: 'button', className: 'lr-btn lr-btn-sm', onClick: manualRefresh, disabled: !!busy.refresh },
            busy.refresh ? t('common.refreshing') : t('common.refresh')
          )
        ),
        banners,
        state === null && stateError === null ? h('p', { className: 'lr-hint' }, t('common.loading')) : null,
        h(Card, { title: t('role.legend') }, roleSelector, h('p', { className: 'lr-hint' }, t('role.hint'))),
        viewRole === 'server' ? serverBlock : null,
        viewRole === 'client' ? clientBlock : null,
        viewRole === 'off' ? offBlock : null,
        footer
      );
    }

    // #endregion

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // Dictionaries: owned by this plugin context, disposed on unload.
        try {
          ctx.effect(() => {
            const disposers = [];
            try {
              const registered = ctx.locale.register(NS, { zh: zh, en: en });
              if (typeof registered === 'function') disposers.push(registered);
            } catch (error) {
              /* locale service may already hold this namespace (hot reload); keep going */
            }
            try {
              setRuntimeTranslate(ctx.locale.bind(NS));
              disposers.push(() => setRuntimeTranslate(undefined));
            } catch (error) {
              setRuntimeTranslate(undefined);
            }
            return () => {
              for (let index = disposers.length - 1; index >= 0; index -= 1) {
                try {
                  disposers[index]();
                } catch (error) {
                  /* ignore a failing disposer */
                }
              }
            };
          }, 'dsh-lan-relay: dictionaries');
        } catch (error) {
          /* locale seat unavailable: the document-language fallback still works */
        }

        // Settings section registration, disposed when the page slot collapses.
        try {
          ctx.slots.inject('settings.section', () => {
            try {
              const unregister = ctx.slots.register(
                {
                  name: 'settings.section',
                  id: 'lan-relay',
                  order: 60,
                  label: () => t('nav'),
                  locale: NS,
                },
                Page
              );
              return () => {
                if (typeof unregister === 'function') unregister();
              };
            } catch (error) {
              return () => {};
            }
          });
        } catch (error) {
          /* slots service unavailable: nothing to render */
        }
      },
    };
  },
});
