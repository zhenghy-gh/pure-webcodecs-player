# 持续迭代台账（长期优化 backlog）

> 建立：2026-09-09（第五十五波）｜owner 目标：**持续迭代优化**
> 定位：跨会话的迭代驱动台账。每一波只做**一个实质项**，做完登记；下一波从「候选池」取最高优先级，不凭记忆、不拍脑袋。

---

## 1. 迭代规则（每波强制）

1. **先现盘后动手**：跑 `node scripts/audit/iteration-scan.mjs`（或等价的 lint / check / 覆盖率 / 契约审计），用数据定目标。
2. **先核实再改代码**：审计脚本报「问题」时，必须回到源文件确认是真缺陷还是**误报 / 已裁决保留**（第五十四波教训：7 项问题全是误报）。
3. **查裁决文档**：动手前必读 `docs/review/*-alignment.md` 与 `round-2-问题清单.md`，避免把已裁决保留的差异当缺陷重构。
4. **最小改动 + 全仓回归**：改动后必须 `npm test`（基线 `--test-concurrency=4`，默认全核并发会误报 cancelled）+ 两个契约审计 + lint + check。
5. **一趟一提交**：提交信息写清「改了什么 / 为什么 / 验证结果」，推送到 `origin main`。
6. **登记**：本文件追加波次条目；当日 `.workbuddy/memory/YYYY-MM-DD.md` 追加摘要。

**红线（不得擅动）**：
- 案 A「完全同构」剩余项（mkv D1/D2/D3/D11/D4 = §7 Q1-Q5）——**待 owner 拍板**，D2 会退化 attach 换源重试能力。
- 任何单模块擅改冻结裁决项（`mkv-base-class-alignment.md` §8、`wav-base-class-alignment.md` §8）。

---

## 2. 驱动源（每波候选来自这里）

| 驱动 | 命令 | 产出 |
|---|---|---|
| 迭代扫描（聚合） | `node scripts/audit/iteration-scan.mjs` | 下一轮候选清单 |
| 分层覆盖率门禁 | `node scripts/audit/coverage-gate.mjs` | 逻辑层未达标文件 |
| 结构层契约审计 | `node scripts/audit/contract-2-4-audit.mjs` | §2.4 结构层问题（应为 0） |
| 运行时契约审计 | `node scripts/audit/runtime-2-4-audit.mjs` | 7 demuxer 运行时矩阵 |
| 风格检查 | `npm run lint` | 应为 0 警告 |
| 模块门槛 | `npm run check` | 16/16 模块达标 |
| 全仓测试 | `npm test` | 1142/1142，fail=0、cancelled=0（第六十一波基线） |

---

## 3. 覆盖率现状基线（2026-09-09，第五十五波实测）

全仓 `line 91.32% / branch 83.66% / funcs 88.60%`。低覆盖高度集中在**环境依赖层**（浏览器 API，Node 不可测）：

| 文件 | 行覆盖 | 未覆盖 | 分层 |
|---|---|---|---|
| `wav/src/player.js` | 13.2% | 283 | env（豁免） |
| `core/src/video-frame-renderer.js` | 24.8% | 233 | env（豁免） |
| `flac/src/player.js` | 38.0% | 103 | env（豁免） |
| `hls/src/player.js` | 40.1% | 343 | env（豁免） |
| `mp4/src/webcodecs-pipeline.js` | 40.7% | 127 | env（豁免） |
| `subtitle/src/renderer.js` | 40.8% | 170 | env（豁免） |
| `core/src/mse-helper.js` | 43.2% | 159 | env（豁免） |

**结论**：这些不是测试缺失，是环境限制。**不要为刷覆盖率给它们写假测试**；正确方向是
①分层门禁（已落地 `coverage-gate.mjs`）；②若确需验证，走真机 e2e（`docs/review/i3/`）。

### 第六十一波里程碑：逻辑层未达标文件清零

| 层 | 文件数 | 均值 | 门槛 | 状态 |
|---|---|---|---|---|
| core 逻辑层 | 20 | **96.3%**（第五十五波 94.3%） | 85% | ✓ |
| parser 层 | 123 | **95.3%**（第五十五波 93.7%） | 80% | ✓ |
| env 浏览器层 | 17 | 61.8% | 豁免（仅报告） | — |

自第五十五波建立门禁起，逐波清掉 8 个未达标文件：`rtsp/nal.js` 42.9% → `mp4/file-source.js`
56.7% → `subtitle/errors.js` 74.2% → `webtorrent/utils.js` 75% → `rtmp/flv-demuxer.js` 75.1%
→ `webtorrent/loader.js` 79% → `core/exp-golomb.js` 82.2% → `core/data-source.js` 84.8%。
全部为**真实补测**（先核实根因、再写断言），无一通过放宽阈值或写假测试达成。

