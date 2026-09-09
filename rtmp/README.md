# rtmp

归属与交付标准见根目录 package.json 说明与共享看板《工程约定》。

# rtmp.js —— RTMP 浏览器播放的本质是 WebSocket-FLV（PurePlay · t13/net-dev）

> 纯 ESM · 零构建 · 零第三方运行时依赖 · Node ≥22 与浏览器双端可运行。
> 契约对齐：CONTRACTS §0.5(µs 时间基) / §9(网关 WS 协议) / §10(传输层形状) / §11.3(错误码)。

## 一、可行性结论（docs/00-需求与可行性结论.md，任何人不得推翻）

**浏览器没有 TCP API**：RTMP 的握手与信令跑在 TCP 1935 上，网页里根本发不出这个连接。
因此「浏览器播 RTMP」从来不是实现 RTMP 协议，而是：

```
RTMP 源 ──推流──▶ 网关（转封装为 FLV）──WebSocket 二进制帧──▶ 本模块解析播放
```

即 **WS-FLV 播放器**。延迟量级对照（选型依据）：

| 链路 | 典型延迟 | 说明 |
|------|---------|------|
| HTTP-FLV | 1~3s | 最常见的 RTMP 浏览器方案（flv.js 路线） |
| **WS-FLV（本模块）** | **1~2s** | 同级延迟，但通道可复用 §9 通用网关 |
| WebRTC | 0.2~1s | 最低延迟，需 SDP/ICE 网关（webrtc/ 模块） |

**直连拒绝口径（PRD）**：任何界面输入裸 `rtmp://` 地址都应拒绝执行并展示教育文案
（demo 页已实现）；本模块提供 `resolveSourceUrl()` 把 `rtmp://` 自动映射到网关地址。

## 二、地址映射约定（`src/url.js`，对外契约的一部分）

| 输入形态 | 输出 | 缺省端口规则 |
|----------|------|--------------|
| `ws-flv://host[:port]/app/stream?x=1` | `ws://host:port/app/stream?x=1` | port 缺省 80 |
| `wss-flv://host/path` | `wss://host:443/path` | 缺省 443 |
| `ws://…` / `wss://…` | 原样透传 | — |
| `rtmp://host[:1935]/app/stream` | `ws://host:<gatewayPort>/app/stream.flv` | 1935→8000；自动补 `.flv` |
| `rtmps://host/app/stream` | `wss://host:8000/app/stream.flv` | 同上 |
| `rtmp://…` + `gatewayBase` 选项 | `<base>/<app/stream>`（§9 通道名形态，不加 .flv） | 如 `ws://127.0.0.1:8090/stream/live/cam1` |

以上均可通过选项覆盖：`{ gatewayPort, appendSuffix, gatewayBase }` 或自定义 `urlResolver`。

## 三、架构与数据流

```
┌──────────────────────────── 浏览器 / Node ───────────────────────────┐
│  WsFlvPlayer（状态机 + 断流重连）                                      │
│   ├─ GatewayChunkSource   §9 信令(meta/eos/hello)+背压语义+空闲判定    │
│   │     └─ WebSocket(binary)                                        │
│   ├─ FlvDemuxer           header/Tag/AMF0 → avcC·ASC·样本            │
│   │     └─ 输出边界换算：毫秒 → 整数微秒（§0.5）                       │
│   ├─ Fmp4Remuxer          init segment + moof/mdat 片段              │
│   └─ sink 双管线                                                      │
│         ├─ MSE: appendBuffer(init/frag) → <video>                    │
│         └─ WebCodecs: AVCC→AnnexB → VideoDecoder → Canvas            │
└────────────────▲────────────────────────────────────────────────────┘
                 │ ws://（二进制分块 + JSON 文本信令）
       samples/gateway（ws-flv 推流服务 / §9 通道中继）
```

## 四、快速开始

```bash
# 1) 启动本地网关（内置 H264 循环测试流，程序化生成、真实可解码）
node samples/gateway/bin/gateway.js
#    ws-flv : ws://127.0.0.1:8321/live/test

# 2) 静态服务打开 demo
python3 -m http.server 8080
#    浏览器访问 http://127.0.0.1:8080/rtmp/demo/
```

代码用法（无头消费，Node 可跑）：

```js
import { WsFlvPlayer } from './src/index.js';

const player = new WsFlvPlayer({
  backoff: { baseMs: 500, factor: 2, maxMs: 30000 },
});
player.on('track', (t) => console.log(t.codecString));        // avc1.42c01e
player.on('sample', (s) => console.log(s.dtsUs, s.keyframe)); // µs 时间基
await player.start('ws-flv://127.0.0.1:8321/live/test');
// …停止：player.stop();
```

