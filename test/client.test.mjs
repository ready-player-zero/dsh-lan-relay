#!/usr/bin/env node
/**
 * Web 半结构冒烟测试：不依赖浏览器 / 真实 React。
 *
 * 用最小 React 替身 + 假 DOM 加载 client.js，验证：
 *   - 模块以 window.__ModuleLoader__.load({id:'dsh-lan-relay'}) 形式注册
 *   - apply() 往 settings.section 注册了 id=lan-relay 的页面
 *   - Host API 正常时渲染出角色选择、端口/token/加入码等表单控件
 *   - Host API 404 时仍能渲染并给出错误提示，不抛异常、不产生未处理拒绝
 *   - 卸载时清理轮询定时器与 visibilitychange 监听
 *
 * 运行：node --test test/client.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = path.join(HERE, '..', 'client.js');

// ---------------------------------------------------------------- 假宿主环境
const loaded = new Map();
const intervals = new Map();
const documentListeners = [];
const unhandled = [];
process.on('unhandledRejection', (error) => unhandled.push(error));

globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded.set(definition.id, definition);
    },
  },
  getSelection: () => null,
};

globalThis.document = {
  documentElement: { lang: 'zh-CN' },
  hidden: false,
  addEventListener(type, handler) {
    documentListeners.push({ type, handler });
  },
  removeEventListener(type, handler) {
    const index = documentListeners.findIndex((item) => item.type === type && item.handler === handler);
    if (index >= 0) documentListeners.splice(index, 1);
  },
  createRange: () => ({ selectNodeContents() {}, setStart() {}, setEnd() {} }),
  execCommand: () => true,
};

let intervalSeq = 0;
globalThis.setInterval = (callback) => {
  intervalSeq += 1;
  intervals.set(intervalSeq, callback);
  return intervalSeq;
};
globalThis.clearInterval = (intervalId) => {
  intervals.delete(intervalId);
};

// ---------------------------------------------------------------- 最小 React 替身
const hookCells = new Map();
const componentKeys = new WeakMap();
let componentSeq = 0;
let currentKey = 'root';
let hookCursor = 0;
const pendingEffects = [];

function keyFor(type) {
  let key = componentKeys.get(type);
  if (!key) {
    componentSeq += 1;
    key = `c${componentSeq}`;
    componentKeys.set(type, key);
  }
  return key;
}

const React = {
  createElement(type, props, ...children) {
    return {
      __isElement: true,
      type,
      props: props || {},
      children: children.length > 1 ? children : children.length === 1 ? children[0] : undefined,
    };
  },
  Fragment: '__fragment__',
  Children: {
    toArray(children) {
      if (children === null || children === undefined) return [];
      if (Array.isArray(children)) return children.flat(Infinity).filter((child) => child !== null && child !== undefined);
      return [children];
    },
  },
  useState(initial) {
    const cell = `${currentKey}#${hookCursor++}`;
    if (!hookCells.has(cell)) {
      hookCells.set(cell, typeof initial === 'function' ? initial() : initial);
    }
    return [
      hookCells.get(cell),
      (next) => {
        hookCells.set(cell, typeof next === 'function' ? next(hookCells.get(cell)) : next);
      },
    ];
  },
  useRef(initial) {
    const cell = `${currentKey}#${hookCursor++}`;
    if (!hookCells.has(cell)) hookCells.set(cell, { current: initial });
    return hookCells.get(cell);
  },
  useEffect(effect) {
    hookCursor += 1;
    pendingEffects.push(effect);
  },
  useMemo(factory) {
    hookCursor += 1;
    return factory();
  },
  useCallback(callback) {
    hookCursor += 1;
    return callback;
  },
};

function renderNode(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null;
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) {
    return node.map((child) => renderNode(child)).filter((child) => child !== null);
  }
  if (!node || node.__isElement !== true) return null;

  if (typeof node.type === 'function') {
    const savedKey = currentKey;
    const savedCursor = hookCursor;
    currentKey = keyFor(node.type);
    hookCursor = 0;
    try {
      return renderNode(node.type({ ...node.props, children: node.children }));
    } finally {
      currentKey = savedKey;
      hookCursor = savedCursor;
    }
  }
  if (node.type === '__fragment__') return renderNode(node.children);
  const props = {};
  for (const [key, value] of Object.entries(node.props)) {
    if (key === 'children') continue;
    if (key === 'dangerouslySetInnerHTML') props.dangerouslySetInnerHTML = value;
    else if (['string', 'number', 'boolean'].includes(typeof value)) props[key] = value;
  }
  return { type: node.type, props, children: renderNode(node.children) };
}

function collectText(tree, out = []) {
  if (tree === null || tree === undefined) return out;
  if (typeof tree === 'string') {
    out.push(tree);
    return out;
  }
  if (Array.isArray(tree)) {
    for (const item of tree) collectText(item, out);
    return out;
  }
  collectText(tree.children, out);
  return out;
}

function findNodes(tree, predicate, out = []) {
  if (!tree) return out;
  if (Array.isArray(tree)) {
    for (const item of tree) findNodes(item, predicate, out);
    return out;
  }
  if (typeof tree !== 'object') return out;
  if (predicate(tree)) out.push(tree);
  findNodes(tree.children, predicate, out);
  return out;
}

async function flush(rounds = 6) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** 渲染 + 跑 effect + 等异步 setState + 再渲染，最多 3 轮；返回树与卸载函数（模拟 React 的 effect 清理）。 */
async function renderPage(component) {
  let tree = null;
  let cleanups = [];
  for (let pass = 0; pass < 3; pass += 1) {
    // 模拟 React：重新渲染前先跑上一轮 effect 的清理
    for (const cleanup of cleanups.splice(0)) {
      if (typeof cleanup === 'function') cleanup();
    }
    pendingEffects.length = 0;
    tree = renderNode(React.createElement(component, {}));
    const effects = pendingEffects.splice(0);
    for (const effect of effects) {
      try {
        const cleanup = effect();
        if (typeof cleanup === 'function') cleanups.push(cleanup);
      } catch (error) {
        throw new Error(`effect 执行抛错：${error?.message || error}`);
      }
    }
    await flush();
  }
  return {
    tree,
    unmount() {
      for (const cleanup of cleanups.splice(0)) {
        if (typeof cleanup === 'function') cleanup();
      }
    },
  };
}

