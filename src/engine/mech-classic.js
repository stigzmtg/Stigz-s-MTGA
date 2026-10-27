// Classic mechanics: phasing, haunt, fading, ingest, skipping and controlling turns (Mindslaver), restarting and
// drawing the game, regeneration replacements, bidding life, draining mana, coin flips with their modifiers, and the
// effects behind them. effects.js merges CLASSIC_EFFECTS into its table; the engine calls the hooks below (each call
// site names this file). The pure parts (keywords, filter properties, trigger matching, the "can't" statics) are in
// mech-classic-rules.js.
import { parseAbility } from './forge.js';
import { matchValid, resolveDefined, calc, calcCtx, ctxOf, liveOrLki, zoneMap } from './filters.js';
import { makeSA, resolveChain, chooseTargetsForSA, manaSourcesFor, activateManaAbility, parseCost, canAfford, payManaCost, canPayNonMana, payCostParts, costLabel } from './abilities.js';
import { parseMana, addCosts } from './mana.js';
import { cantPhaseIn, cantPhaseOut, cantRegenerate, cantAttach, cantGainControl, flipCoinFixed, mustTargetKinds, fitsKind, manaBurns } from './mech-classic-rules.js';

const Z = z => (z ? (zoneMap[z] || z.toLowerCase()) : z);
const cardsOf = list => list.filter(o => o && o.isCard);
const playersOf = list => list.filter(o => o && o.isPlayer);
const hasTgt = sa => !!(sa.p.ValidTgts || sa.p.TargetType);
function objs(game, sa, def = null) {
  if (hasTgt(sa)) return sa.targets.map(t => (t.isCard || t.lki ? liveOrLki(game, t) : t));
  const d = sa.p.Defined || def;
  return d ? resolveDefined(game, d, ctxOf(game, sa)) : [];
}
function num(game, sa, key, def = 0) { const v = sa.p[key]; return v == null || v === '' ? def : calc(game, v, sa); }
function remember(sa, list) { const h = sa.host; if (!h) return; h.remembered = h.remembered || []; for (const o of list) if (o != null && !h.remembered.includes(o)) h.remembered.push(o); }
const live = (game, o) => { const c = o && o.lki ? liveOrLki(game, o) : o; return c && c.isCard && !c.lki ? c : null; };
async function chooseCards(game, pid, cards, min, max, prompt, sa, purpose, extra = {}) {
  if (!cards.length) return [];
  max = Math.min(max, cards.length); min = Math.min(min, max);
  if (max <= 0) return [];
  if (min === cards.length && max === cards.length) return cards.slice();
  const ids = await game.ask(pid, { type: 'cards', prompt, cards: cards.map(c => c.id), min, max, sa, purpose, ...extra });
  return (ids || []).map(id => game.cardById(id)).filter(Boolean).slice(0, max);
}
// a sub-ability (WinSubAbility$, BidSubAbility$, ...) run with extra values for its SVars
async function runSub(game, sa, name, extraSVars = null) {
  const raw = name && sa.svars[name];
  if (!raw) return;
  const sub = makeSA(game, raw, extraSVars ? { ...sa.svars, ...extraSVars } : sa.svars, sa.host, sa.controller, { parent: sa, key: (sa.key || 'x') + '>' + name });
  if (await chooseTargetsForSA(game, sub, { optional: true })) await resolveChain(game, sub);
}

// ================================================================ phasing
// Phase a permanent out: it's treated as though it doesn't exist until it phases in. Its PhaseOut triggers fire first
// (a phased-out permanent's abilities don't work); anything attached to it phases out with it ("indirectly").
export function phaseOut(game, c, { direct = true, wontPhaseIn = false, silent = false } = {}) {
  if (!c || c.zone !== 'battlefield' || c.phasedOut || cantPhaseOut(game, c)) return false;
  game.fire('PhaseOut', { Card: c });
  c.phasedOut = true; c.phasedOutDirect = direct; c.phasedOutUnder = c.controller; c.wontPhaseIn = !!wontPhaseIn;
  if (game.combat) {
    game.combat.attackers = game.combat.attackers.filter(a => a.card !== c.id);
    game.combat.blockers.delete(c.id);
    for (const a of game.combat.attackers) a.blockers = a.blockers.filter(b => b !== c.id);
  }
  // a soulbond pair breaks
  if (c.pairedWith != null) { const o = game.cardById(c.pairedWith); if (o && o.pairedWith === c.id) o.pairedWith = null; c.pairedWith = null; }
  for (const a of [...game.battlefield]) if (a.attachedTo === c.id && !a.phasedOut) phaseOut(game, a, { direct: false, silent: true });
  game.touch();
  if (!silent) game.log(`${game.name(c)} phases out.`, { cardId: c.id });
  return true;
}
export function phaseIn(game, c, { silent = false } = {}) {
  if (!c || !c.phasedOut) return false;
  c.phasedOut = false; c.phasedOutDirect = false; c.wontPhaseIn = false;
  // it comes back attached to the same thing if that's still there
  if (typeof c.attachedTo === 'number') { const t = game.cardById(c.attachedTo); if (!t || t.zone !== 'battlefield') c.attachedTo = null; }
  else if (typeof c.attachedTo === 'string') { const pl = game.players[+c.attachedTo.slice(1)]; if (!pl || pl.lost) c.attachedTo = null; }
  for (const a of [...game.battlefield]) if (a.attachedTo === c.id && a.phasedOut && !a.phasedOutDirect) phaseIn(game, a, { silent: true });
  game.touch();
  if (!silent) game.log(`${game.name(c)} phases in.`, { cardId: c.id });
  game.fire('PhaseIn', { Card: c });
  return true;
}

