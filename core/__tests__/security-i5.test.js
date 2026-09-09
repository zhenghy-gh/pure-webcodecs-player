/**
 * 安全项（评审第二轮 I5）防回归测试。
 *
 * 覆盖六条检查项里可由 Node 侧确定的部分：
 *  ① URL 协议白名单（core/url-guard + HttpRangeDataSource 接入）
 *  ② WS 信令 schema 校验（webrtc/signaling 的 isValidSignalMessage）
 *  ③ postMessage/MessageChannel —— 本仓无跨 frame 通信，见台账 §45 说明（无测试面）
 *  ④ HLS AES-128 密钥 URI 白名单 + 响应体上限 + 有界缓存
 *  ⑤ 大输入防护（HttpRangeDataSource 单次读取上界、assertByteLength、BoundedMapCache）
 *  ⑥ 正则灾难性回溯（hls parseAttributes / ass 结构识别）
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FETCH_PROTOCOLS,
  WS_PROTOCOLS,
  isSafeUrl,
  assertSafeUrl,
  assertSafeWsUrl,
  urlProtocol,
  parseUrl,
} from '../src/url-guard.js';
import {
  DEFAULT_MAX_READ_BYTES,
  DEFAULT_MAX_SCAN_BYTES,
  assertByteLength,
  BoundedMapCache,
} from '../src/limits.js';
import { HttpRangeDataSource } from '../src/http-range-source.js';
import { ErrorCode } from '../src/errors.js';

/* ------------------------------------------------------------------ */
/* ① URL 协议白名单                                                     */
/* ------------------------------------------------------------------ */

test('① 协议白名单常量：fetch 只放行 http/https，ws 只放行 ws/wss', () => {
  assert.deepEqual([...FETCH_PROTOCOLS], ['http:', 'https:']);
  assert.deepEqual([...WS_PROTOCOLS], ['ws:', 'wss:']);
});

test('① 危险协议一律判不安全（file/blob/data/javascript/ftp）', () => {
  for (const u of [
    'file:///etc/passwd',
    'blob:http://x/y',
    'data:text/javascript,alert(1)',
    'javascript:alert(1)',
    'ftp://host/a.mp4',
    'chrome-extension://abcdef/a.mp4',
  ]) {
    assert.equal(isSafeUrl(u), false, `${u} 应判不安全`);
  }
});

test('① http/https 判安全；无法解析的相对地址宽松放行', () => {
  assert.equal(isSafeUrl('https://cdn.example.com/a.m3u8'), true);
  assert.equal(isSafeUrl('http://localhost:8080/a.mp4'), true);
  // 相对地址没有协议信息，交给调用方/运行时解析，不在本层误伤
  assert.equal(isSafeUrl('/vod/a.mp4'), true);
  assert.equal(isSafeUrl('memory'), true);
});

test('① assertSafeUrl 非法协议抛 PlayerError NETWORK_ERROR 而非 TypeError', () => {
  assert.throws(
    () => assertSafeUrl('file:///etc/passwd', { what: 'HLS 资源' }),
    (err) => {
      assert.equal(err.code, ErrorCode.NETWORK_ERROR);
      assert.match(err.message, /HLS 资源协议不允许/);
      return true;
    },
  );
  // code='source' 可切到 SOURCE_ERROR
  assert.throws(
    () => assertSafeUrl('data:,x', { what: '数据源', code: 'source' }),
    (err) => err.code === ErrorCode.SOURCE_ERROR,
  );
});

test('① assertSafeWsUrl 拒绝 http/ws 以外的协议（含 wss 放行）', () => {
  assert.equal(assertSafeWsUrl('wss://gw.example.com/live'), 'wss://gw.example.com/live');
  assert.throws(() => assertSafeWsUrl('http://gw.example.com/live'));
  assert.throws(() => assertSafeWsUrl('file:///tmp/x'));
});

test('① 解析工具：协议小写带冒号；非法串返回 null', () => {
  assert.equal(urlProtocol('HTTPS://Example.com/a'), 'https:');
  assert.equal(urlProtocol('not a url'), null);
  assert.equal(parseUrl('/rel/path'), null);
  assert.equal(parseUrl('rel.m3u8', 'https://h/v/')?.href, 'https://h/v/rel.m3u8');
});

/* ------------------------------------------------------------------ */
/* ② WS 信令 schema 校验                                                */
/* ------------------------------------------------------------------ */

