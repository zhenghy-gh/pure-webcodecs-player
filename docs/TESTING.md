# 测试约定与运行方式

> 维护人：sdet · 2025-08-25。全仓测试基建的唯一说明文档；各模块 README 只需链接到这里。

## 1. 运行方式

```bash
npm test          # 递归运行全仓所有 __tests__/*.test.{js,mjs}（node --test + glob）
npm run test:watch  # 监听模式，改动即重跑
npm run check     # ★ 本地一键门禁：fixtures → test → lint 串行，任一步失败即停（M2 起完工统一自检入口）
npm run lint      # 可选单跑：node --check 语法 + 卫生 + 导入红线检查（零依赖）
npm run demo      # 开发静态服务器 serve.mjs（默认 http://localhost:8080；npm run server 等价委托入口）
npm run gateway   # 本地 WS 测试网关（权威实现=net-dev 的 samples/gateway，此入口保持可用）
npm run fixtures  # 运行各模块 __tests__/fixtures/gen.mjs，重建落盘 fixture（产物已 gitignore）
```

- **Node ≥ 22**：根 `package.json` 的 `test` 脚本使用 `node --test "<glob>"`，
  glob 参数需要 v22 的测试运行器支持（开发基线 v22.23.1，nvm 环境）。
- ⚠️ **禁止目录形式**：本机实测 `node --test <模块>/__tests__/`（带或不带尾斜杠）都会按
  模块加载直接报 MODULE_NOT_FOUND——**一律使用显式 glob**：
  - 单模块：`node --test "<模块>/__tests__/*.test.{js,mjs}"`
  - 单文件：`node --test mp4/__tests__/parse.test.js`
- 测试文件允许 `.js` 或 `.mjs` 扩展名（根 glob 已同时覆盖）；花括号扩展 `{js,mjs}` 在
  node v22 实测可用。
- 不安装任何 npm 依赖、不引入构建步骤。覆盖率可用
  `node --test --experimental-test-coverage "**/__tests__/*.test.js"` 按需开启（非门禁项）。

### lint 的导入红线（错误级，会阻断 check）

| 规则 | 范围 | 说明 |
|---|---|---|
| 禁裸包名导入 | 全仓所有 .js/.mjs | 零第三方运行时依赖（含 scripts/）；CDN 绝对 URL（https:// 等）视为可选增强放行 |
| 禁 `node:` 前缀导入 | 各模块 `src/**` | 浏览器代码不得依赖 Node API；Node 工具请放 `__tests__`/`scripts`/`samples` |

扫描前会剥离注释（JSDoc 示例不误报）；违规输出带文件:行号。

## 2. 文件放置约定

```
<模块>/src/index.js        源码入口（纯 ESM，中文注释）
<模块>/__tests__/*.test.{js,mjs}  node --test 直接可跑的单测
<模块>/__tests__/fixtures/gen.mjs  可选：npm run fixtures 的落盘生成器（导出 async generate(fixDir)）
samples/fixtures/          程序化 fixture 生成器库（内存字节通道）
docs/TESTING.md            本文档
```

- 测试文件命名一律 `*.test.js` / `*.test.mjs`，放在模块的 `__tests__/` 目录——根 `npm test`
  靠这个约定递归发现。
- `.gitignore` 忽略 `**/__tests__/fixtures/`（落盘的临时二进制产物不入库）；
  gen.mjs 生成器源码**必须入库**。

## 3. Fixture：程序化生成，禁止二进制入库

**规则：测试不得依赖外网、真实媒体文件或大体积二进制。所有容器字节一律用
`samples/fixtures` 的纯函数现场生成**（确定性输出，无随机数、无时间戳噪声）。

统一从出口导入：