MSE 渲染（demo 页同款 sink）：

```js
const player = new WsFlvPlayer({
  sink: {
    onInitSegment: (bytes) => sourceBuffer.appendBuffer(bytes),
    onFragment: (bytes) => sourceBuffer.appendBuffer(bytes),
  },
});
```

传输源形状（CONTRACTS §10）：

```js
import { createSource } from './src/index.js';
const source = await createSource({ url: 'ws://127.0.0.1:8321/live/test' });
source.on('data', (chunk) => { /* FLV 字节块 */ });
source.on('meta' | 'eos' | 'stall' | 'error', ...);
```

## 五、ffmpeg 推流示例（对接真实源）

```bash
# RTSP 摄像头 → FLV → ws-flv 网关（-c copy 免转码，延迟最低）
ffmpeg -rtsp_transport tcp -i rtsp://user:pwd@camera/stream \
  -c copy -f flv rtmp://127.0.0.1/live/cam1

# MP4 文件循环推流
ffmpeg -re -stream_loop -1 -i input.mp4 \
  -c copy -f flv rtmp://127.0.0.1/live/vod

# 无 RTMP 服务器的极简链路：直接把 FLV POST 进 §9 通道中继
ffmpeg -re -i rtsp://camera/stream -c copy -f flv \
  'http://127.0.0.1:8090/publish/cam1?meta=%7B%22container%22%3A%22flv%22%7D'
# 订阅端：new WebSocket('ws://127.0.0.1:8090/stream/cam1')
```

## 六、断流重连状态机

```
idle → connecting → playing ⇄ reconnecting → stopped
                                  ↑ failed/error
```

- 触发：WS 关闭/网络错误/首数据超时(`firstDataTimeoutMs`)；
- 退避：指数 `base*factor^n` 封顶 `maxMs`，含抖动；稳定运行 `stableMs`(10s) 后复位；
- eos 缺席的空闲断流：按 §9.2 以 `idleTimeoutMs`(默认 30s) 判定，发 `stall`
  事件但**不断开**——等待上游重推自动续播；
- 错误码（§11.3）：NETWORK_ERROR / TIMEOUT / PARSE_ERROR(尽力恢复不中断) /
  NOT_SUPPORTED(非 AVC/AAC 编码) / ABORTED / STATE_ERROR。

## 七、与 flv/ 模块的复用计划

本模块内置 `FlvDemuxer` 为传输联调自含实现（接口与 vue-dev-2 提案的统一 Demuxer
接口对齐：事件 tracks/sample/metadata）。契约允许后（CONTRACTS 适配壳定稿），
将切换为 `import { FlvDemuxer } from '../flv/src/index.js'` 并删除内置版，
切换点集中在 `src/player.js` 单行构造处。当前 README 即复用计划声明（按派发要求先行注明）。

## 八、API 摘要（`src/index.js` 具名导出）

| 导出 | 说明 |
|------|------|
| `WsFlvPlayer` / `PLAYER_STATES` | 播放器主体 / 状态枚举 |
| `createSource` / `GatewayChunkSource` | §10 传输形状工厂 / 信令+字节流源 |
| `resolveSourceUrl` / `parseWsFlvUrl` / `mapRtmpToGateway` | URL 映射族 |
| `FlvDemuxer` / `avcCodecString` / `parseAudioSpecificConfig` | FLV 解析（自含过渡实现） |
| `Fmp4Remuxer` / `esdsFromAsc` | fMP4 remux（MSE 用） |
| `Backoff` | 退避策略 |
| `PlayerError` / `errors` | §11.3 错误码 |
| `transportName` / `capabilities` | 能力自述 |

## 九、已知限制

- 音频轨支持 AAC（ASC 配置+raw 帧），remux 已就绪；网关测试流当前仅视频；
- 假定无 B 帧（FLV 直播常态），pts≠dts 时告警并按 DTS 直通；
- 直播追帧策略（buffered 超限跳边沿）规划于 M3 与 site 播放器联调时落地。

## 十、测试

```bash
node --test "rtmp/__tests__/*.test.js"   # 显式 glob 形式（终裁#6）
```

35 例覆盖：URL 映射全形态、FLV 解析（元数据/avcC/µs 单调/半包逐字节等价/垃圾前缀嗅探/
损坏容错）、GatewayChunkSource（逐字节一致性/meta 不伪造/eos 合成/stall 保活/回声容忍/
NETWORK_ERROR）、fMP4（init 树/trun 公式/tfdt 递增/esds 注入）、播放器（全管线/sink 接线/
断线重连续流/退避节奏/幂等 stop）。
