# PurePlay · webtorrent —— P2P 边下边播传输接入层

把 WebTorrent 网络中的文件变成 demuxer 可读的 **DataSource**（契约 §2.1：`{size, read(offset,length), close?}`）。定位与交付物遵循 CONTRACTS v0.2 §2.5/§10：**传输接入层不实现 demuxer 接口**，`webtorrent → DataSource`，路线随容器（mkv/mp4）。

> 归属：vue-dev-1（MKV/WebTorrent 方向）· 契约基线 CONTRACTS v0.2 · 单测门槛 ≥40（实测 50，全绿）

## 一、原理速览

BitTorrent 把文件切成固定大小的 **piece**（通常 256KiB~4MiB），每片有 SHA-1 校验；peer 间以乱序方式交换 piece。边下边播的关键：**目标字节区间所在 piece 已到即可读**。

本模块四件套 + 一个封装：

```
magnet/.torrent URL ──▶ loader.js(可选依赖) ──▶ player.js(WebTorrentPlayer)
      .torrent 字节 ─────────────────────────┐│
                                             ▼▼
┌───────────────────────────────────────────────────────────────┐
│ bencode.js     编解码（往返/键排序/二进制安全）                  │
│ torrent-file.js .torrent → pieceLength/pieces/files 布局        │
│ piece-map.js   字节区间→跨片映射；确定性取片决策（可复现）        │
│ assembler.js   已校验片→连续流：头部齐备即产前缀；断流挂起等待续传 │
└───────────────┬───────────────────────────────────────────────┘
                ▼
   DataSource { size, read, close }
   ├ 网络路径: TorrentFileSource（slice 快路径随机读 / stream 滑动缓冲顺序读）
   └ 离线路径: createSource(.torrent 字节) 装配视图（零网络、确定性、单测友好）
                ▼
   mkv / mp4 …demuxer（任意符合契约的解析器）
```

- **slice 快路径**：file.slice 存在时随机读零额外成本；
- **顺序兜底**：仅 stream() 时滑动缓冲向前读；向后超出缓冲自动重启底层流丢弃至目标（慢路径，语义正确优先）；
- **优雅降级**：库加载失败进入 degraded 态并抛 `PlayerError('NETWORK_ERROR', detail.reason='NO_CLIENT')`，UI 提示后本地模式不受影响；
- **离线装配路径**：`.torrent` 字节 → bencode 解析 → piece 决策 → 手动/模拟喂片 → assembler 产出 DataSource。同一份代码覆盖 PRD 的「文件树 / 模拟下载热力图 / 断 mock 续传」演示项，且单测完全离线确定性。

## 二、浏览器侧传输约束与可行性结论

**硬约束（为什么不能"直接连"）**：浏览器沙箱**不提供原生 TCP/UDP socket API**——
BitTorrent 原生 peer 通信（TCP uTP/DHT UDP/tracker HTTP-UDP）在纯网页里不可达。因此浏览器侧只有两条合法通道：

| 通道 | 承载 | 说明 |
|---|---|---|
| **WebRTC tracker** | 数据通道(SCTP/DTLS) | 主路径：tracker 经 HTTP(S) 信令交换 SDP，peer 间走 WebRTC DataChannel；`wss://` tracker 需 HTTPS 环境 |
| **WebSocket gateway** | TCP over WS | 备选：自建网关代理 TCP peer/tracker（与 rtmp/rtsp 桥接同一形态，契约 §9） |

由此推论（也是本模块的工程事实基线）：
1. P2P 能力 = 「可选增强依赖 webtorrent 库」+「WebRTC 可用 + wss tracker 可达」，三者缺一即降级；
2. `file://` 直开无安全上下文 → WebRTC 不可用 → 仅离线装配路径可用；
3. 无 DHT（UDP 不可达），发现完全依赖 tracker——真实 swarm 演示必须联网。

