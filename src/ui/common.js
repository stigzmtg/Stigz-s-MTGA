// Small pieces both games share: a render store, table settings and storage that never throws.
export const DEFAULT_SETTINGS = { aiSpeed: 'normal', stopOppEnd: true, stopOppCombat: true, stopOwnCombat: false, stopForOpponentSpells: true, fullControl: false, autoCommander: true, images: true, sound: true, volume: 0.6, sandbox: false };
export function loadSettings() { try { return { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem('pa-settings') || '{}')) }; } catch { return { ...DEFAULT_SETTINGS }; } }
export function saveSettings(s) { try { localStorage.setItem('pa-settings', JSON.stringify(s)); } catch { /* storage unavailable */ } }

export const safeStorage = {
  getItem(k) { try { return localStorage.getItem(k); } catch { return null; } },
  setItem(k, v) { try { localStorage.setItem(k, v); } catch { /* storage full or blocked */ } },
};

// a version counter the React tree subscribes to; bumps coalesce into one render per frame
export function createStore() {
  let v = 0, scheduled = false;
  const subs = new Set();
  const tick = () => { scheduled = false; v++; subs.forEach(f => f()); };
  return {
    get: () => v,
    subscribe: f => { subs.add(f); return () => subs.delete(f); },
    bump() {
      if (scheduled) return;
      scheduled = true;
      if (typeof requestAnimationFrame === 'function' && !document.hidden) requestAnimationFrame(tick); else setTimeout(tick, 16);
    },
  };
}

// a pixel length from a CSS custom property, which may be calc(84px * 1.2) on big screens
export function cssPx(el, name, fallback) {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  const m = /^calc\(\s*([\d.]+)px\s*\*\s*([\d.]+)\s*\)$/.exec(v);
  if (m) return +m[1] * +m[2];
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}
// the big-screen size scale (1 on laptops)
export const uiScale = () => (typeof document === 'undefined' ? 1 : parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--s')) || 1);

// set by tools/build.mjs: a hash of this build's data files, so a new build never gets last build's copies from a cache
const DATA_VERSION = typeof __DATA_VERSION__ === 'string' ? __DATA_VERSION__ : '';

// (the website only: the claude.ai page's files are replaced together on every publish)
const onClaudePage = () => typeof window !== 'undefined' && !!(window.claude && window.claude.use);
export const dataUrl = url => (DATA_VERSION && /^data\//.test(url) && !onClaudePage() ? `${url}?v=${DATA_VERSION}` : url);
// picture packs are listed with a hash of their contents (img/ptcg-6.avif?v=…); the claude.ai page asks for the bare file
export const packUrl = url => (onClaudePage() ? String(url).split('?')[0] : url);

export async function fetchJSON(url, onProgress) {
  const res = await fetch(dataUrl(url));
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const len = +res.headers.get('content-length') || 0;
  if (!res.body || !len || !onProgress) return res.json();
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    onProgress(Math.min(1, got / len));
  }
  const all = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  return JSON.parse(new TextDecoder().decode(all));
}
