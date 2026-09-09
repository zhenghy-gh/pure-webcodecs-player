# mkv extends Demuxer 基类对齐 —— I1 前置预研（F10）

> 2026-09-07 ｜ reviewer ｜ 对应 `docs/review/checklist.md` F10 与 §24.1
> 性质：**设计预研笔记**（零代码改动）。供第二轮 I 系列（M3 末触发）开波时直接落地，或提前裁决契约语义分歧。
> 基线：`mkv/__tests__` 74/74 绿；全仓低并发 918/918 绿。

---

## 1. 目标与约束

把 `MkvDemuxer`（现 `extends Emitter` 自含同形实现）切到 core `Demuxer` 基类，满足契约 §2.2/checklist §2.4「类名 `<Format>Demuxer` 且继承 core `Demuxer` 基类」。

**硬约束**：
1. `mkv/__tests__` 74 例**零回归**（既有断言是行为契约，改动不得破坏——见 §5）；
2. 公开面冻结（§12.3）：方法名/事件/数据形状不变；
3. 与 ts 样板（`TsDemuxer extends Demuxer`，ts-demuxer.js:42）**语义分歧须显式列出**，交由 I1 裁决，本笔记不擅自定夺。

---

## 2. 现状（磁盘实码）

### 2.1 core `Demuxer` 基类（core/src/demuxer.js, 412 行）

- 状态机 `DEMUXER_STATES`：`idle→opening→ready⇄seeking→destroyed`，`_transition` 白名单 + 非法迁移抛 STATE_ERROR（:97-105）。
- `open()`（:128-177）：幂等；**opening 并发共享 `_openPromise`**（:132-134）；失败 catch → `_transitionSafe(DESTROYED)`（:155，**终态不可重试**）；`Promise.race` initTimeoutMs 超时 → 回 idle（:163）；成功后 `sortTracks` + 事件双发 `'media-info'`+`'mediaInfo'`（:151-152）。
- `readSample(trackId)`（:192-219）：`_requireUsable`（ready/seeking）；`_trackIterators` Map 缓存 per-track `AsyncGenerator`；EOS 置 done → `_maybeEmitEnd` → null；**每次成功 readSample 都 emit `'sample',{trackId,sample}`**（:217）。
- `_maybeEmitEnd`（:347-352）：**只要有迭代器的轨全部 done 即 emit 'end'(eos)，无防重**（A 轨先 EOS、B 轨后 EOS → 发两次；只拉 A 不拉 B → A EOS 即发）。
- `seek(timestampUs)`（:252-274）：`_requireUsable` → `!seekable` reject SEEK_UNSUPPORTED → **非法值抛 STATE_ERROR** → SEEKING 迁移 → return 所有迭代器 → `_doSeek` → finally 回 READY。
- `samples(trackId=undefined)`（:225-239）：**懒生成器**（首次 next() 才 `_requireUsable`），缺省 trackId 时按轨序串行全轨。
- `destroy()`（:296-314）：幂等 → DESTROYED → return 迭代器 → `source.close?.()` → emit('end',aborted) → **`removeAllListeners()`**。
- `pause()/resume()`：置 `pausedFlag` + emit('pause'/'resume')。
- getter：`mediaInfo`→`mediaInfoValue`（未 open 返回 null）、`tracks`→`[]`、`metadata`→null；**均无守卫，不抛**。
- 钩子：`_doOpen()`（返回 MediaInfo）/ `_createTrackIterator(trackId)`（返回 AsyncGenerator）/ `_doSeek(us)`（可选，默认 SEEK_UNSUPPORTED）。
- 别名：`attach`（仅 idle）、`init`、`getMediaInfo`、`getTracks`、`getTrack`、`readSampleData`。

### 2.2 mkv 自含实现（mkv/src/demuxer.js, 987 行）

