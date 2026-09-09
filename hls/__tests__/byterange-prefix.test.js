/**
 * BYTERANGE 前置归属回归测试（第十八波）
 * RFC 8216：BYTERANGE 应用于下一个 URI 分片。规范排列在 EXTINF 之后 URI 之前；
 * 非规范「前置」排列（紧跟上一 URI、所属 EXTINF 尚未来）旧实现因 current=null 直接丢失。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMedia } from '../src/m3u8-parser.js';

test('前置 BYTERANGE（URI→BYTERANGE→EXTINF→URI）归属下一个分片', () => {
  const p = parseMedia(`#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:4.0,
a.ts
#EXT-X-BYTERANGE:100@0
#EXTINF:4.0,
b.ts
#EXT-X-ENDLIST`, '');
  assert.equal(p.segments.length, 2);
  assert.equal(p.segments[0].byteRange, null, 'a.ts 无 BYTERANGE');
  assert.deepEqual(p.segments[1].byteRange, { length: 100, offset: 0 }, '前置 BYTERANGE 应挂给 b.ts');
});

test('混合顺序：首分片规范后置 + 次分片前置，各自归属正确', () => {
  const p = parseMedia(`#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:4.0,
#EXT-X-BYTERANGE:200@0
a.ts
#EXT-X-BYTERANGE:300@200
#EXTINF:4.0,
b.ts
#EXT-X-ENDLIST`, '');
  assert.deepEqual(p.segments[0].byteRange, { length: 200, offset: 0 }, '规范后置归属 a.ts');
  assert.deepEqual(p.segments[1].byteRange, { length: 300, offset: 200 }, '前置 + 显式 offset 归属 b.ts');
});

test('前置 BYTERANGE 缺省 offset 按前序滚动（prevByteRangeEnd 续接）', () => {
  const p = parseMedia(`#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:4.0,
#EXT-X-BYTERANGE:200@0
a.ts
#EXT-X-BYTERANGE:150
#EXTINF:4.0,
b.ts
#EXT-X-ENDLIST`, '');
  assert.deepEqual(p.segments[0].byteRange, { length: 200, offset: 0 });
  assert.deepEqual(p.segments[1].byteRange, { length: 150, offset: 200 }, '缺省 offset 滚动到 200');
});

test('无前置时行为不变：首个分片缺省 offset 仍解析期报错', () => {
  assert.throws(
    () => parseMedia(`#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:4.0,
#EXT-X-BYTERANGE:150
a.ts
#EXT-X-ENDLIST`, ''),
    /BYTERANGE 缺省 offset/
  );
});
