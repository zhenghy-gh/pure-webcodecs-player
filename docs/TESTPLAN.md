# 《纯前端实现播放器》测试计划（TESTPLAN）

| 项 | 内容 |
|---|---|
| 文档版本 | v1.0 |
| 作者 | qa(测试工程师) |
| 日期 | 2026-08-25 |
| 验收唯一依据 | `docs/PRD.md` **v2.0** 第 3 章三段式条款(输入→期望→异常)+ 看板《每模块验收标准摘要表》(权威)；通用异常纪律 E1~E7 全模块适用 |
| 配套依据 | `docs/CONTRACTS.md` 现行 0.x 基线(升版 v0.2 落盘中，E-8；术语与版本号引用随其落盘统一刷新)、`docs/DESIGN.md` v1.0 §12（UI 验收清单）、看板【裁决-hls-flv重定位】【裁决-品牌名 PurePlay】【裁决-qa三问-Q1Q2Q3】 |
| 适用环境 | macOS · Chrome 最新稳定版(主验) · Safari(WebRTC/字幕对照) · Node v22.23.1(`node --test`) |
| 状态 | 已发布，随实现进度滚动执行 |

| 版本 | 日期 | 变更 | 作者 |
|---|---|---|---|
| v1.0 | 2026-08-25 | 首次发布：验证模型/通用基线/门槛核对方法/16 模块用例清单/静态检查规程/冒烟脚本/缺陷闭环 | qa |
| v1.1 | 2026-08-25 | 对齐 PRD v2.0+《每模块验收标准摘要表》：门槛拆分微调(flv≥35/subtitle≥35)、E1~E7 引用、§11 三问全部结案、hls AES-128 按修订后契约执行；CONTRACTS 术语与版本号引用待 v0.2 落盘统一刷新(E-8) | qa |
| v1.1.1 | 2026-08-25 | 应 pm 确认关闭 Q1 行过期"残留事项"备注（PRD 现行 v2.2，§3.7 即 AES-128 支持完整分支，无未修订缺陷，勿再引为催办依据）；用例集 HLS-N02 细化 + 新增 HLS-C04 四分支用例；凭证=看板帖 aes128-scope-restored-per-leader-ruling | qa |

---

## 1. 目的、范围与验证模型

**目的**：把 PRD 第 3 章每条"可验收标准"落成可勾选、可复现、可留档的验收动作，支撑 M2~M5 各里程碑出口判定与最终《验收报告》。

**范围**：16 个验收单元（14 功能模块 + rtmp/rtsp 两个桥接形态）+ 配套目录（site/samples/docs）的间接影响项。本期不做项（真实公网流、DRM、转码、产品级 UI，见 PRD §2.2）不在验收范围，但"诚实标注不做"本身是验收项。

**三层验证模型**：

| 层 | 手段 | 自动化程度 | 对应 PRD 条款 |
|---|---|---|---|
| L1 解析层单测 | `node --test <mod>/__tests__/`，fixture 由 `samples/` 程序化生成 | 全自动 | 各模块"单测 ≥ N 例，必须覆盖…" |
| L2 demo 实机步骤 | 静态服务 + 浏览器打开，按本文 §6.B 步骤逐条操作并截图留档 | 手动步骤化 | 各模块"demo: …" |
| L3 静态与资源检查 | curl/node 探测页面可达性、资源引用完整性、第三方请求红线 | 半自动（§7） | 五件套③、DESIGN §12 |

**底线原则**（贯穿全部模块）：解析层永远可用是底线体验——渲染能力缺失时必须给出明确缺失清单且解析层信息展示不受影响；任何模块不得假装能播。

---

## 2. 环境与工具基线

- macOS + Node v22.23.1（`node --version` 核对）；浏览器 Chrome 最新稳定版为主验浏览器，Safari 用于 webrtc 回环与字幕渲染对照。
- 静态服务：仓库自带零依赖服务器 `node serve.mjs [port]`（即 `npm run demo`，默认 8080，支持中文路径/Range/CORS 头），禁止引入第三方静态服务器。
- 全仓单测一键：`npm test`（等价 `node --test "**/__tests__/*.test.js"`）；分模块见 §5.2。
- fixture 再生成：`npm run fixtures`（samples/generate-all.mjs，固定种子确定性输出）。
- 截图与日志留档目录：`docs/qa-evidence/<module>/`（不入库大文件，仅截图与文本证据）。

---

## 3. 通过判据、缺陷分级与闭环

### 3.1 单模块"通过"定义（五条件同时成立）

1. 五件套通用基线（§4 清单）逐项通过；
2. 单测实数 ≥ PRD 门槛且 `fail = 0`（skip 仅允许 §附录A 场景且已登记原因）；
3. §6 该模块 B 组 demo 步骤全部符合预期；
4. §6 该模块 C 组边界异常场景无崩溃、无未捕获异常、错误路径有明确中文文案与正确 MediaError code；
5. 该模块遗留缺陷无 P0/P1 未闭环项。

### 3.2 缺陷分级

| 级别 | 定义 | 处理要求 |
|---|---|---|
| P0 | 崩溃/死循环/数据损坏/门禁性失败（单测 fail>0、demo 打不开、未捕获异常） | 阻断里程碑出口，立即修复 |
| P1 | 违反 PRD 明文验收标准（功能缺失、数值错误、门槛不足） | 里程碑出口前修复 |
| P2 | 契约/规范偏离但不违反 PRD 明文（命名、日志级别、注释覆盖） | 下一里程碑内修复或经 captain 批准挂账 |
| P3 | 建议项 | 记录即可 |

### 3.3 登记、指派与闭环流程

1. qa 在共享任务列表登记：标题 `[BUG][P0-P3][模块] 一句话现象`，正文固定字段：**PRD 条款引用 / 复现步骤 / 期望 / 实际 / 环境(浏览器+OS) / 证据(docs/qa-evidence/ 路径)**。
2. @对应负责工程师修复；修复后 qa 按 §3.1 相关条目回归，附回归结论后关闭。
3. 状态同步：每次看板 `qa-report` 更新附带《缺陷台账》（编号/级别/负责人/状态）；P0 超 24h 或同一问题催办 2 次无响应 → 上报 captain（captain 无响应则报 leader，与协作约定一致）。
4. **预期行为不是缺陷**（避免噪音，详见附录 A）：CORS 失败解释文案、rtmp/rtsp 直连拒绝教育文案、ProRes 黄标"识别未解码"、ape 范围外规格提示、webtorrent 真实 swarm 按钮灰显等。

---

## 4. 通用五件套基线核查清单（每模块打勾，qa 验收表模板）

