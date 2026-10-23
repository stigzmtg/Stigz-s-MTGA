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

// ---- the newer decks
test('Seek Inspiration uses the discarded Pokémon\'s attack; Boomerang Energy comes back', async T => {
  const s = T.mon(0, 'Slowking', { active: true, energy: ['Psychic'] });
  const boom = T.card(0, 'Boomerang Energy'); s.energy.push(boom);
  const d = T.mon(1, 'Mega Kangaskhan ex', { active: true });
  const b1 = T.mon(1, 'Solrock'), b2 = T.mon(1, 'Budew');
  T.A.deck.unshift(T.card(0, 'Kyurem'));
  await T.attack('Seek Inspiration');
  expect(T.A.discard.some(c => c.name === 'Kyurem'), 'Kyurem discarded from the top');
  expect(d.damage === 110 && b1.damage === 110 && b2.stack.length === 0, `Trifrost: 110 to 3 Pokémon (${d.damage}, ${b1.damage}, Budew KO ${!b2.stack.length})`);
  expect(s.energy.length === 1 && s.energy[0] === boom, `only Boomerang Energy is back on Slowking (${s.energy.map(c => c.name)})`);
});
test('Seek Inspiration does nothing when the top card is a Pokémon with a Rule Box', async T => {
  T.mon(0, 'Slowking', { active: true, energy: ['Psychic', 'Psychic'] });
  const d = T.mon(1, 'Solrock', { active: true });
  T.A.deck.unshift(T.card(0, 'Latias ex'));
  await T.attack('Seek Inspiration');
  expect(d.damage === 0 && T.A.discard.some(c => c.name === 'Latias ex'), `no damage (${d.damage})`);
});
test("Night Joker uses a Benched N's Pokémon's attack without paying its cost", async T => {
  T.mon(0, "N's Zoroark ex", { active: true, energy: ['Darkness', 'Darkness'] });
  T.mon(0, "N's Reshiram");
  const d = T.mon(1, 'Mega Kangaskhan ex', { active: true });
  T.a.on('copy-attack', req => req.options.find(o => o.atk === 'Virtuous Flame').value);
  await T.attack('Night Joker');
  expect(d.damage === 170, `Virtuous Flame for 170 (${d.damage})`);
  T.A.bench = [];
  expect(!T.g.legalActions(0).some(a => a.name === 'Night Joker'), "no N's Pokémon on the Bench: nothing to copy");
});
test('Festival Lead: with Festival Grounds Seaking attacks twice, without it once', async T => {
  const s = T.mon(0, 'Seaking', { active: true, energy: ['Fire'] });
  const d = T.mon(1, 'Mega Kangaskhan ex', { active: true });
  const atk = async () => { const act = T.g.legalActions(0).find(x => x.t === 'attack' && x.name === 'Rapid Draw'); try { await T.g.attack(0, act); await T.g.attackAgain(0, s); } catch (e) { if (!e.gameOver) throw e; } };
  T.g.stadium = { card: T.card(0, 'Festival Grounds'), owner: 0 };
  const h = T.A.hand.length;
  await atk();
  expect(d.damage === 120 && T.A.hand.length === h + 4, `two Rapid Draws: 120 damage, 4 cards (${d.damage}, +${T.A.hand.length - h})`);
  T.g.stadium = null; d.damage = 0; T.g.turn += 2;
  await atk();
  expect(d.damage === 60, `one attack without Festival Grounds (${d.damage})`);
});
test('Festival Lead: after a Knock Out the second attack hits the new Active Pokémon', async T => {
  const s = T.mon(0, 'Seaking', { active: true, energy: ['Fire'] });
  T.g.stadium = { card: T.card(0, 'Festival Grounds'), owner: 0 };
  T.mon(1, 'Budew', { active: true });
  const next = T.mon(1, 'Solrock');
  const act = T.g.legalActions(0).find(x => x.t === 'attack' && x.name === 'Rapid Draw');
  try { await T.g.attack(0, act); await T.g.attackAgain(0, s); } catch (e) { if (!e.gameOver) throw e; }
  expect(T.A.prizes.length === 5 && T.B.active === next && next.damage === 60, `Budew KO, Solrock took 60 (${next.damage})`);
});
test('Festival Grounds: Pokémon with Energy attached shake off Special Conditions', async T => {
  T.mon(0, 'Munkidori', { active: true, energy: ['Psychic', 'Psychic'] });
  const d = T.mon(1, 'Solrock', { active: true, energy: ['Fighting'] });
  T.g.stadium = { card: T.card(1, 'Festival Grounds'), owner: 1 };
  await T.attack('Mind Bend');
  expect(!d.special, 'not Confused');
});
test('Wild Growth: each Basic {G} Energy provides {G}{G}, and Syrup Storm counts it', async T => {
  const h = T.mon(0, 'Hydrapple ex', { active: true, energy: ['Grass'] });
  expect(!T.g.legalActions(0).some(a => a.name === 'Syrup Storm'), 'one Grass Energy alone does not pay {C}{C}');
  T.mon(0, 'Meganium', { energy: ['Grass'] });
  const d = T.mon(1, 'Mega Kangaskhan ex', { active: true });
  expect(T.g.energyTypes(h).length === 2, 'Grass Energy provides 2');
  await T.attack('Syrup Storm');
  expect(d.damage === 150, `30 + 30 x 4 {G} Energy = 150 (${d.damage})`);
});
test('Mysterious Rock Inn: Crustle takes no damage from Pokémon ex, but does from others', async T => {
  T.mon(0, 'Mega Kangaskhan ex', { active: true, energy: ['Psychic', 'Psychic', 'Psychic'] });
  const c = T.mon(1, 'Crustle', { active: true });
  await T.attack('Rapid-Fire Combo');
  expect(c.damage === 0, `no damage from Mega Kangaskhan ex (${c.damage})`);
  T.A.active = null;
  T.mon(0, 'Budew', { active: true });
  T.g.turn += 2;
  await T.attack('Itchy Pollen');
  expect(c.damage === 10, `Budew does 10 (${c.damage})`);
});
test("Hide 'n' Sneak and Mist Energy stop attack effects but not damage", async T => {
  T.mon(0, 'Munkidori', { active: true, energy: ['Psychic', 'Psychic'] });
  const b = T.mon(1, 'Banette', { active: true });
  await T.attack('Mind Bend');
  expect(b.damage === 60 && !b.special, `60 damage, not Confused (${b.damage}, ${b.special})`);
  T.B.active = null;
  const s = T.mon(1, 'Solrock', { active: true });
  s.energy.push(T.card(1, 'Mist Energy'));
  T.g.turn += 2;
  await T.attack('Mind Bend');
  expect(s.damage === 60 && !s.special, `Mist Energy: 60 damage, not Confused (${s.damage}, ${s.special})`);
});
test("Powerful Hand places 2 damage counters per card in hand; Hide 'n' Sneak stops it", async T => {
  T.mon(0, 'Alakazam', { active: true, energy: ['Psychic'] });
  for (let i = 0; i < 5; i++) T.hand(0, 'Psychic Energy');
  const d = T.mon(1, 'Mega Kangaskhan ex', { active: true });
  await T.attack('Powerful Hand');
  expect(d.damage === 100, `10 counters (${d.damage})`);
  T.B.active = null;
  const s = T.mon(1, 'Shuppet', { active: true });
  T.g.turn += 2;
  await T.attack('Powerful Hand');
  expect(s.damage === 0, `Shuppet untouched (${s.damage})`);
});
test("Cursed Blast can't target a Pokémon with Hide 'n' Sneak", async T => {
  const dk = T.mon(0, 'Dusknoir');
  T.mon(0, 'Budew', { active: true });
  T.mon(1, 'Shuppet', { active: true });
  expect(!T.g.legalActions(0).some(a => a.name === 'Cursed Blast'), 'no legal target');
  const s = T.mon(1, 'Solrock');
  await T.ability(dk, 'Cursed Blast');
  expect(s.stack.length === 0 && T.A.prizes.length === 5, 'Solrock takes the 13 counters');
});
test('Legacy Energy: the opponent takes 1 fewer Prize card, once per game', async T => {
  T.mon(0, 'Roaring Moon ex', { active: true, energy: ['Darkness', 'Darkness', 'Darkness'] });
  T.g.stadium = { card: T.card(0, 'Risky Ruins'), owner: 0 };
  const d = T.mon(1, 'Dhelmise', { active: true });
  d.energy.push(T.card(1, 'Legacy Energy'));
  const e = T.mon(1, 'Dhelmise');
  e.energy.push(T.card(1, 'Legacy Energy'));
  T.mon(1, 'Budew');
  await T.attack('Calamity Storm');
  expect(d.stack.length === 0 && T.A.prizes.length === 6, `Knocked Out, no Prize taken (${T.A.prizes.length} left)`);
  T.g.switchActive(1, e);
  T.g.turn += 2;
  T.g.stadium = { card: T.card(0, 'Risky Ruins'), owner: 0 };
  await T.attack('Calamity Storm');
  expect(e.stack.length === 0 && T.A.prizes.length === 5, `the second one gives its Prize (${T.A.prizes.length} left)`);
});
test('Legacy Energy provides any type of Energy, one at a time', async T => {
  const m = T.mon(0, 'Lunatone', { active: true });
  m.energy.push(T.card(0, 'Legacy Energy'));
  T.mon(1, 'Solrock', { active: true });
  expect(!T.g.legalActions(0).some(a => a.name === 'Power Gem'), 'one Energy is not enough for {F}{F}');
  m.energy.push(T.card(0, 'Fighting Energy'));
  expect(T.g.legalActions(0).some(a => a.name === 'Power Gem'), 'Legacy + Fighting pays {F}{F}');
});
test('Forest of Vitality: {G} Pokémon can evolve the turn they come into play', async T => {
  const c = T.mon(0, 'Chikorita', { active: true, played: 3 });
  const dr = T.mon(0, 'Dreepy', { played: 3 });
  T.mon(1, 'Budew', { active: true });
  const b = T.hand(0, 'Bayleef'), m = T.hand(0, 'Meganium'), dk = T.hand(0, 'Drakloak');
  expect(!T.g.legalActions(0).some(a => a.card === b.id), 'no evolving without the Stadium');
  T.g.stadium = { card: T.card(0, 'Forest of Vitality'), owner: 0 };
  await T.play(b); await T.play(m);
  expect(c.name === 'Meganium', `Chikorita -> Bayleef -> Meganium in one turn (${c.name})`);
  expect(!T.g.legalActions(0).some(a => a.card === dk.id && a.target === dr.id), 'Dreepy (not {G}) still waits');
});
test("Strange Timepiece devolves a {P} Pokémon, which can't evolve again this turn", async T => {
  const m = T.mon(0, 'MEG-54', { active: true });
  m.stack.push(T.card(0, 'Kadabra'), T.card(0, 'Alakazam'));
  T.mon(1, 'Budew', { active: true });
  T.a.on('devolve-n', req => 2);
  await T.play(T.hand(0, 'Strange Timepiece'));
  expect(m.name === 'Abra' && T.A.hand.filter(c => c.name === 'Kadabra' || c.name === 'Alakazam').length === 2, `back to Abra, 2 cards in hand (${m.name})`);
  expect(!T.g.legalActions(0).some(a => a.t === 'evolve' && a.target === m.id), "it can't evolve this turn");
});
test('Telepathic Psychic Energy benches 2 Basic {P} Pokémon when attached from hand', async T => {
  const s = T.mon(0, 'Slowpoke', { active: true });
  T.mon(1, 'Budew', { active: true });
  T.A.deck.unshift(T.card(0, 'Slowpoke'), T.card(0, 'Latias ex'));
  const e = T.hand(0, 'Telepathic Psychic Energy');
  await T.play(e, { target: s.id });
  expect(T.A.bench.length === 2 && T.g.energyTypes(s)[0] === 'Psychic', `2 benched, provides {P} (${T.A.bench.map(m => m.name)})`);
});
test("Jamming Tower switches off Tools (Hero's Cape)", async T => {
  const m = T.mon(0, 'Budew', { active: true });
  m.tool = T.card(0, "Hero's Cape");
  T.mon(1, 'Budew', { active: true });
  expect(T.g.maxHp(m) === 130, `130 HP with Hero's Cape (${T.g.maxHp(m)})`);
  T.g.stadium = { card: T.card(1, 'Jamming Tower'), owner: 1 };
  expect(T.g.maxHp(m) === 30, `30 HP under Jamming Tower (${T.g.maxHp(m)})`);
});
test('Evolution Jammer: no evolving from the hand (or Rare Candy) next turn', async T => {
  T.mon(0, 'Bronzong', { active: true, energy: ['Psychic'] });
  T.mon(1, 'Duskull', { active: true, played: 1 });
  await T.attack('Evolution Jammer');
  T.g.turn++; T.g.current = 1;
  const dc = T.hand(1, 'Dusclops'), dn = T.hand(1, 'Dusknoir'), rc = T.hand(1, 'Rare Candy');
  const acts = T.g.legalActions(1);
  expect(!acts.some(a => a.card === dc.id) && !acts.some(a => a.card === rc.id), 'evolution and Rare Candy blocked');
  T.g.turn += 2;
  expect(T.g.legalActions(1).some(a => a.card === dc.id), 'allowed again the turn after');
  expect(dn, 'Dusknoir in hand');
});
test('Spiky Energy and Lucky Helmet trigger when the Active Pokémon is damaged', async T => {
  const att = T.mon(0, 'Lunatone', { active: true, energy: ['Fighting', 'Fighting'] });
  const d = T.mon(1, 'Mega Kangaskhan ex', { active: true });
  d.energy.push(T.card(1, 'Spiky Energy'));
  d.tool = T.card(1, 'Lucky Helmet');
  const h = T.B.hand.length;
  await T.attack('Power Gem');
  expect(att.damage === 20 && T.B.hand.length === h + 2, `2 counters on Lunatone, 2 cards drawn (${att.damage}, +${T.B.hand.length - h})`);
});
test('Ready to Ram puts 6 damage counters on the Pokémon that damages Bouffalant', async T => {
  T.mon(0, 'SSP-151', { active: true, energy: ['Psychic', 'Psychic'] });
  T.mon(1, 'Lunatone', { active: true, energy: ['Fighting', 'Fighting'] });
  await T.attack('Ready to Ram');
  T.g.turn++; T.g.current = 1;
  await T.attack('Power Gem', 1);
  expect(T.B.active.damage === 100, `40 from Ready to Ram, then 6 counters on Lunatone (${T.B.active && T.B.active.damage})`);
});
test("Curly Wall: with 2 Bouffalant, Basic {C} Pokémon take 60 less", async T => {
  T.mon(0, 'Lunatone', { active: true, energy: ['Fighting', 'Fighting'] });
  const b = T.mon(1, 'SSP-151', { active: true });
  await T.attack('Power Gem');
  expect(b.damage === 100, `alone: 50 x2 Weakness = 100 (${b.damage})`);
  b.damage = 0; T.mon(1, 'SCR-119'); T.g.turn += 2;
  await T.attack('Power Gem');
  expect(b.damage === 40, `with a second Bouffalant: 100 - 60 = 40 (${b.damage})`);
});
test('Durable Body: Annihilape can survive a Knock Out on heads', async T => {
  T.mon(0, 'Roaring Moon ex', { active: true, energy: ['Darkness', 'Darkness', 'Darkness'] });
  let saved = 0, ko = 0;
  for (let i = 0; i < 12; i++) {
    T.B.active = null; T.B.bench = [T.B.bench[0] || new Mon(T.g, T.card(1, 'Budew'))];
    const a = T.mon(1, 'Annihilape', { active: true });
    T.g.stadium = { card: T.card(0, 'Risky Ruins'), owner: 0 };
    T.g.turn += 2;
    await T.attack('Calamity Storm');
    if (a.stack.length && T.g.hpLeft(a) === 10) saved++; else if (!a.stack.length) ko++;
  }
  expect(saved > 0 && ko > 0 && saved + ko === 12, `both outcomes (${saved} saved, ${ko} KO)`);
});
test("Gladion's Final Battle: only as the last card in hand; +80 for Pokémon without a Rule Box", async T => {
  T.mon(0, 'Lunatone', { active: true, energy: ['Fighting', 'Fighting'] });
  const d = T.mon(1, 'Mega Kangaskhan ex', { active: true });
  const gl = T.hand(0, "Gladion's Final Battle");
  const other = T.hand(0, 'Psychic Energy');
  expect(!T.g.legalActions(0).some(a => a.card === gl.id), 'not with another card in hand');
  T.A.hand.splice(T.A.hand.indexOf(other), 1);
  await T.play(gl);
  await T.attack('Power Gem');
  expect(d.damage === 260, `(50 + 80) x2 = 260 (${d.damage})`);
});
test('Thunder Raid only hits a Benched Pokémon ex', async T => {
  T.mon(0, 'Zeraora', { active: true, energy: ['Lightning', 'Lightning', 'Lightning'] });
  const d = T.mon(1, 'Budew', { active: true });
  const b = T.mon(1, 'Solrock'), ex = T.mon(1, 'Meowth ex');
  await T.attack('Thunder Raid');
  expect(d.damage === 0 && b.damage === 0 && ex.stack.length === 0 && T.A.active.energy.length === 0, `Meowth ex Knocked Out, Energy discarded (${ex.damage})`);
});
test('Bounce Back switches out the Defending Pokémon (Mist Energy stops it)', async T => {
  T.mon(0, 'Metagross', { active: true, energy: ['Metal'] });
  const d = T.mon(1, 'Solrock', { active: true });
  const b = T.mon(1, 'Lunatone');
  await T.attack('Bounce Back');
  expect(T.B.active === b && d.damage === 60, `Lunatone is Active, Solrock took 60 (${d.damage})`);
  b.energy.push(T.card(1, 'Mist Energy'));
  T.g.turn += 2;
  await T.attack('Bounce Back');
  expect(T.B.active === b, 'Mist Energy keeps Lunatone in');
});
test('Matcha Spin needs 6 Hide \'n\' Sneak Pokémon in the discard pile', async T => {
  T.mon(0, 'Sinistcha', { active: true, energy: ['Grass'] });
  const d = T.mon(1, 'Solrock', { active: true }), b = T.mon(1, 'Lunatone');
  for (let i = 0; i < 5; i++) T.A.discard.push(T.card(0, 'Shuppet'));
  await T.attack('Matcha Spin');
  expect(d.damage === 0 && b.damage === 0, 'nothing with 5');
  T.A.discard.push(T.card(0, 'Poltchageist'));
  T.g.turn += 2;
  await T.attack('Matcha Spin');
  expect(d.damage === 40 && b.damage === 40, `4 counters on each with 6 (${d.damage}, ${b.damage})`);
});
test('Kadabra and Alakazam draw when evolved from the hand', async T => {
  T.mon(0, 'MEG-54', { active: true, played: 1 });
  T.mon(1, 'Budew', { active: true });
  T.a.on('confirm', () => true);
  const rc = T.hand(0, 'Rare Candy'); T.hand(0, 'Alakazam');
  await T.play(rc);
  expect(T.A.active.name === 'Alakazam' && T.A.hand.length === 3, `Alakazam drew 3 (${T.A.hand.length} in hand)`);
});

