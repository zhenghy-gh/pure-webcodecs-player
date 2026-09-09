# 统一接口契约（CONTRACTS）

> 版本：**v0.2**　|　发布日期：2025-08-25　|　署名：architect（架构师）
> 性质：全队并行开发的**唯一权威锚点**。先于实现生效；后续允许 minor 版本演进，破坏性变更必须上板公告。
> 变更治理：修改须经 captain 批准 → 更新本文档 + 共享看板记录版本号/日期/变更点 → 全员周知。
> 事实依据：`docs/00-需求与可行性结论.md`、`docs/PRD.md`、看板《工程约定-v1》《裁决-契约优先》《裁决-hls-flv重定位》。

## 变更记录

| 版本 | 日期 | 说明 |
|---|---|---|
| v0.1 | 2025-08-25 | 首个团队锚点版。整合此前内容并确立 0.x 基线方案；按 T1 任务书新增 §5 Player Core、§7 音频路径取舍、§8 字幕 Cue 流、§9 网关 WS 协议、§10 模块注册约定；完成四项裁决见 §12.1 |
| v0.2 | 2025-08-25 | ①**编号归位：临时版 v1.0.0 编号废止并入 0.x 线**（含曾短暂使用的 v1.0.1），本版起沿 0.x 演进（minor 演进+破坏性变更上板公告），消除全仓引用混乱；②响应 qa TESTPLAN §11 Q1，依 leader 裁决：**hls 支持 EXT-X-KEY METHOD=AES-128 整段解密**（WebCrypto subtle AES-CBC，IV 取自标签属性或媒体序号），解密层位于 Source 与 demux 之间（§2.6），capabilities 增加 crypto.subtle 探测与降级路径（§4）；**范围仅限 hls 模块，其余容器本期一律不做解密/DRM**；③**接口冻结条款生效（§0.7/§12.3）**：至 M2 评审完成，Demuxer/Player 公开方法名与数据形状冻结，别名表只许扩充不许改语义，破坏性更名须 captain+leader 双签 |

---

## 0. 全局硬约束

1. **零第三方运行时依赖**：`src/` 只允许相对路径导入仓库内模块；禁止 npm 包、bare specifier、CDN 运行时代码加载。webtorrent/libass/hls.js/flv.js 等只能作为 README 声明过的可选增强，缺失时明确降级不得崩溃。平台内建 API（WebCrypto `crypto.subtle` 等）**不属于**第三方依赖，可正常使用。
2. **纯 ESM JavaScript**：`.js` + 标准 ESM；禁 TS 语法/JSX/decorator/require。类型信息用中文 JSDoc；公开 API 必须注释完整。
3. **双环境**：浏览器（零构建 `<script type="module">` 直开）与 **Node >= 22**（engines 已锁定）。访问浏览器专属全局前必须存在性判断；Node 下返回"不支持"，不允许抛异常。
4. **只用具名导出**：禁 default export；`src/index.js` 显式 re-export 公共 API。
5. **时间单位统一整数微秒（µs）**：契约边界上一切 timestamp/duration 均为整数微秒（安全整数域）。容器原生 timescale/ticks 只允许作为**模块内部表示**，公共导出前必须完成换算（就近取整）；`Track.timescale` 保留字段仅供诊断。（依据 T1 任务书与【裁决-契约优先】；core 现存 ticks 内部实现按此在输出边界换算，与 vue-dev-2 同一处理原则。）
6. **fixture 规范**（对齐《工程约定-v1》）：每模块 `__tests__/fixtures/gen.mjs` 导出 `async generate(fixDir)`，产物 gitignore，根命令 `npm run fixtures` 一键重建；离线可复现，单文件 ≤256KB。
7. **接口冻结（v0.2 起，效力至 M2 评审完成）**：Demuxer 与 Player 的公开方法名、事件名、数据形状冻结；§2.4 别名表只许扩充、不许改语义；任何破坏性更名或形状变更须 **captain+leader 双签**并上板公告，否则只能以新增可选成员方式演进。细则见 §12.3。

---

## 1. 数据类型（权威定义在 core/src/types.js，各模块不得私设同名异构类型）

### 1.1 Sample —— 解码最小单元

```js
/**
 * @typedef {Object} Sample
 * @property {number}     trackId    // 所属 Track.id
 * @property {string}     codec      // 规范 codec 串（§3），恒等于所属轨的 codec
 * @property {number}     timestamp  // PTS，整数微秒
 * @property {number}     duration   // 整数微秒；未知填 0
 * @property {Uint8Array} data       // 一个 Access Unit 的裸码流字节（约定见下）
 * @property {boolean}    keyframe   // 关键帧标志（音频/文本轨恒 true）
 * // 可选：
 * @property {number}  [dts]         // 解码序时间戳（µs）；视频 B 帧 DTS≠PTS 时必填
 * @property {number}  [size]        // 字节长度
 * @property {number}  [index]       // 轨内序号（0 起）
 * @property {'lazy'|'loaded'} [dataState] // 仅 options.lazySamples 时出现
 */
```

