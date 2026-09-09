import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startGateways } from '../src/index.js';
import { parseSdp } from '../../../rtsp/src/sdp.js';

let PORT_W, PORT_R; // listen(0) 系统分配
let gw;
const liveSockets = new Set();

/** 收集条件满足或超时 */
function until(fn, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (fn()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - t0 > ms) {
        clearInterval(timer);
        reject(new Error('until 超时'));
      }
    }, 10);
    timer.unref?.();
  });
}

function connectWs(url) {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  liveSockets.add(ws);
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error(`连接失败: ${url}`));
  });
}

before(async () => {
  gw = startGateways({ host: '127.0.0.1', wsFlvPort: 0, rtspPort: 0 });
  PORT_W = await gw.servers[0].ready;
  PORT_R = await gw.servers[1].ready;
});

after(async () => {
  for (const ws of liveSockets) {
    try {
      ws.close();
    } catch {}
  }
  await gw.dispose();
});

test('ws-flv：首块为合法 FLV 头，frames=N 后服务端主动正常关闭', async () => {
  const ws = await connectWs(`ws://127.0.0.1:${PORT_W}/live/test?speed=fast&frames=5`);
  const sizes = [];
  let firstChunk = null;
  ws.onmessage = (ev) => {
    if (!firstChunk) firstChunk = new Uint8Array(ev.data);
    sizes.push(ev.data.byteLength);
  };
  const closed = new Promise((r) => (ws.onclose = r));
  await closed;
  assert.ok(firstChunk, '应收到数据');
  assert.equal(String.fromCharCode(firstChunk[0], firstChunk[1], firstChunk[2]), 'FLV');
  assert.equal(firstChunk[4], 0x01); // 仅视频
  // init + ≥5 帧
  assert.ok(sizes.length >= 6, `消息数 ${sizes.length}`);
});

test('rtsp-ws interleaved：完整握手（含 455 状态码校验）+ $ 块双信道', async () => {
  const ws = await connectWs(`ws://127.0.0.1:${PORT_R}/rtsp?intervalMs=5`);
  try {
    const state = { responses: [], sdpText: '', rtp: [], rtcp: 0 };
    let session = '';
    ws.onmessage = (ev) => {
      const u8 = new Uint8Array(ev.data);
      if (u8.length && u8[0] === 0x24) {
        const channel = u8[1];
        const len = (u8[2] << 8) | u8[3];
        assert.equal(len, u8.length - 4, '$ 块长度字段应与实际一致');
        if (channel === 0) state.rtp.push(u8.subarray(4));
        else state.rtcp++;
      } else {
        const text = Buffer.from(u8).toString('utf8');
        state.responses.push(text.split('\r\n')[0]);
        if (text.includes('application/sdp')) state.sdpText = text.split('\r\n\r\n')[1] ?? '';
        const m = text.match(/Session: ([^\r\n;]+)/);
        if (m) session = m[1];
      }
    };
    const enc = (s) => ws.send(new TextEncoder().encode(s));
    enc('OPTIONS rtsp://gw/test RTSP/1.0\r\nCSeq: 1\r\n\r\n');
    await until(() => state.responses.length >= 1);
    assert.match(state.responses[0], /200 OK/);

    enc('DESCRIBE rtsp://gw/test RTSP/1.0\r\nCSeq: 2\r\nAccept: application/sdp\r\n\r\n');
    await until(() => state.sdpText !== '');
    const sdp = parseSdp(state.sdpText);
    const video = sdp.media.find((m) => m.type === 'video');
    assert.ok(video, 'SDP 应含 video 媒体节');
    assert.equal(video.rtpmap['96'].codec, 'H264');
    assert.ok(video.h264, 'SDP 应解析出 H264 参数集');
    assert.ok(video.h264.sps.length >= 1 && video.h264.pps.length >= 1);

    // 未 SETUP 直接 PLAY → 455
    enc('PLAY rtsp://gw/test RTSP/1.0\r\nCSeq: 3\r\n\r\n');
    await until(() => state.responses.some((r) => r.includes('455')));

    enc('SETUP rtsp://gw/test/trackID=0 RTSP/1.0\r\nCSeq: 4\r\nTransport: RTP/AVP/TCP;interleaved=0-1\r\n\r\n');
    await until(() => session !== '');
    assert.equal(session, 'CAFE0001');

    enc(`PLAY rtsp://gw/test RTSP/1.0\r\nCSeq: 5\r\nSession: ${session}\r\n\r\n`);
    await until(() => state.rtp.length >= 8);
    for (const p of state.rtp.slice(0, 8)) {
      assert.equal(p[0] >> 6, 2); // RTP 版本
      assert.equal(p[1] & 0x7f, 96); // PT
    }

    enc(`TEARDOWN rtsp://gw/test RTSP/1.0\r\nCSeq: 6\r\nSession: ${session}\r\n\r\n`);
    await until(() => ws.readyState === 3, 3000);
  } finally {
    ws.close();
  }
});

test('rtsp-ws /rtp：纯 RTP-over-WS，一包一消息，无 $ 封装，序号连续', async () => {
  const ws = await connectWs(`ws://127.0.0.1:${PORT_R}/rtp?mode=passive&speed=fast&frames=6`);
  try {
    const pkts = [];
    ws.onmessage = (ev) => {
      const u8 = new Uint8Array(ev.data);
      assert.notEqual(u8[0], 0x24, '纯 RTP 模式不应有 $ 封装');
      pkts.push(u8);
    };
    await until(() => pkts.length >= 6);
    for (let i = 1; i < Math.min(pkts.length, 6); i++) {
      const s0 = (pkts[i - 1][2] << 8) | pkts[i - 1][3];
      const s1 = (pkts[i][2] << 8) | pkts[i][3];
      assert.equal(s1, (s0 + 1) & 0xffff);
    }
  } finally {
    ws.close();
  }
});

test('chaos=dropEvery:N 会产生序列号跳变（供客户端容错测试）', async () => {
  const ws = await connectWs(`ws://127.0.0.1:${PORT_R}/rtp?mode=passive&speed=fast&frames=12&chaos=dropEvery:4`);
  try {
    const seqs = [];
    ws.onmessage = (ev) => {
      const u8 = new Uint8Array(ev.data);
      seqs.push((u8[2] << 8) | u8[3]);
    };
    await until(() => seqs.length >= 9);
    const gaps = seqs.filter((s, i) => i > 0 && ((seqs[i - 1] + 1) & 0xffff) !== s).length;
    assert.ok(gaps >= 1, `应有丢包跳变，实际 gaps=${gaps}`);
  } finally {
    ws.close();
  }
});
