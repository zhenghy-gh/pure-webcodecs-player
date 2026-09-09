# flv/ —— FLV 解析地基 + 薄播放壳 · PurePlay

> **定位声明（【裁决-hls-flv重定位】）**：本模块是 **FLV 解析地基**——Tag/AMF0/AVCC 解析器的
> 完整实现，是 rtmp/WebSocket-FLV 桥接（契约 §9.4）的必选依赖，也是 Demuxer 契约的参考实现之一。
> 对外叙事不与 flv.js 竞争：**生产场景请使用 [flv.js](https://github.com/bilibili/flv.js)**。
> 本模块保留 fMP4 remux 能力以服务 HTTP-FLV 薄播放壳与教学演示。

- 纯 ESM JavaScript + 中文 JSDoc，零构建、零第三方运行时依赖
- 输入双模：DataSource（File/Blob/内存，支持 seek）与 ChunkSource（HTTP-FLV/WS-FLV 流式）
- 视频支持传统 AVC、非官方 HEVC(CodecID=12)、**Enhanced-FLV FourCC(hvc1/hev1/av01/vp09)**
- `npm run test:flv` 单测 35 例全绿；对外接口遵循 `docs/CONTRACTS.md v0.2`

## 一、FLV 格式速览

```text
┌───────── Header (9B) ─────────┐
│ 'FLV' | version | flags | off │   flags: bit0=有视频 bit2=有音频
├──────── PreviousTagSize0 (4B) ─┤
│ Tag* : type(8音频/9视频/18脚本) │
│        DataSize(3) Timestamp(3+1扩展位) │
│        StreamID(3,恒0) | Data | PrevTagSize(4)
视频 Data: FrameType(4b)|CodecID(4b)|AVCPacketType|CTS(3B)|AVCC NALU
          （Enhanced-FLV: FrameType 后跟 FourCC + PacketType）
音频 Data: SoundFormat(4b)|Rate|Size|Type|[AACPacketType|AAC 数据]
脚本 Data: AMF0 "onMetaData" + 对象
```

## 二、浏览器可行性结论

✅ 完全可纯前端。解析为字节状态机；MSE 只吃 fMP4，故内置 remux 层把 AVCC 样本封装为
moof/mdat（flv.js 的核心工作）。RTMP 直连不可行，但 HTTP-FLV / WebSocket-FLV 桥接完全可达。

## 三、架构图

```text
 fetch body / File.slice 分片          WebSocket 网关二进制分块（§9.4）
        │                                     │
        ▼                                     ▼
   ┌──────────────────────────────────────────┐
   │           FlvParser（内部内核，流式状态机）    │
   │  9B 头校验 → Tag 定长头循环 → 按 type 分派     │
   │   ├─ script → AMF0 decode → onMetaData      │
   │   ├─ audio  → AACPacketType 0/1、MP3 直通     │
   │   └─ video  → 传统 AVC / CodecID=12 HEVC /   │
   │              Enhanced FourCC 白名单探测        │
   │  关键帧索引（绝对字节偏移，供 DataSource seek）  │
   └──────────────────┬───────────────────────┘
                      ▼ 引擎事件（内部）
   ┌──────────────────────────────────────────┐
   │  FlvDemuxer extends core.Demuxer           │ ← 契约适配壳
   │  ms→µs 精确换算｜description=avcC/hvcC/ASC   │
   │  bitstreamFormat='avc'｜codec string←core   │
   └──────────────────┬───────────────────────┘
             WebCodecs │ AVCC 原样直解        MSE 路径
                       │               ┌────────────────────┐
                       │               │ FlvRemuxer（薄壳）    │
                       │               │ initSegment+mediaSeg │
                       │               └──────────┬─────────┘
                       ▼                          ▼ appendBuffer
                 <canvas/WebCodecs>          MediaSource → <video>
```

## 四、快速开始

```html
<script type="module">
  import { createDemuxer } from './flv/src/index.js';

  const demuxer = await createDemuxer(fileInput.files[0]);
  console.log(demuxer.mediaInfo.durationUs);            // 整数微秒（onMetaData.duration×1e6）
  console.log(demuxer.tracks.map((t) => t.codec));       // ['avc1.42C01E','mp4a.40.2']

  for await (const sample of demuxer.samples(1)) {
    render(sample.timestamp, sample.data);               // AVCC 原样输出
  }
</script>
```

薄壳 MSE 播放：

```js
import { FlvDemuxer, FlvRemuxer } from './flv/src/index.js';
const demuxer = new FlvDemuxer(new BlobDataSource(file));
const remuxer = new FlvRemuxer({ fragmentUs: 500_000 });
remuxer.on('initSegment',  ({ data }) => sourceBuffer.appendBuffer(data));
remuxer.on('mediaSegment', ({ data }) => sourceBuffer.appendBuffer(data));
await remuxer.drain(demuxer);
```

演示页：静态服务后打开 `flv/demo/index.html`（时长/宽高/编码展示、seek、薄壳 MSE 播放验证）。

## 五、供 rtmp 模块复用的低层接口（⚠ 将被 rtmp 模块 import 复用）

net-dev 的 rtmp/WebSocket-FLV 消费端只需本节三个导出（`flv/src/index.js` 具名导出，纯数据、零媒体语义）：

```js
import { parseFlvHeader, FlvTagStream, iterateTags } from '../flv/src/index.js';

// 1) 头解析：'FLV'+version+flags+DataOffset；非法返回 null（不抛异常）
const head = parseFlvHeader(bytes);
//   → { version, hasAudio, hasVideo, flags, dataOffset }

// 2) 流式 Tag 遍历器（WebSocket 二进制分块直接喂入）
const stream = new FlvTagStream();
ws.onmessage = (e) => {
  for (const tag of stream.push(new Uint8Array(e.data))) {
    // tag = { type: 8|9|18, timestamp(ms,含扩展位), data: Uint8Array, offset }
  }
};
ws.onclose = () => stream.end();

// 3) 完整字节串的一次性生成器遍历
for (const tag of iterateTags(bytes)) { ... }
```

约定：
- `type`：8=音频 / 9=视频 / 18=脚本；`timestamp` 为毫秒（已并入扩展位）；`data` 不含 11 字节 Tag 头；
- `offset` 为该 Tag 头起始的绝对偏移（跨批次连续），可用于按需回读；
- 尾部不足一个完整 Tag 时留在缓冲等待后续 `push`；`end()` 后丢弃截断残包；
- 上层媒体语义（onMetaData/AVC 序列头/AAC ASC…）如需可直接改用 `FlvParser`（其分帧即本模块）。

## 六、API 说明

### class `FlvDemuxer extends core.Demuxer`（公开面已冻结 §12.3）

| 成员 | 说明 |
|------|------|
| `static probe(bytes)` | 'FLV' 魔数 → ProbeResult(0.95)；否则 null |
| `open()` | 头+序列头解析至轨道就绪；durationUs 来自 onMetaData.duration |
| `readSample/samples` | 契约样本：timestamp/dts 为 µs；data 为 AVCC 帧体 |
| `seek(us)` | DataSource 模式基于关键帧索引对齐 ≤us 最近关键帧，返回 {actualTimestampUs}；ChunkSource 抛 SEEK_UNSUPPORTED |
| `destroy()` | 幂等 |
| `start()` | 直播推送入口：start 后自动逐轨消费并以 `'sample'` 事件 `{trackId,sample}` 吐出；pause/resume 控制吐包节奏 |

Track 要点：`description`=avcC/hvcC/ASC；视频 `bitstreamFormat:'avc'`；
audio 用 `numberOfChannels`；codec string 全部经 `core/src/codec-string.js` 生成。

### class `FlvRemuxer`（薄壳 MSE 路径）

| 成员 | 说明 |
|------|------|
| `drain(demuxer)` | 逐轨拉取契约样本并 remux（Promise 至 EOS） |
| `pushSample(sample)` / `setTracks(tracks)` | 低层喂入（自定义管线用） |
| 事件 `initSegment/mediaSegment` | ftyp+moov 与 moof+mdat，可直接 appendBuffer |

## 七、Enhanced-FLV 支持说明

采用 **FourCC 内容白名单探测**（avc1/avc3/hvc1/hev1/av01/vp09）而非依赖某一版草案位定义，
兼容 ZLMediaKit/SRS 等主流服务器输出；同时保留非官方 CodecID=12（HEVC）传统路径。

## 八、已知限制与路线

| 项 | 现状 | 路线 |
|----|------|------|
| 多音轨/多视频轨 | 单视频+单音频 | Enhanced-RTMP multitrack 按需扩展 |
| MP3 音频 | demux 直通（durationUs=0），MSE 无法容器化 | 如需播放走 WebAudio 路线 |
| AV1/VP9 | 配置透传、codec string 留空（禁止编造 profile） | 浏览器支持面明确后接入 |
| seek 音频对齐 | 从关键帧文件位置继续（近似对齐） | 建立音频独立索引精确对齐 |
| Worker 化 | 未拆分（模块无 DOM 依赖可整体迁入） | 大码率场景按需 |

---
*作者：vue-dev-2 · 契约对齐自检见看板《vue-dev-2 kickoff ts-flv parser contract v1》（v2 已按 CONTRACTS v0.2 完成）。*