- **data 形态约定**：规范形态为 `Uint8Array`（视图，不要求独占 buffer）。API 边界也接受 `ArrayBuffer`（实现应立即 `new Uint8Array(ab)` 包装后处理）；对外产出一律 Uint8Array。字节内容为**一个完整帧**，跨帧分片由 demuxer 自行拼装。
- 视频按**解码序（DTS 序）**输出；`timestamp` 恒为 PTS。
- 音频一帧 = 一个编码帧（AAC raw block / MP3 frame / Opus packet / FLAC frame / PCM 一块）；文本轨一帧 = 一条字幕原始 UTF-8 字节。
- **lazy 优化（可选）**：demuxer 可声明 `lazySamples:true`，此时 `data` 缺省、`dataState:'lazy'`，消费方调 `readSampleData(sample)` 补取字节。未声明时 data 必须就绪。

### 1.2 Track —— 单条轨

```js
/**
 * @typedef {Object} Track
 * @property {number} id                     // MediaInfo 内唯一，从 1 开始
 * @property {'video'|'audio'|'text'|'metadata'} type  // 字幕轨用 'text'
 * @property {string} codec                  // 规范 codec 串（§3）；未知 ''
 * @property {Uint8Array|null} [description] // 解码器私有初始化数据（定稿名，与 WebCodecs 配置项同名）
 * @property {string} [bitstreamFormat]      // 视频专用：'avc'(AVCC/HVCC 长度前缀，description 必为 avcC/hvcC)
 *                                           //           | 'annexb'(Annex B 起始码，description 应为 null)
 * @property {number} [durationUs]
 * @property {number} [timescale]            // 原生时间基（ticks/秒），仅诊断用，样本已换算 µs
 * @property {string} [language]             // ISO-639-2/T，未知 'und'
 * // video：width/height/[frameRate]/[rotation:0|90|180|270]/[sampleEntryType 如 'avc1']
 * // audio：sampleRate/numberOfChannels/[channelLayout 按 W3C 通道顺序]
 */
```

- **裁决：字段名定稿为 `description`**（与 `VideoDecoderConfig.description` 同名，消除映射成本）。core 现存 `codecPrivate` 为过渡别名，接入波次由 media-dev 统一改名或加 getter。
- 解码适配规则：`bitstreamFormat==='avc'` → 把 `description` 传给 Decoder config；`'annexb'` → 省略 description。demuxer **按容器原样输出码流，不做改写**。
- description 常见取值：avcC / hvcC / dvcC(AV1) / vpcC(VP9) / AudioSpecificConfig(AAC) / OpusHead / FLAC STREAMINFO。

### 1.3 MediaInfo —— 容器级元信息

```js
/**
 * @typedef {Object} MediaInfo
 * @property {'mp4'|'mov'|'mkv'|'webm'|'ts'|'flv'|'hls'|'wav'|'flac'|'ape'} container
 * @property {Track[]} tracks        // 至少一条，排序 video > audio > text > metadata
 * @property {number|null} durationUs // 直播/未知 null
 * @property {boolean} seekable      // 直播恒 false
 * @property {boolean} live          // 直播恒 true 且 durationUs=null
 * @property {number} [bitrate]
 * @property {{title?:string,[k:string]:string}} [metadata] // 仅字符串叶子字段
 */
```

### 1.4 ProbeResult 与 DecodedFrame

```js
/**
 * @typedef {Object} ProbeResult
 * @property {number} confidence     // 0~1；≥0.8 视为命中
 * @property {string} container
 * @property {string[]} [codecsHint]
 *
 * @typedef {VideoFrame|AudioData} DecodedFrame  // 解码产物直接使用平台原生类型，不自定义包装
 */
```

---

## 2. Demuxer 统一接口

### 2.1 输入源抽象（core/src/data-source.js 收口）

```js
/**
 * @typedef {Object} DataSource   // 随机读源：File/Blob/HTTP Range/Memory/webtorrent 内容
 * @property {number|null} size   // null=未知
 * @property {(offset:number,length:number)=>Promise<Uint8Array>} read
 * @property {()=>Promise<void>} [close]
 *
 * @typedef {Object} ChunkSource  // 流式源：WebSocket 网关/fetch body/RTSP 中继
 * @property {(chunk:Uint8Array)=>void} write
 * @property {(err?:Error)=>void} end
 */
```

点播型容器（mp4/mov/mkv/cmaf/wav/flac/ape）构造只接 `DataSource`；直播型（ts/flv/hls 及网关桥接）两者皆可。core 提供 Memory/File/HttpRange 实现与 ChunkBuffer（把 ChunkSource 聚合为可随机读）。

**解密层位置（v0.2）**：内容解密发生在 **Source 与 demuxer 之间**——`DecryptingSource` 包装 DataSource/ChunkSource，在 read/write 边界对整段分片解密后原样透传，demuxer 无感知、不改接口。本期仅 hls 模块内置该层（约定见 §2.6），其余容器不得引入解密逻辑。

