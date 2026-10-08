# site —— 共享演示皮肤与通用控制条

## 当前入口与迁移状态（2026-10-08）

`skin.css` 的 `--pp-*` 是共享深色令牌事实源，`skin.js` 是 DOM 行为事实源。
官网、总览、全部 16 个模块页以及 HLS/FLV 对照页均已切换到共享导航与 pp 深色皮肤。
`site.css` 仍保留遗留样式，其令牌与 `css/tokens.css` 均映射到 pp；`js/skin.js` 是薄 API 兼容出口。
下方原有冻结声明和迁移表属于历史记录，不代表当前接入状态。根首页、模块总览、16 个模块与两张对照页面现已共享全站导航与 pp 深色基础组件。
本次不交付浅色主题；不混用多个独立色板。

标准引用：`<body class="pp-scope">`、`../../site/skin.css`、`[data-site-nav][data-root="../../"]`。
页面显式使用 `skin.js` 的 `bindRange`、`bindDrop`、`bindKeys`；销毁时调用各自返回的 disposer。
`initSkin({ ranges: false })` 允许页面控制器独立管理滑杆，自动初始化不抢占已有绑定。
原生 range 的 `input` 仅预览，`change` 提交；程序刷新调用 `syncRange()`，不能派发用户事件。
`formatTime` 接收秒，`formatClockUs` 接收微秒；PlayerAdapter 的秒协议保持不变。

布局：播放器用 `.pp-page > .pp-main + .pp-aside`，总览用 `.pp-page--wide`；
音频/参考页用 `.pp-demo`，APE 用 `.pp-demo--single`，≤1024px 面板下排而非抽屉。
全屏调用 `toggleFullscreen(stage, controls)`，退出、失败和 `disposeFullscreen(stage)` 都恢复控件原位。
导航以规范化完整 URL 匹配当前页，支持部署子路径与目录/index.html 等价，使用 `aria-current="page"`。

验证：`node --test site/__tests__/*.test.js`、`npm test`、`npm run lint`。
这些是逻辑与静态验证，不替代浏览器布局、真实音频和播放验收。

---

## 历史接口与冻结记录

> 归属：ui-kit-dev　|　契约基线：docs/CONTRACTS.md v0.2（E-8 口径）（§0 纯 ESM / 零依赖 / 双环境）
> 视觉规范：docs/DESIGN.md（designer 编写中）发布前，本目录先落地一套深色默认令牌，
> 规范发布后仅需对齐 `site.css` 第 1 节的 CSS 变量取值，组件结构不变。

## 一、组成

```
site/
├─ site.css        # 设计令牌（CSS 变量）+ 页面骨架 + .pui 控制条 BEM 样式
├─ player-ui.js    # createPlayerUI() 工厂 + <player-ui> Web Component
├─ nav.js          # 顶部导航 + MODULES 模块清单（站点首页事实源）
├─ README.md       # 本文档：适配器协议 / 引用方式 / 主题令牌
└─ demo/index.html # 演示站首页（全部模块入口卡片）
```

## 二、各模块 demo 的标准引用方式

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <link rel="stylesheet" href="../../site/site.css">
</head>
<body class="dsk-body">
  <div data-site-nav data-root="../../"></div>

  <main class="site-page">
    <!-- 画面/波形舞台 -->
    <div class="stage" id="stage"></div>
    <!-- 控制条挂载点 -->
    <div id="ui"></div>
  </main>

  <script type="module" src="../../site/nav.js"></script>
  <script type="module" src="./index.js"></script>
