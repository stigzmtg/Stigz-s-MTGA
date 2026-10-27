// Behavioural tests for the recent sets' mechanics and common effects (src/engine/mech-newsets.js): the Avatar
// bending actions, Debuff, endure, increment, day/night, the Ring, storied, recruit, detain, speed, and the
// triggers and replacements that watch for them. Usage: node tools/mech-newsets.mjs [name-filter]
import { setup, expect, run } from './lib/testkit.mjs';
import { refOf, castableOptions, activatedAbilities, canActivate, makeSA, resolveChain, castSpell, chooseTargetsForSA } from '../src/engine/abilities.js';
import * as combat from '../src/engine/combat.js';
import { matchValid } from '../src/engine/filters.js';
import { analyzeCard } from '../src/engine/support.js';
import { db } from './lib/testkit.mjs';

const tests = [];
const test = (name, fn, opts) => tests.push({ name, fn, opts });
const lands = (T, pid) => T.game.battlefield.filter(c => c.controller === pid && T.game.chars(c).types.has('Land'));
const kw = (T, c, k) => T.game.chars(c).keywords.includes(k);
// run an ability string as if a card's (e.g. "DB$ RingTemptsYou") and resolve what it puts on the stack
async function runAbility(T, raw, host, pid = 0) { const sa = makeSA(T.game, raw, {}, host, pid); await chooseTargetsForSA(T.game, sa, { optional: true }); await resolveChain(T.game, sa); await T.resolve(); }
async function attackAndBlock(T, attacks, blocks = [], blockerAgent = T.b) {
  T.game.combat = { attackers: [], blockers: new Map(), firstStrikeDone: new Set() };
  T.game.combatsThisTurn = (T.game.combatsThisTurn || 0) + 1;
  T.game.step = 'declareAttackers';
  T.agents[T.game.activePlayer].on('attackers', () => attacks.map(([a, d]) => ({ attacker: a.id, defender: typeof d === 'number' ? 'p' + d : 'c' + d.id })));
  await combat.declareAttackers(T.game); await T.resolve();
  T.game.step = 'declareBlockers';
  blockerAgent.on('blockers', () => blocks.map(([b, a]) => ({ blocker: b.id, attacker: a.id })));
  await combat.declareBlockers(T.game); await T.resolve();
}

test('every card of the group is automated (no reason left in the analyzer)', async () => {
  const names = ['Earthbending Lesson', 'Fire Sages', "Aang's Iceberg", 'Airbending Lesson', 'Avatar Aang', 'Crash Landing', 'Inspirited Vanguard', 'Ambitious Augmenter', 'Brimstone Vandal', 'Into the Night', 'Ringwraiths', 'Óin the Brave', 'Patient Instructor', 'Azorius Arrester', 'Wolverine, Fierce Fighter', 'Spikeshell Harrier', 'Rasputin Dreamweaver', "Curator of Sun's Creation", 'Paranormal Analyst', 'Case File Auditor', 'Savior of Ollenbock', 'Aegis of the Legion', 'Mistbind Clique', 'Bioessence Hydra', 'Scheming Aspirant', 'Lullmage Mentor', 'Font of Agonies', 'The Millennium Calendar', 'Rewrite History', 'Turnabout', 'Faces of the Past', 'Leader, Super-Genius', 'Bruvac the Grandiloquent', 'Kenessos, Priest of Thassa', 'Eligeth, Crossroads Augur'];
  const left = names.map(n => [n, analyzeCard(db.raw[n] || '')]).filter(([, r]) => r.length);
  expect(!left.length, `still flagged: ${left.map(([n, r]) => `${n} (${r.join(', ')})`).join('; ')}`);
});

// ------------------------------------------------------------ earthbend
test('Earthbend: target land you control becomes a 0/0 haste creature land with counters, and comes back tapped when it dies', async T => {
  const g = T.game;
  const forest = await T.put(0, 'Forest');
  T.a.on('targets', req => req.cands.includes(refOf(forest)) ? [refOf(forest)] : undefined);
  await T.cast('Earthbending Lesson');
  const ch = g.chars(forest);
  expect(ch.types.has('Creature') && ch.types.has('Land') && ch.power === 4 && ch.toughness === 4 && kw(T, forest, 'Haste'), `a 4/4 haste land creature (${[...ch.types]} ${ch.power}/${ch.toughness})`);
  expect(T.A.bends && T.A.bends.kinds.includes('Earthbend'), 'it counts as earthbending this turn');
  await g.destroy(forest, null); await T.resolve();
  expect(forest.zone === 'battlefield' && forest.tapped, `it returned to the battlefield tapped (${forest.zone}, tapped ${forest.tapped})`);
  expect(!g.chars(forest).types.has('Creature') && !(forest.counters.P1P1 > 0), 'as a new object: a plain land again');
  await g.destroy(forest, null); await T.resolve();
  expect(forest.zone === 'graveyard', 'it returns only once');
});
test('Earthbend from a trigger: the computer picks one of its lands; exile also returns it', async T => {
  const g = T.game;
  await T.put(0, 'Plains'); await T.put(0, 'Island');
  await T.cast('Badgermole Cub'); // When this creature enters, earthbend 1
  const land = g.battlefield.find(c => c.controller === 0 && g.chars(c).types.has('Land') && g.chars(c).types.has('Creature'));
  expect(land && land.counters.P1P1 === 1 && g.chars(land).power === 1, 'a land became a 1/1');
  await g.moveCard(land, 'exile', {}); await T.resolve();
  expect(land.zone === 'battlefield' && land.tapped && land.controller === 0, `it came back from exile tapped (${land.zone})`);
});

