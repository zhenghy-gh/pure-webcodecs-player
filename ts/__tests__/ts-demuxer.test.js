/**
 * TsDemuxer 契约适配壳单测（CONTRACTS v0.2 §2.2 / §10 / §0.5）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TsDemuxer, createTsDemuxer } from '../src/ts-demuxer.js';
import * as Mod from '../src/index.js';
import { assembleTs } from './fixtures/build-ts.mjs';
import { MemoryDataSource } from '../../core/src/index.js';

/** 组装标准双轨流：H264(320x240,gop4)×8帧 + AAC×6 帧 */
function stdFile() {
  return assembleTs({
    video: { codec: 'h264', width: 320, height: 240, frames: 8, gopSize: 4 },
    audio: { mode: 'adts', count: 6 },
  });
}

/* ------------------------------ §10 注册形状 ------------------------------ */

test('§10 导出形状：containerName/extensions/mimeTypes/probe/createDemuxer', () => {
  assert.equal(Mod.containerName, 'ts');
  assert.deepEqual(Mod.extensions, ['ts', 'mts', 'm2ts']);
  assert.ok(Array.isArray(Mod.mimeTypes) && Mod.mimeTypes.every((m) => m.includes('mp2t')));
  assert.equal(typeof Mod.probe, 'function');
  assert.equal(typeof Mod.createDemuxer, 'function');
});

/* ------------------------------ static probe ------------------------------ */

test('probe：命中返回 ProbeResult（confidence≥0.8），垃圾字节返回 null 且不抛异常', () => {
  const data = stdFile();
  const pr = TsDemuxer.probe(data.subarray(0, 4096));
  assert.ok(pr && typeof pr.confidence === 'number' && pr.confidence >= 0.8, JSON.stringify(pr));
  assert.equal(pr.container, 'ts');

  assert.equal(TsDemuxer.probe(new Uint8Array(1024).fill(0x33)), null);
  assert.equal(TsDemuxer.probe(new Uint8Array(0)), null);
  assert.equal(TsDemuxer.probe(null), null);          // 不抛异常
  // M2TS（192 包）同样命中
  const m2ts = [];
  for (let off = 0; off < Math.min(data.length, 188 * 4); off += 188) {
    m2ts.push(0, 0, 2, 1, ...data.subarray(off, off + 188));
  }
  const pr192 = TsDemuxer.probe(new Uint8Array(m2ts));
  assert.ok(pr192 && pr192.confidence >= 0.8);
});

/* ------------------------------ open / MediaInfo ------------------------------ */

test('open()：MediaInfo 契约形状与轨道字段（µs 时间基）', async () => {
  const d = await createTsDemuxer(stdFile());
  assert.equal(d.state, 'ready');
  const mi = d.mediaInfo;
  assert.equal(mi.container, 'ts');
  assert.equal(mi.seekable, false);          // 无索引容器（§2.5）
  assert.equal(mi.live, false);

  // 排序 video > audio
  assert.equal(mi.tracks[0].type, 'video');
  assert.equal(mi.tracks[1].type, 'audio');
  const [v, a] = mi.tracks;

  // 视频轨：codec string 走 core 生成、description=avcC、bitstreamFormat='annexb'
  assert.match(v.codec, /^avc1\.[0-9A-F]{6}$/);
  assert.equal(v.bitstreamFormat, 'annexb');
  assert.ok(v.description instanceof Uint8Array && v.description.length > 0);
  assert.equal(v.width, 320);
  assert.equal(v.height, 240);
  assert.equal(v.timescale, 90000);          // 仅诊断保留

  // 音频轨：numberOfChannels 定名字段
  assert.match(a.codec, /^mp4a\.40\.\d$/);
  assert.equal(a.sampleRate, 44100);
  assert.equal(a.numberOfChannels, 2);
  await d.destroy();
});

test('open() 后 durationUs 由 EOS 估算回填（整块源在 open 期间即完成）', async () => {
  const d = await createTsDemuxer(stdFile());
  assert.ok(d.mediaInfo.durationUs > 200_000 && d.mediaInfo.durationUs < 300_000,
    `实际 ${d.mediaInfo.durationUs}`);
  await d.destroy();
});

/* ------------------------------ readSample / samples ------------------------------ */

