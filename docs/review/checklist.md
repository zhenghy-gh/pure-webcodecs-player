# 评审 Checklist（reviewer · v0.2）

> 维护人：reviewer ｜ 更新：契约修订同步版 ｜ 用途：两轮评审的执行底稿（台账 T21）
> 变更记录：v0.1 初稿 → v0.2 同步 CONTRACTS 修订（v0.2 编号线＋v1.0.1 AES-128 修订，待 captain 签批）：
> G9 改 PlayerError 十码并集（§11.3）；hls AES-128 由"不支持"改为"支持（仅 hls，§2.6）"；
> 方法名按定稿口径 open/readSample/destroy（parseInit/stop 为迁移期别名 §2.4）；基类定名 `Demuxer`；
> 字幕轨类型定稿 `'text'`（草案 'subtitle' 废弃）；F1、F5 随契约定名自动消解关闭。
>
> 评审依据（优先级从高到低）：
> ① `docs/CONTRACTS.md` 现行修订版（接口唯一权威；错误体系=§11.3 PlayerError 十码并集）
> ② `docs/00-需求与可行性结论.md` 第六条交付标准（工程红线）
> ③ 共享看板《工程约定 v1》《裁决-契约优先》《裁决-hls-flv重定位》《roster-编制与归属》
> ④ `docs/PRD.md` v1.0 第 3 章（qa 口径，供交叉引用）＋ `docs/TESTPLAN.md`（565 例门槛）
>
> 本文件只列检查项与判定标准，不含业务代码修改。正式评审输出见 `round-N-问题清单.md`。

---

## 0. 评级与闭环约定

| 级别 | 定义 | 处理 |
|---|---|---|
| 阻断 | 违反契约硬约束/红线，或导致功能不可用、测试不可跑 | M2/M3 出口前必须修复 |
| 严重 | 功能性缺陷、契约偏离、明显性能/安全隐患 | 当轮修复或经 captain 批准带病入下一里程碑 |
| 建议 | 可维护性、注释完整性、命名、文档一致性 | 修复建议，不强制当轮 |

每条问题格式：`[级别] 模块 文件:行号 —— 问题 —— 修改建议 —— owner —— 状态(⬜待修/🔄修复中/✅复核通过)`。
复核勾销以磁盘实码为准（口头修复不算）。

---

## 1. 通用红线检查项（每模块必查，G 系列）

> 跨模块系统核查完成于 2026-09-07（第二十一波，台账 §26）：16 模块（ape/cmaf/core/flac/flv/hls/mkv/mov/mp4/rtmp/rtsp/subtitle/ts/wav/webrtc/webtorrent）逐项现盘实证。

- [x] **G1 纯 ESM**：16 模块 `src/index.js` 逐一 `await import` 实证加载成功；无 require()/裸 specifier（webtorrent loader.js 的 `typeof import('webtorrent')` 为 JSDoc 类型注释非运行时代码）。✅
- [x] **G2 零第三方运行时依赖**：16 模块 `src/` 仅相对路径导入；唯一例外 webtorrent loader.js（globalThis 探测 → 动态 import CDN URL → null 降级），属契约"可选增强必须探测→降级"的文档化豁免（README「可选依赖」节）。✅
- [x] **G3 入口与导出**：16 模块 index.js 全显式具名导出、无 default export。✅
- [x] **G4 中文 JSDoc**：导出符号均有中文 JSDoc；§10 注册形状元数据组常量（containerName/extensions/mimeTypes/capabilities/VERSION）共享 section 注释、语义自明，未逐常量加噪音注释。✅
- [x] **G5 双环境安全**：浏览器全局访问逐一核证带守卫（subtitle `typeof document !== 'undefined' &&` 短路、mp4 pickFile typeof document、cmaf 构造 `hasWebCodecs()`、hls mse notSupported 探测、capabilities 探测文件等）；Node 下返回不支持/不抛。✅
- [x] **G6 测试与 fixture**：全仓低并发基线 918/918、0 cancelled（`--test-concurrency=4 --test-timeout=15000`）；fixture 均程序化生成。✅
- [x] **G7 命名规范**：16 模块 src 文件全 kebab-case（脚本实证零违规）。✅
- [x] **G8 日志纪律**：无 alert；console 仅 emitter error 处理器兜底 console.error（日志自身不能抛的纪律例外）与诊断 console.warn（级别默认 warn）；未见二进制本体打印。✅
- [x] **G9 错误封闭枚举**：16 模块 demuxer/引擎、渲染端、传输层对外错误通道均已收口为 PlayerError 十码；低层解析原语 amf0/bits/lacing 等入口自收口或由上层收口；mp4 remuxer/box-builder、WebRTC/RTSP 与渲染端裸 Error 已在第二轮完成裁决。残余 `hls/fmp4-muxer`、`mkv/demuxer`、`ts/aac` 等为内部防御断言（触发即实现 bug，非输入容错路径），不属于用户错误面。✅
- [x] **G10 目录四件套**：16 模块 README＋src/index.js＋demo/＋__tests__/ 全存在；hls/subtitle 另有 round-1 receipt 文件。✅

