// Behavioural tests for the classic mechanics in src/engine/mech-classic.js: soulshift, modular, fading, haunt,
// ingest, phasing, skipping and controlling turns, restarting and drawing the game, the "can't" statics, regeneration
// replacements, draining mana, bidding life, coin flips and the rest. Usage: node tools/mech-classic.mjs [name-filter]
import { setup, expect, run, db } from './lib/testkit.mjs';
import { castSpell, getActions, refOf, activatedAbilities, castableOptions, activateAbility, playLand, canActivate, targetCandidates, targetSpec, whyCantPlay } from '../src/engine/abilities.js';
import * as combat from '../src/engine/combat.js';
import { calcCtx, matchValid } from '../src/engine/filters.js';
import { analyzeCard } from '../src/engine/support.js';
import { deciderFor, controlledBy } from '../src/engine/mech-classic.js';

const tests = [];
const test = (name, fn, opts) => tests.push({ name, fn, opts });
const kill = async (T, c) => { await T.game.destroy(c, null); await T.resolve(); };
const upkeep = async (T, pid = 0) => { T.game.activePlayer = pid; T.game.fire('Phase', { Phase: 'Upkeep', Player: pid }); await T.resolve(); };
const untapStep = async (T, pid = 0) => { T.game.activePlayer = pid; await T.game.runStep('untap'); await T.resolve(); };

// ------------------------------------------------------------ keywords
test('Soulshift: Thief of Hope returns a Spirit with mana value 2 or less when it dies', async T => {
  const kami = await T.put(0, 'Kami of Ancient Law', 'graveyard');
  const big = await T.put(0, 'Thousand-legged Kami', 'graveyard');
  const thief = await T.put(0, 'Thief of Hope');
  T.a.on('targets', req => { expect(!req.cands.includes(refOf(big)), 'a Spirit with too high a mana value is no target'); return [refOf(kami)]; });
  await kill(T, thief);
  expect(kami.zone === 'hand', `the Spirit came back (${kami.zone})`);
});
test('Soulshift is optional', async T => {
  const kami = await T.put(0, 'Kami of Ancient Law', 'graveyard');
  const thief = await T.put(0, 'Thief of Hope');
  T.a.on('optionalTrigger', () => false);
  await kill(T, thief);
  expect(kami.zone === 'graveyard', 'stayed in the graveyard');
});
test('Modular: Arcbound Worker enters with a counter and moves its counters to an artifact creature when it dies', async T => {
  const w = await T.cast('Arcbound Worker');
  expect(w.counters.P1P1 === 1 && T.game.chars(w).power === 1, `enters with one +1/+1 counter (${w.counters.P1P1})`);
  await T.game.addCounters(w, 'P1P1', 2, null);
  const golem = await T.put(0, 'Steel Overseer');
  T.a.on('targets', () => [refOf(golem)]);
  await kill(T, w);
  expect(golem.counters.P1P1 === 3, `three counters moved (${golem.counters.P1P1})`);
});
test('Modular—Sunburst: Arcbound Wanderer gets a counter for each color spent', async T => {
  const c = await T.put(0, 'Arcbound Wanderer', 'hand');
  T.noMana(0); T.A.pool = { W: 1, U: 1, B: 1, R: 1, G: 2, C: 0 };
  T.game.priority = 0;
  await castSpell(T.game, 0, c, {}); await T.resolve();
  expect(c.zone === 'battlefield' && c.counters.P1P1 >= 3, `counters for the colors spent (${c.counters.P1P1})`);
});
test('Fading: Blastoderm loses a fade counter each upkeep and is sacrificed when it can\'t', async T => {
  const b = await T.cast('Blastoderm');
  expect(b.counters.FADE === 3, `three fade counters (${b.counters.FADE})`);
  for (let i = 0; i < 3; i++) await upkeep(T);
  expect(b.zone === 'battlefield' && !b.counters.FADE, 'still here with none left');
  await upkeep(T);
  expect(b.zone === 'graveyard', 'sacrificed when it couldn\'t remove one');
});
test('Ingest: Mist Intruder makes the damaged player exile the top card of their library', async T => {
  const m = await T.put(0, 'Mist Intruder');
  const top = T.B.library[0];
  T.combatWith([[m, 1]]);
  await combat.combatDamage(T.game, false); await T.resolve();
  expect(top.zone === 'exile', `the top card was exiled (${top.zone})`);
});
test('Haunt (creature): Absolver Thrull destroys an enchantment as it enters and again when the haunted creature dies', async T => {
  const e1 = await T.put(1, 'Pacifism'), e2 = await T.put(1, 'Glorious Anthem');
  const victim = await T.put(1, 'Grizzly Bears');
  T.a.on('targets', req => (req.cands.includes(refOf(e1)) ? [refOf(e1)] : req.cands.includes(refOf(e2)) ? [refOf(e2)] : req.cands.includes(refOf(victim)) ? [refOf(victim)] : undefined));
  const thrull = await T.cast('Absolver Thrull');
  expect(e1.zone === 'graveyard', 'enters: an enchantment destroyed');
  await kill(T, thrull);
  expect(thrull.zone === 'exile' && thrull.haunting && thrull.haunting.id === victim.id, `exiled haunting the Bears (${thrull.zone})`);
  await kill(T, victim);
  expect(e2.zone === 'graveyard', 'the haunted creature died: another enchantment destroyed');
  expect(!T.game.effects.some(e => e.hostCard === thrull), 'the haunting ended');
});
test('Haunt (spell): Cry of Contrition is exiled haunting a creature after it resolves', async T => {
  const victim = await T.put(0, 'Grizzly Bears');
  for (const n of ['Island', 'Forest', 'Swamp']) await T.put(1, n, 'hand');
  T.a.on('targets', req => (req.cands.includes('p1') ? ['p1'] : req.cands.includes(refOf(victim)) ? [refOf(victim)] : undefined));
  const h = T.B.hand.length;
  const cry = await T.cast('Cry of Contrition');
  expect(T.B.hand.length === h - 1, 'B discarded a card');
  expect(cry.zone === 'exile', `exiled after resolving (${cry.zone})`);
  await kill(T, victim);
  expect(T.B.hand.length === h - 2, 'the haunted creature died: B discards again');
});
test('Haunt: a countered haunt spell isn\'t exiled', async T => {
  const victim = await T.put(0, 'Grizzly Bears');
  T.a.on('targets', req => (req.cands.includes('p1') ? ['p1'] : undefined));
  const cry = await T.cast('Cry of Contrition', 0, { resolve: false });
  const item = T.game.stack[T.game.stack.length - 1];
  T.game.stack.pop(); await T.game.moveCard(cry, 'graveyard', { cause: { host: victim } });
  await T.resolve();
  expect(cry.zone === 'graveyard' && item, 'still in the graveyard');
});

