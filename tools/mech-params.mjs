// Behavioural tests for card-script parameters the engine now reads (src/engine/mech-params.js; the audit that found
// them is tools/paramaudit.mjs): set up a board, use the card, assert the outcome. Usage: node tools/mech-params.mjs [name-filter]
import { setup, expect, run, db } from './lib/testkit.mjs';
import { castSpell, getActions, activatedAbilities, castableOptions, activateAbility, refOf } from '../src/engine/abilities.js';
import { analyzeCard } from '../src/engine/support.js';

const tests = [];
const test = (name, fn, opts) => tests.push({ name, fn, opts });

// ------------------------------------------------------------ replacements
test('Untap replacements reach other permanents: Charmed Sleep, Intruder Alarm, Back to Basics; Mana Vault only in its untap step', async T => {
  const g = T.game;
  const bear = await T.put(1, 'Grizzly Bears');
  await T.put(0, 'Charmed Sleep', 'battlefield', { attachTo: bear.id });
  const vault = await T.put(1, 'Mana Vault');
  const elf = await T.put(1, 'Llanowar Elves');
  const forest = await T.put(1, 'Forest');
  const tower = await T.put(1, 'Reliquary Tower');
  await T.put(0, 'Back to Basics');
  for (const c of [bear, vault, elf, forest, tower]) c.tapped = true;
  g.activePlayer = 1;
  await g.runStep('untap');
  expect(bear.tapped, 'the enchanted creature stays tapped (Charmed Sleep)');
  expect(vault.tapped, 'Mana Vault stays tapped in its untap step');
  expect(tower.tapped, 'a nonbasic land stays tapped (Back to Basics)');
  expect(!elf.tapped && !forest.tapped, 'everything else untaps');
  // outside the untap step, "doesn't untap during your untap step" doesn't stop it
  g.activePlayer = 0; g.step = 'main1';
  await g.untap(vault);
  expect(!vault.tapped, 'Mana Vault untaps by other means');
  await T.put(0, 'Intruder Alarm');
  elf.tapped = true;
  g.activePlayer = 1;
  await g.runStep('untap');
  expect(elf.tapped, 'Intruder Alarm: creatures don\'t untap');
  expect(!forest.tapped, 'lands still untap');
});
test('Untap replacements: "can\'t become untapped" works outside the untap step; Freyalise\'s Winds removes counters instead', async T => {
  const g = T.game;
  const bear = await T.put(1, 'Grizzly Bears');
  await T.put(0, 'Frozen in Ice', 'battlefield', { attachTo: bear.id });
  bear.tapped = true;
  await g.untap(bear);
  expect(bear.tapped, 'Frozen in Ice: it can\'t become untapped');
  const winds = await T.put(0, "Freyalise's Winds");
  const elf = await T.put(1, 'Llanowar Elves');
  elf.tapped = true; elf.counters.WIND = 2;
  g.activePlayer = 1;
  await g.runStep('untap');
  expect(elf.tapped && !elf.counters.WIND, `the wind counters are removed instead (${elf.tapped}, ${elf.counters.WIND})`);
  await g.runStep('untap');
  expect(!elf.tapped, 'and it untaps in the next untap step');
});

