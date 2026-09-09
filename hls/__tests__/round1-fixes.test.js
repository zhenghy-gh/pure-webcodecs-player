/**
 * 第一轮评审修复验证（严重①②⑤⑦ + 建议1/2）
 * 覆盖：EXT-X-SKIP sn 偏移、续播三场景、SegmentLoader Range/超时、
 * EXTM3U 校验、IV 严格化、PlayerError 错误码贯通、unknown 容器拒收。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMedia } from '../src/m3u8-parser.js';
import { SegmentLoader, LoadError } from '../src/segment-loader.js';
import {
  computeResumeIndexBySn,
  computeResumeIndexByTimeUs,
} from '../src/index.js';
import { Transmuxer } from '../src/transmuxer.js';
import { HlsPlayer } from '../src/player.js';
import { LevelController } from '../src/level-controller.js';
import { MseController } from '../src/mse-controller.js';
import { expandKey128, aesCbcDecryptNoPadding } from '../src/aes-cbc.js';
import { TsToFmp4Transmuxer } from '../src/fmp4-muxer.js';

/* ---------------- 严重①：EXT-X-SKIP sn 偏移 ---------------- */

const DELTA = `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:100
#EXT-X-SKIP:SKIPPED-SEGMENTS=10
#EXTINF:4.0,
skip-then.ts
#EXTINF:4.0,
after.ts
#EXT-X-ENDLIST`;

test('Delta 清单：sn = MEDIA-SEQUENCE + SKIPPED-SEGMENTS + 下标', () => {
  const p = parseMedia(DELTA, '');
  assert.equal(p.skippedSegments, 10);
  assert.deepEqual(
    p.segments.map((s) => s.sn),
    [110, 111],
    '被省略的 100~109 计入偏移'
  );
});

/* ---------------- 严重②③：续播定位三场景 ---------------- */

const SEGS = (from, to) =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ sn: from + i, duration: 4 }));

test('computeResumeIndexBySn：精确衔接', () => {
  // 已消费 sn=105 → 新列表从 106 开始取
  assert.equal(computeResumeIndexBySn(SEGS(106, 120), 105), 0);
  // 新列表窗口起点早于锚点：命中 anchor+1 的位置
  assert.equal(computeResumeIndexBySn(SEGS(100, 120), 105), 6);
});

test('computeResumeIndexBySn：锚点已被窗口滑过 → 向前找不重放', () => {
  // 锚点 sn=90，新窗口 100~120：不存在 91，取第一个 >90 的位置 0，而非回退重放
  assert.equal(computeResumeIndexBySn(SEGS(100, 120), 90), 0);
});

test('computeResumeIndexBySn：无后续可取 → 返回列表长度等待刷新', () => {
  // 锚点 500，新窗口 100~120 全部已消费过：等待而不是重放
  assert.equal(computeResumeIndexBySn(SEGS(100, 120), 500), 21);
  assert.equal(computeResumeIndexBySn([], 5), 0);
});

test('computeResumeIndexByTimeUs：VOD 按时刻映射分片下标', () => {
  const segs = [{ duration: 4 }, { duration: 4 }, { duration: 4 }];
  assert.equal(computeResumeIndexByTimeUs(segs, 0), 0);
  assert.equal(computeResumeIndexByTimeUs(segs, 4e6 - 1), 0);
  assert.equal(computeResumeIndexByTimeUs(segs, 4e6), 1);
  assert.equal(computeResumeIndexByTimeUs(segs, 9.5e6), 2);
  // 超出末尾：钳制到最后一片
  assert.equal(computeResumeIndexByTimeUs(segs, 99e6), 2);
});

/* ---------------- 严重⑤：SegmentLoader Range 与超时码 ---------------- */

test('SegmentLoader：BYTERANGE 映射为 Range 请求头', async () => {
  const seen = [];
  const loader = new SegmentLoader({
    fetchImpl: async (url, init = {}) => {
      seen.push(init.headers?.['Range']);
      return {
        ok: true,
        status: 206,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(4),
      };
    },
  });
  await loader.load('https://cdn/a.mp4', { byteRange: { length: 75232, offset: 1000 } });
  assert.equal(seen[0], 'bytes=1000-76231');
});

