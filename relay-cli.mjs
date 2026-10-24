#!/usr/bin/env node
/**
 * LAN Relay CLI —— 不开 DSH 也能收发/排障（也用于本插件自测）
 *
 *   node relay-cli.mjs status
 *   node relay-cli.mjs send --to pc2 --text "你好，帮我看下 X"
 *   node relay-cli.mjs inbox --limit 10
 *   node relay-cli.mjs wait --timeout 30
 *   node relay-cli.mjs peers
 *
 * 通用参数：--config <文件> --url <http://ip:port> --token <token> --self <peer名> --json
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, RelayError } from './lib/config.mjs';
import { RelayClient } from './lib/relay-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 2) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function fmtTime(iso) {
  if (!iso) return '(未知时间)';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false });
}

function decorate(messages) {
  const now = Date.now();
  return (messages || []).map((message) => ({
    ...message,
    sent_at: message.sent_at || (message.ts ? new Date(message.ts).toISOString() : ''),
    age_seconds: typeof message.age_seconds === 'number'
      ? message.age_seconds
      : Math.max(0, Math.round((now - (message.ts || now)) / 1000)),
  }));
}

function printInbox(result) {
  if (!result.messages.length) {
    console.log(result.timed_out ? `⌛ 等待 ${result.waited_seconds}s，没有新消息` : '📭 没有新消息');
    return;
  }
  for (const message of decorate(result.messages)) {
    const thread = message.thread ? ` [#${message.thread}]` : '';
    console.log(`\n📨 seq=${message.seq} ${message.from} → ${message.to}${thread}  ${fmtTime(message.sent_at)}（${message.age_seconds}s 前）`);
    console.log(message.text);
  }
  console.log(`\n— 共 ${result.messages.length} 条，cursor=${result.cursor}，latest=${result.latest}${result.has_more ? '，还有更多' : ''}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'status';
  const json = Boolean(args.json);

  if (command === 'serve' || command === 'hub') {
    const hubArgs = [path.join(__dirname, 'hub.mjs')];
    if (args.config) hubArgs.push('--config', args.config);
    if (args.port) hubArgs.push('--port', String(args.port));
    if (args.host) hubArgs.push('--host', String(args.host));
    if (args.token) hubArgs.push('--token', String(args.token));
    if (args.data) hubArgs.push('--data', String(args.data));
    const child = spawn(process.execPath, hubArgs, { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }

  const config = loadConfig({
    config: typeof args.config === 'string' ? args.config : undefined,
    url: typeof args.url === 'string' ? args.url : undefined,
    token: typeof args.token === 'string' ? args.token : undefined,
    self: typeof args.self === 'string' ? args.self : undefined,
    state: typeof args.state === 'string' ? args.state : undefined,
  });
  const client = new RelayClient(config);

  switch (command) {
    case 'status': {
      const status = await client.status();
      if (json) return console.log(JSON.stringify(status, null, 2));
      const dot = status.reachable ? '🟢' : '🔴';
      console.log(`${dot} self=${status.self}  hub=${status.relay_url}  可达=${status.reachable ? '是' : '否'}`);
      if (status.hub) console.log(`   hub=${status.hub.name}@${status.hub.hostname}:${status.hub.port} 运行 ${status.hub.uptime_seconds}s，最新 seq=${status.latest}`);
      console.log(`   游标 cursor=${status.cursor}  配置=${status.config_path || '(env)'}`);
      if (status.peers?.length) console.log(`   peers: ${status.peers.map((p) => `${p.name}${p.online ? '(在线)' : '(离线)'}`).join(', ')}`);
      if (status.error) console.log(`   错误: ${status.error}\n   提示: ${status.hint}`);
      return undefined;
    }
    case 'send': {
      if (!args.to || !args.text) {
        throw new RelayError('用法：send --to <peer> --text <内容> [--to-session <session-id>] [--from-session <session-id>] [--thread <标签>]');
      }
      const result = await client.send({
        to: args.to,
        text: args.text,
        thread: args.thread,
        toSession: args['to-session'],
        fromSession: args['from-session'],
      });
      if (json) return console.log(JSON.stringify(result, null, 2));
      const sessionHint = result.message.to_session ? `（会话 ${result.message.to_session}）` : '';
      console.log(`✅ 已发送 #${result.message.seq} → ${result.message.to}${sessionHint}（${result.message.text.length} 字符）`);
      return undefined;
    }
    case 'inbox': {
      const result = await client.inbox({
        limit: Number(args.limit) || 20,
        fromSeq: args['from-seq'] !== undefined ? Number(args['from-seq']) : null,
        markRead: args['no-mark-read'] ? false : true,
      });
      if (json) return console.log(JSON.stringify(result, null, 2));
      printInbox(result);
      return undefined;
    }
    case 'wait': {
      const result = await client.wait({
        timeoutSeconds: Number(args.timeout) || 25,
        afterSeq: args['after-seq'] !== undefined ? Number(args['after-seq']) : null,
      });
      if (json) return console.log(JSON.stringify(result, null, 2));
      printInbox(result);
      return undefined;
    }
    case 'peers': {
      const result = await client.peers();
      if (json) return console.log(JSON.stringify(result, null, 2));
      if (!result.peers?.length) console.log('（暂无 peer 记录：只有至少发过一次请求的 peer 才会出现）');
      for (const peer of result.peers || []) {
        console.log(`${peer.online ? '🟢' : '⚪'} ${peer.name}  最后活跃 ${peer.last_seen_seconds}s 前`);
      }
      return undefined;
    }
    default:
      throw new RelayError(`未知命令：${command}`, {
        hint: '可用命令：status / send / inbox / wait / peers / serve',
      });
  }
}

main().catch((error) => {
  const message = error instanceof RelayError ? error.toString() : String(error?.stack || error);
  console.error(`❌ ${message}`);
  process.exit(1);
});
