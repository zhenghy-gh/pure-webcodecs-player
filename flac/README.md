# flac —— 无损音频解码 JS 参考实现（解析 → 解码 → 播放）
> 状态：✅ 已交付 · 测试 40 例 全绿（node --test flac/__tests__/*.test.js）· 元数据/帧头/子帧全谱 JS 解码器 · decodeAudioData 主路径自动回退 · 吞吐门槛 ≥2× 实测 127× · 更新 2026-08-26

> 归属：ui-kit-dev　|　契约基线：docs/CONTRACTS.md v0.2（E-8 口径）
> 可行性结论（docs/00-需求与可行性结论.md）：**完全可纯前端**——FLAC 解码 → AudioWorklet。
>
> **解码路线（任务书 T16 口径）**：
> ① 主路径 = WebAudio `decodeAudioData`（浏览器原生 FLAC 解码，零 JS 解码开销）；
> ② 回退 = 本目录纯 JS 参考解码器 `FlacDecoder`（覆盖四类子帧全谱），原生解码
>    拒绝时经 `loadFlacSmart()` 自动接管；
> ③ 可选增强 = WASM libflac 替换内核（接口不变）。纯 JS 实现同时承担
>    **协议教学与回归基准**职责，完整保留并全量测试。

## 一、格式原理

```
┌────────────────────────── .flac 文件 ──────────────────────────┐
│ 'fLaC'                                                         │
│ METADATA_BLOCK*  （首块必为 STREAMINFO，34B）                   │
│   ├─ STREAMINFO  采样率/声道/位深/总样本数/MD5                  │
│   ├─ SEEKTABLE   18B/点（采样号→字节偏移）                      │
│   ├─ VORBIS_COMMENT 键值标签 / PICTURE 封面 …                   │
│ FRAME+            帧头(CRC-8) + 子帧×n + 填充位 + CRC-16        │
│   帧头：sync(14b)=11111111111110 | 策略 | 块大小/采样率/位深码    │
│         | 声道分配 | UTF-8 式编码数                              │
│   子帧：CONSTANT / VERBATIM / FIXED(0~4阶) / LPC(1~32阶)        │
│         残差 = Rice 编码分区（4/5bit 参数，可转义为原码）          │
└─────────────────────────────────────────────────────────────────┘
```

立体声优化模式：left/side、right/side、mid/side（差异通道恒存 `左−右`）。

## 二、JS 参考实现的覆盖范围

| 能力 | 状态 |
|---|---|
| STREAMINFO / SEEKTABLE / VORBIS_COMMENT / PICTURE 解析 | ✅ |
| 帧头全字段解析 + CRC-8 校验 + 同步扫描重同步 | ✅ |
| CONSTANT / VERBATIM 子帧 | ✅ |
| FIXED 预测 0~4 阶 + Rice 分区残差（含 partitionOrder>0、转义路径解码） | ✅ |
| LPC 1~32 阶（warmup→精度→位移→系数顺序）+ Rice 残差 | ✅ |
| 浪费位（wasted bits）还原 | ✅ |
| left-side / right-side / mid-side 立体声还原 | ✅ |
| 整帧 CRC-16 校验与损坏帧丢弃续走 | ✅ |
| \karaoke 等 meta 数据块（CUESHEET/APPLICATION） | 跳过透传 |
| 12bit 位深帧头码（sampleSizeCode=010） | ✅ 头部识别，样本按位深归一化 |

**明确不做**：多线程 SIMD 优化、`\t` 时变滤镜（不存在于音频域）。性能敏感场景建议
后续以 WASM 版 libflac 替换 `FlacDecoder` 内核——对外 API（`decodeFlacToPlayable` /
`FlacDemuxer`）保持不变。

## 三、模块结构

| 文件 | 职责 |
|---|---|
| `src/metadata.js` | 元数据块遍历与结构化 |
| `src/frame-header.js` | 帧头解析、同步码扫描 |
| `src/subframe.js` | 四类子帧解码 + Rice 残差 + 立体声还原 |
| `src/decoder.js` | `FlacDecoder.decodeFrame()`：整帧解码 + CRC-16 校验 |
| `src/demuxer.js` | `FlacDemuxer`：probe/parseInit/samples/seek（契约 §2 形状），全量扫描建帧索引 |
| `src/player.js` | `createFlacPlayer()`：解码全部 → 内存 f32 WAV → 复用 wav worklet 管线 |

## 四、快速开始

```js
import { createFlacPlayer, loadFlacSmart } from '../src/index.js';
import { createPlayerUI } from '../../site/player-ui.js';

const player = createFlacPlayer();               // Node 返回 null
const ui = createPlayerUI({ mount: '#ui' });
ui.bind(player);

const bytes = new Uint8Array(await file.arrayBuffer());
// 主路径 decodeAudioData，失败自动回退纯 JS 解码器（via 字段标注实际路径）
const { wavBytes, via } = await loadFlacSmart(player, bytes);
player.load(wavBytes);                           // seek/倍速/波形全部继承
```

Demuxer 用法（只取帧不解码）：

```js
const dem = new FlacDemuxer(source);
await dem.parseInit();                            // MediaInfo：codec 'flac'，
                                                  // description = STREAMINFO 34B
for await (const frame of dem.samples(1)) play(frame.data);
```

## 五、已知限制与路线

1. **seek 粒度 = 帧**（典型 4096 样本 ≈ 85ms@48k）；SEEKTABLE 存在时优先表项校正落点。
2. 帧索引需一次全文件位级扫描建索引（无帧长字段所致）；大文件的流式增量扫描在 M3 整合。
3. `createFlacPlayer` 为「先解码后播放」参考实现，内存占用 ≈ 原始 PCM 大小；
   边解边播管线由 core player 统一编排后替换。
4. 并行期未继承 core BaseDemuxer（共享看板约定），core 稳定后切基类、接口不变。

---
*ui-kit-dev · 2026-08-25*