---

## 2. 第一轮：解析层正确性（M2 末，P/M 系列）

### 2.1 正确性维度（逐模块过一遍）

- **P1 字节序与位流原语**
  ISO-BMFF/mp4/mov/flv/ts = 大端多字节；RIFF/wav = 小端；EBML = 大端 vint。核对每处 DataView get* 方法的 littleEndian 参数；位读取器 MSB-first；exp-Golomb 有符号/无符号分支。
- **P2 偏移边界**
  任何长度字段参与偏移推进前做上界钳制；截断流（数据不足）不越界读；`size=0`/`size=1(largesize)`/EBML unknown-size(`all ones`) 的死循环与终止条件；32 位长度溢出（如 >4GB box）；RIFF chunk 尺寸奇数补齐。
- **P3 异常容错**
  畸形输入抽样 fuzz（随机翻转头部字节、截断至任意位置）不抛未捕获异常；可恢复错误走 warn＋跳过，致命错误才进 error 态；状态机非法迁移抛 STATE_ERROR（≈草案 INVALID_STATE，定稿此名）；TS 连续性计数断档重同步；垃圾字节注入后能恢复同步（PRD 点名场景）。
- **P4 时间基与换算**
  容器原生 timescale → 整数微秒就近取整；PTS/DTS 区分与解码序输出；TS PTS/DTS 33 位（2^33）回绕；FLV 毫秒→微秒；MKV ns→µs（注意 64 位精度）；负向时间戳（SimpleBlock 相对值符号扩展）。
- **P5 契约数据结构**
  Sample{codec,timestamp,duration,data,keyframe} 五必填齐全、视频按 DTS 序；Track 类型取值 video/audio/**text**/metadata（字幕轨定稿 'text'，草案 'subtitle' 废弃）；Track.description 语义正确（avcC/hvcC/ASC/STREAMINFO 原样透传；core 过渡别名 codecPrivate 待接入波次统一）；MediaInfo.container 取值在枚举内、live/seekable/durationUs 三者联动正确；ProbeResult.confidence≥0.8 判命中、未命中返回 null。

### 2.2 内存与性能

- **M1 分片读取**：点播 demuxer 经 DataSource（随机读源）按需 Range 读取，禁止整文件 read 进内存（wav/flac 等头解析尤其注意）；单次 read 长度有上界。
- **M2 无界增长**：样本队列、簇/Cues 索引、字幕缓存在长直播/超长文件下有无上限或淘汰策略。
- **M3 视图与所有权**：`subarray()` 共享底层 buffer 的生命周期（上游复用 buffer 会踩脏数据）；VideoFrame/AudioData 异常路径也 close（finally）。
- **M4 热点复杂度**：无 O(n²) 全文扫描；未知长度 master 元素探测（如 mkv）的读取步长有界。

### 2.3 各模块格式专项要点

