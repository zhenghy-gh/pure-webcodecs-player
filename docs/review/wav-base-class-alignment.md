# wav 与 Demuxer 基类对齐 —— 治理裁决（候选 3，案 C 已落地）

> 2026-09-09 ｜ reviewer ｜ 对应 `docs/review/checklist.md` §2.4 与 `round-2-问题清单.md` §10 候选 3
> 性质：**设计裁决笔记**。初稿为「待批准」状态（零代码改动）；2026-09-09 经 owner 连续「继续」授权，**案 C 已落地**（见 §10），本文 §8 裁决随之更新。遗留「完全同构」（案 A）仍为跨模块裁决项。
> 基线：`wav/__tests__` 43/43 绿；全仓 1030/1030 绿（含 Wave 51 AbortSignal）。
> 关联：`mkv-base-class-alignment.md`（mkv 已基类化 + D1-D12 裁决）、`flac`（已基类化）同系列。

---

## 1. 目标与约束

把 `WavDemuxer`（现**独立实现、不继承** core `Demuxer`）切到基类，满足契约 §2.2/checklist §2.4「`<Format>Demuxer` 且继承 core `Demuxer` 基类」。

**当前状态**：wav 已 `extends Demuxer`（案 C，2026-09-09 落地，见 §9/§10），`MiniEmitter` 自含实现删除交基类，状态机/事件面/`open()`/双发对齐基类；`readSample/samples/seek/stop/parseInit` 保留自实现覆盖与 `ended`/`error` 兼容标记。**「完全同构」（案 A）仍为跨模块裁决项，禁止单模块擅改。**

**硬约束（子类化落地前）**：
1. 公开面（probe/open/parseInit/readSample/seek/samples/pause/resume/destroy/getBufferedRanges）冻结，shape 与契约 §2.2 对齐；
2. 本文列出的「保留/禁止擅改」项，在子类化批准前**不得擅自"修正"为基类形态**——多数差异是点播语义/迁移期兼容，改之即能力退化（同 mkv D2 教训）；
3. 与基类语义分歧，沿用 `mkv-base-class-alignment.md` §8 已裁决的 D1-D12（按格式类比适用）。

---

## 2. 现状（磁盘实码）

### 2.1 core `Demuxer` 基类要点（core/src/demuxer.js）

- 状态机 `DEMUXER_STATES`：`idle→opening→ready⇄seeking→destroyed`，`_transition` 白名单 + 非法迁移抛 STATE_ERROR（:98-106）。
- `open()`（:129-178）：幂等；opening 并发**共享 `_openPromise`**；失败 → `_transitionSafe(DESTROYED)`（终态不可重试）；`Promise.race` initTimeoutMs 超时 → 回 idle；成功 `sortTracks` + **事件双发 `'media-info'`+`'mediaInfo'`**（:152-153）。
- `readSample(trackId, options)`（:199-243）：`_requireUsable`；`_trackIterators` Map 缓存 per-track `AsyncGenerator`；EOS→null + `_maybeEmitEnd`；中断竞速期间落地样本缓存 `pendingResult` 续读（Wave 51）；**每次成功 readSample 都 emit `'sample',{trackId,sample}`**（:241）。
- `samples(trackId=undefined, options)`（:250-264）：懒生成器，首 next() 才 `_requireUsable`。
- `seek(timestampUs)`（:277-299）：`_requireUsable` → 非 seekable reject SEEK_UNSUPPORTED → 非法值抛 STATE_ERROR → SEEKING 迁移 → return 所有迭代器 → `_doSeek` → finally 回 READY。
- `destroy()`（:320-340）：幂等 → DESTROYED → return 迭代器 → `source.close?.()` → emit('end',aborted) → **`removeAllListeners()`**。
- `pause()/resume()`：置 `pausedFlag` + emit('pause'/'resume')；`start(){}` 空桩。
- 钩子：`_doOpen()` / `_createTrackIterator(id)` / `_doSeek(us)`（默认 SEEK_UNSUPPORTED）。
- 事件集（§2.3）：`'error'/'media-info'/'sample'/'progress'/'end'/'statechange'/'mediaInfo'(过渡旧名)`。

### 2.2 wav 独立实现（wav/src/demuxer.js, 303 行）

