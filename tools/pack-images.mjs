// Pack the AVIF card images from tools/fetch-images.mjs into a few hundred files the artifact can publish.
// Every image is stored once:
//   lobby-*   each deck's commanders (the deck list shows them; a game loads the one holding its commanders)
//   common-*  staples that appear in many decks, one printing each, grouped by color identity
//   shared-*  printings several decks use (decks from the same product, or the same default printing)
//   deck-*    printings only one deck uses
//   tokens-*  token pictures, loaded when a token first appears
// Writes dist/img/*.avif and data/images.json.
// Usage: node tools/pack-images.mjs <cache dir> [--common=6]
import fs from 'node:fs';
import path from 'node:path';
import { CardDB } from '../src/engine/cards.js';

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const CACHE = args.find(a => !a.startsWith('--'));
const K = +(flags.common || 6);
const DRY = !!flags.dry;
const manifest = JSON.parse(fs.readFileSync(path.join(CACHE, 'manifest.json'), 'utf8'));
const decks = JSON.parse(fs.readFileSync('data/decks.json', 'utf8'));
const db = new CardDB(JSON.parse(fs.readFileSync('data/cards.json', 'utf8')), JSON.parse(fs.readFileSync('data/tokens.json', 'utf8')));
const OUT = 'dist/img';
// replace the Commander packs (the Pokémon side's ptcg-*.avif packs stay)
if (!DRY) { fs.mkdirSync(OUT, { recursive: true }); for (const f of fs.readdirSync(OUT)) if (!/^ptcg-/.test(f)) fs.rmSync(path.join(OUT, f)); }

const faceFiles = id => (manifest.cards[id] ? manifest.cards[id].urls : []).map((_, f) => path.join(CACHE, 'img', `${id}-${f}.avif`)).filter(f => fs.existsSync(f));
const identity = name => { const d = db.get(name); const ci = d ? d.colorIdentity() : []; return ci.length === 0 ? 'C' : ci.length > 1 ? 'M' : ci[0]; };

// index: packs[i] = url; images[j] = [[pack, offset, length] per face]; decks[id] = { cards: { name: j }, packs: [i...] }
const index = { v: 2, type: 'image/avif', packs: [], images: [], decks: {}, lobby: {}, tokens: {} };
const sizes = [];
let total = 0;
class Pack {
  constructor(name, limit) { this.name = name; this.limit = limit; this.parts = []; this.size = 0; this.idx = index.packs.length; index.packs.push(`img/${name}.avif`); sizes.push(0); }
  add(file) { const b = fs.readFileSync(file); const at = [this.idx, this.size, b.length]; this.parts.push(b); this.size += b.length; sizes[this.idx] = this.size; return at; }
  full() { return this.size >= this.limit; }
  write() { if (!DRY) fs.writeFileSync(path.join(OUT, this.name + '.avif'), Buffer.concat(this.parts)); total += this.size; this.parts = []; }
}
// a series of packs that rolls over to a new one when the current fills up
function series(prefix, limit) {
  let cur = null, n = 0;
  return {
    add(file) { if (!cur || cur.full()) { if (cur) cur.write(); cur = new Pack(`${prefix}-${n++}`, limit); } return cur.add(file); },
    end() { if (cur) cur.write(); cur = null; },
  };
}
const stored = new Map(); // printing id -> image index
function store(id, s) {
  if (stored.has(id)) return stored.get(id);
  const files = faceFiles(id);
  if (!files.length) return null;
  const j = index.images.length;
  index.images.push(files.map(f => s.add(f)));
  stored.set(id, j);
  return j;
}

const namesOf = d => [...new Set([...d.commanders, ...d.cards.map(c => c[0])])];
const printing = (d, n) => manifest.printings[`${d.id}|${n}`];
for (const d of decks) index.decks[d.id] = { cards: {}, packs: [] };

// 1. commanders, in deck-list order
const lobby = series('lobby', 1.2e6);
for (const d of decks) {
  index.lobby[d.id] = [];
  for (const n of d.commanders) {
    const j = printing(d, n) && store(printing(d, n), lobby);
    if (j != null) { index.decks[d.id].cards[n] = j; index.lobby[d.id].push(j); }
  }
}
lobby.end();