| 模块 | 必查点（对照格式规范） |
|---|---|
| mp4/mov | box 头 4B 大端长度+type；ftyp/moov 嗅探；moov 前置/后置双支持；stco/co64 64 位偏移；stss/trun/sbgp 关键帧判定退化链；elst 编辑列表时间偏移；sample 表间数量一致性（stsc/stsz/stts 条目数互检） |
| cmaf | styp/sidx 分片级索引；sidx referenced_size 链；分片未收尾即吐 sample 的 LL 路径 |
| mkv | EBML magic `1A 45 DF A3`；vint 编码（保留位、all-ones 无效值拒绝）；DocType webm/matroska 两步走；Lacing 三种（Xiph/fixed/EBML）展开；Cues 缺失→运行时簇索引→线性扫的退化链；SeekHead 与实际位置不符时兜底 |
| ts | 188 定长＋0x47；连续丢包后滑动窗口重同步；PAT/PMT 版本变化动态更新；continuity_counter 校验；PCR 33 位回绕；PES header length 与 payload 边界；ADTS protection_absent 分支、LATM 流；stream_type 映射未知时的跳过策略 |
| flv | `"FLV"`+版本+flags（音频/视频存在位）；TagHeader 11B；PreviousTagSize0 与 TagSize 校验；时间戳 3B+扩展 1B 拼接（ms→µs）；AMF0 全类型（含 ECMA 数组/严格数组/object-end 嵌套）；AVCVIDEOPACKET→AVCC 输出、CodecID=12 HEVC、Enhanced-FLV FourCC 分支 |
| hls | 主/媒体清单两级解析；EXTINF 浮点时长累计误差；EXT-X-BYTERANGE；**EXT-X-KEY METHOD=AES-128 整段解密支持**（WebCrypto subtle AES-CBC，IV 取标签属性或媒体序号；解密层位于 Source 与 demuxer 之间、demuxer 无感知，范围仅限 hls，见 CONTRACTS §2.6）；SAMPLE-AES 及一切 DRM 报 NOT_SUPPORTED（不得静默跳过）；cryptoSubtle=false 时含 AES-128 KEY 的清单降级报 NOT_SUPPORTED（明文清单不受影响）；相对 URL 基于 playlist URL resolve；LL-HLS PRELOAD-HINT/PART；fMP4 与 TS 分片混排路由到对应子 demuxer |
| wav | RIFF 小端；`WAVE` 标识；chunk 四字节对齐＋奇数尺寸补齐 pad byte；fmt 扩展 cbSize/WAVE_FORMAT_EXTENSIBLE；fmt 长度≠16 时兼容分支；data size=0xFFFFFFFF（流式录制）处理；pcm-* codec 串映射表完整性 |
| flac | `fLaC`；METADATA_BLOCK 头（last-flag 终止）；STREAMINFO 34B 作 description；块长度边界；自产编码器往返验证无损（qa 口径） |
| ape | MAC 标头 magic；版本 ≥3980 校验；APE TAG footer/header 双位置；Phase 3 只交 probe+MediaInfo，README 如实标注解码路线 |
| subtitle | SRT 时间戳 `HH:MM:SS,mmm`（逗号）/WebVTT `.`（点）；ASS `[Script Info]/[V4+ Styles]/[Events]` 分节；UTF-8 BOM 剥离；编码嗅探顺序；x-srt/x-ass/x-vtt codec 串；轨类型定稿 'text' |
| 传输层四件（webtorrent/webrtc/rtmp/rtsp） | 只产 Source 抽象不碰 Sample；输入校验归第二轮 I5；直连地址一律拒绝＋教育文案（PRD 硬要求） |

### 2.4 契约对齐（demuxer 外表面，方法名以 CONTRACTS 定稿为准）

