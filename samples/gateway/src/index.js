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
 * await ready 返回三个实际端口；任一绑定失败会先收尾所有服务再拒绝。
 * close()/dispose() 返回同一个收尾 Promise，可在启动期间调用。
 * @param {{wsFlvPort?:number, rtspPort?:number, relayPort?:number, host?:string}} [opts]
 */
export function startGateways(opts = {}) {
  const ports = [opts.wsFlvPort ?? 8321, opts.rtspPort ?? 8322, opts.relayPort ?? 8090];
  // 在创建任何监听器前校验所有端口，避免后一个 listen() 同步抛错时泄漏前两个服务。
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new RangeError(`gateway port must be an integer between 0 and 65535: ${port}`);
    }
  }
  const servers = [
    createWsFlvGateway({ host: opts.host, port: ports[0] }),
    createRtspWsRelay({ host: opts.host, port: ports[1] }),
    createChannelRelay({ host: opts.host, port: ports[2] }),
  ];
  const startup = servers.map((server) => server.ready);
  let disposal;
  function dispose() {
    if (!disposal) {
      disposal = (async () => {
        // host 的解析/绑定异步完成；先等待全部 settle，不能让收尾后又迟到 listen。
        await Promise.allSettled(startup);
        const results = await Promise.allSettled(servers.map((server) => server.dispose()));
        const failure = results.find((result) => result.status === 'rejected');
        if (failure) throw failure.reason;
      })();
      // close() 的旧调用方可能不 await；仍向显式 dispose() 调用方保留拒绝原因。
      disposal.catch(() => {});
    }
    return disposal;
  }
  const ready = Promise.all(startup).catch(async (error) => {
    try { await dispose(); } catch { /* 保留原始绑定错误 */ }
    throw error;
  });
  ready.catch(() => {}); // 允许兼容调用方只等待某一服务，同时避免孤立 unhandledRejection
  return { servers, ready, close: dispose, dispose };
}
