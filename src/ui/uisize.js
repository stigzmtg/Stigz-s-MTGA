// How big the interface is drawn. tools/build.mjs multiplies every pixel size in the CSS by var(--s); this sets --s
// from the window (the screens are laid out for about 1150 × 650 CSS pixels, so a bigger window draws everything
// bigger instead of leaving it small in the middle) times the size the player picked. Real CSS sizes, never a
// transform, so text stays sharp.
import { safeStorage } from './common.js';

export const UI_SIZES = [['small', 'Small', 0.85], ['normal', 'Normal', 1], ['large', 'Large', 1.15], ['huge', 'Huge', 1.3]];
const KEY = 'pa-uisize';
const listeners = new Set();
let version = 0;

export const uiSizePref = () => { const v = safeStorage.getItem(KEY); return UI_SIZES.some(s => s[0] === v) ? v : 'normal'; };
export const subscribeUiSize = f => { listeners.add(f); return () => listeners.delete(f); };
export const uiSizeVersion = () => version;
export function setUiSize(v) { safeStorage.setItem(KEY, v); applyScale(); version++; for (const f of listeners) f(); }

export function scaleFor(w, h, pref = 'normal') {
  const k = (UI_SIZES.find(s => s[0] === pref) || UI_SIZES[1])[2];
  // phones and narrow windows keep their own layout at about its natural size
  if (w < 760) return Math.min(1.15, Math.max(0.85, k));
  const fit = Math.max(1, Math.min(2.4, Math.min(w / 1150, h / 650)));
  // however big the choice, leave the game at least about 1050 × 600 layout pixels to work with (a four-player table
  // needs that much)
  const room = Math.max(1, Math.min(w / 1050, h / 600));
  return Math.max(0.85, +Math.min(fit * k, room).toFixed(3));
}

export function applyScale() {
  if (typeof document === 'undefined') return;
  const s = scaleFor(window.innerWidth, window.innerHeight, uiSizePref());
  document.documentElement.style.setProperty('--s', String(s));
  // room, in layout pixels, for wide extras such as the full list of turn steps
  document.documentElement.toggleAttribute('data-roomy', window.innerWidth / s >= 1500);
}

let started = false;
export function initUiScale() {
  if (started || typeof window === 'undefined') return;
  started = true;
  applyScale();
  let raf = 0;
  window.addEventListener('resize', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(applyScale); });
}
