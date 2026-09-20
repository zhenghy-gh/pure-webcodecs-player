/**
 * webtorrent-create-source-gaps.test.js —— createSource 残余分支补测（wave 142）
 *
 * 覆盖：
 *   - 非法输入（既非字符串也非 Uint8Array/Blob）→ PARSE_ERROR；
 *   - network 路径 attach 成功：注入 fake player，断言 meta.mode='network'、
 *     magnet 输入附带 infoHash/trackers、files/selected 形状；attach 失败时 player.destroy() 兜底。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSource } from '../src/index.js';

test('createSource：非法输入类型 → PARSE_ERROR', async () => {
  await assert.rejects(
    () => createSource(42),
    (e) => e.code === 'PARSE_ERROR' && e.message.includes('magnet/url 字符串或 .torrent 字节'),
  );
  await assert.rejects(
    () => createSource(null),
    (e) => e.code === 'PARSE_ERROR',
  );
  await assert.rejects(
    () => createSource({ read: () => {} }),
    (e) => e.code === 'PARSE_ERROR',
  );
});

function fakePlayer(attachResult) {
  const calls = { attach: [], destroyed: 0 };
  return {
    calls,
    attach: async (input) => {
      calls.attach.push(input);
      if (attachResult instanceof Error) throw attachResult;
      return attachResult;
    },
    destroy: async () => { calls.destroyed += 1; },
  };
}

test('createSource：magnet 网络路径 attach 成功 → meta.mode=network 附带 infoHash/trackers', async () => {
  const source = { size: 8, read: async () => new Uint8Array(0), close: () => {} };
  const player = fakePlayer({
    source,
    torrent: { name: 'demo', files: [{ name: 'a.txt', length: 3 }, { name: 'b.mkv', path: 'dir/b.mkv', length: 5 }] },
    file: { name: 'b.mkv', length: 5 },
  });
  const magnet = `magnet:?xt=urn:btih:${'ab'.repeat(20)}&tr=${encodeURIComponent('udp://t.example:1337')}`;
  const out = await createSource(magnet, { player });
  assert.equal(out.source, source);
  assert.equal(out.player, player);
  assert.equal(out.meta.mode, 'network');
  assert.equal(out.meta.infoHash, 'ab'.repeat(20));
  assert.deepEqual(out.meta.trackers, ['udp://t.example:1337']);
  assert.equal(out.meta.name, 'demo');
  assert.deepEqual(out.meta.files, [
    { path: 'a.txt', length: 3 },
    { path: 'dir/b.mkv', length: 5 },
  ]);
  assert.deepEqual(out.meta.selected, { path: 'b.mkv', length: 5 });
  assert.equal(player.calls.destroyed, 0);
});

test('createSource：http(s) url 网络路径不带 magnetInfo；attach 失败时 destroy 兜底', async () => {
  const player = fakePlayer(new Error('attach boom'));
  await assert.rejects(() => createSource('https://gw.example/t.torrent', { player }), /attach boom/);
  assert.equal(player.calls.destroyed, 1);
});
