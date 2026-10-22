// Download every Pokémon card picture (TCGdex scans, Limitless for basic Energy) and store it as a 480px AVIF,
// then pack them for the site: dist/img/ptcg-N.avif and data/ptcg/images.json ({ packs, cards: { key: [pack, offset, length] } }).
// Usage: NODE_USE_ENV_PROXY=1 node tools/ptcg/fetch-images.mjs <cache dir>
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const CACHE = process.argv[2];
if (!CACHE) { console.error('usage: node tools/ptcg/fetch-images.mjs <cache dir>'); process.exit(1); }
const dir = path.join(CACHE, 'img');
fs.mkdirSync(dir, { recursive: true });
const cards = JSON.parse(fs.readFileSync('data/ptcg/cards.json', 'utf8'));
const decks = JSON.parse(fs.readFileSync('data/ptcg/decks.json', 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const file = key => path.join(dir, key.replace(/[^\w-]+/g, '_') + '.avif');

let got = 0, failed = [];
const jobs = Object.values(cards).filter(c => !fs.existsSync(file(c.key)));
async function worker() {
  while (jobs.length) {
    const c = jobs.shift();
    let ok = false;
    for (let attempt = 0; attempt < 4 && !ok; attempt++) {
      try {
        const res = await fetch(c.img, { headers: { 'User-Agent': 'PreconArena/1.0 (fan-made battle simulator)' } });
        if (!res.ok) throw new Error(res.status);
        const buf = Buffer.from(await res.arrayBuffer());
        await sharp(buf).resize({ width: 480, withoutEnlargement: true }).avif({ quality: 50, effort: 4 }).toFile(file(c.key));
        ok = true; got++;
      } catch (e) { await sleep(1000 * (attempt + 1)); if (attempt === 3) failed.push(`${c.key} ${c.name}: ${e.message}`); }
    }
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
console.log(`downloaded ${got}, failed ${failed.length}${failed.length ? ': ' + failed.join('; ') : ''}`);

// pack: every deck's cards, in deck order so a pack holds related cards
const order = [];
for (const d of decks) for (const [k] of d.cards) if (!order.includes(k)) order.push(k);
const OUT = 'dist/img';
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (/^ptcg-\d+\.avif$/.test(f)) fs.rmSync(path.join(OUT, f));
const index = { v: 1, type: 'image/avif', packs: [], cards: {} };
let parts = [], size = 0, total = 0;
const flush = () => {
  if (!parts.length) return;
  const name = `img/ptcg-${index.packs.length}.avif`;
  fs.writeFileSync(path.join('dist', name), Buffer.concat(parts));
  index.packs.push(name);
  total += size; parts = []; size = 0;
};
for (const k of order) {
  if (!fs.existsSync(file(k))) continue;
  const b = fs.readFileSync(file(k));
  if (size + b.length > 1.5e6) flush();
  index.cards[k] = [index.packs.length, size, b.length];
  parts.push(b); size += b.length;
}
flush();
fs.writeFileSync('data/ptcg/images.json', JSON.stringify(index));
console.log(`${Object.keys(index.cards).length} images in ${index.packs.length} packs, ${(total / 1048576).toFixed(1)} MB`);
