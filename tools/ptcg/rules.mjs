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

let pass = 0, fail = 0;
for (const t of tests) {
  if (ONLY && !ONLY.test(t.name)) continue;
  try { await t.fn(setup()); pass++; } catch (e) { fail++; console.log(`FAIL ${t.name}: ${e.message}${e.message.startsWith('expected') ? '' : '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n')}`); }
}
console.log(`\n${pass} passed, ${fail} failed`);
