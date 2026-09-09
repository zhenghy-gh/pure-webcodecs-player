# samples/gateway —— 本地联调测试网关（全仓唯一权威实现）

> 归属：net-dev（终裁#3 / CONTRACTS §9）。零第三方依赖，仅 `node:` 内置模块。
> 根入口 `npm run gateway` 保持可用（scripts/gateway.mjs 已冻结为兼容壳，行为与本文一致）。

## 一、三个服务一览

| 服务 | 默认端口 | 地址 | 用途 |
|------|---------|------|------|
| ws-flv 网关 | 8321 | `ws://127.0.0.1:8321/live/<stream>` | 循环推送内置 FLV 流（H264，程序化生成、真实可解码） |
| rtsp-ws 中继 | 8322 | `ws://127.0.0.1:8322/rtsp`、`/rtp?mode=passive`、`GET /sdp` | 模拟 RTSP interleaved / 纯 RTP 两类桥接 |
| §9 通道中继 | 8090 | `POST /publish/<name>` → `ws://127.0.0.1:8090/stream/<name>` | 通用字节流管道（ffmpeg 直推） |

一键启动：

```bash
node samples/gateway/bin/gateway.js
# 端口均可覆盖：--wsflv-port --rtsp-port --relay-port；兼容 PORT=<n> 环境变量
```

## 二、部署图

```
┌────────────┐   RTSP/TCP    ┌─────────────────── samples/gateway ───────────────────┐
│ 摄像头/NVR │──────────────▶│ server-rtsp.js   模拟 RTSP over TCP(interleaved)       │
└────────────┘               │   · OPTIONS/DESCRIBE(SDP)/SETUP/PLAY/TEARDOWN          │
                             │   · $ 块: ch0=RTP(H264 FU-A)  ch1=RTCP SR             │
                             ├────────────────────────────────────────────────────────┤
                             │ server-wsflv.js  内置 FLV 循环流                       │
                             │   · FLV header + onMetaData + avcC + IDR 帧序列        │
                             ├────────────────────────────────────────────────────────┤
        ffmpeg -c copy -f flv│ server-relay.js  §9 通道中继                           │
  rtsp://cam ──────POST─────▶│   · POST /publish/<name> → WS /stream/<name> 广播      │
                             │   · 信令: meta/eos/hello(自回声)；慢消费丢旧块+计数     │
                             │   · 心跳 Ping/Pong 保活；GET /status 频道列表          │
                             └───────┬───────────────────────┬────────────────────────┘
                                     │ WebSocket             │ WebSocket
                             ┌───────▼────────┐      ┌───────▼────────┐
                             │ rtmp/ 播放器    │      │ rtsp/ 播放器    │
                             └────────────────┘      └────────────────┘
```

## 三、ws-flv 网关协议

- 路径：`ws://host:port/live/<任意流名>`；
- 首块：FLV 文件头(9B)+PreviousTagSize0(4B)+AVC sequence header Tag+onMetaData Tag；
- 后续：每帧一个 Video Tag（keyframe+AVC+AVCPacketType=1，AVCC 长度前缀封装），毫秒时间戳单调跨周期递增；
- 测试钩子（查询参数）：

| 参数 | 含义 |
|------|------|
| `speed=fast` | 不按真实时间节流 |
| `frames=N` | 推 N 帧后以 1000 关闭（重连测试） |
| `intervalMs=X` | 覆盖帧间隔 |

- 健康检查：`GET /healthz`。

内置码流说明：本机无 ffmpeg 时 fixture 必须程序化生成——`src/media/h264-pcm.js`
手写了一个 Baseline/I_PCM 极小 H264 编码器（16x16@15fps 对角条纹动画），输出符合规范的
SPS/PPS/IDR，浏览器 WebCodecs 与 MSE 均可直接解码。

## 四、rtsp-ws 中继协议（与 rtsp/ 客户端对齐）

### 4.1 interleaved 模式（`/rtsp`）

一条 WS 连接承载与「RTSP over TCP」完全相同的字节语义：

- 入站：RTSP 请求文本（二进制或文本消息均可，请求间 `\r\n\r\n` 分隔）；
- 出站两类单元复用同一字节流：
  - `$ + channel(1B) + len(2B BE) + RTP/RTCP 载荷`（偶数信道 0=RTP，奇数信道 1=RTCP SR）
  - 原始 RTSP 响应文本（含 Content-Length body，如 DESCRIBE 的 SDP）

信令序列与状态机：

```
OPTIONS → 200 (Public)
DESCRIBE → 200 (application/sdp, 含 sprop-parameter-sets)
SETUP → 200 (Session: CAFE0001; Transport: RTP/AVP/TCP;interleaved=0-1)
PLAY → 200 (RTP-Info) —— 未 SETUP 先 PLAY 将得到 455
TEARDOWN → 200 并断开
```

每条连接会话状态独立；客户端重连必须重新完整握手。

### 4.2 纯 RTP-over-WS 模式（`/rtp?mode=passive`)

无信令直推媒体；每条 WS 二进制消息恰为一个完整 RTP 包；SDP 经 `GET http://…:8322/sdp` 带外获取。