// 2. staples in K or more decks: the printing most of those decks use, one series per color identity
const freq = new Map();
for (const d of decks) for (const n of new Set(d.cards.map(c => c[0]))) freq.set(n, (freq.get(n) || 0) + 1);
const common = [...freq].filter(([, f]) => f >= K).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([n]) => n);
const commonPick = new Map();
const bySeries = {};
// within a series, cards of the same exact identity sit together so a deck touches fewer packs
const fullIdentity = name => { const d = db.get(name); return d ? d.colorIdentity().join('') : ''; };
common.sort((a, b) => (fullIdentity(a) < fullIdentity(b) ? -1 : fullIdentity(a) > fullIdentity(b) ? 1 : 0) || freq.get(b) - freq.get(a));
for (const n of common) {
  const votes = new Map();
  for (const d of decks) { const id = printing(d, n); if (id) votes.set(id, (votes.get(id) || 0) + 1); }
  const best = [...votes].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  if (!best) continue;
  // the most played staples (in a fifth of all decks) go together; the rest by color identity
  const key = freq.get(n) >= decks.length / 5 ? 'top' : identity(n);
  const s = bySeries[key] || (bySeries[key] = series(`common-${key.toLowerCase()}`, 0.8e6));
  const j = store(best[0], s);
  if (j != null) commonPick.set(n, j);
}
for (const s of Object.values(bySeries)) s.end();

// 3. printings several decks use, grouped by the product of the first deck that uses them
const users = new Map(); // printing -> deck ids
for (const d of decks) for (const n of namesOf(d)) {
  if (commonPick.has(n) && !d.commanders.includes(n)) continue;
  const id = printing(d, n);
  if (id && !stored.has(id)) { if (!users.has(id)) users.set(id, new Set()); users.get(id).add(d.id); }
}
const deckById = new Map(decks.map(d => [d.id, d]));
const sharedBySet = new Map();
for (const [id, us] of users) {
  if (us.size < 2) continue;
  const sets = new Set([...us].map(u => deckById.get(u).set));
  const key = sets.size === 1 ? [...sets][0].toLowerCase() : 'x';
  if (!sharedBySet.has(key)) sharedBySet.set(key, []);
  sharedBySet.get(key).push(id);
}
for (const [key, ids] of [...sharedBySet].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
  const s = series(`shared-${key}`, 1.5e6);
  // printings used by the same decks sit together
  const sig = id => [...users.get(id)].sort().join(',');
  for (const id of ids.sort((a, b) => (sig(a) < sig(b) ? -1 : sig(a) > sig(b) ? 1 : a < b ? -1 : 1))) store(id, s);
  s.end();
}

// 4. each deck's own printings
for (const d of decks) {
  const s = series(`deck-${d.id}`, 4e6);
  for (const n of namesOf(d)) { const id = printing(d, n); if (id && !stored.has(id) && !(commonPick.has(n) && !d.commanders.includes(n))) store(id, s); }
  s.end();
}

// deck -> card name -> image, and the packs a game with that deck should load up front
for (const d of decks) {
  const e = index.decks[d.id];
  for (const n of namesOf(d)) {
    if (e.cards[n] != null) continue;
    const j = commonPick.has(n) ? commonPick.get(n) : stored.get(printing(d, n));
    if (j != null) e.cards[n] = j;
  }
  e.packs = [...new Set(Object.values(e.cards).flatMap(j => index.images[j].map(f => f[0])))].sort((a, b) => a - b);
}

// tokens, by Forge token script name, in small packs (loaded when a token shows up)
const tokDir = path.join(CACHE, 'tokens');
if (fs.existsSync(tokDir)) {
  const s = series('tokens', 0.6e6);
  for (const f of fs.readdirSync(tokDir).filter(f => f.endsWith('.avif')).sort()) index.tokens[f.replace(/\.avif$/, '')] = s.add(path.join(tokDir, f));
  s.end();
}

if (!DRY) fs.writeFileSync('data/images.json', JSON.stringify(index));
let missing = 0;
for (const d of decks) for (const n of namesOf(d)) if (index.decks[d.id].cards[n] == null) missing++;
const loads = decks.map(d => index.decks[d.id].packs.reduce((s, i) => s + sizes[i], 0));
loads.sort((a, b) => a - b);
const mb = n => (n / 1048576).toFixed(1);
console.log(`${index.packs.length} packs, ${mb(total)} MB, ${index.images.length} card images (${common.length} shared staples), ${Object.keys(index.tokens).length} tokens, ${missing} deck cards without an image`);
console.log(`per deck download: median ${mb(loads[loads.length >> 1])} MB, max ${mb(loads[loads.length - 1])} MB; index ${mb(JSON.stringify(index).length)} MB`);
