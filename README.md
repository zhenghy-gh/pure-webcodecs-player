# 纯前端实现播放器（下一代 ffplay.js 方向）

浏览器沙箱内完成「Container 解析 → Demux → WebCodecs 解码 → Canvas / AudioWorklet 渲染」的完整媒体管线。
零构建、纯 ESM、零第三方运行时依赖。需求与可行性依据见 [docs/00-需求与可行性结论.md](docs/00-需求与可行性结论.md)，
测试与工程约定见 [docs/TESTING.md](docs/TESTING.md)。

## 快速开始

```bash
npm test         # node --test 递归运行全部 __tests__/*.test.{js,mjs}（Node ≥ 22）
npm run demo     # 启动零依赖静态服务器 http://localhost:8080 （支持中文路径 / Range / 目录列表）
npm run lint     # 可选：语法 + 卫生检查（零依赖）
npm run fixtures # 重建各模块落盘 fixture（产物不入库）
npm run gateway  # 本地 WS 测试网关（rtmp/rtsp 桥接联调用）
```

要求 Node.js ≥ 22（`node --test` 的 glob 参数需要 v22+；本仓库开发基线 v22.23.1）。

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

### 测试与覆盖率现状（2026-09-09，第六十一波基线）

全仓 `npm test`（Node ≥ 22，`--test-concurrency=4`）**1142/1142 绿，fail=0、cancelled=0**。

| 层 | 文件数 | 行覆盖均值 | 门槛 | 状态 |
|----|-------|-----------|------|------|
| core 逻辑层 | 20 | 96.3% | ≥85% | ✓ |
| parser 层 | 123 | 95.3% | ≥80% | ✓ |
| env 浏览器层 | 17 | 61.8% | 豁免（仅报告） | — |

> 逻辑层（core + parser）未达标文件已清零；env 层低覆盖为浏览器 API（WebCodecs / Canvas / AudioWorklet / MSE）在 Node 不可测所致，属环境限制而非测试缺失，**不写假测试刷覆盖率**，验证走真机 e2e（`docs/review/i3/`）。
