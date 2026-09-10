/**
 * env 层 / 能力探测可测化（audit-79：env 层覆盖率短板）。
 *
 * 目标：凡是能在 Node 下用注入 Fake 覆盖的纯逻辑与分支都补测试。
 * 手法：临时把 WebCodecs / MSE / navigator 等全局挂在 globalThis 上，
 *       用 withGlobals() 统一 try/finally 还原，并在文件内断言全局已清干净。
 * 不覆盖：需要真实 VideoDecoder 实现语义、真实 MediaSource 生命周期的部分。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasWebCodecs,
  hasMSE,
  hasManagedMediaSource,
  hasAudioWorklet,
  hasWebGPU,
  hasCryptoSubtle,
  mseIsTypeSupportedSafe,
  detectCapabilities,
  resetCapabilityCache,
  canDecodeVideo,
  canDecodeAudio,
  chooseRoute,
  detectCapabilitiesLegacy,
} from '../src/capabilities.js';

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

/* ------------------------------ has* 同步快判 ------------------------------ */

test('hasWebCodecs：三家齐全才为 true，缺一即 false', async () => {
  assert.equal(hasWebCodecs(), false);
  await withGlobals(
    { VideoDecoder: class {}, AudioDecoder: class {}, EncodedVideoChunk: class {} },
    () => assert.equal(hasWebCodecs(), true),
  );
  await withGlobals(
    { VideoDecoder: class {}, AudioDecoder: class {} }, // 缺 EncodedVideoChunk
    () => assert.equal(hasWebCodecs(), false),
  );
  assert.equal(globalThis.VideoDecoder, undefined, 'Fake 已还原');
  assert.equal(globalThis.EncodedVideoChunk, undefined, 'Fake 已还原');
});

test('hasMSE / hasManagedMediaSource：按构造器存在性判定', async () => {
  assert.equal(hasMSE(), false);
  assert.equal(hasManagedMediaSource(), false);
  await withGlobals({ MediaSource: class {} }, () => {
    assert.equal(hasMSE(), true);
    assert.equal(hasManagedMediaSource(), false);
  });
  await withGlobals({ ManagedMediaSource: class {} }, () => {
    assert.equal(hasMSE(), false);
    assert.equal(hasManagedMediaSource(), true);
  });
  assert.equal(globalThis.MediaSource, undefined);
  assert.equal(globalThis.ManagedMediaSource, undefined);
});

test('hasAudioWorklet：只查原型属性存在性，不触发 getter（Chrome Illegal invocation 规避）', async () => {
  let getterTouched = false;
  class FakeAudioContext {}
  Object.defineProperty(FakeAudioContext.prototype, 'audioWorklet', {
    configurable: true,
    get() {
      getterTouched = true;
      throw new Error('原型 getter 不应被触碰');
    },
  });
  await withGlobals({ AudioContext: FakeAudioContext }, () => {
    assert.equal(hasAudioWorklet(), true);
    assert.equal(getterTouched, false, '用 in 探测不得触发 getter');
  });
  await withGlobals({ AudioContext: class {} }, () =>
    assert.equal(hasAudioWorklet(), false, '无 audioWorklet 原型属性为 false'),
  );
  assert.equal(globalThis.AudioContext, undefined);
});

test('hasWebGPU：仅查 navigator.gpu 存在性', async () => {
  await withGlobals({ navigator: {} }, () => assert.equal(hasWebGPU(), false));
  await withGlobals({ navigator: { gpu: {} } }, () => assert.equal(hasWebGPU(), true));
});

test('hasCryptoSubtle：具备 crypto.subtle.importKey 为 true，访问抛错吞为 false', async () => {
  assert.equal(hasCryptoSubtle(), true, 'Node≥22 具备 WebCrypto');
  await withGlobals({ crypto: {} }, () =>
    assert.equal(hasCryptoSubtle(), false, '无 subtle 计 false'),
  );
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    get() {
      throw new Error('crypto accessor 抛错');
    },
  });
  try {
    assert.equal(hasCryptoSubtle(), false, '访问异常一律吞掉计 false');
  } finally {
    Object.defineProperty(globalThis, 'crypto', desc);
  }
});