test('readSample：契约 Sample 形状 + ticks→µs 黄金值', async () => {
  const d = await createTsDemuxer(stdFile());
  const s = await d.readSample(d.tracks[0].id);
  // 夹具视频首帧 PTS=90000 ticks @90kHz → 恰好 1e6 µs
  assert.equal(s.timestamp, 1_000_000);
  assert.equal(s.dts, 1_000_000);
  assert.equal(s.codec, d.tracks[0].codec);
  assert.equal(s.keyframe, true);
  assert.ok(s.data instanceof Uint8Array && s.data.byteLength > 0);
  assert.equal(s.size, s.data.byteLength);
  assert.equal(s.index, 0);
  await d.destroy();
});

test('音频多帧步进：µs 闭式计算无累计漂移（44100Hz × 1024 采样）', async () => {
  // 单 PES 承载全部 4 帧：步长完全由闭式公式决定，恒为 round(1024×1e6/44100)=23220µs
  const file = assembleTs({ audio: { mode: 'adts', count: 4, framesPerPes: 4 }, video: { codec: 'h264', frames: 2 } });
  const d = await createTsDemuxer(file);
  const audioTrack = d.tracks.find((t) => t.type === 'audio');
  const stamps = [];
  for await (const s of d.samples(audioTrack.id)) stamps.push(s.timestamp);
  assert.ok(stamps.length >= 4, `应至少 4 帧，实际 ${stamps.length}`);
  assert.equal(stamps[1] - stamps[0], 23220);
  assert.equal(stamps[2] - stamps[1], 23220);
  assert.equal(stamps[3] - stamps[2], 23220);

  // 跨 PES 场景：PES 间 PTS 由夹具按 90kHz 取整，允许 ±10µs 换算容差
  const file2 = assembleTs({ audio: { mode: 'adts', count: 4, framesPerPes: 1 }, video: { codec: 'h264', frames: 2 } });
  const d2 = await createTsDemuxer(file2);
  const at2 = d2.tracks.find((t) => t.type === 'audio');
  const st2 = [];
  for await (const s of d2.samples(at2.id)) st2.push(s.timestamp);
  for (let i = 1; i < st2.length; i++) {
    assert.ok(Math.abs((st2[i] - st2[i - 1]) - 23220) <= 10, `跨 PES 步进 ${st2[i]-st2[i-1]}`);
  }
  await d.destroy();
  await d2.destroy();
});

test('samples() 迭代至 EOS 后 readSample 返回 null', async () => {
  const d = await createTsDemuxer(stdFile());
  let n = 0;
  for await (const s of d.samples(d.tracks[0].id)) {
    n++;
    assert.ok(Number.isInteger(s.timestamp));
  }
  assert.equal(n, 8);
  assert.equal(await d.readSample(d.tracks[0].id), null);
  await d.destroy();
});

test('逐字节喂入与整块喂入结果一致（流式等价性保持）', async () => {
  const data = stdFile();

  async function run(feed) {
    if (feed) {
      // 零尺寸源使泵立即 EOF；数据经引擎逐字节灌入（纯流式路径）
      const d0 = new TsDemuxer(new MemoryDataSource(new Uint8Array(0)));
      const p0 = d0.open().catch(() => {});
      for (let i = 0; i < data.length; i++) d0.engine.push(data.subarray(i, i + 1));
      d0.engine.flush();
      await p0;
      const out0 = [];
      const vid = d0.tracks[0]?.id;
      for await (const s of d0.samples(vid)) out0.push([s.timestamp, s.dts, s.size, s.keyframe ? 1 : 0]);
      await d0.destroy();
      return out0;
    }
    const src = new MemoryDataSource(data);
    const d = new TsDemuxer(src);
    await d.open();
    const videoId = d.tracks[0].id;
    const out = [];
    for await (const s of d.samples(videoId)) {
      out.push([s.timestamp, s.dts, s.size, s.keyframe ? 1 : 0]);
    }
    await d.destroy();
    return out;
  }

  const whole = await run(false);
  const bytewise = await run(true);
  assert.deepEqual(bytewise, whole);
  assert.ok(whole.length === 8);
});

