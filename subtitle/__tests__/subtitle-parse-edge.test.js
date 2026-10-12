/**
 * subtitle/__tests__/subtitle-parse-edge.test.js — 三格式解析边界 + 时间/工具回归
 *
 * 深化 vtt.js / srt.js / ass.js 在 src 现有测试中仍未触达的错误/边界分支：
 *   - vtt：无 settings 时 cue.settings===undefined；首字符冒号 token 被忽略；
 *          严格模式缺时间行抛 PARSE_ERROR；NOTE 负向前瞻（NOTEPAD 不算 NOTE）
 *   - srt：严格模式 end<=start 抛 PARSE_ERROR；非数字序号行记警告但照常解析
 *   - ass：空输入 PARSE_ERROR；注释行(;)跳过；Style 字段数不足跳过；
 *          非法颜色值进入 catch 回退默认；Dialogue 字段数不足跳过
 *   - time：纯空白/空串 parseTimestamp 抛 PARSE_ERROR（padEnd 修复回归）
 *   - cue：cuesDurationUs 极值；layout：approximateMeasure 字间距叠加
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVtt, parseSrt, parseAss, SubtitleError,
  parseTimestamp, cuesDurationUs, approximateMeasure,
} from '../src/index.js';

/* ---------------- VTT 边界 ---------------- */

test('VTT：时间行无 settings 时 cue.settings 为 undefined', () => {
  const r = parseVtt('WEBVTT\n\n00:01.000 --> 00:02.000\n台词');
  assert.equal(r.cues[0].settings, undefined, '未带 cue settings 应为 undefined');
});

test('VTT：settings 中首字符冒号 token（:foo）被忽略', () => {
  const r = parseVtt('WEBVTT\n\n00:01.000 --> 00:02.000 :foo align:start\n台词');
  assert.deepEqual(r.cues[0].settings, { align: 'start' });
});

test('VTT：strict 模式缺时间行块抛 PARSE_ERROR', () => {
  const src = 'WEBVTT\n\n这块没有时间行就垃圾\n';
  assert.throws(
    () => parseVtt(src, { strict: true }),
    (e) => e instanceof SubtitleError && e.code === 'PARSE_ERROR',
  );
});

test('VTT：NOTE 负向前瞻——NOTEPAD 不算 NOTE（作为标识符容忍）', () => {
  const src = 'WEBVTT\n\nNOTEPAD 不是注释\n00:01.000 --> 00:02.000\n台词\n';
  const r = parseVtt(src);
  assert.equal(r.stats.noteBlocks, 0, 'NOTEPAD 不应被吞为 NOTE 块');
  assert.equal(r.cues.length, 1, '首行被当作 cue identifier 容忍');
});

test('VTT：真实 NOTE 块仍计数（对照）', () => {
  const r = parseVtt('WEBVTT\n\nNOTE\n这是注释\n\n00:01.000 --> 00:02.000\n台词\n');
  assert.equal(r.stats.noteBlocks, 1);
});

/* ---------------- SRT 边界 ---------------- */

test('SRT：strict 模式 end<=start 抛 PARSE_ERROR', () => {
  const src = '1\n00:00:02,000 --> 00:00:01,000\n台词\n';
  assert.throws(
    () => parseSrt(src, { strict: true }),
    (e) => e instanceof SubtitleError && e.code === 'PARSE_ERROR',
  );
});

test('SRT：非数字序号行记警告但仍解析', () => {
  const r = parseSrt('abc\n00:00:01,000 --> 00:00:02,000\n台词\n');
  assert.equal(r.cues.length, 1);
  assert.ok(r.stats.warnings.some((w) => w.includes('序号行')), '非数字序号应记警告');
});

/* ---------------- ASS 边界 ---------------- */

test('ASS：strict 拒绝重复 Script Info 键，lenient 仍以后值覆盖', () => {
  const src = '[Script Info]\nPlayResX: 640\nplayresx: 1280\nPlayResY: 360';
  assert.throws(() => parseAss(src, { strict: true }), (error) =>
    error instanceof SubtitleError && error.code === 'PARSE_ERROR' &&
    error.detail.field === 'playresx' && error.detail.line === 3);
  const lenient = parseAss(src);
  assert.equal(lenient.info.playResX, 1280);
  assert.equal(lenient.info.playResY, 360);
});

