/**
 * webtorrent —— P2P 边下边播传输接入层（CONTRACTS §2.5/§10）
 *
 * 定位：交付 DataSource 实现（webtorrent → DataSource），不实现 demuxer 接口。
 *   - 网络路径：magnet/.torrent URL → WebTorrentPlayer（webtorrent 为可选增强依赖）
 *   - 离线路径：.torrent 字节 → bencode 解析 → piece 布局 → assembler 装配 DataSource
 */

export { PlayerError, ErrorCode } from '../../core/src/errors.js';

// ── §10 传输层注册形状 ──────────────────────────────────

export const transportName = 'webtorrent';
export const schemes = ['magnet:', 'http:', 'https:'];
/** 能力说明（供 site 汇总页/能力矩阵展示） */
export const capabilities = Object.freeze({
  p2p: true,
  offlineReplay: true, // .torrent 字节离线模拟装配
  requiresOptionalLib: true,
});

/**
 * 工厂：输入解析为就绪可读的 DataSource。
 * @param {string|Uint8Array|File|Blob} input
 *   - magnet:/http(s).torrent 字符串 → 网络路径（需要可选依赖；缺失 reject NETWORK_ERROR）
 *   - Uint8Array/File/Blob（.torrent 内容）→ 离线装配路径（零网络、确定性）
 * @param {{fileIndex?:number, clientFactory?:Function}} options
 * @returns {Promise<{source:DataSource, meta:object}>} source.size/read/close
 */
export async function createSource(input, options = {}) {
  const isBytes = input instanceof Uint8Array
    || (typeof Blob !== 'undefined' && input instanceof Blob);
  if (!(typeof input === 'string') && !isBytes) {
    throw new PlayerError('PARSE_ERROR', 'createSource 需要 magnet/url 字符串或 .torrent 字节输入');
  }
  if (!isBytes) {
    // 磁力链接先行离线校验（btih 提取/base32↔hex），错误前置于可选依赖加载
    if (typeof input === 'string' && input.startsWith('magnet:')) {
      const { parseMagnet } = await import('./magnet.js');
      var magnetInfo = parseMagnet(input); // 非法则抛 PlayerError('PARSE_ERROR')
    }
    // 网络路径：走 WebTorrentPlayer（可选依赖加载失败时给出明确降级错误）
    const { WebTorrentPlayer } = await import('./player.js');
    const player = options.player ?? new WebTorrentPlayer({ clientFactory: options.clientFactory });
    try {
      const { source, torrent, file } = await player.attach(input);
      return {
        source,
        meta: {
          mode: 'network',
          ...(magnetInfo ? { infoHash: magnetInfo.infoHash, trackers: magnetInfo.tr } : {}),
          name: torrent.name ?? file.name,
          files: (torrent.files ?? []).map((f) => ({ path: f.path ?? f.name, length: f.length })),
          selected: { path: file.name, length: file.length },
        },
        player,
      };
    } catch (err) {
      await player.destroy().catch(() => {});
      throw err;
    }
  }

  // ── 离线装配路径 ──
  const bytes = input instanceof Uint8Array
    ? input
    : new Uint8Array(await input.arrayBuffer());
  const { parseTorrent, computeInfoHash } = await import('./torrent-file.js');
  const parsed = parseTorrent(bytes);
  const infoHash = await computeInfoHash(parsed.infoBytes); // Node crypto / subtle 双端，缺失则 null
  const meta = { ...parsed, infoHash };
  if (meta.size === 0) throw new PlayerError('PARSE_ERROR', '.torrent 声明的总大小为 0');

  const { TorrentAssembler } = await import('./assembler.js');
  const assembler = new TorrentAssembler({
    size: meta.size,
    pieceLength: meta.pieceLength,
    verifyPiece: null, // 离线测试数据无真实哈希语义；网络路径校验由 webtorrent 库负责
  });

  const fileIndex = options.fileIndex
    ?? meta.files.reduce((best, f, i, arr) => (f.length > arr[best].length ? i : best), 0);
  const file = meta.files[fileIndex];

  /** 单文件窗口视图：把整包 assembler 映射到选定文件的偏移区间 */
  const source = {
    size: file.length,
    read: async (offset, length) => {
      const end = Math.min(offset + length, file.length);
      if (offset >= file.length || length <= 0) return new Uint8Array(0);
      return assembler.read(file.offset + offset, end - offset);
    },
    close: () => assembler.destroy(),
  };
  return {
    source,
    meta: {
      mode: 'offline',
      infoHash, // sha1(info 字典)，40 位小写 hex（不可用环境为 null）
      name: meta.name,
      pieceLength: meta.pieceLength,
      numPieces: meta.numPieces,
      announce: meta.announce,
      files: meta.files.map((f) => ({ path: f.path, length: f.length })),
      selected: { index: fileIndex, ...file },
      assembler,
    },
  };
}

// ── 组件与工具导出 ──────────────────────────────────────

export { WebTorrentPlayer, selectMediaFile } from './player.js';
export { TorrentFileSource, createTorrentSource, TorrentSourceError } from './source.js';
export { bdecode, bdecodeRaw, decodeAt, bencode } from './bencode.js';
export { parseTorrent, buildSingleFileTorrent, computeInfoHash } from './torrent-file.js';
export { rangesToPieces, pieceIndexFor, planSequentialPieces } from './piece-map.js';
export { TorrentAssembler } from './assembler.js';
export { loadWebTorrent, DEFAULT_CDN_URLS } from './loader.js';
export {
  parseMagnet, buildMagnet, base32Decode, base32Encode, hexToBase32, base32ToHex,
} from './magnet.js';
export { Emitter, formatBytes } from './utils.js';

export const VERSION = '0.2.0';