- `class WavDemuxer`（:43，**无 extends**）；自含 `MiniEmitter`（:36-41），事件集 `'error'|'media-info'|'end'|'pause'|'resume'`。
- 状态机自管字符串集 `'idle'→'parsing'→'ready'⇄'seeking'→'ended'|'error'` + `'destroyed'`（:74，`destroy()` 置 :287），**无 `LEGAL_TRANSITIONS` 白名单**，非法迁移不抛 STATE_ERROR（仅各方法检查特定 state 后用 `stateError` 拒绝）。
- `probe(bytes)`（:49-59）：同步、无副作用、不抛；RIFF/WAVE 嗅探，`confidence 0.95`。
- `parseInit()`（:95-146，**= open 别名**）：非 idle/已 destroyed → 抛 stateError；`parsing` 态；`Promise.race` initTimeoutMs 超时 → reject TIMEOUT（:101-107）；成功 `mediaInfo` 赋值 + emit('media-info')，返回；**失败 → state='error' + emit('error') + rethrow**（:139-142）。
- `samples(trackId, options)`（:154-214）：自定义 async iterator；`#startFrame` 游标；`#endEmitted` 防重；EOS→state='ended' + emit('end',{reason:'eos'})→done；`signal` 经 `raceAbort`（:182-189）；catch 排除 `ABORTED`（:192-195，Wave 51 修）。
- `readSample(trackId, options)`（:255-265）：包 `#reader` 迭代器（与 samples 游标一致），EOS→null；`signal` 经 `raceAbort`。
- `seek(timestampUs)`（:221-243）：非 ready/ended/seeking → 抛；非法值抛 stateError；`seeking`→更新 `#startFrame`→**回 ready**（从 ended seek 修复，:236-237）。
- `open()`（:248）= `parseInit()`；`destroy()`（:285-288）= `stop()`+state='destroyed'；`stop()`（:297-302）= `source.close?.()` + （非 error 时）state='idle'。
- `getBufferedRanges(_trackId)`（:291-294）：点播返回全区间 `[{startUs:0, endUs:durationUs}]`。
- `pause()/resume()`（:273-282）：置 `pausedFlag` + emit('pause'/'resume')。
- 数据源：`this.#source`（`{size, read, close}` ByteSource），直接持有，未归一化为 `this.source`。

---

## 3. 同构性（与基类对齐面）

| wav 现实现 | 基类对应 | 子类化方式 |
|---|---|---|
| `MiniEmitter` 事件 | core `Emitter`（基类已继承） | 删自含，交基类 |
| `parseInit`/`open` 双名 | 基类 `open()` + 钩子 `_doOpen()` | `parseInit` 转 `open()` 别名；解析体拆入 `_doOpen()` |
| `samples`/`readSample` 自定义迭代器 | 基类 `readSample` 主通道 + `_createTrackIterator` 钩子 | 改走基类（或保留自实现覆盖，见 §4 W6） |
| `seek` 自实现 | `_doSeek(us)` 钩子 | 拆入钩子（清 `#startFrame`） |
| `stop`/`destroy` 自管理 | 基类 `destroy()`（含 removeAllListeners） | 删自管，交基类；`stop` 作为别名 |
| `getBufferedRanges` | 同名钩子 | 原样保留 |
| `pause/resume` | 同名方法 | 原样保留 |

---

## 4. 行为差异矩阵（wav 现语义 → 基类语义；★=测试/注释已固化）