### 4.3 公共参数

| 参数 | 含义 |
|------|------|
| `mode=passive` | 免握手直接推流 |
| `chaos=dropEvery:N` | 每 N 个已生成 RTP 包丢 1 个（被丢包同样消耗序号→接收端可见跳变） |
| `frames=N` / `speed=fast` / `intervalMs=X` | 同 ws-flv |

SDP 关键行示例：

```
m=video 5004 RTP/AVP 96
a=rtpmap:96 H264/90000
a=fmtp:96 packetization-mode=1;profile-level-id=42c01e;sprop-parameter-sets=<b64 SPS>,<b64 PPS>
```

## 五、§9 通道中继协议（CONTRACTS §9 权威实现）

### 5.1 通道事实

- `POST|PUT /publish/<name>[?meta=<urlencoded json>]`：HTTP 推流入口，body 边收边转（低延迟）；CORS `*`；
- `ws://host:port/stream/<name>`：订阅端。**二进制帧=字节流分块（保序原样无私有封头）；
  文本帧=控制信令**，网关原样广播给频道内所有人（**含发送者自身回声**——客户端必须容忍）；
- `GET /status`（或 `/`）：频道列表 JSON，含订阅数与慢消费丢弃计数。

### 5.2 文本信令格式（CONTRACTS §9.2 定稿：一帧一个 UTF-8 JSON 对象，禁止多行/多对象）

```js
{"type":"meta","container":"flv","codecs":["avc1.42c01e"],"live":true,"durationUs":null} // 发布方
{"type":"eos"}                                   // 发布正常结束（网关在 publish 结束时也会合成）
{"type":"error","code":"PUBLISH_ABORTED","message":"上游中断"}
{"type":"hello","ua":"pureplay-rtmp/0.1"}        // 订阅方握手自报（会被回声）
```

未知 type 或非法 JSON 由**客户端**静默忽略；网关不拦截转发。

### 5.3 客户端健壮性义务（硬性）

- meta 可能缺席（晚加入者错过/发布方未发）→ 必须退化为对首个二进制分块做 probe 嗅探；
- eos 可能永远不来 → 以空闲超时（建议 30s 可配）判定断流；
- 收到自己的 hello/meta 回显不得产生副作用。

### 5.4 网关侧实现行为（§9.3 三增强已落地）

1. publish 结束向频道合成广播 `{"type":"eos"}`；
2. 频道记忆最近一条 meta，新订阅者 join 时补发；
3. 支持 `?meta=<json>` 首推注入；
4. 慢消费背压：每订阅者出站队列默认上限 2MB，超限**丢弃最旧块**并计数，
   经 `GET /status` 上报（`droppedForSlowConsumer`/`droppedBytes`）；文本信令不丢弃；
5. 心跳保活：默认每 30s 发 Ping，两个周期未收到 Pong/任何数据即断开（可用 `pingIntervalMs` 调整）。

## 六、ffmpeg 推流速查

```bash
# 摄像头 → FLV 进通道中继（免转码）
ffmpeg -rtsp_transport tcp -i rtsp://user:pwd@cam/stream -c copy \
  -f flv 'http://127.0.0.1:8090/publish/cam1'

# MP4 文件循环
ffmpeg -re -stream_loop -1 -i input.mp4 -c copy \
  -f flv 'http://127.0.0.1:8090/publish/vod?meta=%7B%22container%22%3A%22flv%22%7D'

# RTSP → MPEG-TS（供 ts/ 模块消费端，同一条通道即可）
ffmpeg -rtsp_transport tcp -i rtsp://camera/stream -c copy -f mpegts \
  'http://127.0.0.1:8090/publish/cam-ts'
```

## 七、目录与测试

```
samples/gateway/
├─ bin/gateway.js            # CLI（三服务聚合启动）
├─ mock-flv-ws.js            # E-11 约定入口（qa 冒烟用）
├─ mock-rtsp-relay.js        # E-11 约定入口
├─ src/
│  ├─ ws-server.js           # RFC6455 最小实现 + 心跳 + closeAllConnections
│  ├─ slow-consumer.js       # 背压队列（丢旧块+计数，独立可测）
│  ├─ flv-builder.js         # FLV 字节流构建器/循环源
│  ├─ media/bitwriter.js     # RBSP 位流写入器 + 仿真预防
│  ├─ media/h264-pcm.js      # 程序化 H264 编码器（I_PCM）
│  ├─ rtp-packer.js          # RTP 打包（单包/STAP-A/FU-A/SR）
│  ├─ server-wsflv.js        # ws-flv 推流服务
│  ├─ server-rtsp.js         # rtsp-ws 模拟中继
│  └─ server-relay.js        # §9 通道中继
└─ __tests__/                # node --test（显式 glob 运行）
```

```bash
node --test "samples/gateway/__tests__/*.test.js"
```

36 例覆盖：位流写入/EPB、H264 参数集与帧结构、FLV 结构与循环时间戳、RTP 打包
（FU-A 重组还原/STAP-A 解析/SR）、双服务 e2e、§9 通道事实与三增强、背压队列语义、心跳踢除。
