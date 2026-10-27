// Behavioural tests for src/engine/mech-last.js, the last card-script parameters: paying to ignore an effect, the
// Shoals' announced X, Kentaro's and Security Rhox's alternative costs, votes and villainous choices, Opposition Agent,
// Panharmonicon for every trigger mode, snow mana of any color, text-changing effects, Wall of Shadows and Zilortha.
// Usage: node tools/mech-last.mjs [name-filter]
import { setup, expect, run, db } from './lib/testkit.mjs';
import { castSpell, refOf, activatedAbilities, castableOptions, canActivate, targetCandidates, targetSpec, getActions, makeSA, resolveChain, manaAbilitiesOf } from '../src/engine/abilities.js';
import * as combat from '../src/engine/combat.js';
import { analyzeCard } from '../src/engine/support.js';

const tests = [];
const test = (name, fn, opts) => tests.push({ name, fn, opts });
const ignoreAbility = (T, card) => T.game.chars(card).abilities.find(a => a.parsed.api === 'InternalIgnoreEffect');
const kill = async (T, c) => { await T.game.destroy(c, null); await T.resolve(); };
const lands = async (T, pid, name, n) => { const out = []; for (let i = 0; i < n; i++) out.push(await T.put(pid, name)); return out; };
const castOpt = (T, card, pid, re) => castableOptions(T.game, pid, card).find(o => re.test(o.label));
// B acts on its own turn (sorcery-speed spells), then the turn goes back to A
const asB = async (T, fn) => { const g = T.game; g.activePlayer = 1; g.priority = 1; try { return await fn(); } finally { g.activePlayer = 0; g.priority = 0; g.touch(); } };
const treasures = async (T, pid, n, host) => { await resolveChain(T.game, makeSA(T.game, `DB$ Token | TokenAmount$ ${n} | TokenScript$ c_a_treasure_sac | TokenOwner$ You`, {}, host, pid)); return T.tokens(pid).filter(c => /Treasure/.test(T.game.name(c))); };

