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
- 本轮修复将在验证完成后提交并推送 maintenance/round-6。

### 风险与下一轮
- 浏览器验证使用下载到本地 samples/e2e/sintel-trailer.mp4 的真实媒体，该文件未纳入提交。
- 当前未执行 npm 发布；第 1 个完整轮次不触发发布。
- 下一轮候选：继续审计 MSE 多轨 buffered 合并语义、其他容器 seek 后轨道对齐，或优先处理下一项真实浏览器可复现问题。

## Attempt 6：修复 MSE 缓冲水位跨空洞误计

### 发现
- 复现条件：SourceBuffer.buffered 包含多个不连续区间，例如 [0,10] 与 [20,30]，播放器当前时间在第一个区间内。
- 根因：bufferedAhead() 把当前区间剩余时间和所有未来区间直接相加，跨过不可播放的时间空洞，导致背压错误地认为后续内容连续可播。
- 用户影响：播放器可能过早停止拉取/追加数据，遇到空洞时出现等待或卡顿。

### 修改
- core/src/mse-helper.js：bufferedAhead 只返回当前时间所在连续区间的剩余时长；当前时间在空洞或未来区间前时返回 0，不再跨区间累加。
- core/__tests__/core-mse-helper-units.test.js：增加不连续 TimeRanges 的回归断言。

### 验证
- 定向测试：node --test --test-timeout=15000 core/__tests__/core-mse-helper-units.test.js，29/29 通过。
- 全量测试：npm test 串行通过 3134/3134，0 失败；npm run lint 通过（547 个 JS 文件）；npm run check 通过。
- 真实浏览器：Chromium 156 + MSE 验收通过 19/19，覆盖首帧、播放推进、seek 后恢复、buffered、destroy；无 console.error、pageerror、unhandledrejection 或网络失败。

### 提交和推送
- 从远端 origin/main=d192951 创建 maintenance/round-6 分支，避免覆盖之前的本地/远端分叉。

### 风险与下一轮
- 本轮修复未改变公共 API；仅收紧 bufferedAhead 的连续可播放语义。
- 下一步：提交本轮修复并推送维护分支。

## Attempt 8：修复 MSE 多轨 buffered 错误返回并集

### 发现
- 复现条件：活动视频轨与音频轨的 SourceBuffer.buffered 区间不完全重叠。
- 根因：MSE 管线原先逐轨拼接区间并返回并集；只有单轨存在数据的时间段也会被公开为可播放缓冲区间。
- 用户影响：Player.buffered 可能虚报可播放范围，seek UI 或预加载逻辑据此做出错误判断，并在音视频不同步处遇到卡顿。

### 修改
- core/src/pipeline-mse.js：活动音视频轨的 buffered 区间改为求交集，仅报告两条活动轨均可用的区间；过滤零长度区间。
- core/__tests__/core-pipeline-mse-branches.test.js：补充多轨区间交集回归断言。

### 验证
- 定向测试：node --test --test-timeout=15000 core/__tests__/core-pipeline-mse-branches.test.js，21/21 通过。
- 全量测试：npm test 串行通过 3134/3134，0 失败；npm run lint 通过（547 个 JS 文件）；npm run check 通过。
- 真实浏览器：Chromium 156 + MSE 验收通过 19/19，覆盖首帧、播放推进、seek 后恢复、buffered 交集、destroy；无 console.error、pageerror、unhandledrejection 或网络失败。

### 提交和推送
- 基于 maintenance/round-6 继续提交，保持不覆盖 origin/main 历史。

### 风险与下一轮
- 本轮只改变公开 buffered 区间计算，不改变 SourceBuffer 写入和播放时钟。
- 下一步：提交本轮修复并推送维护分支。

## Attempt 9：修复 MSE 活动轨缺失时 buffered 误报

### 发现
- 复现条件：视频轨存在 buffered 区间，但活动音频轨尚未产生区间。
- 根因：多轨 buffered 求交集实现跳过 null 区间，导致仍返回视频轨范围，误报为可播放。
- 用户影响：播放器可能在音频尚未就绪时错误暴露可播放范围，造成 seek/预加载判断过早。