```js
import {
  // 字节工具
  concat, ascii, utf8, u16be, u32be, crc32Mpeg2,
  // 容器生成器（返回 { bytes: Uint8Array, meta: {...} }）
  makeMinimalMP4, makeFLV, makeTS, makeMKV, makeWAV, makeFLACHeader,
  // 网络（rtsp/webrtc 用）
  makeSDP, makeRTPH264Packet, makeRTPH264Packets,
  // HLS 与字幕文本常量
  SAMPLE_M3U8_MEDIA, SAMPLE_M3U8_MASTER, SAMPLE_M3U8_LIVE, makeMediaPlaylist,
  SAMPLE_SRT, SAMPLE_VTT, SAMPLE_ASS,
} from '../samples/fixtures/index.js';
```

> 路径按所在模块调整（如 `../../samples/fixtures/index.js`）。

### 生成器清单

| 函数/常量 | 产出 | 关键 meta | 主要使用方 |
|---|---|---|---|
| `makeMinimalMP4(opts?)` | ftyp+moov(mvhd/trak/stbl 六表)+mdat，AVCC 样本 | width/height/timescale/durationTicks/sizes/chunkOffsets | mov、mp4、cmaf |
| `makeFLV(opts?)` | header+onMetaData(AMF)+AVC sequence header+N 帧（可选 AAC） | tags[]/frameDurationMs/durationSec | flv、rtmp |
| `makeTS(opts?)` | PAT/PMT(CRC32)/PES(PTS/DTS/PCR) 包序列 | pids/streamTypes/ptsList/packetCount | ts、hls |
| `makeMKV(opts?)` | EBML 头+Segment(Info/Tracks/Cluster/SimpleBlock×2) | docType/timecodeScaleNs/blocks | mkv、webtorrent |
| `makeWAV(opts?)` | RIFF/WAVE PCM16 正弦（小端） | numSamples/blockAlign/dataChunkOffset | wav |
| `makeFLACHeader(opts?)` | fLaC+STREAMINFO(34B 位打包) | sampleRate/channels/bitsPerSample | flac |
| `makeSDP(opts?)` | H264 SDP 文本+CRLF 字节 | spsB64/ppsB64/port/payloadType | rtsp、webrtc |
| `makeRTPH264Packet(s)` | RTP 单包 / FU-A 分片数组（可重组） | mode/reassembled/count | rtsp、webrtc |
| `SAMPLE_M3U8_*`、`makeMediaPlaylist()` | VOD/主/直播 m3u8 文本 | — | hls |
| `SAMPLE_SRT/VTT/ASS` | 含中文字幕文本 | — | subtitle |

通用选项见各文件 JSDoc；所有生成器支持参数（尺寸/帧数/时长/PID 等），默认值即可直接使用。
`meta` 是断言专用的期望值集合——**先读 meta 再写字段级断言，不要手抄魔数**。

**两条 fixture 通道的关系**：优先用 `samples/fixtures` 直接 import（内存字节，无磁盘 IO）；
确需真实文件（如 demo 拖拽演示、按字节截断测试）时写 `<模块>/__tests__/fixtures/gen.mjs`
并让 `npm run fixtures` 落盘——gen.mjs 内部应 import `samples/fixtures` 复用生成逻辑，
不要另造第二套编码器。

### 参考实现福利

`samples/fixtures/__tests__/` 里的测试自带最小解析器（ISO-BMFF box 遍历、FLV Tag 链、
TS 包/PSI CRC 复算、EBML VINT 遍历、RTP FU-A 重组）。写模块解析器时可直接对照或复制起点。

### fixtures 重建流程（落盘通道）

```bash
npm run fixtures   # = node samples/generate-all.mjs
```

- `generate-all.mjs` 扫描 16 个模块目录，逐个调用 `<模块>/__tests__/fixtures/gen.mjs`
  导出的 `async generate(fixDir)`；**没有 gen.mjs 的模块自动跳过**（内存通道够用就不必建）；
- 产物写入 gen.mjs 所在目录，已被根 `.gitignore` 忽略，不入库、随时可重建；
- gen.mjs 编写契约、参考实现与红线见 **docs/fixtures-约定.md**（一页纸）。

