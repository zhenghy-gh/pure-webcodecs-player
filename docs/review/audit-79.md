# 审计报告 · 第 79 波前迭代（纯前端媒体播放器）

- 审计范围：16 个模块（`core mp4 mov mkv ts flv hls cmaf webrtc webtorrent rtsp rtmp ape flac wav subtitle`）的 `src/`，不含 `samples/`、`scripts/`、`site/`、`.smoke/`、`.tmp/`、测试文件与 `errors.js` 良性文案。
- 方法：用 Grep 工具（ripgrep）做内容检索，`Read` 读源码，`Glob` 列文件；行数/测试例用 `find`+`wc`+`grep`（已规避中文路径下 `grep` 的假阴性）。**只读**，未修改任何源码/测试/文档，未执行 git 写操作、未 `npm install`。
- 测试口径：测试文件位于各模块根 `$m/__tests__/*.test.js`，用 `node:test`（`import { test, describe } from 'node:test'`）。测试例数按 `test(`/`it(`/`t.test(` 统计（未计 `describe` 分组），为近似值。

---

## A. 真实技术债

扫描 `TODO/FIXME/HACK/XXX/占位/空实现/异常吞掉` 等标记，逐条分类如下。

| 位置 | 现象 | 分类 | 严重度 |
|---|---|---|---|
| `ape/src/mac-parser.js:69` `let p = 32;`；`:94` `audioOffset: 32+24` | 假定 APE_DESCRIPTOR 仅 26 字节、MAC_HEADER 从 offset 32 起。真实格式 descriptor 为 44 字节（见 C-1）。**实为确凿 bug**（归入 C-1），此处标记其"看似有意、实为错"。 | 真实缺陷 | 高 |
| `webtorrent/src/bencode.js:182` `void bytes; // 占位` | `bencode` 的 `bdecode` 路径里一个语义占位参数，无实际作用，属死代码/未实现语义。 | 真实缺陷（轻） | 低 |
| `rtsp/src/source.js:104`、`rtmp/gateway-source.js:64/77/102`、`rtmp/player.js:289`、`rtsp/client.js:156` | 普通数据流/`ws.close()` 路径上的 `catch {}` 静默吞异常，可能掩盖真实错误（非纯 teardown）。 | 真实缺陷（防御过度） | 中 |
| `core/src/player.js:342-343`、`core/src/player.js:520` | `destroy()` 与状态机切换里的 `catch {}`，位于销毁/容错路径，属可接受防御。 | 有意设计约束 | 低 |
| `mp4/src/box-builder.js:467/:477/:496`、`flv/src/iso-bmff.js:280`、`hls/src/fmp4-muxer.js:344` | `buildTrun` 的 `dataOffsetPlaceholder`/两遍构造：先以占位 `data_offset` 生成 moof，量得长度后回填。 | 有意设计约束 | 无 |
| `wav/src/riff-parser.js:130`、`hls/src/decrypter.js:102`、`flv/codec-info.js:190`、`flv/flv-parser.js:246`、`mp4/demuxer.js:213`(`'XXX'` 语言哨兵)、`rtmp/flv-demuxer.js:211/252`、`ts/nalu.js:378`、`ts/ts-stream-engine.js:367`、`mp4/remuxer.js:168`、`mkv/codecs.js:17`、`mov/atom-compat.js`、`ts/ts-demuxer.js:74` | 大量「暂不支持/占位/空编辑」文案，均为已通过 `notSupported()` 或契约文档显式声明的**不支持能力**，不是缺陷。 | 有意设计约束 | 无 |
| `flac/src/metadata.js:124` `// 暴露该缺陷，此处按规范最小修正` | 注释记录历史缺陷已按规范最小修正（SEEKTABLE 占位/乱序/残尾），当前实现已正确。 | 已修复（留存注释） | 无 |
| `mkv/src/schema.js:112` `DiscardPadding: 0x75a2` | 历史曾把 `DiscardPadding` 写成 `0x75a2`、把 `BlockAdditions` 写成 `0x75A1` 的"交换"缺陷。**当前 schema 已与 RFC 9559 完全一致**（`BlockAdditions=0x75A1`、`BlockMore=0xA6`、`BlockAddID=0xEE`、`DiscardPadding=0x75A2`）。 | 已修复（已核对规范） | 无 |

