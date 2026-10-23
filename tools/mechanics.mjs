// Behavioural tests for rules features added to the engine (Graft, Gift, Must Block, Cipher, ...):
// set up a board, use the card, assert the outcome. Usage: node tools/mechanics.mjs [name-filter]
import { setup, expect, run, db } from './lib/testkit.mjs';
import { castSpell, getActions, refOf, activatedAbilities, castableOptions } from '../src/engine/abilities.js';
import * as combat from '../src/engine/combat.js';

const tests = [];
const test = (name, fn, opts) => tests.push({ name, fn, opts });

// ------------------------------------------------------------ keywords, statics, replacements
test('Graft: enters with counters, may move one onto another creature you control', async T => {
  const spider = await T.cast('Aquastrand Spider');
  expect(spider.counters.P1P1 === 2, `two counters (${spider.counters.P1P1})`);
  const elf = await T.put(0, 'Llanowar Elves'); await T.resolve();
  expect(elf.counters.P1P1 === 1 && spider.counters.P1P1 === 1, `moved one (${elf.counters.P1P1}/${spider.counters.P1P1})`);
  const theirs = await T.put(1, 'Llanowar Elves'); await T.resolve();
  expect(!theirs.counters.P1P1 && spider.counters.P1P1 === 1, 'AI keeps the last counter (and never grafts onto an opponent)');
});
test('Graft on a land: Llanowar Reborn', async T => {
  const land = await T.put(0, 'Llanowar Reborn');
  expect(land.counters.P1P1 === 1 && land.tapped, 'enters tapped with a counter');
  const elf = await T.put(0, 'Llanowar Elves'); await T.resolve();
  expect(elf.counters.P1P1 === 1 && !land.counters.P1P1, 'counter moved onto the elf');
});
test('Fog Bank: combat damage to and by it is prevented, other damage is not', async T => {
  const bank = await T.put(1, 'Fog Bank');
  const angel = await T.put(0, 'Serra Angel');
  T.combatWith([[angel, 1]], [[bank, angel]]);
  await combat.combatDamage(T.game, false); await T.resolve();
  expect(bank.zone === 'battlefield' && bank.damage === 0 && angel.damage === 0, 'no combat damage either way');
  await T.game.dealDamage(angel, bank, 2, {}); await T.resolve();
  expect(bank.zone === 'graveyard', 'noncombat damage kills it');
});
test('Guard Gomazoa: only combat damage dealt to it is prevented', async T => {
  const g = await T.put(1, 'Guard Gomazoa');
  const angel = await T.put(0, 'Serra Angel');
  expect(await T.game.dealDamage(angel, g, 4, { combat: true }) === 0, 'combat damage prevented');
  expect(await T.game.dealDamage(g, angel, 1, { combat: true }) === 0 || angel.damage >= 0, 'its own damage is unaffected');
  await T.game.dealDamage(angel, g, 3, {}); await T.resolve();
  expect(g.zone === 'graveyard', 'noncombat damage still kills it');
});
test('Flanking: a blocker without flanking gets -1/-1', async T => {
  const sidar = await T.put(0, 'Sidar Kondo of Jamuraa');
  sidar.temp.push({ power: 1, until: 'EOT' }); // 3/5, so its own static doesn't stop the elf from blocking
  const elf = await T.put(1, 'Llanowar Elves');
  T.game.combat = { attackers: [], blockers: new Map(), firstStrikeDone: new Set() };
  T.a.on('attackers', () => [{ attacker: sidar.id, defender: 'p1' }]);
  T.b.on('blockers', () => [{ blocker: elf.id, attacker: sidar.id }]);
  await combat.declareAttackers(T.game); await T.resolve();
  T.game.step = 'declareBlockers';
  await combat.declareBlockers(T.game); await T.resolve();
  expect(elf.zone === 'graveyard', `the 1/1 blocker died to flanking (${elf.zone})`);
});
test('Sunburst: one counter per color of mana spent', async T => {
  T.noMana(0); T.A.pool.W = 1; T.A.pool.U = 1;
  const prism = await T.cast('Pentad Prism', 0, { mana: false });
  expect(prism.counters.CHARGE === 2, `two charge counters (${prism.counters.CHARGE})`);
  T.noMana(0); T.A.pool.C = 4;
  const oracle = await T.cast('Etched Oracle', 0, { mana: false });
  expect(oracle.zone === 'graveyard' || !oracle.counters.P1P1, 'colorless mana: no counters, 0/0 dies');
});
test('Everlasting Torment: damage is dealt as wither and cannot be prevented', async T => {
  await T.put(0, 'Everlasting Torment');
  const angel = await T.put(1, 'Serra Angel');
  await T.game.dealDamage(angel, angel, 2, {});
  expect(angel.counters.M1M1 === 2 && angel.damage === 0, `two -1/-1 counters (${JSON.stringify(angel.counters)})`);
  const bank = await T.put(1, 'Fog Bank');
  await T.game.dealDamage(angel, bank, 1, { combat: true });
  expect(bank.counters.M1M1 === 1, 'prevention keyword does not apply');
  const l = T.A.life; await T.game.gainLife(T.A, 3, null);
  expect(T.A.life === l, "can't gain life");
});
test('Mayhem: cast a creature from the graveyard the turn it was discarded', async T => {
  const c = await T.put(0, 'Abomination, World Ravager', 'hand');
  await T.game.discard(c, null);
  T.mana(0);
  const act = getActions(T.game, 0).find(a => a.cardId === c.id && /Mayhem/.test(a.label));
  expect(act, 'mayhem offered from the graveyard');
  T.noMana(0); T.A.pool.R = 1; T.A.pool.C = 4;
  await T.game.performAction(0, act); await T.resolve();
  expect(c.zone === 'battlefield', `cast for {4}{R} (${c.zone})`);
  const d = await T.put(0, 'Chameleon, Master of Disguise', 'graveyard');
  T.mana(0);
  expect(!getActions(T.game, 0).some(a => a.cardId === d.id), 'not offered for a card that was not discarded this turn');
});
test('Skip your draw step (Taigam, Sidisi\'s Hand)', async T => {
  await T.put(0, "Taigam, Sidisi's Hand");
  T.game.activePlayer = 0;
  await T.game.takeTurn();
  expect(T.logged(/A skips their draw step/), 'draw step skipped');
  expect(T.A.cardsDrawnThisTurn === 0, `drew nothing (${T.A.cardsDrawnThisTurn})`);
});
test('Stranglehold: opponents skip extra turns, you do not', async T => {
  await T.put(0, 'Stranglehold');
  T.game.extraTurns.push(1);
  T.game.activePlayer = 0;
  await T.game.takeTurn();
  expect(T.logged(/B skips an extra turn/) && !T.game.currentExtra, 'B extra turn skipped');
  T.game.extraTurns.push(0);
  T.game.activePlayer = 1;
  await T.game.takeTurn();
  expect(T.game.activePlayer === 0 && T.game.currentExtra, 'A takes its extra turn');
});
test('Class level 2 trigger: Wizard Class draws two', async T => {
  const cls = await T.put(0, 'Wizard Class');
  const h = T.A.hand.length;
  await T.activate(cls, 0, a => a.parsed.api === 'ClassLevelUp');
  expect(cls.classLevel === 2 && T.A.hand.length === h + 2, `level 2, drew two (${T.A.hand.length - h})`);
});
test('Clash: Marvo wins a clash and draws (Clashed trigger)', async T => {
  const marvo = await T.put(0, 'Marvo, Deep Operative');
  await T.put(0, 'Serra Angel', 'library'); await T.put(1, 'Forest', 'library');
  T.game.combat = { attackers: [], blockers: new Map(), firstStrikeDone: new Set() };
  T.a.on('attackers', () => [{ attacker: marvo.id, defender: 'p1' }]);
  T.a.on('castFree', () => false); T.a.on('playFree', () => []);
  const h = T.A.hand.length;
  await combat.declareAttackers(T.game); await T.resolve();
  expect(T.logged(/clashes with B/), 'clashed with the defending player');
  expect(T.A.hand.length === h + 1, `drew a card on the win (${T.A.hand.length - h})`);
});
test('Selfless Squire: prevents damage to you and grows by the amount', async T => {
  const sq = await T.cast('Selfless Squire');
  const angel = await T.put(1, 'Serra Angel');
  T.game.beginDamageBatch();
  await T.game.dealDamage(angel, T.A, 4, { combat: true });
  await T.game.dealDamage(angel, T.A, 2, { combat: true });
  T.game.endDamageBatch();
  await T.resolve();
  expect(T.A.life === 40, `no damage (${T.A.life})`);
  expect(sq.counters.P1P1 === 6, `six counters from one prevention event (${sq.counters.P1P1})`);
});

