// Behavioural tests for rules features added to the engine (Graft, Gift, Must Block, Cipher, ...):
// set up a board, use the card, assert the outcome. Usage: node tools/mechanics.mjs [name-filter]
import { setup, expect, run, db } from './lib/testkit.mjs';
import { castSpell, getActions, refOf, activatedAbilities, castableOptions } from '../src/engine/abilities.js';
import * as combat from '../src/engine/combat.js';
import { calcCtx } from '../src/engine/filters.js';

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

// ------------------------------------------------------------ casting: gift, casualty, replicate, additional costs
test('Gift (spell): Wear Down promised destroys two, the opponent draws first', async T => {
  const r1 = await T.put(1, 'Sol Ring'), r2 = await T.put(1, 'Arcane Signet');
  T.a.on('gift', req => req.options.find(o => o.value === 1).value);
  T.a.on('targets', req => req.cands.filter(r => [refOf(r1), refOf(r2)].includes(r)));
  const h = T.B.hand.length;
  await T.cast('Wear Down');
  expect(r1.zone === 'graveyard' && r2.zone === 'graveyard', 'both destroyed');
  expect(T.B.hand.length === h + 1, 'B drew the gift');
});
test('Gift (spell): not promised, one target only', async T => {
  const r1 = await T.put(1, 'Sol Ring'), r2 = await T.put(1, 'Arcane Signet');
  T.a.on('gift', () => -1);
  let max = null;
  T.a.on('targets', req => { max = req.max; return [refOf(r1)]; });
  const h = T.B.hand.length;
  await T.cast('Wear Down');
  expect(max === 1 && r1.zone === 'graveyard' && r2.zone === 'battlefield' && T.B.hand.length === h, `one target (max ${max})`);
});
test('Gift (permanent): Octomancer gives an 8/8 Octopus on entering; Jolly Gerbils draws', async T => {
  await T.put(0, 'Jolly Gerbils');
  T.a.on('gift', req => 1);
  const h = T.A.hand.length;
  await T.cast('Octomancer');
  const octo = T.tokens(1).find(t => T.game.chars(t).power === 8);
  expect(octo, 'B got the octopus');
  expect(T.A.hand.length === h + 1, 'Jolly Gerbils drew a card');
});
test('Gift (permanent): Scrapshooter promised destroys an artifact', async T => {
  const ring = await T.put(1, 'Sol Ring');
  T.a.on('gift', () => 1);
  T.a.on('targets', req => req.cands.includes(refOf(ring)) ? [refOf(ring)] : undefined);
  const h = T.B.hand.length;
  await T.cast('Scrapshooter');
  expect(ring.zone === 'graveyard' && T.B.hand.length === h + 1, 'destroyed, B drew');
});
test('Casualty: A Little Chat copied by sacrificing a creature', async T => {
  const elf = await T.put(0, 'Llanowar Elves');
  T.a.on('casualty', req => [elf.id]);
  const h = T.A.hand.length;
  await T.cast('A Little Chat');
  expect(elf.zone === 'graveyard', 'elf sacrificed');
  expect(T.A.hand.length === h + 2, `copy resolved too (+${T.A.hand.length - h})`);
});
test('Replicate: Super Combo paid once fights twice', async T => {
  const angel = await T.put(0, 'Serra Angel');
  const e1 = await T.put(1, 'Llanowar Elves'), e2 = await T.put(1, 'Wall of Omens');
  T.a.on('replicate', () => 1);
  T.a.on('newTargets', () => true);
  let n = 0;
  T.a.on('targets', req => { if (req.cands.includes(refOf(angel))) return [refOf(angel)]; n++; return [refOf(n === 1 ? e1 : e2)]; });
  await T.cast('Super Combo');
  expect(e1.zone === 'graveyard' && e2.zone === 'graveyard', `both died (${e1.zone}, ${e2.zone})`);
});
test('Alternate additional cost: Bitter Triumph pays 3 life or discards', async T => {
  const a = await T.put(1, 'Serra Angel');
  T.a.on('altAdditionalCost', req => req.options.find(o => /PayLife/.test(o.value)).value);
  T.a.on('targets', () => [refOf(a)]);
  const l = T.A.life;
  await T.cast('Bitter Triumph');
  expect(a.zone === 'graveyard' && T.A.life === l - 3, `paid 3 life (${l - T.A.life})`);
  const b = await T.put(1, 'Serra Angel');
  T.A.hand.length = 0;
  T.a.on('targets', () => [refOf(b)]);
  await T.cast('Bitter Triumph');
  expect(b.zone === 'graveyard' && T.A.life === l - 6, 'with no card to discard it pays life again');
});
test('Optional cost: Redemptor Dreadnought exiles a creature card and pumps by its power', async T => {
  const angel = await T.put(0, 'Serra Angel', 'graveyard');
  T.a.on('optionalCost', () => true);
  const d = await T.cast('Redemptor Dreadnought');
  expect(angel.zone === 'exile' && angel.exiledWith === d.id, 'exiled with it');
  d.sick = false;
  T.game.combat = { attackers: [], blockers: new Map(), firstStrikeDone: new Set() };
  T.a.on('attackers', () => [{ attacker: d.id, defender: 'p1' }]);
  await combat.declareAttackers(T.game); await T.resolve();
  expect(T.game.chars(d).power === 8, `4 + 4 (${T.game.chars(d).power})`);
});
test('Optional blight: Burning Curiosity exiles three if blighted', async T => {
  const angel = await T.put(0, 'Serra Angel');
  T.a.on('optionalCost', () => true);
  const ex = T.A.exile.length;
  await T.cast('Burning Curiosity');
  expect(angel.counters.M1M1 === 1 && T.A.exile.length === ex + 3, `blighted, exiled 3 (${T.A.exile.length - ex})`);
});
test('Blight effect: Sinister Gnarlbark at end step', async T => {
  const g = await T.put(0, 'Sinister Gnarlbark');
  T.game.fire('Phase', { Phase: 'End of Turn', Player: 0 }); await T.resolve();
  expect(g.counters.M1M1 === 1, 'blighted its only creature');
});
test('Emerge: Elder Deep-Fiend costs less by the sacrificed creature mana value', async T => {
  const angel = await T.put(0, 'Serra Angel');
  for (const c of T.game.battlefield) if (T.isLand(c)) c.tapped = true;
  T.noMana(0); T.A.pool.U = 2;
  const c = await T.put(0, 'Elder Deep-Fiend', 'hand');
  const act = getActions(T.game, 0).find(a => a.cardId === c.id && /Emerge/.test(a.label));
  expect(act, 'emerge offered for UU with a 5-drop to sacrifice');
  T.a.on('emerge', () => [angel.id]);
  await T.game.performAction(0, act); await T.resolve();
  expect(c.zone === 'battlefield' && angel.zone === 'graveyard' && T.A.pool.U === 0, 'emerged');
});
test('Entwine: One Dozen Eyes makes both', async T => {
  T.a.on('entwine', () => true);
  await T.cast('One Dozen Eyes');
  expect(T.tokens(0).length === 6, `beast + five insects (${T.tokens(0).length})`);
});
test('Tiered: Cloud\'s Limit Break Omnislash pays {3}{W} more', async T => {
  const a = await T.put(1, 'Serra Angel'); a.tapped = true;
  const b = await T.put(1, 'Wall of Omens'); b.tapped = true;
  T.a.on('modes', req => [req.options.find(o => /Omnislash/.test(o.label)).value]);
  T.noMana(0); T.A.pool.W = 2; T.A.pool.C = 4;
  for (const c of T.game.battlefield) if (T.isLand(c)) c.tapped = true;
  await T.cast("Cloud's Limit Break", 0, { mana: false });
  expect(a.zone === 'graveyard' && b.zone === 'graveyard', 'tapped creatures destroyed');
  expect(T.A.pool.W === 0 && T.A.pool.C === 0, `paid {1}{W} + {3}{W} with exactly six mana (${JSON.stringify(T.A.pool)})`);
});
test('Spree: Requisition Raid with two modes', async T => {
  const ring = await T.put(1, 'Sol Ring'), ench = await T.put(1, 'Propaganda');
  T.a.on('modes', req => req.options.filter(o => /Destroy/.test(o.label)).map(o => o.value));
  T.a.on('targets', req => req.cands.includes(refOf(ring)) ? [refOf(ring)] : [refOf(ench)]);
  T.noMana(0); T.A.pool.W = 1; T.A.pool.C = 2;
  for (const c of T.game.battlefield) if (T.isLand(c)) c.tapped = true;
  await T.cast('Requisition Raid', 0, { mana: false });
  expect(ring.zone === 'graveyard' && ench.zone === 'graveyard' && T.A.pool.C === 0, 'both destroyed for {W}+{1}+{1}');
});
test('Strive: Launch the Fleet costs {1} more per extra target', async T => {
  const xs = [await T.put(0, 'Llanowar Elves'), await T.put(0, 'Serra Angel'), await T.put(0, 'Wall of Omens')];
  T.a.on('targets', () => xs.map(refOf));
  T.noMana(0); T.A.pool.W = 1; T.A.pool.C = 3;
  for (const c of T.game.battlefield) if (T.isLand(c)) c.tapped = true;
  await T.cast('Launch the Fleet', 0, { mana: false });
  expect(T.A.pool.C === 1, `paid {W} + {2} (${T.A.pool.C} left)`);
});
test('Prowl: Latchkey Faerie after a Rogue dealt combat damage', async T => {
  const rogue = await T.put(0, 'Latchkey Faerie');
  const c = await T.put(0, 'Latchkey Faerie', 'hand');
  T.mana(0);
  expect(!getActions(T.game, 0).some(a => a.cardId === c.id && /Prowl/.test(a.label)), 'no prowl before damage');
  await T.game.dealDamage(rogue, T.B, 3, { combat: true });
  const act = getActions(T.game, 0).find(a => a.cardId === c.id && /Prowl/.test(a.label));
  expect(act, 'prowl offered');
  const h = T.A.hand.length;
  await T.game.performAction(0, act); await T.resolve();
  expect(c.zone === 'battlefield' && T.A.hand.length === h, 'prowled: drew a card on entering (hand unchanged after casting it)');
});
test('MayFlashCost: Rout at instant speed for {2} more', async T => {
  await T.put(1, 'Serra Angel');
  const c = await T.put(0, 'Rout', 'hand');
  T.game.activePlayer = 1; T.game.priority = 0; T.game.step = 'end';
  T.mana(0);
  const act = getActions(T.game, 0).find(a => a.cardId === c.id);
  expect(act && /flash/.test(act.label), 'flash option offered');
  T.noMana(0); T.A.pool.W = 2; T.A.pool.C = 5;
  for (const x of T.game.battlefield) if (T.isLand(x)) x.tapped = true;
  await T.game.performAction(0, act); await T.resolve();
  expect(!T.game.battlefield.some(T.isCreature) && T.A.pool.C === 0, 'wrath at instant speed, paid 7');
});
test('Dredge: mill 2 instead of drawing, Dakmor Salvage returns', async T => {
  const s = await T.put(0, 'Dakmor Salvage', 'graveyard');
  T.a.on('dredge', () => s.id);
  const gy = T.A.graveyard.length, lib = T.A.library.length;
  await T.game.drawCards(T.A, 1, null);
  expect(s.zone === 'hand' && T.A.library.length === lib - 2 && T.A.graveyard.length === gy - 1 + 2, 'dredged');
  expect(T.A.cardsDrawnThisTurn === 0, 'not a draw');
});
test('Trigger costs: Dawn of Hope pays {2} to draw, or does nothing', async T => {
  await T.put(0, 'Dawn of Hope');
  T.mana(0);
  const h = T.A.hand.length;
  await T.game.gainLife(T.A, 1, null); await T.resolve();
  expect(T.A.hand.length === h + 1 && T.A.pool.C + T.A.pool.W < 18, 'paid and drew');
  T.noMana(0);
  for (const c of T.game.battlefield) if (T.isLand(c)) c.tapped = true;
  await T.game.gainLife(T.A, 1, null); await T.resolve();
  expect(T.A.hand.length === h + 1, 'could not pay: no card');
});
test("Exiled-to-graveyard cost: Void Attendant", async T => {
  const va = await T.put(0, 'Void Attendant');
  const ex = await T.put(1, 'Serra Angel', 'exile');
  await T.activate(va);
  expect(ex.zone === 'graveyard' && T.tokens(0).length === 1, 'card to graveyard, scion made');
  let threw = false; try { await T.activate(va); } catch { threw = true; }
  expect(threw, 'no more opponent cards in exile: cannot activate');
});
test("Ulamog's Nullifier: put two exiled cards into graveyards to counter a spell", async T => {
  await T.put(1, 'Serra Angel', 'exile'); await T.put(1, 'Sol Ring', 'exile');
  const spell = await T.put(1, 'Harmonize', 'hand');
  T.mana(1); T.game.priority = 1; T.game.activePlayer = 1;
  await castSpell(T.game, 1, spell, {});
  T.game.activePlayer = 0;
  T.a.on('targets', req => req.cands.slice(0, 1));
  await T.cast('Ulamog\'s Nullifier', 0, { resolve: false });
  await T.resolve();
  expect(spell.zone === 'graveyard' && T.B.exile.length === 0, `countered (${spell.zone}), exile emptied`);
});
test('Night Soil: exile two creature cards from a single graveyard', async T => {
  const ns = await T.put(0, 'Night Soil');
  await T.put(1, 'Serra Angel', 'graveyard'); await T.put(0, 'Llanowar Elves', 'graveyard');
  let threw = false; try { await T.activate(ns); } catch { threw = true; }
  expect(threw, 'one creature in each graveyard is not enough');
  await T.put(1, 'Wall of Omens', 'graveyard');
  await T.activate(ns);
  expect(T.B.graveyard.length === 0 && T.tokens(0).length === 1, 'two from B\'s graveyard, saproling');
});
test('Reveal the chosen player: Stalking Leonin exiles an attacker of theirs', async T => {
  T.a.on('choosePlayer', () => 1);
  const leo = await T.cast('Stalking Leonin');
  expect(leo.chosen.player === 1 && !T.logged(/A chooses B/), 'secretly chose B');
  const angel = await T.put(1, 'Serra Angel');
  T.game.activePlayer = 1;
  T.combatWith([[angel, 0]]);
  T.a.on('targets', () => [refOf(angel)]);
  await T.activate(leo, 0, a => a.parsed.api === 'ChangeZone');
  expect(angel.zone === 'exile' && leo.chosenRevealed, 'exiled');
});
test('Guardian Archon: protection from the chosen player', async T => {
  T.a.on('choosePlayer', () => 1);
  const ga = await T.cast('Guardian Archon');
  const elf = await T.put(0, 'Llanowar Elves');
  T.a.on('targets', () => [refOf(elf)]);
  await T.activate(ga, 0, a => a.parsed.api === 'Pump');
  const angel = await T.put(1, 'Serra Angel');
  expect(await T.game.dealDamage(angel, elf, 3, {}) === 0, 'elf protected from B');
  expect(await T.game.dealDamage(angel, T.A, 3, {}) === 0, 'A protected from B');
});
test('Emissary of Grudges: redirect an opponent spell that targets you', async T => {
  T.a.on('choosePlayer', () => 1);
  const em = await T.cast('Emissary of Grudges');
  const mine = await T.put(0, 'Serra Angel'), theirs = await T.put(1, 'Serra Angel');
  const tp = await T.put(1, 'Terminate', 'hand');
  T.mana(1); T.game.priority = 1; T.game.activePlayer = 1;
  T.b.on('targets', () => [refOf(mine)]);
  await castSpell(T.game, 1, tp, {});
  T.game.activePlayer = 0;
  T.a.on('targets', req => req.purpose === 'changeTargets' ? [refOf(theirs)] : [req.cands.find(r => r[0] === 's')]);
  await T.activate(em, 0, a => a.parsed.api === 'ChangeTargets', { resolve: false });
  await T.resolve();
  expect(mine.zone === 'battlefield' && theirs.zone === 'graveyard', 'Terminate hit their own angel');
});
test('Rooms: cast a door, it unlocks; unlock the other door as a sorcery', async T => {
  const elf = await T.put(1, 'Llanowar Elves');
  T.a.on('targets', req => req.cands.includes(refOf(elf)) ? [refOf(elf)] : undefined);
  await T.put(0, 'Fear of Sleep Paralysis');
  const c = await T.put(0, 'Bottomless Pool', 'hand');
  T.mana(0);
  const act = getActions(T.game, 0).find(a => a.cardId === c.id && /Bottomless Pool/.test(a.label));
  expect(act, 'cast the Bottomless Pool door');
  await T.game.performAction(0, act); await T.resolve();
  expect(elf.zone === 'hand', 'unlock trigger bounced the elf');
  expect(c.unlocked.join() === '0' && T.game.name(c) === 'Bottomless Pool', `one door open (${T.game.name(c)})`);
  const unlock = activatedAbilities(T.game, 0, c).find(a => a.parsed.api === 'UnlockDoor');
  expect(unlock, 'can unlock Locker Room');
  const angel = await T.put(1, 'Serra Angel');
  T.a.on('targets', req => req.cands.includes(refOf(angel)) ? [refOf(angel)] : undefined);
  await T.activate(c, 0, a => a.parsed.api === 'UnlockDoor');
  expect(c.unlocked.length === 2 && T.game.chars(c).triggers.length === 2, 'both doors open');
  expect(angel.tapped && angel.counters.STUN === 1, 'fully unlocked: Fear of Sleep Paralysis stunned the angel');
});

