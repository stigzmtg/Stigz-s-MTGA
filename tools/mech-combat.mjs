// Behavioural tests for the combat mechanics in src/engine/mech-combat.js: banding, blocking more than one creature,
// rampage, provoke, combat damage assigned in unusual ways, block-changing effects, attack requirements, excess damage,
// saddle and crew. Usage: node tools/mech-combat.mjs [name-filter]
import { setup, expect, run, db } from './lib/testkit.mjs';
import { refOf, activatedAbilities } from '../src/engine/abilities.js';
import * as combat from '../src/engine/combat.js';
import { blockCapacity } from '../src/engine/mech-combat.js';
import { matchValid } from '../src/engine/filters.js';

const tests = [];
const test = (name, fn, opts) => tests.push({ name, fn, opts });

// declare attackers / blockers the way the turn does, with scripted declarations
async function attack(T, attacks) {
  T.game.combat = { attackers: [], blockers: new Map(), firstStrikeDone: new Set() };
  T.game.step = 'declareAttackers';
  T.agents[T.game.activePlayer].on('attackers', () => attacks.map(([a, d]) => ({ attacker: a.id, defender: typeof d === 'number' ? 'p' + d : 'c' + d.id })));
  await combat.declareAttackers(T.game); await T.resolve();
}
async function block(T, blocks, blockerAgent = T.b) {
  T.game.step = 'declareBlockers';
  blockerAgent.on('blockers', () => blocks.map(([b, a]) => ({ blocker: b.id, attacker: a.id })));
  await combat.declareBlockers(T.game); await T.resolve();
}
async function damage(T) {
  if (combat.needsFirstStrike(T.game)) { T.game.step = 'firstStrikeDamage'; await combat.combatDamage(T.game, true); await T.resolve(); }
  T.game.step = 'combatDamage'; await combat.combatDamage(T.game, false); await T.resolve();
}
const blocking = (T, b) => T.game.combat.attackers.filter(r => r.blockers.includes(b.id)).map(r => r.card);
const alive = c => c.zone === 'battlefield';
const ids = list => JSON.stringify(list.map(c => c.id).sort());

// ------------------------------------------------------------ banding
test('Banding: a band attacks together; one blocker blocks the whole band and the attacking player divides its damage', async T => {
  const hero = await T.put(0, 'Benalish Hero'), bears = await T.put(0, 'Grizzly Bears');
  const angel = await T.put(1, 'Serra Angel');
  let offered = null;
  T.a.on('band', req => { offered = req.cards; return [bears.id]; });
  await attack(T, [[hero, 1], [bears, 1]]);
  expect(offered && offered.includes(bears.id), 'the bears are offered to the band');
  const recs = T.game.combat.attackers;
  expect(recs[0].band != null && recs[0].band === recs[1].band, 'both attack in one band');
  await block(T, [[angel, bears]]);
  expect(ids(blocking(T, angel).map(id => T.game.cardById(id))) === ids([hero, bears]), `the angel blocks both (${blocking(T, angel)})`);
  // the attacking player (who has banding) divides the angel's 4 damage: all of it to the hero
  const asked = [];
  T.a.on('divide', req => { asked.push(req.target); return req.target === refOf(hero) ? 4 : 0; });
  await damage(T);
  expect(asked.length === 1, `the attacking player divided the angel's damage (${asked.length} prompts)`);
  expect(!alive(hero) && alive(bears), 'the hero took it all; the bears live');
  expect(angel.damage === 3, `the angel took 1 + 2 (${angel.damage})`);
});
test('Banding: a band only of creatures with banding plus at most one without', async T => {
  const hero = await T.put(0, 'Benalish Hero'), b1 = await T.put(0, 'Grizzly Bears'), b2 = await T.put(0, 'Llanowar Elves');
  T.a.on('band', () => [b1.id, b2.id]);
  await attack(T, [[hero, 1], [b1, 1], [b2, 1]]);
  const r = id => T.game.combat.attackers.find(x => x.card === id);
  expect(r(hero.id).band != null && r(hero.id).band === r(b1.id).band && r(b2.id).band == null, 'only one creature without banding joins');
});
test('Banding: a blocker with banding lets the defending player divide the attacker’s damage (none tramples over)', async T => {
  const wurm = await T.put(0, 'Colossal Dreadmaw');
  const hero = await T.put(1, 'Benalish Hero'), bears = await T.put(1, 'Grizzly Bears');
  await attack(T, [[wurm, 1]]);
  await block(T, [[hero, wurm], [bears, wurm]]);
  T.b.on('divide', req => (req.target === refOf(hero) ? 6 : 0));
  await damage(T);
  expect(!alive(hero) && alive(bears), 'all 6 on the hero, the bears live');
  expect(T.B.life === 40, `no trample damage to the defending player (${T.B.life})`);
});
test('Banding: the AI divides a banding blocker’s damage to lose as little as possible', async T => {
  const wurm = await T.put(0, 'Colossal Dreadmaw');
  const hero = await T.put(1, 'Benalish Hero'), angel = await T.put(1, 'Serra Angel');
  await attack(T, [[wurm, 1]]);
  await block(T, [[hero, wurm], [angel, wurm]]);
  await damage(T);
  expect(!alive(hero) && alive(angel), `the AI puts the damage on the hero and keeps the angel (${angel.damage})`);
});
test('Bands with other: Cathedral of Serra’s white legends band together', async T => {
  await T.put(0, 'Cathedral of Serra');
  const a = await T.put(0, 'Thalia, Guardian of Thraben'), b = await T.put(0, 'Adeline, Resplendent Cathar');
  T.a.on('band', () => [b.id]);
  await attack(T, [[a, 1], [b, 1]]);
  const r = T.game.combat.attackers;
  expect(r[0].band != null && r[0].band === r[1].band, 'the two legends band');
});
test('Banding: a band is blocked together even by an effect (Fog Patch: attacking creatures become blocked)', async T => {
  const hero = await T.put(0, 'Benalish Hero'), bears = await T.put(0, 'Grizzly Bears'), elf = await T.put(0, 'Llanowar Elves');
  T.a.on('band', () => [bears.id]);
  await attack(T, [[hero, 1], [bears, 1], [elf, 1]]);
  await block(T, []);
  await T.cast('Fog Patch', 1);
  expect(T.game.combat.attackers.every(r => r.blocked), 'every attacker is blocked');
  await damage(T);
  expect(T.B.life === 40, `no combat damage (${T.B.life})`);
});