// The untap step: the active player's phased-out permanents phase in and their permanents with phasing phase out, all
// at once (game.js runStep). Then "until your next upkeep" effects end (Ertai's Familiar can't phase out until then).
export async function untapPhasing(game, ap) {
  const ins = [], outs = [];
  for (const c of game.battlefield) {
    if (c.phasedOut) { if (c.phasedOutDirect !== false && (c.phasedOutUnder ?? c.controller) === ap && !c.wontPhaseIn && !cantPhaseIn(game, c)) ins.push(c); }
    else if (c.controller === ap && game.hasKeyword(c, 'Phasing') && !cantPhaseOut(game, c)) outs.push(c);
  }
  for (const c of ins) phaseIn(game, c, { silent: true });
  const out = [];
  for (const c of outs) {
    // an Aura with phasing on a permanent that phases out now goes with it, indirectly
    if (typeof c.attachedTo === 'number' && outs.some(o => o.id === c.attachedTo)) continue;
    if (phaseOut(game, c, { silent: true })) out.push(c);
  }
  if (ins.length) game.log(`${ins.map(c => game.name(c)).join(', ')} phase${ins.length === 1 ? 's' : ''} in.`);
  if (out.length) { game.log(`${out.map(c => game.name(c)).join(', ')} phase${out.length === 1 ? 's' : ''} out.`); game.fire('PhaseOutAll', { Cards: out, Amount: out.length }); }
  await game.expireDurations('UntilYourNextUpkeep', ap);
}

// ================================================================ turns: skipping, controlling, restarting
const COMBAT_STEPS = ['beginCombat', 'declareAttackers', 'declareBlockers', 'firstStrikeDamage', 'combatDamage', 'endCombat'];

// Who makes this player's decisions right now: the player controlling their turn (Mindslaver, Sorin Markov, Emrakul),
// else themselves. A plan starts with the target's next turn (or combat phase) after it was made and lasts for it.
// (a pure query: the table calls it while drawing, so it must never change the game)
export function deciderFor(game, pid) {
  const plans = game.controlPlans;
  if (!plans || !plans.length || game.activePlayer !== pid) return pid;
  let best = null;
  for (const pl of plans) if (pl.target === pid && !game.players[pl.by].lost && planActive(game, pl) && (!best || pl.ts > best.ts)) best = pl;
  return best ? best.by : pid;
}
// the target's turn now is their first one since the plan was made (their turn before this one came no later)
function firstTurnSince(game, pl, turn = game.turnNumber) {
  const t = game.players[pl.target].turns || [];
  if (t[t.length - 1] !== turn) return false;
  const prev = t[t.length - 2];
  return turn > pl.fromTurn && (prev == null || prev <= pl.fromTurn);
}
function planActive(game, pl) {
  if (game.activePlayer !== pl.target) return false;
  if (!pl.combat) return firstTurnSince(game, pl);
  // the first combat phase to begin after it was made: later this turn, or the target's next turn's first one
  if (!COMBAT_STEPS.includes(game.step)) return false;
  const n = game.combatsThisTurn || 0;
  if (game.turnNumber === pl.fromTurn) return n === pl.fromCombats + 1;
  return n === 1 && firstTurnSince(game, pl);
}
// the player whose turn `pid` controls right now, if any (the table shows that player's hand and lets you act for them)
export function controlledBy(game, pid) {
  const ap = game.activePlayer;
  return ap !== pid && deciderFor(game, ap) === pid ? ap : null;
}

// game.js takeTurn, before a turn begins: a restarted game starts over; a player who must skip their next turn skips it
export async function turnStart(game) {
  if (game.classicRestart) {
    const r = game.classicRestart;
    game.classicRestart = null;
    game.activePlayer = r.first; game.turnBase = r.first; game.currentExtra = false;
    for (const p of game.players) if (!p.lost) await game.drawCards(p, 7, null, true);
    await game.mulligans();
  }
  for (let guard = 0; guard < 40; guard++) {
    const p = game.players[game.activePlayer];
    if (!p || p.lost || !(p.skipTurns > 0)) return;
    p.skipTurns--;
    game.log(`${p.name} skips their turn.`, { type: 'turn' });
    const ap = game.activePlayer;
    if (!game.currentExtra) game.turnBase = ap;
    game.currentExtra = false;
    let next = null;
    while (game.extraTurns.length && next == null) { const nx = game.extraTurns.pop(); if (!game.players[nx].lost) next = nx; }
    if (next != null) { game.activePlayer = next; game.currentExtra = true; }
    else game.activePlayer = game.nextPlayer(game.turnBase ?? ap);
    game.touch();
  }
}

// game.js takeTurn, once the turn has begun: say who controls this player during it
export function turnBegun(game) {
  const ap = game.activePlayer;
  for (const pl of game.controlPlans || []) {
    if (pl.target === ap && !pl.combat && !game.players[pl.by].lost && firstTurnSince(game, pl) && deciderFor(game, ap) === pl.by) {
      game.log(`${game.players[pl.by].name} controls ${game.players[ap].name} this turn: ${game.players[pl.by].name} makes all the decisions.`, { type: 'turn' });
      break;
    }
  }
  // spent plans go (a plan is spent once its target has taken a turn since it was made)
  if (game.controlPlans && game.controlPlans.length) game.controlPlans = game.controlPlans.filter(pl => { const t = game.players[pl.target].turns || []; const after = t.filter(x => x > pl.fromTurn); return after.length === 0 || (after.length === 1 && after[0] === game.turnNumber); });
}