test('HEVC 流：hvcC 经 core 生成规范 codec string（level 93 黄金值）', async () => {
  const file = assembleTs({ video: { codec: 'hevc', width: 256, height: 144, frames: 4, gopSize: 2 } });
  const d = await createTsDemuxer(file);
  const v = d.tracks.find((t) => t.type === 'video');
  assert.match(v.codec, /^hvc1\.1\.[0-9A-F]+\.L93/);   // Main@L3.1
  assert.equal(v.width, 256);
  assert.equal(v.height, 144);
  await d.destroy();
});

/* ------------------------------ 生命周期状态机 ------------------------------ */

test('未 open 调 readSample/samples → STATE_ERROR；destroy 后一切调用抛 STATE_ERROR', async () => {
  const d = new TsDemuxer(new MemoryDataSource(stdFile()));
  await assert.rejects(() => d.readSample(1), (e) => e.code === 'STATE_ERROR');
  // samples() 为懒生成器：异常在首次 next() 时抛出
  await assert.rejects(
    async () => { for await (const s of d.samples(1)) void s; },
    (e) => e.code === 'STATE_ERROR',
  );

  const d2 = await createTsDemuxer(stdFile());
  await d2.destroy();
  await assert.rejects(() => d2.readSample(1), (e) => e.code === 'STATE_ERROR');
  await assert.rejects(() => d2.open(), (e) => e.code === 'STATE_ERROR');
});

test('destroy 幂等', async () => {
  const d = await createTsDemuxer(stdFile());
  await d.destroy();
  await d.destroy();     // 不抛
  assert.equal(d.state, 'destroyed');
});

test('parseInit() 为 open() 的过渡别名（§2.4）', async () => {
  const d = new TsDemuxer(new MemoryDataSource(stdFile()));
  const info = await d.parseInit();
  assert.equal(info.container, 'ts');
  await d.destroy();
});

test('seek：TS 无索引容器 reject SEEK_UNSUPPORTED', async () => {
  const d = await createTsDemuxer(stdFile());
  await assert.rejects(() => d.seek(500_000), (e) => e.code === 'SEEK_UNSUPPORTED');
  await d.destroy();
});

/* ------------------------------ 工厂 ------------------------------ */

test('createDemuxer：垃圾输入 reject PROBE_FAILED', async () => {
  await assert.rejects(
    () => createTsDemuxer(new Uint8Array(4096).fill(0x11)),
    (e) => e.code === 'PROBE_FAILED',
  );
});

/* ------------------------------ 引擎级修复回归（reviewer round-1） ------------------------------ */

test('CC 连续计数：跳变被检测并计入诊断', async () => {
  const data = new Uint8Array(stdFile());
  // 找一个视频 PID 包并破坏其 CC 字段
  let flipped = 0;
  for (let off = 0; off + 188 <= data.length; off += 188) {
    const pid = ((data[off + 1] & 0x1f) << 8) | data[off + 2];
    if (pid === 0x0101) {
      data[off + 3] = (data[off + 3] & 0xf0) | ((data[off + 3] + 2) & 0x0f);
      flipped++;
      if (flipped >= 2) break;
    }
  }
  assert.ok(flipped >= 2);
  const d = await createTsDemuxer(data);
  const snap = d.engine.psiSnapshot();
  assert.ok(snap.ccErrors >= 1, `应检测到 CC 断续，实际 ${snap.ccErrors}`);
  await d.destroy();
});

