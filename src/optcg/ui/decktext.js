// One Piece decklists as text: reading a pasted list, and writing one out. Lists come from the simulators and deck
// sites (OPTCGSim, Egman Events, Limitless) or are typed by hand, so a card line can look like any of
//   4xOP01-016 · 4 x OP01-016 · 4 OP01-016 · 4 Nami (OP01-016) · 4 Nami [OP01-016] · 4 OP01-016 Nami · Nami OP01-016 x4 · 4 Nami
// and the Leader is its "1xST01-001" line, a card under a "Leader" heading or after "Leader:", or (a list of names) the
// first line when it names a Leader. Card numbers are read however they're written (op01-16, OP1-016, OP01-016_p1 for
// a parallel art). Names match whatever their capitals and dots ("Monkey D. Luffy" is Monkey.D.Luffy), a near miss
// ("Nmai") is read as the name it's closest to, and a name several cards share (the game has six Namis) is narrowed
// down by the Leader's colors and the other cards in the list; when that still leaves more than one, the reader asks.
// Cards the game doesn't have come back with suggestions. Pure functions: tools/optcg/decktext.mjs tests them.

export const MAX_COPIES = 4, DECK_SIZE = 50, NAME_MAX = 60;

// the form names are compared in: lower case, no accents, "&" as "and", punctuation as spaces
export const normName = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// a card number in its printed form: "op1-16" -> OP01-016, "P-1" -> P-001; null when it isn't one
export function normNumber(s) {
  const m = /^([a-z]{1,4})(\d{1,2})?\s*-?\s*(\d{1,3})$/i.exec(String(s || '').trim());
  // (without the dash only in full: OP01016)
  if (!m || (!/-/.test(s) && !(m[2] && m[2].length === 2 && m[3].length === 3))) return null;
  return `${m[1].toUpperCase()}${m[2] ? m[2].padStart(2, '0') : ''}-${m[3].padStart(3, '0')}`;
}
// a number inside a line, with what's around it: a parallel art's mark ("_p1", "-P2", "_r1") belongs to it
const NUMBER_IN = /(^|[^a-z0-9])([a-z]{1,4}\d{0,2}-\d{1,3})(?:[_-]?(?:p|r|sp|aa)\d{0,2})?(?=$|[^a-z0-9])/i;

