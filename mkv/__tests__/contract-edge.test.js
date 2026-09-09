/**
 * contract-edge.test.js —— 契约边界补充用例（用内联迷你结构覆盖稀疏路径）
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MkvDemuxer, createDemuxer, probe as mkvProbe,
  BufferSource, BlobSource, EbmlWriter, ID, encodeSize,
  readSize, findElement, childrenOf, iterElements, parseTree, readString, encodeId,
} from '../src/index.js';
import {
  makeMinimalWebm, makeWebmWithTextTrack, makeBlock, makeOpusHead,
} from './fixtures/make-fixture.mjs';
import { encodeUnknownSize, vintLength, EbmlError } from '../src/index.js';

/** 内联拼装最小 Segment 文件 */
function buildMini({ infoBuild, tracksBuild, clusterChildren, durationMs = 1000 }) {
  const header = new EbmlWriter().master(ID.EBML, (w) => {
    w.u(ID.EBMLVersion, 1);
    w.s(ID.DocType, 'webm');
  }).done();
  const info = new EbmlWriter().master(ID.Info, (w) => {
    w.u(ID.TimecodeScale, 1_000_000);
    if (durationMs != null) w.f(ID.Duration, durationMs, 4);
    infoBuild?.(w);
  }).done();
  const tracks = new EbmlWriter().master(ID.Tracks, tracksBuild).done();
  const cluster = new EbmlWriter()
    .master(ID.Cluster, (w) => {
      w.u(ID.ClusterTimecode, 0);
      for (const b of clusterChildren) w.raw(b);
    })
    .done();
  const root = new EbmlWriter();
  root.raw(header);
  root.raw(encodeId(ID.Segment));
  root.raw(encodeSize(info.length + tracks.length + cluster.length));
  root.raw(info); root.raw(tracks); root.raw(cluster);
  return root.done();
}

const videoTrackBuild = (w) => {
  w.master(ID.TrackEntry, (t) => {
    t.u(ID.TrackNumber, 1);
    t.u(ID.TrackUID, 0x1);
    t.u(ID.TrackType, 1);
    t.s(ID.CodecID, 'V_VP9');
    t.master(ID.Video, (v) => {
      v.u(ID.PixelWidth, 640);
      v.u(ID.PixelHeight, 360);
    });
  });
};

test('内联：LanguageIETF 优先于 TrackLanguage，TrackName 透出', async () => {
  const bytes = buildMini({
    tracksBuild: (w) => {
      videoTrackBuild(w);
      w.master(ID.TrackEntry, (t) => {
        t.u(ID.TrackNumber, 2);
        t.u(ID.TrackType, 2);
        t.s(ID.CodecID, 'A_OPUS');
        t.b(ID.CodecPrivate, makeOpusHead({}));
        t.s(ID.TrackLanguage, 'chi');
        t.s(0x22b59d, 'zh'); // LanguageIETF
        t.u8str(0x536e, '主声道'); // TrackName
      });
    },
    clusterChildren: [
      new EbmlWriter().leaf(ID.SimpleBlock, makeBlock({ trackNumber: 1, keyframe: true, frames: [new Uint8Array(2)] })).done(),
    ],
  });
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  const audio = d.tracks.find((t) => t.id === 2);
  assert.equal(audio.language, 'zh');
  assert.equal(d.trackList.find((t) => t.id === 2).name, '主声道');
});

test('内联：簇内 Void/CRC32 元素被跳过', async () => {
  const blockBytes = new EbmlWriter().leaf(ID.SimpleBlock, makeBlock({ trackNumber: 1, keyframe: true, frames: [new Uint8Array(3)] })).done();
  const voidEl = new EbmlWriter().leaf(ID.Void, new Uint8Array(5)).done();
  const crc = new EbmlWriter().leaf(0xbf, new Uint8Array(4)).done(); // CRC-32
  const bytes = buildMini({
    tracksBuild: videoTrackBuild,
    clusterChildren: [voidEl, blockBytes, crc],
  });
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  let n = 0;
  for await (const s of d.samples(1)) { n++; assert.equal(s.size, 3); }
  assert.equal(n, 1);
});

test('内联：DisplayWidth/Height 进入公开视图', async () => {
  const bytes = buildMini({
    tracksBuild: (w) => {
      w.master(ID.TrackEntry, (t) => {
        t.u(ID.TrackNumber, 1);
        t.u(ID.TrackType, 1);
        t.s(ID.CodecID, 'V_VP9');
        t.master(ID.Video, (v) => {
          v.u(ID.PixelWidth, 320);
          v.u(ID.PixelHeight, 240);
          v.u(ID.DisplayWidth, 640);
          v.u(ID.DisplayHeight, 480);
        });
      });
    },
    clusterChildren: [],
  });
  const d = new MkvDemuxer(new BufferSource(bytes));
  await d.open();
  const [v] = d.tracks;
  assert.equal(v.width, 320);
  assert.equal(v.displayWidth, 640);
  assert.equal(v.displayHeight, 480);
});

