# PurePlay · 《纯前端实现播放器》产品需求文档(PRD)

| 项 | 内容 |
|---|---|
| 文档版本 | **v2.2**(防误读标注版;实质口径与 v2.1 完全一致,无任何条款变更;取代 v1.0) |
| 作者 | pm(产品经理) |
| 日期 | 2026-08-25 |
| 状态 | 初验通过(captain);AES-128 支持口径经三轮核验确认在位(v2.1 起生效),qa TESTPLAN v1.1/用例集 HLS-N02 已同口径,CP-A 可按 §3.7 正常验收 |
| 品牌 | **PurePlay**(leader 裁决;ffplay.js 因借用 FFmpeg 子项目名有混淆风险而弃用,仅作方向性类比) |
| 事实依据 | `docs/00-需求与可行性结论.md`(最高优先级,本文不得与其矛盾) |
| 上位文档 | `docs/CONTRACTS.md` **v0.2**(唯一权威锚点;含 PlayerError 十码/open/readSample/Cue 流/网关 §9 信令/AES-128 §2.6;§12.3 接口冻结效力至 M2 评审完成)·`docs/ARCHITECTURE.md`·`docs/DESIGN.md` v1.0·看板《工程约定-v1.1》《任务台账》《裁决》系列 |
| 变更规则 | 需求变更须经用户确认;接口口径变更须经 captain 批准并按契约治理流程记版本 |

> ⚠️ **阅读提示(hls AES-128)**:现行口径=**支持 EXT-X-KEY METHOD=AES-128 整段解密(WebCrypto 同构,仅限 hls 模块)**,自 v2.1 起生效于 §3.7/R8/单测行,系按 leader 最终裁决恢复 v1.0 原始范围。第 7 章变更记录中 **v2.0 行所载"加密分片 NOT_SUPPORTED"仅为历史记载**,不构成现行验收依据;引用契约依据一律以 `docs/CONTRACTS.md` v0.2 §2.6 为准。

---

## 目录