- `extends Emitter`（:66）；自管 `_state`（'idle'→'opening'→'ready'→'destroyed'，:128）+ `get state`（:174）。
- `open()`（:236-257）：destroyed 抛 / ready 直返 / **opening 重入抛 STATE_ERROR**（:241-243，非共享 promise）；失败 → **回 idle**（:252，可 attach 换源重试）+ emit('error') + rethrow。
- 守卫 `#assertReady`（:621-624）：destroyed 或非 ready → 抛 STATE_ERROR；挂在 `tracks`（:594-597）/`metadata`（:599-610）/`mediaInfo`（测试断言）getter、`readSample`、`seek`、`getBufferedRanges`（:613-619 ready 检查）上。
- `readSample(trackId)`（:638-658）：`#assertReady` → **未知轨 PARSE_ERROR**（:642）/ **encrypted NOT_SUPPORTED**（:644）→ `#trackIterators` 缓存 `#iterateTrack(trackId)` → next；EOS → `#eosedTracks.add` + `#maybeEmitEnd` → null。**纯 pull，不 emit 'sample'**。
- `#iterateTrack`（:677-693）：包装 `samplesInternal({...#pullOpts, trackIds:[trackId]})`，补 `index` 计数 → 产出契约 Sample 形状（µs、dts=timestampUs）。
- `#maybeEmitEnd`（:699-708）：**每个非 encrypted 可读轨都必须"已建迭代器且 EOS"才 emit 一次**（`#endEmitted` 防重）；未拉取的轨视为未结束。
- `samples(trackId)`（:661-672）：**同步 `#assertReady`**（返回生成器前即抛）。
- `seek(us)`（:717-740）：`#assertReady` → **非法值抛 PARSE_ERROR**（:720，非 STATE_ERROR）→ `!seekable` SEEK_UNSUPPORTED → `#ensureSeekIndex` → `locate` → 清 `#trackIterators/#eosedTracks/#sampleIndexByTrack/#endEmitted` → 更新 `#pullOpts={startFileOffset,fromUs}` → `#peekActualTimestamp` → resolve `{actualTimestampUs}`。
- `pause()/resume()/start()`（:815-817）：**空桩，不发事件**。
- `destroy()`（:822-829）：幂等 → clear 迭代器 → `dataSource.close?.()` → emit('end',aborted)；**不 removeAllListeners**。
- 别名：`init/parseInit`（:261-263，转 open）、`attach`（仅 idle，重注入 dataSource，:269-285）。
- 数据源：构造把 source 规范化为 `this.dataSource`（size getter 兼容 byteLength + close 透传，:123-127）；内部全走 `this.dataSource`。

### 2.3 ts 样板（已基类化，ts-demuxer.js）

- `class TsDemuxer extends Demuxer`（:42），`_doOpen` 内自循环等待参数集捕获（:300）；test 明确 **未 open 的 samples() 是懒生成器**（ts-demuxer.test.js:187-190 注释「异常在首次 next() 时抛出」）。

---

## 3. 同构性（好消息）

mkv 的 pull 骨架与基类**天然同构**，迁移面小：

| mkv 现实现 | 基类对应 | 迁移方式 |
|---|---|---|
| `#trackIterators` Map + 惰性建迭代器 | `_trackIterators`（readSample 内建） | 删除自管，交基类 |
| `#iterateTrack(trackId)` | `_createTrackIterator(trackId)` 钩子 | **改名即用**（含 index 计数/形状拼装） |
| `samplesInternal` 内核 | 子类私有内核（`_doOpen`/迭代器内引用） | 原样保留 |
| open 的 `#scanHeaders`+`#buildMediaInfo` | `_doOpen()` 钩子 | 拆入钩子（去状态/emit 管理） |
| seek 体（ensureSeekIndex/locate/清游标/peekActual） | `_doSeek(us)` 钩子 | 拆入钩子（清 `#pullOpts` 等子类私有态） |
| destroy 清迭代器 + close | 基类 destroy | 删除自管 |
| `#assertReady` + getter 守卫 | 基类 getter（无守卫） | **override 保留守卫**（见 §5） |

---

## 4. 行为差异矩阵（mkv 现语义 → 基类语义；★=测试已固化）