以下 15 条适用于**每一个**模块，验收报告中以表格逐格 ✔/✘/N/A 记录：

| # | 核查项 | 通过标准 |
|---|---|---|
| B01 | README 六要素 | 格式/协议原理、可行性结论、ASCII 架构图、快速开始、API 说明、已知限制与路线，六者齐全且中文 |
| B02 | README 诚实性 | 已知限制具体（写了什么不支持、为什么）；无夸大宣传 |
| B03 | 入口与导出 | 仅 `src/index.js` 唯一入口，具名导出，无 default export |
| B04 | 纯 ESM 零构建 | `.js` ESM 语法；`<script type="module">` 直开可用；无 TS/JSX/require |
| B05 | 零第三方运行时依赖 | src/ 相对导入；仅可依赖第一方 core；无 bare specifier/npm 包 |
| B06 | 中文注释 | 导出符号与关键算法段均有中文 JSDoc/注释 |
| B07 | 双环境安全 | 浏览器专属全局访问前做存在性判断；Node 下返回不支持、不抛异常 |
| B08 | 时间单位契约 | 对外时间戳/时长均为整数微秒（µs）（CONTRACTS §0.5） |
| B09 | codec 字符串契约 | 经 `core/src/codec-string.js` 生成，可直接过 isConfigSupported；demuxer 未自行拼串 |
| B10 | 错误契约 | 使用封闭枚举 MediaError 九码之一；异步 reject 同时 emit `'error'`；禁 alert/console 面向用户 |
| B11 | 日志契约 | createLogger 模块前缀；默认 warn；不打二进制本体（≤16B hex）；文案中文 |
| B12 | demo 可静态打开 | 任意静态服务器可开；拖入文件和/或输地址入口存在；复用 site/ 皮肤 |
| B13 | demo 信息时延 | 拖入本地文件后 3 秒内展示轨道信息（编码/分辨率或采样率/时长/轨道列表） |
| B14 | __tests__ 可直跑 | `node --test <mod>/__tests__/` 直接运行；fixture 来自 samples 固定种子；单文件 ≤256KB、离线 |
| B15 | DESIGN §12 抽查 | 错误路径走 stage 错误面板且错误码 `E_<域>_<名>`；Network 无第三方请求（CDN 对照示例除外，见 §7.4） |

> B01~B11 主要由 reviewer 按契约评审，qa 复核抽查；B12~B15 由 qa 主责。

---

## 5. 单测最低门槛核对方法

### 5.1 计数口径

- 以 `node --test` 输出统计为准：每个 `test()` / `it()` / 顶层子测试计 **1 例**；`describe`/容器不计；`subtest` 各自计 1。
- `pass + fail + skipped (+cancelled) = tests 总数`；**fail 必须 = 0**；skip 必须能说出原因（TAP 注释或 PR 说明）。
- 判定式：`达标 ⇔ tests ≥ PRD门槛 ∧ fail == 0 ∧ 非法skip == 0`。
- 用例数是**最低门槛而非目标值**（PRD §2.3）；覆盖点缺项时即使数量达标也判不通过（§6.A 清单逐项核对）。

### 5.2 汇总命令（macOS + node22 实测口径）

```bash
# 全仓一键（sdet 提供，glob 写法正确）
npm test

# ⚠️ E-6 实测勘误(2026-08-25 qa 复核)：本机 node v22.23.1 下【目录形式】"node --test <mod>/__tests__/"
# 会把目录当模块加载，仅产生 tests 1 / fail 1 —— 一个用例都没跑。必须使用【显式 glob】形式：
for m in core mp4 mov flv ts wav hls mkv flac subtitle cmaf ape webtorrent webrtc rtmp rtsp; do
  [ -d "$m/__tests__" ] || continue
  echo "== $m =="
  node --test --test-reporter=tap "$m"/__tests__/*.test.js 2>&1 \
    | grep -E '^# (tests|suites|pass|fail|cancelled|skipped)'
done
# 关口判定以实际用例数为准：输出 tests 0 或仅 fail 1 视为基建故障，登记缺陷 @sdet。
```

### 5.3 门槛总表（对齐 PRD v2.0 +《每模块验收标准摘要表》，验收以此表为准）

> 2026-08-25 对齐说明：PRD v2.0 分模块拆分微调——flv ≥30→**≥35**、subtitle ≥40→**≥35**(SRT/VTT 为硬门槛，ASS 尽力项不计门槛但已实现项必须有断言)，总数不变仍 **565 例**。

| 模块 | PRD 条款 | 最低例数 | PRD 点名的必须覆盖项（摘要） |
|---|---|---|---|
| core | §3.1 | ≥40 | ByteReader/BitReader 边界(越界/跨字节位域/exp-Golomb 异常)、模型序列化往返、Node(mock navigator)能力探测分支、DemuxerBase 假 demuxer 事件顺序 |
| mp4 | §3.2 | ≥40 | box 树含未知 box 跳过、sample table 交叉一致性、fragment 流式顺序、extradata 提取 |
| mov | §3.3 | ≥30 | moov 后置、elst pts 修正、QT 音频 fourcc 映射、未知/私有 box 容错 |
| flv | §3.4 | ≥35 | tag 流任意切块喂入输出不变+PreviousTagSize 校验、sequence header/ASC 提取、onMetaData 黄金断言、截断半 tag 缓冲等待/end 后计丢弃、FlvRemuxer init segment 可被 mp4 probe 交叉识别 |
| ts | §3.5 | ≥45 | resync 恢复正确位置、PAT/PMT 多节目、PES 跨包重组、PTS 回绕、ADTS 合法性 |
| wav | §3.6 | ≥25 | 四种位深逐样本比对、EXTENSIBLE、chunk 乱序/未知容错、cue/INFO 提取 |
| hls | §3.7 | ≥50 | master/media 标签组合、直播窗口滑动收敛、BYTERANGE 偏移、AES-128(node crypto 同构)、DISCONTINUITY 序号、畸形 playlist 容错 |
| mkv | §3.8 | ≥60 | EBML vint 全边界、三种 lacing 各≥2、Cues seek 命中、SimpleBlock 负时间码、畸形元素不崩、CodecID 映射全覆盖 |
| flac | §3.9 | ≥35 | 编码器往返逐字节一致、CRC-8/-16 篡改必报错、STREAMINFO 边界值 |
| subtitle | §3.10 | ≥35(SRT/VTT 硬) | 三格式黄金用例含 skippedLines、时间码三种格式互转、\pos/\an 数值断言、白名单外进 unsupportedTags、x-srt/x-ass 嗅探置信度 |
| cmaf | §3.11 | ≥25 | chunk 序序与边界、timecode 连续性、违规 fixture 准确报错、switching set 比对 |
| ape | §3.12 | ≥20 | HEADER 字段边界、版本分支、APE Tags UTF-8、Seek Table 偏移（全部针对解析层=硬门禁） |
| webtorrent | §3.13 | ≥40 | bencode 往返、畸形拒绝、magnet 参数、策略确定性序列(固定种子)、offset→piece 边界、assembler 断点续组 |
| webrtc | §3.14 | ≥25 | 信令编解码往返、SDP mangle 前后断言、URL 约定解析、ICE 状态机迁移表 |
| rtmp | §3.15 | ≥20 | WS 帧编解码往返、粘包/分包重组、重连退避(定时器 mock)、错误码→文案映射 |
| rtsp | §3.16 | ≥40 | interleaved/ASCII 交错、SDP 全字段、RTP 乱序重排、FU-A golden 三形态、AnnexB↔AVCC、SR 时间映射 |
| **合计** | | **565** | |

