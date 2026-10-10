# 100 轮持续优化记录

本记录只把有完整问题证据、成组实现和测试证据的轮次计为“实质优化轮”。自动 goal round 计数不等同于完成的工程优化；未满足标准的轮次明确标记为不计入。

## 计入的实质轮次

| 轮次 | 范围 | 结果 |
| --- | --- | --- |
| 12 | Subtitle track 并发消费链路 | 共享单一 pump，避免一次性 AsyncIterable 被并发重复消费；并发消费者和 cuesUntil 回归，18/18 + lint 通过。 |
| 14 | Subtitle cue → layout → renderer 边界 | 非有限 cue 时间边界过滤，非法时刻不再进入布局；字幕全套 325/325 + lint 通过。 |
| 15 | MKV Buffer/Blob/Fetch DataSource | 统一安全整数窗口、sum 溢出、零长度 EOF 和短读/OOB 契约；MKV 全套 222/222 + lint 通过。 |
| 20 | Gateway 聚合启动与生命周期 | 动态端口通过 ready 聚合返回实际端口；任一监听失败时统一回滚；dispose/close 幂等；CLI 等待全部监听成功后再输出地址；端口冲突与清理回归。Gateway 78/78、全仓 3128/3128、lint 547 文件通过。 |
| 23 | Subtitle track 原子泵送与失败语义 | 一次性 AsyncIterable 改为临时数组成功后原子提交，阻塞期间 cuesUntil 不再看到半成品；源失败不提交残留并稳定拒绝重复读取；并发单消费、codec 推导和缓存重放回归。Subtitle 328/328、全仓 3131/3131、lint 547 文件通过。 |
| 25 | RTMP 退避与网关源生命周期 | Backoff 拒绝 NaN/Infinity/负值、非法 factor/jitter 及 max/base 关系；GatewayChunkSource 连接失败/超时原子回滚 started/stopped/ws/timer，失败后可重试，stop 幂等。RTMP 全套 163/163、lint 547 文件通过。 |
| 29 | CMAF ISO-BMFF box 与 PRFT 完整性 | `readBoxHeader` 拒绝超出安全整数的 64-bit largesize；`parsePrft` 校验绝对 content 边界、v0/v1 payload 长度、正 timescale 与支持版本，避免截断数据伪造全零时间。新增恶意 largesize、截断/零 timescale/未知版本回归；CMAF 全套 109/109、lint 547 文件通过。 |

## 明确不计入

- 8：尝试后撤回，无有效改动。
- 11：subtitle/time.js 的 hours > 999 分支被正则不可达，不作为有效优化。
- 16、17、18：仅探索或未完成验证。
- 19：WebTorrent assembler 安全窗口修复虽然测试通过，但按“大颗粒度”标准仅为边界校验，暂不计入；后续可作为基础继续完整生命周期审计。
- 21：CMAF PartTimeline 状态迁移微改动与兼容性探索，未新增测试且暴露既有契约差异，已撤回。

## 只读审计记录

- 22：FLAC demuxer 链路审计，不计代码优化。现有 `buildFrameIndex` 已具备扫描上限、CRC 失败后重同步、共享 reader 与 AbortSignal 竞速保护；`demuxer-gaps` + `contract` 聚焦测试 14/14 通过，未发现第二个可证实的关联缺陷，未改文件。
- 24：MOV atom 兼容链路只读审计，不计代码优化。`iterateBoxes`/`parseUdtaTags` 对截断与恶意边界受控，文本 atom 长度和 `interpretEdits` 的非有限时间/零 timescale 已有保护；MOV 全套 134/134、lint 547 文件通过，未改文件。
- 26：APE MAC 头→APE tag→index 链路只读审计，不计代码优化。恶意 descriptor 长度返回受控 `PARSE_ERROR`，截断 tag value 已有 valueLen 钳制与边界测试；APE 全套 75/75、lint 547 文件通过，未改文件。
- 27：WebRTC stats.extractMetrics→StatsCollector→player 统计链路只读审计，不计代码优化。负 bytes 差分已有 Math.max(0) 保护；StatsCollector 重复 start 是否必须幂等缺少调用方契约证据，未安全修改；WebRTC 全套 158/158、lint 547 文件通过，未改文件。
- 28：TS TsStreamEngine→PSI/PES→flush/reset→ts-demuxer 链路只读审计，不计代码优化。截断 flush、超限 PES 丢弃后 PUSI 恢复、CRC 失败继续、PMT 换版与 reset 重流均已有保护；TS 全套 163/163、lint 547 文件通过，未改文件。

## 既有基础修复（尚未按大颗粒度轮次计数）

此前工作区还包含 HTTP Range、FLV 流式 PreviousTagSize、RTSP 初始失败状态、WAV、APE 等小范围修复。它们均保留并通过相应聚焦测试，但不把单个条件校验或单条回归测试包装成独立实质轮次。

## 验收规则

后续每个实质轮次必须包含：问题复现或代码证据、至少两个关联问题或一条完整链路、成组实现、多场景回归、模块全套测试和 lint。端口占用、网络不可用等环境问题必须与产品回归分开记录。