### 2.2 Demuxer 类契约（定稿方法名）

每个容器模块导出唯一主类 `<Format>Demuxer`，继承 core 的 `Demuxer` 基类（事件/状态机/迭代器骨架由基类提供）：

```js
export class Mp4Demuxer extends Demuxer {
  /** 静态嗅探：bytes 至少 64B（调用方建议给满 4KiB）。同步、无副作用、不抛异常；
   *  不命中返回 null，命中返回 ProbeResult。 */
  static probe(bytes /* Uint8Array */) {}

  constructor(source /* DataSource|ChunkSource */, options /* {initTimeoutMs?=10000,liveLatencyUs?,lazySamples?} */) {}

  /** 打开并解析初始化段（moov/EBML Tracks/FLV header/PAT-PMT/RIFF fmt…）。
   *  resolve 后 this.mediaInfo/.tracks/.metadata 可用，并 emit('media-info')。
   *  流式容器数据不足时等待，受 initTimeoutMs 约束，超时 reject PlayerError('TIMEOUT')。 */
  async open() {}

  /** 拉取指定轨下一个样本（pull 主通道，天然背压）。EOS resolve null。
   *  未 open 先调 → throw PlayerError('STATE_ERROR')。 */
  async readSample(trackId /* number */) {} /* Promise<Sample|null> */

  /** 异步迭代器糖层（等价于循环 readSample）：for await (const s of d.samples(1)) */
  samples(trackId) /* AsyncIterable<Sample> */ {}

  /** seek（仅 seekable）：清空各轨缓冲，迭代起点对齐 ≤timestampUs 最近视频关键帧+对齐音频包，
   *  resolve 实际落点 {actualTimestampUs}。直播/无索引容器 reject PlayerError('SEEK_UNSUPPORTED')。 */
  async seek(timestampUs /* 整数微秒 */) {}

  pause() {}   // 直播推送模式暂停吐包（缓冲继续累积至 options 上限）
  resume() {}  // 恢复推送
  start() {}   // 【可选】直播推送模式入口，配合 'sample' 事件
  /** 销毁：释放数据源与全部缓冲，幂等；之后一切调用抛 STATE_ERROR */
  async destroy() {}

  // —— open() 后可用的属性 ——
  get mediaInfo() {}                 // 完整 MediaInfo
  get tracks() {}                    // 快捷：mediaInfo.tracks
  get metadata() {}                  // 快捷：{container,durationUs,live,seekable,title…}
  getBufferedRanges(trackId) {}      // Array<{startUs,endUs}>
}
```

生命周期状态机（基类强制）：`idle → opening → ready ⇄ seeking → destroyed`，直播态叠加 `paused` 标志；非法迁移抛 `PlayerError('STATE_ERROR')`。

### 2.3 事件模型（core/src/emitter.js 迷你 Emitter）

| 事件 | 载荷 | 语义 |
|---|---|---|
| `'error'` | `PlayerError` | 致命错误；进入 error 态 |
| `'media-info'` | `MediaInfo` | open() 成功 |
| `'sample'` | `{trackId, sample}` | 仅 start() 后推送（直播模式） |
| `'progress'` | `{loadedBytes,totalBytes\|null}` | 读流进度 |
| `'end'` | `{reason:'eos'\|'aborted'}` | 全部轨 EOS 或主动销毁 |

`'error'` 与 Promise rejection 双通道并存，消费方两侧都要接；其余监听器抛错只记日志不影响管线。

### 2.4 方法名兼容别名表（迁移期生效，接入波次后删除）

| 定稿名 | 此前草案/core 现状别名 | 说明 |
|---|---|---|
| `open()` | `parseInit()` / `init()`+`attach(src)` | 语义合并：createDemuxer 工厂内部完成 attach |
| `readSample(id)` | 手工循环 `samples(id)` | samples() 保留为糖层 |
| `destroy()` | `stop()` | 幂等语义不变 |
| `seek(µs)` | core 现 `seek(timeSec)` | 公开口径只有微秒版，core 内部改造或加内部换算 |
| `PlayerError` | v1.0.0 草案名 `MediaError` | 定稿 PlayerError，错误码并集见 §11.3 |
| `description` | core 现 `codecPrivate` | 过渡别名 |
| `'text'` | 草案 `'subtitle'` | 字幕轨类型定稿 'text' |

### 2.5 各容器对齐清单

