/**
 * QuickTime atom 兼容层。
 *
 * 与 ISO-BMFF 的差异点（本模块逐一处理）：
 * 1. `wide`：moov 前的 8 字节占位 box（历史上为 64 位扩展预留），解析时直接跳过；
 * 2. `cmov`：压缩 moov（zlib + Cinepak 时代遗产）——JS 端解压历史格式成本高，明确拒绝并提示；
 * 3. Sound sample description v1/v2：老版音频描述带额外字段，v2 用 Float64 采样率（box-parser 已支持）；
 * 4. `udta`/`meta`：QT 的 meta 无 version/flags 头（ISO 有），内部 hdlr='mdir'；文本 atom 以 u16 长度前缀存 ©nam/©ART 等；
 * 5. `elst` media_time < 0：空编辑（编辑列表占位），播放器需按偏移平移 pts；
 * 6. `tmcd` 时间码轨：非音视频轨，归入 METADATA；
 * 7. 品牌：ftyp major brand 'qt  ' 是最直接的识别特征。
 */
import { ByteStream } from '../../core/src/index.js';
import { iterateBoxes } from '../../mp4/src/box-parser.js';

/** QuickTime 特征品牌 */
export const QT_BRANDS = Object.freeze(['qt  ']);

/** 顶层 QT 特征 atom 类型 */
export const QT_TOP_ATOMS = new Set(['wide', 'pnot', 'skip']);

/** 快速判断字节头是否像 QuickTime 文件 */
export function looksLikeQuickTime(bytes) {
  if (!bytes || bytes.byteLength < 8) return false;
  const type = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
  if (type === 'ftyp') {
    const brand =
      bytes.byteLength >= 12
        ? String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])
        : '';
    return brand === 'qt  ';
  }
  if (type === 'wide' || type === 'pnot') return true;
  // 老 .mov 可以没有 ftyp：moov/mdat 开头 + 内部含 QT 特征
  return type === 'moov' && hasQuickTimeHints(bytes);
}

function hasQuickTimeHints(bytes) {
  try {
    let hinted = false;
    iterateBoxes(bytes, 0, bytes.byteLength, (h) => {
      if (h.type === 'wide' || h.type === 'pnot') {
        hinted = true;
        return false;
      }
      return true;
    });
    void bytes;
    return hinted;
  } catch {
    return false;
  }
}

/** 列出顶层 atom 类型序列（诊断/测试用） */
export function listTopLevelAtoms(bytes) {
  const types = [];
  iterateBoxes(bytes, 0, bytes.byteLength, (h) => {
    types.push(h.type);
    return true;
  });
  return types;
}

/**
 * 检测 moov 是否被压缩（cmov）。入参为完整 moov box（含头）或内容区均可。
 * @returns {{compressed: boolean, vendor?: string}}
 */
export function detectCompressedMoov(moovBytes) {
  let start = 0;
  let end = moovBytes.byteLength;
  if (
    moovBytes.byteLength >= 8 &&
    String.fromCharCode(moovBytes[4], moovBytes[5], moovBytes[6], moovBytes[7]) === 'moov'
  ) {
    start = 8;
  }
  let result = { compressed: false };
  iterateBoxes(moovBytes, start, end, (h) => {
    if (h.type === 'cmov') {
      result = { compressed: true };
      // cmov > dcom 记录压缩算法 fourcc
      try {
        iterateBoxes(moovBytes, h.contentStart, h.end, (sh) => {
          if (sh.type === 'dcom') {
            result.vendor = String.fromCharCode(
              moovBytes[sh.contentStart],
              moovBytes[sh.contentStart + 1],
              moovBytes[sh.contentStart + 2],
              moovBytes[sh.contentStart + 3],
            );
          }
          return true;
        });
      } catch {
        /* 尽力读取 */
      }
      return false;
    }
    return true;
  });
  return result;
}

/**
 * 解析 moov>udta 的元数据标签（©nam/©ART/cprt...）。
 * 兼容两种 meta 布局：
 *   - QT 风格：meta 内容直接是 hdlr + 数据 atom；
 *   - ISO 风格：version+flags 之后才是 children。
 * 文本 atom 载荷约定：u16 大端长度 + UTF-8/MacRoman 字节。
 *
 * @param {Uint8Array} moovBytes
 * @returns {Record<string, string>} fourcc → 解码文本
 */