> **第五十波（2026-09-09）结构层全模块核对**（见台账 §50）：新增 `scripts/audit/contract-2-4-audit.mjs`，对 16 模块核对类名/继承/静态 probe（同步·不抛·垃圾输入返 null）/定稿方法面/迁移别名/default 导出。**mp4/mov/ts/flv/flac 全项通过**；**cmaf/hls/subtitle** 经核实并非 demuxer 类模块（分别导出函数式 probe、HlsPlayer 整播放器、文本解析+渲染器），§2.4 不适用，属此前 scope 误划；**ape(probe-only)、webtorrent/webrtc/rtsp(source)** 符合定位；**wav** 未继承基类属文件头留档的「共享看板约定」批准适配壳，豁免。
> 本波修复两处**真实缺口**：①**mkv** 覆写 `open()` 绕过基类编排 → `initTimeoutMs` 超时保护缺失（卡死源会永久挂起）且只发 'media-info'、未双发过渡期旧名 'mediaInfo'（与 core Demuxer 及其他模块事件面不一致）；②**wav** 缺 `pause()/resume()`（§2.4 第 6 项，start() 才标【可选】）且 `parseInit()` 无 `initTimeoutMs` 超时。新增 4 例防回归（mkv 超时+旧名双发、wav pause/resume+超时），全仓 1015/1015、fail=0、cancelled=0。
> **第 4/5/7/8 项逐模块运行时核对（第五十波 #22，2026-09-09 收口）**：新增 `scripts/audit/runtime-2-4-audit.mjs`，对 mp4/mov/ts/flv/mkv/flac/wav 七个 demuxer 经各模块 `fixtures/gen.mjs` 现盘生成 canonical fixture → `MemoryDataSource` → 真实 open→readSample 循环，全矩阵现盘：
> - **C4 未 open 调 readSample → STATE_ERROR**：7/7 ✓
> - **C5 seek 行为**：可寻址容器（mp4/mov/flv/mkv/flac/wav）seek(0) resolve 0µs；无索引容器（ts）拒 SEEK_UNSUPPORTED —— 7/7 ✓
> - **C7 事件名恰为五者**：触发集 ⊆ {error, media-info, mediaInfo, sample, progress, end}，无溢出（mp4/mov/ts/flv 含 progress+sample；mkv/flac/wav pull 模式无 sample，符合契约「sample 仅 start() 直播」）—— 7/7 ✓
> - **C8 时间戳整数 µs**：所有 Sample.timestamp/duration 全部 `Number.isInteger`，不外泄 ticks —— 7/7 ✓
> §2.4 八项（含此前前三波结构层 + 本波运行时）**全模块闭环**，checklist 收口。

- [x] 类名 `<Format>Demuxer` 且继承 core `Demuxer` 基类（基类提供事件/状态机/迭代器骨架；或经 captain 批准的适配壳）；
- [x] `static probe(bytes)`：同步、无副作用、不抛异常、未命中返回 null；
- [x] **`open()`** 打开并解析初始化段，resolve 后 this.mediaInfo/.tracks/.metadata 可用并 emit('media-info')；initTimeoutMs 超时 reject TIMEOUT（迁移期别名 parseInit()/init()+attach() 按 §2.4 别名表接受）；
- [x] **`readSample(trackId)`** pull 主通道（EOS resolve null），`samples(trackId)` 为等价糖层；未 open 先调 throw STATE_ERROR；
- [x] `seek(timestampUs)` 关键帧对齐、resolve `{actualTimestampUs}`；直播/无索引 reject SEEK_UNSUPPORTED；
- [x] 直播推送 `start()`【可选】+'sample' 事件；pause/resume；**`destroy()` 幂等销毁**（别名 stop()，之后一切调用抛 STATE_ERROR）；
- [x] 事件名恰为 error/media-info/sample/progress/end，载荷形状符合契约事件表；
- [x] 时间戳全部整数微秒（对外），原生 tick 不外泄。

---

## 3. 第二轮：集成与全量一致性（M3 末，I 系列）