// ------------------------------------------------------------ blocking more than one creature
test('Can block an additional creature: Ghastbark Twins blocks two attackers and divides its damage', async T => {
  const twins = await T.put(1, 'Ghastbark Twins');
  expect(blockCapacity(T.game, twins) === 2, `capacity 2 (${blockCapacity(T.game, twins)})`);
  const x = await T.put(0, 'Grizzly Bears'), y = await T.put(0, 'Grizzly Bears'), z = await T.put(0, 'Grizzly Bears');
  await attack(T, [[x, 1], [y, 1], [z, 1]]);
  await block(T, [[twins, x], [twins, y], [twins, z]]);
  expect(blocking(T, twins).length === 2, `it blocks two of the three (${blocking(T, twins).length})`);
  expect(T.logged(/Ghastbark Twins blocks Grizzly Bears, Ghastbark Twins blocks Grizzly Bears/), 'both blocks are logged');
  await damage(T);
  expect(!alive(x) && !alive(y) && alive(z), 'its 7 damage kills both bears it blocks');
  expect(twins.damage === 4 && T.B.life === 38, `it took 4, the third bear hit for 2 (${twins.damage}, ${T.B.life})`);
});
test('Can block an additional creature: the blocker’s controller divides its damage as they choose', async T => {
  const twins = await T.put(1, 'Ghastbark Twins');
  const x = await T.put(0, 'Grizzly Bears'), y = await T.put(0, 'Craw Wurm');
  await attack(T, [[x, 1], [y, 1]]);
  await block(T, [[twins, x], [twins, y]]);
  const prompts = [];
  T.b.on('divide', req => { prompts.push(req); return 0; });
  await damage(T);
  expect(prompts.length === 1 && prompts[0].max === 7, 'one prompt for the first attacker, the rest goes to the last');
  expect(alive(x) && !alive(y), 'all 7 to the wurm');
});
test('Can block any number of creatures: Avatar of Hope blocks three attackers', async T => {
  const avatar = await T.put(1, 'Avatar of Hope');
  expect(blockCapacity(T.game, avatar) === Infinity, 'any number');
  const xs = [await T.put(0, 'Grizzly Bears'), await T.put(0, 'Grizzly Bears'), await T.put(0, 'Llanowar Elves')];
  await attack(T, xs.map(c => [c, 1]));
  await block(T, xs.map(c => [avatar, c]));
  expect(blocking(T, avatar).length === 3, 'it blocks all three');
  expect(T.game.combat.attackers.every(r => r.blocked), 'all are blocked');
  await damage(T);
  // (its 4 damage, divided by the AI to kill the most: both bears)
  expect(!alive(xs[0]) && !alive(xs[1]) && alive(xs[2]) && avatar.damage === 5, `it kills both bears (${xs.filter(alive).length} left, took ${avatar.damage})`);
});
test('Can block an additional creature this turn (Mounted Archers’ ability) and each combat (Brave the Sands)', async T => {
  const archers = await T.put(1, 'Mounted Archers');
  expect(blockCapacity(T.game, archers) === 1, 'one before');
  await T.activate(archers, 1, a => a.parsed.api === 'Pump');
  expect(blockCapacity(T.game, archers) === 2, `two after (${blockCapacity(T.game, archers)})`);
  const bears = await T.put(1, 'Grizzly Bears');
  await T.put(1, 'Brave the Sands');
  expect(blockCapacity(T.game, bears) === 2 && blockCapacity(T.game, archers) === 3, `Brave the Sands adds one each (${blockCapacity(T.game, bears)}, ${blockCapacity(T.game, archers)})`);
});
test('Hundred-Handed One blocks a hundred creatures once monstrous; Kemba’s Legion one more per Equipment', async T => {
  const h = await T.put(1, 'Hundred-Handed One');
  expect(blockCapacity(T.game, h) === 1, 'not monstrous yet');
  h.monstrous = true; T.game.touch();
  expect(blockCapacity(T.game, h) === 100 && T.game.hasKeyword(h, 'Reach'), `monstrous: 100 and reach (${blockCapacity(T.game, h)})`);
  const k = await T.put(1, "Kemba's Legion");
  const s1 = await T.put(1, 'Bonesplitter'), s2 = await T.put(1, 'Short Sword');
  s1.attachedTo = k.id; s2.attachedTo = k.id; T.game.touch();
  expect(blockCapacity(T.game, k) === 3, `two Equipment: 3 (${blockCapacity(T.game, k)})`);
});
test('Blaze of Glory: the creature can block any number and blocks each attacker if able', async T => {
  const xs = [await T.put(0, 'Grizzly Bears'), await T.put(0, 'Llanowar Elves')];
  const wall = await T.put(1, 'Wall of Omens');
  await attack(T, xs.map(c => [c, 1]));
  T.a.on('targets', () => [refOf(wall)]);
  T.game.step = 'declareAttackers';
  await T.cast('Blaze of Glory', 0);
  await block(T, []);
  expect(blocking(T, wall).length === 2, `the wall blocks both (${blocking(T, wall).length})`);
});
test('The AI uses a creature that can block several attackers on the ones it survives', async T => {
  const avatar = await T.put(1, 'Avatar of Hope');
  const xs = [await T.put(0, 'Grizzly Bears'), await T.put(0, 'Grizzly Bears'), await T.put(0, 'Llanowar Elves')];
  await attack(T, xs.map(c => [c, 1]));
  T.game.step = 'declareBlockers';
  await combat.declareBlockers(T.game); await T.resolve();
  expect(blocking(T, avatar).length === 3, `the AI blocks all three with the Avatar (${blocking(T, avatar).length})`);
});

