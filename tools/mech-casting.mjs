// Behavioural tests for the casting mechanics (src/engine/mech-casting.js): alternative and additional costs, casting
// from other zones, cost types. Usage: node tools/mech-casting.mjs [name-filter]
import { setup, expect, run, db } from './lib/testkit.mjs';
import { castSpell, getActions, refOf, activatedAbilities, castableOptions, activateAbility, spellOptions, canActivate } from '../src/engine/abilities.js';
const require_canActivate = (g, card, abil) => canActivate(g, 0, card, abil);
import { matchValid, calcCtx, resolveDefined, ctxOf } from '../src/engine/filters.js';
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


// ------------------------------------------------------------ prepare
test('Prepare: enters prepared; cast a copy of its spell from exile, which unprepares it', async T => {
  const g = T.game;
  const eater = await T.put(0, 'Adventurous Eater', 'hand');
  T.mana(0);
  expect(castableOptions(g, 0, eater).length === 1, `only the creature is cast from hand (${castableOptions(g, 0, eater).map(o => o.label)})`);
  await castWith(T, eater, /./);
  await T.resolve();
  expect(eater.zone === 'battlefield' && matchValid(g, eater, 'Card.prepared', { you: 0 }), 'enters prepared');
  const copy = T.A.exile.find(c => c.preparedFrom);
  expect(copy && g.name(copy) === 'Have a Bite', `a copy of its spell waits in exile (${copy && g.name(copy)})`);
  const act = getActions(g, 0).find(a => a.cardId === copy.id);
  expect(act && /prepared spell/.test(act.label), 'castable from exile');
  const life = T.A.life;
  T.a.on('targets', req => req.cands.includes(refOf(eater)) ? [refOf(eater)] : undefined);
  await g.performAction(0, act);
  expect(!matchValid(g, eater, 'Card.prepared', { you: 0 }), 'unprepared as the copy is cast');
  await T.resolve();
  expect(eater.counters.P1P1 === 1 && T.A.life === life + 1, 'the copy resolved');
  expect(!T.A.exile.includes(copy) && !T.A.graveyard.includes(copy), 'the copy ceased to exist');
  expect(!getActions(g, 0).some(a => a.cardId === copy.id), 'nothing more to cast');
});
test('Prepare: leaving the battlefield or becoming unprepared removes the copy; Codie copies prepared spells', async T => {
  const g = T.game;
  const eater = await T.cast('Adventurous Eater');
  const copy = T.A.exile.find(c => c.preparedFrom);
  expect(copy, 'prepared');
  await g.moveCard(eater, 'graveyard');
  expect(copy.zone === 'gone' && !T.A.exile.includes(copy), 'the copy is gone when the creature dies');
  await T.put(0, 'Codie, Ravenous Codex');
  const e2 = await T.cast('Adventurous Eater');
  const c2 = T.A.exile.find(c => c.preparedFrom);
  T.a.on('targets', req => req.cands.includes(refOf(e2)) ? [refOf(e2)] : undefined);
  T.a.on('newTargets', () => false);
  T.mana(0);
  await g.performAction(0, getActions(g, 0).find(a => a.cardId === c2.id));
  await T.resolve();
  expect(e2.counters.P1P1 === 2, `Codie copied the prepared spell (${e2.counters.P1P1})`);
  expect(!analyzeCard(db.raw['Adventurous Eater']).includes('Prepare') && !analyzeCard(db.raw['Dirgur Focusmage']).includes('Prepare'), 'prepare cards have their spell (Dirgur Focusmage\'s is copied from Braingeyser)');
});
test('Prepare from a copied face: Dirgur Focusmage prepares Braingeyser after a big spell from hand', async T => {
  const g = T.game;
  const mage = await T.put(0, 'Dirgur Focusmage');
  expect(!T.A.exile.some(c => c.preparedFrom), 'not prepared yet');
  await T.cast('Overwhelming Stampede');
  const copy = T.A.exile.find(c => c.preparedFrom);
  expect(copy && g.name(copy) === 'Braingeyser', `a mana value 5 sorcery from hand prepares it: Braingeyser waits in exile (${copy && g.name(copy)})`);
  T.mana(0);
  const act = getActions(g, 0).find(a => a.cardId === copy.id);
  expect(act, 'the copy can be cast');
  const hand = T.A.hand.length;
  T.a.on('targets', req => req.cands.includes('p0') ? ['p0'] : undefined);
  T.a.on('number', () => 2);
  await g.performAction(0, act);
  await T.resolve();
  expect(T.A.hand.length >= hand + 2, `Braingeyser drew cards (${hand} -> ${T.A.hand.length})`);
  expect(!matchValid(g, mage, 'Card.prepared', { you: 0 }), 'the mage is unprepared');
});

