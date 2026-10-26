// The deck builder's brain (src/ui/deckai.js) without a browser: for many commanders, the helper builds a full deck
// that's legal (100 cards, in colors, one of each, nothing banned), its checklist is mostly covered, its color
// advice agrees with the lands it picked, and card details, ranking and precon copies all work.
// Usage: node tools/buildertest.mjs [how many commanders, default 60]
import fs from 'node:fs';
import { buildIndex, deckProblems, BASICS } from '../src/ui/customdecks.js';
import { createDeckHelper } from '../src/ui/deckai.js';

const N = +(process.argv[2] || 60);
const raw = JSON.parse(fs.readFileSync('data/cards.json', 'utf8'));
const decks = JSON.parse(fs.readFileSync('data/decks.json', 'utf8'));
const support = JSON.parse(fs.readFileSync('data/support.json', 'utf8'));
const index = buildIndex(raw);
const byName = new Map(index.map(c => [c.name, c]));
const H = createDeckHelper(index, decks, support);
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };

// commanders spread across the alphabet, plus every precon's (so colorless and five-color ones are in)
const all = index.filter(c => c.commander && H.feats.get(c.name).legal && !H.feats.get(c.name).flagged);
const picks = [...new Set([...all.filter((_, i) => i % Math.max(1, Math.floor(all.length / N)) === 0).slice(0, N).map(c => c.name), 'Kozilek, the Great Distortion', 'Atraxa, Praetors\' Voice', 'Atarka, World Render'])].filter(n => byName.get(n));
let covered = 0, rows = 0, shortColors = 0;
for (const [i, name] of picks.entries()) {
  const state = { commanders: [name], cards: new Map() };
  const r = H.build(state, { seed: i + 1 });
  const done = { commanders: [name], cards: r.cards };
  const list = [...r.cards];
  const identity = byName.get(name).ci;
  const problems = deckProblems({ commanders: [name], cards: list }, byName, identity);
  ok(!problems.length, `${name}: ${problems.join(' ')}`);
  ok(list.every(([n, k]) => k === 1 || BASICS.has(n)), `${name}: one of each`);
  const rec = H.recipe(done);
  covered += rec.rows.filter(x => x.state === 'good').length; rows += rec.rows.length;
  const lands = rec.rows.find(x => x.id === 'land');
  ok(lands.state === 'good', `${name}: lands ${lands.have} (aim ${lands.want})`);
  const mana = H.manaStats(done);
  shortColors += mana.colors.filter(c => c.short).length;
  // card details and ranking for a few cards
  for (const [n] of list.slice(0, 3)) ok(H.info(n, done) && Array.isArray(H.info(n, done).roles), `${name}: info for ${n}`);
  ok(H.rank(done).size > 50, `${name}: ranking`);
}
ok(covered / rows > 0.85, `checklists mostly covered (${covered}/${rows})`);
ok(shortColors <= Math.ceil(picks.length * 0.1), `color advice agrees with the helper's own lands (${shortColors} short colors in ${picks.length} decks)`);
// a precon read as a starting point: counts of a card listed twice add up
const twice = decks.find(d => { const seen = new Set(); return d.cards.some(([n]) => (seen.has(n) ? true : (seen.add(n), false))); });
if (twice) {
  const m = new Map(); for (const [n, k] of twice.cards) m.set(n, (m.get(n) || 0) + k);
  ok(twice.commanders.length + [...m.values()].reduce((a, b) => a + b, 0) === 100, `${twice.name}: 100 cards when its repeated entries are added up`);
}
console.log(`${picks.length} commanders built\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
