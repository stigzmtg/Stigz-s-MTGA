// One Piece card pictures: packed AVIF files (tools/optcg/fetch-images.mjs), sliced into object URLs on demand. The
// menus use the small thumbnail pack (tools/optcg/pack-thumbs.mjs); a battle loads only its two decks' packs.
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

// the packs holding these cards' pictures (a battle's two decks: a few MB, not all 20+ MB of them)
export function preloadOpCards(ids) {
  const ix = state.index;
  if (!ix) return Promise.resolve();
  const want = new Set(ids.map(id => ix.cards[id] && ix.cards[id][0]).filter(i => i != null));
  return Promise.all([...want].map(i => loadPack(i).promise));
}

function slice(map, key, cacheKey) {
  const ix = state.index;
  const e = ix && ix[map] && ix[map][key];
  if (!e) return null;
  const u = state.urls.get(cacheKey);
  if (u) return u;
  const p = loadPack(e[0]);
  if (!p.buf) return null;
  const url = URL.createObjectURL(new Blob([p.buf.slice(e[1], e[1] + e[2])], { type: ix.type || 'image/avif' }));
  state.urls.set(cacheKey, url);
  return url;
}
// a card's picture (480px); asking for one loads its pack
export const opImage = key => slice('cards', key, key);
// a Leader's or featured card's small picture for the menus (one small pack), else the full picture once it's loaded
export const opThumb = key => slice('thumbs', key, 't:' + key) || (state.urls.get(key) || null);
