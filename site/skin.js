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
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    const fn = map[ev.key];
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
  const pct = ((v - min) / span) * 100;
  el.style.setProperty('--p', String(Math.max(0, Math.min(100, pct))));
  if (format) el.setAttribute('aria-valuetext', format(v));
}

/**
 * 绑定滑杆：拖动实时刷新 --p 与 .is-scrubbing 态，change 时回调提交。
 * @param {HTMLInputElement} el 目标滑杆（class 含 .pp-range）
 * @param {{format?: (v: number) => string, onInput?: (v: number) => void,
 *          onChange?: (v: number) => void}} [handlers]
 * @returns {Disposer}
 */
export function bindRange(el, handlers = {}) {
  if (!hasDOM() || !el) return () => {};
  const fmt = handlers.format;
  /** @param {Event} ev */
  const onInput = (ev) => {
    el.classList.add('is-scrubbing');
    syncRange(el, fmt);
    if (handlers.onInput) handlers.onInput(Number(/** @type {HTMLInputElement} */ (ev.target).value));
  };
  const onChange = () => {
    el.classList.remove('is-scrubbing');
    syncRange(el, fmt);
    if (handlers.onChange) handlers.onChange(Number(el.value));
  };
  el.addEventListener('input', onInput);
  el.addEventListener('change', onChange);
  syncRange(el, fmt);
  return () => {
    el.removeEventListener('input', onInput);
    el.removeEventListener('change', onChange);
  };
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
 * @param {{type?: 'info'|'ok'|'warn'|'danger', title: string, detail?: string,
 *          timeoutMs?: number}} o type 默认 info；danger 不自动关闭
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
  const type = o.type ?? 'info';
  const el = document.createElement('div');
  el.className = `pp-toast pp-toast--${type}`;
  if (type === 'danger') el.setAttribute('role', 'alert');
  const main = document.createElement('div');
  const title = document.createElement('div');
  title.textContent = o.title;
  main.appendChild(title);
  if (o.detail) {
    const d = document.createElement('div');
    d.style.color = 'var(--pp-text-faint)';
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
  const close = () => { el.remove(); if (timer) clearTimeout(timer); };
  let timer = 0;
  const timeout = o.timeoutMs ?? (type === 'danger' ? 0 : type === 'warn' ? 5000 : 3000);
  if (timeout > 0) timer = /** @type {any} */ (setTimeout(close, timeout));
  btn.addEventListener('click', close);
  return close;
}

/* ---------------------------------------------------------------- *
 * 页签高亮 + 入口
 * ---------------------------------------------------------------- */

/**
 * 按 location.pathname 高亮 [data-pp-tabs] 内匹配的页签。
 * 匹配规则：页签 data-href 或 href 中包含当前路径的模块段（如 /subtitle/demo/ → subtitle）。
 * @returns {Disposer}
 */
function highlightTabs() {
  if (!hasDOM()) return () => {};
  /** @type {HTMLElement[]} */
  const roots = Array.from(document.querySelectorAll('[data-pp-tabs]'));
  /** @param {URL | Location} loc */
  const apply = (loc) => {
    for (const root of roots) {
      for (const a of /** @type {HTMLElement[]} */ (Array.from(root.querySelectorAll('.pp-tabs__item')))) {
        const href = a.dataset.href || (/** @type {HTMLAnchorElement} */ (a).getAttribute('href') || '');
        let hit = false;
        try {
          const seg = new URL(href, loc.href).pathname.split('/').filter(Boolean)[0] ?? '';
          hit = seg !== '' && loc.pathname.includes(`/${seg}/`);
        } catch { hit = false; }
        a.classList.toggle('is-active', hit);
      }
    }
  };
  apply(window.location);
  return () => {};
}

/**
 * 皮肤入口：初始化页面内全部 .pp-range 的双向绑定与页签高亮。
 * 幂等：重复调用会先清理上一次的绑定。
 * @param {{brand?: string}} [_options] 预留：品牌名覆盖等
 * @returns {Disposer} 总清理函数
 */
export function initSkin(_options = {}) {
  if (!hasDOM()) return () => {}; // Node 环境：不支持但不抛异常（契约 §0.3）
  const w = /** @type {any} */ (window);
  if (typeof w.__PP_SKIN_DISPOSER__ === 'function') w.__PP_SKIN_DISPOSER__();

  /** @type {Disposer[]} */
  const disposers = [];
  for (const el of Array.from(document.querySelectorAll('input.pp-range'))) {
    disposers.push(bindRange(/** @type {HTMLInputElement} */ (el)));
  }
  disposers.push(highlightTabs());

  const disposeAll = () => {
    while (disposers.length) disposers.pop()?.();
    delete w.__PP_SKIN_DISPOSER__;
  };
  w.__PP_SKIN_DISPOSER__ = disposeAll;
  return disposeAll;
}