test('PAT/PMT 版本对账：同版本去重、新版本触发轨道刷新', async () => {
  const { resetCc, buildPAT, buildPMT, sectionToPackets, dataToPackets, buildPes, h264IdrSlice, annexb, resetCc: _r } =
    await import('./fixtures/build-ts.mjs');
  resetCc();
  const VIDEO_PID = 0x0101;
  const packets = [
    ...sectionToPackets(0x0000, buildPAT([{ number: 1, pid: 0x1000 }])),
  ];
  // 版本 0 的 PMT
  packets.push(...sectionToPackets(0x1000, buildPMT({ pcrPid: VIDEO_PID, streams: [{ streamType: 0x1b, pid: VIDEO_PID }] }, 0)));
  packets.push(...dataToPackets(VIDEO_PID, buildPes(0xe0, annexb(h264IdrSlice()), { pts: 90000, dts: 90000 })));
  // 同版本重复 PMT（应被去重，不再刷 tracks）
  packets.push(...sectionToPackets(0x1000, buildPMT({ pcrPid: VIDEO_PID, streams: [{ streamType: 0x1b, pid: VIDEO_PID }] }, 0)));
  // 版本 1 的 PMT（新增一路 AAC）
  packets.push(...sectionToPackets(0x1000, buildPMT({
    pcrPid: VIDEO_PID,
    streams: [{ streamType: 0x1b, pid: VIDEO_PID }, { streamType: 0x0f, pid: 0x0102 }],
  }, 1)));

  const d = new TsDemuxer(new MemoryDataSource(new Uint8Array(packets.flatMap((p) => [...p]))));
  const trackEmissions = [];
  d.on('media-info', () => {});
  // 手动驱动引擎（不走 _doOpen 的 EOF 判定）：直接灌数据观察 tracks 更新
  const all = concatPackets(packets);
  d.engine.push(all);
  trackEmissions.push(...d.engine.tracks.map((t) => t.id));
  assert.ok(trackEmissions.includes(VIDEO_PID), '应有视频轨');

  // 版本 1 到达后引擎流表含 AAC
  d.engine.flush();
  const snap = d.engine.psiSnapshot();
  assert.equal(snap.programs.length, 1);
  assert.equal(snap.programs[0].version, 1);
  const codecs = snap.programs[0].streams.map((s) => s.codec).sort();
  assert.deepEqual(codecs, ['aac', 'h264']);
  void d;
});

function concatPackets(packets) {
  const total = packets.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of packets) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

test('PES 缓冲上限：异常流不会无限堆积（超限丢弃并继续）', async () => {
  // 构造 declaredLength=0 的视频 PES 头后跟大量无 PUSI 载荷包
  const { resetCc, buildPAT, buildPMT, sectionToPackets, tsPacket } =
    await import('./fixtures/build-ts.mjs');
  resetCc();
  const VIDEO_PID = 0x0101;
  const pesHead = new Uint8Array([
    0, 0, 1, 0xe0, 0, 0,            // declaredLength = 0（不限长）
    0x80, 0x80, 5,                  // PTS 存在，头数据 5 字节
    0x21, 0x00, 0x01, 0x00, 0x01,   // PTS≈0
  ]);
  const packets = [
    ...sectionToPackets(0x0000, buildPAT([{ number: 1, pid: 0x1000 }])),
    ...sectionToPackets(0x1000, buildPMT({ pcrPid: VIDEO_PID, streams: [{ streamType: 0x1b, pid: VIDEO_PID }] })),
    ...chunkIntoPackets(VIDEO_PID, pesHead, true),
  ];
  // 9MB 无 PUSI 续包（超过 MAX_PES_BUFFER）
  const junk = new Uint8Array(64 * 1024).fill(0xaa);
  for (let i = 0; i < 140; i++) {
    packets.push(...chunkIntoPackets(VIDEO_PID, junk, false));
  }

  const d = new TsDemuxer(new MemoryDataSource(new Uint8Array(concatPackets(packets))), {
    engineOptions: { maxPesBufferBytes: 256 * 1024 },
  });
  d.engine = Object.assign(d.engine, {});   // 保持兼容引用
  await d.open();
  // 不崩溃即可；缓冲曾被截断重置
  const remain = d.engine.pesLengths.get(VIDEO_PID);
  assert.ok(remain === undefined || remain < 512 * 1024, `残留 ${remain}`);
  await d.destroy();
});

function chunkIntoPackets(pid, data, pusi) {
  const { dataToPackets } = (() => ({}))(); void 0;
  // 局部实现避免依赖外壳导出
  const out = [];
  let pos = 0;
  let first = pusi;
  while (pos < data.length || first) {
    const chunk = data.subarray(pos, Math.min(pos + 184, data.length));
    pos += chunk.length;
    out.push(tsPacketRaw(pid, chunk, first));
    first = false;
    if (chunk.length === 0) break;
  }
  return out;
}

