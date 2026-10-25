#!/usr/bin/env node
/**
 * LAN Relay Hub —— 局域网消息总线 CLI（零依赖）
 *
 * 真正的内核在 lib/hub-server.mjs（可被 DSH 插件在进程内调用）；
 * 这个文件只做：解析命令行 / 配置文件 → 启动内核 → 打印 banner → 处理优雅退出。
 *
 * 启动：
 *   node hub.mjs --config <路径>              # 推荐：复用 ~/.dsh/lan-relay/config.json
 *   node hub.mjs --port 8787 --token xxx      # 也可完全命令行指定
 *
 * 参数：
 *   --config <文件>    配置文件（JSON，可选）
 *   --port <端口>      监听端口，默认 8787
 *   --host <地址>      监听地址，默认 0.0.0.0
 *   --token <token>    访问 token
 *   --data <目录>      数据目录（旧参数名，等同 --data-dir）
 *   --data-dir <目录>  数据目录
 *   --log <文件>       把日志追加写入文件（隐藏窗口自启动时排障用）
 *
 * 退出码：0 = 正常退出（SIGINT/SIGTERM）；1 = 配置/监听失败；2 = 端口已被占用（自启动器据此不再重启）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { readConfigFile, ensureDir } from './lib/config.mjs';
import { createHub, VERSION } from './lib/hub-server.mjs';

let server = null;
let hub = null;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
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

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // ---------- 配置 ----------
  let fileConfig = {};
  if (args.config) {
    try {
      fileConfig = readConfigFile(String(args.config));
    } catch (error) {
      console.error(`[hub] 读取配置失败：${error.message}`);
      process.exit(1);
    }
  }

  // --data 是旧参数名，保留兼容（自启动/冒烟测试在用）；--data-dir 更直观
  const dataDirOption = args.data || args['data-dir'];
  const dataDir = ensureDir(
    path.resolve(
      String(dataDirOption || process.env.LAN_RELAY_HUB_DATA || fileConfig.hub?.data_dir
        || path.join(os.homedir(), '.dsh', 'lan-relay', 'hub')),
    ),
  );

  // --log <文件>：隐藏窗口启动时把日志落盘，方便排障
  const hubLogPath = typeof args.log === 'string'
    ? path.resolve(args.log)
    : (process.env.LAN_RELAY_HUB_LOG ? path.resolve(process.env.LAN_RELAY_HUB_LOG) : '');
  if (hubLogPath) {
    try {
      ensureDir(path.dirname(hubLogPath));
      const original = console.error.bind(console);
      const write = (line) => {
        try {
          fs.appendFileSync(hubLogPath, `${new Date().toISOString()} ${line}\n`);
        } catch {
          /* 写日志失败不影响服务 */
        }
      };
      write(`=== hub start (pid=${process.pid}) ===`);
      console.error = (...parts) => {
        const line = parts.map((p) => (typeof p === 'string' ? p : String(p))).join(' ');
        write(line);
        try {
          original(...parts);
        } catch {
          /* 隐藏窗口下 stderr 可能不可写 */
        }
      };
    } catch {
      /* 忽略日志初始化失败 */
    }
  }

  const tokenPath = path.join(dataDir, 'token.txt');

  function resolveToken() {
    if (args.token) return { token: String(args.token), source: '命令行 --token' };
    if (process.env.LAN_RELAY_TOKEN) return { token: process.env.LAN_RELAY_TOKEN, source: '环境变量 LAN_RELAY_TOKEN' };
    if (fileConfig.token) return { token: String(fileConfig.token), source: '配置文件 token 字段' };
    if (fs.existsSync(tokenPath)) {
      const saved = fs.readFileSync(tokenPath, 'utf8').trim();
      if (saved) return { token: saved, source: 'token.txt' };
    }
    const generated = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(tokenPath, `${generated}\n`, { mode: 0o600 });
    return { token: generated, source: '自动生成（已写入 token.txt，请在两台机器配置中填同一个值）' };
  }

  const { token, source: tokenSource } = resolveToken();
  if (!token) {
    console.error('[hub] 未能确定 token');
    process.exit(1);
  }

  const host = String(args.host || process.env.LAN_RELAY_HUB_HOST || fileConfig.hub?.host || '0.0.0.0');
  const port = Number(args.port || process.env.LAN_RELAY_PORT || fileConfig.hub?.port || 8787);

  hub = createHub({
    host,
    port,
    token,
    dataDir,
    logger: (...parts) => console.error(...parts),
  });

  let info;
  try {
    info = await hub.start();
  } catch (error) {
    if (error?.code === 'EADDRINUSE') {
      console.error(`[hub] 端口 ${port} 已被占用：很可能已经有一个 hub 在运行（这通常是正常的，不用重复启动）。`);
      // 退出码 2 通知自启动器：已有实例，不要再循环重启
      process.exit(2);
    }
    console.error(`[hub] 监听失败：${error?.message || error}`);
    process.exit(1);
  }

  server = hub.server;

  console.error('');
  console.error(`  LAN Relay Hub v${VERSION} 已启动`);
  console.error(`  监听      : http://${info.host}:${info.port}`);
  console.error(`  本机地址  : ${info.urls.join('  ') || '(未检测到局域网 IP)'}`);
  console.error(`  数据目录  : ${info.dataDir}`);
  console.error(`  消息数    : ${info.messages}（最新 seq=${info.latestSeq}）`);
  console.error(`  token     : ${token}  （来源：${tokenSource}）`);
  console.error(`  另一台机器配置 relay_url 时请使用上面的局域网地址，token 填同一个值`);
  console.error('');

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[hub] 收到 ${signal}，正在关闭…`);
    const force = setTimeout(() => process.exit(0), 3000);
    force.unref();
    try {
      await hub.stop();
    } catch (error) {
      console.error(`[hub] 关闭时出错：${error?.message || error}`);
    }
    process.exit(0);
  }

  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('uncaughtException', (error) => {
    console.error(`[hub] 未捕获异常：${error?.stack || error}`);
  });
}

main().catch((error) => {
  console.error(`[hub] 启动失败：${error?.stack || error}`);
  process.exit(1);
});

export { VERSION, server };