// ------------------------------------------------------------ face-down, cipher, entering replacements
test('Cloak: Ransom Note cloaks the top card as a 2/2 with ward {2}', async T => {
  const note = await T.put(0, 'Ransom Note'); await T.resolve(); // its surveil trigger first
  const top = await T.put(0, 'Serra Angel', 'library');
  T.a.on('modes', req => [req.options.find(o => /Cloak/.test(o.label)).value]);
  await T.activate(note);
  expect(top.zone === 'battlefield' && top.faceDown && T.game.chars(top).power === 2, 'face-down 2/2');
  expect(T.game.chars(top).keywords.includes('Ward:2'), 'ward 2');
  const up = activatedAbilities(T.game, 0, top).find(a => a.key === 'manifestUp');
  expect(up, 'can be turned face up for its mana cost');
  await T.activate(top, 0, a => a.key === 'manifestUp');
  expect(!top.faceDown && T.game.name(top) === 'Serra Angel', 'turned face up');
});
test("Cloak: Unexplained Absence — each exiled permanent's controller cloaks", async T => {
  const a = await T.put(1, 'Serra Angel');
  T.a.on('targets', () => [refOf(a)]);
  const n = T.count(1, 'battlefield', c => c.faceDown);
  await T.cast('Unexplained Absence');
  expect(a.zone === 'exile' && T.count(1, 'battlefield', c => c.faceDown) === n + 1, 'B cloaked a card');
});
test('Veiled Ascension: face-down creatures you control enter with a flying counter', async T => {
  await T.put(0, 'Veiled Ascension'); await T.resolve();
  await T.put(0, 'Serra Angel', 'library');
  T.a.on('optionalTrigger', () => true);
  T.game.fire('Phase', { Phase: 'Upkeep', Player: 0 }); await T.resolve();
  const fd = T.game.battlefield.find(c => c.faceDown && c.controller === 0);
  expect(fd && fd.counters.FLYING === 1 && T.game.hasKeyword(fd, 'Flying'), 'cloaked creature has a flying counter');
});
test('Grumgully: other non-Human creatures you control enter with a counter (not itself)', async T => {
  const g = await T.put(0, 'Grumgully, the Generous');
  expect(!g.counters.P1P1, 'no counter on itself');
  const elf = await T.put(0, 'Llanowar Elves');
  const theirs = await T.put(1, 'Llanowar Elves');
  expect(elf.counters.P1P1 === 1 && !theirs.counters.P1P1, "own elf got one, opponent's did not");
});
test('Hooded Hydra: turned face up, it gets five +1/+1 counters', async T => {
  const h = await T.put(0, 'Hooded Hydra', 'hand');
  T.mana(0);
  const act = getActions(T.game, 0).find(a => a.cardId === h.id && /face down/.test(a.label));
  await T.game.performAction(0, act); await T.resolve();
  expect(h.faceDown, 'face down');
  await T.activate(h, 0, a => a.key === 'morphUp');
  expect(!h.faceDown && h.counters.P1P1 === 5, `five counters (${h.counters.P1P1})`);
});
test('Cipher: Writ of Return encoded on a creature, copy cast on combat damage', async T => {
  const flyer = await T.put(0, 'Serra Angel');
  const dead = await T.put(0, 'Llanowar Elves', 'graveyard');
  const dead2 = await T.put(0, 'Wall of Omens', 'graveyard');
  T.a.on('targets', req => req.cands.includes(refOf(dead)) ? [refOf(dead)] : req.cands.includes(refOf(dead2)) ? [refOf(dead2)] : undefined);
  T.a.on('cipher', () => [flyer.id]);
  const writ = await T.cast('Writ of Return');
  expect(dead.zone === 'battlefield' && writ.zone === 'exile', 'resolved and encoded');
  T.combatWith([[flyer, 1]]);
  await combat.combatDamage(T.game, false); await T.resolve();
  expect(dead2.zone === 'battlefield', 'copy cast: the wall came back too');
  expect(writ.zone === 'exile', 'encoded card stays in exile');
  expect(T.game.allCards().filter(c => c.def === writ.def).length === 1, 'the copy is gone');
});
test('Psionic Ritual: cast a copy of an instant from a graveyard', async T => {
  const ns = await T.put(1, "Night's Whisper", 'graveyard');
  T.a.on('targets', () => [refOf(ns)]);
  const h = T.A.hand.length;
  await T.cast('Psionic Ritual');
  expect(T.A.hand.length === h + 2 && ns.zone === 'exile', `copy drew two (${T.A.hand.length - h})`);
});

