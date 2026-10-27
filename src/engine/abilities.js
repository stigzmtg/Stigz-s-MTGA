// Spell abilities: construction, costs, targeting, casting, activation, mana payment and resolution.
import { parseAbility } from './forge.js';
import { parseMana, emptyCost, addCosts, cmc, isManaToken, planPayment, payFromPool, manaColorsFromProduced, costString, poolTotal, cloneCost } from './mana.js';
import { matchValid, resolveDefined, calcCtx, checkConditions, checkPresence, ctxOf, findTargets, zoneMap, ctrlOf } from './filters.js';
import { COLORS } from './util.js';
import { runEffect } from './effects.js';
import { charmModeAllowed, noteCharmModes, paramCostStatic, paramSpellCost, paramAbilityCost, paramCostAfterTargets, otherOptionalCosts, mayPlayUsed, noteMayPlayUse, mayPlayOptions, paramTargetFilter, replaceProducedUnits } from './mech-params.js';

export class Cancelled extends Error { constructor() { super('cancelled'); this.cancelled = true; } }

let saUid = 1;
export class SA {
  constructor(game, abil, host, controller, { parent = null, trig = null, depth = 0 } = {}) {
    this.uid = saUid++;
    this.abil = abil;
    this.def = abil.parsed;
    this.p = abil.parsed.p;
    this.api = abil.parsed.api;
    this.kind = abil.parsed.kind;
    this.svars = abil.svars || {};
    this.host = host;
    this.hostZcc = host && host.isCard && !host.lki ? host.zcc : null;
    this.controller = controller;
    this.parent = parent;
    this.trig = trig || (parent && parent.trig) || null;
    this.targets = [];
    this.key = abil.key;
    if (!parent) { this.paid = { Sacrificed: [], Discarded: [], Exiled: [], Tapped: [], Revealed: [] }; this.x = null; }
    this.sub = null;
    this.modes = null;
    const subName = this.p.SubAbility;
    if (subName && this.svars[subName] && depth < 25) {
      this.sub = new SA(game, { raw: this.svars[subName], parsed: parseAbility(this.svars[subName]), svars: this.svars, src: abil.src, key: abil.key + '>' + subName }, host, controller, { parent: this, trig: this.trig, depth: depth + 1 });
    }
  }
  root() { let s = this; while (s.parent) s = s.parent; return s; }
  chain() { const out = []; for (let s = this; s; s = s.sub) { out.push(s); if (s.modes) for (const m of s.modes) out.push(...m.chain()); } return out; }
  get description() {
    return this._desc || (this.p.SpellDescription || this.p.StackDescription || this.api || '').replace(/^SpellDescription$/, '');
  }
  set description(v) { this._desc = v; }
}

export function makeSA(game, raw, svars, host, controller, opts = {}) {
  return new SA(game, { raw, parsed: parseAbility(raw), svars, src: host, key: opts.key || 'x' }, host, controller, opts);
}

// ---------------------------------------------------------------- refs (for UI / agents)
export function refOf(o) {
  if (!o) return null;
  if (o.isPlayer) return 'p' + o.id;
  if (o.stackItem) return 's' + o.id;
  return 'c' + o.id;
}
export function fromRef(game, r) {
  if (r == null) return null;
  if (typeof r === 'number') return game.cardById(r);
  const t = r[0], id = +r.slice(1);
  if (t === 'p') return game.players[id];
  if (t === 's') return game.stack.find(s => s.id === id) || null;
  return game.cardById(id);
}

// ---------------------------------------------------------------- costs
export function parseCost(str) {
  const cost = { mana: emptyCost(), hasMana: false, tap: false, untap: false, parts: [], raw: str || '' };
  if (!str) return cost;
  const tokens = String(str).match(/\w+<[^>]*>|\S+/g) || [];
  const manaToks = [];
  for (const tok of tokens) {
    if (tok === 'T') { cost.tap = true; continue; }
    if (tok === 'Q') { cost.untap = true; continue; }
    const m = tok.match(/^(\w+)<(.*)>$/);
    if (m) {
      const args = m[2].split('/');
      const type = m[1];
      const part = { type, amount: args[0], args };
      switch (type) {
        case 'Sac': part.valid = args[1] || 'CARDNAME'; part.desc = args[2]; break;
        case 'SubCounter': case 'AddCounter': part.counter = args[1]; part.valid = args[2] || 'CARDNAME'; break;
        case 'RemoveAnyCounter': part.counter = args[1] || 'Any'; part.valid = args[2] || 'Card.YouCtrl'; break;
        case 'Discard': part.valid = args[1] || 'Card'; break;
        case 'Exile': case 'ExileFromGrave': case 'ExileFromHand': case 'ExileFromTop': case 'ExileAnyGrave': case 'ExileSameGrave': case 'ExiledMoveToGrave': part.valid = args[1] || 'Card'; break;
        case 'tapXType': case 'untapYType': part.valid = args[1] || 'Creature'; break;
        case 'Return': part.valid = args[1] || 'CARDNAME'; break;
        case 'Reveal': case 'Behold': part.valid = args[1] || 'Card'; break;
        case 'PutCardToLibFromBattlefield': part.valid = args[2] || 'CARDNAME'; part.libPos = args[1]; break;
        default: break;
      }
      // "Artifact.Other;Creature.Other": ';' separates alternatives in cost types
      if (part.valid && part.valid.includes(';')) part.valid = part.valid.replace(/;/g, ',');
      cost.parts.push(part);
      continue;
    }
    if (isManaToken(tok)) { manaToks.push(tok); continue; }
    // "XMin1", "Mandatory" and other modifiers are ignored
  }
  if (manaToks.length) { cost.mana = parseMana(manaToks.join(' ')); cost.hasMana = true; }
  return cost;
}

function amountOf(game, sa, amt) {
  if (amt === 'All') return Infinity;
  if (amt === 'X' && sa.root().x != null) return sa.root().x;
  return calcCtx(game, amt, ctxOf(game, sa));
}

function costCandidates(game, sa, part) {
  const pid = sa.controller;
  const host = sa.host;
  const ctx = ctxOf(game, sa);
  const valid = (part.valid || '').replace(/CARDNAME|NICKNAME/g, 'Card.Self');
  switch (part.type) {
    case 'Sac': case 'Return': case 'Exile': {
      const ok = c => part.type !== 'Sac' || !game.cantSacrifice(c, sa, true);
      if (valid === 'Card.Self') return host.zone === 'battlefield' && ok(host) ? [host] : [];
      return game.battlefield.filter(c => c.controller === pid && matchValid(game, c, valid, ctx) && ok(c));
    }
    case 'tapXType':
      return game.battlefield.filter(c => c.controller === pid && !c.tapped && matchValid(game, c, valid, ctx) && (valid === 'Card.Self' || c.id !== host.id || true));
    case 'untapYType':
      return game.battlefield.filter(c => c.controller === pid && c.tapped && matchValid(game, c, valid, ctx));
    case 'Discard':
      if (valid === 'Card.Self') return host.zone === 'hand' ? [host] : [];
      if (valid === 'Hand') return game.players[pid].hand.slice();
      return game.players[pid].hand.filter(c => matchValid(game, c, valid === 'Random' ? 'Card' : valid, ctx) && c.id !== host.id);
    case 'ExileFromGrave':
      if (valid === 'Card.Self') return host.zone === 'graveyard' ? [host] : [];
      return game.players[pid].graveyard.filter(c => matchValid(game, c, valid, ctx) && c.id !== host.id);
    case 'ExileAnyGrave':
      return game.cardsInZone('graveyard').filter(c => matchValid(game, c, valid, ctx));
    case 'ExileFromHand':
      return game.players[pid].hand.filter(c => matchValid(game, c, valid, ctx) && c.id !== host.id);
    case 'Reveal':
      return game.players[pid].hand.filter(c => matchValid(game, c, valid, ctx));
    case 'SubCounter': case 'RemoveAnyCounter':
      if (valid === 'Card.Self') return [host];
      return game.battlefield.filter(c => c.controller === pid && matchValid(game, c, valid, ctx));
    case 'Blight': return game.battlefield.filter(c => c.controller === pid && game.chars(c).types.has('Creature'));
    case 'Behold': return [...game.battlefield.filter(c => c.controller === pid), ...game.players[pid].hand].filter(c => c.id !== host.id && matchValid(game, c, valid, ctx));
    case 'PutCardToLibFromBattlefield': if (valid === 'Card.Self') return host.zone === 'battlefield' ? [host] : []; return game.battlefield.filter(c => c.controller === pid && matchValid(game, c, valid, ctx));
    case 'ExiledMoveToGrave': return game.cardsInZone('exile').filter(c => matchValid(game, c, valid, ctx));
    case 'ExileSameGrave': return game.cardsInZone('graveyard').filter(c => matchValid(game, c, valid, ctx));
    default: return [];
  }
}

// cost parts that each pick their own cards ("Sacrifice a Swamp and a Forest"): one card can't pay for two of them
const PICK_PARTS = new Set(['Sac', 'Discard', 'ExileFromGrave', 'ExileFromHand', 'Return', 'Exile', 'tapXType', 'untapYType', 'Reveal', 'ExileAnyGrave', 'ExiledMoveToGrave', 'Behold', 'PutCardToLibFromBattlefield']);
function pickSlots(game, sa, parts, exclude) {
  const slots = [];
  for (const part of parts) {
    if (!PICK_PARTS.has(part.type)) continue;
    if (part.type === 'Discard' && (part.valid === 'Hand' || part.valid === 'Random')) continue;
    if (part.type === 'tapXType' && /withTotalPowerGE/.test(part.valid || '')) continue;
    const n = part.amount === 'X' ? (sa.root().x || 0) : amountOf(game, sa, part.amount);
    if (!Number.isFinite(n) || n <= 0) continue;
    const ids = costCandidates(game, sa, part).filter(c => !exclude.has(c.id)).map(c => c.id);
    for (let i = 0; i < n; i++) slots.push(ids);
  }
  return slots;
}
// can every pick part get its own distinct cards (a bipartite matching of slots to cards)?
function distinctPicksPossible(game, sa, parts, exclude = new Set(), minSlots = 1) {
  const slots = pickSlots(game, sa, parts, exclude);
  if (slots.length < minSlots || slots.length > 60) return true;
  const owner = new Map();
  const assign = (i, seen) => {
    for (const id of slots[i]) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (!owner.has(id) || assign(owner.get(id), seen)) { owner.set(id, i); return true; }
    }
    return false;
  };
  for (let i = 0; i < slots.length; i++) if (!assign(i, new Set())) return false;
  return true;
}

export function canPayNonMana(game, sa, cost, exclude = new Set()) {
  const pid = sa.controller;
  const host = sa.host;
  const p = game.players[pid];
  if (cost.tap) {
    if (host.zone !== 'battlefield' || host.tapped) return false;
    if (game.chars(host).types.has('Creature') && host.sick && !game.hasKeyword(host, 'Haste') && !hasteActivation(game, host)) return false;
  }
  if (cost.untap) {
    if (host.zone !== 'battlefield' || !host.tapped) return false;
    if (game.chars(host).types.has('Creature') && host.sick && !game.hasKeyword(host, 'Haste')) return false;
  }
  for (const part of cost.parts) {
    const n = part.amount === 'X' ? (sa.root().x || 0) : amountOf(game, sa, part.amount);
    switch (part.type) {
      case 'PayLife': if (p.life < n) return false; break;
      case 'PayEnergy': if ((p.counters.ENERGY || 0) < n) return false; break;
      case 'SubCounter': {
        const ctr = normalizeCounterName(part.counter);
        const cands = costCandidates(game, sa, part);
        const total = cands.reduce((a, c) => a + (c.counters[ctr] || 0), 0);
        if (total < n) return false;
        break;
      }
      case 'RemoveAnyCounter': {
        const cands = costCandidates(game, sa, part);
        const total = cands.reduce((a, c) => a + Object.values(c.counters).reduce((x, y) => x + y, 0), 0);
        if (total < n) return false;
        break;
      }
      case 'AddCounter': break;
      case 'Blight': if (!costCandidates(game, sa, part).length) return false; break;
      case 'RollDice': break;
      case 'RevealChosen': if (!(host.chosen && host.chosen.player != null)) return false; break;
      case 'ExileSameGrave': {
        const cands = costCandidates(game, sa, part).filter(c => !exclude.has(c.id));
        if (!game.players.some(pl => cands.filter(c => c.owner === pl.id).length >= n)) return false;
        break;
      }
      case 'Mill': if (p.library.length < n) return false; break;
      case 'Draw': break;
      case 'Exert': case 'Unattach': break;
      case 'Crew': {
        const need = n;
        const total = game.battlefield.filter(c => c.controller === pid && !c.tapped && c.id !== host.id && game.chars(c).types.has('Creature')).reduce((a, c) => a + Math.max(0, game.chars(c).power), 0);
        if (total < need) return false;
        break;
      }
      case 'tapXType': {
        const cands = costCandidates(game, sa, part).filter(c => !exclude.has(c.id));
        if (/withTotalPowerGE(\d+)/.test(part.valid || '')) {
          const need = +RegExp.$1;
          if (cands.reduce((a, c) => a + game.chars(c).power, 0) < need) return false;
        } else if (cands.length < (part.amount === 'Any' ? 0 : n)) return false;
        break;
      }
      default: {
        const cands = costCandidates(game, sa, part).filter(c => !exclude.has(c.id));
        if (n !== Infinity && cands.length < n) return false;
      }
    }
  }
  if (cost.parts.length > 1 && !distinctPicksPossible(game, sa, cost.parts, exclude, 2)) return false;
  return true;
}

function hasteActivation(game, host) {
  return game.activeStatics('ActivateAbilityAsIfHaste').some(s => matchValid(game, host, s.p.ValidCard || 'Card.Self', s.ctx));
}

export function normalizeCounterName(c) {
  if (!c) return 'P1P1';
  const u = c.toUpperCase();
  if (u === 'LOYALTY') return 'LOYALTY';
  return u.replace(/[^A-Z0-9_]/g, '');
}