// ------------------------------------------------------------ splice
test('Splice onto Arcane: Evermind adds "draw a card" to Glacial Ray and stays in hand', async T => {
  const g = T.game;
  const ever = await T.put(0, 'Evermind', 'hand');
  const elf = await T.put(1, 'Llanowar Elves');
  T.a.on('splice', req => req.cards);
  T.a.on('targets', req => req.cands.includes(refOf(elf)) ? [refOf(elf)] : undefined);
  const hand = T.A.hand.length;
  const ray = await T.cast('Glacial Ray', 0, { resolve: false });
  expect(T.A.hand.length === hand, 'Evermind still in hand');
  await T.resolve();
  expect(elf.zone === 'graveyard', 'the ray dealt its damage');
  expect(T.A.hand.length === hand + 1 && ever.zone === 'hand', `drew a card from the spliced effect (${T.A.hand.length - hand})`);
  expect(T.logged(/splices it onto Glacial Ray/), 'logged');
});
test('Splice: Torrent of Stone (sacrifice two Mountains) — not offered without the Mountains', async T => {
  const g = T.game;
  await T.put(0, 'Torrent of Stone', 'hand');
  T.a.on('splice', req => { throw new Error('splice offered without Mountains'); });
  for (const c of [...g.battlefield]) if (c.controller === 0) await g.moveCard(c, 'graveyard', { silent: true });
  await T.cast('Evermind', 0);
});

// ------------------------------------------------------------ craft
test('Craft: exile Braided Net and an artifact from your graveyard to return it transformed', async T => {
  const g = T.game;
  const net = await T.put(0, 'Braided Net');
  const ring = await T.put(0, 'Sol Ring', 'graveyard');
  const abil = activatedAbilities(g, 0, net).find(a => a.parsed.p.Craft);
  expect(abil, 'a craft ability');
  T.mana(0);
  await T.activate(net, 0, a => a.parsed.p.Craft);
  expect(net.zone === 'battlefield' && net.face === 1 && g.name(net) === 'Braided Quipu', `returned transformed (${g.name(net)} in ${net.zone})`);
  expect(ring.zone === 'exile' && ring.exiledWith === net.id, 'the material is exiled with it');
});
test('Craft with X: Altar of the Wretched exiles one or more creatures; nothing to craft with: no ability', async T => {
  const g = T.game;
  for (const c of [...g.battlefield]) if (T.isCreature(c)) await g.moveCard(c, 'graveyard', { silent: true });
  for (const c of [...T.A.graveyard]) await g.moveCard(c, 'exile', { silent: true });
  const altar = await T.put(0, 'Altar of the Wretched');
  T.a.on('optionalTrigger', () => false); T.a.on('triggerCost', () => false);
  await T.resolve();
  T.mana(0);
  expect(!activatedAbilities(g, 0, altar).filter(a => a.parsed.p.Craft).some(a => (g.priority = 0, true) && require_canActivate(g, altar, a)), 'no creatures: craft unavailable');
  const a = await T.put(0, 'Grizzly Bears', 'graveyard'), b = await T.put(0, 'Hill Giant', 'graveyard');
  T.a.on('xValue', () => 2);
  await T.activate(altar, 0, x => x.parsed.p.Craft);
  expect(altar.face === 1 && a.zone === 'exile' && b.zone === 'exile', 'crafted with two creature cards');
  const ch = g.chars(altar);
  expect(ch.power === 5, `power is the total power of the exiled cards (${ch.power})`);
  expect(!g.hasKeyword(altar, 'Flying') && !g.hasKeyword(altar, 'Double Strike'), 'only the keywords the exiled cards have');
});
test('Craft: Wretched Bonemass shares the exiled cards’ keywords; Sunbird Effigy makes their colors', async T => {
  const g = T.game;
  const altar = await T.put(0, 'Altar of the Wretched');
  T.a.on('optionalTrigger', () => false); T.a.on('triggerCost', () => false);
  await T.resolve();
  for (const c of [...T.A.graveyard]) await g.moveCard(c, 'exile', { silent: true });
  await T.put(0, 'Serra Angel', 'graveyard');
  T.a.on('xValue', () => 1);
  await T.activate(altar, 0, x => x.parsed.p.Craft);
  expect(g.hasKeyword(altar, 'Flying') && g.hasKeyword(altar, 'Vigilance') && !g.hasKeyword(altar, 'Trample'), `flying and vigilance from Serra Angel (${g.chars(altar).keywords})`);
  const sb = await T.put(0, 'Sunbird Standard');
  await T.put(0, 'Llanowar Elves');
  for (const c of [...T.A.graveyard]) await g.moveCard(c, 'exile', { silent: true });
  await T.put(0, 'Goblin Guide', 'graveyard'); await T.put(0, 'Wall of Omens', 'graveyard');
  T.a.on('xValue', () => 2);
  T.a.on('costExileCtrlOrGrave', req => req.cards.filter(id => g.cardById(id).zone === 'graveyard').slice(0, 2));
  await T.activate(sb, 0, x => x.parsed.p.Craft);
  const { producedUnits, manaAbilitiesOf } = await import('../src/engine/abilities.js');
  const ab = manaAbilitiesOf(g, sb)[0];
  const units = producedUnits(g, sb, ab).map(u => u.join('')).sort().join(',');
  expect(units === 'R,W', `red and white mana from the exiled Goblin Guide and Wall of Omens (${units})`);
});

