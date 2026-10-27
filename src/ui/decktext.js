// Decklists as text: reading a pasted list, and writing one out. Lists come from everywhere (Moxfield, Archidekt,
// MTG Arena, MTGO, EDHREC, TappedOut, typed by hand), so a card line can look like any of
//   1 Sol Ring · 1x Sol Ring · Sol Ring x1 · Sol Ring · 1 Sol Ring (C21) 263 *F* · 1x Sol Ring (c21) 263 [Ramp] ^Have,#37d67a^ · SB: 1 Sol Ring
// and a commander is marked by a heading ("Commander", "Commander (1)", "// Commander", "COMMANDER:"), by *CMDR* or
// "(Commander)" after its name, by an Archidekt "[Commander]" category, or (MTGO lists) by being the only card or two
// in the sideboard. Names match whatever their capitals, accents or curly quotes; a near miss ("Sol Rnig") is read as
// the one card it's closest to, and a name the game doesn't know comes back with the closest cards as suggestions.

import { canPair } from './customdecks.js';

// the form names are compared in
export const normName = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/æ/gi, 'ae').replace(/[’‘`´]/g, "'").replace(/[“”]/g, '"')
  .toLowerCase().replace(/\s+/g, ' ').trim();

// headings: where the cards under them go
const COMMANDER_HEAD = /^(?:commanders?|command zone|cmdr|commander\(s\))$/;
const SIDE_HEAD = /^(?:sideboard|side ?board|sb)$/;
const SKIP_HEAD = /^(?:maybe ?board|maybe|considering|tokens?(?: & extras)?|extras|companions?|attractions|stickers|contraptions|planes|schemes|acquire ?board|outside the game|wishlist|wish board)$/;
const ABOUT_HEAD = /^about$/;
const DECK_HEAD = /^(?:deck|decklist|main ?(?:deck|board)?|library|the 99|creatures?|lands?|basic lands|nonbasic lands|spells?|instants?|sorcer(?:y|ies)|artifacts?|enchantments?|planeswalkers?|battles?|others?|non-?creatures?|mana rocks|ramp|removal|(?:card )?draw|board ?wipes|wipes|interaction|protection|tutors|recursion|counter ?spells|win ?cons?|win conditions|finishers|synergy|utility|combo|staples)$/;

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

// the lookup for a set of card names (made once per card index)
const lookups = new WeakMap();
function lookupFor(byName) {
  let L = lookups.get(byName);
  if (L) return L;
  const exact = new Map(), short = new Map();
  for (const name of byName.keys()) {
    const k = normName(name);
    exact.set(k, name);
    // "Atraxa" for "Atraxa, Praetors' Voice" (only when one card has that first part)
    const s = k.split(',')[0];
    if (s !== k && s.length >= 4) short.set(s, short.has(s) ? null : name);
  }
  const all = [...exact];
  // every name's three-letter pieces, so a misspelling is compared only with the names that share the most of them
  const grams = new Map();
  all.forEach(([n], i) => { for (const g of trigrams(n)) { let list = grams.get(g); if (!list) grams.set(g, list = []); list.push(i); } });
  L = { exact, short, all, grams, counts: new Uint16Array(all.length) };
  lookups.set(byName, L);
  return L;
}
const trigrams = s => { const p = `  ${s} `, out = new Set(); for (let i = 0; i + 3 <= p.length; i++) out.add(p.slice(i, i + 3)); return out; };
// the names sharing the most three-letter pieces with k
function closeNames(L, k, n = 80) {
  const touched = [];
  for (const g of trigrams(k)) for (const i of L.grams.get(g) || []) { if (!L.counts[i]) touched.push(i); L.counts[i]++; }
  const ranked = touched.map(i => [i, L.counts[i]]).sort((a, b) => b[1] - a[1]).slice(0, n).map(([i]) => L.all[i]);
  for (const i of touched) L.counts[i] = 0;
  return ranked;
}

// the card a name means: { name } (found), { name, fixed: true } (read through a typo), or { suggestions } (not found)
export function findCardName(raw, byName) {
  const L = lookupFor(byName);
  const k = normName(raw);
  if (!k) return { suggestions: [] };
  const direct = L.exact.get(k) || L.exact.get(k.split(/\s+\/\/?\s+/)[0]) || L.short.get(k);
  if (direct) return { name: direct };
  const max = typoAllowance(k);
  let best = [];
  const near = [];
  for (const [n, name] of closeNames(L, k)) {
    if (Math.abs(n.length - k.length) > max + 3) continue;
    const d = distance(k, n, max + 3);
    if (d <= max) { if (!best.length || d < best[0].d) best = [{ d, name }]; else if (d === best[0].d) best.push({ d, name }); }
    if (d <= max + 3) near.push({ d, name });
  }
  if (best.length === 1) return { name: best[0].name, fixed: true };
  // nothing close: names that start with what was typed, then the nearest spellings
  const starts = k.length >= 3 ? L.all.filter(([n]) => n.startsWith(k) || n.includes(' ' + k)).map(([, name]) => name).slice(0, 3) : [];
  near.sort((a, b) => a.d - b.d || a.name.localeCompare(b.name));
  return { suggestions: [...new Set([...starts, ...near.map(x => x.name)])].slice(0, 3) };
}

// a heading line ("Creatures (30)", "// Commander", "SIDEBOARD:"): which kind, or null when it isn't one
function heading(line) {
  const t = normName(line.replace(/^(?:\/\/+|#+)\s*/, '').replace(/\s*\(\d+\)\s*$/, '').replace(/\s*:\s*$/, '').replace(/\s*\[\d+\]\s*$/, ''));
  if (COMMANDER_HEAD.test(t)) return 'cmd';
  if (SIDE_HEAD.test(t)) return 'side';
  if (SKIP_HEAD.test(t)) return 'skip';
  if (ABOUT_HEAD.test(t)) return 'about';
  if (DECK_HEAD.test(t)) return 'deck';
  return null;
}

// one card line: { n, name, cmd, side } or null
function cardLine(line) {
  let s = line, side = false;
  if (/^sb:\s*/i.test(s)) { side = true; s = s.replace(/^sb:\s*/i, ''); }
  const cmd = /\*cmdr\*|\(commander\)|\[commander\b[^\]]*\]/i.test(s);
  s = s.replace(/\^[^^]*\^/g, ' ')             // Archidekt color labels
    .replace(/\[[^\]]*\]/g, ' ')                 // Archidekt categories, [SET]
    .replace(/\*[a-z]+\*/gi, ' ')                // *F* (foil), *E* (etched), *CMDR*
    .replace(/\(commander\)/i, ' ')
    .replace(/\s#\S.*$/, ' ')                    // Moxfield tags
    .replace(/\s+/g, ' ').trim();
  let n = 1, m;
  if ((m = /^(\d{1,3})\s*[x×]?\s+(.+)$/i.exec(s))) { n = +m[1]; s = m[2]; }
  else if ((m = /^(.+?)\s+[x×]\s*(\d{1,3})$/i.exec(s))) { n = +m[2]; s = m[1]; }
  // the printing: "(C21) 263", "(PLST) C21-263", "(SLD) 1234★"
  s = s.replace(/\s+\([a-z0-9]{2,6}\)(?:\s+[\w★†-]+)?$/i, '').replace(/\s+\([a-z0-9]{2,6}\)$/i, '').trim();
  if (!s || n <= 0) return null;
  return { n, name: s, cmd, side };
}

// Read a pasted list. Returns { name, commanders, cards: Map, missing: [{ name, n, suggestions }], fixed: [{ from, to }],
// clamped: [names kept to one copy], notCommander: [marked but can't lead], candidates: [cards that could lead],
// guess (the likeliest of those), skipped (sideboard and maybeboard cards left out) }
export function parseDeckText(text, byName) {
  const out = { name: '', commanders: [], cards: new Map(), missing: [], fixed: [], clamped: [], notCommander: [], candidates: [], guess: null, skipped: 0 };
  let section = 'deck';
  const marked = [], side = [], order = [], para = new Map();
  const seenMissing = new Map();
  let p = 0, blank = false, headings = 0;
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line) { blank = true; continue; }
    if (blank) { p++; blank = false; }
    // (a line with no count that ends like "Ramp (10)" or "Lands:" is some other category of the deck)
    const h = !/^\d/.test(line) && !/^sb:/i.test(line) ? heading(line) || (/\(\d+\)$|:$/.test(line) ? 'deck' : null) : null;
    if (h) { section = h; headings++; continue; }
    if (section === 'about') { const m = /^name\s+(.+)$/i.exec(line); if (m && !out.name) out.name = m[1].trim().slice(0, 60); continue; }
    if (/^(?:\/\/|#)/.test(line)) continue;   // a comment
    const c = cardLine(line);
    if (!c) continue;
    const found = findCardName(c.name, byName);
    if (!found.name) {
      if (section === 'skip' || section === 'side' || c.side) continue;
      const k = normName(c.name);
      if (seenMissing.has(k)) seenMissing.get(k).n += c.n;
      else { const e = { name: c.name, n: c.n, suggestions: found.suggestions }; seenMissing.set(k, e); out.missing.push(e); }
      continue;
    }
    if (found.fixed && !out.fixed.some(f => f.to === found.name)) out.fixed.push({ from: c.name, to: found.name });
    if (section === 'skip' && !c.cmd) { out.skipped += c.n; continue; }
    if ((c.side || section === 'side') && !c.cmd) { side.push(found.name); continue; }
    if (section === 'cmd' || c.cmd) marked.push(found.name);
    else { out.cards.set(found.name, (out.cards.get(found.name) || 0) + c.n); order.push(found.name); para.set(found.name, p); }
  }
  // MTGO lists keep the commander as the sideboard's only card or two
  if (!marked.length && side.length && side.length <= 2 && side.every(n => (byName.get(n) || {}).commander)) marked.push(...side);
  else out.skipped += side.length;
  // the commanders: up to two (two need Partner, or a Background...); a marked card that can't lead stays in the deck
  const leadsFirst = [...new Set(marked)].sort((a, b) => !!(byName.get(b) || {}).commander - !!(byName.get(a) || {}).commander);
  for (const n of leadsFirst) {
    const c = byName.get(n);
    const fits = c && (out.commanders.length === 0 ? c.commander : out.commanders.length === 1 && canPair(byName.get(out.commanders[0]), c));
    if (fits) { out.commanders.push(n); out.cards.delete(n); }
    else { if (c && !c.commander && !c.pairing) out.notCommander.push(n); out.cards.set(n, (out.cards.get(n) || 0) + 1); }
  }
  // one copy of each card, except basics and the few cards that say otherwise (any number, or up to N)
  for (const [n, k] of out.cards) { const max = (byName.get(n) || {}).maxCopies || 1; if (k > max) { out.cards.set(n, max); out.clamped.push(n); } }
  // no commander marked: the cards that could be one, those whose colors cover the whole list first (then in list order)
  if (!out.commanders.length) {
    const colors = new Set();
    for (const n of out.cards.keys()) for (const x of (byName.get(n) || { ci: [] }).ci) colors.add(x);
    const covers = n => [...colors].every(x => byName.get(n).ci.includes(x));
    const cands = [...new Set(order)].filter(n => (byName.get(n) || {}).commander);
    out.candidates = [...cands.filter(covers), ...cands.filter(n => !covers(n))].slice(0, 8);
    const coverAll = cands.filter(covers);
    // (a list with no headings that ends in a short paragraph of one or two legends, as MTGO lists do, ends with its commander)
    const last = [...para].filter(([, k]) => k === p).map(([n]) => n);
    const tail = !headings && p > 0 && last.length <= 2 && last.every(n => cands.includes(n)) ? last[0] : null;
    out.guess = tail || (coverAll.length === 1 ? coverAll[0] : coverAll.length && order[0] === coverAll[0] ? coverAll[0] : null);
  }
  return out;
}

export const countCards = cards => [...cards.values()].reduce((a, b) => a + b, 0);

// a deck as text that pastes back into this builder, Moxfield, Archidekt and MTG Arena
export function deckToText(deck) {
  return ['Commander', ...deck.commanders.map(n => `1 ${n}`), '', 'Deck', ...deck.cards.map(([n, k]) => `${k} ${n}`)].join('\n');
}

// ---- a deck in a link (lotusgoats.com/#deck-…): its name and list as JSON, deflated where the platform can, in
// URL-safe base64 ("z…" compressed, "j…" plain). Opening the link shows the deck in the paste dialog to keep.
const b64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64 = str => { const s = atob(str.replace(/-/g, '+').replace(/_/g, '/')); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; };
const through = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
export async function packDeckLink(deck) {
  const bytes = new TextEncoder().encode(JSON.stringify({ n: deck.name || '', c: deck.commanders, l: deck.cards }));
  if (typeof CompressionStream === 'function') { try { return 'z' + b64(await through(bytes, new CompressionStream('deflate-raw'))); } catch { /* plain instead */ } }
  return 'j' + b64(bytes);
}
// -> { name, commanders, cards } or null when it isn't a deck link
export async function unpackDeckLink(str) {
  const s = String(str || '').trim();
  if (!/^[zj][A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    let bytes = unb64(s.slice(1));
    if (s[0] === 'z') bytes = await through(bytes, new DecompressionStream('deflate-raw'));
    const v = JSON.parse(new TextDecoder().decode(bytes));
    if (!v || !Array.isArray(v.c) || !Array.isArray(v.l)) return null;
    const cards = v.l.filter(x => Array.isArray(x) && typeof x[0] === 'string' && x[1] > 0).map(([n, k]) => [n.slice(0, 200), Math.min(99, k | 0)]);
    return { name: String(v.n || '').slice(0, 60), commanders: v.c.filter(n => typeof n === 'string').slice(0, 2), cards: cards.slice(0, 200) };
  } catch { return null; }
}