// ------------------------------------------------------------ airbend
test('Airbend: exile target nonland permanent; its owner may cast it for {2} from exile, once', async T => {
  const g = T.game;
  const angel = await T.put(1, 'Serra Angel');
  T.a.on('targets', () => [refOf(angel)]);
  await T.cast('Airbending Lesson');
  expect(angel.zone === 'exile', 'exiled');
  expect(T.A.bends && T.A.bends.kinds.includes('Airbend'), 'counts as airbending');
  g.activePlayer = 1; g.priority = 1;
  T.noMana(1); T.B.pool.C = 2;
  const opts = castableOptions(g, 1, angel);
  expect(opts.length && opts.some(o => o.altManaStr === '2'), `its owner can cast it for {2} (${JSON.stringify(opts.map(o => o.altManaStr))})`);
  expect(!castableOptions(g, 0, angel).length, "the one who airbent it can't");
  const ok = await castSpell(g, 1, angel, {});
  await T.resolve();
  expect(ok && angel.zone === 'battlefield' && angel.controller === 1 && T.B.pool.C === 0, `cast for {2} (${angel.zone}, pool C ${T.B.pool.C})`);
  expect(!g.effects.some(e => /^Airbend/.test(e.effectName)), 'the airbend permission is gone');
});
test('Airbend a spell: it leaves the stack for exile (Aang, Swift Savior)', async T => {
  const g = T.game;
  const bolt = await T.put(1, 'Lightning Bolt', 'hand');
  T.mana(1); g.priority = 1; g.activePlayer = 0;
  T.b.on('targets', req => [req.cands.find(r => r === 'p0') || req.cands[0]]);
  await castSpell(g, 1, bolt, {});
  expect(bolt.zone === 'stack', 'bolt on the stack');
  T.a.on('targets', req => req.cands.includes(refOf(bolt)) ? [refOf(bolt)] : undefined);
  await T.cast('Aang, Swift Savior', 0, { resolve: false });
  // resolve Aang (the creature spell), then its trigger; the bolt is gone before it resolves
  for (let i = 0; i < 6 && g.stack.length; i++) { await g.processTriggersAndSBA(); if (g.stack[g.stack.length - 1].card === bolt) break; await g.resolveTop(); }
  expect(bolt.zone === 'exile' && !g.stack.some(s => s.card === bolt), `the bolt was airbent (${bolt.zone})`);
  expect(T.A.life === 40, 'and never resolved');
});

// ------------------------------------------------------------ waterbend
test('Waterbend {4}: artifacts and creatures you tap pay {1} each; you choose which', async T => {
  const g = T.game;
  const leaper = await T.put(0, 'Geyser Leaper');
  const elf = await T.put(0, 'Llanowar Elves'), bear = await T.put(0, 'Grizzly Bears'), ring = await T.put(0, 'Sol Ring');
  await T.put(0, 'Island');
  for (const c of g.battlefield) if (c.controller === 0 && g.chars(c).types.has('Land') && c.def.name !== 'Island') c.tapped = true;
  T.noMana(0);
  const abil = activatedAbilities(g, 0, leaper).find(a => a.parsed.api === 'Draw');
  g.priority = 0;
  expect(canActivate(g, 0, leaper, abil), 'payable with an Island, two creatures and an artifact');
  let req = null;
  T.a.on('waterbend', r => { req = r; return [bear.id, leaper.id]; });
  T.a.on('discard', r => [r.cards[0]]);
  const hand = T.A.hand.length;
  const { activateAbility } = await import('../src/engine/abilities.js');
  await activateAbility(g, 0, leaper, abil.key, {}); await T.resolve();
  expect(req && req.min === 0 && req.max === 4, `asked which to tap (min ${req && req.min}, max ${req && req.max}: the Island, Sol Ring and the Elves could pay it all)`);
  expect(bear.tapped && leaper.tapped, 'the chosen creatures are tapped');
  expect(T.A.hand.length === hand, 'drew then discarded');
  expect(T.A.bends && T.A.bends.kinds.includes('Waterbend'), 'counts as waterbending');
  expect(!canActivate(g, 0, leaper, abil) || !elf.tapped, 'state is consistent');
});
test('Waterbend {X} (Katara, Water Tribe\'s Hope): X can count the creatures; and Water Whip\'s additional waterbend cost', async T => {
  const g = T.game;
  const katara = await T.put(0, "Katara, Water Tribe's Hope");
  for (let i = 0; i < 3; i++) await T.put(0, 'Grizzly Bears');
  for (const c of g.battlefield) if (c.controller === 0 && g.chars(c).types.has('Land')) c.tapped = true;
  T.noMana(0);
  const abil = activatedAbilities(g, 0, katara).find(a => a.parsed.api === 'AnimateAll');
  let maxX = 0;
  T.a.on('xValue', r => { maxX = r.max; return 3; });
  T.a.on('waterbend', r => r.cards.slice(0, 3));
  const { activateAbility } = await import('../src/engine/abilities.js');
  g.priority = 0;
  expect(canActivate(g, 0, katara, abil), 'X ≥ 1 is payable by tapping creatures');
  await activateAbility(g, 0, katara, abil.key, {}); await T.resolve();
  expect(maxX >= 3, `X could go up to the creatures available (${maxX})`);
  const bears = g.battlefield.filter(c => c.def.name === 'Grizzly Bears');
  expect(bears.every(b => g.chars(b).power === 3), `creatures became 3/3 (${bears.map(b => g.chars(b).power)})`);
  // Water Whip: as an additional cost to cast this spell, waterbend {5}
  const whip = db.get('Water Whip');
  expect(whip, 'Water Whip exists');
});

