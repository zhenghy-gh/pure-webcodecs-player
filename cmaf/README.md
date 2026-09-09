# cmaf —— CMAF 低延迟方向（chunked CMAF 解析 / LL-HLS part 策略 / WebCodecs 直解）

> 纯 ESM、零构建、零第三方运行时依赖。
> 契约基线：docs/CONTRACTS.md v0.1 §2.5（probe：ftyp+styp/sidx；LL 场景未收尾即吐 sample）、
> §6（WebCodecs 首选路线）。作者：vue-dev-3。

## 一、CMAF 是什么

CMAF（ISO/IEC 23000-19，Common Media Application Format）把媒体组织成
**一条轨 = 一个 init segment + 一串自包含 chunk**：

```
init segment:  [ftyp][moov]                    ← 轨道元信息 + 解码配置（avcC/esds）
chunk:         [styp][moof[traf[tfhd tfdt trun]]][mdat]   ← 自包含可独立解码的片段
               [styp][moof...][mdat]
               ...
```

同一份 CMAF 媒体既可以用 HLS 清单分发（LL-HLS），也可以用 DASH 分发——
这正是它成为"低延迟通用容器"的原因。本模块聚焦播放端三件事：

1. **chunked track 解析**：把字节流切回 init + chunks，还原样本表；
2. **LL-HLS part 加载策略**：part 时间线状态机与阻塞重载决策（骨架）；
3. **WebCodecs 直解**：从 init 推导 `VideoDecoderConfig/AudioDecoderConfig`
   并直解样本（契约 §6 定稿路线，绕过 MSE 的缓冲延迟）。

## 二、浏览器可行性结论

✅ **完全可纯前端**。

| 环节 | 可行性 | 说明 |
|------|--------|------|
| ISO-BMFF 遍历/chunk 切分 | ✅ | 本模块自实现最小遍历件，Node 单测 12 项全绿 |
| WebCodecs 直解 | ✅ Chrome/Edge | Firefox 129+ 渐进支持；Safari 视频暂缺 |
| LL-HLS part 策略 | ✅ | 纯逻辑骨架，Node 可测；IO 由加载器驱动 |

## 三、架构与模块组成

```
            ┌──────────────────────────────────────────────┐
            │              cmaf/src/index.js               │
            └───┬───────────────┬───────────────┬──────────┘
                │               │               │
      ┌─────────▼────────┐ ┌────▼────────────┐ ┌▼─────────────────────┐
      │   isobmff.js     │ │ llhls-parts.js  │ │    webcodecs.js      │
      │ box 遍历/trun/    │ │ PartTimeline    │ │ decoderConfigsFromInit│
      │ tfhd/tfdt/moof   │ │ 状态机/阻塞重载   │ │ CmafWebCodecsPlayer   │
      └─────────┬────────┘ └────┬────────────┘ └┬─────────────────────┘
                │               │               │
      ┌─────────▼───────────────▼───────────────▼─────┐
      │              chunk-parser.js                  │
      │ probe() · splitChunks() · parseInitSegment()  │
      └───────────────────────────────────────────────┘
```

**关于 ISO-BMFF 复用（回应契约 §12.2 槽位）**：建议把 box 遍历器与 sample table
逻辑沉淀为 `core/src/isobmff-*`（architect 预置方向），mp4/cmaf 共用同一遍历件，
cmaf 仅以 styp/sidx 扩展复用。本模块 `isobmff.js` 即按此边界的过渡实现——
接口刻意收敛为纯函数，迁移时只需改 import 路径。意见已同步共享看板待裁决。

## 四、快速开始

