/**
 * RtspWsClient 未覆盖行补测（第 135 波覆盖率迭代）。
 *
 * 复用「全局对象注入」模式（参照 rtsp-sdp-edge.test.js 的 withGlobals）：
 *   - WebSocket → 可脚本化的 FakeWs（自动 open、按请求方法应答、手动投递字节）
 *   - fetch     → 假实现（驱动 sdpUrl → fetchText 分支）
 *
 * 覆盖点与 client.js 行号对应：
 *   - 116-117  事件处理器抛错隔离（console.error 登记，不中断流程）
 *   - 154-158  WebSocket 连接超时 → ws.close() + TIMEOUT 拒绝
 *   - 169-173  WebSocket 连接失败（onerror）→ NETWORK_ERROR 拒绝
 *   - 199      interleaved 握手直接消费 opts.sdp（免 DESCRIBE）
 *   - 214-216  rtp 模式 sdpUrl → fetchText 成功取 SDP
 *   - 231-233  keepalive：就绪连接周期发送 OPTIONS
 *   - 264-267  RTSP 请求响应超时 → TIMEOUT（虚拟时钟推进）
 *   - 287-289  响应状态码分类（5xx → NETWORK_ERROR，4xx → PARSE_ERROR）
 *   - 327-329  SDP 协商完成前先收到 RTP → 兜底建轨
 *   - 334-336  畸形 RTP 解析失败 → emit('error')
 *   - 379-387  fetchText：ok 校验、5xx/4xx 分类、text 透传
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RtspWsClient, STATES } from '../src/client.js';

// ---------- 测试基建 ----------

/** 最小可用 SDP：单个 H264/90000 视频轨 */
const MIN_SDP = [
  'v=0', 's=Test', 't=0 0',
  'm=video 0 RTP/AVP 96',
  'a=rtpmap:96 H264/90000',
  'a=control:trackID=0',
  '',
].join('\r\n');

/** 临时替换全局对象属性（异步版，finally 还原现场；map 值为假实现函数/类） */
async function withGlobals(map, fn) {
  const saved = new Map();
  for (const [k, v] of Object.entries(map)) {
    saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k) ?? null);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  try {
    return await fn();
  } finally {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(globalThis, k, d);
      else { try { delete globalThis[k]; } catch { /* 非可配置属性：保留原值 */ } }
    }
  }
}

/**
 * 构造可脚本化的 FakeWs。respond(method, cseq, rawText) 返回：
 *   - string         → 按二进制应答（RTSP 响应文本）
 *   - Uint8Array     → 原样按二进制应答（可拼接 interleaved 块 + 响应）
 *   - null/undefined → 不应答（驱动超时路径）
 */
function makeFakeWs({ autoOpen = true, respond = null } = {}) {
  const instances = [];
  class FakeWs {
    constructor(url) {
      this.url = url;
      this.readyState = 0; // CONNECTING
      this.binaryType = '';
      this.sent = []; // 发出的文本（解码后），供断言
      this.closedWith = null;
      instances.push(this);
      if (autoOpen) queueMicrotask(() => this.#open());
    }
    #open() {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.({});
    }
    send(data) {
      const text = new TextDecoder().decode(data);
      this.sent.push(text);
      const cseq = Number(/CSeq:\s*(\d+)/.exec(text)?.[1] ?? 0);
      const method = /^(\S+)/.exec(text)?.[1] ?? '';
      const resp = respond?.(method, cseq, text, this);
      if (resp) this.#deliverLater(resp);
    }
    #deliverLater(payload) {
      queueMicrotask(() => {
        const u8 = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
        const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
        this.onmessage?.({ data: ab });
      });
    }
    close(code, reason) {
      this.closedWith = { code: code ?? null, reason: reason ?? '' };
      this.readyState = 3; // CLOSED
    }
  }
  return { FakeWs, instances };
}

/** 构造 RTSP/1.0 响应文本 */
function rtspResp(cseq, code, reason = 'OK', headers = {}) {
  const lines = [`RTSP/1.0 ${code} ${reason}`, `CSeq: ${cseq}`];
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  return lines.join('\r\n') + '\r\n\r\n';
}

/** 构造最小 RTP 包（V=2，可选 marker，12 字节固定头 + 载荷） */
function rtpPacket({ pt = 96, marker = true, seq = 1, ts = 3000, payload = [0x65, 0x01] } = {}) {
  const b = new Uint8Array(12 + payload.length);
  b[0] = 0x80;
  b[1] = (marker ? 0x80 : 0) | pt;
  const dv = new DataView(b.buffer);
  dv.setUint16(2, seq);
  dv.setUint32(4, ts);
  dv.setUint32(8, 0x12345678);
  b.set(payload, 12);
  return b;
}

