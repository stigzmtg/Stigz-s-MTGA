// Combat rules beyond the basics: banding and "bands with other", creatures that block more than one attacker,
// combat damage assigned in unusual ways (banding, Butcher Orgg, Cunning Giant, "assigns no combat damage"), excess
// damage, effects that change blocks (becomes blocked, block, switch block, Camouflage), attack requirements and
// restrictions, and saddle / crew.
// combat.js calls in here for the rules; effects.js registers COMBAT_EFFECTS. This module only uses what it imports
// inside functions, so the import cycle (effects -> mech-combat -> combat -> abilities -> effects) is harmless.
import { matchValid, calcCtx, resolveDefined, ctxOf, liveOrLki, tapPowerValue } from './filters.js';
import { parseAbility } from './forge.js';
import { refOf, fromRef } from './abilities.js';
import { canBlock, canAttack, canAttackDefender, attackTax, combatPower } from './combat.js';
import { lethalOf } from './mech-last.js';

const nm = (game, o) => game.name(o);
const isCreature = (game, c) => !!c && c.zone === 'battlefield' && game.chars(c).types.has('Creature');

// ---------------------------------------------------------------- combat state helpers
export function recOf(game, a) { return game.combat ? game.combat.attackers.find(r => r.card === a.id) || null : null; }
// the attackers a creature is blocking (a creature that can block more than one, or one blocking a band)
export function attackersBlockedBy(game, b) {
  if (!game.combat) return [];
  return game.combat.attackers.filter(r => r.blockers.includes(b.id)).map(r => game.cardById(r.card)).filter(Boolean);
}
// the attacking creatures in the same band as `a` (itself included)
export function bandOf(game, a) {
  const rec = recOf(game, a);
  if (!rec || rec.band == null) return [a];
  return game.combat.attackers.filter(r => r.band === rec.band).map(r => game.cardById(r.card)).filter(Boolean);
}
// b now blocks a (as an effect does it, or as blocks are recorded): the combat records and the block history
export function addBlock(game, b, a) {
  const rec = recOf(game, a);
  if (!rec || rec.blockers.includes(b.id)) return false;
  rec.blockers.push(b.id);
  rec.blocked = true;
  if (!game.combat.blockers.has(b.id)) game.combat.blockers.set(b.id, a.id);
  if (!(game.combat.blockedIds || []).includes(b.id)) game.combat.blockedIds = [...(game.combat.blockedIds || []), b.id];
  game.turnState.blocks.push({ blocker: b.id, blockerZcc: b.zcc, blockerLKI: game.makeLKI(b), attacker: a.id, attackerZcc: a.zcc, attackerLKI: game.makeLKI(a) });
  return true;
}
// b stops blocking a (the attacker stays blocked)
export function removeBlock(game, b, a) {
  const rec = recOf(game, a);
  if (rec) rec.blockers = rec.blockers.filter(x => x !== b.id);
  if (game.combat.blockers.get(b.id) === a.id) {
    const other = attackersBlockedBy(game, b)[0];
    if (other) game.combat.blockers.set(b.id, other.id); else game.combat.blockers.delete(b.id);
  }
}

// a rough worth for the engine's own suggestions to the AI (what to kill, what to keep)
function worth(game, c) {
  const ch = game.chars(c);
  return Math.max(0, ch.power) + Math.max(0, ch.toughness) / 2 + (ch.cmc || 0) / 2 + Math.min(4, ch.keywords.length) * 0.4 + (c.isCommander ? 6 : 0) - (c.token ? 1 : 0);
}
// damage from src that destroys t (a planeswalker: its loyalty)
function lethalFrom(game, src, t) {
  if (t.isPlayer) return t.life;
  const ch = game.chars(t);
  if (ch.types.has('Planeswalker') && !ch.types.has('Creature')) return t.counters.LOYALTY || 0;
  const left = Math.max(0, lethalOf(ch) - t.damage); // (by power: mech-last.js)
  return src && game.hasKeyword(src, 'Deathtouch') ? Math.min(1, left) : left;
}
const unkillable = (game, t) => !t.isPlayer && game.hasKeyword(t, 'Indestructible');

// ---------------------------------------------------------------- blocking more than one creature
// how many attackers a creature can block: 1, more with "can block an additional creature each combat"
// (CanBlockAmount$ on a static or a pump), any number with "can block any number of creatures" (CanBlockAny$)
export function blockCapacity(game, b) {
  game.ensureChars();
  let extra = 0, any = false;
  for (const { st, ctx } of game._activeStatics || []) {
    const p = st.parsed.p;
    if (p.CanBlockAmount == null && p.CanBlockAny == null) continue;
    if (!staticAffects(game, p, ctx, b)) continue;
    if (p.CanBlockAny != null) any = true;
    else extra += Math.max(0, calcCtx(game, p.CanBlockAmount, ctx));
  }
  for (const t of b.temp || []) { if (t.canBlockAny) any = true; if (t.canBlockAmount) extra += t.canBlockAmount; }
  return any ? Infinity : 1 + extra;
}
function staticAffects(game, p, ctx, c) {
  if (p.AffectedDefined) {
    if (!resolveDefined(game, p.AffectedDefined, ctx).some(x => x && !x.isPlayer && !x.lki && x.id === c.id)) return false;
    return !p.Affected || matchValid(game, c, p.Affected, ctx);
  }
  return !!p.Affected && !/^(You|Player|Opponent)/.test(p.Affected) && matchValid(game, c, p.Affected, ctx);
}
// a pump that lets the creature block more ("can block an additional creature this turn", "any number")
export function pumpBlockExtras(game, sa) {
  const out = {};
  if (sa.p.CanBlockAny != null) out.canBlockAny = true;
  if (sa.p.CanBlockAmount != null) out.canBlockAmount = Math.max(0, calcCtx(game, sa.p.CanBlockAmount, ctxOf(game, sa)));
  return out;
}
// for the blockers prompt: the creatures that can block more than one attacker (99 standing for "any number")
export function blockCaps(game, cands) {
  const caps = {};
  for (const c of cands) { const n = blockCapacity(game, c); if (n > 1) caps[c.id] = Math.min(99, n); }
  return Object.keys(caps).length ? caps : null;
}