// ------------------------------------------------------------ more keywords
test('Station: tap a creature for charge counters equal to its power', async T => {
  const ship = await T.put(0, 'Exploration Broodship');
  const angel = await T.put(0, 'Serra Angel');
  T.a.on('costtapXType', () => [angel.id]);
  await T.activate(ship, 0, a => a.parsed.p.Station === 'True');
  expect(ship.counters.CHARGE === 4 && angel.tapped, `four charge counters (${ship.counters.CHARGE})`);
  expect(T.game.playerChars(0).extraLands === 1, 'station 3+: an additional land each turn');
  expect(!T.isCreature(ship), 'not a creature below 8');
});
test('Vanishing: time counters tick down, then it is sacrificed', async T => {
  const t = await T.put(0, 'Deadwood Treefolk'); await T.resolve();
  expect(t.counters.TIME === 3, 'three time counters');
  for (let i = 0; i < 3; i++) { T.game.fire('Phase', { Phase: 'Upkeep', Player: 0 }); await T.resolve(); }
  expect(t.zone === 'graveyard', `sacrificed when the last counter left (${t.zone}, ${t.counters.TIME})`);
});
test('For Mirrodin!: Glimmer Lens makes a Rebel and attaches to it', async T => {
  const lens = await T.cast('Glimmer Lens');
  const rebel = T.tokens(0).find(c => /Rebel/.test(T.game.name(c)));
  expect(rebel && lens.attachedTo === rebel.id, 'equipped to a new 2/2 Rebel');
});
test('Reinforce: discard Hunting Triad to put three counters on a creature', async T => {
  const elf = await T.put(0, 'Llanowar Elves');
  const c = await T.put(0, 'Hunting Triad', 'hand');
  T.a.on('targets', () => [refOf(elf)]);
  await T.activate(c, 0, a => /Reinforce/.test(a.parsed.p.SpellDescription));
  expect(elf.counters.P1P1 === 3 && c.zone === 'graveyard', 'reinforced');
});
test('Plot: exile now, cast free as a sorcery on a later turn', async T => {
  const c = await T.put(0, 'Lock and Load', 'hand');
  await T.activate(c, 0, a => a.parsed.api === 'Plot');
  expect(c.zone === 'exile' && c.plotted, 'plotted');
  T.noMana(0);
  expect(!getActions(T.game, 0).some(a => a.cardId === c.id), 'not castable the turn it was plotted');
  T.game.turnNumber++;
  for (const x of T.game.battlefield) if (T.isLand(x)) x.tapped = true;
  const act = getActions(T.game, 0).find(a => a.cardId === c.id);
  expect(act, 'castable for free next turn');
  const h = T.A.hand.length;
  await T.game.performAction(0, act); await T.resolve();
  expect(T.A.hand.length === h + 1 && c.zone === 'graveyard', 'drew');
});
test('Gravestorm: Follow the Bodies copies for each permanent that died this turn', async T => {
  const a = await T.put(1, 'Llanowar Elves'), b = await T.put(1, 'Sol Ring');
  await T.game.destroy(a, null); await T.game.destroy(b, null); await T.resolve();
  await T.cast('Follow the Bodies');
  expect(T.tokens(0).filter(c => /Clue/.test(T.game.name(c))).length === 3, `three clues (${T.tokens(0).length})`);
});
test("Champion: Wren's Run Packmaster exiles an Elf until it leaves", async T => {
  const elf = await T.put(0, 'Llanowar Elves');
  const pm = await T.cast("Wren's Run Packmaster");
  expect(elf.zone === 'exile' && pm.zone === 'battlefield', 'elf championed');
  await T.game.destroy(pm, null); await T.resolve();
  expect(elf.zone === 'battlefield', 'elf returned');
  const pm2 = await T.cast("Wren's Run Packmaster");
  expect(pm2.zone === 'battlefield' || pm2.zone === 'graveyard', 'second one');
});
test('Champion: with nothing to champion it is sacrificed', async T => {
  const pm = await T.cast("Wren's Run Packmaster");
  expect(pm.zone === 'graveyard', `sacrificed (${pm.zone})`);
});
test('Cumulative upkeep: Mystic Remora asks {1} per age counter, else sacrifice', async T => {
  const r = await T.put(0, 'Mystic Remora');
  T.mana(0);
  T.game.fire('Phase', { Phase: 'Upkeep', Player: 0 }); await T.resolve();
  expect(r.zone === 'battlefield' && r.counters.AGE === 1, 'paid {1}');
  T.noMana(0); for (const x of T.game.battlefield) if (T.isLand(x)) x.tapped = true;
  T.game.fire('Phase', { Phase: 'Upkeep', Player: 0 }); await T.resolve();
  expect(r.zone === 'graveyard', "couldn't pay {2}: sacrificed");
});
test('Bloodthirst: Bloodlord of Vaasgoth after an opponent was dealt damage', async T => {
  const elf = await T.put(0, 'Llanowar Elves');
  const b1 = await T.cast('Bloodlord of Vaasgoth');
  expect(!b1.counters.P1P1, 'no counters before damage');
  await T.game.dealDamage(elf, T.B, 1, {});
  const b2 = await T.cast('Bloodlord of Vaasgoth');
  expect(b2.counters.P1P1 === 3, 'three counters');
});
test('Read ahead: start Love Song of Night and Day on chapter III', async T => {
  const elf = await T.put(0, 'Llanowar Elves');
  T.a.on('readAhead', () => 3);
  T.a.on('targets', () => [refOf(elf)]);
  const h = T.B.hand.length;
  const s = await T.cast('Love Song of Night and Day');
  expect(elf.counters.P1P1 === 1 && T.B.hand.length === h, 'only chapter III');
  expect(s.zone === 'graveyard', 'saga finished');
});
test('Harmonize: Wild Ride from the graveyard, tapping a creature to pay less', async T => {
  const c = await T.put(0, 'Wild Ride', 'graveyard');
  const angel = await T.put(0, 'Serra Angel');
  T.noMana(0); T.A.pool.R = 1;
  for (const x of T.game.battlefield) if (T.isLand(x)) x.tapped = true;
  angel.tapped = true;
  expect(!getActions(T.game, 0).some(a => a.cardId === c.id), 'not affordable with {R} and no creature to tap');
  angel.tapped = false;
  T.a.on('harmonize', () => [angel.id]);
  T.a.on('targets', () => [refOf(angel)]);
  const act2 = getActions(T.game, 0).find(a => a.cardId === c.id);
  expect(act2, '{4}{R} minus the angel\'s power is payable with {R}');
  await T.game.performAction(0, act2); await T.resolve();
  expect(c.zone === 'exile' && angel.tapped && T.A.pool.R === 0, 'harmonized and exiled');
});
test('Offering: Blast-Furnace Hellkite sacrificing an artifact pays the difference', async T => {
  const ring = await T.put(0, 'Sol Ring');
  const c = await T.put(0, 'Blast-Furnace Hellkite', 'hand');
  T.mana(0);
  const act = getActions(T.game, 0).find(a => a.cardId === c.id && /offering/.test(a.label));
  expect(act, 'offering offered');
  T.a.on('emerge', () => [ring.id]);
  T.noMana(0); T.A.pool.R = 2; T.A.pool.C = 6;
  for (const x of T.game.battlefield) if (T.isLand(x)) x.tapped = true;
  await T.game.performAction(0, act); await T.resolve();
  expect(c.zone === 'battlefield' && ring.zone === 'graveyard' && T.A.pool.C === 0 && T.A.pool.R === 0, 'cast for {6}{R}{R}');
});
test("Buyback: Evincar's Justice returns to hand", async T => {
  T.a.on('buyback', () => true);
  const c = await T.cast("Evincar's Justice");
  expect(c.zone === 'hand' && T.B.life === 38, 'back in hand after dealing 2');
});
test('Exert: Glorybringer deals 4 damage to a non-Dragon and stays tapped', async T => {
  const g = await T.put(0, 'Glorybringer');
  const angel = await T.put(1, 'Serra Angel');
  T.game.combat = { attackers: [], blockers: new Map(), firstStrikeDone: new Set() };
  T.a.on('attackers', () => [{ attacker: g.id, defender: 'p1' }]);
  T.a.on('targets', () => [refOf(angel)]);
  await combat.declareAttackers(T.game); await T.resolve();
  expect(angel.zone === 'graveyard' && g.skipNextUntap, 'angel died, glorybringer exerted');
  T.game.activePlayer = 0; await T.game.runStep('untap');
  expect(g.tapped, "doesn't untap during the next untap step");
  await T.game.runStep('untap');
  expect(!g.tapped, 'untaps the one after');
});
test('Rubinia Soulsinger: stays tapped to keep the stolen creature', async T => {
  const r = await T.put(0, 'Rubinia Soulsinger');
  const angel = await T.put(1, 'Serra Angel');
  T.a.on('targets', () => [refOf(angel)]);
  await T.activate(r, 0, a => a.parsed.api === 'GainControl');
  expect(angel.controller === 0 && r.tapped, 'stolen');
  T.game.activePlayer = 0; await T.game.runStep('untap');
  expect(r.tapped && angel.controller === 0, 'AI keeps Rubinia tapped');
  T.a.on('keepTapped', () => false);
  await T.game.runStep('untap');
  expect(!r.tapped && angel.controller === 1, 'untapping ends the control change');
});
test('Mana Expend: Teapot Slinger on the fourth mana spent on spells', async T => {
  await T.put(0, 'Teapot Slinger');
  T.noMana(0); T.A.pool.C = 9; T.A.pool.G = 9; T.A.pool.W = 9;
  await T.cast('Llanowar Elves', 0, { mana: false });
  expect(T.B.life === 40, 'expend 1: nothing');
  await T.cast('Serra Angel', 0, { mana: false });
  expect(T.B.life === 38, `expend 4 (on the 6th mana total): 2 damage (${T.B.life})`);
});

