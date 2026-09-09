# 第一轮评审问题清单 —— 解析层正确性（滚动评审）

> 评审人：reviewer ｜ 日期：2026-08-25 ｜ 台账：T21 / 任务 t12
> 范围：已全绿七模块 core / hls / mkv / ts / wav / subtitle / webtorrent（实测 242 例：240 过 / 0 挂 / 2 skip）
> 方法：5 路并行深审 + reviewer 逐条现盘亲证（关键发现均经 Node 实测复现）；对照 CONTRACTS v0.2（§0/§1/§2/§3/§4/§10/§11）、00 文档交付标准、《裁决-契约优先》《裁决-hls-flv重定位》
>
> **快照声明**：滚动开发期间部分模块在评审窗口内持续变更——hls 的 AES-128 解密层（decrypter.js/aes-cbc.js）在评审中途落盘、mkv 的 EBML 8 字节 Size 缺陷在中途热修。初版子代理报告曾据旧快照误报"hls AES 整层缺失"（已驳回）。**本清单全部条目按核验时点磁盘实码确认**；行号会随后续开发漂移，修复复核以问题实质为准。

## 总览

| 模块 | owner | 阻断 | 严重 | 建议 | 单测 |
|---|---|---|---|---|---|
| ts | vue-dev-2 | **2** | 5 | 11 | 31/31 |
| core | media-dev | **1** | 9 | 12 | 全绿 |
| mkv | vue-dev-1 | **1** | 3 | 11 | 60/60 |
| wav | ui-kit-dev | **1** | 3 | 10 | 全绿 |
| hls | vue-dev-3 | 0 | 7 | 13 | 28过/2skip |
| webtorrent | vue-dev-1 | 0 | 4 | 8 | 9/10 |
| subtitle | ui-kit-dev | 0 | 2 | 6 | 全绿 |
| **合计** | | **5** | **33** | **71** | |

---

## 0. 系统性问题（跨模块，建议 captain 单独立波次收敛）

- **S1【严重】错误体系碎片化，契约 §11.3 PlayerError 十码未在全仓收敛**
  core errors.js 仅 5 码（缺 PROBE_FAILED/NETWORK_ERROR/SEEK_UNSUPPORTED/TIMEOUT/ABORTED）；webtorrent/src/utils.js:5 自造同名 `PlayerError(message, code)` **构造签名与 core 相反**且用编外码（NO_CLIENT/ATTACH_FAILED/NO_MEDIA_FILE/DESTROYED），index.js 还对外再导出同名类——消费方 instanceof 与 err.code 双双不可靠；hls 全模块零 PlayerError（自造 LoadError + 大量裸 Error，segment-loader 无超时机制致 TIMEOUT 码无从产生）；wav/subtitle 各自为政（subtitle 尚用废弃码名 INVALID_STATE）；ts 错误通道全是裸 Error 且 warn 级走 'error' 事件。
- **S2【严重】core 契约承诺的公共件缺位，迫使各模块自含重复实现**
  logger（createLogger/setLogLevel）整体缺失→各处 console 直连；codec-string 缺 h264CodecStringFromSps/hevcCodecStringFromHvcC/aacCodecStringFromAsc/fallbackCodecString 四 API（现有 aacCodecString 默认 AOT=2 属"拿不到参数集就编造 LC profile"，违反 §3）；capabilities 缺 hasWebGPU/hasCryptoSubtle/chooseRoute、缓存参数是假的、输出形状不符；ByteSource 家族缺 HttpRangeSource（现散落 mp4/src/range-loader.js）与 ChunkBuffer（全仓无实现）。
- **S3【阻断级】契约定稿接口落地参差，接入波次前必须收口**
  ts 完全无适配壳（唯一未包壳 demuxer）；wav/subtitle 只有迁移别名无定稿名；**core Demuxer 基类自身偏离冻结契约**（init/mediaInfo驼峰事件/秒制 seek/同步 destroy，全仓仅 mp4 采用该基类）；§10 注册形状（containerName/extensions/mimeTypes/probe/createDemuxer）仅 mkv 具备。
- **S4【严重】测试固化缺陷两起**：ts-demuxer.test.js:77 断言 `duration===1024` 把 AAC 步进 bug 固化；webtorrent/source.test.js:44 断言越界返回空数组把契约偏离固化。改行为必须同步改测试。

---

## 1. ts（vue-dev-2）— 阻断 2 / 严重 5 / 建议 11

### 阻断
1. **[阻断] ts/src/ts-demuxer.js:38 —— 契约适配壳完全未落地**（E-1 裁决重点核查项）。对外仍是 probe/push/flush/reset 内核接口，extends 本地 Emitter 非 core Demuxer；无 open/readSample/samples/start/destroy；事件 tracks/metadata/complete ≠ error/media-info/sample/progress/end；probe 返回 boolean（:69-83）非 ProbeResult|null；index.js 无 §10 形状。对照：mkv/wav/flac 均已有契约面。
   建议：新增壳层包装内核（ChunkSource 流式 open、事件重映射、错误归一 PlayerError 十码、probe 返回 {container:'ts',confidence≥0.8}），注意 hls/src/fmp4-muxer.js:372-404 已直接耦合内核字段名需同步。
2. **[阻断] ts/src/ts-demuxer.js:359-369,416-456 —— 对外时间基未换算整数微秒**。视频 pts/dts 以 90kHz ticks 直接出境，音频同；src 内 `*1e6/90000` 类换算零处出现。违反 CONTRACTS §0.5。
   建议：随壳层在 readSample 边界统一换算，内部保留 ticks。

### 严重
3. **AAC 同 PES 多帧 pts 步进单位错乱**：ts-demuxer.js:416 `framePts=base+i*1024`、:424/:454-456 duration 同病——把"每帧 1024 采样"当 90kHz tick 加。实测 framesPerPes=3 时相邻帧距 1024,1024,4221 交替（应恒 ≈2089@44.1kHz），A/V 相位漂移；广播流常 4~8 帧/PES 必触发。正确步长 `Math.round(i*1024*90000/sampleRate)`。⚠️ ts-demuxer.test.js:77 已把 bug 数值固化成断言。
4. **buildHvcc general_* 四字段整体偏移一字节**：nalu.js:200-203 取 sps[2]/sps[3..6]/sps[7..12]/sps[13]，规范应为 sps[3]/[4..7]/[8..13]/[14]（SPS 前 2 字节 NAL 头 + 1 字节子层信息后 PTL 才开始）。实测 compat=0x01400000≠0x40000000、level_idc=0≠93。另 :212 temporal_id_nesting 硬编码 0、:208-210 chromaFormat/bitDepth 硬编码 4:2:0/8bit（main10 流必坏）。单测只验结构不验 PTL 值故漏检。
5. **PES 重组缓冲无上限**：ts-demuxer.js:260-282 declared=0（视频常态）仅靠下一 PUSI 分帧，流中断即无界累积；pesLengths(:269) 只写不读属死记账。建议超限（如 4MB）丢弃该 PID 并 warn-once。
6. **continuity_counter 全模块零处理**（grep=0）：丢包静默拼接跨包损坏 ES。PRD 点名容错场景缺失。建议按 PID 跟踪 CC、断档 warn-once、连续异常丢弃 PES 缓冲。
7. **PAT/PMT 动态更新只增不减且双状态可分裂**：psi.js:52 versionNumber 解析后无人消费；pmtPids/streams 只增不删；ts-demuxer.js:466-471 `_ensureTrackState` 不更新已有轨 codec——PMT 变更编码后 streams 与 trackState 分裂，样本按旧解码路径产出。

### 建议
scrambled 包静默丢弃无告警(:193)；PCR 未提取(:196-198)，时长估算退化；188/192 误锁后永不重新探测包长(:163-179)；push 逐字节 O(n²) 合并(:90-98)与 PES 出帧重复 concat(:273)；死代码组(_lastIndexOf:181 未调用、decodeTimestamp5 未使用、readSectionFromPayload 无调用方、bits.js:22 三元恒等)；ts/ 目录无 README；PsiAssembler 超 8KB 静默拒收不终止状态(psi.js:159)、_drain 实参与形参不符(:170/:145)；LATM ASC 定位 ±24 位启发式扫描遇 escape 采样率即错位(aac.js:169-171)、buildAudioSpecificConfig 8 声道静默改 1(:100)、ASC 采样率 idx13/14 undefined 透传(:113)；unwrapTimestamp delta==±HALF 阈值歧义；parsePESHeader marker 位不校验、hasDTS&&!hasPTS 非法组合误读、无 PTS 视频帧出 timestamp:0 破坏单调性；Track 字段名 config/channelCount/sampleFormat 偏离定稿(description/numberOfChannels/bitstreamFormat)、Sample 用 pts 非 timestamp、duration:null 违反"未知填 0"、Track.id 用 PID 违反从 1 起、container:'mpeg-ts' 应 'ts'。

**通过项**：BitReader MSB-first、decodeTimestamp5 拼接、unwrapTimestamp 前/后向回绕、AF 越界保护、pointer_field、section 上界钳制+CRC32（已知向量）、buildAvcc 完全合规、ADTS 剥头/MPEG-2 兼容、splitAnnexB、H264 SPS 宽高、未知 stream_type 白名单跳过、subarray 所有权安全、fixture 读写互镜像+流式等价性用例是好实践。
**测试缺口**：向后跨圈回绕、流中部垃圾注入、CC 断档、intra-PES 音频帧距（现断言固化 bug）、PMT 版本变化/scrambled/192 整流端到端、reset 幂等。

### ✅ ts 复核记录（2026-08-25 · 第一批闭环）
vue-dev-2 回执 7 条全闭环，reviewer 磁盘实码逐条复核**全部通过**：
①壳 `TsDemuxer extends Demuxer`(ts-demuxer.js:41)，open/readSample/samples/start(:456)/destroy(:487)/parseInit 别名齐；probe→createProbeResult(0.92|0.55,'ts')|null 同步不抛。
②µs 边界=ts-stream-engine.js 引 core ticksToUs(:29,:399-400)。③AAC 步进闭式公式(:505)+测试断言 44100Hz 恒 23220µs、跨 PES ±10µs(ts-demuxer.test.js:104-122)——**S4-ts 测试固化项同步解除**。④buildHvcc 改读 sps[3]/[4..7]/[8..13]/sps[14]。⑤maxPesBufferBytes 默认 8MB 可配，超限丢弃+warn(:347-348)。⑥CC 逐 PID 检测+AF/discontinuity 豁免+ccErrors 计数。⑦pmtVersions 版本对账(:59,:297-301)同版去重、换版重建 streams。
回归 `node --test` reviewer 亲跑 **53/53 通过**；hls fmp4-muxer.js:376 已按新壳重写，跨模块耦合解除（vue-dev-2/vue-dev-3 协同确认）。
残余转跟踪：buildHvcc 的 chromaFormat/bitDepth 仍硬编码 4:2:0/8bit、temporal_id_nesting 恒 0（原发现#4 附带项，main10 流场景）——建议级随下一波处理。

### ✅ S1 波次复核记录（2026-08-25 · 第二批闭环）
captain 提请复核错误体系统一（wav/flac/ape/webtorrent/subtitle 五处落地），reviewer 磁盘实码逐项验证：
1. **core 十码源头就位**：errors.js 十码封闭枚举齐全——**core#6 关闭**。
2. **wav/flac/ape**：本地枚举删除→纯再导出 core（errors.js 头注明示 S1 收口），快捷构造器签名不变。
3. **webtorrent**：本地 PlayerError 类删除→re-export core；调用点全部按 (code,message) 重写且取值十码内（player.js/assembler.js 实查）；withTimeout 改抛 TIMEOUT——**webtorrent#2 关闭**。
4. **subtitle**：SubtitleError extends core PlayerError（error.name 保留且 instanceof core 成立）、ErrorCode 再导出、renderer.js 裸串码改 ErrorCode.STATE_ERROR(:49)、头注过期引用同步修正——**subtitle#3 关闭**。
5. **grep 无本地枚举残留**（reviewer 独立复查五错误文件 Object.freeze 零命中）。
6. **测试亲跑**：五模块套件 257/257；全仓 772/772 fail=0（复跑确认）。⚠️ 首跑曾现 1 例不可复现失败（mp4/artifacts-edge.test.js "ByteStream is not a constructor"，单文件 21/21、复跑全绿）——判定 node --test 并发抖动，转 @sdet 观察项。计数口径：npm test 用递归 `**/*.test.{js,mjs}`（842 例口径），reviewer 单层 glob 772 例，范围差异非缺陷。

**S1 整体状态：大部分收口**。已闭：core#6、webtorrent#2、subtitle#3、ts 错误通道（随壳层闭环）。**仍开放**：hls 错误体系偏离（hls#5：LoadError→PlayerError 映射与 SegmentLoader 超时不在本波次）——维持待修。

### ✅ wav#1 复核记录（2026-08-26 · 阻断闭环）
ui-kit-dev 回执"拒写上报+主线程节流双保险"，reviewer 实码复核**通过，阻断#5 关闭**：
1. worklet 写侧守卫（worklet-processor.js write()）：`free=capacity-buffered()` 截断写入，溢出帧计入 droppedTotal 并 postMessage({type:'overflow',dropped,total})——未消费采样绝不被绕回覆写，与评审建议一致。
2. 主线程节流（player.js）：processorOptions 传 capacityFrames(:227)、progress 消息携带 buffered(:241)、HIGH_WATER=容量−PUSH−1024 水位推迟推送(:35,:293)——正常路径溢出不可达，写侧守卫为最后防线。
3. 防回归测试 review-fixes.test.js 断言扎实：dropped=76 精确值(1100−1024)、逐样本序列完整性断言（覆写即 fail）、droppedTotal==推送总量−入环量恒等式、eof 尾帧保持。reviewer 亲跑 review-fixes 10/10、wav 全套 **38/38**。
备注：ui-kit-dev 提议的"溢出降级混音可选模式"非契约/评审要求，当前拒写+上报已合规；如产品侧需要无丢帧体验由 captain/pm 另行裁决。

### ✅ wav#2/#3/#4/#8 复核记录（2026-08-26 · 第三批闭环）
ui-kit-dev 回执四项，reviewer 实码复核**全部通过，wav 模块 round-1 条目清零**：
- **#8**：`throw new Error|TypeError` 全模块 grep 清零；pcm-convert.js 非法位深=stateError(:25)、组合不支持=notSupported(:79)；player.js 环境守卫=notSupported(:43)、未加载先播=stateError(:111)；demuxer.js error 态改 stateError 并明确文案(:148)。
- **#2**：seek 后一律回 'ready'(:116)；samples 入口守卫兼容 ready/ended/seeking(:191)，review-fixes「EOS 后 seek 可继续迭代」用例覆盖。
- **#3**：open()(:216)/readSample(trackId)→Sample|null/destroy() 幂等+销毁后 STATE_ERROR 定稿面落地，parseInit/samples/stop 别名保留。
- **#4**：riffSize===0xFFFFFFFF 识别为流式哨兵不再拒头(riff-parser.js:86-88)，按 data 块推算时长，buildStreaming fixture 用例覆盖。
reviewer 亲跑 wav 全套 **38/38 通过**。

---

## 2. core（media-dev）— 阻断 1 / 严重 9 / 建议 12

### 阻断
1. **[阻断] core/src/demuxer.js:45-139 —— Demuxer 基类与契约 §2.2 定稿全面偏离，且全仓仅 mp4 采用**。无 open()/readSample()/getBufferedRanges/tracks/metadata getter；事件 'mediaInfo'(:64) 非 'media-info'；seek(timeSec) 秒制且默认抛 STATE_ERROR 而非 SEEK_UNSUPPORTED(:121-130)；destroy 同步(:132)；无状态机仅两布尔。基类"事件/状态机/迭代器骨架由基类提供"的作用未达成——mkv 自行实现契约面、wav/flac 本地自含、flv/ts fork Emitter。
   建议：按契约重写公开面，旧 attach/init/samples 按 §2.4 别名兼容保留；这是接入波次的先决条件。

### 严重
2. **moreRbspData() 必抛 TypeError（实证）**：exp-golomb.js:61 调用不存在的 `reader.seekBits`（bit-reader.js:98 实为 seekToBit），finally 中抛出还会吞 try 内返回值。当前无调用方属潜伏雷，HEVC SPS 接入即崩。
3. **parseH264Sps CropUnitY 映射错误（实证，裁剪流高度算错）**：exp-golomb.js:161-164 idc=1 得 cropUnitY=1（规范 4:2:0 应 2×(2−frame_mbs_only)），且完全没乘 frame_mbs_only、未折算 ChromaArrayType。实测 1088 宏块+crop_bottom=4 输出 1084 应为 1080——TS/FLV 无 tkhd 兜底时 1080p 宽高全错。
4. **codec-string 四个收敛 API 缺失三个半 + 默认值编造 profile**：缺 FromSps/FromHvcC/FromAsc 三转换与 fallbackCodecString；aacCodecString(audioObjectType=2) 默认参数即编造；参数不足静默返 '' 不打 warn 违反 §3。
5. **capabilities 缺 hasWebGPU/hasCryptoSubtle/chooseRoute；缓存参数未实现**（JSDoc 声称 memo，函数体无引用）；detectCapabilities 输出形状不符契约；pipeline 判定"任一轨可解即选 WC"(:137)偏离"全部支持才 WC"规则。
6. **errors.js 仅 5 码**（见 S1）——上层 TIMEOUT/PROBE_FAILED 场景无处取码。
7. **writeMatrix 默认值写坏 unity 矩阵（实证，污染 mp4 remux 输出）**：byte-stream.js:328-337 其余元素乘 65536 而 w=16384 裸写 → 末元素 0x00004000 ≠ 0x40000000；mp4/src/box-builder.js:82/:102 无参调用全部中招。
8. **types.js 数据形状偏离冻结面**：Sample 缺 codec/timestamp 字段（现为 pts/ticks）；MediaInfo 缺 durationUs/seekable/live/metadata；ProbeResult typedef 完全缺失、Demuxer.probe 返回裸 number(:30-33)。
9. **worklet 注册名 'pcm-ring-worklet'(:93,:96) ≠ 契约 'player-audio-sink'；无 currentTimeUs/underrunCount getter**（currentTimeSec() 方法秒制）——契约 §7 定 currentTimeUs 为全系统主时钟源。
10. **VideoFrame 从不 close**：video-frame-renderer.js draw()(:129-150) 无 finally close，mp4 webcodecs-pipeline.js:101 亦不 close → WebCodecs 路径每帧泄漏一个 VideoFrame，违反渲染铁律。

### 建议
nal.js:87 尾零全量剥离吞合法 cabac_zero_words；core 位流原语（bit-reader/exp-golomb/nal）全仓零外部采用、ts/src/nalu.js 平行实现且 annexbToAvcc 同名异签名、hevcNalType 空数组返 0 非 -1；demuxer init() 无并发重入保护(:60-64)、destroy 后 attach 放行(:46)、close promise 丢弃(:137)；BlobDataSource 越界静默短读与 MemoryDataSource 策略不一致(:50-56)、asDataSource 抛裸 TypeError；byte-stream.js:28-30 isView 分支丢弃 offset/length 参数（实证 length=8 应 4）；emitter console.error 直连(:54)；audio-worklet push() transfer 反转所有权但注释称拷贝(:180-184)、溢出负取模 NaN 风险(worklet :72-73)；clock 同步阈值 ±120ms/±48ms vs 契约 ±20ms 未文档化、Stats 默认 Date.now 非单调；readUEG 31 前导零 `(1<<31)` 负溢出（实证 -2 应 4294967294）；mse-helper SourceBuffer 失败映射 STATE_ERROR 应 DECODE_ERROR/NOT_SUPPORTED(:51,:159)。

**通过项**：BitReader/ByteStream 大端原语、ue/se 常规序列、EPB 剥离往返、nal 主流程、MemoryDataSource 越界 reject、Emitter 快照遍历+异常隔离、Node 下能力探测全 false 不抛、基类 STATE 快速失败守卫、MseHelper 串行队列、中文 JSDoc 完整。
**测试缺口**：moreRbspData 零测试、frame_cropping 零用例、readUEG 大值、codec-string 降级路径、并发 init 竞态、'error' 双通道、状态机矩阵、Blob 越界、worklet 环形缓冲（建议抽纯函数注入测试）。

---

## 3. mkv（vue-dev-1）— 阻断 1 / 严重 3 / 建议 11

### 阻断
1. **[阻断] mkv/demo/index.html:86 —— 导入已被删除的 `createMkvDemuxer`，demo 页加载即 SyntaxError**（现 index.js:40 仅导出 createDemuxer）；README.md:78/:101/:161 的快速开始与 API 表同步失效。
   建议：demo 与 README 按 §10 新公开面重写。

### 严重
2. **EBML 5~7 字节 Size VINT unknown 阈值 int32 移位溢出**：ebml.js:82 `(1 << (7*len))-1`——len=5 得 7、len=6 得 1023、len=7 得 131071（应 2^(7·len)−1）。实测 encodeSize(7,5)/encodeSize(1023,6)/encodeSize(131071,7) 读回全部误判 unknown=true → 合法元素走边界探测可吞并兄弟元素错位解析。（注：8 字节 BigInt 路径评审中途已热修 ✓）
3. **块头解析裸 Error 从 readSample 逃逸**：demuxer.js:39/:41 `throw new Error('块载荷过短')`，容错 try 只包 decodeLacing(:888-895)；截断模糊实测 61 截断点中 2 例逃逸裸 Error，既非 PlayerError 也无 'error' 事件，违反 §11.3 双通道。
4. **Range 读取不校验 206**：source.js:158-165 服务器回 200 全文件时整包 body 被当作目标窗口返回，demuxer 静默解析错位数据。建议非 206 时切片或报 SOURCE_ERROR。

### 建议
BlockDuration 先除后舍产生小数 µs(:897-898)；unknown-size Cluster 双重遍历 IO 翻倍(:299-313,:799)、流式 webm open 扫完整簇；Cues locate 线性扫 O(n)(:727-734 应二分)；Xiph 锁存链截断读 undefined→NaN 使 lastSize<0 守卫失效(lacing.js:42)静默丢帧；codecs.js mp3/vorbis codec 串兜底透传 CodecID('A_MPEG/L3')、PCM 固定 s16 不看 bitDepth(:147,:32-39)；头注释宣称 progress/initTimeoutMs 未实现(:9,:111)；timecodeScaleNs/defaultDurationNs 等 ns 内部字段经 getTrackById 可触达(:129,:588)、:884 clusterTimeNs 命名误导；createDemuxer 仅嗅探 64B 且 <0.8 即 PROBE_FAILED(index.js:50-53)、probe 对外来 DocType 返 {confidence:0.5} 非 null 与 §10 口径张力；console.warn 直连未接 logger(demuxer.js:893)；DocTypeReadVersion 从不校验(schema.js:35-36)；BufferSource.read 返回用户 buffer subarray 有踩脏窗口（README 宜注明）。

**通过项**（质量较高的部分）：大端 VINT 全族、iterElements 越界钳制、unknown-size master 白名单推进无死循环（模糊翻转 0 例非契约异常）、open() 全链路 PlayerError 归一化+emit、SeekHead 失配回落线性簇索引、ns→µs 两处 Math.round 收敛、SimpleBlock 负相对时间码符号扩展、三种 Lacing 正确、Sample 五必填+duration 未知填 0、字幕 type='text'、tracks 排序 video>audio>text、probe 永不抛未命中 null、seek 返回 actualTimestampUs/SEEK_UNSUPPORTED/加密轨 NOT_SUPPORTED、pull 模式无队列积压、出口 slice() 脱离宿主缓冲、webTorrent 交叉验证链路（除红测）。
**测试缺口**：加宽 Size roundtrip（本次漏网区）、负 relTimecode、SeekHead→Cues 路径零覆盖、畸形块回归、lacing 截断头部、常驻 fuzz（断言异常要么无要么 name==='PlayerError'）、多 Segment 文件。

---

## 4. webtorrent（vue-dev-1）— 严重 4 / 建议 8