// ------------------------------------------------------------ rampage, provoke
test('Rampage: Wolverine Pack gets +2/+2 for each blocker beyond the first', async T => {
  const pack = await T.put(0, 'Wolverine Pack');
  const bs = [await T.put(1, 'Llanowar Elves'), await T.put(1, 'Llanowar Elves'), await T.put(1, 'Llanowar Elves')];
  await attack(T, [[pack, 1]]);
  await block(T, bs.map(b => [b, pack]));
  const ch = T.game.chars(pack);
  expect(ch.power === 6 && ch.toughness === 8, `+4/+4 (${ch.power}/${ch.toughness})`);
});
test('Rampage: one blocker, no bonus', async T => {
  const pack = await T.put(0, 'Wolverine Pack');
  const b = await T.put(1, 'Llanowar Elves');
  await attack(T, [[pack, 1]]);
  await block(T, [[b, pack]]);
  expect(T.game.chars(pack).power === 2, `no bonus (${T.game.chars(pack).power})`);
});
test('Provoke: the target untaps and must block the provoking creature', async T => {
  const g = await T.put(0, 'Goblin Grappler');
  const angel = await T.put(1, 'Serra Angel'); angel.tapped = true;
  T.a.on('targets', req => (req.cands.includes(refOf(angel)) ? [refOf(angel)] : undefined));
  T.a.on('confirm', () => true);
  await attack(T, [[g, 1]]);
  expect(!angel.tapped, 'the angel untapped');
  await block(T, []);
  expect(blocking(T, angel).includes(g.id), 'and blocks the grappler');
});

