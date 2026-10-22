// Token images: match each Forge token script used by the precons to a Scryfall token (name, colors, P/T,
// keywords), then download its picture (TCGplayer product image when it has one, else Scryfall's).
// Usage: NODE_USE_ENV_PROXY=1 node tools/fetch-tokens.mjs <cache dir> [--width=300] [--quality=42]
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const CACHE = args.find(a => !a.startsWith('--'));
const WIDTH = +(flags.width || 480), QUALITY = +(flags.quality || 42);
fs.mkdirSync(path.join(CACHE, 'tokens'), { recursive: true });
const UA = { 'User-Agent': 'PreconArena/1.0 (fan-made Commander simulator)', Accept: 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const cards = JSON.parse(fs.readFileSync('data/cards.json', 'utf8'));
const tokens = JSON.parse(fs.readFileSync('data/tokens.json', 'utf8'));
const decks = JSON.parse(fs.readFileSync('data/decks.json', 'utf8'));
const used = new Set();
for (const n of new Set(decks.flatMap(d => [...d.cards.map(c => c[0]), ...d.commanders]))) {
  const t = cards[n];
  if (t) for (const m of t.matchAll(/TokenScript\$ ?([\w,]+)/g)) for (const s of m[1].split(',')) if (tokens[s.trim()]) used.add(s.trim());
}

const COLOR = { white: 'w', blue: 'u', black: 'b', red: 'r', green: 'g', colorless: 'c' };
const KW = ['Flying', 'Haste', 'Trample', 'Vigilance', 'Lifelink', 'Deathtouch', 'Menace', 'Reach', 'First Strike', 'Double Strike', 'Indestructible', 'Hexproof', 'Defender', 'Infect'];
function describe(script) {
  const f = {};
  for (const line of script.split('\n')) { const i = line.indexOf(':'); if (i > 0 && !f[line.slice(0, i)]) f[line.slice(0, i)] = line.slice(i + 1).trim(); }
  const name = (f.Name || '').replace(/ Token$/, '');
  const colors = (f.Colors || 'colorless').split(',').map(c => COLOR[c.trim()]).filter(Boolean).join('');
  const kws = script.split('\n').filter(l => l.startsWith('K:')).map(l => l.slice(2).split(':')[0]).filter(k => KW.includes(k));
  const [pow, tou] = (f.PT || '').split('/');
  return { name, colors: colors || 'c', pow, tou, kws, artifact: /Artifact/.test(f.Types || '') };
}

async function search(q) {
  const url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&order=released&dir=desc&include_extras=true`;
  for (let attempt = 0; attempt < 6; attempt++) {
    let res;
    try { res = await fetch(url, { headers: UA }); } catch { await sleep(2000 * (attempt + 1)); continue; } // dropped connection: retry
    await sleep(120);
    if (res.status === 429 || res.status >= 500) { await sleep(Math.min(30000, 1500 * 2 ** attempt)); continue; }
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const d = await res.json();
    return d.data && d.data[0];
  }
  return null;
}

const outIndex = path.join(CACHE, 'tokens.json');
const matched = fs.existsSync(outIndex) ? JSON.parse(fs.readFileSync(outIndex, 'utf8')) : {};
let n = 0, miss = 0;
for (const s of [...used].sort()) {
  const out = path.join(CACHE, 'tokens', `${s}.avif`);
  if (matched[s] && fs.existsSync(out)) continue;
  const d = describe(tokens[s]);
  if (!d.name) continue;
  const base = `t:token !"${d.name}"`;
  const pt = d.pow != null && /^\d+$/.test(d.pow) && /^\d+$/.test(d.tou) ? ` pow=${d.pow} tou=${d.tou}` : '';
  const col = ` c=${d.colors}`;
  const kw = d.kws.map(k => ` keyword:"${k.toLowerCase()}"`).join('');
  let card = null;
  for (const q of [base + pt + col + kw, base + pt + col, base + col, base]) { card = await search(q); if (card) break; }
  if (!card) { miss++; console.log(`  no match: ${s} (${d.name})`); continue; }
  const scry = card.image_uris ? card.image_uris.normal : card.card_faces && card.card_faces[0].image_uris ? card.card_faces[0].image_uris.normal : null;
  const urls = [card.tcgplayer_id ? `https://tcgplayer-cdn.tcgplayer.com/product/${card.tcgplayer_id}_in_1000x1000.jpg` : null, scry].filter(Boolean);
  let ok = false;
  for (const u of urls) {
    try {
      const res = await fetch(u, { headers: { 'User-Agent': UA['User-Agent'] } });
      if (!res.ok) continue;
      await sharp(Buffer.from(await res.arrayBuffer())).resize({ width: WIDTH }).avif({ quality: QUALITY, effort: 2 }).toFile(out);
      matched[s] = { id: card.id, name: card.name, set: card.set, from: /tcgplayer/.test(u) ? 'tcgplayer' : 'scryfall' };
      ok = true;
      break;
    } catch { /* try the next source */ }
  }
  if (!ok) { miss++; continue; }
  n++;
  if (n % 25 === 0) { process.stdout.write(`\r  ${n} tokens matched`); fs.writeFileSync(outIndex, JSON.stringify(matched)); }
}
fs.writeFileSync(outIndex, JSON.stringify(matched));
console.log(`\n${Object.keys(matched).length} of ${used.size} token scripts have an image (${miss} without a match)`);
