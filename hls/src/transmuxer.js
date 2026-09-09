/**
 * transmuxer.js —— 分片格式识别与 TS→fMP4 转封装适配层
 *
 * HLS 分片两种形态：
 *  1) fMP4（EXT-X-MAP init segment + m4s 媒体分片）→ 直通 MSE，无需转封装；
 *  2) MPEG-TS → 复用仓库 `ts/` 模块 demux（AnnexB H264 / AAC raw），
 *     再经本模块的 fmp4-muxer.js 封装为 MSE 可直喂的 fMP4。
 *
 * 对齐 docs/CONTRACTS.md：hls 定位为"数据源适配层"——清单解析 + 分片编排，
 * TS 分片的 demux 完全复用 ts/ 模块（TsDemuxer），本层只做容器形态转换。
 */

import { logger } from './utils.js';
import { PlayerError, ErrorCode } from '../../core/src/errors.js';
import { TsToFmp4Transmuxer } from './fmp4-muxer.js';

export { TsToFmp4Transmuxer };

const log = logger('transmuxer');

/** TS 包定界符：0x47 */
const TS_SYNC = 0x47;

/**
 * 探测分片字节形态。
 * @param {Uint8Array} head 分片头部字节（建议 >= 188*3）
 * @returns {'fmp4'|'ts'|'unknown'}
 */
export function sniffContainer(head) {
  if (!head || head.length < 12) return 'unknown';
  // ISO-BMFF box：ftyp / styp / moof / sidx
  const ascii = (off, len) => String.fromCharCode(...head.subarray(off, off + len));
  if (head.length >= 8) {
    const size = (head[0] << 24) | (head[1] << 16) | (head[2] << 8) | head[3];
    const type = ascii(4, 4);
    if (size > 8 && /^(ftyp|styp|moof|sidx|emsg|prft)$/.test(type)) return 'fmp4';
  }
  // MPEG-TS：首字节与后续每 188/192 字节均为 0x47
  if (
    head[0] === TS_SYNC &&
    (head.length < 377 || (head[188] === TS_SYNC && head[376] === TS_SYNC))
  ) {
    return 'ts';
  }
  return 'unknown';
}

/**
 * 转封装器。fMP4 直通；TS 经 fmp4-muxer 转封装。
 */
export class Transmuxer {
  constructor() {
    /** @type {TsToFmp4Transmuxer|null} */
    this._impl = null;
    this._tsAvailable = null; // null=未探测
  }

  /**
   * 处理一个媒体分片（init segment 也走这里，isInit=true 时直接直通）。
   * @param {Uint8Array} data 分片原始数据
   * @param {{isInit?:boolean, discontinuity?:boolean}} [ctx]
   * @returns {Promise<
   *   | {kind:'passthrough', mediaSegment:Uint8Array}
   *   | {kind:'transmuxed',
   *      codecs:{video:string,audio:string},
   *      video:{initSegment:Uint8Array|null, mediaSegment:Uint8Array},
   *      audio:{initSegment:Uint8Array|null, mediaSegment:Uint8Array}|null}>}
   */
  async process(data, ctx = {}) {
    const kind = sniffContainer(data);
    if (ctx.isInit || kind === 'fmp4') {
      return { kind: 'passthrough', mediaSegment: data };
    }
    if (kind === 'unknown') {
      // 无法识别形态时不得空转跳片：显式报错交由上层降级策略
      throw new PlayerError(ErrorCode.PARSE_ERROR, '无法识别的分片容器形态（既非 fMP4 也非 MPEG-TS）');
    }
    if (!this._impl) this._impl = new TsToFmp4Transmuxer();
    const out = await this._impl.remux(data, { discontinuity: !!ctx.discontinuity });
    log.info(
      'TS 分片已转封装:',
      out.video ? 'video' : '-',
      out.audio ? 'audio' : '-',
      JSON.stringify(out.codecs)
    );
    return { kind: 'transmuxed', ...out };
  }

  reset() {
    this._impl?.destroy();
    this._impl = null;
  }

  destroy() {
    this.reset();
  }

  /** 探测 ts/ 模块是否可用（Node 下 import 成功即可用） */
  static async tsAvailable() {
    try {
      await import('../../ts/src/index.js');
      return true;
    } catch {
      return false;
    }
  }
}
