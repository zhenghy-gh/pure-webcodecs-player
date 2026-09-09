/**
 * SDP（RFC 4566）解析器 —— 面向直播场景的最小实现。
 *
 * 提取目标：
 *   - m= 媒体节（类型/端口/传输协议/payload 类型列表）
 *   - a=rtpmap:<pt> <codec>/<clock>[/<channels>]
 *   - a=fmtp:<pt> k=v;k=v
 *   - H.264：a=fmtp 中的 sprop-parameter-sets=<b64 SPS>,<b64 PPS>
 *   - H.265：a=sprop-vps / a=sprop-sps / a=sprop-pps，及 sprop-max-don-diff
 *
 * 输出结构见 parseSdp() 注释。解码出的参数集为 AnnexB 可直接喂解码器的 NAL 数组。
 */

import { b64ToBytes } from './b64.js';

/** 解析 fmtp 参数串 "packetization-mode=1;sprop-parameter-sets=AAA,BBB" */
export function parseFmtpParams(str) {
  const out = {};
  for (const part of String(str ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    } else if (part.trim()) {
      out[part.trim()] = '';
    }
  }
  return out;
}

/** "AAA,BBB" → [bytes, bytes]；容错空段与 URL 安全字符 */
export function b64ListToNals(list) {
  return String(list ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => b64ToBytes(s.replace(/-/g, '+').replace(/_/g, '/')));
}

/**
 * @param {string} text 完整 SDP 文本
 * @returns {{
 *   version: string|null,
 *   sessionName: string|null,
 *   media: Array<{
 *     type: string, port: string, protocol: string, payloads: number[],
 *     rtpmap: Record<string, {codec:string, clock:number, channels?:number}>,
 *     fmtp: Record<string, string>,
 *     control: string|null,
 *     h264: null | { sps: Uint8Array[], pps: Uint8Array[], packetizationMode: number, profileLevelId: string|null },
 *     h265: null | { vps: Uint8Array[], sps: Uint8Array[], pps: Uint8Array[], maxDonDiff: number },
 *   }>,
 * }}
 */
