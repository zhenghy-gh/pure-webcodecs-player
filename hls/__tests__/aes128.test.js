/**
 * HLS AES-128 解密单测（CONTRACTS v0.2 §2.6 全条款）
 *
 * 同构要求：注入 node:crypto 的 webcrypto 作为 subtle 提供方，
 * 与浏览器 crypto.subtle 走同一套代码路径。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import {
  Aes128Decrypter,
  ivFromMediaSequence,
  looksLikePlaintext,
} from '../src/decrypter.js';
import { aesCbcDecryptNoPadding, stripPkcs7 } from '../src/aes-cbc.js';

const subtle = webcrypto.subtle;
const KEY = new Uint8Array([0x0b, 0x1c, 0x2d, 0x3e, 0x4f, 0x50, 0x61, 0x72, 0x83, 0x94, 0xa5, 0xb6, 0xc7, 0xd8, 0xe9, 0xfa]);
const IV_HEX = new Uint8Array(16).fill(0xab);

/** 构造一段以 0x47 开头的"TS 分片"明文（188*3=564B） */
function makeTsPlaintext() {
  const data = new Uint8Array(188 * 3);
  data[0] = 0x47;
  for (let i = 1; i < data.length; i++) data[i] = (i * 7) & 0xff;
  return data;
}

async function encryptPkcs7(key, iv, plain) {
  const k = await subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['encrypt']);
  const cipher = await subtle.encrypt({ name: 'AES-CBC', iv }, k, plain);
  return new Uint8Array(cipher);
}

function makeDecrypter(keyBytes = KEY) {
  return new Aes128Decrypter({
    crypto: webcrypto,
    keyLoader: async () => keyBytes,
  });
}

test('IV 推导：媒体序号 128 位大端（高 64 位补零）', () => {
  const iv = ivFromMediaSequence(2680);
  assert.equal(iv.length, 16);
  // 2680 = 0x0A78
  assert.deepEqual(
    Array.from(iv.slice(14)),
    [0x0a, 0x78]
  );
  assert.ok(iv.slice(0, 12).every((b) => b === 0), '高 96 位应为零');
});

test('looksLikePlaintext：TS 定界符与 ISO-BMFF box 头判定', () => {
  const ts = new Uint8Array(188);
  ts[0] = 0x47;
  assert.equal(looksLikePlaintext(ts), true);

  const fmp4 = new Uint8Array(64);
  fmp4[3] = 40; // size=40
  fmp4.set([0x73, 0x74, 0x79, 0x70], 4); // 'styp'
  assert.equal(looksLikePlaintext(fmp4), true);

  assert.equal(looksLikePlaintext(new Uint8Array(16).fill(0)), false);
  assert.equal(looksLikePlaintext(new Uint8Array(4)), false);
});

test('解密往返：PKCS7 合规流走 WebCrypto 主路径', async (t) => {
  const plain = makeTsPlaintext();
  const cipher = await encryptPkcs7(KEY, IV_HEX, plain);
  // 确认主路径命中（subtle 可用时应直接成功）
  const d = makeDecrypter();
  const out = await d.decryptSegment(
    cipher,
    { method: 'AES-128', uri: 'https://example.com/key.bin', iv: { bytes: IV_HEX } },
    { sn: 100 }
  );
  assert.deepEqual(Array.from(out), Array.from(plain));
});

test('IV 缺省：按媒体序号推导且能正确解密', async () => {
  const sn = 2680;
  const iv = ivFromMediaSequence(sn);
  const plain = makeTsPlaintext();
  const cipher = await encryptPkcs7(KEY, iv, plain);
  const d = makeDecrypter();
  // keyInfo.iv 为 null → 触发 sn 推导路径
  const out = await d.decryptSegment(
    cipher,
    { method: 'AES-128', uri: 'https://example.com/key.bin', iv: null },
    { sn }
  );
  assert.deepEqual(Array.from(out), Array.from(plain));
});

test('兜底路径：subtle 故障时由软件 CBC 解密恢复（含 PKCS7 剥离）', async () => {
  const plain = makeTsPlaintext();
  const cipher = await encryptPkcs7(KEY, IV_HEX, plain);

  const d = makeDecrypter();
  // 强制主路径失败：替换 subtle.decrypt 抛错（保留 importKey 委托）
  d.subtle = {
    importKey: (...args) => webcrypto.subtle.importKey(...args),
    decrypt: async () => {
      throw new Error('simulated OperationError');
    },
  };
  const out = await d.decryptSegment(
    cipher,
    { method: 'AES-128', uri: 'https://example.com/key.bin', iv: { bytes: IV_HEX } },
    { sn: 1 }
  );
  assert.deepEqual(Array.from(out), Array.from(plain), '软件兜底须与标准结果一致');
});

