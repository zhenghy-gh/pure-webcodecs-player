import { BRAND, isCurrentPage } from './skin.js';
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
 *  @type {Array<{name:string, title:string, desc:string, href:string, category:string, status:'ok'|'wip'|'na'}>} */
export const MODULES = [
  { name: 'core',      title: 'Core',     desc: '公共数据源、Demuxer、能力探测与渲染基座', href: 'core/demo/index.html',       category: '实验与字幕', status: 'ok' },
  { name: 'mp4',       title: 'MP4',      desc: 'ISO-BMFF 解析 → WebCodecs / MSE',        href: 'mp4/demo/index.html',       category: '视频容器', status: 'ok' },
  { name: 'mov',       title: 'MOV',      desc: 'QuickTime 容器解析 → WebCodecs',          href: 'mov/demo/index.html',       category: '视频容器', status: 'ok' },
  { name: 'mkv',       title: 'MKV/WebM', desc: 'EBML 解析 → WebCodecs',                   href: 'mkv/demo/index.html',       category: '视频容器', status: 'ok' },
  { name: 'webtorrent',title: 'WebTorrent',desc: 'P2P 分片装配与 MKV demux；真实 swarm 为可选增强', href: 'webtorrent/demo/index.html',category: '流媒体与传输', status: 'wip' },
  { name: 'ts',        title: 'TS',       desc: 'PAT/PMT/PES → H264/AAC → WebCodecs',     href: 'ts/demo/index.html',        category: '视频容器', status: 'ok' },
  { name: 'flv',       title: 'FLV',      desc: 'FLV Tag 解析 → MSE（HTTP-FLV）',         href: 'flv/demo/index.html',       category: '视频容器', status: 'ok' },
  { name: 'hls',       title: 'HLS',      desc: 'm3u8 清单 + 分片 → MSE',                 href: 'hls/demo/index.html',       category: '流媒体与传输', status: 'ok' },
  { name: 'cmaf',      title: 'CMAF',     desc: 'CMAF Chunk → ISO-BMFF（低延迟方向）',    href: 'cmaf/demo/index.html',      category: '流媒体与传输', status: 'ok' },
  { name: 'wav',       title: 'WAV',      desc: 'RIFF 解析 + AudioWorklet 播放与波形',    href: 'wav/demo/index.html',       category: '音频', status: 'ok' },
  { name: 'flac',      title: 'FLAC',     desc: '无损音频解码 JS 参考实现',                href: 'flac/demo/index.html',      category: '音频', status: 'ok' },
  { name: 'ape',       title: 'APE',      desc: 'MAC 头 / APE TAG 解析与元数据展示',      href: 'ape/demo/index.html',       category: '音频', status: 'ok' },
  { name: 'subtitle',  title: '字幕',     desc: 'SRT / WebVTT / ASS 解析与 Canvas 渲染',  href: 'subtitle/demo/index.html',  category: '实验与字幕', status: 'ok' },
  { name: 'webrtc',    title: 'WebRTC',   desc: 'webrtc:// 信令 → RTCPeerConnection',     href: 'webrtc/demo/index.html',    category: '流媒体与传输', status: 'ok' },
  { name: 'rtsp',      title: 'RTSP',     desc: 'WebSocket 中继桥接形态',                  href: 'rtsp/demo/index.html',      category: '流媒体与传输', status: 'ok' },
  { name: 'rtmp',      title: 'RTMP',     desc: 'WebSocket-FLV 网关桥接形态',              href: 'rtmp/demo/index.html',      category: '流媒体与传输', status: 'ok' },
];

/**
 * 渲染顶部导航到目标容器。
 * @param {HTMLElement} target 导航挂载容器
 * @param {{root?:string, items?:typeof MODULES, homeTitle?:string}} [options]
 *   - root：当前页到仓库根的相对路径，默认 '../..'；设为 '' 表示当前就在根。
 * @returns {{update:()=>void}} 导航控制句柄
 */
export function renderNav(target, options = {}) {
  if (typeof document === 'undefined') throw new Error('[site-nav] renderNav requires a browser');
  const root = options.root ?? '../..';
  const items = options.items || MODULES;
  const header = document.createElement('header');
  header.className = 'pp-topbar';
  const brand = document.createElement('a');
  brand.className = 'pp-topbar__brand';
  brand.href = join(root, 'site/landing.html');
  brand.textContent = BRAND;
  header.appendChild(brand);
  const links = document.createElement('nav');
  links.className = 'pp-tabs';
  links.setAttribute('aria-label', '模块导航');
  const entries = [{ title: '总览', href: 'site/demo/index.html' }, ...items,
    { title: 'HLS 对照', href: 'site/demo/ref-hls.html' }, { title: 'FLV 对照', href: 'site/demo/ref-flv.html' }];
  for (const item of entries) {
    const link = document.createElement('a');
    link.className = 'pp-tabs__item';
    link.href = join(root, item.href);
    link.textContent = item.title;
    if (item.name) link.dataset.module = item.name;
    if (isCurrentPage(link.href, location.href)) {
      link.classList.add('is-active');
      link.setAttribute('aria-current', 'page');
    }
    links.appendChild(link);
  }
  header.appendChild(links);
  target.replaceChildren(header);
  return { update() { return renderNav(target, options); } };
}

if (typeof document !== 'undefined') {
  const boot = () => {
    for (const el of document.querySelectorAll('[data-site-nav]')) {
      if (el.dataset.navReady) continue;
      el.dataset.navReady = '1';
      renderNav(el, { root: el.dataset.root ?? '../..' });
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}
function join(root, relative) { return (root ? root.replace(/\/$/, '') + '/' : '') + relative; }
