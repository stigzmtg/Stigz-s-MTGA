// Implementations of Forge ability APIs ("DB$ Draw", "SP$ Destroy", ...).
import { parseAbility } from './forge.js';
import { matchValid, resolveDefined, calc, calcCtx, ctxOf, findTargets, liveOrLki, ctrlOf, zoneMap, compareSpec, isPlayer } from './filters.js';
import { SA, makeSA, resolveChain, chooseTargetsForSA, castSpell, castableOptions, spellOptions, refOf, fromRef, canAfford, payManaCost, parseCost, chooseModes, targetSpec, targetCandidates, producedUnits, buildSpellSA, humanValid, canPayNonMana, payCostParts, rollDice, costLabel as costLabelOf } from './abilities.js';
import { normalizeCounter, counterName } from './game.js';
const counterLabel = k => `${counterName(k)} counter`;
import { COLORS, COLOR_NAMES, NAME_TO_COLOR, BASIC_LAND_TYPES } from './util.js';
import { cmc, parseMana, addCosts } from './mana.js';
import { canAttack, defendersFor, playerInDirection } from './combat.js';
import { COMBAT_EFFECTS, pumpBlockExtras, saddle, mustBlockAll, unblockBlockedOnlyBy } from './mech-combat.js';

const Z = z => (z ? (zoneMap[z] || z.toLowerCase()) : z);

function num(game, sa, key, def = 0) {
  const v = sa.p[key];
  if (v == null || v === '') return def;
  return calc(game, v, sa);
}

function hasTgtSpec(sa) { return !!(sa.p.ValidTgts || sa.p.TargetType); }

function objs(game, sa, defaultDefined = null) {
  if (hasTgtSpec(sa)) return sa.targets.map(t => (t.isCard || t.lki) ? liveOrLki(game, t) : t);
  const d = sa.p.Defined || defaultDefined;
  if (!d) return [];
  if (d === 'Self' && sa.etbCard) return [sa.etbCard];
  return resolveDefined(game, d, ctxOf(game, sa));
}

const cardsOf = list => list.filter(o => o && o.isCard);
const playersOf = list => list.filter(o => o && o.isPlayer);

function remember(sa, list) {
  const h = sa.host;
  if (!h) return;
  h.remembered = h.remembered || [];
  for (const o of list) if (o && !h.remembered.includes(o)) h.remembered.push(o);
}

// per-object SVar values (never written into the shared card definition)
function storeSVar(sa, name, value) {
  const h = sa.host;
  if (!h || !h.isCard) return;
  if (!h.storedSVars || h.storedSVars.zcc !== h.zcc) h.storedSVars = { zcc: h.zcc, v: {} };
  h.storedSVars.v[name] = value;
}

function desc(game, sa) {
  const d = sa.p.SpellDescription || (sa.p.StackDescription && sa.p.StackDescription !== 'SpellDescription' ? sa.p.StackDescription : '') || (sa.host ? game.name(sa.host) : sa.api || '');
  return d.replace(/CARDNAME|NICKNAME/g, game.name(sa.host));
}

async function chooseCards(game, pid, cards, min, max, prompt, sa, purpose, extra = {}) {
  if (!cards.length) return [];
  max = Math.min(max, cards.length);
  min = Math.min(min, max);
  if (max <= 0) return [];
  if (min === cards.length && max === cards.length) return cards.slice();
  const ids = await game.ask(pid, { type: 'cards', prompt, cards: cards.map(c => c.id), min, max, sa, purpose, ...extra });
  return (ids || []).map(id => game.cardById(id)).filter(Boolean).slice(0, max);
}

function durationOf(sa) {
  const d = sa.p.Duration;
  if (!d || d === 'EndOfTurn' || d === 'UntilEndOfTurn') return 'EOT';
  if (d === 'Permanent') return 'Permanent';
  return d;
}

function applyDuration(game, sa, obj, rec) {
  const d = durationOf(sa);
  rec.until = d === 'UntilHostLeavesPlay' || d === 'UntilHostLeavesPlayOrEOT' || d === 'UntilLoseControlOfHost' ? (d === 'UntilHostLeavesPlayOrEOT' ? 'EOT' : 'Permanent') : d;
  if (d.startsWith('UntilHostLeaves') || d === 'UntilLoseControlOfHost') rec.untilHostLeaves = sa.host.id;
  rec.owner = sa.controller;
}

function kwList(s) { return s ? String(s).split(' & ').map(x => x.trim()).filter(Boolean) : []; }

function tokenCounts(game, sa, ownerId, n) {
  // CreateToken replacement effects (token doublers)
  let amount = n;
  for (const h of [...game.battlefield, ...game.effects]) {
    const ch = h.isEffect ? h.effectChars : game.chars(h);
    for (const r of ch.replacements) {
      const p = r.parsed.p;
      if (p.Event !== 'CreateToken') continue;
      const ctx = { host: h, you: h.controller, svars: r.svars, trig: { TokenNum: amount }, sa: { svars: r.svars, host: h, controller: h.controller, trig: { TokenNum: amount }, root() { return { x: 0, paid: {} }; } } };
      if (p.ValidToken && !/YouCtrl/.test(p.ValidToken) && !/Card/.test(p.ValidToken)) continue;
      if (p.ValidToken && /YouCtrl/.test(p.ValidToken) && h.controller !== ownerId) continue;
      if (p.ValidToken && /OppCtrl/.test(p.ValidToken) && h.controller === ownerId) continue;
      if (p.ValidPlayer && !matchValid(game, game.players[ownerId], p.ValidPlayer, ctx)) continue;
      if (p.EffectOnly === 'True' && !sa) continue;
      const raw = r.svars[p.ReplaceWith];
      if (!raw) continue;
      const parsed = parseAbility(raw);
      if (parsed.api !== 'ReplaceToken') continue;
      if (parsed.p.Type === 'Amount' || !parsed.p.Type) amount = parsed.p.Amount ? calcCtx(game, parsed.p.Amount, ctx) : amount * 2;
    }
  }
  return amount;
}

async function makeTokens(game, sa, script, ownerId, n, opts = {}) {
  const def = game.db.token(script);
  if (!def) { game.log(`Unknown token "${script}".`, { type: 'error' }); return []; }
  n = tokenCounts(game, sa, ownerId, n);
  const out = [];
  for (let i = 0; i < Math.min(n, 60); i++) {
    const t = await game.createToken(def, ownerId, sa, { tapped: opts.tapped, attacking: opts.attacking });
    if (!t) continue;
    if (opts.power != null || opts.toughness != null) t.mods.push({ id: game.uid++, power: opts.power, toughness: opts.toughness, until: 'Permanent' });
    if (opts.keywords && opts.keywords.length) t.temp.push({ keywords: opts.keywords, until: opts.pumpDuration || 'EOT', owner: sa.controller });
    if (opts.counters) await game.addCounters(t, opts.counters.type, opts.counters.n, sa);
    out.push(t);
  }
  if (out.length) game.log(`${game.players[ownerId].name} creates ${out.length > 1 ? out.length + ' ' : 'a '}${def.front.name.replace(/ Token$/, '')} token${out.length > 1 ? 's' : ''}.`, { type: 'token' });
  if (out.length) { game.noteTokenBatch(ownerId); game.fire('TokenCreatedOnce', { Card: out[0], Cards: out, Player: ownerId }); }
  game.touch();
  return out;
}

function attackingFromSpec(game, sa, spec) {
  if (!spec || !game.combat) return null;
  if (spec === 'True') {
    const host = sa.host;
    const rec = game.combat.attackers.find(a => a.card === host.id);
    if (rec) return rec.defenderPlayer;
    const opp = game.opponents(sa.controller)[0];
    return opp ? opp.id : null;
  }
  const t = resolveDefined(game, spec.split(' & ')[0], ctxOf(game, sa)).find(isPlayer);
  return t ? t.id : null;
}

// ---------------------------------------------------------------- generic scry/surveil helpers
async function scry(game, pid, n, sa) {
  const p = game.players[pid];
  const top = p.library.slice(0, n);
  if (!top.length) return;
  const bottom = await chooseCards(game, pid, top, 0, top.length, `Scry ${n}: choose cards to put on the bottom`, sa, 'scryBottom', { reveal: true });
  for (const c of bottom) { p.library.splice(p.library.indexOf(c), 1); p.library.push(c); }
  game.touch();
  game.log(`${p.name} scries ${n}${bottom.length ? ` (${bottom.length} to the bottom)` : ''}.`);
  game.fire('Scry', { Player: pid, Amount: n });
}

async function surveil(game, pid, n, sa) {
  const p = game.players[pid];
  for (const s of game.activeStatics('SurveilNum')) if (matchValid(game, p, s.p.ValidPlayer || 'You', s.ctx)) n += +(s.p.Num || 0);
  const top = p.library.slice(0, n);
  if (!top.length) return;
  const gy = await chooseCards(game, pid, top, 0, top.length, `Surveil ${n}: choose cards to put into your graveyard`, sa, 'surveilGrave', { reveal: true });
  for (const c of gy) { const r = await game.moveCard(c, 'graveyard', { silent: true }); if (r && r.zone === 'graveyard') r.surveilledTurn = game.turnNumber; }
  game.log(`${p.name} surveils ${n}${gy.length ? ` (${gy.length} to the graveyard)` : ''}.`);
  game.fire('Surveil', { Player: pid, Amount: n });
}

