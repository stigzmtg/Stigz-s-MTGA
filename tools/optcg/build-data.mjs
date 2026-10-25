// Build the One Piece Card Game data the site uses from the pages fetch-cards.mjs cached:
//   data/optcg/cards.json   every card any deck uses, keyed by card number (official English card list text)
//   data/optcg/decks.json   the starter decks in release order: Leader + the 50 cards with their counts
//   data/optcg/sources.json what every decklist source said for every deck, the fixes made to it, and the result
// Usage: node tools/optcg/build-data.mjs <cache dir>
import fs from 'node:fs';
import path from 'node:path';
import { DECKS, SOURCES, LEADER_CHOICE, BOOSTER_SERIES } from './decklists.mjs';
import { BLURBS } from './blurbs.mjs';

const CACHE = process.argv[2];
if (!CACHE) { console.error('usage: node tools/optcg/build-data.mjs <cache dir>'); process.exit(1); }
const read = f => fs.readFileSync(path.join(CACHE, f), 'utf8');
const has = f => fs.existsSync(path.join(CACHE, f));
const problems = [];
const fail = msg => problems.push(msg);

// ---- text clean-up ----------------------------------------------------------------------------------------------
const decode = s => s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
// one spelling for everything the engine reads: DON!!, ASCII minus and quotes, <Attribute> in plain angle brackets,
// and the DON!! rest cost as the circled digits ①–⑩ (the site mixes two Unicode sets for the same printed symbol)
const clean = s => decode(s.replace(/<br\s*\/?>/gi, '\n'))
  .replace(/‼/g, '!!').replace(/[−–－]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/＜/g, '<').replace(/＞/g, '>')
  .replace(/[➀-➉]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x2780 + 0x2460))
  .replace(/[ \t 　]+/g, ' ').split('\n').map(l => l.trim().replace(/^[-・]\s*/, '• ')).filter(Boolean).join('\n');

// ---- official card lists ----------------------------------------------------------------------------------------
function parseOfficial(html, file) {
  const out = [];
  for (const m of html.matchAll(/<dl class="modalCol" id="([^"]+)">([\s\S]*?)<\/dl>/g)) {
    const b = m[2];
    const info = [...b.match(/<div class="infoCol">([\s\S]*?)<\/div>/)[1].matchAll(/<span>([^<]*)<\/span>/g)].map(x => x[1].trim());
    const field = cls => { const r = b.match(new RegExp(`<div class="${cls}">\\s*<h3>[\\s\\S]*?<\\/h3>([\\s\\S]*?)<\\/div>`)); return r ? r[1].trim() : null; };
    out.push({
      key: m[1], file, id: info[0], rarity: info[1], cat: info[2],
      name: clean(b.match(/<div class="cardName">([\s\S]*?)<\/div>/)[1]),
      costLabel: (b.match(/<div class="cost"><h3>([^<]*)<\/h3>/) || [])[1] || '',
      cost: field('cost'), power: field('power'), counter: field('counter'), color: field('color'),
      attr: [...((b.match(/<div class="attribute">([\s\S]*?)<\/div>/) || [])[1] || '').matchAll(/<i>([^<]*)<\/i>/g)].flatMap(x => x[1].split('/')).map(x => x.trim()).filter(Boolean),
      type: field('feature'), text: field('text'), trigger: field('trigger'), sets: field('getInfo'),
    });
  }
  return out;
}
const official = {}; // id -> every entry (prints) found, starter decks first
const officialFiles = [...DECKS.map(d => `official/en-${d.enSeries}.html`), ...BOOSTER_SERIES.map(s => `official/en-${s}.html`)];
for (const f of officialFiles) {
  if (!has(f)) { fail(`missing ${f}: run fetch-cards.mjs`); continue; }
  for (const e of parseOfficial(read(f), f)) (official[e.id] ||= []).push(e);
}
const productCards = {}; // deck code -> base ids in its official card list
const jpName = {}; // deck code -> id -> Japanese name
for (const d of DECKS) {
  const f = `official/en-${d.enSeries}.html`;
  productCards[d.code] = has(f) ? [...new Set(parseOfficial(read(f), f).map(e => e.id))] : [];
  const j = `official/jp-${d.jpSeries}.html`;
  jpName[d.code] = {};
  if (has(j)) for (const e of parseOfficial(read(j), j)) jpName[d.code][e.id] ||= e.name;
}