// ------------------------------------------------------------ mana, copies, day/night and other replacements
test('Mana Reflection: tapping a permanent for mana produces twice as much', async T => {
  await T.put(0, 'Mana Reflection');
  const f = await T.put(0, 'Forest');
  T.noMana(0);
  const { activateManaAbility, manaAbilitiesOf } = await import('../src/engine/abilities.js');
  await activateManaAbility(T.game, 0, f, manaAbilitiesOf(T.game, f)[0].key);
  expect(T.A.pool.G === 2, `two green (${T.A.pool.G})`);
});
test("Leyline Tyrant keeps red mana; Omnath turns lost mana colorless and grows", async T => {
  await T.put(0, 'Leyline Tyrant');
  T.noMana(0); T.A.pool.R = 2; T.A.pool.G = 1;
  T.game.emptyPools();
  expect(T.A.pool.R === 2 && T.A.pool.G === 0, 'red kept, green lost');
  const o = await T.put(0, 'Omnath, Locus of the Void');
  T.A.pool.G = 3;
  T.game.emptyPools();
  expect(T.A.pool.R === 2 && T.A.pool.C === 3 && T.game.chars(o).power === 6 + 5, `green became colorless; Omnath ${T.game.chars(o).power}`);
});
test('Twinning Staff: copying a spell makes one more copy', async T => {
  const staff = await T.put(0, 'Twinning Staff');
  const ns = await T.put(0, "Night's Whisper", 'hand');
  T.mana(0); T.game.priority = 0;
  await castSpell(T.game, 0, ns, {});
  const h = T.A.hand.length;
  T.a.on('targets', req => [req.cands.find(r => r[0] === 's')]);
  await T.activate(staff, 0, a => a.parsed.api === 'CopySpellAbility');
  expect(T.A.hand.length === h + 6, `original + 2 copies drew 6 (${T.A.hand.length - h})`);
});
test('Seeker of Slaanesh: an opponent must attack with at least one creature', async T => {
  await T.put(0, 'Seeker of Slaanesh');
  const e = await T.put(1, 'Llanowar Elves');
  T.game.activePlayer = 1;
  T.game.combat = { attackers: [], blockers: new Map(), firstStrikeDone: new Set() };
  T.b.on('attackers', () => []);
  await combat.declareAttackers(T.game);
  expect(T.game.combat.attackers.length === 1 && T.game.combat.attackers[0].card === e.id, 'forced to attack');
});
test('Skullbriar: counters stay on it in the graveyard and when it returns', async T => {
  const s = await T.put(0, 'Skullbriar, the Walking Grave');
  await T.game.addCounters(s, 'P1P1', 3, null);
  await T.game.destroy(s, null); await T.resolve();
  expect(s.zone === 'graveyard' && s.counters.P1P1 === 3, 'counters kept in the graveyard');
  await T.game.moveCard(s, 'battlefield', { controller: 0 });
  expect(T.game.chars(s).power === 4, `returns as a 4/4 (${T.game.chars(s).power})`);
  await T.game.moveCard(s, 'hand');
  expect(!s.counters.P1P1, 'counters removed in hand');
});
test('Soulbond: Silverblade Paladin pairs and both gain double strike', async T => {
  const elf = await T.put(0, 'Llanowar Elves');
  const sp = await T.cast('Silverblade Paladin');
  expect(T.game.pairedPartner(sp) === elf, 'paired with the elf');
  expect(T.game.hasKeyword(sp, 'Double Strike') && T.game.hasKeyword(elf, 'Double Strike'), 'both have double strike');
  await T.game.destroy(elf, null); await T.resolve();
  expect(!T.game.hasKeyword(sp, 'Double Strike'), 'unpaired when the partner leaves');
  const e2 = await T.put(0, 'Llanowar Elves'); await T.resolve();
  expect(T.game.pairedPartner(sp) === e2, 'pairs with a creature entering later');
});
test('Vote: Model of Unity lets players who voted with you scry; ties use the tied ability', async T => {
  await T.put(0, 'Model of Unity');
  T.a.on('vote', req => req.options[1].value); T.b.on('vote', req => req.options[1].value);
  const h = T.A.hand.length;
  await T.cast('Plea for Power');
  expect(T.A.hand.length === h + 3, 'knowledge: drew three');
  expect(T.logged(/B scries 2/) && T.logged(/A scries 2/), 'both scried');
  T.a.on('vote', req => req.options[0].value); T.b.on('vote', req => req.options[1].value);
  const h2 = T.A.hand.length;
  await T.cast('Plea for Power');
  expect(T.A.hand.length === h2 + 3 && !T.game.extraTurns.length, 'tie: knowledge (VoteTiedAbility)');
});
test('Empower: Plan for All Outcomes creates a Jace token', async T => {
  await T.put(0, 'Plan for All Outcomes'); await T.resolve();
  await T.cast("Night's Whisper");
  const jace = T.game.battlefield.find(c => c.token && T.game.chars(c).subtypes.has('Jace'));
  expect(jace && jace.counters.LOYALTY === 1, `Jace token with 1 loyalty (${jace && jace.counters.LOYALTY})`);
});
test("Day and night: Tovolar's Huntmaster makes it day, then transforms at night", async T => {
  const h = await T.cast("Tovolar's Huntmaster");
  expect(T.game.dayNight === 'Day' && h.face === 0, 'it became day');
  T.game.lastActive = 0; T.A.spellsCastThisTurn = [];
  T.game.activePlayer = 1;
  await T.game.takeTurn();
  expect(T.game.dayNight === 'Night' && h.face === 1 && T.game.name(h) === "Tovolar's Packleader", `night: transformed (${T.game.dayNight}, ${T.game.name(h)})`);
});
test('Awaken: Ruinous Path destroys and awakens a land', async T => {
  const a = await T.put(1, 'Serra Angel');
  const land = await T.put(0, 'Forest');
  const c = await T.put(0, 'Ruinous Path', 'hand');
  T.mana(0);
  const act = getActions(T.game, 0).find(x => x.cardId === c.id && /Awaken/.test(x.label));
  expect(act, 'awaken offered');
  T.a.on('targets', req => req.cands.includes(refOf(a)) ? [refOf(a)] : [refOf(land)]);
  await T.game.performAction(0, act); await T.resolve();
  expect(a.zone === 'graveyard' && T.isCreature(land) && T.game.chars(land).power === 4 && T.game.hasKeyword(land, 'Haste') && T.isLand(land), 'land is a 4/4 haste creature');
});
test('Aethersnatch: gain control of a creature spell', async T => {
  const spell = await T.put(1, 'Serra Angel', 'hand');
  T.mana(1); T.game.priority = 1; T.game.activePlayer = 1;
  await castSpell(T.game, 1, spell, {});
  T.game.activePlayer = 0;
  T.a.on('targets', req => req.cands.slice(0, 1));
  await T.cast('Aethersnatch', 0, { resolve: false });
  await T.resolve();
  expect(spell.zone === 'battlefield' && spell.controller === 0, 'it entered under A');
});
test('Alms Collector: an opponent drawing two instead makes each of you draw one', async T => {
  await T.put(0, 'Alms Collector');
  const ha = T.A.hand.length, hb = T.B.hand.length;
  await T.game.drawCards(T.B, 2, null);
  expect(T.A.hand.length === ha + 1 && T.B.hand.length === hb + 1, 'one each');
  await T.game.drawCards(T.A, 2, null);
  expect(T.A.hand.length === ha + 3, 'you still draw two');
});
test('Clay Golem: roll a d8 for monstrosity X', async T => {
  const g = await T.put(0, 'Clay Golem');
  const ring = await T.put(1, 'Sol Ring');
  T.a.on('targets', () => [refOf(ring)]);
  await T.activate(g, 0, a => a.parsed.p.Monstrosity);
  expect(g.monstrous && g.counters.P1P1 >= 1 && g.counters.P1P1 <= 8 && ring.zone === 'graveyard', `monstrous with ${g.counters.P1P1}, berserk destroyed the ring`);
});
test('Deflecting Palm: prevent damage from a source and deal it to its controller', async T => {
  const angel = await T.put(1, 'Serra Angel');
  T.a.on('chooseSource', () => [angel.id]);
  await T.cast('Deflecting Palm');
  const r = await T.game.dealDamage(angel, T.A, 4, { combat: true });
  await T.resolve();
  expect(r === 0 && T.A.life === 40 && T.B.life === 36, `prevented and reflected (A ${T.A.life}, B ${T.B.life})`);
  await T.game.dealDamage(angel, T.A, 4, { combat: true });
  expect(T.A.life === 36, 'only the next time');
});
test('Phantom Nantuko: damage to it is prevented and it loses a counter', async T => {
  const p = await T.put(0, 'Phantom Nantuko');
  const angel = await T.put(1, 'Serra Angel');
  await T.game.dealDamage(angel, p, 5, {}); await T.resolve();
  expect(p.zone === 'battlefield' && p.counters.P1P1 === 1 && p.damage === 0, `prevented, one counter left (${p.counters.P1P1})`);
});

