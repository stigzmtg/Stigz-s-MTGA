// Rules tests for the Pokémon engine: set up a board, take an action, check the result.
// Usage: node tools/ptcg/rules.mjs [filter]
import fs from 'node:fs';
import { PokemonGame, Mon } from '../../src/ptcg/game.js';
import { PokemonAI } from '../../src/ptcg/ai.js';

const db = JSON.parse(fs.readFileSync('data/ptcg/cards.json', 'utf8'));
const byName = n => Object.values(db).find(c => c.name === n);
const filler = { id: 'test', name: 'Test', cards: [['Psychic Energy', 60]] };

// a scripted player: answers from handlers by type/hint, else the AI's choice
class Scripted {
  constructor() { this.ai = new PokemonAI(); this.h = {}; }
  on(k, f) { this.h[k] = f; return this; }
  async ask(g, pid, req) { const f = this.h[req.hint] || this.h[req.type]; if (f) { const v = f(req, g); if (v !== undefined) return v; } return this.ai.ask(g, pid, req); }
}

function setup() {
  const a = new Scripted(), b = new Scripted();
  const g = new PokemonGame({ db, seed: 5, players: [{ name: 'A', deck: filler, agent: a }, { name: 'B', deck: filler, agent: b }] });
  g.throwErrors = true;
  for (const p of g.players) { p.prizes = p.deck.splice(0, 6); p.hand = []; }
  g.turn = 3; g.current = 0; g.first = 1;
  for (const p of g.players) p.turns = 2;
  const card = (pid, name) => { const d = db[name] ? db[name] : byName(name); if (!d) throw new Error('no card ' + name); const c = g.cardById(-1) || null; return Object.assign(Object.create(Object.getPrototypeOf(g.players[pid].deck[0])), { def: d, owner: pid, id: g.uid++ }); };
  const T = {
    g, a, b, A: g.players[0], B: g.players[1],
    card,
    mon(pid, name, { active = false, energy = [], damage = 0, played = 0 } = {}) {
      const m = new Mon(g, card(pid, name));
      m.playedTurn = played;
      for (const e of energy) m.energy.push(card(pid, `${e} Energy`));
      m.damage = damage;
      if (active) g.players[pid].active = m; else g.players[pid].bench.push(m);
      return m;
    },
    hand(pid, name) { const c = card(pid, name); g.players[pid].hand.push(c); return c; },
    async attack(name, pid = 0) { const act = g.legalActions(pid).find(x => x.t === 'attack' && x.name === name); if (!act) throw new Error(`attack ${name} not legal: ${g.attackBlock(g.players[pid].active, g.attacksOf(g.players[pid].active).find(x => x.name === name))}`); try { await g.attack(pid, act); } catch (e) { if (!e.gameOver) throw e; } },
    async play(cardObj, extra = {}, pid = 0) {
      const act = g.legalActions(pid).find(x => x.card === cardObj.id && Object.entries(extra).every(([k, v]) => x[k] === v));
      if (!act) throw new Error(`can't play ${cardObj.name}`);
      try { await g.doAction(pid, act); await g.checkKOs(); } catch (e) { if (!e.gameOver) throw e; }
    },
    async ability(mon, name, pid = 0) { const act = g.legalActions(pid).find(x => x.t === 'ability' && x.mon === mon.id && x.name === name); if (!act) throw new Error(`ability ${name} not usable`); await g.doAction(pid, act); await g.checkKOs(); },
  };
  return T;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const expect = (c, msg) => { if (!c) throw new Error('expected: ' + msg); };
const ONLY = process.argv[2] ? new RegExp(process.argv[2], 'i') : null;

test('Weakness doubles damage to the Active Pokémon', async T => {
  T.mon(0, 'PAF-7', { active: true, energy: ['Fire', 'Fire'] });        // Charmander: Steady Firebreathing 30
  const d = T.mon(1, 'Lunatone', { active: true });                     // weak to Grass, not Fire
  const bud = T.mon(1, 'Budew');
  await T.attack('Steady Firebreathing');
  expect(d.damage === 30, `30 to Lunatone (${d.damage})`);
  T.g.switchActive(1, bud);
  T.g.turn += 2;
  await T.attack('Steady Firebreathing');
  expect(bud.stack.length === 0 || bud.damage >= 60, 'Budew (weak to Fire) takes 60 and is Knocked Out');
  expect(T.A.prizes.length === 5, `A took a Prize (${T.A.prizes.length})`);
});
test('Resistance takes 30 off', async T => {
  T.mon(0, 'Lunatone', { active: true, energy: ['Fighting', 'Fighting'] }); // Power Gem 50
  const r = T.mon(1, 'MEG-58', { active: true });                            // Ralts: Resistance Fighting -30
  await T.attack('Power Gem');
  expect(r.damage === 20, `50 - 30 = 20 (${r.damage})`);
});
test('Knocking out a Pokémon ex takes 2 Prizes, a Mega Evolution ex 3', async T => {
  T.mon(0, 'Roaring Moon ex', { active: true, energy: ['Darkness', 'Darkness', 'Darkness'] });
  T.mon(1, 'Meowth ex', { active: true });
  T.mon(1, 'Mega Kangaskhan ex');
  await T.attack('Frenzied Gouging');
  expect(T.A.prizes.length === 4, `2 Prizes for Meowth ex (${T.A.prizes.length} left)`);
  expect(T.B.active && T.B.active.name === 'Mega Kangaskhan ex', 'B promoted Kangaskhan');
  T.g.turn += 2;
  T.A.active.damage = 0;
  await T.attack('Frenzied Gouging');
  expect(T.A.prizes.length === 1, `3 more for the Mega (${T.A.prizes.length} left)`);
});
test('Frenzied Gouging does 200 to itself', async T => {
  const m = T.mon(0, 'Roaring Moon ex', { active: true, energy: ['Darkness', 'Darkness', 'Darkness'] });
  T.mon(0, 'Budew');
  T.mon(1, 'Lunatone', { active: true }); T.mon(1, 'Solrock');
  await T.attack('Frenzied Gouging');
  expect(m.damage === 200, `200 self damage (${m.damage})`);
});
test('The player going first cannot attack or play a Supporter on turn 1', async T => {
  T.g.turn = 1; T.g.first = 0; T.A.turns = 1;
  T.mon(0, 'Lunatone', { active: true, energy: ['Fighting', 'Fighting'] });
  T.mon(1, 'Solrock', { active: true });
  const s = T.hand(0, "Boss's Orders");
  const acts = T.g.legalActions(0);
  expect(!acts.some(a => a.t === 'attack'), 'no attack');
  expect(!acts.some(a => a.card === s.id), 'no Supporter');
});
test('Evolution: not on your first turn, not the turn it was played', async T => {
  T.mon(1, 'Budew', { active: true });
  T.mon(0, 'Dreepy', { active: true, played: 3 });
  const dr = T.hand(0, 'Drakloak');
  expect(!T.g.legalActions(0).some(a => a.card === dr.id), "can't evolve a Pokémon played this turn");
  T.A.active.playedTurn = 1;
  T.A.turns = 1;
  expect(!T.g.legalActions(0).some(a => a.card === dr.id), "can't evolve on your first turn");
  T.A.turns = 2;
  await T.play(dr);
  expect(T.A.active.name === 'Drakloak', 'evolved');
});
test('Rare Candy skips the Stage 1; Infernal Reign attaches Fire Energy', async T => {
  T.mon(0, 'PAF-7', { active: true, played: 1 });
  T.mon(1, 'Budew', { active: true });
  T.A.deck.unshift(T.card(0, 'Fire Energy'), T.card(0, 'Fire Energy'), T.card(0, 'Fire Energy'));
  T.hand(0, 'Charizard ex');
  const rc = T.hand(0, 'Rare Candy');
  T.a.on('confirm', () => true);
  await T.play(rc);
  expect(T.A.active.name === 'Charizard ex', 'Charizard ex in play');
  expect(T.A.active.energy.filter(c => c.def.provides === 'Fire').length + T.A.bench.reduce((s, m) => s + m.energy.length, 0) === 3, `3 Fire Energy attached (${T.A.active.energy.length})`);
});
test('Retreat discards Energy; Asleep Pokémon cannot retreat', async T => {
  const a = T.mon(0, 'Lunatone', { active: true, energy: ['Fighting', 'Fighting'] });
  const b = T.mon(0, 'Solrock');
  T.mon(1, 'Budew', { active: true });
  a.special = 'asleep';
  expect(!T.g.legalActions(0).some(x => x.t === 'retreat'), 'asleep: no retreat');
  a.special = null;
  await T.g.doAction(0, T.g.legalActions(0).find(x => x.t === 'retreat'));
  expect(T.A.active === b && a.energy.length === 1, `retreated, paid 1 (${a.energy.length} left)`);
  expect(!T.g.legalActions(0).some(x => x.t === 'retreat'), 'only once per turn');
});
test('Poison and Burn in the Pokémon Checkup', async T => {
  const a = T.mon(0, 'Solrock', { active: true });
  T.mon(1, 'Lunatone', { active: true });
  a.poisoned = true; a.burned = true;
  await T.g.endTurn(0);
  expect(a.damage === 30, `10 poison + 20 burn (${a.damage})`);
});
test('Confused attackers can hurt themselves', async T => {
  const a = T.mon(0, 'Lunatone', { active: true, energy: ['Fighting', 'Fighting'] });
  const d = T.mon(1, 'Solrock', { active: true });
  a.special = 'confused';
  let self = 0, hit = 0;
  for (let i = 0; i < 12; i++) { a.damage = 0; d.damage = 0; T.g.turn += 2; await T.attack('Power Gem'); if (a.damage === 30) self++; if (d.damage) hit++; a.special = 'confused'; }
  expect(self > 0 && hit > 0 && self + hit === 12, `both outcomes happen (${self} self, ${hit} hit)`);
});
test('Phantom Dive spreads counters on the Bench and takes Prizes for Knock Outs', async T => {
  T.mon(0, 'Dragapult ex', { active: true, energy: ['Fire', 'Psychic'] });
  T.mon(1, 'Mega Kangaskhan ex', { active: true });
  const b1 = T.mon(1, 'Budew'), b2 = T.mon(1, 'Budew');
  await T.attack('Phantom Dive');
  expect(b1.stack.length === 0 && b2.stack.length === 0, 'both Budew (30 HP) Knocked Out by 6 counters');
  expect(T.A.prizes.length === 4, `2 Prizes (${T.A.prizes.length} left)`);
});
test('Benched Tera Pokémon ex take no damage from attacks', async T => {
  T.mon(0, 'Fezandipiti ex', { active: true, energy: ['Darkness', 'Darkness', 'Darkness'] });
  T.mon(1, 'Lunatone', { active: true });
  const t = T.mon(1, 'Wellspring Mask Ogerpon ex');
  T.a.on('opp-damage:100', () => [t.id]);
  await T.attack('Cruel Arrow');
  expect(t.damage === 0, `no damage (${t.damage})`);
});
test('Cornerstone Stance blocks attacks from Pokémon with an Ability', async T => {
  T.mon(0, 'Gholdengo ex', { active: true, energy: ['Metal'] });
  T.A.hand.push(T.card(0, 'Metal Energy'), T.card(0, 'Metal Energy'));
  const o = T.mon(1, 'Cornerstone Mask Ogerpon ex', { active: true });
  await T.attack('Make It Rain');
  expect(o.damage === 0, `no damage (${o.damage})`);
});
test('Make It Rain: 50 for each Basic Energy discarded from hand', async T => {
  T.mon(0, 'Gholdengo ex', { active: true, energy: ['Metal'] });
  for (let i = 0; i < 3; i++) T.A.hand.push(T.card(0, 'Metal Energy'));
  const d = T.mon(1, 'Mega Kangaskhan ex', { active: true });
  T.a.on('fuel:50', req => req.options);
  await T.attack('Make It Rain');
  expect(d.damage === 150, `150 (${d.damage})`);
  expect(T.A.hand.length === 0 && T.A.discard.length === 3, 'energy discarded');
});
test('Terminal Period knocks out a Pokémon with exactly 6 damage counters', async T => {
  T.mon(0, 'Mega Absol ex', { active: true, energy: ['Darkness', 'Darkness'] });
  T.mon(0, 'Budew');
  const d = T.mon(1, 'Mega Kangaskhan ex', { active: true, damage: 60 });
  T.mon(1, 'Lunatone');
  await T.attack('Terminal Period');
  expect(d.stack.length === 0, 'Knocked Out');
  expect(T.A.prizes.length === 3, `3 Prizes (${T.A.prizes.length} left)`);
});
test('Resolute Heart: Pikachu ex survives a Knock Out from full HP', async T => {
  T.mon(0, 'Roaring Moon ex', { active: true, energy: ['Darkness', 'Darkness', 'Darkness'] });
  T.g.stadium = { card: T.card(0, 'Risky Ruins'), owner: 0 };
  const p = T.mon(1, 'Pikachu ex', { active: true });
  await T.attack('Calamity Storm');
  expect(p.stack.length && T.g.hpLeft(p) === 10, `10 HP left (${T.g.hpLeft(p)})`);
});
test('Psychic Embrace attaches from the discard pile and adds 2 damage counters', async T => {
  const g = T.mon(0, 'Gardevoir ex', { active: true });
  T.A.discard.push(T.card(0, 'Psychic Energy'));
  T.mon(1, 'Lunatone', { active: true });
  await T.ability(g, 'Psychic Embrace');
  expect(g.energy.length === 1 && g.damage === 20, `1 Energy, 20 damage (${g.energy.length}, ${g.damage})`);
});
test('Tuck Tail returns Meowth ex to hand and a new Active comes in', async T => {
  T.mon(0, 'Meowth ex', { active: true, energy: ['Darkness', 'Darkness', 'Darkness'] });
  const b = T.mon(0, 'Budew');
  T.mon(1, 'Lunatone', { active: true });
  await T.attack('Tuck Tail');
  expect(T.A.active === b, 'Budew promoted');
  expect(T.A.hand.some(c => c.name === 'Meowth ex'), 'Meowth ex in hand');
});
test('Iono: both players draw one card per remaining Prize', async T => {
  T.mon(0, 'Budew', { active: true }); T.mon(1, 'Budew', { active: true });
  T.B.prizes.splice(0, 2);
  for (let i = 0; i < 5; i++) { T.hand(0, 'Psychic Energy'); T.hand(1, 'Psychic Energy'); }
  const io = T.hand(0, 'Iono');
  await T.play(io);
  expect(T.A.hand.length === 6 && T.B.hand.length === 4, `6 and 4 cards (${T.A.hand.length}, ${T.B.hand.length})`);
});
test('Item lock (Itchy Pollen) stops Items but not Supporters', async T => {
  T.mon(0, 'Budew', { active: true });
  T.mon(1, 'Budew', { active: true });
  await T.attack('Itchy Pollen');
  T.g.turn++; T.g.current = 1;
  const it = T.hand(1, 'Nest Ball'), sp = T.hand(1, 'Judge');
  const acts = T.g.legalActions(1);
  expect(!acts.some(a => a.card === it.id) && acts.some(a => a.card === sp.id), 'Nest Ball locked, Judge allowed');
});
test('Boss\'s Orders brings up a Benched Pokémon', async T => {
  T.mon(0, 'Budew', { active: true });
  T.mon(1, 'Lunatone', { active: true });
  const s = T.mon(1, 'Solrock');
  await T.play(T.hand(0, "Boss's Orders"));
  expect(T.B.active === s, 'Solrock is Active');
});
test('Deck out: no card to draw at the start of the turn loses', async T => {
  T.mon(0, 'Budew', { active: true }); T.mon(1, 'Budew', { active: true });
  T.B.deck = [];
  T.g.current = 0;
  try { await T.g.takeTurn(); } catch (e) { if (!e.gameOver) throw e; }
  expect(T.g.over && T.g.winner === 0, 'A wins when B cannot draw');
});
test('Bench limit 5; Area Zero Underdepths allows 8 with a Tera Pokémon', async T => {
  T.mon(0, 'Wellspring Mask Ogerpon ex', { active: true });
  for (let i = 0; i < 5; i++) T.mon(0, 'Budew');
  const extra = T.hand(0, 'Budew');
  expect(!T.g.legalActions(0).some(a => a.card === extra.id), 'bench full at 5');
  T.g.stadium = { card: T.card(0, 'Area Zero Underdepths'), owner: 0 };
  expect(T.g.legalActions(0).some(a => a.card === extra.id), 'room for more with Area Zero');
});

let pass = 0, fail = 0;
for (const t of tests) {
  if (ONLY && !ONLY.test(t.name)) continue;
  try { await t.fn(setup()); pass++; } catch (e) { fail++; console.log(`FAIL ${t.name}: ${e.message}${e.message.startsWith('expected') ? '' : '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n')}`); }
}
console.log(`\n${pass} passed, ${fail} failed`);
