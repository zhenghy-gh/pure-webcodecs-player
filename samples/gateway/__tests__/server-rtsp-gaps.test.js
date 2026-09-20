/**
 * server-rtsp 残余分支补测（第 138 波覆盖率迭代）。
 *
 * 覆盖点与 server-rtsp.js 行号对应：
 *   - 76-82    httpHandler：/healthz 200 JSON 统计；其余路径 404 纯文本兜底
 *   - 122-124  tick 早退兜底：conn 已死（alive=false）但 close 事件尚未到达
 *              → stopStreaming 清推流计时器（原型注入 send 触发真实 terminate()，
 *              制造 alive=false 而 close 永不到达的窗口，finally 还原）
 *   - 163-175  /rtsp 播放中周期性 RTCP SR（信道 1，2s 周期，unref 不阻塞退出）
 *   - 256-258  未 DESCRIBE 直接 SETUP（state=idle）→ 455
 *   - 279-282  PAUSE → state=paused + 停推流 + 200
 *   - 289      未知方法 → 501 Not Implemented
 *   - 295-296  文本消息请求（isText=true）→ replyAsText=true，响应以文本帧回传
 *   - 301-303  二进制消息首字节 0x24（$ 块透传噪声）→ 静默忽略不崩溃
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createRtspWsRelay } from '../src/server-rtsp.js';
import { WsConnection } from '../src/ws-server.js';

let PORT;
let server;

before(async () => {
  server = createRtspWsRelay({ host: '127.0.0.1', port: 0 });
  PORT = await server.ready;
});
after(async () => server.dispose());

function connectWs(url) {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error(`连接失败: ${url}`));
  });
}

async function until(fn, ms = 4000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('until 超时');
    await new Promise((r) => setTimeout(r, 8));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ httpHandler（76-82） ------------------------------ */

test('httpHandler：/healthz 返回 200 JSON 统计；未匹配路径 404 纯文本（76-82）', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json');
  const body = await res.json();
  assert.equal(body.service, 'rtsp-ws-relay');
  assert.equal(typeof body.connections, 'number');
  assert.equal(typeof body.rtpSent, 'number');

  const res404 = await fetch(`http://127.0.0.1:${PORT}/definitely-not-here`);
  assert.equal(res404.status, 404);
  assert.equal(await res404.text(), 'not found');
});

/* ------------------------------ 周期性 RTCP SR（163-175） ------------------------------ */

test('/rtsp passive 播放 2s → 信道 1 收到周期性 RTCP Sender Report（163-175）', async () => {
  const ws = await connectWs(`ws://127.0.0.1:${PORT}/rtsp?mode=passive&intervalMs=100`);
  try {
    const state = { rtp: 0, sr: [] };
    ws.onmessage = (ev) => {
      const u8 = new Uint8Array(ev.data);
      if (u8.length >= 4 && u8[0] === 0x24 && u8[1] === 1) state.sr.push(u8);
      else state.rtp++;
    };
    // SR 周期硬编码 2000ms，预算放宽到 5s
    await until(() => state.sr.length >= 1, 5000);
    const sr = state.sr[0];
    assert.equal((sr[2] << 8) | sr[3], sr.length - 4, '$ 块长度字段应与实际一致');
    assert.equal(sr[4] >> 6, 2, 'RTCP 版本应为 V=2');
    assert.equal(sr[5], 200, 'RTCP PT 应为 SR(200)');
    assert.deepEqual([...sr.subarray(8, 12)], [0x12, 0x34, 0xab, 0xcd], 'SSRC 应为 0x1234abcd');
    assert.ok(state.rtp >= 1, '等待期偶数信道 0 应持续有 RTP');
  } finally {
    ws.close();
  }
});

/* -------------- 文本请求 + 状态机杂项（256-258/279-282/289/295-296/301-303） -------------- */