| 模块 | 类型 | probe 特征 | 要点 |
|---|---|---|---|
| mov / mp4 | DataSource | `ftyp`/`moov` | moov 前置后置都支持；trun/sbgp 优先，退化 stss |
| cmaf | DataSource | ftyp+`styp`/sidx | 分片级 sidx；LL 场景未收尾即吐 sample |
| mkv / webm | DataSource | EBML `0x1A45DFA3` | Cues 缺失线性扫索引；Lacing 展开 |
| ts | 双模 | 0x47+PID 连续性 | PAT/PMT 动态更新；PCR 时钟基准 |
| flv | 双模 | `"FLV"` | ms→µs；AVCC 原样输出（含 CodecID=12 HEVC 与 Enhanced-FLV FourCC） |
| hls | 双模 | m3u8 文本 | 定位为**数据源适配层**（见【裁决-hls-flv重定位】）：清单解析+分片编排喂统一内核，重点验证 WebCodecs 直解；支持 EXT-X-KEY METHOD=AES-128 整段解密（§2.6）；SAMPLE-AES/DRM 报 NOT_SUPPORTED |
| wav | DataSource | `RIFF…WAVE` | 直接产 pcm-* Sample |
| flac | DataSource | `fLaC` | STREAMINFO 作 description |
| ape | DataSource | MAC 头 | 本期仅头/TAG 解析+元数据，解码 Phase 后置（PRD 软验收） |
| subtitle | — | 内容嗅探 SRT/VTT/ASS | 产 x-srt/x-vtt/x-ass 样本；Cue 流接口见 §8 |

> webtorrent/webrtc/rtmp/rtsp 是**传输接入层**：交付物是 DataSource/ChunkSource 实现（如 webtorrent→DataSource、网关 WS→ChunkSource），不实现本节接口，协议见 §9。

### 2.6 HLS AES-128 解密约定（v0.2 新增）

- **范围**：仅 hls 模块。支持 `EXT-X-KEY` 且 `METHOD=AES-128` 的整段加密分片；`METHOD=NONE` 正常直通；`SAMPLE-AES` 及一切 DRM 方案 → `PlayerError('NOT_SUPPORTED')`（不得静默跳过）。
- **密钥管线**：KEY 标签解析为 `{method, uri, iv?}`；密钥固定 16 字节，经可注入加载器获取——`options.keyLoader(keyUri): Promise<Uint8Array>`（缺省实现用全局 fetch；单测注入 mock，满足离线零网络可测）。
- **解密算法**：**整段分片先解密再交子 demuxer**（TS 与 fMP4 分片一致）。走 WebCrypto：`subtle.importKey('raw', keyBytes, 'AES-CBC')` → `subtle.decrypt({name:'AES-CBC', iv}, key, segmentBytes)`，PKCS7 填充由 subtle 自动剥离。
- **IV 规则（RFC 8216）**：EXT-X-KEY 带 IV 属性 → 按 16 字节十六进制取值；未带 → 该分片的媒体序号 mediaSequence 的 128 位大端表示（序号为 64 位无符号整数，高 64 位补零）。
- **同构要求**：解密实现必须接受注入的 crypto 提供方（默认浏览器 `crypto.subtle`；node --test 注入 `node:crypto` 的 webcrypto），同一套代码双环境测试——对齐 TESTPLAN「node crypto 同构」条目。
- **错误映射（封闭）**：`crypto.subtle` 不可用或密钥长度 ≠16 字节 → `NOT_SUPPORTED`；密钥获取失败 → `NETWORK_ERROR`；解密后首块校验失败（TS 应为 0x47 / fMP4 应为合法 box 头）→ `PARSE_ERROR`。

---

## 3. codec 字符串规范

**总则**：能映射 WebCodecs 注册表的，一律生成可直接通过 `isConfigSupported({codec})` 校验的标准串；无法表达的加 `x-` 前缀。生成逻辑收敛 `core/src/codec-string.js`，**各 demuxer 禁止自行拼串**。

| 家族 | 模板 | 参数来源 | 示例 |
|---|---|---|---|
| H.264 | `avc1.PPCCLL`（profile/constraint/level 各 2 位十六进制） | SPS 前 3 字节或 avcC 前 3 字节 | `avc1.64001f`(High@3.1)、`avc1.42E01E`(Baseline@3.0) |
| HEVC | `hvc1.P.CP.LL.CB[.T]`（sample entry 为 hvc1 时用 hvc1，hev1 类推） | hvcC 或 VPS/SPS | `hvc1.1.6.L93.B0` |
| VP9 | `vp09.<profile>.<level>.<bitDepth>` | 帧头 | `vp09.00.10.08` |
| AV1 | `av01.<P>.<L>.<DD>` | sequence header | `av01.0.04M.08`（后期） |
| AAC | `mp4a.40.<AOT>` | AudioSpecificConfig 高 5 位 | `mp4a.40.2`(LC)、`mp4a.40.5`(HE-AAC) |
| MP3 | `mp3`（MSE 场景可用 `mp4a.69/.6B`） | 固定 | `mp3` |
| Opus | `opus` | 固定 | `opus` |
| FLAC | `flac` | 固定 | `flac` |
| PCM | `pcm-u8/pcm-s16/pcm-s16be/pcm-s24/pcm-s32/pcm-f32/alaw/ulaw` | RIFF fmt/PMT | `pcm-s16` |
| 字幕 | `x-srt / x-vtt / x-ass` | 内容嗅探 | `x-ass` |

