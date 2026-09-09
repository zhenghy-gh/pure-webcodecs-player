# 测试执行计划 — docs/test/TESTPLAN.md

| 项 | 内容 |
|---|---|
| 文档版本 | v1.2（2026-09-07 第二轮评审同步版） |
| 作者 | qa(测试工程师) |
| 日期 | 2026-08-25 |
| 台账任务 | T22（captain 台账）/ t11（overseer 台账 key=ledger） |
| 正式验收依据 | `docs/PRD.md` **v2.0** 第 3 章三段式条款(输入→期望→异常)+ 看板《每模块验收标准摘要表》(权威)；通用异常纪律 E1~E7 |
| 上游文档 | 《工程约定-v1》(根命令/fixture 约定)、《协作约定》、《roster-编制与归属》、任务台账 v2 |
| 配套文档 | 方法论基线=`docs/TESTPLAN.md`（三层验证模型/B01~B15 清单/门槛总表 565 例）；编号用例清单=`docs/test/用例集.md` |

---

## 1. 定位与文档关系

- 本文件是**执行层骨架**：测试策略矩阵 + 里程碑关口 + 环境与命令规范，随模块落地滚动更新版本号。
- `docs/TESTPLAN.md` 是**方法论与验收标准基线**：通用五件套 B01~B15、demo 静态检查规程 S-1~S-7、冒烟脚本 SM-1~SM-7、缺陷分级 P0~P3——本文直接引用不重复。
- `docs/test/用例集.md` 是**编号化用例清单**（每模块 正常路径 N / 损坏输入 C / 边界值 B 三类），M4 验收逐条打勾的唯一执行清单。
- 三份文档冲突时以 PRD §3 为准，qa 在看板登记口径问题并提请裁决（已有先例 Q1/Q2）。

---

## 2. 环境说明

| 项 | 要求 | 备注 |
|---|---|---|
| OS | macOS（当前开发机） | Windows/Linux 差异不在本期范围 |
| Node | >=22（engines 锁定），实测 v22.23.1 | `node --version` 先行核对 |
| 静态服务 | `npm run demo` → serve.mjs :8080 | 支持 HTTP Range / CORS 头 / 中文路径（mp4/mov Range 演示依赖它） |
| WS 测试网关 | `npm run gateway` → :8090 | POST `/publish/<name>` 推流 → `ws://127.0.0.1:8090/stream/<name>` 订阅二进制分块；推流示例见《工程约定-v1》§3 |
| fixtures | `npm run fixtures` → 各模块 `__tests__/fixtures/gen.mjs`（导出 `async generate(fixDir)`）+ `samples/generate-all.mjs` 总调度 | 产物被 .gitignore 忽略，必须可一键重建且两次重建 diff 为空 |
| 浏览器主验 | Chrome 最新稳定版：WebCodecs + MSE + AudioWorklet 必须 | WebCodecs 要求安全上下文，localhost 即满足 |
| 浏览器对照 | Safari（webrtc 回环 / 字幕渲染 / 能力矩阵差异）；Edge/Firefox 用于 README 能力矩阵抽查 | 能力矩阵由 qa 实测填写（PRD §2.4） |

---

## 3. 测试命令规范（⚠️ 含 E-6 实测结论）

**本机 node v22.23.1 实测（2026-08-25 qa 复核）：**

| 调用形式 | 结果 | 结论 |
|---|---|---|
| `node --test "hls/__tests__/"` （目录形式） | 仅产生 `# tests 1 / # fail 1`——把目录当模块加载，**一个用例都没跑** | ❌ 禁用 |
| `node --test "hls/__tests__/*.test.js"` （显式 glob） | 正常发现 23 例 | ✅ 唯一可用形式 |

**qa 标准命令集（写入所有脚本与文档）：**