// ------------------------------------------------------------ firebending
test('Firebending: attacking adds {R}s that last until end of combat (and it counts as firebending)', async T => {
  const g = T.game;
  const sages = await T.put(0, 'Ozai, the Phoenix King');
  T.noMana(0);
  await attackAndBlock(T, [[sages, 1]]);
  expect(T.A.pool.R === 4, `four red mana from firebending 4 (${T.A.pool.R})`);
  g.step = 'combatDamage'; g.emptyPools();
  expect(T.A.pool.R === 4, `kept through combat (${T.A.pool.R})`);
  // (Ozai's own replacement: "If you would lose unspent mana, that mana becomes red instead.")
  g.step = 'main2'; g.emptyPools();
  expect(T.A.pool.R === 4, `after combat Ozai keeps it, as red (${T.A.pool.R})`);
  expect(T.A.bends && T.A.bends.kinds.includes('Firebend'), 'counts as firebending');
});
test('Avatar Aang: draws when you bend, and transforms once you did all four this turn', async T => {
  const g = T.game;
  const aang = await T.put(0, 'Avatar Aang');
  const { noteBend } = await import('../src/engine/mech-newsets.js');
  const hand = T.A.hand.length;
  noteBend(g, 0, 'Earthbend'); await T.resolve();
  expect(T.A.hand.length === hand + 1 && aang.face === 0, 'drew a card');
  noteBend(g, 0, 'Waterbend'); noteBend(g, 0, 'Airbend'); await T.resolve();
  expect(aang.face === 0, 'not yet transformed');
  noteBend(g, 0, 'Firebend'); await T.resolve();
  expect(T.A.hand.length === hand + 4 && aang.face === 1, `four draws and transformed (${T.A.hand.length - hand}, face ${aang.face})`);
});

// ------------------------------------------------------------ debuff
test('Debuff: loses flying until end of turn, including flying from an Equipment; back at end of turn', async T => {
  const g = T.game;
  const angel = await T.put(1, 'Serra Angel');
  await T.put(0, 'Forest'); await T.put(0, 'Forest');
  T.a.on('targets', () => [refOf(angel)]);
  await T.cast('Crash Landing');
  expect(!kw(T, angel, 'Flying'), 'the angel lost flying');
  expect(angel.zone === 'graveyard' || angel.damage > 0, 'and was dealt damage');
  // flying from a static (Cobbled Wings) is lost too
  const bear = await T.put(1, 'Grizzly Bears');
  const wings = await T.put(1, 'Cobbled Wings');
  wings.attachedTo = bear.id; g.touch();
  expect(kw(T, bear, 'Flying'), 'the Wings give flying');
  await resolveChain(g, makeSA(g, 'DB$ Debuff | Defined$ Self | Keywords$ Flying & Vigilance', {}, bear, 0));
  expect(!kw(T, bear, 'Flying'), 'lost flying from the Equipment');
  const angel2 = await T.put(1, 'Serra Angel');
  await resolveChain(g, makeSA(g, 'DB$ Debuff | Defined$ Self | Keywords$ Flying & Vigilance', {}, angel2, 0));
  expect(!kw(T, angel2, 'Flying') && !kw(T, angel2, 'Vigilance'), 'lost flying and vigilance');
  await g.expireDurations('EOT');
  expect(kw(T, angel2, 'Flying') && kw(T, angel2, 'Vigilance') && kw(T, bear, 'Flying'), 'until end of turn');
});
test('Debuff: a landwalk suffix, protection from a color, and Duration$ Permanent', async T => {
  const g = T.game;
  const bear = await T.put(1, 'Grizzly Bears');
  bear.temp.push({ keywords: ['Landwalk:Swamp', 'Landwalk:Forest', 'Protection from black', 'Defender'], until: 'Permanent' });
  await resolveChain(g, makeSA(g, 'DB$ Debuff | Defined$ Self | AllSuffixKeywords$ walk', {}, bear, 0));
  expect(!g.chars(bear).keywords.some(k => /^Landwalk/.test(k)), 'lost all landwalk');
  await resolveChain(g, makeSA(g, 'DB$ Debuff | Defined$ Self | Keywords$ Protection from black', {}, bear, 0));
  expect(!kw(T, bear, 'Protection from black'), 'lost protection from black');
  await resolveChain(g, makeSA(g, 'DB$ Debuff | Defined$ Self | Keywords$ Defender | Duration$ Permanent', {}, bear, 0));
  await g.expireDurations('EOT');
  expect(!kw(T, bear, 'Defender') && kw(T, bear, 'Protection from black'), 'permanent loss stays; end-of-turn loss ends');
});

