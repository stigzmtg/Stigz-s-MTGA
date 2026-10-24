// Which cards the One Piece engine fully implements: every ability of every card's text and [Trigger] must compile
// (src/optcg/text.js plus overrides in src/optcg/cards.js). A card with any text the compiler can't read is listed
// and the check fails: nothing is silently ignored.
// Usage: node tools/optcg/coverage.mjs [--decks=st01,st02] [--all] [--show=ID] [--verbose]
import { compileCard } from '../../src/optcg/cards.js';
import { loadDb, loadDecks, deckCards } from './lib.mjs';

const flags = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const db = loadDb();
const decks = loadDecks();
const pick = flags.decks ? decks.filter(d => flags.decks.split(',').includes(d.id)) : decks;
const list = flags.all ? Object.values(db) : deckCards(db, pick);
if (flags.show) {
  const d = db[flags.show];
  console.log(d.text, '\n[Trigger]', d.trigger);
  console.log(JSON.stringify(compileCard(d), (k, v) => (typeof v === 'function' ? 'fn' : v), 1));
  process.exit(0);
}
let ok = 0, bad = 0;
const lines = [];
for (const d of list.sort((a, b) => a.id.localeCompare(b.id))) {
  const c = compileCard(d);
  if (c.errors.length) { bad++; lines.push(`${d.id} ${d.name}`); for (const e of c.errors) lines.push(`    ${e}`); }
  else ok++;
  if (flags.verbose && !c.errors.length) lines.push(`ok ${d.id} ${d.name}: ${c.abilities.map(a => a.kind + (a.kw ? `:${a.kw}` : a.timings ? `:${a.timings.join('/')}` : '')).join(', ')}`);
}
console.log(lines.join('\n'));
console.log(`\n${ok + bad} cards: ${ok} fully implemented, ${bad} with text the engine doesn't handle`);
process.exit(bad ? 1 : 0);