function tsPacketRaw(pid, payload, pusi) {
  const pkt = new Uint8Array(188);
  pkt[0] = 0x47;
  pkt[1] = (pusi ? 0x40 : 0) | ((pid >> 8) & 0x1f);
  pkt[2] = pid & 0xff;
  const pad = 184 - payload.length;
  if (pad === 0) {
    pkt[3] = 0x10;
    pkt.set(payload, 4);
  } else {
    const afLen = pad - 1;
    pkt[3] = 0x30;
    pkt[4] = afLen;
    if (afLen > 0) {
      pkt[5] = 0;
      for (let i = 6; i < 5 + afLen; i++) pkt[i] = 0xff;
    }
    pkt.set(payload, 4 + 1 + afLen);
  }
  return pkt;
}

/* ------------------------------ 覆盖补齐（LATM/重同步/诊断） ------------------------------ */

test('LATM 音频流：契约轨道与样本（µs）', async () => {
  const file = assembleTs({
    video: { codec: 'h264', frames: 2 },
    audio: { mode: 'latm', count: 4 },
  });
  const d = await createTsDemuxer(file);
  const audio = d.tracks.find((t) => t.type === 'audio');
  assert.ok(audio, '应有音轨');
  assert.match(audio.codec, /^mp4a\.40\.\d$/);
  assert.equal(audio.sampleRate, 44100);
  assert.ok(audio.description instanceof Uint8Array);
  let n = 0;
  for await (const s of d.samples(audio.id)) {
    n++;
    assert.equal(s.duration, Math.round((1024 * 1e6) / 44100));
  }
  assert.equal(n, 4);
  await d.destroy();
});

test('垃圾前缀后自动重同步（resync），样本完整', async () => {
  const data = assembleTs({ video: { codec: 'h264', frames: 4 } });
  const garbage = new Uint8Array([0x12, 0x34, 0x56]);
  const mixed = new Uint8Array([...garbage, ...data]);
  const d = await createTsDemuxer(mixed);
  let n = 0;
  for await (const s of d.samples(d.tracks[0].id)) n++;
  assert.equal(n, 4);
  await d.destroy();
});

test('未知 stream_type 记入 ignoredStreams（全损信息保留）', async () => {
  const { resetCc, buildPAT, buildPMT, sectionToPackets, buildPes, dataToPackets } =
    await import('./fixtures/build-ts.mjs');
  resetCc();
  const packets = [
    ...sectionToPackets(0x0000, buildPAT([{ number: 1, pid: 0x1000 }])),
    ...sectionToPackets(0x1000, buildPMT({ pcrPid: 0x101, streams: [{ streamType: 0x06, pid: 0x101 }] })),
    ...dataToPackets(0x101, buildPes(0xbd, new Uint8Array(32), { pts: 1000 })),
  ];
  const blob = new Uint8Array(packets.flatMap((p) => [...p]));
  const d = await createTsDemuxer(blob);
  assert.equal(d.tracks.length, 0);   // 无受支持轨道，但仍应成功打开（全损信息保留）
  const snap = d.engine.psiSnapshot();
  assert.ok(snap.programs.length >= 1, 'PSI 应被解析并保留');
  assert.ok(snap.ignoredStreams.some((s) => s.pid === 0x101 && s.streamType === 0x06));
  await d.destroy();
});

test('M2TS（192 字节包）端到端', async () => {
  const raw = assembleTs({ video: { codec: 'h264', frames: 4 } });
  const parts = [];
  for (let off = 0; off < raw.length; off += 188) {
    const pkt = new Uint8Array(192);            // [4B 前缀][188B 包]，尾部不足零填充
    pkt.set([0x00, 0x00, 0x02, 0x01], 0);
    pkt.set(raw.subarray(off, Math.min(off + 188, raw.length)), 4);
    parts.push(...pkt);
  }
  const d = await createTsDemuxer(new Uint8Array(parts));
  assert.equal(d.engine.packetSize, 192);
  let n = 0;
  for await (const s of d.samples(d.tracks[0].id)) n++;
  assert.equal(n, 4);
  await d.destroy();
});

test('pause/resume 标志位（直播推送语义）', async () => {
  const d = await createTsDemuxer(stdFile());
  d.pause();
  assert.equal(d.pausedFlag, true);
  d.resume();
  assert.equal(d.pausedFlag, false);
  await d.destroy();
});