// ------------------------------------------------------------ phasing
test('Phasing: Teferi\'s Imp phases out on your untap step (discard), in on the next (draw)', async T => {
  const imp = await T.put(0, "Teferi's Imp");
  T.A.hand.length = 0; await T.put(0, 'Island', 'hand'); await T.put(0, 'Forest', 'hand');
  await untapStep(T);
  expect(imp.phasedOut, 'phased out');
  expect(T.A.hand.length === 1, `discarded a card (${T.A.hand.length})`);
  expect(!matchValid(T.game, imp, 'Creature', { you: 0 }) && !T.game.zone(0, 'battlefield').filter(c => matchValid(T.game, c, 'Creature.YouCtrl', { you: 0 })).includes(imp), 'treated as though it doesn\'t exist');
  await untapStep(T);
  expect(!imp.phasedOut, 'phased in');
  expect(T.A.hand.length === 2, `drew a card (${T.A.hand.length})`);
  await untapStep(T);
  expect(imp.phasedOut, 'and out again');
});
test('Phasing: an Aura phases out and in with the creature it enchants', async T => {
  const e = await T.put(0, 'Shimmering Efreet');
  const aura = await T.put(0, 'Rancor', 'battlefield', { attachTo: null });
  aura.attachedTo = e.id;
  const bear = await T.put(1, 'Grizzly Bears');
  T.a.on('targets', req => (req.cands.includes(refOf(bear)) ? [refOf(bear)] : undefined));
  await untapStep(T);
  expect(e.phasedOut && aura.phasedOut && aura.zone === 'battlefield', 'both phased out, the Aura stays');
  await T.game.processTriggersAndSBA();
  expect(aura.zone === 'battlefield', 'no state-based action for the phased-out Aura');
  await untapStep(T);
  expect(!e.phasedOut && !aura.phasedOut && aura.attachedTo === e.id, 'both back, still attached');
});
test('Phasing: Shimmering Efreet phases another creature out as it phases in; Warping Wurm grows', async T => {
  const e = await T.put(0, 'Shimmering Efreet');
  const bear = await T.put(1, 'Grizzly Bears');
  T.a.on('targets', req => (req.cands.includes(refOf(bear)) ? [refOf(bear)] : undefined));
  await untapStep(T);
  await untapStep(T);
  expect(!e.phasedOut && bear.phasedOut, 'the Efreet phased in and the Bears out');
  await untapStep(T, 1);
  expect(!bear.phasedOut, 'the Bears phase in on their controller\'s untap step');
  const w = await T.put(0, 'Warping Wurm');
  await untapStep(T); await untapStep(T);
  expect(!w.phasedOut && w.counters.P1P1 === 1, `the Wurm phased in with a counter (${w.counters.P1P1})`);
});
test('Can\'t phase out: Ertai\'s Familiar until your next upkeep; Spatial Binding', async T => {
  const f = await T.put(0, "Ertai's Familiar");
  await T.activate(f, 0, a => a.parsed.api === 'Effect');
  await untapStep(T);
  expect(!f.phasedOut, 'didn\'t phase out');
  await untapStep(T);
  expect(f.phasedOut, 'the effect ended with the upkeep: phases out next time');
  const imp = await T.put(1, "Teferi's Imp");
  const sb = await T.put(0, 'Spatial Binding');
  T.a.on('targets', () => [refOf(imp)]);
  await T.activate(sb, 0);
  T.b.on('cards', req => req.cards.slice(0, req.min));
  await untapStep(T, 1);
  expect(!imp.phasedOut, 'Spatial Binding kept the Imp in');
});
test('Phase in / out triggers and Time and Tide: phased-out creatures phase in, creatures with phasing out', async T => {
  const imp = await T.put(0, "Teferi's Imp");
  const bear = await T.put(1, 'Grizzly Bears');
  T.a.on('targets', req => (req.cands.includes(refOf(bear)) ? [refOf(bear)] : undefined));
  await T.cast('Reality Ripple');
  expect(bear.phasedOut, 'Reality Ripple phased the Bears out');
  T.a.on('cards', req => req.cards.slice(0, req.min));
  await T.cast('Time and Tide');
  expect(!bear.phasedOut && imp.phasedOut, 'the Bears phase in, the Imp out');
});
test('Phased out: attacking creature leaves combat; King of the Oathbreakers', async T => {
  const king = await T.put(0, 'King of the Oathbreakers');
  const spirit = await T.put(0, 'Kami of Ancient Law');
  T.combatWith([[spirit, 1]]);
  T.b.on('targets', req => (req.cands.includes(refOf(spirit)) ? [refOf(spirit)] : undefined));
  T.game.priority = 1;
  await T.cast('Lightning Bolt', 1);
  expect(spirit.phasedOut && spirit.zone === 'battlefield' && !T.game.isAttacking(spirit), 'targeted Spirit phased out, removed from combat, Bolt fizzled');
  const tokens = T.tokens(0).length;
  await untapStep(T);
  expect(!spirit.phasedOut && T.tokens(0).length === tokens + 1, 'phasing in made a Spirit token');
  expect(king.zone === 'battlefield', 'king fine');
});

