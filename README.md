# 纯前端实现播放器（下一代 ffplay.js 方向）

浏览器沙箱内完成「Container 解析 → Demux → WebCodecs 解码 → Canvas / AudioWorklet 渲染」的完整媒体管线。
零构建、纯 ESM、零第三方运行时依赖。需求与可行性依据见 [docs/00-需求与可行性结论.md](docs/00-需求与可行性结论.md)，
测试与工程约定见 [docs/TESTING.md](docs/TESTING.md)。

## 效果演示

**🌐 在线演示（免克隆直接玩）：<https://zhenghy-gh.github.io/pure-webcodecs-player/>**

真实 Chrome 无头驱动本仓库代码的实拍（非效果图）——**WebCodecs 主路线**：TS 流 → 解复用 →
`VideoDecoder` 真实解码 → Canvas 渲染，下方日志为 15 步端到端自断言全部 PASS：

<p align="center">
  <img src="docs/demo/demo-webcodecs.gif" alt="WebCodecs 主路线真实解码播放 Big Buck Bunny（含 seek 与端到端断言日志）" width="720" />
</p>

| MP4 渐进播放（MSE 路线，Sintel 预告片） | 演示站（16 模块 demo 入口） |
|---|---|
| <img src="docs/demo/demo-mp4-mse.png" width="430" /> | <img src="docs/demo/demo-hub.png" width="430" /> |

> 采集方法：`scripts/e2e/`（playwright 驱动系统 Chrome）+ 素材 `samples/e2e/`（bbb480_30s.ts / sintel-trailer.mp4），均来自真实运行中的页面；复现命令见下文「真机端到端验收」。

## 快速开始

```bash
npm test         # node --test 递归运行全部 __tests__/*.test.{js,mjs}（Node ≥ 22）
npm run demo     # 启动零依赖静态服务器 http://localhost:8080 （支持中文路径 / Range / 目录列表）
npm run lint     # 可选：语法 + 卫生检查（零依赖）
npm run fixtures # 重建各模块落盘 fixture（产物不入库）
npm run gateway  # 本地 WS 测试网关（rtmp/rtsp 桥接联调用）
```

要求 Node.js ≥ 22（`node --test` 的 glob 参数需要 v22+；本仓库开发基线 v22.23.1）。

## 使用方式

### 1. 浏览器直接体验（推荐先跑这个）

