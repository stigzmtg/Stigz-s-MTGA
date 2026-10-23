// Card images: packed AVIF files published next to the page (built by tools/pack-images.mjs).
// Packs load on demand and are sliced into object URLs; anything without an image falls back to the drawn frame.
import { dataUrl, packUrl } from './common.js';
const state = { index: null, packs: new Map(), urls: new Map(), version: 0, listeners: new Set(), failed: false };

export async function initImages() {
  try {
    const res = await fetch(dataUrl('data/images.json'));
    if (!res.ok) throw new Error(res.status);
    const ix = await res.json();
    state.index = ix && ix.v === 2 && ix.packs && ix.packs.length ? ix : null;
  } catch { state.failed = true; }
  bump();
  return !!state.index;
}

export function imagesAvailable() { return !!state.index; }

function bump() { state.version++; for (const f of state.listeners) f(); }
export function subscribeImages(f) { state.listeners.add(f); return () => state.listeners.delete(f); }
export function imagesVersion() { return state.version; }

function loadPack(i) {
  let p = state.packs.get(i);
  if (p) return p;
  p = { buf: null, promise: null };
  state.packs.set(i, p);
  // a busy host or a dropped connection gets a few more tries, backing off, before the pack is given up on
  const get = attempt => fetch(packUrl(state.index.packs[i])).then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
    .catch(e => { if (attempt >= 3) throw e; return new Promise(res => setTimeout(res, 1500 * 2 ** attempt)).then(() => get(attempt + 1)); });
  p.promise = get(0).then(b => { p.buf = b; bump(); }, () => { p.error = true; });
  return p;
}

// entry: [pack, offset, length]
function urlFor(entry) {
  const key = entry.join(':');
  const u = state.urls.get(key);
  if (u) return u;
  const p = loadPack(entry[0]);
  if (!p.buf) return null;
  const url = URL.createObjectURL(new Blob([p.buf.slice(entry[1], entry[1] + entry[2])], { type: state.index.type || 'image/avif' }));
  state.urls.set(key, url);
  return url;
}

function entriesFor(name, deckId) {
  const ix = state.index;
  if (!ix || !name) return null;
  const found = lookup(ix, name, deckId);
  // adventure, room and omen cards are listed in decks by their first half
  return found || (name.includes(' // ') ? lookup(ix, name.split(' // ')[0], deckId) : null);
}

// index v2: images[j] = faces as [pack, offset, length]; decks[id].cards[name] = j
function lookup(ix, name, deckId) {
  const d = deckId && ix.decks[deckId];
  if (d && d.cards[name] != null) return ix.images[d.cards[name]];
  for (const id in ix.decks) { const j = ix.decks[id].cards[name]; if (j != null) return ix.images[j]; }
  return null;
}

// URL for a card face (0 = front), or null while loading / when there is no image
export function cardImage(name, deckId, face = 0) {
  const es = entriesFor(name, deckId);
  if (!es) return null;
  return urlFor(es[Math.min(face, es.length - 1)]);
}

export function lobbyImages(deckId) {
  const ix = state.index;
  if (!ix || !ix.lobby[deckId]) return [];
  return ix.lobby[deckId].map(j => urlFor(ix.images[j][0]));
}

// start loading everything a game needs; resolves when the packs are in
export function preloadDecks(deckIds) {
  const ix = state.index;
  if (!ix) return Promise.resolve();
  // every pack holding a card of these decks; token packs load when a token first appears
  const packs = new Set();
  for (const id of deckIds) for (const i of (ix.decks[id] && ix.decks[id].packs) || []) packs.add(i);
  return Promise.all([...packs].map(i => loadPack(i).promise));
}

// image for a live card in a game: its owner's deck printing, the shown face for transformed cards
export function imageOf(game, card) {
  if (!state.index || card.faceDown) return null;
  // copies (clones, token copies) show the copied card; tokens made from a script show that token
  const def = card.copyOf && card.copyOf.def ? card.copyOf.def : card.def;
  const face = card.copyOf ? card.copyOf.face || 0 : card.face || 0;
  if (def.token) {
    const e = state.index.tokens && def.scriptName && state.index.tokens[def.scriptName];
    return e ? urlFor(e) : null;
  }
  const owner = game.players[card.owner];
  return cardImage(def.name, owner && owner.deckId, face);
}
