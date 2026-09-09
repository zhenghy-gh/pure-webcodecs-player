/**
 * data-source.js —— HLS 数据源适配层（契约 §2.1 ChunkSource / §10 传输层约定）
 *
 * 定位【裁决-hls-flv重定位】：hls 不做完整播放器竞赛，而是把
 * "清单解析 + 分片编排"封装为统一内核可消费的数据源：
 *
 *   createHlsSource(url) ──► HlsChunkSource (implements ChunkSource)
 *                               │ start() 内部：清单解析→顺序下载分片
 *                               ▼ write(bytes) ──► 消费端（如 TsDemuxer.push）
 *
 * - TS 变体：字节流天然连续，可直接接 ts/TsDemuxer.push；
 * - fMP4 变体：按分片边界回调（initSegment 与媒体分片分离语义由容器自描述），
 *   统一内核可转交 mp4/cmaf demuxer；
 * - AES-128 分片在进入 write 前完成解密（契约 §2.6：解密层位于 Source 与 demux 之间）。
 */

import { parseMaster, parseMedia, detectPlaylistType } from './m3u8-parser.js';
import { SegmentLoader } from './segment-loader.js';
import { Aes128Decrypter } from './decrypter.js';
import { notSupported, sourceError } from '../../core/src/errors.js';

/** 默认文本/字节获取器 */
function defaultFetchImpl(url, init) {
  if (typeof fetch !== 'function') {
    throw notSupported('当前环境无 fetch，请通过 options.fetchImpl 注入');
  }
  return fetch(url, init);
}

export class HlsChunkSource {
  /** @internal */
  constructor({ playlistUrl, playlist, loader, decrypter, fetchImpl }) {
    this.playlistUrl = playlistUrl;
    this.mediaPlaylist = playlist;
    this._loader = loader;
    this._decrypter = decrypter;
    this._fetchImpl = fetchImpl;
    this._aborted = false;

    /** @type {'ts'|'fmp4'} 由首个分片字节探测，start() 后有效 */
    this.container = 'ts';
    this.live = playlist.live;
    /** 已推送字节数（诊断用） */
    this.bytesWritten = 0;

    // —— ChunkSource 契约面 ——
    /** @type {(bytes:Uint8Array)=>void|null} 消费端数据回调（如 TsDemuxer.push） */
    this.onData = null;
    /** @type {(err?:Error)=>void|null} 流结束回调 */
    this.onEnd = null;
    /** @type {{uri:string,bytes:Uint8Array}|null} fMP4 变体的 init segment（EXT-X-MAP） */
    this.pendingInit = null;
  }

  /**
   * ChunkSource.write：向消费端推送一段字节。
   * @param {Uint8Array} bytes
   */
  write(bytes) {
    this.bytesWritten += bytes.byteLength;
    this.onData?.(bytes);
  }

  /**
   * ChunkSource.end：结束流。
   * @param {Error} [err]
   */
  end(err) {
    const cb = this.onEnd;
    this.onEnd = null;
    cb?.(err);
  }

  /**
   * 开始顺序拉取分片并写入。VOD 到 ENDLIST 结束；直播窗口取完当前清单即结束
   * （持续追新归统一内核调度，见 README 路线）。
   */
  async start() {
    const pl = this.mediaPlaylist;
    let firstSegmentChecked = false;

    for (const seg of pl.segments) {
      if (this._aborted) break;

      // EXT-X-MAP（fMP4 init）：先于媒体分片推送
      if (seg.map && !this.pendingInit) {
        const res = await this._loader.load(seg.map.uri, {
          byteRange: seg.map.byteRange || undefined,
        });
        this.pendingInit = { uri: seg.map.uri, bytes: res.data };
      }

      let data = await this._loader.load(seg.url, {
        byteRange: seg.byteRange || undefined,
      });

      // 解密层（§2.6）
      if (seg.key && seg.key.method !== 'NONE') {
        data = { ...data, data: await this._decrypter.decryptSegment(data.data, seg.key, { sn: seg.sn }) };
      }

      // 首个分片探测容器形态
      if (!firstSegmentChecked) {
        firstSegmentChecked = true;
        this.container = detectContainer(data.data);
      }

      this.write(data.data);
    }
    this.end();
  }

  /** 中止拉取 */
  close() {
    this._aborted = true;
    this.end();
  }
}

function detectContainer(head) {
  if (!head || head.length < 12) return 'unknown';
  if (head[0] === 0x47) return 'ts';
  const t = String.fromCharCode(head[4], head[5], head[6], head[7]);
  if (/^(ftyp|styp|moof|sidx|emsg|prft)$/.test(t)) return 'fmp4';
  return 'unknown';
}

/**
 * 工厂（契约 §10 同形替换：传输层导出 createSource）。
 * @param {string} url m3u8 地址（MASTER 或 MEDIA）
 * @param {{variant?:number, keyLoader?:(uri:string)=>Promise<Uint8Array>, fetchImpl?:Function}} [options]
 *   variant：MASTER 时选择的清晰度下标（0=最高清，默认 0）
 * @returns {Promise<HlsChunkSource>}
 */
export async function createHlsSource(url, options = {}) {
  const fetchImpl = options.fetchImpl || defaultFetchImpl;
  const loader = new SegmentLoader(fetchImpl ? { fetchImpl } : {});
  // 文本加载走注入的 fetchImpl（便于单测离线）
  const loadText = async (u) => {
    const res = await fetchImpl(u);
    if (!res.ok) throw sourceError(`HTTP ${res.status} ${u}`, { url: u, status: res.status });
    return new TextDecoder().decode(await res.arrayBuffer());
  };

  const text = await loadText(url);
  let playlistUrl = url;
  let playlist;
  if (detectPlaylistType(text) === 'master') {
    const master = parseMaster(text, url);
    const level = master.levels[Math.min(options.variant ?? 0, master.levels.length - 1)];
    playlistUrl = level.url;
    playlist = parseMedia(await loadText(level.url), level.url);
  } else {
    playlist = parseMedia(text, url);
  }

  const decrypter = new Aes128Decrypter(
    options.keyLoader ? { keyLoader: options.keyLoader } : {}
  );

  return new HlsChunkSource({ playlistUrl, playlist, loader, decrypter, fetchImpl });
}