test('文本消息驱动会话：replyAsText 回文本帧 + idle 态 SETUP→455 + PAUSE→200 + 未知方法→501 + $ 块忽略（256-258/279-282/289/295-296/301-303）', async () => {
  const ws = await connectWs(`ws://127.0.0.1:${PORT}/rtsp`);
  try {
    const statuses = [];
    let textFrames = 0;
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        textFrames++;
        statuses.push(ev.data.split('\r\n')[0]);
      }
    };
    const enc = (s) => ws.send(new TextEncoder().encode(s));

    // ① 首条请求用真实文本帧（isText=true → 295-296 置 replyAsText）；
    //    state=idle 未 DESCRIBE 直接 SETUP → 455（256-258）
    ws.send('SETUP rtsp://gw/test/trackID=0 RTSP/1.0\r\nCSeq: 1\r\n\r\n');
    await until(() => statuses.length >= 1);
    assert.match(statuses[0], /455 Method Not Valid In This State/);

    // ② PAUSE 无状态守卫：任何状态均 200 并停推流（279-282）
    enc('PAUSE rtsp://gw/test RTSP/1.0\r\nCSeq: 2\r\n\r\n');
    await until(() => statuses.length >= 2);
    assert.match(statuses[1], /200 OK/);

    // ③ 未知方法 → 501（289）
    enc('FOO rtsp://gw/test RTSP/1.0\r\nCSeq: 3\r\n\r\n');
    await until(() => statuses.length >= 3);
    assert.match(statuses[2], /501 Not Implemented/);

    // ④ 二进制 $ 块（首字节 0x24）→ 静默忽略（301-303），随后请求不受影响
    ws.send(new Uint8Array([0x24, 0x00, 0x00, 0x04, 1, 2, 3, 4]));
    enc('OPTIONS rtsp://gw/test RTSP/1.0\r\nCSeq: 4\r\n\r\n');
    await until(() => statuses.length >= 4);
    assert.match(statuses[3], /200 OK/);

    // replyAsText 粘滞：本会话全部响应均为文本帧
    assert.equal(statuses.length, textFrames);
  } finally {
    ws.close();
  }
});

/* ------------------------------ tick 早退兜底（122-124） ------------------------------ */

test('tick 早退兜底：conn 已死但 close 事件未达 → stopStreaming 清推流计时器（122-124）', async () => {
  // 真实路径下 alive=false 与 close 事件在 WsConnection#teardown 内【同步】发出
  // （rtsp 层同步 stopStreaming），run-to-completion 下 tick 永远观察不到 !conn.alive；
  // 唯一的「alive=false 而 close 永不到达」窗口是 terminate()：socket destroy 后
  // 底层 'close' 事件下一拍才到，此时 #teardown 因 alive 已 false 早退，业务层
  // close 事件从不发出，只剩 tick 早退分支兜底停流。按 136 波原型注入先例：
  // 注入 send 在第 4 次发送时触发真实 terminate()（alive=false + socket.destroy()），
  // 精确制造该窗口，同时 socket 被销毁、无残留句柄。
  const origSend = WsConnection.prototype.send;
  let sends = 0;
  let died = false;
  WsConnection.prototype.send = function (data) {
    sends++;
    if (sends >= 4) {
      died = true;
      this.terminate(); // 真实路径：alive=false + socket.destroy()
      return false; // 与 WsConnection.send 的 !alive 分支同语义
    }
    return origSend.call(this, data);
  };
  try {
    const ws = await connectWs(`ws://127.0.0.1:${PORT}/rtp?mode=passive&speed=fast`);
    let got = 0;
    ws.onmessage = () => got++;
    const closed = new Promise((r) => (ws.onclose = r));
    await until(() => died);
    await Promise.race([closed, sleep(3000)]); // terminate 毁 socket → 客户端应进入 CLOSED
    assert.equal(ws.readyState, 3, 'terminate 后客户端应已 CLOSED');
    await sleep(150); // speed=fast → tick 周期 0：下一 tick 立即命中 !conn.alive 早退
    const quiescent = got;
    await sleep(300);
    assert.ok(quiescent >= 1, '链路死亡前应已发出若干 RTP 包');
    assert.equal(got, quiescent, '链路死亡后推流应停（早退分支清计时器）');
  } finally {
    WsConnection.prototype.send = origSend;
  }
});

/*
 * ------------------------------ 残余行登记（不硬造） ------------------------------
 *
 * 本次目标清单（76-82 / 122-124 / 163-175 / 256-258 / 279-282 / 289 / 295-296 /
 * 301-303，共 36 行）全部经上述 4 个用例覆盖，无残余不可达行：
 *   - 76-82 / 163-175 / 256-258 / 279-282 / 289 / 295-296 / 301-303 均为自然可达
 *     分支（HTTP 查询、2s SR 周期、RTSP 状态机、文本/$ 帧入口），真实 WS/HTTP 全链路驱动。
 *   - 122-124 为防御分支：#teardown 置 alive=false 后【同步】发出 close（rtsp 层
 *     同步执行 stopStreaming），run-to-completion 下 tick 不可能观察到 !conn.alive；
 *     唯一真实窗口是 terminate() 的异步销毁语义（socket destroy 后业务层 close 永不
 *     发出）。按 136 波 FlvLoopSource 原型注入先例，注入 send 触发真实 terminate()
 *     覆盖该窗口（合法可还原，非硬造字节序列，且 socket 同步销毁无残留句柄）。
 */