// ---------------------------------------------------------------- banding
const hasBanding = (game, c) => game.chars(c).keywords.some(k => k === 'Banding');
const bandsWithOther = (game, c) => game.chars(c).keywords.filter(k => /^Bands with other:/.test(k)).map(k => k.split(':')[1]);
// "Any creatures with banding, and up to one without, can attack in a band"; "any [quality] creatures can attack in a
// band as long as at least one has bands with other [quality]"
export function canFormBand(game, cards) {
  if (cards.length < 2) return true;
  const banding = cards.filter(c => hasBanding(game, c)).length;
  if (banding >= 1 && banding >= cards.length - 1) return true;
  return cards.some(c => bandsWithOther(game, c).some(v => cards.every(x => matchValid(game, x, v, { host: c, you: c.controller }))));
}
// "If any creatures with banding you control are blocking or being blocked by a creature" (or two [quality] creatures,
// one with bands with other [quality]): their controller divides that creature's combat damage
export function sharesDamage(game, cards) {
  if (cards.some(c => hasBanding(game, c))) return true;
  return cards.some(c => bandsWithOther(game, c).some(v => matchValid(game, c, v, { host: c, you: c.controller }) && cards.filter(x => matchValid(game, x, v, { host: c, you: c.controller })).length >= 2));
}
// as attackers are declared: bands (the attacking player picks, for each creature with banding, who joins it)
export async function declareBands(game, ap) {
  const recs = game.combat.attackers;
  let next = 1 + Math.max(0, ...recs.map(r => r.band || 0));
  for (const lead of recs) {
    const c = game.cardById(lead.card);
    if (!c || lead.band != null || (!hasBanding(game, c) && !bandsWithOther(game, c).length)) continue;
    const same = r => r !== lead && r.band == null && r.defenderPlayer === lead.defenderPlayer && r.defenderCard === lead.defenderCard;
    const mates = recs.filter(same).map(r => game.cardById(r.card)).filter(m => m && canFormBand(game, [c, m]));
    if (!mates.length) continue;
    const ids = await game.ask(ap, {
      type: 'cards', prompt: `Banding: choose attacking creatures to attack in a band with ${nm(game, c)} (blocking one of a band blocks them all; you divide the damage a blocker deals to the band)`,
      cards: mates.map(m => m.id), min: 0, max: mates.length, purpose: 'band', cardId: c.id, aiSuggest: aiBand(game, c, mates, lead.defenderPlayer),
    });
    const band = [c];
    for (const id of ids || []) { const m = mates.find(x => x.id === id); if (m && canFormBand(game, [...band, m])) band.push(m); }
    if (band.length < 2) continue;
    const id = next++;
    for (const m of band) recs.find(r => r.card === m.id).band = id;
    game.log(`${game.players[ap].name} attacks with a band: ${band.map(m => nm(game, m)).join(', ')}.`);
  }
  game.touch();
}
// the AI bands when a blocker could kill one of them (the band then shares that blocker's damage), with the biggest
// creature without banding along
function aiBand(game, lead, mates, defPid) {
  const all = [lead, ...mates];
  const big = game.battlefield.filter(b => b.controller === defPid && !b.tapped && game.chars(b).types.has('Creature'));
  const risky = all.some(c => big.some(b => combatPower(game, b) >= game.chars(c).toughness - c.damage));
  if (!risky) return [];
  const withB = mates.filter(m => hasBanding(game, m));
  const without = mates.filter(m => !hasBanding(game, m)).sort((x, y) => worth(game, y) - worth(game, x));
  const pick = hasBanding(game, lead) ? [...withB, ...without.slice(0, 1)] : mates.filter(m => canFormBand(game, [lead, m]));
  return pick.map(m => m.id);
}

