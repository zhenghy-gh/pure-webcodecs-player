/**
 * aes-cbc.js —— 纯软件 AES-128-CBC 解密（无填充）
 *
 * 用途：WebCrypto subtle.decrypt 强制校验 PKCS7 填充，个别服务端的
 * HLS 分片未按 RFC 8216 填充时会失败。本实现作为 Aes128Decrypter 的
 * 兜底路径（仅 AES-128 解密方向），逐块 CBC 解密后由调用方决定是否剥填充。
 *
 * 正确性锚点：与 FIPS-197 Appendix C.1 官方向量及 node:crypto 输出交叉验证。
 * 状态布局：列主序，state[i] 中 i = 行 r + 4×列 c（in[r+4c]）。
 *
 * 错误体系：参数非法统一抛 core PlayerError（PARSE_ERROR），收敛契约 §11.3 十码。
 */

import { parseError } from '../../core/src/errors.js';

/* ---------------- S-box 与逆 S-box（程序化生成） ---------------- */

const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);

(function buildSbox() {
  // GF(2^8) 乘法（俄式 peasant，模多项式 x^8+x^4+x^3+x+1 = 0x11b）
  const mul = (a, b) => {
    let p = 0;
    for (let i = 0; i < 8; i++) {
      if (b & 1) p ^= a;
      const hi = a & 0x80;
      a = (a << 1) & 0xff;
      if (hi) a ^= 0x1b;
      b >>= 1;
    }
    return p;
  };
  const inv = new Uint8Array(256);
  for (let i = 1; i < 256; i++) {
    for (let j = 1; j < 256; j++) {
      if (mul(i, j) === 1) {
        inv[i] = j;
        break;
      }
    }
  }
  const rotl8 = (x, n) => ((x << n) | (x >>> (8 - n))) & 0xff;
  for (let i = 0; i < 256; i++) {
    const b = inv[i];
    const s = (b ^ rotl8(b, 1) ^ rotl8(b, 2) ^ rotl8(b, 3) ^ rotl8(b, 4) ^ 0x63) & 0xff;
    SBOX[i] = s;
    INV_SBOX[s] = i;
  }
})();

/* ---------------- GF 常量表 ---------------- */

const MUL2 = new Uint8Array(256);
const MUL3 = new Uint8Array(256);
const MUL9 = new Uint8Array(256);
const MUL11 = new Uint8Array(256);
const MUL13 = new Uint8Array(256);
const MUL14 = new Uint8Array(256);
for (let x = 0; x < 256; x++) {
  const t2 = ((x << 1) ^ (x & 0x80 ? 0x1b : 0)) & 0xff;
  const t4 = ((t2 << 1) ^ (t2 & 0x80 ? 0x1b : 0)) & 0xff;
  const t8 = ((t4 << 1) ^ (t4 & 0x80 ? 0x1b : 0)) & 0xff;
  // 系数二进制分解：9=8+1, 11=8+2+1, 13=8+4+1, 14=8+4+2
  MUL2[x] = t2;
  MUL3[x] = (t2 ^ x) & 0xff;
  MUL9[x] = (t8 ^ x) & 0xff;
  MUL11[x] = (t8 ^ t2 ^ x) & 0xff;
  MUL13[x] = (t8 ^ t4 ^ x) & 0xff;
  MUL14[x] = (t8 ^ t4 ^ t2) & 0xff;
}

/* ---------------- 密钥扩展 ---------------- */

/** AES-128 密钥扩展：输出 176 字节（11 组轮密钥 × 16B） */
export function expandKey128(keyBytes) {
  if (!keyBytes || keyBytes.length !== 16) throw parseError('expandKey128: 需要 16 字节密钥');
  const w = new Uint8Array(176);
  w.set(keyBytes);
  let rcon = 1;
  for (let i = 16; i < 176; i += 4) {
    let t0 = w[i - 4], t1 = w[i - 3], t2 = w[i - 2], t3 = w[i - 1];
    if (i % 16 === 0) {
      // RotWord 后 SubWord，再异或 Rcon
      const tmp = t0;
      t0 = SBOX[t1] ^ rcon;
      t1 = SBOX[t2];
      t2 = SBOX[t3];
      t3 = SBOX[tmp];
      rcon = ((rcon << 1) ^ (rcon & 0x80 ? 0x1b : 0)) & 0xff;
    }
    w[i] = w[i - 16] ^ t0;
    w[i + 1] = w[i - 15] ^ t1;
    w[i + 2] = w[i - 14] ^ t2;
    w[i + 3] = w[i - 13] ^ t3;
  }
  return w;
}

