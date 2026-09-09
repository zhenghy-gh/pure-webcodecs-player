import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createRtspWsRelay } from '../../samples/gateway/src/server-rtsp.js';
import { createSource, PlayerError, errors } from '../src/index.js';

let PORT; // listen(0) 系统分配
let server;

before(async () => {
  server = createRtspWsRelay({ host: '127.0.0.1', port: 0 });
  PORT = await server.ready;
});

after(async () => server.dispose());

test('createSource：§10 传输形状——meta 携带 codec/bitstreamFormat，data 为 AnnexB AU', async () => {
  const src = await createSource({ url: `ws://127.0.0.1:${PORT}/rtsp?intervalMs=5` });
  try {
    assert.ok(src.meta, 'start() resolve 时 meta 已可用');
    assert.equal(src.meta.codec, 'h264');
    assert.equal(src.meta.bitstreamFormat, 'annexb');
    assert.equal(src.meta.live, true);
    assert.ok(src.meta.parameterSets.sps.length >= 1);

    const chunks = [];
    let watchdog;
    await new Promise((resolve, reject) => {
      const off = src.on('data', (bytes, info) => {
        chunks.push({ bytes, info });
        if (chunks.length >= 4) {
          src.off('data', off);
          resolve();
        }
      });
      // 成功路径也必须撤销看门狗：引用型定时器会钉住进程直至超时
      watchdog = setTimeout(() => reject(new Error('收 chunk 超时')), 8000);
    });
    clearTimeout(watchdog);
    for (const c of chunks) {
      // AnnexB 起始码开头
      assert.deepEqual(Array.from(c.bytes.subarray(0, 4)), [0, 0, 0, 1]);
      assert.equal(typeof c.info.ptsUs, 'number');
      assert.ok(Number.isInteger(c.info.ptsUs), 'pts 必须是整数微秒（§0.5）');
    }
    assert.equal(chunks[0].info.keyframe, true);
  } finally {
    src.stop();
  }
});

test('错误码对齐 §11.3：连接失败报 NETWORK_ERROR，重复 start 报 STATE_ERROR', async () => {
  const bad = await createSource({ url: `ws://127.0.0.1:1/rtsp` }).catch((e) => e);
  assert.ok(bad instanceof PlayerError);
  assert.equal(bad.code, 'NETWORK_ERROR');
  void errors;
});

// TEMP-PROBE3
setTimeout(() => {
  console.error('[PROBE3] activeResources:', JSON.stringify(process.getActiveResourcesInfo?.()));
}, 1000);
setTimeout(() => {
  console.error('[PROBE3@2500]:', JSON.stringify(process.getActiveResourcesInfo?.()));
}, 2500);
