# hls —— HLS 数据源适配层（PurePlay · 模块）

> 纯 ESM、零构建、零第三方运行时依赖。
> 契约基线：docs/CONTRACTS.md **v0.2**（§2.1 数据源抽象、§2.5 定位、§2.6 AES-128、§10/§11 规范）。
> 作者：vue-dev-3。scope 依【裁决-hls-flv重定位】执行。

## 一、定位（重要，scope 已重定位）

**本模块是「HLS 数据源适配层」，不是 hls.js 的复刻或竞品。**

- ✅ 做：m3u8 清单解析、分片加载编排、AES-128 解密层、TS→fMP4 转封装地基、
  ChunkSource 数据源接入件——为统一内核（core Player）提供 HLS 输入，
  验证 MSE 保底路线与 WebCodecs 直解试验；
- ❌ 不做：完整 ABR 竞赛特性（多档并发探测/复杂切换策略）、生产级健壮性工程；
- 🏭 **生产场景请直接使用 [hls.js](https://github.com/video-dev/hls.js)**；
  demo 提供其 CDN 对照入口（可选增强，离线时优雅降级）。

## 二、HLS 协议原理（30 秒版）

HTTP Live Streaming（Apple，RFC 8216）把媒体切成小文件（分片），用文本索引（`.m3u8`）描述：

- **MASTER**：多路码流（清晰度/音轨）索引；每路由一个 MEDIA 清单描述；
- **MEDIA**：顺序列出分片 URL 与时长；带 `#EXT-X-ENDLIST` 为点播，否则直播滑动窗口；
- 分片封装：MPEG-TS 或 fMP4（CMAF）；MSE 只能直吃 fMP4，TS 必须转封装；
- **LL-HLS**：PART 子分片 + SERVER-CONTROL + 阻塞重载（`?_HLS_msn&_HLS_part`），延迟 1~5s。

## 三、浏览器可行性结论

✅ 完全可纯前端。

| 环节 | 可行性 | 说明 |
|------|--------|------|
| m3u8 解析 | ✅ 自实现 | Node/浏览器通用；54 项单测覆盖 |
| 分片下载 | ✅ | fetch + ReadableStream；跨域需 CORS |
| fMP4 → MSE | ✅ | 直通 SourceBuffer |
| TS → fMP4 | ✅ 架构就绪 | 复用 `ts/` TsDemuxer + 本模块 remuxer；集成断言随 ts/ 就绪自动激活 |
| AES-128 解密 | ✅ 契约 §2.6 | WebCrypto 主路径 + 软件兜底 + 完整性闸门；node webcrypto 同构单测 |
| SAMPLE-AES / DRM | ❌ | 按契约报 NOT_SUPPORTED |

## 四、架构

```
                     createHlsSource(url)
                            │
              ┌─────────────▼──────────────────┐
              │   HlsChunkSource (ChunkSource) │◄── 数据源接入层【核心交付】
              │   清单解析→分片编排→(解密)→write │    喂统一内核 / TsDemuxer.push
              └─────────────┬──────────────────┘
                            │
        ┌───────────────────┼──────────────────────┐
        ▼                   ▼                      ▼
  m3u8-parser.js      segment-loader.js       decrypter.js (§2.6)
  MASTER/MEDIA        fetch+Stream            AES-CBC 主+软兜底
  LL-HLS PART         Range/重试/取消          IV 推导/完整性闸门
        │                   │                      │
        └───────────────────┴──────────┬───────────┘
                                       ▼
                              transmuxer.js
                    sniffContainer: fMP4 直通 / TS→TsDemuxer(ts/)
                                       ▼
                              fmp4-muxer.js（AVCC 化 · esds · moof/mdat）
                                       ▼
                 HlsPlayer（MSE 保底验证壳，非生产目标）──► <video>
```

## 五、快速开始

### A. 数据源接入统一内核（推荐形态）

```js
import { createHlsSource } from './hls/src/index.js'
const source = await createHlsSource('https://cdn/live/index.m3u8')
source.onData = (bytes) => tsDemuxer.push(bytes)   // 或统一内核的流式入口
source.onEnd = () => console.log('eos')
await source.start()
// source.container: 'ts' | 'fmp4'；AES-128 已在 write 前解密（§2.6）
```

### B. 独立 MSE 保底播放壳（仅用于验证，生产用 hls.js）

```html
<video id="v" controls></video>
<script type="module">
  import { HlsPlayer } from './src/index.js'
  const player = new HlsPlayer({ lowLatencyMode: false })
  await player.attach('https://example.com/master.m3u8', document.querySelector('#v'))
</script>
```

本地跑 demo：仓库根目录 `npm run demo` 后访问 `/hls/demo/`（file:// 下无法 fetch，必须 http 服务）。

## 六、API 说明

### 数据源层

| 导出 | 说明 |
|------|------|
| `createHlsSource(url, {variant?, keyLoader?, fetchImpl?})` | 工厂：解析清单并返回 `HlsChunkSource`（已按 variant 选档；keyLoader/fetchImpl 可注入供离线测试） |
| `source.onData(bytes)` | 消费端挂点：逐分片回调（解密后字节） |
| `source.onEnd(err?)` / `start()` / `close()` | 流生命周期（ChunkSource.end 语义） |
| `source.container` | `'ts' \| 'fmp4' \| 'unknown'`（首分片探测） |
| `source.pendingInit` | fMP4 变体的 EXT-X-MAP init 字节（如有） |

### 解析层

```js
import { parseMaster, parseMedia, parsePlaylist } from './src/m3u8-parser.js'
// master: {levels:[{url,bandwidth,resolution,videoCodec,label,...}], audioTracks,...}
// media : {live, targetDuration, segments:[{sn,cc,duration,byteRange,key,map,parts,...}], serverControl}
```

BYTERANGE 支持规范滚动 offset；discontinuity 计数器从 DISCONTINUITY-SEQUENCE 起步；
LL-HLS PART 按 RFC 8216bis 归属到其后的 EXTINF 分片。

### AES-128 解密层（契约 §2.6）

```js
new Aes128Decrypter({ crypto?, keyLoader? })   // 双注入：subtle 提供方与密钥加载器
await d.decryptSegment(cipherBytes, keyInfo, { sn })
// 主路径 subtle AES-CBC（PKCS7 自动剥离）；OperationError 时软件 CBC 兜底；
// 明文首块校验失败 → PARSE_ERROR（拦截错误密钥/损坏数据）
// 错误封闭映射：无 subtle/密钥≠16B → NOT_SUPPORTED；取钥失败 → NETWORK_ERROR
```

IV 规则：KEY 带 IV 用之；否则媒体序号 sn 的 128 位大端（高 64 位补零）。
软件兜底实现（aes-cbc.js）经 FIPS-197 C.1 向量与 node:crypto 交叉验证。

### TS→fMP4 转封装

```js
const out = await new TsToFmp4Transmuxer().remux(tsBytes)
// { codecs:{video:'avc1.64001f',audio:'mp4a.40.2'}, video:{initSegment,mediaSegment}, audio:{...}|null }
```

时间轴：首分片最小 DTS 为基准并跨分片保持；视频 DTS 序输出、PTS−DTS 走 trun composition offset（B 帧安全）。

## 七、demo 使用说明（诚实标注）

`demo/index.html`：

- 内置公开测试流按钮（Apple bipbop、Mux 等）——**需网络可达外网 + 服务端开 CORS**；
- 「hls.js 对照」按钮（可选增强）：动态加载 CDN 版 hls.js 对比播放，加载失败/离线时提示降级，不影响本模块功能；
- 离线/不可达地址：友好降级提示（原因分类 + 建议），无未捕获异常；
- AES-128 加密流：本模块已支持解密播放（契约 §2.6）。

## 八、已知限制与路线

1. **ABR 为最简自动切档**（EWMA 带宽 + 缓冲水位阈值）：满足保底验证即可，
   不做 hls.js 级别的切换工程——这是 scope 裁决的明确边界。
2. 音频 Rendition 独立清单未单独装载（主分片自含音轨时正常）。
3. LL-HLS"最近独立 part 快速起播"完整实现在 cmaf/ 方向（PartTimeline 骨架已就位）。
4. I-frame 清单登记不渲染；EXT-X-GAP 分片跳过策略从简。
5. WebCodecs 直解管线归统一内核（core Player M3），remuxer 已产出 AVCC 形态样本与 description 备好接入。
6. core ErrorCode 十码未齐前，NETWORK_ERROR 在本模块内前向兼容取值（core 补齐后自动对齐）。
