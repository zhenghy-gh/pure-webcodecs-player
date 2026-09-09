# PurePlay · subtitle —— SRT/WebVTT/ASS 字幕解析与 Canvas 渲染
> 状态：✅ 已交付 · 测试 93 例 全绿（node --test subtitle/__tests__/*.test.js）· SRT/VTT/ASS 解析 + 排版求解 + Canvas 渲染（designer 参考实现为权威） · 更新 2026-08-26

> 归属：**ui-kit-dev**（维护者，2025-08-25 派发令；designer 交付版本为参考实现，已随注释移交）
> ｜ 契约基线：docs/CONTRACTS.md v0.2（E-8 口径）｜ 设计依据：docs/design/视觉规范.md v1.0（§7 字幕叠加）
> 状态：解析层硬验收（SRT/VTT 必做、ASS 尽力）；渲染走 JS 排版求解器 + Canvas 2D
> cue 数据结构对齐：当前 `{startUs,endUs,text,layer,style,settings}` 为本模块约定；
>   architect 的字幕轨 Track/Sample 接口定稿后按 CONTRACTS 对齐（待对齐点：字段命名、
>   Sample.data 承载形态、多轨 id 分配），对齐前以 README 本节为准（任务书 T4 允许先行）。
> 整合记录（ui-kit-dev · 2026-08-25）：①并行期产生的重复解析器已删除，src 以 designer 版为权威；
> ②errors.js 合并 SubtitleError（主）与 PlayerError（兼容别名）双体系，93 项单测全绿；
>   （S1 收口更新：SubtitleError 已 extends core PlayerError，ErrorCode 为 core 十码封闭枚举）；
> ③demo 保持 --pp-*/.pp-* 皮肤家族（视觉规范 §1.6 双皮肤冻结边界内），接 site/skin.css + site/skin.js。

## 一、原理与可行性结论

字幕是「文本进、文本出」的格式族，浏览器原生支持极弱（`<track>` 只认 WebVTT 且无 ASS 特效），
但纯前端实现完全可行且无网络沙箱问题——解析在主进程内存中完成，渲染用 Canvas 2D 叠加层。
与 docs/00-需求与可行性结论.md 的结论一致：`subtitle.js ✅ 可纯前端（难度低），libass-wasm 作可选增强`。

三种格式的核心结构：

| 格式 | 结构要点 | 时间码 | 样式能力 |
|------|---------|--------|----------|
| SRT | 序号行 + `-->` 时间行 + 文本块，空行分块 | `HH:MM:SS,mmm` | 无（仅内联 HTML 标签习惯） |
| WebVTT | `WEBVTT` 签名头 + NOTE/STYLE/REGION 块 + cue | `HH:MM:SS.mmm` | cue settings 定位 + 内联标签 |
| ASS/SSA | INI 风格节：Script Info / V4(+ ) Styles / Events | `H:MM:SS.cc` 厘秒 | Style 表 + 行内覆盖标签 |

## 二、架构

```
            文件文本（BOM/CRLF 容错归一）
                      │
        ┌─────────────▼──────────────┐
        │ detectFormat 内容嗅探        │  → x-srt / x-vtt / x-ass（CONTRACTS §3）
        └──────┬───────┬───────┬─────┘
               ▼       ▼       ▼
           parseSrt parseVtt parseAss ── 时间码→整数微秒(µs)
               │       │       │            畸形块跳过并计数(warnings)
               └───────┴───────┘
                      ▼
              Cue[] {startUs,endUs,text,…}
                      │
        ┌─────────────▼──────────────┐
        │ layoutEvents 排版求解（纯函数）│  九宫锚点/\pos/\move/\fad/
        │ （碰撞=自下而上堆叠简化模型）    │  \clip/frz/fscx/fscy/折行
        └─────────────┬──────────────┘
                      ▼ Drawable[]（PlayRes 逻辑坐标）
        ┌────────────────────────────┐
        │ SubtitleCanvasRenderer      │  ctx.scale 到画布像素后绘制：
        │ attach(video|clock) rAF 驱动 │  描边/阴影/底框/下划线/删除线
        └────────────────────────────┘
```

分层说明：解析与排版求解均为**纯函数**（Node 可直接数值断言）；只有 Renderer 触碰 DOM。
契约 §2.4「字幕渲染归 site 层」指消费关系——本模块交付渲染组件，由各播放器 demo 引用挂载。

## 三、快速开始

```html
<script type="module">
  import { parseAuto, SubtitleCanvasRenderer } from '../src/index.js';

  const text = await file.text();                 // 拖入的 .ass/.srt/.vtt
  const parsed = parseAuto(text);                  // 自动嗅探分派
  console.log(parsed.codec, parsed.cues.length, parsed.stats);

  const renderer = new SubtitleCanvasRenderer(document.querySelector('canvas'));
  renderer.setCues(parsed);
  renderer.renderAt(1_500_000);                    // 渲染 1.5s 处（整数微秒）

  // 或绑定时钟自动驱动（<video> 或任意返回微秒的函数）
  const stop = renderer.attach(myVideoElement);
</script>
```