// ---------------------------------------------------------------- effects
export const E = {
  async Mana(game, sa) {
    const pid = sa.controller;
    const host = sa.host.lki ? sa.host.card : sa.host;
    const units = producedUnits(game, host, sa.abil);
    const p = game.players[pid];
    const colors = [];
    for (const u of units) {
      if (u.length === 1) { colors.push(u[0]); continue; }
      const c = await game.ask(pid, { type: 'color', prompt: 'Choose a color of mana', colors: u, purpose: 'mana' });
      colors.push(c || u[0]);
    }
    for (const c of colors) p.pool[c] = (p.pool[c] || 0) + 1;
    game.touch();
    if (colors.length) game.log(`${p.name} adds ${colors.map(c => `{${c}}`).join('')}.`, { type: 'mana' });
  },
  async ManaReflected(game, sa) {
    if (sa.p.ReflectProperty === 'Produced' && sa.trig && sa.trig.Produced) {
      const opts = [...new Set(sa.trig.Produced.split(/\s+/).filter(Boolean))];
      const pl = game.players[sa.controller];
      const c = opts.length === 1 ? opts[0] : await game.ask(sa.controller, { type: 'color', prompt: 'Choose the type of mana to add', colors: opts, purpose: 'mana' });
      pl.pool[c || opts[0]] = (pl.pool[c || opts[0]] || 0) + 1;
      game.touch();
      return;
    }
    return E.Mana(game, sa);
  },

  async Draw(game, sa) {
    const who = playersOf(objs(game, sa, 'You'));
    for (const p of who.length ? who : [game.players[sa.controller]]) {
      let n = num(game, sa, 'NumCards', 1);
      if (sa.p.Upto === 'True') n = await game.ask(p.id, { type: 'number', prompt: `Draw up to ${n} cards`, min: 0, max: n, purpose: 'drawUpTo', sa });
      if (n > 0) await game.drawCards(p, n, sa);
    }
  },

  async Discard(game, sa) {
    const who = playersOf(objs(game, sa, 'You'));
    const mode = sa.p.Mode || 'TgtChoose';
    for (const p of who) {
      const valid = sa.p.DiscardValid || 'Card';
      const pool = p.hand.filter(c => matchValid(game, c, valid, ctxOf(game, sa)));
      let n = sa.p.NumCards === 'All' ? pool.length : num(game, sa, 'NumCards', 1);
      if (sa.p.AnyNumber === 'True') n = pool.length;
      let chosen = [];
      if (mode === 'Hand') chosen = p.hand.slice();
      else if (mode === 'Random') { const tmp = pool.slice(); game.rng.shuffle(tmp); chosen = tmp.slice(0, n); }
      else if (mode === 'RevealYouChoose' || mode === 'RevealTgtChoose') chosen = await chooseCards(game, sa.controller, pool, Math.min(n, pool.length), n, `Choose ${n} card(s) for ${p.name} to discard`, sa, 'discardOpponent', { reveal: true });
      else if (mode === 'Defined') chosen = cardsOf(resolveDefined(game, sa.p.DefinedCards || 'Remembered', ctxOf(game, sa)));
      else chosen = await chooseCards(game, p.id, pool, sa.p.AnyNumber === 'True' || sa.p.Optional === 'True' ? 0 : Math.min(n, pool.length), n, `Discard ${n} card(s)`, sa, 'discard');
      for (const c of chosen) { if (c.zone === 'hand') await game.discard(c, sa); }
      if (sa.p.RememberDiscarded === 'True') remember(sa, chosen);
      sa.root().paid.Discarded = (sa.root().paid.Discarded || []).concat(chosen);
    }
  },

  async Destroy(game, sa) {
    const list = cardsOf(objs(game, sa, 'Self'));
    const destroyed = [];
    game.beginBatch();
    for (const c of list) { if (c.zone === 'battlefield' && await game.destroy(c, sa, { noRegen: sa.p.NoRegen === 'True' })) destroyed.push(c); }
    await game.endBatch();
    if (sa.p.RememberDestroyed === 'True') remember(sa, destroyed);
  },

  async DestroyAll(game, sa) {
    const ctx = ctxOf(game, sa);
    const list = game.battlefield.filter(c => matchValid(game, c, sa.p.ValidCards || 'Card', ctx));
    game.beginBatch();
    const destroyed = [];
    for (const c of list) if (await game.destroy(c, sa, { noRegen: sa.p.NoRegen === 'True' })) destroyed.push(c);
    await game.endBatch();
    if (sa.p.RememberDestroyed === 'True') remember(sa, destroyed);
    game.log(`${desc(game, sa)} (${destroyed.length} destroyed)`);
  },

  async ChangeZone(game, sa) {
    const p = sa.p;
    const ctx = ctxOf(game, sa);
    const origins = (p.Origin || 'Battlefield').split(',').map(Z);
    const dest = Z(p.Destination || 'Graveyard');
    const hidden = p.Hidden === 'True' || (!hasTgtSpec(sa) && !p.Defined && origins.some(o => o === 'library' || o === 'hand' || (o === 'battlefield' && p.ChangeType)));
    let moved = [];
    const moveOpts = (c) => {
      const o = { cause: sa, tapped: p.Tapped === 'True' };
      if (dest === 'battlefield' && p.GainControl === 'True') o.controller = sa.controller;
      if (dest === 'battlefield' && p.GainControl !== 'True') o.controller = c.owner;
      if (dest === 'library') o.pos = p.LibraryPosition === '-1' ? 'bottom' : (p.LibraryPosition && +p.LibraryPosition > 0 ? +p.LibraryPosition : 'top');
      if (dest === 'exile') o.exiledWith = sa.host.lki ? sa.host.id : sa.host.id;
      if (dest === 'exile' && (p.ExileFaceDown === 'True' || p.FaceDown === 'True')) o.faceDown = true;
      if (dest === 'battlefield' && p.FaceDown === 'True') o.faceDown = true;
      if (dest === 'battlefield' && p.Transformed === 'True') o.transformed = true;
      if (p.AttachedTo && dest === 'battlefield') { const t = resolveDefined(game, p.AttachedTo, ctx)[0]; if (t) o.attachTo = t.isPlayer ? 'p' + t.id : t.id; }
      return o;
    };
    const after = async (c, from) => {
      if (!c) return;
      if (dest === 'battlefield') {
        if (p.WithCountersType) await game.addCounters(c, normalizeCounter(p.WithCountersType), p.WithCountersAmount ? calc(game, p.WithCountersAmount, sa) : 1, sa, { etb: true });
        if (p.Attacking && game.combat) {
          const d = attackingFromSpec(game, sa, p.Attacking);
          if (d != null) game.combat.attackers.push({ card: c.id, defenderPlayer: d, defenderCard: null, blockers: [], blocked: false });
        }
        if (p.Unearth === 'True') {
          c.temp.push({ keywords: ['Haste'], until: 'Permanent' });
          c.exileIfLeaves = true;
          game.delayed.push({ id: game.uid++, p: { Mode: 'Phase', Phase: 'End of Turn', Execute: 'UnearthExile' }, svars: { UnearthExile: 'DB$ ChangeZone | Defined$ DelayTriggerRemembered | Origin$ Battlefield | Destination$ Exile' }, host: c, controller: sa.controller, remembered: [c], turn: game.turnNumber, thisTurnOnly: true });
        }
        if (p.AddKeywords) c.temp.push({ keywords: kwList(p.AddKeywords), until: 'Permanent' });
      }
      if (p.RememberChanged === 'True' || p.RememberChangedCard === 'True') remember(sa, [c]);
      if (p.Imprint === 'True') { sa.host.imprinted = sa.host.imprinted || []; sa.host.imprinted.push(c); }
      if (p.ForgetChanged === 'True' && sa.host.remembered) sa.host.remembered = sa.host.remembered.filter(x => x !== c);
      moved.push(c);
    };
    if (!hidden) {
      const rawList = objs(game, sa, 'Self');
      for (const e of rawList.filter(o => o && o.isEffect)) { game.effects = game.effects.filter(x => x !== e); game.touch(); }
      // (a targeted spell is its card: "exile target spell" — Spell Queller)
      let list = cardsOf(rawList.map(o => o && o.stackItem && o.card ? o.card : o));
      if (p.Origin) list = list.filter(c => origins.includes(c.zone) || (p.Origin === 'Any'));
      if (sa.p.Optional === 'True' && list.length) {
        const yes = await game.ask(sa.controller, { type: 'confirm', prompt: `${desc(game, sa)}?`, purpose: 'optional', sa });
        if (!yes) return;
      }
      game.beginBatch();
      for (const c of list) {
        if (c.zone === 'gone') continue;
        const from = c.zone;
        if (p.RememberLKI === 'True') remember(sa, [c.zone === 'battlefield' ? game.makeLKI(c) : c]);
        if (dest === 'library' && p.Shuffle === 'True') { await game.moveCard(c, 'library', { ...moveOpts(c), pos: 'top' }); game.shuffle(game.players[c.owner], sa); moved.push(c); continue; }
        const r = await game.moveCard(c, dest, moveOpts(c));
        await after(r, from);
      }
      await game.endBatch();
      if (dest === 'library' && p.Shuffle === 'True') for (const pl of new Set(list.map(c => c.owner))) game.shuffle(game.players[pl], sa);
      return;
    }
    // hidden-zone search / choice
    const players = p.DefinedPlayer ? playersOf(resolveDefined(game, p.DefinedPlayer, ctx)) : (hasTgtSpec(sa) && sa.targets.length && sa.targets[0].isPlayer ? playersOf(sa.targets) : [game.players[sa.controller]]);
    for (const pl of players) {
      const chooserP = p.Chooser ? playersOf(resolveDefined(game, p.Chooser, { ...ctx, you: sa.controller }))[0] : pl;
      const chooser = chooserP ? chooserP.id : pl.id;
      const fctx = { ...ctx, you: pl.id };
      let pool = [];
      for (const o of origins) {
        if (o === 'battlefield') pool.push(...game.battlefield.filter(c => c.controller === pl.id));
        else pool.push(...(pl[o] || []));
      }
      const ctype = (p.ChangeType || 'Card').replace(/\bLand\.IsRemembered\b/, 'Card.IsRemembered');
      pool = pool.filter(c => matchValid(game, c, ctype, fctx));
      let n = p.ChangeNum === 'All' ? pool.length : num(game, sa, 'ChangeNum', 1);
      const mandatory = p.Mandatory === 'True' || origins[0] === 'battlefield';
      if (sa.p.Optional === 'True' && !mandatory) {
        const yes = await game.ask(pl.id, { type: 'confirm', prompt: `${desc(game, sa)}?`, purpose: 'optionalSearch', sa });
        if (!yes) { if (origins.includes('library') && p.Shuffle !== 'False') game.shuffle(pl, sa); continue; }
      }
      let chosen;
      if (p.AtRandom === 'True') { const tmp = pool.slice(); game.rng.shuffle(tmp); chosen = tmp.slice(0, n); }
      else {
        let prompt = p.SelectPrompt || `Choose ${p.ChangeNum === 'All' ? 'any number of' : mandatory ? n : 'up to ' + n} ${p.ChangeTypeDesc || 'card'}${n > 1 ? 's' : ''} (${origins.join('/')} → ${dest})`;
        chosen = await chooseCards(game, chooser, pool, mandatory ? Math.min(n, pool.length) : 0, n, prompt, sa, 'search' + (dest === 'battlefield' ? 'Battlefield' : dest === 'hand' ? 'Hand' : ''), { reveal: true, dest });
        if (p.ShareLandType === 'True' && chosen.length > 1) {
          const t0 = [...game.chars(chosen[0]).subtypes].filter(t => BASIC_LAND_TYPES[t]);
          chosen = [chosen[0], ...chosen.slice(1).filter(c => [...game.chars(c).subtypes].some(t => t0.includes(t)))];
        }
        if (p.DifferentNames === 'True') { const seen = new Set(); chosen = chosen.filter(c => { const nm = game.name(c); if (seen.has(nm)) return false; seen.add(nm); return true; }); }
      }
      game.beginBatch();
      for (const c of chosen) {
        const from = c.zone;
        const r = await game.moveCard(c, dest, moveOpts(c));
        await after(r, from);
      }
      await game.endBatch();
      if (chosen.length && dest !== 'battlefield' && origins.includes('library')) game.log(`${pl.name} searches their library${dest === 'hand' ? ' and puts ' + chosen.length + ' card(s) into their hand' : ''}.`);
      if (origins.includes('library')) game.fire('SearchedLibrary', { Player: chooser, Searched: pl.id, SearchOwn: chooser === pl.id });
      if (origins.includes('library') && p.Shuffle !== 'False') game.shuffle(pl, sa);
    }
  },

  async ChangeZoneAll(game, sa) {
    const p = sa.p;
    const ctx = ctxOf(game, sa);
    const origins = (p.Origin || 'Battlefield').split(',').map(Z);
    const dest = Z(p.Destination || 'Graveyard');
    let players = null;
    if (hasTgtSpec(sa)) players = playersOf(sa.targets);
    else if (p.Defined) players = playersOf(resolveDefined(game, p.Defined, ctx));
    let pool = [];
    for (const o of origins) {
      if (o === 'battlefield') pool.push(...game.battlefield.filter(c => !players || players.some(pl => pl.id === c.controller)));
      else for (const pl of players || game.livingPlayers()) pool.push(...(pl[o] || []));
    }
    pool = pool.filter(c => matchValid(game, c, p.ChangeType || 'Card', ctx));
    if (sa.p.Optional === 'True' && pool.length) {
      const yes = await game.ask(sa.controller, { type: 'confirm', prompt: `${desc(game, sa)}?`, purpose: 'optional', sa });
      if (!yes) return;
    }
    game.beginBatch();
    const moved = [];
    for (const c of pool) {
      const o = { cause: sa, tapped: p.Tapped === 'True', silent: pool.length > 4 };
      if (dest === 'battlefield') o.controller = p.GainControl === 'True' ? sa.controller : c.owner;
      if (dest === 'library') o.pos = p.LibraryPosition === '-1' ? 'bottom' : 'top';
      if (dest === 'exile') o.exiledWith = sa.host.id;
      const r = await game.moveCard(c, dest, o);
      if (r) moved.push(r);
    }
    await game.endBatch();
    if (pool.length > 4) game.log(`${desc(game, sa)} (${pool.length} cards)`);
    if (p.RememberChanged === 'True') remember(sa, moved);
    if (dest === 'library' && p.Shuffle !== 'False') for (const pl of new Set(pool.map(c => c.owner))) game.shuffle(game.players[pl], sa);
  },

  async Token(game, sa) {
    const p = sa.p;
    const ctx = ctxOf(game, sa);
    const owners = playersOf(resolveDefined(game, p.TokenOwner || 'You', ctx));
    const scripts = (p.TokenScript || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!scripts.length) { game.log(`Token effect without a token script: ${desc(game, sa)}`, { type: 'unsupported' }); return; }
    const n = num(game, sa, 'TokenAmount', 1);
    const made = [];
    for (const o of owners.length ? owners : [game.players[sa.controller]]) {
      for (const s of scripts) {
        const toks = await makeTokens(game, sa, s, o.id, n, {
          tapped: p.TokenTapped === 'True',
          attacking: p.TokenAttacking ? attackingFromSpec(game, sa, p.TokenAttacking) : null,
          power: p.TokenPower != null ? calc(game, p.TokenPower, sa) : null,
          toughness: p.TokenToughness != null ? calc(game, p.TokenToughness, sa) : null,
          keywords: kwList(p.PumpKeywords),
          pumpDuration: p.PumpDuration === 'EOT' ? 'EOT' : (p.PumpDuration ? 'Permanent' : 'EOT'),
          counters: p.WithCountersType ? { type: normalizeCounter(p.WithCountersType), n: p.WithCountersAmount ? calc(game, p.WithCountersAmount, sa) : 1 } : null,
        });
        made.push(...toks);
      }
    }
    if (p.RememberTokens === 'True' || p.RememberObjects === 'Created') remember(sa, made);
    if (p.ImprintTokens === 'True') { sa.host.imprinted = (sa.host.imprinted || []).concat(made); }
    if (p.AtEOT) for (const t of made) game.delayed.push({ id: game.uid++, p: { Mode: 'Phase', Phase: 'End of Turn', Execute: 'Do' }, svars: { Do: p.AtEOT === 'Sacrifice' ? 'DB$ Sacrifice | Defined$ DelayTriggerRemembered' : 'DB$ ChangeZone | Defined$ DelayTriggerRemembered | Origin$ Battlefield | Destination$ Exile' }, host: t, controller: sa.controller, remembered: [t], turn: game.turnNumber, thisTurnOnly: true });
    sa.root().createdTokens = made;
  },

  async PutCounter(game, sa) {
    const p = sa.p;
    let list = objs(game, sa, 'Self');
    if (sa.etbCard && (!p.Defined || p.Defined === 'Self') && !hasTgtSpec(sa)) list = [sa.etbCard];
    let type = normalizeCounter(p.CounterType || 'P1P1');
    // "each kind of counter on <source>": copy every counter kind and amount
    if (p.CounterType === 'EachFromSource') {
      const src = resolveDefined(game, p.EachFromSource || 'Self', ctxOf(game, sa)).map(o => o && o.lki ? (liveOrLki(game, o) || o) : o).find(o => o && o.counters);
      const kinds = src ? Object.entries(src.counters).filter(([, k]) => k > 0) : [];
      for (const o of list) for (const [k, amt] of kinds) if (o && (o.isCard || o.isPlayer)) await game.addCounters(o.lki ? o.card || o : o, k, amt, sa);
      return;
    }
    // a choice between counter kinds ("a +1/+1, first strike, or vigilance counter")
    if (p.CounterType && p.CounterType.includes(',') && !p.CounterTypes) {
      const opts = [...new Set(p.CounterType.split(',').map(normalizeCounter))];
      type = await game.ask(sa.controller, { type: 'option', prompt: 'Choose a counter', options: opts.map(o => ({ label: counterLabel(o), value: o })), purpose: 'counterType', sa });
      if (!opts.includes(type)) type = opts[0];
    }
    if (p.CounterType === 'ExistingCounter' || p.CounterTypes) {
      const opts = [...new Set(p.CounterTypes ? p.CounterTypes.split(',').map(normalizeCounter) : Object.keys(list[0] && list[0].counters || {}).filter(k => list[0].counters[k] > 0))];
      if (opts.length) type = opts.length === 1 ? opts[0] : await game.ask(sa.controller, { type: 'option', prompt: 'Choose a counter type', options: opts.map(o => ({ label: counterLabel(o), value: o })), purpose: 'counterType', sa });
    }
    const n = num(game, sa, 'CounterNum', 1);
    if (p.Monstrosity) {
      const mn = p.Monstrosity === 'True' ? n : calc(game, p.Monstrosity, sa);
      for (const c of cardsOf(list)) { if (c.monstrous) continue; await game.addCounters(c, 'P1P1', mn, sa); c.monstrous = true; game.fire('BecomeMonstrous', { Card: c }); }
      return;
    }
    if (p.Adapt === 'True') { for (const c of cardsOf(list)) if (!(c.counters.P1P1 > 0)) await game.addCounters(c, 'P1P1', n, sa); return; }
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      const amt = sa.division ? sa.division[i] : n;
      if (o.isPlayer) await game.addCounters(o, type, amt, sa);
      else if (o.isCard) await game.addCounters(o, type, amt, sa, { etb: !!p.ETB && sa.etbCard === o });
    }
    if (p.Renown === 'True') for (const c of cardsOf(list)) { c.renowned = true; game.fire('BecomeRenowned', { Card: c, Player: c.controller }); }
    if (p.RememberCards === 'True') remember(sa, list);
  },

  async PutCounterAll(game, sa) {
    const ctx = ctxOf(game, sa);
    const n = num(game, sa, 'CounterNum', 1);
    for (const c of game.battlefield.filter(c => matchValid(game, c, sa.p.ValidCards || 'Card', ctx))) await game.addCounters(c, normalizeCounter(sa.p.CounterType), n, sa);
    if (sa.p.ValidCards2) for (const c of game.battlefield.filter(c => matchValid(game, c, sa.p.ValidCards2, ctx))) await game.addCounters(c, normalizeCounter(sa.p.CounterType2), n, sa);
  },

  async RemoveCounter(game, sa) {
    const list = objs(game, sa, 'Self');
    for (const o of list) {
      if (!o || !o.counters) continue;
      let type = sa.p.CounterType ? normalizeCounter(sa.p.CounterType) : null;
      if (!type || type === 'ANY' || sa.p.CounterType === 'Any') { const ks = Object.keys(o.counters).filter(k => o.counters[k] > 0); type = ks[0]; }
      if (!type) continue;
      const n = sa.p.CounterNum === 'All' ? (o.counters[type] || 0) : num(game, sa, 'CounterNum', 1);
      const r = await game.removeCounters(o, type, n);
      if (sa.p.RememberRemoved === 'True') sa.root().removedCounters = r;
    }
  },
  async RemoveCounterAll(game, sa) {
    const ctx = ctxOf(game, sa);
    for (const c of game.battlefield.filter(c => matchValid(game, c, sa.p.ValidCards || 'Card', ctx))) {
      const t = normalizeCounter(sa.p.CounterType);
      await game.removeCounters(c, t, sa.p.AllCounters === 'True' || sa.p.CounterNum === 'All' ? (c.counters[t] || 0) : num(game, sa, 'CounterNum', 1));
    }
  },

  async MultiplyCounter(game, sa) {
    const list = cardsOf(objs(game, sa, 'Self'));
    const mult = num(game, sa, 'Multiplier', 2);
    for (const c of list) {
      const types = sa.p.CounterType ? [normalizeCounter(sa.p.CounterType)] : Object.keys(c.counters).filter(k => c.counters[k] > 0);
      for (const t of types) { const have = c.counters[t] || 0; if (have > 0) await game.addCounters(c, t, have * (mult - 1), sa); }
    }
  },

  async MoveCounter(game, sa) {
    const src = cardsOf(resolveDefined(game, sa.p.Source || 'Self', ctxOf(game, sa)))[0];
    const dst = cardsOf(objs(game, sa, 'Self')).find(c => c !== src);
    if (!src || !dst) return;
    const t = normalizeCounter(sa.p.CounterType || 'P1P1');
    const n = sa.p.CounterNum === 'All' ? (src.counters[t] || 0) : num(game, sa, 'CounterNum', 1);
    const r = await game.removeCounters(src, t, n);
    if (r > 0) await game.addCounters(dst, t, r, sa);
  },

  async Proliferate(game, sa) {
    const pid = sa.controller;
    // "if you would proliferate, proliferate twice instead"
    const rp = await game.applySimpleReplacement('Proliferate', { Affected: game.players[pid], Player: pid, Num: 1 }, sa);
    const times = rp ? Math.max(1, rp.Num || 1) : 1;
    for (let k = 0; k < times; k++) await proliferateOnce(game, sa, pid);
  },

  async Pump(game, sa) {
    const p = sa.p;
    let list = objs(game, sa, 'Self');
    if (sa.etbCard && (!p.Defined || p.Defined === 'Self') && !hasTgtSpec(sa)) list = [sa.etbCard];
    // "double its power and toughness" (Okaun, Unnatural Growth): +X/+X where X is what it has now
    const dblA = /^\+?Double$/.test(p.NumAtt || ''), dblD = /^\+?Double$/.test(p.NumDef || '');
    const a0 = p.NumAtt != null && !dblA ? calc(game, p.NumAtt, sa) : 0;
    const d0 = p.NumDef != null && !dblD ? calc(game, p.NumDef, sa) : 0;
    let kws = kwList(p.KW);
    if (p.KWChoice || p.Choices && p.KWChoice !== undefined) { /* ignore */ }
    // "Landwalk:ChosenType", "Hexproof:ChosenColor" with DefinedKW$ ChosenType / ChosenColor: what the source chose
    const chosen = sa.host && sa.host.chosen;
    if (p.DefinedKW === 'ChosenType') kws = chosen && chosen.type ? kws.map(k => k.replace(/ChosenType/g, chosen.type)) : [];
    else if (p.DefinedKW === 'ChosenColor') {
      const name = chosen && chosen.colors && chosen.colors.length ? COLOR_NAMES[chosen.colors[0]] : null;
      const Name = name && name[0].toUpperCase() + name.slice(1);
      // (hexproof from a color is "Hexproof:Card.Blue:blue" here)
      kws = name ? kws.map(k => k === 'Hexproof:ChosenColor' ? `Hexproof:Card.${Name}:${name}` : k.replace(/ChosenColor/g, Name)) : [];
    }
    // "Protection:Player.PlayerUID_ChosenPlayerUID:ChosenPlayerName" with DefinedKW$ <player>: fill in that player
    else if (p.DefinedKW) {
      const who = playersOf(resolveDefined(game, p.DefinedKW, ctxOf(game, sa)))[0];
      kws = who ? kws.map(k => k.replace(/ChosenPlayerUID/g, String(who.id)).replace(/ChosenPlayerName/g, who.name)) : kws.filter(k => !/ChosenPlayer/.test(k));
    }
    for (const o of list) {
      if (!o) continue;
      if (o.isPlayer) {
        if (kws.length) { const rec = { keywords: kws }; applyDuration(game, sa, o, rec); o.temp = (o.temp || []).concat([rec]); game.touch(); game.log(`${o.name} gains ${kws.join(', ')}.`); }
        continue;
      }
      // ("PumpZone$ Exile": a card in another zone, Jhoira of the Ghitu giving an exiled card suspend)
      const zones = p.PumpZone ? p.PumpZone.split(',').map(z => zoneMap[z] || z.toLowerCase()) : ['battlefield'];
      if (!zones.includes(o.zone) && !o.lki) continue;
      const c = o.lki ? o.card : o;
      if (!c || !zones.includes(c.zone)) continue;
      const cch = game.chars(c);
      const a = dblA ? cch.power : a0, d = dblD ? cch.toughness : d0;
      const rec = { power: a, toughness: d, keywords: kws.filter(k => k !== 'HIDDEN'), removeKeywords: p.KWRemove ? kwList(p.KWRemove) : null };
      if (p.CanBlockAmount != null || p.CanBlockAny != null) Object.assign(rec, pumpBlockExtras(game, sa));
      applyDuration(game, sa, c, rec);
      c.temp.push(rec);
      game.touch();
      const parts = [];
      if (a || d) parts.push(`${a >= 0 ? '+' : ''}${a}/${d >= 0 ? '+' : ''}${d}`);
      if (kws.length) parts.push(kws.join(', '));
      if (parts.length) game.log(`${game.name(c)} gets ${parts.join(' and ')}${rec.until === 'EOT' ? ' until end of turn' : ''}.`, { type: 'pump' });
    }
  },

  async PumpAll(game, sa) {
    const p = sa.p;
    const ctx = ctxOf(game, sa);
    const a = p.NumAtt != null ? calc(game, p.NumAtt, sa) : 0;
    const d = p.NumDef != null ? calc(game, p.NumDef, sa) : 0;
    const kws = kwList(p.KW);
    let list = game.battlefield.filter(c => matchValid(game, c, p.ValidCards || 'Creature', ctx));
    if (hasTgtSpec(sa) && sa.targets.length && sa.targets[0].isPlayer) list = list.filter(c => sa.targets.some(t => t.id === c.controller));
    for (const c of list) { const rec = { power: a, toughness: d, keywords: kws }; applyDuration(game, sa, c, rec); c.temp.push(rec); }
    game.touch();
    game.log(`${desc(game, sa)} (${list.length} creature${list.length === 1 ? '' : 's'})`, { type: 'pump' });
  },

  async DealDamage(game, sa) {
    const p = sa.p;
    const ctx = ctxOf(game, sa);
    const n = num(game, sa, 'NumDmg', 0);
    let list = objs(game, sa, null);
    if (!hasTgtSpec(sa) && !p.Defined) list = [];
    const srcList = p.DamageSource ? resolveDefined(game, p.DamageSource, ctx) : [sa.host];
    const source = srcList[0] || sa.host;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      const amt = sa.division ? sa.division[i] : n;
      if (!t) continue;
      await game.dealDamage(source.lki ? source : source, t.lki ? t.card : t, amt, {});
    }
    if (p.RememberDamaged === 'True') remember(sa, list);
  },

  async DamageAll(game, sa) {
    const p = sa.p;
    const ctx = ctxOf(game, sa);
    const n = num(game, sa, 'NumDmg', 0);
    const srcList = p.DamageSource ? resolveDefined(game, p.DamageSource, ctx) : [sa.host];
    const source = srcList[0] || sa.host;
    const cards = p.ValidCards ? game.battlefield.filter(c => matchValid(game, c, p.ValidCards, ctx)) : [];
    let players = p.ValidPlayers ? game.livingPlayers().filter(pl => matchValid(game, pl, p.ValidPlayers, ctx)) : [];
    if (hasTgtSpec(sa) && sa.targets.length && sa.targets[0].isPlayer) { const tp = sa.targets.map(t => t.id); for (let i = cards.length - 1; i >= 0; i--) if (!tp.includes(cards[i].controller)) cards.splice(i, 1); }
    game.beginDamageBatch();
    for (const c of cards) await game.dealDamage(source, c, n, {});
    for (const pl of players) await game.dealDamage(source, pl, n, {});
    game.endDamageBatch();
  },

  async GainLife(game, sa) {
    const n = num(game, sa, 'LifeAmount', 0);
    for (const pl of playersOf(objs(game, sa, 'You'))) await game.gainLife(pl, n, sa);
  },
  async LoseLife(game, sa) {
    const n = num(game, sa, 'LifeAmount', 0);
    let list = playersOf(objs(game, sa, 'You'));
    let total = 0;
    for (const pl of list) total += await game.loseLife(pl, n, sa);
    sa.root().lifeLost = total;
    storeSVar(sa, 'AFLifeLost', String(total));
  },
  async SetLife(game, sa) {
    const n = num(game, sa, 'LifeAmount', 0);
    for (const pl of playersOf(objs(game, sa, 'You'))) { const diff = n - pl.life; if (diff > 0) await game.gainLife(pl, diff, sa); else if (diff < 0) await game.loseLife(pl, -diff, sa); }
  },
  async ExchangeLife(game, sa) {
    const list = playersOf(objs(game, sa, 'You'));
    const both = list.length >= 2 ? list : [game.players[sa.controller], ...list];
    if (both.length < 2) return;
    const [a, b] = both;
    const la = a.life, lb = b.life;
    a.life = lb; b.life = la; game.touch();
    game.log(`${a.name} and ${b.name} exchange life totals.`);
  },
  async ExtortDrain(game, sa) {
    let total = 0;
    for (const o of game.opponents(sa.controller)) total += await game.loseLife(o, 1, sa);
    await game.gainLife(game.players[sa.controller], total, sa);
  },

  async Tap(game, sa) {
    let list = cardsOf(objs(game, sa, 'Self'));
    if (sa.p.ETB === 'True' && sa.etbCard) { if (!sa.p.Defined || sa.p.Defined === 'Self' || list.includes(sa.etbCard) || sa.p.Defined === 'ReplacedCard') { sa.etbCard.tapped = true; game.touch(); } return; }
    if (sa.p.TapType || sa.p.CardChoices) {
      const pool = game.battlefield.filter(c => !c.tapped && matchValid(game, c, sa.p.TapType || sa.p.CardChoices, ctxOf(game, sa)));
      list = await chooseCards(game, sa.controller, pool, 0, num(game, sa, 'Amount', 1), 'Choose permanents to tap', sa, 'tap');
    }
    for (const c of list) if (c.zone === 'battlefield') await game.tap(c);
    if (list.length) game.log(`${list.map(c => game.name(c)).join(', ')} ${list.length > 1 ? 'are' : 'is'} tapped.`);
  },
  async TapAll(game, sa) {
    const ctx = ctxOf(game, sa);
    let list = game.battlefield.filter(c => matchValid(game, c, sa.p.ValidCards || 'Card', ctx));
    if (hasTgtSpec(sa) && sa.targets.length && sa.targets[0].isPlayer) list = list.filter(c => sa.targets.some(t => t.id === c.controller));
    for (const c of list) await game.tap(c);
  },
  async Untap(game, sa) {
    if (sa.p.UntapType) {
      const ctx = ctxOf(game, sa);
      const pool = game.battlefield.filter(c => c.tapped && c.controller === sa.controller && matchValid(game, c, sa.p.UntapType, ctx));
      const n = num(game, sa, 'Amount', 1);
      const list = await chooseCards(game, sa.controller, pool, sa.p.UntapUpTo === 'True' ? 0 : Math.min(n, pool.length), n, `Untap up to ${n}`, sa, 'untap');
      for (const c of list) await game.untap(c);
      return;
    }
    for (const c of cardsOf(objs(game, sa, 'Self'))) if (c.zone === 'battlefield') await game.untap(c);
  },
  async UntapAll(game, sa) {
    const ctx = ctxOf(game, sa);
    let list = game.battlefield.filter(c => matchValid(game, c, sa.p.ValidCards || 'Card', ctx));
    if (sa.p.Defined) { const pl = playersOf(resolveDefined(game, sa.p.Defined, ctx)).map(x => x.id); list = list.filter(c => pl.includes(c.controller)); }
    for (const c of list) await game.untap(c);
  },

  async Sacrifice(game, sa) {
    const p = sa.p;
    const ctx = ctxOf(game, sa);
    const def = objs(game, sa, 'You');
    const cards = cardsOf(def);
    if (cards.length && !p.SacValid) {
      for (const c of cards) if (c.zone === 'battlefield') { if (p.RememberSacrificed === 'True') remember(sa, [game.makeLKI(c)]); await game.sacrifice(c, sa); }
      return;
    }
    const valid = (p.SacValid || 'Card.Self').replace(/CARDNAME/g, 'Card.Self').replace(/^Self$/, 'Card.Self'); // "SacValid$ Self" (Uro)
    // "SacEachValid$ True": one of each kind ("an artifact creature and a nonartifact creature")
    const kinds = p.SacEachValid === 'True' ? valid.split(' & ') : [valid];
    for (const pl of playersOf(def.length ? def : [game.players[sa.controller]])) {
      const chosen = [];
      for (const kind of kinds) {
        const pool = game.battlefield.filter(c => c.controller === pl.id && !chosen.includes(c) && matchValid(game, c, kind, { ...ctx, you: pl.id }) && !game.cantSacrifice(c, sa));
        const n = p.Amount === 'All' ? pool.length : num(game, sa, 'Amount', 1);
        if (!pool.length) continue;
        if (kind === 'Card.Self') chosen.push(...pool.filter(c => c.id === sa.host.id));
        else chosen.push(...await chooseCards(game, pl.id, pool, p.Optional === 'True' ? 0 : Math.min(n, pool.length), n, `Sacrifice ${n}: ${p.SacMessage || kind}`, sa, 'sacrifice'));
      }
      if (!chosen.length) continue;
      game.beginBatch();
      for (const c of chosen) {
        const lki = game.makeLKI(c);
        await game.sacrifice(c, sa);
        if (p.RememberSacrificed === 'True') remember(sa, [lki]);
        sa.root().paid.Sacrificed.push(lki);
        if (p.Exploit === 'True') game.fire('Exploited', { Card: lki, Exploiter: sa.host, Player: pl.id });
      }
      await game.endBatch();
    }
  },
  async SacrificeAll(game, sa) {
    const ctx = ctxOf(game, sa);
    let list = game.battlefield.filter(c => matchValid(game, c, sa.p.ValidCards || 'Card', ctx));
    if (sa.p.Defined) {
      // Defined$ names either players (sacrifice what they control) or the permanents themselves
      const objs2 = resolveDefined(game, sa.p.Defined, ctx);
      const pl = playersOf(objs2).map(x => x.id);
      const cs = new Set(objs2.filter(o => o && !o.isPlayer).map(o => liveOrLki(game, o)).filter(c => c && c.isCard && c.zone === 'battlefield').map(c => c.id));
      list = list.filter(c => pl.includes(c.controller) || cs.has(c.id));
    }
    game.beginBatch();
    for (const c of list) { const lki = game.makeLKI(c); await game.sacrifice(c, sa); if (sa.p.RememberSacrificed === 'True') remember(sa, [lki]); }
    await game.endBatch();
  },

  async Mill(game, sa) {
    const n = num(game, sa, 'NumCards', 1);
    for (const pl of playersOf(objs(game, sa, 'You'))) {
      const cards = await game.mill(pl, n, sa);
      if (sa.p.RememberMilled === 'True') remember(sa, cards);
    }
  },

  async Scry(game, sa) {
    const n = num(game, sa, 'ScryNum', 1);
    for (const pl of playersOf(objs(game, sa, 'You'))) await scry(game, pl.id, n, sa);
  },
  async Surveil(game, sa) {
    const n = num(game, sa, 'Amount', 1);
    for (const pl of playersOf(objs(game, sa, 'You'))) await surveil(game, pl.id, n, sa);
  },

  async Dig(game, sa) {
    const p = sa.p;
    const ctx = ctxOf(game, sa);
    const owners = playersOf(objs(game, sa, 'You'));
    for (const pl of owners.length ? owners : [game.players[sa.controller]]) {
      const n = num(game, sa, 'DigNum', 1);
      const top = pl.library.slice(0, n);
      if (!top.length) continue;
      const chooser = sa.controller;
      const eligible = top.filter(c => matchValid(game, c, p.ChangeValid || 'Card', { ...ctx, you: chooser }));
      let count = p.ChangeNum === 'All' ? eligible.length : num(game, sa, 'ChangeNum', 1);
      const anyNum = p.AnyNumber === 'True';
      const optional = p.Optional === 'True' || anyNum || !!p.ChangeValid;
      const dest = Z(p.DestinationZone || 'Hand');
      const dest2 = Z(p.DestinationZone2 || 'Library');
      let picked;
      if (p.ChangeNum === 'All' && !anyNum) picked = eligible;
      else if (p.NoMove === 'True') picked = [];
      else picked = await chooseCards(game, chooser, eligible, optional ? 0 : Math.min(count, eligible.length), anyNum ? eligible.length : count, `Look at the top ${n}: choose ${anyNum ? 'any number' : count} to put into ${dest}${p.ChangeValid ? ' (' + (p.ChangeValidDesc || p.ChangeValid) + ')' : ''}`, sa, 'dig' + (dest === 'hand' ? 'Hand' : dest === 'battlefield' ? 'Battlefield' : ''), { reveal: true, shown: top.map(c => c.id) });
      const rest = top.filter(c => !picked.includes(c));
      game.beginBatch();
      for (const c of picked) {
        const o = { cause: sa, tapped: p.Tapped === 'True' };
        if (dest === 'battlefield') o.controller = p.GainControl === 'True' ? sa.controller : c.owner;
        if (dest === 'library') o.pos = p.LibraryPosition === '-1' ? 'bottom' : 'top';
        if (dest === 'exile') { o.exiledWith = sa.host.id; if (p.ExileFaceDown === 'True') o.faceDown = true; }
        const r = await game.moveCard(c, dest, o);
        if (r && (p.RememberChanged === 'True' || p.ExiledWithSource === 'True')) remember(sa, [r]);
        if (r && p.Imprint === 'True') sa.host.imprinted = (sa.host.imprinted || []).concat([r]);
      }
      if (rest.length) {
        if (p.RestRandomOrder === 'True') game.rng.shuffle(rest);
        for (const c of rest) {
          if (dest2 === 'library') {
            const pos = p.LibraryPosition2 === '0' ? 'top' : 'bottom';
            pl.library.splice(pl.library.indexOf(c), 1);
            if (pos === 'top') pl.library.unshift(c); else pl.library.push(c);
          } else await game.moveCard(c, dest2, { cause: sa, exiledWith: sa.host.id });
        }
      }
      await game.endBatch();
      game.touch();
      if (p.RememberRevealed === 'True') remember(sa, top);
      if (picked.length && dest === 'hand') game.log(`${pl.name} puts ${picked.length} card${picked.length > 1 ? 's' : ''} into their hand${p.Reveal === 'True' ? ': ' + picked.map(c => game.name(c)).join(', ') : ''}.`);
    }
  },

  async SkipPhase(game, sa) {
    const name = sa.p.Step || sa.p.Phase || 'Untap';
    const map = { Untap: ['untap'], Upkeep: ['upkeep'], Draw: ['draw'], Main: ['main1', 'main2'], Main1: ['main1'], Main2: ['main2'], BeginCombat: ['beginCombat'], Combat: ['beginCombat'], End: ['end'] };
    const label = { Untap: 'their untap step', Upkeep: 'their upkeep', Draw: 'their draw step', Main: 'their main phase', BeginCombat: 'combat', Combat: 'combat', End: 'their end step' }[name] || name;
    for (const pl of playersOf(objs(game, sa, 'You'))) {
      pl.skips = pl.skips || [];
      pl.skips.push({ steps: map[name] || [name.toLowerCase()], thisTurn: sa.p.Duration === 'EndOfTurn', turn: game.turnNumber, label });
      game.log(`${pl.name} will skip ${sa.p.Duration === 'EndOfTurn' ? '' : 'their next '}${label.replace('their ', '')}${sa.p.Duration === 'EndOfTurn' ? ' this turn' : ''}.`);
    }
  },

  async ReverseTurnOrder(game) {
    game.turnDir = -(game.turnDir || 1);
    game.log('Turn order is reversed.');
  },

  async DigMultiple(game, sa) {
    const p = sa.p;
    const ctx = ctxOf(game, sa);
    const pl = game.players[sa.controller];
    const n = num(game, sa, 'DigNum', 1);
    const top = pl.library.slice(0, n);
    if (!top.length) return;
    const alts = (p.ChangeValid || 'Card').split(',');
    const fits = (c, a) => matchValid(game, c, a, ctx);
    const eligible = top.filter(c => alts.some(a => fits(c, a)));
    const raw = await chooseCards(game, sa.controller, eligible, 0, Math.min(alts.length, eligible.length), `Look at the top ${n}: choose up to one card for each of: ${alts.map(a => humanValid(a)).join(', ')}`, sa, 'digHand', { reveal: true, shown: top.map(c => c.id) });
    // keep a subset where each card covers a distinct requirement (bipartite matching)
    const owner = new Map();
    const tryAssign = (c, seen) => {
      for (let i = 0; i < alts.length; i++) {
        if (seen.has(i) || !fits(c, alts[i])) continue;
        seen.add(i);
        if (!owner.has(i) || tryAssign(owner.get(i), seen)) { owner.set(i, c); return true; }
      }
      return false;
    };
    const picked = raw.filter(c => tryAssign(c, new Set()));
    let toField = [];
    if (p.ChosenZone && picked.length) {
      const k = Math.min(num(game, sa, 'ChooseAmount', 1), picked.length);
      toField = k === picked.length ? picked.slice() : await chooseCards(game, sa.controller, picked, k, k, `Choose ${k} to put onto the ${Z(p.ChosenZone)}`, sa, 'digBattlefield');
    }
    const dest = Z(p.DestinationZone || 'Hand'), dest2 = Z(p.DestinationZone2 || 'Library');
    const rest = top.filter(c => !picked.includes(c));
    game.beginBatch();
    for (const c of toField) await game.moveCard(c, Z(p.ChosenZone), { cause: sa, controller: sa.controller });
    for (const c of picked.filter(c => !toField.includes(c))) await game.moveCard(c, dest, { cause: sa });
    if (p.RestRandomOrder === 'True') game.rng.shuffle(rest);
    for (const c of rest) {
      if (dest2 === 'library') { pl.library.splice(pl.library.indexOf(c), 1); if (p.LibraryPosition === '0') pl.library.unshift(c); else pl.library.push(c); }
      else await game.moveCard(c, dest2, { cause: sa });
    }
    await game.endBatch();
    if (picked.length) game.log(`${pl.name} takes ${picked.map(c => game.name(c)).join(', ')}.`);
    game.touch();
  },

  async EachDamage(game, sa) {
    const p = sa.p;
    const ctx = ctxOf(game, sa);
    const damagers = (p.DefinedDamagers ? resolveDefined(game, p.DefinedDamagers, ctx) : game.battlefield.filter(c => matchValid(game, c, p.ValidCards || 'Creature', ctx)))
      .map(c => c && c.lki ? (liveOrLki(game, c) || c) : c).filter(c => c && c.isCard);
    const victims = p.EachToItself === 'True' ? null : objs(game, sa, null).filter(Boolean);
    game.beginDamageBatch();
    for (const d of damagers) {
      const amt = calcCtx(game, p.NumDmg || '0', { ...ctx, host: d });
      if (amt <= 0) continue;
      for (const t of victims || [d]) {
        const tt = t.lki ? t.card : t;
        if (tt && (tt.isPlayer || tt.zone === 'battlefield')) await game.dealDamage(d, tt, amt, {});
      }
    }
    game.endDamageBatch();
  },

  async DigUntil(game, sa) {
    const p = sa.p;
    const ctx = ctxOf(game, sa);
    for (const pl of playersOf(objs(game, sa, 'You'))) {
      const need = num(game, sa, 'Amount', 1);
      const found = [], revealed = [];
      while (found.length < need && pl.library.length) {
        const c = pl.library[0];
        pl.library.shift();
        if (matchValid(game, c, p.Valid || 'Card', ctx)) found.push(c); else revealed.push(c);
      }
      pl.library.unshift(...found, ...revealed); // temporarily back so moves work
      game.log(`${pl.name} reveals ${revealed.length + found.length} card(s)${found.length ? ', finding ' + found.map(c => game.name(c)).join(', ') : ''}.`);
      const fdest = Z(p.FoundDestination || 'Hand');
      const rdest = Z(p.RevealedDestination || 'Graveyard');
      for (const c of found) {
        if (p.OptionalFoundMove === 'True') { const yes = await game.ask(sa.controller, { type: 'confirm', prompt: `Put ${game.name(c)} into ${fdest}?`, purpose: 'optional', sa }); if (!yes) { revealed.push(c); continue; } }
        const r = await game.moveCard(c, fdest, { cause: sa, controller: fdest === 'battlefield' ? (p.GainControl === 'True' ? sa.controller : c.owner) : undefined, pos: p.FoundLibraryPosition === '-1' ? 'bottom' : 'top' });
        if (p.RememberFound === 'True') remember(sa, [r || c]);
      }
      for (const c of revealed) {
        if (rdest === 'library') { pl.library.splice(pl.library.indexOf(c), 1); if (p.RevealedLibraryPosition === '0') pl.library.unshift(c); else pl.library.push(c); }
        else await game.moveCard(c, rdest, { cause: sa, silent: true, exiledWith: sa.host.id });
      }
      if (p.RememberRevealed === 'True') remember(sa, revealed);
      if (p.Shuffle === 'True') game.shuffle(pl, sa);
      game.touch();
    }
  },

  async PeekAndReveal(game, sa) {
    const pl = playersOf(objs(game, sa, 'You'))[0] || game.players[sa.controller];
    const n = num(game, sa, 'PeekAmount', 1);
    const top = pl.library.slice(0, n);
    let reveal = true;
    if (sa.p.RevealOptional === 'True') reveal = await game.ask(sa.controller, { type: 'confirm', prompt: `Reveal ${top.map(c => game.name(c)).join(', ')}?`, purpose: 'reveal', sa, cards: top.map(c => c.id) });
    if (sa.p.NoReveal === 'True') reveal = false;
    if (reveal && top.length) game.log(`${pl.name} reveals ${top.map(c => game.name(c)).join(', ')}.`);
    if ((sa.p.RememberRevealed === 'True' && reveal) || sa.p.RememberPeeked === 'True') remember(sa, top);
  },

  async Reveal(game, sa) {
    const pls = playersOf(objs(game, sa, 'You'));
    for (const pl of pls) {
      let cards;
      if (sa.p.RevealDefined) cards = cardsOf(resolveDefined(game, sa.p.RevealDefined, ctxOf(game, sa)));
      else if (sa.p.Random === 'True') cards = pl.hand.length ? [pl.hand[game.rng.int(pl.hand.length)]] : [];
      else if (sa.p.RevealAll === 'True' || sa.p.AnyNumber === 'True') cards = pl.hand.slice();
      else cards = await chooseCards(game, pl.id, pl.hand.filter(c => matchValid(game, c, sa.p.RevealValid || 'Card', ctxOf(game, sa))), 0, num(game, sa, 'NumCards', 1), 'Choose a card to reveal', sa, 'reveal');
      if (cards.length) game.log(`${pl.name} reveals ${cards.map(c => game.name(c)).join(', ')}.`);
      if (sa.p.RememberRevealed === 'True') remember(sa, cards);
      sa.root().paid.Revealed = (sa.root().paid.Revealed || []).concat(cards);
    }
  },
  async RevealHand(game, sa) {
    for (const pl of playersOf(objs(game, sa, 'You'))) {
      game.log(`${pl.name} reveals their hand: ${pl.hand.map(c => game.name(c)).join(', ') || '(empty)'}.`);
      if (sa.p.RememberRevealed === 'True') remember(sa, pl.hand.slice());
    }
  },
  async LookAt(game, sa) { },

  async GenericChoice(game, sa) {
    const names = (sa.p.Choices || '').split(',').map(s => s.trim()).filter(n => sa.svars[n]);
    if (!names.length) return;
    const chooser = playersOf(resolveDefined(game, sa.p.Defined || 'You', ctxOf(game, sa)))[0] || game.players[sa.controller];
    const options = names.map(n => ({ label: (parseAbility(sa.svars[n]).p.SpellDescription || n).replace(/CARDNAME/g, game.name(sa.host)), value: n }));
    const pick = names.length === 1 ? names[0] : await game.ask(chooser.id, { type: 'option', prompt: sa.p.ChoiceTitle || desc(game, sa) || 'Choose one', options, sa, purpose: 'genericChoice', ai: sa.p.AILogic });
    const name = pick || names[0];
    const sub = new SA(game, { raw: sa.svars[name], parsed: parseAbility(sa.svars[name]), svars: sa.svars, src: sa.abil.src, key: sa.key + '>' + name }, sa.host, sa.controller, { parent: sa, trig: sa.trig });
    sub.etbCard = sa.etbCard;
    if (chooser.id !== sa.controller && sa.p.Defined) sub.controller = sa.controller;
    const ok = await chooseTargetsForSA(game, sub, { optional: true });
    if (!ok) return;
    await resolveChain(game, sub);
  },

  async ChooseColor(game, sa) {
    const chooser = playersOf(resolveDefined(game, sa.p.Defined || 'You', ctxOf(game, sa)))[0] || game.players[sa.controller];
    let opts = COLORS.slice();
    if (sa.p.Exclude) { const ex = sa.p.Exclude.split(',').map(x => NAME_TO_COLOR[x.trim().toLowerCase()]); opts = opts.filter(c => !ex.includes(c)); }
    if (sa.p.Choices) opts = sa.p.Choices.split(',').map(x => NAME_TO_COLOR[x.trim().toLowerCase()]).filter(Boolean);
    const n = num(game, sa, 'TwoColors', 0) || (sa.p.TwoColors === 'True' ? 2 : 1);
    const chosen = [];
    for (let i = 0; i < n; i++) {
      const c = await game.ask(chooser.id, { type: 'color', prompt: `Choose a color${n > 1 ? ' (' + (i + 1) + '/' + n + ')' : ''} for ${game.name(sa.host)}`, colors: opts.filter(x => !chosen.includes(x)), sa, purpose: 'chooseColor', ai: sa.p.AILogic });
      chosen.push(c || opts[0]);
    }
    const target = sa.etbCard || sa.host;
    target.chosen = { ...(target.chosen || {}), colors: chosen };
    game.log(`${chooser.name} chooses ${chosen.map(c => COLOR_NAMES[c]).join(' and ')}.`);
    game.touch();
  },

  async ChooseType(game, sa) {
    const chooser = playersOf(resolveDefined(game, sa.p.Defined || 'You', ctxOf(game, sa)))[0] || game.players[sa.controller];
    const kind = sa.p.Type || 'Creature';
    let types;
    if (kind === 'Creature') types = creatureTypesInGame(game);
    else if (kind === 'Basic Land' || kind === 'Land') types = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];
    else if (kind === 'Card') types = ['Artifact', 'Creature', 'Enchantment', 'Instant', 'Land', 'Planeswalker', 'Sorcery', 'Battle'];
    else types = creatureTypesInGame(game);
    if (sa.p.ValidTypes) types = sa.p.ValidTypes.split(',');
    if (sa.p.InvalidTypes) types = types.filter(t => !sa.p.InvalidTypes.split(',').includes(t));
    const t = await game.ask(chooser.id, { type: 'option', prompt: `Choose a ${kind.toLowerCase()} type`, options: types.map(x => ({ label: x, value: x })), sa, purpose: 'chooseType', kind, ai: sa.p.AILogic });
    const target = sa.etbCard || sa.host;
    target.chosen = { ...(target.chosen || {}), type: t || types[0] };
    game.log(`${chooser.name} chooses ${target.chosen.type}.`);
    game.touch();
  },

  async ChooseCard(game, sa) {
    const ctx = ctxOf(game, sa);
    const chooser = playersOf(resolveDefined(game, sa.p.Chooser || sa.p.Defined || 'You', ctx))[0] || game.players[sa.controller];
    const zone = Z(sa.p.ChoiceZone || 'Battlefield');
    let pool;
    if (sa.p.ChoiceZone && zone !== 'battlefield') pool = (sa.p.Defined && sa.p.Defined !== 'You' ? playersOf(resolveDefined(game, sa.p.Defined, ctx)) : [game.players[sa.controller]]).flatMap(pl => pl[zone] || []);
    else pool = game.cardsInZone(zone);
    if (sa.p.DefinedCards) pool = cardsOf(resolveDefined(game, sa.p.DefinedCards, ctx));
    pool = pool.filter(c => matchValid(game, c, sa.p.Choices || 'Card', { ...ctx, you: sa.controller }));
    const n = sa.p.Amount === 'All' ? pool.length : num(game, sa, 'Amount', 1);
    const chosen = await chooseCards(game, chooser.id, pool, sa.p.Mandatory === 'True' || !sa.p.MinAmount ? Math.min(n, pool.length) : 0, n, sa.p.ChoiceTitle || `Choose ${n} card(s)`, sa, 'chooseCard', { ai: sa.p.AILogic });
    const target = sa.etbCard || sa.host;
    target.chosen = { ...(target.chosen || {}), cards: chosen.map(c => c.id) };
    if (sa.p.RememberChosen === 'True') remember(sa, chosen);
    if (chosen.length) game.log(`${chooser.name} chooses ${chosen.map(c => game.name(c)).join(', ')}.`);
  },

  async ChoosePlayer(game, sa) {
    const ctx = ctxOf(game, sa);
    const chooser = playersOf(resolveDefined(game, sa.p.Defined || 'You', ctx))[0] || game.players[sa.controller];
    const choices = playersOf(resolveDefined(game, sa.p.Choices || 'Player', ctx));
    if (!choices.length) return;
    const r = await game.ask(chooser.id, { type: 'player', prompt: sa.p.ChoiceTitle || 'Choose a player', players: choices.map(p => p.id), sa, purpose: 'choosePlayer', ai: sa.p.AILogic });
    const target = sa.etbCard || sa.host;
    const ok = choices.some(p => p.id === r);
    if (!ok && r != null && (game.debugLog || game.debugChoose)) console.log('ChoosePlayer: invalid answer', JSON.stringify(r), choices.map(p => p.id));
    target.chosen = { ...(target.chosen || {}), player: ok ? r : choices[0].id };
    if (sa.p.RememberChosen === 'True') remember(sa, [game.players[target.chosen.player]]);
    game.log(sa.p.Secretly === 'True' ? `${chooser.name} secretly chooses a player.` : `${chooser.name} chooses ${game.players[target.chosen.player].name}.`);
  },

  async ChooseNumber(game, sa) {
    const min = num(game, sa, 'Min', 0), max = num(game, sa, 'Max', 10);
    const n = sa.p.Random === 'True' ? min + game.rng.int(max - min + 1) : await game.ask(sa.controller, { type: 'number', prompt: sa.p.ListTitle || 'Choose a number', min, max, sa, purpose: 'chooseNumber' });
    const target = sa.etbCard || sa.host;
    target.chosen = { ...(target.chosen || {}), number: n };
    game.log(`${game.players[sa.controller].name} chooses ${n}.`);
  },

  async ChooseCardName(game, sa) {
    const pool = [...new Set(game.allCards().filter(c => c.owner !== sa.controller).map(c => c.def.faces[0].name))];
    const n = pool.length ? pool[game.rng.int(pool.length)] : 'Island';
    sa.host.chosen = { ...(sa.host.chosen || {}), name: n };
    game.log(`${game.players[sa.controller].name} names ${n}.`);
  },

  async Effect(game, sa) {
    const p = sa.p;
    const ctx = ctxOf(game, sa);
    const ownerP = p.EffectOwner ? playersOf(resolveDefined(game, p.EffectOwner, ctx))[0] : null;
    const names = s => (s || '').split(',').map(x => x.trim()).filter(Boolean);
    const svars = { ...sa.svars };
    const statics = names(p.StaticAbilities).map(n => svars[n]).filter(Boolean);
    const triggers = names(p.Triggers).map(n => svars[n]).filter(Boolean);
    const repls = names(p.ReplacementEffects).map(n => svars[n]).filter(Boolean);
    const e = {
      isEffect: true, id: game.nextId++, effectName: p.Name || `${game.name(sa.host)} effect`,
      controller: ownerP ? ownerP.id : sa.controller, owner: ownerP ? ownerP.id : sa.controller, zone: 'command',
      duration: durationOf(sa), remembered: [], imprinted: [], chosen: { ...(sa.host.chosen || {}) }, counters: {}, timestamp: game.uid++, temp: [], mods: [],
      hostCard: sa.host, xPaid: sa.root().x || 0, abilityUses: {},
      exileOnMoved: p.ExileOnMoved ? Z(p.ExileOnMoved) : null, forgetOnMoved: p.ForgetOnMoved ? Z(p.ForgetOnMoved) : null,
      // "the next instant or sorcery spell you cast this turn has storm": it ends once that spell is cast
      forgetOnCast: p.ForgetOnCast || null,
      description: desc(game, sa),
    };
    const mk = (raw, i, kind) => ({ raw, parsed: parseAbility(raw), svars, src: e, key: `e${e.id}${kind}${i}` });
    e.effectChars = { name: e.effectName, types: new Set(['Effect']), subtypes: new Set(), supertypes: new Set(), colors: new Set(), keywords: [], abilities: [], triggers: triggers.map((r, i) => mk(r, i, 'T')), statics: statics.map((r, i) => mk(r, i, 'S')), replacements: repls.map((r, i) => mk(r, i, 'R')), svars, power: 0, toughness: 0, cmc: 0 };
    if (p.SetChosenNumber) e.chosen.number = calc(game, p.SetChosenNumber, sa);
    if (p.RememberObjects) e.remembered = resolveDefined(game, p.RememberObjects, ctx).map(o => o.lki ? liveOrLki(game, o) : o).filter(Boolean);
    if (p.ImprintCards) e.imprinted = resolveDefined(game, p.ImprintCards, ctx);
    if (p.RememberLKI === 'True') e.remembered = e.remembered.map(o => o.isCard ? game.makeLKI(o) : o);
    if (e.duration === 'UntilHostLeavesPlay' || e.duration === 'UntilLoseControlOfHost') { e.endsWhenHostLeaves = sa.host.id; e.duration = 'Permanent'; }
    if (e.duration === 'UntilHostLeavesPlayOrEOT') { e.endsWhenHostLeaves = sa.host.id; e.duration = 'EOT'; }
    if (e.duration === 'UntilHostLeavesPlayOrEndOfCombat') { e.endsWhenHostLeaves = sa.host.id; e.duration = 'UntilEndOfCombat'; }
    if (e.duration === 'UntilUntaps') { e.endsWhenHostUntaps = sa.host.id; e.endsWhenHostLeaves = sa.host.id; e.duration = 'Permanent'; }
    if (p.Stackable === 'False' && game.effects.some(x => x.effectName === e.effectName && x.controller === e.controller)) return;
    if (p.Duration === 'Permanent' && /Emblem/.test(e.effectName)) e.isEmblem = true;
    game.effects.push(e);
    game.touch();
    if (p.SpellDescription && !sa.parent) game.log(`${desc(game, sa)}`, { type: 'effect' });
  },

  async Animate(game, sa) {
    const p = sa.p;
    let list = cardsOf(objs(game, sa, 'Self'));
    if (sa.etbCard && !p.Defined && !hasTgtSpec(sa)) list = [sa.etbCard];
    for (const c of list) animate(game, sa, c);
    if (p.IsCrew === 'True' && list[0]) { list[0].crewedTurn = game.turnNumber; }
  },
  async AnimateAll(game, sa) {
    const ctx = ctxOf(game, sa);
    for (const c of game.battlefield.filter(c => matchValid(game, c, sa.p.ValidCards || 'Card', ctx))) animate(game, sa, c);
  },

  async DelayedTrigger(game, sa) {
    const p = { ...sa.p };
    const ctx = ctxOf(game, sa);
    const rem = p.RememberObjects ? resolveDefined(game, p.RememberObjects, ctx).map(o => o.lki ? liveOrLki(game, o) : o) : [];
    // (spawner: what set it up, for "Spawner>TriggeredCard" when it fires)
    const d = { id: game.uid++, p, svars: sa.svars, host: sa.host, controller: sa.controller, remembered: rem, turn: game.turnNumber, thisTurnOnly: p.ThisTurn === 'True', nextTurn: p.NextTurn === 'True' || p.UpcomingTurn === 'True', spawner: sa.root() };
    if (p.Mode === 'Phase' && p.Phase === 'End of Turn' && !p.NextTurn && game.step === 'end') d.nextTurn = true;
    if (p.Mode === 'Phase' && p.Phase === 'Upkeep' && !p.ValidPlayer) d.p.ValidPlayer = 'Player';
    if (p.DelayedTriggerDefinedPlayer) { const pl = playersOf(resolveDefined(game, p.DelayedTriggerDefinedPlayer, ctx))[0]; if (pl) d.p.ValidPlayer = 'Player.IsTriggerRemembered'; d.playerFilter = pl ? pl.id : null; }
    game.delayed.push(d);
  },

  async ImmediateTrigger(game, sa) {
    const p = sa.p;
    const ctx = ctxOf(game, sa);
    const rem = p.RememberObjects ? resolveDefined(game, p.RememberObjects, ctx) : [];
    const exec = p.Execute;
    if (!exec || !sa.svars[exec]) return;
    const raw = sa.svars[exec];
    const sub = new SA(game, { raw, parsed: parseAbility(raw), svars: sa.svars, src: sa.abil.src, key: sa.key + '>imm' }, sa.host, sa.controller, { trig: sa.trig });
    sub.isTrigger = true;
    sub.trigRemembered = rem;
    sub.delayRemembered = rem;
    sub.spawner = sa.root();
    // "when you pay this cost one or more times, put that many ..." (Count$TriggerRememberAmount)
    if (p.RememberSVarAmount) sub.triggerRememberAmount = sa.svars[p.RememberSVarAmount] ? calc(game, sa.svars[p.RememberSVarAmount], sa) : 0;
    sub.description = (p.TriggerDescription || parseAbility(raw).p.SpellDescription || '').replace(/CARDNAME/g, game.name(sa.host));
    const ok = await chooseTargetsForSA(game, sub, { optional: true });
    if (!ok) return;
    const item = { id: game.uid++, kind: 'trigger', sa: sub, card: null, source: sa.host, controller: sa.controller, description: sub.description, stackItem: true };
    sub.stackItem = item;
    game.stack.push(item);
    game.touch();
  },

  async GainControl(game, sa) {
    const p = sa.p;
    const ctx = ctxOf(game, sa);
    const newCtrl = p.NewController ? playersOf(resolveDefined(game, p.NewController, ctx))[0] : game.players[sa.controller];
    if (!newCtrl) return;
    const list = cardsOf(objs(game, sa, 'Self'));
    for (const c of list) {
      if (c.zone !== 'battlefield') continue;
      const prev = c.controller;
      if (prev === newCtrl.id) continue;
      c.controller = newCtrl.id;
      c.sick = true;
      if (p.LoseControl) {
        const lc = p.LoseControl;
        c.tempControl = { prev, owner: sa.controller, until: /EOT/.test(lc) ? 'EOT' : /EndOfCombat/.test(lc) ? 'UntilEndOfCombat' : 'Permanent', untilHostLeaves: /LeavesPlay|LoseControl/.test(lc) ? sa.host.id : null, untilUntapOf: /Untap/.test(lc) ? sa.host.id : null };
      }
      if (p.Untap === 'True') c.tapped = false;
      if (p.RememberControlled === 'True') remember(sa, [c]);
      if (p.AddKWs) c.temp.push({ keywords: kwList(p.AddKWs), until: p.LoseControl && /EOT/.test(p.LoseControl) ? 'EOT' : 'Permanent', owner: sa.controller });
      if (game.combat) { game.combat.attackers = game.combat.attackers.filter(a => a.card !== c.id); game.combat.blockers.delete(c.id); }
      game.touch();
      game.log(`${newCtrl.name} gains control of ${game.name(c)}.`);
      game.fire('ChangesController', { Card: c, OriginalController: prev });
    }
  },
  async ExchangeControl(game, sa) {
    const list = cardsOf(objs(game, sa, 'Self'));
    let a, b;
    if (sa.p.Defined && hasTgtSpec(sa)) { a = cardsOf(resolveDefined(game, sa.p.Defined, ctxOf(game, sa)))[0]; b = sa.targets[0]; }
    else [a, b] = list;
    if (!a || !b || a.zone !== 'battlefield' || b.zone !== 'battlefield') return;
    [a.controller, b.controller] = [b.controller, a.controller];
    a.sick = b.sick = true;
    game.touch();
    game.log(`${game.name(a)} and ${game.name(b)} exchange controllers.`);
  },

  async CopySpellAbility(game, sa) {
    const ctx = ctxOf(game, sa);
    let items = [];
    if (hasTgtSpec(sa)) items = sa.targets.filter(t => t.stackItem);
    else {
      const d = resolveDefined(game, sa.p.Defined || 'Targeted', ctx);
      for (const x of d) { if (x && x.stackItem) items.push(x); else if (x && x.isCard) { const it = game.stack.find(s => s.card === x); if (it) items.push(it); } }
      if (!items.length && sa.trig && sa.trig.StackItem) items = [sa.trig.StackItem];
    }
    let n = num(game, sa, 'Amount', 1);
    const controller = sa.p.Controller ? (playersOf(resolveDefined(game, sa.p.Controller, ctx))[0] || game.players[sa.controller]).id : sa.controller;
    // "if you would copy a spell one or more times, instead copy it that many times plus an additional time"
    if (n > 0 && items.some(it => it.kind === 'spell')) { const rp = await game.applySimpleReplacement('CopySpell', { Affected: game.players[controller], Player: controller, Amount: n }, sa); if (rp && rp.Amount > n) { game.log(`${game.players[controller].name} makes an additional copy.`); n = rp.Amount; } }
    for (const item of items) for (let i = 0; i < n; i++) await copyStackItem(game, item, controller, sa.p.MayChooseTarget === 'True' || sa.p.MayChooseNewTargets === 'True');
  },

  async Counter(game, sa) {
    const ctx = ctxOf(game, sa);
    let items = hasTgtSpec(sa) ? sa.targets.filter(t => t.stackItem) : resolveDefined(game, sa.p.Defined || 'Targeted', ctx).map(x => (x && x.stackItem) ? x : game.stack.find(s => s.card === x)).filter(Boolean);
    for (const item of items) {
      if (!game.stack.includes(item)) continue;
      if (item.card && cantBeCountered(game, item.card)) { game.log(`${game.name(item.card)} can't be countered.`); continue; }
      game.stack.splice(game.stack.indexOf(item), 1);
      game.touch();
      game.log(`${item.description || game.name(item.card)} is countered.`, { type: 'counter' });
      if (item.card && !item.isCopy) {
        const dest = Z(sa.p.Destination || 'Graveyard');
        await game.moveCard(item.card, dest, { cause: sa, pos: sa.p.LibraryPosition === '-1' || sa.p.Destination === 'BottomOfLibrary' ? 'bottom' : 'top', silent: true });
      } else if (item.card && item.isCopy) { item.card.zone = 'gone'; game.cards.delete(item.card.id); }
      if (sa.p.RememberCountered === 'True') remember(sa, [item.card || item.source]);
      game.fire('Countered', { Card: item.card, Cause: sa });
    }
  },

  async Clone(game, sa) {
    const p = sa.p;
    const ctx = ctxOf(game, sa);
    const target = sa.etbCard || cardsOf(resolveDefined(game, p.CloneTarget || 'Self', ctx))[0] || sa.host;
    let source;
    if (p.Defined && p.Choices == null) source = cardsOf(resolveDefined(game, p.Defined, ctx))[0];
    else if (hasTgtSpec(sa)) source = sa.targets[0];
    else {
      const zone = Z(p.ChoiceZone || 'Battlefield');
      const pool = game.cardsInZone(zone).filter(c => c !== target && matchValid(game, c, p.Choices || 'Creature.Other', ctx));
      const chosen = await chooseCards(game, sa.controller, pool, p.Optional === 'True' ? 0 : 1, 1, `Choose a card to copy`, sa, 'clone');
      source = chosen[0];
    }
    if (!source || !target) return;
    const base = source.copyOf ? { ...source.copyOf } : { def: source.def, face: source.face };
    const extra = { ...(base.extra || {}) };
    if (p.AddTypes) extra.addTypes = (extra.addTypes || []).concat(p.AddTypes.split(' & ').flatMap(x => x.split(',')));
    if (p.NonLegendary === 'True') extra.nonLegendary = true;
    if (p.SetPower) extra.power = calc(game, p.SetPower, sa);
    if (p.SetToughness) extra.toughness = calc(game, p.SetToughness, sa);
    if (p.AddKeywords) extra.keywords = (extra.keywords || []).concat(kwList(p.AddKeywords));
    if (p.SetColor) extra.colors = p.SetColor.split(',').map(x => NAME_TO_COLOR[x.trim().toLowerCase()]).filter(Boolean);
    if (p.NewName) extra.name = p.NewName;
    if (p.AddColors) extra.addColors = p.AddColors.split(',').map(x => NAME_TO_COLOR[x.trim().toLowerCase()]).filter(Boolean);
    target.copyOf = { def: base.def, face: base.face || 0, extra };
    game.touch();
    game.log(`${game.name(target)} becomes a copy of ${game.name(source)}.`);
  },

  async CopyPermanent(game, sa) {
    const p = sa.p;
    const ctx = ctxOf(game, sa);
    let list = objs(game, sa, 'Self').filter(o => o && (o.isCard || o.lki));
    // "create a Mutavault token": a copy of the card with that name (not of this one)
    if (p.DefinedName) {
      const def = game.db.get(p.DefinedName);
      if (!def) { game.log(`${p.DefinedName} isn't available to copy.`, { type: 'unsupported' }); return; }
      list = [{ lki: true, def, face: 0, chars: { name: def.name } }];
    }
    if (p.Populate === 'True') {
      const pool = game.battlefield.filter(c => c.controller === sa.controller && c.token && game.chars(c).types.has('Creature'));
      list = pool.length ? await chooseCards(game, sa.controller, pool, 1, 1, 'Populate: choose a creature token to copy', sa, 'copy') : [];
      if (!list.length) return;
    }
    if (p.Choices) {
      const pool = game.battlefield.filter(c => matchValid(game, c, p.Choices, ctx));
      const chooser = p.Chooser ? (playersOf(resolveDefined(game, p.Chooser, ctx))[0] || game.players[sa.controller]) : game.players[sa.controller];
      list = await chooseCards(game, chooser.id, pool, 1, num(game, sa, 'ChoiceNum', 1), 'Choose a permanent to copy', sa, 'copy');
    }
    const n = num(game, sa, 'NumCopies', 1);
    const ctrl = p.Controller ? (playersOf(resolveDefined(game, p.Controller, ctx))[0] || game.players[sa.controller]).id : sa.controller;
    const made = [];
    for (const src of list) {
      const live = src.lki ? src : src;
      const def = live.lki ? live.def : (live.copyOf ? live.copyOf.def : live.def);
      const face = live.lki ? (live.face || 0) : (live.copyOf ? live.copyOf.face : live.face);
      const extra = {};
      if (p.AddTypes) extra.addTypes = p.AddTypes.split(' & ').flatMap(x => x.split(','));
      if (p.NonLegendary === 'True') extra.nonLegendary = true;
      if (p.SetPower) extra.power = calc(game, p.SetPower, sa);
      if (p.SetToughness) extra.toughness = calc(game, p.SetToughness, sa);
      if (p.AddKeywords) extra.keywords = kwList(p.AddKeywords);
      if (p.SetColor) extra.colors = p.SetColor.split(',').map(x => NAME_TO_COLOR[x.trim().toLowerCase()]).filter(Boolean);
      if (p.Encore === 'True') {
        for (const opp of game.opponents(ctrl)) {
          const t = await game.createToken(def, ctrl, sa, { copyOf: { def, face, extra: { ...extra, keywords: ['Haste'] } } });
          if (!t) continue;
          t.mustAttack = opp.id;
          made.push(t);
          game.delayed.push({ id: game.uid++, p: { Mode: 'Phase', Phase: 'End of Turn', Execute: 'EncoreSac' }, svars: { EncoreSac: 'DB$ Sacrifice | Defined$ DelayTriggerRemembered' }, host: t, controller: ctrl, remembered: [t], turn: game.turnNumber, thisTurnOnly: true });
        }
        continue;
      }
      const cnt = tokenCounts(game, sa, ctrl, n);
      for (let i = 0; i < cnt; i++) {
        const t = await game.createToken(def, ctrl, sa, { copyOf: { def, face, extra }, tapped: p.TokenTapped === 'True', attacking: p.TokenAttacking ? attackingFromSpec(game, sa, p.TokenAttacking) : null });
        if (!t) continue;
        if (p.PumpKeywords) t.temp.push({ keywords: kwList(p.PumpKeywords), until: p.PumpDuration === 'EOT' ? 'EOT' : 'Permanent' });
        made.push(t);
        if (p.AtEOT) game.delayed.push({ id: game.uid++, p: { Mode: 'Phase', Phase: 'End of Turn', Execute: 'AtEOT' }, svars: { AtEOT: p.AtEOT === 'Sacrifice' ? 'DB$ Sacrifice | Defined$ DelayTriggerRemembered' : 'DB$ ChangeZone | Defined$ DelayTriggerRemembered | Origin$ Battlefield | Destination$ Exile' }, host: t, controller: ctrl, remembered: [t], turn: game.turnNumber, thisTurnOnly: true });
      }
    }
    if (made.length) { game.noteTokenBatch(ctrl); game.fire('TokenCreatedOnce', { Card: made[0], Cards: made, Player: ctrl }); }
    if (made.length) game.log(`${game.players[ctrl].name} creates ${made.length} token cop${made.length > 1 ? 'ies' : 'y'} of ${list.map(c => game.name(c)).join(', ')}.`);
    if (p.RememberTokens === 'True' || p.RememberCopied === 'True') remember(sa, made);
  },

  async Attach(game, sa) {
    const p = sa.p;
    const ctx = ctxOf(game, sa);
    const objsToAttach = p.Object ? cardsOf(resolveDefined(game, p.Object, ctx)) : [sa.host.lki ? sa.host.card : sa.host];
    let target = (hasTgtSpec(sa) ? sa.targets : resolveDefined(game, p.Defined || 'Self', ctx))[0];
    if (p.Choices && !hasTgtSpec(sa)) {
      const pool = game.battlefield.filter(c => !objsToAttach.includes(c) && matchValid(game, c, p.Choices, ctx));
      target = (await chooseCards(game, sa.controller, pool, p.Optional === 'True' ? 0 : 1, 1, p.ChoiceTitle || 'Choose what to attach it to', sa, 'attachChoice'))[0];
    }
    if (!target) return;
    for (const a of objsToAttach) {
      if (!a || a.zone !== 'battlefield') continue;
      if (target.isPlayer) { a.attachedTo = 'p' + target.id; }
      else {
        if (target.zone !== 'battlefield' || target === a) continue;
        if (game.chars(a).subtypes.has('Equipment') && (!game.chars(target).types.has('Creature'))) continue;
        if (game.chars(a).subtypes.has('Fortification') && (!game.chars(target).types.has('Land'))) continue;
        for (const r of game.chars(a).replacements) {
          const rp = r.parsed.p;
          if (rp.Event !== 'Attached' || !r.svars[rp.ReplaceWith]) continue;
          if (rp.ValidTarget && !matchValid(game, target, rp.ValidTarget, { host: a, you: a.controller })) continue;
          await resolveChain(game, makeSA(game, r.svars[rp.ReplaceWith], r.svars, a, a.controller, { key: r.key }));
        }
        a.attachedTo = target.id;
      }
      game.touch();
      game.log(`${game.name(a)} is attached to ${game.name(target)}.`, { type: 'attach' });
      game.fire('Attached', { AttachSource: a, AttachTarget: target });
    }
  },
  async Unattach(game, sa) {
    for (const c of cardsOf(objs(game, sa, 'Self'))) { c.attachedTo = null; }
    game.touch();
  },
  async UnattachAll(game, sa) {
    const tgt = cardsOf(objs(game, sa, 'Self'))[0];
    if (!tgt) return;
    for (const a of game.attachmentsOf(tgt)) if (!sa.p.UnattachValid || matchValid(game, a, sa.p.UnattachValid, ctxOf(game, sa))) a.attachedTo = null;
    game.touch();
  },

  async Goad(game, sa) {
    for (const c of cardsOf(objs(game, sa, 'Self'))) { if (!c.goadedBy.includes(sa.controller)) c.goadedBy.push(sa.controller); game.log(`${game.name(c)} is goaded.`); }
    game.touch();
  },

  async Investigate(game, sa) {
    const n = num(game, sa, 'Num', 1);
    for (const pl of playersOf(objs(game, sa, 'You'))) { await makeTokens(game, sa, 'c_a_clue_draw', pl.id, n); game.fire('Investigated', { Player: pl.id }); }
  },

  async BecomeMonarch(game, sa) {
    const pl = playersOf(objs(game, sa, 'You'))[0];
    if (!pl) return;
    game.monarch = pl.id;
    game.touch();
    game.log(`${pl.name} becomes the monarch.`);
    game.fire('BecomeMonarch', { Player: pl.id });
  },
  async TakeInitiative(game, sa) { const pl = playersOf(objs(game, sa, 'You'))[0]; if (pl) await game.takeInitiative(pl.id); },

  async Fight(game, sa) {
    const ctx = ctxOf(game, sa);
    let fighters = [];
    if (sa.p.Defined) fighters.push(...cardsOf(resolveDefined(game, sa.p.Defined, ctx)));
    if (hasTgtSpec(sa)) fighters.push(...cardsOf(sa.targets));
    else if (!sa.p.Defined) fighters.push(sa.host);
    if (sa.p.Defined && !hasTgtSpec(sa) && fighters.length < 2 && sa.parent) fighters.push(...cardsOf(findTargets(sa.parent)));
    fighters = [...new Set(fighters.map(f => liveOrLki(game, f)))].filter(c => c && c.zone === 'battlefield' && game.chars(c).types.has('Creature'));
    if (fighters.length < 2) return;
    const [a, b] = fighters;
    const pa = game.chars(a).power, pb = game.chars(b).power;
    game.log(`${game.name(a)} fights ${game.name(b)}.`);
    game.beginDamageBatch();
    await game.dealDamage(a, b, pa, {});
    await game.dealDamage(b, a, pb, {});
    game.endDamageBatch();
    game.fire('Fight', { Fighter: a, Fighters: [a, b] });
  },

  async Regenerate(game, sa) { for (const c of cardsOf(objs(game, sa, 'Self'))) { c.regenShields = (c.regenShields || 0) + 1; c.temp.push({ until: 'EOT', regen: true }); } game.touch(); },

  async Shuffle(game, sa) { for (const pl of playersOf(objs(game, sa, 'You'))) game.shuffle(pl, sa); },

  async Amass(game, sa) {
    const n = num(game, sa, 'Num', 1);
    const type = sa.p.Type || 'Zombie';
    const pid = sa.controller;
    let army = game.battlefield.find(c => c.controller === pid && game.chars(c).subtypes.has('Army'));
    if (!army) {
      const script = { Zombie: 'b_0_0_zombie_army', Orc: 'b_0_0_orc_army', Sliver: 'b_0_0_sliver_army', Goblin: 'b_0_0_goblin_army' }[type] || 'b_0_0_army';
      const t = await makeTokens(game, sa, script, pid, 1);
      army = t[0];
    }
    if (army) await game.addCounters(army, 'P1P1', n, sa);
    if (army && sa.p.RememberAmass === 'True') remember(sa, [army]);
  },

  async Connive(game, sa) {
    for (const c of cardsOf(objs(game, sa, 'Self'))) {
      const pl = game.players[c.controller];
      const n = num(game, sa, 'ConniveNum', 1);
      await game.drawCards(pl, n, sa);
      const d = await chooseCards(game, pl.id, pl.hand, Math.min(n, pl.hand.length), n, `Connive: discard ${n}`, sa, 'discard');
      let nonland = 0;
      for (const x of d) { if (!game.chars(x).types.has('Land')) nonland++; await game.discard(x, sa); }
      if (nonland && c.zone === 'battlefield') await game.addCounters(c, 'P1P1', nonland, sa);
      game.fire('Connives', { Card: c, Player: pl.id });
    }
  },

  async Explore(game, sa) {
    for (const c of cardsOf(objs(game, sa, 'Self'))) {
      // "if a creature you control would explore, instead it explores, then it explores again"
      let times = num(game, sa, 'Num', 1);
      if (!sa.p.Num && game.replacementsFor('Explore').some(({ p, ctx }) => !p.ValidExplorer || matchValid(game, c, p.ValidExplorer, ctx))) times = 2;
      for (let k = 0; k < times; k++) {
        const pl = game.players[c.controller];
        const top = pl.library[0];
        if (!top) break;
        game.log(`${game.name(c)} explores, revealing ${game.name(top)}.`);
        if (game.chars(top).types.has('Land')) await game.moveCard(top, 'hand', { silent: true });
        else {
          if (c.zone === 'battlefield') await game.addCounters(c, 'P1P1', 1, sa);
          const toGy = await game.ask(pl.id, { type: 'confirm', prompt: `Put ${game.name(top)} into your graveyard?`, purpose: 'exploreGrave', cards: [top.id], sa });
          if (toGy) await game.moveCard(top, 'graveyard');
        }
        game.fire('Explores', { Card: c, Player: pl.id });
      }
    }
  },

  async RollDice(game, sa) {
    const sides = num(game, sa, 'Sides', 6);
    const amount = num(game, sa, 'Amount', 1);
    const ignore = sa.p.IgnoreLower ? num(game, sa, 'IgnoreLower', 1) : 0;
    let { total } = await rollDice(game, sa.controller, amount, sides, ignore, sa);
    total += num(game, sa, 'Modifier', 0);
    sa.host.chosen = { ...(sa.host.chosen || {}), number: total };
    storeSVar(sa, 'Result', String(total));
    if (sa.p.ResultSubAbilities) {
      for (const part of sa.p.ResultSubAbilities.split(',')) {
        const [range, name] = part.split(':');
        const [lo, hi] = range.includes('-') ? range.split('-').map(Number) : [+range, +range];
        if (total >= lo && total <= (hi || lo) && sa.svars[name]) {
          const sub = makeSA(game, sa.svars[name], sa.svars, sa.host, sa.controller, { parent: sa, key: sa.key + name });
          if (await chooseTargetsForSA(game, sub, { optional: true })) await resolveChain(game, sub);
        }
      }
    }
  },

  async FlipCoin(game, sa) {
    const p = sa.p;
    const run = async (name) => {
      if (!name || !sa.svars[name]) return;
      const sub = makeSA(game, sa.svars[name], sa.svars, sa.host, sa.controller, { parent: sa });
      if (await chooseTargetsForSA(game, sub, { optional: true })) await resolveChain(game, sub);
    };
    // "each player flips a coin; each player whose coin comes up tails ..." (Goblin Assassin): heads or tails, no call;
    // the results stay on the source for "FlippedTails" until a Cleanup clears them
    if (p.NoCall === 'True' || p.Flipper) {
      const flippers = p.Flipper ? playersOf(resolveDefined(game, p.Flipper, ctxOf(game, sa))) : [game.players[sa.controller]];
      for (const pl of flippers) {
        const heads = game.rng.int(2) === 0;
        if (p.NoCall !== 'True') {
          game.log(`${pl.name} flips a coin: ${heads ? 'wins' : 'loses'}.`);
          await run(heads ? p.WinSubAbility : p.LoseSubAbility);
          game.fire('FlippedCoin', { Player: pl.id, Result: heads });
          continue;
        }
        game.log(`${pl.name} flips a coin: ${heads ? 'heads' : 'tails'}.`);
        if (p.RememberResult === 'True') sa.host.flipResults = { ...sa.host.flipResults, [pl.id]: heads ? 'Heads' : 'Tails' };
        await run(heads ? p.HeadsSubAbility : p.TailsSubAbility);
        game.fire('FlippedCoin', { Player: pl.id, Result: heads });
      }
      return;
    }
    let win = game.rng.int(2) === 0;
    if (game.activeStatics('FlipCoinDoubler').some(s => matchValid(game, game.players[sa.controller], s.p.ValidPlayer || 'You', s.ctx))) win = (game.rng.int(2) === 0) || win;
    game.log(`${game.players[sa.controller].name} flips a coin: ${win ? 'wins' : 'loses'}.`);
    await run(win ? p.WinSubAbility : p.LoseSubAbility);
    game.fire('FlippedCoin', { Player: sa.controller, Result: win });
  },

  async WinsGame(game, sa) { const pl = playersOf(objs(game, sa, 'You'))[0]; if (pl) for (const o of game.opponents(pl.id)) game.playerLoses(o, `${game.name(sa.host)}`); },
  async LosesGame(game, sa) { for (const pl of playersOf(objs(game, sa, 'You'))) game.playerLoses(pl, game.name(sa.host)); },

  async SetState(game, sa) {
    const mode = sa.p.Mode || 'Transform';
    for (const c of cardsOf(objs(game, sa, 'Self'))) {
      if (mode === 'TurnFaceUp' || mode === 'TurnFace') {
        if (!c.faceDown) continue;
        c.faceDown = false;
        c.cloaked = false; c.disguised = false;
        if (sa.p.Megamorph === 'true' || sa.p.Megamorph === 'True') await game.addCounters(c, 'P1P1', 1, sa);
        game.touch();
        game.log(`${game.players[c.controller].name} turns ${game.name(c)} face up.`);
        c.turnedFaceUpTurn = game.turnNumber;
        // "as CARDNAME is turned face up, ..." replacements
        for (const r of game.chars(c).replacements) {
          const rp = r.parsed.p;
          if (rp.Event !== 'TurnFaceUp' || !r.svars[rp.ReplaceWith]) continue;
          if (rp.ValidCard && !matchValid(game, c, rp.ValidCard, { host: c, you: c.controller })) continue;
          if (rp.Optional === 'True' && !(await game.ask(c.controller, { type: 'confirm', prompt: `${game.name(c)}: ${rp.Description || 'apply?'}`, purpose: 'replacement', cardId: c.id }))) continue;
          const sub = makeSA(game, r.svars[rp.ReplaceWith], r.svars, c, c.controller, { key: r.key });
          for (const s of sub.chain()) s.etbCard = c;
          await resolveChain(game, sub);
        }
        game.fire('TurnFaceUp', { Card: c, Player: c.controller });
      } else if (mode === 'TurnFaceDown') {
        if (c.faceDown || c.zone !== 'battlefield') continue;
        c.faceDown = true; c.copyOf = null;
        game.touch();
        game.log(`${game.players[c.controller].name} turns ${game.name(c)} face down.`);
      } else if (mode === 'Transform' || mode === 'Flip') {
        if (c.def.faces.length < 2) continue;
        c.face = c.face ? 0 : 1;
        c.transformed = !!c.face;
        game.touch();
        game.log(`${game.name(c)} transforms.`);
        for (const r of game.chars(c).replacements) {
          const rp = r.parsed.p;
          if (rp.Event !== 'Transform' || !r.svars[rp.ReplaceWith]) continue;
          const sub = makeSA(game, r.svars[rp.ReplaceWith], r.svars, c, c.controller, { key: r.key });
          for (const s of sub.chain()) s.etbCard = c;
          await resolveChain(game, sub);
        }
        game.fire('Transformed', { Card: c });
      }
    }
  },

  async Manifest(game, sa) {
    const pl = playersOf(objs(game, sa, 'You'))[0] || game.players[sa.controller];
    const n = num(game, sa, 'Amount', 1);
    const cards = sa.p.Defined && !/You|Player/.test(sa.p.Defined) ? cardsOf(resolveDefined(game, sa.p.Defined, ctxOf(game, sa))) : pl.library.slice(0, n);
    for (const c of cards) {
      const r = await game.moveCard(c, 'battlefield', { controller: sa.controller, faceDown: true, silent: true, setProps: { manifested: true } });
      if (r && sa.p.RememberManifested === 'True') remember(sa, [r]);
      game.log(`${pl.name} manifests a card.`);
    }
  },

  // cloak: put the card onto the battlefield face down as a 2/2 creature with ward {2}
  async Cloak(game, sa) {
    const ctx = ctxOf(game, sa);
    const players = sa.p.DefinedPlayer ? playersOf(resolveDefined(game, sa.p.DefinedPlayer, ctx)) : [game.players[sa.controller]];
    const n = num(game, sa, 'Amount', 1);
    const fromTop = !sa.p.Defined || sa.p.Defined === 'TopOfLibrary';
    for (const pl of players) {
      if (pl.lost) continue;
      const cards = fromTop ? pl.library.slice(0, n) : cardsOf(resolveDefined(game, sa.p.Defined, ctx));
      for (const c of cards) {
        const r = await game.moveCard(c, 'battlefield', { controller: pl.id, faceDown: true, silent: true, cause: sa, setProps: { manifested: true, cloaked: true } });
        if (r && sa.p.RememberCloaked === 'True') remember(sa, [r]);
        game.log(`${pl.name} cloaks a card.`);
      }
    }
  },

  async TwoPiles(game, sa) {
    const ctx = ctxOf(game, sa);
    const zone = Z(sa.p.Zone || 'Battlefield');
    let cards = sa.p.DefinedCards ? cardsOf(resolveDefined(game, sa.p.DefinedCards, ctx)) : game.cardsInZone(zone).filter(c => matchValid(game, c, sa.p.ValidCards || 'Card', ctx));
    const half = Math.ceil(cards.length / 2);
    const pile1 = cards.slice(0, half), pile2 = cards.slice(half);
    const chosen = game.rng.int(2) ? pile1 : pile2;
    sa.host.remembered = chosen.slice();
    for (const name of [sa.p.ChosenPile]) if (name && sa.svars[name]) await resolveChain(game, makeSA(game, sa.svars[name], sa.svars, sa.host, sa.controller, { parent: sa }));
    sa.host.remembered = (chosen === pile1 ? pile2 : pile1).slice();
    for (const name of [sa.p.UnchosenPile]) if (name && sa.svars[name]) await resolveChain(game, makeSA(game, sa.svars[name], sa.svars, sa.host, sa.controller, { parent: sa }));
  },

  async Vote(game, sa) {
    const choices = (sa.p.Choices || '').split(',').map(s => s.trim()).filter(n => sa.svars[n]);
    if (!choices.length) return;
    const tally = {}, votes = {};
    for (const pl of game.livingPlayers()) {
      const v = await game.ask(pl.id, { type: 'option', prompt: `Vote: ${desc(game, sa)}`, options: choices.map(n => ({ label: parseAbility(sa.svars[n]).p.SpellDescription || n, value: n })), sa, purpose: 'vote' });
      const pick = choices.includes(v) ? v : choices[0];
      tally[pick] = (tally[pick] || 0) + 1;
      votes[pl.id] = [pick];
    }
    const best = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    const winners = best.filter(x => x[1] === best[0][1]).map(x => x[0]);
    game.fire('Vote', { Player: sa.controller, Votes: votes });
    const resolveThese = winners.length > 1 && sa.p.VoteTiedAbility && sa.svars[sa.p.VoteTiedAbility] ? [sa.p.VoteTiedAbility] : winners;
    for (const w of resolveThese) await resolveChain(game, makeSA(game, sa.svars[w], sa.svars, sa.host, sa.controller, { parent: sa }));
  },

  async Repeat(game, sa) {
    const name = sa.p.RepeatSubAbility;
    if (!name || !sa.svars[name]) return;
    const n = Math.min(50, num(game, sa, 'RepeatCount', 1));
    for (let i = 0; i < n; i++) {
      if (sa.p.RepeatCheckSVar && !compareSpec(game, calc(game, sa.p.RepeatCheckSVar, sa), sa.p.RepeatSVarCompare, ctxOf(game, sa))) break;
      const sub = makeSA(game, sa.svars[name], sa.svars, sa.host, sa.controller, { parent: sa, key: sa.key + name });
      if (await chooseTargetsForSA(game, sub, { optional: true })) await resolveChain(game, sub);
    }
  },

  async RepeatEach(game, sa) {
    const p = sa.p;
    const ctx = ctxOf(game, sa);
    const name = p.RepeatSubAbility;
    if (!name || !sa.svars[name]) return;
    let items = [];
    if (p.RepeatPlayers) items = playersOf(resolveDefined(game, p.RepeatPlayers, ctx));
    else if (p.RepeatCards) { const zone = Z(p.Zone || 'Battlefield'); items = game.cardsInZone(zone).filter(c => matchValid(game, c, p.RepeatCards, ctx)); }
    else if (p.DefinedCards) items = resolveDefined(game, p.DefinedCards, ctx);
    else if (p.RepeatCounters) items = [];
    if (p.StartingWith === 'You') items.sort((a, b) => (a.id === sa.controller ? -1 : 0) - (b.id === sa.controller ? -1 : 0));
    const prev = sa.host.remembered;
    const prevImp = sa.host.imprinted;
    const useImp = p.UseImprinted === 'True';
    const added = [];
    for (const it of items.slice(0, 60)) {
      if (useImp) sa.host.imprinted = [it];
      else sa.host.remembered = [...(p.RememberOld ? prev : []), it];
      const sub = makeSA(game, sa.svars[name], sa.svars, sa.host, it.isPlayer && p.RepeatOptionalDecider !== 'You' && p.ChangeController === 'True' ? it.id : sa.controller, { parent: sa, key: sa.key + name });
      sub.etbCard = sa.etbCard;
      if (!useImp) for (const s of sub.chain()) s.rememberedOverride = [it];
      if (p.RepeatOptionalDecider) {
        const yes = await game.ask(sa.controller, { type: 'confirm', prompt: `${desc(game, sub)} for ${game.name(it)}?`, purpose: 'optional', sa: sub });
        if (!yes) continue;
      }
      if (await chooseTargetsForSA(game, sub, { optional: true })) await resolveChain(game, sub);
      // what the iterations remember ("RememberChosen") outlives the loop; the iterated object doesn't
      if (!useImp) for (const x of sa.host.remembered || []) if (x !== it && !prev.includes(x) && !added.includes(x)) added.push(x);
    }
    if (useImp) sa.host.imprinted = prevImp; else sa.host.remembered = [...prev, ...added];
  },

  async Branch(game, sa) {
    const p = sa.p;
    const ctx = ctxOf(game, sa);
    let cond = true;
    if (p.BranchConditionSVar) cond = compareSpec(game, calc(game, p.BranchConditionSVar, sa), p.BranchConditionSVarCompare || 'GE1', ctx);
    else if (p.BranchCondition) cond = true;
    const name = cond ? p.TrueSubAbility : p.FalseSubAbility;
    if (name && sa.svars[name]) {
      const sub = makeSA(game, sa.svars[name], sa.svars, sa.host, sa.controller, { parent: sa, key: sa.key + name });
      sub.etbCard = sa.etbCard;
      if (await chooseTargetsForSA(game, sub, { optional: true })) await resolveChain(game, sub);
    }
  },

  async AddPhase(game, sa) {
    if ((sa.p.ExtraPhase || '').includes('Combat') || sa.p.ExtraPhase === 'BeginCombat') {
      game.extraCombats = (game.extraCombats || 0) + 1;
      game.log('An additional combat phase will follow.');
      // "at the beginning of that combat, ..."
      const dt = sa.p.ExtraPhaseDelayedTrigger && sa.svars[sa.p.ExtraPhaseDelayedTrigger];
      const ex = sa.p.ExtraPhaseDelayedTriggerExcute || sa.p.ExtraPhaseDelayedTriggerExecute;
      if (dt && ex) game.delayed.push({ id: game.uid++, p: { ...parseAbility(dt).p, Execute: ex, ValidPlayer: undefined }, svars: sa.svars, host: sa.host, controller: sa.controller, remembered: [], turn: game.turnNumber, thisTurnOnly: true, afterCombats: (game.combatsThisTurn || 0) + 1 });
    }
  },
  async AddTurn(game, sa) {
    const n = sa.p.NumTurns ? calc(game, sa.p.NumTurns, sa) : 1;
    for (const pl of playersOf(objs(game, sa, 'You'))) {
      if (n <= 0) continue;
      for (let i = 0; i < n; i++) game.extraTurns.push(pl.id);
      game.log(`${pl.name} will take ${n === 1 ? 'an extra turn' : n + ' extra turns'} after this one.`);
    }
  },

  async Cleanup(game, sa) {
    const h = sa.host;
    const p = sa.p;
    if (p.ClearRemembered === 'True') h.remembered = [];
    if (p.ClearImprinted === 'True') h.imprinted = [];
    if (p.ClearChosenCard === 'True' && h.chosen) delete h.chosen.cards;
    if (p.ClearChosenType === 'True' && h.chosen) delete h.chosen.type;
    if (p.ClearCoinFlips === 'True') h.flipResults = null;
    if (p.ClearChosenPlayer === 'True' && h.chosen) delete h.chosen.player;
    if (p.ClearNamedCard === 'True' && h.chosen) delete h.chosen.name;
    if (p.ForgetDefined) { const f = resolveDefined(game, p.ForgetDefined, ctxOf(game, sa)); h.remembered = (h.remembered || []).filter(x => !f.includes(x)); }
    game.touch();
  },

  async Phases(game, sa) {
    const out = [];
    for (const c of cardsOf(objs(game, sa, 'Self'))) {
      if (c.zone !== 'battlefield') continue;
      if (c.phasedOut) { if (sa.p.PhaseInOrOut === 'True') { c.phasedOut = false; game.log(`${game.name(c)} phases in.`); } continue; }
      c.phasedOut = true; out.push(c);
      game.log(`${game.name(c)} phases out.`);
    }
    game.touch();
    if (out.length) game.fire('PhaseOutAll', { Cards: out, Amount: out.length });
  },

  async Play(game, sa) {
    const p = sa.p;
    const ctx = ctxOf(game, sa);
    let cards;
    if (p.Valid) {
      const zones = (p.ValidZone || 'Hand').split(',').map(Z);
      cards = zones.flatMap(z => z === 'battlefield' ? [] : game.cardsInZone(z)).filter(c => matchValid(game, c, p.Valid, ctx));
    } else cards = cardsOf(objs(game, sa, 'Self'));
    cards = cards.filter(c => c.zone !== 'stack' && c.zone !== 'battlefield' && c.zone !== 'gone');
    const pid = p.Controller ? (playersOf(resolveDefined(game, p.Controller, ctx))[0] || game.players[sa.controller]).id : sa.controller;
    let amount = p.Amount === 'All' ? cards.length : num(game, sa, 'Amount', 1);
    const free = p.WithoutManaCost === 'True';
    for (let i = 0; i < amount && cards.length; i++) {
      const castable = cards.filter(c => {
        const ch = game.chars(c);
        if (ch.types.has('Land')) return !p.ValidSA || /Land/.test(p.ValidSA);
        if (p.ValidSA && /^Spell\.cmcLE(\d+)/.test(p.ValidSA) && ch.cmc > +RegExp.$1) return false;
        return true;
      });
      if (!castable.length) break;
      let pick;
      if (castable.length === 1 && p.Optional !== 'True') pick = castable[0];
      else { const ch = await chooseCards(game, pid, castable, p.Optional === 'True' ? 0 : 1, 1, `Choose a card to ${free ? 'cast without paying its mana cost' : 'play'}`, sa, 'playFree', { reveal: true }); pick = ch[0]; }
      if (!pick) break;
      if (p.Optional === 'True' && castable.length === 1) {
        const yes = await game.ask(pid, { type: 'confirm', prompt: `Cast ${game.name(pick)}${free ? ' without paying its mana cost' : ''}?`, purpose: 'castFree', sa, cards: [pick.id] });
        if (!yes) break;
      }
      cards = cards.filter(c => c !== pick);
      if (game.chars(pick).types.has('Land') && p.CopyCard !== 'True') { await game.moveCard(pick, 'battlefield', { controller: pid }); continue; }
      if (p.CopyCard === 'True') {
        // "copy that card; you may cast the copy" — the copy is a new object that stops existing outside the stack
        const copy = game.newCard(pick.def, pid);
        copy.token = true; copy.isSpellCopy = true; copy.zone = 'none'; copy.face = pick.face;
        let ok = false;
        try { ok = await castSpell(game, pid, copy, {}, { free, fromEffect: true, effectSA: sa }); } catch (e) { if (!e.cancelled) throw e; }
        if (!ok && copy.zone === 'none') { copy.zone = 'gone'; game.cards.delete(copy.id); }
        continue;
      }
      try {
        const ok = await castSpell(game, pid, pick, {}, { free, fromEffect: true, effectSA: sa });
        if (ok && p.ReplaceGraveyard === 'Exile') pick.mustBeExiled = true;
        if (ok && p.ForgetPlayed === 'True' && sa.host.remembered) sa.host.remembered = sa.host.remembered.filter(x => x !== pick);
        if (ok && p.RememberPlayed === 'True') remember(sa, [pick]);
      } catch (e) { if (!e.cancelled) throw e; }
    }
  },

  async Cascade(game, sa) {
    const spell = sa.trig && sa.trig.Card;
    const pid = sa.controller;
    const pl = game.players[pid];
    const mv = spell ? game.chars(spell).cmc : 0;
    const exiled = [];
    let hit = null;
    while (pl.library.length) {
      const c = pl.library[0];
      await game.moveCard(c, 'exile', { silent: true });
      exiled.push(c);
      const ch = game.chars(c);
      if (!ch.types.has('Land') && ch.cmc < mv) { hit = c; break; }
    }
    game.log(`Cascade: ${pl.name} exiles ${exiled.length} card(s)${hit ? ', hitting ' + game.name(hit) : ''}.`);
    if (hit) {
      const yes = await game.ask(pid, { type: 'confirm', prompt: `Cascade: cast ${game.name(hit)} without paying its mana cost?`, purpose: 'castFree', sa, cards: [hit.id] });
      if (yes) {
        try { await castSpell(game, pid, hit, {}, { free: true, fromEffect: true, effectSA: sa }); } catch (e) { if (!e.cancelled) throw e; }
      }
    }
    const rest = exiled.filter(c => c.zone === 'exile');
    game.rng.shuffle(rest);
    for (const c of rest) await game.moveCard(c, 'library', { pos: 'bottom', silent: true });
  },

  async Discover(game, sa) {
    const pid = sa.controller;
    const pl = game.players[pid];
    const mv = num(game, sa, 'Num', 0);
    const exiled = [];
    let hit = null;
    while (pl.library.length) {
      const c = pl.library[0];
      await game.moveCard(c, 'exile', { silent: true });
      exiled.push(c);
      const ch = game.chars(c);
      if (!ch.types.has('Land') && ch.cmc <= mv) { hit = c; break; }
    }
    if (hit) {
      const yes = await game.ask(pid, { type: 'confirm', prompt: `Discover: cast ${game.name(hit)} without paying its mana cost? (No puts it into your hand)`, purpose: 'castFree', sa, cards: [hit.id] });
      let cast = false;
      if (yes) { try { cast = await castSpell(game, pid, hit, {}, { free: true, fromEffect: true, effectSA: sa }); } catch (e) { if (!e.cancelled) throw e; } }
      if (!cast && hit.zone === 'exile') await game.moveCard(hit, 'hand');
    }
    const rest = exiled.filter(c => c.zone === 'exile');
    game.rng.shuffle(rest);
    for (const c of rest) await game.moveCard(c, 'library', { pos: 'bottom', silent: true });
  },

  async Myriad(game, sa) {
    const host = sa.host.lki ? sa.host.card : sa.host;
    if (!host || host.zone !== 'battlefield' || !game.combat) return;
    const rec = game.combat.attackers.find(a => a.card === host.id);
    for (const opp of game.opponents(sa.controller)) {
      if (rec && rec.defenderPlayer === opp.id) continue;
      const yes = await game.ask(sa.controller, { type: 'confirm', prompt: `Myriad: create a token copy attacking ${opp.name}?`, purpose: 'myriad', sa });
      if (!yes) continue;
      const t = await game.createToken(host.def, sa.controller, sa, { copyOf: { def: host.copyOf ? host.copyOf.def : host.def, face: host.face }, tapped: true, attacking: opp.id });
      if (t) game.delayed.push({ id: game.uid++, p: { Mode: 'Phase', Phase: 'EndCombat', Execute: 'MyriadExile' }, svars: { MyriadExile: 'DB$ ChangeZone | Defined$ DelayTriggerRemembered | Origin$ Battlefield | Destination$ Exile' }, host: t, controller: sa.controller, remembered: [t], turn: game.turnNumber, thisTurnOnly: true });
    }
  },

  async EchoUpkeep(game, sa) {
    const host = sa.host;
    const cost = parseCost(sa.p.EchoCost || '');
    host.echoPaid = true;
    if (cost.hasMana && canAfford(game, sa.controller, cost.mana)) {
      const yes = await game.ask(sa.controller, { type: 'confirm', prompt: `Pay echo for ${game.name(host)}? (otherwise sacrifice it)`, purpose: 'echo', sa, cost: cost.mana });
      if (yes && await payManaCost(game, sa.controller, cost.mana)) return;
    }
    await game.sacrifice(host, sa);
  },

  async Devour(game, sa) {
    const host = sa.host;
    const pool = game.battlefield.filter(c => c.controller === sa.controller && c !== host && game.chars(c).types.has(sa.p.DevourType || 'Creature'));
    if (!pool.length) return;
    const chosen = await chooseCards(game, sa.controller, pool, 0, pool.length, 'Devour: sacrifice any number of creatures', sa, 'devour');
    for (const c of chosen) await game.sacrifice(c, sa);
    if (chosen.length) await game.addCounters(host, 'P1P1', chosen.length * num(game, sa, 'Amount', 1), sa);
  },

  async Ninjutsu(game, sa) {
    const card = sa.host;
    if (!game.combat || (card.zone !== 'hand' && card.zone !== 'command')) return;
    const unblocked = game.combat.attackers.filter(a => !a.blocked).map(a => ({ a, c: game.cardById(a.card) })).filter(x => x.c && x.c.controller === sa.controller);
    if (!unblocked.length) return;
    const pick = await chooseCards(game, sa.controller, unblocked.map(x => x.c), 1, 1, 'Ninjutsu: return an unblocked attacker', sa, 'ninjutsu');
    if (!pick[0]) return;
    const rec = unblocked.find(x => x.c === pick[0]).a;
    const def = rec.defenderPlayer;
    await game.moveCard(pick[0], 'hand');
    const n = await game.moveCard(card, 'battlefield', { controller: sa.controller, tapped: true });
    if (n) game.combat.attackers.push({ card: n.id, defenderPlayer: def, defenderCard: rec.defenderCard && game.cardById(rec.defenderCard) && game.cardById(rec.defenderCard).zone === 'battlefield' ? rec.defenderCard : null, blockers: [], blocked: false });
  },

  async AlterAttribute(game, sa) {
    const attrs = (sa.p.Attributes || '').split(',');
    for (const c of cardsOf(objs(game, sa, 'Self'))) {
      for (const a of attrs) {
        if (a === 'Suspected') { c.suspected = true; c.temp.push({ keywords: ['Menace', "CARDNAME can't block."], until: 'Permanent', suspect: true }); }
        if (a === 'Solved') c.solved = true;
        if (a === 'Renowned') c.renowned = true;
        if (a === 'Harnessed') c.harnessed = true;
        if (a === 'Saddle' || a === 'Saddled') saddle(game, sa, c);
      }
    }
    game.touch();
  },

  async Venture(game, sa) {
    for (const pl of playersOf(objs(game, sa, 'You'))) await game.venture(pl.id, { undercity: sa.p.Dungeon === 'Undercity' });
  },
  async ReplaceEffect() {}, async ReplaceCounter() {}, async ReplaceToken() {}, async ReplaceDamage() {}, async ReplaceSplitDamage() {},
  async StoreSVar(game, sa) {
    const name = sa.p.SVar;
    if (!name) return;
    let v = 0;
    if (sa.p.Type === 'Number') v = +sa.p.Expression || 0;
    else if (sa.p.Type === 'Count') v = calc(game, 'Count$' + sa.p.Expression, sa);
    else v = calc(game, sa.p.Expression, sa);
    storeSVar(sa, name, `Number$${v}`);
  },
  async Learn(game, sa) {},
  async Seek(game, sa) {
    const pl = game.players[sa.controller];
    const pool = pl.library.filter(c => matchValid(game, c, sa.p.Type || 'Card', ctxOf(game, sa)));
    const n = num(game, sa, 'Num', 1);
    for (let i = 0; i < n && pool.length; i++) { const c = pool.splice(game.rng.int(pool.length), 1)[0]; await game.moveCard(c, 'hand'); }
  },
  async Incubate(game, sa) {
    const n = num(game, sa, 'Amount', 1);
    const t = await makeTokens(game, sa, 'incubator_c_0_0_a_phyrexian', sa.controller, num(game, sa, 'Times', 1));
    for (const x of t) await game.addCounters(x, 'P1P1', n, sa);
  },
  async PermanentCreature() {}, async PermanentNoncreature() {},
  async Monstrosity(game, sa) {
    const n = num(game, sa, 'Num', 1);
    const host = sa.host;
    if (host.monstrous) return;
    await game.addCounters(host, 'P1P1', n, sa);
    host.monstrous = true;
    game.fire('BecomeMonstrous', { Card: host });
  },
  // choose new targets for target spell or ability (Emissary of Grudges)
  async ChangeTargets(game, sa) {
    const ctx = ctxOf(game, sa);
    const items = (hasTgtSpec(sa) ? sa.targets : resolveDefined(game, sa.p.Defined || 'Targeted', ctx)).filter(t => t && t.stackItem && game.stack.includes(t));
    for (const item of items) {
      if (sa.p.ConditionPlayerContains && !matchValid(game, game.players[item.controller], sa.p.ConditionPlayerContains, ctx)) continue;
      if (sa.p.ConditionTargetValidTargeting && !item.sa.chain().flatMap(s => s.targets || []).some(t => matchValid(game, t, sa.p.ConditionTargetValidTargeting, ctx))) continue;
      let changed = false;
      for (const s of item.sa.chain()) {
        const spec = targetSpec(game, s);
        if (!spec || !s.targets || !s.targets.length) continue;
        const cands = targetCandidates(game, s, spec).filter(c => c !== item);
        if (!cands.length) continue;
        const max = Math.min(spec.max, cands.length);
        const chooser = sa.p.Chooser ? (playersOf(resolveDefined(game, sa.p.Chooser, ctx))[0] || game.players[sa.controller]) : game.players[sa.controller];
        const ans = await game.ask(chooser.id, { type: 'targets', prompt: `Choose new targets for ${item.description}`, cands: cands.map(refOf), min: Math.min(spec.min, max), max, sa: s, spec, purpose: 'changeTargets' });
        const picked = (ans || []).map(r => fromRef(game, r)).filter(o => o && cands.includes(o));
        if (picked.length < spec.min) continue;
        s.targets = picked; s.targetZcc = picked.map(o => (o.isCard ? o.zcc : null)); changed = true;
      }
      if (changed) { game.touch(); game.log(`${game.players[sa.controller].name} changes the targets of ${item.description} (now ${item.sa.chain().flatMap(s => s.targets || []).map(t => game.name(t)).join(', ')}).`); }
    }
  },
  async ExchangeZone() {},
  async RearrangeTopOfLibrary(game, sa) {
    const pl = playersOf(objs(game, sa, 'You'))[0] || game.players[sa.controller];
    const n = num(game, sa, 'NumCards', 3);
    if (sa.p.MayShuffle === 'True' && await game.ask(sa.controller, { type: 'confirm', prompt: 'Shuffle the library instead?', purpose: 'shuffle', sa })) { game.shuffle(pl, sa); return; }
    await scry(game, sa.controller, Math.min(n, pl.library.length), sa);
  },
  async Radiation(game, sa) { for (const pl of playersOf(objs(game, sa, 'You'))) await game.addCounters(pl, 'RAD', num(game, sa, 'Num', 1), sa); },
  async Pay(game, sa) {},

  async Protection(game, sa) {
    const colors = await protectionColors(game, sa);
    for (const c of cardsOf(objs(game, sa, 'Self'))) {
      if (c.zone !== 'battlefield') continue;
      const rec = { keywords: colors.map(col => 'Protection from ' + col) };
      applyDuration(game, sa, c, rec);
      c.temp.push(rec);
      game.log(`${game.name(c)} gains protection from ${colors.join(' and ')}.`);
    }
    game.touch();
  },
  async ProtectionAll(game, sa) {
    const colors = await protectionColors(game, sa);
    const ctx = ctxOf(game, sa);
    for (const c of game.battlefield.filter(c => matchValid(game, c, sa.p.ValidCards || 'Creature.YouCtrl', ctx))) {
      const rec = { keywords: colors.map(col => 'Protection from ' + col) };
      applyDuration(game, sa, c, rec);
      c.temp.push(rec);
    }
    game.log(`${desc(game, sa)}`);
    game.touch();
  },
  async TapOrUntap(game, sa) {
    for (const c of cardsOf(objs(game, sa, 'Self'))) {
      const decider = sa.p.Tapper ? (playersOf(resolveDefined(game, sa.p.Tapper, ctxOf(game, sa)))[0] || game.players[sa.controller]) : game.players[sa.controller];
      const tap = await game.ask(decider.id, { type: 'option', prompt: `Tap or untap ${game.name(c)}?`, options: [{ label: 'Tap', value: 'tap' }, { label: 'Untap', value: 'untap' }], purpose: 'tapOrUntap', sa, cardId: c.id });
      if (tap === 'untap') await game.untap(c); else await game.tap(c);
    }
  },
  async Poison(game, sa) {
    const n = num(game, sa, 'Num', 1);
    for (const pl of playersOf(objs(game, sa, 'You'))) await game.addCounters(pl, 'POISON', n, sa);
  },
  async Fog(game, sa) {
    const e = { isEffect: true, id: game.nextId++, effectName: `${game.name(sa.host)} (fog)`, controller: sa.controller, owner: sa.controller, zone: 'command', duration: 'EOT', remembered: [], imprinted: [], chosen: {}, counters: {}, timestamp: game.uid++, temp: [], mods: [], abilityUses: {} };
    const raw = 'Event$ DamageDone | IsCombat$ True | Prevent$ True | Description$ Prevent all combat damage this turn.';
    e.effectChars = { name: e.effectName, types: new Set(['Effect']), subtypes: new Set(), supertypes: new Set(), colors: new Set(), keywords: [], abilities: [], triggers: [], statics: [], replacements: [{ raw, parsed: parseAbility(raw), svars: {}, src: e, key: 'fog' }], svars: {}, power: 0, toughness: 0, cmc: 0 };
    game.effects.push(e);
    game.touch();
    game.log('All combat damage will be prevented this turn.');
  },
  async RemoveFromCombat(game, sa) {
    if (!game.combat) return;
    for (const c of cardsOf(objs(game, sa, 'Self'))) {
      if (sa.p.UnblockCreaturesBlockedOnlyBy) unblockBlockedOnlyBy(game, c);
      game.combat.attackers = game.combat.attackers.filter(a => a.card !== c.id);
      game.combat.blockers.delete(c.id);
      for (const a of game.combat.attackers) a.blockers = a.blockers.filter(b => b !== c.id);
      game.log(`${game.name(c)} is removed from combat.`);
    }
    game.touch();
  },
  async AddOrRemoveCounter(game, sa) {
    for (const c of cardsOf(objs(game, sa, 'Self'))) {
      const types = Object.keys(c.counters).filter(k => c.counters[k] > 0);
      if (!types.length) continue;
      const t = types.length === 1 ? types[0] : await game.ask(sa.controller, { type: 'option', prompt: 'Choose a counter type', options: types.map(x => ({ label: counterLabel(x), value: x })), purpose: 'counterType', sa });
      const add = await game.ask(sa.controller, { type: 'option', prompt: `Add or remove a ${counterName(t)} counter on ${game.name(c)}?`, options: [{ label: 'Add', value: 'add' }, { label: 'Remove', value: 'remove' }], purpose: 'addOrRemove', sa, cardId: c.id });
      if (add === 'remove') await game.removeCounters(c, t, num(game, sa, 'CounterNum', 1)); else await game.addCounters(c, t, num(game, sa, 'CounterNum', 1), sa, { anyZone: true });
    }
  },
  async VillainousChoice(game, sa) {
    const names = (sa.p.Choices || '').split(',').map(x => x.trim()).filter(n => sa.svars[n]);
    for (const pl of playersOf(objs(game, sa, 'Opponent'))) {
      const pick = await game.ask(pl.id, { type: 'option', prompt: `Villainous choice (${game.name(sa.host)})`, options: names.map(n => ({ label: parseAbility(sa.svars[n]).p.SpellDescription || n, value: n })), purpose: 'villainousChoice', sa });
      const n = pick || names[0];
      const prev = sa.host.remembered;
      sa.host.remembered = [pl];
      const sub = makeSA(game, sa.svars[n], sa.svars, sa.host, sa.controller, { parent: sa, key: sa.key + n });
      for (const x of sub.chain()) x.rememberedOverride = [pl];
      await resolveChain(game, sub);
      sa.host.remembered = prev;
    }
  },
  async GainControlVariant(game, sa) {
    const ctx = ctxOf(game, sa);
    const list = sa.p.AllValid ? game.battlefield.filter(c => matchValid(game, c, sa.p.AllValid, ctx)) : cardsOf(objs(game, sa, 'Self'));
    const mode = sa.p.ChangeController;
    const dir = (sa.host.chosen && sa.host.chosen.direction) || 'Left';
    const back = dir === 'Left' ? 'Right' : 'Left';
    const moves = [];
    if (mode === 'ChooseNextPlayerInChosenDirection' || mode === 'ChooseFromPlayerToTheirRight') {
      // starting with you and proceeding in the direction, each player chooses one of the next player's permanents
      const order = [];
      const d = mode === 'ChooseFromPlayerToTheirRight' ? 'Right' : dir;
      for (let pid = sa.controller, k = 0; k < game.players.length && pid != null && !order.includes(pid); k++) { order.push(pid); pid = playerInDirection(game, pid, d); }
      for (const pid of order) {
        const from = playerInDirection(game, pid, d);
        const pool = list.filter(c => c.controller === from);
        const pick = (await chooseCards(game, pid, pool, 1, 1, `Choose a permanent ${game.players[from].name} controls to gain control of`, sa, 'gainControlChoice'))[0];
        if (pick) moves.push([pick, pid]);
      }
    } else for (const c of list) {
      // each player gains control of what the next player in the chosen direction controls
      const to = mode === 'CardOwner' ? c.owner : mode === 'NextPlayerInChosenDirection' ? playerInDirection(game, c.controller, back) : sa.controller;
      if (to != null) moves.push([c, to]);
    }
    for (const [c, to] of moves) {
      if (c.zone !== 'battlefield' || c.controller === to) continue;
      const prev = c.controller;
      c.controller = to; c.sick = true;
      if (game.combat) { game.combat.attackers = game.combat.attackers.filter(a => a.card !== c.id); game.combat.blockers.delete(c.id); }
      game.fire('ChangesController', { Card: c, OriginalController: prev });
    }
    game.touch();
    game.log(desc(game, sa));
  },

  async ChooseDirection(game, sa) {
    const target = sa.etbCard || sa.host;
    const pid = sa.controller;
    const dir = await game.ask(pid, { type: 'option', prompt: `${game.name(sa.host)}: choose left or right`, options: [{ label: `Left (toward ${game.players[playerInDirection(game, pid, 'Left') ?? pid].name})`, value: 'Left' }, { label: `Right (toward ${game.players[playerInDirection(game, pid, 'Right') ?? pid].name})`, value: 'Right' }], sa, purpose: 'chooseDirection', ai: sa.p.AILogic });
    target.chosen = { ...(target.chosen || {}), direction: dir === 'Right' ? 'Right' : 'Left' };
    game.log(`${game.players[pid].name} chooses ${target.chosen.direction.toLowerCase()}.`);
    game.touch();
  },

  // "target creature blocks <attacker> this turn if able" (Grappling Hook, provoke)
  async MustBlock(game, sa) {
    if (sa.p.BlockAllDefined) return mustBlockAll(game, sa, cardsOf(objs(game, sa, 'Self')));
    const ctx = ctxOf(game, sa);
    const attacker = cardsOf(resolveDefined(game, sa.p.DefinedAttacker || 'Self', ctx)).map(c => liveOrLki(game, c)).find(c => c && c.isCard);
    if (!attacker) return;
    for (const c of cardsOf(objs(game, sa, 'Self'))) {
      if (c.zone !== 'battlefield') continue;
      c.mustBlock = { attacker: attacker.id, turn: game.turnNumber };
      game.log(`${game.name(c)} must block ${game.name(attacker)} this turn if able.`);
    }
    game.touch();
  },

  // reselect which player or permanent an attacking creature attacks (or put it into combat attacking)
  async ChangeCombatants(game, sa) {
    if (!game.combat) return;
    const ctx = ctxOf(game, sa);
    for (const c of cardsOf(objs(game, sa, 'Self'))) {
      if (c.zone !== 'battlefield') continue;
      const rec = game.combat.attackers.find(a => a.card === c.id);
      let opts = defendersFor(game, c.controller);
      const spec = sa.p.Attacking;
      if (spec && spec !== 'True') {
        const ok = new Set();
        for (let part of spec.split(' & ').map(s => s.trim())) {
          if (part.startsWith('.')) part = 'Player' + part;
          if (part.startsWith('Valid ')) { for (const x of resolveDefined(game, part, ctx)) if (x && x.isCard) ok.add('c' + x.id); continue; }
          if (/^(Player|Opponent|You)(\.|$)/.test(part)) { for (const pl of game.livingPlayers()) if (matchValid(game, pl, part, ctx)) ok.add('p' + pl.id); continue; }
          for (const x of resolveDefined(game, part, ctx)) if (x) ok.add(x.isPlayer ? 'p' + x.id : 'c' + x.id);
        }
        opts = opts.filter(d => ok.has(d.ref));
      }
      if (!opts.length) continue;
      const cur = rec ? (rec.defenderCard ? 'c' + rec.defenderCard : 'p' + rec.defenderPlayer) : null;
      const label = d => d.card ? game.name(game.cardById(d.card)) : game.players[d.player].name;
      const options = opts.map(d => ({ label: `${d.ref === cur ? 'Keep attacking' : 'Attack'} ${label(d)}`, value: d.ref }));
      const pick = opts.length === 1 && !rec ? opts[0].ref : await game.ask(sa.controller, { type: 'option', prompt: `${game.name(c)}: choose what it attacks`, options, sa, purpose: 'changeCombatants', cardId: c.id, ai: sa.p.AILogic });
      const d = opts.find(x => x.ref === pick) || opts[0];
      if (rec) { rec.defenderPlayer = d.player; rec.defenderCard = d.card || null; }
      else game.combat.attackers.push({ card: c.id, defenderPlayer: d.player, defenderCard: d.card || null, blockers: [], blocked: false });
      game.touch();
      if (d.ref !== cur) game.log(`${game.name(c)} is now attacking ${label(d)}.`);
    }
  },
  async DamageResolve() {},
  async Balance(game, sa) {
    const pls = game.livingPlayers();
    const zone = sa.p.Zone ? Z(sa.p.Zone) : 'battlefield';
    const ctx = ctxOf(game, sa);
    const valid = sa.p.Valid || 'Card';
    const counts = pls.map(pl => (zone === 'battlefield' ? game.battlefield.filter(c => c.controller === pl.id && matchValid(game, c, valid, ctx)) : pl[zone]).length);
    const min = Math.min(...counts);
    for (const pl of pls) {
      const pool = zone === 'battlefield' ? game.battlefield.filter(c => c.controller === pl.id && matchValid(game, c, valid, ctx)) : pl[zone].slice();
      const excess = pool.length - min;
      if (excess <= 0) continue;
      const chosen = await chooseCards(game, pl.id, pool, excess, excess, zone === 'hand' ? `Balance: discard ${excess}` : `Balance: sacrifice ${excess}`, sa, zone === 'hand' ? 'discard' : 'sacrifice');
      for (const c of chosen) { if (zone === 'hand') await game.discard(c, sa); else await game.sacrifice(c, sa); }
    }
  },
  async ManifestDread(game, sa) {
    const pl = game.players[sa.controller];
    const top = pl.library.slice(0, 2);
    if (!top.length) return;
    const pick = (await chooseCards(game, pl.id, top, 1, 1, 'Manifest dread: choose a card to manifest', sa, 'manifestDread', { reveal: true }))[0] || top[0];
    const r = await game.moveCard(pick, 'battlefield', { controller: pl.id, faceDown: true, silent: true, setProps: { manifested: true } });
    if (r && sa.p.RememberManifested === 'True') remember(sa, [r]);
    for (const c of top) if (c !== pick) await game.moveCard(c, 'graveyard', { silent: true });
    game.log(`${pl.name} manifests dread.`);
  },
  async NameCard(game, sa) {
    for (const pl of playersOf(objs(game, sa, 'You'))) {
      const own = pl.library.concat(pl.hand).map(c => c.def.faces[0].name);
      const n = own.length ? own[game.rng.int(own.length)] : 'Island';
      pl.namedCard = n;
      sa.host.chosen = { ...(sa.host.chosen || {}), name: n };
      game.log(`${pl.name} names ${n}.`);
    }
  },
  async Clash(game, sa) {
    const me = game.players[sa.controller];
    const opps = game.opponents(sa.controller);
    let opp = sa.p.Defined ? playersOf(resolveDefined(game, sa.p.Defined, ctxOf(game, sa))).find(p => p.id !== me.id && !p.lost) : null;
    if (!opp && opps.length === 1) opp = opps[0];
    else if (!opp && opps.length) {
      const id = await game.ask(me.id, { type: 'player', prompt: 'Choose an opponent to clash with', players: opps.map(p => p.id), sa, purpose: 'clashOpponent', ai: 'Opponent' });
      opp = opps.find(p => p.id === id) || opps[0];
    }
    const a = me.library[0], b = opp && opp.library[0];
    const va = a ? game.chars(a).cmc : -1, vb = b ? game.chars(b).cmc : -1;
    game.log(`${me.name} clashes${opp ? ' with ' + opp.name : ''}: ${a ? game.name(a) + ' (' + va + ')' : 'nothing'} vs ${b ? game.name(b) + ' (' + vb + ')' : 'nothing'}.`);
    game.fire('Clashed', { Player: me.id, Won: va > vb });
    if (opp) game.fire('Clashed', { Player: opp.id, Won: vb > va });
    // each clashing player puts the revealed card on the top or bottom of their library
    for (const [pl, c] of [[me, a], [opp, b]]) {
      if (!pl || !c || pl.library[0] !== c) continue;
      const bottom = await game.ask(pl.id, { type: 'confirm', prompt: `Clash: put ${game.name(c)} on the bottom of your library?`, purpose: 'clashBottom', cards: [c.id], sa });
      if (bottom) { pl.library.shift(); pl.library.push(c); game.touch(); }
    }
    if (sa.p.RememberClasher === 'True' && opp) remember(sa, [opp]);
    const name = va > vb ? sa.p.WinSubAbility : sa.p.OtherwiseSubAbility;
    if (name && sa.svars[name]) await resolveChain(game, makeSA(game, sa.svars[name], sa.svars, sa.host, sa.controller, { parent: sa }));
  },
  async TimeTravel(game, sa) {
    const pid = sa.controller;
    for (const c of [...game.battlefield.filter(c => c.controller === pid), ...game.players[pid].exile]) {
      if (!(c.counters.TIME > 0)) continue;
      await game.removeCounters(c, 'TIME', 1);
    }
  },
  async ChangeX(game, sa) {
    const items = resolveDefined(game, sa.p.Defined || 'TriggeredSpellAbility', ctxOf(game, sa)).filter(x => x && x.stackItem);
    for (const it of items) {
      const cur = it.sa.root().x || 0;
      it.sa.root().x = cur * 2;
      if (it.card) it.card.xPaid = cur * 2;
      game.log(`X becomes ${cur * 2} for ${it.description}.`);
    }
  },
  async ExchangeLifeVariant(game, sa) {
    const host = sa.host;
    const pl = playersOf(objs(game, sa, 'Opponent'))[0];
    if (!pl || !host || host.zone !== 'battlefield') return;
    const t = game.chars(host).toughness;
    const life = pl.life;
    pl.life = t;
    host.mods.push({ id: game.uid++, toughness: life, until: 'Permanent' });
    game.touch();
    game.log(`${pl.name}'s life total becomes ${t}; ${game.name(host)}'s toughness becomes ${life}.`);
  },
  async RingTemptsYou(game, sa) {
    const pid = sa.controller;
    const mine = game.battlefield.filter(c => c.controller === pid && game.chars(c).types.has('Creature'));
    if (!mine.length) { game.log(`The Ring tempts ${game.players[pid].name}.`); return; }
    const pick = (await chooseCards(game, pid, mine, 1, 1, 'The Ring tempts you: choose your Ring-bearer', sa, 'ringBearer'))[0];
    for (const c of game.battlefield) if (c.ringBearer && c.controller === pid) { c.ringBearer = false; c.temp = c.temp.filter(t => !t.ring); }
    if (pick) { pick.ringBearer = true; pick.temp.push({ keywords: ['Legendary'], until: 'Permanent', ring: true }); game.log(`The Ring tempts ${game.players[pid].name}; ${game.name(pick)} becomes the Ring-bearer.`); }
    game.touch();
  },
  async Suspend(game, sa) {
    const c = sa.host;
    if (c.zone !== 'hand') return;
    const n = sa.p.SuspendTime === 'X' ? (sa.root().x || 1) : num(game, sa, 'SuspendTime', 1);
    await game.moveCard(c, 'exile', { silent: true });
    c.suspended = true;
    c.xPaid = sa.root().x || 0;
    await game.addCounters(c, 'TIME', n, sa, { anyZone: true, silent: true });
    game.log(`${game.players[sa.controller].name} suspends ${game.name(c)} with ${n} time counter${n > 1 ? 's' : ''}.`);
  },
  async SuspendTick(game, sa) {
    const c = sa.host;
    if (c.zone !== 'exile' || !(c.counters.TIME > 0)) return;
    await game.removeCounters(c, 'TIME', 1);
    if ((c.counters.TIME || 0) === 0) {
      game.log(`The last time counter is removed from ${game.name(c)}.`);
      c.suspended = false;
      try {
        const ok = await castSpell(game, c.owner, c, {}, { free: true, fromEffect: true });
        if (ok && game.chars(c).types.has('Creature')) c.hasteFromSuspend = true;
      } catch (e) { if (!e.cancelled) throw e; }
    }
  },
  async Foretell(game, sa) {
    const c = sa.host;
    if (c.zone !== 'hand') return;
    await game.moveCard(c, 'exile', { silent: true, faceDown: true });
    c.foretold = true;
    c.foretoldTurn = game.turnNumber;
    game.log(`${game.players[sa.controller].name} foretells a card.`);
  },
  // soulbond: pair the host with another unpaired creature you control
  async Pair(game, sa) {
    const host = sa.host;
    const ok = c => c && c.zone === 'battlefield' && c.controller === sa.controller && game.chars(c).types.has('Creature') && !game.pairedPartner(c);
    if (!ok(host)) return;
    let partner = sa.p.Defined ? cardsOf(resolveDefined(game, sa.p.Defined, ctxOf(game, sa))).find(c => c !== host && ok(c)) : null;
    if (!sa.p.Defined) partner = (await chooseCards(game, sa.controller, game.battlefield.filter(c => c !== host && ok(c)), 1, 1, `Soulbond: pair ${game.name(host)} with`, sa, 'pair'))[0];
    if (!partner) return;
    host.pairedWith = partner.id; partner.pairedWith = host.id;
    game.touch();
    game.log(`${game.name(host)} is paired with ${game.name(partner)}.`);
  },

  // empower <type> N: loyalty counters on your <type> token, creating one first if needed
  async Empower(game, sa) {
    const type = sa.p.Type || 'Jace';
    const n = num(game, sa, 'Num', 1);
    let tok = game.battlefield.find(c => c.controller === sa.controller && c.token && game.chars(c).subtypes.has(type) && game.chars(c).types.has('Planeswalker'));
    if (!tok) { tok = (await makeTokens(game, sa, `u_empower_${type.toLowerCase()}`, sa.controller, 1))[0]; }
    if (tok) await game.addCounters(tok, 'LOYALTY', n, sa);
  },

  // gain control of target spell
  async ControlSpell(game, sa) {
    const ctx = ctxOf(game, sa);
    const to = sa.p.NewController ? playersOf(resolveDefined(game, sa.p.NewController, ctx))[0] : game.players[sa.controller];
    if (!to) return;
    const items = (hasTgtSpec(sa) ? sa.targets : resolveDefined(game, sa.p.Defined || 'Targeted', ctx)).map(x => (x && x.stackItem) ? x : game.stack.find(s => s.card === x)).filter(it => it && game.stack.includes(it));
    for (const it of items) {
      if (it.controller === to.id) continue;
      it.controller = to.id;
      for (const s of it.sa.chain()) s.controller = to.id;
      if (it.card) it.card.controller = to.id;
      game.touch();
      game.log(`${to.name} gains control of ${it.description}.`);
    }
  },

  // choose a source (Deflecting Palm)
  async ChooseSource(game, sa) {
    const pool = [...game.battlefield, ...game.stack.filter(s => s.card).map(s => s.card)];
    const pick = (await chooseCards(game, sa.controller, pool, 1, 1, sa.p.ChoiceTitle || 'Choose a source', sa, 'chooseSource'))[0];
    if (!pick) return;
    const target = sa.etbCard || sa.host;
    target.chosen = { ...(target.chosen || {}), cards: [pick.id] };
    game.log(`${game.players[sa.controller].name} chooses ${game.name(pick)}.`);
  },

  async UnlockDoor(game, sa) {
    const c = sa.host;
    if (c && c.isCard) game.unlockDoor(c, num(game, sa, 'Door', 0), sa.controller);
  },

  // plot: exile it from your hand; cast it as a sorcery on a later turn without paying its mana cost
  async Plot(game, sa) {
    const c = sa.host;
    if (!c || c.zone !== 'hand') return;
    await game.moveCard(c, 'exile', { silent: true });
    c.plotted = { turn: game.turnNumber, zcc: c.zcc };
    game.log(`${game.players[sa.controller].name} plots ${game.name(c)}.`);
  },

  // champion: exile another [type] you control or sacrifice this; it returns when this leaves
  async Champion(game, sa) {
    const host = sa.host;
    if (!host || host.zone !== 'battlefield') return;
    const type = sa.p.ChampionType || 'Creature';
    const pool = game.battlefield.filter(c => c !== host && c.controller === sa.controller && matchValid(game, c, type, ctxOf(game, sa)));
    const pick = (await chooseCards(game, sa.controller, pool, 0, 1, `Champion: exile another ${type} you control (or ${game.name(host)} is sacrificed)`, sa, 'champion'))[0];
    if (pick) { const r = await game.moveCard(pick, 'exile', { cause: sa, exiledWith: host.id }); host.championed = r ? [{ id: r.id, zcc: r.zcc }] : []; return; }
    await game.sacrifice(host, sa);
  },

  // cumulative upkeep: put an age counter, then pay the cost for each age counter or sacrifice it
  async CumulativeUpkeep(game, sa) {
    const host = sa.host;
    if (!host || host.zone !== 'battlefield') return;
    await game.addCounters(host, 'AGE', 1, sa);
    const n = host.counters.AGE || 1;
    const pid = sa.controller;
    const costStr = sa.p.UpkeepCost || '0';
    let m;
    const ask = desc => game.ask(pid, { type: 'confirm', prompt: `Cumulative upkeep for ${game.name(host)}: ${desc}? (otherwise sacrifice it)`, purpose: 'cumulativeUpkeep', sa, cardId: host.id, age: n });
    if ((m = costStr.match(/^FlipCoin<(\d+)>$/))) {
      if (await ask(`flip ${n * +m[1]} coin${n * +m[1] === 1 ? '' : 's'}`)) {
        for (let i = 0; i < n * +m[1]; i++) { const win = game.rng.int(2) === 0; game.log(`${game.players[pid].name} flips a coin: ${win ? 'wins' : 'loses'}.`); game.fire('FlippedCoin', { Player: pid, Result: win }); }
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
        return;
      }
    } else {
      const cost = parseCost(costStr);
      let mana = parseMana('0');
      for (let i = 0; i < n; i++) mana = addCosts(mana, cost.mana);
      const parts = cost.parts.map(pt => (/^\d+$/.test(pt.amount) ? { ...pt, amount: String(+pt.amount * n), args: [String(+pt.amount * n), ...pt.args.slice(1)] } : pt));
      const full = { ...cost, mana, parts, tap: false, untap: false };
      if ((!cost.hasMana || canAfford(game, pid, mana)) && canPayNonMana(game, sa, full) && await ask(`pay ${costLabelOf(costStr)} × ${n}`)) {
        if ((!cost.hasMana || await payManaCost(game, pid, mana)) && await payCostParts(game, sa, full)) return;
      }
    }
    game.log(`${game.players[pid].name} doesn't pay the cumulative upkeep for ${game.name(host)}.`);
    await game.sacrifice(host, sa);
  },

  async ReplaceMana() {}, // interpreted by the mana replacement code (Mana Reflection, Omnath)

  // "prevent the next N damage that would be dealt this turn to any number of targets, divided as you choose"
  async PreventDamage(game, sa) {
    const list = objs(game, sa, null);
    const n = num(game, sa, 'Amount', 1);
    game.shields = game.shields || [];
    list.forEach((t, i) => {
      const amt = sa.division ? sa.division[i] : n;
      if (!t || amt <= 0) return;
      game.shields.push(t.isPlayer ? { player: t.id, amount: amt, turn: game.turnNumber } : { card: t.id, zcc: t.zcc, amount: amt, turn: game.turnNumber });
      game.log(`The next ${amt} damage to ${game.name(t)} this turn will be prevented.`);
    });
  },

  async ChooseEvenOdd(game, sa) {
    const v = await game.ask(sa.controller, { type: 'option', prompt: 'Choose odd or even', options: [{ label: 'Odd', value: 'Odd' }, { label: 'Even', value: 'Even' }], sa, purpose: 'chooseEvenOdd' });
    const target = sa.etbCard || sa.host;
    target.chosen = { ...(target.chosen || {}), evenOdd: v === 'Odd' ? 'Odd' : 'Even' };
    game.log(`${game.players[sa.controller].name} chooses ${target.chosen.evenOdd.toLowerCase()}.`);
  },

  // exchange the powers of two creatures (until end of combat)
  async ExchangePower(game, sa) {
    const ctx = ctxOf(game, sa);
    const xs = [...cardsOf(resolveDefined(game, sa.p.Defined || 'Self', ctx)), ...cardsOf(hasTgtSpec(sa) ? sa.targets : [])].filter(c => c && c.zone === 'battlefield');
    if (xs.length < 2) return;
    const [a, b] = xs;
    const pa = game.chars(a).power, pb = game.chars(b).power;
    const until = sa.p.Duration === 'UntilEndOfCombat' ? 'UntilEndOfCombat' : durationOf(sa);
    a.mods.push({ id: game.uid++, power: pb, until }); b.mods.push({ id: game.uid++, power: pa, until });
    game.touch();
    game.log(`${game.name(a)} and ${game.name(b)} exchange power (${pb} and ${pa}).`);
  },

  // end the combat phase: remove everything from combat, exile all spells and abilities from the stack
  async EndCombatPhase(game, sa) {
    if (game.combat) { game.combat.attackers = []; game.combat.blockers = new Map(); }
    await exileStack(game, sa);
    game.endCombatNow = true;
    game.log('The combat phase ends.');
  },

  // end the turn: exile the stack and skip straight to the cleanup step
  async EndTurn(game, sa) {
    await exileStack(game, sa);
    if (game.combat) { game.combat.attackers = []; game.combat.blockers = new Map(); }
    game.endTurnNow = true;
    game.log('The turn ends.');
  },

  // for each player, choose a group (friend or foe), then each group does its thing
  async AssignGroup(game, sa) {
    const names = (sa.p.Choices || '').split(',').map(s => s.trim()).filter(n => sa.svars[n]);
    if (!names.length) return;
    const groups = Object.fromEntries(names.map(n => [n, []]));
    for (const pl of playersOf(objs(game, sa, 'Player'))) {
      const pick = await game.ask(sa.controller, { type: 'option', prompt: `${game.name(sa.host)}: choose for ${pl.name}`, options: names.map(n => ({ label: parseAbility(sa.svars[n]).p.SpellDescription || n, value: n })), sa, purpose: 'assignGroup', forPlayer: pl.id });
      groups[names.includes(pick) ? pick : names[0]].push(pl);
    }
    const prev = sa.host.remembered;
    for (const n of names) {
      if (!groups[n].length) continue;
      sa.host.remembered = groups[n].slice();
      const sub = makeSA(game, sa.svars[n], sa.svars, sa.host, sa.controller, { parent: sa, key: sa.key + n });
      for (const s of sub.chain()) s.rememberedOverride = groups[n].slice();
      await resolveChain(game, sub);
    }
    sa.host.remembered = prev;
  },

  // "exchange the text boxes of those creatures for as long as this enchantment remains on the battlefield"
  async ExchangeTextBox(game, sa) {
    const list = cardsOf(hasTgtSpec(sa) ? sa.targets : objs(game, sa, 'Self')).filter(c => c && c.zone === 'battlefield');
    if (list.length < 2) return;
    const [a, b] = list;
    const host = sa.host && sa.host.isCard && sa.p.Duration === 'AsLongAsInPlay' ? sa.host : null;
    const link = (x, y) => { x.textSwap = { other: y.id, otherZcc: y.zcc, host: host ? host.id : null, hostZcc: host ? host.zcc : null }; };
    link(a, b); link(b, a);
    game.touch();
    game.log(`${game.name(a)} and ${game.name(b)} exchange text boxes.`);
  },

  async ChooseSector(game, sa) {
    const SECTORS = ['Alpha', 'Beta', 'Gamma'];
    const v = await game.ask(sa.controller, { type: 'option', prompt: 'Choose a sector', options: SECTORS.map(x => ({ label: x, value: x })), sa, purpose: 'chooseSector', ai: sa.p.AILogic });
    const s = SECTORS.includes(v) ? v : 'Alpha';
    sa.host.chosen = { ...(sa.host.chosen || {}), sector: s };
    game.touch();
    game.log(`${game.players[sa.controller].name} chooses the ${s.toLowerCase()} sector.`);
  },

  // the planar die (there's no planar deck outside Planechase, so planeswalking and chaos have nothing to act on)
  async RollPlanarDice(game, sa) {
    const pid = sa.controller;
    let amount = 1, ignore = 0;
    // "if you would roll one or more planar dice, instead roll that many plus one and ignore one" (Ichor Elixir)
    const rr = await game.applySimpleReplacement('RollPlanarDice', { Affected: game.players[pid], Player: pid, Number: 1, Ignore: 0 }, sa);
    if (rr) { amount = Math.max(1, rr.Number || 1); ignore = rr.Ignore || 0; }
    const FACES = ['Chaos', 'Planeswalk', 'Blank', 'Blank', 'Blank', 'Blank'];
    const rolls = [];
    for (let i = 0; i < amount; i++) rolls.push(FACES[game.rng.int(6)]);
    while (ignore > 0 && rolls.length > 1) {
      const opts = [...new Set(rolls)];
      const drop = opts.length === 1 ? opts[0] : await game.ask(pid, { type: 'option', prompt: `Planar die: ${rolls.join(', ')}. Choose a result to ignore`, options: opts.map(x => ({ label: x, value: x })), sa, purpose: 'planarIgnore' });
      rolls.splice(rolls.indexOf(opts.includes(drop) ? drop : opts[0]), 1);
      ignore--;
    }
    game.log(`${game.players[pid].name} rolls the planar die: ${rolls.join(', ')}.`);
    for (const r of rolls) {
      if (r === 'Chaos') await E.ChaosEnsues(game, sa);
      else if (r === 'Planeswalk') await E.Planeswalk(game, sa);
    }
  },
  async ChaosEnsues(game, sa) { game.log('Chaos ensues (no plane is in play, so nothing happens).'); game.fire('ChaosEnsues', { Player: sa.controller }); },
  async Planeswalk(game, sa) { game.log(`${game.players[sa.controller].name} can't planeswalk: there's no planar deck in this game.`); },
  async BlankLine() {},

  // "change the text of that creature by replacing all instances of one creature type with Vampire"
  async ChangeText(game, sa) {
    const m = String(sa.p.ChangeTypeWord || '').match(/^ChooseCreatureType (\w+)$/);
    if (!m) return;
    const to = m[1];
    const known = new Set(creatureTypesInGame(game));
    for (const c of cardsOf(objs(game, sa, 'Self'))) {
      if (c.zone !== 'battlefield') continue;
      const ch = game.chars(c);
      const words = [...ch.subtypes].filter(t => !game.nonCreatureSubtypes.has(t));
      const text = [...ch.abilities, ...ch.triggers, ...ch.statics, ...ch.replacements].map(e => e.raw).concat(Object.values(ch.svars), ch.keywords).join(' ');
      for (const w of text.match(/\b[A-Z][a-z]+\b/g) || []) if (known.has(w) && !words.includes(w)) words.push(w);
      const list = words.filter(w => w !== to);
      if (!list.length) continue;
      const pick = list.length === 1 ? list[0] : await game.ask(sa.controller, { type: 'option', prompt: `${game.name(c)}: replace which creature type with ${to}?`, options: list.map(x => ({ label: x, value: x })), sa, purpose: 'changeText', cardId: c.id });
      const from = list.includes(pick) ? pick : list[0];
      c.textChanges = [...(c.textChanges || []), { from, to }];
      game.touch();
      game.log(`${game.name(c)}: ${from} becomes ${to} in its text.`);
    }
  },

  // "each player separates all permanents they control into three piles, then chooses one at random"
  async MultiplePiles(game, sa) {
    const p = sa.p;
    const ctx = ctxOf(game, sa);
    const n = Math.max(2, num(game, sa, 'Piles', 2));
    const zone = Z(p.Zone || 'Battlefield');
    const np = game.players.length;
    const players = playersOf(objs(game, sa, 'Player')).sort((a, b) => ((a.id - sa.controller + np) % np) - ((b.id - sa.controller + np) % np));
    const chosen = [];
    for (const pl of players) {
      let rest = (zone === 'battlefield' ? game.battlefield.filter(c => c.controller === pl.id) : (pl[zone] || []).slice()).filter(c => matchValid(game, c, p.ValidCards || 'Card', ctx));
      const piles = [];
      for (let i = 1; i < n; i++) {
        let pick = [];
        if (rest.length) {
          const ids = await game.ask(pl.id, { type: 'cards', prompt: `Separate your permanents into ${n} piles: choose the cards for pile ${i} (the rest make pile ${n})`, cards: rest.map(c => c.id), min: 0, max: rest.length, purpose: 'pile', pile: i, piles: n, sa });
          pick = rest.filter(c => (ids || []).includes(c.id));
        }
        piles.push(pick);
        rest = rest.filter(c => !pick.includes(c));
      }
      piles.push(rest);
      let k = 0;
      if (p.RandomChosen === 'True') k = game.rng.int(n);
      else {
        const v = await game.ask(pl.id, { type: 'option', prompt: 'Choose a pile', options: piles.map((x, i) => ({ label: `Pile ${i + 1}: ${x.map(c => game.name(c)).join(', ') || 'empty'}`, value: i })), sa, purpose: 'choosePile' });
        k = piles[v] ? v : 0;
      }
      game.log(`${pl.name} makes piles of ${piles.map(x => x.length).join(', ')}; pile ${k + 1} is chosen${p.RandomChosen === 'True' ? ' at random' : ''} (${piles[k].map(c => game.name(c)).join(', ') || 'empty'}).`);
      chosen.push(...piles[k]);
    }
    const raw = p.ChosenPile && sa.svars[p.ChosenPile];
    if (!raw) return;
    const prev = sa.host.remembered;
    sa.host.remembered = chosen.slice();
    const s2 = makeSA(game, raw, sa.svars, sa.host, sa.controller, { parent: sa, key: sa.key + 'pile' });
    for (const s of s2.chain()) s.rememberedOverride = chosen.slice();
    await resolveChain(game, s2);
    sa.host.remembered = prev;
  },

  // meld: exile both cards, then put them onto the battlefield as the melded permanent
  async Meld(game, sa) {
    const p = sa.p;
    const pid = sa.controller;
    const mine = c => c.controller === pid && c.owner === pid && !c.faceDown;
    const prim = game.battlefield.find(c => mine(c) && c.def.faces[0].name === p.Primary);
    const sec = game.battlefield.find(c => mine(c) && c.def.faces[0].name === p.Secondary);
    if (!prim || !sec || prim.def.faces.length < 2) return;
    await game.moveCard(prim, 'exile', { cause: sa, silent: true });
    await game.moveCard(sec, 'exile', { cause: sa, silent: true });
    if (prim.zone !== 'exile' || sec.zone !== 'exile') return;
    const melded = await game.moveCard(prim, 'battlefield', { controller: pid, face: 1, cause: sa, silent: true });
    if (!melded) return;
    melded.meldedWith = sec.id;
    game.touch();
    game.log(`${p.Primary} and ${p.Secondary} meld into ${game.name(melded)}.`);
  },

  // blight N: put N -1/-1 counters on a creature you control
  async Blight(game, sa) {
    const n = num(game, sa, 'Num', 1);
    for (const pl of playersOf(objs(game, sa, 'You'))) {
      const pool = game.battlefield.filter(c => c.controller === pl.id && game.chars(c).types.has('Creature'));
      const pick = (await chooseCards(game, pl.id, pool, 1, 1, `Blight ${n}: put ${n} -1/-1 counter${n === 1 ? '' : 's'} on a creature you control`, sa, 'blight'))[0];
      if (pick) { await game.addCounters(pick, 'M1M1', n, sa); game.log(`${pl.name} blights ${n} (${game.name(pick)}).`); }
    }
  },

  // the promised opponent gets the card's gift (GiftAbility SVar, Defined$ Promised)
  async GiveGift(game, sa) {
    const raw = sa.svars.GiftAbility;
    const to = playersOf(resolveDefined(game, 'Promised', ctxOf(game, sa)))[0];
    if (!raw || !to || to.lost) return;
    game.log(`${game.players[sa.controller].name} gives ${to.name} ${parseAbility(raw).p.GiftDescription || 'a gift'}.`);
    const sub = makeSA(game, raw, sa.svars, sa.host, sa.controller, { parent: sa, key: sa.key + '>gift' });
    if (await chooseTargetsForSA(game, sub, { optional: true })) await resolveChain(game, sub);
    game.fire('GiveGift', { Player: sa.controller, Card: sa.host, Recipient: to.id });
  },

  async ClassLevelUp(game, sa) {
    const c = sa.host;
    c.classLevel = num(game, sa, 'ClassLevel', (c.classLevel || 1) + 1);
    game.touch();
    game.log(`${game.name(c)} reaches level ${c.classLevel}.`);
    game.fire('ClassLevelGained', { Card: c, ClassLevel: c.classLevel });
  },
};

