/**
 * NAL 单元与 AnnexB 字节流工具（H.264 / H.265 通用）。
 *
 * AnnexB：[00 00 00 01] NAL [00 00 00 01] NAL ...
 * AVCC： [4 字节大端长度] NAL ...（FLV/MP4 内使用）
 */

const START_CODE = Uint8Array.from([0, 0, 0, 1]);
const START_CODE_3 = Uint8Array.from([0, 0, 1]);

/** 拼接为 AnnexB */
export function toAnnexb(nals) {
  let len = 0;
  for (const n of nals) len += 4 + n.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const n of nals) {
    out.set(START_CODE, off);
    off += 4;
    out.set(n, off);
    off += n.length;
  }
  return out;
}

/** 从 AnnexB 流切分 NAL（容忍 3/4 字节起始码；输入应不含跨包截断） */
export function fromAnnexb(bytes) {
  const marks = []; // { nalStart: 起始码起点（含前导零）, payloadStart: NAL 首字节 }
  for (let i = 0; i + 2 < bytes.length; i++) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
      let start = i;
      while (start > 0 && bytes[start - 1] === 0) start--; // 归并 4 字节起始码的前导零
      marks.push({ nalStart: start, payloadStart: i + 3 });
      i += 2;
    }
  }
  const nals = [];
  for (let k = 0; k < marks.length; k++) {
    const from = marks[k].payloadStart;
    const to = k + 1 < marks.length ? marks[k + 1].nalStart : bytes.length;
    if (to > from) nals.push(bytes.subarray(from, to));
  }
  return nals;
}

/** AVCC（长度前缀封装）→ NAL 数组。lengthSize 通常为 4。 */
export function avccToNals(data, lengthSize = 4) {
  const nals = [];
  let off = 0;
  while (off + lengthSize <= data.length) {
    let len = 0;
    for (let i = 0; i < lengthSize; i++) len = (len << 8) | data[off + i];
    off += lengthSize;
    if (len === 0 || off + len > data.length) break; // 容错
    nals.push(data.subarray(off, off + len));
    off += len;
  }
  return nals;
}

/** NAL 数组 → AVCC 封装字节 */
export function nalsToAvcc(nals, lengthSize = 4) {
  let len = 0;
  for (const n of nals) len += lengthSize + n.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const n of nals) {
    const l = n.length;
    out[off + lengthSize - 1] = l & 0xff;
    out[off + lengthSize - 2] = (l >> 8) & 0xff;
    out[off + lengthSize - 3] = (l >> 16) & 0xff;
    out[off + lengthSize - 4] = (l >> 24) & 0xff;
    off += lengthSize;
    out.set(n, off);
    off += n.length;
  }
  return out;
}

/** H264 判定关键帧（IDR）：扫描 AU 的 NAL 中是否存在类型 5 */
export function h264IsKeyframe(nals) {
  return nals.some((n) => (n[0] & 0x1f) === 5);
}

/** H265 关键帧：IDR_W_RADL(19)/IDR_N_LP(20)/CRA(21) 视作关键帧入口 */
export function h265IsKeyframe(nals) {
  return nals.some((n) => {
    const t = (n[0] >> 1) & 0x3f;
    return t === 19 || t === 20 || t === 21;
  });
}