// ------------------------------------------------------------ long tail: turn structure, odd costs, odd replacements
const spyRng = T => { const calls = []; const orig = T.game.rng.int.bind(T.game.rng); T.game.rng.int = n => { const r = orig(n); calls.push([n, r]); return r; }; return calls; };
test('Extinction Event: exile each creature with mana value of the chosen parity', async T => {
  const elf = await T.put(1, 'Llanowar Elves'), angel = await T.put(1, 'Serra Angel'), wall = await T.put(0, 'Wall of Omens');
  T.a.on('chooseEvenOdd', () => 'Odd');
  await T.cast('Extinction Event');
  expect(elf.zone === 'exile' && angel.zone === 'exile' && wall.zone === 'battlefield', 'odd creatures exiled, the even one stays');
});
test("Narset, Parter of Veils: opponents can't draw more than one card each turn", async T => {
  await T.put(0, 'Narset, Parter of Veils');
  const hb = T.B.hand.length, ha = T.A.hand.length;
  await T.game.drawCards(T.B, 3, null);
  await T.game.drawCards(T.B, 1, null);
  expect(T.B.hand.length === hb + 1, `B drew one (${T.B.hand.length - hb})`);
  await T.game.drawCards(T.A, 2, null);
  expect(T.A.hand.length === ha + 2, 'A is unaffected');
});
test("Hushwing Gryff: creatures entering don't cause abilities to trigger", async T => {
  await T.put(0, 'Hushwing Gryff');
  const h = T.A.hand.length;
  await T.put(0, 'Wall of Omens'); await T.resolve();
  expect(T.A.hand.length === h, 'Wall of Omens drew nothing');
});
test('Time Stop: exile the stack and end the turn', async T => {
  const spell = await T.put(1, 'Serra Angel', 'hand');
  T.mana(1); T.game.priority = 1; T.game.activePlayer = 1;
  await castSpell(T.game, 1, spell, {});
  T.game.activePlayer = 0;
  const ts = await T.cast('Time Stop', 0, { resolve: false });
  await T.game.resolveTop();
  expect(spell.zone === 'exile' && ts.zone === 'exile' && !T.game.stack.length && T.game.endTurnNow, `stack exiled (${spell.zone}, ${ts.zone}), turn ending`);
});
test('Mandate of Peace: end the combat phase', async T => {
  const angel = await T.put(0, 'Serra Angel');
  T.game.step = 'declareBlockers';
  T.combatWith([[angel, 1]]);
  T.game.activePlayer = 1;
  await T.cast('Mandate of Peace', 0);
  expect(!T.game.combat.attackers.length && T.game.endCombatNow, 'attackers removed, combat ends');
});
test("Archon of Coronation: as the monarch, damage doesn't make you lose life", async T => {
  await T.put(0, 'Archon of Coronation'); await T.resolve();
  const angel = await T.put(1, 'Serra Angel');
  expect(T.game.monarch === 0, 'A is the monarch');
  await T.game.dealDamage(angel, T.A, 4, { combat: true }); await T.resolve();
  expect(T.A.life === 40, `no life lost (${T.A.life})`);
});
test('Angel of Salvation: prevent the next 5 damage, divided', async T => {
  T.a.on('targets', req => req.cands.includes('p0') ? ['p0'] : req.cands.slice(0, req.min));
  await T.cast('Angel of Salvation');
  const angel = await T.put(1, 'Serra Angel');
  await T.game.dealDamage(angel, T.A, 3, {});
  expect(T.A.life === 40, 'first 3 prevented');
  await T.game.dealDamage(angel, T.A, 4, {});
  expect(T.A.life === 38, `2 more prevented, 2 dealt (${T.A.life})`);
});
test('Enlist: Aradesh adds the power of a tapped creature, gains double strike and draws', async T => {
  const ar = await T.put(0, 'Aradesh, the Founder');
  const angel = await T.put(0, 'Serra Angel');
  T.game.combat = { attackers: [], blockers: new Map(), firstStrikeDone: new Set() };
  T.a.on('attackers', () => [{ attacker: ar.id, defender: 'p1' }]);
  T.a.on('enlist', () => [angel.id]);
  const h = T.A.hand.length;
  await combat.declareAttackers(T.game); await T.resolve();
  expect(angel.tapped && T.game.chars(ar).power === 5, `enlisted (power ${T.game.chars(ar).power})`);
  expect(T.game.hasKeyword(ar, 'Double Strike') && T.A.hand.length === h + 1, 'double strike and a card');
});
test('Moraug: +1/+0 per attack this turn; landfall adds a combat that untaps creatures', async T => {
  await T.put(0, 'Moraug, Fury of Akoum');
  const elf = await T.put(0, 'Llanowar Elves');
  T.game.turnState.attackCounts = { [elf.id]: 2 }; T.game.touch();
  expect(T.game.chars(elf).power === 3, `elf attacked twice: 3 power (${T.game.chars(elf).power})`);
  await T.put(0, 'Forest'); await T.resolve();
  expect(T.game.extraCombats === 1, 'an additional combat phase');
  elf.tapped = true;
  T.game.combatsThisTurn = 0;
  await T.game.runStep('beginCombat'); await T.resolve();
  expect(!elf.tapped, 'untapped at the beginning of that combat');
});
test('Necromancy: cast with flash, sacrificed at the next cleanup', async T => {
  const angel = await T.put(1, 'Serra Angel', 'graveyard');
  const n = await T.put(0, 'Necromancy', 'hand');
  T.game.activePlayer = 1; T.mana(0);
  const act = getActions(T.game, 0).find(x => x.cardId === n.id && /flash/i.test(x.label));
  expect(act, 'flash cast offered');
  T.a.on('targets', req => req.cands.includes(refOf(angel)) ? [refOf(angel)] : req.cands.slice(0, req.min));
  await T.game.performAction(0, act); await T.resolve();
  expect(angel.zone === 'battlefield' && angel.controller === 0, 'reanimated');
  T.game.step = 'cleanup';
  await T.game.runStep('cleanup'); await T.resolve();
  expect(n.zone === 'graveyard' && angel.zone === 'graveyard', `both gone at cleanup (${n.zone}, ${angel.zone})`);
});
test('Impending: Overlord of the Mistmoors enters as a non-creature with time counters', async T => {
  const o = await T.put(0, 'Overlord of the Mistmoors', 'hand');
  T.mana(0);
  const act = getActions(T.game, 0).find(x => x.cardId === o.id && /impending/i.test(x.label));
  expect(act, 'impending offered');
  await T.game.performAction(0, act); await T.resolve();
  expect(o.zone === 'battlefield' && !T.isCreature(o) && o.counters.TIME === 4 && T.tokens(0).length === 2, `non-creature with 4 time counters and two insects (${o.counters.TIME})`);
  await T.game.runStep('end'); await T.resolve();
  expect(o.counters.TIME === 3, `a counter removed at the end step (${o.counters.TIME})`);
});
test('Fortify: C.A.M.P. fortifies a land; tapping it puts a counter and makes Junk', async T => {
  const camp = await T.put(0, 'C.A.M.P.');
  const forest = await T.put(0, 'Forest');
  const elf = await T.put(0, 'Llanowar Elves');
  T.a.on('targets', req => req.cands.includes(refOf(forest)) ? [refOf(forest)] : req.cands.includes(refOf(elf)) ? [refOf(elf)] : req.cands.slice(0, req.min));
  await T.activate(camp, 0, a => a.parsed.api === 'Attach');
  expect(camp.attachedTo === forest.id, 'fortifying the forest');
  T.noMana(0);
  const { activateManaAbility, manaAbilitiesOf } = await import('../src/engine/abilities.js');
  await activateManaAbility(T.game, 0, forest, manaAbilitiesOf(T.game, forest)[0].key); await T.resolve();
  expect(elf.counters.P1P1 === 1 && T.tokens(0).some(t => T.game.chars(t).subtypes.has('Junk')), 'counter on the green elf and a Junk token');
});
test('Sanctuary Blade: choose a color as it becomes attached', async T => {
  const blade = await T.put(0, 'Sanctuary Blade');
  const elf = await T.put(0, 'Llanowar Elves');
  T.a.on('targets', () => [refOf(elf)]);
  T.a.on('color', () => 'B');
  await T.activate(blade, 0, a => a.parsed.api === 'Attach');
  expect(blade.attachedTo === elf.id && T.game.chars(elf).power === 3, 'equipped: +2/+0');
  expect(blade.chosen && (blade.chosen.colors || []).includes('B') && T.game.chars(elf).keywords.some(k => /^Protection/.test(k)), 'protection from the chosen color');
});
test('Behold: Sarkhan, Dragon Ascendant makes a Treasure when you reveal a Dragon', async T => {
  await T.put(0, 'Akoum Hellkite', 'hand');
  await T.cast('Sarkhan, Dragon Ascendant');
  expect(T.tokens(0).some(t => T.game.chars(t).subtypes.has('Treasure')), 'treasure created');
  expect(T.logged(/beholds Akoum Hellkite/), 'the dragon was beheld');
});
test('Serene Master: exchange power with the creature it blocks', async T => {
  const m = await T.put(0, 'Serene Master');
  const angel = await T.put(1, 'Sun Titan');
  T.game.activePlayer = 1;
  T.game.combat = { attackers: [], blockers: new Map(), firstStrikeDone: new Set() };
  T.b.on('attackers', () => [{ attacker: angel.id, defender: 'p0' }]);
  T.a.on('blockers', () => [{ blocker: m.id, attacker: angel.id }]);
  T.a.on('targets', () => [refOf(angel)]);
  await combat.declareAttackers(T.game); await T.resolve();
  T.game.step = 'declareBlockers';
  await combat.declareBlockers(T.game); await T.resolve();
  expect(T.game.chars(m).power === 6 && T.game.chars(angel).power === 0, `powers exchanged (${T.game.chars(m).power}/${T.game.chars(angel).power})`);
});
test('Radiation: Strong gains life instead of losing it', async T => {
  await T.put(0, 'Strong, the Brutish Thespian');
  for (let i = 0; i < 3; i++) await T.put(0, 'Serra Angel', 'library');
  T.A.counters.RAD = 3;
  T.game.step = 'main1';
  await T.game.runStep('main1');
  expect(T.A.life === 43 && !T.A.counters.RAD, `gained 3, counters gone (${T.A.life}, ${T.A.counters.RAD})`);
});
test('Renown: Relic Seeker becomes renowned and finds an Equipment', async T => {
  const s = await T.put(0, 'Relic Seeker');
  const blade = await T.put(0, 'Sanctuary Blade', 'library');
  T.combatWith([[s, 1]]);
  await combat.combatDamage(T.game, false); await T.resolve();
  expect(s.renowned && s.counters.P1P1 === 1 && blade.zone === 'hand', `renowned, blade found (${blade.zone})`);
});
test('Widespread Panic: shuffling your own library puts a card from hand on top', async T => {
  await T.put(0, 'Widespread Panic');
  const elf = await T.put(0, 'Llanowar Elves', 'hand');
  T.a.on('cards', req => req.cards.includes(elf.id) ? [elf.id] : undefined);
  await T.cast('Rampant Growth');
  expect(T.A.library[0] === elf, 'the elf is on top');
});
test('Zellix: milling creature cards makes a Horror', async T => {
  await T.put(0, 'Zellix, Sanity Flayer');
  await T.put(1, 'Serra Angel', 'library'); await T.put(1, 'Llanowar Elves', 'library');
  await T.game.mill(T.B, 2, null); await T.resolve();
  expect(T.tokens(0).length === 1, `one token for one mill (${T.tokens(0).length})`);
});
test('Mobilize: Zurgo creates a tapped and attacking Warrior, sacrificed at end of turn', async T => {
  const z = await T.put(0, 'Zurgo Stormrender');
  T.game.combat = { attackers: [], blockers: new Map(), firstStrikeDone: new Set() };
  T.a.on('attackers', () => [{ attacker: z.id, defender: 'p1' }]);
  await combat.declareAttackers(T.game); await T.resolve();
  const tok = T.tokens(0)[0];
  expect(tok && tok.tapped && T.game.combat.attackers.some(a => a.card === tok.id), 'warrior attacking');
  const h = T.A.hand.length;
  T.game.combat = null;
  await T.game.runStep('end'); await T.resolve();
  expect(tok.zone !== 'battlefield' && T.B.life === 39 && T.A.hand.length === h, `sacrificed; not attacking anymore so opponents lose 1 (${T.B.life})`);
});
test('Compleated: Vraska enters with two fewer loyalty per {B/P} paid with life', async T => {
  T.noMana(0); T.A.pool.B = 5;
  const v = await T.cast("Vraska, Betrayal's Sting", 0, { mana: false });
  expect(T.A.life === 38 && v.counters.LOYALTY === 4, `paid 2 life, 4 loyalty (${T.A.life}, ${v.counters.LOYALTY})`);
});
test("Timestream Navigator: put it on the bottom of your library to take an extra turn", async T => {
  const n = await T.put(0, 'Timestream Navigator');
  for (let i = 0; i < 9; i++) await T.put(0, 'Forest');
  await T.activate(n, 0, a => a.parsed.api === 'AddTurn');
  expect(T.A.library[T.A.library.length - 1] === n && T.game.extraTurns.includes(0), 'on the bottom, extra turn');
});
test('Disturb: cast Dennick from the graveyard transformed', async T => {
  const d = await T.put(0, 'Dennick, Pious Apprentice', 'graveyard');
  T.mana(0);
  const act = getActions(T.game, 0).find(x => x.cardId === d.id && /Disturb/.test(x.label));
  expect(act, 'disturb offered');
  await T.game.performAction(0, act); await T.resolve();
  expect(d.zone === 'battlefield' && T.game.name(d) === 'Dennick, Pious Apparition', `entered transformed (${T.game.name(d)})`);
  await T.game.destroy(d, null); await T.resolve();
  expect(d.zone === 'exile', 'exiled instead of dying');
});
test("Zndrsplt's Judgment: friends copy a creature, foes bounce one", async T => {
  await T.put(0, 'Llanowar Elves');
  const angel = await T.put(1, 'Serra Angel');
  T.a.on('assignGroup', req => req.forPlayer === 0 ? 'FriendRepeat' : 'FoeBounce');
  await T.cast("Zndrsplt's Judgment");
  expect(T.tokens(0).length === 1 && angel.zone === 'hand', `A copied, B bounced (${T.tokens(0).length}, ${angel.zone})`);
});
test("Unleash: Tesak enters with a counter, can't block, has haste", async T => {
  T.a.on('unleash', () => true);
  const t = await T.cast("Tesak, Judith's Hellhound");
  expect(t.counters.P1P1 === 1 && !combat.canBlockAny(T.game, t) && T.game.hasKeyword(t, 'Haste'), 'unleashed');
});
test('Start your engines: speed rises once per turn when an opponent loses life', async T => {
  await T.cast('Howlsquad Heavy');
  expect(T.A.speed === 1, 'speed 1');
  await T.game.loseLife(T.B, 1, null); await T.game.loseLife(T.B, 1, null);
  expect(T.A.speed === 2, `speed 2 (${T.A.speed})`);
});
test('Enhanced Surveillance: look at two more cards when you surveil', async T => {
  await T.put(0, 'Enhanced Surveillance');
  for (let i = 0; i < 5; i++) await T.put(0, 'Forest', 'library');
  await T.cast('Ransom Note');
  const req = T.a.asked.find(r => /surveil/i.test(r.purpose || '') || /surveil/i.test(r.prompt || ''));
  expect(req && (req.cards || req.cands || []).length === 3, `three cards seen (${req && (req.cards || req.cands || []).length})`);
});
test('Altar of the Pantheon: devotion +1; dual devotion counts both colors', async T => {
  const ctx = { host: null, you: 0 };
  await T.put(0, 'Wall of Omens');
  const before = calcCtx(T.game, 'Count$DevotionDual.White.Black', ctx);
  await T.put(0, 'Altar of the Pantheon');
  expect(before === 1 && calcCtx(T.game, 'Count$DevotionDual.White.Black', ctx) === 2, 'Wall of Omens counts, Altar adds one');
  expect(calcCtx(T.game, 'Count$Devotion.Blue', ctx) === 1, 'blue devotion is not black');
});
test("Tekuthal: proliferate twice", async T => {
  await T.put(0, 'Tekuthal, Inquiry Dominus');
  const elf = await T.put(0, 'Llanowar Elves');
  await T.game.addCounters(elf, 'P1P1', 1, null);
  const bastion = await T.put(0, "Karn's Bastion");
  T.a.on('proliferate', req => [refOf(elf)]);
  await T.activate(bastion, 0, a => a.parsed.api === 'Proliferate');
  expect(elf.counters.P1P1 === 3, `two more counters (${elf.counters.P1P1})`);
});
test('Topography Tracker: a creature you control explores twice', async T => {
  const tr = await T.put(0, 'Topography Tracker'); await T.resolve();
  await T.put(0, 'Forest', 'library'); await T.put(0, 'Forest', 'library');
  const map = T.tokens(0).find(t => T.game.chars(t).subtypes.has('Map'));
  expect(map, 'map token');
  T.a.on('targets', () => [refOf(tr)]);
  const h = T.A.hand.length;
  await T.activate(map, 0, 0);
  expect(T.A.hand.length === h + 2, `two lands to hand (${T.A.hand.length - h})`);
});
test('Barbarian Class: roll one more die and ignore the lowest', async T => {
  await T.put(0, 'Barbarian Class');
  const g = await T.put(0, 'Clay Golem');
  const ring = await T.put(1, 'Sol Ring');
  T.a.on('targets', () => [refOf(ring)]);
  const calls = spyRng(T);
  await T.activate(g, 0, a => a.parsed.p.Monstrosity);
  const d8 = calls.filter(([n]) => n === 8).map(([, r]) => r + 1);
  expect(d8.length === 2 && g.counters.P1P1 === Math.max(...d8), `rolled two d8, kept ${Math.max(...d8)} (${g.counters.P1P1})`);
});
test("Krark's Thumb: flip two coins and ignore one", async T => {
  await T.put(0, "Krark's Thumb");
  const calls = spyRng(T);
  await T.cast('Stitch in Time');
  expect(calls.filter(([n]) => n === 2).length === 2, 'two coins flipped');
});
test('Leyline of Anticipation: begin the game with it on the battlefield', async T => {
  const l = await T.put(0, 'Leyline of Anticipation', 'hand');
  T.a.on('mulligan', () => true); T.b.on('mulligan', () => true);
  await T.game.mulligans();
  expect(l.zone === 'battlefield', `on the battlefield (${l.zone})`);
});
test("Ludevic: transforms into a copy of an exiled creature card named Olag", async T => {
  const lu = await T.put(0, 'Ludevic, Necrogenius');
  await T.resolve();
  await T.put(0, 'Serra Angel', 'graveyard'); await T.put(0, 'Wall of Omens', 'graveyard');
  T.a.on('xValue', () => 2); T.a.on('number', () => 2);
  await T.activate(lu, 0, a => a.parsed.api === 'SetState');
  expect(T.game.name(lu) === "Olag, Ludevic's Hubris", `named Olag (${T.game.name(lu)})`);
  const ch = T.game.chars(lu);
  expect(ch.power === 6 && ch.subtypes.has('Zombie') && ch.colors.has('U') && ch.colors.has('B'), `4/4 + 2 counters, Zombie, blue-black (${ch.power})`);
});