</body>
</html>
```

要点：

1. `<body class="dsk-body">` 提供基础排版；`data-site-nav` 元素由 nav.js 自动渲染导航。
2. `data-root` 必须写「当前页面 → 仓库根」的相对路径（demo 页固定为 `../../`）。
3. 控制条由 JS 创建（`createPlayerUI({ mount: '#ui' })`），或直接写
   `<player-ui title="WAV 播放器"></player-ui>` 使用 Web Component 封装。

## 三、PlayerAdapter 协议（各模块 Player ↔ 控制条的唯一耦合点）

```js
const adapter = {
  play(),                          // 开始播放
  pause(),                         // 暂停
  seek(sec),                       // 跳转到第 sec 秒
  setVolume(v),                    // 可选。v ∈ [0,1]
  setRate(r),                      // 可选。倍速
  duration: () => number | null,   // 秒；null 或 Infinity = 直播/未知时长
  currentTime: () => number,       // 秒
  seekable: true,                  // 可选，默认 true；false 时进度条不可拖
  rates: [0.5, 0.75, 1, 1.5, 2],   // 可选倍速档位
  on(event, cb) { …; return off }, // 订阅事件，必须返回退订函数
  getStats: () => [['键', '值'], …] // 可选。统计面板数据源
};
// 需要转发的事件：
// 'time'({currentTime,duration}) 'play' 'pause' 'ended'
// 'ready' 'buffering'(boolean) 'error'(Error)
createPlayerUI({ mount: '#ui', fullscreenEl: '#stage-wrap' }).bind(adapter);
```

约定：适配器内部一律使用契约的**整数微秒**时间戳，仅在适配器边界换算成秒交给皮肤；
换算用就近取整（µs ÷ 1e6）。

## 四、控制条能力清单

| 功能 | 说明 |
|---|---|
| 播放/暂停 | 主按钮 + 空格/K 快捷键 |
| 进度条 | Pointer Events 拖拽（兼容触屏）、缓冲区间展示、直播态禁拖 |
| 音量 | 滑杆 + 静音切换（M），双击滑杆恢复 100% |
| 倍速 | 弹出菜单，档位来自 `adapter.rates` |
| 全屏 | 对 `fullscreenEl`（默认控制条父级）requestFullscreen（F） |
| 统计面板 | S 键开关；每 500ms 刷新 `getStats()` 结果；HTML 已转义防注入 |
| 快捷键 | 空格/K 播放暂停、←→ ±5s、↑↓ 音量、F 全屏、M 静音、S 统计 |
| 错误提示条 | `ui.setError(msg)` 或适配器 `'error'` 事件自动展示 |

## 五、设计令牌（site.css 第 1 节）

| 类别 | 变量示例 |
|---|---|
| 色板 | `--dsk-bg / --dsk-bg-elev / --dsk-surface / --dsk-border / --dsk-text(-dim/-faint) / --dsk-accent / --dsk-ok / --dsk-warn / --dsk-danger` |
| 字体 | `--dsk-font / --dsk-font-mono / --dsk-fs-xs…xl` |
| 尺寸 | `--dsk-radius-sm/md/lg / --dsk-bar-h / --dsk-nav-h` |
| 动效 | `--dsk-ease / --dsk-fast` |

历史浅色接口已停止交付；当前 pp 皮肤仅提供深色主题。

## 六、BEM 命名约定

- 导航：`.site-nav` `.site-nav__brand` `.site-nav__links` `.site-nav__link--active`
- 卡片：`.demo-card` `.demo-card__title/--desc/--meta`
- 控制条块名 `.pui`：`.pui__btn--main`、`.pui__progress-fill`、`.pui__rate-menu--open` 等。
- 各模块 demo 只允许写「本页专属」样式于页内 `<style>`，跨页复用的样式一律上收至 site.css。

## 七、已知限制

- `<player-ui>` 为 light-DOM 封装（不使用 Shadow DOM），因此样式完全来自 site.css，页面不得污染 `.pui` 内部类名。
- 全屏按钮依赖 `Element.requestFullscreen`（iOS Safari 不支持时按钮无效但不报错）。
- nav.js 的当前页高亮基于路径字符串匹配，若部署在子路径下请保持相对链接结构不变。

---
*ui-kit-dev · 2026-08-25*

## 测试运行指引（重要）

本机 Node 22 的 runner 对 **目录形式** `node --test <dir>/` 会把目录当 CJS 入口 require，
报 MODULE_NOT_FOUND 并表现为「文件级失败」——这是环境问题，不是模块缺陷。
请一律使用通配形式：

```bash
node --test wav/__tests__/*.test.js
node --test flac/__tests__/*.test.js      # 含 perf.test.js 吞吐硬门槛 ≥实时2×
node --test ape/__tests__/*.test.js
node --test subtitle/__tests__/*.test.js
```

## 八、皮肤家族边界与冻结声明（2026-08-26）

| 家族 | 文件 | 前缀 | 状态 |
|---|---|---|---|
| 新结构（DESIGN.md §11） | `css/{tokens,base,layout,components}.css` + `js/skin.js` + `assets/icons.svg` | 无前缀 BEM + `data-skin` | 现行交付面（ref-hls/ref-flv/wav/flac 已接入） |
| pp-* 家族（视觉规范 §2 参考实现） | `skin.css` + `skin.js` | `.pp-*` + `data-pp-*` | 冻结维护（subtitle/demo 在用） |
| 遗留三件套 | `site.css` + `player-ui.js` + `nav.js` | `--dsk-*` / `.pui` / `data-site-nav` | **冻结不扩展**（leader 裁决），合并/归档待 captain M3 |
| ~~新结构家族~~（并入 pp 收敛） | `css/{tokens,base,layout,components}.css` + `js/skin.js` + `assets/icons.svg` | 无前缀 BEM（§10）+ `data-skin` | ref-hls/ref-flv 在用；wav/flac/ape 标记迁移排期中 |
| **收敛目标** | `skin.css` + `skin.js`（--pp-*/.pp-*） | `.pp-*` + `data-pp-*` | **现行共享家族**；全站页面均已迁移；遗留路径仅保留令牌/API 兼容 |

