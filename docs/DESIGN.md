# DESIGN.md — 演示站统一视觉规范（Design Tokens & Skin Spec）

> 版本：v1.1 · 作者：designer（UI/UX 设计师）· 日期：2025-08-25
> 状态：**已结案归档**——《初验-DESIGN》两项必须整改已于本版落盘（品牌结案见 §2、字幕叠加迷你规范见 §13）。**现行维护版本为 `docs/design/视觉规范.md` v1.0**（令牌对账更全、含信息架构与字幕呈现完整章），两文档冲突时以视觉规范为准；本文档转为历史锚点供 reviewer/qa 追溯。
> 读者：ui-kit-dev（实现 `site/` 共享皮肤）、各模块工程师（demo 页接入）、reviewer / qa（验收依据）
> 上游文档：`docs/00-需求与可行性结论.md`、`docs/PRD.md`、`docs/ARCHITECTURE.md`、`docs/CONTRACTS.md v0.2`

---

## 1. 设计目标与原则

本规范覆盖 **演示站首页 + 每个模块的 `demo/index.html`** 的统一视觉与交互皮肤。目标：

1. **零依赖纯 CSS**：不引入任何 UI 框架、字体文件、图标库；全部能力由 CSS 变量 + BEM 类名 + 一个轻量 `skin.js` 提供。
2. **深色单主题**：面向视频/码流演示场景，默认且唯一主题为深色；令牌层预留未来扩展位，本期不实现浅色。
3. **一套骨架，处处复用**：所有 demo 页共用同一布局网格、同一控制条组件、同一状态/错误语言，用户在模块间切换时"肌肉记忆"不变。
4. **变量即契约**：颜色、间距、字号、层级只允许以 CSS 变量形式出现（唯一定义处 `site/css/tokens.css`），页面自有样式禁止硬编码色值。
5. **无障碍达标**：正文对比度 ≥ 4.5:1，图标/UI 对比度 ≥ 3:1，全键盘可操作，尊重 `prefers-reduced-motion`。

---

## 2. 品牌命名（✅ 已结案）

**品牌名终裁为「PurePlay」**——见共享看板【裁决-品牌名】（leader 署名）：与仓库目录《纯前端实现播放器》、根 package.json 名 pure-frontend-player 一致，中性无商标包袱；候选 ffplay.js 因借用 FFmpeg 子项目名、开源发布有混淆/商标风险被明确弃用。

执行口径：
- `site/skin.js` 的 `BRAND` 常量值为 `'PurePlay'`（改名唯一触点）；各页面 `<title>` 模板落地为 `{Module} · PurePlay`。
- 各模块 README 标题可用「PurePlay · <模块名>」格式。
- 设计侧解耦保持有效：品牌名只出现在 topbar 文案与 `<title>` 模板两处，不影响任何类名、变量与结构。本文档以下章节的旧占位符 `PurePlay` 均按 PurePlay 读。

---

## 3. 令牌体系总览

三层结构，全部落在 `site/css/tokens.css`：

```
原始色阶 (gray-50…950, accent, status)      ← 仅 tokens.css 内部使用
        ↓ 映射
语义变量 (--bg-page, --text-primary …)      ← 页面/组件唯一允许引用的层
        ↓ 消费
BEM 组件类 (.controls .slider .toast …)     ← 结构与行为
```

命名规则：CSS 变量一律 `--<类别>-<名称>[-<变体>]`，kebab-case；
类名一律 BEM：`.block__element--modifier`，瞬时态用 `.is-*` / `.has-*`。

---

## 4. 设计令牌表（tokens.css 内容规范）

### 4.1 中性色阶（冷灰，hue≈220）

| 变量 | 值 | 用途备注 |
|---|---|---|
| `--gray-50` | `#f2f5fa` | （预留）浅色文字底 |
| `--gray-100` | `#e2e8f2` | |
| `--gray-200` | `#c9d2e0` | |
| `--gray-300` | `#a3b0c4` | |
| `--gray-400` | `#78869e` | |
| `--gray-500` | `#57637a` | |
| `--gray-600` | `#3f4a60` | 图标禁用 |
| `--gray-700` | `#2c3547` | 强边框 / 滑块轨道 / 缓冲段 |
| `--gray-800` | `#1d2433` | 弱边框 / tooltip 底 |
| `--gray-850` | `#151c28` | 浮层 / 输入框底 |
| `--gray-900` | `#10151f` | 卡片 / 面板底 |
| `--gray-950` | `#0a0e16` | 页面底 |

### 4.2 颜色 · 基底与边框

| 语义变量 | 值 | 用途 |
|---|---|---|
| `--bg-page` | `var(--gray-950)` #0a0e16 | 页面最底层 |
| `--bg-deep` | `#06090f` | 视频画布 letterbox 黑边、代码块底 |
| `--bg-surface` | `var(--gray-900)` | 卡片、信息面板 |
| `--bg-raised` | `var(--gray-850)` | 下拉菜单、输入框、toast |
| `--bg-overlay` | `rgba(6, 9, 15, .72)` | 模态遮罩 |
| `--bg-hover` | `rgba(255,255,255,.06)` | 行/项悬停 |
| `--bg-active` | `rgba(255,255,255,.10)` | 按下态 |
| `--border-subtle` | `var(--gray-800)` | 卡片描边、分隔线 |
| `--border-strong` | `var(--gray-700)` | 输入框描边、进度条缓冲段 |
| `--border-focus` | `var(--accent)` | 焦点环颜色 |

