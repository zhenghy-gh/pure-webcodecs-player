# PurePlay · mkv —— 浏览器 MKV/WebM 播放器（EBML 解析 + Matroska Demux）

纯前端、零构建的 Matroska/WebM 解析层。公开面**逐字对齐 `docs/CONTRACTS.md` v0.2**（接口冻结条款生效中）：`probe → open → readSample/samples → seek → destroy`，输出契约 Sample/Track/MediaInfo，整数微秒时间基。

> 归属：vue-dev-1（MKV/WebTorrent 方向）· 契约基线 CONTRACTS v0.2 · 单测门槛 ≥60（实测 60，全绿）

## 一、原理速览

**EBML** 是 Matroska 的自描述二进制容器语言，核心两件事：

1. **变长整数 VINT**：首字节中「第一个为 1 的位」是标记位，其位置决定总长 n；数据位共 `7n` 位。
   - 元素 ID：标记位属于编码本身（EBML 头 = `0x1A45DFA3`，Segment = `0x18538067`）；
   - 尺寸：掩掉标记位；数据位全 1 表示未知长度（流式封装常见）；8 字节形态标记位独占首字节。
2. **元素嵌套**：`ID + Size + Data`；Master 元素的 Data 为子元素序列。

```
文件: [EBML 头] [Segment
         ├── Info        (TimecodeScale / Duration / Title / DateUTC …)
         ├── Tracks      (TrackEntry × N → CodecID / CodecPrivate / Video / Audio)
         ├── SeekHead    (可选索引：元素 ID → 段内偏移)
         ├── Cluster × N (Timecode + SimpleBlock/BlockGroup…)
         └── Cues        (可选寻址索引: CueTime → CueClusterPosition)]
```

**Block 结构**：`[轨道号 VINT][相对时间码 int16BE][flags][帧数据…]`
- flags：bit7=关键帧（仅 SimpleBlock）、bit2-1=Lacing 类型、bit0=可丢弃；
- Lacing 三式：Xiph 锁存字节链 / fixed 等分 / EBML 差值（有符号 VINT=数据位宽二补码，见「已知限制」）；
- 时间换算：`(ClusterTimecode + 相对时间码) × TimecodeScale`，本模块统一换算 **µs 整数**后输出（契约 §0.5）；
- 关键帧判定：SimpleBlock 看 flags；BlockGroup 内 Block 以**是否存在 ReferenceBlock** 区分参考/非参考帧。

## 二、浏览器可行性结论

✅ 完全可纯前端。解析只耗字节与 CPU；解码走 WebCodecs（VP8/VP9/AVC/AV1/AAC/Opus/FLAC），HEVC 取决于平台硬件。大文件惰性解析：open 只扫元素头，样本按需拉取。

## 三、架构

```
┌────────────────────────────────────────────────────────────────┐
│  core 注册表 / site 汇总页 / 直接调用方                           │
│    probe(bytes) · createDemuxer(source) · MkvDemuxer            │
└───────────────┬────────────────────────────────────────────────┘
                │ DataSource { size, read(o,l)->Promise<Uint8Array> }   ← 契约 §2.1
┌───────────────▼───────────────┐   ┌───────────────────────────┐
│ source.js                     │   │ schema.js  ID↔名称/类型表  │
│ Buffer/Blob/Fetch(Range+顺序) │   └────────────▲──────────────┘
└───────────────┬───────────────┘                │
┌───────────────▼───────────────┐   ┌────────────┴──────────────┐
│ demuxer.js  MkvDemuxer        │──▶│ ebml.js                   │
│ open()/readSample()/seek()    │   │ VINT 读写/元素遍历/Writer  │
│ Cues 定位+线性簇索引兜底       │   ├───────────────────────────┤
│ µs 换算在输出边界完成          │──▶│ lacing.js 三种 Lacing     │
└───────────────────────────────┘   ├───────────────────────────┤
        复用 core 叶子件 ▶           │ codecs.js                 │
  PlayerError十码 · Emitter ·       │ CodecID 归一化（串构造收敛 │
  codec-string 构造器               │ core/src/codec-string.js）│
                                    └───────────────────────────┘
```

继承说明：core `Demuxer` 基类尚处 attach/init/ticks 旧形（E-8 迁移波次未到），本模块当前为**自含同形实现**——公开方法名与数据形状与冻结契约逐字一致，并直接复用 core 的 `PlayerError`/`Emitter`/codec-string 构造器；基类继承切换在 E-8 落地后进行（reviewer F10 跟踪项）。

