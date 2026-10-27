// Combat: attacker/blocker legality, declarations and combat damage.
import { matchValid, calcCtx, checkPresence } from './filters.js';
import { parseAbility } from './forge.js';
import { refOf, fromRef, payManaCost, canAfford } from './abilities.js';
import { parseMana } from './mana.js';
import { BASIC_LAND_TYPES } from './util.js';
import * as M from './mech-combat.js';
import { cantBecomeMonarch } from './mech-classic-rules.js';
import { lethalOf } from './mech-last.js';

function kw(game, c, k) { return game.hasKeyword(c, k); }
function hidden(game, c, text) { return game.chars(c).keywords.some(k => k === text || k === 'HIDDEN ' + text); }

export function canAttack(game, c, { ignoreTapped = false } = {}) {
  if (c.zone !== 'battlefield' || c.phasedOut) return false;
  const ch = game.chars(c);
  if (!ch.types.has('Creature')) return false;
  if (c.tapped && !ignoreTapped) return false;
  if (c.sick && !kw(game, c, 'Haste') && !M.attacksAsThoughHaste(game, c)) return false;
  if (kw(game, c, 'Defender') && !game.activeStatics('CanAttackDefender').some(s => matchValid(game, c, s.p.ValidCard || 'Card.Self', s.ctx))) return false;
  if (hidden(game, c, "CARDNAME can't attack.") || hidden(game, c, "CARDNAME can't attack or block.")) return false;
  for (const s of game.activeStatics('CantAttack')) {
    // (one that names whom it can't attack, or "unless defending player ...", depends on the defender: canAttackDefender)
    if (s.p.ValidCard && matchValid(game, c, s.p.ValidCard, s.ctx) && !s.p.Target && !s.p.UnlessDefender) return false;
  }
  if (c.suspected === false) return false;
  return true;
}

// nearest living opponent of pid to the left (turn order) or right
export function playerInDirection(game, pid, dir) {
  const n = game.players.length, step = dir === 'Right' ? -1 : 1;
  for (let k = 1; k < n; k++) { const q = game.players[(pid + step * k + n * 4) % n]; if (!q.lost && q.id !== pid) return q.id; }
  return null;
}

// Restrictions for attacking a specific defender (player or planeswalker)
export function canAttackDefender(game, c, defPid, defCard) {
  // "can attack your opponents as though it had haste" (Frenzied Saddlebrute): only some players
  if (c.sick && !kw(game, c, 'Haste') && !M.attacksAsThoughHaste(game, c, defCard || game.players[defPid])) return false;
  // "can attack players who attacked you during their last turn as though it didn't have defender"
  if (kw(game, c, 'Defender')) {
    const sts = game.activeStatics('CanAttackDefender').filter(s => matchValid(game, c, s.p.ValidCard || 'Card.Self', s.ctx));
    if (sts.length && !sts.some(s => !s.p.ValidAttacked || matchValid(game, defCard || game.players[defPid], s.p.ValidAttacked, s.ctx))) return false;
  }
  for (const s of game.activeStatics('CantAttack')) {
    if (s.p.DefenderNotNearestToYouInChosenDirection === 'True') {
      // "each player may attack only the nearest opponent in the chosen direction and planeswalkers controlled by that opponent"
      const dir = s.host.chosen && s.host.chosen.direction;
      if (dir && playerInDirection(game, c.controller, dir) !== defPid) return false;
      continue;
    }
    // "can't attack unless defending player controls an Island" (Slipstream Eel and the like)
    if (s.p.UnlessDefender) {
      if (s.p.ValidCard && !matchValid(game, c, s.p.ValidCard, s.ctx)) continue;
      if (!defenderHas(game, game.players[defPid], s.p.UnlessDefender, s.ctx)) return false;
      continue;
    }
    if (!s.p.Target) continue;
    if (s.p.ValidCard && !matchValid(game, c, s.p.ValidCard, s.ctx)) continue;
    const tgt = defCard || game.players[defPid];
    if (matchValid(game, tgt, s.p.Target, s.ctx)) return false;
  }
  return true;
}

// a player property as Forge's UnlessDefender$ writes it: "controlsIsland", "!controlsLand.untapped", "IsPoisoned",
// "controlsEnchantment,Permanent.enchanted" (either)
function defenderHas(game, player, prop, ctx) {
  if (!player) return false;
  if (prop.startsWith('!')) return !defenderHas(game, player, prop.slice(1), ctx);
  const m = /^controls(.+)$/.exec(prop);
  if (m && m[1].includes(',')) return m[1].split(',').some(t => defenderHas(game, player, 'controls' + t, ctx));
  return matchValid(game, player, 'Player.' + prop, ctx);
}

