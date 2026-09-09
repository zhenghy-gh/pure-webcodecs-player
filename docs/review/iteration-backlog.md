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
| 全仓测试 | `npm test` | 1094/1094，fail=0、cancelled=0（第五十七波基线） |

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
| 57 | webtorrent utils 补测 | `webtorrent/src/utils.js` 75%→达标（+15 例）；发现 `withTimeout` 未导出且零调用（死代码候选，待 owner 定夺） | 本波 |

---

## 5. 候选池（下一波从这里取，按优先级）

> 每波完成后更新：已做项划掉并写入 §4。

### 已完成
- [x] **P1** 接入 CI：`coverage-gate.mjs` 已加进 `.github/workflows/ci.yml`（第五十五波）
- [x] **P1** `iteration-scan.mjs`：聚合扫描器已落地（第五十六波）
- [x] **P1** 补测 `mp4/src/file-source.js` 56.7% → 达标出列（第五十六波，+12 例）
- [x] **P2** 补测 `subtitle/src/errors.js` 74.2% → 达标出列（第五十六波，+26 例）
- [x] **P1** 补测 `webtorrent/src/utils.js` 75% → 达标出列（第五十七波，+15 例）

### 待办（按优先级，下一波取 P1 第一条）
- [ ] **P1** 死代码处置（**待 owner 定夺**）：`webtorrent/src/utils.js` 的 `withTimeout` 未从 `index.js` 导出、全仓零调用——删掉 or 导出，二选一（第五十七波发现，已补测证明可用）
- [ ] **P1** 补测 `rtmp/src/flv-demuxer.js` **75.1%**（parser 层最差）
- [ ] **P2** 补测 `webtorrent/src/loader.js` 79%
- [ ] **P2** 补测 `core/src/exp-golomb.js` 82.2%、`core/src/data-source.js` 84.8%（core 门槛 85%，各差 2.8/0.2）
- [ ] **P2** 真机 e2e 回归脚本化：把 `docs/review/i3/` 的手工验证固化成可重跑脚本
- [ ] **P2** README 刷新：当前 README 未反映第 50-56 波（GitHub 首推、CI、契约对齐、分层门禁、迭代机制）成果
- [ ] **P3** 案 A 完全同构（**待 owner 裁决**）：mkv D1/D2/D3/D11/D4 收敛

> 注：候选池未达标项以 `node scripts/audit/iteration-scan.mjs` 实时输出为准（本表为快照，可能滞后）。
