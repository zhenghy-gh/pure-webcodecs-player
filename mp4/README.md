# @player/mp4 —— ISO-BMFF(MP4/fMP4) 容器模块

纯前端实现 MP4 解复用与 fMP4 重封装：本地 File 拖入或 HTTP Range 渐进加载 → demux → 输出 MSE（fMP4 segment）或 WebCodecs 逐帧解码。

- **纯 ESM、零第三方依赖**；解析层在 Node 下可完整测试（`__tests__/fixtures/gen.mjs` 程序化生成 + 内存构造器双通道，不依赖真实大文件）。
- **对齐 CONTRACTS v0.2**：Sample 边界输出一律整数微秒（timestamp/duration/dts），内部采样表保持原生 ticks；`static probe→ProbeResult|null`；`open()/readSample(trackId)/seek(timestampUs)→{actualTimestampUs}`；轨字段用 `description/numberOfChannels/durationUs`，视频 `bitstreamFormat:'avc'`。

## 架构图

```
                 ┌────────────────────────────────────────────────┐
 File / HTTP ──► │ DataSource（Memory/Blob/HttpRange）              │
 (Range 渐进)    └───────────────┬────────────────────────────────┘
                                ▼
   ┌──────────────────────── Mp4Demuxer ────────────────────────┐
   │ 顶层扫描(只读 box 头) → moov 解析 → stbl 采样表展开          │
   │ 普通 MP4：样本表一次成型        fMP4：顺序遍历 moof/mdat     │
   └──────┬─────────────────────────────────┬───────────────────┘
          ▼ Sample 流                        ▼
   ┌── WebCodecs 管线 ──┐            ┌── Fmp4Remuxer ──────────┐
   │ VideoDecoder       │            │ init: ftyp+moov(+mvex)  │
   │ AudioDecoder       │            │ seg : moof+mdat(GOP对齐)│
   └──► Canvas/AudioWorklet          └──► MseHelper ► <video> ─┘
```

## 浏览器可行性结论

✅ **完全可纯前端**。MP4/fMP4 是 MSE 原生容器，WebCodecs 对 AVC/HEVC 的支持也以 avcC/hvcC 为描述——两条管线都无需服务端参与。HTTP 渐进播放要求服务器支持 `Accept-Ranges: bytes`（静态服务器默认支持）。

## 快速开始

### 本地文件拖入 → MSE 播放

```js
import { Mp4Demuxer, remuxDemuxer, attachFileDrop } from '../mp4/src/index.js';
import { BlobDataSource, MseHelper } from '../core/src/index.js';

attachFileDrop(dropZone, async (source) => {
  const demuxer = new Mp4Demuxer(source);
  const info = await demuxer.open();

  const mse = new MseHelper(videoEl);
  await mse.open();
  for await (const { track, init, segments } of remuxDemuxer(demuxer)) {
    const key = `t${track.id}`;
    await mse.addTrack(key, `${track.type === 'audio' ? 'audio' : 'video'}/mp4; codecs="${track.codec}"`);
    await mse.append(key, init);
    for (const seg of segments) {
      await mse.append(key, seg.data);
      if (key.startsWith('t1')) videoEl.currentTime = 0; // 收到首段即可起播
    }
  }
}, { accept: ['.mp4', '.m4v'] });
```

### HTTP Range 渐进播放（moov 在尾部也能播）

```js
import { HttpRangeDataSource } from '../mp4/src/index.js';

const ds = new HttpRangeDataSource('https://example.com/movie.mp4', { chunkSize: 256 * 1024 });
const demuxer = new Mp4Demuxer();
demuxer.attach(ds);
await demuxer.init();      // 只拉 box 头与 moov，mdat 不整读
// 之后 samples()/remuxDemuxer() 会按需 Range 拉取
```

### WebCodecs 管线

```js
import { Mp4WebCodecsPipeline } from '../mp4/src/index.js';
import { VideoFrameRenderer } from '../core/src/index.js';

const pipeline = new Mp4WebCodecsPipeline(demuxer, {
  onVideoFrame: (frame) => renderer.draw(frame), // frame.close() 由渲染器策略决定
});
if ((await pipeline.supported()).supported) await pipeline.start();
```

## API 说明

| 导出 | 说明 |
|------|------|
| `Mp4Demuxer` | 静态 `probe(bytes)→ProbeResult|null`；`new Mp4Demuxer(source,{lazySamples})` → `open()` → `readSample(id)/samples(id)/seek(µs)`（契约 §2.2）；lazy 时样本带 `dataState:'lazy'` |
| `expandSampleTable(stbl)` | stts/stsc/stsz/stco/co64/ctts/stss → 样本表（导出供测试与自定义容器复用）|
| `parseMoofTracks(moofBytes)` | moof → 各轨分片记录（tfhd/tfdt/trun）|
| `Fmp4Remuxer` | 入口为契约 µs 样本：`createInitSegment(track)` / `createMediaSegment(track, samples)`（内部回转轨 ticks 写 tfdt/trun）；`resetSequence()` |
| `batchSamplesByGop(samples, opts)` | 按 GOP + 目标时长切批 |
| `remuxDemuxer(demuxer, opts)` | 一键：demux 全量 → `{track, init, segments}[]` |
| `HttpRangeDataSource` | 实现已收口 core/src/http-range-source.js（§2.1），此处薄壳再导出；分块 LRU 缓存，fetchImpl 可注入 |
| `attachFileDrop/pickFile` | 本地文件接入辅助（返回 disposer）|
| `buildVideoConfig/buildAudioConfig` | Track → WebCodecs 配置（纯函数）|
| `Mp4WebCodecsPipeline` | mp4 专属 WebCodecs 管线（视频 `VideoDecoder`→canvas、音频 `AudioDecoder`→AudioWorklet），与 core `WebCodecsPipeline` 同源；`new Mp4WebCodecsPipeline(demuxer, {onVideoFrame})` → `supported()` → `start()` |

## 关键实现决定

1. **tfhd 固定 `default-base-is-moof`**：data_offset 以 moof 起点为基准，规避 base_data_offset 的 64 位兼容性坑；
2. **trun 一律 version 1**（带符号 composition offset）：B 帧负 CTS 安全；
3. **无 stss 视为全关键帧**（ISO-BMFF 规范约定）；
4. **加密轨道（encv/enca）直接 NOT_SUPPORTED**：DRM 超出纯前端范围；
5. **渐进扫描只读 box 头**：moov 在文件尾部时不会把 mdat 读进内存。

## 运行测试

```bash
npm run fixtures && node --test "mp4/__tests__/*.test.js"   # 43 例全绿（含真实 http Range 服务与产物级端到端）
```

> ⚠️ `tkhd` 含 `layer(2B)` 标准字段（历史实现漏掉，导致 width/height 错位恒 0、fMP4 init segment 被 Chrome 拒收）。
> 改动 `box-builder.js` 的 `buildTkhd` 后必须重跑 `npm run fixtures` 重建产物，否则 `artifacts-edge` 的字节比对会失败。

## 已知限制与路线

- 暂不解析 `sidx`（分段索引），fMP4 直播场景按文件序线性消费；
- 暂不支持多 sample description 切换（stsd 多条目取第一条）；
- HEVC over MSE 依赖浏览器 isTypeSupported 探测，Safari 可用、Chrome 需硬解支持；
- 路线：sidx 随机访问、CMAF chunk 化输出（配合 cmaf 模块）、AV1。