### 4.3 颜色 · 文字

| 语义变量 | 值 | 对比度(vs --bg-page) | 用途 |
|---|---|---|---|
| `--text-primary` | `#e6ebf4` | ≈15:1 ✅ | 标题、正文主文字 |
| `--text-secondary` | `#a9b4c8` | ≈9:1 ✅ | 次级说明、面板标签 |
| `--text-muted` | `#6f7b93` | ≈4.6:1 ✅ | 占位符、时间戳辅助 |
| `--text-disabled` | `#49536a` | — | 禁用文字 |
| `--text-on-accent` | `#071021` | on accent ≈7:1 ✅ | 实心强调按钮上的深色文字 |

### 4.4 颜色 · 品牌/强调色

| 语义变量 | 值 | 用途 |
|---|---|---|
| `--accent` | `#47a3ff` | 主强调：进行中进度、选中态、焦点环、链接 |
| `--accent-hover` | `#6ab5ff` | accent 文字的 hover 色（同时是 `--link`） |
| `--accent-active` | `#3087ee` | accent 实心底按下色 |
| `--accent-dim` | `rgba(71,163,255,.14)` | 选中项底色水洗 |
| `--accent-border` | `rgba(71,163,255,.42)` | 选中项描边 |
| `--link` | `var(--accent-hover)` | 超链接 |

### 4.5 状态色（含 dim/border 配对值，用于徽章/toast 底与描边）

| 语义变量 | 主色 | dim（底） | border（描边） | 语义 |
|---|---|---|---|---|
| `--status-success` | `#4ade80` | `rgba(74,222,128,.13)` | `rgba(74,222,128,.38)` | 就绪/成功/轨道正常 |
| `--status-warning` | `#fbbf24` | `rgba(251,191,36,.12)` | `rgba(251,191,36,.38)` | 加载中/降级软解/丢帧偏高 |
| `--status-error` | `#f87171` | `rgba(248,113,113,.13)` | `rgba(248,113,113,.42)` | 失败/不支持/网络中断 |
| `--status-info` | 同 `--accent` 族 | 同 `--accent-dim` | 同 `--accent-border` | 提示（不单独设色，复用 accent） |
| `--status-live` | `#ff5c5c` | `rgba(255,92,92,.14)` | `rgba(255,92,92,.42)` | 直播点/REC 点（呼吸动画） |
| `--status-neutral` | `#8b97ad` | `rgba(139,151,173,.12)` | `rgba(139,151,173,.35)` | 未激活/未知 |
| `--danger-solid` | `#e5484d`（hover `#f2555a`） | — | — | 唯一实心危险按钮（清空日志等） |

### 4.6 字体

```css
--font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
             "Helvetica Neue", Arial, "PingFang SC", "Hiragino Sans GB",
             "Microsoft YaHei", sans-serif;
--font-mono: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas,
             "Liberation Mono", monospace;   /* 时间码/统计/编解码标签 */
```

| 变量 | 值 | 用途 |
|---|---|---|
| `--fs-xs` | `12px` | 徽章、tag、tooltip、kbd |
| `--fs-sm` | `13px` | 面板标签、菜单项、辅助文字 |
| `--fs-md` | `14px` | 正文默认 |
| `--fs-lg` | `16px` | 区块标题 |
| `--fs-xl` | `20px` | 页标题（topbar 品牌名） |
| `--fs-2xl` | `24px` | stage 空状态大标题 |
| `--lh-body` | `1.6` | 正文行高 |
| `--lh-head` | `1.35` | 标题行高 |
| `--fw-medium` / `--fw-semibold` | `500` / `600` | 强调字重（不用 >600） |

数字场景（时间码、统计值）必须加 `font-variant-numeric: tabular-nums`，避免刷新时跳动。

### 4.7 几何

| 变量 | 值 | 变量 | 值 |
|---|---|---|---|
| `--sp-0` | `0` | `--sp-6` | `24px` |
| `--sp-1` | `4px` | `--sp-7` | `32px` |
| `--sp-2` | `8px` | `--sp-8` | `40px` |
| `--sp-3` | `12px` | `--sp-9` | `48px` |
| `--sp-4` | `16px` | `--sp-10` | `64px` |
| `--sp-5` | `20px` | | |

| 变量 | 值 | 用途 |
|---|---|---|
| `--radius-sm` | `4px` | tag、kbd、输入框内元素 |
| `--radius-md` | `8px` | 按钮、输入框、卡片内嵌块 |
| `--radius-lg` | `12px` | 卡片、toast、stage 错误盒 |
| `--radius-full` | `999px` | 徽章、圆点、胶囊 |

**布局尺寸**（§6 使用）：

| 变量 | 值 | 用途 |
|---|---|---|
| `--topbar-h` | `52px` | 顶部导航高度 |
| `--controls-h` | `56px` | 控制条高度 |
| `--panel-w` | `320px`（≤1120px 时 `280px`） | 信息面板宽度 |
| `--content-max` | `1440px` | 演示站内容最大宽度（居中） |
| `--ctl-icon` | `36px` | 控制条图标按钮尺寸 |
| `--ctl-gap` | `8px` | 控件间基础间距 |