// Gather cost choices (no state change). Returns plan object or throws Cancelled / returns null if impossible.
async function chooseCostParts(game, sa, cost, { afford = null } = {}) {
  const pid = sa.controller;
  const choices = [];
  const used = new Set();
  for (const [pi, part] of cost.parts.entries()) {
    const n0 = part.amount === 'X' ? (sa.root().x || 0) : amountOf(game, sa, part.amount);
    const label = part.desc || part.valid;
    switch (part.type) {
      case 'Blight': {
        const cands = costCandidates(game, sa, part);
        if (!cands.length) return null;
        const ids = cands.length === 1 ? [cands[0].id] : await game.ask(pid, { type: 'cards', prompt: `Blight ${n0}: put ${n0} -1/-1 counter${n0 === 1 ? '' : 's'} on a creature you control`, cards: cands.map(c => c.id), min: 1, max: 1, purpose: 'blight', sa, cancellable: true });
        if (!ids) throw new Cancelled();
        choices.push({ part, cards: ids.map(id => game.cardById(id)).filter(Boolean).slice(0, 1), n: n0 });
        break;
      }
      case 'ExileSameGrave': {
        // N cards from a single graveyard
        const cands = costCandidates(game, sa, part).filter(c => !used.has(c.id));
        const owners = game.players.filter(pl => cands.filter(c => c.owner === pl.id).length >= n0);
        if (!owners.length) return null;
        let owner = owners[0];
        if (owners.length > 1) { const id = await game.ask(pid, { type: 'player', prompt: 'Exile cards from whose graveyard?', players: owners.map(o => o.id), sa, purpose: 'costExileSameGrave' }); owner = owners.find(o => o.id === id) || owners[0]; }
        const pool = cands.filter(c => c.owner === owner.id);
        const ids = pool.length === n0 ? pool.map(c => c.id) : await game.ask(pid, { type: 'cards', prompt: `Exile ${n0}: ${part.args[2] || humanValid(part.valid)} from ${owner.name}'s graveyard`, cards: pool.map(c => c.id), min: n0, max: n0, purpose: 'costExile', sa, cancellable: true });
        if (!ids) throw new Cancelled();
        const chosen = ids.map(id => game.cardById(id)).filter(Boolean);
        chosen.forEach(c => used.add(c.id));
        choices.push({ part, cards: chosen });
        break;
      }
      case 'Sac': case 'Discard': case 'ExileFromGrave': case 'ExileFromHand': case 'Return': case 'Exile': case 'tapXType': case 'untapYType': case 'Reveal': case 'ExileAnyGrave': case 'ExiledMoveToGrave': case 'Behold': case 'PutCardToLibFromBattlefield': {
        let cands = costCandidates(game, sa, part).filter(c => !used.has(c.id));
        let n = n0 === Infinity ? cands.length : n0;
        // don't offer a permanent the mana payment still needs (a Treasure to sacrifice, a creature to tap)
        if (afford && (part.type === 'Sac' || part.type === 'tapXType') && n0 !== Infinity) {
          const keep = cands.filter(c => afford(new Set(costExclusions(game, [{ part, cards: [c] }]))));
          if (keep.length >= n) cands = keep;
        }
        // nor one the rest of the cost needs (a Swamp Forest when a Swamp and a Forest are to be sacrificed)
        const rest = cost.parts.slice(pi + 1).filter(pt => PICK_PARTS.has(pt.type));
        const restOk = ids => !rest.length || distinctPicksPossible(game, sa, rest, new Set([...used, ...ids]));
        if (rest.length && n0 !== Infinity) {
          const keep = cands.filter(c => restOk([c.id]));
          if (keep.length >= n) cands = keep;
        }
        if (part.type === 'tapXType' && /withTotalPowerGE(\d+)/.test(part.valid || '')) {
          const need = +RegExp.$1;
          cands = costCandidates(game, sa, { ...part, valid: part.valid.replace(/\+?withTotalPowerGE\d+/, '') }).filter(c => !used.has(c.id));
          let chosen = null;
          for (let tries = 0; tries < 3 && !chosen; tries++) {
            const ids = await game.ask(pid, { type: 'cards', prompt: `${tries ? `Those creatures' total power is less than ${need}. ` : ''}Tap creatures with total power ${need} or more`, cards: cands.map(c => c.id), min: 1, max: cands.length, purpose: 'crew', need, sa, cancellable: true });
            if (!ids) throw new Cancelled();
            const cs = ids.map(id => game.cardById(id)).filter(Boolean);
            if (cs.reduce((a, c) => a + Math.max(0, game.chars(c).power), 0) >= need) chosen = cs;
          }
          if (!chosen) throw new Cancelled();
          choices.push({ part, cards: chosen });
          chosen.forEach(c => used.add(c.id));
          break;
        }
        if (part.valid === 'Random' && part.type === 'Discard') { choices.push({ part, random: n }); break; }
        if (part.valid === 'Hand' && part.type === 'Discard') { choices.push({ part, cards: cands }); break; }
        if (cands.length < n) return null;
        if (n === 0) { choices.push({ part, cards: [] }); break; }
        let chosen;
        if (cands.length === n && (part.valid === 'CARDNAME' || part.valid === 'Card.Self')) chosen = cands;
        else {
          const verb = { Sac: 'Sacrifice', Discard: 'Discard', ExileFromGrave: 'Exile from your graveyard', ExileFromHand: 'Exile from your hand', Return: 'Return to hand', Exile: 'Exile', tapXType: 'Tap', untapYType: 'Untap', Reveal: 'Reveal', ExileAnyGrave: 'Exile from a graveyard', ExiledMoveToGrave: "Put into its owner's graveyard from exile" }[part.type];
          // together, the chosen permanents must leave enough to make the mana (two Treasures for "sacrifice two artifacts" and {R})
          const jointOk = cs => !afford || !(part.type === 'Sac' || part.type === 'tapXType') || afford(new Set([...costExclusions(game, choices), ...costExclusions(game, [{ part, cards: cs }])]));
          let why = '';
          for (let tries = 0; tries < 3 && !chosen; tries++) {
            const ids = await game.ask(pid, { type: 'cards', prompt: `${why}${verb} ${n}: ${part.desc || humanValid(part.valid)}`, cards: cands.map(c => c.id), min: n, max: n, purpose: 'cost' + part.type, sa, cancellable: true });
            if (!ids) throw new Cancelled();
            const cs = ids.map(id => game.cardById(id)).filter(Boolean);
            if (!jointOk(cs)) why = "You'd need one of those to pay the mana. ";
            else if (!restOk(cs.map(c => c.id))) why = "That would leave nothing to pay the rest of the cost with. ";
            else chosen = cs;
          }
          if (!chosen) throw new Cancelled();
        }
        chosen.forEach(c => used.add(c.id));
        choices.push({ part, cards: chosen });
        break;
      }
      case 'SubCounter': case 'RemoveAnyCounter': {
        const ctr = part.type === 'SubCounter' ? normalizeCounterName(part.counter) : null;
        const cands = costCandidates(game, sa, part);
        if (cands.length === 1 || part.valid === 'CARDNAME') { choices.push({ part, cards: [cands[0]], counter: ctr, n: n0 }); break; }
        const withC = cands.filter(c => ctr ? (c.counters[ctr] || 0) > 0 : Object.values(c.counters).some(x => x > 0));
        const has = c => ctr ? (c.counters[ctr] || 0) : Object.values(c.counters).reduce((a, x) => a + x, 0);
        if (n0 <= 0) { choices.push({ part, cards: [], counter: ctr, n: 0 }); break; }
        if (withC.reduce((a, c) => a + has(c), 0) < n0) throw new Cancelled();
        // "remove N counters from among permanents you control": they can come from several
        const one = withC.filter(c => has(c) >= n0);
        const ids = withC.length === 1 ? [withC[0].id] : await game.ask(pid, { type: 'cards', prompt: `Remove ${n0} counter${n0 > 1 ? 's' : ''} from`, cards: withC.map(c => c.id), min: 1, max: one.length ? 1 : withC.length, purpose: 'costRemoveCounter', sa, cancellable: true });
        if (!ids) throw new Cancelled();
        const picked = ids.map(id => game.cardById(id)).filter(Boolean);
        for (const c of withC) { if (picked.reduce((a, x) => a + has(x), 0) >= n0) break; if (!picked.includes(c)) picked.push(c); }
        choices.push({ part, cards: picked, counter: ctr, n: n0 });
        break;
      }
      case 'Crew': {
        const need = n0;
        const cands = game.battlefield.filter(c => c.controller === pid && !c.tapped && c.id !== sa.host.id && game.chars(c).types.has('Creature'));
        // the tapped creatures' total power must reach the crew number
        let chosen = null;
        for (let tries = 0; tries < 3 && !chosen; tries++) {
          const ids = await game.ask(pid, { type: 'cards', prompt: tries ? `Those creatures' total power is less than ${need}. Crew ${need}: tap creatures with total power ${need} or more` : `Crew ${need}: tap creatures with total power ${need} or more`, cards: cands.map(c => c.id), min: 1, max: cands.length, purpose: 'crew', need, sa, cancellable: true });
          if (!ids) throw new Cancelled();
          const cs = ids.map(id => game.cardById(id)).filter(Boolean);
          if (cs.reduce((a, c) => a + Math.max(0, game.chars(c).power), 0) >= need) chosen = cs;
        }
        if (!chosen) throw new Cancelled();
        choices.push({ part, cards: chosen });
        break;
      }
      default: choices.push({ part, n: n0 });
    }
  }
  return choices;
}

export function humanValid(v) {
  if (!v) return '';
  if (v === 'CARDNAME' || v === 'Card.Self') return 'this';
  const ADJ = { untapped: 'untapped', tapped: 'tapped', Other: 'other', StrictlyOther: 'other', nonToken: 'nontoken', token: 'token', nonLand: 'nonland', nonCreature: 'noncreature', attacking: 'attacking', Legendary: 'legendary', Basic: 'basic', nonBasic: 'nonbasic' };
  const TAIL = { YouCtrl: 'you control', YouOwn: 'you own', OppCtrl: 'an opponent controls', YouDontCtrl: "you don't control" };
  return v.split(',').map(alt => {
    const [type, ...rest] = alt.split('.');
    const props = rest.join('.').split('+').filter(Boolean);
    const adj = [], withs = [], tail = [];
    for (const pr of props) {
      if (ADJ[pr]) adj.push(ADJ[pr]);
      else if (TAIL[pr]) tail.push(TAIL[pr]);
      else if (/^with/.test(pr)) withs.push('with ' + pr.slice(4).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase());
      else if (/^non/.test(pr)) adj.push('non' + pr.slice(3).toLowerCase());
      else if (/^(cmc|power|toughness)(LE|GE|EQ|LT|GT)(\d+)$/.test(pr)) { const m = pr.match(/^(cmc|power|toughness)(LE|GE|EQ|LT|GT)(\d+)$/); withs.push(`with ${m[1] === 'cmc' ? 'mana value' : m[1]} ${{ LE: '≤', GE: '≥', EQ: '=', LT: '<', GT: '>' }[m[2]]} ${m[3]}`); }
      else if (/^[A-Z]/.test(pr)) adj.push(pr);
    }
    const noun = type === 'Card' ? 'card' : type === 'Permanent' ? 'permanent' : type.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    return [...adj, noun, ...withs, ...tail].join(' ');
  }).join(' or ');
}

// roll dice for a player: "roll that many plus one and ignore the lowest" replacements (Barbarian Class) apply
export async function rollDice(game, pid, amount, sides, ignore = 0, sa = null) {
  const rr = await game.applySimpleReplacement('RollDice', { Affected: game.players[pid], Player: pid, Number: amount, Ignore: ignore }, sa);
  if (rr) { amount = rr.Number; ignore = rr.Ignore || 0; }
  const rolls = [];
  for (let i = 0; i < amount; i++) rolls.push(1 + game.rng.int(sides));
  // "roll two d20 and ignore the lower roll"
  if (ignore > 0) { rolls.sort((a, b) => b - a); rolls.splice(Math.max(1, rolls.length - ignore)); }
  const total = rolls.reduce((a, b) => a + b, 0);
  game.log(`${game.players[pid].name} rolls ${rolls.length > 1 ? rolls.length : 'a'} d${sides}: ${total}.`);
  game.fire('RolledDie', { Player: pid, Result: total, Sides: sides });
  game.fire('RolledDieOnce', { Player: pid, Result: total, Sides: sides });
  return { rolls, total };
}

// For "can this be paid?": the permanents a sacrifice / tap cost will most likely use (ones that don't make
// mana by sacrificing themselves first) and that therefore can't help pay the mana part.
function costPartExclusions(game, sa, parts) {
  const out = [];
  for (const part of parts) {
    if (part.type !== 'Sac' && part.type !== 'tapXType') continue;
    if (part.valid === 'CARDNAME' || part.valid === 'Card.Self') continue;
    const n = part.amount === 'X' ? 0 : amountOf(game, sa, part.amount);
    if (!(n > 0) || n === Infinity) continue;
    const needed = c => part.type === 'tapXType' ? manaAbilitiesOf(game, c).length > 0 : costExclusions(game, [{ part, cards: [c] }]).length > 0;
    const cands = costCandidates(game, sa, part).filter(c => !out.includes(c.id));
    const ordered = [...cands.filter(c => !needed(c)), ...cands.filter(needed)];
    out.push(...costExclusions(game, [{ part, cards: ordered.slice(0, n) }]));
  }
  return out;
}

// Permanents chosen for a cost that can't also make mana for it: ones tapped for the cost, and ones whose
// mana ability would sacrifice them. A land you sacrifice (Harrow) can be tapped for mana first.
function costExclusions(game, choices) {
  const out = [];
  for (const c of choices) for (const x of c.cards || []) {
    const t = c.part && c.part.type;
    if (t === 'tapXType' || t === 'untapYType' || t === 'Crew' || x.zone !== 'battlefield') { out.push(x.id); continue; }
    if (manaAbilitiesOf(game, x).some(a => parseCost(a.parsed.p.Cost).parts.some(pt => pt.type === 'Sac'))) out.push(x.id);
  }
  return out;
}

// "you may spend mana as though it were mana of any color to pay the activation costs of CARDNAME's abilities"
function manaConverted(game, card, mana, sa = null) {
  if (sa && mana) mana = paramAbilityCost(game, sa, mana); // Type$ Ability cost statics, ManaConvert (mech-params.js)
  if (!card || !card.isCard || card.zone !== 'battlefield' || !mana) return mana;
  if (!game.chars(card).statics.some(s => s.parsed.p.Mode === 'ManaConvert' && /Card\.Self/.test(s.parsed.p.ValidCard || 'Card.Self') && /Activated/.test(s.parsed.p.ValidSA || 'Activated'))) return mana;
  const m = cloneCost(mana);
  for (const c of COLORS) { m.generic += m.colored[c] || 0; m.colored[c] = 0; }
  m.generic += m.hybrid.length; m.hybrid = [];
  return m;
}

// "you may pay {2}{R} any number of times" (Cost$ Mana<2 R\NumTimes> | Announce$ NumTimes)
async function payRepeatedMana(game, sa, unitStr, varName) {
  const pid = sa.controller;
  const unit = parseMana(unitStr);
  let max = 0, m = emptyCost();
  while (max < 10) { const m2 = addCosts(m, unit); if (!canAfford(game, pid, m2, {})) break; m = m2; max++; }
  if (!max) return false;
  const n = await game.ask(pid, { type: 'number', prompt: `${game.name(sa.host)}: pay ${costString(unit)} how many times?`, min: 0, max, purpose: 'repeatCost', sa });
  if (!n || n < 0) return false;
  let total = emptyCost();
  for (let i = 0; i < Math.min(n, max); i++) total = addCosts(total, unit);
  if (!(await payManaCost(game, pid, total, { sa }))) return false;
  const svars = { ...sa.svars, [varName]: `Number$${Math.min(n, max)}` };
  for (const s of sa.chain()) s.svars = svars;
  sa.svars = svars;
  return true;
}

async function applyCostParts(game, sa, cost, choices) {
  const pid = sa.controller;
  const p = game.players[pid];
  const host = sa.host;
  const paid = sa.root().paid;
  if (cost.tap) { await game.tap(host); }
  if (cost.untap) { await game.untap(host); }
  for (const ch of choices) {
    const part = ch.part;
    switch (part.type) {
      case 'Sac': for (const c of ch.cards) { paid.Sacrificed.push(game.makeLKI(c)); await game.sacrifice(c, sa); } break;
      case 'Discard':
        if (ch.random) { for (let i = 0; i < ch.random && p.hand.length; i++) { const c = p.hand[game.rng.int(p.hand.length)]; paid.Discarded.push(c); await game.discard(c, sa); } }
        else for (const c of ch.cards) { paid.Discarded.push(c); await game.discard(c, sa); }
        break;
      case 'ExileFromGrave': case 'ExileFromHand': case 'Exile': case 'ExileAnyGrave': case 'ExileSameGrave': for (const c of ch.cards) { paid.Exiled.push(c); await game.moveCard(c, 'exile', { cause: sa, exiledWith: host.isCard && (sa.isSpell || host.zone === 'battlefield') ? host.id : undefined }); } break;
      case 'ExiledMoveToGrave': for (const c of ch.cards) { (paid.MovedToGrave = paid.MovedToGrave || []).push(c); await game.moveCard(c, 'graveyard', { cause: sa }); } break;
      case 'RollDice': {
        const { total } = await rollDice(game, pid, +part.args[0] || 1, +part.args[1] || 6, 0, sa);
        if (part.args[2] === 'X') sa.root().x = total;
        break;
      }
      case 'Blight': for (const c of ch.cards) await game.addCounters(c, 'M1M1', ch.n, sa); game.log(`${p.name} blights ${ch.n}${ch.cards[0] ? ' (' + game.name(ch.cards[0]) + ')' : ''}.`); break;
      case 'Behold': for (const c of ch.cards) paid.Revealed.push(c); game.log(`${p.name} beholds ${ch.cards.map(c => game.name(c)).join(', ')}.`); break;
      case 'PutCardToLibFromBattlefield': for (const c of ch.cards) await game.moveCard(c, 'library', { cause: sa, pos: part.libPos === '-1' ? 'bottom' : 'top' }); break;
      case 'RevealChosen': if (host.chosen && host.chosen.player != null) { host.chosenRevealed = true; game.log(`${p.name} reveals the chosen player: ${game.players[host.chosen.player].name}.`); } break;
      case 'Return': for (const c of ch.cards) await game.moveCard(c, 'hand', { cause: sa }); break;
      case 'tapXType': case 'Crew': for (const c of ch.cards) { paid.Tapped.push(c); await game.tap(c); } if (part.type === 'Crew') game.fire('BecomesCrewed', { Card: host, Crew: ch.cards }); break;
      case 'untapYType': for (const c of ch.cards) await game.untap(c); break;
      case 'Reveal': for (const c of ch.cards) paid.Revealed.push(c); game.log(`${p.name} reveals ${ch.cards.map(c => game.name(c)).join(', ')}.`); break;
      case 'SubCounter': {
        let left = ch.n;
        for (const c of ch.cards) { if (left <= 0) break; left -= await game.removeCounters(c, ch.counter, left); }
        if (ch.counter === 'LOYALTY') sa.root().loyaltyCost = -ch.n;
        break;
      }
      case 'RemoveAnyCounter': {
        let left = ch.n;
        for (const c of ch.cards) for (const k of Object.keys(c.counters)) { if (left <= 0) break; left -= await game.removeCounters(c, k, left); }
        break;
      }
      case 'AddCounter': { const n = ch.n; await game.addCounters(host, normalizeCounterName(part.counter), n, sa); if (normalizeCounterName(part.counter) === 'LOYALTY') sa.root().loyaltyCost = n; break; }
      case 'PayLife': { const n = ch.n; p.life -= n; p.lifeLostThisTurn += n; game.touch(); game.log(`${p.name} pays ${n} life.`); game.fire('LifeLost', { Player: pid, LifeAmount: n }); paid.LifePaid = n; break; }
      case 'PayEnergy': p.counters.ENERGY = Math.max(0, (p.counters.ENERGY || 0) - ch.n); game.touch(); break;
      case 'Mill': await game.mill(p, ch.n, sa); break;
      case 'Draw': await game.drawCards(p, ch.n, sa); break;
      case 'Exert': host.exertedTurn = game.turnNumber; host.skipNextUntap = true; game.fire('Exerted', { Card: host, Player: pid }); break;
      case 'Unattach': break;
      default: break;
    }
  }
}

// ---------------------------------------------------------------- mana sources & payment
export function manaAbilitiesOf(game, card) {
  return game.chars(card).abilities.filter(a => (a.parsed.api === 'Mana' || a.parsed.api === 'ManaReflected') && a.parsed.kind === 'AB');
}

function reflectedColors(game, card, abil) {
  const p = abil.parsed.p;
  const ctx = { host: card, you: card.controller };
  const out = new Set();
  const pool = game.battlefield.filter(c => matchValid(game, c, p.Valid || 'Land.OppCtrl', ctx));
  for (const c of pool) {
    for (const a of game.chars(c).abilities) {
      if (a.parsed.api !== 'Mana') continue;
      for (const u of producedUnits(game, c, a, true)) for (const col of u) out.add(col);
    }
  }
  if (p.ColorOrType !== 'Type') out.delete('C');
  return [...out];
}

export function producedUnits(game, card, abil, noReflect = false) {
  const p = abil.parsed.p;
  if (abil.parsed.api === 'ManaReflected') {
    if (noReflect) return [];
    const cols = reflectedColors(game, card, abil);
    return cols.length ? [cols] : [];
  }
  let produced = p.Produced || 'C';
  const pid = card.controller;
  if (produced.includes('ColorIdentity')) {
    const ci = game.players[pid].colorIdentity;
    produced = produced.replace('ColorIdentity', ci.join(' '));
    if (!ci.length) return [];
  }
  if (produced.includes('Chosen')) {
    const cols = (card.chosen && card.chosen.colors) || [];
    produced = produced.replace('Chosen', cols.join(' ') || '');
  }
  if (produced === 'Combo Any' || produced === 'Any' || produced === 'AnyDifferent') produced = 'Any';
  // "for each color among permanents you control, add one mana of that color" (Faeburrow Elder)
  const each = produced.match(/^Special EachColorAmong_Valid (.+)$/);
  if (each) {
    const cols = new Set();
    for (const c of game.battlefield) if (matchValid(game, c, each[1], { host: card, you: pid })) for (const x of game.chars(c).colors) cols.add(x);
    return COLORS.filter(x => cols.has(x)).map(x => [x]);
  }
  let units = manaColorsFromProduced(produced);
  if (p.Amount) {
    const ctx = { host: card, you: pid, svars: abil.svars, sa: { svars: abil.svars, host: card, controller: pid, root() { return { x: 0, paid: {} }; } } };
    const n = calcCtx(game, p.Amount, ctx);
    if (units.length === 1) units = Array.from({ length: Math.max(0, n) }, () => units[0]);
    else { const base = units; units = []; for (let i = 0; i < n; i++) units.push(...base); }
  }
  return replaceProducedUnits(game, card, units); // Contamination, Damping Sphere (mech-params.js)
}

// can mana from `host` be spent here? RestrictValid says what it can pay for: spells ("Spell.Creature",
// "Spell.Instant,Spell.Sorcery"), activated abilities ("Activated", "Activated.Dragon+inZoneBattlefield") or, for
// Powerstones, anything but a nonartifact spell. spellCard: the spell being cast; abilityHost: the permanent whose
// activated ability is being paid for; costHasX: that ability's cost has {X} (Nexos, Elementalist's Palette:
// "spend this mana only on costs that contain {X}"). Neither (tapping a source by hand): restricted mana stays put.
function restrictionAllows(game, host, restrict, pid, { spellCard = null, abilityHost = null, costHasX = false }) {
  const ctx = { host, you: pid };
  if (restrict === 'CantCastNonArtifactSpells') return spellCard ? game.chars(spellCard).types.has('Artifact') : !!abilityHost;
  if (restrict === 'CostContainsX') return spellCard ? !!game.chars(spellCard).manaCost?.x : !!abilityHost && costHasX;
  if (restrict === 'CantPayGenericCosts') return !!(spellCard || abilityHost); // Jegantha: the planner keeps it off generic mana
  if (spellCard) {
    // "Spell.Creature": the spell's own characteristics, wherever it is cast from (it only moves to the stack
    // once its costs are paid)
    return restrict.split(',').some(r => {
      if (r === 'Spell') return true;
      if (!r.startsWith('Spell.')) return false;
      if (r === 'Spell.wasCastFromYourGraveyard') return (spellCard.zone === 'stack' ? spellCard.castFrom : spellCard.zone) === 'graveyard' && spellCard.owner === pid;
      return matchValid(game, spellCard, 'Card.' + r.slice(6), ctx);
    });
  }
  if (!abilityHost) return false;
  return restrict.split(',').some(r => r === 'Activated' || (r.startsWith('Activated.') && matchValid(game, abilityHost, 'Card.' + r.slice(10), ctx)));
}

export function manaSourcesFor(game, pid, { exclude = new Set(), spellCard = null, abilityHost = null, costHasX = false } = {}) {
  const out = [];
  for (const card of game.battlefield) {
    if (card.controller !== pid || exclude.has(card.id) || card.phasedOut) continue;
    const ch = game.chars(card);
    const isCreature = ch.types.has('Creature');
    for (const abil of manaAbilitiesOf(game, card)) {
      const p = abil.parsed.p;
      const cost = parseCost(p.Cost);
      if (cost.tap && (card.tapped || (isCreature && card.sick && !game.hasKeywordIn(ch, 'Haste')))) continue;
      if (cost.untap) continue;
      // only simple extra costs
      let penalty = ch.types.has('Land') ? 0 : isCreature ? (card.isCommander ? 8 : 3) : 1;
      let ok = true, manualOnly = false;
      for (const part of cost.parts) {
        if (part.type === 'Sac' && (part.valid === 'CARDNAME' || part.valid === 'Card.Self')) penalty += 20;
        else if (part.type === 'PayLife') penalty += 2;
        else if (part.type === 'Sac' && game.battlefield.filter(c => c.controller === pid && matchValid(game, c, part.valid, { host: card, you: pid })).length >= (+part.amount || 1)) manualOnly = true; // "Sacrifice a Goblin: Add {R}"
        else ok = false;
      }
      if (!ok) continue;
      if (p.RestrictValid && !restrictionAllows(game, card, p.RestrictValid, pid, { spellCard, abilityHost, costHasX })) continue;
      if (p.ActivationLimit && (card.abilityUses[abil.key] || 0) >= +p.ActivationLimit) continue;
      if (!checkPresence(game, p, { host: card, you: pid, svars: abil.svars, sa: { svars: abil.svars, host: card, controller: pid, root() { return { x: 0, paid: {} }; } } })) continue;
      if (p.SubAbility) penalty += 1.5;
      const units = producedUnits(game, card, abil);
      if (!units.length) continue;
      const extra = cost.hasMana ? cost.mana : null;
      if (extra) penalty += 1;
      if (!cost.tap && !cost.parts.length && !extra) continue; // free mana abilities with no cost: ignore
      // manualOnly: tapped by hand only (it sacrifices another permanent, which automatic payment never does)
      out.push({ key: card.id + ':' + abil.key, card, abil, units, penalty, extraCost: extra, manualOnly, noGeneric: p.RestrictValid === 'CantPayGenericCosts', excl: cost.tap ? 'tap' + card.id : null, sig: card.def.name + '|' + abil.key + '|' + units.map(u => u.join('')).join(',') + (card.tapped ? 't' : '') });
    }
  }
  // a Signet or filter land is only a source if its own {1} / {W/U} can be paid (from the pool or other sources)
  if (!out.some(s => s.extraCost)) return out;
  const pool = game.players[pid].pool;
  const plain = out.filter(s => !s.extraCost && !s.manualOnly);
  return out.filter(s => !s.extraCost || payFromPool(s.extraCost, pool) || planPayment(s.extraCost, pool, plain.filter(x => x.card !== s.card), { lifeAvailable: 0, maxNodes: 4000 }));
}

function surplusPay(pool, cost, reserve, produced = []) {
  // pay a (filter) cost from the pool while keeping colors the pending main cost needs: try the ways of
  // paying it and keep one after which the rest is still payable; else fall back to a heuristic
  if (reserve) {
    const ways = [];
    const seen = new Set();
    const go = (p, hyb, gen) => {
      if (ways.length >= 64) return;
      if (hyb.length) { for (const c of new Set(hyb[0])) if (p[c] > 0) go({ ...p, [c]: p[c] - 1 }, hyb.slice(1), gen); return; }
      if (gen > 0) { for (const c of ['C', 'W', 'U', 'B', 'R', 'G']) if (p[c] > 0) go({ ...p, [c]: p[c] - 1 }, hyb, gen - 1); return; }
      const k = JSON.stringify(p);
      if (!seen.has(k)) { seen.add(k); ways.push(p); }
    };
    const start = { ...pool };
    let ok = true;
    for (const k of ['W', 'U', 'B', 'R', 'G', 'C']) { const n = cost.colored[k] || 0; if ((start[k] || 0) < n) ok = false; else start[k] = (start[k] || 0) - n; }
    if (ok) go(start, cost.hybrid || [], cost.generic || 0);
    for (const w of ways) {
      const fin = { ...w };
      for (const c of produced) fin[c] = (fin[c] || 0) + 1;
      if (payFromPool(reserve, fin)) return w;
    }
  }
  const need = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  if (reserve) { for (const k in need) need[k] = reserve.colored[k] || 0; for (const h of reserve.hybrid) for (const k of h) need[k] += 0.5; }
  for (const c of produced) need[c] = (need[c] || 0) - 1;
  const p = { ...pool };
  for (const k of ['W', 'U', 'B', 'R', 'G', 'C']) { const n = cost.colored[k] || 0; if (p[k] < n) return null; p[k] -= n; }
  for (const h of cost.hybrid) { const c = h.filter(x => p[x] > 0).sort((a, b) => (p[b] - need[b]) - (p[a] - need[a]))[0]; if (!c) return null; p[c]--; }
  for (let i = 0; i < cost.generic; i++) {
    const c = ['C', 'W', 'U', 'B', 'R', 'G'].filter(x => p[x] > 0).sort((a, b) => (p[b] - need[b]) - (p[a] - need[a]))[0];
    if (!c) return null;
    p[c]--;
  }
  return p;
}

export async function produceMana(game, card, abil, colors, pid, reserve = null, { sacrifice = [] } = {}) {
  const p = abil.parsed.p;
  const cost = parseCost(p.Cost);
  const player = game.players[pid];
  if (cost.tap && card.tapped) return false;
  // pay a mana cost (Signets, filter lands) before tapping: if it can't be paid, nothing happens
  let np = null;
  if (cost.hasMana) { np = surplusPay(player.pool, cost.mana, reserve, colors); if (!np) return false; }
  if (cost.tap) { card.tapped = true; game.touch(); }
  if (cost.tap && game.chars(card).types.has('Land')) player.landManaTurn = game.turnNumber; // (Desolation)
  if (np) player.pool = np;
  for (const part of cost.parts) {
    if (part.type === 'Sac') {
      if (!part.valid || /^(CARDNAME|Card\.Self)$/.test(part.valid)) await game.sacrifice(card, null);
      else for (const c of sacrifice) await game.sacrifice(c, null);
    }
    if (part.type === 'PayLife') { const n = +part.amount || 1; player.life -= n; player.lifeLostThisTurn += n; }
  }
  // "if you tap a permanent for mana, it produces twice as much of that mana instead"
  let mult = 1;
  if (cost.tap) for (const { r, p: rp, ctx } of game.replacementsFor('ProduceMana')) {
    if (rp.ValidActivator && !matchValid(game, player, rp.ValidActivator, ctx)) continue;
    if (rp.ValidCard && !matchValid(game, card, rp.ValidCard, ctx)) continue;
    const w = rp.ReplaceWith && r.svars[rp.ReplaceWith];
    if (w) mult *= +(parseAbility(w).p.ReplaceAmount || 1);
  }
  for (const c of colors) player.pool[c] = (player.pool[c] || 0) + mult;
  card.abilityUses[abil.key] = (card.abilityUses[abil.key] || 0) + 1;
  game.touch();
  // sub-abilities (pain lands, talismans)
  if (p.SubAbility && abil.svars[p.SubAbility]) {
    const sub = makeSA(game, abil.svars[p.SubAbility], abil.svars, card, pid);
    await resolveChain(game, sub);
  }
  if (cost.tap) game.fire('Taps', { Card: card, Player: pid });
  game.fire('TapsForMana', { Card: card, Player: pid, Produced: colors.join(' '), Amount: colors.length });
  // triggered mana abilities (mana doublers) resolve immediately
  await resolveManaTriggers(game);
  return true;
}

async function resolveManaTriggers(game) {
  const keep = [];
  for (const pt of game.pendingTriggers) {
    if (pt.rp && pt.rp.Mode === 'TapsForMana') {
      const raw = pt.t.svars && pt.t.svars[pt.t.parsed.p.Execute];
      if (raw && /Mana(Reflected)?\b/.test(parseAbility(raw).api || '')) {
        const sa = makeSA(game, raw, pt.t.svars, pt.host, pt.controller, { trig: pt.rp });
        await resolveChain(game, sa);
        continue;
      }
    }
    keep.push(pt);
  }
  game.pendingTriggers = keep;
}

export async function activateManaAbility(game, pid, card, abilityKey, color) {
  if (!card || card.controller !== pid) return false;
  const abil = manaAbilitiesOf(game, card).find(a => a.key === abilityKey) || manaAbilitiesOf(game, card)[0];
  if (!abil) return false;
  const src = manaSourcesFor(game, pid).find(s => s.card === card && s.abil.key === abil.key);
  if (!src) return false;
  // "{1}, {T}: Add {U}{R}": with the {1} not floating yet, tap other sources for it first
  if (src.extraCost && !payFromPool(src.extraCost, game.players[pid].pool) && !(await floatManaFor(game, pid, src.extraCost, new Set([card.id])))) return false;
  let sacrifice = [];
  if (src.manualOnly) {
    const part = parseCost(abil.parsed.p.Cost).parts.find(pt => pt.type === 'Sac' && !/^(CARDNAME|Card\.Self)$/.test(pt.valid || ''));
    const n = +part.amount || 1;
    const cands = game.battlefield.filter(c => c.controller === pid && matchValid(game, c, part.valid, { host: card, you: pid }));
    if (cands.length < n) return false;
    const ids = cands.length === n ? cands.map(c => c.id) : await game.ask(pid, { type: 'cards', prompt: `${game.name(card)}: sacrifice ${n} ${part.desc || humanValid(part.valid)} for mana`, cards: cands.map(c => c.id), min: n, max: n, purpose: 'costSac', cancellable: true });
    if (ids == null) throw new Cancelled();
    sacrifice = ids.map(id => game.cardById(id)).filter(Boolean);
  }
  let colors = src.units.map(u => u[0]);
  if (src.units.some(u => u.length > 1)) {
    colors = [];
    for (const u of src.units) {
      if (u.length === 1) { colors.push(u[0]); continue; }
      let c = color && u.includes(color) ? color : null;
      if (!c) c = await game.ask(pid, { type: 'color', prompt: `Choose a color of mana to add (${game.name(card)})`, colors: u, purpose: 'mana', cancellable: true });
      if (!c) throw new Cancelled();
      colors.push(c);
    }
  }
  await produceMana(game, card, abil, colors, pid, null, { sacrifice });
  game.log(`${game.players[pid].name} taps ${game.name(card)} for ${colors.map(c => `{${c}}`).join('')}.`, { type: 'mana' });
  return true;
}

// put enough mana in the pool to pay a cost (without paying it), using the player's other sources
async function floatManaFor(game, pid, cost, exclude) {
  const p = game.players[pid];
  const sources = manaSourcesFor(game, pid, { exclude }).filter(s => !s.extraCost && !s.manualOnly);
  const plan = planPayment(cost, p.pool, sources, { lifeAvailable: 0 });
  if (!plan) return false;
  const byKey = new Map(sources.map(s => [s.key, s]));
  for (const a of plan.activations) { const s = byKey.get(a.key); if (s) await produceMana(game, s.card, s.abil, a.colors, pid, cost); }
  return !!payFromPool(cost, p.pool);
}

// Additional payment sources for convoke / improvise
function alternativeSources(game, pid, card, exclude, face) {
  const out = [];
  // (printed, or given to the spell: Chief Engineer's convoke, Inspiring Statuary's improvise)
  const ch = card.zone === 'stack' ? game.chars(card) : { keywords: castKeywords(game, pid, card, face || card.faceDef, card.zone) };
  const convoke = game.hasKeywordIn(ch, 'Convoke');
  const improvise = game.hasKeywordIn(ch, 'Improvise');
  if (!convoke && !improvise) return out;
  for (const c of game.battlefield) {
    if (c.controller !== pid || c.tapped || exclude.has(c.id)) continue;
    const cc = game.chars(c);
    if (convoke && cc.types.has('Creature')) {
      const cols = [...cc.colors];
      out.push({ key: 'convoke:' + c.id, card: c, convoke: true, units: [cols.length ? [...cols, 'C'] : ['C']], penalty: 6, sig: 'cv' + c.id, excl: 'tap' + c.id });
    } else if (improvise && cc.types.has('Artifact')) {
      out.push({ key: 'improvise:' + c.id, card: c, improvise: true, units: [['C']], penalty: 5, sig: 'im' + c.id, excl: 'tap' + c.id });
    }
  }
  return out;
}

// what a filter source at position i of a payment sequence must not spend on its own cost: mana the spell
// still needs after counting what later activations add, and mana later filter sources need for theirs
function reserveFor(manaCost, seq, i) {
  const r = cloneCost(manaCost);
  // what later activations add covers a colored symbol, else a hybrid one, else generic
  for (const { a } of seq.slice(i + 1)) for (const c of a.colors) {
    if (r.colored[c] > 0) { r.colored[c]--; continue; }
    const h = r.hybrid.findIndex(x => x.includes(c));
    if (h >= 0) { r.hybrid = r.hybrid.filter((_, j) => j !== h); continue; }
    if (r.generic > 0) r.generic--;
  }
  for (const { s } of seq.slice(i + 1)) if (s.extraCost) {
    for (const [k, n] of Object.entries(s.extraCost.colored)) r.colored[k] = (r.colored[k] || 0) + n;
    r.hybrid = [...r.hybrid, ...s.extraCost.hybrid];
  }
  return r;
}

// Plan + pay a mana cost for player pid. Returns true when paid. No state change when it fails.
export async function payManaCost(game, pid, manaCost, { exclude = new Set(), spellCard = null, abilityHost = null, costHasX = false, sa = null, dryRun = false } = {}) {
  const p = game.players[pid];
  if (cmc(manaCost) === 0 && !manaCost.x) return true;
  let sources = manaSourcesFor(game, pid, { exclude, spellCard, abilityHost, costHasX }).filter(s => !s.manualOnly);
  if (spellCard) sources = sources.concat(alternativeSources(game, pid, spellCard, exclude, sa && spellCard.def.faces[sa.face || 0]));
  const plan = planPayment(manaCost, p.pool, sources, { lifeAvailable: p.life - 1 });
  if (!plan) return false;
  if (dryRun) return true;
  const byKey = new Map(sources.map(s => [s.key, s]));
  let acts = plan.activations.map(a => ({ a, s: byKey.get(a.key) }));
  // non-filter sources first
  acts.sort((x, y) => (x.s.extraCost ? 1 : 0) - (y.s.extraCost ? 1 : 0));
  // filter sources in an order that works when played out (each pays its own cost from what's floating)
  const filt = acts.filter(x => x.s.extraCost);
  if (filt.length > 1) {
    const plainActs = acts.filter(x => !x.s.extraCost);
    const works = seq => {
      let pool = { ...p.pool };
      for (const [i, { a, s }] of seq.entries()) {
        if (s.extraCost) { const np = surplusPay(pool, s.extraCost, reserveFor(manaCost, seq, i), a.colors); if (!np) return false; pool = np; }
        for (const c of a.colors) pool[c] = (pool[c] || 0) + 1;
      }
      return !!payFromPool(manaCost, pool, { lifeAvailable: p.life - 1 });
    };
    const perms = [];
    const permute = (rest, pre) => { if (perms.length > 120) return; if (!rest.length) { perms.push(pre); return; } rest.forEach((x, i) => permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...pre, x])); };
    permute(filt, []);
    const good = perms.find(pm => works([...plainActs, ...pm]));
    if (good) acts = [...plainActs, ...good];
  }
  const tapped = [];
  // what a filter source (Signet, Opal Palace) pays its own {1} with must not be mana the spell still needs
  // after counting what the activations after it will add
  const reserveAt = (i) => reserveFor(manaCost, acts, i);
  for (const [i, { a, s }] of acts.entries()) {
    if (s.convoke || s.improvise) {
      s.card.tapped = true; game.touch();
      for (const c of a.colors) p.pool[c] = (p.pool[c] || 0) + 1;
      if (spellCard) spellCard.convokedBy = [...(spellCard.convokedBy || []), s.card.id];
      game.fire('Taps', { Card: s.card });
      continue;
    }
    if (spellCard && sa && game.chars(s.card).subtypes.has('Treasure')) sa.root().manaFromTreasure = true; // (Rain of Riches)
    // where the mana came from: "if mana from an artifact was spent to cast it", "spent mana from this to cast"
    if (sa) { const sch = game.chars(s.card); (sa.root().manaFrom = sa.root().manaFrom || []).push({ id: s.card.id, n: a.colors.length, artifact: sch.types.has('Artifact'), creature: sch.types.has('Creature') }); }
    await produceMana(game, s.card, s.abil, a.colors, pid, s.extraCost ? reserveAt(i) : manaCost);
    tapped.push(s.card);
    // the table can pace a computer player's taps one at a time (never changes the game)
    if (game.pace) await game.pace('tap', pid);
  }
  const r = payFromPool(manaCost, p.pool, { lifeAvailable: p.life - 1 });
  if (!r) {
    // should not happen; leave mana floating
    game.log('Mana payment failed unexpectedly; mana left in pool.', { type: 'error', detail: JSON.stringify({ cost: manaCost, pool: p.pool, acts: acts.map(x => [x.s.card.def.name, x.a.colors]) }) });
    if (game.debugMana) console.log('MANA FAIL', JSON.stringify({ cost: manaCost, pool: p.pool, acts: acts.map(x => [x.s.card.def.name, x.a.colors, x.s.key, x.s.excl, x.s.extraCost, x.s.units]) }), JSON.stringify(sources.map(s => [s.key, s.excl, s.units, s.extraCost])));
    return false;
  }
  const spent = {};
  for (const k of Object.keys(p.pool)) { const d = p.pool[k] - r.pool[k]; if (d > 0) spent[k] = d; }
  p.pool = r.pool;
  if (r.life) { p.life -= r.life; p.lifeLostThisTurn += r.life; }
  if (sa) { sa.root().manaSpent = spent; if (r.life) sa.root().phyrexianLife = Math.floor(r.life / 2); }
  game.touch();
  if (tapped.length) game.log(`${p.name} taps ${tapped.map(c => game.name(c)).join(', ')}.`, { type: 'mana', quiet: true });
  return true;
}

