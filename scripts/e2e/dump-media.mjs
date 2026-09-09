#!/usr/bin/env node
/** 对比两份 media 段的 moof/trun 关键字段，定位 append 失败结构差异 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const base = path.join(ROOT, 'samples/e2e/transmux-diag');

function u32(b, o) { return (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]; }

function analyze(file) {
  const buf = new Uint8Array(fs.readFileSync(file));
  const n = buf.length;
  // 找 mdat
  let moofLen = 0, mdatPayload = 0, hasStyp = false;
  if (String.fromCharCode(buf[4], buf[5], buf[6], buf[7]) === 'styp') { hasStyp = true; const s = u32(buf, 0); moofLen = s; }
  // 找 moof box
  let p = hasStyp ? moofLen : 0;
  // p 应是 moof 起点
  const moofStart = p;
  const moofSize = u32(buf, p);
  moofLen = moofSize;
  // 找 mdat 起点（moof 之后）
  const mdatStart = p + moofSize;
  const mdatSize = u32(buf, mdatStart);
  mdatPayload = mdatSize - 8;
  // 在 moof 内找 trun
  const moov = buf.subarray(p, p + moofSize);
  let trunOff = -1;
  for (let i = 0; i + 4 <= moov.length; i++) {
    if (moov[i] === 0x74 && moov[i + 1] === 0x72 && moov[i + 2] === 0x75 && moov[i + 3] === 0x6e) { trunOff = i; break; }
  }
  // tfdt
  let tfdtOff = -1;
  for (let i = 0; i + 4 <= moov.length; i++) {
    if (moov[i] === 0x74 && moov[i + 1] === 0x66 && moov[i + 2] === 0x64 && moov[i + 3] === 0x74) { tfdtOff = i; break; }
  }
  const tfdt = tfdtOff >= 0 ? Number((BigInt(u32(moov, tfdtOff + 12)) << 32n) | BigInt(u32(moov, tfdtOff + 16))) : -1;
  const sampleCount = trunOff >= 0 ? u32(moov, trunOff + 8) : -1;
  const dataOffset = trunOff >= 0 ? u32(moov, trunOff + 12) : -1;
  // per-sample: duration(4) size(4) flags(4) cts(4) 从 trunOff+16
  let sumSize = 0;
  const rows = [];
  for (let k = 0; k < sampleCount; k++) {
    const o = trunOff + 16 + k * 16;
    const dur = u32(moov, o);
    const sz = u32(moov, o + 4);
    const fl = u32(moov, o + 8);
    const cts = (moov[o + 12] << 24) | (moov[o + 13] << 16) | (moov[o + 14] << 8) | moov[o + 15];
    sumSize += sz;
    if (k < 3 || k === sampleCount - 1) rows.push({ k, dur, sz, fl: '0x' + fl.toString(16), cts });
  }
  return { file: path.basename(file), total: n, moofStart, moofSize, mdatPayload, hasStyp, tfdt, sampleCount, dataOffset, sumSize, sumVsMdat: sumSize === mdatPayload, rows };
}

for (const f of ['A/seg-000.m4s', 'I/seg-000.m4s', 'D/seg-000.m4s', 'I/seg-000.m4s']) {
  try {
    const r = analyze(path.join(base, f));
    console.log(`\n[${r.file}] total=${r.total} hasStyp=${r.hasStyp} moof=${r.moofSize} mdatPayload=${r.mdatPayload}`);
    console.log(`  tfdt=${r.tfdt} sampleCount=${r.sampleCount} dataOffset=${r.dataOffset} sumSize=${r.sumSize} sum==mdat? ${r.sumVsMdat}`);
    console.log('  first/last samples:', JSON.stringify(r.rows));
  } catch (e) { console.log(`[${f}] err ${e.message}`); }
}
