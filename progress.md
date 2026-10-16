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

## Attempt 24：修复 AudioContext pause/resume 拒绝并收紧真实浏览器验收

### 发现
- 复现条件：浏览器 AudioContext 因用户手势、权限或设备状态导致 `resume()` / `suspend()` 返回 rejected Promise；AudioWorkletPlayer 原先只调用 Promise，不消费拒绝。
- 根因：AudioWorklet 播放控制路径没有统一处理 WebAudio 异步控制 Promise，可能留下 `unhandledrejection`；同时 WebCodecs E2E 运行器只观察控制台，未区分媒体销毁时浏览器主动取消的正常请求。
- 用户影响：真实浏览器控制台可能出现未处理拒绝，宿主无法通过播放器 `error` 事件感知音频输出失败；E2E 验收还可能把正常资源回收误报为网络故障。

### 修改
- core/src/audio-worklet-player.js：新增受保护的 AudioContext resume/suspend 辅助路径，同步 throw 与 rejected Promise 均转为 `DECODE_ERROR` 的 `error` 事件；成功 resume 仍派发 `resumed`，不改变原有播放状态 API。
- core/__tests__/core-audio-worklet-env.test.js：FakeAudioContext 增加可控 resume/suspend 拒绝，补充两条无未处理拒绝且正确上报 error 的回归测试。
- scripts/e2e/player-harness.html：声明空 favicon，避免 WebCodecs 验收页面产生无关 404。
- scripts/e2e/run.mjs：捕获 pageerror、unhandledrejection 和 HTTP/request failure；将媒体 destroy 时 Chromium 的 `ERR_ABORTED` 单独标为主动取消，不把它当网络失败；真实 console error/pageerror、非预期网络失败或 unhandledrejection 使验收失败。该文件仅为开发验收工具，不进入运行时依赖。

### 验证
- 复现基线：原 AudioContext 控制路径对 rejected Promise 会留下未处理拒绝；修复后定向测试收到 `DECODE_ERROR`，无未处理拒绝。
- 定向测试：`node --test --test-timeout=15000 core/__tests__/core-audio-worklet-env.test.js`，16/16 通过。
- 全量测试：`npm test` 串行通过 3143/3143，0 失败。
- 静态验证：`npm run lint && npm run check` 通过；check 内嵌测试 3143/3143，lint 检查 547 个 JS 文件。
- 浏览器首次尝试：使用不存在的 `/samples/e2e/bbb480_30s.ts`，真实 Chromium 返回 404、退出码 1；已确认是工作区缺失媒体 fixture，不将其报告为通过，随后改用实际存在的 `sintel-trailer.mp4` 重跑。
- 真实 Chromium WebCodecs：`scripts/e2e/run.mjs --harness=player-harness.html --media=/samples/e2e/sintel-trailer.mp4`，15/15 通过；能力探测、轨道解析、进入 playing、首帧（约 473ms）、播放推进（0.49→1.29s）、seek（12s→9.33s）、seek 后恢复（9.51→10.01s）、stats/buffered、背压、AudioWorklet 输出、destroy 均通过。无 console.error、pageerror、unhandledrejection 或非预期网络失败；仅有 Chromium headless 的 WebGL ReadPixels 性能 warning，以及 2 个 destroy 时主动取消媒体请求。
- 真实 Chromium MSE：`scripts/e2e/run.mjs --harness=mse-harness.html --media=/samples/e2e/sintel-trailer.mp4`，19/19 通过；首帧（854x480、约 210ms）、播放推进、seek（20s→16.50s）、seek 后恢复（16.50→16.95s）、buffered、destroy 和 src 释放均通过。无 console.error、pageerror、unhandledrejection 或非预期网络失败；1 个主动取消媒体请求已单独记录。
- E2E 生成截图已恢复为提交前版本，未纳入本轮提交。

### 提交和推送
- 本轮待提交：AudioWorklet 实现与回归测试、E2E 验收工具改进和本条 progress 记录。

### 风险
- headless Chromium 仍输出 WebGL `ReadPixels` 性能 warning；它不是页面 error，也未阻断播放，但属于当前浏览器/渲染环境噪声。
- E2E runner 的默认 TS 样本在当前工作区不存在，默认命令仍需调用方提供存在的媒体或准备 fixture；本轮未伪造该路径。
- 未执行 npm 发布、版本递增、release commit、tag、npm pack 或 npm publish。

### 下一轮候选
- 继续审计 WebCodecs 解码器/AudioWorklet 销毁竞态、Player 参数 setter 和 pause/seek 状态恢复；优先验证真实错误事件和资源释放。

## Attempt 25：修复 AudioContext destroy() 异步拒绝

### 发现
- 复现条件：AudioContext 的 `close()` 在 destroy 期间返回 rejected Promise（设备/上下文关闭竞态）；调用 `AudioWorkletPlayer.destroy()`。
- 根因：destroy 原先只用同步 try/catch；异步 close rejection 没有被消费，会触发 `unhandledrejection`。
- 用户影响：销毁本应是幂等、静默的资源回收路径，却可能污染控制台并触发宿主全局未处理拒绝监控。

### 修改
- core/src/audio-worklet-player.js：消费 `AudioContext.close()` 的 thenable rejection；保持 destroy 同步返回、资源引用清理与既有事件/公共 API 不变。
- core/__tests__/core-audio-worklet-env.test.js：FakeAudioContext 增加 close 拒绝能力，增加 destroy 异步拒绝回归测试。

### 验证
- 复现基线：注入返回 rejected Promise 的 AudioContext.close，原实现真实触发 Node `unhandledRejection`；修复后拒绝被消费。
- 定向测试：`node --test --test-timeout=15000 core/__tests__/core-audio-worklet-env.test.js`，17/17 通过。
- 全量测试：`npm test` 串行通过 3144/3144，0 失败。
- 静态验证：`npm run lint && npm run check` 通过；check 内嵌测试 3144/3144，lint 检查 547 个 JS 文件。
- 真实 Chromium WebCodecs：`scripts/e2e/run.mjs --harness=player-harness.html --media=/samples/e2e/sintel-trailer.mp4`，15/15 通过；首帧约 489ms、播放推进 0.50→1.30s、seek 12s→9.33s、seek 后恢复 9.50→10.01s、stats/buffered、背压、AudioWorklet、destroy 均通过；无 console.error、pageerror、unhandledrejection 或非预期网络失败，仅 2 个 destroy 主动取消媒体请求和 headless WebGL 性能 warning。
- 真实 Chromium MSE：同媒体执行 `--harness=mse-harness.html`，19/19 通过；首帧 854x480 约 207ms、播放推进 0.08→0.88s、seek 20s→16.50s、seek 后恢复 16.50→16.93s、buffered、水位、destroy 和 src 释放均通过；无 console.error、pageerror、unhandledrejection 或非预期网络失败，仅 1 个主动取消请求。
- E2E 生成截图已恢复为提交前版本，未纳入提交。

### 提交和推送
- 本轮待提交：AudioWorklet destroy 修复、回归测试和 progress.md。

### 风险
- AudioContext close rejection 按 destroy 语义静默忽略；资源回收失败不会通过 error 事件上报，因为对象已进入 destroyed。
- headless Chromium WebGL ReadPixels warning 仍是环境噪声，不影响上述真实播放断言。
- 未执行 npm 发布、版本递增、release commit、tag、npm pack 或 npm publish。

### 下一轮候选
- 审计 Player 参数 setter 与 MSE/WebCodecs 管线 setter 的异常/Promise 边界，或检查 destroy 后延迟控制调用是否仍会泄漏拒绝。

## Attempt 26：修复 Player 控制 setter 的管线异常泄漏

### 发现
- 复现条件：管线在 detach/destroy 或底层媒体元素失效期间，`setVolume`、`setMuted` 或 `setPlaybackRate` 同步抛错，或返回 rejected Promise；通过 Player 属性 setter 修改控制参数。
- 根因：Player 先写本地状态再直接透传管线，既会把底层异常直接暴露为普通 Error，也会在异步拒绝时产生 `unhandledrejection`，并留下 Player 本地值与实际管线状态不一致。
- 用户影响：音量、静音或速度控制可能污染宿主控制流/控制台；失败控制还会被 UI 误认为已生效。

### 修改
- core/src/player.js：新增统一控制透传边界；同步异常转换为 `DECODE_ERROR`、派发 Player `error` 并抛出；thenable 拒绝被消费并派发 `error`；同步失败时本地 volume/muted/playbackRate 保持原值，成功调用后再更新本地值。
- core/__tests__/core-player-state.test.js：增加同步失败状态回滚和异步拒绝消费回归测试，覆盖三个 setter。

### 验证
- 复现基线：注入会抛错的管线 setter，原实现直接抛出 `detached` 且本地值已被污染（volume=0.2、muted=true、playbackRate=1.5）；修复后抛 `DECODE_ERROR`、派发 error 且保留默认本地值。
- 定向测试：`node --test --test-timeout=15000 core/__tests__/core-player-state.test.js`，40/40 通过。
- 全量测试：`npm test` 串行通过 3146/3146，0 失败。
- 静态验证：`npm run lint && npm run check` 通过；check 内嵌测试 3146/3146，lint 检查 547 个 JS 文件。
- 真实 Chromium WebCodecs：`scripts/e2e/run.mjs --harness=player-harness.html --media=/samples/e2e/sintel-trailer.mp4`，15/15 通过；首帧约 463ms、播放推进 0.47→1.37s、seek 12s→9.33s、seek 后恢复 9.50→10.01s、stats/buffered、背压、AudioWorklet 输出和 destroy 均通过；无 console.error、pageerror、unhandledrejection 或非预期网络失败，仅 2 个主动取消媒体请求和 headless WebGL warning。
- 真实 Chromium MSE：`--harness=mse-harness.html`，19/19 通过；首帧 854x480 约 220ms、播放推进 0.09→0.89s、seek 20s→16.50s、seek 后恢复 16.50→16.95s、buffered、水位、destroy 和 src 释放均通过；无 console.error、pageerror、unhandledrejection 或非预期网络失败，仅 1 个主动取消请求。
- E2E 截图已恢复为提交前版本，未纳入提交。

### 提交和推送
- 本轮待提交：Player 控制边界实现、回归测试和 progress.md。

### 风险
- 管线异步 setter 拒绝通过 error 事件异步通知，属性 setter 本身按同步 API 返回；宿主需要监听 error 处理底层控制失败。
- 本轮未改变公共 setter 名称或合法值校验；未执行 npm 发布、版本递增、release commit、tag、npm pack 或 npm publish。

### 下一轮候选
- 审计 Player 的 play/pause/seek 对管线同步 throw、异步 Promise rejection 的统一处理，以及 destroy 后迟到控制结果是否仍会触发 error。

## Attempt 27：收敛 Player play/pause 管线错误与销毁竞态

### 发现
- 复现条件：`Player.play()` 的底层管线控制同步抛错，或 `play()`/`pause()` 返回 rejected Promise；另一个竞态是在 `Player.destroy()` 异步释放期间 play Promise 才拒绝。
- 根因：Player 先将状态置为 playing 并启动时钟，再直接调用管线控制；同步异常会留下错误状态，异步拒绝未消费；pause 同步异常可能导致时钟已停但 Player 仍 playing。销毁的异步窗口中迟到错误也需要被终态屏蔽。
- 用户影响：控制 Promise 可造成 `unhandledrejection`，状态/时钟与实际管线不一致，宿主收不到规范化的 `DECODE_ERROR`。

### 修改
- core/src/player.js：play/pause 共用安全管线控制入口；同步 throw 规范化为 `DECODE_ERROR`、终止样本泵、暂停软时钟、进入 error 并派发 error；thenable 异步拒绝被消费并以同一路径收敛。`destroy()` 开始时设置 `_destroying`，屏蔽 teardown 期间迟到的控制错误。
- core/__tests__/core-player-state.test.js：新增 play 同步抛错、play/pause 异步拒绝、pause 同步抛错及 destroy 等待时迟到拒绝 5 条回归断言；确认不产生未处理拒绝且 destroyed 状态不被复活。

### 验证
- 定向测试：`node --test --test-timeout=15000 core/__tests__/core-player-state.test.js`，45/45 通过。
- 全量测试：`npm test` 串行通过 3151/3151，0 失败。
- 静态验证：`npm run lint && npm run check` 通过；内嵌测试 3151/3151，lint 检查 547 个 JS 文件。
- 真实 Chromium WebCodecs：`scripts/e2e/run.mjs --harness=player-harness.html --media=/samples/e2e/sintel-trailer.mp4`，15/15 通过；首帧约 463ms、播放推进 0.48→1.28s、seek 12s→9.33s、seek 后恢复 9.50→10.01s、AudioWorklet、stats/buffered、背压和 destroy 均通过；无 console.error/pageerror/unhandledrejection/非预期网络失败，只有 headless WebGL warning 和 2 个主动取消请求。
- 真实 Chromium MSE：`--harness=mse-harness.html`，19/19 通过；首帧 854x480 约 210ms、播放推进 0.08→0.88s、seek 20s→16.50s、seek 后恢复 16.51→16.97s，buffered、destroy 和 src 释放均通过；无播放器错误和非预期网络失败，只有 1 个主动取消请求。
- E2E 覆盖截图已恢复为 HEAD 原始版本，未纳入提交。

### 提交和推送
- 本轮待提交：Player play/pause 错误收敛、回归测试和本条进展记录。

### 风险
- Player `play()`/`pause()` 的底层异步控制拒绝通过 Player `error` 事件通知（play 的调用 Promise 本身不等待管线内部播放 Promise）；宿主需订阅 error。
- `seek()` 本身走 demuxer seek 路径，并无 play/pause 管线调用；其错误边界已保持原实现，本轮未更改公共 API。
- 未执行 npm 发布、版本递增、release commit、tag、npm pack 或 npm publish。

### 下一轮候选
- 审计控制 setter 异步拒绝在 destroy 后是否仍派发 error，以及 MSE/WebCodecs pipeline 的 play/pause 状态是否在失败时自洽。

## Attempt 28：修复 WebVTT strict 畸形时间行裸 TypeError

### 发现
- 复现条件：`parseVtt(text, { strict: true })` 输入类似 `00:01.000 -->`（无结束时间）或 `--> 00:02.000`（无开始时间）。
- 根因：时间行存在 `-->`，解析器会将它认作 cue 时间行；但 `TIMING_RE.exec()` 失败返回 null，后续直接读取 `tm[1]` 泄漏裸 `TypeError`，不符合模块所有解析错误需使用 `SubtitleError(PARSE_ERROR)` 的约定。
- 用户影响：strict 消费方不能按统一错误类型/code 分类和展示输入错误；lenient 模式目前会在相同畸形输入上崩溃而不是安全跳过。

### 修改
- subtitle/src/vtt.js：验证时间行正则结果；无效行增加 skippedBlocks/warning，在 strict 模式抛带 block/timing detail 的 `SubtitleError(PARSE_ERROR)`，lenient 模式跳过该块。
- subtitle/__tests__/subtitle-vtt-settings.test.js：将已知缺陷守卫升级为类型/code 回归，并覆盖缺起始、缺结束 token 在 strict/lenient 两种模式的行为。

### 验证
- 修复前复现输出：`TypeError TypeError undefined Cannot read properties of null (reading '1')`。
- 定向测试：`node --test --test-timeout=15000 subtitle/__tests__/subtitle-vtt-settings.test.js`，15/15 通过。
- 全量测试：`npm test` 串行通过 3152/3152，0 失败。
- 静态验证：`npm run lint && npm run check` 通过；lint 检查 547 个 JS 文件，check 内嵌测试 3152/3152。
- 此变更仅影响纯 ESM 字幕解析逻辑，不涉及浏览器媒体管线，故本轮无需真实浏览器验证。

### 提交和推送
- 本轮待提交：WebVTT parser、strict/lenient 回归测试和 progress.md。

### 风险
- lenient 模式遇到畸形 timing 行现在有意跳过并计数，而非以前抛出 TypeError；strict 模式使用项目标准 SubtitleError。正常合法 cue 解析无变化。
- 未执行 npm 发布、版本递增、release commit、tag、npm pack 或 npm publish。

### 下一轮候选
- 审计其他字幕解析器 strict 分支是否也存在裸异常泄漏，或寻找真实媒体数据源/边界处理中的高价值问题。

## Attempt 29：修复 ASS strict 非法样式静默降级

### 发现
- 复现条件：调用 `parseAss(text, { strict: true })`，输入的 Style 行包含无法解析的颜色（如 `PrimaryColour=notacolor`）。
- 根因：样式字段解析包在 catch 中，任何颜色错误都只写 warning 并回退默认值；strict 标志没有参与该错误分支，导致严格解析仍成功。
- 用户影响：strict 调用方无法把畸形样式识别为解析失败，与 README 对 strict 模式“畸形即抛错”的契约不一致；输入错误会静默变成视觉上不同的样式。

### 修改
- subtitle/src/ass.js：保持 lenient 既有回退默认值行为；strict 下颜色/样式字段错误转换为带原始 cause、行号和值 detail 的 `SubtitleError(PARSE_ERROR)`。
- subtitle/__tests__/subtitle-parse-edge.test.js：增加严格模式断言 error 类型、code、行号和 cause；原 lenient fallback 回归保持。

### 验证
- 修复前复现：错误颜色在 strict 模式返回成功，生成 1 个默认回退样式并留 warning。
- 定向测试：`node --test --test-timeout=15000 subtitle/__tests__/subtitle-parse-edge.test.js subtitle/__tests__/subtitle-ass-edge.test.js`，29/29 通过。
- 全量测试：`npm test` 串行通过 3153/3153，0 失败。
- 静态验证：`npm run lint && npm run check` 通过；check 内嵌测试 3153/3153，lint 检查 547 个 JS 文件。
- 修改仅影响纯 ESM 字幕解析，不涉及浏览器播放/渲染管线，因此无需真实浏览器验证。

### 提交和推送
- 本轮待提交：ASS parser strict 错误处理、回归测试和 progress.md。

### 风险
- 只有 strict 模式行为改变为预期的拒绝；默认 lenient 模式依然记录 warning 并对非法颜色回退默认色，合法文件结果不变。
- 未执行 npm 发布、版本递增、release commit、tag、npm pack 或 npm publish。

### 下一轮候选
- 继续审计 strict ASS 时间码捕获与 Comment 记录、以及字幕探测/解析入口是否一致遵守畸形输入契约。

## Attempt 30：严格验证 ASS 样式数值字段

### 发现
- 复现条件：`parseAss(text, { strict: true })` 的 Style 字段使用 `Fontsize=40px`、`Bold=1foo`、`Angle=NaN` 等畸形值。
- 根因：ASS 样式构造器使用 `parseFloat` / `parseInt` 宽松读取并退回默认值，strict 模式既不验证数值格式，也不产生 warning；畸形样式被当成成功输入。
- 用户影响：strict 消费者无法拒绝损坏字段，部分输入被静默截断或回退，造成实际字体/位置/效果与文件内容不一致。

### 修改
- subtitle/src/ass.js：仅在 strict 模式验证已知数值样式字段的完整十进制语法、整数型字段的整数/安全范围，以及 Bold/Italic/Underline/StrikeOut 的整数语法；失败经标准 `SubtitleError(PARSE_ERROR)` 传播并保留字段/value cause。lenient 路径继续使用原有 parseFloat/intOr/boolOr 容错。
- subtitle/__tests__/subtitle-parse-edge.test.js：验证带尾随字符数值、NaN 和小数 alignment 在 strict 下报错；lenient 对照保持老行为。