```bash
# 分模块统计（唯一可靠形式：显式 glob）
for m in core mp4 mov flv ts wav hls mkv flac subtitle cmaf ape webtorrent webrtc rtmp rtsp; do
  [ -d "$m/__tests__" ] || continue
  echo "== $m =="
  node --test --test-reporter=tap "$m"/__tests__/*.test.js 2>&1 \
    | grep -E '^# (tests|suites|pass|fail|cancelled|skipped)'
done

# 全仓一键（根 package.json 已是 glob 写法，形式正确）
npm test            # node --test "**/__tests__/*.test.js"
npm run lint        # 语法+卫生检查
npm run fixtures    # 重建全部测试样例
npm run demo        # :8080 静态服务
npm run gateway     # :9090? 以 scripts/gateway.mjs 实际端口为准(:8090)
```

> 关口判定一律以"实际跑到的用例数"为准：若某命令输出 `tests 0` 或只有 `fail 1`，视为**基建故障**而非模块失败，立即按 §7 登记缺陷并 @sdet（E-6 类问题的复发监控归 qa）。

---

## 4. 里程碑测试关口定义（qa 判定口径）

| 关口 | 定义（captain 派发原文） | qa 具体判据 | qa 动作与产物 |
|---|---|---|---|
| **M1** | 五条根命令绿 | `npm test`(当时已有模块范围内 fail=0)、`npm run lint`(exit 0)、`npm run demo`(:8080 探测 200)、`npm run gateway`(:8090 端口可达)、`npm run fixtures`(exit 0 且产物生成) | 逐命令执行记录 exit code → 看板 `qa-report` 快照帖 |
| **M2** | `npm test` 全绿 + fixtures 可重建 | ①全仓 fail=0 且各模块实数 ≥ PRD v2.0 门槛（总表见 docs/TESTPLAN.md §5.3，合计 565；flv≥35/subtitle≥35）；②`npm run fixtures` 连跑两次 diff 为空（固定种子确定性）；③**probe 交叉矩阵无误判**——16 个 demuxer 的 probe 对其余容器样例一律返 null | CP-A 全量统计 → 看板 key=`qa-report`（16 行统计表+缺陷台账）；skip 必须有因 |
| **M3** | 端到端演示通过 | 每个 demo 页：静态服务打开 → 拖文件/输地址 → 解析出轨道信息 → 至少一条渲染路径可用；细化为：视频容器首帧后连续播放 ≥10s、音频模块真实出声、seek 关键帧对齐不花屏、MSE 兜底路径可用、webrtc 本地回环、site 汇总页可达；rtmp/rtsp e2e 为条件验收(gateway+上游前提)不阻塞主线但须留档；SM-4 四步冒烟(hls)、SM-5/SM-6(mock 网关/直连拒绝)、S-1~S-7 静态检查五元组全绿 | CP-B 逐页检查表 → 缺陷登记《qa-缺陷登记》并跟踪闭环 |
| **M4** | PRD 全量验收 | 按 `docs/test/用例集.md` 逐条验证：每模块 N/C/B 三类全绿 + B01~B15 基线 + reviewer 两轮清单修复回归完成 | 《验收报告》交 captain：总体结论+16 模块明细+能力矩阵实测+附加项 X1~X10+缺陷闭环表 |

> 口径兼容：pm 的 M0~M5 与 captain 台账 M1~M4 并存时，qa 以上表四关口绑定实质内容；对齐关系 M1≈pm-M0 出口、M2≈pm-M1+M2 解析器完成、M3≈pm-M1~M3 demo 就绪、M4≈pm-M5 收口。

---

## 5. 十六模块测试策略矩阵

> 每模块三列：①解析层单测(node --test) ②浏览器行为验证点(demo 手工/半自动) ③异常路径。详细覆盖点见 docs/TESTPLAN.md §6.A/C，编号用例见 docs/test/用例集.md。状态=2026-08-25 盘面。