辅助 API（core 导出）：`h264CodecStringFromSps(sps)`、`hevcCodecStringFromHvcC(hvcC)`、`aacCodecStringFromAsc(asc)`、`fallbackCodecString(family)`（拿不到参数集时降级为基础串并打 warn，**禁止编造 profile**）。

---

## 4. 能力探测 API（core/src/capabilities.js）

```js
export function hasWebCodecs() {}      // 同步快判，Node 恒 false
export function hasMSE() {}
export function hasAudioWorklet() {}
export function hasWebGPU() {}         // 仅查 navigator.gpu 存在性
export function hasCryptoSubtle() {}   // 查 globalThis.crypto?.subtle 存在性（Node≥22 与现代浏览器均具备）

/** 深探测（真实走 isConfigSupported/isTypeSupported/requestAdapter），结果进程内缓存 */
export async function detectCapabilities(options /* {deep?:true} */) {}
/* => { webcodecs:{supported, video:Record<codec,bool>, audio:Record<codec,bool>},
        mse:{supported, mimeTypes:string[]}, audioWorklet:boolean, webgpu:boolean,
        cryptoSubtle:boolean, secureContext:boolean } */

/** 路线裁决：'webcodecs' | 'mse' | 'none'（规则见 §6 矩阵） */
export function chooseRoute(caps, mediaInfo) {}
```

探测失败一律吞掉计 false，绝不向上抛；单测覆盖 Node 全 false 路径。**AES-128 降级路径（v0.2）**：`cryptoSubtle=false` 时，hls 对含 AES-128 KEY 的清单报 `NOT_SUPPORTED`（明文清单不受影响），见 §2.6。

---

## 5. Player Core API 与状态机（core/src/player.js，M3 交付）

```js
export async function createPlayer(options /* {
  canvas?: HTMLCanvasElement,         // 缺省则内部创建
  routePreference?: ['webcodecs','mse'],
  bufferTargetUs?: number = 3000000,  // 起播前向缓冲目标
  liveLatencyUs?: number,
} */) {}                              // => Promise<Player>

export class Player extends Emitter {
  async load(input) {}   // url | File | Blob | DataSource | ChunkSource | {type:'gateway',name,url}
                         // 内部：探测→选 demuxer→open→chooseRoute→建管线→resolve(this)
  play(): Promise<void>  // ready/paused → playing；起播条件不足则等待并保持 pending
  pause(): void          // playing → paused
  async seek(timestampUs) // → seeking 态，落帧后回到原态；reject SEEK_UNSUPPORTED
  async destroy()        // 幂等，释放解码器/渲染器/音频输出/demuxer

  get state() {}          // 见下方状态机
  get ended() {}          // 播放自然到尾标志（不新增状态，避免状态爆炸）
  get currentTimeUs() {}
  get durationUs() {}
  get buffered() {}       // Array<{startUs,endUs}>
  get volume() set volume(v) {}
  get muted() set muted(v) {}
  get playbackRate() set playbackRate(v) {}
  get videoTracks() get audioTracks() get textTracks()   // Track[]
  selectTrack(type, trackId) {}   // 切换活动轨（音视频切换触发重建解码链）
  get stats() {}                  // {droppedFrames, underrunCount, decodedFps, bitrateBps}
}
```

**状态机（定稿六态）**：

```
idle ──load──▶ ready ──play──▶ playing ◀──pause──▶ paused
                │                │  │                │
                └────play────────┘  └──seek──▶ seeking┘（完成后回到来源态）
任意态 ──致命错误──▶ error（唯一出口 destroy()）
播放自然到尾：playing → paused 且 ended=true，emit('ended')
```

非法迁移一律 `PlayerError('STATE_ERROR')`；事件：`statechange / error / timeupdate(节流250ms) / ended / firstframe / trackschange / cue / stall / underrun`。

**同步策略**：音频主时钟（AudioWorklet `currentTimeUs`）；无声轨用 `performance.now()` 软时钟。视频 PTS 对齐 ±20ms 窗口：早到等待、迟到丢帧且不越过下一关键帧。直播落后于 liveLatencyUs 目标时优先丢帧追赶。

---

## 6. 渲染后端适配层边界：WebCodecs 路径 vs MSE 路径

两路径共享内核基座/传输/解封装层，分歧仅在解码渲染段。**规范路由表**（对照需求文档第一节表格逐行定稿）：