✅ **可纯前端**（WebRTC 数据通道 + WebSocket tracker，无需自有服务端）。piece 校验/缓存/读取全部在浏览器内完成；唯一外部依赖是可选的 `webtorrent` 库本身（README 声明的可选增强，缺失降级不崩溃——契约 §0.1）。

**magnet 离线解析不依赖任何网络栈**：`src/magnet.js` 完成 btih 提取（40 位 hex ↔ 32 位 Base32 双向）与 dn/tr/xl 字段收集，错误前置于可选依赖加载（`PlayerError('PARSE_ERROR')`）。

## 三、可选依赖声明（重要）

运行时网络路径依赖 `webtorrent` 库（仅此一个），两种引入任选：

方式 A —— CDN `<script>` 标签（推荐生产）：

```html
<script src="https://cdn.jsdelivr.net/npm/webtorrent@2/dist/webtorrent.min.js"></script>
<!-- 或 https://unpkg.com/webtorrent@2/dist/webtorrent.min.js -->
```

方式 B —— 免标签动态 import（loader 默认 jsDelivr → unpkg）：

```js
import { loadWebTorrent } from './src/index.js';
const WebTorrent = await loadWebTorrent({ timeoutMs: 15000 });
if (!WebTorrent) { /* 降级提示 */ }
```

自托管/测试注入：`new WebTorrentPlayer({ clientFactory })`。**离线装配路径不需要任何依赖。**

## 四、快速开始

```js
import { createSource } from './webtorrent/src/index.js';
import { createDemuxer } from './mkv/src/index.js';

// ① 离线装配（零依赖）：.torrent 字节 → DataSource + 文件树 meta
const { source, meta } = await createSource(torrentBytes);
console.log(meta.files, meta.pieceLength, meta.numPieces);
// 喂入已校验 piece（真实场景由 webtorrent 回调驱动；demo 用确定性模拟）
for (const i of planSequentialPieces({ numPieces: meta.numPieces })) {
  meta.assembler.writePiece(i, await downloadPieceSomewhere(i));
}

// ② 接 MKV demuxer（契约互通）
const d = await createDemuxer(source);          // source 即 DataSource
for await (const s of d.samples(videoTrackId)) { /* 边下边播 */ }

// ③ 网络 swarm 路径（需要可选依赖）
const net = await createSource('magnet:?xt=urn:btih:…');
// net.source 同样是 DataSource；net.player 提供 stats 事件（速度/peers/进度）
```

运行演示页：

```bash
cd webtorrent && python3 -m http.server 8091    # 或根目录 npm run demo
# 打开 http://127.0.0.1:8091/demo/
# 功能：文件树 / piece 热力图 / 模拟下载+断流续传 / 内置确定性样例 /
#       真实 swarm 按钮（环境受限默认灰显并注明原因）/ 本地媒体直连 demux
```

## 五、API

### index.js 导出（§10 传输层形状）

| 导出 | 说明 |
|---|---|
| `transportName='webtorrent'` / `schemes` / `capabilities` | 注册形状与能力说明 |
| `createSource(input, options)` | magnet/url → 网络路径；Uint8Array/File/Blob(.torrent) → 离线路径。返回 `{source:DataSource, meta}` |
| `bdecode/bencode/decodeAt` | bencode 编解码 |
| `parseTorrent/buildSingleFileTorrent` | .torrent 解析 / 确定性测试种子构造 |
| `rangesToPieces/pieceIndexFor/planSequentialPieces` | 跨片映射 / 偏移换算 / 确定性取片决策 |
| `TorrentAssembler` | 片→连续流装配器 |
| `WebTorrentPlayer/selectMediaFile` | 网络封装（可选依赖） |
| `TorrentFileSource/createTorrentSource` | webtorrent File → DataSource |
| `loadWebTorrent/DEFAULT_CDN_URLS` | 可选依赖加载器 |
| `Emitter/formatBytes`、`PlayerError/ErrorCode`(复用 core) | 工具 |

### TorrentAssembler