**无需克隆，在线直接玩**：**[https://zhenghy-gh.github.io/pure-webcodecs-player/](https://zhenghy-gh.github.io/pure-webcodecs-player/)**（GitHub Pages，随 main 分支自动更新；演示站、mp4/mse、音频、字幕、HLS 等 demo 全部可用，本地文件拖进页面，数据不离开浏览器）。

想在本地跑也一样简单：

```bash
git clone https://github.com/zhenghy-gh/pure-webcodecs-player.git
cd pure-webcodecs-player
npm run demo        # 启动零依赖静态服务器（支持中文路径 / HTTP Range / 目录列表）
```

> `npm run demo` 启动的是**你本机**的服务器，下面出现的 `localhost` 地址只在你自己的浏览器里有效。不想折腾就直接用上面的在线链接。

然后在**本机浏览器**打开：

- `http://localhost:8080/site/demo/` —— **演示站**，16 个模块的 demo 入口卡片
- 例：`http://localhost:8080/mp4/demo/` 把本地 `.mp4` 拖进页面即可播放——**数据不离开浏览器**，全部本地解复用 + 重封装 + MSE 解码
- 音频（wav / flac / ape）、字幕、HLS、WebTorrent 等同理，入口见演示站

### 2. 代码集成：`createPlayer` 一条龙（推荐）

```js
import { createPlayer, registerDemuxer } from './core/src/index.js';
import * as mp4Mod from './mp4/src/index.js';
import * as tsMod from './ts/src/index.js';

// 宿主注册容器模块（生产协议），URL 自动探测容器并选路
registerDemuxer(mp4Mod);
registerDemuxer(tsMod);

const player = await createPlayer({
  url: 'https://example.com/movie.mp4',
  canvas: document.getElementById('stage'),      // WebCodecs 路线；MSE 路线改传 mediaElement: <video>
  routePreference: ['webcodecs', 'mse'],          // 能用 WebCodecs 就不落 MSE
});

await player.load();
await player.play();                              // 起播前向缓冲 3s 后出水
player.on('firstframe', () => console.log('首帧已出'));
player.on('error', (e) => console.error(e.code, e.detail));

await player.seek(20_000_000);                    // seek 20s（整数 µs，关键帧对齐）
await player.selectTrack('audio', 1);             // 切音轨
await player.destroy();                           // 幂等释放解码器与元素
```

### 3. 底层 API：Demuxer / DataSource 直用

只要解复用不要播放管线时（如转码器、编辑器、元数据提取）：

```js
import { Mp4Demuxer, HttpRangeDataSource } from './mp4/src/index.js';

const demuxer = new Mp4Demuxer(
  new HttpRangeDataSource('https://example.com/movie.mp4'),  // 256KB 分块 LRU 缓存
);
const info = await demuxer.open();     // → MediaInfo（轨道/时长/seekable），同时 emit 'media-info'
for (const t of info.tracks) console.log(t.type, t.codec, t.width ?? `${t.sampleRate}Hz`);

const sample = await demuxer.readSample(info.tracks[0].id);  // pull 主通道；EOS → null
// sample: { trackId, codec, timestamp(整数µs), duration, data, keyframe }

await demuxer.seek(20_000_000);        // → { actualTimestampUs }；无索引容器 reject SEEK_UNSUPPORTED
await demuxer.destroy();               // 幂等
```

所有容器/传输模块 API 同构（同一基类契约）：`hls`（m3u8 + 分片）、`mkv`（EBML）、
`webtorrent`（`createSource` P2P 边下边播）、`rtmp`/`rtsp`（WS 网关桥接）等，
形状与差异见各模块 README 与 [docs/CONTRACTS.md](docs/CONTRACTS.md)。

### 4. 真机端到端验收

```bash
node scripts/e2e/run.mjs                  # TS 素材 / WebCodecs 主路线（15 步自断言）
node scripts/e2e/run.mjs --media=/samples/e2e/sintel-trailer.mp4 --seekUs=20000000   # MP4 素材（含 seek）
```

真实系统 Chrome + 真实 WebCodecs 跑完 `load → 首帧 → 播放推进 → seek → stats → destroy` 全链路。

> 素材说明：`samples/e2e/`（约 32MB 媒体文件）**不入库**，克隆后默认路径为空。可把自己的 `.ts` / `.mp4` / `.flac` / `.mkv` 文件放进 `samples/e2e/` 后用 `--media=/samples/e2e/文件名` 指定（TS 无索引会按契约判不可 seek，属预期行为）。

## 统一管线

```
输入(File/HTTP Range/WebSocket/WebRTC)
        │
  Container/Demuxer（各模块自研解析）
        │
  EncodedVideo/AudioChunk
        │
    WebCodecs 解码
        │
  Canvas / WebGPU ＋ AudioWorklet 渲染
```

- RTMP / RTSP 浏览器不可直连（无 TCP/UDP API），落地形态为 WebSocket 网关桥接或转 WebRTC。

## 模块状态表

> 状态取值：`未开始` / `进行中` / `待评审` / `已完成`。本表已按 2026-09-09 第二轮评审现状更新；运行时以各模块 README、测试与 demo 为准。

| 模块 | 目录 | 负责人 | 状态 | 说明 |
|------|------|--------|------|------|
| 公共内核 | `core/` | captain | 已完成 | 字节序/EBML/ISO-BMFF 公共工具、统一 Demuxer/Player 基础与渲染适配 |
| MOV | `mov/` | captain | 已完成 | ISO-BMFF 解析 → HTTP Range/File |
| MP4 | `mp4/` | captain | 已完成 | fMP4/CMAF 分片 → MSE 或 WebCodecs |
| FLV | `flv/` | vue-dev-2 | 已完成 | HTTP-FLV Tag 解析 → MSE |
| HLS | `hls/` | vue-dev-3 | 已完成 | m3u8 解析 + TS/fMP4 分片 → MSE |
| CMAF | `cmaf/` | vue-dev-3 | 已完成 | 低延迟分片（LL 流媒体方向） |
| TS | `ts/` | vue-dev-2 | 已完成 | PAT/PMT/PES → H264/AAC |
| MKV | `mkv/` | vue-dev-1 | 已完成 | EBML 解析 → WebCodecs |
| WAV | `wav/` | captain | 已完成 | RIFF → AudioWorklet/WebAudio |
| FLAC | `flac/` | captain | 已完成 | FLAC 解码 → AudioWorklet |
| APE | `ape/` | captain | 已完成 | APE 头解析 + 解码（复杂度高） |
| 字幕 | `subtitle/` | captain | 已完成 | ASS/SSA/SRT/VTT 解析渲染 |
| WebTorrent | `webtorrent/` | vue-dev-1 | 已完成 | torrent → piece → mp4，P2P 边下边播 |
| WebRTC | `webrtc/` | vue-dev-3 | 已完成 | webrtc:// 信令 → RTCPeerConnection |
| RTMP 桥 | `rtmp/` | captain | 已完成 | WebSocket 网关桥接（WebSocket-FLV 形态） |
| RTSP 桥 | `rtsp/` | captain | 已完成 | WS 中继（interleaved/RTP over TCP）或 WebRTC 网关 |
| 共享皮肤 | `site/` | designer/ui-kit-dev | 已完成 | 各模块 demo 共用样式与组件 |
| 测试样例 | `samples/fixtures/` | sdet | 已完成 | 程序化 fixture 生成器库（见 docs/TESTING.md） |

> 状态依据当前源码、模块测试与 demo 文件实盘核对；桥接模块的“已完成”仅表示浏览器可行的 WebSocket/WebRTC 适配形态，不表示浏览器原生直连 RTMP/RTSP。

## 交付标准（每个模块统一）

1. `README.md`：协议原理、浏览器可行性、ASCII 架构图、快速开始、API、已知限制
2. `src/`：纯 ESM JavaScript，入口 `index.js`，中文注释，不引第三方运行时依赖
3. `demo/index.html`：可静态服务的最小演示页，复用 `site/` 共享皮肤
4. `__tests__/`：`node --test` 可运行的解析层单测；fixture 一律由 `samples/fixtures/` 程序化生成，不依赖外网与大文件
5. 质量门禁：全仓测试通过；demo 打开无未捕获异常；reviewer 评审通过；qa 按 PRD 验收

## 质量门禁与工程化

仓库已接入完整的契约对齐、覆盖率门禁与持续迭代机制（详见 [docs/CONTRACTS.md](docs/CONTRACTS.md)、[docs/review/iteration-backlog.md](docs/review/iteration-backlog.md)）：

- **单仓库 monorepo**：`pure-webcodecs-player` 一个仓库承载全部 16 模块（mp4/mov/cmaf/mkv/ts/flv/hls/wav/flac/ape/subtitle/webtorrent/webrtc/rtsp/rtmp/core），模块间直接 `import core`，拆仓即断链。
- **CI**：[`.github/workflows/ci.yml`](.github/workflows/ci.yml)（Node 22）——`lint → check(16/16 模块门槛) → test → 结构层 §2.4 审计 → 运行时 §2.4 审计` 五段全绿。
- **分层覆盖率门禁**：[`scripts/audit/coverage-gate.mjs`](scripts/audit/coverage-gate.mjs)——`env` 浏览器依赖层豁免（Node 不可测）、`core` 逻辑层 ≥85%、`parser` 层 ≥80%，未达标 CI 失败。
- **契约审计**：[`scripts/audit/contract-2-4-audit.mjs`](scripts/audit/contract-2-4-audit.mjs)（结构层 §2.4，应为 0 问题）+ [`runtime-2-4-audit.mjs`](scripts/audit/runtime-2-4-audit.mjs)（7 个 demuxer 运行时矩阵），对齐 [docs/CONTRACTS.md](docs/CONTRACTS.md) §2.4 八项契约。
- **迭代扫描器**：[`scripts/audit/iteration-scan.mjs`](scripts/audit/iteration-scan.mjs)（聚合 git / lint / check / 双契约审计 / 覆盖率 / backlog，末行自动建议下一波），驱动「每波一项、数据驱动、跨会话可续」的长期优化。

### 测试与覆盖率现状（2026-09-09，第六十三波基线）

全仓 `npm test`（Node ≥ 22，`--test-concurrency=4`）**1144/1144 绿，fail=0、cancelled=0**。

| 层 | 文件数 | 行覆盖均值 | 门槛 | 状态 |
|----|-------|-----------|------|------|
| core 逻辑层 | 20 | 96.3% | ≥85% | ✓ |
| parser 层 | 123 | 95.3% | ≥80% | ✓ |
| env 浏览器层 | 17 | 61.8% | 豁免（仅报告） | — |

> 逻辑层（core + parser）未达标文件已清零；env 层低覆盖为浏览器 API（WebCodecs / Canvas / AudioWorklet / MSE）在 Node 不可测所致，属环境限制而非测试缺失，**不写假测试刷覆盖率**，验证走真机 e2e（`docs/review/i3/`）。
