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

> 状态取值：`未开始` / `进行中` / `待评审` / `已完成`。本表已按 2026-09-07 第二轮评审现状更新；运行时以各模块 README、测试与 demo 为准。

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
