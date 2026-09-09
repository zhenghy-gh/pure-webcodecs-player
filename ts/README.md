# ts/ —— MPEG-TS 解复用器 · PurePlay

纯前端（浏览器 / Node≥22 同构）的 MPEG-TS 解复用实现：**188 字节包同步（自动识别 M2TS 192 包）→
PSI(PAT/PMT) 跨包 Section 重组 + CRC32 → PES 重组 → H.264/H.265 AnnexB 提取 → AAC(ADTS/LATM) 拆帧**。
对外接口遵循 `docs/CONTRACTS.md v0.2`（§2.2 Demuxer / §10 注册形状），时间基为整数微秒。

- 纯 ESM JavaScript + 中文 JSDoc，零构建、零第三方运行时依赖
- 双模数据源：DataSource（随机读）与 ChunkSource（流式推送，WebSocket 网关/fetch body）
- `npm run test:ts` 单测 50 例全绿；fixture 程序化生成（含与共享库 samples/fixtures 的交叉验证）

> 定位说明：TS 无同等地位的开源参考库，本模块为自研解析地基；hls/ 模块的 TS 分片直接复用本模块工具层。

## 一、MPEG-TS 格式速览

```text
TS 流
┌─────────────────────────────── 188B × N ─────────────────────────────┐
│ Packet: sync(8)=0x47 | TEI,PUSI,prio | PID(13) | scr,AF,CC(4)         │
│         [Adaptation Field: 长度+PCR+填充]                              │
│         Payload ── PID 0x0000 → PAT（节目→PMT PID）                    │
│                   ── PMT PID   → PMT（stream_type + ES PID + 版本）    │
│                   ── ES PID    → PES（一帧视频/一段音频, PTS/DTS 33bit） │
└────────────────────────────────────────────────────────────────────────┘
ES: H.264/H.265 = AnnexB 起始码 NALU 串；AAC = ADTS/LATM 帧
```

## 二、浏览器可行性结论

✅ 完全可纯前端。TS 解析是纯字节状态机；解码走 WebCodecs（天然 AnnexB 直解，
契约 §6 定稿路线：TS 仅 WC 路线、不做 TS→fMP4 remux）。hls.js 多年生产验证了浏览器内 demux TS。

## 三、架构图

```text
 DataSource.read 顺序泵          ChunkSource.write（构造时接管）
        │                                │
        ▼                                ▼
   ┌─────────────────────────────────────┐
   │        TsStreamEngine（内部内核）      │
   │  188/192 同步探测 → 失步滑动恢复        │
   │  PsiAssembler(跨包Section+CRC32)      │
   │  PAT/PMT 版本对账（防双状态分裂）        │
   │  PES 重组（declared_length 提前出帧     │
   │   + 缓冲上限保护）                     │
   │  H264/H265: AnnexB 切分·SPS/PPS(/VPS) │
   │   捕获→avcC/hvcC·SPS宽高·关键帧判定     │
   │  AAC: ADTS 拆帧/LATM(AudioSyncStream) │
   │   ASC 构建·1024采样 µs 步进闭式计算      │
   │  CC 连续计数检测（断续告警）              │
   └──────────────────┬──────────────────┘
                      ▼ 引擎事件（内部）
   ┌─────────────────────────────────────┐
   │  TsDemuxer extends core.Demuxer      │  ← 契约适配壳
   │  open/readSample/samples/seek/       │
   │  pause/resume/destroy                │
   │  边界换算: ticks→µs(ticksToUs)         │
   │  codec string ← core/codec-string.js │
   └─────────────────────────────────────┘
```

## 四、快速开始

```html
<script type="module">
  import { createDemuxer } from './ts/src/index.js';

  // 文件拖入（工厂接受 File/Blob/Uint8Array/DataSource/ChunkSource/url）
  const demuxer = await createDemuxer(fileInput.files[0]);
  console.log(demuxer.mediaInfo.container);            // 'ts'
  console.log(demuxer.tracks.map((t) => [t.id, t.codec])); // [['257','avc1.42C01E'], …]

  const video = demuxer.tracks.find((t) => t.type === 'video');
  for await (const sample of demuxer.samples(video.id)) {
    render(sample.timestamp, sample.data);   // timestamp 为整数微秒 PTS
  }
</script>
```

WebSocket 网关直播流（§9.4 ChunkSource 接线）：

```js
import { TsDemuxer } from './ts/src/index.js';
const ws = new WebSocket('ws://127.0.0.1:8090/stream/live');
const demuxer = new TsDemuxer({ write() {}, end() {} });   // 构造时接管 write/end
ws.binaryType = 'arraybuffer';
ws.onmessage = (e) => e.data instanceof ArrayBuffer && demuxer.source.write(new Uint8Array(e.data));
await demuxer.open();
```