| 需求表格行 | WebCodecs 路径 | MSE 路径 | 定稿路线与降级链 |
|---|---|---|---|
| mov.js / mp4.js | ✅ 首选（AVCC/HVCC 原样直解） | ✅ 近零 remux | 默认 WC；老 Safari/Firefox 降级 MSE |
| hls.js | ✅ 重点验证（差异化：hls.js 没有的直解路线） | ✅ 保底首发 | 定位=数据源适配层非播放器竞赛；生产提示用 hls.js |
| flv.js | ✅（Annex B/AVCC 双形态） | ✅ FlvRemuxer→fMP4 | 双路线并行；定位=FLV 解析地基+薄壳，rtmp 桥接必选依赖；生产提示用 flv.js |
| mkv.js | ✅ 唯一完整路线 | ⚠️ 仅 webm 子集 | WC 为主；MKV→fMP4 remux 不做 |
| ts.js | ✅（天然 Annex B） | ❌ 不做 | 仅 WC；TS→fMP4 无收益 |
| cmaf.js | ✅ 首选（LL 方向） | ✅ 分片近直喂 | WC 优先；与 mp4 复用 ISO-BMFF 解析件（待 vue-dev-3 意见并入 §12.2） |
| wav.js | ✅ pcm-* AudioDecoder | ➖ | WC 直解或 §7 快速通道；MSE 无意义 |
| flac.js | ✅ flac AudioDecoder | ➖ | 同上；不支持环境降级 JS 解码（可选增强） |
| ape.js | ⚠️ 无原生解码 | ➖ | 解析层硬验收；解码走 JS/WASM 可选增强（软验收） |
| subtitle.js | ➖ 与路径无关 | ➖ | 恒为自有 Cue 流（§8），DOM/Canvas 渲染 |
| webtorrent.js | ✅（经 mp4 子集） | ✅ | 交付物=torrent→DataSource；路线随容器 |
| webrtc.js | ➖ 不适用 | ➖ | 走 RTCPeerConnection 原生管线，本仓仅信令抽象+播放端 |
| rtmp.js | ✅ 经 FLV 解析 | ✅ | 浏览器无 TCP，**必须** WebSocket 网关桥接（§9）；本质 WS-FLV 播放 |
| rtsp.js | ✅ 经中继 | ⚠️ | 浏览器无 UDP，**必须** WS 中继(interleaved/RTP over TCP)或 WebRTC 网关 |

**chooseRoute 规则**：tracks 全部被 WC 支持 → `'webcodecs'`；否则可 remux fMP4 且 `MediaSource.isTypeSupported` 通过 → `'mse'`；否则 `'none'`（UI 提示缺失能力清单）。原则：能用 WC 就不落 MSE（统一延迟模型与行为），MSE 只是兼容兜底。

渲染端铁律（两路径共用）：VideoFrame 单一所有权——`render(frame)` 调用后所有权移交渲染器，绘制完立即 close（finally 保证）；渲染器被动无定时；Canvas2D 用 `drawImage`，WebGPU 用 `copyExternalImageToTexture`（Phase 后置）；`fit:'contain'|'cover'|'fill'` 默认 contain。

---

## 7. 音频路径取舍边界

| 路径 | 适用 | 禁用场景 |
|---|---|---|
| **AudioWorklet**（默认主路径） | 一切流式/直播/WebCodecs 路线/需要精确主时钟的场景。PCM 规范形态 `f32-planar`（每通道一个 Float32Array，transferable 零拷贝）；processor 注册名 `'player-audio-sink'`，内置 ≥200ms 环形缓冲，水位低发 underrun | 无 |
| **decodeAudioData 快速通道**（可选优化） | 仅限**完整的本地小文件音频**（wav/flac 点播 File，经验阈值 ≤32MB），产出 AudioBuffer 直接 `AudioBufferSourceNode`，换取零管线成本 | 直播、边下边播、超阈值文件、任何需要主时钟精度的场景；**不得作为任何模块硬依赖**（探测失败自动回落 Worklet 路线） |
| MSE 路线的音频 | 由 `<video>/<audio>` 元素内建处理，不经上述两者 | — |

WebCodecs `AudioData` 必须在进 Worklet 前转成 `f32-planar`；通道顺序遵循 W3C channel interpretation。`AudioOutput.currentTimeUs` 是全系统主时钟源。

---

## 8. 字幕轨接口（对接 subtitle 模块）

```js
/**
 * @typedef {Object} Cue  文本 cue 流统一形状
 * @property {number} trackId
 * @property {number} startUs   // 整数微秒
 * @property {number} endUs
 * @property {string} text      // 纯文本行（\n 分段）
 * @property {Uint8Array} [raw] // 原始条目字节（含 ASS 标签等富文本，供高级渲染）
 */

// subtitle 模块公共导出：
export function probe(bytes) {}                     // → {format:'srt'|'vtt'|'ass'}
export async function* parseCues(bytes, options) {} // AsyncIterable<Cue>，options={format?,encoding?='utf-8'}
export function createTextTrack(cuesIterable) {}    // → {id,type:'text',codec:'x-srt'|'x-vtt'|'x-ass',
                                                    //     cues():AsyncIterable<Cue>, cuesUntil(us):Cue[]}
```

- Player 侧：`textTracks` 暴露文本轨；`selectTrack('text',id)` 后按播放时钟 emit `'cue'`（入点）与出点事件；seek 后按 `cuesUntil` 重放活动窗口。
- 渲染归 site 层 DOM overlay（DESIGN.md 三区布局），契约只管数据流。ASS 特效渲染属可选增强（libass-wasm），缺失时降级纯文本。