// ---- Basic Box
test("Cobalt Command: +20 per Iron Crown ex for other Future Pokémon's attacks, not Iron Crown's own", async T => {
  T.mon(0, 'Iron Leaves ex', { active: true, energy: ['Grass', 'Grass', 'Grass'] });     // Prism Edge 180
  T.mon(0, 'Iron Crown ex'); T.mon(0, 'Iron Crown ex');
  const d = T.mon(1, 'Mega Kangaskhan ex', { active: true });
  await T.attack('Prism Edge');
  expect(d.damage === 220, `180 + 2 x 20 = 220 (${d.damage})`);
  T.A.active = null; T.A.bench = [];
  T.mon(0, 'Iron Crown ex', { active: true, energy: ['Psychic', 'Psychic', 'Psychic'] }); T.mon(0, 'Iron Crown ex');
  const e = T.mon(1, 'Solrock'); T.B.active = null; T.g.switchActive(1, e); T.B.bench = T.B.bench.filter(m => m !== e);
  T.mon(1, 'Lunatone');
  T.g.turn += 2;
  T.a.on('opp-damage-pierce:50', req => req.options);
  await T.attack('Twin Shotels');
  expect(e.damage === 50, `Iron Crown's own attack gets no bonus (${e.damage})`);
});
test('Twin Shotels: 50 to 2 Pokémon, ignoring Weakness and Bench protection (Tera, Flower Curtain)', async T => {
  T.mon(0, 'Iron Crown ex', { active: true, energy: ['Psychic', 'Psychic', 'Psychic'] });
  const d = T.mon(1, 'Passimian', { active: true });                    // weak to {P}: Weakness would double it
  const tera = T.mon(1, 'Wellspring Mask Ogerpon ex');                  // Benched Tera Pokémon ex
  T.mon(1, 'Shaymin');                                                   // Flower Curtain
  const plain = T.mon(1, 'Solrock');
  T.a.on('opp-damage-pierce:50', () => [tera.id, plain.id]);
  await T.attack('Twin Shotels');
  expect(tera.damage === 50 && plain.damage === 50 && d.damage === 0, `50 each through Tera and Flower Curtain (${tera.damage}, ${plain.damage})`);
  T.g.turn += 2;
  const l = T.mon(1, 'Lunatone');
  T.a.on('opp-damage-pierce:50', () => [d.id, l.id]);
  await T.attack('Twin Shotels');
  expect(d.damage === 50, `no Weakness or Resistance on the Active either (${d.damage})`);
});
test('Coordinated Throwing: 20 for each of your Basic Pokémon in play', async T => {
  T.mon(0, 'Passimian', { active: true, energy: ['Fighting', 'Fighting'] });
  T.mon(0, 'Budew'); T.mon(0, 'Lunatone');
  const dc = T.mon(0, 'Dusclops');
  const d = T.mon(1, 'Mega Kangaskhan ex', { active: true });
  await T.attack('Coordinated Throwing');
  expect(d.damage === 120 && dc, `3 Basic Pokémon (Dusclops is a Stage 1): 60 x2 Weakness = 120 (${d.damage})`);
});

