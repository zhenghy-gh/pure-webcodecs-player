/**
 * VideoFrame 渲染器：把解码产物（VideoFrame / HTMLVideoElement / ImageBitmap）
 * 画到 <canvas> 上，支持 2D 与 WebGL 两条路径与信箱（letterbox）适配。
 *
 * 选路规则：
 *   mode='auto' → 有 WebGL 用 WebGL（VideoFrame 可直接作为纹理源，GPU 零拷贝），
 *                 否则退回 Canvas2D；任一路径 draw 抛错自动永久降级到 2D 并 emit('fallback')。
 */
import { Emitter } from './emitter.js';
import { notSupported } from './errors.js';

const VERT_SRC = `
attribute vec2 a_pos;
varying vec2 v_uv;
uniform vec4 u_uvTransform; // scale.xy, offset.xy
void main() {
  v_uv = a_pos * u_uvTransform.xy + u_uvTransform.zw;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG_SRC = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_texture;
void main() {
  gl_FragColor = texture2D(u_texture, v_uv);
}`;

/**
 * 契约 §6 工厂：创建统一 VideoRenderer 实例。
 * `preference` 是定稿参数名，`mode` 作为迁移期兼容参数保留。
 * @param {HTMLCanvasElement} canvasEl
 * @param {{preference?: 'auto'|'2d'|'webgl', fit?: 'contain'|'cover'|'fill', mode?: 'auto'|'2d'|'webgl', flipY?: boolean}} [options]
 * @returns {VideoFrameRenderer}
 */
export function createVideoRenderer(canvasEl, options = {}) {
  const preference = options.preference ?? options.mode ?? 'auto';
  return new VideoFrameRenderer(canvasEl, { ...options, mode: preference });
}

