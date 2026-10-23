// Heuristic AI agent. Answers every engine prompt ("ask") for its player.
import { SA, getActions, spellOptions, buildSpellSA, targetSpec, targetCandidates, refOf, fromRef, manaSourcesFor, parseCost, activatedAbilities, producedUnits, canAfford } from '../engine/abilities.js';
import { canBlock, canAttack, combatPower, blockRules, attackTax, canAttackDefender, playerInDirection } from '../engine/combat.js';
import { matchValid, calc, ctxOf, ctrlOf } from '../engine/filters.js';
import { parseAbility } from '../engine/forge.js';
import { sleep, COLORS, BASIC_LAND_TYPES } from '../engine/util.js';
import { addCosts } from '../engine/mana.js';

const HARMFUL = new Set(['Destroy', 'DestroyAll', 'DealDamage', 'DamageAll', 'Counter', 'Sacrifice', 'SacrificeAll', 'Discard', 'LoseLife', 'Mill', 'GainControl', 'Tap', 'TapAll', 'Goad', 'Fight', 'Phases', 'ExchangeControl', 'RemoveCounter']);
const BENEFICIAL = new Set(['Pump', 'PumpAll', 'PutCounter', 'PutCounterAll', 'GainLife', 'Draw', 'Untap', 'UntapAll', 'Attach', 'Regenerate', 'Animate', 'Token', 'CopyPermanent', 'Clone', 'Investigate', 'Scry', 'Surveil', 'Proliferate', 'Dig', 'BecomeMonarch', 'Explore', 'Connive', 'Amass', 'MultiplyCounter', 'Mana']);

export class AIAgent {
  // pace(kind) -> milliseconds to wait before acting ('think', 'land', 'attack', 'block', 'choose', 'respond'),
  // so a computer opponent plays at a person's tempo; none for headless games
  constructor({ pace = null, name = 'AI' } = {}) {
    this.pace = pace;
    this.name = name;
    this.uses = new Map();
    this.passedWindow = null;
  }

  async ask(game, pid, req) {
    this.game = game; this.pid = pid;
    try {
      switch (req.type) {
        case 'priority': return await this.priority(game, pid);
        case 'attackers': { const r = this.attackers(game, pid, req); if (r.length) await this.pause('attack'); return r; }
        case 'blockers': { const r = this.blockers(game, pid, req); if (r.length) await this.pause('block'); return r; }
        default: {
          const r = this.choose(game, pid, req);
          if (r !== undefined) { await this.pause('choose'); return r; }
          return null;
        }
      }
    } catch (e) {
      if (game.throwErrors) throw e;
      console.error('AI error', e);
      return defaultAnswer(req);
    }
  }

  // every other choice: mulligans, targets, cards, modes, options, numbers, colors, players
  choose(game, pid, req) {
    switch (req.type) {
      case 'mulligan': return this.mulligan(game, pid);
      case 'targets': return this.targets(game, pid, req);
      case 'cards': return this.cards(game, pid, req);
      case 'option': return this.option(game, pid, req);
      case 'modes': return this.modes(game, pid, req);
      case 'confirm': return this.confirm(game, pid, req);
      case 'number': return this.number(game, pid, req);
      case 'color': return this.color(game, pid, req);
      case 'player': return this.player(game, pid, req);
      default: return undefined;
    }
  }

  async pause(kind) {
    const ms = this.pace ? this.pace(kind) : 0;
    if (ms > 0) await sleep(ms);
  }

  // ------------------------------------------------------------ evaluation
  value(c) {
    const game = this.game;
    if (!c) return 0;
    if (c.isPlayer) return 0;
    const ch = c.lki ? c.chars : game.chars(c);
    let v = 0;
    if (ch.types.has('Creature')) {
      v = Math.max(0, ch.power) * 1.5 + Math.max(0, ch.toughness) + 1;
      const kws = { Flying: 2, Deathtouch: 1.5, Lifelink: 1, Trample: 1, 'First Strike': 1, 'Double Strike': 3, Hexproof: 1.5, Indestructible: 3, Vigilance: 0.5, Haste: 0.3, Menace: 1, Ward: 1, Infect: 2 };
      for (const k of Object.keys(kws)) if (game.hasKeywordIn(ch, k)) v += kws[k];
      v += ch.abilities.filter(a => a.parsed.api !== 'Mana').length * 1 + ch.triggers.length * 1.2 + ch.statics.length * 1.2;
    } else if (ch.types.has('Planeswalker')) v = 8 + (c.counters ? c.counters.LOYALTY || 0 : 0);
    else if (ch.types.has('Land')) v = ch.supertypes.has('Basic') ? 1 : 2;
    else v = 2 + ch.cmc * 0.8 + ch.statics.length + ch.triggers.length;
    if (c.isCommander) v += 4;
    if (c.token && !ch.types.has('Creature')) v = Math.min(v, 1.5);
    v += (ch.cmc || 0) * 0.3;
    return v;
  }

  threat(pid) {
    const game = this.game;
    const p = game.players[pid];
    let t = 0;
    for (const c of game.battlefield) if (c.controller === pid) t += this.value(c);
    t += Math.max(0, 40 - p.life) * -0.2;
    return t;
  }

  mainOpponent(pid) {
    const game = this.game;
    const opps = game.opponents(pid);
    if (!opps.length) return null;
    // prefer the most threatening opponent; human slightly favoured as a target so games stay engaging
    return opps.slice().sort((a, b) => (this.threat(b.id) + (b.isHuman ? 3 : 0)) - (this.threat(a.id) + (a.isHuman ? 3 : 0)))[0];
  }

  sentiment(sa) {
    if (!sa) return 'help';
    const p = sa.p || {};
    if (p.IsCurse === 'True' || /Curse/.test(p.AILogic || '')) return 'harm';
    const api = sa.api;
    if (api === 'ChangeZone' || api === 'ChangeZoneAll') {
      const o = p.Origin || 'Battlefield', d = p.Destination || '';
      if (/Battlefield/.test(o) && /Exile|Graveyard|Hand|Library/.test(d)) return /YouCtrl|YouOwn/.test(p.ValidTgts || '') && !/Opp/.test(p.ValidTgts || '') ? 'help' : 'harm';
      if (/Graveyard/.test(o) && /Exile/.test(d)) return 'harm';
      return 'help';
    }
    if (api === 'Pump') { const a = String(p.NumAtt || ''), d = String(p.NumDef || ''); if (a.startsWith('-') || d.startsWith('-')) return 'harm'; return 'help'; }
    if (api === 'PutCounter') return /M1M1|-1\/-1|STUN/.test(p.CounterType || '') ? 'harm' : 'help';
    if (api === 'Attach') {
      const host = sa.host;
      const ch = host && (host.lki ? host.chars : this.game.chars(host));
      if (ch && ch.statics.some(s => /AddPower\$ -|AddToughness\$ -|CantAttack|CantBlock|RemoveAllAbilities|CantBeActivated/.test(s.raw))) return 'harm';
      if (ch && ch.triggers.some(t => /Mode\$ Phase.*ValidPlayer\$ You.*Enchanted|LoseLife/.test(t.raw)) && /Curse/.test(ch.subtypes ? [...ch.subtypes].join() : '')) return 'harm';
      return 'help';
    }
    if (api === 'Animate' && /OppCtrl/.test(p.ValidTgts || '')) return 'harm';
    if (HARMFUL.has(api)) return 'harm';
    if (BENEFICIAL.has(api)) return 'help';
    if (/OppCtrl|Opponent/.test(p.ValidTgts || '')) return 'harm';
    return 'help';
  }