| # | 维度 | mkv 现状 | 基类语义 | ts 样板 | 影响 |
|---|---|---|---|---|---|
| D1 | open 重入 | ★重入抛 STATE_ERROR（:241） | opening 并发共享 promise | 共享 | 行为变化（测试未直接固化重入？见 §5 复核） |
| D2 | open 失败 | 回 idle，可 attach 换源重试（:252） | → destroyed 终态 | destroyed | **能力退化**：mkv 现有 attach 重试路径失效 |
| D3 | 未 open 访问 getter | ★tracks/mediaInfo/metadata 同步抛 STATE_ERROR（:126/:131） | 返回 null/[]/null 不抛 | 返回默认值 | ★**冲突（mkv 更严）** |
| D4 | end 时机/单次 | ★所有非 encrypted 可读轨被拉完才 emit 一次（#endEmitted 防重） | 已建迭代器轨全 done 即发、**可多次**、未拉轨不影响 | 基类 | ★**冲突（mkv 更严；基类会提前/重复发）** |
| D5 | 未知轨/encrypted | ★readSample 抛 PARSE_ERROR/NOT_SUPPORTED（:136 测试） | 前置到 `_createTrackIterator` 首建时抛（基类建迭代器在 try 外，不 emit） | — | 等值（校验移钩子开头） |
| D6 | seek 非法目标码 | PARSE_ERROR（:720） | STATE_ERROR | STATE_ERROR | 码变化（少见路径） |
| D7 | readSample 是否 emit 'sample' | 纯 pull 不发 | 每次成功 emit('sample',{trackId,sample}) | 发 | 增发事件（监听者通常无） |
| D8 | media-info 旧名 | 只发 'media-info'（:249） | 双发 'media-info'+'mediaInfo' | 双发 | 增发旧名（§2.4 过渡期双发为设计内） |
| D9 | destroy 监听器 | 不 removeAllListeners | removeAllListeners | 基类 | 销毁后监听失效（通常合理） |
| D10 | pause/resume | 空桩不发事件（:815-816） | 置 pausedFlag + emit('pause'/'resume') | 基类 | 增发事件 |
| D11 | samples() 未 open | ★**同步抛**（contract-edge:281） | 懒生成器（首 next 抛） | 懒生成器 | ★**冲突（mkv 更严）** |
| D12 | state 字段命名 | `_state` + get state | `stateValue` + get state | 基类 | 内部机械替换 |

---

## 5. 测试固化点（74 例中锁死上述差异的断言）

| 测试 | 断言 | 锁死差异 |
|---|---|---|
| demuxer.test.js:124-132「STATE_ERROR：未 open 访问 tracks/readSample；销毁后访问」 | :126 `d.tracks` **同步抛** STATE_ERROR；:131 `d.mediaInfo` 同步抛 | D3 |
| contract-edge.test.js:281-283「samples()：未 open 同步抛 STATE_ERROR（非 Promise 拒绝）」 | `d.samples(1)` **同步抛** | D11 |
| demuxer.test.js:141「事件：media-info 恰一次；两轨 EOS 后 end(eos)」 | 两轨分别 for-await 拉完 → end 一次（payload 校验） | D4（+D8 计数兼容：基类 'media-info' 仍恰一次） |
| demuxer.test.js:136「readSample：未知轨道 PARSE_ERROR」 | `assert.rejects(... e.code==='PARSE_ERROR')` | D5（移钩子后需保持不 emit 'error'） |
| demuxer.test.js:86/117、lazy-open.test.js | pull/EOS null/samples 糖层/惰性 open | 兼容基类 readSample/samples 主通道 |

> 结论：**直接机械替换必挂 3 组断言**（D3 getter 守卫、D11 samples 同步抛、D4 end 语义）。mkv 的守卫/end 语义比基类与 ts 样板更严，且贴近契约 §2.3「end：全部轨 EOS」字面。

---

## 6. 三案设计

### 案 A：贴基类，改测试（语义向 ts/基类看齐）
删 mkv 自管 open/readSample/samples/seek/destroy/end 判定/守卫，全用基类；改 3 组断言 + 接受 D1/D2/D4/D6 行为变化。
- 优点：代码最少、与 ts 完全同构、I1 比对面最小。
- 代价：end 提前/可重复（真实播放器多轨并行拉取时通常恰好一次，但**契约字面与 mkv 现语义更严**）；open 失败不可重试；未 open 访问不报错（掩盖编程错误）。**需跨模块契约裁决**（§7 Q1-Q4），非 mkv 单方能定。

