/**
 * samples/fixtures/subtitles.js —— 字幕模块测试用文本常量。
 * 均含中文与多行文本，覆盖常见语法要素；解析器按真实格式应可读出时间轴与内容。
 */

/** SRT：2 条 cue，第 2 条含两行文本 */
export const SAMPLE_SRT = `1
00:00:01,000 --> 00:00:03,500
大家好，欢迎来到纯前端播放器。

2
00:00:04,000 --> 00:00:07,250
第二行字幕：
支持换行与中文标点。
`;

/** WebVTT：头部 + NOTE + 2 条 cue（第 2 条带定位设置） */
export const SAMPLE_VTT = `WEBVTT

NOTE 这是一段注释
解析器应跳过。

00:00:01.000 --> 00:00:03.500
大家好，欢迎来到<b>纯前端播放器</b>。

intro-2
00:00:04.000 --> 00:00:07.250 line:80% align:center
WebVTT 支持 Cue Identifier、内联标签与定位。
`;

/** ASS/SSA（v4+ 格式）：Script Info + 单个 Style + 2 条 Dialogue（含 {\i1} 覆写标签） */
export const SAMPLE_ASS = `[Script Info]
; 由 samples/fixtures 程序化生成
Title: 纯前端播放器测试字幕
ScriptType: v4.00+
WrapStyle: 0
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,思源黑体,64,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,2,60,60,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,大家好，欢迎来到{\\i1}纯前端播放器{\\i0}。
Dialogue: 0,0:00:04.00,0:00:07.25,Default,,0,0,0,,第二句：ASS 时间轴精度为厘秒。`;