test('ASS：strict 校验 PlayResX/Y 为正安全整数，lenient 保留宽松解析', () => {
  for (const field of ['PlayResX', 'PlayResY']) {
    for (const value of ['640px', 'oops', '0', '-10', '9007199254740992']) {
      const src = ['[Script Info]', field + ': ' + value].join('\n');
      assert.throws(() => parseAss(src, { strict: true }), (error) =>
        error instanceof SubtitleError && error.code === 'PARSE_ERROR' &&
        error.detail.field === field.toLowerCase());
    }
  }
  const valid = parseAss('[Script Info]\nPlayResX: 640\nPlayResY: 360', { strict: true });
  assert.equal(valid.info.playResX, 640);
  assert.equal(valid.info.playResY, 360);
  assert.equal(parseAss('[Script Info]\nPlayResX: 640px').info.playResX, 640);
});

test('ASS：空输入抛 PARSE_ERROR', () => {
  assert.throws(() => parseAss(''), (e) => e instanceof SubtitleError && e.code === 'PARSE_ERROR');
});

test('ASS：注释行（; 开头）跳过且后续 Key:Value 仍解析', () => {
  const r = parseAss('[Script Info]\n; 这是注释\nTitle: t\n');
  assert.equal(r.info.title, 't');
});

test('ASS：Style 字段数少于 Format 声明 → lenient 跳过并计数', () => {
  const src = [
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, Strikeout, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: A',
    '',
  ].join('\n');
  const r = parseAss(src);
  assert.equal(r.styles.length, 0, '字段不足应跳过该 Style');
  assert.ok(r.stats.skippedBlocks >= 1);
});

test('ASS：Style 含非法颜色值 → catch 回退默认 primary 并记警告', () => {
  const src = [
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour',
    'Style: Bad, Arial, 40, notacolor',
    '',
  ].join('\n');
  const r = parseAss(src);
  assert.equal(r.styles.length, 1, '仍应创建样式对象');
  assert.deepEqual(r.styles[0].primary, { r: 255, g: 255, b: 255, alpha: 1 }, '非法颜色回退默认白');
  assert.ok(r.stats.warnings.length >= 1, '应记录颜色解析失败警告');
});

test('ASS：Style 非法颜色 strict 模式抛带 cause 的 PARSE_ERROR', () => {
  const src = [
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour',
    'Style: Bad,Arial,20,notacolor',
  ].join('\n');
  assert.throws(() => parseAss(src, { strict: true }), (error) =>
    error instanceof SubtitleError && error.code === 'PARSE_ERROR' &&
    error.detail.line === 3 && error.cause?.code === 'PARSE_ERROR');
});

test('ASS：Style strict 拒绝带尾随字符的数字/布尔字段，lenient 继续兼容', () => {
  const cases = [
    ['Fontsize', '40px'],
    ['Bold', '1foo'],
    ['Angle', 'NaN'],
    ['Alignment', '2.5'],
  ];
  for (const [field, value] of cases) {
    const src = [
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, Bold, Angle, Alignment',
      'Style: Bad,Arial,20,0,0,2',
    ];
    const columns = src[1].slice(src[1].indexOf(':') + 1).split(',').map((name) => name.trim());
    const values = src[2].slice(src[2].indexOf(':') + 1).split(',');
    values[columns.indexOf(field)] = value;
    src[2] = 'Style:' + values.join(',');
    const input = src.join('\n');
    assert.throws(() => parseAss(input, { strict: true }), (error) =>
      error instanceof SubtitleError && error.code === 'PARSE_ERROR' &&
      error.cause?.detail?.field === field.toLowerCase());
  }
  const lenient = parseAss([
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, Bold, Angle',
    'Style: Bad,Arial,40px,1foo,NaN',
  ].join('\n'));
  assert.equal(lenient.styles[0].fontsize, 40);
  assert.equal(lenient.styles[0].bold, true);
  assert.equal(lenient.stats.warnings.length, 0);
});