// ------------------------------------------------------------ assist, conspire, ripple, epic, paradigm
test('Assist: another player pays part of the generic mana', async T => {
  const g = T.game;
  const big = await T.put(1, 'Hill Giant'); T.game.chars(big);
  const troll = await T.put(1, 'Craw Wurm');
  const bd = await T.put(0, 'Bring Down', 'hand');
  T.mana(0); T.mana(1);
  T.a.on('assist', req => req.type === 'option' ? 1 : undefined);
  T.b.on('assist', req => req.max);
  T.a.on('targets', req => req.cands.includes(refOf(troll)) ? [refOf(troll)] : undefined);
  const before = Object.values(T.B.pool).reduce((a, b) => a + b, 0);
  await castWith(T, bd, /./);
  await T.resolve();
  const paid = before - Object.values(T.B.pool).reduce((a, b) => a + b, 0);
  expect(troll.zone === 'graveyard', 'destroyed');
  expect(paid === 3, `the helper paid the generic part (${paid})`);
});
test('Conspire: tap two creatures sharing a color to copy Burn Trail', async T => {
  const g = T.game;
  await T.put(0, 'Goblin Guide'); await T.put(0, 'Goblin Guide');
  T.a.on('conspire', req => req.cards.slice(0, 2));
  T.a.on('newTargets', () => false);
  const life = T.B.life;
  T.a.on('targets', req => req.cands.includes(refOf(T.B)) ? [refOf(T.B)] : undefined);
  await T.cast('Burn Trail');
  expect(T.B.life === life - 6, `copied (${life - T.B.life} damage)`);
});
test('Ripple: Surging Flame casts the copies of itself among the top four cards', async T => {
  const g = T.game;
  const lib = T.A.library;
  const other = await T.put(0, 'Surging Flame', 'library');
  T.a.on('targets', req => req.cands.includes(refOf(T.B)) ? [refOf(T.B)] : undefined);
  const life = T.B.life;
  await T.cast('Surging Flame');
  expect(T.B.life === life - 4 && other.zone === 'graveyard', `the second Surging Flame was cast (${life - T.B.life})`);
  expect(!lib.slice(0, 3).some(c => c.def.name === 'Surging Flame'), 'the rest went to the bottom');
});
test('Epic: Endless Swarm — no more spells, a copy each upkeep', async T => {
  const g = T.game;
  await T.put(0, 'Grizzly Bears', 'hand'); await T.put(0, 'Grizzly Bears', 'hand');
  await T.cast('Endless Swarm');
  const n1 = T.tokens(0).length;
  expect(n1 >= 2, `snakes (${n1})`);
  const bolt = await T.put(0, 'Lightning Bolt', 'hand');
  T.mana(0);
  expect(!castableOptions(g, 0, bolt).length, 'no more spells for the rest of the game');
  g.step = 'upkeep';
  g.fire('Phase', { Phase: 'Upkeep', Player: 0 });
  await T.resolve();
  expect(T.tokens(0).length > n1, `a copy at the upkeep (${T.tokens(0).length - n1} more)`);
});
test('Paradigm: Germination Practicum is exiled; a free copy at the first main phase', async T => {
  const g = T.game;
  const bear = await T.put(0, 'Grizzly Bears');
  const c = await T.cast('Germination Practicum');
  expect(c.zone === 'exile' && bear.counters.P1P1 === 2, 'resolved, then exiled');
  T.noMana(0);
  g.fire('Phase', { Phase: 'Main1', Player: 0 });
  await T.resolve();
  expect(bear.counters.P1P1 === 4 && c.zone === 'exile', `a copy was cast for free (${bear.counters.P1P1})`);
  expect(g.effects.filter(e => /paradigm/.test(e.effectName)).length === 1, 'one paradigm effect');
});