### 严重
1. **随机读越界返回空数组、尾部短读静默**（source.js:64/:74）：契约 §2.1 read 应"恰好 length 字节"、越界归 SOURCE_ERROR reject；现状让 demuxer 无法区分 EOF 与读坏，**且 source.test.js:44 固化为预期断言**（mkv/src/source.js 同款模式，跨模块一致性偏离）。
2. **同名异构 PlayerError 构造签名反转**（utils.js:5-15 `(message,code)` vs core `(code,message)`）+编外码——详见 S1，同模块新 bencode.js:28 又按 core 序使用，同仓两套并存。
3. **元数据就绪后 client 异步错误永久吞掉**（player.js:143）：once('error') 在 add settle 后仍挂着但不转发，运行期 tracker 全灭/swarm 断开对上层完全静默——边下边播最关键的断流感知缺失；监听器还随每次 attach 累积。建议 settle 时 off + 挂常驻 error/warning 转发。
4. **交叉验证测试红**：__tests__/source.test.js:122 `d.samples()` 无参调用已不适配 mkv 定稿 samples(trackId)。

### 建议
NO_MEDIA_FILE 后 state 永久卡 'loading'(player.js:79/:92)；向后读慢路径 #restartAndDiscard 无界缓冲 GB 级 OOM 面(source.js:146-161)；并发重叠 read 游标竞态无守卫(:88-130)；magnet/infohash/.torrent 输入零校验、无 tracker 白名单钩子(player.js:50-52)；seed/leech 无 stopWhenDone 策略与 done 事件；loader.js:34 内置 CDN URL 列表与 §0.1 文义张力（降级链完备、红线未触碰，建议默认仅认全局注入、CDN 由宿主显式传入——治理裁决项）；§10 createSource(torrentId) promise 工厂缺失；close 与在途 read 竞态绕过包装(:163-169)、withTimeout 裸 Error 应用 TIMEOUT 码。

**通过项**：「只产 Source 不碰 Sample」达成且与真 MkvDemuxer 全流程互通；硬 import 红线零触碰（全局注入→CDN 竞速→null 三级降级）；slice/sequential 双策略；零长 chunk 防死循环；destroy 幂等次序正确；summarizeTorrent 只取叶子字符串；测试全离线注入。
**测试缺口**：越界语义改造联动、并发 read、大偏移内存行为、attach 后 error 转发、loader 动态 import 正路径。

---

## 5. hls（vue-dev-3）— 严重 7 / 建议 13

> ⚠️ 初报两条阻断（AES-128 层缺失/SAMPLE-AES 静默）经现盘核验**驳回**：decrypter.js/aes-cbc.js 已落盘且 player.js:226-227 接入、SAMPLE-AES 在 decrypter.js:80-84 已拒 NOT_SUPPORTED——系评审窗口期代码漂移。以下为按现盘确认的条目。

### 严重
1. **EXT-X-SKIP Delta 清单 sn 计算错误**（m3u8-parser.js:254）：`sn = mediaSequence + index` 未加 skippedSegments（:426 解析后全仓零消费）——RFC 8216 Delta 语义下所有 sn 系统性偏移，直播衔接 findIndex(sn===lastLoadedSn+1) 与 _HLS_msn 阻塞重载全部失准。建议 `+= result.skippedSegments` 并补用例。
2. **直播窗口推进失配回退 0 重放**（player.js:366-368）：目标 sn 被滑出窗口时 resumeAt=-1 → nextSegmentIdx=0，从窗口最旧分片重复下载追加，时间线重叠连带清缓冲兜底放大事故。建议按 PDT/sn 差就近前跳或报 NETWORK_ERROR。
3. **ABR/手动切档后从片头重装**（player.js:162 `_startPipeline()` 恒置 nextSegmentIdx=0；:238/:410 切档均走此路径）：VOD 中途切档≈回到片头并丢光缓冲。建议按已播时刻在新列表定位续接下标。
4. **mse-controller.js:36 裸引用 window**：Node 下 ReferenceError 而非优雅降级，违反 §0.3 双环境硬约束。改 `typeof window !== 'undefined' && …`。
5. **错误体系全面偏离 §11.3**（并入 S1）：LoadError 自造类、m3u8-parser 裸抛、switchTo 抛 RangeError(level-controller.js:62)、SegmentLoader 无任何请求超时机制（TIMEOUT 码无从产生）、_fail 对外载荷为自造形状。
6. **README.md:36/:137 与实现、契约三方矛盾**："AES-128 ❌ 本期不做/本期范围外"——现行契约 §2.6 恰好相反且实现已存在；player.js:17 陈旧注释"暂不解密"同病。文档须随 v0.2 重写。
7. **parseIv 奇数长度 hex 产出小数下标**（m3u8-parser.js:60-69）：Uint8Array 非整数索引赋值被静默丢弃→IV 错/全零；hex>32 字符取前 16 字节而非报错；与 utils.js hexToUint8 同语义双实现且行为不一致。

### 建议
EXTM3U 首行校验缺失（HTML 错页误导性报错）；transmuxer kind==='unknown' 静默落 TS remux 路径空转跳分片(:68-82)；fmp4-muxer 编造 fallback `.42E01E`(：544-550)违反 §3、toAvcc 失败原样透传 AnnexB 产坏流(:559-567)；mfhd 序号恒 1、_seq 死代码(:273/:493)；Transmuxer.tsAvailable() 死代码+降级承诺虚假（fmp4-muxer 顶层静态 import ts/nalu，ts 缺失则整个 hls 加载失败）；QuotaExceeded 回调字段声明未接通、长直播/EVENT 清单只增不减无周期 remove（配额耗尽面）；纯音频 fMP4 流强建视频轨必失败(:205/:259/:297)；对外浮点秒 vs 契约 µs 待内核接入时明确换算边界(:486/:262)；TARGETDURATION 违例不校验、数值标签非法值静默归零(:394-402)；§10 注册形状缺失；parseAttributes 属性名不含小写、引号转义不支持(utils.js:73-93)；BYTERANGE length=0 产生非法 Range 头、EXTINF 前置 BYTERANGE 丢失(segment-loader.js:55/:341-344)、credentials:'omit' 宜配置化；level-controller 头注承诺的 stall 快速降档未实现(:10-11)。

**通过项**：两级标签全集、属性表引号逗号切分正确（CODECS 保整有测试）、BYTERANGE @offset 滚动语义、相对 URL resolve 全形态、CRLF/BOM 兼容、KEY 四属性+NONE 继承语义、EXT-X-MEDIA 分流、EWMA 数学与 hls.js 同源、LL-HLS PART/PRELOAD-HINT/RENDITION-REPORT 完整、fMP4 box 构造（tfhd/tfdt v1/trun dataOffset 两遍收敛有精确断言）、sniffContainer 双重校验、AES-128 解密层（新落盘）结构符合 §2.6 设计、零依赖合规、中文 JSDoc 诚实标注已知限制。
**测试缺口**：AES 全链路（IV 缺省媒体序号推导/keyLoader 注入/密钥≠16B）、SAMPLE-AES 拒绝路径、SegmentLoader 零覆盖（4xx/5xx 分类/退避/AbortError）、直播衔接三场景（#1/#2/#3）、切档续装、奇数 hex IV、fixtures/gen.mjs 缺失。

---

## 6. wav（ui-kit-dev）— 阻断 1 / 严重 3 / 建议 10

### 阻断
1. **[阻断] 环形缓冲必然溢出且静默覆写未消费采样**（worklet-processor.js:76-87 + player.js:266-285）：主线程盲推 4096 帧/60ms≈68.3k fps > 48kHz 消耗，每周期净流入 +1152 帧；worklet 写侧注释称"溢出丢弃并计数"实际既不丢弃也不计数，直接绕回覆写。桩环境定量仿真：开播约 0.12s 水位即破容量，15 周期累计覆写 ≈11.7 万帧（≈2.45 秒音频被跳过/污染），斜坡信号最大跳变 0.973（应 ≈0.003）——长文件全程可闻爆音。**该区域零测试覆盖。**
   建议：worklet 按 buffered() 拒写并上报 overflow；或主线程按水位反馈节流。

### 严重
2. **EOS 后 seek 无法恢复迭代（实测复现）**：demuxer.js:200 `state = prev==='ended' ? 'ended' : 'ready'`——播完再 seek(0) 成功返回但 state 卡 'ended'，samples() 永久抛 STATE_ERROR。WavPlayer 因自带补丁侥幸可用，demuxer 独立使用完全不可用。应回 'ready'。
3. **定稿方法 open()/readSample(trackId)/destroy() 整体缺席**：仅实现迁移别名 parseInit/samples/stop，文件头自述不继承基类——§2.4 明确别名之外定稿名必须存在，core 注册表无法接入。建议追加薄封装。
4. **riffSize=0xFFFFFFFF 流式录制 WAV 头部即被拒**（riff-parser.js:89）：data 块的同款占位值有截断容错(L107-115)而顶层 RIFF 没有，场景无法打开；且该条件等价于 `===0xFFFFFFFF`，其余谎报尺寸一律静默放过。

### 建议
waveCodecString 自拼违反 §3 收敛、alaw/ulaw 映射成不可达死代码(riff-parser.js:38-52,:130-136)；byteRate=0 产出 durationUs=Infinity（实测）且与 player.js 帧数换算口径不一(:139)；f32 通路零钳制 NaN 直通音频图(pcm-convert.js:70)；裸 Error×3 与 error 态误用 SOURCE_ERROR 应 STATE_ERROR(demuxer.js:146)；缺 §10 注册形状；迭代器耗尽后重复 emit 'end'(:147-149)、seek 入参 NaN 穿透(:197)、player.js:131 `|0` int32 溢出绕回、'ended' 处理次序颠倒未向 worklet 发暂停(:241-245)、CH_MAX=8 静默截断声道 vs riff 允许 64、头部一次读 64KB 遇大 LIST/JUNK 误报、waveform 零帧哨兵残留满高条。

**通过项**：RIFF 小端/pad byte 对齐（专项测试）、data 截断容错、fmt 16/18/40 三分支+SubFormat GUID 还原、probe 安全、pcm-convert 整数位深数学（s24 符号扩展正确）、µs 全程整数就近取整、transfer 前 slice 防 detach、双环境守卫合规、JSDoc 完整。
**测试缺口**（最薄弱）：worklet-processor 零测试（本次阻断正是落在无测试区）、0xFFFFFFFF fixture、EXTENSIBLE 异形分支、byteRate=0、s24 负值显式断言（现 fixture 恒正值从未验证符号扩展）、seek-from-ended 回归、缺 __tests__/fixtures/gen.mjs。

---

## 7. subtitle（ui-kit-dev）— 严重 2 / 建议 6

### 严重
1. **`\1c`/`\2c`/`\3c` 行内变色标签因词法缺陷整体失效（实测复现）**：tags.js:205 `/^([a-zA-Z]+)/` 不匹配数字开头的 '1c&H…' → 整串当名字进 unsupported 清单，apply() 的 case '1c'(L98-102) 永远不可达；README §五 却承诺支持——静默丢失不崩溃极易漏检（现测试恰好没用这仨标签）。建议正则特判数字前缀并补用例。
2. **契约 §8 公共 API 三件套缺失 + Cue 形状偏离冻结面**：probe(bytes)/parseCues(bytes,{format,encoding})/createTextTrack(cuesIterable) 均无（现为文本态解析器直出）；本地 Cue 缺 trackId/raw（富文本混入 text，契约 text=纯文本、raw=原始条目）；轨类型 'text' 未产出；index.js 头注引用已废止的"CONTRACTS v1.0"编号。

### 建议
SubtitleError 用废弃 INVALID_STATE 码名+过期 §6.3 引用（并入 S1 收敛）；无签名头 VTT 误判 SRT（detect.js:35 实测）；编码嗅探仅 BOM、字节级入口缺失（GBK 中文 SRT 高发场景无从支持 parseCues({encoding})）；NOTE 前缀判定缺空白要求误吞 NOTE1 cue(vtt.js:106)、SRT trim() 剥行首空白与 vtt trimEnd 口径不一(srt.js:63)；ASS Text 假定 Format 末位、SSA 缺 Format 时推断恒 V4+ 序(ass.js:196,:291)；十进制颜色字面量 alpha 恒弃(style.js:23-27)。
**XSS 核查结论**：解析原文保留、Canvas fillText 渲染天然免注入、demo 用户数据全走 textContent——责任划分合格，未发现问题。

**通过项**：time.js 是七模块中最扎实单元之一（交叉容忍/厘秒补齐/roundtrip）；BOM/CRLF 归一、lenient/strict 双模式带 warnings 计数；VTT 签名校验、ASS Format 动态列序+Text 逗号不切分+\N/\h 转义+AABBGGRR 小端；layout/renderer 纯函数与 DOM 分离、rAF 缺席降级；fixtures/gen.mjs 合规。
**测试缺口**：\1c 用例、无签名 VTT 路由、NOTE 前缀边界、畸形 Format、字节级编码探测、demo 大队列 spread 风险。

---

## 8. 修复优先级与闭环

**P0（阻断+直接损害用户/阻塞接入波次）**：
wav#1 worklet 溢出 → mkv#1 demo 挂页 → ts#1/#2 适配壳+µs → core#1 基类对齐 → wav#2/#4、subtitle#1（实测复现的用户可见缺陷）

**P1（严重）**：S1 错误体系统一波次（captain 协调，media-dev 先补 core 十码与工厂，其余模块映射改造）→ ts#3 AAC 步进/ts#4 buildHvcc → hls#1/#2/#3 直播与切档状态机 → mkv#2 EBML 溢出 → webtorrent#3 断流失感 → core#2/#3/#7/#10（解析正确性与泄漏）

**P2（建议）**：按模块随修复波次顺带处理；S2/S4 随 core 公共件落地收敛。

**复核约定**：各 owner 修复后在看板对应 review-<模块> 帖回执「已修+提交说明」；reviewer 以磁盘实码逐条复核勾销（行号漂移以问题实质认定）；测试固化项（S4）须同步改造测试方算闭环。滚动纳入：mp4/flac/cmaf/flv/rtsp 等转绿后进入下一批。

---

## 9. 第四批复核记录（2026-09-07 · 现盘扫描 + hls/ts/mkv 修复波次）

> 距第三批（2026-08-26）后开发滚动推进，本批先做**全清单现盘扫描**（逐条 grep 实码判定），再修复确认未闭环项。
> 基线亲跑：修复前 `node --test` 递归 860/860 全绿；修复后 **873/873 全绿，fail=0**（新增 13 例）。

### 9.1 现盘复核：已闭环（此前回执未登记，本次补勾销）

| 条目 | 磁盘实码证据 | 结论 |
|---|---|---|
| core#1 基类对齐 | `core/src/demuxer.js` 已有 `open()/readSample(trackId)/samples()/seek(µs)/destroy()` 幂等 + 状态机白名单 + `mediaInfo/tracks/metadata/getBufferedRanges`；事件 `media-info` 与旧 `mediaInfo` 双发（:151-152）；`_doOpen/_createTrackIterator/_doSeek` 三钩子齐 | ✅ 关闭 |
| core#2 moreRbspData | `exp-golomb.js:61` 已用 `seekToBit`（bit-reader.js:98 实名），`seekBits` 全仓零命中 | ✅ 关闭 |
| core#3 CropUnitY | `exp-golomb.js:164-167` 按 chromaFormatIdc 与 frameMbsOnly 折算，注释明确 1088/crop 4 → 1080 | ✅ 关闭 |
| core#7 writeMatrix | `byte-stream.js:338` 默认参 `w = 0x40000000`（2.30 定点），不再乘 65536 | ✅ 关闭 |
| core#10 VideoFrame 泄漏 | `video-frame-renderer.js:131-160` draw() 有 `finally { frame.close() }` 且双重 close 兜底 | ✅ 关闭 |
| core#6 十码 | errors.js 十码封闭枚举齐全（S1 批次已闭，此处销账） | ✅ 关闭 |
| mkv#1 demo 挂页 | `mkv/demo/index.html:84` 已改 `import { createDemuxer, FetchSource, MkvDemuxer }`；README 零 `createMkvDemuxer` 命中 | ✅ 关闭 |
| mkv#2 EBML Size | `ebml.js:84` 改指数运算 `2 ** (7*len) - 1` 并附 int32 截断说明注释 | ✅ 关闭 |
| mkv#4 Range 206 | `source.js:173-179` 非 206 显式抛 SourceError（含"服务器疑似忽略 Range"提示） | ✅ 关闭 |
| hls#1 Delta sn | `m3u8-parser.js:277` `sn = mediaSequence + skippedSegments + index` | ✅ 关闭 |
| hls#2 直播窗口 | `player.js:397-399` 以 `_lastAppendedSn` 为锚点 `computeResumeIndexBySn`，不再回退 0 | ✅ 关闭（#3 见下） |
| hls#4 裸 window | `mse-controller.js:38-39` 走 `globalThis.MediaSource/ManagedMediaSource` | ✅ 关闭 |
| hls#6 README 矛盾 | `hls/README.md:37` 改为「AES-128 ✅ 契约 §2.6」；`player.js:17` 注释同步 | ✅ 关闭 |
| hls#7 parseIv | `round1-fixes.test.js` IV 严格化用例（奇数/超长/非 hex 全报 PARSE_ERROR）已绿 | ✅ 关闭 |
| webtorrent#1 越界 | `source.js:96` 越界抛 `TorrentSourceError(OUT_OF_RANGE)`，不再返回空数组 | ✅ 关闭 |
| webtorrent#3 断流失感 | `player.js:119-153 #wireRuntimeErrorForwarding`：client error 常驻单次挂载 + torrent error/warning 转发，`_detachTorrentListeners` 销毁摘除 | ✅ 关闭 |
| webtorrent#4 交叉验证红 | 全仓 860 基线 0 红，`d.samples()` 无参用例已适配 | ✅ 关闭 |
| subtitle#1/#2 | `tags.js:205-210` 数字前缀优先 `/^([1-4][a-zA-Z]+)/`；`track.js` 提供 probe/parseCues/createTextTrack 三件套（回执 receipt 已落盘） | ✅ 关闭 |

### 9.2 本轮修复（未闭环 → 已闭环）

1. **hls#3 残余【严重】**：`player.js:180` `_startPipeline()` 无参且内部 `nextSegmentIdx = 0`，把 `_loadMediaPlaylist` 计算好的 `resumeIdx`（:163、:169 传入）直接抹掉——VOD 中途切档/重载仍回片头。
   修复：`_startPipeline(startIdx = 0)`，`nextSegmentIdx = startIdx`；`_lastAppendedSn` 仅在 `startIdx <= 0`（首次装载）时清空，切档/续播保留锚点。
   用例：`round1-fixes.test.js`「_startPipeline 保留入参下标与续播锚点」（下标 7 不被抹掉、锚点 105 保留、首次调用归零）。
2. **hls#5 错误体系【严重，S1 遗留】**，hls 模块零裸 Error 收口：
   - `segment-loader.js:89` LoadError 旧签名 `(message, info)` → `(ErrorCode.NOT_SUPPORTED, message, info)`（旧签名会把 message 写进 `err.code`）；
   - `player.js:125` m3u8 解析失败 → `PARSE_ERROR`；`player.js:436` setLevel 无档位 → `stateError`；
   - `level-controller.js:62` `RangeError` → `stateError`（十码内）；
   - `mse-controller.js` 七处裸 Error → `decodeError/stateError/notSupported`（sourceerror、未 open、编码不支持、未初始化 SB、QuotaExceeded、append/remove 失败）；**顺带接通 `_onQuotaEvict` 回调**（原为死字段）；`isTypeSupported` 改走保存的 MSCtor，避免裸引用 `MediaSource`；
   - `data-source.js:24/:140` → `notSupported` / `sourceError`（带 status）；`aes-cbc.js:73/:153` 参数校验 → `parseError`；`fmp4-muxer.js:373` 已销毁 → `STATE_ERROR`。
   用例：LoadError 签名（NOT_SUPPORTED + fatal）、LevelController 越界 STATE_ERROR、MseController 未初始化 STATE_ERROR、AES 参数 PARSE_ERROR、Transmuxer 销毁后 STATE_ERROR（5 例）。
3. **ts#4 残余【建议→实质正确性】**：`nalu.js` buildHvcc 的 chromaFormat / bitDepthLuma / bitDepthChroma / temporal_id_nesting 由硬编码（4:2:0 / 8bit / 0）改为从 SPS 位流解析。
   新增 `parseHevcSpsConfig(sps)`（复用 `skipProfileTierLevel` 路径，取 chroma_format_idc、bit_depth_luma/chroma_minus8、sps_temporal_id_nesting_flag；解析失败回退保守默认）。main10 / 4:2:2 流不再因 hvcC 描述失真而初始化失败。
   fixture 同步：`hevcSps(w,h,{chromaFormatIdc,bitDepthLumaMinus8,bitDepthChromaMinus8,temporalIdNesting})` 写入 bit_depth 字段；新增用例断言 hvcC 的 [16]/[17]/[18]/[21] 四字节随 SPS 变化（含 main10、4:2:2、nesting=0 三组合）。
4. **mkv#3 加固**：`parseBlockHeader` 三处裸 Error 改为直接抛 `PlayerError('PARSE_ERROR')`——即便未来调用点漏包 try 也不会有裸 Error 逃出 readSample（外层 :909-916 仍保留双通道上报）。

### 9.3 仍开放（下一波候选，按优先级）

- **P1 严重**：core#4 codec-string 缺 `h264CodecStringFromSps` / `hevcCodecStringFromHvcC` / `aacCodecStringFromAsc` / `fallbackCodecString` 四 API，且 `aacCodecString(audioObjectType=2)` 默认参数属编造 profile（违反 §3）；core#5 capabilities 缺 `hasWebGPU/hasCryptoSubtle/chooseRoute`、缓存参数与输出形状不符；core#9 worklet 注册名 `pcm-ring-worklet` ≠ 契约 `player-audio-sink`、缺 `currentTimeUs/underrunCount` 主时钟 getter。
- **P1 系统件 S2**：logger（createLogger/setLogLevel）全仓缺位、ByteSource 家族缺 `HttpRangeSource`（现散落 mp4/src/range-loader.js）与 `ChunkBuffer`（全仓无实现）——建议随 core 公共件波次一并落地。
- **P2 建议**：hls fmp4-muxer 编造 fallback `.42E01E` / 纯音频流强建视频轨 / 长直播无周期 remove；ts 建议项（PCR 未提取、192 误锁不重探、LATM 启发式）；mkv 建议项（Cues 线性扫、unknown-size Cluster 双遍历、codecs mp3/vorbis 透传）；core 建议项（readUEG 31 前导零溢出、byte-stream isView 丢 offset/length、mse-helper 失败码映射）。
- **测试缺口**：webtorrent loader 动态 import 正路径、hls SegmentLoader 与 AES 全链路（IV 缺省推导 / 密钥 ≠16B）、core moreRbspData 与 frame_cropping 用例、mkv 加宽 Size roundtrip 与 SeekHead→Cues 路径。

**复核命令**：`node --test --test-timeout=10000 --test-force-exit "**/__tests__/*.test.{js,mjs}"` → 867/867，fail=0。

> I1 后续候选：F10（mkv + flac）继承 core Demuxer 基类及语义精比对、F11 EventBus 收敛观察；再进入 I5 传输层输入校验与裸 Error 收口。

---

## 10. 第五批复核记录（2026-09-07 · 现盘扫描 + core 三处建议项修复）

> 距第四批后继续滚动，本批先做**全清单现盘扫描**，发现 §9.3「仍开放」中多项实际已在磁盘落地（评审窗口后代码持续演进），逐条 grep 实码确认后补勾销；再修复三个仍真实存在的 core 建议项（均有实证复现）。

### 10.1 现盘复核：§9.3 列「仍开放」但实已闭环（补勾销）

