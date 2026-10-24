// Which cards the One Piece engine fully implements: every ability of every card's text and [Trigger] must compile
// (src/optcg/text.js plus overrides in src/optcg/cards.js). A card with any text the compiler can't read is listed
// and the check fails: nothing is silently ignored.
// Also checks that everything a compiled ability uses is something game.js handles (HANDLED).
// Usage: node tools/optcg/coverage.mjs [--decks=st01,st02] [--sets=ST03,OP01] [--all] [--show=ID] [--verbose]
import { compileCard } from '../../src/optcg/cards.js';
import { HANDLED, KEYWORDS } from '../../src/optcg/game.js';
import { loadDb, loadDecks, deckCards } from './lib.mjs';

const flags = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const db = loadDb();
const decks = loadDecks();
const pick = flags.decks ? decks.filter(d => flags.decks.split(',').includes(d.id)) : decks;
// --sets=ST03,ST04: the cards numbered in those sets, and the cards of those starter decks
function setCards(names) {
  const want = names.split(',').map(x => x.toUpperCase().replace('-', ''));
  const ids = new Set(Object.keys(db).filter(id => want.includes(id.split('-')[0])));
  for (const d of decks) if (want.includes(d.id.toUpperCase().replace('-', ''))) { ids.add(d.leader); for (const [id] of d.cards) ids.add(id); }
  return [...ids].map(id => db[id]).filter(Boolean);
}
const list = flags.all ? Object.values(db) : flags.sets ? setCards(flags.sets) : deckCards(db, pick);
if (flags.show) {
  const d = db[flags.show];
  console.log(d.text, '\n[Trigger]', d.trigger);
  console.log(JSON.stringify(compileCard(d), (k, v) => (typeof v === 'function' ? 'fn' : v), 1));
  process.exit(0);
}
// every piece of a compiled ability must be something the interpreter handles (HANDLED in game.js)
const H = Object.fromEntries(Object.entries(HANDLED).map(([k, v]) => [k, new Set(v)]));
function handled(ab) {
  const out = [];
  const need = (set, v, what) => { if (!H[set].has(v)) out.push(`${what} "${v}" isn't handled`); };
  const amount = n => { if (n == null || typeof n === 'number') return; need('amounts', n.k, 'amount'); if (n.sel) sel(n.sel); if (n.of) amount(n.of); if (n.v != null) amount(n.v); };
  const filters = fs => { for (const f of fs || []) { need('filters', f.k, 'filter'); if (f.n != null) amount(f.n); if (f.k === 'or') for (const g of f.any) filters(g); if (f.k === 'not') filters([f.f]); } };
  const sel = s => { if (!s) return; if (s.ref) need('refs', s.ref, 'reference'); else { if (s.zone) need('zones', s.zone, 'zone'); if (s.n != null) amount(s.n); } filters(s.f); };
  const cond = c => {
    if (!c) return;
    need('conds', c.k, 'condition');
    for (const x of c.all || []) cond(x);
    for (const x of c.any || []) cond(x);
    if (c.c) cond(c.c);
    amount(c.a); amount(c.b); sel(c.sel); filters(c.f);
  };
  const costs = cs => { for (const c of cs || []) { need('costs', c.op, 'cost'); filters(c.f); } };
  const steps = ss => {
    for (const s of ss || []) {
      need('steps', s.op, 'step');
      cond(s.cond); cond(s.need); sel(s.sel); amount(s.n); filters(s.f);
      if (s.dur) need('durations', s.dur, 'duration');
      if (s.op === 'restrict') need('mods', s.flag, 'restriction');
      if (s.op === 'playerFlag') need('playerFlags', s.flag, 'player flag');
      if (s.op === 'play' && s.from !== 'handOrTrash') need('zones', s.from, 'zone');
      if (s.pick) filters(s.pick.f);
      steps(s.steps); steps(s.then);
      for (const o of s.options || []) steps(o.steps);
    }
  };
  switch (ab.kind) {
    case 'keyword': if (!KEYWORDS.includes(ab.kw)) out.push(`keyword ${ab.kw}`); cond(ab.cond); break;
    case 'static': for (const m of ab.mods) { need('mods', m.k, 'permanent effect'); sel(m.sel); amount(m.n); } cond(ab.cond); break;
    case 'auto':
      for (const t of ab.timings) need('timings', t, 'timing');
      for (const k of Object.keys(ab.when || {})) need('when', k, 'event detail');
      if (ab.when) sel(ab.when.sel), sel(ab.when.battleSel);
      costs(ab.cost); cond(ab.need); steps(ab.steps); break;
    case 'activate': costs(ab.cost); cond(ab.need); steps(ab.steps); break;
    case 'event': for (const t of ab.timings) if (t !== 'main' && t !== 'counter') out.push(`event timing ${t}`); costs(ab.cost); steps(ab.steps); break;
    case 'trigger': costs(ab.cost); steps(ab.steps); break;
    case 'replace': for (const e of ab.replace.events) if (!['remove', 'koEffect', 'koBattle'].includes(e)) out.push(`replacement of ${e}`); sel(ab.replace.sel); costs(ab.replace.cost); steps(ab.replace.steps); break;
    default: out.push(`ability kind ${ab.kind}`);
  }
  return out;
}

let ok = 0, bad = 0;
const lines = [];
for (const d of list.sort((a, b) => a.id.localeCompare(b.id))) {
  const c = compileCard(d);
  const errors = [...c.errors];
  for (const ab of c.abilities) for (const e of handled(ab)) errors.push(`${ab.text} -- ${e}`);
  if (errors.length) { bad++; lines.push(`${d.id} ${d.name}`); for (const e of errors) lines.push(`    ${e}`); }
  else ok++;
  if (flags.verbose && !c.errors.length) lines.push(`ok ${d.id} ${d.name}: ${c.abilities.map(a => a.kind + (a.kw ? `:${a.kw}` : a.timings ? `:${a.timings.join('/')}` : '')).join(', ')}`);
}
console.log(lines.join('\n'));
console.log(`\n${ok + bad} cards: ${ok} fully implemented, ${bad} with text the engine doesn't handle`);
process.exit(bad ? 1 : 0);