test('ASS：strict 拒绝零字号/非正缩放和负几何值，保留负字号/字距/角度', () => {
  const format = 'Name, Fontname, Fontsize, ScaleX, ScaleY, Outline, Shadow, MarginL, Spacing, Angle';
  const columns = format.split(',').map((name) => name.trim().toLowerCase());
  const baseValues = ['Good', 'Arial', '24', '100', '100', '2', '2', '10', '0', '0'];
  const cases = [
    ['fontsize', '0'], ['fontsize', '0.0'], ['fontsize', '-0'], ['scalex', '0'], ['scalex', '-100'],
    ['scaley', '0'], ['scaley', '-100'], ['outline', '-2'], ['shadow', '-1'],
    ['marginl', '-4'],
  ];
  for (const [field, value] of cases) {
    const values = baseValues.slice();
    values[columns.indexOf(field)] = value;
    const input = ['[V4+ Styles]', 'Format: ' + format, 'Style: ' + values.join(',')].join('\n');
    assert.throws(() => parseAss(input, { strict: true }), (error) =>
      error instanceof SubtitleError && error.code === 'PARSE_ERROR' &&
      error.cause?.detail?.field === field);
  }
  const valid = baseValues.slice();
  valid[columns.indexOf('fontsize')] = '-10';
  valid[columns.indexOf('spacing')] = '-1';
  valid[columns.indexOf('angle')] = '-30';
  const result = parseAss(['[V4+ Styles]', 'Format: ' + format, 'Style: ' + valid.join(',')].join('\n'), { strict: true });
  assert.equal(result.styles[0].fontsize, -10);
  assert.equal(result.styles[0].spacing, -1);
  assert.equal(result.styles[0].angle, -30);
  const lenient = parseAss(['[V4+ Styles]', 'Format: ' + format, 'Style: ' + baseValues.map((value, index) => index === columns.indexOf('fontsize') ? '0' : value).join(',')].join('\n'));
  assert.equal(lenient.styles[0].fontsize, 0);
});

test('ASS：Style strict 拒绝超宽/越界颜色；lenient 保留既有掩码兼容', () => {
  for (const value of ['&H123456789ABC&', '16777216', '999999999999999999999999999']) {
    const src = [
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour',
      'Style: Bad,Arial,20,' + value,
    ].join('\n');
    assert.throws(() => parseAss(src, { strict: true }), (error) =>
      error instanceof SubtitleError && error.code === 'PARSE_ERROR' &&
      error.cause?.detail?.field === 'primarycolour');
  }
  const lenient = parseAss([
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour',
    'Style: Bad,Arial,20,&H123456789ABC&',
  ].join('\n'));
  assert.equal(lenient.styles[0].primary.r, 0xbc);
});

test('ASS：Style strict 拒绝越界 Alignment 和非标准 BorderStyle，保留 SSA 11', () => {
  for (const [field, value] of [['Alignment', '0'], ['Alignment', '10'], ['BorderStyle', '2']]) {
    const src = [
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, BorderStyle, Alignment',
      'Style: Bad,Arial,20,1,2',
    ];
    const columns = src[1].slice(src[1].indexOf(':') + 1).split(',').map((name) => name.trim());
    const values = src[2].slice(src[2].indexOf(':') + 1).split(',');
    values[columns.indexOf(field)] = value;
    src[2] = 'Style:' + values.join(',');
    assert.throws(() => parseAss(src.join('\n'), { strict: true }), (error) =>
      error instanceof SubtitleError && error.code === 'PARSE_ERROR');
  }
  const accepted = parseAss([
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, BorderStyle, Alignment',
    'Style: Good,Arial,20,3,9',
  ].join('\n'), { strict: true });
  assert.equal(accepted.styles[0].borderStyle, 3);
  assert.equal(accepted.styles[0].alignment, 9);
  const legacy = parseAss([
    '[V4 Styles]',
    'Format: Name, Fontname, Fontsize, BorderStyle, Alignment',
    'Style: Legacy,Arial,20,1,11',
  ].join('\n'), { strict: true });
  assert.equal(legacy.styles[0].alignment, 6, 'SSA V4 alignment 11 maps to ASS middle-right');
});