export function canAfford(game, pid, manaCost, opts = {}) {
  const p = game.players[pid];
  if (cmc(manaCost) === 0) return true;
  let sources = manaSourcesFor(game, pid, opts).filter(s => !s.manualOnly);
  if (opts.spellCard) sources = sources.concat(alternativeSources(game, pid, opts.spellCard, opts.exclude || new Set()));
  return !!planPayment(manaCost, p.pool, sources, { lifeAvailable: p.life - 1, maxNodes: 8000 });
}

export function availableManaCount(game, pid, spellCard = null, opts = {}) {
  const p = game.players[pid];
  let n = poolTotal(p.pool);
  const best = new Map();
  for (const s of manaSourcesFor(game, pid, { spellCard, ...opts })) {
    if (s.manualOnly) continue;
    const v = s.units.length - (s.extraCost ? cmc(s.extraCost) : 0);
    const k = s.excl || s.key;
    best.set(k, Math.max(best.get(k) || 0, v));
  }
  for (const v of best.values()) n += v;
  if (spellCard) n += alternativeSources(game, pid, spellCard, new Set()).length;
  return n;
}

// ---------------------------------------------------------------- targeting
function normValidTgts(v) {
  return String(v).split(',').map(s => s.trim()).flatMap(s => s === 'Any' ? ['Creature', 'Planeswalker', 'Battle', 'Player'] : s.startsWith('Any.') ? ['Creature' + s.slice(3), 'Planeswalker' + s.slice(3), 'Player'] : [s]).join(',');
}

export function targetSpec(game, sa) {
  const p = sa.p;
  if (!p.ValidTgts && !p.TargetType) return null;
  const ctx = ctxOf(game, sa);
  const spec = {
    valid: normValidTgts(p.ValidTgts || 'Card'),
    min: p.TargetMin != null ? Math.max(0, calcCtx(game, p.TargetMin, ctx)) : 1,
    max: p.TargetMax != null ? Math.max(0, calcCtx(game, p.TargetMax, ctx)) : 1,
    stack: !!(p.TargetType && /Spell|Activated|Triggered|SpellAbility/.test(p.TargetType)),
    stackTypes: p.TargetType || '',
    zone: p.TgtZone ? p.TgtZone.split(',').map(z => zoneMap[z] || z.toLowerCase())
      : (sa.api === 'ChangeZone' && p.Origin && !/Battlefield|Any/.test(p.Origin)) ? p.Origin.split(',').map(z => zoneMap[z] || z.toLowerCase()) : ['battlefield'],
    prompt: p.TgtPrompt || p.SpellDescription || 'Choose targets',
    unique: p.TargetUnique === 'True',
    differentControllers: p.TargetsWithDifferentControllers === 'True' || p.TargetsForEachPlayer === 'True',
    sameController: p.TargetsWithSameController === 'True',
    divided: p.DividedAsYouChoose,
  };
  if (p.TargetMin == null && p.TargetMax != null && spec.max > 1 && p.TargetMax !== '1') spec.min = Math.min(1, spec.max);
  if (p.TargetMax === 'MaxTgts' || p.TargetMax === 'OneEach') spec.max = game.livingPlayers().length;
  if (p.TargetsForEachPlayer === 'True' && p.TargetMax == null) spec.max = game.opponents(sa.controller).length;
  if (spec.max < spec.min) spec.max = spec.min;
  return spec;
}

export function canBeTargetedBy(game, obj, sa) {
  if (!obj) return false;
  const you = sa.controller;
  if (obj.isPlayer) {
    if (obj.lost) return false;
    const pc = game.playerChars(obj.id);
    if (pc.keywords.includes('Shroud')) return false;
    if (pc.keywords.includes('Hexproof') && obj.id !== you) return false;
    if (sa.host && obj.id !== you && game.playerProtectedFrom(obj, sa.host)) return false;
    return true;
  }
  if (obj.stackItem) return true;
  if (obj.zone !== 'battlefield') return true;
  const ch = game.chars(obj);
  if (game.hasKeywordIn(ch, 'Shroud')) return false;
  if (obj.controller !== you) {
    for (const k of ch.keywords) {
      if (k === 'Hexproof') return false;
      if (k.startsWith('Hexproof:')) {
        const v = k.split(':')[1];
        if (sa.host && matchValid(game, sa.host, v, { host: obj, you: obj.controller })) return false;
      }
      if (k === 'Hexproof from everything') return false;
    }
  }
  if (sa.host && game.hasProtectionFrom(obj, sa.host)) return false;
  for (const s of game.activeStatics('CantTarget')) {
    if (s.p.ValidCard && !matchValid(game, obj, s.p.ValidCard, s.ctx)) continue;
    if (s.p.ValidSource && !(sa.host && matchValid(game, sa.host, s.p.ValidSource, s.ctx))) continue;
    if (s.p.Activator && !matchValid(game, game.players[you], s.p.Activator, s.ctx)) continue;
    return false;
  }
  if (game.hasKeywordIn(ch, "CARDNAME can't be the target of spells or abilities your opponents control.") && obj.controller !== you) return false;
  return true;
}

export function targetCandidates(game, sa, spec) {
  const ctx = ctxOf(game, sa);
  const out = [];
  if (spec.stack) {
    for (const item of game.stack) {
      if (item.sa === sa || (sa.stackItem && item === sa.stackItem)) continue;
      const isSpell = item.kind === 'spell';
      if (isSpell && !/Spell/.test(spec.stackTypes)) continue;
      if (!isSpell && item.kind === 'ability' && !/Activated|SpellAbility/.test(spec.stackTypes)) continue;
      if (!isSpell && item.kind === 'trigger' && !/Triggered|SpellAbility/.test(spec.stackTypes)) continue;
      const card = item.card || item.source;
      const valid = spec.valid.replace(/\bPlayer\b/g, '');
      if (card && (valid === 'Card' || matchValid(game, card, valid, { ...ctx, stackController: item.controller }))) out.push(item);
      else if (!card) out.push(item);
    }
    return paramTargetFilter(game, sa, out); // "that targets you or a creature you control" (mech-params.js)
  }
  const hasPlayers = /(^|,)(Player|Opponent|You)/.test(spec.valid);
  for (const z of spec.zone) {
    const pool = z === 'battlefield' ? game.battlefield : game.cardsInZone(z);
    for (const c of pool) {
      if (c.phasedOut) continue;
      if (matchValid(game, c, spec.valid, ctx) && canBeTargetedBy(game, c, sa)) out.push(c);
    }
  }
  if (hasPlayers) for (const pl of game.livingPlayers()) if (matchValid(game, pl, spec.valid, ctx) && canBeTargetedBy(game, pl, sa)) out.push(pl);
  return paramTargetFilter(game, sa, out); // "target creature that player controls" (mech-params.js)
}