  // ------------------------------------------------------------ mulligan
  mulligan(game, pid) {
    const p = game.players[pid];
    const lands = p.hand.filter(c => game.chars(c).types.has('Land')).length;
    return lands >= 2 && lands <= 5;
  }

  // ------------------------------------------------------------ priority
  async priority(game, pid) {
    const turnKey = game.turnNumber + ':' + game.step;
    const myTurn = game.activePlayer === pid;
    const stackTop = game.stack[game.stack.length - 1];
    // quick exit: nothing castable at all
    const actions = getActions(game, pid);
    // something of someone else's on the stack: take a moment, as a person would, before letting it resolve
    const pass = async () => { if (stackTop && stackTop.kind === 'spell' && stackTop.controller !== pid) await this.pause('respond'); return { type: 'pass' }; };
    if (!actions.length) return pass();
    let best = null, bestScore = 0;
    const consider = (a, s) => { if (s > bestScore) { best = a; bestScore = s; } };
    const main = myTurn && game.isMainPhase() && game.stack.length === 0;
    // lands first
    if (main) {
      const lands = actions.filter(a => a.type === 'land');
      if (lands.length) {
        const pick = this.bestLand(game, pid, lands);
        if (pick) { await this.pause('land'); return pick; }
      }
    }
    for (const a of actions) {
      if (a.type === 'land') continue;
      const k = `${turnKey}:${a.cardId}:${a.abilityKey || a.optionKey}`;
      const used = this.uses.get(k) || 0;
      if (used >= 2) continue;
      let s = 0;
      if (a.type === 'cast') s = this.scoreCast(game, pid, a, { main, myTurn, stackTop });
      else if (a.type === 'activate') s = this.scoreActivate(game, pid, a, { main, myTurn, stackTop });
      consider(a, s);
    }
    if (best) {
      const k = `${turnKey}:${best.cardId}:${best.abilityKey || best.optionKey}`;
      this.uses.set(k, (this.uses.get(k) || 0) + 1);
      if (this.uses.size > 3000) this.uses.clear();
      await this.pause('think');
      return best;
    }
    return pass();
  }

  bestLand(game, pid, lands) {
    const p = game.players[pid];
    const need = this.colorNeeds(game, pid);
    let best = null, bs = -Infinity;
    for (const a of lands) {
      const c = game.cardById(a.cardId);
      const f = c.def.faces[+(a.optionKey || 'land0').replace('land', '')] || c.def.faces[0];
      let s = 1;
      const tapped = f.replacements.some(r => /ETBTapped|LandTapped/.test(r) && !/ConditionPresent/.test(f.svars[(r.match(/ReplaceWith\$ (\w+)/) || [])[1]] || ''));
      if (tapped) s -= 0.5;
      // colors produced
      const prod = new Set();
      for (const t of f.subtypes) if (BASIC_LAND_TYPES[t]) prod.add(BASIC_LAND_TYPES[t]);
      for (const ab of f.abilities) { const m = ab.match(/Produced\$ ([^|]+)/); if (m) for (const x of m[1].split(/\s+/)) if (COLORS.includes(x)) prod.add(x); if (/ColorIdentity|Any/.test(ab)) p.colorIdentity.forEach(x => prod.add(x)); }
      for (const col of prod) s += (need[col] || 0) * 0.6;
      if (c.def.faces.length > 1 && !f.types.includes('Land')) s -= 1;
      if (a.optionKey === 'land1' && c.def.faces[0].types && !c.def.faces[0].types.includes('Land')) s -= 2; // MDFC back face
      if (s > bs) { bs = s; best = a; }
    }
    return best;
  }

  colorNeeds(game, pid) {
    const p = game.players[pid];
    const need = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    const have = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    for (const s of manaSourcesFor(game, pid)) for (const u of s.units) for (const c of u) if (have[c] != null) have[c]++;
    for (const c of [...p.hand, ...p.command]) {
      const mc = c.faceDef.manaCost;
      if (!mc) continue;
      for (const k of COLORS) need[k] += Math.max(0, mc.colored[k] - have[k]);
      for (const h of mc.hybrid) for (const k of h) if (need[k] != null) need[k] += 0.3;
    }
    for (const k of COLORS) if (!p.colorIdentity.includes(k)) need[k] = 0; else need[k] += have[k] === 0 ? 1 : 0;
    return need;
  }

  turnPhaseFactor(game) { return game.turnNumber <= game.players.length * 5 ? 1 : 0.4; }

  scoreCast(game, pid, a, ctx) {
    const card = game.cardById(a.cardId);
    if (!card) return 0;
    const opt = spellOptions(game, pid, card).find(o => o.key === a.optionKey);
    if (!opt) return 0;
    const face = card.def.faces[opt.face] || card.def.faces[0];
    const isInstantSpeed = face.types.includes('Instant') || face.keywords.includes('Flash');
    const sa = buildSpellSA(game, pid, card, opt);
    let s = 0;
    if (sa.permanent) {
      if (!ctx.main && !isInstantSpeed) return 0;
      if (!ctx.main && isInstantSpeed) {
        // flash permanents: cast at end of opponent's turn
        if (!(game.step === 'end' && !ctx.myTurn && !game.stack.length)) return 0;
      }
      const types = face.types;
      if (types.includes('Creature')) {
        const p = face.power && /^\d+$/.test(face.power) ? +face.power : 2;
        const t = face.toughness && /^\d+$/.test(face.toughness) ? +face.toughness : 2;
        s = 3 + p * 1.2 + t * 0.8 + face.keywords.length * 0.6 + face.triggers.length + face.statics.length + face.abilities.filter(x => !/Mana/.test(x)).length * 0.7;
        if (opt.altCost === 'Morph') s = 3;
      } else if (types.includes('Planeswalker')) s = 9 + face.cmc;
      else {
        s = 2.5 + face.cmc * 0.9 + face.statics.length + face.triggers.length;
        if (face.abilities.some(x => /Mana \|/.test(x) || /AB\$ Mana/.test(x))) s += 4 * this.turnPhaseFactor(game);
        if (face.subtypes.includes('Aura')) {
          const sent = this.sentiment(sa);
          const best = this.bestTargetValue(game, pid, sa, sent);
          if (best <= 0) return 0;
          s = 2 + best * 0.5;
        }
        if (face.subtypes.includes('Equipment')) s = game.battlefield.some(c => c.controller === pid && game.chars(c).types.has('Creature')) ? 3 + face.cmc * 0.5 : 1.5;
      }
      if (card.isCommander) s += 4;
      s += face.cmc * 0.4;
      return s;
    }
    // instants & sorceries
    if (!ctx.main) {
      if (!isInstantSpeed) return 0;
      return this.scoreInstantResponse(game, pid, card, sa, ctx);
    }
    s = this.scoreChain(game, pid, sa, { main: true });
    if (isInstantSpeed && this.isReactive(sa)) s = Math.min(s, 0);
    if (s > 0) s += face.cmc * 0.3;
    return s;
  }

  isReactive(sa) {
    for (const s of sa.chain()) {
      if (s.api === 'Counter') return true;
      if (s.api === 'Pump' || s.api === 'PumpAll') return true;
      if (s.api === 'Effect' && /Prevent|Fog|RPrevent/i.test(JSON.stringify(s.p))) return true;
      if (s.api === 'ChangeZone' && /Battlefield/.test(s.p.Origin || '') && /Hand/.test(s.p.Destination || '') && /YouCtrl/.test(s.p.ValidTgts || '')) return true;
    }
    return false;
  }

