/**
 * RFC-6381 codec string 工具：
 * `avc1.42E01E`、`hvc1.1.6.L93.B0`、`mp4a.40.2` ...
 *
 * 用途：
 * 1. 从 sample description（avcC/hvcC/esds）构造 codec string，供 WebCodecs config 与 MSE mime 使用；
 * 2. 解析 codec string 反查参数；
 * 3. 组装 `video/mp4; codecs="..."` 供 MediaSource.isTypeSupported 探测。
 */

function toHex(v) {
  return v.toString(16).toUpperCase().padStart(2, '0');
}

/** 十六进制大整数转字符串：去前导零与尾随零（ISO 14496-15 Annex E 兼容性元素规则），全零返回 '0' */
function compactHex(bigintValue) {
  if (bigintValue === 0n) return '0';
  return bigintValue.toString(16).toUpperCase().replace(/0+$/, '') || '0';
}

/**
 * 约束指示标志（hvcC 第 6~11 字节，共 6 字节）转字符串：
 * 去掉尾部的全零字节后逐字节十六进制拼接。
 * 例：B0 00 00 00 00 00 → "B0"；全零 → ''（该元素整体省略）。
 */
function constraintHexFromBytes(bytes, offset = 0) {
  let end = offset + 6;
  while (end > offset && bytes[end - 1] === 0) end -= 1;
  let s = '';
  for (let i = offset; i < end; i++) s += toHex(bytes[i]);
  return s;
}

/**
 * 从 avcC 配置构造 AVC codec string。
 * avcC: [0]=version, [1]=profile, [2]=compatibility, [3]=level
 * 例：42 E0 1E → "avc1.42E01E"
 */
export function buildAvcCodecString(avcC, prefix = 'avc1') {
  if (!avcC) return '';
  const p = avcC instanceof Uint8Array ? avcC : new Uint8Array(avcC);
  if (p.byteLength < 4) return '';
  return `${prefix}.${toHex(p[1])}${toHex(p[2])}${toHex(p[3])}`;
}

/**
 * 从 hvcC 构造 HEVC codec string（ISO 14496-15 Annex E）。
 * 例：Main@L3.1 + 约束 B0 → "hvc1.1.6.L93.B0"
 *
 * 元素格式：
 *   <profile>: profile_space∈{1,2,3} 时加前缀 'A'/'B'/'C'，否则纯十进制 profile_idc
 *   <compat>:  兼容性标志(32bit)十六进制，去前导零与尾随零
 *   <tier+level>: 'L'(主层)/'H'(高层) + level_idc 十进制
 *   <constraint>: 约束标志(48bit)非零时以 '.' 拼接，同样压缩规则
 *
 * @param {Uint8Array} hvcC
 * @param {'hvc1'|'hev1'} [prefix]
 */
export function buildHevcCodecString(hvcC, prefix = 'hvc1') {
  if (!hvcC) return '';
  const p = hvcC instanceof Uint8Array ? hvcC : new Uint8Array(hvcC);
  if (p.byteLength < 23) return '';

  const profileSpace = (p[1] >> 6) & 0x03;
  const tierFlag = (p[1] >> 5) & 0x01;
  const profileIdc = p[1] & 0x1f;

  let profileStr = String(profileIdc);
  if (profileSpace > 0) {
    profileStr = 'ABC'[profileSpace - 1] + profileStr;
  }

  const compat =
    (((p[2] << 24) >>> 0) + (p[3] << 16) + (p[4] << 8) + p[5]) >>> 0;

  const levelIdc = p[12];
  const tierChar = tierFlag === 1 ? 'H' : 'L';

  const constraintPart = (() => {
    const hex = constraintHexFromBytes(p, 6);
    return hex === '' ? '' : '.' + hex;
  })();

  return `${prefix}.${profileStr}.${compactHex(BigInt(compat))}.${tierChar}${levelIdc}${constraintPart}`;
}

/** AAC codec string：objectType 默认 2(AAC-LC) → "mp4a.40.2" */
export function aacCodecString(audioObjectType = 2) {
  return `mp4a.40.${audioObjectType}`;
}

/* ============================================================================
 * CONTRACTS v0.2 §3 定稿助手（生成逻辑唯一收敛点，各 demuxer 禁止自行拼串）
 * ==========================================================================*/

/**
 * H.264：从 SPS NAL 单元生成 `avc1.PPCCLL`。
 * 参数取 SPS 载荷的 profile_idc/constraint_flags/level_idc（自动去 emulation prevention）。
 * @param {Uint8Array} spsNalu 含 NAL 头的 SPS
 * @returns {string} 解析失败返回 '' （禁止编造 profile）
 */
export function h264CodecStringFromSps(spsNalu) {
  try {
    // 延迟导入避免循环依赖（exp-golomb 依赖本模块的兄弟模块 nal）
    const rbsp = removeEmulationPreventionSafe(spsNalu);
    if (rbsp.byteLength < 4 || (rbsp[0] & 0x1f) !== 7) return '';
    return buildAvcCodecString([1, rbsp[1], rbsp[2], rbsp[3]]);
  } catch {
    return '';
  }
}