// ------------------------------------------------------------ amplify, tribute, recover, adapt, transfigure
test('Amplify: reveal Zombie cards to Embalmed Brawler for counters', async T => {
  await T.put(0, 'Gravecrawler', 'hand'); await T.put(0, 'Lightning Bolt', 'hand');
  T.a.on('amplify', req => req.cards);
  const c = await T.cast('Embalmed Brawler');
  expect(c.counters.P1P1 === 1, `one Zombie revealed: one counter (${c.counters.P1P1})`);
});
test('Tribute: the opponent pays (counters) or the trigger happens', async T => {
  const g = T.game;
  T.b.on('tribute', () => true);
  const a = await T.cast('Fanatic of Xenagos');
  expect(a.counters.P1P1 === 1 && g.chars(a).power === 4 && !g.hasKeyword(a, 'Haste'), 'tribute paid: a counter, no haste');
  T.b.on('tribute', () => false);
  const b = await T.cast('Fanatic of Xenagos');
  expect(!b.counters.P1P1 && g.chars(b).power === 4 && g.hasKeyword(b, 'Haste'), 'not paid: +1/+1 and haste');
});
test('Recover: pay to return Controvert to hand when a creature dies, or exile it', async T => {
  const g = T.game;
  const cv = await T.put(0, 'Controvert', 'graveyard');
  const bear = await T.put(0, 'Grizzly Bears');
  T.mana(0);
  T.a.on('triggerCost', () => true);
  await g.destroy(bear, null); await T.resolve();
  expect(cv.zone === 'hand', `paid: back to hand (${cv.zone})`);
  await g.moveCard(cv, 'graveyard', { silent: true });
  const b2 = await T.put(0, 'Grizzly Bears');
  T.a.on('triggerCost', () => false);
  await g.destroy(b2, null); await T.resolve();
  expect(cv.zone === 'exile', 'not paid: exiled');
});
test("Adapt: Sharktocrab adapts once; Biomancer's Familiar lets it adapt again (and the Adapt trigger ends it)", async T => {
  const g = T.game;
  const crab = await T.put(0, 'Sharktocrab');
  await T.activate(crab, 0, a => a.parsed.p.Adapt);
  expect(crab.counters.P1P1 === 1, 'adapted');
  await T.activate(crab, 0, a => a.parsed.p.Adapt);
  expect(crab.counters.P1P1 === 1, 'no second adapt');
  const fam = await T.put(0, "Biomancer's Familiar");
  T.a.on('targets', req => req.cands.includes(refOf(crab)) ? [refOf(crab)] : undefined);
  await T.activate(fam, 0, a => a.parsed.api === 'Effect');
  await T.activate(crab, 0, a => a.parsed.p.Adapt);
  expect(crab.counters.P1P1 === 2, `adapted as though it had no counters (${crab.counters.P1P1})`);
  await T.activate(crab, 0, a => a.parsed.p.Adapt);
  expect(crab.counters.P1P1 === 2, 'only the next time');
});
test('Transfigure: Fleshwrither finds a creature with the same mana value', async T => {
  const g = T.game;
  const fw = await T.put(0, 'Fleshwrither');
  const target = await T.put(0, 'Hill Giant', 'library');
  T.a.on('searchBattlefield', req => req.cards.includes(target.id) ? [target.id] : undefined);
  await T.activate(fw, 0, a => /Transfigure/.test(a.parsed.p.SpellDescription || ''));
  expect(fw.zone === 'graveyard' && target.zone === 'battlefield', 'transfigured');
});

