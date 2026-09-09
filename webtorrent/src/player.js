/**
 * player.js —— WebTorrentPlayer：P2P 边下边播播放器封装
 *
 * 职责：
 *   magnet/torrent 输入 → 加载可选依赖(webtorrent) → 客户端 add → 元数据就绪
 *   → 媒体文件选择（扩展名优先、体积兜底）→ TorrentFileSource → 交给 demuxer
 *
 * 设计原则：
 *   - 不绑定具体容器：产出符合 MediaByteSource 契约的 source，由调用方接 mkv/mp4 demuxer；
 *   - 可注入 clientFactory 便于测试与自定义构建（如自托管 bundle）；
 *   - 库不可用时进入 degraded 态并抛 PlayerError('NO_CLIENT')，UI 据此提示。
 */

import { PlayerError } from '../../core/src/errors.js';
import { Emitter } from './utils.js';
import { loadWebTorrent } from './loader.js';
import { createTorrentSource } from './source.js';

const DEFAULT_SELECT_EXTS = Object.freeze(['.mp4', '.webm', '.mkv', '.m4v']);

export class WebTorrentPlayer extends Emitter {
  /**
   * @param {{
   *   clientFactory?: () => Promise<Function|null>, // 注入测试桩或自定义加载器
   *   selectExts?: string[],       // 媒体文件优选扩展名
   *   autoSelect?: boolean,        // ready 时自动选文件（默认 true）
   * }} opts
   */
  constructor(opts = {}) {
    super();
    this.opts = opts;
    /** idle | loading | ready | degraded | destroyed */
    this.state = 'idle';
    /** @type {any} webtorrent client 实例 */
    this.client = null;
    /** @type {any} torrent 实例 */
    this.torrent = null;
    /** @type {object|null} 选中的媒体文件 */
    this.file = null;
    /** @type {import('./source.js').TorrentFileSource|null} */
    this.source = null;
    /** @type {ReturnType<typeof setInterval>|null} */
    this._statsTimer = null;
    /** client 常驻错误转发是否已挂（每 client 一次，避免随 attach 累积） */
    this._clientErrorWired = false;
    /** @type {Function|null} client error 转发器引用（destroy 时摘除） */
    this._clientErrorForwarder = null;
    /** @type {Function|null} 当前 torrent 的监听器摘除函数 */
    this._detachTorrentListeners = null;
  }

  /**
   * 连接种子并准备流式源。
   * @param {string|Uint8Array} torrentId magnet:/infohash/.torrent URL/torrent 文件内容
   * @returns {Promise<{file:Object, source:Object, torrent:Object}>}
   */
  async attach(torrentId) {
    if (this.state === 'destroyed') {
      throw new PlayerError('STATE_ERROR', '播放器已销毁');
    }
    if (!torrentId) {
      throw new PlayerError('PARSE_ERROR', '缺少 torrentId（magnet 链接 / .torrent 地址 / 文件内容）');
    }

    this.state = 'loading';
    this.emit('status', this.state);

    const factory = this.opts.clientFactory ?? loadWebTorrent;
    const WT = await factory();
    if (!WT) {
      this.state = 'degraded';
      this.emit('status', this.state);
      this.emit('no-client');
      throw new PlayerError(
        'NETWORK_ERROR',
        'webtorrent 库未加载成功：请按 README「可选依赖」通过 CDN 引入，'
        + '或检查网络。已降级为本地文件模式。',
        { detail: { reason: 'NO_CLIENT' } },
      );
    }

    try {
      this.client ??= new WT();
      this.torrent = await addTorrent(this.client, torrentId);

      if (this.opts.autoSelect !== false && !this.file) {
        this.file = selectMediaFile(this.torrent.files ?? [], {
          selectExts: this.opts.selectExts ?? DEFAULT_SELECT_EXTS,
        });
        if (!this.file) {
          this.state = 'degraded'; // 评审建议：不再永久卡 loading
          this.emit('status', this.state);
          throw new PlayerError('NOT_SUPPORTED', '种子中没有可识别的媒体文件');
        }
      }
      this.source = createTorrentSource(this.file);

      // ── 断流感知：torrent/client 的运行期错误必须转发上层（评审严重3）──
      this.#wireRuntimeErrorForwarding(this.client, this.torrent);

      this.state = 'ready';
      this.emit('status', this.state);
      this.emit('metadata', summarizeTorrent(this.torrent));
      this.emit('ready', { file: this.file, source: this.source, torrent: this.torrent });

      this._startStats();
      return { file: this.file, source: this.source, torrent: this.torrent };
    } catch (err) {
      this.state = err instanceof PlayerError ? this.state : 'degraded';
      this.emit('error', err);
      throw err;
    }
  }

