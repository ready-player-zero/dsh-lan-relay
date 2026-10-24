import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RelayHttp,
  RelayRuntime,
  formatIncoming,
  selectTarget,
  describeAgent,
  readCursor,
  writeCursor,
} from '../lib/core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HUB = path.join(ROOT, 'hub.mjs');
const TOKEN = 'push-test-token';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lan-push-test-'));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function makeAgent(id, { status = 'idle', title = '' } = {}) {
  const calls = [];
  return {
    id: undefined,
    status,
    calls,
    session: {
      header: { id, title, cwd: 'C:/work', updatedAt: Date.now() },
      snapshotEvents: () => [],
    },
    followup(message) {
      calls.push({ method: 'followup', message });
    },
    inject(message) {
      calls.push({ method: 'inject', message });
    },
  };
}

function makeCtx(agents, extras = {}) {
  const disposers = [];
  return {
    disposers,
    agents: {
      list: () => agents,
      get: (id) => agents.find((agent) => describeAgent(agent).id === id) ?? null,
    },
    get: (name) => extras[name] ?? null,
    effect: (fn) => {
      const disposer = fn();
      if (typeof disposer === 'function') disposers.push(disposer);
      return () => {};
    },
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
  };
}

function makeRuntime({ agents, stateDir, port, push = {}, toolsService = null, defineTool = null, extras = {} }) {
  const ctx = makeCtx(agents, extras);
  const config = {
    relayUrl: `http://127.0.0.1:${port}`,
    token: TOKEN,
    self: 'pc1',
    stateDir,
    push: {
      enabled: push.enabled !== false,
      default_session: push.default_session || '',
      wake: push.wake !== false,
      poll_timeout_seconds: push.poll_timeout_seconds || 5,
      offline_fallback: push.offline_fallback === true,
      require_session: push.require_session === true,
      cold_session: push.cold_session === 'drop' ? 'drop' : 'prompt',
    },
  };
  const runtime = new RelayRuntime({ ctx, defineTool, log: () => {}, config, toolsService });
  return { runtime, ctx, config };
}

function fakeSessionController(calls) {
  return {
    async prompt(request, signal) {
      if (!signal || typeof signal.throwIfAborted !== 'function') throw new Error('missing AbortSignal');
      calls.push(request);
      return { accepted: true };
    },
  };
}

