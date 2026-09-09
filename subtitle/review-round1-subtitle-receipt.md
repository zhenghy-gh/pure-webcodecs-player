# review-round1 · subtitle 严重1&2 闭环回执（补达）— ui-kit-dev

## 严重1 \1c/\2c/\3c 词法失效 ✅ 已修
- tags.js tokenizeDialogue token 名解析改**数字前缀优先**：`/^([1-4][a-zA-Z]+)/` 先于字母正则执行；
- `'1c&H…'` 正确切出 name='1c' → apply 的 case '1c' 分支恢复可达（主色覆盖生效）；
- 用例：contract.test.js「\1c 行内变色生效」断言 unsupportedTags 不含 '1c' 且 run 主色被覆盖。

## 严重2 §8 三件套 + Cue 冻结面 ✅ 已交付
- 新增 `src/track.js`：
  - `probe(bytes)` → `{format:'srt'|'vtt'|'ass'} | null`（同步不抛）；
  - `async* parseCues(bytes, {format?, encoding?, trackId?})` → AsyncIterable<Cue>；TextDecoder(encoding) 支持 gbk（中文 SRT 用例通过）/utf-8 回退；
  - `createTextTrack(cuesIterable)` → `{id, type:'text', codec, cues(), cuesUntil(us)}`（先整流缓存再重放；codec 由首条 raw 嗅探 x-srt/x-vtt/x-ass）；
- Cue 冻结面：trackId + raw(Uint8Array 原始条目字节) 挂接 srt/vtt/ass 三解析器输出；增量字段零破坏，99/99 全绿。index.js 已导出三件套。

## 复核命令
```
node --test subtitle/__tests__/contract.test.js   # 6/6
node --test subtitle/__tests__/*.test.js          # 99/99
```
