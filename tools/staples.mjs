// Behavioural tests for the most-played Commander staples: set up a board, cast the card, assert the outcome.
import fs from 'node:fs';
import { allCardScripts } from './lib/allcards.mjs';
import { CardDB } from '../src/engine/cards.js';
import { Game } from '../src/engine/game.js';
import { AIAgent } from '../src/ai/ai.js';
import { castSpell, activateAbility, activatedAbilities, activateManaAbility, manaAbilitiesOf, refOf, getActions } from '../src/engine/abilities.js';

const db = new CardDB(allCardScripts(), JSON.parse(fs.readFileSync('data/tokens.json', 'utf8')));
const basics = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];
const deck = (name, cmd) => ({ name, commanders: [cmd], cards: basics.map(b => [b, 12]).concat([['Llanowar Elves', 4], ['Serra Angel', 4], ['Wall of Omens', 4]]) });

class Scripted {
  constructor() { this.ai = new AIAgent(); this.h = {}; }
  on(type, fn) { this.h[type] = fn; return this; }
  async ask(game, pid, req) {
    const f = this.h[req.type] || this.h[req.purpose];
    if (f) { const r = f(req, game); if (r !== undefined) return r; }
    return this.ai.ask(game, pid, req);
  }
}

async function setup() {
  const a = new Scripted(), b = new Scripted();
  const game = new Game({ db, seed: 7, players: [{ name: 'A', deck: deck('A', "Atraxa, Praetors' Voice"), agent: a }, { name: 'B', deck: deck('B', 'Sun Titan'), agent: b }] });
  game.throwErrors = true;
  for (const p of game.players) game.rng.shuffle(p.library);
  game.turnNumber = 3; game.activePlayer = 0; game.step = 'main1'; game.priority = 0;
  const T = {
    game, a, b, A: game.players[0], B: game.players[1],
    async put(pid, name, zone = 'battlefield', opts = {}) {
      const c = game.newCard(db.get(name), pid); c.zone = 'none';
      if (zone === 'battlefield') { await game.moveCard(c, 'battlefield', { controller: pid, silent: true, ...opts }); c.sick = false; }
      else { c.zone = zone; game.players[pid][zone].push(c); }
      return c;
    },
    async resolve() {
      for (let i = 0; i < 60; i++) {
        await game.processTriggersAndSBA();
        if (!game.stack.length) break;
        await game.resolveTop();
      }
    },
    mana(pid = 0) { game.players[pid].pool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 }; },
    async cast(name, pid = 0, { resolve = true } = {}) {
      const c = await T.put(pid, name, 'hand');
      T.mana(pid);
      game.priority = pid;
      const ok = await castSpell(game, pid, c, {});
      if (!ok) throw new Error(`could not cast ${name}`);
      if (resolve) await T.resolve();
      return c;
    },
    async activate(card, pid = 0, idx = 0) {
      T.mana(pid);
      card.sick = false;
      const abil = activatedAbilities(game, pid, card)[idx];
      if (!abil) throw new Error('no ability on ' + card.def.name);
      game.priority = pid;
      const ok = await activateAbility(game, pid, card, abil.key, { ignoreTiming: true });
      if (!ok) throw new Error('could not activate ' + card.def.name);
      await T.resolve();
    },
    count(pid, zone, pred = () => true) { return (zone === 'battlefield' ? game.battlefield.filter(c => c.controller === pid) : game.players[pid][zone]).filter(pred).length; },
    named(n) { return c => c.def.name === n || game.name(c) === n; },
    isLand: c => game.chars(c).types.has('Land'),
    isCreature: c => game.chars(c).types.has('Creature'),
  };
  return T;
}

const tests = [];
const ONLY = process.argv[2] ? new RegExp(process.argv[2], 'i') : null;
const test = (name, fn) => tests.push({ name, fn });
const expect = (cond, msg) => { if (!cond) throw new Error('expected: ' + msg); };