export async function chooseTargetsForSA(game, root, { optional = false, aiHint = null } = {}) {
  const chain = root.chain();
  const chosenAll = [];
  for (const sa of chain) {
    const spec = targetSpec(game, sa);
    if (!spec) continue;
    let cands = targetCandidates(game, sa, spec);
    if (spec.unique) cands = cands.filter(c => !chosenAll.includes(c));
    if (cands.length < spec.min) {
      if (spec.min === 0) { sa.targets = []; continue; }
      return false;
    }
    if (spec.max === 0) { sa.targets = []; continue; }
    // dividing N among targets: at most N targets (each gets at least 1)
    const divTotal = spec.divided ? calcCtx(game, spec.divided, ctxOf(game, sa)) : Infinity;
    const max = Math.min(spec.max, cands.length, sa.targetCap ?? Infinity, Math.max(spec.min, divTotal));
    // only a spell or ability being cast or activated can be backed out of; triggers and resolving effects can't
    const cancellable = !optional && !root.isTrigger && !sa.isTrigger;
    const ans = await game.ask(sa.controller, { type: 'targets', prompt: (spec.prompt || '').replace(/CARDNAME/g, game.name(sa.host)), cands: cands.map(refOf), min: spec.min, max, sa, spec, cancellable });
    if (ans == null) { if (cancellable) throw new Cancelled(); if (spec.min > 0) return false; sa.targets = []; continue; }
    let objs = ans.map(r => fromRef(game, r)).filter(o => o && cands.includes(o)).filter((o, i, a) => a.indexOf(o) === i).slice(0, max);
    if (objs.length < spec.min) { if (!cancellable) return false; throw new Cancelled(); }
    if (spec.differentControllers) {
      const seen = new Set(); objs = objs.filter(o => { const c = o.isPlayer ? o.id : ctrlOf(game, o); if (seen.has(c)) return false; seen.add(c); return true; });
    }
    sa.targets = objs;
    sa.targetZcc = objs.map(o => (o.isCard ? o.zcc : null));
    sa.hadTargets = objs.length > 0;
    chosenAll.push(...objs);
    if (spec.divided) {
      // "divided as you choose": each target gets at least 1
      const total = calcCtx(game, spec.divided, ctxOf(game, sa));
      if (objs.length > 1 && total > objs.length) {
        const div = [];
        let left = total;
        for (let i = 0; i < objs.length - 1; i++) {
          const targetsLeft = objs.length - i;
          const n = await game.ask(sa.controller, { type: 'number', prompt: `Divide ${total}: how much for ${game.name(objs[i])}? (${left} left for ${targetsLeft} targets)`, min: 1, max: left - (targetsLeft - 1), purpose: 'divide', sa, left, targetsLeft, target: refOf(objs[i]) });
          div.push(n); left -= n;
        }
        div.push(left);
        sa.division = div;
      } else sa.division = divideEvenly(total, objs.length);
    }
  }
  return true;
}

function divideEvenly(total, n) {
  if (!n) return [];
  const base = Math.floor(total / n);
  const out = Array(n).fill(base);
  for (let i = 0; i < total - base * n; i++) out[i]++;
  return out;
}

// Re-validate targets on resolution; returns false if the whole thing fizzles.
export function recheckTargets(game, root) {
  let had = 0, legalAny = 0;
  for (const sa of root.chain()) {
    if (!sa.targets || !sa.targets.length) continue;
    had++;
    const spec = targetSpec(game, sa);
    if (!spec) continue;
    const ctx = ctxOf(game, sa);
    const kept = [];
    sa.targets.forEach((t, i) => {
      if (t.isPlayer) { if (!t.lost && matchValid(game, t, spec.valid, ctx) && canBeTargetedBy(game, t, sa)) kept.push(t); return; }
      if (t.stackItem) { if (game.stack.includes(t)) kept.push(t); return; }
      if (sa.targetZcc && sa.targetZcc[i] != null && t.zcc !== sa.targetZcc[i]) return;
      if (!spec.zone.includes(t.zone)) return;
      if (!matchValid(game, t, spec.valid, ctx)) return;
      if (!canBeTargetedBy(game, t, sa)) return;
      kept.push(t);
    });
    if (sa.division && kept.length !== sa.targets.length) sa.division = sa.targets.map((t, i) => kept.includes(t) ? sa.division[i] : 0).filter((_, i) => kept.includes(sa.targets[i]));
    sa.targets = kept;
    if (kept.length) legalAny++;
  }
  return had === 0 || legalAny > 0;
}

// ---------------------------------------------------------------- casting
const PERMANENT = ['Artifact', 'Creature', 'Enchantment', 'Land', 'Planeswalker', 'Battle'];

function faceIsPermanent(face) { return face.types.some(t => PERMANENT.includes(t)); }

export function hasFlash(game, card, face) {
  if (face.types.includes('Instant')) return true;
  const ch = game.chars(card);
  if (game.hasKeywordIn(ch, 'Flash') || face.keywords.includes('Flash')) return true;
  return game.activeStatics('CastWithFlash').some(s => matchValid(game, card, s.p.ValidCard || 'Card', s.ctx) && (!s.p.Caster || matchValid(game, game.players[card.owner], s.p.Caster, s.ctx)) && staticTimeOk(game, s));
}

// "during combat" (Basandra), "during each opponent's end step" (Final-Word Phantom)
function staticTimeOk(game, s) {
  if (s.p.Phases && !phaseOk(game, s.p.Phases)) return false;
  if (s.p.PlayerTurn === 'Opponent' && !game.isOpponent(game.activePlayer, s.ctx.you)) return false;
  return true;
}

// "you may look at the top card of your library any time" (Vizier of the Menagerie, Augur of Autumn), "play with the
// top card of your library revealed" (Courser of Kruphix: everyone sees it)
export function canSeeTopOfLibrary(game, viewer, owner = viewer) {
  const top = game.players[owner].library[0];
  if (!top) return false;
  game.ensureChars();
  for (const { st, ctx } of game._activeStatics || []) {
    const p = st.parsed.p;
    if (!p.MayLookAt || !(p.AffectedZone || '').split(',').includes('Library')) continue;
    if (p.Affected && !matchValid(game, top, p.Affected, ctx)) continue;
    if (p.MayLookAt === 'Player' || ctx.you === viewer) return true;
  }
  return false;
}

export function mayPlayFrom(game, pid, card) {
  // Continuous statics with MayPlay$ that let you play this card from its current zone
  for (const { st, ctx } of game._activeStatics || []) {
    const p = st.parsed.p;
    if (!p.MayPlay) continue;
    if (p.MayPlayDontGrantZonePermissions === 'True') continue; // changes how, not where (As Foretold, Aluren): mech-params.js
    const zones = (p.AffectedZone || 'Battlefield').split(',').map(z => zoneMap[z] || z.toLowerCase());
    if (!zones.includes(card.zone)) continue;
    const who = ctx.you;
    if (p.Affected && !matchValid(game, card, p.Affected, ctx)) continue;
    if (p.AffectedDefined && !resolveDefined(game, p.AffectedDefined, ctx).some(x => x && x.id === card.id)) continue;
    const player = st.host.isEffect ? st.host.controller : who;
    if (player !== pid && !/Player|Opponent/.test(p.MayPlayPlayer || '')) continue;
    if (p.MayPlayLimit && mayPlayUsed(game, st) >= +p.MayPlayLimit) continue; // (each turn, per static)
    return { st, without: p.MayPlayWithoutManaCost === 'True', ignoreType: p.MayPlayIgnoreType === 'True', ignoreColor: p.MayPlayIgnoreColor === 'True' };
  }
  return null;
}

export function spellOptions(game, pid, card, { anyZone = false } = {}) {
  const opts = [];
  if (!card) return opts;
  const def = card.def;
  const zone = card.zone;
  let from = null;
  let mayPlay = null;
  if (anyZone && zone !== 'battlefield' && zone !== 'stack') from = zone;
  else if (zone === 'hand' && card.owner === pid) from = 'hand';
  else if (zone === 'command' && card.owner === pid && card.isCommander) from = 'command';
  else if (zone === 'exile' && card.onAdventure && card.owner === pid) from = 'adventure';
  else if (zone === 'exile' && card.foretold && card.owner === pid) from = 'foretold';
  else if (zone === 'exile' && card.plotted && card.plotted.zcc === card.zcc && card.owner === pid) from = 'plotted';
  else if (zone === 'graveyard' || zone === 'exile' || zone === 'library' || zone === 'hand') {
    game.ensureChars();
    mayPlay = mayPlayFrom(game, pid, card);
    if (mayPlay) from = zone;
  }
  const faces = def.faces;
  const pushFace = (fi, extra = {}) => {
    const face = faces[fi];
    if (!face) return;
    if (face.types.includes('Land')) {
      if (from === 'hand' || mayPlay) opts.push({ key: `land${fi}`, label: `Play ${face.name}`, land: true, face: fi, from });
      return;
    }
    const spAbils = face.abilities.map((raw, i) => ({ raw, i })).filter(a => /^SP\$/.test(a.raw));
    if (spAbils.length && !faceIsPermanent(face)) {
      for (const a of spAbils) opts.push({ key: `f${fi}a${a.i}`, label: `Cast ${face.name}${spAbils.length > 1 ? ' (' + (parseAbility(a.raw).p.SpellDescription || '').slice(0, 40) + ')' : ''}`, face: fi, abilIdx: a.i, from, ...extra });
    } else if (spAbils.length && face.subtypes.includes('Aura')) {
      opts.push({ key: `f${fi}a${spAbils[0].i}`, label: `Cast ${face.name}`, face: fi, abilIdx: spAbils[0].i, from, permanent: true, ...extra });
    } else {
      opts.push({ key: `f${fi}`, label: `Cast ${face.name}`, face: fi, permanent: true, from, ...extra });
    }
  };
  if (!from) {
    // flashback / escape / retrace from graveyard
    if (zone === 'graveyard' && card.owner === pid) {
      const f = faces[0];
      for (const k of castKeywords(game, pid, card, f, 'graveyard')) {
        let m;
        if ((m = k.match(/^Flashback:?(.*)$/))) { const raw = (m[1] || '').split(':')[0]; pushFace(0, { altCost: 'Flashback', altManaStr: ownCost(f, raw), from: 'graveyard', label: `Flashback ${f.name}` }); }
        if ((m = k.match(/^Escape:(.*)$/))) pushFace(0, { altCost: 'Escape', altManaStr: ownCost(f, m[1].split(':')[0]), from: 'graveyard', label: `Escape ${f.name}` });
        if (k === 'Retrace') pushFace(0, { altCost: 'Retrace', from: 'graveyard', extraCostStr: 'Discard<1/Land>', label: `Retrace ${f.name}` });
        if ((m = k.match(/^Jump-start$/))) pushFace(0, { altCost: 'Flashback', from: 'graveyard', extraCostStr: 'Discard<1/Card>', label: `Jump-start ${f.name}` });
        if ((m = k.match(/^Disturb:(.+)$/)) && faces[1]) pushFace(1, { altCost: 'Disturb', altManaStr: m[1].split(':')[0], from: 'graveyard', label: `Disturb ${f.name} (cast ${faces[1].name})` });
        if ((m = k.match(/^Harmonize:(.+)$/))) pushFace(0, { altCost: 'Harmonize', altManaStr: m[1].split(':')[0], from: 'graveyard', label: `Harmonize ${f.name}` });
        // mayhem: cast it from your graveyard for its mayhem cost if you discarded it this turn
        if ((m = k.match(/^Mayhem:(.+)$/)) && card.discarded && card.discarded.turn === game.turnNumber && card.discarded.zcc === card.zcc) pushFace(0, { altCost: 'Mayhem', altManaStr: m[1].split(':')[0], from: 'graveyard', label: `Mayhem ${f.name}` });
      }
      for (const o of opts) o.key = (o.altCost || 'g') + o.key;
    }
    return opts.map(o => ({ ...o, from: o.from || 'graveyard' }));
  }
  if (from === 'adventure') { pushFace(0); return opts; }
  if (from === 'plotted') {
    if (card.plotted.turn !== game.turnNumber) pushFace(0, { altCost: 'Plot', withoutMana: true, sorcery: true, label: `Cast ${faces[0].name} (plotted)` });
    return opts;
  }
  if (from === 'foretold') {
    const fk = faces[0].keywords.find(k => k.startsWith('Foretell:'));
    if (fk && card.foretoldTurn !== game.turnNumber) pushFace(0, { altCost: 'Foretell', altManaStr: fk.split(':').slice(1).join(':'), label: `Cast ${faces[0].name} (foretold)` });
    return opts;
  }
  const aftermath = def.altMode === 'Split' && faces[1] && faces[1].keywords.includes('Aftermath');
  if (aftermath) {
    if (from === 'hand') pushFace(0);
    return opts;
  }
  if (def.altMode === 'Split' || def.altMode === 'Adventure' || def.altMode === 'Modal' || def.altMode === 'Omen' || def.altMode === 'Prepare') {
    pushFace(0);
    if (from !== 'command') pushFace(1, def.altMode === 'Adventure' ? { adventure: true } : {});
  } else {
    pushFace(card.face && card.zone !== 'hand' ? card.face : 0);
  }
  // alternative costs from hand
  if (from === 'hand' || from === 'command') {
    const f = faces[0];
    const seenAlt = new Set();
    for (const k of castKeywords(game, pid, card, f, from)) {
      let m;
      // (the same cost twice, printed and granted, is one way to cast it)
      if (seenAlt.has(k)) continue;
      seenAlt.add(k);
      if ((m = k.match(/^Evoke:(.*)$/))) pushFace(0, { altCost: 'Evoke', altManaStr: ownCost(f, m[1].split(':')[0]), label: `Evoke ${f.name}` });
      if ((m = k.match(/^Dash:(.*)$/))) pushFace(0, { altCost: 'Dash', altManaStr: ownCost(f, m[1].split(':')[0]), label: `Dash ${f.name}` });
      // "Blitz:CardManaCost:Spell.Creature+cmcGE4": Henzie's, for creature spells with mana value 4 or greater
      if ((m = k.match(/^Blitz:([^:]*)(?::(.+))?$/)) && (!m[2] || !/^Spell\b/.test(m[2]) || castMatchesSpell(game, card, {}, m[2], { host: card, you: pid }))) pushFace(0, { altCost: 'Blitz', altManaStr: ownCost(f, m[1]), label: `Blitz ${f.name}` });
      if ((m = k.match(/^Overload:(.*)$/))) pushFace(0, { altCost: 'Overload', altManaStr: m[1].split(':')[0], label: `Overload ${f.name}` });
      if ((m = k.match(/^(Morph|Megamorph|Disguise):(.*)$/))) opts.push({ key: 'morph', label: `Cast ${f.name} face down (${m[1]})`, face: 0, permanent: true, faceDown: true, altManaStr: '3', altCost: 'Morph', from, disguise: m[1] === 'Disguise' });
      if ((m = k.match(/^Spectacle:(.*)$/)) && game.opponents(pid).some(o => o.lifeLostThisTurn > 0)) pushFace(0, { altCost: 'Spectacle', altManaStr: m[1], label: `Spectacle ${f.name}` });
      if ((m = k.match(/^Surge:(.*)$/)) && game.players[pid].spellsCastThisTurn.length > 0) pushFace(0, { altCost: 'Surge', altManaStr: m[1], label: `Surge ${f.name}` });
      if ((m = k.match(/^Impending:(\d+):(.+)$/))) pushFace(0, { altCost: 'Impending', altManaStr: m[2], label: `Cast ${f.name} for its impending cost` });
      if (k === 'MayFlashSac' && !game.canSorcery(pid)) pushFace(0, { mayFlash: true, flashSac: true, label: `Cast ${f.name} as though it had flash (sacrifice it at the next cleanup)` });
      if ((m = k.match(/^Awaken:(\d+):(.+)$/))) pushFace(0, { altCost: 'Awaken', altManaStr: m[2], awaken: +m[1], label: `Awaken ${m[1]} — ${f.name}` });
      if ((m = k.match(/^Emerge:(.*)$/))) pushFace(0, { altCost: 'Emerge', altManaStr: m[1].split(':')[0], label: `Emerge ${f.name} (sacrifice a creature)` });
      if ((m = k.match(/^Offering:(\w+)$/)) && game.battlefield.some(c => c.controller === pid && matchValid(game, c, m[1], { host: card, you: pid }))) pushFace(0, { altCost: 'Offering', offering: m[1], mayFlash: true, label: `Cast ${f.name} with offering (sacrifice a ${m[1]})` });
      if ((m = k.match(/^Prowl:(.*)$/)) && prowlReady(game, pid, card)) pushFace(0, { altCost: 'Prowl', altManaStr: m[1].split(':')[0], label: `Prowl ${f.name}` });
      // "you may cast this spell as though it had flash if you pay {2} more"
      if ((m = k.match(/^MayFlashCost:(.*)$/)) && !game.canSorcery(pid) && !hasFlash(game, card, f)) pushFace(0, { mayFlash: true, addCostStr: m[1], label: `Cast ${f.name} with flash (+${costLabel(m[1])})` });
    }
    // "You may pay X rather than pay this spell's mana cost"
    for (const st of f.statics) {
      const sp = parseAbility(st).p;
      if (sp.Mode !== 'AlternativeCost' || !sp.Cost) continue;
      if (sp.ValidSA && !/Spell(\.Self)?$/.test(sp.ValidSA)) continue;
      const ctx = { host: card, you: pid };
      if (!checkPresence(game, sp, ctx)) continue;
      pushFace(0, { altCost: 'Alternative', altManaStr: sp.Cost, label: `Cast ${f.name} (${(sp.Description || 'alternative cost').slice(0, 50)})` });
    }
  }
  // aftermath half from the graveyard
  if (zone === 'graveyard' && card.owner === pid && def.altMode === 'Split' && faces[1] && faces[1].keywords.includes('Aftermath')) {
    pushFace(1, { from: 'graveyard', altCost: 'Flashback', label: `Cast ${faces[1].name} (aftermath)` });
  }
  const seenKeys = new Set();
  for (const o of opts) { let k = (o.altCost ? o.altCost + ':' : '') + o.key; while (seenKeys.has(k)) k += "'"; seenKeys.add(k); o.key = k; }
  if (mayPlay && mayPlay.without) for (const o of opts) o.withoutMana = true;
  for (const o of opts) if (mayPlay) o.mayPlay = mayPlay;
  return mayPlayOptions(game, pid, card, opts, mayPlay); // alternative costs and flash from may-play statics (mech-params.js)
}

// prowl: you dealt combat damage to a player this turn with a creature that shares a creature type with the card
function prowlReady(game, pid, card) {
  const list = (game.turnState.prowl || {})[pid];
  if (!list || !list.length) return false;
  const ch = game.chars(card);
  return list.some(d => d.all ? ch.subtypes.size > 0 || ch.allCreatureTypes : ch.allCreatureTypes ? d.types.length > 0 : d.types.some(t => ch.subtypes.has(t)));
}

function timingOk(game, pid, card, opt) {
  const face = card.def.faces[opt.face] || card.def.faces[0];
  if (opt.land) return game.canSorcery(pid);
  if (game.stack.some(s => s.splitSecond)) return false;
  if (opt.sorcery) return game.canSorcery(pid);
  if (hasFlash(game, card, face) || opt.mayFlash) return true;
  if (opt.altCost === 'Morph') return game.canSorcery(pid);
  return game.canSorcery(pid);
}

// the static that stops this spell being cast now, if any (its host names it in whyCantPlay)
function cantBeCast(game, pid, card) {
  for (const s of game.activeStatics('CantBeCast')) {
    if (s.p.ValidCard && !matchValid(game, card, s.p.ValidCard, s.ctx)) continue;
    if (s.p.Caster && !matchValid(game, game.players[pid], s.p.Caster, s.ctx)) continue;
    if (s.p.Origin && !s.p.Origin.split(',').map(z => zoneMap[z] || z.toLowerCase()).includes(card.zone)) continue;
    if (!staticTimeOk(game, s)) continue;
    // "only any time they could cast a sorcery" (Teferi, Time Raveler)
    if (s.p.OnlySorcerySpeed === 'True' && game.canSorcery(pid)) continue;
    // "no more than N spells each turn" (Rule of Law, Ethersworn Canonist, Fires of Invention): once N such were cast
    if (s.p.NumLimitEachTurn && game.players[pid].spellsCastThisTurn.filter(r => matchValid(game, r.lki, s.p.ValidCard || 'Card', s.ctx)).length < +s.p.NumLimitEachTurn) continue;
    // "mana value greater than the number of lands that player controls" (Lavinia, Azorius Renegade)
    if (s.p.cmcGT === 'Land' && game.chars(card).cmc <= game.battlefield.filter(c => c.controller === pid && game.chars(c).types.has('Land')).length) continue;
    return s;
  }
  return null;
}