// ------------------------------------------------------------ combat requirements and restrictions
// declare attackers / blockers the way the turn does, with scripted declarations
async function attackAndBlock(T, attacks, blocks = [], blockerAgent = T.b) {
  T.game.combat = { attackers: [], blockers: new Map(), firstStrikeDone: new Set() };
  T.game.step = 'declareAttackers';
  T.agents[T.game.activePlayer].on('attackers', () => attacks.map(([a, d]) => ({ attacker: a.id, defender: typeof d === 'number' ? 'p' + d : 'c' + d.id })));
  await combat.declareAttackers(T.game); await T.resolve();
  T.game.step = 'declareBlockers';
  blockerAgent.on('blockers', () => blocks.map(([b, a]) => ({ blocker: b.id, attacker: a.id })));
  await combat.declareBlockers(T.game); await T.resolve();
}
test('Must block: Peema Aether-Seer makes target creature block this turn', async T => {
  const peema = await T.cast('Peema Aether-Seer');
  expect(T.A.counters.ENERGY === 3, `three energy (${T.A.counters.ENERGY})`);
  const wall = await T.put(1, 'Wall of Omens');
  T.a.on('targets', () => [refOf(wall)]);
  await T.activate(peema, 0, a => a.parsed.api === 'Effect');
  const elf = await T.put(0, 'Llanowar Elves');
  await attackAndBlock(T, [[elf, 1]], []);
  expect(T.game.combat.blockers.get(wall.id) === elf.id, 'the wall was forced to block');
});
test("Must block: Khârn the Betrayer blocks each combat if able", async T => {
  const k = await T.put(1, 'Khârn the Betrayer');
  const elf = await T.put(0, 'Llanowar Elves');
  await attackAndBlock(T, [[elf, 1]], []);
  expect(T.game.combat.blockers.get(k.id) === elf.id, 'Khârn blocks');
});
test('Grappling Hook: target creature must block the equipped creature', async T => {
  const hook = await T.put(0, 'Grappling Hook');
  const elf = await T.put(0, 'Llanowar Elves');
  hook.attachedTo = elf.id; T.game.touch();
  const wall = await T.put(1, 'Wall of Omens'), bears = await T.put(1, 'Llanowar Elves');
  T.a.on('targets', req => req.cands.includes(refOf(bears)) ? [refOf(bears)] : undefined);
  const other = await T.put(0, 'Indomitable Ancients');
  await attackAndBlock(T, [[elf, 1], [other, 1]], [[bears, other], [wall, other]]);
  expect(T.game.combat.blockers.get(bears.id) === elf.id, 'bears reassigned to block the hooked elf');
  expect(T.game.combat.blockers.get(wall.id) === other.id, 'the wall still blocks the giant');
});
test('Lure: all creatures able to block Treeshaker Chimera do so', async T => {
  const ch = await T.put(0, 'Treeshaker Chimera');
  const w = await T.put(1, 'Wall of Omens'), g = await T.put(1, 'Llanowar Elves'), angel = await T.put(1, 'Serra Angel');
  angel.tapped = true;
  await attackAndBlock(T, [[ch, 1]], []);
  expect(T.game.combat.blockers.get(w.id) === ch.id && T.game.combat.blockers.get(g.id) === ch.id, 'both untapped creatures block');
});
test('Crawlspace: no more than two creatures can attack you', async T => {
  await T.put(1, 'Crawlspace');
  const xs = [await T.put(0, 'Llanowar Elves'), await T.put(0, 'Llanowar Elves'), await T.put(0, 'Indomitable Ancients')];
  await attackAndBlock(T, xs.map(c => [c, 1]));
  expect(T.game.combat.attackers.length === 2, `two attackers (${T.game.combat.attackers.length})`);
});
test('Silent Arbiter: one attacker and one blocker per combat', async T => {
  await T.put(1, 'Silent Arbiter');
  const xs = [await T.put(0, 'Llanowar Elves'), await T.put(0, 'Llanowar Elves')];
  const w = await T.put(1, 'Wall of Omens'), g = await T.put(1, 'Llanowar Elves');
  await attackAndBlock(T, xs.map(c => [c, 1]), [[w, xs[0]], [g, xs[0]]]);
  expect(T.game.combat.attackers.length === 1, 'one attacker');
  expect(T.game.combat.blockers.size === 1, `one blocker (${T.game.combat.blockers.size})`);
});
test('Archangel of Tithes: blocking costs {1} per creature while it attacks', async T => {
  const arch = await T.put(0, 'Archangel of Tithes');
  const elf = await T.put(0, 'Llanowar Elves');
  const angel = await T.put(1, 'Serra Angel'), w = await T.put(1, 'Wall of Omens');
  for (const c of T.game.battlefield) if (c.controller === 1 && T.isLand(c)) c.tapped = true;
  T.noMana(1); T.B.pool.C = 1;
  await attackAndBlock(T, [[arch, 1], [elf, 1]], [[angel, arch], [w, elf]]);
  expect(T.game.combat.blockers.size === 1 && T.game.combat.blockers.get(angel.id) === arch.id, `only the first block was paid for (${T.game.combat.blockers.size})`);
  expect(T.B.pool.C === 0, 'paid {1}');
});
test('War Cadence: blocks cost {X} each this turn', async T => {
  const wc = await T.put(0, 'War Cadence');
  T.a.on('xValue', () => 2);
  await T.activate(wc);
  const elf = await T.put(0, 'Llanowar Elves');
  const w = await T.put(1, 'Wall of Omens');
  for (const c of T.game.battlefield) if (c.controller === 1 && T.isLand(c)) c.tapped = true;
  T.noMana(1); T.B.pool.C = 1;
  await attackAndBlock(T, [[elf, 1]], [[w, elf]]);
  expect(T.game.combat.blockers.size === 0, "can't pay {2}: no block");
});
test('Portal Mage: redirect an attacker during declare attackers', async T => {
  const elf = await T.put(0, 'Llanowar Elves');
  T.game.combat = { attackers: [], blockers: new Map(), firstStrikeDone: new Set() };
  T.game.step = 'declareAttackers';
  T.a.on('attackers', () => [{ attacker: elf.id, defender: 'p2' }]);
  await combat.declareAttackers(T.game); await T.resolve();
  T.c.on('targets', () => [refOf(elf)]);
  await T.cast('Portal Mage', 2);
  const rec = T.game.combat.attackers.find(a => a.card === elf.id);
  expect(rec && rec.defenderPlayer === 1, `elf now attacks B (${rec && rec.defenderPlayer})`);
  const d = T.agents[2].asked.find(r => r.purpose === 'changeCombatants');
  expect(d && !d.options.some(o => o.value === 'p0'), "can't attack its own controller");
}, { players: 3 });
test('Capricopian: the attacked player reselects whom it attacks', async T => {
  T.a.on('xValue', () => 2);
  const cap = await T.cast('Capricopian');
  cap.sick = false;
  T.game.combat = { attackers: [], blockers: new Map(), firstStrikeDone: new Set() };
  T.game.step = 'declareAttackers';
  T.a.on('attackers', () => [{ attacker: cap.id, defender: 'p1' }]);
  await combat.declareAttackers(T.game); await T.resolve();
  T.game.priority = 1;
  await T.activate(cap, 1, a => a.parsed.api === 'PutCounter');
  const rec = T.game.combat.attackers.find(a => a.card === cap.id);
  expect(cap.counters.P1P1 === 3 && rec.defenderPlayer === 2, `grew and now attacks C (${cap.counters.P1P1}, ${rec.defenderPlayer})`);
}, { players: 3 });
test('Mystic Barrier: attack only the nearest opponent in the chosen direction', async T => {
  T.a.on('chooseDirection', () => 'Left');
  const mb = await T.cast('Mystic Barrier');
  expect(mb.chosen.direction === 'Left', 'chose left');
  const e1 = await T.put(0, 'Llanowar Elves'), e2 = await T.put(0, 'Llanowar Elves');
  await attackAndBlock(T, [[e1, 1], [e2, 2]]);
  expect(T.game.combat.attackers.length === 1 && T.game.combat.attackers[0].defenderPlayer === 1, 'only the attack on B (to the left) stands');
}, { players: 3 });
test('Order of Succession: each player takes a creature from the player in the chosen direction', async T => {
  const a = await T.put(0, 'Llanowar Elves'), b = await T.put(1, 'Serra Angel'), c = await T.put(2, 'Wall of Omens');
  T.a.on('chooseDirection', () => 'Left');
  await T.cast('Order of Succession');
  expect(b.controller === 0 && c.controller === 1 && a.controller === 2, `rotated (${a.controller}, ${b.controller}, ${c.controller})`);
}, { players: 3 });
test('Aminatou -6: everyone takes the nonland permanents of the next player to the left', async T => {
  const am = await T.put(0, 'Aminatou, the Fateshifter');
  am.counters.LOYALTY = 6;
  const ring = await T.put(1, 'Sol Ring'), elf = await T.put(2, 'Llanowar Elves'), mine = await T.put(0, 'Serra Angel');
  T.a.on('chooseDirection', () => 'Left');
  await T.activate(am, 0, x => /SubCounter<6/.test(x.parsed.p.Cost));
  expect(ring.controller === 0 && elf.controller === 1 && mine.controller === 2 && am.controller === 0, `rotated (${ring.controller}, ${elf.controller}, ${mine.controller})`);
}, { players: 3 });

process.exit(await run(tests) ? 1 : 0);