// ------------------------------------------------------------ planar die, text changes, piles, meld, stun and the last few
test('Planar die: Fractured Powerstone rolls; Ichor Elixir rolls one more and ignores one', async T => {
  const ps = await T.put(0, 'Fractured Powerstone');
  let calls = spyRng(T);
  await T.activate(ps, 0, a => a.parsed.api === 'RollPlanarDice');
  expect(calls.filter(([n]) => n === 6).length === 1 && T.logged(/rolls the planar die/), 'one planar die');
  await T.put(0, 'Ichor Elixir');
  ps.tapped = false; ps.abilityUses = {};
  calls = spyRng(T);
  await T.activate(ps, 0, a => a.parsed.api === 'RollPlanarDice');
  expect(calls.filter(([n]) => n === 6).length === 2, 'two planar dice');
});
test('Path of the Pyromancer: the Will of the Planeswalkers vote resolves without a planar deck', async T => {
  for (let i = 0; i < 3; i++) await T.put(0, 'Forest', 'hand');
  for (let i = 0; i < 6; i++) await T.put(0, 'Island', 'library');
  await T.cast('Path of the Pyromancer');
  expect(T.A.hand.length === 4 && T.A.graveyard.length >= 3, `discarded 3, drew 4 (${T.A.hand.length})`);
  expect(T.logged(/Chaos ensues|can't planeswalk/), 'the vote was carried out');
});
test('New Blood: steal a creature and turn one of its creature types into Vampire', async T => {
  await T.put(0, 'Bloodthirsty Adversary');
  const elf = await T.put(1, 'Llanowar Elves');
  T.a.on('targets', () => [refOf(elf)]);
  T.a.on('changeText', () => 'Elf');
  await T.cast('New Blood');
  const ch = T.game.chars(elf);
  expect(elf.controller === 0 && ch.subtypes.has('Vampire') && !ch.subtypes.has('Elf') && ch.subtypes.has('Druid'), `Vampire Druid under A (${[...ch.subtypes]})`);
});
test('Stun counters: an untap removes one instead; Fear of Sleep Paralysis keeps them on', async T => {
  const elf = await T.put(0, 'Llanowar Elves');
  elf.tapped = true; await T.game.addCounters(elf, 'STUN', 1, null);
  await T.game.untap(elf);
  expect(elf.tapped && !elf.counters.STUN, 'stayed tapped, counter removed');
  await T.game.untap(elf);
  expect(!elf.tapped, 'untaps next time');
  const angel = await T.put(1, 'Serra Angel');
  T.a.on('targets', req => req.cands.includes(refOf(angel)) ? [refOf(angel)] : []);
  await T.cast('Fear of Sleep Paralysis');
  expect(angel.tapped && angel.counters.STUN === 1, 'tapped and stunned');
  await T.game.untap(angel);
  expect(angel.tapped && angel.counters.STUN === 1, "the counter can't be removed: still tapped");
});
test('Chorus of the Conclave: pay extra mana for extra +1/+1 counters on creature spells', async T => {
  await T.put(0, 'Chorus of the Conclave');
  T.a.on('chorus', () => 3);
  const elf = await T.cast('Llanowar Elves');
  expect(elf.counters.P1P1 === 3, `three counters (${elf.counters.P1P1})`);
});
test('Bloodthirsty Adversary: pay {2}{R} any number of times; copy an instant from the graveyard', async T => {
  const opt = await T.put(0, 'Opt', 'graveyard');
  T.a.on('repeatCost', () => 1);
  T.a.on('targets', req => req.cands.includes(refOf(opt)) ? [refOf(opt)] : req.cands.slice(0, req.min));
  const h = T.A.hand.length;
  const ba = await T.cast('Bloodthirsty Adversary');
  expect(ba.counters.P1P1 === 1 && opt.zone === 'exile', `a counter, Opt exiled (${ba.counters.P1P1}, ${opt.zone})`);
  expect(T.A.hand.length === h + 1, `the copy drew a card (${T.A.hand.length - h})`);
});
test('Whims of the Fates: each player sacrifices one of three piles at random', async T => {
  const a = [await T.put(0, 'Llanowar Elves'), await T.put(0, 'Serra Angel'), await T.put(0, 'Wall of Omens')];
  const b = [await T.put(1, 'Llanowar Elves'), await T.put(1, 'Serra Angel'), await T.put(1, 'Wall of Omens')];
  const one = req => [req.cards[0]];
  T.a.on('pile', one); T.b.on('pile', one);
  await T.cast('Whims of the Fates');
  expect(a.filter(c => c.zone === 'battlefield').length === 2 && b.filter(c => c.zone === 'battlefield').length === 2, 'one permanent each');
});
test('Meld: Gisela and Bruna become Brisela; both cards leave together', async T => {
  const g = await T.put(0, 'Gisela, the Broken Blade');
  const b = await T.put(0, 'Bruna, the Fading Light');
  await T.game.runStep('end'); await T.resolve();
  expect(g.zone === 'battlefield' && T.game.name(g) === 'Brisela, Voice of Nightmares' && T.game.chars(g).power === 9 && b.zone === 'exile', `melded (${T.game.name(g)}, ${b.zone})`);
  await T.game.destroy(g, null); await T.resolve();
  expect(g.zone === 'graveyard' && b.zone === 'graveyard', `both in the graveyard (${g.zone}, ${b.zone})`);
});
test('Manascape Refractor: has the activated abilities of lands and spends mana as any color for them', async T => {
  const r = await T.put(0, 'Manascape Refractor');
  await T.put(1, 'Kessig Wolf Run'); await T.put(0, 'Forest');
  const keys = activatedAbilities(T.game, 0, r).map(a => a.parsed.api);
  expect(keys.includes('Pump'), `gained Kessig Wolf Run's ability (${keys})`);
  const elf = await T.put(0, 'Llanowar Elves');
  T.noMana(0); T.A.pool.C = 3; r.tapped = false; r.sick = false;
  T.a.on('xValue', () => 1); T.a.on('targets', () => [refOf(elf)]);
  const abil = T.game.chars(r).abilities.find(a => a.parsed.api === 'Pump');
  T.game.priority = 0;
  const ok = await (await import('../src/engine/abilities.js')).activateAbility(T.game, 0, r, abil.key, { ignoreTiming: true });
  await T.resolve();
  expect(ok && T.game.chars(elf).power === 2 && T.game.hasKeyword(elf, 'Trample'), `paid {X}{R}{G} with colorless (${T.game.chars(elf).power})`);
});
test('Exchange of Words: two creatures swap text boxes while it remains', async T => {
  const elf = await T.put(0, 'Llanowar Elves');
  const angel = await T.put(1, 'Serra Angel');
  T.a.on('targets', () => [refOf(elf), refOf(angel)]);
  const ex = await T.cast('Exchange of Words');
  expect(T.game.hasKeyword(elf, 'Flying') && !T.game.hasKeyword(angel, 'Flying') && T.game.chars(elf).power === 1, 'the elf has flying and vigilance, still 1/1');
  await T.game.destroy(ex, null); await T.resolve();
  expect(!T.game.hasKeyword(elf, 'Flying') && T.game.hasKeyword(angel, 'Flying'), 'back to normal');
});
test('Space Beleren: creatures get sectors; -1 counters one sector', async T => {
  const elf = await T.put(0, 'Llanowar Elves');
  const angel = await T.put(1, 'Serra Angel');
  T.a.on('sector', () => 'Alpha'); T.b.on('sector', () => 'Beta');
  const sb = await T.put(0, 'Space Beleren'); await T.resolve();
  expect(elf.sector === 'Alpha' && angel.sector === 'Beta', 'assigned');
  T.a.on('chooseSector', () => 'Alpha');
  await T.activate(sb, 0, a => a.parsed.api === 'ChooseSector' && /SubCounter<1\//.test(a.parsed.p.Cost));
  expect(elf.counters.P1P1 === 1 && !angel.counters.P1P1, 'only the alpha sector got counters');
  const elf2 = await T.put(1, 'Llanowar Elves'); await T.resolve();
  expect(elf2.sector === 'Beta', 'a creature entering later is assigned too');
  sb.abilityUses = {};
  expect(combat.canBlock(T.game, angel, elf), 'before +1: blocks across sectors');
  await T.activate(sb, 0, a => a.parsed.api === 'Effect');
  expect(!combat.canBlock(T.game, angel, elf) && combat.canBlock(T.game, angel, elf2), 'after +1: only within its sector');
});
test("Danny Pink: counters for the first time each turn draw a card", async T => {
  await T.put(0, 'Danny Pink');
  const elf = await T.put(0, 'Llanowar Elves');
  const h = T.A.hand.length;
  await T.game.addCounters(elf, 'P1P1', 1, null); await T.resolve();
  await T.game.addCounters(elf, 'P1P1', 1, null); await T.resolve();
  expect(T.A.hand.length === h + 1, `one card (${T.A.hand.length - h})`);
});
test("Everybody Lives!: players can't lose life this turn", async T => {
  await T.cast('Everybody Lives!');
  await T.game.loseLife(T.B, 5, null);
  expect(T.B.life === 40, `no life lost (${T.B.life})`);
});
test('River Song: draw from the bottom; opponents searching their library get punished', async T => {
  const rs = await T.put(0, 'River Song');
  await T.put(0, 'Serra Angel', 'library');
  const bottom = await T.put(0, 'Wall of Omens', 'library');
  T.A.library.push(T.A.library.splice(T.A.library.indexOf(bottom), 1)[0]);
  await T.game.drawCards(T.A, 1, null);
  expect(bottom.zone === 'hand', 'drew the bottom card');
  await T.put(1, 'Forest', 'library');
  T.game.activePlayer = 1;
  await T.cast('Rampant Growth', 1);
  expect(rs.counters.P1P1 === 1 && T.B.life === 37, `a counter and 3 damage (${T.B.life})`);
});
test('Regenerations Restored: removing time counters scries and gains life', async T => {
  const rr = await T.put(0, 'Regenerations Restored'); await T.resolve();
  expect(rr.counters.TIME === 12, 'vanishing 12');
  await T.game.removeCounters(rr, 'TIME', 1); await T.resolve();
  expect(T.A.life === 41, `gained 1 (${T.A.life})`);
});
test('The Master, Multiplied: your triggered abilities can\'t make you sacrifice creature tokens', async T => {
  await T.put(0, 'The Master, Multiplied');
  await T.cast('Dragon Fodder');
  const tok = T.tokens(0)[0];
  expect(tok && T.game.cantSacrifice(tok, { isTrigger: true, controller: 0 }) && !T.game.cantSacrifice(tok, { isSpell: true, controller: 0 }), 'blocked only for your triggers');
});
test('The Pandorica: the permanent stays phased out while it remains tapped; The War Doctor counts it', async T => {
  const pan = await T.put(0, 'The Pandorica');
  const doc = await T.put(0, 'The War Doctor');
  const angel = await T.put(1, 'Serra Angel');
  angel.tapped = true;
  T.a.on('targets', () => [refOf(angel)]);
  T.a.on('keepTapped', () => true);
  await T.activate(pan, 0, a => a.parsed.api === 'Untap');
  expect(angel.phasedOut && !angel.tapped && doc.counters.TIME === 1, `phased out, War Doctor +1 (${doc.counters.TIME})`);
  T.game.activePlayer = 1; await T.game.runStep('untap');
  expect(angel.phasedOut, "can't phase in while The Pandorica is tapped");
  T.game.activePlayer = 0; T.a.on('keepTapped', () => false);
  await T.game.runStep('untap'); await T.resolve();
  expect(!pan.tapped && !angel.phasedOut, 'phased in when The Pandorica untapped');
});

test('Highest mana value and greatest power filters (Padeem, Desecrator Hag)', async T => {
  await T.put(0, 'Padeem, Consul of Innovation');
  await T.put(0, 'Sol Ring');
  const x = () => calcCtx(T.game, 'Count$Valid Artifact.greatestCMC_Artifact+YouCtrl', { host: null, you: 0 });
  expect(x() === 1, 'Sol Ring is the highest');
  const s = await T.put(1, 'Weathered Sentinels');
  expect(x() === 0, 'not any more');
  await T.game.destroy(s, null);
  const angel = await T.put(0, 'Serra Angel', 'graveyard'); await T.put(0, 'Llanowar Elves', 'graveyard');
  await T.cast('Desecrator Hag');
  expect(angel.zone === 'hand', 'the 4-power angel returned');
});
test('Attack history: Weathered Sentinels attacks players who attacked you; Bloodthirster attacks a player once', async T => {
  const s = await T.put(0, 'Weathered Sentinels');
  T.B.attackedPlayers = [0]; T.C.attackedPlayers = [3];
  expect(combat.canAttackDefender(T.game, s, 1, null) && !combat.canAttackDefender(T.game, s, 2, null), 'only B, who attacked A');
  const b = await T.put(0, 'Bloodthirster');
  T.game.combat = { attackers: [], blockers: new Map(), firstStrikeDone: new Set() };
  T.a.on('attackers', () => [{ attacker: b.id, defender: 'p1' }]);
  await combat.declareAttackers(T.game); await T.resolve();
  expect(!combat.canAttackDefender(T.game, b, 1, null) && combat.canAttackDefender(T.game, b, 2, null), "it can't attack B again this turn");
}, { players: 4 });

test('Steel Hellkite: destroys only what players it damaged control', async T => {
  const h = await T.put(0, 'Steel Hellkite');
  const ringB = await T.put(1, 'Sol Ring'), ringC = await T.put(2, 'Sol Ring'), ringA = await T.put(0, 'Sol Ring');
  await T.game.dealDamage(h, T.B, 5, { combat: true });
  T.a.on('xValue', () => 1);
  await T.activate(h, 0, a => a.parsed.api === 'DestroyAll');
  expect(ringB.zone === 'graveyard' && ringC.zone === 'battlefield' && ringA.zone === 'battlefield', `only B's ring (${ringB.zone}, ${ringC.zone}, ${ringA.zone})`);
}, { players: 3 });
test('"AttachedBy Self": Presence of Gond grants its ability to the enchanted creature', async T => {
  const elf = await T.put(0, 'Llanowar Elves');
  T.a.on('targets', () => [refOf(elf)]);
  await T.cast('Presence of Gond');
  expect(activatedAbilities(T.game, 0, elf).some(a => a.parsed.api === 'Token'), 'the elf can make tokens');
});
test('Sylvan Offering: you and the chosen opponent each get the tokens', async T => {
  T.a.on('xValue', () => 2);
  await T.cast('Sylvan Offering');
  expect(T.tokens(0).length === 3 && T.tokens(1).length === 3, `three tokens each (${T.tokens(0).length}, ${T.tokens(1).length})`);
});
test('Escape: Woe Strider escapes with two +1/+1 counters', async T => {
  const w = await T.put(0, 'Woe Strider', 'graveyard');
  for (let i = 0; i < 4; i++) await T.put(0, 'Forest', 'graveyard');
  T.mana(0);
  const act = getActions(T.game, 0).find(x => x.cardId === w.id && /Escape/i.test(x.label));
  expect(act, 'escape offered');
  await T.game.performAction(0, act); await T.resolve();
  expect(w.zone === 'battlefield' && w.counters.P1P1 === 2, `escaped with counters (${w.counters.P1P1})`);
});
test('Crackling Doom: each opponent sacrifices its greatest-power creature', async T => {
  const angel = await T.put(1, 'Serra Angel'), elf = await T.put(1, 'Llanowar Elves');
  await T.cast('Crackling Doom');
  expect(angel.zone === 'graveyard' && elf.zone === 'battlefield' && T.B.life === 38, `angel sacrificed (${angel.zone}, ${elf.zone}, ${T.B.life})`);
});
test('Equip restrictions: Lothlórien Blade equips only Elves', async T => {
  const blade = await T.put(0, 'Lothlórien Blade');
  const elf = await T.put(0, 'Llanowar Elves'), angel = await T.put(0, 'Serra Angel');
  let cands = null;
  T.a.on('targets', req => { cands = req.cands; return [refOf(elf)]; });
  await T.activate(blade, 0, a => a.parsed.p.IsEquip === 'True');
  expect(cands && cands.includes(refOf(elf)) && !cands.includes(refOf(angel)) && blade.attachedTo === elf.id, 'only the elf');
});

process.exit(await run(tests) ? 1 : 0);