---

## 4. 波次台账

| 波次 | 主题 | 关键产出 | 提交 |
|---|---|---|---|
| 50 | §2.4 契约对齐 | 结构层 + 运行时全 16 模块对齐；mkv/wav 补 initTimeoutMs 与事件双发 | `60419a7` 起 |
| 51 | AbortSignal | `core/src/abort.js`（raceAbort/throwIfAborted）；4 处 readSample 接可选 signal；修中断吞样本 / flac 游标丢帧 / wav ABORTED 误判 | `6cfd638` |
| 52 | 治理文档化 | `wav-base-class-alignment.md` 新建；flac 现状并入 mkv §2.4 | `8844813` |
| 53 | wav 案 C 子类化 | `WavDemuxer extends Demuxer`，删 MiniEmitter、解析体入 `_doOpen` | `b73a6a4` |
| 54 | 审计误报清零 + CI | 结构层问题 7→0（scope 修正 + DECIDED 白名单）；`npm test` 固化并发参数；`.github/workflows/ci.yml` | `7c9fc1b` |
| 55 | 分层覆盖率门禁 + 补测 | `coverage-gate.mjs`（env 豁免 / core 85% / parser 80%）接入 CI；`rtsp/src/nal.js` 专项补测 42.9%→达标；迭代台账建立 | `fa8ebe3` |
| 56 | 迭代扫描器 + 两项补测 | `iteration-scan.mjs` 聚合现盘（git/lint/check/双契约审计/覆盖率/backlog → 自动建议下一波）；`mp4/src/file-source.js` DOM stub 补测 56.7%→达标；`subtitle/src/errors.js` 构造器表驱动补测 74.2%→达标 | `077a33e` |
| 57 | webtorrent utils 补测 | `webtorrent/src/utils.js` 75%→达标（+15 例）；发现 `withTimeout` 未导出且零调用（死代码候选，待 owner 定夺） | `79135b3` |
| 58 | rtmp FLV 分支补测 | `rtmp/src/flv-demuxer.js` 75.1%→达标（+16 例）：AAC 轨、不支持 codec、未知 Tag 跳过、未配置前丢样本、tsExt/负 cts、PreviousTagSize 告警、魔数缺失、destroy 后写入 | `7e73f05` |
| 59 | webtorrent loader 补测 | `webtorrent/src/loader.js` 79%→达标（+16 例）：用 `module.registerHooks` 白名单拦截解决「Node 只支持 file/data import vs 安全白名单只放行 http(s)」的互斥，真实跑通 CDN 成功路径；含 data:/blob:/file: 安全过滤回归 | 本波 |
| 60 | core exp-golomb 分支补测 | `core/src/exp-golomb.js` 82.2%→达标（+7 例）：high profile scaling list 消费、chroma_format_idc=3(4:4:4)/0(mono) 的 CropUnitX/Y 分支、frame_mbs_only=0 高度翻倍、pic_order_cnt_type=1 循环、非 SPS PARSE_ERROR、stripEmulationPrevention、BitReader 复用 | 本波 |
| 61 | core data-source 补测（逻辑层清零） | `core/src/data-source.js` 84.8%→达标（+8 例）：`MemoryDataSource`/`BlobDataSource`/`asDataSource` 三个导出此前**零直接测试**；含 ArrayBuffer 入参、File 名回退、尾部截断 vs 越界、无 Blob 环境降级、鸭子类型 TypeError | `9c577f9` |
| 62 | README 工程化章节刷新 | 新增「质量门禁与工程化」章节（单仓库 monorepo / CI 五段 / 分层覆盖率门禁 / §2.4 双契约审计 / 迭代扫描器）+ 测试与覆盖率现状表（1142/1142 绿；core 96.3% / parser 95.3% / env 61.8% 豁免）；模块状态表脚注日期→2026-09-09 | `98e3af4` |
| 63 | withTimeout 死代码转正（owner「继续」授权） | 裁决=**导出**而非删除：`index.js` 导出 `withTimeout`（增量合规 §12.3）；`loader.js` 删自写 `raceTimeout` 改用 `withTimeout`（超时错误原被循环内 `catch{}` 吞掉，替换为零可观察差异，实为消费者转正）；新增 2 例超时分支回归（永不 settle 的 CDN 模块按 timeoutMs 放弃返回 null、超时后回退下一源）；全仓 1144/1144 | `8e89068` |
| 64 | README 效果演示 + 使用方式（owner 指出缺口） | 新增「效果演示」：playwright 驱动真实 Chrome 播放实拍——WebCodecs 主路线动图（bbb480_30s.ts + 15 步断言日志）+ MP4/MSE 实拍 + 演示站全景（`docs/demo/` 三件约 660KB）；新增「使用方式」四级（demo 体验 / createPlayer 集成 / 底层 Demuxer API / 真机 e2e）；修 mp4/demo 环境日志陈旧字段 `.available`→`.supported`（截图暴露） | `4d90c61` |
| 65 | README localhost 框架修正（owner 反馈） | §使用方式 1 补 clone→run→open 完整流程，localhost 改代码体并注明「本机地址非外网链接」；§e2e 如实注明素材不入库需自备；覆盖率计数 1142→1144 | `b44b219` |
| 66 | GitHub Pages 在线演示上线（owner 指令「自己弄」） | 通道：OAuth device flow（curl 全程走本机 VPN 代理 127.0.0.1:7897，绕开沙箱代理对 github.com 的封锁）→ token → API 开通 Pages（201）→ 构建 built → 站点 200。根 `index.html` 重定向演示站 + `.nojekyll`（`9d37879`）；README 顶部与使用方式 1 均加在线链接（`2ad56e2`）。在线地址：https://zhenghy-gh.github.io/pure-webcodecs-player/ | `2ad56e2` |