### 4.8 层级 / 动效

| 变量 | 值 | | 变量 | 值 |
|---|---|---|---|---|
| `--z-nav` | `100` | | `--dur-fast` | `120ms` |
| `--z-menu` | `200` | | `--dur-base` | `200ms` |
| `--z-toast` | `300` | | `--dur-slow` | `320ms` |
| `--z-tooltip` | `400` | | `--ease-out` | `cubic-bezier(0, 0, .2, 1)` |
| `--z-fs-ui` | `500` | | `--ease-standard` | `cubic-bezier(.2, 0, 0, 1)` |

阴影（暗色下以"描边为主、投影为辅"）：
`--shadow-1: 0 1px 2px rgba(0,0,0,.4)`；`--shadow-2: 0 4px 16px rgba(0,0,0,.45)`（浮层）；`--shadow-focus-ring: 0 0 0 2px var(--bg-page), 0 0 0 4px var(--accent)`。

---

## 5. 深色主题规范

- `<html data-theme="dark">` 固定写入；本期不提供浅色，但所有颜色必须经 §4 语义变量引用，未来加主题 = 追加一份 `[data-theme="light"]` 变量覆盖，组件零改动。
- **画布区永远比页面更黑**：媒体四周留黑用 `--bg-deep`（#06090f），与 `--bg-page` 形成微妙层次，避免"视频浮在灰底上"的廉价感。
- 不使用大面积纯白文字以外的发光效果；强调只允许 accent 一族，一屏内大面积强调色占比 ≤ 10%。
- 全局 `::selection { background: var(--accent-dim); }`；滚动条统一细化（见附录 A base 段）。

---

## 6. 布局网格与页面骨架

### 6.1 三区网格（所有 demo 页强制同构）

```
┌──────────────────────────────────────────────┐
│ topbar  PurePlay · [MP4] [HLS] [FLV] [MKV] …  │ --topbar-h 52px
├───────────────────────────────┬──────────────┤
│                               │              │
│   stage（中央画布区）           │  info-panel  │
│   canvas/video + overlay 层    │  轨道/编码/    │
│                               │  统计信息       │
├───────────────────────────────┤   --panel-w  │
│   controls（底部控制条）        │  可独立滚动    │
└───────────────────────────────┴──────────────┘
```

```css
.demo {
  display: grid;
  min-height: 100vh;
  max-width: var(--content-max);
  margin-inline: auto;
  grid-template-columns: minmax(0, 1fr) var(--panel-w);
  grid-template-rows: var(--topbar-h) minmax(0, 1fr) auto;
  grid-template-areas:
    "topbar   topbar"
    "stage    panel"
    "controls panel";
}
.demo__topbar   { grid-area: topbar; }
.demo__stage    { grid-area: stage; }
.demo__controls { grid-area: controls; }
.demo__panel    { grid-area: panel; }
```

要点：控制条**只属于画布列**（不横穿面板下方）；面板纵跨两行、内部独立滚动；`minmax(0,1fr)` 防止 canvas 撑破网格。

### 6.2 topbar（顶部导航 = 模块切换）

- 高 `--topbar-h`，左右内距 `--sp-4`；底部 1px `--border-subtle` 分隔；吸顶（sticky，`--z-nav`）。
- 左区：logo 记号（24×24 SVG 波形符号，见 §9）+ 品牌名 `PurePlay`（`--fs-xl`，`--fw-semibold`），点击回演示站首页。
- 中区 `.tabs`：模块切换页签（文本页签，非按钮堆）。每项高满、水平内距 `--sp-3`、`--fs-sm`、`color: --text-secondary`；
  - hover：`--bg-hover`；激活 `.is-active`：文字 `--accent` + 底部 2px accent 下划线（`::after`）+ `--accent-dim` 底；
  - 数量多时横向滚动，两端 16px 渐隐遮罩（mask-image）提示可滚。
- 右区 `.topbar__actions`：GitHub 链接、窄屏下的"信息面板"开关按钮（`.btn-icon`）。
- 允许 `backdrop-filter: blur(8px)` + 半透明底作为渐进增强，必须有纯色 fallback（先写 `background: var(--bg-page)` 再写支持查询内的透明底）。

### 6.3 stage（中央画布区）

结构四层叠放（`position: relative` 容器 + 绝对定位层）：

```
.stage
 ├─ .stage__viewport   ← <canvas>/<video> 容器：aspect-ratio 16/9，居中，
 │                        背景 --bg-deep；媒体 object-fit: contain 等价行为
 ├─ .stage__overlay    ← 缓冲 spinner / 直播标 / 中央大播放键（点击画布也可切换播放）
 ├─ .drop              ← 拖放热区（空状态或拖拽中显示）
 └─ .stage__errbox     ← 错误面板（§8.4），仅 has-error 时显示
```

- 默认宽高比 16:9；音频类模块（wav/flac/ape）允许改用可视化画布并设 `min-height: 240px`，控制条规格不变。
- 空状态（未加载媒体）：居中 `.drop` 卡片 —— 虚线 2px `--border-strong` 圆角 `--radius-lg`，内含上传图标、"拖入本地文件或粘贴地址"、`.field` 地址输入行（输入框 + "打开"按钮）、"载入示例"ghost 按钮、一行支持格式 chips。
- 全窗口 dragover 时 `.stage.is-dragging`：inset 8px 处显示 2px dashed `--accent-border` 边框 + `--accent-dim` 底 + "松开以载入文件"文案。
- 双击画布 = 切换全屏（与右下角按钮等效）。