### 验证
- 修复前复现：strict 与 lenient 都返回正常样式（`40px` 被截为 40、`1foo` 被读取为 true、无 warning）。
- 定向测试：`node --test --test-timeout=15000 subtitle/__tests__/subtitle-parse-edge.test.js subtitle/__tests__/subtitle-ass-edge.test.js`，30/30 通过。
- 全量测试：`npm test` 串行通过 3154/3154，0 失败。
- 静态验证：`npm run lint && npm run check` 通过；内嵌全量测试 3154/3154，lint 检查 547 个 JS 文件。该次静态验证同时作为维护计划每 10 次 attempt 阶段验证（Attempt 30）。
- 变更仅影响纯 ESM 字幕解析，媒体浏览器播放管线未变，本轮无需真实浏览器验证。

### 提交和推送
- 本轮待提交：ASS strict 样式字段校验、回归测试及 progress.md。

### 风险
- strict 模式对部分历史上可被 `parseFloat` 前缀读取的畸形数字、非整数位置字段更严格；这是 strict 契约的预期。lenient 默认行为保持兼容。
- 未执行 npm 发布、版本递增、release commit、tag、npm pack 或 npm publish。

### 下一轮候选
- 审计 ASS strict 时间码/Comment 字段覆盖，或探索容器/字幕公共入口把编码与 parse 错误统一映射为项目错误码的边界。

## Attempt 31：修复 ASS strict 超宽颜色截断

### 发现
- 复现条件：strict 解析 ASS Style 中超宽十六进制颜色（`&H123456789ABC&`）、超过 24 位的十进制颜色（`16777216`）或超出安全整数范围的长数字。
- 根因：`parseAssColor()` 为兼容既有输入会对十六进制高位截断、对十进制使用位运算掩码；strict Style 校验此前只检查颜色是否可解析，未检查有效位宽/数值范围。
- 用户影响：strict 模式对严重溢出/越界颜色静默截断，产出与源文件不符的颜色。

### 修改
- subtitle/src/ass.js：strict 模式下颜色字段仅接受 1–6 位（补零至 BGR）或 8 位 AA-BBGGRR 十六进制，以及 0..0xFFFFFF 的安全十进制；非法值纳入标准 `SubtitleError(PARSE_ERROR)`。lenient 路径仍保持既有掩码/截断行为。
- subtitle/__tests__/subtitle-parse-edge.test.js：覆盖超宽十六进制、24 位十进制越界、超过安全整数的十进制拒绝；增加 lenient 超宽颜色仍兼容的对照。

### 验证
- 修复前复现：上述三个颜色均在 strict 下成功解析，产生截断颜色。
- 定向测试：`node --test --test-timeout=15000 subtitle/__tests__/subtitle-parse-edge.test.js subtitle/__tests__/subtitle-ass-edge.test.js`，31/31 通过。
- 全量测试：`npm test` 串行通过 3155/3155，0 失败。
- 静态验证：`npm run lint && npm run check` 通过；内嵌全量测试 3155/3155，lint 检查 547 个 JS 文件。纯字幕 parser 变更无需真实浏览器验证。

### 提交和推送
- 本轮待提交：ASS strict color bounds、回归测试和 progress.md。

### 风险
- strict 新增标准颜色宽度/范围校验；默认 lenient 的既有容错行为保持不变。
- 未执行 npm 发布、版本递增、release commit、tag、npm pack 或 npm publish。

### 下一轮候选
- 继续检查 ASS strict 时间字段与 Comment、Format 列配置的边界；核对 strict 校验与解析器实际消费字段是否一致。

## Attempt 32：严格拒绝 ASS 非法枚举样式

### 发现
- 复现条件：strict ASS Style 使用 `Alignment=0/10/99` 或 `BorderStyle=2`。
- 根因：数值类型检查只验证整数；实际样式构造对 alignment 静默 clamp 至 1–9，而 renderer 只实现 BorderStyle 1/3。非法枚举因此被悄悄改值，或进入未支持渲染分支。
- 用户影响：strict 调用方无法检测非法布局值；ASS 输入声明的对齐/边框效果与最终渲染不一致。

### 修改
- subtitle/src/ass.js：strict 校验 ASS alignment 为 1–9、SSA V4 采用有效旧编号集合 `{1,2,3,5,6,7,9,10,11}`，以及 BorderStyle 限制为 1/3；SSA V4 旧 alignment 编号转换为对应的 ASS numpad alignment，lenient 的既有行为不变。
- subtitle/__tests__/subtitle-parse-edge.test.js：新增越界 alignment、非标准 BorderStyle 拒绝；覆盖合法 ASS 上界与 SSA V4 alignment 11 转换兼容。

### 验证
- 修复前复现：Alignment 0/99 和 BorderStyle 2 均 strict 成功；alignment 被钳制到 1/9，borderStyle 2 原样进入样式。
- 定向测试：`node --test --test-timeout=15000 subtitle/__tests__/subtitle-parse-edge.test.js subtitle/__tests__/subtitle-ass-edge.test.js`，32/32 通过。
- 全量测试：`npm test` 串行通过 3156/3156，0 失败。
- 静态验证：`npm run lint && npm run check` 通过；check 内嵌测试 3156/3156，lint 检查 547 个 JS 文件。字幕解析纯代码变更无需真实浏览器验证。

### 提交和推送
- 本轮待提交：ASS strict enum 校验、SSA V4 alignment 映射、回归测试和 progress.md。

### 风险
- strict 模式现在拒绝不合法的 ASS/SSA enum 输入；lenient 模式仍保持宽容，SSA V4 合法旧值映射到统一的 ASS 1–9 呈现锚点。
- 未执行 npm 发布、版本递增、release commit、tag、npm pack 或 npm publish。

### 下一轮候选
- 继续审计 ASS strict 时间字段与 Comment/Format 列配置边界，重点验证 parser 消费的默认列与 strict 校验覆盖一致。

## Attempt 33：校验 ASS 对齐/边框样式枚举

### 发现
- 复现条件：strict 模式 ASS 样式将 `Alignment` 设为 0/10/99，或将 `BorderStyle` 设为 2。
- 根因：上一轮严格校验只限制字段为整数；样式构造器随后把非法 alignment 静默钳到 1–9，而 BorderStyle=2 虽可被 parser 接受但 renderer 不支持。
- 用户影响：严格解析调用方无法识别布局设置错误，文件请求的对齐效果被改变或边框样式无法正确渲染。

### 修改
- subtitle/src/ass.js：strict 模式验证 ASS Alignment 为 1–9、SSA V4 legacy Alignment 仅接受 1/2/3/5/6/7/9/10/11；BorderStyle 仅接受当前 renderer 支持的 1 或 3。将 SSA V4 legacy 编号转换到统一 ASS numpad 锚点（例如旧值 11 → 6）。
- subtitle/__tests__/subtitle-parse-edge.test.js：覆盖非法/边界 enum 拒绝、BorderStyle=3 和 Alignment=9 的有效边界，以及 SSA V4 旧值转换。

### 验证
- 修复前复现：Alignment 0/99 和 BorderStyle 2 均 strict 成功；alignment 被静默钳到 1/9，borderStyle 2 原样进入结果。
- 定向测试：`node --test --test-timeout=15000 subtitle/__tests__/subtitle-parse-edge.test.js subtitle/__tests__/subtitle-ass-edge.test.js`，32/32 通过。
- 全量测试：`npm test` 串行通过 3156/3156，0 失败。
- 静态验证：`npm run lint && npm run check` 通过；check 内嵌测试 3156/3156，lint 检查 547 个 JS 文件。变更仅涉及纯 ESM 字幕解析，无需真实浏览器验证。

### 提交和推送
- 已提交并推送：`e2d3b34 fix: validate strict ass style enums`（ASS strict enum 校验、SSA V4 映射、回归测试和 progress.md）。

### 风险
- strict 模式将拒绝非标准 alignment/borderStyle 值；lenient 模式沿用现有宽容策略，合法 SSA V4 旧编号保留并映射。
- 未执行 npm 发布、版本递增、release commit、tag、npm pack 或 npm publish。

### 下一轮候选
- 继续审计 strict ASS 时间码与 `[Events] Format` 列表，确认 missing 列不会让严格输入静默错映射。

## Attempt 34：拒绝 strict ASS Format 空列和重复列

### 发现
- 复现条件：strict 模式的 Style Format 声明 `Bold, Bold` 等重复列，或 `Name, , Fontsize` 等空列；Events Format 同样可出现重复/空列。
- 根因：Format 字段名被直接转成索引映射；重复字段会让后一个值覆盖前一个，空字段名则生成无法访问的记录键。strict 模式未检查这些结构错误，仍可能成功返回，但结果取值已歧义。
- 用户影响：strict 调用者会收到表面成功但字段静默错映射的样式/字幕数据。

### 修改
- subtitle/src/ass.js：strict 模式在 Style 和 Events Format 解析时拒绝空字段名及大小写归一后的重复字段名，抛出带行号/列详情的 `SubtitleError(PARSE_ERROR)`；lenient 保持旧的兼容映射行为。
- subtitle/__tests__/subtitle-parse-edge.test.js：覆盖 Style/Events 两种 Format 的空列和重复列，并验证 lenient duplicate 列继续兼容。

### 验证
- 修复前复现：strict 接受 `Bold, Bold` 和空列格式，重复 Bold 时后一值覆盖前值。
- 定向测试：`node --test --test-timeout=15000 subtitle/__tests__/subtitle-parse-edge.test.js subtitle/__tests__/subtitle-ass-edge.test.js`，33/33 通过。
- 全量测试：`npm test` 串行通过 3157/3157，0 失败。
- 静态验证：`npm run lint && npm run check` 通过；check 内嵌全量测试 3157/3157，lint 检查 547 个 JS 文件。纯字幕解析变更不触及浏览器播放管线，无需真实浏览器验证。

### 提交和推送
- 已提交并推送：`ba1e9ab fix: reject ambiguous strict ass formats`（strict Format 校验、回归测试及 progress.md）。

### 风险
- strict 现在拒绝空/重复的 Format 列；lenient 默认兼容行为未改变。未变更公共 API 或运行时依赖。
- 未执行 npm 发布、版本递增、release commit、tag、npm pack 或 npm publish。

### 下一轮候选
- 检查 strict Events Format 缺少关键 Start/End/Text/Style 字段时的处理，以及非法 Script Info 数值字段是否有静默 NaN/截断问题。

## Attempt 35：拒绝缺少字幕必需列的 strict Events Format

### 发现
- 复现条件：`[Events] Format` 声明有足够列数但缺少 `Text`，例如 `Layer, Start, End, Style`，随后 Dialogue 带合法时间码。
- 根因：strict 只检查行字段数量，不验证 Dialogue 格式必需的 Start/End/Text 字段；缺失 Text 时通过 `rec.text ?? ''` 作为空正文产出 cue。
- 用户影响：严格解析错误的字幕文件会“成功”返回空字幕 cue，输入故障不易被调用方发现。

### 修改
- subtitle/src/ass.js：strict Dialogue 记录解析前要求 Events Format 含 Start、End、Text；缺少任一列时抛带行号/缺失字段详情的 `SubtitleError(PARSE_ERROR)`。Comment 仍只计数且不进入字幕轨道，不额外强制其含字幕正文列。
- subtitle/__tests__/subtitle-parse-edge.test.js：覆盖分别缺少 Start、End、Text 的严格拒绝，并保留合法最小 Format 的正例。

### 验证
- 修复前复现：strict 模式接受缺 Text 的格式，产出 1 个正文为空、时间有效的 cue。
- 定向测试：`node --test --test-timeout=15000 subtitle/__tests__/subtitle-parse-edge.test.js subtitle/__tests__/subtitle-ass-edge.test.js`，34/34 通过。
- 全量测试：`npm test` 串行通过 3158/3158，0 失败。
- 静态验证：`npm run lint && npm run check` 通过；内嵌全量测试 3158/3158，lint 检查 547 个 JS 文件。仅影响字幕文本解析，不涉及浏览器播放管线，无需真实浏览器验证。

### 提交和推送
- 已提交并推送：`1238b45 fix: require strict ass dialogue fields`（strict Dialogue 必需列校验、回归测试及 progress.md）。

### 风险
- strict 模式拒绝不含 Start/End/Text 的 Dialogue Format；合法 ASS 默认列序及 lenient 模式行为保持原样。Comment 行不要求 Text 列。
- 未执行 npm 发布、版本递增、release commit、tag、npm pack 或 npm publish。

### 下一轮候选
- 检查 strict Script Info PlayResX/Y 是否发生 `parseInt` 截断或 NaN，并确认零/负分辨率语义。

## Attempt 36：严格验证 ASS PlayRes 尺寸

### 发现
- 复现条件：strict 模式在 `[Script Info]` 中使用 `PlayResX: 640px`、非数字、零/负值或超出安全整数的分辨率。
- 根因：PlayResX/Y 使用 `parseInt` 而无严格校验，导致前缀数字被截断、非法内容产生 `NaN`，零/负尺寸也被作为有效输出。Renderer 会使用 PlayRes 尺寸决定坐标缩放；非法值可能造成不合理布局或 fallback。
- 用户影响：strict 模式放过损坏的坐标系元数据，无法保证解析结果中的分辨率可作为合法尺寸使用。

### 修改
- subtitle/src/ass.js：strict 下 PlayResX/Y 必须为正安全整数的纯十进制形式；解析失败以 `SubtitleError(PARSE_ERROR)` 给出行号、字段和值。lenient 继续保留既有 parseInt 前缀容忍。
- subtitle/__tests__/subtitle-parse-edge.test.js：覆盖两个方向的前缀/非数字/零/负/溢出拒绝、合法尺寸，以及 lenient 旧行为。

### 验证
- 修复前复现：`640px` 被接受为 640，非数字产生 NaN，负数和 0 同样被接受。
- 定向测试：`node --test --test-timeout=15000 subtitle/__tests__/subtitle-parse-edge.test.js subtitle/__tests__/subtitle-ass-edge.test.js`，35/35 通过。
- 全量测试：`npm test` 串行通过 3159/3159，0 失败。
- 阶段验证（第 10 轮）：`npm run lint && npm run check` 通过；内嵌全量测试 3159/3159，lint 检查 547 个 JS 文件。check 的 PRD 门槛摘要仍报告覆盖计数 0/565、0/16 模块达门槛，但脚本结论为全部通过（该摘要是报告性输出）；并非本次回归失败。
- 改动只涉及字幕 parser 元数据校验，不触及媒体播放/渲染管线，无需真实浏览器验证。

### 提交和推送
- 已提交并推送：`47d67bd fix: validate strict ass script dimensions`（strict PlayRes 校验、回归测试及 progress.md）。

### 风险
- strict 模式拒绝非规范的带符号、带前导零、非整数、非正或不安全范围的 PlayRes；lenient 解析和公共 API 均不变。
- 未执行 npm 发布、版本递增、release commit、tag、npm pack 或 npm publish。

### 下一轮候选
- 审查 Script Info 重复关键键、Style/Events 缺失 Format 时 strict 的默认列回退契约，以及 PlayRes 安全范围是否需上限。

## Attempt 37：严格模式拒绝重复 Script Info 键

### 发现
- 复现条件：`[Script Info]` 含大小写不同但归一后相同的键（例如 `PlayResX: 640` 与 `playresx: 1280`）。
- 根因：解析器以归一化 key 存入 `info` 对象，后出现的值静默覆盖先值；strict 模式没有发现关键元数据重复，调用方只能看到最终值。
- 用户影响：严格模式输入中的冲突元数据被悄悄覆盖，降低了错误可诊断性，也可能造成坐标尺寸取值歧义。

### 修改
- subtitle/src/ass.js：在 parseAss 中跟踪归一化 Script Info key；strict 模式重复键抛带行号、字段和值的 `SubtitleError(PARSE_ERROR)`。lenient 仍以后值覆盖。
- subtitle/__tests__/subtitle-parse-edge.test.js：覆盖大小写归一重复 PlayResX 的拒绝，并确认 lenient 兼容行为。

### 验证
- 修复前复现：strict 与 lenient 都接受重复 PlayResX 并返回最后值 1280。
- 定向测试：`node --test --test-timeout=15000 subtitle/__tests__/subtitle-parse-edge.test.js subtitle/__tests__/subtitle-ass-edge.test.js`，36/36 通过。
- 全量测试：`npm test` 串行通过 3160/3160，0 失败。
- 静态验证：`npm run lint && npm run check` 通过；内嵌全量测试 3160/3160，lint 检查 547 个 JS 文件。check 报告性门槛表统计为 0/565、0/16，但脚本结论为全部通过。纯字幕 parser 变更不涉及浏览器播放管线，无需真实浏览器验证。

### 提交和推送
- 已提交并推送：`b11678f fix: reject duplicate strict ass metadata`（Script Info strict duplicate 检查、回归测试及 progress.md）。

### 风险
- strict 模式现在拒绝任何重复 Script Info key（不只 PlayRes）；lenient 路径与输出对象兼容行为保持不变。
- 未执行 npm 发布、版本递增、release commit、tag、npm pack 或 npm publish。

### 下一轮候选
- 检查 strict 时缺少 Style/Events Format 是否仍静默启用默认列序，并确认该 fallback 与既有项目契约一致。

## Attempt 38：隔离 ASS 节 Format 状态并严格要求声明

### 发现
- 复现条件：`[Events]` 下无 `Format:` 时 strict Dialogue 会按默认列序成功解析，缺少明确列定义；另一情况是重复 Events/Styles 节在省略新 `Format:` 后错误继承前一节的列序。
- 根因：Style 默认列和 Events Format 状态保留为跨节局部变量；进入重复节不重置列序。strict 还对缺失 Format 静默使用 V4+ 默认列，可能把自定义/畸形布局误映射。
- 用户影响：strict 模式下记录内容可能按错误的字段布局解释，给出时间/正文/样式错误却表面成功的结果。

### 修改
- subtitle/src/ass.js：进入 V4/V4+ Styles 节时恢复独立的默认 Style 列序并清除显式声明标记；进入 Events 节时清空该节 eventFormat，避免跨节泄漏。strict Style 行与 Dialogue 行要求当前节已有显式 Format 声明；lenient 仍按既有默认列序兜底。
- subtitle/__tests__/subtitle-parse-edge.test.js：覆盖严格模式缺 Style/Events Format 拒绝、lenient 默认列序兼容，以及重复 Events/Styles 节不继承前节列序。

### 验证
- 修复前复现：strict Events 在没有 `Format:` 时成功产出 1 个 cue。
- 定向测试：`node --test --test-timeout=15000 subtitle/__tests__/subtitle-parse-edge.test.js subtitle/__tests__/subtitle-ass-edge.test.js subtitle/__tests__/ass.test.js`，56/56 通过。
- 全量测试：`npm test` 串行通过 3162/3162，0 失败。
- 静态验证：`npm run lint && npm run check` 通过；内嵌测试 3162/3162，lint 检查 547 个 JS 文件。check 中覆盖门槛汇总仍显示报告值 0/565、0/16，脚本结论为全部通过。
- 改动仅限 ASS parser 的结构/列映射，不触及浏览器播放管线，无需真实浏览器验证。

### 提交和推送
- 本轮待提交：ASS 节 Format 状态隔离、strict 显式声明要求、回归测试和 progress.md。