test('ASS：strict 拒绝空列或重复列的 Style/Events Format', () => {
  const cases = [
    ['[V4+ Styles]', 'Format: Name, Fontname, Fontsize, Bold, Bold', 'Style: A,Arial,20,0,1'],
    ['[V4+ Styles]', 'Format: Name, , Fontsize, Bold', 'Style: A,Arial,20,1'],
    ['[Events]', 'Format: Layer, Start, Start, End, Style, Text', 'Dialogue: 0,0:00:01.00,0:00:02.00,0:00:03.00,Default,hello'],
    ['[Events]', 'Format: Layer, Start, End, , Style, Text', 'Dialogue: 0,0:00:01.00,0:00:02.00,,Default,hello'],
  ];
  for (const [section, format, record] of cases) {
    const src = [section, format, record].join('\n');
    assert.throws(() => parseAss(src, { strict: true }), (error) =>
      error instanceof SubtitleError && error.code === 'PARSE_ERROR' && error.detail.line === 2);
  }
  const lenient = parseAss([
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, Bold, Bold',
    'Style: A,Arial,20,0,1',
  ].join('\n'));
  assert.equal(lenient.styles[0].bold, true);
});

test('ASS：Text 在末列前仍保留逗号并按尾部列解析', () => {
  const src = [
    '[Events]',
    'Format: Layer, Text, Start, End, Style',
    'Dialogue: 0,Hello, world,0:00:01.00,0:00:02.00,Default',
  ].join('\n');
  for (const strict of [false, true]) {
    const cue = parseAss(src, { strict }).cues[0];
    assert.equal(cue.text, 'Hello, world');
    assert.equal(cue.startUs, 1_000_000);
    assert.equal(cue.endUs, 2_000_000);
    assert.equal(cue.style, 'Default');
  }
  const emptyText = parseAss([
    '[Events]',
    'Format: Layer, Text, Start, End, Style',
    'Dialogue: 0,,0:00:01.00,0:00:02.00,Default',
  ].join('\n'), { strict: true }).cues[0];
  assert.equal(emptyText.text, '');
  assert.equal(emptyText.startUs, 1_000_000);
});

test('ASS：重复节不会继承前一节的 Format 列序', () => {
  const events = [
    '[Events]',
    'Format: Text, Start, End',
    'Dialogue: first,0:00:01.00,0:00:02.00',
    '[Events]',
    'Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,second',
  ].join('\n');
  const parsedEvents = parseAss(events);
  assert.deepEqual(parsedEvents.cues.map((cue) => cue.text), ['first', 'second']);

  const styles = [
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize',
    'Style: Compact,Arial,20',
    '[V4+ Styles]',
    'Style: Full,Arial,24,&H000000FF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1',
  ].join('\n');
  const parsedStyles = parseAss(styles);
  assert.equal(parsedStyles.styles[1].name, 'Full');
  assert.equal(parsedStyles.styles[1].primary.r, 255);
  assert.equal(parsedStyles.styles[1].primary.g, 0);
});

test('ASS：strict 拒绝缺失 Style/Events Format，lenient 沿用默认列序', () => {
  const style = [
    '[V4+ Styles]',
    'Style: Default,Arial,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1',
  ].join('\n');
  const events = ['[Events]', 'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,hello'].join('\n');
  assert.throws(() => parseAss(style, { strict: true }), (error) =>
    error instanceof SubtitleError && error.code === 'PARSE_ERROR' && error.detail.line === 2);
  assert.throws(() => parseAss(events, { strict: true }), (error) =>
    error instanceof SubtitleError && error.code === 'PARSE_ERROR' && error.detail.line === 2);
  assert.equal(parseAss(style).styles.length, 1);
  assert.equal(parseAss(events).cues[0].text, 'hello');
});