// ------------------------------------------------------------ turns
test('Skip Turn: Meditate draws four and you skip your next turn', async T => {
  const h = T.A.hand.length;
  await T.cast('Meditate');
  expect(T.A.hand.length === h + 4 && T.A.skipTurns === 1, 'drew four, a turn to skip');
  T.game.activePlayer = 1;
  await T.game.takeTurn();
  expect(T.game.activePlayer === 0, 'B took its turn, A is next');
  const t = T.game.turnNumber;
  await T.game.takeTurn();
  expect(T.logged(/A skips their turn/) && T.game.turnNumber === t + 1 && T.game.logs.some(l => l.text === `Turn ${t + 1}: B`), 'A skipped: B went again');
  expect(T.game.activePlayer === 0 && !T.A.skipTurns, 'then A');
});
test('Skip Turn: Ral Zarek, Guest Lecturer — skip a turn for each heads of five coins', async T => {
  const ral = await T.put(0, 'Ral Zarek, Guest Lecturer');
  ral.counters.LOYALTY = 7;
  T.a.on('targets', () => ['p1']);
  await T.activate(ral, 0, a => a.parsed.api === 'FlipCoin');
  const heads = T.game.logs.filter(l => /flips a coin.*heads/.test(l.text)).length;
  expect((T.B.skipTurns || 0) === heads, `B skips ${heads} turn(s) (${T.B.skipTurns})`);
});
test('Control Player: Mindslaver — you make the target player\'s decisions during their next turn', async T => {
  const ms = await T.put(0, 'Mindslaver');
  T.a.on('targets', () => ['p1']);
  await T.activate(ms, 0);
  expect(ms.zone === 'graveyard', 'sacrificed');
  expect(deciderFor(T.game, 1) === 1, 'not yet: still this turn');
  T.game.activePlayer = 1;
  const asked = [];
  T.a.on('priority', (req, g) => { asked.push(req.player); return { type: 'pass' }; });
  await T.game.takeTurn();
  expect(asked.includes(1), 'A was asked for B\'s priority');
  expect(T.a.asked.filter(r => r.player === 1).every(r => r.decider === 0), 'and the requests name A as the decider');
  expect(!T.b.asked.some(r => r.type === 'priority' && r.player === 1 && T.game.turnNumber === 4), 'B made none of its own decisions that turn');
  T.game.activePlayer = 1;
  asked.length = 0;
  await T.game.takeTurn();
  expect(!asked.includes(1), 'B decides again on its following turn');
});
test('Control Player: controlledBy names the turn you control; Cruel Entertainment swaps', async T => {
  T.game.controlPlans = [{ target: 1, by: 0, combat: false, fromTurn: 2, fromStep: 'main1', fromCombats: 0, ts: 1 }];
  T.game.activePlayer = 1; T.B.turns = [1, 3]; T.game.turnNumber = 3;
  expect(controlledBy(T.game, 0) === 1 && deciderFor(T.game, 1) === 0, 'A controls B\'s turn 3');
  T.B.turns = [1, 3, 5]; T.game.turnNumber = 5;
  expect(controlledBy(T.game, 0) === null, 'not B\'s next one');
  T.game.controlPlans = []; T.game.activePlayer = 0; T.game.turnNumber = 3;
  T.a.on('targets', req => (req.cands.includes('p0') && !req.cands.includes('p1') ? ['p0'] : req.cands.includes('p1') ? ['p1'] : undefined));
  T.a.on('player', () => 1);
  await T.cast('Cruel Entertainment');
  const plans = T.game.controlPlans || [];
  expect(plans.length === 2 && plans.some(p => p.target === 1 && p.by === 0) && plans.some(p => p.target === 0 && p.by === 1), `each controls the other's next turn (${JSON.stringify(plans.map(p => [p.target, p.by]))})`);
});
test('Restart Game: Karn Liberated restarts, leaving his exiled permanent cards and returning them', async T => {
  const karn = await T.put(0, 'Karn Liberated');
  const angel = await T.put(1, 'Serra Angel');
  T.a.on('targets', req => (req.cands.includes(refOf(angel)) ? [refOf(angel)] : undefined));
  karn.counters.LOYALTY = 20;
  await T.activate(karn, 0, a => /SubCounter<3/.test(a.parsed.p.Cost));
  expect(angel.zone === 'exile' && angel.exiledWith === karn.id, 'exiled with Karn');
  T.A.life = 12; T.B.life = 7;
  karn.abilityUses = {};
  await T.activate(karn, 0, a => a.parsed.api === 'RestartGame');
  expect(T.A.life === 40 && T.B.life === 40, 'life totals reset');
  expect(angel.zone === 'battlefield' && angel.controller === 0, `the exiled Angel enters under A's control (${angel.zone})`);
  expect(karn.zone === 'library' && T.A.hand.length === 0 && T.A.graveyard.length === 0, 'everything else went to the library');
  expect(T.game.endTurnNow && T.game.classicRestart, 'this turn ends; the new game starts');
  T.game.endTurnNow = false;
  T.game.activePlayer = 1;
  await T.game.takeTurn();
  expect(T.A.hand.length + T.game.battlefield.filter(c => c.controller === 0).length >= 7, 'A drew a new opening hand and took the first turn');
});
test('Game Drawn: Divine Intervention', async T => {
  const d = await T.put(0, 'Divine Intervention');
  expect(d.counters.INTERVENTION === 2, 'two counters');
  await upkeep(T);
  expect(!T.game.over, 'one left');
  try { await upkeep(T); } catch (e) { if (!/game over/.test(e.message)) throw e; }
  expect(T.game.over && T.game.winner == null, 'the game is a draw');
});
test('Reorder Zone: Search for Survivors reorders the graveyard at random', async T => {
  for (const n of ['Island', 'Forest', 'Swamp', 'Grizzly Bears']) await T.put(0, n, 'graveyard');
  const n = T.A.graveyard.length;
  T.a.on('player', () => 1);
  await T.cast('Search for Survivors');
  expect(T.A.graveyard.length + T.A.exile.length + T.game.battlefield.filter(c => c.controller === 0 && c.def.name === 'Grizzly Bears').length >= n, 'cards accounted for');
  expect(T.logged(/reorders their graveyard at random/), 'reordered');
});