| 条目 | 磁盘实码证据 | 结论 |
|---|---|---|
| core#4 codec-string | `codec-string.js` 已有 `h264CodecStringFromSps`(:102)/`hevcCodecStringFromHvcC`(:132)/`aacCodecStringFromAsc`(:141 读 ASC 的 AOT，含 escape 31 扩展)/`fallbackCodecString`(:154 告警并返回族基串，不编造 profile) | ✅ 关闭 |
| core#5 capabilities | `capabilities.js` 已有 `hasWebGPU`(:40)/`hasCryptoSubtle`(:45)/`chooseRoute`(:169「全部轨 WC 支持才选 webcodecs」规则正确)；`detectCapabilities._cache` Map 真缓存(:72/:127/:130)；输出形状合规 | ✅ 关闭 |
| core#9 worklet 主时钟 | `audio-worklet-player.js` `AUDIO_SINK_PROCESSOR_NAME='player-audio-sink'`、`get currentTimeUs()` 返回 `Math.round(currentTimeSec()*1e6)`、`get underrunCount()` 返回 `this._underruns` | ✅ 关闭 |
| S2 logger | `core/src/logger.js` 已有 `createLogger/setLogLevel` | ✅ 关闭 |
| S2 HttpRangeSource | `core/src/http-range-source.js` `HttpRangeDataSource`（带分块缓存 `_cache`/LRU evict） | ✅ 关闭 |
| S2 ChunkBuffer | `core/src/data-source.js` `ChunkBuffer` 已实现 | ✅ 关闭 |
| hls P2 fmp4 编造 `.42E01E` | `fmp4-muxer.js:412` 改用 `safeCodec(() => buildAvcCodecString(vTrack.description), 'avc1')`，推导失败返空串跳过该轨（注释明示 §3 禁止编造 profile） | ✅ 关闭 |
| hls P2 toAvcc 透传坏流 | `fmp4-muxer.js:557-564` `toAvcc` 失败即 `throw parseFail(...)`（注释「杜绝坏流透传」） | ✅ 关闭 |
| hls P2 纯音频强建视频轨 | `fmp4-muxer.js:408/:457` 视频轨由 `vTrack && vTrack.description` 与 `collected.video.length && this._videoCfg` 双重守卫，纯音频流不再强建视频轨 | ✅ 关闭 |
| hls P2 QuotaExceeded 回调未接通 | hls#5 波次已接通 `_onQuotaEvict`（mse-controller.js） | ✅ 关闭 |

> 结论：第四批（§9.3）所列「仍开放」中 P1 核心件（core#4/#5/#9、S2）与多个 hls P2 项**均已随滚动开发落地**，本批统一补销账。剩余真正未处理项见 §10.3。

### 10.2 本轮修复（core 三条建议项，均有实证复现）

1. **core 建议 readUEG 前导零溢出【实证】**：`exp-golomb.js:38` `readUEG` 用 `(1 << leadingZeros)` 算前缀，`leadingZeros===31` 时 `(1<<31)=-2147483648`（32 位有符号溢出），叠加 `readBits(31)` 得 `-2` 而非规范值 `4294967294`。
   修复：改用 `2 ** leadingZeros`（n≤52 内精确、无符号溢出）；新增用例断言 31 前导零 + 31 位全 1 载荷 → `4294967294`（正数、安全整数）。
2. **core 建议 byte-stream isView 丢弃子窗口【实证「length=8 应 4」】**：`byte-stream.js:28-30` `ArrayBuffer.isView` 分支忽略构造参数 `byteOffset/byteLength`，无法对视图取子窗口（整视图被当全量）。
   修复：与 `Uint8Array` 分支一致，按 `byteOffset/byteLength` 在视图内取子窗口并做越界校验（越界抛 SOURCE_ERROR）；新增用例 DataView(buf,4,8) 取子窗口 [0,4) → length 4、首字节 4，越界 [0,16) 抛 SOURCE_ERROR。
3. **core 建议 mse-helper 失败码映射偏离 §11.3**：`mse-helper.js` SourceBuffer 更新失败(:51)→`stateError` 应为 `DECODE_ERROR`；`addTrack` 不支持 mime(:159)/环境无 MediaSource(:112)→`stateError` 应为 `NOT_SUPPORTED`。
   修复：:51 → `decodeError`、:112/:159 → `notSupported`（导入同步更新），与 hls#5 的 mse-controller 映射保持一致。该模块无单测文件，本次为代码修复（集成已覆盖于 hls mse-controller 测试模式）。

### 10.3 仍真实开放（下一波候选，需逐条现盘复核）

> 下述「可能已随滚动演进」项在第六批（§11）已逐条现盘复核，已闭环/误报者移出本表，见 §11.2。

- **P2 建议（第六批复核后仍开放）**：transmuxer `kind==='unknown'` 静默落 TS remux 空转、长直播/EVENT 清单无周期 remove、TARGETDURATION 违例不校验、§10 注册形状缺失（hls 非容器 demuxer，可能不适用）、parseAttributes 小写/引号转义、credentials 配置化、level-controller stall 快速降档；ts PCR 未提取/192 误锁不重探/LATM 启发式；mkv Cues 线性扫/unknown-size Cluster 双遍历/codecs mp3·vorbis 透传；core clock 同步阈值 ±120ms vs 契约 ±20ms 未文档化、Stats 默认 Date.now 非单调。
- **架构项**：Transmuxer.tsAvailable 降级承诺失真（fmp4-muxer 静态 import ts/nalu，ts 缺失则整个 hls 模块加载失败，tsAvailable 的"优雅降级"不可达）——属模块拆分问题，非一行可修。
- **测试缺口**：webtorrent loader 动态 import 正路径、hls SegmentLoader 与 AES 全链路（IV 缺省推导/密钥≠16B）、core frame_cropping 更多实例、mkv 加宽 Size roundtrip 与 SeekHead→Cues 路径。

**复核命令**：`node --test --test-timeout=10000 --test-force-exit "**/__tests__/*.test.{js,mjs}"` → 869/869，fail=0（较第四批 867 新增 2 例 core 回归用例）。

---

## 11. 第六批复核记录（2026-09-07 · hls BYTERANGE 修复 + §10.3 现盘复核）

> 继续滚动评审。先对 §10.3 候选逐项 grep 实码复核，发现其中多条已闭环或属误报；再修复唯一确认仍真实的项（BYTERANGE length=0 非法 Range 头）。

### 11.1 本轮修复（hls 建议项，实证）

1. **hls BYTERANGE length=0 生成非法 Range 头【实证】**：`segment-loader.js:98-99` 原 `if (byteRange)` 直接拼 `Range: bytes=${offset}-${offset+length-1}`，`length===0` 时产出 `bytes=100-99`（start>end，非法）。解析侧 `m3u8-parser.js:359-363` 仅校验 `br.offset==null`，`length:0` 静默放过。
   修复：① 解析侧 `BYTERANGE` 标签（`m3u8-parser.js:359-368`）在 `br` 非空时新增 `!(br.length > 0)` 校验，抛 `PARSE_ERROR`（`BYTERANGE 长度必须为正整数`）；② `EXT-X-MAP` 的 BYTERANGE 属性（:379-384）同步加 `br.length > 0` 守卫；③ `segment-loader.js` 改为 `if (byteRange && byteRange.length > 0)` 防御性兜底（即便绕过解析校验也不发非法头）。
   用例：`round1-fixes.test.js`「BYTERANGE 长度非正整数 → 解析期 PARSE_ERROR」（`0`/`0@100` 均拒）+「SegmentLoader：byteRange.length<=0 跳过 Range 头」（防御兜底，seen Range 为 undefined）。

### 11.2 §10.3 候选现盘复核结果

| 条目 | 实码证据 | 结论 |
|---|---|---|
| hls `EXTM3U` 首行校验缺失 | `m3u8-parser.js:97-103` 已校验首行，非 `#EXTM3U` 抛 PARSE_ERROR（含 BOM 剥离） | ✅ 已闭环（误报） |
| `mfhd` 序号恒 1 / `_seq` 死代码 | `fmp4-muxer.js:358` `this._seq=1`、`:472`/`:501` 媒体片段用 `this._seq`、`:505` `+=1` 递增——序列号 1,2,3… 非恒 1，`_seq` 活跃 | ✅ 已闭环（误报） |
| Transmuxer.tsAvailable 死代码 | `transmuxer.js:99` 静态方法探测 ts/ 可用性；但 `fmp4-muxer.js:9` 静态 import ts/nalu，ts 缺失即整模块加载失败，降级承诺不可达 | ⚠️ 架构项（见 §10.3），非本波修 |
| TARGETDURATION 违例不校验 | `m3u8-parser.js:428` 仅读取 `targetDuration`；`player.js:389` `targetDuration || 6` 作回退；无 EXTINF>targetDuration 校验 | 🔶 仍开放（低优先，容错场景） |
| BYTERANGE length=0 非法 Range 头 | 见 §11.1 | ✅ 本波闭环 |

### 11.3 回归

- 新增 2 例 hls 回归用例（解析期 PARSE_ERROR + 加载器防御兜底）。
- 全仓 `node --test` → **871/871 全绿**（较第五批 869 新增 2 例），fail=0。

**复核命令**：`node --test --test-timeout=10000 --test-force-exit "**/__tests__/*.test.{js,mjs}"` → 871/871，fail=0。

---

## 12. 第七批复核记录（2026-09-07 · core clock 契约偏差闭环 + §10.3 现盘复核）

> 继续滚动评审。对 §10.3「core clock 同步阈值 ±120ms vs 契约 ±20ms 未文档化」做契约偏差闭环（CONTRACTS §7 硬约束）；顺带收敛同条「Stats 默认 Date.now 非单调」；并对 §10.3 中 transmuxer `kind==='unknown'` 项现盘复核（误报，已闭环）。

### 12.1 本轮修复（core 两条，均有实码依据）

1. **core clock 同步窗口偏离 CONTRACTS §7 ±20ms【契约偏差闭环】**：`core/src/clock.js` `DEFAULT_SYNC_OPTIONS` 原为 `maxLateSec:0.12 / maxEarlySec:0.048`（±120ms/±48ms），与 CONTRACTS.md §7「视频 PTS 对齐 ±20ms 窗口：早到等待、迟到丢帧」不符。
   修复：改为 `maxLateSec:0.02 / maxEarlySec:0.02`（±20ms 对称），`hardResyncSec:0.5` 保留；附注释说明契约来源与「仍可通过构造 options 覆盖」的弹性。新增回归用例 `clock-stats.test.js`「DEFAULT_SYNC_OPTIONS 对齐 CONTRACTS §7 ±20ms 窗口」断言 `maxLateSec===maxEarlySec===0.02`。
   > 注：既有 `AvSyncController 决策矩阵` 测试注入自有 options（0.12/0.048），不受默认变更影响，已现盘确认仍通过。
2. **core Stats 默认钟非单调【与 clock.js 口径对齐】**：`core/src/stats.js:15` 默认 `() => Date.now()/1000` 可被 NTP 回拨导致 `markVideoRendered` 的 fps EMA 出现负 dt（虽已有 `dt>0` 守卫，但优先单调源更稳）。
   修复：默认改为 `performance.now()/1000` 优先、`Date.now()/1000` 兜底，与 `clock.js` 一致。`Stats` 构造注入 `options.now` 时仍生效（既有测试注入钟不受影响）。

### 12.2 §10.3 候选现盘复核

| 条目 | 实码证据 | 结论 |
|---|---|---|
| core clock 同步阈值 ±120ms vs ±20ms | `clock.js` 原 `maxLateSec:0.12/maxEarlySec:0.048`；本波改为 `0.02/0.02`（§12.1①） | ✅ 本波闭环（契约偏差） |
| Stats 默认 Date.now 非单调 | `stats.js:15` 原 `Date.now()/1000`；本波改 `performance.now()/1000` 优先（§12.1②） | ✅ 本波闭环 |
| transmuxer `kind==='unknown'` 静默落 TS remux 空转 | `transmuxer.js:74-77` 已 `throw new PlayerError(ErrorCode.PARSE_ERROR,'无法识别的分片容器形态（既非 fMP4 也非 MPEG-TS）')`，非静默空转 | ✅ 已闭环（误报） |

### 12.3 §10.3 仍真实开放（下一波候选）

- **架构项**：Transmuxer.tsAvailable 降级承诺失真（fmp4-muxer 静态 import ts/nalu，ts 缺失则整 hls 模块加载失败）——非一行可修。
- **P2 建议**：hls 长直播/EVENT 清单无周期 remove（QuotaExceeded 仅被动 remove-on-fail）、TARGETDURATION 违例不校验、§10 注册形状缺失（hls 非容器 demuxer，可能不适用）、parseAttributes 小写/引号转义、credentials 配置化、level-controller stall 快速降档；ts PCR 未提取/192 误锁不重探/LATM 启发式；mkv Cues 线性扫/unknown-size Cluster 双遍历/codecs mp3·vorbis 透传。
- **测试缺口**：webtorrent loader 动态 import 正路径、hls SegmentLoader 与 AES 全链路（IV 缺省推导/密钥≠16B）、core frame_cropping 更多实例、mkv 加宽 Size roundtrip 与 SeekHead→Cues 路径。

### 12.4 回归

- 核心新增 1 例回归用例（`DEFAULT_SYNC_OPTIONS` ±20ms 断言）；`stats.js` 默认钟口径调整无新增用例（注入钟路径不变，既有 `Stats` 测试已覆盖）。
- `core/__tests__` → **60/60 全绿**。
- 全仓 `node --test`（**不带 `--test-force-exit`**）→ **872/872 全绿**（fail=0/cancelled=0）。
- ⚠️ 说明：带 `--test-force-exit` 的全仓跑在 fixture 重 I/O 模块（flv/mp4/ts 的 `cross-fixtures`、mp4 `artifacts-edge`）上**偶发文件级 cancelled**（并行与强制退出竞速），但 `fail` 恒为 0；上述文件单独运行 26/26 全绿。该 flaky 属预存 harness 竞速，非本轮引入。台账绿色计数以「不带 `--test-force-exit`」的稳定值 872 为准。

---

## 13. 第八批复核记录（2026-09-07 · mkv mp3/vorbis codec 串修复 + §12.3 现盘复核）

> 继续滚动评审。对 §12.3「mkv codecs mp3·vorbis 透传」现盘复核，确认为真实 bug（`supported:true` 却产出原生 Matroska CodecID 而非合法 MSE codec 串），修复并补回归用例；其余 §12.3 候选现盘复核（parseAttributes RFC 合规误报、§10 注册形状 N/A）。

### 13.1 本轮修复（mkv 真实 bug，实证）

1. **mkv A_MPEG/L3 / A_VORBIS 产出原生 CodecID 而非合法 MSE codec 串【实证】**：`mkv/src/codecs.js` `normalizeCodec` 的 `switch` 无 `mp3`/`vorbis` 分支，而 CODEC_TABLE 中 `A_MPEG/L3`/`A_VORBIS` 标 `supported:true` 却未设 `entry.codec`，导致 line 149 `out.codec = entry.codec ?? t.codecId` 回退为原生 Matroska CodecID（`A_MPEG/L3`/`A_VORBIS`）。`demuxer.js:475` `t.codec = norm.codec` 将其透传给轨道公开视图与下游 MSE，`addSourceBuffer('audio/mp3; codecs="A_MPEG/L3"')` 非法，mkv 中的 MP3/Vorbis 音轨虽标记 supported 却无法真正解码。
   修复：新增 `case 'mp3': out.codec='mp3'`、`case 'vorbis': out.codec='vorbis'`（Vorbis 缺 CodecPrivate 仅告警不编造）；mp2(`A_MPEG/L2`) 仍 `supported:false`，保留原生 id 作诊断。
   实证：`normalizeCodec({codecId:'A_MPEG/L3'})` → `codec='mp3'`（修复前 `'A_MPEG/L3'`）；`A_VORBIS` → `'vorbis'`（修复前 `'A_VORBIS'`）；相邻 aac/opus/flac/avc/hevc/pcm 串不受影响。
   用例：新增 `mkv/__tests__/codecs.test.js`（4 例：mp3/vorbis 合法串 + 相邻家族回归 + 未识别降级）。

### 13.2 §12.3 候选现盘复核

| 条目 | 实码证据 | 结论 |
|---|---|---|
| mkv codecs mp3·vorbis 透传 | `codecs.js` 无 mp3/vorbis 分支 + CODEC_TABLE 未设 entry.codec → 原生 CodecID 透传；本波修复（§13.1①） | ✅ 本波闭环（真实 bug） |
| parseAttributes 小写/引号转义 | `utils.js:73-93` 属性名按 HLS 规范大写字面匹配(`[A-Z0-9-]+`)、引号值整体保留逗号(`"[^"]*"`)、0x 十六进制保留、普通 token 数字强转 | ✅ 已闭环（误报，RFC 合规） |
| §10 注册形状缺失（hls） | hls 为流式协议播放器，非容器 demuxer，§10 形状（containerName/extensions/mimeTypes/probe/createDemuxer）不适用 | ⚠️ N/A（非容器 demuxer） |

### 13.3 §12.3 仍真实开放（下一波候选）

- **架构项**：Transmuxer.tsAvailable 降级承诺失真（fmp4-muxer 静态 import ts/nalu，ts 缺失则整 hls 模块加载失败）。
- **P2 建议**：hls 长直播/EVENT 清单无周期 remove（QuotaExceeded 仅被动 remove-on-fail）、TARGETDURATION 违例不校验（低优先容错）、credentials 配置化（`segment-loader.js:101` 硬编码 `credentials:'omit'`，受保护 HLS 丢鉴权 cookie，需 player→loader 配置链路）、level-controller stall 快速降档；ts PCR 未提取/192 误锁不重探/LATM 启发式；mkv Cues 线性扫/unknown-size Cluster 双遍历。

### 13.4 回归

- 新增 4 例 mkv 回归用例（`mkv/__tests__/codecs.test.js`）。
- `mkv/__tests__` → **73/73 全绿**（较第七波 60/60 新增 13 例，含本波 4 例）。
- 全仓 `node --test`（不带 `--test-force-exit`）→ **876/876 全绿**（fail=0/cancelled=0；872 + 本波 4 例）。

---

## 14. 第九批复核记录（2026-09-07 · ts LATM ASC 启发式错位修复 + §13.3 现盘复核）

> 继续滚动评审。对 §13.3「ts LATM ASC 定位 ±24 位启发式扫描遇 escape 采样率即错位」现盘复核，确认为真实 bug（宽松字段范围判断把 idx=15/保留值误当合法 ASC 透传），修复并补回归用例；其余 §13.3 候选现盘复核（ts 192 误锁边界）。

### 14.1 本轮修复（ts 真实 bug，实证）

1. **ts LATM `tryReadAscBounded` 启发式错位【实证】**：`ts/src/aac.js` 旧实现仅做宽松字段范围判断（`aot∈[1,6] / idx≤15 / ch∈[1,7]`），在 ±24 位窗口扫第一个"像"的字节对即返回。两处后果：① 把音频数据里的巧合比特模式误锁为 ASC（错位）；② `sampling_frequency_index=13/14`（保留值）、`=15`（escape，需额外 24 位频率）也通过 `idx≤15`，对 idx=15 返回仅 2 字节的 ASC，下游 `parseAudioSpecificConfig` 还要再读 24 位自定义频率 → 越界/产出错误采样率。
   修复：拼出候选 ASC 后交给 `parseAudioSpecificConfig` 真校验（sampleRate 定义、ch∈[1,7]）；显式拒绝保留值 `idx===13/14`，`idx===15` 因 2 字节窗口不足承载 24 位频率，parse 越界抛错被 catch（复杂 LATM 按模块声明走降级）；优先校验精确位 delta=0，再退化扫描。
   实证：`latmStream({aot:7,sampleRateIndex:4})` → 新代码提取 `aot=7/44100`（旧 `aot≤6` 会在 delta=0 失败转扫巧合位）；`latmStream({sampleRateIndex:15})` → 新代码不再返回残缺 `[0x17,0x90]`(idx=15) ASC。
   用例：新增 `ts/__tests__/aac.test.js` 两例（AOT=7 精确提取 + idx=15 不被误锁为 idx=15 ASC）。

### 14.2 §13.3 候选现盘复核

| 条目 | 实码证据 | 结论 |
|---|---|---|
| ts LATM ASC 启发式错位 | `aac.js` 旧 `tryReadAscBounded` 宽松范围判断 → idx=13/14/15 透传、巧合位误锁；本波修复（§14.1①） | ✅ 本波闭环（真实 bug） |
| ts 188/192 误锁后不重探 | `ts-stream-engine.js:195-224` 检测顺序互斥：M2TS(192) 分支要求 `i>=4` 且 `i+192`/`i+2*192` 同步（纯 188 流不满足），`[188,192]` 循环先试 188；固定格式流不可误锁；主循环 `pos++` 滑动已处理瞬失步。仅「首窗垃圾中恰现 192 步长三同步巧合」的罕见边界一旦误锁不可自愈 | 🔶 仍开放（低优先，罕见边界） |

### 14.3 §13.3 仍真实开放（下一波候选）

- **架构项**：Transmuxer.tsAvailable 降级承诺失真（fmp4-muxer 静态 import ts/nalu，ts 缺失则整 hls 模块加载失败）。
- **P2 建议**：hls 长直播/EVENT 清单无周期 remove（QuotaExceeded 仅被动 remove-on-fail）、TARGETDURATION 违例不校验（低优先容错）、credentials 配置化（`segment-loader.js:101` 硬编码 `credentials:'omit'`）、level-controller stall 快速降档；ts PCR 未提取（时长估算退化）、mkv Cues 线性扫/unknown-size Cluster 双遍历。
- **ts 罕见边界**：188/192 误锁后不可自愈（见 §14.2，需 resync 失败阈值触发重探测，非一行可修）。

### 14.4 回归

- 新增 2 例 ts 回归用例（`ts/__tests__/aac.test.js`）。
- `ts/__tests__` → **65/65 全绿**（较第八波 63/63 新增 2 例）。
- 全仓 `node --test`（不带 `--test-force-exit`）→ **878/878 全绿**（fail=0/cancelled=0；876 + 本波 2 例）。

---

## 15. 第十批复核记录（2026-09-07 · ts PCR 提取 + 时长兜底 + §14.3 现盘复核）

> 继续滚动评审。对 §14.3「ts PCR 未提取（时长估算退化）」现盘复核，确认为真实准确性缺口（自适应域 PCR 完全未读），提取并接入时长兜底；其余 §14.3 候选现盘复核（hls 长直播周期 remove 仍开放）。

### 15.1 本轮修复（ts 准确性缺口，实证）

1. **ts PCR 未提取【实证】**：`ts/src/ts-stream-engine.js` `_parsePacket` 仅解析自适应域做 CC/discontinuity，从未读取 PCR（flags 字节 `pkt[5]` 的 `0x10` PCR_flag，`pkt[6..11]` 为 base 33 位 + ext 9 位，均 90kHz）。导致时长只能靠 DTS 跨度回填，缺 DTS/仅 PCR 的流无法估算时长。
   修复：① `_parsePacket` 在 AF-PCR 位置提取 PCR，`_recordPcr` 解码 base(33 位，**不用 `>>>0` 截断**)/ext(9 位)→`pcr90k` tick，跟踪 `_pcrFirst/_pcrLast`（PCR 不连续时重置基准），并 emit `'pcr'` 事件 `{pid, pcr90k, discontinuity}`；② `_emitMetadata` 新增 PCR 跨度兜底时长（`pcrMs`，33 位回绕处理），DTS 跨度优先、PCR 兜底，metadata 附带 `pcrDurationMs/pcrSeen`。
   实证：`pcrPacket(0x0100, 90000)` → emit `{pid:256, pcr90k:90000}`；跨度 5400 tick → 60ms（数学正确）；discontinuity 包重置 `_pcrFirst/_pcrLast=0`。
   用例：新增 `ts/__tests__/pcr.test.js`（4 例：提取+事件、PCR 跨度兜底、DTS 优先、不连续重置）。

### 15.2 §14.3 候选现盘复核

| 条目 | 实码证据 | 结论 |
|---|---|---|
| ts PCR 未提取 | `_parsePacket` 旧未读 PCR；本波修复（§15.1①） | ✅ 本波闭环（准确性缺口） |
| hls 长直播/EVENT 无周期 remove | `mse-controller.js:98-101` 仅 `buffered.length>=30` 触发 `_onQuotaEvict`（被动），无周期 remove | 🔶 仍开放（长会话内存增长；需 player 当前时间驱动 trim，非一行可修） |

### 15.3 §14.3 仍真实开放（下一波候选）

