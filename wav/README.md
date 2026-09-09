# wav —— RIFF/WAVE 解析 + AudioWorklet 播放与波形绘制
> 状态：✅ 已交付 · 测试 28 例 全绿（node --test wav/__tests__/*.test.js）· RIFF 全位深+EXTENSIBLE+INFO · Demuxer · AudioWorklet 播放器 · 波形 · 更新 2026-08-26

> 归属：ui-kit-dev　|　契约基线：docs/CONTRACTS.md v0.2（E-8 口径）
> 可行性结论（权威依据 docs/00-需求与可行性结论.md）：**完全可纯前端**——RIFF 解析 → AudioWorklet/WebAudio。

## 一、格式原理

```
┌─────────────────────────── .wav 文件 ───────────────────────────┐
│ 'RIFF'  riffSize(u32le)  'WAVE'                                 │
│ ┌─ 'fmt ' ────────────────┐                                     │
│ │ formatTag channels      │  1=PCM 3=IEEE float                 │
│ │ sampleRate byteRate     │  0xFFFE=EXTENSIBLE(SubFormat GUID)  │
│ │ blockAlign bitsPerSample│                                     │
│ └─────────────────────────┘                                     │
│ ├─ 'LIST'/'INFO'…        元数据（INAM/IART…，可选）              │
│ └─ 'data'                PCM 采样（小端、交错存储）              │
└──────────────────────────────────────────────────────────────────┘
```

- 所有整数小端；子块奇数长度后补 1 字节。
- 支持位深：u8 / s16 / s24 / s32 / f32；归一化规则见 `src/pcm-convert.js` 头注。

## 二、浏览器可行性

纯字节解析零依赖；播放走 WebAudio：

```
File/ArrayBuffer → parseWavHeader → convertToFloat32Planar(整段)
   → postMessage(f32-planar, Transferable) → AudioWorklet 环形缓冲
   → 线性插值倍速消费 → GainNode → destination
```

- 无 MSE 必要性（ARCHITECTURE §路线表），WebCodecs 也非必需——直接喂 worklet 最短路径。
- Node ≥18 下解析层全部可测；播放层经 `isWavPlaybackSupported()` 守卫，Node 返回 false，不抛异常。

## 三、模块结构

| 文件 | 职责 |
|---|---|
| `src/riff-parser.js` | RIFF 子块遍历、fmt/LIST/INFO 解析、codec 字符串映射 |
| `src/pcm-convert.js` | 各位深 → f32-planar 归一化、帧切片视图 |
| `src/demuxer.js` | `WavDemuxer`：probe/parseInit/samples/seek/stop（契约 §2 形状） |
| `src/worklet-processor.js` | 环形缓冲 + 插值重采样处理器源码（Blob URL 加载） |
| `src/player.js` | `WavPlayer`：实现 site PlayerAdapter 协议的高层播放器 |
| `src/waveform.js` | 峰值包络计算 + Canvas 绘制（context 鸭子类型可 mock） |

## 四、快速开始

```html
<script type="module">
  import { createPlayerUI } from '../../site/player-ui.js';
  import { createWavPlayer, computePeaks } from '../src/index.js';

  const player = createWavPlayer();          // Node/不支持环境返回 null
  const ui = createPlayerUI({ mount: '#ui', fullscreenEl: '#wrap' });
  ui.bind(player);

  const bytes = new Uint8Array(await (await file.arrayBuffer())); // 拖入或 fetch
  player.load(bytes);
</script>
```

Demuxer 用法（解耦播放的取样本路径）：

```js
import { WavDemuxer } from '../src/index.js';
const dem = new WavDemuxer(memorySource /* {size, read(offset,len), close()} */);
const info = await dem.parseInit();          // → MediaInfo(container:'wav')
for await (const sample of dem.samples(1)) { // pcm-s16 Sample，µs 时间戳
  render(sample);
}
await dem.seek(1_500_000);                   // µs
```

## 五、API 摘要

### WavPlayer（即 PlayerAdapter）
`load(bytes)` · `play/pause()` · `seek(sec)` · `setVolume(v)` · `setRate(r)` ·
`duration()/currentTime()`（秒）· `getStats()`（统计面板）· `on('ready'|'play'|'pause'|'ended'|'time'|'error')`

### 波形
`computePeaks(planar, buckets) → {mins,maxs}`；
`drawWaveform(ctx2d, {width,height}, peaks, progress01, theme)`。

## 六、已知限制与路线

1. **全量解码进内存**：`WavPlayer.load` 将 data 块整体转 f32-planar（4 字节/采样），
   数百 MB WAV 会占用大内存。流式直通（demuxer Sample → worklet 不落全量）为 M3 整合项。
2. **不支持** ADPCM / a-law / μ-law 解码（probe 能识别并报 NOT_SUPPORTED，错误码见 §契约 11.3 十码封闭枚举）。
3. **倍速**用线性插值重采样（0.25x~4x），不做变速不变调（Phase 3 可选 SoundTouch 类方案）。
4. 并行期未继承 core BaseDemuxer（共享看板约定）；core 稳定后切换基类，接口不变。

---
*ui-kit-dev · 2026-08-25*

> 评审闭环补充（2026-08-26）：round-1 §6 阻断1（环形缓冲溢出覆写）与严重 2/3/4、建议级裸 Error 全部修复闭环——worklet 写侧守卫+主线程水位节流双保险；open/readSample/destroy 定稿方法与 §10 注册形状落地；流式哨兵/byteRate=0/f32 钳制/STATE_ERROR 归位。复核见 review-round1 键 reviewer 结论（阻断1 ✅ 关闭）。
- 模块级 package.json 已落盘（net-dev 示范口径）：`npm test` = node --test --test-force-exit "__tests__/*.test.js"。
- review-round1 #8 闭环（2026-08-26）：全模块裸 Error 清零，统一十码 PlayerError（pcm-convert 非法位深=STATE_ERROR、组合不支持=NOT_SUPPORTED；player 环境守卫=NOT_SUPPORTED、未加载先播=STATE_ERROR；demuxer error 态=STATE_ERROR）。