### 6.4 info-panel（右侧信息面板）

- 宽 `--panel-w`，背景 `--bg-surface`，左边框 1px `--border-subtle`，内边距 `--sp-4`，纵向独立滚动。
- 由若干 `.panel__section` 卡片组成（卡片间 `--sp-3`）：区块头为 `--fs-sm` `--fw-semibold` 大写间距字母的可选标题 + 右侧 `.badge` 状态。
- **固定三个区块（各模块统一）**：
  1. **媒体信息** `.kv` 列表：容器格式 / 时长 / 分辨率 / 帧率 / 总码率；编码用 `.tag`（如 `H264` `AAC` `OPUS`，mono 11px 大写）。
  2. **轨道列表**：每轨一行 `.track`（类型图标 + 名称/语言 + 编码 tag + 选中态 radio 样式点）；字幕轨可多选（勾选样式），音视频轨单选。
  3. **实时统计**：`.kv` mono 值，≥500ms 刷新一次：fps、已解码帧、丢帧（dropped >1% 转 warning 色）、音频缓冲 ms、当前码率、延迟（直播）、下载速度。数值按阈值着色：正常 `--text-primary`、警告 `--status-warning`、错误 `--status-error`。
  4. （可选折叠）**事件日志**：最近 N 条，mono `--fs-xs`，带级别色点。
- 响应式：≤1024px 面板变为右侧抽屉（fixed，translateX(100%) ↔ 0，`--dur-base`），topbar 出现开关按钮；抽屉打开时画布区不加遮罩（允许边播边看数据）。

### 6.5 HTML 骨架示例（可直接复制为新 demo 页起点）

```html
<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{Module} · PurePlay</title>
  <link rel="stylesheet" href="../../site/css/tokens.css">
  <link rel="stylesheet" href="../../site/css/base.css">
  <link rel="stylesheet" href="../../site/css/layout.css">
  <link rel="stylesheet" href="../../site/css/components.css">
</head>
<body>
<div class="demo">
  <header class="topbar demo__topbar" data-skin="topbar">…</header>

  <main class="stage demo__stage is-idle" id="stage">
    <div class="stage__viewport" id="viewport"></div>
    <div class="stage__overlay"></div>
    <div class="drop">…空状态…</div>
  </main>

  <footer class="controls demo__controls" id="controls">
    <div class="controls__group">
      <button class="btn-icon" data-skin="play" aria-label="播放"></button>
      <span class="controls__time">00:00</span>
      <input class="slider slider--progress" type="range" min="0" max="1000" value="0"
             step="1" aria-label="播放进度">
      <span class="controls__time controls__time--total">00:00</span>
    </div>
    <div class="controls__group">
      <button class="btn-icon" data-skin="mute" aria-label="静音"></button>
      <input class="slider slider--volume" type="range" min="0" max="100" value="100"
             aria-label="音量">
      <div class="menu" data-skin="rate">…倍速…</div>
      <button class="btn-icon" data-skin="cc" aria-label="字幕" aria-pressed="false"></button>
      <button class="btn-icon" data-skin="fs" aria-label="全屏"></button>
    </div>
  </footer>

  <aside class="panel demo__panel">…三区块…</aside>
</div>
<script type="module" src="../../site/js/skin.js"></script>
<!-- 各模块自己的播放器逻辑 ESM 放在其后引入 -->
</body>
</html>
```

### 6.6 响应式断点

| 断点 | 行为 |
|---|---|
| ≥1440px | 内容限宽 `--content-max` 居中，页面两侧露出 `--bg-page` |
| ≤1120px | `--panel-w: 280px` |
| ≤1024px | 单列网格（topbar/stage/controls 竖排），面板转右侧抽屉，topbar 加开关 |
| ≤640px | 控制条紧凑化：隐藏音量滑条（保留静音钮）、倍速收进图标菜单；topbar 页签横向滚动；触控命中区放大到 44×44 |

---

## 7. 播放控制条组件规格（`.controls`）

### 7.1 总体

- 高 `--controls-h`，水平内距 `--sp-3`，上下分组 `.controls__group`（gap `--ctl-gap`），两组之间 flex:1 的进度组自然撑开。
- 背景 `--bg-surface`，顶部 1px `--border-subtle`；控件垂直居中。
- 从左到右分区固定：**播放/暂停 → 时间(当前) → 进度滑块 → 时间(总长)** ‖ **静音 → 音量滑块 → 倍速 → 字幕开关 → [设置] → [PiP] → 全屏**。
- 方括号为可选控件（模块按能力裁剪），其余为必备。

### 7.2 控件逐一规格

**① 播放/暂停 `.btn-icon[data-skin=play]`**
- 尺寸 36×36（`--ctl-icon`），图标 20×20，圆角 `--radius-md`；hover `--bg-hover`，active `--bg-active`。
- 状态由容器类驱动：`.controls.is-playing` 显示暂停图标，否则播放图标（SVG `<use>` 两 symbol 切换）。
- 禁用态（无媒体）：opacity .4 + cursor not-allowed。
- ARIA：`aria-label` 动态取"播放/暂停"；这是全页唯一主操作，键盘 Space 全局绑定。

