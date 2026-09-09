/**
 * tkhd 布局回归（真实浏览器端到端暴露的缺陷，见 docs/review/round-1-问题清单.md §44）
 *
 * 历史实现漏掉 ISO/IEC 14496-12 tkhd 的 layer(2B) 字段：
 * 解析时 alternateGroup/volume/矩阵整体错位 2 字节 → width/height 读到矩阵尾部垃圾值（恒 0）；
 * 构建时同样漏写 layer → 自产自解"自洽"但产出非标准 box。
 * 后果：fMP4 init segment 的 avc1 宽高为 0，Chrome 拒收 init segment，MSE 路线整体不可用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTkhd } from '../src/box-parser.js';
import { buildTkhd } from '../src/box-builder.js';
import { ByteStream } from '../../core/src/index.js';

/** 组装一个标准 tkhd v0 box（含完整 header） */
function makeTkhd({ width = 854, height = 480, layer = 0, alternateGroup = 1, volume = 0x0100, trackId = 7 } = {}) {
  const payload = new Uint8Array(84);
  const dv = new DataView(payload.buffer);
  let p = 0;
  dv.setUint8(p, 0); p += 1;                 // version
  dv.setUint8(p, 0); dv.setUint8(p + 1, 0); dv.setUint8(p + 2, 0x03); p += 3; // flags
  dv.setUint32(p, 0); p += 4;                // creation
  dv.setUint32(p, 0); p += 4;                // modification
  dv.setUint32(p, trackId); p += 4;          // track_ID
  dv.setUint32(p, 0); p += 4;                // reserved
  dv.setUint32(p, 1000); p += 4;             // duration
  p += 8;                                    // reserved[2]
  dv.setUint16(p, layer); p += 2;            // layer ★ 历史实现漏读的字段
  dv.setUint16(p, alternateGroup); p += 2;   // alternate_group
  dv.setUint16(p, volume); p += 2;           // volume
  dv.setUint16(p, 0); p += 2;                // reserved
  // unity matrix 36B
  const unity = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
  for (const v of unity) { dv.setUint32(p, v); p += 4; }
  dv.setUint32(p, width << 16); p += 4;      // width 16.16
  dv.setUint32(p, height << 16); p += 4;     // height 16.16

  const box = new Uint8Array(8 + payload.length);
  new DataView(box.buffer).setUint32(0, box.length);
  box.set([0x74, 0x6b, 0x68, 0x64], 4); // 'tkhd'
  box.set(payload, 8);
  return box;
}

test('parseTkhd：按 ISO 布局解析，width/height 与 layer/alternateGroup/volume 各就各位', () => {
  const box = makeTkhd();
  const t = parseTkhd(new ByteStream(box, 8, box.length - 8));
  assert.equal(t.width, 854, 'width 应取自矩阵之后的 16.16 定点');
  assert.equal(t.height, 480);
  assert.equal(t.layer, 0);
  assert.equal(t.alternateGroup, 1);
  assert.equal(t.volume, 1, '0x0100 → 1.0');
  assert.equal(t.trackId, 7);
  assert.equal(t.duration, 1000);
});

test('parseTkhd：layer 非 0 时也不会污染后续字段（错位回归探针）', () => {
  // 若实现漏读 layer，此处 alternateGroup 会读到 0x0007、volume 读到 alternateGroup/256
  const box = makeTkhd({ layer: 7, alternateGroup: 3, volume: 0x0080, width: 1920, height: 1080 });
  const t = parseTkhd(new ByteStream(box, 8, box.length - 8));
  assert.equal(t.layer, 7);
  assert.equal(t.alternateGroup, 3);
  assert.equal(t.volume, 0.5, '0x0080 → 0.5');
  assert.equal(t.width, 1920);
  assert.equal(t.height, 1080);
});

test('buildTkhd → parseTkhd 往返一致，且产出标准长度（含 layer）', () => {
  const box = buildTkhd({ trackId: 1, duration: 5000, isVideo: true, width: 854, height: 480 });
  assert.equal(box.byteLength, 92, '8B 头 + 84B 载荷（标准 tkhd v0）');
  const t = parseTkhd(new ByteStream(box, 8, box.length - 8));
  assert.equal(t.width, 854);
  assert.equal(t.height, 480);
  assert.equal(t.alternateGroup, 0);
  assert.equal(t.volume, 0, '视频轨音量 0');
  assert.equal(t.trackId, 1);
});

test('buildTkhd 音频轨：宽高为 0、音量 1.0', () => {
  const box = buildTkhd({ trackId: 2, isAudio: true });
  const t = parseTkhd(new ByteStream(box, 8, box.length - 8));
  assert.equal(t.width, 0);
  assert.equal(t.height, 0);
  assert.equal(t.volume, 1);
});
