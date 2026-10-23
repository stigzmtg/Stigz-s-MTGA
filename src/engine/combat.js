// Combat: attacker/blocker legality, declarations and combat damage.
import { matchValid, calcCtx } from './filters.js';
import { refOf, fromRef, payManaCost, canAfford } from './abilities.js';
import { parseMana } from './mana.js';
import { BASIC_LAND_TYPES } from './util.js';

function kw(game, c, k) { return game.hasKeyword(c, k); }
function hidden(game, c, text) { return game.chars(c).keywords.some(k => k === text || k === 'HIDDEN ' + text); }

export function canAttack(game, c, { ignoreTapped = false } = {}) {
  if (c.zone !== 'battlefield' || c.phasedOut) return false;
  const ch = game.chars(c);
  if (!ch.types.has('Creature')) return false;
  if (c.tapped && !ignoreTapped) return false;
  if (c.sick && !kw(game, c, 'Haste')) return false;
  if (kw(game, c, 'Defender') && !game.activeStatics('CanAttackDefender').some(s => matchValid(game, c, s.p.ValidCard || 'Card.Self', s.ctx))) return false;
  if (hidden(game, c, "CARDNAME can't attack.") || hidden(game, c, "CARDNAME can't attack or block.")) return false;
  for (const s of game.activeStatics('CantAttack')) {
    if (s.p.ValidCard && matchValid(game, c, s.p.ValidCard, s.ctx) && !s.p.Target) return false;
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
  for (const s of game.activeStatics('CantAttack')) {
    if (s.p.DefenderNotNearestToYouInChosenDirection === 'True') {
      // "each player may attack only the nearest opponent in the chosen direction and planeswalkers controlled by that opponent"
      const dir = s.host.chosen && s.host.chosen.direction;
      if (dir && playerInDirection(game, c.controller, dir) !== defPid) return false;
      continue;
    }
    if (!s.p.Target) continue;
    if (s.p.ValidCard && !matchValid(game, c, s.p.ValidCard, s.ctx)) continue;
    const tgt = defCard || game.players[defPid];
    if (matchValid(game, tgt, s.p.Target, s.ctx)) return false;
  }
  return true;
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
    if (used.has(c.id)) continue;
    let must = (c.goadedBy && c.goadedBy.length > 0) || c.mustAttack != null;
    let forced = null;
    for (const s of game.activeStatics('MustAttack')) {
      if (!matchValid(game, c, s.p.ValidCreature || s.p.ValidCard || 'Card.Self', s.ctx)) continue;
      must = true;
      if (s.p.MustAttack) { const t = s.p.MustAttack === 'You' ? s.ctx.you : null; if (t != null) forced = t; }
    }
    if (!must) continue;
    let d = null;
    if (c.mustAttack != null) d = defenders.find(x => x.player === c.mustAttack && !x.card);
    if (!d && forced != null) d = defenders.find(x => x.player === forced && !x.card);
    if (!d && c.goadedBy && c.goadedBy.length) d = defenders.find(x => !x.card && !c.goadedBy.includes(x.player));
    if (!d) d = defenders.find(x => !x.card && canAttackDefender(game, c, x.player, null)) || defenders.find(x => !x.card);
    if (d && canAttackDefender(game, c, d.player, null)) { used.add(c.id); decl.push({ c, d, forced: true }); }
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
    if (!kw(game, c, 'Vigilance')) { c.tapped = true; }
  }
  game.touch();
  const names = decl.map(({ c, d }) => `${game.name(c)} → ${d.card ? game.name(game.cardById(d.card)) : game.players[d.player].name}`);
  game.log(`${game.players[ap].name} attacks: ${names.join(', ')}`, { type: 'attack' });
  game.turnState.attackedWith = decl.map(x => x.c.id);
  const n = decl.length;
  for (const { c, d } of decl) {
    if (!kw(game, c, 'Vigilance')) game.fire('Taps', { Card: c, Attacker: true });
    game.fire('Attacks', { Attacker: c, Card: c, DefendingPlayer: d.player, DefenderCard: d.card ? game.cardById(d.card) : null, Defender: d.card ? game.cardById(d.card) : game.players[d.player], AttackerCount: n, AttackingPlayer: ap });
  }
  const defPids = [...new Set(decl.map(x => x.d.player))];
  game.fire('AttackersDeclared', { AttackingPlayer: ap, Attackers: decl.map(x => x.c), Defenders: defPids });
  for (const dp of defPids) game.fire('AttackersDeclaredOneTarget', { AttackingPlayer: ap, Attackers: decl.filter(x => x.d.player === dp).map(x => x.c), DefendingPlayer: dp });
}

