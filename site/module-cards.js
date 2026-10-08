import { MODULES } from './nav.js';

/** 官网和总览共用模块事实源，分类不等于编码支持承诺。 */
export function renderModuleCards(target, root = '../../') {
  if (!target || typeof document === 'undefined') return;
  target.replaceChildren();
  for (const category of ['视频容器', '流媒体与传输', '音频', '实验与字幕']) {
    const heading = document.createElement('h2');
    heading.className = 'pp-category';
    heading.textContent = category;
    const grid = document.createElement('div');
    grid.className = 'pp-module-grid';
    for (const item of MODULES.filter(module => module.category === category)) {
      const card = document.createElement('a');
      card.className = 'pp-card pp-module-card';
      card.href = root + item.href;
      const top = document.createElement('div');
      top.className = 'pp-module-card__top';
      const title = document.createElement('strong');
      title.textContent = item.title;
      const arrow = document.createElement('span');
      arrow.textContent = '↗';
      arrow.setAttribute('aria-hidden', 'true');
      top.append(title, arrow);
      const description = document.createElement('p');
      description.textContent = item.desc;
      const meta = document.createElement('div');
      meta.className = 'pp-module-card__meta';
      const name = document.createElement('code');
      name.textContent = item.name + '/';
      const badge = document.createElement('span');
      badge.className = `pp-badge ${item.status === 'ok' ? 'pp-badge--ok' : 'pp-badge--warn'}`;
      badge.textContent = item.status === 'ok' ? '演示可用' : '建设中';
      meta.append(name, badge);
      card.append(top, description, meta);
      grid.appendChild(card);
    }
    target.append(heading, grid);
  }
}
