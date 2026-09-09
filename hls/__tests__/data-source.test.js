/**
 * HLS 数据源适配层（ChunkSource）单测——scope 重定位后的核心契约交付
 * 全部离线：清单与分片经注入的 fetchImpl 提供。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHlsSource } from '../src/data-source.js';

const MEDIA_TS = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:4.0,
seg0.ts
#EXTINF:4.0,
seg1.ts
#EXT-X-ENDLIST`;

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=900000,CODECS="avc1.42E01E"
lo/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.64001f"
hi/index.m3u8`;

/** TS 分片字节（首字节 0x47 满足探测） */
function tsBytes(fill) {
  const b = new Uint8Array(188);
  b[0] = 0x47;
  b.fill(fill, 1);
  return b;
}

/** 注入式 fetch：路径 → 响应 */
function fakeFetch(routes) {
  return async (url) => {
    const path = new URL(url).pathname;
    for (const [pattern, handler] of routes) {
      if (path.includes(pattern)) return handler(url);
    }
    return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
  };
}

test('createHlsSource：MEDIA 清单顺序推送分片并正确 end', async () => {
  const chunks = [];
  const source = await createHlsSource('https://cdn/media.m3u8', {
    fetchImpl: fakeFetch([
      ['media.m3u8', () => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(MEDIA_TS).buffer, headers: { get: () => null } })],
      ['seg0.ts', () => ({ ok: true, status: 200, arrayBuffer: async () => tsBytes(0xaa).slice().buffer, headers: { get: () => null } })],
      ['seg1.ts', () => ({ ok: true, status: 200, arrayBuffer: async () => tsBytes(0xbb).buffer, headers: { get: () => null } })],
    ]),
  });

  assert.equal(source.container, 'ts', 'start 前默认标注为 ts');
  assert.equal(source.live, false);

  const ended = [];
  source.onData = (b) => chunks.push(b);
  source.onEnd = (err) => ended.push(err);
  await source.start();

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0][0], 0x47);
  assert.equal(chunks[0][1], 0xaa);
  assert.equal(source.container, 'ts');
  assert.equal(source.bytesWritten, 376);
  assert.equal(ended.length, 1);
  assert.equal(ended[0], undefined, '正常结束无错误');
});

test('createHlsSource：MASTER 按 variant 选择清晰度', async () => {
  const source = await createHlsSource('https://cdn/master.m3u8', {
    variant: 1, // 第二档（低清）
    fetchImpl: fakeFetch([
      ['master.m3u8', () => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(MASTER).buffer, headers: { get: () => null } })],
      ['index.m3u8', () => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-ENDLIST').buffer, headers: { get: () => null } })],
    ]),
  });
  assert.ok(source.mediaPlaylist.segments.length === 0, '空清单合法');
});

test('createHlsSource：AES-128 分片在 Source 内解密后写出（§2.6 解密层位置）', async () => {
  const { webcrypto } = await import('node:crypto');
  const subtle = webcrypto.subtle;
  const KEY = new Uint8Array(16).fill(7);
  const IV = new Uint8Array(16);

  // 明文 TS → PKCS7 加密
  const plain = tsBytes(0x77);
  const k = await subtle.importKey('raw', KEY, { name: 'AES-CBC' }, false, ['encrypt']);
  const cipherBuf = await subtle.encrypt({ name: 'AES-CBC', iv: IV }, k, plain);

  const MEDIA_ENC = `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:5
#EXT-X-KEY:METHOD=AES-128,URI="k.key",IV=0x${Array.from(IV).map((b) => b.toString(16).padStart(2, '0')).join('')}
#EXTINF:4.0,
enc.ts
#EXT-X-ENDLIST`;

  const source = await createHlsSource('https://cdn/enc.m3u8', {
    keyLoader: async () => KEY,
    fetchImpl: fakeFetch([
      ['enc.m3u8', () => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(MEDIA_ENC).buffer })],
      ['k.key', () => ({ ok: true, status: 200, arrayBuffer: async () => KEY.slice().buffer, headers: { get: () => null } })],
      ['enc.ts', () => ({ ok: true, status: 200, arrayBuffer: async () => cipherBuf, headers: { get: () => null } })],
    ]),
  });

  const outs = [];
  source.onData = (b) => outs.push(b);
  await source.start();

  assert.equal(outs.length, 1);
  assert.deepEqual(Array.from(outs[0]), Array.from(plain), '消费端拿到的必须是明文分片');
});