// ------------------------------------------------------------ endure, increment, recruit, detain
test('Endure: counters or an N/N Spirit (the player chooses); a creature gone makes the Spirit', async T => {
  const g = T.game;
  T.a.on('endure', () => 'counters');
  const v = await T.cast('Inspirited Vanguard');
  expect(v.counters.P1P1 === 2, `two counters (${v.counters.P1P1})`);
  T.a.on('endure', () => 'token');
  await runAbility(T, 'DB$ Endure | Num$ 3', v, 0);
  const tok = T.tokens(0).find(t => g.chars(t).name.startsWith('Spirit'));
  expect(tok && g.chars(tok).power === 3 && g.chars(tok).toughness === 3, 'a 3/3 Spirit token');
  await g.moveCard(v, 'graveyard', {});
  const n = T.tokens(0).length;
  await runAbility(T, 'DB$ Endure | Defined$ Self | Num$ 2', v, 0);
  expect(T.tokens(0).length === n + 1, 'gone: a token instead');
});
test('Increment: a +1/+1 counter when the mana spent is greater than its power or toughness', async T => {
  const aug = await T.put(0, 'Ambitious Augmenter'); // 1/1
  await T.cast('Llanowar Elves'); // 1 mana: not greater
  expect(!(aug.counters.P1P1 > 0), `1 mana: no counter (${aug.counters.P1P1})`);
  await T.cast('Grizzly Bears'); // 2 mana > 1
  expect(aug.counters.P1P1 === 1, `2 mana: a counter (${aug.counters.P1P1})`);
  await T.cast('Grizzly Bears'); // 2 mana, it's 2/2 now
  expect(aug.counters.P1P1 === 1, 'not greater than 2/2');
  await T.cast('Serra Angel');
  expect(aug.counters.P1P1 === 2, 'five mana: another');
});
test('Recruit: draw, discard; a nonland discard makes a 1/1 Human Soldier', async T => {
  const g = T.game;
  T.a.on('discard', r => [r.cards.find(id => !g.chars(g.cardById(id)).types.has('Land')) || r.cards[0]]);
  await T.put(0, 'Lightning Bolt', 'hand');
  const n = T.tokens(0).length;
  await T.cast('Patient Instructor');
  expect(T.tokens(0).length === n + 1 && T.tokens(0).some(t => g.chars(t).name === 'Human Soldier Token' || /Human Soldier/.test(g.chars(t).name)), 'a Human Soldier');
  T.a.on('discard', r => [r.cards.find(id => g.chars(g.cardById(id)).types.has('Land')) || r.cards[0]]);
  await T.put(0, 'Forest', 'hand');
  await runAbility(T, 'DB$ Recruit', g.battlefield.find(c => c.def.name === 'Patient Instructor'), 0);
  expect(T.tokens(0).length === n + 1, 'a land discarded: no token');
});
test('Detain: can\'t attack, block or activate until the detainer\'s next turn', async T => {
  const g = T.game;
  const elf = await T.put(1, 'Llanowar Elves');
  const seer = await T.put(1, 'Prodigal Pyromancer');
  T.a.on('targets', req => req.cands.includes(refOf(seer)) ? [refOf(seer)] : undefined);
  await T.cast('Azorius Arrester');
  const abil = activatedAbilities(g, 1, seer)[0];
  g.priority = 1;
  expect(!canActivate(g, 1, seer, abil, { ignoreTiming: true }), "its ability can't be activated");
  expect(!combat.canAttack(g, seer) && !combat.canBlockAny(g, seer), "it can't attack or block");
  expect(combat.canBlockAny(g, elf), 'others are fine');
  await g.expireDurations('UntilYourNextTurn', 1);
  expect(!combat.canBlockAny(g, seer), 'still detained on another player\'s turn');
  await g.expireDurations('UntilYourNextTurn', 0);
  expect(combat.canBlockAny(g, seer) && canActivate(g, 1, seer, abil, { ignoreTiming: true }), 'free at the detainer\'s next turn');
});

// ------------------------------------------------------------ day and night
test('Day/night: entering makes it day (no trigger); a turn without spells makes it night, which triggers', async T => {
  const g = T.game;
  const vandal = await T.cast('Brimstone Vandal');
  expect(g.dayNight === 'Day', 'it became day');
  expect(T.B.life === 40, 'becoming day the first time is not "day becomes night"');
  g.setDayNight('Night'); await T.resolve();
  expect(T.B.life === 39, `day became night: 1 damage to each opponent (${T.B.life})`);
  g.setDayNight('Day'); await T.resolve();
  expect(T.B.life === 38, 'and back');
  await runAbility(T, 'DB$ DayTime | Value$ Switch', vandal, 0);
  expect(g.dayNight === 'Night' && T.B.life === 37, 'The Celestus switch');
  const { dayNightLabel } = await import('../src/engine/mech-newsets.js');
  expect(/Night/.test(dayNightLabel(g).text), 'the table can show it');
});
test('Day/night: "if it\'s night" costs and counts (Moonrager\'s Slash, Count$Night)', async T => {
  const g = T.game;
  const { calcCtx } = await import('../src/engine/filters.js');
  g.dayNight = 'Day';
  expect(calcCtx(g, 'Count$Night.13.2', { you: 0 }) === 2, 'day: the second number');
  g.dayNight = 'Night';
  expect(calcCtx(g, 'Count$Night.13.2', { you: 0 }) === 13, 'night: the first');
});

