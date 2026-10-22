// Download card images and store them as small AVIF files.
// Scryfall identifies each deck's own precon printing (or the default printing) and its TCGplayer product;
// the picture comes from TCGplayer's product image, with Scryfall's image as the fallback and for back faces.
// Resumable: re-running skips images already on disk.
// Usage: node tools/fetch-images.mjs <cache dir> [--width=300] [--quality=50] [--limit=N]
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { CardDB } from '../src/engine/cards.js';

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const CACHE = args.find(a => !a.startsWith('--'));
if (!CACHE) { console.error('usage: node tools/fetch-images.mjs <cache dir>'); process.exit(1); }
const WIDTH = +(flags.width || 480), QUALITY = +(flags.quality || 42), EFFORT = +(flags.effort || 2), WORKERS = +(flags.workers || 12);
const TCG_SIZE = flags.tcgsize || 'in_1000x1000'; // TCGplayer product image variant (716x1000)
fs.mkdirSync(path.join(CACHE, 'img'), { recursive: true });

const UA = { 'User-Agent': 'PreconArena/1.0 (fan-made Commander simulator)', Accept: 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const db = new CardDB(JSON.parse(fs.readFileSync('data/cards.json', 'utf8')), JSON.parse(fs.readFileSync('data/tokens.json', 'utf8')));
const decks = JSON.parse(fs.readFileSync('data/decks.json', 'utf8'));
const manifestPath = path.join(CACHE, 'manifest.json');
// manifest: { printings: { "<deckId>|<name>": [scryfallId, ...faces] }, faces: { scryfallId: { name, set, faces: n } } }
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { printings: {}, cards: {} };
const save = () => fs.writeFileSync(manifestPath, JSON.stringify(manifest));

async function api(url, body) {
  // Scryfall asks for ~10 requests a second at most; on 429 back off and try again rather than give up
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(url, body ? { method: 'POST', headers: { ...UA, 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { headers: UA });
    if (res.status === 429 || res.status >= 500) { await sleep(Math.min(30000, 1000 * 2 ** attempt)); continue; }
    if (res.status === 404) return null;
    if (!res.ok) { console.log(`\n  ${res.status} ${url}`); return null; }
    return res.json();
  }
  console.log(`\n  gave up after repeated rate limits: ${url}`);
  return null;
}

// name Scryfall knows: split/adventure/modal cards use the full "A // B" name, transform cards the front face
function scryName(name) {
  const def = db.get(name);
  if (!def) return name;
  return def.name;
}

// candidate image URLs per face, best first
function imageUrls(card) {
  const scry = card.image_uris ? [card.image_uris.normal] : card.card_faces && card.card_faces[0].image_uris ? card.card_faces.map(f => f.image_uris.normal) : [];
  const tcg = card.tcgplayer_id ? `https://tcgplayer-cdn.tcgplayer.com/product/${card.tcgplayer_id}_${TCG_SIZE}.jpg` : null;
  return scry.map((u, i) => (i === 0 && tcg ? [tcg, u] : [u]));
}

function remember(card) {
  manifest.cards[card.id] = { name: card.name, set: card.set, tcg: card.tcgplayer_id || null, urls: imageUrls(card), layout: card.layout };
}

// 1. resolve printings
const wanted = [];
for (const d of decks) {
  const names = new Set([...d.cards.map(c => c[0]), ...d.commanders]);
  for (const n of names) if (!manifest.printings[`${d.id}|${n}`]) wanted.push({ key: `${d.id}|${n}`, name: scryName(n), set: d.set.toLowerCase() });
}
if (flags.limit) wanted.splice(+flags.limit);
console.log(`resolving ${wanted.length} deck printings`);
const fallback = [];
for (let i = 0; i < wanted.length; i += 75) {
  const batch = wanted.slice(i, i + 75);
  const res = await api('https://api.scryfall.com/cards/collection', { identifiers: batch.map(w => ({ name: w.name, set: w.set })) }) || { data: [] };
  const byName = new Map();
  for (const c of res.data) { remember(c); byName.set(c.name.toLowerCase(), c); if (c.card_faces) byName.set(c.card_faces[0].name.toLowerCase(), c); }
  for (const w of batch) {
    const c = byName.get(w.name.toLowerCase()) || byName.get(w.name.split(' // ')[0].toLowerCase());
    if (c && c.set === w.set) manifest.printings[w.key] = c.id; else fallback.push(w);
  }
  save();
  process.stdout.write(`\r  ${Math.min(i + 75, wanted.length)}/${wanted.length} (${fallback.length} without a precon printing)`);
  await sleep(110);
}
console.log();
// cards without a printing in the deck's set: Scryfall's default printing, one lookup per name
const defaults = new Map();
const names = [...new Set(fallback.map(w => w.name))];
for (let i = 0; i < names.length; i += 75) {
  const batch = names.slice(i, i + 75);
  const res = await api('https://api.scryfall.com/cards/collection', { identifiers: batch.map(n => ({ name: n })) }) || { data: [], not_found: [] };
  for (const c of res.data) { remember(c); defaults.set(c.name.toLowerCase(), c.id); if (c.card_faces) defaults.set(c.card_faces[0].name.toLowerCase(), c.id); }
  for (const nf of res.not_found || []) {
    const c = await api(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(nf.name.split(' // ')[0])}`);
    if (c) { remember(c); defaults.set(nf.name.toLowerCase(), c.id); }
    else console.log(`\n  not found on Scryfall: ${nf.name}`);
    await sleep(200);
  }
  await sleep(110);
}
for (const w of fallback) { const id = defaults.get(w.name.toLowerCase()) || defaults.get(w.name.split(' // ')[0].toLowerCase()); if (id) manifest.printings[w.key] = id; }
save();

// refresh candidate URLs (the TCGplayer size may differ from the run that resolved them)
for (const c of Object.values(manifest.cards)) {
  if (!Array.isArray(c.urls)) continue;
  const scry = c.urls.map(u => (Array.isArray(u) ? u[u.length - 1] : u));
  c.urls = scry.map((u, i) => (i === 0 && c.tcg ? [`https://tcgplayer-cdn.tcgplayer.com/product/${c.tcg}_${TCG_SIZE}.jpg`, u] : [u]));
}

// 2. download + encode every face of every printing in use
const ids = [...new Set(Object.values(manifest.printings))];
const jobs = [];
for (const id of ids) (manifest.cards[id].urls || []).forEach((u, f) => { const out = path.join(CACHE, 'img', `${id}-${f}.avif`); if (!fs.existsSync(out)) jobs.push({ urls: Array.isArray(u) ? u : [u], out, id }); });
console.log(`downloading ${jobs.length} images (${ids.length} printings)`);
let done = 0, failed = 0;
const source = { tcgplayer: 0, scryfall: 0 };
async function worker() {
  while (jobs.length) {
    const j = jobs.shift();
    let ok = false;
    for (const u of j.urls) {
      try {
        let buf;
        for (let attempt = 0; attempt < 4 && !buf; attempt++) {
          const res = await fetch(u, { headers: { 'User-Agent': UA['User-Agent'] } });
          if (res.status === 429 || res.status >= 500) { await sleep(1500 * (attempt + 1)); continue; }
          if (!res.ok) throw new Error(res.status + ' ' + u);
          buf = Buffer.from(await res.arrayBuffer());
        }
        if (!buf) throw new Error('gave up ' + u);
        await sharp(buf).resize({ width: WIDTH }).avif({ quality: QUALITY, effort: EFFORT }).toFile(j.out);
        source[/tcgplayer/.test(u) ? 'tcgplayer' : 'scryfall']++;
        ok = true;
        break;
      } catch (e) { if (u === j.urls[j.urls.length - 1]) console.log('\n  ' + e.message); }
    }
    if (!ok) failed++;
    done++;
    if (done % 25 === 0) process.stdout.write(`\r  ${done} done, ${failed} failed, ${jobs.length} left`);
  }
}
await Promise.all(Array.from({ length: WORKERS }, worker));
console.log(`\nimages: ${done} processed, ${failed} failed · from TCGplayer ${source.tcgplayer}, from Scryfall ${source.scryfall}`);