## 4. 单测计数口径（qa 统计用）

`node --test` 输出 TAP 格式，统计以**输出尾部 `#` 注释块**为准：

```
# tests 451      ← 用例总数（每个 test() 计 1）【数字为示例，随进度变化】
# pass 437       ← 通过数
# fail 11        ← 失败数（门槛要求恒为 0）
# skipped 2      ← 跳过数（不计入 pass，需在报告单列原因）
```

- 计数规则：`test()` 计 1 个用例；文件级 suite 与 describe 分组**不折算用例**；
  断言数量与用例数无关。
- 单模块计数命令：

  ```bash
  node --test --test-timeout=10000 "<模块>/__tests__/*.test.{js,mjs}" | grep "^#"
  ```

- 模块门槛对照 PRD 摘要表（16 模块合计 ≥565 例，fail=0）；全仓一键汇总即 `npm test` 尾部统计。
- **自动化达标表**：`npm run check` 末尾（或 `node scripts/thresholds.mjs` 单跑）逐模块输出
  「实际/门槛/缺口/状态」，与 qa 报表同口径；当前为报告性维度，M2 出口起转阻断。
  表中"实际"=该模块 TAP `# tests` 总数。

### 4.1 计数争议仲裁：三件套规程（唯一事实源）

多写者并行下，"同一仓库不同修复时点"的读数差异是固有现象。**任何模块计数争议，
一律以 sdet 现场执行的三件套输出为准**，争议方不得再以各自快照互驳：

1. `ls -lT <模块>/src/ <模块>/__tests__/`——带时间戳文件清单（证明文件代际）；
2. `shasum <模块>/src/*.js <模块>/__tests__/*.test.*`——内容哈希基线（证明字节一致）；
3. 双套件实跑 TAP 原文：`npm run test:<模块>` + 全仓 `npm test` 的尾部统计与 not-ok 清单。

证据包归档于 `docs/arbitration/<争议主题>-<日期>/`（首例：ts-flv-2025-08-25）。
仲裁结论只回答"此刻磁盘上是什么"，不追溯历史快照对错。

## 5. 编写规范（质量门禁的一部分）

1. **零依赖、确定性**：不引第三方包、不用 `Math.random()`/`Date.now()`，重复运行结果一致。
2. **结构合法性 > 内容真实性**：fixture 样本载荷允许伪造，但长度链/标志位/CRC 必须
   符合规范（有标准 check 向量的必须复算，如 CRC32/MPEG-2）。
3. **只测解析层**：WebCodecs/MSE/Canvas 等 DOM 能力不在 node 单测范围（后续 qa 走浏览器验证）。
4. 断言用 `node:assert/strict`；一个行为一个 `test()`；描述用中文写清"测什么、期望什么"。
5. 禁止跨模块 import 源码（模块间只许通过 fixtures 或显式契约互通，契约结论上看板）。
6. 测试里不要 sleep；异步逻辑用 Promise/queueMicrotask 构造确定时序。

## 6. 测试隔离与资源规约

### 6.1 症状识别：文件级超时 ≠ 断言失败

若某测试文件表现为「全部用例 ok，但文件级 `not ok` 且 `failureType=testTimeoutFailure`、
`cancelled ≥ 1`」——这是**进程无法自然退出**（句柄泄漏：未关闭的 server/socket/
setInterval 等），不是测试逻辑失败。runner 只能靠 `--test-timeout` 兜底击杀。

### 6.2 编写规约（红线）

1. **网络测试一律监听随机端口**：`server.listen(0)` 后用 `server.address().port`
   拼接连接地址；禁止硬编码端口号。（rtsp/gateway 历史固定端口已于 2026-08-26
   全数迁移为 listen(0)，工厂 ready Promise 直接 resolve 实际端口。）
