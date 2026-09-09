/**
 * site/js/skin.js — PurePlay 皮肤行为层（DESIGN.md v1.1 §11）
 * 职责 = §11 清单：页签高亮 / range --p·--b 回写与悬停气泡 / toast /
 * 时间与码率格式化 / 全屏包装 / 快捷键注册器 / BRAND。
 * 播放器逻辑归各模块，经 `skin:<key>` CustomEvent 解耦；Node 导入安全。
 */
export const BRAND = 'PurePlay';                       // 改名唯一触点（§2 终裁）
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
const on = (el, ev, fn, op) => el ? (el.addEventListener(ev, fn, op), () => el.removeEventListener(ev, fn, op)) : () => {};
const num = v => Number(v) || 0;
const p2 = n => String(n).padStart(2, '0');

/** 秒 → mm:ss / h:mm:ss（§7.2②） */
export function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '-:--';
  const t = Math.floor(sec);
  return t >= 3600 ? `${Math.floor(t / 3600)}:${p2(Math.floor(t / 60) % 60)}:${p2(t % 60)}` : `${Math.floor(t / 60)}:${p2(t % 60)}`;
}
/** 码率 bps → Mbps/kbps（面板统计用） */
export function formatBitrate(bps) {
  return !Number.isFinite(bps) || bps <= 0 ? '—'
    : bps >= 1e6 ? `${(bps / 1e6).toFixed(2)} Mbps` : `${Math.round(bps / 1e3)} kbps`;
}