/* ---------------- 逆变换 ---------------- */

function addRoundKey(state, w, off) {
  for (let i = 0; i < 16; i++) state[i] ^= w[off + i];
}

function invSubBytes(s) {
  for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]];
}

/** InvShiftRows：行 r 右移 r ⇒ new(r,j)=cur(r,(j−r) mod 4) */
function invShiftRows(s) {
  for (let r = 1; r < 4; r++) {
    const cur = [s[r], s[r + 4], s[r + 8], s[r + 12]];
    for (let j = 0; j < 4; j++) {
      s[r + 4 * j] = cur[(((j - r) % 4) + 4) % 4];
    }
  }
}

/** InvMixColumns：列向量左乘 [[14,11,13,9],[9,14,11,13],[13,9,14,11],[11,13,9,14]] */
function invMixColumns(s) {
  for (let c = 0; c < 4; c++) {
    const o = c * 4;
    const a0 = s[o], a1 = s[o + 1], a2 = s[o + 2], a3 = s[o + 3];
    s[o] = (MUL14[a0] ^ MUL11[a1] ^ MUL13[a2] ^ MUL9[a3]) & 0xff;
    s[o + 1] = (MUL9[a0] ^ MUL14[a1] ^ MUL11[a2] ^ MUL13[a3]) & 0xff;
    s[o + 2] = (MUL13[a0] ^ MUL9[a1] ^ MUL14[a2] ^ MUL11[a3]) & 0xff;
    s[o + 3] = (MUL11[a0] ^ MUL13[a1] ^ MUL9[a2] ^ MUL14[a3]) & 0xff;
  }
}

/** 单块解密：等价于 AES-128 ECB 解一个块 */
export function decryptBlock(w, input, output) {
  const state = Uint8Array.from(input);
  addRoundKey(state, w, 160); // 轮密钥 10
  for (let round = 9; round >= 1; round--) {
    invShiftRows(state);
    invSubBytes(state);
    addRoundKey(state, w, round * 16);
    invMixColumns(state);
  }
  invShiftRows(state);
  invSubBytes(state);
  addRoundKey(state, w, 0);
  output.set(state);
}

/**
 * CBC 模式整段解密（不处理填充）。
 * @param {Uint8Array} key 16 字节密钥
 * @param {Uint8Array} iv  16 字节 IV
 * @param {Uint8Array} data 密文（长度须为 16 的倍数且非零）
 * @returns {Uint8Array} 明文（尾部填充原样保留，由调用方剥离）
 */
export function aesCbcDecryptNoPadding(key, iv, data) {
  if (!data.length || data.length % 16 !== 0) {
    throw parseError('aesCbcDecryptNoPadding: 数据长度须为非零的 16 的倍数');
  }
  const w = expandKey128(key);
  const out = new Uint8Array(data.length);
  let prev = iv.length === 16 ? Uint8Array.from(iv) : new Uint8Array(16);
  const blockOut = new Uint8Array(16);
  for (let off = 0; off < data.length; off += 16) {
    const cipher = data.subarray(off, off + 16);
    decryptBlock(w, cipher, blockOut);
    for (let i = 0; i < 16; i++) out[off + i] = blockOut[i] ^ prev[i];
    prev = cipher.slice();
  }
  return out;
}

/** 手动剥离 PKCS7（严格校验，非法填充返回 null） */
export function stripPkcs7(data) {
  if (!data.length) return null;
  const pad = data[data.length - 1];
  if (pad < 1 || pad > 16 || pad > data.length) return null;
  for (let i = data.length - pad; i < data.length; i++) {
    if (data[i] !== pad) return null;
  }
  return data.subarray(0, data.length - pad);
}

/** 调试/自检句柄（非公共 API）：暴露逆变换原语供单测逐函数验证 */
export const _debugPrimitives = { invShiftRows, invSubBytes, invMixColumns, addRoundKey, SBOX, INV_SBOX, MUL2, MUL3, MUL9, MUL11, MUL13, MUL14 };