---

## 9. 网关 WS 通道协议（权威实现=samples/gateway（net-dev 维护）；scripts/gateway.mjs 为冻结兼容入口，行为一致）

### 9.1 通道事实（当前实现，契约如实收编）

- `POST|PUT /publish/<name>`：HTTP 推流入口，body 字节按到达顺序即时转发（低延迟，边收边转）；CORS `*`；发布结束仅记日志，**不产生任何订阅端信号**。
- `ws://host:port/stream/<name>`：订阅端。**二进制帧 = 推流字节流的分块**（保序、原样、无私有封头）；**文本帧 = 控制信令**，网关原样广播给频道内所有人（**含发送者自身回声**——客户端必须容忍收到自己发出的消息）。
- `GET /status`（或 `/`）：JSON 频道列表与订阅数。无鉴权，仅限本机联调。

### 9.2 文本信令格式（定稿）

一帧一条信令：**UTF-8 单个 JSON 对象，禁止一帧多行/多对象**；`type` 为判别字段；收到未知 `type` 或非法 JSON 必须**静默忽略**（记 debug 日志）。

```js
// 发布方 → 频道（经发布侧控制连接或网关注入）：
{"type":"meta","name":"cam1","container":"flv","codecs":["avc1.64001f","mp4a.40.2"],"live":true,"durationUs":null}
{"type":"eos"}                                                 // 发布正常结束
{"type":"error","code":"PUBLISH_ABORTED","message":"上游中断"}    // 发布异常终止（code 大写蛇形自由串）
// 订阅方 → 频道（可选）：
{"type":"hello","ua":"pureplay-rtsp/0.1"}                       // 握手自报，服务端与其他端可忽略
```

- `meta.container` ∈ §1.3 枚举；`meta.codecs` 为 §3 codec 串数组；字段可增不可减，消费方按需读取。
- **客户端健壮性义务（硬性）**：meta 可能缺席（晚加入者错过、发布方未发）——必须退化为对首个二进制分块做 `static probe` 嗅探；eos 可能永远不来——用空闲超时（建议 30s 可配）判定断流。

### 9.3 网关增强项（依终裁#3 移交 net-dev 在权威实现 samples/gateway 排期；scripts/gateway.mjs 已冻结为兼容入口，不影响客户端契约）

1. publish 结束时向频道合成广播 `{"type":"eos"}`；
2. 频道记忆最近一条 meta，新订阅者 join 时补发；
3. 支持 `POST /publish/<name>?meta=<urlencoded json>` 首推注入。

### 9.4 消费端接线

rtmp/rtsp 模块交付物 = `GatewayChunkSource implements ChunkSource`（内含信令解析与 meta/eos 生命周期），再交 flv/ts demuxer——传输层不碰 Sample（§2.1）。

---

## 10. 模块注册约定（index.js 导出形状）

每个 demux 容器模块 `src/index.js` 必须导出以下形状（供 core 注册表与 site 汇总页统一驱动）：

```js
export const containerName = 'mp4';              // ∈ §1.3 枚举，与主类静态字段一致
export const extensions = ['mp4', 'm4v', 'mov']; // 小写扩展名，无点
export const mimeTypes = ['video/mp4'];          // 标准 MIME

/** 同步嗅探：命中 ProbeResult（confidence≥0.8），否则 null。禁止抛异常。 */
export function probe(bytes /* Uint8Array */) {}

/** 工厂：接受 url|File|Blob|DataSource|ChunkSource，内部完成构造+attach+open。
 *  resolve Promise<Demuxer>（已 ready）；识别失败 reject PlayerError('PROBE_FAILED')。 */
export function createDemuxer(source, options) {}

export { Mp4Demuxer };                           // 主类本身（继承 core Demuxer）
```

- 传输层模块（webtorrent/webrtc/rtmp/rtsp）同形替换：导出 `createSource(...)=>Promise<DataSource|ChunkSource>` 与能力说明，不导出 demuxer。
- core 注册表：`registerDemuxer(module)` / `probeBuffer(bytes)`（遍历已注册模块按 confidence 最高者胜）/ `createDemuxerAuto(source)`（识别失败聚合各模块 confidence 报 PROBE_FAILED）。
- URL 探测：同步 `probe` 只吃字节；URL 场景由 core `detectFromUrl(url)` 取头部 4KiB 后走注册表。

---

## 11. 目录、命名、错误与日志规范

### 11.1 目录结构

```
docs/ core/ mov/ mp4/ cmaf/ mkv/ ts/ flv/ hls/ wav/ flac/ ape/ subtitle/
webtorrent/ webrtc/ rtmp/ rtsp/ site/ samples/
<module>/README.md · src/index.js · demo/index.html · __tests__/*.test.js(+fixtures/gen.mjs)
```

### 11.2 命名