// ------------------------------------------------------------ triggers
test('Werewolves transform only if no spells were cast last turn, and back after a player cast two (Mayor of Avabruck)', async T => {
  const g = T.game;
  const wolf = await T.put(0, 'Mayor of Avabruck');
  const upkeep = async () => { g.fire('Phase', { Phase: 'Upkeep', Player: g.activePlayer }); await T.resolve(); };
  g.lastTurnSpellCounts = [0, 1];
  await upkeep();
  expect(wolf.face === 0, 'a spell was cast last turn: stays human');
  g.lastTurnSpellCounts = [0, 0];
  await upkeep();
  expect(wolf.face === 1, 'no spells last turn: transforms');
  g.lastTurnSpellCounts = [1, 1];
  await upkeep();
  expect(wolf.face === 1, 'one spell each: stays a werewolf');
  g.lastTurnSpellCounts = [0, 2];
  await upkeep();
  expect(wolf.face === 0, 'a player cast two spells: transforms back');
  // the count is taken as each turn ends
  g.players[1].spellsCastThisTurn = [{}, {}];
  g.activePlayer = 0;
  await g.takeTurn();
  expect(g.lastTurnSpellCounts.join() === '0,2', `last turn's spells are recorded as the next turn begins (${g.lastTurnSpellCounts})`);
});
test('Valiant triggers only the first time each turn a spell or ability you control targets it (Heartfire Hero)', async T => {
  const g = T.game;
  const hero = await T.put(0, 'Heartfire Hero');
  T.a.on('targets', () => [refOf(hero)]);
  await T.cast('Giant Growth');
  expect((hero.counters.P1P1 || 0) === 1, `a +1/+1 counter the first time (${hero.counters.P1P1})`);
  await T.cast('Giant Growth');
  expect((hero.counters.P1P1 || 0) === 1, `not the second time this turn (${hero.counters.P1P1})`);
  g.turnState = g.freshTurnState();
  await T.cast('Giant Growth');
  expect((hero.counters.P1P1 || 0) === 2, `again the next turn (${hero.counters.P1P1})`);
});
test('Valiant: an opponent targeting it doesn\'t count', async T => {
  const g = T.game;
  const hero = await T.put(0, 'Heartfire Hero');
  T.b.on('targets', () => [refOf(hero)]);
  await T.cast('Giant Growth', 1);
  expect(!hero.counters.P1P1, 'no counter from an opponent\'s spell');
  T.a.on('targets', () => [refOf(hero)]);
  await T.cast('Giant Growth');
  expect((hero.counters.P1P1 || 0) === 1, 'the first one of yours still counts');
});
test('IsSingleTarget: Leyline of Resonance copies a spell that targets only a single creature you control', async T => {
  const g = T.game;
  await T.put(0, 'Leyline of Resonance');
  const a = await T.put(0, 'Grizzly Bears'), b = await T.put(0, 'Llanowar Elves');
  T.a.on('targets', () => [refOf(a)]);
  await T.cast('Giant Growth', 0, { resolve: false });
  await g.processTriggersAndSBA();
  const copied = g.stack.length;
  await T.resolve();
  expect(copied === 2, `a single target: copied (${copied} on the stack)`);
  let k = 0;
  T.a.on('targets', () => [refOf([a, b, a][k++ % 3])]);
  await T.cast('Seeds of Strength', 0, { resolve: false });
  await g.processTriggersAndSBA();
  const n2 = g.stack.length;
  await T.resolve();
  expect(n2 === 1, `two different targets: no copy (${n2} on the stack)`);
});

