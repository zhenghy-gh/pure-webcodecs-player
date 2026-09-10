/**
 * video-frame-renderer 可测化：用注入的假 canvas/gl/ctx 在 Node 下跑通真实构造与绘制分支。
 *
 * 覆盖：选路判定（auto/2d/webgl）、fit 归一化、computeLetterbox 真实几何、
 *      WebGL UV 变换数学、WebGL→2D 永久降级、VideoFrame 所有权 close、resize/clear/destroy。
 * 手法：临时挂 globalThis.document（与可选 VideoFrame），try/finally 还原并断言清干净。
 * 不覆盖：真实浏览器 WebGL 上下文/着色器编译与真实 VideoFrame 纹理上传。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoFrameRenderer, createVideoRenderer } from '../src/video-frame-renderer.js';

/* ------------------------------ Fake 环境 ------------------------------ */

class Fake2D {
  constructor({ throwOnDraw = false } = {}) {
    this.ops = [];
    this.fillStyle = null;
    this._throwOnDraw = throwOnDraw;
  }
  fillRect(...args) {
    this.ops.push(['fillRect', ...args]);
  }
  drawImage(...args) {
    if (this._throwOnDraw) throw new Error('2d drawImage 失败');
    this.ops.push(['drawImage', ...args]);
  }
}

class FakeGL {
  constructor({ shaderOk = true, linkOk = true, throwOn = null } = {}) {
    // WebGL 常量（真实数值无关，只要自洽）
    const C = {
      COMPILE_STATUS: 1, VERTEX_SHADER: 2, FRAGMENT_SHADER: 3, LINK_STATUS: 4,
      ARRAY_BUFFER: 5, STATIC_DRAW: 6, FLOAT: 7, TEXTURE_2D: 8,
      TEXTURE_WRAP_S: 9, TEXTURE_WRAP_T: 10, CLAMP_TO_EDGE: 11,
      TEXTURE_MIN_FILTER: 12, TEXTURE_MAG_FILTER: 13, LINEAR: 14,
      RGBA: 15, UNSIGNED_BYTE: 16, COLOR_BUFFER_BIT: 17, TRIANGLE_STRIP: 18, TEXTURE0: 19,
    };
    Object.assign(this, C);
    this.uniforms = [];
    this.clears = 0;
    this._shaderOk = shaderOk;
    this._linkOk = linkOk;
    this._throwOn = throwOn;
  }
  _hit(name) {
    if (this._throwOn === name) throw new Error(`gl ${name} 失败`);
  }
  createShader() { this._hit('createShader'); return { id: 's' }; }
  shaderSource() {}
  compileShader() {}
  getShaderParameter() { return this._shaderOk; }
  getShaderInfoLog() { return 'compile info'; }
  deleteShader() {}
  createProgram() { return { id: 'p' }; }
  attachShader() {}
  linkProgram() {}
  getProgramParameter() { return this._linkOk; }
  getProgramInfoLog() { return 'link info'; }
  deleteProgram() {}
  createBuffer() { return { id: 'b' }; }
  bindBuffer() {}
  bufferData() {}
  getAttribLocation() { return 0; }
  enableVertexAttribArray() {}
  vertexAttribPointer() {}
  createTexture() { return { id: 't' }; }
  bindTexture() {}
  texParameteri() {}
  clearColor() {}
  getUniformLocation() { return { id: 'u' }; }
  uniform1i() {}
  uniform4f(...args) {
    this._hit('uniform4f');
    this.uniforms.push(args);
  }
  viewport() {}
  clear() { this.clears += 1; }
  useProgram() {}
  activeTexture() {}
  texImage2D() { this._hit('texImage2D'); }
  drawArrays() { this._hit('drawArrays'); }
  deleteTexture() {}
  deleteBuffer() {}
  getExtension() { return null; }
}

function makeCanvas({ gl = null, ctx = null, width = 100, height = 100 } = {}) {
  return {
    width,
    height,
    getContext(kind) {
      if (kind === '2d') return ctx;
      if (kind === 'webgl' || kind === 'experimental-webgl') return gl;
      return null;
    },
  };
}