| # | 维度 | wav 现状 | 基类语义 | 影响 | 裁决（预填，待批准） |
|---|---|---|---|---|---|
| W1 | 是否继承基类 | ✅ `WavDemuxer extends Demuxer`（案 C，2026-09-09） | `extends Demuxer` | 已对齐 | **案 C 已落地**；进一步「完全同构」须跨模块裁决 |
| W2 | 状态机 | 基类状态机 + 自有 `ended`/`error` 直接写 `stateValue`（兼容标记） | `_transition` 白名单 + 抛 STATE_ERROR | 弱约束（flac 同款） | 保留兼容标记；非法迁移统一用 PlayerError（D12） |
| W3 | open 幂等/重入 | 走基类（共享 `_openPromise`、usable 直返） | 同 | 已对齐 | 沿用 D1：新模块用基类共享 promise |
| W4 | open 失败终态 | `_doOpen` 抛错 → 基类 → DESTROYED（终态） | 同 | 行为变化（原 'error' 终态） | 沿用 D2：失败恢复策略待跨模块统一；**禁止单模块擅改** |
| W5 | media-info 旧名 | ✅ 基类双发 `'media-info'`+`'mediaInfo'` | 双发 | 已补齐 | 接入前补事件兼容测试（已做，wav.test 'parseInit 产出契约 MediaInfo 并发事件'） |
| W6 | readSample emit 'sample' | 纯 pull，不 emit 'sample' | 每次成功 emit('sample') | 增发事件 | 沿用 D7：pull 不依赖 'sample'；仅 `start()` 推送模式可依赖 |
| W7 | EOS 表达 | samples 迭代器 `stateValue='ended'` + emit('end'); readSample 经 #reader 返 null | readSample 返 null + `_maybeEmitEnd` | 等价 | 子类化后统一走基类 `_maybeEmitEnd`（防重语义同 D4） |
| W8 | seek 失败码 | 非法值抛 STATE_ERROR | 同 STATE_ERROR | 一致 | 沿用 D6 口径 |
| W9 | destroy 监听器 | 自版 destroy（close + destroyed），不 `removeAllListeners`；`stop` 可回 idle | `removeAllListeners` | 销毁后监听保留 | 沿用 D9：基类行为为准（同 flac 案 C 现状，跨模块统一议题） |
| W10 | getBufferedRanges | 点播返全区间 | 同名钩子 | 一致 | 保留 |
| W11 | pause/resume | ✅ 继承基类（pausedFlag + emit），已删自版 | 同 | 一致 | 沿用 D10：仅直播推送作为可观测事件 |
| W12 | 事件集完整度 | 基类补齐（含 'sample'/'progress'/'statechange' 事件面） | 含全部 | 已补齐 | 基类事件面自动生效 |
| W13 | signal 中断 | readSample/samples 已接 `raceAbort`（Wave 51） | 同（§12.3 新增可选成员） | 一致 | 已对齐，保留 |
| W14 | 数据源字段 | `super(source)` → `this.source`（基类字段） | 基类 `this.source` | 已对齐 | 已对齐 |

---

## 5. 测试固化点（wav/__tests__ 锁死的断言）

| 测试 | 断言 | 锁死差异 |
|---|---|---|
| wav.test.js（probe/parseInit/samples/seek/destroy 集合） | probe RIFF/WAVE 嗅探；parseInit 后 mediaInfo.tracks[0].codec 为 pcm-*；samples 整帧 pcm 字节、µs 时间戳；seek 落点 µs 回退；destroy 幂等 | 公开面 shape（W1 公开契约） |
| Wave 51 新增 2 例 | samples 挂起可被 signal 取消、不丢帧、不 emit('error') | W13 + 中断不误判故障 |

> 结论：wav 公开面对齐契约 §2.2，但**内部实现完全独立**。直接机械"继承基类"会丢失 W4 可恢复性语义、改变 W3/W5/W7 行为，且需补 D8 双发与 D9 监听器测试——属跨模块议题，**不得单模块擅改**（同 mkv D2）。

---

## 6. 三案设计（子类化时）

### 案 A：贴基类，改测试
删 wav 自管 open/readSample/samples/seek/destroy/state 自管理，全用基类；接受 W3/W4/W5/W7 行为变化，补 D8 双发 + D9 removeAllListeners 测试。
- 优点：与 flac/ts 完全同构。
- 代价：wav 可恢复性（W4）退化、未 open 访问行为变化（W3）；需跨模块裁决。

### 案 B：基类 + 子类守卫 override
继承基类复用状态机/open/destroy/事件双发；`readSample/samples/seek` 用基类，override 保留 W4 可恢复性 + W5 单发（如需）。
- 优点：行为不变。
- 代价：override 面大，长期维护两套语义。

### 案 C：形式继承，核心自实现保留（推荐，对齐 mkv/flac）
`extends Demuxer`，状态机切 `stateValue`（删 `MiniEmitter`/自管 state/open/destroy/pause/resume），但 `readSample/samples/seek` 与中断保护、end 判定**保留自实现**覆盖基类；`parseInit`/`open`/`stop`/`destroy` 别名保留。
- 优点：拿到「继承基类 + 统一状态机 + 统一 destroy」形式对齐；测试零回归；语义分歧延后到批准波次。
- 代价：readSample/samples/seek 仍是自实现，与 ts 复用深度不同。

### 推荐
**先 C 后 A**（与 mkv/flac 一致）。子类化批准前，**本文档锁定现状，禁止任何"修正"**。

---

## 7. 待批准裁决问题（升级清单）