export function parseUdtaTags(moovBytes) {
  const tags = {};
  let udtaBox = null;
  try {
    const scanStart = isWholeBox(moovBytes, 'moov') ? 8 : 0;
    iterateBoxes(moovBytes, scanStart, moovBytes.byteLength, (h) => {
      if (h.type === 'udta') {
        udtaBox = h;
        return false;
      }
      return true;
    });
  } catch {
    return tags;
  }
  if (!udtaBox) return tags;

  iterateBoxes(moovBytes, udtaBox.contentStart, udtaBox.end, (child) => {
    if (child.type === 'meta') {
      parseMetaAtom(moovBytes, child, tags);
    } else if (isTextTagType(child.type)) {
      const text = readTextAtom(moovBytes, child);
      if (text !== null) tags[child.type] = text;
    }
    return true;
  });
  return tags;
}

function isWholeBox(bytes, type) {
  return (
    bytes.byteLength >= 8 &&
    String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]) === type
  );
}

function parseMetaAtom(bytes, metaBox, tags) {
  const contentLen = metaBox.end - metaBox.contentStart;
  if (contentLen < 8) return;
  // 布局探测：QT 风格的内容区直接以子 box 开头（首子 box 的 fourcc 位于 +4）；
  // ISO 风格则是 version+flags(4) 之后才是子 box。
  const fourccAt = (off) =>
    String.fromCharCode(
      bytes[metaBox.contentStart + off],
      bytes[metaBox.contentStart + off + 1],
      bytes[metaBox.contentStart + off + 2],
      bytes[metaBox.contentStart + off + 3],
    );
  const head = fourccAt(4) === 'hdlr' ? 0 : 4;
  try {
    iterateBoxes(bytes, metaBox.contentStart + head, metaBox.end, (h) => {
      if (isTextTagType(h.type)) {
        const text = readTextAtom(bytes, h);
        if (text !== null) tags[h.type] = text;
      }
      return true;
    });
  } catch {
    /* 元数据尽力而为 */
  }
}

/** 常见文本标签 fourcc（0xA9 开头的 © 系列为主） */
const TEXT_TAGS = new Set([
  '©nam', '©ART', '©alb', '©gen', '©cpy', '©cmt', '©day', '©des', '©dir',
  '©dis', '©ed', '©enc', '©fmt', '©inf', '©prd', '©prf', '©req', '©src',
  '©swr', '©too', '©wrt', 'cprt', 'name', 'auth',
]);

function isTextTagType(type) {
  return TEXT_TAGS.has(type) || type.charCodeAt(0) === 0xa9;
}

function readTextAtom(bytes, box) {
  const len = box.end - box.contentStart;
  if (len < 2) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset + box.contentStart, len);
  const strLen = dv.getUint16(0, false);
  if (strLen === 0 || strLen > len - 2) {
    // 不符合 u16 长度前缀约定 → 忽略该标签（可能是其它二进制数据）
    return null;
  }
  const payload = bytes.subarray(box.contentStart + 2, box.contentStart + 2 + strLen);
  try {
    return new TextDecoder('utf-8').decode(payload);
  } catch {
    return null;
  }
}

/**
 * 解释 elst 编辑列表：标出空编辑与首个有效媒体起点（秒）。
 * media_time < 0 为空编辑（占位），播放起点取第一条非负 mediaTime。
 * @returns {{hasEmptyEdit: boolean, firstMediaTimeSec: number|null}}
 */
export function interpretEdits(elstEntries, timescale) {
  if (!elstEntries || elstEntries.entries.length === 0) {
    return { hasEmptyEdit: false, firstMediaTimeSec: null };
  }
  const firstValid = elstEntries.entries.find((e) => e.mediaTime >= 0);
  return {
    hasEmptyEdit: elstEntries.entries.some((e) => e.mediaTime < 0),
    firstMediaTimeSec:
      timescale > 0 && firstValid ? firstValid.mediaTime / timescale : null,
  };
}

/** tmcd 时间码轨识别 */
export function isTimecodeHandler(handlerType) {
  return handlerType === 'tmcd';
}
