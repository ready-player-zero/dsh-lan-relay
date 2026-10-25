/**
 * Hub 内核（lib/hub-server.mjs）与加入码（lib/join-code.mjs）单元测试
 *
 * 运行：node --test test/hub-core.test.mjs
 * 全部使用 os.tmpdir() 下的临时目录与临时端口，结束自动清理。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHub } from '../lib/hub-server.mjs';
import { encodeJoinCode, decodeJoinCode, JOIN_CODE_PREFIX } from '../lib/join-code.mjs';

const TOKEN = 'core-test-token-0123456789';
const AUTH = { 'x-relay-token': TOKEN };
// 注意：旧版 hub 的 /api/inbox 在省略 limit 时因 clampInt(Number(null)=0) 实际按 1 条返回，
// 这是既有线上行为，本次内核化保持不变；测试里显式传 limit 以覆盖多消息场景。
const INBOX_LIMIT = '&limit=50';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lan-relay-${prefix}-`));
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响测试结论 */
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 安静 logger：测试里不刷屏 */
const silentLogger = () => {};

function authHeaders(extra = {}) {
  return { ...AUTH, ...extra };
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, options);
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { response, body };
}

/** 建一个临时 hub；测试结束时确保关闭并清理目录 */
function makeHub(t, { dataDir, port = 0, host = '127.0.0.1', token = TOKEN } = {}) {
  const dir = dataDir || tmpDir('hub');
  const hub = createHub({ host, port, token, dataDir: dir, logger: silentLogger });
  t.after(async () => {
    try {
      await hub.stop();
    } catch {
      /* ignore */
    }
    if (!dataDir) removeDir(dir);
  });
  return { hub, dir };
}

test('createHub：启动 / status / 健康检查 / 幂等停止', async (t) => {
  const { hub, dir } = makeHub(t);

  // 构造时不应监听，也不应读盘
  const before = hub.status();
  assert.equal(before.running, false);
  assert.equal(before.messages, 0);
  assert.equal(before.latestSeq, 0);
  assert.equal(hub.server, null);

  const info = await hub.start();
  assert.equal(info.host, '127.0.0.1');
  assert.ok(Number.isInteger(info.port) && info.port > 0, `应当拿到实际监听端口，实际=${info.port}`);
  assert.equal(info.dataDir, dir);
  assert.equal(info.messages, 0);
  assert.equal(info.latestSeq, 0);
  assert.ok(Array.isArray(info.urls));
  assert.ok(hub.server, '启动后 server 应指向 http.Server');

  const status = hub.status();
  assert.equal(status.running, true);
  assert.equal(status.port, info.port);
  assert.equal(status.messages, 0);

  const { response, body } = await jsonFetch(`http://127.0.0.1:${info.port}/api/health`, { headers: AUTH });
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.hub.name.length > 0, true);
  assert.equal(body.hub.version, '0.1.0');
  assert.equal(body.hub.port, info.port);
  assert.equal(body.hub.data_dir, dir);
  assert.equal(body.latest, 0);
  assert.equal(body.message_count, 0);
  assert.ok(Array.isArray(body.peers));

  // 重复 start 幂等，返回同一监听信息
  const again = await hub.start();
  assert.equal(again.port, info.port);

  await hub.stop();
  assert.equal(hub.status().running, false);
  assert.equal(hub.server, null);

  // 重复 stop 幂等
  await hub.stop();
  assert.equal(hub.status().running, false);
});

test('鉴权与路由：无 token / 错误 token / 非 API 路径 / 未知接口 / 缺参', async (t) => {
  const { hub } = makeHub(t);
  const info = await hub.start();
  const base = `http://127.0.0.1:${info.port}`;

  const noToken = await jsonFetch(`${base}/api/health`);
  assert.equal(noToken.response.status, 401);
  assert.equal(noToken.body.ok, false);
  assert.equal(noToken.body.error, 'unauthorized');
  assert.match(String(noToken.body.hint), /x-relay-token/);

  const badToken = await jsonFetch(`${base}/api/health`, { headers: { 'x-relay-token': 'wrong-token' } });
  assert.equal(badToken.response.status, 401);

  const good = await jsonFetch(`${base}/api/health`, { headers: AUTH });
  assert.equal(good.response.status, 200);

  // 非 /api/ 路径在鉴权之前就返回 404（与旧版行为一致）
  const root = await jsonFetch(base + '/');
  assert.equal(root.response.status, 404);
  assert.equal(root.body.error, 'not found');

  const unknownApi = await jsonFetch(`${base}/api/nope`, { headers: AUTH });
  assert.equal(unknownApi.response.status, 404);
  assert.match(String(unknownApi.body.error), /未知接口/);

  const noPeer = await jsonFetch(`${base}/api/inbox`, { headers: AUTH });
  assert.equal(noPeer.response.status, 400);
  assert.match(String(noPeer.body.error), /peer/);

  // x-relay-peer 上报在线状态
  const peers = await jsonFetch(`${base}/api/peers`, { headers: authHeaders({ 'x-relay-peer': 'PC1' }) });
  assert.equal(peers.response.status, 200);
  assert.equal(peers.body.online_window_seconds, 120);
  const self = peers.body.peers.find((item) => item.name === 'pc1');
  assert.ok(self, '请求头 x-relay-peer 应被记录');
  assert.equal(self.online, true);
  assert.equal(self.last_seen_seconds, 0);
});

