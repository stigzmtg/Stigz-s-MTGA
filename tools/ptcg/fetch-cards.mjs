// Map Limitless set codes to TCGdex sets and download every card the chosen decklists use (TCGdex API).
// Usage: NODE_USE_ENV_PROXY=1 node tools/ptcg/fetch-cards.mjs <cache dir> '["Dragapult ex",...]'
import fs from 'node:fs';
const [DIR, PICK] = process.argv.slice(2);
const pick = JSON.parse(PICK);
const lists = JSON.parse(fs.readFileSync(`${DIR}/lists.json`, 'utf8')).filter(d => pick.includes(d.name));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const api = async p => { for (let i = 0; i < 5; i++) { try { const r = await fetch('https://api.tcgdex.net/v2/en/' + p); if (r.ok) return r.json(); if (r.status === 404) return null; } catch {} await sleep(1000 * (i + 1)); } throw new Error('api ' + p); };
fs.mkdirSync(`${DIR}/cards`, { recursive: true });
const need = new Set(lists.flatMap(d => d.cards.map(c => c.set)));
const mapPath = `${DIR}/setmap.json`;
const setmap = fs.existsSync(mapPath) ? JSON.parse(fs.readFileSync(mapPath, 'utf8')) : {};
if ([...need].some(s => !setmap[s])) {
  const sets = await api('sets');
  for (const s of sets) {
    if (!/^(sv|me|swsh|svp|mep|mee|sve|30th)/i.test(s.id) && !/Energ|Promo/i.test(s.name)) continue;
    const d = await api('sets/' + s.id);
    const ab = d && d.abbreviation && d.abbreviation.official;
    // two sets can share an abbreviation (30th Celebration and its Classic Collection): keep the main one
    const official = (d && d.cardCount && d.cardCount.official) || 0;
    if (ab && (!setmap[ab] || official > (setmap[ab].official || 0))) setmap[ab] = { id: s.id, name: s.name, official, cards: Object.fromEntries((d.cards || []).map(c => [String(parseInt(c.localId, 10)), c.id])) };
    await sleep(60);
  }
  fs.writeFileSync(mapPath, JSON.stringify(setmap));
}
const missing = [...need].filter(s => !setmap[s]);
console.log('set codes', [...need].join(' '), '| unmapped:', missing.join(' ') || 'none');
let got = 0, miss = [];
for (const d of lists) for (const c of d.cards) {
  const key = `${c.set}-${c.num}`;
  const out = `${DIR}/cards/${key}.json`;
  if (fs.existsSync(out)) { got++; continue; }
  const sm = setmap[c.set];
  const id = sm && sm.cards[String(parseInt(c.num, 10))];
  if (!id) { miss.push(`${key} ${c.name}`); continue; }
  const card = await api('cards/' + id);
  if (!card) { miss.push(`${key} ${c.name} (404 ${id})`); continue; }
  delete card.variants_detailed; delete card.pricing;
  fs.writeFileSync(out, JSON.stringify(card));
  got++;
  await sleep(50);
}
console.log('cards', got, 'missing', miss.length, miss.join('; '));