1. **W4 失败恢复**：wav 失败 → 'error' 终态 vs 基类 DESTROYED vs mkv 'idle' 可重试——三套终态需统一口径。
2. **W3 open 重入**：严抛（wav）vs 共享 promise（基类/flac）——新模块统一基类。
3. **W5 事件旧名**：wav 单发 vs 基类双发——子类化补双发 + 兼容测试。
4. **W7 end 语义**：统一到契约字面「全部轨 EOS」（D4 裁决目标）。

---

## 8. 当前裁决（2026-09-09 更新：案 C 已落地）

| 差异 | 当前裁决 | wav 实现 | 约束 |
|---|---|---|---|
| W1 继承 | **案 C 已落地**（owner 授权） | `class WavDemuxer extends Demuxer`（2026-09-09） | 禁止无跨模块裁决的「完全同构」（案 A） |
| W2-W14 | 沿用 mkv §8 的 D1-D12 裁决（按格式类比）；W4 可恢复性/失败终态见 §7-1 待统一 | 见 §4 与 §10 | 禁止单模块擅改 |

**护栏（写入代码注释，防误删/误改）**：
- `wav/src/demuxer.js` 头注释已声明案 C 落地与「进一步完全同构属跨模块裁决项」——**勿回退为独立实现，勿擅自案 A**。
- `parseInit`/`open` 双名、`stop`/`destroy` 双名为兼容别名，删除需随跨模块裁决一并处理。

---

## 9. 子类化落地记录（2026-09-09 已执行，案 C）

案 C 步骤（对照 §6 三案设计）：
1. `class WavDemuxer extends Demuxer`（`core/src/demuxer.js`）；`super(source, options)` → `this.source`/`this.options.initTimeoutMs`/`stateValue`/`pausedFlag`/Emitter 由基类接管。
2. 删除 `MiniEmitter` 自含实现 → 基类 Emitter（`on` 返回退订、`emit` 吞监听器异常，语义一致）；`this.emitter.*` → `this.emit/this.on`。
3. `parseInit` 体拆入 `_doOpen()` 钩子（`_doOpen` 只解析头返回 MediaInfo，不再自管状态/事件/超时——超时与 `'media-info'+'mediaInfo'` 双发由基类 `open()` 统一负责，W5 补齐）；保留 `parseInit(){return this.open()}` 别名。
4. `readSample/samples/seek` 保留自实现覆盖（含 signal、先读后推进游标、自有 `ended`/`error` 标记、seek-from-ended 回 ready）。
5. `pause()/resume()` 删除自版覆盖 → 继承基类（语义一致：置 pausedFlag + emit）；`stop()`/`destroy()` 保留自版（close + destroyed 终态，不 removeAllListeners，W9 兼容）。
6. `mediaInfo` 字段 → 基类 `mediaInfoValue`（基类 `get mediaInfo` 返回）；`#source` → `this.source`。
7. 验证：`wav/__tests__` 43/43 绿（含 fixture 集成、review-fixes、AbortSignal）；全仓回归待确认（基线并发 4）。

## 10. 案 C 落地后仍保留的差异（W2/W3/W4/W6/W7/W9，勿擅改）

| 差异 | 落地后现状 | 约束 |
|---|---|---|
| W2 状态机 | 基类状态机 + 自有 `ended`/`error` 直接写 `stateValue`（同 flac 兼容标记） | 保留 |
| W3 open 幂等 | `open`/`parseInit` 走基类（共享 `_openPromise`、usable 直返） | 已对齐基类，删自版 |
| W4 失败终态 | `_doOpen` 抛错 → 基类 open catch → DESTROYED 终态 | 同 mkv D2，待跨模块统一 |
| W6 readSample emit 'sample' | pull 路径不 emit 'sample'（继承 flac/mkv 语义） | 符合 D7 裁决 |
| W7 EOS | samples 迭代器置 `stateValue='ended'` + emit('end')；readSample 返 null | 保留 |
| W9 destroy | 自版 destroy（close + destroyed），不 removeAllListeners | 同 flac，D9 兼容 |

## 11. 开放风险

- wav 独立实现期间…… 已随案 C 落地消除；现风险为「把案 C 保留差异当成缺陷再改回基类形态」（W2/W6/W7），review 应依据 §10 驳回此类改动。
- 公开面 shape 已对齐契约 §2.2，demo/site 可正常消费；内部差异不影响上层。
