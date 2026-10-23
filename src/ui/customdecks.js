// Your own Commander decks, built from the cards the rules engine has scripts for. They have the same shape as the
// precons in data/decks.json ({ id, name, commanders, cards: [[name, n]] }, commanders not in cards) plus
// custom: true, so the engine, lobby, records and replays treat them alike. Saved on this device; in friends'
// rooms each player's presence carries their custom deck so everyone builds the same game.
import { safeStorage } from './common.js';

const MINE = 'pa-custom-decks';
const SEEN = 'pa-deck-cache';     // other people's custom decks met in rooms and replays
export const BASICS = new Set(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes']);

const read = k => { try { const v = JSON.parse(safeStorage.getItem(k) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
export const loadCustomDecks = () => read(MINE).filter(validShape);
function validShape(d) { return d && typeof d.id === 'string' && /^custom-[a-z0-9]{4,16}$/.test(d.id) && Array.isArray(d.commanders) && Array.isArray(d.cards) && typeof d.name === 'string'; }

export function saveCustomDeck(deck) {
  const all = loadCustomDecks().filter(d => d.id !== deck.id);
  all.unshift({ ...deck, custom: true, updated: Date.now() });
  safeStorage.setItem(MINE, JSON.stringify(all));
  registerDeck(deck);
}
export function deleteCustomDeck(id) { safeStorage.setItem(MINE, JSON.stringify(loadCustomDecks().filter(d => d.id !== id))); }
export const newDeckId = () => 'custom-' + Math.random().toString(36).slice(2, 10);

// every custom deck this browser knows: its own, and others' seen in rooms or replays
const registry = new Map();
for (const d of [...read(SEEN), ...loadCustomDecks()]) if (validShape(d)) registry.set(d.id, { ...d, custom: true });
export function registerDeck(d) {
  if (!validShape(d)) return;
  const known = registry.get(d.id);
  if (known && JSON.stringify(known.cards) === JSON.stringify(d.cards) && known.name === d.name) return;
  registry.set(d.id, { ...d, custom: true });
  if (!loadCustomDecks().some(x => x.id === d.id)) {
    const seen = read(SEEN).filter(x => x.id !== d.id);
    seen.unshift({ id: d.id, name: d.name, commanders: d.commanders, cards: d.cards });
    safeStorage.setItem(SEEN, JSON.stringify(seen.slice(0, 40)));
  }
}
export const customDeck = id => registry.get(id) || null;
// a precon by id, or a custom deck
export function findDeck(decks, id) { return decks.find(d => d.id === id) || customDeck(id); }

// the compact form that travels in room presence: { i, n, c: [commanders], l: 'name*count|name|…' }
export function packDeck(d) { return { i: d.id, n: d.name.slice(0, 60), c: d.commanders, l: d.cards.map(([n, k]) => (k > 1 ? `${n}*${k}` : n)).join('|') }; }
export function unpackDeck(p) {
  if (!p || typeof p.l !== 'string' || !Array.isArray(p.c)) return null;
  const cards = p.l.split('|').filter(Boolean).map(s => { const m = /^(.*)\*(\d+)$/.exec(s); return m ? [m[1], +m[2]] : [s, 1]; });
  const d = { id: p.i, name: String(p.n || 'Custom deck'), commanders: p.c.map(String).slice(0, 2), cards };
  return validShape(d) ? d : null;
}

// ---- a light index of every scripted card for searching (no full script parsing)
const COLORS = ['W', 'U', 'B', 'R', 'G'];
const LAND_COLOR = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };
const MAIN_TYPES = ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land'];
export function buildIndex(raw) {
  const out = [];
  for (const name of Object.keys(raw)) {
    const s = raw[name];
    let cost = null, type = null, text = '';
    const ci = new Set();
    for (const l of s.split('\n')) {
      // Forge writes hybrid and Phyrexian mana as joined letters: WB, PR, 2W
      if (l.startsWith('ManaCost:')) { const v = l.slice(9).trim(); if (cost == null) cost = v; if (v !== 'no cost') for (const t of v.split(/\s+/)) for (const c of t) if (COLORS.includes(c)) ci.add(c); }
      else if (l.startsWith('Types:')) { const v = l.slice(6).trim(); if (type == null) type = v; if (/\bLand\b/.test(v)) for (const [k, c] of Object.entries(LAND_COLOR)) if (v.includes(k)) ci.add(c); }
      else if (l.startsWith('Colors:')) { for (const [k, c] of Object.entries({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' })) if (l.includes(k)) ci.add(c); }
      else if (l.startsWith('Oracle:')) { const v = l.slice(7).replace(/\\n/g, '\n'); if (!text) text = v; for (const m of v.replace(/\([^)]*\)/g, '').matchAll(/\{([^}]+)\}/g)) for (const c of m[1].split('/')) if (COLORS.includes(c)) ci.add(c); }
    }
    let cmc = 0;
    if (cost && cost !== 'no cost') for (const t of cost.split(/\s+/)) { if (/^\d+$/.test(t)) cmc += +t; else if (/^\d[WUBRG]$/.test(t)) cmc += +t[0]; else if (t && !/^[XYZ]$/.test(t)) cmc += 1; }
    const typeLine = type || '';
    out.push({
      name, cost: cost && cost !== 'no cost' ? cost.split(/\s+/) : [], cmc, type: typeLine, text,
      main: MAIN_TYPES.find(t => new RegExp('\\b' + t + '\\b').test(typeLine)) || 'Other',
      ci: COLORS.filter(c => ci.has(c)),
      commander: (/\bLegendary\b/.test(typeLine) && /\bCreature\b/.test(typeLine)) || /can be your commander/i.test(text),
      partner: /^K:Partner$/m.test(s),
      anyNumber: BASICS.has(name) || /A deck can have any number of cards named/i.test(text),
      lower: name.toLowerCase(),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// what's wrong with a deck, if anything (an empty list means it's ready to play)
export function deckProblems(deck, byName, identity) {
  const out = [];
  if (!deck.commanders.length) out.push('Choose a commander.');
  if (deck.commanders.length === 2 && !deck.commanders.every(n => byName.get(n) && byName.get(n).partner)) out.push('Two commanders need Partner.');
  const total = deck.commanders.length + deck.cards.reduce((a, [, n]) => a + n, 0);
  if (total !== 100) out.push(`A Commander deck has exactly 100 cards (this one has ${total}).`);
  const off = deck.cards.filter(([n]) => { const c = byName.get(n); return c && c.ci.some(x => !identity.includes(x)); }).map(([n]) => n);
  if (off.length) out.push(`Outside your commander's colors: ${off.slice(0, 4).join(', ')}${off.length > 4 ? ` and ${off.length - 4} more` : ''}.`);
  const dupes = deck.cards.filter(([n, k]) => k > 1 && !(byName.get(n) || {}).anyNumber).map(([n]) => n);
  if (dupes.length) out.push(`Only one copy of each card except basic lands: ${dupes.slice(0, 3).join(', ')}.`);
  return out;
}