**结论**：真正的技术债很少且多为低/中（死参数、个别过度静默的 `catch`）；绝大多数标记是有意的设计约束。最值得关注的是 APE 偏移（见 C-1）。

---

## B. 测试密度与盲区

### 各模块 src 行数 / 测试文件 / 测试例（测试例已排除 `describe` 分组，近似）

| 模块 | src 行数 | 测试文件 | 测试例 | 行/例 |
|---|---:|---:|---:|---:|
| ape | 326 | 6 | 63 | 5.2 |
| core | 5706 | 22 | 161 | **35.5** |
| cmaf | 927 | 7 | 53 | 17.5 |
| flac | 1389 | 10 | 116 | 12.0 |
| flv | 2251 | 7 | 54 | **41.7** |
| hls | 3404 | 14 | 108 | 31.5 |
| mkv | 2425 | 9 | 118 | 20.5 |
| mov | 392 | 4 | 30 | 13.1 |
| mp4 | 2294 | 11 | 69 | 33.3 |
| rtmp | 1468 | 9 | 84 | 17.5 |
| rtsp | 1397 | 12 | 93 | 15.0 |
| subtitle | 2103 | 12 | 168 | 12.5 |
| ts | 2480 | 8 | 73 | **34.0** |
| wav | 1205 | 7 | 72 | 16.7 |
| webrtc | 1052 | 6 | 58 | 18.1 |
| webtorrent | 1403 | 6 | 88 | 15.9 |

### 测试密度最低（行/例 最高）的 3 个模块 + 各自行数最大的 2 个源文件

1. **flv**（41.7 行/例）——最可能藏未测逻辑的大文件：
   - `flv/src/flv-demuxer.js`（615 行）
   - `flv/src/iso-bmff.js`（298 行）
2. **core**（35.5 行/例）——体量最大、管线/状态机复杂：
   - `core/src/pipeline-webcodecs.js`（534 行）
   - `core/src/player.js`（523 行）
3. **ts**（34.0 行/例）——TS/PES/时钟域易错：
   - `ts/src/ts-stream-engine.js`（732 行）
   - `ts/src/ts-demuxer.js`（536 行）

> 说明：`mp4`（33.3）、`hls`（31.5）紧随其后，同样值得加强。以上"测试例"为近似值，因 `describe` 嵌套用例未被逐一展开；相对排序不受此影响。

---

## C. 潜在真实缺陷（定向审查，确凿 bug）

### C-1 【高】APE 容器头偏移错误——真实文件全字段错位（被自洽 fixture 掩盖）
- **现状代码**
  - `ape/src/mac-parser.js:63-95`：`if (version >= 3980)` 分支在 offset 6 读了 6 个长度字段后，`let p = 32;` 直接从 offset 32 开始读 `compression/flags/blocksPerFrame/finalFrameBlocks/totalFrames/bps/channels/sampleRate`，并 `audioOffset: 32 + 24`(=56)。
  - 注释 `:6` 称 "DESCRIPTOR（32B）"，但实际 APE_DESCRIPTOR（v≥3980）结构为：`nDescriptorBytes(4) nHeaderBytes(4) nSeekTableBytes(4) nHeaderDataBytes(4) nAPEFrameDataBytes(4) nAPEFrameDataBytesHigh(4) nTerminatingDataBytes(4) cFileMD5[16]` —— 共 **44 字节**（ffmpeg `libavformat/ape.c` 的 `APEContext`、audiotools `ape.py` 均印证）。
