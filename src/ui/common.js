// Small pieces both games share: a render store, table settings and storage that never throws.
export const DEFAULT_SETTINGS = { aiSpeed: 'normal', stopOppEnd: true, stopOppCombat: true, stopOwnCombat: false, stopForOpponentSpells: true, fullControl: false, autoCommander: true, images: true, sound: true, volume: 0.6 };
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

export async function fetchJSON(url, onProgress) {
  const res = await fetch(url);
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
