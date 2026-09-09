/**
 * 同构 Base64 工具：浏览器（atob/btoa）与 Node（Buffer）双端可用。
 * 本模块零第三方依赖，且必须能在浏览器直接以 <script type="module"> 加载。
 */

export function b64ToBytes(b64) {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  throw new Error('当前环境无 atob/Buffer，无法解码 Base64');
}

export function bytesToB64(bytes) {
  let u8 = bytes;
  if (typeof Buffer !== 'undefined' && typeof atob !== 'function') {
    return Buffer.from(u8).toString('base64');
  }
  if (typeof btoa === 'function') {
    let bin = '';
    u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    return btoa(bin);
  }
  if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
  throw new Error('当前环境无 btoa/Buffer，无法编码 Base64');
}
