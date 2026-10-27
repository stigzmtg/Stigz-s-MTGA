// Pokémon decklists as text: reading a pasted list, and writing one out. Lists come from Pokémon TCG Live and
// Limitless (a heading with a count for each part, then "count name set number"), the old Pokémon TCG Online, or
// typed by hand, so a list can look like any of
//   Pokémon: 12 · 4 Dreepy TWM 128 · Trainer: 33 · Energy: 15 · 1 Basic {P} Energy SVE 5 · Total Cards: 60
//   ##Pokémon - 12 · * 4 Dreepy TWM 128 · 4x Dreepy · Dreepy x4 · 4 Dreepy (TWM 128) · 4 Ultra Ball SVI 196 PH
// A set code and number pick that exact card when the game has it; otherwise the name decides, whatever its capitals,
// accents, hyphens or curly quotes, and a card printed more than once is the print most tournament decks play. A near
// miss ("Dragapult ec") is read as the one card it's closest to, and a card the game doesn't have comes back with the
// closest names as suggestions.

export const ENERGY_TYPES = ['Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal'];
// the letters Pokémon TCG Live writes Energy types with ({P} is Psychic)
const LETTER = { G: 'Grass', R: 'Fire', W: 'Water', L: 'Lightning', P: 'Psychic', F: 'Fighting', D: 'Darkness', M: 'Metal', N: 'Dragon', C: 'Colorless', Y: 'Fairy' };
const LETTER_OF = Object.fromEntries(Object.entries(LETTER).map(([k, v]) => [v, k]));
export const MAX_COPIES = 4;
export const isBasicEnergy = d => !!d && d.cat === 'E' && d.energy === 'Basic';

