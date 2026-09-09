/**
 * level-controller.js —— 清晰度（Level）控制器
 *
 * 职责：
 *  - 持有多码率 Level 列表，管理当前清晰度与切换决策
 *  - auto 模式：基于 EWMA 带宽估计 + 缓冲水位做保守升级 / 快速降级
 *  - 手动模式：用户指定 levelIndex（-1 表示恢复 auto）
 *
 * 策略说明（对标 hls.js 最小核心，刻意从简）：
 *  - 升级条件：估计带宽 >= 目标码率 * 1.4 且当前缓冲 > 10s，且距上次切换 > 一个分片周期
 *  - 降级条件：加载超时或缓冲 < 2s 时立即降到估计带宽能承载的最高档
 */

import { EwmaBandwidthEstimator } from './utils.js';
import { stateError } from '../../core/src/errors.js';

export class LevelController {
  /**
   * @param {Array} levels parseMaster().levels
   * @param {object} [opts]
   */
  constructor(levels = [], opts = {}) {
    this.setLevels(levels);
    this.autoLevelEnabled = true;
    this.currentLevel = opts.startLevel != null ? opts.startLevel : this._pickInitial();
    this.bandwidthEstimator =
      opts.bandwidthEstimator || new EwmaBandwidthEstimator(256 * 1024, 1e6);
    this.lastSwitchTime = 0;
    this.bufferSeconds = 0; // 由播放器回填当前缓冲水位
  }

  setLevels(levels) {
    // 按 bandwidth 降序：index 0 = 最高清
    this.levels = [...levels].sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
  }

  /** 初始清晰度策略：默认从中间偏低的档位起步，快速起播后再爬升 */
  _pickInitial() {
    const n = this.levels.length;
    if (!n) return -1;
    return Math.min(n - 1, Math.floor(n * 0.7)); // 偏低档
  }

  get levelCount() {
    return this.levels.length;
  }

  /** 当前生效的 level 对象；无 level（单码率媒体列表）返回 null */
  get current() {
    return this.currentLevel >= 0 ? this.levels[this.currentLevel] : this.levels[0] || null;
  }

  /**
   * 用户手动切换。levelIndex 为 levels 数组下标（0=最高清），-1 恢复 auto。
   * @returns {number|null} 实际切换到的下标；无变化返回 null
   */
  switchTo(levelIndex) {
    if (levelIndex === -1) {
      this.autoLevelEnabled = true;
      return this.autoSelect(true);
    }
    if (levelIndex < 0 || levelIndex >= this.levels.length) {
      // 收敛契约 §11.3：越界属生命周期/参数非法 → STATE_ERROR（原 RangeError 非十码）
      throw stateError(`levelIndex 越界: ${levelIndex}/${this.levels.length}`, { levelIndex });
    }
    this.autoLevelEnabled = false;
    return this._apply(levelIndex);
  }

  /**
   * auto 模式下依据带宽与缓冲选择目标档。
   * @returns {number|null} 新档位下标；无需切换返回 null
   */
  autoSelect(force = false) {
    if (!this.levels.length) return null;
    if (!this.autoLevelEnabled && !force) return null;

    const bw = this.bandwidthEstimator.bandwidth;
    // 能"安全"承载的档位：估计带宽 >= level.bandwidth * 安全系数
    const SAFE_FACTOR_UP = 1.4;
    let best = -1;
    for (let i = 0; i < this.levels.length; i++) {
      const need = (this.levels[i].bandwidth || 0) * SAFE_FACTOR_UP;
      if (bw >= need) {
        best = i; // levels 已按带宽降序，最后一个满足者即最低的可承受高档
        break;
      }
    }
    if (best === -1) {
      // 带宽不足最高档：选带宽不超过估计值的最低档（levels 降序，取末尾方向）
      for (let i = this.levels.length - 1; i >= 0; i--) {
        if ((this.levels[i].bandwidth || 0) <= bw) {
          best = i;
          break;
        }
      }
      if (best === -1) best = this.levels.length - 1; // 全都超出也用最底档兜底
    }

    // 防抖：缓冲充足才允许向上切，且限制切换频率由调用方控制
    const curIdx = this.currentLevel;
    if (best === curIdx) return null;
    if (best < curIdx) {
      // 向上（更高清）：需要缓冲水位支持
      if (this.bufferSeconds < 10 && !force) return null;
    }
    return this._apply(best);
  }

  _apply(idx) {
    if (idx === this.currentLevel) return null;
    const prev = this.currentLevel;
    this.currentLevel = idx;
    this.lastSwitchTime = Date.now();
    return { from: prev, to: idx };
  }

  /** 播放器在每次分片下载完成后调用：回填样本并触发 ABR 复核 */
  reportLoad(bytes, durationMs, bufferSeconds, onMaybeSwitch) {
    this.bandwidthEstimator.sample(bytes, durationMs);
    this.bufferSeconds = bufferSeconds || 0;
    if (this.autoLevelEnabled && onMaybeSwitch) {
      const sw = this.autoSelect();
      if (sw) onMaybeSwitch(sw);
    }
  }

  /**
   * stall（播放饥饿）快速降档（评审 §18.3）。
   * 头部策略注释承诺「缓冲 < 2s 立即降到估计带宽能承载的最高档」，但旧实现从未
   * 兑现：autoSelect 的降级完全依赖带宽 EWMA 回落，bufferSeconds 仅作升级闸；
   * 高码率档下载慢到播放停顿时，EWMA 尚未反映，只能干等到下一分片下载完成。
   * 播放器在 video 'waiting' 且缓冲近零时调用本方法：绕过带宽估计与升级闸，
   * 直接切最低档换取最大下载余量，待后续 reportLoad 的 ABR 复核自然爬回。
   * 仅 auto 模式生效（手动锁定档位不覆盖用户选择）。
   * @param {number} [minGapMs=2000] 距上次切换的最小间隔，防 waiting 风暴连环降档
   * @returns {{from:number,to:number}|null} 实际切换（已最低 / 手动 / 节流中返回 null）
   */
  handleStall(minGapMs = 2000) {
    if (!this.levels.length || !this.autoLevelEnabled) return null;
    const now = Date.now();
    if (now - this.lastSwitchTime < minGapMs) return null;
    return this._apply(this.levels.length - 1);
  }
}
