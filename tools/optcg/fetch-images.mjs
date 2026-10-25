// Picture every One Piece card the decks use and pack them for the site: docs/img/optcg-N.avif (and dist/img/) plus
// data/optcg/images.json ({ v, type, packs, cards: { id: [pack, offset, length] } }), 480px wide AVIF like the
// Pokémon pictures, packs under 1.5 MB holding the cards in deck order.
//
// The official site's pictures (and optcgapi's and Limitless's, which copy them) carry a big "SAMPLE" watermark, and
// so do most of TCGplayer's product pictures, which are the same files. So for every card number this tries
// TCGplayer's products with the same art (the plain printing in its own set first, then the same card printed in
// other starter decks and boxes, then starter-deck "(Reprint)" printings; never Alternate Art, Parallel or promo-pack
// versions) and keeps the first one that is a real scan: a picture that matches none of the card's official pictures
// (every printing of that number on the official card lists) and isn't TCGplayer's "Image Coming Soon". Cards with no
// clean scan use the official picture, watermark and all. The outcome is kept in tools/optcg/tcg-ids.json so reruns
// are stable (--recheck redoes it).
// Usage: NODE_USE_ENV_PROXY=1 node tools/optcg/fetch-images.mjs <cache dir> [--recheck]
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { cardImage } from './decklists.mjs';

const CACHE = process.argv[2];
if (!CACHE) { console.error('usage: node tools/optcg/fetch-images.mjs <cache dir> [--recheck]'); process.exit(1); }
const sub = d => { const p = path.join(CACHE, d); fs.mkdirSync(p, { recursive: true }); return p; };
const IMG = sub('img'), SCANS = sub('tcg'), OFFICIAL = sub('official-img'), SEARCHES = sub('tcg-search');
const cards = JSON.parse(fs.readFileSync('data/optcg/cards.json', 'utf8'));
const decks = JSON.parse(fs.readFileSync('data/optcg/decks.json', 'utf8'));
const IDS = 'tools/optcg/tcg-ids.json';
const known = fs.existsSync(IDS) && !process.argv.includes('--recheck') ? JSON.parse(fs.readFileSync(IDS, 'utf8')).cards : {};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const UA = { 'User-Agent': 'Mozilla/5.0 (fan-made battle simulator; card pictures)' };

async function download(url, file) {
  if (fs.existsSync(file)) return fs.readFileSync(file);
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: UA });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(file, buf);
      return buf;
    } catch (e) { if (attempt === 3) throw new Error(`${url}: ${e.message}`); await sleep(1000 * (attempt + 1)); }
  }
}