export class VideoFrameRenderer extends Emitter {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{mode?: 'auto'|'2d'|'webgl', flipY?: boolean, fit?: 'contain'|'cover'|'fill'}} [options]
   */
  constructor(canvas, options = {}) {
    super();
    if (typeof document === 'undefined') {
      throw notSupported('VideoFrameRenderer requires a DOM environment');
    }
    this.canvas = canvas;
    this.requestedMode = options.mode ?? 'auto';
    this.fit = options.fit ?? 'contain';
    if (!['contain', 'cover', 'fill'].includes(this.fit)) {
      this.fit = 'contain';
    }
    this.flipY = options.flipY !== false;
    this.mode = null; // 实际生效路径
    this._gl = null;
    this._program = null;
    this._texture = null;
    this._degraded = false;

    const wantWebGL = this.requestedMode === 'auto' || this.requestedMode === 'webgl';
    let ok = false;
    if (!this._degraded && wantWebGL) ok = this._initWebGL();
    if (!ok && (this.requestedMode === 'auto' || this.requestedMode === '2d')) {
      ok = this._init2D();
    }
    if (!ok) throw notSupported('no usable rendering path (webgl/2d)');
    this.mode = this._gl ? 'webgl' : '2d';
  }

  _init2D() {
    try {
      this._ctx = this.canvas.getContext('2d');
      return !!this._ctx;
    } catch {
      return false;
    }
  }

  _initWebGL() {
    try {
      const gl =
        this.canvas.getContext('webgl', { preserveDrawingBuffer: true }) ||
        this.canvas.getContext('experimental-webgl', { preserveDrawingBuffer: true });
      if (!gl) return false;
      const program = createProgram(gl, VERT_SRC, FRAG_SRC);
      if (!program) return false;
      // 全屏四边形（两个三角形组成的 strip：-1..1）
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
        gl.STATIC_DRAW,
      );
      const locPos = gl.getAttribLocation(program, 'a_pos');
      gl.enableVertexAttribArray(locPos);
      gl.vertexAttribPointer(locPos, 2, gl.FLOAT, false, 0, 0);

      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.clearColor(0, 0, 0, 1);

      this._gl = gl;
      this._program = program;
      this._texture = texture;
      this._quadBuffer = buffer;
      this._uUv = gl.getUniformLocation(program, 'u_uvTransform');
      this._uTex = gl.getUniformLocation(program, 'u_texture');
      return true;
    } catch {
      this._cleanupGl();
      return false;
    }
  }

  /** 调整画布物理尺寸 */
  resize(width, height) {
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }

  /** 计算 fit 适配后的目标矩形（CSS 像素） */
  computeLetterbox(srcW, srcH, dstW, dstH) {
    if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0) {
      return { x: 0, y: 0, width: dstW, height: dstH };
    }
    if (this.fit === 'fill') return { x: 0, y: 0, width: dstW, height: dstH };
    const scale = this.fit === 'cover'
      ? Math.max(dstW / srcW, dstH / srcH)
      : Math.min(dstW / srcW, dstH / srcH);
    const width = srcW * scale;
    const height = srcH * scale;
    return { x: (dstW - width) / 2, y: (dstH - height) / 2, width, height };
  }

  /**
   * 绘制一帧。
   * 契约 §6 铁律：render(frame) 调用后所有权移交渲染器——若传入 VideoFrame，
   * 绘制结束（含异常路径）由本方法负责 frame.close()，调用方不得复用该帧。
   * @param {VideoFrame|HTMLVideoElement|ImageBitmap|HTMLCanvasElement} frame
   * @returns {boolean} 是否成功
   */
  draw(frame) {
    const ownsFrame = typeof VideoFrame !== 'undefined' && frame instanceof VideoFrame;
    try {
      let ok = false;
      if (this._gl) ok = this._drawWebGL(frame);
      else ok = this._draw2D(frame);
      return ok;
    } catch (err) {
      // WebGL 路径失败 → 永久降级 2D
      if (this._gl && !this._degraded) {
        this._degraded = true;
        this._cleanupGl();
        this.mode = '2d';
        if (!this._ctx) this._init2D();
        this.emit('fallback', err);
        try {
          return this._draw2D(frame);
        } catch {
          return false;
        }
      }
      this.emit('error', err);
      return false;
    } finally {
      if (ownsFrame) {
        try {
          frame.close();
        } catch {
          /* 双重 close 等异常路径忽略 */
        }
      }
    }
  }

  _frameSize(frame) {
    if (typeof VideoFrame !== 'undefined' && frame instanceof VideoFrame) {
      return { width: frame.displayWidth, height: frame.displayHeight };
    }
    return {
      width: frame.videoWidth || frame.displayWidth || frame.width || 0,
      height: frame.videoHeight || frame.displayHeight || frame.height || 0,
    };
  }

  _draw2D(frame) {
    const ctx = this._ctx;
    if (!ctx) return false;
    const { width, height } = this._frameSize(frame);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!width || !height) return false;
    const rect = this.computeLetterbox(width, height, this.canvas.width, this.canvas.height);
    ctx.drawImage(frame, rect.x, rect.y, rect.width, rect.height);
    return true;
  }

  _drawWebGL(frame) {
    const gl = this._gl;
    const { width, height } = this._frameSize(frame);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!width || !height) return false;

    gl.useProgram(this._program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, /** @type any */ frame);
    gl.uniform1i(this._uTex, 0);

    // 信箱：UV 缩放 + 居中偏移（NDC 空间）
    const canvasAspect = this.canvas.width / this.canvas.height;
    const videoAspect = width / height;
    let scaleX = 1;
    let scaleY = 1;
    if (this.fit === 'fill') {
      scaleX = 1;
      scaleY = 1;
    } else if (this.fit === 'cover') {
      if (videoAspect > canvasAspect) scaleX = videoAspect / canvasAspect;
      else scaleY = canvasAspect / videoAspect;
    } else if (videoAspect > canvasAspect) {
      scaleY = canvasAspect / videoAspect;
    } else {
      scaleX = videoAspect / canvasAspect;
    }
    const offX = (1 - scaleX) / 2;
    const offY = (1 - scaleY) / 2;
    // 垂直翻转：
    //   flipY=true（默认）保持原 upright——uvTop=offY，使采样子矩形正立。
    //   flipY=false 将采样子矩形 [offY-scaleY, offY+scaleY] 关于纹理 v=0.5 镜像，
    //   即把屏幕顶部映射到原底部（1-offY+scaleY），故 uvTop = 1 - offY。
    //   注意旧实现写的是 1-offY-scaleY，代数上恒等于 offY（flipY 失效，见缺陷报告）。
    const uvTop = this.flipY ? offY : 1 - offY;
    gl.uniform4f(this._uUv, scaleX, scaleY, offX, uvTop);

    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuffer);
    const locPos = gl.getAttribLocation(this._program, 'a_pos');
    gl.enableVertexAttribArray(locPos);
    gl.vertexAttribPointer(locPos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }

  clear(color = '#000') {
    if (this._ctx) {
      this._ctx.fillStyle = color;
      this._ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    if (this._gl) {
      this._gl.clear(this._gl.COLOR_BUFFER_BIT);
    }
  }

  _cleanupGl() {
    if (!this._gl) return;
    const gl = this._gl;
    try {
      gl.deleteTexture(this._texture);
      gl.deleteBuffer(this._quadBuffer);
      gl.deleteProgram(this._program);
      const lose = gl.getExtension('WEBGL_lose_context');
      lose?.loseContext();
    } catch {
      /* 清理尽力而为 */
    }
    this._gl = null;
    this._texture = null;
    this._program = null;
  }

  destroy() {
    this._cleanupGl();
    this._ctx = null;
    this.removeAllListeners();
  }
}

function compileShader(gl, type, src) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`shader compile failed: ${info}`);
  }
  return shader;
}

function createProgram(gl, vertSrc, fragSrc) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`program link failed: ${info}`);
  }
  return program;
}