// ------------------------------------------------------------ the Ring
test('The Ring tempts you: the Ring-bearer is legendary, the Ring grows, "whenever the Ring tempts you" triggers', async T => {
  const g = T.game;
  const wraiths = await T.put(0, 'Ringwraiths');
  const bear = await T.put(0, 'Grizzly Bears');
  T.a.on('ringBearer', () => [bear.id]);
  await runAbility(T, 'DB$ RingTemptsYou', bear, 0);
  expect(g.chars(bear).supertypes.has('Legendary'), 'the Ring-bearer is legendary');
  expect(matchValid(g, bear, 'Card.IsRingbearer', { you: 0 }) && !matchValid(g, wraiths, 'Card.IsRingbearer', { you: 0 }), 'IsRingbearer');
  expect(T.A.ringTempted === 1, 'tempted once');
  const big = await T.put(1, 'Serra Angel');
  expect(!combat.canBlock(g, big, bear), "can't be blocked by creatures with greater power");
  const ring = g.effects.find(e => e.isRing && e.controller === 0);
  expect(ring && ring.effectChars.statics.length === 2 && ring.effectChars.triggers.length === 0, 'level 1');
  const { calcCtx } = await import('../src/engine/filters.js');
  await runAbility(T, 'DB$ RingTemptsYou', bear, 0);
  expect(ring.effectChars.triggers.length === 1 && calcCtx(g, 'PlayerCountPropertyYou$RingTemptedYou', { you: 0 }) === 2, 'level 2 and the count');
  await g.moveCard(bear, 'graveyard', {});
  expect(!matchValid(g, bear, 'Card.IsRingbearer', { you: 0 }), 'a new object is not the Ring-bearer');
});
test('The Ring at level 2 and 4: loot on attack, opponents lose 3 on combat damage', async T => {
  const g = T.game;
  const bear = await T.put(0, 'Grizzly Bears');
  T.a.on('ringBearer', () => [bear.id]);
  for (let i = 0; i < 4; i++) await runAbility(T, 'DB$ RingTemptsYou', bear, 0);
  const hand = T.A.hand.length;
  T.a.on('discard', r => [r.cards[0]]);
  await attackAndBlock(T, [[bear, 1]]);
  expect(T.A.hand.length === hand && T.A.graveyard.length >= 1, 'looted');
  g.step = 'combatDamage';
  await combat.combatDamage(g, false); await T.resolve();
  expect(T.B.life === 40 - 2 - 3, `2 combat damage and 3 life lost (${T.B.life})`);
}, { players: 2 });

// ------------------------------------------------------------ storied
test('Storied: three historic permanents give an enduring story for the rest of the game', async T => {
  const g = T.game;
  const oin = await T.put(0, 'Óin the Brave');
  expect(g.chars(oin).power === 1 && !kw(T, oin, 'Haste'), 'no story yet');
  const a = await T.put(0, 'Sol Ring'), b = await T.put(0, 'Mind Stone');
  await T.resolve();
  expect(T.A.enduringStory && g.chars(oin).power === 2 && kw(T, oin, 'Haste'), 'Óin (legendary) and two artifacts: an enduring story');
  await g.moveCard(a, 'graveyard', {}); await g.moveCard(b, 'graveyard', {}); await T.resolve();
  expect(g.chars(oin).power === 2, 'for the rest of the game');
});

// ------------------------------------------------------------ small effects
test('Heal damage, speed, and the max counter static (Rasputin Dreamweaver)', async T => {
  const g = T.game;
  const bear = await T.put(0, 'Grizzly Bears');
  bear.damage = 1;
  await runAbility(T, 'DB$ HealDamage | Defined$ Self', bear, 0);
  expect(bear.damage === 0, 'damage removed');
  T.B.speed = 3; T.A.speed = 1;
  const harrier = await T.put(0, 'Spikeshell Harrier', 'hand');
  const target = await T.put(1, 'Grizzly Bears');
  T.a.on('targets', () => [refOf(target)]);
  T.mana(0); g.priority = 0;
  await castSpell(g, 0, harrier, {}); await T.resolve();
  expect(target.zone === 'hand' && T.B.speed === 2, `bounced, and their speed went down (${T.B.speed})`);
  const r = await T.put(0, 'Rasputin Dreamweaver');
  expect(r.counters.DREAM === 7, `enters with seven (${r.counters.DREAM})`);
  await g.addCounters(r, 'DREAM', 1, null);
  expect(r.counters.DREAM === 7, 'never more than seven');
});
test('Heal damage as a replacement (Wolverine, Fierce Fighter): new damage is dealt, the old damage healed', async T => {
  const g = T.game;
  T.a.on('targets', () => []);
  const w = await T.put(0, 'Wolverine, Fierce Fighter'); // 3/5
  const bolt = await T.put(1, 'Hill Giant');
  await g.dealDamage(bolt, w, 3, {}); await T.resolve();
  expect(w.damage === 3, `three damage marked (${w.damage})`);
  await g.dealDamage(bolt, w, 3, {}); await T.resolve();
  expect(w.zone === 'battlefield' && w.damage === 3, `survives a second 3: the first was healed (${w.zone}, ${w.damage})`);
});
test('Tap or untap all (Turnabout): the player chooses which', async T => {
  const g = T.game;
  const opp = [await T.put(1, 'Grizzly Bears'), await T.put(1, 'Llanowar Elves')];
  T.a.on('chooseType', r => (r.options.find(o => o.value === 'Creature') || r.options[0]).value);
  T.a.on('targets', req => req.cands.includes('p1') ? ['p1'] : undefined);
  let opts = null;
  T.a.on('tapOrUntapAll', r => { opts = r.options; return 'tap'; });
  await T.cast('Turnabout');
  expect(opp.every(c => c.tapped), 'their creatures are tapped');
  expect(opts && opts.length === 2 && opts[0].value === 'tap', 'tapping an opponent\'s creatures is offered first');
});