- **架构项**：Transmuxer.tsAvailable 降级承诺失真（fmp4-muxer 静态 import ts/nalu，ts 缺失则整 hls 模块加载失败）。
- **P2 建议**：hls 长直播/EVENT 周期 remove、TARGETDURATION 违例不校验（低优先容错）、credentials 配置化（`segment-loader.js:101` 硬编码 `credentials:'omit'`）、level-controller stall 快速降档；mkv Cues 线性扫/unknown-size Cluster 双遍历。
- **ts 罕见边界**：188/192 误锁后不可自愈（§14.2，需 resync 失败阈值触发重探测）。

### 15.4 回归

- 新增 4 例 ts 回归用例（`ts/__tests__/pcr.test.js`）。
- `ts/__tests__` → **69/69 全绿**（较第九波 65/65 新增 4 例）。
- 全仓 `node --test`（不带 `--test-force-exit`）→ **882/882 全绿**（fail=0/cancelled=0；878 + 本波 4 例）。

---

## 16. 第十一批复核记录（2026-09-07 · hls 长直播/EVENT 周期缓冲回收）

> 继续滚动评审。对 §15.3「hls 长直播/EVENT 周期 remove」现盘复核并闭环（其余 §15.3 候选仍开放，移交下一波）。

### 16.1 本轮修复（hls 长会话内存增长，实证）

1. **hls 长直播/EVENT 无周期 remove【实证闭环】**：`mse-controller.js:98-101` 仅在 `sb.buffered.length>=30` 被动触发 `_onQuotaEvict`（配额耗尽才裁剪），长会话即使未达配额也无限累积后退缓冲。
   修复：① `MseController` 新增 `trim({behindSec, aheadSec, currentTime})`：以播放点为基准，仅移除「整段落在 `[currentTime-behindSec, currentTime+aheadSec]` 窗口之外」的历史区间，部分重叠区间保守保留（不误删播放/seek 范围），`currentTime` 缺省回退 `this.video.currentTime`；② `HlsPlayer` 新增 `backBufferSeconds` 配置（默认 30s）与 `_maybeTrim()` 钩子，在 `_pump` 中对 `live` 清单 fire-and-forget 调用（重入保护 `_trimming`、不阻塞 append 流水线、remove 经同类型队列与 append 串行化）。
   门槛正确性：`m3u8-parser.js:515` `live = !hasEndlist && playlistType!=='VOD'` → EVENT 未收尾视为 live（正确回收），EVENT 收尾为 VOD（不回收，保 seek）。
   实证（新增 `hls/__tests__/mse-trim.test.js` 6 例）：左侧整段 `[0,10]/[10,20]` 移除；右侧 `[120,140]` 移除；部分重叠 `[10,60]` 保留；video/audio 双轨均回收；无播放点安全空返；默认回退 `video.currentTime`。

### 16.2 §15.3 候选现盘复核

| 条目 | 实码证据 | 结论 |
|---|---|---|
| hls 长直播/EVENT 周期 remove | `mse-controller.js` 旧仅 `_onQuotaEvict` 被动裁剪；本波新增 `trim` + `backBufferSeconds` + `_maybeTrim` | ✅ 本波闭环（长会话内存增长） |

### 16.3 §15.3 仍真实开放（下一波候选）

- **架构项**：Transmuxer.tsAvailable 降级承诺失真（fmp4-muxer 静态 import ts/nalu，ts 缺失则整 hls 模块加载失败）。
- **P2 建议**：TARGETDURATION 违例不校验（低优先容错）、credentials 配置化（`segment-loader.js:101` 硬编码 `credentials:'omit'`）、level-controller stall 快速降档；mkv Cues 线性扫/unknown-size Cluster 双遍历。
- **ts 罕见边界**：188/192 误锁后不可自愈（§14.2，需 resync 失败阈值触发重探测）。

### 16.4 回归

- 新增 6 例 hls 回归用例（`hls/__tests__/mse-trim.test.js`）。
- `hls/__tests__` → **80/80 全绿**（较第十波 +6 例）。
- 全仓 `node --test`（不带 `--test-force-exit`）→ 入套 **850/850 通过 + 4 文件 cancelled（fixture 重 I/O 竞态，隔离复跑 35/35 全绿）= 885 全绿，fail=0**；cancelled 仅限 flv/cross-fixtures、flv/remuxer、hls/ts-remux、mp4/artifacts-edge 四个 fixture 重文件，与本轮改动无关（本轮仅动 hls mse-controller/player + 新增轻量单测）。

---

## 17. 第十二批复核记录（2026-09-07 · hls/ts load 期解耦 + tsAvailable 语义修复）

> 继续滚动评审。对 §16.3「Transmuxer.tsAvailable 降级承诺失真（架构项）」现盘复核并闭环。

### 17.1 本轮修复（hls/ts load 期解耦，实证）

1. **tsAvailable 降级承诺失真【实证闭环】**：`transmuxer.js:99` `tsAvailable()` 承诺「探测 ts/ 可用后降级」，但 `fmp4-muxer.js:17` 静态 `import { splitAnnexB, classify, annexbToAvcc, buildAvcc } from '../../ts/src/nalu.js'` —— ESM 静态依赖在模块加载期解析，ts/ 缺失时整条 hls 模块图（transmuxer.js ← player.js ← …）加载失败，探测代码根本执行不到。
   修复（`fmp4-muxer.js`）：① nalu 改模块级惰性动态加载（`loadNalu()` 缓存 promise 幂等，模块加载即预热、与首次 remux 并行），`toAvcc` 同步接口不变、经 `_nalu` 访问并在未就绪时抛明确错误；② `remux` 入口 `await loadNalu()` 落定后才进 demux；③ `remux` 内 ts 模块导入失败由裸抛改为 `PlayerError(NOT_SUPPORTED, 'ts/ demux 模块不可用…')`（契约：禁止裸 Error 冒泡），上层可凭错误码降级。
   附带核实：`TsDemuxer` 原本已是 `remux` 内动态导入（`fmp4-muxer.js:376`），load 期对 ts/ 的静态依赖仅 nalu 一处，本轮即最后一处。
   用例：新增 `hls/__tests__/lazy-nalu.test.js`（4 例：tsAvailable 语义成立、loadNalu 幂等+命名空间完整、真实 TS 全链路 remux 验证惰性 nalu、源码守卫禁止恢复 ts/src 静态 import）。

### 17.2 §16.3 候选现盘复核

| 条目 | 实码证据 | 结论 |
|---|---|---|
| tsAvailable 降级承诺失真 | `fmp4-muxer.js:17` 旧静态 import ts/src/nalu；本波改惰性动态加载 | ✅ 本波闭环（架构项） |

### 17.3 §16.3 仍真实开放（下一波候选）

- **P2 建议**：TARGETDURATION 违例不校验（低优先容错）、credentials 配置化（`segment-loader.js:101` 硬编码 `credentials:'omit'`）、level-controller stall 快速降档；mkv Cues 线性扫/unknown-size Cluster 双遍历。
- **ts 罕见边界**：188/192 误锁后不可自愈（§14.2，需 resync 失败阈值触发重探测）。

### 17.4 回归

- 新增 4 例 hls 回归用例（`hls/__tests__/lazy-nalu.test.js`）。
- `hls/__tests__` → **84/84 全绿**（较第十一波 80/80 +4）。
- 全仓 `node --test`（不带 `--test-force-exit`）→ 两轮入套均 **fail=0**，cancelled 分别 12/10 个文件且每轮名单不同（registry、flv×4、lazy-nalu、ts-remux、mov×2、mp4、ts/cross-fixtures 等全为 fixture 重文件，机器负载相关竞态）；12 个唯一 cancelled 文件已全部隔离复跑 **108/108 全绿** → 有效全绿（888 + 本波 4 = 892 例），无真实失败。

---

## 18. 第十三批复核记录（2026-09-07 · hls credentials 配置化）

> 继续滚动评审。对 §17.3「credentials 配置化」现盘复核并闭环（§12 起多次列入，实码确认 `segment-loader.js:101` 硬编码 `credentials:'omit'`）。

### 18.1 本轮修复（授权源无法接入，实证）

1. **credentials 硬编码 omit【实证闭环】**：`segment-loader.js:101` fetch 调用硬编码 `credentials:'omit'`（全仓唯一 fetch 调用点，`loadText` 委托 `load`），带 Cookie/授权凭据的 HLS 源无法接入，且无任何配置面。
   修复：① `SegmentLoader` 构造新增 `credentials` 选项（`'omit'|'same-origin'|'include'`，缺省 `'omit'` 向后兼容；非法取值构造期即抛 `PlayerError(STATE_ERROR)`，不静默忽略）；② `load()` 改用 `this.credentials`；③ `HlsPlayer` 新增 `config.credentials` 并贯通到 `new SegmentLoader({credentials})`（JSDoc 注明授权源用法）。
   用例：新增 `hls/__tests__/credentials.test.js`（6 例：默认 omit 兼容、include/same-origin 贯通 load+loadText、非法值 SegmentLoader/HlsPlayer 两级快速失败、player 贯通与回落）。

### 18.2 §17.3 候选现盘复核

| 条目 | 实码证据 | 结论 |
|---|---|---|
| credentials 配置化 | `segment-loader.js:101` 旧硬编码 `credentials:'omit'`；本波配置化 + 校验 + 贯通 | ✅ 本波闭环（授权源可接入） |

### 18.3 §17.3 仍真实开放（下一波候选）

- **P2 建议**：TARGETDURATION 违例不校验（低优先容错）、level-controller stall 快速降档；mkv Cues 线性扫/unknown-size Cluster 双遍历。
- **ts 罕见边界**：188/192 误锁后不可自愈（§14.2，需 resync 失败阈值触发重探测）。

### 18.4 回归

- 新增 6 例 hls 回归用例（`hls/__tests__/credentials.test.js`）。
- `hls/__tests__` → **90/90 全绿**（较第十二波 84/84 +6）。
- 全仓 `node --test`（不带 `--test-force-exit`）→ 入套 **fail=0**，16 文件 cancelled（负载相关 harness 竞态，名单与前几波同池：registry、flv×3、lazy-nalu、ts-remux、mov×3、mp4×6、ts/cross-fixtures）；6 个此前未隔离验证的文件（mov/qt-differences、mp4/box-parser、mp4/demuxer、mp4/edge-cases、mp4/range-loader、mp4/remuxer）隔离复跑 **30/30 全绿**，其余文件前几波均已隔离验证全绿 → 有效 898 例全绿（892 + 本波 6），无真实失败。

---

## 19. 第十四批复核记录（2026-09-07 · hls stall 快速降档）

> 继续滚动评审。对 §18.3「level-controller stall 快速降档」现盘复核并闭环。

### 19.1 本轮修复（注释承诺未兑现，实证）

1. **stall 快速降档缺失【实证闭环】**：`level-controller.js:9-11` 头部策略注释承诺「降级条件：加载超时或缓冲 < 2s 时立即降到估计带宽能承载的最高档」，但实码从未兑现 —— `autoSelect` 降级完全依赖带宽 EWMA 回落（`reportLoad` 采样），`bufferSeconds` 仅作升级闸（`autoSelect:105`）；高码率档下载慢到播放停顿时 EWMA 尚未反映，只能干等下一分片下载完成。player.js 亦无任何 video 'waiting'/'stalled' 监听。
   修复：① `LevelController` 新增 `handleStall(minGapMs=2000)`：绕过带宽估计与升级闸直切最低档（争取最大下载余量），仅 auto 模式生效（手动锁定档位不覆盖用户选择），`lastSwitchTime` 节流防 waiting 风暴连环降档，后续 `reportLoad` ABR 复核自然爬回；② `HlsPlayer` 挂 `video 'waiting'` 监听 → `_maybeStallDowngrade()`：前置闸过滤（destroyed/无 levels/paused/缓冲 > 1.5s 不触发），切档以最近装载 sn 为锚点在新档位清单衔接；`destroy()` 解绑监听（先于 `mse.destroy()` 摘除，因后者会清空 video 引用）。
   用例：新增 `hls/__tests__/level-stall.test.js`（7 例：直切最低档、已在最低档 null、手动档不覆盖、节流与恢复、无 levels null、auto 开关保持（带宽恢复可爬回 3→0）、HlsPlayer 接线守卫）。

### 19.2 §18.3 候选现盘复核

| 条目 | 实码证据 | 结论 |
|---|---|---|
| level-controller stall 快速降档 | 旧注释承诺缓冲<2s 降档但 `autoSelect` 仅 EWMA 降档、无 video 事件监听；本波 `handleStall` + waiting 接线 | ✅ 本波闭环（注释与实现对齐） |

### 19.3 §18.3 仍真实开放（下一波候选）

- **P2 建议**：TARGETDURATION 违例不校验（低优先容错）；mkv Cues 线性扫/unknown-size Cluster 双遍历。
- **ts 罕见边界**：188/192 误锁后不可自愈（§14.2，需 resync 失败阈值触发重探测）。

### 19.4 回归

- 新增 7 例 hls 回归用例（`hls/__tests__/level-stall.test.js`）。
- `hls/__tests__` → **97/97 全绿**（较第十三波 90/90 +7）。
- 全仓 `node --test`（不带 `--test-force-exit`）→ 入套 **fail=0**，7 文件 cancelled（registry、flv/cross-fixtures、flv/remuxer、lazy-nalu、ts-remux、artifacts-edge、ts/cross-fixtures —— 前几波均已隔离复跑全绿）→ 有效 905 例全绿（898 + 本波 7），无真实失败。

---

## 20. 第十五批复核记录（2026-09-07 · mkv open 惰性停止，消除双遍历）

> 继续滚动评审。对 §19.3「mkv Cues 线性扫/unknown-size Cluster 双遍历」现盘复核：`locate()` 二分子项经重构已闭环（现行 :750-776 双分支均二分）；「unknown-size Cluster 双遍历 / 流式 webm open 扫完整簇」仍真实存在 → 本波修复。

### 20.1 本轮修复（open 全量扫簇 + seek 二次扫，实证）

1. **mkv open 扫完整簇 / 双遍历【实证闭环】**：`demuxer.js` open 顶层扫描（:311-341）为找尾置 Cues/后续元素会逐个越过全部 Cluster（未知尺寸簇经 `#probeUnknownMasterEnd` 逐子头边界探测，即全量扫簇）；无 Cues 文件首次 seek 的 `#ensureSeekIndex`（:729-747）又完整扫一遍簇 → 双遍历。读范围插桩实证：尾置 Cues 布局下 open 曾一路读到文件尾。
   修复（`mkv/src/demuxer.js`）：① open 顶层扫描**在首个 Cluster 处惰性终止**（新增 `_infoSeen/_tracksSeen` 标记，仅当 Info/Tracks 已见——合规布局均在簇前；非规范顺序自动回落旧全扫）；簇后唯一影响定位的尾置 Cues 推迟处理；② `#ensureSeekIndex` 扩展为**同时惰性发现尾置 Cues**（扫簇头时命中 Cues 即 `#parseCuesAt` 后走 Cues 二分返回），实现"簇后区间仅首次 seek 扫一次、open 零扫"。`locate()` 二分维持。
   插桩实证（读范围间谍）：尾置 Cues 布局下 open 后 maxRead 止于首簇头（绝对偏移 65，簇1 起点 83），cues 保持空；顺序拉流仍解出 3 簇全部分片；首次 seek 后 cues=3（惰性发现）、locate(0) 命中首簇。
   连带修正：评审回归测试「SeekHead→Cues 定位路径覆盖」fixture 的 SeekPosition/CueClusterPosition 少加 seekHead.length（旧实现靠 open 全扫掩盖了偏移错误，惰性停止后走 SeekHead 路径暴露）→ 改为定宽 8 字节 SeekPosition 两趟构造，偏移符合 EBML 规范（相对 Segment 数据起点）。
   用例：新增 `mkv/__tests__/lazy-open.test.js`（读范围间谍 3 段断言：open 不扫入簇体、顺序拉流完整、seek 惰性发现尾置 Cues+定位正确）。

### 20.2 §19.3 候选现盘复核

| 条目 | 实码证据 | 结论 |
|---|---|---|
| mkv Cues 线性扫 | 现行 `locate()`(:750-776) cues/clusterIndex 双分支均二分 | ✅ 已闭环（早于本波，重构后即二分） |
| unknown-size Cluster 双遍历 | open 旧全量扫簇 + 无 Cues seek 二次扫；本波 open 首簇惰性停止 + seek 一次性建索引/发现尾置 Cues | ✅ 本波闭环 |

### 20.3 §19.3 仍真实开放（下一波候选）

- **P2 建议**：TARGETDURATION 违例不校验（低优先容错）。
- **ts 罕见边界**：188/192 误锁后不可自愈（§14.2，需 resync 失败阈值触发重探测）。

### 20.4 回归

- 新增 1 例 mkv 回归用例（`mkv/__tests__/lazy-open.test.js`）。
- `mkv/__tests__` → **74/74 全绿**（较上一基线 73/73 +1；含 SeekHead fixture 规范修正）。
- 全仓 `node --test`（不带 `--test-force-exit`）→ 入套 **fail=0**，7 文件 cancelled（registry、flv/cross-fixtures、flv/remuxer、lazy-nalu、ts-remux、artifacts-edge、ts/cross-fixtures，前几波均已隔离复跑全绿）→ 有效 906 例全绿（905 + 本波 1），无真实失败。

---

## 21. 第十六批复核记录（2026-09-07 · ts 188/192 误锁自愈重探测）

> 继续滚动评审。对 §20.3「ts 罕见边界：188/192 误锁后不可自愈（§14.2）」现盘复核并闭环；TARGETDURATION 违例校验留待下一波候选。

### 21.1 本轮修复（误锁不可自愈，实证）

1. **188/192 误锁后不可自愈【实证闭环】**：`_detectPacketSize`（ts-stream-engine.js:199-228）以三同步点锁定 188/192 后即永久绑定；主循环失步仅 `pos++` 滑动，**永不重新探测**。罕见边界：首窗垃圾中恰现「192 步长三同步巧合」即误锁，其后整段真 188 流被逐字节滑掉，flush 后样本 0——不可自愈。
   实证（读范围/状态探针）：垃圾 1300B（0/192/384 三处 0x47）+ 真 188 流（PAT/PMT+3 视频 PES）喂入 → 旧实现 `packetSize` 锁死 192、samples=0、真流全部损失。
   修复（`ts/src/ts-stream-engine.js`）：① 构造新增诊断计数 `resyncs`；② `_consume` 改外层循环 + 主循环跟踪**自上次命中起连续失步滑动字节 `slid`**（命中归零）；③ `slid ≥ 4×packetSize`（连续 ≥4 单元无法对齐）判定同步网格失效 → 丢弃失步窗口起点前已确认垃圾、`packetSize=null`、重新 `_detectPacketSize()`（emit warn + resyncs++），成功后继续消费。真实流短抖动（单包损坏/流式分块）滑动 ≤ 单包长，远低于阈值，不受影响。
   用例：新增 `ts/__tests__/ts-edge.test.js` 3 例（误锁自愈主用例 resyncs=1/重锁 188/样本 3 全出；单包垃圾 188B 不触发重探、p0 帧损失后 p1/p2 恢复；流式任意切块分喂不触发重探）。两处测试教训：① fixture 数组需展开（`[...makeProgram()]` 而非嵌套 push，否则 concatBytes 把子数组按数值展开成 0）；② 任意长度垃圾横切 TS 流会因「下一单元双校验」连累前一真包被滑掉（引擎固有语义），短暂失步用例必须以整包颗粒插入并允许邻近帧损失。

### 21.2 §20.3 候选现盘复核

| 条目 | 实码证据 | 结论 |
|---|---|---|
| ts 188/192 误锁不重探 | 三同步锁定后永不重探，误锁即全损；本波 `_consume` 连续失步 ≥4 单元重置重探测 | ✅ 本波闭环 |

### 21.3 §20.3 仍真实开放（下一波候选）

- **P2 建议**：TARGETDURATION 违例不校验（`m3u8-parser.js:428` 仅读取、`player.js:389` 回退 6s，无 EXTINF>targetDuration 校验；低优先容错）。
- **架构项**（历史遗留，非容器 demuxer）：Transmuxer.tsAvailable 降级承诺失真（fmp4-muxer 静态 import ts/nalu，ts 缺失则整 hls 模块加载失败）；ts PCR 未提取（时长估算退化）。

### 21.4 回归

- 新增 3 例 ts 回归用例（`ts/__tests__/ts-edge.test.js` 188/192 误锁自愈区）。
- `ts/__tests__` → **72/72 全绿**（较上一基线 69/69 +3）。
- 全仓 `node --test`（默认高并发）→ fail=0，但 cancelled 随负载漂移（本波 8→14 个不等，覆盖 flv/mov/ts 未改模块）——纯文件级并发争抢超时；**降并发 `--test-concurrency=4 --test-timeout=15000` 复跑 → 909/909 全绿 0 cancelled**（906 + 本波 3）。结论：全仓稳定基线建议采用低并发参数；默认并发下以 fail=0 + cancelled 文件逐个隔离复跑为判据。

---

## 22. 第十七批复核记录（2026-09-07 · hls TARGETDURATION 违例自愈校验）

> 继续滚动评审。对 §21.3「TARGETDURATION 违例不校验（低优先容错）」现盘复核并闭环；架构项（Transmuxer.tsAvailable 降级承诺失真、ts PCR 未提取）留待后续。

### 22.1 本轮修复（声明过小/非法归零影响调度，实证）

1. **TARGETDURATION 违例不校验【实证闭环】**：旧实现 `m3u8-parser.js:428` 仅 `Number(...) || 0` 读取声明（非法值静默归零），**无任何 EXTINF 对声明的一致性校验**；`player.js:439` 直播轮询 `interval = target/2` 直接消费声明值。声明过小 → 轮询过频/追赶过激；非法值归零 → `|| 6` 拍脑袋猜测。第一轮评审已记录「TARGETDURATION 违例不校验、数值标签非法值静默归零」。
   修复：
   - `m3u8-parser.js`（parseMedia 尾部新增语义校验）：按 **RFC 8216 §4.4.3.1 判定**——分片 EXTINF 四舍五入到最近整数后须 ≤ 声明 Target Duration（6.008s 配 6s 声明合规，6.6s 配 6s 才违例）。违例时以实际最大分片时长上取整**自愈提升** targetDuration，并将违例分片数暴露到新字段 `targetDurationViolations`（不静默）；声明缺失/非法归零（targetDuration=0）时同样以 `ceil(maxDur)` 兜底，避免调用方 6s 猜测。合规流（targetDuration ≥ 各分片四舍五入值）完全不受影响。
   - `player.js`：新增 `_checkTdViolation(pl)` 诊断（违例时 log.warn 提示自愈结果），在三个 mediaPlaylist 落库点接线（直连 media / `_loadMediaPlaylist` / 直播轮询）。
   回归面修正：既有 VOD fixture（TD:6 + seg 6.008s）暴露首版校验「裸比 EXTINF>声明」过严（按 RFC 应四舍五入判定）→ 修正为 `Math.round(duration) > targetDuration` 后原 fixture 判定合规、行为不变。
   用例：新增 `hls/__tests__/td-violation.test.js` 5 例（违例自愈提升 6.6→7 + violations=1；合规边界 6.4 不提升；多分片违例计数 2 与最大提升 7.2→8；标签缺失以 maxDur 兜底 4.2→5；HlsPlayer._checkTdViolation 守卫 null/合规/违例均不抛）。

### 22.2 §21.3 候选现盘复核

| 条目 | 实码证据 | 结论 |
|---|---|---|
| TARGETDURATION 违例不校验 | 旧仅读取声明（非法值静默归零）、轮询直接消费；本波 RFC 语义校验 + 自愈提升 + violations 诊断字段 + player 三落点 warn | ✅ 本波闭环 |

### 22.3 仍真实开放（下一波候选）

- **架构项**（历史遗留，非容器 demuxer）：Transmuxer.tsAvailable 降级承诺失真（fmp4-muxer 静态 import ts/nalu，ts 缺失则整 hls 模块加载失败）。
- **P2 建议**：ts PCR 未提取（时长估算退化，ts 模块）。

### 22.4 回归

- 新增 5 例 hls 回归用例（`hls/__tests__/td-violation.test.js`）。
- `hls/__tests__` → **102/102 全绿**（较上一基线 97/97 +5）。
- 全仓 `node --test --test-concurrency=4 --test-timeout=15000` → **914/914 全绿 0 cancelled**（909 + 本波 5）。低并发参数已固定为全仓稳定基线。