test('消息：send -> inbox 游标 / 广播 / 字段结构 / 写盘', async (t) => {
  const { hub, dir } = makeHub(t);
  const info = await hub.start();
  const base = `http://127.0.0.1:${info.port}`;

  const sent = await jsonFetch(`${base}/api/send`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      from: 'a', to: 'b', text: 'hello b', thread: 'demo', from_session: 'sess-a', to_session: 'sess-b',
    }),
  });
  assert.equal(sent.response.status, 200);
  assert.equal(sent.body.ok, true);
  assert.equal(sent.body.message.seq, 1);
  assert.equal(sent.body.message.from, 'a');
  assert.equal(sent.body.message.to, 'b');
  assert.equal(sent.body.message.text, 'hello b');
  assert.equal(sent.body.message.thread, 'demo');
  assert.equal(sent.body.message.from_session, 'sess-a');
  assert.equal(sent.body.message.to_session, 'sess-b');
  assert.ok(typeof sent.body.message.ts === 'number' && sent.body.message.ts > 0, '消息时间戳字段保持 ts');
  assert.equal(sent.body.latest, 1);

  // 发送方自己不收
  const aInbox = await jsonFetch(`${base}/api/inbox?peer=a&since=0${INBOX_LIMIT}`, { headers: AUTH });
  assert.equal(aInbox.body.messages.length, 0);

  // 接收方按游标收
  const bInbox = await jsonFetch(`${base}/api/inbox?peer=b&since=0${INBOX_LIMIT}`, { headers: AUTH });
  assert.equal(bInbox.body.latest, 1);
  assert.deepEqual(bInbox.body.messages.map((m) => m.text), ['hello b']);

  const bSince = await jsonFetch(`${base}/api/inbox?peer=b&since=1${INBOX_LIMIT}`, { headers: AUTH });
  assert.equal(bSince.body.messages.length, 0, '游标之后没有新消息');

  // 广播：* 发给除自己以外的所有 peer
  const bcast = await jsonFetch(`${base}/api/send`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ from: 'a', to: '*', text: 'broadcast' }),
  });
  assert.equal(bcast.response.status, 200);
  assert.equal(bcast.body.message.seq, 2);

  const bAfter = await jsonFetch(`${base}/api/inbox?peer=b&since=1${INBOX_LIMIT}`, { headers: AUTH });
  assert.deepEqual(bAfter.body.messages.map((m) => m.text), ['broadcast']);
  const cAfter = await jsonFetch(`${base}/api/inbox?peer=c&since=0${INBOX_LIMIT}`, { headers: AUTH });
  assert.deepEqual(cAfter.body.messages.map((m) => m.text), ['broadcast']);
  const aAfter = await jsonFetch(`${base}/api/inbox?peer=a&since=0${INBOX_LIMIT}`, { headers: AUTH });
  assert.equal(aAfter.body.messages.length, 0);

  // 参数校验与原版一致
  const emptyText = await jsonFetch(`${base}/api/send`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ from: 'a', to: 'b', text: '   ' }),
  });
  assert.equal(emptyText.response.status, 400);
  assert.match(String(emptyText.body.error), /内容为空/);

  const badTo = await jsonFetch(`${base}/api/send`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ from: 'a', to: 'bad peer!', text: 'x' }),
  });
  assert.equal(badTo.response.status, 400);
  assert.match(String(badTo.body.error), /收件人/);

  const tooLong = await jsonFetch(`${base}/api/send`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ from: 'a', to: 'b', text: 'x'.repeat(32001) }),
  });
  assert.equal(tooLong.response.status, 400);

  // messages.jsonl 追加落盘
  const lines = fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const last = JSON.parse(lines[1]);
  assert.equal(last.seq, 2);
  assert.equal(last.text, 'broadcast');
});

