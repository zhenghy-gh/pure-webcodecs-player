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

## Round 3/100
- 目标：避免 RTSP 线解析器对超出 JavaScript 安全整数范围的 Content-Length 永久等待。
- 改动：解析 Content-Length 时检查 `Number.isSafeInteger`，超范围抛 `SOURCE_ERROR`；增加 `9007199254740992` 回归。
- 验证：RTSP 线边界定向测试 16/16；`npm run check` 的 fixtures、全量测试、lint 均通过；`git diff --check` 通过。
- 指标：全量测试 3089 项通过；异常长度立即拒绝，不再以不精确数字等待输入。
- 风险：异常/不可表示的长度现在显式报错；合法安全整数范围内行为不变。
- 下轮计划：继续检查解析器输入长度与资源上限的边界行为。