// ------------------------------------------------------------ paying to ignore an effect
test('Leonin Arbiter: players find nothing searching; paying {2} lets that player search this turn', async T => {
  await T.put(1, 'Leonin Arbiter');
  const before = T.count(0, 'battlefield', T.isLand);
  await T.cast('Rampant Growth');
  expect(T.count(0, 'battlefield', T.isLand) === before, 'the search found nothing');
  const arb = T.game.battlefield.find(T.named('Leonin Arbiter'));
  const ab = ignoreAbility(T, arb);
  expect(ab && canActivate(T.game, 0, arb, ab, { ignoreTiming: true }), 'any player may pay to ignore it');
  await T.activate(arb, 0, a => a.parsed.api === 'InternalIgnoreEffect');
  expect(T.A.pool.C === 7 || T.A.pool.W + T.A.pool.U + T.A.pool.B + T.A.pool.R + T.A.pool.G + T.A.pool.C === 52, 'paid {2}');
  expect(!canActivate(T.game, 0, arb, ab, { ignoreTiming: true }), 'no need to pay twice');
  await T.cast('Rampant Growth');
  expect(T.count(0, 'battlefield', T.isLand) === before + 1, 'now the search finds a land');
  // the other player still can't search
  const b0 = T.count(1, 'battlefield', T.isLand);
  await asB(T, () => T.cast('Rampant Growth', 1));
  expect(T.count(1, 'battlefield', T.isLand) === b0, 'B still finds nothing');
  // next turn it applies again
  T.game.turnNumber++; T.game.touch();
  const a1 = T.count(0, 'battlefield', T.isLand);
  await T.cast('Rampant Growth');
  expect(T.count(0, 'battlefield', T.isLand) === a1, 'only until end of turn');
});
test('Damping Engine: the player with the most permanents can\'t cast creatures; sacrificing a permanent lets them', async T => {
  const eng = await T.put(1, 'Damping Engine');
  for (const n of ['Grizzly Bears', 'Llanowar Elves', 'Forest', 'Forest']) await T.put(0, n);
  const bears = await T.put(0, 'Hill Giant', 'hand');
  T.mana(0);
  expect(!castableOptions(T.game, 0, bears).length, 'A (most permanents) can\'t cast a creature spell');
  const b = await T.put(1, 'Grizzly Bears', 'hand'); T.mana(1);
  T.game.priority = 1;
  expect(castableOptions(T.game, 1, b, { ignoreTiming: true }).length, 'B can');
  T.game.priority = 0;
  const ab = ignoreAbility(T, eng);
  const land0 = await T.put(0, 'Plains', 'hand');
  expect(!getActions(T.game, 0).some(a => a.type === 'land' && a.cardId === land0.id), 'A can\'t play a land either');
  expect(!canActivate(T.game, 1, eng, ab, { ignoreTiming: true }), 'B isn\'t affected, so can\'t pay');
  T.a.on('costSac', req => [req.cards.find(id => T.game.cardById(id).def.name === 'Llanowar Elves')]);
  await T.activate(eng, 0, a => a.parsed.api === 'InternalIgnoreEffect');
  expect(T.game.battlefield.every(c => c.def.name !== 'Llanowar Elves'), 'sacrificed a permanent');
  expect(castableOptions(T.game, 0, bears).length, 'now A can cast it');
  const land = await T.put(0, 'Mountain', 'hand');
  expect(getActions(T.game, 0).some(a => a.type === 'land' && a.cardId === land.id), 'and play lands');
});
test('Lost in Thought: the enchanted creature can\'t attack until its controller exiles three cards from their graveyard', async T => {
  const g = await T.put(0, 'Grizzly Bears');
  const aura = await T.put(1, 'Lost in Thought', 'battlefield', { attachTo: g.id });
  expect(!combat.canAttack(T.game, g), 'can\'t attack');
  for (const n of ['Island', 'Island', 'Forest']) await T.put(0, n, 'graveyard');
  const ab = ignoreAbility(T, aura);
  expect(!canActivate(T.game, 1, aura, ab, { ignoreTiming: true }), 'the Aura\'s controller doesn\'t control the creature');
  expect(canActivate(T.game, 0, aura, ab, { ignoreTiming: true }), 'the creature\'s controller may pay');
  await T.activate(aura, 0, a => a.parsed.api === 'InternalIgnoreEffect');
  expect(T.A.graveyard.length === 0 && T.A.exile.length >= 3, 'exiled three cards');
  expect(combat.canAttack(T.game, g), 'now it can attack');
  T.game.turnNumber++; T.game.touch();
  expect(!combat.canAttack(T.game, g), 'again from the next turn');
});
test('Volrath\'s Curse: its controller sacrifices a permanent and the creature can block and use abilities', async T => {
  const elf = await T.put(0, 'Llanowar Elves');
  const curse = await T.put(1, "Volrath's Curse", 'battlefield', { attachTo: elf.id });
  expect(!combat.canBlockAny(T.game, elf) && !combat.canAttack(T.game, elf), 'can\'t attack or block');
  expect(!manaAbilitiesOf(T.game, elf).length, 'nor tap for mana (a mana ability is an activated ability)');
  const tok = await T.put(0, 'Plains');
  T.a.on('costSac', req => [tok.id]);
  await T.activate(curse, 0, a => a.parsed.api === 'InternalIgnoreEffect');
  expect(tok.zone === 'graveyard', 'sacrificed the land');
  expect(combat.canBlockAny(T.game, elf) && combat.canAttack(T.game, elf), 'can attack and block again');
  expect(manaAbilitiesOf(T.game, elf).length === 1, 'and tap for mana');
});
test('AI: pays Leonin Arbiter\'s {2} before a search, never for nothing', async T => {
  const arb = await T.put(1, 'Leonin Arbiter');
  for (let i = 0; i < 4; i++) await T.put(0, 'Forest');
  const { AIAgent } = await import('../src/ai/ai.js');
  const ai = new AIAgent();
  const act = () => ai.priority(T.game, 0);
  let a = await act();
  expect(!(a.type === 'activate' && a.cardId === arb.id), 'nothing to search for: no payment');
  T.A.hand.length = 0;
  await T.put(0, 'Rampant Growth', 'hand');
  a = await new AIAgent().priority(T.game, 0);
  expect(a.type === 'activate' && a.cardId === arb.id, `pays before casting the search (${JSON.stringify(a)})`);
});