| 模块 | ① 解析层单测重点 | ② 浏览器行为验证点 | ③ 异常路径 | 状态 |
|---|---|---|---|---|
| core | bit-reader/exp-golomb/byte-stream/nal/codec-string/capabilities/emitter/errors/clock-stats/demuxer-base 事件序 | demo 能力矩阵徽标页与 navigator/MediaSource/VideoDecoder 实际存在性逐一核对（Chrome+Safari） | Node 下探测恒 false 不抛；监听器抛错隔离；非法状态迁移 INVALID_STATE | ✅ 公共内核与 demo 已落地；浏览器能力矩阵按 M3/M4 手工执行 |
| mp4 | box 树含未知 box 跳过/sample table 交叉一致性/fragment 顺序/extradata 提取/Range 惰性读 moov | 拖入出 major brand+轨道表+box 树；MSE→WebCodecs→缺失清单三级降级；moov 后置 fixture | 截断/伪 size→PARSE_ERROR 不白屏；DRM(sinf) NOT_SUPPORTED | ✅ 解析层与 demo 骨架已落地；浏览器端到端按 M3/M4 手工执行 |
| mov | moov 后置/elst pts 修正/QT fourcc 映射/wide·skip·udta 容错 | pts 修正前后对比折叠区；ProRes 黄标"识别未解码"；udta 展示 | 大 mdat Range 回读内存受控；全景轨跳过 | ✅ 解析层与 demo 骨架已落地；浏览器端到端按 M3/M4 手工执行 |
| flv | tag 重组+PreviousTagSize 校验/sequence header·ASC/onMetaData/截断续传/ms→µs | 拖入出时长/宽高/编码/关键帧数+MSE 播放；ws-flv 无网关提示文案 | 半 tag 不崩；CodecID=12/FourCC 仅识别；时间戳回退钳制 | ✅ 解析层与 demo 骨架已落地；浏览器端到端按 M3/M4 手工执行 |
| ts | 188 同步+resync/PAT·PMT 多节目/PES 重组/PTS 回绕/ADTS 校验/PCR 统计 | program/PMT 树+轨道列表+PCR 抖动统计；program 切换；垃圾字节注入开关演示 | CA 加密节目提示；discontinuity warn 继续 | ✅ 解析层与 demo 骨架已落地；浏览器端到端按 M3/M4 手工执行 |
| wav | 四位深逐样本比对/EXTENSIBLE/chunk 容错/cue·INFO·PEAK | fmt 详情+波形图；播放/seek；四位深均可播；24bit+32f 试听无爆音 | ADPCM 已知限制提示；data 截断安全 | ✅ 解析层与 demo 骨架已落地；浏览器端到端按 M3/M4 手工执行 |
| hls | master/media 标签全集/AES-128 同构解密/直播窗口滑动收敛/BYTERANGE/畸形容错 | 三输入形态(URL CORS 文案/粘贴文本/内置 VOD)；VOD 完整可播；四步冒烟 | SAMPLE-AES NOT_SUPPORTED；live seek 受限 | ✅ 解析层与 demo 骨架已落地；浏览器端到端按 M3/M4 手工执行 |
| mkv | EBML vint 全边界/三种 lacing/Cues seek/SimpleBlock 负时间码/CodecID 映射全覆盖 | DocType/Track 表(映射失败标红)/Cluster 计数；首帧 Canvas 截图；seek50% 二次渲染比对 | 畸形元素不崩；zlib 头/加密识别提示 | ✅ 解析层与 demo 骨架已落地；浏览器端到端按 M3/M4 手工执行 |
| flac | 自产编码器往返法逐字节一致/CRC-8·16 篡改必报/STREAMINFO 边界 | STREAMINFO+SEEKTABLE+标签面板；MD5 徽标+解码耗时；播放/seek | CRC 损坏报 PARSE_ERROR；OggFLAC 限制提示；真实文件人工回归 | ✅ 解析层与 demo 骨架已落地；浏览器端到端按 M3/M4 手工执行 |
| subtitle | 三格式解析容错计数/双时间码/白名单标签布局数值断言(\pos·\an 九宫·\fs+) | 滑杆驱动实时渲染；\pos/\an 目测正确；未支持标签清单 | 白名单外标签不崩；重叠时间轴合并规则 | ✅ 解析层与 demo 骨架已落地；浏览器端到端按 M3/M4 手工执行 |
| cmaf | chunk 序序与边界/timecode 连续性/违规 fixture 准确报错/switching set 比对 | chunk 边界时间线+约束 pass/fail 列表；低延迟模式首帧耗时对比 | chunk 内多 moof 报错；CENC 识别提示 | ✅ 解析层与 demo 骨架已落地；浏览器端到端按 M3/M4 手工执行 |
| ape | HEADER 全字段边界/版本分支(<3980 拒绝)/APEv2 Tags/Seek Table 偏移（解析层硬门禁 ≥20） | HEADER 全字段+时长；支持规格播放；范围外显示支持范围矩阵 | 解码层软门禁：无 ffmpeg 时 skip 显示原因 | ✅ 解析层与 demo 骨架已落地；浏览器端到端按 M3/M4 手工执行 |
| webtorrent | bencode 往返/畸形拒绝/magnet/info-hash/piece 策略确定性/offset 映射/assembler 续组 | 离线解析文件树；模拟下载热力图+demux 轨道信息；真实 swarm 按钮灰显 | 损坏 pieces 重取(mock)；无 tracker 如实提示 | ✅ 解析层与 demo 骨架已落地；真实 swarm 按已知限制执行 |
| webrtc | 信令编解码往返/SDP mangle 断言/URL 约定/ICE 状态机迁移表 | 本地回环全链路真实播放(canvas→pc1→pc2→video)；信令日志+统计面板跳动；Chrome+Safari 双录 | ICE failed 排查提示；信令断开退避重连 | ✅ 信令/播放器与 demo 骨架已落地；浏览器回环按 M3/M4 条件验收 |
| rtmp | WS 帧编解码/粘包分包重组/退避状态机(定时器 mock)/错误码→文案 | 直连 rtmp:// 拒绝教育文案；mock 网关 canned 流完整播放；杀网关后退避重连可见 | 网关错误码映射；半途流复用 flv 容错 | ✅ WebSocket-FLV 桥接与 demo 骨架已落地；网关联调按 M3/M4 条件验收 |
| rtsp | interleaved/ASCII 交错/SDP 全字段/RTP 乱序重排/FU-A golden 三形态/AnnexB↔AVCC/SR 映射 | 直连 rtsp:// 拒绝文案；mock relay H264 上 Canvas+序号统计；乱序开关不花屏 | 丢包超阈值丢至关键帧；SR 缺失降级"—" | ✅ WebSocket 中继桥接与 demo 骨架已落地；中继联调按 M3/M4 条件验收 |
| site/samples(配套) | — | site 皮肤接入同构性(S-6)；PurePlay 品牌；DESIGN §12 九条抽查 | — | 🔄 三件套已落地 |

