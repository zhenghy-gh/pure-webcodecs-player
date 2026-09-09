/**
 * site/player-ui.js — 通用播放控制条（工厂函数 + 可选 Web Component）
 * ------------------------------------------------------------
 * 纯 ESM、零依赖、零构建；浏览器直开可用，Node 下导入不报错
 * （所有 DOM 访问都发生在函数调用内部并做存在性守卫）。
 *
 * 设计：以「播放器适配器协议」解耦皮肤与各模块 Player 实例。
 * 任何满足下列最小协议的对象都能被本控制条驱动：
 *
 * @typedef {Object} PlayerAdapter
 * @property {()=>void|Promise<void>} play              播放
 * @property {()=>void}               pause             暂停
 * @property {(sec:number)=>void}     seek              跳转（单位：秒）
 * @property {(v:number)=>void}       [setVolume]       音量 0~1
 * @property {(r:number)=>void}       [setRate]         倍速
 * @property {()=>number|null}        duration          总时长（秒）；null/ Infinity 表示直播或未知
 * @property {()=>number}             currentTime       当前时间（秒）
 * @property {boolean}                [seekable]        是否可拖动进度，默认 true
 * @property {number[]}               [rates]           倍速档位，默认 [0.5,0.75,1,1.25,1.5,2]
 * @property {((ev:string,cb:(p?:any)=>void)=>function)} [on] 订阅事件，返回退订函数
 * @property {()=>Array<[string,string]>} [getStats]     统计面板数据源（[键,值] 对数组）
 *
 * 适配器需向 `on` 转发的事件：
 *   'time'({currentTime,duration}) | 'play' | 'pause' | 'ended'
 *   'ready' | 'buffering'(boolean) | 'error'(Error)
 */

/* ---------- 内部迷你事件发射器 ---------- */
class MiniEmitter {
  #map = new Map();
  /** @returns {()=>void} 退订函数 */
  on(ev, fn) {
    let list = this.#map.get(ev);
    if (!list) this.#map.set(ev, (list = []));
    list.push(fn);
    return () => this.off(ev, fn);
  }
  once(ev, fn) {
    const off = this.on(ev, (p) => { off(); fn(p); });
    return off;
  }
  off(ev, fn) {
    const list = this.#map.get(ev);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  emit(ev, payload) {
    const list = this.#map.get(ev);
    if (!list) return;
    for (const fn of [...list]) {
      try { fn(payload); } catch (e) { console.error(`[player-ui] "${ev}" 监听器异常`, e); }
    }
  }
}

/* ---------- 内联 SVG 图标（fill: currentColor） ---------- */
const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.14v13.72c0 .8.87 1.3 1.56.88l11-6.86a1.04 1.04 0 0 0 0-1.76l-11-6.86A1.04 1.04 0 0 0 8 5.14Z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z"/></svg>',
  volumeHigh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3Zm13.5 3a4.5 4.5 0 0 0-2.5-4.03v8.05A4.5 4.5 0 0 0 16.5 12ZM14 2.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77Z"/></svg>',
  volumeMute: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3Zm18.5 3-2.25-2.25-1.41 1.41L20.09 13l-2.25 2.25 1.41 1.41L21.5 14.41l2.25 2.25.66-.75-1.41-1.41Z" transform="translate(-2.4 -2)"/><path d="M21 9.34 19.59 7.93 17.67 9.85 15.76 7.93 14.34 9.34 16.26 11.26 14.34 13.17 15.76 14.59 17.67 12.67 19.59 14.59 21 13.17 19.09 11.26Z"/></svg>',
  stats: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V10h3v10H4Zm6.5 0V4h3v16h-3ZM17 20v-7h3v7h-3Z"/></svg>',
  fullscreen: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6v2H6v4H4V4Zm10 0h6v6h-2V6h-4V4ZM4 14h2v4h4v2H4v-6Zm14 0h2v6h-6v-2h4v-4Z"/></svg>',
};

