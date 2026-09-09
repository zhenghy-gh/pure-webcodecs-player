# 总体架构（ARCHITECTURE）

> 版本：**v0.2**　|　日期：2025-08-25　|　署名：architect（架构师）
> 依据：`docs/00-需求与可行性结论.md`、`docs/PRD.md`；接口规范见 `docs/CONTRACTS.md` v0.2（唯一权威锚点，本文档与其同版本演进）。
> 变更须经 captain 批准并在看板记录版本。

---

## 1. 总管线图（含网关位置）

```
┌──────────────────────────────────────────────────────────────────────────┐
│ L5 应用层    site/ 共享皮肤(PurePlay) · 各模块 demo/index.html · 拖文件/输地址│
├──────────────────────────────────────────────────────────────────────────┤
│ L4 播放控制层 core/player（契约 §5）：六态状态机 idle/ready/playing/paused/ │
│              seeking/error + ended 标志 · 缓冲管理 · 音频主时钟同步 · seek编排│
├──────────────────────────────────────────────────────────────────────────┤
│ L3 解码渲染层（契约 §6/§7 二选一路径）                                       │
│   WebCodecs 路径: VideoDecoder/AudioDecoder → VideoFrame/AudioData         │
│        → Canvas2D/WebGPU 渲染器 + AudioWorklet('player-audio-sink')        │
│   MSE 路径:      fMP4 Muxer(core/mse-helper) → SourceBuffer → <video> 内建  │
├──────────────────────────────────────────────────────────────────────────┤
│ L2 容器解封装层（契约 §2 统一 Demuxer 接口，open/readSample/seek…）          │
│   mp4 mov cmaf mkv ts flv hls(=数据源适配层) wav flac ape subtitle(Cue流)   │
├──────────────────────────────────────────────────────────────────────────┤
│ L1 传输接入层（交付物=DataSource/ChunkSource 抽象，不碰 Sample，契约 §2.1）   │
│   File/Blob · HTTP Range · fetch 流 · webtorrent→DataSource                │
│   DecryptingSource 解密层(AES-128 整段, 仅 hls, 契约 §2.6)                   │
│   webrtc→RTCPeerConnection 原生管线（仅信令抽象）                            │
│   rtmp/rtsp ──▶ samples/gateway（权威 WS 测试网关, net-dev, 契约 §9）       │
│                scripts/gateway.mjs = 冻结兼容入口                           │
│        POST /publish/<name> 推流 ──转发──▶ ws /stream/<name> 订阅二进制分块  │
│        ──▶ GatewayChunkSource(ChunkSource) → flv/ts demuxer                │
├──────────────────────────────────────────────────────────────────────────┤
│ L0 内核基座 core：types · PlayerError · logger · capabilities(+chooseRoute) │
│    codec-string · bit-reader/exp-golomb/nal · data-source · demuxer 基类     │
│    emitter · clock · mse-helper · stats · 注册表(probeBuffer/createAuto)    │
├──────────────────────────────────────────────────────────────────────────┤
│ 平台 API：WebCodecs · MediaSource · AudioWorklet/WebAudio · Canvas2D/WebGPU │
│           Fetch/File/WebSocket/WebRTC          （浏览器网络沙箱不可逾越）      │
└──────────────────────────────────────────────────────────────────────────┘
```

统一数据流水线：

```
字节流(File/Range/WS网关) → DataSource|ChunkSource → Demuxer(open/readSample)
  → Sample{trackId,codec,timestampµs,duration,data,keyframe}
     ├─ WebCodecs 路径: Decoder → VideoFrame/AudioData → 渲染器+AudioWorklet
     └─ MSE 路径:      fMP4 重封装 → SourceBuffer → 浏览器内建解码渲染
字幕轨旁路: subtitle → Cue 流(§8) → player 'cue' 事件 → site DOM overlay
```

**网关位置说明**：网关是 L1 的本地联调基础设施（非播放器模块），只解决"浏览器无 TCP/UDP"的桥接通道；它位于数据源之下、平台 WebSocket 之上，对上层暴露的语义就是 ChunkSource。权威实现=net-dev 的 `samples/gateway`（含协议 README+单测，终裁#3），根目录 `scripts/gateway.mjs` 冻结为兼容入口、行为一致；生产部署中对应独立的协议网关服务（仓库外），前端消费方式不变。

## 2. 各模块在管线中的位置

