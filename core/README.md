# @player/core —— 纯前端播放器公共内核

所有容器模块（mp4 / mov / ts / flv / mkv / hls ...）共用的 L0 基座：数据契约、位流原语、NAL 转换、能力探测与路线裁决，以及 MSE / WebCodecs / AudioWorklet 三条输出端与音画同步。

- **纯 ESM、零第三方依赖、零构建**：入口 `src/index.js`，只用具名导出。
- **权威契约**：`docs/CONTRACTS.md` **v0.2**（接口冻结至 M2 评审完成）；本模块即其 §1/§2/§3/§4/§7 的参考实现。
- **双环境**：浏览器直开 + Node ≥22（除 DOM 渲染件外全部可 `node --test` 直跑）。

## 架构图

```
                 ┌──────────────────────────────────────────────┐
   容器模块       │  core（本模块，L0 基座）                       │
 (mp4/mov/...)   │                                              │
 ┌────────────┐  │  DataSource ──► Demuxer 基类 ──► Sample(µs)   │
 │ Mp4Demuxer │─►│        │            open/readSample/seek      │
 └────────────┘  │  ByteStream/BitReader/exp-Golomb/NAL 原语     │
                 │        │                                     │
                 │  ┌─────┴──────────────────────────────┐       │
                 │  │ A：MseHelper ► <video>              │       │
                 │  │ B：WebCodecs ► VideoFrameRenderer    │       │
                 │  │          ► AudioWorklet('player-audio-sink')│
                 │  └─────────────────────────────────────┘       │
                 │  Clock+AvSync(audio master) · Stats · chooseRoute│
                 └──────────────────────────────────────────────┘
```

## 快速开始

统一内核不内置任何解码器，也不绑定具体容器：搭配一个容器模块（如 `mp4` / `hls` / `ts`）即可播放。

```js
import { createPlayer } from '../core/src/index.js';
import { Mp4Demuxer } from '../mp4/src/index.js';

const video = document.querySelector('video');

// createPlayer 内部按 url 嗅探容器并选路（WebCodecs 优先，MSE 保底）
const player = await createPlayer({
  url: 'https://example.com/movie.mp4',
  demuxerFactory: (source) => new Mp4Demuxer(source),
  mediaElement: video,            // 走 MSE 路线（<video>）；若要 WebCodecs 路线改传 canvas: <canvas>
  routePreference: ['webcodecs', 'mse'],
});

await player.load();
await player.play();              // 起播前向缓冲到 bufferTargetUs（默认 3s）后出水

player.on('firstframe', () => console.log('首帧已出'));
player.on('error', (e) => console.error(e.code, e.detail));

await player.seek(20_000_000);    // seek 20s，落点按关键帧对齐
await player.selectTrack('audio', 1);
await player.destroy();           // 幂等释放解码器与元素
```

> 两条路线均在真实浏览器跑通（见「真实浏览器端到端验收」）：WebCodecs 直用浏览器 `VideoDecoder/AudioDecoder`；MSE 把样本重封装成 fMP4 交给 `<video>` 内建解码。

## 浏览器可行性结论

| 能力 | Chrome/Edge | Firefox | Safari | 说明 |
|------|-------------|---------|--------|------|
| WebCodecs 解码 | ✅ 94+ | ⚠️ 130+ | ✅ 16.4+ | 主路线 |
| MSE (fMP4) | ✅ | ✅ | ✅ macOS/iPadOS | 兼容兜底；iPhone `<video>` 受限 |
| ManagedMediaSource | ✅ 108+ | ❌ | ✅ 17+ | MseHelper `managed` 选项 |
| AudioWorklet | ✅ 66+ | ✅ 76+ | ✅ 14.1+ | processor 注册名 `'player-audio-sink'`（§7 定稿）|

## 数据契约（§1 权威形状）

