// Community Commander decks from magic websites, with credit: EDHREC's average deck for the most-played commanders of
// the last two years (each built from thousands of players' decks) and the most-viewed Commander decks on Archidekt.
// Writes the lists as the sites give them to data/sources/community-raw.json; tools/build-allcards.mjs keeps the ones
// that are complete, legal and fully scripted, and writes data/community.json.
// Usage: node tools/fetch-decks.mjs [edhrec commanders=40] [archidekt decks=40]
import fs from 'node:fs';

const N_EDHREC = +(process.argv[2] || 40), N_ARCH = +(process.argv[3] || 40);
const get = async (url, tries = 4) => {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'LotusGoats/1.0 (deck list import; lotusgoats.com)' } });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return await r.json();
    } catch (e) { if (i >= tries) throw e; await new Promise(res => setTimeout(res, 1500 * 2 ** i)); }
  }
};
const pause = ms => new Promise(r => setTimeout(r, ms));
const out = [];

// ---- EDHREC: the average deck of each of the most popular commanders
const top = await get('https://json.edhrec.com/pages/commanders/year.json');
const commanders = top.container.json_dict.cardlists[0].cardviews.slice(0, N_EDHREC);
for (const c of commanders) {
  const j = await get(`https://json.edhrec.com/pages/average-decks/${c.sanitized}.json`);
  await pause(250);
  if (!j || !j.deck) { console.log('EDHREC: no average deck for', c.name); continue; }
  const cmds = j.deck.commander_v2 ? j.deck.commander_v2.map(([n]) => n) : j.deck.commander;
  const cards = [];
  for (const list of Object.values(j.deck.cards || {})) for (const [n, k] of list) cards.push([n, k]);
  out.push({
    source: 'EDHREC', key: c.sanitized, name: `${cmds.map(n => n.split(',')[0]).join(' & ')}`, commanders: cmds, cards,
    url: `https://edhrec.com/average-decks/${c.sanitized}`, decks: c.num_decks || null,
  });
  console.log('EDHREC', c.name, cards.reduce((a, [, k]) => a + k, 0) + cmds.length);
}

// ---- Archidekt: the most-viewed Commander decks (public, not theorycrafted)
let page = 1, kept = 0;
while (kept < N_ARCH && page <= 10) {
  const list = await get(`https://archidekt.com/api/decks/v3/?orderBy=-viewCount&deckFormat=3&pageSize=50&page=${page++}`);
  if (!list || !list.results || !list.results.length) break;
  for (const d of list.results) {
    if (kept >= N_ARCH) break;
    if (d.private || d.unlisted || d.theorycrafted || d.size !== 100) continue;
    const j = await get(`https://archidekt.com/api/decks/${d.id}/`);
    await pause(400);
    if (!j || !j.cards) continue;
    const outside = new Set((j.categories || []).filter(c => c.includedInDeck === false).map(c => c.name));
    const cmds = [], cards = [];
    for (const c of j.cards) {
      const name = c.card && c.card.oracleCard && c.card.oracleCard.name;
      if (!name || (c.categories || []).some(x => outside.has(x))) continue;
      if ((c.categories || []).includes('Commander')) cmds.push(name);
      else cards.push([name, c.quantity]);
    }
    if (!cmds.length) continue;
    out.push({
      source: 'Archidekt', key: String(d.id), name: j.name, author: j.owner && j.owner.username, commanders: cmds, cards,
      url: `https://archidekt.com/decks/${d.id}`, views: d.viewCount, bracket: j.edhBracket || null,
    });
    kept++;
    console.log('Archidekt', j.name, 'by', j.owner && j.owner.username, cards.reduce((a, [, k]) => a + k, 0) + cmds.length);
  }
}

fs.mkdirSync('data/sources', { recursive: true });
fs.writeFileSync('data/sources/community-raw.json', JSON.stringify({ fetched: new Date().toISOString(), decks: out }, null, 1));
console.log(`\n${out.length} decks → data/sources/community-raw.json`);
