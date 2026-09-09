# fixtures 约定（一页纸）

> 维护人：sdet · 2025-08-25 ｜ 适用：全部 16 个功能模块的 `__tests__` ｜ 配套：docs/TESTING.md §3

## 目标

测试样本**程序化生成、离线可复现、二进制不入库**。任何人 clone 仓库后
`npm run fixtures && npm test` 必须完整复现所有测试，不依赖外网、真实媒体文件或手工拷贝。

## 契约

1. **位置与签名**：`<模块>/__tests__/fixtures/gen.mjs`，导出：

   ```js
   export async function generate(fixDir) { /* 把样例文件写入 fixDir */ }
   ```

2. **触发方式**：`npm run fixtures`（= `samples/generate-all.mjs`）逐模块调用；
   没有 gen.mjs 的模块自动跳过；重复运行必须幂等（覆盖写，无副作用累积）。
3. **产物处置**：写入 gen.mjs 所在目录即可（`__tests__/fixtures/` 已被根 .gitignore
   整体忽略，仅 gen.mjs 本身入库）；产物丢失/损坏随时重建。
4. **实现红线**：
   - 容器字节一律 `import` 根 fixture 库 `samples/fixtures/index.js` 复用生成，
     **禁止在 gen.mjs 里另造第二套编码器**；
   - 输出必须确定性：禁随机数、禁当前时间戳；
   - 禁网络下载样本、禁提交任何二进制到 git。

## 参考实现（flv/__tests__/fixtures/gen.mjs，可直接复制改名）

```js
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { makeFLV } from '../../../samples/fixtures/index.js';

/** @param {string} fixDir 产物目录（即本文件所在目录） */
export async function generate(fixDir) {
  await mkdir(fixDir, { recursive: true });
  const cases = [
    ['basic.flv', makeFLV({ frameCount: 6 })],
    ['av.flv', makeFLV({ hasAudio: true, frameCount: 8 })],
    ['tiny.flv', makeFLV({ frameCount: 1 })],
  ];
  for (const [name, { bytes, meta }] of cases) {
    await writeFile(path.join(fixDir, name), bytes);
    console.log(`[fixtures] ${name}: ${bytes.length}B / ${meta.frameCount}帧`);
  }
}
```

## 两条通道怎么选

| 通道 | 适用 | 说明 |
|---|---|---|
| **内存字节**（推荐默认） | 绝大多数解析层单测 | 直接 `import { makeFLV } from '../../samples/fixtures/index.js'`，零磁盘 IO |
| **落盘文件**（本约定） | demo 拖拽演示、按字节截断/注入用例、跨模块交叉验证 | 写 gen.mjs，内部仍 import samples/fixtures |

## 验收口径

- 模块完工自检 = `npm run check`（串行 fixtures → test → lint，任一步失败即停）。
- qa/captain 初验时会在干净环境重跑 `npm run fixtures` 核对产物可重建、测试全绿。