// ------------------------------------------------------------ effects
test('StaticEffect: Enduring Vitality returns as an enchantment, not a creature, and only while it stays', async T => {
  const g = T.game;
  const ev = await T.put(0, 'Enduring Vitality');
  await g.moveCard(ev, 'graveyard', {});
  await T.resolve();
  expect(ev.zone === 'battlefield', `it returns (${ev.zone})`);
  const ch = g.chars(ev);
  expect(ch.types.has('Enchantment') && !ch.types.has('Creature'), `an enchantment, not a creature (${[...ch.types]})`);
  await g.moveCard(ev, 'hand', {});
  expect(!g.effects.some(e => e.remembered.includes(ev)), 'the effect ends when it leaves');
  await g.moveCard(ev, 'battlefield', { controller: 0 });
  expect(g.chars(ev).types.has('Creature'), 'cast again later, it is a creature');
});
test('StaticEffect: Liliana, Death\'s Majesty returns a black Zombie', async T => {
  const g = T.game;
  const bear = await T.put(0, 'Grizzly Bears', 'graveyard');
  const lili = await T.put(0, "Liliana, Death's Majesty");
  lili.counters.LOYALTY = 5;
  T.a.on('targets', () => [refOf(bear)]);
  await T.activate(lili, 0, 1);
  const ch = g.chars(bear);
  expect(bear.zone === 'battlefield' && ch.subtypes.has('Zombie') && ch.subtypes.has('Bear') && ch.colors.has('B') && ch.colors.has('G'), `a black Zombie Bear (${[...ch.subtypes]}, ${[...ch.colors]})`);
});
test('OriginAlternative: Finale of Devastation finds a creature in the graveyard', async T => {
  const g = T.game;
  for (const c of [...T.A.library]) if (g.chars(c).types.has('Creature')) await g.moveCard(c, 'exile', { silent: true });
  const bear = await T.put(0, 'Grizzly Bears', 'graveyard');
  T.a.on('xValue', () => 2);
  await T.cast('Finale of Devastation');
  expect(bear.zone === 'battlefield', `from the graveyard to the battlefield (${bear.zone})`);
});
test('DestinationAlternative: Subtlety lets the spell\'s owner choose top or bottom', async T => {
  const g = T.game;
  g.activePlayer = 1;
  const angel = await T.cast('Serra Angel', 1, { resolve: false });
  g.activePlayer = 0;
  T.b.on('altDestination', req => req.options[1].value);
  T.a.on('targets', req => req.cands.includes('c' + angel.id) ? ['c' + angel.id] : []);
  await T.cast('Subtlety', 0, { resolve: false });
  await T.resolve();
  expect(angel.zone === 'library' && T.B.library[T.B.library.length - 1] === angel, `the owner put it on the bottom (${angel.zone}, at ${T.B.library.indexOf(angel)})`);
  expect(T.b.asked.some(r => r.purpose === 'altDestination'), 'the owner was asked');
});
test('TwoPiles: Fact or Fiction — an opponent separates, you choose a pile', async T => {
  const g = T.game;
  const top = T.A.library.slice(0, 5);
  T.b.on('separatePiles', req => [req.cards[0]]);
  T.a.on('choosePile', req => 2);
  const hand = T.A.hand.length;
  await T.cast('Fact or Fiction');
  expect(T.b.asked.some(r => r.purpose === 'separatePiles') && T.a.asked.some(r => r.purpose === 'choosePile'), 'the opponent separates, the caster chooses');
  expect(T.A.hand.length === hand + 4 && top[0].zone === 'graveyard' && top.slice(1).every(c => c.zone === 'hand'), `the chosen pile of four to hand, the other to the graveyard (${top.map(c => c.zone)})`);
});
test('TwoPiles: Liliana of the Veil −6 — you separate their permanents, they sacrifice the pile they choose', async T => {
  const g = T.game;
  const lili = await T.put(0, 'Liliana of the Veil');
  lili.counters.LOYALTY = 7;
  for (const c of [...g.battlefield]) if (c.controller === 1) await g.moveCard(c, 'graveyard', { silent: true });
  const a = await T.put(1, 'Grizzly Bears'), b = await T.put(1, 'Serra Angel'), c = await T.put(1, 'Forest');
  T.a.on('targets', req => req.cands.includes('p1') ? ['p1'] : undefined);
  T.a.on('separatePiles', req => [b.id]);
  T.b.on('choosePile', () => 1);
  await T.activate(lili, 0, 2);
  expect(b.zone === 'graveyard' && a.zone === 'battlefield' && c.zone === 'battlefield', `they sacrifice the pile they chose (${a.zone}, ${b.zone}, ${c.zone})`);
  expect(T.b.asked.some(r => r.purpose === 'choosePile' && r.good === false), 'asked as a pile to lose');
});
test('TwoPiles: the AI chooses the more valuable pile to keep, the less valuable one to lose', async T => {
  const g = T.game;
  const { AIAgent } = await import('../src/ai/ai.js');
  const ai = new AIAgent();
  ai.game = g;
  const bear = await T.put(1, 'Grizzly Bears'), angel = await T.put(1, 'Serra Angel'), elf = await T.put(1, 'Llanowar Elves');
  const req = good => ({ type: 'option', purpose: 'choosePile', options: [{ label: '1', value: 1 }, { label: '2', value: 2 }], piles: [[bear.id, elf.id], [angel.id]], good });
  const keep = await ai.ask(g, 1, req(true)), lose = await ai.ask(g, 1, req(false));
  expect(keep !== lose, `different piles to keep and to lose (${keep}, ${lose})`);
  const sep = await ai.ask(g, 1, { type: 'cards', purpose: 'separatePiles', cards: [bear.id, angel.id, elf.id], min: 0, max: 3 });
  expect(sep.length > 0 && sep.length < 3, `the AI makes two non-empty piles (${sep})`);
});
test('ReplaceDying: Anger of the Gods and Magma Spray exile what would die', async T => {
  const g = T.game;
  const bear = await T.put(1, 'Grizzly Bears');
  const angel = await T.put(1, 'Serra Angel');
  await T.cast('Anger of the Gods');
  expect(bear.zone === 'exile' && angel.zone === 'battlefield', `the Bears are exiled, the Angel survives (${bear.zone}, ${angel.zone})`);
  const elf = await T.put(1, 'Llanowar Elves');
  T.a.on('targets', () => [refOf(elf)]);
  await T.cast('Magma Spray');
  expect(elf.zone === 'exile', `Magma Spray exiles it (${elf.zone})`);
  const elf2 = await T.put(1, 'Llanowar Elves');
  await g.moveCard(elf2, 'graveyard', {});
  expect(elf2.zone === 'graveyard', 'other creatures still die normally');
});
test('ChooseCard: Cataclysmic Gearhulk — each player keeps one of each type they control', async T => {
  const g = T.game;
  for (const c of [...g.battlefield]) await g.moveCard(c, 'graveyard', { silent: true });
  const a1 = await T.put(0, 'Grizzly Bears'), a2 = await T.put(0, 'Serra Angel'), a3 = await T.put(0, 'Sol Ring'), a4 = await T.put(0, 'Forest');
  const b1 = await T.put(1, 'Llanowar Elves'), b2 = await T.put(1, 'Wall of Omens'), b3 = await T.put(1, 'Rancor', 'battlefield', { attachTo: null });
  T.a.on('chooseCard', req => [a2, a3].filter(c => req.cards.includes(c.id)).map(c => c.id).slice(0, 1).concat(req.cards).slice(0, 1));
  T.b.on('chooseCard', req => req.cards.includes(b2.id) ? [b2.id] : req.cards.slice(0, 1));
  const gh = await T.cast('Cataclysmic Gearhulk');
  const asked = T.a.asked.filter(r => r.purpose === 'chooseCard'), askedB = T.b.asked.filter(r => r.purpose === 'chooseCard');
  expect(asked.every(r => r.cards.every(id => g.cardById(id).controller === 0)) && askedB.every(r => r.cards.every(id => g.cardById(id).controller === 1)), 'each player chooses among their own permanents');
  expect(a2.zone === 'battlefield' && a3.zone === 'battlefield' && a1.zone === 'graveyard' && a4.zone === 'battlefield' && gh.zone === 'graveyard', `A keeps the Angel and the Sol Ring, and lands (${a1.zone}, ${a2.zone}, ${a3.zone}, ${a4.zone}, gearhulk ${gh.zone})`);
  expect(b2.zone === 'battlefield' && b1.zone === 'graveyard', `B keeps the Wall (${b1.zone}, ${b2.zone})`);
});
test('PersistentMana: Savage Ventmaw\'s mana stays through the steps of the turn, not into the next turn', async T => {
  const g = T.game;
  const vm = await T.put(0, 'Savage Ventmaw');
  T.noMana(0);
  g.fire('Attacks', { Attacker: vm, Defender: 1, DefendingPlayer: 1 });
  await T.resolve();
  expect(T.A.pool.R === 3 && T.A.pool.G === 3, `RRRGGG added (${JSON.stringify(T.A.pool)})`);
  T.A.pool.C = 2;
  g.emptyPools();
  expect(T.A.pool.R === 3 && T.A.pool.G === 3 && T.A.pool.C === 0, `kept as the step ends, other mana lost (${JSON.stringify(T.A.pool)})`);
  T.A.pool.R = 1;
  g.emptyPools();
  expect(T.A.pool.R === 1 && T.A.pool.G === 3, 'what was spent is gone');
  g.turnNumber++;
  g.emptyPools();
  expect(T.A.pool.R === 0 && T.A.pool.G === 0, 'lost at the next turn');
});
test('RememberDrawn: Fa\'adiyah Seer discards the drawn card if it isn\'t a land', async T => {
  const g = T.game;
  const seer = await T.put(0, "Fa'adiyah Seer");
  const top = await T.put(0, 'Serra Angel', 'library');
  await T.activate(seer, 0, a => a.parsed.api === 'Draw');
  expect(top.zone === 'graveyard', `a nonland is discarded (${top.zone})`);
  const land = await T.put(0, 'Forest', 'library');
  seer.tapped = false;
  await T.activate(seer, 0, a => a.parsed.api === 'Draw');
  expect(land.zone === 'hand', `a land is kept (${land.zone})`);
});
test('Charm ChoiceRestriction: Monument to Endurance chooses each mode once a turn', async T => {
  const g = T.game;
  await T.put(0, 'Monument to Endurance');
  const offered = [];
  T.a.on('modes', req => { offered.push(req.options.map(o => o.value)); return [req.options[0].value]; });
  for (let i = 0; i < 4; i++) { const c = await T.put(0, 'Forest', 'hand'); await g.discard(c); await T.resolve(); }
  expect(offered.length === 3 && offered[0].length === 3 && offered[1].length === 2 && offered[2].length === 1, `three, then two, then one mode; none the fourth time (${JSON.stringify(offered)})`);
  g.turnState = g.freshTurnState();
  const c = await T.put(0, 'Forest', 'hand'); await g.discard(c); await T.resolve();
  expect(offered.length === 4 && offered[3].length === 3, 'all three again next turn');
});

process.exit(await run(tests) ? 1 : 0);
