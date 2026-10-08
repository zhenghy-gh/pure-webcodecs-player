import { toast } from './skin.js';
const ready = () => new Promise(resolve => document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', resolve, { once: true }) : resolve());

const local = name => new URL(`./assets/samples/${name}`, import.meta.url).href;
/** Deterministic offline samples ship with the site, unlike optional e2e media. */
export const DEMO_SAMPLES = {
  mp4: [{ title: '播放内置 MP4', file: 'color-bars.mp4', input: '#url', button: '#loadUrl' }],
  mov: [{ title: '播放内置 MOV', file: 'color-bars.mov', event: 'demo:sample' }],
  hls: [{ title: '播放内置 HLS', url: local('playlist.m3u8'), button: '#btn-load' }],
  flv: [{ title: '解析并试播内置 FLV', file: 'color-bars.flv', fileInput: '#fileInput', then: file => document.dispatchEvent(new CustomEvent('demo:flv-mse', { detail: { file } })) }],
  ts: [{ title: '解析内置 TS', file: 'parser.ts', input: '#urlInput', enter: true }],
  mkv: [{ title: '解析内置 MKV', file: 'color-bars.mkv', input: '#url', button: '#btnUrl' }],
  cmaf: [{ title: '解析内置 fMP4', file: 'color-bars.mp4', input: '#url', button: '#btn-fetch' }],
  wav: [{ title: '载入示例音', button: '#gen-demo' }],
  flac: [{ title: '载入示例音', button: '#gen-demo' }],
  ape: [{ title: '查看内置元数据', file: 'metadata.ape', fileInput: '#file' }],
  subtitle: [{ title: '载入 SRT 样例', button: '[data-sample="srt"]' }, { title: '载入 ASS 样例（定位/特效）', button: '[data-sample="ass"]' }, { title: '载入 VTT 样例', button: '[data-sample="vtt"]' }],
  core: [{ title: '运行合成帧', button: '#renderToggle' }, { title: '试听正弦音', button: '#audioToggle' }],
  webrtc: [{ title: '启动本机回环', button: '#btn-loop' }],
  webtorrent: [{ title: '体验内置装配', button: '#builtin-sample' }],
  rtsp: [{ title: '连接本地测试网关', url: 'ws://127.0.0.1:8322/rtsp', input: '#url', button: '#btnStart', gateway: true }],
  rtmp: [{ title: '连接本地测试网关', url: 'ws-flv://127.0.0.1:8321/live/test', input: '#url', button: '#btnStart', gateway: true }],
  'ref-hls': [{ title: '内置 HLS 对照（点击后尝试 CDN）', url: local('playlist.m3u8'), input: '#url', button: '#load' }],
  'ref-flv': [{ title: '播放内置 FLV 对照', file: 'color-bars.flv', input: '#url', button: '#load', requires: 'flv.js CDN' }],
};

export function initDemoSamples(module, target = null) {
  const controller = new AbortController();
  const samples = DEMO_SAMPLES[module] || [];
  const teardown = () => controller.abort();
  void ready().then(() => {
    if (controller.signal.aborted) return;
    target ||= document.querySelector('[data-demo-samples]');
    if (!target) return;
    renderSamples(module, samples, target, controller);
  });
  return teardown;
}

function renderSamples(module, samples, target, controller) {
  target.classList.add('pp-samples');
  const label = document.createElement('span'); label.className = 'pp-samples__label'; label.textContent = '快速体验';
  const actions = document.createElement('div'); actions.className = 'pp-actions';
  target.replaceChildren(label, actions);
  for (const sample of samples) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'pp-btn pp-btn--ghost'; button.textContent = sample.title;
    button.dataset.demoSample = module;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const url = sample.url || (sample.file ? local(sample.file) : undefined);
        if (sample.before) await sample.before();
        if (sample.input) {
          const input = document.querySelector(sample.input);
          input.value = url;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          if (sample.enter) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        }
        let demoFile = null;
        if (sample.fileInput) {
          const response = await fetch(url, { signal: controller.signal });
          if (!response.ok) throw new Error(`示例无法读取（HTTP ${response.status}）`);
          const transfer = new DataTransfer();
          demoFile = new File([await response.arrayBuffer()], sample.file);
          transfer.items.add(demoFile);
          const input = document.querySelector(sample.fileInput);
          input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (sample.event) document.dispatchEvent(new CustomEvent(sample.event, { detail: { url, file: demoFile }, bubbles: true }));
        if (sample.button) document.querySelector(sample.button)?.click();
        if (sample.then) sample.then(demoFile, url);
        if (sample.requires) toast({ type: 'warn', title: '内置示例需要网络', detail: sample.requires + ' 未能离线加载；可点击自研模块离线播放样例。' });
      } catch (error) {
        if (error.name !== 'AbortError') toast({ type: 'danger', title: '示例加载失败', detail: error.message });
      } finally { button.disabled = false; }
    }, { signal: controller.signal });
    actions.appendChild(button);
  }
  const hint = document.createElement('span'); hint.className = 'pp-drop__hint';
  hint.textContent = samples.some(sample => sample.gateway)
    ? '地址已内置；需先运行 npm run gateway。本地测试网关不连接外部媒体源。'
    : module === 'ref-hls' || module === 'ref-flv' ? module === 'ref-hls' ? 'CDN 仅在点按后加载；下载失败会自动回退到本地自研 HLS。' : '参考 FLV 需联网加载 CDN；完全离线可用的自研解析与 MSE 样例见 FLV 模块。'
      : '内置示例 · 无需手填地址 · 点击后立即运行。';
  target.appendChild(hint);
  const first = samples.find(sample => sample.input && sample.file);
  const input = first && document.querySelector(first.input);
  if (input && !input.value) input.value = local(first.file);
  if (module === 'hls') document.getElementById('url').value = local('playlist.m3u8');
}
