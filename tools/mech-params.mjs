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
test('Untap locks on a creature only reach what they name: Hokori and Rimescale Dragon untap themselves', async T => {
  const g = T.game;
  const hokori = await T.put(0, 'Hokori, Dust Drinker');
  const dragon = await T.put(0, 'Rimescale Dragon');
  const forest = await T.put(0, 'Forest');
  const bear = await T.put(0, 'Grizzly Bears');
  bear.counters.ICE = 1;
  for (const c of [hokori, dragon, forest, bear]) c.tapped = true;
  g.activePlayer = 0;
  await g.runStep('untap');
  expect(!hokori.tapped && !dragon.tapped, `the creatures with the locks untap (${hokori.tapped}, ${dragon.tapped})`);
  expect(forest.tapped, 'lands don\'t untap (Hokori)');
  expect(bear.tapped, 'a creature with an ice counter doesn\'t untap (Rimescale Dragon)');
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

// ------------------------------------------------------------ costs
const poolSum = pl => Object.values(pl.pool).reduce((a, b) => a + b, 0);
// mana a cast takes out of a full pool
async function spentOn(T, name, pid = 0, opts = {}) {
  T.mana(pid);
  const before = poolSum(T.game.players[pid]);
  const c = await T.cast(name, pid, { mana: false, ...opts });
  return { spent: before - poolSum(T.game.players[pid]), card: c };
}
test('ValidTarget cost statics: Terror of the Peaks charges 3 life only to spells that target it', async T => {
  const g = T.game;
  const bear = await T.put(0, 'Grizzly Bears');
  const terror = await T.put(0, 'Terror of the Peaks');
  g.activePlayer = 1; g.priority = 1;
  T.b.on('targets', () => [refOf(bear)]);
  let life = T.B.life;
  const r1 = await spentOn(T, 'Lightning Bolt', 1);
  expect(r1.spent === 1 && T.B.life === life, `targeting the Bears: just {R} (${r1.spent} mana, ${life - T.B.life} life)`);
  T.b.on('targets', () => [refOf(terror)]);
  life = T.B.life;
  const r2 = await spentOn(T, 'Lightning Bolt', 1);
  expect(r2.spent === 1 && T.B.life === life - 3, `targeting Terror of the Peaks: {R} and 3 life (${r2.spent} mana, ${life - T.B.life} life)`);
});
test('ValidTarget cost statics: Savage Stomp costs {2} less only if it targets a Dinosaur you control', async T => {
  const g = T.game;
  const bear = await T.put(0, 'Grizzly Bears');
  const opp = await T.put(1, 'Llanowar Elves');
  let k = 0;
  T.a.on('targets', req => [refOf([bear, opp][k++ % 2])]);
  const r1 = await spentOn(T, 'Savage Stomp');
  expect(r1.spent === 3, `a non-Dinosaur: full {2}{G} (${r1.spent})`);
  const dino = await T.put(0, 'Ghalta, Primal Hunger');
  const opp2 = await T.put(1, 'Llanowar Elves');
  k = 0;
  T.a.on('targets', req => [refOf([dino, opp2][k++ % 2])]);
  const r2 = await spentOn(T, 'Savage Stomp');
  expect(r2.spent === 1, `a Dinosaur: just {G} (${r2.spent})`);
});
test('Relative cost statics: Fireball costs {1} more per extra target; Damping Sphere counts the caster\'s spells', async T => {
  const g = T.game;
  const a = await T.put(1, 'Grizzly Bears'), b = await T.put(1, 'Llanowar Elves');
  T.a.on('xValue', () => 2).on('targets', () => [refOf(a), refOf(b)]);
  const r = await spentOn(T, 'Fireball');
  expect(r.spent === 1 + 2 + 1, `X=2 with two targets: {2}{R} + {1} (${r.spent})`);
  await T.put(1, 'Damping Sphere');
  T.A.spellsCastThisTurn = []; g.turnState.spellsCast = [];
  T.a.on('targets', () => ['p1']);
  const s1 = await spentOn(T, 'Lightning Bolt');
  const s2 = await spentOn(T, 'Lightning Bolt');
  expect(s1.spent === 1 && s2.spent === 2, `the caster's second spell costs {1} more (${s1.spent}, ${s2.spent})`);
  g.activePlayer = 1; g.priority = 1;
  T.b.on('targets', () => ['p0']);
  const s3 = await spentOn(T, 'Lightning Bolt', 1);
  expect(s3.spent === 1, `another player's first spell isn't taxed by the first player's spells (${s3.spent})`);
});
test('Announced additional costs: March of Swirling Mist exiles blue cards to cost {2} less each', async T => {
  const g = T.game;
  const bear = await T.put(1, 'Grizzly Bears');
  const blue1 = await T.put(0, 'Counterspell', 'hand'), blue2 = await T.put(0, 'Brainstorm', 'hand');
  T.a.on('xValue', () => 1).on('targets', () => [refOf(bear)]).on('announce', req => req.max).on('costExileFromHand', req => req.cards.slice(0, req.max));
  const r = await spentOn(T, 'March of Swirling Mist');
  expect(blue1.zone === 'exile' && blue2.zone === 'exile', `both blue cards exiled (${blue1.zone}, ${blue2.zone})`);
  expect(r.spent === 1, `{X}{U}{U} with X=1 less {4}: just one mana (${r.spent})`);
  expect(bear.phasedOut, 'the target phased out');
});
test('Ability cost statics: Training Grounds makes creatures\' abilities cost {2} less, never below one mana', async T => {
  const g = T.game;
  await T.put(0, 'Training Grounds');
  const spent = async (card, idx = 0) => { T.mana(0); const b = poolSum(T.A); await T.activate(card, 0, idx); card.tapped = false; return b - poolSum(T.A); };
  const shade = await T.put(0, 'Frozen Shade'); // {B}: +1/+1
  expect(await spent(shade) === 1, 'Frozen Shade still costs {B}');
  const cliff = await T.put(0, 'Cliffside Lookout'); // {4}{W}: creatures you control get +1/+1
  const n = await spent(cliff);
  expect(n === 3, `Cliffside Lookout's {4}{W} costs {2}{W} (${n})`);
  const pyro = await T.put(0, 'Prodigal Pyromancer'); // {T}: 1 damage
  T.a.on('targets', () => ['p1']);
  expect(await spent(pyro) === 0, 'a tap-only ability stays free');
  const sol = await T.put(0, 'Sol Ring');
  const ring = await T.put(0, 'Mind Stone'); // {1}, {T}, sacrifice: draw — not a creature
  expect(await spent(ring, a => a.parsed.api === 'Draw') === 1, 'a noncreature\'s ability is unchanged');
});
test('Ability cost raises: Kopala, Warden of Waves taxes abilities that target a Merfolk', async T => {
  const g = T.game;
  await T.put(0, 'Kopala, Warden of Waves');
  const merfolk = await T.put(0, 'Merfolk Looter');
  const bear = await T.put(0, 'Grizzly Bears');
  const pyro = await T.put(1, 'Prodigal Pyromancer');
  const spent = async (target) => { T.mana(1); const b = poolSum(T.B); T.b.on('targets', () => [refOf(target)]); await T.activate(pyro, 1, 0); pyro.tapped = false; return b - poolSum(T.B); };
  expect(await spent(bear) === 0, 'targeting a non-Merfolk: free');
  expect(await spent(merfolk) === 2, 'targeting a Merfolk: {2} more');
});
test('Mana conversion: Chromatic Orrery pays colored costs with colorless; Vizier of the Menagerie for creature spells', async T => {
  const g = T.game;
  const { canAfford } = await import('../src/engine/abilities.js');
  const { parseMana } = await import('../src/engine/mana.js');
  T.noMana(0); T.A.pool.C = 2;
  const angel = await T.put(0, 'Serra Angel', 'hand');
  T.A.pool.C = 5;
  const ok0 = castableOptions(g, 0, angel).length > 0;
  expect(!ok0, 'without it, {C}{C}{C}{C}{C} can\'t cast Serra Angel');
  await T.put(0, 'Vizier of the Menagerie');
  expect(castableOptions(g, 0, angel).length > 0, 'Vizier: colorless mana casts a creature spell');
  const bolt = await T.put(0, 'Lightning Bolt', 'hand');
  expect(castableOptions(g, 0, bolt).length === 0, 'but not a noncreature spell');
  await T.put(0, 'Chromatic Orrery');
  expect(castableOptions(g, 0, bolt).length > 0, 'Chromatic Orrery: any spell');
  g.priority = 0;
  const ok = await castSpell(g, 0, bolt, {});
  expect(ok && T.A.pool.C === 4, `cast with {C} (${T.A.pool.C} left)`);
});
test('Drought: spells cost an additional "sacrifice a Swamp" per black symbol', async T => {
  const g = T.game;
  await T.put(1, 'Drought');
  const s1 = await T.put(0, 'Swamp'), s2 = await T.put(0, 'Swamp');
  const bear = await T.put(1, 'Grizzly Bears');
  T.a.on('targets', () => [refOf(bear)]);
  await T.cast('Doom Blade');
  expect([s1, s2].filter(s => s.zone === 'graveyard').length === 1 && bear.zone === 'graveyard', `one Swamp sacrificed for {1}{B} (${s1.zone}, ${s2.zone})`);
  const elf = await T.put(1, 'Llanowar Elves');
  T.a.on('targets', () => [refOf(elf)]);
  await T.cast('Lightning Bolt');
  expect(s2.zone === 'battlefield' || s1.zone === 'battlefield', 'a red spell needs no Swamp');
});
test('OptionalCost on other permanents: Defiler of Vigor — pay 2 life, the green permanent spell costs {G} less', async T => {
  const g = T.game;
  await T.put(0, 'Defiler of Vigor');
  T.a.on('optionalCost', () => true);
  const life = T.A.life;
  const r = await spentOn(T, 'Grizzly Bears');
  expect(r.spent === 1 && T.A.life === life - 2, `{1}{G} less {G}, and 2 life (${r.spent} mana, ${life - T.A.life} life)`);
  const r2 = await spentOn(T, 'Lightning Bolt', 0, { resolve: true });
  expect(T.A.life === life - 2, 'not offered for a red spell');
});

// ------------------------------------------------------------ casting permissions
test('MayPlayAltManaCost: Bolas\'s Citadel casts the top card for life, not mana', async T => {
  const g = T.game;
  await T.put(0, "Bolas's Citadel");
  const top = await T.put(0, 'Serra Angel', 'library');
  T.noMana(0);
  g.priority = 0;
  const acts = getActions(g, 0).filter(a => a.cardId === top.id);
  expect(acts.length === 1 && /pay 5 life/.test(acts[0].label), `one way, paying 5 life (${acts.map(a => a.label)})`);
  const life = T.A.life;
  await g.performAction(0, acts[0]);
  await T.resolve();
  expect(top.zone === 'battlefield' && T.A.life === life - 5, `cast for 5 life (${top.zone}, ${life - T.A.life})`);
  const land = await T.put(0, 'Forest', 'library');
  expect(getActions(g, 0).some(a => a.cardId === land.id && a.type === 'land'), 'a land on top can still be played');
});
test('MayPlay in hand: Omniscience casts spells from your hand without paying their mana costs', async T => {
  const g = T.game;
  await T.put(0, 'Omniscience');
  const angel = await T.put(0, 'Serra Angel', 'hand');
  T.noMana(0);
  g.priority = 0;
  const act = getActions(g, 0).find(a => a.cardId === angel.id);
  expect(act && /without paying/.test(act.label), `offered free (${act && act.label})`);
  await g.performAction(0, act);
  await T.resolve();
  expect(angel.zone === 'battlefield', 'cast for free');
});
test('MayPlayDontGrantZonePermissions: As Foretold\'s {0} works once a turn and doesn\'t let you cast from your graveyard', async T => {
  const g = T.game;
  const af = await T.put(0, 'As Foretold');
  af.counters.TIME = 3;
  const gy = await T.put(0, 'Grizzly Bears', 'graveyard');
  const a = await T.put(0, 'Grizzly Bears', 'hand'), b = await T.put(0, 'Llanowar Elves', 'hand');
  T.noMana(0);
  g.priority = 0;
  expect(!getActions(g, 0).some(x => x.cardId === gy.id), 'nothing from the graveyard');
  const act = getActions(g, 0).find(x => x.cardId === a.id);
  expect(act && /\{0\}/.test(act.label), `the Bears for {0} (${act && act.label})`);
  await g.performAction(0, act);
  await T.resolve();
  expect(a.zone === 'battlefield', 'cast for {0}');
  expect(!getActions(g, 0).some(x => x.cardId === b.id), 'only once each turn');
  g.turnState = g.freshTurnState();
  expect(getActions(g, 0).some(x => x.cardId === b.id), 'again next turn');
});
test('MayPlayWithFlash and MayPlayPlayer: Aluren lets any player cast small creatures free, as though they had flash', async T => {
  const g = T.game;
  await T.put(0, 'Aluren');
  const elf = await T.put(1, 'Llanowar Elves', 'hand');
  const angel = await T.put(1, 'Serra Angel', 'hand');
  T.noMana(1);
  g.priority = 1; // on A's turn
  const acts = getActions(g, 1);
  expect(acts.some(x => x.cardId === elf.id) && !acts.some(x => x.cardId === angel.id), 'B may cast the Elves on A\'s turn, not the Angel');
  await g.performAction(1, acts.find(x => x.cardId === elf.id));
  await T.resolve();
  expect(elf.zone === 'battlefield', 'cast for free at instant speed');
});
test('MayPlayLimit counts per static and per turn: Muldrotha plays a land and casts a creature from the graveyard', async T => {
  const g = T.game;
  await T.put(0, 'Muldrotha, the Gravetide');
  const land = await T.put(0, 'Forest', 'graveyard');
  const c1 = await T.put(0, 'Grizzly Bears', 'graveyard'), c2 = await T.put(0, 'Llanowar Elves', 'graveyard');
  T.mana(0);
  g.priority = 0;
  await g.performAction(0, getActions(g, 0).find(x => x.cardId === c1.id));
  await T.resolve();
  expect(c1.zone === 'battlefield', 'a creature from the graveyard');
  T.mana(0);
  expect(!getActions(g, 0).some(x => x.cardId === c2.id), 'not a second creature this turn');
  expect(getActions(g, 0).some(x => x.cardId === land.id), 'but still a land');
  g.turnState = g.freshTurnState();
  expect(getActions(g, 0).some(x => x.cardId === c2.id), 'another creature next turn');
});
test('TopCardOfLibraryIs: Vampire Nocturnus gets +2/+1 and flying only while the top card is black', async T => {
  const g = T.game;
  const vn = await T.put(0, 'Vampire Nocturnus');
  await T.put(0, 'Forest', 'library');
  g.touch();
  expect(g.chars(vn).power === 3 && !g.chars(vn).keywords.includes('Flying'), `a land on top: 3/3 (${g.chars(vn).power})`);
  await T.put(0, 'Doom Blade', 'library');
  g.touch();
  expect(g.chars(vn).power === 5 && g.chars(vn).keywords.includes('Flying'), `a black card on top: 5/4 flying (${g.chars(vn).power})`);
});

// ------------------------------------------------------------ characteristics
test('GainsAbilitiesOfZones: Necrotic Ooze has the activated abilities of creature cards in graveyards, not on the battlefield', async T => {
  const g = T.game;
  const ooze = await T.put(0, 'Necrotic Ooze');
  await T.put(0, 'Frozen Shade'); // on the battlefield: not gained
  await T.put(1, 'Prodigal Pyromancer', 'graveyard');
  g.touch();
  const abil = activatedAbilities(g, 0, ooze);
  expect(abil.some(a => a.parsed.api === 'DealDamage') && !abil.some(a => a.parsed.api === 'Pump'), `the Pyromancer's ping, not the Shade's pump (${abil.map(a => a.parsed.api)})`);
  T.a.on('targets', () => ['p1']);
  const life = T.B.life;
  await T.activate(ooze, 0, a => a.parsed.api === 'DealDamage');
  expect(T.B.life === life - 1, 'and it works');
});
test('GainsAbilitiesOf exiled cards + ManaConvert: Agatha\'s Soul Cauldron', async T => {
  const g = T.game;
  const pot = await T.put(0, "Agatha's Soul Cauldron");
  const shade = await T.put(0, 'Frozen Shade', 'graveyard');
  const bear = await T.put(0, 'Grizzly Bears');
  T.a.on('targets', req => req.cands.includes(refOf(shade)) ? [refOf(shade)] : [refOf(bear)]);
  await T.activate(pot, 0, a => a.parsed.api === 'ChangeZone');
  expect(shade.zone === 'exile' && bear.counters.P1P1 === 1, `exiled, and a +1/+1 counter on the Bears (${shade.zone}, ${bear.counters.P1P1})`);
  g.touch();
  const abil = activatedAbilities(g, 0, bear);
  expect(abil.some(a => a.parsed.api === 'Pump'), 'the Bears have the Shade\'s {B}: +1/+1');
  // any color of mana pays it
  T.noMana(0); T.A.pool.G = 1;
  bear.sick = false; g.priority = 0;
  const act = getActions(g, 0).find(x => x.cardId === bear.id && x.api === 'Pump');
  expect(act, '{G} pays the {B} ability');
  await g.performAction(0, act); await T.resolve();
  expect(g.chars(bear).power === 4, `pumped (${g.chars(bear).power})`);
  const elf = await T.put(0, 'Llanowar Elves');
  expect(!activatedAbilities(g, 0, elf).some(a => a.parsed.api === 'Pump'), 'a creature without a counter doesn\'t');
});
test('SharedKeywordsZone: Cairn Wanderer has only the keywords creature cards in graveyards have', async T => {
  const g = T.game;
  const cw = await T.put(0, 'Cairn Wanderer');
  g.touch();
  expect(!g.chars(cw).keywords.some(k => /Flying|Trample|Lifelink/.test(k)), `nothing yet (${g.chars(cw).keywords})`);
  await T.put(1, 'Serra Angel', 'graveyard');
  g.touch();
  const kws = g.chars(cw).keywords;
  expect(kws.includes('Flying') && kws.includes('Vigilance') && !kws.includes('Trample'), `flying and vigilance from Serra Angel (${kws})`);
});
test('SharedKeywordsZone on an effect: Odric, Lunarch Marshal shares only keywords your creatures have', async T => {
  const g = T.game;
  await T.put(0, 'Odric, Lunarch Marshal');
  const bear = await T.put(0, 'Grizzly Bears');
  await T.put(0, 'Serra Angel');
  g.fire('Phase', { Phase: 'BeginCombat', Player: 0 });
  await T.resolve();
  const kws = g.chars(bear).keywords;
  expect(kws.includes('Flying') && kws.includes('Vigilance') && !kws.includes('Trample') && !kws.includes('Deathtouch'), `flying and vigilance only (${kws})`);
});
test('CantHaveKeyword: Archetype of Courage — opponents\' creatures lose first strike and can\'t gain it', async T => {
  const g = T.game;
  await T.put(0, 'Archetype of Courage');
  const knight = await T.put(1, 'White Knight');
  g.touch();
  expect(!g.chars(knight).keywords.includes('First Strike'), 'loses first strike');
  T.b.on('targets', () => [refOf(knight)]);
  await T.cast('Brute Force', 1);
  const elite = await T.put(1, 'Grizzly Bears');
  T.b.on('targets', () => [refOf(elite)]);
  g.activePlayer = 1;
  await T.cast('Bladed Pinions', 1).catch(() => {});
  g.activePlayer = 0;
  knight.counters.FIRSTSTRIKE = 1;
  g.touch();
  expect(!g.chars(knight).keywords.includes('First Strike'), `not from a counter either (${g.chars(knight).keywords})`);
  const mine = await T.put(0, 'White Knight');
  expect(g.chars(mine).keywords.includes('First Strike'), 'its controller\'s own creatures keep it');
});
test('RemoveNonManaAbilities: under Blood Sun, lands keep only their mana abilities', async T => {
  const g = T.game;
  await T.put(1, 'Blood Sun');
  const fetch = await T.put(0, 'Polluted Delta');
  const mine = await T.put(0, 'Mutavault');
  g.touch();
  expect(!activatedAbilities(g, 0, fetch).length, 'the fetchland has no ability');
  const ab = g.chars(mine).abilities;
  expect(ab.length > 0 && ab.every(a => a.parsed.api === 'Mana'), `Mutavault keeps only {T}: Add {C} (${ab.map(a => a.parsed.api)})`);
  const forest = await T.put(0, 'Forest');
  expect(g.chars(forest).abilities.some(a => a.parsed.api === 'Mana'), 'basic lands still tap for mana');
});
test('SetName and AddReplacementEffect: Witness Protection renames; Cloudsteel Kirin\'s player can\'t lose', async T => {
  const g = T.game;
  const angel = await T.put(1, 'Serra Angel');
  await T.put(0, 'Witness Protection', 'battlefield', { attachTo: angel.id });
  g.touch();
  expect(g.chars(angel).name === 'Legitimate Businessperson' && g.chars(angel).power === 1 && !g.chars(angel).keywords.includes('Flying'), `a 1/1 Legitimate Businessperson (${g.chars(angel).name})`);
  const kirin = await T.put(0, 'Cloudsteel Kirin');
  const bear = await T.put(0, 'Grizzly Bears');
  kirin.attachedTo = bear.id;
  g.touch();
  T.A.life = 0;
  await g.processTriggersAndSBA();
  expect(!T.A.lost, 'with the Kirin attached, A doesn\'t lose at 0 life');
});

// ------------------------------------------------------------ damage redirection
test('Damage redirection: Pariah sends damage dealt to you to the enchanted creature', async T => {
  const g = T.game;
  const bear = await T.put(0, 'Serra Angel');
  await T.put(0, 'Pariah', 'battlefield', { attachTo: bear.id });
  const life = T.A.life;
  T.b.on('targets', () => ['p0']);
  g.activePlayer = 1;
  await T.cast('Lightning Bolt', 1);
  expect(T.A.life === life && bear.damage === 3, `the Angel takes the 3, not A (${life - T.A.life} life, ${bear.damage} damage)`);
});
test('Damage redirection: Palisade Giant takes the damage dealt to you and your other permanents', async T => {
  const g = T.game;
  const giant = await T.put(0, 'Palisade Giant');
  const elf = await T.put(0, 'Llanowar Elves');
  T.b.on('targets', () => [refOf(elf)]);
  g.activePlayer = 1;
  await T.cast('Lightning Bolt', 1);
  expect(elf.zone === 'battlefield' && giant.damage === 3, `the Elves survive, the Giant has 3 damage (${elf.zone}, ${giant.damage})`);
  const life = T.A.life;
  T.b.on('targets', () => ['p0']);
  await T.cast('Lightning Bolt', 1);
  expect(T.A.life === life && giant.damage === 6, `and the damage to A (${life - T.A.life}, ${giant.damage})`);
});
test('Damage redirection: Harm\'s Way moves the next 2 damage from a source to any target', async T => {
  const g = T.game;
  const ogre = await T.put(1, 'Hill Giant');
  const shock = await T.put(1, 'Prodigal Pyromancer');
  T.a.on('chooseSource', req => req.cards ? [shock.id] : undefined).on('targets', () => [refOf(ogre)]);
  T.a.on('cards', req => req.cards && req.cards.includes(shock.id) ? [shock.id] : undefined);
  await T.cast('Harm\'s Way');
  const life = T.A.life;
  await g.dealDamage(shock, T.A, 3, {});
  expect(T.A.life === life - 1 && ogre.damage === 2, `2 to the Giant, 1 to A (${life - T.A.life}, ${ogre.damage})`);
  await g.dealDamage(shock, T.A, 2, {});
  expect(T.A.life === life - 3, 'used up: the next damage is dealt as usual');
});

// ------------------------------------------------------------ targeting
test('TargetsWithDefinedController: Mortuary Mire only targets creature cards in your own graveyard', async T => {
  const g = T.game;
  const mine = await T.put(0, 'Grizzly Bears', 'graveyard');
  const theirs = await T.put(1, 'Serra Angel', 'graveyard');
  let cands = null;
  T.a.on('targets', req => { cands = req.cands; return [refOf(mine)]; }).on('optionalTrigger', () => true);
  await T.put(0, 'Mortuary Mire');
  await T.resolve();
  expect(cands && cands.includes(refOf(mine)) && !cands.includes(refOf(theirs)), `only A's graveyard (${cands})`);
  expect(T.A.library[0] === mine, 'the Bears go on top of A\'s library');
});
test('TargetValidTargeting: Siren Stormtamer counters only what targets you or a creature you control', async T => {
  const g = T.game;
  const siren = await T.put(0, 'Siren Stormtamer');
  const bear = await T.put(0, 'Grizzly Bears');
  g.activePlayer = 1;
  T.b.on('targets', () => ['p0']);
  const bolt1 = await T.cast('Lightning Bolt', 1, { resolve: false });
  const opp = await T.put(1, 'Hill Giant');
  T.b.on('targets', () => [refOf(opp)]);
  const bolt2 = await T.cast('Giant Growth', 1, { resolve: false });
  g.priority = 0;
  const abil = activatedAbilities(g, 0, siren).find(a => a.parsed.api === 'Counter');
  const { targetSpec, targetCandidates, SA } = await import('../src/engine/abilities.js');
  const sa = new SA(g, abil, siren, 0);
  const cands = targetCandidates(g, sa, targetSpec(g, sa));
  expect(cands.some(i => i.card === bolt1) && !cands.some(i => i.card === bolt2), `the Bolt at A, not the Giant Growth on B's creature (${cands.map(i => i.description)})`);
});
test('ValidAfterStack: Lurrus casts a permanent spell from the graveyard only if its mana value on the stack is 2 or less', async T => {
  const g = T.game;
  await T.put(0, 'Lurrus of the Dream-Den');
  const hw = await T.put(0, 'Hangarback Walker', 'graveyard');
  T.mana(0);
  g.priority = 0;
  T.a.on('xValue', () => 2);
  const act = getActions(g, 0).find(a => a.cardId === hw.id);
  expect(act, 'offered from the graveyard');
  const ok = await g.performAction(0, act);
  expect(!ok && hw.zone === 'graveyard', `X=2 makes it mana value 4: not allowed (${hw.zone})`);
  T.a.on('xValue', () => 1);
  await g.performAction(0, getActions(g, 0).find(a => a.cardId === hw.id));
  await T.resolve();
  expect(hw.zone === 'battlefield', `X=1 is fine (${hw.zone})`);
});

// ------------------------------------------------------------ mana
test('ProduceMana replacements: Contamination makes lands tap for {B}; Damping Sphere turns two or more into {C}', async T => {
  const g = T.game;
  const { producedUnits, manaAbilitiesOf, activateManaAbility } = await import('../src/engine/abilities.js');
  const forest = await T.put(0, 'Forest');
  const tomb = await T.put(0, 'Ancient Tomb');
  const units = c => producedUnits(g, c, manaAbilitiesOf(g, c)[0]).map(u => u.join('/')).join(' ');
  expect(units(forest) === 'G' && units(tomb) === 'C C', `normally G and CC (${units(forest)}, ${units(tomb)})`);
  const sphere = await T.put(1, 'Damping Sphere');
  g.touch();
  expect(units(forest) === 'G' && units(tomb) === 'C', `Damping Sphere: Ancient Tomb makes one {C} (${units(tomb)})`);
  await g.moveCard(sphere, 'graveyard', { silent: true });
  await T.put(1, 'Contamination');
  g.touch();
  expect(units(forest) === 'B', `Contamination: the Forest makes {B} (${units(forest)})`);
  T.noMana(0);
  await activateManaAbility(g, 0, forest, manaAbilitiesOf(g, forest)[0].key);
  expect(T.A.pool.B === 1 && T.A.pool.G === 0, `tapped for {B} (${JSON.stringify(T.A.pool)})`);
});
test('LoseMana replacements: under Omnath, Locus of All unspent mana becomes black', async T => {
  const g = T.game;
  await T.put(0, 'Omnath, Locus of All');
  T.noMana(0); T.A.pool.G = 2; T.A.pool.U = 1;
  g.emptyPools();
  expect(T.A.pool.B === 3 && T.A.pool.G === 0, `three black mana (${JSON.stringify(T.A.pool)})`);
});

// ------------------------------------------------------------ misc
test('RollDice ResultSVar: Bucknard\'s Everfull Purse makes as many Treasures as the roll', async T => {
  const g = T.game;
  const purse = await T.put(0, "Bucknard's Everfull Purse");
  const before = T.tokens(0).length;
  await T.activate(purse, 0, a => a.parsed.api === 'RollDice');
  const made = T.tokens(0).length - before;
  const rolled = purse.chosen && purse.chosen.number;
  expect(made >= 1 && made === rolled, `Treasures = the d4 roll (${made} for ${rolled})`);
});
test('Replacement ActivePhases: Island Sanctuary replaces only the draw-step draw', async T => {
  const g = T.game;
  await T.put(0, 'Island Sanctuary');
  T.a.on('replacement', () => true);
  const hand = T.A.hand.length;
  g.step = 'main1';
  await g.drawCards(T.A, 1);
  expect(T.A.hand.length === hand + 1, 'a draw in the main phase is just a draw');
  g.step = 'draw';
  await g.drawCards(T.A, 1);
  expect(T.A.hand.length === hand + 1, 'the draw-step draw is skipped');
});
test('TriggerController: Yuan-Ti Malison\'s trigger is controlled by the creature\'s controller', async T => {
  const g = T.game;
  const yt = await T.put(1, 'Yuan-Ti Malison');
  g.fire('DamageDone', { Source: yt, DamageSource: yt, Target: T.A, DamageTarget: T.A, DamageAmount: 2, IsCombatDamage: true, CombatDamage: true });
  const pt = g.pendingTriggers.find(x => x.host === yt);
  expect(pt && pt.controller === 1, `controlled by B (${pt && pt.controller})`);
});
test('support.js flags the parameters left out: Opposition Agent, Leonin Arbiter, the Shoals; not the cards fixed here', async T => {
  const { allCardScripts } = await import('./lib/allcards.mjs');
  const all = allCardScripts();
  const issues = n => analyzeCard(all[n]);
  expect(issues('Opposition Agent').some(i => /search/.test(i)), `Opposition Agent (${issues('Opposition Agent')})`);
  expect(issues('Leonin Arbiter').some(i => /ignore/.test(i)), `Leonin Arbiter (${issues('Leonin Arbiter')})`);
  expect(issues('Disrupting Shoal').some(i => /chosen X/.test(i)), `Disrupting Shoal (${issues('Disrupting Shoal')})`);
  for (const n of ["Bolas's Citadel", 'Fact or Fiction', 'Cataclysmic Gearhulk', 'Enduring Vitality', 'Necrotic Ooze', 'Charmed Sleep', 'Pariah', 'Terror of the Peaks']) expect(!issues(n).length, `${n} looks supported (${issues(n)})`);
});

// ------------------------------------------------------------ remembered numbers and objects
test('RememberCounteredCMC + RememberNumber: Mana Drain adds {C} equal to the countered spell\'s mana value next main phase', async T => {
  const g = T.game;
  g.activePlayer = 1;
  const angel = await T.cast('Serra Angel', 1, { resolve: false });
  T.a.on('targets', req => req.cands.find(r => r.startsWith('s')) ? [req.cands.find(r => r.startsWith('s'))] : undefined);
  await T.cast('Mana Drain', 0);
  expect(angel.zone === 'graveyard', `countered (${angel.zone})`);
  g.activePlayer = 0;
  T.noMana(0);
  g.fire('Phase', { Phase: 'Main1', Player: 0 });
  await T.resolve();
  expect(T.A.pool.C === 5, `{C}{C}{C}{C}{C} for a mana value 5 spell (${JSON.stringify(T.A.pool)})`);
});
test('RememberAmount + RememberedNumber: Creeping Bloodsucker gains the life it drained', async T => {
  const g = T.game;
  await T.put(0, 'Creeping Bloodsucker');
  const life = T.A.life, opp = T.B.life;
  g.fire('Phase', { Phase: 'Upkeep', Player: 0 });
  await T.resolve();
  expect(T.B.life === opp - 1 && T.A.life === life + 1, `1 damage, 1 life (${opp - T.B.life}, ${T.A.life - life})`);
});
test('RememberPumped: Patriarch\'s Bidding returns the creature cards of each chosen type', async T => {
  const g = T.game;
  const elf = await T.put(0, 'Llanowar Elves', 'graveyard');
  const angel = await T.put(1, 'Serra Angel', 'graveyard');
  const bear = await T.put(0, 'Grizzly Bears', 'graveyard');
  T.a.on('chooseType', () => 'Elf');
  T.b.on('chooseType', () => 'Angel');
  await T.cast("Patriarch's Bidding");
  expect(elf.zone === 'battlefield' && angel.zone === 'battlefield' && bear.zone === 'graveyard', `the Elf and the Angel return, the Bear stays (${elf.zone}, ${angel.zone}, ${bear.zone})`);
});
test('RememberPut: Fangs of Kalonia doubles the counters on the creature it put one on', async T => {
  const g = T.game;
  const bear = await T.put(0, 'Grizzly Bears');
  bear.counters.P1P1 = 2;
  T.a.on('targets', () => [refOf(bear)]);
  await T.cast('Fangs of Kalonia');
  expect(bear.counters.P1P1 === 6, `2 + 1 = 3, doubled to 6 (${bear.counters.P1P1})`);
});
test('RememberSVarAmount from a roll: Ancient Brass Dragon\'s d20 sets the total mana value it can return', async T => {
  const g = T.game;
  const dragon = await T.put(0, 'Ancient Brass Dragon');
  const angel = await T.put(1, 'Serra Angel', 'graveyard');
  let maxSeen = null;
  T.a.on('targets', req => { maxSeen = req.max; return req.cands.includes(refOf(angel)) ? [refOf(angel)] : []; });
  g.fire('DamageDone', { Source: dragon, DamageSource: dragon, Target: T.B, DamageTarget: T.B, DamageAmount: 7, IsCombatDamage: true, CombatDamage: true });
  await T.resolve();
  const rolled = dragon.storedSVars && dragon.storedSVars.v.Result;
  expect(rolled != null, 'rolled');
  expect(+rolled >= 5 ? angel.zone === 'battlefield' : angel.zone === 'graveyard', `rolled ${rolled}: the Angel (mana value 5) ${angel.zone}`);
});

test('Trigger conditions: Fastbond (not the first land), The Lost and the Damned (not from hand), Karmic Justice (an opponent\'s destroy)', async T => {
  const g = T.game;
  await T.put(0, 'Fastbond');
  const { playLand } = await import('../src/engine/abilities.js');
  const life = T.A.life;
  const f1 = await T.put(0, 'Forest', 'hand'), f2 = await T.put(0, 'Forest', 'hand');
  T.A.landsPlayed = 0;
  await g.performAction(0, getActions(g, 0).find(a => a.cardId === f1.id)); await T.resolve();
  expect(T.A.life === life, `the first land: no damage (${life - T.A.life})`);
  await g.performAction(0, getActions(g, 0).find(a => a.cardId === f2.id)); await T.resolve();
  expect(T.A.life === life - 1, `the second land: 1 damage (${life - T.A.life})`);
  await T.put(0, 'The Lost and the Damned');
  const tokens = T.tokens(0).length;
  const f3 = await T.put(0, 'Island', 'hand');
  T.A.landsPlayed = 0;
  await g.performAction(0, getActions(g, 0).find(a => a.cardId === f3.id)); await T.resolve();
  expect(T.tokens(0).length === tokens, 'a land from hand makes no Spawn');
  const f4 = await T.put(0, 'Swamp', 'graveyard');
  await g.moveCard(f4, 'battlefield', { controller: 0 }); await T.resolve();
  expect(T.tokens(0).length === tokens + 1, 'a land from the graveyard does');
  const kj = await T.put(0, 'Karmic Justice');
  const ring = await T.put(0, 'Mind Stone');
  const ench = await T.put(1, 'Glorious Anthem');
  T.a.on('optionalTrigger', () => true).on('targets', req => req.cands.includes(refOf(ench)) ? [refOf(ench)] : undefined);
  await g.destroy(ring, null);
  await T.resolve();
  expect(ench.zone === 'battlefield', 'destroyed by no one\'s spell: no trigger');
  const ring2 = await T.put(0, 'Mind Stone');
  T.b.on('targets', () => [refOf(ring2)]);
  g.activePlayer = 1;
  await T.cast('Shatter', 1);
  expect(ench.zone === 'graveyard', `an opponent's Shatter: Karmic Justice destroys their Glorious Anthem (${ench.zone})`);
});

process.exit(await run(tests) ? 1 : 0);