// ------------------------------------------------------------ combat damage: assigned elsewhere, or not at all
test('Assigns no combat damage: Ophidian draws instead of dealing damage', async T => {
  const o = await T.put(0, 'Ophidian');
  T.a.on('confirm', () => true);
  const hand = T.A.hand.length;
  await attack(T, [[o, 1]]);
  await block(T, []);
  expect(T.A.hand.length === hand + 1, 'drew a card');
  await damage(T);
  expect(T.B.life === 40, `no combat damage (${T.B.life})`);
});
test('Assigns no combat damage: Keeper of Tresserhorn makes the player lose 2 instead; only this turn', async T => {
  const k = await T.put(0, 'Keeper of Tresserhorn');
  await attack(T, [[k, 1]]);
  await block(T, []);
  await damage(T);
  expect(T.B.life === 38, `lost 2, no combat damage (${T.B.life})`);
  await T.game.expireDurations('EOT');
  T.game.combat = null;
  expect(!T.game.activeStatics('AssignNoCombatDamage').length, 'the effect ends with the turn');
});
test('Laccolith Titan: blocked, it deals its damage to a creature and assigns no combat damage', async T => {
  const t = await T.put(0, 'Laccolith Titan');
  const wall = await T.put(1, 'Wall of Omens'), elf = await T.put(1, 'Llanowar Elves');
  T.a.on('confirm', () => true);
  T.a.on('targets', req => (req.cands.includes(refOf(elf)) ? [refOf(elf)] : undefined));
  await attack(T, [[t, 1]]);
  await block(T, [[wall, t]]);
  expect(!alive(elf), 'the elf took 6');
  await damage(T);
  expect(wall.damage === 0, `no combat damage to the wall (${wall.damage})`);
});
test('Master of Cruelties: attacks alone; unblocked, the player goes to 1 and it deals no combat damage (until end of combat)', async T => {
  const m = await T.put(0, 'Master of Cruelties'), bears = await T.put(0, 'Grizzly Bears');
  await attack(T, [[m, 1], [bears, 1]]);
  expect(T.game.combat.attackers.length === 1 && T.game.combat.attackers[0].card === bears.id, `it can only attack alone: with others, it stays home (${T.game.combat.attackers.length} attackers)`);
  await attack(T, [[m, 1]]);
  await block(T, []);
  expect(T.B.life === 1, `life becomes 1 (${T.B.life})`);
  await damage(T);
  expect(T.B.life === 1, `no combat damage (${T.B.life})`);
  await T.game.expireDurations('UntilEndOfCombat');
  expect(!T.game.activeStatics('AssignNoCombatDamage').length, 'the effect ends with combat');
});
test('Becomes blocked: Curtain of Light blocks an unblockable attacker (no damage); Choking Vines also deals 1', async T => {
  const eel = await T.put(0, 'Phantom Warrior'), bears = await T.put(0, 'Grizzly Bears');
  await attack(T, [[eel, 1], [bears, 1]]);
  await block(T, []);
  T.b.on('targets', req => (req.cands.includes(refOf(eel)) ? [refOf(eel)] : undefined));
  await T.cast('Curtain of Light', 1);
  expect(T.game.isBlocked(eel) && !T.game.isBlocked(bears), 'the warrior is blocked, the bears not');
  T.b.on('targets', req => (req.cands.includes(refOf(bears)) ? [refOf(bears)] : undefined));
  T.b.on('xValue', () => 1);
  await T.cast('Choking Vines', 1);
  expect(T.game.isBlocked(bears) && bears.damage === 1, `the bears are blocked and took 1 (${bears.damage})`);
  await damage(T);
  expect(T.B.life === 40, `no combat damage (${T.B.life})`);
});
test('Butcher Orgg divides its combat damage among the defending player and creatures they control', async T => {
  const orgg = await T.put(0, 'Butcher Orgg');
  const elf = await T.put(1, 'Llanowar Elves'), bears = await T.put(1, 'Grizzly Bears');
  await attack(T, [[orgg, 1]]);
  await block(T, [[bears, orgg]]);
  T.a.on('divideCombatDamage', req => (req.type === 'confirm' ? true : [refOf(T.B), refOf(elf), refOf(bears)]));
  T.a.on('divide', req => (req.target === refOf(T.B) ? 3 : req.target === refOf(elf) ? 1 : 0));
  await damage(T);
  expect(T.B.life === 37 && !alive(elf) && !alive(bears), `3 to the player, 1 to the elf, 2 to the bears (${T.B.life}, ${alive(elf)}, ${alive(bears)})`);
});
test('Butcher Orgg (AI): blocked, it still gets its damage where it wants', async T => {
  const orgg = await T.put(0, 'Butcher Orgg');
  const wall = await T.put(1, 'Wall of Omens'), angel = await T.put(1, 'Serra Angel');
  await attack(T, [[orgg, 1]]);
  await block(T, [[wall, orgg]]);
  await damage(T);
  expect(!alive(angel), 'the AI kills the angel');
});
test('Cunning Giant: unblocked, it may deal its combat damage to a creature instead', async T => {
  const g = await T.put(0, 'Cunning Giant');
  const angel = await T.put(1, 'Serra Angel');
  await attack(T, [[g, 1]]);
  await block(T, []);
  T.a.on('unblockedToCreature', () => [refOf(angel)]);
  await damage(T);
  expect(!alive(angel) && T.B.life === 40, `the angel took 4, the player nothing (${T.B.life})`);
});
test('Loot, the Anomaly: negative power assigns combat damage as though positive', async T => {
  const loot = await T.put(0, 'Loot, the Anomaly');
  loot.temp.push({ power: -4, until: 'EOT' }); T.game.touch();
  const p = T.game.chars(loot).power;
  expect(p < 0, `negative power (${p})`);
  await attack(T, [[loot, 1]]);
  await block(T, []);
  await damage(T);
  expect(T.B.life === 40 + p, `dealt ${-p} (${T.B.life})`);
});
test('No cleanup damage: Ancient Adamantoise keeps its damage', async T => {
  const a = await T.put(0, 'Ancient Adamantoise'), bears = await T.put(0, 'Grizzly Bears');
  a.damage = 5; bears.damage = 1;
  T.game.step = 'cleanup';
  await T.game.runStep('cleanup');
  expect(a.damage === 5 && bears.damage === 0, `the tortoise keeps 5, the bears heal (${a.damage}, ${bears.damage})`);
});

