/**
 * decrypter 残余分支补测（wave 123）：
 *  - defaultKeyLoader 三路径（无 fetch / 非 2xx / 成功返回）
 *  - _decryptSoftware 直接单测（长度非法 → PARSE_ERROR；坏密钥 → DECODE_ERROR）
 *  - destroy() 清空密钥缓存（keyLoader 再次触发）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { Aes128Decrypter } from '../src/decrypter.js';
import { PlayerError } from '../../core/src/errors.js';

const KEY = new Uint8Array([
  0x0b, 0x1c, 0x2d, 0x3e, 0x4f, 0x50, 0x61, 0x72,
  0x83, 0x94, 0xa5, 0xb6, 0xc7, 0xd8, 0xe9, 0xfa,
]);

/** 临时替换 globalThis.fetch（保存属性描述符，finally 还原） */
async function withFetch(stub, fn) {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  try {
    if (stub === undefined) {
      Object.defineProperty(globalThis, 'fetch', { value: undefined, configurable: true, writable: true });
    } else {
      Object.defineProperty(globalThis, 'fetch', { value: stub, configurable: true, writable: true });
    }
    return await fn();
  } finally {
    if (desc) Object.defineProperty(globalThis, 'fetch', desc);
    else delete globalThis.fetch;
  }
}

test('defaultKeyLoader：无 fetch 环境抛 NOT_SUPPORTED（提示注入 keyLoader）', async () => {
  const d = new Aes128Decrypter({ crypto: webcrypto }); // 不注入 keyLoader → 走默认实现
  await withFetch(undefined, () =>
    assert.rejects(
      () => d.getKey('https://example.com/key.bin'),
      (e) => e instanceof PlayerError && e.code === 'NOT_SUPPORTED' && /keyLoader/.test(e.message)
    )
  );
});

test('defaultKeyLoader：密钥响应非 2xx → SOURCE_ERROR 携带状态码', async () => {
  const d = new Aes128Decrypter({ crypto: webcrypto });
  await withFetch(async () => ({ ok: false, status: 403 }), () =>
    assert.rejects(
      () => d.getKey('https://example.com/key.bin'),
      (e) => e instanceof PlayerError && e.code === 'SOURCE_ERROR' && /403/.test(e.message)
    )
  );
});

test('defaultKeyLoader：成功路径返回 16 字节密钥并可导入', async () => {
  const d = new Aes128Decrypter({ crypto: webcrypto });
  await withFetch(
    async () => ({ ok: true, status: 200, arrayBuffer: async () => KEY.slice().buffer }),
    async () => {
      const entry = await d.getKey('https://example.com/key.bin');
      assert.deepEqual(Array.from(entry.raw), Array.from(KEY));
      assert.ok(entry.imported, 'imported CryptoKey 已生成');
    }
  );
});

test('_decryptSoftware：分片长度非 16 的倍数 → PARSE_ERROR', () => {
  const d = new Aes128Decrypter({ crypto: webcrypto });
  assert.throws(
    () => d._decryptSoftware(new Uint8Array(20), new Uint8Array(16), KEY, new Error('cause')),
    (e) => e instanceof PlayerError && e.code === 'PARSE_ERROR' && /16 的倍数/.test(e.message)
  );
});

test('_decryptSoftware：坏密钥（长度≠16）→ DECODE_ERROR 且携带 cause', () => {
  const d = new Aes128Decrypter({ crypto: webcrypto });
  const cause = new Error('simulated subtle failure');
  assert.throws(
    () => d._decryptSoftware(new Uint8Array(32), new Uint8Array(16), new Uint8Array(15), cause),
    (e) => {
      assert.equal(e.code, 'DECODE_ERROR');
      assert.equal(e.cause, cause, 'cause 应透传主路径错误');
      return true;
    }
  );
});

test('destroy：清空密钥缓存，同 URI 再次 getKey 触发 keyLoader', async () => {
  let calls = 0;
  const d = new Aes128Decrypter({
    crypto: webcrypto,
    keyLoader: async () => {
      calls += 1;
      return KEY;
    },
  });
  await d.getKey('https://example.com/again.bin');
  d.destroy();
  await d.getKey('https://example.com/again.bin');
  assert.equal(calls, 2, '缓存已清空 → keyLoader 第二次触发');
});

test('defaultKeyLoader：密钥响应超过小资源上限 → SOURCE_ERROR 拒收（第二百零三波）', async () => {
  const { DEFAULT_MAX_SMALL_RESOURCE_BYTES } = await import('../../core/src/limits.js');
  const d = new Aes128Decrypter({ crypto: webcrypto });
  const oversize = new ArrayBuffer(DEFAULT_MAX_SMALL_RESOURCE_BYTES + 1);
  await withFetch(
    async () => ({ ok: true, status: 200, arrayBuffer: async () => oversize }),
    () =>
      assert.rejects(
        () => d.getKey('https://example.com/huge-key.bin'),
        (e) =>
          e instanceof PlayerError &&
          e.code === 'SOURCE_ERROR' &&
          /密钥响应过大/.test(e.message) &&
          String(DEFAULT_MAX_SMALL_RESOURCE_BYTES).includes(String(1 << 20).slice(0, 3)),
      ),
  );
});
