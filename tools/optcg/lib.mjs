// Shared helpers for the One Piece tools: the card database and decks. They come from data/optcg (the data
// pipeline); until those files exist, from the temporary cache in tools/.scratch/optcg.
import fs from 'node:fs';

function load(name) {
  for (const dir of ['data/optcg', 'tools/.scratch/optcg']) {
    const f = `${dir}/${name}`;
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  }
  throw new Error(`no ${name}: run the One Piece data pipeline first`);
}
export function loadDb() {
  const raw = load('cards.json');
  return Array.isArray(raw) ? Object.fromEntries(raw.map(c => [c.id, c])) : raw;
}
export function loadDecks() { return load('decks.json'); }
// the cards used by the given decks (all decks by default), leaders included
export function deckCards(db, decks) {
  const ids = new Set();
  for (const d of decks) { ids.add(d.leader); for (const [id] of d.cards) ids.add(id); }
  return [...ids].map(id => db[id]).filter(Boolean);
}