## 四、快速开始

```html
<script type="module">
import { createDemuxer } from './mkv/src/index.js';

// File/Blob/Uint8Array/URL/DataSource 任一输入；工厂内部 探测→构造→open
const d = await createDemuxer(fileInput.files[0]);

console.log(d.mediaInfo.container, d.mediaInfo.durationUs);
for (const t of d.tracks) {
  console.log(t.id, t.type, t.codec, t.description?.length); // description=定稿名
}

// pull 主通道（天然背压）；EOS 返回 null
const s = await d.readSample(1); // {trackId, codec, timestamp(µs), duration(µs), data, keyframe, dts, size, index}

// 糖层迭代器
for await (const s of d.samples(1)) { /* … */ }

// seek（µs）：清空缓冲并对齐寻址点，返回实际落点
const { actualTimestampUs } = await d.seek(30_000_000);

await d.destroy();
</script>
```

WebCodecs 解码最小闭环：

```js
const v = d.tracks.find(t => t.type === 'video');
dec.configure({
  codec: v.codec,
  codedWidth: v.width, codedHeight: v.height,
  description: v.bitstreamFormat === 'avc' ? v.description : undefined,
});
for (;;) {
  const s = await d.readSample(v.id);
  if (!s) break;
  dec.decode(new EncodedVideoChunk({ type: s.keyframe ? 'key' : 'delta', timestamp: s.timestamp, data: s.data }));
}
```

运行演示页：

```bash
cd mkv && python3 -m http.server 8090   # 或根目录 npm run demo
# 打开 http://127.0.0.1:8090/demo/
# 功能：拖文件/URL → DocType·Track 表（失败标红）→ 全量扫描 → seek50% → WebCodecs 首帧预览
```

## 五、API（契约 §10 注册形状 + 类面）

### index.js 导出

| 导出 | 说明 |
|---|---|
| `containerName = 'mkv'` | ∈ MediaInfo container 枚举 |
| `extensions` | `['mkv','mk3d','mka','mks','webm']` |
| `mimeTypes` | video/audio x-matroska + webm |
| `probe(bytes)` | 同步嗅探 → `{confidence≥0.8, container}` 或 null；永不抛 |
| `createDemuxer(source, options)` | 一体工厂；识别失败 reject `PlayerError('PROBE_FAILED')` |
| `MkvDemuxer` | 主类 |

### MkvDemuxer（契约 §2.2）

| 成员 | 说明 |
|---|---|
| `static probe(bytes)` | 同上（类入口与模块函数等价） |
| `constructor(source, options)` | source = DataSource `{size,read,close?}`（兼容 byteLength 旧名） |
| `async open()` | 解析 EBML 头+Segment；resolve 后 `mediaInfo/tracks/metadata` 可用并 emit `'media-info'` |
| `async readSample(trackId)` | pull 主通道；EOS null；未 open/已销毁 throw `STATE_ERROR` |
| `samples(trackId)` | 异步迭代器糖层 |
| `async seek(timestampUs)` | Cues 定位优先，无 Cues 线性扫簇建索引；返回 `{actualTimestampUs}`；不可寻址 reject `SEEK_UNSUPPORTED` |
| `pause/resume/start` | 点播容器的安全空操作（保留冻结方法名） |
| `async destroy()` | 幂等释放；之后一切调用 `STATE_ERROR` |
| `mediaInfo/tracks/metadata` | MediaInfo / Track[] / `{container,durationUs,live,seekable,title,…}` |
| `getBufferedRanges(trackId)` | 点播整段范围 |
| 事件 | `'media-info'` `'error'` `'end'{reason:'eos'\|'aborted'}` |

### Sample / Track 要点（契约 §1）

- Sample：`{trackId, codec, timestamp(PTS µs), duration(µs,未知=0), data(Uint8Array), keyframe, dts=timestamp, size, index}`；音频/文本轨 keyframe 恒 true；视频按文件序（MKV 无独立 DTS）。
- Track：`type:'video'|'audio'|'text'`（字幕定稿 text）、`codec` 规范串、`description`（定稿名，codecPrivate 过渡别名）、视频含 `bitstreamFormat:'avc'|'annexb'`、音频 `sampleRate/numberOfChannels`、`language` 默认 `'und'`、`timescale` 仅诊断。
- 加密轨（ContentEncodings 存在）：`encrypted:true, supported:false`——open 正常、readSample reject `NOT_SUPPORTED`（PRD 口径：标红不崩）。