---

## 6. 执行节奏与产物

| 节点 | 触发 | 产物 |
|---|---|---|
| G1 | M1 到口 | 五命令快照帖（看板 qa-report） |
| G2=CP-A | M2 到口 | 16 模块单测统计表 → key=`qa-report`；缺口即登记缺陷 |
| G3=CP-B | M3 到口 | demo 页五元组检查矩阵 + 《qa-缺陷登记》开账 |
| G4 | reviewer 第 1/2 轮清单发布 | 对清单逐项做修复回归，结果附于《qa-缺陷登记》 |
| G5=M4 | 全部关口绿 | 《验收报告》交 captain（总体结论+明细+能力矩阵+X1~X10 附件+缺陷闭环表） |

---

## 7. 缺陷登记与闭环（看板笔记《qa-缺陷登记》）

- 格式：`ID / 模块 / 严重级(P0~P3，定义见 docs/TESTPLAN.md §3.2) / 复现步骤 / 状态(新→修复中→待回归→已闭环)`。
- ID 规则：`BUG-<序号三位>`，全局递增；同一缺陷的回归结论追加在该条目下，不改写历史。
- 预期行为不算缺陷（附录 A 十条：CORS 文案、直连拒绝、ProRes 黄标等）。
- 催办线：P0 超 24h 未指派，或同一问题催办 2 次无响应 → 上报 captain（无响应则报 leader，与协作约定一致）。

---

*维护人 qa · 本文为执行层策略矩阵；模块实现与评审进度以源码、模块测试和 `docs/review/round-1-问题清单.md` 为准。重大口径变化须同步本文并留痕。*