演示页：仓库根目录起静态服务后打开 `ts/demo/index.html`
（program/PMT 树、扰动开关 resync 演示、轨道导出 .264/.265/.aac）。

## 五、API 说明

### class `TsDemuxer extends core.Demuxer`（公开面已冻结 §12.3）

| 成员 | 说明 |
|------|------|
| `static probe(bytes)` | → ProbeResult（confidence 0.92 强特征 / 0.55 弱特征）或 null；同步不抛异常 |
| `constructor(source, options)` | source=DataSource\|ChunkSource\|Uint8Array\|File；options 含 initTimeoutMs 等 |
| `open()` | 解析 PAT/PMT 至轨道就绪；resolve MediaInfo；emit `'media-info'` |
| `readSample(trackId)` | pull 主通道；EOS 为 null；未 open 抛 STATE_ERROR |
| `samples(trackId)` | 异步迭代器糖层 |
| `seek(us)` | TS 无索引容器恒 reject SEEK_UNSUPPORTED（路线图：PCR 索引 seek） |
| `destroy()` | 幂等；之后一切调用抛 STATE_ERROR |
| `start()` | 直播推送入口：start 后自动逐轨消费并以 `'sample'` 事件 `{trackId,sample}` 吐出；pause/resume 控制吐包节奏 |
| 属性 | mediaInfo / tracks / metadata / state |

MediaInfo/Track/Sample 形状以 `core/src/types.js` 为权威：
Track 含 `description`(avcC/hvcC/ASC)、`bitstreamFormat:'annexb'`、诊断用 `timescale`；
Sample 为 `{trackId,codec,timestamp(µs),duration(µs),data,keyframe,dts,size,index}`。

### 内部引擎与可复用工具

| 模块 | 导出 |
|------|------|
| `ts-stream-engine.js` | TsStreamEngine（push/flush 内核；psiSnapshot() 供 demo 呈现 program/PMT 树与 CC/ignoredStreams 诊断） |
| `psi.js` | parsePAT/parsePMT（含 versionNumber）/PsiAssembler/mpegCrc32 |
| `pes.js` | parsePESHeader/decodeTimestamp5/encodeTimestamp5 |
| `nalu.js` | splitAnnexB/annexbToAvcc/buildAvcc/buildHvcc/parseH264SpsDimensions/parseHevcSpsDimensions |
| `aac.js` | splitAdtsFrames/parseLatmSyncStream/splitLatmUnits/buildAudioSpecificConfig |

**访问单元（AU）划分口径**：TS 中一个 PES 承载一个视频访问单元（H.264/H.265 按 AnnexB 切分
NALU 后整段作为一个 Sample 输出，SPS/PPS 随关键帧内联保留）；音频一个 PES 可含多帧，
ADTS/LATM 按帧拆分、每帧一个 Sample 并以闭式公式补齐 µs 时间戳。
| `bits.js` | BitReader/BitWriter/unwrapTimestamp（2^33 回绕解卷积） |

## 六、时间戳设计（契约 §0.5）

- 视频：PES PTS/DTS 为 90kHz ticks，输出边界经 `ticksToUs(ticks,90000)` 就近取整为整数微秒；
- 音频：`基准 µs + round(i×1024×1e6/采样率)` 闭式计算，跨 PES 无累计漂移；
- 33bit 回绕由 `unwrapTimestamp` 折叠为单调轴（单测覆盖回绕用例）；
- Track.timescale 保留原生值仅供诊断。

## 七、已知限制与路线

| 项 | 现状 | 路线 |
|----|------|------|
| 加扰流 | transport_scrambling_control≠0 跳过并告警 | 浏览器无解密责任，维持 |
| 多节目 | PAT 多节目均记录 PMT，样本按 PID 全收 | 按需增加节目选择过滤 |
| HEVC 多子层 SPS 宽高 | 返回 null（不影响解复用） | 补 profile_tier_level 子层语法 |
| LATM | audioMuxVersion=0 单层常见形态 | 按需补全 StreamMuxConfig 变体 |
| 其他编码（MP2V/MP3…） | ignoredStreams 记录后跳过 | 需求驱动逐个接入 |
| PCR 时钟基准 | 未暴露 | 直播延迟统计需要时开放 |
| seek | SEEK_UNSUPPORTED | 基于 PCR/关键帧扫描建索引后支持 |

---
*作者：vue-dev-2 · 契约对齐自检见看板《vue-dev-2 kickoff ts-flv parser contract v1》（v2 已按 CONTRACTS v0.2 完成）。*
