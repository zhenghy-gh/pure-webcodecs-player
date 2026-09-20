/**
 * track-gaps.test.js —— 字幕字节入口残余分支补测（wave 156）
 *
 * 覆盖：
 *   - decodeBytes：非法 encoding 标签（TextDecoder 构造抛 RangeError）→ 回退 utf-8 正常解析；
 *   - probe：null 输入（decode 抛 TypeError）→ catch 返 null 不冒泡。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { probe, parseCues } from '../src/track.js';

test('parseCues：非法 encoding 标签 → 回退 utf-8 解析成功', async () => {
  const srt = new TextEncoder().encode(
    '1\n00:00:01,000 --> 00:00:02,000\n你好世界\n\n' +
    '2\n00:00:03,000 --> 00:00:04,000\n第二行\n',
  );
  const cues = [];
  for await (const c of parseCues(srt, { encoding: 'x-不存在的编码', format: 'srt' })) cues.push(c);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, '你好世界');
  assert.equal(cues[1].text, '第二行');
});

test('probe：null 输入触发 decode 异常 → catch 返回 null', () => {
  assert.equal(probe(null), null);
});
