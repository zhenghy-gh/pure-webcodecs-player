/**
 * site/skin.js — PurePlay 共享皮肤脚本（权威版）
 *
 * 规范来源：docs/design/视觉规范.md v0.9（designer · 2026-08-25）
 * 约束：纯 ESM、零依赖、具名导出；只做「DOM 皮肤行为」，
 *       不含任何 demux/decode 播放逻辑（那属于各模块 src）。
 * 双环境：浏览器直开可用；Node 下所有 DOM 能力安全降级（不抛异常）。
 */

/** 品牌名常量（改名唯一触点，见视觉规范 §5） */
export const BRAND = 'PurePlay';

/** @typedef {() => void} Disposer 取消订阅/清理函数 */

/* ---------------------------------------------------------------- *
 * 工具
 * ---------------------------------------------------------------- */

/**
 * 微秒时间戳 → 「h:mm:ss / mm:ss」时钟文案。
 * @param {number} us 整数微秒（契约时间基）
 * @param {{total?: boolean}} [opts] total=true 时按总时长补足小时位风格
 * @returns {string}
 */
export function formatClockUs(us, opts = {}) {
  if (!Number.isFinite(us)) return '--:--';
  const neg = us < 0;
  let s = Math.floor(Math.abs(us) / 1e6);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  const out = h > 0 || opts.total ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  return (neg ? '-' : '') + out;
}

/**
 * 码率 → 「3.42 Mbps」文案。
 * @param {number} bps 比特每秒
 * @returns {string}
 */
export function formatBitrate(bps) {
  if (!Number.isFinite(bps) || bps <= 0) return '--';
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(2)} Mbps`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(1)} kbps`;
  return `${Math.round(bps)} bps`;
}

/** 是否在浏览器环境 */
function hasDOM() {
  return typeof document !== 'undefined' && typeof window !== 'undefined';
}

/**
 * 全局快捷键注册。文本输入焦点时自动跳过（避免打字触发）。
 * @param {Record<string, (ev: KeyboardEvent) => void>} map 键位表，如 { ' ': fn, ArrowLeft: fn }
 * @returns {Disposer}
 */
