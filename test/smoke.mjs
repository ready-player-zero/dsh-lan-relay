#!/usr/bin/env node
/**
 * 端到端冒烟测试（零依赖，直接 node test/smoke.mjs）
 *
 * 覆盖：hub 启动/健康检查 → MCP 握手与工具列表 → 点对点发送 →
 *       长轮询 → 游标去重 → 广播 → 离线补投 → hub 重启持久化 →
 *       token 鉴权失败 → 参数校验错误。
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HUB = path.join(ROOT, 'hub.mjs');
const MCP = path.join(ROOT, 'mcp-server.mjs');
const TOKEN = 'test-token-0123456789';

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
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

class McpClient {
  constructor(name, env) {
    this.name = name;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderr = '';
    this.child = spawn(process.execPath, [MCP], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk;
    });
    this.child.on('exit', (code) => {
      for (const [, entry] of this.pending) {
        entry.reject(new Error(`MCP ${this.name} 提前退出 code=${code}: ${this.stderr.slice(-400)}`));
      }
      this.pending.clear();
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        throw new Error(`MCP ${this.name} 返回非 JSON：${line.slice(0, 200)}`);
      }
      const entry = this.pending.get(message.id);
      if (entry) {
        this.pending.delete(message.id);
        entry.resolve(message);
      }
    }
  }

  rpc(method, params = {}) {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${this.name} 请求超时：${method}`));
      }, 20000);
      this.pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  async initialize() {
    const response = await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke-test', version: '1.0.0' },
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    return response;
  }

  async callTool(name, args = {}) {
    const response = await this.rpc('tools/call', { name, arguments: args });
    const result = response.result;
    const text = result?.content?.[0]?.text ?? '';
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
    return { result, payload, isError: Boolean(result?.isError) };
  }

  kill() {
    try {
      this.child.kill();
    } catch {
      /* ignore */
    }
  }
}

