// The last card-script parameters the engine left out: paying to ignore an effect (Leonin Arbiter, Damping Engine,
// Lost in Thought, Volrath's Curse), alternative costs with an announced X or a mana restriction (the Shoals, Kentaro,
// Security Rhox), votes and villainous choices (Ballot Broker, Brago's Representative, Tivit, The Valeyard, Illusion of
// Choice), controlling an opponent's search (Opposition Agent), "triggers an additional time" for every trigger mode
// (Panoptic Projektor and the other Panharmonicon statics), snow mana of any color (Draugr Necromancer), text-changing
// effects (Swirl the Mists, Volrath's Shapeshifter, Spy Kit's names, Mirrodin Besieged's locked-in choice), statics
// that stop targeting (Wall of Shadows) and lethal damage by power (Zilortha). Small hooks in game.js, chars.js,
// abilities.js, effects.js, filters.js, combat.js and ai.js call in here.
// This module imports only leaf modules: chars.js and filters.js load it before abilities.js and effects.js exist, so
// abilities.js hands over the few functions used here as it loads (bindLast), as it does for mech-params.js.
import { matchValid, resolveDefined, calcCtx, checkPresence, ctxOf, zoneMap } from './filters.js';
import { parseAbility } from './forge.js';
import { cmc } from './mana.js';
import { abilityList } from './cards.js';
import { COLORS, COLOR_NAMES, NAME_TO_COLOR } from './util.js';
import { filterExt } from './ext.js';
import { causeMatches } from './mech-classic-rules.js';

// SA, makeSA, resolveChain, canPayNonMana, parseCost, costLabel: from abilities.js (bindLast)
const AB = {};
export function bindLast(fns) { Object.assign(AB, fns); }

const Z = z => zoneMap[z] || String(z).toLowerCase();
const staticCtx = (game, host, st) => {
  const you = host.isEffect ? host.controller : (host.zone === 'battlefield' ? host.controller : host.owner);
  return { host, you, svars: st.svars, sa: { svars: st.svars, host, controller: you, root() { return { x: host.xPaid || 0, paid: {} }; } } };
};
// the statics of a mode in effect now, latest timestamp last
const byTimestamp = list => list.slice().sort((a, b) => (a.host.timestamp || 0) - (b.host.timestamp || 0));

// ================================================================ paying to ignore an effect (IgnoreEffectCost)
// "Any player may pay {2} for that player to ignore this effect until end of turn" (Leonin Arbiter), "that player may
// sacrifice a permanent ..." (Damping Engine), "its controller may exile three cards from their graveyard ..." (Lost
// in Thought). As in Forge, the static's host gets a special action (no stack) that a player the static applies to, or
// the controller of a card it applies to, may take; the static then leaves that player and the cards it applied to
// alone until end of turn (host.lastIgnore, per static, for this object and this turn).
function ignoreRecord(game, host, key) {
  const r = host && host.lastIgnore && host.lastIgnore[key];
  return r && r.zcc === host.zcc && r.turn === game.turnNumber ? r : null;
}
// the context a static applies with: the players and cards it ignores don't match its filters (filters.js matchValid)
export function lastIgnoreCtx(game, st, ctx) {
  if (!ctx || !st || !st.parsed || st.parsed.p.IgnoreEffectCost == null) return ctx;
  const r = ignoreRecord(game, st.host || ctx.host, st.key);
  if (!r) return ctx;
  return { ...ctx, lastIgnoring: new Set([...r.players.map(i => 'p' + i), ...r.cards.map(i => 'c' + i)]) };
}
export const lastIgnored = (obj, ctx) => ctx.lastIgnoring.has((obj.isPlayer ? 'p' : 'c') + obj.id);

// who and what a static applies to right now (players: Affected$ Player...; cards: AffectedDefined$ / Affected$)
function staticAffects(game, host, st, ctx) {
  const p = st.parsed.p;
  const players = [], cards = [];
  if (p.Affected && /^(You|Player|Opponent)/.test(p.Affected)) {
    for (const pl of game.livingPlayers()) if (matchValid(game, pl, p.Affected, ctx)) players.push(pl);
  } else if (p.AffectedDefined) {
    for (const o of resolveDefined(game, p.AffectedDefined, ctx)) if (o && o.isCard && !o.lki && (!p.Affected || matchValid(game, o, p.Affected, ctx))) cards.push(o);
  } else if (p.Affected) {
    for (const z of (p.AffectedZone || 'Battlefield').split(',').map(Z)) for (const c of z === 'battlefield' ? game.battlefield : game.cardsInZone(z)) if (matchValid(game, c, p.Affected, ctx)) cards.push(c);
  }
  // "A player who controls more permanents ... can't play lands or cast ... spells": the players the "can't" names
  for (const k of ['Player', 'Caster']) if (p[k] && /^(You|Player|Opponent)/.test(p[k])) for (const pl of game.livingPlayers()) if (!players.includes(pl) && matchValid(game, pl, p[k], ctx)) players.push(pl);
  return { players, cards };
}
function ignoreStatic(game, card, key) {
  const found = game.chars(card).statics.find(s => s.key === key && s.parsed.p.IgnoreEffectCost != null);
  if (!found || card.zone !== 'battlefield' || card.phasedOut) return null;
  const st = { ...found, host: card };
  const ctx = staticCtx(game, card, st);
  if (!checkPresence(game, st.parsed.p, ctx)) return null;
  return { st, ctx: lastIgnoreCtx(game, st, ctx) };
}
// chars.js, layer 6: the special action on the static's host
export function lastIgnoreAbilities(game, map) {
  for (const c of game.battlefield) {
    const ch = map.get(c.id);
    if (!ch || c.phasedOut) continue;
    for (const st of ch.statics) {
      const cost = st.parsed.p.IgnoreEffectCost;
      if (cost == null || ch.abilities.some(a => a.ignoreKey === st.key)) continue;
      const label = AB.costLabel ? AB.costLabel(cost) : cost;
      const raw = `AB$ InternalIgnoreEffect | Cost$ ${cost} | AnyPlayer$ True | Static$ True | IgnoreStatic$ ${st.key} | SpellDescription$ ${label}: ignore CARDNAME's effect until end of turn`;
      ch.abilities.push({ raw, parsed: parseAbility(raw), svars: st.svars, src: c, key: `ign:${st.key}`, ignoreKey: st.key });
    }
  }
}
// abilities.js canActivate: only a player the effect applies to, or who controls a card it applies to
export function lastActivatorOk(game, pid, card, abil) {
  if (abil.parsed.api !== 'InternalIgnoreEffect') return true;
  const found = ignoreStatic(game, card, abil.parsed.p.IgnoreStatic);
  if (!found) return false;
  const { players, cards } = staticAffects(game, card, found.st, found.ctx);
  return players.some(pl => pl.id === pid) || cards.some(c => c.controller === pid);
}
async function InternalIgnoreEffect(game, sa) {
  const host = sa.host;
  const key = sa.p.IgnoreStatic;
  const found = host && host.isCard ? ignoreStatic(game, host, key) : null;
  if (!found) return;
  const { cards } = staticAffects(game, host, found.st, found.ctx);
  host.lastIgnore = host.lastIgnore || {};
  let r = ignoreRecord(game, host, key);
  if (!r) r = host.lastIgnore[key] = { zcc: host.zcc, turn: game.turnNumber, players: [], cards: [] };
  if (!r.players.includes(sa.controller)) r.players.push(sa.controller);
  for (const c of cards) if (!r.cards.includes(c.id)) r.cards.push(c.id);
  game.touch();
  game.log(`${game.players[sa.controller].name} ignores ${game.name(host)}'s effect until end of turn${cards.length ? ` (${cards.map(c => game.name(c)).join(', ')})` : ''}.`, { type: 'effect' });
}
// "players can't search libraries" (Leonin Arbiter's CantSearchLibrary): the searcher finds nothing there
export const lastCantSearch = (game, pid) => game.playerChars(pid).keywords.includes('CantSearchLibrary');