test('长轮询 wait：消息到达即返回 / 超时返回空 / stop 时结束等待', async (t) => {
  const { hub } = makeHub(t);
  const info = await hub.start();
  const base = `http://127.0.0.1:${info.port}`;

  // 已有消息时立即返回
  await jsonFetch(`${base}/api/send`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ from: 'a', to: 'b', text: 'already here' }),
  });
  const immediate = await jsonFetch(`${base}/api/wait?peer=b&since=0&timeout=5`, { headers: AUTH });
  assert.equal(immediate.response.status, 200);
  assert.equal(immediate.body.timed_out, false);
  assert.deepEqual(immediate.body.messages.map((m) => m.text), ['already here']);

  // 挂起后发消息，wait 被唤醒
  const pending = jsonFetch(`${base}/api/wait?peer=b&since=1&timeout=10`, { headers: AUTH });
  await sleep(150);
  const wakeSend = await jsonFetch(`${base}/api/send`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ from: 'a', to: 'b', text: 'wake up' }),
  });
  assert.equal(wakeSend.response.status, 200);
  const woken = await pending;
  assert.equal(woken.response.status, 200);
  assert.equal(woken.body.timed_out, false);
  assert.deepEqual(woken.body.messages.map((m) => m.text), ['wake up']);

  // 超时返回空数组
  const startAt = Date.now();
  const timedOut = await jsonFetch(`${base}/api/wait?peer=b&since=999&timeout=1`, { headers: AUTH });
  const elapsed = Date.now() - startAt;
  assert.equal(timedOut.response.status, 200);
  assert.equal(timedOut.body.timed_out, true);
  assert.deepEqual(timedOut.body.messages, []);
  assert.ok(elapsed >= 900, `超时应等待约 1s，实际 ${elapsed}ms`);

  // stop 应立即结束所有挂起的 waiter
  const hanging = jsonFetch(`${base}/api/wait?peer=b&since=999&timeout=30`, { headers: AUTH });
  await sleep(150);
  await hub.stop();
  const ended = await hanging;
  assert.equal(ended.response.status, 200);
  assert.equal(ended.body.timed_out, true);
  assert.deepEqual(ended.body.messages, []);
  assert.equal(hub.status().running, false);
});

test('持久化：落盘后新实例能读历史，损坏行被跳过，seq 继续递增', async (t) => {
  const dir = tmpDir('hub-persist');
  t.after(() => removeDir(dir));

  const hub1 = createHub({ host: '127.0.0.1', port: 0, token: TOKEN, dataDir: dir, logger: silentLogger });
  t.after(() => hub1.stop().catch(() => {}));
  const info1 = await hub1.start();
  const base1 = `http://127.0.0.1:${info1.port}`;
  for (const text of ['first', 'second']) {
    const sent = await jsonFetch(`${base1}/api/send`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ from: 'a', to: 'b', text }),
    });
    assert.equal(sent.response.status, 200);
  }
  await hub1.stop();

  // 人为塞一行损坏数据，模拟写日志中断
  fs.appendFileSync(path.join(dir, 'messages.jsonl'), '{broken json\n');
  assert.ok(fs.statSync(path.join(dir, 'messages.jsonl')).size > 0);

  // 新实例：构造时不读盘，start 时加载
  const hub2 = createHub({ host: '127.0.0.1', port: 0, token: TOKEN, dataDir: dir, logger: silentLogger });
  t.after(() => hub2.stop().catch(() => {}));
  assert.equal(hub2.status().messages, 0);
  const info2 = await hub2.start();
  assert.equal(info2.messages, 2, '应加载 2 条有效历史消息');
  assert.equal(info2.latestSeq, 2);

  const base2 = `http://127.0.0.1:${info2.port}`;
  const inbox = await jsonFetch(`${base2}/api/inbox?peer=b&since=0${INBOX_LIMIT}`, { headers: AUTH });
  assert.deepEqual(inbox.body.messages.map((m) => m.text), ['first', 'second']);

  const third = await jsonFetch(`${base2}/api/send`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ from: 'a', to: 'b', text: 'third' }),
  });
  assert.equal(third.body.message.seq, 3, '重启后 seq 继续递增');
  assert.equal(hub2.status().latestSeq, 3);
});