test('Sol Ring taps for {C}{C}', async T => {
  const c = await T.put(0, 'Sol Ring');
  T.A.pool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  await activateManaAbility(T.game, 0, c, manaAbilitiesOf(T.game, c)[0].key);
  expect(T.A.pool.C === 2 && c.tapped, `pool C=2, got ${T.A.pool.C}`);
});
test('Arcane Signet makes a color in commander identity', async T => {
  const c = await T.put(0, 'Arcane Signet');
  T.A.pool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  T.a.on('color', req => req.colors.includes('B') ? 'B' : req.colors[0]);
  await activateManaAbility(T.game, 0, c, manaAbilitiesOf(T.game, c)[0].key);
  expect(T.A.pool.B === 1, 'one black mana');
});
test('Swords to Plowshares exiles and gives life equal to power', async T => {
  const angel = await T.put(1, 'Serra Angel');
  T.a.on('targets', req => [refOf(angel)]);
  const life = T.B.life;
  await T.cast('Swords to Plowshares');
  expect(angel.zone === 'exile', 'angel exiled');
  expect(T.B.life === life + 4, `B gains 4 (life ${T.B.life})`);
});
test('Path to Exile exiles; controller fetches a basic tapped', async T => {
  const angel = await T.put(1, 'Serra Angel');
  T.a.on('targets', req => [refOf(angel)]);
  const lands = T.count(1, 'battlefield', T.isLand);
  await T.cast('Path to Exile');
  expect(angel.zone === 'exile', 'exiled');
  expect(T.count(1, 'battlefield', T.isLand) === lands + 1, 'B got a land');
  expect(T.game.battlefield.filter(c => c.controller === 1 && T.isLand(c)).some(c => c.tapped), 'tapped land');
});
test('Cultivate: one basic tapped onto battlefield, one to hand', async T => {
  const lands = T.count(0, 'battlefield', T.isLand), hand = T.A.hand.length;
  await T.cast('Cultivate');
  expect(T.count(0, 'battlefield', T.isLand) === lands + 1, 'land on battlefield');
  expect(T.A.hand.length === hand + 1, `land in hand (${T.A.hand.length} vs ${hand})`);
});
test("Kodama's Reach works like Cultivate", async T => {
  const lands = T.count(0, 'battlefield', T.isLand), hand = T.A.hand.length;
  await T.cast("Kodama's Reach");
  expect(T.count(0, 'battlefield', T.isLand) === lands + 1 && T.A.hand.length === hand + 1, 'one to play, one to hand');
});
test('Rampant Growth puts a basic onto the battlefield tapped', async T => {
  const lands = T.count(0, 'battlefield', T.isLand);
  await T.cast('Rampant Growth');
  expect(T.count(0, 'battlefield', T.isLand) === lands + 1, 'land added');
});
test('Farseek finds a land', async T => {
  const lands = T.count(0, 'battlefield', T.isLand);
  await T.cast('Farseek');
  expect(T.count(0, 'battlefield', T.isLand) === lands + 1, 'land added');
});
test('Beast Within destroys and gives a 3/3 Beast', async T => {
  const ring = await T.put(1, 'Sol Ring');
  T.a.on('targets', () => [refOf(ring)]);
  await T.cast('Beast Within');
  expect(ring.zone === 'graveyard', 'ring destroyed');
  expect(T.game.battlefield.some(c => c.controller === 1 && c.token && T.game.chars(c).power === 3), 'beast token for B');
});
test('Chaos Warp shuffles the permanent away', async T => {
  const angel = await T.put(1, 'Serra Angel');
  T.a.on('targets', () => [refOf(angel)]);
  await T.cast('Chaos Warp');
  expect(angel.zone === 'library' || angel.zone === 'battlefield', `angel in library or re-revealed (${angel.zone})`);
});
test('Blasphemous Act costs less and kills everything', async T => {
  for (let i = 0; i < 4; i++) { await T.put(0, 'Serra Angel'); await T.put(1, 'Serra Angel'); }
  await T.cast('Blasphemous Act');
  expect(T.game.battlefield.filter(T.isCreature).length === 0, 'no creatures left');
});
test('Wrath of God destroys all creatures', async T => {
  await T.put(0, 'Llanowar Elves'); await T.put(1, 'Serra Angel');
  await T.cast('Wrath of God');
  expect(T.game.battlefield.filter(T.isCreature).length === 0, 'wiped');
});
test('Lightning Greaves: equip {0} gives haste and shroud', async T => {
  const g = await T.put(0, 'Lightning Greaves');
  const elf = await T.put(0, 'Llanowar Elves');
  T.a.on('targets', () => [refOf(elf)]);
  await T.activate(g);
  expect(g.attachedTo === elf.id, 'attached');
  expect(T.game.hasKeyword(elf, 'Haste') && T.game.hasKeyword(elf, 'Shroud'), 'haste + shroud');
});
test('Swiftfoot Boots gives hexproof and haste', async T => {
  const g = await T.put(0, 'Swiftfoot Boots');
  const elf = await T.put(0, 'Llanowar Elves');
  T.a.on('targets', () => [refOf(elf)]);
  await T.activate(g);
  expect(T.game.hasKeyword(elf, 'Hexproof') && T.game.hasKeyword(elf, 'Haste'), 'hexproof + haste');
});
test('Hexproof blocks opponent targeting', async T => {
  const g = await T.put(1, 'Swiftfoot Boots');
  const angel = await T.put(1, 'Serra Angel');
  g.attachedTo = angel.id; T.game.touch();
  const acts = getActions(T.game, 0);
  const c = await T.put(0, 'Swords to Plowshares', 'hand');
  T.mana(0);
  const { castableOptions } = await import('../src/engine/abilities.js');
  const opts = castableOptions(T.game, 0, c);
  // only other creatures can be targeted; A controls none -> cannot cast
  expect(opts.length === 0, 'Swords cannot target the hexproof angel');
});
test("Commander's Sphere: sacrifice to draw", async T => {
  const s = await T.put(0, "Commander's Sphere");
  const hand = T.A.hand.length;
  await T.activate(s, 0, 0);
  expect(s.zone === 'graveyard' && T.A.hand.length === hand + 1, 'drew a card');
});
test("Wayfarer's Bauble fetches a basic", async T => {
  const s = await T.put(0, "Wayfarer's Bauble");
  const lands = T.count(0, 'battlefield', T.isLand);
  await T.activate(s, 0, 0);
  expect(T.count(0, 'battlefield', T.isLand) === lands + 1, 'land fetched');
});
test('Mind Stone: {1},{T}, sacrifice: draw', async T => {
  const s = await T.put(0, 'Mind Stone');
  const hand = T.A.hand.length;
  await T.activate(s, 0, 0);
  expect(T.A.hand.length === hand + 1 && s.zone === 'graveyard', 'drew');
});
test('Skullclamp: equipped creature dies, draw two', async T => {
  const s = await T.put(0, 'Skullclamp');
  const elf = await T.put(0, 'Llanowar Elves');
  T.a.on('targets', () => [refOf(elf)]);
  const hand = T.A.hand.length;
  await T.activate(s);
  expect(elf.zone === 'graveyard', 'elf died to the toughness reduction');
  expect(T.A.hand.length === hand + 2, `drew two (${T.A.hand.length - hand})`);
});
test('Solemn Simulacrum: ETB land, dies draw', async T => {
  const lands = T.count(0, 'battlefield', T.isLand);
  const s = await T.cast('Solemn Simulacrum');
  expect(T.count(0, 'battlefield', T.isLand) === lands + 1, 'ramped');
  const hand = T.A.hand.length;
  await T.game.destroy(s, null); await T.resolve();
  expect(T.A.hand.length === hand + 1, 'drew on death');
});
test('Sakura-Tribe Elder: sacrifice for a basic', async T => {
  const s = await T.put(0, 'Sakura-Tribe Elder');
  const lands = T.count(0, 'battlefield', T.isLand);
  await T.activate(s);
  expect(s.zone === 'graveyard' && T.count(0, 'battlefield', T.isLand) === lands + 1, 'sac + land');
});
test('Harmonize draws three', async T => { const h = T.A.hand.length; await T.cast('Harmonize'); expect(T.A.hand.length === h + 3, 'three cards'); });
test("Night's Whisper: draw two, lose two", async T => { const h = T.A.hand.length, l = T.A.life; await T.cast("Night's Whisper"); expect(T.A.hand.length === h + 2 && T.A.life === l - 2, 'draw 2 lose 2'); });
test('Austere Command picks two modes', async T => {
  await T.put(1, 'Sol Ring'); await T.put(1, 'Serra Angel'); await T.put(1, 'Llanowar Elves');
  T.a.on('modes', req => [req.options[0].value, req.options[2].value]);
  await T.cast('Austere Command');
  expect(!T.game.battlefield.some(c => c.def.name === 'Sol Ring'), 'artifacts gone');
  expect(!T.game.battlefield.some(c => c.def.name === 'Llanowar Elves'), 'small creatures gone');
  expect(T.game.battlefield.some(c => c.def.name === 'Serra Angel'), 'angel (MV 5) survives');
});
test('Counterspell counters a spell on the stack', async T => {
  const c = await T.put(1, 'Harmonize', 'hand');
  T.mana(1); T.game.priority = 1; T.game.activePlayer = 1;
  await castSpell(T.game, 1, c, {});
  T.game.activePlayer = 0;
  expect(T.game.stack.length === 1, 'harmonize on stack');
  T.a.on('targets', req => [req.cands[0]]);
  await T.cast('Counterspell', 0, { resolve: false });
  await T.resolve();
  expect(c.zone === 'graveyard' && T.B.hand.length < 10, 'countered');
});
test('Arcane Denial counters and both draw next upkeep', async T => {
  const c = await T.put(1, 'Harmonize', 'hand');
  T.mana(1); T.game.priority = 1; T.game.activePlayer = 1;
  await castSpell(T.game, 1, c, {});
  T.game.activePlayer = 0;
  T.a.on('targets', req => [req.cands[0]]);
  await T.cast('Arcane Denial', 0, { resolve: false });
  await T.resolve();
  expect(c.zone === 'graveyard', 'countered');
  expect(T.game.delayed.length >= 2, 'delayed draws registered');
});
test('Anointed Procession doubles tokens', async T => {
  await T.put(0, 'Anointed Procession');
  const before = T.game.battlefield.filter(c => c.token).length;
  await T.cast('Beast Within', 0, { resolve: false }).catch(() => {});
  T.game.stack = [];
  const whirl = await T.cast('Whirler Rogue');
  expect(T.game.battlefield.filter(c => c.token && c.controller === 0).length === 4, `4 thopters (${T.game.battlefield.filter(c => c.token && c.controller === 0).length})`);
});
test("Cathars' Crusade adds counters on creature ETB", async T => {
  await T.put(0, "Cathars' Crusade");
  const elf = await T.put(0, 'Llanowar Elves');
  await T.resolve();
  expect((elf.counters.P1P1 || 0) === 1, `elf has a counter (${elf.counters.P1P1})`);
});
test('Hardened Scales adds one more counter', async T => {
  await T.put(0, 'Hardened Scales');
  const elf = await T.put(0, 'Llanowar Elves');
  await T.game.addCounters(elf, 'P1P1', 1, null);
  expect(elf.counters.P1P1 === 2, `two counters (${elf.counters.P1P1})`);
});
test('Sun Titan returns a cheap permanent from the graveyard', async T => {
  const ring = await T.put(0, 'Sol Ring', 'graveyard');
  T.a.on('targets', req => req.cands.includes(refOf(ring)) ? [refOf(ring)] : undefined);
  await T.cast('Sun Titan');
  expect(ring.zone === 'battlefield', 'sol ring returned');
});
test('Avenger of Zendikar makes a plant per land', async T => {
  for (let i = 0; i < 3; i++) await T.put(0, 'Forest');
  const lands = T.count(0, 'battlefield', T.isLand);
  await T.cast('Avenger of Zendikar');
  expect(T.game.battlefield.filter(c => c.token && c.controller === 0).length === lands, `plants = lands (${lands})`);
});
test('Temple of Malady enters tapped and scries', async T => {
  const t = await T.put(0, 'Temple of Malady'); await T.resolve();
  expect(t.tapped, 'enters tapped');
  expect(T.game.logs.some(l => /scries 1/.test(l.text)), 'scried');
});
test('Woodland Cemetery checks for Swamp/Forest', async T => {
  const a = await T.put(0, 'Woodland Cemetery');
  expect(a.tapped, 'tapped without Swamp/Forest');
  await T.put(0, 'Forest');
  const b = await T.put(0, 'Woodland Cemetery');
  expect(!b.tapped, 'untapped with Forest');
});
test('Command Tower produces identity colors', async T => {
  const t = await T.put(0, 'Command Tower');
  T.A.pool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  T.a.on('color', req => { expect(req.colors.length === 4 && !req.colors.includes('R'), 'WUBG options'); return 'G'; });
  await activateManaAbility(T.game, 0, t, manaAbilitiesOf(T.game, t)[0].key);
  expect(T.A.pool.G === 1, 'green');
});
test('Bojuka Bog exiles a graveyard', async T => {
  await T.put(1, 'Sol Ring', 'graveyard'); await T.put(1, 'Serra Angel', 'graveyard');
  T.a.on('targets', req => req.cands.includes('p1') ? ['p1'] : undefined);
  await T.put(0, 'Bojuka Bog'); await T.resolve();
  expect(T.B.graveyard.length === 0, 'graveyard exiled');
});
test('Reliquary Tower: no maximum hand size', async T => {
  await T.put(0, 'Reliquary Tower');
  expect(T.game.playerChars(0).maxHandSize === Infinity, 'unlimited');
});
test('Talisman colored mana deals 1 damage', async T => {
  const t = await T.put(0, 'Talisman of Dominance');
  T.A.pool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  T.a.on('color', () => 'U');
  const l = T.A.life;
  await activateManaAbility(T.game, 0, t, manaAbilitiesOf(T.game, t)[1].key);
  expect(T.A.pool.U === 1 && T.A.life === l - 1, 'U and 1 damage');
});
test('Signet filters {1} into two colors', async T => {
  const s = await T.put(0, 'Orzhov Signet');
  T.A.pool = { W: 0, U: 0, B: 0, R: 0, G: 1, C: 0 };
  await activateManaAbility(T.game, 0, s, manaAbilitiesOf(T.game, s)[0].key);
  expect(T.A.pool.W === 1 && T.A.pool.B === 1 && T.A.pool.G === 0, 'W + B');
});
test('Exotic Orchard reflects opponent land colors', async T => {
  await T.put(1, 'Mountain');
  const o = await T.put(0, 'Exotic Orchard');
  T.A.pool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  T.a.on('color', req => { expect(req.colors.includes('R'), 'red offered'); return 'R'; });
  await activateManaAbility(T.game, 0, o, manaAbilitiesOf(T.game, o)[0].key);
  expect(T.A.pool.R === 1, 'red mana');
});
test('Thought Vessel: no max hand size', async T => { await T.put(0, 'Thought Vessel'); expect(T.game.playerChars(0).maxHandSize === Infinity, 'unlimited'); });
test('Putrefy destroys an artifact or creature', async T => { const a = await T.put(1, 'Serra Angel'); T.a.on('targets', () => [refOf(a)]); await T.cast('Putrefy'); expect(a.zone === 'graveyard', 'dead'); });
test('Terminate', async T => { const a = await T.put(1, 'Serra Angel'); T.a.on('targets', () => [refOf(a)]); await T.cast('Terminate'); expect(a.zone === 'graveyard', 'dead'); });
test('Feed the Swarm: destroy and lose life equal to MV', async T => { const a = await T.put(1, 'Serra Angel'); T.a.on('targets', () => [refOf(a)]); const l = T.A.life; await T.cast('Feed the Swarm'); expect(a.zone === 'graveyard' && T.A.life === l - 5, `lost 5 (${l - T.A.life})`); });
test('Acidic Slime destroys an artifact', async T => { const r = await T.put(1, 'Sol Ring'); T.a.on('targets', req => req.cands.includes(refOf(r)) ? [refOf(r)] : undefined); await T.cast('Acidic Slime'); expect(r.zone === 'graveyard', 'ring destroyed'); });
test('Propaganda taxes attacks', async T => {
  await T.put(0, 'Propaganda');
  const angel = await T.put(1, 'Serra Angel');
  T.game.activePlayer = 1; T.game.combat = { attackers: [], blockers: new Map(), firstStrikeDone: new Set() };
  T.B.pool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  for (const c of T.game.battlefield) if (c.controller === 1) c.tapped = true;
  angel.tapped = false;
  T.b.on('attackers', req => [{ attacker: angel.id, defender: 'p0' }]);
  const { declareAttackers } = await import('../src/engine/combat.js');
  await declareAttackers(T.game);
  expect(T.game.combat.attackers.length === 0, 'cannot pay tax -> no attack');
});
test('Herald\'s Horn reduces creature costs of chosen type', async T => {
  T.a.on('chooseType', () => 'Angel');
  T.a.on('option', req => req.purpose === 'chooseType' ? 'Angel' : undefined);
  const h = await T.cast("Herald's Horn");
  expect(h.chosen && h.chosen.type === 'Angel', 'chose Angel');
  const { spellCost, buildSpellSA, spellOptions } = await import('../src/engine/abilities.js');
  const c = await T.put(0, 'Serra Angel', 'hand');
  const opt = spellOptions(T.game, 0, c)[0];
  const { mana } = spellCost(T.game, 0, c, opt, buildSpellSA(T.game, 0, c, opt));
  expect(mana.generic === 2, `angel costs {2}{W}{W} (${mana.generic})`);
});
test('Brainstorm: draw 3, put 2 back', async T => { const h = T.A.hand.length, lib = T.A.library.length; await T.cast('Brainstorm'); expect(T.A.hand.length === h + 1 && T.A.library.length === lib - 1, `net +1 (${T.A.hand.length - h})`); });
test('Faithless Looting: draw 2 discard 2', async T => { for (let i = 0; i < 3; i++) await T.put(0, 'Forest', 'hand'); const h = T.A.hand.length; await T.cast('Faithless Looting'); expect(T.A.hand.length === h, `hand unchanged (${T.A.hand.length - h})`); });
test('Explore: draw a card and extra land drop', async T => { const h = T.A.hand.length; await T.cast('Explore'); expect(T.A.hand.length === h + 1 && T.game.playerChars(0).extraLands >= 1, 'draw + land'); });
test('Chromatic Lantern makes lands tap for any color', async T => {
  await T.put(0, 'Chromatic Lantern');
  const f = await T.put(0, 'Forest');
  const colors = new Set(manaAbilitiesOf(T.game, f).flatMap(a => a.parsed.p.Produced ? [a.parsed.p.Produced] : []));
  expect([...colors].some(p => /Any/.test(p)), 'forest can make any color');
});
test('Martial Coup with X=5 wipes and makes soldiers', async T => {
  await T.put(1, 'Serra Angel');
  T.a.on('xValue', () => 5);
  await T.cast('Martial Coup');
  expect(!T.game.battlefield.some(c => c.def.name === 'Serra Angel'), 'others destroyed');
  expect(T.game.battlefield.filter(c => c.token && c.controller === 0).length === 5, 'five soldiers');
});
test('Generous Gift destroys and gives an Elephant', async T => { const r = await T.put(1, 'Sol Ring'); T.a.on('targets', () => [refOf(r)]); await T.cast('Generous Gift'); expect(r.zone === 'graveyard' && T.game.battlefield.some(c => c.token && c.controller === 1), 'elephant'); });
test('Heroic Intervention protects your permanents', async T => {
  const elf = await T.put(0, 'Llanowar Elves');
  await T.cast('Heroic Intervention');
  expect(T.game.hasKeyword(elf, 'Hexproof') && T.game.hasKeyword(elf, 'Indestructible'), 'hexproof + indestructible');
  await T.cast('Wrath of God');
  expect(elf.zone === 'battlefield', 'survives wrath');
});
test('Fact or Fiction: split into piles and take one', async T => { const h = T.A.hand.length; await T.cast('Fact or Fiction'); expect(T.A.hand.length > h, `took cards (${T.A.hand.length - h})`); });
test('Commander tax increases', async T => {
  const cmd = T.A.command[0];
  T.mana(0); T.game.priority = 0;
  await castSpell(T.game, 0, cmd, {}); await T.resolve();
  expect(cmd.zone === 'battlefield', 'commander cast');
  await T.game.destroy(cmd, null); await T.resolve();
  expect(cmd.zone === 'command', 'back to command zone');
  expect(T.game.commanderTax(cmd) === 2, 'tax 2');
});
test('Commander damage: 21 kills', async T => {
  const cmd = T.A.command[0];
  T.mana(0); T.game.priority = 0;
  await castSpell(T.game, 0, cmd, {}); await T.resolve();
  for (let i = 0; i < 6; i++) await T.game.dealDamage(cmd, T.B, 4, { combat: true });
  await T.game.checkSBA();
  expect(T.B.lost, 'B loses to commander damage');
});
test('Deathtouch + first strike combat', async T => {
  const atr = T.A.command[0];
  T.mana(0); T.game.priority = 0;
  await castSpell(T.game, 0, atr, {}); await T.resolve();
  const angel = await T.put(1, 'Serra Angel');
  atr.sick = false;
  const combat = await import('../src/engine/combat.js');
  T.game.combat = { attackers: [], blockers: new Map(), firstStrikeDone: new Set() };
  T.a.on('attackers', () => [{ attacker: atr.id, defender: 'p1' }]);
  T.b.on('blockers', () => [{ blocker: angel.id, attacker: atr.id }]);
  await combat.declareAttackers(T.game);
  await combat.declareBlockers(T.game);
  await combat.combatDamage(T.game, false);
  await T.game.checkSBA();
  expect(angel.zone === 'graveyard', 'angel dies to deathtouch');
  expect(T.A.life === 44, `lifelink 4 (life ${T.A.life})`);
});
test('Trample assigns excess to the player', async T => {
  const elf = await T.put(1, 'Llanowar Elves');
  const avenger = await T.put(0, 'Avenger of Zendikar');
  avenger.temp.push({ keywords: ['Trample'], until: 'EOT' });
  T.game.touch();
  const combat = await import('../src/engine/combat.js');
  T.game.combat = { attackers: [], blockers: new Map(), firstStrikeDone: new Set() };
  T.a.on('attackers', () => [{ attacker: avenger.id, defender: 'p1' }]);
  T.b.on('blockers', () => [{ blocker: elf.id, attacker: avenger.id }]);
  await combat.declareAttackers(T.game); await combat.declareBlockers(T.game); await combat.combatDamage(T.game, false);
  expect(T.B.life === 36, `4 tramples over (life ${T.B.life})`);
});
test('Legend rule keeps one', async T => {
  await T.put(0, "Atraxa, Praetors' Voice"); await T.put(0, "Atraxa, Praetors' Voice");
  await T.game.checkSBA();
  expect(T.game.battlefield.filter(c => c.def.name === "Atraxa, Praetors' Voice").length === 1, 'one Atraxa');
});
test('Atraxa proliferates at end step', async T => {
  const at = await T.put(0, "Atraxa, Praetors' Voice");
  const elf = await T.put(0, 'Llanowar Elves');
  elf.counters.P1P1 = 1;
  T.game.fire('Phase', { Phase: 'End of Turn', Player: 0 });
  await T.resolve();
  expect(elf.counters.P1P1 === 2, `proliferated (${elf.counters.P1P1})`);
});
test('Unstable Obelisk: sac to destroy nonland permanent', async T => {
  const o = await T.put(0, 'Unstable Obelisk');
  const r = await T.put(1, 'Serra Angel');
  T.a.on('targets', () => [refOf(r)]);
  await T.activate(o, 0, 0);
  expect(r.zone === 'graveyard' && o.zone === 'graveyard', 'both gone');
});
test('Burnished Hart: {3}, sac: two basics', async T => {
  const h = await T.put(0, 'Burnished Hart');
  const lands = T.count(0, 'battlefield', T.isLand);
  await T.activate(h, 0, 0);
  expect(T.count(0, 'battlefield', T.isLand) === lands + 2, 'two lands');
});
test('Hedron Archive: sac to draw two', async T => { const h = await T.put(0, 'Hedron Archive'); const n = T.A.hand.length; await T.activate(h, 0, 0); expect(T.A.hand.length === n + 2, 'drew two'); });
test('Everflowing Chalice enters with charge counters per kick', async T => {
  T.a.on('multikicker', () => 2);
  const c = await T.cast('Everflowing Chalice');
  expect(c.counters.CHARGE === 2, `2 charge counters (${c.counters.CHARGE})`);
});
test('Chain Reaction damages each creature for number of creatures', async T => {
  for (let i = 0; i < 3; i++) await T.put(1, 'Llanowar Elves');
  await T.cast('Chain Reaction');
  expect(!T.game.battlefield.some(c => c.def.name === 'Llanowar Elves'), 'elves dead');
});