export function attackTax(game, c, defPid) {
  let tax = 0;
  for (const s of game.activeStatics('CantAttackUnless')) {
    if (s.p.ValidCard && !matchValid(game, c, s.p.ValidCard, s.ctx)) continue;
    if (s.p.Target && !matchValid(game, game.players[defPid], s.p.Target, s.ctx)) continue;
    const cost = s.p.Cost || '';
    const m = cost.match(/^(\d+)$/);
    if (m) tax += +m[1];
    else if (/^X$/.test(cost)) tax += 0;
    else tax += 2;
  }
  return tax;
}

export function attackCandidates(game, pid) {
  return game.battlefield.filter(c => c.controller === pid && canAttack(game, c));
}

export function defendersFor(game, pid) {
  const out = [];
  for (const p of game.opponents(pid)) {
    out.push({ ref: 'p' + p.id, player: p.id });
    for (const c of game.battlefield) {
      if (c.controller === p.id && !c.phasedOut) {
        const ch = game.chars(c);
        if (ch.types.has('Planeswalker')) out.push({ ref: 'c' + c.id, player: p.id, card: c.id });
        if (ch.types.has('Battle')) out.push({ ref: 'c' + c.id, player: p.id, card: c.id, battle: true });
      }
    }
  }
  return out;
}

