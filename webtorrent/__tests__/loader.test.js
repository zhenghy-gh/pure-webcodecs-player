/**
 * loader.test.js —— webtorrent 可选依赖加载器（loader.js）专项测试
 *
 * 难点与解法：
 * `loadWebTorrent` 的核心是「动态 import() 一个 http(s) CDN 地址」。Node 22 的默认 ESM
 * loader **只支持 file:/data:**（network imports 已移除），而 `assertSafeImportUrl` 出于
 * 安全只放行 **http(s)** ——两者互斥，真实网络路径在 Node 下永远失败，因此此前该文件
 * 只能覆盖「全局注入」与「全部失败返回 null」两条分支（79%）。
 *
 * 本文件用 `module.registerHooks` 注册一个**只拦截白名单宿主**的解析/加载钩子，
 * 把 `https://wt.test/<name>` 映射到测试内置的模块源码：既真实走完
 * `import(url) → 取 default/WebTorrent → 返回 ctor` 全链路，又不触网、不影响其他 import。
 *
 * 白名单设计（安全回归重点）：
 *  - 钩子只认 `https://wt.test/`，其余一律 `next()` 透传，不污染进程内其他模块加载；
 *  - `data:` / `blob:` / `file:` **不拦截**——它们会被 `assertSafeImportUrl` 拒绝，
 *    正是 I5 安全项要守的行为（否则 data: 形式的 import 可直接执行任意代码）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

import { loadWebTorrent, DEFAULT_CDN_URLS } from '../src/loader.js';

const HOST = 'https://wt.test/';
/** url → 模块源码；未登记的 URL 视为 404（import 抛错） */
const MOCKS = new Map();