1. [产品定位](#1-产品定位)
2. [总体范围与统一验收口径](#2-总体范围与统一验收口径)
3. [16 个模块功能范围与验收标准](#3-模块需求详述)
4. [里程碑 M1~M4 验收口径](#4-里程碑-m1m4-验收口径)
5. [风险清单](#5-风险清单)
6. [验收流程与角色分工](#6-验收流程与角色分工)
7. [变更记录](#7-变更记录)

---

## 1. 产品定位

### 1.1 一句话定位

**教学型「下一代 ffplay.js」纯前端播放器 monorepo(PurePlay):面向开发者学习多媒体容器/协议/解码原理,每个模块都可直接跑通演示的开源 JavaScript 播放器合集。**

统一媒体管线:`Container → Demuxer → Codec → WebCodecs → Renderer`(Canvas/WebGPU + AudioWorklet);前端做媒体管线,服务端只负责协议入口;RTMP/RTSP 以本地网关桥接形态接入(`scripts/gateway.mjs` 已备好)。

### 1.2 「教学型」的三个硬标准

| 标准 | 含义 | 验收落点 |
|---|---|---|
| 读得懂 | 中文 JSDoc 覆盖全部导出符号与关键算法(CONTRACTS §11.2);README 用原理讲解 + ASCII 架构图讲清格式本质 | reviewer 评审项;M4 已知限制终审 |
| 跑得通 | 零构建零第三方运行时依赖,`<script type="module">` 直开或 `npm run demo`(8080 静态服务器)即可演示;`npm test` 一键全绿 | 每模块 demo 验收 + M1/M2 门禁 |
| 学得真 | 可行性结论诚实(RTMP/RTSP 必须桥接等基线任何人不得更改);限制写得比功能还清楚;错误语义化(`PlayerError` 十码封闭枚举 + 中文文案) | README 六要素「已知限制」;qa 抽查 |

### 1.3 与成熟开源生态的关系(leader 裁决《hls-flv 重定位》,全员生效)

- **不再造 hls.js/flv.js**:两者作为 CDN 可选依赖进 demo 站做对照参考;生产场景在各模块 README 明确建议直接使用 hls.js/flv.js。
- **差异化主战场**:core 内核、mkv、mov、ts、subtitle、音频三件套(wav/flac/ape)、webrtc、rtsp/rtmp 桥接,以及「WebCodecs 直解」这一 hls.js 没有的路线验证。
- **hls/** 重定位为「HLS 数据源适配层」:m3u8 解析 + 分片加载 + 喂给统一内核;不做 ABR/缓冲策略竞赛。
- **flv/** 重定位为「FLV 解析地基 + 薄播放壳」:其 Tag/AMF0/AVCC 解析器是 `rtmp/`(WebSocket-FLV 桥接)的必选依赖,也是 Demuxer 契约的参考实现。
- **ts/** 保持完整播放器定位(IPTV/HLS 分片核心,无同等地位的标准库)。

### 1.4 目标用户

| 用户群 | 典型场景 | 主要受益模块 |
|---|---|---|
| 学习多媒体格式的开发者 | 读一份可运行的 ISO-BMFF/EBML/MPEG-TS 解析参考实现 | mp4/mov/mkv/ts/flv/core |
| 自研播放器团队 | 借鉴 Demuxer 契约、WebCodecs/MSE 双路线与能力降级设计 | core/mp4/mkv/webrtc |
| 安防监控前端 | 摄像头流经网关低延迟上屏 | ts/rtsp/webrtc |
| 直播/点播平台前端 | HTTP-FLV、HLS、CMAF 低延迟分发 | flv/hls/cmaf |
| 二次元/影视字幕社区 | MKV 内挂字幕与 ASS 特效渲染 | subtitle/mkv |
| P2P 场景开发者 | torrent 边下边播 | webtorrent/mp4 |
| 音频爱好者 | 无损格式网页试听 | flac/ape/wav |

### 1.5 不可更改的事实基线(源自 00 号文档,任何人不得凭空更改)

1. 浏览器无 TCP/UDP API,**RTMP/RTSP 直连不存在实现路径**,只能桥接:`RTMP → HTTP-FLV/WebSocket-FLV`;`RTSP → WebSocket 中继(interleaved / RTP over TCP)` 或 `RTSP → WebRTC`。本项目桥接前提 = 本地测试网关 `scripts/gateway.mjs`(默认 `ws://127.0.0.1:8090`;`POST/PUT /publish/<name>` 推流 → `ws://…/stream/<name>` 订阅二进制分块,文本帧留作控制信令,`GET /` 通道状态页;推流示例 `ffmpeg -re -i rtsp://cam -c copy -f flv http://127.0.0.1:8090/publish/cam1`)。
2. 本期**不要求真实公网网络流打通**;重点是解析层可用、渲染管线在浏览器能力可用时可用、文档诚实标注限制。
3. 延迟量级(HLS 5~30s / LL-HLS 1~5s / HTTP-FLV 1~3s / WebRTC 200ms~1s / WebSocket 自定义流几百毫秒)为可行性研究数据,引用时须标注来源待实测。

---

## 2. 总体范围与统一验收口径

### 2.1 模块总览(16 个验收单元)

> Owner 依看板《任务台账》/leader【roster-编制与归属】;类型与默认路线依 `docs/ARCHITECTURE.md` 选型矩阵。demux=解析层;transport=传输接入层(产出 Source 抽象,不实现 Demuxer 接口,契约 §2.5 注)。

| # | 目录 | 名称 | 类型 | 默认路线 | Owner |
|---|------|------|------|---------|-------|
| 1 | `core/` | 公共内核 | 基座 | — | media-dev |
| 2 | `mp4/` | MP4 播放器 | demux | WebCodecs(MSE 双路线) | media-dev |
| 3 | `mov/` | QuickTime 播放器 | demux | WebCodecs(MSE 双路线) | media-dev |
| 4 | `mkv/` | Matroska/WebM 播放器 | demux | WebCodecs | vue-dev-1 |
| 5 | `ts/` | MPEG-TS 播放器 | demux(双模源) | WebCodecs | vue-dev-2 |
| 6 | `flv/` | FLV 解析地基+薄播放壳 | demux(双模源) | Phase1 MSE 先行,双路线并行 | vue-dev-2 |
| 7 | `hls/` | HLS 数据源适配层 | demux(双模源) | MSE 保底 + WebCodecs 直解验证 | vue-dev-3 |
| 8 | `cmaf/` | CMAF 低延迟模块 | demux | WebCodecs | vue-dev-3 |
| 9 | `wav/` | WAV 音频播放器 | demux | pcm Sample→AudioWorklet | captain(M2 窗口认领) |
| 10 | `flac/` | FLAC 无损播放器 | demux+decode | WebCodecs/AudioWorklet | ui-kit-dev/captain |
| 11 | `ape/` | Monkey's Audio 播放器 | demux(头解析) | 元数据展示;解码=wasm 可选增强 | ui-kit-dev/captain |
| 12 | `subtitle/` | 字幕解析+渲染组件 | demux+site 组件 | Canvas 覆盖层(归 site 层) | designer |
| 13 | `webtorrent/` | P2P 传输接入 | transport→DataSource | 经 core 管线 | vue-dev-1 |
| 14 | `webrtc/` | WebRTC 播放端 | transport(原生管线) | MediaStream→video | vue-dev-3 |
| 15 | `rtmp/` | RTMP 桥接消费端 | transport→ChunkSource | WS-FLV→flv/ 解析→双路线 | vue-dev-2 |
| 16 | `rtsp/` | RTSP 桥接消费端 | transport→ChunkSource | interleaved/RTP→annexb→WebCodecs | vue-dev-2 |

配套目录:`docs/` · `site/`(共享皮肤,designer)· `samples/`(fixture 程序化生成 + gateway 参考)· `scripts/`(gateway/static-server/lint,根文件所有权=captain)。

### 2.2 统一交付物:每模块四件套(CONTRACTS §11.1 + 工程约定-v1.1)

| 交付物 | 硬性要求(qa 逐项检查) |
|---|---|
| `README.md` | 六要素:格式/协议原理;浏览器可行性结论;ASCII 架构图;快速开始示例;API 说明;**已知限制与路线** |
| `src/index.js` | 唯一入口,只用具名导出;纯 ESM `.js` + 中文 JSDoc;零构建;仅相对路径导入仓库内模块(禁 bare specifier/npm 包);demux 层主类命名 `<Format>Demuxer` 继承 core `Demuxer` 基类,并按契约 §10 导出注册形状(containerName/extensions/mimeTypes/probe/createDemuxer);codec 串一律取自 `core/src/codec-string.js`,禁止自行拼串 |
| `demo/index.html` | 静态直开或 `npm run demo` 可访问;拖入本地文件/输入地址;复用 `site/` 皮肤;控制台无未捕获异常 |
| `__tests__/` | `node --test` 可跑;fixture 由 `<module>/__tests__/fixtures/gen.mjs` 导出 `async generate(fixDir)` 程序化生成(产物 .gitignore 忽略,`npm run fixtures` 一键重建);单 fixture 文件 ≤256KB、离线可复现 |

### 2.3 根命令与全仓门禁

```
npm test         # 全仓 node --test,必须 0 fail(skip 须注明原因)
npm run lint     # scripts/lint.mjs 语法+卫生检查
npm run demo     # 8080 静态服务器(Range/CORS/中文路径)
npm run gateway  # 8090 WS 测试网关(rtmp/rtsp 联调前提)
npm run fixtures # 重建全部程序化 fixture
```

### 2.4 qa 执行口径:三段式写法(第 3 章统一遵循)

每条验收标准按「**输入 → 期望 → 异常**」书写,qa 可直接转成用例:

- **输入**:明确的 fixture(gen.mjs 生成)/用户操作/命令;
- **期望**:可观察行为(API 返回值、页面展示、事件序列);
- **异常**:故障注入后的表现——必须是受控失败(`PlayerError` 指定错误码/页面中文错误面板),**禁止**表现为崩溃、卡死或控制台未捕获异常。

通用异常纪律(适用于全部模块,各模块小节不再重复):

| 编号 | 纪律 |
|---|---|
| E1 | 任意 demuxer 的 `static probe()` 收到随机垃圾字节或其他容器样例 → 同步返回 `null`,不抛异常 |
| E2 | 结构损坏输入 → `PlayerError('PARSE_ERROR')`,且 Promise rejection 与 `'error'` 事件双通道并存,两边都须处理 |
| E3 | 未 `open()` 先调 `readSample(trackId)` → `throw PlayerError('STATE_ERROR')`(≈草案 INVALID_STATE;samples(trackId) 保留为迭代器糖层) |
| E4 | 直播流(seekable=false)上调 `seek()` → `reject PlayerError('SEEK_UNSUPPORTED')` |
| E5 | Node 环境(≥18 兼容)调用任何浏览器专属探测 → 返回 false/null,**不允许抛异常** |
| E6 | 日志禁打二进制本体(最多前 16 字节 hex),文案中文,默认级别 warn |
| E7 | 每个 demo 页空态与工作态各检查一次:控制台无未捕获异常 |

### 2.5 能力分级与降级(CONTRACTS §4)

- 同步快探:`hasWebCodecs()/hasMSE()/hasAudioWorklet()/hasWebGPU()/hasCryptoSubtle()`(Node 恒 false);
- 深探测:`detectCapabilities({deep:true})` → 逐 codec 支持矩阵 + cryptoSubtle 字段;
- 路线裁决:`chooseRoute(caps, mediaInfo)` → `'webcodecs' | 'mse' | 'none'`;
- **AES-128 降级路径**(契约 §4/§2.6):cryptoSubtle=false 时,hls 含 KEY 清单报 `NOT_SUPPORTED`,明文清单不受影响;
- 结果为 `none` 时,demo 页显示缺失能力清单(中文),解析层信息面板仍须可用(**解析层永远可用是底线体验**)。

---

## 3. 模块需求详述

> 每模块结构:定位与教学点 → 功能范围(本期做/明确不做)→ 验收标准(【单测】【demo】【异常】,三段式)。
> 单测数字为**最低门槛**;`node --test <module>/__tests__/` 指该目录全部用例且 0 fail。

### 3.1 `core/` —— 公共内核

**定位与教学点**:全家统一底座(types/error/logger/capability/source/codec-string/bits-reader/demux-base/render/audio);教学价值在字节读写、ExpGolomb、生命周期状态机等媒体基本功。

**功能范围**
- 做:`Sample/Track/MediaInfo/ProbeResult` 类型(JSDoc);`PlayerError` 十码封闭枚举(core/src/errors.js:PROBE_FAILED/PARSE_ERROR/NOT_SUPPORTED/SOURCE_ERROR/NETWORK_ERROR/DECODE_ERROR/SEEK_UNSUPPORTED/TIMEOUT/ABORTED/STATE_ERROR——STATE_ERROR 即草案 INVALID_STATE 定稿名);迷你 Emitter(≤80 行,on/off/once/emit,监听器抛错隔离);四级 logger;`DataSource/ChunkSource` 抽象与 Memory/File/HttpRange 实现(HttpRange 并发 Range 合并,最小分片默认 256KiB)+ChunkBuffer;bits-reader/ExpGolomb;`readSampleData(sample)`(lazySamples 可选优化);`codec-string.js` 全家族生成(h264CodecStringFromSps/hevcCodecStringFromHvcC/aacCodecStringFromAsc/fallbackCodecString);capability 五探针(含 hasCryptoSubtle)+ detectCapabilities + chooseRoute;`Demuxer` 基类(`idle→opening→ready⇄seeking→destroyed` 状态机强制,直播态叠加 paused 标志;方法族 open/readSample/pause/resume/seek/destroy + mediaInfo/tracks/metadata 属性,samples() 为迭代器糖层);createVideoRenderer(Phase1 仅 Canvas2D,VideoFrame 单一所有权,finally 保证 close)/createAudioOutput(f32-planar 唯一 PCM 形态,'player-audio-sink',currentTimeUs 主时钟,underrunCount)。
- 不做:任何具体容器知识;UI 组件;网络重试策略(归传输层)。

**验收标准**
- 【单测】≥ 40 例,关键断言:bits-reader 越界/跨字节位域/ExpGolomb 异常输入不抛且返回约定值;codec-string 黄金用例(SPS→`avc1.640028`、ASC→`mp4a.40.2`、hvcC→`hev1.1.6.L93.B0`、VP9→`vp09.00.10.08`、PCM 族 `pcm-u8/s16/s16be/s24/s32/f32/alaw/ulaw`、字幕 `x-srt/x-ass/x-vtt`);参数集解析失败必须走 fallbackCodecString 并 warn,**不得编造 profile**;capability 在 Node 断言全 false 且不抛(E5),探测内部异常吞掉计 false 不上抛;Emitter once/off 与抛错隔离;HttpRange 用 mock fetch 断言并发 Range 合并与 256KiB 分片;ChunkBuffer 把乱序到达分块聚合成可随机读;`Demuxer` 基类非法状态迁移 throw `STATE_ERROR`(含 open 前调 readSample、destroy 后调用两条路径);AudioOutput 写入 f32-planar 经 mock worklet 断言环形缓冲水位与 underrun 计数。
- 【demo】打开 `core/demo/index.html` → 展示 detectCapabilities 能力矩阵徽标页;浏览器人工核对徽标与 navigator/MediaSource 实际存在性一致。
- 【异常】E1/E5/E7;渲染器异常路径 VideoFrame 必须 close(代码评审项,M3 实机核对无内存持续增长迹象)。

### 3.2 `mp4/` —— MP4 播放器

**定位与教学点**:ISO-BMFF 入门首选;box 树、sample table(stts/stsc/stsz/stco/co64/stss)、fragment(moof/tfra)。

**功能范围**
- 做:`Mp4Demuxer`(probe `ftyp`,confidence≥0.8);moov 前置与后置(DataSource Range 回读,不全量载入);fragmented MP4 流式;trun/sbgp 优先、退化 stss 找关键帧;输出 `bitstreamFormat:'avc'`,description=avcC 原样字节;AAC ASC→`mp4a.40.x` 经 core;seek 关键帧对齐返回 `{actualTimestampUs}`。
- 不做:DRM(sinf/cenc);HDR 色彩管理;remux 之外的写入混流。

**验收标准**
- 【单测】≥ 40 例:gen.mjs 手写 box 生成的最小合法 MP4(1 视频 1 音频)probe 命中 container='mp4';open() 后 mediaInfo/tracks 属性可用(tracks 顺序 video>audio,durationUs 整数 µs);readSample(videoTrackId) 循环(samples() 糖层等效)按 DTS 序输出、timestamp 恒为 PTS 且单调不减、keyframe 与 stss 一致;moov-at-end fixture 全通过;moof 序列按 fragment 顺序输出;description 字节与写入 avcC 逐字节一致。
- 【demo】①拖入 fixture `.mp4` → 信息面板 3 秒内显示 container/tracks 表(codec 串/分辨率/时长/轨数);②点「枚举样本」→ 前 N 个 Sample 的 timestamp/keyframe 列表时间戳递增;③(M3 起)「播放」按钮 Chrome 上首帧上 Canvas 连续 ≥10s。
- 【异常】拖入改名为 .mp4 的 PNG → probe null → 错误面板 `PROBE_FAILED` 中文文案;头部正确中部截断 → `PARSE_ERROR`,页面不崩、可重新拖入(E7 复查)。

### 3.3 `mov/` —— QuickTime 播放器

**定位与教学点**:ISO-BMFF 家族 QuickTime 变体;elst 编辑列表、moov 后置(流式录制常见)、QuickTime 音频 fourcc。

**功能范围**
- 做:moov 前置/后置双支持(契约 §2.5 明确要求);`wide/skip/edts/elst/udta/meta`;elst 对 PTS 的修正(修正前后均可查);QuickTime fourcc 映射(`lpcm/twos/sowt` 等);ProRes 类编码(`apcn` 等)**识别但不承诺解码**,轨道表黄色「识别未解码」状态而非报错。
- 不做:ProRes/DNxHD 软解;QuickTime VR;历史奇变体全兼容。

**验收标准**
- 【单测】≥ 30 例:moov-at-end fixture open() 成功;含单条 elst(media time≠0)时输出 PTS = 原始 PTS − elst.mediaTime 换算 µs(黄金值断言);fourcc→codec 映射表逐项;未知 box 跳过后继续解析。
- 【demo】拖入 `.mov`(gen.mjs 提供 moov-at-end 与含 udta 两款)→ 信息面板含「编辑列表修正」折叠区与元数据键值;ProRes 样例显示识别徽标。
- 【异常】PROBE_FAILED/PARSE_ERROR 口径同 mp4;ProRes 轨道**不得**触发 error 事件,只出现在轨道表状态列。

### 3.4 `mkv/` —— Matroska/WebM 播放器

**定位与教学点**:空白方向 ★★★★★;EBML 变长整数、Segment/Cluster 层级、Lacing、Cues 索引。

**功能范围**
- 做:EBML magic `0x1A45DFA3` probe;DocType matroska/webm(container 取值 'mkv'|'webm');Info(Duration×TimecodeScale→整数 µs 就近取整)/Tracks/Cluster/SimpleBlock/BlockGroup;三种 Lacing(Xiph/fixed/EBML)展开;Cues 索引 seek,**Cues 缺失时线性扫描建索引**(契约 §2.5);CodecID→codec 串一律经 core codec-string;无法映射时轨道表显式标红 + warn,不抛异常。允许两步走交付:第一步 webm 子集可播,第二步补全 matroska 常用特性(qa 分两次验收)。
- 不做:ContentEncoding 加密(识别并 NOT_SUPPORTED);附件字体渲染(路线图);章节导航 UI(解析出列表即可);DV/杜比视界。

**验收标准**
- 【单测】≥ 60 例(全仓最多):EBML vint 全边界(1~8 字节/保留位/未知 size);三种 lacing 各 ≥2 例展开逐帧一致;SimpleBlock 相对时间码负值;Cues seek 落点命中正确 Cluster;无 Cues fixture 走线性扫描建索引且 seek 结果与有 Cues 版本一致;畸形元素(截断/超长 size)→ PARSE_ERROR 不崩溃;CodecID 映射表全覆盖(`V_MPEG4/ISO/AVC`→avc1 串 + avcC description 重建)。
- 【demo】拖入 `.mkv/.webm` → DocType/Duration/TimecodeScale/Track 表(CodecID 及映射 codec 串,失败标红)/Cluster 计数;(M3 起)Chrome 渲染首帧;有 Cues 时 seek 到 50% 再渲染一帧。
- 【异常】加密 MKV → NOT_SUPPORTED 中文提示;垃圾字节 → PROBE_FAILED;截断 → PARSE_ERROR。

### 3.5 `ts/` —— MPEG-TS 播放器

**定位与教学点**:IPTV/监控/HLS 分片核心;188 包结构、PAT/PMT、PES、PTS/DTS 33bit 回绕。

**功能范围**
- 做:双模源;0x47 同步与损坏 resync;PAT/PMT **动态更新**(中途变更生效);PES 跨包重组;PTS/DTS 2^33 回绕钳制(warn);ADTS→ASC;PCR 时钟基准;多 program 枚举与选择;视频输出 `bitstreamFormat:'annexb'`(description=null 或 SPS/PPS 说明性数据)。
- 不做:CA 加密节目;SI/EPG 全表;DVB 字幕。

**验收标准**
- 【单测】≥ 45 例:gen.mjs 从零合成 TS(PAT/PMT/PES 手工打包,1 视频 1 音频);注入连续垃圾字节后 resync,resync 后 sample 流仍正确(拼接结果与参考流一致);PMT 中途更新 fixture(新增音轨)后 tracks 更新;PTS 回绕 fixture 时间戳钳制正确且产生 warn;ADTS 头非法 → 该包丢弃计数 +1 不中断整流;多节目 fixture 选择指定 program 只出该 program 轨道。
- 【demo】拖入 `.ts` → program/PMT 树 + 轨道表;program 切换刷新;内置「注入扰动」开关演示 resync;(M3 起)Chrome 播放选中 program ≥10s。
- 【异常】非 0x47 流 → PROBE_FAILED;全损流 → PARSE_ERROR 且已解析信息保持可见。

### 3.6 `flv/` —— FLV 解析地基 + 薄播放壳

**定位与教学点**:HTTP-FLV 主力直播形态 + rtmp 桥接必选依赖;Tag 流、AMF0、AVC sequence header。生产播放场景 README 声明请用 flv.js。

**功能范围**
- 做:probe `"FLV"`;header/tag/PreviousTagSize;AMF0 onMetaData;AVC sequence header→avcC description、AAC ASC;Tag 时间戳 ms→µs;AVCVIDEOPACKET 按 AVCC 输出(`bitstreamFormat:'avc'`);FlvRemuxer:tag 流→fMP4 init+media segment(Phase1 MSE 快速上线路线,复用 core mux-fmp4);Enhanced-FLV FourCC 与非官方 CodecID=12 HEVC **识别并提示**(不承诺解封装完整性);双模源。
- 不做:Enhanced-FLV 全量支持(路线图);私有加密 FLV。

**验收标准**
- 【单测】≥ 35 例:gen.mjs 手工构造最小 FLV(script tag+video sequence header+N 个音视频 tag);tag 流任意切块喂入输出不变;onMetaData 黄金断言;截断半 tag 缓冲等待,end() 后未完成 tag 计丢弃;FlvRemuxer 产出 init segment 可被本仓 mp4 probe 识别(交叉自洽断言);CodecID=12 轨道带「HEVC(非标)」提示字段。
- 【demo】拖入 `.flv` → 时长/宽高/编码/关键帧数;(M3 起)MSE 薄播放壳按钮;ws-flv 地址输入框连接失败提示「需要 WebSocket-FLV 网关(npm run gateway)」,属预期不算缺陷。
- 【异常】垃圾字节 → PROBE_FAILED;tag 流损坏 → PARSE_ERROR;ws 不可达 → NETWORK_ERROR 中文文案。

### 3.7 `hls/` —— HLS 数据源适配层

**定位与教学点**:m3u8 标签语义可视化;差异化在「分片→统一内核→WebCodecs 直解」路线验证与 AES-128 整段解密(RFC8216 IV 两规则)。生产场景 README 声明请用 hls.js;AES-128 解密为本期硬验收——**按 leader 最终裁决恢复 v1.0 原始范围**(qa 引用的 v1.0 §3.7 原文即硬验收,v2.0 重写引入回退,属一致性纠正而非新增范围,无需报用户确认;见【裁决-契约优先】【裁决-契约基线v0x】与契约 v0.2 §2.6)。

**功能范围**
- 做:m3u8 master/media 两级解析(RFC8216 常用标签全集 + LL-HLS PART/PRELOAD-HINT 结构感知,BYTERANGE/DISCONTINUITY/EXT-X-MAP/ENDLIST);分片编排器(顺序下载/失败重试上限/fetch 可注入);TS 与 fMP4 分片混排路由至 ts//mp4/ 子 demuxer 统一输出;**EXT-X-KEY METHOD=AES-128 整段解密**(契约 §2.6):DecryptingSource 解密层位于 Source 与 demuxer 之间(demuxer 无感知),WebCrypto AES-CBC,IV 取标签属性或媒体序号 128 位大端,options.keyLoader 密钥加载可注入,node --test 注入 node:crypto webcrypto 同构双环境可测;MSE 保底首发 + WebCodecs 直解验证;直播窗口滑动跟随。
- 不做:**SAMPLE-AES 及一切 DRM 方案(报 `NOT_SUPPORTED`,不得静默跳过)**;METHOD=NONE 正常直通;ABR 自动切换算法;LL-HLS 阻塞式传送完整实现。(支持边界 README 显著声明:AES-128 已支持,SAMPLE-AES/DRM 不支持;cryptoSubtle 缺失环境对含 KEY 清单报 NOT_SUPPORTED,明文清单不受影响——契约 §2.6/§4。)

**验收标准**
- 【单测】≥ 50 例:master/media 黄金 playlist 各 ≥5 组标签组合;直播窗口模拟(时间推进后请求窗口收敛到最新段);BYTERANGE 偏移黄金值;DISCONTINUITY 序列号处理;AES-128 全链路(gen.mjs 以 node webcrypto 加密生成 fixture):解密输出与明文参考流逐字节一致、IV 两规则黄金用例(标签属性/媒体序号推导)、keyLoader 失败→NETWORK_ERROR、密钥长度≠16 字节→NOT_SUPPORTED、解密后首块校验失败(TS 应 0x47)→PARSE_ERROR、SAMPLE-AES 清单→NOT_SUPPORTED 且不触发解密、注入 cryptoSubtle=false→含 KEY 清单 NOT_SUPPORTED;畸形行跳过计数;全程 fetch/keyLoader mock 离线可测。
- 【demo】三种输入:①URL(CORS 失败显示「跨域受限,属浏览器安全策略」解释+本地验证指引,属预期);②粘贴 m3u8 文本;③一键加载 demo 内置静态 VOD(samples 生成)。期望:解析树+分片列表;内置 VOD 完整可播(M3 起);qa 冒烟四步:播放→暂停→seek→续播。
- 【异常】404 → NETWORK_ERROR;SAMPLE-AES/DRM 清单 → NOT_SUPPORTED(不得静默跳过);crypto.subtle 缺失环境遇含 KEY 清单 → NOT_SUPPORTED(中文文案指引);密钥获取失败 → NETWORK_ERROR;非 m3u8 文本 → PROBE_FAILED。

### 3.8 `cmaf/` —— CMAF 低延迟模块

**定位与教学点**:LL 流媒体方向;chunk 化 fMP4、sidx 索引、switching set。

**功能范围**
- 做:probe ftyp+`styp`/sidx;chunk 化 fMP4 解析,分片级 sidx 索引;**LL 场景允许未收尾就吐 sample**(契约 §2.5);约束校验子集(chunk 内单 moof、movie-fragment timecode 连续性)+ switching set 字段比对报告;chunk 粒度回调供低延迟消费;与 mp4/ 的 box 解析复用策略提 architect 裁决(台账 T14),裁决前自含开发。
- 不做:CMAF 合规认证全集(README 列明未覆盖项);`.mpd`/playlist 编排;加密 CMAF。

**验收标准**
- 【单测】≥ 25 例:gen.mjs chunk 序列边界与顺序;sidx 索引 seek 落点;故意违规 fixture(chunk 内两个 moof)被校验器准确报 PARSE_ERROR;timecode 不连续报告指出 chunk 序号;缺尾 chunk 的未收尾流已输出此前全部 sample。
- 【demo】加载内置 CMAF track 序列 → chunk 边界时间线 + 约束 pass/fail 列表;「低延迟模式」对比整分片模式首帧耗时数值。
- 【异常】非 fMP4 → PROBE_FAILED;违规结构 → PARSE_ERROR 且报告面板给出违规项中文名。

### 3.9 `wav/` —— WAV 音频播放器

**定位与教学点**:难度最低起步模块;RIFF chunk 结构、位深与采样格式。

**功能范围**
- 做:probe `RIFF…WAVE`;fmt(WAVE_FORMAT_EXTENSIBLE)/data/LIST/INFO/cue/PEAK;PCM 位深 u8/s16/s24/s32/f32 + alaw/ulaw(契约 §3 PCM 族全集);直接产 `pcm-*` Sample;AudioWorklet 播放(f32-planar/'player-audio-sink'/currentTimeUs 主时钟,M3);波形缩略图。
- 不做:压缩 wav(ADPCM)→ NOT_SUPPORTED;标签编辑;录制。

**验收标准**
- 【单测】≥ 25 例:六种位深 fixture 解码输出与 gen.mjs 参考波形逐样本相等(±0 容差);EXTENSIBLE channelMask 解析;乱序/未知 chunk 跳过继续;cue 点位置换算 µs;alaw/ulaw 展开黄金值。
- 【demo】拖入 `.wav` → fmt 详情+波形图+时长;(M3 起)播放/暂停/点击波形 seek 出声,underrunCount 面板可见。
- 【异常】ADPCM wav → NOT_SUPPORTED 中文提示;data chunk 截断 → PARSE_ERROR 且已解部分可听。

### 3.10 `flac/` —— FLAC 无损播放器

**定位与教学点**:纯 JS 无损解码参考实现;子帧类型/LPC/Rice、CRC 校验链。

**功能范围**
- 做:probe `fLaC`;METADATA 全解析(STREAMINFO 作 description——契约 §2.5;SEEKTABLE/VORBIS_COMMENT/PADDING/CUESHEET);帧解码 CONSTANT/VERBATIM/FIXED/LPC+Rice **全覆盖**;帧头 CRC-8/帧尾 CRC-16 强校验;codec='flac';SEEKTABLE 快速 seek;解码吞吐基准用例(风险 R4)。
- 不做:Ogg 封装 FLAC;MD5 校验失败的容错播放(直接 PARSE_ERROR,守住无损承诺);>192kHz 规格承诺(能过则过,不过 README 如实标注)。

**验收标准**
- 【单测】≥ 35例:**往返法**——测试内迷你 FLAC 编码器(仅覆盖声称支持参数域)生成正弦/噪声 fixture,解码输出与编码输入 PCM 逐字节一致(参数组合 ≥8 组:blocksize 大小/声道分配 left-side 等/LPC 阶数/Rice 分区);篡改任一比特必被 CRC 检出报 PARSE_ERROR;STREAMINFO 边界值;吞吐基准:44.1kHz/16bit/立体声解码速率 ≥ 实时 2 倍(宽容系数与测试环境在用例注释注明)。
- 【demo】拖入 `.flac` → STREAMINFO/标签/SEEKTABLE 条目数;(M3 起)播放+seek 出声;面板显示解码耗时与「MD5 校验通过」徽标。
- 【异常】损坏帧 → PARSE_ERROR 并停在出错帧(面板显示已正确解码时长);OggFLAC → NOT_SUPPORTED。

### 3.11 `ape/` —— Monkey's Audio 播放器

**定位与教学点**:高风险模块按既定裁决**分层交付**(T2 指令 + ARCHITECTURE Phase 3 结论 + ui-kit-dev 开工承诺三方一致):解析层硬验收,解码层降级为 wasm 可选增强。

**功能范围**
- 做(硬验收):MAC 头全字段解析(版本/压缩级别/块数/每块样本数/最终帧样本数/声道/采样率/位深);APE Tags v2(UTF-8 键值);Seek Table 偏移换算;cue 关联;probe(MediaInfo 先出——契约 §2.5);demo 元数据展示 + 支持状态徽标。
- 做(可选增强):wasm 解码加载路径(探测到则启用播放;探测不到显示「解码增强未安装,详见 README」;README 声明获取方式与降级行为;不进主链路,不违零依赖红线)。
- 不做:JS 全量解码(本期明确放弃,历史版本分支过多);APEv1 标签写入。

**验收标准**
- 【单测】≥ 20 例(全部针对解析层,硬门禁):gen.mjs 手工构造 MAC 头字段边界值 fixture;版本分支(<3800/3980+/压缩级别)解析正确;APE Tags UTF-8/特殊字符;SeekTable 偏移→时间换算黄金值;头截断 → PARSE_ERROR。
- 【demo】拖入 `.ape` → 头字段表+标签+时长+「解码:wasm 增强(未安装)」徽标;徽标引导至 README;无未捕获异常。
- 【异常】垃圾字节 → PROBE_FAILED;旧版本头 → 解析成功 + 黄色提示「该版本不在解码支持范围(见 README 已知限制)」。

### 3.12 `subtitle/` —— 字幕解析与渲染

**定位与教学点**:难度低需求刚性;时间码格式、ASS 样式系统。渲染 UI 归 site 层(契约 §8),本模块交付解析器(Cue 流)+ site 渲染组件对接。

**功能范围**
- 做:SRT/WebVTT 解析(必做);ASS/SSA 解析(尽力,白名单标签:Style 定义、`\b \i \u \s \fn \fs \fsp \c \1c \alpha \pos \an \fad \org \clip(矩形)`);内容嗅探(x-srt/x-vtt/x-ass);按契约 §8 导出 Cue 流接口:`probe(bytes)` / `parseCues(bytes)→AsyncIterable<Cue>` / `createTextTrack(cues)`(含 cuesUntil(us) 重放窗口);`Cue{trackId,startUs,endUs,text,raw?}`(text=纯文本行,raw=原始条目字节供 ASS 高级渲染);Player 侧经 `'cue'` 事件驱动上屏、seek 后按 cuesUntil 重放活动窗口;渲染归 site 层 overlay(对接 DESIGN.md §6.5 骨架);libass-wasm 可选增强(缺失时降级纯文本,README 声明)。
- 不做:`\t` 动画插值全套、`\p` 矢量绘图、卡拉 OK `\k`、3D/\bez(进白名单外清单,路线图)。

**验收标准**
- 【单测】≥ 35 例(SRT/VTT 为硬门槛;ASS 尽力项不计门槛但已实现项必须有断言):三格式黄金用例(BOM/CRLF/畸形行跳过并返回 skippedLines);时间码三种格式互转;`\pos` 坐标与 `\an` 九宫锚点布局求解数值断言;白名单外标签进 unsupportedTags 数组不崩溃;x-srt/x-vtt/x-ass 嗅探;parseCues 输出 startUs/endUs 整数 µs 黄金值且 text/raw 双通道一致。
- 【demo】加载内置样例或拖入本地 `.srt/.vtt/.ass` → 时间轴滑杆拖动,覆盖层实时渲染对应文本;\pos/\an 目测位置正确;面板列出未支持标签清单;与视频 demo 联动时随 currentTimeUs 同步。
- 【异常】二进制文件 → PROBE_FAILED;空字幕文件 → 解析成功 0 条 + 提示,不算错误。

### 3.13 `webtorrent/` —— P2P 传输接入

**定位与教学点**:边下边播;bencode、piece 管理、稀疏下载策略。**浏览器侧硬前提:需 WebRTC tracker(无 UDP,DHT/BEP-5 不可用)**,故以传输抽象+mock 回放为硬验收(风险 R3)。

**功能范围**
- 做:bencode 编解码;`.torrent` metainfo(single/multi-file)与 magnet URI 解析;info-hash v1 计算(v2/混合种子结构感知并提示);piece 选择策略(文件头优先>顺序>稀有度微调,固定种子可复现);文件偏移→piece 映射;streaming assembler(下载到文件头即可开始 demux);Transport 接口抽象,交付 `DataSource`(契约 §2.5 注);mock transport 回放模式。
- 不做(可选增强,README 声明环境要求):真实 swarm(WebTorrent tracker 协议+RTCDataChannel);做种;加密 peer;DHT(明确说明浏览器不可行的原因)。

**验收标准**
- 【单测】≥ 40 例:bencode 往返(嵌套 dict/list/int/string)与畸形拒绝;黄金 torrent 断言 name/files/piece length;offset 跨 piece 边界映射;固定种子下 piece 选择决策序列完全可复现;assembler 乱序收 piece 时头部齐备即产出可读前缀。
- 【demo】①粘贴 magnet 或拖入 `.torrent` → 离线解析 name/files/info-hash 文件树;②「模拟下载」:mock transport 回放,piece 热力图点亮,头部齐备后完成 demux 显示轨道信息;③「连接真实 swarm」灰显+tooltip「需 WebRTC tracker 环境,见 README」。
- 【异常】畸形 magnet → 校验失败中文提示;模拟下载中断(mock 移除)→ 状态栏等待,恢复续传,无未捕获异常。

### 3.14 `webrtc/` —— WebRTC 播放端

**定位与教学点**:200ms~1s 低延迟,"rtsp.js 其实应该变成 webrtc.js";信令/SDP/ICE 状态机。走原生管线(MediaStream→video),不经 demux 契约。

**功能范围**
- 做:Signaling 信令抽象(offer/answer/candidate 编解码,WebSocket 内置实现+可注入);`webrtc://` URL 约定映射(兼容 SRS 风格参数);SDP 规范化(方向/编解码偏好);播放包装(pc→MediaStream→video);getStats 统计面板(RTT/丢包/码率/fps);ICE 状态机与断线重连;**本地回环模式**(canvas.captureStream→pc1→loopback ICE→pc2→video,零外部服务)。
- 不做:TURN/STUN 部署承诺(demo 用公共 STUN 并注明生产自建);WHIP/WHEP(路线图兼容项);录制;多人会议。

**验收标准**
- 【单测】≥ 25 例:信令消息编解码往返;webrtc:// URL 参数解析黄金值;SDP fixture mangle 前后断言(编解码顺序/direction);ICE/连接状态机迁移表逐迁移;Node 下全局缺失走降级不抛(E5)。
- 【demo】打开即有「本地回环演示」按钮(本期硬验收,无需外部服务):点击后 video 出画面,信令日志滚动,统计面板数值跳动;qa 在 Chrome 与 Safari 各执行一次截图留档;自定义信令地址留空=回环。
- 【异常】信令不可达 → 中文连接状态提示+退避重连,无未捕获异常;getUserMedia 被拒 → 权限提示(回环模式用 canvas 不受影响)。

### 3.15 `rtmp/` —— RTMP 桥接消费端(⚠️ 非直连)

**定位与教学点**:诚实形态=「WebSocket-FLV 消费端」。README 原理章节讲清 RTMP 握手/chunk stream 为何无法浏览器直连(TCP API 缺失)及最佳拓扑。**e2e 依赖本地网关前提:`scripts/gateway.mjs` 已备好并冒烟通过**(风险 R1)。

**功能范围**
- 做:WS-FLV 消费端——订阅 `ws://127.0.0.1:8090/stream/<name>`(二进制帧=FLV 字节分块保序原样;文本帧=控制信令,按契约 §9:JSON 一帧一条 meta/eos/error/hello,meta 缺席退化为对首分块 probe 嗅探,eos 缺席以空闲超时判除断流,须容忍发送者回声),以 GatewayChunkSource implements ChunkSource(契约 §9.4)接入交 flv/ 解析(hls-flv 重定位裁决:flv/ 是必选依赖);心跳与指数退避重连;连接状态机(连接中/等待推流/播放中/断线重连);`rtmp://` 直连输入**拒绝并给教育文案**(为什么不行+推荐拓扑);README 附网关使用说明(ffmpeg 推流示例见 §1.5)。
- 不做:浏览器内 RTMP 协议实现(写了也连不上,仅在 README 讲解);真实 RTMP 服务器联调承诺(排查指南代替)。

**验收标准**
- 【单测】≥ 20 例:WS 二进制帧 mock(含粘包/任意分块)聚合后与原始 FLV 字节流逐字节一致;退避状态机(定时器 mock)按 1s/2s/4s…封顶节奏;文本帧不污染字节流;错误码→中文文案映射全覆盖。
- 【demo】①输入 `rtmp://…` → 拒绝提交并显示教育文案(预期行为);②启动 `npm run gateway` + 上游推流(ffmpeg 示例或 samples 回放脚本)→ 输入 ws 地址 → 播放;③kill 上游 → 状态栏「推流已断开,等待重推」,恢复推流自动续播;④gateway 未启动 → NETWORK_ERROR 中文提示。
- 【条件验收】:②③为**条件验收**(前提=本机 gateway+上游),qa 无 ffmpeg 环境时用 samples 回放脚本替代;该项不通过不阻塞 M4 主线,但验收报告必须标注原因。

### 3.16 `rtsp/` —— RTSP 桥接消费端(⚠️ 非直连)

**定位与教学点**:可行路径=WS 中继(interleaved/RTP over TCP)或 WebRTC 网关,本项目交付前者消费端。教学点 SDP、RTP 解包、FU-A 分片。e2e 同样依赖本地网关(风险 R1)。

**功能范围**
- 做:interleaved 帧($ + channel + length)解析与 ASCII 请求/响应建模(OPTIONS/DESCRIBE/SETUP/PLAY 语义,发送由网关代理);SDP 解析(m=/rtpmap/fmtp/sprop-parameter-sets 提取 SPS/PPS);RTP 序号乱序重排(简化 jitter buffer)、序号/时钟回绕;H264 depacketizer(FU-A/STAP-A/Single-NALU 全覆盖)+ HEVC FU 基础;RTCP SR 的 NTP/RTP 时间映射(延迟估算);输出 AnnexB(`bitstreamFormat:'annexb'`,description=null)→ WebCodecs 直解;经 GatewayChunkSource(契约 §9.4)接入;canned interleaved 流 fixture 由 gen.mjs 程序化生成。
- 不做:UDP 传输(原理章节讲清不可行);RTSP over TLS 网关细节;ONVIF/PTZ(路线图);真实摄像头联调(排查手册代替)。

**验收标准**
- 【单测】≥ 40 例:interleaved 帧与 ASCII 消息交错流边界解析(黄金字节流 fixture);SDP 全字段断言;乱序 RTP 注入后输出序号严格递增且 payload 完整;FU-A 重组 golden(STAP-A 多 NALU/单 NALU/FU-A 三形态各 ≥2 例);AnnexB 起始码(00 00 00 01)格式断言;SR 时间映射换算黄金值。
- 【demo】①输入 `rtsp://…` → 拒绝并教育文案;②gateway+回放脚本推 canned H264 interleaved 流 → 订阅播放上 Canvas,面板显示 SDP 摘要+RTP 连续性统计;③「注入乱序」开关演示 jitter buffer 生效(fixture 固定画面肉眼核对不花屏)。
- 【条件验收】:②③同 rtmp,gateway+上游就绪为前提。

---

## 4. 里程碑 M1~M4 验收口径

> 与《任务台账 v1》及 overseer 核产判据一致:M1=架构契约定稿+全模块骨架;M2=解析器+单测;M3=WebCodecs/MSE 管线打通+site 汇总 demo;M4=修复闭环+总 README 状态表+交付汇报。凡口头完工而无磁盘产物一律按虚报处理。
> 与 ARCHITECTURE「Phase 1~3」的关系:Phase 是技术路线分层(哪些模块走哪条渲染路线),M 是交付节奏;M2 收口 ≈ Phase1 解析面,M3 覆盖 Phase1~2 管线面,M4 收口 Phase3 桥接与长尾。

### M1 —— 架构契约定稿 + 全模块骨架

| # | 出口条件(qa 逐条核) |
|---|---|
| 1 | `docs/CONTRACTS.md` 定稿且看板署名帖存在 ✅ 已达成(版本线按 leader 裁决已切 0.x,引用以契约文档现行内容与变更记录为准);后续变更按治理流程记版本 |
| 2 | `docs/ARCHITECTURE.md`、`docs/DESIGN.md`、本 PRD(v2.0)落盘,关键决定署名上板 |
| 3 | 16 个模块四件套骨架齐:README(六要素标题占位)、src/index.js(具名导出可 import 不抛错)、demo/index.html(空态可开)、\_\_tests\_\_/ ≥1 条冒烟用例 |
| 4 | `npm test` 全绿;`npm run lint` 通过;`npm run fixtures` 可重建且产物不入库(.gitignore 生效) |
| 5 | `site/` 皮肤就位(tokens/base/layout/components.css + skin.js/icons.svg,对齐 DESIGN.md §10 类名总表) |

### M2 —— 解析器实现 + node --test 单测

| # | 出口条件 |
|---|---|
| 1 | 16 模块全部达到第 3 章【单测】门槛(合计 ≥565 例,0 fail,skip 有因可查) |
| 2 | **probe 交叉矩阵**:每类 fixture 喂给全部其他 demuxer 的 probe,必须 null 或低置信度,不允许误判(qa 用脚本批量执行) |
| 3 | CONTRACTS §2.5 对齐清单逐模块核对(含 §2.4 别名表迁移期核对:open/readSample/destroy/description/'text'),reviewer 职能执行,输出问题清单;时间基全链路整数 µs 抽查 |
| 4 | 传输层四模块交付 Source 抽象与协议解析单测(webtorrent DataSource/mock 回放;webrtc 信令;rtmp/rtsp 帧解析+网关 §9 信令健壮性) |
| 5 | 每个 demo 空态与拖入解析态均无未捕获异常(渲染管线不要求) |

### M3 —— WebCodecs/MSE 管线打通 + site 汇总 demo

| # | 出口条件 |
|---|---|
| 1 | `chooseRoute` 在 demo 生效:同一文件在支持 WebCodecs 的 Chrome 走 webcodecs,兼容场景走 mse,都不支持显示缺失能力清单 |
| 2 | 视频容器(mp4/mov/ts/flv/hls/cmaf/mkv)各完成至少一条「拖入→首帧上 Canvas→连续播放 ≥10s」实机链路(Chrome 最新稳定版) |
| 3 | 音频(wav/flac)AudioWorklet 出声,currentTimeUs 主时钟推进,暂停/seek 生效,underrunCount 面板可见 |
| 4 | seek 关键帧对齐实测:mp4/mkv 各一例,resolve 返回 actualTimestampUs 且落点为关键帧 |
| 5 | MSE 兜底:flv/hls 各一例走 MSE 播放成功 |
| 6 | subtitle 渲染上屏并与播放时间同步;webrtc 本地回环播放(Chrome+Safari 各一次) |
| 7 | rtmp/rtsp 条件验收通过(gateway+上游/回放脚本);条件不满足时在验收报告标注 |
| 8 | `site/index.html` 总汇总页:全模块卡片导航+状态徽标(解析/单测/demo/管线);所有 demo 页 E7 复查 |
| 9 | Safari/Firefox 能力矩阵实测回填各 README(qa 执行) |

### M4 —— 修复闭环 + 总 README 状态表 + 交付汇报

| # | 出口条件 |
|---|---|
| 1 | reviewer 两轮评审问题清单逐条闭环(修复或书面豁免,豁免经 captain 批准留档) |
| 2 | qa 出具《验收报告》:按第 3 章条款号逐条 pass/fail,附单测实数、demo 截图、异常用例记录 |
| 3 | 缺陷全部登记任务台账跟踪闭环,fatal/blocker 清零 |
| 4 | 根 README 模块状态表:16 模块 × [probe/解析/单测数/demo/管线/已知限制] 矩阵,与磁盘实际产物一致 |
| 5 | README 已知限制终审:每模块「不支持/降级/条件验收」三项如实呈现(「学得真」标准的落地检查) |
| 6 | captain 向用户交付汇报 |

---

## 5. 风险清单

| # | 风险 | 影响/可能性 | 应对(已固化进需求) | 责任 |
|---|------|-----------|---------------------|------|
| **R1** | **RTMP/RTSP 依赖本地网关前提**(`scripts/gateway.mjs` 已备好:8090,`POST /publish/<name>` 推流→`ws://…/stream/<name>` 二进制分块,冒烟通过):端到端播放还需上游持续推流源(ffmpeg 或回放器),CI 无法自动化真实摄像头/公网链路 | e2e 不可自动化 / 高 | 单测全部基于 gen.mjs 离线 mock 帧;samples 提供 canned 流回放推流脚本替代 ffmpeg;demo 前置条件中文文案;rtmp/rtsp e2e 定为**条件验收**(§3.15/§3.16),不通过不阻塞 M4 主线但须留档原因 | net-dev 职能(captain 兼)+vue-dev-2 |
| **R2** | **APE 解码复杂度**(多版本格式历史包袱) | 工期失控 / 高 | 已裁决允许降级:硬验收=MAC 头/APEv2 TAG/SeekTable 解析+元数据展示;JS 全量解码不做,wasm 解码做成可选增强(README 声明获取方式与降级行为);与 ARCHITECTURE Phase 3 结论、ui-kit-dev 开工承诺一致 | ui-kit-dev/captain |
| **R3** | **webtorrent 浏览器端需 WebRTC tracker**(无 UDP→DHT/BEP-5 不可用;公网 swarm 依赖 tracker 可达性与 NAT 类型) | 真实环境不可控 / 高 | 硬验收=Transport 抽象+mock 回放(piece 策略/assembler 全覆盖);真实 swarm 为可选增强,demo 默认灰显注明环境要求;README 说明 DHT 不可行原因 | vue-dev-1 |
| **R4** | **FLAC/APE 纯 JS 解码性能上限**(主线程 GC/无 SIMD,高规格追不上实时) | 高规格卡顿 / 中 | 解码吞吐基准入单测(≥2× 实时阈值,宽容系数与环境注明);AudioWorklet 线程化解码管线评估;不达标规格 README 写明上限;APE 已按 R2 降级不受影响;flac SEEKTABLE 降低 seek 后解码压力 | ui-kit-dev/captain |
| R5 | WebCodecs/MSE 兼容性碎片化(H265 硬解参差,Safari/Firefox 进度不一) | 部分浏览器管线不可用 / 高 | capability 探测+chooseRoute 降级(§2.5);解析层底线体验;M3-9 能力矩阵实测回填 | media-dev/qa |
| R6 | mkv/EBML 工作量失控(无限长元素/lacing/in-band extradata) | M2 延期 / 高 | 允许 webm 子集两步走(§3.4);Cues 缺失线性扫描兜底已入契约;定期向 captain 报燃尽 | vue-dev-1/captain |
| R7 | 字幕 ASS 像素级还原差距(特效长尾极大) | 用户预期落差 / 高 | 白名单承诺制+unsupportedTags 显式清单;libass-wasm 可选增强补足;渲染对照截图留档 | designer |
| R8 | SAMPLE-AES/DRM 被期待支持(AES-128 已按 Q1 裁决纳入本期支持) | 预期落差 / 低(主场景已收敛) | AES-128=WebCrypto 同构整段解密硬验收(§3.7);SAMPLE-AES/DRM 明确 NOT_SUPPORTED;README 显著声明支持边界 | vue-dev-3 |
| R9 | CORS 导致在线输入失败被误判为 bug | issue 噪音 / 高 | 统一中文错误文案模板+本地验证指引;site 首页说明卡 | designer/pm |
| R10 | 大文件内存压力(全量载入崩溃) | 大文件场景不可用 / 中 | DataSource Range 惰性读取为架构约束(moov/Cues 后置必须回读非全量);HttpRange 实现最小分片 256KiB | architect/media-dev |
| R11 | 接口漂移(先例:push/flush 提案早于契约定稿) | 集成返工 / 中 | 一律以 docs/CONTRACTS.md 现行文本为准;变更走治理流程(captain 批准+看板记版本);reviewer 按契约评审 | architect/reviewer 职能 |
| R12 | 需求来源为 AI 会话总结,量化论断未经实测 | 文档误导 / 中 | 量化数据标注来源待实测;qa 实测回填;冲突以实测为准并走变更流程 | pm/qa |

---

## 6. 验收流程与角色分工

1. **captain**:组织本 PRD 初验 → 按台账派发/跟催 → M1~M4 出口组织核产(对照 overseer 判据:口头完工而无磁盘产物=虚报)→ 向 leader/用户汇报。qa/reviewer/overseer 缺编期间由 captain 代行初审(《协作约定与编制现状》),正式评审请 leader 补员。
2. **architect**:维护 CONTRACTS(变更走治理流程);裁决模块间复用问题(cmaf↔mp4 box 解析共享,台账 T14)。
3. **designer**:site 皮肤与 demo 交互规范落地;subtitle 渲染组件(§3.12)。
4. **qa**:以本 PRD 第 3 章三段式条款为唯一验收依据出具《验收报告》;M2 执行 probe 交叉矩阵;M3 实机能力矩阵;缺陷登记台账。
5. **reviewer 职能**:按「契约符合性/纯 ESM 零依赖/中文注释/仅依赖 core」两轮评审,只出清单不改代码。
6. **pm**(本人):维护本 PRD;范围/口径变更经用户确认后更新并同步 captain;看板发布《每模块验收标准摘要表》供全员对齐。

---

## 7. 变更记录

| 日期 | 版本 | 变更人 | 变更内容 |
|------|------|--------|---------|
| 2026-08-25 | v1.0 | pm | 首版:定位/16 模块详述/五件套基线/M0~M5 里程碑/13 条风险 |
| 2026-08-25 | v2.0 | pm | 按 T2 重构:①定位改为教学型(读得懂/跑得通/学得真),采纳 PurePlay 品牌裁决;②全量对齐 CONTRACTS v1.0.0 词汇(Sample/µs/probe/MediaError/chooseRoute 等),验收标准改为 qa 三段式执行口径(输入→期望→异常,E1~E7 通用异常纪律);③里程碑对齐台账 M1~M4 并给出逐条出口条件;④风险清单更新:R1 本地网关前提(scripts/gateway.mjs)、R2 APE 降级裁决、R3 webtorrent 需 WebRTC tracker、R4 FLAC/APE 纯 JS 性能上限列前四位;⑤采纳既有裁决:hls/flv 重定位、ape 分层交付、HLS 加密分片 NOT_SUPPORTED、webtorrent/webrtc/rtmp/rtsp 为传输接入层**(历史记载,现行口径见 v2.1)** |
| 2026-08-25 | v2.1 | pm | 纯术语对齐修订(不改结构,单测门槛/demo 步骤实质不变;对齐基准=磁盘现行 CONTRACTS 文本):①`MediaError` 九码→`PlayerError` 十码并集(新增 SOURCE_ERROR,INVALID_STATE 定名 STATE_ERROR,见契约 §11.3);②方法体系 parseInit/samples/stop→open/readSample(+samples 糖层)/destroy + mediaInfo/tracks/metadata 属性,生命周期 idle→opening→ready⇄seeking→destroyed(直播 paused 标志);③ByteSource→DataSource,基类 BaseDemuxer→Demuxer;④字幕轨接口改 Cue 流(契约 §8:Cue{trackId,startUs,endUs,text,raw}/parseCues/createTextTrack,x-srt/x-vtt/x-ass);⑤**hls 条款按 leader 最终裁决恢复 v1.0 原始范围:AES-128 整段解密为本期硬验收**(qa 引用的 v1.0 §3.7 原文即硬验收,v2.0 重写引入回退,恢复属一致性纠正非新增范围,无需用户确认;SAMPLE-AES/DRM 维持 NOT_SUPPORTED,R8 同步降级);⑥网关信令引用契约 §9(meta/eos/hello、meta 缺席首分块嗅探、eos 缺席空闲超时、GatewayChunkSource);⑦能力探测补 hasCryptoSubtle 与 AES-128 降级路径;⑧章节引文重编号(§6.x→§11.x、对齐清单 §2.5)。增量校准:CONTRACTS **v0.2** 已落盘(临时编号废止并入 0.x 线+接口冻结条款 §12.3 生效至 M2 评审完成),经逐条比对与本次对齐基准一致,本文引用已正式切换为 v0.2 |
| 2026-08-25 | v2.2 | pm | **防误读标注版,零条款变更**:针对三次催办所引"§3.7 仍为不支持口径"的过期快照,在文档头增加阅读提示(现行=AES-128 支持,v2.0 历史行仅为史实),状态行记录三轮核验结论。经逐行取证:§3.7 做项(236 行)/单测 AES-128 全链路(240 行)/R8(427 行)自 v2.1 起即为支持口径;全仓仅此一份 PRD;旧句全仓 *.md 零命中。qa 侧 TESTPLAN v1.1、用例集 HLS-N02 已同口径(AES-128 解密往返),其 Q1 结案行的"残留事项"备注写于本仓 v2.1 修复之前,属过期快照,已提请 qa 关闭。**结案**:leader 采纳 pm 核实结论(我方合规,催办所引系过期快照),并按其指示于 v2.0 历史行尾补「(历史记载,现行口径见 v2.1)」括注,AES-128 口径四方对齐彻底完成,无遗留 |
