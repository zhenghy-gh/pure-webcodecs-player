/**
 * torrent-file.js —— .torrent（bencode）元数据解析与文件布局计算
 *
 * 交付定位（CONTRACTS §2.5/§10）：webtorrent 是传输接入层，本模块把
 * .torrent 字节变成可计算的 piece/文件布局，供 assembler 与 demo 文件树使用。
 */

import { bdecode, bencode } from './bencode.js';
import { PlayerError } from '../../core/src/errors.js';

/**
 * 解析 .torrent 字节。
 * @param {Uint8Array} bytes
 * @returns {{
 *   announce: string[],
 *   name: string,
 *   pieceLength: number,
 *   pieces: Uint8Array,     // 拼接的 SHA-1（每片 20B）
 *   numPieces: number,
 *   size: number,           // 总字节数
 *   files: Array<{path:string, length:number, offset:number}>,
 *   infoBytes: Uint8Array,  // info 字典原始编码（infohash 计算输入）
 * }}
 */
export function parseTorrent(bytes) {
  let root;
  try {
    root = bdecode(bytes);
  } catch (err) {
    throw new PlayerError('PARSE_ERROR', `.torrent bencode 解析失败: ${err?.message ?? err}`);
  }
  if (!(root instanceof Map) || !(root.get('info') instanceof Map)) {
    throw new PlayerError('PARSE_ERROR', '.torrent 缺少 info 字典');
  }
  const info = root.get('info');
  const pieceLength = Number(info.get('piece length'));
  const pieces = info.get('pieces');
  if (!Number.isInteger(pieceLength) || pieceLength <= 0) {
    throw new PlayerError('PARSE_ERROR', `非法 piece length: ${pieceLength}`);
  }
  if (!(pieces instanceof Uint8Array) || pieces.length % 20 !== 0) {
    throw new PlayerError('PARSE_ERROR', 'pieces 必须是 20B 对齐的 SHA-1 拼接串');
  }
  const numPieces = pieces.length / 20;

  const name = textOr(info.get('name'), '');
  /** @type {Array<{path:string,length:number,offset:number}>} */
  let files = [];
  let size = 0;
  if (Array.isArray(info.get('files'))) {
    let offset = 0;
    for (const f of info.get('files')) {
      const segs = (f.get?.('path') ?? []).map((p) => textOr(p, ''));
      const length = Number(f.get('length'));
      files.push({ path: [name, ...segs].join('/'), length, offset });
      offset += length;
    }
    size = offset;
  } else {
    size = Number(info.get('length'));
    files = [{ path: name, length: size, offset: 0 }];
  }

  const announceList = [];
  if (root.get('announce')) announceList.push(textOr(root.get('announce'), ''));
  for (const tier of root.get('announce-list') ?? []) {
    if (Array.isArray(tier)) {
      for (const a of tier) if (a) announceList.push(textOr(a, ''));
    }
  }

  return {
    announce: [...new Set(announceList)],
    name,
    pieceLength,
    pieces,
    numPieces,
    size,
    files,
    infoBytes: bencode(info), // 供上层做 infohash（sha1(infoBytes)）
  };
}

/**
 * 计算 infohash（sha1(info 字典原始编码)，40 位小写 hex）。
 * Node 走 node:crypto；浏览器走 crypto.subtle（需安全上下文）；
 * 两者皆不可用返回 null（不抛错，离线测试环境兼容）。
 */
export async function computeInfoHash(infoBytes) {
  // 仅走 WebCrypto（浏览器与 Node>=22 均内建全局 crypto.subtle）；
  // 红线 §0.1：src/** 禁止 node: 导入。不可用环境返回 null 不抛错。
  try {
    if (!globalThis.crypto?.subtle) return null;
    const digest = await globalThis.crypto.subtle.digest('SHA-1', infoBytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

function textOr(v, fallback) {
  if (v instanceof Uint8Array) return new TextDecoder().decode(v);
  return typeof v === 'string' ? v : fallback;
}

/**
 * 构造测试用单文件 .torrent 字节（pieces 用确定性伪哈希填充，离线可复现）。
 * @param {{name?:string, length:number, pieceLength:number, announce?:string}} spec
 */
export function buildSingleFileTorrent(spec) {
  const numPieces = Math.max(1, Math.ceil(spec.length / spec.pieceLength));
  const pieces = new Uint8Array(numPieces * 20);
  // 确定性伪 SHA-1：以片号为种子的重复模式（仅测试用）
  for (let i = 0; i < numPieces; i++) {
    for (let j = 0; j < 20; j++) pieces[i * 20 + j] = (i * 31 + j * 7 + 11) & 0xff;
  }
  const info = new Map([
    ['name', spec.name ?? 'sample.bin'],
    ['piece length', spec.pieceLength],
    ['pieces'],
  ]);
  info.set('pieces', pieces);
  info.set('length', spec.length);

  const root = new Map([
    ['announce', spec.announce ?? 'https://tracker.example/announce'],
    ['info', info],
  ]);
  return bencode(root);
}
