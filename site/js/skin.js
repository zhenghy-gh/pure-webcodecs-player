/** Legacy API facade. All state, formatting and lifecycle lives in ../skin.js. */
import { BRAND, initTabs, bindRange as bindSharedRange, bindKeys, toggleFullscreen as toggleSharedFullscreen,
  toast as sharedToast, formatTime, formatBitrate, syncRange } from '../skin.js';
export { BRAND, initTabs, bindKeys, formatTime, formatBitrate, syncRange };
export function toggleFullscreen(stage) {
  const controls = stage?.querySelector('.pp-controls, .controls')
    || stage?.closest('.pp-demo, .demo')?.querySelector('.pp-controls, .demo__controls');
  return toggleSharedFullscreen(stage, controls);
}
export function bindRange(el, handlers = {}) {
  return bindSharedRange(el, { format: handlers.format || (el?.dataset?.unit === 'us' ? undefined : formatTime),
    onInput: handlers.onPreview, onChange: handlers.onCommit });
}
export function toast(options = {}) { return sharedToast(options); }
const Skin = { BRAND, initTabs, bindRange, bindKeys, toggleFullscreen, toast, formatTime, formatBitrate, syncRange };
export { Skin, Skin as default }; // Existing external imports remain supported.
