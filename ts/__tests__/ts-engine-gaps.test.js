/**
 * TS 引擎与探测残余防御分支直测（第一百九十八波）
 * ------------------------------------------------------------
 * 补齐 ts 模块最后 4 处未覆盖行：
 *   - TsDemuxer.probe 字节访问抛错 → 防御性返回 null（对齐 MP4 probe 先例）；
 *   - _onPsiSection 整段 try/catch：section 访问抛错统一转 error 事件；
 *   - _rebuildVideoConfig：SPS 访问抛错转 error 事件后仍走 _emitTracks 收尾。
 * 引擎私有方法直测先例：pcr.test.js 的 _parsePacket/_emitMetadata。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { TsDemuxer } from '../src/ts-demuxer.js';
import { TsStreamEngine } from '../src/ts-stream-engine.js';

test('probe：字节访问抛错 → 防御性返回 null（不抛异常）', () => {
  const evil = { byteLength: 64 };
  Object.defineProperty(evil, 0, { get() { throw new Error('boom'); } });
  assert.equal(TsDemuxer.probe(evil), null);
});

test('_onPsiSection：section 数据访问抛错 → error 事件不外泄', () => {
  const e = new TsStreamEngine();
  const errs = [];
  e.on('error', (err) => errs.push(err));
  const section = { length: 1 };
  Object.defineProperty(section, 0, { get() { throw new Error('section-boom'); } });
  e._onPsiSection(0, section);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].message, 'section-boom');
});

test('_rebuildVideoConfig：SPS 访问抛错 → error 事件且仍完成 tracks 重建收尾', () => {
  const e = new TsStreamEngine();
  const errs = [];
  let tracksEmitted = 0;
  e.on('error', (err) => errs.push(err));
  e.on('tracks', () => { tracksEmitted++; });
  const state = {};
  Object.defineProperty(state, 'lastSps', { get() { throw new Error('sps-boom'); } });
  e._rebuildVideoConfig(state, false);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].message, 'sps-boom');
  assert.equal(tracksEmitted, 1, 'catch 之后 _emitTracks 照常执行（配置重建失败不阻断轨表刷新）');
});
