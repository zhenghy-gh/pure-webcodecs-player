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

## Attempt 14：修复 Stats 非有限时钟污染 FPS

### 发现
- 复现条件：Stats 注入的 now() 返回 NaN/Infinity 或抛出异常。
- 根因：统计模块直接保存时钟回调，渲染时间锚点和 FPS 计算可能接收非有限时间。
- 用户影响：FPS 统计可能失真，进度上报出现异常值。

### 修改
- core/src/stats.js：缓存最近一次有限 now 值；异常读取回退到该值。
- core/__tests__/clock-stats.test.js：增加 Stats 异常时钟回退回归断言。

### 验证
- 定向测试：10/10 通过。
- 全量测试：npm test 串行通过 3135/3135，0 失败；npm run lint 通过（547 个 JS 文件）；npm run check 通过。
- 真实浏览器：Chromium 156 + MSE 验收通过 19/19；无 console.error、pageerror、unhandledrejection 或网络失败。

### 提交和推送
- 基于 maintenance/round-6 继续提交。

## Attempt 15：修复 Player 码率统计非有限时钟输入

### 发现
- 复现条件：Player 码率窗口使用的 now() 返回 NaN/Infinity 或抛出异常。
- 根因：Player 的码率统计直接读取系统时钟，可能生成非有限时间戳并污染滑动窗口。
- 用户影响：stats.bitrateBps 可能失真，异常时钟还会造成窗口清理和速率计算不稳定。

### 修改
- core/src/player.js：增加有限时钟缓存与异常回退，并让码率窗口统一使用该安全时钟。
- core/__tests__/core-player-state.test.js：增加码率统计异常时钟回归测试。

### 验证
- 定向测试：34/34 通过。
- 全量测试：npm test 串行通过 3136/3136，0 失败；npm run lint 通过（547 个 JS 文件）；npm run check 通过。
- 真实浏览器：Chromium 156 + MSE 验收通过 19/19；无 console.error、pageerror、unhandledrejection 或网络失败。

### 提交和推送
- 基于 maintenance/round-6 继续提交。

## Attempt 16：修复 Player currentTimeUs 外部时钟污染

### 发现
- 复现条件：注入的播放时钟 getTimeSec() 返回 NaN/Infinity 或抛出异常。
- 根因：Player.currentTimeUs 直接将外部时钟换算为微秒，异常值可能污染公共播放时间。
- 用户影响：timeupdate、同步决策和 UI 播放进度可能收到非有限值。

### 修改
- core/src/player.js：读取外部时钟时增加异常捕获和有限性校验，仅接受有限微秒值。
- core/__tests__/core-player-state.test.js：增加 currentTimeUs 非有限时钟回退回归测试。

### 验证
- 定向测试：35/35 通过。
- 全量测试：npm test 串行通过 3137/3137，0 失败；npm run lint 通过（547 个 JS 文件）；npm run check 通过。
- 真实浏览器：Chromium 156 + MSE 验收通过 19/19；无 console.error、pageerror、unhandledrejection 或网络失败。

### 提交和推送
- 基于 maintenance/round-6 继续提交。

## Attempt 17：修复 Player buffered 读取异常崩溃

### 发现
- 复现条件：demuxer 或 pipeline 在销毁/SourceBuffer 失效期间，getBufferedRanges() 抛出异常。
- 根因：Player.buffered 直接调用底层区间读取，没有隔离底层生命周期异常。
- 用户影响：UI 读取 buffered 可能同步抛错，阻断进度展示和播放控制。

### 修改
- core/src/player.js：分别保护 demuxer 与 pipeline 的缓冲区间读取；失败后继续尝试其他来源，再回退到 bufferedAheadUs 合成区间或空数组。
- core/__tests__/core-player-state.test.js：覆盖双来源异常、有效管线回退和水位合成回退。

### 验证
- 定向测试：36/36 通过。
- 全量测试：npm test 串行通过 3138/3138，0 失败；npm run lint 通过（547 个 JS 文件）；npm run check 通过。

## Attempt 18：修复 Player buffered 非法区间污染

### 发现
- 复现条件：底层 getBufferedRanges() 返回负起点、零长度、end 不大于 start 或 NaN 的区间。
- 根因：Player.buffered 仅检查数组，不校验区间数值契约，非法数据会直接暴露给 UI。
- 用户影响：进度条、seek 范围和预加载逻辑可能收到不可用区间。

### 修改
- core/src/player.js：过滤非对象、非有限、负起点和非正长度的缓冲区间；同时保留底层读取异常时的来源回退。
- core/__tests__/core-player-state.test.js：增加非法区间过滤回归覆盖。

### 验证
- 定向测试：36/36 通过。
- 全量测试：npm test 串行通过 3138/3138，0 失败；npm run lint 通过（547 个 JS 文件）；npm run check 通过。
- 真实浏览器：Chromium 156 + MSE 验收通过 19/19；无 console.error、pageerror、unhandledrejection 或网络失败。

### 提交和推送
- 基于 maintenance/round-6 继续提交。

## Attempt 21：修复 Player bufferedAheadUs 读取异常

### 发现
- 复现条件：管线在销毁或输出资源失效期间，读取 bufferedAheadUs getter 抛出异常，或返回负数、NaN 等非法水位。
- 根因：Player.bufferedAheadUs 直接读取底层 getter，仅校验类型和有限性，没有隔离生命周期异常或拒绝负水位。
- 用户影响：buffered、背压和预缓冲逻辑可能同步抛错，或将无效水位当作可用数据。

### 修改
- core/src/player.js：保护管线水位 getter；异常、负数和非有限值统一回退 null，保留 0 作为合法水位。
- core/__tests__/core-player-state.test.js：增加异常 getter、负数、NaN 和零水位回归测试。