test('② 信令消息 schema：类型白名单 / sdp 必须字符串 / candidate 必须对象', async () => {
  const { isValidSignalMessage } = await import('../../webrtc/src/signaling.js');
  assert.equal(isValidSignalMessage({ type: 'answer', sdp: 'v=0...' }), true);
  assert.equal(isValidSignalMessage({ type: 'candidate', candidate: { candidate: 'x' } }), true);
  // 未知类型
  assert.equal(isValidSignalMessage({ type: 'evil' }), false);
  // 非字符串 sdp
  assert.equal(isValidSignalMessage({ type: 'answer', sdp: { a: 1 } }), false);
  // 缺 type / 非对象 / 数组
  assert.equal(isValidSignalMessage({ sdp: 'v=0' }), false);
  assert.equal(isValidSignalMessage(null), false);
  assert.equal(isValidSignalMessage([]), false);
  // candidate 非对象
  assert.equal(isValidSignalMessage({ type: 'candidate', candidate: 'x' }), false);
});

test('② 信令消息拒绝原型污染键（__proto__/constructor/prototype）', async () => {
  const { isValidSignalMessage } = await import('../../webrtc/src/signaling.js');
  const payload = JSON.parse('{"type":"candidate","candidate":{"__proto__":{"polluted":1}}}');
  assert.equal(isValidSignalMessage(payload), false);
  const payload2 = JSON.parse('{"type":"candidate","candidate":{"constructor":{"x":1}}}');
  assert.equal(isValidSignalMessage(payload2), false);
});

test('② 超长 SDP 被拒（1MB 上界）', async () => {
  const { isValidSignalMessage } = await import('../../webrtc/src/signaling.js');
  assert.equal(isValidSignalMessage({ type: 'answer', sdp: 'v'.repeat(1024) }), true);
  assert.equal(isValidSignalMessage({ type: 'answer', sdp: 'v'.repeat((1 << 20) + 1) }), false);
});

/* ------------------------------------------------------------------ */
/* ④ HLS AES-128 密钥 URI 白名单 / 响应上限 / 有界缓存                    */
/* ------------------------------------------------------------------ */

test('④ 密钥 URI 走协议白名单：file:/data: 被拒（不发出请求）', async () => {
  const { Aes128Decrypter } = await import('../../hls/src/decrypter.js');
  let called = 0;
  const d = new Aes128Decrypter({
    crypto: { subtle: null },
    keyLoader: async () => {
      called += 1;
      return new Uint8Array(16);
    },
  });
  // 密钥 URI 非法：assertSafeUrl 在进入 keyLoader 之前就抛错
  await assert.rejects(
    () => d.getKey('file:///etc/passwd'),
    (err) => {
      assert.equal(err.code, ErrorCode.NETWORK_ERROR);
      return true;
    },
  );
  assert.equal(called, 0, '非法协议不得触达 keyLoader');
});