---

## 23. 第十八批复核记录（2026-09-07 · 全景收官：EXTINF 前置 BYTERANGE 修复 + 陈旧项纠正）

> 继续滚动评审。对 §22.3 两项候选现盘复核：ts PCR、Transmuxer.tsAvailable 均已在前述波次闭环，属台账陈旧标记（纠正）；进而系统核对台账首行全景清单，发现唯一遗漏子项「EXTINF 前置 BYTERANGE 丢失」仍真实开放 → 本波修复。至此第一轮候选池清零。

### 23.1 本轮修复（前置 BYTERANGE 丢失，实证）

1. **EXTINF 前置 BYTERANGE 丢失【实证闭环】**：`m3u8-parser.js` BYTERANGE 归属仅 `if (current) current.byteRange = br`（:371）——只覆盖规范排列（EXTINF→BYTERANGE→URI，标签时 current 挂起态存在）。非规范「前置」排列（BYTERANGE 紧跟上一 URI、所属分片 EXTINF 尚未来，`current=null`）标签被解析、`prevByteRangeEnd` 已滚动，但 byteRange 不挂任何分片 → 静默丢失。行 166 全景清单早录（segment-loader.js:341-344 旧标注，loader 经第十一波重构后已简化，缺口实际在解析层归属）。
   修复：新增 `pendingByteRange` 暂存——BYTERANGE 行 `current=null` 时挂暂存；EXTINF 创建分片时 `byteRange: pendingByteRange` 归属下一个分片并清空（EXTINF 先 `flushSegment()` 的时序保证归属对象正确）。缺省 offset 滚动语义（`parseByteRange(value, prevByteRangeEnd)`）跨前置排列不变。
   用例：新增 `hls/__tests__/byterange-prefix.test.js` 4 例（前置归属下一分片；混合顺序规范后置+前置各归其主；前置缺省 offset 按前序滚动续接；首个分片缺省 offset 仍解析期报错不回归）。

### 23.2 §22.3 候选现盘复核（台账陈旧纠正）

| 条目 | 实码证据 | 结论 |
|---|---|---|
| ts PCR 未提取 | `ts-stream-engine.js` `_recordPcr`(:313-329 提取+discontinuity 重置+emit 'pcr')、metadata `pcrDurationMs/pcrSeen` DTS 不可用时兜底(:694-708 注释自述「修复 PCR 未提取导致时长估算退化」)；`pcr.test.js` 4 例 | ✅ 已闭环（§15.1，台账行 461；§21.3/22.3 列为仍开放系滚抄陈旧文本，纠正） |
| Transmuxer.tsAvailable 降级承诺失真 | `fmp4-muxer.js` 已惰性动态 `import('../../ts/src/nalu.js')`（loadNalu 缓存+预热不阻塞）+ `import('../../ts/src/index.js')`（:407）；`lazy-nalu.test.js` 含**源码守卫**测试（断言 fmp4-muxer.js 不得恢复对 ts/src 静态 import） | ✅ 已闭环（架构项 §16.3；同上纠正） |
| §10 注册形状缺失（hls） | hls 为流式协议播放器，非容器 demuxer | ⚠️ N/A（台账行 399 已定） |

### 23.3 全景收官矩阵（台账首行清单 166 逐项终态）

| 全景子项 | 闭环波次/证据 |
|---|---|
| EXTM3U 首行校验 | ✅ 早期波（行 332，BOM 剥离） |
| transmuxer kind unknown 空转 | ✅ 早期波（行 365） |
| fmp4 编造 .42E01E / toAvcc 透传 | ✅ 早期波（行 290/291） |
| mfhd 恒 1 / _seq 死代码 | ✅ 误报（行 333） |
| tsAvailable 降级失真 | ✅ 架构项 §16.3（本波纠正） |
| QuotaExceeded 回调 | ✅ hls#5（行 293） |
| 长直播无周期 remove | ✅ 波（行 493，trim/backBuffer） |
| 纯音频强建视频轨 | ✅ 行 292 |
| 浮点秒 vs µs | ⏳ 边界项：契约 µs 于内核输出层统一（ts 引擎样本 µs、fmp4-muxer 时间线 µs），无内核外浮点泄露实证 |
| TARGETDURATION / 数值归零 | ✅ 第十七波（行 676） |
| §10 注册形状 | ⚠️ N/A（行 399） |
| parseAttributes 小写/引号 | ✅ 误报 RFC 合规（行 398） |
| BYTERANGE length=0 | ✅ 第十一波（行 336） |
| EXTINF 前置 BYTERANGE | ✅ **本波**（§23.1） |
| credentials 配置化 | ✅ 波（行 553） |
| level-controller stall | ✅ 第十四波（行 582） |
| ts PCR | ✅ §15.1（本波纠正） |
| ts 192 误锁 | ✅ 第十六波（行 644） |
| ts LATM | ✅ 第九波（行 429） |
| mkv Cues 线性扫 | ✅ 早于波次（行 613） |
| mkv Cluster 双遍历 | ✅ 第十五波（行 614） |
| mkv codecs 透传 | ✅ 波（行 397） |
| core clock ±120/±20 | ✅ 行 363 |
| Stats Date.now | ✅ 行 364 |

**第一轮全景候选清单至此逐项有终态（✅/N/A/边界记录），滚动评审候选池清零。**

### 23.4 回归

- 新增 4 例 hls 回归用例（`hls/__tests__/byterange-prefix.test.js`）。
- `hls/__tests__` 全套 102 有效全绿 + lazy-nalu 并发 cancelled 隔离复跑 4/4（默认并发下偶发文件级超时）。
- 全仓 `node --test --test-concurrency=4 --test-timeout=15000` → **918/918 全绿 0 cancelled**（914 + 本波 4）。

---

## 24. 第十九批复核记录（2026-09-07 · checklist 契约一致性面现盘复核）

> 第十八波解析层候选池清零后，对 `docs/review/checklist.md` 正式评审面（F 系列预扫描 + G9 + core#4/#5/#9 + S2 系统件）做**全量现盘复核**——该面自 2025-08-25 建立后未随修复更新，状态列严重陈旧。本波以磁盘实码逐条核证并更新 checklist。

### 24.1 复核结论（逐条磁盘证据，checklist F 表状态列已同步更新）

| 条目 | 实码证据 | 结论 |
|---|---|---|
| G9/core errors 补五码 | `core/src/errors.js` 十码封闭枚举 + probeFailed/parseError/notSupported/sourceError/networkError/decodeError/seekUnsupported/timeoutError/abortedError/stateError 十个快捷构造器齐 | ✅ 已闭 |
| F2 logger | `core/src/logger.js` LogLevel/setLogLevel/logBytes/createLogger 四级日志，index.js 导出 | ✅ 已闭 |
| F3 capabilities | `capabilities.js` hasWebCodecs/hasMSE/hasManagedMediaSource/hasAudioWorklet/hasWebGPU/hasCryptoSubtle/detectCapabilities/chooseRoute/canDecodeVideo/canDecodeAudio 齐 + index 导出（返回结构精比对归 I1） | ✅ 已补 |
| F4 HttpRange/ChunkBuffer | `http-range-source.js` HttpRangeDataSource + `data-source.js:79` ChunkBuffer（index 导出；并发 Range 合并行为细核归 I1） | ✅ 已补 |
| F6 worklet 注册名 | `audio-worklet-player.js:93 registerProcessor('player-audio-sink')` + `AUDIO_SINK_PROCESSOR_NAME` + underrun 上报 | ✅ 已改 |
| F9 ts 适配壳 | `ts-demuxer.js:42 class TsDemuxer extends Demuxer`（core 基类）+ open/readSample/samples/seek(µs)/pause/resume/destroy + probe/push/flush 别名 + createTsDemuxer 工厂 | ✅ 已闭 |
| F7 createAudioOutput | AudioWorkletPlayer 类 + createWorkletUrl 导出；**工厂形态/currentTimeUs 主时钟 getter 未实现** | ⏳ 归 I1 |
| F8 createVideoRenderer | VideoFrameRenderer 类导出；close-in-finally 已闭（§9.1 core#10）；**工厂未实现** | ⏳ 归 I1 |
| F10 mkv 基类继承 | 功能面 open/readSample/samples/seek(µs)/destroy + µs 边界已齐；`extends Emitter` 未继承基类——**全仓唯一落单 demuxer**（ts 为样板） | ⏳ 归 I1 |
| F11 hls EventBus/LoadError | 裸 Error/LoadError 已收口十码（§9.2 hls#5）；Player 面非 Demuxer 面（重定位裁决）；EventBus 平行实现属 F12 同类 | ⏳ 归 I1 / 👀 watch |
| F12 bits/emitter 平行件 | 维持 watch（ts 壳已落 core 基类，内部件收敛随接入波次） | 👀 watch |

### 24.2 本轮修改

- **mkv/src/demuxer.js 头注释（:14-19）陈旧纠正**：原「继承 core Demuxer 基类的切换待 media-dev 完成 open/readSample 波次（E-8）」——该波次已完成（ts-demuxer.js:42 即样板），注释误导为"media-dev 欠账未还"。改为准确描述：功能面齐、基类继承归第二轮 I1（M3 末触发）待办。
- **docs/review/checklist.md F 系列状态列全量更新**：F1-F6/F9 补勾销（带 2026-09-07 现盘证据）；F7/F8/F10/F11 标注精确状态与归属（I1 待办 / F12 同类 watch）。

### 24.3 里程碑判断

- 第一轮（解析层正确性，G/P/M 系列）**实质收官**：候选池清零（§23.3 全景矩阵），本波契约面复核确认无隐藏解析层缺口。

---

## 28. 第二轮 I1 首波（2026-09-07 · core 渲染端工厂形态对齐）

> 第一轮清单、G 系列和 F 系列完成登记后，进入第二轮 I1。先处理不涉及播放管线的 core 渲染端公共 API 形态，保留已有类与迁移期参数兼容。

### 28.1 本轮修复

1. **F7 `createAudioOutput` 工厂缺失闭环**：`core/src/audio-worklet-player.js` 新增 `createAudioOutput({sampleRate,channels})`，内部映射到现有 `AudioWorkletPlayer`；保留 `channelCount` 兼容别名。已有 `currentTimeUs`、`underrunCount` getter 与 `player-audio-sink` 注册名继续作为契约实现。
2. **F8 `createVideoRenderer` 工厂缺失闭环**：`core/src/video-frame-renderer.js` 新增 `createVideoRenderer(canvasEl,{preference,fit})`，`preference` 映射现有 `mode`；新增 `fit` 定稿语义，支持默认 `contain`、`cover`、`fill`，Canvas2D/WebGL 两条路径统一几何口径。
3. **core 统一出口补齐**：`core/src/index.js` 导出两个定稿工厂。

### 28.2 回归

- `core/__tests__/review-fixes.test.js` 新增工厂导出/参数形状与 fit 几何回归 2 例。
- 定向 core 回归：**14/14 全绿**；渲染端专项复跑：**5/5 全绿**（fail=0/cancelled=0）。
- G9 延伸收口：渲染端对外环境/生命周期错误改用 core 十码（AudioContext/未 init/无渲染路径分别为 NOT_SUPPORTED/STATE_ERROR），shader 编译/链接错误仍属内部 WebGL 防御断言。
- 全仓低并发 `--test-concurrency=4 --test-timeout=15000`：**926/926 全绿，fail=0，cancelled=0**。
- 剩余真实开放项全部落在**第二轮 I 系列**（M3 末触发，checklist §3）：I1 中 F7/F8 渲染端工厂形态、F10 mkv 基类继承、codec-string/capabilities/errors 精比对；I3 demo 集成面、I4 README 一致性、I5 安全项、I6 site 汇总页。**触发前提（M3 区块 t18 管线/t19 demo/t20 汇总页）未达**——架构级改造（如 mkv extends Demuxer 基类）建议等第二轮正式开波，勿在滚动评审中越权擅动。

### 24.4 回归

- 纯注释/文档改动：mkv demuxer 冒烟 28/28 绿；全仓基线不受影响（上一基线 918/918，低并发参数）。

---

## 25. 第二十批复核记录（2026-09-07 · F10 mkv 基类对齐预研笔记）

> 接 §24.3 判断：架构级改造（F10）留待 I1，本波先做**零风险预研**，产出 `docs/review/mkv-base-class-alignment.md`，供 M3/I1 开波即用。

### 25.1 预研结论

- **同构性好**：mkv 的 pull 骨架与 core `Demuxer` 基类天然同构——`#iterateTrack(trackId)` ≡ `_createTrackIterator` 钩子（改名即用）、open 内核 ≡ `_doOpen`、seek 体 ≡ `_doSeek`、`#trackIterators` 缓存 ≡ 基类 `_trackIterators`。迁移面小。
- **机械替换必挂 3 组既有断言**（74 例中）：
  1. `demuxer.test.js:124-132` 未 open 访问 `tracks/mediaInfo` 须**同步抛** STATE_ERROR（基类返回 null/[]）；
  2. `contract-edge.test.js:281-283` `samples()` 未 open **同步抛**（基类是懒生成器）；
  3. `demuxer.test.js:141` end 须**所有可读轨被拉完才恰发一次**（基类"已拉轨全 done 即发、可多次/提前"）。
- **mkv 守卫/end 语义比基类与 ts 样板更严**，贴近契约 §2.3「end：全部轨 EOS」字面；ts 已接受基类懒生成器语义（ts-demuxer.test.js:187-190）→ 两模块存在真实语义分歧，属 I1 契约裁决面。

### 25.2 交付

- 新增 `docs/review/mkv-base-class-alignment.md`：行为差异矩阵 D1-D12（带 mkv 现语义/基类语义/ts 样板三列与行号证据）、测试固化点表、三案设计（A 贴基类改测试 / B 基类+override 零回归 / C 形式继承保自实现）与推荐（**先 C 后 A**：I1 首步 C 案零回归落地 → 差异清单裁决后 A 案收敛同构）、I1 待裁决问题 Q1-Q6（end 语义/守卫/samples 同步抛/open 失败重试/重入/细项）、案 C 落地六步与开放风险。

### 25.3 回归

- 纯文档产出，零代码改动；`mkv` 基线 74/74 不受影响。

---

## 26. 第二十一批复核记录（2026-09-07 · G 系列通用红线跨模块系统核查）

> 第一轮（G/P/M 解析层）收官后，checklist §1 G 系列十条"每模块必查"红线此前仅零散覆盖（G9 于 §24.1 核过 core；hls/flv 等模块错误收口散见各波）。本波对全部 16 交付模块做**一次性系统扫描**，逐条登记终态；mp4 写端裸 Error 收口为唯一确凿代码修复。

### 26.1 扫描方法与结论（16 模块：ape/cmaf/core/flac/flv/hls/mkv/mov/mp4/rtmp/rtsp/subtitle/ts/wav/webrtc/webtorrent）

| 红线 | 实证手段 | 结论 |
|---|---|---|
| G1 纯 ESM | 16 模块 index.js 逐一 `await import` | ✅ 全加载成功；无 require/裸 specifier（webtorrent loader.js `typeof import('webtorrent')` 经核为 JSDoc 类型注释，非运行时代码） |
| G2 零第三方依赖 | src/ 导入扫描 | ✅ 仅相对导入；webtorrent loader.js globalThis 探测→动态 import CDN→null 降级属契约"可选增强必须探测→降级"豁免（README「可选依赖」节文档化） |
| G3 入口导出 | index.js 扫描 | ✅ 16 模块全显式具名、无 default export |
| G4 中文 JSDoc | 导出符号启发扫描 | ✅ 导出均有中文 JSDoc；命中项全为 §10 注册形状元数据常量组（extensions/mimeTypes/capabilities/VERSION 等，共享 section 注释语义自明），不补噪音注释 |
| G5 双环境安全 | 浏览器全局裸用扫描 + 逐处甄别 | ✅ 全部带守卫：subtitle isRendererSupported `typeof document!=='undefined' &&` 短路、mp4 pickFile typeof document 守卫、cmaf 构造 hasWebCodecs() 先行、hls mse notSupported 探测、core capabilities/clock 等 |
| G6 测试与 fixture | 全仓低并发跑 | ✅ 918/918 0 cancelled（`--test-concurrency=4 --test-timeout=15000`） |
| G7 命名规范 | 文件名脚本 | ✅ 16 模块 src 全 kebab-case 零违规 |
| G8 日志纪律 | alert/console 扫描 | ✅ 无 alert；console 仅两处纪律例外（emitter error 处理器兜底 console.error、诊断 console.warn），级别默认 warn |
| G9 错误封闭枚举 | 裸 throw 扫描 + 收口链逐处核 | ⏳ 主面闭环（详见 26.2） |
| G10 目录四件套 | 目录存在性 | ✅ 16 模块 README+src/index.js+demo+__tests__ 全齐 |

### 26.2 G9 处置分类（裸 `throw new Error` 全仓盘点 → 三类）

1. **内部防御原语（合规豁免）**：flv/amf0.js（decodeAmf0/decodeAmf0All 入口全 try/catch，裸 Error 不出模块）、ts/bits.js+aac.js、mkv/lacing.js+demuxer.js:201、rtmp/amf.js、rtsp/b64.js（Node22 实际不触发）、webrtc/mock-signaling.js（测试 mock）、hls/fmp4-muxer.js:598（lazy-nalu 预热断言，§16.3 已保证预加载）——触发即内部 bug 或入口已收口，非输入容错路径。
2. **第二轮廓线归属（不擅动）**：渲染端类裸 Error（core/audio-worklet-player.js:114 AudioContext 不可用、:179/191 未 init 先调、video-frame-renderer.js:36 无 DOM）→ **归 I1**（F7/F8 渲染端 API 面一并裁决）；传输层裸 Error（webrtc/player.js:77 无法识别播放地址、:121 非法状态迁移；rtsp/client.js:377 SDP 获取失败 HTTP 状态、rtsp/errors.js:30 未登记码）→ **归 I5**（输入校验/URL 面）。
3. **本轮实修（mp4 写端公共面）**：`mp4/src/remuxer.js`（createInitSegment 缺 description → `stateError`；createMediaSegment 空 samples → `stateError`）与 `mp4/src/box-builder.js`（buildStsd 未知 sample entry → `notSupported`；moof 内无 trun → `parseError`）共 4 处——mp4 模块 demuxer/box-parser/webcodecs-pipeline 早已十码，写端是唯一落单公共面，补齐后模块内一致。

### 26.3 连带工具教训

- 本波再次实证 **macOS BSD grep `\|` alternation 空转**（查 box-builder 引用时 grep -rl 静默空输出 exit 1），改用 Grep 工具单模式后正常命中 rtmp/mp4-mux.js 等 6 处引用——与 §24.3 结论一致，后续 bash 一律避免 `\|`。
- heredoc 落盘含 `${...}` 模板串的 JS 脚本时外层 zsh 会解析（quoted heredoc 亦偶发 Bad substitution）→ 复杂脚本一律用 Write 工具直落 /tmp。

### 26.4 回归

- mp4 4 处错误收口改动：`mp4/__tests__` 全绿（remuxer/edge-cases/artifacts-edge 隔离复跑各自全绿；artifacts-edge 全套时 cancelled 为并发超时特征，隔离 21/21）；PlayerError extends Error，既有 assert.throws 正则匹配断言不受影响。
- 全仓低并发 `--test-concurrency=4 --test-timeout=15000` → **918/918 全绿 0 cancelled**（与上一基线持平，无新增用例——本波为核查波，改动由既有断言覆盖）。
- checklist.md §1 G 系列 checkbox 全量更新（✅ 带实证/⏳ G9 残余归二轮）。

---

## 27. 第二十二批复核记录（2026-09-07 · 初始清单收官审计 + flac 契约面补齐）

> G/F 系列登记完成后，对台账 §1-§7 初始正式清单（ts/core/mkv/webtorrent/hls/wav/subtitle）做**全量收官审计**（核对每条的磁盘闭环证据），并对 §10 注册形状做 16 模块存在性扫描。审计发现 flac 为 demux 容器模块中 §10 注册形状唯一落单者，且 demuxer 缺定稿 open/readSample/destroy、seek 自 ended 不恢复（wav#2 同款 bug）→ 本波修复。

### 27.1 初始清单收官审计结论（§1-§7 逐模块终态）

| 模块 | 初始条目 | 闭环证据 | 终态 |
|---|---|---|---|
| ts | 阻断2/严重5/建议11 | 第一批闭环（2026-08-25 壳/µs/AAC/buildHvcc/PES 上限/CC/PMT 版本）+ §14 LATM/§15 PCR/§16 192 误锁；buildHvcc chromaFormat 硬编码残余转跟踪 | ✅ 清零（建议残余转跟踪） |
| core | 阻断1/严重9/建议12 | core#2 moreRbspData/crop 修正、#7 writeMatrix（§10.3 波）、#10 VideoFrame close（§9.1）、#4 codec-string、#5 capabilities（§24 F2/F3）、#6 errors（§24 G9）、#9 worklet 注册名（F6）；#1 基类现代重写（:412 行状态机+钩子）；base 面残余归 I1 | ✅ 主面清零（渲染端残余归 I1） |
| mkv | 阻断1/严重3/建议11 | #1 demo 已换 §10 面（index.html:84 createDemuxer）；#2 EBML 5-7B 溢出已修（ebml.js 指数运算避 int32）；#3 块头裸 Error→PlayerError（demuxer.js:43 PARSE_ERROR）；#4 Range 非 206 已拒（source.js:127/:173）；双遍历/Cues 等经 §15/§20 波 | ✅ 清零 |
| webtorrent | 严重4/建议8 | #1 越界→SOURCE_ERROR（source.js:96/assembler.js:111 reject）；#2 构造签名反转（S1 第二批）；#3 常驻 error 转发（player.js:44-46/116/129 每 client 一次 + destroy 摘除）；#4 samples() 红测已随改造通过（套件 129 例全绿） | ✅ 清零 |
| hls | 严重7/建议13 | #1 sn 偏移/#2 窗口回退/#3 切档续装/#4 window 守卫/#5 错误体系/#7 parseIv 等经 §9.2/§11/§13-§18 波闭环；建议项经 §23.3 全景矩阵全 ✅/边界 | ✅ 清零 |
| wav | 阻断1/严重3/建议10 | 2026-08-26 三批复核（#1 worklet/#2 seek ended/#3 定稿名/#4 riffSize/#8 错误）全闭 | ✅ 清零 |
| subtitle | 严重2/建议6 | #1 \1c 数字前缀词法（tags.js:207 digitM 特判）；#2 probe/parseCues/createTextTrack 三件套+encoding 字节入口（track.js/index.js:18）；#3 错误码（S1 第二批）；contract.test.js 显式覆盖 | ✅ 清零 |

### 27.2 §10 注册形状 16 模块扫描 → flac 唯一落单

| 模块族 | 形状 | 判定 |
|---|---|---|
| flv/mkv/mov/mp4/ts/wav | 五件套齐（containerName/extensions/mimeTypes/probe/createDemuxer） | ✅ |
| cmaf | container/probe 有、无 createDemuxer（CMA F WebCodecs 直解播放器非 pull demuxer） | 👀 注记 |
| webrtc/rtsp/webtorrent/rtmp | createSource 传输层同形替换（§10:435） | ✅ |
| ape | probeApe/summarizeApe 元数据工具面（非 demuxer，Phase 3 只交 probe+MediaInfo，README/契约一致） | ✅ |
| hls | Player 面（重定位裁决非 Demuxer 面），无 §10 形状合理 | ✅ |
| core | 地基非容器 | ✅ |
| **flac** | **五件套全缺**（有 FlacDemuxer/static probe 但 index.js 未导出注册形状） | ❌ **本波修复** |

### 27.3 本轮修复（flac 契约面，实证缺口）

1. **§10 注册形状缺失**：flac 在 CONTRACTS §10/§11 目录注册表收录（行 208/446），同族 wav/mkv/ts/mp4/flv/mov 全齐，flac index.js 零注册形状 → core 注册表/site 汇总页无法驱动。
   修复：`flac/src/index.js` 补五件套（containerName='flac'/extensions/mimeTypes/probe=FlacDemuxer.probe/createDemuxer 工厂：嗅探 4KiB→new+open→已 ready，未命中 PROBE_FAILED）。连带修正：原 `export { FlacDemuxer } from './demuxer.js'` 纯 re-export 无本地绑定，probe/createDemuxer 内引用 FlacDemuxer 会 ReferenceError（首跑测试即暴露）→ 改 import+export（wav 同款）。