export async function declareAttackers(game) {
  const ap = game.activePlayer;
  const cands = attackCandidates(game, ap);
  if (!cands.length) return;
  const defenders = defendersFor(game, ap);
  if (!defenders.length) return;
  const ans = await game.ask(ap, { type: 'attackers', candidates: cands.map(c => c.id), defenders });
  const decl = [];
  const used = new Set();
  for (const a of ans || []) {
    const c = game.cardById(a.attacker);
    if (!c || used.has(c.id) || !cands.includes(c)) continue;
    const d = defenders.find(x => x.ref === a.defender) || defenders[0];
    if (!canAttackDefender(game, c, d.player, d.card ? game.cardById(d.card) : null)) continue;
    used.add(c.id);
    decl.push({ c, d });
  }
  // requirements: goaded creatures, "attacks each combat if able"
  for (const c of cands) {
    const goaders = game.goaders(c);
    let must = goaders.length > 0 || c.mustAttack != null;
    let forced = null;
    for (const s of game.activeStatics('MustAttack')) {
      if (!matchValid(game, c, s.p.ValidCreature || s.p.ValidCard || 'Card.Self', s.ctx)) continue;
      must = true;
      if (s.p.MustAttack) { const t = s.p.MustAttack === 'You' ? s.ctx.you : null; if (t != null) forced = t; }
    }
    // "if that creature had to attack this combat"
    if (must) c.hadToAttack = { turn: game.turnNumber, combat: game.combatsThisTurn || 0 };
    if (!must || used.has(c.id)) continue;
    let d = null;
    if (c.mustAttack != null) d = defenders.find(x => x.player === c.mustAttack && !x.card);
    if (!d && forced != null) d = defenders.find(x => x.player === forced && !x.card);
    if (!d && goaders.length) d = defenders.find(x => !x.card && !goaders.includes(x.player) && canAttackDefender(game, c, x.player, null));
    if (!d) d = defenders.find(x => !x.card && canAttackDefender(game, c, x.player, null)) || defenders.find(x => !x.card);
    if (d && canAttackDefender(game, c, d.player, null)) { used.add(c.id); decl.push({ c, d, forced: true }); }
  }
  // "if a creature you control attacks, this creature also attacks if able"
  M.applyAttackRequirements(game, cands, decl, defenders);
  // "each opponent must attack with at least one creature each combat if able"
  if (!decl.length && game.activeStatics('PlayerMustAttack').some(s => matchValid(game, game.players[ap], s.p.ValidPlayer || 'Opponent', s.ctx))) {
    for (const c of cands) {
      const d = defenders.find(x => !x.card && canAttackDefender(game, c, x.player, null));
      if (d) { decl.push({ c, d, forced: true }); game.log(`${game.players[ap].name} must attack with at least one creature.`); break; }
    }
  }
  // "no more than N creatures can attack [you / this planeswalker] each combat"
  for (const s of game.activeStatics('AttackRestrict')) {
    const max = s.p.MaxAttackers != null ? calcCtx(game, s.p.MaxAttackers, s.ctx) : 99;
    const hits = decl.filter(({ d }) => !s.p.ValidDefender || matchValid(game, d.card ? game.cardById(d.card) : game.players[d.player], s.p.ValidDefender, s.ctx));
    if (hits.length <= max) continue;
    const keep = [...hits.filter(x => x.forced), ...hits.filter(x => !x.forced)].slice(0, Math.max(0, max));
    const drop = hits.filter(x => !keep.includes(x));
    for (let i = decl.length - 1; i >= 0; i--) if (drop.includes(decl[i])) decl.splice(i, 1);
    game.log(`${game.name(s.host)}: no more than ${max} creature${max === 1 ? '' : 's'} can attack${s.p.ValidDefender ? ' ' + (s.p.ValidDefender === 'Card.Self' ? game.name(s.host) : game.players[s.ctx.you].name) : ''} (${drop.map(x => game.name(x.c)).join(', ')} won't attack).`);
  }
  // "can't attack alone", "can only attack alone", "... unless at least two other creatures attack"
  M.attackAloneRules(game, decl);
  // attack taxes (Propaganda-style)
  let tax = 0;
  for (const { c, d } of decl) tax += attackTax(game, c, d.player);
  if (tax > 0) {
    const cost = parseMana(String(tax));
    if (!canAfford(game, ap, cost) || !(await payManaCost(game, ap, cost))) {
      game.log(`${game.players[ap].name} can't pay the attack tax; no attack.`);
      return;
    }
  }
  if (!decl.length) return;
  for (const { c, d } of decl) {
    game.combat.attackers.push({ card: c.id, defenderPlayer: d.player, defenderCard: d.card || null, blockers: [], blocked: false });
    if (!kw(game, c, 'Vigilance') && !M.attacksWithoutTapping(game, c)) { c.tapped = true; }
  }
  game.touch();
  const names = decl.map(({ c, d }) => `${game.name(c)} → ${d.card ? game.name(game.cardById(d.card)) : game.players[d.player].name}`);
  game.log(`${game.players[ap].name} attacks: ${names.join(', ')}`, { type: 'attack' });
  // banding: attacking creatures in bands, blocked as a group
  await M.declareBands(game, ap);
  game.turnState.attackedWith = decl.map(x => x.c.id);
  // "attacked this combat" holds even after it's removed from combat; "attacked during its controller's last turn",
  // "attacked a battle this turn"
  game.combat.attackedIds = decl.map(x => x.c.id);
  for (const { c, d } of decl) {
    c.attackTurns = [...c.attackTurns.slice(-2), game.turnNumber];
    if (d.card && game.chars(game.cardById(d.card)).types.has('Battle')) game.turnState.attackedBattles.push(c.id);
  }
  // who attacked whom: "attacked you during their last turn", "a player it has already attacked this turn"
  const apP = game.players[ap];
  if (apP.attackedPlayersTurn !== game.turnNumber) { apP.attackedPlayers = []; apP.attackedPlayersTurn = game.turnNumber; }
  for (const { c, d } of decl) {
    if (!c.attackedPlayers || c.attackedPlayers.turn !== game.turnNumber) c.attackedPlayers = { turn: game.turnNumber, pids: [] };
    if (d.card) continue;
    if (!apP.attackedPlayers.includes(d.player)) apP.attackedPlayers.push(d.player);
    if (!c.attackedPlayers.pids.includes(d.player)) c.attackedPlayers.pids.push(d.player);
  }
  for (const { c } of decl) game.turnState.attackCounts = { ...(game.turnState.attackCounts || {}), [c.id]: ((game.turnState.attackCounts || {})[c.id] || 0) + 1 };
  // enlist: as it attacks, you may tap a nonattacking creature without summoning sickness to add its power
  for (const { c } of decl) {
    if (!kw(game, c, 'Enlist')) continue;
    const pool = game.battlefield.filter(x => x.controller === ap && x !== c && !x.tapped && game.chars(x).types.has('Creature') && !decl.some(d => d.c === x) && (!x.sick || kw(game, x, 'Haste')));
    if (!pool.length) continue;
    const ids = await game.ask(ap, { type: 'cards', prompt: `Enlist: you may tap a creature to add its power to ${game.name(c)}`, cards: pool.map(x => x.id), min: 0, max: 1, purpose: 'enlist', cardId: c.id });
    const e = ids && ids.length ? game.cardById(ids[0]) : null;
    if (!e || !pool.includes(e)) continue;
    await game.tap(e);
    c.enlistedTurn = game.turnNumber;
    const pw = game.chars(e).power;
    if (pw) c.temp.push({ power: pw, until: 'EOT' });
    game.touch();
    game.log(`${game.name(c)} enlists ${game.name(e)} (+${pw}/+0).`);
    game.fire('Enlisted', { Card: c, Enlisted: e });
  }
  // optional attack costs: "you may exert CARDNAME as it attacks. When you do, ..."
  for (const { c } of decl) {
    for (const st of game.chars(c).statics) {
      const p = st.parsed.p;
      if (p.Mode !== 'OptionalAttackCost') continue;
      const ctx = { host: c, you: ap, svars: st.svars, sa: { svars: st.svars, host: c, controller: ap, root() { return { x: 0, paid: {} }; } } };
      if (p.ValidCard && !matchValid(game, c, p.ValidCard, ctx)) continue;
      if (!checkPresence(game, p, ctx)) continue;
      if (!/^Exert/.test(p.Cost || '')) continue;
      const trigRaw = p.Trigger && st.svars[p.Trigger];
      const yes = await game.ask(ap, { type: 'confirm', prompt: `${game.name(c)}: ${p.Description || 'exert it as it attacks?'}`, purpose: 'exert', cardId: c.id, trigger: trigRaw ? parseAbility(trigRaw) : null });
      if (!yes) continue;
      c.exertedTurn = game.turnNumber; c.skipNextUntap = true;
      game.log(`${game.players[ap].name} exerts ${game.name(c)}.`);
      game.fire('Exerted', { Card: c, Player: ap });
      if (trigRaw) game.pendingTriggers.push({ host: c, t: { parsed: { p: { Execute: p.Trigger, TriggerDescription: (parseAbility(trigRaw).p.SpellDescription || 'When you do, ...').replace(/CARDNAME/g, game.name(c)) } }, svars: st.svars, key: 'exert:' + st.key }, rp: { Card: c, Attacker: c, Player: ap }, controller: ap });
    }
  }
  const n = decl.length;
  for (const { c, d } of decl) {
    if (c.tapped && !kw(game, c, 'Vigilance')) game.fire('Taps', { Card: c, Attacker: true });
    game.fire('Attacks', { Attacker: c, Card: c, DefendingPlayer: d.player, DefenderCard: d.card ? game.cardById(d.card) : null, Defender: d.card ? game.cardById(d.card) : game.players[d.player], AttackerCount: n, AttackingPlayer: ap });
  }
  const defPids = [...new Set(decl.map(x => x.d.player))];
  game.fire('AttackersDeclared', { AttackingPlayer: ap, Attackers: decl.map(x => x.c), Defenders: defPids });
  for (const dp of defPids) game.fire('AttackersDeclaredOneTarget', { AttackingPlayer: ap, Attackers: decl.filter(x => x.d.player === dp).map(x => x.c), DefendingPlayer: dp });
}

