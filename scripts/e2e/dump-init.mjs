#!/usr/bin/env node
/** 对比 hls buildInit 与 mp4 Fmp4Remuxer.createInitSegment 的 init box 树与关键字段 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _internalForTest } from '../../hls/src/fmp4-muxer.js';
import { Fmp4Remuxer } from '../../mp4/src/remuxer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
void ROOT;

const desc = { tag: 'avcC', bytes: new Uint8Array(40) };
const hlsInit = _internalForTest.buildInit([{ id: 1, type: 'video', codec: 'avc1.64001F', description: desc, width: 854, height: 480, timescale: 90000 }]);
const mp4Init = new Fmp4Remuxer().createInitSegment({ id: 1, type: 'video', codec: 'avc1.64001F', description: new Uint8Array(40), width: 854, height: 480, timescale: 90000, sampleEntryType: 'avc1' });

const CONTAINER = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'mvex', 'traf', 'edts', 'udta', 'meta']);
function u32(b, o) { return (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]; }

function dump(buf, label) {
  console.log(`\n=== ${label} (${buf.length} bytes) ===`);
  function walk(off, end, depth) {
    let p = off;
    while (p + 8 <= end) {
      const size = u32(buf, p);
      const type = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
      const indent = '  '.repeat(depth);
      let extra = '';
      if (type === 'ftyp') {
        const brands = [];
        for (let i = 8; i + 4 <= p + size; i += 4) brands.push(String.fromCharCode(buf[p + i], buf[p + i + 1], buf[p + i + 2], buf[p + i + 3]));
        extra = ` brands=${brands.join(',')}`;
      } else if (type === 'tkhd') {
        const flags = u32(buf, p + 4 + 1) & 0xffffff; // flags 后 3 字节
        const w = u32(buf, p + size - 4);
        const h = u32(buf, p + size - 8);
        extra = ` flags=${flags.toString(16)} w=${w} h=${h}`;
      } else if (type === 'trex') {
        const id = u32(buf, p + 12);
        const defDesc = u32(buf, p + 16);
        const defDur = u32(buf, p + 20);
        const defSize = u32(buf, p + 24);
        const defFlags = u32(buf, p + 28);
        extra = ` trackId=${id} defSampleDescIdx=${defDesc} defDur=${defDur} defSize=${defSize} defFlags=0x${defFlags.toString(16)}`;
      } else if (type === 'mvhd') {
        const ts = u32(buf, p + 8 + 8); // version(1)+flags(3)+creation(4)+mod(4)+timescale(4)
        extra = ` timescale=${ts}`;
      } else if (type === 'avc1') {
        const w = (buf[p + 8 + 24] << 8) | buf[p + 8 + 25];
        const h = (buf[p + 8 + 26] << 8) | buf[p + 8 + 27];
        extra = ` w=${w} h=${h}`;
      }
      console.log(`${indent}${type} size=${size}${extra}`);
      if (size < 8) break;
      if (CONTAINER.has(type)) walk(p + 8, p + size, depth + 1);
      p += size;
    }
  }
  walk(0, buf.length, 0);
}

dump(hlsInit, 'HLS buildInit');
dump(mp4Init, 'mp4 Fmp4Remuxer.init');
