# rtsp

归属与交付标准见根目录 package.json 说明与共享看板《工程约定》。

# rtsp.js —— WebSocket 中继 RTSP 播放器客户端（PurePlay · t13/net-dev）

> 纯 ESM · 零构建 · 零第三方运行时依赖 · Node ≥22 与浏览器双端可运行。
> 契约对齐：CONTRACTS §0.5(µs 时间基) / §9(网关协议) / §10(传输层形状) / §11.3(错误码)。

## 一、为什么必须 WebSocket 桥接（可行性结论，见 docs/00-需求与可行性结论.md）

浏览器**没有 TCP 套接字 API，也没有 UDP API**：

- RTSP 控制通道是 TCP（默认 554）—— 浏览器无法直连；
- RTP over UDP —— 浏览器完全不可达。

因此纯前端 RTSP 只有桥接形态：

| 形态 | 说明 | 本模块 |
|------|------|--------|
| **WebSocket 中继（interleaved）** | 网关把 `RTSP over TCP` 字节流原样搬到 WS：`$` 块 + 内联响应 | ✅ 默认 |
| **纯 RTP-over-WS** | 控制面带外（HTTP 下发 SDP），每条 WS 二进制消息=一个 RTP 包 | ✅ |
| RTSP→WebRTC 网关 | 完整 SDP/ICE 协商网关 | `webrtc/` 模块路线 |

## 二、架构与数据流

```
┌────────────────────────── 浏览器 ──────────────────────────┐
│  RtspWsClient / RtspChunkSource(createSource)              │
│   ├─ WebSocket(binary)                                     │
│   ├─ 帧协议层 InterleavedWireParser($块+内联响应,半包安全)   │
│   ├─ parseRtp(RFC3550: V/P/X/M/PT/seq/ts/SSRC/CSRC/pad)    │
│   ├─ H264Depacketizer(RFC6184: 单包/STAP-A/B/FU-A)          │
│   ├─ H265Depacketizer(RFC7798: 单包/AP/FU/DONL)             │
│   └─ 输出 {annexB, keyframe, dtsUs/ptsUs} → WebCodecs      │
└──────────────▲─────────────────────────────────────────────┘
               │ ws:// (binary)
┌──────────────┴────────────── 网关侧 ───────────────────────┐
│ samples/gateway/src/server-rtsp.js（模拟中继，协议见其 README）│
└────────────────────────────────────────────────────────────┘
```

## 三、快速开始

```bash
node samples/gateway/bin/gateway.js        # 或 node samples/gateway/mock-rtsp-relay.js
# interleaved : ws://127.0.0.1:8322/rtsp
# 纯 RTP      : ws://127.0.0.1:8322/rtp?mode=passive
# SDP(HTTP)   : http://127.0.0.1:8322/sdp
python3 -m http.server 8080   # 浏览器打开 http://127.0.0.1:8080/rtsp/demo/
```

播放器级用法（完整握手 + 自动重连）：

```js
import { RtspWsClient } from './src/index.js';

const client = new RtspWsClient({ url: 'ws://192.168.1.64:8322/rtsp', framing: 'interleaved' });
client.on('sdp', ({ track }) => { /* track.codec: 'h264'|'h265'，parameterSets 已解出 */ });
client.on('frame', (f) => {
  // f.dtsUs/f.ptsUs：整数微秒（契约 §0.5）；f.ptsMs 为迁移期兼容别名
  decoder.decode(new EncodedVideoChunk({ type: f.keyframe ? 'key' : 'delta',
                                          timestamp: f.ptsUs, data: f.annexB }));
});
await client.start();
```

传输源形状（CONTRACTS §10：`createSource(...) => Promise<ChunkSource-like>`）：

```js
import { createSource } from './src/index.js';

const source = await createSource({ url: 'ws://gw:8322/rtsp' });
// source.meta = { container:'rtsp', codec:'h264', bitstreamFormat:'annexb', live:true, ... }
source.on('data', (annexBBytes, { ptsUs, keyframe }) => { /* 一帧一个 chunk */ });
source.on('meta' | 'error' | 'end' | 'reconnecting', ...);
```

## 四、帧协议文档（与 samples/gateway 对齐）

### 4.1 interleaved 模式（`ws://host:port/rtsp`）

一条 WS 连接承载与「RTSP over TCP」完全相同的字节语义：

- **入站**：RTSP 请求文本（OPTIONS/DESCRIBE/SETUP/PLAY/PAUSE/TEARDOWN），一条消息一个请求；
- **出站**：RTSP 响应为原始报文文本字节；媒体为 `$` interleaved 块：