文件 kebab-case.js；类 PascalCase；函数 camelCase；常量 UPPER_SNAKE；私有成员 `#field` 优先；跨目录导入相对路径（如 `../../core/src/index.js`）；中文注释覆盖所有导出符号。

### 11.3 错误体系（定稿：core/src/errors.js 的 PlayerError，错误码封闭枚举取双方并集）

```js
export class PlayerError extends Error { code; detail; }
```

| code | 场景 |
|---|---|
| `PROBE_FAILED` | 所有注册 demuxer 均无法识别 |
| `PARSE_ERROR` | 结构损坏/校验失败 |
| `NOT_SUPPORTED` | codec/SAMPLE-AES/DRM 等特性不支持（hls AES-128 已支持，见 §2.6） |
| `SOURCE_ERROR` | 数据源越界、File/Range 读写失败 |
| `NETWORK_ERROR` | fetch/WS 网关连接失败或异常断开 |
| `DECODE_ERROR` | WebCodecs/MSE 解码报错 |
| `SEEK_UNSUPPORTED` | 直播/无索引容器 seek |
| `TIMEOUT` | open/网络等待超时 |
| `ABORTED` | 用户主动中断 |
| `STATE_ERROR` | 生命周期非法迁移（≈草案 INVALID_STATE，定稿此名） |

规则：同步 throw / 异步 reject 同类型并同时 emit `'error'`；禁止吞错、禁止 alert/console 直接面向用户；底层重试不得超过 options 上限。UI 错误展示格式遵循 DESIGN.md `E_<域>_<名>` 映射。

### 11.4 日志

四级 `debug<info<warn<error`，默认 warn；`createLogger('mp4')` 模块前缀；debug=逐 box/Tag/包，info=生命周期节点，warn=可恢复异常（丢包、时间戳钳制、codec 降级），error=终止故障；**禁止打印二进制本体**（最多前 16 字节 hex）；文案中文。

---

## 12. 契约治理与本次裁决记录

### 12.1 v0.1 四项裁决（architect，依据磁盘现状 + T1 任务书 + 既有看板裁决）

1. **时间基**：契约边界一律整数微秒（T1 任务书 +【裁决-契约优先】）。core 现存 ticks 内部表示与 `seek(timeSec)` 属实现细节，公共导出与公开方法必须在输出边界换算 µs；`Track.timescale` 保留仅诊断。与 vue-dev-2 处理原则一致。
2. **错误类定名**：`PlayerError`（尊重 media-dev 已落地实现），错误码取并集封闭为 §11.3 十码；草案名 MediaError 废弃。
3. **字段定名**：`description`（与 WebCodecs 配置同名）；core `codecPrivate` 作过渡别名，M2 接入波次统一。
4. **方法名定名**：`open/readSample/pause/resume/seek/destroy + metadata/tracks 属性`（T1 任务书口径）；`parseInit/init/attach/stop/samples` 按 §2.4 别名表兼容迁移，接入波次后清理。

### 12.2 待决输入槽位（收到后裁决进 v0.2）

- media-dev：core 公共件接口建议（emitter/data-source/clock/mse-helper/stats 现状已吸收进 §2/§4/§7，差异部分见 §12.1）；
- vue-dev-3：cmaf/mp4 ISO-BMFF 复用意见（预置方向：box 遍历器与 sample table 逻辑沉淀 core/src/isobmff-*，cmaf 以 sidx/styp 扩展复用，避免两份解析器）。

### 12.3 接口冻结条款（v0.2 新增）

- **冻结范围**：`Demuxer` 全部公开方法与属性（open/readSample/samples/seek/pause/resume/start/destroy/mediaInfo/tracks/metadata/getBufferedRanges/static probe）、`Player` 全部公开 API 与六态状态机（§5）、事件名全集（§2.3）、数据形状 Sample/Track/MediaInfo/ProbeResult/Cue 的既有字段。
- **冻结期**：自本版发布起，至 **M2 评审完成**解除；解除后恢复 §12 一般治理流程。
- **演进规则**：新增可选成员=允许（minor 版本）；§2.4 别名表只许扩充行、不许修改既有行语义；删除/改名/改语义=破坏性变更，须 **captain+leader 双签**批准并上板公告后方可进新版本。
- **执行**：违反冻结的实现一律评审打回。背景：接口已三次成形（v1.0.0 的 parseInit/samples → v0.1 的 open/readSample），再翻一次全仓返工不可接受。

---

*签署：architect · 2025-08-25。本契约自签发起对 core 与全部 demuxer 实现生效；media-dev 依此交付 core，各工程师依 §2.5 清单对齐，偏离须走 §12 治理流程。*

*v0.2 修订：architect · 2025-08-25 · ①编号归位 0.x 线（临时版 v1.0.0 编号废止，全仓引用以 v0.2 为准）；②hls AES-128 支持依 leader 对 qa TESTPLAN §11 Q1 的裁决纳入（范围仅限 hls）；③接口冻结条款生效（§0.7/§12.3，至 M2 评审完成）。本帖上板公示，请 captain 批复。*