- **时间基硬约束（§0.5）**：边界上一切 timestamp/duration 为**整数微秒**；容器 ticks 只许存在于实现内部（`ticksToUs/usToTicks` 就近取整换算）。`Track.timescale` 仅供诊断。
- **Sample 五必填**：`{trackId, codec, timestamp, duration, data, keyframe}`——data 为 Uint8Array（一个完整 Access Unit）；可选 `dts/size/index/dataState`；本仓扩展可选 `offset`。视频按**解码序**输出，`timestamp` 恒为 PTS。
- **Track**：id/type/`codec`(RFC6381)/**`description`**(avcC·hvcC·ASC，与 WebCodecs 配置项同名)/`bitstreamFormat('avc'|'annexb')`/durationUs/timescale(诊断)/language + 视频 width·height·rotation、音频 sampleRate·numberOfChannels。过渡别名 `codecPrivate/channelCount` getter 双向同步（§2.4，M2 清理）。
- **MediaInfo**：container/tracks(video>audio>text>metadata 排序)/**durationUs(null=未知)**/**seekable/live**/metadata；扩展字段 brands/qtTags。
- **ProbeResult**：probe 未命中一律返回 `null`；命中返回 `{confidence≥0.8?, container, codecsHint?}`。

## Demuxer 基类（§2.2 定稿）

```js
class MyDemuxer extends Demuxer {
  static probe(bytes) {}                    // 同步·无副作用·不抛异常→ProbeResult|null
  constructor(source, options) {}           // {initTimeoutMs=10000, lazySamples?...}
  async open() {}                           // emit('media-info')；超时 reject TIMEOUT
  async readSample(trackId) {}              // pull 主通道；EOS→null
  samples(trackId)                          // 迭代器糖层（同一游标持续）
  async seek(timestampUs) {}                // → {actualTimestampUs}；不支持 reject SEEK_UNSUPPORTED
  pause()/resume()/start()                  // 直播推送模式
  async destroy()                           // 幂等；之后一切调用 STATE_ERROR
  // 属性：mediaInfo / tracks / metadata / getBufferedRanges(trackId)
}
```

状态机：`idle→opening→ready⇄seeking→destroyed`（非法迁移 STATE_ERROR）。
事件全集：`'error'/'media-info'/'sample'/'progress'/'end'`（过渡期兼容旧名 `mediaInfo` 双发，M2 移除）。
子类钩子：`_doOpen()` / `_createTrackIterator(trackId)` / `_doSeek(us)`。

## DataSource / ChunkSource（§2.1）

- `DataSource = {size:number|null, read(offset,length):Promise<Uint8Array>, close?}`。
  内置：`MemoryDataSource`、`BlobDataSource`、**`HttpRangeDataSource`**（256KB 分块 LRU 缓存；fetchImpl 可注入离线测试）、**`ChunkBuffer`**（把流式 ChunkSource 聚合为随机读，直播容器用）。
- 解密层 DecryptingSource 位于 Source 与 demuxer 之间，本期仅 hls 使用。

## 位流原语

`ByteStream/ByteWriter`（大端读写、16.16/2.30 定点矩阵）、`BitReader`、`ExpGolombReader`、`parseH264Sps`（含 H.264 E.2.2 裁剪单位换算）；NAL：`annexbToAvcc/avccToAnnexb/splitAvcc/splitAnnexB` 与 emulation prevention 摘除/回加。

## codec string（§3 唯一生成收敛点）

`h264CodecStringFromSps(sps)` / `hevcCodecStringFromHvcC(hvcC)` / `aacCodecStringFromAsc(asc)` / `fallbackCodecString(family)`（降级打 warn，**不编造 profile**）；另有 `buildAvcCodecString/buildHevcCodecString/aacCodecString/parseCodecString/buildMseMimeType`。各 demuxer 禁止自行拼串。

## 能力探测与路线裁决（§4）

`hasWebCodecs/hasMSE/hasAudioWorklet/hasWebGPU/hasCryptoSubtle`（Node 全 false 不抛错）；
`detectCapabilities({deep})` → `{webcodecs:{supported,video,audio}, mse:{supported,mimeTypes}, audioWorklet, webgpu, cryptoSubtle, secureContext}`（进程内缓存）；
**`chooseRoute(caps, mediaInfo)`** → `'webcodecs'|'mse'|'none'`。

## 输出端

