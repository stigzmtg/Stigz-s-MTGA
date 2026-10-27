// Behavioural tests for the casting mechanics (src/engine/mech-casting.js): alternative and additional costs, casting
// from other zones, cost types. Usage: node tools/mech-casting.mjs [name-filter]
import { setup, expect, run, db } from './lib/testkit.mjs';
import { castSpell, getActions, refOf, activatedAbilities, castableOptions, activateAbility, spellOptions } from '../src/engine/abilities.js';
import { matchValid, calcCtx } from '../src/engine/filters.js';
import { analyzeCard } from '../src/engine/support.js';

const tests = [];
const test = (name, fn, opts) => tests.push({ name, fn, opts });

const opt = (T, card, re) => castableOptions(T.game, 0, card).find(o => re.test(o.key) || re.test(o.label));
async function castWith(T, card, re, pid = 0) {
  const o = castableOptions(T.game, pid, card).find(x => re.test(x.key) || re.test(x.label));
  if (!o) throw new Error(`no option ${re} for ${card.def.name}: ${castableOptions(T.game, pid, card).map(x => x.key + ' ' + x.label).join(' | ')}`);
  T.game.priority = pid;
  const ok = await castSpell(T.game, pid, card, { optionKey: o.key });
  if (!ok) throw new Error(`could not cast ${card.def.name} (${o.label})`);
  return o;
}
async function endStep(T, pid = 0) {
  T.game.step = 'end';
  T.game.fire('Phase', { Phase: 'End of Turn', Player: pid });
  await T.resolve();
}
async function nextTurn(T, pid = 0) {
  T.game.turnNumber++;
  T.game.activePlayer = pid; T.game.priority = pid; T.game.step = 'main1';
  T.game.turnState = T.game.freshTurnState();
  for (const p of T.game.players) p.spellsCastThisTurn = [];
  T.game.touch();
}

// ------------------------------------------------------------ warp
test('Warp: cast for the warp cost, exiled at the next end step, cast from exile on a later turn', async T => {
  const g = T.game;
  const wurm = await T.put(0, 'Germinating Wurm', 'hand');
  T.mana(0);
  const o = opt(T, wurm, /^Warp/);
  expect(o && /Warp Germinating Wurm/.test(o.label), `a warp option with a label (${castableOptions(g, 0, wurm).map(x => x.label)})`);
  const life = T.A.life;
  await castWith(T, wurm, /^Warp/);
  expect(T.logged(/casts Germinating Wurm \(warp\)/), 'logged as warped');
  await T.resolve();
  expect(wurm.zone === 'battlefield' && T.A.life === life + 2, 'entered, ETB trigger');
  expect(calcCtx(g, 'Count$Void.1.0', { you: 0 }) === 1, 'void: a spell was warped this turn');
  await endStep(T);
  expect(wurm.zone === 'exile' && matchValid(g, wurm, 'Card.warped', { you: 0 }), `exiled at the end step (${wurm.zone})`);
  expect(!getActions(g, 0).some(a => a.cardId === wurm.id), 'not castable the turn it was exiled');
  await nextTurn(T);
  T.mana(0);
  const act = getActions(g, 0).find(a => a.cardId === wurm.id);
  expect(act && /warped/.test(act.label), `castable from exile on a later turn (${getActions(g, 0).filter(a => a.cardId === wurm.id).map(a => a.label)})`);
  await g.performAction(0, act); await T.resolve();
  expect(wurm.zone === 'battlefield', 'cast from exile');
  await endStep(T);
  expect(wurm.zone === 'battlefield', 'cast normally: it stays');
});
test('Warp: only from the hand; Timeline Culler warps from the graveyard (paying life), Tannuk gives warp', async T => {
  const g = T.game;
  const wurm = await T.put(0, 'Germinating Wurm', 'graveyard');
  T.mana(0);
  expect(!castableOptions(g, 0, wurm).length, 'no warp from the graveyard');
  const culler = await T.put(0, 'Timeline Culler', 'graveyard');
  const os = castableOptions(g, 0, culler);
  expect(os.length === 1 && os[0].altCost === 'Warp', `only its warp from the graveyard (${os.map(o => o.label)})`);
  const life = T.A.life;
  await castWith(T, culler, /Warp/);
  await T.resolve();
  expect(culler.zone === 'battlefield' && T.A.life === life - 2, 'warped from the graveyard, paid 2 life');
  await endStep(T);
  expect(culler.zone === 'exile', 'exiled at end step');
  g.step = 'main1';
  await T.put(0, 'Tannuk, Steadfast Second');
  const bolt = await T.put(0, 'Goblin Guide', 'hand');
  expect(castableOptions(g, 0, bolt).some(o => o.altCost === 'Warp'), 'a red creature card in hand has warp from Tannuk');
});

