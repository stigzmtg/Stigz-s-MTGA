// Every Magic card the engine can play: each card Forge has a rules script for that's legal (or banned) in Commander,
// according to Scryfall. Run after tools/build-data.mjs (which writes the precons' cards) and tools/fetch-decks.mjs.
//  - data/cards.json       the cards loaded with the page: the precons', the community decks' and the cards those
//                          cards can conjure by name (so a game never needs a card one player's page hasn't loaded)
//  - data/more/cards-N.json the rest, in pieces of a few MB, loaded when the deck builder opens or a deck needs them
//  - data/more.json        how many pieces there are
//  - data/cardmeta.json    for every card: its Scryfall picture id (with a back face or not), its EDHREC rank (how
//                          many decks play it) and whether it's banned in Commander
//  - data/community.json   the community decks that are complete, legal and fully scripted, with credit
// Usage: node tools/build-allcards.mjs [forge-res-dir] [scryfall oracle-cards .jsonl.gz]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { compactScript, parseCardScript, normName } from '../src/engine/forge.js';
import { buildIndex, deckProblems, canPair, BASICS } from '../src/ui/customdecks.js';

const SCRATCH = '/tmp/claude-0/-home-user/c7951bb0-2eab-52cb-96d1-4ea2a7466e6c/scratchpad/dl';
const FORGE_RES = process.argv[2] || path.join(SCRATCH, 'forge/forge-gui/res');
const ORACLE = process.argv[3] || path.join(SCRATCH, 'scryfall/oracle.jsonl.gz');
const SHARD_BYTES = 3.5e6;
const EDHREC_DECKS = 24, ARCHIDEKT_DECKS = 16;