### 迁移进度（裁决③执行记录 · 2026-08-26）

| 页面 | 原家族 | 状态 |
|---|---|---|
| landing / overview / 16 modules / 2 reference pages | mixed | ✅ shared pp skin + common navigation |
| site/demo/index.html（hub） | dsk 遗留 | ✅ 已迁 pp-* |
| wav/demo、flac/demo、ape/demo | dsk 遗留（css×4 兼容期） | ⏳ 排期：下轮按 hub 模式迁移 |
| subtitle/demo | pp-*（原生） | ✅ 无需迁移 |
| cmaf/hls/mkv/webrtc 等 8 页 | dsk 遗留 | ⏳ compat 层已保视觉一致；标记迁移随 owner 波次 |

**compat 层**：site.css 头部已注入 `@import skin.css` + 全量 --dsk-*→--pp-* 令牌别名——遗留页零改动即继承目标视觉值，类名/标记迁移完成前不发生视觉漂移。site.css 进入退役倒计时，归档删除待全部页面迁毕。

规则：M3 裁决前三个家族互不扩展、互不迁移；令牌冲突以 docs/design/视觉规范.md v1.0 为唯一依据。

## 九、M3 走查待办（记录用）

- DESIGN §7.3 进度滑杆「缓冲段色 == 轨道色」（同为 gray-700）按字面实现，视觉区分度问题由 designer 列入 M3 全站走查一并复核（裁决②，非阻塞）。
- 三皮肤家族合并/归档方案（见 §八 边界表），待 captain M3 裁决。
- DESIGN §11 措辞改具名导入（designer 侧文档任务）。

> 四项长期挂起裁决合并终答（2026-08-26，captain；此前分别裁定，此处汇总存档）：①**default export 冲突**：契约 §0.4 硬约束胜出——具名导出为正典，skin.js 尾部 `export { Skin as default }` 兼容别名允许（注释标明契约例外仅此一处），DESIGN §11 措辞由 designer 改为具名导入；②**§7.3 缓冲段==轨道色**：按字面实现接受（非阻塞），视觉区分度列入 M3 全站走查由 designer 复核；③**版本引用勘误知悉**——现行=DESIGN.md v1.1 历史锚点+视觉规范.md v1.0 现行维护版，按 v1.1 实现正确；④**M3 双皮肤收敛方向**：维持第 20 版裁决——目标=--pp-*/.pp-* 家族，9 个 demo 由 ui-kit-dev 统一迁移+compat 层过渡，旧家族出口前退役归档；根 package.json 测试脚本已是通配+force-exit 形式（sdet 早前完成），模块级以 net-dev 显式 glob 示范为准（wav/flac/ape/subtitle 已同步落盘，`npm test` = node --test --test-force-exit "__tests__/*.test.js"）。四项至此全部有终答，后续不再受理同题重申。原编号文本：④M3 收敛目标=--pp-*/.pp-* 家族，9 个 demo 由 ui-kit-dev 统一迁移 + compat 层过渡，旧家族出口前退役归档；根测试脚本已通配+force-exit（sdet），模块级脚本以 net-dev 显式 glob 示范为准（四模块已同步，`npm test` = node --test --test-force-exit "__tests__/*.test.js"）。
- review-round1 #8 闭环（2026-08-26）：wav 全模块裸 Error 清零，统一十码 PlayerError；模块级 package.json 脚本落盘。
- review-round1 建议级收尾（2026-08-26）：f32 NaN/±Inf 钳制补回归用例（wav review-fixes 11 例全绿，全套 39/39）；alaw/ulaw 仅存常量/GUID 映射供 EXTENSIBLE 识别后拒绝（非死代码），waveCodecString 已无死分支。


### 内置示例与浏览器验收
`site/demo-samples.js` 是每页唯一的快速体验入口数据源；确定性离线测试媒体保存在 `site/assets/samples/`，
由 `node scripts/generate-demo-media.mjs` 重新生成（没有外网下载）。点击按钮触发实际播放器/解析入口，不会自动播放媒体；
音频的“载入样例”按钮只解码，需再点播放。参考实现明确标注 CDN 网络要求，RTSP/RTMP 明确提示先运行 `npm run gateway`。

```bash
node scripts/e2e/demo-smoke.mjs --base-url http://localhost:8080 --width 1280 --out-dir .tmp/ui-smoke
node scripts/e2e/demo-smoke.mjs --base-url http://localhost:8080 --width 390 --out-dir .tmp/ui-mobile
```

截图与 JSON 报告默认写入 `.tmp/`，不覆盖 `docs/review/i3/` 历史验收图；测试需要本机 Chrome 与已有 Playwright Core 工具副本，播放器本身没有第三方运行时依赖。