test('ASS：strict Dialogue Margin 必须为非负安全整数', () => {
  const format = 'Layer, Start, End, MarginL, MarginR, MarginV, Text';
  const make = (field, value) => {
    const margins = { marginl: '0', marginr: '0', marginv: '0', [field]: value };
    return ['[Events]', 'Format: ' + format,
      'Dialogue: 0,0:00:01.00,0:00:02.00,' + margins.marginl + ',' + margins.marginr + ',' + margins.marginv + ',cue',
    ].join('\n');
  };
  for (const field of ['marginl', 'marginr', 'marginv']) {
    for (const value of ['1.5', '-4', '12px', '9007199254740992']) {
      assert.throws(() => parseAss(make(field, value), { strict: true }), (error) =>
        error instanceof SubtitleError && error.code === 'PARSE_ERROR' &&
        error.detail.field === field && error.detail.value === value);
    }
  }
  const valid = parseAss([
    '[Events]', 'Format: ' + format,
    'Dialogue: 0,0:00:01.00,0:00:02.00,10,20,30,cue',
  ].join('\n'), { strict: true });
  assert.deepEqual(valid.cues[0].settings, { name: '', effect: '', mL: '10', mR: '20', mV: '30' });
  assert.equal(parseAss(make('marginl', '12px')).cues[0].settings.mL, '12px');
});

test('ASS：strict Dialogue Layer 必须是安全整数，lenient 保留前缀兼容', () => {
  const make = (layer) => [
    '[Events]',
    'Format: Layer, Start, End, Text',
    'Dialogue: ' + layer + ',0:00:01.00,0:00:02.00,cue',
  ].join('\n');
  for (const value of ['2abc', '1.5', '9007199254740992', '']) {
    assert.throws(() => parseAss(make(value), { strict: true }), (error) =>
      error instanceof SubtitleError && error.code === 'PARSE_ERROR' &&
      error.detail.line === 3 && error.detail.field === 'layer' && error.detail.value === value);
  }
  assert.equal(parseAss(make('-2'), { strict: true }).cues[0].layer, -2);
  assert.equal(parseAss(make('+2'), { strict: true }).cues[0].layer, 2);
  assert.equal(parseAss(make('2abc')).cues[0].layer, 2);
  assert.equal(parseAss(make('1.5')).cues[0].layer, 1);
});

test('ASS：strict 拒绝大小写冲突的重复 Style 名，lenient 保留顺序', () => {
  const src = [
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize',
    'Style: Default,Arial,20',
    'Style: default,Serif,40',
    '[Events]',
    'Format: Layer, Start, End, Style, Text',
    'Dialogue: 0,0:00:01.00,0:00:02.00,DEFAULT,ambiguous',
  ].join('\n');
  assert.throws(() => parseAss(src, { strict: true }), (error) =>
    error instanceof SubtitleError && error.code === 'PARSE_ERROR' &&
    error.detail.line === 4 && error.detail.field === 'name' && error.detail.value === 'default');
  const lenient = parseAss(src);
  assert.deepEqual(lenient.styles.map((style) => style.name), ['Default', 'default']);
  assert.equal(lenient.cues[0].style, 'Default');
});

test('ASS：strict Dialogue 缺失或空 Style 时仍回退样式表', () => {
  const styles = [
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize',
    'Style: Custom,Arial,24',
  ];
  const withoutStyleColumn = parseAss([
    ...styles, '[Events]', 'Format: Layer, Start, End, Text',
    'Dialogue: 0,0:00:01.00,0:00:02.00,no style column',
  ].join('\n'), { strict: true });
  assert.equal(withoutStyleColumn.cues[0].style, 'Custom');
  assert.equal(withoutStyleColumn.cues[0].text, 'no style column');

  const emptyStyle = parseAss([
    ...styles, '[Events]', 'Format: Layer, Start, End, Style, Text',
    'Dialogue: 0,0:00:01.00,0:00:02.00,,empty style',
  ].join('\n'), { strict: true });
  assert.equal(emptyStyle.cues[0].style, 'Custom');
  assert.equal(emptyStyle.cues[0].text, 'empty style');

  const explicitDefault = parseAss([
    ...styles, 'Style: Default,Serif,18', '[Events]',
    'Format: Layer, Start, End, Style, Text',
    'Dialogue: 0,0:00:01.00,0:00:02.00,,empty style',
  ].join('\n'), { strict: true });
  assert.equal(explicitDefault.cues[0].style, 'Default');
});