// ------------------------------------------------------------ sneak
test('Sneak: in the declare blockers step, return an unblocked attacker; the creature enters tapped and attacking', async T => {
  const g = T.game;
  const bear = await T.put(0, 'Grizzly Bears');
  const ninja = await T.put(0, 'Raphael, the Nightwatcher', 'hand');
  T.mana(0);
  expect(!castableOptions(g, 0, ninja).some(o => o.altCost === 'Sneak'), 'not in the main phase');
  T.combatWith([[bear, 1]]);
  g.step = 'declareBlockers';
  const o = opt(T, ninja, /Sneak/);
  expect(o, `a sneak option once an attacker is unblocked (${castableOptions(g, 0, ninja).map(x => x.label)})`);
  await castWith(T, ninja, /Sneak/);
  expect(bear.zone === 'hand', 'the attacker returned to hand');
  await T.resolve();
  expect(ninja.zone === 'battlefield' && ninja.tapped && g.isAttacking(ninja) && g.attackTargetOf(ninja) === 1 && !g.isBlocked(ninja), 'tapped and attacking the same player, unblocked');
  expect(matchValid(g, ninja, 'Card.sneaked', { you: 0 }), 'sneaked');
});

// ------------------------------------------------------------ web-slinging
test('Web-slinging: return a tapped creature you control; Scarlet Spider counts its mana value', async T => {
  const g = T.game;
  const giant = await T.put(0, 'Hill Giant');
  const spider = await T.put(0, 'Scarlet Spider, Ben Reilly', 'hand');
  T.mana(0);
  expect(!castableOptions(g, 0, spider).some(o => o.altCost === 'Web-slinging'), 'no tapped creature: no web-slinging');
  giant.tapped = true; g.touch();
  await castWith(T, spider, /Web/);
  expect(giant.zone === 'hand', 'returned the tapped creature');
  await T.resolve();
  expect(spider.zone === 'battlefield' && (spider.counters.P1P1 || 0) === 4, `enters with counters equal to the returned creature's mana value (${spider.counters.P1P1})`);
});

// ------------------------------------------------------------ freerunning
test('Freerunning: only after combat damage to a player by an Assassin or commander you controlled', async T => {
  const g = T.game;
  const c = await T.put(0, 'Monastery Raid', 'hand');
  T.mana(0);
  expect(!castableOptions(g, 0, c).some(o => o.altCost === 'Freerunning'), 'not yet');
  const assassin = await T.put(0, 'Royal Assassin');
  await g.dealDamage(assassin, T.B, 1, { combat: true });
  const o = castableOptions(g, 0, c).find(x => x.altCost === 'Freerunning');
  expect(o, 'after an Assassin dealt combat damage');
  T.noMana(0); T.A.pool.R = 1; T.A.pool.C = 3;
  T.a.on('xValue', () => 3);
  await castWith(T, c, /Freerunning/);
  await T.resolve();
  expect(T.A.exile.length >= 3, `exiled X = 3 cards (${T.A.exile.length})`);
});

