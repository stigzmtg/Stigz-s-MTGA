// Your own Pokémon decks: 60 cards from the 441 the rules engine plays. They have the same shape as the tournament
// decks in data/ptcg/decks.json ({ id, name, cards: [[key, n]] }, keys like "TWM-128") plus custom: true, and take
// the lobby's picture and Energy symbols from their cards (deckLook). Saved on this device. In friends' rooms each
// player's presence carries their deck (packDeck), and their seat names it with a fingerprint of its cards (deckRef),
// so a browser only starts the battle once it holds exactly the same 60 cards, in the same order, as everyone else.
import { safeStorage, progressChanged } from '../ui/common.js';
import { MAX_COPIES, isBasicEnergy, ENERGY_TYPES } from './decktext.js';

const MINE = 'pk-custom-decks';
const GONE = 'pk-deleted-decks';
const SEEN = 'pk-deck-cache';       // other people's decks met in rooms (the latest of each)
export const DECK_SIZE = 60;
const ID = /^pkc-[a-z0-9]{4,16}$/;

// ---- the rules: what makes a deck legal, in plain words
const isBasicMon = d => !!d && d.cat === 'P' && d.stage === 'Basic';
const andList = a => (a.length > 1 ? `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}` : a[0] || '');
const total = cards => cards.reduce((a, [, n]) => a + n, 0);

// how many of each kind: { total, P, T, E, basics, items, supporters, stadiums, tools, basicEnergy, specialEnergy }
export function deckCounts(cards, db) {
  const c = { total: 0, P: 0, T: 0, E: 0, basics: 0, Item: 0, Supporter: 0, Stadium: 0, Tool: 0, basicEnergy: 0, specialEnergy: 0 };
  for (const [k, n] of cards) {
    const d = db[k];
    if (!d) continue;
    c.total += n; c[d.cat] += n;
    if (isBasicMon(d)) c.basics += n;
    if (d.cat === 'T') c[d.trainer] = (c[d.trainer] || 0) + n;
    if (d.cat === 'E') c[isBasicEnergy(d) ? 'basicEnergy' : 'specialEnergy'] += n;
  }
  return c;
}
// each name's count (basic Energy left out: a deck can have any number)
function copiesByName(cards, db) {
  const m = new Map();
  for (const [k, n] of cards) { const d = db[k]; if (d && !isBasicEnergy(d)) m.set(d.name, (m.get(d.name) || 0) + n); }
  return m;
}
// the deck's ACE SPEC cards and Radiant Pokémon, by name with counts
const special = (cards, db, f) => { const m = new Map(); for (const [k, n] of cards) { const d = db[k]; if (d && f(d)) m.set(d.name, (m.get(d.name) || 0) + n); } return m; };
const listOf = m => andList([...m].map(([nm, n]) => (n > 1 ? `${n} ${nm}` : nm)));

// The five rules a deck must keep to play, each { id, ok, label, have, text } in words a child can follow.
export function deckRules(cards, db) {
  const c = deckCounts(cards, db);
  const copies = [...copiesByName(cards, db)];
  const over = copies.filter(([, n]) => n > MAX_COPIES);
  const most = copies.reduce((a, [, n]) => Math.max(a, n), 0);
  const aces = special(cards, db, d => d.ace), radiants = special(cards, db, d => d.radiant);
  const nAce = total([...aces]), nRad = total([...radiants]);
  return [
    { id: 'size', ok: c.total === DECK_SIZE, label: '60 cards', have: `${c.total}/${DECK_SIZE}`,
      text: c.total === DECK_SIZE ? 'Exactly 60 cards, just right.'
        : c.total < DECK_SIZE ? `A deck has exactly 60 cards. Yours has ${c.total}: add ${DECK_SIZE - c.total} more.`
          : `A deck has exactly 60 cards. Yours has ${c.total}: take ${c.total - DECK_SIZE} out.` },
    { id: 'copies', ok: !over.length, label: 'Up to 4 of a card', have: `${most}/${MAX_COPIES}`,
      text: over.length ? `You can have up to 4 cards with the same name (basic Energy as many as you like). Too many: ${andList(over.map(([nm, n]) => `${nm} (${n})`))}.`
        : 'No more than 4 cards with the same name. Basic Energy can be as many as you like.' },
    { id: 'basic', ok: c.basics > 0, label: 'A Basic Pokémon', have: String(c.basics),
      text: c.basics ? `${c.basics} Basic Pokémon to start the game with.` : 'You need at least one Basic Pokémon: every game starts with one in the Active Spot.' },
    { id: 'ace', ok: nAce <= 1, label: '1 ACE SPEC at most', have: `${nAce}/1`,
      text: nAce > 1 ? `ACE SPEC cards are extra strong, so a deck can have only 1. You have ${nAce}: ${listOf(aces)}.`
        : `ACE SPEC cards are extra strong, so a deck can have only 1${nAce ? ` (yours is ${listOf(aces)})` : ''}.` },
    { id: 'radiant', ok: nRad <= 1, label: '1 Radiant at most', have: `${nRad}/1`,
      text: nRad > 1 ? `A deck can have only 1 Radiant Pokémon. You have ${nRad}: ${listOf(radiants)}.`
        : `A deck can have only 1 Radiant Pokémon${nRad ? ` (yours is ${listOf(radiants)})` : ''}.` },
  ];
}
// what keeps a deck from playing (an empty list means it's ready)
export const deckProblems = (cards, db) => deckRules(cards, db).filter(r => !r.ok).map(r => r.text);
export const deckReady = (deck, db) => !!deck && deckProblems(deck.cards, db).length === 0;