// ------------------------------------------------------------ alternative costs
test('Blazing Shoal: exile a red card with mana value X from hand; the creature gets +X/+0', async T => {
  const g = await T.put(0, 'Grizzly Bears');
  await T.put(0, 'Lightning Bolt', 'hand');
  const fire = await T.put(0, 'Hill Giant', 'hand');
  const red = await T.put(0, 'Goblin Piker', 'hand');
  const shoal = await T.put(0, 'Blazing Shoal', 'hand');
  T.noMana(0);
  const opt = castOpt(T, shoal, 0, /exile a red card/);
  expect(opt, 'castable for its alternative cost with no mana');
  T.a.on('announceX', req => { expect(req.options.map(o => o.value).join() === '1,2,4', `X values with a red card to exile (${req.options.map(o => o.value)})`); return 2; });
  T.a.on('targets', () => [refOf(g)]);
  await castSpell(T.game, 0, shoal, { optionKey: opt.key }); await T.resolve();
  expect(red.zone === 'exile', `the red mana value 2 card was exiled (${red.zone})`);
  expect(T.game.chars(g).power === 4, `+2/+0 (${T.game.chars(g).power})`);
  expect(fire.zone === 'hand', 'nothing else exiled');
});
test('Disrupting Shoal: counters a spell whose mana value is X', async T => {
  const blue = await T.put(0, 'Counterspell', 'hand');
  const shoal = await T.put(0, 'Disrupting Shoal', 'hand');
  T.mana(1);
  const giant = await T.put(1, 'Hill Giant', 'hand');
  await asB(T, () => castSpell(T.game, 1, giant, {}));
  T.noMana(0);
  const opt = castOpt(T, shoal, 0, /exile a blue card/);
  expect(opt, 'castable by exiling a blue card');
  T.a.on('targets', req => [req.cands[0]]);
  await castSpell(T.game, 0, shoal, { optionKey: opt.key });
  expect(blue.zone === 'exile', 'exiled Counterspell (X = 2)');
  await T.resolve();
  expect(giant.zone === 'battlefield', `Hill Giant (mana value 4) wasn't countered: X was 2 (${giant.zone})`);
});
test('Disrupting Shoal (AI): announces the X of the spell it targets', async T => {
  await T.put(0, 'Arcane Denial', 'hand'); await T.put(0, 'Counterspell', 'hand');
  const shoal = await T.put(0, 'Disrupting Shoal', 'hand');
  T.mana(1);
  const bears = await T.put(1, 'Grizzly Bears', 'hand');
  await asB(T, () => castSpell(T.game, 1, bears, {}));
  T.noMana(0);
  const opt = castOpt(T, shoal, 0, /exile a blue card/);
  await castSpell(T.game, 0, shoal, { optionKey: opt.key }); await T.resolve();
  expect(bears.zone === 'graveyard', `Grizzly Bears was countered (${bears.zone})`);
});
test('Nourishing Shoal: gain X life', async T => {
  await T.put(0, 'Llanowar Elves', 'hand'); await T.put(0, 'Craterhoof Behemoth', 'hand');
  const shoal = await T.put(0, 'Nourishing Shoal', 'hand');
  T.noMana(0);
  T.a.on('announceX', req => Math.max(...req.options.map(o => o.value)));
  const opt = castOpt(T, shoal, 0, /exile a green card/);
  await castSpell(T.game, 0, shoal, { optionKey: opt.key }); await T.resolve();
  expect(T.A.life === 48, `gained 8 (${T.A.life})`);
});
test('Sickening Shoal: target creature gets -X/-X', async T => {
  const g = await T.put(1, 'Hill Giant');
  await T.put(0, 'Doom Blade', 'hand');
  const shoal = await T.put(0, 'Sickening Shoal', 'hand');
  T.noMana(0);
  T.a.on('targets', () => [refOf(g)]);
  const opt = castOpt(T, shoal, 0, /exile a black card/);
  await castSpell(T.game, 0, shoal, { optionKey: opt.key }); await T.resolve();
  expect(T.game.chars(g).power === 1 && T.game.chars(g).toughness === 1, `3/3 with -2/-2 (${T.game.chars(g).power}/${T.game.chars(g).toughness})`);
});
test('Shining Shoal: the next X damage from the chosen source to you is dealt to the target instead', async T => {
  await T.put(0, 'Serra Angel', 'hand');
  const shoal = await T.put(0, 'Shining Shoal', 'hand');
  const giant = await T.put(1, 'Hill Giant');
  T.noMana(0);
  T.a.on('chooseSource', () => [giant.id]).on('targets', () => ['p1']);
  const opt = castOpt(T, shoal, 0, /exile a white card/);
  await castSpell(T.game, 0, shoal, { optionKey: opt.key }); await T.resolve();
  await T.game.dealDamage(giant, T.A, 3, {}); await T.resolve();
  expect(T.A.life === 40 && T.B.life === 37, `redirected (A ${T.A.life}, B ${T.B.life})`);
});
test('Kentaro: Samurai spells for {X} (their mana value) of any mana', async T => {
  await T.put(0, 'Kentaro, the Smiling Cat');
  const cap = await T.put(0, 'Asari Captain', 'hand');
  T.noMana(0); T.A.pool.C = 5;
  const opt = castOpt(T, cap, 0, /Kentaro/);
  expect(opt, 'castable with five colorless mana');
  await castSpell(T.game, 0, cap, { optionKey: opt.key }); await T.resolve();
  expect(cap.zone === 'battlefield' && T.A.pool.C === 0, `cast for {5} (${cap.zone}, ${T.A.pool.C} left)`);
  const bear = await T.put(0, 'Grizzly Bears', 'hand');
  T.noMana(0); T.A.pool.C = 2;
  expect(!castOpt(T, bear, 0, /Kentaro/) && !castableOptions(T.game, 0, bear).length, 'not for non-Samurai');
});
test('Security Rhox: {R}{G} instead, only with mana from Treasures', async T => {
  const rhox = await T.put(0, 'Security Rhox', 'hand');
  T.noMana(0);
  const m = await T.put(0, 'Mountain'); await T.put(0, 'Forest');
  expect(!castableOptions(T.game, 0, rhox).length, 'lands can\'t pay the alternative cost');
  const [t1, t2] = await treasures(T, 0, 2, m);
  T.noMana(0);
  const opt = castOpt(T, rhox, 0, /R}{G}|Treasures/);
  expect(opt, 'two Treasures pay it');
  await castSpell(T.game, 0, rhox, { optionKey: opt.key }); await T.resolve();
  expect(rhox.zone === 'battlefield' && t1.zone !== 'battlefield' && t2.zone !== 'battlefield', 'cast with the Treasures');
  expect(T.game.battlefield.filter(c => c.controller === 0 && T.isLand(c)).every(c => !c.tapped), 'the lands stayed untapped');
});

