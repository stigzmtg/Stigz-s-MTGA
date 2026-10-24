// One Piece card pictures: packed AVIF files (tools/optcg/fetch-images.mjs), sliced into object URLs on demand.
import { dataUrl, packUrl } from '../../ui/common.js';
const state = { index: null, packs: new Map(), urls: new Map(), listeners: new Set(), version: 0 };
const bump = () => { state.version++; for (const f of state.listeners) f(); };
export const subscribeOp = f => { state.listeners.add(f); return () => state.listeners.delete(f); };
export const opImagesVersion = () => state.version;

export async function initOpImages() {
  if (state.index) return true;
  try {
    const r = await fetch(dataUrl('data/optcg/images.json'));
    if (!r.ok) throw new Error(r.status);
    const ix = await r.json();
    state.index = ix && ix.packs && ix.packs.length ? ix : null;
  } catch { state.index = null; }
  bump();
  return !!state.index;
}

function loadPack(i) {
  let p = state.packs.get(i);
  if (p) return p;
  p = { buf: null };
  state.packs.set(i, p);
  const get = attempt => fetch(packUrl(state.index.packs[i])).then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
    .catch(e => { if (attempt >= 3) throw e; return new Promise(res => setTimeout(res, 1500 * 2 ** attempt)).then(() => get(attempt + 1)); });
  p.promise = get(0).then(b => { p.buf = b; bump(); }, () => { p.error = true; });
  return p;
}

// all packs (every starter deck together is a few MB)
export function preloadOp() { if (!state.index) return Promise.resolve(); return Promise.all(state.index.packs.map((_, i) => loadPack(i).promise)); }

export function opImage(key) {
  const ix = state.index;
  const e = ix && ix.cards[key];
  if (!e) return null;
  const u = state.urls.get(key);
  if (u) return u;
  const p = loadPack(e[0]);
  if (!p.buf) return null;
  const url = URL.createObjectURL(new Blob([p.buf.slice(e[1], e[1] + e[2])], { type: ix.type || 'image/avif' }));
  state.urls.set(key, url);
  return url;
}
