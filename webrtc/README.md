# webrtc —— WebRTC 低延迟播放器（WHEP 标准信令 + 自定义信令适配点）

> 纯 ESM、零构建、零第三方运行时依赖。
> 契约定位（§2.5/§6）：**传输接入层**——媒体走 RTCPeerConnection 原生管线直达
> `<video>/<audio>`，本模块只做"信令抽象 + 播放端"，不产 Sample、不接 demuxer。
> 典型延迟 200ms~1s。作者：vue-dev-3。

## 一、原理速览

WebRTC 播放端三步：

1. **信令**：把本地 SDP offer 交给服务端，换回 answer（WHEP 用 HTTP POST 实现）；
2. **打洞**：ICE 候选交换，P2P 不通时经 STUN/TURN 中继；
3. **收流**：DTLS-SRTP 解密 → `ontrack` 得到 MediaStream → 挂到媒体元素自动播放。

浏览器原生完成解包与解码，因此这是所有方案里**延迟最低、CPU 占用最小**的路线；
代价是必须有一个信令服务（WHEP 服务端或自定义信令网关）。

## 二、浏览器可行性结论

✅ 完全可纯前端（信令 HTTP 化后无需任何插件）。
❌ Node 下无 RTCPeerConnection/WebSocket 时按契约返回不支持，不抛未捕获异常。

| 环境 | 能力 |
|------|------|
| Chrome / Edge / Firefox / Safari | 完整可用 |
| Node 22 | 仅纯逻辑层可测（SDP 解析、退避计算、getStats 提取——14 项单测全绿） |

## 三、架构

```
                 ┌───────────────────────────────────────────┐
   webrtc:// ──► │            WebRtcPlayer (player.js)       │
   http(s)://    │  parsePlayerUrl → 信令工厂                  │
   ws(s)://      │  状态机: idle→connecting→connected          │
                 │         ↘ reconnecting(指数退避)↺ / failed  │
                 └──────┬───────────────────────┬────────────┘
                        │                       │
        ┌───────────────▼────────┐   ┌──────────▼───────────────┐
        │ signaling.js           │   │ stats.js                 │
        │ SignalChannel 接口      │   │ getStats 提取            │
        │ ├ WhepSignal (RFC9725) │   │ RTT/码率/丢包/抖动        │
        │ └ WebSocketSignal(示例) │   │ 缓冲驻留/端到端延迟估计    │
        └────────────────────────┘   └──────────────────────────┘
                        │
              RTCPeerConnection(recvonly)
                        │ ontrack
                <video>.srcObject = MediaStream
```

## 四、快速开始

```html
<video id="v" autoplay playsinline muted></video>
<script type="module">
  import { WebRtcPlayer } from './src/index.js'

  const player = new WebRtcPlayer()
  player.onEvent = ... // 见构造器 onEvent 回调
  await player.play('https://edge.example.com/whep', { video: document.querySelector('#v') })

  // 统计面板
  setInterval(() => console.log(player.stats), 2000)
  // 页面卸载时释放服务端会话（WHEP DELETE）
  addEventListener('beforeunload', () => player.destroy())
</script>
```

地址形态约定：

| 形态 | 信令 |
|------|------|
| `https://host/path`（POST SDP） | WHEP 标准（RFC 9725） |
| `wss://host/path` | 自定义 JSON 信令（`{type:'offer'\|'answer'\|'candidate'}` 示例适配器） |
| `webrtc://host/group/stream` | 约定映射为 `https://host/group/stream/whep` |

自定义信令：实现 `{connect?, exchange(offer)->{sdp}, sendCandidate?, drainRemoteCandidates?, close?}` 接口的对象，
构造播放器时以 `signalChannel` 注入即可，其余逻辑零改动。

## 五、API 说明

### WebRtcPlayer

| 成员 | 说明 |
|------|------|
| `play(url, {video?, audio?})` | 建立连接并挂载元素；默认非 trickle（等 ICE 收集完成再 POST），兼容面最广 |
| `state` | `idle/connecting/connected/reconnecting/failed/closed` 封闭状态机，非法迁移抛错 |
| `stats` | 最近一轮统计指标（见下） |
| `pause()/resume()` | 元素级播控（收流不断） |
| `destroy()` | 关 PC + WHEP DELETE 释放服务端资源 |
| 事件（`onEvent(type,payload)`） | `statechange/track/connectionlost/reconnecting/stats/warn/error` |

重连策略：指数退避 `min(capMs, baseMs·2^n)` ± 抖动，默认 base=1s、cap=15s、上限 5 次；
连接恢复即清零计数。参数均可注入（测试用 10ms 验证过全流程）。

### 统计口径（全部来自标准 getStats 字段）

| 指标 | 来源 |
|------|------|
| `rttMs` | nominated 且 succeeded 的 candidate-pair.currentRoundTripTime |
| `video/audio.kbps` | inbound-rtp.bytesReceived 差分 |
| `packetsLost / jitterMs` | inbound-rtp 同名字段 |
| `framesDecoded/Dropped/FPS` | video inbound-rtp |
| `bufferDelayMs` | jitterBufferDelay ÷ jitterBufferEmittedCount（播放端缓冲平均驻留） |
| `latencyEstimateMs` | remote-outbound-rtp.remoteTimestamp 与本地时钟差（需服务端支持，标注估计值） |

### 信令与解析工具

- `WhepSignal`：POST offer → 201 answer + Location；`sendCandidate()` PATCH trickle 片段；`close()` DELETE 资源；
- `WebSocketSignal`：自定义信令参考实现，含 answer 超时（10s）与候选缓冲；
- `createMockSignalChannel(gen)` / `createLoopbackSignalPair()`：本地回环 mock 信令
  （零服务依赖联调；demo 回环演示与 Node 单测均基于它）；
- `parseSdp/summarizeSdp`：SDP 结构化（m 行/rtpmap/fmtp/candidate/方向/ICE-DTLS 属性）。

## 六、demo 使用说明（诚实标注）

`demo/index.html` 提供 WHEP 地址输入与实时统计面板（RTT/码率/丢包率/延迟估计），
并内置一个**自托管回环演示**：页面内用两个本地 RTCPeerConnection 直连模拟"拉流"
（canvas 合成动画帧作为视频源），完全离线可跑，用于验证管线本身。
真实拉流需要你提供可达的 WHEP/信令地址；不可达时展示友好降级提示而非报错崩溃。

## 七、已知限制与路线

1. 默认**非 trickle**（gather 完成再 POST）：首帧建立慢约几百毫秒，换取兼容性；
   trickle 路径已实现（PATCH），待服务端联调后作为选项开放。
2. TURN/STUN 服务器目前写死公共 STUN，生产部署应从配置注入 iceServers。
3. 双向场景（推流）不在本期范围（契约定位为"播放端"）。
4. SIMULCAST/SVC 多层选择待统一内核的清晰度策略一起做。