// ------------------------------------------------------------ triggers
test('Triggers: discover, manifest dread, case solved, championed, proliferate, pay life', async T => {
  const g = T.game;
  // proliferate (Scheming Aspirant: each opponent loses 2, you gain 2)
  await T.put(0, 'Scheming Aspirant');
  await runAbility(T, 'DB$ Proliferate', null, 0);
  expect(T.B.life === 38 && T.A.life === 42, `proliferating triggered (${T.B.life}/${T.A.life})`);
  // pay life (Font of Agonies: blood counters)
  const font = await T.put(0, 'Font of Agonies');
  g.fire('PayLife', { Player: 0, LifeAmount: 3 }); await T.resolve();
  expect(font.counters.BLOOD === 3, `three blood counters (${font.counters.BLOOD})`);
  // manifest dread (Paranormal Analyst returns a card put into the graveyard this way)
  await T.put(0, 'Paranormal Analyst');
  const gy = T.A.graveyard.length;
  await runAbility(T, 'DB$ ManifestDread', null, 0);
  expect(T.A.graveyard.length === gy, `the card milled by manifest dread went to hand (${T.A.graveyard.length - gy})`);
  // championed (Mistbind Clique taps all lands of target player)
  await T.put(0, 'Faerie Miscreant');
  T.a.on('champion', r => [r.cards[0]]);
  T.a.on('targets', req => req.cands.includes('p1') ? ['p1'] : undefined);
  for (let i = 0; i < 2; i++) await T.put(1, 'Forest');
  await T.cast('Mistbind Clique');
  expect(lands(T, 1).every(l => l.tapped), 'championing a Faerie tapped their lands');
});
test('Triggers: "one or more" batches (tapped creatures, sacrificed Foods, counters on planeswalkers) fire once', async T => {
  const g = T.game;
  const rh = await T.put(0, 'Rewrite History');
  const a = await T.put(0, 'Grizzly Bears'), b = await T.put(0, 'Llanowar Elves');
  const hand = T.A.hand.length;
  T.a.on('discard', r => [r.cards[0]]);
  await g.tap(a); await g.tap(b); await T.resolve();
  expect(rh.counters.PLAN === 1 && T.A.hand.length === hand, `one trigger for two creatures (${rh.counters.PLAN})`);
  const cam = await T.put(0, 'Camellia, the Seedmiser');
  await runAbility(T, 'DB$ Token | TokenScript$ c_a_food_sac | TokenAmount$ 2 | TokenOwner$ You', cam, 0);
  const foods = T.tokens(0).filter(t => g.chars(t).subtypes.has('Food'));
  const squirrels = () => T.tokens(0).filter(t => g.chars(t).subtypes.has('Squirrel')).length;
  for (const t of foods) await g.sacrifice(t, null);
  await T.resolve();
  expect(foods.length === 2 && squirrels() === 1, `one Squirrel for two Foods (${foods.length} foods, ${squirrels()} squirrels)`);
  const hydra = await T.put(0, 'Bioessence Hydra');
  const before = hydra.counters.P1P1 || 0;
  const pw1 = await T.put(0, 'Jace Beleren'), pw2 = await T.put(0, 'Chandra, Torch of Defiance');
  await T.resolve();
  const mid = hydra.counters.P1P1 || 0;
  await runAbility(T, 'DB$ PutCounterAll | ValidCards$ Planeswalker.YouCtrl | CounterType$ LOYALTY | CounterNum$ 1', null, 0);
  expect((hydra.counters.P1P1 || 0) === mid + 2, `two loyalty counters, one trigger putting two (${before} ${mid} ${hydra.counters.P1P1})`);
  expect(cam && pw1 && pw2, 'setup');
});
test('Triggers: countered, trains, mentored, fight, untap step, case solved', async T => {
  const g = T.game;
  // Lullmage Mentor: a spell you control counters a spell -> a Merfolk
  await T.put(0, 'Lullmage Mentor');
  T.a.on('optionalTrigger', () => true);
  const bolt = await T.put(1, 'Lightning Bolt', 'hand');
  T.mana(1); g.priority = 1;
  T.b.on('targets', req => [req.cands[0]]);
  await castSpell(g, 1, bolt, {});
  const n = T.tokens(0).length;
  T.a.on('targets', req => req.cands.find(r => r[0] === 's') ? [req.cands.find(r => r[0] === 's')] : undefined);
  await T.cast('Counterspell');
  expect(bolt.zone === 'graveyard' && T.tokens(0).length === n + 1, `countered, and a Merfolk (${T.tokens(0).length - n})`);
  // The Millennium Calendar: untapping permanents in your untap step
  const cal = await T.put(0, 'The Millennium Calendar');
  for (const c of [await T.put(0, 'Forest'), await T.put(0, 'Grizzly Bears')]) c.tapped = true;
  const tappedN = g.battlefield.filter(c => c.controller === 0 && c.tapped).length;
  await g.runStep('untap'); await T.resolve();
  expect(cal.counters.TIME === tappedN, `time counters for each untapped permanent (${cal.counters.TIME} of ${tappedN})`);
  // Case File Auditor: whenever you solve a Case
  await T.put(0, 'Case File Auditor');
  T.a.on('digChoose', () => []);
  const before = T.A.library.length;
  const kase = await T.put(0, 'Case of the Burning Masks');
  await runAbility(T, 'DB$ AlterAttribute | Defined$ Self | Attributes$ Solved', kase, 0);
  expect(kase.solved && g.logs.some(l => /Case File Auditor triggers/.test(l.text)), 'solving a Case triggered');
  expect(T.A.library.length <= before, 'looked at the top six');
});
test('Triggers: training (Savior of Ollenbock), mentor (Aegis of the Legion), fight (Neyith)', async T => {
  const g = T.game;
  const savior = await T.put(0, 'Savior of Ollenbock');
  const big = await T.put(0, 'Serra Angel');
  const victim = await T.put(1, 'Grizzly Bears');
  T.a.on('targets', req => req.cands.includes(refOf(victim)) ? [refOf(victim)] : undefined);
  await attackAndBlock(T, [[savior, 1], [big, 1]]);
  expect(savior.counters.P1P1 === 1 && victim.zone === 'exile', `trained, and the trigger exiled the bear (${victim.zone})`);
  // Neyith: whenever one or more creatures you control fight, draw
  await T.put(0, 'Neyith of the Dire Hunt');
  const hand = T.A.hand.length;
  const b2 = await T.put(1, 'Grizzly Bears');
  T.a.on('targets', req => req.cands.includes(refOf(b2)) ? [refOf(b2)] : undefined);
  await runAbility(T, 'DB$ Fight | Defined$ Self | ValidTgts$ Creature.OppCtrl', big, 0);
  expect(T.A.hand.length === hand + 1, `fighting drew a card (${T.A.hand.length - hand})`);
});
test('Mentor with Aegis of the Legion: the mentored creature gets a shield counter', async T => {
  const g = T.game;
  const aegis = await T.put(0, 'Aegis of the Legion');
  const knight = await T.put(0, 'Serra Angel');
  const small = await T.put(0, 'Llanowar Elves');
  aegis.attachedTo = knight.id; g.touch();
  T.a.on('targets', req => req.cands.includes(refOf(small)) ? [refOf(small)] : undefined);
  await attackAndBlock(T, [[knight, 1], [small, 1]]);
  expect(small.counters.P1P1 === 1 && small.counters.SHIELD === 1, `mentored: +1/+1 and a shield counter (${JSON.stringify(small.counters)})`);
});