test('端口占用：start() reject 且保留 EADDRINUSE，并可在释放后重新启动', async (t) => {
  const dir = tmpDir('hub-inuse');
  t.after(() => removeDir(dir));

  const holder = net.createServer();
  await new Promise((resolve, reject) => {
    holder.once('error', reject);
    holder.listen(0, '127.0.0.1', resolve);
  });
  const takenPort = holder.address().port;

  const hub = createHub({ host: '127.0.0.1', port: takenPort, token: TOKEN, dataDir: dir, logger: silentLogger });
  t.after(() => hub.stop().catch(() => {}));

  await assert.rejects(hub.start(), (error) => {
    assert.equal(error.code, 'EADDRINUSE', `应保留 err.code，实际=${error.code}`);
    return true;
  });
  assert.equal(hub.status().running, false);
  assert.equal(hub.server, null);
  await hub.stop(); // 失败后 stop 也应安全

  // 释放端口后，同一个实例应能重新启动（不留半开 server）
  await new Promise((resolve) => holder.close(() => resolve()));
  const info = await hub.start();
  assert.equal(info.port, takenPort);
  assert.equal(hub.status().running, true);
  const health = await jsonFetch(`http://127.0.0.1:${info.port}/api/health`, { headers: AUTH });
  assert.equal(health.response.status, 200);
  await hub.stop();
  assert.equal(hub.status().running, false);
});

test('加入码：往返编解码与非法输入', () => {
  // 基本往返
  const code = encodeJoinCode({ url: 'http://192.168.0.105:8787', token: 'tok-123456' });
  assert.ok(code.startsWith(JOIN_CODE_PREFIX));
  assert.deepEqual(decodeJoinCode(code), {
    url: 'http://192.168.0.105:8787',
    token: 'tok-123456',
    self: '',
  });

  // 带 self（大写会被规范化为小写）
  const withSelf = encodeJoinCode({ url: 'http://192.168.0.105:8787', token: 'tok-123456', self: 'PC-01' });
  assert.deepEqual(decodeJoinCode(withSelf), {
    url: 'http://192.168.0.105:8787',
    token: 'tok-123456',
    self: 'pc-01',
  });

  // 地址规范化：去尾部斜杠、保留路径、支持 https；首尾空白容忍
  assert.equal(
    decodeJoinCode(encodeJoinCode({ url: 'http://192.168.0.105:8787/', token: 't' })).url,
    'http://192.168.0.105:8787',
  );
  assert.equal(
    decodeJoinCode(encodeJoinCode({ url: 'https://relay.example.com:9443/base/', token: 't' })).url,
    'https://relay.example.com:9443/base',
  );
  const messy = encodeJoinCode({ url: 'http://192.168.0.105:8787', token: 'tok' });
  assert.equal(decodeJoinCode(`  ${messy}\n`).token, 'tok');

  // 编码侧校验
  assert.throws(() => encodeJoinCode({ token: 't' }), /需要中继地址/);
  assert.throws(() => encodeJoinCode({ url: 'http://h:1' }), /需要 token/);
  assert.throws(() => encodeJoinCode({ url: 'not-a-url', token: 't' }), /不是合法 URL/);
  assert.throws(() => encodeJoinCode({ url: 'ftp://h:1', token: 't' }), /http\/https/);
  assert.throws(() => encodeJoinCode({ url: 'http://h:1', token: 't', self: 'bad name!' }), /本机名不合法/);

  // 解码侧校验：格式
  assert.throws(() => decodeJoinCode(''), /加入码格式不对/);
  assert.throws(() => decodeJoinCode('hello'), /加入码格式不对/);
  assert.throws(() => decodeJoinCode('dshrelay2.abc'), /加入码格式不对/);
  assert.throws(() => decodeJoinCode(JOIN_CODE_PREFIX), /加入码格式不对/);
  assert.throws(() => decodeJoinCode(`${JOIN_CODE_PREFIX}!!!`), /加入码格式不对/);

  const b64 = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

  // 解码侧校验：内容
  assert.throws(() => decodeJoinCode(`${JOIN_CODE_PREFIX}${b64('just-a-string')}`), /加入码格式不对|无法解析/);
  assert.throws(
    () => decodeJoinCode(`${JOIN_CODE_PREFIX}${Buffer.from('not json', 'utf8').toString('base64url')}`),
    /加入码内容无法解析/,
  );
  assert.throws(() => decodeJoinCode(`${JOIN_CODE_PREFIX}${b64({ t: 'tok' })}`), /加入码里没有地址/);
  assert.throws(() => decodeJoinCode(`${JOIN_CODE_PREFIX}${b64({ u: 'http://h:1' })}`), /加入码里没有 token/);
  assert.throws(() => decodeJoinCode(`${JOIN_CODE_PREFIX}${b64({ u: '192.168.0.1:8787', t: 'tok' })}`), /地址不合法/);
  assert.throws(() => decodeJoinCode(`${JOIN_CODE_PREFIX}${b64({ u: 'ftp://h:1', t: 'tok' })}`), /http\/https/);
  assert.throws(() => decodeJoinCode(`${JOIN_CODE_PREFIX}${b64({ u: 'http://h:1', t: 'tok', n: 'bad name!' })}`), /本机名不合法/);
});