export function canBlockAny(game, b) {
  if (b.zone !== 'battlefield' || b.phasedOut || (b.tapped && !M.blocksWhileTapped(game, b))) return false;
  if (!game.chars(b).types.has('Creature')) return false;
  if (hidden(game, b, "CARDNAME can't block.") || hidden(game, b, "CARDNAME can't attack or block.") || hidden(game, b, "CARDNAME can't block creatures.")) return false;
  if (b.suspected) return false;
  if ((b.counters.P1P1 || 0) > 0 && game.hasKeyword(b, 'Unleash')) return false;
  for (const s of game.activeStatics('CantBlock')) if (matchValid(game, b, s.p.ValidCard || 'Card.Self', s.ctx)) return false;
  return true;
}

// Can b block a? Returns null when it can, or why not ([kind, detail]): blockProblem() puts that in words for the
// player, and canBlock() is the yes or no.
function blockCheck(game, b, a) {
  if (!canBlockAny(game, b)) return ['cant'];
  const ach = game.chars(a), bch = game.chars(b);
  const has = (ch, k) => game.hasKeywordIn(ch, k);
  if (has(ach, 'Flying') && !has(bch, 'Flying') && !has(bch, 'Reach') && !M.blocksAsThoughReach(game, b, a)) return ['flying'];
  if (has(bch, "CARDNAME can block only creatures with flying.") && !has(ach, 'Flying')) return ['onlyFlyers'];
  if (has(ach, 'Shadow') && !has(bch, 'Shadow') && !M.blocksAsThoughShadow(game, b, a)) return ['shadow'];
  if (!has(ach, 'Shadow') && has(bch, 'Shadow')) return ['blockerShadow'];
  if (has(ach, 'Horsemanship') && !has(bch, 'Horsemanship')) return ['horsemanship'];
  if (has(ach, 'Fear') && !bch.types.has('Artifact') && !bch.colors.has('B')) return ['fear'];
  if (has(ach, 'Intimidate') && !bch.types.has('Artifact') && ![...ach.colors].some(c => bch.colors.has(c))) return ['intimidate'];
  if (has(ach, 'Skulk') && bch.power > ach.power) return ['skulk'];
  if (ach.keywords.some(k => /^(HIDDEN )?(CARDNAME can't be blocked\.|Unblockable)$/.test(k))) return ['unblockable'];
  // landwalk
  const defPid = b.controller;
  for (const k of ach.keywords) {
    let m = k.match(/^Landwalk:(\w+)/) || k.match(/^(\w+)walk$/);
    if (m && !M.ignoresLandwalk(game, b, a, k)) {
      const t = m[1];
      if (game.battlefield.some(l => l.controller === defPid && game.chars(l).types.has('Land') && (game.chars(l).subtypes.has(t) || (t === 'Nonbasic' && !game.chars(l).supertypes.has('Basic')) || (t === 'Legendary' && game.chars(l).supertypes.has('Legendary'))))) return ['landwalk', t];
    }
  }
  if (game.hasProtectionFrom(a, b)) return ['protection'];
  for (const s of game.activeStatics('CantBlockBy')) {
    if (s.p.ValidAttacker && !matchValid(game, a, s.p.ValidAttacker, s.ctx)) continue;
    if (s.p.ValidBlocker && !matchValid(game, b, s.p.ValidBlocker, s.ctx)) continue;
    // "can be blocked only by creatures in the same sector" (relative to the attacker)
    if (s.p.ValidBlockerRelative && !matchValid(game, b, s.p.ValidBlockerRelative, { ...s.ctx, attacker: a })) continue;
    if (!s.p.ValidAttacker && !s.p.ValidBlocker && !s.p.ValidBlockerRelative) continue;
    return ['static', s.host];
  }
  return null;
}

export function canBlock(game, b, a) { return !blockCheck(game, b, a); }

// why b can't block a, in a sentence (null when it can)
export function blockProblem(game, b, a) {
  const why = blockCheck(game, b, a);
  if (!why) return null;
  const A = game.name(a), B = game.name(b);
  switch (why[0]) {
    case 'cant': return b.tapped ? `${B} is tapped: tapped creatures can't block.` : b.suspected ? `${B} is suspected: suspected creatures can't block.` : `${B} can't block.`;
    case 'flying': return `${A} has flying: only creatures with flying or reach can block it.`;
    case 'onlyFlyers': return `${B} can block only creatures with flying.`;
    case 'shadow': return `${A} has shadow: only creatures with shadow can block it.`;
    case 'blockerShadow': return `${B} has shadow: it can block only creatures with shadow.`;
    case 'horsemanship': return `${A} has horsemanship: only creatures with horsemanship can block it.`;
    case 'fear': return `${A} has fear: only black creatures and artifact creatures can block it.`;
    case 'intimidate': return `${A} has intimidate: only artifact creatures and creatures that share a color with it can block it.`;
    case 'skulk': return `${A} has skulk: creatures with greater power can't block it.`;
    case 'unblockable': return `${A} can't be blocked.`;
    case 'landwalk': return `${A} has ${why[1] === 'Nonbasic' ? 'nonbasic land' : why[1] === 'Legendary' ? 'legendary land' : why[1].toLowerCase()}walk: it can't be blocked while you control ${/^[AEIOU]/.test(why[1]) ? 'an' : 'a'} ${why[1] === 'Nonbasic' ? 'nonbasic land' : why[1] === 'Legendary' ? 'legendary land' : why[1]}.`;
    case 'protection': return `${A} has protection: ${B} can't block it.`;
    case 'static': return why[1] && why[1].id === a.id ? `${A} can't be blocked by ${B}.` : why[1] && why[1].id === b.id ? `${B} can't block ${A}.` : `${game.name(why[1])} stops ${B} from blocking ${A}.`;
    default: return `${B} can't block ${A}.`;
  }
}

function minBlockers(game, a) {
  const ach = game.chars(a);
  let min = 1;
  if (game.hasKeywordIn(ach, 'Menace')) min = 2;
  for (const k of ach.keywords) { const m = k.match(/can't be blocked except by (\w+) or more/); if (m) min = Math.max(min, { two: 2, three: 3 }[m[1]] || 2); }
  for (const s of game.activeStatics('MinMaxBlocker')) if (matchValid(game, a, s.p.ValidCard || 'Card.Self', s.ctx) && s.p.Min) min = Math.max(min, +s.p.Min);
  return min;
}

function maxBlockers(game, a) {
  for (const s of game.activeStatics('MinMaxBlocker')) if (matchValid(game, a, s.p.ValidCard || 'Card.Self', s.ctx) && s.p.Max) return +s.p.Max;
  return 99;
}

export function blockRules(game, a) { return { min: minBlockers(game, a), max: maxBlockers(game, a) }; }

export async function declareBlockers(game) {
  const combat = game.combat;
  const defPids = game.apnap().filter(pid => pid !== game.activePlayer && combat.attackers.some(x => x.defenderPlayer === pid));
  for (const dp of defPids) {
    const atks = combat.attackers.filter(x => x.defenderPlayer === dp).map(x => game.cardById(x.card)).filter(Boolean);
    const cands = game.battlefield.filter(c => c.controller === dp && canBlockAny(game, c));
    if (!cands.length || !atks.length) continue;
    // (Camouflage: piles assigned at random instead of declaring blockers; creatures that can block more than one
    // attacker are listed in caps)
    const caps = M.blockCaps(game, cands);
    const ans = (await M.replaceDeclareBlockers(game, dp, atks, cands)) || await game.ask(dp, { type: 'blockers', attackers: atks.map(c => c.id), candidates: cands.map(c => c.id), ...(caps ? { caps } : {}) });
    const pairs = [];
    const uses = new Map();
    for (const pr of ans || []) {
      const b = game.cardById(pr.blocker), a = game.cardById(pr.attacker);
      if (!b || !a || !cands.includes(b) || !atks.includes(a)) continue;
      if (pairs.some(p => p.b === b && p.a === a) || (uses.get(b.id) || 0) >= M.blockCapacity(game, b)) continue;
      if (!canBlock(game, b, a)) continue;
      uses.set(b.id, (uses.get(b.id) || 0) + 1);
      pairs.push({ b, a });
    }
    applyBlockRequirements(game, atks, cands, pairs);
    // menace / max blockers validation
    const validate = () => {
      for (const a of atks) {
        const mine = pairs.filter(p => p.a === a);
        const { min, max } = blockRules(game, a);
        if (mine.length && (mine.length < min || mine.length > max)) for (const p of mine) pairs.splice(pairs.indexOf(p), 1);
      }
    };
    validate();
    // "no more than N creatures can block each combat" (per defending player when it names one)
    for (const s of game.activeStatics('BlockRestrict')) {
      if (s.p.ValidDefender && !matchValid(game, game.players[dp], s.p.ValidDefender, s.ctx)) continue;
      const max = s.p.MaxBlockers != null ? calcCtx(game, s.p.MaxBlockers, s.ctx) : 99;
      const key = `${s.host.id}:${s.st.key}${s.p.ValidDefender ? ':' + dp : ''}`;
      combat.blockCounts = combat.blockCounts || {};
      const room = Math.max(0, max - (combat.blockCounts[key] || 0));
      const blockers = [...new Set(pairs.map(p => p.b))];
      if (blockers.length > room) {
        const drop = blockers.slice(room);
        for (let i = pairs.length - 1; i >= 0; i--) if (drop.includes(pairs[i].b)) pairs.splice(i, 1);
        game.log(`${game.name(s.host)}: no more than ${max} creature${max === 1 ? '' : 's'} can block (${drop.map(b => game.name(b)).join(', ')} won't block).`);
        validate();
      }
      combat.blockCounts[key] = (combat.blockCounts[key] || 0) + new Set(pairs.map(p => p.b)).size;
    }
    // "can't block alone", "can't block unless at least two other creatures block"
    M.blockAloneRules(game, pairs);
    validate();
    // "creatures can't block unless their controller pays {N} for each of those creatures"
    for (const b of [...new Set(pairs.map(p => p.b))]) {
      const tax = blockTax(game, b, pairs.filter(p => p.b === b).map(p => p.a));
      if (tax <= 0) continue;
      const cost = parseMana(String(tax));
      if (canAfford(game, dp, cost) && await payManaCost(game, dp, cost)) { game.log(`${game.players[dp].name} pays {${tax}} to block with ${game.name(b)}.`); continue; }
      for (let i = pairs.length - 1; i >= 0; i--) if (pairs[i].b === b) pairs.splice(i, 1);
      game.log(`${game.players[dp].name} can't pay {${tax}} to block with ${game.name(b)}.`);
      validate();
    }
    if (pairs.length) game.log(`${game.players[dp].name} blocks: ${pairs.map(p => `${game.name(p.b)} blocks ${game.name(p.a)}`).join(', ')}`, { type: 'block' });
    // banding: blocking one creature in a band blocks the whole band
    const banded = [];
    for (const { b, a } of pairs) for (const m of M.bandOf(game, a)) if (m !== a && !pairs.some(p => p.b === b && p.a === m) && !banded.some(p => p.b === b && p.a === m)) banded.push({ b, a: m });
    if (banded.length) game.log(`Bands are blocked together: ${banded.map(p => `${game.name(p.b)} also blocks ${game.name(p.a)}`).join(', ')}.`);
    // block history: "blocked this combat", "blocked or was blocked by a legendary creature this turn"
    for (const { b, a } of [...pairs, ...banded]) M.addBlock(game, b, a);
  }
  game.touch();
  // triggers: "whenever one or more creatures block", "whenever CARDNAME blocks" (once, however many it blocks),
  // "whenever CARDNAME becomes blocked", "whenever one or more creatures you control become blocked"
  const allBlockers = [...combat.blockers.keys()].map(id => game.cardById(id)).filter(Boolean);
  if (allBlockers.length) game.fire('BlockersDeclared', { Blockers: allBlockers, Attackers: combat.attackers.filter(r => r.blockers.length).map(r => game.cardById(r.card)).filter(Boolean) });
  for (const b of allBlockers) { const as = M.attackersBlockedBy(game, b); game.fire('Blocks', { Blocker: b, Card: b, Attacker: as[0], Attackers: as }); }
  const blockedNow = [];
  for (const rec of combat.attackers) {
    const a = game.cardById(rec.card);
    if (!a) continue;
    if (rec.blocked) {
      const bl = rec.blockers.map(id => game.cardById(id)).filter(Boolean);
      game.fire('AttackerBlocked', { Attacker: a, Card: a, Blockers: bl, Blocker: bl[0], DefendingPlayer: rec.defenderPlayer, NumBlockers: bl.length });
      for (const b of bl) game.fire('AttackerBlockedByCreature', { Attacker: a, Blocker: b });
      blockedNow.push(a);
    } else {
      game.fire('AttackerUnblocked', { Attacker: a, Card: a, DefendingPlayer: rec.defenderPlayer });
    }
  }
  if (blockedNow.length) game.fire('AttackerBlockedOnce', { Attackers: blockedNow });
  const unb = combat.attackers.filter(r => !r.blocked).map(r => game.cardById(r.card)).filter(Boolean);
  if (unb.length) game.fire('AttackerUnblockedOnce', { Attackers: unb, AttackingPlayer: game.activePlayer });
}

function mustBlockNow(game, b) { return game.activeStatics('MustBlock').some(s => matchValid(game, b, s.p.ValidCreature || s.p.ValidCard || 'Card.Self', s.ctx)); }

// Blocking requirements ("blocks each combat if able", "target creature blocks it this turn if able", lure,
// "all Walls able to block it do so", "must be blocked if able"): extend the declared blocks so as many requirements as
// possible are obeyed. A creature that can block more than one attacker takes on another one rather than switching.
export function applyBlockRequirements(game, atks, cands, pairs) {
  const of = b => pairs.filter(p => p.b === b);
  const cap = new Map();
  const capOf = b => { if (!cap.has(b.id)) cap.set(b.id, M.blockCapacity(game, b)); return cap.get(b.id); };
  const assign = (b, a) => {
    const mine = of(b);
    if (mine.some(p => p.a === a)) return;
    if (mine.length < capOf(b)) pairs.push({ b, a });
    else mine[mine.length - 1].a = a;
  };
  const lures = new Map(atks.map(a => [a.id, M.lureFilters(game, a)]));
  const lure = a => (lures.get(a.id) || []).length > 0;
  const luredBy = (b, a) => (lures.get(a.id) || []).some(v => matchValid(game, b, v, { host: a, you: a.controller }));
  for (const a of atks) {
    if (!lure(a)) continue;
    for (const b of cands) {
      if (!luredBy(b, a) || !canBlock(game, b, a)) continue;
      const mine = of(b);
      if (mine.length >= capOf(b) && mine.some(p => lure(p.a))) continue;
      assign(b, a);
    }
  }
  for (const b of cands) {
    const req = b.mustBlock;
    if (!req || req.turn !== game.turnNumber) continue;
    // ("blocks each attacking creature this turn if able": as many as it can block)
    for (const a of atks.filter(x => (req.attackers || [req.attacker]).includes(x.id))) {
      const mine = of(b);
      if (!canBlock(game, b, a) || mine.some(p => p.a === a)) continue;
      if (mine.length >= capOf(b) && mine.some(p => lure(p.a))) continue;
      assign(b, a);
    }
  }
  for (const b of cands) {
    if (of(b).length || !mustBlockNow(game, b)) continue;
    const a = atks.find(x => canBlock(game, b, x));
    if (a) assign(b, a);
  }
  for (const a of atks) {
    const ach = game.chars(a);
    const two = ach.keywords.some(k => /^(HIDDEN )?CARDNAME must be blocked by two or more creatures if able\.$/.test(k));
    if (!two && !ach.keywords.some(k => /^(HIDDEN )?CARDNAME must be blocked (if able|by exactly one creature if able)\.$/.test(k))) continue;
    const need = two ? 2 : 1;
    const free = cands.filter(x => !of(x).length && canBlock(game, x, a));
    const have = pairs.filter(p => p.a === a).length;
    if (have >= need || have + free.length < need) continue;
    for (const b of free.slice(0, need - have)) assign(b, a);
  }
  return pairs;
}

// what blocking costs this creature's controller (each static once, for any of the attackers it blocks)
function blockTax(game, b, atks) {
  let tax = 0;
  for (const s of game.activeStatics('CantBlockUnless')) {
    if (!matchValid(game, b, s.p.ValidCard || 'Creature', s.ctx)) continue;
    if (s.p.ValidAttacker && !atks.some(a => matchValid(game, a, s.p.ValidAttacker, s.ctx))) continue;
    const cost = s.p.Cost || '0';
    tax += /^\d+$/.test(cost) ? +cost : Math.max(0, calcCtx(game, cost, s.ctx));
  }
  return tax;
}

export function needsFirstStrike(game) {
  const ids = [...game.combat.attackers.map(a => a.card), ...game.combat.blockers.keys()];
  return ids.some(id => { const c = game.cardById(id); return c && (kw(game, c, 'First Strike') || kw(game, c, 'Double Strike')); });
}

function dealsThisStep(game, c, firstStrike) {
  const fs = kw(game, c, 'First Strike'), ds = kw(game, c, 'Double Strike');
  if (firstStrike) return fs || ds;
  if (!game.combat.hadFirstStrike) return true;
  if (ds) return true;
  return !game.combat.firstStrikeDone.has(c.id);
}

export function combatPower(game, c) {
  const ch = game.chars(c);
  if (game.activeStatics('CombatDamageToughness').some(s => matchValid(game, c, s.p.ValidCard || 'Creature', s.ctx))) return ch.toughness;
  return M.negatedPower(game, c, ch.power);
}

export async function combatDamage(game, firstStrike) {
  const combat = game.combat;
  if (firstStrike) combat.hadFirstStrike = true;
  const assigns = [];
  for (const rec of combat.attackers) {
    const a = game.cardById(rec.card);
    if (!a || a.zone !== 'battlefield') continue;
    if (!dealsThisStep(game, a, firstStrike)) continue;
    const power = combatPower(game, a);
    if (firstStrike) combat.firstStrikeDone.add(a.id);
    if (power <= 0 || M.assignsNoCombatDamage(game, a)) continue;
    const defTarget = rec.defenderCard ? game.cardById(rec.defenderCard) : game.players[rec.defenderPlayer];
    const defAlive = defTarget && (defTarget.isPlayer ? !defTarget.lost : defTarget.zone === 'battlefield');
    const trample = kw(game, a, 'Trample');
    const asUnblocked = game.activeStatics('AssignCombatDamageAsUnblocked').some(s => matchValid(game, a, s.p.ValidCard || 'Card.Self', s.ctx));
    const blockers = rec.blockers.map(id => game.cardById(id)).filter(b => b && b.zone === 'battlefield');
    // Butcher Orgg, Cunning Giant, banding blockers: damage the attacking player (or, with banding, the defending
    // player) divides some other way
    const special = await M.attackerDamage(game, rec, a, power, rec.blocked && !(asUnblocked && !rec.blockers.length) ? blockers : []);
    if (special) { assigns.push(...special); continue; }
    if (!rec.blocked || asUnblocked && rec.blocked && !rec.blockers.length) {
      if (defAlive) assigns.push({ src: a, tgt: defTarget, n: power });
      continue;
    }
    if (!blockers.length) { if (trample && defAlive) assigns.push({ src: a, tgt: defTarget, n: power }); continue; }
    // order: kill as many as possible
    const deathtouch = kw(game, a, 'Deathtouch');
    // (lethal damage by power: mech-last.js)
    const lethal = b => { const t = lethalOf(game.chars(b)) - b.damage; return deathtouch ? Math.min(1, Math.max(0, t)) : Math.max(0, t); };
    blockers.sort((x, y) => lethal(x) - lethal(y));
    let left = power;
    const per = new Map();
    for (const b of blockers) {
      const need = lethal(b);
      const give = Math.min(left, need);
      per.set(b.id, give);
      left -= give;
      if (left <= 0) break;
    }
    if (left > 0) {
      if (trample && defAlive) assigns.push({ src: a, tgt: defTarget, n: left });
      else { const last = blockers[blockers.length - 1]; per.set(last.id, (per.get(last.id) || 0) + left); }
    }
    for (const b of blockers) if (per.get(b.id)) assigns.push({ src: a, tgt: b, n: per.get(b.id) });
  }
  // blockers: each deals its damage to the attacker it blocks, or divides it among several (a creature that can block
  // more than one, or one blocking a band)
  for (const bid of [...combat.blockers.keys()]) {
    const b = game.cardById(bid);
    if (!b || b.zone !== 'battlefield') continue;
    if (!dealsThisStep(game, b, firstStrike)) continue;
    if (firstStrike) combat.firstStrikeDone.add(b.id);
    const atks = M.attackersBlockedBy(game, b).filter(a => a.zone === 'battlefield');
    if (!atks.length) continue;
    const power = combatPower(game, b);
    if (power > 0 && !M.assignsNoCombatDamage(game, b)) assigns.push(...await M.blockerDamage(game, b, atks, power));
  }
  if (!assigns.length) return;
  game.beginDamageBatch();
  for (const x of assigns) await game.dealDamage(x.src, x.tgt, x.n, { combat: true });
  game.endDamageBatch();
  // initiative steal
  if (game.initiative != null) {
    const hit = assigns.find(x => x.tgt.isPlayer && x.tgt.id === game.initiative && x.src.controller !== game.initiative && x.n > 0);
    if (hit) game.pendingInitiative = hit.src.controller;
  }
  // monarch steal
  if (game.monarch != null) {
    const hit = assigns.find(x => x.tgt.isPlayer && x.tgt.id === game.monarch && x.src.controller !== game.monarch);
    if (hit && !cantBecomeMonarch(game, hit.src.controller)) { game.monarch = hit.src.controller; game.log(`${game.players[game.monarch].name} becomes the monarch.`); game.fire('BecomeMonarch', { Player: game.monarch }); }
  }
}

export { refOf, fromRef };