// Build the spell SA for an option (no state change).
function buildSpellSA(game, pid, card, opt) {
  const face = card.def.faces[opt.face] || card.def.faces[0];
  let raw;
  if (opt.abilIdx != null) raw = face.abilities[opt.abilIdx];
  else if (opt.faceDown) raw = 'SP$ PermanentCreature | SpellDescription$ Face-down creature';
  else if (face.subtypes.includes('Aura') && face.keywords.some(k => k.startsWith('Enchant'))) {
    const ek = face.keywords.find(k => k.startsWith('Enchant'));
    const valid = ek.startsWith('Enchant:') ? ek.split(':')[1] : ek.replace(/^Enchant /, '').replace(/^creature$/i, 'Creature').replace(/^land$/i, 'Land').replace(/^player$/i, 'Player').replace(/^permanent$/i, 'Permanent').replace(/^artifact$/i, 'Artifact');
    const zm = valid.match(/inZone(\w+)/);
    raw = `SP$ Attach | ValidTgts$ ${valid}${zm ? ' | TgtZone$ ' + zm[1] : ''} | AILogic$ ${face.svars.AttachAILogic || 'Pump'} | SpellDescription$ Enchant ${valid}`;
  } else raw = `SP$ Permanent${face.types.join('')} | SpellDescription$ ${face.name}`;
  const abil = { raw, parsed: parseAbility(raw), svars: face.svars, src: card, key: `cast:${opt.key}` };
  const sa = new SA(game, abil, card, pid);
  sa.isSpell = true;
  sa.permanent = !!opt.permanent || /^SP\$ Permanent/.test(raw) || (abil.parsed.api === 'Attach' && face.subtypes.includes('Aura'));
  sa.face = opt.face;
  sa.opt = opt;
  // awaken N: also put N +1/+1 counters on target land you control; it becomes a 0/0 Elemental creature with haste
  if (opt.awaken) {
    const svars2 = { ...face.svars, KWAwakenAnimate: 'DB$ Animate | Defined$ ParentTarget | Power$ 0 | Toughness$ 0 | Types$ Creature,Elemental | Keywords$ Haste | Duration$ Permanent' };
    const raw2 = `DB$ PutCounter | ValidTgts$ Land.YouCtrl | TgtPrompt$ Select target land you control to awaken | CounterType$ P1P1 | CounterNum$ ${opt.awaken} | SubAbility$ KWAwakenAnimate`;
    let last = sa; while (last.sub) last = last.sub;
    last.sub = new SA(game, { raw: raw2, parsed: parseAbility(raw2), svars: svars2, src: card, key: `cast:${opt.key}>awaken` }, card, pid, { parent: last });
  }
  return sa;
}

function spellCost(game, pid, card, opt, sa) {
  const face = card.def.faces[opt.face] || card.def.faces[0];
  let mana, extra = parseCost('');
  if (opt.withoutMana) mana = emptyCost();
  else if (opt.altManaStr != null) {
    const c = parseCost(opt.altManaStr);
    mana = c.mana; extra = c;
  } else if (sa.p.Cost) {
    const c = parseCost(sa.p.Cost);
    mana = c.hasMana ? c.mana : (face.manaCost ? cloneCost(face.manaCost) : emptyCost());
    extra = c;
  } else mana = face.manaCost ? cloneCost(face.manaCost) : emptyCost();
  if (opt.extraCostStr) { const c = parseCost(opt.extraCostStr); extra = { ...extra, parts: [...(extra.parts || []), ...c.parts] }; }
  if (opt.addCostStr) { const c = parseCost(opt.addCostStr); if (c.hasMana) mana = addCosts(mana, c.mana); extra = { ...extra, parts: [...(extra.parts || []), ...c.parts] }; }
  if (opt.from === 'command' && card.isCommander) { mana = addCosts(mana, parseMana(String(game.commanderTax(card)))); }
  // cost modifiers
  const ctxCard = card;
  let reduce = 0, raise = 0;
  const colorReduce = [];
  for (const s of game.activeStatics('ReduceCost')) {
    const p = s.p;
    if (paramCostStatic(s, 'reduce')) continue; // handled in mech-params.js
    if (p.Type && !/Spell/.test(p.Type) && p.Type !== 'Any') continue;
    if (p.ValidCard && !matchValid(game, ctxCard, p.ValidCard.replace(/CARDNAME/g, 'Card.Self'), { ...s.ctx, host: s.host })) continue;
    if (p.Activator && !matchValid(game, game.players[pid], p.Activator, s.ctx)) continue;
    if (p.ValidSpell && !castMatchesSpell(game, ctxCard, opt, p.ValidSpell, s.ctx)) continue;
    if (p.OnlyFirstSpell === 'True' && game.players[pid].spellsCastThisTurn.length > 0) continue;
    const amt = p.Amount ? calcCtx(game, p.Amount, { ...s.ctx, sa: { ...s.ctx.sa, svars: s.st.svars } }) : 1;
    if (p.Color) { for (let i = 0; i < amt; i++) colorReduce.push(...p.Color.split(' ')); }
    else reduce += amt;
  }
  for (const s of game.activeStatics('RaiseCost')) {
    const p = s.p;
    if (paramCostStatic(s, 'raise')) continue; // handled in mech-params.js
    if (p.Type && !/Spell/.test(p.Type)) continue;
    if (p.ValidCard && !matchValid(game, ctxCard, p.ValidCard, s.ctx)) continue;
    if (p.Activator && !matchValid(game, game.players[pid], p.Activator, s.ctx)) continue;
    raise += p.Amount ? calcCtx(game, p.Amount, s.ctx) : 1;
  }
  // affinity, delve, undaunted: printed or given to it (Pearl-Ear's affinity for Auras, Durnan's undaunted)
  const ch = { keywords: castKeywords(game, pid, card, face, opt.from) };
  for (const k of ch.keywords) {
    const m = k.match(/^Affinity:([^:]+)/);
    if (m) reduce += game.battlefield.filter(c => c.controller === pid && matchValid(game, c, m[1], { host: card, you: pid })).length;
  }
  if (game.hasKeywordIn(ch, 'Delve')) sa.delve = true;
  if (game.hasKeywordIn(ch, 'Undaunted')) reduce += game.opponents(pid).length;
  if (opt.reduceBy) reduce += opt.reduceBy; // Aminatou's miracle: "its mana cost reduced by {4}"
  mana = cloneCost(mana);
  mana.generic += raise;
  for (const col of colorReduce) { if (mana.colored[col] > 0) mana.colored[col]--; else if (mana.generic > 0) mana.generic--; }
  mana.generic = Math.max(0, mana.generic - reduce);
  // "you may spend mana as though it were mana of any color / type to cast it" (Brainstealer Dragon,
  // Gonti, Daxos, ...): each colored symbol takes any color (any type: anything)
  if (opt.mayPlay && (opt.mayPlay.ignoreColor || opt.mayPlay.ignoreType)) {
    const ANY = ['W', 'U', 'B', 'R', 'G'];
    for (const col of ANY) {
      const n = mana.colored[col] || 0;
      if (!n) continue;
      mana.colored[col] = 0;
      if (opt.mayPlay.ignoreType) mana.generic += n; else for (let i = 0; i < n; i++) mana.hybrid = [...mana.hybrid, ANY];
    }
    if (opt.mayPlay.ignoreType) { mana.generic += mana.hybrid.length; mana.hybrid = []; }
    else mana.hybrid = mana.hybrid.map(h => [...new Set([...h, ...ANY])]);
  }
  mana = paramSpellCost(game, pid, card, opt, sa, mana); // target-dependent and Relative cost statics, ManaConvert
  return { mana, extra };
}

export function castableOptions(game, pid, card, { ignoreTiming = false, freeCast = false } = {}) {
  const out = [];
  if (!card) return out;
  if (game.priority !== pid && !ignoreTiming) return out;
  for (const opt of spellOptions(game, pid, card)) {
    if (opt.land) {
      if (!ignoreTiming && !canPlayLandNow(game, pid)) continue;
      out.push(opt);
      continue;
    }
    if (!ignoreTiming && !timingOk(game, pid, card, opt)) continue;
    if (cantBeCast(game, pid, card)) continue;
    const sa = buildSpellSA(game, pid, card, opt);
    const { mana, extra } = spellCost(game, pid, card, freeCast ? { ...opt, withoutMana: true } : opt, sa);
    let xFree = mana.x ? { ...mana, x: 0 } : mana;
    if (!canPayNonMana(game, sa, extra)) continue;
    const face = card.def.faces[opt.face] || card.def.faces[0];
    // emerge / offering: some permanent to sacrifice must make the rest payable (without its own mana)
    if (opt.altCost === 'Emerge') {
      const base = xFree;
      const ok = game.battlefield.some(c => c.controller === pid && game.chars(c).types.has('Creature') && (() => { const m2 = cloneCost(base); m2.generic = Math.max(0, m2.generic - game.chars(c).cmc); return canAfford(game, pid, m2, { spellCard: card, exclude: new Set([card.id, c.id]) }); })());
      if (!ok) continue;
      xFree = emptyCost();
    }
    if (opt.altCost === 'Harmonize') {
      const pw = game.battlefield.filter(c => c.controller === pid && !c.tapped && game.chars(c).types.has('Creature')).map(c => game.chars(c).power);
      if (pw.length) { xFree = cloneCost(xFree); xFree.generic = Math.max(0, xFree.generic - Math.max(0, ...pw)); }
    }
    if (opt.altCost === 'Offering') {
      const base = xFree;
      const ok = game.battlefield.some(c => c.controller === pid && matchValid(game, c, opt.offering, { host: card, you: pid }) && canAfford(game, pid, game.chars(c).manaCost ? reduceByCost(base, game.chars(c).manaCost) : base, { spellCard: card, exclude: new Set([card.id, c.id]) }));
      if (!ok) continue;
      xFree = emptyCost();
    }
    // spree / tiered: some mode must be both targetable and affordable together with its own cost
    if (sa.api === 'Charm' && (sa.p.Choices || '').split(',').some(n => /ModeCost\$/.test(sa.svars[n.trim()] || ''))) {
      const base = xFree;
      const ok = (sa.p.Choices || '').split(',').map(n => n.trim()).filter(n => sa.svars[n]).some(n => {
        const m = makeSA(game, sa.svars[n], sa.svars, sa.host, sa.controller, { parent: sa });
        return targetsPossible(game, m) && canAfford(game, pid, addCosts(base, parseCost(m.p.ModeCost || '0').mana), { spellCard: card, exclude: new Set([card.id]) });
      });
      if (!ok) continue;
    }
    const altAdd = face.keywords.map(k => k.match(/^AlternateAdditionalCost:(.+)$/)).find(Boolean);
    if (altAdd && !altAdd[1].split(':').some(s => { const c = parseCost(s); return canPayNonMana(game, sa, { ...c, parts: [...extra.parts, ...c.parts] }) && canAfford(game, pid, addCosts(xFree, c.mana), { spellCard: card, exclude: new Set([card.id]) }); })) continue;
    if (!canAfford(game, pid, xFree, { spellCard: card, exclude: new Set([card.id, ...costPartExclusions(game, sa, extra.parts)]) })) continue;
    if (!targetsPossible(game, sa)) continue;
    out.push({ ...opt, manaCost: mana });
  }
  return out;
}

// Why can't pid play this card right now? A sentence for the player, or null when it can be played (the same checks
// as castableOptions, in the order a player would think of them).
export function whyCantPlay(game, pid, card) {
  if (!card || game.over) return null;
  if (game.priority !== pid) return 'Wait until it’s your turn to act.';
  const opts = spellOptions(game, pid, card);
  const name = game.name(card);
  if (!opts.length) return card.zone === 'hand' || card.zone === 'command' ? `${name} can’t be played right now.` : `${name} can’t be played from there.`;
  if (castableOptions(game, pid, card).length) return null;
  const why = [];
  for (const opt of opts) {
    if (opt.land) {
      const p = game.players[pid];
      if (game.activePlayer !== pid) why.push('Lands can only be played on your own turn.');
      else if (!game.isMainPhase() || game.stack.length) why.push('Lands go down in your main phase, while nothing is waiting to resolve.');
      else if (p.landsPlayed >= 1 + game.playerChars(pid).extraLands) why.push('You’ve already played a land this turn.');
      continue;
    }
    if (!timingOk(game, pid, card, opt)) {
      why.push(game.stack.some(s => s.splitSecond) ? 'A spell with split second is on the stack: nothing can be cast until it resolves.'
        : game.activePlayer !== pid ? `${name} can only be cast on your turn (it isn’t an instant and doesn’t have flash).`
          : game.stack.length ? `${name} has to wait until the stack is empty (it isn’t an instant and doesn’t have flash).`
            : `${name} can only be cast in a main phase (it isn’t an instant and doesn’t have flash).`);
      continue;
    }
    const stop = cantBeCast(game, pid, card);
    if (stop) { why.push(`${stop.host && stop.host.def ? game.name(stop.host) : 'Something on the battlefield'} stops ${name} being cast right now${stop.p.Description ? `: “${stop.p.Description.replace(/CARDNAME/g, game.name(stop.host))}”` : '.'}`); continue; }
    const sa = buildSpellSA(game, pid, card, opt);
    const { mana, extra } = spellCost(game, pid, card, opt, sa);
    if (!canPayNonMana(game, sa, extra)) { why.push(`You can’t pay the rest of ${name}’s cost (${extra.parts.map(pt => pt.type === 'Sac' ? 'something to sacrifice' : pt.type === 'Discard' ? 'a card to discard' : pt.type === 'Exile' ? 'a card to exile' : pt.type === 'PayLife' ? 'life to pay' : pt.type === 'tapXType' ? 'creatures to tap' : 'more').join(', ')}).`); continue; }
    const xFree = mana.x ? { ...mana, x: 0 } : mana;
    if (!canAfford(game, pid, xFree, { spellCard: card, exclude: new Set([card.id, ...costPartExclusions(game, sa, extra.parts)]) })) { why.push(`Not enough mana: ${name} costs ${costString(xFree) || '{0}'}${card.zone === 'command' && game.commanderTax(card) ? ` (with ${game.commanderTax(card)} commander tax)` : ''}.`); continue; }
    if (!targetsPossible(game, sa)) { why.push(`${name} has nothing it can target right now.`); continue; }
  }
  return why[0] || `${name} can’t be played right now.`;
}

function targetsPossible(game, root) {
  // a modal spell needs enough modes it can actually choose (each with legal targets)
  if (root.api === 'Charm') {
    const names = (root.p.Choices || '').split(',').map(x => x.trim()).filter(n => root.svars[n]);
    const ctx = ctxOf(game, root);
    const num = root.p.CharmNum ? calcCtx(game, root.p.CharmNum, ctx) : 1;
    const min = root.p.MinCharmNum != null ? calcCtx(game, root.p.MinCharmNum, ctx) : num;
    const usable = names.filter(n => targetsPossible(game, makeSA(game, root.svars[n], root.svars, root.host, root.controller, { parent: root })));
    return usable.length >= Math.max(1, Math.min(min, names.length));
  }
  const slots = [];
  for (const sa of root.chain()) {
    const spec = targetSpec(game, sa);
    if (!spec || spec.min === 0) continue;
    const c = targetCandidates(game, sa, spec);
    if (c.length < spec.min) return false;
    slots.push({ cands: c, min: spec.min, unique: spec.unique });
  }
  // "another target creature" (TargetUnique): the targets must be different objects
  if (!slots.some(s => s.unique)) return true;
  const picked = slots.map(() => []);
  let budget = 2000;
  const fill = (i, k) => {
    if (--budget < 0) return true;
    if (i >= slots.length) return true;
    const s = slots[i];
    if (k >= s.min) return fill(i + 1, 0);
    for (const c of s.cands) {
      if (picked[i].includes(c)) continue;
      if (s.unique && picked.slice(0, i).some(l => l.includes(c))) continue;
      picked[i].push(c);
      const ok = fill(i, k + 1);
      picked[i].pop();
      if (ok) return true;
    }
    return false;
  };
  return fill(0, 0);
}

function canPlayLandNow(game, pid) {
  if (!game.canSorcery(pid)) return false;
  const p = game.players[pid];
  return p.landsPlayed < 1 + game.playerChars(pid).extraLands;
}

export async function playLand(game, pid, card, action) {
  if (!card || !canPlayLandNow(game, pid)) return false;
  const opts = spellOptions(game, pid, card).filter(o => o.land);
  const opt = opts.find(o => o.key === action.optionKey) || opts[0];
  if (!opt) return false;
  const p = game.players[pid];
  p.landsPlayed++;
  if (opt.mayPlay && opt.mayPlay.st) noteMayPlayUse(game, opt.mayPlay.st);
  game.log(`${p.name} plays ${card.def.faces[opt.face].name}.`, { type: 'land', cardId: card.id });
  await game.moveCard(card, 'battlefield', { controller: pid, face: opt.face, silent: true });
  game.fire('LandPlayed', { Card: card, Player: pid, MayPlay: !!opt.mayPlay, MayPlayHost: opt.mayPlay && opt.mayPlay.st ? opt.mayPlay.st.host.id : null });
  return true;
}