- **MseHelper(mediaElement,{managed})**：open/addTrack/append（串行化 appendBuffer 队列）/bufferedAhead/resetTrack/endOfStream/destroy。
- **VideoFrameRenderer(canvas,{mode})**：WebGL→2D 自动降级；**所有权铁律（§6）**——`draw(frame)` 接管 VideoFrame 所有权，绘制完 finally `close()`，调用方不得复用该帧。
- **AudioWorkletPlayer**：processor 注册名 `'player-audio-sink'`；PCM 规范形态 f32-planar；`currentTimeSec()` 音频主钟。

## 时钟与统计

`PlaybackClock`（锚定单调钟，时钟源可注入便于单测）、`AvSyncController`（audio master 决策 render|drop|wait|resync；±20ms 窗口参数可调）、`Stats`（帧/字节/丢帧/underrun/解码耗时 + fps EMA，snapshot 输出纯 JSON）。
渲染循环对决策的执行语义（§5）：**迟到帧一律丢帧**——即使偏差 ≥`hardResyncSec`（0.5s）被 AvSync 判为 resync，只要 drift<0（视频太旧）仍按丢帧处理，不迁就旧帧；**大幅超前帧**（drift>0 且 ≥0.5s）才重锚主钟到该帧（复用 `_masterRealignToUs`：音频输出可清缓冲则归零计数 + 偏移锚定），避免长期 wait 造成 A/V 无限落后。

## 播放编排与管线（§5 / §6）

- **`Player` / `createPlayer()`**（`src/player.js`）：七态状态机 `idle → ready → playing / paused / seeking / error → destroyed`；`load()` 支持 DataSource / URL / Blob / 注入工厂，内部串接探测 → `open()` → `detectCapabilities` → `chooseRoute` → 建管线；样本泵按活动轨 pull 并交给管线。
- **`WebCodecsPipeline`**（`src/pipeline-webcodecs.js`）：`webcodecsPipelineFactory()` 产出 Player 可用的管线工厂。视频 `VideoDecoder` → AvSync 决策 render/drop/wait → `VideoFrameRenderer`；音频 `AudioDecoder` → f32-planar → `AudioWorkletPlayer`；字幕直出 `cue`。
- 解码器/渲染器/音频输出/调度器全部可注入，因此 Node 下用假实现跑单测、浏览器里用真实 WebCodecs 跑生产。
- 主时钟：有音轨取 `AudioOutput.currentTimeUs` 并叠加 seek 偏移，无音轨退化 `PlaybackClock`。
- **`MsePipeline`**（`src/pipeline-mse.js`）：`msePipelineFactory()` 产出兼容路线（§6「能用 WC 就不落 MSE」）的管线工厂。样本 → fMP4 重封装（默认 `mp4/Fmp4Remuxer`，延迟引入）→ `MseHelper` 串行 appendBuffer → `<video>/<audio>` 内建解码渲染。
  - 分片策略：GOP 边界 + 目标时长（`segmentDurationUs`，默认 2s）双条件成段，段首必为关键帧；
  - 背压：`bufferedAhead` 超 `maxBufferAheadSec`（默认 30s）时让出事件循环，不无条件 append；
  - 主时钟取元素 `currentTime`；`end()` 收尾 flush 后 `endOfStream()`（不调用则元素永不 `ended`）；
  - **建轨必须两阶段**（真实浏览器约束）：先为所有活动轨建齐 SourceBuffer，再统一写 init segment。Chrome 一旦某个 SourceBuffer 写过数据，再 `addSourceBuffer` 会抛 `QuotaExceededError: reached the limit of SourceBuffer objects`（有头/无头均复现），逐轨「建 SB → 写 init」交错会导致第二轨直接失败；
  - `MseHelper.addTrack` 判定 mime 走 **MediaSource/ManagedMediaSource 构造器静态** `isTypeSupported`（实例上没有该方法；注入实现自带实例方法时优先用实例方法）；
  - `mediaElement` / `mse` / `remuxer` / `schedule` 均可注入，Node 下用假实现单测。
