/**
 * 本地文件接入辅助：拖拽与文件选择。
 * 纯浏览器 API（dragover/drop/input[type=file]），返回 disposer 便于组件卸载时清理。
 */
import { BlobDataSource } from '../../core/src/index.js';

/**
 * 监听元素上的文件拖入。
 * @param {HTMLElement} element
 * @param {(source: BlobDataSource, file: File) => void} onFile
 * @param {{accept?: string[]}} [options] accept: 扩展名白名单如 ['.mp4','.m4v']
 * @returns {() => void} disposer
 */
export function attachFileDrop(element, onFile, options = {}) {
  const accept = options.accept ?? null;
  const prevent = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const onDragOver = (e) => {
    prevent(e);
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };
  const onDrop = (e) => {
    prevent(e);
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (accept && !accept.some((ext) => file.name.toLowerCase().endsWith(ext))) {
      console.warn(`[file-source] rejected ${file.name}: expected ${accept.join('/')}`);
      return;
    }
    const source = new BlobDataSource(file);
    onFile(source, file);
  };
  element.addEventListener('dragover', onDragOver);
  element.addEventListener('drop', onDrop);
  return () => {
    element.removeEventListener('dragover', onDragOver);
    element.removeEventListener('drop', onDrop);
  };
}

/** 弹出系统文件选择框，返回 File 或 null（取消） */
export function pickFile(accept = '.mp4,.m4v,.mov') {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve(null);
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    document.body.appendChild(input);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      document.body.removeChild(input);
      resolve(value);
    };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    // 用户取消时 change 不触发，focus 恢复后兜底
    window.addEventListener('focus', () => setTimeout(() => finish(input.files?.[0] ?? null), 300), { once: true });
    input.click();
  });
}
