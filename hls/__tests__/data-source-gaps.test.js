/**
 * HlsChunkSource 残余分支补测（第一百二十二波）
 * ------------------------------------------------------------
 * 覆盖：defaultFetchImpl 无 fetch 注入提示与默认 fetch 路径、EXT-X-MAP
 * init 分片先行推送、close() 中止拉取、detectContainer fMP4/unknown 分支。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHlsSource } from '../src/data-source.js';

const MEDIA_TS = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:4',
  '#EXTINF:4.0,',
  'seg0.ts',
  '#EXTINF:4.0,',
  'seg1.ts',
  '#EXT-X-ENDLIST',
  '',
].join('\n');

const MEDIA_FMP4 = [
  '#EXTM3U',
  '#EXT-X-VERSION:6',
  '#EXT-X-TARGETDURATION:4',
  '#EXT-X-MAP:URI="init.mp4"',
  '#EXTINF:4.0,',
  'seg0.m4s',
  '#EXT-X-ENDLIST',
  '',
].join('\n');

const TS_BYTES = Uint8Array.from([0x47, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
const STYP_BYTES = Uint8Array.from([0, 0, 0, 16, 0x73, 0x74, 0x79, 0x70, 1, 2, 3, 4, 5, 6, 7, 8]);
const JUNK_BYTES = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);

function bytesRes(bytes) {
  if (typeof bytes === 'string') bytes = new TextEncoder().encode(bytes);
  return new Response(bytes.slice().buffer, { status: 200 });
}

test('defaultFetchImpl：无 fetch 时给出注入提示（notSupported）', async (t) => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  Object.defineProperty(globalThis, 'fetch', { value: undefined, configurable: true });
  try {
    await assert.rejects(
      () => createHlsSource('http://fixture.internal/live.m3u8'),
      (e) => /options\.fetchImpl 注入/.test(e.message),
    );
  } finally {
    if (saved) Object.defineProperty(globalThis, 'fetch', saved);
    else delete globalThis.fetch;
  }
  void t;
});

test('defaultFetchImpl：未注入 fetchImpl 时走全局 fetch（文本+分片）', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const calls = [];
  const stub = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('.m3u8')) return bytesRes(new TextEncoder().encode(MEDIA_TS));
    return bytesRes(TS_BYTES);
  };
  Object.defineProperty(globalThis, 'fetch', { value: stub, configurable: true });
  try {
    const src = await createHlsSource('http://fixture.internal/live.m3u8');
    const chunks = [];
    src.onData = (b) => chunks.push(b);
    await src.start();
    assert.equal(chunks.length, 2, '两个 TS 分片全部写出');
    assert.equal(src.container, 'ts');
    assert.ok(calls.includes('http://fixture.internal/seg0.ts'));
  } finally {
    if (saved) Object.defineProperty(globalThis, 'fetch', saved);
    else delete globalThis.fetch;
  }
});

test('EXT-X-MAP：init 分片先于媒体分片入 pendingInit；fMP4 容器探测', async () => {
  const files = { 'http://fixture.internal/pl.m3u8': MEDIA_FMP4, 'http://fixture.internal/init.mp4': STYP_BYTES, 'http://fixture.internal/seg0.m4s': STYP_BYTES };
  const src = await createHlsSource('http://fixture.internal/pl.m3u8', {
    fetchImpl: async (url) => {
      const f = files[String(url)];
      assert.ok(f, `意外请求 ${url}`);
      return bytesRes(f);
    },
  });
  assert.equal(src.pendingInit, null);
  const chunks = [];
  src.onData = (b) => chunks.push(b);
  await src.start();
  assert.ok(src.pendingInit, 'EXT-X-MAP 已捕获');
  assert.equal(src.pendingInit.uri, 'http://fixture.internal/init.mp4', 'EXT-X-MAP URI 经清单基准解析');
  assert.equal(src.container, 'fmp4', 'styp 头识别为 fMP4');
  assert.equal(chunks.length, 1, 'init 不进 write 通道（经 pendingInit 交付）');
  assert.equal(src.bytesWritten, STYP_BYTES.byteLength);
});

test('detectContainer：既非 TS 也非 ISO-BMFF → unknown；close() 不再启动后续分片', async () => {
  const MEDIA_3SEG = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:4',
    '#EXTINF:4.0,',
    'seg0.ts',
    '#EXTINF:4.0,',
    'seg1.ts',
    '#EXTINF:4.0,',
    'seg2.ts',
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');
  const files = {
    'http://fixture.internal/pl.m3u8': MEDIA_3SEG,
    'http://fixture.internal/seg0.ts': JUNK_BYTES,
    'http://fixture.internal/seg1.ts': TS_BYTES,
    'http://fixture.internal/seg2.ts': TS_BYTES,
  };
  const fetched = [];
  const src = await createHlsSource('http://fixture.internal/pl.m3u8', {
    fetchImpl: async (url) => {
      fetched.push(String(url));
      return bytesRes(files[String(url)]);
    },
  });
  const chunks = [];
  let ended = 0;
  const firstWrite = new Promise((r) => {
    src.onData = (b) => { chunks.push(b); r(); };
  });
  src.onEnd = () => ended++;
  const running = src.start();
  await firstWrite; // 等首分片写出，容器探测完成
  assert.equal(src.container, 'unknown', '垃圾头 → unknown');
  src.close(); // seg1 已在途会完成，seg2 不应再启动
  await running;
  assert.ok(!fetched.some((u) => u.endsWith('seg2.ts')), 'close 后 seg2 不再拉取');
  assert.equal(ended, 1, 'onEnd 恰好回调一次');
});