- **轨道选择**：`Player.selectTrack(type, trackId)` 维护 `selectedTracks{video,audio,text}`，样本泵只拉选中轨，切轨时中断并重启泵；WebCodecs 管线 close 旧解码器并按新 codec 重建（同格式音轨复用音频输出并 `clearBuffer`），MSE 管线为新轨建 SourceBuffer 并补写 init segment。两条管线都丢弃非选中轨样本，并广播 `trackchange`。
- **直播落后丢帧追赶**（§5「直播落后于 liveLatencyUs 目标时优先丢帧追赶」）：`mediaInfo.live` 且配置 `liveLatencyUs` 时，管线以「已灌入最新视频样本时间戳」为 live 边缘；主钟落后目标（= liveEdge − liveLatencyUs）超过 `catchUpThresholdUs`（默认 liveLatency 一半、下限 500ms）时把主钟重锚到目标（音频输出清缓冲 + 偏移锚定），随后旧帧逐个被 drop 丢弃，广播 `'catchup'`（Player 已转发）。seek/视频切轨会重置 live 边缘累计。MSE 路线的实时时间轴由 `<video>` 元素自管，不在本管线范围。
- **起播缓冲与背压**（§5 `bufferTargetUs`）：`play()` 进入 `playing` 后先做「起播前向缓冲」——按媒体时长跨度（或管线自报水位）灌到 `bufferTargetUs`（默认 3s，直播用 `liveLatencyUs`）再交给常规泵；满足水位 / 活动轨 EOS / 达到 `prebufferMaxSamples` 任一即起播，避免无时间戳推进的异常流死循环。常规泵每次推帧后检查管线 `bufferedAheadUs`：超过 `bufferTargetUs × backpressureFactor`（默认 2）时暂停拉流，水位回落后续跑，避免无界吃内存。预缓冲与背压均通过 `'buffering'`（`{active,bufferedAheadUs,targetUs,reason}`）事件暴露，供 UI 显示缓冲圈。
  - `buffered`（`Array<{startUs,endUs}>`）取数优先级：demuxer `getBufferedRanges()` → 管线 `getBufferedRanges()`（MSE 取 SourceBuffer 真实区间）→ 仅水位时合成 `{startUs: currentTimeUs, endUs: currentTimeUs + ahead}` → 空数组。
  - `stats.bitrateBps`：按 `bitrateWindowSec`（默认 1s）滑动窗口统计已 demux 字节数，样本过稀时以 0.5s 为分母下限避免瞬时尖刺（不再是恒 0）。
  - `progress` 事件链路：demuxer 的读取进度（网络/文件侧）经 `load()` 透传到 Player `'progress'`。
  - 两条管线均新增 `bufferedAheadUs` / `getBufferedRanges()`：WebCodecs 取音频输出水位优先、否则待渲染队列领先主钟时长；MSE 取活动音视频轨 SourceBuffer 中最小水位（木桶效应）。

## 安全与输入防护（评审 I5）

评审第二轮 I5 在核心层新增两道输入面守卫，所有出网 / 读盘入口统一收敛：

- **`url-guard.js`**：协议白名单。`FETCH_PROTOCOLS=['http:','https:']` / `WS_PROTOCOLS=['ws:','wss:']` / `IMPORT_PROTOCOLS=['http:','https:']`；`assertSafeUrl` / `assertSafeWsUrl` / `assertSafeImportUrl` 在非法协议（file: / blob: / data: / javascript: 等）时抛 `NETWORK_ERROR` / `SOURCE_ERROR`（封闭错误码，非裸 TypeError）。`HttpRangeDataSource`、hls 的 playlist/segment/密钥加载、webrtc/rtmp/rtsp 信令、webtorrent CDN import 均已接入。
- **`limits.js`**：畸形长度字段防护。`DEFAULT_MAX_READ_BYTES=64MB` / `MAX_MOOV_BYTES=64MB` / `MAX_SAMPLE_BYTES=32MB` / `MAX_SMALL_RESOURCE_BYTES=1MB` / `MAX_SCAN_BYTES=256MB`；`assertByteLength` 越界抛 `PARSE_ERROR`（拒绝而非截断，避免半截数据被当正常内容）；`BoundedMapCache` 为有界 FIFO 缓存（密钥 / 元数据类小缓存在长直播下不无限增长）。`HttpRangeDataSource`、hls segment、`mp4/mov/flac` demuxer 的 `readCapped` 均已接入。

