/**
 * 能力探测（CONTRACTS v0.2 §4 定稿）。
 *
 * 原则：
 * - 同步快判 has* 系列：Node 下 WebCodecs/MSE/AudioWorklet/WebGPU 恒 false；
 * - 探测失败一律吞掉计 false，绝不向上抛；
 * - detectCapabilities 深探测结果进程内缓存；
 * - chooseRoute 依 §6 规则给出 'webcodecs' | 'mse' | 'none'。
 */
import { buildMseMimeType, mseIsTypeSupported } from './codec-string.js';

/** 是否存在 WebCodecs 全家桶 */
export function hasWebCodecs() {
  return (
    typeof VideoDecoder === 'function' &&
    typeof AudioDecoder === 'function' &&
    typeof EncodedVideoChunk === 'function'
  );
}

/** 是否存在 MediaSource */
export function hasMSE() {
  return typeof MediaSource === 'function';
}

/** iOS 17+ 的 ManagedMediaSource（后台播放更友好） */
export function hasManagedMediaSource() {
  return typeof ManagedMediaSource === 'function';
}

/** AudioContext.audioWorklet 是否可用 */
export function hasAudioWorklet() {
  // 注意：audioWorklet 是原型上的 accessor getter，直接读 prototype.audioWorklet 时
  // this=prototype（非合法实例）会在 Chrome 抛 Illegal invocation；用 `in` 只查属性
  // 存在性、不触发 getter（真实缺陷由浏览器端到端验收暴露）。
  return (
    typeof AudioContext === 'function' &&
    'audioWorklet' in AudioContext.prototype
  );
}