// ---- optcgapi (cross-check only) --------------------------------------------------------------------------------
const api = {};
for (const f of ['allSTCards', 'allSetCards', 'allPromos']) for (const r of JSON.parse(read(`optcgapi/${f}.json`))) (api[r.card_set_id] ||= []).push(r);
const apiNormal = id => (api[id] || []).find(r => r.card_image_id === id) || (api[id] || [])[0];

// ---- cards ------------------------------------------------------------------------------------------------------
const CAT = { LEADER: 'L', CHARACTER: 'C', EVENT: 'E', STAGE: 'S' };
const num = v => (v == null || v === '-' || v === '' ? null : Number(v));
const setOf = id => (id.startsWith('P-') ? 'P' : id.replace(/^([A-Z]+)(\d+)-\d+$/, '$1-$2'));
const officialNotes = [];
function buildCard(id) {
  const prints = official[id];
  if (!prints) return null;
  // the normal print is the entry without a suffix (OP09-001, not OP09-001_p2); reprint entries fill in when the
  // normal print's own list wasn't fetched
  // the normal print's entry, except for a field the site left in Japanese there (then the reprints' wording)
  const base = { ...(prints.find(e => e.key === id) || prints[0]) };
  for (const k of ['name', 'type', 'text', 'trigger']) if (/[\u3040-\u30ff\u4e00-\u9fff]/.test(base[k] || '')) {
    const alt = prints.find(e => e[k] && !/[\u3040-\u30ff\u4e00-\u9fff]/.test(e[k]));
    if (alt) { officialNotes.push(`${id}: the normal print's ${k} reads "${clean(base[k])}" (Japanese); used "${clean(alt[k])}" from ${alt.key}`); base[k] = alt[k]; }
  }
  for (const e of prints) for (const k of ['name', 'type', 'text', 'trigger', 'color', 'cost', 'power', 'counter'])
    if (e.key !== base.key && clean(e[k] || '') !== clean(base[k] || '')) officialNotes.push(`${id}: ${e.key} (${e.file.replace(/^official\/|\.html$/g, '')}) has ${k} "${clean(e[k] || '')}"; the normal print has "${clean(base[k] || '')}" (kept)`);
  const cat = CAT[base.cat];
  if (!cat) throw new Error(`${id}: unknown category ${base.cat}`);
  const text = base.text && base.text !== '-' ? clean(base.text) : '';
  const trigger = base.trigger ? clean(base.trigger).replace(/^\[Trigger\]\s*/, '') : null;
  return {
    id, name: base.name, cat,
    colors: base.color.split('/').map(s => s.trim()),
    // the site prints a 0 cost or power as "-"
    cost: cat === 'L' ? null : num(base.cost) ?? 0,
    life: cat === 'L' ? num(base.cost) : null,
    power: cat === 'L' || cat === 'C' ? num(base.power) ?? 0 : null,
    counter: num(base.counter),
    attr: base.attr,
    traits: base.type && base.type !== '-' ? clean(base.type).split('/').map(s => s.trim()).filter(Boolean) : [],
    text, trigger,
    rarity: base.key === id ? base.rarity : (apiNormal(id) && apiNormal(id).rarity) || base.rarity,
    set: setOf(id),
  };
}