const walk = (dir, out = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.txt')) out.push(p); } return out; };

// ---- Forge: every card script, by name (its first face, and "Front // Back" for split and double-faced cards)
const forge = new Map();     // normName -> canonical name
const scripts = {};          // canonical name -> compact script
for (const file of walk(path.join(FORGE_RES, 'cardsfolder'))) {
  const text = fs.readFileSync(file, 'utf8');
  const parsed = parseCardScript(text);
  const names = parsed.faces.map(f => f.name).filter(Boolean);
  if (!names.length) continue;
  const canon = names[0];
  if (scripts[canon]) continue;
  scripts[canon] = compactScript(text);
  for (const n of [canon, names.join(' // ')]) { const k = normName(n); if (!forge.has(k)) forge.set(k, canon); }
}
const forgeName = n => forge.get(normName(n)) || forge.get(normName(n.split(' // ')[0])) || null;
console.log('forge scripts:', Object.keys(scripts).length);

// ---- Scryfall: Commander legality, pictures and EDHREC rank
const sf = new Map();        // canonical (Forge) name -> { legal, banned, img, rank }
const lines = zlib.gunzipSync(fs.readFileSync(ORACLE)).toString('utf8').split('\n');
for (const line of lines) {
  if (!line.trim()) continue;
  const c = JSON.parse(line);
  if (['token', 'double_faced_token', 'emblem', 'art_series', 'planar', 'scheme', 'vanguard'].includes(c.layout)) continue;
  const canon = forgeName(c.name);
  if (!canon) continue;
  const legality = c.legalities && c.legalities.commander;
  const back = Array.isArray(c.card_faces) && c.card_faces.length > 1 && c.card_faces[1].image_uris ? 'b' : '';
  const img = c.image_status !== 'missing' && (c.image_uris || (c.card_faces && c.card_faces[0].image_uris)) ? c.id + back : '';
  const prev = sf.get(canon);
  // (the paper card wins over a digital-only one of the same name)
  if (prev && prev.legal && legality !== 'legal' && legality !== 'banned') continue;
  sf.set(canon, { legal: legality === 'legal' || legality === 'banned', banned: legality === 'banned', img, rank: c.edhrec_rank || 0 });
}
console.log('matched on Scryfall:', sf.size);

// ---- the precons' cards (data/decks.json, from tools/build-data.mjs)
const decks = JSON.parse(fs.readFileSync('data/decks.json', 'utf8'));
const preconNames = new Set();
for (const d of decks) for (const n of [...d.commanders, ...d.cards.map(([x]) => x)]) preconNames.add(n);
const missingPrecon = [...preconNames].filter(n => !scripts[n]);
if (missingPrecon.length) console.log('precon cards without a script (left as they were):', missingPrecon.join(', '));

// ---- every card in the pool: Commander-legal (or banned) on Scryfall, plus anything a precon plays
const pool = new Set([...preconNames].filter(n => scripts[n]));
let notLegal = 0;
// (ante cards can't be played: there's no ante)
for (const n of Object.keys(scripts)) { const s = sf.get(n); if (s && s.legal && !/playing for ante/i.test(scripts[n])) pool.add(n); else if (!pool.has(n)) notLegal++; }
console.log('pool:', pool.size, '| left out (not Commander cards: Alchemy, Un-sets, schemes, planes, ...):', notLegal);

// ---- community decks: complete, legal and fully scripted ones only
const index = buildIndex(Object.fromEntries([...pool].map(n => [n, scripts[n]])));
const byName = new Map(index.map(c => [c.name, c]));
const raw = fs.existsSync('data/sources/community-raw.json') ? JSON.parse(fs.readFileSync('data/sources/community-raw.json', 'utf8')).decks : [];
const community = [];
const kept = { EDHREC: 0, Archidekt: 0 };
const want = { EDHREC: EDHREC_DECKS, Archidekt: ARCHIDEKT_DECKS };
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
for (const d of raw) {
  if (kept[d.source] >= want[d.source]) continue;
  // (copies of official precons are already in the game; joke decks don't play)
  if (d.source === 'Archidekt' && (/precon/i.test(d.author || '') || /all lands/i.test(d.name))) continue;
  const why = [];
  const cmds = d.commanders.map(n => forgeName(n) || (why.push(`no script: ${n}`), null)).filter(Boolean);
  const cards = new Map();
  for (const [n, k] of d.cards) {
    const c = forgeName(n);
    if (!c) { why.push(`no script: ${n}`); continue; }
    if (cmds.includes(c)) continue;
    cards.set(c, (cards.get(c) || 0) + k);
  }
  for (const n of [...cmds, ...cards.keys()]) { if (!pool.has(n)) why.push(`not a Commander card: ${n}`); else if ((sf.get(n) || {}).banned) why.push(`banned: ${n}`); }
  const identity = [...new Set(cmds.flatMap(n => (byName.get(n) || { ci: [] }).ci))];
  if (!why.length) {
    const deck = { commanders: cmds, cards: [...cards] };
    why.push(...deckProblems(deck, byName, identity));
    if (!cmds.every(n => (byName.get(n) || {}).commander || (cmds.length === 2 && canPair(byName.get(cmds[0]), byName.get(cmds[1]))))) why.push('commander can’t lead');
  }
  if (why.length) { console.log(`dropped ${d.source} ${d.name}: ${why.slice(0, 3).join('; ')}`); continue; }
  kept[d.source]++;
  const name = d.source === 'EDHREC' ? `${d.name}: the EDHREC average deck` : `${d.name}`;
  community.push({
    id: `community-${d.source.toLowerCase()}-${slug(d.key)}`.slice(0, 80), name, set: d.source === 'EDHREC' ? 'EDHREC' : 'ARCHIDEKT',
    setName: d.source === 'EDHREC' ? 'EDHREC average decks' : 'Popular on Archidekt', community: true, source: d.source,
    author: d.author || null, url: d.url, commanders: cmds, cards: [...cards].sort((a, b) => a[0].localeCompare(b[0])), total: 100,
    // the commander's picture on Scryfall, for the deck list (these decks have no picture packs)
    art: cmds.map(n => (sf.get(n) || {}).img || '').filter(Boolean),
  });
}
console.log(`community decks: ${community.length} (EDHREC ${kept.EDHREC}, Archidekt ${kept.Archidekt})`);

// ---- what loads with the page: precons, community decks, and the cards their cards make by name
const base = new Set([...preconNames].filter(n => scripts[n]));
for (const d of community) for (const n of [...d.commanders, ...d.cards.map(([x]) => x)]) base.add(n);
const conjured = s => {
  const out = [];
  for (const line of s.split('\n')) {
    if (!/MakeCard|Conjure|ChangeZone.*Defined\$ NamedCard/.test(line)) continue;
    for (const m of line.matchAll(/\b(?:Name|Names|Spellbook)\$ ([^|]+)/g)) for (const n of m[1].split(/,(?! )/)) out.push(n.trim());
  }
  return out;
};
for (let grew = true; grew;) {
  grew = false;
  for (const n of [...base]) for (const m of conjured(scripts[n] || '')) { const c = forgeName(m); if (c && !base.has(c)) { base.add(c); pool.add(c); grew = true; } }
}

// ---- write
const sorted = set => [...set].sort();
const baseCards = Object.fromEntries(sorted(base).map(n => [n, scripts[n]]));
fs.writeFileSync('data/cards.json', JSON.stringify(baseCards));
fs.rmSync('data/more', { recursive: true, force: true });
fs.mkdirSync('data/more', { recursive: true });
const rest = sorted(pool).filter(n => !base.has(n));
const shards = [];
let cur = {}, size = 0;
for (const n of rest) {
  cur[n] = scripts[n]; size += n.length + scripts[n].length + 8;
  if (size >= SHARD_BYTES) { shards.push(cur); cur = {}; size = 0; }
}
if (Object.keys(cur).length) shards.push(cur);
shards.forEach((s, i) => fs.writeFileSync(`data/more/cards-${i}.json`, JSON.stringify(s)));
fs.writeFileSync('data/more.json', JSON.stringify({ shards: shards.length, cards: rest.length }));
const meta = {};
for (const n of sorted(pool)) { const s = sf.get(n); if (s) meta[n] = s.banned ? [s.img, s.rank, 1] : [s.img, s.rank]; }
fs.writeFileSync('data/cardmeta.json', JSON.stringify(meta));
fs.writeFileSync('data/community.json', JSON.stringify(community));
const kb = f => (fs.statSync(f).size / 1024).toFixed(0) + 'KB';
console.log(`cards.json ${base.size} cards ${kb('data/cards.json')} | more: ${rest.length} cards in ${shards.length} pieces (${shards.map((_, i) => kb(`data/more/cards-${i}.json`)).join(', ')}) | cardmeta ${kb('data/cardmeta.json')} | community ${kb('data/community.json')}`);
console.log('total playable cards:', pool.size, '| without a picture on Scryfall:', [...pool].filter(n => !(sf.get(n) || {}).img).length);
