/**
 * dsh-lan-relay-push —— DSH 插件入口
 *
 * 作用：在 DSH 进程内自动接收局域网消息，投递到指定会话并唤醒该会话的 agent；
 *       同时提供 lan_relay_send / lan_relay_sessions / lan_relay_status 三个工具。
 *
 * 设计取舍：零外部 import（只用 node 内置 + 本包相对文件），工具定义用 registry
 * 接受的原始 JSON Schema，避免依赖 @deepseek-ai/dsh-tools 的 peer 解析。
 *
 * 配置（~/.dsh/lan-relay/config.json，与 hub/MCP/CLI 共用）：
 *   {
 *     "relay_url": "http://10.0.0.10:8787",
 *     "token": "...",
 *     "self": "pc1",
 *     "push": { "enabled": true, "default_session": "", "wake": true, "poll_timeout_seconds": 25 }
 *   }
 */
import { createRuntime, makeLogger } from './lib/core.mjs';

export const name = 'dsh-lan-relay-push';
/** agents：会话/唤醒；tools：注册工具（root 层 dsh-tools 服务，声明后 apply 会等它就绪） */
export const inject = ['agents', 'tools'];

export function apply(ctx) {
  const log = makeLogger(ctx);

  let runtime;
  try {
    runtime = createRuntime({ ctx, log });
  } catch (error) {
    log(`插件初始化失败：${error?.stack || error}`, 'error');
    return;
  }

  // 工具注册：不阻塞唤醒循环。tools 服务可能稍后才就绪，两段式尝试：
  //   1) 立即 ctx.get('tools')
  //   2) 若还没有，用 ctx.inject(['tools'], child) 等它就绪再注册
  const registerTools = (toolsService) => {
    try {
      runtime.installTools(toolsService);
    } catch (error) {
      runtime.debug(`installTools threw: ${error?.stack || error}`);
      log(`工具注册失败：${error?.message || error}`, 'warn');
    }
  };

  let tools = null;
  try {
    tools = (typeof ctx.get === 'function' ? ctx.get('tools') : null) ?? null;
    runtime.debug(`ctx.get('tools') -> ${tools ? 'service' : 'undefined'}`);
  } catch (error) {
    runtime.debug(`ctx.get('tools') threw: ${error?.message || error}`);
  }

  if (tools) {
    registerTools(tools);
  } else if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['tools'], (scoped) => {
        runtime.debug('tools service became available via ctx.inject');
        let service = null;
        try {
          service = (typeof scoped.get === 'function' ? scoped.get('tools') : null) ?? scoped.tools ?? null;
        } catch {
          service = null;
        }
        registerTools(service);
      });
    } catch (error) {
      runtime.debug(`ctx.inject(['tools']) failed: ${error?.message || error}`);
      log(`无法等待 tools 服务：${error?.message || error}`, 'warn');
    }
  } else {
    runtime.debug('ctx.inject 不存在，工具注册放弃（唤醒不受影响）');
  }

  try {
    runtime.start();
  } catch (error) {
    // 顶层绝不抛：宿主在 dsh web 下可能没有日志 sink，抛错会静默杀掉整个插件
    log(`长轮询启动失败（不阻塞 DSH）：${error?.stack || error}`, 'error');
  }
}