// Why adding one more of `key` would break a rule, or null.
export function cantAdd(cards, db, key) {
  const d = db[key];
  if (!d) return 'That card isn’t in the game.';
  if (isBasicEnergy(d)) return null;
  const have = copiesByName(cards, db).get(d.name) || 0;
  if (have >= MAX_COPIES) return `You can have up to 4 cards called ${d.name}.`;
  const other = (f, kind) => { const m = special(cards, db, f); const names = [...m.keys()].filter(n => n !== d.name); return names.length ? `Only 1 ${kind} per deck: you already have ${names[0]}.` : have ? `Only 1 ${kind} per deck.` : null; };
  if (d.ace) return other(x => x.ace, 'ACE SPEC card');
  if (d.radiant) return other(x => x.radiant, 'Radiant Pokémon');
  return null;
}

// the Energy types a deck's Energy cards make (Energy that can count as every type makes them all)
export function energyMade(cards, db) {
  const makes = new Set();
  for (const [k] of cards) {
    const d = db[k];
    if (!d || d.cat !== 'E') continue;
    if (d.anyType || /every type/i.test(d.text || '')) ENERGY_TYPES.concat('Dragon').forEach(t => makes.add(t));
    else makes.add(d.provides);
    if (d.either) d.either.types.forEach(t => makes.add(t));
  }
  return makes;
}
// the Energy types a Pokémon is missing to use any of its attacks (its cheapest attack's), or [] when one is payable
export function energyMissing(d, makes) {
  if (!d || d.cat !== 'P' || !(d.attacks || []).length) return [];
  const short = a => [...new Set(a.cost.filter(t => t !== 'Colorless' && !makes.has(t)))];
  if (d.attacks.some(a => !short(a).length)) return [];
  return short(d.attacks.reduce((a, b) => (b.cost.length < a.cost.length ? b : a)));
}

// Friendly hints that don't stop a deck from playing: an evolution with nothing to evolve from, a deck whose Pokémon
// can't pay for any attack with its Energy, very few Basic Pokémon.
export function deckTips(cards, db) {
  const out = [];
  const defs = cards.map(([k]) => db[k]).filter(Boolean);
  const names = new Set(defs.map(d => d.name));
  const pool = new Map(Object.values(db).filter(d => d.cat === 'P').map(d => [d.name, d]));
  const candy = names.has('Rare Candy');
  for (const d of defs) {
    // (only lines the game can build: a card whose earlier stage isn't in the game is in a deck for other reasons)
    if (d.cat !== 'P' || !d.from || !pool.has(d.from) || names.has(d.from) || out.some(t => t.id === `evo-${d.name}`)) continue;
    const basic = d.stage === 'Stage2' && pool.get(d.from).from;
    if (basic && candy && names.has(basic)) continue;
    out.push({ id: `evo-${d.name}`, text: `${d.name} evolves from ${d.from}, and there’s no ${d.from} in your deck${basic && pool.has(basic) ? ` (or Rare Candy can turn a ${basic} into ${d.name})` : ''}.` });
  }
  const mons = defs.filter(d => d.cat === 'P' && (d.attacks || []).length);
  const makes = energyMade(cards, db);
  if (mons.length && mons.every(d => energyMissing(d, makes).length)) {
    const need = [...new Set(mons.flatMap(d => energyMissing(d, makes)))];
    out.push({ id: 'energy', text: makes.size ? `None of your Pokémon can attack with the Energy in your deck. They need ${andList(need)} Energy.` : `Your deck has no Energy cards, and Pokémon need Energy to attack (${andList(need)}).` });
  }
  const c = deckCounts(cards, db);
  if (c.basics > 0 && c.basics < 6 && c.total >= 40) out.push({ id: 'basics', text: `Only ${c.basics} Basic Pokémon: many opening hands won't have one, and then you shuffle and draw again (a mulligan). Most decks have 8 or more.` });
  return out;
}