export function bindKeys(map) {
  if (!hasDOM()) return () => {};
  /** @param {KeyboardEvent} ev */
  const onKey = (ev) => {
    const t = /** @type {HTMLElement|null} */ (ev.target);
    if (t && (/^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(t.tagName) || t.isContentEditable)) return;
    if (ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const fn = map[ev.key] || map[ev.code];
    if (fn) { ev.preventDefault(); fn(ev); }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}

/* ---------------------------------------------------------------- *
 * 滑杆：input 值 ↔ CSS 变量 --p 双向同步
 * ---------------------------------------------------------------- */

/**
 * 把 input[type=range] 当前值写回 --p 百分比变量与 aria-valuetext。
 * @param {HTMLInputElement} el
 * @param {(v: number) => string} [format] aria-valuetext 格式化器
 */
export function syncRange(el, format) {
  const min = Number(el.min) || 0;
  const max = Number(el.max);
  const v = Number(el.value);
  const span = Number.isFinite(max) && max > min ? max - min : 100;
  const pct = Math.max(0, Math.min(100, Number.isFinite(v) ? ((v - min) / span) * 100 : 0));
  el.style.setProperty('--p', String(Math.max(0, Math.min(100, pct))));
  const buffered = Number(el.dataset?.buffered);
  el.style.setProperty('--b', String(Math.max(pct, Number.isFinite(buffered) ? Math.min(100, buffered) : pct)));
  if (format) el.setAttribute('aria-valuetext', format(v));
}

const rangeBindings = new WeakMap();

/**
 * 绑定滑杆：拖动实时刷新 --p 与 .is-scrubbing 态，change 时回调提交。
 * @param {HTMLInputElement} el 目标滑杆（class 含 .pp-range）
 * @param {{format?: (v: number) => string, onInput?: (v: number) => void,
 *          onChange?: (v: number) => void}} [handlers]
 * @returns {Disposer}
 */
export function bindRange(el, handlers = {}) {
  if (!hasDOM() || !el) return () => {};
  rangeBindings.get(el)?.();
  const fmt = handlers.format || (el.dataset?.unit === 'us' ? formatClockUs : undefined);
  let tip = null;
  const wrap = el.parentElement;
  if ((wrap?.classList?.contains('pp-range-wrap') || wrap?.classList?.contains('slider__wrap')) && document.createElement) {
    tip = document.createElement('span');
    tip.className = 'pp-range-tip';
    if (wrap.classList.contains('slider__wrap')) tip.classList.add('slider__tip');
    tip.setAttribute('aria-hidden', 'true');
    wrap.appendChild(tip);
  }
  const scrub = active => {
    if (active) el.classList.add('is-scrubbing');
    else el.classList.remove('is-scrubbing');
    for (const selector of ['.pp-controls', '.pp-stage', '.controls', '.stage']) {
      const parent = el.closest?.(selector);
      if (active) parent?.classList.add('is-scrubbing');
      else parent?.classList.remove('is-scrubbing');
    }
  };
  const onInput = () => {
    scrub(true);
    syncRange(el, fmt);
    handlers.onInput?.(Number(el.value));
  };
  const onChange = () => {
    scrub(false);
    syncRange(el, fmt);
    handlers.onChange?.(Number(el.value));
  };
  let pointerId = null;
  const onDown = event => {
    pointerId = event.pointerId ?? null;
    scrub(true);
  };
  const onCancel = event => {
    if (pointerId !== null && event?.pointerId !== undefined && event.pointerId !== pointerId) return;
    pointerId = null;
    scrub(false);
  };
  const onMove = event => {
    if (!tip || !fmt) return;
    const rect = el.getBoundingClientRect();
    const ratio = rect.width ? Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) : 0;
    tip.style.setProperty('--tip-x', `${ratio * 100}%`);
    tip.textContent = fmt(Number(el.min) + ratio * (Number(el.max) - Number(el.min)));
  };
  const listeners = [[el, 'input', onInput], [el, 'change', onChange], [el, 'pointerdown', onDown],
    [el, 'pointermove', onMove], [el, 'lostpointercapture', () => onCancel()], [el, 'blur', () => onCancel()],
    [window, 'pointerup', onCancel], [window, 'pointercancel', onCancel]];
  for (const [target, event, fn] of listeners) target.addEventListener(event, fn);
  syncRange(el, fmt); // Initial paint must never invoke a business callback.
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const [target, event, fn] of listeners) target.removeEventListener(event, fn);
    scrub(false);
    tip?.remove();
    if (rangeBindings.get(el) === dispose) rangeBindings.delete(el);
  };
  rangeBindings.set(el, dispose);
  return dispose;
}

/* ---------------------------------------------------------------- *
 * 拖放区
 * ---------------------------------------------------------------- */

/**
 * 绑定拖放区：dragover 高亮 .is-over；drop 回调 File 列表；
 * 单个文本文件可走 onText 直接拿内容。
 * @param {HTMLElement} zone class 含 .pp-drop 的元素
 * @param {{onFiles?: (files: File[]) => void, onText?: (text: string, file: File) => void}} cbs
 * @returns {Disposer}
 */
export function bindDrop(zone, cbs = {}) {
  if (!hasDOM() || !zone) return () => {};
  /** @param {DragEvent} ev */
  const over = (ev) => { ev.preventDefault(); zone.classList.add('is-over'); };
  /** @param {DragEvent} ev */
  const leave = () => zone.classList.remove('is-over');
  /** @param {DragEvent} ev */
  const drop = async (ev) => {
    ev.preventDefault();
    zone.classList.remove('is-over');
    const files = Array.from(ev.dataTransfer?.files ?? []);
    if (cbs.onFiles && files.length) cbs.onFiles(files);
    if (cbs.onText && files.length === 1 && /\.(srt|vtt|ass|ssa|txt)$/i.test(files[0].name)) {
      try { cbs.onText(await files[0].text(), files[0]); } catch { /* 读取失败交给调用方处理 */ }
    }
  };
  zone.addEventListener('dragover', over);
  zone.addEventListener('dragleave', leave);
  zone.addEventListener('drop', drop);
  return () => {
    zone.removeEventListener('dragover', over);
    zone.removeEventListener('dragleave', leave);
    zone.removeEventListener('drop', drop);
  };
}