// ------------------------------------------------------------ teamwork
test('Teamwork: tap creatures with total power N to get the bonus; Quantum Reduction with flash', async T => {
  const g = T.game;
  await T.put(0, 'Grizzly Bears'); await T.put(0, 'Grizzly Bears');
  const elf = await T.put(1, 'Llanowar Elves');
  T.a.on('teamwork', () => true);
  T.a.on('targets', req => req.cands.includes(refOf(elf)) ? [refOf(elf)] : undefined);
  const hand = T.A.hand.length;
  await T.cast('Beast Mode');
  // Beast Mode targets a creature: the AI picks; the +1/+1 counter shows teamwork
  const tapped = g.battlefield.filter(c => c.controller === 0 && c.tapped && T.isCreature(c)).length;
  expect(tapped >= 1, `creatures tapped for teamwork (${tapped})`);
  expect(g.battlefield.some(c => (c.counters.P1P1 || 0) === 1), 'the teamwork bonus (+1/+1 counter)');
  expect(T.A.hand.length === hand, 'cast from hand');
});
test('Teamwork: Count$Teamwork modes (Go Nuts! chooses both)', async T => {
  const g = T.game;
  const mine = await T.put(0, 'Hill Giant');
  const theirs = await T.put(1, 'Llanowar Elves');
  T.a.on('teamwork', () => true);
  const c = await T.put(0, 'Go Nuts!', 'hand');
  T.mana(0);
  T.a.on('modes', req => req.options.map(o => o.value).slice(0, req.max));
  T.a.on('targets', req => req.cands.includes(refOf(theirs)) ? [refOf(theirs)] : req.cands.includes(refOf(mine)) ? [refOf(mine)] : undefined);
  await castWith(T, c, /./);
  const item = g.stack[g.stack.length - 1];
  expect(item && item.sa.modes && item.sa.modes.length === 2, `both modes with teamwork (${item && item.sa.modes && item.sa.modes.length})`);
  await T.resolve();
  expect(theirs.zone === 'graveyard', 'fought');
});

// ------------------------------------------------------------ more than meets the eye, living metal
test('More Than Meets the Eye: cast converted for its cost; living metal is a creature on your turn', async T => {
  const g = T.game;
  const c = await T.put(0, 'Arcee, Sharpshooter', 'hand');
  T.mana(0);
  const o = opt(T, c, /converted/);
  expect(o && o.face === 1, `a converted option (${castableOptions(g, 0, c).map(x => x.label)})`);
  await castWith(T, c, /converted/);
  await T.resolve();
  expect(c.zone === 'battlefield' && c.face === 1 && c.transformed && g.name(c) === 'Arcee, Acrobatic Coupe', `entered converted (${g.name(c)})`);
  expect(T.isCreature(c), 'living metal: a creature during your turn');
  g.activePlayer = 1; g.touch();
  expect(!T.isCreature(c), 'not on an opponent’s turn');
});

// ------------------------------------------------------------ prototype
test('Prototype: Goring Warplow cast prototyped is a 1/1 with the prototype cost and color', async T => {
  const g = T.game;
  const c = await T.put(0, 'Goring Warplow', 'hand');
  T.mana(0);
  const o = opt(T, c, /prototyped/);
  expect(o, `a prototype option (${castableOptions(g, 0, c).map(x => x.label)})`);
  await castWith(T, c, /prototyped/);
  expect(g.chars(c).cmc === 2, `mana value 2 on the stack (${g.chars(c).cmc})`);
  await T.resolve();
  const ch = g.chars(c);
  expect(c.zone === 'battlefield' && ch.power === 1 && ch.toughness === 1 && ch.colors.has('B') && ch.cmc === 2, `a 1/1 black with mana value 2 (${ch.power}/${ch.toughness} ${[...ch.colors]} ${ch.cmc})`);
  await g.moveCard(c, 'hand');
  expect(g.chars(c).cmc === 6, 'back to normal outside the battlefield');
});

process.exit(await run(tests) ? 1 : 0);