// ------------------------------------------------------------ cost types
test('Collect evidence: Forensic Researcher exiles cards with total mana value 3+; Evidence Examiner investigates', async T => {
  const g = T.game;
  const fr = await T.put(0, 'Forensic Researcher');
  await T.put(0, 'Evidence Examiner');
  const elf = await T.put(1, 'Llanowar Elves');
  const abil = a => a.parsed.api === 'Tap';
  T.mana(0);
  expect(!activatedAbilities(g, 0, fr).filter(abil).some(a => canActivate(g, 0, fr, a)), 'an empty graveyard: no evidence');
  const a = await T.put(0, 'Lightning Bolt', 'graveyard'), b = await T.put(0, 'Grizzly Bears', 'graveyard'), c = await T.put(0, 'Divination', 'graveyard');
  T.a.on('collectEvidence', req => [b.id, a.id]);
  T.a.on('targets', req => req.cands.includes(refOf(elf)) ? [refOf(elf)] : undefined);
  await T.activate(fr, 0, abil);
  expect(elf.tapped && a.zone === 'exile' && b.zone === 'exile' && c.zone === 'graveyard', 'exiled Bolt and Bears (mana value 3)');
  expect(T.tokens(0).some(t => /Clue/.test(g.name(t))), 'whenever you collect evidence: investigate');
});
test('Collect evidence as an optional additional cost (Deadly Cover-Up)', async T => {
  const g = T.game;
  for (const n of ['Serra Angel', 'Hill Giant']) await T.put(0, n, 'graveyard');
  const victim = await T.put(1, 'Grizzly Bears', 'graveyard');
  T.a.on('optionalCost', () => true);
  T.a.on('collectEvidence', req => req.cards.slice(0, 2));
  await T.cast('Deadly Cover-Up', 0, { resolve: false });
  expect(T.A.graveyard.filter(c => c.def.name === 'Serra Angel').length === 0, 'evidence collected');
  const item = g.stack[g.stack.length - 1];
  expect(resolveDefined(g, 'Collected', ctxOf(g, item.sa)).length === 2, 'the collected cards are known to the spell');
  await T.resolve();
});
test('Forage: exile three cards or sacrifice a Food (Treetop Sentries draws)', async T => {
  const g = T.game;
  for (let i = 0; i < 3; i++) await T.put(0, 'Lightning Bolt', 'graveyard');
  T.a.on('triggerCost', () => true);
  const hand = T.A.hand.length;
  await T.cast('Treetop Sentries');
  expect(T.A.graveyard.length === 0 && T.A.hand.length === hand + 1, 'foraged three cards from the graveyard, drew');
  const food = (await g.createToken(db.token('c_a_food_sac'), 0, null)) || T.tokens(0).find(t => /Food/.test(g.name(t)));
  const hand2 = T.A.hand.length;
  await T.cast('Treetop Sentries');
  expect(T.A.hand.length === hand2 + 1 && !T.tokens(0).some(t => /Food/.test(g.name(t))), 'foraged by sacrificing the Food');
});
test('Exile from top: Phyrexian Devourer grows by the exiled card’s mana value', async T => {
  const g = T.game;
  const pd = await T.put(0, 'Phyrexian Devourer');
  await T.put(0, 'Hill Giant', 'library');
  await T.activate(pd, 0, a => a.parsed.api === 'PutCounter');
  expect(pd.counters.P1P1 === 4 && T.A.exile.some(c => c.def.name === 'Hill Giant'), `four counters (${pd.counters.P1P1})`);
});
test('Put a card from hand on top of your library: Leashling returns to hand', async T => {
  const g = T.game;
  const l = await T.put(0, 'Leashling');
  const x = await T.put(0, 'Lightning Bolt', 'hand');
  await T.activate(l, 0, a => a.parsed.api === 'ChangeZone');
  expect(l.zone === 'hand' && T.A.library[0] === x, 'returned; the card went on top');
});
test('Put cards from your graveyard on the bottom: Battlefield Scrounger (threshold)', async T => {
  const g = T.game;
  const bs = await T.put(0, 'Battlefield Scrounger');
  for (let i = 0; i < 7; i++) await T.put(0, 'Lightning Bolt', 'graveyard');
  await T.activate(bs, 0, a => a.parsed.api === 'Pump');
  expect(g.chars(bs).power === 6 && T.A.graveyard.length === 4, `pumped, three cards to the bottom (${g.chars(bs).power}, ${T.A.graveyard.length})`);
});
test('Exile a spell you control from the stack: Nivmagus Elemental', async T => {
  const g = T.game;
  const nv = await T.put(0, 'Nivmagus Elemental');
  const bolt = await T.cast('Lightning Bolt', 0, { resolve: false });
  await T.activate(nv, 0, a => a.parsed.api === 'PutCounter', { resolve: false });
  expect(bolt.zone === 'exile' && !g.stack.some(s => s.card === bolt), 'the spell was exiled from the stack');
  await T.resolve();
  expect(nv.counters.P1P1 === 2, 'two counters');
});
test('Reveal or choose: Monstrous Emergence uses the chosen creature’s power', async T => {
  const g = T.game;
  const giant = await T.put(0, 'Craw Wurm');
  const victim = await T.put(1, 'Hill Giant');
  T.a.on('costRevealOrChoose', req => [giant.id]);
  T.a.on('targets', req => req.cands.includes(refOf(victim)) ? [refOf(victim)] : undefined);
  await T.cast('Monstrous Emergence');
  expect(victim.zone === 'graveyard', 'dealt 6 damage');
});
test('Choose a creature type as a cost: Caller of the Hunt', async T => {
  const g = T.game;
  await T.put(0, 'Grizzly Bears'); await T.put(1, 'Grizzly Bears');
  T.a.on('chooseType', req => 'Bear');
  const c = await T.cast('Caller of the Hunt');
  expect(c.zone === 'battlefield' && c.chosen.type === 'Bear' && g.chars(c).power === 2, `a 2/2 for the two Bears (${c.chosen.type}, ${g.chars(c).power})`);
});
test('Additional costs on permanent spells: Skaab Ruinator exiles three creature cards', async T => {
  const g = T.game;
  const c = await T.put(0, 'Skaab Ruinator', 'hand');
  T.mana(0);
  expect(!castableOptions(g, 0, c).length, 'not castable without three creature cards in the graveyard');
  for (const n of ['Grizzly Bears', 'Hill Giant', 'Serra Angel']) await T.put(0, n, 'graveyard');
  await castWith(T, c, /./);
  await T.resolve();
  expect(c.zone === 'battlefield' && T.A.graveyard.length === 0, 'exiled them');
});
test('An opponent gains life as a cost: Invigorate, Roar of Jukai spliced', async T => {
  const g = T.game;
  await T.put(0, 'Forest');
  const bear = await T.put(0, 'Grizzly Bears');
  const c = await T.put(0, 'Invigorate', 'hand');
  T.noMana(0);
  for (const x of g.battlefield) if (T.isLand(x)) x.tapped = true;
  const o = castableOptions(g, 0, c).find(x => x.altCost === 'Alternative');
  expect(o, 'the alternative cost (an opponent gains 3 life) is available');
  const life = T.B.life;
  T.a.on('targets', req => req.cands.includes(refOf(bear)) ? [refOf(bear)] : undefined);
  await castWith(T, c, /Alternative/);
  await T.resolve();
  expect(T.B.life === life + 3 && g.chars(bear).power === 6, 'the opponent gained 3 life; pumped');
});