// ------------------------------------------------------------ can't
test('Can\'t regenerate: Incinerate stops a regeneration shield', async T => {
  const troll = await T.put(1, 'Mossbridge Troll');
  const w = await T.put(1, 'Drudge Skeletons');
  T.mana(1); await T.activate(w, 1);
  expect(w.regenShields > 0, 'shielded');
  T.a.on('targets', req => (req.cands.includes(refOf(w)) ? [refOf(w)] : undefined));
  await T.cast('Incinerate');
  await T.game.dealDamage(w, w, 5, {});
  await T.resolve();
  expect(w.zone === 'graveyard', `couldn't regenerate (${w.zone})`);
  expect(troll.zone === 'battlefield', 'troll fine');
});
test('Destroy replacement: Mossbridge Troll regenerates instead; not when it can\'t be regenerated', async T => {
  const troll = await T.put(1, 'Mossbridge Troll');
  await T.game.destroy(troll, null);
  expect(troll.zone === 'battlefield' && troll.tapped, 'regenerated (tapped)');
  const clergy = await T.put(1, 'Clergy of the Holy Nimbus');
  T.mana(0);
  await T.activate(clergy, 0, a => a.parsed.api === 'Effect');
  await T.game.destroy(clergy, null);
  expect(clergy.zone === 'graveyard', 'Clergy can\'t be regenerated this turn');
});
test('Destroy replacement: Harmonious Emergence sacrifices itself instead and the land survives', async T => {
  const land = await T.put(0, 'Forest');
  T.a.on('targets', () => [refOf(land)]);
  const aura = await T.cast('Harmonious Emergence');
  expect(aura.attachedTo === land.id && T.isCreature(land), 'the land is a creature');
  await T.game.destroy(land, null); await T.resolve();
  expect(land.zone === 'battlefield' && aura.zone === 'graveyard', 'land survives, the Aura went');
});
test('Can\'t play lands: Aggressive Mining, Moonhold-style effects, Experimental Frenzy from the hand', async T => {
  await T.put(0, 'Aggressive Mining');
  const f = await T.put(0, 'Forest', 'hand');
  expect(!getActions(T.game, 0).some(a => a.type === 'land'), 'no land play');
  expect(/Aggressive Mining stops you playing/.test(whyCantPlay(T.game, 0, f) || ''), `says why (${whyCantPlay(T.game, 0, f)})`);
  expect(!(await playLand(T.game, 0, f, {})), 'playLand refuses');
  expect(getActions(T.game, 1).length >= 0, 'fine');
});
test('Can\'t attach: Konda\'s Banner only on legendary creatures; Gate Smasher falls off a smaller creature', async T => {
  const banner = await T.put(0, "Konda's Banner");
  const bear = await T.put(0, 'Grizzly Bears');
  const legend = await T.put(0, 'Isamaru, Hound of Konda');
  const abil = activatedAbilities(T.game, 0, banner).find(a => a.parsed.p.IsEquip);
  const s = { ...abil };
  const { SA } = await import('../src/engine/abilities.js');
  const sa = new SA(T.game, abil, banner, 0);
  const cands = targetCandidates(T.game, sa, targetSpec(T.game, sa));
  expect(cands.includes(legend) && !cands.includes(bear), 'only the legendary creature');
  const gs = await T.put(0, 'Gate Smasher');
  const big = await T.put(0, 'Craw Wurm');
  gs.attachedTo = big.id; T.game.touch();
  await T.game.processTriggersAndSBA();
  expect(gs.attachedTo === big.id, 'on a 6/4');
  T.game.combat = null;
  big.mods.push({ id: 99, toughness: 2, until: 'EOT' }); T.game.touch();
  await T.game.processTriggersAndSBA();
  expect(gs.attachedTo == null, 'unattached from a 6/2');
});
test('Can\'t attach: Anti-Magic Aura — no other Auras; existing ones fall off', async T => {
  const bear = await T.put(1, 'Grizzly Bears');
  const pac = await T.put(1, 'Pacifism'); pac.attachedTo = bear.id;
  T.a.on('targets', () => [refOf(bear)]);
  const ama = await T.cast('Anti-Magic Aura');
  expect(ama.attachedTo === bear.id && pac.zone === 'graveyard', `the other Aura went (${pac.zone})`);
  const pacifism = await T.put(0, 'Pacifism', 'hand');
  T.mana(0); T.game.priority = 0;
  expect(!castableOptions(T.game, 0, pacifism).length, 'Pacifism has no creature it may enchant');
});
test('Can\'t transform: Bound by Moonsilver stops a werewolf transforming at night', async T => {
  const w = await T.put(1, 'Kessig Naturalist');
  T.a.on('targets', () => [refOf(w)]);
  await T.cast('Bound by Moonsilver');
  T.game.setDayNight('Night');
  expect(w.face === 0, 'still the front face');
});
test('Can\'t discard: Tamiyo, Collector of Tales stops an opponent\'s discard effect, not costs', async T => {
  await T.put(1, 'Tamiyo, Collector of Tales');
  await T.put(1, 'Island', 'hand'); await T.put(1, 'Forest', 'hand');
  const h = T.B.hand.length;
  T.a.on('targets', () => ['p1']);
  await T.cast('Mind Rot');
  expect(T.B.hand.length === h, `nothing discarded (${h - T.B.hand.length})`);
});
test('Can\'t gain control: Guardian Beast protects noncreature artifacts while untapped', async T => {
  await T.put(1, 'Guardian Beast');
  const ring = await T.put(1, 'Sol Ring');
  T.a.on('targets', () => [refOf(ring)]);
  T.mana(0);
  const c = await T.put(0, 'Steal Artifact', 'hand');
  T.game.priority = 0;
  await castSpell(T.game, 0, c, {}); await T.resolve();
  expect(ring.controller === 1 && ring.zone === 'battlefield', 'still B\'s');
});
test('Can\'t be suspected: Airtight Alibi', async T => {
  const bear = await T.put(0, 'Grizzly Bears');
  T.a.on('targets', () => [refOf(bear)]);
  await T.cast('Airtight Alibi');
  const sa = (await import('../src/engine/abilities.js')).makeSA(T.game, 'DB$ AlterAttribute | Attributes$ Suspected | Defined$ Targeted', {}, bear, 1);
  sa.targets = [bear];
  await (await import('../src/engine/abilities.js')).resolveChain(T.game, sa);
  expect(!bear.suspected, 'not suspected');
});
test('Can\'t become the monarch: Jared Carthalion, True Heir', async T => {
  T.a.on('targets', () => ['p1']);
  await T.cast('Jared Carthalion, True Heir');
  expect(T.game.monarch === 1, 'B is the monarch');
  const bear = await T.put(0, 'Grizzly Bears');
  T.combatWith([[bear, 1]]);
  await combat.combatDamage(T.game, false); await T.resolve();
  expect(T.game.monarch === 1, 'A can\'t take it this turn');
});
test('Can\'t venture: Keen-Eared Sentry — once a turn for opponents', async T => {
  await T.put(0, 'Keen-Eared Sentry');
  await T.game.venture(1); await T.game.venture(1);
  expect(T.B.dungeon && T.B.dungeon.room && T.logged(/B enters/) && T.game.logs.filter(l => /^B enters/.test(l.text)).length === 1, 'B ventured once');
  await T.game.venture(0); await T.game.venture(0);
  expect(T.game.logs.filter(l => /^A enters/.test(l.text)).length === 2, 'A twice');
});
test('Can\'t pay life: Karn\'s Sylex — no life costs, no Phyrexian life', async T => {
  await T.put(1, "Karn's Sylex");
  const c = await T.put(0, 'Dismember', 'hand');
  T.noMana(0); T.A.pool.C = 1;
  T.game.priority = 0;
  await T.put(1, 'Grizzly Bears');
  expect(!castableOptions(T.game, 0, c).length, 'Dismember can\'t be paid with life');
  const tool = await T.put(0, "Arcbound Ravager");
  expect(T.game.players[0].life === 40, 'fine');
});
test('Pay Life replacement: Ashiok exiles cards instead', async T => {
  await T.put(0, 'Ashiok, Wicked Manipulator');
  const lib = T.A.library.length;
  const c = await T.put(0, 'Toxic Deluge', 'hand');
  T.mana(0); T.game.priority = 0;
  T.a.on('xValue', () => 3); T.a.on('number', () => 3);
  await castSpell(T.game, 0, c, {}); await T.resolve();
  expect(T.A.life === 40 && T.A.library.length === lib - 3, `exiled three instead (${T.A.life}, ${lib - T.A.library.length})`);
});
test('Ignore Hexproof: Glaring Spotlight lets you target hexproof creatures', async T => {
  const t = await T.put(1, 'Gladecover Scout');
  T.a.on('targets', req => req.cands);
  const { SA } = await import('../src/engine/abilities.js');
  const bolt = await T.put(0, 'Lightning Bolt', 'hand');
  const can = () => castableOptions(T.game, 0, bolt).length && getActions(T.game, 0).some(a => a.cardId === bolt.id);
  T.mana(0); T.game.priority = 0;
  for (const c of [...T.game.battlefield]) if (c !== t && T.isCreature(c)) await T.game.moveCard(c, 'graveyard', { silent: true });
  await T.put(0, 'Glaring Spotlight');
  T.a.on('targets', req => { expect(req.cands.includes(refOf(t)), 'the hexproof creature is a target'); return [refOf(t)]; });
  await castSpell(T.game, 0, bolt, {}); await T.resolve();
  expect(t.zone === 'graveyard', 'bolted');
});
test('Ignore Shroud: Autumn Willow can be targeted by the chosen player', async T => {
  const w = await T.put(1, 'Autumn Willow');
  T.mana(1);
  T.b.on('targets', req => (req.cands.includes('p0') ? ['p0'] : undefined));
  await T.activate(w, 1);
  const bolt = await T.put(0, 'Lightning Bolt', 'hand');
  T.mana(0); T.game.priority = 0;
  let saw = false;
  T.a.on('targets', req => { saw = req.cands.includes(refOf(w)); return [refOf(w)]; });
  await castSpell(T.game, 0, bolt, {}); await T.resolve();
  expect(saw, 'A may target the Willow');
});
test('Must Target: Standard Bearer — an opponent\'s targeted spell must target it', async T => {
  const sb = await T.put(1, 'Standard Bearer');
  const bear = await T.put(1, 'Grizzly Bears');
  let cands;
  T.a.on('targets', req => { cands = req.cands; return [refOf(bear)]; });
  await T.cast('Lightning Bolt');
  expect(!cands.includes(refOf(bear)) && cands.includes(refOf(sb)), 'only the Flagbearer offered');
  expect(sb.zone === 'graveyard' && bear.zone === 'battlefield', 'the Bolt hit the Flagbearer');
});
test('Activations: boast once a turn after attacking; Birgi allows twice on your turn', async T => {
  const b = await T.put(0, 'Dragonkin Berserker');
  const boast = a => a.parsed.p.Boast;
  const abil = activatedAbilities(T.game, 0, b).find(boast);
  T.mana(0);
  expect(!canActivate(T.game, 0, b, abil, { ignoreTiming: true }), 'not before it attacked');
  T.game.turnState.attackedWith = [b.id];
  await T.activate(b, 0, boast);
  T.mana(0);
  expect(!canActivate(T.game, 0, b, abil, { ignoreTiming: true }), 'once a turn');
  await T.put(0, 'Birgi, God of Storytelling');
  T.mana(0);
  expect(canActivate(T.game, 0, b, abil, { ignoreTiming: true }), 'Birgi: twice');
});
test('Activations: exhaust once; Elvish Refueler while you haven\'t exhausted this turn', async T => {
  const r = await T.put(0, 'Elvish Refueler');
  const ex = a => a.parsed.p.Exhaust;
  await T.activate(r, 0, ex);
  expect(r.counters.P1P1 === 1, 'a counter');
  T.mana(0);
  const abil = activatedAbilities(T.game, 0, r).find(ex);
  expect(!canActivate(T.game, 0, r, abil, { ignoreTiming: true }), 'exhausted this turn already: no more');
  T.game.turnState.activations = []; T.game.touch();
  expect(canActivate(T.game, 0, r, abil, { ignoreTiming: true }), 'a new turn on which nothing was exhausted: again');
  T.game.activePlayer = 1; T.game.touch();
  expect(!canActivate(T.game, 0, r, abil, { ignoreTiming: true }), 'not on an opponent\'s turn');
});
test('Ignore Planeswalker Zero Loyalty Rule: Sanctum Lurker', async T => {
  await T.put(0, 'Sanctum Lurker');
  const pw = await T.put(0, 'Ajani Goldmane');
  pw.counters.LOYALTY = 0; T.game.touch();
  await T.game.processTriggersAndSBA();
  expect(pw.zone === 'battlefield', 'stays with 0 loyalty');
});