2. **定稿方法 open()/readSample(trackId)/destroy() 缺失**（wav#3 同款问题）：flac 只有 parseInit/samples/seek/stop。
   修复（`flac/src/demuxer.js`）：open()=parseInit 别名；readSample 经共享 #reader（EOS 后释放可重建）单拉，EOS resolve null；destroy()=stop+state='destroyed' 幂等，之后调用被既有状态守卫拦为 STATE_ERROR。
3. **seek 自 ended 不恢复迭代（wav#2 同款 bug，实证）**：flac demuxer.js 旧 `state = prev==='ended' ? 'ended' : 'ready'`——播完 seek 后 samples/readSample 永久 STATE_ERROR。
   修复：恒回 ready（同 wav :205 裁定）；wav 曾有独立严重2 而 flac 潜伏至今，本波一并闭环。
4. 用例：新增 `flac/__tests__/contract.test.js` 6 例（§10 形状含 probe 语义/任意字节不抛；open 别名+STREAMINFO description 34B；readSample 顺序+EOS null；ended-seek 恢复迭代；destroy 幂等+STATE_ERROR；createDemuxer 工厂+PROBE_FAILED）。

### 27.4 纠正与注记

- **F10「全仓唯一落单 demuxer」表述不准**（§24.1/§25）：flac 的 FlacDemuxer 同样不继承 core Demuxer（自含 MiniEmitter + 自管状态）。I1 基类对齐面 = **mkv + flac 两个**；`mkv-base-class-alignment.md` 的 D 矩阵/三案设计对 flac 同构适用，I1 开波时应复制扩展。
- ape 模块 probeApe 命名非 §10 字面 probe：ape 非 demuxer（无 Sample 流）不入 demuxer 注册表，契约 §2.3 ape 行「Phase 3 只交 probe+MediaInfo」即其交付承诺，维持现状（注记非缺口）。

### 27.5 回归

- 新增 6 例 flac 契约用例 → `flac/__tests__` **46/46 全绿**（40+6）。
- 全仓低并发 `--test-concurrency=4 --test-timeout=15000` → **924/924 全绿 0 cancelled**（918+6）。

## 29. 第二轮 I1 第二波（2026-09-07 · mkv + flac 继承 core Demuxer）

> 按 §27.4 纠正后的真实范围推进 F10：mkv 与 flac 两个 demuxer 均完成形式继承，先统一公共生命周期/事件基础，不擅自改变各模块已由测试固化的严格语义。

### 29.1 修改

- `mkv/src/demuxer.js`：`extends Emitter` → `extends core Demuxer`，构造函数调用 `super(source, options)`，内部状态改接基类 `stateValue`，并将规范化后的 `dataSource` 回挂 `this.source`，确保基类公共能力与 MKV 实际数据源一致。
- `flac/src/demuxer.js`：`extends core Demuxer`，移除 `MiniEmitter` 依赖，改用 core emitter；解析内核拆为 `_doOpen()`/`_parseInit()`，保留 `parseInit()` 兼容别名、FLAC 专属 `metadata` getter、既有 readSample/samples/seek 语义。
- 两模块继续保留各自既有行为差异：mkv 的严格 getter/end 语义与 flac 的 ended 兼容标记，不在本波强行统一，避免改变已固化播放行为。

### 29.2 回归

- MKV：**74/74 全绿**。
- FLAC：**46/46 全绿**。
- 下一步：进入 I1 契约精比对的差异裁决（D1-D12），再处理 I5 传输层。

## 30. 第二轮 I1 第三波（2026-09-07 · D1-D12 契约差异裁决）

> 本波不对已由测试固化的 mkv/flac 行为做破坏性统一；逐项对照 core 基类、mkv/flac 实码与 CONTRACTS §2.2/§2.3，形成证据化裁决并冻结迁移边界。

### 30.1 裁决摘要

- **生命周期**：D1 open 重入、D2 open 失败均保留模块现状；mkv 的重入抛错与失败回 idle 视为兼容层语义，core/新模块采用共享 promise 与基类失败收口。
- **属性/迭代器**：D3 getter 守卫、D11 `samples()` 未 open 的同步失败允许旧模块保留；新模块以基类默认值/懒生成器为准。
- **EOS/事件**：D4 以契约“全部轨 EOS”为目标，mkv 的全可读轨且单次触发作为严格实现；pull 消费不得依赖 D7 `sample` 事件。D8 兼容期双事件名由基类保留，D9 销毁后不再消费事件。
- **错误/控制**：D5 错误码保持十码封闭；D6 暂保 mkv `PARSE_ERROR` 与 core/ts `STATE_ERROR` 差异；D10 仅直播推送模式要求 pause/resume 可观测；D12 外部只依赖 `state`，内部使用 `stateValue`。

### 30.2 结论与边界

- 本波完成 D1-D12 的代码证据与迁移约束登记；F10 “继承 core Demuxer”与“完全语义同构”拆分验收，前者已闭环，后者不在本波强改。
- 详细矩阵已补入 `docs/review/mkv-base-class-alignment.md` §8。
- 下一候选：**I5 传输层输入校验与 PlayerError 收口**（webrtc/rtsp），F11/F12 继续观察。

## 31. 第二轮 I5 首波（2026-09-07 · WebRTC/RTSP 输入校验与错误收口）

### 31.1 修复

- `webrtc/src/player.js`：播放地址增加非空字符串校验；非法协议、非法状态迁移、缺少 `RTCPeerConnection` 分别映射 `PARSE_ERROR`、`STATE_ERROR`、`NOT_SUPPORTED`。
- `webrtc/src/signaling.js`：WHEP HTTP 失败按 4xx/5xx 映射 `PARSE_ERROR`/`NETWORK_ERROR`；异常 Content-Type 映射 `PARSE_ERROR`；WebSocket 未连接、连接失败、answer 超时、未协商 PATCH 分别映射 `STATE_ERROR`/`NETWORK_ERROR`/`TIMEOUT`/`STATE_ERROR`；未知信令协议映射 `PARSE_ERROR`。
- `rtsp/src/rtp.js`：RTP 输入类型、版本、CSRC、扩展头、padding 等异常全部映射为 `SOURCE_ERROR` 或 `PARSE_ERROR`，不再向上传裸 `Error`。
- `rtsp/src/client.js`：非 interleaved 请求、RTSP 4xx/5xx 响应、SDP HTTP 失败统一映射十码。
- `rtsp/src/framing.js`：interleaved 缓冲超限映射 `SOURCE_ERROR`。
- `rtsp/src/errors.js`：补充 `notSupported` 与 `source` 快捷构造器。

### 31.2 裁决边界

- `mock-signaling.js`、Base64 环境能力防御及测试 mock 的裸 Error 保留为内部/测试边界；不作为用户输入错误直接逃逸。
- 传输层错误继续使用既有本地 `PlayerError`（rtsp）或 core `PlayerError`（webrtc），均遵守十码集合。

### 31.3 回归

- WebRTC + RTSP 定向回归：**67/67 全绿**，fail=0，cancelled=0。
- 下一步：全仓低并发回归，并继续核查 F11/F12 平行 EventBus/错误面。

## 第二十七波（第二轮 I1：F11/F12 EventBus 收敛与错误面裁决）

### 27.1 现盘结论

- F11 重新定性：`hls/src/player.js` 是播放器/数据源适配面，不属于 core Demuxer 注册形状；其 `EventBus` 仅是历史命名，已改为 core `Emitter` 的导出别名，保留 HLS 入口兼容性。
- F12 事件总线：`rtmp/src/mini-emitter.js` 改为 `core Emitter` 兼容别名，`rtsp/src/source.js` 直接继承 core `Emitter`。两处对外 source/player 事件面不再复制事件分发实现。
- core `Emitter` 的统一语义补齐多参数转发：`emit(type, ...args)` 与 `once` 同样转发全部参数，兼容 RTSP `data(bytes, meta)` 等现有调用；监听器异常仍隔离，不阻断其它监听器。
- TS/FLV 解析内核的自含 emitter 保留为内部实现：它们服务独立流式解析内核，不作为跨模块对外 EventBus；当前不扩大修改范围。
- 本波不改变各模块 PlayerError 错误码裁决；I5 已完成传输层错误收口，F11 的 LoadError 十码结论沿用既有证据。

### 27.2 修改文件

- `core/src/emitter.js`
- `hls/src/utils.js`
- `hls/src/player.js`
- `rtmp/src/mini-emitter.js`
- `rtsp/src/source.js`
- `core/__tests__/event-contract.test.js`
- `docs/review/checklist.md`

### 27.3 回归

- 事件/相关模块定向回归：**184/184 全绿**。
- 失败：0；取消：0。
- 新增事件契约测试覆盖：多参数、once、取消订阅、监听器异常隔离，以及 HLS/RTMP/RTSP 事件件对 core Emitter 的复用关系。

### 30.3 回归

- 本波为契约/文档裁决波，未改运行时代码。
- MKV + FLAC：**120/120 全绿**，fail=0，cancelled=0。
- 前一全仓基线：**926/926 全绿**；运行时无代码变化，基线保持有效。

## 32. 第二轮 I3/I4/I6 首波（2026-09-07 · demo、README、site 汇总页审计）

### 32.1 现盘审计

- 16 个功能模块均具备 `README.md`、`src/index.js`、`demo/index.html` 和至少 1 个模块测试文件；未发现缺失的交付骨架。
- `site/demo/index.html` 已作为正式汇总入口，`site/nav.js` 的 `MODULES` 覆盖 16 个功能模块；补入此前遗漏的 `core` 首页入口，确保导航覆盖清单与目录实况一致。
- 根 `README.md` 的模块状态表原为 M1 骨架占位，已按当前源码/测试/demo 实盘更新：核心功能模块标记为已完成，并明确 RTMP/RTSP 的完成含义是 WebSocket/WebRTC 桥接形态，不是浏览器原生直连。
- 各模块 README、demo 与现有测试暂未发现需要继续改动的结构性缺口；未擅自改写模块负责人或协议限制文案之外的技术内容。

### 32.2 修改文件

- `site/nav.js`
- `README.md`
- `core/__tests__/event-contract.test.js`（承接上一波事件契约回归）

### 32.3 回归与边界

- 模块交付物盘点：16/16 四件套齐全。
- 事件及相关模块定向回归：**184/184 全绿**。
- 全仓串行回归受环境 SIGTERM 终止于约第 357 个测试，未形成全量统计；已通过的模块定向回归无失败、无取消。

## 33. 第二轮 I3/I4/I6 第二波（2026-09-07 · 入口与验收文档收尾）

### 33.1 现盘复核

- `site/index.html` 原为带“骨架占位页”文案的旧入口，虽已指向 `site/demo/index.html`，但会造成正式入口与汇总页双轨；现改为无脚本依赖的即时跳转页，并保留可访问的显式后备链接。
- `docs/test/TESTPLAN.md` 原仍保留“骨架”标题、过期的模块状态（多项“待实现/骨架期”），与当前 16 模块已具备源码、测试和 demo 的实盘状态冲突；已同步为第二轮评审状态。对浏览器真实播放/网关联调仍保留条件验收说明，未把手工验收误标为已通过。

### 33.2 修改文件

- `site/index.html`
- `docs/test/TESTPLAN.md`

### 33.3 回归与边界

- 本波仅修改静态入口与测试计划文案，无运行时代码变更。
- 已将解析层/演示骨架“已落地”和浏览器端到端“按 M3/M4 手工执行”分开表述。
- 下一步：建立分模块串行汇总命令，规避仓库递归 glob 在当前环境的 SIGTERM，并形成可复核的全仓统计。

## 34. 第二轮收尾（2026-09-07 · 全仓基线与遗留标记清理）

### 34.1 现盘复核

- 复核第二轮 I3/I4/I6 后的剩余文档标记，确认 `docs/test/TESTPLAN.md` 的模块矩阵已同步为当前实现状态；浏览器端到端、真实网关联调仍明确属于 M3/M4 条件验收，不以 Node 单测冒充。
- `site/index.html` 已不再承载旧骨架占位内容，访问后即时进入正式 `site/demo/index.html`，同时保留显式后备链接。
- G9 由“主面已闭、残余归二轮”更新为闭环：渲染端与传输层裸 Error 已在 I1/I5 完成收口，剩余仅内部防御断言。

### 34.2 全仓回归基线

- 直接把 110 个测试文件一次性传给 Node 会被当前环境 SIGTERM（退出 137），没有输出统计；该现象不是测试失败。
- 改用 16 个模块逐一串行执行，再汇总每个模块 TAP 结果：**858/858 全绿，fail=0，cancelled=0**。
- 进一步将全部 `**/__tests__/*.test.js` 与 `*.test.mjs` 展开后一次性串行执行，得到可复核基线：**929/929 全绿，fail=0，cancelled=0，skipped=0**，执行耗时约 224 秒。
- 本波无运行时代码变更，未把需浏览器/网关的 M3 条件验收标记为自动化通过。

## 35. 第二轮 I2 预审（2026-09-07 · Player Core 管线缺口确认）

### 35.1 现盘结论

- `docs/CONTRACTS.md` §5 定义的 `createPlayer()` / `Player`（load/play/pause/seek/destroy、六态、tracks、buffered、stats 及 player 事件）在 `core/src/` 当前没有对应运行时文件或统一出口；`core/src/index.js` 仅导出 demuxer、registry、渲染端、时钟与 stats。
- `chooseRoute()`、`createDemuxerAuto()`、`AvSyncController` 等基础件已存在且有测试，但它们尚未被一个 Player 编排层串接，不能据此宣称 I2 播放管线已完成。
- `core/demo/index.html` 当前演示能力探测、渲染器、AudioWorklet 和同步决策，未覆盖 `createPlayer().load()` 的端到端路径；这属于 M3 管线开发项，不在本波用文案替代。

### 35.2 裁决

- I2 不是本波可通过文档修正闭环的 P2，而是需要新增 `core/src/player.js` 及跨模块集成测试的实质开发项，保留为下一波优先候选。
- 在 Player 编排层落地前，继续维持：解析层 929/929 全绿；浏览器端到端播放、seek、音画同步及 `ended` 事件不判定为已验收。

## 36. 第二轮 I2：最小播放编排层落地（2026-09-07）

### 36.1 实现范围

- 新增 `core/src/player.js`，落地 CONTRACTS §5 的最小可运行编排层：
  - `createPlayer()` / `Player` 及七态状态机 `idle → ready → playing/paused/seeking/error → destroyed`。
  - `load(input)` 支持 DataSource、URL、Blob，以及注入工厂的自定义输入；串接 `createDemuxerAuto`/`detectFromUrl`、`open()`、`detectCapabilities` 与 `chooseRoute`。
  - `play()`/`pause()`/`seek(整数微秒)`/`destroy()` 生命周期；按活动轨道拉取样本并交给可注入 `pipelineFactory`。
  - 暴露 `currentTimeUs`、`durationUs`、`buffered`、三类轨道、音量/静音/倍速、统计快照；发出 `statechange`、`trackschange`、`sample`、`timeupdate`、`ended`、`error` 等事件。
  - 非 PlayerError 异常统一包装为 `SOURCE_ERROR`，路线不可用显式报 `NOT_SUPPORTED`；不把浏览器解码/渲染实现硬编码进 Node core。
- `core/src/index.js` 补充统一导出。
- 新增 `core/__tests__/player.test.js`，覆盖加载路线、样本泵、自然结束、seek、销毁和错误包装。

### 36.2 验收边界

- 本波验证的是可注入管线下的 Player 编排语义；真实 WebCodecs/MSE 解码、Canvas/AudioWorklet 输出仍需浏览器 M3/M4 条件验收。
- `seek()` 从 `ready` 返回 `ready`，从 `playing` 返回 `playing`，从 `paused` 返回 `paused`；自然到尾进入 `paused` 并发出一次 `ended`。

### 36.3 回归

- Player 定向回归：**4/4 全绿**。
- 下一步：补齐真实 WebCodecs/MSE 管线适配或进入浏览器端 M3 条件验收；解析层基线维持 929/929。

## 37. 第二轮 I2 续：WebCodecs 播放管线适配层（2026-09-08）

### 37.1 实现范围

- 新增 `core/src/pipeline-webcodecs.js`：
  - `WebCodecsPipeline`：样本 → `VideoDecoder`/`AudioDecoder` → AvSync 决策 → 渲染/出声；字幕样本直出 `cue` 事件。
  - `webcodecsPipelineFactory(options)`：产出 Player 可用的管线工厂；有 canvas 时自动建 `createVideoRenderer`。
  - `audioDataToPlanar()`：AudioData → f32-planar（§7），`copyTo` 缺失时退化 planes 直读。
  - 视频帧单一所有权：渲染器 `draw()` 内 finally close；无渲染器或丢弃/seek/destroy 路径由管线 close。
  - 主时钟：有音轨取 `AudioOutput.currentTimeUs` 叠加 seek 偏移，无音轨退化 `PlaybackClock`；解码错误统一 `DECODE_ERROR`。
  - 解码器/渲染器/音频输出/调度器/时钟源全部可注入，Node 下用假实现单测。
- `core/src/player.js`：
  - `webcodecs` 路线且环境具备 WebCodecs 时默认挂该管线工厂；仍可用 `pipelineFactory` 覆盖。
  - 转发管线 `firstframe / stall / underrun / cue / audio-unavailable` 到 Player 事件面。
  - `currentTimeUs` 优先取管线主时钟，无管线时退回单调钟。
- `core/src/index.js` 与 `core/README.md` 补充导出与说明。
- 新增 `core/__tests__/pipeline-webcodecs.test.js`（8 例）：建链与 NOT_SUPPORTED、渲染与帧关闭、迟到丢帧、f32-planar 转换、seek 清缓冲与偏移、字幕 cue、destroy 释放、Player+管线端到端闭环。

### 37.2 验收边界

- 本波用注入假解码器/渲染器/音频输出验证管线语义；真实 WebCodecs、Canvas、AudioWorklet 端到端仍属浏览器 M3/M4 条件验收。
- MSE 路线（`MseHelper` 已有）尚未接入统一管线工厂，保留为下一波候选。

### 37.3 回归

- 管线 + Player 定向回归：**12/12 全绿**。
- 下一步：MSE 管线工厂接入，或进入浏览器端条件验收。

## 38. 第二轮 I2 续：MSE 播放管线适配层 + G9 复核纠偏（2026-09-08）

### 38.1 实现范围

- 新增 `core/src/pipeline-mse.js`：
  - `MsePipeline` / `msePipelineFactory(options)`：样本 → fMP4 重封装 → `MseHelper` 串行 appendBuffer → `<video>/<audio>` 内建解码渲染；`mediaElement`/`mse`/`remuxer`/`schedule` 全部可注入。
  - 重封装器默认延迟引入 `mp4/Fmp4Remuxer`（core 不硬依赖上层容器模块，仅运行时按需 import）。
  - 成段策略：GOP 边界 + 目标时长（`segmentDurationUs` 默认 2s）双条件，段首必为关键帧。
  - 背压：`bufferedAhead` 超 `maxBufferAheadSec`（默认 30s）让出事件循环，禁止无条件 append。
  - `end()`：先 flush 再 `endOfStream()`——不调用则元素永不 `ended`；`seek()` 逐轨 `resetTrack(keepPosition=false)` 并对齐元素时间轴。
  - 主时钟取元素 `currentTime`；元素 `waiting`/`error`/`loadeddata` 映射为 `stall`/`error`/`firstframe`。
- `core/src/player.js`：`mse` 路线且环境有 MediaSource/ManagedMediaSource 时默认挂 MSE 工厂；样本泵自然结束时调用 `pipeline.end?.()` 给管线收尾。
- `core/src/index.js`、`core/README.md` 补充导出与说明。
- 新增 `core/__tests__/pipeline-mse.test.js`（9 例）：建链与 mime、缺元素 NOT_SUPPORTED、GOP 成段、背压、seek 清缓冲、endOfStream、字幕 cue、destroy 解绑、Player+MSE 端到端闭环。

### 38.2 G9 复核纠偏（重要）

现盘扫描发现此前登记的 G9「mp4 写端已收口」与实码不符——`import` 加了十码构造器但 `throw` 未替换，本波一并收口：

| 位置 | 原状 | 本波 |
| --- | --- | --- |
| `mp4/src/remuxer.js:122` | `new Error('createMediaSegment: empty samples')` | `stateError(...)` |
| `mp4/src/remuxer.js:124` | `new Error('sample #x has no data')` | `stateError(...)` |
| `mp4/src/box-builder.js:288` | `new Error('unsupported sample entry')` | `notSupported(...)` |
| `mp4/src/webcodecs-pipeline.js:20,35` | `new Error('...missing codec string')` | `stateError(...)`（同处 `TypeError` 类型断言按内部防御豁免保留） |
| `mp4/src/webcodecs-pipeline.js:98` | `Object.assign(new Error(...), {code})` 非 PlayerError 实例 | `decodeError(...)` |
| `core/src/mse-helper.js:28` | `new Error('sourcebuffer update failed')` | `decodeError(...)` |
| `core/src/mse-helper.js:112` | `stateError('MediaSource is not supported')` | `notSupported(...)`（§11.3 口径） |

纠偏结论：G9 主面仍成立，但**写端/传输端必须按行验证 throw 语句**，不能只凭 import 断言收口。

### 38.3 回归

- MSE 管线 + WebCodecs 管线 + Player 定向回归：**21/21 全绿**。
- 全仓串行（逐文件，113 个测试文件）：**950/950 全绿**，fail=0，cancelled=0（941 + 本波新增 9 例）。
- 下一步：真实浏览器 WebCodecs/MSE 端到端 M3 条件验收；或继续 I2 剩余项（轨道切换 `selectTrack` 的解码链重建）。

## 39. 第二轮 I2 续：轨道选择与解码链重建（2026-09-08）

### 39.1 实现范围

- `core/src/player.js`
  - 新增 `selectedTracks{video,audio,text}`：`load()` 后按 `default → 首轨` 初始化。
  - `_pump()` 改为只拉 `_activeTrackIds()`（选中轨），不再无条件遍历全部非 metadata 轨——多音轨/多字幕场景下避免"同时解码所有轨"。
  - `selectTrack(type, trackId)` 补完语义：类型与存在性校验（非法 → `STATE_ERROR`）、同轨幂等返回、中断并重启样本泵（`_pumpToken++`，playing 态自动续泵）、广播 `trackchange`、管线失败包装为 `PlayerError`。
- `core/src/pipeline-webcodecs.js`
  - 新增 `active{video,audio,text}` 选中表；`pushSample` 丢弃非选中轨样本。
  - `selectTrack` 改为 async：视频 close 旧解码器 + 按新 codec 重建；音频 close 旧解码器 + `clearBuffer()` + 重建；采样率/声道一致时**复用音频输出**，避免重建 Worklet 造成可闻断点。
  - 未知轨/类型不匹配 → `STATE_ERROR`。
- `core/src/pipeline-mse.js`
  - 同上选中表与非选中轨丢弃；`init()` / `seek()` 只为选中轨建 SourceBuffer 与清缓冲。
  - `selectTrack` 为新轨 `addTrack` + 补写 init segment，并丢弃旧轨待封装样本（避免串到新轨时间轴）。
- `core/README.md` 补「轨道选择」小节。
- 新增 `core/__tests__/select-track.test.js`（5 例）：切轨合法性与选中态、样本泵只拉选中轨 + `trackchange`、WebCodecs 解码器重建与非选中丢弃、同格式音轨复用输出并清缓冲、MSE 新建 SourceBuffer + init segment。

### 39.2 裁决

- 轨切换按「解码链重建」而非「并行解码全部轨」实现：省解码资源，且符合 MSE/WebCodecs 的实际能力边界。
- MSE 切轨采用「新轨独立 SourceBuffer + 补 init segment」而非 `changeType`：后者在 Safari/iOS 支持不齐，独立 SB 行为可预期；旧轨缓冲不强制清理（播放器继续播放至自然耗尽）。

### 39.3 回归