// ------------------------------------------------------------ mana and cost rules
test('Mana restriction: Imperiosaur only with mana from basic lands; Hogaak only by convoke and delve', async T => {
  const g = T.game;
  for (const c of [...g.battlefield]) if (c.controller === 0) await g.moveCard(c, 'graveyard', { silent: true });
  const imp = await T.put(0, 'Imperiosaur', 'hand');
  T.noMana(0); T.A.pool.G = 4;
  expect(!castableOptions(g, 0, imp).length, 'floating mana of unknown origin can’t pay for it');
  for (let i = 0; i < 2; i++) await T.put(0, 'Forest');
  await T.put(0, 'Llanowar Elves'); await T.put(0, 'Llanowar Elves');
  expect(!castableOptions(g, 0, imp).length, 'two Forests and two Elves: not enough basic-land mana');
  await T.put(0, 'Forest'); await T.put(0, 'Forest');
  await castWith(T, imp, /./);
  expect(T.A.pool.G === 4, 'the floating mana is untouched');
  const elves = g.battlefield.filter(c => c.def.name === 'Llanowar Elves');
  expect(elves.every(e => !e.tapped), 'the Elves weren’t tapped');
  await T.resolve();
  expect(imp.zone === 'battlefield', 'cast with the Forests');
  const hog = await T.put(0, 'Hogaak, Arisen Necropolis', 'hand');
  expect(!castableOptions(g, 0, hog).length, 'Hogaak: no mana at all');
});
test('Trinisphere: spells cost at least three', async T => {
  const g = T.game;
  await T.put(1, 'Trinisphere');
  const bolt = await T.put(0, 'Lightning Bolt', 'hand');
  T.noMana(0); T.A.pool.R = 2;
  expect(!castableOptions(g, 0, bolt).length, 'Lightning Bolt costs three now');
  T.A.pool.R = 3;
  await castWith(T, bolt, /./);
  expect(T.A.pool.R === 0, 'paid three');
});
test('Emblazoned Golem: kicker X is paid with X different colors', async T => {
  const g = T.game;
  for (const c of [...g.battlefield]) if (c.controller === 0) await g.moveCard(c, 'graveyard', { silent: true });
  const c = await T.put(0, 'Emblazoned Golem', 'hand');
  T.noMana(0); T.A.pool.C = 2; T.A.pool.R = 3; T.A.pool.G = 1;
  T.a.on('kicker', () => true);
  T.a.on('xValue', req => req.max);
  await castWith(T, c, /./);
  expect(T.A.pool.R === 2 && T.A.pool.G === 0, `X = 2 paid with red and green (R ${T.A.pool.R} G ${T.A.pool.G})`);
  await T.resolve();
  expect(c.counters.P1P1 === 2, `two counters (${c.counters.P1P1})`);
});
test('Panglacial Wurm: cast it while searching your library', async T => {
  const g = T.game;
  const wurm = await T.put(0, 'Panglacial Wurm', 'library');
  T.a.on('castFromSearch', () => true);
  T.a.on('searchHand', req => []);
  await T.cast('Diabolic Tutor', 0, { resolve: false });
  T.mana(0);
  await T.resolve();
  expect(wurm.zone === 'battlefield', `cast during the search (${wurm.zone})`);
});