### 风险
- strict 输入缺 Format 时现在会抛 `PARSE_ERROR`，属于严格模式契约；lenient 行为保持兼容。默认公共 API 没变化。
- 未执行 npm 发布、版本递增、release commit、tag、npm pack 或 npm publish。

### 下一轮候选
- 继续审查 strict 对空 Dialogue 文本、缺少 Style 列/引用不存在样式的约束，判断哪些应为语法错误、哪些保留有效 fallback。

## Attempt 39：严格校验 ASS Style 零值/负几何值

### 发现
- 复现条件：strict ASS Style 将 `Fontsize: 0`、`ScaleX/ScaleY <= 0`、负 `Outline`/`Shadow`/Margin 值当作可用样式数据接受。
- 根因：既有校验仅检查数值语法、整数形式及 Alignment/BorderStyle 枚举，没有约束会造成零字高、退化/镜像缩放或无效几何留白的值域。
- 用户影响：strict 输入会成功输出对布局/渲染无意义或具有误导性的 Style。

### 修改
- subtitle/src/ass.js：strict 拒绝数值为零的字号（覆盖 `0`、`0.0`、`-0`）、非正缩放，以及负描边、阴影和 Margin；lenient 路径不变。
- 兼容边界：保留负 Fontsize、Spacing 与 Angle，不把实现差异误当作格式错误。libass 兼容性说明确认 VSFilter/libass 会保留负 Fontsize 并在渲染时使用绝对值：https://github.com/TheOneric/libass/commit/5ca4c9ba44f73f3088f6dbd7a9f6009a8759d675.patch 。
- subtitle/__tests__/subtitle-parse-edge.test.js：覆盖拒绝值、零字号不同写法、负值兼容，以及 lenient 零字号保持原行为。

### 验证
- 修复前复现：strict 接受 0 字号、负/零缩放、负描边/阴影/Margin。
- 定向测试：`node --test --test-timeout=15000 subtitle/__tests__/subtitle-parse-edge.test.js subtitle/__tests__/subtitle-ass-edge.test.js subtitle/__tests__/ass.test.js`，57/57 通过。
- 全量测试：`npm test` 串行通过 3163/3163，0 失败。
- 静态验证：`npm run lint && npm run check` 通过；内嵌测试 3163/3163，lint 检查 547 个 JS 文件。check 报告性门槛表仍显示 0/565、0/16，脚本结论全部通过。字幕 parser 变更不触及播放/渲染执行管线，无需真实浏览器验证。

### 提交和推送
- 已提交并推送：`4017947 fix: validate strict ass style ranges`（Style strict 数值范围检查、回归测试及 progress.md）。

### 风险
- 数值范围规则只影响显式 strict 模式；lenient 保持历史兼容。strict 仍接受负 Fontsize，这是为兼容 VSFilter/libass 行为而有意保留。
- 未执行 npm 发布、版本递增、release commit、tag、npm pack 或 npm publish。

### 下一轮候选
- 继续审查 strict Dialogue 的 Style 字段缺省/未知样式引用，以及空正文是否属于合法零内容 cue，避免把有效 fallback 误判为结构错误。

## Attempt 40：修复 SSA Marked 层级映射

### 发现
- 复现条件：SSA `[Events]` 使用 `Format: Marked, ...`，Dialogue 的首字段是 `Marked=1`。
- 根因：解析器把 `Marked=1` 原样传给 `parseInt`，解析失败后静默退为 layer 0；SSA 的二态标记信息因此丢失。
- 用户影响：旧式 SSA 字幕的事件层级/绘制顺序错误。

### 修改
- subtitle/src/ass.js：识别 `Marked=0` / `Marked=1` 并映射至相应 layer；strict 模式中 Marked 存在且无 Layer 字段时拒绝非法标记；显式 Layer 仍优先于 Marked。lenient 对无效标记保持 layer 0 fallback。
- subtitle/__tests__/subtitle-ass-edge.test.js：将原先“当前缺陷”的守卫改为回归测试，覆盖两种合法 Marked 值、strict/lenient 解析、非法严格输入和显式 Layer 优先级。

### 验证
- 修复前复现：Marked=1 输入成功解析但 cue.layer 错误为 0。
- 定向测试：`node --test --test-timeout=15000 subtitle/__tests__/subtitle-ass-edge.test.js subtitle/__tests__/ass.test.js subtitle/__tests__/subtitle-parse-edge.test.js`，57/57 通过。
- 全量测试：`npm test` 串行通过 3163/3163，0 失败。
- 静态验证：`npm run lint && npm run check` 通过；内嵌全量测试 3163/3163，lint 检查 547 个 JS 文件。check 的报告性门槛表显示 0/565、0/16，脚本结论全部通过。只涉及 ASS/SSA parser，不改播放/渲染管线，无需真实浏览器验证。

### 提交和推送
- 已提交并推送：`3d11ec2 fix: map ssa marked values to layers`（SSA Marked layer 映射、回归测试及 progress.md）。

### 风险
- `Marked=0/1` 到 layer 0/1 的映射只作用于 SSA Marked 格式；正常 V4+ `Layer` 字段优先。strict 新增非法 Marked 拒绝，lenient 行为兼容。
- 未执行 npm 发布、版本递增、release commit、tag、npm pack 或 npm publish。

### 下一轮候选
- 审查 strict Dialogue 中缺省/未知 Style 引用与空正文的兼容语义，寻找高价值且可验证的解析问题。

## Attempt 41：按 SSA/V4+ 版本推断 Events 默认列序

### 发现
- 复现条件：旧式 SSA 使用 `[V4 Styles]`，省略 Events `Format:`，按标准 SSA 列序提供 `Marked=1` 事件。
- 根因：无 Format 时 `inferEventFormat` 对所有格式都返回 V4+ `Layer` 列序，导致 SSA 的 `Marked=1` 被误当 Layer 字段，时间/文本列也可能错位。
- 用户影响：SSA 缺失可选 Format 行时，cue 内容和时间码会被错误解析。

### 修改
- subtitle/src/ass.js：记录当前 Styles 版本，V4/SSA 文件缺少 Events Format 时推断 `Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`；V4+ 仍用 Layer 列序。显式 Format 优先。
- subtitle/__tests__/subtitle-ass-edge.test.js：覆盖 SSA `Marked=1` 无 Format 时起止时间、层级和文本；原 V4+ 缺 Format 且含逗号测试继续守护旧行为。

### 验证
- 修复前复现：SSA 无 Events Format 解析得到 layer 0（而非 Marked=1）；其余字段在样例中看似正常，掩盖了版本特定错误。
- 定向测试：`node --test --test-timeout=15000 subtitle/__tests__/subtitle-ass-edge.test.js subtitle/__tests__/ass.test.js subtitle/__tests__/subtitle-parse-edge.test.js`，58/58 通过。
- 全量测试：`npm test` 串行通过 3164/3164，0 失败。
- 静态验证：`npm run lint && npm run check` 通过；内嵌全量测试 3164/3164，lint 检查 547 个 JS 文件。check 报告门槛摘要仍为 0/565、0/16，脚本结论全部通过。仅字幕解析逻辑变更，不需浏览器验证。

### 提交和推送
- 已提交并推送：`23c6f0a fix: infer legacy ssa event columns`（SSA/V4+ 版本化默认事件列序、回归测试及 progress.md）。

### 风险
- 缺 Format 的 SSA 文件现按 SSA V4 Marked 列序解析，V4+ fallback 保持现状。显式 Events Format 仍完全控制字段映射。
- 未执行 npm 发布、版本递增、release commit、tag、npm pack 或 npm publish。

### 下一轮候选
- 检查缺失 Style 字段在 strict Format 下是否存在默认样式契约歧义，及空 Dialogue 正文是否应保持合法零内容 cue。

## Attempt 42：strict ASS 拒绝未知 Dialogue Style 引用

### 发现
- 复现条件：文件声明自定义样式 `Custom`，Dialogue 引用未声明的 `Missing`。
- 根因：解析器未找到引用时静默退回 `styles[0]`，导致 cue 看似成功，却按无关样式渲染；strict 模式也没有指出配置拼写/声明错误。
- 用户影响：严格校验不能发现无效样式引用，输出字幕视觉属性与输入声明不一致。

### 修改
- subtitle/src/ass.js：strict 且存在样式表时，Dialogue 未命中大小写不敏感样式名即抛 `SubtitleError(PARSE_ERROR)`，detail 带行号、字段和值。lenient 继续回退首个样式；没有 Styles 节时仍用默认样式。
- subtitle/__tests__/subtitle-parse-edge.test.js：验证 strict 拒绝未知引用、lenient 保持原回退，且无样式表时 strict 仍能使用默认样式。

### 验证
- 修复前复现：strict/lenient 均接受 `Missing` 并改用首个样式 `Custom`。
- 定向测试：`node --test --test-timeout=15000 subtitle/__tests__/subtitle-parse-edge.test.js subtitle/__tests__/ass.test.js subtitle/__tests__/subtitle-ass-edge.test.js`，59/59 通过。
- 全量测试：`npm test` 串行通过 3165/3165，0 失败。
- 静态验证：`npm run lint && npm run check` 通过；lint 检查 547 个 JS 文件，check 内嵌测试 3165/3165。PRD 覆盖门槛摘要 0/565、0/16 为报告性输出，脚本结论全部通过。纯 parser 逻辑未触及浏览器执行管线，无需真实浏览器验证。

### 提交和推送
- 已提交并推送：`b23a20f fix: reject unknown strict ass styles`（Dialogue 样式引用 strict 验证、回归测试及 progress.md）。

### 风险
- strict 模式现在拒绝已声明样式表中的未解析引用；lenient 和无 Styles 节的默认样式行为不变。无公共 API 变更。
- 未执行 npm 发布、版本递增、release commit、tag、npm pack 或 npm publish。

### 下一轮候选
- 检查缺失 Style 字段与空 Dialogue 正文的严格模式兼容语义，避免将合法 fallback 或零内容 cue 误判。

## Attempt 43：strict ASS 拒绝大小写冲突的重复 Style 名

### 发现
- 复现条件：样式表定义 `Default` 和 `default`，Dialogue 引用 `DEFAULT`。
- 根因：解析器的样式查找大小写不敏感、始终取首个匹配项，但 strict 未检查样式名称冲突；文件会成功解析，却有第二个无法被 Dialogue 明确引用的 Style。
- 用户影响：严格模式接受解析歧义，样式选择取决于文件记录顺序，妨碍诊断拼写和字体/颜色意外。

### 修改
- subtitle/src/ass.js：strict 新增大小写不敏感的重复 Style 名检查；重名时抛带行号、字段和值的 `SubtitleError(PARSE_ERROR)`。lenient 仍保留全部样式并沿用首个匹配行为。
- subtitle/__tests__/subtitle-parse-edge.test.js：覆盖大小写冲突、strict 错误详情和 lenient 原有顺序/选择行为。

### 验证
- 修复前复现：`Default`/`default` 两个 Style 在 strict 下均被接受，Dialogue 对 `DEFAULT` 静默选择首项。
- 定向测试：`node --test --test-timeout=15000 subtitle/__tests__/subtitle-parse-edge.test.js subtitle/__tests__/ass.test.js subtitle/__tests__/subtitle-ass-edge.test.js`，60/60 通过。
- 全量测试：`npm test` 串行通过 3166/3166，0 失败。
- 静态验证：`npm run lint && npm run check` 通过；lint 扫描 547 个 JS 文件，check 内嵌测试 3166/3166。PRD 覆盖门槛摘要 0/565、0/16 为报告值，结论全部通过。纯字幕 parser 变更无浏览器验证需求。

### 提交和推送
- 已提交并推送：`76e2cad fix: reject duplicate strict ass style names`（Style 名 strict 唯一性校验、回归测试及 progress.md）。

### 风险
- 只影响显式 strict 模式；lenient 重名样式行为未变。没有公开 API 变化。
- 未执行 npm 发布、版本递增、release commit、tag、npm pack 或 npm publish。

## Attempt 44：strict 校验 ASS Dialogue Layer 安全整数

### 发现
- 复现条件：`Layer` 为 `2abc`、`1.5` 或超出 JS 安全整数的数值。
- 根因：cue 创建使用 `parseInt` 容错，strict 路径此前没有校验 V4+ `Layer` 字段；畸形值静默变成前缀整数或失真数字。
- 用户影响：strict 接受损坏/精度不可靠的事件层级，绘制顺序可能错乱。

### 修改
- subtitle/src/ass.js：strict Dialogue 存在 `Layer` 列时要求有符号十进制整数并确保 `Number.isSafeInteger`；允许负层级和显式正号。lenient 保持历史 `parseInt` 行为。
- subtitle/__tests__/subtitle-parse-edge.test.js：覆盖前缀/小数/越界/空值拒绝、负/正安全整数接受及 lenient 前缀兼容。

### 验证
- 修复前复现：strict 接受 `2abc`、`1.5`、`9007199254740992`，输出 Layer 为 2、1 和失真数值。
- 定向测试：`node --test --test-timeout=15000 subtitle/__tests__/subtitle-parse-edge.test.js subtitle/__tests__/subtitle-ass-edge.test.js subtitle/__tests__/ass.test.js`，61/61 通过。
- 第 20 轮阶段全量验证：`npm test && npm run lint && npm run check` 通过；全量测试 3167/3167，lint 检查 547 个 JS 文件。check 报告的 PRD 覆盖门槛摘要仍为 0/565、0/16（报告输出），结论全部通过。
- 改动仅限 ASS parser strict 校验，无需浏览器播放验证。

### 提交和推送
- 已提交并推送：`47b1ec1 fix: validate strict ass dialogue layers`（Dialogue Layer strict 整数校验、回归测试及 progress.md）。

### 风险
- 范围只影响 strict 输入；负安全整数保留为合法 layer，lenient 不变。无公共 API 变化。
- 未执行 npm 发布、版本递增、release commit、tag、npm pack 或 npm publish。

### 下一轮候选
- 检查 strict ASS 空 Dialogue 正文和缺失/空 Style 字段的有效性契约，避免错误拒绝合法内容。

## Attempt 45：strict 校验 ASS Dialogue Margin 安全整数

### 发现
- 复现条件：Dialogue 的 `MarginL`、`MarginR` 或 `MarginV` 含 `1.5`、`-4`、`12px` 或超出安全整数范围的值。
- 根因：事件 Margin 以原始字符串直接传入 cue settings，strict 模式未检查格式或数值范围。
- 用户影响：strict 解析接受非法/负坐标 margin，可能导致字幕定位异常，并丧失输入校验可靠性。

### 修改
- subtitle/src/ass.js：strict Dialogue 中存在的 MarginL/R/V 字段必须为空（沿用 ASS 缺省值兼容）或为非负安全十进制整数；空白会被字段解析 trim 成空值。lenient 行为不变。
- subtitle/__tests__/subtitle-parse-edge.test.js：覆盖三个 margin 字段的负数、小数、尾随字符和超安全整数拒绝，合法值解析及 lenient 兼容。

### 验证
- 修复前复现：strict 接受 `1.5`、`-4`、`12px` 和 `9007199254740992`。
- 定向测试：`node --test --test-timeout=15000 subtitle/__tests__/subtitle-parse-edge.test.js subtitle/__tests__/subtitle-ass-edge.test.js subtitle/__tests__/ass.test.js`，62/62 通过。
- 全量测试：`npm test` 串行通过 3168/3168，0 失败。
- 静态验证：`npm run lint && npm run check` 通过；lint 扫描 547 个 JS 文件，check 内嵌测试 3168/3168；PRD 覆盖摘要 0/565、0/16 为报告性输出，check 结论全部通过。纯 parser 修改，无需真实浏览器验证。

### 提交和推送
- 已提交并推送：`0e2be2b fix: validate strict ass event margins`（strict Dialogue Margin 校验、回归测试及 progress.md）。

### 风险
- 只在 strict 模式拒绝非法非空 Margin；lenient 与公共 API 保持不变。允许空 Margin 与样式默认语义兼容。
- 未执行 npm 发布、版本递增、release commit、tag、npm pack 或 npm publish。

### 下一轮候选
- 继续检查空 Dialogue 正文及其他可选字段 strict fallback 契约。

## Attempt 46：保留 strict ASS 缺失/空 Dialogue Style 的 fallback

### 发现
- 复现条件：样式表仅定义自定义 `Custom`，Events Format 不包含 `Style` 列，或 Style 列值为空。
- 根因：上一轮 strict 未知 Style 检查将缺省 `Default` 视为显式样式名；自定义样式表并无 Default 定义时，合法的可选字段 fallback 被误判为无效引用。
- 用户影响：启用 strict 的合法 ASS 文件因省略可选 Style 列/值而失败，与既有 parser 的“匹配不到则首样式 fallback”兼容契约冲突。

### 修改
- subtitle/src/ass.js：区分原始 Style 是否由输入显式非空给出；strict 只拒绝显式未知名称，缺失或空值继续使用 Default（命中时）或首个已声明样式。
- subtitle/__tests__/subtitle-parse-edge.test.js：覆盖无 Style 列、空 Style 值自定义样式 fallback，以及存在 Default 样式时的缺省优先级；Attempt 42 的显式未知名称 strict 拒绝仍保留。

### 验证
- 修复前复现：strict 对无 Style 列和空 Style 值均抛 `PARSE_ERROR`，提示引用未定义 Default。
- 定向测试：`node --test --test-timeout=15000 subtitle/__tests__/subtitle-parse-edge.test.js subtitle/__tests__/subtitle-ass-edge.test.js subtitle/__tests__/ass.test.js`，63/63 通过。
- 全量测试：`npm test` 串行通过 3169/3169，0 失败。
- 静态验证：`npm run lint && npm run check` 通过；lint 检查 547 个 JS 文件，check 内嵌测试 3169/3169；PRD 门槛摘要 0/565、0/16 为报告性输出，check 结论全部通过。纯 parser 变更无需真实浏览器验证。

### 提交和推送
- 已提交并推送：`218bd92 fix: preserve strict ass style fallback`（修复缺失/空 Style strict 回退、回归测试及 progress.md）。

### 风险
- strict 仍拒绝显式写出的未知非空 Style；只有省略或空值走既有缺省 fallback。lenient 与公共 API 不变。
- 未执行 npm 发布、版本递增、release commit、tag、npm pack 或 npm publish。

### 下一轮候选
- 继续检查空 Dialogue 正文及其他可选事件字段的 strict 合法性契约。

## Attempt 47：支持 Text 不在末列的 ASS Events Format

### 发现
- 复现条件：Events Format 声明 Text 后还有 Start、End、Style 等列，Dialogue 的 Text 正文包含逗号。
- 根因：事件解析一律将最后一列当作逗号承载列，忽略 Text 的列位置；Text 非末列时，逗号文本泄漏至时间码/其他字段，strict 抛错或 lenient 跳过 cue。
- 用户影响：按自定义列序的 ASS Events 无法解析带逗号的对白，或事件字段错位。

### 修改
- subtitle/src/ass.js：唯一 Text 列前面的字段从左侧按序切分，Text 收集剩余字段中为其保留末尾列后缀后的逗号片段，后续字段从右侧按序映射。Text 位于末列仍走既有逻辑；重复 Text 在 strict 已被 Format 校验拒绝，lenient 保持旧路径。
- subtitle/__tests__/subtitle-parse-edge.test.js：覆盖 Layer, Text, Start, End, Style 中含逗号对白在 strict/lenient 下的文本/时间/样式映射，及非末列空 Text。

