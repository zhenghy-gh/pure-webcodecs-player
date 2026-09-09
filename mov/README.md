# @player/mov —— QuickTime(MOV) 兼容层

基于 `mp4` 模块的 ISO-BMFF 解析能力，叠加 QuickTime 特有 atom 的兼容语义，使老式 `.mov` 文件走同一套 Demuxer → MSE/WebCodecs 管线。

## 架构图

```
        .mov 文件
            │
            ▼
   ┌── MovDemuxer ─────────────────────────────┐
   │  probe：qt 品牌 / wide/pnot 特征           │
   │  cmov（压缩 moov）→ 明确拒绝并提示转封装    │
   │  复用 Mp4Demuxer：box 解析/采样表/seek     │
   │  QT 增强语义：                             │
   │   · SoundDescription v1/v2 音频描述        │
   │   · udta>meta(©nam/©ART...) → qtTags      │
   │   · tmcd 时间码轨 → METADATA               │
   │   · elst 空编辑(mediaTime<0) → emptyEdit   │
   └───────────────────┬───────────────────────┘
                       ▼
          Sample 流 → Fmp4Remuxer → MSE / WebCodecs
```

## 浏览器可行性结论

✅ **完全可纯前端**——与 MP4 同为 ISO-BMFF 家族，差异只在元数据层。真正不可行的只有两类历史遗留，本模块都会显式报错而不是静默出错：

| 遗留特性 | 处理 |
|----------|------|
| `cmov` 压缩 moov（zlib，90 年代 Cinepak 光盘产物） | 抛 `NOT_SUPPORTED`，提示 `ffmpeg -c copy` 转封装 |
| 加密 sample entry（encv/enca） | 抛 `NOT_SUPPORTED` |

其余（wide 占位、v1/v2 音频描述、udta 标签、tmcd、elst 空编辑）全部透明兼容。

## 快速开始

```js
import { MovDemuxer } from '../mov/src/index.js';
import { remuxDemuxer, attachFileDrop } from '../mp4/src/index.js'; // remuxer 直接复用
import { BlobDataSource, MseHelper } from '../core/src/index.js';

attachFileDrop(dropZone, async (source) => {
  const demuxer = new MovDemuxer(source); // 与 Mp4Demuxer 同一套生命周期（契约 §2.2）
  const info = await demuxer.open();

  console.log('QT 元数据：', info.qtTags);       // { '©nam': '标题', '©ART': '作者' }
  console.log('标题镜像：', info.metadata.title); // ©nam 同步进契约 metadata.title
  // 之后与 mp4 完全一致（样本为整数微秒契约形状）：
  for await (const { track, init, segments } of remuxDemuxer(demuxer)) { /* MSE */ }
}, { accept: ['.mov'] });
```

### 自动选路（推荐入口写法）

```js
import { Mp4Demuxer } from '../mp4/src/index.js';
import { MovDemuxer } from '../mov/src/index.js';

const head = await source.read(0, 64);
const DemuxerClass =
  MovDemuxer.probe(head) >= Mp4Demuxer.probe(head) ? MovDemuxer : Mp4Demuxer;
```

## API 说明

### MovDemuxer extends Mp4Demuxer
- 静态 `probe(bytes)→ProbeResult|null`（契约 §2.2）：品牌 `qt  ` → 0.98；顶层 `wide/pnot` → ≥0.9；无特征时按通用 ISO 打分 ×0.6（让位纯 MP4）。
- `open()` 后的 MediaInfo 增补字段：
  - `container: 'mov'`
  - `qtTags: Record<fourcc, string>`：©nam/©ART/cprt 等 udta 文本标签
- Track 增补字段（可选）：
  - `emptyEdit: boolean` / `mediaTimeSec?: number`：来自 elst 编辑列表（播放器据此平移 pts）
  - tmcd 时间码轨：`type='metadata'`、`codec='tmcd'`

### atom-compat.js 工具
- `looksLikeQuickTime(bytes)` / `listTopLevelAtoms(bytes)`
- `detectCompressedMoov(moovBytes)` → `{compressed, vendor?}`（vendor 如 'zlib'）
- `parseUdtaTags(moovBytes)`：兼容 QT 无头 meta 与 ISO version+flags meta 两种布局；文本约定 u16 大端长度 + UTF-8
- `interpretEdits(elstEntries, timescale)` → `{hasEmptyEdit, firstMediaTimeSec}`
- `isTimecodeHandler('tmcd')`

### 兼容矩阵（已覆盖）

| QuickTime 特性 | 状态 |
|----------------|------|
| ftyp 品牌 `qt  ` / 无 ftyp 的老文件 | ✅ probe 特征识别 |
| `wide` 8 字节占位 atom | ✅ 当作普通顶层 box 跳过 |
| mvhd/tkhd/mdhd/elst version 1（64 位时间） | ✅ mp4 解析器原生支持 |
| Sound sample description **v1/v2**（Float64 采样率） | ✅ |
| `udta > meta(hdlr=mdir) > ©nam...` | ✅ 输出 qtTags |
| `tmcd` 时间码轨（含 TimeCodeDef 子 atom） | ✅ 归入 METADATA |
| `edts/elst` 空编辑（media_time = -1） | ✅ emptyEdit 标记 |
| `pnot` 预览 atom | ✅ 仅作探测特征，不解析内容 |
| `cmov` 压缩 moov | 🚫 NOT_SUPPORTED（提示转封装）|
| 加密轨道 encv/enca | 🚫 NOT_SUPPORTED |

## 运行测试

```bash
npm run fixtures && node --test "mov/__tests__/*.test.js"   # 30 例全绿（含 gen.mjs 产物端到端）
```

## 已知限制与路线

- 未处理 `matt/kmat` 视频蒙版、`chan` 声道布局 box（不影响解码主链路，后续按需透出）；
- 老 ProRes/Apng/JPEG 等 QT 编码不在 WebCodecs/MSE 支持范围，会走到 codec string 为空的自然失败；
- 路线：cmov 用 DecompressionStream('deflate') 尝试恢复、chan → AudioDecoder channelLayout 映射。