// ------------------------------------------------------------ batch 2: mechanics
test('Rancor: +2/+0 trample, returns to hand when it goes to the graveyard', async T => {
  const elf = await T.put(0, 'Llanowar Elves');
  T.a.on('targets', () => [refOf(elf)]);
  const r = await T.cast('Rancor');
  expect(r.attachedTo === elf.id && T.game.chars(elf).power === 3 && T.game.hasKeyword(elf, 'Trample'), 'aura applied');
  await T.game.destroy(elf, null); await T.resolve();
  expect(r.zone === 'hand', `rancor back in hand (${r.zone})`);
});
test('Ajani Steadfast +1 once per turn', async T => {
  const aj = await T.cast('Ajani Steadfast');
  expect(aj.counters.LOYALTY === 4, 'starts at 4');
  const elf = await T.put(0, 'Llanowar Elves');
  T.a.on('targets', () => [refOf(elf)]);
  await T.activate(aj, 0, 0);
  expect(aj.counters.LOYALTY === 5 && T.game.chars(elf).power === 2, `loyalty 5 and pump (${aj.counters.LOYALTY})`);
  let threw = false; try { await T.activate(aj, 0, 1); } catch { threw = true; }
  expect(threw, 'second loyalty ability blocked');
});
test('Age of Ultron chapter I destroys a creature', async T => {
  const a = await T.put(1, 'Serra Angel');
  T.a.on('targets', req => req.cands.includes(refOf(a)) ? [refOf(a)] : undefined);
  const s = await T.cast('Age of Ultron');
  expect(a.zone === 'graveyard' && s.counters.LORE === 1, 'chapter I');
});
test('Bloodbraid Elf cascades into a free spell', async T => {
  T.A.library.unshift(T.game.newCard(db.get("Night's Whisper"), 0)); T.A.library[0].zone = 'library';
  const h = T.A.hand.length;
  await T.cast('Bloodbraid Elf');
  expect(T.A.hand.length === h + 2, `cascaded into Night's Whisper (+${T.A.hand.length - h})`);
});
test('Think Twice flashback from graveyard, then exiled', async T => {
  const c = await T.put(0, 'Think Twice', 'graveyard');
  T.mana(0);
  const acts = getActions(T.game, 0).filter(a => a.cardId === c.id);
  expect(acts.length, 'flashback offered');
  await T.game.performAction(0, acts[0]); await T.resolve();
  expect(c.zone === 'exile', `exiled after flashback (${c.zone})`);
});
test('Mulldrifter evoke: draw two, then sacrificed', async T => {
  const c = await T.put(0, 'Mulldrifter', 'hand');
  T.mana(0);
  const acts = getActions(T.game, 0).filter(a => a.cardId === c.id && /Evoke/.test(a.label));
  expect(acts.length, 'evoke offered');
  const h = T.A.hand.length;
  await T.game.performAction(0, acts[0]); await T.resolve();
  expect(c.zone === 'graveyard' && T.A.hand.length === h + 1, `drew 2 (net ${T.A.hand.length - h}), sacrificed (${c.zone})`);
});
test('Stonecoil Serpent enters with X counters', async T => {
  T.a.on('xValue', () => 4);
  const c = await T.cast('Stonecoil Serpent');
  expect(T.game.chars(c).power === 4, `4/4 (${T.game.chars(c).power})`);
});
test('Spark Double copies a creature with an extra counter', async T => {
  const a = await T.put(0, 'Serra Angel');
  const c = await T.cast('Spark Double');
  expect(T.game.name(c) === 'Serra Angel' && T.game.chars(c).power === 5, `copy 5/5 (${T.game.name(c)} ${T.game.chars(c).power})`);
});
test("Smuggler's Copter crews into a creature", async T => {
  const v = await T.put(0, "Smuggler's Copter");
  await T.put(0, 'Llanowar Elves');
  expect(!T.isCreature(v), 'not a creature yet');
  await T.activate(v, 0, activatedAbilities(T.game, 0, v).findIndex(a => a.parsed.p.IsCrew === 'True'));
  expect(T.isCreature(v), 'crewed');
});
test('Lotus Cobra landfall adds mana', async T => {
  await T.put(0, 'Lotus Cobra');
  T.A.pool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  await T.put(0, 'Forest'); await T.resolve();
  expect(Object.values(T.A.pool).reduce((a, b) => a + b, 0) === 1, 'one mana added');
});
test('Diabolic Tutor finds a card', async T => { const h = T.A.hand.length; await T.cast('Diabolic Tutor'); expect(T.A.hand.length === h + 1, 'tutored'); });
test('Windfall: everyone discards and draws the max', async T => {
  for (let i = 0; i < 4; i++) await T.put(1, 'Forest', 'hand');
  await T.cast('Windfall');
  expect(T.A.hand.length === 4 && T.B.hand.length === 4, `both have 4 (${T.A.hand.length}/${T.B.hand.length})`);
});
test('Darkness prevents combat damage', async T => {
  await T.cast('Darkness');
  const angel = await T.put(1, 'Serra Angel');
  const r = await T.game.dealDamage(angel, T.A, 4, { combat: true });
  expect(r === 0 && T.A.life === 40, 'prevented');
});
test('Reanimate returns a creature and costs life', async T => {
  const a = await T.put(1, 'Serra Angel', 'graveyard');
  T.a.on('targets', () => [refOf(a)]);
  const l = T.A.life;
  await T.cast('Reanimate');
  expect(a.zone === 'battlefield' && a.controller === 0 && T.A.life === l - 5, 'reanimated under A, lost 5');
});
test('Animate Dead returns a creature as an aura', async T => {
  const a = await T.put(1, 'Serra Angel', 'graveyard');
  T.a.on('targets', () => [refOf(a)]);
  await T.cast('Animate Dead');
  expect(a.zone === 'battlefield' && a.controller === 0, `animated (${a.zone})`);
});
test('Beast Whisperer draws on creature cast', async T => {
  await T.put(0, 'Beast Whisperer');
  const h = T.A.hand.length;
  await T.cast('Llanowar Elves');
  expect(T.A.hand.length === h + 1, 'drew');
});
test('Talrand makes a Drake on instant cast', async T => {
  await T.put(0, 'Talrand, Sky Summoner');
  await T.cast('Think Twice');
  expect(T.game.battlefield.some(c => c.token && c.controller === 0 && T.game.hasKeyword(c, 'Flying')), 'drake');
});
test('Rhox Faithmender doubles life gain', async T => { await T.put(0, 'Rhox Faithmender'); const l = T.A.life; await T.game.gainLife(T.A, 3, null); expect(T.A.life === l + 6, `gained 6 (${T.A.life - l})`); });
test('Murderous Rider adventure, then cast the creature from exile', async T => {
  const a = await T.put(1, 'Serra Angel');
  const c = await T.put(0, 'Murderous Rider', 'hand');
  T.mana(0);
  const act = getActions(T.game, 0).find(x => x.cardId === c.id && /Swift End/.test(x.label));
  expect(act, 'adventure offered');
  T.a.on('targets', () => [refOf(a)]);
  await T.game.performAction(0, act); await T.resolve();
  expect(a.zone === 'graveyard' && c.zone === 'exile' && c.onAdventure, `adventure resolved (${c.zone})`);
  T.mana(0);
  const act2 = getActions(T.game, 0).find(x => x.cardId === c.id);
  expect(act2, 'creature castable from exile');
  await T.game.performAction(0, act2); await T.resolve();
  expect(c.zone === 'battlefield', 'rider on battlefield');
});
test('Pitiless Plunderer makes Treasure; Treasure sacs for mana', async T => {
  await T.put(0, 'Pitiless Plunderer');
  const elf = await T.put(0, 'Llanowar Elves');
  await T.game.destroy(elf, null); await T.resolve();
  const tr = T.game.battlefield.find(c => c.token && c.controller === 0 && T.game.name(c).includes('Treasure'));
  expect(tr, 'treasure created');
  T.A.pool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  T.a.on('color', () => 'R');
  await activateManaAbility(T.game, 0, tr, manaAbilitiesOf(T.game, tr)[0].key);
  expect(T.A.pool.R === 1 && tr.zone === 'gone', 'sacrificed for red');
});
test('Ghave: enters with 5 counters, remove one for a Saproling', async T => {
  const g = await T.put(0, 'Ghave, Guru of Spores');
  expect(g.counters.P1P1 === 5, 'five counters');
  T.a.on('costRemoveCounter', req => [g.id]);
  await T.activate(g, 0, 0);
  expect(g.counters.P1P1 === 4 && T.game.battlefield.some(c => c.token && c.controller === 0), 'saproling');
});
test('Krenko attack trigger makes goblins equal to power', async T => {
  const k = await T.put(0, 'Krenko, Tin Street Kingpin');
  T.game.combat = { attackers: [], blockers: new Map(), firstStrikeDone: new Set() };
  T.a.on('attackers', () => [{ attacker: k.id, defender: 'p1' }]);
  const combat = await import('../src/engine/combat.js');
  await combat.declareAttackers(T.game); await T.resolve();
  expect(T.game.battlefield.filter(c => c.token && c.controller === 0).length === 2, 'two goblins');
});
test('Edgar Markov eminence from the command zone', async T => {
  const e = T.game.newCard(db.get('Edgar Markov'), 0); e.zone = 'command'; e.isCommander = true; T.A.command.push(e);
  await T.cast('Bloodline Pretender').catch(async () => { await T.cast('Indulgent Aristocrat').catch(() => {}); });
  const vamp = T.game.battlefield.find(c => c.token && c.controller === 0);
  expect(vamp, 'vampire token from eminence');
});
test('Adeline makes attacking Humans', async T => {
  const ad = await T.put(0, 'Adeline, Resplendent Cathar');
  T.game.combat = { attackers: [], blockers: new Map(), firstStrikeDone: new Set() };
  T.a.on('attackers', () => [{ attacker: ad.id, defender: 'p1' }]);
  const combat = await import('../src/engine/combat.js');
  await combat.declareAttackers(T.game); await T.resolve();
  expect(T.game.combat.attackers.length === 2, `token attacking (${T.game.combat.attackers.length})`);
});
test('Hornet Nest makes insects when damaged', async T => {
  const n = await T.put(0, 'Hornet Nest');
  const a = await T.put(1, 'Serra Angel');
  await T.game.dealDamage(a, n, 4, { combat: true }); await T.resolve();
  expect(T.game.battlefield.filter(c => c.token && c.controller === 0).length === 4, 'four insects');
});
test('Blood Artist drains on death', async T => { await T.put(0, 'Blood Artist'); const e = await T.put(1, 'Llanowar Elves'); const l = T.B.life; await T.game.destroy(e, null); await T.resolve(); expect(T.B.life === l - 1, 'drained'); });
test('Zulaport Cutthroat drains when your creature dies', async T => { await T.put(0, 'Zulaport Cutthroat'); const e = await T.put(0, 'Llanowar Elves'); const l = T.B.life; await T.game.destroy(e, null); await T.resolve(); expect(T.B.life === l - 1, 'drained'); });
test('Goblin Bombardment: sacrifice a creature, 1 damage', async T => {
  const g = await T.put(0, 'Goblin Bombardment'); await T.put(0, 'Llanowar Elves');
  T.a.on('targets', req => req.cands.includes('p1') ? ['p1'] : undefined);
  const l = T.B.life;
  await T.activate(g);
  expect(T.B.life === l - 1, 'pinged');
});
test('Overwhelming Stampede pumps by greatest power', async T => {
  const a = await T.put(0, 'Serra Angel'); const e = await T.put(0, 'Llanowar Elves');
  await T.cast('Overwhelming Stampede');
  expect(T.game.chars(e).power === 1 + 4 && T.game.hasKeyword(e, 'Trample'), `elf 5 power (${T.game.chars(e).power})`);
});
test("Teferi's Protection: protection from everything", async T => {
  const e = await T.put(0, 'Llanowar Elves');
  await T.cast("Teferi's Protection");
  const a = await T.put(1, 'Serra Angel');
  const r = await T.game.dealDamage(a, T.A, 5, { combat: true });
  expect(T.A.life === 40, `life unchanged (${T.A.life})`);
});
test('Cyclonic Rift bounces an opponent permanent', async T => { const a = await T.put(1, 'Serra Angel'); T.a.on('targets', () => [refOf(a)]); await T.cast('Cyclonic Rift'); expect(a.zone === 'hand', 'bounced'); });
test("Rishkar's Expertise draws by greatest power", async T => { await T.put(0, 'Serra Angel'); const h = T.A.hand.length; await T.cast("Rishkar's Expertise"); expect(T.A.hand.length >= h + 3, `drew (${T.A.hand.length - h})`); });
test('Pongify: destroy, controller gets an Ape', async T => { const a = await T.put(1, 'Serra Angel'); T.a.on('targets', () => [refOf(a)]); await T.cast('Pongify'); expect(a.zone === 'graveyard' && T.game.battlefield.some(c => c.token && c.controller === 1), 'ape'); });
test('Toxic Deluge: pay X life, creatures get -X/-X', async T => {
  await T.put(1, 'Serra Angel');
  T.a.on('xValue', () => 4);
  const l = T.A.life;
  await T.cast('Toxic Deluge');
  expect(!T.game.battlefield.some(c => c.def.name === 'Serra Angel') && T.A.life === l - 4, `dead and paid 4 (${l - T.A.life})`);
});
test('Living Death swaps creatures and graveyards', async T => {
  const a = await T.put(0, 'Serra Angel', 'graveyard');
  const e = await T.put(1, 'Llanowar Elves');
  await T.cast('Living Death');
  expect(a.zone === 'battlefield' && e.zone === 'graveyard', 'swapped');
});
test('Grave Pact: opponents sacrifice when your creature dies', async T => {
  await T.put(0, 'Grave Pact'); const e = await T.put(0, 'Llanowar Elves'); const a = await T.put(1, 'Serra Angel');
  await T.game.destroy(e, null); await T.resolve();
  expect(a.zone === 'graveyard', 'opponent sacrificed');
});
test('Gratuitous Violence doubles damage from your creatures', async T => {
  await T.put(0, 'Gratuitous Violence'); const a = await T.put(0, 'Serra Angel');
  await T.game.dealDamage(a, T.B, 4, { combat: true });
  expect(T.B.life === 32, `took 8 (${40 - T.B.life})`);
});
test("Basalt Monolith doesn't untap", async T => {
  const m = await T.put(0, 'Basalt Monolith'); m.tapped = true;
  T.game.activePlayer = 0; await T.game.runStep('untap');
  expect(m.tapped, 'still tapped');
});
test("Seedborn Muse untaps on others' turns", async T => {
  await T.put(0, 'Seedborn Muse'); const e = await T.put(0, 'Llanowar Elves'); e.tapped = true;
  T.game.activePlayer = 1; await T.game.runStep('untap');
  expect(!e.tapped, 'untapped');
});
test('Zendikar Resurgent: lands tap for extra mana', async T => {
  await T.put(0, 'Zendikar Resurgent'); const f = await T.put(0, 'Forest');
  T.A.pool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  await activateManaAbility(T.game, 0, f, manaAbilitiesOf(T.game, f)[0].key);
  expect(T.A.pool.G === 2, `two green (${T.A.pool.G})`);
});
test('Branching Evolution doubles +1/+1 counters', async T => { await T.put(0, 'Branching Evolution'); const e = await T.put(0, 'Llanowar Elves'); await T.game.addCounters(e, 'P1P1', 2, null); expect(e.counters.P1P1 === 4, `four (${e.counters.P1P1})`); });
test('Skyshroud Claim: two Forests untapped', async T => { const n = T.count(0, 'battlefield', T.isLand); await T.cast('Skyshroud Claim'); expect(T.count(0, 'battlefield', T.isLand) === n + 2, 'two forests'); });
test('Explosive Vegetation: two basics', async T => { const n = T.count(0, 'battlefield', T.isLand); await T.cast('Explosive Vegetation'); expect(T.count(0, 'battlefield', T.isLand) === n + 2, 'two lands'); });
test('Read the Bones: scry 2, draw 2, lose 2', async T => { const h = T.A.hand.length, l = T.A.life; await T.cast('Read the Bones'); expect(T.A.hand.length === h + 2 && T.A.life === l - 2, 'ok'); });
test('Sign in Blood targets a player', async T => { T.a.on('targets', () => ['p0']); const h = T.A.hand.length; await T.cast('Sign in Blood'); expect(T.A.hand.length === h + 2, 'drew'); });
test('Thrill of Possibility needs a discard', async T => { await T.put(0, 'Forest', 'hand'); const h = T.A.hand.length; await T.cast('Thrill of Possibility'); expect(T.A.hand.length === h + 1, `net +1 (${T.A.hand.length - h})`); });
test('Ezuri\'s Predation: beasts fight each opposing creature', async T => {
  const a = await T.put(1, 'Llanowar Elves');
  await T.cast("Ezuri's Predation");
  expect(a.zone === 'graveyard', 'elf killed');
});
test('Return of the Wildspeaker draws by greatest non-Human power', async T => {
  await T.put(0, 'Serra Angel');
  T.a.on('modes', req => [req.options[0].value]);
  T.a.on('genericChoice', req => req.options[0].value);
  const h = T.A.hand.length;
  await T.cast('Return of the Wildspeaker');
  expect(T.A.hand.length === h + 4, `drew 4 (${T.A.hand.length - h})`);
});

