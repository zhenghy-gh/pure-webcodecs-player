/**
 * cmaf/__tests__/cmaf-webcodecs-env.test.js — CMAF WebCodecs 直解路线可测化（env 层）
 * ------------------------------------------------------------
 * hasWebCodecs/CmafWebCodecsPlayer 主路径在 Node 下不可达，用 Fake globalThis
 * （withGlobals try/finally 还原）注入 VideoDecoder/AudioDecoder/EncodedVideoChunk
 * 与 window 载体，覆盖 open 配置推导、isConfigSupported 拒绝、appendChunk
 * 分轨分发与 µs 边界换算、decode 抛错隔离、close flush/幂等。
 * fixture 复用 hls fMP4 构造器程序化生成（零外网）。
 * 不覆盖：真实浏览器解码语义。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { _internalForTest as fmp4 } from '../../hls/src/fmp4-muxer.js';
import { splitChunks } from '../src/chunk-parser.js';
import {
  CmafWebCodecsPlayer,
  codecStringFromAvcC,
} from '../src/webcodecs.js';

/* ---------------- fixture（与 cmaf-parse.test.js 同源） ---------------- */

const FAKE_AVC_C = new Uint8Array([
  0x01, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x08, 0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9, 0x40, 0x50,
  0x01, 0x00, 0x04, 0x68, 0xeb, 0xec, 0xb2,
]);
const ASC = new Uint8Array([0x12, 0x10]); // AOT=2(LC) 44.1kHz 双声道

function makeVideoTrak(extra = {}) {
  return {
    id: 1,
    type: 'video',
    codec: 'avc1.64001f',
    description: { tag: 'avcC', bytes: FAKE_AVC_C },
    width: 640,
    height: 360,
    timescale: 90000,
    ...extra,
  };
}
function makeAudioTrak(extra = {}) {
  return {
    id: 2,
    type: 'audio',
    codec: 'mp4a.40.2',
    description: { tag: 'esds', bytes: ASC },
    sampleRate: 44100,
    channels: 2,
    timescale: 44100,
    ...extra,
  };
}
function makeVideoFrames(baseDts, count) {
  const frames = [];
  for (let i = 0; i < count; i++) {
    frames.push({
      dts: baseDts + i * 3003,
      pts: baseDts + i * 3003,
      duration: 3003,
      keyframe: i === 0,
      data: new Uint8Array(48 + i).fill(i + 1),
    });
  }
  return frames;
}
/** init（视频+音频双轨）+ 一个含 3 视频帧的 chunk 的完整缓冲 */
function buildAvStream() {
  const init = fmp4.buildInit([makeVideoTrak(), makeAudioTrak()]);
  const frag = fmp4.buildFragment({ trackId: 1, samples: makeVideoFrames(0, 3), hasCts: true });
  const buf = new Uint8Array(init.length + frag.length);
  buf.set(init, 0);
  buf.set(frag, init.length);
  return { init, buf, chunkStart: init.length };
}
/** 纯音频 chunk 流（init 前缀 + trackId=2 分片） */
function buildAudioStream() {
  const init = fmp4.buildInit([makeAudioTrak()]);
  const frag = fmp4.buildFragment({ trackId: 2, samples: makeVideoFrames(0, 2), hasCts: false });
  const buf = new Uint8Array(init.length + frag.length);
  buf.set(init, 0);
  buf.set(frag, init.length);
  return { init, buf };
}

/* ---------------- Fake WebCodecs ---------------- */