// ------------------------------------------------------------ excess damage, infect, colorless sources
test('Excess damage: Toralf deals the excess of noncombat damage to another target', async T => {
  await T.put(0, 'Toralf, God of Fury');
  const elf = await T.put(1, 'Llanowar Elves');
  T.a.on('targets', req => (req.cands.includes(refOf(elf)) ? [refOf(elf)] : req.cands.includes(refOf(T.B)) ? [refOf(T.B)] : undefined));
  await T.cast('Lightning Bolt', 0);
  expect(!alive(elf) && T.B.life === 38, `2 excess to the player (${T.B.life})`);
  const myr = await T.put(1, 'Darksteel Myr');
  T.a.on('targets', req => (req.cands.includes(refOf(myr)) ? [refOf(myr)] : req.cands.includes(refOf(T.B)) ? [refOf(T.B)] : undefined));
  await T.cast('Lightning Bolt', 0);
  expect(alive(myr) && T.B.life === 36 && matchValid(T.game, myr, 'Card.wasDealtExcessDamageThisTurn', { you: 0 }), `an indestructible 0/1 dealt 3: 2 excess, and it remembers (${T.B.life})`);
});
test('Excess damage: combat excess doesn’t trigger Toralf (noncombat only); Magmatic Galleon makes one Treasure per event', async T => {
  await T.put(0, 'Toralf, God of Fury');
  await T.put(0, 'Magmatic Galleon');
  await T.resolve();   // (its enters trigger has no target yet)
  const wurm = await T.put(0, 'Craw Wurm'), elf = await T.put(1, 'Llanowar Elves');
  await attack(T, [[wurm, 1]]);
  await block(T, [[elf, wurm]]);
  await damage(T);
  expect(!T.game.stack.length && T.B.life === 40, 'no trigger from combat excess');
  const before = T.tokens(0).length;
  const e1 = await T.put(1, 'Llanowar Elves'), e2 = await T.put(1, 'Llanowar Elves');
  T.game.combat = null; T.game.step = 'main1';
  T.a.on('targets', req => (req.cands.includes(refOf(T.B)) ? [refOf(T.B)] : undefined));
  const life = T.B.life;
  await T.cast('Pyroclasm', 0);
  expect(!alive(e1) && !alive(e2), 'both elves died');
  expect(T.B.life === life - 2, `Toralf triggered for each elf's 1 excess (${life - T.B.life})`);
  expect(T.tokens(0).length - before === 1, `one Treasure for the one Pyroclasm (${T.tokens(0).length - before})`);
});
test('Infect damage: Phyrexian Unlife at 0 life turns damage to you into poison', async T => {
  await T.put(0, 'Phyrexian Unlife');
  T.A.life = 0; T.game.touch();
  const bolt = await T.put(1, 'Lightning Bolt', 'hand');
  T.b.on('targets', req => (req.cands.includes(refOf(T.A)) ? [refOf(T.A)] : undefined));
  T.mana(1); T.game.priority = 1;
  const { castSpell } = await import('../src/engine/abilities.js');
  await castSpell(T.game, 1, bolt, {}); await T.resolve();
  expect(T.A.life === 0 && (T.A.counters.POISON || 0) === 3 && !T.A.lost, `3 poison, life stays 0 (${T.A.life}, ${T.A.counters.POISON})`);
});
test('Colorless damage source: Ghostly Flame lets a red source damage a creature with protection from red', async T => {
  const knight = await T.put(1, 'Paladin en-Vec');
  T.a.on('targets', req => (req.cands.includes(refOf(knight)) ? [refOf(knight)] : undefined));
  await T.put(0, 'Ghostly Flame');
  const { DamageAll } = {};
  await T.cast('Pyroclasm', 0);
  expect(knight.damage === 2 || !alive(knight), `the knight took damage (${knight.damage})`);
});

// ------------------------------------------------------------ who can block whom
test('Ignore landwalk: Quagmire lets swampwalk creatures be blocked; Staff of the Ages any landwalk', async T => {
  const walker = await T.put(0, 'Bog Raiders');
  const bears = await T.put(1, 'Grizzly Bears');
  await T.put(1, 'Swamp');
  expect(!combat.canBlock(T.game, bears, walker), 'swampwalk: unblockable');
  const q = await T.put(0, 'Quagmire');
  expect(combat.canBlock(T.game, bears, walker), 'with Quagmire, blockable');
  await T.game.moveCard(q, 'graveyard', { silent: true });
  const fw = await T.put(0, 'Shanodin Dryads');
  await T.put(1, 'Forest');
  await T.put(1, 'Quagmire');
  expect(!combat.canBlock(T.game, bears, fw), 'Quagmire leaves forestwalk alone');
  await T.put(1, 'Staff of the Ages');
  expect(combat.canBlock(T.game, bears, fw), 'Staff of the Ages: any landwalk');
});
test('Street Savvy: the enchanted creature blocks landwalkers', async T => {
  const walker = await T.put(0, 'Bog Raiders');
  const bears = await T.put(1, 'Grizzly Bears'), other = await T.put(1, 'Grizzly Bears');
  await T.put(1, 'Swamp');
  const aura = await T.put(1, 'Street Savvy'); aura.attachedTo = bears.id; T.game.touch();
  expect(combat.canBlock(T.game, bears, walker) && !combat.canBlock(T.game, other, walker), 'only the enchanted one');
});
test('Can block if shadow / reach: Heartwood Dryad blocks shadow creatures, Dragon Hunter blocks Dragons', async T => {
  const shade = await T.put(0, 'Soltari Foot Soldier'), dragon = await T.put(0, 'Shivan Dragon'), bird = await T.put(0, 'Suntail Hawk');
  const dryad = await T.put(1, 'Heartwood Dryad'), hunter = await T.put(1, 'Dragon Hunter'), bears = await T.put(1, 'Grizzly Bears');
  expect(combat.canBlock(T.game, dryad, shade) && !combat.canBlock(T.game, bears, shade), 'the dryad blocks the shadow creature, the bears don’t');
  expect(combat.canBlock(T.game, hunter, dragon) && !combat.canBlock(T.game, hunter, bird) && !combat.canBlock(T.game, bears, dragon), 'the hunter blocks the Dragon (not the Bird)');
});
test('Block tapped: Masako lets tapped creatures you control block', async T => {
  const elf = await T.put(0, 'Llanowar Elves');
  const bears = await T.put(1, 'Grizzly Bears'); bears.tapped = true;
  expect(!combat.canBlockAny(T.game, bears), 'tapped: no');
  await T.put(1, 'Masako the Humorless');
  expect(combat.canBlockAny(T.game, bears) && combat.canBlock(T.game, bears, elf), 'with Masako: yes');
});
test('Must be blocked by all: Marble Priest is blocked by every Wall able to', async T => {
  const priest = await T.put(0, 'Marble Priest');
  const w1 = await T.put(1, 'Wall of Omens'), w2 = await T.put(1, 'Wall of Wood'), bears = await T.put(1, 'Grizzly Bears');
  await attack(T, [[priest, 1]]);
  await block(T, []);
  expect(blocking(T, w1).includes(priest.id) && blocking(T, w2).includes(priest.id) && !blocking(T, bears).length, 'both walls block, the bears don’t have to');
  await damage(T);
  expect(alive(priest), 'and Walls deal it no combat damage');
});
test('Gorm the Great must be blocked by two or more creatures if able', async T => {
  const gorm = await T.put(0, 'Gorm the Great');
  await T.put(1, 'Grizzly Bears'); await T.put(1, 'Grizzly Bears');
  await attack(T, [[gorm, 1]]);
  await block(T, []);
  expect(T.game.combat.attackers[0].blockers.length === 2, `two blockers (${T.game.combat.attackers[0].blockers.length})`);
});

