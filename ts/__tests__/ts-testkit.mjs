/**
 * ts-testkit.mjs —— 本波补充测试的共享辅助（非 .test. 文件，不会被测试 glob 选中执行）。
 * 仅用于精简各测试文件中的包构造/引擎驱动样板，不改动任何 src 或已有测试。
 */
import { TsStreamEngine } from '../src/ts-stream-engine.js';
import {
  resetCc, buildPAT, buildPMT, sectionToPackets, dataToPackets,
  buildPes, h264IdrSlice, h264NonIdrSlice, annexb,
} from './fixtures/build-ts.mjs';

export const VIDEO_PID = 0x0101;
export const AUDIO_PID = 0x0102;
export const PMT_PID = 0x1000;

/** 拼接字节数组 */
export function concatBytes(list) {
  const total = list.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of list) { out.set(b, off); off += b.length; }
  return out;
}

/**
 * 精确构造单个 188 字节 TS 包（绕过 build-ts 的 CC 自增与填充策略）。
 * @param {object} o
 *   pid, payload(Uint8Array), pusi, tei, afControl(0x00/0x01/0x02/0x03),
 *   cc, afLen(自适应域长度，仅 afControl&0x02 时生效), afFlags(AF flags 字节),
 *   scrambling(0..3)
 */
export function mkPacket(o = {}) {
  const {
    pid = 0x0100,
    payload = new Uint8Array(0),
    pusi = false,
    tei = false,
    afControl = 0x01,
    cc = 0,
    afLen = 0,
    afFlags = 0x00,
    scrambling = 0,
  } = o;
  const pkt = new Uint8Array(188);
  pkt[0] = 0x47;
  pkt[1] = (tei ? 0x80 : 0) | (pusi ? 0x40 : 0) | ((pid >> 8) & 0x1f);
  pkt[2] = pid & 0xff;
  pkt[3] = ((scrambling & 0x03) << 6) | ((afControl & 0x03) << 4) | (cc & 0x0f);
  let offset = 4;
  if (afControl & 0x02) {
    pkt[4] = afLen;
    if (afLen >= 1) pkt[5] = afFlags;        // discontinuity=0x80，PCR_flag=0x10
    offset = 4 + 1 + afLen;
  }
  const space = 188 - offset;
  if (space > 0) pkt.set(payload.subarray(0, space), offset);
  return pkt;
}

/** 标准 program：PAT + PMT(默认声明一路 H264@VIDEO_PID) */
export function makeProgram(extraStreams = []) {
  resetCc();
  return [
    ...sectionToPackets(0x0000, buildPAT([{ number: 1, pid: PMT_PID }])),
    ...sectionToPackets(PMT_PID, buildPMT({
      pcrPid: VIDEO_PID,
      streams: [{ streamType: 0x1b, pid: VIDEO_PID }, ...extraStreams],
    })),
  ];
}

/**
 * 构造一个已就绪的引擎并驱动：push(bytes) + flush()，收集事件。
 * @returns {{ engine, samples:object[], tracksEmitted:number, warns:string[], errors:Error[] }}
 */
export function drive(bytes, { prePush } = {}) {
  const engine = new TsStreamEngine();
  const samples = [];
  let tracksEmitted = 0;
  const warns = [];
  const errors = [];
  engine.on('sample', (s) => samples.push(s));
  engine.on('tracks', () => tracksEmitted++);
  engine.on('warn', (e) => warns.push(e.message));
  engine.on('error', (e) => errors.push(e));
  if (prePush) prePush(engine);
  engine.push(bytes);
  engine.flush();
  return { engine, samples, tracksEmitted, warns, errors };
}

/** 把一个 PAT/PMT/ES 的 TS 字节流喂入引擎，passthrough 返回 engine */
export function feed(engine, bytes) {
  engine.push(bytes);
  return engine;
}

/** 已就绪引擎（packetSize=188，syncOffsetInCell=0），便于直接调用 _parsePacket 做分支隔离 */
export function mkEngine() {
  const e = new TsStreamEngine();
  e.packetSize = 188;
  e.syncOffsetInCell = 0;
  return e;
}

/** 挂接事件收集器，返回 {samples,warns,errors,tracks,pcrs} */
export function attachCollector(e) {
  const ev = { samples: [], warns: [], errors: [], tracks: [], pcrs: [] };
  e.on('sample', (s) => ev.samples.push(s));
  e.on('warn', (err) => ev.warns.push(err.message));
  e.on('error', (err) => ev.errors.push(err));
  e.on('tracks', (t) => ev.tracks.push(t));
  e.on('pcr', (p) => ev.pcrs.push(p));
  return ev;
}

/** 构造一个 PSI 单元包：payload = [pointer_field] + section，可带 AF 填充 */
export function psiCell(pid, section, opts = {}) {
  const inner = concatBytes([new Uint8Array([opts.pointerField ?? 0]), section]);
  return mkPacket({
    pid,
    pusi: opts.pusi ?? true,
    afControl: opts.afControl ?? 0x01,
    afLen: opts.afLen ?? 0,
    afFlags: opts.afFlags ?? 0x00,
    cc: opts.cc ?? 0,
    payload: inner,
  });
}