export function parseSdp(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const result = {
    version: null,
    sessionName: null,
    media: [],
  };

  let current = null; // 当前 m= 节
  // 会话级 sprop（H265 允许放在会话级）
  const sessionLevel = { spropVps: [], spropSps: [], spropPps: [] };
  let inSession = true;

  for (const line of lines) {
    const ch = line[0];
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = ch;
    const value = line.slice(eq + 1);

    if (key === 'v') {
      result.version = value;
    } else if (key === 's') {
      result.sessionName = value;
    } else if (key === 'm') {
      inSession = false;
      const [type, port, proto, pts] = value.split(/\s+/);
      current = {
        type,
        port,
        protocol: proto,
        payloads: (pts ?? '').split(' ').filter(Boolean).map(Number),
        rtpmap: {},
        fmtp: {},
        control: null,
        h264: null,
        h265: null,
        // 媒体级 H265 参数集属性（RFC 7798 允许放在媒体级或会话级）
        _spropVps: [],
        _spropSps: [],
        _spropPps: [],
      };
      result.media.push(current);
    } else if (key === 'a') {
      // 属性分隔符兼容两种形态：a=rtpmap:96 ...（冒号）与 a=sprop-vps=<b64>（等号）
      const sepIdx = value.search(/[:=]/);
      const attr = sepIdx > 0 ? value.slice(0, sepIdx) : value;
      const attrVal = sepIdx > 0 ? value.slice(sepIdx + 1) : '';

      if (!current) {
        // 会话级属性中与 H265 参数集相关者
        collectH265Prop(sessionLevel, attr, attrVal);
        continue;
      }
      // 媒体级 H265 参数集（数组共享，push 直接落入 current）
      collectH265Prop(
        { spropVps: current._spropVps, spropSps: current._spropSps, spropPps: current._spropPps },
        attr,
        attrVal,
      );

      if (attr === 'rtpmap') {
        const sp = attrVal.split(/\s+/);
        const pt = sp[0];
        const rest = sp.slice(1).join(' ');
        const slash = rest.split('/');
        current.rtpmap[pt] = {
          codec: slash[0]?.toUpperCase() ?? '',
          clock: Number(slash[1] ?? 90000),
          channels: slash[2] ? Number(slash[2]) : undefined,
        };
      } else if (attr === 'fmtp') {
        const sp = attrVal.split(/\s+/);
        const pt = sp[0];
        current.fmtp[pt] = sp.slice(1).join(' ');
      } else if (attr === 'control') {
        current.control = attrVal || '*';
      }
    }
  }

  // 汇总每媒体节的编解码专用信息
  for (const m of result.media) {
    for (const [pt, rm] of Object.entries(m.rtpmap)) {
      const params = parseFmtpParams(m.fmtp[pt] ?? '');
      if (rm.codec === 'H264' && !m.h264) {
        // sprop-parameter-sets 形如 "<b64 SPS>,<b64 PPS>"
        const nals = b64ListToNals(params['sprop-parameter-sets']);
        m.h264 = {
          sps: nals.filter((n) => (n[0] & 0x1f) === 7),
          pps: nals.filter((n) => (n[0] & 0x1f) === 8),
          packetizationMode: Number(params['packetization-mode'] ?? 1),
          profileLevelId: params['profile-level-id'] ?? null,
          rawFmtp: m.fmtp[pt] ?? '',
          pt: Number(pt),
          clock: rm.clock,
        };
      }
      if (rm.codec === 'H265' && !m.h265) {
        // 媒体级 fmtp 参数优先，其次媒体级 a=sprop-* 属性，最后会话级
        const vps = b64ListToNals(params['sprop-vps']).length ? b64ListToNals(params['sprop-vps'])
          : m._spropVps.length ? m._spropVps : sessionLevel.spropVps;
        const sps = b64ListToNals(params['sprop-sps']).length ? b64ListToNals(params['sprop-sps'])
          : m._spropSps.length ? m._spropSps : sessionLevel.spropSps;
        const pps = b64ListToNals(params['sprop-pps']).length ? b64ListToNals(params['sprop-pps'])
          : m._spropPps.length ? m._spropPps : sessionLevel.spropPps;
        m.h265 = {
          vps,
          sps,
          pps,
          maxDonDiff: Number(params['sprop-max-don-diff'] ?? 0),
          pt: Number(pt),
          clock: rm.clock,
        };
      }
    }
  }

  return result;
}

function collectH265Prop(bucket, attr, val) {
  if (attr === 'sprop-vps') bucket.spropVps.push(...b64ListToNals(val));
  else if (attr === 'sprop-sps') bucket.spropSps.push(...b64ListToNals(val));
  else if (attr === 'sprop-pps') bucket.spropPps.push(...b64ListToNals(val));
}

/**
 * 从 SDP 提取「首选视频轨」描述，供客户端初始化 depacketizer 与解码器。
 * @returns {null | { codec:'h264'|'h265', pt:number, clock:number,
 *   parameterSets:{vps?:Uint8Array[],sps:Uint8Array[],pps:Uint8Array[]},
 *   maxDonDiff:number, packetizationMode:number }}
 */
export function pickVideoTrack(sdp) {
  for (const m of sdp.media) {
    if (m.type !== 'video') continue;
    if (m.h264) {
      return {
        codec: 'h264',
        pt: m.h264.pt,
        clock: m.h264.clock ?? 90000,
        parameterSets: { sps: m.h264.sps, pps: m.h264.pps },
        maxDonDiff: 0,
        packetizationMode: m.h264.packetizationMode || 1,
      };
    }
    if (m.h265) {
      return {
        codec: 'h265',
        pt: m.h265.pt,
        clock: m.h265.clock ?? 90000,
        parameterSets: { vps: m.h265.vps, sps: m.h265.sps, pps: m.h265.pps },
        maxDonDiff: m.h265.maxDonDiff ?? 0,
        packetizationMode: 1,
      };
    }
  }
  return null;
}