// the chance an opening hand of 7 from `size` cards has at least one of `have` cards (a Basic Pokémon)
export function handChance(size, have, hand = 7) {
  if (size < hand || have <= 0) return 0;
  let none = 1;
  for (let i = 0; i < hand; i++) none *= (size - have - i) / (size - i);
  return 1 - Math.max(0, none);
}

// A deck's cards in the order lists show them: Pokémon by evolution line (the biggest line first), then Supporters,
// Items, Tools and Stadiums, then basic and Special Energy.
export function sortDeck(cards, db) {
  const root = d => { let r = d; for (let i = 0; i < 3 && r.from; i++) { const p = Object.values(db).find(x => x.cat === 'P' && x.name === r.from); if (!p) return r.from; r = p; } return r.name; };
  const STAGE = { Basic: 0, Stage1: 1, Stage2: 2, VSTAR: 3 };
  const TRAINER = { Supporter: 0, Item: 1, Tool: 2, Stadium: 3 };
  const fam = new Map();
  for (const [k, n] of cards) { const d = db[k]; if (d && d.cat === 'P') { const r = root(d); fam.set(r, (fam.get(r) || 0) + n); } }
  const rank = ([k, n]) => {
    const d = db[k] || { cat: 'Z', name: k };
    if (d.cat === 'P') { const r = root(d); return [0, -fam.get(r), r, STAGE[d.stage] || 0, -n, d.name, k]; }
    if (d.cat === 'T') return [1, TRAINER[d.trainer] ?? 4, 0, 0, -n, d.name, k];
    if (d.cat === 'E') return [2, isBasicEnergy(d) ? 0 : 1, 0, isBasicEnergy(d) ? ENERGY_TYPES.indexOf(d.provides) : 0, -n, d.name, k];
    return [3, 0, 0, 0, 0, k, k];
  };
  const cmp = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return 0; };
  return cards.slice().sort((a, b) => cmp(rank(a), rank(b)));
}

// What the lobby shows for a deck: its picture (the card you chose, else the biggest Pokémon ex, V or Mega, else the
// Pokémon with the most HP), the Energy types it makes, and the types it attacks with.
export function deckLook(deck, db) {
  const mons = deck.cards.map(([k, n]) => [db[k], n]).filter(([d]) => d && d.cat === 'P');
  const star = mons.slice().sort(([a, an], [b, bn]) => (!!(b.ex || b.v || b.mega) - !!(a.ex || a.v || a.mega)) || (b.hp - a.hp) || (bn - an))[0];
  const featured = deck.featured && db[deck.featured] ? deck.featured : star ? star[0].key : (deck.cards[0] || [])[0] || null;
  const energy = [...new Set(deck.cards.map(([k]) => db[k]).filter(d => d && d.cat === 'E' && (isBasicEnergy(d) || (d.provides !== 'Colorless' && !d.anyType))).sort((a, b) => !isBasicEnergy(a) - !isBasicEnergy(b)).map(d => d.provides))];
  const types = star ? [...new Set([star[0].type, ...mons.filter(([d]) => d.ex || d.v || d.mega).map(([d]) => d.type)])].filter(Boolean) : [];
  return { featured, energy, types };
}