registerHooks({
  resolve(spec, ctx, next) {
    if (typeof spec === 'string' && spec.startsWith(HOST)) {
      return { url: spec, shortCircuit: true, format: 'module' };
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (typeof url === 'string' && url.startsWith(HOST)) {
      const source = MOCKS.get(url);
      // 未 mock：模拟 CDN 不可达（网络/CORS/离线）
      if (source === undefined) throw new Error(`404 Not Found: ${url}`);
      return { format: 'module', shortCircuit: true, source };
    }
    return next(url, ctx);
  },
});

let seq = 0;
/** 登记一个虚拟 CDN 模块，返回其 URL（每次唯一，规避 ESM 模块缓存） */
function mockModule(source) {
  const url = `${HOST}m${(seq += 1)}.js`;
  MOCKS.set(url, source);
  return url;
}

/** 每个用例前后清理全局注入，避免互相污染 */
function withGlobal(value, fn) {
  return async () => {
    const had = 'WebTorrent' in globalThis;
    const prev = globalThis.WebTorrent;
    if (value === undefined) delete globalThis.WebTorrent;
    else globalThis.WebTorrent = value;
    try {
      await fn();
    } finally {
      if (had) globalThis.WebTorrent = prev;
      else delete globalThis.WebTorrent;
    }
  };
}

// ── 1. CDN 动态 import 成功路径 ──────────────────────────

test('CDN 模块 default 导出即构造器', async () => {
  const url = mockModule('export default function WebTorrent(){ this.tag = "default"; }\n');
  const Ctor = await loadWebTorrent({ cdnUrls: [url] });
  assert.equal(typeof Ctor, 'function');
  assert.equal(Ctor.name, 'WebTorrent');
  assert.equal(new Ctor().tag, 'default');
});

test('CDN 模块无 default 时回退命名导出 WebTorrent', async () => {
  const url = mockModule('export function WebTorrent(){ this.tag = "named"; }\n');
  const Ctor = await loadWebTorrent({ cdnUrls: [url] });
  assert.equal(typeof Ctor, 'function');
  assert.equal(Ctor.name, 'WebTorrent');
  assert.equal(new Ctor().tag, 'named');
});

test('default 与命名导出同时存在时 default 优先', async () => {
  const url = mockModule(
    'export default function FromDefault(){}\n'
      + 'export function WebTorrent(){ throw new Error("不应被选中"); }\n',
  );
  const Ctor = await loadWebTorrent({ cdnUrls: [url] });
  assert.equal(Ctor.name, 'FromDefault');
});

// ── 2. 多源回退链 ────────────────────────────────────────

test('首个源 import 失败（不可达）时回退下一个源', async () => {
  const dead = `${HOST}not-registered.js`; // 未 mock → 404
  const good = mockModule('export default function Second(){}\n');
  const Ctor = await loadWebTorrent({ cdnUrls: [dead, good], timeoutMs: 5000 });
  assert.equal(typeof Ctor, 'function');
  assert.equal(Ctor.name, 'Second');
});

test('首个源已加载但无构造器时继续下一个源', async () => {
  const noCtor = mockModule('export const VERSION = "2.0";\n');
  const good = mockModule('export default function Fallback(){}\n');
  const Ctor = await loadWebTorrent({ cdnUrls: [noCtor, good] });
  assert.equal(Ctor.name, 'Fallback');
});

test('default 存在但不是函数时跳过该源', async () => {
  const notFn = mockModule('export default { version: "2.0" };\n');
  const good = mockModule('export default function Real(){}\n');
  const Ctor = await loadWebTorrent({ cdnUrls: [notFn, good] });
  assert.equal(Ctor.name, 'Real');
});

test('全部源都无构造器时返回 null（不抛错）', async () => {
  const a = mockModule('export const A = 1;\n');
  const b = mockModule('export function notWebTorrent(){}\n');
  const Ctor = await loadWebTorrent({ cdnUrls: [a, b] });
  assert.equal(Ctor, null);
});

// ── 3. 安全：协议白名单（I5） ────────────────────────────

test('data: 源被安全过滤，不会执行其中代码', async () => {
  // 若过滤失效，data: 模块会被 import 并交出 EVIL 构造器（可等效为任意代码执行）
  const evil = 'data:text/javascript,export default function EVIL(){ globalThis.__pwned = 1; }\n';
  const good = mockModule('export default function Safe(){}\n');
  const Ctor = await loadWebTorrent({ cdnUrls: [evil, good] });
  assert.equal(Ctor.name, 'Safe');
  assert.equal(globalThis.__pwned, undefined);
});

test('blob: / file: 源被安全过滤', async () => {
  const blobUrl = 'blob:https://wt.test/0000-1111';
  const fileUrl = 'file:///tmp/webtorrent-evil.js';
  const good = mockModule('export default function Safe2(){}\n');
  const Ctor = await loadWebTorrent({ cdnUrls: [blobUrl, fileUrl, good] });
  assert.equal(Ctor.name, 'Safe2');
});

test('全部源协议非法时返回 null', async () => {
  const Ctor = await loadWebTorrent({
    cdnUrls: ['data:text/javascript,export default function(){}', 'blob:https://x/y'],
  });
  assert.equal(Ctor, null);
});

// ── 4. 全局注入优先 ──────────────────────────────────────

test('全局 WebTorrent 为函数时直接返回，且短路 CDN', withGlobal(function GlobalWT() {}, async () => {
  // CDN 源未 mock（会 404）：若走了 CDN，最终会返回 null
  const Ctor = await loadWebTorrent({ cdnUrls: [`${HOST}never-used.js`], timeoutMs: 5000 });
  assert.equal(Ctor, globalThis.WebTorrent);
  assert.equal(Ctor.name, 'GlobalWT');
}));

test('全局 WebTorrent 非函数时被忽略，继续走 CDN', withGlobal({ version: '2.0' }, async () => {
  const url = mockModule('export default function FromCdn(){}\n');
  const Ctor = await loadWebTorrent({ cdnUrls: [url] });
  assert.equal(Ctor.name, 'FromCdn');
}));

test('用例结束后全局注入已清理', async () => {
  assert.equal('WebTorrent' in globalThis, false);
});

// ── 5. 默认参数与常量 ────────────────────────────────────

test('cdnUrls 为空数组时不发起任何 import，直接 null', async () => {
  assert.equal(await loadWebTorrent({ cdnUrls: [] }), null);
});

test('DEFAULT_CDN_URLS 冻结且仅含 https 源', () => {
  assert.ok(Object.isFrozen(DEFAULT_CDN_URLS));
  assert.ok(DEFAULT_CDN_URLS.length >= 2);
  for (const u of DEFAULT_CDN_URLS) {
    assert.ok(u.startsWith('https://'), `应为 https：${u}`);
  }
});

test('未传 opts 时走默认 CDN 列表且失败返回 null（不抛错）', async () => {
  // Node 默认 ESM loader 不支持 http(s) import，两个默认源都会即时失败
  assert.equal(await loadWebTorrent({ timeoutMs: 5000 }), null);
});