// ---- TCGplayer search -----------------------------------------------------------------------------------------
const query = () => ({
  algorithm: 'sales_synonym_v2', from: 0, size: 50,
  filters: { term: { productLineName: ['one-piece-card-game'] }, range: {}, match: {} },
  listingSearch: { context: { cart: {} }, filters: { term: { sellerStatus: 'Live', channelId: 0 }, range: { quantity: { gte: 1 } }, exclude: { channelExclusion: 0 } } },
  context: { cart: {}, shippingCountry: 'US', userProfile: {} }, settings: { useFuzzySearch: false, didYouMean: {} }, sort: {},
});
async function search(id) {
  const f = path.join(SEARCHES, id + '.json');
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const res = await searchLive(id);
  fs.writeFileSync(f, JSON.stringify(res));
  return res;
}
async function searchLive(id) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(`https://mp-search-api.tcgplayer.com/v1/search/request?q=${encodeURIComponent(id)}&isList=false`, { method: 'POST', headers: { ...UA, 'Content-Type': 'application/json' }, body: JSON.stringify(query()) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return (await r.json()).results[0].results;
    } catch { await sleep(1500 * (attempt + 1)); }
  }
  throw new Error('TCGplayer search failed for ' + id);
}
// a plain name is the card's name, optionally with its number: "Shanks (001)", "Nami", "Bartolomeo (P-029)",
// "Roronoa Zoro - OP14-015", "Mr.2.Bon.Kurei (Bentham)" (those brackets are part of the card's name)
const squash = s => s.replace(/\s+/g, '').toLowerCase();
const plain = (name, id) => {
  let rest = name.replace(` - ${id}`, '').replace(/\s*\((\d{3}|[A-Z]+\d*-\d{3})\)\s*$/, '');
  const own = squash(cards[id].name);
  if (squash(rest).startsWith(own)) rest = squash(rest).slice(own.length);
  return !/\(/.test(rest);
};
const reprint = (name, id) => /\((Promo )?Reprint\)$/.test(name.replace(` - ${id}`, ''));
const STARTER = /^ST-\d+:/;
const SAME_ART_BOXES = /Demo Deck|Learn Together|Premium Booster|Family Deck|Deck Set/i;
const NEVER = /Pre-Release|Tournament|Release Event|Championship/i;
// every product of this card number with its art as printed, best first
function candidates(id, results) {
  const mine = results.filter(x => !x.sealed && ((x.customAttributes || {}).number || '').trim() === id && !NEVER.test(x.setName));
  const own = id.startsWith('ST') ? x => x.setName.startsWith(`ST-${id.slice(2, 4)}:`) : id.startsWith('P-') ? x => /Promotion Cards/.test(x.setName) : x => !STARTER.test(x.setName) && !SAME_ART_BOXES.test(x.setName) && !/Promotion Cards/.test(x.setName);
  const tiers = [
    x => plain(x.productName, id) && own(x), // its own set: the starter deck for ST cards, the booster for OP/EB cards
    x => plain(x.productName, id) && STARTER.test(x.setName), // the same card in another starter deck
    x => plain(x.productName, id) && SAME_ART_BOXES.test(x.setName), // … or in a demo deck, deck set, premium booster
    x => reprint(x.productName, id), // marked reprints keep the art
  ];
  const out = [];
  for (const t of tiers) for (const x of mine.filter(t).sort((a, b) => a.productId - b.productId)) if (!out.includes(x)) out.push(x);
  return out;
}

// ---- is a picture a real scan? ----------------------------------------------------------------------------------
// every official picture of a card number: the normal print and each reprint/parallel entry on the card lists
const officialKeys = {};
for (const f of fs.readdirSync(path.join(CACHE, 'official'))) if (f.startsWith('en-'))
  for (const m of fs.readFileSync(path.join(CACHE, 'official', f), 'utf8').matchAll(/<dl class="modalCol" id="(([A-Z]+\d*-\d{3})(?:_[a-z]+\d+)?)">/g)) (officialKeys[m[2]] ||= new Set()).add(m[1]);
const W = 60, H = 84;
const thumb = buf => sharp(buf).resize(W, H, { fit: 'fill' }).greyscale().raw().toBuffer();
// the watermark runs across the middle of the card: a picture that matches an official one everywhere else and
// also across that band is the official file; a scan differs (lighting, edges) and has no watermark in the band
// real scans whose bright art happens to sit where the letters go (score over 15): checked by eye, no watermark
const SEEN_CLEAN = new Set([288230 /* ST01-003 Karoo */, 288269 /* ST04-001 Kaido */, 657256 /* OP13-004 Sabo */]);
async function verdict(id, buf, product) {
  const t = await thumb(buf);
  let white = 0;
  for (const v of t) if (v > 225) white++;
  if (white / t.length > 0.65) return 'placeholder';
  // TCGplayer also carries sample files that don't line up with today's official pictures (older frames, other
  // prints): those still show the letters, so look for them where every sample has them
  const m = await watermarkScore(buf);
  if (m > 15 && !SEEN_CLEAN.has(product)) return `watermark-like (${m.toFixed(0)})`;
  for (const key of officialKeys[id] || [id]) {
    const o = await thumb(await download(cardImage(key), path.join(OFFICIAL, key + '.png')));
    let band = 0, nb = 0, rest = 0, nr = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const d = Math.abs(o[y * W + x] - t[y * W + x]);
      if (y >= 30 && y <= 48 && x > 5 && x < 55) { band += d; nb++; } else { rest += d; nr++; }
    }
    if (rest / nr < 20 && band / nb - rest / nr < 4) return 'watermarked (' + key + ')';
  }
  return 'clean';
}

const ids = Object.keys(cards);

// where the SAMPLE letters sit: over all the official pictures, the darkest each pixel ever gets (2nd percentile) is
// bright only where the watermark always is; a picture whose pixels there are brighter than the art around them
// (at 150x210) carries the watermark. Official pictures score 10 to 150 (median 75), real scans below 15.
const MW = 150, MH = 210;
await Promise.all(Array.from({ length: 6 }, async (_, k) => { for (let i = k; i < ids.length; i += 6) await download(cardImage(ids[i]), path.join(OFFICIAL, ids[i] + '.png')); }));
const stacks = Array.from({ length: MW * MH }, () => new Uint8Array(ids.length));
for (const [n, id] of ids.entries()) {
  const g = await sharp(fs.readFileSync(path.join(OFFICIAL, id + '.png'))).resize(MW, MH, { fit: 'fill' }).greyscale().raw().toBuffer();
  for (let i = 0; i < MW * MH; i++) stacks[i][n] = g[i];
}
const letters = [], around = [];
for (let y = 80; y < 130; y++) for (let x = 5; x < MW - 5; x++) {
  const i = y * MW + x, v = stacks[i].sort()[Math.floor(ids.length * 0.02)];
  if (v > 100) letters.push(i); else if (v < 45) around.push(i);
}
async function watermarkScore(buf) {
  const g = await sharp(buf).resize(MW, MH, { fit: 'fill' }).greyscale().raw().toBuffer();
  const mean = idx => idx.reduce((a, i) => a + g[i], 0) / idx.length;
  return mean(letters) - mean(around);
}
const todo = ids.filter(id => !(id in known));
let checked = 0;
async function chooser() {
  while (todo.length) {
    const id = todo.shift();
    const tried = [];
    let chosen = null;
    for (const p of candidates(id, await search(id))) {
      let scan = null;
      try { scan = await download(`https://tcgplayer-cdn.tcgplayer.com/product/${p.productId}_in_1000x1000.jpg`, path.join(SCANS, p.productId + '.jpg')); } catch {}
      const v = scan ? await verdict(id, scan, p.productId) : 'no picture';
      tried.push(`${p.productId} ${v}`);
      if (v === 'clean') { chosen = { product: p.productId, name: p.productName, set: p.setName }; break; }
    }
    known[id] = chosen || { product: null, tried };
    checked++;
    await sleep(200);
  }
}
await Promise.all(Array.from({ length: 4 }, chooser));
const sorted = Object.fromEntries(Object.keys(known).sort().map(k => [k, known[k]]));
fs.writeFileSync(IDS, JSON.stringify({
  about: 'The TCGplayer product whose scan pictures each card: the first clean scan (no SAMPLE watermark, not a placeholder) among its products with the same art. product null: none found (tried lists what was checked); the official picture is used. Made by tools/optcg/fetch-images.mjs.',
  cards: sorted,
}, null, 1) + '\n');
if (checked) console.log(`checked TCGplayer for ${checked} cards`);