/** 构造 interleaved $ 块：0x24 + channel + len(2B BE) + RTP 载荷 */
function interleavedBlock(channel, rtpU8) {
  const out = new Uint8Array(4 + rtpU8.length);
  out[0] = 0x24;
  out[1] = channel;
  out[2] = (rtpU8.length >> 8) & 0xff;
  out[3] = rtpU8.length & 0xff;
  out.set(rtpU8, 4);
  return out;
}

function concatBytes(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询等待条件成立（真实时钟，用于 keepalive 等定时器路径） */
async function waitFor(cond, timeoutMs = 2000, stepMs = 5) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor 等待超时');
    await sleep(stepMs);
  }
}

/** 完整握手应答器：OPTIONS / SETUP / PLAY 全部 200 */
const fullHandshakeRespond = (method, cseq) => {
  if (method === 'OPTIONS') return rtspResp(cseq, 200);
  if (method === 'SETUP') return rtspResp(cseq, 200, 'OK', { Session: 'deadbeef;timeout=30' });
  if (method === 'PLAY') return rtspResp(cseq, 200);
  return null;
};

// ---------- 用例 ----------

test('事件处理器抛错被隔离：console.error 登记且不影响启动流程（116-117）', async () => {
  const { FakeWs } = makeFakeWs({});
  await withGlobals({ WebSocket: FakeWs }, async () => {
    const origError = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args);
    try {
      const c = new RtspWsClient({ url: 'ws://127.0.0.1:9/x', framing: 'rtp' });
      c.on('open', () => { throw new Error('处理器内部错误'); });
      await c.start();
      assert.equal(c.state, STATES.PLAYING, '处理器抛错不应中断连接流程');
      c.stop();
    } finally {
      console.error = origError;
    }
    assert.equal(logged.length, 1, '应恰好登记一次处理器异常');
    assert.match(logged[0][0], /^\[rtsp-ws\] open 处理器异常:/);
    assert.ok(logged[0][1] instanceof Error);
  });
});

test('WebSocket 连接超时：close() 被调用并以 TIMEOUT 拒绝（154-158）', async () => {
  const { FakeWs, instances } = makeFakeWs({ autoOpen: false }); // 永不 open
  await withGlobals({ WebSocket: FakeWs }, async () => {
    const c = new RtspWsClient({ url: 'ws://127.0.0.1:9/x', connectTimeoutMs: 30 });
    await assert.rejects(
      () => c.start(),
      (e) => e.code === 'TIMEOUT' && /连接超时/.test(e.message),
    );
    assert.ok(instances[0].closedWith, '超时后应对未决连接调用 close()');
    assert.equal(c.ws.readyState, 3);
    await assert.rejects(() => c.start(), /不允许重复 start/); // 行 130：非 IDLE/CLOSED 状态守卫
  });
});

test('WebSocket 连接失败：onerror 以 NETWORK_ERROR 拒绝（169-173）', async () => {
  const { FakeWs, instances } = makeFakeWs({ autoOpen: false });
  await withGlobals({ WebSocket: FakeWs }, async () => {
    const c = new RtspWsClient({ url: 'ws://127.0.0.1:9/x', connectTimeoutMs: 5_000 });
    const p = c.start();
    instances[0].onerror?.({}); // 模拟底层连接错误（如端口拒绝）
    await assert.rejects(
      () => p,
      (e) => e.code === 'NETWORK_ERROR' && /连接失败/.test(e.message),
    );
    c.stop();
  });
});

test('构造兜底：无 url 时不做安全校验，opts.url 为空串（67）', () => {
  const c = new RtspWsClient({});
  assert.equal(c.opts.url, '');
  assert.equal(c.state, STATES.IDLE);
});