test('SegmentLoader：超时产出 TIMEOUT 码并按网络类重试', async () => {
  let attempts = 0;
  const loader = new SegmentLoader({
    timeoutMs: 30,
    maxRetry: 1,
    retryDelayMs: 1,
    fetchImpl: (url, init = {}) =>
      new Promise((_resolve, reject) => {
        attempts += 1;
        init.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }),
  });
  await assert.rejects(
    () => loader.load('https://slow/x.ts'),
    (e) => e instanceof LoadError && e.code === 'TIMEOUT'
  );
  assert.ok(attempts >= 2, `超时应触发重试，实际尝试 ${attempts} 次`);
});

test('SegmentLoader：4xx → SOURCE_ERROR 且 fatal 不重试', async () => {
  let attempts = 0;
  const loader = new SegmentLoader({
    fetchImpl: async () => {
      attempts += 1;
      return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
    },
  });
  await assert.rejects(
    () => loader.loadText('https://cdn/no.m3u8'),
    (e) => e.code === 'SOURCE_ERROR' && e.fatal === true
  );
  assert.equal(attempts, 1);
});

/* ---------------- 建议1/2：EXTM3U 校验 / BOM / unknown 拒收 ---------------- */

test('EXTM3U 首行校验：缺失报 PARSE_ERROR；BOM 自动剥离', () => {
  assert.throws(
    () => parseMedia('#EXTINF:4,\na.ts\n', ''),
    (e) => e.code === 'PARSE_ERROR' && /首行必须是 #EXTM3U/.test(e.message)
  );
  const p = parseMedia('\uFEFF#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST', '');
  assert.equal(p.segments.length, 1, '带 BOM 的合法清单正常解析');
});

test('解析抛错均为 PlayerError(PARSE_ERROR) 且保留中文文案', () => {
  try {
    parseMedia('#EXTM3U\n#EXT-X-TARGETDURATION:4\nbad.ts\n', '');
    assert.fail('应当抛错');
  } catch (e) {
    assert.equal(e.name, 'PlayerError');
    assert.equal(e.code, 'PARSE_ERROR');
    assert.match(e.message, /缺少 #EXTINF/);
  }
});

test('IV 严格化：奇数长度 / 超 128 位 / 非十六进制均报错', () => {
  const wrap = (iv) =>
    `#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-KEY:METHOD=AES-128,URI="k",IV=${iv}\n#EXTINF:4,\na.ts`;
  for (const bad of ['0xABC', '0x' + 'ab'.repeat(17), '0xZZZZ']) {
    assert.throws(() => parseMedia(wrap(bad), ''), (e) => e.code === 'PARSE_ERROR', `IV=${bad} 应报错`);
  }
  // 合法：右对齐填充到 16 字节
  const p = parseMedia(wrap('0xABCD'), '');
  assert.deepEqual(Array.from(p.segments[0].key.iv.bytes.slice(-2)), [0xab, 0xcd]);
  assert.ok(p.segments[0].key.iv.bytes.slice(0, 14).every((b) => b === 0));
});

test('unknown 容器不再静默空转：Transmuxer 直接拒收', async () => {
  const t = new Transmuxer();
  await assert.rejects(
    () => t.process(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), {}),
    (e) => e.code === 'PARSE_ERROR' && /无法识别的分片容器形态/.test(e.message)
  );
});

/* ---------------- 建议：BYTERANGE length=0 不得生成非法 Range 头 ---------------- */

test('BYTERANGE 长度非正整数 → 解析期 PARSE_ERROR（不产出非法 Range）', () => {
  for (const bad of ['#EXT-X-BYTERANGE:0', '#EXT-X-BYTERANGE:0@100']) {
    assert.throws(
      () => parseMedia(`#EXTM3U\n#EXT-X-TARGETDURATION:4\n${bad}\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST`, ''),
      (e) => e.code === 'PARSE_ERROR' && /BYTERANGE/.test(e.message),
      `BYTERANGE 值 "${bad}" 应报 PARSE_ERROR`
    );
  }
});