// the form names are compared in ("Chi-Yu" and "chi yu", "Poké Ball" and "poke ball", "Boss’s" and "Boss's" are alike)
export const normName = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’‘`´]/g, "'").replace(/[“”]/g, '"')
  .replace(/[-–—_]/g, ' ').toLowerCase().replace(/\s+/g, ' ').trim();

// "Basic {P} Energy", "Basic Psychic Energy", "{P} Energy", "Psychic Energy Energy" (Pokémon TCG Online) -> "Psychic Energy"
function energyName(s) {
  const t = s.replace(/\{([a-z])\}/gi, (m, l) => LETTER[l.toUpperCase()] || m).trim();
  const m = /^(?:basic\s+)?([a-z]+)\s+energy(?:\s+energy)?$/i.exec(t);
  const type = m && ENERGY_TYPES.find(x => x.toLowerCase() === m[1].toLowerCase());
  return type ? `${type} Energy` : t;
}

// what a card does, for telling reprints (the same card printed again) from different cards that share a name
const signature = d => JSON.stringify([d.name, d.cat, d.stage, d.hp, d.type, d.from, d.weak, d.resist, d.retreat, d.abilities, d.attacks, d.trainer, d.text, d.provides, d.energy]);

// Everything the reader needs to know about the card pool, made once: each name's prints (the one most tournament
// decks play first), how many decks play each card, and which cards are reprints of each other.
export function cardIndex(db, decks = []) {
  const plays = new Map();
  for (const d of decks) for (const [k] of d.cards) plays.set(k, (plays.get(k) || 0) + 1);
  const byName = new Map(), bySig = new Map(), twins = new Map();
  for (const def of Object.values(db)) {
    const n = normName(def.name);
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(def.key);
    const s = signature(def);
    if (!bySig.has(s)) bySig.set(s, []);
    bySig.get(s).push(def.key);
  }
  for (const keys of byName.values()) keys.sort((a, b) => (plays.get(b) || 0) - (plays.get(a) || 0));
  for (const keys of bySig.values()) for (const k of keys) twins.set(k, keys);
  // a name with prints that do different things (three Dunsparce): those prints show their set in lists
  const versions = new Set([...byName.values()].filter(keys => new Set(keys.map(k => signature(db[k]))).size > 1).flat());
  return { db, plays, byName, twins, versions, names: [...byName.keys()], deckCount: decks.length };
}
// the print to use for a name (the one most decks play), and the cards a name means
export const printOf = (ix, name) => (ix.byName.get(normName(energyName(name))) || [])[0] || null;
// the same card as `key` already in `keys` (a reprint counts as the same card), if any
export const twinIn = (ix, key, keys) => (ix.twins.get(key) || [key]).find(k => keys.has(k)) || null;
// how a key is written in a list: "TWM 128"
export const setLabel = key => { const i = key.lastIndexOf('-'); return i > 0 ? `${key.slice(0, i)} ${key.slice(i + 1)}` : key; };

// a bounded edit distance (letters swapped next to each other count once); gives up past `max`
function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null, prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let low = i;
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
      if (v < low) low = v;
    }
    if (low > max) return max + 1;
    prev2 = prev; prev = cur;
  }
  return prev[b.length];
}
// how far off a name may be and still count as a typo of one card
const typoAllowance = n => (n.length <= 4 ? 0 : n.length <= 8 ? 1 : n.length <= 15 ? 2 : 3);

// the card a name means: { name } (a normalized name the pool has), { name, fixed: true } (read through a typo), or
// { suggestions: [keys] } (not found)
export function findName(raw, ix) {
  const k = normName(energyName(raw));
  if (!k) return { suggestions: [] };
  if (ix.byName.has(k)) return { name: k };
  const max = typoAllowance(k);
  let best = [];
  const near = [];
  for (const n of ix.names) {
    if (Math.abs(n.length - k.length) > max + 3) continue;
    const d = distance(k, n, max + 3);
    if (d <= max) { if (!best.length || d < best[0].d) best = [{ d, n }]; else if (d === best[0].d) best.push({ d, n }); }
    if (d <= max + 3) near.push({ d, n });
  }
  if (best.length === 1) return { name: best[0].n, fixed: true };
  // nothing close: names that start with what was typed (or have a word that does), then the nearest spellings
  const starts = k.length >= 3 ? ix.names.filter(n => n.startsWith(k) || n.includes(' ' + k)) : [];
  near.sort((a, b) => a.d - b.d || a.n.localeCompare(b.n));
  return { suggestions: [...new Set([...starts, ...near.map(x => x.n)])].slice(0, 3).map(n => ix.byName.get(n)[0]) };
}

// headings ("Pokémon: 12", "##Trainer Cards - 33", "Energy (15)"), and lines that are about the list, not in it
const HEAD = /^(?:pokemon|pokemons|trainers?|trainer cards|energy|energies|energy cards|basic energy|special energy|supporters?|items?|tools?|pokemon tools?|stadiums?)$/;
const ABOUT = /^(?:total(?: cards)?|cards|deck ?list|pokemon trading card game deck ?list)\b/;
function heading(line) {
  const t = normName(line.replace(/^[#*\s]+/, '').replace(/\s*[:(]?\s*\d+\s*\)?\s*$/, '').replace(/[\s:]+$/, '').replace(/\s+\s*$/, ''));
  return HEAD.test(t) ? t : null;
}

// a set code and number at the end of a card line: "TWM 128", "TWM-128", "(TWM 128)", "[TWM 128]", "(TWM) 128", "PR-SV 101"
const SET = '([A-Za-z0-9]{2,6}(?:-[A-Za-z0-9]{1,4})?)';
const PRINTS = [
  new RegExp(`^(.*?)\\s*[([]\\s*${SET}[\\s-]+([A-Za-z]{0,6}\\d{1,4}[a-z]?)\\s*[)\\]]$`),
  new RegExp(`^(.*?)\\s*\\(${SET}\\)\\s*([A-Za-z]{0,6}\\d{1,4}[a-z]?)$`),
  new RegExp(`^(.*\\S)\\s+${SET}[\\s-]+([A-Za-z]{0,6}\\d{1,4}[a-z]?)$`),
];
// the key a set code and number would have in the card pool ("twm", "007" -> "TWM-7")
const keyOf = (set, num) => `${set.toUpperCase()}-${/^\d+$/.test(num) ? String(+num) : num.toUpperCase()}`;

// one card line: { n, name, set, num } or null
function cardLine(line) {
  let s = line.replace(/^[*•·-]\s+/, '').replace(/\s+PH$/, '').trim();
  let n = null, m;
  if ((m = /^(\d{1,3})\s*[x×]?\s+(.+)$/i.exec(s))) { n = +m[1]; s = m[2]; }
  else if ((m = /^(.+?)\s+[x×]\s*(\d{1,3})$/i.exec(s))) { n = +m[2]; s = m[1]; }
  s = s.replace(/\s+PH$/, '').trim();
  if (!s || n === 0) return null;
  for (const re of PRINTS) if ((m = re.exec(s)) && m[1]) return { n, name: m[1].trim(), set: m[2], num: m[3], whole: s };
  return { n, name: s, set: null, num: null, whole: s };
}

// the card a line means: { key, fixed?, swapped? } or { suggestions }
function resolve(c, ix) {
  const key = c.set ? keyOf(c.set, c.num) : null;
  const atKey = key && ix.db[key];
  let found = findName(c.name, ix);
  // ("Pokégear 3.0" and other names that end like a set code and number)
  if (!found.name && c.set) { const whole = findName(c.whole, ix); if (whole.name) { found = whole; c = { ...c, name: c.whole, set: null, num: null }; } }
  if (!found.name) {
    // a name the game doesn't know, but a set code and number it does: that card (the name was off)
    if (atKey) return { key, fixed: true };
    return { suggestions: found.suggestions };
  }
  const prints = ix.byName.get(found.name);
  if (atKey && prints.includes(key)) return { key, fixed: found.fixed };
  // another print: the same set if the game has one, else the one most decks play
  const sameSet = c.set && prints.find(k => k.startsWith(c.set.toUpperCase() + '-'));
  const pick = sameSet || prints[0];
  // (a print the game doesn't have that may do something else than the one used: said so)
  const swapped = !!c.set && !atKey && ix.versions.has(pick);
  return { key: pick, fixed: found.fixed, swapped };
}

// Read a pasted list. Returns { name, cards: Map(key -> count, in list order), missing: [{ name, n, suggestions: [keys] }],
// fixed: [{ from, to: key }] (typos read as the closest card), swapped: [{ from, to: key }] (a print the game doesn't
// have, read as another print of that name that may play differently), clamped: [names kept to 4 copies], total }
export function parseDeckList(text, ix) {
  const out = { name: '', cards: new Map(), missing: [], fixed: [], swapped: [], clamped: [], total: 0 };
  const seenMissing = new Map();
  let lines = 0;
  for (let line of String(text).split(/\r?\n/)) {
    line = line.trim();
    if (!line) continue;
    lines++;
    if (/^\*{3,}/.test(line) || /^\/\//.test(line) || (/^#/.test(line) && !heading(line))) continue;   // banners and comments
    if (heading(line) || ABOUT.test(normName(line.replace(/^[#*\s]+/, '')))) continue;
    const c = cardLine(line);
    if (!c) continue;
    const r = resolve(c, ix);
    if (!r.key) {
      // the first line, with no count, that isn't a card: the deck's name ("Dragapult Box")
      if (c.n == null && lines === 1 && !out.cards.size) { out.name = line.slice(0, 60); continue; }
      const k = normName(c.name);
      if (seenMissing.has(k)) seenMissing.get(k).n += c.n || 1;
      else { const e = { name: c.set ? `${c.name} ${c.set} ${c.num}` : c.name, n: c.n || 1, suggestions: r.suggestions }; seenMissing.set(k, e); out.missing.push(e); }
      continue;
    }
    // a reprint of a card already read is the same card ("2 Ultra Ball SVI 196" and "2 Ultra Ball PAF 91")
    const key = twinIn(ix, r.key, out.cards) || r.key;
    const from = c.set ? `${c.name} ${c.set} ${c.num}` : c.name;
    if (r.fixed && !out.fixed.some(f => f.to === key)) out.fixed.push({ from, to: key });
    else if (r.swapped && !out.swapped.some(f => f.to === key)) out.swapped.push({ from, to: key });
    out.cards.set(key, (out.cards.get(key) || 0) + (c.n || 1));
  }
  // no more than 4 cards with the same name (basic Energy as many as you like): the first ones listed stay
  const byName = new Map();
  for (const [k, n] of out.cards) {
    const d = ix.db[k];
    if (isBasicEnergy(d)) continue;
    const have = byName.get(d.name) || 0, keep = Math.max(0, Math.min(n, MAX_COPIES - have));
    byName.set(d.name, have + keep);
    if (keep < n) { if (!out.clamped.includes(d.name)) out.clamped.push(d.name); if (keep) out.cards.set(k, keep); else out.cards.delete(k); }
  }
  out.total = [...out.cards.values()].reduce((a, b) => a + b, 0);
  return out;
}

// how a card is written in a Pokémon TCG Live list: "Dreepy TWM 128", "Basic {P} Energy SVE 5"
export function printName(d) {
  if (isBasicEnergy(d)) return `Basic {${LETTER_OF[d.provides]}} Energy SVE ${ENERGY_TYPES.indexOf(d.provides) + 1}`;
  return `${d.name} ${setLabel(d.key)}`;
}
// a deck ([[key, n]]) as Pokémon TCG Live and Limitless write it, which pastes back into this builder and into Live
export function deckToText(cards, db) {
  const out = [];
  for (const [cat, label] of [['P', 'Pokémon'], ['T', 'Trainer'], ['E', 'Energy']]) {
    const rows = cards.filter(([k]) => db[k] && db[k].cat === cat);
    if (!rows.length) continue;
    out.push(`${label}: ${rows.reduce((a, [, n]) => a + n, 0)}`, ...rows.map(([k, n]) => `${n} ${printName(db[k])}`), '');
  }
  out.push(`Total Cards: ${cards.reduce((a, [, n]) => a + n, 0)}`);
  return out.join('\n');
}
