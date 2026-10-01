# 持续优化进度

## Round 1/100
- 目标：拒绝不符合 RTP 填充格式的输入包。
- 改动：`rtsp/src/rtp.js` 对 padding 标志要求存在计数字节、padding 长度非零且不超过载荷长度；`rtsp/__tests__/rtp.test.js` 增加空载荷及零计数回归。
- 验证：基线全量测试 3086/3086；改动后定向测试 6/6、全量测试 3087/3087、lint 通过；`npm run check` fixtures、test、lint 全通过；`git diff --check` 通过。
- 指标：全量测试由 3086 增至 3087；测试失败 0；lint 检查 564 个 JS 文件。
- 风险：无已知行为风险；合法 RTP padding 行为保持不变。工作区另有用户既存修改，本轮未触碰、未纳入提交。
- 假设：以本次自动循环自身作为 1/100 计数；项目现存优化 backlog 的历史编号不作为本轮计数。遵守用户既有偏好，每轮单独提交并继续。
- 下轮计划：扫描 RTP/传输解析器的邻近边界，优先修复可稳定复现的输入校验缺口。

## Round 2/100
- 目标：防止 ByteStream 的负长度读取返回错误切片并倒退游标。
- 改动：`ByteStream._need()` 要求读取长度为非负整数；`byte-stream-gaps.test.js` 覆盖 `readSlice(-1)`、`peekSlice(-1)` 抛 `SOURCE_ERROR` 且游标不变。
- 验证：定向测试 9/9；`npm run check` fixtures、全量测试、lint 均通过；`git diff --check` 通过。
- 指标：全量测试 3088 项通过；错误输入不会修改位置。
- 风险：调用方传入非整数或负读取长度将明确报 `SOURCE_ERROR`，符合字节长度契约。
- 下轮计划：继续检查解析器输入长度与资源上限的边界行为。

- 下轮计划：继续检查解析器输入长度与资源上限的边界行为。

## Round 4/100
- 目标：确保 AVCC NAL 长度字段配置有效，且编码长度可由指定字段宽度表示。
- 改动：`avccToNals` / `nalsToAvcc` 限制 lengthSize 为 1–4；编码时超宽 NAL 抛 `RangeError`；解码长度累积改用乘法，避免有符号位移对 4 字节无符号长度产生负数。
- 验证：NAL 定向测试 12/12；`npm run check` fixtures、全量测试、lint 均通过；`git diff --check` 通过。
- 指标：全量测试 3090 项通过；边界非法配置被拒绝，1 字节 AVCC 往返保持正确。
- 风险：不合法长度配置从隐式错读变为抛 `RangeError`；合法长度配置行为不变。
- 下轮计划：继续检查容器解析路径中可能的整数溢出和截断。

## Round 5/100
- 目标：拒绝 RFC 6184 FU-A 中保留位错误、首尾标志互斥违反及非法 NAL type。
- 改动：H264 depacketizer 在启动/续接分片前验证 FU header；畸形头作废当前 FU，Marker 仍可正常收束空 AU；新增三个坏头回归。
- 验证：H264/H265 depacketizer 定向测试 15/15；`npm run check` fixtures、全量测试、lint 均通过；`git diff --check` 通过。
- 指标：全量测试 3091 项通过；不合法分片不进入 NAL 输出。
- 风险：仅拒绝规范定义为无效的 FU header；合法分片路径保持通过。
- 下轮计划：继续检查容器解析路径中可能的整数溢出和截断。

- 下轮计划：继续检查容器解析路径中可能的整数溢出和截断。

## Round 7/100
- 目标：拒绝 RFC 7798 H.265 FU 的非法类型、S/E 同时置位及 DONL 截断首片。
- 改动：FU type 读取 6 位并拒绝聚合/分片保留类型；首尾位冲突拒绝；DONL 模式首片必须含完整 2 字节 DONL；增加对应回归。
- 验证：H.264/H.265 depacketizer 定向测试通过；`npm run check` fixtures、全量测试、lint 均通过；`git diff --check` 通过。
- 指标：全量测试 3093 项通过；不合法 FU 不会进入重组 NAL。
- 风险：仅拒绝协议保留/非法 FU 头；合法分片重组及 DONL 流程通过。
- 下轮计划：继续检查容器解析路径中可能的整数溢出和截断。

- 下轮计划：继续检查容器解析路径中可能的整数溢出和截断。

## Round 9/100
- 目标：使 H.265 `reset()` 一并清零统计，保持与 H.264 重置语义一致。
- 改动：H.265 reset 重建 stats 为零值；测试先积累丢包、帧及 FU 计数，再检查所有计数归零并验证之后 packet 重新计数。
- 验证：H.265 depacketizer 定向 7/7；`npm run check` fixtures、全量测试、lint 均通过；`git diff --check` 通过。
- 指标：全量测试 3095 项通过；reset 后统计准确反映新周期。
- 风险：调用方观察 stats 的行为更符合 reset 名称及 H.264 对应实现；其他协议状态不变。
- 下轮计划：继续检查容器解析路径中可能的整数溢出和截断。
