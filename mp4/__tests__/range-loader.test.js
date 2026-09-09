import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { HttpRangeDataSource } from '../src/range-loader.js';
import { Mp4Demuxer } from '../src/demuxer.js';
import { buildProgressiveVideoFixture } from './fixtures.js';

/** 起一个支持 Range 的静态服务器，返回 {server, url, close} */
function startRangeServer(buffer) {
  const server = createServer((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'content-length': String(buffer.byteLength),
        'accept-ranges': 'bytes',
      });
      res.end();
      return;
    }
    const range = req.headers.range;
    if (!range) {
      res.writeHead(200, { 'content-length': String(buffer.byteLength) });
      res.end(buffer);
      return;
    }
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m[1] === '' ? 0 : Number(m[1]);
    const end = m[2] === '' ? buffer.byteLength - 1 : Math.min(Number(m[2]), buffer.byteLength - 1);
    if (start > end || start >= buffer.byteLength) {
      res.writeHead(416, { 'content-range': `bytes */${buffer.byteLength}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${buffer.byteLength}`,
      'accept-ranges': 'bytes',
    });
    res.end(buffer.subarray(start, end + 1));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('HttpRangeDataSource：跨块读取与整文件一致', async () => {
  const { bytes } = buildProgressiveVideoFixture();
  const { server, port } = await startRangeServer(Buffer.from(bytes));
  try {
    const ds = new HttpRangeDataSource(`http://127.0.0.1:${port}/video.mp4`, { chunkSize: 256 });
    await ds.open();
    assert.equal(ds.size, bytes.byteLength);
    assert.equal(ds.acceptRanges, true);

    // 跨块边界读取
    const a = await ds.read(0, 100);
    assert.deepEqual([...a], [...bytes.subarray(0, 100)]);
    const b = await ds.read(250, 300); // 256 边界两侧
    assert.deepEqual([...b], [...bytes.subarray(250, 550)]);
    const c = await ds.read(bytes.byteLength - 7, 7); // 尾部
    assert.deepEqual([...c], [...bytes.subarray(bytes.byteLength - 7)]);

    // 缓存淘汰后重读仍正确
    for (let off = 0; off < bytes.byteLength; off += 256) await ds.read(off, 16);
    const again = await ds.read(300, 32);
    assert.deepEqual([...again], [...bytes.subarray(300, 332)]);
  } finally {
    server.close();
  }
});

test('HTTP Range 渐进 demux：moov 在尾部的文件也能完整解析', async () => {
  // 构造 mdat 在前、moov 在后的变体（真实网络 MP4 常见形态）
  const { bytes } = buildProgressiveVideoFixture();
  let moovBox = null;
  let ftypBox = null;
  const { iterateBoxes } = await import('../src/box-parser.js');
  iterateBoxes(bytes, 0, bytes.byteLength, (h) => {
    if (h.type === 'moov') moovBox = h;
    if (h.type === 'ftyp') ftypBox = h;
    return true;
  });
  const reordered = new Uint8Array(bytes.byteLength);
  reordered.set(bytes.subarray(ftypBox.start, ftypBox.end), 0);
  const tailStart = ftypBox.end;
  reordered.set(bytes.subarray(moovBox.start, moovBox.end), tailStart);
  reordered.set(
    bytes.subarray(ftypBox.end, moovBox.start),
    tailStart + (moovBox.end - moovBox.start),
  );

  const { server, port } = await startRangeServer(Buffer.from(reordered));
  try {
    const ds = new HttpRangeDataSource(`http://127.0.0.1:${port}/tail-moov.mp4`, { chunkSize: 512 });
    const d = new Mp4Demuxer();
    d.attach(ds);
    const info = await d.init();
    assert.equal(info.container, 'mp4');
    const samples = [];
    for await (const s of d.samples(1)) samples.push(s);
    assert.equal(samples.length, 8);
  } finally {
    server.close();
  }
});

test('服务器不支持 Range 时给出明确错误', async () => {
  const { bytes } = buildProgressiveVideoFixture();
  const server = createServer((req, res) => {
    // 无视 Range 头，永远返回 200 整文件
    res.writeHead(200, { 'content-length': String(bytes.byteLength) });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = server.address().port;
    const ds = new HttpRangeDataSource(`http://127.0.0.1:${port}/no-range.mp4`, { chunkSize: 128 });
    // HEAD 成功且无 accept-ranges → size 可得；但 read(offset>0) 应报错
    await ds.open();
    await assert.rejects(
      () => ds.read(1000, 16),
      (e) => e.code === 'SOURCE_ERROR' && /Range/i.test(e.message),
    );
  } finally {
    server.close();
  }
});