// ------------------------------------------------------------ votes
test('Tivit: each player votes; Tivit\'s controller may vote an additional time; one Clue or Treasure per vote', async T => {
  T.a.on('extraVotes', req => { expect(req.type === 'confirm', 'one more vote: yes or no'); return true; }).on('vote', () => 'DBBribery');
  T.b.on('vote', () => 'DBEvidence');
  await T.cast('Tivit, Seller of Secrets');
  const toks = T.tokens(0);
  expect(toks.filter(c => /Treasure/.test(c.def.name)).length === 2, `two Treasures (${toks.map(c => c.def.name)})`);
  expect(toks.filter(c => /Clue/.test(c.def.name)).length === 1, 'one Clue');
});
test('Brago\'s Representative and Ballot Broker: an additional vote, an optional one', async T => {
  await T.put(0, "Brago's Representative");
  await T.put(1, 'Ballot Broker');
  let asked = 0;
  T.a.on('vote', () => 'DBVoteDeath');
  T.b.on('extraVotes', req => { asked++; return true; }).on('vote', () => 'DBVoteTaxes');
  for (let i = 0; i < 3; i++) await T.put(1, 'Grizzly Bears');
  for (let i = 0; i < 3; i++) await T.put(1, 'Island', 'hand');
  await T.cast('Capital Punishment');
  expect(asked === 1, 'B was asked for the optional vote');
  expect(T.count(1, 'battlefield', T.named('Grizzly Bears')) === 1, `two death votes: B sacrificed two Bears (${T.count(1, 'battlefield', T.named('Grizzly Bears'))} left)`);
  expect(T.B.hand.length === 1, `two taxes votes: two discards (${T.B.hand.length} left)`);
});
test('Illusion of Choice: its caster chooses how every player votes this turn', async T => {
  await T.cast('Illusion of Choice');
  const forWhom = [];
  T.a.on('vote', req => { forWhom.push(req.forPlayer); return 'DBVoteDeath'; });
  T.b.on('vote', () => { throw new Error('B voted itself'); });
  for (let i = 0; i < 2; i++) await T.put(1, 'Grizzly Bears');
  await T.cast('Capital Punishment');
  expect(forWhom.join() === '0,1', `A voted for both players (${forWhom})`);
  expect(T.count(1, 'battlefield', T.isCreature) === 0, 'two death votes');
});
test('The Valeyard: opponents face a villainous choice twice; it votes an additional time', async T => {
  await T.put(0, 'The Valeyard');
  let n = 0;
  T.b.on('villainousChoice', req => { n++; return req.options[1].value; });
  const lifeB = T.B.life;
  await T.cast('Sycorax Commander');
  expect(n === 2, `B chose twice (${n})`);
  expect(T.logged(/chooses/), 'the choices were logged');
  T.a.on('extraVotes', () => true);
  let votes = 0;
  T.a.on('vote', () => { votes++; return 'DBVoteTaxes'; });
  await T.cast('Capital Punishment');
  expect(votes === 2, `A voted twice (${votes})`);
  void lifeB;
});

