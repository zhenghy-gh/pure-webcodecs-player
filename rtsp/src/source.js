/**
 * RtspChunkSource —— CONTRACTS §10 传输层交付形状：
 *   createSource(options) => Promise<ChunkSource-like>
 *
 * 与 §9.4「GatewayChunkSource」语义对齐：内含信令解析与生命周期；
 * 差异说明（已在 README 声明）：RTSP 中继产出的不是 FLV/TS 字节流，而是
 * depacketize 后的 AnnexB Access Unit，因此 chunk = 一帧 AnnexB，
 * meta 携带 codec/parameterSets/bitstreamFormat='annexb'，直接可喂
 * WebCodecs（VideoDecoder）或 annexb 形态的消费端。
 */

import { RtspWsClient, STATES } from './client.js';
import { errors } from './errors.js';
import { Emitter } from '../../core/src/emitter.js';

/** 极简事件发射器（传输层自含，避免依赖 core） */
export class RtspChunkSource extends Emitter {
  /** @param {RtspWsClient} client 已配置未启动的客户端 */
  constructor(client) {
    super();
    this.client = client;
    this.meta = null;
    this.started = false;
    this.stopped = false;

    client.on('sdp', ({ track }) => {
      this.meta = {
        container: 'rtsp',
        live: true,
        durationUs: null,
        codec: track?.codec ?? 'h264',
        bitstreamFormat: 'annexb',
        parameterSets: track?.parameterSets ?? null,
        clock: track?.clock ?? 90000,
        maxDonDiff: track?.maxDonDiff ?? 0,
      };
      this.emit('meta', this.meta);
    });

    client.on('frame', (f) => {
      // chunk = 一个完整 AU 的 AnnexB；时间戳以 µs 附着在对象上（不破坏字节流纯度）
      this.emit('data', f.annexB, { ptsUs: f.dtsUs ?? f.ptsUs, keyframe: f.keyframe });
    });

    client.on('error', (e) => this.emit('error', e));
    client.on('close', ({ code }) => {
      if (!this.stopped && !client.opts.reconnect) {
        this.emit('end');
      } else {
        this.emit('reconnecting', { code });
      }
    });
  }

  /** 连接并开始推流；resolve 于 SDP 协商完成（meta 可用） */
  async start() {
    if (this.started) throw errors.state('source 已启动');
    this.started = true;
    let metaTimer; // 提升到外层作用域：连接失败路径也要清理，避免引用型定时器钉住进程
    const metaPromise = new Promise((resolve, reject) => {
      metaTimer = setTimeout(() => reject(errors.timeout('等待 SDP/meta 超时')), 12000);
      this.on('meta', (m) => {
        clearTimeout(metaTimer);
        resolve(m);
      });
      this.on('error', (e) => {
        clearTimeout(metaTimer);
        reject(e);
      });
    });
    // 连接先于 meta 失败时该 Promise 会迟到拒绝，内部静默避免 unhandledRejection
    metaPromise.catch(() => {});
    try {
      await this.client.start();
      const meta = await metaPromise;
      return meta;
    } catch (err) {
      clearTimeout(metaTimer);
      throw err;
    }
  }

  stop() {
    this.stopped = true;
    this.client.stop();
    this.emit('end');
  }
}

/**
 * 工厂（CONTRACTS §10 传输模块同形替换）。
 * @param {object} options 与 RtspWsClient 相同的选项
 * @returns {Promise<RtspChunkSource>}
 */
export async function createSource(options = {}) {
  const client = new RtspWsClient({ ...options, reconnect: options.reconnect ?? false });
  const source = new RtspChunkSource(client);
  try {
    await source.start();
  } catch (err) {
    // 启动失败的源必须终止重连循环并释放句柄，避免僵尸客户端钉住宿主进程
    try {
      source.stop();
    } catch {}
    throw err;
  }
  return source;
}