export async function castSpell(game, pid, card, action = {}, { free = false, fromEffect = false, effectSA = null, altOpt = null } = {}) {
  if (!card) return false;
  const all = altOpt ? [altOpt] : spellOptions(game, pid, card, { anyZone: fromEffect }).filter(o => !o.land);
  let opt = all.find(o => o.key === action.optionKey) || null;
  if (!opt) {
    const cands = fromEffect ? all : castableOptions(game, pid, card).filter(o => !o.land);
    if (!cands.length) return false;
    if (cands.length === 1) opt = cands[0];
    else {
      const k = await game.ask(pid, { type: 'option', prompt: `How do you want to cast ${game.name(card)}?`, options: cands.map(o => ({ label: o.label, value: o.key })), cancellable: true, purpose: 'castMode', cardId: card.id });
      if (k == null) throw new Cancelled();
      opt = cands.find(o => o.key === k);
    }
  }
  if (!opt) return false;
  if (free) opt = { ...opt, withoutMana: true };
  if (effectSA && effectSA.p && effectSA.p.ManaConversion) opt = { ...opt, manaConversion: effectSA.p.ManaConversion }; // "spend mana as though any type"
  if (!fromEffect && !timingOk(game, pid, card, opt)) return false;
  const sa = buildSpellSA(game, pid, card, opt);
  sa.castFrom = opt.from;
  if (opt.altCost) sa.altCost = opt.altCost;
  if (opt.faceDown) sa.faceDown = true;
  const face = card.def.faces[opt.face] || card.def.faces[0];
  // costs
  let { mana, extra } = spellCost(game, pid, card, opt, sa);
  const kws = castKeywords(game, pid, card, face);
  const addCost = (str, times = 1) => {
    const c = parseCost(str);
    for (let i = 0; i < times; i++) mana = addCosts(mana, c.mana);
    if (c.parts.length) extra = { ...extra, parts: [...extra.parts, ...repeatParts(c.parts, times)] };
  };
  const affordable = (str, times = 1) => {
    const c = parseCost(str);
    let m = mana.x ? { ...mana, x: 0 } : mana;
    for (let i = 0; i < times; i++) m = addCosts(m, c.mana);
    return canAfford(game, pid, m, { spellCard: card, exclude: new Set([card.id]) }) && canPayNonMana(game, sa, { ...c, tap: false, untap: false, parts: [...extra.parts, ...repeatParts(c.parts, times)] });
  };
  // modes (entwine: all of them for an additional cost; spree / tiered: each chosen mode has its own cost)
  if (sa.api === 'Charm') {
    const ent = kws.map(k => k.match(/^Entwine:(.+)$/)).find(Boolean);
    if (ent && affordable(ent[1]) && allModesUsable(game, sa)) {
      const yes = await game.ask(pid, { type: 'confirm', prompt: `Entwine ${face.name} (pay ${costLabel(ent[1])} to choose all modes)?`, purpose: 'entwine', sa, cancellable: true });
      if (yes == null) throw new Cancelled();
      if (yes) { sa.entwined = true; addCost(ent[1]); }
    }
    const esc = kws.map(k => k.match(/^Escalate:(.+)$/)).find(Boolean);
    const ok = await chooseModes(game, sa, { mana, card, cancellable: true, escalate: esc ? parseCost(esc[1]) : null });
    if (!ok) throw new Cancelled();
    for (const m of sa.modes || []) if (m.p.ModeCost) addCost(m.p.ModeCost);
    if (esc && sa.modes && sa.modes.length > 1) addCost(esc[1], sa.modes.length - 1);
  }
  // gift: promise an opponent a gift as you cast the spell
  const giftRaw = kws.includes('Gift') ? face.svars.GiftAbility : null;
  // (only when the spell could still be cast with the gift promised: "if the gift was promised, target creature you control ...")
  const giftCastable = () => { sa.promisedGift = game.opponents(pid)[0].id; const ok = targetsPossible(game, sa); delete sa.promisedGift; return ok; };
  if (giftRaw && game.opponents(pid).length && giftCastable()) {
    const gp = parseAbility(giftRaw);
    const what = gp.p.GiftDescription || 'a gift';
    const opps = game.opponents(pid);
    const ans = await game.ask(pid, { type: 'option', prompt: `Gift ${what}: promise it to an opponent as you cast ${face.name}?`, options: [{ label: "Don't promise a gift", value: -1 }, ...opps.map(o => ({ label: `Promise ${what} to ${o.name}`, value: o.id }))], purpose: 'gift', sa, gift: gp, cancellable: true, cardId: card.id });
    if (ans == null) throw new Cancelled();
    if (ans !== -1 && opps.some(o => o.id === ans)) sa.promisedGift = ans;
  }
  // "as an additional cost to cast this spell, [pay one of these]"
  const alt = kws.map(k => k.match(/^AlternateAdditionalCost:(.+)$/)).find(Boolean);
  if (alt) {
    const choices = alt[1].split(':').filter(x => affordable(x));
    if (!choices.length) return false;
    let pick = choices[0];
    if (choices.length > 1) {
      pick = await game.ask(pid, { type: 'option', prompt: `${face.name}: choose an additional cost`, options: choices.map(c => ({ label: costLabel(c), value: c })), purpose: 'altAdditionalCost', sa, cancellable: true, cardId: card.id });
      if (pick == null) throw new Cancelled();
      if (!choices.includes(pick)) pick = choices[0];
    }
    addCost(pick);
  }
  // optional additional costs ("as an additional cost to cast this spell, you may ...")
  for (const st of face.statics) {
    const sp = parseAbility(st).p;
    if (sp.Mode !== 'OptionalCost' || !sp.Cost) continue;
    const reveal = sp.Cost.match(/^Reveal<\d+\/(\w+)/);
    if (reveal && game.battlefield.some(c => c.controller === pid && matchValid(game, c, reveal[1], { host: card, you: pid }))) (sa.castPresence = sa.castPresence || []).push(reveal[1]);
    if (!affordable(sp.Cost)) continue;
    const yes = await game.ask(pid, { type: 'confirm', prompt: `${face.name}: ${sp.Description || 'pay the optional additional cost ' + costLabel(sp.Cost) + '?'}`, purpose: 'optionalCost', sa, cost: sp.Cost, cancellable: true, cardId: card.id });
    if (yes == null) throw new Cancelled();
    if (!yes) continue;
    addCost(sp.Cost);
    sa.optionalCostPaid = true;
    if (reveal) (sa.castPresence = sa.castPresence || []).push(reveal[1]);
  }
  // bargain: "you may sacrifice an artifact, enchantment, or token as you cast this spell"
  const bargain = 'Sac<1/Artifact;Enchantment;Card.token/artifact, enchantment, or token>';
  if (kws.includes('Bargain') && affordable(bargain)) {
    const yes = await game.ask(pid, { type: 'confirm', prompt: `${face.name}: bargain (sacrifice an artifact, enchantment, or token as you cast it)?`, purpose: 'optionalCost', bargain: true, sa, cost: bargain, cancellable: true, cardId: card.id });
    if (yes == null) throw new Cancelled();
    if (yes) { addCost(bargain); sa.optionalCostPaid = true; sa.bargained = true; }
  }
  // Chorus of the Conclave: "as an additional cost to cast creature spells, you may pay any amount of mana"
  if (face.types.includes('Creature') && game.battlefield.some(c => c.controller === pid && game.chars(c).keywords.some(k => /^As an additional cost to cast creature spells, you may pay any amount of mana/.test(k)))) {
    let max = 0;
    while (max < 20 && affordable(String(max + 1))) max++;
    if (max > 0) {
      const n = await game.ask(pid, { type: 'number', prompt: `Pay any amount of additional mana: ${face.name} enters with that many more +1/+1 counters`, min: 0, max, purpose: 'chorus', sa, cancellable: true });
      if (n == null) throw new Cancelled();
      if (n > 0) { addCost(String(Math.min(n, max))); sa.chorusCounters = Math.min(n, max); }
    }
  }
  // casualty N: you may sacrifice a creature with power N or greater; when you do, copy the spell
  const cas = kws.map(k => k.match(/^Casualty:(\d+)$/)).find(Boolean);
  if (cas) {
    const pool = game.battlefield.filter(c => c.controller === pid && c.id !== card.id && game.chars(c).types.has('Creature') && game.chars(c).power >= +cas[1]);
    if (pool.length) {
      const ids = await game.ask(pid, { type: 'cards', prompt: `Casualty ${cas[1]}: you may sacrifice a creature with power ${cas[1]} or greater to copy ${face.name}`, cards: pool.map(c => c.id), min: 0, max: 1, purpose: 'casualty', sa, cancellable: true });
      if (ids == null) throw new Cancelled();
      const c = ids.length ? game.cardById(ids[0]) : null;
      if (c && pool.includes(c)) sa.casualtySac = c;
    }
  }
  // conspire: you may tap two untapped creatures you control that share a color with it; when you do, copy it
  if (kws.includes('Conspire')) {
    const cols = game.chars(card).colors;
    const pool = game.battlefield.filter(c => c.controller === pid && c.id !== card.id && !c.tapped && game.chars(c).types.has('Creature') && [...game.chars(c).colors].some(x => cols.has(x)));
    if (pool.length >= 2) {
      const ids = await game.ask(pid, { type: 'cards', prompt: `Conspire: you may tap two untapped creatures you control that share a color with ${face.name} to copy it`, cards: pool.map(c => c.id), min: 0, max: 2, purpose: 'conspire', sa, cancellable: true });
      if (ids == null) throw new Cancelled();
      const picked = (ids || []).map(id => game.cardById(id)).filter(c => c && pool.includes(c));
      if (picked.length === 2) sa.conspireTap = picked;
    }
  }
  // offering: sacrifice a permanent of the type and pay the difference in mana costs
  if (opt.altCost === 'Offering') {
    const pool = game.battlefield.filter(c => c.controller === pid && matchValid(game, c, opt.offering, { host: card, you: pid }) && canAfford(game, pid, game.chars(c).manaCost ? reduceByCost(mana, game.chars(c).manaCost) : mana, { spellCard: card, exclude: new Set([card.id, c.id]) }));
    if (!pool.length) return false;
    const ids = await game.ask(pid, { type: 'cards', prompt: `Offering: sacrifice a ${opt.offering} (its mana cost reduces the cost)`, cards: pool.map(c => c.id), min: 1, max: 1, purpose: 'emerge', sa, cancellable: true });
    if (ids == null) throw new Cancelled();
    const c = game.cardById(ids[0]);
    if (!c || !pool.includes(c)) return false;
    sa.emergeSac = c;
    if (game.chars(c).manaCost) mana = reduceByCost(mana, game.chars(c).manaCost);
  }
  // harmonize: you may tap a creature you control to reduce the cost by its power
  if (opt.altCost === 'Harmonize') {
    const reduced = c => { const m2 = cloneCost(mana); m2.generic = Math.max(0, m2.generic - game.chars(c).power); return m2; };
    // only creatures that leave the rest payable; when the full cost can't be paid, tapping one isn't optional
    const pool = game.battlefield.filter(c => c.controller === pid && !c.tapped && game.chars(c).types.has('Creature') && game.chars(c).power > 0 && canAfford(game, pid, reduced(c), { spellCard: card, exclude: new Set([card.id, c.id]) }));
    const mustTap = !canAfford(game, pid, mana, { spellCard: card, exclude: new Set([card.id]) });
    if (mustTap && !pool.length) return false;
    if (pool.length && mana.generic > 0) {
      const ids = await game.ask(pid, { type: 'cards', prompt: mustTap ? 'Harmonize: tap a creature you control to reduce the cost by its power' : 'Harmonize: you may tap a creature you control to reduce the cost by its power', cards: pool.map(c => c.id), min: mustTap ? 1 : 0, max: 1, purpose: 'harmonize', sa, cancellable: true });
      if (ids == null) throw new Cancelled();
      const c = ids.length ? game.cardById(ids[0]) : null;
      if (c && pool.includes(c)) { sa.harmonizeTap = c; const m2 = cloneCost(mana); m2.generic = Math.max(0, m2.generic - game.chars(c).power); mana = m2; }
    }
  }
  // buyback: pay more and the spell returns to your hand as it resolves
  const bb = kws.map(k => k.match(/^Buyback:(.+)$/)).find(Boolean);
  if (bb && affordable(bb[1])) {
    const yes = await game.ask(pid, { type: 'confirm', prompt: `Pay buyback ${costLabel(bb[1])} for ${face.name}?`, purpose: 'buyback', sa, cancellable: true, cardId: card.id });
    if (yes == null) throw new Cancelled();
    if (yes) { addCost(bb[1]); sa.buyback = true; }
  }
  // emerge: sacrifice a creature and pay the emerge cost reduced by its mana value
  if (opt.altCost === 'Emerge') {
    const emergeCost = c => { const m2 = cloneCost(mana); m2.generic = Math.max(0, m2.generic - game.chars(c).cmc); return m2; };
    const pool = game.battlefield.filter(c => c.controller === pid && game.chars(c).types.has('Creature') && canAfford(game, pid, emergeCost(c), { spellCard: card, exclude: new Set([card.id, c.id]) }));
    if (!pool.length) return false;
    const ids = await game.ask(pid, { type: 'cards', prompt: `Emerge: sacrifice a creature (its mana value reduces the cost)`, cards: pool.map(c => c.id), min: 1, max: 1, purpose: 'emerge', sa, cancellable: true });
    if (ids == null) throw new Cancelled();
    const c = game.cardById(ids[0]);
    if (!c || !pool.includes(c)) return false;
    sa.emergeSac = c;
    const m2 = cloneCost(mana); m2.generic = Math.max(0, m2.generic - game.chars(c).cmc); mana = m2;
  }
  // replicate: copy the spell for each time its replicate cost was paid
  const rep = kws.map(k => k.match(/^Replicate:(.+)$/)).find(Boolean);
  if (rep) {
    const rc = rep[1] === 'CardManaCost' ? (face.manaCostStr || '0') : rep[1];
    let max = 0;
    while (max < 10 && affordable(rc, max + 1)) max++;
    if (max > 0) {
      const n = await game.ask(pid, { type: 'number', prompt: `Replicate ${costLabel(rc)}: how many times?`, min: 0, max, purpose: 'replicate', sa, cancellable: true });
      if (n == null) throw new Cancelled();
      if (n > 0) { addCost(rc, n); sa.replicated = n; }
    }
  }
  // kicker / multikicker / offspring / optional costs
  const ch = game.chars(card);
  for (const k of kws) {
    let m;
    // offspring: pay more and a 1/1 token copy of it is made as it enters (printed, or Zinnia's for creature spells)
    if ((m = k.match(/^Offspring:(.+)$/)) && affordable(m[1])) {
      const yes = await game.ask(pid, { type: 'confirm', prompt: `Pay offspring ${costLabel(m[1])} for ${face.name}? (When it enters, you create a 1/1 token copy of it.)`, purpose: 'offspring', sa, cancellable: true, cardId: card.id });
      if (yes == null) throw new Cancelled();
      if (yes) { addCost(m[1]); sa.offspring = (sa.offspring || 0) + 1; }
    }
    if ((m = k.match(/^(Kicker|Multikicker):(.+)$/))) {
      const costs = m[2].split(':').filter(x => x && !/^(Generic|ValidSA)/.test(x));
      for (const kc of costs.slice(0, 2)) {
        const kcost = parseCost(kc);
        const test = addCosts(mana.x ? { ...mana, x: 0 } : mana, kcost.mana);
        if (!canAfford(game, pid, test, { spellCard: card, exclude: new Set([card.id]) }) || !canPayNonMana(game, sa, kcost)) continue;
        if (m[1] === 'Multikicker') {
          let n = 0;
          const max = maxRepeat(game, pid, mana, kcost.mana, card);
          if (max > 0) n = await game.ask(pid, { type: 'number', prompt: `Multikicker ${costString(kcost.mana)}: how many times?`, min: 0, max, purpose: 'multikicker', sa, cancellable: true });
          if (n == null) throw new Cancelled();
          for (let i = 0; i < n; i++) mana = addCosts(mana, kcost.mana);
          sa.kicked = n;
        } else {
          const yes = await game.ask(pid, { type: 'confirm', prompt: `Pay kicker ${kc.replace(/</g, ' ').replace(/>/g, '')} for ${face.name}?`, purpose: 'kicker', sa, cancellable: true });
          if (yes == null) throw new Cancelled();
          if (yes) { mana = addCosts(mana, kcost.mana); extra = { ...extra, parts: [...extra.parts, ...kcost.parts] }; sa.kicked = (sa.kicked || 0) + 1; }
        }
      }
    }
    if ((m = k.match(/^Squad:(.+)$/))) {
      const kcost = parseCost(m[1]);
      const max = maxRepeat(game, pid, mana, kcost.mana, card);
      if (max > 0) {
        const n = await game.ask(pid, { type: 'number', prompt: `Squad ${costString(kcost.mana)}: how many times?`, min: 0, max, purpose: 'squad', sa, cancellable: true });
        if (n == null) throw new Cancelled();
        for (let i = 0; i < n; i++) mana = addCosts(mana, kcost.mana);
        sa.squad = n;
      }
    }
  }
  // X that only appears in non-mana costs (e.g. "pay X life")
  const xPart = extra.parts.find(pt => pt.amount === 'X');
  if (!mana.x && xPart) {
    const p0 = game.players[pid];
    const max = Math.min(xPart.type === 'PayLife' ? Math.max(0, p0.life - 1) : xPart.type === 'PayEnergy' ? (p0.counters.ENERGY || 0) : 20, xCap(game, sa, extra.parts));
    const x = await game.ask(pid, { type: 'number', prompt: `Choose X for ${face.name}`, min: 0, max, purpose: 'xValue', sa, cancellable: true, xCost: xPart.type });
    if (x == null) throw new Cancelled();
    sa.x = x;
  }
  // X
  if (mana.x) {
    const fixed = sa.p.XChoice || null;
    const max = Math.min(maxX(game, pid, mana, card), xCap(game, sa, extra.parts));
    if (max < 0) return false;
    const minX = /XMin1/.test(sa.p.Cost || '') ? 1 : 0;
    let x = null;
    // "target creature with mana value X": an X with no legal target is asked again
    for (let tries = 0; tries < 3; tries++) {
      x = await game.ask(pid, { type: 'number', prompt: tries ? `There's no legal target with X = ${x}. Choose X for ${face.name}` : `Choose X for ${face.name}`, min: minX, max, purpose: 'xValue', sa, cancellable: true });
      if (x == null) throw new Cancelled();
      sa.x = x;
      if (targetsPossible(game, sa)) break;
    }
    const m2 = cloneCost(mana); m2.generic += m2.x * x; m2.x = 0; mana = m2;
  } else if (sa.x == null) sa.x = 0;
  if (sa.x && extra.parts.length && !canPayNonMana(game, sa, { ...extra, tap: false, untap: false })) return false;
  // strive: no more targets than can be paid for
  const strive = kws.map(k => k.match(/^Strive:(.+)$/)).find(Boolean);
  if (strive) { const cap = 1 + maxRepeat(game, pid, mana, parseCost(strive[1]).mana, card); for (const s2 of sa.chain()) s2.targetCap = cap; }
  // targets
  const ok = await chooseTargetsForSA(game, sa);
  if (!ok) return false;
  ({ mana, extra } = await paramCostAfterTargets(game, 'spell', pid, card, opt, sa, mana, extra)); // costs that depend on targets (mech-params.js)
  ({ mana, extra } = await otherOptionalCosts(game, pid, card, sa, mana, extra)); // the Defilers' "you may pay 2 life
  // strive: costs more for each target beyond the first
  if (strive) { const n = sa.chain().reduce((a, s) => a + (s.targets || []).length, 0); if (n > 1) addCost(strive[1], n - 1); }
  // non-mana cost choices
  const preEx = [sa.casualtySac, sa.emergeSac, sa.harmonizeTap, ...(sa.conspireTap || [])].filter(Boolean).map(c => c.id);
  const choices = await chooseCostParts(game, sa, extra, { afford: ex => canAfford(game, pid, mana, { spellCard: card, exclude: new Set([card.id, ...preEx, ...ex]) }) });
  if (!choices) return false;
  const exclude = new Set([card.id, ...costExclusions(game, choices)]);
  for (const c of [sa.casualtySac, sa.emergeSac, sa.harmonizeTap, ...(sa.conspireTap || [])]) if (c) exclude.add(c.id);
  // delve: exile cards from graveyard to pay generic
  if (sa.delve && mana.generic > 0) {
    const gy = game.players[pid].graveyard.filter(c => c.id !== card.id);
    const need = mana.generic;
    let n = 0;
    if (gy.length && !canAfford(game, pid, mana, { spellCard: card, exclude })) n = Math.min(gy.length, need);
    else if (gy.length) n = await game.ask(pid, { type: 'number', prompt: `Delve: exile how many cards from your graveyard?`, min: 0, max: Math.min(gy.length, need), purpose: 'delve', sa });
    if (n) { sa.delveCards = gy.slice(0, n); const m2 = cloneCost(mana); m2.generic -= n; mana = m2; }
  }
  if (!canAfford(game, pid, mana, { spellCard: card, exclude })) {
    if (!game.players[pid].isHuman) return false;
    game.log(`Not enough mana to cast ${face.name}.`, { type: 'info' });
    return false;
  }
  // pay
  const paidOk = await payManaCost(game, pid, mana, { exclude, spellCard: card, sa });
  if (!paidOk) return false;
  if (sa.delveCards) for (const c of sa.delveCards) await game.moveCard(c, 'exile');
  await applyCostParts(game, sa, extra, choices);
  if (sa.harmonizeTap && sa.harmonizeTap.zone === 'battlefield') await game.tap(sa.harmonizeTap);
  if (sa.conspireTap) for (const c of sa.conspireTap) if (c.zone === 'battlefield' && !c.tapped) await game.tap(c);
  // expend: the Nth total mana you spend on spells this turn
  if (sa.manaSpent) {
    const pl = game.players[pid];
    const before = pl.manaExpended || 0;
    pl.manaExpended = before + Object.values(sa.manaSpent).reduce((a, b) => a + b, 0);
    for (let k = before + 1; k <= pl.manaExpended; k++) game.fire('ManaExpend', { Player: pid, Amount: k });
  }
  for (const c of [sa.emergeSac, sa.casualtySac]) {
    if (!c || c.zone !== 'battlefield') continue;
    const lki = game.makeLKI(c);
    sa.root().paid.Sacrificed.push(lki);
    if (c === sa.emergeSac) sa.emerged = lki;
    await game.sacrifice(c, sa);
  }
  // what it has as it becomes cast, now that its costs are paid (Rain of Riches: "that mana from a Treasure was spent to cast")
  const lockKws = castKeywords(game, pid, card, face, opt.from, sa);
  // move to stack
  const fromZone = card.zone;
  if (opt.from === 'command') game.players[pid].commanderCasts[card.id] = (game.players[pid].commanderCasts[card.id] || 0) + 1;
  if (opt.mayPlay && opt.mayPlay.st) noteMayPlayUse(game, opt.mayPlay.st);
  await game.moveCard(card, 'stack', { silent: true, noReplace: true });
  card.zone = 'stack';
  card.controller = pid;
  card.face = opt.face || 0;
  card.castFrom = fromZone;
  card.castSA = sa;
  // what other cards gave it as it was cast stays with the spell ("the first spell you cast each turn has cascade")
  const own = [...card.faceDef.keywords];
  card.castGrants = [];
  for (const k of lockKws) { const j = own.indexOf(k); if (j >= 0) own.splice(j, 1); else card.castGrants.push(k); }
  // cast thanks to a "you may cast ... from your graveyard" permission: whose (Jaya's emblem, Edgar, Serra Paragon)
  card.castMayPlayHost = opt.mayPlay && opt.mayPlay.st ? opt.mayPlay.st.host.id : null;
  if (opt.faceDown) card.faceDown = true;
  if (sa.promisedGift != null) card.promisedGift = sa.promisedGift;
  if (opt.altCost === 'Flashback' || opt.altCost === 'Harmonize' || (opt.altCost === 'Escape' && !faceIsPermanent(face))) card.mustBeExiled = true;
  if (opt.altCost === 'Suspend') sa.fromSuspend = true;
  const item = { id: game.uid++, kind: 'spell', card, sa, controller: pid, description: face.name, stackItem: true, opt, fromZone };
  if (game.hasKeywordIn(ch, 'Split second')) item.splitSecond = true;
  sa.stackItem = item;
  game.stack.push(item);
  game.touch();
  const tdesc = describeTargets(game, sa);
  // "casts Serra Angel (blitz)": an alternative cost it was cast for, and the extras paid
  const how = [['Blitz', 'Dash', 'Evoke', 'Flashback', 'Escape', 'Retrace', 'Madness', 'Miracle', 'Overload', 'Emerge', 'Surge', 'Spectacle', 'Prowl', 'Mayhem', 'Harmonize', 'Disturb'].includes(opt.altCost) ? opt.altCost.toLowerCase() : null, sa.offspring ? 'offspring' : null, sa.conspireTap ? 'conspire' : null, sa.casualtySac ? 'casualty' : null].filter(Boolean);
  game.log(`${game.players[pid].name} casts ${opt.faceDown ? 'a face-down creature' : face.name}${how.length ? ` (${how.join(', ')})` : ''}${tdesc ? ' targeting ' + tdesc : ''}.`, { type: 'cast', cardId: card.id, player: pid });
  const rec = { lki: game.makeLKI(card), controller: pid };
  game.turnState.spellsCast.push(rec);
  game.players[pid].spellsCastThisTurn.push(rec);
  game.fire('SpellCast', { Card: card, Player: pid, IsSpell: true, StackItem: item, CastFrom: fromZone === 'hand' ? 'hand' : fromZone, AltCost: opt.altCost, MayPlay: !!opt.mayPlay, MayPlayHost: card.castMayPlayHost, Targets: sa.chain().flatMap(s => s.targets), SpellAbility: sa });
  const used = game.effects.filter(e => e.forgetOnCast && matchValid(game, card, e.forgetOnCast, { host: e, you: e.controller }));
  if (used.length) { game.effects = game.effects.filter(e => !used.includes(e)); game.touch(); }
  // casualty / replicate: "when you cast this spell, copy it ..." (you may choose new targets for the copies)
  const copies = (sa.casualtySac ? 1 : 0) + (sa.conspireTap ? 1 : 0) + (sa.replicated || 0);
  if (copies) {
    const what = [sa.casualtySac ? 'Casualty' : null, sa.conspireTap ? 'Conspire' : null, sa.replicated ? `Replicate ×${sa.replicated}` : null].filter(Boolean).join(', ');
    game.pendingTriggers.push({ host: card, t: { parsed: { p: { Execute: 'CopyIt', TriggerDescription: `${what} — copy ${face.name}` } }, svars: { CopyIt: `DB$ CopySpellAbility | Defined$ TriggeredSpellAbility | Amount$ ${copies} | MayChooseTarget$ True` }, key: 'castcopy' }, rp: { Card: card, StackItem: item, Player: pid }, controller: pid });
  }
  game.notifyTargets(sa, item);
  return true;
}