- **为何错**：真实 MAC_HEADER 起始于 offset **6 + 44 = 50**（而非 32），落后约 18 字节。于是 `compressionCode/flags/channels/sampleRate/totalFrames/blocksPerFrame` 全部从 descriptor 尾部的 `nTerminatingDataBytes`+`md5` 区域读取 → 得到**乱码元数据**；`totalSamples/durationUs` 与 `audioOffset` 也全错，真实 APE 文件无法定位音频、时长错误。`ape/__tests__/ape.test.js` 的 fixture 按同一错误布局自造（`descriptorLen` 填在 offset 6、`headerLen` 在 10、header 在 32），故单测全过、掩盖了真实缺陷。
- **建议修法**：不要硬编码 32，改用 descriptor 自身字段定位头部——读 `nDescriptorBytes`（offset 6）与 `nHeaderBytes`（offset 10），或显式跳过 20 字节（`nTerminatingDataBytes` 4 + `md5` 16）后读 MAC_HEADER；`audioOffset` 改为 `descriptorEnd + 24 + seekTableLen + waveHeaderLen`（取 descriptor 内各长度字段）。建议补一个**真实 APE 文件字节向量**的 conformance 测试（而非程序化自造 fixture）。

### C-2 【中】CMAF `findTimescales` 按出现顺序假定"第 1 个 mdhd=视频、第 2 个=音频"
- **现状代码** `cmaf/src/chunk-parser.js:194-211`：扫描 init segment 中全文件的 4 字节 `'mdhd'` 子串，第一个命中写入 `result.video`、第二个写入 `result.audio`；随后 `:186`/`189` 直接 `timescales.video ?? 90000`、`timescales.audio ?? 48000`。
- **为何错**：
  1. **顺序假设错误**：moov 内 trak 顺序不保证视频在前；若音频 trak 在前、或多视频轨，会把音频 timescale 当作视频（如 48000 当 90000），时间戳换算 systemic 错误。
  2. **子串误命中**：在整个 init segment 字节上匹配字面 `'mdhd'`，解码配置（avcC/esds/hvcC）或任意二进制里若出现该 4 字节，会被当作一个 mdhd 并读出一个 `0<ts<0xffffffff` 的伪 timescale，污染 video/audio 取值。
- **建议修法**：从 moov 的 `trak→mdia→mdhd` 树结构解析，按 trak 的 `tkhd`/handler（`vide`/`soun`）把 timescale 关联到具体轨；不要在全文件做 4 字节字面扫描。该函数在 `parseInitSegment` 被调用，影响 HLS/CMAF 全流程时间戳。

### C-3 【低–中】字幕时间轴分数域 >3 位时被放大 10 倍
- **现状代码** `subtitle/src/time.js:45`：`ms = frac === '' ? 0 : Number.parseInt(frac.padEnd(3, '0'), 10);` 然后 `:46` 返回 `(... * 1000 + ms) * 1000`。
- **为何错**：`padEnd(3,'0')` 只补不截。若分数域为 `.1234`（4 位，=0.1234s=123.4ms），`parseInt('1234')=1234` → 当作 1234ms，**放大 ~10 倍**。主流 SRT/VTT 用 3 位毫秒故通常不触发，但非标准/高精度字幕会错。
- **建议修法**：取前 3 位再解析：`frac.slice(0,3).padEnd(3,'0')`，或对多余位做四舍五入而非截断。

### C-4 【低】flv fmp4-remuxer 非 flush 切片末帧 duration=0
- **现状代码** `flv/src/fmp4-remuxer.js:91-96`（视频帧 duration 由下一帧 DTS 回填）、`:120-122`（达到 `fragmentUs` 即 `cut`）、`:133-138`（`duration: s.durationTicks ?? 0`）。触发 `cut` 的那一帧其 `durationTicks` 仍为 `null` → 写入 0。
- **为何错**：每个片段的最后一帧时长为 0，部分 MSE/sample 计会按 0 处理（虽可由下一片段 `tfdt` 连续性兜底，但属脆弱实现）。
- **建议修法**：`cut` 前对末帧做一次与下一预期帧的时长估算（或沿用上一帧时长），与 `flush()` 的回填逻辑统一。