  scoreInstantResponse(game, pid, card, sa, ctx) {
    const top = ctx.stackTop;
    // counter opponent's threatening spells
    if (top && top.controller !== pid && sa.chain().some(s => s.api === 'Counter')) {
      if (top.kind !== 'spell') return 0;
      const ch = game.chars(top.card);
      let threat = ch.cmc;
      const tsa = top.sa;
      if (tsa.chain().some(s => s.api === 'DestroyAll' || s.api === 'DamageAll' || s.api === 'ChangeZoneAll')) threat += 5;
      if (tsa.chain().some(s => s.targets.some(t => (t.isPlayer && t.id === pid) || (t.isCard && t.controller === pid)))) threat += 3;
      if (top.card.isCommander) threat += 2;
      return threat >= 5 ? threat : 0;
    }
    // end of opponent's turn: use instant-speed draw / removal
    if (game.step === 'end' && !ctx.myTurn && !game.stack.length) {
      const s = this.scoreChain(game, pid, sa, { main: false });
      return this.isReactive(sa) ? 0 : s;
    }
    // combat: removal on attackers coming at us
    if (!ctx.myTurn && game.step === 'declareBlockers' && game.combat && !game.stack.length) {
      const removal = sa.chain().some(s => (s.api === 'Destroy' || (s.api === 'ChangeZone' && /Exile/.test(s.p.Destination || ''))) && s.p.ValidTgts);
      if (removal) {
        const atk = game.combat.attackers.filter(x => x.defenderPlayer === pid && !x.blocked).map(x => game.cardById(x.card)).filter(Boolean);
        const dmg = atk.reduce((acc, c) => acc + combatPower(game, c), 0);
        if (dmg >= game.players[pid].life * 0.5) return 6;
      }
    }
    return 0;
  }

  scoreChain(game, pid, root, { main }) {
    let s = 0;
    const subs = root.api === 'Charm' ? [] : root.chain();
    if (root.api === 'Charm') return 3;
    for (const sa of subs) s += this.scoreApi(game, pid, sa, { main });
    return s;
  }

  bestTargetValue(game, pid, sa, sent) {
    const spec = targetSpec(game, sa);
    if (!spec) return 0;
    const cands = targetCandidates(game, sa, spec);
    let best = 0;
    for (const c of cands) {
      const mine = c.isPlayer ? c.id === pid : (c.stackItem ? c.controller === pid : ctrlOf(game, c) === pid);
      if (sent === 'harm' && mine) continue;
      if (sent === 'help' && !mine) continue;
      const v = c.isPlayer ? 3 : c.stackItem ? 3 : this.value(c);
      if (v > best) best = v;
    }
    return best;
  }

  scoreApi(game, pid, sa, { main }) {
    const p = sa.p;
    const num = (k, d = 1) => { try { return p[k] != null ? calc(game, p[k], sa) : d; } catch { return d; } };
    const me = game.players[pid];
    const myCreatures = game.battlefield.filter(c => c.controller === pid && game.chars(c).types.has('Creature'));
    const oppCreatures = game.battlefield.filter(c => c.controller !== pid && game.chars(c).types.has('Creature'));
    const sumV = l => l.reduce((a, c) => a + this.value(c), 0);
    switch (sa.api) {
      case 'Draw': return 2 * Math.max(1, num('NumCards', 1)) * (/(Opponent|Player)/.test(p.ValidTgts || '') ? 0.8 : 1);
      case 'ChangeZone': {
        const o = p.Origin || 'Battlefield', d = p.Destination || '';
        if (/Library/.test(o) && /Land/.test(p.ChangeType || '')) return (/Battlefield/.test(d) ? 4.5 : 2.5) * this.turnPhaseFactor(game) + 0.5;
        if (/Library/.test(o)) return 4;
        if (p.ValidTgts) { const sent = this.sentiment(sa); const v = this.bestTargetValue(game, pid, sa, sent); return v >= 3 ? v : 0; }
        if (/Graveyard/.test(o) && /Hand|Battlefield/.test(d)) return me.graveyard.length ? 2 : 0;
        return 1;
      }
      case 'Destroy': case 'GainControl': {
        if (!p.ValidTgts) return 0.5;
        const v = this.bestTargetValue(game, pid, sa, 'harm');
        return v >= 3.5 ? v + 1 : 0;
      }
      case 'DestroyAll': case 'DamageAll': case 'SacrificeAll': {
        const valid = p.ValidCards || 'Creature';
        const ctx = ctxOf(game, sa);
        const hit = game.battlefield.filter(c => matchValid(game, c, valid, ctx));
        if (sa.api === 'DamageAll') { const n = num('NumDmg', 1); hit.splice(0, hit.length, ...hit.filter(c => game.chars(c).toughness <= n)); }
        const mine = sumV(hit.filter(c => c.controller === pid)), theirs = sumV(hit.filter(c => c.controller !== pid));
        const diff = theirs - mine;
        return diff > 8 ? diff / 2 : 0;
      }
      case 'DealDamage': {
        const n = num('NumDmg', 1);
        if (!p.ValidTgts) return n * 0.4;
        const spec = targetSpec(game, sa);
        const cands = spec ? targetCandidates(game, sa, spec) : [];
        let best = 0;
        for (const c of cands) {
          if (c.isPlayer) { if (c.id !== pid) best = Math.max(best, n * 0.6 + (c.life <= n ? 50 : 0)); continue; }
          if (c.controller === pid) continue;
          const ch = game.chars(c);
          if (ch.types.has('Creature') && ch.toughness - c.damage <= n && !game.hasKeywordIn(ch, 'Indestructible')) best = Math.max(best, this.value(c) + 1);
          if (ch.types.has('Planeswalker') && (c.counters.LOYALTY || 0) <= n) best = Math.max(best, this.value(c));
        }
        return best;
      }
      case 'Token': return 2.5 * Math.max(1, num('TokenAmount', 1));
      case 'CopyPermanent': case 'Clone': return 4;
      case 'Pump': return main ? 0 : 0;
      case 'PumpAll': return main ? 0 : 0;
      case 'PutCounter': return /M1M1/.test(p.CounterType || '') ? (p.ValidTgts ? this.bestTargetValue(game, pid, sa, 'harm') * 0.5 : 0) : (myCreatures.length ? 1.5 * num('CounterNum', 1) : 0);
      case 'PutCounterAll': return /P1P1/.test(p.CounterType || '') ? myCreatures.length * 0.8 : 0.5;
      case 'GainLife': return num('LifeAmount', 1) * 0.25;
      case 'LoseLife': return /Opponent|Player/.test(p.Defined || p.ValidTgts || '') ? num('LifeAmount', 1) * 0.6 : -num('LifeAmount', 1) * 0.15;
      case 'Discard': return /Opponent|Player/.test(p.Defined || p.ValidTgts || '') ? 1.5 : -1;
      case 'Mill': return /Opponent/.test(p.Defined || p.ValidTgts || '') ? 0.4 : 0.3;
      case 'Counter': return 0;
      case 'Scry': case 'Surveil': return 0.8;
      case 'Dig': return 2;
      case 'DigUntil': return 2;
      case 'Effect': return 1;
      case 'Animate': return main ? 0.5 : 0;
      case 'Mana': return 0;
      case 'Untap': return 0.3;
      case 'Tap': return main ? 0 : 0.5;
      case 'TapAll': return 0;
      case 'Sacrifice': return /Opponent|Player/.test(p.Defined || '') ? 3 : -1;
      case 'Proliferate': return 1.5;
      case 'Investigate': return 1.5;
      case 'BecomeMonarch': return 3;
      case 'Fight': return this.bestTargetValue(game, pid, sa, 'harm') * 0.6;
      case 'Attach': return 0.5;
      case 'Cleanup': case 'StoreSVar': return 0;
      case 'Regenerate': return 0;
      case 'Goad': return 1.5;
      case 'AddPhase': return 2;
      case 'UnlockDoor': { const f = sa.host && sa.host.def && sa.host.def.faces[+p.Door || 0]; return f ? 3 + f.cmc * 0.6 + f.triggers.length + f.statics.length : 2; }
      default: return 1;
    }
  }

