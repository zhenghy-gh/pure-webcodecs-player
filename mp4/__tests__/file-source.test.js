/**
 * mp4/src/file-source.js 专项测试。
 *
 * 该文件是纯浏览器 DOM 接入层（dragover/drop、input[type=file]），此前无任何测试直接引用，
 * 覆盖率全靠间接调用。这里用轻量 DOM stub 覆盖其真实分支：
 * 白名单过滤、空投放、disposer 解绑、pickFile 的 change/focus 两条收口路径。
 */
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { attachFileDrop, pickFile } from '../src/file-source.js';
import { BlobDataSource } from '../../core/src/index.js';

/** 最小事件目标 stub：只保留 add/remove/dispatch，足以验证解绑语义 */
function makeElement() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = listeners.get(type);
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    dispatch(type, event) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
    },
    count(type) {
      return (listeners.get(type) ?? []).length;
    },
  };
}

/** dataTransfer stub；files 传 null 表示事件上没有 dataTransfer */
function makeDropEvent(files) {
  const calls = { preventDefault: 0, stopPropagation: 0 };
  return {
    calls,
    preventDefault() {
      calls.preventDefault += 1;
    },
    stopPropagation() {
      calls.stopPropagation += 1;
    },
    dataTransfer: files === null ? undefined : { files, dropEffect: '' },
  };
}

function makeFile(name = 'clip.mp4', size = 16) {
  return new File([new Uint8Array(size)], name, { type: 'video/mp4' });
}

describe('attachFileDrop', () => {
  it('dragover 阻止默认行为并标记 copy 光标', () => {
    const el = makeElement();
    const dispose = attachFileDrop(el, () => {});
    const ev = makeDropEvent(null);
    el.dispatch('dragover', ev);
    assert.equal(ev.calls.preventDefault, 1);
    assert.equal(ev.calls.stopPropagation, 1);
    ev.dataTransfer = { dropEffect: '' };
    el.dispatch('dragover', ev);
    assert.equal(ev.dataTransfer.dropEffect, 'copy', '应把 dropEffect 置为 copy');
    dispose();
  });

  it('拖入白名单文件 → 回吐 BlobDataSource 与 File', () => {
    const el = makeElement();
    const seen = [];
    const dispose = attachFileDrop(el, (source, file) => seen.push({ source, file }), {
      accept: ['.mp4', '.m4v'],
    });
    const file = makeFile('movie.mp4', 32);
    el.dispatch('drop', makeDropEvent([file]));

    assert.equal(seen.length, 1);
    assert.ok(seen[0].source instanceof BlobDataSource, '应产 BlobDataSource');
    assert.equal(seen[0].source.size, 32);
    assert.equal(seen[0].source.name, 'movie.mp4');
    assert.equal(seen[0].file, file);
    dispose();
  });

  it('扩展名比对大小写不敏感', () => {
    const el = makeElement();
    let called = 0;
    const dispose = attachFileDrop(el, () => {
      called += 1;
    }, { accept: ['.mp4'] });
    el.dispatch('drop', makeDropEvent([makeFile('MOVIE.MP4')]));
    assert.equal(called, 1, '大写扩展名也应通过白名单');
    dispose();
  });

  it('不在白名单 → 拒绝并告警，不回调', () => {
    const el = makeElement();
    let called = 0;
    const dispose = attachFileDrop(el, () => {
      called += 1;
    }, { accept: ['.mp4'] });

    const warn = mock.method(console, 'warn', () => {});
    try {
      el.dispatch('drop', makeDropEvent([makeFile('clip.mkv')]));
    } finally {
      warn.mock.restore();
    }
    assert.equal(called, 0, '非白名单不应回调');
    assert.equal(warn.mock.callCount(), 1, '应给出一次告警');
    assert.match(warn.mock.calls[0].arguments[0], /rejected clip\.mkv/);
    dispose();
  });

  it('files 为空 / 无 dataTransfer → 静默返回', () => {
    const el = makeElement();
    let called = 0;
    const dispose = attachFileDrop(el, () => {
      called += 1;
    });
    el.dispatch('drop', makeDropEvent([]));
    el.dispatch('drop', makeDropEvent(null));
    assert.equal(called, 0);
    dispose();
  });

  it('未传 accept 时不过滤任何扩展名', () => {
    const el = makeElement();
    let called = 0;
    const dispose = attachFileDrop(el, () => {
      called += 1;
    });
    el.dispatch('drop', makeDropEvent([makeFile('anything.bin')]));
    assert.equal(called, 1, 'accept 缺省表示不限制');
    dispose();
  });

  it('disposer 解绑后不再响应（且监听器归零）', () => {
    const el = makeElement();
    let called = 0;
    const dispose = attachFileDrop(el, () => {
      called += 1;
    });
    assert.equal(el.count('dragover'), 1);
    assert.equal(el.count('drop'), 1);

    dispose();
    assert.equal(el.count('dragover'), 0, 'disposer 应移除 dragover');
    assert.equal(el.count('drop'), 0, 'disposer 应移除 drop');

    el.dispatch('drop', makeDropEvent([makeFile()]));
    assert.equal(called, 0, '解绑后不应再回调');
  });
});

