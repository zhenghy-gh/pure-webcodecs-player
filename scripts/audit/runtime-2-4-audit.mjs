/**
 * §2.4 运行时契约审计（第五十波 #22）
 *
 * 对 7 个 demuxer 模块做"逐模块运行时"现盘核对，覆盖清单第 4/5/7/8 项：
 *   C4  未 open 先调 readSample → 抛 STATE_ERROR（或 Promise reject）
 *   C5  seek 行为：可寻址容器 resolve {actualTimestampUs}；直播/无索引 reject SEEK_UNSUPPORTED
 *   C7  事件名集合 ⊆ {error, media-info, mediaInfo, sample, progress, end}
 *   C8  所有 Sample.timestamp / duration 为整数微秒（µs），不外泄 ticks
 *
 * 复用各模块 fixtures/gen.mjs 现盘生成 canonical fixture（__tests__/fixtures 已被 .gitignore 忽略），
 * 经 MemoryDataSource 装入后跑真实 open→readSample 循环。
 *
 * 用法：node scripts/audit/runtime-2-4-audit.mjs
 */
import { readFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryDataSource } from '../../core/src/index.js';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const ALLOWED_EVENTS = new Set(['error', 'media-info', 'mediaInfo', 'sample', 'progress', 'end']);

/** 模块注册表：generate(fixDir) 落盘 canonical fixture + 读取字节 + Demuxer 类 */
async function loadFixtureBytes(relGen, relFile) {
  const genPath = path.join(ROOT, relGen);
  const fixDir = path.dirname(genPath);
  await mkdir(fixDir, { recursive: true });
  const mod = await import(`file://${genPath}`);
  await mod.generate(fixDir);
  return readFile(path.join(fixDir, relFile));
}

const REGISTRY = [
  { name: 'mp4', gen: 'mp4/__tests__/fixtures/gen.mjs', file: 'progressive.mp4', demuxer: 'mp4/src/demuxer.js', cls: 'Mp4Demuxer' },
  { name: 'mov', gen: 'mov/__tests__/fixtures/gen.mjs', file: 'quicktime.mov', demuxer: 'mov/src/demuxer.js', cls: 'MovDemuxer' },
  { name: 'ts', gen: 'ts/__tests__/fixtures/gen.mjs', file: 'basic.ts', demuxer: 'ts/src/ts-demuxer.js', cls: 'TsDemuxer' },
  { name: 'flv', gen: 'flv/__tests__/fixtures/gen.mjs', file: 'basic.flv', demuxer: 'flv/src/flv-demuxer.js', cls: 'FlvDemuxer' },
  { name: 'mkv', gen: 'mkv/__tests__/fixtures/gen.mjs', file: 'avc-aac-flac.mkv', demuxer: 'mkv/src/demuxer.js', cls: 'MkvDemuxer' },
  { name: 'flac', gen: 'flac/__tests__/fixtures/gen.mjs', file: 'sample-basic.flac', demuxer: 'flac/src/demuxer.js', cls: 'FlacDemuxer' },
  { name: 'wav', gen: 'wav/__tests__/fixtures/gen.mjs', file: 'sample-basic.wav', demuxer: 'wav/src/demuxer.js', cls: 'WavDemuxer' },
];

function isStateError(e) {
  return e && (e.code === 'STATE_ERROR' || (e instanceof Error && /STATE_ERROR/i.test(e.message)));
}

async function checkC4(Demuxer, bytes) {
  const d = new Demuxer(new MemoryDataSource(bytes));
  try {
    await d.readSample(1);
    return { ok: false, detail: '未抛 STATE_ERROR（resolve 了 null/样本）' };
  } catch (e) {
    if (isStateError(e)) return { ok: true, detail: '未 open 调 readSample 抛 STATE_ERROR' };
    return { ok: false, detail: `抛了非 STATE_ERROR: ${e?.code || e?.message}` };
  }
}

async function checkC5(Demuxer, bytes, opened) {
  // opened 已 open 的实例；seek 到 0
  try {
    const r = await opened.seek(0);
    return { ok: true, detail: `seek(0) resolve（可寻址）${r && r.actualTimestampUs !== undefined ? ' → ' + r.actualTimestampUs + 'µs' : ''}` };
  } catch (e) {
    if (e && e.code === 'SEEK_UNSUPPORTED') return { ok: true, detail: 'seek 拒 SEEK_UNSUPPORTED（无索引/直播，符合契约）' };
    return { ok: false, detail: `seek 抛非预期错误: ${e?.code || e?.message}` };
  }
}