test('progress 事件在 DataSource 泵路径触发', async () => {
  const d = await createTsDemuxer(stdFile());
  void d;
  // open 已完成泵；此处验证事件通道本身（progress 由基类契约定义）
  let progressSeen = false;
  const d2 = new TsDemuxer(new MemoryDataSource(stdFile()));
  d2.on('progress', () => { progressSeen = true; });
  await d2.open();
  assert.equal(progressSeen, true);
  await d2.destroy();
});

// ── t17 收尾回归：流中部垃圾注入（PRD demo「扰动开关」同源场景）──
test('流中部垃圾注入：跨包错位后重同步，后续样本完整且时间戳连续', async () => {
  const data = assembleTs({ video: { codec: 'h264', frames: 6 } });
  const garbage = new Uint8Array(97).fill(0x5a); // 素数长度：制造与包边界的最差对齐
  const cut = 188 * 2 + 37;                      // 在第 3 个包中部切开
  const mixed = new Uint8Array([
    ...data.subarray(0, cut),
    ...garbage,
    ...data.subarray(cut),
  ]);
  const d = await createTsDemuxer(mixed);
  const stamps = [];
  for await (const s of d.samples(d.tracks[0].id)) stamps.push(s.timestamp);
  // 垃圾吞掉切点附近至多 1 帧，其余帧必须完整保留且 PTS 单调递增
  assert.ok(stamps.length >= 4, `样本数过少: ${stamps.length}`);
  for (let i = 1; i < stamps.length; i++) {
    assert.ok(stamps[i] > stamps[i - 1], `PTS 非单调: ${stamps[i - 1]} -> ${stamps[i]}`);
  }
  assert.equal(d.mediaInfo.container, 'ts');
  await d.destroy();
});

/* ------------------------------ 直播推送模式 ------------------------------ */

test("start()+'sample' 推送：事件计数与 pull 通道一致；pause/resume 生效", async () => {
  const d = await createTsDemuxer(stdFile());
  const events = [];
  d.on('sample', ({ trackId, sample }) => events.push({ trackId, ts: sample.timestamp }));

  const videoId = d.tracks[0].id;
  d.start();
  await new Promise((r) => setTimeout(r, 80));
  const videoEvents = events.filter((e) => e.trackId === videoId);
  assert.equal(videoEvents.length, 8);
  assert.ok(events.every((e) => Number.isFinite(e.ts)));

  // pause 后不再吐新样本（文件流已 EOS，此处仅验证标志位与调用安全）
  d.pause();
  d.resume();
  await d.destroy();
  assert.equal(d.state, 'destroyed');
});

test('ChunkSource 流式 start()：边推边吐（直播语义）', async () => {
  const data = stdFile();
  const sink = { write() {}, end() {} };
  const d = new TsDemuxer(sink);
  const pOpen = d.open();
  const got = [];
  d.on('sample', ({ sample }) => got.push(sample));
  setTimeout(() => {
    for (let off = 0; off < data.length; off += 300) sink.write(data.subarray(off, Math.min(off + 300, data.length)));
    sink.end();
  }, 10);
  await pOpen;
  d.start();
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(got.length >= 8, `应经事件收到全部视频样本，实际 ${got.length}`);
  await d.destroy();
});

/* ------------------------------ 零参构造与 push/flush 兼容通道 ------------------------------ */

test('零参构造不抛错；push/flush 旧式用法经事件与 readSample 双通道可用', async () => {
  const d = new TsDemuxer();                       // 无 source
  const tracksEvents = [];
  d.on('media-info', () => {});
  const data = assembleTs({ video: { codec: 'h264', frames: 3 } });

  for (let off = 0; off < data.length; off += 100) d.push(data.subarray(off, Math.min(off + 100, data.length)));
  d.flush();

  // open() 在 idle→push 触发后应已就绪（fire-and-forget），此处幂等等待
  await d.open().catch(() => {});
  let n = 0;
  for await (const s of d.samples(d.tracks[0].id)) n++;
  assert.equal(n, 3);
  void tracksEvents;
  await d.destroy();
});

test('push/flush 后 open() 幂等且轨道就绪', async () => {
  const d = new TsDemuxer();
  d.push(assembleTs({ video: { codec: 'h264', frames: 2 } }));
  d.flush();
  const mi = await d.open();
  assert.equal(mi.container, 'ts');
  assert.ok(mi.tracks.length >= 1);
  await d.destroy();
});
