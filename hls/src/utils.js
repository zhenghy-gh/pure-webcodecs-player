/**
 * utils.js —— HLS 模块通用工具
 *
 * 纯函数集合，零第三方依赖，浏览器与 Node 通用（Node 18+ 自带 URL/console）。
 */

/** 简易日志开关（demo 中可打开调试输出） */
let logEnabled = false;

export function enableLog(on = true) {
  logEnabled = !!on;
}

export function logger(tag) {
  const emit = (level, args) => {
    if (!logEnabled) return;
    // eslint-disable-next-line no-console
    console[level](`[hls:${tag}]`, ...args);
  };
  return {
    info: (...a) => emit('log', a),
    warn: (...a) => emit('warn', a),
    error: (...a) => emit('error', a),
  };
}

/**
 * 将播放列表中的相对地址解析为绝对地址。
 * 兼容三种输入：绝对 URL、协议相对（//host/a.m3u8）、路径相对（seg/1.ts）。
 * @param {string} url    播放列表里写的地址
 * @param {string} base   该播放列表自身的绝对地址
 * @returns {string} 绝对地址；解析失败时原样返回
 */
export function resolveUrl(url, base) {
  if (!url) return '';
  try {
    return new URL(url, base || undefined).href;
  } catch {
    return url;
  }
}

/**
 * 解析 BYTERANGE 属性值 "length[@offset]"。
 * 按 RFC 8216 §4.3.2.2，offset 缺省时沿用"上一个引用的结束位置"（滚动偏移），
 * 由调用方把 prevEnd 传进来维护滚动状态。
 * @param {string} value       如 "1000@2000"
 * @param {number|null} prevEnd 上一个 byterange 的结束偏移（offset+length），无则 null
 * @returns {{length:number, offset:number}|null}
 *   - 值为空或格式非法返回 null；
 *   - 缺省 offset 且无前序引用时返回 {length, offset:null}（规范禁止的用法，由上层报错）
 */
export function parseByteRange(value, prevEnd) {
  if (!value) return null;
  const m = /^\s*(\d+)\s*(?:@\s*(\d+)\s*)?$/.exec(value);
  if (!m) return null;
  const length = Number(m[1]);
  let offset;
  if (m[2] !== undefined) {
    offset = Number(m[2]);
  } else if (prevEnd != null) {
    offset = prevEnd;
  } else {
    return { length, offset: null }; // 非法用法标记，交由上层报错
  }
  return { length, offset };
}

/**
 * 解析 #EXT-X-KEY / #EXT-X-MAP 这类带引号属性的属性表。
 * 例：'METHOD=AES-128,URI="key.bin",IV=0x9c7d...,KEYFORMAT="identity"'
 */
export function parseAttributes(str) {
  const attrs = {};
  if (!str) return attrs;
  // 匹配 KEY=VALUE，VALUE 可为 "双引号串"、0x 十六进制或普通 token。
  // I5：键/值均加上界——无上界时 `[A-Z0-9-]+` 在「长串无等号」的畸形属性行上
  // 会退化成 O(n²) 回溯（灾难性回溯 / ReDoS）；有界后最坏 O(n·64)。
  const re = /([A-Z0-9-]{1,64})=("[^"]{0,4096}"|[^,]{0,4096})/g;
  let m;
  while ((m = re.exec(str))) {
    const key = m[1];
    let val = m[2];
    if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1);
    } else if (/^0[xX]/.test(val)) {
      val = val; // 保留十六进制字符串形式，由具体解析函数转换
    } else {
      val = val.trim();
      if (val !== '' && !Number.isNaN(Number(val))) val = Number(val);
    }
    attrs[key] = val;
  }
  return attrs;
}

