/**
 * track-gaps.test.js —— 字幕字节入口残余分支补测（wave 156）
 *
 * 覆盖：
 *   - decodeBytes：非法 encoding 标签（TextDecoder 构造抛 RangeError）→ 回退 utf-8 正常解析；
 *   - probe：null 输入（decode 抛 TypeError）→ catch 返 null 不冒泡。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { probe, parseCues, createTextTrack } from '../src/track.js';

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

test('createTextTrack：并发 cues 调用共享一次性输入且不重复消费', async () => {
  let pulls = 0;
  async function* source() {
    pulls++;
    yield { startUs: 0, endUs: 1_000_000, text: 'one', raw: new TextEncoder().encode('00:00:00,000 --> 00:00:01,000') };
    yield { startUs: 1_000_000, endUs: 2_000_000, text: 'two' };
  }
  const track = createTextTrack(source());
  const [a, b] = await Promise.all([
    (async () => { const out = []; for await (const c of track.cues()) out.push(c.text); return out; })(),
    (async () => { const out = []; for await (const c of track.cues()) out.push(c.text); return out; })(),
  ]);
  assert.equal(pulls, 1);
  assert.deepEqual(a, ['one', 'two']);
  assert.deepEqual(b, ['one', 'two']);
  assert.equal(track.cuesUntil(1_500_000).length, 2);
});

test('createTextTrack：泵送未完成时 cuesUntil 不暴露半成品', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  async function* source() {
    yield { startUs: 0, endUs: 1_000_000, text: 'pending' };
    await blocked;
    yield { startUs: 1_000_000, endUs: 2_000_000, text: 'tail' };
  }
  const track = createTextTrack(source());
  const reading = (async () => { const out = []; for await (const c of track.cues()) out.push(c.text); return out; })();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(track.cuesUntil(500_000), []);
  release();
  assert.deepEqual(await reading, ['pending', 'tail']);
  assert.deepEqual(track.cuesUntil(500_000).map((c) => c.text), ['pending']);
});

test('createTextTrack：源失败不提交残留且后续读取稳定拒绝', async () => {
  const failure = new Error('subtitle source failed');
  let pulls = 0;
  async function* source() {
    pulls++;
    yield { startUs: 0, endUs: 1_000_000, text: 'leaked' };
    throw failure;
  }
  const track = createTextTrack(source());
  const consume = async () => {
    for await (const cue of track.cues()) void cue;
  };
  await assert.rejects(consume(), (error) => error === failure);
  assert.deepEqual(track.cuesUntil(1_000_000), []);
  await assert.rejects(consume(), (error) => error === failure);
  assert.equal(pulls, 1);
});

test('createTextTrack：首条 raw 正确推导 codec 且缓存重放一致', async () => {
  const track = createTextTrack([{
    startUs: 0,
    endUs: 1_000_000,
    text: 'vtt',
    raw: new TextEncoder().encode('WEBVTT\n\n00:00:00.000 --> 00:00:01.000'),
  }]);
  const first = [];
  for await (const cue of track.cues()) first.push(cue.text);
  const second = [];
  for await (const cue of track.cues()) second.push(cue.text);
  assert.equal(track.codec, 'x-vtt');
  assert.deepEqual(second, first);
});