> 已**核对非缺陷**的项（避免误报）：mkv `schema.js` 的 `DiscardPadding/BlockAdditions/BlockMore` 现已与 RFC 9559 一致；`ts/src/pes.js` 的 33bit `decodeTimestamp5`/`encodeTimestamp5` 编解码互验正确；`ts/src/bits.js` 的 33bit `unwrapTimestamp` 与 `ts-stream-engine.js:699` 回绕处理正确；`flac/src/frame-header.js:122` 采样率码 12 的 `readBits(8)*1000` 与 libFLAC 一致；`flac/src/metadata.js:109` 36bit `totalSamples` 计算因 `>>>0` 仅作用于低 32 位、高 4 位加法在 Number 安全整数内，结果正确；`core/src/bit-reader.js` `readBits` 限 ≤32 位且 `>>>0` 收口，安全。

---

## D. 死代码与重复实现

### 重复实现（多模块各自实现同一功能）
1. **`BitReader` ×4**：`core/src/bit-reader.js:7`、`flac/src/bit-reader.js:9`、`ts/src/bits.js:9`、`flv/src/bits-lite.js:6`。四个按位读取器，行为约定不完全一致（如 `bits-lite` 是否支持 `peek`/`alignToByte`），长期会漂移。
2. **`BitWriter` ×2**：`flac/src/bit-reader.js:109`、`ts/src/bits.js:89`。
3. **`buildEsds`（ESDS 描述符构造）×2**：`mp4/src/box-builder.js:185` 与 `hls/src/fmp4-muxer.js:231`。同一 MP4 `esds` box 构造逻辑两处实现，修改需同步。
4. **`u32`/小端写入 helper 散落**：`flv/src/iso-bmff.js:66`、`hls/src/fmp4-muxer.js`（多处 `u32`）、`mp4/src/box-builder.js` 各自有 `writeU32`/`u32`，未统一到 `core/src/byte-stream.js` 的 `ByteWriter`（`:254`）。
   - 注：`crc` **不是**重复——`ts/src/psi.js:13` 的 MPEG-TS CRC32（poly `0x04C11DB7`）与 `flac/src/crc.js:26/:50` 的 CRC8/CRC16 是各格式专用算法，应保留独立。

### 死代码 / 未引用导出（已用 Grep 全仓逐一核对）
- `mp4/src/box-builder.js:225` `export function buildBtrt(...)`：全仓仅定义、无任何调用（box-builder 内仅用 `buildEsds`）。属未接线的死导出（低）。
- `wav/src/waveform.js` 的 `computePeaks`/`drawWaveform`（`:15`/`:49`）、`rtsp/src/b64.js` 的 `b64ToBytes`、各 `parseAvcConfig`/`parseHevcConfig`/`parseAscInfo`/`unwrapTimestamp`/`interpretEdits`/`findTimescales`/`buildTrun`/`crc8`/`crc16` 等均**有引用**（非死代码）——已核对，避免误报。
- 未发现"定义了全仓无引用"的大规模死模块；疑似死代码主要集中在零散未接线的小 helper（如 `buildBtrt`）。

---

## 建议的下一步 Top 5（按 价值/风险 排序）

1. **修 C-1 APE 头偏移 + 补真实文件 conformance 测试**（高价值/高风险：一个整格式解析在真实文件上整体错误，且被自洽 fixture 长期掩盖；修复成本低、影响确定）。
2. **修 C-2 CMAF `findTimescales` 按 trak 树关联 timescale**（高价值：影响 HLS/CMAF 主链路的时间戳正确性，覆盖音视频顺序非常规或非单音视频的流）。
3. **收敛重复实现**：把 4 份 `BitReader`、2 份 `BitWriter`、2 份 `buildEsds` 统一到 `core`（中价值/中风险：降低漂移与回归，避免"改一处漏一处"）。
4. **把自造 fixture 替换为真实样本向量的 conformance 测试**（高价值：本审计发现 APE 缺陷正源于"程序化自造 fixture 与解析器同一错误布局"，需在 `ape`/`cmaf`/`mp4` 引入真实文件字节向量）。
5. **对密度最低 3 模块（flv/core/ts）补边界用例**（中价值：补 33bit 回绕、零/NaN timescale、`sampleRate=0`、>3 位字幕分数、空 `catch` 错误传播等边界；同时处理 C-3/C-4 两个确凿小 bug）。