async function proliferateOnce(game, sa, pid) {
  const cands = [...game.battlefield.filter(c => Object.values(c.counters).some(n => n > 0)), ...game.livingPlayers().filter(p => Object.values(p.counters).some(n => n > 0))];
  if (!cands.length) return;
  const ans = await game.ask(pid, { type: 'targets', prompt: 'Proliferate: choose any number of permanents and/or players', cands: cands.map(refOf), min: 0, max: cands.length, sa, purpose: 'proliferate', notTargeting: true });
  const chosen = (ans || []).map(r => fromRef(game, r)).filter(Boolean);
  for (const o of chosen) for (const [k, n] of Object.entries(o.counters)) if (n > 0) await game.addCounters(o, k, 1, sa, { silent: true });
  if (chosen.length) game.log(`${game.players[pid].name} proliferates (${chosen.map(o => game.name(o)).join(', ')}).`);
}

async function exileStack(game, sa) {
  const self = sa.host && sa.host.isCard ? sa.host : null;
  for (const it of [...game.stack]) {
    game.stack.splice(game.stack.indexOf(it), 1);
    if (it.card && it.card.zone === 'stack' && !it.isCopy) await game.moveCard(it.card, 'exile', { silent: true });
    else if (it.card && it.isCopy) { it.card.zone = 'gone'; game.cards.delete(it.card.id); }
  }
  if (self && self.zone === 'stack') self.mustBeExiled = true;
  game.touch();
}

