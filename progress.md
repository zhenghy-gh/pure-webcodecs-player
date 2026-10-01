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

## Round 6/100
- 目标：避免 H.265 AP 聚合包出现截断时仍输出已解析的部分 NAL。
- 改动：先将聚合项解析到局部数组，仅当完整消费 payload 后一次性合并；DONL 模式下缺少 DONL 也视为无效 AP；新增两项回归。
- 验证：H.264/H.265 depacketizer 定向测试通过；`npm run check` fixtures、全量测试、lint 均通过；`git diff --check` 通过。
- 指标：全量测试 3092 项通过；无效聚合包不再部分污染 AU。
- 风险：损坏 AP 的先前有效条目不再输出，保证聚合包原子性；合法 AP/DONL 路径不变。
- 下轮计划：继续检查容器解析路径中可能的整数溢出和截断。