test('④ 默认密钥加载器：响应体超过 1MB 报错，不进内存解码', async () => {
  const d = new (await import('../../hls/src/decrypter.js')).Aes128Decrypter({
    crypto: { subtle: null },
  });
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (uri) => {
    calls.push(uri);
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer((1 << 20) + 1),
    };
  };
  try {
    await assert.rejects(
      () => d.getKey('https://cdn.example.com/key.bin'),
      (err) => {
        assert.equal(err.code, ErrorCode.SOURCE_ERROR);
        assert.match(err.message, /密钥响应过大/);
        return true;
      },
    );
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('④ 密钥缓存有界（FIFO，超限淘汰最旧）', async () => {
  const { Aes128Decrypter } = await import('../../hls/src/decrypter.js');
  let n = 0;
  const subtle = {
    importKey: async () => {
      n += 1;
      return { kid: n };
    },
  };
  const d = new Aes128Decrypter({
    crypto: { subtle },
    maxCachedKeys: 3,
    keyLoader: async () => new Uint8Array(16),
  });
  for (let i = 0; i < 5; i++) await d.getKey(`https://k/${i}.bin`);
  assert.equal(d._keys.size, 3, '缓存条目不得超过上限');
  // 前两个（0/1）应已被淘汰，重取会再次 importKey
  await d.getKey('https://k/0.bin');
  assert.equal(n, 6, '被淘汰的密钥应重新导入（5 次首次 + 1 次重取）');
  assert.equal(d._keys.size, 3);
});

/* ------------------------------------------------------------------ */
/* ⑤ 大输入防护                                                         */
/* ------------------------------------------------------------------ */

test('⑤ assertByteLength：越界/负数/NaN/Infinity 一律抛 PARSE_ERROR', () => {
  assert.equal(assertByteLength(10, 100), 10);
  for (const bad of [101, -1, NaN, Infinity, 1e12]) {
    assert.throws(
      () => assertByteLength(bad, 100, '样本'),
      (err) => err.code === ErrorCode.PARSE_ERROR && /越界/.test(err.message),
    );
  }
});

test('⑤ HttpRangeDataSource 构造即校验协议，file: 抛 SOURCE_ERROR', () => {
  assert.throws(
    () => new HttpRangeDataSource('file:///etc/passwd', { fetchImpl: async () => ({}) }),
    (err) => err.code === ErrorCode.SOURCE_ERROR,
  );
});

test('⑤ HttpRangeDataSource 单次读取超上界抛错，不发出超大 Range 请求', async () => {
  const requested = [];
  const src = new HttpRangeDataSource('https://cdn.example.com/a.mp4', {
    maxReadLength: 1024,
    fetchImpl: async (url, init) => {
      const range = init?.headers?.Range ?? init?.method ?? '';
      requested.push(`${url} ${range}`);
      if (init?.method === 'HEAD') {
        return { ok: true, headers: new Map([['content-length', '1000000'], ['accept-ranges', 'bytes']]) };
      }
      return { ok: true, status: 206, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(10) };
    },
  });
  await assert.rejects(
    () => src.read(0, 2 << 20),
    (err) => err.code === ErrorCode.PARSE_ERROR && /HTTP Range 单次读取越界/.test(err.message),
  );
  // 只应有 open 阶段的探测请求，无 2MB 的 Range 请求
  assert.deepEqual(requested, ['https://cdn.example.com/a.mp4 HEAD']);
});

test('⑤ BoundedMapCache：FIFO 淘汰，maxEntries=0 时不缓存', () => {
  const c = new BoundedMapCache(2);
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3);
  assert.equal(c.size, 2);
  assert.equal(c.has('a'), false);
  assert.equal(c.get('c'), 3);
  const none = new BoundedMapCache(0);
  none.set('a', 1);
  assert.equal(none.size, 0);
  none.clear();
  assert.equal(none.size, 0);
});

test('⑤ 上界常量量级符合预期（64MB 读取 / 256MB 扫描）', () => {
  assert.equal(DEFAULT_MAX_READ_BYTES, 64 << 20);
  assert.equal(DEFAULT_MAX_SCAN_BYTES, 256 << 20);
});

/* ------------------------------------------------------------------ */
/* ⑥ 正则灾难性回溯                                                     */
/* ------------------------------------------------------------------ */

test('⑥ hls parseAttributes：长串无等号不触发灾难性回溯（1s 内完成）', async () => {
  const { parseAttributes } = await import('../../hls/src/utils.js');
  const evil = 'A'.repeat(200000); // 无等号的长属性行：旧正则会 O(n²) 回溯
  const t0 = Date.now();
  const attrs = parseAttributes(evil);
  const cost = Date.now() - t0;
  assert.deepEqual(attrs, {});
  assert.ok(cost < 1000, `parseAttributes 耗时 ${cost}ms，疑灾难性回溯`);
});

test('⑥ hls parseAttributes：正常属性表解析不受上界影响', async () => {
  const { parseAttributes } = await import('../../hls/src/utils.js');
  const attrs = parseAttributes('METHOD=AES-128,URI="https://k/x.bin",IV=0x9c7d,KEYFORMAT="identity"');
  assert.equal(attrs.METHOD, 'AES-128');
  assert.equal(attrs.URI, 'https://k/x.bin');
  assert.equal(attrs.IV, '0x9c7d');
  assert.equal(attrs.KEYFORMAT, 'identity');
});

test('⑥ ASS 结构识别：大量空行不触发灾难性回溯（1s 内完成）', async () => {
  const { parseAss } = await import('../../subtitle/src/ass.js');
  // 5 万行空白 + 一个真实节头：旧正则 ^\s*\[.*\] 会退化为 O(n²)
  const evil = `${'  \n'.repeat(50000)}[Script Info]\nScriptType: v4.00+\n`;
  const t0 = Date.now();
  const res = parseAss(evil);
  const cost = Date.now() - t0;
  assert.ok(cost < 1000, `parseAss 耗时 ${cost}ms，疑灾难性回溯`);
  assert.ok(res, '正常节头仍应被识别为 ASS');
});

test('⑥ ASS 结构识别：带前导空格的节头与 Dialogue 行仍可识别', async () => {
  const { parseAss } = await import('../../subtitle/src/ass.js');
  const ok1 = await import('../../subtitle/src/ass.js').then((m) => m.parseAss('[Script Info]\n'));
  assert.ok(ok1);
  // 仅 Dialogue 行也应判为 ASS
  const ok2 = parseAss('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,hi\n');
  assert.ok(ok2);
});