### 案 B：基类 + 子类守卫 override（零行为回归）
继承基类复用状态机/open 框架/destroy/事件双发；`readSample/samples/seek` 用基类，但 override：
- `_maybeEmitEnd`（保留"可读轨集合 + 防重"判定）、`tracks/mediaInfo/metadata` getter（保留 #assertReady）、`samples()`（同步 assertReady 后转基类）。
- D1/D2 需额外 override `open()`（保留重入抛错与失败回 idle）——否则这两点仍变。
- 优点：行为 100% 不变、74 例应全绿。
- 代价：override 面较大（近 1/2 基类方法被覆写），"复用"打折，长期维护两套语义。

### 案 C：形式继承，核心自实现保留（最小侵入）
`extends Demuxer`，状态机切 `stateValue`（删 `_state`/自管 open/destroy/state getter/pause/resume，交基类），但 `readSample/samples/seek/samplesInternal` 与守卫、end 判定**保留自实现**（子类同名方法覆盖基类，合法）。
- 优点：拿到「继承基类 + 统一状态机 + 统一 destroy/open/事件双发」的形式对齐与大半复用；**74 例零回归**；真实语义分歧延后到 I1 裁决，不在本轮滚动中擅改。
- 代价：readSample/samples/seek 仍是自实现（与 ts 的复用深度不同），I1 全量比对时仍可能再议 D1-D11。

### 推荐
**先 C 后 A**：I1 开波首步按案 C 落地（安全、可独立验证、测试全绿），把 D1-D11 语义差异做成裁决清单交 captain/leader（§7），裁决后按案 A 收敛到与 ts 完全同构。**不建议跳过 C 直接 A**——D4（end）与 D3（守卫）涉及播放管线可观测行为，单模块擅改风险高。

---

## 7. I1 待裁决契约问题（升级清单）

1. **Q1 end 语义**：契约 §2.3「全部轨 EOS」——mkv 现语义（须拉完所有可读轨、恰一次）vs 基类/ts（已拉轨全 done 即发、可多次）。字面支持 mkv，工程惯例支持基类。**裁决方向影响 mkv 与 ts 二者**。
2. **Q2 未 open 访问守卫**：同步抛（mkv）vs 返回空值（基类/ts）。契约 §2.2 只说 open 后可用；严守卫可早期暴露编程错误，但与 ts 不一致。
3. **Q3 samples() 同步失败**：同步抛（mkv）vs 懒生成器（基类/ts）。
4. **Q4 open 失败重试**：回 idle 可 attach 重试（mkv）vs destroyed 终态（基类/ts）。直播/坏源场景哪个对？
5. **Q5 open 重入**：抛错（mkv）vs 共享 promise（基类/ts）。
6. Q6 细项：seek 非法目标码（PARSE_ERROR vs STATE_ERROR）；pause/resume 是否 emit；readSample 是否 emit 'sample'（pull 场景契约事件表未禁）。

---

## 8. I1 首轮裁决（2026-09-07）

本轮对照 `mkv`、`flac` 实码及 `core/src/demuxer.js` 基类，确认 D1-D12 不是单模块实现遗漏，而是**迁移期兼容语义分歧**。当前裁决如下：

