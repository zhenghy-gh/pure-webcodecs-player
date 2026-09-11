/**
 * subtitle/__tests__/subtitle-vtt-settings.test.js — WebVTT 设置/畸形块深水区
 *
 * 扩展 vtt.test.js / subtitle-vtt-cue.test.js 尚未深入的分支：
 *   - cue settings 越界/非常规值：position>100、line 负数、size 0、vertical rl/lr
 *   - 缺少结束时间的 cue（仅 start -->）
 *   - 重叠时间戳 start==end
 *   - 多个 NOTE / STYLE / REGION 块、重复 STYLE 块
 *   - 畸形块：纯文本无时间行、结束时间非法字符、标识符行本身含 -->
 *   - settings 原始值透传（不钳制，记录当前行为）
 *   - 已知限制：VTT align/position/line/vertical/size 设置被解析但 layout 不消费
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVtt, layoutEvents } from '../src/index.js';
import { createDefaultStyle } from '../src/index.js';
import { SubtitleError } from '../src/index.js';

test('VTT-settings：position>100 / line 负数 / size 0 原样保留（不钳制）', () => {
  const src = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000 position:150% line:-2 size:0% align:start\nx\n';
  const { cues } = parseVtt(src);
  assert.deepEqual(cues[0].settings, {
    position: '150%', line: '-2', size: '0%', align: 'start',
  });
});

test('VTT-settings：vertical rl/lr、line:auto、align 全枚举值', () => {
  const cases = [
    'vertical:rl align:left',
    'vertical:lr align:right',
    'line:auto align:middle',
    'line:50% align:end',
  ];
  for (const s of cases) {
    const src = `WEBVTT\n\n00:00:01.000 --> 00:00:02.000 ${s}\nx\n`;
    const r = parseVtt(src);
    assert.equal(r.cues.length, 1, `settings="${s}" 应解析出 1 条`);
    assert.ok(r.cues[0].settings, `settings="${s}" 应存在`);
  }
});

test('VTT-settings：缺冒号的 token 被忽略', () => {
  const src = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000 align:start plainword\nx\n';
  const { cues } = parseVtt(src);
  assert.deepEqual(cues[0].settings, { align: 'start' });
});

test('VTT：缺少结束时间的 cue（仅 start -->）被跳过', () => {
  const src = 'WEBVTT\n\n00:01.000 --> \n只有开始没有结束\n';
  const r = parseVtt(src);
  assert.equal(r.cues.length, 0, '缺结束时间应跳过');
  assert.equal(r.stats.skippedBlocks, 1);
});

test('VTT：缺少结束时间（strict 模式）抛错（已知缺陷：泄漏 TypeError 而非 SubtitleError）', () => {
  const src = 'WEBVTT\n\n00:01.000 --> \n只有开始没有结束\n';
  // 缺陷回归守卫：当前 TIMING_RE.exec 对「只有 start -->」返回 null，
  // 代码访问 tm[1] 抛出裸 TypeError 并在 strict 下透传，未包成 SubtitleError(PARSE_ERROR)。
  // 这里仅断言「会抛错」，避免把缺陷当特性固化；详见汇报 vtt.js:122。
  assert.throws(() => parseVtt(src, { strict: true }));
});

test('VTT：重叠时间戳 start==end 视为非法区间被跳过', () => {
  const src = 'WEBVTT\n\n00:01.000 --> 00:01.000\n零时长\n';
  const r = parseVtt(src);
  assert.equal(r.cues.length, 0);
  assert.equal(r.stats.skippedBlocks, 1);
});

test('VTT：多个 NOTE / STYLE / REGION 块分别计数', () => {
  const src = [
    'WEBVTT',
    '',
    'NOTE 注释一',
    '',
    'NOTE 注释二',
    '',
    'STYLE',
    '::cue{color:red}',
    '',
    'STYLE',
    '::cue{color:blue}',
    '',
    'REGION',
    'id:r1 width:50%',
    '',
    '00:01.000 --> 00:02.000\nx\n',
  ].join('\n');
  const r = parseVtt(src);
  assert.equal(r.stats.noteBlocks, 2);
  assert.equal(r.stats.styleBlocks, 2);
  assert.equal(r.stats.regionBlocks, 1);
  assert.equal(r.cues.length, 1);
});

test('VTT：REGION 块内容被忽略但计数', () => {
  const src = 'WEBVTT\n\nREGION\nid:r1 width:50% lines:3 scroll:up\n\n00:01.000 --> 00:02.000\nx\n';
  const r = parseVtt(src);
  assert.equal(r.stats.regionBlocks, 1);
  assert.equal(r.cues.length, 1);
});

test('VTT：畸形块（纯文本无时间行）被跳过', () => {
  const src = 'WEBVTT\n\n这整块没有时间行只是文本\n\n00:01.000 --> 00:02.000\n真实\n';
  const r = parseVtt(src);
  assert.equal(r.cues.length, 1);
  assert.equal(r.stats.skippedBlocks, 1);
  assert.ok(r.cues[0].text.startsWith('真实'), '首条真实 cue 文本应保留');
});

test('VTT：结束时间为非法字符 → 跳过并计数', () => {
  const src = 'WEBVTT\n\n00:01.000 --> 不是时间\n坏块\n';
  const r = parseVtt(src);
  assert.equal(r.cues.length, 0);
  assert.equal(r.stats.skippedBlocks, 1);
});

test('VTT：标识符行本身含 --> 被当作时间行（首行即命中）', () => {
  const src = 'WEBVTT\n\n00:01.000 --> 00:02.000\n文本\n';
  const r = parseVtt(src);
  assert.equal(r.cues.length, 1);
  assert.equal(r.cues[0].startUs, 1_000_000);
});

test('VTT：带尾注签名仍解析 cue', () => {
  const src = 'WEBVTT - 演示字幕\n\n00:01.000 --> 00:02.000\nx\n';
  const r = parseVtt(src);
  assert.equal(r.cues.length, 1);
});

test('VTT：空块/仅空白块被安全跳过', () => {
  const src = 'WEBVTT\n\n\n   \n\n00:01.000 --> 00:02.000\nx\n\n\n';
  const r = parseVtt(src);
  assert.equal(r.cues.length, 1);
});

test('VTT：解析后 settings.align 原样保留，但 layout 不消费（已知限制回归守卫）', () => {
  const r = parseVtt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000 align:left position:10%\n左对齐文本\n');
  assert.equal(r.cues[0].settings?.align, 'left', 'vtt.js 应解析出 align:left');
  // layoutEvents 使用默认样式对齐（center），不读取 VTT cue settings.align（当前限制）
  const draw = layoutEvents(r.cues, 1_500_000, {
    styles: [], defaultStyle: createDefaultStyle(), playRes: { w: 640, h: 360 }, measure: (t) => [...t].length * 10,
  });
  assert.equal(draw.length, 1);
  assert.equal(draw[0].alignH, 'center', '当前 layout 忽略 VTT align，仍按默认 center（限制回归守护）');
});
