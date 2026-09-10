# ape —— Monkey's Audio 容器解析与元数据展示
> 状态：✅ 已交付 · 测试 41 例 全绿（node --test ape/__tests__/*.test.js）· MAC descriptor/legacy + APEv1/v2 标签 + 封面拆包；解码降级边界见下文 · 更新 2026-08-26

> 归属：ui-kit-dev　|　契约基线：docs/CONTRACTS.md v0.2（E-8 口径）
> 可行性结论（docs/00-需求与可行性结论.md）：**可纯前端（解码器复杂）**——
> APE 头解析 + 解码 → WebAudio。
> 按 ARCHITECTURE.md 的阶段划分，本模块 Phase 1~2 交付**容器头 + APE TAG 元数据层**；
> 音频解码器为 Phase 3 候选（路线见下文「解码器复杂度与路线」，如实标注，不夸大）。

## 一、格式原理

```
┌──────────────────────────── .ape 文件 ────────────────────────────┐
│ 'MAC ' + version(u16)                                             │
│ ├─ version ≥ 3980：                                               │
│ │   APE_DESCRIPTOR(52B)：nDescriptorBytes/nHeaderBytes/          │
│ │       nSeekTableBytes/nHeaderDataBytes/audioDataLen/.../md5[16]  │
│ │   MAC_HEADER(24B)@nDescriptorBytes：compression formatFlags     │
│ │                     finalFrameBlocks totalFrames bps ch rate    │
│ ├─ version < 3980：旧式头（无 bps/总帧数，块大小按版本推导）        │
│ ├─ 音频帧流（压缩数据，本模块不触碰其内容）                        │
│ ├─ [ID3v1]                                                        │
│ └─ APE TAG footer/header（APETAGEX v1000/v2000，键值元数据+封面）   │
└────────────────────────────────────────────────────────────────────┘
```

## 二、已交付能力

| 能力 | 状态 |
|---|---|
| `probeApe` 静态嗅探（'MAC ' 魔数，confidence 0.9） | ✅ |
| descriptor 形态全字段解析 + 时长换算（µs） | ✅ |
| legacy（<3980）形态：压缩级别/声道/采样率；块大小按公开资料推导 | ✅（帧数未知如实置 null） |
| APEv1/v2 标签定位（footer / 跳过 ID3v1 / 含 header 形态） | ✅ |
| utf8 / binary / locator 三类 item；只读位识别 | ✅ |
| 封面二进制 `<mime>\0<data>` 拆包展示 | ✅ |
| **音频解码** | ❌ Phase 3 |

## 三、解码器复杂度与路线（如实标注）

Monkey's Audio 是预测型无损压缩，解码端需要实现：

1. **逐帧范围编码（Range Coding）熵解码器** —— 与 Rice/Golomb 不同，需维护
   自适应区间状态，出错即级联失步；
2. **自适应预测滤波器组**（按 compression level fast→extra 有 4 档系数集），
   含历史窗口的整数 FIR 与一阶 IIR 混合；
3. 版本间位流差异大（3900/3960/3980 各有布局变化），参考实现的社区资料稀少。

**路线建议**（captain/architect 裁决后执行）：

- 方案 A（推荐）：WASM 移植 —— 以 C 参考解码器编译 wasm，`FlacDecoder` 同样的
  接口位替换进 core player 管线；JS 侧保留本模块做 probe/MediaInfo。
- 方案 B：纯 JS 逐步移植开源解码核心（工作量大，Phase 3+ 评估）。
- 在此之前，demo 提供完整的元信息面板与标签/封面对照，验证容器层的正确性。

## 四、快速开始

```js
import { summarizeApe, findApeTag } from '../src/index.js';

const bytes = new Uint8Array(await file.arrayBuffer());
const { info, tag, cover } = summarizeApe(bytes);
// info: {version:'3990', kind:'descriptor', compressionLevel:'normal',
//        sampleRate, channels, bitsPerSample, durationUs, …}
// tag.items → [{key,value,type,readOnly}]；cover:{mime,data}
```

## 五、已知限制

1. 不解压音频；`samples()` 迭代器待解码内核落地后补齐（接口预留见 CONTRACTS §2.4 ape 行）。
2. legacy 头的 blocksPerFrame 推导基于公开资料整理，极端老文件可能偏差——字段名已标注推断语义。
3. 加密（locked）formatFlags 文件未特殊处理。

---
*ui-kit-dev · 2026-08-25*