test('ASS：strict 拒绝未知 Dialogue Style，lenient 保留首样式回退', () => {
  const src = [
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize',
    'Style: Custom,Arial,24',
    '[Events]',
    'Format: Layer, Start, End, Style, Text',
    'Dialogue: 0,0:00:01.00,0:00:02.00,Missing,unknown style',
  ].join('\n');
  assert.throws(() => parseAss(src, { strict: true }), (error) =>
    error instanceof SubtitleError && error.code === 'PARSE_ERROR' &&
    error.detail.field === 'style' && error.detail.value === 'Missing');
  const lenient = parseAss(src);
  assert.equal(lenient.cues[0].style, 'Custom');
  assert.equal(lenient.cues[0].text, 'unknown style');

  const noStyles = parseAss([
    '[Events]',
    'Format: Layer, Start, End, Style, Text',
    'Dialogue: 0,0:00:01.00,0:00:02.00,Default,no style section',
  ].join('\n'), { strict: true });
  assert.equal(noStyles.cues[0].style, 'Default');
});

test('ASS：strict Dialogue Format 缺少 Start/End/Text 时拒绝', () => {
  const cases = [
    ['Layer, End, Text', 'Dialogue: 0,0:00:02.00,hello'],
    ['Layer, Start, Text', 'Dialogue: 0,0:00:01.00,hello'],
    ['Layer, Start, End, Style', 'Dialogue: 0,0:00:01.00,0:00:02.00,Default'],
  ];
  for (const [format, dialogue] of cases) {
    const src = ['[Events]', 'Format: ' + format, dialogue].join('\n');
    assert.throws(() => parseAss(src, { strict: true }), (error) =>
      error instanceof SubtitleError && error.code === 'PARSE_ERROR' &&
      error.detail.missing.length === 1);
  }
  const valid = parseAss([
    '[Events]',
    'Format: Layer, Start, End, Text',
    'Dialogue: 0,0:00:01.00,0:00:02.00,hello',
  ].join('\n'), { strict: true });
  assert.equal(valid.cues[0].text, 'hello');
});

test('ASS：Dialogue 字段数少于 Format 声明 → lenient 跳过并计数', () => {
  const src = [
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.00,0:00:02.00',
    '',
  ].join('\n');
  const r = parseAss(src);
  assert.equal(r.stats.dialogueCount, 0);
  assert.ok(r.stats.skippedBlocks >= 1);
});

/* ---------------- time.js 回归 ---------------- */

test('parseTimestamp：纯空白串抛 PARSE_ERROR', () => {
  assert.throws(() => parseTimestamp('   '), (e) => e instanceof SubtitleError && e.code === 'PARSE_ERROR');
});

test('parseTimestamp：空串抛 PARSE_ERROR', () => {
  assert.throws(() => parseTimestamp(''), (e) => e instanceof SubtitleError && e.code === 'PARSE_ERROR');
});

/* ---------------- cue / layout 工具 ---------------- */

test('cuesDurationUs：空数组为 0，非空取最大 endUs', () => {
  assert.equal(cuesDurationUs([]), 0);
  assert.equal(cuesDurationUs([
    { startUs: 0, endUs: 5_000_000, text: 'a' },
    { startUs: 0, endUs: 9_000_000, text: 'b' },
  ]), 9_000_000);
});

test('approximateMeasure：字间距按 (len-1) 叠加', () => {
  // AB 两个 ASCII：2*0.5*10 + (2-1)*2 = 10 + 2 = 12
  assert.equal(approximateMeasure('AB', { fontSize: 10, spacing: 2 }), 12);
  assert.equal(approximateMeasure('中', { fontSize: 10, spacing: 0 }), 10);
});
