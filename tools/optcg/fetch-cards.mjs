// Download everything the One Piece data is built from into a cache dir (files already there are kept):
// optcgapi's card dumps and per-deck card lists, the official English and Japanese card lists (every starter deck,
// booster, extra booster and the promotion cards), the official product pages, and every decklist page that
// tools/optcg/decklists.mjs names.
// Usage: NODE_USE_ENV_PROXY=1 node tools/optcg/fetch-cards.mjs <cache dir>
import fs from 'node:fs';
import path from 'node:path';
import { DECKS, SOURCES, OFFICIAL_EN, OFFICIAL_JP, BOOSTER_SERIES, OPTCGAPI } from './decklists.mjs';

const CACHE = process.argv[2];
if (!CACHE) { console.error('usage: node tools/optcg/fetch-cards.mjs <cache dir>'); process.exit(1); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const UA = 'Mozilla/5.0 (fan-made battle simulator; card data)';

const jobs = [];
const want = (url, file) => { if (!jobs.some(j => j.file === file)) jobs.push({ url, file }); };
want(OPTCGAPI.st, 'optcgapi/allSTCards.json');
want(OPTCGAPI.set, 'optcgapi/allSetCards.json');
want(OPTCGAPI.promo, 'optcgapi/allPromos.json');
for (const d of DECKS) {
  want(OPTCGAPI.deck(d.code), `optcgapi/decks/${d.code}.json`);
  want(OFFICIAL_EN + d.enSeries, `official/en-${d.enSeries}.html`);
  want(OFFICIAL_JP + d.jpSeries, `official/jp-${d.jpSeries}.html`);
  want(d.product, `products/${d.product.split('/').pop()}`);
  for (const s of SOURCES) if (!s.only || s.only(d)) want((s.fetch || s.url)(d), s.file(d));
}
for (const s of BOOSTER_SERIES) want(OFFICIAL_EN + s, `official/en-${s}.html`);

let got = 0, kept = 0;
const failed = [];
async function worker() {
  while (jobs.length) {
    const { url, file } = jobs.shift();
    const out = path.join(CACHE, file);
    if (fs.existsSync(out)) { kept++; continue; }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    let ok = false, why = '';
    for (let attempt = 0; attempt < 4 && !ok; attempt++) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': UA } });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const text = await res.text();
        if (file.endsWith('.json')) JSON.parse(text);
        fs.writeFileSync(out, text);
        ok = true; got++;
      } catch (e) { why = e.message; await sleep(1500 * (attempt + 1)); }
    }
    if (!ok) failed.push(`${file} (${url}): ${why}`);
    await sleep(150);
  }
}
const total = jobs.length;
await Promise.all(Array.from({ length: 4 }, worker));
console.log(`${total} files: downloaded ${got}, already cached ${kept}, failed ${failed.length}${failed.length ? '\n  ' + failed.join('\n  ') : ''}`);
if (failed.length) process.exitCode = 1;