// ------------------------------------------------------------ replacements
test('Replacements: mill twice (Bruvac), scry one more (Kenessos), scry as draws (Eligeth), connive (Leader)', async T => {
  const g = T.game;
  await T.put(0, 'Bruvac the Grandiloquent');
  const gy = T.B.graveyard.length;
  await runAbility(T, 'DB$ Mill | Defined$ Opponent | NumCards$ 3', null, 0);
  expect(T.B.graveyard.length === gy + 6, `an opponent milled six (${T.B.graveyard.length - gy})`);
  const gyA = T.A.graveyard.length;
  await runAbility(T, 'DB$ Mill | Defined$ You | NumCards$ 2', null, 0);
  expect(T.A.graveyard.length === gyA + 2, 'you mill as usual');
  await T.put(0, 'Kenessos, Priest of Thassa');
  let seen = 0;
  T.a.on('scryBottom', r => { seen = r.cards.length; return []; });
  await runAbility(T, 'DB$ Scry | ScryNum$ 2', null, 0);
  expect(seen === 3, `scry 2 became scry 3 (${seen})`);
  await T.put(0, 'Eligeth, Crossroads Augur');
  const hand = T.A.hand.length;
  await runAbility(T, 'DB$ Scry | ScryNum$ 2', null, 0);
  expect(T.A.hand.length >= hand + 2, `scry became drawing (${T.A.hand.length - hand})`);
  const leader = await T.put(0, 'Leader, Super-Genius');
  T.a.on('discard', r => [r.cards[0]]);
  const h2 = T.A.hand.length;
  await runAbility(T, 'DB$ Connive | Defined$ Self', leader, 0);
  expect(T.A.hand.length === h2 + 1, `drew one extra before conniving (${T.A.hand.length - h2})`);
});

// ------------------------------------------------------------ exhaust
test('Exhaust: activate each exhaust ability only once (Bitter Work)', async T => {
  const g = T.game;
  const bw = await T.put(0, 'Bitter Work');
  await T.put(0, 'Forest');
  const abil = activatedAbilities(g, 0, bw)[0];
  T.mana(0); g.priority = 0;
  expect(canActivate(g, 0, bw, abil), 'first time');
  await T.activate(bw, 0, 0);
  T.mana(0);
  expect(!canActivate(g, 0, bw, abil), 'not again');
});