// keywords a card has as it's cast from `from`: its own and the ones statics give it where it is (Lier's flashback,
// Ashling's evoke), plus the ones given to spells on the stack, checked as if it already were one (Henzie's blitz,
// Zinnia's offspring, Anhelo's casualty: "the first instant or sorcery spell you cast each turn")
export function castKeywords(game, pid, card, face = card.faceDef, from = card.zone, sa = null) {
  game.ensureChars();
  const fi = card.def.faces.indexOf(face);
  const ch = game.chars(card); // (looked up where it really is, before the as-if-cast check below)
  const out = fi < 0 || fi === (card.face || 0) ? [...ch.keywords] : [...face.keywords];
  const here = card.zone;
  const grants = [];
  for (const { st, ctx } of game._activeStatics || []) {
    const p = st.parsed.p;
    if (!p.AddKeyword || !p.AffectedZone) continue;
    const zones = p.AffectedZone.split(',').map(z => zoneMap[z] || z.toLowerCase());
    if (!zones.includes('stack') || zones.includes(here)) continue; // (a card in hand already has what's given in hand)
    grants.push({ p, ctx });
  }
  if (!grants.length) return out;
  const saved = { zone: card.zone, controller: card.controller, castFrom: card.castFrom, face: card.face, castSA: card.castSA };
  card.zone = 'stack'; card.controller = pid; card.castFrom = ['adventure', 'foretold', 'plotted'].includes(from) ? 'exile' : from; card.face = Math.max(0, fi);
  if (sa) card.castSA = sa;
  try {
    for (const { p, ctx } of grants) {
      if (p.Affected && !matchValid(game, card, p.Affected, ctx)) continue;
      if (p.AffectedDefined && !resolveDefined(game, p.AffectedDefined, ctx).some(x => x && x.id === card.id)) continue;
      if (!p.Affected && !p.AffectedDefined) continue;
      out.push(...p.AddKeyword.split(' & '));
    }
  } finally { Object.assign(card, saved); }
  return out;
}

// a keyword's cost: "CardManaCost" / "ManaCost" is the card's own mana cost (Henzie's blitz, Lier's flashback)
export function ownCost(face, raw) {
  const own = face.manaCostStr || '0';
  if (raw == null || raw === '') return own;
  return String(raw).replace(/\b(Card)?ManaCost\b/g, own);
}

// a cost modifier's "ValidSpell$", for the spell being cast this way ("blitz costs you pay cost {1} less")
function castMatchesSpell(game, card, opt, valid, ctx) {
  return valid.split(',').some(v => {
    const [type, ...rest] = v.trim().split('.');
    if (type !== 'Spell' && type !== 'Card') return false;
    const props = rest.join('.').split('+').filter(Boolean);
    return props.every(pr => pr === 'Blitz' ? opt.altCost === 'Blitz' : pr === 'isCastFaceDown' ? !!opt.faceDown : pr === 'MayPlaySource' ? !!opt.mayPlay : matchValid(game, card, 'Card.' + pr, ctx));
  });
}

// reduce a mana cost by another one ("paying the difference in mana costs"): colored symbols first, rest from generic
function reduceByCost(mana, by) {
  const m = cloneCost(mana);
  let spare = by.generic + by.hybrid.length + by.twobrid.length * 2 + by.phyrexian.length;
  for (const [k, n] of Object.entries(by.colored)) {
    const use = Math.min(n, m.colored[k] || 0);
    m.colored[k] -= use;
    spare += n - use;
  }
  m.generic = Math.max(0, m.generic - spare);
  return m;
}

// choose and pay the non-mana parts of a cost (sacrifices, discards, ...)
export async function payCostParts(game, sa, cost) {
  if (!cost.parts.length && !cost.tap && !cost.untap) return true;
  let choices;
  try { choices = await chooseCostParts(game, sa, cost); } catch (e) { if (e && e.cancelled) return false; throw e; }
  if (!choices) return false;
  await applyCostParts(game, sa, cost, choices);
  return true;
}

function repeatParts(parts, times) {
  if (times === 1) return parts;
  return parts.map(pt => (/^\d+$/.test(pt.amount) ? { ...pt, amount: String(+pt.amount * times), args: [String(+pt.amount * times), ...pt.args.slice(1)] } : pt));
}

export function costLabel(str) {
  const c = parseCost(str);
  const bits = [];
  if (c.hasMana) bits.push(costString(c.mana));
  for (const pt of c.parts) {
    const d = pt.args[2] || (pt.valid ? humanValid(pt.valid) : '');
    bits.push({ PayLife: `pay ${pt.amount} life`, Discard: `discard ${pt.amount} card${pt.amount === '1' ? '' : 's'}`, Sac: `sacrifice ${pt.amount} ${d}`, Reveal: `reveal ${pt.amount} ${d} card`, tapXType: `tap ${pt.amount} untapped ${d}`, ExileFromGrave: `exile ${pt.amount} ${d} card from your graveyard`, Blight: `blight ${pt.amount}` }[pt.type] || `${pt.type} ${pt.amount}`);
  }
  return bits.join(', ') || costString(c.mana);
}

function allModesUsable(game, sa) {
  const names = (sa.p.Choices || '').split(',').map(s => s.trim()).filter(n => sa.svars[n]);
  return names.length > 0 && names.every(n => targetsPossible(game, makeSA(game, sa.svars[n], sa.svars, sa.host, sa.controller, { parent: sa })));
}

function maxX(game, pid, mana, card) {
  const avail = availableManaCount(game, pid, card);
  const base = cmc({ ...mana, x: 0 });
  if (base > avail) return -1;
  const perX = mana.x || 1;
  let hi = Math.floor((avail - base) / perX);
  // verify with planner, decreasing
  while (hi > 0) {
    const m = cloneCost(mana); m.generic += m.x * hi; m.x = 0;
    if (canAfford(game, pid, m, { spellCard: card, exclude: new Set([card.id]) })) break;
    hi--;
  }
  return Math.max(0, hi);
}

// the largest X a player could actually use: "X target creatures", "exile X cards from your graveyard"
function xCap(game, sa, parts, afford = null) {
  let cap = Infinity;
  for (const s of sa.chain()) {
    if (s.p.TargetMin !== 'X' && s.p.TargetMax !== 'X') continue;
    const spec = targetSpec(game, s);
    if (spec && s.p.TargetMin === 'X') cap = Math.min(cap, targetCandidates(game, s, spec).length);
  }
  for (const pt of parts || []) {
    if (pt.amount !== 'X') continue;
    if (!['ExileFromGrave', 'ExileFromHand', 'Discard', 'Sac', 'tapXType', 'untapYType', 'Exile', 'Return', 'ExileAnyGrave', 'ExileSameGrave'].includes(pt.type)) continue;
    let cands = costCandidates(game, sa, pt);
    let k = cands.length;
    // sacrificing / tapping X permanents: keep enough of them to make the mana (Grim Hireling's {B} from a Treasure)
    if (afford && (pt.type === 'Sac' || pt.type === 'tapXType')) {
      const needed = c => pt.type === 'tapXType' ? manaAbilitiesOf(game, c).length > 0 : costExclusions(game, [{ part: pt, cards: [c] }]).length > 0;
      cands = [...cands.filter(c => !needed(c)), ...cands.filter(needed)];
      while (k > 0 && !afford(new Set(costExclusions(game, [{ part: pt, cards: cands.slice(0, k) }])))) k--;
    }
    cap = Math.min(cap, k);
  }
  return cap;
}

function maxRepeat(game, pid, base, add, card) {
  let n = 0;
  let m = base.x ? { ...base, x: 0 } : base;
  for (let i = 0; i < 10; i++) {
    m = addCosts(m, add);
    if (!canAfford(game, pid, m, { spellCard: card, exclude: new Set([card.id]) })) break;
    n++;
  }
  return n;
}

export async function chooseModes(game, sa, { mana = null, card = null, cancellable = false, escalate = null } = {}) {
  const p = sa.p;
  const names = (p.Choices || '').split(',').map(s => s.trim()).filter(Boolean);
  const ctx = ctxOf(game, sa);
  const num = p.CharmNum ? calcCtx(game, p.CharmNum, ctx) : 1;
  const min = p.MinCharmNum != null ? calcCtx(game, p.MinCharmNum, ctx) : num;
  const options = names.map(n => {
    const raw = sa.svars[n];
    const parsed = raw ? parseAbility(raw) : null;
    const desc = (parsed && (parsed.p.SpellDescription || parsed.api)) || n;
    // spree / tiered: each mode has an additional cost
    const mc = parsed && parsed.p.ModeCost != null ? parseCost(parsed.p.ModeCost) : null;
    const label = mc ? `${parsed.p.PrecostDesc ? parsed.p.PrecostDesc + ' — ' : ''}+${mc.hasMana ? costString(mc.mana) : '{0}'} — ${desc}` : desc;
    return { label, value: n, ...(mc ? { cost: mc.mana } : {}) };
  }).filter(o => sa.svars[o.value]);
  const usable = options.filter(o => {
    if (!charmModeAllowed(game, sa, o.value)) return false; // "choose one that hasn't been chosen this turn"
    const m = makeSA(game, sa.svars[o.value], sa.svars, sa.host, sa.controller, { parent: sa });
    if (!targetsPossible(game, m)) return false;
    if (o.cost && mana && !canAfford(game, sa.controller, addCosts(mana.x ? { ...mana, x: 0 } : mana, o.cost), { spellCard: card, exclude: card ? new Set([card.id]) : new Set() })) return false;
    return true;
  });
  if (!usable.length) return false;
  if (sa.entwined) {
    sa.modes = usable.map(o => new SA(game, { raw: sa.svars[o.value], parsed: parseAbility(sa.svars[o.value]), svars: sa.svars, src: sa.abil.src, key: sa.key + '#' + o.value }, sa.host, sa.controller, { parent: sa, trig: sa.trig }));
    return true;
  }
  const repeat = p.CanRepeatModes === 'True';
  let prompt = p.ChoiceDesc || `Choose ${num === min ? num : min + '-' + num} mode${num > 1 ? 's' : ''}`;
  let ans = null;
  let max = repeat ? num : Math.min(num, usable.length);
  const lo = Math.min(min, usable.length);
  // escalate: no more modes than the escalate costs can be paid for (the prompt's max says so)
  const escalateOk = k => {
    if (!escalate || k < 2) return true;
    if (escalate.parts.length && !canPayNonMana(game, sa, { ...escalate, tap: false, untap: false, hasMana: false, parts: repeatParts(escalate.parts, k - 1) })) return false;
    if (!escalate.hasMana || !mana) return true;
    let m = mana.x ? { ...mana, x: 0 } : mana;
    for (let i = 1; i < k; i++) m = addCosts(m, escalate.mana);
    return canAfford(game, sa.controller, m, { spellCard: card, exclude: card ? new Set([card.id]) : new Set() });
  };
  while (max > Math.max(1, lo) && !escalateOk(max)) max--;
  // "an opponent chooses one" (Fatal Lore, Misfortune): you pick the opponent, they pick the mode
  let chooser = sa.controller;
  if (p.Chooser) {
    const ids = resolveDefined(game, p.Chooser, ctx).filter(x => x && x.isPlayer).map(x => x.id);
    const pick = ids.length > 1 ? await game.ask(sa.controller, { type: 'player', prompt: 'Choose who chooses the mode', players: ids, purpose: 'modeChooser', sa }) : ids[0];
    chooser = ids.includes(pick) ? pick : ids.length ? ids[0] : sa.controller;
  }
  sa.choosingPlayer = chooser;
  for (let tries = 0; tries < 4; tries++) {
    ans = await game.ask(chooser, { type: 'modes', prompt, options: usable, min: lo, max, repeat, sa, cancellable: !!cancellable && !sa.isTrigger && chooser === sa.controller, baseMana: mana });
    if (!ans) return false;
    // spree: the chosen modes' costs must be payable together
    const extra = ans.map(n => (usable.find(o => o.value === n) || {}).cost).filter(Boolean);
    if (escalate) for (let k = 1; k < ans.length; k++) if (escalate.hasMana) extra.push(escalate.mana);
    // escalate paid by tapping creatures, discarding, ...: enough of those for every extra mode
    const nonManaOk = !escalate || !escalate.parts.length || ans.length < 2 || canPayNonMana(game, sa, { ...escalate, tap: false, untap: false, hasMana: false, parts: repeatParts(escalate.parts, ans.length - 1) });
    if (nonManaOk && (!mana || !extra.length || canAfford(game, sa.controller, extra.reduce((a, c) => addCosts(a, c), mana.x ? { ...mana, x: 0 } : mana), { spellCard: card, exclude: card ? new Set([card.id]) : new Set() }))) break;
    if (tries === 3) return false;
    prompt = `You can't pay for all of those modes together. ${p.ChoiceDesc || 'Choose again'}`;
  }
  sa.modes = ans.map(n => {
    const m = new SA(game, { raw: sa.svars[n], parsed: parseAbility(sa.svars[n]), svars: sa.svars, src: sa.abil.src, key: sa.key + '#' + n }, sa.host, sa.controller, { parent: sa, trig: sa.trig });
    return m;
  });
  noteCharmModes(game, sa, ans);
  return true;
}

export function describeTargets(game, sa) {
  const ts = sa.chain().flatMap(s => s.targets || []);
  if (!ts.length) return '';
  return ts.map(t => game.name(t)).join(', ');
}

// ---------------------------------------------------------------- activated abilities
export function activatedAbilities(game, pid, card) {
  const out = [];
  if (!card) return out;
  const ch = game.chars(card);
  for (const abil of ch.abilities) {
    const p = abil.parsed.p;
    if (abil.parsed.kind !== 'AB') continue;
    if (abil.parsed.api === 'Mana' || abil.parsed.api === 'ManaReflected') continue;
    const zones = p.ActivationZone ? p.ActivationZone.split(',').map(z => zoneMap[z.trim()] || z.trim().toLowerCase()) : ['battlefield'];
    if (!zones.includes(card.zone)) continue;
    const controller = card.zone === 'battlefield' ? card.controller : card.owner;
    if (controller !== pid && !(p.AnyPlayer === 'True' || /Player|Opponent/.test(p.Activator || ''))) continue;
    out.push(abil);
  }
  return out;
}

export function canActivate(game, pid, card, abil, { ignoreTiming = false } = {}) {
  const p = abil.parsed.p;
  if (card.zone === 'battlefield' && card.phasedOut) return false;
  if (!ignoreTiming && game.priority !== pid) return false;
  if (game.stack.some(s => s.splitSecond)) return false;
  if (p.SorcerySpeed === 'True' || p.Planeswalker === 'True' || p.IsEquip === 'True') { if (!game.canSorcery(pid)) return false; }
  // ninjutsu: only once blockers are declared, while you control an unblocked attacker
  if (abil.parsed.api === 'Ninjutsu') {
    if (!game.combat || !['declareBlockers', 'firstStrikeDamage', 'combatDamage', 'endCombat'].includes(game.step)) return false;
    if (!game.combat.attackers.some(a => !a.blocked && (game.cardById(a.card) || {}).controller === pid)) return false;
  }
  if (p.Planeswalker === 'True') {
    const limit = 1 + game.activeStatics('NumLoyaltyAct').filter(s => matchValid(game, card, s.p.ValidCard || 'Planeswalker', s.ctx)).length;
    if ((card.abilityUses.__pw || 0) >= limit) return false;
  }
  if (p.ActivationLimit && (card.abilityUses[abil.key] || 0) >= calcCtx(game, p.ActivationLimit, { host: card, you: pid })) return false;
  if (p.GameActivationLimit && (card.gameUses && card.gameUses[abil.key] || 0) >= +p.GameActivationLimit) return false;
  if (p.PlayerTurn === 'True' && game.activePlayer !== pid) return false;
  if (p.OpponentTurn === 'True' && game.activePlayer === pid) return false;
  if (p.ActivationPhases && !phaseOk(game, p.ActivationPhases)) return false;
  const ctx = { host: card, you: pid, svars: abil.svars, sa: { svars: abil.svars, host: card, controller: pid, root() { return { x: 0, paid: {} }; } } };
  if (!checkPresence(game, p, ctx)) return false;
  if (game.activeStatics('CantBeActivated').some(s => matchValid(game, card, s.p.ValidCard || 'Card', s.ctx) && (!s.p.AffectedZone || true))) return false;
  const sa = new SA(game, abil, card, pid);
  const cost = parseCost(p.Cost);
  if (!canPayNonMana(game, sa, cost)) return false;
  if (!cost.hasMana && cmc(manaConverted(game, card, cost.mana, sa)) > 0) cost.hasMana = true; // a cost raised by a static
  if (cost.hasMana) {
    const m = manaConverted(game, card, cost.mana.x ? { ...cost.mana, x: 0 } : cost.mana, sa);
    const exclude = new Set(cost.tap ? [card.id] : []);
    for (const part of cost.parts) if (part.type === 'Sac' && (part.valid === 'CARDNAME' || part.valid === 'Card.Self')) exclude.add(card.id);
    for (const id of costPartExclusions(game, sa, cost.parts)) exclude.add(id);
    if (!canAfford(game, pid, m, { exclude, abilityHost: card, costHasX: !!cost.mana.x })) return false;
  }
  if (!targetsPossible(game, sa)) return false;
  return true;
}

function phaseOk(game, spec) {
  const names = { untap: 'Untap', upkeep: 'Upkeep', draw: 'Draw', main1: 'Main1', beginCombat: 'BeginCombat', declareAttackers: 'Declare Attackers', declareBlockers: 'Declare Blockers', combatDamage: 'Combat Damage', firstStrikeDamage: 'First Strike Damage', endCombat: 'EndCombat', main2: 'Main2', end: 'End of Turn', cleanup: 'Cleanup' };
  const order = ['Untap', 'Upkeep', 'Draw', 'Main1', 'BeginCombat', 'Declare Attackers', 'Declare Blockers', 'First Strike Damage', 'Combat Damage', 'EndCombat', 'Main2', 'End of Turn', 'Cleanup'];
  const cur = names[game.step];
  for (const part of spec.split(',')) {
    if (part.includes('->')) {
      const [a, b] = part.split('->');
      const ia = order.indexOf(a), ib = order.indexOf(b), ic = order.indexOf(cur);
      if (ic >= ia && ic <= ib) return true;
    } else if (part.trim() === cur) return true;
  }
  return false;
}