/** 仅查 navigator.gpu 存在性（§4） */
export function hasWebGPU() {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

/** 查 crypto.subtle 存在性（Node≥22 与现代浏览器均具备；hls AES-128 依赖） */
export function hasCryptoSubtle() {
  try {
    return typeof globalThis.crypto?.subtle?.importKey === 'function';
  } catch {
    return false;
  }
}

/** 安全包装 MediaSource.isTypeSupported：环境不支持时返回 false */
export function mseIsTypeSupportedSafe(mime) {
  return mseIsTypeSupported(mime);
}

/** WebCodecs 深度探测默认 codec 清单（chooseRoute 裁决 + demo 展示用；可并入媒体实际 codec 追加探测） */
export const DEFAULT_VIDEO_CODECS = ['avc1.42E01E', 'avc1.640028', 'hvc1.1.6.L93.B0', 'vp09.00.10.08'];
export const DEFAULT_AUDIO_CODECS = ['mp4a.40.2', 'mp3', 'opus', 'flac'];

/**
 * 深探测（真实走 isConfigSupported / isTypeSupported），结果进程内缓存。
 * @param {{deep?: boolean, videoCodecs?: string[], audioCodecs?: string[]}} [options]
 * @returns {Promise<{
 *   webcodecs: {supported: boolean, video: Record<string, boolean>, audio: Record<string, boolean>},
 *   mse: {supported: boolean, mimeTypes: string[]},
 *   audioWorklet: boolean,
 *   webgpu: boolean,
 *   cryptoSubtle: boolean,
 *   secureContext: boolean,
 * }>}
 */
export async function detectCapabilities(options = {}) {
  const key = JSON.stringify(options);
  if (!options.deep && detectCapabilities._cache.has(key)) {
    return detectCapabilities._cache.get(key);
  }

  const videoCodecs = options.videoCodecs ?? DEFAULT_VIDEO_CODECS;
  const audioCodecs = options.audioCodecs ?? DEFAULT_AUDIO_CODECS;

  const report = {
    webcodecs: {
      supported: hasWebCodecs(),
      video: {},
      audio: {},
    },
    mse: {
      supported: hasMSE(),
      mimeTypes: [],
    },
    audioWorklet: hasAudioWorklet(),
    webgpu: hasWebGPU(),
    cryptoSubtle: hasCryptoSubtle(),
    secureContext:
      typeof globalThis.isSecureContext === 'boolean' ? globalThis.isSecureContext : false,
  };

  const jobs = [];
  if (report.webcodecs.supported) {
    for (const codec of videoCodecs) {
      jobs.push(
        canDecodeVideo({ codec }).then((ok) => {
          report.webcodecs.video[codec] = ok;
        }),
      );
    }
    for (const codec of audioCodecs) {
      // 注意：Chrome 对缺 sampleRate/numberOfChannels 的 audio config 直接判不支持；
      // 探测补标准参数（48kHz/stereo）才能反映「该 codec 类可解」的真实能力
      //（真实缺陷由浏览器端到端验收暴露——route 因此误判 none）。
      jobs.push(
        canDecodeAudio({ codec, sampleRate: 48000, numberOfChannels: 2 }).then((ok) => {
          report.webcodecs.audio[codec] = ok;
        }),
      );
    }
  }
  if (report.mse.supported) {
    for (const container of ['video/mp4', 'video/webm']) {
      for (const codecs of [
        ...videoCodecs.map((v) => [v]),
        ...audioCodecs.map((a) => [a]),
        ['avc1.42E01E', 'mp4a.40.2'],
      ]) {
        const mime = buildMseMimeType(container, codecs);
        if (mseIsTypeSupported(mime)) report.mse.mimeTypes.push(mime);
      }
    }
  }
  await Promise.all(jobs);

  if (!options.deep) detectCapabilities._cache.set(key, report);
  return report;
}
detectCapabilities._cache = new Map();

/** 清空探测缓存（测试用） */
export function resetCapabilityCache() {
  detectCapabilities._cache.clear();
}

/** 单个视频 codec 的 WebCodecs 解码可用性（失败计 false） */
export async function canDecodeVideo(config) {
  if (!hasWebCodecs()) return false;
  try {
    const support = await VideoDecoder.isConfigSupported(config);
    return !!support?.supported;
  } catch {
    return false;
  }
}

/** 单个音频 codec 的 WebCodecs 解码可用性（失败计 false） */
export async function canDecodeAudio(config) {
  if (!hasWebCodecs()) return false;
  try {
    const support = await AudioDecoder.isConfigSupported(config);
    return !!support?.supported;
  } catch {
    return false;
  }
}

/**
 * 路线裁决（契约 §6）：'webcodecs' | 'mse' | 'none'
 *
 * 规则：tracks 全部被 WC 支持 → 'webcodecs'；
 *       可 remux fMP4 且 isTypeSupported 通过 → 'mse'；
 *       否则 'none'。
 *
 * 裁决顺序（§6）：默认「能用 WebCodecs 就不落 MSE」；宿主可通过 `preference`
 * 显式指定顺序（如强制 MSE 兼容验证、或某 codec 在 WebCodecs 下不稳），
 * 此时只在偏好列表内按顺序取第一个可用路线。
 *
 * @param {Awaited<ReturnType<typeof detectCapabilities>>} caps
 * @param {MediaInfo} mediaInfo
 * @param {{preference?: string[]}} [options]
 */
export function chooseRoute(caps, mediaInfo, options = {}) {
  try {
    if (!caps || !mediaInfo || !Array.isArray(mediaInfo.tracks)) return 'none';

    const canWebCodecs = () => {
      if (!caps.webcodecs?.supported) return false;
      let allOk = true;
      let anyTrack = false;
      for (const track of mediaInfo.tracks) {
        if (track.type === 'metadata') continue; // 元数据轨不参与解码
        anyTrack = true;
        const ok =
          track.type === 'video'
            ? caps.webcodecs.video[track.codec] === true
            : track.type === 'audio'
              ? caps.webcodecs.audio[track.codec] === true
              : true; // text 走 Cue 流，与解码路径无关
        if (track.type !== 'text' && !ok) allOk = false;
      }
      return anyTrack && allOk;
    };

    const canMse = () => {
      if (!caps.mse?.supported) return false;
      // remuxable：本仓 mp4/mov/flv 可出 fMP4；此处以容器白名单表达
      const REMUXABLE = new Set(['mp4', 'mov', 'flv']);
      if (!REMUXABLE.has(mediaInfo.container)) return false;
      const codecs = mediaInfo.tracks
        .filter((t) => t.type === 'video' || t.type === 'audio')
        .map((t) => t.codec)
        .filter(Boolean);
      if (codecs.length === 0) return true;
      const mime = buildMseMimeType('video/mp4', codecs);
      // 深探测命中即采信（无 MediaSource 的环境也能确定性裁决）；
      // 未命中一律回落实时 isTypeSupported —— 探测清单未必覆盖素材实际 codec 组合。
      const probed = caps.mse?.mimeTypes;
      if (Array.isArray(probed) && probed.includes(mime)) return true;
      return mseIsTypeSupported(mime);
    };

    const available = { webcodecs: canWebCodecs, mse: canMse };
    const preference = Array.isArray(options.preference) && options.preference.length > 0
      ? options.preference
      : ['webcodecs', 'mse'];
    for (const route of preference) {
      if (available[route]?.() === true) return route;
    }
    return 'none';
  } catch {
    return 'none';
  }
}

/* ------------------------------ 过渡期兼容导出（M2 移除） ------------------------------ */

/** @deprecated 旧组合探测，内部改走新形状 */
export async function detectCapabilitiesLegacy(options = {}) {
  const caps = await detectCapabilities(options);
  return {
    webcodecs: {
      available: caps.webcodecs.supported,
      video: Object.values(caps.webcodecs.video).some(Boolean),
      audio: Object.values(caps.webcodecs.audio).some(Boolean),
    },
    mse: {
      available: caps.mse.supported,
      managed: hasManagedMediaSource(),
      combo: caps.mse.mimeTypes.some((m) => m.includes('avc1')),
    },
    audioWorklet: caps.audioWorklet,
    pipeline:
      caps.webcodecs.supported &&
      (Object.values(caps.webcodecs.video).some(Boolean) ||
        Object.values(caps.webcodecs.audio).some(Boolean))
        ? 'webcodecs'
        : caps.mse.supported
          ? 'mse'
          : 'none',
  };
}

export { mseIsTypeSupported };