**② 时间显示 `.controls__time`**
- mono、`tabular-nums`、`--fs-sm`、`color: --text-secondary`；总时长加 `--muted` 修饰类。格式：`mm:ss`，≥1h 用 `h:mm:ss`（skin.js `formatTime`）。

**③ 进度滑块 `.slider--progress`**（详见 §7.3）

**④ 静音 + 音量 `.btn-icon[data-skin=mute]` + `.slider--volume`**
- 静音钮随音量档位换图标（高/低/静音三档）；`.is-muted` 时图标固定静音款。
- 音量滑条宽 72px，hover 展开/聚焦展开到 96px（width transition `--dur-fast`）；≤640px 隐藏滑条仅留按钮。
- 静音时恢复音量应回到静音前值（skin.js 记忆 lastVolume）。

**⑤ 倍速 `.menu[data-skin=rate]`**
- 触发器：btn-icon 或文字按钮显示当前值 `1x`；点开向上弹出 `.menu--up` 菜单。
- 固定档位：`0.5 / 0.75 / 1 / 1.25 / 1.5 / 2`；当前档 `.menu__item--selected`（左侧 ✓ + accent 文字）。
- 关闭：点外部 / Esc / 再次点击触发器。直播流下禁用（`disabled` + tooltip 说明）。

**⑥ 字幕开关 `.btn-icon[data-skin=cc]`**
- `aria-pressed` 表达开关；开启态 `.btn-icon--active`：图标 accent 色 + 底部 2px accent 短横线。
- 无字幕轨时禁用。快捷键 C。

**⑦ 全屏 `[data-skin=fs]`**
- 对 `#viewport` 所在 stage 请求全屏（不是整页），保证全屏内仍有自绘控制条；进入后容器加 `.is-fullscreen`，控制条悬浮于底部（absolute + `--z-fs-ui` + 底部渐变遮罩 `linear-gradient(transparent, rgba(6,9,15,.85))`），3s 无操作自动隐藏、鼠标移动唤起。
- Esc 退出；`fullscreenchange` 同步按钮图标（expand/compress）。

### 7.3 进度滑块详细规格

视觉（基于原生 `<input type="range">` 跨浏览器伪元素定制，保证键盘/ARIA 免费）：

- 命中区：整条高 16px（易点）；可视轨道高 4px，容器 hover/focus-within 时过渡到 6px。
- 分段着色（用 `--p`（0–100 已播放百分比）与 `--b`（缓冲百分比）两个自定义属性 + 渐变实现）：

```css
.slider--progress {
  --p: 0; --b: 0;
  background: linear-gradient(to right,
    var(--accent)                                 0 calc(var(--p) * 1%),
    var(--status-warning)                         calc(var(--p) * 1%) 0); /* 见注 */
}
/* 注：缓冲段实际写法为三段渐变 ——
   played(accent) → buffered(var(--border-strong)) → track(var(--gray-700))，
   由 --p 与 --b 两变量切分；thumb 用 ::-webkit-slider-thumb / ::-moz-range-thumb 定制 */
```

- thumb：直径 12px 圆形 `--text-primary` 白芯 + accent 描边，默认 scale(0)，hover/focus-within/dragging 时 scale(1)；拖动中 `.is-scrubbing` 放大到 14px 并关闭 transition。
- 悬停预览：鼠标悬停时 thumb 上方浮现时间气泡 `.slider__tip`（mono 12px，`--bg-raised` + `--shadow-2`），位置跟随指针（JS 写入 `--tip-x` 与文案）；拖动中气泡常显。
- 行为约定：拖动中仅更新 UI 与时间预览（`input` 事件），pointerup 才提交 seek（`change` 事件）；直播无 DVR 时滑条替换为 `LIVE` 徽章（红点 + 文字，点击跳到边缘）。
- 键盘：←/→ ±5s，↑/↓ ±10s（竖向不需要），Home/End 到首尾；`aria-valuetext` 由 skin.js 格式化为 `mm:ss`。

**音量滑块**同构，仅宽度与填充色不同（填充用 `--text-secondary`，避免与进度条混淆）。

### 7.4 状态机类名（JS 只切这些钩子，CSS 负责一切表现）

挂在 `.controls`（及联动 `.stage`）上：

| 类名 | 含义 | 表现要点 |
|---|---|---|
| `.is-idle` | 未载入媒体 | 控制条整体降透明 .55，播放钮禁用 |
| `.is-buffering` | 缓冲中 | stage 中央 spinner + "缓冲中…" |
| `.is-playing` / `.is-paused` | 播放/暂停 | play 图标互换 |
| `.is-seeking` / `.is-scrubbing` | 跳转中/拖动中 | thumb 放大、气泡常显 |
| `.is-muted` | 静音 | 音量图标固定 |
| `.is-live` | 直播模式 | 进度条→LIVE 徽章、倍速禁用 |
| `.has-error` | 出错 | stage 显示 errbox，控制条降透明 |
| `.is-fullscreen` | 全屏中 | 控制条转悬浮样式 |
| `.is-dragging` | 文件拖入 stage | dropzone 高亮 |

