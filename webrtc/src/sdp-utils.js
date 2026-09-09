/**
 * sdp-utils.js —— SDP 解析辅助（WHEP 信令与播放端共用）
 *
 * 只做"语法 → 结构化对象"，不修改语义。覆盖：
 *  - 会话级行：v=/o=/s=/t=/a=*
 *  - m 行：m=<type> <port> <proto> <fmt...>
 *  - 常用属性：direction、ice-ufrag/pwd、fingerprint、rtpmap/fmtp、candidate
 */

/** 解析 rtpmap 行 "a=rtpmap:<pt> <name>/<clock>[/<channels>]"（名称不含斜杠） */
function parseRtpmap(value) {
  const m = /^(\d+)\s+([A-Za-z0-9-]+)\/(\d+)(?:\/(\d+))?/.exec(value.trim());
  if (!m) return null;
  return { pt: Number(m[1]), name: m[2].toUpperCase(), clockRate: Number(m[3]), channels: m[4] ? Number(m[4]) : 1 };
}

/**
 * 解析 SDP 文本。
 * @param {string} sdp
 * @returns {{session:Object, media:Array<Object>}}
 */
export function parseSdp(sdp) {
  const session = {
    version: null,
    origin: null,
    name: null,
    timing: null,
    attributes: {},
    lines: [],
  };
  /** @type {Array} */
  const media = [];
  let current = null;

  for (const raw of sdp.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const prefix = line.charAt(0);
    const body = line.slice(2);

    if (prefix === 'm') {
      const parts = body.split(/\s+/);
      current = {
        type: parts[0], // audio | video | application
        port: Number(parts[1]),
        proto: parts[2],
        formats: parts.slice(3),
        direction: null,
        mid: null,
        iceUfrag: null,
        icePwd: null,
        setup: null,
        fingerprint: null,
        rtcpMux: false,
        codecs: [],
        candidates: [],
        ssrcGroups: [],
        ssrcs: [],
        extmaps: [],
      };
      media.push(current);
      continue;
    }

    if (!current) {
      // 会话级
      session.lines.push(line);
      switch (prefix) {
        case 'v': session.version = Number(body); break;
        case 'o': session.origin = body; break;
        case 's': session.name = body; break;
        case 't': session.timing = body; break;
        case 'a': {
          const eqAt = body.indexOf(':');
          if (eqAt < 0) session.attributes[body] = true;
          else session.attributes[body.slice(0, eqAt)] = body.slice(eqAt + 1);
          break;
        }
        default: break;
      }
      continue;
    }

    if (prefix === 'a') {
      const colonAt = body.indexOf(':');
      const attrName = colonAt < 0 ? body : body.slice(0, colonAt);
      const attrValue = colonAt < 0 ? undefined : body.slice(colonAt + 1);
      switch (attrName) {
        case 'sendrecv': case 'sendonly': case 'recvonly': case 'inactive':
          current.direction = attrName;
          break;
        case 'mid': current.mid = attrValue; break;
        case 'ice-ufrag': current.iceUfrag = attrValue; break;
        case 'ice-pwd': current.icePwd = attrValue; break;
        case 'setup': current.setup = attrValue; break;
        case 'fingerprint': current.fingerprint = attrValue; break;
        case 'rtcp-mux': current.rtcpMux = true; break;
        case 'rtpmap': {
          const r = parseRtpmap(attrValue || '');
          if (r) current.codecs.push(r);
          break;
        }
        case 'fmtp': {
          const sp = (attrValue || '').indexOf(' ');
          if (sp > 0) {
            const pt = Number(attrValue.slice(0, sp));
            const codec = current.codecs.find((c) => c.pt === pt);
            if (codec) codec.fmtp = attrValue.slice(sp + 1);
          }
          break;
        }
        case 'extmap': current.extmaps.push(attrValue || ''); break;
        case 'candidate': current.candidates.push(parseCandidateLine(attrValue || '')); break;
        case 'ssrc': {
          const sp2 = (attrValue || '').indexOf(' ');
          current.ssrcs.push({
            id: sp2 > 0 ? attrValue.slice(0, sp2) : attrValue,
            attribute: sp2 > 0 ? attrValue.slice(sp2 + 1) : '',
          });
          break;
        }
        default: break; // 未知属性静默保留在原始行里
      }
      current.rawAttrs ??= [];
      current.rawAttrs.push(line);
      continue;
    }

    if (prefix === 'c') current.connection = body;
  }

  return { session, media };
}

/**
 * 解析 "a=candidate:" 后的候选字段（RFC 8445 序列化格式）。
 */
export function parseCandidateLine(value) {
  const v = value.replace(/^candidate:/, '');
  const f = v.split(/\s+/);
  if (f.length < 8) return null;
  return {
    foundation: f[0],
    component: Number(f[1]),
    protocol: f[2].toLowerCase(),
    priority: Number(f[3]),
    address: f[4],
    port: Number(f[5]),
    type: f[7], // host | srflx | prflx | relay
    relatedAddress: f[9] || null,
    relatedPort: f[11] ? Number(f[11]) : null, // f[8]='raddr' f[9]=值 f[10]='rport' f[11]=值
  };
}

/**
 * 统计 SDP 中媒体行与编解码概况（供信令校验与测试断言）。
 */
export function summarizeSdp(sdp) {
  const { session, media } = parseSdp(sdp);
  return {
    bundle: !!session.attributes.group && String(session.attributes.group).includes('BUNDLE'),
    mediaCount: media.length,
    mediaTypes: media.map((m) => m.type),
    directions: media.map((m) => m.direction),
    codecs: media.flatMap((m) => m.codecs.map((c) => `${m.type[0]}:${c.name}`)),
    hasIce: media.every((m) => m.iceUfrag && m.icePwd),
    hasDtls: media.every((m) => !!m.fingerprint),
    candidateCount: media.reduce((n, m) => n + m.candidates.filter(Boolean).length, 0),
  };
}