| 差异 | 裁决 | 当前实现 | 后续约束 |
|---|---|---|---|
| D1 open 重入 | 保留已冻结行为 | mkv 抛 STATE_ERROR；flac/core 共享打开 promise | 新增 demuxer 一律采用基类共享 promise；mkv 兼容面暂不改 |
| D2 open 失败 | 保留模块既有可恢复性 | mkv 回 idle；flac/core 由基类收口 | 播放器接入前再统一失败恢复策略，禁止单模块擅改 |
| D3 getter 守卫 | 兼容层可更严 | mkv 未 open 抛；flac 使用基类默认 getter（FLAC `metadata` 为专属旧视图） | 新模块按基类默认值；旧调用方依赖的严格守卫需专门迁移波次 |
| D4 end | 以契约字面“全部轨 EOS”为目标 | mkv 全部可读轨且恰一次；core/ts 为已建迭代器轨 | 新代码禁止复制基类的提前/重复触发；基类收敛另立跨模块议题 |
| D5 未知轨/encrypted | 错误码保持 | mkv PARSE_ERROR/NOT_SUPPORTED；基类钩子负责同类校验 | 错误必须仍为十码，不得退化为裸 Error |
| D6 非法 seek | 暂保兼容 | mkv PARSE_ERROR；core/ts STATE_ERROR | 公开契约最终口径待 captain+leader 双签后统一 |
| D7 sample 事件 | pull 不依赖事件 | mkv/flac 不额外发 sample；core 会发 | 只有 `start()` 推送模式允许依赖 sample 事件；pull 消费不得以此为前提 |
| D8 media-info | 兼容期双名 | 基类双发；mkv 自实现仅发定稿名 | 新模块双发；旧模块接入前补事件兼容测试 |
| D9 destroy 监听器 | 基类行为为准 | core destroy 会 removeAllListeners；mkv/flac 兼容实现暂保留监听 | 新代码不得在销毁后继续消费事件 |
| D10 pause/resume | 点播安全空操作 | mkv 空操作；flac 继承基类事件实现 | 仅直播推送模式把 pause/resume 作为可观测事件 |
| D11 samples 未 open | 兼容层可同步失败 | mkv 同步抛；flac/core/ts 懒生成器 | 新模块按基类懒生成器；mkv 迁移不改既有同步断言 |
| D12 状态字段 | 外部只读 `state` | 两模块均接 `stateValue`，保留各自历史结束标记 | 禁止外部依赖私有状态字段；非法迁移统一用 PlayerError |

**结论**：I1 本波完成的是差异的证据化裁决与边界冻结，不把已由 74+46 例固化的 mkv/flac 行为强行改成另一套语义。F10 的“继承基类”与 D1-D12 的“完全同构”是两个不同验收层级；前者已闭环，后者保留为跨模块统一议题。

## 9. 案 C 落地步骤（供 I1 使用）

1. `class MkvDemuxer extends Demuxer`（替换 Emitter import 为 Demuxer）；`super(source)` 后继续做 `dataSource` 规范化并把 `this.source = this.dataSource`（基类 destroy/open 走 close?.()）。
2. 删自管 `_state`/`get state`/`open()`/`destroy()`/`pause()`/`resume()`/`start()`；内部 `this._state` 引用（约 10 处：#assertReady、getBufferedRanges、samplesInternal、attach、parseInit 守卫）→ `this.stateValue` 与 `DEMUXER_STATES`。
3. `#assertReady` 改基于 `stateValue`（destroyed/ready 判定 + `_requireUsable` 语义）；getter 守卫 override 保留。
4. 保留自实现 `readSample/samples/seek/samplesInternal/#iterateTrack/#maybeEmitEnd`（覆盖基类同名）。
5. `parseInit/init/attach` 保留（基类无 parseInit；attach 语义与基类不同——基类 attach 仅赋 source，mkv attach 重建规范化包装，保留自版）。
6. 验证：`mkv/__tests__` 74/74 + `hls/ts` 相关引用（若有 `instanceof` 依赖）→ 全仓低并发。

## 9. 开放风险

- mkv 内部 `this.source`（基类字段）与 `this.dataSource` 双引用需一步理顺，防止基类 destroy `source.close` 与 mkv 自管关闭路径重复 close（幂等包装已 close?.() 兜底）。
- 基类 `open()` 会额外 emit('mediaInfo') 旧名——检查 demo/site 是否有对该旧名的计数断言（测试未发现）。
- `samplesInternal` 现检查 `this._state !== 'ready'`（:840）——案 C 中 stateValue 迁移后 seek 期间（基类 SEEKING）samplesInternal 若被调用会怎样：基类 seek 已清空 `_trackIterators`，但 mkv 自实现 readSample 用自管迭代器，seek 自实现内自己清——**案 C 下基类 seek 与自版 seek 的覆盖关系需测试确认无基类 seek 泄漏路径**（外部调用走自版 seek，安全）。