test('mseIsTypeSupportedSafe：环境无 MediaSource 时安全返回 false', () => {
  assert.equal(mseIsTypeSupportedSafe('video/mp4; codecs="avc1.42E01E"'), false);
});

/* ------------------------------ WebCodecs 深探测 ------------------------------ */

class FakeVideoDecoder {
  static async isConfigSupported(config) {
    if (config.codec === 'boom') throw new Error('探测抛错');
    if (config.codec === 'undef') return undefined;
    return { supported: config.codec !== 'no' };
  }
}
class FakeAudioDecoder {
  static async isConfigSupported(config) {
    if (config.codec === 'aboom') throw new Error('探测抛错');
    return { supported: !config.codec.startsWith('a-no') };
  }
}

test('detectCapabilities：WebCodecs 支持路径逐 codec 深探测，异常/undefined 计 false', async () => {
  await withGlobals(
    {
      VideoDecoder: FakeVideoDecoder,
      AudioDecoder: FakeAudioDecoder,
      EncodedVideoChunk: class {},
    },
    async () => {
      resetCapabilityCache();
      const report = await detectCapabilities({
        deep: true,
        videoCodecs: ['ok', 'no', 'boom', 'undef'],
        audioCodecs: ['a-ok', 'a-no-x', 'aboom'],
      });
      assert.equal(report.webcodecs.supported, true);
      assert.deepEqual(report.webcodecs.video, {
        ok: true,
        no: false,
        boom: false,
        undef: false,
      });
      assert.deepEqual(report.webcodecs.audio, { 'a-ok': true, 'a-no-x': false, aboom: false });
      assert.equal(report.mse.supported, false);
      assert.deepEqual(report.mse.mimeTypes, []);
    },
  );
});

test('detectCapabilities：MSE 支持路径按 isTypeSupported 命中收集 mimeTypes', async () => {
  class FakeMediaSource {
    static isTypeSupported(mime) {
      return mime.includes('avc1');
    }
  }
  await withGlobals({ MediaSource: FakeMediaSource }, async () => {
    resetCapabilityCache();
    const report = await detectCapabilities({ deep: true });
    assert.equal(report.mse.supported, true);
    assert.ok(report.mse.mimeTypes.length > 0, '至少命中一条 avc1 组合');
    assert.ok(
      report.mse.mimeTypes.every((m) => m.includes('avc1')),
      '仅收录 isTypeSupported=true 的组合',
    );
  });
});

test('detectCapabilities：非 deep 结果进程内缓存，deep 绕过缓存', async () => {
  resetCapabilityCache();
  const first = await detectCapabilities();
  const second = await detectCapabilities();
  assert.equal(first, second, '同 key 非 deep 命中缓存返回同一对象');
  const deep = await detectCapabilities({ deep: true });
  assert.notEqual(deep, first, 'deep 不读写缓存');
  resetCapabilityCache();
  const afterReset = await detectCapabilities();
  assert.notEqual(afterReset, first, 'resetCapabilityCache 后重新探测');
  assert.deepEqual(afterReset.webcodecs, first.webcodecs);
});

test('detectCapabilities：secureContext 与 audioWorklet/webgpu 反映注入环境', async () => {
  class FakeAudioContext {}
  FakeAudioContext.prototype.audioWorklet = {};
  await withGlobals(
    { isSecureContext: true, AudioContext: FakeAudioContext, navigator: { gpu: {} } },
    async () => {
      resetCapabilityCache();
      const report = await detectCapabilities({ deep: true });
      assert.equal(report.secureContext, true);
      assert.equal(report.audioWorklet, true);
      assert.equal(report.webgpu, true);
    },
  );
  assert.equal(globalThis.isSecureContext, undefined, 'Fake 已还原');
});