| 模块 | 层 | 管线角色 | 下游对接 |
|---|---|---|---|
| core | L0/L3/L4 | 基座+解码渲染+播放控制 | 所有模块 |
| mp4 / mov | L2 | 点播 ISO-BMFF 解封装 | WC 首选/MSE 兜底 |
| cmaf | L2 | LL 分片解封装（与 mp4 复用解析件） | WC 首选 |
| mkv | L2 | EBML 解封装 | 仅 WC |
| ts | L2 | 188 包/PES 解封装（hls 分片复用） | 仅 WC |
| flv | L2 | Tag 解封装 + FlvRemuxer（MSE 用） | 双路径；rtmp 桥接必选依赖 |
| hls | L2* | *重定位：m3u8 解析+分片加载的数据源适配层，非完整播放器 | 喂统一内核验证 WC 直解 |
| wav / flac / ape | L2 | 音频容器解封装（ape 本期仅头/TAG） | WC AudioDecoder 或 decodeAudioData 快速通道 |
| subtitle | L2 | SRT/VTT/ASS → Cue 流 | player textTracks → site 渲染 |
| webtorrent | L1 | torrent piece → DataSource | 交任意点播 demuxer |
| webrtc | L1 | 信令抽象 + RTCPeerConnection 播放端 | 平台原生管线，不经 demux |
| rtmp / rtsp | L1 | GatewayChunkSource（WS 桥接消费端） | flv/ts demuxer |
| site | L5 | 汇总导航页+统一皮肤（DESIGN.md 规范） | 全部 demo 页 |

依赖规则：自上而下单向，禁止反向与同层横依；demux 层只 import `core/src/index.js` 与自身；传输层只产出 Source 抽象；player 是唯一同时认识三方（demux/decode/render）的组件；循环依赖零容忍。

## 3. 双路线选型矩阵

详细逐行裁决表见 **CONTRACTS.md §6**（normative），此处为决策摘要：

- **WebCodecs = 主路线**：mov/mp4/cmaf/mkv/ts/wav/flac/ws 裸流全适用；延迟最低、行为可控、支持非 fMP4 内容。
- **MSE = 兼容兜底 + Phase 加速器**：mp4 近零 remux 可直接用；hls 保底首发；flv 双路线并行（FlvRemuxer）；mkv/ts 明确不做 MSE。
- **chooseRoute 算法**（core/capabilities.js）：tracks 全被 WC 支持 → `'webcodecs'`；可 remux fMP4 且 isTypeSupported 通过 → `'mse'`；否则 `'none'` 提示缺失能力。
- 同步策略：音频主时钟（Worklet currentTimeUs），无声轨退化 performance.now() 软时钟；视频 PTS ±20ms 对齐窗；直播丢帧追赶优先于暂停。

## 4. 里程碑技术路线（对齐 PRD M0~M5）

| 里程碑 | 技术路线要点 |
|---|---|
| M0 地基 | **CONTRACTS v0.1 + ARCHITECTURE v0.1 上板署名**（本文档）；各模块骨架按 §10 注册形状并行开工，暂不 import core |
| M1 最小闭环 | mp4/mov/flv/ts/wav 解析层 + node --test 全绿；flv 出 FlvRemuxer 打通 MSE 冒烟 |
| M2 主力格式 | hls 数据源适配层 + mkv + flac + subtitle Cue 流；ISO-BMFF 复用件沉淀 core（待 vue-dev-3 意见并入契约 v0.2）；ticks→µs 别名清理波次 |
| M3 播放管线 | core/player 六态状态机 + WebCodecs 主路线打通 + AudioWorklet 音频主时钟 + site 汇总 demo |
| M4 桥接接入 | rtmp/rtsp GatewayChunkSource（契约 §9 信令）+ gateway 增强建议排期 + webrtc 本地回环 |
| M5 收口 | reviewer 两轮评审 + qa 按 PRD 验收 + 根 README 模块状态表 |

## 5. 已知风险与对策

| 风险 | 对策 |
|---|---|
| WebCodecs 兼容性碎片化（PRD R1：Safari/Firefox HEVC/FLAC 参差） | chooseRoute 自动降级 MSE 或提示；capabilities 深探测逐 codec 判定 |
| MKV EBML 工作量（PRD R2） | 允许 webm 子集先行两步走（PRD 关键决策）；Cues 缺失线性扫索引 |
| HLS AES-128 加密分片 | **已支持**（契约 v0.2 §2.6，依 leader 裁决）：DecryptingSource 在 Source 与 demux 之间对整段分片做 WebCrypto AES-CBC 解密（IV 取自 KEY 标签或媒体序号）；`crypto.subtle` 缺失时降级 NOT_SUPPORTED；SAMPLE-AES/DRM 明确不做；其余容器本期一律不解密 |
| RTSP/RTMP 无法直连（事实基线） | 只做桥接形态：gateway WS 通道（§9）+ WebRTC 网关两条路，接口以 ChunkSource 收口 |
| 契约漂移（已发生 2 起：vue-dev-2 ticks/push-flush、core seek(timeSec)） | 按 CONTRACTS §12.1 裁决统一 µs 边界 + §2.4 别名表迁移；新代码一律对照 v0.1 |
| 零依赖下解析工作量大 | 公共解析件全部沉淀 core（bit-reader/exp-golomb/nal/isobmff），demux 只写容器逻辑 |

---

*签署：architect · 2025-08-25。media-dev 依 CONTRACTS v0.2 实现 core；各模块依 §10 形状注册、§2 清单对齐；偏离走契约治理流程。*