// ================================================================ destroy: replacements and "can't be regenerated"
// game.js destroy(): returns false when a replacement stops the destruction ("if CARDNAME would be destroyed,
// regenerate it", Crackling Emergence, Pyramids), else undefined. "Can't be regenerated" turns regeneration off.
export async function destroyReplaced(game, card, sa, opts) {
  if (!opts.noRegen && cantRegenerate(game, card)) opts.noRegen = true;
  for (const { h, r, p, ctx } of game.replacementsFor('Destroy')) {
    if (p.ValidCard && !matchValid(game, card, p.ValidCard, ctx)) continue;
    if (p.Regeneration === 'True' && opts.noRegen) continue;
    const raw = p.ReplaceWith && r.svars[p.ReplaceWith];
    if (!raw) continue;
    const key = h.id + ':' + r.key;
    if (game.activeRepl.has(key)) continue;
    if (p.Optional === 'True' && !(await game.ask(h.controller, { type: 'confirm', prompt: `${game.name(h)}: ${(p.Description || 'apply?').replace(/CARDNAME/g, game.name(h))}`, purpose: 'replacement', cardId: card.id }))) continue;
    const s = makeSA(game, raw, r.svars, h, h.controller, { key: r.key, trig: { Card: card, Affected: card, Cause: sa } });
    game.activeRepl.add(key);
    try { await resolveChain(game, s); } finally { game.activeRepl.delete(key); }
    return false;
  }
  return undefined;
}
function regenerate(game, c) {
  if (!c || c.zone !== 'battlefield') return;
  c.tapped = true; c.damage = 0; c.deathtouchHit = false;
  if (game.combat) { game.combat.attackers = game.combat.attackers.filter(a => a.card !== c.id); game.combat.blockers.delete(c.id); for (const a of game.combat.attackers) a.blockers = a.blockers.filter(b => b !== c.id); }
  game.log(`${game.name(c)} regenerates.`, { cardId: c.id });
  game.touch();
}

// ================================================================ state-based actions: illegal attachments
// An Aura that can't be attached to what it's on (Anti-Magic Aura, Consecrate Land) goes to the graveyard; Equipment
// that can't be (Gate Smasher on a smaller creature, Konda's Banner on a nonlegendary one) becomes unattached.
export async function attachmentSBA(game) {
  if (!game.activeStatics('CantAttach').length) return false;
  let acted = false;
  for (const a of [...game.battlefield]) {
    if (a.phasedOut || a.attachedTo == null || a.zone !== 'battlefield') continue;
    const t = typeof a.attachedTo === 'number' ? game.cardById(a.attachedTo) : game.players[+String(a.attachedTo).slice(1)];
    if (!t || !cantAttach(game, a, t)) continue;
    acted = true;
    if (game.chars(a).subtypes.has('Aura')) await game.moveCard(a, 'graveyard', { sba: true });
    else { a.attachedTo = null; game.touch(); game.log(`${game.name(a)} becomes unattached.`); }
  }
  return acted;
}

// ================================================================ haunt
// After a haunt instant or sorcery resolves and goes to its owner's graveyard, it's exiled haunting target creature
// (abilities.js resolveStackItem).
export function spellResolved(game, card, controller) {
  if (!card || card.zone !== 'graveyard' || card.token || card.isSpellCopy) return;
  if (!card.faceDef.keywords.some(k => /^Haunt:/.test(k))) return;
  const svars = { ...card.faceDef.svars, KWHauntExile: 'DB$ HauntExile | ValidTgts$ Creature | TgtPrompt$ Choose target creature to haunt' };
  game.pendingTriggers.push({ host: card, t: { parsed: { p: { Execute: 'KWHauntExile', TriggerDescription: `Haunt — exile ${game.name(card)} haunting target creature` } }, svars, key: 'haunt' }, rp: { Card: card }, controller });
}
// the haunter in exile: when the creature it haunts dies, its haunt ability triggers; the haunting ends when either leaves
function hauntCreature(game, card, target, controller) {
  const k = card.faceDef.keywords.find(x => /^Haunt:/.test(x));
  const exec = k && k.split(':')[1];
  const raw = exec && card.faceDef.svars[exec];
  if (!raw) return;
  const what = (raw.match(/SpellDescription\$ ([^|]+)/) || [])[1] || '';
  const svars = { ...card.faceDef.svars, KWHauntEnd: 'DB$ HauntEnd' };
  const name = card.faceDef.name;
  const e = {
    isEffect: true, id: game.nextId++, effectName: name, controller, owner: controller, zone: 'command',
    duration: 'Permanent', remembered: [target], imprinted: [card], chosen: {}, counters: {}, timestamp: game.uid++, temp: [], mods: [], abilityUses: {}, xPaid: 0,
    hostCard: card, description: `${name} haunts ${game.name(target)}. When it dies: ${what.trim()}`,
  };
  const trig = (raw2, i) => ({ raw: raw2, parsed: parseAbility(raw2), svars, src: e, key: `haunt${e.id}T${i}` });
  e.effectChars = {
    name, types: new Set(['Effect']), subtypes: new Set(), supertypes: new Set(), colors: new Set(), keywords: [], abilities: [], statics: [], replacements: [], svars, power: 0, toughness: 0, cmc: 0,
    triggers: [
      trig(`Mode$ ChangesZone | Origin$ Battlefield | Destination$ Graveyard | ValidCard$ Card.IsRemembered | Execute$ ${exec} | TriggerDescription$ When the creature ${name} haunts dies, ${what.trim()}`, 0),
      trig('Mode$ ChangesZone | Origin$ Battlefield | Destination$ Any | ValidCard$ Card.IsRemembered | Static$ True | Execute$ KWHauntEnd | TriggerDescription$ The haunting ends', 1),
      trig('Mode$ ChangesZone | Origin$ Exile | Destination$ Any | ValidCard$ Card.IsImprinted | Static$ True | Execute$ KWHauntEnd | TriggerDescription$ The haunting ends', 2),
    ],
  };
  card.haunting = { id: target.id, zcc: target.zcc };
  game.effects.push(e);
  game.touch();
  game.log(`${name} haunts ${game.name(target)}.`, { cardId: card.id });
}

// ================================================================ life payment
// A replacement for paying life ("exile that many cards from the top of your library instead": Ashiok, Wicked
// Manipulator). abilities.js applyCostParts: true when the payment was replaced (it still counts as paid).
export async function payLifeReplaced(game, sa, pid, n) {
  const p = game.players[pid];
  for (const { h, r, p: rp, ctx } of game.replacementsFor('PayLife')) {
    if (rp.ValidPlayer && !matchValid(game, p, rp.ValidPlayer, ctx)) continue;
    if (rp.Amount) { const m = rp.Amount.match(/^(EQ|NE|LT|LE|GT|GE)(.+)$/); if (m && !({ EQ: n === calcCtx(game, m[2], ctx), NE: n !== calcCtx(game, m[2], ctx), LT: n < calcCtx(game, m[2], ctx), LE: n <= calcCtx(game, m[2], ctx), GT: n > calcCtx(game, m[2], ctx), GE: n >= calcCtx(game, m[2], ctx) })[m[1]]) continue; }
    game.log(`${game.name(h)}: ${p.name} exiles the top ${n} card${n === 1 ? '' : 's'} of their library instead of paying ${n} life.`);
    const top = p.library.slice(0, n);
    game.beginBatch();
    for (const c of top) await game.moveCard(c, 'exile', { cause: sa, silent: true });
    await game.endBatch();
    return true;
  }
  return false;
}