  scoreActivate(game, pid, a, ctx) {
    const card = game.cardById(a.cardId);
    if (!card) return 0;
    const abil = game.chars(card).abilities.find(x => x.key === a.abilityKey);
    if (!abil) return 0;
    const p = abil.parsed.p;
    const api = abil.parsed.api;
    const cost = parseCost(p.Cost);
    const sa = { ...buildDummySA(game, abil, card, pid) };
    // equip
    if (p.IsEquip === 'True') {
      if (!ctx.main) return 0;
      const cur = card.attachedTo ? game.cardById(card.attachedTo) : null;
      const mine = game.battlefield.filter(c => c.controller === pid && game.chars(c).types.has('Creature') && c.id !== (cur && cur.id));
      if (!mine.length) return 0;
      const best = mine.reduce((b, c) => this.value(c) > this.value(b) ? c : b, mine[0]);
      if (cur && this.value(cur) >= this.value(best)) return 0;
      return 3;
    }
    if (p.IsCrew === 'True') {
      if (!(ctx.main && ctx.myTurn && game.step === 'main1')) return 0;
      if (card.crewedTurn === game.turnNumber) return 0;
      const sick = game.battlefield.filter(c => c.controller === pid && c.id !== card.id && !c.tapped && game.chars(c).types.has('Creature') && c.sick);
      const need = +(cost.parts.find(x => x.type === 'Crew') || { amount: 1 }).amount || 1;
      return sick.reduce((s, c) => s + game.chars(c).power, 0) >= need ? 3 : 0;
    }
    if (p.IsCycling === 'True') {
      const lands = game.battlefield.filter(c => c.controller === pid && game.chars(c).types.has('Land')).length;
      const isLand = game.chars(card).types.has('Land');
      if (ctx.myTurn && ctx.main) return isLand && lands < 5 ? 0 : (card.faceDef.cmc > lands + 2 ? 2.5 : 0);
      return 0;
    }
    // timing: only main phase of own turn or end of opponent's turn
    const eot = game.step === 'end' && !ctx.myTurn && !game.stack.length;
    if (!ctx.main && !eot) {
      if (abil.parsed.api === 'Counter' && ctx.stackTop && ctx.stackTop.controller !== pid) return 0;
      return 0;
    }
    let s = 0;
    const fake = buildDummySA(game, abil, card, pid);
    for (const sub of fake.chain()) s += this.scoreApi(game, pid, sub, { main: ctx.main });
    if (abil.parsed.api === 'Charm') s = 2;
    // planeswalkers: prefer plus abilities
    if (p.Planeswalker === 'True') {
      const add = cost.parts.find(x => x.type === 'AddCounter');
      const sub = cost.parts.find(x => x.type === 'SubCounter');
      const loyalty = card.counters.LOYALTY || 0;
      if (add) s += 3;
      if (sub) { const n = +sub.amount || 0; if (loyalty - n < 1) s -= 4; else s -= n * 0.3; if (p.Ultimate === 'True') s += 6; }
      return Math.max(s, add ? 2 : 0);
    }
    // cost penalties
    for (const part of cost.parts) {
      if (part.type === 'Sac') {
        if (part.valid === 'CARDNAME' || part.valid === 'Card.Self') {
          const ch = game.chars(card);
          if (ch.types.has('Creature')) s -= Math.max(0, this.value(card) - 3);
          else if (manaSourcesFor(game, pid).some(x => x.card === card)) s -= 3 * this.turnPhaseFactor(game) + 1;
          else s -= 0.5;
        } else s -= 4;
      }
      if (part.type === 'PayLife') s -= (+part.amount || 1) * 0.4;
      if (part.type === 'Discard') s -= 2;
      if (part.type === 'tapXType') s -= 1;
      if (part.type === 'ExileFromGrave') s -= 0.3;
    }
    if (cost.tap && game.chars(card).types.has('Creature') && ctx.main && game.step === 'main1' && ctx.myTurn && canAttack(game, card)) s -= 1.5;
    if (api === 'Pump' || api === 'PumpAll' || api === 'Animate' && !game.chars(card).types.has('Land')) s = Math.min(s, 0);
    if (api === 'Animate' && game.chars(card).types.has('Land')) s = 0;
    if (api === 'Mana' || api === 'ManaReflected') s = 0;
    if (api === 'PutCounter' && /Defined\$ Self/.test(abil.raw) && !cost.hasMana && !cost.tap) s = Math.min(s, 0);
    return s;
  }

  // ------------------------------------------------------------ targets
  targets(game, pid, req) {
    const sa = req.sa;
    const cands = req.cands.map(r => fromRef(game, r)).filter(Boolean);
    if (req.purpose === 'proliferate') {
      return cands.filter(o => {
        if (o.isPlayer) return o.id !== pid ? (o.counters.POISON > 0) : !(o.counters.POISON > 0);
        const mine = o.controller === pid;
        if (o.counters.M1M1 > 0) return !mine;
        return mine;
      }).map(refOf);
    }
    const sent = this.sentiment(sa);
    const api = sa ? sa.api : null;
    const scoreT = (o) => {
      const mine = o.isPlayer ? o.id === pid : o.stackItem ? o.controller === pid : ctrlOf(game, o) === pid;
      let v;
      if (o.isPlayer) {
        if (sent === 'harm') v = mine ? -100 : 10 + this.threat(o.id) * 0.1 + (40 - o.life) * 0.2 + (o.isHuman ? 1 : 0);
        else v = mine ? 20 : -20;
        return v;
      }
      if (o.stackItem) {
        if (sent === 'harm') return mine ? -100 : 5 + (o.card ? game.chars(o.card).cmc : 2);
        return mine ? 5 : -5;
      }
      const base = this.value(o);
      if (sent === 'harm') {
        if (mine) return -base - 50;
        if (api === 'DealDamage') {
          const n = sa.p.NumDmg ? safeCalc(game, sa.p.NumDmg, sa) : 1;
          const ch = game.chars(o);
          if (ch.types.has('Creature') && ch.toughness - o.damage > n) return base * 0.1;
        }
        if (sa.p.AITgts) { try { if (matchValid(game, o, sa.p.AITgts, ctxOf(game, sa))) return base + 5; } catch { } }
        return base;
      }
      if (mine) {
        let v2 = base;
        if (game.combat && game.isAttacking(o)) v2 += 3;
        return v2 + 10;
      }
      return -base - 10;
    };
    const sorted = cands.map(o => ({ o, s: scoreT(o) })).sort((a, b) => b.s - a.s);
    const out = [];
    for (const { o, s } of sorted) {
      if (out.length >= req.max) break;
      if (s < 0 && out.length >= req.min) break;
      out.push(o);
    }
    while (out.length < req.min && sorted.length > out.length) out.push(sorted[out.length].o);
    return out.map(refOf);
  }