// ---- saved on this device
const read = k => { try { const v = JSON.parse(safeStorage.getItem(k) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const validShape = d => !!d && typeof d.id === 'string' && ID.test(d.id) && typeof d.name === 'string' && Array.isArray(d.cards)
  && d.cards.every(e => Array.isArray(e) && typeof e[0] === 'string' && Number.isInteger(e[1]) && e[1] > 0 && e[1] <= DECK_SIZE);
export const loadCustomDecks = () => read(MINE).filter(validShape).map(d => ({ ...d, custom: true }));
export const newDeckId = () => 'pkc-' + Math.random().toString(36).slice(2, 10);

export function saveCustomDeck(deck) {
  const all = read(MINE).filter(d => d && d.id !== deck.id);
  all.unshift({ id: deck.id, name: deck.name, cards: deck.cards, ...(deck.featured ? { featured: deck.featured } : {}), updated: Date.now() });
  safeStorage.setItem(MINE, JSON.stringify(all));
  progressChanged();
}
// (a deleted deck is remembered, so a save code from another device doesn't bring it back)
export function deleteCustomDeck(id) {
  safeStorage.setItem(MINE, JSON.stringify(read(MINE).filter(d => d && d.id !== id)));
  safeStorage.setItem(GONE, JSON.stringify([...read(GONE).filter(x => x !== id), id].slice(-300)));
  progressChanged();
}

// ---- decks in rooms and replays
// a fingerprint of a deck's cards in their order (two browsers holding the same fingerprint build the same game)
export function fingerprint(cards) {
  let h = 0x811c9dc5;
  const s = cards.map(([k, n]) => `${k}*${n}`).join('|');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
// how a room seat names a deck: a tournament deck by its id, your own as "pkc-…@fingerprint"
export const deckRef = d => (d.custom ? `${d.id}@${fingerprint(d.cards)}` : d.id);
export const plainId = ref => String(ref || '').split('@')[0];

// the compact form that travels in room presence and replays: { i, n, l: 'TWM-128*4|MEG-114|…', f }
export function packDeck(d) { return { i: d.id, n: d.name.slice(0, 60), l: d.cards.map(([k, n]) => (n > 1 ? `${k}*${n}` : k)).join('|'), ...(d.featured ? { f: d.featured } : {}) }; }
// (a deck with cards this browser doesn't have, or one that breaks the rules, is refused: it couldn't be played)
export function unpackDeck(p, db) {
  if (!p || typeof p.i !== 'string' || typeof p.l !== 'string' || p.l.length > 3000) return null;
  const cards = [];
  for (const s of p.l.split('|')) {
    const m = /^(.+?)(?:\*(\d{1,2}))?$/.exec(s);
    if (!m || !Object.prototype.hasOwnProperty.call(db, m[1])) return null;
    cards.push([m[1], m[2] ? +m[2] : 1]);
  }
  const d = { id: p.i, name: String(p.n || 'Pokémon deck').slice(0, 60), cards, custom: true, ...(typeof p.f === 'string' && db[p.f] ? { featured: p.f } : {}) };
  return validShape(d) && !deckProblems(cards, db).length ? d : null;
}

// A replay of a battle with a deck of your own (or a friend's) keeps that deck as it was, so it plays back the same
// after the deck changes, and on another device. (ui/records.js keeps the replay; this adds the decks to it.)
export function keepDecksInReplay(id, decks) {
  const key = 'pa-replay-' + id;
  let rep = null;
  try { rep = JSON.parse(safeStorage.getItem(key) || 'null'); } catch { /* not a replay */ }
  if (!rep || !Array.isArray(rep.players) || !decks.some(d => d && d.custom)) return;
  rep.players = rep.players.map((p, i) => (decks[i] && decks[i].custom ? { ...p, deck: packDeck(decks[i]) } : p));
  safeStorage.setItem(key, JSON.stringify(rep));
}

// others' decks this browser has met: every version seen since the page opened (by ref), and the latest of each kept
// on the device
const versions = new Map();
export function registerDeck(d) {
  if (!d || !validShape(d)) return;
  const ref = deckRef({ ...d, custom: true });
  if (versions.has(ref) && versions.get(ref).name === d.name) return;
  versions.set(ref, { ...d, custom: true });
  if (loadCustomDecks().some(x => x.id === d.id)) return;
  const seen = read(SEEN);
  const had = seen.find(x => x && x.id === d.id);
  if (had && fingerprint(had.cards) === fingerprint(d.cards) && had.name === d.name) return;
  safeStorage.setItem(SEEN, JSON.stringify([{ id: d.id, name: d.name, cards: d.cards, ...(d.featured ? { featured: d.featured } : {}) }, ...seen.filter(x => x && x.id !== d.id)].slice(0, 40)));
}
// a deck that came packed in someone's room presence (each packed form is read and checked once)
const unpacked = new Set();
export function registerPacked(p, db) {
  const key = p && typeof p.l === 'string' ? `${p.i}|${p.n}|${p.f || ''}|${p.l}` : null;
  if (!key || unpacked.has(key)) return;
  unpacked.add(key);
  registerDeck(unpackDeck(p, db));
}
// A deck by id or ref: a tournament deck, one of yours, or one met in a room. A ref with a fingerprint only finds
// exactly that version of the deck.
export function findDeck(decks, ref) {
  if (!ref) return null;
  const [id, fp] = String(ref).split('@');
  const built = decks.find(d => d.id === id && !d.custom);
  if (built) return built;
  if (!ID.test(id)) return null;
  if (fp && versions.has(ref)) return versions.get(ref);
  for (const d of [...loadCustomDecks(), ...read(SEEN).filter(validShape)]) if (d.id === id && (!fp || fingerprint(d.cards) === fp)) return { ...d, custom: true };
  return null;
}