2. **after() 必须彻底释放**：close server、destroy 全部 socket、clear 所有 timer；
   服务端测试工具应提供可 await 的 dispose 句柄（范例：samples/gateway 的
   `server.dispose()`——优雅 CLOSE + 冲刷窗口后强毁残余，测试里 `await server.ready` / `await dispose()`）。
   **看门狗定时器是高频踩坑点**：`setTimeout(reject, N)` 这类保护性定时器在成功
   路径也必须 clearTimeout（或 `.unref()`），否则用例全过后进程仍被钉住数秒——
   表现为「cancelled≥1 但 fail=0」的假挂起。库层同理：请求超时定时器、重连退避
   定时器都要在生命周期结束时撤销/unref（案例：RtspWsClient 两处，2026-08-26 修）。
3. **测试进程必须可自然退出**：审计方法=不带 `--test-force-exit` 单跑该文件，
   出现 cancelled 即存在泄漏。
4. **跨文件禁共享端口/临时文件**：node --test 的多个测试文件默认并行运行
   （`--test-concurrency` 可调），任何"别的文件不会同时跑"的假设都会偶发翻车。
5. **全局猴子补丁纪律**：替换 `globalThis.fetch/crypto/console` 等全局对象时，
   必须「先存原值 → try 业务 → **finally 恢复**」：

   ```js
   const originalFetch = globalThis.fetch;
   globalThis.fetch = fakeFetch;
   try { /* 断言 */ } finally { globalThis.fetch = originalFetch; }
   ```

   说明：node --test 默认按文件开子进程（isolation=process），globalThis 补丁
   **不会跨文件传播**；但一旦将来启用 `--experimental-test-isolation=none`
   （单进程跑全部），本条立即升格为硬红线，违者会互相污染。范例见
   `hls/__tests__/extras.test.js`（SegmentLoader 重试用例的 fetch mock）。

### 6.3 runner 参数语义（root 脚本已统一启用前两者）

| 参数 | 作用 | 备注 |
|---|---|---|
| `--test-timeout=10000` | 单用例/单文件 10s 兜底击杀 | 防无限挂起 |
| `--test-force-exit` | 用例完成后强制退出 | 泄漏文件从 10s 击杀变为即时通过；**不豁免 6.2 规约** |
| `--test-concurrency=N` | 文件级并行度 | 默认按 CPU；排查并发疑点时可设 1 |

> 历史案例：rtsp client-e2e/source 与 gateway relay/servers 曾因 relay 句柄未释放 +
> 看门狗定时器成功路径不撤销，整仓跑时文件级超时。2026-08-26 由 net-dev 分两批根治
> （dispose 句柄族 + 定时器撤销/unref + createSource 失败路径自动 stop）后，
> **全部文件无 flag 自然退出**（client-e2e 1.3s / source 2.6s / gateway 1.8s / rtmp 2.0s）。
> 此前一度误判为 undici WebSocket 上游问题（INFRA-FLAKY），实为定时器引用态叠加
> 审计窗口不足，该结论作废；`--test-force-exit` 保留为通用兜底而非特定缺陷的对策。

## 7. 开发服务器 serve.mjs

- `npm run demo` 或 `PORT=9000 node serve.mjs`；
- 支持**中文路径**（自动 decodeURIComponent）、**HTTP Range**（mp4/mov 流式拖动演示必需）、
  目录列表、HEAD；MIME 覆盖本项目全部媒体类型（m3u8/ts/flv/mkv/wav/flac/ape/srt/vtt/ass…）；
- 仅限本地开发使用，含路径穿越防护（normalize 后必须在仓库根内）。

## 8. 当前状态与分工

- 全仓门禁 = `npm run check`（fixtures → test → lint 串行 + 末尾门槛达标表）。
- 其余模块测试的失败归属见共享看板「任务台账」；fixtures 库问题找 sdet。
- **根文件（package.json / serve.mjs / scripts/*）所有权=sdet(t16)**；任何改动须
  captain+sdet 在看板报备协同后进行（leader 勘误帖#4 裁定，2025-08-25）。