### 验证
- 修复前复现：Format: Layer, Text, Start, End, Style + Hello, world 在 strict 因 Start="world" 抛 PARSE_ERROR，lenient 将 cue 跳过。
- 修复后独立复现：strict/lenient 均完整返回 Hello, world，Start=1s、End=2s、Style=Default。
- 定向测试：node --test --test-timeout=15000 subtitle/__tests__/subtitle-parse-edge.test.js subtitle/__tests__/subtitle-ass-edge.test.js subtitle/__tests__/ass.test.js，64/64 通过。
- 全量测试：npm test 串行通过 3170/3170，0 失败。
- 静态验证：npm run lint && npm run check 通过；lint 检查 547 个 JS 文件，check 内嵌测试 3170/3170；PRD 门槛摘要 0/565、0/16 是报告性输出，结论全部通过。纯解析器变更，不需浏览器播放验证。

### 提交和推送
- 已提交并推送：`aa47bf8 fix: parse reordered ass text columns`（Text 按声明列位置切分、回归测试及 progress.md）。

### 风险
- 列顺序与 Text 逗号归属按 Format 声明处理；Text 为末列时行为未变，strict 和 lenient 兼容均有回归。无公共 API 变化。
- 未执行 npm 发布、版本递增、release commit、tag、npm pack 或 npm publish。

### 下一轮候选
- 检查 ASS 非末列 Text 与逗号分隔数据的无歧义解析，并复核 SRT 恢复边界策略。

## Attempt 48：恢复缺少空行分隔的 SRT 相邻 cue

### 发现
- 复现条件：两个 SRT cue 之间没有空白行，含/不含数字序号均可复现。
- 根因：解析器只按空白行切块；合并块仅取第一条时间行，其余时间行和后续文本被并入第一条 cue 的正文。
- 用户影响：丢失后一条及之后的 cue，字幕时间轴和正文错误。

### 修改
- subtitle/src/srt.js：空行切分后，对单块内多个有效正向时间行恢复 cue 边界；若时间行紧邻纯数字序号，将序号划归新 cue。原有序号/无序号解析和错误时间检测路径保留。
- subtitle/__tests__/subtitle-srt-edge.test.js：将已知缺陷守卫改为回归，覆盖有/无序号以及 strict/lenient 下两条 cue 的正文、时间和零跳过计数。

### 验证
- 修复前复现：strict/lenient 均只返回一条 cue，正文包含第二条时间行和台词。
- 定向测试：node --test --test-timeout=15000 subtitle/__tests__/subtitle-srt-edge.test.js subtitle/__tests__/srt.test.js，27/27 通过。
- 全量测试：npm test 通过，3170/3170，0 失败。
- 静态验证：`npm run lint && npm run check` 和单独重跑 `npm run check` 均退出码 0；lint 检查 547 个 JS 文件；check 内嵌全量测试 3170/3170，0 失败。PRD 门槛摘要 0/565、0/16 是报告性输出，check 结论全部通过。本轮定向 SRT 测试稳定为 27/27。纯 parser 修改，不需浏览器播放验证。

### 提交和推送
- 已提交并推送：`6059627 fix: recover adjacent srt cues`（SRT cue 边界恢复、回归测试及 progress.md）。

### 风险
- 合并块内可解析且递增的后续时间行被视为 cue 起点；若正文刻意包含独立成行、形似合法 SRT 时间行的文本，该行可能被视为新 cue 边界。缺少 separator 的格式本身存在歧义。
- 没有公共 API 变化；未执行 npm 发布、版本递增、release commit、tag、npm pack 或 npm publish。

### 下一轮候选
- 为缺空行的损坏 SRT cue 增加恢复守卫：仅在紧邻数字序号后将疑似时间行作为边界，避免损坏条目隐身。

## Attempt 49：将缺分隔符的损坏 SRT cue 送入错误路径

### 发现
- 复现条件：有效 cue 后紧接纯数字序号，再跟损坏时间行，且无空白分隔。
- 根因：Attempt 48 仅按有效时间戳恢复边界；损坏时间行未成为分段边界，于是和序号、错误 cue 文本一起吞入前一个 cue。
- 用户影响：strict 模式错误地接受损坏字幕，lenient 不增加 skippedBlocks，诊断和错误统计失真。

### 修改
- subtitle/src/srt.js：检测时间行样式候选时，后接纯数字序号的时间行形态即使时间无效也会用作分界；分段后走已有时间解析错误逻辑，strict 抛错、lenient 跳过损坏块。无序号正文中的有效递增时间行仍可恢复 cue。
- subtitle/__tests__/subtitle-srt-edge.test.js：覆盖损坏后续块不污染前 cue 正文，lenient 保留前一 cue 并计数跳过一块，strict 抛 PARSE_ERROR。

### 验证
- 修复前复现：strict/lenient 都只返回一条 cue，正文包含损坏的第二条时间行和台词，skippedBlocks=0。
- 定向测试：node --test --test-timeout=15000 subtitle/__tests__/subtitle-srt-edge.test.js subtitle/__tests__/srt.test.js，28/28 通过。
- 全量测试：npm test 3171/3171，0 失败。
- 静态验证：npm run lint && npm run check 退出码 0；单独重跑 npm run check 确认 3171/3171，lint 检查 547 个 JS 文件；PRD 覆盖摘要 0/565、0/16 为报告性输出，check 结论全部通过。
- 解析器逻辑变更，无需真实浏览器播放验证。

### 提交和推送
- 已提交并推送：`a94e4bf fix: isolate malformed adjacent srt cues`（损坏 SRT cue 边界恢复、回归测试及 progress.md）。

### 风险
- 非空行中的时间行格式与紧随数字的序号组合被视为 cue 边界，因而会将这段正文解释为损坏 cue；此结构与无空行的损坏 SRT 无法在语法上区分。
- 无公共 API 变化；未执行 npm 发布、版本递增、release commit、tag、npm pack 或 npm publish。

### 下一轮候选
- 进一步审查字幕严格模式的其他外部 setting 值校验及浏览器无关解析边界。

## Attempt 50：strict 校验 WebVTT cue settings

### 发现
- 复现条件：cue 时间行携带未知键、重复 align、size/position 大于 100%、非法 vertical 或非法 token。
- 根因：settings 解析器在 strict 和 lenient 下都只按冒号拆分并覆盖重复键；不识别键白名单或各字段值域。
- 用户影响：strict 模式仍接受无效/冲突的显示参数，用户难以发现 settings 拼写错误；渲染方可能因错误值产生非预期布局。

### 修改
- subtitle/src/vtt.js：strict settings 验证允许的键、重复键、空值和裸 token；校验 vertical、line、position、size、align 的枚举/数字/百分比语法及 0–100 范围，region 允许非空不含空白值。解析失败抛带块号、键和值的 PARSE_ERROR。lenient 保留原始宽松覆盖及忽略裸 token 行为。
- 随后对照 WebVTT 规范修正 grammar：百分比允许十进制且范围 0–100；line 仅接受负号行号或百分比（不接受 auto、显式正号）；align 枚举排除 middle；region 标识符允许空字符串，非空时允许任意 token 但排除空格、tab 及 `-->`。严格 token 分隔限定为 ASCII 空格/tab。
- subtitle/__tests__/subtitle-vtt-settings.test.js：覆盖未知/重复/空值/裸 token、非法枚举、越界百分比、有效 strict settings 和 lenient 兼容。

### 验证
- 修复前复现：strict 接受 pos:50%、重复 align、size/position:150%、vertical:sideways。
- 定向测试：node --test --test-timeout=15000 subtitle/__tests__/subtitle-vtt-settings.test.js subtitle/__tests__/vtt.test.js subtitle/__tests__/subtitle-vtt-cue.test.js，49/49 通过。
- 全量测试：npm test 3172/3172，0 失败。
- 静态验证：npm run lint && npm run check 最终退出码 0；lint 扫描 547 个 JS 文件，check 全量测试 3172/3172，结论全部通过。中间发现 full-check 并行负载会使 WebRTC 统计采样的固定短时延测试偶发少采一轮，已改为最多 500ms 条件等待并通过全量复核。
- 改动是格式 parser 校验，不涉及播放渲染管线，无需浏览器播放验证。

### 提交和推送
- 已提交并推送：`84f06ef fix: validate strict webvtt cue settings`（strict WebVTT setting schema 验证、回归和 progress.md）。

### 风险
- 新约束只作用于 strict；lenient 输出兼容保持。strict 可能拒绝此前未校验的未知/重复 cue-setting 键，符合 strict 输入校验目的。
- 没有公开 API 变更；未执行发布、版本递增、release commit、tag、npm pack 或 npm publish。

### 后续规范复核（Attempt 50 续）
- 对照 W3C WebVTT 当前规范发现初始 strict 校验对小数百分比、行号前导正号、align:middle 和空 region ID 的处理有偏差；已修正 grammar，并要求设置之间只以 ASCII 空格/tab 分隔。
- 扩展回归覆盖边界小数、越界小数、空区域标识符、区域标识符空格/箭头、非 ASCII 空白和非标准枚举。定向 VTT + WebRTC 70/70，全量 3172/3172；lint/check 通过（check 内嵌 3172/3172）。
- 已提交并推送 VTT 规范修订及本 addendum：`07f90b5 fix: align strict webvtt settings with spec`；纯 parser，无需浏览器验证。

## Attempt 51：稳定 StatsCollector 周期采样测试

### 发现
- npm run check 的并行全量测试偶发让固定等待 60ms 的 StatsCollector 测试只采到 2 轮而失败（要求至少 3 轮）；单文件隔离连续运行可过，表明是运行负载导致 timer schedule 抖动，而非 collector 行为回归。
- 失败不会反映媒体/WebRTC 用户运行时缺陷，但让门禁不稳定、掩盖真实问题。

### 修改
- webrtc/__tests__/webrtc-stats-backoff.test.js：去掉脆弱的固定 60ms 等待，改为以 10ms 间隔等待第三份样本，最多 500ms；拿到所需样本即停止并保留 stop 后不再采集的断言。生产 StatsCollector 无改动。

### 验证
- 修复前单独重跑该测试文件 21/21 通过，确认失败为并行负载相关的偶发竞态。
- VTT settings + VTT + WebRTC stats 定向测试 70/70 通过。
- 全量 npm test 3172/3172；npm run lint && npm run check 通过，lint 547 个 JS 文件，check 内嵌 3172/3172。
- 纯测试等待时间稳健性修复，不需浏览器验证。

### 提交和推送
- 已提交并推送：`52ebd6c test: stabilize stats sampling timer assertion`（稳健 StatsCollector 计时回归及进度记录）。

### 风险
- 测试最多多等待至 500ms；没有生产代码/API 行为变化。

### 下一轮候选
- 审查未知 cue settings 扩展策略与其他格式的 strict grammar，并寻找媒体管线之外高价值问题。

## Attempt 52：优先按内容位置区分 SRT 与 ASS

### 发现
- 复现输入是正常 SRT cue，正文含独立的 \[Script Info\] 行及 Dialogue 文本；detectFormat 返回 ass，parseAuto 因而错误分派 ASS parser。
- 根因：原判定只要任意位置出现 ASS 节头/Dialogue 行就直接认定 ASS，没有将真实 cue 时间行作为强证据，也没有比较两类特征在全文中的先后位置。

### 修改
- subtitle/src/detect.js：保留 WEBVTT 签名及无签名 VTT 的优先判定；识别独占一行的 SRT 时间模式，与 ASS 结构特征比较在文本中的起点，先出现的特征胜出。SRT cue payload 中后出现的 ASS 外观文本不再覆盖字幕格式；真 ASS 节头先出现时仍按 ASS 分派。
- subtitle/__tests__/subtitle-detect-edge.test.js：将原已知限制改为回归，验证 detectFormat、probeSubtitleCodec 和 parseAuto 对夹带 ASS section/dialogue 字样的 SRT 一致判为 SRT；另覆盖 ASS 节头先于时间行的歧义输入仍保留 ASS。

### 验证
- 修复前复现：夹带 [Script Info] 的有效 SRT 被 detectFormat 与 parseAuto 判为 ASS。
- 定向测试：subtitle-detect-edge、subtitle-detect-track、srt、vtt，55/55 通过。
- 全量测试：npm test 3174/3174，0 失败。
- 静态验证：npm run lint && npm run check 退出码 0，lint 扫描 547 个 JS 文件，check 内嵌测试 3174/3174，结论全部通过。
- 纯格式嗅探 parser 改动，不涉及播放渲染，未需浏览器验证。

### 提交和推送
- 已提交并推送：`3d63edb fix: disambiguate srt and ass subtitle content`（detectFormat 优先级修正、ASS/SRT 混合输入回归及进度记录）。

### 风险
- 格式特征混合文本本质上有歧义：节头/Dialogue 特征若先于独立 SRT 时间行仍按 ASS 处理，以避免 ASS 文件中示例或正文包含时间箭头时误判。
- 无公开 API 变化；未执行发布、版本递增、release commit、tag、npm pack 或 npm publish。

## Attempt 53：修复分片 MP4 seek 中断及多轨扫描丢样本

### 发现
- 复现条件：fragment 中含多个样本；只读取其中部分后 seek，core 会关闭旧迭代器，但 MP4 的共享顶层游标已越过当前 moof。
- 根因：旧实现只把请求轨已 yield 样本放进表，并在请求另一轨时过滤并跳过其 moof 数据。游标前进后 seek 重建迭代器只能重放已缓存项，因此同一 moof 未解析尾样本丢失；交错读取也会让未请求轨无法重放该 fragment 的数据。并行 track pull 还可能重复推进扫描位置。
- 用户影响：播放过程 seek 或多轨异步读取可能产生样本缺口、音视频轨 EOS 不一致或不完整解码。

### 修改
- mp4/src/demuxer.js：共享扫描在每个 moof 解析所有已知轨的样本元数据，仅解析一次；用每轨独立 fragmentReadIndex 重放、加载该轨样本，并在并发读取时共享 in-flight fragment 扫描。
- mp4/src/demuxer.js：fragment seek 将目标轨及其他轨的样本 cursor 与实际 seek 落点对齐；样本读取失败时不提前推进样本 cursor。
- mp4/__tests__/mp4-demuxer-seek-cursor.test.js：把原先记录丢样本限制的用例改为 seek 后要求保留当前 moof 未读尾部，并接续后续 fragment。
- mp4/__tests__/mp4-demuxer-multitrack.test.js：新增音视频 fragmented fixture，验证先读一轨再完整读另一轨，以及两轨并发 pull 均不丢失样本。
- mp4/__tests__/demuxer.test.js：增加 lazySamples 分片 seek/重放后仍可 readSampleData 的回归。

