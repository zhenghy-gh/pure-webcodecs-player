/**
 * site/nav.js — 演示站顶部导航（纯 ESM，零依赖）
 * ------------------------------------------------------------
 * 用法一（声明式，推荐）：页面放一个占位元素，nav.js 自动渲染：
 *   <div data-site-nav data-root="../../"></div>
 *   <script type="module" src="../../site/nav.js"></script>
 *   · data-root：当前页面到仓库根目录的相对路径（用于拼接各模块链接）
 *
 * 用法二（编程式）：
 *   import { renderNav, MODULES } from '../../site/nav.js';
 *   renderNav(document.querySelector('#nav'), { root: '../../' });
 */

/** 仓库根相对路径下的模块清单（站点首页与导航共用同一份事实源）。
 *  @type {Array<{name:string, title:string, desc:string, href:string, status:'ok'|'wip'|'na'}>} */
export const MODULES = [
  { name: 'core',      title: 'Core',     desc: '公共数据源、Demuxer、能力探测与渲染基座', href: 'core/demo/index.html',       status: 'wip' },
  { name: 'mp4',       title: 'MP4',      desc: 'ISO-BMFF 解析 → WebCodecs / MSE',        href: 'mp4/demo/index.html',       status: 'wip' },
  { name: 'mov',       title: 'MOV',      desc: 'QuickTime 容器解析 → WebCodecs',          href: 'mov/demo/index.html',       status: 'wip' },
  { name: 'mkv',       title: 'MKV/WebM', desc: 'EBML 解析 → WebCodecs',                   href: 'mkv/demo/index.html',       status: 'wip' },
  { name: 'webtorrent',title: 'WebTorrent',desc: 'P2P 边下边播 torrent → piece → mp4',     href: 'webtorrent/demo/index.html',status: 'wip' },
  { name: 'ts',        title: 'TS',       desc: 'PAT/PMT/PES → H264/AAC → WebCodecs',     href: 'ts/demo/index.html',        status: 'wip' },
  { name: 'flv',       title: 'FLV',      desc: 'FLV Tag 解析 → MSE（HTTP-FLV）',         href: 'flv/demo/index.html',       status: 'wip' },
  { name: 'hls',       title: 'HLS',      desc: 'm3u8 清单 + 分片 → MSE',                 href: 'hls/demo/index.html',       status: 'wip' },
  { name: 'cmaf',      title: 'CMAF',     desc: 'CMAF Chunk → ISO-BMFF（低延迟方向）',    href: 'cmaf/demo/index.html',      status: 'wip' },
  { name: 'wav',       title: 'WAV',      desc: 'RIFF 解析 + AudioWorklet 播放与波形',    href: 'wav/demo/index.html',       status: 'ok' },
  { name: 'flac',      title: 'FLAC',     desc: '无损音频解码 JS 参考实现',                href: 'flac/demo/index.html',      status: 'ok' },
  { name: 'ape',       title: 'APE',      desc: 'MAC 头 / APE TAG 解析与元数据展示',      href: 'ape/demo/index.html',       status: 'ok' },
  { name: 'subtitle',  title: '字幕',     desc: 'SRT / WebVTT / ASS 解析与 Canvas 渲染',  href: 'subtitle/demo/index.html',  status: 'ok' },
  { name: 'webrtc',    title: 'WebRTC',   desc: 'webrtc:// 信令 → RTCPeerConnection',     href: 'webrtc/demo/index.html',    status: 'wip' },
  { name: 'rtsp',      title: 'RTSP',     desc: 'WebSocket 中继桥接形态',                  href: 'rtsp/demo/index.html',      status: 'na' },
  { name: 'rtmp',      title: 'RTMP',     desc: 'WebSocket-FLV 网关桥接形态',              href: 'rtmp/demo/index.html',      status: 'na' },
];

const STATUS_TEXT = { ok: '可用', wip: '建设中', na: '规划中' };

/**
 * 渲染顶部导航到目标容器。
 * @param {HTMLElement} target 导航挂载容器
 * @param {{root?:string, items?:typeof MODULES, homeTitle?:string}} [options]
 *   - root：当前页到仓库根的相对路径，默认 '../..'；设为 '' 表示当前就在根。
 * @returns {{update:()=>void}} 导航控制句柄
 */
export function renderNav(target, options = {}) {
  if (typeof document === 'undefined') {
    throw new Error('[site-nav] renderNav 仅可在浏览器环境使用');
  }
  const root = options.root !== undefined ? options.root : '../..';
  const items = options.items || MODULES;

  const here = normalizePath(location.pathname);

  const nav = document.createElement('nav');
  nav.className = 'site-nav';

  const brand = document.createElement('a');
  brand.className = 'site-nav__brand';
  brand.href = join(root, 'site/demo/index.html');
  brand.innerHTML =
    '<span class="site-nav__logo" aria-hidden="true"></span><span>纯前端播放器</span>';
  nav.appendChild(brand);

  const links = document.createElement('div');
  links.className = 'site-nav__links';
  for (const m of items) {
    const a = document.createElement('a');
    a.className = 'site-nav__link';
    a.href = join(root, m.href);
    a.dataset.module = m.name;
    a.textContent = m.title;
    // 当前页高亮：地址以模块链接路径收尾即命中
    if (here.endsWith(normalizePath('/' + m.href).replace(/\/index\.html?$/, '')) ||
        here.endsWith(normalizePath(m.href))) {
      a.classList.add('site-nav__link--active');
    }
    links.appendChild(a);
  }
  nav.appendChild(links);

  const tip = document.createElement('span');
  tip.className = 'site-nav__gh';
  tip.textContent = '零构建 · 纯 ESM';
  nav.appendChild(tip);

  target.textContent = '';
  target.appendChild(nav);

  return {
    /** 窗口跳转后可手动重算高亮（SPA 场景用，静态站一般不需要） */
    update() { renderNav(target, options); },
  };
}

/* ---- 声明式自动初始化：扫描 [data-site-nav] 占位元素 ---- */
if (typeof document !== 'undefined') {
  const boot = () => {
    for (const el of document.querySelectorAll('[data-site-nav]')) {
      if (el.dataset.navReady) continue;
      el.dataset.navReady = '1';
      renderNav(el, { root: el.dataset.root || '../..', items: MODULES });
    }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}

/* ---------- 路径工具 ---------- */
function join(root, rel) {
  return (root.endsWith('/') ? root.slice(0, -1) : root) + '/' + rel;
}
function normalizePath(p) {
  return p.endsWith('/') ? p.slice(0, -1) : p;
}