### codec 串（契约 §3）

构造收敛 core：`buildAvcCodecString(avcC)` / `buildHevcCodecString(hvcC,'hev1')` / `aacCodecString(AOT)`。容器拿不到参数集时降级家族基础串（`vp09`/`av01`/`avc1`…）并 warn，**不编造 profile**。

## 六、支持的 CodecID 映射

| Matroska CodecID | codec 串 | 私有数据(description) | 管线 |
|---|---|---|---|
| `V_MPEG4/ISO/AVC` | `avc1.PPCCLL` | AVCDecoderConfigurationRecord | ✅ bitstreamFormat='avc' |
| `V_MPEGH/ISO/HEVC` | `hev1.…`（有 hvcC 时精确） | HEVCDecoderConfigurationRecord | ⚠️ 平台相关 |
| `V_VP9` / `V_AV1` | `vp09` / `av01` 基础串 | —（vpcC/OBU Phase 后置） | ✅ |
| `A_AAC` | `mp4a.40.<AOT>` | AudioSpecificConfig | ✅ |
| `A_OPUS` / `A_FLAC` | `opus` / `flac` | OpusHead / fLaC STREAMINFO | ✅ |
| `A_MPEG/L3`,`A_VORBIS`,`A_PCM/INT/LIT` | 家族基础串 | — | ✅ |
| `S_TEXT/UTF8` 等 | `x-srt/x-vtt/x-ass` | 文本透传 | Cue 流对接 subtitle 模块 |
| AC3/DTS/TRUEHD/MPEG1/2… | 原样透传 | — | ❌ supported=false，样本仍可提取 |

## 七、已知限制与路线

1. **EBML Lacing 有符号尺寸互操作校验点**："有符号 VINT" 采用主流理解——同宽度标记、数据位按位宽二补码解释（全 1 位型即 -1）。fixture roundtrip 已验；真实文件如遇偏差请对照 `mkvinfo` 反馈。
2. 多 Segment 文件仅取第一个；未处理 BlockAdditions 与 Chapter 深层结构（安全跳过）。
3. VP9/AV1 精确 codec 串需解析帧头参数集，当前降级基础串（README 如实标注）。
4. 无 Cues 且未预扫描时首个 seek 会做一次线性簇索引（header-only 扫描，开销小）。
5. 路线：接入 core Demuxer 基类（E-8）、ContentEncoding 压缩轨支持、mux 方向（EbmlWriter 已具雏形）、字幕 Cue 流直通 subtitle 模块。

## 八、测试（60 例，node --test 全绿）

```bash
cd mkv && node --test "__tests__/*.test.js"     # 或 npm test（根）
```

- `fixtures/make-fixture.mjs` 程序化生成六种最小合法夹具（常规 webm / 未知长度 / matroska 三编码 / 文本轨 / 加密轨 / 无时长+DateUTC）；`fixtures/gen.mjs` 提供契约要求的 `async generate(fixDir)` 磁盘产物出口（测试本体零 IO）；
- `ebml.test.js`（25）：VINT 边界与未知长度、ID 编码、五类值解码、树构建、Writer 字节断言、三种 Lacing 往返；
- `demuxer.test.js`（22）：probe 矩阵、MediaInfo/Track 契约形状、pull/EOS/STATE_ERROR、seek 双路径、事件、加密 NOT_SUPPORTED、BlobSource、FetchSource Range/顺序双模式；
- `contract-edge.test.js`（13）：IETF 语言优先、Void/CRC32 跳过、Display 尺寸、外来 DocType 拒绝、序号重置、8 字节尺寸编读等稀疏路径。

## 九、接口对齐声明

- 契约锚点：`docs/CONTRACTS.md` **v0.2**（§0 硬约束 / §1 数据形状 / §2 Demuxer / §3 codec 串 / §10 注册形状 / §11.3 错误体系）。
- 自检清单：static probe→ProbeResult|null ✓；open/readSample/destroy ✓（init 为 §2.4 别名）✓；samples(trackId) 糖层 ✓；µs 整数时间基 ✓；具名导出无 default ✓；PlayerError 十码（复用 core/src/errors.js）✓；codec 串走 core/src/codec-string.js ✓；DataSource.size 字段 ✓。