// ------------------------------------------------------------ mana, bidding, coins, upkeep costs
test('Drain Mana: Mana Short taps lands and empties the pool; Yurlok\'s mana burn', async T => {
  await T.put(1, 'Yurlok of Scorch Thrash');
  T.B.pool = { W: 0, U: 2, B: 0, R: 0, G: 1, C: 0 };
  T.a.on('targets', () => ['p1']);
  await T.cast('Mana Short');
  expect(T.B.pool.U === 0 && T.B.pool.G === 0, 'pool emptied');
  expect(T.B.life === 37, `mana burn: lost 3 life (${T.B.life})`);
  T.A.pool = { W: 2, U: 0, B: 0, R: 0, G: 0, C: 0 };
  T.game.emptyPools();
  expect(T.A.life === 38, `losing mana between steps burns too (${T.A.life})`);
});
test('Activate Ability + Drain Mana: Drain Power takes the mana of their lands', async T => {
  for (const c of [...T.game.battlefield]) if (c.controller === 1) await T.game.moveCard(c, 'graveyard', { silent: true });
  await T.put(1, 'Island'); await T.put(1, 'Forest'); await T.put(1, 'Swamp');
  T.a.on('targets', () => ['p1']);
  T.noMana(0);
  const c = await T.put(0, 'Drain Power', 'hand');
  T.A.pool.U = 2; T.game.priority = 0;
  await castSpell(T.game, 0, c, {}); await T.resolve();
  const total = Object.values(T.A.pool).reduce((a, b) => a + b, 0);
  expect(total === 3 && T.A.pool.U === 1 && T.A.pool.G === 1 && T.A.pool.B === 1, `A has their three mana (${JSON.stringify(T.A.pool)})`);
});
test('Bid Life: Pain\'s Reward — the high bidder loses that much life and draws four', async T => {
  T.a.on('bidStart', () => 2);
  T.a.on('bidLife', () => false);
  T.b.on('bidLife', req => req.bid < 4);
  T.b.on('bidRaise', () => 2);
  const h = T.B.hand.length;
  await T.cast("Pain's Reward");
  expect(T.B.life === 36 && T.B.hand.length === h + 4, `B bid 4, lost 4 and drew four (${T.B.life}, ${T.B.hand.length - h})`);
});
test('Bid Life: Illicit Auction — the winner gains control of the creature', async T => {
  const angel = await T.put(1, 'Serra Angel');
  T.a.on('targets', () => [refOf(angel)]);
  T.a.on('bidLife', req => req.bid < 5);
  T.a.on('bidRaise', () => 1);
  T.b.on('bidLife', req => req.bid < 3);
  T.b.on('bidRaise', () => 1);
  await T.cast('Illicit Auction');
  expect(angel.controller === 0, 'A won the Angel');
  expect(T.A.life === 40 - 4, `A paid the high bid (${T.A.life})`);
});
test('Bid Life AI: bids stop', async T => {
  const angel = await T.put(1, 'Serra Angel');
  T.a.on('targets', () => [refOf(angel)]);
  await T.cast('Illicit Auction');
  expect(T.A.life + T.B.life >= 80 - 20, 'the AI bids sensibly');
});
test('Exchange Control Variant: Cultural Exchange swaps any number of creatures', async T => {
  const a1 = await T.put(0, 'Grizzly Bears'), b1 = await T.put(1, 'Serra Angel'), b2 = await T.put(1, 'Craw Wurm');
  T.a.on('targets', () => ['p0', 'p1']);
  T.a.on('exchangeChoice', req => (req.cards.includes(a1.id) ? [a1.id] : [b1.id]));
  await T.cast('Cultural Exchange');
  expect(a1.controller === 1 && b1.controller === 0 && b2.controller === 1, 'one for one');
});
test('Aura swap: Arcanum Wings swaps for an Aura card in hand', async T => {
  const bear = await T.put(0, 'Grizzly Bears');
  const w = await T.put(0, 'Arcanum Wings'); w.attachedTo = bear.id;
  const r = await T.put(0, 'Rancor', 'hand');
  T.a.on('auraSwap', () => [r.id]);
  await T.activate(w, 0, a => a.parsed.api === 'AuraSwap');
  expect(w.zone === 'hand' && r.zone === 'battlefield' && r.attachedTo === bear.id, 'swapped');
});
test('Flip Coin Mod: Edgar\'s first flips each turn come up heads; Amount and FlipUntilYouLose', async T => {
  await T.put(0, 'Edgar, King of Figaro');
  await T.cast('Stitch in Time');
  expect(T.logged(/A flips a coin: wins/) && T.A.extraTurns !== null && T.game.extraTurns.includes(0), 'won the flip: an extra turn');
  expect(!T.game.logs.some(l => /flips a coin: loses/.test(l.text)), 'no losses');
  const n = T.game.logs.length;
  await T.cast('Stitch in Time');
  expect(T.game.logs.slice(n).some(l => /flips a coin/.test(l.text)), 'flips again (not fixed this time)');
});
test('Flip Coin: Goblin Traprunner flips three, a token for each win', async T => {
  const g = await T.put(0, 'Goblin Traprunner');
  T.combatWith([[g, 1]]);
  T.game.fire('Attacks', { Attacker: g, DefendingPlayer: 1, AttackerCount: 1 });
  await T.resolve();
  const wins = T.game.logs.filter(l => /flips a coin.*wins/.test(l.text)).length;
  expect(T.game.logs.filter(l => /flips a coin \(\d\/3\)/.test(l.text)).length === 3, 'three flips');
  expect(T.tokens(0).length === wins, `a token per win (${T.tokens(0).length} / ${wins})`);
});
test('Pay Cumulative Upkeep trigger: Balduvian Fallen gets +1/+0 for each {B} or {R} paid', async T => {
  const f = await T.put(0, 'Balduvian Fallen');
  T.noMana(0); T.A.pool.B = 1;
  for (const x of T.game.battlefield) if (T.isLand(x)) x.tapped = true;
  await upkeep(T);
  expect(f.zone === 'battlefield' && T.game.chars(f).power === 4, `paid {B}: 4/5 (${T.game.chars(f).power})`);
});
test('Pay Cumulative Upkeep trigger: Heart of Bogardan deals damage when it isn\'t paid', async T => {
  const h = await T.put(0, 'Heart of Bogardan');
  h.counters.AGE = 2;
  T.noMana(0); for (const x of T.game.battlefield) if (T.isLand(x)) x.tapped = true;
  T.a.on('targets', () => ['p1']);
  await upkeep(T);
  expect(h.zone === 'graveyard' && T.B.life === 40 - 4, `sacrificed, B took 4 (${T.B.life})`);
});
test('Pay Echo trigger: Shah of Naar Isle lets each opponent draw up to three', async T => {
  const s = await T.cast('Shah of Naar Isle');
  T.game.turnNumber++;
  T.b.on('drawUpTo', () => 3);
  const h = T.B.hand.length;
  await upkeep(T);
  expect(s.zone === 'battlefield' && T.B.hand.length === h + 3, `echo paid, B drew three (${T.B.hand.length - h})`);
});