test('SegmentLoader：byteRange.length<=0 跳过 Range 头（防御性兜底）', async () => {
  const seen = [];
  const loader = new SegmentLoader({
    fetchImpl: async (url, init = {}) => {
      seen.push(init.headers?.['Range']);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(4),
      };
    },
  });
  // length=0 即便绕过得解析校验，也不得发出 "bytes=100-99" 之类非法头
  await loader.load('https://cdn/a.mp4', { byteRange: { length: 0, offset: 100 } });
  assert.equal(seen[0], undefined, 'length<=0 不得设置 Range 请求头');
});

/* ---------------- 严重③残余：_startPipeline 不得抹掉续播下标 ---------------- */

test('_startPipeline 保留入参下标与续播锚点（切档不回片头）', () => {
  const p = new HlsPlayer();
  let pumped = 0;
  p._pump = () => {
    pumped += 1;
  };
  p._scheduleLivePoll = () => {};

  // 切档/续播场景：锚点必须保留，否则直播轮询与下一次重载失去衔接依据
  p._lastAppendedSn = 105;
  p._startPipeline(7);
  assert.equal(p.nextSegmentIdx, 7, '入参下标被 _startPipeline 抹掉会导致回到片头');
  assert.equal(p._lastAppendedSn, 105, '续播锚点不得被清空');

  // 首次装载：从 0 起播并清空锚点
  p._startPipeline();
  assert.equal(p.nextSegmentIdx, 0);
  assert.equal(p._lastAppendedSn, null);
  assert.equal(pumped, 2, '两种场景都应触发一次 pump');
});

/* ---------------- 严重⑤：错误体系统一（LoadError 签名 + 十码） ---------------- */

test('SegmentLoader 无 fetchImpl：LoadError 走 (code,message) 签名 → NOT_SUPPORTED', async () => {
  const loader = new SegmentLoader({ fetchImpl: async () => ({ ok: true }) });
  loader._fetch = null; // 模拟无 fetch 环境
  await assert.rejects(
    () => loader.load('https://cdn/x.ts'),
    (e) =>
      e instanceof LoadError &&
      e.code === 'NOT_SUPPORTED' &&
      /无 fetch/.test(e.message) &&
      e.fatal === true,
    '旧签名会把 message 当成 code 写入 err.code'
  );
});

test('LevelController.switchTo 越界 → STATE_ERROR（原 RangeError 非十码）', () => {
  const lc = new LevelController([{ url: 'a.m3u8', bandwidth: 1000 }]);
  assert.throws(
    () => lc.switchTo(5),
    (e) => e.code === 'STATE_ERROR' && e.name === 'PlayerError'
  );
  assert.throws(() => lc.switchTo(-2), (e) => e.code === 'STATE_ERROR');
});

test('MseController 未初始化 SourceBuffer：append → STATE_ERROR', async () => {
  const m = new MseController();
  await assert.rejects(
    () => m.append('video', new Uint8Array([0])),
    (e) => e.code === 'STATE_ERROR' && /未初始化/.test(e.message)
  );
});

test('AES 参数非法 → PARSE_ERROR（全模块零裸 Error）', () => {
  assert.throws(
    () => expandKey128(new Uint8Array(15)),
    (e) => e.code === 'PARSE_ERROR' && e.name === 'PlayerError'
  );
  const key = new Uint8Array(16);
  assert.throws(
    () => aesCbcDecryptNoPadding(key, key, new Uint8Array(17)),
    (e) => e.code === 'PARSE_ERROR'
  );
});

test('TsToFmp4Transmuxer 销毁后 remux → STATE_ERROR', async () => {
  const t = new TsToFmp4Transmuxer();
  t.destroyed = true;
  await assert.rejects(
    () => t.remux(new Uint8Array(188)),
    (e) => e.code === 'STATE_ERROR' && /已销毁/.test(e.message)
  );
});
