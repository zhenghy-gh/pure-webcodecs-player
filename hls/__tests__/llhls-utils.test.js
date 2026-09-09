/**
 * LL-HLS（EXT-X-PART / SERVER-CONTROL / PRELOAD-HINT / SKIP）与工具层单测
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMedia,
  resolveUrl,
  parseByteRange,
  parseAttributes,
  splitCodecs,
  EwmaBandwidthEstimator,
} from '../src/index.js';

const LL = `#EXTM3U
#EXT-X-VERSION:9
#EXT-X-TARGETDURATION:4
#EXT-X-SERVER-CONTROL:CAN-SKIP-UNTIL=24.0,PART-HOLD-BACK=1.02,CAN-BLOCK-RELOAD=YES
#EXT-X-PART-INF:PART-TARGET=0.33334
#EXT-X-MEDIA-SEQUENCE:160
#EXTINF:4.0,
fs160.mp4
#EXT-X-PART:DURATION=0.33334,URI="p1.mp4",INDEPENDENT=YES
#EXT-X-PART:DURATION=0.33334,URI="p2.mp4"
#EXT-X-PART:DURATION=0.33334,URI="p3.mp4"
#EXTINF:4.0,
fs161.mp4
#EXT-X-PRELOAD-HINT:TYPE=PART,URI="p4.mp4"
#EXT-X-RENDITION-REPORT:URI="../720p/playlist.m3u8",LAST-MSN=161,LAST-PART=2`;

test('LL-HLS：SERVER-CONTROL 解析', () => {
  const p = parseMedia(LL, 'https://cdn.example.com/1080p/playlist.m3u8');
  assert.ok(p.serverControl);
  assert.equal(p.serverControl.canSkipUntil, 24.0);
  assert.equal(p.serverControl.partHoldBack, 1.02);
  assert.equal(p.serverControl.canBlockReload, true);
});

test('LL-HLS：PART-INF 与 EXT-X-PART 挂载到所属分片', () => {
  const p = parseMedia(LL, 'https://cdn.example.com/1080p/playlist.m3u8');
  assert.equal(p.partTargetDuration, 0.33334);
  // 两个 EXTINF 分片：parts 应挂在第二个（fs161）上
  assert.equal(p.segments[0].parts.length, 0);
  const parts = p.segments[1].parts;
  assert.equal(parts.length, 3);
  assert.equal(parts[0].independent, true);
  assert.equal(parts[1].independent, false);
  assert.equal(
    parts[0].uri,
    'https://cdn.example.com/1080p/p1.mp4',
    'part URI 相对播放列表解析'
  );
});

test('LL-HLS：PRELOAD-HINT 与 RENDITION-REPORT', () => {
  const p = parseMedia(LL, 'https://cdn.example.com/1080p/playlist.m3u8');
  assert.equal(p.preloadHint.type, 'PART');
  assert.equal(p.preloadHint.uri, 'https://cdn.example.com/1080p/p4.mp4');
  assert.equal(p.renditionReports.length, 1);
  assert.equal(p.renditionReports[0].lastMsn, 161);
  assert.equal(p.renditionReports[0].lastPart, 2);
  assert.equal(
    p.renditionReports[0].uri,
    'https://cdn.example.com/720p/playlist.m3u8'
  );
});

test('resolveUrl：绝对 / 协议相对 / 路径相对 / 越级相对', () => {
  assert.equal(resolveUrl('http://a/x.ts', ''), 'http://a/x.ts');
  assert.equal(resolveUrl('//b/y.m3u8', 'https://a/c/d.m3u8'), 'https://b/y.m3u8');
  assert.equal(resolveUrl('s/1.ts', 'https://a/c/d.m3u8'), 'https://a/c/s/1.ts');
  assert.equal(resolveUrl('../up/2.ts', 'https://a/c/d.m3u8'), 'https://a/up/2.ts');
  assert.equal(resolveUrl('/abs/3.ts', 'https://a/c/d.m3u8'), 'https://a/abs/3.ts');
});

test('parseByteRange：显式与滚动 offset、非法输入', () => {
  assert.deepEqual(parseByteRange('100@200', null), { length: 100, offset: 200 });
  assert.deepEqual(parseByteRange('100', 500), { length: 100, offset: 500 });
  // 缺省 offset 且无前序引用：返回 offset=null 哨兵（规范禁止的用法），上层据此报错
  assert.deepEqual(parseByteRange('100', null), { length: 100, offset: null });
  assert.equal(parseByteRange('', null), null);
});

test('parseAttributes：引号值 / 数字 / 十六进制保留字符串形态', () => {
  const a = parseAttributes('METHOD=AES-128,URI="k.bin",IV=0xABCDEF01,X=42,FLAG=YES');
  assert.equal(a.METHOD, 'AES-128');
  assert.equal(a.URI, 'k.bin');
  assert.equal(a.IV, '0xABCDEF01'); // 保持字符串，由 hexToUint8 处理
  assert.equal(a.X, 42);
  assert.equal(a.FLAG, 'YES');
});

test('splitCodecs：视频/音频编码拆分', () => {
  const c = splitCodecs('avc1.640028,mp4a.40.2');
  assert.equal(c.video, 'avc1.640028');
  assert.equal(c.audio, 'mp4a.40.2');
  const h = splitCodecs('hvc1.1.6.L93.B0,opus');
  assert.equal(h.video, 'hvc1.1.6.L93.B0');
  assert.equal(h.audio, 'opus');
});

test('EWMA 带宽估计：样本充足后向真实带宽收敛', () => {
  const est = new EwmaBandwidthEstimator(256 * 1024, 1e6);
  // 模拟持续以 5 Mbps 的链路下载分片
  for (let i = 0; i < 40; i++) {
    est.sample(625000, 1000); // 625000 B / 1000 ms ≈ 5 Mbps
  }
  assert.ok(est.bandwidth > 4.2e6 && est.bandwidth < 5.8e6, `收敛失败: ${est.bandwidth}`);
});