  // ------------------------------------------------------------ card choices
  cards(game, pid, req) {
    const cards = req.cards.map(id => game.cardById(id)).filter(Boolean);
    const { min, max } = req;
    const p = game.players[pid];
    const lands = game.battlefield.filter(c => c.controller === pid && game.chars(c).types.has('Land')).length;
    const isLand = c => game.chars(c).types.has('Land');
    const v = c => this.value(c);
    const pick = (sorted, n) => sorted.slice(0, n).map(c => c.id);
    const purpose = req.purpose || '';
    if (purpose === 'crew') {
      const sorted = cards.slice().sort((a, b) => v(a) - v(b));
      const out = []; let pw = 0;
      for (const c of sorted) { if (pw >= (req.need || 1)) break; out.push(c.id); pw += game.chars(c).power; }
      return out.length ? out : [sorted[0].id];
    }
    if (purpose === 'mulliganBottom' || purpose === 'discard' || purpose === 'costDiscard') {
      const handLands = cards.filter(isLand).length;
      const score = c => {
        if (isLand(c)) return lands + handLands > 6 ? -5 : (lands < 4 ? 10 : 2);
        const cm = game.chars(c).cmc;
        return v(c) - Math.max(0, cm - lands - 2) * 2;
      };
      const sorted = cards.slice().sort((a, b) => score(a) - score(b));
      return pick(sorted, Math.max(min, Math.min(max, min)));
    }
    if (purpose.startsWith('search') || purpose.startsWith('dig') || purpose === 'chooseCard' || purpose === 'clone' || purpose === 'copy' || purpose === 'playFree' || purpose === 'legendKeep') {
      const need = this.colorNeeds(game, pid);
      const score = c => {
        const ch = game.chars(c);
        if (ch.types.has('Land')) {
          let s = 2;
          for (const t of ch.subtypes) if (BASIC_LAND_TYPES[t]) s += (need[BASIC_LAND_TYPES[t]] || 0) + (p.colorIdentity.includes(BASIC_LAND_TYPES[t]) ? 1 : -3);
          return s;
        }
        if (purpose === 'legendKeep') return v(c) + Object.values(c.counters).reduce((a, b) => a + b, 0) + (c.tapped ? 0 : 0.5);
        if (purpose === 'clone' || purpose === 'copy') return c.controller !== pid && game.chars(c).supertypes.has('Legendary') ? v(c) : v(c) + 0.1;
        return v(c);
      };
      const sorted = cards.slice().sort((a, b) => score(b) - score(a));
      const n = purpose.startsWith('dig') && min === 0 ? Math.max(1, Math.min(max, max)) : max;
      return pick(sorted, Math.max(min, Math.min(n, sorted.length)));
    }
    if (purpose === 'sacrifice' || purpose === 'costSac' || purpose === 'devour' || purpose === 'costExile' || purpose === 'costReturn') {
      if (purpose === 'devour') return pick(cards.filter(c => c.token).sort((a, b) => v(a) - v(b)), Math.min(max, cards.filter(c => c.token).length));
      const sorted = cards.slice().sort((a, b) => v(a) - v(b));
      return pick(sorted, min);
    }
    if (purpose === 'scryBottom' || purpose === 'surveilGrave') {
      const handLands = p.hand.filter(isLand).length;
      const wantLand = lands + handLands < 5;
      const bad = cards.filter(c => isLand(c) ? !wantLand && lands + handLands >= 6 : (wantLand && game.chars(c).cmc > lands + 2) || game.chars(c).cmc > lands + 4);
      return bad.slice(0, max).map(c => c.id);
    }
    if (purpose === 'tap') return pick(cards.filter(c => c.controller !== pid).sort((a, b) => v(b) - v(a)), max);
    if (purpose === 'gainControlChoice') return pick(cards.slice().sort((a, b) => v(b) - v(a)), Math.max(min, 1));
    if (purpose === 'chooseSource') {
      // the opposing source most likely to hurt us
      const score = c => (c.controller === pid ? -100 : 0) + (game.isAttacking(c) && game.attackTargetOf(c) === pid ? 20 : 0) + (game.chars(c).types.has('Creature') ? Math.max(0, combatPower(game, c)) : c.zone === 'stack' ? 3 : 0);
      return pick(cards.slice().sort((a, b) => score(b) - score(a)), 1);
    }
    if (purpose === 'pair') return pick(cards.slice().sort((a, b) => v(b) - v(a)), 1);
    if (purpose === 'champion') return pick(cards.slice().sort((a, b) => v(a) - v(b)), Math.min(1, cards.length));
    if (purpose === 'harmonize') return pick(cards.slice().sort((a, b) => (game.chars(b).power - (canAttack(game, b) && game.step === 'main1' ? 3 : 0)) - (game.chars(a).power - (canAttack(game, a) && game.step === 'main1' ? 3 : 0))), 1);
    if (purpose === 'cipher') {
      // encode on the creature most likely to connect
      const evasive = c => ['Flying', 'Menace', 'Shadow', 'Horsemanship', 'Fear', 'Intimidate', 'Skulk'].some(k => game.hasKeyword(c, k)) || game.chars(c).keywords.some(k => /can't be blocked/.test(k));
      const score = c => (evasive(c) ? 4 : 0) + Math.max(0, combatPower(game, c)) * 0.3 - (game.hasKeyword(c, 'Defender') ? 6 : 0);
      return pick(cards.slice().sort((a, b) => score(b) - score(a)), 1);
    }
    if (purpose === 'casualty') { const ok = cards.filter(c => c.token || v(c) <= 4).sort((a, b) => v(a) - v(b)); return ok.length ? [ok[0].id] : []; }
    if (purpose === 'emerge') return pick(cards.slice().sort((a, b) => (game.chars(b).cmc - v(b) * 0.4 + (b.token ? 2 : 0)) - (game.chars(a).cmc - v(a) * 0.4 + (a.token ? 2 : 0))), 1);
    if (purpose === 'blight') {
      const n = 1;
      const score = c => (game.chars(c).toughness > n ? 0 : 8) + (c.token ? -2 : 0) + v(c) * 0.5 - (c.controller !== pid ? 20 : 0);
      return pick(cards.slice().sort((a, b) => score(a) - score(b)), Math.max(1, min));
    }
    if (purpose === 'untap') return pick(cards.filter(c => c.controller === pid), max);
    if (purpose === 'discardOpponent') return pick(cards.slice().sort((a, b) => v(b) - v(a)), max);
    if (purpose === 'costTapXType' || purpose === 'costtapXType') return pick(cards.slice().sort((a, b) => v(a) - v(b)), min);
    if (purpose === 'costRemoveCounter') return pick(cards, min);
    if (purpose === 'ninjutsu') return pick(cards.slice().sort((a, b) => v(a) - v(b)), 1);
    // default: best by value if choosing for self
    const sorted = cards.slice().sort((a, b) => (b.controller === pid ? v(b) : -v(b)) - (a.controller === pid ? v(a) : -v(a)));
    return pick(sorted, Math.max(min, Math.min(max, min || max)));
  }

  option(game, pid, req) {
    const opts = req.options || [];
    if (!opts.length) return null;
    if (req.purpose === 'chooseType') {
      const counts = {};
      for (const c of game.allCards()) if (c.owner === pid) { const ch = game.chars(c); if (ch.types.has('Creature')) for (const t of ch.subtypes) counts[t] = (counts[t] || 0) + 1; }
      const best = opts.slice().sort((a, b) => (counts[b.value] || 0) - (counts[a.value] || 0))[0];
      return best.value;
    }
    if (req.purpose === 'genericChoice') {
      if (req.ai === 'Fabricate') return opts[0].value;
      if (req.ai === 'Riot') return opts[0].value;
      // score each mode by api
      let best = opts[0].value, bs = -Infinity;
      for (const o of opts) {
        const raw = req.sa && req.sa.svars[o.value];
        if (!raw) continue;
        const parsed = parseAbility(raw);
        let s = { Draw: 3, Token: 3, PutCounter: 2, GainLife: 1, Pump: 1, LoseLife: -1, Discard: -1, Sacrifice: -2, Mill: -0.5 }[parsed.api] ?? 0.5;
        if (/Opponent|Player/.test(parsed.p.Defined || '') && ['LoseLife', 'Discard', 'Sacrifice', 'Mill'].includes(parsed.api)) s = 2;
        if (s > bs) { bs = s; best = o.value; }
      }
      return best;
    }
    if (req.purpose === 'castMode') {
      const nonAlt = opts.find(o => !/Evoke|Morph|face down/i.test(o.label));
      return (nonAlt || opts[0]).value;
    }
    if (req.purpose === 'chooseDirection') return this.direction(game, pid, req);
    if (req.purpose === 'gift') {
      // promise only cheap gifts (a card, a small token), to the least threatening opponent
      const g = req.gift;
      const cheap = g && (g.api === 'Draw' && !(+g.p.NumCards > 1) || g.api === 'Token' && /_1_1_|treasure|food|clue/i.test(g.p.TokenScript || ''));
      if (!cheap) return -1;
      const opps = opts.filter(o => o.value !== -1).map(o => o.value);
      return opps.sort((a, b) => this.threat(a) - this.threat(b))[0] ?? -1;
    }
    if (req.purpose === 'dredge') {
      // dredge when the library can afford it; lands back only while we still want land drops
      const me = game.players[pid];
      const lands = game.battlefield.filter(c => c.controller === pid && game.chars(c).types.has('Land')).length;
      const best = opts.filter(o => o.value !== 0).map(o => game.cardById(o.value)).filter(Boolean)
        .filter(c => me.library.length > 25 && (!game.chars(c).types.has('Land') || lands < 6 && !me.hand.some(h => game.chars(h).types.has('Land'))))
        .sort((a, b) => this.value(b) - this.value(a))[0];
      return best ? best.id : 0;
    }
    if (req.purpose === 'altAdditionalCost') {
      const me = game.players[pid];
      const rank = o => /^Reveal/.test(o.value) ? 0 : /^\d+$|^[WUBRGC ]+$/.test(o.value) ? 1 : /^PayLife/.test(o.value) ? (me.life > 15 ? 1.5 : 5) : /^Discard/.test(o.value) ? (me.hand.length > 3 ? 2 : 4) : 3;
      return opts.slice().sort((a, b) => rank(a) - rank(b))[0].value;
    }
    if (req.purpose === 'changeCombatants') {
      // send the attacker at whoever we like least: never at ourselves, preferably at the weakest-defended threat
      const c = game.cardById(req.cardId);
      const mine = c && c.controller === pid;
      const score = o => {
        const ref = o.value; const obj = fromRef(game, ref);
        if (!obj) return -99;
        const owner = obj.isPlayer ? obj.id : obj.controller;
        if (owner === pid) return -100;
        return mine ? (obj.isPlayer ? 40 - obj.life + this.threat(owner) * 0.2 : 5) : this.threat(owner) + (obj.isPlayer ? 0 : -3);
      };
      return opts.slice().sort((a, b) => score(b) - score(a))[0].value;
    }
    return opts[0].value;
  }

  // left or right: for control swaps take the richer neighbour's side, for attack limits face the weaker attacker
  direction(game, pid, req) {
    const worth = (q, valid) => q == null ? 0 : game.battlefield.filter(c => c.controller === q && valid(c)).reduce((s, c) => s + this.value(c), 0);
    const left = playerInDirection(game, pid, 'Left'), right = playerInDirection(game, pid, 'Right');
    if (req.ai === 'Aminatou' || req.ai === 'GainControl') {
      // we take what the player in the chosen direction controls ... and give ours to the other side
      const valid = req.ai === 'GainControl' ? (c => game.chars(c).types.has('Creature')) : (c => !game.chars(c).types.has('Land'));
      return worth(left, valid) >= worth(right, valid) ? 'Left' : 'Right';
    }
    // everyone may attack only their nearest opponent in that direction: with Left we're attacked from our right
    return this.threat(right ?? pid) <= this.threat(left ?? pid) ? 'Left' : 'Right';
  }

  modes(game, pid, req) {
    const sa = req.sa;
    const scored = req.options.map(o => {
      const raw = sa.svars[o.value];
      const parsed = parseAbility(raw);
      const fake = buildDummySA(game, { raw, parsed, svars: sa.svars, src: sa.host, key: 'm' }, sa.host, pid);
      let s = 0;
      for (const sub of fake.chain()) s += this.scoreApi(game, pid, sub, { main: true });
      if (parsed.api === 'Counter') s = game.stack.some(x => x.controller !== pid) ? 5 : -5;
      return { v: o.value, s };
    }).sort((a, b) => b.s - a.s);
    const n = Math.max(req.min, Math.min(req.max, scored.filter(x => x.s > 0).length || req.min));
    if (req.baseMana && req.options.some(o => o.cost)) {
      // spree / tiered: add modes while their costs stay affordable
      let acc = req.baseMana.x ? { ...req.baseMana, x: 0 } : req.baseMana;
      const out = [];
      const ex = new Set(sa && sa.host ? [sa.host.id] : []);
      for (const x of scored) {
        if (out.length >= req.max || (out.length >= Math.max(1, req.min) && x.s <= 0)) break;
        const o = req.options.find(y => y.value === x.v);
        const next = o.cost ? addCosts(acc, o.cost) : acc;
        if (!canAfford(game, pid, next, { spellCard: sa && sa.host, exclude: ex })) continue;
        acc = next; out.push(x.v);
      }
      return out.length >= req.min ? out : scored.slice(0, req.min).map(x => x.v);
    }
    if (req.repeat) return Array(n).fill(scored[0].v);
    return scored.slice(0, n).map(x => x.v);
  }

  confirm(game, pid, req) {
    const purpose = req.purpose || '';
    const sa = req.sa;
    switch (purpose) {
      case 'commanderReturn': return true;
      case 'kicker': return true;
      case 'castFree': return true;
      case 'replacement': return true;
      case 'myriad': return true;
      case 'echo': return true;
      case 'newTargets': return false;
      case 'shuffle': return false;
      case 'reveal': return true;
      case 'exploreGrave': { const c = req.cards && game.cardById(req.cards[0]); return c ? game.chars(c).cmc > 5 : false; }
      case 'entwine': return true;
      case 'buyback': return true;
      case 'exert': {
        // only when the "when you do" part has something to do
        const t = req.trigger;
        if (!t || !t.p.ValidTgts) return true;
        const s = new SA(game, { raw: t.raw, parsed: t, svars: {}, src: null, key: 'x' }, game.cardById(req.cardId), pid);
        const spec = targetSpec(game, s);
        return !spec || targetCandidates(game, s, spec).some(o => (o.isPlayer ? o.id : ctrlOf(game, o)) !== pid);
      }
      case 'keepTapped': {
        // keep it tapped while something depends on it staying tapped
        const c = game.cardById(req.cardId);
        return !!c && (game.battlefield.some(x => x.tempControl && x.tempControl.untilUntapOf === c.id) || game.effects.some(e => e.endsWhenHostUntaps === c.id));
      }
      case 'cumulativeUpkeep': return (req.age || 1) <= 4;
      case 'optionalCost': {
        const c = String(req.cost || '');
        if (/^Blight/.test(c)) return game.battlefield.some(x => x.controller === pid && game.chars(x).types.has('Creature') && (x.token || game.chars(x).toughness > 1));
        return true;
      }
      case 'triggerCost': {
        if (!sa || !sa.p.Cost) return true;
        const me = game.players[pid];
        const cost = parseCost(sa.p.Cost);
        for (const pt of cost.parts) {
          const n = +pt.amount || 1;
          if (pt.type === 'PayLife' && me.life - n < 12) return false;
          if (pt.type === 'Discard' && me.hand.length < 3) return false;
          if (pt.type === 'Sac' && !/^(CARDNAME|Card\.Self)$/.test(pt.valid || '')) {
            const pool = game.battlefield.filter(c => c.controller === pid && matchValid(game, c, pt.valid, ctxOf(game, sa)));
            if (!pool.some(c => c.token || this.value(c) < 3)) return false;
          }
        }
        return true;
      }
      case 'clashBottom': {
        const c = req.cards && game.cardById(req.cards[0]);
        if (!c) return false;
        const lands = game.battlefield.filter(x => x.controller === pid && game.chars(x).types.has('Land')).length;
        return game.chars(c).types.has('Land') ? lands >= 6 : game.chars(c).cmc > lands + 3;
      }
      case 'unlessCost': {
        if (!sa) return false;
        if (sa.api === 'Counter') return true;
        if (sa.p.UnlessSwitched === 'True') return true;
        const harmToMe = this.sentiment(sa) === 'harm';
        if (sa.api === 'Draw' && sa.controller !== pid) return game.activePlayer !== pid && Math.random() < 0.5;
        return harmToMe;
      }
      case 'optionalTrigger': case 'optional': case 'optionalSearch': case 'etbOptional': {
        if (!sa) return true;
        const api = sa.api;
        if (api === 'MoveCounter' && sa.p.AILogic === 'Graft') {
          // graft: only onto our own creatures, and never if the counter is what keeps the grafter alive
          const dst = sa.trig && sa.trig.Card, src = sa.host;
          if (!dst || dst.controller !== pid || !src || src.zone !== 'battlefield') return false;
          const sch = game.chars(src);
          return !sch.types.has('Creature') || sch.toughness > 1;
        }
        if (api === 'Sacrifice' && (!sa.p.Defined || sa.p.Defined === 'You')) return false;
        if (api === 'Discard' && (!sa.p.Defined || sa.p.Defined === 'You')) return game.players[pid].hand.length > 3;
        if (api === 'LoseLife' && (!sa.p.Defined || sa.p.Defined === 'You')) return game.players[pid].life > 15;
        if (api === 'Mill' && (!sa.p.Defined || sa.p.Defined === 'You')) return true;
        return true;
      }
      default: return true;
    }
  }

  number(game, pid, req) {
    if (req.purpose === 'readAhead') return req.min;
    if (req.purpose === 'xValue' && req.xCost === 'PayLife') {
      const opp = game.battlefield.filter(c => c.controller !== pid && game.chars(c).types.has('Creature'));
      const need = opp.length ? Math.max(...opp.map(c => game.chars(c).toughness)) : 0;
      return Math.max(req.min, Math.min(req.max, need, game.players[pid].life - 8));
    }
    if (req.purpose === 'xValue' && req.sa) {
      for (const s of req.sa.chain()) {
        if (s.p.TargetMax === 'X' || s.p.TargetMin === 'X') {
          const spec = targetSpec(game, s);
          if (!spec) continue;
          const sent = this.sentiment(s);
          const good = targetCandidates(game, s, spec).filter(c => {
            const mine = c.isPlayer ? c.id === pid : (c.stackItem ? c.controller === pid : ctrlOf(game, c) === pid);
            return sent === 'harm' ? !mine : mine;
          }).length;
          return Math.max(req.min, Math.min(req.max, good));
        }
      }
    }
    if (req.purpose === 'xValue' || req.purpose === 'multikicker' || req.purpose === 'squad' || req.purpose === 'delve' || req.purpose === 'drawUpTo') return req.max;
    return req.max;
  }

  color(game, pid, req) {
    const opts = req.colors || COLORS;
    const counts = {};
    const mine = !(req.ai && /Human|Opponent/.test(req.ai));
    for (const c of game.allCards()) {
      if (mine ? c.owner !== pid : c.owner === pid) continue;
      const mc = c.def.faces[0].manaCost;
      if (!mc) continue;
      for (const k of COLORS) counts[k] = (counts[k] || 0) + mc.colored[k];
    }
    if (req.purpose === 'mana') {
      const need = this.colorNeeds(game, pid);
      return opts.slice().sort((a, b) => (need[b] || 0) - (need[a] || 0))[0];
    }
    return opts.slice().sort((a, b) => (counts[b] || 0) - (counts[a] || 0))[0];
  }

  player(game, pid, req) {
    const sa = req.sa;
    const ids = req.players;
    const harm = !sa || this.sentiment(sa) === 'harm' || /Curse|Opponent|Worst/.test(req.ai || '');
    if (harm) {
      const opp = ids.filter(id => id !== pid).sort((a, b) => this.threat(b) - this.threat(a));
      return opp.length ? opp[0] : ids[0];
    }
    return ids.includes(pid) ? pid : ids[0];
  }

  // ------------------------------------------------------------ combat
  attackers(game, pid, req) {
    const me = game.players[pid];
    const cands = req.candidates.map(id => game.cardById(id)).filter(Boolean);
    // only opponents some creature may legally attack (Mystic Barrier & co. limit who can be attacked)
    const opps = game.opponents(pid).filter(o => !cands.length || cands.some(c => canAttackDefender(game, c, o.id, null)));
    if (!opps.length) return [];
    // potential damage opponents could swing back with
    const backswing = opps.reduce((m, o) => Math.max(m, game.battlefield.filter(c => c.controller === o.id && game.chars(c).types.has('Creature') && !game.hasKeyword(c, 'Defender')).reduce((s, c) => s + strikeDamage(game, c), 0)), 0);
    const out = [];
    const used = new Set();
    // mandatory attackers (goad / encore)
    for (const c of cands) {
      if (c.mustAttack != null && game.players[c.mustAttack] && !game.players[c.mustAttack].lost) { out.push({ attacker: c.id, defender: 'p' + c.mustAttack }); used.add(c.id); }
      else if (c.goadedBy && c.goadedBy.length) {
        const t = opps.find(o => !c.goadedBy.includes(o.id)) || opps[0];
        out.push({ attacker: c.id, defender: 'p' + t.id }); used.add(c.id);
      }
    }
    // choose the target opponent: lethal first, then most threatening / lowest life
    const evasivePower = (o) => cands.filter(c => !used.has(c.id)).filter(c => !this.blockersFor(game, c, o.id).length).reduce((s, c) => s + strikeDamage(game, c), 0);
    let target = opps.find(o => evasivePower(o) >= o.life) || null;
    if (!target) target = opps.slice().sort((a, b) => (a.life - this.threat(a.id) * 0.3 - (a.isHuman ? 4 : 0)) - (b.life - this.threat(b.id) * 0.3 - (b.isHuman ? 4 : 0)))[0];
    const lethal = evasivePower(target) >= target.life;
    const totalPower = cands.reduce((s, c) => s + strikeDamage(game, c), 0);
    let keepBack = 0;
    if (backswing >= me.life - 2) keepBack = backswing - (me.life - 3);
    const ordered = cands.filter(c => !used.has(c.id)).sort((a, b) => this.value(a) - this.value(b));
    let defenseValue = 0;
    const defenders = game.battlefield.filter(c => c.controller === pid && game.chars(c).types.has('Creature'));
    for (const c of ordered) {
      const pw = combatPower(game, c);
      if (pw <= 0) continue;
      if (attackTax(game, c, target.id) > 0 && !lethal) continue;
      const blockers = this.blockersFor(game, c, target.id);
      let go = false;
      if (lethal || totalPower >= target.life * 1.2 && blockers.length < 2) go = true;
      else if (!blockers.length) go = true;
      else {
        const ch = game.chars(c);
        const killers = blockers.filter(b => this.wouldKill(game, b, c));
        const safeKillers = killers.filter(b => !this.wouldKill(game, c, b));
        if (!killers.length) go = true;
        else if (!safeKillers.length && killers.every(b => this.value(b) >= this.value(c) - 1)) go = c.token || this.value(c) < 6;
        if (game.hasKeywordIn(ch, 'Indestructible')) go = true;
      }
      // hold back blockers when facing lethal backswing
      if (go && keepBack > 0 && !game.hasKeyword(c, 'Vigilance') && !lethal) {
        if (game.chars(c).toughness >= 2 || defenseValue < keepBack) { defenseValue += game.chars(c).toughness; continue; }
      }
      if (go) {
        // attack planeswalkers if an easy kill
        let def = 'p' + target.id;
        const pw2 = game.battlefield.find(x => x.controller === target.id && game.chars(x).types.has('Planeswalker') && (x.counters.LOYALTY || 0) <= pw);
        if (pw2 && !lethal && !blockers.length) def = 'c' + pw2.id;
        out.push({ attacker: c.id, defender: def });
      }
    }
    return out;
  }

  blockersFor(game, attacker, defPid) {
    return game.battlefield.filter(b => b.controller === defPid && !b.tapped && game.chars(b).types.has('Creature') && canBlockSafe(game, b, attacker));
  }

  // would `src` destroy `dst` when they fight, counting first strike and double strike:
  // a first striker can kill its opponent before that one deals damage, a double striker hits twice
  wouldKill(game, src, dst) {
    const p = combatPower(game, src);
    if (p <= 0) return false;
    if (game.hasKeywordIn(game.chars(dst), 'Indestructible')) return false;
    const lethal = (from, to, n) => n > 0 && (game.hasKeyword(from, 'Deathtouch') || n >= game.chars(to).toughness - to.damage);
    const early = c => game.hasKeyword(c, 'First Strike') || game.hasKeyword(c, 'Double Strike');
    let dealt = early(src) ? p : 0;
    if (lethal(src, dst, dealt)) return true;
    const back = combatPower(game, dst);
    if (early(dst) && !game.hasKeywordIn(game.chars(src), 'Indestructible') && lethal(dst, src, back)) return false;
    if (!early(src) || game.hasKeyword(src, 'Double Strike')) dealt += p;
    return lethal(src, dst, dealt);
  }

  blockers(game, pid, req) {
    const me = game.players[pid];
    const atks = req.attackers.map(id => game.cardById(id)).filter(Boolean).sort((a, b) => combatPower(game, b) - combatPower(game, a));
    const avail = new Set(req.candidates);
    const out = [];
    let incoming = atks.reduce((s, a) => s + strikeDamage(game, a), 0);
    const poisonThreat = atks.filter(a => game.hasKeyword(a, 'Infect')).reduce((s, a) => s + strikeDamage(game, a), 0);
    const cmdrDanger = atks.some(a => a.isCommander && (me.commanderDamage[a.id] || 0) + strikeDamage(game, a) >= 21);
    const lethal = incoming >= me.life || (me.counters.POISON || 0) + poisonThreat >= 10 || cmdrDanger;
    for (const a of atks) {
      const cand = [...avail].map(id => game.cardById(id)).filter(b => b && canBlockSafe(game, b, a));
      if (!cand.length) continue;
      const rules = blockRules(game, a);
      const good = cand.filter(b => this.wouldKill(game, b, a) && !this.wouldKill(game, a, b)).sort((x, y) => this.value(x) - this.value(y));
      const safe = cand.filter(b => !this.wouldKill(game, a, b)).sort((x, y) => this.value(x) - this.value(y));
      const trade = cand.filter(b => this.wouldKill(game, b, a) && this.value(b) <= this.value(a) + 0.5 && !b.isCommander).sort((x, y) => this.value(x) - this.value(y));
      let pickList = null;
      if (rules.min <= 1) {
        if (good.length) pickList = [good[0]];
        else if (safe.length && !game.hasKeyword(a, 'Trample')) pickList = [safe[0]];
        else if (trade.length) pickList = [trade[0]];
        else if (lethal) { const chump = cand.filter(b => !b.isCommander).sort((x, y) => this.value(x) - this.value(y))[0]; if (chump) pickList = [chump]; }
      } else if (cand.length >= rules.min && (lethal || cand.filter(b => this.wouldKill(game, b, a)).length)) {
        pickList = cand.sort((x, y) => this.value(x) - this.value(y)).slice(0, rules.min);
      }
      if (pickList) {
        for (const b of pickList) { out.push({ blocker: b.id, attacker: a.id }); avail.delete(b.id); }
        if (!game.hasKeyword(a, 'Trample')) incoming -= strikeDamage(game, a);
      }
    }
    return out;
  }
}

// combat damage a creature deals if unblocked (double strike hits twice)
function strikeDamage(game, c) { return Math.max(0, combatPower(game, c)) * (game.hasKeyword(c, 'Double Strike') ? 2 : 1); }

function canBlockSafe(game, b, a) { try { return canBlock(game, b, a); } catch { return false; } }

function safeCalc(game, v, sa) { try { return calc(game, v, sa); } catch { return 0; } }

function buildDummySA(game, abil, card, pid) {
  // lightweight SA for scoring (no state change)
  return new SA(game, abil, card, pid);
}

function defaultAnswer(req) {
  switch (req.type) {
    case 'priority': return { type: 'pass' };
    case 'mulligan': return true;
    case 'targets': return req.cands.slice(0, req.min);
    case 'cards': return req.cards.slice(0, req.min);
    case 'option': return req.options && req.options[0] ? req.options[0].value : null;
    case 'modes': return req.options.slice(0, req.min).map(o => o.value);
    case 'confirm': return false;
    case 'number': return req.min || 0;
    case 'color': return (req.colors || ['W'])[0];
    case 'player': return req.players[0];
    case 'attackers': return [];
    case 'blockers': return [];
    default: return null;
  }
}