---

## 8. 状态色与错误提示

### 8.1 播放器生命周期 → 视觉映射

| 状态 | 位置 | 视觉 |
|---|---|---|
| idle | stage 中央 | dropzone 空状态卡 |
| loading/buffering | stage 中央 | `.spinner`（28px，accent 弧线旋转 .8s linear）+ `--fs-sm` 文案 |
| ready/playing/paused | info-panel 徽章 | `.badge--success`（就绪）/ 无额外打扰，状态只在面板呈现 |
| live | stage 左上角 + 面板 | `.badge--live`（红点呼吸动画） |
| degraded/warning | toast（一次性告知，如"该容器启用软解回退"） | `.toast--warn` |
| error | stage 内 errbox + 面板徽章 | `.stage__errbox` + `.badge--error` |

### 8.2 徽章 `.badge`

胶囊形：`--fs-xs` + 6px 圆点 + 2px/8px 内距；修饰符 `--success/--warning/--error/--live/--neutral` 分别套用 §4.5 的 dim 底 + 主色文字 + border 描边。live/warning 点带 `pulse` 呼吸动画（reduced-motion 下改为静态）。

### 8.3 Toast（非阻塞提示）

- 出现在 **stage 内顶部居中**（absolute，`--z-toast`），宽 ≤420px，多条纵向堆叠 gap 8px。
- 结构：左 3px 类型色边 + 图标 + 文案（主行 `--fs-md`，详情行 `--fs-sm muted`）+ 关闭钮。
- 进入：translateY(-8px)+fade `--dur-base` `--ease-out`；自动关闭：info/success 3s、warn 5s、**error 不自动关**。
- ARIA：容器 `aria-live="polite"`，error 类型用 `role="alert"`。
- API（skin.js）：`Skin.toast({ type, title, detail?, timeout? })`。

### 8.4 Stage 内错误面板 `.stage__errbox`

阻断性错误（解析失败、解码不支持、网络中断）不用 toast，用画布中央卡片：

```
┌──────────────────────────────────┐
│  ⚠  播放失败                       │   ← 图标32px(status-error) + 标题 fs-lg
│  [E_DEMUX_FORMAT]                 │   ← 错误码 chip（mono xs，error 描边）
│  无法识别的容器格式：文件头魔数不匹配。 │   ← 中文一句话原因 + 建议（fs-sm secondary）
│  [ 重试 ]  [ 复制诊断信息 ]          │   ← btn--solid(accent) + btn--ghost
└──────────────────────────────────┘
```

- 卡片：max-width 400px，`--bg-raised`，1px `--status-error` border 色，`--radius-lg`，`--shadow-2`。
- 错误码约定：`E_<域>_<名>`，域 ∈ `DEMUX / DECODE / NET / SUBTITLE / SRC`（如 `E_NET_TIMEOUT`、`E_DECODE_UNSUPPORTED`）。模块抛错时携带 `{ code, message, detail }`，skin 只负责渲染。
- "复制诊断信息"把 UA、错误对象、最近 20 条事件日志写入剪贴板，成功后按钮短暂变"已复制"。

### 8.5 输入与校验

地址输入 `.field`：输入框 1px `--border-strong` 底 `--bg-raised`，focus 时描边 accent；非法 URL 时 `.field--invalid`（error 描边 + 下方 `--fs-xs` error 提示文字），抖动动画一次（120ms，reduced-motion 关闭）。

---

## 9. 图标规范

- 形式：**SVG sprite**（`site/assets/icons.svg` 内 `<symbol>`），页面 `<svg><use href="../../site/assets/icons.svg#i-play"/></svg>`；`fill:none; stroke:currentColor; stroke-width:1.8; viewBox 0 0 24 24`。
- 命名 `i-<name>`，首批清单：`play pause volume-high volume-low volume-mute cc gear expand compress pip upload link close retry copy chevron-up chevron-down film audio subtitle chart github live`。
- 尺寸只有三档：16（行内）/ 20（控制条默认）/ 32（空状态、错误面板），用 CSS 类控制，不改 SVG。
- 品牌记号：24×24 波形折线（三峰），stroke `--accent`，仅 topbar 使用。

---

## 10. BEM 类名总表（ui-kit-dev 实现清单）

| Block | 元素 / 修饰 | 备注 |
|---|---|---|
| `.demo` | `__topbar __stage __controls __panel` | 页面网格骨架 |
| `.topbar` | `__logo __title __nav __actions` | 吸顶导航 |
| `.tabs` | `__item`(`.is-active`) | 模块切换页签 |
| `.stage` | `__viewport __overlay __errbox`; `.is-idle .is-buffering .has-error .is-dragging .is-fullscreen` | 画布区 |
| `.drop` | `__icon __hint`; `.drop--over` | 拖放区/空状态 |
| `.field` | `__input __btn __help`; `.field--invalid` | 地址输入行 |
| `.controls` | `__group __time`(`--total`); 状态机类见 §7.4 | 控制条 |
| `.btn-icon` | `--active --danger`; disabled 属性态 | 36px 图标钮 |
| `.btn` | `--solid --ghost --outline --danger-solid` | 文本按钮（重试/复制等） |
| `.slider` | `--progress --volume`; `__tip`; `.is-scrubbing` | range 皮肤 |
| `.menu` | `__list __item`(`--selected`); `--up`, `.is-open` | 倍速等弹出菜单 |
| `.panel` | `__head __body __section __title` | 信息面板 |
| `.kv` | `__key __val`(`--ok --warn --bad`) | 键值统计行（val 必须 mono+tabular） |
| `.track` | `__icon __meta __codec __pick`(`.is-selected`) | 轨道行 |
| `.tag` | `--accent` | 编码标签（H264/AAC…） |
| `.chip` | — | 格式能力小胶囊（空状态"支持 MP4/WebM…"） |
| `.badge` | `--success --warning --error --live --neutral` | 状态徽章 |
| `.toast` | `__icon __msg __close`; `--info --success --warn --error` | 轻提示 |
| `.spinner` | `--sm --lg` | CSS 旋转弧 |
| `.kbd` | — | 快捷键提示胶囊 |
| `.divider` | `--h` | 1px 分隔线 |

