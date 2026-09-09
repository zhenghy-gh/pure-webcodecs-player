import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createRtspWsRelay } from '../../samples/gateway/src/server-rtsp.js';
import { RtspWsClient } from '../src/client.js';

let PORT; // 实际端口由系统分配（listen 0），彻底规避并发端口冲突
let server;

before(async () => {
  server = createRtspWsRelay({ host: '127.0.0.1', port: 0 });
  PORT = await server.ready;
});

after(async () => {
  await server.dispose();
});

test('e2e interleaved：自动握手收流，首帧含参数集且为关键帧', { timeout: 8000 }, async () => {
  const c = new RtspWsClient({ url: `ws://127.0.0.1:${PORT}/rtsp?intervalMs=5`, framing: 'interleaved', connectTimeoutMs: 3000 });
  const frames = [];
  const states = [];
  let sdpTrack = null;
  c.on('frame', (f) => frames.push(f));
  c.on('state', (s) => states.push(s.to));
  c.on('sdp', ({ track }) => (sdpTrack = track));

  await c.start();
  await new Promise((resolve, reject) => {
    const wd = setTimeout(() => {
      clearInterval(t);
      reject(new Error(`收帧超时，实际 ${frames.length} 帧`));
    }, 6000);
    const t = setInterval(() => {
      if (frames.length >= 6) {
        clearTimeout(wd);
        clearInterval(t);
        resolve();
      }
    }, 10);
  });

  c.stop();
  assert.ok(sdpTrack, '应通过 DESCRIBE 获得 SDP 轨信息');
  assert.equal(sdpTrack.codec, 'h264');
  assert.equal(states[0], 'connecting');
  assert.ok(frames[0].keyframe, '首帧应为关键帧');
  // 首帧 NAL 序列：SPS(67)+PPS(68)+IDR(65)
  assert.equal(frames[0].nals.length, 3);
  assert.equal(frames[0].nals[0][0] & 0x1f, 7);
  // pts 单调
  for (let i = 1; i < frames.length; i++) {
    assert.ok(frames[i].ptsMs >= frames[i - 1].ptsMs, `pts 应单调 ${frames[i - 1].ptsMs} -> ${frames[i].ptsMs}`);
  }
});

test('e2e 纯 RTP-over-WS 模式：带外 SDP + 收帧', { timeout: 8000 }, async () => {
  // 先从 HTTP /sdp 带外获取 SDP
  const res = await fetch(`http://127.0.0.1:${PORT}/sdp`);
  const sdpText = await res.text();
  assert.match(sdpText, /a=rtpmap:96 H264\/90000/);

  const c = new RtspWsClient({
    url: `ws://127.0.0.1:${PORT}/rtp?mode=passive&speed=fast&intervalMs=5`,
    framing: 'rtp',
    sdp: sdpText,
    connectTimeoutMs: 3000,
  });
  const frames = [];
  c.on('frame', (f) => frames.push(f));
  await c.start();
  await new Promise((resolve, reject) => {
    const wd = setTimeout(() => {
      clearInterval(t);
      reject(new Error('纯 RTP 模式收帧超时'));
    }, 8000);
    const t = setInterval(() => {
      if (frames.length >= 4) {
        clearTimeout(wd);
        clearInterval(t);
        resolve();
      }
    }, 10);
  });
  c.stop();
  assert.equal(c.track.codec, 'h264', 'SDP 带外解析生效');
  assert.ok(frames.every((f) => f.annexB instanceof Uint8Array));
});

test('e2e 断线重连：服务端主动断开后客户端按退避重连并继续收流', { timeout: 9500 }, async () => {
  // frames=6：网关发完即关连接，触发客户端重连
  const c = new RtspWsClient({
    url: `ws://127.0.0.1:${PORT}/rtsp?intervalMs=5&frames=6`,
    framing: 'interleaved',
    connectTimeoutMs: 3000,
    backoff: { baseMs: 100, maxMs: 300 },
  });
  const frames = [];
  let closes = 0;
  let reconnectsSeen = 0;
  c.on('frame', (f) => frames.push(f));
  c.on('close', () => closes++);
  c.on('state', (s) => {
    if (s.to === 'reconnecting') reconnectsSeen++;
  });

  await c.start();
  await new Promise((resolve, reject) => {
    const wd = setTimeout(() => {
      clearInterval(t);
      reject(new Error(`重连后收帧不足：${frames.length} 帧, close=${closes}`));
    }, 9000);
    const t = setInterval(() => {
      if (frames.length >= 12) {
        clearTimeout(wd);
        clearInterval(t);
        resolve();
      }
    }, 10);
  });
  c.stop();
  assert.ok(closes >= 1, `应发生服务端关闭，closes=${closes}`);
  assert.ok(reconnectsSeen >= 1, '应进入重连状态');
  assert.ok(frames.length >= 12);
});

test('e2e chaos 丢包容错：FU-A 中段丢包后仍能恢复出帧', { timeout: 9500 }, async () => {
  const c = new RtspWsClient({
    url: `ws://127.0.0.1:${PORT}/rtsp?mode=passive&intervalMs=2&chaos=dropEvery:9`,
    framing: 'interleaved',
    handshake: false,
    sdp: null,
    payloadType: 96,
  });
  const frames = [];
  c.on('frame', (f) => frames.push(f));
  await c.start();
  await new Promise((resolve, reject) => {
    const wd = setTimeout(() => {
      clearInterval(t);
      reject(new Error(`容错测试超时：frames=${frames.length} lost=${c.stats.lost}`));
    }, 9000);
    const t = setInterval(() => {
      if (frames.length >= 5 && c.stats.lost >= 1) {
        clearTimeout(wd);
        clearInterval(t);
        resolve();
      }
    }, 10);
  });
  c.stop();
  assert.ok(c.stats.lost >= 1, `应检测到丢包 lost=${c.stats.lost}`);
});