/* ---------------------------------------------------------------- *
 * Toast 轻提示
 * ---------------------------------------------------------------- */

let /** @type {HTMLElement|null} */ toastWrap = null;

/**
 * 弹出轻提示（右上顶部居中，见视觉规范）。
 * @param {{type?: 'info'|'ok'|'warn'|'danger'|'success'|'error', title: string, detail?: string,
 *          timeoutMs?: number, timeout?: number}} o type 默认 info；danger 不自动关闭
 * @returns {() => void} 手动关闭函数
 */
export function toast(o) {
  if (!hasDOM()) return () => {};
  if (!toastWrap || !toastWrap.isConnected) {
    toastWrap = document.createElement('div');
    toastWrap.className = 'pp-toast-wrap';
    toastWrap.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastWrap);
  }
  const type = ({ success: 'ok', error: 'danger' })[o.type] || o.type || 'info';
  const el = document.createElement('div');
  el.className = `pp-toast pp-toast--${type}`;
  if (type === 'danger') el.setAttribute('role', 'alert');
  const main = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'pp-toast__title';
  title.textContent = o.title || '';
  main.appendChild(title);
  if (o.detail) {
    const d = document.createElement('div');
    d.className = 'pp-toast__detail';
    d.textContent = o.detail;
    main.appendChild(d);
  }
  const btn = document.createElement('button');
  btn.className = 'pp-toast__close';
  btn.type = 'button';
  btn.setAttribute('aria-label', '关闭提示');
  btn.textContent = '×';
  el.append(main, btn);
  toastWrap.appendChild(el);

  /** 关闭当前 toast */
  const close = () => { el.remove(); if (timer) clearTimeout(timer); btn.removeEventListener?.('click', close); };
  let timer = 0;
  const timeout = o.timeoutMs ?? o.timeout ?? (type === 'danger' ? 0 : type === 'warn' ? 5000 : 3000);
  if (timeout > 0) timer = /** @type {any} */ (setTimeout(close, timeout));
  btn.addEventListener('click', close);
  return close;
}

/* ---------------------------------------------------------------- *
 * 页签高亮 + 入口
 * ---------------------------------------------------------------- */

/**
 * 规范化静态页面路径：目录和 index.html 等价，部署前缀保持不变。
 */