- **I1 core API vs CONTRACTS 全量比对**（以现行契约章节为准）：输入源抽象（Memory/File/HttpRange 实现并发 Range 合并与最小分片、ChunkBuffer、新增 DecryptingSource 仅 hls 内置）、`Demuxer` 基类与状态机、codec-string 收敛（h264CodecStringFromSps/hevcCodecStringFromHvcC/aacCodecStringFromAsc/fallbackCodecString，demuxer 禁止自行拼串）、capability（hasWebGPU/chooseRoute/cryptoSubtle 探测/进程内缓存/Node 全 false 不抛）、渲染端（createVideoRenderer/createAudioOutput/'player-audio-sink'/f32-planar/VideoFrame 单一所有权）、**§11.3 PlayerError 十码并集**、§11.4 logger（createLogger/setLogLevel）。
- **I2 播放管线语义**：chooseRoute('webcodecs'|'mse'|'none') 裁决顺序（能用 WC 就不落 MSE）；seek 清缓冲＋关键帧对齐＋音频包对齐；音画同步以 out.currentTimeUs 音频主时钟、无音轨用 performance.now() 软时钟；progress/end 事件链路；createDemuxer 工厂识别失败 reject PROBE_FAILED。**✅ 第四十波（2026-09-08）收口：起播前向缓冲（`bufferTargetUs` 默认 3s，直播 `liveLatencyUs`）、常规泵背压（`bufferedAheadUs` 超阈值暂停拉流）、`buffered` 三级回落、`stats.bitrateBps` 滑动窗口、`progress` 透传、统一 `_deliver` 投递口；两条管线补 `bufferedAheadUs`/`getBufferedRanges()`；新增 buffering.test.js 8 例；core 17 文件全绿。** **✅ 第四十一波（2026-09-08）工程化缓解：`Demuxer.destroy()` 不再 `await gen.return()`，迭代器被永不 resolve 的 `await` 卡住时也能立即完成；新增 demuxer-destroy.test.js 3 例；core 18 文件全绿。** 后续：直播落后丢帧追赶（**✅ §42 已完成**：live+liveLatencyUs 落后超阈值主钟重锚 + 旧帧逐丢 + 'catchup'；resync 显式按方向处理——迟到丢帧/超前重锚，修正此前 resync 落「渲染」致大幅迟到帧被渲染的缺陷）、或为 `readSample` 引入 AbortSignal。**✅ 第四十三波（2026-09-08）M3 真实浏览器端到端验收（WebCodecs 主路线打通）**：系统 Chrome+playwright-core 驱动（scripts/e2e/），TS（annexb）与 MP4（seekable）双素材 15 步自断言全 PASS（含 seek 关键帧对齐+恢复、AudioWorklet 接管、destroy 干净）；端到端暴露并修复 6 个真实缺陷（hasAudioWorklet accessor Illegal invocation 改 `in` 探测 / 能力探测并入媒体实际 codec / 音频探测补 48k·stereo / annexb 轨 decode 前 annexbToAvcc / seek reset 后重新 configure / 宿主注册协议打通 registry 恒空缝隙）；新增 webcodecs-e2e-regress.test.js 3 例；core 19 文件 109 例全绿。**✅ 第四十四波（2026-09-08）M3 真实浏览器端到端验收（MSE 兜底路线打通）**：新增 scripts/e2e/mse-harness.html（19 步自断言，强制 routePreference:['mse']）+ 诊断页 mse-diag.html + run.mjs `--harness=`；MP4 素材 19/19 PASS（2×SourceBuffer + 2 段 init → 元素真实解码 854x480、readyState=4、首帧 219ms → 时间轴推进 → Player 时钟跟随元素 → 渲染 23 帧/0 丢 → seek 20s→16.5s 关键帧对齐后恢复 → 25 段/3009 样本 → destroy 干净），WebCodecs 复跑仍 15/15。端到端暴露并修复 5 个真实缺陷：①chooseRoute 忽略宿主 routePreference（强制 MSE 仍裁决 webcodecs）；②MseHelper.addTrack 用实例调 isTypeSupported（实为构造器静态方法）→ 全轨误判不支持；③**tkhd 漏 layer(2B)**（parser 与 builder 两侧）→ width/height 错位恒 0 → fMP4 init segment avc1 宽高 0 → Chrome 拒收 init，MSE 整体不可用（顺带补齐 WebCodecs 的 codedWidth/Height）；④MsePipeline.init 建 SB 与写 init 交错 → Chrome QuotaExceededError（某 SB 写过数据后禁止新建）→ 改两阶段「先建齐 SB 再统一 append」；⑤canMse 在已深探测时重复实时判定 → 深探测 mimeTypes 直接采信。新增 core/__tests__/mse-e2e-regress.test.js（5 例）与 mp4/__tests__/tkhd-layout.test.js（4 例）；tkhd 多 2 字节致 fixture 需重建（generate-all.mjs 后 artifacts-edge 21/21）。遗留：TS 不在 REMUXABLE 白名单，MSE 验收以 MP4 覆盖。
- **I3 demo 页可用性**：✅ **第四十八波（2026-09-08）收口**（见台账 §48）：16/16 demo 真机（系统 Chrome+playwright）无未捕获异常、site 资源 404=0、皮肤引用完整；真机播放链路坐实（mp4 URL Range / mov 拖放 readyState=4、ts 29.98s 全解析、hls fMP4 直通 11 分片、wav/flac 内置生成、webrtc 回环入口）；网络/假文件注入路径均受控错误提示。修复 8 个真实缺陷：①wav/flac/ape skin 资源 404（CSS/icons/skin.js 指向模块内副本，实际收敛到 site/）②webtorrent `clearErr` 未定义 ③mp4 demo `durationSec`→`durationUs` ④mp4/mov demo remuxDemuxer 旧 iterable 用法→await 数组 ⑤flac demo computePeaks/drawWaveform 错从自身模块导入（实属 wav）⑥hls SegmentLoader webidl fetch 未 bind→成员调用 Illegal invocation ⑦hls MseController removed-SourceBuffer 读 buffered 连环 pageerror（onErr/getBuffered 加防御）⑧hls fmp4-muxer init 移除 stts/stsc/stsz/stco 空表。全仓回归 1009/1009。新增基建 scripts/e2e/demo-audit.mjs（防回归）+ mk-hls-fmp4.mjs（素材再生）。TESTPLAN B01~B15 十五条抽查随 §43/§44/§48 演示链路覆盖。
- **HLS TS→fMP4 transmux 真机兼容（I3 遗留）**：✅ **第四十九波（2026-09-08）收口**（见台账 §49）：根因锁定 hls/src/fmp4-muxer.js 两处真机缺陷——①videoSampleEntry 的 VisualSampleEntry 头部漏写 pre_defined[3]（标准 16 字节，hls 只写 8 字节，avc1 错位致 Chrome 拒 init）②remux() 内 video 样本 size 取 annexb 原始帧长而 data 存 avcc（更短），Σ trun size ≠ mdat 致 Chrome 拒 media。真机二分（transmux-diag.mjs 七变体 + dump-init/dump-media box 对比）定位；修复后全 7 变体 initOk+mediaOk 全过、hls-ts-e2e.mjs 端到端 hls demo 加载 TS 形态 HLS 真机播放 readyState=4 / 848×480 / pageError=0；ts-remux.test.js 补 2 防回归断言（stsd 对齐 mp4 标准、Σ trun size==mdat）9/9。hls 模块 fail=0，全仓 fail=0。
- **I4 README 与实现一致性**：✅ **第四十六波（2026-09-08）收口**（见台账 §46）。16 模块 README 六要素齐全（core 原缺独立「快速开始」章节已补）；core 新增「安全与输入防护（评审 I5）」章节文档化 url-guard/limits 导出面（index.js:70-90）；mp4 API 表补 Mp4WebCodecsPipeline（mp4/src/index.js:14 已导出、快速开始已用）；core 快速开始示例字段名核实修正（MsePipeline 读 `mediaElement`/`video`、WebCodecsPipeline 读 `canvas`，非 videoElement）；已知限制抽查如实（hls AES-128 已支持声明与 v0.2 定稿一致、flv 定位声明一致）。本波纯文档修正，无代码改动，基线不受影响。
- **I5 安全项**：✅ **第四十五波（2026-09-08）收口**（见台账 §45）：新增 `core/src/url-guard.js`+`core/src/limits.js` 两守卫模块，六类风险全部现盘修复并锁入防回归；
  - fetch/ws 输入：URL 协议白名单（url-guard.js：fetch 仅 http/https、ws 仅 ws/wss、import 仅 http/https；非法协议抛 NETWORK/SOURCE_ERROR 而非 TypeError），各入口已接入 ✅
  - WS 信令 JSON：schema 校验后再取字段，防原型污染（`__proto__`/constructor 注入键）—— webrtc/rtmp signaling 已接入 ✅
  - postMessage/MessageChannel：origin/e.source 校验 —— 现盘确认 site/demo 无跨窗口通信，N/A 关闭 ✅
  - 解密路径（hls AES-128）：密钥 URL 校验、响应体 1MB 上界、密钥缓存 FIFO 淘汰、解密失败报 PARSE_ERROR/NOT_SUPPORTED 而非静默乱码 —— decrypter.js ✅
  - 大输入防护：Range 读取上界（64MB）+ sample/moov 长度互检（readCapped + assertByteLength），防畸形长度字段 OOM —— limits.js + mp4/mov/flac/HttpRangeDataSource ✅
  - 正则/字符串解析（m3u8/ASS/SRT）：灾难性回溯风险 —— hls parseAttributes 加 maxLength 上界、ASS 结构识别加长度前缀 ✅