// ---------------------------------------------------------------- attacking
// "attacking doesn't cause creatures you control to tap" (Johan)
export function attacksWithoutTapping(game, c) {
  return game.activeStatics('AttackVigilance').some(s => matchValid(game, c, s.p.ValidCard || 'Creature', s.ctx));
}
// "can attack as though it had haste" (Instill Energy, Chaos Lord, Frenzied Saddlebrute: only some players)
export function attacksAsThoughHaste(game, c, defender = null) {
  return game.activeStatics('CanAttackIfHaste').some(s => (!s.p.ValidCard || matchValid(game, c, s.p.ValidCard, s.ctx)) && (!s.p.ValidTarget || !defender || matchValid(game, defender, s.p.ValidTarget, s.ctx)));
}
// "If a creature you control attacks, this creature also attacks if able" (Ekundu Cyclops, Viashino Bey, Magnetic Web,
// War's Toll): creatures that must join once another one attacks
export function applyAttackRequirements(game, cands, decl, defenders) {
  const sts = game.activeStatics('AttackRequirement');
  if (!sts.length) return;
  for (let changed = true, guard = 0; changed && guard < 20; guard++) {
    changed = false;
    for (const s of sts) {
      const leaders = decl.filter(x => matchValid(game, x.c, s.p.ValidCard || 'Creature', s.ctx));
      if (!leaders.length) continue;
      for (const c of cands) {
        if (decl.some(x => x.c === c) || !leaders.some(x => x.c !== c)) continue;
        if (!matchValid(game, c, s.p.ValidAttacker || 'Creature', s.ctx)) continue;
        const want = leaders[0].d;
        let d = canAttackDefender(game, c, want.player, want.card ? game.cardById(want.card) : null) ? want : null;
        if (!d) d = defenders.find(x => !x.card && canAttackDefender(game, c, x.player, null));
        if (!d || attackTax(game, c, d.player) > 0) continue;
        decl.push({ c, d, forced: true });
        changed = true;
        game.log(`${nm(game, c)} attacks too (${nm(game, s.host)}).`);
      }
    }
  }
}
// "can't attack alone", "can only attack alone", "can't attack unless at least two other creatures attack", "... unless
// a creature with greater power also attacks", "... unless a black or green creature also attacks"
const ALONE = {
  "CARDNAME can't attack alone.": list => list.length >= 2,
  "CARDNAME can't attack or block alone.": list => list.length >= 2,
  'CARDNAME can only attack alone.': list => list.length === 1,
  "CARDNAME can't attack unless at least two other creatures attack.": list => list.length >= 3,
  "CARDNAME can't attack unless a creature with greater power also attacks.": (list, c, game) => list.some(x => x !== c && game.chars(x).power > game.chars(c).power),
  "CARDNAME can't attack unless a black or green creature also attacks.": (list, c, game) => list.some(x => x !== c && (game.chars(x).colors.has('B') || game.chars(x).colors.has('G'))),
};
const BLOCK_ALONE = {
  "CARDNAME can't block alone.": list => list.length >= 2,
  "CARDNAME can't attack or block alone.": list => list.length >= 2,
  "CARDNAME can't block unless at least two other creatures block.": list => list.length >= 3,
  "CARDNAME can't block unless a creature with greater power also blocks.": (list, c, game) => list.some(x => x !== c && game.chars(x).power > game.chars(c).power),
};
const hiddenKws = (game, c) => game.chars(c).keywords.map(k => k.replace(/^HIDDEN /, ''));
export function attackAloneRules(game, decl) {
  for (let guard = 0; guard < 20; guard++) {
    const list = decl.map(x => x.c);
    const bad = decl.find(x => hiddenKws(game, x.c).some(k => ALONE[k] && !ALONE[k](list, x.c, game)));
    if (!bad) return;
    decl.splice(decl.indexOf(bad), 1);
    game.log(`${nm(game, bad.c)} can't attack this way (${hiddenKws(game, bad.c).find(k => ALONE[k]).replace(/CARDNAME/g, 'it').replace(/\.$/, '')}).`);
  }
}
export function blockAloneRules(game, pairs) {
  for (let guard = 0; guard < 20; guard++) {
    const list = [...new Set(pairs.map(p => p.b))];
    const bad = list.find(c => hiddenKws(game, c).some(k => BLOCK_ALONE[k] && !BLOCK_ALONE[k](list, c, game)));
    if (!bad) return;
    for (let i = pairs.length - 1; i >= 0; i--) if (pairs[i].b === bad) pairs.splice(i, 1);
    game.log(`${nm(game, bad)} can't block this way (${hiddenKws(game, bad).find(k => BLOCK_ALONE[k]).replace(/CARDNAME/g, 'it').replace(/\.$/, '')}).`);
  }
}