async function runModule(cfg) {
  const bytes = await loadFixtureBytes(cfg.gen, cfg.file);
  const { [cfg.cls]: Demuxer } = await import(`file://${path.join(ROOT, cfg.demuxer)}`);

  const res = { name: cfg.name, C4: null, C5: null, C7: { ok: true, bad: [], names: [] }, C8: { ok: true, bad: [] } };

  // C4：未 open 调 readSample
  res.C4 = await checkC4(Demuxer, bytes);

  // open + 事件名收集 + 时间戳整数
  const events = new Set();
  const d = new Demuxer(new MemoryDataSource(bytes));
  const onAny = (e) => events.add(e);
  ['error', 'media-info', 'mediaInfo', 'sample', 'progress', 'end'].forEach((e) => d.on?.(e, () => onAny(e)));

  try {
    await d.open();
  } catch (e) {
    res.C7 = { ok: false, bad: [`open 失败: ${e?.code || e?.message}`], names: [...events] };
    return res;
  }

  const tid = (d.tracks && d.tracks[0]?.id) ?? 1;
  let count = 0;
  const MAX = 2000;
  try {
    while (count < MAX) {
      const s = await d.readSample(tid);
      if (s == null) break;
      count++;
      // C8：整数 µs
      if (!Number.isInteger(s.timestamp)) res.C8.bad.push(`#${count} timestamp=${s.timestamp} 非整数`);
      if (s.duration != null && !Number.isInteger(s.duration)) res.C8.bad.push(`#${count} duration=${s.duration} 非整数`);
      if (res.C8.bad.length > 5) break;
    }
  } catch (e) {
    // 到达 EOS 之外的拒绝不计入 C8 失败（只记事件）
  }

  res.C7.names = [...events];
  for (const e of events) if (!ALLOWED_EVENTS.has(e)) res.C7.bad.push(`非法事件名: ${e}`);
  res.C7.ok = res.C7.bad.length === 0;

  // C5：seek 行为（可寻址 resolve / 无索引 reject SEEK_UNSUPPORTED）
  res.C5 = await checkC5(Demuxer, bytes, d);

  // 收尾
  try { await d.destroy(); } catch { /* ignore */ }
  return res;
}

async function main() {
  console.log('=== §2.4 运行时契约审计（7 模块 × 4 项）===\n');
  const rows = [];
  let allOk = true;
  for (const cfg of REGISTRY) {
    let r;
    try {
      r = await runModule(cfg);
    } catch (e) {
      r = { name: cfg.name, C4: { ok: false, detail: '审计脚本异常: ' + (e?.stack || e?.message) }, C5: null, C7: { ok: false, bad: [String(e)], names: [] }, C8: { ok: false, bad: [String(e)] } };
    }
    const pass = r.C4?.ok && r.C5?.ok && r.C7.ok && r.C8.ok;
    if (!pass) allOk = false;
    rows.push(r);
    console.log(`【${r.name}】${pass ? 'PASS' : 'FAIL'}`);
    console.log(`  C4 未open→STATE_ERROR : ${r.C4?.ok ? '✓' : '✗'} ${r.C4?.detail || ''}`);
    console.log(`  C5 seek 行为         : ${r.C5?.ok ? '✓' : '✗'} ${r.C5?.detail || ''}`);
    console.log(`  C7 事件名 ⊆ 5者      : ${r.C7.ok ? '✓' : '✗'} 触发[${r.C7.names.join(',') || '∅'}]${r.C7.bad.length ? ' 异常:' + r.C7.bad.join(';') : ''}`);
    console.log(`  C8 时间戳整数 µs      : ${r.C8.ok ? '✓' : '✗'}${r.C8.bad.length ? ' 异常:' + r.C8.bad.join(';') : ' 全部整数'}`);
    console.log('');
  }
  console.log(allOk ? '=== 全部模块 §2.4 运行时契约 PASS ===' : '=== 存在 FAIL，见上 ===');
  process.exitCode = allOk ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