// ---- decklists --------------------------------------------------------------------------------------------------
// card names are compared loosely: full-width and half-width alike, hiragana as katakana, no spaces or punctuation
const key = s => (s || '').normalize('NFKC').toLowerCase().replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60))
  .replace(/[\s・.·"'“”‘’&＆!！?？\-ー~〜,、]/g, '');
const bigrams = s => { const k = key(s), out = []; for (let i = 0; i < k.length - 1; i++) out.push(k.slice(i, i + 2)); return out.length ? out : [k]; };
const similar = (a, b) => { const x = bigrams(a), y = bigrams(b); let hit = 0; const pool = [...y]; for (const g of x) { const i = pool.indexOf(g); if (i >= 0) { hit++; pool.splice(i, 1); } } return (2 * hit) / (x.length + y.length); };
const cardCache = {};
const card = id => (id in cardCache ? cardCache[id] : (cardCache[id] = buildCard(id)));
// Match a source's entries to the product's card list. An entry keeps its number when that card is in the product
// and its name agrees; otherwise the name decides: the one product card of that name (several of the same name: the
// next unused one in number order, for sources that list in number order), and as a last resort the only product
// card no other entry took. Every change is logged.
function resolve(src, d, entries) {
  const universe = productCards[d.code];
  const nameOf = (id, lang) => (lang === 'ja' ? jpName[d.code][id] : card(id) && card(id).name) || '';
  const fixes = [], used = new Set(), out = new Array(entries.length);
  // a near miss (a dropped kana, an abbreviation) keeps the number, unless another card in the product has exactly that name
  const fits = e => {
    if (!e.name || key(nameOf(e.id, e.lang)) === key(e.name)) return true;
    if (universe.some(id => id !== e.id && key(nameOf(id, e.lang)) === key(e.name))) return false;
    return key(nameOf(e.id, e.lang)).includes(key(e.name)) || similar(nameOf(e.id, e.lang), e.name) >= 0.6;
  };
  entries.forEach((e, i) => { if (e.id && universe.includes(e.id) && fits(e)) { out[i] = e.id; used.add(e.id); } });
  const open = [];
  entries.forEach((e, i) => {
    if (out[i]) return;
    const want = key(e.name);
    const pick = test => { let c = universe.filter(id => want && test(key(nameOf(id, e.lang)))); if (e.leader != null) c = c.filter(id => (card(id).cat === 'L') === e.leader); return c; };
    let cands = pick(k => k === want);
    if (!cands.length) cands = pick(k => want.length >= 3 && k.includes(want));
    if (cands.length > 1) cands = cands.filter(id => !used.has(id));
    if (cands.length > 1 && e.id) { const same = cands.filter(id => id.split('-')[1] === e.id.split('-')[1]); if (same.length === 1) cands = same; }
    let note = e.id ? `"${e.name}" is listed as ${e.id}: the product's card of that name is ${cands[0]}` : null;
    if (cands.length > 1 && e.ordered) {
      cands = [cands.sort((a, b) => a.localeCompare(b))[0]];
      note = `"${e.name}" (x${e.n}): several cards in the product have that name; the page lists cards in number order, so this row is ${cands[0]}`;
    }
    if (cands.length !== 1) { open.push(i); return; }
    if (note) fixes.push(note.replace(/is \S+$/, `is ${cands[0]}`));
    out[i] = cands[0]; used.add(cands[0]);
  });
  if (open.length) {
    const left = universe.filter(id => !used.has(id));
    if (open.length === 1 && left.length === 1) {
      const e = entries[open[0]];
      fixes.push(`"${e.name}"${e.id ? ` (${e.id})` : ''} matches no card name in the product; it is the only entry left and ${left[0]} (${nameOf(left[0], e.lang)}) the only card left`);
      out[open[0]] = left[0];
    } else {
      for (const i of open) fixes.push(`could not place "${entries[i].name}" (${entries[i].id || 'no number'} x${entries[i].n})`);
      return { fixes, failed: true };
    }
  }
  const merged = new Map();
  entries.forEach((e, i) => merged.set(out[i], (merged.get(out[i]) || 0) + e.n));
  return { fixes, list: [...merged] };
}
const sig = list => list.map(([id, n]) => `${id}x${n}`).sort().join(' ');

const limitlessTitle = d => { const m = read(`limitless/ST${d.n}.html`).match(/<title>([^<]*)<\/title>/); return m ? decode(m[1]).replace(/\s*\(ST\d+\)\s*–\s*Limitless One Piece\s*$/, '').trim() : null; };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function releaseDate(d) {
  const f = `products/${d.product.split('/').pop()}`;
  const t = decode(read(f).replace(/<[^>]+>/g, '\n')).split('\n').map(s => s.trim()).filter(Boolean);
  const i = t.findIndex(s => /^Release Date$/i.test(s));
  const m = i >= 0 && t[i + 1].match(/^([A-Za-z]+)\.?\s+(\d+),\s*(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}
function limitlessDate(d) {
  const m = read(`limitless/ST${d.n}.html`).replace(/<[^>]+>/g, ' ').match(/(\d+)(?:st|nd|rd|th) ([A-Z][a-z]+) (20\d\d)/);
  return m ? `${m[3]}-${String(MONTHS.indexOf(m[2].toLowerCase()) + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

const CAT_ORDER = { L: 0, C: 1, E: 2, S: 3 };
const decks = [], record = {};
for (const d of DECKS) {
  const rec = record[d.code] = { product: d.product, cardList: `https://en.onepiece-cardgame.com/cardlist/?series=${d.enSeries}`, sources: [] };
  for (const s of SOURCES) {
    if (s.only && !s.only(d)) continue;
    const f = s.file(d);
    const entry = { source: s.key, name: s.name, url: s.url(d) };
    rec.sources.push(entry);
    if (!has(f)) { entry.status = 'not fetched'; continue; }
    let parsed;
    try { parsed = s.parse(read(f), d); } catch (e) { entry.status = 'unreadable: ' + e.message; continue; }
    if (!parsed) { entry.status = 'no list on the page'; continue; }
    const r = resolve(s, d, parsed);
    if (r.fixes.length) entry.fixes = r.fixes;
    if (r.failed) { entry.status = 'unusable'; continue; }
    entry.leaders = r.list.filter(([id]) => card(id).cat === 'L').map(([id]) => id);
    entry.cards = r.list.filter(([id]) => card(id).cat !== 'L');
    entry.total = entry.cards.reduce((a, [, n]) => a + n, 0);
    // a partial list next to the full one (the text of a post whose photo gave the full list): every card it names
    // must have the same count
    if (parsed.partial) {
      const counts = new Map(r.list), seen = [];
      for (const e of parsed.partial) {
        const one = resolve(s, d, [e]);
        if (one.failed) { (entry.textNotChecked ||= []).push(`x${e.n} ${e.name}`); continue; }
        const [[id, n]] = one.list;
        if (counts.get(id) !== n) { entry.status = `the post's text lists ${e.name} (${id}) x${n}, the photo shows x${counts.get(id)}`; break; }
        seen.push(id);
      }
      if (entry.status) { delete entry.cards; continue; }
      entry.textAgrees = `the post's text names ${seen.length} of these cards, all with the same counts`;
    }
  }
  const listed = rec.sources.filter(s => s.cards);
  const groups = new Map();
  // (an Ultra Deck's sources may name one or all three of its Leaders: only the 50 cards count there)
  for (const s of listed) { const k = sig(s.cards) + (LEADER_CHOICE[d.code] ? '' : ' | ' + s.leaders.join(' ')); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
  const productLeaders = productCards[d.code].filter(id => card(id) && card(id).cat === 'L');
  // the list at least two sources give, unless another list also has two
  const ranked = [...groups.values()].sort((a, b) => b.length - a.length);
  const ok = ranked.length && ranked[0].length >= 2 && !(ranked[1] && ranked[1].length >= 2);
  const agreeing = ok ? ranked[0] : [];
  for (const s of listed) {
    s.agrees = agreeing.includes(s);
    if (!s.agrees && agreeing.length) {
      const a = new Map(agreeing[0].cards), b = new Map(s.cards);
      s.differs = [...new Set([...a.keys(), ...b.keys()])].filter(id => a.get(id) !== b.get(id)).map(id => `${id} x${b.get(id) || 0} (the others: x${a.get(id) || 0})`);
      if (!LEADER_CHOICE[d.code] && agreeing[0].leaders.join() !== s.leaders.join()) s.differs.push(`Leader ${s.leaders.join(', ') || 'none'} (the others: ${agreeing[0].leaders.join(', ')})`);
    }
  }
  const leaders = [...new Set(agreeing.flatMap(s => s.leaders))];
  const leader = LEADER_CHOICE[d.code] || (leaders.length === 1 ? leaders[0] : null);
  rec.leader = leader;
  if (LEADER_CHOICE[d.code]) rec.leaderNote = `the product holds ${productLeaders.length} Leaders (${productLeaders.join(', ')}), all legal with these 50 cards; we play ${leader}`;
  if (!ok || !leader || (LEADER_CHOICE[d.code] && !leaders.includes(leader))) {
    rec.status = !ok ? (groups.size > 1 ? 'sources disagree' : `only ${agreeing.length || listed.length} source${listed.length === 1 ? '' : 's'} with a list`) : 'no single Leader';
    fail(`${d.code}: ${rec.status}${groups.size > 1 ? ':\n    ' + [...groups].map(([k, v]) => `${v.map(s => s.source).join('+')}: ${k}`).join('\n    ') : ''}`);
    continue;
  }
  if (!productLeaders.includes(leader)) fail(`${d.code}: leader ${leader} is not in the product's card list`);
  const cards = agreeing[0].cards.slice().sort(([a], [b]) => CAT_ORDER[card(a).cat] - CAT_ORDER[card(b).cat] || (card(a).cost ?? 0) - (card(b).cost ?? 0) || a.localeCompare(b));
  const dissent = listed.filter(s => !s.agrees);
  rec.status = `${agreeing.length} sources agree` + (dissent.length ? `; ${dissent.map(s => s.source).join(', ')} differ${dissent.length === 1 ? 's' : ''}` : '');
  rec.cards = cards;
  const released = releaseDate(d), lim = limitlessDate(d);
  if (!released) fail(`${d.code}: no release date on ${d.product}`);
  if (lim && released && lim !== released) rec.dateNote = `Limitless gives ${lim}, the official product page ${released} (used)`;
  const blurb = BLURBS[d.code];
  if (!blurb) fail(`${d.code}: no blurb`);
  decks.push({
    id: d.id, code: d.code, name: limitlessTitle(d), leader, colors: card(leader).colors, cards, released,
    blurb: blurb ? blurb.blurb : '', featured: (blurb && blurb.featured) || leader,
  });
}
decks.sort((a, b) => a.released.localeCompare(b.released) || a.code.localeCompare(b.code));

// every card the decks use, in deck order
const cards = {};
for (const d of decks) for (const id of [d.leader, ...d.cards.map(([id]) => id)]) {
  const c = card(id);
  if (!c) { fail(`${d.code}: ${id} has no official card list entry`); continue; }
  cards[id] = c;
}

// ---- optcgapi cross-check: report every card whose effect, trigger, name or numbers differ --------------------
// formatting doesn't count: (3) for the circled 3, "Navy" or [Navy] for {Navy}, "Slash" or (Slash) for <Slash>,
// bullets, spacing, case, "NULL", and
// the minus signs optcgapi drops ("give … 2000 power" for "-2000")
const loose = s => (s == null || s === 'NULL' ? '' : s).replace(/[①-⑩]/g, c => `(${c.charCodeAt(0) - 0x245f})`).replace(/[➀-➉]/g, c => `(${c.charCodeAt(0) - 0x277f})`)
  .normalize('NFKC').replace(/[−–-](?=\d)/g, '').replace(/[‘’]/g, "'").replace(/[“”"{}]/g, '').replace(/(^|\n|\s)[-•・](?=\s)/g, '$1')
  .replace(/\[([^\]]*)\]/g, '$1').replace(/[\s.,:;<>()]+/g, '').toLowerCase();
const apiDiffs = [];
for (const c of Object.values(cards)) {
  const r = apiNormal(c.id);
  if (!r) { apiDiffs.push(`${c.id}: not in optcgapi`); continue; }
  const raw = clean(r.card_text && r.card_text !== 'NULL' ? r.card_text : '').replace(/\s*This card has been officially errata'd\.?/i, '');
  // optcgapi runs the trigger into the text: the last "[Trigger]" that starts a sentence (not "a card with a [Trigger]")
  const at = Math.max(-1, ...[...raw.matchAll(/(^|[.)!\n]\s*)\[Trigger\]\s/g)].map(m => m.index + m[1].length));
  const apiText = at >= 0 ? raw.slice(0, at) : raw, apiTrig = at >= 0 ? raw.slice(at + 9).trim() : null;
  const d = [];
  if (loose(apiText) !== loose(c.text)) d.push(`text\n      official: ${c.text || '(none)'}\n      optcgapi: ${apiText.trim() || '(none)'}`);
  if (loose(apiTrig) !== loose(c.trigger)) d.push(`trigger\n      official: ${c.trigger || '(none)'}\n      optcgapi: ${apiTrig || '(none)'}`);
  // (optcgapi adds print notes to names: "(001)", "(ST15-002)", " - OP14-015", "(OP10 Release Event)", "[Winner]")
  const apiName = clean(r.card_name).replace(/\s*\[[^\]]*\]$/, '').replace(/\s+-\s+[A-Z]+\d*-\d{3}$/, '')
    .replace(/(\s*\((\d{3}|[A-Z]+\d*-\d{3}|Reprint|Parallel|[^)]*(Ver|Pack|Edition|Promo|Collection|Set|Deck|Event|Battle|Regional|Vol)[^)]*)\))+$/i, '');
  if (loose(apiName) !== loose(c.name)) d.push(`name: official "${c.name}", optcgapi "${apiName}"`);
  for (const [k, v] of [['cost', c.cat === 'L' ? null : c.cost], ['power', c.power], ['life', c.life]]) {
    let av = num(r[k === 'cost' ? 'card_cost' : k === 'power' ? 'card_power' : 'life']);
    if (Number.isNaN(av) || (av === null && v === 0)) av = v === 0 ? 0 : null;
    if (av !== v && !(k === 'cost' && av === null)) d.push(`${k}: official ${v}, optcgapi ${av}`);
  }
  const apiColors = (r.card_color || '').split(/[\s/]+/).filter(Boolean).sort().join('/');
  if (apiColors !== c.colors.slice().sort().join('/')) d.push(`colors: official ${c.colors.join('/')}, optcgapi ${apiColors}`);
  const apiCounter = num(r.counter_amount) || null;
  if (c.cat === 'C' && apiCounter !== c.counter) d.push(`counter: official ${c.counter}, optcgapi ${apiCounter}`);
  if (d.length) apiDiffs.push(`${c.id} ${c.name}: ${d.join('\n    ')}`);
}

fs.mkdirSync('data/optcg', { recursive: true });
fs.writeFileSync('data/optcg/cards.json', JSON.stringify(cards));
fs.writeFileSync('data/optcg/decks.json', JSON.stringify(decks));
fs.writeFileSync('data/optcg/sources.json', JSON.stringify({
  about: 'How each starter deck list was confirmed: every source that has the deck, what it lists after matching card numbers to the product\'s official card list (fixes), and whether it agrees. A deck is used only when at least two sources give the same 50 cards.',
  decks: record,
  officialEntryConflicts: officialNotes,
}, null, 1));
if (process.argv.includes('--diffs')) console.log(`optcgapi differences (${apiDiffs.length}):\n  ` + apiDiffs.join('\n  '));
console.log(`${decks.length} decks, ${Object.keys(cards).length} cards; ${apiDiffs.length} cards read differently on optcgapi (--diffs lists them); ${officialNotes.length} official entry conflicts`);
for (const d of DECKS) { const r = record[d.code]; console.log(`  ${d.code} ${r.status}: ${r.sources.map(s => `${s.source}${s.cards ? (s.agrees ? '=' : '≠') + s.total : ' (' + s.status + ')'}`).join(', ')}`); }
for (const d of DECKS) for (const s of record[d.code].sources) if (s.differs) console.log(`  ${d.code} ${s.source} differs: ${s.differs.join(', ')}`);
if (problems.length) { console.error('PROBLEMS:\n  ' + problems.join('\n  ')); process.exitCode = 1; }