export async function activateAbility(game, pid, card, abilityKey, action = {}) {
  if (!card) return false;
  const abil = game.chars(card).abilities.find(a => a.key === abilityKey);
  if (!abil) return false;
  if (!canActivate(game, pid, card, abil, { ignoreTiming: !!action.ignoreTiming })) return false;
  const p = abil.parsed.p;
  const sa = new SA(game, abil, card, pid);
  sa.isActivated = true;
  if (sa.api === 'Charm') { const ok = await chooseModes(game, sa, { cancellable: true }); if (!ok) throw new Cancelled(); }
  const cost = parseCost(p.Cost);
  let mana = manaConverted(game, card, cost.mana, sa);
  if (cmc(mana) > 0) cost.hasMana = true;
  const payOpts = { abilityHost: card, costHasX: !!cost.mana.x };
  if (mana.x || /\bX\b/.test(p.Cost || '') && cost.parts.some(pt => pt.amount === 'X')) {
    const exclude = new Set(cost.tap ? [card.id] : []);
    let max;
    if (mana.x) {
      max = Math.max(0, Math.floor((availableManaCount(game, pid, null, payOpts) - cmc({ ...mana, x: 0 }) - (cost.tap && manaSourcesFor(game, pid, payOpts).some(s => s.card === card) ? 1 : 0)) / mana.x));
      // the count can double-book sources (a filter land's own cost): check with the planner, going down
      const exX = new Set(cost.tap ? [card.id] : []);
      while (max > 0) { const m = cloneCost(mana); m.generic += m.x * max; m.x = 0; if (canAfford(game, pid, m, { exclude: exX, ...payOpts })) break; max--; }
    }
    else {
      const part = cost.parts.find(pt => pt.amount === 'X');
      max = part.type === 'SubCounter' ? ((card.counters[normalizeCounterName(part.counter)]) || 0) : part.type === 'PayLife' ? game.players[pid].life - 1 : part.type === 'PayEnergy' ? (game.players[pid].counters.ENERGY || 0) : 10;
    }
    max = Math.min(max, xCap(game, sa, cost.parts, cost.hasMana ? ex => canAfford(game, pid, mana.x ? { ...mana, x: 0 } : mana, { exclude: new Set([...(cost.tap ? [card.id] : []), ...ex]), ...payOpts }) : null));
    let x = null;
    for (let tries = 0; tries < 3; tries++) {
      x = await game.ask(pid, { type: 'number', prompt: tries ? `There's no legal target with X = ${x}, or its cost can't be paid. Choose X for ${game.name(card)}` : `Choose X for ${game.name(card)}`, min: 0, max: Math.max(0, max), purpose: 'xValue', sa, cancellable: true });
      if (x == null) throw new Cancelled();
      sa.x = x;
      // "exile an artifact card with mana value X": the X must work for the costs and the targets
      if (targetsPossible(game, sa) && canPayNonMana(game, sa, cost)) break;
    }
    if (mana.x) { const m2 = cloneCost(mana); m2.generic += m2.x * x; m2.x = 0; mana = m2; }
  } else sa.x = 0;
  // with X chosen, the costs must still be payable ("Pay {E} X times", "Remove X counters")
  if (sa.x && !canPayNonMana(game, sa, cost)) return false;
  const ok = await chooseTargetsForSA(game, sa);
  if (!ok) return false;
  { const adj = await paramCostAfterTargets(game, 'ability', pid, card, null, sa, mana, cost); mana = adj.mana; cost.parts = adj.extra.parts; if (cmc(mana) > 0) cost.hasMana = true; }
  const choices = await chooseCostParts(game, sa, cost, { afford: cost.hasMana ? ex => canAfford(game, pid, mana, { exclude: new Set([...(cost.tap ? [card.id] : []), ...ex]), ...payOpts }) : null });
  if (!choices) return false;
  const exclude = new Set(cost.tap ? [card.id] : []);
  for (const id of costExclusions(game, choices)) exclude.add(id);
  if (cost.hasMana && !canAfford(game, pid, mana, { exclude, ...payOpts })) return false;
  if (cost.hasMana) { const paidOk = await payManaCost(game, pid, mana, { exclude, sa, ...payOpts }); if (!paidOk) return false; }
  await applyCostParts(game, sa, cost, choices);
  card.abilityUses[abil.key] = (card.abilityUses[abil.key] || 0) + 1;
  if (p.Planeswalker === 'True') card.abilityUses.__pw = (card.abilityUses.__pw || 0) + 1;
  if (p.GameActivationLimit) { card.gameUses = card.gameUses || {}; card.gameUses[abil.key] = (card.gameUses[abil.key] || 0) + 1; }
  const desc = (p.SpellDescription || p.StackDescription || abil.parsed.api || '').replace(/CARDNAME|NICKNAME/g, game.name(card));
  const tdesc = describeTargets(game, sa);
  game.log(`${game.players[pid].name} activates ${game.name(card)}: ${desc}${tdesc ? ' (targeting ' + tdesc + ')' : ''}`, { type: 'activate', cardId: card.id, player: pid });
  if (p.IsCycling === 'True') game.fire('Cycled', { Card: card, Player: pid });
  if (p.Static === 'True') { await resolveChain(game, sa); return true; }
  const item = { id: game.uid++, kind: 'ability', sa, card: null, source: card, controller: pid, description: `${game.name(card)}: ${desc}`, stackItem: true };
  sa.stackItem = item;
  game.stack.push(item);
  game.touch();
  game.fire('AbilityCast', { Card: card, Player: pid, IsSpell: false, StackItem: item, SpellAbility: sa });
  game.notifyTargets(sa, item);
  return true;
}

// ---------------------------------------------------------------- resolution
export async function resolveStackItem(game, item) {
  const sa = item.sa;
  if (item.kind === 'spell') {
    const card = item.card;
    if (!recheckTargets(game, sa)) {
      game.log(`${game.name(card)} fizzles (all targets are illegal).`);
      if (card.zone === 'stack') await game.moveCard(card, 'graveyard');
      return;
    }
    if (sa.permanent) {
      // what it was given as a spell that still matters on the battlefield: a blitzed creature's "when this dies,
      // draw a card", an evoked one's sacrifice, offspring's token copy
      const kept = (card.castGrants || []).filter(k => (/^Blitz\b/.test(k) && sa.altCost === 'Blitz') || (/^Evoke\b/.test(k) && sa.altCost === 'Evoke') || (/^Offspring\b/.test(k) && sa.offspring));
      const opts = { controller: item.controller, cast: { from: item.fromZone, x: sa.x || 0, kicked: sa.kicked || 0, sa, manaSpent: sa.manaSpent, altCost: sa.altCost, squad: sa.squad || 0, offspring: sa.offspring || 0, grants: kept }, silent: true, face: sa.face || 0, faceDown: sa.faceDown };
      if (sa.api === 'Attach') {
        const t = sa.targets[0];
        if (!t) { await game.moveCard(card, 'graveyard'); return; }
        opts.attachTo = t.isPlayer ? 'p' + t.id : t.id;
      }
      const wasFaceDown = card.faceDown;
      const moved = await game.moveCard(card, 'battlefield', opts);
      if (moved) {
        if (wasFaceDown || sa.faceDown) moved.faceDown = true;
        if (sa.opt && sa.opt.disguise) { moved.disguised = true; game.touch(); }
        game.log(`${game.name(moved)} enters the battlefield.`, { type: 'resolve', cardId: moved.id });
        if (sa.altCost === 'Dash' || sa.altCost === 'Blitz') {
          moved.temp.push({ keywords: ['Haste'], until: 'Permanent' });
          game.delayed.push({ id: game.uid++, p: { Mode: 'Phase', Phase: 'End of Turn', Execute: 'DashReturn' }, svars: { DashReturn: sa.altCost === 'Dash' ? 'DB$ ChangeZone | Defined$ DelayTriggerRemembered | Origin$ Battlefield | Destination$ Hand' : 'DB$ Sacrifice | Defined$ DelayTriggerRemembered' }, host: moved, controller: item.controller, remembered: [moved], turn: game.turnNumber, thisTurnOnly: true });
          if (sa.altCost === 'Blitz') moved.blitzed = true;
          game.touch();
        }
        if (sa.altCost === 'Evoke') moved.evoked = true;
        if (sa.altCost === 'Disturb') { moved.transformed = true; game.touch(); }
        if (sa.opt && sa.opt.flashSac) game.delayed.push({ id: game.uid++, p: { Mode: 'Phase', Phase: 'Cleanup', Execute: 'FlashSac' }, svars: { FlashSac: 'DB$ SacrificeAll | Defined$ DelayTriggerRemembered' }, host: moved, controller: item.controller, remembered: [moved], turn: game.turnNumber, thisTurnOnly: true });
        if (moved.unlocked && moved.unlocked.length) { const d = moved.unlocked[0]; moved.unlocked = []; game.unlockDoor(moved, d, item.controller); }
        if (sa.squad) moved.squad = sa.squad;
        if (sa.kicked) moved.kicked = sa.kicked;
      }
      return;
    }
    // gift: the promised opponent gets the gift before the spell's other effects
    if (card.promisedGift != null && !item.isCopy && (card.faceDef.svars || {}).GiftAbility) await resolveChain(game, makeSA(game, 'DB$ GiveGift', card.faceDef.svars, card, item.controller, { parent: sa, key: 'gift' }));
    await resolveChain(game, sa);
    // cipher: you may exile the spell card encoded on a creature you control
    if (card.zone === 'stack' && !item.isCopy && !card.isSpellCopy && card.faceDef.keywords.includes('Cipher')) await encodeCipher(game, item.controller, card);
    if (card.zone === 'stack') {
      if (sa.opt && sa.opt.adventure) { await game.moveCard(card, 'exile', { silent: true }); card.onAdventure = true; game.log(`${game.name(card)} goes on an adventure.`); }
      else if (card.reboundPending) { await game.moveCard(card, 'exile'); }
      else if (sa.buyback && !card.mustBeExiled) { await game.moveCard(card, 'hand', { silent: true }); game.log(`${game.name(card)} returns to its owner's hand (buyback).`); }
      else await game.moveCard(card, 'graveyard', { silent: true });
    }
    return;
  }
  // abilities & triggers
  if (!recheckTargets(game, sa)) { game.log(`${item.description} fizzles.`); return; }
  if (sa.isTrigger) {
    const tp = sa.triggerParams || {};
    const ctx = { host: sa.host, you: sa.controller, trig: sa.trig, svars: sa.svars, sa };
    if ((tp.IsPresent || tp.CheckSVar) && tp.NoResolvingCheck !== 'True' && !checkPresence(game, tp, ctx)) return;
    if (tp.OptionalDecider) {
      const decider = resolveDefined(game, tp.OptionalDecider, ctx)[0];
      const pid = decider && decider.isPlayer ? decider.id : sa.controller;
      const yes = await game.ask(pid, { type: 'confirm', prompt: `Use ${game.name(sa.host)}'s ability? ${item.description}`, purpose: 'optionalTrigger', sa });
      if (!yes) return;
    }
    // "you may pay [cost]. If you do, ...": a triggered ability with a cost asks for it as it resolves
    if (sa.kind === 'AB' && sa.p.Cost && !(await payTriggerCost(game, sa, item, !!tp.OptionalDecider))) return;
  }
  await resolveChain(game, sa);
}

// Cipher: exile the card encoded on a creature you control; whenever that creature deals combat damage to a
// player, its controller may cast a copy of the encoded card without paying its mana cost.
async function encodeCipher(game, pid, card) {
  const pool = game.battlefield.filter(c => c.controller === pid && game.chars(c).types.has('Creature'));
  if (!pool.length) return;
  const ids = await game.ask(pid, { type: 'cards', prompt: `Cipher: you may encode ${game.name(card)} on a creature you control`, cards: pool.map(c => c.id), min: 0, max: 1, purpose: 'cipher', cardId: card.id });
  const host = ids && ids.length ? game.cardById(ids[0]) : null;
  if (!host || !pool.includes(host)) return;
  await game.moveCard(card, 'exile', { silent: true });
  if (card.zone !== 'exile') return;
  const name = card.faceDef.name;
  const raw = `Mode$ DamageDone | ValidSource$ Card.IsRemembered | ValidTarget$ Player | CombatDamage$ True | Execute$ CipherCast | TriggerDescription$ Cipher — you may cast a copy of ${name} without paying its mana cost`;
  const svars = { CipherCast: 'DB$ Play | Defined$ Imprinted | CopyCard$ True | WithoutManaCost$ True | Optional$ True | Controller$ TriggeredSourceController' };
  const e = {
    isEffect: true, id: game.nextId++, effectName: `${name} (encoded on ${game.name(host)})`, controller: pid, owner: pid, zone: 'command',
    duration: 'Permanent', remembered: [host], imprinted: [card], chosen: {}, counters: {}, timestamp: game.uid++, temp: [], mods: [], abilityUses: {}, xPaid: 0,
    endsWhenHostLeaves: host.id, hostCard: card, description: `Whenever ${game.name(host)} deals combat damage to a player, its controller may cast a copy of ${name} without paying its mana cost.`,
  };
  e.effectChars = { name: e.effectName, types: new Set(['Effect']), subtypes: new Set(), supertypes: new Set(), colors: new Set(), keywords: [], abilities: [], triggers: [{ raw, parsed: parseAbility(raw), svars, src: e, key: `cipher${e.id}` }], statics: [], replacements: [], svars, power: 0, toughness: 0, cmc: 0 };
  card.encodedOn = { id: host.id, zcc: host.zcc };
  game.effects.push(e);
  game.touch();
  game.log(`${game.players[pid].name} encodes ${name} on ${game.name(host)}.`);
}

// Pay the cost of a triggered ability on resolution. Returns true when paid (or nothing to pay).
export async function payTriggerCost(game, sa, item, alreadyAgreed = false) {
  const costStr = sa.p.Cost;
  const rep = String(costStr || '').match(/^Mana<([^\\>]+)\\(\w+)>$/);
  if (rep) return payRepeatedMana(game, sa, rep[1], rep[2]);
  const cost = parseCost(costStr);
  const mandatory = /\bMandatory\b/.test(costStr);
  const pid = sa.controller;
  const host = sa.host;
  // X announced by the payer ("you may pay {X}{R}")
  const xIsChoice = !sa.svars.X || /xPaid/i.test(sa.svars.X);
  if ((cost.mana.x || cost.parts.some(pt => pt.amount === 'X')) && xIsChoice && sa.root().x == null) {
    const base = cmc({ ...cost.mana, x: 0 });
    const max = cost.mana.x ? Math.max(0, Math.floor((availableManaCount(game, pid) - base) / cost.mana.x)) : cost.parts.some(pt => pt.type === 'PayLife' && pt.amount === 'X') ? Math.max(0, game.players[pid].life - 1) : 10;
    const x = await game.ask(pid, { type: 'number', prompt: `${game.name(host)}: choose X`, min: 0, max, purpose: 'xValue', sa });
    sa.x = x || 0;
  }
  let mana = cost.mana;
  if (mana.x) { const m2 = cloneCost(mana); m2.generic += m2.x * (sa.root().x || 0); m2.x = 0; mana = m2; }
  // triggered abilities aren't bound by summoning sickness for {T} costs
  const tapOk = !cost.tap || (host && host.zone === 'battlefield' && !host.tapped);
  const can = tapOk && canPayNonMana(game, sa, { ...cost, tap: false, untap: cost.untap }) && (!cost.hasMana || canAfford(game, pid, mana, { exclude: new Set(cost.tap && host ? [host.id] : []) }));
  if (!can) return false;
  if (!mandatory && !alreadyAgreed) {
    const yes = await game.ask(pid, { type: 'confirm', prompt: `${game.name(host)}: pay ${costLabel(costStr.replace(/\bMandatory\b/, '').trim()) || 'the cost'}? (${(item && item.description) || sa.description})`, purpose: 'triggerCost', sa, cost: mana });
    if (!yes) return false;
  }
  let choices;
  try { choices = await chooseCostParts(game, sa, cost, { afford: cost.hasMana ? ex => canAfford(game, pid, mana, { exclude: new Set([...(cost.tap && host ? [host.id] : []), ...ex]) }) : null }); } catch (e) { if (e && e.cancelled) return false; throw e; }
  if (!choices) return false;
  const exclude = new Set(cost.tap && host ? [host.id] : []);
  for (const id of costExclusions(game, choices)) exclude.add(id);
  if (cost.hasMana && cmc(mana) > 0 && !(await payManaCost(game, pid, mana, { exclude, sa }))) return false;
  await applyCostParts(game, sa, cost, choices);
  return true;
}

export async function resolveChain(game, sa) {
  for (let s = sa; s; s = s.sub) {
    if (game.over) return;
    if (s.api === 'Charm') {
      if (!s.modes) { const ok = await chooseModes(game, s); if (!ok) continue; if (s.isTrigger || s.parent) await chooseTargetsForSA(game, s, { optional: true }); }
      for (const m of s.modes || []) await resolveChain(game, m);
      continue;
    }
    const ctx = ctxOf(game, s);
    if (!checkConditions(game, s.p, ctx)) continue;
    if (s.hadTargets && s.targets.length === 0) continue;
    if (s.p.UnlessCost) {
      const paid = await payUnless(game, s);
      const switched = s.p.UnlessSwitched === 'True';
      if (paid !== switched) continue;
    }
    if (s.p.Optional === 'True' && s.api !== 'ChangeZone' && s.api !== 'Dig' && s.api !== 'Play') {
      const decider = s.p.OptionalDecider ? resolveDefined(game, s.p.OptionalDecider, ctx)[0] : game.players[s.controller];
      const pid = decider && decider.isPlayer ? decider.id : s.controller;
      const yes = await game.ask(pid, { type: 'confirm', prompt: (s.p.OptionQuestion || `${s.description}?`).replace(/CARDNAME/g, game.name(s.host)), purpose: 'optional', sa: s });
      if (!yes) continue;
    }
    try {
      await runEffect(game, s);
    } catch (e) {
      if (e && (e.cancelled || e.message === 'game over')) throw e;
      game.log(`Effect error (${s.api}) on ${s.host ? game.name(s.host) : 'an ability'}: ${e.message}`, { type: 'error', detail: String((e && e.stack) || '').split('\n').slice(1, 3).join(' | ') });
      if (game.throwErrors) throw e;
      console.error(e);
    }
    if (s.p.RememberCostCards) { /* handled via paid */ }
  }
}

async function payUnless(game, sa) {
  const ctx = ctxOf(game, sa);
  const payerSpec = sa.p.UnlessPayer || 'TargetedController';
  const payers = resolveDefined(game, payerSpec, ctx).filter(x => x && x.isPlayer);
  const costStr = sa.p.UnlessCost;
  for (const payer of payers) {
    let costStr2 = costStr;
    if (/^[A-Z]\w*$/.test(costStr) && sa.svars[costStr] && !isManaToken(costStr)) costStr2 = String(calcCtx(game, costStr, ctx));
    const cost = parseCost(costStr2);
    if (!cost.hasMana && /^\d+$/.test(costStr2)) cost.mana = parseMana(costStr2), cost.hasMana = true;
    const tmp = new SA(game, sa.abil, sa.host, payer.id);
    tmp.root().x = sa.root().x;
    if (!canPayNonMana(game, tmp, cost)) continue;
    if (cost.hasMana && !canAfford(game, payer.id, cost.mana)) continue;
    const yes = await game.ask(payer.id, { type: 'confirm', prompt: `Pay ${costStr2.replace(/<|>/g, ' ')} ${sa.p.UnlessSwitched === 'True' ? 'to' : 'to prevent'}: ${sa.description.replace(/CARDNAME/g, game.name(sa.host))}?`, purpose: 'unlessCost', sa, cost: cost.mana, payer: payer.id });
    if (!yes) continue;
    const choices = await chooseCostParts(game, tmp, cost).catch(() => null);
    if (!choices) continue;
    if (cost.hasMana && !(await payManaCost(game, payer.id, cost.mana))) continue;
    await applyCostParts(game, tmp, cost, choices);
    game.log(`${payer.name} pays ${costStr2}.`);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- legal actions
export function getActions(game, pid) {
  const out = [];
  const p = game.players[pid];
  if (game.priority !== pid || game.over) return out;
  game.ensureChars();
  const seen = new Set();
  const consider = (card) => {
    if (seen.has(card.id)) return;
    seen.add(card.id);
    for (const o of castableOptions(game, pid, card)) {
      if (o.land) out.push({ type: 'land', cardId: card.id, optionKey: o.key, label: o.label });
      else out.push({ type: 'cast', cardId: card.id, optionKey: o.key, label: o.label, manaCost: o.manaCost });
    }
  };
  for (const c of p.hand) consider(c);
  for (const c of p.command) consider(c);
  for (const c of p.graveyard) consider(c);
  for (const c of p.exile) consider(c);
  if (p.library.length) consider(p.library[0]);
  for (const q of game.players) if (q.id !== pid) for (const c of q.exile) if (mayPlayFrom(game, pid, c)) consider(c);
  // activated abilities
  const abilityCards = [...game.battlefield, ...p.hand, ...p.graveyard, ...p.exile, ...p.command];
  for (const c of abilityCards) {
    for (const abil of activatedAbilities(game, pid, c)) {
      if (!canActivate(game, pid, c, abil)) continue;
      out.push({ type: 'activate', cardId: c.id, abilityKey: abil.key, label: (abil.parsed.p.SpellDescription || abil.parsed.api).replace(/CARDNAME|NICKNAME/g, game.name(c)), api: abil.parsed.api });
    }
  }
  return out;
}

// Offer to cast a card for an alternative cost (madness, miracle). Returns true if cast.
export async function castAlternative(game, pid, card, costStr, kind, fromExile) {
  const face = card.def.faces[0];
  // "ManaCost": its mana cost (Falkenrath Gorger's madness); "ManaCost:4": that, less {4} (Aminatou's miracle)
  const less = /^(?:Card)?ManaCost:(\d+)$/.exec(costStr || '');
  costStr = ownCost(face, less ? 'ManaCost' : costStr);
  const opt = { key: kind.toLowerCase(), label: `${kind} ${face.name}`, face: 0, from: card.zone, altCost: kind, altManaStr: costStr, permanent: faceIsPermanent(face), reduceBy: less ? +less[1] : 0 };
  if (opt.permanent && !face.types.includes('Creature') && false) opt.permanent = true;
  let cast = false;
  const sa = buildSpellSA(game, pid, card, opt);
  const { mana } = spellCost(game, pid, card, opt, sa);
  if (canAfford(game, pid, mana.x ? { ...mana, x: 0 } : mana, { spellCard: card, exclude: new Set([card.id]) }) && targetsPossible(game, sa)) {
    const yes = await game.ask(pid, { type: 'confirm', prompt: `${kind}: cast ${face.name} for ${costString(parseCost(costStr).mana)}?`, purpose: 'castFree', cards: [card.id] });
    if (yes) {
      try { cast = await castSpell(game, pid, card, { optionKey: opt.key }, { fromEffect: true, altOpt: opt }); } catch (e) { if (!e.cancelled) throw e; }
    }
  }
  if (!cast && fromExile && card.zone === 'exile') await game.moveCard(card, 'graveyard', { silent: true });
  return cast;
}

export { buildSpellSA, spellCost };