// headings: where the cards under them go
const LEADER_HEAD = /^(?:leaders?)$/;
const DECK_HEAD = /^(?:deck|decklist|deck list|main|main deck|maindeck|cards|characters?|events?|stages?|the 50)$/;
const SKIP_HEAD = /^(?:don|don deck|side ?deck|side ?board|sb|maybe|maybe ?board|considering|tokens?|extras?)$/;
function heading(line) {
  const t = normName(line.replace(/^(?:\/\/+|#+)\s*/, '').replace(/\s*[([]\s*\d+\s*[)\]]\s*$/, '').replace(/\s*:?\s*\d*\s*$/, ''));
  if (!t) return null;
  if (LEADER_HEAD.test(t)) return 'leader';
  if (DECK_HEAD.test(t)) return 'deck';
  if (SKIP_HEAD.test(t)) return 'skip';
  return null;
}

// one card line: { n, number, name } (either may be missing), or null for a line that holds no card
function cardLine(line) {
  let s = line.replace(/\s+/g, ' ').trim();
  let n = null, m;
  // (an "x" after the count only when a space or a card number follows: "4 X.Drake" is four X.Drakes)
  if ((m = /^(\d{1,2})(?![\d-])\s*(?:[x×*](?=\s|[a-z]{1,4}\d{0,2}-\d))?\s*(.+)$/i.exec(s))) { n = +m[1]; s = m[2]; }
  else if ((m = /^(.+?)\s*[x×*]\s*(\d{1,2})$/i.exec(s))) { n = +m[2]; s = m[1]; }
  else if ((m = /^(.+?)\s+\((\d{1,2})\)$/.exec(s))) { n = +m[2]; s = m[1]; }
  let number = null, name = s;
  if ((m = NUMBER_IN.exec(s))) {
    number = normNumber(m[2]);
    if (number) name = (s.slice(0, m.index) + m[1] + ' ' + s.slice(m.index + m[0].length)).replace(/[([]\s*[)\]]/g, ' ');
  }
  name = name.replace(/^[\s\-–—:|,·]+|[\s\-–—:|,·]+$/g, '').trim();
  if (!number && !normName(name)) return null;
  if (n === 0) return null;
  return { n: Math.min(DECK_SIZE, n || 1), counted: n != null, number, name };
}

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
// how far off a name may be and still count as a typo of one name
const typoAllowance = n => (n.length <= 3 ? 0 : n.length <= 6 ? 1 : n.length <= 14 ? 2 : 3);

// the names of a card pool, made once per pool: name -> card numbers (printings of the same name are different cards)
const indexes = new WeakMap();
export function nameIndex(cards) {
  let ix = indexes.get(cards);
  if (ix) return ix;
  ix = new Map();
  for (const c of Object.values(cards)) { const k = normName(c.name); if (!ix.has(k)) ix.set(k, { name: c.name, ids: [] }); ix.get(k).ids.push(c.id); }
  indexes.set(cards, ix);
  return ix;
}

// the names a typed name means: { keys: [key] } (found), { keys, fixed: true } (read through a typo, or a short form:
// "Zoro" is Roronoa Zoro, or Zoro-Juurou), or { keys: [], near: [keys] } (nothing close enough)
export function findName(raw, cards) {
  const ix = nameIndex(cards);
  const k = normName(raw);
  if (!k) return { keys: [], near: [] };
  if (ix.has(k)) return { keys: [k] };
  // "Nami (Parallel)", "Nami [Alt art]": the name without what's in brackets
  const bare = String(raw).replace(/\s*[([][^)\]]*[)\]]/g, ' ').trim();
  if (bare && bare !== String(raw).trim() && normName(bare)) { const f = findName(bare, cards); if (f.keys.length) return f; }
  // a short form: the names it's a part of (a word or more, not much longer)
  const words = ` ${k} `, len = k.split(' ').length;
  const part = [...ix.keys()].filter(n => ` ${n} `.includes(words) && n.split(' ').length <= len + 2);
  if (part.length && part.length <= 3) return { keys: part, fixed: true };
  const max = typoAllowance(k);
  let best = [];
  const near = [];
  for (const n of ix.keys()) {
    const d = distance(k, n, max + 3);
    if (d <= max) { if (!best.length || d < best[0].d) best = [{ d, n }]; else if (d === best[0].d) best.push({ d, n }); }
    if (d <= max + 3) near.push({ d, n });
  }
  if (best.length && best.length <= 2) return { keys: best.map(b => b.n), fixed: true };
  near.sort((a, b) => a.d - b.d || a.n.localeCompare(b.n));
  return { keys: [], near: [...new Set([...part, ...near.map(x => x.n)])].slice(0, 4) };
}

const sharesColor = (c, colors) => !!c && (!colors || !colors.length || c.colors.some(x => colors.includes(x)));
// card numbers in the order a person would look for them: by set, then number
const byNumber = (a, b) => a.localeCompare(b, 'en', { numeric: true });

// Read a pasted list. cards: data/optcg/cards.json. ctx: { leader } (the deck's Leader now, when the list has none)
// and { prefer } (when adding to a deck: its cards, a Map of number -> copies; a shared name means one of those first,
// if the copies still fit).
// Returns { name, leader, leaderOptions, extraLeaders, cards: Map(number -> n), ambiguous: [{ key, label, n, options }],
// missing: [{ label, n, suggestions }], fixed: [{ from, to }], clamped: [numbers], leadersOut: [numbers], skipped }
export function parseDeckList(text, cards, ctx = {}) {
  const out = { name: '', leader: null, leaderOptions: [], extraLeaders: [], cards: new Map(), ambiguous: [], missing: [], fixed: [], clamped: [], leadersOut: [], skipped: 0 };
  const ix = nameIndex(cards);
  // 1. the lines: card entries, each in its section
  const entries = [];
  let section = 'deck', first = true;
  for (let raw of String(text || '').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    let m;
    if ((m = /^(?:deck ?name|name|title)\s*[:=-]\s*(.+)$/i.exec(line))) { if (!out.name) out.name = m[1].trim().slice(0, NAME_MAX); continue; }
    if (/^(?:\/\/|#)/.test(line) && !heading(line)) continue;              // a comment
    if (/\bDON!!?(?:\s*cards?)?\s*(?:x\s*\d+)?$/i.test(line) && !NUMBER_IN.test(line)) { out.skipped++; continue; }   // "10 DON!!": every deck brings its own
    if (/^(?:total|cards|count)\s*[:=]?\s*\d+$/i.test(line) || /^\d+$/.test(line) || /^https?:\/\//i.test(line)) continue;
    const h = !/^\d/.test(line) ? heading(line) : null;
    if (h) { section = h; continue; }
    let lead = section === 'leader';
    if ((m = /^leader\s*[:=-]\s*(.+)$/i.exec(line))) { lead = true; line = m[1]; }
    const c = cardLine(line);
    if (!c) continue;
    if (section === 'skip') { out.skipped += c.n; continue; }
    // (a list's first line, uncounted, that isn't a card: the deck's name)
    if (first && !c.counted && !c.number && !lead && !out.name && !findName(c.name, cards).keys.length) { out.name = c.name.slice(0, NAME_MAX); continue; }
    entries.push({ ...c, lead, first, label: line });
    first = false;
  }
  // 2. card numbers: the cards themselves
  for (const e of entries) {
    if (!e.number) continue;
    const c = cards[e.number];
    if (c) { e.id = c.id; continue; }
    // a number the game doesn't have: its name (or the line) is what's shown, with cards of that name as suggestions
    const f = e.name ? findName(e.name, cards) : { keys: [], near: [] };
    e.gone = { label: e.name ? `${e.name} (${e.number})` : e.number, names: f.keys.length ? f.keys : f.near };
  }
  // the cards a name means, other than Leaders (the printings of every name it could be)
  const printings = keys => keys.flatMap(k => ix.get(k).ids).filter(id => cards[id].cat !== 'L');
  for (const e of entries) if (!e.number) e.found = findName(e.name, cards);
  // 3. the Leader: the first Leader card in the list; a list of names marks it with a heading, "Leader:", or as its first line
  for (const e of entries.filter(x => x.id && cards[x.id].cat === 'L')) {
    if (!out.leader) out.leader = e.id; else if (e.id !== out.leader && !out.extraLeaders.includes(e.id)) out.extraLeaders.push(e.id);
    e.done = true;
  }
  if (!out.leader) {
    const e = entries.find(x => x.found && x.found.keys.length && (x.lead || (x.first && x.n === 1)));
    const leaders = e ? e.found.keys.flatMap(k => ix.get(k).ids).filter(id => cards[id].cat === 'L') : [];
    if (leaders.length) {
      e.done = true;
      if (e.found.fixed) out.fixed.push({ from: e.name, to: cards[leaders[0]].name });
      // several Leaders with this name: the one whose colors the most cards in the list share (cards by number, and
      // names only one card has)
      const one = x => { const ids = x.found ? printings(x.found.keys) : []; return ids.length === 1 ? ids[0] : null; };
      const known = entries.filter(x => !x.done).map(x => x.id || one(x)).filter(Boolean).map(id => cards[id]);
      const fit = id => known.filter(c => sharesColor(c, cards[id].colors)).length;
      const best = Math.max(...leaders.map(fit));
      const top = leaders.filter(id => fit(id) === best);
      if (top.length === 1) out.leader = top[0]; else out.leaderOptions = top.sort(byNumber);
    }
  }
  // (the Leader still to be picked from a few: the colors any of them has)
  const colors = out.leader ? cards[out.leader].colors : out.leaderOptions.length ? [...new Set(out.leaderOptions.flatMap(id => cards[id].colors))]
    : ctx.leader && cards[ctx.leader] ? cards[ctx.leader].colors : null;
  // 4. names: the printing that fits (not a Leader, the Leader's colors, a number already in the list or the deck), else ask
  // (a number the list already has 4 of isn't what another line with its name means)
  const listed = new Map();
  for (const e of entries) if (e.id) listed.set(e.id, (listed.get(e.id) || 0) + e.n);
  // (ctx.prefer: the deck's cards, as a Map of how many it has, or a Set)
  const had = id => (!ctx.prefer ? 0 : ctx.prefer instanceof Map ? ctx.prefer.get(id) || 0 : ctx.prefer.has(id) ? 1 : 0);
  const asked = new Map();
  for (const e of entries) {
    if (e.done || e.id || e.gone) continue;
    const f = e.found;
    if (!f.keys.length) { e.gone = { label: e.name, names: f.near }; continue; }
    const shown = f.keys.length === 1 ? ix.get(f.keys[0]).name : e.name;
    if (f.fixed && f.keys.length === 1 && !out.fixed.some(x => x.from === e.name)) out.fixed.push({ from: e.name, to: shown });
    let ids = printings(f.keys);
    if (!ids.length) { const l = ix.get(f.keys[0]).ids[0]; if (!out.leadersOut.includes(l)) out.leadersOut.push(l); continue; }
    const fits = ids.filter(id => sharesColor(cards[id], colors));
    if (fits.length) ids = fits;
    const prefer = id => (listed.has(id) || had(id) > 0) && (listed.get(id) || 0) + had(id) + e.n <= MAX_COPIES;
    if (ids.length > 1 && ids.filter(prefer).length === 1) ids = ids.filter(prefer);
    if (ids.length === 1) { e.id = ids[0]; continue; }
    // still several: ask once per name, adding up its lines
    const key = f.keys.join('|');
    const a = asked.get(key);
    if (a) a.n += e.n; else { const q = { key, label: shown, n: e.n, options: ids.sort(byNumber).slice(0, 12) }; asked.set(key, q); out.ambiguous.push(q); }
  }
  // 5. the 50: Leaders can't be in them; up to 4 of each card number
  for (const e of entries) {
    if (e.done || !e.id) continue;
    if (cards[e.id].cat === 'L') { if (!out.leadersOut.includes(e.id)) out.leadersOut.push(e.id); continue; }
    out.cards.set(e.id, (out.cards.get(e.id) || 0) + e.n);
  }
  for (const [id, n] of out.cards) if (n > MAX_COPIES) { out.cards.set(id, MAX_COPIES); out.clamped.push(id); }
  // cards the game doesn't have: suggestions are the cards of the nearest names, in the Leader's colors first
  const gone = new Map();
  for (const e of entries) {
    if (!e.gone) continue;
    const k = e.gone.label.toLowerCase();
    if (gone.has(k)) { gone.get(k).n += e.n; continue; }
    const ids = printings(e.gone.names);
    const suggestions = [...ids.filter(id => sharesColor(cards[id], colors)), ...ids.filter(id => !sharesColor(cards[id], colors))].slice(0, 4);
    const m = { label: e.gone.label, n: e.n, suggestions };
    gone.set(k, m);
    out.missing.push(m);
  }
  return out;
}

// the list once the person has answered: which card each shared name means (picks: key -> number or 'none'), and the
// cards used instead of missing ones (swaps: label -> number). Returns { leader, cards: Map } with at most 4 of each.
export function resolveList(parsed, { picks = new Map(), swaps = new Map(), leader = null } = {}) {
  const cards = new Map(parsed.cards);
  const add = (id, n) => { if (id && id !== 'none') cards.set(id, Math.min(MAX_COPIES, (cards.get(id) || 0) + n)); };
  for (const a of parsed.ambiguous) add(picks.get(a.key), a.n);
  for (const m of parsed.missing) add(swaps.get(m.label), m.n);
  return { leader: parsed.leader || leader || null, cards };
}

export const countCards = cards => [...cards.values()].reduce((a, b) => a + b, 0);

// a deck as text that pastes into OPTCGSim, Egman Events and back into this builder: the Leader first, then the 50
// by cost (cards: the card pool, to sort by cost)
export function deckToText(deck, cards = null) {
  const cost = id => (cards && cards[id] && cards[id].cost) || 0;
  const list = deck.cards.slice().sort((a, b) => cost(a[0]) - cost(b[0]) || byNumber(a[0], b[0]));
  return [...(deck.leader ? [`1x${deck.leader}`] : []), ...list.map(([id, n]) => `${n}x${id}`)].join('\n');
}