test('canDecodeVideo / canDecodeAudio：无 WebCodecs 直接 false；异常与空结果计 false', async () => {
  assert.equal(await canDecodeVideo({ codec: 'ok' }), false);
  assert.equal(await canDecodeAudio({ codec: 'a-ok' }), false);
  await withGlobals(
    { VideoDecoder: FakeVideoDecoder, AudioDecoder: FakeAudioDecoder, EncodedVideoChunk: class {} },
    async () => {
      assert.equal(await canDecodeVideo({ codec: 'ok' }), true);
      assert.equal(await canDecodeVideo({ codec: 'no' }), false);
      assert.equal(await canDecodeVideo({ codec: 'boom' }), false);
      assert.equal(await canDecodeVideo({ codec: 'undef' }), false);
      assert.equal(await canDecodeAudio({ codec: 'a-ok' }), true);
      assert.equal(await canDecodeAudio({ codec: 'a-no-x' }), false);
    },
  );
});

/* ------------------------------ chooseRoute 分支覆盖 ------------------------------ */

const mp4Info = (tracks) => ({
  container: 'mp4',
  durationUs: 1000,
  seekable: true,
  live: false,
  tracks,
});

test('chooseRoute：入参缺失/非法一律 none；裁决内部异常也吞为 none', () => {
  assert.equal(chooseRoute(null, null), 'none');
  assert.equal(chooseRoute({}, { container: 'mp4', tracks: 'nope' }), 'none');
  const throwing = {
    get webcodecs() {
      throw new Error('caps 结构损坏');
    },
  };
  assert.equal(chooseRoute(throwing, mp4Info([])), 'none', 'try/catch 兜底');
});

test('chooseRoute：metadata 轨不参与解码，text 轨走 Cue 流不影响 WC 判定', () => {
  const caps = {
    webcodecs: { supported: true, video: {}, audio: {} },
    mse: { supported: false, mimeTypes: [] },
  };
  // 仅 metadata：无实际解码轨 → anyTrack=false → WC 不可用
  assert.equal(chooseRoute(caps, mp4Info([{ id: 0, type: 'metadata', codec: '' }])), 'none');
  // metadata + text：text 不计失败，anyTrack=true → WC 可用
  assert.equal(
    chooseRoute(caps, mp4Info([
      { id: 0, type: 'metadata', codec: '' },
      { id: 3, type: 'text', codec: 'x-srt' },
    ])),
    'webcodecs',
  );
});

test('chooseRoute：任一视频/音频轨 codec 未命中即放弃 WebCodecs', () => {
  const caps = {
    webcodecs: { supported: true, video: { v1: true }, audio: { a1: true } },
    mse: { supported: false, mimeTypes: [] },
  };
  assert.equal(
    chooseRoute(caps, mp4Info([
      { id: 1, type: 'video', codec: 'v1' },
      { id: 2, type: 'audio', codec: 'a1' },
    ])),
    'webcodecs',
  );
  assert.equal(
    chooseRoute(caps, mp4Info([
      { id: 1, type: 'video', codec: 'v1' },
      { id: 2, type: 'audio', codec: 'missing' },
    ])),
    'none',
    '木桶效应：任一轨不支持即整体回落',
  );
});

test('chooseRoute：未知轨类型不计入 WC 失败（else 分支）', () => {
  const caps = {
    webcodecs: { supported: true, video: {}, audio: {} },
    mse: { supported: false, mimeTypes: [] },
  };
  assert.equal(
    chooseRoute(caps, mp4Info([{ id: 9, type: 'data', codec: 'x' }])),
    'webcodecs',
  );
});

test('chooseRoute：MSE 仅在可 remux 容器（mp4/mov/flv）上可用，其余回落 none', () => {
  const mseCaps = {
    webcodecs: { supported: false, video: {}, audio: {} },
    mse: { supported: true, mimeTypes: ['video/mp4; codecs="avc1.42E01E"'] },
  };
  const track = [{ id: 1, type: 'video', codec: 'avc1.42E01E' }];
  assert.equal(chooseRoute(mseCaps, { ...mp4Info(track), container: 'mp4' }), 'mse');
  assert.equal(chooseRoute(mseCaps, { ...mp4Info(track), container: 'mov' }), 'mse');
  assert.equal(chooseRoute(mseCaps, { ...mp4Info(track), container: 'flv' }), 'mse');
  assert.equal(chooseRoute(mseCaps, { ...mp4Info(track), container: 'mkv' }), 'none');
});

