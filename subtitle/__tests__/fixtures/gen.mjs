/**
 * subtitle/__tests__/fixtures/gen.mjs — 程序化生成字幕 fixture（原子写盘）
 * 样例集合：basic/messy/broken × SRT、basic/blocks × VTT、styled/broken × ASS。
 * 内容与各 .test.js 断言一一对应；缺失时由 helpers.ensureFixtures 现场重建。
 */
import path from 'node:path';

/** 原子写盘：避免并行 ensureFixtures 时读到半截文件（竞态加固） */
async function atomicWrite(file, data) {
  const { writeFile, rename } = await import('node:fs/promises');
  const tmp = file + '.tmp-' + process.pid;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

const SRT_BASIC = [
  '1',
  '00:00:01,000 --> 00:00:03,000',
  '第一条台词',
  '',
  '2',
  '00:00:03,500 --> 00:00:06,000',
  '第二段字幕',
  '可以多行显示',
  '',
  '3',
  '00:00:06,500 --> 00:00:09,000',
  '<i>带斜体标签</i>',
  '',
].join('\n');

/* BOM + CRLF + 点分隔 + 缺小时位 + 逗号毫秒 + 坐标段尾巴 + 非连续序号 */
const SRT_MESSY =
  '\uFEFF10\r\n' +
  '00:00.500 --> 00:02.000 X1:40 X2:600 Y1:20 Y2:50\r\n' +
  '缺小时位与点分隔\r\n\r\n' +
  '11\r\n' +
  '00:02,500 --> 00:04,000\r\n' +
  '逗号毫秒\r\n';

/* 4 块：1 好 + 3 坏（lenient 跳过计数且首警告以「已跳过」结尾 / strict 抛 PARSE_ERROR） */
const SRT_BROKEN = [
  '1',
  '00:00:01,000 --> 00:00:02,000',
  '好的台词',
  '',
  '2',
  'XX:YY:ZZ,mmm --> 00:00:05,000',
  '坏块一（时间行非法字符）',
  '',
  '3',
  '00:00:05,000 --> ',
  '坏块二（结束时间缺失）',
  '',
  '4',
  '00:00:06,0001 --> 00:00:07,000',
  '坏块三（毫秒四位）',
].join('\n');

const VTT_BASIC = [
  'WEBVTT',
  'Kind: captions',
  'Language: zh-CN',
  '',
  'NOTE 这是一条注释块，应被跳过并计数',
  '',
  'intro',
  '00:00:00.500 --> 00:00:02.500 align:start position:10%',
  '第一条（带 cue settings）',
  '',
  'c2',
  '00:00:03.000 --> 00:00:06.000',
  '<v 张三>语音标签样例</v>',
  '',
].join('\n');

const VTT_BLOCKS = [
  'WEBVTT',
  '',
  'STYLE',
  '::cue { color: yellow }',
  '',
  'REGION',
  'id:r1 width:50% lines:2',
  '',
  '00:05.000 --> 00:07,500',
  '缺小时位 + 逗号毫秒混用',
  '',
  '00:08.000 --> 00:10.000',
  '第二条台词',
  '',
].join('\n');

/* styled：2 样式 + 5 Dialogue + 1 Comment；覆盖 pos/an/fad/move/fs+/fsp/未支持 bord,k/\N/\h */
const ASS_STYLED = [
  '[Script Info]',
  'Title: PurePlay 功能演示',
  'PlayResX: 640',
  'PlayResY: 360',
  'ScaledBorderAndShadow: yes',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,思源黑体,48,&H00FFFFFF,&H000000FF,&H00101010,&H7F000000,-1,0,0,0,100,100,0,0,1,2,2,2,20,20,30,1',
  'Style: Top,思源宋体,36,&H0020E0FF,&H000000FF,&H00000000,&H00000000,0,-1,0,0,80,120,1,0,1,1,0,8,10,10,16,1',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Comment: 本行为注释，计数但不进入轨道',
  'Dialogue: 0,0:00:00.50,0:00:03.00,Default,,0,0,0,,普通台词,半角逗号保留',
  'Dialogue: 1,0:00:03.50,0:00:06.00,Default,,0,0,0,,{\\pos(320,50)\\an5\\fad(200,300)}几何覆盖标签',
  'Dialogue: 0,0:00:06.50,0:00:09.00,Default,,0,0,0,,{\\fs+8\\fsp2\\bord3\\k15}字号叠加与字间距',
  'Dialogue: 1,0:00:09.50,0:00:12.00,Top,,0,0,0,,{\\move(100,300,500,100,0,0)}移动台词\\N第二行\\h硬空格',
  'Dialogue: 0,0:00:12.50,0:00:15.00,Ghost,,0,0,0,,引用不存在样式',
  '',
].join('\n');

/* broken：1 正常 + 1 畸形时间码（lenient 跳过 / strict 抛 PARSE_ERROR） */
const ASS_BROKEN = [
  '[Script Info]',
  'PlayResX: 640',
  'PlayResY: 360',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,sans-serif,48,&H00FFFFFF,&H000000FF,&H00101010,&H7F000000,-1,0,0,0,100,100,0,0,1,2,2,2,20,20,30,1',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:00.50,0:00:02.00,Default,,0,0,0,,正常台词',
  'Dialogue: 0,0:00:XX.YY,0:00:03.00,Default,,0,0,0,,坏时间码台词',
  '',
].join('\n');

const FILES = {
  'sample-basic.srt': SRT_BASIC,
  'sample-messy.srt': SRT_MESSY,
  'sample-broken.srt': SRT_BROKEN,
  'sample-basic.vtt': VTT_BASIC,
  'sample-blocks.vtt': VTT_BLOCKS,
  'sample-styled.ass': ASS_STYLED,
  'sample-broken.ass': ASS_BROKEN,
};

export async function generate(dir) {
  await import('node:fs/promises').then(fs => fs.mkdir(dir, { recursive: true }));
  for (const [name, content] of Object.entries(FILES)) {
    await atomicWrite(path.join(dir, name), content);
  }
}
if (process.argv[1] && process.argv[1].endsWith('gen.mjs')) {
  generate(process.argv[2] || new URL('.', import.meta.url).pathname)
    .then(() => console.log('fixtures written:', Object.keys(FILES).length));
}
