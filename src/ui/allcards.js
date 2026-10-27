// The whole card pool. The page loads the precons' and community decks' cards (data/cards.json); the other ~25,000
// cards (data/more/cards-N.json) load when the deck builder opens or a game's decks need them, along with every
// card's picture id on Scryfall, its EDHREC rank and whether it's banned (data/cardmeta.json). Once loaded they stay.
import { fetchJSON, onClaudePage } from './common.js';
import { setCardMeta } from './images.js';

const st = { meta: null, metaPromise: null, all: null, allPromise: null, done: 0, total: 0, version: 0, listeners: new Set() };
const bump = () => { st.version++; for (const f of st.listeners) f(); };
export const subscribeAllCards = f => { st.listeners.add(f); return () => st.listeners.delete(f); };
export const allCardsVersion = () => st.version;
export const allCardsLoaded = () => !!st.all;
export const allCardsProgress = () => (st.total ? st.done / st.total : 0);
export const cardMeta = name => (st.meta && st.meta[name]) || null;
// (the claude.ai page holds only the cards the precons and community decks play: the whole pool is on the website)
export const fullPoolHere = () => !onClaudePage();

// pictures, ranks and the banned list (about 2 MB)
export function loadCardMeta() {
  if (!fullPoolHere()) return Promise.resolve({});
  if (!st.metaPromise) {
    st.metaPromise = fetchJSON('data/cardmeta.json').then(m => { st.meta = m; setCardMeta(m); bump(); return m; }, e => { st.metaPromise = null; throw e; });
  }
  return st.metaPromise;
}

// every card (resolves when they're in db)
export function loadAllCards(db) {
  if (!fullPoolHere()) return Promise.resolve(db);
  if (!st.allPromise) {
    st.allPromise = (async () => {
      const m = await fetchJSON('data/more.json');
      st.total = m.shards + 1; st.done = 0; bump();
      const tick = x => { st.done++; bump(); return x; };
      const [, ...parts] = await Promise.all([loadCardMeta().then(tick), ...Array.from({ length: m.shards }, (_, i) => fetchJSON(`data/more/cards-${i}.json`).then(tick))]);
      for (const p of parts) db.add(p);
      st.all = true; bump();
      return db;
    })().catch(e => { st.allPromise = null; throw e; });
  }
  return st.allPromise;
}

// the card names these decks use that aren't loaded yet
export function missingCards(db, decks) {
  const out = new Set();
  for (const d of decks) if (d) for (const n of [...d.commanders, ...d.cards.map(([x]) => x)]) if (!db.has(n)) out.add(n);
  return [...out];
}

// before a game: every card its decks use, and pictures for decks that aren't precons (precons have picture packs)
export async function prepareDecks(db, decks) {
  const list = decks.filter(Boolean);
  const waits = [];
  if (missingCards(db, list).length) waits.push(loadAllCards(db));
  if (list.some(d => d.custom || d.community)) waits.push(loadCardMeta().catch(() => null));
  await Promise.all(waits);
}