test('interleaved 握手：opts.sdp 直接消费，跳过 DESCRIBE（199）', async () => {
  const { FakeWs } = makeFakeWs({ respond: fullHandshakeRespond });
  await withGlobals({ WebSocket: FakeWs }, async () => {
    const c = new RtspWsClient({ url: 'ws://127.0.0.1:9/x', sdp: MIN_SDP, keepAliveMs: 3_600_000 });
    const sdpEvents = [];
    c.on('sdp', (e) => sdpEvents.push(e));
    await c.start();
    assert.equal(c.ws.sent.some((t) => t.startsWith('DESCRIBE')), false, '有外部 SDP 时不应发送 DESCRIBE');
    assert.equal(sdpEvents.length, 1, '应恰好触发一次 sdp 事件');
    assert.equal(sdpEvents[0].track.codec, 'h264');
    assert.equal(c.track.codec, 'h264');
    assert.equal(c.track.pt, 96);
    assert.equal(c.session, 'deadbeef', 'Session 头应截断 ;timeout 参数');
    c.stop();
  });
});

test('rtp 模式 sdpUrl：fetch 成功取回 SDP 并完成建轨（214-216, 379-387）', async () => {
  const { FakeWs } = makeFakeWs({});
  const fetched = [];
  const fakeFetch = async (url) => {
    fetched.push(url);
    return { ok: true, status: 200, text: async () => MIN_SDP };
  };
  await withGlobals({ WebSocket: FakeWs, fetch: fakeFetch }, async () => {
    const c = new RtspWsClient({ url: 'ws://127.0.0.1:9/x', framing: 'rtp', sdpUrl: 'http://127.0.0.1:1/sdp' });
    await c.start();
    assert.deepEqual(fetched, ['http://127.0.0.1:1/sdp']);
    assert.equal(c.track.codec, 'h264');
    assert.equal(c.state, STATES.PLAYING);
    c.stop();
  });
});

test('sdpUrl fetch 5xx：归类 NETWORK_ERROR 并携带状态码（379-387）', async () => {
  const { FakeWs } = makeFakeWs({});
  await withGlobals(
    { WebSocket: FakeWs, fetch: async () => ({ ok: false, status: 503, text: async () => '' }) },
    async () => {
      const c = new RtspWsClient({ url: 'ws://127.0.0.1:9/x', framing: 'rtp', sdpUrl: 'http://127.0.0.1:1/sdp' });
      await assert.rejects(
        () => c.start(),
        (e) => e.code === 'NETWORK_ERROR' && /获取 SDP 失败: HTTP 503/.test(e.message),
      );
      c.stop();
    },
  );
});

test('sdpUrl fetch 4xx：归类 PARSE_ERROR 并携带状态码（379-387）', async () => {
  const { FakeWs } = makeFakeWs({});
  await withGlobals(
    { WebSocket: FakeWs, fetch: async () => ({ ok: false, status: 404, text: async () => '' }) },
    async () => {
      const c = new RtspWsClient({ url: 'ws://127.0.0.1:9/x', framing: 'rtp', sdpUrl: 'http://127.0.0.1:1/sdp' });
      await assert.rejects(
        () => c.start(),
        (e) => e.code === 'PARSE_ERROR' && /获取 SDP 失败: HTTP 404/.test(e.message),
      );
      c.stop();
    },
  );
});

test('keepalive：连接就绪后按 keepAliveMs 周期发送 OPTIONS（231-233）', async () => {
  const { FakeWs } = makeFakeWs({ respond: fullHandshakeRespond });
  await withGlobals({ WebSocket: FakeWs }, async () => {
    const c = new RtspWsClient({ url: 'ws://127.0.0.1:9/x', sdp: MIN_SDP, keepAliveMs: 15 });
    await c.start();
    const optionsCount = () => c.ws.sent.filter((t) => t.startsWith('OPTIONS')).length;
    await waitFor(() => optionsCount() >= 2, 2000); // 握手 1 次 + 保活 ≥ 1 次
    assert.ok(c.cseq >= 4, `保活应推进 CSeq，实际 ${c.cseq}`);
    c.stop();
    const n = optionsCount();
    await sleep(40);
    assert.equal(optionsCount(), n, 'stop 后应停止保活');
  });
});

test('RTSP 请求响应超时：8s 无匹配 CSeq 响应以 TIMEOUT 拒绝（264-267）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); // 虚拟时钟：无需真实等待 8s
  const { FakeWs } = makeFakeWs({ respond: () => null }); // 永不回应
  await withGlobals({ WebSocket: FakeWs }, async () => {
    const c = new RtspWsClient({ url: 'ws://127.0.0.1:9/x', sdp: MIN_SDP, connectTimeoutMs: 50_000 });
    const p = c.start().then(() => null, (e) => e);
    await new Promise((r) => setImmediate(r)); // 等待 onopen → OPTIONS 已发出、请求定时器已挂
    t.mock.timers.tick(8_500); // 连接超时(50s)未到；请求超时(8s)触发
    const err = await p;
    assert.equal(err.code, 'TIMEOUT');
    assert.match(err.message, /OPTIONS 响应超时/);
    c.stop();
  });
});