// ---------------------------------------------------------------- 夹具
const stateFixture = {
  api: 1,
  version: '1.0.0',
  role: 'server',
  self: 'pc-test',
  token: 'tok-abcdefghijklmnop',
  joinCode: 'dshrelay1.eyJ1IjoiaHR0cDovLzE5Mi4xNjguMC4xMDo4Nzg3IiwidCI6InRrIn0',
  configPath: 'C:/Users/test/.dsh/lan-relay/config.json',
  hub: {
    enabled: true,
    running: true,
    host: '0.0.0.0',
    port: 8787,
    urls: ['http://192.168.0.10:8787'],
    dataDir: 'C:/Users/test/.dsh/lan-relay/hub',
    messages: 3,
    latestSeq: 7,
    error: '',
  },
  client: {
    relayUrl: 'http://127.0.0.1:8787',
    reachable: true,
    error: '',
    hint: '',
    peers: [{ name: 'pc-b', online: true, last_seen_seconds: 3 }],
    wake: { enabled: true, stats: { delivered: 1, cold: 0, skipped: 0, failed: 0 } },
  },
  firewall: { port: 8787, supported: true },
  startedAt: Date.now(),
  lastError: '',
};

function installFetch(handler) {
  globalThis.fetch = async (url, init) => handler(String(url), init || {});
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

// ---------------------------------------------------------------- 主流程
async function main() {
  const source = fs.readFileSync(CLIENT_PATH, 'utf8');
  assert.ok(source.includes('__ModuleLoader__'), 'client.js 应使用 DSH 客户端模块加载器');
  assert.ok(!/document\.body\s*\./.test(source), '不应向 document.body 追加内容');

  await import('../client.js');

  const definition = loaded.get('dsh-lan-relay');
  assert.ok(definition, '应注册 id=dsh-lan-relay 的客户端模块');
  const clientModule = definition.factory((name) => {
    if (name === 'react') return React;
    throw new Error(`未预期的 require：${name}`);
  });
  assert.ok(Array.isArray(clientModule.inject) && clientModule.inject.includes('slots'));

  // ---- apply：注册 settings.section
  const registrations = [];
  const ctxEffects = [];
  const slotDisposers = [];
  const localeDicts = new Map();
  const fakeCtx = {
    effect(factory, label) {
      const dispose = factory();
      ctxEffects.push({ dispose, label });
      return dispose;
    },
    locale: {
      register(namespace, dicts) {
        localeDicts.set(namespace, dicts || {});
        return () => {};
      },
      bind(namespace) {
        return (key) => {
          const dicts = localeDicts.get(namespace) || {};
          return dicts.zh?.[key] ?? dicts.en?.[key] ?? key;
        };
      },
    },
    slots: {
      inject(_slotName, callback) {
        const dispose = callback();
        if (typeof dispose === 'function') slotDisposers.push(dispose);
        return dispose;
      },
      register(registration, component) {
        registrations.push({ registration, component });
        return () => {
          const index = registrations.findIndex((item) => item.registration === registration);
          if (index >= 0) registrations.splice(index, 1);
        };
      },
    },
  };

  clientModule.apply(fakeCtx);
  assert.equal(registrations.length, 1, '应只注册一个 settings section');
  const { registration, component } = registrations[0];
  assert.equal(registration.name, 'settings.section');
  assert.equal(registration.id, 'lan-relay');
  assert.equal(typeof registration.order, 'number');
  assert.equal(typeof registration.label, 'function');
  assert.ok(String(registration.label()).length > 0);

  // ---- 场景 1：Host API 正常（服务端角色，带 token / 加入码 / peer）
  installFetch((url, init) => {
    assert.ok(url.startsWith('/lan-relay/api/'), `应请求同源 API：${url}`);
    if (url === '/lan-relay/api/state') return jsonResponse(stateFixture);
    if (url === '/lan-relay/api/test') return jsonResponse({ ok: true, hub: { name: 'pc-test', version: '1.0.0' } });
    return jsonResponse({ ok: true, method: 'failed', error: 'fake host: 未实现' }, init.method === 'POST' ? 200 : 404);
  });

  let first = await renderPage(component);
  let tree = first.tree;
  let text = collectText(tree).join(' ');
  assert.ok(text.includes('局域网中继'), `页面应包含中文标题，实际：${text.slice(0, 160)}`);
  assert.ok(text.includes('服务端'), '页面应包含角色选项「服务端」');
  assert.ok(text.includes('客户端'), '页面应包含角色选项「客户端」');
  const inputs = findNodes(tree, (node) => node.type === 'input' || node.type === 'textarea');
  assert.ok(inputs.length >= 2, `服务端区块应有端口/token 输入框，实际 ${inputs.length}`);
  const portInput = inputs.find((node) => String(node.props?.value ?? '') === '8787');
  assert.ok(portInput, '端口输入框应回填 8787');
  assert.ok(intervals.size >= 1, '应注册状态轮询定时器');
  assert.ok(documentListeners.some((item) => item.type === 'visibilitychange'), '应监听页面可见性');
  const buttons = findNodes(tree, (node) => node.type === 'button');
  assert.ok(buttons.length >= 2, '页面应有保存/刷新/复制等按钮');
  assert.ok(!unhandled.length, `不应产生未处理的 Promise 拒绝：${unhandled.map(String).join('; ')}`);

  // ---- 场景 2：Host API 全 404（插件 Host 半未加载/开发期）
  first.unmount();
  installFetch(() => jsonResponse({ ok: false, error: 'not found (fake host)' }, 404));
  hookCells.clear();
  const second = await renderPage(component);
  tree = second.tree;
  text = collectText(tree).join(' ');
  assert.ok(text.includes('局域网中继'), '接口 404 时仍应渲染页面标题');
  assert.ok(
    /无法|失败|未加载|错误|not found|404/i.test(text),
    `接口 404 时应给出可读错误提示，实际：${text.slice(0, 240)}`,
  );
  assert.ok(!unhandled.length, `接口 404 不应产生未处理拒绝：${unhandled.map(String).join('; ')}`);

  // ---- 卸载：清理定时器与事件监听
  second.unmount();
  for (const dispose of slotDisposers.splice(0)) {
    if (typeof dispose === 'function') dispose();
  }
  for (const item of ctxEffects) {
    if (typeof item.dispose === 'function') item.dispose();
  }
  assert.equal(intervals.size, 0, '卸载后应清理轮询定时器');
  assert.equal(documentListeners.length, 0, '卸载后应移除 visibilitychange 监听');
  assert.equal(registrations.length, 0, '卸载后应注销 settings section');

  console.log('✅ client.test.mjs 全部通过');
}

try {
  await main();
} finally {
  process.removeAllListeners('unhandledRejection');
}