详见 `core/src/url-guard.js` / `core/src/limits.js` 注释与 `core/__tests__/security-i5.test.js`。

## 错误体系（§11.3）

`PlayerError{code,detail}` 封闭枚举 **10 码**：PROBE_FAILED / PARSE_ERROR / NOT_SUPPORTED / SOURCE_ERROR / NETWORK_ERROR / DECODE_ERROR / SEEK_UNSUPPORTED / TIMEOUT / ABORTED / STATE_ERROR。同步 throw 与异步 reject 同型并同时 emit `'error'`。

## 测试与 fixture

```bash
npm run fixtures && node --test "core/__tests__/*.test.js"   # 全量例全绿（基线见 docs/review/checklist.md）
```
fixture 约定见 `docs/fixtures-约定.md`：`__tests__/fixtures/gen.mjs` 导出 `async generate(fixDir)`，产物 gitignore、幂等重建。

## 真实浏览器端到端验收（M3）

系统 Chrome + 真实 WebCodecs 的端到端冒烟（playwright-core 驱动，素材在 `samples/e2e/`）：

```bash
# 前置：一次
cd ~/.workbuddy/binaries/node/workspace && npm i playwright-core   # 或仓库 docs 指引的等价安装

node scripts/e2e/run.mjs                                       # TS 素材（annexb 主链，seek 按契约不可寻址）
node scripts/e2e/run.mjs --media=/samples/e2e/sintel-trailer.mp4 --seekUs=20000000   # MP4 素材（含 seek）
```

- harness：`scripts/e2e/player-harness.html`（注册容器 → URL 探测 → load → play → 首帧 → 播放推进 → pause/seek/恢复 → stats → destroy，15 步自断言）。
- 浏览器 end-to-end 验收曾暴露并修复的真实缺陷（Node 假实现测不出）：
  1. `hasAudioWorklet` 直读 `AudioContext.prototype.audioWorklet`（accessor）→ Chrome `Illegal invocation`；改用 `in`。
  2. 能力探测默认 codec 清单不含媒体实际 codec（如 `avc1.64001F`）→ WebCodecs 路线误判不可用；Player 深探测并入媒体 codec。
  3. 音频能力探测缺 `sampleRate/numberOfChannels` → Chrome 直接判不支持；探测补 48k/stereo。
  4. TS/annexb 轨样本直接喂 VideoDecoder（期望 avcC）→ 解码错误自动 closed；decode 前 `annexbToAvcc`。
  5. `pipeline.seek()` `decoder.reset()` 后未重新 configure → `decode on an unconfigured codec`；保存配置并在 reset 后重配。
  6. 宿主注册协议从未被生产代码调用（registry 恒空）——harness 首先补齐 `registerDemuxer` 聚合，M3 验证 Player→真实容器接线打通。
- 防回归：`core/__tests__/webcodecs-e2e-regress.test.js`（3 例锁上述 1/4/5）。

## 已知限制与路线

- ChunkBuffer 目前线性定位块（后续换前缀和+二分）；AudioWorklet push 为拷贝语义（SAB 在路线图）；
- 渲染端三件需要浏览器环境；WebGPU 渲染器 Phase 后置（copyExternalImageToTexture）;
- 过渡别名表（attach/init/mediaInfo/codecPrivate…）按 §2.4 于 M2 接入波次统一清理。
- **`Demuxer.destroy()` 不再因阻塞生成器挂起**：当某轨迭代器正 `await` 一个永不 resolve 的外部 promise（如网络读卡死）时，`destroy()` 不再 `await gen.return()`（V8 异步生成器 `return()` 需等该 promise 落地），而是标记各迭代器 `done` 并清空映射后立即返回；in-flight `readSample` 最终落地后的样本由上层（Player）按 `state==destroyed` 丢弃，外部 `readSample` 由 `_requireUsable` 直接拒绝。仍在飞的异步迭代器随进程自然 GC。后续波次再为 `readSample` 引入可中断信号（AbortSignal/超时）以进一步减少悬挂请求。