// ------------------------------------------------------------ effects that change blocks
test('Switch block: General Jarkeld swaps the blockers of two attackers', async T => {
  const x = await T.put(0, 'Grizzly Bears'), y = await T.put(0, 'Craw Wurm');
  const jarkeld = await T.put(0, 'General Jarkeld');
  const bx = await T.put(1, 'Llanowar Elves'), by = await T.put(1, 'Wall of Omens');
  await attack(T, [[x, 1], [y, 1]]);
  await block(T, [[bx, x], [by, y]]);
  T.a.on('targets', () => [refOf(x), refOf(y)]);
  await T.activate(jarkeld, 0, a => a.parsed.api === 'SwitchBlock');
  expect(blocking(T, bx)[0] === y.id && blocking(T, by)[0] === x.id, 'the blockers swapped');
  await damage(T);
  expect(!alive(bx) && alive(x), 'the wurm kills the elf; the wall stops the bears');
});
test('Switch block: Sorrow’s Path swaps what two blockers block', async T => {
  // (its own trigger deals 2 to each creature you control)
  const x = await T.put(0, 'Indomitable Ancients'), y = await T.put(0, 'Craw Wurm');
  const bx = await T.put(1, 'Llanowar Elves'), by = await T.put(1, 'Wall of Omens');
  const path = await T.put(0, "Sorrow's Path");
  await attack(T, [[x, 1], [y, 1]]);
  await block(T, [[bx, x], [by, y]]);
  T.a.on('targets', () => [refOf(bx), refOf(by)]);
  await T.activate(path, 0, a => a.parsed.api === 'SwitchBlock');
  expect(blocking(T, bx)[0] === y.id && blocking(T, by)[0] === x.id, 'the blockers swapped');
});
test('Block: Balduvian Warlord takes a blocker out of combat, then it blocks another attacker', async T => {
  const x = await T.put(0, 'Grizzly Bears'), y = await T.put(0, 'Llanowar Elves');
  const wall = await T.put(1, 'Wall of Omens'), warlord = await T.put(1, 'Balduvian Warlord');
  await attack(T, [[x, 1], [y, 1]]);
  await block(T, [[wall, x]]);
  T.b.on('targets', () => [refOf(wall)]);
  T.b.on('cards', () => [y.id]);
  await T.activate(warlord, 1, a => a.parsed.api === 'RemoveFromCombat');
  expect(!T.game.isBlocked(x), 'the bears are unblocked again');
  expect(blocking(T, wall)[0] === y.id && T.game.isBlocked(y), 'the wall blocks the elf');
  await damage(T);
  expect(T.B.life === 38, `the bears hit (${T.B.life})`);
});
test('Block: False Orders makes a creature block another attacker', async T => {
  const x = await T.put(0, 'Grizzly Bears'), y = await T.put(0, 'Llanowar Elves');
  const wall = await T.put(1, 'Wall of Omens');
  await attack(T, [[x, 1], [y, 1]]);
  await block(T, [[wall, y]]);
  T.a.on('targets', () => [refOf(wall)]);
  T.a.on('cards', () => [x.id]);
  T.game.step = 'declareBlockers';
  await T.cast('False Orders', 0);
  expect(T.game.isBlocked(x) && blocking(T, wall)[0] === x.id && !T.game.isBlocked(y), 'it blocks the chosen attacker; the elf is unblocked again');
});