/** 临时改写 globalThis 若干属性，执行 fn（支持 async）后原样还原 */
async function withGlobals(patch, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(patch)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  try {
    return await fn();
  } finally {
    for (const [key, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete globalThis[key];
    }
  }
}

function makeFakes() {
  const env = { videoSupported: true, audioSupported: true, audioConfigureThrows: false };
  const videoDecoders = [];
  const audioDecoders = [];
  const chunks = [];

  class FakeEncodedVideoChunk {
    constructor(opts) {
      this.type = opts.type;
      this.timestamp = opts.timestamp;
      this.duration = opts.duration;
      this.byteLength = opts.data?.byteLength ?? 0;
      chunks.push(this);
    }
  }
  class FakeEncodedAudioChunk {
    constructor(opts) { Object.assign(this, opts); }
  }

  class FakeVideoDecoder {
    constructor({ output, error }) {
      this.output = output;
      this.errorCb = error;
      this.state = 'unconfigured';
      this.config = null;
      this.decoded = [];
      this.flushes = 0;
      this.closed = 0;
      videoDecoders.push(this);
    }
    static async isConfigSupported(cfg) {
      return { supported: env.videoSupported, config: cfg };
    }
    configure(cfg) { this.state = 'configured'; this.config = cfg; }
    decode(chunk) {
      if (this.state === 'closed') throw new Error('decode on closed decoder');
      this.decoded.push(chunk);
    }
    async flush() { this.flushes++; }
    close() { this.closed++; this.state = 'closed'; }
  }

  class FakeAudioDecoder {
    constructor({ output, error }) {
      this.output = output;
      this.errorCb = error;
      this.state = 'unconfigured';
      this.config = null;
      this.decoded = [];
      this.flushes = 0;
      this.closed = 0;
      audioDecoders.push(this);
    }
    static async isConfigSupported(cfg) {
      return { supported: env.audioSupported, config: cfg };
    }
    configure(cfg) {
      if (env.audioConfigureThrows) throw new Error('audio configure failed');
      this.state = 'configured';
      this.config = cfg;
    }
    decode(chunk) {
      if (this.state === 'closed') throw new Error('decode on closed decoder');
      this.decoded.push(chunk);
    }
    async flush() { this.flushes++; }
    close() { this.closed++; this.state = 'closed'; }
  }

  const fakeWindow = {
    VideoDecoder: FakeVideoDecoder,
    AudioDecoder: FakeAudioDecoder,
    EncodedVideoChunk: FakeEncodedVideoChunk,
    EncodedAudioChunk: FakeEncodedAudioChunk,
  };
  return { env, videoDecoders, audioDecoders, chunks, fakeWindow, FakeVideoDecoder, FakeAudioDecoder, FakeEncodedVideoChunk, FakeEncodedAudioChunk };
}

async function withWebCodecs(fn) {
  const fakes = makeFakes();
  return withGlobals({
    window: fakes.fakeWindow,
    VideoDecoder: fakes.FakeVideoDecoder,
    AudioDecoder: fakes.FakeAudioDecoder,
    EncodedVideoChunk: fakes.FakeEncodedVideoChunk,
    EncodedAudioChunk: fakes.FakeEncodedAudioChunk,
  }, () => fn(fakes));
}

/* ---------------- codec 串推导（纯函数补充面） ---------------- */

test('codecStringFromAvcC 边界：null/过短返回 null（禁止编造 profile）', () => {
  assert.equal(codecStringFromAvcC(null), null);
  assert.equal(codecStringFromAvcC(new Uint8Array([1, 2, 3])), null);
  assert.equal(codecStringFromAvcC(FAKE_AVC_C), 'avc1.64001f');
});

/* ---------------- CmafWebCodecsPlayer 调度路径 ---------------- */

describe('CmafWebCodecsPlayer（Fake WebCodecs）', () => {
  test('纯音频环境只需 AudioDecoder + EncodedAudioChunk', async () => {
    const fakes = makeFakes();
    await withGlobals({
      window: { AudioDecoder: fakes.FakeAudioDecoder, EncodedAudioChunk: fakes.FakeEncodedAudioChunk },
      AudioDecoder: fakes.FakeAudioDecoder,
      EncodedAudioChunk: fakes.FakeEncodedAudioChunk,
    }, async () => {
      const { init } = buildAudioStream();
      const player = new CmafWebCodecsPlayer();
      await player.open(init);
      assert.equal(player.videoDecoder, null);
      assert.ok(player.audioDecoder);
    });
  });

  test('双轨 init 缺少 AudioDecoder 时在部分建 decoder 前拒绝', async () => {
    const fakes = makeFakes();
    await withGlobals({
      window: { VideoDecoder: fakes.FakeVideoDecoder, EncodedVideoChunk: fakes.FakeEncodedVideoChunk },
      VideoDecoder: fakes.FakeVideoDecoder,
      EncodedVideoChunk: fakes.FakeEncodedVideoChunk,
    }, async () => {
      const player = new CmafWebCodecsPlayer();
      await assert.rejects(() => player.open(buildAvStream().init), (e) => e.code === 'NOT_SUPPORTED');
      assert.equal(player.videoDecoder, null, 'missing audio APIs must not leave a partial video decoder');
    });
  });

  test('open：双轨配置推导、configure、timescale 落位；返回结构与 ASC 推导', async () => {
    await withWebCodecs(async (fakes) => {
      const { init } = buildAvStream();
      const p = new CmafWebCodecsPlayer();
      const cfg = await p.open(init);

      assert.equal(cfg.video.codec, 'avc1.64001f');
      assert.equal(cfg.video.optimizeForLatency, true);
      assert.ok(cfg.video.description instanceof Uint8Array);
      assert.equal(cfg.audio.codec, 'mp4a.40.2');
      assert.equal(cfg.audio.sampleRate, 44100, 'ASC 索引 4 → 44100');
      assert.equal(cfg.audio.numberOfChannels, 2);
      assert.deepEqual(cfg.videoTrack, { trackId: 1, timescale: 90000 });
      assert.deepEqual(cfg.audioTrack, { trackId: 2, timescale: 44100 });

      const vd = fakes.videoDecoders[0];
      const ad = fakes.audioDecoders[0];
      assert.equal(vd.state, 'configured');
      assert.equal(vd.config.codec, 'avc1.64001f');
      assert.equal(ad.config.sampleRate, 44100);
      assert.equal(p.videoTimescale, 90000);
      assert.equal(p.audioTimescale, 44100);
    });
  });

  test('open：音频 config 不支持时不创建双轨 decoder', async () => {
    await withWebCodecs(async (fakes) => {
      fakes.env.audioSupported = false;
      const player = new CmafWebCodecsPlayer();
      await assert.rejects(() => player.open(buildAvStream().init), (err) => err.code === 'NOT_SUPPORTED' && err.message.includes('mp4a.40.2'));
      assert.equal(fakes.videoDecoders.length, 0, 'audio preflight precedes video decoder construction');
      assert.equal(fakes.audioDecoders.length, 0);
      assert.equal(player.videoDecoder, null);
      assert.equal(player.audioDecoder, null);
    });
  });

  test('open：configure 半途失败时关闭所有临时 decoder 且不挂接到 player', async () => {
    await withWebCodecs(async (fakes) => {
      fakes.env.audioConfigureThrows = true;
      const player = new CmafWebCodecsPlayer();
      await assert.rejects(() => player.open(buildAvStream().init), /audio configure failed/);
      assert.equal(fakes.videoDecoders.length, 1);
      assert.equal(fakes.videoDecoders[0].closed, 1, 'configure failure releases video decoder');
      assert.equal(fakes.audioDecoders.length, 1);
      assert.equal(fakes.audioDecoders[0].closed, 1, 'configure failure releases audio decoder');
      assert.equal(player.videoDecoder, null);
      assert.equal(player.audioDecoder, null);
    });
  });

  test('open：isConfigSupported 拒绝视频配置 → NOT_SUPPORTED 且不建解码器', async () => {
    await withWebCodecs(async (fakes) => {
      fakes.env.videoSupported = false;
      const { init } = buildAvStream();
      const p = new CmafWebCodecsPlayer();
      await assert.rejects(
        () => p.open(init),
        (e) => e.code === 'NOT_SUPPORTED' && e.message.includes('avc1.64001f'),
      );
      assert.equal(p.videoDecoder, null);
      assert.equal(fakes.videoDecoders.length, 0, '拒绝路径不实例化解码器');
    });
  });

  test('open：成功重开时只在新 decoder 配置完成后替换并释放旧 decoder', async () => {
    await withWebCodecs(async (fakes) => {
      const player = new CmafWebCodecsPlayer();
      await player.open(fmp4.buildInit([makeVideoTrak()]));
      const oldDecoder = player.videoDecoder;
      await player.open(fmp4.buildInit([makeVideoTrak({ id: 7 })]));
      assert.equal(oldDecoder.flushes, 1);
      assert.equal(oldDecoder.closed, 1);
      assert.equal(player.videoTrackId, 7);
      const sample = { durationTicks: 1, size: 1, keyframe: true, dtsOffset: 0, dataStart: 0 };
      player.appendChunk({ tracks: [{ trackId: 1, samples: [sample] }] }, new Uint8Array([1]));
      assert.equal(fakes.videoDecoders[0].decoded.length, 0, '旧 track_ID 必须失效');
      player.appendChunk({ tracks: [{ trackId: 7, samples: [sample] }] }, new Uint8Array([1]));
      assert.equal(fakes.videoDecoders[1].decoded.length, 1, '新 track_ID 应关联新 decoder');
    });
  });

  test('open：新配置预检失败时保留仍可用的旧 decoder', async () => {
    await withWebCodecs(async (fakes) => {
      const player = new CmafWebCodecsPlayer();
      await player.open(fmp4.buildInit([makeVideoTrak()]));
      const oldDecoder = player.videoDecoder;
      fakes.env.audioSupported = false;
      await assert.rejects(
        () => player.open(fmp4.buildInit([makeVideoTrak({ id: 7 }), makeAudioTrak()])),
        (err) => err.code === 'NOT_SUPPORTED',
      );
      assert.equal(player.videoDecoder, oldDecoder);
      assert.equal(oldDecoder.closed, 0, 'preflight 不应销毁仍有效的旧 decoder');
      assert.equal(player.videoTrackId, 1);
    });
  });

  test('appendChunk：视频轨分发到 VideoDecoder，key/delta 与 µs 边界换算', async () => {
    await withWebCodecs(async (fakes) => {
      const { init, buf, chunkStart } = buildAvStream();
      const p = new CmafWebCodecsPlayer();
      await p.open(init);

      const { chunks } = splitChunks(buf.subarray(chunkStart));
      const chunk = chunks[0];
      p.appendChunk(chunk, buf.subarray(chunkStart));

      const vd = fakes.videoDecoders[0];
      assert.equal(vd.decoded.length, 3, '3 个样本全部进解码器');
      assert.equal(fakes.chunks.length, 3);
      const first = fakes.chunks[0];
      assert.equal(first.type, 'key', '首帧关键帧');
      assert.equal(fakes.chunks[1].type, 'delta');
      // dtsOffset 0/3003/6006 ticks @90000 → 0/33367/66733 µs
      assert.equal(first.timestamp, 0);
      assert.equal(fakes.chunks[1].timestamp, Math.round((3003 / 90000) * 1e6));
      assert.equal(fakes.chunks[2].timestamp, Math.round((6006 / 90000) * 1e6));
      assert.equal(first.duration, Math.round((3003 / 90000) * 1e6));
      // 样本数据从 mdat 切片：data 传给 EncodedVideoChunk（fake 里记录 byteLength）
      assert.ok(first.byteLength > 0);
      void vd;
    });
  });

  test('appendChunk：使用 init 中的 track_ID 路由非 1/2 的音视频轨，忽略未知轨', async () => {
    await withWebCodecs(async (fakes) => {
      const init = fmp4.buildInit([makeVideoTrak({ id: 7 }), makeAudioTrak({ id: 9 })]);
      const videoFrag = fmp4.buildFragment({ trackId: 7, samples: makeVideoFrames(0, 3), hasCts: true });
      const audioFrag = fmp4.buildAudioFragment(9, 44100, makeVideoFrames(0, 2));
      const payload = fmp4.concat([videoFrag, audioFrag]);
      const player = new CmafWebCodecsPlayer();
      const cfg = await player.open(init);
      assert.equal(cfg.videoTrack.trackId, 7);
      assert.equal(cfg.audioTrack.trackId, 9);
      const chunks = splitChunks(payload).chunks;
      player.appendChunk(chunks[0], payload);
      player.appendChunk(chunks[1], payload);
      assert.equal(fakes.videoDecoders[0].decoded.length, 3);
      assert.equal(fakes.audioDecoders[0].decoded.length, 2);
      assert.ok(fakes.videoDecoders[0].decoded[0] instanceof fakes.FakeEncodedVideoChunk);
      assert.ok(fakes.audioDecoders[0].decoded[0] instanceof fakes.FakeEncodedAudioChunk);
      player.appendChunk({ tracks: [{ trackId: 1, samples: [{ durationTicks: 1, size: 1, keyframe: true, dtsOffset: 0, dataStart: 0 }] }] }, payload);
      assert.equal(fakes.videoDecoders[0].decoded.length, 3, 'trackId=1 不得误投到已配置 video track');
      assert.equal(fakes.audioDecoders[0].decoded.length, 2, '未知轨不得回退投递到 audio decoder');
    });
  });

  test('appendChunk：按 init 中的音频 track_ID 解码且忽略未知轨', async () => {
    await withWebCodecs(async (fakes) => {
      const { init, buf } = buildAudioStream();
      const p = new CmafWebCodecsPlayer();
      await p.open(init);
      assert.equal(p.videoDecoder, null, '纯音频 init 不建视频解码器');

      const { chunks } = splitChunks(buf.subarray(init.length));
      p.appendChunk(chunks[0], buf.subarray(init.length));
      const ad = fakes.audioDecoders[0];
      assert.equal(ad.decoded.length, 2, '音频轨 2 样本进 AudioDecoder');
      assert.ok(ad.decoded[0] instanceof fakes.FakeEncodedAudioChunk, '音频 decoder 必须收到 EncodedAudioChunk');
      assert.equal(ad.decoded[0].type, 'key');
      assert.equal(ad.decoded[0].duration, Math.round((3003 / 44100) * 1e6), '音频 timescale 44100 换算');

      // 不匹配 init track_ID 的轨道不能回退误投到音频 decoder。
      const ad2 = fakes.audioDecoders[0];
      p.appendChunk({ tracks: [{ trackId: 9, samples: [{ durationTicks: 1, size: 1, keyframe: true, dtsOffset: 0, dataStart: 0 }] }] }, buf);
      assert.equal(ad2.decoded.length, 2, '未知轨应被忽略');
    });
  });

  test('decode 抛错被隔离：onError 逐样本上报且不中断后续样本', async () => {
    await withWebCodecs(async (fakes) => {
      const { init, buf, chunkStart } = buildAvStream();
      const errors = [];
      const p = new CmafWebCodecsPlayer({ onError: (e) => errors.push(e) });
      await p.open(init);
      const vd = fakes.videoDecoders[0];
      vd.decode = () => { throw new Error('boom'); };

      const { chunks } = splitChunks(buf.subarray(chunkStart));
      p.appendChunk(chunks[0], buf.subarray(chunkStart));
      assert.equal(errors.length, 3, '每样本错误都上报');
      assert.equal(errors[0].message, 'boom');
    });
  });

  test('close：flush→close 双解码器并清引用；closed 态跳过；无解码器安全；decode-on-closed 防御', async () => {
    await withWebCodecs(async (fakes) => {
      const p = new CmafWebCodecsPlayer();
      await p.close(); // 无解码器安全
      assert.equal(p.videoDecoder, null);

      const { init } = buildAvStream();
      await p.open(init);
      const vd = fakes.videoDecoders[0];
      const ad = fakes.audioDecoders[0];
      await p.close();
      assert.equal(vd.flushes, 1);
      assert.equal(vd.closed, 1);
      assert.equal(ad.flushes, 1);
      assert.equal(ad.closed, 1);
      assert.equal(p.videoDecoder, null);
      assert.equal(p.audioDecoder, null);

      // state==='closed' 的解码器：跳过 flush/close 但引用仍被清
      await p.open(init);
      const vd2 = fakes.videoDecoders[1];
      vd2.state = 'closed';
      await p.close();
      assert.equal(vd2.flushes, 0);
      assert.equal(vd2.closed, 0);
      assert.equal(p.videoDecoder, null);
    });
  });

  test('output/error 回调连线：flush 后 output 收到样本、error 经 onError 上报', async () => {
    await withWebCodecs(async (fakes) => {
      const frames = [];
      const audio = [];
      const errors = [];
      const p = new CmafWebCodecsPlayer({
        onVideoFrame: (f) => frames.push(f),
        onAudioData: (a) => audio.push(a),
        onError: (e) => errors.push(e),
      });
      const { init, buf, chunkStart } = buildAvStream();
      await p.open(init);

      const vd = fakes.videoDecoders[0];
      const ad = fakes.audioDecoders[0];
      vd.decode = () => vd.output({ marker: 'frame' });
      ad.decode = () => ad.output({ marker: 'audio' });

      const { chunks } = splitChunks(buf.subarray(chunkStart));
      p.appendChunk(chunks[0], buf.subarray(chunkStart));
      assert.deepEqual(frames, [{ marker: 'frame' }, { marker: 'frame' }, { marker: 'frame' }]);
      assert.equal(audio.length, 0, '本 chunk 只含视频轨');

      // error 回调在构造时即与 onError 连线：解码器触发即上报
      ad.errorCb(new Error('ad-err'));
      assert.equal(errors.length, 1);
      assert.equal(errors[0].message, 'ad-err');
    });
  });
});