**JS 钩子约定**：行为挂 `data-skin="<key>"` 属性（`topbar/play/mute/rate/cc/fs/tabs/range…`），skin.js 按 attribute 委托绑定；禁止用 `.js-*` 类名或 id 做行为钩子（id 仅限锚点与全屏目标）。

---

## 11. site/ 目录拆分与接入手册（交付形态）

```
site/
├─ css/
│  ├─ tokens.css       ← §4 全部变量（唯一定义处）
│  ├─ base.css         ← reset、排版、滚动条、focus-visible、selection、reduced-motion
│  ├─ layout.css       ← .demo 网格、topbar、stage、panel、响应式断点
│  └─ components.css   ← §10 所有 block
├─ js/
│  └─ skin.js          ← ESM 默认导出 Skin：{ initTabs, bindRange, toast,
│                          formatTime, formatBitrate, BRAND }
├─ assets/
│  └─ icons.svg        ← sprite（§9 清单）
└─ README.md           ← 接入手册：引入顺序、类名速查、改名指引
```

- **引入路径必须相对**（`../../site/css/*.css`），保证任意静态服务器与子目录部署都能直接打开（呼应交付标准第 3 条）。
- `skin.js` 职责边界：**只做 DOM 皮肤行为**（页签高亮、range 的 `--p/--b` 回写、tooltip 文案、toast、时间/码率格式化、全屏包装、快捷键注册器 `Skin.bindKeys(map)`）；**不做任何 demux/decode/player 逻辑**——那是各模块的事。
- 品牌名常量：`export const BRAND = 'PurePlay'`（改名唯一触点）+ topbar 渲染使用它。
- 体量预算：四个 CSS 合计 ≤ 30KB（未压缩）；skin.js ≤ 8KB。超预算须回本规范裁剪而不是引库。

---

## 12. 验收清单（qa / reviewer 直接可用）

1. [ ] 除 `tokens.css` 外全站 grep 不到裸十六进制色值（alpha 派生 rgba 除外）。
2. [ ] 正文对比度 ≥4.5:1、图标 ≥3:1（§4.3/§4.5 已给基准值，抽测即可）。
3. [ ] 任一 demo 页拔掉 JS 后：布局、控制条静态外观仍完整（渐进增强成立）。
4. [ ] 纯键盘可完成：Tab 遍历控件、Space 播放/暂停、方向键 seek/音量、F 全屏、M 静音、C 字幕、Esc 退出。
5. [ ] `prefers-reduced-motion: reduce` 下无旋转/呼吸/位移动画。
6. [ ] 断点抽查 1440 / 1120 / 1024 / 640 四档无横向滚动条、无遮挡。
7. [ ] 错误路径：喂损坏文件能走到 `.stage__errbox` 且错误码符合 `E_<域>_<名>` 约定。
8. [ ] 控制条在 idle/buffering/playing/live/error 五状态下表现符合 §7.4 表。
9. [ ] 零运行时依赖：Network 面板除本地资源外无任何第三方请求。

---

## 附录 A · tokens.css 参考实现（节选骨架，完整值以 §4 为准）

```css
/* site/css/tokens.css — v1.0 designer 2025-08-25 */
:root {
  color-scheme: dark;

  /* raw ramp */
  --gray-50:#f2f5fa;  --gray-300:#a3b0c4;  --gray-600:#3f4a60;
  --gray-700:#2c3547; --gray-800:#1d2433;  --gray-850:#151c28;
  --gray-900:#10151f; --gray-950:#0a0e16;

  /* base */
  --bg-page:var(--gray-950);   --bg-deep:#06090f;
  --bg-surface:var(--gray-900);--bg-raised:var(--gray-850);
  --bg-overlay:rgba(6,9,15,.72);
  --bg-hover:rgba(255,255,255,.06); --bg-active:rgba(255,255,255,.10);
  --border-subtle:var(--gray-800);  --border-strong:var(--gray-700);

  /* text */
  --text-primary:#e6ebf4; --text-secondary:#a9b4c8; --text-muted:#6f7b93;
  --text-disabled:#49536a; --text-on-accent:#071021;

  /* accent */
  --accent:#47a3ff; --accent-hover:#6ab5ff; --accent-active:#3087ee;
  --accent-dim:rgba(71,163,255,.14); --accent-border:rgba(71,163,255,.42);
  --link:var(--accent-hover);

  /* status */
  --status-success:#4ade80; --success-dim:rgba(74,222,128,.13);
  --status-warning:#fbbf24; --warning-dim:rgba(251,191,36,.12);
  --status-error:#f87171;   --error-dim:rgba(248,113,113,.13);
  --status-live:#ff5c5c;    --status-neutral:#8b97ad;
  --danger-solid:#e5484d;

  /* type / space / radius / layout / motion —— 见 §4.6–4.8 */
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration:.01ms !important;
    animation-iteration-count:1 !important;
    transition-duration:.01ms !important;
  }
}
```