// ------------------------------------------------------------ plot, foretell, cascade, learn, copies
test('Becomes plotted: Aloe Alchemist triggers when plotted; Kellan Joins Up plots a card from hand', async T => {
  const g = T.game;
  const bear = await T.put(0, 'Grizzly Bears');
  const aloe = await T.put(0, 'Aloe Alchemist', 'hand');
  T.a.on('targets', req => req.cands.includes(refOf(bear)) ? [refOf(bear)] : undefined);
  await T.activate(aloe, 0, a => a.parsed.api === 'Plot');
  await T.resolve();
  expect(aloe.zone === 'exile' && g.chars(bear).power === 5, `plotted and triggered (${g.chars(bear).power})`);
  const bolt = await T.put(0, 'Lightning Bolt', 'hand');
  T.a.on('searchHand', req => req.cards.includes(bolt.id) ? [bolt.id] : undefined);
  T.a.on('optionalSearch', () => true);
  await T.cast('Kellan Joins Up');
  expect(bolt.zone === 'exile' && bolt.plotted && bolt.plotted.zcc === bolt.zcc, `plotted from hand (${bolt.zone})`);
});
test('Fblthp: plot the top card of your library', async T => {
  const g = T.game;
  await T.put(0, 'Fblthp, Lost on the Range');
  const top = await T.put(0, 'Grizzly Bears', 'library');
  T.mana(0);
  const act = getActions(g, 0).find(a => a.cardId === top.id && a.type === 'activate');
  expect(act, 'the top card can be plotted');
  await g.performAction(0, act);
  expect(top.zone === 'exile' && top.plotted, 'plotted from the library');
  await T.put(0, 'Forest', 'library');
  expect(!getActions(g, 0).some(a => a.type === 'activate' && a.cardId === T.A.library[0].id), 'not a land');
});
test("Foretell trigger and given foretell: Dream Devourer", async T => {
  const g = T.game;
  const dd = await T.put(0, 'Dream Devourer');
  const angel = await T.put(0, 'Serra Angel', 'hand');
  T.mana(0);
  await T.activate(angel, 0, a => a.parsed.api === 'Foretell');
  await T.resolve();
  expect(angel.zone === 'exile' && angel.foretold && g.chars(dd).power === 2, `foretold; +2/+0 (${g.chars(dd).power})`);
  await nextTurn(T);
  T.noMana(0); T.A.pool.W = 2; T.A.pool.C = 1;
  for (const x of g.battlefield) if (T.isLand(x)) x.tapped = true;
  const act = getActions(g, 0).find(a => a.cardId === angel.id);
  expect(act, 'castable for its mana cost reduced by {2}');
  await g.performAction(0, act); await T.resolve();
  expect(angel.zone === 'battlefield', 'cast from exile');
});
test('Cascade replacement: Averna puts a land from among the exiled cards onto the battlefield', async T => {
  const g = T.game;
  await T.put(0, 'Averna, the Chaos Bloom');
  await T.put(0, 'Lightning Bolt', 'library');
  await T.put(0, 'Serra Angel', 'library');
  const land = await T.put(0, 'Forest', 'library');
  T.a.on('castFree', () => false);
  T.a.on('searchBattlefield', req => req.cards.includes(land.id) ? [land.id] : undefined);
  await T.cast('Bloodbraid Elf');
  expect(land.zone === 'battlefield' && land.tapped, `the land entered tapped (${land.zone})`);
});
test('Learn replacement: Retriever Phoenix returns instead; otherwise learn rummages', async T => {
  const g = T.game;
  const ph = await T.put(0, 'Retriever Phoenix', 'graveyard');
  T.a.on('replacement', () => true);
  await T.cast('Retriever Phoenix');
  expect(ph.zone === 'battlefield', `the one in the graveyard returned instead of learning (${ph.zone})`);
});
test('Grip of Chaos: copies get their single target reselected at random; Display of Power can’t be copied', async T => {
  const g = T.game;
  await T.put(0, 'Grip of Chaos');
  await T.put(0, 'Goblin Guide'); await T.put(0, 'Goblin Guide');
  T.a.on('conspire', req => req.cards.slice(0, 2));
  T.a.on('newTargets', () => false);
  const before = g.logs.length;
  await T.cast('Burn Trail');
  expect(g.logs.slice(before).filter(l => /changes the targets/.test(l.text)).length >= 1 || g.logs.slice(before).some(l => /Grip of Chaos triggers/.test(l.text)), 'Grip of Chaos saw the copy');
  const dop = await T.cast('Display of Power', 0, { resolve: false });
  const copyIt = await T.put(0, 'Twincast', 'hand');
  T.a.on('targets', req => { const it = g.stack.find(s => s.card === dop); return it && req.cands.includes(refOf(it)) ? [refOf(it)] : undefined; });
  await castWith(T, copyIt, /./);
  await T.resolve();
  expect(T.logged(/Display of Power can't be copied/), 'not copied');
});

// ------------------------------------------------------------ more variants
test("Dragon's Approach: exile it from the stack with four more from the graveyard to find a Dragon", async T => {
  const g = T.game;
  for (let i = 0; i < 4; i++) await T.put(0, "Dragon's Approach", 'graveyard');
  const dragon = await T.put(0, 'Shivan Dragon', 'library');
  T.a.on('unlessCost', () => true);
  T.a.on('searchBattlefield', req => req.cards.includes(dragon.id) ? [dragon.id] : undefined);
  const c = await T.cast("Dragon's Approach");
  expect(c.zone === 'exile' && T.A.graveyard.filter(x => x.def.name === "Dragon's Approach").length === 0, `the spell and four more exiled (${c.zone})`);
  expect(dragon.zone === 'battlefield', 'found the Dragon');
});
test('Quantum Reduction: with teamwork it can be cast as though it had flash', async T => {
  const g = T.game;
  await T.put(0, 'Grizzly Bears');
  const foe = await T.put(1, 'Hill Giant');
  const qr = await T.put(0, 'Quantum Reduction', 'hand');
  T.mana(0);
  g.activePlayer = 1;
  const os = castableOptions(g, 0, qr);
  expect(os.length === 1 && os[0].forceTeamwork, `only the teamwork option on an opponent's turn (${os.map(o => o.label)})`);
  T.a.on('targets', req => req.cands.includes(refOf(foe)) ? [refOf(foe)] : undefined);
  await castWith(T, qr, /teamwork/);
  await T.resolve();
  expect(qr.zone === 'battlefield' && qr.attachedTo === foe.id && g.chars(foe).power < 0, 'attached');
  expect(g.battlefield.some(c => c.def.name === 'Grizzly Bears' && c.tapped), 'the Bears were tapped for teamwork');
  g.activePlayer = 0;
  const qr2 = await T.put(0, 'Quantum Reduction', 'hand');
  expect(castableOptions(g, 0, qr2).every(o => !o.forceTeamwork), 'at sorcery speed it’s cast normally');
});
test("Recover with a life cost: Garza's Assassin (pay half your life)", async T => {
  const g = T.game;
  const ga = await T.put(0, "Garza's Assassin", 'graveyard');
  const bear = await T.put(0, 'Grizzly Bears');
  T.a.on('triggerCost', () => true);
  T.A.life = 21;
  await g.destroy(bear, null); await T.resolve();
  expect(ga.zone === 'hand' && T.A.life === 10, `returned for 11 life (${ga.zone}, ${T.A.life})`);
});
test('Warp during the end step: exiled at the next end step (the next turn’s)', async T => {
  const g = T.game;
  const c = await T.put(0, 'Sinister Cryologist', 'hand');
  T.mana(0);
  g.step = 'main2';
  await castWith(T, c, /^Warp/);
  g.step = 'end'; // (it resolves in the end step, after "at the beginning of the end step" has passed)
  await T.resolve();
  expect(c.zone === 'battlefield', 'entered');
  await endStep(T);
  expect(c.zone === 'battlefield', 'not this end step');
  await nextTurn(T, 1);
  await endStep(T, 1);
  expect(c.zone === 'exile', `exiled at the next end step (${c.zone})`);
});
test('Sneak on a sorcery: Splinter’s Technique in the declare blockers step', async T => {
  const g = T.game;
  const bear = await T.put(0, 'Grizzly Bears');
  const tech = await T.put(0, "Splinter's Technique", 'hand');
  T.mana(0);
  T.combatWith([[bear, 1]]);
  g.step = 'declareBlockers';
  const o = opt(T, tech, /Sneak/);
  expect(o && o.mayFlash, 'castable at instant speed during the declare blockers step with sneak');
  T.a.on('searchHand', req => [req.cards[0]]);
  await castWith(T, tech, /Sneak/);
  expect(bear.zone === 'hand', 'returned the attacker');
  await T.resolve();
  expect(tech.zone === 'graveyard', 'resolved');
});

process.exit(await run(tests) ? 1 : 0);