export function normalizePagePath(pathname) {
  return pathname.replace(/\/index\.html?$/, '').replace(/\/+$/, '') || '/';
}
export function isCurrentPage(href, current) {
  try {
    const destination = new URL(href, current);
    const here = new URL(current);
    return destination.origin === here.origin && normalizePagePath(destination.pathname) === normalizePagePath(here.pathname);
  } catch { return false; }
}
export function initTabs(root) {
  if (!hasDOM()) return () => {};
  for (const link of (root || document).querySelectorAll('.pp-tabs__item, .tabs__item')) {
    const active = isCurrentPage(link.dataset?.href || link.getAttribute('href'), window.location.href);
    link.classList.toggle('is-active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  return () => {};
}

/**
 * 皮肤入口：初始化页面内全部 .pp-range 的双向绑定与页签高亮。
 * 幂等：重复调用会先清理上一次的绑定。
 * @param {{ranges?: boolean}} [options] ranges=false：由页面控制器显式绑定滑杆
 * @returns {Disposer} 总清理函数
 */
export function initSkin(options = {}) {
  if (!hasDOM()) return () => {}; // Node 环境：不支持但不抛异常（契约 §0.3）
  const w = /** @type {any} */ (window);
  if (typeof w.__PP_SKIN_DISPOSER__ === 'function') w.__PP_SKIN_DISPOSER__();

  /** @type {Disposer[]} */
  const disposers = [];
  for (const el of options.ranges === false ? [] : Array.from(document.querySelectorAll('input.pp-range'))) {
    if (!rangeBindings.has(el)) disposers.push(bindRange(/** @type {HTMLInputElement} */ (el)));
  }
  disposers.push(initTabs());

  const disposeAll = () => {
    while (disposers.length) disposers.pop()?.();
    if (w.__PP_SKIN_DISPOSER__ === disposeAll) delete w.__PP_SKIN_DISPOSER__;
  };
  w.__PP_SKIN_DISPOSER__ = disposeAll;
  return disposeAll;
}

/** 秒单位公开 UI 边界；媒体核心仍使用微秒。 */
export function formatTime(sec) {
  return !Number.isFinite(sec) || sec < 0 ? '-:--' : formatClockUs(sec * 1e6).replace(/^0(?=\d:)/, '');
}

const fullscreenBindings = new WeakMap();
const fullscreenPending = new WeakSet();
/** 清理全屏监听/隐藏计时器并恢复控制条的原位置。 */
export function disposeFullscreen(stage) { fullscreenBindings.get(stage)?.(); }
/** 全屏仅作用于指定舞台，绝不挪用其他播放器的控件。 */
export function toggleFullscreen(stage, controls) {
  if (!hasDOM() || !stage) return;
  if (document.fullscreenElement) {
    void Promise.resolve(document.exitFullscreen?.()).catch(() => {});
    return;
  }
  const request = stage.requestFullscreen || stage.webkitRequestFullscreen;
  if (!request) return;
  disposeFullscreen(stage);
  controls ||= stage.querySelector('.pp-controls') || stage.closest('.pp-demo')?.querySelector('.pp-controls');
  const parent = controls?.parentElement;
  const next = controls?.nextSibling;
  let timer = 0;
  let disposed = false;
  const hide = () => {
    if (controls?.contains(document.activeElement) || stage.querySelector('.is-scrubbing, .is-open')) return;
    stage.classList.add('is-controls-hidden');
  };
  const wake = () => {
    stage.classList.remove('is-controls-hidden');
    clearTimeout(timer);
    timer = setTimeout(hide, 3000);
  };
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    for (const event of ['pointermove', 'pointerdown', 'keydown', 'focusin']) stage.removeEventListener(event, wake);
    for (const event of ['pointermove', 'pointerdown', 'keydown', 'focusin']) controls?.removeEventListener(event, wake);
    document.removeEventListener('fullscreenchange', change);
    if (controls && parent && controls.parentElement === stage && parent !== stage) {
      parent.insertBefore(controls, next?.parentElement === parent ? next : null);
    }
    stage.classList.remove('is-fullscreen', 'is-controls-hidden');
    fullscreenPending.delete(stage);
    if (fullscreenBindings.get(stage) === cleanup) fullscreenBindings.delete(stage);
  };
  const change = () => {
    if (document.fullscreenElement === stage) fullscreenPending.delete(stage);
    if (document.fullscreenElement !== stage) { cleanup(); return; }
    stage.classList.add('is-fullscreen');
    wake();
  };
  fullscreenBindings.set(stage, cleanup);
  fullscreenPending.add(stage);
  if (controls && parent !== stage) stage.appendChild(controls);
  document.addEventListener('fullscreenchange', change);
  for (const event of ['pointermove', 'pointerdown', 'keydown', 'focusin']) stage.addEventListener(event, wake);
  for (const event of ['pointermove', 'pointerdown', 'keydown', 'focusin']) controls?.addEventListener(event, wake);
  try { void Promise.resolve(request.call(stage)).catch(cleanup); }
  catch { cleanup(); }
}