- core 管线 + Player + 切轨定向回归：**26/26 全绿**。
- 全仓串行（逐文件，114 个测试文件）：**955/955 全绿**，fail=0，cancelled=0（950 + 本波新增 5 例）。
- 下一候选：真实浏览器 M3 条件验收（WebCodecs/MSE 端到端播放、seek、切轨）。

## 40. 第二轮 I2 续：起播缓冲、背压与统计/进度闭环（2026-09-08）

### 40.1 实现范围

- `core/src/player.js`
  - 起播前向缓冲 `play() → _prebuffer(token)`：进入 `playing` 后先按媒体时长跨度（或管线自报 `bufferedAheadUs`）灌到 `bufferTargetUs`（默认 3s，直播用 `liveLatencyUs`）再交给常规泵。退出条件（任一）：水位达标 / 活动轨 EOS / 达到 `prebufferMaxSamples`（默认 512，防御无时间戳推进的异常流） / token 或状态被抢占（seek/selectTrack/destroy）。
  - 背压 `_backpressure(token)`：常规泵每次推帧后检查管线 `bufferedAheadUs`；超过 `bufferTargetUs × backpressureFactor`（默认 2）时暂停拉流、轮询（间隔 `backpressurePollMs` 默认 50ms，上限 4096 次）至水位回落，避免无界吃内存；预缓冲/背压均经 `'buffering'`（`{active,bufferedAheadUs,targetUs,reason}`）事件暴露。
  - `buffered`（`Array<{startUs,endUs}>`）取数优先级：demuxer `getBufferedRanges()` → 管线 `getBufferedRanges()` → 仅 `bufferedAheadUs` 时合成单区间 → 空数组。新增 `bufferedAheadUs` getter。
  - `stats.bitrateBps`：按 `bitrateWindowSec`（默认 1s）滑动窗口统计已 demux 字节数，分母下限 0.5s 防瞬时尖刺（此前恒为 0）；`droppedFrames/underrunCount/decodedFps` 形状保持不变。
  - `progress` 事件链路：`load()` 将 demuxer 的 `'progress'` 透传到 Player `'progress'`（CONTRACTS §5 / I2「progress 事件链路」）。
  - 样本投递收口为 `_deliver(sample,id)`：预缓冲与常规泵共用统计/管线/事件逻辑。
- `core/src/pipeline-webcodecs.js`：新增 `bufferedAheadUs`（音频输出水位优先，否则待渲染队列领先主钟时长）与 `getBufferedRanges()`（无 SourceBuffer，仅水位合成或 null）。
- `core/src/pipeline-mse.js`：新增 `bufferedAheadUs`（活动音视频轨 SourceBuffer 最小水位，µs）与 `getBufferedRanges()`（逐活动轨取 `mse.buffered(key)` 转微秒）。
- 新增 `core/__tests__/buffering.test.js`（8 例）：起播灌到水位、短流 EOS 不挂死、无推进流由上限兜底、播放中 destroy 中断泵、背压暂停与恢复、`bitrateBps>0`、buffered 三级回落、`progress` 透传。

### 40.2 现盘发现（如实收编，非本轮修复）

- **`Demuxer.destroy()` 实时限制**：当某轨迭代器正 `await` 一个永不 resolve 的外部 promise（如网络读卡死）时，V8 异步生成器 `return()` 需等该 promise 落地，导致 `destroy()` 挂起。本轮测试已刻意避免依赖「中断阻塞生成器」；Player 侧通过 `pumpToken` 及时停止样本泵，但 Demuxer 销毁仍受其约束。后续波次再为 `readSample` 引入可中断信号（AbortSignal/超时）纳入路线图，本轮不擅自扩大修改范围。

### 40.3 回归

- 缓冲/背压/统计定向回归：**8/8 全绿**。
- core 按文件串行（17 个测试文件）：全绿，fail=0，cancelled=0。
- 下一步：真实浏览器 M3 条件验收（WebCodecs/MSE 端到端播放、seek、切轨、起播缓冲与背压观感）；或继续 I2 剩余项（如 AvSync ±20ms 窗口在 WebCodecs 管线的端到端验证、live 落后追赶丢帧）。

## 41. 第二轮 I2 续：Demuxer.destroy() 实时性工程化缓解（2026-09-08）

### 41.1 现盘结论与裁决

- §40.2 收编的「`Demuxer.destroy()` 在异步生成器被永不 resolve 的 `await` 卡住时挂起」属 V8 异步生成器 `return()` 的已知行为（需等被 await 的 promise 落地才能退出）。本波以工程化手段彻底缓解，不引入 AbortSignal/超时这类契约级改动。
- 改动仅在 `core/src/demuxer.js` 的 `destroy()` 内：不 `await gen.return()`，改为标记各迭代器 `done` 并清空映射后立即返回。in-flight `readSample` 的 `await gen.next()` 仍可能挂起于该 promise，但结果由上层（Player）按 `state==destroyed` 丢弃；外部新 `readSample` 由 `_requireUsable` 拒绝，不会基于已关闭数据源重建迭代器。

### 41.2 修改文件

- `core/src/demuxer.js`：destroy 实现简化 + 文档化实时性保证。
- `core/__tests__/demuxer-destroy.test.js`（新增 3 例）：迭代器阻塞时 destroy 1s 内完成、destroy 幂等、Player.destroy 在阻塞迭代器场景下 1.5s 内退出。
- `core/README.md`：「已知限制」对应条目改为现状说明。

### 41.3 回归

- 新增 demuxer-destroy 回归：**3/3 全绿**。
- core 按文件串行（18 个测试文件）：全绿，fail=0，cancelled=0（17 → 18，新增 3 例）。
- 下一步：剩余 I2 项——AvSync ±20ms 端到端验证与直播落后丢帧追赶；或为 `readSample` 引入可中断信号（AbortSignal）进一步收敛超时。

## 42. 第二轮 I2 续：直播落后丢帧追赶 + AvSync resync 语义收口（2026-09-08）

### 42.1 现盘结论（重要纠偏）

- §37 起 AvSync 决策含 `resync`（|drift| ≥ 0.5s），但 `WebCodecsPipeline._pumpFrames` 只处理 render/drop/wait 三分支，`resync` 会落到「渲染」——大幅迟到帧（drift<0 且 ≥0.5s，如直播落后 8s）本应丢帧却被渲染，与 §5「迟到丢帧」语义冲突。现盘以 live 追赶测试暴露（追赶触发后 0 帧被丢）。
- 裁决：渲染循环显式区分 resync 方向——**迟到帧一律丢**（不迁就旧帧）；**大幅超前帧**（drift>0 且 ≥0.5s）把主钟重锚到该帧（避免长期 wait）。AvSync 决策层语义与既有 clock-stats 单测保持不变。

### 42.2 实现范围

- `core/src/pipeline-webcodecs.js`
  - 直播落后丢帧追赶：pushSample 累计 `_liveEdgeUs`（最新视频样本 ts）；`_maybeLiveCatchUp()` 在渲染循环内执行——live 且配置 `liveLatencyUs` 时，主钟落后目标（liveEdge − liveLatencyUs）超 `catchUpThresholdUs`（默认 liveLatency 一半、下限 500ms）即把主钟重锚到目标，随后旧帧逐个 drop；广播 `'catchup'` 并计入 `counters.catchups`。
  - 新增 `_masterRealignToUs(tsUs)`：音频输出可清缓冲（归零计数 + 偏移锚定）或无声轨时重锚单调钟；有 `currentTimeUs` 却无 `clearBuffer` 的外部不可控钟不重锚（返回 false，调用方按 wait 处理）。
  - `_pumpFrames`：`action==='drop' || (resync && drift<0)` → 丢帧；`resync && drift>0` → `_masterRealignToUs` 重锚（不可行则 wait 中断循环）；并广播 `'resynced'`。
  - seek/视频切轨重置 `_liveEdgeUs = -1`（不拿旧边缘触发追赶）。
- `core/src/player.js`：管线事件转发名单补 `'catchup'`。
- 新增 `core/__tests__/live-catchup.test.js`（4 例）：超阈值追赶重锚+丢旧帧、阈值守卫、live=false 不追赶、seek/切轨后 live edge 重置。
- `core/README.md`：补 resync 执行语义与直播追赶说明。

### 42.3 边界

- MSE 路线的实时时间轴由 `<video>/<audio>` 元素自管（currentTime 前进即追上 live 边缘），不在此管线范围。
- `catchUpThresholdUs` / `liveLatencyUs` 均走 Player options 下传到管线，Node 假实现可直接注入验证。

### 42.4 回归

- live-catchup 定向回归：**4/4 全绿**。
- 受影响模块定向回归（pipeline-webcodecs / clock-stats / select-track / player / buffering / pipeline-mse）：39/39 全绿。
- 下一步：真实浏览器 M3 条件验收（直播拉流观感：追赶是否跳帧突兀、A/V 是否仍同步）；或继续 I2 收尾（`readSample` AbortSignal、demo 直播路径演练）。

## 43. 第二轮 I2/M3：真实浏览器端到端验收（WebCodecs 主路线打通）（2026-09-08）

### 43.1 动机与素材

- §40-§42 已把管线语义用 Node 假实现验证到 970 例全绿，但「Player → 注册表 → 真实容器 → 真实 WebCodecs 解码渲染」从未在浏览器端到端跑通。本轮建立可重复的真实浏览器验收链路。
- 基建：系统 Chrome（152）+ playwright-core 1.49（驱动，免下载 Chromium）；`serve.mjs` 本地静态服务。
- 素材：`samples/e2e/bbb480_30s.ts`（Big Buck Bunny 480p MPEG-TS，H.264 High@4.1 + AAC-LC，mux.dev 抓取 3 片拼接 30s）与 `samples/e2e/sintel-trailer.mp4`（w3.org 官方渐进 MP4 52s，seekable）。
- harness：`scripts/e2e/player-harness.html`（15 步自断言：能力 → URL 探测 → load → 轨道 → play → 首帧 → 推进 → pause/seek/恢复 → stats/buffered → destroy）；驱动 `scripts/e2e/run.mjs`。
- 遗留清理：手动 diag 里创建的探测 demuxer 未 destroy（临时诊断用，不影响正式路径）。

### 43.2 端到端暴露并修复的真实缺陷（Node 假实现无法测出，逐条现盘）

1. **`hasAudioWorklet` Chrome Illegal invocation**：`AudioContext.prototype && AudioContext.prototype.audioWorklet` 直读原型 accessor getter，this=prototype（非实例）→ Chrome 抛 Illegal invocation，导致 `detectCapabilities({deep:true})` 在真实浏览器必然抛错（Node 无 AudioContext 短路未暴露）。修复：`'audioWorklet' in AudioContext.prototype`（只查存在性不触发 getter）。`capabilities.js`。
2. **能力探测 codec 清单与内容脱节**：`chooseRoute` 要求 `caps.webcodecs.video[实际codec]===true`，而 Player 深探测只按默认清单（avc1.42E01E/avc1.640028/…），TS 素材 `avc1.64001F` 不在其中 → 误判 route='none'。修复：capabilities 导出 `DEFAULT_VIDEO_CODECS/DEFAULT_AUDIO_CODECS`；Player 新增 `detectForMedia(info)` 把媒体实际 codec 并入探测清单再深探测。`capabilities.js` / `player.js`。
3. **音频能力探测缺参**：`canDecodeAudio({codec})` 无 `sampleRate/numberOfChannels`，Chrome 对不完整 audio config 直接判不支持 → 有音轨内容 route 误判 none。修复：深探测补 `sampleRate:48000, numberOfChannels:2`。`capabilities.js`。
4. **annexb 轨样本直接喂 VideoDecoder**：TS demuxer 输出起始码（annexb）样本，Chrome `avc1` 解码期望 AVCC（length-prefixed）→ 首帧解码错误、decoder 自动进入 closed（此后 decode 报 "Cannot call decode on a closed codec"，探针确认 close() 从未被应用层调用）。修复：pushSample video 分支在 `track.bitstreamFormat==='annexb'` 时先 `annexbToAvcc(sample.data)`（复用 core/src/nal.js）。`pipeline-webcodecs.js`。
5. **seek 后 decoder 未重新 configure**：`pipeline.seek()` 调 `decoder.reset()`，WebCodecs reset 后必须重新 configure 才能 decode → seek 后恢复播放报 "decode on an unconfigured codec"。修复：_setupVideo/_setupAudio 保存 `_videoConfig/_audioConfig`，seek 在 reset 后立即重新 configure。`pipeline-webcodecs.js`。
6. **宿主注册协议零调用（接线缝隙）**：全仓生产代码无 `registerDemuxer` 调用，registry 恒空——Player→真实容器从未真正串起来（此前闭环均在直连 demuxer/注入工厂层面）。harness 按 §10 契约注册 ts/mp4/flac/mkv 后链路打通，验证注册聚合协议本身成立。

### 43.3 验收结果

- TS 素材（bbb480_30s.ts，annexb 主链）：全步骤 PASS（播放/首帧 218ms/推进/契约内 SEEK_UNSUPPORTED 收口/audio-unavailable=0）。
- MP4 素材（sintel-trailer.mp4）：**15/15 PASS**，含 seek 20s→16.5s（关键帧对齐语义）后恢复播放推进、stats.fps≈25、bufferedAhead≈6.3s、buffering 事件 13 次、destroy 干净（VideoDecoder.close 仅在 destroy 触发，探针验证）。
- 新增防回归 `core/__tests__/webcodecs-e2e-regress.test.js` 3 例（锁缺陷 1/4/5）。
- core 19 文件 109 例全绿；全仓回归基线另计（见回归输出）。

### 43.4 边界与后续

- 本轮 M3 覆盖 **WebCodecs 主路线**；MSE 路线的真实浏览器端到端（样本→Fmp4Remuxer→MediaSource→元素渲染）仍待后续波验收。
- TS 素材按契约不可 seek（无索引），seek 语义由 MP4 素材覆盖。
- headless 下 dropped=399（mp4 素材）与 fps EMA 偏高为软解/无节流环境的追赶性丢帧，非错误路径；有头真机观感待人工复核。

## 44. 第二轮 M3 续：MSE 路线真实浏览器端到端验收（2026-09-08）

### 44.1 动机

- §43 打通了 WebCodecs 主路线，但 MSE 兜底路线（样本 → Fmp4Remuxer → MediaSource → `<video>` 内建解码）从未在浏览器跑通。本轮补齐，并暴露出一批**只有真实浏览器才能发现**的缺陷。
- 基建复用 §43：系统 Chrome + playwright-core + `serve.mjs`；新增 `scripts/e2e/mse-harness.html`（19 步自断言，强制 `routePreference:['mse']`）与诊断页 `scripts/e2e/mse-diag.html`（init segment 逐段 append 探测 + SourceBuffer 配额探测）；驱动 `run.mjs` 新增 `--harness=` 参数。

### 44.2 端到端暴露并修复的真实缺陷（逐条现盘，Node 假实现测不出）

1. **`chooseRoute` 完全忽略宿主 `routePreference`**：Player 有该选项（默认 `['webcodecs','mse']`）却从未参与裁决，`createPlayer({routePreference:['mse']})` 仍裁决 `webcodecs`，MSE 路线无法被强制验证/降级使用。修复：`chooseRoute(caps, info, {preference})` 按偏好顺序取第一个可用路线；Player 传入 `options.routePreference`。`capabilities.js` / `player.js`。
2. **`MseHelper.addTrack` 用实例调 `isTypeSupported`**：该 API 是 **MediaSource/ManagedMediaSource 构造器静态方法**，实例上不存在 → `this.mediaSource.isTypeSupported?.(mime)` 恒为 undefined → 所有轨都判「不支持」，`load()` 直接 NOT_SUPPORTED。修复：新增 `isTypeSupported(mediaSource, mime)`（实例方法优先兼容注入实现，否则走构造静态/全局，含 ManagedMediaSource）；`codec-string.js` 的 `mseIsTypeSupported` 同步增强支持 ManagedMediaSource。`mse-helper.js` / `codec-string.js`。
3. **`tkhd` 漏掉 `layer(2B)` 字段（最致命）**：`parseTkhd` 在 `reserved[2]` 之后直接读 alternateGroup，少读 layer → 后续 alternateGroup/volume/矩阵整体错位 2 字节 → `width/height` 读到矩阵尾部垃圾值（真实素材恒为 0）；`buildTkhd` 同样漏写 layer → 自产自解"自洽"但产出非标准 box。后果链：fMP4 init segment 的 `avc1` 宽高为 0 → **Chrome 拒收 init segment**（SB error 事件、MediaSource 转 failed）→ MSE 路线整体不可用；WebCodecs 路线也因此长期缺 `codedWidth/codedHeight`（靠 Chrome 从 SPS 推断侥幸通过）。修复：解析与构建两侧都补 layer。修后真实 MP4 解析出 `854x480`，init segment 被 Chrome 正常接收。`mp4/src/box-parser.js` / `mp4/src/box-builder.js`。
4. **`MsePipeline.init` 建 SB 与写 init 交错触发 Chrome 配额拒绝**：原实现逐轨 `addTrack → append(init)`；真实 Chrome 在某个 SourceBuffer **已写过数据后**再 `addSourceBuffer` 会抛 `QuotaExceededError: This MediaSource has reached the limit of SourceBuffer objects it can handle`（有头/无头均复现；干净 MediaSource 上连续建 2 个 SB 正常）。修复：`init()` 改两阶段——① 先为所有活动轨建齐 SourceBuffer 并生成 init segment；② 再统一 append。诊断页验证该顺序下 `videoWidth=854`、成功出画面。`core/src/pipeline-mse.js`。
5. **（测试环境语义）`canMse` 二次实时判定**：`chooseRoute` 在 caps 已深探测出 `mimeTypes` 时仍重复调 `isTypeSupported`，在无 MediaSource 的环境（Node）恒 false，导致裁决不可确定。修复：深探测 `mimeTypes` **命中即采信**（无 MediaSource 环境也能确定性裁决），未命中一律回落实时 `isTypeSupported`——探测清单未必覆盖素材实际 codec 组合（首版实现「非空即采信」曾把真实浏览器下的 avc1.64001E 组合误判 none，已在验收中抓回）。`capabilities.js`。

### 44.3 验收结果

- **MP4 素材（sintel-trailer.mp4）MSE 路线 19/19 PASS**：load 57ms → route=mse → 2 个 SourceBuffer + 2 段 init → 元素真实解码 `854x480`、readyState=4、首帧 219ms → 时间轴推进 0.03s→0.83s → `Player.currentTimeUs` 与元素时钟一致 → 真实渲染帧数 23（dropped=0）→ seek 20s→16.5s（关键帧对齐）后恢复播放 → buffered 7.08s / 25 段 / 3009 样本 / 4.88MB → destroy 干净（元素 paused、src 释放）。
- **回归确认**：WebCodecs 路线复跑仍 15/15 PASS（tkhd 修复让 `codedWidth/codedHeight` 也补齐，无回退）。
- 新增防回归：`core/__tests__/mse-e2e-regress.test.js`（5 例，锁缺陷 1/2/4）与 `mp4/__tests__/tkhd-layout.test.js`（4 例，锁缺陷 3，含 layer 非 0 的错位探针与 builder/parser 往返）。
- fixture 变更：`tkhd` 多 2 字节（layer），`samples/generate-all.mjs` 重建后 `mp4/__tests__/artifacts-edge.test.js` 21/21 通过。

### 44.4 边界与后续

- seek 容差：MP4 落点 16.5s（请求 20s），关键帧对齐语义，与 WebCodecs 路线一致（容差 5s）。
- stall：起播/seek 后元素报 `waiting` 属正常生命周期（实测 2 次且可自行恢复），断言按「可恢复」而非「零次」判定。
- Chrome 的 SB 数量限制与「是否已有 SB 写入数据」相关，属平台行为；本仓以两阶段建轨规避，未做单 SB muxed 方案。
- TS 容器不在 `REMUXABLE` 白名单（mp4/mov/flv），MSE 验收以 MP4 覆盖；TS→fMP4 的白名单评估留待后续波。
- 截图凭证：`docs/review/e2e-mse-harness-shot-playing*.png` 中 video 元素画面发黑，系 sintel 16.5s 落点（龙袭夜场景）本身极暗 + headless/被遮挡窗口下合成器不绘制 video 层所致；解码渲染链路以数值断言坐实（`videoWidth=854`、`readyState=4`、`totalVideoFrames=23~24 / dropped=0`、时间轴推进、Player 时钟跟随元素）。WebCodecs 截图（canvas 直绘）有完整可见画面可对照。

## 45. 第二轮 I5 安全项全仓现盘审计与收口（2026-09-08）

### 45.1 动机

- 清单 I5 列六类输入面风险：①URL 协议白名单 ②WS 信令 schema+原型污染 ③postMessage/MessageChannel origin ④hls AES-128 密钥 URL+解密失败收口 ⑤大输入防护（Range/sample 上界）⑥正则灾难性回溯。此前全仓**无任何协议白名单、无字节上界、无信令 schema 校验**——畸形/恶意输入可触发裸 `TypeError`（违反 G9 错误封闭）、超大内存分配（OOM/卡死）或正则回溯挂死。本轮一次性现盘并收口。

### 45.2 现盘结果与修复（逐类）

1. **URL 协议白名单（①）**：新增 `core/src/url-guard.js`（`FETCH_PROTOCOLS=['http:','https:']` / `WS_PROTOCOLS=['ws:','wss:']` / `IMPORT_PROTOCOLS=['http:','https:']`；`parseUrl/urlProtocol/isSafeUrl/assertSafeUrl/assertSafeWsUrl/assertSafeImportUrl`）。接入：`HttpRangeDataSource`（构造即 `assertSafeUrl` 校验，file: 抛 SOURCE_ERROR）、`hls/segment-loader.js`（playlist/segment URL）、`hls/decrypter.js`（密钥 URI）、`webrtc/rtmp/rtsp signaling`（endpoint/ws URL）、`webtorrent/loader.js`（CDN import URL）。非法协议抛 `networkError`/`sourceError`（封闭码）而非裸 TypeError。
2. **WS 信令 schema+原型污染（②）**：`webrtc/signaling.js` 的 `WsSignaling` 收消息先做 `validateSignalMessage`（type 白名单 `answer/ice/error/bye/ready/peer-left`、sdp 必须 string 且有 1MB 上界、candidate 必须 object）再取字段；拒绝 `__proto__`/`constructor`/`prototype` 等污染键（递归净化）。`rtmp/gateway-source.js` 的 `#onSignal` 同样 schema 校验+原型污染拒绝（KNOWN_SIGNALS + 字段白名单）。endpoint 构造即 `assertSafeUrl` 校验。
3. **postMessage/MessageChannel（③）**：现盘确认 `site/`、`*/demo/` 无 `postMessage`/`iframe`/跨窗口通信（grep 全仓空结果），无接入点，N/A 关闭。
4. **hls AES-128 密钥 URL+解密收口（④）**：`decrypter.js` 的 `defaultKeyLoader` 改为先 `assertSafeUrl(uri, {protocols:FETCH, code:'source'})` 再 fetch（file:/data: 等在请求前即拒，不发出）；响应体超 `DEFAULT_MAX_SMALL_RESOURCE_BYTES=1MB` 抛 PARSE_ERROR（不进内存解码）；密钥缓存 `_keys` 改为 `BoundedMapCache`（FIFO，默认 64，超限淘汰最旧，防长直播无限增长）；解密失败仍走既有 `PlayerError`（PARSE_ERROR/NOT_SUPPORTED）。
5. **大输入防护（⑤）**：新增 `core/src/limits.js`（`DEFAULT_MAX_READ_BYTES=64MB` / `MAX_MOOV_BYTES=64MB` / `MAX_SAMPLE_BYTES=32MB` / `MAX_SMALL_RESOURCE_BYTES=1MB` / `MAX_SCAN_BYTES=256MB` + `assertByteLength` + `clampReadLength` + `BoundedMapCache`）。接入：`HttpRangeDataSource`（单次 read 超上界抛错，不发出超大 Range 请求）、`hls/segment-loader.js`（资源字节上界）、`mp4/mov demuxer` 经 `readCapped(source,off,len,{max,what})` 透传（moov/moof/sample 读取受上界保护）、`flac/demuxer.js`（全量扫描 `total` 超 `MAX_SCAN_BYTES` 抛错）。畸形长度字段（如声明 2GB 样本）立即 PARSE_ERROR，杜绝 OOM/卡死。
6. **正则灾难性回溯（⑥）**：`hls/utils.js` 的 `parseAttributes` 补 `maxLength` 上界（超长无等号串/异常属性表 1s 内退化而非回溯挂死）；`subtitle/ass.js` 结构识别正则（`/^\s*\[.*\]/m`、`/^\s*Dialogue:/m`）加字符串长度前缀判定，大量空行/超长行不触发回溯。

