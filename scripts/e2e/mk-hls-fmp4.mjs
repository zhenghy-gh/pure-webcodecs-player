/**
 * 生成「fMP4 直通形态」的本地 HLS 验收流：
 *   samples/e2e/fmp4/init.mp4 + seg-000.m4s… + playlist.m3u8
 * 数据源 = bbb480_30s.ts（ts/ 模块 demux，annexb→avcc），
 * 复用被 MSE 真机验收通过的 mp4 Fmp4Remuxer 切 2s GOP 批。
 * 用途：I3 hls demo 真机链路验收（HlsPlayer 对 EXT-X-MAP fMP4 走直通 MSE，
 *       不经 TS→fMP4 transmux）；规避 transmux 产物 Chrome 兼容遗留问题（见台账）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TsDemuxer } from '../../ts/src/index.js';
import { Fmp4Remuxer, batchSamplesByGop } from '../../mp4/src/remuxer.js';
import { annexbToAvcc } from '../../core/src/nal.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '../../samples/e2e/fmp4');
fs.mkdirSync(OUT, { recursive: true });

const bytes = new Uint8Array(fs.readFileSync('samples/e2e/bbb480_30s.ts'));
const sink = { write() {}, end() {} };
const demuxer = new TsDemuxer(sink);
const opened = demuxer.open();
sink.write(bytes);
sink.end();
await opened;

let vTrack = null;
const vSamples = [];
for (const t of demuxer.tracks || []) {
  if (t.type !== 'video') continue;
  vTrack = t;
  for (;;) {
    const s = await demuxer.readSample(t.id);
    if (!s) break;
    vSamples.push(s);
  }
}
if (!vTrack) throw new Error('no video track');
console.log(`video ${vTrack.codec} ${vTrack.width}x${vTrack.height} samples=${vSamples.length}`);

const track = {
  id: 1,
  type: 'video',
  codec: vTrack.codec,
  description: vTrack.description, // 裸 avcC content（与 mp4 demuxer 契约一致）
  width: vTrack.width,
  height: vTrack.height,
  timescale: 90000,
  sampleEntryType: 'avc1',
};
const samples = vSamples.map((s) => ({
  timestamp: s.pts ?? s.timestamp,
  dts: s.dts ?? s.timestamp,
  duration: s.duration || 30000,
  keyframe: !!s.keyframe,
  data: annexbToAvcc(s.data),
}));

const fr = new Fmp4Remuxer();
fs.writeFileSync(path.join(OUT, 'init.mp4'), fr.createInitSegment(track));

const batches = batchSamplesByGop(samples, { targetDurationUs: 2_000_000 });
const lines = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-TARGETDURATION:3', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-MAP:URI="init.mp4"'];
batches.forEach((batch, i) => {
  const seg = fr.createMediaSegment(track, batch);
  fs.writeFileSync(path.join(OUT, `seg-${String(i).padStart(3, '0')}.m4s`), seg.data);
  const dur = (batch.reduce((a, s) => a + (s.duration ?? 0), 0) / 1e6).toFixed(3);
  lines.push(`#EXTINF:${dur},`, `seg-${String(i).padStart(3, '0')}.m4s`);
});
lines.push('#EXT-X-ENDLIST');
fs.writeFileSync(path.join(OUT, 'playlist.m3u8'), lines.join('\n') + '\n');
console.log(`fmp4 HLS written: init + ${batches.length} segs (${(samples.length).toFixed(0)} samples, ~${(samples.reduce((a,s)=>a+(s.duration??0),0)/1e6).toFixed(1)}s)`);