function removeEmulationPreventionSafe(bytes) {
  const out = new Uint8Array(bytes.byteLength);
  let len = 0;
  let zeros = 0;
  for (let i = 0; i < bytes.byteLength; i++) {
    const b = bytes[i];
    if (zeros === 2 && b === 0x03 && i + 1 < bytes.byteLength && (bytes[i + 1] & 0xfc) === 0) {
      zeros = 0;
      continue;
    }
    out[len++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, len);
}

/**
 * HEVC：hvcC → codec string。与 buildHevcCodecString 同逻辑的契约定名版本。
 */
export function hevcCodecStringFromHvcC(hvcC, prefix = 'hvc1') {
  return buildHevcCodecString(hvcC, prefix);
}

/**
 * AAC：AudioSpecificConfig → `mp4a.40.<AOT>`。
 * AOT 取 ASC 首字节高 5 位；5 位全 1（escape）时按规范读后续 6 位。
 * @param {Uint8Array} asc
 */
export function aacCodecStringFromAsc(asc) {
  if (!asc || asc.byteLength < 2) return fallbackCodecString('aac');
  let aot = (asc[0] >> 3) & 0x1f;
  if (aot === 31) {
    aot = 32 + (((asc[0] & 0x07) << 3) | ((asc[1] >> 5) & 0x07));
  }
  return aacCodecString(aot);
}

/**
 * 兜底降级串：拿不到参数集时返回家族基础串并打 warn（契约：禁止编造 profile）。
 * @param {'avc'|'hevc'|'aac'|'opus'|'flac'|string} family
 */
export function fallbackCodecString(family) {
  const base = FAMILY_FALLBACK[family] ?? null;
  console.warn(`[codec-string] 参数集不可得，降级为基础串 "${base ?? 'x-unknown'}"`);
  return base ?? `x-${family}`;
}

const FAMILY_FALLBACK = Object.freeze({
  avc: 'avc1',
  hevc: 'hvc1',
  aac: 'mp4a.40', // 不编造 AOT；精确串必须来自 AudioSpecificConfig
  mp3: 'mp3',
  opus: 'opus',
  flac: 'flac',
});

/**
 * 解析 codec string 为结构化描述（尽力而为，不抛错）。
 * @returns {{family:string, raw:string, parts:string[], objectType?:number}}
 */
export function parseCodecString(codec) {
  const raw = String(codec ?? '').trim();
  const parts = raw.length > 0 ? raw.split('.') : [];
  const familyRaw = (parts[0] || '').toLowerCase();
  const base = { family: familyRaw, raw, parts };

  if (/^avc/.test(familyRaw)) {
    // avc1.PPCCLL
    const packed = parseInt(parts[1] ?? '', 16);
    return Number.isNaN(packed)
      ? Object.assign(base, { family: 'avc' })
      : Object.assign(base, { family: 'avc', profile: packed >>> 16, level: packed & 0xff });
  }
  if (/^hv|^he/.test(familyRaw)) {
    return Object.assign(base, { family: 'hevc' });
  }
  if (/^mp4a$/.test(familyRaw)) {
    // mp4a.40.<objectType>
    const oti = Number(parts[1]);
    const objectType = Number(parts[2]);
    return Object.assign(base, {
      family: 'aac',
      oti: Number.isFinite(oti) ? oti : undefined,
      objectType: Number.isFinite(objectType) ? objectType : undefined,
    });
  }
  if (/^opus$/.test(familyRaw)) return Object.assign(base, { family: 'opus' });
  if (/^flac$/.test(familyRaw)) return Object.assign(base, { family: 'flac' });
  if (/^vp(8|9)$/.test(familyRaw)) return Object.assign(base, { family: familyRaw });
  if (/^av01/.test(familyRaw)) return Object.assign(base, { family: 'av1' });
  return base;
}

/**
 * 安全包装 MediaSource.isTypeSupported：环境不支持时返回 false 而不是抛错。
 * 注意：isTypeSupported 是**静态方法**（MediaSource / ManagedMediaSource 构造器上），
 * 实例上并不存在，切勿用 `mediaSource实例.isTypeSupported()` 调用。
 */
export function mseIsTypeSupported(mime) {
  try {
    const ctors = [];
    if (typeof MediaSource !== 'undefined') ctors.push(MediaSource);
    if (typeof ManagedMediaSource !== 'undefined') ctors.push(ManagedMediaSource);
    for (const Ctor of ctors) {
      if (typeof Ctor.isTypeSupported === 'function' && Ctor.isTypeSupported(mime)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 组装 MSE mimeType。
 * buildMseMimeType('video/mp4', ['avc1.42E01E', 'mp4a.40.2'])
 * → 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"'
 */
export function buildMseMimeType(container, codecs) {
  const list = [...new Set(codecs.filter(Boolean))];
  const mime = container.includes('/') ? container : `video/${container}`;
  return list.length > 0 ? `${mime}; codecs="${list.join(', ')}"` : mime;
}