/** 页签高亮：location.pathname 与 .tabs__item[href] 后缀匹配（§6.2） */
export function initTabs(root) {
  if (typeof location === 'undefined') return;
  const here = location.pathname.replace(/\/index\.html?$/, '');
  for (const a of $$('.tabs__item', root)) {
    const t = (a.getAttribute('href') || '').replace(/\/index\.html?$/, '').replace(/^\.\.?\//g, '');
    a.classList.toggle('is-active', !!t && here.endsWith(t));
  }
}

let stack;
/** 非阻塞提示（§8.3）：info/success 3s、warn 5s、error 不自动关且 role=alert */
export function toast({ type = 'info', title, detail = '', timeout } = {}) {
  if (typeof document === 'undefined') return () => {};
  if (!stack) {
    stack = Object.assign(document.createElement('div'), { className: 'toast-stack' });
    stack.setAttribute('aria-live', 'polite');
    document.body.appendChild(stack);
  }
  const el = document.createElement('article');
  el.className = `toast toast--${type}`;
  if (type === 'error') el.setAttribute('role', 'alert');
  el.innerHTML = '<span class="toast__icon" aria-hidden="true"></span>'
    + '<span class="toast__msg"><span class="toast__title"></span><span class="toast__detail"></span></span>'
    + '<button class="toast__close" aria-label="关闭"><svg class="icon icon-16"><use href="#i-close"/></svg></button>';
  el.querySelector('.toast__title').textContent = title || '';
  el.querySelector('.toast__detail').textContent = detail;
  const close = () => el.remove();
  on(el.querySelector('.toast__close'), 'click', close);
  stack.appendChild(el);
  const ttl = timeout !== undefined ? timeout : type === 'warn' ? 5000 : type === 'error' ? 0 : 3000;
  const tm = ttl > 0 ? setTimeout(close, ttl) : 0;
  return () => { clearTimeout(tm); close(); };
}

/** 原生 range 皮肤（§7.3）：--p/--b 回写、aria-valuetext、悬停时间气泡；
 *  input 仅预览、change 才提交 seek，拖动中容器加 .is-scrubbing；
 *  data-unit="us" 时气泡按微秒时钟格式化；data-buffered 存缓冲百分比。 */
export function bindRange(el, h = {}) {
  if (!el || typeof el.addEventListener !== 'function') return () => {};
  let wrap = el.parentElement;
  if (!wrap || !wrap.classList.contains('slider__wrap')) {
    wrap = Object.assign(document.createElement('div'), { className: 'slider__wrap' });
    el.replaceWith(wrap); wrap.appendChild(el);
  }
  const tip = document.createElement('span');
  tip.className = 'slider__tip';
  tip.setAttribute('aria-hidden', 'true');
  wrap.appendChild(tip);
  const us = el.dataset.unit === 'us';
  const fmt = v => us ? formatClock(v) : formatTime(v);
  function formatClock(usVal) {
    const s = Math.floor(usVal / 1e6);
    return s >= 3600 ? `${p2(Math.floor(s / 3600))}:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}` : `${Math.floor(s / 60)}:${p2(s % 60)}`;
  }
  const scrub = add => { for (const p of ['.controls', '.stage']) el.closest(p)?.classList.toggle('is-scrubbing', add); };
  const offs = [
    on(el, 'input', () => {
      const max = num(el.max) || 100, p = (num(el.value) / max) * 100;
      el.style.setProperty('--p', p.toFixed(2));
      el.style.setProperty('--b', Math.max(p, num(el.dataset.buffered)).toFixed(2));
      el.setAttribute('aria-valuetext', fmt(num(el.value)));
      h.onPreview?.(num(el.value));
    }),
    on(el, 'change', () => { h.onCommit?.(num(el.value)); }),
    on(el, 'pointerdown', () => scrub(true)),
    on(window, 'pointerup', () => scrub(false)),
    on(el, 'pointermove', e => {
      const r = el.getBoundingClientRect();
      const ratio = r.width ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0;
      tip.style.setProperty('--tip-x', `${ratio * 100}%`);
      tip.textContent = fmt(num(el.min) + ratio * ((num(el.max) || 100) - num(el.min)));
    }),
  ];
  el.dispatchEvent(new Event('input'));
  return () => offs.splice(0).forEach(f => f());
}

/* 全屏包装（§7.2⑦）：对 stage 请求全屏；进入前把 .controls 移入 stage 悬浮，
   退出还原 DOM 位；3s 无操作自动隐藏；fullscreenchange 同步按钮图标。 */
let fsKeep = null;
const fsH = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

function syncFsIcons() {
  const fs = typeof document !== 'undefined' && document.fullscreenElement;
  for (const b of $$('[data-skin="fs"]')) {
    const use = b.querySelector('use');
    if (use) use.setAttribute('href', `#i-${fs ? 'compress' : 'expand'}`);
  }
}
function armHide(stageEl) {
  let t = 0;
  const wake = () => { stageEl.classList.remove('is-controls-hidden'); clearTimeout(t); t = setTimeout(() => stageEl.classList.add('is-controls-hidden'), 3000); };
  const off = on(stageEl, 'pointermove', wake);
  wake();
  return () => { clearTimeout(t); off(); };
}
/** 对 stage 所在全屏切换（Esc/浏览器 UI 退出同样经 fullscreenchange 同步） */
export function toggleFullscreen(stageEl) {
  const doc = typeof document !== 'undefined' ? document : undefined;
  if (!stageEl || !doc) return;
  if (doc.fullscreenElement) { doc.exitFullscreen?.(); return; }
  const req = stageEl.requestFullscreen || stageEl.webkitRequestFullscreen;
  if (!req) return;
  const c = $('.controls', stageEl) || $('.demo__controls');
  let hideDisposer = null;                             // 本 stage 当前的自动隐藏控制器
  if (c && c.parentElement !== stageEl && !fsKeep) {
    fsKeep = { parent: c.parentElement, next: c.nextSibling, controls: c };
    stageEl.appendChild(c);
  }
  if (fsH && !fsH.has(stageEl)) {
    fsH.set(stageEl, () => {
      const active = doc.fullscreenElement === stageEl;
      stageEl.classList.toggle('is-fullscreen', active);
      if (active) { hideDisposer?.(); hideDisposer = armHide(stageEl); }
      else if (fsKeep && fsKeep.controls.parentElement === stageEl) {
        fsKeep.parent.insertBefore(fsKeep.controls, fsKeep.next);
        stageEl.classList.remove('is-controls-hidden');
        fsKeep = null;
        hideDisposer?.(); hideDisposer = null;
      }
      syncFsIcons();
    });
    doc.addEventListener('fullscreenchange', fsH.get(stageEl));
  }
  Promise.resolve(req.call(stageEl)).catch(() => {});
}

/** 快捷键注册器 Skin.bindKeys(map)：key/code → fn；可编辑元素内不触发 */
export function bindKeys(map) {
  if (typeof window === 'undefined') return () => {};
  return on(window, 'keydown', e => {
    const t = /** @type {any} */ (e.target);
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    const fn = map[e.key] || map[e.code];
    if (fn) { e.preventDefault(); fn(e); }
  });
}

/** §11 API 面（具名导出为正典，CONTRACTS §0.4 只用具名约束） */
const Skin = { BRAND, initTabs, bindRange, bindKeys, toggleFullscreen, toast, formatTime, formatBitrate };
export { Skin };
export { Skin as default };   // DESIGN §11 兼容别名，契约例外仅此一处
