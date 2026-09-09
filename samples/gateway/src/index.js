/**
 * 测试网关聚合入口：一键拉起 ws-flv 网关与 rtsp-ws 中继。
 */

import { createWsFlvGateway } from './server-wsflv.js';
import { createRtspWsRelay, makeSdpText } from './server-rtsp.js';
import { createChannelRelay } from './server-relay.js';

export { createWsFlvGateway, createRtspWsRelay, makeSdpText };
export { createChannelRelay };
export { FlvLoopSource, buildFlvTags, flvFileHeader, serializeTag, makeAvcC } from './flv-builder.js';
export {
  packetizeAccessUnit,
  packetizeNal,
  serializeRtp,
  interleaveFrame,
  makeSenderReport,
} from './rtp-packer.js';
export {
  VIDEO_W,
  VIDEO_H,
  VIDEO_FPS,
  CLOCK_RATE,
  makeParameterSets,
  makeIdrFrame,
  annexb,
} from './media/h264-pcm.js';

/**
 * 启动全部服务：ws-flv 网关 + rtsp-ws 中继 + §9 通道中继（兼容 npm run gateway 语义）。
 * @param {{wsFlvPort?:number, rtspPort?:number, relayPort?:number, host?:string}} [opts]
 */
export function startGateways(opts = {}) {
  const wsflv = createWsFlvGateway({ host: opts.host, port: opts.wsFlvPort ?? 8321 });
  const rtsp = createRtspWsRelay({ host: opts.host, port: opts.rtspPort ?? 8322 });
  const relay = createChannelRelay({ host: opts.host, port: opts.relayPort ?? 8090 });
  return {
    servers: [wsflv, rtsp, relay],
    close() {
      for (const s of this.servers) s.close();
    },
    /** 确定性收尾：await 后无残留 socket/timer */
    async dispose() {
      for (const s of this.servers) await s.dispose?.();
    },
  };
}