// ---------------------------------------------------------------- blocking: statics and requirements
// "Tapped creatures you control can block as though they were untapped" (Masako the Humorless)
export function blocksWhileTapped(game, b) {
  return game.activeStatics('BlockTapped').some(s => matchValid(game, b, s.p.ValidCard || 'Creature', s.ctx));
}
const blockStatic = (game, mode, b, a) => game.activeStatics(mode).some(s => (!s.p.ValidAttacker || matchValid(game, a, s.p.ValidAttacker, s.ctx)) && (!s.p.ValidBlocker || matchValid(game, b, s.p.ValidBlocker, s.ctx)));
// "can block creatures with shadow as though they didn't have shadow" (Aether Web, Heartwood Dryad)
export function blocksAsThoughShadow(game, b, a) { return blockStatic(game, 'CanBlockIfShadow', b, a); }
// "can block Dragons as though it had reach" (Dragon Hunter)
export function blocksAsThoughReach(game, b, a) { return blockStatic(game, 'CanBlockIfReach', b, a); }
// "Creatures with mountainwalk can be blocked as though they didn't have mountainwalk" (Crevasse, Staff of the Ages,
// Street Savvy for the enchanted creature)
export function ignoresLandwalk(game, b, a, kw) {
  const k = kw.replace(/^HIDDEN /, '').replace(/^(\w+)walk$/, 'Landwalk:$1');
  for (const mode of ['IgnoreLandWalk', 'IgnoreLandwalk']) {
    for (const s of game.activeStatics(mode)) {
      if (s.p.ValidAttacker && !matchValid(game, a, s.p.ValidAttacker, s.ctx)) continue;
      if (s.p.ValidBlocker && !matchValid(game, b, s.p.ValidBlocker, s.ctx)) continue;
      if (s.p.ValidKeyword && !s.p.ValidKeyword.split(',').some(v => k === v || k.startsWith(v + ':'))) continue;
      return true;
    }
  }
  return false;
}
// lure-like requirements on an attacker: "All creatures able to block CARDNAME do so" and "All Walls able to block
// CARDNAME do so" (MustBeBlockedByAll:Creature.Wall): the filters that blockers must match
export function lureFilters(game, a) {
  const out = [];
  for (const k of game.chars(a).keywords) {
    if (/^(HIDDEN )?All creatures able to block CARDNAME do so\.$/.test(k)) out.push('Creature');
    const m = /^MustBeBlockedByAll:([^:]+)/.exec(k);
    if (m) out.push(m[1]);
  }
  return out;
}
// "It blocks each attacking creature this turn if able" (Blaze of Glory)
export function mustBlockAll(game, sa, cards) {
  const atks = (resolveDefined(game, sa.p.DefinedAttacker || 'Valid Card.attacking', ctxOf(game, sa)) || []).map(c => liveOrLki(game, c)).filter(c => c && c.isCard);
  for (const c of cards) {
    if (c.zone !== 'battlefield') continue;
    c.mustBlock = { attackers: atks.map(a => a.id), attacker: atks[0] ? atks[0].id : null, turn: game.turnNumber };
    game.log(`${nm(game, c)} blocks each attacking creature this turn if able.`);
  }
  game.touch();
}

// ---------------------------------------------------------------- combat damage
// "CARDNAME assigns no combat damage this turn" (Ophidian and friends)
export function assignsNoCombatDamage(game, c) {
  return game.activeStatics('AssignNoCombatDamage').some(s => matchValid(game, c, s.p.ValidCard || 'Card.Self', s.ctx));
}
// "assigns combat damage as though its power were positive" (Loot, the Anomaly)
export function negatedPower(game, c, power) {
  return power < 0 && game.activeStatics('CombatDamageNegatePower').some(s => matchValid(game, c, s.p.ValidCard || 'Card.Self', s.ctx)) ? -power : power;
}

// how one source's combat damage is divided among several creatures (and players): the deciding player says how
// much goes to each in turn, the last one getting what's left. `how` is the engine's suggestion for the AI: 'kill'
// (destroy as much as possible, best first) or 'save' (lose as little as possible)
export async function divideDamage(game, pid, src, amount, targets, how) {
  if (targets.length <= 1) return targets.length ? [amount] : [];
  const suggest = how === 'save' ? saveSplit(game, src, amount, targets) : killSplit(game, src, amount, targets);
  const out = [];
  let left = amount;
  for (let i = 0; i < targets.length - 1; i++) {
    if (left <= 0) { out.push(0); continue; }
    const t = targets[i];
    const n = await game.ask(pid, {
      type: 'number', prompt: `${nm(game, src)} deals ${amount} combat damage, divided as you choose: how much to ${t.isPlayer ? t.name : nm(game, t)}? (${left} left, ${targets.length - i - 1} more after this)`,
      min: 0, max: left, purpose: 'divide', target: refOf(t), left, targetsLeft: targets.length - i, cardId: src.id, combatDamage: true, aiSuggest: Math.max(0, Math.min(left, suggest[i])),
    });
    const v = Math.max(0, Math.min(left, n | 0));
    out.push(v); left -= v;
  }
  out.push(left);
  game.log(`${nm(game, src)}'s combat damage: ${targets.map((t, i) => `${out[i]} to ${t.isPlayer ? t.name : nm(game, t)}`).join(', ')}.`);
  return out;
}
// destroy the most worthwhile targets first; what's left goes to the first player, else the best target
function killSplit(game, src, amount, targets) {
  const out = targets.map(() => 0);
  let left = amount;
  const order = targets.map((t, i) => ({ t, i })).filter(x => !x.t.isPlayer && !unkillable(game, x.t)).sort((x, y) => worth(game, y.t) - worth(game, x.t));
  for (const { t, i } of order) { const need = lethalFrom(game, src, t); if (need <= left) { out[i] = need; left -= need; } }
  if (left > 0) { const p = targets.findIndex(t => t.isPlayer); out[p >= 0 ? p : (order[0] ? order[0].i : 0)] += left; }
  return out;
}
// keep everything alive if the damage can be spread that way, else let only the least worthwhile one take the rest
function saveSplit(game, src, amount, targets) {
  const out = targets.map(() => 0);
  const order = targets.map((t, i) => ({ t, i })).sort((x, y) => worth(game, y.t) - worth(game, x.t));
  const cheapest = order[order.length - 1];
  let left = amount;
  for (const { t, i } of order) {
    if (t === cheapest.t) continue;
    const room = unkillable(game, t) ? left : Math.max(0, lethalFrom(game, src, t) - 1);
    const n = Math.min(left, room);
    out[i] = n; left -= n;
  }
  out[cheapest.i] += left;
  return out;
}

