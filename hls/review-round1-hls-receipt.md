# review-round1 · hls 严重③残余 & ⑤错误体系 闭环回执 — 2026-09-07

> 对应台账：docs/review/round-1-问题清单.md §5 hls、§0 S1，复核记录见 §9.2。
> 验证：`node --test "hls/__tests__/*.test.js"` → 72/72；全仓 867/867；`node scripts/lint.mjs` 通过。

## 严重③残余：切档/续播回到片头 ✅ 已修

- 问题：`_startPipeline()` 无参且内部 `this.nextSegmentIdx = 0`，把 `_loadMediaPlaylist()`
  按 sn/时刻算出的 `resumeIdx`（player.js:163、:169 传入）直接抹掉；同时无条件清空
  `_lastAppendedSn`，使后续直播轮询失去锚点。
- 修复：`_startPipeline(startIdx = 0)` → `nextSegmentIdx = startIdx`；
  `_lastAppendedSn` 仅在 `startIdx <= 0`（真·首次装载）时清空。
- 用例：`round1-fixes.test.js`「_startPipeline 保留入参下标与续播锚点」
  —— 入参 7 不被抹掉、锚点 105 保留、无参调用归零且清空锚点、两种场景各触发一次 pump。

## 严重⑤：错误体系统一（S1 遗留）✅ 全模块零裸 Error

| 位置 | 修复前 | 修复后 |
|---|---|---|
| segment-loader.js:89 | `new LoadError(message, info)`（message 被写进 `err.code`） | `new LoadError(ErrorCode.NOT_SUPPORTED, message, info)` |
| player.js:125 | `new LoadError('m3u8 解析错误…', {fatal})` | `PARSE_ERROR` 码 |
| player.js:436 | `new Error('当前源为单码率…')` | `stateError()` |
| level-controller.js:62 | `RangeError` | `stateError()`（附 levelIndex detail） |
| mse-controller.js:49/62/64/83/97/99/137 | 7 处裸 Error | `decodeError` / `stateError` / `notSupported` |
| data-source.js:24/140 | 裸 Error | `notSupported` / `sourceError`（带 status） |
| aes-cbc.js:73/153 | 裸 Error 参数校验 | `parseError` |
| fmp4-muxer.js:373 | 裸 Error（已销毁） | `PlayerError(STATE_ERROR)` |

附带两项（原建议级）：
- `_onQuotaEvict` 回调接通（此前是死字段）：QuotaExceeded 时先通知上层裁剪再抛 DECODE_ERROR；
- `isTypeSupported` 改走 attach 时保存的 MSCtor，不再裸引用全局 `MediaSource`（双环境红线）。

新增用例 5 例：LoadError 签名（NOT_SUPPORTED + fatal）、LevelController 越界 STATE_ERROR、
MseController 未初始化 STATE_ERROR、AES 参数 PARSE_ERROR、Transmuxer 销毁后 STATE_ERROR。

## 复核命令

```bash
node --test --test-timeout=10000 --test-force-exit "hls/__tests__/*.test.js"   # 72/72
node --test --test-timeout=10000 --test-force-exit "**/__tests__/*.test.{js,mjs}" # 867/867
node scripts/lint.mjs
```
