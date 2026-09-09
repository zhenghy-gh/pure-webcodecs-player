/**
 * MovDemuxer：QuickTime 兼容解复用器，复用 Mp4Demuxer 全部解析能力，
 * 在其上叠加 QT 特有语义（CONTRACTS v0.2 对齐）：
 *  - cmov（压缩 moov）→ 明确 NOT_SUPPORTED；
 *  - udta/meta 标签 → mediaInfo.qtTags 并镜像 title 到 mediaInfo.metadata；
 *  - tmcd 时间码轨 → METADATA 类型、codec='tmcd'；
 *  - elst 空编辑/媒体起点 → track.emptyEdit / track.mediaTimeSec；
 *  - container 标识 'mov'。
 */
import { notSupported, parseError, createProbeResult } from '../../core/src/index.js';
import { Mp4Demuxer, readCapped } from '../../mp4/src/demuxer.js';
import {
  QT_TOP_ATOMS,
  detectCompressedMoov,
  interpretEdits,
  looksLikeQuickTime,
  parseUdtaTags,
} from './atom-compat.js';

export class MovDemuxer extends Mp4Demuxer {
  static containerName = 'mov';

  /**
   * 嗅探优先级：QuickTime 特征 > 通用 ISO-BMFF。
   * 与 Mp4Demuxer.probe 对同一文件打分后取高者（自动选路）。
   */
  static probe(bytes) {
    try {
      if (looksLikeQuickTime(bytes)) {
        return createProbeResult(0.98, 'mov');
      }
      const base = Mp4Demuxer.probe(bytes);
      // 顶层出现 wide/pnot 也强烈暗示 QuickTime
      let hinted = false;
      try {
        for (let i = 4; i + 8 <= bytes.byteLength; ) {
          const size =
            ((bytes[i - 4] << 24) | (bytes[i - 3] << 16) | (bytes[i - 2] << 8) | bytes[i - 1]) >>> 0;
          const type = String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
          if (QT_TOP_ATOMS.has(type)) {
            hinted = true;
            break;
          }
          if (size < 8 || i + size > bytes.byteLength) break;
          i += size;
        }
      } catch {
        /* 探测尽力而为 */
      }
      if (hinted) return createProbeResult(Math.max(base?.confidence ?? 0, 0.9), 'mov');
      if (base && base.confidence > 0) {
        // 无 QT 特征时让位给纯 MP4 判定
        return createProbeResult(base.confidence * 0.6, 'mov');
      }
      return null;
    } catch {
      return null;
    }
  }

  async _doOpen() {
    // 先独立扫描并检查 cmov：压缩 moov 必须在解析前拒绝
    await this._scanTopLevel();
    const moovBox = this._topLevelBoxes.find((b) => b.type === 'moov');
    if (!moovBox) throw parseError('MOV: moov atom not found');

    // I5：与 mp4 同一上界（MovDemuxer 继承 Mp4Demuxer，取已解析的 maxMoovBytes）
    const moovBytes = await readCapped(this.source, moovBox.start, moovBox.end - moovBox.start, {
      max: this.maxMoovBytes,
      what: 'MOV moov',
    });
    this._movMoovBytes = moovBytes;
    const cmov = detectCompressedMoov(moovBytes);
    if (cmov.compressed) {
      throw notSupported(
        `compressed moov (cmov${cmov.vendor ? `/${cmov.vendor}` : ''}) is not supported; ` +
          'please remux the file with ffmpeg -c copy',
        { vendor: cmov.vendor ?? null },
      );
    }

    const info = await super._doOpen();
    info.container = 'mov';

    // QT 元数据标签：qtTags 保留完整集合，title 镜像进契约 metadata
    info.qtTags = parseUdtaTags(moovBytes);
    const nameTag = info.qtTags['©nam'] ?? info.qtTags.name;
    info.metadata = {
      ...(nameTag ? { title: nameTag } : {}),
      ...info.metadata,
    };

    // 按轨道叠加 elst/tmcd 语义
    for (const trak of this._moov.traks) {
      const trackId = trak.tkhd?.trackId;
      const track = info.tracks.find((t) => t.id === trackId);
      if (!track) continue;

      if (trak.hdlr?.handlerType === 'tmcd') {
        track.type = /** @type any */ ('metadata');
        track.codec = 'tmcd';
        track.sampleEntryType = 'tmcd';
      }
      if (trak.elst) {
        const edits = interpretEdits(trak.elst, track.timescale);
        track.emptyEdit = edits.hasEmptyEdit;
        track.mediaTimeSec = edits.firstMediaTimeSec ?? undefined;
      }
    }
    return info;
  }
}