### 验证
- 定向 MP4 测试：node --test --test-timeout=15000 mp4/__tests__/*.test.js，162/162 通过。
- 全量测试：npm test 独立重跑 3160/3160 通过；npm run check 的 fixtures、3176/3176 全量测试及 lint 全部通过（扫描 547 个 JS 文件）。check 中样本数较 npm test 多 16，因 check 先生成并落盘 fixtures；此前一次独立 npm test 受 RTMP 测试的 event-loop pending promise 影响，有 125 项 cancelled，未作为通过结果计入。
- 真实浏览器：Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；双轨 track parse、video 854x480 / readyState=4、播放推进、seek(20s)→16.50s 并恢复至 16.94s、buffered 和销毁均通过，无 console/pageerror/network error/unhandled rejection。浏览器截图由验收脚本临时重写，已还原，不纳入提交。
- git diff --check 通过。

### 提交和推送
- 修复和进度记录完成后独立提交并推送当前分支 maintenance/round-6。

### 风险
- 分片样本索引表会保存每条 track 已扫描过 fragment 的轻量样本元数据；样本 payload 仍按读取方式加载或保持 lazy，支持 seek 与跨轨重放所需的元数据随扫描量增长。
- 本轮未执行发布、版本递增、release commit、tag、npm pack 或 npm publish。

## Attempt 54：修复 fMP4 sample flags 与 track 默认值继承

### 发现
- 复现条件：分片 trun 中省略样本字段、依赖 tfhd/trex 默认值，或使用 first_sample_flags。
- 根因：sample_is_non_sync_sample 位于 sample flags 的第 16 位，旧实现却检查了 sample_depends_on 字段；first_sample_flags 虽由 box parser 解出却未传入 demuxer。tfhd 默认 duration/size/flags 也被忽略；继承 sample size 未正确用于数据偏移时会读错 payload。
- 用户影响：非同步 H.264/H.265 样本可能被误认为关键帧，导致 seek 缺参考帧；未重复声明样本字段的合法 fragmented MP4 可能出现错误时长、关键帧判断或 payload。

### 修改
- mp4/src/demuxer.js：依据 bit 16 判定 sample_is_non_sync_sample；按每样本 → trun.first_sample_flags（仅首样本）→ tfhd → trex 的优先级解析 flags、duration、size；用最终解析出的 sample size 累计 payload 偏移。
- mp4/src/demuxer.js：parseMoofTracks 向调用方传递 tfhd 默认字段及 trun 首样本 flags。
- mp4/__tests__/fragment-defaults.test.js：新增端到端 fMP4 回归，覆盖非同步标志、first_sample_flags、tfhd/trex 的 duration/size/flags defaults 及 payload offsets。

### 验证
- 修复前复现：第二个样本只有 sample_is_non_sync_sample=1 且 sample_depends_on 未设置时，错误地回报 keyframe=true。
- 定向 MP4 全套：node --test --test-timeout=15000 mp4/__tests__/*.test.js，166/166 通过。
- npm run check：fixtures 通过；全量测试 3180/3180；lint 通过（548 个 JS 文件）；check 结论全部通过。
- 真实浏览器：Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；双轨初始化、首帧与分辨率、播放推进、20s seek 对齐至 16.50s 并继续播放、buffered 与释放均正常；无 console/pageerror/network error/unhandled rejection。脚本生成的截图已还原，不纳入提交。
- git diff --check 通过。

### 提交和推送
- 修复和进度记录完成后独立提交并推送当前分支 maintenance/round-6。

### 风险
- API 不变；未执行发布、版本递增、release commit、tag、npm pack 或 npm publish。

## Attempt 55：修复 fMP4 同轨多 trun 时间与 payload 连续性

### 发现
- 复现条件：一个 traf 包含多个 trun，首个 run 带 tfdt 和 data_offset，后续 run 省略 data_offset。
- 根因：解析器把同一个 traf 的每个 trun 当成独立片段，均从同一 baseMediaDecodeTime 开始；demuxer 还将省略 data_offset 的 run 默认为偏移 0，覆盖前一个 run 的 payload。
- 用户影响：合法 fragmented MP4 的同轨后续 run 可能出现重复 DTS、重复/错误数据，导致播放错序或样本损坏。

### 修改
- mp4/src/demuxer.js：每个 moof 扫描时按 track 累积 decode time 与数据末尾；后续 trun 无 data_offset 时从前 run 结束位置接续。
- mp4/src/demuxer.js：解析 trun 时保留 data_offset 的 null 与显式 0 差异，并透传 tfhd base_data_offset / default-base-is-moof 及默认 sample 属性。
- mp4/__tests__/fragment-defaults.test.js：增加同一 traf 两个 trun 的回归，断言 DTS 连续增长且第二 run 读取紧邻的不同 payload。

### 验证
- 修复前复现：第二个 run 的 sample DTS 重复为 100000µs（预期 140000µs），并由显式 payload 检查覆盖偏移回退风险。
- 定向 MP4 全套：node --test --test-timeout=15000 mp4/__tests__/*.test.js，167/167 通过。
- npm run check：fixtures 通过；全量测试 3181/3181；lint 通过（548 个 JS 文件）；check 结论全部通过。
- 真实浏览器：Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；双轨初始化、视频解码、播放推进、20s seek 至 16.50s 并恢复、buffered 和 destroy 均通过；无 pageerror、console error、网络错误或 unhandled rejection。测试生成截图已还原，不纳入提交。
- git diff --check 通过。

### 提交和推送
- 修复和进度记录完成后独立提交并推送当前分支 maintenance/round-6。

### 风险
- 本轮仅改善同一 traf 多 run 的 decode-time 与隐式数据连续性；未新增公共 API。未执行发布、版本递增、release commit、tag、npm pack 或 npm publish。

## Attempt 56：修复 fMP4 隐式 traf 基址和 mdat 样本边界

### 发现
- 分片多轨若省略 tfhd.base_data_offset / default-base-is-moof，后续 traf 的默认数据基址承接前一个 traf 的媒体数据结束位置，而不是重置到 moof 或沿用 track 的上次状态。
- 扫描器未验证 trun 解出的样本范围是否落入该 moof 后的 mdat payload；损坏 offset 会被记录为 lazy sample，直到后续读数据才暴露错误。
- 同一 fragment segment 可以包含多个 mdat；样本 offset 可能合法指向后续 mdat，检查需覆盖 moof 后、下一 moof 前的所有 mdat，而非仅首个。

### 修改
- mp4/src/demuxer.js：解析每个 trun 的 traf 序号；保留各 traf 的隐式数据结束位置，后续隐式 traf 基址承接先前 traf 的媒体数据末尾。decode time 仅在同 traf 的多个 trun 间连续。
- mp4/src/demuxer.js：同一 moof 下收集所有 mdat；样本 [offset, offset+size) 必须完整落入至少一个 mdat payload，否则立即抛 PARSE_ERROR。未选择的 track 仍参与数据布局推导。
- mp4/__tests__/mp4-demuxer-multitrack.test.js：新增省略后续音频 traf 基址和 trun data_offset 的双轨同 moof fixture，断言两路 payload 与连续偏移正确。
- mp4/__tests__/fragment-defaults.test.js：增加跨多个 mdat 的显式 run offset 读取回归，及越界 run offset 立即失败回归。

### 验证
- 定向回归（fragment-defaults、mp4-demuxer-multitrack、demuxer-gaps）：28/28 通过；MP4 全套 169/169 通过。
- npm run check：fixtures 通过；全量测试 3184/3184；lint 通过（548 个 JS 文件）；check 结论全部通过。
- 真实浏览器：Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；双轨解析/初始化、真实视频解码、播放时钟推进、seek 后恢复、buffered 和资源释放均通过。
- 浏览器生成的截图已还原；git diff --check 通过。

### 提交和推送
- 修复和进度记录完成后独立提交并推送当前分支 maintenance/round-6。

### 风险
- 本轮仅修复 fragmented MP4 的 traf 基址、mdat 样本边界校验；未新增公共 API。未执行发布、版本递增、release commit、tag、npm pack 或 npm publish。

## Attempt 57：按单轨 codec 能力安全启动 WebCodecs

### 发现
- 复现条件：音视频双轨中某一种 codec 不受当前 WebCodecs decoder 支持，但另一轨可解。
- 根因：supported() 允许任意一条可解即通过；_ensureDecoders() 却无视逐轨探测结果，仍配置不支持的 decoder，start() 也会启动两条轨道的 pump。
- 用户影响：双轨媒体不能在一轨可播放时优雅降级，可能因不支持的轨道配置失败，使可解码轨道也无法播放。

### 修改
- mp4/src/webcodecs-pipeline.js：_ensureDecoders 仅创建且配置通过对应 isConfigSupported 探测的音频/视频解码器。既有 start() pump 会跳过 decoder 为空的轨道，因此可解码轨正常播放、不支持轨不启动。
- mp4/__tests__/webcodecs-pipeline.test.js：新增视频仅支持、音频仅支持两个启动回归，断言仅有支持的 decoder/pump 工作，并清理 FakeDecoder 全局状态。

### 验证
- 定向 WebCodecs 管线测试（webcodecs-pipeline + gaps）：13/13 通过。
- npm run check：fixtures 通过；全量测试 3185/3185；lint 通过（548 个 JS 文件）；check 结论全部通过。
- 真实浏览器：Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；播放、首帧、时钟推进、seek 后恢复、buffered 与释放均通过。
- 浏览器截图已还原；git diff --check 通过。

### 提交和推送
- 修复和进度记录完成后独立提交并推送当前分支 maintenance/round-6。

### 风险
- 单轨 codec 不支持时现按可解码轨降级；如果所有音视频轨均不支持仍按既有行为返回 decodeError。未新增公共 API；未执行版本/发布工作流。

## Attempt 58：校验 fMP4 重封装样本的 size 和 payload

### 发现
- 复现条件：调用 createMediaSegment 时 Sample.size 与 data.byteLength 不同（可能过短或过长）。
- 根因：重封装器原样写入声明 size，却按 data 实际长度拼装 mdat，输出 trun 的样本边界和后续 payload 偏移不一致，生成不可读/错误解码的 fMP4。对非 Uint8Array 的 typed view 还需严格保留 view 的 byteOffset 与 byteLength。
- 用户影响：由 remuxer 接受的外部 Sample 会损坏产生的媒体段；失败延迟到下游解码才显现。

### 修改
- mp4/src/remuxer.js：在推进 sequenceNumber 或构建 moof 前验证 data 为 byte buffer/view、size 是非负安全整数且与 data.byteLength 一致、size 不超过 BMFF 32-bit sample size。
- mp4/src/remuxer.js：将 ArrayBuffer 和 typed-array 子视图规范化为准确 Uint8Array 字节范围，避免误写 view 底层无关字节。
- mp4/__tests__/remuxer.test.js：新增小/大 size mismatch 拒绝、非法样本不得消耗 sequence number、ArrayBuffer 正常输入与 typed subarray 范围精准输出回归。

### 验证
- 定向 remuxer、remuxer-gaps、muxer-roundtrip 测试：12/12 通过。
- npm run check：fixtures 通过；全量测试 3186/3186；lint 通过（548 个 JS 文件）；check 结论全部通过。
- 真实浏览器：Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；真实解码、播放推进、seek 后恢复、buffer 水位及 destroy 全部通过。
- 浏览器截图已恢复；git diff --check 通过。

### 提交和推送
- 修复和进度记录完成后独立提交并推送当前分支 maintenance/round-6。

### 风险
- 无公共 API 改动；错误的 Sample 输入现在更早抛出 STATE_ERROR，正确 byte buffer/view 保持支持。未执行版本/发布工作流。

## Attempt 59：确保 remux GOP 切批只在随机访问点边界发生

### 发现
- 复现条件：视频 GOP 长于 3× targetDurationUs，且 GOP 内没有关键帧。旧兜底按时长在 delta sample 后拆出后续分段。
- 根因：batchSamplesByGop 的“3× 时长兜底”在非关键帧处强制 flush，导致下一 moof 的第一 sample 仍依赖前段中的参考帧；对 MSE 独立 media segment 来说不是有效随机访问起点。旧算法还把切点关键帧放在前一段末尾，而非后一段开头。
- 相关边界：若输入开头为 delta samples，直接生成的首段也无法从随机访问点开始；无 keyframe metadata 的轨则不能安全猜测切点。

### 修改
- mp4/src/remuxer.js：达到目标时长后仅在遇到下一个关键帧时 flush 前一 GOP，并将该关键帧放入新段；删除 mid-GOP 强制切段。
- mp4/src/remuxer.js：跳过首个 keyframe 之前的 delta samples；没有任何关键帧时整体保留一个 batch，避免制造无法解码的附加片段。
- mp4/__tests__/remuxer.test.js：更新边界归属断言，新增长 GOP、开头 delta、整条流无关键帧的回归。
- mp4/__tests__/artifacts-edge.test.js：替换原 3× 无关键帧硬切预期，改测无随机访问信息时保持完整。

### 验证
- 定向 remux / remuxer-gaps / muxer-roundtrip / artifacts-edge 测试：38/38 通过。
- npm run check：fixtures 通过；全量测试 3189/3189；lint 通过（548 个 JS 文件）；check 结论全部通过。
- 真实浏览器：Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；视频解码、时间推进、seek、buffered 和 destroy 全部通过。
- E2E 截图已还原；git diff --check 通过。

### 提交和推送
- 修复和进度记录完成后独立提交并推送当前分支 maintenance/round-6。

### 风险
- 超长 GOP 现在会增大单个输出段以保持随机访问边界；无关键帧 metadata 时批次可能超过 targetDurationUs，但不再凭空在依赖帧处断开。无公共 API 更改。

## Attempt 60：拒绝 fMP4 remux 无法表达的 DTS 间隙

### 发现
- 复现条件：向 createMediaSegment 提供同轨样本，其后样本 DTS 与前样本 DTS + duration 不连续（间隙或重叠）。
- 根因：一个 trun 只通过首样本 tfdt、每样本 duration 隐式表示连续 decode timeline；旧 remuxer 各自写 sample DTS 计算仅用于 CTS，却不校验相邻关系，因此接受并静默压缩了输入 gap/overlap。另有非整数、不安全或超出 BMFF 字段范围的时间数据可被转换/写 box 时截断。
- 用户影响：段的 decode timing 与输入 Sample 不一致，视频画面或 A/V 同步发生偏移；畸形时间字段可能产生损坏的 media segment。

### 修改
- mp4/src/remuxer.js：构建及推进序号前，要求 timescale 为正 32-bit 整数，PTS/DTS/duration 为安全整数微秒，DTS ticks 非负，duration ticks 可由 trun 32-bit 表示，CTS 位于 trun signed 32-bit 范围。
- mp4/src/remuxer.js：在 track timescale tick 域检查 DTS == previous DTS + previous duration；拒绝 discontinuity 和 overlap，不再静默合并。
- mp4/__tests__/remuxer.test.js：新增 DTS gap/overlap 拒绝、时间字段溢出及 fractional timestamp 拒绝，并断言无效样本不会推进序号。

### 验证
- 定向 remux / remuxer-gaps / muxer-roundtrip / artifacts-edge：40/40 通过。
- 60 轮里程碑全量 npm run check：fixtures 通过；全量测试 3191/3191；lint 通过（548 个 JS 文件）；全流程通过。
- 独立 npm test 复核全量测试 3191/3191 通过；之前一次在临时编辑期间的测试计数为 3175，故再跑完整门禁并确认稳定结果。
- 真实浏览器：Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；双轨解析、真实解码、播放推进、seek 恢复、buffered 与 destroy 均通过。
- 浏览器临时截图已恢复；git diff --check 通过。

### 提交和推送
- 修复和进度记录完成后独立提交并推送当前分支 maintenance/round-6。

### 风险
- createMediaSegment 现在拒绝不连续 DTS 输入；调用方须先将 discontinuous decode epochs 分成分别从合法基准开始的片段，或调整样本时间。该单 trun API 不新增 gap 表示功能。

## Attempt 61：在轨道 timescale 域正确校验 remux DTS 连续性

### 发现
- 复现条件：44.1 kHz timescale 下有连续的 1µs → 11µs decode-time step。两个输入时间分别量化成相邻 ticks，但独立将 11µs duration 四舍五入会得到 0 tick，与 tfdt/trun 所隐式表示的连续时间矛盾。
- 实际媒体表现：Sintel 视频样本间隔交替为 41667/41666µs，而每个 Sample.duration 为 41667µs；音频样本间隔也有 21334µs 和 21333µs。微秒时间戳/时长字段独立四舍五入，不能逐项精确相等。
- 影响：Round 60 的 `previous DTS + duration` 微秒域精确相等检查，错误拒绝有效真实媒体，浏览器 MSE 在构造 segment 时失败。量化前逐 duration 四舍五入还可能漏掉 tick。

### 修改
- mp4/src/remuxer.js：先分别将 Sample 的起始 DTS 和结束 DTS (dts + duration) 转换至轨道 timescale tick 域；在 tick 域验证当前 DTS 等于前一样本的量化结束 DTS。该精度域与最终 tfdt/trun 表示一致，接纳仅因微秒舍入形成的 ±1µs 差。
- mp4/src/remuxer.js：各个 sample duration 由量化后的结束 tick 减开始 tick 计算；保留真实 tick 间隔，避免独立舍入 duration 引入时间线误差。
- mp4/__tests__/remuxer.test.js：新增 44.1 kHz 时间量化边界回归，读取 `trun` 并验证样本 duration 字段。

### 验证
- 定向 remux / remuxer-gaps / muxer-roundtrip / artifacts-edge：41/41 通过。
- npm run check：fixtures 通过；全量测试 3192/3192；lint 548 个 JS 文件通过；全门禁通过。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4：首轮暴露视频 DTS舍入差，按轨道 ticks 修正后重新验证 19/19；真实解码、播放推进、seek、stall 恢复、buffered 与 destroy 全通过。
- E2E 临时截图已恢复；git diff --check 通过。

### 提交和推送
- 修复和进度记录完成后独立提交并推送当前分支 maintenance/round-6。

### 风险
- 对连续 DTS 输入使用量化 DTS 区间得出的 duration；单轨 segment 的 decode timeline 以 timescale tick 为准。真正的 tick 间隙或重叠仍会在 segment 构建前被拒绝。

## Attempt 62：隔离 WebCodecs 音视频轨能力探测错误

### 发现
- 复现条件：含音视频双轨的媒体中，VideoDecoder.isConfigSupported 或 AudioDecoder.isConfigSupported 单独一个抛异常。
- 根因：supported() 将两个异步探测放进单一 try/catch；首个探测异常会直接返回双轨 unsupported，连尚未探测或另一轨本可成功的 decoder 都被判为失败。先探测到的轨配置也可能残留为不可用状态。
- 影响：浏览器仅支持音频或仅支持视频时，单轨 WebCodecs 异常阻断可解轨道，造成不必要的 MSE/播放路线降级或完全无法播放。

### 修改
- mp4/src/webcodecs-pipeline.js：视频/音频配置探测分别捕获异常，单轨 unsupported 时清理其配置并记录轨道级错误；另一轨探测照常完成，支持任一轨时继续启动对应 decoder/pump。仅两轨均不可用时报告失败原因。
- mp4/__tests__/webcodecs-pipeline.test.js：新增视频探测异常但音频保留，以及音频异常但视频保留的双向断言，同时检查成功轨配置缓存、失败轨配置清理。
- 测试 fake decoder 的异常状态拆分为视频/音频各自独立，避免共享 static 继承导致假阳性/假阴性。

### 验证
- WebCodecs pipeline + gaps 定向测试：13/13 通过。
- npm run check：fixtures 通过；全量测试 3192/3192；lint 548 个 JS 文件通过；全门禁通过。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；MSE 初始化、视频解码、播放/seek、stall 恢复、buffered 与 destroy 均通过。
- E2E 临时截图已恢复；git diff --check 通过。

### 提交和推送
- 修复和进度记录完成后独立提交并推送当前分支 maintenance/round-6。

### 风险
- 支持结果保持现有 any-track 成功策略；如果单轨不支持，仍跳过该轨 decoder/pump，不为单轨保留失败配置。无公共 API 更改。

## Attempt 63：避免 WebCodecs supported() 将不存在轨道标记为可用

### 发现
- 复现条件：只有音频轨或只有视频轨的媒体，其实际轨道 decoder 探测返回 unsupported；以及媒体没有 WebCodecs 音/视频轨道。
- 根因：上轮为保证只含视频/音频文件的另一轨不阻断可解轨，把不存在的轨道支持状态初始化成 true。aggregation 用 OR 判总支持，于是缺失轨本身就能让 `supported: true`，即使文件中唯一存在的轨道不支持；无 A/V 轨时也被错误报告为可支持。
- 用户影响：单轨不支持的文件会误通过 supported()；start 后没有可运行 decoder/pump，能力查询与实际播放不一致。

### 修改
- mp4/src/webcodecs-pipeline.js：video/audio capability 默认均为 false；只有实际存在轨的 config probe 返回 true 才能置为 true。缺轨不会阻断另一轨，也不能伪造成功；无可用轨返回 unsupported。
- mp4/__tests__/webcodecs-pipeline.test.js：增加 audio-only codec unsupported、video-only codec unsupported、无媒体轨道三种用例，要求 flags 全 false / overall unsupported。

### 验证
- WebCodecs pipeline + gaps 定向测试：14/14 通过。
- npm run check：fixtures 通过；全量测试 3193/3193；lint 548 个 JS 文件通过；全门禁通过。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；轨道解析、真实解码、播放/seek、stall 恢复、buffered 及销毁均通过。
- E2E 临时截图已恢复；git diff --check 通过。

### 提交和推送
- 修复和进度记录完成后独立提交并推送当前分支 maintenance/round-6。

### 风险
- 无 A/V 轨道的输入明确返回 unsupported，不会再被标记为可启动 WebCodecs 管线。无公共 API 结构变化。

## Attempt 64：按轨道检查 WebCodecs API 并修复 CMAF 音频 chunk 类型

### 发现
- 复现条件：只有 AudioDecoder + EncodedAudioChunk、但没有 VideoDecoder 的音频媒体；只有视频 API、但没有音频 API 的视频媒体；或音频 decoder 收到 EncodedVideoChunk 的 CMAF 输入。
- 根因 1：MP4 pipeline 构造时调用 hasWebCodecs()，其“完整套装”门槛同时要求 VideoDecoder + AudioDecoder，却漏查 EncodedAudioChunk；纯音频路线因缺无关视频 API 被拒，也可能因缺音频 chunk 构造器误判支持。Player 的 track-aware guard 存在相同缺 EncodedAudioChunk 问题。
- 根因 2：core 深能力探测及 canDecodeVideo/canDecodeAudio 共用 hasWebCodecs()，单类 API 会抑制两种 codec 探测，audio-only/video-only 设备也就无法被 chooseRoute 选中 WebCodecs。CMAF appendChunk 更直接把两类 decoder 的输入都包装成 EncodedVideoChunk。
- 用户影响：部分浏览器/平台上的单轨解码路线降级或失败；CMAF 纯音频 decode 将以错误 chunk 构造器报错。

### 修改
- core/src/capabilities.js：独立检查 VideoDecoder + EncodedVideoChunk 和 AudioDecoder + EncodedAudioChunk；保留完整套装 hasWebCodecs 的含义，但 video/audio 深探测各检查本族 API；webcodecs.available 对应至少一个完整族。
- core/src/player.js：默认 WebCodecs pipeline factory 按媒体实际轨道检查对应 decoder 和 Encoded*Chunk API。
- mp4/src/webcodecs-pipeline.js：不在构造时一刀切拒绝；supported() 按实际轨道族检查 decoder/chunk，并仅探测该 codec。
- cmaf/src/webcodecs.js：按 decoder 轨道族分别创建 EncodedVideoChunk 或 EncodedAudioChunk。
- core/__tests__、mp4/__tests__：覆盖 audio-only / video-only decoder 配置、缺 audio chunk API、全套 API，以及无 WebCodecs unsupported 路径。
- cmaf/__tests__/cmaf-webcodecs-env.test.js：补测双轨 init 缺少其中一个 API 家族时，在创建任何 decoder 之前原子拒绝。
- cmaf/__tests__/cmaf-webcodecs-env.test.js：fake 增加 EncodedAudioChunk，回归断言音频 decoder 收到正确类型。

### 验证
- 定向 core capabilities / player defaults / MP4 pipeline / CMAF fake 浏览器测试：87/87 通过。
- npm run check：fixtures 通过；全量测试 3197/3197；lint 548 个 JS 文件通过；全门禁通过（最终完整运行 exit code 0）。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；MSE 初始化、真实视频解码、播放推进、seek、stall 恢复、buffered 与 destroy 均通过。
- E2E 临时截图已恢复；git diff --check 通过。

### 提交和推送
- 修复和进度记录完成后独立提交并推送当前分支 maintenance/round-6。

### 风险
- hasWebCodecs() 继续代表“全套音视频 API 齐全”；单轨探测则按对应完整 API 族进行。

## Attempt 65：CMAF 解码按 init 中的 tkhd.track_ID 精确路由

### 发现
- 复现条件：视频轨 ID 不为 1、音频轨 ID 不为 2，或片段中包含 init 未声明的未知轨道。
- 根因：CmafWebCodecsPlayer.appendChunk() 将 trackId===1 硬编码为视频，并把所有其余轨道回退给音频解码器；其行为忽略了 init 的 trak/tkhd 映射，导致合法非默认 track_ID 送入错误 decoder，未知 ID 也可能被误解码。
- 用户影响：使用非 1/2 轨道编号的 CMAF 内容会丢帧、错音或在 WebCodecs decoder 抛错；未知轨道无法安全跳过。

### 修改
- cmaf/src/chunk-parser.js：按 moov/trak/hdlr 关联媒体族，从同一 trak 的 tkhd 解析 v0/v1 track_ID，并与 timescale 一起返回；保留 findTimescales() 的原有结果形状。
- cmaf/src/webcodecs.js：decoder track 元数据保留轨 ID；open() 对缺失/无效 ID 提前拒绝；appendChunk() 精确匹配视频/音频 ID，忽略未配置 ID，close() 清除关联 ID。
- cmaf/__tests__：覆盖 tkhd ID 提取、纯音频/视频与任意非 1/2 双轨路由、错误 ID 不误投、正确 Encoded*Chunk 类型。

### 验证
- 定向 CMAF init / WebCodecs / parse / fragment 测试：42/42 通过。
- 真实 Chromium MSE sintel-trailer.mp4 验收：19/19 通过；包括真实解码、播放、seek、stall 恢复与 destroy。
- npm run check：fixtures 通过；全量测试 3198/3198；lint 548 个 JS 文件通过；完整门禁通过（exit code 0）。

### 提交和推送
- 全量门禁完成后独立提交并推送当前分支 maintenance/round-6。

### 风险
- CMAF init 路由元数据目前对每种已支持族视频、音频各保留一条配置轨；其他 ID 被有意跳过，而不是猜测 decoder 类型。

## Attempt 66：CMAF 双轨 decoder 配置改为原子预检与安全替换

### 发现
- 复现条件：双轨 init 的视频 codec 可解，但音频 codec 不受支持；或音频 decoder.configure() 在视频 decoder 已创建后失败。
- 根因：CmafWebCodecsPlayer.open() 只调用 VideoDecoder.isConfigSupported()，未预检音频配置；且视频 decoder 会在继续建立音频前直接赋给 player。因此音频拒绝/构建失败时可留下半初始化的双轨状态。重复 open 也在新配置尚未全部成功时覆盖 decoder 和 track metadata。
- 用户影响：AAC 配置不支持时留下可见但不可完整播放的 video decoder；音频配置中途失败泄漏视频 decoder；重载媒体时旧/新轨道状态可能不一致。

### 修改
- cmaf/src/webcodecs.js：先按轨道 API 家族检查并依次 probe 所有真实 video/audio configs；全部支持后才创建/configure 临时 decoder pair，成功后才 flush/close 旧 pair 并整体交换 references/track IDs；创建或 configure 失败时关闭所有临时 decoder。
- cmaf/__tests__/cmaf-webcodecs-env.test.js：新增音频 config 不支持时零 decoder 创建、音频 configure throw 时临时 decoder 全部回收、成功重开替换旧轨以及替换预检失败保留旧 decoder。

### 验证
- 定向 CMAF WebCodecs / init / parse 测试：46/46 通过。
- 全量 npm run check：fixtures 通过；3202/3202 tests 通过；lint 548 个 JS 文件通过；完整门禁 exit code 0。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；MSE 初始化、真实解码、播放/seek、stall 恢复和 teardown 均通过；截图已恢复。

### 提交和推送
- 完成全量门禁和浏览器验收后，独立提交并推送 maintenance/round-6。

### 风险
- CMAF open() 的多个同时并发调用仍未串行化；当前修改保障单次调用的预检与 decoder pair 安全替换。

## Attempt 67：串行化 CMAF open/close 生命周期操作

### 发现
- 复现条件：第一次 open() 的 isConfigSupported() 尚未返回时，再调用第二次 open() 或 close()。
- 根因：虽然单次 open() 已做到 codec 预检、临时 decoder 配置和整体替换，但其异步操作可并发交错。较慢的旧 open 可能晚于新 open 提交并覆盖后者；close 与尚未完成的 open 也可能先清状态、再被迟到 open 重新挂上 decoder。
- 用户影响：迅速切换 CMAF init 或销毁时，可能播放旧媒体轨、覆盖新 decoder，或在 close 返回后复活资源。

### 修改
- cmaf/src/webcodecs.js：实例级生命周期 Promise 队列按 open()/close() 调用顺序串行执行；将 decoder 初始化拆成 queued public open() 与 internal _open()，成功替换时调用不入队的 _closeNow()，避免队列自锁；拒绝的 operation 不污染队列。
- cmaf/__tests__/cmaf-webcodecs-env.test.js：加入可控延迟 probe，覆盖慢 open + 新 open、慢 open + close 的最终顺序；覆盖 open 失败后队列仍可恢复。

### 验证
- 定向 CMAF WebCodecs / init / parse：43/43 通过。
- npm run check：fixtures 通过；全量测试 3204/3204；lint 548 个 JS 文件通过；完整门禁 exit code 0。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；真实 decode、play、seek、stall recovery 与 destroy 均通过；E2E 截图已恢复。

### 提交和推送
- 验证完成后独立提交并推送 maintenance/round-6。

### 风险
- 队列约束同一 player 实例上的生命周期顺序；不同实例之间无共享队列。

## Attempt 68：CMAF flush 拒绝时继续关闭所有 decoder

### 发现
- 复现条件：双轨 close() 中 VideoDecoder.flush() 或 close() 抛错/拒绝。
- 根因：_closeNow() 之前顺序 await video flush→close→audio flush→close；任何 video 操作异常都会直接跳至 finally，清空 player 引用却没有实际 flush/close 音频 decoder，且失败轨也可能保持打开。
- 用户影响：一次 flush 错误会泄漏另一条 decoder 的内部队列/资源，close() 表面释放了引用却不能保证底层解码器已关闭。

### 修改
- cmaf/src/webcodecs.js：逐 decoder 独立 try/catch flush 和 close；记录并最终抛出首个错误，但仍处理另一个 decoder；finally 一定清空 decoder 与 track ID。
- cmaf/__tests__/cmaf-webcodecs-env.test.js：复现 video flush 拒绝和 video close 抛错，断言 video/audio 均尽力 close、引用被清空、首错被报告，且 lifecycle 队列在失败后可继续使用。

### 验证
- 定向 CMAF WebCodecs / init / parse：45/45 通过。
- 全量 npm run check：fixtures 通过；全量测试 3204/3204；lint 548 个 JS 文件通过；完整门禁 exit code 0。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；真实 decode、play、seek、stall recovery 与 destroy 均通过；E2E 截图已恢复。

### 提交和推送
- 验证完毕后独立提交并推送 maintenance/round-6。

### 风险
- 底层 decoder.close() 自身若抛错，逻辑会继续清理另一个 decoder；该 decoder 内部是否可回收仍由浏览器实现决定。

## Attempt 69：close() 请求时立即停止接受 CMAF chunk

### 发现
- 复现条件：视频 decoder.flush() 保持 pending 时调用 close()，在 flush 尚未 resolve 时继续调用 appendChunk()。
- 根因：close() 只将异步 _closeNow() 放入生命周期队列，appendChunk() 不在队列中，且原逻辑直到 flush 完成并清引用前仍接受新样本。这些 decode 请求可能落在正在结束的 decoder flush 之后，flush 返回的完成保证因而失效，或触发 closed decoder 错误。
- 用户影响：播放器销毁/切换期间 late chunk 仍进 decoder，可能丢帧、报错或破坏 close 完成语义。

### 修改
- cmaf/src/webcodecs.js：引入同步接受标记与 lifecycle request token；close() 调用时立即关闭 chunk 接受门，appendChunk() 对关闭窗口输入无操作；queued open 仅在仍是最新生命周期请求时才能重新打开接受门。
- cmaf/__tests__/cmaf-webcodecs-env.test.js：以可控 pending flush 复现关闭窗口，在 close() 后立即 append，确认新 chunk 未 decode，flush 完成后 decoder 已释放。

### 验证
- 定向 CMAF WebCodecs / init / parse：47/47 通过（包含 queued open + close 请求 token race）。
- npm run check：fixtures 通过；全量测试 3208/3208；lint 548 个 JS 文件通过；完整门禁 exit code 0（本轮为第 20 轮阶段性全量验证）。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；真实 decode/play/seek/stall recovery/destroy 均通过；截图已恢复。

### 提交和推送
- 验证完成后独立提交并推送 maintenance/round-6。

### 风险
- close 请求一旦发出，新 chunk 会立即被丢弃；这是保证已开始的 decoder flush 不被新输入穿插的确定语义。

## Attempt 70：CMAF 样本范围必须完全位于 mdat payload 内

### 发现
- 复现条件：构造一个 trun data_offset 指向 mdat 之后的 free box，同时文件总缓冲仍有足够字节容纳声明样本。
- 根因：materializeSamples() 仅验证 dataStart + sample.size 不超过整个 Uint8Array 长度，没有限制到所选 mdat 的 payload end，也没有验证样本起点不早于 payload start。
- 用户影响：畸形 fragment 可将 box header/其他 box 内容误当压缩样本喂给 decoder，造成解码错误、垃圾输出或错误解析接受。

### 修改
- cmaf/src/chunk-parser.js：同时捕获 mdat payload start/end，并要求每个样本范围完整包含在 mdat payload 内；保留针对整个 buffer 的安全整数/越界拒绝。
- cmaf/__tests__/cmaf-fragment.test.js：新增 mdat 后附 free box 的畸形 fragment，令 trun 指向 mdat 外但仍在 buffer 内，断言以 NOT_SUPPORTED 拒绝。
- 更新 cmaf/__tests__/cmaf-moof-flags.test.js 与 cmaf/__tests__/cmaf-defect-regression.test.js 的合成片段偏移，使合法测试数据实际指向 mdat payload。

### 验证
- 定向 fragment/moof flags/defect-regression：28/28 通过。
- 全 CMAF 测试：123/123 通过。
- 全量 npm run check：fixtures 通过；3209/3209 tests；lint 548 个 JS 文件通过；完整门禁 exit code 0。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19，包含真实解码、播放、seek、stall recovery 和 destroy；截图已恢复。

### 提交和推送
- 验证完成后独立提交并推送 maintenance/round-6。

### 风险
- 每个 traf 当前仍按其 trun offset 连续解释样本，尚未验证样本区间与同一 chunk 其他 traf 的重叠关系。

## Attempt 71：将 CMAF decode timestamps 转为 presentation timestamps

### 发现
- 复现条件：视频 fragment 含 B 帧，trun 中 CTS 为正/负，样本按 DTS 顺序提交 decoder。
- 根因：CmafWebCodecsPlayer.appendChunk() 将 EncodedVideoChunk.timestamp 直接设为 dtsOffset。CMAF trun 同时提供 composition offset；WebCodecs chunk timestamp 应代表呈现时间，等于 DTS + CTS。忽略 CTS 会让重排帧显示在错误时间。
- 用户影响：带 B-frame reorder 的 CMAF 视频可能错序显示或产生 presentation timeline 不连续；仅全 I/P 帧、CTS=0 的测试无法发现。

### 修改
- cmaf/src/webcodecs.js：对视频和音频样本统一以 dtsOffset + (cts ?? 0) 换算 Encoded*Chunk.timestamp；音频 CTS 正常为 0。
- cmaf/__tests__/cmaf-webcodecs-env.test.js：新增 fragment 含一正一负 CTS 的 regression，验证时间戳映射到预期 PTS（单位 µs）且保留解码提交次序。

### 验证
- CMAF WebCodecs / roundtrip / fragment 定向测试：33/33 通过。
- 全量 npm run check：fixtures 通过；3210/3210 tests；lint 548 个 JS 文件通过；完整门禁 exit code 0。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；真实 decode、play、seek、stall recovery 和 destroy 均通过；截图已恢复。

### 提交和推送
- 完成验证后独立提交并推送 maintenance/round-6。

### 风险
- 当前播放器仍按 fragment 输入顺序接收样本；此修复确保每个 EncodedChunk 的展示时间戳正确，不改变上游的 sample decode order。

## Attempt 72：保留同一 traf 中的多个 trun 样本 run

### 发现
- 复现条件：一个合法 traf 包含多个 trun，例如编码器将同一轨道的一段样本拆为多个连续 run。
- 根因：parseMoof() 遍历 traf 子 box 时反复覆盖 info.trun，只留下最后一条；前序 run 样本静默丢失。即使保留最后一条，chunk-parser 也只物化单个 trun。
- 用户影响：fragment 的一部分样本不会送入 decoder，导致视频/音频片段缺帧或断续；单 trun 的 muxer fixture 未覆盖该常见合法结构。

### 修改
- cmaf/src/isobmff.js：在每个 traf 中累积 truns 数组，保留 trun 兼容 alias。
- cmaf/src/chunk-parser.js：按 run 顺序物化全部样本；同一轨 DTS 在 run 间连续累计，后一 run 无 data_offset 时沿用前一 run 的数据末端；显式 offset 仍以 moof 为基准，所有范围继续受 mdat payload 边界约束。
- cmaf/__tests__/cmaf-moof-flags.test.js：新增两 run 单 traf regression，断言两条 run 的样本、DTS 连续性及数据偏移。

### 验证
- CMAF fragment / moof flags / parse / roundtrip 定向测试：37/37 通过。
- 全量 npm run check：fixtures 通过；3211/3211 tests；lint 548 个 JS 文件通过；完整门禁 exit code 0。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19，真实 decode/play/seek/stall recovery/destroy 均通过；截图已恢复。

### 提交和推送
- 验证完成后独立提交并推送 maintenance/round-6。

### 风险
- 各 run 之间显式 data_offset 被按声明尊重；malformed overlap 仍未做跨 run / 跨 traf 区间重叠检测。

## Attempt 73：显式零值 sample flags 覆盖 tfhd 默认

### 发现
- 复现条件：tfhd default_sample_flags 声明 non-sync，而 trun 的 sample-flags 字段显式为 0。
- 根因：materializeSamples() 使用 `r.flags || defaults.defaultSampleFlags`，将有意义的显式零误认为缺省，导致轨道默认 non-sync 标志覆盖了 run 声明的 flags=0。
- 用户影响：具有默认非关键标志、但 trun 显式覆盖为零的样本被错判为 delta；影响随机访问/关键帧调度。相同 truthy 回落也会混淆显式零 duration/size 与字段缺失。

### 修改
- cmaf/src/isobmff.js：parseTrun() 返回 `hasDuration/hasSize/hasFlags/hasCts` 字段存在性元数据。
- cmaf/src/chunk-parser.js：根据 trun 字段标志决定是否回落 tfhd 默认，而非以数值 truthiness 判断；first_sample_flags 继续仅应用首样本。
- cmaf/__tests__/cmaf-moof-flags.test.js：加入显式 `flags=0` 覆盖 non-sync track default 的 regression；将旧的“同一 trun 部分样本字段省略”fixture 改为规范结构中的两个 trun。

### 验证
- CMAF moof flags / fragment / defect regression / parse / WebCodecs：64/64 通过。
- 全量 npm run check：fixtures 通过；3212/3212 tests；lint 548 个 JS 文件通过；完整门禁 exit code 0。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；真实解码、播放/seek、stall recovery 与 destroy 均通过；截图已恢复。

### 提交和推送
- 验证后独立提交并推送 maintenance/round-6。

### 风险
- 正确区分字段缺失与显式零依赖 parseTrun 返回的 has* 标志；外部调用方直接消费解析对象时新增属性是兼容性扩展。

## Attempt 74：拒绝同一 traf 内重叠或倒退的样本 run

### 发现
- 复现条件：同一 traf 的两个 trun 都显式指定 data_offset，第二个 offset 指回第一 run 已消费的 mdat 字节范围。
- 根因：虽已验证每个样本独立落在 mdat payload 内，但没有比较不同 run 的数据区间。两个 run 因而可以重复引用同一批压缩字节，形成伪造/重复样本表。
- 用户影响：同一输入字节可能被多次送进 decoder，造成视频重复帧、时间轴错位，或令攻击者构造高开销解析路径。

### 修改
- cmaf/src/chunk-parser.js：在单 traf 内追踪上一 run 消耗的末端；任何后续显式 data_offset 回退到该末端之前即以 NOT_SUPPORTED 拒绝。相邻连续 run（无 data_offset）仍由前 run 末端开始。
- cmaf/__tests__/cmaf-moof-flags.test.js：增加两个 trun 重复 data_offset 的拒绝用例；保留原合法连续 run 样本、DTS 与数据相邻断言。

### 验证
- CMAF moof flags / fragment / defect regression / roundtrip 定向测试：36/36 通过。
- 全量 npm run check：fixtures 通过；3213/3213 tests；lint 548 个 JS 文件通过；完整门禁 exit code 0。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；真实解码、播放/seek、stall recovery 与 destroy 均通过；截图已恢复。

### 提交和推送
- 完成验证后独立提交并推送 maintenance/round-6。

### 风险
- 本轮覆盖同一 traf 相邻 runs；跨不同 traf 的数据区间重叠仍未建立全 moof 级共享区间账本。

## Attempt 75：拒绝不同 traf 之间的样本数据重叠

### 发现
- 复现条件：moof 含视频和音频两个 traf，但两者 trun data_offset 均指向 mdat 中同一段压缩字节。
- 根因：先前只在每个 traf 内验证 trun runs 的数据区间，未比较同一 moof 中不同轨道的样本范围；同一 mdat 区间可被跨轨重复消费。
- 用户影响：错误 fragment 会把视频 payload 同时作为音频（或反之）解码，带来损坏媒体、时间轴错误和不必要的解码开销。

### 修改
- cmaf/src/chunk-parser.js：每个 moof 收集所有 traf 样本的半开区间，排序后线性扫描，发现跨 traf 重叠即以 NOT_SUPPORTED 拒绝；算法 O(n log n)，避免逐样本两两比较。
- cmaf/__tests__/cmaf-moof-flags.test.js：将合法双轨用例布局为互不重叠的 mdat 区域；新增双 traf 共用同一 data_offset 的畸形拒绝回归。

### 验证
- CMAF moof flags / fragment / defect regression / roundtrip 定向测试：37/37 通过。
- 全量 npm run check：fixtures 通过；3214/3214 tests；lint 548 个 JS 文件通过；完整门禁 exit code 0。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；真实解码、播放/seek、stall recovery 与 destroy 均通过；截图已恢复。

### 提交和推送
- 完成验证后独立提交并推送 maintenance/round-6。

### 风险
- mdat 中未被任何 sample 引用的 padding/其他合法 payload 仍允许存在；当前只保证样本区间彼此不重叠。

## Attempt 76：拒绝 trun 中被静默截断的样本计数

### 发现
- 复现条件：trun.sample_count 大于框体中完整可读的 per-sample 行数，或无行字段时 sample_count 超过安全上限。
- 根因：parseTrun() 先前将声明计数钳到可读行数/默认上限并正常返回；截断 fragment 会被当作合法的部分样本表继续处理，丢弃尾部样本而不报错。
- 用户影响：媒体时间轴可能仍显示片段有效，但样本内容缺失，导致音视频不完整或 seek/同步行为异常；超大计数也掩盖 malformed input。

### 修改
- cmaf/src/isobmff.js：per-sample 行字段存在时按完整行数与安全上限取最大值，声明 sample_count 超出即 NOT_SUPPORTED；无 per-sample 行字段时仍保留 DEFAULT_MAX_TRUN_SAMPLES 防护并快速拒绝超限。
- cmaf/__tests__/cmaf-defect-regression.test.js：替换“钳制并接受部分结果”的历史用例，覆盖无字段巨量计数快速失败及带字段截断行数拒绝。

### 验证
- CMAF defect regression / box / moof flags / fragment 定向测试：50/50 通过。
- 全量 npm run check：首轮 fixtures 重建期间为 3202/3202；随后独立 npm test 与第二轮完整 npm run check 均稳定 3214/3214；lint 548 个 JS 文件通过，完整门禁 exit code 0。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；真实解码、播放/seek、stall recovery 与 destroy 均通过；截图已恢复。

### 提交和推送
- 完成验证后独立提交并推送 maintenance/round-6。

### 风险
- 无 per-sample 字段时 sample_count 的上限仍按 DEFAULT_MAX_TRUN_SAMPLES；进一步缩紧需评估超大合法 fragment 的兼容性。

## Attempt 78：每个 moof 仅能关联自身后续的 mdat

### 发现
- 复现条件：一个 fragment 的 moof 后面缺失 mdat，后面才出现下一个 moof 和其 mdat；前一 trun 的 data_offset 被恶意设到后一个 mdat。
- 根因：materializeSamples() 从当前 moof 末尾迭代到整个输入末尾，找到第一个 mdat 时没有遇到下一个 moof 就停止的边界检查，因此前一 fragment 可越过后一 fragment 并借用其 payload。
- 用户影响：解析器接受结构不完整的早期 fragment，并把后续片段的数据误路由至错误轨道/时间段，可能造成损坏解码。

### 修改
- cmaf/src/chunk-parser.js：查找关联 mdat 时遇到下一个 moof 即停止；若本 fragment 的 moof 后无 mdat，沿用 NOT_SUPPORTED 错误拒绝。
- cmaf/__tests__/cmaf-fragment.test.js：新增两个连续 moof 但只有第二个后有 mdat 的输入，并将第一个 trun offset 特意指向第二 fragment payload，断言拒绝。

### 验证
- CMAF fragment / moof flags / roundtrip 定向测试：31/31 通过。
- CMAF 定向测试：31/31 通过。
- 阶段性全量 npm run check：fixtures 通过；3217/3217 tests；lint 548 个 JS 文件通过；完整门禁 exit code 0。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；真实解码、播放/seek、stall recovery 与 destroy 均通过；截图已恢复。

### 提交和推送
- 完成验证后独立提交并推送 maintenance/round-6。

### 风险
- 允许 moof 与其 mdat 之间出现其他 box；关联边界只禁止跨越下一个 moof。

## Attempt 77：拒绝不精确的 CMAF 64 位解码时间

### 发现
- 复现条件：tfdt version 1 的 baseMediaDecodeTime 大于 Number.MAX_SAFE_INTEGER；或样本 duration 累加使 DTS 越过该范围。
- 根因：parseTfdt() 将 uint64 BigInt 直接转 Number，超过安全整数后低位静默丢失；materializeSamples() 也未验证 DTS/PTS 累加是否仍精确。
- 用户影响：EncodedChunk 时间戳被舍入到错误 tick，可能造成严重时间轴偏移、呈现时序错误或跨样本时间戳重复。

### 修改
- cmaf/src/isobmff.js：tfdt v1 在 BigInt 转 Number 前验证不超过 MAX_SAFE_INTEGER，超出则 NOT_SUPPORTED。
- cmaf/src/chunk-parser.js：每个样本提交前验证 DTS 与 DTS+CTS (PTS) 为安全整数，并在累计 duration 后重新检查 DTS。
- cmaf/__tests__/cmaf-moof-flags.test.js：新增不安全 tfdt uint64 与安全范围末端 DTS 累计溢出拒绝测试，原有跨 2^32 有效时间测试继续保留。

### 验证
- CMAF box / moof flags / fragment / roundtrip 定向测试：48/48 通过。
- 全量 npm run check：fixtures 通过；3216/3216 tests；lint 548 个 JS 文件通过；完整门禁 exit code 0。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；真实解码、播放/seek、stall recovery 与 destroy 均通过；截图已恢复。

### 提交和推送
- 验证完成后独立提交并推送 maintenance/round-6。

### 风险
- 极长/异常媒体若合法 tick 时间超过 Number 安全整数范围将拒绝；支持该量级需要端到端 BigInt→时间基换算契约，而不仅是本解析器局部变更。

## Attempt 79：tfhd optional fields 不得越过 box 边界读取

### 发现
- 复现条件：tfhd 声明 base_data_offset 或 default 字段，但自身 box 在字段中途结束，后续相邻 box 恰好仍有足够字节。
- 根因：parseTfhd() 虽接收 contentEnd，却只按整个输入 Uint8Array 建立 DataView 并读取可选字段；截断时可能把 sibling box header/body 当作当前字段，静默误解析。
- 用户影响：恶意碎片可以跨 box 边界伪造 track defaults/offset，造成错误样本寻址，或导致裸 RangeError 代替稳定解析错误。

### 修改
- cmaf/src/isobmff.js：先验证 tfhd fullbox header 与 track_ID 完整存在；每个可选字段读取前根据 contentEnd 校验字节数；base_data_offset 另拒绝超过 Number.MAX_SAFE_INTEGER 的 uint64。
- cmaf/__tests__/cmaf-moof-flags.test.js：新增 track_ID 截断、base_data_offset 截断、base_data_offset 精度溢出拒绝覆盖。

### 验证
- CMAF moof flags / fragment / defect regression / box 定向测试：56/56 通过。
- CMAF 定向测试：56/56 通过。
- 阶段性全量 npm run check：fixtures 通过；3220/3220 tests；lint 548 个 JS 文件通过；完整门禁 exit code 0。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；真实解码、播放/seek、stall recovery 与 destroy 均通过；截图已恢复。

### 提交和推送
- 完成验证后独立提交并推送 maintenance/round-6。

### 风险
- 当前仅处理 parseTfhd 被上层限定为 tfhd box 的调用契约；类似边界检查需继续审查其他 full-box parsers。

## Attempt 80：trun 各字段读取严格限定于 box contentEnd

### 发现
- 复现条件：trun 在 data_offset、first_sample_flags 或 per-sample row 中途截断，但整个缓冲区后续 box 字节仍可被 DataView 读取。
- 根因：parseTrun() 使用 buffer 全局边界而非传入的 contentEnd 保护 optional header/行读取；仅在计算可容纳样本数时检查 contentEnd，前面的可选字段仍可能从下一个 box 借字节。
- 用户影响：畸形 trun 可跨 box 读取 sibling 内容，伪造 data offset / sample flags，或让解析行为偏离稳定 NOT_SUPPORTED 错误契约。

### 修改
- cmaf/src/isobmff.js：parseTrun() 为 fullbox header、sample_count、data_offset、first_sample_flags 加显式 contentEnd 检查；per-sample rows 由完整行计数预检后读取。
- cmaf/__tests__/cmaf-moof-flags.test.js：添加 trun data_offset 截断、first_sample_flags 截断和样本行截断测试（缓冲中仍有尾部字节，确保不会越界借读）。

### 验证
- CMAF moof flags / box / defect regression / fragment 定向测试：57/57 通过。
- 全量 npm run check：fixtures 通过；3221/3221 tests；lint 548 个 JS 文件通过；完整门禁 exit code 0。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；真实解码、播放/seek、stall recovery 与 destroy 均通过；截图已恢复。

### 提交和推送
- 完成验证后独立提交并推送 maintenance/round-6。

### 风险
- parseTrun 完整性依赖上层向它传入实际 trun contentEnd；非法调用者传入过大的 end 不在此函数的当前职责范围。

## Attempt 81：tfdt 与 mfhd 按 box contentEnd 校验并拒绝未知版本

### 发现
- 复现条件：tfdt v0/v1 的 fullbox/body 截断于自身 box，但缓冲后方仍有其他 box 字节；或 tfdt/mfhd 使用当前解析器未定义的 version。
- 根因：parseTfdt() 与 parseMfhd() 直接用整个 Uint8Array 的 DataView 读取字段，未接收或验证当前 box 的 contentEnd；版本校验仅在 tfdt v1 判断，其他值被当作 v0。
- 用户影响：恶意 box 可跨边界读取邻接内容，或让未知二进制布局被静默解释为旧版本时间戳/sequence。

### 修改
- cmaf/src/isobmff.js：parseTfdt() 增加 contentEnd 参数、header/body 完整性检查及仅接受 version 0/1；parseMfhd() 增加 contentEnd 检查并仅接受 version 0；parseMoof() 传递 tfdt box 边界。
- cmaf/__tests__/cmaf-box.test.js：新增 tfdt 截断/未知版本、mfhd sequence 截断/未知版本拒绝用例；既有 v0/v1 合法时钟测试保留。

### 验证
- CMAF box / moof flags / fragment / defect regression 定向测试：59/59 通过。
- 定向测试：59/59 通过。
- 全量 npm run check：fixtures 通过；3221/3221 tests；lint 548 个 JS 文件通过；完整门禁 exit code 0。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；真实解码、播放/seek、stall recovery 与 destroy 均通过；截图已恢复。

### 提交和推送
- 完成验证后独立提交并推送 maintenance/round-6。

### 风险
- parseTfdt() 对外直接调用时默认 contentEnd 为整个缓冲区；parseMoof() 生产路径显式传入实际 tfdt contentEnd。

## Attempt 82：严格校验 sidx 版本、表长度与 64 位索引精度

### 发现
- 复现条件：sidx 的 reference_count 指向不完整 reference table、timescale 为零、version 未知，或 version 1 的 uint64 时间/first_offset 超过 JavaScript 安全整数。
- 根因：parseSidx() 在 references 循环只读到可用行数后静默返回部分索引；固定头字段可能跨 contentEnd 读取；任何非 1 版本被按 v0 读取，且 uint64 转 Number 不验证精度。
- 用户影响：分段索引被部分接受或时间/偏移静默舍入，可能造成错误 segment seek、范围请求落错位置或隐蔽索引损坏。

### 修改
- cmaf/src/isobmff.js：parseSidx() 验证传入边界、fullbox/固定头/reference_count/全部声明 references；仅接受 v0/v1、timescale 必须非零，version 1 时间和偏移必须为安全整数。
- cmaf/__tests__/sidx.test.js：新增截断 references、未知版本、零 timescale、不安全 uint64 拒绝回归；原有 v0/v1 合法索引测试保持通过。

### 验证
- sidx / box / parse / fragment CMAF 定向测试：46/46 通过。
- 全量 npm run check：fixtures 通过；3225/3225 tests；lint 548 个 JS 文件通过；完整门禁 exit code 0。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；真实解码、播放/seek、stall recovery 与 destroy 均通过；截图已恢复。

### 提交和推送
- 完成验证后独立提交并推送 maintenance/round-6。

### 风险
- 此轮只校验 sidx 自身表完整性，不验证 reference 计算出的外部 segment 字节范围是否超出源资源；该范围校验位于消费者侧。

## Attempt 83：无损保留 PRFT producer NTP 并校验 media_time 精度

### 发现
- 复现条件：PRFT version 1 常规 producer_time NTP 32.32 固定点本身即常超过 Number.MAX_SAFE_INTEGER；media_time uint64 也可能超出 Number 精度范围。
- 根因：parsePrft() 将 producer_time 和 media_time 都直接 Number(uint64)，使 NTP fractional bits 与大值媒体时间的低位静默丢失。producer_time 是 NTP 固定点，不应套用普通 safe-integer 转换。
- 用户影响：依赖 PRFT 的 A/V 时钟同步、生产者/媒体时间对齐可能出现无法察觉的精度损失。

### 修改
- cmaf/src/isobmff.js：PRFT v1 新增精确 `producerTimeNtp` BigInt 返回字段；旧 `producerTimeTicks` 数值字段保留兼容视图；media_time 继续返回 Number ticks，但超过安全整数时拒绝。
- cmaf/__tests__/sidx.test.js：以超过 2^53 的 NTP fixed-point 证明 BigInt 字段无损；另外验证不安全 media_time 被拒绝。

### 验证
- PRFT / sidx / box 定向测试：28/28 通过。
- 定向 PRFT / sidx / box 测试：28/28 通过。
- 全量 npm run check：fixtures 通过；3226/3226 tests；lint 548 个 JS 文件通过；完整门禁 exit code 0。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；真实解码、播放/seek、stall recovery 与 destroy 均通过；截图已恢复。

### 提交和推送
- 完成验证后独立提交并推送 maintenance/round-6。

### 风险
- v1 的 producerTimeTicks 仍作为旧 API 的近似 Number 兼容视图返回；需要精确值的调用者应改用新增的 producerTimeNtp BigInt。

## Attempt 84：校验 ISO-BMFF box reader 与 iterator 输入范围

### 发现
- 复现条件：readBoxHeader() 收到负数、非整数、NaN、Infinity 等 off；iterateBoxes() 收到负 start、end 小于 start 或 end 超出缓冲。
- 根因：解析器直接对 off 执行 DataView.getUint32()，异常值会泄漏裸 RangeError；iterator 对非法 start/end 未建统一输入契约。
- 用户影响：外部调用者传入异常边界时得到不稳定错误类型，或错误范围扫描导致意外吞掉/越界处理 box。

### 修改
- cmaf/src/isobmff.js：readBoxHeader() 先要求 off 为非负安全整数；缓冲尾部不足仍按流式契约返回 null。iterateBoxes() 校验 `0 <= start <= end <= buf.length` 且边界均为安全整数。
- cmaf/__tests__/cmaf-box.test.js：新增负数/分数/NaN/Infinity header offset，以及 iterator 非法范围拒绝覆盖。

### 验证
- box / fragment / defect regression 定向测试：38/38 通过。
- box / fragment / defect regression 定向测试：38/38 通过。
- 全量 npm run check：fixtures 通过；3228/3228 tests；lint 548 个 JS 文件通过；完整门禁 exit code 0。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；真实解码、播放/seek、stall recovery 与 destroy 均通过；截图已恢复。

### 提交和推送
- 完成验证后独立提交并推送 maintenance/round-6。

### 风险
- 合法但大于缓冲长度的 header offset 保留既有流式行为并返回 null；畸形数值 offset 则稳定抛 NOT_SUPPORTED。

## Attempt 85：init-segment hdlr/mdhd 字段读取限定于子 box 边界

### 发现
- 复现条件：moov/trak/mdia 结构中 hdlr 或 mdhd box 自身被截断，但其后续兄弟 box 在同一 init 缓冲内仍含足够字节。
- 根因：readHandlerType() 与 readMdhdTimescale() 只按整个 init buffer.length 检查，而未以 hdlr/mdhd contentEnd 为字段上限；mdhd 还将任意非 v1 version 当 v0。
- 用户影响：畸形 init 可跨 box 读取相邻数据，误判轨道类型或 timescale，造成解码轨配置错误。

### 修改
- cmaf/src/chunk-parser.js：hdlr handlerType 检查改为 box-local contentEnd；mdhd 验证 fullbox header、版本 0/1 与完整 timescale 字段均在当前 box 内。
- cmaf/__tests__/cmaf-init.test.js：构造 hdlr 仅保留 fullbox+predefined、mdhd 结束于 timescale 之前的 init；确认后续兄弟字节不会被借读，元数据保持未识别。

### 验证
- CMAF init / parse / box 定向测试：49/49 通过。
- CMAF init / parse / box 定向测试：49/49 通过。
- 全量 npm run check：fixtures 通过；3229/3229 tests；lint 548 个 JS 文件通过；完整门禁 exit code 0。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；真实解码、播放/seek、stall recovery 与 destroy 均通过；截图已恢复。

### 提交和推送
- 完成验证后独立提交并推送 maintenance/round-6。

### 风险
- 对不完整 init metadata 仍按现有容错策略跳过单条轨道字段，而不拒绝整个 init；上层会继续使用兼容默认 timescale 或缺省轨道元数据。

## Attempt 86：findAudioSpecificConfig 不得在 moov 外提取伪造 esds

### 发现
- 复现条件：合法视频 init 后追加一个顶层伪造 `esds` box，其中嵌套看似完整的 ES_Descriptor/DecoderConfig/DSI；整个文件扫描会把视频流伪装成带音频 ASC。
- 根因：findAudioSpecificConfig() 从 initSegment 全局搜索第一个 `esds` 标签，不要求其属于 moov/stsd/sample entry 的真实音频配置树。
- 用户影响：伪造字节可注入错误音频 decoder config，使无音频流被误报为音频轨，或引起音频解码失败。

### 修改
- cmaf/src/isobmff.js：init segment 现仅在结构化 `moov` 范围搜索 esds；保留仅传入独立顶层 esds box 的历史 helper 用法。
- cmaf/__tests__/cmaf-box.test.js：新增视频 moov + 顶层有效形状假 esds payload 回归，必须返回 null；合法 standalone 与真实音频 init 覆盖继续通过。

### 验证
- CMAF box / init / parse / extras 定向测试：60/60 通过。
- CMAF box / init / parse / extras 定向测试：60/60 通过。
- 全量 npm run check：fixtures 通过；3230/3230 tests；lint 548 个 JS 文件通过；完整门禁 exit code 0。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；真实解码、播放/seek、stall recovery 与 destroy 均通过；截图已恢复。

### 提交和推送
- 完成验证后独立提交并推送 maintenance/round-6。

### 风险
- moov 内仍使用 bounded fourcc 搜索而非完整 stsd/sample-entry 递归解析；当前范围足以消除跨顶层伪匹配，嵌套结构验证可继续加固。

## Attempt 87：ASC 只能来自 stsd/mp4a/esds 真实 box 层级

### 发现
- 复现条件：视频 `avcC` 配置 payload 内嵌一串字节，内容伪装成完整 `esds` box 与 AAC DSI；虽然位于 moov 内，bounded fourcc 搜索仍会命中并返回 ASC。
- 根因：上一轮仅把 esds 搜索范围收窄到 moov，仍未验证标签处在真实 box 边界，也未确认其父 sample entry 是 mp4a。
- 用户影响：视频配置字节可伪造出音频 ASC，导致错误音频轨识别或 decoder configure 失败。

### 修改
- cmaf/src/isobmff.js：加入结构遍历 moov/trak/mdia/minf/stbl/stsd → mp4a child `esds`；解码描述仅从真实 mp4a sample entry 子盒提取。保留独立顶层 esds helper 输入兼容。
- cmaf/__tests__/cmaf-box.test.js：新增 avcC payload 内完整伪造 esds 结构必须忽略；顶层伪 esds、合法 AAC init、合法 standalone esds 均覆盖。

### 验证
- CMAF box / init / parse / extras 定向测试：61/61 通过。
- CMAF box / init / parse / extras 定向测试：61/61 通过。
- 全量 npm run check：fixtures 通过；3231/3231 tests；lint 548 个 JS 文件通过；完整门禁 exit code 0。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；真实解码、播放/seek、stall recovery 与 destroy 均通过；截图已恢复。

### 提交和推送
- 完成验证后独立提交并推送 maintenance/round-6。

### 风险
- 只解析 stsd 标准 AudioSampleEntry 固定 28-byte 前缀与 mp4a 子盒；受外部扩展的非标准音频 sample entry 保持不识别，而非退回内容字节猜测。

## Attempt 88：VideoDecoderConfig 仅从真实 stsd visual entry 提取

### 发现
- 复现条件：hvcC 配置字节内含看似 box 的 `avc1` 标签/尺寸/`avcC` 子载荷；旧解析器在 moov 全局扫描四字符标签，可把 hvcC payload 伪装成更优先的 avc1 sample entry。
- 根因：findVideoDecoderConfig() 虽检查伪 entry 声明的尺寸，却没有从 stsd entry_count 与实际子盒边界遍历；内部 codec payload 的字节仍可被误认成 entry/config box。
- 用户影响：错误 entryType/description 传给 WebCodecs，可能配置不匹配并拒绝解码，或造成合法视频轨错误路由。

### 修改
- cmaf/src/isobmff.js：结构遍历 moov/trak/mdia/minf/stbl/stsd，遵守 stsd entry_count；只认真实 visual sample entry 的直系配置子盒 avcC/hvcC/dvcC/vpcC。截断/损坏子盒返回 null。
- cmaf/__tests__/cmaf-box.test.js：将含伪 avc1+avcC 完整字节组的 payload 放进 hvcC；必须返回真实 hvc1/hvcC 与原始描述。

### 验证
- CMAF box / init / parse 定向测试：52/52 通过。
- round 90 阶段性全量 npm run check：fixtures 通过；3232/3232 tests；lint 548 个 JS 文件通过；完整门禁 exit code 0。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；真实解码、播放/seek、stall recovery 与 destroy 均通过；截图已恢复。

### 提交和推送
- 完成阶段验证后独立提交并推送 maintenance/round-6。

### 风险
- sample-entry parser 目前基于标准 VisualSampleEntry 78-byte 固定字段；非标准扩展或未知 visual entry 不会通过猜测内部标签恢复配置。

## Attempt 89：移除视频配置扫描法带来的 sample-entry 伪造命中

### 发现
- round 90 修复后进一步发现：前一轮 `findVideoDecoderConfig()` 的实现在源码尚有全局 stsd fourcc 搜索，hvcC payload 可构造完整伪 avc1 + avcC 子结构，且伪尺寸落在 sample-entry 范围内。
- 根因：按标签字节扫描只能过滤跨 moov 的伪造，不能证明 codec type/config tag 真的是 stsd/visual-entry 的真实 box 节点。
- 用户影响：WebCodecs 收到错误 codec entry/config，导致 configure 失败或轨道错误归类。

### 修改
- cmaf/src/isobmff.js：完全改为遍历 moov/trak/mdia/minf/stbl/stsd，按声明 entry_count 解析 sample entries；只从 VisualSampleEntry 的真实直系子盒识别 avcC/hvcC/dvcC/vpcC；校验 child box 列表完整和边界。iterateBoxes() 同时暴露 headerSize，支持规范 box header 信息。
- cmaf/__tests__/cmaf-box.test.js：hvcC payload 内嵌伪造 avc1/avcC；必须仍返回真实 hvc1/hvcC；既有截断配置拒绝用例继续通过。

### 验证
- CMAF box / init / parse 定向测试：52/52 通过。
- 完整 npm run check：fixtures 通过；3232/3232 tests；lint 548 个 JS 文件通过；exit code 0。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；真实 H.264 解码、播放/seek、stall recovery 与 destroy 均通过；截图已恢复。

### 提交和推送
- 此轮是 round 91 对 round 90 同一修复面的直接后续，合并为独立提交推送。

### 风险
- VisualSampleEntry 采用 ISO 固定 78-byte 前缀；尚未支持非标准结构扩展。

## Attempt 90：PRFT/ESDS 迭代器准确暴露 largesize box 起点与头长

### 发现
- 复现条件：顶层 standalone `esds` 使用 size=1/largesize（16-byte box header）；标签扫描推导 boxStart/content offsets 时错误地按 8-byte header 固定回退。
- 根因：iterateBoxes() 虽保留 headerSize，但没暴露 boxStart；audio config 消费者曾对扩展头推导错误起点，descriptor 读取落在 size/type/largesize 字段中而返回 null。
- 用户影响：合法扩展尺寸的 ESDS box 无法提取 ASC，音频轨配置被意外丢弃。

### 修改
- cmaf/src/isobmff.js：iterateBoxes() 输出 `boxStart`；findAudioSpecificConfig() 从真实 contentStart + fullbox header 定位 descriptor，不再依赖固定 8-byte 起点回推；结构 helper 不覆盖真实头长。
- cmaf/__tests__/cmaf-box.test.js：新增 standalone largesize ESDS 盒，声明 16-byte header 并包含合法 AAC 描述，期望提取 `[0x12, 0x10]`。

### 验证
- CMAF box / init 定向测试：41/41 通过。
- CMAF box / init 定向测试：41/41 通过。
- 全量 npm run check：fixtures 通过；3233/3233 tests；lint 548 个 JS 文件通过；完整门禁 exit code 0。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；真实解码、播放/seek、stall recovery 与 destroy 均通过；截图已恢复。

### 提交和推送
- 完成验证后独立提交并推送 maintenance/round-6。

### 风险
- ESDS 保持标准单层 ISO BMFF 盒头；不可表示或不完整 largesize 会由 box iterator 按既有截断行为忽略。

## Attempt 91：仅解析受支持版本的 ESDS FullBox

### 发现
- 复现条件：`esds` box 声明非零 version、保留 flags，或自身 fullbox header 截断，却在后续字节包含看似合法的 descriptor/ASC。
- 根因：ASC helper 直接跳过 4-byte fullbox header，不检查 box 内是否完整，也未验证 ESDS 规范要求的 version=0、flags=0。
- 用户影响：未知/畸形 header 下的任意后续字节可能被误解释为 AAC decoderSpecificInfo。

### 修改
- cmaf/src/isobmff.js：读取 descriptor 前要求 box-local fullbox header 完整，并仅接受 version=0、flags=0。
- cmaf/__tests__/cmaf-box.test.js：新增 truncated fullbox、version 1、nonzero flags 必须返回 null；合法大尺寸 esds 与 AAC ASC 用例仍保留。

### 验证
- CMAF box / init / extras 定向测试：52/52 通过。
- CMAF box / init / extras 定向测试：52/52 通过。
- 全量 npm run check：fixtures 通过；3234/3234 tests；lint 548 个 JS 文件通过；完整门禁 exit code 0。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；真实解码、播放/seek、stall recovery 与 destroy 均通过；截图已恢复。

### 提交和推送
- 完成验证后独立提交并推送 maintenance/round-6。

### 风险
- 非零 flags 或未知 version 按当前受支持范围返回 null；未知未来规范扩展需显式解析后再支持。

## Attempt 92：要求 ESDS 的 ES_Descriptor 精确覆盖完整 payload

### 发现
- 复现条件：合法 `ES_Descriptor` 后拼接额外 byte；ESDS box 长度随之扩大，但内部 descriptor 长度仍保持原值。
- 根因：findAudioSpecificConfig() 成功解析 ES descriptor 及其子树后忽略外层 esds payload 尾随字节，可能接受 framing 不一致的数据。
- 用户影响：畸形/有歧义的 MPEG-4 descriptor box 仍可能产出 decoderSpecificInfo。

### 修改
- cmaf/src/isobmff.js：要求 ES_Descriptor 解析结束偏移严格等于 esds box contentEnd；不再容忍未被 descriptor 长度覆盖的尾随数据。
- cmaf/__tests__/cmaf-box.test.js：保留有效普通/大尺寸 ESDS 测试，新增合法 ASC 后的未声明尾随 byte 必须返回 null。

### 验证
- CMAF box / init / extras 定向测试：53/53 通过。
- CMAF box / init / extras 定向测试：53/53 通过。
- 全量 npm run check：fixtures 通过；3235/3235 tests；lint 548 个 JS 文件通过；完整门禁 exit code 0。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；真实解码、播放/seek、stall recovery 与 destroy 均通过；截图已恢复。

### 提交和推送
- 完成验证后独立提交并推送 maintenance/round-6。

### 风险
- ESDS 内容按单个 ES_Descriptor 精确消费；需要支持非标准尾部扩展时应先引入有明确规格定义的解析规则。

## Attempt 93：按 DecoderConfig descriptor 边界完整校验子项

### 发现
- 复现条件：`DecoderConfigDescriptor` 中含有效 `DecoderSpecificInfo`，其后再添加未声明尾部字节；父 ES_Descriptor 长度同步扩大。
- 根因：audio config parser 命中第一个 DSI 就立即返回，未验证 DecoderConfig descriptor 余下字节是否能解析成完整子 descriptor；可接受内部 framing 不一致的数据。
- 用户影响：畸形 ESDS 可返回看似有效的 AAC ASC，绕开上轮仅校验 ES_Descriptor 外层长度的改进。

### 修改
- cmaf/src/isobmff.js：遍历 DecoderConfig 中所有子 descriptor，只有结构完整后才返回缓存的 DSI；截断或非法尾随子项返回 null。允许完整的合法后续 descriptor。
- cmaf/__tests__/cmaf-box.test.js：新增 DSI 后额外未声明 byte case，并保留普通 AAC descriptor、ESDS 尾随与 largesize 用例。

### 验证
- CMAF box / init / extras 定向测试：54/54 通过。
- 完成后复跑的全量 npm run check：fixtures 通过；3236/3236 tests；lint 548 个 JS 文件通过；完整门禁 exit code 0。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；真实 H.264 解码、播放/seek、stall recovery 与 destroy 均通过；截图已恢复。

### 提交和推送
- 完成验证后独立提交并推送 maintenance/round-6。

### 风险
- DecoderConfig 固定字段仍按标准 13-byte 前缀解析；遇到更短或描述符 framing 损坏时采取拒绝策略。

## Attempt 94：验证 ESDS DecoderConfig 确为 MPEG-4 Audio

### 发现
- 复现条件：`DecoderConfigDescriptor` 使用非 AAC objectTypeIndication（如视觉 codec），或 `streamType` 不是 audio；但其子树仍含结构完整的 tag 0x05 descriptor。
- 根因：ASC 提取器此前只验证 13-byte DecoderConfig 固定字段存在，然后寻找 DSI；它未检查 objectTypeIndication、streamType 与 AudioStream 保留位，可能把非音频 decoder-specific 字节作为 AAC AudioSpecificConfig 返回。
- 用户影响：错误 AAC 配置交给 WebCodecs audio decoder，导致音频轨配置失败或错误处理。

### 修改
- cmaf/src/isobmff.js：要求 objectTypeIndication 为 AAC 的 MPEG-4 Audio OTI（0x40、0x66、0x67、0x68）；streamType 必须为 5 (AudioStream)，AudioStream reserved bit 必须为 1，之后才遍历 DSI。
- cmaf/__tests__/cmaf-box.test.js：新增有效 AAC OTI 正例与非 AAC OTI、非音频 streamType、缺失 reserved bit 三个拒绝用例；同时修正上轮尾随字节回归，把未声明 byte 放在 DecoderConfig 内部的真实边界。

### 验证
- CMAF box / init / extras 定向测试：55/55 通过。
- 全量 npm run check：fixtures 通过；3237/3237 tests；lint 548 个 JS 文件通过；完整门禁 exit code 0。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；真实 H.264 解码、播放/seek、stall recovery 与 destroy 均通过；截图已恢复。

### 提交和推送
- 完成验证后独立提交并推送 maintenance/round-6。

### 风险
- 当前只从 MPEG-4 Audio OTI 中提取 AAC ASC；其他 codec/OTI 必须使用相应专用配置提取逻辑。

## Attempt 95：支持 MPEG-2 AAC LTP 并拒绝未知 trun 版本

### 发现
- AAC 假阴性：本解析器支持 MPEG-2 AAC Main/LC/SSR OTI (0x66–0x68) 以及 MPEG-4 AAC OTI 0x40，却遗漏 MP4RA 注册的 MPEG-2 AAC LTP OTI 0x69；合法 ESDS 里的 ASC 因此被丢弃。注册表：https://mp4ra.org/registered-types/object-types。
- trun 版本误解析：parseTrun() 未限制 ISO BMFF 仅定义的 version 0/1；所有非零值都把 composition_time_offset 解释成有符号值，version 2 输入可制造虚假负 CTS。
- 用户影响：MPEG-2 AAC LTP 轨道无法获得有效解码配置；异常 trun 能污染时间轴/CTS 并令样本错误排序或被解码器拒收。

### 修改
- cmaf/src/isobmff.js：允许注册的 AAC LTP OTI 0x69；parseTrun() 只接受版本 0 或 1，其余返回 NOT_SUPPORTED。
- cmaf/__tests__/cmaf-box.test.js：使用 OTI 0x69 与 AAC-LTP (AOT=4) AudioSpecificConfig 验证 ASC 正确透传；保留非 AAC OTI 和 stream type 拒绝用例。
- cmaf/__tests__/cmaf-moof-flags.test.js：版本 2 的 trun 携带 0x80000000 CTS，必须以 NOT_SUPPORTED 拒绝；既有 v0 unsigned/v1 signed 用例保持。

### 验证
- CMAF box / init / moof-flags / parse 定向测试：82/82 通过。
- round 100 阶段性全量 npm run check：fixtures 通过；3239/3239 tests；lint 548 个 JS 文件通过；完整门禁 exit code 0。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；真实解码、播放/seek、stall recovery 与 destroy 均通过；截图已恢复。

### 提交和推送
- 完成阶段验证后独立提交并推送 maintenance/round-6。

### 风险
- OTI 0x69 的 ASC 只作字节级透传，不在本解析器内解码 MPEG-2 AAC LTP；WebCodecs 实际解码能力由运行时决定。

## Attempt 96：验证 SIDX 保留位并定位 AudioSampleEntry v1 esds

### 发现
- `parseSidx()` 只检查 version，不验证 reserved FullBox flags；最小 v0 SIDX 即使 flags 非零仍会被解析成合法索引，可能让损坏的 segment metadata 静默进入播放器。
- `findMp4aEsds()` 固定假设 AudioSampleEntry v0 的 28-byte body prefix；soundVersion=1 会在其后额外增加 16 bytes，导致合法 AAC `esds` 被漏掉。
- 独立审计还发现 `parseTfhd()` 未拒绝非零 FullBox version；该 box 只定义 version 0。

### 修改
- cmaf/src/isobmff.js：sidx 必须 flags=0；tfhd 必须 version=0；mp4a 根据 soundVersion=0/1 分别跳过标准 28/44-byte 前缀；截断、未知 soundVersion 或超出 entry 的扩展安全拒绝。
- cmaf/__tests__/sidx.test.js：验证零 flags 继续成功，保留 flags 非零抛 NOT_SUPPORTED。
- cmaf/__tests__/cmaf-moof-flags.test.js：新增 version 1 tfhd 拒绝测试，原有 version 0/default 行用例保持。
- cmaf/__tests__/cmaf-box.test.js：在既有音频 init 中扩展 sample entry、更新包裹 box 尺寸并设置 soundVersion=1；合法 esds 在额外 16 bytes 之后仍提取出 ASC。

### 验证
- CMAF box / init / moof-flags / sidx 定向测试：81/81 通过。
- 全量 npm run check：fixtures 通过；3242/3242 tests；lint 548 个 JS 文件通过；完整门禁 exit code 0。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4 验收 19/19；真实 H.264 解码、播放/seek、stall recovery 与 destroy 均通过；截图已恢复。

### 提交和推送
- 完成验证后独立提交并推送 maintenance/round-6。

### 风险
- mp4a AudioSampleEntry 支持版本 0/1；未实现的 soundVersion 2/3 布局不做猜测解析。

## Attempt 97：拒绝 CMAF FullBox 中未定义的保留 flags

### 发现
- 多个 box parser 只校验 version 却忽略 flags：PRFT/TFDT/MFHD/SIDX 的 flags 必须为 0；TFHD/TRUN 只允许各自规范定义的位。保留位非零输入此前会被接受并按已知字段继续解析，掩盖损坏数据。
- 延伸审计还发现 SIDX 16-bit reserved 字段未检查、TRUN 接受互斥的 first_sample_flags/sample_flags、tfhd/trun/mfhd 缺少安全 content range 验证；parseMoof 会静默截断嵌套 child 列表、接受无/重复 tfhd 的 traf。延伸复核发现空 traf 会影响后续 traf 的隐式 base inheritance。
- 用户影响：非法 fragment metadata 可能被误认为有效时间/样本属性，带来时间戳错误、样本错位或解码失败。

### 修改
- cmaf/src/isobmff.js：PRFT、TFDT、MFHD 仅接受 flags=0；TFHD/TRUN 拒绝未定义 flags；实现 tfhd 显式 baseDataOffset 与 traf 间隐式数据基址继承，校验 duration-is-empty、sample_description_index 及 mutually exclusive trun flags；moof/traf 子 box 必须完整且每个 traf 恰有一个有效 tfhd。
- cmaf/src/chunk-parser.js：trun data_offset 相对已解析的 tfhd/ISO implicit base 计算；不再忽略显式 baseDataOffset。
- cmaf/src/isobmff.js：验证 tfhd/trun/mfhd/tfdt/prft 安全范围和完整字段；mp4a largesize 支持 64-bit box header。
- cmaf/__tests__/sidx.test.js：覆盖 PRFT/SIDX 非零保留 flags 拒绝。
- cmaf/__tests__/cmaf-box.test.js：新增 TFDT/MFHD 非零 flags 拒绝。
- cmaf/__tests__/cmaf-moof-flags.test.js：新增 TRUN/TFHD 未定义 flags 拒绝；既有全部合法标志组合仍测试。

### 验证
- 全套 CMAF 测试：166/166 通过（包含空 traf 数据基址继承回归）。
- 全量 npm run check：fixtures 通过；3252/3252 tests；lint 548 个 JS 文件通过；最终重跑 exit code 0。
- 真实 Chromium 1248 + MSE sintel-trailer.mp4 最终验收 19/19；真实解码、播放/seek、stall recovery 与 destroy 均通过；截图已恢复。

### 提交和推送
- 完成全量及浏览器验证后独立提交并推送 maintenance/round-6。

### 风险
- 对未来 ISO BMFF 扩展增加的新 flag 位需更新白名单实现；当前对未识别位明确拒绝。