// an attacker's combat damage when it isn't simply assigned as usual: Butcher Orgg's "divided as you choose among
// defending player and/or any number of creatures they control", Cunning Giant's "if it's unblocked, to a creature
// defending player controls", and banding ("you divide that creature's combat damage, not its controller"). Returns the
// assignments, or null for the usual ones.
export async function attackerDamage(game, rec, a, power, blockers) {
  const kws = hiddenKws(game, a);
  const defP = game.players[rec.defenderPlayer];
  const theirs = defP && !defP.lost ? game.battlefield.filter(c => c.controller === defP.id && game.chars(c).types.has('Creature')) : [];
  if (theirs.length && kws.includes("You may assign CARDNAME's combat damage divided as you choose among defending player and/or any number of creatures they control.")) {
    const plan = killSplit(game, a, power, [defP, ...theirs.filter(c => worth(game, c) >= 3 || blockers.includes(c))]);
    const planned = [defP, ...theirs.filter(c => worth(game, c) >= 3 || blockers.includes(c))].filter((t, i) => plan[i] > 0);
    const yes = await game.ask(a.controller, { type: 'confirm', prompt: `${nm(game, a)}: divide its ${power} combat damage as you choose among ${defP.name} and/or creatures they control?`, purpose: 'divideCombatDamage', cardId: a.id, aiSuggest: rec.blocked || planned.some(t => !t.isPlayer) });
    if (yes) {
      const cands = [defP, ...theirs];
      const picked = await game.ask(a.controller, { type: 'targets', prompt: `${nm(game, a)}: choose what to divide its ${power} combat damage among`, cands: cands.map(refOf), min: 1, max: cands.length, purpose: 'divideCombatDamage', cardId: a.id, aiSuggest: planned.map(refOf) });
      const ts = cands.filter(t => (picked || []).includes(refOf(t)));
      if (ts.length) {
        const split = await divideDamage(game, a.controller, a, power, ts, 'kill');
        return ts.map((t, i) => ({ src: a, tgt: t, n: split[i] })).filter(x => x.n > 0);
      }
    }
  }
  if (!rec.blocked && theirs.length && kws.includes('If CARDNAME is unblocked, you may have it assign its combat damage to a creature defending player controls.')) {
    const best = theirs.filter(c => !unkillable(game, c) && lethalFrom(game, a, c) <= power && worth(game, c) >= 4).sort((x, y) => worth(game, y) - worth(game, x))[0];
    const picked = await game.ask(a.controller, { type: 'targets', prompt: `${nm(game, a)} is unblocked: you may have it assign its combat damage to a creature ${defP.name} controls instead`, cands: theirs.map(refOf), min: 0, max: 1, purpose: 'unblockedToCreature', cardId: a.id, aiSuggest: best ? [refOf(best)] : [] });
    const t = (picked || []).map(r => fromRef(game, r)).find(c => theirs.includes(c));
    if (t) { game.log(`${nm(game, a)} assigns its combat damage to ${nm(game, t)}.`); return [{ src: a, tgt: t, n: power }]; }
  }
  // banding: the defending player divides the damage among the creatures blocking it (none of it tramples over)
  if (blockers.length && sharesDamage(game, blockers)) {
    const split = await divideDamage(game, blockers[0].controller, a, power, blockers, 'save');
    return blockers.map((b, i) => ({ src: a, tgt: b, n: split[i] })).filter(x => x.n > 0);
  }
  return null;
}
// a blocker's combat damage: all to the one it blocks, or divided among several (by its controller, or by the
// attacking player when banding is among them)
export async function blockerDamage(game, b, atks, power) {
  if (atks.length === 1) return [{ src: b, tgt: atks[0], n: power }];
  const ap = atks[0].controller;
  const byAttacker = atks.every(x => x.controller === ap) && sharesDamage(game, atks);
  const split = await divideDamage(game, byAttacker ? ap : b.controller, b, power, atks, byAttacker ? 'save' : 'kill');
  return atks.map((a, i) => ({ src: b, tgt: a, n: split[i] })).filter(x => x.n > 0);
}

// ---------------------------------------------------------------- excess damage
// damage beyond what's lethal for a creature (deathtouch: 1), or beyond a planeswalker's loyalty
export function excessDamageOf(game, target, ch, amount, deathtouch) {
  if (!target.isCard || amount <= 0) return 0;
  if (ch.types.has('Creature')) { const left = Math.max(0, lethalOf(ch) - target.damage); return Math.max(0, amount - (deathtouch ? Math.min(1, left) : left)); }
  if (ch.types.has('Planeswalker')) return Math.max(0, amount - (target.counters.LOYALTY || 0));
  return 0;
}
export function noteExcessDamage(game, source, target, n, combat) {
  target.excessDamage = { turn: game.turnNumber, zcc: target.zcc };
  game.fire('ExcessDamage', { Target: target, DamageTarget: target, DamageAmount: n, IsCombatDamage: combat, Source: source });
  if (game.damageBatch) (game.excessBatch = game.excessBatch || []).push({ target, combat });
  else game.fire('ExcessDamageAll', { DamageTargets: [target], Targets: [target], IsCombatDamage: combat });
}
// one "whenever one or more creatures are dealt excess damage" for all the damage dealt at once
export function flushExcessDamage(game) {
  const b = game.excessBatch;
  game.excessBatch = null;
  if (b && b.length) game.fire('ExcessDamageAll', { DamageTargets: b.map(x => x.target), Targets: b.map(x => x.target), IsCombatDamage: b[0].combat });
}