function startHub(port, dataDir) {
  const child = spawn(process.execPath, [HUB, '--port', String(port), '--host', '127.0.0.1', '--token', TOKEN, '--data', dataDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  return {
    child,
    getStderr: () => stderr,
    async waitReady() {
      for (let i = 0; i < 100; i += 1) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
            headers: { 'x-relay-token': TOKEN },
          });
          if (response.ok) return;
        } catch {
          /* not ready */
        }
        await sleep(100);
      }
      throw new Error(`hub 启动失败：${stderr.slice(-800)}`);
    },
    kill() {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    },
  };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-relay-test-'));
  const hubData = path.join(tmp, 'hub-data');
  const stateA = path.join(tmp, 'state-a');
  const stateB = path.join(tmp, 'state-b');
  const missingConfig = path.join(tmp, 'no-config.json');
  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}`;

  const envFor = (self, state) => ({
    LAN_RELAY_CONFIG: missingConfig,
    LAN_RELAY_URL: url,
    LAN_RELAY_TOKEN: TOKEN,
    LAN_RELAY_SELF: self,
    LAN_RELAY_STATE: state,
  });

  let hub = startHub(port, hubData);
  let a = null;
  let b = null;
  let c = null;

  try {
    console.log(`\n▶ 1. hub 启动与鉴权（${url}）`);
    await hub.waitReady();
    check('hub /api/health 可访问', true);
    const noToken = await fetch(`${url}/api/health`);
    check('无 token 请求被拒绝（401）', noToken.status === 401, `实际 ${noToken.status}`);
    const badToken = await fetch(`${url}/api/health`, { headers: { 'x-relay-token': 'wrong' } });
    check('错误 token 被拒绝（401）', badToken.status === 401, `实际 ${badToken.status}`);

    console.log('\n▶ 2. MCP 握手与工具清单');
    a = new McpClient('a', envFor('a', stateA));
    b = new McpClient('b', envFor('b', stateB));
    const initA = await a.initialize();
    check('initialize 返回协议版本', typeof initA.result?.protocolVersion === 'string', JSON.stringify(initA.result?.protocolVersion));
    check('serverInfo 名称正确', initA.result?.serverInfo?.name === 'dsh-lan-relay', JSON.stringify(initA.result?.serverInfo));
    await b.initialize();

    const tools = await a.rpc('tools/list');
    const names = (tools.result?.tools || []).map((tool) => tool.name).sort();
    const expected = ['relay_inbox', 'relay_peers', 'relay_send', 'relay_status', 'relay_wait'];
    check('tools/list 暴露 5 个工具', JSON.stringify(names) === JSON.stringify(expected), JSON.stringify(names));
    check('每个工具都有 inputSchema', (tools.result?.tools || []).every((tool) => tool.inputSchema?.type === 'object'));

    console.log('\n▶ 3. 状态与在线列表');
    const statusA = await a.callTool('relay_status');
    check('relay_status 连通 hub', statusA.payload?.reachable === true, JSON.stringify(statusA.payload));
    check('relay_status 报告 self=a', statusA.payload?.self === 'a');
    const peersA = await a.callTool('relay_peers');
    const peerNames = (peersA.payload?.peers || []).map((peer) => peer.name);
    check('relay_peers 能看到自己', peerNames.includes('a'), JSON.stringify(peerNames));

    console.log('\n▶ 4. 点对点发送 + 长轮询接收');
    const sent = await a.callTool('relay_send', { to: 'b', text: 'hello from a', thread: 'demo' });
    check('relay_send 成功且返回 seq', sent.isError === false && Number.isInteger(sent.payload?.seq), JSON.stringify(sent.payload));
    const waited = await b.callTool('relay_wait', { timeout_seconds: 5 });
    check('relay_wait 收到 1 条消息', waited.payload?.count === 1, JSON.stringify(waited.payload));
    check('消息内容正确', waited.payload?.messages?.[0]?.text === 'hello from a');
    check('消息带 thread 与 age_seconds', waited.payload?.messages?.[0]?.thread === 'demo' && typeof waited.payload?.messages?.[0]?.age_seconds === 'number');
    check('relay_wait 未标记超时', waited.payload?.timed_out === false);

    console.log('\n▶ 5. 游标去重');
    const bInbox = await b.callTool('relay_inbox', {});
    check('b 再取 inbox 不重复返回', bInbox.payload?.count === 0, JSON.stringify(bInbox.payload));
    const aInbox = await a.callTool('relay_inbox', {});
    check('a 不会收到自己发的消息', aInbox.payload?.count === 0);

    console.log('\n▶ 6. 广播与 from_seq 重读');
    const bcast = await a.callTool('relay_send', { to: '*', text: 'broadcast to all' });
    check('广播发送成功', bcast.isError === false, JSON.stringify(bcast.payload));
    const bAfterBcast = await b.callTool('relay_inbox', {});
    check('b 收到广播', bAfterBcast.payload?.count === 1 && bAfterBcast.payload?.messages?.[0]?.text === 'broadcast to all');
    const bReplay = await b.callTool('relay_inbox', { from_seq: 0, limit: 50, mark_read: false });
    check('b 用 from_seq=0 能重读到广播', bReplay.payload?.messages?.some((message) => message.text === 'broadcast to all'), JSON.stringify(bReplay.payload?.count));

    console.log('\n▶ 7. 离线补投（接收方进程不在线）');
    b.kill();
    await sleep(300);
    const offline = await a.callTool('relay_send', { to: 'b', text: 'queued while b offline' });
    check('离线期间发送成功', offline.isError === false, JSON.stringify(offline.payload));
    b = new McpClient('b', envFor('b', stateB));
    await b.initialize();
    const bBack = await b.callTool('relay_inbox', {});
    check('b 重启后补收到离线消息', bBack.payload?.messages?.some((message) => message.text === 'queued while b offline'), JSON.stringify(bBack.payload?.count));

    console.log('\n▶ 8. hub 重启后的持久化');
    hub.kill();
    await sleep(300);
    hub = startHub(port, hubData);
    await hub.waitReady();
    const afterRestart = await a.callTool('relay_send', { to: 'b', text: 'after hub restart' });
    check('hub 重启后仍可发送（seq 单调递增）', afterRestart.isError === false && afterRestart.payload?.seq > 3, JSON.stringify(afterRestart.payload?.seq));
    const bAfterRestart = await b.callTool('relay_inbox', {});
    check('b 收到重启后的消息', bAfterRestart.payload?.messages?.some((message) => message.text === 'after hub restart'));

    console.log('\n▶ 9. 失败路径');
    const emptyText = await a.callTool('relay_send', { to: 'b', text: '   ' });
    check('空消息被拒绝且 isError=true', emptyText.isError === true, JSON.stringify(emptyText.payload));
    const badPeer = await a.callTool('relay_send', { to: 'bad peer!', text: 'x' });
    check('非法 peer 名被拒绝', badPeer.isError === true);

    c = new McpClient('c', { ...envFor('c', path.join(tmp, 'state-c')), LAN_RELAY_TOKEN: 'wrong-token' });
    await c.initialize();
    const cStatus = await c.callTool('relay_status');
    check('错误 token 时 relay_status 报不可达', cStatus.payload?.reachable === false, JSON.stringify(cStatus.payload?.error));
    check('错误 token 的错误信息包含 token 提示', /token/i.test(JSON.stringify(cStatus.payload)), JSON.stringify(cStatus.payload));

    console.log('\n▶ 10. 未知工具与非法方法');
    const unknown = await a.rpc('tools/call', { name: 'relay_nope', arguments: {} });
    check('未知工具返回 -32602', unknown.error?.code === -32602, JSON.stringify(unknown.error));
    const unknownMethod = await a.rpc('bogus/method');
    check('未知方法返回 -32601', unknownMethod.error?.code === -32601, JSON.stringify(unknownMethod.error));

    console.log('\n▶ 11. 凭据与配置缺失');
    const d = new McpClient('d', { LAN_RELAY_CONFIG: missingConfig, LAN_RELAY_URL: '', LAN_RELAY_TOKEN: '', LAN_RELAY_SELF: '' });
    await d.initialize();
    const dStatus = await d.callTool('relay_status');
    check('未配置时给出明确错误', dStatus.payload?.error && /未配置|配置/.test(String(dStatus.payload.error)), JSON.stringify(dStatus.payload));
    d.kill();
  } finally {
    a?.kill();
    b?.kill();
    c?.kill();
    hub.kill();
    await sleep(200);
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  console.log(`\n${failures.length ? '❌' : '✅'} 通过 ${passed} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    for (const failure of failures) console.log(`   - ${failure}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('\n测试异常终止：', error?.stack || error);
  process.exitCode = 1;
});