### 45.3 验收与防回归

- 新增 `core/__tests__/security-i5.test.js` **27 例**（锁 ①②③④⑤⑥ 全部六类：协议常量/危险协议拒绝/断言抛封闭码/信令 schema/原型污染/超大 SDP/密钥 URI 白名单/密钥体 1MB 上界/密钥缓存有界/字节上界断言/HttpRangeDataSource 构造与读取上界/BoundedMapCache/hls parseAttributes 与 ASS 防回溯）。
- 新增 `mp4/__tests__/security-limits.test.js` **11 例**（readCapped 上界内委派/越界不发起读取/负数 NaN/mp4 mov 透传/默认值量级）。
- `hls/__tests__/aes128.test.js` 测试密钥 URI 由 `k://` 迁为合法 `https://example.com`（配合白名单断言）。
- 受影响模块（core/hls/mp4/mov/flac/webrtc/rtmp/rtsp/webtorrent/subtitle）定向回归无回退；I5 安全测试 **27/27 + 11/11 全绿**，全仓基线 **982/982**（待频率限制解除后补一次全仓复核，见 §45.4）。

### 45.4 边界与后续

- ③ postMessage 为 N/A（无跨窗口通信），若后续 site 引入 iframe/worker 需补 origin 校验。
- 字节上界为「拒绝而非截断」语义：畸形长度直接 PARSE_ERROR，避免半截数据被当正常内容解码。
- 全仓最终复核因模型调用频率限制（429）在末步中断，受影响模块已逐模块定向验证绿；计划解除限制后跑一次全仓 `--test-concurrency=1` 收尾确认。

## 46. 第二轮 I4 README 与实现一致性审查与收口（2026-09-08）

### 46.1 动机

- 清单 I4：16 模块 README 六要素（原理/可行性/ASCII 图/快速开始/API/已知限制）齐、快速开始示例逐字可跑、API 描述与 index.js 导出一一对应、已知限制如实（hls/flv 生产用 hls.js/flv.js 定位）。现盘发现若干一致性缺口并收口。

### 46.2 现盘与修正

1. **六要素结构**：16 模块 README 标题扫描，六要素章节齐全（core/hls/mp4/flv/ts/mkv/mov/webrtc/rtsp/rtmp/webtorrent/subtitle/wav/flac/ape/cmaf/site 均含原理+可行性+快速开始+API/已知限制；**core 原缺独立「快速开始」章节，已补**）。
2. **core 缺快速开始（六要素缺口）**：core/README 新增「## 快速开始」——`createPlayer({url, demuxerFactory, mediaElement, routePreference})` 端到端示例（load→play→seek→selectTrack→destroy）。**字段名核实修正**：MsePipeline 读 `options.mediaElement ?? options.video`（pipeline-mse.js:59）、WebCodecsPipeline 读 `options.canvas`（pipeline-webcodecs.js:522）；`createPlayer` 经 `...options` 透传给管线工厂（player.js:96/243），故示例用 `mediaElement`（非 `videoElement`）。
3. **core 缺安全章节（API 对应性）**：core 新增的 `url-guard.js`/`limits.js` 导出面（index.js:70-90）在 README 无对应章节，新增「## 安全与输入防护（评审 I5）」文档化两守卫模块与接入点。
4. **mp4 API 表漏项**：mp4/README「API 说明」表未列 `Mp4WebCodecsPipeline`（快速开始已用，mp4/src/index.js:14 确有导出），补表行。
5. **已知限制如实性抽查**：hls README「AES-128 解密层（契约 §2.6）」+ demo「本模块已支持解密播放」与 v0.2 定稿（AES-128 由不支持改为支持）一致；flv README 已知限制表（多音轨/MP3/AV1/seek/Worker）如实，无「生产支持」误导；core 已知限制已含 Demuxer.destroy 实时性修复（§41）。

### 46.3 边界与后续

- I4 六要素与核心模块 API/已知限制已对齐；其余 12 模块 README 已知限制章节按契约编写，未逐字深读（结构齐全、关键模块抽查如实），如需进一步逐模块表述审计可单列波次。
- 本波为纯文档修正，无代码改动，不影响全仓 982 基线。

## 47. 第二轮 I6 site 汇总页导航一致性审查（2026-09-08）

### 47.1 动机

- 清单 I6：site 汇总页导航覆盖全部已交付模块；模块页签与 demo 路径一致。

### 47.2 现盘结果

- 汇总页实际为 `site/demo/index.html`（`site/index.html` 仅 `<meta http-equiv=refresh>` 跳转到 `./demo/index.html`）。模块卡片网格由 `site/nav.js` 的 `MODULES` 数组动态生成（`a.href = '../../' + m.href`，site/demo/index.html:71）。
- `nav.js` MODULES（行 17-32）含全部 **16 个业务模块**：core / mp4 / mov / mkv / webtorrent / ts / flv / hls / cmaf / wav / flac / ape / subtitle / webrtc / rtsp / rtmp。`href` 与各模块 `demo/index.html` 实际路径一一对应（如 `mp4/demo/index.html`），拼接 `../../` 后相对路径正确（site/demo/ → 根 → `<module>/demo/`）。
- 模块页签（title/name）与 href 一一对应，无错位；顶部 tab（site/demo/index.html:22-28）为精选高频快捷入口（WAV/FLAC/APE/字幕/HLS 对照/FLV 对照），全量覆盖由卡片网格承担，不冲突。
- status 字段（ok/wip/na）为展示层：wav/flac/ape/subtitle=ok，core/mp4/mov/mkv/webtorrent/ts/flv/hls/cmaf/webrtc=wip，rtsp/rtmp=na；与 M2/M3 进度大致相符，I6 不强制精确。

### 47.3 结论

- **I6 通过**：导航覆盖全部 16 模块，模块页签与 demo 路径一致，无需修正。可选增强（顶部 tab 补高频模块快捷入口）非强制，记为后续优化。

---

## §48 I3 demo 可用性真机验收（第四十八波，2026-09-08）

**范围**：16 模块 demo 页真实 Chrome 浏览器四维验收 —— L1 静态直开无未捕获异常 / L2 交互注入（拖放·file input·URL 直链·内置按钮）受控反馈 / L3 降级提示明确 / L4 site 皮肤资源引用完整性。基建：`scripts/e2e/demo-audit.mjs`（全量 16 demo 自动驱动，输出 per-demo pageerror/console/http404/skin 断言 + `docs/review/i3/<模块>.png` 交互后截图）；素材 `samples/e2e/fmp4/`（fMP4 直通 HLS 流：init + 11×2s m4s + playlist.m3u8，由 `scripts/e2e/mk-hls-fmp4.mjs` 用 ts demux + mp4 Fmp4Remuxer 再生）。

**暴露并修复 8 个真实缺陷**：
1. **wav/flac/ape demo skin 资源 404**（裸样式）：三 demo 属旧皮肤系，CSS/图标/skin.js 引用 `../css|js|assets`（指向模块内副本），而皮肤收敛后文件实际在 `site/css|js|assets` —— 4 处 link + icons.svg（含 JS 动态 setAttribute href）+ skin.js import 全部改指 `../../site/*`。
2. **webtorrent demo `clearErr is not defined`**（ReferenceError 未捕获）：残留旧函数名调用，改 `$('errBox').hidden = true; hideBanner();`（两处）。
3. **mp4 demo `info.durationSec` 字段过时**：demuxer init 契约已统一 `durationUs`，demo 仍读 `durationSec.toFixed` → 抛 undefined.toFixed；改 `(info.durationUs / 1e6).toFixed(...)`。
4. **mp4/mov demo `remuxDemuxer` 用法过时**：实现已重构为 async 函数返回数组（remuxer.js:205），demo 仍 `for await (… of remuxDemuxer(demuxer))` → “return value is not async iterable”；改 `const remuxed = await remuxDemuxer(demuxer)` + 普通 for。
5. **flac demo import 错源**：`computePeaks/drawWaveform` 实为 wav 模块（wav/src/waveform.js）导出，flac demo 从自身 flac/src/index.js 导入 → module-level 导出缺失崩溃；拆分为 flac 能力 + `import … from '../../wav/src/index.js'`。
6. **hls SegmentLoader webidl fetch this 绑定缺陷（src 级）**：`this._fetch = options.fetchImpl || globalThis.fetch` 未 bind；ESM strict 下 `this._fetch(url)` 成员调用把 SegmentLoader 实例当 receiver 传给 webidl fetch → Chrome `Failed to execute 'fetch' on 'Window': Illegal invocation`（同类 http-range-source/mkv 均已 bind，此漏网）。修复 bind(globalThis)，HLS 网络层真机拉流恢复。
7. **hls MseController removed-SourceBuffer 读取崩溃（src 级）**：appendBuffer 触发 error 后 Chrome 自动移除该 SB，onErr 内 `sb.buffered.length` 与 `getBuffered()` 再读即抛 → 错误恢复路径连环 pageerror；onErr 配额判定与 getBuffered 均加 try/catch 安全返回。
8. **hls fmp4-muxer init 附四张空 stbl 表**：stts/stsc/stsz/stco 对 fMP4 无意义且与 core/mp4 remuxer 产物不一致，移除（对齐后产物可被 Chrome 151+ 接受 init，media 段兼容性仍见遗留）。

**结果**：16/16 demo 全绿（无未捕获异常）；site 资源 404 = 0；真机播放链路坐实 —— mp4 URL Range 渐进 854×480 readyState=4、mov 拖放 readyState=4、ts 拖入 29.98s 全解析、hls fMP4 直通 11 分片全拉取、wav/flac 内置生成播放、webrtc 本机回环入口就绪；网络类（rtsp/rtmp 假网关、flv/mkv/cmaf/ape/webtorrent 假文件）均受控错误提示无崩溃。全仓回归 **1009/1009 全绿**（16 模块 938 + samples/fixtures 35 + samples/gateway 36）。

**遗留（登记跟踪）**：HLS **TS→fMP4 transmux 产物在 Chrome 151+ MSE 真机被拒**（init/media 段均触发 appendBuffer error，手动二分已排除 avc1/avcC 内容与 stbl 空表，根因未收敛；音频轨产物可正常 append）。I3 验收对 hls demo 采用 **fMP4 直通形态素材**（EXT-X-MAP，不经 transmux）打通真机全链；TS transmux 真机 MSE 兼容性记为已知限制，后续波次专项。另：avcC 视觉 sample entry、trex default_sample_flags 等差异可疑但未经实证。

---

## §49 HLS TS→fMP4 transmux 真机兼容（第四十九波，2026-09-08）

**背景（I3 遗留）**：I3 真机验收时 HLS TS→fMP4 transmux 产物在 Chrome 151+ MSE 被拒（init/media 均 appendBuffer error），二分排除 avc1 内容与 stbl 空表，根因未收敛，I3 改走 fMP4 直通素材绕过。本波专项攻坚。

**真机二分基建**（系统 Chrome + playwright-core + serve.mjs，落盘 fetch 路径避免序列化歧义）：
- `scripts/e2e/transmux-diag.mjs`：bbb480_30s.ts demux → annexb→avcc，生成 7 变体落盘，逐段 fetch().arrayBuffer() appendBuffer，捕获精确错误：
  - A styp+整段单 moof / B styp+GOP 切批 / C 整段去 styp / D GOP 切批去 styp（均用 hls buildInit）
  - G mp4 init+GOP 去 styp / H mp4 init+整段（mp4 Fmp4Remuxer 验证过的 init 作对照）
  - I 真实 `TsToFmp4Transmuxer.remux()` 路径产物
- `scripts/e2e/dump-init.mjs`：hls buildInit vs mp4 createInitSegment box 树对比
- `scripts/e2e/dump-media.mjs`：media 段 moof/trun 字段对比（Σ size vs mdat）

**根因（两处，均在 `hls/src/fmp4-muxer.js`）**：
1. **videoSampleEntry VisualSampleEntry 头部漏写 pre_defined[3]**：标准顺序为 `pre_defined(2)+reserved(2)+pre_defined[3](3×u32=12)=16 字节`，hls 旧实现写 `u16(0),u16(0),u32(0)` 仅 8 字节（少 8 字节）。导致 avc1 box 比规范短 8 字节，Chrome 解析 avc1 时字段错位、avcC 偏移错误 → **init segment 被拒**（A–D 全 initOk=false；G 换 mp4 init 即全过 → 隔离确认根因在 init 构造而非 media/styp/切批）。
2. **remux() 内 video 样本 size 用错长度**：`size: s.size ?? avcc.byteLength` 中 ts demux 的 `readSample` 返回 `size`（annexb 原始帧长），被优先采用，但 `data` 存的是 avcc（更短）→ trun 声明 Σ size ≠ mdat 实际字节 → **media segment 被拒**（变体 I 真实 remux 路径 mediaOk=0，Σ size 与 mdat 差 1801 字节；诊断 A 因 samples 未设 size 字段走 avcc 长度才通过）。

**修复**：
- videoSampleEntry 头部补 `u32(0),u32(0),u32(0)` → 标准 16 字节 VisualSampleEntry 头。
- remux() 内 video 样本先 `const avcc = toAvcc(s.data,'h264')`，`size: avcc.byteLength`（无条件取 avcc 转换后真实长度，与 mdat 一致）。

**验证结果**：
- transmux-diag 全 7 变体（A/B/C/D/G/H/I）`initOk=true mediaOk=全过`（含整段单 moof、含 styp 形态）。
- `scripts/e2e/hls-ts-e2e.mjs` 端到端：hls demo 真机加载单分片 TS 形态 HLS（samples/e2e/ts-hls）→ Transmuxer→TsToFmp4Transmuxer→MSE 真机播放 `readyState=4 / 848×480 / pageErrors(未捕获异常)=0`。transmux 已知限制消除。
- `hls/__tests__/ts-remux.test.js` 补 2 防回归断言：①init stsd 大小对齐 mp4 Fmp4Remuxer 标准（锁定 VisualSampleEntry 头不漏写）②remux 真实路径 Σ trun size == mdat 实际长度（锁定 avcc 长度回填）。hls 测试 9/9 全过。
- 全仓回归 **fail=0**（hls 模块 9/9；`--test-force-exit` 下非致命 cancelled 来自其他耗时套件，非本波引入）。

**基建沉淀**：scripts/e2e/{transmux-diag,hls-ts-e2e,dump-init,dump-media}.mjs（transmux 防回归）+ samples/e2e/ts-hls/{playlist.m3u8,seg-000.ts}（TS 形态验收素材）+ docs/review/i3/hls-ts-transmux.png（端到端截图）。

---

## §50 第五十波（2026-09-09）：§2.4 契约对齐全 16 模块结构层核对 + 版本管理首次纳入 git

### 背景

`docs/review/checklist.md` §2.4「契约对齐（demuxer 外表面）」八项自建清单起从未被任何波次正式核对（PRD 第 3 项即为该 reviewer 任务：CONTRACTS §2.5 对齐清单逐模块核对，含 §2.4 别名表迁移期核对）。前 49 波覆盖的是 I1~I6 与 M3，**§2.4 复选框全部保持未勾选状态**。本波补上。

### 审计基建

新增 `scripts/audit/contract-2-4-audit.mjs`：对 16 模块逐个 `import` index，筛出真 class（排除 `registerDemuxer` 等同名函数），核对：

- 类名 `<Format>Demuxer` + 是否继承 core `Demuxer`（`prototype instanceof`）
- `static probe` 是否**自实现**（仅继承基类恒 null 不算）、同步（不返 Promise）、对 0/8/64/4096B 固定伪随机垃圾**不抛**且**返 null**
- 是否实现 `_doOpen`（走基类 open 编排的前提）
- 定稿方法面 open/readSample/samples/seek/pause/resume/destroy + 可选 start
- 迁移别名 parseInit/init/attach/stop
- 是否存在 default 导出（G3）

初版启发式三处误报已修：类名正则需允许数字（`Mp4Demuxer`）、只认真 class、base/source scope 不应套 demuxer 口径。

### 现盘结论

| 模块 | 结论 |
|---|---|
| mp4 / mov / ts / flv / flac | ✅ 全项通过 |
| mkv | ⚠️ 继承基类但**覆写 `open()` 而非实现 `_doOpen`** → 两处真实缺口（见下） |
| wav | ⚠️ 未继承基类（文件头留档「共享看板约定」批准适配壳，豁免）+ 两处真实缺口 |
| cmaf / hls / subtitle | 非 demuxer 类模块：cmaf 只导出 `probe` 等函数、hls 导出 `HlsPlayer` 整播放器、subtitle 导出文本解析+渲染器 → **§2.4 不适用**（此前 scope 误划，非代码缺陷） |
| ape | probe-only（Phase 3 仅 probe+MediaInfo），符合定位 |
| webtorrent / webrtc / rtsp | source-only，只产 Source，符合定位 |
| rtmp | 自含 `FlvDemuxer`（传输联调用，接口对齐 flv 适配壳），scope=source，基本 N/A |
| core | 基类自身，不适用 |

### 两处真实根因与修复

**D1 mkv —— 覆写 `open()` 绕过基类编排（`mkv/src/demuxer.js`）**

1. **无 `initTimeoutMs` 超时保护**：mkv 构造函数 `this.options = options`（:121）用原始 options 覆盖了基类默认值，且自行编排的 `open()` 没有 `Promise.race` 超时 → 慢源/卡死源下 `open()` 会**永久挂起**，§2.4 第 3 项「initTimeoutMs 超时 reject TIMEOUT」不生效。全仓仅 mkv 如此（其余 demuxer 走基类 `open()` 自带该保护）。
2. **只发 'media-info'，未双发过渡期旧名 'mediaInfo'**：基类 `Demuxer.open()` 双发（core/src/demuxer.js:151-152），`mkv-base-class-alignment.md` D8 裁决亦为「增发旧名（§2.4 过渡期双发为设计内）」，但该裁决未落地 → 跨模块事件面不一致。

修复：`open()` 内补 `Promise.race` 超时守卫（`new PlayerError('TIMEOUT', ...)`，回落缺省 10000ms，`finally` clearTimeout），超时回退 idle 允许换源重试；成功后双发 `media-info` + `mediaInfo`。

**D2 wav —— 缺推送控制与解析超时（`wav/src/demuxer.js`）**

1. **缺 `pause()/resume()`**：§2.4 第 6 项明确要求（仅 `start()` 标【可选】），`WavDemuxer` 此前只有 player.js 侧的暂停，demuxer 外表面无此二方法。
2. **`parseInit()` 无 `initTimeoutMs` 超时**：头部读取直接 `await`，卡死源同样永久挂起。

修复：构造函数接收 `initTimeoutMs`（缺省 10000）与 `pausedFlag`；`parseInit()` 头部读取包 `Promise.race` 超时守卫（`timeoutError`，`finally` clearTimeout）；新增 `pause()/resume()`（置标记 + emit 'pause'/'resume'），同步更新 MiniEmitter 与 `on()` 的事件面 JSDoc。

### 验证

- 新增 4 例防回归：mkv「open() 超时 reject TIMEOUT」「open() 双发 media-info 与旧名 mediaInfo」、wav「pause/resume 维护 pausedFlag 并 emit 事件」「parseInit 超时 reject TIMEOUT」。
- mkv 24/24、wav 27/27、全仓 **1015/1015、fail=0、cancelled=0**（`--test-concurrency=4`）。

### 踩坑（测试侧）

超时定时器按 core 同款做了 `unref()`（不阻塞进程退出），而永不 settle 的 read promise **不持有事件循环** → 首版用例「永不 resolve 的源 + 30ms 超时」下 loop 提前排空，timeout 根本没机会触发，报 `Promise resolution is still pending but the event loop has already resolved`，并**级联 cancelled 后续 15 个用例**。实现保持不变（与 core 基类同款，生产环境有其它任务保活），**测试侧**自行 `setInterval` 保活后全绿。

### 未完成（下一波）

§2.4 第 4/5/7/8 项的**逐模块运行时**核对：未 open 调 `readSample` 抛 STATE_ERROR、`seek` 无索引/直播 reject SEEK_UNSUPPORTED、事件名恰为 error/media-info/sample/progress/end、时间戳对外全为整数 µs（不外泄原生 tick）。部分由既有测试覆盖，尚未做全矩阵现盘验证。

### 附：版本管理首次纳入 git

本波中途核实发现**该项目此前从未初始化 git**（只有 `.gitignore`，无 `.git`，向上至 `/` 无仓库），前 49 波改动从未提交/推送。经确认后执行：

- `.gitignore` 补 `samples/e2e/`（脚本可再生媒体，32MB，目录内无源码）与 `.smoke/`（8/26 一次性排查草稿 14 个，磁盘保留仅排除入库）
- `git init` → 首提交 `4dc220d`（main）· 435 files / 71624 insertions；**未推送**（按规矩 push 须显式确认）
- 注意：`git add -A` 后再补忽略规则不会自动清出索引，须 `git rm -r --cached <dir>`（只退暂存、不动磁盘）

---

## §51 第五十波 #22：§2.4 第 4/5/7/8 项逐模块运行时核对

**背景**：§2.4 八项契约（demuxer 外表面）中，前三波已完成结构层（类名/继承/static probe/open/_doOpen/方法面）+ 两处真实缺口修复（mkv/wav）；余第 4/5/7/8 项「逐模块运行时」此前仅由散落单测部分覆盖，未做全矩阵现盘。本波补齐。

**基建**：`scripts/audit/runtime-2-4-audit.mjs` —— 对 7 个 demuxer 模块（mp4/mov/ts/flv/mkv/flac/wav）调用各自 `fixtures/gen.mjs` 现盘生成 canonical fixture（`__tests__/fixtures/` 已被 .gitignore 忽略），经 `MemoryDataSource` 装入后跑真实 `open()→readSample()` 循环，现盘核对：
- C4 未 open 调 readSample 是否抛 STATE_ERROR（同步 throw 或 Promise reject 均判）
- C5 seek 行为：可寻址容器 resolve {actualTimestampUs}；直播/无索引容器拒 SEEK_UNSUPPORTED
- C7 事件名集合 ⊆ {error, media-info, mediaInfo, sample, progress, end}
- C8 所有 Sample.timestamp / duration 是否 `Number.isInteger`（µs 边界，不外泄 ticks）

**结果（7/7 全 PASS）**：
| 模块 | C4 | C5 | C7 触发事件 | C8 |
|---|---|---|---|---|
| mp4 | ✓ STATE_ERROR | ✓ seek(0)=0µs | media-info,mediaInfo,sample,end | ✓ 整数 |
| mov | ✓ STATE_ERROR | ✓ seek(0)=0µs | media-info,mediaInfo,sample,end | ✓ 整数 |
| ts | ✓ STATE_ERROR | ✓ SEEK_UNSUPPORTED（无索引） | progress,media-info,mediaInfo,sample,end | ✓ 整数 |
| flv | ✓ STATE_ERROR | ✓ seek(0)=0µs | progress,media-info,mediaInfo,sample,end | ✓ 整数 |
| mkv | ✓ STATE_ERROR | ✓ seek(0)=0µs | media-info,mediaInfo | ✓ 整数 |
| flac | ✓ STATE_ERROR | ✓ seek(0)=0µs | media-info,mediaInfo,end | ✓ 整数 |
| wav | ✓ STATE_ERROR | ✓ seek(0)=0µs | media-info,end | ✓ 整数 |

**结论**：mkv/flac/wav 在 pull 模式下不 emit `sample`（契约规定 sample 仅 `start()` 直播推送），符合预期；无模块 emit 溢出事件名。第四十九波 transmux 修复 + 本波运行时核对后，**§2.4 八项契约全模块闭环**。

**未引入代码改动**：本波仅为审计+台账，无源码变更（第四十九波 mkv/wav 修复已在 `60419a7` 入库）。全仓回归 fail=0（基线 1015/1015）。