### 验证
- 定向测试：37/37 通过。
- 全量测试：npm test 串行通过 3139/3139，0 失败；npm run lint 通过（547 个 JS 文件）；npm run check 通过。
- 真实浏览器：Chromium 156 + MSE 验收通过 19/19；无 console.error、pageerror、unhandledrejection 或网络失败。

### 提交和推送
- 基于 maintenance/round-6 继续提交。

### 阶段性说明
- 按当前维护策略不执行 npm 发布、版本递增、release commit、tag 或 npm 包发布；npm 仅作为测试工具使用。

## Attempt 22：修复 Player 管线时钟 getter 异常崩溃

### 发现
- 复现条件：管线在销毁、输出设备失效或 MediaSource 断开期间，`pipeline.currentTimeUs` getter 抛出异常；读取 `Player.currentTimeUs`。
- 根因：Player 只校验 getter 返回值的类型/有限性，没有隔离 getter 本身的同步异常。
- 用户影响：暂停、timeupdate、buffered 合成和 seek 相关 UI 读取播放时间时可能同步抛错，阻断控制层。

### 修改
- core/src/player.js：用局部 try/catch 保护管线 `currentTimeUs` getter；读取失败时回退已有时间值或 PlaybackClock，不改变公共 API。
- core/__tests__/core-player-state.test.js：增加管线时钟 getter 抛错时回退播放器时钟的回归测试。

### 验证
- 复现基线：未修复代码读取抛错 getter 真实退出码 1；修复后回退到 1.25s 播放时钟。
- 定向测试：`node --test --test-timeout=15000 core/__tests__/core-player-state.test.js`，38/38 通过。
- 全量测试：`npm test` 串行通过 3123/3123，0 失败。
- 静态验证：`npm run lint && npm run check` 通过；check 内嵌测试报告 3140/3140，lint 检查 547 个 JS 文件。
- 真实浏览器：Playwright + Chromium（本地安装）执行 `scripts/e2e/run.mjs --harness=mse-harness.html --media=/samples/e2e/sintel-trailer.mp4`，19/19 通过；覆盖 MSE 能力、MP4 load、轨道解析、MediaSource open、首帧（854x480，readyState=4）、播放推进、渲染帧（24，dropped=0）、seek（20s 请求对齐到 16.50s）、seek 后恢复（16.50→16.95s）、stall 恢复、buffered、水位、管线段计数、destroy 和 src 释放。
- 浏览器 console.error、pageerror、unhandledrejection、网络失败：无输出；E2E 生成的截图仅作验证产物，未纳入本轮提交。

### 提交和推送
- 本轮待提交：Player 实现、回归测试和 progress.md；不包含 E2E 截图或媒体文件。

### 风险
- 本轮只保护管线时钟 getter 的异常边界；其他管线 getter 仍由各自调用点按既有语义处理。
- 未执行 npm 发布、版本递增、release commit、tag、npm pack 或 npm publish。

### 下一轮候选
- 审计 Player 其余同步管线边界（volume/muted/playbackRate、pipeline 事件转发及 destroy 竞态），优先选择可真实复现且能补回归测试的问题。

## Attempt 23：修复 MSE play() Promise 未处理拒绝

### 发现
- 复现条件：真实 HTMLMediaElement 的 `play()` 因 autoplay、权限或浏览器策略返回 rejected Promise；MSE 管线调用 `element.play()` 后不接收 Promise。
- 根因：`MsePipeline.play()` 只捕获同步 throw，未处理标准异步 Promise rejection。
- 用户影响：浏览器控制台出现 `unhandledrejection`，播放错误无法稳定进入播放器 error 事件面，导致宿主难以恢复或提示用户。

### 修改
- core/src/pipeline-mse.js：保留同步异常捕获，并对 thenable play 结果挂接拒绝处理，统一转为 `DECODE_ERROR` 的管线 `error` 事件。
- core/__tests__/core-pipeline-mse-branches.test.js：扩展 FakeMediaElement 的异步拒绝能力，增加 rejected Promise 不产生未处理拒绝且上报 error 的回归测试。

### 验证
- 复现基线：原实现对 rejected Promise 产生 Node `unhandledRejection`；修复后定向测试捕获 `DECODE_ERROR`，无未处理拒绝。
- 定向测试：`node --test --test-timeout=15000 core/__tests__/core-pipeline-mse-branches.test.js`，22/22 通过。
- 全量测试：`npm test` 串行通过 3141/3141，0 失败。
- 静态验证：`npm run lint && npm run check` 通过；check 内嵌测试 3141/3141，lint 检查 547 个 JS 文件。
- 真实浏览器：Playwright + Chromium 执行 `scripts/e2e/run.mjs --harness=mse-harness.html --media=/samples/e2e/sintel-trailer.mp4`，19/19 通过；首帧 854x480（readyState=4，205ms）、播放推进（0.08→0.88s）、24 渲染帧且 dropped=0、seek（20s→16.50s）、seek 后恢复（16.50→16.96s）、stall 恢复、buffered、水位、destroy 和 src 释放均通过。
- 浏览器 console.error、pageerror、unhandledrejection、网络失败：无输出；E2E 截图已恢复，不纳入提交。

### 提交和推送
- 本轮待提交：MSE 管线实现、回归测试和本条 progress 记录。

### 风险
- `play()` Promise 拒绝现在会发 error，但管线仍按既有语义保持 playing；宿主应按 error 事件决定重试或提示。
- 未执行 npm 发布、版本递增、release commit、tag、npm pack 或 npm publish。

### 下一轮候选
- 继续审计 Player 与 MSE/WebCodecs 管线的同步 setter、pause/seek/destroy 竞态及事件转发边界。