- **I6 site 汇总页**：✅ 第四十七波（2026-09-08）收口（见台账 §47）。汇总页 `site/demo/index.html` 模块卡片由 `site/nav.js` 的 MODULES 动态生成，现盘确认 MODULES 覆盖全部 16 业务模块、href 与各模块 `demo/index.html` 实际路径一一对应、页签与路径无错位；顶部 tab 为精选快捷入口，全量覆盖由卡片网格承担。I6 通过，无需修正。

---

## 4. 预扫描发现（F 系列 —— 建立清单时的疑点存目）

> 通读现有代码时的初步观察。定级与闭环以 round-N 清单为准。

| # | 位置 | 观察 | 涉及契约条款 | 状态 |
|---|---|---|---|---|
| F1 | core/src/errors.js:7-18 | ~~PlayerError 仅 5 码 vs 契约九码不一致~~ **✅ 已关闭**：契约 v1.0.1 定稿错误类名即 `PlayerError`、十码并集（§11.3），命名冲突消解。残余动作归 G9 常规核查：core errors.js 需补齐 PROBE_FAILED/NETWORK_ERROR/SEEK_UNSUPPORTED/TIMEOUT/ABORTED 五码 | §11.3 | ✅ 关闭（2026-09-07 现盘：十码 + 十个快捷构造器齐，`errors.js` 全量核对无缺码） |
| F2 | core/src/（无 logger 文件） | createLogger/setLogLevel 未实现；各模块日志形态不一（hls 自带 enableLog/logger） | §11.4 | ✅ 关闭（2026-09-07 现盘：`logger.js` 已实现 LogLevel/setLogLevel/logBytes/createLogger 四级日志，index.js 导出） |
| F3 | core/src/capabilities.js | 缺 `hasWebGPU`、`chooseRoute`；detectCapabilities 返回结构与 §4 待比对（新增 cryptoSubtle 探测亦未见） | §4 | ✅ 已补（2026-09-07 现盘：`hasWebGPU/hasCryptoSubtle/detectCapabilities/resetCapabilityCache/canDecodeVideo/canDecodeAudio/chooseRoute` 全在，index.js 导出；返回结构精比对归 I1） |
| F4 | core/src/data-source.js | 导出 MemoryDataSource/BlobDataSource/asDataSource；契约要求的 HttpRange 实现（并发 Range 合并、最小分片）与 ChunkBuffer 未见 | §2.1 | ✅ 已补（2026-09-07 现盘：`http-range-source.js` HttpRangeDataSource + `data-source.js:79` ChunkBuffer，index.js 导出；并发 Range 合并/最小分片行为细核归 I1） |
| F5 | core/src/index.js:38 | ~~导出名 Demuxer ≠ 契约名 BaseDemuxer~~ **✅ 已关闭**：契约修订定稿基类名即 `Demuxer`（§2.2），命名漂移消解；继承关系与状态机实现细节仍随 round-1 常规核实 | §2.2 | ✅ 关闭 |
| F6 | core/src/audio-worklet-player.js:93 | processor 注册名 `'pcm-ring-worklet'` ≠ 契约 `'player-audio-sink'`（captain 确认继续跟踪） | 渲染端约定 | ✅ 已改（2026-09-07 现盘：`:93 registerProcessor('player-audio-sink')` + `AUDIO_SINK_PROCESSOR_NAME` 导出；underrun 计数经 port 上报） |
| F7 | core/src/audio-worklet-player.js | `AudioWorkletPlayer` 与契约工厂 `createAudioOutput({sampleRate,channels})`、getter `currentTimeUs/underrunCount` 形态待比对 | 渲染端约定 | ✅ 已闭（2026-09-07 I1 首波：`createAudioOutput({sampleRate,channels})` 已导出并兼容 `channelCount`；`currentTimeUs/underrunCount` getter、`player-audio-sink` 注册名齐；Node 无 AudioContext 时明确报错） |
| F8 | core/src/video-frame-renderer.js | `VideoFrameRenderer` 类与契约工厂 `createVideoRenderer(canvasEl,{preference,fit})` 形态待比对；close-in-finally 待核实 | 渲染端约定 | ✅ 已闭（2026-09-07 I1 首波：`createVideoRenderer(canvasEl,{preference,fit})` 已导出，默认 contain 并支持 cover/fill；`draw()` finally close 已在 round-1 §9.1 闭环；Node 构造有明确 DOM 环境错误） |
| F9 | ts/src/ts-demuxer.js:14,38,90 | 对外仍为 probe/push/flush/reset＋tracks/metadata/complete 事件、ticks 时间基；E-1 裁决要求的契约适配壳（open/readSample/samples/start/µs/error/media-info/sample/progress/end）未见落地证据（captain 确认继续跟踪） | 裁决-契约优先 §2.4 别名表 | ✅ 已闭（2026-09-07 现盘：`class TsDemuxer extends Demuxer`(:42 基类)，open/readSample/samples/seek(µs)/pause/resume/destroy + probe/push/flush 别名 + createTsDemuxer 工厂 PROBE_FAILED 全落地） |
| F10 | mkv/src/demuxer.js + flac/src/demuxer.js | `MkvDemuxer`、`FlacDemuxer` 已继承 core `Demuxer`；各自兼容层仍保留既有严格 getter、EOS 与 seek 语义，统一裁决后续再收敛 | §2.2/§0.5 | ✅ I1 2026-09-07：两模块均 `extends Demuxer`，mkv 74/74、flac 46/46 全绿；F10 基类继承面闭环 |
| F11 | hls/src/player.js | `HlsPlayer.attach(url,video)` 架构与契约 Demuxer 面关系需按【裁决-hls-flv重定位】澄清验收口径；自带 EventBus/LoadError 与 core 统一 emitter/PlayerError 重复 | §2.5/§11.3 | ✅ I1 2026-09-07：HLS Player 明确属于播放器/数据源适配面，不冒充 Demuxer；EventBus 已改为 core `Emitter` 别名，兼容 `removeAllListeners()`；LoadError 十码收口沿用 §9.2 证据 |
| F12 | ts/src/bits.js、ts/src/emitter.js | 与 core bit-reader/emitter 平行实现——并行期自含开发被《工程约定 v1》豁免，接入波次后应收敛（watch 项，非违规） | 工程约定 §4 | ✅ I1 2026-09-07：F12 事件平行件已收敛为 core Emitter 的传输/播放器兼容别名（rtmp MiniEmitter、rtsp source、hls EventBus）；TS/FLV 解析内核仍保留自含 emitter 作为内部隔离实现，未扩大对外契约面；core 多参数与监听器隔离语义已补回归 |

---

## 5. 执行节奏（对应台账 T21）

1. **第 1 轮触发条件**：台账 M2 区块（t6~t10/t13 各模块 `__tests__` 齐、npm test 绿）全部 ✅ → 输出 `docs/review/round-1-问题清单.md`，「阻断+严重」条目数摘要上板 @captain。
2. **第 2 轮触发条件**：M3 区块（t18 管线/t19 demo/t20 汇总页）✅ → 输出 `docs/review/round-2-问题清单.md`。
3. 每轮清单按本文 §0 格式登记；owner 修复后由 reviewer 以磁盘实码复核勾销，闭环记录追加在同一文件尾部。
