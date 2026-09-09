/**
 * hls 补充单测：加载器重试 / 直播轮询 URL / 解析容错 / 格式探测
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SegmentLoader, LoadError } from '../src/segment-loader.js';
import { HlsPlayer } from '../src/player.js';
import { parseMedia, parseMaster } from '../src/m3u8-parser.js';
import { sniffContainer } from '../src/transmuxer.js';

/* ---------------- SegmentLoader 重试策略 ---------------- */

test('SegmentLoader：5xx 按上限重试后成功', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push(url);
    if (calls.length < 3) {
      return { ok: false, status: 503, headers: { get: () => null }, text: async () => '' };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => '5' },
      body: { getReader: () => {
        let done2 = false;
        return { read: async () => {
          if (done2) return { done: true };
          done2 = true;
          return { done: false, value: new TextEncoder().encode('hello') };
        } };
      } },
    };
  };
  try {
    const loader = new SegmentLoader({ maxRetry: 3, retryDelayMs: 1 });
    const text = await loader.loadText('https://cdn/x.ts');
    assert.equal(text, 'hello');
    assert.equal(calls.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('SegmentLoader：4xx 不重试直接抛 fatal LoadError', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async () => {
    calls.push(1);
    return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
  };
  try {
    const loader = new SegmentLoader({ maxRetry: 3, retryDelayMs: 1 });
    await assert.rejects(
      () => loader.loadText('https://cdn/missing.m3u8'),
      (e) => e instanceof LoadError && e.status === 404 && e.fatal === true
    );
    assert.equal(calls.length, 1, 'fatal 错误不得重试');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/* ---------------- 直播轮询 URL（LL-HLS 阻塞重载） ---------------- */

test('_buildReloadUrl：CAN-BLOCK-RELOAD 时追加 _HLS_msn/_HLS_part', () => {
  const player = new HlsPlayer();
  player.mediaPlaylist = {
    mediaSequence: 100,
    segments: [
      { sn: 100, parts: [{}, {}, {}] },
      { sn: 101, parts: [] },
    ],
    serverControl: { canBlockReload: true },
  };
  player.playlistUrl = 'https://cdn/live/index.m3u8';
  const url = player._buildReloadUrl();
  assert.equal(url, 'https://cdn/live/index.m3u8?_HLS_msn=102&_HLS_part=3');
  player.destroy?.();
});

test('_buildReloadUrl：无阻塞能力时原地址直返', () => {
  const player = new HlsPlayer();
  player.mediaPlaylist = {
    mediaSequence: 7,
    segments: [{ sn: 7, parts: [] }],
    serverControl: null,
  };
  player.playlistUrl = 'https://cdn/live/index.m3u8?token=a';
  assert.equal(player._buildReloadUrl(), 'https://cdn/live/index.m3u8?token=a');
  player.destroy?.();
});

/* ---------------- 解析容错与附加标签 ---------------- */

test('解析容错：CRLF 行尾与 UTF-8 BOM', () => {
  const text = '\uFEFF#EXTM3U\r\n#EXT-X-TARGETDURATION:6\r\n#EXTINF:6.0,\r\na.ts\r\n#EXT-X-ENDLIST';
  const p = parseMedia(text, '');
  assert.equal(p.segments.length, 1);
  assert.equal(p.segments[0].duration, 6.0);
});

test('EXT-X-START 与 I-FRAME 播放列表登记', () => {
  const master = `#EXTM3U
#EXT-X-START:TIME-OFFSET=-6.0
#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1.42E01E"
lo.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=60000,URI="iframe.m3u8"`;
  const m = parseMaster(master, 'https://x/master.m3u8');
  const media = parseMedia(`#EXTM3U\n#EXT-X-START:TIME-OFFSET=0\n#EXTINF:4,\nb.ts\n#EXT-X-ENDLIST`, '');
  void media;
  assert.deepEqual(m.iframePlaylists, ['https://x/iframe.m3u8']);
});

test('未知标签静默忽略（向前兼容，不抛错）', () => {
  const text = `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-CUSTOM-FUTURE-TAG:something-new
#EXTINF:4,
a.ts
#EXT-X-ENDLIST`;
  const p = parseMedia(text, '');
  assert.equal(p.segments.length, 1);
});

/* ---------------- 格式探测边界 ---------------- */

test('sniffContainer：过短/未知缓冲返回 unknown', () => {
  assert.equal(sniffContainer(new Uint8Array(8)), 'unknown');
  assert.equal(sniffContainer(new Uint8Array([1, 2, 3]), ), 'unknown');
  // 合法 ftyp 头
  const ftyp = new Uint8Array(16);
  ftyp[3] = 16;
  ftyp.set([0x66, 0x74, 0x79, 0x70], 4); // ftyp
  assert.equal(sniffContainer(ftyp), 'fmp4');
});