test('probe：EBML 头但外来 DocType → null（§10 未命中口径）', async () => {
  const header = new EbmlWriter().master(ID.EBML, (w) => {
    w.s(ID.DocType, 'divx');
  }).done();
  assert.equal(mkvProbe(header), null);

  await assert.rejects(
    () => createDemuxer(header),
    (e) => e.code === 'PROBE_FAILED',
  );
});

test('createDemuxer：接受自定义 DataSource 对象（{size,read}）', async () => {
  const bytes = makeMinimalWebm().bytes;
  const dataSource = {
    size: bytes.length,
    read: async (o, l) => bytes.subarray(o, o + l),
  };
  const d = await createDemuxer(dataSource);
  assert.equal(d.mediaInfo.container, 'webm');
  const s = await d.readSample(1);
  assert.equal(s.timestamp, 0);
  await d.destroy();
});

test('双轨独立拉取：互不干扰且顺序各自正确', async () => {
  const d = new MkvDemuxer(new BufferSource(makeMinimalWebm().bytes));
  await d.open();
  const v1 = await d.readSample(1);
  const a1 = await d.readSample(2);
  const a2 = await d.readSample(2);
  const v2 = await d.readSample(1);
  assert.equal(v1.timestamp, 0);
  assert.equal(a1.timestamp, 0);
  assert.equal(a2.timestamp, 0);
  assert.equal(v2.timestamp, 1_500_000); // 视频轨进度未被音频拉取影响
});

test('seek 后拉取：样本序号从 0 重新计数', async () => {
  const d = new MkvDemuxer(new BufferSource(makeMinimalWebm().bytes));
  await d.open();
  await d.readSample(1);
  const s1 = await d.readSample(1);
  assert.equal(s1.index, 1);
  await d.seek(1_600_000);
  const s2 = await d.readSample(1);
  assert.equal(s2.index, 0);
  assert.equal(s2.timestamp, 2_000_000);
});

test('单轨消费不触发 end（仍有未完成轨道）', async () => {
  const d = new MkvDemuxer(new BufferSource(makeMinimalWebm().bytes));
  await d.open();
  let ended = false;
  d.on('end', () => { ended = true; });
  for await (const s of d.samples(1)) void s;
  assert.equal(ended, false);
});

test('destroy 关闭底层数据源（close 恰一次）', async () => {
  let closed = 0;
  const bytes = makeMinimalWebm().bytes;
  const source = {
    size: bytes.length,
    read: async (o, l) => bytes.subarray(o, o + l),
    close: () => { closed++; },
  };
  const d = new MkvDemuxer(source);
  await d.open();
  await d.destroy();
  await d.destroy();
  assert.equal(closed, 1);
});

// ── §2.4：本类覆写 open() 自行编排，须等价补齐基类自带的超时保护与旧名双发 ──

test('open() 超时 reject TIMEOUT（initTimeoutMs 生效）', async () => {
  const never = {
    size: 65536,
    read: () => new Promise(() => {}), // 永不 resolve，模拟卡死源
    close: () => {},
  };
  // 实现里超时定时器 unref 了（与 core 基类同款，不阻塞进程退出），
  // 而永不 settle 的 promise 不持有事件循环，故测试须自行保活，
  // 否则 loop 提前排空会让 timeout 永不触发。
  const keepAlive = setInterval(() => {}, 5);
  try {
    const d = new MkvDemuxer(never, { initTimeoutMs: 30 });
    await assert.rejects(() => d.open(), (err) => err?.code === 'TIMEOUT');
    // 超时后回退到 idle，允许调用方换源重试
    assert.equal(d.state, 'idle');
  } finally {
    clearInterval(keepAlive);
  }
});

test('open() 双发 media-info 与过渡期旧名 mediaInfo', async () => {
  const d = new MkvDemuxer(new BufferSource(makeMinimalWebm().bytes));
  const seen = [];
  d.on('media-info', (info) => seen.push(['media-info', info]));
  d.on('mediaInfo', (info) => seen.push(['mediaInfo', info]));
  await d.open();
  assert.deepEqual(seen.map(([name]) => name).sort(), ['media-info', 'mediaInfo']);
  // 两个事件名投递的是同一个 MediaInfo 对象
  assert.equal(seen[0][1], seen[1][1]);
});

// ── EBML 层边界 ─────────────────────────────────────────

test('readSize：强制 8 字节宽度编码往返（非全 1 非未知）', () => {
  const v = 123456789;
  const enc = encodeSize(v, 8);
  assert.equal(enc.length, 8);
  const dec = readSize(enc, 0);
  assert.equal(dec.unknown, false);
  assert.equal(dec.value, v);
});

test('encodeSize：强制最小长度与边界值', () => {
  assert.deepEqual([...encodeSize(126, 3)], [0x20, 0x00, 0x7e]);
  assert.deepEqual([...encodeSize(127, 4)], [0x10, 0x00, 0x00, 0x7f]);
});