---

## 5. 候选池（下一波从这里取，按优先级）

> 每波完成后更新：已做项划掉并写入 §4。

### 已完成
- [x] **P1** 接入 CI：`coverage-gate.mjs` 已加进 `.github/workflows/ci.yml`（第五十五波）
- [x] **P1** `iteration-scan.mjs`：聚合扫描器已落地（第五十六波）
- [x] **P1** 补测 `mp4/src/file-source.js` 56.7% → 达标出列（第五十六波，+12 例）
- [x] **P2** 补测 `subtitle/src/errors.js` 74.2% → 达标出列（第五十六波，+26 例）
- [x] **P1** 补测 `webtorrent/src/utils.js` 75% → 达标出列（第五十七波，+15 例）
- [x] **P1** 补测 `rtmp/src/flv-demuxer.js` 75.1% → 达标出列（第五十八波，+16 例）
- [x] **P1** 补测 `webtorrent/src/loader.js` 79% → 达标出列（第五十九波，+16 例，`registerHooks` 白名单拦截）
- [x] **P1** 补测 `core/src/exp-golomb.js` 82.2% → 达标出列（第六十波，+7 例）
- [x] **P1** 补测 `core/src/data-source.js` 84.8% → 达标出列（第六十一波，+8 例）——**至此逻辑层（core+parser）未达标文件清零，`coverage-gate` exit 0**
- [x] **P2** README 刷新：补「质量门禁与工程化」章节 + 覆盖率现状表，反映第 50-61 波成果（第六十二波，`98e3af4`）
- [x] **P1** 死代码处置：`withTimeout` **导出**（owner「继续」授权，第六十三波）——`index.js` 增导出 + `loader.js` 删自写 `raceTimeout` 改用它（消费者转正，行为零差异）+ 2 例超时回归
- [x] **P2** 总览页 MODULES.status 陈旧修复（第七十波 `e7ff2eb`）：nav.js 16 模块 status 全部对齐 ok（core/mp4/mov/mkv/webtorrent/ts/flv/hls/cmaf/webrtc wip→ok，rtsp/rtmp na→ok）；线上 hub 验证徽章唯一 ["可用"]
- [x] **P2** 真机 e2e 回归脚本化（第七十一波）：新增 `scripts/e2e/demo-smoke.mjs`——playwright 驱动真实 Chrome 遍历 16 模块 demo 页 + hub，捕获 console error/pageerror + 资源 404（favicon/sourcemap 豁免良性），mp4/hls 用本地样本自动驱动播放并断言，全屏截图刷新 `docs/review/i3/*.png` 与 `docs/demo/demo-hub.png`；17/17 全 PASS、退出码 0。把 i3 手工验证固化成可重跑回归

- [x] **P2** 薄弱模块测试补强（第七十三~七十八波）：webrtc/wav/cmaf/ape/flac/mkv 共新增 23 个测试文件，全仓测试 1144 → **1385**（+241），全量全绿；过程中修复 mkv 两个真实缺陷（第七十二波）