test('未填充/截断流：软件兜底可完整恢复明文（subtle 静默误剥离的残余风险见 README）', async () => {
  // 模拟"服务端按零填充到块边界、不带 PKCS7"的流：取块对齐明文（560=35×16），
  // 截掉标准加密结果的填充块后，无填充解密应精确还原原媒体字节。
  const plain = new Uint8Array(35 * 16);
  plain[0] = 0x47;
  for (let i = 1; i < plain.length; i++) plain[i] = (i * 13 + 5) & 0xff;
  const paddedCipher = await encryptPkcs7(KEY, IV_HEX, plain);
  const truncatedCipher = paddedCipher.subarray(0, paddedCipher.length - 16);

  const d = makeDecrypter();
  d.subtle = {
    importKey: (...args) => webcrypto.subtle.importKey(...args),
    decrypt: async () => {
      throw new Error('simulated OperationError');
    },
  };
  const out = await d.decryptSegment(
    truncatedCipher,
    { method: 'AES-128', uri: 'https://example.com/key.bin', iv: { bytes: IV_HEX } },
    { sn: 1 }
  );
  assert.equal(out.length, plain.length);
  assert.deepEqual(Array.from(out), Array.from(plain));
});

test('软件 AES 与 node webcrypto 结果一致性（交叉验证）', async () => {
  const plain = makeTsPlaintext();
  const cipher = await encryptPkcs7(KEY, IV_HEX, plain);
  const swPlain = aesCbcDecryptNoPadding(KEY, IV_HEX, cipher);
  assert.ok(stripPkcs7(swPlain), 'PKCS7 应可严格剥离');
  assert.deepEqual(
    Array.from(stripPkcs7(swPlain)),
    Array.from(plain),
    '软件实现须与标准库一致'
  );
});

test('错误映射：SAMPLE-AES → NOT_SUPPORTED（不得静默跳过）', async () => {
  const d = makeDecrypter();
  await assert.rejects(
    () =>
      d.decryptSegment(new Uint8Array(32), { method: 'SAMPLE-AES', uri: null, iv: null }, { sn: 0 }),
    (e) => e.code === 'NOT_SUPPORTED'
  );
});

test('错误映射：无 crypto.subtle 环境 → 明文清单不受影响、加密清单报 NOT_SUPPORTED', async () => {
  const d = new Aes128Decrypter({ crypto: null, keyLoader: async () => KEY });
  assert.equal(d.hasSubtle, false);
  // 明文直通
  const data = new Uint8Array(32).fill(9);
  assert.deepEqual(await d.decryptSegment(data, null, {}), data);
  // 加密清单：assertSupported 为同步抛错，用 assert.throws
  assert.throws(() => d.assertSupported({ method: 'AES-128' }), (e) => e.code === 'NOT_SUPPORTED');
});

test('错误映射：密钥长度≠16 字节 → NOT_SUPPORTED', async () => {
  const d = new Aes128Decrypter({
    crypto: webcrypto,
    keyLoader: async () => new Uint8Array(15),
  });
  await assert.rejects(
    () => d.getKey('https://example.com/short.bin'),
    (e) => e.code === 'NOT_SUPPORTED'
  );
});

test('错误映射：密钥获取失败 → NETWORK_ERROR', async () => {
  const d = new Aes128Decrypter({
    crypto: webcrypto,
    keyLoader: async () => {
      throw new Error('connection refused');
    },
  });
  await assert.rejects(
    () => d.getKey('https://example.com/fail.bin'),
    (e) => e.code === 'NETWORK_ERROR'
  );
});

test('错误映射：密钥错误导致明文形态校验失败 → PARSE_ERROR', async () => {
  // 用正确密钥加密"非 TS/box 形态"的明文，再用错误密钥解密：
  // 解密本身成功但首块校验必须失败。fill=0x00 为经探测固定的确定性用例。
  const garbage = new Uint8Array(48).fill(0x00);
  const cipher = await encryptPkcs7(KEY, IV_HEX, garbage);
  const WRONG_KEY = new Uint8Array(16).fill(0x11);
  const d = new Aes128Decrypter({
    crypto: webcrypto,
    keyLoader: async () => WRONG_KEY,
  });
  await assert.rejects(
    () =>
      d.decryptSegment(cipher, { method: 'AES-128', uri: 'https://example.com/key.bin', iv: { bytes: IV_HEX } }, { sn: 0 }),
    (e) => e.code === 'PARSE_ERROR'
  );
});

test('密钥缓存：同 URI 只触发一次 keyLoader', async () => {
  let calls = 0;
  const d = new Aes128Decrypter({
    crypto: webcrypto,
    keyLoader: async () => {
      calls += 1;
      return KEY;
    },
  });
  await d.getKey('https://example.com/same.bin');
  await d.getKey('https://example.com/same.bin');
  assert.equal(calls, 1);
});