// ---------------------------------------------------------------- saddle and crew
export function isSaddled(game, c) { return !!c.saddled && c.saddled.turn === game.turnNumber && c.saddled.zcc === c.zcc; }
// "becomes saddled until end of turn" (AlterAttribute Saddle): who saddled it this turn, how many times
export function saddle(game, sa, c) {
  const by = ((sa.root().paid || {}).Tapped || []).map(x => (x.lki ? x.card : x)).filter(Boolean);
  const prev = isSaddled(game, c) ? c.saddled : null;
  c.saddled = { turn: game.turnNumber, zcc: c.zcc, by: [...(prev ? prev.by : []), ...by.map(x => ({ id: x.id, zcc: x.zcc }))], times: (prev ? prev.times : 0) + 1 };
  game.touch();
  game.log(`${nm(game, c)} becomes saddled${by.length ? ` (by ${by.map(x => nm(game, x)).join(', ')})` : ''}.`);
  game.fire('BecomesSaddled', { Card: c, Crew: by, TimesSaddled: c.saddled.times });
}
// "creatures that saddled it this turn" (relative to the Mount)
export function saddledBy(game, mount, c) { return !!mount && isSaddled(game, mount) && mount.saddled.by.some(x => x.id === c.id && x.zcc === c.zcc); }
// "Enchanted permanent can't crew Vehicles" (Bound in Gold, Revoke Privileges)
export function cantCrew(game, c) { return game.activeStatics('CantCrew').some(s => matchValid(game, c, s.p.ValidCard || 'Card.Self', s.ctx)); }
// as a crew or saddle cost is paid: "whenever this creature crews a Vehicle / saddles a Mount" (one each)
export function crewedBy(game, sa, part, cards) {
  const host = sa.host;
  const sub = game.chars(host).subtypes;
  if (part.type === 'Crew' && sub.has('Vehicle')) for (const c of cards) game.fire('Crewed', { Card: host, Crew: c });
  if (sa.p.Saddle === 'True' && sub.has('Mount')) for (const c of cards) game.fire('Saddled', { Card: host, Crew: c });
}
// what each creature counts for when crewing / saddling (TapPowerValue: "as though its power were 2 greater",
// "using its toughness")
export function crewPowers(game, cards, sa) { return Object.fromEntries(cards.map(c => [c.id, tapPowerValue(game, c, sa)])); }
// the AI's pick for a crew / saddle cost: creatures that can't attack this turn first, then the least worthwhile
export function crewPick(game, cards, need, sa) {
  const idle = c => c.sick && !game.hasKeyword(c, 'Haste') || game.hasKeyword(c, 'Defender');
  const sorted = cards.slice().sort((x, y) => (idle(y) - idle(x)) || (worth(game, x) - worth(game, y)));
  const out = [];
  let pw = 0;
  for (const c of sorted) { if (pw >= need) break; out.push(c.id); pw += tapPowerValue(game, c, sa); }
  return out;
}
// the AI saddles a Mount that can attack, before combat, with creatures that can't attack anyway
export function aiSaddleScore(game, pid, card, cost, ctx) {
  if (!(ctx.main && ctx.myTurn && game.step === 'main1') || isSaddled(game, card) || !canAttack(game, card)) return 0;
  const part = cost.parts.find(x => x.type === 'tapXType');
  const need = +((/withTotalPowerGE(\d+)/.exec(part && part.valid || '') || [])[1] || 1);
  const sa = { p: { Saddle: 'True' }, host: card, controller: pid };
  const idle = game.battlefield.filter(c => c.controller === pid && c !== card && !c.tapped && game.chars(c).types.has('Creature') && (c.sick && !game.hasKeyword(c, 'Haste') || game.hasKeyword(c, 'Defender')));
  return idle.reduce((s, c) => s + tapPowerValue(game, c, sa), 0) >= need ? 3 : 0;
}

// ---------------------------------------------------------------- the AI's extra blocks
// a creature that can block more than one attacker also takes on other attackers it survives
export function aiExtraBlocks(game, pid, req, out) {
  const atks = req.attackers.map(id => game.cardById(id)).filter(Boolean);
  const taken = new Set(out.map(x => x.attacker));
  for (const id of req.candidates) {
    const b = game.cardById(id);
    if (!b) continue;
    const cap = blockCapacity(game, b);
    if (cap <= 1) continue;
    const mine = out.filter(x => x.blocker === id).map(x => game.cardById(x.attacker)).filter(Boolean);
    for (const a of atks) {
      if (mine.length >= cap) break;
      if (taken.has(a.id) || !canBlock(game, b, a)) continue;
      const hits = [...mine, a];
      if (hits.some(x => game.hasKeyword(x, 'Deathtouch')) && !unkillable(game, b)) continue;
      const dmg = hits.reduce((s, x) => s + Math.max(0, combatPower(game, x)) * (game.hasKeyword(x, 'Double Strike') ? 2 : 1), 0);
      if (!unkillable(game, b) && dmg >= game.chars(b).toughness - b.damage) continue;
      out.push({ blocker: id, attacker: a.id });
      mine.push(a); taken.add(a.id);
    }
  }
  return out;
}

