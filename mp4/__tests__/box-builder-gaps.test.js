/**
 * box-builder 残余分支补测（wave 125）：
 *  - buildFree 填充尺寸语义
 *  - buildHvcC 直通与 buildStsd hvc1 分支
 *  - buildStsd 未知 sampleEntryType → notSupported
 * （box largesize 分支需 >4GB body、findTrunDataOffset 无 trun 抛错为内部不可达，登记不硬造）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFree, buildHvcC, buildStsd } from '../src/box-builder.js';

test('buildFree：size=8 零填充头；size=16 补两个 U32', () => {
  const f8 = buildFree(8);
  assert.equal(f8.length, 8);
  assert.deepEqual([...f8.subarray(4, 8)], [0x66, 0x72, 0x65, 0x65]); // 'free'
  assert.equal(new DataView(f8.buffer).getUint32(0), 8);

  const f16 = buildFree(16);
  assert.equal(f16.length, 16);
  assert.equal(new DataView(f16.buffer).getUint32(0), 16);
  assert.ok([...f16.subarray(8)].every((b) => b === 0), 'free 体全零填充');
});

test('buildHvcC：解码私有配置字节直通', () => {
  const priv = new Uint8Array([0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00, 0x23, 0xc0]);
  const b = buildHvcC(priv);
  const dv = new DataView(b.buffer);
  assert.equal(dv.getUint32(0), 8 + priv.length, 'box 尺寸 = 头 8 + 载荷');
  assert.equal(String.fromCharCode(b[4], b[5], b[6], b[7]), 'hvcC');
  assert.deepEqual([...b.subarray(8)], [...priv], '载荷原样透传');
});

test('buildStsd：hvc1 分支生成 hvc1 + hvcC 子盒', () => {
  const priv = new Uint8Array(16).fill(0x7c);
  const stsd = buildStsd({
    sampleEntryType: 'hvc1',
    codecPrivate: priv,
    width: 1920,
    height: 1080,
  });
  const text = (off, n) => String.fromCharCode(...stsd.subarray(off, off + n));
  assert.equal(text(4, 4), 'stsd');
  // stsd：box 头 8 + version/flags 4 + entry_count 4 → entry 起点在 16
  const entryOff = 16;
  assert.equal(text(entryOff + 4, 4), 'hvc1');
  assert.ok([...stsd].some((_, i) => text(i, 4) === 'hvcC'), 'hvc1 entry 内应含 hvcC 子盒');
  // VisualSampleEntry：宽高为相邻两个 U16（非定点）
  const dv = new DataView(stsd.buffer, stsd.byteOffset, stsd.byteLength);
  let found = false;
  for (let i = 0; i + 4 <= stsd.length; i++) {
    if (dv.getUint16(i) === 1920 && dv.getUint16(i + 2) === 1080) found = true;
  }
  assert.ok(found, '宽高以 U16 写入');
});

test('buildStsd：未知 sampleEntryType → notSupported', () => {
  assert.throws(
    () => buildStsd({ sampleEntryType: 'vp99', codecPrivate: new Uint8Array(4) }),
    (e) => e.code === 'NOT_SUPPORTED' && /vp99/.test(e.message)
  );
});