> ⚠️ 口径说明①：上表合计 565 例；pm 看板摘要写"约 545"，**以 PRD 正文逐条合计 565 为准**，已提请 pm 勘误（见 §11）。
> ⚠️ 口径说明②：【裁决-hls-flv重定位】只调整 hls/flv 的**产品定位与 README/demo 口径**，未降低两者单测门槛（hls≥50、flv≥30 维持），验收仍按本表执行。
> ⚠️ 口径说明③：mkv 允许"webm 子集→全量 matroska"两步走，qa 分两次验收：第一步出口核 webm 子集可播 + 已交付部分用例全绿；第二步补足 ≥60 与全清单。
> ⚠️ 口径说明④：ape 解码层为软门禁——`gen-ape-fixture.js` 检测到 ffmpeg 生成 fixture 则往返误差 0 用例必须真跑；检测不到时解码层用例自动 skip 且 CI 显示原因，**解析层 20 例不享受该豁免**。

### 5.4 登记格式（看板 key=qa-report）

```
【qa-report】<日期> · node v22.x · npm test 快照
| 模块 | tests | pass | fail | skipped | 门槛 | 达标 | 缺陷 |
16 行 + 合计行；fail>0 或缺口径即标红并链 team_task 缺陷号。
里程碑出口时追加一句结论（如"M2 出口单测门禁：通过/不通过+原因"）。
```

---

## 6. 分模块验收用例清单

> 结构约定：每组模块三块——**A 解析层单测覆盖点**（验收时逐项勾选）、**B demo 手动验证步骤**（编号操作→预期）、**C 边界与异常场景**。A/B/C 全绿 + §4 基线全绿 = 该模块验收通过。

### 6.1 core（§3.1，≥40）

**A 单测覆盖点**
- □ ByteReader/BitReader：大小端读写往返；越界读抛错或返回约定哨兵（二选一且有断言）；跨字节位域拼接正确；exp-Golomb 正常码字解码 + 异常输入（全 0/超长前缀）不静默错解
- □ 数据模型：Sample/Track/MediaInfo 构造→序列化→还原往返一致（仅字符串叶子字段）
- □ 能力探测：Node 环境（无 navigator/mock 部分 API）下 hasWebCodecs/hasMSE/hasAudioWorklet/hasWebGPU 恒 false 且**不抛异常**；detectCapabilities 各分支吞错计 false；同参数第二次调用走缓存
- □ chooseRoute：tracks 全支持→webcodecs；可 remux 且 MSE 通过→mse；否则 none
- □ DemuxerBase：内存假 demuxer 验证事件顺序 media-info→sample…→end；'error' 后进入 error 态；非法状态迁移抛 INVALID_STATE；未 parseInit 先 samples() 抛 INVALID_STATE
- □ 迷你 Emitter：on/off/once/emit；监听器抛错被隔离不影响管线；'error' 事件双通道并存
- □ Source：MemorySource/FileSource(Node 下优雅降级)/HttpRangeSource 并发 Range 合并与最小分片(256KiB 可配)/ChunkBuffer 聚合随机读
- □ codec-string：SPS→avc1.PPCCLL、ASC→mp4a.40.x、fallbackCodecString 降级打 warn 不编造 profile
- □ MediaError 九码封闭枚举；logger setLogLevel 分级与 ≤16 字节 hex 截断
- □ 时间戳工具：时基换算就近取整、单调性检查

**B demo 手动步骤**
1. 打开 `/core/demo/` → 页面渲染 L0~L3 能力矩阵徽标（绿/红）。
2. 对照 DevTools：徽标与 navigator.mediaCapabilities/MediaSource/VideoDecoder/AudioWorklet/navigator.gpu 实际存在性逐一人工核对一致。
3. Chrome 与 Safari 各开一次，截图存 `docs/qa-evidence/core/`。

**C 边界与异常**
- □ Node 下 import core 全部入口不抛异常（CI 即证）；探测失败路径全部计 false
- □ 假 demuxer 中途 emit error：迭代器 throw 与 'error' 事件两条通道都能被消费方捕获

### 6.2 mp4（§3.2，≥40）

**A 单测覆盖点**
- □ box 树：ftyp/moov(mvhd/trak/tkhd/mdia/minf/stbl/stsd)/mdat/mvex 全解析；未知 box 安全跳过（size+type 前进）；box 树输出结构与手工构造 fixture 一致
- □ sample table：stts/stsc/stsz/stco/co64/stss/stsd 交叉校验（样例数守恒、chunk↔sample 映射、co64 高位）；stss 关键帧标记
- □ fragment：moof/mfro/tfra 序列流式喂入，sample 输出顺序=解码序，track 片段边界正确
- □ extradata：avcC/hvcC/AudioSpecificConfig 原样提取（字节级断言）；description 透传不二次包装
- □ probe：ftyp 命中 confidence≥0.8；非 mp4 输入返回 null 不抛
- □ remux 到 fMP4 init+media segment 可被 MSE 接受（结构断言）
- □ HTTP Range 惰性读取 moov（HttpRangeSource mock，断言只读了必要区间）

**B demo 手动步骤**
1. 拖入本地 `.mp4/.m4v/.m4a` → 3 秒内出 ftyp major brand + 轨道表(id/类型/fourcc/分辨率/采样率/时长/帧数) + box 结构树。
2. 点"播放"：MSE 可用走 MSE 播放；否则 WebCodecs Canvas 渲染前 10 秒；都不支持则列出缺失能力且轨道信息仍在（底线体验）。
3. 加载 samples 生成的"moov 在 mdat 之后"fixture → 仍出全量信息。
4. 截图留档：轨道表面板 + box 树折叠展开。