export function canBlockAny(game, b) {
  if (b.zone !== 'battlefield' || b.tapped || b.phasedOut) return false;
  if (!game.chars(b).types.has('Creature')) return false;
  if (hidden(game, b, "CARDNAME can't block.") || hidden(game, b, "CARDNAME can't attack or block.") || hidden(game, b, "CARDNAME can't block creatures.")) return false;
  if (b.suspected) return false;
  for (const s of game.activeStatics('CantBlock')) if (matchValid(game, b, s.p.ValidCard || 'Card.Self', s.ctx)) return false;
  return true;
}

export function canBlock(game, b, a) {
  if (!canBlockAny(game, b)) return false;
  const ach = game.chars(a), bch = game.chars(b);
  const has = (ch, k) => game.hasKeywordIn(ch, k);
  if (has(ach, 'Flying') && !has(bch, 'Flying') && !has(bch, 'Reach')) return false;
  if (has(bch, "CARDNAME can block only creatures with flying.") && !has(ach, 'Flying')) return false;
  if (has(ach, 'Shadow') !== has(bch, 'Shadow')) return false;
  if (has(ach, 'Horsemanship') && !has(bch, 'Horsemanship')) return false;
  if (has(ach, 'Fear') && !bch.types.has('Artifact') && !bch.colors.has('B')) return false;
  if (has(ach, 'Intimidate') && !bch.types.has('Artifact') && ![...ach.colors].some(c => bch.colors.has(c))) return false;
  if (has(ach, 'Skulk') && bch.power > ach.power) return false;
  if (ach.keywords.some(k => /^(HIDDEN )?(CARDNAME can't be blocked\.|Unblockable)$/.test(k))) return false;
  // landwalk
  const defPid = b.controller;
  for (const k of ach.keywords) {
    let m = k.match(/^Landwalk:(\w+)/) || k.match(/^(\w+)walk$/);
    if (m) {
      const t = m[1];
      if (game.battlefield.some(l => l.controller === defPid && game.chars(l).types.has('Land') && (game.chars(l).subtypes.has(t) || (t === 'Nonbasic' && !game.chars(l).supertypes.has('Basic')) || (t === 'Legendary' && game.chars(l).supertypes.has('Legendary'))))) return false;
    }
  }
  if (game.hasProtectionFrom(a, b)) return false;
  for (const s of game.activeStatics('CantBlockBy')) {
    if (s.p.ValidAttacker && !matchValid(game, a, s.p.ValidAttacker, s.ctx)) continue;
    if (s.p.ValidBlocker && !matchValid(game, b, s.p.ValidBlocker, s.ctx)) continue;
    if (!s.p.ValidAttacker && !s.p.ValidBlocker) continue;
    return false;
  }
  return true;
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
    const ans = await game.ask(dp, { type: 'blockers', attackers: atks.map(c => c.id), candidates: cands.map(c => c.id) });
    const pairs = [];
    const usedB = new Set();
    for (const pr of ans || []) {
      const b = game.cardById(pr.blocker), a = game.cardById(pr.attacker);
      if (!b || !a || usedB.has(b.id) || !cands.includes(b) || !atks.includes(a)) continue;
      if (!canBlock(game, b, a)) continue;
      usedB.add(b.id);
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
      if (pairs.length > room) {
        const drop = pairs.splice(room);
        game.log(`${game.name(s.host)}: no more than ${max} creature${max === 1 ? '' : 's'} can block (${drop.map(p => game.name(p.b)).join(', ')} won't block).`);
        validate();
      }
      combat.blockCounts[key] = (combat.blockCounts[key] || 0) + pairs.length;
    }
    // "creatures can't block unless their controller pays {N} for each of those creatures"
    for (const pr of [...pairs]) {
      const tax = blockTax(game, pr.b, pr.a);
      if (tax <= 0) continue;
      const cost = parseMana(String(tax));
      if (canAfford(game, dp, cost) && await payManaCost(game, dp, cost)) { game.log(`${game.players[dp].name} pays {${tax}} to block with ${game.name(pr.b)}.`); continue; }
      pairs.splice(pairs.indexOf(pr), 1);
      game.log(`${game.players[dp].name} can't pay {${tax}} to block with ${game.name(pr.b)}.`);
      validate();
    }
    for (const { b, a } of pairs) {
      combat.blockers.set(b.id, a.id);
      const rec = combat.attackers.find(x => x.card === a.id);
      rec.blockers.push(b.id);
      rec.blocked = true;
    }
    if (pairs.length) game.log(`${game.players[dp].name} blocks: ${pairs.map(p => `${game.name(p.b)} blocks ${game.name(p.a)}`).join(', ')}`, { type: 'block' });
  }
  game.touch();
  for (const rec of combat.attackers) {
    const a = game.cardById(rec.card);
    if (!a) continue;
    if (rec.blocked) {
      const bl = rec.blockers.map(id => game.cardById(id)).filter(Boolean);
      for (const b of bl) game.fire('Blocks', { Blocker: b, Card: b, Attacker: a });
      game.fire('AttackerBlocked', { Attacker: a, Card: a, Blockers: bl, Blocker: bl[0], DefendingPlayer: rec.defenderPlayer, NumBlockers: bl.length });
      for (const b of bl) game.fire('AttackerBlockedByCreature', { Attacker: a, Blocker: b });
    } else {
      game.fire('AttackerUnblocked', { Attacker: a, Card: a, DefendingPlayer: rec.defenderPlayer });
    }
  }
  const unb = combat.attackers.filter(r => !r.blocked).map(r => game.cardById(r.card)).filter(Boolean);
  if (unb.length) game.fire('AttackerUnblockedOnce', { Attackers: unb, AttackingPlayer: game.activePlayer });
}

const LURE = 'All creatures able to block CARDNAME do so.';
function mustBlockNow(game, b) { return game.activeStatics('MustBlock').some(s => matchValid(game, b, s.p.ValidCreature || s.p.ValidCard || 'Card.Self', s.ctx)); }

// Blocking requirements ("blocks each combat if able", "target creature blocks it this turn if able", lure,
// "must be blocked if able"): extend the declared blocks so as many requirements as possible are obeyed.
export function applyBlockRequirements(game, atks, cands, pairs) {
  const byBlocker = () => new Map(pairs.map(p => [p.b.id, p]));
  const assign = (b, a) => { const ex = byBlocker().get(b.id); if (ex) ex.a = a; else pairs.push({ b, a }); };
  const lure = a => hidden(game, a, LURE);
  for (const a of atks) {
    if (!lure(a)) continue;
    for (const b of cands) { const cur = byBlocker().get(b.id); if ((!cur || !lure(cur.a)) && canBlock(game, b, a)) assign(b, a); }
  }
  for (const b of cands) {
    const req = b.mustBlock;
    if (!req || req.turn !== game.turnNumber) continue;
    const a = atks.find(x => x.id === req.attacker);
    const cur = byBlocker().get(b.id);
    if (a && canBlock(game, b, a) && !(cur && (cur.a === a || lure(cur.a)))) assign(b, a);
  }
  for (const b of cands) {
    if (byBlocker().has(b.id) || !mustBlockNow(game, b)) continue;
    const a = atks.find(x => canBlock(game, b, x));
    if (a) assign(b, a);
  }
  for (const a of atks) {
    if (pairs.some(p => p.a === a)) continue;
    const ach = game.chars(a);
    if (!ach.keywords.some(k => /^(HIDDEN )?CARDNAME must be blocked (if able|by exactly one creature if able)\.$/.test(k))) continue;
    const taken = byBlocker();
    const b = cands.find(x => !taken.has(x.id) && canBlock(game, x, a));
    if (b) assign(b, a);
  }
  return pairs;
}

function blockTax(game, b, a) {
  let tax = 0;
  for (const s of game.activeStatics('CantBlockUnless')) {
    if (!matchValid(game, b, s.p.ValidCard || 'Creature', s.ctx)) continue;
    if (s.p.ValidAttacker && !matchValid(game, a, s.p.ValidAttacker, s.ctx)) continue;
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
  return ch.power;
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
    if (power <= 0) continue;
    const defTarget = rec.defenderCard ? game.cardById(rec.defenderCard) : game.players[rec.defenderPlayer];
    const defAlive = defTarget && (defTarget.isPlayer ? !defTarget.lost : defTarget.zone === 'battlefield');
    const trample = kw(game, a, 'Trample');
    const asUnblocked = game.activeStatics('AssignCombatDamageAsUnblocked').some(s => matchValid(game, a, s.p.ValidCard || 'Card.Self', s.ctx));
    if (!rec.blocked || asUnblocked && rec.blocked && !rec.blockers.length) {
      if (defAlive) assigns.push({ src: a, tgt: defTarget, n: power });
      continue;
    }
    const blockers = rec.blockers.map(id => game.cardById(id)).filter(b => b && b.zone === 'battlefield');
    if (!blockers.length) { if (trample && defAlive) assigns.push({ src: a, tgt: defTarget, n: power }); continue; }
    // order: kill as many as possible
    const deathtouch = kw(game, a, 'Deathtouch');
    const lethal = b => { const t = game.chars(b).toughness - b.damage; return deathtouch ? Math.min(1, Math.max(0, t)) : Math.max(0, t); };
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
  for (const [bid, aid] of combat.blockers) {
    const b = game.cardById(bid), a = game.cardById(aid);
    if (!b || b.zone !== 'battlefield') continue;
    if (!dealsThisStep(game, b, firstStrike)) continue;
    if (firstStrike) combat.firstStrikeDone.add(b.id);
    if (!a || a.zone !== 'battlefield') continue;
    const power = combatPower(game, b);
    if (power > 0) assigns.push({ src: b, tgt: a, n: power });
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
    if (hit) { game.monarch = hit.src.controller; game.log(`${game.players[game.monarch].name} becomes the monarch.`); game.fire('BecomeMonarch', { Player: game.monarch }); }
  }
}

export { refOf, fromRef };