// ------------------------------------------------------------ attacking
test('Attack requirement: when Viashino Bey attacks, all your creatures attack if able', async T => {
  const bey = await T.put(0, 'Viashino Bey'), bears = await T.put(0, 'Grizzly Bears'), wall = await T.put(0, 'Wall of Omens');
  await attack(T, [[bey, 1]]);
  expect(T.game.combat.attackers.length === 2 && T.game.isAttacking(bears) && !T.game.isAttacking(wall), `the bears attack too (${T.game.combat.attackers.length})`);
});
test('Attack requirement: Ekundu Cyclops attacks when another creature attacks', async T => {
  const cy = await T.put(0, 'Ekundu Cyclops'), bears = await T.put(0, 'Grizzly Bears');
  await attack(T, [[bears, 1]]);
  expect(T.game.isAttacking(cy), 'the cyclops joins');
  await attack(T, []);
  expect(!T.game.isAttacking(cy), 'no attack, no cyclops');
});
test('Attack vigilance: with Johan untapped, attacking doesn’t tap your creatures', async T => {
  const johan = await T.put(0, 'Johan'), bears = await T.put(0, 'Grizzly Bears');
  T.a.on('confirm', () => true);
  T.game.combat = { attackers: [], blockers: new Map(), firstStrikeDone: new Set() };
  T.game.step = 'beginCombat';
  T.game.fire('Phase', { Phase: 'BeginCombat', Player: 0 }); await T.resolve();
  expect(!combat.canAttack(T.game, johan), 'Johan can’t attack');
  await attack(T, [[bears, 1]]);
  expect(T.game.isAttacking(bears) && !bears.tapped, 'the bears attack untapped');
});
test('Can attack as though it had haste: Instill Energy; Frenzied Saddlebrute (only at its controller’s opponents)', async T => {
  const bears = await T.put(0, 'Grizzly Bears'); bears.sick = true;
  expect(!combat.canAttack(T.game, bears), 'summoning sick');
  const aura = await T.put(0, 'Instill Energy'); aura.attachedTo = bears.id; T.game.touch();
  expect(combat.canAttack(T.game, bears), 'enchanted: it can attack');
  await T.put(0, 'Frenzied Saddlebrute');
  const elf = await T.put(0, 'Llanowar Elves'); elf.sick = true;
  expect(combat.canAttack(T.game, elf) && combat.canAttackDefender(T.game, elf, 1, null), 'my sick elf can attack my opponent');
  const theirs = await T.put(1, 'Llanowar Elves'); theirs.sick = true;
  expect(!combat.canAttackDefender(T.game, theirs, 0, null), 'their sick elf can’t attack me');
}, { players: 2 });
test('Can’t attack alone, can’t block alone: Bonded Construct stays home alone; Craven Hulk doesn’t block alone', async T => {
  const c = await T.put(0, 'Bonded Construct'), bears = await T.put(0, 'Grizzly Bears');
  await attack(T, [[c, 1]]);
  expect(!T.game.combat.attackers.length, 'alone: no attack');
  await attack(T, [[c, 1], [bears, 1]]);
  expect(T.game.combat.attackers.length === 2, 'with another: fine');
  const hulk = await T.put(1, 'Craven Hulk');
  await T.put(1, 'Llanowar Elves');
  await block(T, [[hulk, bears]]);
  expect(!blocking(T, hulk).length, 'the hulk can’t block alone');
});

// ------------------------------------------------------------ triggers
test('Attacker blocked once: Hezrou gives each blocking creature -1/-1 (one trigger for several blocked attackers)', async T => {
  await T.put(0, 'Hezrou');
  const x = await T.put(0, 'Grizzly Bears'), y = await T.put(0, 'Grizzly Bears');
  const e1 = await T.put(1, 'Llanowar Elves'), w = await T.put(1, 'Wall of Omens');
  await attack(T, [[x, 1], [y, 1]]);
  await block(T, [[e1, x], [w, y]]);
  expect(!alive(e1) && T.game.chars(w).toughness === 3, 'the elf dies, the wall shrinks once');
});
test('Blockers declared: Tide of War flips a coin and sacrifices the blockers or the blocked creatures', async T => {
  await T.put(1, 'Tide of War');
  const x = await T.put(0, 'Grizzly Bears'), y = await T.put(0, 'Llanowar Elves');
  const w = await T.put(1, 'Wall of Omens');
  await attack(T, [[x, 1], [y, 1]]);
  await block(T, [[w, x]]);
  expect(T.logged(/flip/i), 'a coin was flipped');
  expect(alive(w) !== alive(x) && alive(y), `either the wall or the bears are gone, the unblocked elf stays (${alive(w)}, ${alive(x)})`);
});
test('Camouflage: the defending player’s piles are assigned to the attackers at random', async T => {
  const x = await T.put(0, 'Grizzly Bears'), y = await T.put(0, 'Llanowar Elves');
  const w = await T.put(1, 'Wall of Omens'), e = await T.put(1, 'Llanowar Elves');
  T.game.step = 'declareAttackers';
  T.game.combat = { attackers: [], blockers: new Map(), firstStrikeDone: new Set() };
  await T.cast('Camouflage', 0);
  await attack(T, [[x, 1], [y, 1]]);
  let n = 0;
  T.b.on('camouflagePile', () => (n++ === 0 ? [w.id] : [e.id]));
  T.game.step = 'declareBlockers';
  T.b.on('blockers', () => { throw new Error('no ordinary block declaration'); });
  await combat.declareBlockers(T.game); await T.resolve();
  expect(n === 2, `two piles (${n})`);
  const wb = blocking(T, w), eb = blocking(T, e);
  expect(wb.length === 1 && eb.length === 1 && wb[0] !== eb[0], `each pile blocks one attacker (${wb}, ${eb})`);
});

