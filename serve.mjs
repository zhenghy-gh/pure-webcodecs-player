#!/usr/bin/env node
/**
 * 零依赖开发用静态服务器（Node 内置模块实现，无需安装任何包）。
 *
 * 特性：
 *  - 支持中文等非 ASCII 路径（自动 decodeURIComponent）
 *  - 正确的 Content-Type / charset（覆盖本项目涉及的媒体类型：mp4/ts/flv/mkv/m3u8/wav/flac/ape/字幕等）
 *  - HTTP Range（单区间）请求支持 → mp4/mov 的 HTTP Range 流式解析演示可用
 *  - 目录访问：优先 index.html，否则输出简易目录列表
 *  - 防路径穿越（normalize 后必须仍在仓库根内）
 *
 * 用法：
 *   node serve.mjs [port]     或   PORT=9000 node serve.mjs
 *   npm run demo              （默认端口 8080）
 */
import http from 'node:http';
import { stat, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 8080);

/** 扩展名 → MIME 映射；文本类统一带 charset=utf-8 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
  // 媒体容器 / 音视频
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.ts': 'video/mp2t',
  '.m2t': 'video/mp2t',
  '.flv': 'video/x-flv',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mpd': 'application/dash+xml',
  '.mp3': 'audio/mpeg',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ape': 'audio/ape',
  '.ogg': 'audio/ogg',
  // 字幕
  '.srt': 'application/x-subrip; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.ass': 'text/x-ssa; charset=utf-8',
  '.ssa': 'text/x-ssa; charset=utf-8',
};

function mimeOf(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/** 解析单区间 Range 头；返回 {start,end} 或 null（不支持/非法） */
function parseRange(header, total) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') {
    // bytes=-500 → 末尾 500 字节
    const suffix = Number(m[2]);
    if (suffix === 0 || suffix > total) return null;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) return null;
  return { start, end };
}

/** 简易目录列表页 */
function renderDirList(relPath, entries) {
  const items = [{ name: '../', href: path.posix.join(relPath, '../') }]
    .concat(entries.map((e) => ({ name: e + (e.includes('.') ? '' : '/'), href: path.posix.join(relPath, encodeURIComponent(e)) })));
  const lis = items.map((i) => `<li><a href="${i.href}">${i.name}</a></li>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>Index of ${relPath}</title>
<h1>Index of ${relPath}</h1><ul>${lis}</ul>
<hr><small>纯前端播放器 · 开发静态服务器</small>`;
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') {
    // CORS 预检：允许跨端口联调（如 demo 页 fetch 网关样例）
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,HEAD,POST,PUT,OPTIONS',
      'Access-Control-Allow-Headers': '*',
    }).end();
    return;
  }
  const url = new URL(req.url, 'http://localhost');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname); // 中文/空格等已编码字符还原
  } catch {
    res.writeHead(400).end('Bad Request: 非法 URL 编码');
    return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';

  const filePath = path.normalize(path.join(ROOT, pathname));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('Forbidden: 越出仓库根目录');
    return;
  }

  let target = filePath;
  let info;
  try {
    info = await stat(target);
    if (info.isDirectory()) {
      // 目录：先试 index.html，否则列目录
      const indexPath = path.join(target, 'index.html');
      try {
        await stat(indexPath);
        target = indexPath;
        info = await stat(indexPath);
      } catch {
        const entries = await readdir(target);
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
        res.end(renderDirList(pathname.replace(/index\.html$/, ''), entries));
        return;
      }
    }
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`404 Not Found: ${pathname}`);
    return;
  }

  // 统一流式输出：大文件（视频样本等）不再整读进内存，Range 直接映射为流的 start/end
  const total = info.size;
  const baseHeaders = {
    'Content-Type': mimeOf(target),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*', // 本地多端口联调需要
  };

  const range = req.headers.range ? parseRange(req.headers.range, total) : null;
  if (req.headers.range && !range) {
    // Range 不满足：按 RFC 7233 返回 416 与当前全长
    res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${total}` });
    res.end();
    return;
  }

  if (req.method === 'HEAD') {
    // 只发头不发体，也不必打开文件流
    if (range) {
      res.writeHead(206, {
        ...baseHeaders,
        'Content-Range': `bytes ${range.start}-${range.end}/${total}`,
        'Content-Length': range.end - range.start + 1,
      });
    } else {
      res.writeHead(200, { ...baseHeaders, 'Content-Length': total });
    }
    res.end();
    return;
  }

  let stream;
  if (range) {
    res.writeHead(206, {
      ...baseHeaders,
      'Content-Range': `bytes ${range.start}-${range.end}/${total}`,
      'Content-Length': range.end - range.start + 1,
    });
    stream = createReadStream(target, { start: range.start, end: range.end });
  } else {
    res.writeHead(200, { ...baseHeaders, 'Content-Length': total });
    stream = createReadStream(target);
  }

  // 客户端中断（取消下载/关闭页面）时停止读取，避免悬挂句柄
  res.on('close', () => stream.destroy());
  stream.on('error', (err) => {
    console.error('[serve] 读流出错:', err?.message || err);
    res.destroy();
  });
  stream.pipe(res);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('[serve] 处理请求出错:', err?.message || err);
    try {
      res.writeHead(500).end('Internal Server Error');
    } catch { /* 已响应则忽略 */ }
  });
});

// 端口冲突：给出可操作的中文提示（演示服务器默认 8080，测试网关默认 8090）
server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`[serve] 端口 ${PORT} 已被占用（可能是另一个 serve/gateway 实例）。`);
    console.error(`[serve] 换端口启动： PORT=${PORT + 1} npm run demo`);
    console.error(`[serve] 查看占用进程： lsof -nP -iTCP:${PORT} -sTCP:LISTEN`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`[serve] 纯前端播放器演示服务器已启动`);
  console.log(`[serve] 根目录: ${ROOT}`);
  console.log(`[serve] 地址:   http://localhost:${PORT}/`);
  console.log(`[serve] 支持: 中文路径 / Range(断点与流式拖动) / 目录列表`);
});