---

## 13. 字幕叠加层迷你规范（v1.1 新增；《初验-DESIGN》整改项②）

> 对接关系：字幕**解析与 Cue 流产出**归 `subtitle/` 模块（时间基整数微秒，命中区间 `startUs ≤ t < endUs`）；**叠加呈现**归 site 层皮肤（CONTRACTS v0.2 §8）。本节规定两者在 demo 页舞台内的对接规格。完整版（含 ASS 样式映射与降级阶梯）见 `docs/design/视觉规范.md` §7。

### 13.1 叠加容器层级

字幕渲染在舞台内使用**独立覆盖层** `.subtitle-layer`（Canvas 或 DOM 文本叠层二选一，demo 默认 Canvas）：

| 层 | 内容 | z-index |
|---|---|---|
| L0 媒体画面 | `<video>`/`<canvas>` | 0 |
| **L1 字幕覆盖层** | `.subtitle-layer`，**必须 `pointer-events:none`** | 10 |
| L2 舞台状态层 | buffering spinner / live 徽章 / dropzone | 20 |
| L3 错误盒 errbox | 阻断错误卡（出现时字幕冻结刷新） | 30 |
| L4 全屏悬浮控制条 | 全屏态的 controls | 40 |

toast 为全局层（`--z-toast: 300`，挂 body），永远高于舞台内一切层。字幕层独立于媒体 canvas 存在，避免「清字幕」与「清画面」互相清屏。

### 13.2 字号缩放策略

- 基准：**画布显示高度 × 5.5%**；ASS 文件带 `PlayResX/PlayResY` 时改为 PlayRes→画布线性缩放，且 Style 表字号优先于本缺省。
- 触发：`ResizeObserver` 监听舞台尺寸（含全屏切换、窗口缩放、DPR 变化）后重算。
- 钳制：最小 14px、最大 64px；描边宽度恒 = 字号 ÷ 21，随字号同步缩放。

### 13.3 安全边距

- 底部：`max(画布高 × 5%, 控制条高 56px + 8px)`——保证台词不被非全屏控制条遮挡。
- 左右：画布宽 × 4%（居中锚点 an=2 下对称生效）。
- 全屏：控制条转悬浮并自动隐藏，此时底部边距退为 `画布高 × 5%`；控制条唤起期间允许短暂共存（不做重排抖动，M3 视觉走查复核体验）。

### 13.4 与控制条的状态联动类名（对接契约）

播放器/皮肤负责在 **stage 舞台容器**上维护以下状态类；字幕层**只读**这组类决定表现，禁止反向依赖控制条内部结构：

| 舞台容器状态类 | 字幕层行为 |
|---|---|
| `.is-buffering` | 保持当前帧，整层透明度降至 .5（缓冲弱化，避免误读为正常台词节奏） |
| `.has-error` | 冻结刷新，透明度降至 .4；错误盒关闭后由播放器移除该类恢复 |
| `.is-scrubbing` | 拖动进度时按预览时刻逐帧实时重绘（跟随 input，不等 change 提交 seek） |
| `.is-fullscreen` | 安全边距切 13.3 全屏分支；字号策略不变 |
| `[data-cc="off"]`（或 `.cc-off`） | 整层 `visibility:hidden`（CC 开关关闭），DOM/canvas 保留以便秒开 |
| `.is-idle` | 无媒体时不渲染任何字幕内容 |

两套皮肤的对应关系：状态类一律挂**舞台容器**（`.pp-stage` 或承载 `.pui` 的舞台包装元素），按钮侧（如 CC 按钮 `aria-pressed`）只负责同步容器属性；`.pp-*` 与 `.pui-*` 前缀不同但状态语义一致，M3 收敛裁决后自然统一。时钟源以播放器音频主时钟（整数微秒）为准，无音轨 demo 用性能软时钟。

---

*本文档由 designer 起草，随实现反馈迭代；改动请在文末追加变更记录。*

| 版本 | 日期 | 变更 | 作者 |
|---|---|---|---|
| v1.0 | 2025-08-25 | 初版：令牌表/布局网格/控制条规格/状态与错误/BEM 清单/site 交付形态（原误署 2026-08-25，系笔误，本次更正） | designer |
| v1.1 | 2025-08-25 | 《初验-DESIGN》两项必须整改落盘：①§2 品牌章节结案（引用【裁决-品牌名】终裁 PurePlay，ffplay.js 弃用，全文 {BRAND} 占位符落地）；②新增 §13 字幕叠加层迷你规范（容器层级/字号缩放/安全边距/与控制条状态联动类名）。文档头标注现行版本为 docs/design/视觉规范.md v1.0，本文档转历史锚点 | designer |