### 修改
- core/src/pipeline-mse.js：任一活动音视频轨没有 buffered 数据时立即返回空区间；有数据时继续求轨道交集。
- core/__tests__/core-pipeline-mse-branches.test.js：增加活动音频轨缺失缓冲的回归断言。

### 验证
- 定向测试：21/21 通过。
- 全量测试：npm test 串行通过 3134/3134，0 失败；npm run lint 通过（547 个 JS 文件）；npm run check 通过。
- 真实浏览器：Chromium 156 + MSE 验收通过 19/19，覆盖首帧、播放推进、seek 后恢复、buffered、destroy；无 console.error、pageerror、unhandledrejection 或网络失败。

### 提交和推送
- 基于 maintenance/round-6 继续提交并推送。

### 风险与下一轮
- 本轮仅收紧 buffered 公开语义，不改变数据追加或播放时钟。

## Attempt 11：修复 WebCodecs 非有限音频时钟污染主时钟

### 发现
- 复现条件：AudioOutput.currentTimeUs 返回 NaN 或 Infinity。
- 根因：WebCodecs 管线仅检查类型为 number，非有限值会参与偏移换算，Player.currentTimeUs 随之变成非有限值。
- 用户影响：播放进度、缓冲水位和同步决策可能被 NaN/Infinity 污染。

### 修改
- core/src/pipeline-webcodecs.js：只有有限音频时钟才作为主时钟；异常时回退单调 PlaybackClock。
- core/__tests__/core-webcodecs-pipeline-env.test.js：增加 NaN 音频时钟回退回归断言。

### 验证
- 定向测试：node --test --test-timeout=15000 core/__tests__/core-webcodecs-pipeline-env.test.js，30/30 通过。
- 全量测试：npm test 串行通过 3134/3134，0 失败；npm run lint 通过（547 个 JS 文件）；npm run check 通过。
- 真实浏览器：Chromium 156 + MSE 验收通过 19/19；无 console.error、pageerror、unhandledrejection 或网络失败。

### 提交和推送
- 基于 maintenance/round-6 继续提交。

### npm 发布
- 第十轮已完成 npm pack --dry-run；npm whoami 因 ENEEDAUTH 失败，实际发布待 npm 登录后执行。

## Attempt 12：修复 AudioWorklet 非有限 context 时钟回退

### 发现
- 复现条件：AudioContext.currentTime 在播放期间异常返回 NaN/Infinity。
- 根因：AudioWorkletPlayer 直接用非有限 context 时钟计算播放进度，可能向同步层暴露 NaN。
- 用户影响：AudioWorklet 音频主钟、currentTimeUs 和进度事件可能失真。

### 修改
- core/src/audio-worklet-player.js：播放态仅使用有限的 context.currentTime、锚点和 startedAt；异常时回退已消费帧时钟。
- core/__tests__/core-audio-worklet-env.test.js：增加异常 context 时钟回归断言。

### 验证
- 定向测试：14/14 通过。
- 全量测试：npm test 串行通过 3134/3134，0 失败；npm run lint 通过（547 个 JS 文件）；npm run check 通过。
- 真实浏览器：Chromium 156 + MSE 验收通过 19/19；无 console.error、pageerror、unhandledrejection 或网络失败。

### 提交和推送
- 基于 maintenance/round-6 继续提交。

## Attempt 13：修复 PlaybackClock 非有限 now 值污染

### 发现
- 复现条件：注入的单调时钟回调返回 NaN/Infinity，或时钟读取本身抛异常。
- 根因：PlaybackClock 直接使用 now() 结果计算播放时间，异常值会污染主时钟。
- 用户影响：播放进度和 A/V 同步决策可能产生非有限时间或跳变。

### 修改
- core/src/clock.js：缓存最近一次有限单调时钟值；now 异常、抛错或非有限时回退该值。
- core/__tests__/clock-stats.test.js：增加 NaN/Infinity 时钟回退与不跳变回归测试。

### 验证
- 定向测试：10/10 通过。
- 全量测试：npm test 串行通过 3135/3135，0 失败；npm run lint 通过（547 个 JS 文件）；npm run check 通过。
- 真实浏览器：Chromium 156 + MSE 验收通过 19/19；无 console.error、pageerror、unhandledrejection 或网络失败。

### 提交和推送
- 基于 maintenance/round-6 继续提交。