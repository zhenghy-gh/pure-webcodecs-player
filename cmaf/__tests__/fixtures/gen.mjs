/**
 * fixtures/gen.mjs —— cmaf 轨样例程序化生成（契约 §0.6）
 *
 * 复用 hls 模块的 fMP4 构造器产出合法字节流（零外网、零大文件、单文件 ≤256KB）：
 *   init.cmf1            视频轨初始化段（ftyp+moov，avcC）
 *   chunk-000.cmf1 …     CMAF chunk（styp+moof+mdat），每块 3 帧、首帧关键帧
 */

const FAKE_AVC_C = new Uint8Array([
  0x01, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x08, 0x67, 0x64, 0x00, 0x1f,
  0xac, 0xd9, 0x40, 0x50, 0x01, 0x00, 0x04, 0x68, 0xeb, 0xec, 0xb2,
]);

function videoTrak() {
  return {
    id: 1,
    type: 'video',
    codec: 'avc1.64001f',
    description: { tag: 'avcC', bytes: FAKE_AVC_C },
    width: 640,
    height: 360,
    timescale: 90000,
  };
}

/** 契约签名：async generate(fixDir) */
export async function generate(fixDir) {
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  // 延迟引入避免测试目录间构建期耦合
  const { _internalForTest } = await import('../../../hls/src/fmp4-muxer.js');

  await writeFile(join(fixDir, 'init.cmf1'), _internalForTest.buildInit([videoTrak()]));

  for (let c = 0; c < 4; c++) {
    const frames = [];
    for (let i = 0; i < 3; i++) {
      frames.push({
        dts: (c * 3 + i) * 3003,
        pts: (c * 3 + i) * 3003,
        duration: 3003,
        keyframe: i === 0,
        data: new Uint8Array(48 + ((i + c) % 7)).fill((i + 1) * (c + 1)),
      });
    }
    const frag = _internalForTest.buildFragment({ trackId: 1, timescale: 90000, samples: frames });
    await writeFile(join(fixDir, `chunk-00${c}.cmf1`), frag);
  }
}