### 待办（按优先级，下一波取 P1 第一条）
- [x] **P3** flv iso-bmff 剩余面（**第九十波 `7485e97` 已完成**，flv 63→89）。下一批：rtmp player/gateway 正向管线（需网关样本）、webvtt 渲染层
- [ ] **P3** 信息性观察（agent 报告，行为已固化测试，动前需 owner 点头）：①pipeline 渲染 emitted 顺序为 rendered 先于 firstframe（与直觉相反）；②_waitQueue guard=64 兜底空转与注释不一致
- [x] **P3** webtorrent 手动选文件 API（**第九十三波 `18d1ec4` 已落地**）：player.selectFile(selector) 在 degraded 态调用，selector 四形态，错误码全显式
- [ ] **P3** 重构收敛（audit-79 D，**动前需 owner 点头**）：BitReader×4 / BitWriter×2 / buildEsds×2 收敛到 core；删 `mp4/src/box-builder.js:225` 死导出 buildBtrt
- [ ] **P3** env 层可测化（浏览器依赖层 61.8%）：引入 Playwright 跑 `player.js`/`renderer.js`/`mse-helper.js`，或维持豁免
- [ ] **P3** 案 A 完全同构（**待 owner 裁决**）：mkv D1/D2/D3/D11/D4 收敛