// ================================================================ "must target" (Coalition Flag, Standard Bearer)
// abilities.js chooseTargetsForSA: while a Flagbearer could be targeted and none is yet, only Flagbearers may be
// chosen for this target (when there's room for just one more target), and one is added if the answer has none.
export function mustTargetCands(game, root, cands, chosen, max) {
  const kinds = mustTargetKinds(game, root).filter(k => !chosen.some(o => fitsKind(game, o, k)));
  const need = kinds.filter(k => cands.some(o => fitsKind(game, o, k)));
  if (!need.length) return { cands, need };
  return { cands: max <= need.length ? cands.filter(o => need.some(k => fitsKind(game, o, k))) : cands, need };
}
export function mustTargetFix(game, picked, cands, need, max) {
  let out = picked.slice();
  for (const k of need) {
    if (out.some(o => fitsKind(game, o, k))) continue;
    const add = cands.find(o => fitsKind(game, o, k) && !out.includes(o));
    if (!add) continue;
    if (out.length >= max) out = out.slice(0, max - 1);
    out.push(add);
  }
  return out;
}

// ================================================================ activations (boast, exhaust, power-up)
export function noteActivation(game, card, abil, pid) {
  const p = abil.parsed.p;
  (game.turnState.activations = game.turnState.activations || []).push({ card: card.id, p, controller: pid, api: abil.parsed.api });
  if (p.Exhaust || p.PowerUp) {
    if (!card.onceUses || card.onceUses.zcc !== card.zcc) card.onceUses = { zcc: card.zcc, n: {} };
    card.onceUses.n[abil.key] = (card.onceUses.n[abil.key] || 0) + 1;
  }
}
export function activationsUsed(game, card, abil) {
  const p = abil.parsed.p;
  if (p.Boast) return card.abilityUses[abil.key] || 0;
  return card.onceUses && card.onceUses.zcc === card.zcc ? (card.onceUses.n[abil.key] || 0) : 0;
}

// ================================================================ the computer's choices for these effects (ai.js)
// undefined when it's not one of ours
export function aiCards(game, pid, req, value) {
  if (req.purpose === 'phaseChoice') return []; // (phasing your own things out for no reason helps nobody)
  if (req.purpose !== 'exchangeChoice') return undefined;
  // Cultural Exchange: give away your worst creatures for their best, while each trade is a gain
  const cards = req.cards.map(id => game.cardById(id)).filter(Boolean);
  if (!cards.length) return [];
  const side = cards[0].controller;
  const pls = playersOf((req.sa && req.sa.targets) || []).map(p => p.id);
  const other = pls.find(x => x !== side);
  if (side !== pid && other !== pid) return cards.slice(0, req.min).map(c => c.id);
  const mine = (side === pid ? cards : game.battlefield.filter(c => c.controller === pid && game.chars(c).types.has('Creature'))).slice().sort((a, b) => value(a) - value(b));
  const theirs = (side === pid ? game.battlefield.filter(c => c.controller === other && game.chars(c).types.has('Creature')) : cards).slice().sort((a, b) => value(b) - value(a));
  let k = req.min;
  if (!k) { k = 0; while (k < Math.min(mine.length, theirs.length, req.max) && value(theirs[k]) > value(mine[k]) + 0.5) k++; }
  return (side === pid ? mine : theirs).slice(0, k).map(c => c.id);
}