// ---- shrink to 480px AVIF -----------------------------------------------------------------------------------------
const source = id => (known[id] && known[id].product ? `tcg-${known[id].product}` : 'official');
const file = id => path.join(IMG, `${id}-${source(id)}.avif`);
const failed = [];
const jobs = ids.filter(id => !fs.existsSync(file(id)));
async function shrinker() {
  while (jobs.length) {
    const id = jobs.shift();
    try {
      const p = known[id] && known[id].product;
      const buf = p ? await download(`https://tcgplayer-cdn.tcgplayer.com/product/${p}_in_1000x1000.jpg`, path.join(SCANS, p + '.jpg')) : await download(cardImage(id), path.join(OFFICIAL, id + '.png'));
      await sharp(buf).resize({ width: 480, withoutEnlargement: true }).avif({ quality: 50, effort: 4 }).toFile(file(id));
    } catch (e) { failed.push(`${id}: ${e.message}`); }
  }
}
await Promise.all(Array.from({ length: 6 }, shrinker));
if (failed.length) console.log(`failed: ${failed.join('; ')}`);
const official = ids.filter(id => !(known[id] && known[id].product));
console.log(`${ids.length - official.length} clean TCGplayer scans, ${official.length} official (watermarked) pictures`);

// ---- pack: each deck's cards in deck order (Leader first), so a game loads few packs ---------------------------
const order = [];
for (const d of decks) for (const id of [d.leader, ...d.cards.map(([id]) => id)]) if (!order.includes(id)) order.push(id);
// the Ultra Decks' other Leaders go last, so adding them leaves the earlier packs as they were
for (const d of decks) for (const id of d.leaders || []) if (!order.includes(id)) order.push(id);
const index = { v: 1, type: 'image/avif', packs: [], cards: {} };
const outDirs = ['dist/img', 'docs/img'];
for (const o of outDirs) { fs.mkdirSync(o, { recursive: true }); for (const f of fs.readdirSync(o)) if (/^optcg-\d+\.avif$/.test(f)) fs.rmSync(path.join(o, f)); }
let parts = [], size = 0;
const sizes = [];
const flush = () => {
  if (!parts.length) return;
  const name = `img/optcg-${index.packs.length}.avif`;
  const buf = Buffer.concat(parts);
  for (const o of outDirs) fs.writeFileSync(path.join(o, path.basename(name)), buf);
  index.packs.push(name);
  sizes.push(buf.length);
  parts = []; size = 0;
};
for (const id of order) {
  if (!fs.existsSync(file(id))) continue;
  const b = fs.readFileSync(file(id));
  if (size + b.length > 1.5e6) flush();
  index.cards[id] = [index.packs.length, size, b.length];
  parts.push(b); size += b.length;
}
flush();
fs.writeFileSync('data/optcg/images.json', JSON.stringify(index));
const total = sizes.reduce((a, b) => a + b, 0);
console.log(`${Object.keys(index.cards).length} of ${ids.length} pictures in ${index.packs.length} packs, ${(total / 1048576).toFixed(1)} MB (largest ${(Math.max(...sizes) / 1048576).toFixed(2)} MB)`);
const clean = decks.filter(d => [d.leader, ...d.cards.map(([id]) => id)].every(id => known[id] && known[id].product)).map(d => d.code);
console.log(`decks with only clean scans: ${clean.join(', ') || 'none'}`);

// the menus' small pictures
await import('./pack-thumbs.mjs');