/** 安装最小 document/window stub，返回可观测的输入框与调用日志 */
function installDom() {
  const log = { created: null, appended: [], removed: [], clicked: 0, focusHandlers: [] };
  const input = {
    type: '',
    accept: '',
    style: {},
    files: null,
    _listeners: new Map(),
    addEventListener(type, fn) {
      if (!input._listeners.has(type)) input._listeners.set(type, []);
      input._listeners.get(type).push(fn);
    },
    click() {
      log.clicked += 1;
    },
    fire(type) {
      for (const fn of [...(input._listeners.get(type) ?? [])]) fn();
    },
  };
  globalThis.document = {
    createElement(tag) {
      log.created = tag;
      return input;
    },
    body: {
      appendChild(el) {
        log.appended.push(el);
      },
      removeChild(el) {
        log.removed.push(el);
      },
    },
  };
  globalThis.window = {
    addEventListener(type, fn) {
      if (type === 'focus') log.focusHandlers.push(fn);
    },
  };
  return { input, log };
}

describe('pickFile', () => {
  afterEach(() => {
    delete globalThis.document;
    delete globalThis.window;
  });

  it('非浏览器环境（无 document）→ resolve null', async () => {
    delete globalThis.document;
    assert.equal(await pickFile(), null);
  });

  it('选中文件 → 经 change 回吐 File，并清理 DOM', async () => {
    const { input, log } = installDom();
    const file = makeFile('picked.mp4', 8);
    input.files = [file];

    const p = pickFile('.mp4,.m4v,.mov');
    assert.equal(log.created, 'input');
    assert.equal(input.type, 'file');
    assert.equal(input.accept, '.mp4,.m4v,.mov');
    assert.equal(input.style.display, 'none', '输入框应隐藏');
    assert.equal(log.appended.length, 1, '需挂到 body 才能 click');
    assert.equal(log.clicked, 1, '应触发一次 click');

    input.fire('change');
    assert.equal(await p, file);
    assert.equal(log.removed.length, 1, '收口后应移除输入框');
  });

  it('未选文件（change 但 files 为空）→ resolve null', async () => {
    const { input } = installDom();
    input.files = [];
    const p = pickFile();
    input.fire('change');
    assert.equal(await p, null);
  });

  it('重复触发 change 只结算一次，输入框只移除一次', async () => {
    const { input, log } = installDom();
    const file = makeFile('one.mp4', 4);
    input.files = [file];
    const p = pickFile();
    input.fire('change');
    input.fire('change');
    input.fire('change');
    assert.equal(await p, file);
    assert.equal(log.removed.length, 1, 'settle 幂等，只移除一次');
  });

  it('用户取消（change 不触发）→ 由 window focus 兜底在 300ms 后结算 null', async () => {
    const { log } = installDom();
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const p = pickFile();
      assert.equal(log.focusHandlers.length, 1, '应注册 focus 兜底');
      log.focusHandlers[0]();
      mock.timers.tick(300);
      assert.equal(await p, null, '取消场景应结算为 null');
      assert.equal(log.removed.length, 1, '兜底同样要移除输入框');
    } finally {
      mock.timers.reset();
    }
  });
});
