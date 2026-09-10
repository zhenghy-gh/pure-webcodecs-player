/**
 * subtitle/src/track.js — CONTRACTS v0.2 §8 字幕轨公共接口实现
 * ------------------------------------------------------------
 * probe(bytes) / parseCues(bytes,{format?,encoding?,trackId?}) /
 * createTextTrack(cuesIterable)。字节级入口支持编码声明（GBK 中文 SRT 高发）。
 */
import { detectFormat } from './detect.js';
import { parseSrt } from './srt.js';
import { parseVtt } from './vtt.js';
import { parseAss } from './ass.js';
import { SubtitleError } from './errors.js';

const BOM = /^\uFEFF/;
const encoder = new TextEncoder();

/** 解码字节为文本：encoding 非法或解码失败时回退 utf-8 */
function decodeBytes(bytes, encoding) {
  try {
    return new TextDecoder(encoding || 'utf-8', { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

/**
 * 同步嗅探（契约 §8）：返回 {format:'srt'|'vtt'|'ass'}，未知返回 null。
 * @param {Uint8Array} bytes
 */
export function probe(bytes) {
  try {
    const text = decodeBytes(bytes, 'utf-8').replace(BOM, '');
    const format = detectFormat(text);
    return format ? { format } : null;
  } catch {
    return null;
  }
}

/** 按格式分派到具体解析器 */
function dispatch(text, format) {
  switch (format) {
    case 'srt': return parseSrt(text);
    case 'vtt': return parseVtt(text);
    case 'ass': case 'ssa': return parseAss(text);
    default: throw new SubtitleError('PROBE_FAILED', `无法识别的字幕格式：「${format}」`);
  }
}

/**
 * 字节级 Cue 流（契约 §8）：AsyncIterable<Cue>。
 * Cue 在本地形状上追加 trackId 与 raw（原始条目字节）以满足 §12.3 冻结面。
 * @param {Uint8Array} bytes
 * @param {{format?:string, encoding?:string, trackId?:number}} [options]
 * @returns {AsyncIterable<object>}
 */
export async function* parseCues(bytes, options = {}) {
  const encoding = options.encoding || 'utf-8';
  const text = decodeBytes(bytes, encoding).replace(BOM, '');
  const format = options.format || detectFormat(text);
  if (!format) {
    throw new SubtitleError('PROBE_FAILED', '无法识别的字幕格式（probe 失败）');
  }
  const parsed = dispatch(text, format);
  const trackId = options.trackId ?? 1;
  for (const c of parsed.cues) {
    yield {
      ...c,
      trackId,
      raw: c.raw instanceof Uint8Array ? c.raw : encoder.encode(c.raw ?? c.text),
    };
  }
}

let nextTrackId = 1;

/**
 * 文本轨对象（契约 §8）：把 Cue 流包装成可查询轨。
 * @param {AsyncIterable<object>|Iterable<object>} cuesIterable
 * @returns {{id:number, type:'text', codec:string,
 *           cues:()=>AsyncIterable<object>, cuesUntil:(us:number)=>object[]}}
 */
export function createTextTrack(cuesIterable) {
  const id = nextTrackId++;
  /** @type {object[]} */
  const cache = [];
  let done = false;
  let codec = 'x-srt';

  async function* cachedAndPump() {
    if (!done) {
      // 先整流缓存（原子性保证后续 cuesUntil 可重放），再逐条产出
      for await (const c of cuesIterable) cache.push(c);
      done = true;
      const first = cache[0];
      if (first?.raw) {
        const f = detectFormat(new TextDecoder().decode(first.raw));
        if (f) codec = `x-${f}`;
      }
    }
    for (const c of cache) yield c;
  }

  return {
    id,
    type: 'text',
    get codec() { return codec; },
    cues: () => cachedAndPump(),
    /** 重放活动窗口：startUs ≤ us 的全部已入轨 cue（消费方再按 endUs 过滤在播） */
    cuesUntil(us) {
      return cache.filter((c) => c.startUs <= us);
    },
  };
}