// ---------------------------------------------------------------- replacing the declare blockers step (Camouflage)
// "instead of declaring blockers, each defending player chooses any number of creatures they control and divides them
// into a number of piles equal to the number of attacking creatures ... Assign each pile to a different one of those
// attacking creatures at random. Each creature in a pile that can block the creature that pile is assigned to does so."
export async function replaceDeclareBlockers(game, dp, atks, cands) {
  const r = game.replacementsFor('DeclareBlocker').find(({ p, ctx }) => !p.ValidPlayer || matchValid(game, game.players[dp], p.ValidPlayer, ctx));
  if (!r) return null;
  const raw = r.p.ReplaceWith && r.r.svars[r.p.ReplaceWith];
  if (!raw || parseAbility(raw).api !== 'Camouflage') return null;
  return camouflagePiles(game, dp, atks, cands, r.h);
}
async function camouflagePiles(game, dp, atks, cands, host) {
  const left = new Map(cands.map(c => [c.id, Math.min(atks.length, blockCapacity(game, c))]));
  // (the AI's piles: one sturdy creature each)
  const sturdy = cands.slice().sort((x, y) => game.chars(y).toughness - game.chars(x).toughness);
  const piles = [];
  for (let i = 0; i < atks.length; i++) {
    const pool = cands.filter(c => left.get(c.id) > 0);
    if (!pool.length) { piles.push([]); continue; }
    const ids = await game.ask(dp, {
      type: 'cards', prompt: `${nm(game, host)}: choose the creatures for pile ${i + 1} of ${atks.length}. Each pile goes to a different attacker at random, and each creature in it blocks that attacker if it can.`,
      cards: pool.map(c => c.id), min: 0, max: pool.length, purpose: 'camouflagePile', aiSuggest: sturdy[i] && pool.includes(sturdy[i]) ? [sturdy[i].id] : [],
    });
    const pile = (ids || []).map(id => game.cardById(id)).filter(c => c && pool.includes(c));
    for (const c of pile) left.set(c.id, left.get(c.id) - 1);
    piles.push(pile);
  }
  game.rng.shuffle(piles);
  const out = [];
  piles.forEach((pile, i) => { for (const b of pile) out.push({ blocker: b.id, attacker: atks[i].id }); });
  game.log(`${game.players[dp].name}'s piles are assigned at random: ${piles.map((p, i) => `${nm(game, atks[i])} ← ${p.length ? p.map(c => nm(game, c)).join(', ') : 'nothing'}`).join('; ')}.`);
  return out;
}