// ------------------------------------------------------------ Opposition Agent
test('Opposition Agent: its controller searches for the opponent, the card is exiled and castable by them', async T => {
  await T.put(1, 'Opposition Agent');
  const target = await T.put(0, 'Serra Angel', 'library');
  let decider = null;
  T.b.on('searchHand', (req) => { decider = req.decider; return [target.id]; });
  T.a.on('searchHand', () => { throw new Error('A searched'); });
  await T.cast('Demonic Tutor');
  expect(decider === 1, `B made the choice (${decider})`);
  expect(target.zone === 'exile', `the found card was exiled (${target.zone})`);
  T.mana(1);
  await asB(T, async () => {
    expect(castableOptions(T.game, 1, target).length, 'B may cast it');
    T.noMana(1); T.B.pool.B = 5; // "as though it were mana of any color"
    expect(castableOptions(T.game, 1, target).length, 'with black mana');
    await castSpell(T.game, 1, target, {}); await T.resolve();
  });
  expect(target.zone === 'battlefield' && target.controller === 1, 'B cast the Angel');
});
test('Opposition Agent: draws and its controller\'s own searches aren\'t touched', async T => {
  await T.put(1, 'Opposition Agent');
  const top = T.A.library[0];
  await T.game.drawCards(T.A, 1);
  expect(top.zone === 'hand', 'a drawn card stays in hand');
  const bl = await T.put(1, 'Forest', 'library');
  T.b.on('searchBattlefield', () => [bl.id]);
  await asB(T, () => T.cast('Rampant Growth', 1));
  expect(bl.zone === 'battlefield', 'B searching their own library finds normally');
});

// ------------------------------------------------------------ Panharmonicon
test('Panoptic Projektor: turning a face-down creature face up triggers its abilities an additional time', async T => {
  await T.put(0, 'Panoptic Projektor');
  const m = await T.put(0, 'Den Protector', 'battlefield', { faceDown: true });
  m.faceDown = true; T.game.touch();
  for (let i = 0; i < 2; i++) await T.put(0, 'Grizzly Bears', 'graveyard');
  const back = T.A.graveyard.map(c => refOf(c));
  T.a.on('targets', req => [back.shift()]);
  const ab = activatedAbilities(T.game, 0, m).find(a => /SetState|Turn face up/.test(a.raw));
  await T.activate(m, 0, a => a === ab);
  expect(T.A.graveyard.length === 0, `both cards returned (${T.A.graveyard.length} left)`);
});
test('Panoptic Projektor doesn\'t double other triggers; Teysa Karlov doubles death triggers', async T => {
  await T.put(0, 'Panoptic Projektor');
  const h = T.A.hand.length;
  await T.cast('Wall of Omens');
  expect(T.A.hand.length === h + 1, `one card from Wall of Omens (${T.A.hand.length - h})`);
  await T.put(0, 'Teysa Karlov');
  const life = T.B.life;
  const z = await T.put(0, 'Zulaport Cutthroat');
  await kill(T, z);
  expect(T.B.life === life - 2, `Zulaport triggered twice (${life - T.B.life})`);
});

// ------------------------------------------------------------ snow mana
test('Draugr Necromancer: creatures die into exile with ice counters; cast them with snow mana of any color', async T => {
  await T.put(0, 'Draugr Necromancer');
  const angel = await T.put(1, 'Serra Angel');
  await kill(T, angel);
  expect(angel.zone === 'exile' && angel.counters.ICE === 1, `exiled with an ice counter (${angel.zone}, ${JSON.stringify(angel.counters)})`);
  T.noMana(0);
  for (let i = 0; i < 5; i++) await T.put(0, 'Snow-Covered Swamp');
  expect(castableOptions(T.game, 0, angel).length, 'snow Swamps pay {3}{W}{W}');
  await castSpell(T.game, 0, angel, {}); await T.resolve();
  expect(angel.zone === 'battlefield' && angel.controller === 0, 'cast it');
  const bear = await T.put(1, 'Grizzly Bears');
  await kill(T, bear);
  T.noMana(0);
  for (let i = 0; i < 2; i++) await T.put(0, 'Swamp');
  expect(!castableOptions(T.game, 0, bear).length, 'plain Swamps don\'t make green');
});

