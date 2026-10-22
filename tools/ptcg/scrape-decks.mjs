// Scrape one top tournament decklist per archetype from Limitless (limitlesstcg.com).
// Usage: NODE_USE_ENV_PROXY=1 node tools/ptcg/scrape-decks.mjs <cache dir>/lists.json '{"Dragapult ex":284,...}'
import fs from 'node:fs';
const OUT = process.argv[2];
const arche = JSON.parse(process.argv[3]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = async u => { for (let i = 0; i < 4; i++) { try { const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 PreconArena' } }); if (r.ok) return r.text(); } catch {} await sleep(1500); } throw new Error('fetch ' + u); };
const dec = s => s.replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/&quot;/g, '"').replace(/&eacute;/g, 'é');
const out = [];
for (const [name, id] of Object.entries(arche)) {
  const page = await get(`https://limitlesstcg.com/decks/${id}`);
  const lists = [...page.matchAll(/\/decks\/list\/(\d+)/g)].map(m => m[1]);
  const listId = lists[0];
  const html = await get(`https://limitlesstcg.com/decks/list/${listId}`);
  const cards = [];
  for (const m of html.matchAll(/<div class="decklist-card" data-set="([^"]*)" data-number="([^"]*)"[^>]*>\s*<a[^>]*>\s*<span class="card-count">(\d+)<\/span>\s*<span class="card-name">([^<]+)<\/span>/g)) cards.push({ set: m[1], num: m[2], n: +m[3], name: dec(m[4].trim()) });
  const title = dec((html.match(/<title>([^<]+)<\/title>/) || [])[1] || '');
  const info = dec((html.match(/<div class="decklist-title">([\s\S]*?)<\/div>/) || [])[1] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const total = cards.reduce((s, c) => s + c.n, 0);
  out.push({ name, archetype: id, list: listId, title, info, total, cards });
  console.log(name, listId, total, title, '|', info.slice(0, 100));
  await sleep(400);
}
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