// ---------------------------------------------------------------- what support.js can't see on its own
// combat abilities written as hidden keywords ("CARDNAME can't attack alone.") or as parameters of other abilities
// (CanBlockAmount$ on a static or a pump): the ones the engine doesn't do get flagged
const HIDDEN_DONE = new Set([
  "CARDNAME can't block.", "CARDNAME can't attack.", "CARDNAME can't attack or block.", "CARDNAME can't block creatures.",
  'All creatures able to block CARDNAME do so.', 'CARDNAME must be blocked if able.', 'CARDNAME must be blocked by exactly one creature if able.',
  'CARDNAME must be blocked by two or more creatures if able.', 'CARDNAME can block only creatures with flying.', "CARDNAME can't be blocked.",
  'Prevent all combat damage that would be dealt to CARDNAME.', 'Prevent all combat damage that would be dealt by CARDNAME.', 'Prevent all combat damage that would be dealt to and dealt by CARDNAME.',
  "You may assign CARDNAME's combat damage divided as you choose among defending player and/or any number of creatures they control.",
  'If CARDNAME is unblocked, you may have it assign its combat damage to a creature defending player controls.',
  ...Object.keys(ALONE), ...Object.keys(BLOCK_ALONE),
]);
const COMBAT_PARAMS = { CanBlockAmount: true, CanBlockAny: true };
export function combatSupportIssues(face) {
  const out = new Set();
  const kws = [...face.K];
  const texts = [...face.A, ...face.S, ...Object.values(face.svars)];
  for (const t of texts) for (const m of String(t).matchAll(/(?:\bKW|AddKeyword|AddHiddenKeyword)\$ ([^|]+)/g)) kws.push(...m[1].split(' & ').map(x => x.trim()));
  for (const k0 of kws) {
    const k = k0.replace(/^HIDDEN /, '');
    if (/^(CARDNAME|You may assign CARDNAME|If CARDNAME)\b/.test(k) && /\b(attack|block|blocked|combat damage)/.test(k) && !HIDDEN_DONE.has(k) && !/can't be blocked/.test(k)) out.add(k);
  }
  for (const t of texts) for (const m of String(t).matchAll(/\b(CanBlock\w+)\$/g)) if (!COMBAT_PARAMS[m[1]]) out.add(m[1]);
  return [...out];
}

// ---------------------------------------------------------------- effects
function objs(game, sa, def = null) {
  if (sa.p.ValidTgts || sa.p.TargetType) return (sa.targets || []).map(t => (t.isCard || t.lki ? liveOrLki(game, t) : t));
  const d = sa.p.Defined || def;
  return d ? resolveDefined(game, d, ctxOf(game, sa)) : [];
}
const cardsIn = (game, list) => list.map(o => (o && o.lki ? liveOrLki(game, o) : o)).filter(o => o && o.isCard && !o.lki);

export const COMBAT_EFFECTS = {
  // "Target unblocked attacking creature becomes blocked" (Curtain of Light, Trap Runner, Fog Patch, Choking Vines):
  // no blocker, but it's blocked (so it deals no combat damage unless it has trample); a band becomes blocked together
  async BecomesBlocked(game, sa) {
    if (!game.combat) return;
    const hit = new Set();
    for (const c of cardsIn(game, objs(game, sa, null))) if (game.isAttacking(c)) for (const m of bandOf(game, c)) hit.add(m);
    const newly = [];
    for (const c of hit) {
      const rec = recOf(game, c);
      if (!rec || rec.blocked) continue;
      rec.blocked = true;
      newly.push(c);
      game.log(`${nm(game, c)} becomes blocked.`);
      game.fire('AttackerBlocked', { Attacker: c, Card: c, Blockers: [], DefendingPlayer: rec.defenderPlayer, NumBlockers: 0 });
    }
    if (newly.length) game.fire('AttackerBlockedOnce', { Attackers: newly });
    game.touch();
  },
  // "Then it blocks an attacking creature of your choice" (Balduvian Warlord, False Orders)
  async Block(game, sa) {
    if (!game.combat) return;
    const ctx = ctxOf(game, sa);
    const atks = cardsIn(game, resolveDefined(game, sa.p.DefinedAttacker || 'Targeted', ctx)).filter(c => game.isAttacking(c));
    const blockers = cardsIn(game, resolveDefined(game, sa.p.DefinedBlocker || 'Self', ctx)).filter(c => isCreature(game, c));
    if (!atks.length || !blockers.length) return;
    const newly = [];
    for (const a0 of atks) {
      for (const a of bandOf(game, a0)) {
        const was = recOf(game, a).blocked;
        const added = [];
        for (const b of blockers) {
          if (!addBlock(game, b, a)) continue;
          added.push(b);
          game.log(`${nm(game, b)} blocks ${nm(game, a)}.`, { type: 'block' });
          game.fire('AttackerBlockedByCreature', { Attacker: a, Blocker: b });
          game.fire('Blocks', { Blocker: b, Card: b, Attacker: a, Attackers: [a] });
        }
        if (added.length && !was) {
          newly.push(a);
          game.fire('AttackerBlocked', { Attacker: a, Card: a, Blockers: added, Blocker: added[0], DefendingPlayer: recOf(game, a).defenderPlayer, NumBlockers: added.length });
        }
      }
    }
    if (newly.length) game.fire('AttackerBlockedOnce', { Attackers: newly });
    game.touch();
  },
  // General Jarkeld: two blocked attackers trade blockers; Sorrow's Path: two blockers trade the attackers they block
  async SwitchBlock(game, sa) {
    if (!game.combat) return;
    const ctx = ctxOf(game, sa);
    const atks = cardsIn(game, resolveDefined(game, sa.p.DefinedAttacker || 'Targeted', ctx)).filter(c => game.isAttacking(c));
    const blockers = cardsIn(game, resolveDefined(game, sa.p.DefinedBlocker || 'Targeted', ctx)).filter(c => game.isBlocking(c));
    const blocking = (b, a) => attackersBlockedBy(game, b).includes(a);
    if (sa.p.DefinedAttacker === 'Targeted') {
      if (atks.length < 2 || !blockers.length) return;
      const [a1, a2] = atks;
      const r1 = recOf(game, a1), r2 = recOf(game, a2);
      if (r1.band != null && r1.band === r2.band) return;
      if (blockers.some(b => (blocking(b, a1) && !canBlock(game, b, a2)) || (blocking(b, a2) && !canBlock(game, b, a1)))) { game.log(`${nm(game, sa.host)}: those blockers can't be switched.`); return; }
      const st = blockers.map(b => [b, blocking(b, a1), blocking(b, a2)]);
      for (const [b, x, y] of st) { if (x) removeBlock(game, b, a1); if (y) removeBlock(game, b, a2); }
      for (const [b, x, y] of st) { if (x && !y) addBlock(game, b, a2); if (y && !x) addBlock(game, b, a1); if (x && y) { addBlock(game, b, a1); addBlock(game, b, a2); } }
      game.log(`${nm(game, a1)} and ${nm(game, a2)} switch blockers.`);
    } else {
      if (blockers.length < 2) return;
      const [b1, b2] = blockers;
      const l1 = attackersBlockedBy(game, b1), l2 = attackersBlockedBy(game, b2);
      if (l1.length > blockCapacity(game, b2) || l2.length > blockCapacity(game, b1)) return;
      if (l1.some(a => !canBlock(game, b2, a)) || l2.some(a => !canBlock(game, b1, a))) { game.log(`${nm(game, sa.host)}: those blockers can't be switched.`); return; }
      for (const a of l1) removeBlock(game, b1, a);
      for (const a of l2) removeBlock(game, b2, a);
      for (const a of l1) { addBlock(game, b2, a); if (sa.p.RemoveFromCombat) game.fire('Blocks', { Blocker: b2, Card: b2, Attacker: a, Attackers: [a] }); }
      for (const a of l2) { addBlock(game, b1, a); if (sa.p.RemoveFromCombat) game.fire('Blocks', { Blocker: b1, Card: b1, Attacker: a, Attackers: [a] }); }
      game.log(`${nm(game, b1)} and ${nm(game, b2)} switch the creatures they block.`);
    }
    game.touch();
  },
  // (Camouflage's piles replace the declare blockers step itself: replaceDeclareBlockers)
  async Camouflage() {},
};

// "Remove target blocking creature from combat. Creatures it was blocking that hadn't become blocked by another
// creature this combat become unblocked." (RemoveFromCombat with UnblockCreaturesBlockedOnlyBy$)
export function unblockBlockedOnlyBy(game, b) {
  if (!game.combat) return;
  for (const rec of game.combat.attackers) if (rec.blockers.length && rec.blockers.every(x => x === b.id)) rec.blocked = false;
}