**C 边界与异常**
- □ 损坏文件（截断/伪 box size 超界）→ PARSE_ERROR + 中文文案，页面不白屏
- □ 加密内容(sinf/cenc) → 识别并提示 DRM 不支持（NOT_SUPPORTED），不假装能播
- □ 零轨道/空 mdat → 明确错误而非空面板

### 6.3 mov（§3.3，≥30）

**A 单测覆盖点**
- □ moov 后置（mdat 先行）解析成功，信息与前置版本一致
- □ elst 编辑列表 pts 修正：修正前后 pts 数值断言（媒体时间≠显示时间的构造用例）
- □ QT 音频 fourcc 映射：lpcm/twos/sowt/'raw '/apcn/apch 全命中映射表
- □ wide/skip/udta/meta 未知/私有 box 容错跳过；udta 元数据提取
- □ ProRes 识别：codec 标记 + bitstreamFormat/description 如实输出（不解码）
- □ probe：mov 与 mp4 区分（major brand qt）

**B demo 手动步骤**
1. 拖入 `.mov` → 信息面板出现"编辑列表修正前后 pts 对比"折叠区，展开数值合理。
2. 含 udta 元数据的 fixture → 元数据显示。
3. ProRes fixture → 黄色"识别未解码"徽标而非报错弹窗（预期行为）。
4. 可解码 mov → MSE/WebCodecs 播放正常。

**C 边界与异常**
- □ mdat 巨大且 moov 在尾：Range 回读路径生效（内存不爆，观察 loadedBytes 进度事件）
- □ QuickTime VR/全景轨 → 识别跳过并列入已知限制提示

### 6.4 flv（§3.4，≥30｜裁决后定位：FLV 解析地基 + 薄播放壳，rtmp 桥接的消费底座）

**A 单测覆盖点**
- □ header/PreviousTagSize/Tag(Audio/Video/Script) 流式重组；PreviousTagSize 校验失配报 PARSE_ERROR
- □ AVC sequence header→avcC extradata；AAC ASC 提取（字节级断言）
- □ ScriptTag onMetaData AMF0 键值解析（嵌套对象/数组）
- □ 截断流：半个 tag 中断不崩溃；续喂剩余字节后恢复解析（可续传）
- □ Tag 时间戳 ms→整数 µs 换算；扩展时间戳处理
- □ AVCVIDEOPACKET 按 AVCC 形态输出（bitstreamFormat='avc'+description）
- □ H.265-in-FLV CodecID=12 / Enhanced-FLV FourCC → 识别并提示（PRD 口径：识别提示即可，超出不扣分）
- □ WS 工厂注入接口：可替换 WebSocket 实现（供 rtmp 复用的契约面）

**B demo 手动步骤**
1. 拖入 `.flv` → 时长/宽高/音视频编码/关键帧数 3 秒内展示。
2. MSE 播放正常，seek 到关键帧不花屏。
3. ws-flv 地址框输入无效地址 → 提示"需要 WebSocket-FLV 网关，详见 rtmp 桥接形态"（预期行为非缺陷）。
4. README 复核：声明生产场景建议 flv.js（裁决口径）+ 作为 rtmp 依赖的说明。

**C 边界与异常**
- □ 纯音频 FLV / 纯视频 FLV 均可解析；空 ScriptTag 不致命
- □ 时间戳回退（直播转推常见）→ warn 日志 + 钳制，不崩

### 6.5 ts（§3.5，≥45）

**A 单测覆盖点**
- □ 188 包同步：正常连续解析；破坏若干字节后 resync 从下一个合法 0x47 恢复**正确位置**（不丢后续节目数据）
- □ PAT/PMT：多节目枚举；program_number↔PID 映射；PMT stream_type→codec 映射；PAT/PMT 动态更新（中途变更后轨道刷新）
- □ PES：跨 TS 包重组（payload 单元拆多包）；PTS/DTS 提取（2^33 回绕用例：前后 PTS 差值正确）；PCR 读取与时基统计
- □ Annex-B 起始码处理（3/4 字节起始码）；ADTS→ASC 转换与 ADTS 头合法性校验（syncword/长度字段）
- □ H265 stream_type 路径基础解析
- □ probe：0x47 + PID 连续性校验防误报

**B demo 手动步骤**
1. 拖入 `.ts` → program/PMT 树 + 轨道列表 + PCR 抖动简单统计 3 秒内展示。
2. 多节目 fixture → 切换 program 后只播所选节目轨。
3. 开"注入垃圾字节"开关 → resync 后继续正常解析，画面/轨道信息不乱（PRD 点名演示项）。
4. 播放：MSE 或 WebCodecs 至少一路可用。

**C 边界与异常**
- □ CA 加密节目 → 识别 stream_type 并提示不支持（不做解密）
- □ 连续性计数器 discontinuity → warn 并继续，不产生重复/丢包静默错解
- □ 非 188 对齐输入（188+垃圾混合）→ resync 生效

### 6.6 wav（§3.6，≥25）

**A 单测覆盖点**
- □ 四种位深 8/16/24/32f 采样值换算与 samples 参考 PCM **逐样本比对**
- □ WAVE_FORMAT_EXTENSIBLE（SubFormat GUID）解析；channelMask
- □ chunk 遍历容错：乱序 chunk、未知 chunk 跳过、odd-size chunk 补齐字节
- □ LIST/INFO 元数据、cue point、PEAK 提取
- □ probe：RIFF…WAVE 命中；pcm-* codec 串经 codec-string 生成
- □ 位深/采样率/声道自适应参数正确传入 AudioWorklet 配置

**B demo 手动步骤**
1. 拖入 `.wav` → fmt 详情（位深/采样率/声道/块对齐）+ Canvas 波形图。
2. 播放/暂停/点击波形 seek 均正常；波形进度联动。
3. samples 生成的四种位深 fixture 逐个拖入均可播。
4. 24bit 与 32f 混合 fixture 播放**无爆音**（人工试听，qa 在 `docs/qa-evidence/wav/` 记录结论）。

**C 边界与异常**
- □ ADPCM 等非 PCM wav → 明确已知限制提示（NOT_SUPPORTED），不噪声输出
- □ data chunk 截断 → 按实际样本数截断播完，不越界读

### 6.7 hls（§3.7，≥50｜裁决后定位：HLS 数据源适配层，m3u8 解析+分片加载+喂统一内核，重点 WebCodecs 直解差异化）