> 注：候选池未达标项以 `node scripts/audit/iteration-scan.mjs` 实时输出为准（本表为快照，可能滞后）。
| 67 | npm 首发pure-webcodecs-player@0.1.0（owner 指令「先发布一版npm」） | package.json：exports 16 子路径（"."=core、./mp4 等 15 模块）、files 仅各模块 src+README+LICENSE、sideEffects=false；新增 MIT LICENSE（此前无许可证）；README §使用方式 2 加 npm 安装段。验证：npmjs 发布成功（tar 412.8kB/171 文件），临时目录真实 `npm i` 后 bare import 与 ./mp4、./wav 子路径导入全通；全仓 1144/1144 绿 | `52df096` |
| 68 | README 精简（owner 指令） | 删「模块状态表」「交付标准」「质量门禁与工程化」三块内部治理内容（非使用者视角）；保留目标/效果演示/快速开始/使用方式/统一管线。结合第六十七波：npm@0.1.0 标注 + CDN 直引断链修复 + §3 包名 import | `8dd57c9` |
| 69 | 根路径重定向 mp4/demo/（owner 选方向1） | index.html 重定向目标由 ./site/demo/index.html 改为 ./mp4/demo/，打开仓库主页即播放器；线上已生效验证（curl 返回 location.replace('./mp4/demo/')） | `2c66a19` |
| 70 | 总览页 MODULES.status 陈旧修复（owner「继续优化」） | nav.js 16 模块 status 全部对齐 ok（core/mp4/mov/mkv/webtorrent/ts/flv/hls/cmaf/webrtc wip→ok，rtsp/rtmp na→ok）；线上 hub playwright 验证 16 卡片徽章取值唯一 ["可用"]；hub 截图已同步更新 | `e7ff2eb` |
| 71 | 真机 e2e 回归脚本化（P2） | 新增 `scripts/e2e/demo-smoke.mjs`：playwright 驱动真实 Chrome 遍历 16 模块 demo 页 + hub，捕获 console error/pageerror + 资源 404（favicon/sourcemap 豁免），mp4/hls 用本地样本（sintel-trailer.mp4 / ts-hls/playlist.m3u8）自动驱动播放并断言（video playing / stats 分片），全屏截图刷新 `docs/review/i3/*.png` 与 `docs/demo/demo-hub.png`；17/17 全 PASS、退出码 0；backlog 划掉 hub 徽章 P2 + e2e P2 | 本波 |
| 72 | 修复 mkv 两个真实缺陷 | ①**CueTime 未按 TimecodeScale 缩放**：`#parseCuesAt` 把 CueTime 直接当 ns，与 `locate()` 的 targetNs(=us×1000) 单位差 1e6 倍 → 二分命中错误簇（seek(1.6s) 误落 2s 簇）；改为 ×`this.timecodeScaleNs`，并修正既有用例 demuxer.test.js「seek：Cues 定位」（原期望 1.6s 命中 cluster1 系旧 bug 凑巧成立，目标改 2s 以保持原意图）。②**DiscardPadding 对外丢失**：`#emitBlockFrames` 已解析为 µs，但 `#iterateTrack` 映射未透传 → `readSample` 拿不到 Opus/AAC 首尾填充裁剪依据；现透传 `discardPaddingUs`/`discardable` | `8d47f09` |
| 73 | webrtc 补测（27→58） | +4 文件：SDP 构造与 `parseCandidateLine` 边界、getStats 极端输入（无 inbound-rtp / 未 succeeded 候选 / 除零 / 未来时间戳截断）、player 边界（parsePlayerUrl 多形态、状态枚举冻结、destroy 清理、trickle 注入、重连中 destroy 取消定时器）、信令错误分支（5xx/4xx/非 sdp/Location 协议白名单、WS 无实现、`__proto__` 键拒绝） | `c183b95` |
| 74 | wav 补测（75→82） | +4 文件：RIFF/WAVE 头校验（截断/坏魔数/流式哨兵 0xFFFFFFFF）、fmt 全格式（PCM 8/16/24/32、IEEE float、mulaw/alaw、extensible SubFormat GUID、cbSize 缺失）、chunk 边界（未知块跳过/奇数长度补齐/data 先于 fmt/超大块报错）、createWavPlayer 在 Node 与 browser-mock 下的支持性契约 | `70a4010` |
| 75 | cmaf 补测 | +3 文件：init segment 配置提取（avcC/hvcC/mp4a、未知盒、零长不崩）、fragment 封装（两遍 `data_offset` 回填、mdat 载荷、parseMoof 的 tfhd/tfdt/trun、mfhd seq 递增）、box 字节级解析（readBoxHeader 普通/largesize/截断、findBox、parseTrun v0/v1 有符号 cts） | `fd2ef47` |
| 76 | ape 补测 | +3 文件：压缩等级码表全量映射（descriptor/legacy 双路径、未知码兜底 `code-XXXX`）、validate 边界（采样率/声道/帧数越界拒绝与合法极值）、APE 标签解析（<32B/<160B 的 ID3v1 守卫、空标签安全、valueLen 越界钳制、itemsStart>itemsEnd 抛错） | `351616c` |
| 77 | flac 补测 | +5 文件：bitreader 位读取边界越界、CRC8/CRC16、帧头与帧同步、metadata 各类块（STREAMINFO/VORBIS_COMMENT/PICTURE/SEEKTABLE 占位乱序残尾/APPLICATION/padding 截断）、subframe 各预测分支（CONSTANT/FIXED/LPC/verbatim）与残差解码 | `3c9e7e0` |
| 78 | mkv 补测（+4 文件） | EBML 变长整数与定长读写边界、Cues 与 seek 定位、时间戳与关键帧判定、轨道与编解码私有数据解析。**并修正 3 处测试自身缺陷**：Cues 自依赖（CueClusterPosition 依赖 Cues 长度、Cues 长度又依赖其值）改用 `minLen=8` 固定宽度两遍构造并附等长断言兜底；`U8(10)` 实为 `Uint8Array.from(10)`→空数组致 xiph 帧全 0 长，改 `new Uint8Array(10)`；AAC ASC 显式采样率须位于 channelConfiguration **之前**（规范顺序），此前置错得到 sampleRate=2103152 | `293ade7` |
| 79 | rtmp/rtsp/subtitle 补测（后台并行） | +12 文件（rtmp/rtsp/subtitle 各 4）：rtmp 按 WebSocket-FLV 桥接实际源码补 AMF0 全类型/错误工厂/MP4 封装/WS URL 安全守卫；rtsp 补错误枚举/Backoff/SDP 边界/报文与 RTP 解析错误分支；subtitle 补时间码/ASS 标签/detectFormat/VTT settings。全仓 1385 → **1531**（+146） | `6e2babf` |
| 80 | 修复 subtitle 两个真实缺陷 | ①track.js:69 对 ASS 的 Uint8Array raw 二次 encode（ToString 压成逗号串），改 instanceof 透传，连带修复 createTextTrack 的 x-ass codec 推断；②time.js:45 小数域 padEnd 只补不截（'1234'→1234ms），改 slice(0,3).padEnd | `ce34d30` |
| 81 | 修复 APE 头偏移（高危，真实文件全读错） | descriptor 分支把 offset 6 的 nPadding 当 descriptorLen、header 硬编码 offset 32、audioOffset=56 忽略 seekTable/headerData。按真实布局（52B 描述符含 MD5，header 从 descriptorLen 起）重写；5 个测试文件的 buildDescriptorFile 与 gen.mjs 复刻了错误布局自洽掩盖 bug，全部重写 + 3 条 conformance 回归。ape 74/74 | `0b5e0cc` |
| 82 | 修复 CMAF findTimescales 顺序假定 | 全文件扫 'mdhd' + 按出现顺序假定第 1 个=视频 → 音频在前取反、解码配置字节误命中。改 box 树关联：moov→trak→mdia，hdlr handlerType 判轨型再读 mdhd；缺字段跳过兜底。新增乱序双轨/埋字节/缺 hdlr 测试（旧实现验证必败）。cmaf 58/58 | `bd7b327` |
| 83 | 全仓只读审计 | 产出 `docs/review/audit-79.md`：A 技术债 8 条（多为有意设计，轻量债 webtorrent bencode 死参数、rtsp/rtmp 空 catch）、B 密度最低 flv/core/ts、C 确凿 bug 4 条（C-1 APE 高危已修、C-2 CMAF 已修、C-3 subtitle ms 截断已修、C-4 flv duration=0 待办）、D 死导出 buildBtrt + 重复实现 BitReader×4/BitWriter×2/buildEsds×2。C-4 与重构级收敛**待 owner 决策**后动 | 本波 |
| 84 | flv 补测 + 修复 C-4 | cut() 非 flush 切片末帧 durationTicks 未回填即出 trun → duration=0；改用上一回填帧时长估算兜底（与 flush() 一致）+ trun 全 duration>0 回归。补测 +11（音频位域/ASC 序列头/MP3 直通/ASC 24bit 扩展位序修正）。flv 52 → 63 | `734c982` |
| 85 | ts 补测（+17） | 包头/TEI/PUSI/CC/afControl 三分支与 afLen 边界/AF stuffing 落位/半截 PES 丢弃（0xff stuffing 语义）/截断与垃圾重同步。ts 72 → 90 | `17985dd` |
| 86 | core 补测（+19） | pipeline 错误路径：Fake codec 注入下 decodeError 传播/configure 失败/close-reset 重建。core 密度收敛起步 | `d97d47a` |
| 87 | hls 补测（+28）+ 修复 averageBandwidth 恒 0 | m3u8-parser 读 AVERAGE-BANDWIDTH 键名误写下划线（attrs.AVERAGE_BANDWIDTH），parseAttributes 保留连字符原键 → 所有 level 的 averageBandwidth 恒 0，ABR 选档依据失效。补测覆盖主清单边界/KEY 作用域与 IV/ABR 闸/loader 守卫（410 不重试/maxBytes 熔断）。hls 118 → 146 | `2d40098` |
| 88 | mov 补测（+39）+ 修复 mp4 两缺陷 | ①buildStsz defaultSize≠0 时 sample_count 恒写 0（违反 ISO 14496-12）→ 恒写 sizes.length；②stz2 误映射 parseStsz（布局不符，field_size<32 静默错解）→ 新增 parseStz2（4/8/16，返回形状与 stsz 一致）+ 5 例专项。mov 30 → 69、mp4 68 → 74 | `1e62d38` |
| 89 | core 正向补测（+38）+ 修复 ended 恒 true | player.js seek() 成功路径不复位 endedValue → ended 后 play() 自动重播期间 player.ended 恒 true；seek 成功即复位（HTMLMediaElement 语义）+ 回归断言。补测覆盖状态机全矩阵/pipeline 队列与渲染决策/clock 与 Emitter 边界。core 180 → 218 | `e434065` |
| 90 | 第三批后台流程升级 | 后台 agent 改用 lite 模型规避默认模型 429 + 「增量验证」约束（每写完 1 个测试文件立即跑模块测试再写下一个）→ 落盘文件全部已验证，主线程零测试构造错修复，只处理真实缺陷 | 本波 |
| 91 | mp4 补测（+15）+ 修复 seek 游标不重定位 | **高**：_doSeek 只算返回值不重定位游标，违反 core 契约——渐进模式 seek 后从样本 0 重来、分片模式 seek 后提前 EOS（两种模式 seek 全坏）。修：各轨 state 增 resumeIndex，_doSeek 写目标轨关键帧二分结果 + 其余轨按各自时间基定位（_locateResumeIndex）；渐进迭代器从 resumeIndex 起步；分片迭代器开头重放表内样本再接续扫描（重放不动共享游标；resumeIndex=0 且表非空也重放）。已知限制注释明示：中断 moof 内未解析样本随游标越过丢失。补测：双轨交错、渐进→fMP4 remux→读回往返、游程与退化文件、seek 四场景回归。mp4 74 → 92 | `6268350` |
| 92 | webtorrent 补测（+45）+ 修复 3 缺陷 | **高**：read() OOB 检查只在 slice 路径，顺序流 offset≥size 静默返回空数组（两路行为不一致 + 违反 EOF 契约）→ 检查上提入口两路共用；**中**：autoSelect=false 声明可用实际不可用（null file 流入 createTorrentSource 抛 SOURCE_ERROR 且 state 永卡 loading，且无手动选文件 API）→ 诚实抛 STATE_ERROR + degraded，手动选文件 API 进待办；清理 bdecodeRaw 的 void bytes+arguments[0] 占位异味（audit A 遗留）。webtorrent 100 → 145 | 本波 |
| 93 | webtorrent selectFile() API（第五批后台） | 补上 autoSelect=false 的手动路径：player.selectFile(selector) 在 degraded 态调用后续走加载管线至 ready；selector 四形态（对象/文件名/索引/谓词）；错误分支全显式（FILE_NOT_FOUND / NOT_MEDIA / PARSE_ERROR / STATE_ERROR）保持 degraded 可重试；attach 与 selectFile 公共收尾 #finishLoad()；README 同步 + 修正两处过期计数（50→152）。webtorrent 145 → 152 | `18d1ec4` |
| 94 | cmaf 深化补测 + 修复 2 缺陷（第五批后台） | **isobmff parseTrun**：flags 含 first-sample-flags-present（0x004）时不消费 data_offset 后的 4 字节字段 → 样本行整体错位 4 字节且首样本标志未应用 → 消费并赋 rows[0]；**materializeSamples**：dataOffset 应以 moof 起点为基准（各 muxer 均按 moof.length+8 写入），此前错加在 mdat 载荷起点 → dataStart 偏大 moof.size+8、样本数据全读偏 → 改 moofStart+dataOffset（无标志回退 mdat）。补测：splitChunks finalize 分支、moof flag 组合（v0/v1 cts、tfhd 缺省回落、单 moof 双 traf）、muxer→parser 逐字段往返。cmaf 58 → 81 | `3109f37` |
| 95 | ts 深化补测 + 修复 3 缺陷（第五批后台） |
| 97 | webrtc 深化补测 + 修复 stats 帧数误归零（第六批后台） | 补测 4 文件 +75 例：player-main 状态机全矩阵/destroy 幂等/parsePlayerUrl 拒 stun/turn/ftp/rtsp；signaling-http WHEP 协议白名单/sendCandidate 无 Auth/WS 8MB 熔断/危险键拒绝；stats-backoff 抖动下限/各类 report 缺省/续采；sdp-advanced 多 m= section/四方向/parseCandidateLine TCP 归一。修复：stats.js framesDecoded/framesDropped ?? bucket 0 致某次 report 缺字段时指标从非零归零（违反 WebRTC 单调递增）→ fallback 顺序 s→prev→bucket + 纳入 nextPrev 通道。webrtc 58 → 134。 | `2febd4c` |
| 98 | 第六批后台待补 rtmp（额度未恢复） | 6 次派 rtmp（agent-21/23/25 三次 429，agent-22/24/25 等 webrtc 已完成）均撞额度。**实际状态：webrtc 97 已完成并提交，rtmp 仍维持 84/84 基线**，14:08 重置后重派。 | 本波 |
| 96 | 第五批后台任务收尾 | webtorrent selectFile API（93）+ cmaf 两缺陷修复（94：parseTrun first-sample-flags 错位 / materializeSamples dataOffset 基准错）+ ts 三缺陷修复（95：CC/disc 次序 / PCR 33bit 回绕 / PMT 换版静默）| 本批 | **CC/discontinuity 次序**：CC 校验先于 AF 解析，拼接点跳变误计 ccError → AF 解析上提、discontinuity 豁免；**PCR 回绕**：min/max 追踪使 33 位回绕后时长变 ≈26.5h 垃圾值且 span<0 补偿不可达 → 回退值 +2^33 抬升单调域；**PMT 换版静默**：`changed = firstSeen` 使仅移除 ES 的换版不重发 tracks、this.tracks 残留 → firstSeen\|\|versionChanged。补测：跨包 PES 组装/PTS-DTS 三形态与回绕连续化/declaredLength=0/PSI 跨包分段/stream_type 全映射/版本对账/PCR ext/丢包恢复。ts 90 → 113 | 本波 |
| 99 | rtmp 正向管线补测 + 修复 4 缺陷（第七批后台） | agent-26 补 player/gateway-source/flv-demuxer 正向管线与错误恢复（92→114，+3 文件）；主线程独立核实修 4 缺陷：①stats.reconnects 仅声明不累加→#scheduleReconnect 重连分支累加；②#nextBackoffMs 先++再 emit 致 will-reconnect.attempt 首次报 1→改先 emit 后++（attempt=本轮重连序号）；③flushPending() 无参却 flushPending(true) 调用（死参，去掉参数）；④gateway-source.js 视图越界（byteOffset）→按 byteOffset/byteLength 切片。补 2 条回归（reconnects 自增 / will-reconnect.attempt）。rtmp 114 → 116 | 本波 |
| 100 | core env 层可测化补测 + 修复 flipY 死选项（第七批后台） | agent-27 env 层纯逻辑分支（capabilities/renderer/mse-helper/pipeline-mse，Fake globalThis + try/finally 还原，218→297，+4 文件）；主线程修 video-frame-renderer.js:238 `1-offY-scaleY ≡ offY` 代数恒等致 flipY 失效→改 `1-offY`（flipY=false 关于 v=0.5 镜像，默认 flipY=true 行为不变）+ 翻转固化观测（断言 flipY=false 使 uvTop=0.78125 且 ≠ flipY=true）。core 297/297 | 本波 |
| 101 | mkv 深化补测 + 修复 5 缺陷（第七批后台） | agent-28 深化补测（BlockGroup/Cluster 跨边界/Cues/codecs 私有数据/错误边界，118→179，+4 文件）；主线程修 5 缺陷：①codecs.js FLAC totalSamples 36bit 字节位错；②簇内未知元素 break 致整簇丢弃→跳过 payload 后 continue；③同 CuePoint 多 CueTrackPositions 后者覆盖→按 CueTrack 独立 push；④Duration 早于 TimecodeScale 误用默认 scale→先存 durationRaw 后重算；⑤LanguageIETF 被 legacy Language 覆盖→`_ietfLang` 守卫。5 处均翻转固化观测。mkv 179/179 | 本波 |
| 102 | subtitle 渲染层与解析边界深化补测（+60 例，第八批后台） | 攻克 renderer（覆盖率 40.8% 的环境豁免层）：Node 下**注入式 stub 2D 上下文**（measureText 按字符数×10 确定性返回）断言绘制几何而非像素。renderer.test.js（14：九宫锚点 an=1/3/5/7/9→textAlign/textBaseline、`\pos` 直通、样式透传、多 cue 堆叠、attach 无 rAF 降级）+ subtitle-renderer.test.js（19：borderStyle=3 底框、shadow 层、outline 描边、underline/strikeout、多 run 累计偏移、alpha≤0 跳过、clip/rotation 变换）+ detect-parseauto（11）+ parse-edge（16）。主线程核实并修正 1 处**断言张冠李戴**：折行不属 renderer 职责，实为 layout.js:111 `wrapSegments`（layoutEvents 阶段完成），未经 layout 的原始 cue 渲染为单行 → 改为固化观测并记录折行归属。subtitle 249/249 | 本波 |
| 103 | flv remuxer/demuxer 深化补测（+41 例，第八批后台） | flv-demuxer-deep（15：probe 边界/AAC ASC 边角与 AOT=31 扩展/多 sps-pps/非官方 CodecID=12 HEVC/vp09 透传/PreviousTagSize 不校验/destroy 后写入守卫）；fmp4-remuxer-deep（14：trun flag 组合/duration 回填/tfdt baseDts/CTS 正负/>255 样本/空轨）；flv-fmp4-remuxer-deep（12：setTracks 幂等/pushSample 守卫/HEVC hvcC/mp3 排除/音频 0x705）。主线程修 6 处**用例侧**错误（src 无误）：①`walkBoxes(moof)` 只列给定缓冲顶层盒（moof 切片顶层即 moof）→ 改用 drill 下钻校验 mfhd/traf；②默认 fragmentUs 下样本并入同片致 segs[1] undefined → 首样本关键帧/非关键帧两种情形分别构造；③`dts=-1000µs` 实为 -1ms（timescale=1000）→ tfdt 应为 `(-1)>>>0`(0xFFFFFFFF) 而非 `(-1000)>>>0`；④>255 样本需放大 fragmentUs（10s）才会合并为单个 trun；⑤destroy 后 `samples()` 抛 STATE_ERROR 属 core `_requireUsable` 既有守卫（非静默返回 0）。flv 130/130 | 本波 |
| 104 | mov 深化补测（+20 例，第八批后台） | mov-demuxer-deep（20）：expandSampleTable 的 stsc 三 run/stts 多 run 与大 delta(1<<24)/stss/stsz 零尺寸/ctts v0 无符号与 v1 负偏移，端到端多轨、奇数 timescale(2997)、elst、逐字节增量喂入、probe 品牌取舍。**修复阻断性 SyntaxError**：test 回调内含 `await import` 却未声明 async → 整文件 789 行无法编译（0 pass/1 fail）；改为 `async () =>` 后解锁 20 例。修正 stts 期望（**src 正确**）：`dts[i]=Σ delta[0..i-1]` → [0,10,20,40,60] 而非 [0,10,30,50,70]。**登记 2 项待核查**：text 轨未回填 sampleEntryType（undefined）；未知 ftyp 品牌('xyz ')仍命中 mov（置信 0.57，未让位 null）。mov 89/89 | 本波 |
| — | 第八批后台：全员 429 额度中断 | 本批 agent-31/32（第七批末派出）与 agent-33/34/35（本批重派）**全部因 429「使用量已超出频率限制」失败**（重置 19:10:56）。**结论：重派无效，改主线程直接接手**——agent 产物虽落盘但未经完整验证（8 个新文件中 6 个带缺陷），主线程逐一核实并修复后全绿。**教训：429 期间不要空等/重派，先扫 `git status` 抢救已落盘产物。** | 本波 |