// ================================================================ effects
export const CLASSIC_EFFECTS = {
  // "[target] phases out", "phase in or out" (Time and Tide, Oubliette), "any number of them phase out"
  async Phases(game, sa) {
    const p = sa.p;
    const ctx = ctxOf(game, sa);
    let list;
    if (p.AllValid) list = game.battlefield.filter(c => (p.PhaseInOrOut === 'True' || !c.phasedOut) && matchValid(game, c, p.AllValid, ctx));
    else list = cardsOf(objs(game, sa, 'Self').map(o => live(game, o))).filter(c => c.zone === 'battlefield');
    list = [...new Set(list)];
    if (p.AnyNumber === 'True') list = await chooseCards(game, sa.controller, list, 0, list.length, 'Choose any number of them to phase out', sa, 'phaseChoice');
    const out = [];
    for (const c of list) {
      if (c.phasedOut) {
        if (p.PhaseInOrOut !== 'True' || cantPhaseIn(game, c)) continue;
        phaseIn(game, c);
        if (p.Tapped === 'True') c.tapped = true;
        else if (p.Untapped === 'True') c.tapped = false;
        continue;
      }
      if (phaseOut(game, c, { wontPhaseIn: p.WontPhaseInNormal === 'True' })) { out.push(c); if (p.RememberAffected === 'True') remember(sa, [c]); }
    }
    if (p.RememberValids === 'True') remember(sa, list);
    game.touch();
    if (out.length) game.fire('PhaseOutAll', { Cards: out, Amount: out.length });
  },

  // "You skip your next N turns."
  async SkipTurn(game, sa) {
    const n = num(game, sa, 'NumTurns', 1);
    if (n <= 0) return;
    for (const pl of playersOf(objs(game, sa, 'You'))) {
      pl.skipTurns = (pl.skipTurns || 0) + n;
      game.log(`${pl.name} will skip their next ${n === 1 ? 'turn' : n + ' turns'}.`);
    }
    game.touch();
  },

  // "You control target player during that player's next turn" (Mindslaver); "Combat$ True": their next combat phase
  async ControlPlayer(game, sa) {
    const p = sa.p;
    const ctx = ctxOf(game, sa);
    const by = p.Controller ? playersOf(resolveDefined(game, p.Controller, ctx))[0] : game.players[sa.controller];
    if (!by || by.lost) return;
    for (const pl of playersOf(objs(game, sa, 'You'))) {
      if (pl.lost || pl.id === by.id) continue;
      game.controlPlans = [...(game.controlPlans || []).filter(x => !x.done), { target: pl.id, by: by.id, combat: p.Combat === 'True', fromTurn: game.turnNumber, fromStep: game.step, fromCombats: game.combatsThisTurn || 0, ts: game.uid++ }];
      game.log(`${by.name} will control ${pl.name} during ${pl.name}'s next ${p.Combat === 'True' ? 'combat phase' : 'turn'}.`);
    }
    game.touch();
  },

  // Karn Liberated: "Restart the game, leaving in exile all non-Aura permanent cards exiled with CARDNAME."
  async RestartGame(game, sa) {
    const ctx = ctxOf(game, sa);
    const leaveZone = sa.p.RestrictFromZone ? Z(sa.p.RestrictFromZone) : null;
    const leaveValid = sa.p.RestrictFromValid || 'Card';
    game.log(`${game.players[sa.controller].name} restarts the game.`, { type: 'turn' });
    const stackCards = game.stack.map(s => s.card).filter(Boolean);
    game.stack = []; game.pendingTriggers = []; game.lookback = []; game.combat = null;
    for (const c of [...game.cards.values()]) {
      if (c.zone === 'gone' || c.zone === 'none') continue;
      if (c.zone === 'command' && !c.isCommander) continue;
      // what stays in exile: the cards the restriction doesn't send back (Karn's non-Aura permanent cards); commanders
      // start the new game in the command zone whatever happened to them
      if (leaveZone && c.zone === leaveZone && !c.isCommander && !matchValid(game, c, leaveValid, ctx)) continue;
      game.removeFromZone(c);
      if (c.token || c.isSpellCopy) { c.zone = 'gone'; game.cards.delete(c.id); continue; }
      c.reset(); c.zcc++; c.controller = c.owner;
      if (c.isCommander) { c.zone = 'command'; game.players[c.owner].command.push(c); }
      else { c.zone = 'library'; game.players[c.owner].library.push(c); }
    }
    for (const c of stackCards) if (c.zone === 'stack') { game.removeFromZone(c); c.reset(); c.zcc++; c.zone = 'library'; game.players[c.owner].library.push(c); }
    game.battlefield = game.battlefield.filter(c => c.zone === 'battlefield');
    for (const pl of game.players) {
      pl.command = pl.command.filter(c => c.isCommander);
      pl.life = 40; pl.pool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }; pl.counters = {}; pl.poison = 0; pl.commanderDamage = {};
      for (const k of Object.keys(pl.commanderCasts)) pl.commanderCasts[k] = 0;
      pl.landsPlayed = 0; pl.drewFromEmpty = false; pl.dungeon = null; pl.dungeonsCompleted = []; pl.skipTurns = 0; pl.skips = [];
      pl.lifeGainedThisTurn = 0; pl.lifeLostThisTurn = 0; pl.cardsDrawnThisTurn = 0; pl.spellsCastThisTurn = []; pl.temp = []; pl.remembered = []; pl.speed = 0;
      game.rng.shuffle(pl.library);
    }
    game.effects = []; game.delayed = []; game.shields = []; game.extraTurns = []; game.controlPlans = [];
    game.monarch = null; game.initiative = null; game.pendingInitiative = null; game.dayNight = null; game.turnDir = 1;
    game.turnState = game.freshTurnState(); game.turnState.turnsTaken = {};
    // the rest of this turn is skipped; the restarted game begins with its controller's turn (mech-classic turnStart)
    game.classicRestart = { first: sa.controller };
    game.endTurnNow = true;
    game.touch();
  },

  // "the game is a draw" (Divine Intervention, Celestial Convergence)
  async GameDrawn(game, sa) {
    game.log(`${game.name(sa.host)}: the game is a draw.`, { type: 'gameover' });
    game.endGame(null, 'The game is a draw.');
  },

  // "reorder your graveyard as you choose" / "at random"
  async ReorderZone(game, sa) {
    const zone = Z(sa.p.Zone || 'Graveyard');
    for (const pl of playersOf(objs(game, sa, 'You'))) {
      const list = pl[zone];
      if (!list || list.length < 2) continue;
      if (sa.p.Random === 'True') { game.rng.shuffle(list); game.log(`${pl.name} reorders their ${zone} at random.`); }
      else {
        const top = await chooseCards(game, pl.id, list.slice(), 0, list.length, `Reorder your ${zone}: choose cards in the order they go on top`, sa, 'reorder');
        const rest = list.filter(c => !top.includes(c));
        pl[zone] = zone === 'graveyard' ? [...rest, ...top.reverse()] : [...top, ...rest];
        game.log(`${pl.name} reorders their ${zone}.`);
      }
      game.touch();
    }
  },

  // "regenerate it" now, as a replacement ("If CARDNAME would be destroyed, regenerate it")
  async Regeneration(game, sa) { for (const c of cardsOf(objs(game, sa, 'Self'))) regenerate(game, live(game, c)); },
  async HealDamage(game, sa) { for (const c of cardsOf(objs(game, sa, 'Self'))) { const x = live(game, c); if (x && x.zone === 'battlefield') { x.damage = 0; x.deathtouchHit = false; } } game.touch(); },

  // fading: remove a fade counter, or sacrifice it if you can't
  async FadingUpkeep(game, sa) {
    const c = live(game, sa.host);
    if (!c || c.zone !== 'battlefield') return;
    if ((c.counters.FADE || 0) > 0) await game.removeCounters(c, 'FADE', 1);
    else await game.sacrifice(c, sa);
  },
  // ingest: the damaged player exiles the top card of their library
  async IngestExile(game, sa) {
    const pl = sa.trig && sa.trig.Target && sa.trig.Target.isPlayer ? sa.trig.Target : null;
    if (!pl || pl.lost || !pl.library.length) return;
    await game.moveCard(pl.library[0], 'exile', { cause: sa });
  },
  // haunt: exile the haunter from its owner's graveyard haunting the target creature
  async HauntExile(game, sa) {
    const h = sa.host;
    const card = h && h.lki ? h.card : h;
    if (!card || card.token || card.zone !== 'graveyard') return;
    if (h.lki && h.newZcc != null && card.zcc !== h.newZcc) return;
    const target = cardsOf(sa.targets.map(t => live(game, t)))[0];
    if (!target || target.zone !== 'battlefield') return;
    await game.moveCard(card, 'exile', { cause: sa });
    if (card.zone === 'exile') hauntCreature(game, card, target, card.owner);
  },
  async HauntEnd(game, sa) {
    const e = sa.host;
    if (e && e.hostCard) e.hostCard.haunting = null;
    game.effects = game.effects.filter(x => x !== e);
    game.touch();
  },

  // Aura swap: exchange this Aura with an Aura card in your hand that could enchant the same thing
  async AuraSwap(game, sa) {
    const aura = live(game, sa.host);
    if (!aura || aura.zone !== 'battlefield' || aura.attachedTo == null) return;
    const pid = sa.controller;
    const t = typeof aura.attachedTo === 'number' ? game.cardById(aura.attachedTo) : game.players[+String(aura.attachedTo).slice(1)];
    if (!t) return;
    const ok = c => {
      const f = c.faceDef;
      if (!f.subtypes.includes('Aura')) return false;
      const ek = f.keywords.find(k => k.startsWith('Enchant:'));
      const valid = ek ? ek.split(':')[1] : 'Creature';
      return matchValid(game, t, valid, { host: c, you: pid }) && !cantAttach(game, c, t);
    };
    const pool = game.players[pid].hand.filter(ok);
    const pick = (await chooseCards(game, pid, pool, 0, 1, `Aura swap: exchange ${game.name(aura)} with an Aura card in your hand`, sa, 'auraSwap'))[0];
    if (!pick) return;
    const attachTo = aura.attachedTo;
    await game.moveCard(aura, 'hand', { cause: sa });
    await game.moveCard(pick, 'battlefield', { controller: pid, attachTo, cause: sa });
    game.log(`${game.players[pid].name} swaps ${game.name(aura)} for ${game.name(pick)}.`);
  },

  // "Target player activates a mana ability of each land they control" (Drain Power, Pygmy Hippo)
  async ActivateAbility(game, sa) {
    for (const pl of playersOf(objs(game, sa, 'You'))) {
      if (pl.lost) continue;
      const type = sa.p.Type || 'Card';
      const cards = game.battlefield.filter(c => c.controller === pl.id && !c.phasedOut && matchValid(game, c, type, { host: sa.host, you: pl.id }));
      for (const c of cards) {
        const srcs = manaSourcesFor(game, pl.id).filter(s => s.card === c && !s.manualOnly && !s.extraCost);
        if (!srcs.length) continue;
        let src = srcs[0];
        if (srcs.length > 1) {
          const k = await game.ask(pl.id, { type: 'option', prompt: `${game.name(c)}: activate which mana ability?`, options: srcs.map(s => ({ label: (s.abil.parsed.p.SpellDescription || s.abil.raw).slice(0, 60), value: s.abil.key })), purpose: 'manaAbility', cardId: c.id });
          src = srcs.find(s => s.abil.key === k) || srcs[0];
        }
        try { await activateManaAbility(game, pl.id, c, src.abil.key); } catch (e) { if (!(e && e.cancelled)) throw e; }
      }
    }
  },

  // "that player loses all unspent mana" (Mana Short, Power Sink); "DrainMana$ True": you add the mana lost this way
  async DrainMana(game, sa) {
    const drained = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    let total = 0;
    for (const pl of playersOf(objs(game, sa, 'You'))) {
      if (pl.lost) continue;
      let lost = 0;
      for (const k of Object.keys(pl.pool)) { lost += pl.pool[k] || 0; drained[k] = (drained[k] || 0) + (pl.pool[k] || 0); }
      pl.pool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
      total += lost;
      if (lost) game.log(`${pl.name} loses ${lost} unspent mana.`);
      if (lost && manaBurns(game, pl.id)) await game.loseLife(pl, lost, sa);
    }
    if (sa.p.DrainMana === 'True' && total) { const me = game.players[sa.controller]; for (const k of Object.keys(drained)) me.pool[k] = (me.pool[k] || 0) + drained[k]; game.log(`${me.name} adds the ${total} mana lost this way.`); }
    if (sa.p.RememberDrainedMana === 'True') sa.root().triggerRememberAmount = total;
    game.touch();
  },

  // "Each player may bid life ..." (Illicit Auction, Mages' Contest, Pain's Reward)
  async BidLife(game, sa) {
    const p = sa.p;
    const host = sa.host;
    const me = game.players[sa.controller];
    let bid = 0;
    if (p.StartBidding === 'Any') bid = await game.ask(me.id, { type: 'number', prompt: `${game.name(host)}: start the bidding at how much life?`, min: 0, max: Math.max(0, me.life), purpose: 'bidStart', sa, aiMax: +(p.AIBidMax || 8) });
    else if (p.StartBidding) bid = calc(game, p.StartBidding, sa);
    let bidders;
    if (p.OtherBidder) bidders = [me, ...playersOf(resolveDefined(game, p.OtherBidder, ctxOf(game, sa))).filter(x => x.id !== me.id)];
    else { bidders = []; let q = me.id; for (let i = 0; i < game.players.length; i++) { if (!game.players[q].lost && !bidders.includes(game.players[q])) bidders.push(game.players[q]); q = game.nextPlayer(q); } }
    bidders = bidders.filter(x => x && !x.lost);
    let winner = me;
    game.log(`${me.name} starts the bidding at ${bid} life.`);
    for (let round = 0, more = true; more && round < 200; round++) {
      more = false;
      for (const pl of bidders) {
        if (pl === winner && bidders.length > 1) continue;
        const top = await game.ask(pl.id, { type: 'confirm', prompt: `${game.name(host)}: the high bid is ${bid} life (${winner.name}). Top it?`, purpose: 'bidLife', sa, bid, winner: winner.id, aiMax: +(p.AIBidMax || 8) });
        if (!top) continue;
        const raise = await game.ask(pl.id, { type: 'number', prompt: `${game.name(host)}: raise the bid of ${bid} by how much life?`, min: 1, max: Math.max(1, pl.life), purpose: 'bidRaise', sa, bid });
        bid += Math.max(1, raise || 1);
        winner = pl; more = true;
        game.log(`${pl.name} bids ${bid} life.`);
      }
    }
    game.log(`${winner.name} wins the bidding with ${bid} life.`);
    host.chosen = { ...(host.chosen || {}), number: bid };
    const saved = host.remembered || [];
    host.remembered = [winner];
    try { await runSub(game, sa, p.BidSubAbility); } finally { host.remembered = saved; }
    game.touch();
  },

  // Cultural Exchange: any number of creatures of one target player, the same number of another's, exchange control
  async ExchangeControlVariant(game, sa) {
    const pls = playersOf(sa.targets.length ? sa.targets : objs(game, sa, null));
    if (pls.length !== 2) return;
    const [a, b] = pls;
    const zone = Z(sa.p.Zone || 'Battlefield');
    const type = sa.p.Type || 'Card';
    const ctx = ctxOf(game, sa);
    const inZone = pl => (zone === 'battlefield' ? game.battlefield.filter(c => c.controller === pl.id && !c.phasedOut) : pl[zone]).filter(c => matchValid(game, c, type, ctx));
    const l1 = inZone(a), l2 = inZone(b);
    const max = Math.min(l1.length, l2.length);
    const c1 = await chooseCards(game, sa.controller, l1, 0, max, `Choose any number of ${a.name}'s creatures to exchange`, sa, 'exchangeChoice');
    const c2 = c1.length ? await chooseCards(game, sa.controller, l2, c1.length, c1.length, `Choose ${c1.length} of ${b.name}'s creatures`, sa, 'exchangeChoice') : [];
    if (!c1.length || c2.length !== c1.length || [...c1, ...c2].some(c => cantGainControl(game, c))) return;
    for (const c of c1) { c.controller = b.id; c.sick = true; game.fire('ChangesController', { Card: c, OriginalController: a.id }); }
    for (const c of c2) { c.controller = a.id; c.sick = true; game.fire('ChangesController', { Card: c, OriginalController: b.id }); }
    if (game.combat) for (const c of [...c1, ...c2]) { game.combat.attackers = game.combat.attackers.filter(x => x.card !== c.id); game.combat.blockers.delete(c.id); }
    game.touch();
    game.log(`${a.name} and ${b.name} exchange control of ${[...c1, ...c2].map(c => game.name(c)).join(', ')}.`);
  },

  // coin flips: called flips (win / lose), heads or tails ("NoCall$ True"), several at once ("Amount$"), until you lose,
  // one for each player; Krark's Thumb (flip two, keep one) and Edgar (the first flips each turn come up heads)
  async FlipCoin(game, sa) {
    const p = sa.p;
    const ctx = ctxOf(game, sa);
    const host = sa.host;
    const noCall = p.NoCall === 'True' || (!!p.Flipper && p.NoCall !== 'False' && !p.WinSubAbility && !p.LoseSubAbility);
    const flippers = p.Flipper ? playersOf(resolveDefined(game, p.Flipper, ctx)) : [game.players[sa.controller]];
    const amount = p.Amount ? Math.max(0, calc(game, p.Amount, sa)) : 1;
    const doublers = pid => game.activeStatics('FlipCoinDoubler').filter(s => matchValid(game, game.players[pid], s.p.ValidPlayer || 'You', s.ctx)).length;
    const flipOne = async (pl, fixed, info = '') => {
      game.turnState.coinFlips = game.turnState.coinFlips || {};
      game.turnState.coinFlips[pl.id] = (game.turnState.coinFlips[pl.id] || 0) + 1;
      let won;
      if (fixed != null) won = fixed;
      else {
        const results = new Set();
        for (let i = 0, n = 1 << doublers(pl.id); i < n; i++) results.add(game.rng.int(2) === 0);
        if (results.size === 1) won = [...results][0];
        else if (noCall) won = (await game.ask(pl.id, { type: 'option', prompt: `${game.name(host)}: you flipped heads and tails. Keep which?`, options: [{ label: 'Heads', value: 'h' }, { label: 'Tails', value: 't' }], purpose: 'flipResult', sa })) !== 't';
        else won = true; // ignore the losing flip
      }
      game.log(`${pl.name} flips a coin${info}: ${noCall ? (won ? 'heads' : 'tails') : (won ? 'wins' : 'loses')}.`);
      if (!noCall || fixed != null) game.fire('FlippedCoin', { Player: pl.id, Result: won });
      return won;
    };
    const flipMany = async (pl, n, info = '') => {
      const fixed = flipCoinFixed(game, pl.id);
      let wins = 0, last = true;
      do {
        for (let i = 0; i < n; i++) { last = await flipOne(pl, fixed, info + (n > 1 ? ` (${i + 1}/${n})` : '')); if (last) wins++; }
      } while (p.FlipUntilYouLose === 'True' && last && wins < 60);
      return { wins, flips: p.FlipUntilYouLose === 'True' ? wins + 1 : n };
    };
    for (const pl of flippers) {
      if (pl.lost) continue;
      if (noCall) {
        const { wins: heads, flips } = await flipMany(pl, amount);
        const tails = flips - heads;
        const v = p.SaveNumFlipsToSVar || 'X';
        if (heads > 0) { if (p.RememberResult === 'True') host.flipResults = { ...host.flipResults, [pl.id]: 'Heads' }; await runSub(game, sa, p.HeadsSubAbility, p.Amount ? { [v]: 'Number$' + heads } : null); }
        if (tails > 0) { if (p.RememberResult === 'True') host.flipResults = { ...host.flipResults, [pl.id]: tails > 0 && heads > 0 ? 'Both' : 'Tails' }; await runSub(game, sa, p.TailsSubAbility, p.Amount ? { [v]: 'Number$' + tails } : null); }
      } else if (p.ForEachPlayer) {
        const won = [], lost = [];
        for (const q of playersOf(resolveDefined(game, p.ForEachPlayer, ctx))) ((await flipMany(pl, 1, ` for ${q.name}`)).wins ? won : lost).push(q);
        const saved = host.remembered || [];
        if (won.length && p.WinSubAbility) { host.remembered = won; try { await runSub(game, sa, p.WinSubAbility, { Wins: 'Number$' + won.length }); } finally { host.remembered = saved; } }
        if (lost.length && p.LoseSubAbility) { host.remembered = lost; try { await runSub(game, sa, p.LoseSubAbility, { Losses: 'Number$' + lost.length }); } finally { host.remembered = saved; } }
      } else {
        const { wins, flips } = await flipMany(pl, amount);
        const losses = flips - wins;
        if (wins > 0) { if (p.RememberWinner === 'True') remember(sa, [pl]); await runSub(game, sa, p.WinSubAbility, { Wins: 'Number$' + wins }); }
        if (losses > 0) { if (p.RememberLoser === 'True') remember(sa, [pl]); await runSub(game, sa, p.LoseSubAbility, { Losses: 'Number$' + losses }); }
        if (p.RememberNumber) host.chosen = { ...(host.chosen || {}), number: /^Win/.test(p.RememberNumber) ? wins : losses };
      }
    }
  },

  // cumulative upkeep, with "whenever its cumulative upkeep is paid / isn't paid" triggers (Balduvian Fallen, Heart of
  // Bogardan, Hibernation's End): the same as effects.js's, telling the triggers what happened
  async CumulativeUpkeep(game, sa) {
    const host = sa.host;
    if (!host || host.zone !== 'battlefield') return;
    await game.addCounters(host, 'AGE', 1, sa);
    const n = host.counters.AGE || 1;
    const pid = sa.controller;
    const costStr = sa.p.UpkeepCost || '0';
    let m;
    const ask = d => game.ask(pid, { type: 'confirm', prompt: `Cumulative upkeep for ${game.name(host)}: ${d}? (otherwise sacrifice it)`, purpose: 'cumulativeUpkeep', sa, cardId: host.id, age: n });
    const paid = (spent = null) => game.fire('PayCumulativeUpkeep', { Card: host, Paid: true, PayingMana: spent || {}, Player: pid });
    if ((m = costStr.match(/^FlipCoin<(\d+)>$/))) {
      if (await ask(`flip ${n * +m[1]} coin${n * +m[1] === 1 ? '' : 's'}`)) {
        for (let i = 0; i < n * +m[1]; i++) { const win = game.rng.int(2) === 0; game.log(`${game.players[pid].name} flips a coin: ${win ? 'wins' : 'loses'}.`); game.fire('FlippedCoin', { Player: pid, Result: win }); }
        paid();
        return;
      }
    } else if ((m = costStr.match(/^PutCardToLibFromSameGrave<(\d+)\/[^/]*\/(\w+)>$/))) {
      const need = n * +m[1];
      const owners = game.livingPlayers().filter(pl => pl.graveyard.filter(c => matchValid(game, c, m[2], ctxOf(game, sa))).length >= need);
      if (owners.length && await ask(`put ${need} cards from a single graveyard on the bottom of their owner's library`)) {
        let from = owners[0];
        if (owners.length > 1) { const id = await game.ask(pid, { type: 'player', prompt: 'From whose graveyard?', players: owners.map(o => o.id), sa, purpose: 'cumulativeUpkeepGrave' }); from = owners.find(o => o.id === id) || owners[0]; }
        const pool = from.graveyard.filter(c => matchValid(game, c, m[2], ctxOf(game, sa)));
        for (const c of await chooseCards(game, pid, pool, need, need, `Put ${need} cards on the bottom of ${from.name}'s library`, sa, 'cumulativeUpkeepCards')) await game.moveCard(c, 'library', { pos: 'bottom', cause: sa });
        paid();
        return;
      }
    } else {
      const cost = parseCost(costStr);
      let mana = parseMana('0');
      for (let i = 0; i < n; i++) mana = addCosts(mana, cost.mana);
      const parts = cost.parts.map(pt => (/^\d+$/.test(pt.amount) ? { ...pt, amount: String(+pt.amount * n), args: [String(+pt.amount * n), ...pt.args.slice(1)] } : pt));
      const full = { ...cost, mana, parts, tap: false, untap: false };
      if ((!cost.hasMana || canAfford(game, pid, mana)) && canPayNonMana(game, sa, full) && await ask(`pay ${costLabel(costStr)} × ${n}`)) {
        sa.root().manaSpent = null;
        if ((!cost.hasMana || await payManaCost(game, pid, mana, { sa })) && await payCostParts(game, sa, full)) { paid(sa.root().manaSpent); return; }
      }
    }
    game.log(`${game.players[pid].name} doesn't pay the cumulative upkeep for ${game.name(host)}.`);
    game.fire('PayCumulativeUpkeep', { Card: host, CardLKI: game.makeLKI(host), Paid: false, Player: pid });
    await game.sacrifice(host, sa);
  },

  // echo, with "when its echo cost is paid" triggers (Shah of Naar Isle)
  async EchoUpkeep(game, sa) {
    const host = sa.host;
    const cost = parseCost(sa.p.EchoCost || '');
    host.echoPaid = true;
    if (cost.hasMana && canAfford(game, sa.controller, cost.mana)) {
      const yes = await game.ask(sa.controller, { type: 'confirm', prompt: `Pay echo for ${game.name(host)}? (otherwise sacrifice it)`, purpose: 'echo', sa, cost: cost.mana });
      if (yes && await payManaCost(game, sa.controller, cost.mana)) { game.fire('PayEcho', { Card: host, Paid: true, Player: sa.controller }); return; }
    }
    game.fire('PayEcho', { Card: host, Paid: false, Player: sa.controller });
    await game.sacrifice(host, sa);
  },
};