**A 单测覆盖点**
- □ Master playlist：BANDWIDTH/RESOLUTION/CODECS 全解析；variant 树正确
- □ Media playlist：EXTINF 时长累计、EXT-X-MAP（init segment）、BYTERANGE 偏移计算（含隐式接续偏移）、ENDLIST 判 VOD、DISCONTINUITY 序列号处理
- □ LL-HLS：PART/PRELOAD-HINT 结构感知（解析级，阻塞式传送归 cmaf）
- □ AES-128：KEY 属性解析 + node crypto 同构路径解密往返（密钥获取接口可注入）
- □ 直播窗口滑动模拟：时间推进后窗口收敛、刷新节奏符合 slide 语义、live=true 且 durationUs=null
- □ 分片调度器：顺序下载、失败重试次数上限、buffer 水位触发（fetch 注入 mock 断言请求序列）
- □ 畸形 playlist 容错：缺 EXTINF、非法标签、空行 CRLF 混排 → 跳过计数不崩溃
- □ TS/fMP4 分片混排分别路由到对应子 demuxer

**B demo 手动步骤**
1. 输入外部 URL（CORS 受限源）→ 显示明确的跨域受限解释文案（预期行为）。
2. 粘贴 m3u8 文本 → 解析出 master→variant 树与分片列表。
3. 一键加载内置静态 VOD（samples 生成）→ 完整可播。
4. **四步冒烟**：播放→暂停→seek→续播（qa 截图留档，PRD 点名附加项）。
5. README 复核：声明生产场景建议 hls.js（裁决口径）；WebCodecs 直解路线的可用性说明清晰。

**C 边界与异常**
- □ 加密分片按已结案口径执行：AES-128（WebCrypto AES-CBC 整段解密）属本期硬验收、仅限 hls 模块（captain【裁决-qa三问】+CONTRACTS v1.0.1 变更记录）；SAMPLE-AES/FairPlay/Widevine 维持 NOT_SUPPORTED 明确提示
- □ SAMPLE-AES/FairPlay/Widevine → NOT_SUPPORTED 明确提示
- □ live playlist 无 ENDLIST → 不显示时长、seek 按窗口限制（SEEK_UNSUPPORTED 语义）

### 6.8 mkv（§3.8，≥60｜最高工作量，两步走分两次验收）

**A 单测覆盖点**
- □ EBML vint 全边界（1~8 字节长度前缀、保留值、unknown size）；DocType matroska/webm 区分
- □ 无限长元素流式解析（UnknownSize Segment/Cluster）不失控
- □ Info：Duration×TimecodeScale 换算；Tracks 全字段
- □ Cluster/SimpleBlock/BlockGroup：相对时间码（含**负值**）、绝对时间码换算 µs
- □ 三种 Lacing：Xiph/fixed-lace/EBML lacing 各至少 2 个用例解帧正确
- □ SeekHead/Cues：seek(t) 命中 ≤t 最近关键帧所在 Cluster（索引命中断言）；Cues 缺失时线性扫描建索引兜底
- □ CodecID 映射全覆盖：V_MPEG4/ISO/AVC(avcc extradata in-band 重建)、V_VP9、V_AV1、A_OPUS、A_VORBIS、A_AAC、V_MPEGH/ISO/HEVC(如有)；映射失败显式标红路径
- □ ContentEncoding：zlib 头识别→提示不支持；加密 MKV→识别提示
- □ 畸形元素：截断/超长 size/未知 element ID 不崩溃（PARSE_ERROR 或跳过计数）

**B demo 手动步骤（第一次验收=webm 子集出口）**
1. 拖入 `.mkv/.webm` → DocType/Duration/TimecodeScale/Track 表（CodecID 及映射到的 WebCodecs codec string；映射失败显式标红）/Cluster 计数 3 秒内展示。
2. WebCodecs 可用 → 首帧画面渲染到 Canvas（截图）。
3. 有 Cues 的文件 → seek 至 50% 再渲染一帧（两张截图比对内容不同）。
4. 第二次验收补：ASS 内挂字幕轨识别（渲染交给 subtitle）、章节列表解析展示。

**C 边界与异常**
- □ 大文件 Cues 在尾部 → Range/惰性读取路径生效
- □ 附件字体/封面 → 解析不崩，字体加载列路线图提示
- □ DV/杜比视界轨 → 识别并如实提示不支持

### 6.9 flac（§3.9，≥35）

**A 单测覆盖点（核心方法论：自产最小编码器往返法）**
- □ 往返法：最小 FLAC 编码器生成的正弦/噪声 fixture（多参数组合：blocksize/采样率/声道分配/位深），解码输出与编码器输入 PCM **逐字节一致**
- □ 帧头同步码 0xFFF8 域 + CRC-8 校验；篡改任一比特**必报错**
- □ 帧尾 CRC-16：篡改检出
- □ 子帧全类型：constant/verbatim/fixed(各阶)/LPC(≤32 阶)、Rice 分区参数边界
- □ 声道分配：left/side/right/mid 等联合声道还原正确
- □ STREAMINFO 字段边界值（min/max blocksize/frame、totalSamples、MD5 存在与否）
- □ METADATA：SEEKTABLE/VORBIS_COMMENT/PADDING 解析、CUESHEET 识别跳过
- □ MD5 不匹配 → 直接报错（无损承诺，不容错播放）
- □ SEEKTABLE 快速 seek 落点正确

**B demo 手动步骤**
1. 拖入 `.flac` → STREAMINFO（采样率/位深/总样本/MD5）+ SEEKTABLE 条目数 + VORBIS_COMMENT 标签。
2. 播放/暂停/seek 正常（AudioWorklet 路径）。
3. 面板显示解码耗时与"MD5 校验通过"徽标。
4. **真实世界 FLAC 回归**（用户提供文件、不入库）：人工回归一次并记录于 `docs/qa-evidence/flac/`（PRD 点名附加项）。

**C 边界与异常**
- □ OggFLAC → 明确已知限制提示
- □ >192kHz/32bit 高清规格 → 能过则过、不过如实标注（实测记录）
- □ CRC 损坏文件 → PARSE_ERROR 中文提示，不出杂音

### 6.10 subtitle（§3.10，≥40）