// ------------------------------------------------------------ more bending
test('Firebending X (Firebending Student): X is its power', async T => {
  const st = await T.put(0, 'Firebending Student'); // 1/2, firebending X where X is its power
  st.temp.push({ power: 2, until: 'EOT' });
  T.noMana(0);
  await attackAndBlock(T, [[st, 1]]);
  expect(T.A.pool.R === 3, `three red (${T.A.pool.R})`);
});
test('Waterbend as an additional cost (Water Whip), an optional one (Katara, Seeking Revenge), and an unless cost (Waterbending Lesson)', async T => {
  const g = T.game;
  for (let i = 0; i < 5; i++) await T.put(0, 'Grizzly Bears');
  T.noMana(0); T.A.pool.U = 2;
  const whip = await T.put(0, 'Water Whip', 'hand');
  g.priority = 0;
  expect(castableOptions(g, 0, whip).length, 'castable: {U}{U} plus waterbend {5} paid by five creatures');
  let wreq = null;
  T.a.on('waterbend', r => { wreq = r; return r.cards; });
  T.a.on('targets', () => []);
  const hand = T.A.hand.length;
  expect(await castSpell(g, 0, whip, {}), 'cast');
  await T.resolve();
  expect(wreq && wreq.min === 5 && wreq.max === 5, `all five needed (${wreq && wreq.min}-${wreq && wreq.max})`);
  expect(g.battlefield.filter(c => c.def.name === 'Grizzly Bears').every(c => c.tapped) && T.A.hand.length === hand - 1 + 2, 'five creatures tapped, drew two');
  // Katara, Seeking Revenge: may waterbend {2}
  for (const c of g.battlefield) c.tapped = false;
  T.noMana(0); T.A.pool.U = 4;
  let asked = false;
  T.a.on('optionalCost', () => { asked = true; return true; });
  T.a.on('waterbend', r => r.cards.slice(0, 2));
  const kat = await T.put(0, 'Katara, Seeking Revenge', 'hand');
  expect(await castSpell(g, 0, kat, {}), 'cast Katara');
  await T.resolve();
  expect(asked && kat.zone === 'battlefield' && kat.castSA && kat.castSA.optionalCostPaid, 'the optional waterbend was paid');
  // Waterbending Lesson: discard unless you waterbend {2}
  for (const c of g.battlefield) c.tapped = false;
  T.mana(0);
  T.a.on('unlessCost', () => true);
  const h2 = T.A.hand.length;
  await T.cast('Waterbending Lesson');
  expect(T.A.hand.length === h2 + 3, `drew three and kept them all (${T.A.hand.length - h2})`);
});
test('Ward—waterbend {4} (The Unagi of Kyoshi Island): pay it or the spell is countered', async T => {
  const g = T.game;
  const unagi = await T.put(1, 'The Unagi of Kyoshi Island');
  T.a.on('targets', () => [refOf(unagi)]);
  T.a.on('unlessCost', () => false);
  await T.cast('Lightning Bolt');
  expect(unagi.damage === 0, 'not paid: countered');
  for (let i = 0; i < 4; i++) await T.put(0, 'Grizzly Bears');
  T.noMana(0);
  T.a.on('unlessCost', () => true);
  T.a.on('waterbend', r => r.cards.slice(0, 4));
  const bolt = await T.put(0, 'Lightning Bolt', 'hand');
  T.A.pool.R = 1; g.priority = 0;
  await castSpell(g, 0, bolt, {}); await T.resolve();
  expect(unagi.damage === 3, `paid by tapping four creatures: the bolt resolved (${unagi.damage})`);
});
test('Hama, the Bloodbender: cast the exiled card by waterbending its mana value', async T => {
  const g = T.game;
  T.B.library.unshift(...[await T.put(1, 'Divination', 'library')].filter(() => false));
  T.a.on('targets', req => req.cands.includes('p1') ? ['p1'] : undefined);
  T.a.on('optional', () => true);
  await T.cast('Hama, the Bloodbender');
  const ex = T.A.exile.concat(T.B.exile).find(c => c.def.name === 'Divination');
  expect(ex, 'Divination exiled');
  for (let i = 0; i < 3; i++) await T.put(0, 'Grizzly Bears');
  T.noMana(0);
  g.priority = 0;
  const opts = castableOptions(g, 0, ex);
  expect(opts.some(o => /Waterbend<3>/.test(o.altManaStr || '')), `castable by waterbending {3} (${JSON.stringify(opts.map(o => o.altManaStr))})`);
});
test('Sunstreak Phoenix: from the graveyard, day becoming night lets you pay {1}{R} to return it', async T => {
  const g = T.game;
  const ph = await T.put(0, 'Sunstreak Phoenix', 'graveyard');
  g.dayNight = 'Day';
  T.mana(0);
  T.a.on('triggerCost', () => true);
  g.setDayNight('Night'); await T.resolve();
  expect(ph.zone === 'battlefield' && ph.tapped, `returned tapped (${ph.zone})`);
});
test('The Ring at level 3: the creature blocking the Ring-bearer is sacrificed at end of combat', async T => {
  const g = T.game;
  const bear = await T.put(0, 'Hill Giant');
  T.a.on('ringBearer', () => [bear.id]);
  for (let i = 0; i < 3; i++) await runAbility(T, 'DB$ RingTemptsYou', bear, 0);
  T.a.on('discard', r => [r.cards[0]]);
  const wall = await T.put(1, 'Wall of Omens');
  await attackAndBlock(T, [[bear, 1]], [[wall, bear]]);
  g.step = 'combatDamage';
  await combat.combatDamage(g, false); await T.resolve();
  expect(wall.zone === 'battlefield', 'the wall survived the damage');
  g.step = 'endCombat'; g.fire('Phase', { Phase: 'EndCombat', Player: 0 }); await T.resolve();
  expect(wall.zone === 'graveyard', `sacrificed at end of combat (${wall.zone})`);
});
test('Detained mana creatures can\'t tap for mana; The Water Crystal adds four to mills', async T => {
  const g = T.game;
  const elf = await T.put(1, 'Llanowar Elves');
  T.a.on('targets', req => req.cands.includes(refOf(elf)) ? [refOf(elf)] : undefined);
  await T.cast('Azorius Arrester');
  const { manaSourcesFor } = await import('../src/engine/abilities.js');
  expect(!manaSourcesFor(g, 1).some(s => s.card === elf), 'the detained Elves make no mana');
  await T.put(0, 'The Water Crystal');
  const gy = T.B.graveyard.length;
  await runAbility(T, 'DB$ Mill | Defined$ Opponent | NumCards$ 1', null, 0);
  expect(T.B.graveyard.length === gy + 5, `milled 1 + 4 (${T.B.graveyard.length - gy})`);
});
test('The AI uses the new effects sensibly: airbends an opponent\'s best permanent, earthbends its own land', async T => {
  const g = T.game;
  const big = await T.put(1, 'Serra Angel'), small = await T.put(1, 'Llanowar Elves');
  await T.cast('Airbending Lesson', 0);
  expect(big.zone === 'exile' && small.zone === 'battlefield', `the angel was airbent (${big.zone})`);
  await T.put(0, 'Forest'); await T.put(1, 'Forest');
  await T.cast('Earthbending Lesson', 0);
  const animated = g.battlefield.filter(c => g.chars(c).types.has('Land') && g.chars(c).types.has('Creature'));
  expect(animated.length === 1 && animated[0].controller === 0, 'its own land became the creature');
});

process.exit(await run(tests) ? 1 : 0);
