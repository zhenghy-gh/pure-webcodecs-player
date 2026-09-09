/**
 * TARGETDURATION 语义校验回归测试（第十七波）
 * RFC 8216 §4.4.3.1：各分片 EXTINF 四舍五入到最近整数后必须 ≤ 声明的 Target Duration。
 * 违例自愈提升声明值 + targetDurationViolations 暴露；标签缺失以实际最大分片时长兜底。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMedia } from '../src/m3u8-parser.js';
import { HlsPlayer } from '../src/player.js';

test('违例自愈：EXTINF 四舍五入超声明 → targetDuration 提升并暴露违例数', () => {
  const p = parseMedia(`#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.6,
a.ts
#EXTINF:5.0,
b.ts
#EXT-X-ENDLIST`, '');
  assert.equal(p.targetDuration, 7, '应提升到 ceil(6.6)=7');
  assert.equal(p.targetDurationViolations, 1, '6.6 四舍五入 7 > 6 应计违例');
});

test('合规边界：EXTINF 四舍五入 ≤ 声明不提升（6.4s 配 6s 声明）', () => {
  const p = parseMedia(`#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.4,
a.ts
#EXTINF:5.0,
b.ts
#EXT-X-ENDLIST`, '');
  assert.equal(p.targetDuration, 6, '6.4 四舍五入 6 ≤ 6 合规，不得提升');
  assert.equal(p.targetDurationViolations, undefined);
});

test('多分片违例计数取全部，提升按最大分片', () => {
  const p = parseMedia(`#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:5.0,
a.ts
#EXTINF:6.6,
b.ts
#EXTINF:7.2,
c.ts
#EXT-X-ENDLIST`, '');
  assert.equal(p.targetDuration, 8, '应提升到 ceil(7.2)=8');
  assert.equal(p.targetDurationViolations, 2, '6.6 与 7.2 两个违例');
});

test('标签缺失（非法值归零同理）：以实际最大分片时长兜底', () => {
  const p = parseMedia(`#EXTM3U
#EXTINF:4.2,
a.ts
#EXTINF:4.0,
b.ts
#EXT-X-ENDLIST`, '');
  assert.equal(p.targetDuration, 5, '无声明时按 ceil(4.2)=5 兜底，而非留给调用方猜测');
  assert.equal(p.targetDurationViolations, undefined);
});

test('HlsPlayer._checkTdViolation 守卫：违例/合规/null 均不抛（诊断仅 warn）', () => {
  const p = new HlsPlayer();
  assert.doesNotThrow(() =>
    p._checkTdViolation({ type: 'media', targetDurationViolations: 2, targetDuration: 8 })
  );
  assert.doesNotThrow(() => p._checkTdViolation({ type: 'media', targetDuration: 6 }));
  assert.doesNotThrow(() => p._checkTdViolation(null));
  p.destroy();
});