**A 单测覆盖点**
- □ SRT/WebVTT/ASS/SSA 全量解析：BOM、CRLF、畸形行跳过**并计数**
- □ 时间码：`0:00:00.00`(SRT/VTT) 与 `h:mm:ss.cc`(ASS) 双格式及越界值
- □ 白名单字符样式：`\b \i \u \s \fn \fs \fs+ \fsp \c \1c \2c \3c \alpha` 逐类布局求解数值断言
- □ 定位变换：`\pos` 坐标换算、`\an` 九宫锚点换算（9 个锚点全枚举）、`\move` 插值端点、`\org`、`\fad`、`\fscx/\fscy/\frz`、`\clip` 矩形
- □ Style 全局样式继承与 Dialogue 内联覆盖优先级；多层 Layer 叠加顺序
- □ 白名单外标签（\t 动画/\p 绘图/\k 卡拉OK 等）→ 进入"未支持清单"且不崩溃
- □ attach(videoOrClock) 时间驱动：给定 t 输出当前应显行集合

**B demo 手动步骤**
1. 加载本地 `.ass/.srt/.vtt` 或内置样例 → 时间轴滑杆拖动，Canvas 覆盖层实时渲染对应行。
2. `\pos`/`\an` 样例目测位置正确（对照 ASS 坐标系 PlayRes）。
3. 面板列出该文件的"未支持标签清单"且计数与解析一致。
4. **JS 引擎 vs libass-wasm 截图对照**（浏览器可加载时）：差异点记入 README 已知限制，截图留档（PRD 点名附加项）。
5. Safari 复测一次渲染（字体栈差异记录）。

**C 边界与异常**
- □ 空 Dialogue/重叠时间轴/负时长 → 不崩，按规则合并或跳过
- □ 超长行/极端 \fs → 画布裁剪不溢出不卡死

### 6.11 cmaf（§3.11，≥25）

**A 单测覆盖点**
- □ chunk 序列解析：单 moof 每 chunk、trun 数据对齐、顺序与边界断言
- □ timecode 连续性：movie-fragment 间 sequence/timecode 连续断言；故意断号报错
- □ 约束校验器：CMAF track 文件检测（ftyp+styp/sidx）；故意违规 fixture（chunk 内多 moof）准确报错
- □ switching set：可判定字段提取与比对报告内容正确
- □ onChunk 低延迟回调：首 fragment 到达即回调（未收尾吐 sample 路径）
- □ sidx 分片级索引解析
- □ 复用 mp4 box 解析经 core 抽象（无复制粘贴的第二份 ISO-BMFF 解析器——reviewer 协同确认）

**B demo 手动步骤**
1. 加载 samples 生成的 chunk 化 CMAF track 序列 → chunk 边界时间线 + 约束检查 pass/fail 列表。
2. "低延迟模式"演示：逐 chunk 回调解码首帧耗时 vs 整分片模式的对比数字展示。

**C 边界与异常**
- □ 加密 CMAF(CENC) → 识别提示不做
- □ 非法 styp/缺 sidx → 降级线性解析并提示

### 6.12 ape（§3.12，≥20 解析层硬门禁｜解码层软门禁）

**A 单测覆盖点（全部针对解析层）**
- □ HEADER 宏全字段：版本/压缩级别/块数/每块样本数/最终帧样本数/声道/采样率/每样本位数，各字段边界值
- □ 版本号分支：≥3980 支持、<3980 明确"暂不支持"路径
- □ APE Tags v2：UTF-8 键值解析（含 footer/header 两种位置）
- □ Seek Table：偏移换算正确（帧数↔字节偏移）
- □ cue 关联信息解析；probe：APE 标头/MAC magic 命中

**解码层软门禁（单独记账，允许 skip 但必须有因）**
- □ gen-ape-fixture.js：本机有 ffmpeg → 生成 <200KB fixture，至少一组**往返解码误差为 0**（无损）
- □ 无 ffmpeg → 解码用例自动 skip 且显示原因（验收报告记录 skip 数与原因）

**B demo 手动步骤**
1. 拖入 `.ape` → HEADER 全字段 + 标签 + 时长展示。
2. 受支持规格（≥3980/Normal/≤48kHz/16~24bit/立体声）→ 播放/seek。
3. 范围外文件 → 显示明确支持范围提示文案（引用 README 矩阵）。
4. README 复核：完整"支持版本/级别/规格矩阵"存在。

**C 边界与异常**
- □ R3 应急预案触发（解码层顺延下期）→ 验收报告如实记录决策并注明 captain 批准（届时解析层仍硬验收）
- □ 损坏帧 → 解析层信息不受影响；解码层报错不崩页面

### 6.13 webtorrent（§3.13，≥40）

**A 单测覆盖点**
- □ bencode 编解码往返：嵌套 dict/list/int/string；字典键排序；畸形输入拒绝
- □ metainfo：single/multi-file 解析（name/files/piece length/pieces）
- □ magnet URI：xt/dn/tr/xl 等参数解析；info-hash v1 SHA-1 计算；v2 结构感知 + 混合种子提示
- □ piece 选择策略：固定种子下确定性决策序列断言（头 piece > 顺序 > 稀有度微调）
- □ offset→piece 映射：文件跨越 piece 边界的起止 piece 计算边界用例
- □ streaming assembler：乱序到达 piece 重组成连续字节流；断点续组（中断后从已有集合恢复）
- □ Transport 注入：mock transport 回放驱动全流程（不触网）

**B demo 手动步骤**
1. 粘贴 magnet 或拖入 `.torrent` → 离线解析出 name/files/piece 长度/info-hash 文件树。
2. 点"模拟下载"→ mock transport 按 piece 策略回放，热力图随推进点亮，完成后 demux 出轨道信息。
3. "连接真实 swarm"按钮默认灰显并注明环境要求（可选增强开启后才可用）——灰显本身是验收项。
4. **info-hash 外部比对**：与 transmission-show 类工具比对一次，记录留档（PRD 点名附加项）。

**C 边界与异常**
- □ 私有种子(DHT 禁用)/无 tracker → 解析照常，连接层如实提示
- □ 损坏 pieces 哈希 → piece 校验失败标记重取（mock 场景）

### 6.14 webrtc（§3.14，≥25）

**A 单测覆盖点**
- □ 信令消息 offer/answer/candidate 编解码往返
- □ SDP fixture mangle：编解码偏好排序（H264 优先 H265 视能力）、direction 收发修改，前后断言
- □ webrtc:// URL 约定解析（SRS 风格参数）→ {signaling, app, stream} 映射
- □ ICE/连接状态机迁移表：new→checking→connected/failed/disconnected→reconnect 路径全覆盖
- □ 断线重连：指数退避参数与最大次数
- □ getStats 轮询数据结构化输出（RTT/丢包/码率/fps 字段存在性）