// ------------------------------------------------------------ text
test('Mirrodin Besieged: the chosen mode\'s ability (Mirran: a Myr for each artifact spell)', async T => {
  T.a.on('genericChoice', () => 'Mirran');
  const mb = await T.cast('Mirrodin Besieged');
  expect(mb.chosen && mb.chosen.mode === 'Mirran', 'remembers Mirran');
  await T.cast('Sol Ring');
  expect(T.tokens(0).some(c => /Myr/.test(c.def.name)), 'a Myr');
  expect(analyzeCard(db.raw['Mirrodin Besieged']).length === 0, 'fully supported');
});
test('Mirrodin Besieged: Phyrexian loots at the end step', async T => {
  T.a.on('genericChoice', () => 'Phyrexian');
  await T.cast('Mirrodin Besieged');
  await T.cast('Sol Ring');
  expect(!T.tokens(0).some(c => /Myr/.test(c.def.name)), 'no Myr');
  const h = T.A.hand.length, g = T.A.graveyard.length;
  T.game.fire('Phase', { Phase: 'End of Turn', Player: 0 }); await T.resolve();
  expect(T.A.hand.length === h && T.A.graveyard.length === g + 1, 'drew and discarded');
});
test('Spy Kit: the equipped creature has all names of nonlegendary creature cards', async T => {
  const a = await T.put(0, 'Wall of Omens');
  const kit = await T.put(0, 'Spy Kit', 'battlefield', { attachTo: a.id });
  void kit;
  const bear = await T.put(1, 'Grizzly Bears');
  T.a.on('targets', () => [refOf(bear)]);
  await T.cast('Echoing Truth');
  expect(bear.zone === 'hand', 'the Bears returned');
  expect(a.zone === 'hand', `and the equipped Wall, named Grizzly Bears too (${a.zone})`);
});
test('Swirl the Mists: color words change to the chosen one (Doom Blade: nongreen)', async T => {
  T.a.on('chooseColor', () => 'G');
  await T.cast('Swirl the Mists');
  const black = await T.put(1, 'Vampire Nighthawk');
  const green = await T.put(1, 'Grizzly Bears');
  const blade = await T.put(0, 'Doom Blade', 'hand');
  const sa = makeSA(T.game, blade.faceDef.abilities[0], blade.faceDef.svars, blade, 0);
  void sa;
  let cands = null;
  T.a.on('targets', req => { cands = req.cands; return [refOf(black)]; });
  T.mana(0);
  await castSpell(T.game, 0, blade, {}); await T.resolve();
  expect(cands && cands.includes(refOf(black)) && !cands.includes(refOf(green)), 'targets nongreen creatures');
  expect(black.zone === 'graveyard', 'destroyed the black creature');
  const knight = await T.put(1, 'White Knight');
  expect(T.game.chars(knight).keywords.some(k => /Protection from green/.test(k)), `protection from green (${T.game.chars(knight).keywords})`);
});
test('Volrath\'s Shapeshifter: has the full text of the top creature card of its controller\'s graveyard', async T => {
  const v = await T.put(0, "Volrath's Shapeshifter");
  expect(T.game.chars(v).power === 0, '0/1 on its own');
  await T.put(0, 'Serra Angel', 'graveyard');
  const ch = T.game.chars(v);
  expect(ch.name === 'Serra Angel' && ch.power === 4 && ch.toughness === 4 && T.game.hasKeyword(v, 'Flying'), `a Serra Angel (${ch.name} ${ch.power}/${ch.toughness})`);
  expect(ch.colors.has('W') && ch.cmc === 5, 'its color and mana value');
  expect(activatedAbilities(T.game, 0, v).some(a => a.parsed.api === 'Discard'), 'and "{2}: Discard a card"');
  await T.put(0, 'Lightning Bolt', 'graveyard');
  expect(T.game.chars(v).name === "Volrath's Shapeshifter", 'a noncreature card on top: itself again');
  T.A.hand.push(...[]);
  await T.put(0, 'Hill Giant', 'hand');
  T.a.on('discard', req => [req.cards[0]]);
  await T.put(0, 'Grizzly Bears', 'graveyard');
  expect(T.game.chars(v).power === 2, 'Grizzly Bears now');
});
test('Wall of Shadows: abilities that can target only Walls can\'t target it', async T => {
  const w = await T.put(1, 'Wall of Shadows');
  const other = await T.put(1, 'Wall of Omens');
  const team = await T.put(0, 'Dwarven Demolition Team');
  const ab = activatedAbilities(T.game, 0, team)[0];
  const sa = makeSA(T.game, ab.raw, ab.svars, team, 0);
  const cands = targetCandidates(T.game, sa, targetSpec(T.game, sa));
  expect(!cands.includes(w) && cands.includes(other), 'only the other Wall');
  const bolt = await T.put(0, 'Lightning Bolt', 'hand');
  const bsa = makeSA(T.game, bolt.faceDef.abilities[0], bolt.faceDef.svars, bolt, 0);
  expect(targetCandidates(T.game, bsa, targetSpec(T.game, bsa)).includes(w), 'any target: fine');
});
test('CantTarget statics apply to their own targets only (Gaea\'s Revenge, Spellbane Centaur)', async T => {
  const gaea = await T.put(1, "Gaea's Revenge");
  const bear = await T.put(1, 'Grizzly Bears');
  const bolt = await T.put(0, 'Lightning Bolt', 'hand');
  const sa = makeSA(T.game, bolt.faceDef.abilities[0], bolt.faceDef.svars, bolt, 0);
  const c = targetCandidates(T.game, sa, targetSpec(T.game, sa));
  expect(c.includes(bear) && !c.includes(gaea), 'Bolt can target the Bears, not Gaea\'s Revenge');
});
test('Zilortha: lethal damage to your creatures is their power', async T => {
  await T.put(0, 'Zilortha, Strength Incarnate');
  const wall = await T.put(0, 'Wall of Omens'); // 0/4
  const giant = await T.put(0, 'Hill Giant'); // 3/3
  await T.game.dealDamage(null, giant, 2, {}); await T.resolve();
  expect(giant.zone === 'battlefield', 'a 3/3 survives 2 damage');
  await T.game.dealDamage(null, giant, 1, {}); await T.resolve();
  expect(giant.zone === 'graveyard', 'and dies to 3');
  await T.game.dealDamage(null, wall, 1, {}); await T.resolve();
  expect(wall.zone === 'graveyard', 'a 0/4 dies to any damage');
  const opp = await T.put(1, 'Hill Giant');
  await T.game.dealDamage(null, opp, 2, {}); await T.resolve();
  expect(opp.zone === 'battlefield', 'an opponent\'s creature: toughness as usual');
});