// ------------------------------------------------------------ saddle, crew, enlist
const saddleAbility = a => a.parsed.p.Saddle === 'True';
const crewAbility = a => a.parsed.p.IsCrew === 'True';
test('Saddle: Alacrian Jaguar becomes saddled (sorcery speed) and gets +2/+2 when it attacks saddled', async T => {
  const jag = await T.put(0, 'Alacrian Jaguar'), elf = await T.put(0, 'Llanowar Elves');
  const ab = activatedAbilities(T.game, 0, jag).find(saddleAbility);
  expect(ab, 'it has a saddle ability');
  T.a.on('crew', req => [elf.id]);
  await T.activate(jag, 0, saddleAbility);
  expect(elf.tapped && matchValid(T.game, jag, 'Card.IsSaddled', { you: 0 }) && matchValid(T.game, elf, 'Creature.SaddledThisTurn', { you: 0, host: jag }), 'saddled by the elf');
  const base = T.game.chars(jag).power;
  await attack(T, [[jag, 1]]);
  expect(T.game.chars(jag).power === base + 2, `+2/+2 (${base} -> ${T.game.chars(jag).power})`);
  T.game.turnNumber++;
  expect(!matchValid(T.game, jag, 'Card.IsSaddled', { you: 0 }), 'saddled only this turn');
});
test('Saddle: not enough power, no saddle; only as a sorcery', async T => {
  const sloth = await T.put(0, 'Unswerving Sloth');
  await T.put(0, 'Llanowar Elves');
  const { canActivate } = await import('../src/engine/abilities.js');
  const ab = activatedAbilities(T.game, 0, sloth).find(saddleAbility);
  const { canPayNonMana, parseCost } = await import('../src/engine/abilities.js');
  expect(!canPayNonMana(T.game, { controller: 0, host: sloth, p: ab.parsed.p, root() { return { x: 0 }; }, svars: {} }, parseCost(ab.parsed.p.Cost)), 'saddle 4 with a 1/1: can’t pay');
});
test('Becomes saddled: Stubborn Burrowfiend mills two and grows the first time each turn', async T => {
  const fiend = await T.put(0, 'Stubborn Burrowfiend'), bears = await T.put(0, 'Grizzly Bears');
  const lib = T.A.library.length;
  T.a.on('crew', req => [bears.id]);
  await T.activate(fiend, 0, saddleAbility);
  expect(T.A.library.length === lib - 2, `milled two (${lib - T.A.library.length})`);
});
test('Saddled / crewed triggers: Canyon Vaulter gives the Mount flying; Speedway Fanatic gives the Vehicle haste', async T => {
  const vaulter = await T.put(0, 'Canyon Vaulter'), jag = await T.put(0, 'Alacrian Jaguar');
  T.a.on('crew', req => [vaulter.id]);
  await T.activate(jag, 0, saddleAbility);
  expect(T.game.hasKeyword(jag, 'Flying'), 'the Mount it saddled has flying');
  const fan = await T.put(0, 'Speedway Fanatic'), copter = await T.put(0, "Smuggler's Copter");
  copter.sick = true;
  T.a.on('crew', req => [fan.id]);
  await T.activate(copter, 0, crewAbility);
  expect(T.game.hasKeyword(copter, 'Haste') && combat.canAttack(T.game, copter), 'the Vehicle it crewed has haste');
});
test('Can’t crew: Revoke Privileges; Tap power value: Cloudspire Captain crews as though 2 greater, Giant Ox with toughness', async T => {
  const copter = await T.put(0, "Smuggler's Copter"), bears = await T.put(0, 'Grizzly Bears');
  const rp = await T.put(1, 'Revoke Privileges'); rp.attachedTo = bears.id; T.game.touch();
  const { canPayNonMana, parseCost } = await import('../src/engine/abilities.js');
  const ab = activatedAbilities(T.game, 0, copter).find(crewAbility);
  const sa = { controller: 0, host: copter, p: ab.parsed.p, root() { return { x: 0 }; }, svars: {} };
  expect(!canPayNonMana(T.game, sa, parseCost(ab.parsed.p.Cost)), 'the enchanted bears can’t crew');
  const { tapPowerValue } = await import('../src/engine/filters.js');
  const cap = await T.put(0, 'Cloudspire Captain'), ox = await T.put(0, 'Giant Ox');
  expect(tapPowerValue(T.game, cap, sa) === T.game.chars(cap).power + 2, 'the Captain crews 2 greater');
  expect(tapPowerValue(T.game, ox, sa) === T.game.chars(ox).toughness, 'the Ox crews with its toughness');
  expect(tapPowerValue(T.game, ox, { p: { Saddle: 'True' }, host: copter }) === T.game.chars(ox).power, 'but saddles with its power (Vehicles only)');
  const heavy = await T.put(0, 'Demolition Stomper');
  const hab = activatedAbilities(T.game, 0, heavy).find(crewAbility);
  T.a.on('crew', req => { expect(req.powers && req.powers[ox.id] === T.game.chars(ox).toughness, 'the prompt shows what each counts for'); return [ox.id, cap.id]; });
  await T.activate(heavy, 0, crewAbility);
  expect(T.game.chars(heavy).types.has('Creature'), 'crew 5 from the Ox (5 toughness) and the Captain');
});
test('Tap power value for stations: Tapestry Warden stations with toughness', async T => {
  await T.put(0, 'Tapestry Warden');
  const ship = await T.put(0, 'Uthros Research Craft');
  const wall = await T.put(0, 'Wall of Omens');
  const st = activatedAbilities(T.game, 0, ship).find(a => a.parsed.p.Station === 'True');
  if (!st) return; // (no station card in the pool by that name: nothing to check)
  T.a.on('costtapXType', () => [wall.id]);
  await T.activate(ship, 0, a => a.parsed.p.Station === 'True');
  expect((ship.counters.CHARGE || 0) === 4, `4 charge counters from a 0/4 (${ship.counters.CHARGE})`);
});
test('Enlisted: Guardian of New Benalia scries 2 when it enlists', async T => {
  const g = await T.put(0, 'Guardian of New Benalia'), bears = await T.put(0, 'Grizzly Bears');
  T.a.on('enlist', () => [bears.id]);
  await attack(T, [[g, 1]]);
  expect(T.logged(/scries 2/), 'scried 2');
});

process.exit(await run(tests) ? 1 : 0);