  /**
   * 常驻转发：client error（每 client 仅挂一次）与 torrent error/warning。
   * destroy 时统一摘除；转发为 NETWORK_ERROR 十码并保留 reason 细分。
   */
  #wireRuntimeErrorForwarding(client, torrent) {
    if (!this._clientErrorWired && typeof client.on === 'function') {
      this._clientErrorForwarder = (err) => {
        if (this.state === 'destroyed') return;
        this.emit('error', new PlayerError(
          'NETWORK_ERROR',
          `webtorrent 客户端错误: ${err?.message ?? err}`,
          { detail: { reason: 'CLIENT' } },
        ));
      };
      client.on('error', this._clientErrorForwarder);
      this._clientErrorWired = true;
    }
    if (typeof torrent.on === 'function') {
      const onTorrentError = (err) => {
        if (this.state === 'destroyed') return;
        this.emit('error', new PlayerError(
          'NETWORK_ERROR',
          `种子运行错误（可能断流）: ${err?.message ?? err}`,
          { detail: { reason: 'TORRENT' } },
        ));
      };
      const onTorrentWarning = (w) => {
        if (this.state === 'destroyed') return;
        this.emit('warning', w); // 非致命：tracker 超时等
      };
      torrent.on('error', onTorrentError);
      torrent.on('warning', onTorrentWarning);
      this._detachTorrentListeners = () => {
        torrent.off?.('error', onTorrentError);
        torrent.off?.('warning', onTorrentWarning);
        this._detachTorrentListeners = null;
      };
    }
  }

  _startStats() {
    this._stopStats();
    this._statsTimer = setInterval(() => {
      const t = this.torrent;
      if (!t) return;
      this.emit('stats', {
        progress: t.progress ?? 0,
        downloadSpeed: t.downloadSpeed ?? 0,
        uploadSpeed: t.uploadSpeed ?? 0,
        peers: t.peers ? Object.keys(t.peers).length : (t.numPeers ?? 0),
        downloaded: t.downloaded ?? 0,
        timeRemaining: t.timeRemaining ?? Infinity,
      });
    }, 1000);
  }

  _stopStats() {
    if (this._statsTimer) clearInterval(this._statsTimer);
    this._statsTimer = null;
  }

  async destroy() {
    if (this.state === 'destroyed') return;
    this.state = 'destroyed';
    this._stopStats();
    try { this._detachTorrentListeners?.(); } catch { /* 忽略 */ }
    this._detachTorrentListeners = null;
    if (this.client && this._clientErrorForwarder) {
      try { this.client.off?.('error', this._clientErrorForwarder); } catch { /* 忽略 */ }
      this._clientErrorForwarder = null;
      this._clientErrorWired = false;
    }
    try { this.source?.close(); } catch { /* 忽略 */ }
    try { await this.torrent?.destroy?.(); } catch { /* 忽略 */ }
    try { await this.client?.destroy?.(); } catch { /* 忽略 */ }
    this.torrent = null;
    this.client = null;
    this.source = null;
    this.file = null;
    this.emit('status', this.state);
  }
}

/** client.add 的 Promise 封装（兼容回调风格 API 与错误事件） */
function addTorrent(client, torrentId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    // 元数据阶段的临时错误监听：settle 时立即摘除，杜绝随 attach 累积
    let detachPre = () => {};
    const fail = (err) => {
      if (settled) return;
      settled = true;
      detachPre();
      reject(new PlayerError('NETWORK_ERROR', `种子加载失败: ${err?.message ?? err}`, { detail: { reason: 'ATTACH_FAILED' } }));
    };
    // 元数据阶段临时错误监听：settle 即摘除（防随 attach 累积）
    const onPreError = (err) => fail(err);
    client.once?.('error', onPreError);
    detachPre = () => { client.off?.('error', onPreError); };

    client.add(torrentId, {}, (err, torrent) => {
      if (settled) return;
      settled = true;
      detachPre();
      // 注意：此处必须内联 reject——若复用 fail，其 settled 守卫会被上一行拦下导致永不 settle
      if (err) reject(new PlayerError('NETWORK_ERROR', `种子加载失败: ${err?.message ?? err}`, { detail: { reason: 'ATTACH_FAILED' } }));
      else resolve(torrent);
    });
  });
}

/**
 * 媒体文件选择：优选指定扩展名中最大者；否则取全局最大。
 * @param {{name:string,length:number}[]} files
 */
export function selectMediaFile(files, { selectExts = DEFAULT_SELECT_EXTS } = {}) {
  if (!files?.length) return null;
  const norm = selectExts.map((e) => e.toLowerCase());
  const byExt = files.filter((f) => norm.some((ext) => (f.name ?? '').toLowerCase().endsWith(ext)));
  const pool = byExt.length ? byExt : files;
  return [...pool].sort((a, b) => (b.length ?? 0) - (a.length ?? 0))[0];
}

function summarizeTorrent(t) {
  return {
    name: t.name ?? '',
    infoHash: t.infoHash ?? null,
    length: t.length ?? 0,
    files: (t.files ?? []).map((f) => ({ name: f.name, path: f.path ?? f.name, length: f.length })),
  };
}
