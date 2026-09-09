/**
 * ape/src/index.js — APE 模块唯一入口（具名导出，契约 §0.4）
 *
 * 范围（对齐 ARCHITECTURE Phase 3 结论）：容器头 + APE TAG 元数据解析与展示。
 * 音频解码器复杂度高（预测滤波 + 范围编码），路线见 README「解码器路线」。
 */
import { parseMacHeader } from './mac-parser.js';
import { findApeTag } from './ape-tag.js';
export { parseMacHeader, describeFormatFlags, COMPRESSION_LEVEL } from './mac-parser.js';
export { findApeTag, tagValue, APE_TAG_VERSION } from './ape-tag.js';
export { PlayerError, ErrorCode } from './errors.js';

/**
 * 静态嗅探：'MAC ' 魔数 → ProbeResult（契约 §2.4 ape 行）。
 * @param {Uint8Array} bytes
 * @returns {{confidence:number, container:'ape', codecsHint:string[]}|null}
 */
export function probeApe(bytes) {
  try {
    if (bytes.length < 6) return null;
    if (!(bytes[0] === 0x4d && bytes[1] === 0x41 && bytes[2] === 0x43 && bytes[3] === 0x20)) return null;
    return { confidence: 0.9, container: 'ape', codecsHint: ['x-ape'] };
  } catch {
    return null;
  }
}

/**
 * 汇总容器信息 + 标签为统一展示模型（demo 与未来 MediaInfo 桥接共用）。
 * @param {Uint8Array} bytes 完整文件字节
 * @returns {{info:import('./mac-parser.js').ApeInfo,
 *            tag:import('./ape-tag.js').ApeTag|null,
 *            cover:{mime:string,data:Uint8Array}|null}}
 */
export function summarizeApe(bytes) {
  const info = parseMacHeader(bytes);
  const tag = findApeTag(bytes);
  let cover = null;
  const coverItem = tag?.items.find((it) => /^cover art/i.test(it.key) || it.key.toUpperCase() === 'COVER ART (FRONT)');
  if (coverItem && coverItem.value instanceof Uint8Array) {
    // 二进制值格式：< mime 字符串 >\0< 图片字节 >
    const zero = coverItem.value.indexOf(0);
    if (zero > 0) {
      cover = {
        mime: new TextDecoder().decode(coverItem.value.subarray(0, zero)),
        data: coverItem.value.slice(zero + 1),
      };
    }
  }
  return { info, tag, cover };
}