// ---- the third wave of decks: one test for every card with more than plain damage
const canAttack = (T, name, pid = 0) => T.g.legalActions(pid).some(a => a.t === 'attack' && a.name === name);
const canPlay = (T, card, pid = 0) => T.g.legalActions(pid).some(a => a.card === card.id);
const evolved = (T, pid, names, opts = {}) => { const m = T.mon(pid, names[0], opts); for (const n of names.slice(1)) m.stack.push(T.card(pid, n)); return m; };

// Mega Excadrill ex
test('Iron Tackle: 50 damage and 10 to itself', async T => {
  const b = T.mon(0, 'Beldum', { active: true, energy: ['Metal', 'Metal', 'Metal'] });
  const d = T.mon(1, 'Mega Kangaskhan ex', { active: true });
  await T.attack('Iron Tackle');
  expect(d.damage === 50 && b.damage === 10, `50 and 10 (${d.damage}, ${b.damage})`);
});
test('Metal Maker attaches Basic {M} Energy from the top 4 and puts the rest on the bottom', async T => {
  const a = T.mon(0, 'Beldum', { active: true });
  const mt = evolved(T, 0, ['Beldum', 'Metang']);
  T.mon(1, 'Budew', { active: true });
  const judge = T.card(0, 'Judge');
  T.A.deck.unshift(T.card(0, 'Metal Energy'), T.card(0, 'Psychic Energy'), T.card(0, 'Metal Energy'), judge);
  T.a.on('attach', req => req.options).on('attach:Metal', () => [a.id]);
  const n = T.A.deck.length;
  await T.ability(mt, 'Metal Maker');
  expect(a.energy.length === 2 && T.A.deck.length === n - 2, `2 Metal Energy attached (${a.energy.length})`);
  expect(T.A.deck.slice(-2).includes(judge), 'the other cards went to the bottom');
  expect(!T.g.legalActions(0).some(x => x.name === 'Metal Maker'), 'once per turn');
});
test('Undermine discards the top 2 of the opponent\'s deck; Maximum Drilling +130 with 2 extra Energy', async T => {
  const x = T.mon(0, 'Mega Excadrill ex', { active: true, energy: ['Metal', 'Metal'] });
  const d = T.mon(1, 'Mega Lucario ex', { active: true });
  const deck = T.B.deck.length, disc = T.B.discard.length;
  await T.attack('Undermine');
  expect(d.damage === 90 && T.B.deck.length === deck - 2 && T.B.discard.length === disc + 2, `90, 2 cards milled (${d.damage})`);
  x.energy.push(T.card(0, 'Metal Energy')); d.damage = 0; T.g.turn += 2;
  await T.attack('Maximum Drilling');
  expect(d.damage === 200, `exactly the cost: 200 (${d.damage})`);
  x.energy.push(T.card(0, 'Metal Energy')); d.damage = 0; T.g.turn += 2;
  await T.attack('Maximum Drilling');
  expect(d.damage === 200, `1 extra: still 200 (${d.damage})`);
  x.energy.push(T.card(0, 'Metal Energy')); d.damage = 0; T.g.turn += 2;
  await T.attack('Maximum Drilling');
  expect(d.damage === 330, `2 extra: 330 (${d.damage})`);
});
test('Sonic Ripper shuffles its Energy into the deck and does 220 to any opposing Pokémon', async T => {
  const s = T.mon(0, 'Mega Skarmory ex', { active: true, energy: ['Metal', 'Metal', 'Metal'] });
  T.mon(1, 'Budew', { active: true });
  const k = T.mon(1, 'Mega Kangaskhan ex');
  T.a.on('opp-damage:220', () => [k.id]);
  const n = T.A.deck.length;
  await T.attack('Sonic Ripper');
  expect(k.damage === 220 && s.energy.length === 0 && T.A.deck.length === n + 3, `220 on the Bench, 3 Energy back in the deck (${k.damage})`);
});
// Mega Lucario ex
test("Accelerating Stab and Mega Brave can't be used two turns in a row (other attacks can)", async T => {
  T.mon(0, 'Riolu', { active: true, energy: ['Fighting'] });
  T.mon(1, 'Mega Kangaskhan ex', { active: true });
  await T.attack('Accelerating Stab');
  T.g.turn += 2;
  expect(!canAttack(T, 'Accelerating Stab'), 'not the next turn');
  T.g.turn += 2;
  expect(canAttack(T, 'Accelerating Stab'), 'again the turn after');
  T.A.active = null;
  T.mon(0, 'Mega Lucario ex', { active: true, energy: ['Fighting', 'Fighting'] });
  await T.attack('Mega Brave');
  T.g.turn += 2;
  expect(!canAttack(T, 'Mega Brave') && canAttack(T, 'Aura Jab'), 'Mega Brave locked, Aura Jab fine');
});
test('Aura Jab attaches up to 3 Basic {F} Energy from the discard pile to the Bench', async T => {
  T.mon(0, 'Mega Lucario ex', { active: true, energy: ['Fighting'] });
  const b1 = T.mon(0, 'Riolu'), b2 = T.mon(0, 'Makuhita');
  for (let i = 0; i < 4; i++) T.A.discard.push(T.card(0, 'Fighting Energy'));
  const d = T.mon(1, 'Mega Kangaskhan ex', { active: true });
  T.a.on('attach', req => req.options);
  await T.attack('Aura Jab');
  expect(d.damage === 260 && b1.energy.length + b2.energy.length === 3 && T.A.discard.length === 1, `260 (x2), 3 attached (${d.damage}, ${b1.energy.length + b2.energy.length})`);
});
test('Heave-Ho Catcher drags up a Benched Pokémon as Hariyama evolves; Wild Press does 70 to itself', async T => {
  const mk = T.mon(0, 'Makuhita', { active: true, played: 1, energy: ['Fighting', 'Fighting', 'Fighting'] });
  T.mon(1, 'Budew', { active: true });
  const lat = T.mon(1, 'Latias ex');
  T.a.on('confirm', () => true).on('gust', () => [lat.id]);
  await T.play(T.hand(0, 'Hariyama'));
  expect(mk.name === 'Hariyama' && T.B.active === lat, 'Latias ex dragged up');
  await T.attack('Wild Press');
  expect(lat.damage === 180 && mk.damage === 70, `210 - 30 Resistance, 70 to itself (${lat.damage}, ${mk.damage})`);
});
// Mega Sharpedo ex
test('Reckless Charge does 10 to itself; Greedy Fang draws 2; Hungry Jaws +150 once damaged', async T => {
  const c = T.mon(0, 'Carvanha', { active: true, energy: ['Darkness'] });
  const d = T.mon(1, 'Mega Lucario ex', { active: true });
  await T.attack('Reckless Charge');
  expect(d.damage === 30 && c.damage === 10, `30 and 10 (${d.damage}, ${c.damage})`);
  T.A.active = null; d.damage = 0; T.g.turn += 2;
  const s = T.mon(0, 'Mega Sharpedo ex', { active: true, energy: ['Darkness', 'Darkness'] });
  await T.attack('Greedy Fang');
  expect(d.damage === 70 && T.A.hand.length === 2, `70, 2 cards (${d.damage}, ${T.A.hand.length})`);
  d.damage = 0; T.g.turn += 2;
  await T.attack('Hungry Jaws');
  expect(d.damage === 120, `undamaged: 120 (${d.damage})`);
  d.damage = 0; s.damage = 10; T.g.turn += 2;
  await T.attack('Hungry Jaws');
  expect(d.damage === 270, `with a damage counter: 270 (${d.damage})`);
});
test('Sinister Surge attaches a {D} Energy from the deck to a Benched {D} Pokémon, which takes 2 counters', async T => {
  const t = evolved(T, 0, ['Toxel', 'Toxtricity']);
  const c = T.mon(0, 'Carvanha');
  T.mon(0, 'Budew', { active: true }); T.mon(1, 'Budew', { active: true });
  T.A.deck.push(T.card(0, 'Darkness Energy'));
  T.a.on('attach-surge:Darkness', () => [c.id]);
  await T.ability(t, 'Sinister Surge');
  expect(c.energy.length === 1 && c.energy[0].name === 'Darkness Energy' && c.damage === 20, `Energy and 20 damage (${c.energy.length}, ${c.damage})`);
});
test('Attract Customers: a Supporter from the top 6, only from the Active Spot', async T => {
  const ta = T.mon(0, 'Tatsugiri', { active: true }); const b = T.mon(0, 'Tatsugiri');
  T.mon(1, 'Budew', { active: true });
  T.A.deck.splice(3, 0, T.card(0, 'Judge'));
  expect(!T.g.legalActions(0).some(x => x.name === 'Attract Customers' && x.mon === b.id), 'not from the Bench');
  await T.ability(ta, 'Attract Customers');
  expect(T.A.hand.some(c => c.name === 'Judge'), 'Judge in hand');
});
// Rocket's Honchkrow
test('Deceit finds a Supporter; Torment locks one attack for a turn (not through Mist Energy)', async T => {
  T.mon(0, "Team Rocket's Murkrow", { active: true, energy: ['Darkness', 'Darkness'] });
  const k = T.mon(1, 'Mega Kangaskhan ex', { active: true, energy: ['Psychic', 'Psychic', 'Psychic'] });
  T.A.deck.push(T.card(0, 'Judge'));
  await T.attack('Deceit');
  expect(T.A.hand.some(c => c.name === 'Judge'), 'Judge found');
  T.g.turn += 2;
  await T.attack('Torment');
  T.g.turn++; T.g.current = 1;
  expect(k.damage === 30 && !canAttack(T, 'Rapid-Fire Combo', 1), 'Rapid-Fire Combo locked');
  T.g.turn++; T.g.current = 0;
  k.energy.push(T.card(1, 'Mist Energy'));
  await T.attack('Torment');
  T.g.turn++; T.g.current = 1;
  expect(canAttack(T, 'Rapid-Fire Combo', 1), 'Mist Energy stops Torment');
});
test('Rocket Feathers: 60 for each Team Rocket Supporter discarded from hand', async T => {
  T.mon(0, "Team Rocket's Honchkrow", { active: true, energy: ['Darkness', 'Darkness'] });
  const d = T.mon(1, 'Mega Lucario ex', { active: true });
  for (const n of ["Team Rocket's Ariana", "Team Rocket's Archer", "Team Rocket's Giovanni"]) T.hand(0, n);
  const lil = T.hand(0, "Lillie's Determination");
  T.a.on('fuel:60', req => req.options);
  await T.attack('Rocket Feathers');
  expect(d.damage === 180 && T.A.hand.length === 1 && T.A.hand[0] === lil, `180, Lillie's kept (${d.damage})`);
});
test('Hacking: you discard a card, then your opponent does', async T => {
  T.mon(0, "Team Rocket's Porygon", { active: true, energy: ['Psychic'] });
  T.mon(1, 'Budew', { active: true });
  T.hand(0, 'Judge'); T.hand(0, 'Psychic Energy'); T.hand(1, "Boss's Orders");
  await T.attack('Hacking');
  expect(T.A.hand.length === 1 && T.B.hand.length === 0 && T.B.discard.some(c => c.name === "Boss's Orders"), 'one card each');
});
test('R Command: 20 for each Team Rocket Supporter in your discard pile', async T => {
  evolved(T, 0, ["Team Rocket's Porygon", "Team Rocket's Porygon2"], { active: true, energy: ['Psychic', 'Psychic', 'Psychic'] });
  const d = T.mon(1, 'Mega Lucario ex', { active: true });
  for (const n of ["Team Rocket's Ariana", "Team Rocket's Archer", "Team Rocket's Giovanni", "Team Rocket's Proton", "Lillie's Determination"]) T.A.discard.push(T.card(0, n));
  await T.attack('R Command');
  expect(d.damage === 80, `4 x 20 = 80 (${d.damage})`);
});
test("Repelling Veil keeps attack effects off Basic Team Rocket's Pokémon", async T => {
  T.mon(0, 'Munkidori', { active: true, energy: ['Psychic', 'Psychic'] });
  const m = T.mon(1, "Team Rocket's Murkrow", { active: true });
  await T.attack('Mind Bend');
  expect(m.special === 'confused', 'Confused without Articuno');
  m.special = null; m.damage = 0;
  T.mon(1, "Team Rocket's Articuno");
  T.g.turn += 2;
  await T.attack('Mind Bend');
  expect(m.damage === 60 && !m.special, `damage still lands, no Confusion (${m.damage})`);
});
test("Dark Frost +60 with Team Rocket's Energy, which provides 2 Energy", async T => {
  const ar = T.mon(0, "Team Rocket's Articuno", { active: true, energy: ['Water'] });
  ar.energy.push(T.card(0, "Team Rocket's Energy"));
  const d = T.mon(1, 'Mega Lucario ex', { active: true });
  await T.attack('Dark Frost');
  expect(d.damage === 120, `Water + Team Rocket's Energy pays {W}{C}{C}: 120 (${d.damage})`);
});
test("Gemstone Mimicry copies an attack of the opponent's Active Tera Pokémon", async T => {
  T.mon(0, "Team Rocket's Mimikyu", { active: true, energy: ['Psychic', 'Psychic'] });
  T.mon(1, 'Budew', { active: true });
  expect(!canAttack(T, 'Gemstone Mimicry'), 'not against a non-Tera Pokémon');
  T.B.active = null;
  const og = T.mon(1, 'Teal Mask Ogerpon ex', { active: true });
  await T.attack('Gemstone Mimicry');
  expect(og.damage === 90, `Myriad Leaf Shower with 2 Energy in play: 90 (${og.damage})`);
});
// Cynthia's Garchomp ex
test('Rock Hurl ignores Resistance; Champion\'s Call finds a Cynthia\'s Pokémon', async T => {
  T.mon(0, "Cynthia's Gible", { active: true, energy: ['Fighting'] });
  const gb = evolved(T, 0, ["Cynthia's Gible", "Cynthia's Gabite"]);
  const d = T.mon(1, 'Latias ex', { active: true });
  await T.attack('Rock Hurl');
  expect(d.damage === 20, `no -30 (${d.damage})`);
  T.A.deck.push(T.card(0, "Cynthia's Roselia"));
  await T.ability(gb, "Champion's Call");
  expect(T.A.hand.some(c => c.name === "Cynthia's Roselia"), 'Roselia found');
});
test("Cheer On to Glory (+30 per Roserade) with Corkscrew Dive (draw to 6) and Draconic Buster", async T => {
  const gc = T.mon(0, "Cynthia's Garchomp ex", { active: true, energy: ['Fighting', 'Fighting'] });
  T.mon(0, "Cynthia's Roserade"); T.mon(0, "Cynthia's Roserade");
  const d = T.mon(1, 'Mega Lucario ex', { active: true });
  T.a.on('draw-to-6', () => true);
  await T.attack('Corkscrew Dive');
  expect(d.damage === 160 && T.A.hand.length === 6, `100 + 2 x 30 = 160, 6 cards (${d.damage}, ${T.A.hand.length})`);
  d.damage = 0; T.g.turn += 2;
  await T.attack('Draconic Buster');
  expect(d.damage === 320 && gc.energy.length === 0, `260 + 60 = 320, Energy discarded (${d.damage})`);
});
test('Raging Curse: 10 per damage counter on your Benched Cynthia\'s Pokémon, no Weakness', async T => {
  T.mon(0, "Cynthia's Spiritomb", { active: true, energy: ['Darkness'] });
  T.mon(0, "Cynthia's Gible", { damage: 30 }); T.mon(0, "Cynthia's Roselia", { damage: 20 }); T.mon(0, 'Budew', { damage: 10 });
  const d = T.mon(1, 'Latias ex', { active: true });
  await T.attack('Raging Curse');
  expect(d.damage === 50, `5 counters, not doubled (${d.damage})`);
});
test('Memory Dive: evolved Pokémon use their previous Evolutions\' attacks', async T => {
  evolved(T, 0, ["Cynthia's Gible", "Cynthia's Gabite"], { active: true, energy: ['Fighting'] });
  const d = T.mon(1, 'Mega Kangaskhan ex', { active: true });
  expect(!canAttack(T, 'Rock Hurl'), 'not without Relicanth');
  T.mon(0, 'Relicanth');
  await T.attack('Rock Hurl');
  expect(d.damage === 40, `Gabite uses Rock Hurl: 20 x2 (${d.damage})`);
});
// Mew Box
test('Orichalcum Fang +120 after a Knock Out by attack damage last turn; Impact Blow locks itself', async T => {
  T.mon(0, 'Koraidon ex', { active: true, energy: ['Fighting', 'Fighting', 'Fighting'] });
  const d = T.mon(1, 'Latias ex', { active: true });
  await T.attack('Orichalcum Fang');
  expect(d.damage === 20, `50 - 30 = 20 (${d.damage})`);
  T.A.koLog.push({ turn: T.g.turn + 1, name: 'Budew', byAttack: false }); d.damage = 0; T.g.turn += 2;
  await T.attack('Orichalcum Fang');
  expect(d.damage === 20, `a Knock Out that wasn't attack damage doesn't count (${d.damage})`);
  T.A.koLog.push({ turn: T.g.turn + 1, name: 'Budew', byAttack: true }); d.damage = 0; T.g.turn += 2;
  await T.attack('Orichalcum Fang');
  expect(d.damage === 140, `170 - 30 = 140 (${d.damage})`);
  await T.attack('Impact Blow').catch(() => {});
  T.g.turn += 2;
  expect(!canAttack(T, 'Impact Blow') && canAttack(T, 'Orichalcum Fang'), 'Impact Blow locked next turn');
});
test('Wish Granter draws to 7; Swift ignores Weakness, Resistance and effects (Mysterious Rock Inn)', async T => {
  T.mon(0, 'Jirachi ex', { active: true, energy: ['Psychic', 'Psychic', 'Psychic'] });
  const c = T.mon(1, 'Crustle', { active: true });
  T.hand(0, 'Judge');
  await T.attack('Wish Granter');
  expect(T.A.hand.length === 7, `7 cards (${T.A.hand.length})`);
  T.g.turn += 2;
  await T.attack('Swift');
  expect(c.damage === 150, `150 through Mysterious Rock Inn (${c.damage})`);
});
test('Mysterious Signal: one more Prize card for a Knock Out', async T => {
  T.mon(0, 'Unown', { active: true, energy: ['Psychic', 'Psychic'] });
  T.mon(1, 'Budew', { active: true }); T.mon(1, 'Solrock');
  await T.attack('Mysterious Signal');
  expect(T.A.prizes.length === 4, `2 Prizes for Budew (${T.A.prizes.length} left)`);
});
test("Memory Helix: Mew ex uses its Benched Pokémon's attacks with its own Energy; Teleportation Burst switches", async T => {
  const mew = T.mon(0, '30C-66', { active: true, energy: ['Psychic', 'Psychic'] });
  const k = T.mon(0, 'Mega Kangaskhan ex');
  let d = T.mon(1, 'Mega Excadrill ex', { active: true }); T.mon(1, 'Budew');
  expect(!canAttack(T, 'Rapid-Fire Combo'), 'needs {C}{C}{C}');
  mew.energy.push(T.card(0, 'Psychic Energy'));
  await T.attack('Rapid-Fire Combo');
  expect(d.damage >= 200 && d.damage % 50 === 0, `Rapid-Fire Combo from Mew ex: ${d.damage}`);
  T.g.turn += 2; T.B.active = null; d = T.mon(1, 'Mega Lucario ex', { active: true });
  T.a.on('teleport', () => true).on('switch', () => [k.id]);
  await T.attack('Teleportation Burst');
  expect(d.damage === 60 && T.A.active === k, `30 x2 Weakness, Kangaskhan switched in (${d.damage})`);
});
// Marnie's Grimmsnarl ex
test('Filch draws a card; Punk Up attaches up to 5 {D} Energy to Marnie\'s Pokémon; Shadow Bullet hits the Bench', async T => {
  const imp = T.mon(0, "Marnie's Impidimp", { active: true, energy: ['Darkness'] });
  T.mon(1, 'Mega Lucario ex', { active: true }); const b = T.mon(1, 'Budew');
  await T.attack('Filch');
  expect(T.A.hand.length === 1, 'drew 1');
  T.A.hand = []; T.g.turn += 2;
  imp.energy = [];
  const mo = evolved(T, 0, ["Marnie's Impidimp", "Marnie's Morgrem"], { played: 1 });
  for (let i = 0; i < 6; i++) T.A.deck.push(T.card(0, 'Darkness Energy'));
  T.a.on('confirm', () => true).on('attach', req => req.options).on('attach:Darkness', req => [req.options.includes(mo.id) && mo.energy.length < 3 ? mo.id : req.options[0]]);
  await T.play(T.hand(0, "Marnie's Grimmsnarl ex"));
  expect(mo.name === "Marnie's Grimmsnarl ex" && mo.energy.length + imp.energy.length === 5, `5 Energy on Marnie's Pokémon (${mo.energy.length} + ${imp.energy.length})`);
  T.g.switchActive(0, mo);
  T.a.on('opp-damage:30', () => [b.id]);
  await T.attack('Shadow Bullet');
  expect(T.B.active.damage === 180 && b.stack.length === 0, `180 and Budew Knocked Out (${T.B.active.damage})`);
});
test('Freezing Shroud: 1 damage counter on every Pokémon with an Ability in the Checkup, except Froslass', async T => {
  const fr = evolved(T, 0, ['Snorunt', 'Froslass']);
  const bud = T.mon(0, 'Budew', { active: true });
  const sh = T.mon(0, 'Shaymin');
  const k = T.mon(1, 'Mega Kangaskhan ex', { active: true });
  const fz = T.mon(1, 'Fezandipiti ex');
  const sp = T.mon(1, 'Shuppet');
  await T.g.endTurn(0);
  expect(sh.damage === 10 && k.damage === 10 && fz.damage === 10, `Shaymin, Kangaskhan, Fezandipiti (${sh.damage}, ${k.damage}, ${fz.damage})`);
  expect(fr.damage === 0 && bud.damage === 0 && sp.damage === 0, "not Froslass, Budew (no Ability) or Shuppet (Hide 'n' Sneak)");
  T.g.stadium = { card: T.card(1, "Team Rocket's Watchtower"), owner: 1 };
  await T.g.endTurn(0);
  expect(k.damage === 10 && sh.damage === 20, 'no counter on Kangaskhan once Watchtower takes its Ability');
});
// Hop's Trevenant
test('Splashing Dodge: on heads, no damage or effects from attacks next turn', async T => {
  const ph = T.mon(0, "Hop's Phantump", { active: true, energy: ['Psychic'] });
  const lu = T.mon(1, 'Lunatone', { active: true, energy: ['Fighting', 'Fighting'] });
  let dodged = 0, hit = 0;
  for (let i = 0; i < 12; i++) {
    T.g.current = 0; lu.damage = 0;
    await T.attack('Splashing Dodge');
    const dodge = T.g.effects.some(e => e.kind === 'dig' && e.mon === ph.id && e.turn === T.g.turn + 1);
    T.g.turn++; T.g.current = 1; ph.damage = 0;
    await T.attack('Power Gem', 1);
    if (dodge) { expect(ph.damage === 0, `dodged (${ph.damage})`); dodged++; } else { expect(ph.damage === 20, `50 - 30 = 20 (${ph.damage})`); hit++; }
    T.g.turn++;
  }
  expect(dodged && hit, `both outcomes (${dodged} dodged, ${hit} hit)`);
});
test("Hop's boosts: Horrifying Revenge +100 after a Hop's Knock Out, Extra Helpings, Postwick and Hop's Choice Band", async T => {
  const tr = T.mon(0, "Hop's Trevenant", { active: true });
  const d = T.mon(1, 'Mega Kangaskhan ex', { active: true });
  expect(!canAttack(T, 'Horrifying Revenge'), 'needs {C}');
  tr.tool = T.card(0, "Hop's Choice Band");
  await T.attack('Horrifying Revenge');
  expect(d.damage === 60, `free with the Band: 30 + 30 = 60 (${d.damage})`);
  T.A.koLog.push({ turn: T.g.turn + 1, name: 'Budew', byAttack: true }); d.damage = 0; T.g.turn += 2;
  await T.attack('Horrifying Revenge');
  expect(d.damage === 60, `a non-Hop's Knock Out doesn't count (${d.damage})`);
  T.A.koLog.push({ turn: T.g.turn + 1, name: "Hop's Phantump", byAttack: true }); d.damage = 0; T.g.turn += 2;
  T.mon(0, "Hop's Snorlax"); T.mon(0, "Hop's Snorlax");
  T.g.stadium = { card: T.card(0, 'Postwick'), owner: 0 };
  await T.attack('Horrifying Revenge');
  expect(d.damage === 220, `130 + Band 30 + Extra Helpings 30 (once) + Postwick 30 = 220 (${d.damage})`);
});
test('Corner: 90 and the Defending Pokémon can\'t retreat; Dynamic Press does 80 to itself', async T => {
  const tr = T.mon(0, "Hop's Trevenant", { active: true, energy: ['Psychic', 'Psychic', 'Psychic'] });
  const d = T.mon(1, 'Mega Kangaskhan ex', { active: true, energy: ['Psychic', 'Psychic', 'Psychic'] });
  T.mon(1, 'Budew');
  await T.attack('Corner');
  T.g.turn++; T.g.current = 1;
  expect(d.damage === 90 && !T.g.legalActions(1).some(a => a.t === 'retreat'), `90, no retreat (${d.damage})`);
  T.g.turn++; T.g.current = 0; T.A.active = null;
  const sn = T.mon(0, "Hop's Snorlax", { active: true, energy: ['Psychic', 'Psychic', 'Psychic'] });
  d.damage = 0;
  await T.attack('Dynamic Press');
  expect(d.damage === 170 && sn.damage === 80, `140 + its own Extra Helpings 30, 80 to itself (${d.damage}, ${sn.damage})`);
  expect(tr, 'Trevenant');
});
test("Defiant Horn drags up a Benched Pokémon as Hop's Dubwool evolves", async T => {
  T.mon(0, "Hop's Wooloo", { active: true, played: 1 });
  T.mon(1, 'Budew', { active: true }); const s = T.mon(1, 'Solrock');
  T.a.on('confirm', () => true).on('gust', () => [s.id]);
  await T.play(T.hand(0, "Hop's Dubwool"));
  expect(T.B.active === s, 'Solrock dragged up');
});
test('ACE Nullifier: with a Tool, Genesect stops the opponent playing ACE SPEC cards', async T => {
  T.mon(0, 'Budew', { active: true });
  const ge = T.mon(1, 'Genesect', { active: true }); T.mon(1, 'Solrock');
  const pc = T.hand(0, 'Prime Catcher'), nb = T.hand(0, 'Nest Ball');
  expect(canPlay(T, pc), 'fine without a Tool');
  ge.tool = T.card(1, 'Air Balloon');
  expect(!canPlay(T, pc) && canPlay(T, nb), 'Prime Catcher locked, Nest Ball fine');
});
test("Insta-Strike hits the Bench; Brave Slash locks itself; Hop's Choice Band takes {C} off", async T => {
  const z = T.mon(0, "Hop's Zacian ex", { active: true, energy: ['Metal'] });
  const d = T.mon(1, 'Mega Lucario ex', { active: true }); const b = T.mon(1, 'Solrock');
  T.a.on('opp-damage:30', () => [b.id]);
  await T.attack('Insta-Strike');
  expect(d.damage === 30 && b.damage === 30, `30 and 30 (${d.damage}, ${b.damage})`);
  z.energy.push(T.card(0, 'Metal Energy'), T.card(0, 'Metal Energy'));
  T.g.turn += 2;
  expect(!canAttack(T, 'Brave Slash'), '{M}{M}{M}{C} needs 4');
  z.tool = T.card(0, "Hop's Choice Band");
  d.damage = 0;
  await T.attack('Brave Slash');
  expect(d.damage === 270, `3 Energy with the Band: 240 + 30 (${d.damage})`);
  T.g.turn += 2;
  expect(!canAttack(T, 'Brave Slash') && canAttack(T, 'Insta-Strike'), 'Brave Slash locked next turn');
});
test('Fickle Spitting only works when the opponent has exactly 3 or 4 Prize cards left', async T => {
  T.mon(0, "Hop's Cramorant", { active: true, energy: ['Psychic'] });
  const d = T.mon(1, 'Mega Lucario ex', { active: true });
  await T.attack('Fickle Spitting');
  expect(d.damage === 0, `6 Prizes: nothing (${d.damage})`);
  T.B.prizes.splice(0, 2); T.g.turn += 2;
  await T.attack('Fickle Spitting');
  expect(d.damage === 120, `4 Prizes: 120 (${d.damage})`);
  T.B.prizes.splice(0, 2); T.g.turn += 2; d.damage = 0;
  await T.attack('Fickle Spitting');
  expect(d.damage === 0, `2 Prizes: nothing (${d.damage})`);
});
// Trainers
test('Harlequin: hands go back, then 5 and 3 cards, who gets 5 decided by a coin flip', async T => {
  T.mon(0, 'Budew', { active: true }); T.mon(1, 'Budew', { active: true });
  const h = T.hand(0, 'Harlequin'); T.hand(0, 'Judge'); for (let i = 0; i < 4; i++) T.hand(1, 'Psychic Energy');
  await T.play(h);
  const a = T.A.hand.length, b = T.B.hand.length;
  expect((a === 5 && b === 3) || (a === 3 && b === 5), `5 and 3 (${a}, ${b})`);
});
test('Energy Recycler shuffles up to 5 Basic Energy from the discard pile into the deck', async T => {
  T.mon(0, 'Budew', { active: true }); T.mon(1, 'Budew', { active: true });
  for (let i = 0; i < 6; i++) T.A.discard.push(T.card(0, 'Metal Energy'));
  const n = T.A.deck.length;
  T.a.on('recover', req => req.options);
  await T.play(T.hand(0, 'Energy Recycler'));
  expect(T.A.deck.length === n + 5 && T.A.discard.filter(c => c.name === 'Metal Energy').length === 1, `5 back (${T.A.deck.length - n})`);
});
test("Wally's Compassion heals a Mega Evolution Pokémon ex and returns its Energy to hand", async T => {
  const r = T.mon(0, 'Riolu', { active: true, damage: 20 });
  T.mon(1, 'Budew', { active: true });
  const w = T.hand(0, "Wally's Compassion");
  expect(!canPlay(T, w), 'no damaged Mega ex');
  const l = T.mon(0, 'Mega Lucario ex', { damage: 100, energy: ['Fighting', 'Fighting'] });
  await T.play(w);
  expect(l.damage === 0 && l.energy.length === 0 && T.A.hand.filter(c => c.name === 'Fighting Energy').length === 2 && r.damage === 20, 'healed, Energy in hand');
});
test('Premium Power Pro: +30 for {F} Pokémon this turn', async T => {
  T.mon(0, 'Riolu', { active: true, energy: ['Fighting'] });
  const d = T.mon(1, 'Mega Kangaskhan ex', { active: true });
  await T.play(T.hand(0, 'Premium Power Pro'));
  await T.attack('Accelerating Stab');
  expect(d.damage === 120, `(30 + 30) x2 = 120 (${d.damage})`);
});
test('Gravity Mountain: Stage 2 Pokémon get -30 HP (and are Knocked Out if that leaves them at 0)', async T => {
  const gc = T.mon(0, "Cynthia's Garchomp ex", { active: true, damage: 310 });
  const gb = T.mon(0, "Cynthia's Gible");
  T.mon(1, 'Budew', { active: true });
  expect(T.g.maxHp(gc) === 330, '330 before');
  await T.play(T.hand(0, 'Gravity Mountain'));
  expect(gc.stack.length === 0 && T.g.maxHp(gb) === 70, 'Garchomp ex Knocked Out at 300 HP, Gible unchanged');
});
test("Iris's Fighting Spirit: discard a card to draw until you have 6", async T => {
  T.mon(0, 'Budew', { active: true }); T.mon(1, 'Budew', { active: true });
  const iris = T.hand(0, "Iris's Fighting Spirit");
  expect(!canPlay(T, iris), 'needs another card to discard');
  T.hand(0, 'Judge'); T.hand(0, 'Psychic Energy');
  await T.play(iris);
  expect(T.A.hand.length === 6 && T.A.discard.length === 2, `6 cards (${T.A.hand.length})`);
});
test("Team Rocket's Ariana draws to 5, or to 8 with only Team Rocket's Pokémon in play", async T => {
  T.mon(0, "Team Rocket's Murkrow", { active: true }); const b = T.mon(0, 'Budew');
  T.mon(1, 'Budew', { active: true });
  await T.play(T.hand(0, "Team Rocket's Ariana"));
  expect(T.A.hand.length === 5, `5 (${T.A.hand.length})`);
  T.A.bench = T.A.bench.filter(m => m !== b); T.A.hand = []; T.A.supporter = false;
  await T.play(T.hand(0, "Team Rocket's Ariana"));
  expect(T.A.hand.length === 8, `8 (${T.A.hand.length})`);
});
test("Team Rocket's Archer: only after a Team Rocket's Pokémon was Knocked Out; 5 and 3 cards", async T => {
  T.mon(0, 'Budew', { active: true }); T.mon(1, 'Budew', { active: true });
  const ar = T.hand(0, "Team Rocket's Archer");
  T.A.koLog.push({ turn: T.g.turn - 1, name: 'Budew', byAttack: true });
  expect(!canPlay(T, ar), "not after a non-Team Rocket's Knock Out");
  T.A.koLog.push({ turn: T.g.turn - 1, name: "Team Rocket's Murkrow", byAttack: false });
  await T.play(ar);
  expect(T.A.hand.length === 5 && T.B.hand.length === 3, `5 and 3 (${T.A.hand.length}, ${T.B.hand.length})`);
});
test("Team Rocket's Giovanni switches Team Rocket's Pokémon, then drags up the opponent's", async T => {
  const m = T.mon(0, 'Budew', { active: true }); const p = T.mon(0, "Team Rocket's Porygon");
  T.mon(1, 'Budew', { active: true }); const s = T.mon(1, 'Solrock');
  const gi = T.hand(0, "Team Rocket's Giovanni");
  expect(!canPlay(T, gi), "the Active must be a Team Rocket's Pokémon");
  T.A.active = null; T.mon(0, "Team Rocket's Murkrow", { active: true });
  T.a.on('gust', () => [s.id]);
  await T.play(gi);
  expect(T.A.active === p && T.B.active === s && m, 'Porygon in, Solrock dragged up');
});
test("Team Rocket's Proton works on the first turn of the player going first", async T => {
  T.g.turn = 1; T.g.first = 0; T.A.turns = 1;
  T.mon(0, 'Budew', { active: true }); T.mon(1, 'Budew', { active: true });
  const pr = T.hand(0, "Team Rocket's Proton"), ju = T.hand(0, 'Judge');
  for (const n of ["Team Rocket's Murkrow", "Team Rocket's Porygon", "Team Rocket's Mimikyu", "Team Rocket's Articuno"]) T.A.deck.push(T.card(0, n));
  expect(canPlay(T, pr) && !canPlay(T, ju), 'Proton yes, Judge no');
  T.a.on('take', req => req.options);
  await T.play(pr);
  expect(T.A.hand.filter(c => /^Team Rocket's /.test(c.name)).length === 3, '3 Basic Team Rocket\'s Pokémon');
});
test('Roto-Stick takes any number of Supporters from the top 4; Miracle Headset 2 from the discard', async T => {
  T.mon(0, 'Budew', { active: true }); T.mon(1, 'Budew', { active: true });
  T.A.deck.unshift(T.card(0, 'Judge'), T.card(0, 'Psychic Energy'), T.card(0, 'Iono'), T.card(0, 'Nest Ball'));
  T.a.on('take', req => req.options);
  await T.play(T.hand(0, 'Roto-Stick'));
  expect(T.A.hand.map(c => c.name).sort().join() === 'Iono,Judge', `Judge and Iono (${T.A.hand.map(c => c.name)})`);
  for (const n of ['Judge', 'Iono', 'Arven']) T.A.discard.push(T.card(0, n));
  T.A.hand = [];
  await T.play(T.hand(0, 'Miracle Headset'));
  expect(T.A.hand.length === 2 && T.A.hand.every(c => c.def.trainer === 'Supporter'), '2 Supporters back');
});
test("Larry's Skill discards the hand and finds a Pokémon, a Supporter and a Basic Energy", async T => {
  T.mon(0, 'Budew', { active: true }); T.mon(1, 'Budew', { active: true });
  const l = T.hand(0, "Larry's Skill"); T.hand(0, 'Nest Ball'); T.hand(0, 'Iono');
  T.A.deck.push(T.card(0, 'Budew'), T.card(0, 'Judge'));
  await T.play(l);
  const names = T.A.hand.map(c => c.name).sort();
  expect(names.join() === 'Budew,Judge,Psychic Energy' && T.A.discard.some(c => c.name === 'Nest Ball'), `found ${names}`);
});
test("Cynthia's Power Weight: +70 HP for Cynthia's Pokémon only", async T => {
  const g = T.mon(0, "Cynthia's Gible", { active: true }); const b = T.mon(0, 'Budew');
  T.mon(1, 'Budew', { active: true });
  g.tool = T.card(0, "Cynthia's Power Weight"); b.tool = T.card(0, "Cynthia's Power Weight");
  expect(T.g.maxHp(g) === 140 && T.g.maxHp(b) === 30, `140 and 30 (${T.g.maxHp(g)}, ${T.g.maxHp(b)})`);
});
test('Dusk Ball finds a Pokémon in the bottom 7 cards only', async T => {
  T.mon(0, 'Budew', { active: true }); T.mon(1, 'Budew', { active: true });
  T.A.deck.splice(T.A.deck.length - 10, 0, T.card(0, 'Solrock'));
  T.A.deck.push(T.card(0, 'Lunatone'));
  T.a.on('take', req => req.options);
  await T.play(T.hand(0, 'Dusk Ball'));
  expect(T.A.hand.map(c => c.name).join() === 'Lunatone', `Lunatone, not Solrock (${T.A.hand.map(c => c.name)})`);
});
test('Spikemuth Gym searches for a Marnie\'s Pokémon once a turn', async T => {
  T.mon(0, 'Budew', { active: true }); T.mon(1, 'Budew', { active: true });
  T.g.stadium = { card: T.card(1, 'Spikemuth Gym'), owner: 1 };
  T.A.deck.push(T.card(0, "Marnie's Impidimp"));
  await T.g.doAction(0, T.g.legalActions(0).find(a => a.t === 'stadium'));
  expect(T.A.hand.some(c => c.name === "Marnie's Impidimp") && !T.g.legalActions(0).some(a => a.t === 'stadium'), 'found, once per turn');
});
test("Hassel: only after a Knock Out last turn, up to 3 of the top 8; Hop's Bag benches 2 Hop's Pokémon", async T => {
  T.mon(0, 'Budew', { active: true }); T.mon(1, 'Budew', { active: true });
  const h = T.hand(0, 'Hassel');
  expect(!canPlay(T, h), 'not without a Knock Out');
  T.A.koTurn = T.g.turn - 1;
  T.a.on('take', req => req.options.slice(0, 3));
  await T.play(h);
  expect(T.A.hand.length === 3, `3 cards (${T.A.hand.length})`);
  T.A.deck.push(T.card(0, "Hop's Phantump"), T.card(0, "Hop's Wooloo"), T.card(0, "Hop's Snorlax"));
  T.a.on('bench', req => req.options.slice(0, 2));
  await T.play(T.hand(0, "Hop's Bag"));
  expect(T.A.bench.length === 2 && T.A.bench.every(m => m.name.startsWith("Hop's ")), "2 Hop's Pokémon benched");
});
test("Team Rocket's Energy: 2 Energy of {P}/{D}, only on Team Rocket's Pokémon (discarded elsewhere)", async T => {
  const h = T.mon(0, "Team Rocket's Honchkrow", { active: true, energy: ['Psychic'] });
  const b = T.mon(0, 'Budew');
  T.mon(1, 'Mega Kangaskhan ex', { active: true });
  const e = T.hand(0, "Team Rocket's Energy");
  expect(T.g.legalActions(0).some(a => a.card === e.id && a.target === h.id) && !T.g.legalActions(0).some(a => a.card === e.id && a.target === b.id), "only onto a Team Rocket's Pokémon");
  await T.play(e, { target: h.id });
  expect(T.g.energyTypes(h).length === 3 && canAttack(T, 'Hammer In'), 'pays {D}{C}{C} with 1 more Energy');
  const e2 = T.card(0, "Team Rocket's Energy"); b.energy.push(e2);
  await T.play(T.hand(0, 'Nest Ball'));
  expect(!b.energy.includes(e2) && T.A.discard.includes(e2), 'discarded from Budew');
});
test('Ignition Energy: {C}{C}{C} on an Evolution Pokémon, {C} on a Basic, discarded at the end of the turn', async T => {
  const d = evolved(T, 0, ["Hop's Wooloo", "Hop's Dubwool"], { active: true });
  const w = T.mon(0, "Hop's Wooloo");
  T.mon(1, 'Mega Lucario ex', { active: true });
  d.energy.push(T.card(0, 'Ignition Energy')); w.energy.push(T.card(0, 'Ignition Energy'));
  expect(canAttack(T, 'Headbutt') && T.g.energyTypes(w).length === 1, 'Dubwool can Headbutt, Wooloo has 1 Energy');
  await T.g.endTurn(0);
  expect(!d.energy.length && !w.energy.length, 'both discarded');
});
test('Rocky Fighting Energy keeps attack effects off the {F} Pokémon it is attached to', async T => {
  T.mon(0, 'Munkidori', { active: true, energy: ['Psychic', 'Psychic'] });
  const l = T.mon(1, 'Lunatone', { active: true });
  l.energy.push(T.card(1, 'Rocky Fighting Energy'));
  await T.attack('Mind Bend');
  expect(l.damage === 60 && !l.special && T.g.energyTypes(l)[0] === 'Fighting', `damage but no Confusion, provides {F} (${l.damage})`);
  T.B.active = null;
  const la = T.mon(1, 'Latias ex', { active: true });
  la.energy.push(T.card(1, 'Rocky Fighting Energy'));
  T.g.turn += 2;
  await T.attack('Mind Bend');
  expect(la.special === 'confused', 'a {P} Pokémon is not protected');
});

// ---- Found by chaos play (tools/ptcg/invariants.mjs --chaos): cards that could be played to do nothing at all
test('Deck-only Trainers, Abilities and Stadium actions are not offered with an empty deck', async T => {
  T.mon(0, 'Genesect ex', { active: true });   // Metallic Signal
  T.mon(0, 'Budew');
  T.mon(1, 'Budew', { active: true });
  const pad = T.hand(0, 'Poké Pad'), pr = T.hand(0, "Professor's Research");
  T.g.stadium = { card: T.card(1, 'Artazon'), owner: 1 };
  const acts = () => T.g.legalActions(0);
  expect(acts().some(a => a.card === pad.id), 'Poké Pad with a deck');
  expect(acts().some(a => a.t === 'ability' && a.name === 'Metallic Signal'), 'Metallic Signal with a deck');
  expect(acts().some(a => a.t === 'stadium'), "Artazon's action with a deck");
  T.A.deck = [];
  expect(!acts().some(a => a.card === pad.id), 'no Poké Pad with an empty deck');
  expect(!acts().some(a => a.t === 'ability' && a.name === 'Metallic Signal'), 'no Metallic Signal with an empty deck');
  expect(!acts().some(a => a.t === 'stadium'), "no Artazon's action with an empty deck");
  expect(acts().some(a => a.card === pr.id), "Professor's Research still playable: it discards the hand");
  T.A.hand = [pr];
  expect(!acts().some(a => a.card === pr.id), "no Professor's Research with nothing in hand or deck");
});
test('A "when you play this Pokémon" Ability that searches the deck is not offered with an empty deck', async T => {
  T.mon(0, 'Budew', { active: true }); T.mon(1, 'Budew', { active: true });
  const m = T.hand(0, 'Meowth ex');            // Last-Ditch Catch: a Supporter from the deck
  let asked = 0;
  T.a.on('confirm', () => { asked++; return true; });
  T.A.deck = [];
  await T.play(m);
  expect(T.A.bench.some(x => x.name === 'Meowth ex'), 'Meowth ex benched');
  expect(asked === 0, `no "Use Last-Ditch Catch?" question (${asked})`);
});
test("Team Rocket's Ariana is not playable with 5 or more other cards in hand", async T => {
  T.mon(0, 'Budew', { active: true }); T.mon(1, 'Budew', { active: true });
  const ar = T.hand(0, "Team Rocket's Ariana");
  for (let i = 0; i < 5; i++) T.hand(0, 'Psychic Energy');
  expect(!T.g.legalActions(0).some(a => a.card === ar.id), 'not with 5 other cards in hand');
  T.A.hand.pop();
  await T.play(ar);
  expect(T.A.hand.length === 5, `draws up to 5 (${T.A.hand.length})`);
});
test("Special Red Card needs a hand to disrupt; Professor Turo's Scenario needs a Benched Pokémon", async T => {
  T.mon(0, 'Budew', { active: true }); T.mon(1, 'Budew', { active: true });
  T.B.prizes.splice(0, 3);
  const red = T.hand(0, 'Special Red Card'), turo = T.hand(0, "Professor Turo's Scenario");
  const acts = () => T.g.legalActions(0);
  expect(!acts().some(a => a.card === red.id), 'no Special Red Card against an empty hand');
  T.hand(1, 'Psychic Energy');
  expect(acts().some(a => a.card === red.id), 'Special Red Card against a hand');
  expect(!acts().some(a => a.card === turo.id), "no Turo's Scenario with only an Active Pokémon");
  T.mon(0, 'Solrock');
  expect(acts().some(a => a.card === turo.id), "Turo's Scenario with a Benched Pokémon");
});
test('A main-phase answer that is not one of the choices asks again instead of ending the turn', async T => {
  T.mon(0, 'Budew', { active: true }); T.mon(1, 'Budew', { active: true });
  const e = T.hand(0, 'Psychic Energy');
  let n = 0;
  T.a.on('main', req => { n++; if (n === 1) return { t: 'attack', mon: 999, name: 'Nothing' }; if (n === 2) return req.actions.find(a => a.t === 'energy'); return { t: 'end' }; });
  T.b.on('main', () => ({ t: 'end' }));
  T.g.turn = 2; T.g.current = 1;
  T.g.maxTurns = 3;
  await T.g.takeTurn();
  expect(n === 3, `asked again after the odd answer (${n} questions)`);
  expect(T.A.active.energy.includes(e), 'the Energy was attached after the odd answer');
});

test('A Supporter backed out of (nothing chosen, nothing happened) goes back to the hand and is not used up', async T => {
  T.mon(0, 'Budew', { active: true }); T.mon(1, 'Budew', { active: true });
  const gw = T.hand(0, 'Gwynn'); T.hand(0, 'Budew');
  T.a.on('discard-draw', () => []);
  const hand = T.A.hand.length;
  await T.play(gw);
  expect(T.A.hand.includes(gw), 'Gwynn is back in hand');
  expect(T.A.hand.length === hand && !T.A.discard.includes(gw), `nothing discarded or drawn (${T.A.hand.length})`);
  expect(!T.A.supporter, 'no Supporter used this turn');
  expect(T.g.legalActions(0).some(a => a.card === gw.id), 'Gwynn can still be played');
});
test('An Ability that showed hidden cards is used up even when nothing was taken (no looking again and again)', async T => {
  const met = T.mon(0, 'Metang', { active: true }); T.mon(1, 'Budew', { active: true });
  T.A.deck = [T.card(0, 'Metal Energy')];
  T.a.on('attach', () => []);
  await T.ability(met, 'Metal Maker');
  expect(met.energy.length === 0, 'nothing attached');
  expect(!T.g.legalActions(0).some(a => a.t === 'ability' && a.name === 'Metal Maker'), 'Metal Maker used up: the top card was seen');
});
test('An empty answer to a question that needs a card still does the effect (a Stadium action is not given back)', async T => {
  T.mon(0, 'Budew', { active: true }); T.mon(1, 'Budew', { active: true });
  T.g.stadium = { card: T.card(1, 'Academy at Night'), owner: 1 };
  T.hand(0, 'Psychic Energy');
  const act = () => T.g.legalActions(0).find(a => a.t === 'stadium');
  expect(act(), "Academy at Night's action offered");
  T.a.on('topdeck', () => []);
  await T.g.doAction(0, act());
  expect(T.A.deck[0].name === 'Psychic Energy', 'a card went on top (Academy at Night needs exactly 1)');
  expect(!act(), 'and the action is used up');
});
let pass = 0, fail = 0;
for (const t of tests) {
  if (ONLY && !ONLY.test(t.name)) continue;
  try { await t.fn(setup()); pass++; } catch (e) { fail++; console.log(`FAIL ${t.name}: ${e.message}${e.message.startsWith('expected') ? '' : '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n')}`); }
}
console.log(`\n${pass} passed, ${fail} failed`);
