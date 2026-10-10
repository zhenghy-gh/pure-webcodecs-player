# 维护进度

## Attempt 1：修复 MSE seek 后音视频时间缺口

### 发现
- 复现条件：真实 Chromium 通过 MSE 播放包含视频与音频轨的 MP4，播放后 seek 到 20 秒。
- 根因：MP4 demuxer 的 seek 以视频关键帧作为实际落点，但其余轨道仍按用户请求时间定位；请求时间落在关键帧之后时，音频从请求时间才开始，导致 MSE 在实际视频落点到请求时间之间出现轨道缺口，seek 后 readyState 降为 1 且播放不再推进。
- 用户影响：seek 后可能无声、卡住或无法恢复播放。

### 修改
- mp4/src/demuxer.js：先计算视频关键帧实际落点，再用该落点定位音频等其他轨道。
- mp4/__tests__/demuxer-gaps.test.js：补充双轨 seek 回归断言，确保其他轨道从实际落点之前的样本开始。
- scripts/e2e/mse-harness.html：声明空 favicon，避免真实浏览器验收产生 404 控制台噪声。
- package.json、package-lock.json：将 playwright-core 作为 devDependency，固化真实浏览器验证工具；不引入运行时依赖。

### 验证
- 定向测试：node --test --test-timeout=15000 mp4/__tests__/demuxer-gaps.test.js（15/15 通过）。
- 全量测试：npm test 串行通过 3134/3134，0 失败；npm run lint 通过（547 个 JS 文件）；npm run check 通过。
- 真实浏览器：Chromium 156 + scripts/e2e/run.mjs --harness=mse-harness.html --media=/samples/e2e/sintel-trailer.mp4，通过 19/19。覆盖 MSE 能力、MP4 加载、轨道解析、MediaSource open、首帧（854x480，readyState=4）、播放推进、渲染帧（23，dropped=0）、seek（20s 请求对齐到 16.50s）、seek 后恢复（16.50→16.96s）、buffered、管线段计数、destroy 和元素 src 释放。
- 浏览器 console.error、pageerror、unhandledrejection、网络失败：无输出；空 favicon 后不再出现此前 favicon 404。
- 初次并行验证曾出现一次 npm test 退出码 1，随后独立串行重跑通过，未将初次结果伪报为通过。

### 提交和推送
- 前置用户要求代码提交：591d3ba fix: harden media and gateway boundaries，已推送 main。
- 本轮修复待提交，提交后推送 main。

### 风险与下一轮
- 浏览器验证使用下载到本地 samples/e2e/sintel-trailer.mp4 的真实媒体，该文件未纳入提交。
- 当前未执行 npm 发布；第 1 个完整轮次不触发发布。
- 下一轮候选：继续审计 MSE 多轨 buffered 合并语义、其他容器 seek 后轨道对齐，或优先处理下一项真实浏览器可复现问题。