**B demo 手动步骤（本地回环模式=本期硬验收，无需外部服务）**
1. 打开 demo → canvas.captureStream→pc1→loopback ICE→pc2→`<video>` 全链路真实播放。
2. 信令日志实时滚动、统计面板数字跳动（RTT/码率/fps）。
3. 自定义信令地址框留空=回环模式。
4. **Chrome 与 Safari 各跑一次**，统计面板截图留档（PRD 点名附加项）。

**C 边界与异常**
- □ ICE 连接失败 → 状态机进 failed 并给排查提示（STUN 说明）
- □ 信令 WebSocket 断开 → 重连退避可见

### 6.15 rtmp（§3.15，≥20｜桥接形态，非直连）

**A 单测覆盖点**
- □ WS 二进制帧编解码往返（流标识/时间戳/FLV payload 字段）
- □ 粘包/分包重组：一帧拆多次 message、多帧粘一个 message 均正确还原
- □ 重连退避状态机：定时器 mock 下指数退避序列断言、最大次数封顶、心跳保活
- □ 错误码→用户中文文案映射表全覆盖
- □ rtmp:// 直连输入的拒绝逻辑（纯客户端判断路径）

**B demo 手动步骤**
1. 输入 `rtmp://...` 直连地址 → **拒绝并展示解释文案**（为何不可能+推荐拓扑+延迟量级表，教育行为属预期）。
2. `node samples/gateway/mock-flv-ws.js` 启动 mock 网关 → 输入 ws 地址 → canned FLV 流完整播放。
3. 杀掉 mock 网关 → 客户端显示重连状态并按退避节奏重试；网关复活后自动恢复。
4. README 复核：直连不可能的原因、最佳拓扑、延迟量级表齐全；网关契约文档 rtmp 章节 architect 署名上板。

**C 边界与异常**
- □ 网关返回错误码 → 对应文案而非裸异常
- □ 半途 FLV 字节流 → 复用 flv 截断容错能力不断流

### 6.16 rtsp（§3.16，≥40｜桥接形态，非直连）

**A 单测覆盖点**
- □ interleaved 帧（$ + channel + length）与 ASCII 请求/响应交错解析互不污染
- □ ASCII 状态机 OPTIONS/DESCRIBE/SETUP/PLAY 语义建模（发送端由网关代理的报文构造）
- □ SDP 全字段：track/mid/rtpmap/fmtp/sprop-parameter-sets（sps/pps 提取字节级断言）
- □ RTP：序号乱序重排（乱序注入后输出**严格递增**）；时钟/序列号回绕；payload 类型路由
- □ H264 depacketizer golden 用例：Single-NALU/STAP-A 多 NALU/FU-A 分片重组三形态全覆盖；H265 FU 基础
- □ Annex-B ↔ AVCC 双向转换往返一致
- □ RTCP SR：NTP/RTP 时间映射换算断言
- □ jitter buffer 简化版行为（乱序/迟到包丢弃策略确定）

**B demo 手动步骤**
1. 输入 `rtsp://...` 直连地址 → 拒绝并解释（同 rtmp 教育行为，属预期）。
2. `node samples/gateway/mock-rtsp-relay.js` → canned H264 流渲染上 Canvas；面板显示 SDP 摘要与 RTP 序号连续性统计。
3. 开"人为注入乱序"开关 → jitter buffer 生效、画面不花屏（fixture 固定内容肉眼核对，截图留档）。
4. README 复核：UDP 不可达原理、RTSP→WebRTC / RTSP→HLS 替代拓扑与延迟量级表；网关契约 rtsp 章节 architect 署名上板。

**C 边界与异常**
- □ 丢包（gap 超阈值）→ 丢至下一关键帧策略，不花屏死等
- □ RTCP 复合包拆分正确；SR 缺失时延迟估算降级为"—"

---

## 7. demo 页静态检查规程（M3 触发，逐页执行）

### 7.1 检查矩阵（每页一行登记）

| 检查项 | 方法 | 通过标准 |
|---|---|---|
| S-1 页面可达 | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/<mod>/demo/` | 200 |
| S-2 资源引用完整 | node 一次性脚本解析 index.html 的 script/link/img src+href（相对路径），逐个 HTTP HEAD | 全部 200，无 404/500 |
| S-3 无未捕获异常 | 浏览器打开，DevTools Console 观察 window.onerror/unhandledrejection | 无未捕获异常；**预期错误提示除外**（附录 A） |
| S-4 第三方请求红线 | Network 面板过滤非 localhost 域 | 主链路零第三方；仅 hls/flv/webtorrent 对照示例区允许 CDN（且页面明确标注可选增强） |
| S-5 降级底线 | DevTools 禁用 WebCodecs/MSE（或用不支持浏览器） | 显示缺失能力清单，解析层轨道信息仍展示 |
| S-6 site 皮肤接入 | 目测 + DOM 查类名 | topbar/stage/控制条/信息面板同构，PurePlay 品牌（title 与 skin BRAND） |
| S-7 DESIGN §12 抽查 | 键盘 Tab/Space/方向键/F/M/C/Esc；reduced-motion；640px 断点 | 与 DESIGN.md §12 条款一致（designer/ui-kit 主责，qa 抽查登记） |

### 7.2 批量命令骨架（qa 执行用）

```bash
node serve.mjs 8080 &          # 静态服务
for m in core mp4 mov flv ts wav hls mkv flac subtitle cmaf ape webtorrent webrtc rtmp rtsp; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8080/$m/demo/")
  echo "$m demo: $code"