const DEFAULT_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** 秒 → 「mm:ss」或「h:mm:ss」 */
export function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '-:--';
  const total = Math.floor(sec);
  const s = String(total % 60).padStart(2, '0');
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${s}`;
  return `${m}:${s}`;
}

/**
 * 创建通用播放控制条。
 * @param {{mount?:HTMLElement|string, title?:string, fullscreenEl?:HTMLElement|string,
 *          keyboard?:boolean}} [options]
 *   - mount：挂载容器（元素或选择器）。缺省时由调用方自行 append ui.el。
 *   - fullscreenEl：全屏目标（建议为包含画面与控制条的包装层），默认 ui.el 的父级。
 *   - keyboard：是否注册全局快捷键（空格/方向键/F/M/S），默认 true。
 * @returns {PlayerUIController}
 */
export function createPlayerUI(options = {}) {
  const bus = new MiniEmitter();
  const doc = typeof document !== 'undefined' ? document : undefined;
  if (!doc) throw new Error('[player-ui] createPlayerUI 仅可在浏览器环境使用');

  const root = doc.createElement('div');
  root.className = 'pui';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', options.title ? `播放控制条：${options.title}` : '播放控制条');

  /* ---- 构建 DOM（BEM 类名见 site.css 第 6 节） ---- */
  const btnMain = mkBtn('pui__btn pui__btn--main', ICONS.play, '播放/暂停 (空格)');
  const timeLabel = mkSpan('pui__time',
    `<span class="pui__time-current">0:00</span><span class="pui__time-sep"> / </span><span class="pui__time-total">-:--</span>`);

  const progress = mkDiv('pui__progress');
  progress.innerHTML =
    `<div class="pui__progress-track">
       <div class="pui__progress-buffered"></div>
       <div class="pui__progress-fill"></div>
       <div class="pui__progress-thumb"></div>
     </div>`;
  const fillEl = progress.querySelector('.pui__progress-fill');
  const bufferedEl = progress.querySelector('.pui__progress-buffered');
  const thumbEl = progress.querySelector('.pui__progress-thumb');

  const btnMute = mkBtn('pui__btn', ICONS.volumeHigh, '静音 (M)');
  const volSlider = mkDiv('pui__volume-slider', '<div class="pui__volume-track"><div class="pui__volume-fill" style="width:100%"></div></div>');
  const volFill = volSlider.querySelector('.pui__volume-fill');

  const rateWrap = mkDiv('pui__rate');
  const btnRate = mkBtn('pui__btn pui__rate-btn', '', '倍速');
  btnRate.textContent = '1x';
  const rateMenu = mkDiv('pui__rate-menu');
  rateWrap.append(btnRate, rateMenu);

  const btnStats = mkBtn('pui__btn', ICONS.stats, '统计面板 (S)');
  const btnFull = mkBtn('pui__btn', ICONS.fullscreen, '全屏 (F)');
  const errBar = mkDiv('pui__error');
  const statsBox = mkDiv('pui__stats');

  const volumeGroup = mkDiv('pui__volume');
  volumeGroup.append(btnMute, volSlider);

  root.append(
    btnMain, timeLabel, progress,
    volumeGroup, rateWrap,
    btnStats, btnFull,
    errBar, statsBox,
  );

  /* ---- 状态 ---- */
  let adapter = null;
  let offAdapter = [];
  let curTime = 0;
  let curDur = null;      // 秒；null=未知/直播
  let isLive = false;
  let volume = 1;
  let muted = false;
  let rate = 1;
  let dragging = false;
  let statsTimer = 0;

  const ratesOf = () => (adapter && Array.isArray(adapter.rates) && adapter.rates.length ? adapter.rates : DEFAULT_RATES);

  /** 随控制器销毁一并执行的清理函数集合 */
  const cleanupFns = [];

  /* ---- 渲染辅助 ---- */
  function renderTime() {
    root.querySelector('.pui__time-current').textContent = formatTime(curTime);
    root.querySelector('.pui__time-total').textContent = isLive ? '直播' : formatTime(curDur);
  }
  function renderProgress() {
    if (dragging) return;
    if (isLive || !curDur) {
      progress.classList.add('pui__progress--live');
      fillEl.style.width = '100%';
      thumbEl.style.left = '0%';
      bufferedEl.style.width = '0%';
      return;
    }
    const pct = Math.min(100, Math.max(0, (curTime / curDur) * 100));
    fillEl.style.width = pct + '%';
    thumbEl.style.left = pct + '%';
  }
  function renderVolumeIcon() {
    btnMute.innerHTML = (muted || volume === 0) ? ICONS.volumeMute : ICONS.volumeHigh;
    btnMute.title = muted ? '取消静音 (M)' : '静音 (M)';
  }
  function renderRate() {
    btnRate.textContent = (rate === 1 ? '1' : String(rate).replace(/\.?0+$/, '')) + 'x';
    for (const item of rateMenu.children) {
      item.classList.toggle('pui__rate-item--active', Number(item.dataset.rate) === rate);
    }
  }

  function buildRateMenu() {
    rateMenu.textContent = '';
    for (const r of ratesOf()) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'pui__rate-item';
      b.dataset.rate = String(r);
      b.textContent = r === 1 ? '正常' : `${r}x`;
      b.addEventListener('click', () => {
        setRate(r);
        rateMenu.classList.remove('pui__rate-menu--open');
      });
      rateMenu.appendChild(b);
    }
    renderRate();
  }

  /* ---- 行为命令：全部转发给适配器 ---- */
  function togglePlay() { if (!adapter) return; isPlaying() ? adapter.pause() : adapter.play(); }
  function isPlaying() { return btnMain.getAttribute('data-playing') === '1'; }
  function setPlaying(v) { btnMain.setAttribute('data-playing', v ? '1' : '0'); btnMain.innerHTML = v ? ICONS.pause : ICONS.play; }
  function seekRatio(ratio) {
    if (!adapter || isLive || !curDur) return;
    adapter.seek(Math.min(curDur, Math.max(0, ratio)) * curDur);
  }
  function applyVolume() {
    renderVolumeIcon();
    volFill.style.width = (muted ? 0 : volume * 100) + '%';
    if (adapter && adapter.setVolume) adapter.setVolume(muted ? 0 : volume);
  }
  function setRate(r) {
    rate = r;
    if (adapter && adapter.setRate) adapter.setRate(r);
    renderRate();
  }
  function showError(msg) {
    errBar.textContent = msg || '';
    errBar.classList.toggle('pui__error--show', !!msg);
  }
  function toggleStats(open) {
    const willOpen = open !== undefined ? open : !statsBox.classList.contains('pui__stats--open');
    statsBox.classList.toggle('pui__stats--open', willOpen);
    btnStats.classList.toggle('pui__btn--on', willOpen);
    clearInterval(statsTimer);
    if (willOpen) {
      refreshStats();
      statsTimer = setInterval(refreshStats, 500);
    }
  }
  function refreshStats() {
    if (!adapter || typeof adapter.getStats !== 'function') {
      statsBox.innerHTML = '<span class="pui__stats-empty">当前播放器未提供统计信息（适配器未实现 getStats）。</span>';
      return;
    }
    const rows = adapter.getStats() || [];
    if (!rows.length) { statsBox.innerHTML = '<span class="pui__stats-empty">暂无统计数据。</span>'; return; }
    statsBox.innerHTML =
      '<div class="pui__stats-grid">' +
      rows.map(([k, v]) =>
        `<span><span class="pui__stats-key">${esc(k)}</span>　<span class="pui__stats-val">${esc(String(v))}</span></span>`).join('') +
      '</div>';
  }
  function toggleFullscreen() {
    const target = resolveEl(options.fullscreenEl) || root.parentElement || root;
    if (doc.fullscreenElement) { void doc.exitFullscreen(); return; }
    const anyTarget = /** @type {any} */ (target);
    if (anyTarget.requestFullscreen) void anyTarget.requestFullscreen();
  }

  /* ---- 进度条与音量条的指针交互（Pointer Events，兼容触屏） ---- */
  function bindSlider(el, onRatio, { live } = {}) {
    el.addEventListener('pointerdown', (e) => {
      if (!adapter || (live === false && (isLive || !curDur))) return;
      dragging = true;
      el.setPointerCapture?.(e.pointerId);
      el.classList.add('pui__progress--dragging');
      handle(e);
    });
    el.addEventListener('pointermove', (e) => { if (dragging) handle(e); });
    const end = () => { dragging = false; el.classList.remove('pui__progress--dragging'); };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);

    function handle(e) {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      onRatio(ratio);
    }
  }
  bindSlider(progress, (ratio) => {
    if (!isLive && curDur) {
      fillEl.style.width = ratio * 100 + '%';
      thumbEl.style.left = ratio * 100 + '%';
      root.querySelector('.pui__time-current').textContent = formatTime(ratio * curDur);
      seekRatio(ratio);
    }
  });
  bindSlider(volSlider, (ratio) => {
    volume = ratio;
    muted = ratio === 0;
    applyVolume();
  });

  /* ---- 按钮事件 ---- */
  btnMain.addEventListener('click', togglePlay);
  btnMute.addEventListener('click', () => {
    muted = !muted;
    if (!muted && volume === 0) volume = 0.6;
    applyVolume();
  });
  volSlider.addEventListener('dblclick', () => { volume = 1; muted = false; applyVolume(); });
  btnRate.addEventListener('click', () => rateMenu.classList.toggle('pui__rate-menu--open'));
  btnStats.addEventListener('click', () => toggleStats());
  btnFull.addEventListener('click', toggleFullscreen);
  doc.addEventListener('click', (e) => {
    if (!rateWrap.contains(/** @type {Node} */ (e.target))) rateMenu.classList.remove('pui__rate-menu--open');
  });

  /* ---- 快捷键 ---- */
  if (options.keyboard !== false && typeof window !== 'undefined') {
    const keyHandler = (e) => {
      if (!adapter) return;
      const t = /** @type {any} */ (e.target);
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      switch (e.key) {
        case ' ': case 'k': e.preventDefault(); togglePlay(); break;
        case 'ArrowRight': e.preventDefault(); if (curDur) adapter.seek(Math.min(curDur, curTime + 5)); break;
        case 'ArrowLeft': e.preventDefault(); adapter.seek(Math.max(0, curTime - 5)); break;
        case 'ArrowUp': e.preventDefault(); volume = Math.min(1, volume + 0.1); muted = false; applyVolume(); break;
        case 'ArrowDown': e.preventDefault(); volume = Math.max(0, volume - 0.1); applyVolume(); break;
        case 'f': case 'F': toggleFullscreen(); break;
        case 'm': case 'M': btnMute.click(); break;
        case 's': case 'S': toggleStats(); break;
        default: return;
      }
    };
    window.addEventListener('keydown', keyHandler);
    cleanupFns.push(() => window.removeEventListener('keydown', keyHandler));
  }

  /* ---- 控制器对外 API ---- */
  const ui = {
    /** 根元素（含 .pui 控制条本体） */
    el: root,

    /**
     * 绑定播放器适配器。重复绑定会先解绑旧的。
     * @param {PlayerAdapter|null} a
     */
    bind(a) {
      ui.unbind();
      adapter = a;
      if (!a) return;
      curDur = typeof a.duration === 'function' ? a.duration() : null;
      isLive = curDur === null || !Number.isFinite(curDur);
      curTime = a.currentTime ? a.currentTime() : 0;
      buildRateMenu();
      progress.classList.toggle('pui__progress--live', isLive);
      progress.style.cursor = (a.seekable === false || isLive) ? 'default' : 'pointer';
      showError('');

      if (typeof a.on === 'function') {
        const fwd = (ev, map) => {
          offAdapter.push(a.on(ev, (p) => { map(p); bus.emit(ev, p); }));
        };
        fwd('time', (p) => {
          curTime = Number(p?.currentTime) || 0;
          if (p && 'duration' in p && Number.isFinite(Number(p.duration)) && Number(p.duration) > 0) {
            curDur = Number(p.duration); isLive = false;
            progress.classList.remove('pui__progress--live');
          }
          renderTime(); renderProgress();
        });
        fwd('play', () => setPlaying(true));
        fwd('pause', () => setPlaying(false));
        fwd('ended', () => setPlaying(false));
        fwd('ready', () => {
          curDur = typeof a.duration === 'function' ? a.duration() : curDur;
          isLive = curDur === null || !Number.isFinite(curDur);
          renderTime(); renderProgress();
        });
        fwd('buffering', () => {});
        fwd('error', (err) => showError(`⚠ ${err?.message || String(err)}`));
      }
      renderTime(); renderProgress();
    },

    /** 解除绑定并复位控制条状态 */
    unbind() {
      for (const off of offAdapter.splice(0)) { try { off(); } catch { /* 忽略 */ } }
      adapter = null;
      setPlaying(false);
      curTime = 0; curDur = null; isLive = false;
      showError('');
      renderTime(); renderProgress();
    },

    /** 打开(true)/关闭(false)/翻转(undefined)统计面板 */
    showStats(open) { toggleStats(open); },
    /** 显示一条错误提示（各模块 demo 的解析错误也走这里） */
    setError(msg) { showError(msg); },
    /** 当前绑定的适配器 */
    get adapter() { return adapter; },
    /** 订阅转发自适配器的生命周期事件 */
    on(ev, fn) { return bus.on(ev, fn); },
    off(ev, fn) { bus.off(ev, fn); },
    /** 销毁：解绑、清定时器、移除 DOM 与全局监听 */
    destroy() {
      ui.unbind();
      clearInterval(statsTimer);
      for (const fn of cleanupFns.splice(0)) fn();
      root.remove();
    },
  };

  /* ---- 挂载 ---- */
  const mountEl = resolveEl(options.mount);
  if (mountEl) mountEl.appendChild(root);

  return ui;
}

/** @typedef {ReturnType<typeof createPlayerUI>} PlayerUIController */

/* ===================== 可选 Web Component 封装 ===================== */
/**
 * <player-ui> 轻量封装（light-DOM，直接吃 site.css 样式）。
 * 用法：
 *   const ui = document.querySelector('player-ui');
 *   ui.adapter = myAdapter;          // 绑定播放器
 *   ui.addEventListener('time', e => …); // 原样转发适配器事件
 */
if (typeof HTMLElement !== 'undefined' && typeof customElements !== 'undefined' && !customElements.get('player-ui')) {
  class PlayerUIElement extends HTMLElement {
    connectedCallback() {
      if (this._ui) return;
      this.className = 'pui-root';
      this._ui = createPlayerUI({
        title: this.getAttribute('title') || undefined,
        keyboard: this.getAttribute('keyboard') !== 'off',
      });
      this.appendChild(this._ui.el);
      // 把控制器事件桥接成 DOM CustomEvent
      this._unsubs = [];
      for (const ev of ['time', 'play', 'pause', 'ended', 'ready', 'buffering', 'error']) {
        this._unsubs.push(this._ui.on(ev, (detail) => {
          this.dispatchEvent(new CustomEvent(ev, { detail }));
        }));
      }
      // 已在属性上预先设置的适配器立即绑定
      if (this._pendingAdapter) this._ui.bind(this._pendingAdapter);
    }
    disconnectedCallback() {
      this._unsubs?.forEach?.((fn) => fn());
      this._unsubs = [];
      this._ui?.destroy?.();
      this._ui = undefined;
    }
    /** @param {PlayerAdapter|null} a */
    set adapter(a) {
      this._pendingAdapter = a;
      if (this._ui) this._ui.bind(a);
    }
    get adapter() { return this._ui ? this._ui.adapter : this._pendingAdapter; }
    /** @returns {PlayerUIController|null} */
    get controller() { return this._ui || null; }
  }
  customElements.define('player-ui', PlayerUIElement);
}

/* ---------- 工具 ---------- */
function mkDiv(cls, html) {
  const el = document.createElement('div');
  el.className = cls;
  if (html !== undefined) el.innerHTML = html;
  return el;
}
function mkSpan(cls, html) {
  const el = document.createElement('span');
  el.className = cls;
  el.innerHTML = html;
  return el;
}
function mkBtn(cls, iconHtml, title) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.innerHTML = iconHtml;
  b.title = title;
  b.setAttribute('aria-label', title || '');
  return b;
}
function resolveEl(x) {
  if (!x) return undefined;
  if (typeof x === 'string') return document.querySelector(x) || undefined;
  return x;
}
/** 极简 HTML 转义（统计面板防注入） */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