```js
import { probe, splitChunks, parseInitSegment } from '../cmaf/src/index.js'

// 1) 嗅探（契约 §10 形状：命中返回 ProbeResult）
const p = probe(headerBytes)          // {confidence:0.95, container:'cmaf'} 或 null

// 2) 切分（内存流或增量聚合后的完整段）
const { chunks, initRange } = splitChunks(trackBytes)
//    initRange = {startOffset, byteLength} → parseInitSegment 用
//    chunks[i] = {index,styp,startOffset,byteLength,
//                 tracks:[{trackId,baseTime,samples:[{durationTicks,size,keyframe,dtsOffset,dataStart}]}]}

// 3) 解码配置推导（浏览器）
import { decoderConfigsFromInit, CmafWebCodecsPlayer } from '../cmaf/src/index.js'
const cfg = decoderConfigsFromInit(initBytes)
// cfg.video = {codec:'avc1.64001f', description:<avcC>, optimizeForLatency:true}
```

## 五、API 说明

### chunk-parser

| 导出 | 说明 |
|------|------|
| `probe(bytes)` | 同步嗅探；styp→0.95，ftyp→0.6（可能是普通 mp4），其余 null |
| `splitChunks(buf)` | 切分；ftyp 开头且无 moof 的块识别为 init（`initRange`），其余按 styp/moof 归组为 chunks |
| `parseInitSegment(init)` | `{video:{entryType,description,timescale}, audio:{asc,codecAot,timescale}}` |

### webcodecs

| 导出 | 说明 |
|------|------|
| `decoderConfigsFromInit(init)` | 产出 WebCodecs 配置；时间戳在公共边界换算整数 µs（契约 §0.5） |
| `CmafWebCodecsPlayer` | `open(init)` → `appendChunk(chunk, buf)` → frame 回调；Node 下构造抛 `NOT_SUPPORTED` |
| `codecStringFromAvcC / FromAsc` | 契约 §3 的 avc1.PPCCLL / mp4a.40.AOT 推导 |

### llhls-parts（纯逻辑骨架）

| 导出 | 说明 |
|------|------|
| `PartTimeline` | part 状态机（pending/loading/ready/gap）；`updateFromPlaylist(segments)` 合并清单且状态不回退；`pickNext({startup})` 起播优先最近 INDEPENDENT part |
| `buildBlockingReloadUrl(url,{msn,part})` | `?_HLS_msn=&_HLS_part=` 阻塞重载地址 |
| `nextPollTarget(timeline)` | 下次轮询目标（支持 CAN-BLOCK-RELOAD） |
| `shouldPrefetchPreloadHint(hint, tl, {inFlight,maxInFlight})` | PRELOAD-HINT 预取决策（去重 + 并发上限） |

## 六、demo 使用说明（诚实标注）

`demo/index.html`：

- **拖入本地 CMAF/fMP4 文件**（`.cmf1/.cmfv/.cmfa/.m4s/mp4`）：解析并展示 box 结构树、
  chunk 时间线与解码配置——完全离线可用；
- 输入远程 LL-HLS part 地址实时拉取：需要可达地址 + CORS，离线时显示友好降级提示；
- WebCodecs 直解预览按钮：环境不支持时明确提示能力缺失，不产生未捕获异常。

## 七、已知限制与路线

1. **isobmff.js 为最小遍历件**：只覆盖 CMAF 关键路径（见文件头注释），
   不做 mp4 全量解析；待 core isobmff-* 沉淀后迁移合并。
2. **多轨 chunk**：解析层已按 traf.trackId 分组，但 demo 只演示单视频轨；
   音视频双 chunk 交错装载归统一内核调度。
3. **sidx 寻址索引已支持**（v0.2 补齐）：`parseSidx` 解析 reference_ID/timescale/
   earliest_presentation_time/first_offset 与逐引用 size/duration/SAP 位；
   `splitChunks` 捕获为 `segmentIndex` 供统一内核 seek 调度。
4. **加密 CMEC/CENS** 未实现（识别留位）。
5. WebCodecs 路线的渲染复用 core `VideoFrameRenderer`（单一所有权铁律，契约 §6），
   本模块只产 frame 回调不碰画布。