test('RTSP 响应 5xx：归类 NETWORK_ERROR（287-289）', async () => {
  const { FakeWs } = makeFakeWs({
    respond: (method, cseq) => (method === 'OPTIONS' ? rtspResp(cseq, 500, 'Internal Server Error') : null),
  });
  await withGlobals({ WebSocket: FakeWs }, async () => {
    const c = new RtspWsClient({ url: 'ws://127.0.0.1:9/x', sdp: MIN_SDP });
    await assert.rejects(
      () => c.start(),
      (e) => e.code === 'NETWORK_ERROR' && /RTSP 500 Internal Server Error/.test(e.message),
    );
    c.stop();
  });
});

test('RTSP 响应 4xx：归类 PARSE_ERROR（287-289）', async () => {
  const { FakeWs } = makeFakeWs({
    respond: (method, cseq) => (method === 'OPTIONS' ? rtspResp(cseq, 454, 'Session Not Found') : null),
  });
  await withGlobals({ WebSocket: FakeWs }, async () => {
    const c = new RtspWsClient({ url: 'ws://127.0.0.1:9/x', sdp: MIN_SDP });
    await assert.rejects(
      () => c.start(),
      (e) => e.code === 'PARSE_ERROR' && /RTSP 454 Session Not Found/.test(e.message),
    );
    c.stop();
  });
});

test('SDP 协商完成前收到 RTP：兜底建轨出帧，畸形包走 error 事件（327-329, 334-336）', async () => {
  const garbage = Uint8Array.from([0x40, 0x60, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1]); // V=1 → parseRtp 抛错
  const prelude = concatBytes(
    interleavedBlock(0, garbage), // 畸形：触发兜底建轨 + error 事件
    interleavedBlock(0, rtpPacket({ seq: 1, ts: 3000 })), // 合法：兜底轨上出帧
  );
  const { FakeWs } = makeFakeWs({
    respond: (method, cseq) => {
      if (method === 'OPTIONS') return concatBytes(prelude, new TextEncoder().encode(rtspResp(cseq, 200)));
      return fullHandshakeRespond(method, cseq);
    },
  });
  await withGlobals({ WebSocket: FakeWs }, async () => {
    const c = new RtspWsClient({ url: 'ws://127.0.0.1:9/x', sdp: MIN_SDP, keepAliveMs: 3_600_000 });
    const errorsSeen = [];
    const frames = [];
    c.on('error', (e) => errorsSeen.push(e));
    c.on('frame', (f) => frames.push(f));
    await c.start();
    assert.equal(errorsSeen.length, 1, '畸形 RTP 应触发一次 error 事件');
    assert.match(errorsSeen[0].message, /RTP 版本/);
    assert.equal(frames.length, 1, '合法 RTP 应在兜底轨上出帧');
    assert.equal(frames[0].keyframe, true, '单 NAL IDR(0x65) 应判为关键帧');
    assert.equal(c.track.codec, 'h264');
    assert.equal(c.stats.packets, 1, '畸形包不计入收包统计');
    c.stop();
  });
});

/*
 * ------------------------------ 残余行登记（不硬造） ------------------------------
 *
 * 本次目标清单（116-117 / 154-158 / 199 / 214-216 / 231-233 / 264-267 /
 * 287-289 / 327-329 / 334-336 / 379-387）经分析全部可达，均已由上方用例覆盖。
 *
 * subset（client-e2e + client-gaps）下仍不覆盖、但不在本文件重复造用例的行：
 *   - 241-243  request 非 interleaved 模式的 STATE_ERROR 前置拒绝
 *   - 258-261  request 在连接未就绪时 #sendRawText 抛错 → 清理 pendingResolve 并 reject
 *   两者均已由 rtsp-client-edge.test.js 覆盖（全量套件内可达），此处不复制用例。
 *
 * 说明一处行号-语义勘误：任务清单将 334-336 描述为「consumeSdp 异常 → emit('error')」，
 * 实际源码该行为 #handleRtpBytes 内 parseRtp 抛错分支（catch → emit('error') → return）。
 * consumeSdp 内部无裸抛路径：parseSdp 对畸形输入容错返回空结构，
 * 'sdp' 事件处理器抛错已被 #emit 的 try/catch 吞掉，故无需也无法为
 * 「consumeSdp 异常」另造用例。
 */
