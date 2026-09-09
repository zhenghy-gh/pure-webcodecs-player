/**
 * wav/src/waveform.js — 波形峰值计算与 Canvas 绘制
 * ------------------------------------------------------------
 * 绘制函数接受「canvas 2D context 形状」的对象（鸭子类型），
 * 因此 Node 单测可用 mock context 验证绘制调用，无需真实 DOM。
 */

/**
 * 计算波形峰值包络：把整段采样按帧均分为 buckets 桶，
 * 每桶取跨通道的 min/max（多声道合并为单列）。
 * @param {Float32Array[]} planar 每通道一个数组
 * @param {number} buckets 目标桶数（建议 = 画布 CSS 宽度）
 * @returns {{mins:Float32Array, maxs:Float32Array}}
 */
export function computePeaks(planar, buckets) {
  if (!planar || !planar.length) return { mins: new Float32Array(0), maxs: new Float32Array(0) };
  const totalFrames = planar[0].length;
  const n = Math.max(1, Math.min(buckets | 0 || 1, totalFrames || 1));
  const mins = new Float32Array(n);
  const maxs = new Float32Array(n);
  const per = totalFrames / n;

  for (let b = 0; b < n; b++) {
    const start = Math.floor(b * per);
    const end = Math.min(totalFrames, Math.floor((b + 1) * per) + 1); // +1 防缝隙漏帧
    let mn = 1;
    let mx = -1;
    for (const ch of planar) {
      for (let i = start; i < end; i++) {
        const v = ch[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
    mins[b] = mn;
    maxs[b] = mx;
  }
  return { mins, maxs };
}

/**
 * 把波形画到 canvas 上：已播部分用 accent 色，未播部分用暗色。
 * @param {CanvasRenderingContext2D} ctx 2D context（或同形状 mock）
 * @param {{width:number, height:number}} size 画布 CSS 尺寸
 * @param {{mins:Float32Array, maxs:Float32Array}} peaks computePeaks 结果
 * @param {number} progress01 播放进度 0~1
 * @param {{bg?:string, dim?:string, accent?:string, barGap?:number}} [theme]
 */
export function drawWaveform(ctx, size, peaks, progress01, theme = undefined) {
  const t = { bg: '#0d1117', dim: '#3a4560', accent: '#6c8cff', barGap: 0, ...theme };
  const { width, height } = size;
  ctx.fillStyle = t.bg;
  ctx.fillRect(0, 0, width, height);

  const n = peaks.mins.length;
  if (!n) return;
  const barW = width / n;
  const mid = height / 2;
  const progressX = width * Math.min(1, Math.max(0, progress01));

  for (let b = 0; b < n; b++) {
    const x = b * barW;
    const top = mid - peaks.maxs[b] * mid;
    const bottom = mid - peaks.mins[b] * mid;
    const h = Math.max(1, bottom - top);
    // 已播放到 x 的桶使用高亮色
    ctx.fillStyle = x + barW <= progressX ? t.accent : t.dim;
    ctx.fillRect(x, top, Math.max(0.5, barW - t.barGap), h);
  }
}