done
# S-2 资源探测：node scripts 下临时脚本（不提交业务仓库，qa 本地执行）解析 HTML 引用并逐个 HEAD
```

### 7.3 结果处置

- 每页结论 `[可加载|资源完整|无未捕获异常|第三方合规|降级底线]` 五元组登记看板；
- 任一项不过 → 按 §3.3 登记 team_task 缺陷，跟踪闭环后复核销项；
- M3 出口判据：当时已存在的全部 demo 页五元组全绿。

---

## 8. 冒烟测试脚本说明

冒烟 = 里程碑出口前的快速健康检查，全部通过才进入正式验收细项。

| 编号 | 名称 | 命令/操作 | 通过判据 |
|---|---|---|---|
| SM-1 | 全仓单测 | `npm test` | exit 0，fail=0（skip 附原因） |
| SM-2 | fixture 确定性 | 连跑两次 `npm run fixtures`，diff 输出目录 | 两次产物完全一致（固定种子） |
| SM-3 | demo 服务 | `node serve.mjs 8080 &` + §7.2 批量 curl | 所有已存在 demo 页 200 |
| SM-4 | 播放四步冒烟 | hls 内置静态 VOD：播放→暂停→seek→续播（PRD §3.7 附加项） | 四步均成功，截图留档 |
| SM-5 | mock 网关冒烟 | `node samples/gateway/mock-flv-ws.js` / `mock-rtsp-relay.js` + 对应 demo 页 | canned 流可播；断开后重连状态可见 |
| SM-6 | 直连拒绝冒烟 | demo 页分别输入 rtmp:// 与 rtsp:// 地址 | 教育文案出现，无异常栈 |
| SM-7 | 能力降级冒烟 | 任一渲染型 demo 在能力缺失路径打开 | 缺失清单 + 解析层信息仍可用 |

说明：SM-1/SM-2/SM-3 可无人值守自动跑；SM-4~SM-7 为浏览器手动步骤（R8 风险共识：渲染层无自动化手段，人工清单+截图代替；Playwright 冒烟列为可选增强，若 sdet 后续交付则升级 SM-4~SM-7 为自动化）。

---

## 9. 附加人工项与留档清单（PRD 点名，验收报告必备附件）

| # | 附加项 | 来源条款 | 留档位置 |
|---|---|---|---|
| X1 | core 能力徽标 Chrome+Safari 对照截图 | §3.1 | docs/qa-evidence/core/ |
| X2 | wav 24bit/32f 试听无爆音记录 | §3.6 | docs/qa-evidence/wav/ |
| X3 | hls 四步冒烟截图 | §3.7 | docs/qa-evidence/hls/ |
| X4 | flac 真实世界文件回归记录 | §3.9 | docs/qa-evidence/flac/ |
| X5 | subtitle JS vs libass-wasm 对照截图 | §3.10 | docs/qa-evidence/subtitle/ |
| X6 | webrtc 回环 Chrome+Safari 统计截图 | §3.14 | docs/qa-evidence/webrtc/ |
| X7 | webtorrent info-hash 与外部工具比对记录 | §3.13 | docs/qa-evidence/webtorrent/ |
| X8 | mkv 两步走两次验收记录 | §3.8 | docs/qa-evidence/mkv/ |
| X9 | README 能力矩阵实测填写（Chrome/Edge/Firefox/Safari 最新两大版本） | §2.4 | 各模块 README + 验收报告 |
| X10 | R13 实测复核回填（延迟量级/兼容性论断以实测为准） | §5-R13 | 验收报告附录 |

---

## 10. 执行节奏与报告物

| 节点 | 触发条件 | qa 动作 | 报告物 |
|---|---|---|---|
| 现在 | TESTPLAN 发布 | 上板周知，等待各模块产出 | 本文档 + 看板帖 |
| CP-A 单测汇总 | 解析层+单测批量完成节点（pm 方案 M1/M2 出口；对应 leader 口径"M2 后"） | §5.2 全量跑测 → 逐模块统计 | 看板 key=qa-report（含缺陷台账） |
| CP-B demo 检查 | demo 管线可用节点（pm 方案 M3 出口；leader 口径"M3 后"，含早期 demo 回归） | §7 逐页静态检查 | 五元组矩阵 + 缺陷 team_task |
| CP-C 桥接专项 | pm 方案 M4 出口 | SM-5/SM-6 + rtmp/rtsp 细项验收 | 桥接模块验收小结 |
| CP-D 最终验收 | pm 方案 M5（reviewer 评审完成后） | 全部模块终验 | 《验收报告》交 captain：总体结论(通过/有条件通过/不通过) + 16 模块明细(五件套✔表/单测实数vs门槛/demo 结果/边界结果) + 附加项 X1~X10 + 能力矩阵实测 + 缺陷闭环表 |

里程碑编号兼容说明：pm PRD 采用 M0~M5，leader 早期口径为 M1~M4；qa 以上表 CP-A~CP-D 绑定"实质完成内容"而非编号，两个口径均已覆盖。

---

## 11. 口径问题记录（2026-08-25 全部结案）

| # | 问题 | 结论 |
|---|---|---|
| Q1 | HLS AES-128：PRD 与 CONTRACTS 表述冲突 | ✅ 结案并全链路闭合（captain【裁决-qa三问】+ leader 复核 + pm 三轮核验）：**AES-128(WebCrypto AES-CBC 整段解密)属本期硬验收、仅限 hls 模块**。PRD 自 v2.1 起已修复为支持口径，现行 **v2.2** §3.7【单测】行含完整分支——解密逐字节一致 / IV 两规则黄金用例 / keyLoader 失败→NETWORK_ERROR / 密钥≠16 字节→NOT_SUPPORTED / 首块校验失败(TS 应 0x47)→PARSE_ERROR / SAMPLE-AES→NOT_SUPPORTED 且不触发解密 / cryptoSubtle=false 含 KEY 清单→NOT_SUPPORTED，与用例集 HLS-N02/HLS-C04 同口径。**CP-A 直接按 PRD v2.2 §3.7 验收，不存在未修订缺陷**（本行早期版本所记"PRD v2.0 措辞残留"作废，勿再引为催办依据）。凭证：看板帖 aes128-scope-restored-per-leader-ruling。 |
| Q2 | 单测门槛合计"约545" vs 565 | ✅ 结案：以 PRD 正文逐条合计 **565 例**为准；pm 已上板勘误帖闭环。PRD v2.0 分模块拆分微调(flv≥35/subtitle≥35)，总数不变。 |
| Q3 | hls/flv 重定位后硬验收项是否维持 | ✅ 结案维持：功能硬验收不减(hls 本地 VOD 可播/flv MSE 可播照验)，仅 README 生产建议口径声明生产请用 hls.js/flv.js。 |

---

## 附录 A：预期行为清单（不算缺陷）

1. 外部 URL 因 CORS 失败时的明确解释文案（R12 共识）。
2. `rtmp://` / `rtsp://` 直连地址输入被拒绝 + 教育文案（PRD 点名教育行为）。
3. ws-flv 地址无网关时连接失败提示（flv demo 预期）。
4. ProRes/DNxHD 等"识别未解码"黄标提示（mov 预期）。
5. ape/flac 范围外规格的支持范围提示（引 README）。
6. webtorrent "连接真实 swarm"按钮默认灰显。
7. 能力缺失时展示缺失清单且解析层信息可用（降级底线）。
8. ape 解码层用例因无 ffmpeg 自动 skip 且显示原因（解析层不豁免）。
9. demo 对照示例区的 CDN 引用（hls.js/flv.js/webtorrent 可选增强，页面明确标注）。
10. 加密/DRM 内容的 NOT_SUPPORTED 明确提示。

---

*本计划由 qa 维护；PRD/契约发生版本变更时按变更条款同步修订并在文末登记。*