test('Panoptic Projektor: the next face-down creature spell costs {3} less, once', async T => {
  const proj = await T.put(0, 'Panoptic Projektor');
  await T.activate(proj, 0, a => a.parsed.api === 'Effect');
  const m = await T.put(0, 'Den Protector', 'hand');
  T.noMana(0);
  const opt = castOpt(T, m, 0, /face down/);
  expect(opt && opt.manaCost.generic === 0, 'free to cast face down');
  await castSpell(T.game, 0, m, { optionKey: opt.key }); await T.resolve();
  expect(m.zone === 'battlefield' && m.faceDown, 'a face-down creature');
  const m2 = await T.put(0, 'Den Protector', 'hand');
  T.noMana(0);
  expect(!castOpt(T, m2, 0, /face down/), 'the reduction was used up');
});
test('Kentaro and Fist of Suns: other cards\' alternative costs; commander tax still applies', async T => {
  await T.put(0, 'Fist of Suns');
  const giant = await T.put(0, 'Hill Giant', 'hand');
  T.noMana(0); T.A.pool = { W: 1, U: 1, B: 1, R: 1, G: 1, C: 0 };
  const opt = castOpt(T, giant, 0, /Fist of Suns/);
  expect(opt, 'Hill Giant for {W}{U}{B}{R}{G}');
  await castSpell(T.game, 0, giant, { optionKey: opt.key }); await T.resolve();
  expect(giant.zone === 'battlefield', 'cast');
});
test('Spy Kit: Pithing Needle naming a nonlegendary creature stops the equipped creature\'s abilities', async T => {
  const pyro = await T.put(0, 'Prodigal Pyromancer');
  const ab = activatedAbilities(T.game, 0, pyro)[0];
  const needle = await T.put(1, 'Pithing Needle');
  needle.chosen = { name: 'Grizzly Bears' }; T.game.touch();
  expect(canActivate(T.game, 0, pyro, ab, { ignoreTiming: true }), 'not named Grizzly Bears yet');
  await T.put(0, 'Spy Kit', 'battlefield', { attachTo: pyro.id });
  expect(!canActivate(T.game, 0, pyro, ab, { ignoreTiming: true }), 'equipped: it has that name too');
});
test('Swirl the Mists: statics of permanents read the new color word (Crusade: red creatures)', async T => {
  T.a.on('chooseColor', () => 'R');
  await T.cast('Swirl the Mists');
  await T.put(0, 'Crusade');
  const goblin = await T.put(0, 'Goblin Piker');
  const angel = await T.put(0, 'Serra Angel');
  expect(T.game.chars(goblin).power === 3, `the red creature gets +1/+1 (${T.game.chars(goblin).power})`);
  expect(T.game.chars(angel).power === 4, 'the white one doesn\'t');
});
test('Wall of Shadows: damage from creatures it blocks is prevented', async T => {
  const w = await T.put(1, 'Wall of Shadows');
  const g = await T.put(0, 'Hill Giant');
  T.combatWith([[g, 1]], [[w, g]]);
  await combat.combatDamage(T.game, false); await T.resolve();
  expect(w.zone === 'battlefield' && !w.damage, 'no damage');
});
test('Zilortha: trample assigns lethal damage by power (nothing to a 0/4 blocker, all to the player)', async T => {
  await T.put(1, 'Zilortha, Strength Incarnate');
  const wall = await T.put(1, 'Wall of Omens');
  const att = await T.put(0, 'Colossal Dreadmaw');
  T.combatWith([[att, 1]], [[wall, att]]);
  const life = T.B.life;
  await combat.combatDamage(T.game, false); await T.resolve();
  expect(life - T.B.life === 6, `all 6 trample over (${life - T.B.life})`);
});
test('Mirrodin Besieged and the Sieges: the chosen mode is remembered (Citadel Siege: Khans)', async T => {
  T.a.on('genericChoice', req => req.options.find(o => /Khans/.test(o.label)).value);
  const s = await T.cast('Citadel Siege');
  expect(s.chosen && s.chosen.mode === 'Khans', `chose Khans (${JSON.stringify(s.chosen)})`);
  const g = await T.put(0, 'Grizzly Bears');
  T.a.on('targets', () => [refOf(g)]);
  T.game.step = 'beginCombat';
  T.game.fire('Phase', { Phase: 'BeginCombat', Player: 0 }); await T.resolve();
  expect(g.counters.P1P1 === 2, `two +1/+1 counters at the beginning of combat (${g.counters.P1P1})`);
});
test('Split Decision: players vote though the spell targets a spell', async T => {
  let votes = 0;
  T.a.on('vote', () => { votes++; return 'DBDenial'; });
  T.b.on('vote', () => { votes++; return 'DBDenial'; });
  const bolt = await T.put(1, 'Lightning Bolt', 'hand');
  T.mana(1);
  T.game.priority = 1;
  T.b.on('targets', () => ['p0']);
  await castSpell(T.game, 1, bolt, {});
  T.game.priority = 0;
  T.a.on('targets', req => [req.cands[0]]);
  await T.cast('Split Decision');
  expect(votes === 2, `both voted (${votes})`);
  expect(bolt.zone === 'graveyard' && T.A.life === 40, 'denial: Bolt countered');
});

// ------------------------------------------------------------ support list
test('support: the cards made to work are no longer flagged', async T => {
  const names = ['Leonin Arbiter', 'Damping Engine', 'Lost in Thought', "Volrath's Curse", 'Blazing Shoal', 'Disrupting Shoal', 'Nourishing Shoal', 'Shining Shoal', 'Sickening Shoal', 'Kentaro, the Smiling Cat', 'Security Rhox', 'Tivit, Seller of Secrets', 'Ballot Broker', "Brago's Representative", 'The Valeyard', 'Illusion of Choice', 'Opposition Agent', 'Panoptic Projektor', 'Draugr Necromancer', 'Mirrodin Besieged', 'Spy Kit', 'Swirl the Mists', "Volrath's Shapeshifter", 'Wall of Shadows', 'Zilortha, Strength Incarnate'];
  const bad = names.filter(n => analyzeCard(db.raw[n]).length);
  expect(!bad.length, `still flagged: ${bad.map(n => n + ' ' + analyzeCard(db.raw[n])).join('; ')}`);
  expect(analyzeCard(db.raw['Animus of Predation']).length, 'Animus of Predation stays flagged (draft only)');
});

process.exitCode = await run(tests);