async function withGlobals(patch, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(patch)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  try {
    return await fn();
  } finally {
    for (const [key, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete globalThis[key];
    }
  }
}

const withDocument = (fn) => withGlobals({ document: {} }, fn);
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
/** uniform4f(location, x, y, z, w) —— 首参为 uniform 位置，四浮点在 slice(1) */
function assertUniform(callArgs, expected) {
  assert.equal(callArgs.length, 5, 'uniform4f 必须 location + 四分量');
  const v = callArgs.slice(1);
  expected.forEach((want, i) => assert.ok(approx(v[i], want), `uniform4f[${i}]=${v[i]} 应≈ ${want}`));
}

/* ------------------------------ 构造与选路 ------------------------------ */

test('无 DOM 环境构造抛 NOT_SUPPORTED（优雅降级不崩溃）', () => {
  assert.equal(typeof document, 'undefined');
  assert.throws(
    () => new VideoFrameRenderer(makeCanvas({ ctx: new Fake2D() })),
    (e) => e.code === 'NOT_SUPPORTED',
  );
});

test('mode=2d：直接走 Canvas2D 路径；非法 fit 归一化为 contain', async () => {
  await withDocument(() => {
    const ctx = new Fake2D();
    const r = new VideoFrameRenderer(makeCanvas({ ctx }), { mode: '2d', fit: 'squish' });
    assert.equal(r.mode, '2d');
    assert.equal(r._gl, null);
    assert.equal(r.fit, 'contain', '未知 fit 回落 contain');
    assert.equal(r.requestedMode, '2d');
    assert.equal(r.flipY, true, 'flipY 默认 true');
    assert.equal(new VideoFrameRenderer(makeCanvas({ ctx }), { mode: '2d', flipY: false }).flipY, false);
  });
  assert.equal(globalThis.document, undefined, 'document 已还原');
});

test('createVideoRenderer：preference 为定稿参数名，并作为 mode 传入', async () => {
  await withDocument(() => {
    const r = createVideoRenderer(makeCanvas({ ctx: new Fake2D() }), { preference: '2d' });
    assert.equal(r.mode, '2d');
    assert.equal(r.requestedMode, '2d');
  });
});

test('选路失败：auto 且 webgl/2d 均不可用时抛 NOT_SUPPORTED', async () => {
  await withDocument(() => {
    assert.throws(
      () => new VideoFrameRenderer(makeCanvas({ gl: null, ctx: null })),
      (e) => e.code === 'NOT_SUPPORTED',
    );
    // 显式 webgl 失败不回落到 2D
    assert.throws(
      () => new VideoFrameRenderer(makeCanvas({ gl: null, ctx: new Fake2D() }), { mode: 'webgl' }),
      (e) => e.code === 'NOT_SUPPORTED',
    );
  });
});

test('选路：auto 下 WebGL 着色器编译失败 → 回落 2D', async () => {
  await withDocument(() => {
    const gl = new FakeGL({ shaderOk: false });
    const r = new VideoFrameRenderer(makeCanvas({ gl, ctx: new Fake2D() }));
    assert.equal(r.mode, '2d', '编译失败应静默回落 2D');
    assert.equal(r._gl, null);
  });
});

test('选路：auto 下 WebGL 链接失败 → 回落 2D', async () => {
  await withDocument(() => {
    const gl = new FakeGL({ linkOk: false });
    const r = new VideoFrameRenderer(makeCanvas({ gl, ctx: new Fake2D() }));
    assert.equal(r.mode, '2d');
  });
});

test('选路：auto 下 WebGL 可用 → 优先走 WebGL（GPU 零拷贝）', async () => {
  await withDocument(() => {
    const gl = new FakeGL();
    const r = new VideoFrameRenderer(makeCanvas({ gl, ctx: new Fake2D() }));
    assert.equal(r.mode, 'webgl');
    assert.equal(r._gl, gl);
  });
});

/* ------------------------------ computeLetterbox 真实几何 ------------------------------ */

test('computeLetterbox：contain/cover/fill 与退化尺寸分支', async () => {
  await withDocument(() => {
    const contain = new VideoFrameRenderer(makeCanvas({ ctx: new Fake2D() }), { mode: '2d', fit: 'contain' });
    assert.deepEqual(contain.computeLetterbox(16, 9, 100, 100), {
      x: 0, y: 21.875, width: 100, height: 56.25,
    });
    const cover = new VideoFrameRenderer(makeCanvas({ ctx: new Fake2D() }), { mode: '2d', fit: 'cover' });
    const rc = cover.computeLetterbox(16, 9, 100, 100);
    assert.ok(approx(rc.x, -38.888888888888886) && rc.y === 0 && approx(rc.width, 177.77777777777777) && rc.height === 100);
    const fill = new VideoFrameRenderer(makeCanvas({ ctx: new Fake2D() }), { mode: '2d', fit: 'fill' });
    assert.deepEqual(fill.computeLetterbox(16, 9, 100, 100), { x: 0, y: 0, width: 100, height: 100 });
    // 退化尺寸：直接返回目标框，不除以零
    assert.deepEqual(contain.computeLetterbox(0, 0, 320, 240), { x: 0, y: 0, width: 320, height: 240 });
    assert.deepEqual(contain.computeLetterbox(16, 9, 0, 0), { x: 0, y: 0, width: 0, height: 0 });
  });
});

/* ------------------------------ WebGL 绘制与 UV 变换 ------------------------------ */

test('_drawWebGL：contain/cover/fill 的 UV 缩放与居中偏移（NDC）', async () => {
  await withDocument(() => {
    const gl = new FakeGL();
    const r = new VideoFrameRenderer(makeCanvas({ gl, ctx: new Fake2D(), width: 100, height: 100 }), { fit: 'contain' });
    const frameWide = { width: 16, height: 9 }; // videoAspect > canvasAspect
    assert.equal(r.draw(frameWide), true);
    assertUniform(gl.uniforms.at(-1), [1, 0.5625, 0, 0.21875]);

    // 缺陷修复：flipY 现在必须真实切换垂直方向（旧实现两个分支恒等，flipY 失效）。
    // flipY=true（默认）保持原 upright（uvTop=offY=0.21875）；flipY=false 应做关于 v=0.5 的镜像（uvTop=1-offY=0.78125）。
    const rNoFlip = new VideoFrameRenderer(
      makeCanvas({ gl, ctx: new Fake2D(), width: 100, height: 100 }),
      { fit: 'contain', flipY: false },
    );
    assert.equal(rNoFlip.draw(frameWide), true);
    assertUniform(gl.uniforms.at(-1), [1, 0.5625, 0, 1 - 0.21875]);
    assert.notEqual(0.21875, 1 - 0.21875, 'flipY=false 必须使 uvTop 不同于 flipY=true');

    r.fit = 'cover';
    assert.equal(r.draw(frameWide), true);
    assertUniform(gl.uniforms.at(-1), [16 / 9, 1, (1 - 16 / 9) / 2, 0]);

    r.fit = 'fill';
    assert.equal(r.draw(frameWide), true);
    assertUniform(gl.uniforms.at(-1), [1, 1, 0, 0]);

    // contain + 竖屏源（videoAspect <= canvasAspect → scaleX 分支）
    r.fit = 'contain';
    assert.equal(r.draw({ width: 9, height: 16 }), true);
    assertUniform(gl.uniforms.at(-1), [0.5625, 1, 0.21875, 0]);
  });
});

test('_drawWebGL：尺寸为 0 时仅清屏返回 false，不使用着色器', async () => {
  await withDocument(() => {
    const gl = new FakeGL();
    const r = new VideoFrameRenderer(makeCanvas({ gl, ctx: new Fake2D() }));
    assert.equal(r.draw({ width: 0, height: 0 }), false);
    assert.equal(gl.uniforms.length, 0);
    assert.equal(gl.clears, 1, '仍执行清屏');
  });
});

test('WebGL 绘制抛错 → 永久降级 2D 并 emit fallback，不再回到 WebGL', async () => {
  await withDocument(() => {
    const gl = new FakeGL({ throwOn: 'uniform4f' });
    const ctx = new Fake2D();
    const r = new VideoFrameRenderer(makeCanvas({ gl, ctx }));
    assert.equal(r.mode, 'webgl');
    const fallbacks = [];
    r.on('fallback', (err) => fallbacks.push(err));
    const ok = r.draw({ width: 16, height: 9 });
    assert.equal(ok, true, '降级后 2D 绘制成功');
    assert.equal(r.mode, '2d');
    assert.equal(r._gl, null);
    assert.equal(r._degraded, true);
    assert.equal(fallbacks.length, 1);
    assert.match(fallbacks[0].message, /uniform4f/);
    // 第二次绘制走 2D，不再触发 fallback
    assert.equal(r.draw({ width: 16, height: 9 }), true);
    assert.equal(fallbacks.length, 1);
    assert.equal(ctx.ops.filter((o) => o[0] === 'drawImage').length, 2);
  });
});

/* ------------------------------ 2D 绘制 ------------------------------ */

test('_draw2D：按 letterbox 矩形 drawImage；尺寸为 0 时仅清屏返回 false', async () => {
  await withDocument(() => {
    const ctx = new Fake2D();
    const r = new VideoFrameRenderer(makeCanvas({ ctx, width: 100, height: 100 }), { mode: '2d' });
    assert.equal(r.draw({ videoWidth: 16, videoHeight: 9 }), true);
    const draw = ctx.ops.find((o) => o[0] === 'drawImage');
    assert.ok(draw, '应调用 drawImage');
    assert.equal(draw[1].videoWidth, 16);
    assert.deepEqual(draw.slice(2), [0, 21.875, 100, 56.25]);
    assert.equal(ctx.ops[0][0], 'fillRect');
    assert.equal(ctx.fillStyle, '#000', '先铺黑底再贴帧');

    ctx.ops.length = 0;
    assert.equal(r.draw({ videoWidth: 0, videoHeight: 0 }), false);
    assert.equal(ctx.ops.filter((o) => o[0] === 'drawImage').length, 0);
  });
});

test('_frameSize：VideoFrame 用 displayWidth/Height，元素按 videoWidth→displayWidth→width 回落', async () => {
  await withDocument(() => {
    const r = new VideoFrameRenderer(makeCanvas({ ctx: new Fake2D() }), { mode: '2d' });
    assert.deepEqual(r._frameSize({ videoWidth: 0, displayWidth: 640, width: 1280, height: 0, displayHeight: 360 }), {
      width: 640,
      height: 360,
    });
    assert.deepEqual(r._frameSize({ width: 10, height: 20 }), { width: 10, height: 20 });
  });
});

test('2D 绘制抛错（无 WebGL 可降级）→ emit error 且返回 false', async () => {
  await withDocument(() => {
    const r = new VideoFrameRenderer(makeCanvas({ ctx: new Fake2D({ throwOnDraw: true }) }), { mode: '2d' });
    const errors = [];
    r.on('error', (e) => errors.push(e));
    assert.equal(r.draw({ width: 16, height: 9 }), false);
    assert.equal(errors.length, 1);
  });
});

/* ------------------------------ VideoFrame 所有权 ------------------------------ */

test('draw(VideoFrame)：绘制结束（含异常）由渲染器 close，调用方不复用', async () => {
  class FakeVideoFrame {
    constructor(w, h) {
      this.displayWidth = w;
      this.displayHeight = h;
      this.closes = 0;
    }
    close() {
      this.closes += 1;
    }
  }
  await withGlobals({ document: {}, VideoFrame: FakeVideoFrame }, () => {
    const r = new VideoFrameRenderer(makeCanvas({ ctx: new Fake2D() }), { mode: '2d' });
    const frame = new FakeVideoFrame(16, 9);
    assert.equal(r.draw(frame), true);
    assert.equal(frame.closes, 1, 'render 调用后所有权移交，渲染器负责 close');
    assert.equal(r._frameSize(frame).width, 16, 'VideoFrame 走 displayWidth 分支');
  });
  assert.equal(globalThis.VideoFrame, undefined, 'VideoFrame 假全局已还原');
});

test('draw：VideoFrame.close 抛错被吞掉，不影响绘制结果', async () => {
  class BadVideoFrame {
    constructor() {
      this.displayWidth = 16;
      this.displayHeight = 9;
    }
    close() {
      throw new Error('double close');
    }
  }
  await withGlobals({ document: {}, VideoFrame: BadVideoFrame }, () => {
    const r = new VideoFrameRenderer(makeCanvas({ ctx: new Fake2D() }), { mode: '2d' });
    assert.equal(r.draw(new BadVideoFrame()), true);
  });
});

/* ------------------------------ resize / clear / destroy ------------------------------ */

test('resize：仅在尺寸变化时改写 canvas（避免无谓重排）', async () => {
  await withDocument(() => {
    const canvas = makeCanvas({ ctx: new Fake2D(), width: 100, height: 100 });
    const r = new VideoFrameRenderer(canvas, { mode: '2d' });
    r.resize(100, 100);
    assert.equal(canvas.width, 100);
    r.resize(320, 240);
    assert.equal(canvas.width, 320);
    assert.equal(canvas.height, 240);
  });
});

test('clear：2D 填充指定颜色；WebGL 调用 gl.clear', async () => {
  await withDocument(() => {
    const ctx = new Fake2D();
    const r = new VideoFrameRenderer(makeCanvas({ ctx }), { mode: '2d' });
    r.clear('#123456');
    assert.equal(ctx.fillStyle, '#123456');
    assert.deepEqual(ctx.ops.at(-1), ['fillRect', 0, 0, 100, 100]);

    const gl = new FakeGL();
    const rw = new VideoFrameRenderer(makeCanvas({ gl, ctx: new Fake2D() }));
    rw.clear();
    assert.equal(gl.clears, 1);
  });
});

test('destroy：释放 GL 资源、清空 ctx、移除全部监听（幂等）', async () => {
  await withDocument(() => {
    const gl = new FakeGL();
    const r = new VideoFrameRenderer(makeCanvas({ gl, ctx: new Fake2D() }));
    let emitted = 0;
    r.on('anything', () => (emitted += 1));
    r.destroy();
    assert.equal(r._gl, null);
    assert.equal(r._ctx, null);
    r.emit('anything');
    assert.equal(emitted, 0, 'destroy 后监听已清空');
  });
});
