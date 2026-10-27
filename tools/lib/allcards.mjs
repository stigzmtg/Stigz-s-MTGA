// Every card script (the page's data/cards.json plus the rest of the pool in data/more, from tools/build-allcards.mjs),
// for tests that use cards no precon plays.
import fs from 'node:fs';

export function allCardScripts() {
  const cards = JSON.parse(fs.readFileSync('data/cards.json', 'utf8'));
  const n = fs.existsSync('data/more.json') ? JSON.parse(fs.readFileSync('data/more.json', 'utf8')).shards : 0;
  for (let i = 0; i < n; i++) Object.assign(cards, JSON.parse(fs.readFileSync(`data/more/cards-${i}.json`, 'utf8')));
  return cards;
}