```
+---------+---------+------------------+---------+
| '$'(24) | channel | length(2B 大端)   | payload |
+---------+---------+------------------+---------+
            channel 偶数=RTP，奇数=RTCP(SR)
```

客户端按首字节是否 `$` 区分两类单元，解析逻辑与 TCP 模式一致。
信令序列 OPTIONS→DESCRIBE(SDP)→SETUP(Session)→PLAY(RTP-Info)；未 SETUP 先 PLAY → `455`。
每条连接会话状态独立，断线重连必须重新走全握手（客户端已实现）。

### 4.2 纯 RTP-over-WS 模式（`ws://host:port/rtp?mode=passive`）

无信令；连接即推流；一包一消息（RTP 头无长度字段，不做拼接约定）；SDP 经
`GET /sdp` 带外获取（选项 `sdp` 文本或 `sdpUrl` 自动 fetch）。适用于「RTP→WS」薄搬运网关。

### 4.3 SDP 关键字段（RFC 4566/6184/7798）

```
a=rtpmap:96 H264/90000
a=fmtp:96 packetization-mode=1;profile-level-id=42c01e;sprop-parameter-sets=<b64 SPS>,<b64 PPS>

a=rtpmap:96 H265/90000
a=fmtp:96 sprop-max-don-diff=2;sprop-sps=<b64>;sprop-pps=<b64>     （sprop-vps 可在会话级）
```

`sprop-max-don-diff>0` ⇒ 启用 DONL（AP 首条目/FU 首分片前置 2B DONL，本实现解析后丢弃）。
属性分隔符同时兼容 `:`（rtpmap/fmtp）与 `=`（sprop-*）两种形态。

### 4.4 depacketize 覆盖矩阵

| H264(RFC6184) | 支持 | H265(RFC7798) | 支持 |
|---|---|---|---|
| 单 NAL 包(1~23) | ✅ | 单 NAL 包 | ✅ |
| STAP-A(24) | ✅ | AP(48) | ✅ |
| STAP-B(25,跳过DON) | ✅ | FU(49) | ✅ |
| FU-A(28) | ✅ S/E 重组+丢包容错 | DONL | ✅ 解析并跳过 |
| FU-B(29)/GIFF | ❌（实际设备极少用，路线图） | PCI(50) | ❌ |

容错语义：序号回绕安全比较；迟到/重复包丢弃；FU 中段断流即弃半成品并等待下一个 S 位；
丢包计数进 `stats.lost`。

## 五、API 摘要（`src/index.js` 具名导出）

| 导出 | 说明 |
|------|------|
| `RtspWsClient` | 播放器主体（连接/握手/收流/退避重连状态机） |
| `createSource` / `RtspChunkSource` | §10 传输形状：meta + AnnexB AU 流 |
| `Backoff` / `STATES` | 指数退避策略 / 状态枚举 |
| `parseSdp` / `pickVideoTrack` / `parseFmtpParams` / `b64ListToNals` | SDP 解析族 |
| `parseRtp` / `seqNewer` | RTP 头解析 / 回绕安全序号比较 |
| `H264Depacketizer` / `H265Depacketizer` | 重组器 |
| `InterleavedWireParser` / `parseResponse` | $ 块+内联响应切分（半包/粘包安全） |
| `toAnnexb` / `fromAnnexb` / `avccToNals` / `nalsToAvcc` | NAL 封装互转 |
| `PlayerError` / `errors` | §11.3 封闭错误码（NETWORK_ERROR/TIMEOUT/STATE_ERROR…） |
| `transportName` / `capabilities` | §10 能力自述 |

事件：`open/state/sdp/frame/close/error`（Client）、`meta/data/error/end/reconnecting`（Source）。

## 六、已知限制与路线

- 仅视频轨（音频 AAC/Opus 的 RTP 载荷未实现）；抖动处理为低延迟策略（迟到即弃，无重排窗）；
- H265 WebCodecs 解码依赖浏览器能力，demo 以 H264 演示；
- RTCP 目前仅解析信道计数（SR 内容未消费），后续补 NACK/PLI 反馈；
- 与 core 的复用（nal 工具/codec-string/errors）：并行期自含最小实现，core 稳定后按看板波次切换。

## 七、测试

```bash
node --test "rtsp/__tests__/*.test.js"   # 显式 glob 形式（终裁#6）
```

32 例覆盖：SDP(H264/H265/DONL/双分隔符)、RTP 全字段+padding+CSRC+扩展头、
FU-A/STAP-A/STAP-B/AP/FU/DONL 重组与丢包容错、interleaved 半包/粘包、
四条端到端链路（握手收流/纯 RTP/断线重连/chaos 丢包恢复）、§10 createSource 形状与错误码。