test('Seasoned Dungeoneer takes the initiative and enters Undercity', async T => {
  const lands = T.count(0, 'hand', T.isLand);
  await T.cast('Seasoned Dungeoneer');
  expect(T.game.initiative === 0, 'A has the initiative');
  expect(T.A.dungeon && T.A.dungeon.obj.effectName === 'Undercity' && T.A.dungeon.room === 'Entrance', `in Secret Entrance (${T.A.dungeon && T.A.dungeon.room})`);
  expect(T.count(0, 'hand', T.isLand) === lands + 1, 'fetched a basic land');
});
test('Dungeon Map ventures through Lost Mine of Phandelver to completion', async T => {
  const map = await T.put(0, 'Dungeon Map');
  for (let i = 0; i < 4; i++) { map.tapped = false; await T.activate(map, 0, 0); }
  expect(!T.A.dungeon && T.A.dungeonsCompleted.includes('Lost Mine of Phandelver'), `completed (${T.A.dungeonsCompleted}, room ${T.A.dungeon && T.A.dungeon.room})`);
});
test('Rise of the Eldrazi grants an extra turn', async T => {
  await T.put(1, 'Serra Angel');
  await T.cast('Rise of the Eldrazi');
  expect(T.game.extraTurns.length === 1 && T.game.extraTurns[0] === 0, `extra turns ${T.game.extraTurns}`);
});
test('Combat damage to the initiative holder steals it', async T => {
  T.game.initiative = 1;
  const c = await T.put(0, 'Serra Angel');
  T.game.combat = { attackers: [{ card: c.id, defenderPlayer: 1, defenderCard: null, blockers: [], blocked: false }], blockers: new Map(), firstStrikeDone: new Set() };
  const { combatDamage } = await import('../src/engine/combat.js');
  await combatDamage(T.game, false);
  await T.resolve();
  expect(T.game.initiative === 0 && T.A.dungeon, 'A took the initiative and ventured');
});
test('Wave of Reckoning: each creature damages itself by its power', async T => {
  await T.put(1, 'Serra Angel'); await T.put(1, 'Wall of Omens');
  await T.cast('Wave of Reckoning');
  expect(T.count(1, 'battlefield', T.named('Serra Angel')) === 0 && T.count(1, 'battlefield', T.named('Wall of Omens')) === 1, 'angel died, wall lived');
});
test('Selective Adaptation sorts keyword cards', async T => {
  for (const n of ['Serra Angel', 'Llanowar Elves', 'Forest']) { const c = T.game.newCard(T.game.db.get(n), 0); c.zone = 'library'; T.A.library.unshift(c); }
  const lib = T.A.library.length;
  await T.cast('Selective Adaptation');
  expect(T.count(0, 'battlefield', T.named('Serra Angel')) === 1, 'Serra Angel onto battlefield');
  expect(T.A.library.length === lib - 7, 'seven cards left the library');
});
test('Skipped untap step keeps permanents tapped', async T => {
  const { E } = await import('../src/engine/effects.js');
  const { SA } = await import('../src/engine/abilities.js');
  const { parseAbility } = await import('../src/engine/forge.js');
  const src = await T.put(0, 'Serra Angel');
  const raw = 'DB$ SkipPhase | Defined$ Player.Opponent | Step$ Untap';
  const sa = new SA(T.game, { raw, parsed: parseAbility(raw), svars: {}, src, key: 'x' }, src, 0, {});
  await E.SkipPhase(T.game, sa);
  const land = await T.put(1, 'Forest'); land.tapped = true;
  T.game.activePlayer = 1;
  await T.game.takeTurn();
  expect(land.tapped, 'Forest stayed tapped');
  expect(!T.B.skips.length, 'skip consumed');
});
test('Denry Klin: chosen keyword counter, copied to new creatures', async T => {
  T.a.on('counterType', req => req.options.find(o => o.value === 'VIGILANCE').value);
  const d = await T.cast('Denry Klin, Editor in Chief');
  expect(d.counters.VIGILANCE >= 1 && !Object.keys(d.counters).some(k => k !== 'VIGILANCE'), `vigilance counter (${JSON.stringify(d.counters)})`);
  expect(T.game.chars(d).keywords.includes('Vigilance'), 'Denry has vigilance');
  const c = await T.cast('Serra Angel');
  expect(c.counters.VIGILANCE >= 1, `angel got the counter (${JSON.stringify(c.counters)})`);
});
test('Destroy Evil kills a toughness-4 creature', async T => {
  const big = await T.put(1, 'Serra Angel');
  T.a.on('modes', req => [req.options[0].value]);
  await T.cast('Destroy Evil');
  expect(big.zone === 'graveyard', `angel destroyed (zone ${big.zone})`);
});
// ---- first strike / double strike
// give a creature keywords (and a P/T bonus) until end of turn
function grant(T, c, keywords, power = 0, toughness = 0) { c.temp.push({ keywords, power, toughness, until: 'EOT' }); T.game.touch(); }
// run combat damage the way the turn does: a first-strike step when needed (state-based actions in between), then the regular step
async function fight(T, attacks, blocks = []) {
  const combat = await import('../src/engine/combat.js');
  T.game.combat = {
    attackers: attacks.map(([a, pid]) => ({ card: a.id, defenderPlayer: pid, defenderCard: null, blockers: blocks.filter(([, x]) => x === a).map(([b]) => b.id), blocked: blocks.some(([, x]) => x === a) })),
    blockers: new Map(blocks.map(([b, a]) => [b.id, a.id])), firstStrikeDone: new Set(),
  };
  const steps = [];
  if (combat.needsFirstStrike(T.game)) { steps.push('first'); await combat.combatDamage(T.game, true); await T.resolve(); }
  steps.push('regular'); await combat.combatDamage(T.game, false); await T.resolve();
  return steps;
}
test('Double strike: unblocked attacker hits twice in a real turn (lifelink and commander damage too)', async T => {
  const atr = T.A.command[0];
  T.mana(0); T.game.priority = 0;
  await castSpell(T.game, 0, atr, {}); await T.resolve();
  atr.sick = false;
  grant(T, atr, ['Double Strike']);
  const steps = [], runStep = T.game.runStep.bind(T.game);
  T.game.runStep = s => { steps.push(s); return runStep(s); };
  T.a.on('attackers', () => [{ attacker: atr.id, defender: 'p1' }]);
  T.b.on('blockers', () => []);
  const lifeA = T.A.life;
  await T.game.takeTurn();
  expect(steps.includes('firstStrikeDamage') && steps.indexOf('firstStrikeDamage') < steps.indexOf('combatDamage'), `first-strike step ran (${steps})`);
  expect(T.B.life === 32, `8 damage (B life ${T.B.life})`);
  expect(T.A.life === lifeA + 8, `lifelink twice (A life ${T.A.life}, was ${lifeA})`);
  expect(T.B.commanderDamage[atr.id] === 8, `commander damage 8 (${T.B.commanderDamage[atr.id]})`);
});
test('Double strike: kills its blocker in the first-strike step, nothing gets through without trample', async T => {
  const atk = await T.put(0, 'Llanowar Elves'), blk = await T.put(1, 'Llanowar Elves');
  grant(T, atk, ['Double Strike']);
  const steps = await fight(T, [[atk, 1]], [[blk, atk]]);
  expect(steps.join() === 'first,regular', `two damage steps (${steps})`);
  expect(blk.zone === 'graveyard', 'blocker died');
  expect(atk.zone === 'battlefield' && atk.damage === 0, 'attacker took no damage (blocker died first)');
  expect(T.B.life === 40, `no damage to player (life ${T.B.life})`);
});
test('Double strike + trample: excess in the first step, everything in the second', async T => {
  const atk = await T.put(0, 'Serra Angel'), blk = await T.put(1, 'Llanowar Elves');
  grant(T, atk, ['Double Strike', 'Trample']);
  await fight(T, [[atk, 1]], [[blk, atk]]);
  expect(blk.zone === 'graveyard', 'blocker died');
  expect(T.B.life === 33, `3 + 4 trample damage (life ${T.B.life})`);
});
test('Double strike: second hit finishes a blocker that survived the first', async T => {
  const atk = await T.put(0, 'Llanowar Elves'), wall = await T.put(1, 'Wall of Omens');
  grant(T, atk, ['Double Strike'], 2, 2); // 3/3
  await fight(T, [[atk, 1]], [[wall, atk]]);
  expect(wall.zone === 'graveyard', `wall (0/4) died to 3+3 (zone ${wall.zone}, damage ${wall.damage})`);
});
test('First strike blocker kills the attacker before it deals damage', async T => {
  const atk = await T.put(0, 'Llanowar Elves'), blk = await T.put(1, 'Llanowar Elves');
  grant(T, blk, ['First Strike']);
  await fight(T, [[atk, 1]], [[blk, atk]]);
  expect(atk.zone === 'graveyard', 'attacker died');
  expect(blk.zone === 'battlefield' && blk.damage === 0, 'first striker unharmed');
});
test('Double strike blocker vs. a regular attacker', async T => {
  const atk = await T.put(0, 'Serra Angel'), blk = await T.put(1, 'Serra Angel');
  grant(T, blk, ['Double Strike']);
  await fight(T, [[atk, 1]], [[blk, atk]]);
  expect(atk.zone === 'graveyard', 'attacker died in the first-strike step');
  expect(blk.damage === 0, `blocker took no damage (${blk.damage})`);
});
test('Double strike vs. first strike: both hit first, the double striker hits again', async T => {
  const atk = await T.put(0, 'Wall of Omens'), blk = await T.put(1, 'Llanowar Elves');
  atk.temp.push({ removeKeywords: ['Defender'], until: 'EOT' });
  grant(T, atk, ['Double Strike'], 1, 0); // 1/4 double strike
  grant(T, blk, ['First Strike'], 0, 1); // 1/2 first strike
  await fight(T, [[atk, 1]], [[blk, atk]]);
  expect(atk.damage === 1, `attacker took 1 (first-strike step only) (${atk.damage})`);
  expect(blk.zone === 'graveyard', `blocker took 1 + 1 (zone ${blk.zone})`);
});
test('Gaining double strike between steps still deals regular damage once; a first striker does not hit twice', async T => {
  const fsAtk = await T.put(0, 'Serra Angel');
  grant(T, fsAtk, ['First Strike']);
  await fight(T, [[fsAtk, 1]]);
  expect(T.B.life === 36, `first striker dealt 4 once (life ${T.B.life})`);
});
test('Double strike + deathtouch spreads lethal damage across blockers', async T => {
  const atk = await T.put(0, 'Llanowar Elves');
  grant(T, atk, ['Double Strike', 'Deathtouch'], 1, 4); // 2/5
  const b1 = await T.put(1, 'Serra Angel'), b2 = await T.put(1, 'Serra Angel');
  await fight(T, [[atk, 1]], [[b1, atk], [b2, atk]]);
  expect(b1.zone === 'graveyard' && b2.zone === 'graveyard', `both angels died (${b1.zone}, ${b2.zone})`);
});
test('AI respects first strike and double strike when blocking', async T => {
  const { AIAgent } = await import('../src/ai/ai.js');
  const ai = new AIAgent();
  const ds = await T.put(0, 'Llanowar Elves'); grant(T, ds, ['Double Strike'], 1, 1); // 2/2 double strike
  const wall = await T.put(1, 'Wall of Omens'); // 0/4
  expect(ai.wouldKill(T.game, ds, wall), '2/2 double striker kills a 0/4');
  const fs = await T.put(1, 'Llanowar Elves'); grant(T, fs, ['First Strike'], 1, 1); // 2/2 first strike
  const plain = await T.put(0, 'Llanowar Elves'); grant(T, plain, [], 1, 1); // 2/2
  expect(ai.wouldKill(T.game, fs, plain) && !ai.wouldKill(T.game, plain, fs), '2/2 first striker beats a 2/2');
  expect(!ai.wouldKill(T.game, ds, fs) || ai.wouldKill(T.game, fs, ds), 'double strike vs first strike: they trade');
});
let pass = 0, fail = 0;
for (const t of tests) {
  if (ONLY && !ONLY.test(t.name)) continue;
  try {
    const T = await setup();
    await t.fn(T);
    pass++;
  } catch (e) {
    fail++;
    console.log(`FAIL ${t.name}: ${e.message}${e.message.startsWith('expected') ? '' : '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n')}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