async function protectionColors(game, sa) {
  const g = sa.p.Gains || 'Choice';
  const names = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' };
  if (g === 'Choice' || g === 'ChoiceOfColor') {
    const opts = sa.p.Choices && sa.p.Choices !== 'AnyColor' ? sa.p.Choices.split(',').map(x => NAME_TO_COLOR[x.trim().toLowerCase()]).filter(Boolean) : COLORS;
    const c = await game.ask(sa.controller, { type: 'color', prompt: 'Choose a color for protection', colors: opts, purpose: 'protection', ai: 'MostProminentHumanCreatures', sa });
    return [names[c || 'B']];
  }
  if (g === 'ChosenColor') return (sa.host.chosen && sa.host.chosen.colors || ['B']).map(c => names[c]);
  return g.split(',').map(x => x.trim().toLowerCase());
}

function cantBeCountered(game, card) {
  const ch = game.chars(card);
  if (ch.replacements.some(r => r.parsed.p.Event === 'Counter' && r.parsed.p.Layer === 'CantHappen')) return true;
  if (ch.keywords.some(k => /can't be countered/i.test(k))) return true;
  return game.activeStatics('CantBeCountered').some(s => matchValid(game, card, s.p.ValidCard || 'Card', s.ctx));
}

function animate(game, sa, c) {
  const p = sa.p;
  if (!c || c.zone !== 'battlefield') return;
  const m = { id: game.uid++, src: sa.host, svars: sa.svars };
  if (p.Power != null) m.power = calc(game, p.Power, sa);
  if (p.Toughness != null) m.toughness = calc(game, p.Toughness, sa);
  if (p.Types) m.types = p.Types.split(',').map(s => s.trim()).flatMap(t => t === 'ChosenType' && sa.host.chosen && sa.host.chosen.type ? [sa.host.chosen.type] : [t]);
  if (p.RemoveCardTypes === 'True') m.removeCardTypes = true;
  if (p.RemoveCreatureTypes === 'True') m.removeCreatureTypes = true;
  if (p.RemoveSubTypes === 'True') m.removeSubTypes = true;
  if (p.RemoveSuperTypes === 'True') m.removeSuperTypes = true;
  if (p.RemoveLandTypes === 'True') m.removeLandTypes = true;
  if (p.RemoveTypes) m.removeTypes = p.RemoveTypes.split(',');
  if (p.RemoveAllAbilities === 'True') m.removeAll = true;
  if (p.Keywords) m.keywords = kwList(p.Keywords);
  if (p.RemoveKeywords) m.removeKeywords = kwList(p.RemoveKeywords);
  if (p.Abilities) m.abilities = p.Abilities.split(',').map(s => s.trim());
  if (p.Triggers) m.triggers = p.Triggers.split(',').map(s => s.trim());
  if (p.staticAbilities || p.StaticAbilities || p.Statics) m.statics = (p.staticAbilities || p.StaticAbilities || p.Statics).split(',').map(s => s.trim());
  if (p.Replacements) m.replacements = p.Replacements.split(',').map(s => s.trim());
  if (p.Colors) {
    const cols = p.Colors === 'ChosenColor' ? (sa.host.chosen && sa.host.chosen.colors || []) : p.Colors.split(',').map(x => NAME_TO_COLOR[x.trim().toLowerCase()]).filter(c => c && c !== 'C');
    m.colors = p.OverwriteColors === 'True' || true ? cols : cols;
    if (p.Colors.toLowerCase() === 'colorless') m.colors = [];
  }
  applyDuration(game, sa, c, m);
  c.mods.push(m);
  game.touch();
  const what = [m.power != null || m.toughness != null ? `${m.power ?? '?'}/${m.toughness ?? '?'}` : '', (m.types || []).join(' '), (m.keywords || []).join(', ')].filter(Boolean).join(' ');
  if (what) game.log(`${game.name(c)} becomes ${what}${m.until === 'EOT' ? ' until end of turn' : ''}.`);
}

function creatureTypesInGame(game) {
  const counts = {};
  for (const c of game.allCards()) {
    const ch = game.chars(c);
    if (!ch.types.has('Creature')) continue;
    for (const t of ch.subtypes) counts[t] = (counts[t] || 0) + 1;
  }
  const list = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  for (const t of ['Human', 'Elf', 'Goblin', 'Zombie', 'Vampire', 'Dragon', 'Angel', 'Spirit', 'Soldier', 'Wizard', 'Warrior', 'Knight', 'Beast', 'Elemental', 'Merfolk', 'Sliver', 'Dinosaur', 'Cat', 'Dog']) if (!list.includes(t)) list.push(t);
  return list;
}

async function copyStackItem(game, item, controller, mayChooseTargets) {
  const orig = item.sa;
  let card = null;
  if (item.card) {
    card = game.newCard(item.card.def, controller);
    card.token = true;
    card.zone = 'stack';
    card.controller = controller;
    card.face = item.card.face;
    card.isSpellCopy = true;
  }
  const host = card || orig.host;
  const sa = new SA(game, orig.abil, host, controller, { trig: orig.trig });
  sa.isSpell = orig.isSpell; sa.permanent = orig.permanent; sa.face = orig.face; sa.opt = orig.opt; sa.x = orig.root().x; sa.kicked = orig.kicked;
  sa.isTrigger = orig.isTrigger; sa.triggerParams = orig.triggerParams; sa.delayRemembered = orig.delayRemembered;
  if (orig.modes) sa.modes = orig.modes.map(m => new SA(game, m.abil, host, controller, { parent: sa, trig: orig.trig }));
  const a = orig.chain(), b = sa.chain();
  for (let i = 0; i < Math.min(a.length, b.length); i++) { b[i].targets = a[i].targets.slice(); b[i].targetZcc = a[i].targetZcc; b[i].hadTargets = a[i].hadTargets; b[i].division = a[i].division; }
  if (mayChooseTargets && b.some(s => s.targets.length)) {
    const change = await game.ask(controller, { type: 'confirm', prompt: `Choose new targets for the copy of ${item.description}?`, purpose: 'newTargets', sa });
    if (change) { try { await chooseTargetsForSA(game, sa, { optional: true }); } catch (e) { if (!e.cancelled) throw e; } }
  }
  const copy = { id: game.uid++, kind: item.kind, sa, card, source: item.source, controller, description: `Copy of ${item.description}`, stackItem: true, isCopy: true, fromZone: null, opt: item.opt };
  sa.stackItem = copy;
  game.stack.push(copy);
  game.touch();
  game.log(`${game.players[controller].name} copies ${item.description}.`);
  if (card) game.fire('SpellCopy', { Card: card, Player: controller, IsSpell: true, StackItem: copy });
}

Object.assign(E, COMBAT_EFFECTS);
export const SUPPORTED_APIS = new Set(Object.keys(E).concat(['Charm']));

export async function runEffect(game, sa) {
  const f = E[sa.api];
  if (!f) {
    if (sa.api) game.log(`Not automated: ${desc(game, sa)} [${sa.api}]`, { type: 'unsupported', cardId: sa.host && sa.host.id });
    return;
  }
  await f(game, sa);
  const p = sa.p;
  if (p.RememberObjects && !['Effect', 'DelayedTrigger', 'ImmediateTrigger', 'Token'].includes(sa.api)) remember(sa, resolveDefined(game, p.RememberObjects, ctxOf(game, sa)));
  if (p.RememberTargets === 'True') remember(sa, findTargets(sa));
  game.touch();
}