// ================================================================ votes and villainous choices
// what Continuous statics give a player: AdditionalVote$, AdditionalOptionalVote$, AdditionalVillainousChoice$
export function playerStaticTotal(game, pid, param) {
  let n = 0;
  for (const s of game.activeStatics('Continuous')) {
    if (s.p[param] == null) continue;
    if (!matchValid(game, game.players[pid], s.p.Affected || 'You', s.ctx)) continue;
    n += calcCtx(game, s.p[param], s.ctx) || 0;
  }
  return n;
}
// "you choose how each player votes this turn" (Illusion of Choice): the player with the latest such effect
export function voteController(game) {
  let best = null;
  for (const s of byTimestamp(game.activeStatics('Continuous').filter(s => s.p.ControlVote))) {
    for (const pl of game.livingPlayers()) if (matchValid(game, pl, s.p.Affected || 'You', s.ctx)) best = pl.id;
  }
  return best;
}
const choiceLabel = (game, sa, n) => (parseAbility(sa.svars[n]).p.SpellDescription || n).replace(/CARDNAME|NICKNAME/g, game.name(sa.host));
const voteKey = o => (typeof o === 'string' ? o : (o.isPlayer ? 'p' : 'c') + o.id);

// Forge's VoteEffect: starting with you, each player votes (more times with Brago's Representative, as many more as
// they like with Ballot Broker and Tivit, and as the player with Illusion of Choice says); for choices, cards
// (VoteCard$) or players (VotePlayer$). Then: each vote resolves its choice (EachVote$), each choice resolves with the
// number of votes it got (StoreVoteNum$), or the choice(s) with the most votes (VoteTiedAbility$ on a tie) or the
// objects with the most votes (VoteSubAbility$, as remembered objects).
async function Vote(game, sa) {
  const p = sa.p, host = sa.host;
  const ctx = ctxOf(game, sa);
  // (Forge's getDefinedPlayersOrTargeted: Defined$ when there is one, though the spell targets: Split Decision)
  let players = (p.Defined || !p.ValidTgts ? resolveDefined(game, p.Defined || 'Player', ctx) : (sa.targets || [])).filter(o => o && o.isPlayer);
  const start = players.findIndex(o => o.id === sa.controller);
  if (start > 0) players = [...players.slice(start), ...players.slice(0, start)];
  let kind, opts;
  if (p.Choices) { kind = 'choice'; opts = p.Choices.split(',').map(s => s.trim()).filter(n => sa.svars[n]); }
  else if (p.VoteCard) {
    kind = 'card';
    const z = Z(p.Zone || 'Battlefield');
    opts = (z === 'battlefield' ? game.battlefield : game.cardsInZone(z)).filter(c => !c.phasedOut && matchValid(game, c, p.VoteCard, ctx));
  } else if (p.VotePlayer) {
    kind = 'player';
    opts = resolveDefined(game, p.VotePlayer === 'Other' ? 'Player' : p.VotePlayer, ctx).filter(o => o && o.isPlayer && !o.lost);
  }
  if (!kind || !opts.length) return;
  const what = p.VoteMessage || `for ${kind === 'choice' ? opts.map(n => choiceLabel(game, sa, n)).join(' or ') : kind === 'card' ? 'a card' : 'a player'}`;
  const ctl = voteController(game);
  const secret = p.Secretly === 'True';
  const votes = {}; // player id -> the keys they voted for (the Vote trigger's "voted for a choice you voted for")
  const tally = new Map(); // key -> { obj, voters: [player ids, one per vote] }
  const record = [];
  for (const pl of players) {
    if (pl.lost) continue;
    const mine = kind === 'player' && p.VotePlayer === 'Other' ? opts.filter(o => o.id !== pl.id) : opts;
    if (!mine.length) continue;
    let n = 1 + playerStaticTotal(game, pl.id, 'AdditionalVote');
    const optional = playerStaticTotal(game, pl.id, 'AdditionalOptionalVote');
    if (optional > 0) {
      // (one more: yes or no; several: how many)
      const k = optional === 1
        ? ((await game.ask(pl.id, { type: 'confirm', prompt: `${game.name(host)}: vote an additional time?`, purpose: 'extraVotes', sa })) ? 1 : 0)
        : await game.ask(pl.id, { type: 'number', prompt: `${game.name(host)}: you may vote up to ${optional} additional times. How many more votes?`, min: 0, max: optional, purpose: 'extraVotes', sa });
      n += Math.max(0, Math.min(optional, +k || 0));
    }
    const voter = ctl != null && !game.players[ctl].lost ? ctl : pl.id;
    for (let i = 0; i < n; i++) {
      // "Capital Punishment: vote (1 of 2) for Death or Taxes", "Council's Judgment: B's vote for a nonland permanent ..."
      const base = { prompt: `${game.name(host)}: ${voter !== pl.id ? `${pl.name}'s vote` : 'vote'}${n > 1 ? ` (${i + 1} of ${n})` : ''} ${what}`, sa, purpose: 'vote', forPlayer: pl.id, voteKind: kind };
      let v = null;
      if (kind === 'choice') {
        const ans = await game.ask(voter, { ...base, type: 'option', options: mine.map(n2 => ({ label: choiceLabel(game, sa, n2), value: n2 })) });
        v = mine.includes(ans) ? ans : mine[0];
      } else if (kind === 'card') {
        const ids = await game.ask(voter, { ...base, type: 'cards', cards: mine.map(c => c.id), min: p.UpTo === 'True' ? 0 : 1, max: 1 });
        v = mine.find(c => (ids || []).includes(c.id)) || (p.UpTo === 'True' ? null : mine[0]);
      } else {
        const id = await game.ask(voter, { ...base, type: 'player', players: mine.map(o => o.id) });
        v = mine.find(o => o.id === id) || mine[0];
      }
      if (v == null) continue;
      const key = voteKey(v);
      if (!tally.has(key)) tally.set(key, { obj: v, voters: [] });
      tally.get(key).voters.push(pl.id);
      (votes[pl.id] = votes[pl.id] || []).push(key);
      const line = `${pl.name} votes for ${kind === 'choice' ? choiceLabel(game, sa, v) : game.name(v)}${voter !== pl.id ? ` (${game.players[voter].name} chooses)` : ''}.`;
      if (secret) record.push(line); else game.log(line, { type: 'effect' });
    }
  }
  for (const line of record) game.log(line, { type: 'effect' });
  game.fire('Vote', { Player: sa.controller, Votes: votes });
  const count = key => (tally.get(key) ? tally.get(key).voters.length : 0);
  const sub = (name, extraSvars = null) => AB.makeSA(game, sa.svars[name], extraSvars ? { ...sa.svars, ...extraSvars } : sa.svars, host, sa.controller, { parent: sa, key: sa.key + '>' + name });
  const withRemembered = async (objs, fn) => { const prev = host.remembered; host.remembered = [...(prev || []), ...objs]; try { await fn(); } finally { host.remembered = prev; } };
  if (p.EachVote === 'True' && kind === 'choice') {
    for (const key of opts) for (const voterId of (tally.get(key) || { voters: [] }).voters) await withRemembered([game.players[voterId]], () => AB.resolveChain(game, sub(key)));
  } else if (p.StoreVoteNum === 'True' && kind === 'choice') {
    for (const key of opts) await AB.resolveChain(game, sub(key, { VoteNum: `Number$${count(key)}` }));
  } else {
    const top = Math.max(0, ...[...tally.keys()].map(count));
    const most = top > 0 ? [...tally.keys()].filter(k => count(k) === top) : [];
    if (p.VoteTiedAbility && most.length > 1 && sa.svars[p.VoteTiedAbility]) await AB.resolveChain(game, sub(p.VoteTiedAbility));
    else if (p.VoteSubAbility && sa.svars[p.VoteSubAbility]) {
      host.remembered = [...(host.remembered || []), ...most.map(k => tally.get(k).obj)];
      await AB.resolveChain(game, sub(p.VoteSubAbility));
      host.remembered = [];
    } else if (kind === 'choice') for (const key of most) await AB.resolveChain(game, sub(key));
  }
  // the number of votes each card or player got, for whatever counts them later
  if (p.StoreVoteNum === 'True' && kind !== 'choice') sa.root().voteCounts = Object.fromEntries([...tally].map(([k, t]) => [k, t.voters.length]));
  if (p.RememberVotedObjects === 'True') host.remembered = [...(host.remembered || []), ...[...tally.values()].map(t => t.obj).filter(o => !(host.remembered || []).includes(o))];
}

// "If an opponent would face a villainous choice, they face that choice an additional time" (The Valeyard): each
// player makes all their choices, then each chosen ability resolves
async function VillainousChoice(game, sa) {
  const names = (sa.p.Choices || '').split(',').map(x => x.trim()).filter(n => sa.svars[n]);
  if (!names.length) return;
  const players = (sa.p.Defined || !sa.p.ValidTgts ? resolveDefined(game, sa.p.Defined || 'Opponent', ctxOf(game, sa)) : (sa.targets || [])).filter(o => o && o.isPlayer && !o.lost);
  for (const pl of players) {
    const times = 1 + playerStaticTotal(game, pl.id, 'AdditionalVillainousChoice');
    const picks = [];
    for (let i = 0; i < times; i++) {
      const pick = await game.ask(pl.id, { type: 'option', prompt: `Villainous choice (${game.name(sa.host)})${times > 1 ? ` — ${i + 1} of ${times}` : ''}`, options: names.map(n => ({ label: choiceLabel(game, sa, n), value: n })), purpose: 'villainousChoice', sa });
      picks.push(names.includes(pick) ? pick : names[0]);
    }
    for (const n of picks) {
      if (pl.lost) break;
      game.log(`${pl.name} chooses: ${choiceLabel(game, sa, n)}.`, { type: 'effect' });
      const prev = sa.host.remembered;
      sa.host.remembered = [pl];
      const sub = AB.makeSA(game, sa.svars[n], sa.svars, sa.host, sa.controller, { parent: sa, key: sa.key + n });
      for (const x of sub.chain()) x.rememberedOverride = [pl];
      try { await AB.resolveChain(game, sub); } finally { sa.host.remembered = prev; }
    }
  }
}

// GenericChoice | SetChosenMode$ True: the card remembers the mode chosen ("As Mirrodin Besieged enters, choose Mirran
// or Phyrexian"; the Sieges), read by the ChosenMode<name> card property
export function lastSetChosenMode(game, sa, name) {
  if (sa.p.SetChosenMode !== 'True' || !sa.svars[name]) return;
  const target = sa.etbCard || sa.host;
  if (!target || !target.isCard) return;
  target.chosen = { ...(target.chosen || {}), mode: parseAbility(sa.svars[name]).p.SpellDescription || name };
  game.touch();
}
filterExt.cardProp.push((game, card, ch, prop, ctx) => {
  if (prop.startsWith('ChosenMode')) {
    const c = card.lki ? card.card || card : card;
    return !!(c && c.chosen && c.chosen.mode === prop.slice(10));
  }
  // "Defined<X>" / "NotDefined<X>": one of (not one of) the objects X names ("all other permanents with the same name as
  // that permanent": Echoing Truth's Permanent.NotDefinedTargeted)
  const m = /^(Not)?Defined(.+)$/.exec(prop);
  if (m && ctx) { const hit = resolveDefined(game, m[2], ctx).some(o => o && !o.isPlayer && o.id === card.id); return m[1] ? !hit : hit; }
  return undefined;
});

// ================================================================ alternative costs
// options for a spell's own AlternativeCost static: Announce$ X (the Shoals: "exile a blue card with mana value X from
// your hand rather than pay this spell's mana cost", X announced first) and ManaRestriction$ (Security Rhox: "spend
// only mana produced by Treasures to cast it this way")
export function lastAltOptionExtras(sp) {
  const out = {};
  if (sp.Announce) out.announce = sp.Announce;
  if (sp.ManaRestriction) out.manaRestriction = sp.ManaRestriction;
  return out;
}
// other cards' AlternativeCost statics for spells you cast: "You may pay {X} rather than pay the mana cost for Samurai
// spells you cast, where X is that spell's mana value" (Kentaro, XAlternative$), "{W}{U}{B}{R}{G}" (Fist of Suns),
// "{0} for Zombie creature spells" (Rooftop Storm), "life equal to its mana value" (Marshland Bloodcaster)
export function lastAltCostOptions(game, pid, card, from, pushFace) {
  if (from !== 'hand' && from !== 'command') return;
  const f = card.def.faces[0];
  if (f.types.includes('Land')) return; // (lands aren't cast)
  for (const s of game.activeStatics('AlternativeCost')) {
    if (s.host === card || s.host.id === card.id) continue; // (its own: abilities.js)
    const p = s.p;
    if (!p.Cost || !p.ValidSA) continue;
    const m = /^Spell(?:\.(.+))?$/.exec(p.ValidSA);
    if (!m || m[1] === 'Self') continue;
    const ctx = { ...s.ctx, host: s.host };
    if (m[1] && !matchValid(game, card, 'Card.' + m[1], ctx)) continue;
    if (p.ValidCard && !matchValid(game, card, p.ValidCard, ctx)) continue;
    if (p.ValidPlayer && !matchValid(game, game.players[pid], p.ValidPlayer, ctx)) continue;
    const mv = cmc(f.manaCost);
    let cost = String(p.Cost).replace(/ConvertedManaCost/g, String(mv));
    if (p.XAlternative && /^X$/.test(cost.trim())) cost = String(calcCtx(game, p.XAlternative, { host: card, you: pid, svars: f.svars }) || 0);
    pushFace(0, { altCost: 'Alternative', altManaStr: cost, altHost: s.host.id, label: `Cast ${f.name} (${game.name(s.host)}: ${AB.costLabel ? AB.costLabel(cost) : cost} instead of its mana cost)`, ...lastAltOptionExtras(p) });
  }
}
// Announce$ X: the values of X for which the rest of the cost can be paid (an X with no card of that mana value to
// exile is no choice at all)
function announceValues(game, sa, extra) {
  const out = [];
  const saved = sa.x;
  try { for (let x = 0; x <= 20; x++) { sa.x = x; if (AB.canPayNonMana(game, sa, extra)) out.push(x); } } finally { sa.x = saved; }
  return out;
}
// abilities.js castableOptions: some X works (sa.x is left at one that does, for the target checks)
export function lastAnnounceOk(opt, game, sa, extra) {
  if (!opt.announce) return true;
  const xs = announceValues(game, sa, extra);
  if (!xs.length) return false;
  sa.x = xs[xs.length - 1];
  return true;
}
// abilities.js castSpell: announce X
export async function lastAnnounce(game, pid, card, opt, sa, extra) {
  if (!opt.announce) return true;
  const xs = announceValues(game, sa, extra);
  if (!xs.length) return false;
  const name = card.def.faces[opt.face || 0].name;
  const x = xs.length === 1 ? xs[0] : await game.ask(pid, { type: 'option', prompt: `${name}: announce X for its alternative cost`, options: xs.map(v => ({ label: `X = ${v}`, value: v })), purpose: 'announceX', sa, cardId: card.id, cancellable: true });
  if (x == null) throw new AB.Cancelled();
  sa.x = xs.includes(x) ? x : xs[xs.length - 1];
  return true;
}
// mech-casting.js castingManaRestriction: while a spell is paid for the restricted way (card.lastRestrict)
export function lastManaRestriction(game, card) {
  if (!card || !card.lastRestrict) return null;
  const spec = card.lastRestrict;
  return src => matchValid(game, src, spec, { host: card, you: card.controller != null ? card.controller : card.owner });
}

// abilities.js spellCost: cast face down, the spell is a nameless colorless 2/2 creature spell with no mana cost, which
// is what cost statics see ("the next face-down creature spell you cast this turn costs {3} less": Panoptic Projektor)
export function lastSpellView(game, card, opt) {
  if (!opt || !opt.faceDown || !card || card.faceDown) return null;
  const v = game.makeLKI(card);
  v.faceDown = true;
  v.chars = { ...v.chars, name: '', types: new Set(['Creature']), subtypes: new Set(), supertypes: new Set(), colors: new Set(), keywords: [], abilities: [], triggers: [], statics: [], replacements: [], manaCost: null, cmc: 0, power: 2, toughness: 2 };
  return v;
}

// ================================================================ "you control your opponents while they're searching"
// Opposition Agent: the latest such static that applies to the searching player names who decides for them
export function lastSearchController(game, pid) {
  let by = null;
  for (const s of byTimestamp(game.activeStatics('Continuous').filter(s => s.p.ControlOpponentsSearchingLibrary))) {
    if (!matchValid(game, game.players[pid], s.p.Affected || 'Opponent', s.ctx)) continue;
    const who = resolveDefined(game, s.p.ControlOpponentsSearchingLibrary, s.ctx).find(o => o && o.isPlayer && !o.lost);
    if (who && who.id !== pid) by = who.id;
  }
  return by;
}
// game.js ask: during that search, the controlling player's seat decides for the searcher
export function lastDecider(game, pid) {
  const c = game.lastSearchControl;
  return c && c.target === pid && !game.players[c.by].lost ? c.by : null;
}
export async function lastWhileSearching(game, pid, fn) {
  const by = lastSearchController(game, pid);
  if (by == null) return fn();
  const prev = game.lastSearchControl;
  game.lastSearchControl = { target: pid, by };
  game.log(`${game.players[by].name} controls ${game.players[pid].name} while they search their library.`, { type: 'effect' });
  try { return await fn(); } finally { game.lastSearchControl = prev || null; }
}
// game.js applyMovedReplacements, for two kinds of Moved replacements: FoundSearchingLibrary$ True applies only to
// cards a player found searching their own library, and its ChangeZone replacement moves the card and then runs the
// rest ("exile each card they find. You may play those cards ..."); a ChangeZone replacement WithCountersType$ puts
// the card there with those counters ("exile that card with an ice counter on it instead": Draugr Necromancer).
// Returns null when it's neither, 'skip' when it doesn't apply, 'done' when the move was replaced.
export async function lastMoveReplacement(game, h, r, p, card, from, opts, key, applied) {
  const raw = p.ReplaceWith && r.svars[p.ReplaceWith];
  const parsed = raw ? parseAbility(raw) : null;
  const found = p.FoundSearchingLibrary === 'True';
  const dest = parsed && parsed.api === 'ChangeZone' && parsed.p.Destination && (!parsed.p.Defined || parsed.p.Defined === 'ReplacedCard') ? Z(parsed.p.Destination) : null;
  const counters = !!dest && !!parsed.p.WithCountersType && dest !== 'battlefield';
  if (!found && !counters) return null;
  if (found && (opts.foundSearching == null || opts.foundSearching !== card.owner)) return 'skip';
  if (!raw) return 'skip';
  const you = h.controller;
  if (p.Optional === 'True' && !(await game.ask(you, { type: 'confirm', prompt: `${game.name(h)}: ${p.Description || 'apply replacement?'}`, purpose: 'replacement' }))) return 'skip';
  applied.add(key);
  if (dest) {
    const moved = await game.moveCard(card, dest, { ...opts, appliedRepl: applied, foundSearching: null });
    if (moved && moved.zone === dest && parsed.p.WithCountersType) {
      const n = parsed.p.WithCountersAmount ? calcCtx(game, parsed.p.WithCountersAmount, { host: h, you, svars: r.svars }) : 1;
      await game.addCounters(moved, String(parsed.p.WithCountersType).toUpperCase(), n, null, { anyZone: true });
    }
  }
  const subName = dest ? parsed.p.SubAbility : null;
  const run = dest ? (subName && r.svars[subName]) : raw;
  if (run) {
    const sa = new AB.SA(game, { raw: run, parsed: parseAbility(run), svars: r.svars, src: h, key: r.key }, h, you, { trig: { Card: card } });
    await game.resolveSAChain(sa);
  }
  return 'done';
}

// ================================================================ Panharmonicon, for every trigger mode
// Forge's StaticAbilityPanharmonicon: how many more times a trigger triggers (ValidMode$, ValidCard$ = the trigger's
// source, ValidZone$, and per mode ValidCause$ / Origin$ / Destination$ / ValidTurned$ / ...). Delayed triggers don't.
const has = (list, v) => String(list).split(',').map(s => s.trim()).includes(v);
function panharmoniconApplies(game, s, mode, host, t, rp, zone) {
  const p = s.p, tp = t.parsed.p;
  const ctx = { ...s.ctx, host: s.host };
  const trigMode = tp.Mode || mode;
  if (p.ValidMode && !has(p.ValidMode, trigMode)) return false;
  if (p.ValidMode === 'RoomEntered') return false; // (game.js enterRoom)
  if (p.ValidCard && !matchValid(game, host, p.ValidCard, ctx)) return false;
  const hz = zone === 'lookback' ? 'battlefield' : host.isEffect ? 'command' : zone;
  if (!(p.ValidZone || 'Battlefield').split(',').map(Z).includes(hz)) return false;
  const ok = (param, obj) => !p[param] || (obj != null && matchValid(game, obj, p[param], ctx));
  const zoneOk = (param, z) => !p[param] || (z != null && has(p[param], z));
  switch (trigMode) {
    case 'ChangesZone': {
      const moved = tp.Origin === 'Battlefield' ? (rp.CardLKI || rp.Card) : rp.Card;
      return ok('ValidCause', moved) && zoneOk('Origin', rp.Origin) && zoneOk('Destination', rp.Destination);
    }
    case 'ChangesZoneAll': {
      if (!zoneOk('Origin', rp.Origin) || !zoneOk('Destination', rp.Destination)) return false;
      const list = rp.Origin === 'Battlefield' ? (rp.CardsLKI || rp.Cards || []) : (rp.Cards || []);
      const tctx = { host, you: host.controller, svars: t.svars };
      return list.some(c => c && ok('ValidCause', c) && (!tp.ValidCards || matchValid(game, c, tp.ValidCards, tctx)));
    }
    case 'Attacks': return ok('ValidCause', rp.Attacker);
    case 'AttackersDeclared': case 'AttackersDeclaredOneTarget': return !p.ValidCause || (rp.Attackers || []).some(c => ok('ValidCause', c));
    case 'SpellCast': case 'SpellCopy': case 'SpellCastOrCopy':
      return ok('ValidCause', rp.Card) && (!p.ValidActivator || (rp.Player != null && matchValid(game, game.players[rp.Player], p.ValidActivator, ctx)));
    case 'BecomesTarget': return ok('ValidTarget', rp.Target);
    case 'BecomesTargetOnce': return !p.ValidTarget || (rp.Targets || [rp.Target]).some(o => ok('ValidTarget', o));
    case 'DamageDone': case 'DamageDoneOnce': case 'DamageDealtOnce': case 'DamageAll':
      if (p.CombatDamage && (p.CombatDamage === 'True') !== !!rp.IsCombatDamage) return false;
      if (trigMode === 'DamageAll') return true;
      if (trigMode === 'DamageDoneOnce') return ok('ValidTarget', rp.DamageTarget) && (!p.ValidSource || (rp.Sources || [rp.DamageSource]).some(o => ok('ValidSource', o)));
      if (trigMode === 'DamageDealtOnce') return ok('ValidSource', rp.DamageSource) && (!p.ValidTarget || (rp.Targets || [rp.DamageTarget]).some(o => ok('ValidTarget', o)));
      return ok('ValidSource', rp.DamageSource) && ok('ValidTarget', rp.DamageTarget);
    case 'TurnFaceUp': return ok('ValidTurned', rp.Card);
    case 'LifeGained': return !p.ValidPlayer || (rp.Player != null && matchValid(game, game.players[rp.Player], p.ValidPlayer, ctx));
    default: return true;
  }
}
// game.js fire: how many extra times this trigger goes on the stack
export function lastPanharmonicon(game, mode, host, t, rp, zone) {
  if (t.delayed || host.isDelayed || zone === 'delayed') return 0;
  const tp = t.parsed.p;
  if (tp.Static === 'True') return 0;
  let n = 0;
  for (const s of game.activeStatics('Panharmonicon')) if (panharmoniconApplies(game, s, mode, host, t, rp, zone)) n++;
  // "triggers only once each turn": no more than its limit allows (game.js counted this one already)
  const lim = tp.ActivationLimit || tp.ResolvedLimit;
  if (n && lim) n = Math.max(0, Math.min(n, +lim - (game.turnState.triggerCounts[`${host.id}:${t.key}`] || 0)));
  if (n && tp.OneOff === 'True') n = 0;
  return n;
}

// ================================================================ snow mana of any color
// Draugr Necromancer: "you may spend mana from snow sources as though it were mana of any color to cast those spells"
// (MayPlaySnowIgnoreColor$): while such a spell is paid for, a snow source's mana takes any color
function snowAnyColor(game, pid, spellCard) {
  if (!spellCard || spellCard.zone === 'stack' || spellCard.zone === 'battlefield') return false;
  game.ensureChars();
  for (const { st, ctx } of game._activeStatics || []) {
    const p = st.parsed.p;
    if (p.MayPlaySnowIgnoreColor !== 'True' || !p.MayPlay) continue;
    if (!(p.AffectedZone || 'Battlefield').split(',').map(Z).includes(spellCard.zone)) continue;
    if (p.Affected && !matchValid(game, spellCard, p.Affected, ctx)) continue;
    if ((st.host.isEffect ? st.host.controller : ctx.you) !== pid) continue;
    return true;
  }
  return false;
}
// abilities.js manaSourcesFor
export function lastSourceUnits(game, pid, card, spellCard, units) {
  if (!spellCard || !units.length || !game.chars(card).supertypes.has('Snow') || !snowAnyColor(game, pid, spellCard)) return units;
  return units.map(u => [...new Set([...u, ...COLORS])]);
}

// ================================================================ text-changing effects (the text layer)
// chars.js computeAll, before the type layer: "has the full text of that card" (Volrath's Shapeshifter, GainTextOf$),
// "all instances of color words ... are changed to the chosen color word" (Swirl the Mists, ChangeColorWordsTo$) and
// "has all names of nonlegendary creature cards in addition to its name" (Spy Kit, AddNames$). Abilities with
// LockInText$ keep their words (Mirrodin Besieged's chosen mode).
const NO_CHANGE_KEYS = new Set(['TokenScript', 'NewName', 'DefinedName', 'ChooseFromList', 'AddAbility']);
const COLOR_RE = /(?<!named.{0,100})\b(non)?(white|blue|black|red|green|White|Blue|Black|Red|Green)\b/g;
export function swapColorWords(text, to) {
  if (!text || !to) return text;
  return String(text).replace(COLOR_RE, (m, non, w) => (non || '') + (w[0] === w[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to));
}
// (memoized: the same texts are changed every time characteristics are computed)
const swapped = new Map();
function swapAbilityText(raw, to, svars) {
  const k = to + '|' + raw;
  if (swapped.has(k)) return swapped.get(k);
  const out = swapAbilityTextNow(raw, to, svars);
  if (swapped.size > 20000) swapped.clear();
  swapped.set(k, out);
  return out;
}
function swapAbilityTextNow(raw, to, svars) {
  if (String(raw).includes('LockInText') && parseAbility(raw).p.LockInText === 'True') return raw; // (its words are locked in)
  return String(raw).split(' | ').map(part => {
    const i = part.indexOf('$ ');
    if (i < 0) return swapColorWords(part, to);
    const k = part.slice(0, i), v = part.slice(i + 2);
    if (NO_CHANGE_KEYS.has(k) || (svars && svars[v.trim()] != null)) return part;
    return k + '$ ' + swapColorWords(v, to);
  }).join(' | ');
}
const MODIFIABLE_KW = ['Enchant', 'Protection', 'Cumulative upkeep', 'Equip', 'Buyback', 'Cycling', 'Echo', 'Kicker', 'Flashback', 'Madness', 'Morph', 'Affinity', 'Entwine', 'Splice', 'Ninjutsu', 'Transmute', 'Replicate', 'Recover', 'Squad', 'Suspend', 'Aura swap', 'Fortify', 'Transfigure', 'Champion', 'Evoke', 'Prowl', 'Freerunning', 'Reinforce', 'Unearth', 'Level up', 'Miracle', 'Overload', 'Cleave', 'Scavenge', 'Encore', 'Bestow', 'Outlast', 'Dash', 'Surge', 'Emerge', 'Hexproof:', 'Bands with other', 'Landwalk', 'Offering', 'etbCounter', 'Reflect', 'Ward'];
function swapSvars(svars, to) {
  const out = {};
  for (const [k, v] of Object.entries(svars || {})) out[k] = /\$/.test(v) && /\|/.test(v) ? swapAbilityText(v, to, svars) : swapColorWords(v, to);
  return out;
}
function changeColorWords(ch, to) {
  const svars = swapSvars(ch.svars, to);
  const remap = list => list.map(e => {
    const raw = swapAbilityText(e.raw, to, ch.svars);
    return { ...e, raw, parsed: raw === e.raw ? e.parsed : parseAbility(raw), svars: e.svars === ch.svars ? svars : e.svars };
  });
  ch.abilities = remap(ch.abilities); ch.triggers = remap(ch.triggers); ch.statics = remap(ch.statics); ch.replacements = remap(ch.replacements);
  ch.keywords = ch.keywords.map(k => (MODIFIABLE_KW.some(m => k.startsWith(m)) ? swapColorWords(k, to) : k));
  ch.svars = svars;
  ch.oracle = swapColorWords(ch.oracle || '', to);
}
// the color word a ChangeColorWordsTo$ static changes to
function colorWordOf(host, p) {
  const v = p.ChangeColorWordsTo;
  if (v === 'ChosenColor') { const c = host.chosen && host.chosen.colors && host.chosen.colors[0]; return c ? COLOR_NAMES[c] : null; }
  return NAME_TO_COLOR[String(v).toLowerCase()] ? String(v).toLowerCase() : null;
}
function gainText(game, card, ch, from, st) {
  const f = from.faceDef;
  Object.assign(ch, {
    name: f.name, manaCost: f.manaCost, cmc: cmc(f.manaCost), colors: new Set(f.colors), types: new Set(f.types), supertypes: new Set(f.supertypes), subtypes: new Set(f.subtypes),
    keywords: [...f.keywords], powerStr: f.power, toughnessStr: f.toughness, loyalty: f.loyalty, svars: f.svars,
    abilities: abilityList(f.abilities, f.svars, card, `${card.face}vA`), triggers: abilityList(f.triggers, f.svars, card, `${card.face}vT`),
    statics: abilityList(f.statics, f.svars, card, `${card.face}vS`), replacements: abilityList(f.replacements, f.svars, card, `${card.face}vR`),
    oracle: f.oracle, gainedTextOf: from.id,
  });
  // "... and has the text '{2}: Discard a card.'" (GainTextAbilities$)
  for (const n of String(st.parsed.p.GainTextAbilities || '').split(' & ').map(x => x.trim()).filter(Boolean)) {
    const raw = st.svars[n];
    if (!raw) continue;
    ch.abilities.push({ raw, parsed: parseAbility(raw), svars: st.svars, src: card, key: `vtext:${n}` });
    const d = parseAbility(raw).p.SpellDescription;
    if (d) ch.oracle = `${ch.oracle || ''}\n${d}`;
  }
}
// GainTextOf$ TopOfGraveyard.Creature: the top card of its controller's graveyard, if it's a creature card
function gainTextSource(game, host, spec) {
  const [what, ...rest] = String(spec).split('.');
  let cand = null;
  if (what === 'TopOfGraveyard') { const gy = game.players[host.controller].graveyard; cand = gy[gy.length - 1] || null; }
  else cand = resolveDefined(game, what, staticCtx(game, host, { svars: {} })).find(o => o && o.isCard) || null;
  if (!cand) return null;
  if (rest.length && !cand.faceDef.types.includes(rest.join('.')) && !matchValid(game, cand, 'Card.' + rest.join('.'), { host, you: host.controller })) return null;
  return cand;
}
export function lastTextLayer(game, map, all, affected) {
  const sts = [];
  for (const c of game.battlefield) {
    const ch = map.get(c.id);
    if (!ch || c.phasedOut) continue;
    for (const st of ch.statics) {
      const p = st.parsed.p;
      if (!String(p.Mode || '').split(',').includes('Continuous') || !(p.GainTextOf || p.ChangeColorWordsTo || p.AddNames)) continue;
      const ctx = staticCtx(game, c, st);
      if (!checkPresence(game, p, ctx)) continue;
      sts.push({ st: { ...st, host: c, ch }, ctx });
    }
  }
  if (!sts.length) return;
  sts.sort((a, b) => (a.st.host.timestamp || 0) - (b.st.host.timestamp || 0));
  for (const kind of ['GainTextOf', 'ChangeColorWordsTo', 'AddNames']) {
    for (const { st, ctx } of sts) {
      const p = st.parsed.p;
      if (!p[kind]) continue;
      const targets = affected(st, ctx).filter(c => map.has(c.id));
      if (kind === 'GainTextOf') {
        const from = gainTextSource(game, st.host, p.GainTextOf);
        if (from) for (const c of targets) gainText(game, c, map.get(c.id), from, st);
      } else if (kind === 'ChangeColorWordsTo') {
        const to = colorWordOf(st.host, p);
        if (to) for (const c of targets) changeColorWords(map.get(c.id), to);
      } else for (const c of targets) map.get(c.id).allNames = true;
    }
  }
}
// abilities.js buildSpellSA: a spell being cast has its color words changed too
export function lastSpellText(game, card, raw, svars) {
  let to = null;
  for (const s of game.activeStatics('Continuous')) {
    const p = s.p;
    if (!p.ChangeColorWordsTo || !/Spell/.test(p.Affected || '') || !/Stack/.test(p.AffectedZone || '')) continue;
    to = colorWordOf(s.host, p) || to;
  }
  if (!to) return null;
  return { raw: swapAbilityText(raw, to, svars), svars: swapSvars(svars, to) };
}
// Spy Kit: the names of nonlegendary creature cards (any face), from the card database
function nonlegendaryCreatureName(game, name) {
  if (!name || !game.db || !game.db.get) return false;
  const def = game.db.get(name);
  return !!def && def.faces.some(f => f.name === name && f.types.includes('Creature') && !f.supertypes.includes('Legendary'));
}
// filters.js: does a card (its characteristics) have this name?
export function lastHasName(game, ch, name) {
  return !!ch && !!ch.allNames && nonlegendaryCreatureName(game, name);
}
// filters.js namesMatch: two objects share a name when either has all those names and the other has one of them
export function lastNamesMatch(game, a, b) {
  if (!a || !b || !(a.allNames || b.allNames)) return false;
  if (a.allNames && b.allNames) return true;
  return a.allNames ? nonlegendaryCreatureName(game, b.name) : nonlegendaryCreatureName(game, a.name);
}

// ================================================================ can't be the target
// Forge's StaticAbilityCantTarget: AffectedZone$ (default: permanents), ValidTarget$, ValidSA$, ValidSource$,
// Activator$, an EffectZone$ Stack static only while its spell is being cast (Enthralling Hold), and
// SourceCanOnlyTarget$ (Wall of Shadows: only spells and abilities that can target only Walls)
export function lastCantTarget(game, s, obj, sa, you) {
  const p = s.p;
  if (obj.isCard || obj.lki) {
    const zone = obj.zone;
    if (p.AffectedZone) { if (!p.AffectedZone.split(',').map(Z).includes(zone)) return false; }
    else if (zone !== 'battlefield') return false;
    if ((p.EffectZone || '').split(',').includes('Stack') && sa && sa.host && game.stack.some(i => i.kind === 'spell' && i.card === sa.host)) return false;
  } else if (p.AffectedZone) return false;
  const ctx = s.ctx;
  const valid = p.ValidTarget || p.ValidCard;
  if (valid && !matchValid(game, obj, valid, ctx)) return false;
  if (p.ValidSA && !(sa && causeMatches(game, sa, p.ValidSA, ctx))) return false;
  if (p.ValidSource && !(sa && sa.host && matchValid(game, sa.host, p.ValidSource, ctx))) return false;
  if (p.Activator && !matchValid(game, game.players[you], p.Activator, ctx)) return false;
  if (p.SourceCanOnlyTarget) {
    const only = p.SourceCanOnlyTarget;
    const root = sa && sa.root ? sa.root() : sa;
    if (!root) return false;
    const chains = root.api === 'Charm'
      ? (root.p.Choices || '').split(',').map(n => n.trim()).filter(n => root.svars[n]).map(n => AB.makeSA(game, root.svars[n], root.svars, root.host, root.controller, { parent: root }).chain())
      : [root.chain()];
    for (const chain of chains) for (const x of chain) {
      if (!x.p.ValidTgts && !x.p.TargetType) continue;
      const v = String(x.p.ValidTgts || '');
      if (!v.includes(only) || v.includes(',') || v.includes('non' + only)) return false;
    }
  }
  return true;
}

// ================================================================ mana abilities that can't be activated
// "Enchanted creature ... its activated abilities can't be activated" (Lost in Thought, Volrath's Curse, Arrest): mana
// abilities too, unless the static leaves them out (Pithing Needle: ValidSA$ Activated.!ManaAbility) or only stops
// other kinds (loyalty, cycling, ...)
export function lastNoManaAbilities(game, card) {
  if (!card || card.zone !== 'battlefield') return false;
  return game.activeStatics('CantBeActivated').some(s => {
    const v = s.p.ValidSA;
    if (v && v !== 'Activated' && v !== 'Activated.hasTapCost') return false;
    if (s.p.AffectedZone && !s.p.AffectedZone.split(',').map(Z).includes('battlefield')) return false;
    if (s.p.Activator && !matchValid(game, game.players[card.controller], s.p.Activator, s.ctx)) return false;
    return matchValid(game, card, s.p.ValidCard || 'Card', s.ctx);
  });
}

// ================================================================ lethal damage by power
// Zilortha: "Lethal damage dealt to creatures you control is determined by their power rather than their toughness"
export function lastLethalLayer(game, active, map, affected) {
  for (const { st, ctx } of active) {
    if (st.parsed.p.LethalDamageByPower !== 'True') continue;
    for (const c of affected(st, ctx)) { const ch = map.get(c.id); if (ch) ch.lethalByPower = true; }
  }
}
// the damage that's lethal for a creature with these characteristics (combat assignment, state-based actions)
export const lethalOf = ch => (ch && ch.lethalByPower ? ch.power : ch ? ch.toughness : 0);

// ================================================================ effects
export const LAST_EFFECTS = { InternalIgnoreEffect, Vote, VillainousChoice };

// ================================================================ the computer's choices
// ai.js choose: votes, extra votes, the announced X
export function aiLast(ai, game, pid, req) {
  if (req.purpose === 'extraVotes') return req.type === 'confirm' ? true : req.max;
  if (req.purpose === 'announceX') return aiAnnounce(ai, game, pid, req);
  if (req.purpose !== 'vote' || !req.sa) return undefined;
  const sa = req.sa;
  const caster = sa.controller;
  const forMe = caster === pid; // (an opponent's vote goes against what helps the caster)
  if (req.type === 'option') {
    let best = null, bs = -Infinity;
    for (const o of req.options || []) {
      const raw = sa.svars[o.value];
      if (!raw) continue;
      let v = 0;
      try { for (const s of AB.makeSA(game, raw, sa.svars, sa.host, caster, { parent: sa }).chain()) v += ai.scoreApi(game, caster, s, { main: true }); } catch { v = 0; }
      const score = forMe ? v : -v;
      if (score > bs) { bs = score; best = o.value; }
    }
    return best != null ? best : (req.options[0] || {}).value;
  }
  if (req.type === 'cards') {
    const cards = (req.cards || []).map(id => game.cardById(id)).filter(Boolean);
    // the most valuable card that isn't ours; nothing when voting is optional and only ours are left
    const theirs = cards.filter(c => c.controller !== pid).sort((a, b) => ai.value(b) - ai.value(a));
    if (theirs.length) return [theirs[0].id];
    if (!req.min) return [];
    return [cards.sort((a, b) => ai.value(a) - ai.value(b))[0].id];
  }
  if (req.type === 'player') {
    const ids = req.players || [];
    const helps = /Draw|GainLife|Token/.test(JSON.stringify(Object.values(sa.svars || {})));
    if (helps && ids.includes(pid)) return pid;
    const opp = ids.filter(id => id !== pid).sort((a, b) => ai.threat(b) - ai.threat(a));
    return opp.length ? opp[0] : ids[0];
  }
  return undefined;
}
function aiAnnounce(ai, game, pid, req) {
  const xs = (req.options || []).map(o => o.value);
  if (!xs.length) return null;
  // "counter target spell if its mana value is X": an opponent's spell's mana value
  const counters = req.sa && req.sa.chain().some(s => s.api === 'Counter');
  if (counters) {
    for (const item of game.stack.slice().reverse()) {
      if (item.kind !== 'spell' || item.controller === pid || !item.card) continue;
      const mv = game.chars(item.card).cmc + (item.sa && item.sa.x && item.card.faceDef.manaCost && item.card.faceDef.manaCost.x ? item.sa.x * item.card.faceDef.manaCost.x : 0);
      if (xs.includes(mv)) return mv;
    }
  }
  return Math.max(...xs);
}
// ai.js scoreActivate: paying to ignore an effect, when that lets it do something now
export function aiIgnoreScore(ai, game, pid, card, abil, ctx) {
  const found = ignoreStatic(game, card, abil.parsed.p.IgnoreStatic);
  if (!found) return 0;
  const p = found.st.parsed.p;
  const me = game.players[pid];
  const modes = String(p.Mode || '').split(',');
  const cost = String(p.IgnoreEffectCost);
  // a permanent to sacrifice, when that's the cost: something worth less than what it frees
  // (a token, a cheap nonland permanent, or a land when it has plenty)
  const lands = game.battlefield.filter(c => c.controller === pid && game.chars(c).types.has('Land')).length;
  const sacOk = limit => !/^Sac/.test(cost) || game.battlefield.some(c => c.controller === pid && c.id !== card.id && (c.token || (game.chars(c).types.has('Land') ? lands >= 7 : ai.value(c) <= limit)));
  if (/CantSearchLibrary/.test(p.AddKeyword || '')) {
    if (!ctx.main) return 0;
    // a search to make right after (a spell in hand it can pay for too, or an ability on the battlefield)
    const searches = raw => /ChangeZone/.test(raw) && /Origin\$ [^|]*Library/.test(raw) && !/Defined\$/.test(raw);
    const mana = AB.availableManaCount ? AB.availableManaCount(game, pid) : 0;
    const need = cmc(AB.parseCost ? AB.parseCost(cost).mana : null) || 0;
    const hand = me.hand.some(c => !c.faceDef.types.includes('Land') && Object.values(c.faceDef.svars).concat(c.faceDef.abilities).some(searches) && need + cmc(c.faceDef.manaCost) <= mana);
    const board = game.battlefield.some(c => c.controller === pid && game.chars(c).abilities.some(a => searches(a.raw)));
    return hand || board ? 8 : 0;
  }
  if (modes.includes('CantPlayLand') || modes.includes('CantBeCast')) {
    // a spell it could cast right after (not a land: sacrificing one permanent to play another gains nothing)
    if (!(ctx.main && ctx.myTurn)) return 0;
    const spell = me.hand.some(c => ['Artifact', 'Creature', 'Enchantment'].some(t => c.faceDef.types.includes(t)) && c.faceDef.cmc <= lands);
    return spell && sacOk(2) ? 3 : 0;
  }
  // "can't attack or block, and its activated abilities can't be activated": before combat, a creature worth freeing
  const freed = staticAffects(game, card, found.st, found.ctx).cards.filter(c => c.controller === pid);
  if (!freed.length) return 0;
  const best = Math.max(...freed.map(c => ai.value(c)));
  if (!(ctx.myTurn && game.step === 'main1')) return 0;
  const sac = /^Sac/.test(cost);
  if (!freed.some(c => (!c.sick && game.chars(c).power >= (sac ? 3 : 2)) || game.chars(c).abilities.some(a => a.parsed.kind === 'AB' && a.parsed.api !== 'Mana'))) return 0;
  if (sac && best < 5) return 0;
  return sacOk(Math.min(3, best / 2)) ? 2.5 : 0;
}