只解析不渲染时按需具名导入：`import { parseSrt, parseVtt, parseAss } from '../src/index.js'`。

## 四、API 速查（全部具名导出）

| 导出 | 说明 |
|---|---|
| `parseSrt(text, {strict})` / `parseVtt(...)` / `parseAss(...)` | 解析为 `{format, codec, cues[], durationUs, stats}`；strict 时畸形即抛错，默认跳过并计数 |
| `parseAuto(text)` / `detectFormat(text)` / `probeSubtitleCodec(text)` | 嗅探与自动分派；codec 串对齐 CONTRACTS §3（`x-srt/x-vtt/x-ass`） |
| `parseTimestamp(str)` / `formatSrtTimestamp(us)` / `formatVttTimestamp(us)` / `formatAssTimestamp(us)` | 时间码 ↔ 整数微秒；容忍逗号/句点、缺小时位、厘秒 |
| `sortCues` / `shiftCues` / `findActiveCues` / `cuesDurationUs` / `stripCueTags` / `normalizeText` | Cue 工具（区间语义 start≤t<end） |
| `parseAssColor` / `rgbaToCss` / `anToAnchor` / `createDefaultStyle` | ASS 颜色(&HAABBGGRR)/九宫锚点换算/默认样式 |
| `tokenizeDialogue` / `TagState` / `TAG_WHITELIST` / `unescapeAssText` | 覆盖标签词法与白名单状态机 |
| `layoutEvents(cues, timeUs, ctx)` 及配套纯函数 | 排版求解（PlayRes 逻辑坐标输出，Node 可断言） |
| `SubtitleCanvasRenderer(canvas, opts)` / `isRendererSupported()` | Canvas 绘制与时钟驱动；Node 下探测恒 false |
| `SubtitleError(code, message, {detail})` | 模块错误类型，extends core PlayerError（core 十码封闭枚举；常用 PARSE_ERROR/NOT_SUPPORTED/STATE_ERROR），细分走 detail 字段 |

统一返回结构：

```js
{
  format: 'srt'|'vtt'|'ass',   codec: 'x-srt'|'x-vtt'|'x-ass',
  cues: [{ startUs, endUs, text, layer?, style?, settings?, segments?(ass) }],
  durationUs, stats: { cueCount, skippedBlocks, warnings[], … },
  // ASS 专属：info{playResX,playResY}, styles[AssStyle], unsupportedTags[]
}
```

## 五、ASS 白名单对照（本期承诺集，PRD §3.10）

| 类别 | 支持 | 不支持（进入未支持清单，不崩溃） |
|---|---|---|
| 字符样式 | `\b \i \u \s \fn \fs \fs± \fsp \c(\1c) \2c \3c \alpha` | `\r \be \blur \bord \shad \fst` 等 |
| 定位变换 | `\pos \move \org \an \fad \fscx \fscy \frz` | `\t` 动画插值、`\frx \fry` |
| 裁剪绘图 | `\clip(x1,y1,x2,y2)` 矩形 | `\clip(路径,scale)` 矢量、`\p` 绘图 |
| 特效 | 多层 Layer 叠加 | 卡拉OK `\k/\kf`、3D/`\bez` |

## 六、可选增强：libass-wasm（像素级还原模式）

主链路零依赖不变。需要像素级 ASS 还原时，可在宿主页面自行异步加载
`libass-wasm`（CDN 或 npm 分发均属运行时第三方依赖，故不入 src/），
将其 `SubtitleRenderer` 适配为本模块同名接口即可替换；README 不提供内置加载器。
建议做法：能力探测 `isRendererSupported()` 通过后再决定是否动态 import 增强，
失败则回退本 JS 引擎并 toast 提示。

## 七、测试与样例

```bash
node --test "subtitle/__tests__/*.test.js"   # 93 例全绿
npm run fixtures                             # 重建 __tests__/fixtures/*.srt|.vtt|.ass
```

fixture 由 `__tests__/fixtures/gen.mjs` 程序化生成（导出 `generate(fixDir)` 约定），
覆盖规范样例、容错样例（BOM/CRLF/点分隔/缺小时/坐标段）、畸形样例（坏块计数）、
双样式 ASS 白名单全家桶，离线可复现。

## 八、已知限制与路线

1. 折行为贪心近似（CJK 任意断行、西文整段处理），复杂西文混排可能早/晚一行换行。
2. `\t` 动画、矢量裁剪、卡拉OK 未支持（白名单外自动收集到 `unsupportedTags` 并在 demo 面板展示）。
3. 真实字体度量依赖系统字体栈；缺字回退与 libass 存在像素差异（可选增强见 §六）。
4. VTT cue settings（line/position/size）解析保留但布局暂不消费（路线图）。
5. 错误类型已接入 core 统一错误体系：SubtitleError extends PlayerError（十码封闭枚举，
   CONTRACTS v0.2 §11.3；草案 INVALID_STATE 定稿为 STATE_ERROR）。

---
*designer · 2026-08-25 · PurePlay M2 交付*
