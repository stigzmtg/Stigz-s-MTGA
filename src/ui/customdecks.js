// Your own Commander decks, built from the cards the rules engine has scripts for. They have the same shape as the
// precons in data/decks.json ({ id, name, commanders, cards: [[name, n]] }, commanders not in cards) plus
// custom: true, so the engine, lobby, records and replays treat them alike. Saved on this device; in friends'
// rooms each player's presence carries their custom deck so everyone builds the same game.
import { safeStorage, progressChanged } from './common.js';

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
  progressChanged();
}
// (a deleted deck is remembered, so a save code from another device doesn't bring it back)
export function deleteCustomDeck(id) {
  safeStorage.setItem(MINE, JSON.stringify(loadCustomDecks().filter(d => d.id !== id)));
  safeStorage.setItem('pa-deleted-decks', JSON.stringify([...read('pa-deleted-decks').filter(x => x !== id), id].slice(-300)));
  progressChanged();
}
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
// the ways two commanders can share the command zone: Partner (with any other Partner), Partner with one named card,
// Partner—a group (Character select), Friends forever, Choose a Background (with a Background) and Doctor's
// companion (with a Time Lord Doctor)
function pairingOf(s, typeLine) {
  const p = {};
  for (const l of s.split('\n')) {
    let m;
    if (/^K:Partner$/.test(l)) p.any = true;
    else if ((m = /^K:Partner with:([^:]+)/.exec(l))) p.with = m[1];
    else if ((m = /^K:Partner:(.+)$/.exec(l))) p.group = m[1].trim();
    else if (/^K:Friends forever$/i.test(l)) p.group = 'Friends forever';
    else if (/^K:Choose a Background$/i.test(l)) p.background = true;
    else if (/^K:Doctor.s companion$/i.test(l)) p.companion = true;
  }
  if (/\bLegendary\b/.test(typeLine) && /\bBackground\b/.test(typeLine)) p.isBackground = true;
  if (/\bTime Lord Doctor\b/.test(typeLine)) p.isDoctor = true;
  return Object.keys(p).length ? p : null;
}
// can these two cards be commanders together?
export function canPair(a, b) {
  const p = a && a.pairing, q = b && b.pairing;
  if (!p || !q || a.name === b.name) return false;
  return !!((p.any && q.any) || p.with === b.name || q.with === a.name || (p.group && p.group === q.group)
    || (p.background && q.isBackground) || (q.background && p.isBackground) || (p.companion && q.isDoctor) || (q.companion && p.isDoctor));
}
const NUMBER_WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
function copiesAllowed(name, typeLine, text) {
  if (BASICS.has(name) || (/\bBasic\b/.test(typeLine) && /\bLand\b/.test(typeLine)) || /A deck can have any number of cards named/i.test(text)) return Infinity;
  const m = /A deck can have up to (\w+) cards named/i.exec(text);
  return m ? NUMBER_WORDS[m[1].toLowerCase()] || +m[1] || 1 : 1;
}
// (in steps: buildIndexAsync lets the page breathe every few hundred cards, so 32,000 of them never freeze it)
function* indexSteps(raw) {
  const out = [];
  let n = 0;
  for (const name of Object.keys(raw)) {
    if (++n % 400 === 0) yield;
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
    const pairing = pairingOf(s, typeLine);
    out.push({
      name, cost: cost && cost !== 'no cost' ? cost.split(/\s+/) : [], cmc, type: typeLine, text,
      main: MAIN_TYPES.find(t => new RegExp('\\b' + t + '\\b').test(typeLine)) || 'Other',
      ci: COLORS.filter(c => ci.has(c)),
      // (legendary Vehicles and Spacecraft with power and toughness can lead too)
      commander: (/\bLegendary\b/.test(typeLine) && (/\bCreature\b/.test(typeLine) || (/\b(?:Vehicle|Spacecraft)\b/.test(typeLine) && /^PT:/m.test(s)))) || /can be your commander/i.test(text),
      pairing, partner: !!pairing,
      // how many copies a deck may have: one, any number (basics, snow basics, Relentless Rats), or up to N (Nazgûl)
      maxCopies: copiesAllowed(name, typeLine, text),
      get anyNumber() { return this.maxCopies > 1; },
      lower: name.toLowerCase(),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
export const buildIndex = raw => runSteps(indexSteps(raw));
export const buildIndexAsync = raw => runStepsAsync(indexSteps(raw));

// run a generator of work to the end: at once, or with a pause for the page between steps
export const runSteps = g => { let r; while (!(r = g.next()).done); return r.value; };
const breather = () => new Promise(res => { if (typeof MessageChannel === 'undefined') { setTimeout(res, 0); return; } const ch = new MessageChannel(); ch.port1.onmessage = () => res(); ch.port2.postMessage(0); });
export async function runStepsAsync(g) { let r; while (!(r = g.next()).done) await breather(); return r.value; }

// what's wrong with a deck, if anything (an empty list means it's ready to play)
export function deckProblems(deck, byName, identity) {
  const out = [];
  if (!deck.commanders.length) out.push('Choose a commander.');
  if (deck.commanders.length === 2 && !canPair(byName.get(deck.commanders[0]), byName.get(deck.commanders[1]))) out.push('These two can’t be commanders together: two commanders need Partner (or Partner with each other, or a Background).');
  const total = deck.commanders.length + deck.cards.reduce((a, [, n]) => a + n, 0);
  if (total !== 100) out.push(`A Commander deck has exactly 100 cards (this one has ${total}).`);
  const off = deck.cards.filter(([n]) => { const c = byName.get(n); return c && c.ci.some(x => !identity.includes(x)); }).map(([n]) => n);
  if (off.length) out.push(`Outside your commander's colors: ${off.slice(0, 4).join(', ')}${off.length > 4 ? ` and ${off.length - 4} more` : ''}.`);
  const dupes = deck.cards.filter(([n, k]) => k > ((byName.get(n) || {}).maxCopies || 1)).map(([n]) => n);
  if (dupes.length) out.push(`Only one copy of each card except basic lands: ${dupes.slice(0, 3).join(', ')}.`);
  return out;
}
