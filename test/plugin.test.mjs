#!/usr/bin/env node
/**
 * 插件级集成测试：在假 Host 里加载 index.js（Host 半），验证
 *   - 服务端角色：进程内起 hub、自动生成 token、注册 6 个工具、/lan-relay 管理 API
 *   - 客户端角色：用加入码 / 地址+token 连接另一个 hub，状态可达
 *   - token 重新生成、角色切换、关闭角色时 hub/轮询停止
 *
 * 不依赖真实 DSH 宿主，也不需要安装 bundle。
 * 运行：node --test test/plugin.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createHub } from '../lib/hub-server.mjs';
import { encodeJoinCode } from '../lib/join-code.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-relay-plugin-'));
const CONFIG_PATH = path.join(TMP, 'config.json');
process.env.LAN_RELAY_CONFIG = CONFIG_PATH;

const { apply } = await import('../index.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function makeLogger() {
  return () => ({ info() {}, warn() {}, error() {}, debug() {} });
}

function makeHost() {
  const tools = [];
  const disposers = [];
  const ctx = {
    logger: makeLogger(),
    agents: { list: () => [] },
    get(name) {
      if (name === 'tools') return { register: (def) => { tools.push(def); return () => {}; }, schemas: () => tools };
      if (name === 'webServer') return { register: () => () => {} };
      return undefined;
    },
    inject(names, callback) {
      const child = {
        ...ctx,
        get: ctx.get,
        effect(fn) {
          const dispose = fn();
          if (typeof dispose === 'function') disposers.push(dispose);
          return dispose;
        },
      };
      for (const name of names) {
        if (name === 'webServer') child.webServer = ctx.get('webServer');
        if (name === 'tools') child.tools = ctx.get('tools');
      }
      callback(child);
      return () => {};
    },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
  };
  return { ctx, tools, disposers };
}

function makeReq({ method = 'GET', url = '/lan-relay/api/state', body = null } = {}) {
  const chunks = body === null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(chunks);
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:50181' };
  return req;
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writableEnded: false,
    setHeader(key, value) {
      this.headers[String(key).toLowerCase()] = value;
    },
    end(text) {
      this.body = text || '';
      this.writableEnded = true;
    },
  };
}

async function waitFor(fn, timeoutMs = 8000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待超时：${label}`);
}

async function callApi(plugin, { method = 'GET', path: apiPath, body = null }) {
  const req = makeReq({ method, url: `/lan-relay/api/${apiPath}`, body });
  const res = makeRes();
  await plugin.handleApi(req, res);
  let parsed = null;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    parsed = null;
  }
  return { status: res.statusCode, json: parsed };
}

async function main() {
  const port = await freePort();
  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify({ role: 'server', self: 'test-a', hub: { host: '127.0.0.1', port }, push: { enabled: true } }, null, 2),
  );

  const host = makeHost();
  apply(host.ctx);
  const plugin = host.ctx.lanRelay;
  assert.ok(plugin, 'apply 后应能拿到插件实例');

  // ---- 服务端角色：hub 起在进程内、token 自动生成
  const state = await waitFor(async () => {
    const value = await plugin.state();
    return value.role === 'server' && value.hub.running ? value : null;
  }, 8000, 'hub 启动');
  assert.equal(state.role, 'server');
  assert.equal(state.hub.port, port);
  assert.ok(state.token && state.token.length >= 16, '服务端应自动生成 token');
  assert.ok(state.joinCode.startsWith('dshrelay1.'), '服务端应给出加入码');
  assert.equal(state.client.reachable, true, '服务端自身的客户端应能连上本地 hub');

  // token 已落盘，旧 CLI/MCP 读同一份配置也能用
  const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  assert.equal(saved.token, state.token);
  assert.equal(saved.role, 'server');
  assert.equal(saved.hub.enabled, true);
  assert.equal(saved.relay_url, `http://127.0.0.1:${port}`);

  // ---- 工具都注册上了
  await waitFor(() => (host.tools.length >= 6 ? true : null), 4000, '工具注册');
  const names = host.tools.map((tool) => tool.name).sort();
  for (const expected of [
    'lan_relay_configure',
    'lan_relay_inbox',
    'lan_relay_peers',
    'lan_relay_send',
    'lan_relay_sessions',
    'lan_relay_status',
    'lan_relay_wait',
  ]) {
    assert.ok(names.includes(expected), `缺少工具 ${expected}（实际：${names.join(',')}）`);
  }

  // ---- 工具真的能跑：status 可达、send 入队、inbox 收到
  const statusTool = host.tools.find((tool) => tool.name === 'lan_relay_status');
  const statusResult = await statusTool.execute({}, {});
  assert.equal(statusResult.reachable, true);
  assert.equal(statusResult.role, 'server');

  const sendTool = host.tools.find((tool) => tool.name === 'lan_relay_send');
  const sent = await sendTool.execute({ to: 'test-b', text: 'hello from plugin test' }, {});
  assert.ok(sent.seq >= 1, 'send 应返回 seq');

  const inboxTool = host.tools.find((tool) => tool.name === 'lan_relay_inbox');
  // 发给自己可见（hub 按 to 过滤；这里用广播确认通道）
  const broadcast = await sendTool.execute({ to: '*', text: 'broadcast hello' }, {});
  assert.ok(broadcast.seq > sent.seq);
  const inbox = await inboxTool.execute({ limit: 10 }, {});
  assert.ok(Array.isArray(inbox.messages));

  // ---- 自动唤醒：hub 收到发给本机的消息 → 投递到目标会话并唤醒 agent
  const deliveries = [];
  const fakeAgent = {
    status: 'idle',
    session: { header: { id: 'session-test-1', title: 'fake session', cwd: TMP } },
    async followup(body) {
      deliveries.push(body);
    },
  };
  host.ctx.agents = { list: () => [fakeAgent] };
  const { RelayClient } = await import('../lib/relay-client.mjs');
  const sender = new RelayClient({
    relayUrl: `http://127.0.0.1:${port}`,
    token: state.token,
    self: 'test-b',
    stateDir: path.join(TMP, 'sender-state'),
  });
  await sender.send({ to: 'test-a', text: 'hello wake', toSession: 'session-test-1' });
  const delivered = await waitFor(() => (deliveries.length ? deliveries : null), 15000, '自动唤醒投递');
  const deliveredText = (delivered[0].content || []).map((block) => block.text || '').join('\n');
  assert.match(deliveredText, /hello wake/, '唤醒正文应包含原始消息');
  assert.match(deliveredText, /LAN relay/, '唤醒正文应带来源说明');
  assert.equal(delivered[0].role, 'user');
  const wakeState = await plugin.state();
  assert.ok(wakeState.client.wake.stats.delivered >= 1, '唤醒统计应 +1');

  // ---- 管理 API：GET state
  const apiState = await callApi(plugin, { path: 'state' });
  assert.equal(apiState.status, 200);
  assert.equal(apiState.json.role, 'server');
  assert.equal(apiState.json.api, 1);

  // ---- 管理 API：重新生成 token（hub 用新 token 重启）
  const regen = await callApi(plugin, { method: 'POST', path: 'token', body: { regenerate: true } });
  assert.equal(regen.status, 200);
  assert.ok(regen.json.token && regen.json.token !== state.token, 'token 应该变化');
  await waitFor(async () => {
    const value = await plugin.state();
    return value.client.reachable ? value : null;
  }, 8000, '换 token 后 hub 恢复');

  // ---- 管理 API：非法配置返回 400
  const bad = await callApi(plugin, { method: 'POST', path: 'config', body: { role: 'nope' } });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.error);

  // 坏加入码要 400（而不是静默写入坏配置）
  const badJoin = await callApi(plugin, { method: 'POST', path: 'config', body: { joinCode: 'not-a-valid-code' } });
  assert.equal(badJoin.status, 400);
  assert.ok(badJoin.json.error);

  // ---- 切换成「关闭」：hub 停止、状态为 off
  const off = await callApi(plugin, { method: 'POST', path: 'config', body: { role: 'off' } });
  assert.equal(off.status, 200);
  assert.equal(off.json.role, 'off');
  await waitFor(async () => {
    const value = await plugin.state();
    return value.hub.running === false ? value : null;
  }, 4000, 'hub 停止');
  const offState = await plugin.state();
  assert.equal(offState.role, 'off');
  assert.equal(offState.hub.running, false);

  // 停用后工具调用要给出可读提示
  const statusWhenOff = host.tools.find((tool) => tool.name === 'lan_relay_status');
  const offStatus = await statusWhenOff.execute({}, {});
  assert.equal(offStatus.role, 'off');
  const sendWhenOff = host.tools.find((tool) => tool.name === 'lan_relay_send');
  await assert.rejects(() => sendWhenOff.execute({ to: 'x', text: 'y' }, {}), /未启用/);

  // ---- 客户端角色：连另一个 hub（用加入码加入）
  const peerPort = await freePort();
  const peerHub = createHub({ host: '127.0.0.1', port: peerPort, token: 'peer-token-123456', dataDir: path.join(TMP, 'peer-hub') });
  await peerHub.start();
  try {
    const joinCode = encodeJoinCode({ url: `http://127.0.0.1:${peerPort}`, token: 'peer-token-123456', self: 'hub-owner' });
    const joined = await callApi(plugin, { method: 'POST', path: 'config', body: { role: 'client', joinCode } });
    assert.equal(joined.status, 200, JSON.stringify(joined.json));
    assert.equal(joined.json.role, 'client');
    assert.equal(joined.json.client.relayUrl, `http://127.0.0.1:${peerPort}`);
    const reachable = await waitFor(async () => {
      const value = await plugin.state();
      return value.client.reachable ? value : null;
    }, 8000, '客户端连上 peer hub');
    assert.equal(reachable.client.reachable, true);
    assert.equal(reachable.joinCode, '', '客户端不应生成加入码');

    // 客户端能发消息到 peer hub
    const send = await callApi(plugin, { method: 'POST', path: 'test' });
    assert.equal(send.status, 200);
    assert.equal(send.json.ok, true);
    assert.ok(send.json.hub, '应返回 peer hub 信息');

    // 用地址 + token 也能加入（手动填写路径）
    const manual = await callApi(plugin, {
      method: 'POST',
      path: 'config',
      body: { role: 'client', relay_url: `http://127.0.0.1:${peerPort}`, token: 'peer-token-123456', self: 'test-a' },
    });
    assert.equal(manual.status, 200, JSON.stringify(manual.json));
    assert.equal(manual.json.client.reachable, true);

    // 错误 token 应该连不上而不是崩溃
    const wrongToken = await callApi(plugin, {
      method: 'POST',
      path: 'config',
      body: { role: 'client', relay_url: `http://127.0.0.1:${peerPort}`, token: 'wrong-token' },
    });
    assert.equal(wrongToken.status, 200);
    assert.equal(wrongToken.json.client.reachable, false);
    assert.match(wrongToken.json.client.error, /token|401|拒绝/i);
  } finally {
    await peerHub.stop();
  }

  // ---- 对话式配置工具：与设置页写同一份配置
  const configureTool = host.tools.find((tool) => tool.name === 'lan_relay_configure');
  assert.ok(configureTool, '应注册 lan_relay_configure 工具');
  const configured = await configureTool.execute({ role: 'off' }, {});
  assert.equal(configured.role, 'off');
  assert.equal(configured.hub.running, false);
  assert.equal(configured.client.reachable, false);

  // ---- 卸载：hub/轮询/timer 全部停掉
  plugin.dispose();
  const disposed = await plugin.state();
  assert.equal(disposed.hub.running, false);

  console.log('✅ plugin.test.mjs 全部通过');
}

try {
  await main();
} finally {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