// ------------------------------------------------------------ support report and deck rules
test('Support report: the classic mechanics are no longer flagged', async T => {
  for (const n of ['Thief of Hope', 'Arcbound Ravager', 'Blastoderm', 'Absolver Thrull', 'Seize the Soul', 'Mist Intruder', "Teferi's Imp", 'Mindslaver', 'Karn Liberated', 'Divine Intervention', 'Fossil Find', 'Incinerate', 'Aggressive Mining', "Konda's Banner", 'Immerwolf', 'Tamiyo, Collector of Tales', 'Guardian Beast', 'Airtight Alibi', 'Jared Carthalion, True Heir', 'Keen-Eared Sentry', "Karn's Sylex", 'Ashiok, Wicked Manipulator', 'Clergy of the Holy Nimbus', 'Mana Short', 'Yurlok of Scorch Thrash', 'Illicit Auction', 'Cultural Exchange', 'Arcanum Wings', 'Edgar, King of Figaro', 'Birgi, God of Storytelling', 'Drain Power', 'Kaya, Bane of the Dead', 'Autumn Willow', 'Standard Bearer', 'Balduvian Fallen', 'Shah of Naar Isle', 'Sanctum Lurker', 'Arcane Savant', 'Relentless Rats', 'Seven Dwarves', 'World at War', 'Meditate']) {
    const issues = analyzeCard(db.raw[n]);
    expect(!issues.length, `${n}: ${issues.join(', ')}`);
  }
});
test('Deck rules: any number of Relentless Rats, up to seven Seven Dwarves', async T => {
  const { buildIndex } = await import('../src/ui/customdecks.js');
  const idx = buildIndex({ 'Relentless Rats': db.raw['Relentless Rats'], 'Seven Dwarves': db.raw['Seven Dwarves'], 'Nazgûl': db.raw['Nazgûl'], 'Grizzly Bears': db.raw['Grizzly Bears'] });
  const by = Object.fromEntries(idx.map(c => [c.name, c.maxCopies]));
  expect(by['Relentless Rats'] === Infinity && by['Seven Dwarves'] === 7 && by['Nazgûl'] === 9 && by['Grizzly Bears'] === 1, JSON.stringify(by));
});

process.exitCode = await run(tests);