test('formatIncoming 带来源 peer/session 与回复提示', () => {
  const text = formatIncoming(
    { seq: 7, from: 'pc2', from_session: 'session-aaa', text: '帮我看看日志', thread: 'ops', ts: 1700000000000 },
    { self: 'pc1' },
  );
  assert.match(text, /peer="pc2"/);
  assert.match(text, /session-aaa/);
  assert.match(text, /帮我看看日志/);
  assert.match(text, /lan_relay_send\(to="pc2", to_session="session-aaa"/);
  assert.match(text, /本机 peer=pc1/);
});

test('selectTarget：精确命中 / 目标不在线默认不投递 / 默认会话 / require_session', () => {
  const a = makeAgent('session-a', { title: 'A' });
  const b = makeAgent('session-b', { title: 'B' });
  const agents = [a, b];

  const exact = selectTarget(agents, { to_session: 'session-b' }, { push: {} });
  assert.equal(describeAgent(exact.agent).id, 'session-b');
  assert.equal(exact.note, '');

  // 目标不在线 → 标记为可冷启动，不直接丢弃
  const missing = selectTarget(agents, { to_session: 'session-nope' }, { push: {} });
  assert.equal(missing.agent, null);
  assert.equal(missing.cold, true);
  assert.match(missing.note, /不在线/);

  // 显式开启 offline_fallback 只影响 dispatch 的兜底路径，selectTarget 仍是 cold
  const fallback = selectTarget(agents, { to_session: 'session-nope' }, { push: { offline_fallback: true } });
  assert.equal(fallback.agent, null);
  assert.equal(fallback.cold, true);

  // 无 to_session：默认会话（在线的才用）
  const toDefault = selectTarget(agents, {}, { push: { default_session: 'session-a' } });
  assert.equal(describeAgent(toDefault.agent).id, 'session-a');
  assert.match(toDefault.note, /默认会话/);

  // 无 to_session：没有默认会话 → 最近活跃
  const plain = selectTarget(agents, {}, { push: {} });
  assert.ok(plain.agent);
});

test('selectTarget：require_session=true 时无 to_session 直接拒收', () => {
  const agents = [makeAgent('session-a')];
  const result = selectTarget(agents, {}, { push: { require_session: true, default_session: 'session-a' } });
  assert.equal(result.agent, null);
  assert.match(result.note, /require_session/);
});

test('describeAgent 兼容 header.id / session.id / agent.id', () => {
  assert.equal(describeAgent({ session: { header: { id: 'session-h' } } }).id, 'session-h');
  assert.equal(describeAgent({ session: { id: 'session-s' } }).id, 'session-s');
  assert.equal(describeAgent({ id: 'session-a' }).id, 'session-a');
});

test('installTools 注册 3 个工具，relay_send 自动带 from_session', async () => {
  const registered = [];
  const toolsService = { register: (definition) => { registered.push(definition); return () => {}; } };
  const agents = [makeAgent('session-sender')];
  const { runtime } = makeRuntime({
    agents,
    stateDir: tmpDir(),
    port: 1,
    toolsService,
    defineTool: (definition) => definition,
  });
  runtime.installTools();
  assert.deepEqual(registered.map((d) => d.name).sort(), ['lan_relay_send', 'lan_relay_sessions', 'lan_relay_status']);

  const send = registered.find((d) => d.name === 'lan_relay_send');
  let captured = null;
  runtime.http.send = async (payload) => {
    captured = payload;
    return { message: { seq: 3, from: 'pc1', to: payload.to, to_session: payload.toSession, ts: Date.now() } };
  };
  const value = await send.execute(
    { to: 'pc2', text: 'ping', to_session: 'session-remote' },
    { agent: agents[0], signal: { aborted: false, throwIfAborted() {} } },
  );
  assert.equal(value.ok, true);
  assert.equal(value.from_session, 'session-sender');
  assert.equal(captured.fromSession, 'session-sender');
  assert.equal(captured.toSession, 'session-remote');
});

test('dispatch：投递到精确会话，消息形状符合 V4（id/role/source）', async () => {
  const target = makeAgent('session-target');
  const other = makeAgent('session-other');
  const { runtime } = makeRuntime({ agents: [target, other], stateDir: tmpDir(), port: 1 });
  await runtime.dispatch({
    seq: 1,
    from: 'pc2',
    from_session: 'session-remote',
    to: 'pc1',
    to_session: 'session-target',
    text: 'hello',
    ts: Date.now(),
  });
  assert.equal(target.calls.length, 1);
  assert.equal(other.calls.length, 0);
  const { method, message } = target.calls[0];
  assert.equal(method, 'followup');
  assert.equal(message.role, 'user');
  assert.equal(typeof message.id, 'string');
  assert.equal(message.source.kind, 'user');
  assert.equal(message.content[0].type, 'text');
  assert.match(message.content[0].text, /hello/);
  assert.equal(runtime.stats.delivered, 1);
});

test('dispatch：目标会话不在线 → 冷启动投递（sessionController.prompt）', async () => {
  const calls = [];
  const { runtime } = makeRuntime({
    agents: [makeAgent('session-open')],
    stateDir: tmpDir(),
    port: 1,
    extras: { sessionController: fakeSessionController(calls) },
  });
  await runtime.dispatch({
    seq: 2,
    from: 'pc2',
    from_session: 'session-remote',
    to: 'pc1',
    to_session: 'session-d493e600-xxxx',
    text: 'ComfyUI 交接任务',
    ts: Date.now(),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, 'session-d493e600-xxxx');
  assert.equal(calls[0].mode, 'queue');
  assert.equal(typeof calls[0].requestId, 'string');
  assert.match(calls[0].content[0].text, /ComfyUI 交接任务/);
  assert.equal(runtime.stats.delivered, 1);
  assert.equal(runtime.stats.cold, 1);
});

test('dispatch：冷启动不可用时不误投其它会话', async () => {
  const fallback = makeAgent('session-default');
  const { runtime } = makeRuntime({
    agents: [fallback],
    stateDir: tmpDir(),
    port: 1,
    push: { default_session: 'session-default' },
  });
  await runtime.dispatch({ seq: 2, from: 'pc2', to: 'pc1', to_session: 'session-gone', text: 'x', ts: Date.now() });
  assert.equal(fallback.calls.length, 0);
  assert.equal(runtime.stats.skipped, 1);
  assert.match(runtime.stats.last_error, /不在线/);
});

test('dispatch：cold_session=drop 时不冷启动；offline_fallback=true 才改投并加 [注意]', async () => {
  const calls = [];
  const fallback = makeAgent('session-default');
  const { runtime } = makeRuntime({
    agents: [fallback],
    stateDir: tmpDir(),
    port: 1,
    push: { default_session: 'session-default', offline_fallback: true, cold_session: 'drop' },
    extras: { sessionController: fakeSessionController(calls) },
  });
  await runtime.dispatch({ seq: 2, from: 'pc2', to: 'pc1', to_session: 'session-gone', text: 'x', ts: Date.now() });
  assert.equal(calls.length, 0);
  assert.equal(fallback.calls.length, 1);
  assert.match(fallback.calls[0].message.content[0].text, /\[注意\]/);
});

test('dispatch：无 to_session 且 require_session=true 时拒收', async () => {
  const agent = makeAgent('session-a');
  const { runtime } = makeRuntime({
    agents: [agent],
    stateDir: tmpDir(),
    port: 1,
    push: { default_session: 'session-a', require_session: true },
  });
  await runtime.dispatch({ seq: 4, from: 'pc2', to: 'pc1', text: 'x', ts: Date.now() });
  assert.equal(agent.calls.length, 0);
  assert.equal(runtime.stats.skipped, 1);
  assert.match(runtime.stats.last_error, /require_session/);
});

test('dispatch：没有活跃会话时记录失败而不抛错', async () => {
  const { runtime } = makeRuntime({ agents: [], stateDir: tmpDir(), port: 1 });
  await runtime.dispatch({ seq: 3, from: 'pc2', to: 'pc1', text: 'x', ts: Date.now() });
  assert.equal(runtime.stats.skipped, 1);
  assert.match(runtime.stats.last_error, /没有活跃会话/);
});

test('游标读写', () => {
  const dir = tmpDir();
  assert.equal(readCursor(dir, 'pc1'), 0);
  writeCursor(dir, 'pc1', 42);
  assert.equal(readCursor(dir, 'pc1'), 42);
});

test('端到端：真实 hub + 长轮询自动唤醒指定会话', async () => {
  const port = await freePort();
  const hubData = tmpDir();
  const hub = spawn(process.execPath, [HUB, '--port', String(port), '--host', '127.0.0.1', '--token', TOKEN, '--data', hubData], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  try {
    let ready = false;
    for (let i = 0; i < 100 && !ready; i += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { 'x-relay-token': TOKEN } });
        ready = response.ok;
      } catch {
        await sleep(100);
      }
    }
    assert.equal(ready, true, 'hub 未就绪');

    const target = makeAgent('session-target');
    const other = makeAgent('session-other');
    const { runtime, ctx } = makeRuntime({
      agents: [target, other],
      stateDir: tmpDir(),
      port,
      push: { poll_timeout_seconds: 3 },
    });
    runtime.start();
    await sleep(300);

    const sender = new RelayHttp({ relayUrl: `http://127.0.0.1:${port}`, token: TOKEN, self: 'pc2' });
    await sender.send({ to: 'pc1', text: '自动唤醒测试', toSession: 'session-target', fromSession: 'session-remote' });

    for (let i = 0; i < 100 && target.calls.length === 0; i += 1) await sleep(100);
    assert.equal(target.calls.length, 1, `未收到消息，当前统计：${JSON.stringify(runtime.stats)}`);
    assert.equal(other.calls.length, 0);
    assert.match(target.calls[0].message.content[0].text, /自动唤醒测试/);
    assert.match(target.calls[0].message.content[0].text, /session-remote/);

    // 不该重复投递
    await sleep(500);
    assert.equal(target.calls.length, 1);

    for (const disposer of ctx.disposers) disposer();
  } finally {
    hub.kill();
  }
});