/** 十六进制字符串（可含 0x 前缀）转 Uint8Array。用于 EXT-X-KEY 的 IV。 */
export function hexToUint8(hex) {
  if (typeof hex === 'string') hex = hex.replace(/^0[xX]/, '');
  if (!hex) return new Uint8Array(0);
  if (hex.length % 2 !== 0) hex = '0' + hex;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * EWMA（指数加权移动平均）带宽估计器。
 * 参考 hls.js 思路：以字节量而非采样数为衰减单位，慢启动阶段权重自适应。
 */
export class EwmaBandwidthEstimator {
  /**
   * @param {number} halfLife 字节半衰期（每传输多少字节，旧样本权重减半）
   * @param {number} defaultEstimate 初始估计值（bps）
   */
  constructor(halfLife = 256 * 1024, defaultEstimate = 1e6) {
    this.alpha = 1 - Math.exp(-Math.LN2 / halfLife);
    this.defaultEstimate = defaultEstimate;
    this.estimate = defaultEstimate;
    this.totalWeight = 0;
    this.totalBytes = 0;
  }

  sample(bytes, durationMs) {
    if (!(bytes > 0 && durationMs > 0)) return;
    const bitsPerSecond = (bytes * 8000) / durationMs;
    // 权重单位与 halfLife 一致（字节）：一次 625KB 的下载相对 256KB 半衰期，
    // 应使估计值向本次样本大幅靠拢（hls.js 同思路）。
    let weight = bytes;
    // 慢启动：累计样本不足时放大首几个样本的权重，避免初始值拖慢收敛
    const WARMUP = 512 * 1024;
    if (this.totalWeight < WARMUP) {
      weight = Math.max(weight, (WARMUP - this.totalWeight) / 4);
    }
    const adj = 1 - Math.pow(1 - this.alpha, weight);
    this.totalWeight += weight;
    this.totalBytes += bytes;
    this.estimate += adj * (bitsPerSecond - this.estimate);
  }

  get bandwidth() {
    return this.totalWeight < 64 * 1024 ? this.defaultEstimate : this.estimate;
  }
}

/** 极简事件总线：on/off/once/emit，供播放器对外发布事件使用。 */
export { Emitter as EventBus } from '../../core/src/emitter.js';

/**
 * 根据编码串（CODECS 属性）拆分视频/音频编码。
 * 'avc1.640028,mp4a.40.2' -> { video:'avc1.640028', audio:'mp4a.40.2' }
 */
export function splitCodecs(codecsAttr) {
  const list = (codecsAttr || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const result = { video: '', audio: '', all: list };
  for (const c of list) {
    if (/^(avc1|avc3|hvc1|hev1|av01|vp09|vp9|vp8)/i.test(c)) {
      if (!result.video) result.video = c;
    } else if (/^(mp4a|opus|ac-3|ec-3|flac)/i.test(c)) {
      if (!result.audio) result.audio = c;
    }
  }
  return result;
}

/** 组装 fMP4 所需的 SourceBuffer MIME 串 */
export function buildMime(videoCodec, audioCodec) {
  const codecs = [videoCodec, audioCodec].filter(Boolean).join(', ');
  return codecs ? `video/mp4; codecs="${codecs}"` : 'video/mp4';
}

/** 安全的数字解析（EXTINF 时长等），失败返回 NaN */
export function toNumber(v) {
  if (v === undefined || v === '') return NaN;
  return Number(v);
}

/**
 * 在新播放列表中定位续播下标（直播衔接/切档共用）。
 * 三场景：精确衔接（anchor+1 命中）→ 该下标；窗口已滑过锚点 → 向前找第一个
 * sn 更大的分片；新窗口整体落后或无后续 → 返回列表长度（等待下一轮刷新，
 * 绝不回退到 0 重放已消费内容）。
 * @param {Array<{sn:number}>} segments
 * @param {number} anchorSn 最近成功消费的分片 sn
 */
export function computeResumeIndexBySn(segments, anchorSn) {
  if (anchorSn == null) return 0;
  const exact = segments.findIndex((s) => s.sn === anchorSn + 1);
  if (exact >= 0) return exact;
  const ahead = segments.findIndex((s) => s.sn > anchorSn);
  return ahead >= 0 ? ahead : segments.length;
}

/**
 * VOD 按播放时刻（µs）定位续播下标：返回首个累计时长覆盖该时刻的分片下标。
 * @param {Array<{duration:number}>} segments
 * @param {number} timeUs 播放时刻（整数微秒，契约 §0.5）
 */
export function computeResumeIndexByTimeUs(segments, timeUs) {
  let accUs = 0;
  for (let i = 0; i < segments.length; i++) {
    const endUs = accUs + segments[i].duration * 1e6;
    if (timeUs < endUs || i === segments.length - 1) return i;
    accUs = endUs;
  }
  return 0;
}
