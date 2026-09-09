/**
 * mock-signaling.js —— 本地回环 mock 信令实现（无服务依赖）
 *
 * 用途：
 *  - 无 WHEP 服务时的本地联调：answer 由注入的生成器产生；
 *    浏览器场景可传入"第二台 RTCPeerConnection"作为对端（demo 回环演示即此模式），
 *    Node 单测可传入纯函数生成假 answer。
 *  - 形状与 SignalChannel 接口完全一致（connect/exchange/sendCandidate/close），
 *    WebRtcPlayer 零改动接入：new WebRtcPlayer({ signalChannel: createMockSignalChannel(gen) })。
 */

/**
 * @typedef {(offerSdp: string) => Promise<string>|string} AnswerGenerator
 */

/**
 * 创建 mock 信令通道。
 * @param {AnswerGenerator} answerGenerator 收到 offer 后返回 answer SDP
 * @param {{latencyMs?: number}} [options] 模拟信令往返延迟（默认 0）
 */
export function createMockSignalChannel(answerGenerator, options = {}) {
  const latency = options.latencyMs ?? 0;
  const wait = () => (latency > 0 ? new Promise((r) => setTimeout(r, latency)) : Promise.resolve());

  return {
    /** mock 标记，便于诊断区分真实信令 */
    __mock: true,
    connected: false,
    offers: [],
    candidates: [],
    closed: false,

    async connect() {
      this.connected = true;
    },

    /**
     * 接收 offer → 调用生成器 → 返回 answer。
     * @param {string} offerSdp
     */
    async exchange(offerSdp) {
      if (!this.connected) throw new Error('mock 信令未连接（先调用 connect）');
      this.offers.push(offerSdp);
      await wait();
      const answer = await answerGenerator(offerSdp);
      return { sdp: answer, resourceUrl: null };
    },

    /** 记录候选供测试断言 */
    async sendCandidate(candidate) {
      this.candidates.push(candidate);
    },

    drainRemoteCandidates() {
      return [];
    },

    async close() {
      this.closed = true;
    },
  };
}

/**
 * 创建一对互连的 mock 通道（A 的 offer 喂给 B 的生成器，反之亦然）。
 * 典型用法：两端各挂一台 RTCPeerConnection，互相 setRemoteDescription 完成真回环。
 *
 * @param {{aToB?: AnswerGenerator, bToA?: AnswerGenerator}} [handlers]
 */
export function createLoopbackSignalPair(handlers = {}) {
  const wireA = []; // A→B 的消息
  const wireB = []; // B→A 的消息

  const mkSide = (out, in_, gen, name) => ({
    __mock: true,
    name,
    drain: out,
    async connect() {},
    async exchange(offerSdp) {
      out.push(offerSdp);
      const answer = await gen?.(offerSdp);
      if (answer == null) throw new Error(`[${name}] 对端未提供 answer 生成器`);
      in_.push(answer);
      return { sdp: answer, resourceUrl: null };
    },
    async sendCandidate(c) {
      out.push(c);
    },
    drainRemoteCandidates() {
      return [];
    },
    async close() {},
  });

  return {
    sideA: mkSide(wireA, wireB, handlers.aToB, 'A'),
    sideB: mkSide(wireB, wireA, handlers.bToA, 'B'),
    /** 对端收到的 offer/answer 序列（断言用） */
    wireA,
    wireB,
  };
}