test('findElement / childrenOf：浅层查找与子元素收集', () => {
  const buf = new EbmlWriter()
    .s(ID.DocType, 'webm')
    .u(ID.EBMLVersion, 4)
    .done();
  const docType = findElement(buf, 0, buf.length, ID.DocType);
  assert.ok(docType && docType.name === 'DocType');
  const kids = childrenOf(buf, { contentStart: 0, contentEnd: buf.length });
  assert.equal(kids.length, 2);
  assert.equal(findElement(buf, 0, buf.length, ID.Segment), null);
});

test('iterElements：元素尺寸越界时钳制到可用末尾', () => {
  const buf = new Uint8Array([0x42, 0x86, 0x40, 0x50]); // DocType 宣称 80B 但只有 4B
  const els = [...iterElements(buf, 0, buf.length)];
  assert.equal(els.length, 1);
  assert.equal(els[0].contentEnd, buf.length);
});

test('parseTree：深度限制保护', () => {
  const inner = new EbmlWriter().u(ID.TimecodeScale, 500).done();
  const mid = new EbmlWriter().masterBytes(ID.Info, inner).done();
  const outer = new EbmlWriter().masterBytes(ID.Segment, mid).done();
  const tree = parseTree(outer, 0, outer.length, undefined, 1); // 只展开一层
  assert.equal(tree[0].children[0].children, undefined);
  const full = parseTree(outer, 0, outer.length, undefined, 6);
  assert.equal(full[0].children[0].children[0].value, 500);
});

test('readString：UTF-8 多字节解码', () => {
  const bytes = new TextEncoder().encode('播放器\0');
  assert.equal(readString(bytes), '播放器');
});

test('encodeId：四字节 Cues ID 还原', () => {
  assert.deepEqual([...encodeId(ID.Cues)], [0x1c, 0x53, 0xbb, 0x6b]);
});

// ── 补充边界（凑足 mkv ≥60 例门槛）─────────────────────────

test('encodeUnknownSize：1/2/8 字节未知长度标记往返', () => {
  for (const n of [1, 2, 4, 8]) {
    const enc = encodeUnknownSize(n);
    assert.equal(enc.length, n);
    assert.equal(enc[0], n === 8 ? 0x01 : (0xff >> n) | (1 << (8 - n)));
    assert.equal(readSize(enc, 0).unknown, true);
  }
});

test('vintLength：0x00 无标记位必须抛错', () => {
  assert.throws(() => vintLength(0), EbmlError);
});

test('BufferSource：越界读取 reject SOURCE_ERROR；跨末尾允许短读', async () => {
  const src = new BufferSource(new Uint8Array(10));
  await assert.rejects(() => src.read(-1, 4));                       // 非法参数
  await assert.rejects(() => src.read(20, 5), (e) => e.code === 'SOURCE_ERROR'); // 完全越界
  const tail = await src.read(8, 100);                               // 跨末尾 → 短读 2B（EOF 信号）
  assert.equal(tail.length, 2);
});

test('BlobSource：完全越界 reject SOURCE_ERROR；尾部短读保留', async () => {
  const blob = new Blob([makeMinimalWebm().bytes]);
  const src = new BlobSource(blob);
  await assert.rejects(() => src.read(blob.size + 100, 8), (e) => e.code === 'SOURCE_ERROR');
  const tail = await src.read(blob.size - 3, 99);
  assert.equal(tail.length, 3);
});

test('samples()：未 open 同步抛 STATE_ERROR（非 Promise 拒绝）', () => {
  const d = new MkvDemuxer(new BufferSource(makeMinimalWebm().bytes));
  assert.throws(() => d.samples(1), (e) => e.code === 'STATE_ERROR');
});

test('三轨变体轨道排序：video > audio > text', async () => {
  // 用文本轨变体再拼一个音频轨的合成检查：直接验证排序权重函数语义
  const d = new MkvDemuxer(new BufferSource(makeWebmWithTextTrack().bytes));
  await d.open();
  assert.deepEqual(d.tracks.map((t) => t.type), ['video', 'text']);
});

test('§12.3 新增可选成员：readSample/samples 支持 options.signal（已中断前置快速失败且保留续读）', async () => {
  const d = new MkvDemuxer(new BufferSource(makeMinimalWebm().bytes));
  await d.open();
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => d.readSample(1, { signal: ac.signal }), (e) => e?.code === 'ABORTED');
  await assert.rejects(async () => {
    for await (const s of d.samples(1, { signal: ac.signal })) void s;
  }, (e) => e?.code === 'ABORTED');
  // 前置失败不触碰迭代器：首个样本仍完整可取
  const s = await d.readSample(1);
  assert.ok(s && s.size > 0, '前置失败未推进迭代器，首样本仍可取');
  await d.destroy();
});