test('chooseRoute：无可解码 codec 的可 remux 容器直接采信 MSE（codecs.length===0 分支）', () => {
  const caps = {
    webcodecs: { supported: false, video: {}, audio: {} },
    mse: { supported: true, mimeTypes: [] },
  };
  // 仅字幕轨：无 video/audio codec，容器可 remux → 直接 true
  assert.equal(
    chooseRoute(caps, mp4Info([{ id: 3, type: 'text', codec: 'x-srt' }])),
    'mse',
  );
});

test('chooseRoute：深探测未命中时回落实时 mseIsTypeSupported；Node 无 MediaSource 则 none', () => {
  const caps = {
    webcodecs: { supported: false, video: {}, audio: {} },
    mse: { supported: true, mimeTypes: ['video/mp4; codecs="OTHER"'] }, // 清单不含目标组合
  };
  const info = mp4Info([{ id: 1, type: 'video', codec: 'avc1.42E01E' }]);
  assert.equal(chooseRoute(caps, info), 'none', '探测清单未命中 + 无 MediaSource → none');
});

test('chooseRoute：preference 列表内的未知路线被安全跳过', () => {
  const caps = {
    webcodecs: { supported: true, video: { v1: true }, audio: {} },
    mse: { supported: false, mimeTypes: [] },
  };
  const info = mp4Info([{ id: 1, type: 'video', codec: 'v1' }]);
  assert.equal(chooseRoute(caps, info, { preference: ['bogus'] }), 'none');
  assert.equal(chooseRoute(caps, info, { preference: ['bogus', 'webcodecs'] }), 'webcodecs');
  assert.equal(chooseRoute(caps, info, { preference: 'not-an-array' }), 'webcodecs', '非法 preference 回落默认');
});

/* ------------------------------ 过渡期兼容：detectCapabilitiesLegacy ------------------------------ */

test('detectCapabilitiesLegacy：WC 命中 → pipeline=webcodecs，managed/combo 反映环境', async () => {
  class FakeMediaSource {
    static isTypeSupported(mime) {
      return mime.includes('avc1.42E01E');
    }
  }
  await withGlobals(
    {
      VideoDecoder: FakeVideoDecoder,
      AudioDecoder: FakeAudioDecoder,
      EncodedVideoChunk: class {},
      MediaSource: FakeMediaSource,
      ManagedMediaSource: class {},
    },
    async () => {
      resetCapabilityCache();
      const legacy = await detectCapabilitiesLegacy({ deep: true, videoCodecs: ['ok'], audioCodecs: ['a-ok'] });
      assert.equal(legacy.webcodecs.available, true);
      assert.equal(legacy.webcodecs.video, true);
      assert.equal(legacy.webcodecs.audio, true);
      assert.equal(legacy.mse.available, true);
      assert.equal(legacy.mse.managed, true);
      assert.equal(legacy.mse.combo, true);
      assert.equal(legacy.pipeline, 'webcodecs');
    },
  );
});

test('detectCapabilitiesLegacy：仅 MSE 可用 → pipeline=mse；全不可用 → none', async () => {
  await withGlobals({ MediaSource: class {} }, async () => {
    resetCapabilityCache();
    const legacy = await detectCapabilitiesLegacy({ deep: true });
    assert.equal(legacy.webcodecs.available, false);
    assert.equal(legacy.mse.available, true);
    assert.equal(legacy.mse.managed, false);
    assert.equal(legacy.mse.combo, false);
    assert.equal(legacy.pipeline, 'mse');
  });
  resetCapabilityCache();
  const none = await detectCapabilitiesLegacy({ deep: true });
  assert.equal(none.pipeline, 'none');
});

/* ------------------------------ 全局清洁断言 ------------------------------ */

test('全部探测假全局在本文件内均已还原（不污染后续测试）', () => {
  for (const key of ['VideoDecoder', 'AudioDecoder', 'EncodedVideoChunk', 'MediaSource', 'ManagedMediaSource', 'AudioContext']) {
    assert.equal(globalThis[key], undefined, `${key} 应已还原为 undefined`);
  }
});