| 成员 | 说明 |
|---|---|
| `writePiece(index, bytes)` | 写入已校验片（末片允许短）；重复/越界/毁坏静默 false |
| `read(offset,length)` | 前缀内立返；未到齐**挂起等待续传**（不抛错）；销毁时以 ABORTED 唤醒 |
| `prefixBytes/canReadNow/progress/complete` | 头部齐备即产前缀；进度查询 |
| `verifyPiece` 注入 | 片校验钩子（缺省跳过；网络路径哈希校验由 webtorrent 负责） |
| 事件 | `'piece' 'prefix' 'complete'` |

### WebTorrentPlayer

`attach(torrentId)` → `{file, source, torrent}`；状态机 `idle/loading/ready/degraded/destroyed`；事件 `status/metadata/ready/stats/no-client/error`；错误码映射十码：NO_CLIENT→`NETWORK_ERROR(detail.reason)`、ATTACH_FAILED→`NETWORK_ERROR`、无可播文件→`NOT_SUPPORTED`、已销毁调用→`STATE_ERROR`。

### TorrentFileSource（DataSource 实现）

`size`（契约主名，byteLength 别名）、`read`（恰好 length 字节，EOF 短读）、`supportsRandomAccess`、`close()`、`onRead(bytes)` 测速钩子。

## 六、已知限制与路线

1. 纯顺序文件的向后 seek 需重启底层流重拉（慢路径）；路线：对接 webtorrent 存储层做 piece 粒度随机读。
2. 冷启动首帧延迟取决于关键帧所在 piece 到达时间；路线：联动 swarm 顺序下载优先级，优先拉 EBML 头部与首个 Cues 区间。
3. WebRTC tracker 需要 HTTPS 安全上下文；`file://` 无法使用 P2P（demo 真实按钮据此灰显注明）。
4. 离线装配路径不做 SHA-1 校验（测试数据无哈希语义）；生产校验由 webtorrent 库完成，`verifyPiece` 钩子留给自定义管线。
5. 路线：WebSeed 混合源、piece 热力图联调面板、与 core 缓冲水位联动、infohash 计算导出。

## 七、测试（50 例，node --test 全绿；PRD 验收单元 ≥40 达标）

```bash
cd webtorrent && node --test "__tests__/*.test.js"    # 或 npm test（根）
```

全程注入桩 client / 假 torrent 文件，**不需要真实网络**：

- `source.test.js`（11）：slice 随机读/EOF 短读、顺序流前进+跨块+向后自动重启、参数校验、size 契约主名、**跨模块互验**（TorrentFileSource 直接喂 MkvDemuxer 完成 init+逐轨 pull）；
- `player.test.js`（9）：
- `magnet.test.js`（10）：btih 提取(hex/base32 双形态)、base32↔hex 手算向量与 crypto sha1 往返、非法输入拒绝、buildMagnet↔parseMagnet 往返；attach 全流程与事件序列、NO_CLIENT 降级映射 NETWORK_ERROR、ATTACH_FAILED 映射、destroy 幂等、loader 全局注入优先/全 CDN 失败返 null；
- `protocol.test.js`（21）：bencode 往返/键序/二进制安全/截断拒绝、.torrent 单/多文件解析、跨 piece 映射精确切分、决策确定性与环绕策略、assembler 前缀即产/乱序续传挂起不抛/末片长度校验/ABORTED、createSource 双路径。

## 八、接口对齐声明

- 契约锚点：`docs/CONTRACTS.md` **v0.2** —— §2.5「webtorrent 是传输接入层：交付物是 DataSource 实现」；§10「导出 createSource(...)=>Promise<DataSource> 与能力说明，不导出 demuxer」。
- 自检清单：createSource ✓；DataSource.size/read/close ✓；可选增强声明+降级 ✓（§0.1）；具名导出 ✓；PlayerError 十码复用 core ✓；纯 ESM 零构建 ✓；fixture 程序化生成且离线确定性 ✓。
