import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasWebCodecs,
  hasMSE,
  hasAudioWorklet,
  hasWebGPU,
  hasCryptoSubtle,
  detectCapabilities,
  resetCapabilityCache,
  chooseRoute,
  canDecodeVideo,
} from '../src/capabilities.js';
import { Demuxer } from '../src/demuxer.js';
import { MemoryDataSource, createProbeResult, createSample } from '../src/index.js';

test('Node 环境下探测不抛错且返回 false（§4：探测失败吞掉计 false）', () => {
  assert.equal(hasWebCodecs(), false);
  assert.equal(hasMSE(), false);
  assert.equal(hasAudioWorklet(), false);
  assert.equal(hasWebGPU(), false);
  assert.equal(typeof hasCryptoSubtle(), 'boolean'); // Node≥22 具备 crypto.subtle
});

test('detectCapabilities 契约形状（Node 全 false 路径）', async () => {
  resetCapabilityCache();
  const report = await detectCapabilities();
  assert.deepEqual(report.webcodecs, { supported: false, video: {}, audio: {} });
  assert.deepEqual(report.mse, { supported: false, mimeTypes: [] });
  assert.equal(report.audioWorklet, false);
  assert.equal(report.webgpu, false);
  assert.equal(report.secureContext, false);
  // 进程内缓存生效
  const again = await detectCapabilities();
  assert.equal(again, report);
});

test('chooseRoute：Node 无能力时恒 none', async () => {
  resetCapabilityCache();
  const caps = await detectCapabilities();
  const mi = {
    container: 'mp4',
    tracks: [{ id: 1, type: 'video', codec: 'avc1.42E01E' }],
    durationUs: 1000000,
    seekable: true,
    live: false,
  };
  assert.equal(chooseRoute(caps, mi), 'none');
  assert.equal(chooseRoute(null, null), 'none');
});

test('canDecodeVideo 在 Node 下返回 false', async () => {
  assert.equal(await canDecodeVideo({ codec: 'avc1.42E01E' }), false);
});

/* --------------------- Demuxer 基类契约（§2.2） --------------------- */

/** 用于验证基类契约的最小 demuxer */
class ToyDemuxer extends Demuxer {
  static probe(bytes) {
    if (bytes && bytes.length >= 4 && bytes[0] === 0x54 && bytes[1] === 0x4f) {
      return createProbeResult(1, /* container */ 'mp4'); // toy 用合法枚举占位
    }
    return null;
  }

  async _doOpen() {
    this.emit('toy:opened');
    return {
      container: 'mp4',
      tracks: [
        { id: 1, type: 'video', codec: 'avc1.42001E', timescale: 1000, durationUs: 300000 },
        { id: 2, type: 'audio', codec: 'mp4a.40.2', timescale: 8000, durationUs: 300000 },
      ],
      durationUs: 300000,
      seekable: true,
      live: false,
    };
  }

  _createTrackIterator(trackId) {
    const self = this;
    async function* gen() {
      const ids = trackId !== undefined ? [trackId] : [1, 2];
      for (const id of ids) {
        for (let i = 0; i < 3; i++) {
          yield createSample({
            trackId: id,
            codec: id === 1 ? 'avc1.42001E' : 'mp4a.40.2',
            timestamp: i * 100000,
            duration: 100000,
            keyframe: i === 0,
            data: await self.source.read(i * 4, 4),
            size: 4,
            index: i,
          });
        }
      }
    }
    return gen();
  }

  async _doSeek(timestampUs) {
    return { actualTimestampUs: Math.min(timestampUs, 200000) };
  }
}

test('probe 静态嗅探：命中 ProbeResult，未命中 null', () => {
  const bytes = new Uint8Array([0x54, 0x4f, 7, 7, ...new Array(12).fill(0)]);
  const hit = ToyDemuxer.probe(bytes);
  assert.ok(hit && hit.confidence === 1 && typeof hit.container === 'string');
  assert.ok(hit.confidence >= 0.8, '≥0.8 视为命中');
  assert.equal(Demuxer.probe(bytes), null, '基类默认未命中返回 null');
});

test('constructor 直入 source；open() 后属性可用并 emit media-info', async () => {
  const bytes = new Uint8Array([0x54, 0x4f, ...new Array(16).fill(7)]);
  let openedEvent = null;
  let legacyEvent = null;
  const d = new ToyDemuxer(new MemoryDataSource(bytes));
  d.on('media-info', (info) => (openedEvent = info));
  d.on('mediaInfo', (info) => (legacyEvent = info));

  const info = await d.open();
  assert.ok(openedEvent === info && legacyEvent === info, '双事件过渡期并存');
  assert.equal(d.state, 'ready');
  assert.equal(d.mediaInfo.tracks.length, 2);
  assert.equal(d.tracks.length, 2);
  assert.equal(d.metadata.container, 'mp4');
  assert.equal(d.metadata.durationUs, 300000);

  // 幂等：再次 open 返回同一 MediaInfo
  assert.equal(await d.open(), info);
});

test('readSample pull 主通道与 EOS null', async () => {
  const bytes = new Uint8Array([0x54, 0x4f, ...new Array(16).fill(7)]);
  const d = new ToyDemuxer(new MemoryDataSource(bytes));
  await d.open();

  const s0 = await d.readSample(1);
  assert.equal(s0.trackId, 1);
  assert.equal(s0.codec, 'avc1.42001E');
  assert.equal(s0.timestamp, 0);
  assert.equal(s0.duration, 100000);
  assert.equal(s0.keyframe, true);
  assert.deepEqual([...s0.data], [...bytes.subarray(0, 4)]);

  const s1 = await d.readSample(1);
  assert.equal(s1.timestamp, 100000);
  assert.equal(s1.keyframe, false);

  await d.readSample(1);
  assert.equal(await d.readSample(1), null, 'EOS 为 null');

  // samples() 糖层等价循环
  const all = [];
  for await (const s of d.samples(2)) all.push(s);
  assert.equal(all.length, 3);
});

test('seek(timestampUs) 返回实际落点', async () => {
  const d = new ToyDemuxer(new MemoryDataSource(new Uint8Array([0x54, 0x4f])));
  await d.open();
  const r = await d.seek(250000);
  assert.deepEqual(r, { actualTimestampUs: 200000 });
});

test('状态机：未 open 读样本 reject；销毁后一切调用抛 STATE_ERROR', async () => {
  const d = new ToyDemuxer(new MemoryDataSource(new Uint8Array([0x54, 0x4f])));
  await assert.rejects(() => d.readSample(1), (e) => e.code === 'STATE_ERROR');

  await d.open();
  await d.destroy();
  assert.equal(d.state, 'destroyed');
  await assert.rejects(() => d.readSample(1), (e) => e.code === 'STATE_ERROR');
  await assert.rejects(() => d.open(), (e) => e.code === 'STATE_ERROR');
});

test('destroy 幂等且触发 end(aborted)', async () => {
  const d = new ToyDemuxer(new MemoryDataSource(new Uint8Array([0x54, 0x4f])));
  await d.open();
  let endEvent = null;
  d.on('end', (e) => (endEvent = e));
  await d.destroy();
  await d.destroy(); // 幂等
  assert.deepEqual(endEvent, { reason: 'aborted' });
});
