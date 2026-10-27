// Casting mechanics: alternative and additional costs, casting from other zones, the cost types they use and the
// keywords that change how spells are cast — Warp, Sneak, Web-slinging, Freerunning, Teamwork, More Than Meets the
// Eye, Living metal, Prototype, Prepare, Splice, Craft, Assist, Ripple, Epic, Amplify, Tribute, Recover, Paradigm,
// collect evidence, forage and the rest. abilities.js calls the hooks below at the matching steps of casting a spell
// and paying a cost; the shared files that can't import this module (filters, triggers, keywords) take its
// additions through the registries in ext.js. (Only use imported bindings inside functions: the imports are
// circular. Never import this module before effects.js or abilities.js: effects.js needs CASTING_EFFECTS as it loads.)
import { parseAbility } from './forge.js';
import { SA, makeSA, parseCost, castSpell, castKeywords, ownCost, costLabel, canAfford, payManaCost, humanValid, Cancelled, availableManaCount, payTriggerCost, resolveChain } from './abilities.js';
import { matchValid, resolveDefined, calcCtx, ctxOf } from './filters.js';
import { filterExt, triggerExt, keywordExt } from './ext.js';
import { cmc, cloneCost, parseMana } from './mana.js';
import { COLORS } from './util.js';
import { copyStackItem } from './effects.js';

const PERMANENT_TYPES = ['Artifact', 'Creature', 'Enchantment', 'Land', 'Planeswalker', 'Battle'];
const faceIsPermanent = face => face.types.some(t => PERMANENT_TYPES.includes(t));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---------------------------------------------------------------- keywords
const etbSelf = 'Mode$ ChangesZone | Origin$ Any | Destination$ Battlefield | ValidCard$ Card.Self';
// tribute N: as it enters, an opponent of your choice may put N +1/+1 counters on it; "if tribute wasn't paid" triggers
keywordExt.Tribute = ({ T, R, S, a, face }) => {
  R.push(`Event$ Moved | Destination$ Battlefield | ValidCard$ Card.Self | ReplacementResult$ Updated | ReplaceWith$ KWTribute | Description$ Tribute ${a}`);
  S.KWTribute = `DB$ Tribute | Amount$ ${a || 1}`;
  const not = face.svars.TrigNotTribute;
  if (not) T.push(`${etbSelf}+notTributed | Execute$ TrigNotTribute | TriggerDescription$ ${(parseAbility(not).p.SpellDescription || "When CARDNAME enters, if tribute wasn't paid, …").replace(/\|/g, '')}`);
};
// amplify N: as it enters, reveal any number of cards from your hand that share a creature type with it
keywordExt.Amplify = ({ R, S, a }) => {
  R.push(`Event$ Moved | Destination$ Battlefield | ValidCard$ Card.Self | ReplacementResult$ Updated | ReplaceWith$ KWAmplify | Description$ Amplify ${a}`);
  S.KWAmplify = `DB$ Amplify | Amount$ ${a || 1}`;
};
// recover: when a creature is put into your graveyard from the battlefield, pay the cost to return this card to
// your hand, or exile it
keywordExt.Recover = ({ T, S, parts, face }) => {
  const cost = parts.slice(1).join(':');
  const creature = face.types.includes('Creature');
  T.push(`Mode$ ChangesZone | Origin$ Battlefield | Destination$ Graveyard | ValidCard$ Creature.YouOwn${creature ? '+Other' : ''} | TriggerZones$ Graveyard | Execute$ KWRecover | TriggerDescription$ Recover ${costLabel(cost)} (when ${creature ? 'another' : 'a'} creature is put into your graveyard from the battlefield, you may pay it to return CARDNAME to your hand; otherwise exile CARDNAME)`);
  S.KWRecover = `DB$ Recover | Cost$ ${cost}`;
};
// ripple N: when you cast it, you may reveal the top N cards and cast the ones with the same name for free
keywordExt.Ripple = ({ T, S, a }) => {
  T.push(`Mode$ SpellCast | ValidCard$ Card.Self | OptionalDecider$ You | Execute$ KWRipple | TriggerDescription$ Ripple ${a} — reveal the top ${a} cards of your library; cast the ones named CARDNAME without paying their mana costs`);
  S.KWRipple = `DB$ Ripple | Amount$ ${a || 4}`;
};
// craft with [materials] {cost}: exile this and the materials from among permanents you control and/or cards in your
// graveyard; return it transformed, as a sorcery
keywordExt.Craft = ({ A, parts }) => {
  const cost = parts[1] || '';
  const label = parts[2] ? `Craft with ${parts[2]}` : `Craft (${costLabel(cost)})`;
  A.push(`AB$ ChangeZone | Cost$ Exile<1/CARDNAME> ${cost} | Origin$ Exile | Destination$ Battlefield | Transformed$ True | Defined$ CorrectedSelf | SorcerySpeed$ True | Craft$ True | SpellDescription$ ${label} — ${costLabel(cost)}: exile CARDNAME and the materials, then return it transformed`);
};
// transfigure: sacrifice it to search for a creature card with the same mana value, as a sorcery
keywordExt.Transfigure = ({ A, S, a }) => {
  A.push(`AB$ ChangeZone | Cost$ ${a} Sac<1/CARDNAME> | Origin$ Library | Destination$ Battlefield | ChangeType$ Creature.cmcEQKWTransfigX | ChangeNum$ 1 | SorcerySpeed$ True | SpellDescription$ Transfigure ${costLabel(a)} (sacrifice CARDNAME: search for a creature card with the same mana value and put it onto the battlefield)`);
  S.KWTransfigX = 'Count$CardManaCost';
};

// ---------------------------------------------------------------- trigger modes
const playerOk = (game, p, rp, ctx) => !p.ValidPlayer || (rp.Player != null && matchValid(game, game.players[rp.Player], p.ValidPlayer, ctx));
const cardOk = (game, p, rp, ctx) => !p.ValidCard || (!!rp.Card && matchValid(game, rp.Card, p.ValidCard, ctx));
triggerExt.BecomesPlotted = (game, p, host, rp, ctx) => cardOk(game, p, rp, ctx) && playerOk(game, p, rp, ctx);
triggerExt.Foretell = (game, p, host, rp, ctx) => cardOk(game, p, rp, ctx) && playerOk(game, p, rp, ctx);
triggerExt.CollectEvidence = (game, p, host, rp, ctx) => playerOk(game, p, rp, ctx);
triggerExt.Forage = (game, p, host, rp, ctx) => playerOk(game, p, rp, ctx);
triggerExt.Adapt = (game, p, host, rp, ctx) => cardOk(game, p, rp, ctx);
// "whenever a spell or ability is put onto the stack" also sees copies (Grip of Chaos)
triggerExt.SpellAbilityCopy = (game, p, host, rp, ctx) => {
  if (p.IsSingleTarget === 'True' && (rp.Targets || []).length !== 1) return false;
  if (p.ValidCard && !(rp.Card && matchValid(game, rp.Card, p.ValidCard, ctx))) return false;
  if (p.ValidActivatingPlayer && !matchValid(game, game.players[rp.Player], p.ValidActivatingPlayer, ctx)) return false;
  return true;
};

// ---------------------------------------------------------------- card properties and Count$ values
function castSAOf(card) { return card && (card.castSA || (card.lki && card.castSA)) || null; }
function isWarped(card) { return !!card && card.zone === 'exile' && !!card.warped && card.warped.zcc === card.zcc; }
export function preparedCopyOf(game, card) {
  if (!card || !card.prepared || card.prepared.zcc !== card.zcc || card.zone !== 'battlefield') return null;
  const copy = game.cardById(card.prepared.copyId);
  return copy && copy.zone === 'exile' ? copy : null;
}
filterExt.cardProp.push((game, card, ch, prop) => {
  switch (prop) {
    case 'tributed': return !!card.tributed && card.tributed.zcc === card.zcc;
    case 'notTributed': return !(card.tributed && card.tributed.zcc === card.zcc);
    case 'warped': return isWarped(card);
    // a creature that's prepared, or the copy of a prepared spell (Codie: "whenever you cast a prepared spell")
    case 'prepared': return !!card.preparedFrom || !!preparedCopyOf(game, card);
    case 'unprepared': return !card.preparedFrom && !preparedCopyOf(game, card);
    case 'Teamwork': { const sa = castSAOf(card); return !!(sa && sa.root().teamwork); }
    case 'freerunning': case 'Freerunning': { const sa = castSAOf(card); return !!(sa && sa.root().altCost === 'Freerunning'); }
    case 'prototyped': return !!(card.castSA && card.castSA.opt && card.castSA.opt.prototype);
  }
  return undefined;
});
filterExt.castSA.push((game, sa, card, prop) => {
  const root = sa.root ? sa.root() : sa;
  switch (prop) {
    case 'Teamwork': return !!root.teamwork;
    case 'Freerunning': return root.altCost === 'Freerunning';
    case 'MTMtE': return !!(root.opt && root.opt.converted);
    case 'Prototype': return !!(root.opt && root.opt.prototype);
    case 'Spliced': return !!(root.spliced && root.spliced.length);
  }
  return undefined;
});
// void: a nonland permanent left the battlefield this turn or a spell was warped this turn
export function isVoid(game) {
  return game.turnState.moves.some(m => m.from === 'battlefield' && m.lki && !m.lki.chars.types.has('Land'))
    || game.turnState.spellsCast.some(r => r.lki && r.lki.castSA && r.lki.castSA.altCost === 'Warp');
}
filterExt.count.push((game, rest, ctx) => {
  const m = rest.match(/^(Teamwork|Freerunning|Void|Spliced)\.([-\w]+)\.([-\w]+)$/);
  if (!m) return undefined;
  const sa = ctx && ctx.sa;
  const r = sa && sa.root ? sa.root() : null;
  const cast = ctx && ctx.host && ctx.host.castSA;
  const flag = m[1] === 'Void' ? isVoid(game)
    : m[1] === 'Teamwork' ? !!((r && r.teamwork) || (cast && cast.teamwork))
      : m[1] === 'Spliced' ? !!((r && r.spliced && r.spliced.length) || (cast && cast.spliced && cast.spliced.length))
        : (r && r.altCost === 'Freerunning') || (cast && cast.altCost === 'Freerunning');
  return calcCtx(game, flag ? m[2] : m[3], ctx);
});

// ---------------------------------------------------------------- ways to cast a spell
// freerunning: you dealt combat damage to a player this turn with an Assassin or a commander you controlled
function freerunReady(game, pid) {
  return game.turnState.damageLog.some(e => {
    if (!e.combat || e.player == null || e.controller !== pid || e.source == null) return false;
    const src = game.cardById(e.source);
    if (!src) return false;
    const ch = game.chars(src);
    return src.isCommander || ch.subtypes.has('Assassin') || ch.allCreatureTypes;
  });
}
function untappedPower(game, pid) {
  return game.battlefield.filter(c => c.controller === pid && !c.tapped && game.chars(c).types.has('Creature')).reduce((a, c) => a + Math.max(0, game.chars(c).power), 0);
}
const teamworkCost = n => `tapXType<Any/Creature.YouCtrl+withTotalPowerGE${n}>`;

// Options from the hand (and the command zone) for the alternative costs this module adds: spellOptions calls it
// with its pushFace(face, extra).
export function castingAltOptions(game, pid, card, from, pushFace, kws = null) {
  const faces = card.def.faces;
  const f = faces[0];
  const seen = new Set();
  for (const k of kws || castKeywords(game, pid, card, f, from)) {
    if (seen.has(k)) continue;
    seen.add(k);
    const parts = k.split(':');
    const arg = parts.slice(1).join(':');
    switch (parts[0]) {
      // warp {cost}: from your hand only; it's exiled at the next end step and can be cast from exile later
      case 'Warp':
        if (from === 'hand') pushFace(0, { key: 'warp0', altCost: 'Warp', altManaStr: ownCost(f, arg), label: `Warp ${f.name} (${costLabel(ownCost(f, arg))}; exiled at the next end step)` });
        break;
      // sneak {cost}: during the declare blockers step, return an unblocked attacker you control to hand
      case 'Sneak':
        if (game.step === 'declareBlockers' && game.combat) pushFace(0, { key: 'sneak0', altCost: 'Sneak', altManaStr: `${ownCost(f, parts[1])} Return<1/Creature.attacking+unblocked/unblocked attacker>`, mayFlash: true, onlyStep: 'declareBlockers', label: `Sneak ${f.name} (${costLabel(parts[1])} and return an unblocked attacker to your hand)` });
        break;
      // web-slinging {cost}: return a tapped creature you control to its owner's hand
      case 'Web-slinging':
        pushFace(0, { key: 'web0', altCost: 'Web-slinging', altManaStr: `${ownCost(f, parts[1])} Return<1/Creature.tapped/tapped creature you control>`, label: `Web-sling ${f.name} (${costLabel(parts[1])} and return a tapped creature you control to your hand)` });
        break;
      case 'Freerunning':
        if (freerunReady(game, pid)) pushFace(0, { key: 'free0', altCost: 'Freerunning', altManaStr: ownCost(f, arg), label: `Freerunning ${f.name} (${costLabel(ownCost(f, arg))})` });
        break;
      // more than meets the eye {cost}: cast it converted (its back face)
      case 'More Than Meets the Eye':
        if (faces[1]) pushFace(1, { key: 'mtmte1', altCost: 'MTMtE', altManaStr: arg, converted: true, label: `Cast ${faces[1].name} converted (${costLabel(arg)})` });
        break;
      // prototype {cost} P/T: a smaller version with that mana cost, its colors and that power and toughness
      case 'Prototype': {
        const [, cost, p, t] = parts;
        if (!cost) break;
        const mana = parseMana(cost);
        const colors = COLORS.filter(c => (mana.colored[c] || 0) > 0 || mana.hybrid.some(h => h.includes(c)) || mana.phyrexian.includes(c));
        pushFace(0, { key: 'proto0', altManaStr: cost, prototype: { manaCost: mana, colors, power: p, toughness: t }, label: `Cast ${f.name} prototyped (${costLabel(cost)}: a ${p}/${t})` });
        break;
      }
      // "you may cast this spell as though it had flash if it's cast using teamwork" (Quantum Reduction)
      case 'Teamwork':
        if (!game.canSorcery(pid) && f.statics.some(s => /Mode\$ CastWithFlash/.test(s) && /ValidSA\$ Spell\.Teamwork/.test(s)) && untappedPower(game, pid) >= +parts[1]) {
          pushFace(0, { key: 'teamflash0', mayFlash: true, forceTeamwork: +parts[1], extraCostStr: teamworkCost(parts[1]), label: `Cast ${f.name} with teamwork (as though it had flash)` });
        }
        break;
    }
  }
}

// casting from exile: a warped card on a later turn, the copy of a prepared creature's spell
export function castingExileFrom(game, pid, card) {
  if (isWarped(card) && card.owner === pid && card.warped.turn !== game.turnNumber && !game.chars(card).types.has('Land')) return 'warped';
  if (card.preparedFrom && card.owner === pid) {
    const src = game.cardById(card.preparedFrom.id);
    if (src && src.zone === 'battlefield' && src.controller === pid && preparedCopyOf(game, src) === card) return 'prepared';
  }
  return null;
}
export function castingExileOptions(game, pid, card, from, pushFace) {
  if (from === 'prepared') pushFace(card.face || 1, { key: 'prep', label: `Cast ${card.faceDef.name} (prepared spell)` });
  else pushFace(0, { label: `Cast ${card.def.faces[0].name} (warped)` });
}

// what a "you may cast it from your graveyard" permission allows: Timeline Culler only with its warp ability
export function castingFilterOptions(game, pid, card, from, opts, mayPlay, pushFace) {
  if (!mayPlay || !mayPlay.st) return;
  const vsa = mayPlay.st.parsed.p.ValidSA || '';
  if (vsa === 'Spell.Warp') {
    opts.length = 0;
    const f = card.def.faces[0];
    for (const k of castKeywords(game, pid, card, f, from)) {
      const m = k.match(/^Warp:(.+)$/);
      if (m) { pushFace(0, { key: 'warpg0', altCost: 'Warp', altManaStr: ownCost(f, m[1]), label: `Warp ${f.name} from your graveyard (${costLabel(ownCost(f, m[1]))})` }); break; }
    }
  }
}

// ---------------------------------------------------------------- choices made while casting
// Teamwork: called by castSpell before modes are chosen ("if this spell was cast using teamwork, choose both
// instead"). h.addCost(str) adds a cost (mana and other parts), h.affordable(str) checks it together with the rest.
export async function castingEarlyCosts(game, pid, card, sa, opt, face, kws, h) {
  // teamwork N: you may tap any number of creatures you control with total power N or more
  const tw = kws.map(k => k.match(/^Teamwork:(\d+)$/)).find(Boolean);
  if (tw) {
    const n = +tw[1];
    if (opt.forceTeamwork) sa.teamwork = true;
    else if (untappedPower(game, pid) >= n && h.affordable(teamworkCost(n))) {
      const yes = await game.ask(pid, { type: 'confirm', prompt: `Teamwork ${n}: tap creatures you control with total power ${n} or more as you cast ${face.name}?`, purpose: 'teamwork', need: n, sa, cancellable: true, cardId: card.id });
      if (yes == null) throw new Cancelled();
      if (yes) { h.addCost(teamworkCost(n)); sa.teamwork = true; }
    }
  }
}

// Splice: called by castSpell after the other optional costs, before X and targets.
export async function castingAdditionalCosts(game, pid, card, sa, opt, face, kws, h) {
  // splice onto [type] {cost}: reveal cards from your hand as you cast a spell of that type and add their effects
  if (!card.isSpellCopy) {
    const cands = [];
    for (const c of game.players[pid].hand) {
      if (c === card) continue;
      const k = game.chars(c).keywords.find(x => /^Splice:/.test(x));
      if (!k) continue;
      const [, type, ...rest] = k.split(':');
      const cost = rest.join(':');
      const spellFace = c.faceDef;
      const raw = spellFace.abilities.find(a => /^SP\$/.test(a));
      if (!raw || !type.split(',').some(t => matchValid(game, card, t.trim(), { host: card, you: pid }))) continue;
      if (!h.affordable(cost)) continue;
      cands.push({ c, cost, raw, type });
    }
    if (cands.length) {
      const ids = await game.ask(pid, { type: 'cards', prompt: `Splice onto ${cands[0].type.replace(/,/g, ' or ')}: you may reveal cards from your hand to add their effects to ${face.name} (paying their splice costs)`, cards: cands.map(x => x.c.id), min: 0, max: cands.length, purpose: 'splice', sa, cancellable: true, cardId: card.id });
      if (ids == null) throw new Cancelled();
      for (const id of ids) {
        const x = cands.find(y => y.c.id === id);
        if (!x || !h.affordable(x.cost)) continue;
        h.addCost(x.cost);
        const raw = x.raw.replace(/^SP\$/, 'DB$');
        let last = sa;
        while (last.sub) last = last.sub;
        last.sub = new SA(game, { raw, parsed: parseAbility(raw), svars: x.c.faceDef.svars, src: card, key: `splice:${x.c.id}` }, card, pid, { parent: last });
        (sa.spliced = sa.spliced || []).push(x.c.id);
        game.log(`${game.players[pid].name} reveals ${game.name(x.c)} and splices it onto ${face.name}.`, { cardId: x.c.id });
      }
    }
  }
}

// "each spell that would cost less than three mana to cast costs three mana" (Trinisphere)
export function castingSetCost(game, pid, card, mana) {
  let m = mana;
  for (const s of game.activeStatics('SetCost')) {
    const p = s.p;
    if (p.Type && !/Spell/.test(p.Type)) continue;
    if (p.ValidCard && !matchValid(game, card, p.ValidCard, s.ctx)) continue;
    if (p.Activator && !matchValid(game, game.players[pid], p.Activator, s.ctx)) continue;
    const amt = p.Amount ? calcCtx(game, p.Amount, s.ctx) : 0;
    const total = cmc({ ...m, x: 0 });
    if (p.RaiseTo === 'True' ? total < amt : total !== amt && total < amt) { m = cloneCost(m); m.generic += amt - total; }
  }
  return m;
}

// assist: another player may pay any amount of the generic mana in the spell's total cost
export async function castingAssist(game, pid, card, sa, mana, kws) {
  if (!kws.includes('Assist') || !(mana.generic > 0)) return mana;
  const helpers = game.opponents(pid).filter(o => availableManaCount(game, o.id) > 0);
  if (!helpers.length) return mana;
  const who = await game.ask(pid, { type: 'option', prompt: `Assist: another player may pay up to ${mana.generic} of the generic mana for ${game.name(card)}`, options: [{ label: 'Pay it all yourself', value: -1 }, ...helpers.map(o => ({ label: `Ask ${o.name} to help pay`, value: o.id }))], purpose: 'assist', sa, cardId: card.id });
  const helper = helpers.find(o => o.id === who);
  if (!helper) return mana;
  const max = Math.min(mana.generic, availableManaCount(game, helper.id));
  const n = await game.ask(helper.id, { type: 'number', prompt: `${game.players[pid].name} asks you to help pay for ${game.name(card)} (assist): pay how much of its generic mana?`, min: 0, max, purpose: 'assist', sa, forPlayer: pid, cardId: card.id });
  if (!n) { game.log(`${helper.name} doesn't help pay for ${game.name(card)}.`); return mana; }
  let k = n;
  while (k > 0 && !canAfford(game, helper.id, parseMana(String(k)))) k--;
  if (!k || !(await payManaCost(game, helper.id, parseMana(String(k)), {}))) return mana;
  game.log(`${helper.name} pays ${k} of ${game.name(card)}'s cost (assist).`);
  const m = cloneCost(mana);
  m.generic -= k;
  return m;
}

// once the spell is on the stack: casting a prepared copy unprepares its creature; a cost-chosen creature type stays
export function castingOnCast(game, pid, card, sa, opt) {
  if (card.preparedFrom) {
    const src = game.cardById(card.preparedFrom.id);
    if (src && src.prepared && src.prepared.copyId === card.id) { src.prepared = null; game.log(`${game.name(src)} becomes unprepared.`); }
  }
  if (sa.chosenType) card.chosen = { ...(card.chosen || {}), type: sa.chosenType };
  game.touch();
}

// a permanent spell cast this way has entered: warp's end-step exile, sneak's attack, a converted card's face
export async function castingPermanentResolved(game, item, moved) {
  const sa = item.sa;
  if (!sa || item.isCopy) return;
  if (sa.chosenType) moved.chosen = { ...(moved.chosen || {}), type: sa.chosenType };
  if (sa.opt && sa.opt.converted) { moved.transformed = true; game.touch(); }
  if (sa.altCost === 'Warp') {
    // "at the beginning of the next end step" (the next turn's, when it resolves during an end step)
    const late = game.step === 'end' || game.step === 'cleanup';
    game.delayed.push({ id: game.uid++, p: { Mode: 'Phase', Phase: 'End of Turn', Execute: 'WarpExile', TriggerDescription: `Warp — exile ${game.name(moved)}; its owner may cast it from exile on a later turn` }, svars: { WarpExile: `DB$ WarpExile | WarpZcc$ ${moved.zcc}` }, host: moved, controller: item.controller, remembered: [moved], turn: game.turnNumber, thisTurnOnly: !late, nextTurn: late });
  }
  if (sa.altCost === 'Sneak' && game.combat && game.chars(moved).types.has('Creature')) {
    const was = (sa.root().paid.ReturnedAttack || [])[0];
    if (was) {
      moved.tapped = true;
      game.combat.attackers.push({ card: moved.id, defenderPlayer: was.defenderPlayer, defenderCard: was.defenderCard && game.cardById(was.defenderCard) && game.cardById(was.defenderCard).zone === 'battlefield' ? was.defenderCard : null, blockers: [], blocked: false });
      game.log(`${game.name(moved)} enters tapped and attacking.`);
      game.touch();
    }
  }
}

// an instant or sorcery has resolved: paradigm exiles it and lets you cast copies of it; epic copies it each upkeep
export async function castingSpellResolved(game, item) {
  const card = item.card;
  if (!card || item.isCopy || card.isSpellCopy) return;
  const kws = card.faceDef.keywords;
  const pid = item.controller;
  if (kws.includes('Epic')) {
    makeEffect(game, card, pid, `${card.faceDef.name} (epic)`, {
      statics: ['Mode$ CantBeCast | ValidCard$ Card | Caster$ You | EffectZone$ Command | Description$ For the rest of the game, you can\'t cast spells.'],
      triggers: [`Mode$ Phase | Phase$ Upkeep | ValidPlayer$ You | Execute$ EpicCopy | TriggerDescription$ Epic — copy ${card.faceDef.name} (except its epic ability)`],
      svars: { EpicCopy: 'DB$ EpicCopy' },
      description: `For the rest of the game, you can't cast spells. At the beginning of each of your upkeeps, copy ${card.faceDef.name} except for its epic ability.`,
      extra: { epicItem: item },
    });
    game.log(`${game.players[pid].name} can't cast spells for the rest of the game (epic).`);
  }
  if (kws.includes('Paradigm') && card.zone === 'stack') {
    await game.moveCard(card, 'exile', { silent: true });
    game.log(`${card.faceDef.name} is exiled (paradigm).`);
    const name = `${card.faceDef.name} (paradigm)`;
    if (!game.effects.some(e => e.effectName === name && e.controller === pid)) {
      makeEffect(game, card, pid, name, {
        triggers: [`Mode$ Phase | Phase$ Main1 | ValidPlayer$ You | Execute$ ParadigmCast | TriggerDescription$ Paradigm — you may cast a copy of ${card.faceDef.name} without paying its mana cost`],
        svars: { ParadigmCast: 'DB$ ParadigmCast' },
        description: `At the beginning of each of your first main phases, you may cast a copy of ${card.faceDef.name} from exile without paying its mana cost.`,
        extra: { paradigmDef: card.def, paradigmFace: card.face || 0 },
      });
    }
  }
}

function makeEffect(game, card, pid, name, { statics = [], triggers = [], svars = {}, description = '', extra = {} }) {
  const e = {
    isEffect: true, id: game.nextId++, effectName: name, controller: pid, owner: pid, zone: 'command',
    duration: 'Permanent', remembered: [], imprinted: [], chosen: {}, counters: {}, timestamp: game.uid++, temp: [], mods: [], abilityUses: {}, xPaid: 0,
    hostCard: card, description, ...extra,
  };
  const mk = (raw, i, kind) => ({ raw, parsed: parseAbility(raw), svars, src: e, key: `e${e.id}${kind}${i}` });
  e.effectChars = { name, types: new Set(['Effect']), subtypes: new Set(), supertypes: new Set(), colors: new Set(), keywords: [], abilities: [], triggers: triggers.map((r, i) => mk(r, i, 'T')), statics: statics.map((r, i) => mk(r, i, 'S')), replacements: [], svars, power: 0, toughness: 0, cmc: 0 };
  game.effects.push(e);
  game.touch();
  return e;
}

// ---------------------------------------------------------------- prepare
// "becomes prepared": a copy of its spell waits in exile for its controller to cast; casting it, the creature
// leaving the battlefield or being unprepared ends that
export function castingAlterAttribute(game, sa, c, attr, activate = true) {
  if (attr === 'Prepared') {
    if (!c.isCard) return;
    if (!activate) { unprepare(game, c); return; }
    if (c.zone !== 'battlefield' || preparedCopyOf(game, c)) return;
    const spell = c.def.altMode === 'Prepare' ? c.def.faces[1] : null;
    if (!spell || !spell.abilities.some(a => /^SP\$/.test(a))) return; // only creatures with prepare spells
    const pid = c.controller;
    const copy = game.newCard(c.def, pid);
    copy.token = true; copy.isSpellCopy = true; copy.face = 1; copy.zone = 'exile';
    copy.preparedFrom = { id: c.id, zcc: c.zcc };
    game.players[pid].exile.push(copy);
    c.prepared = { zcc: c.zcc, copyId: copy.id };
    game.touch();
    game.log(`${game.name(c)} becomes prepared (${game.players[pid].name} may cast a copy of ${spell.name}).`, { cardId: c.id });
    return;
  }
  if (attr === 'Plotted') {
    if (!c.isCard || c.zone !== 'exile') return;
    if (!activate) { c.plotted = null; game.touch(); return; }
    c.plotted = { turn: game.turnNumber, zcc: c.zcc };
    game.touch();
    game.log(`${game.name(c)} becomes plotted.`);
    game.fire('BecomesPlotted', { Card: c, Player: sa.controller });
  }
}
function unprepare(game, c) {
  const copy = preparedCopyOf(game, c) || (c.prepared ? game.cardById(c.prepared.copyId) : null);
  c.prepared = null;
  if (copy && copy.zone === 'exile') {
    game.removeFromZone(copy);
    copy.zone = 'gone';
    game.cards.delete(copy.id);
  }
  game.touch();
}
// (moveCard, as a permanent leaves the battlefield)
export function castingLeftBattlefield(game, card) {
  if (card.prepared) unprepare(game, card);
}

// ---------------------------------------------------------------- costs
export const CASTING_COST_TYPES = new Set(['CollectEvidence', 'Forage', 'ExileFromTop', 'PutCardToLibFromHand', 'PutCardToLibFromGrave', 'PutCardToLibFromSameGrave', 'ExileFromStack', 'RevealFromExile', 'ChooseCreatureType', 'RevealOrChoose', 'ExileCtrlOrGrave', 'GainLife']);

// bare cost words: "Forage" (no amount)
export function castingBareCost(tok) {
  if (tok === 'Forage') return { type: 'Forage', amount: '1', args: ['1'] };
  return null;
}

const validOf = (part, i = 1, def = 'Card') => String(part.args[i] || def).replace(/;/g, ',').replace(/CARDNAME|NICKNAME/g, 'Card.Self');
function hostOf(sa) { return sa.host; }
function gyPool(game, sa) { return game.players[sa.controller].graveyard.filter(c => c !== hostOf(sa)); }
// Craft materials: "Permanent.Other+withSharedCardType" (two that share a card type) is checked on the whole choice
function craftValid(part) { return validOf(part).replace(/[+.]withSharedCardType/g, ''); }
function sharesCardType(game, cards) {
  if (cards.length < 2) return true;
  const types = cards.map(c => game.chars(c).types);
  return [...types[0]].some(t => types.every(s => s.has(t)));
}

function candidates(game, sa, part, exclude = new Set()) {
  const pid = sa.controller;
  const ctx = ctxOf(game, sa);
  const p = game.players[pid];
  const ok = c => !exclude.has(c.id);
  switch (part.type) {
    case 'CollectEvidence': return gyPool(game, sa).filter(ok);
    case 'ExileFromTop': return p.library.slice(0, Math.max(0, +part.amount || 1));
    case 'PutCardToLibFromHand': return p.hand.filter(c => c !== hostOf(sa) && ok(c) && matchValid(game, c, validOf(part, 2), ctx));
    case 'PutCardToLibFromGrave': return gyPool(game, sa).filter(c => ok(c) && matchValid(game, c, validOf(part, 2), ctx));
    case 'PutCardToLibFromSameGrave': return game.cardsInZone('graveyard').filter(c => c !== hostOf(sa) && ok(c) && matchValid(game, c, validOf(part, 2), ctx));
    // (the resolving spell too: "you may exile [this spell] ..." — Dragon's Approach)
    case 'ExileFromStack': return game.cardsInZone('stack').filter(c => c.controller === pid && ok(c) && matchValid(game, c, validOf(part).replace(/^Spell\b/, 'Card').replace(/,Spell\b/g, ',Card'), ctx));
    case 'RevealFromExile': return p.exile.filter(c => ok(c) && matchValid(game, c, validOf(part), ctx));
    case 'RevealOrChoose': { const v = validOf(part); return [...p.hand.filter(c => c !== hostOf(sa)), ...game.battlefield.filter(c => c.controller === pid)].filter(c => ok(c) && matchValid(game, c, v, ctx)); }
    case 'ExileCtrlOrGrave': { const v = craftValid(part); return [...game.battlefield.filter(c => c.controller === pid), ...p.graveyard].filter(c => c !== hostOf(sa) && ok(c) && matchValid(game, c, v, ctx)); }
    default: return [];
  }
}
function forageFood(game, sa, exclude = new Set()) { return game.battlefield.filter(c => c.controller === sa.controller && !exclude.has(c.id) && game.chars(c).subtypes.has('Food') && !game.cantSacrifice(c, sa, true)); }
function gainLifePlayers(game, sa, part) { return game.livingPlayers().filter(pl => matchValid(game, pl, validOf(part, 1, 'Player.Opponent'), ctxOf(game, sa))); }
const totalMV = (game, cards) => cards.reduce((a, c) => a + game.chars(c).cmc, 0);

export function castingCanPayPart(game, sa, part, n, exclude = new Set()) {
  switch (part.type) {
    case 'CollectEvidence': return n <= 0 || totalMV(game, candidates(game, sa, part, exclude)) >= n;
    case 'Forage': return gyPool(game, sa).filter(c => !exclude.has(c.id)).length >= 3 || forageFood(game, sa, exclude).length > 0;
    case 'ExileFromTop': return game.players[sa.controller].library.length >= n;
    case 'ChooseCreatureType': return true;
    case 'GainLife': return gainLifePlayers(game, sa, part).length > 0;
    case 'PutCardToLibFromSameGrave': { const cs = candidates(game, sa, part, exclude); return game.players.some(pl => cs.filter(c => c.owner === pl.id).length >= n); }
    case 'ExileCtrlOrGrave': {
      if (part.xMin && n < part.xMin) return false;
      const cs = candidates(game, sa, part, exclude);
      if (cs.length < n) return false;
      if (/withSharedCardType/.test(part.args[1] || '') && n >= 2) return PERMANENT_TYPES.concat(['Instant', 'Sorcery', 'Kindred']).some(t => cs.filter(c => game.chars(c).types.has(t)).length >= n);
      return true;
    }
    default: return candidates(game, sa, part, exclude).length >= n;
  }
}
// the largest X a cost part allows ("collect evidence X", "exile X creatures you control and/or creature cards")
export function castingCostMax(game, sa, part) {
  if (part.type === 'CollectEvidence') return totalMV(game, candidates(game, sa, part));
  if (part.type === 'ExileFromTop') return game.players[sa.controller].library.length;
  if (['ChooseCreatureType', 'GainLife', 'Forage'].includes(part.type)) return Infinity;
  return candidates(game, sa, part).length;
}

function creatureTypes(game) {
  const s = new Set();
  for (const c of game.allCards()) { const ch = game.chars(c); if (ch.types.has('Creature') || ch.types.has('Kindred')) for (const t of ch.subtypes) if (!game.nonCreatureSubtypes.has(t)) s.add(t); }
  return [...s].sort();
}

async function pickCards(game, sa, pool, n, prompt, purpose, check = null, extra = {}) {
  if (pool.length < n) return null;
  if (n <= 0) return [];
  if (pool.length === n && !check) return pool.slice();
  let why = '';
  for (let tries = 0; tries < 3; tries++) {
    const ids = await game.ask(sa.controller, { type: 'cards', prompt: why + prompt, cards: pool.map(c => c.id), min: extra.min ?? n, max: extra.max ?? n, purpose, sa, cancellable: true, ...extra });
    if (!ids) throw new Cancelled();
    const cs = ids.map(id => game.cardById(id)).filter(c => c && pool.includes(c));
    const bad = check ? check(cs) : null;
    if (!bad) return cs;
    why = bad + ' ';
  }
  throw new Cancelled();
}

export async function castingChooseCostPart(game, sa, part, n, used) {
  const pid = sa.controller;
  const ex = used || new Set();
  switch (part.type) {
    case 'CollectEvidence': {
      if (n <= 0) return { part, cards: [], n };
      const pool = candidates(game, sa, part, ex);
      if (totalMV(game, pool) < n) return null;
      const cards = await pickCards(game, sa, pool, 1, `Collect evidence ${n}: exile cards with total mana value ${n} or more from your graveyard`, 'collectEvidence',
        cs => totalMV(game, cs) >= n ? null : `Those cards' total mana value is ${totalMV(game, cs)}, less than ${n}.`, { min: 1, max: pool.length, needMV: n });
      return { part, cards, n };
    }
    case 'Forage': {
      const gy = gyPool(game, sa).filter(c => !ex.has(c.id));
      const food = forageFood(game, sa, ex);
      let how = gy.length >= 3 ? 'exile' : 'food';
      if (gy.length >= 3 && food.length) {
        how = await game.ask(pid, { type: 'option', prompt: 'Forage: exile three cards from your graveyard or sacrifice a Food', options: [{ label: 'Exile three cards from your graveyard', value: 'exile' }, { label: 'Sacrifice a Food', value: 'food' }], purpose: 'forage', sa, cancellable: true });
        if (how == null) throw new Cancelled();
      }
      if (how === 'exile') return { part, cards: await pickCards(game, sa, gy, 3, 'Forage: exile three cards from your graveyard', 'costExile'), forage: 'exile' };
      if (!food.length) return null;
      return { part, cards: await pickCards(game, sa, food, 1, 'Forage: sacrifice a Food', 'costSac'), forage: 'food' };
    }
    case 'ExileFromTop': {
      const lib = game.players[pid].library;
      if (lib.length < n) return null;
      return { part, cards: lib.slice(0, n), n };
    }
    case 'ChooseCreatureType': {
      const types = creatureTypes(game);
      if (!types.length) return { part, type: 'Human' };
      const t = await game.ask(pid, { type: 'option', prompt: 'Choose a creature type', options: types.map(x => ({ label: x, value: x })), purpose: 'chooseType', kind: 'Creature', sa, cancellable: true, ai: sa.p && sa.p.AILogic });
      if (t == null) throw new Cancelled();
      return { part, type: types.includes(t) ? t : types[0] };
    }
    case 'GainLife': {
      const pls = gainLifePlayers(game, sa, part);
      if (!pls.length) return null;
      if (part.args[2] === '*' || pls.length === 1) return { part, players: pls, n };
      const id = await game.ask(pid, { type: 'player', prompt: `Choose a player to gain ${n} life`, players: pls.map(p => p.id), purpose: 'costGainLife', sa, cancellable: true, ai: 'Opponent' });
      if (id == null) throw new Cancelled();
      return { part, players: [pls.find(p => p.id === id) || pls[0]], n };
    }
    case 'PutCardToLibFromSameGrave': {
      const cs = candidates(game, sa, part, ex);
      const owners = game.players.filter(pl => cs.filter(c => c.owner === pl.id).length >= n);
      if (!owners.length) return null;
      let owner = owners[0];
      if (owners.length > 1) { const id = await game.ask(pid, { type: 'player', prompt: 'Put cards from whose graveyard on the bottom of their library?', players: owners.map(o => o.id), purpose: 'costSameGrave', sa }); owner = owners.find(o => o.id === id) || owners[0]; }
      return { part, cards: await pickCards(game, sa, cs.filter(c => c.owner === owner.id), n, `Put ${plural(n, 'card')} from ${owner.name}'s graveyard on the bottom of their library`, 'costPutCardToLib'), n };
    }
    default: {
      const pool = candidates(game, sa, part, ex);
      const desc = part.args[3] || part.args[2] || humanValid(validOf(part, part.type.startsWith('PutCardToLib') ? 2 : 1));
      const prompts = {
        PutCardToLibFromHand: `Put ${plural(n, 'card')} from your hand on ${part.args[1] === '-1' ? 'the bottom' : 'top'} of your library`,
        PutCardToLibFromGrave: `Put ${plural(n, 'card')} from your graveyard on ${part.args[1] === '-1' ? 'the bottom' : 'top'} of your library`,
        ExileFromStack: `Exile ${n === 1 ? 'a' : n} ${part.args[2] || 'spell'}${n === 1 ? '' : 's'} you control from the stack`,
        RevealFromExile: `Reveal ${n === 1 ? 'a' : n} ${desc} from exile`,
        RevealOrChoose: `Reveal a ${desc} card from your hand or choose a ${desc} you control`,
        ExileCtrlOrGrave: `Craft: exile ${n} ${part.args[2] || desc} from among permanents you control and/or cards in your graveyard`,
      };
      const shared = part.type === 'ExileCtrlOrGrave' && /withSharedCardType/.test(part.args[1] || '');
      const cards = await pickCards(game, sa, pool, Math.min(n, 1e6), prompts[part.type] || `${part.type} ${n}`, 'cost' + part.type, shared ? cs => (sharesCardType(game, cs) ? null : 'Those don’t share a card type.') : null);
      if (!cards) return null;
      return { part, cards, n };
    }
  }
}

export async function castingApplyCostPart(game, sa, ch) {
  const pid = sa.controller;
  const p = game.players[pid];
  const paid = sa.root().paid;
  const host = sa.host;
  const part = ch.part;
  const exileAll = async (cards, opts = {}) => { for (const c of cards) { paid.Exiled.push(c); await game.moveCard(c, 'exile', { cause: sa, ...opts }); } };
  switch (part.type) {
    case 'CollectEvidence':
      (paid.Collected = paid.Collected || []).push(...ch.cards);
      await exileAll(ch.cards);
      game.log(`${p.name} collects evidence ${ch.n} (${ch.cards.map(c => game.name(c)).join(', ') || 'nothing'}).`);
      sa.root().evidence = (sa.root().evidence || 0) + ch.n;
      game.fire('CollectEvidence', { Player: pid, Amount: ch.n });
      break;
    case 'Forage':
      if (ch.forage === 'food') for (const c of ch.cards) { paid.Sacrificed.push(game.makeLKI(c)); await game.sacrifice(c, sa); }
      else await exileAll(ch.cards);
      game.log(`${p.name} forages.`);
      game.fire('Forage', { Player: pid });
      break;
    case 'ExileFromTop': await exileAll(ch.cards.filter(c => c.zone === 'library')); break;
    case 'PutCardToLibFromHand': case 'PutCardToLibFromGrave': case 'PutCardToLibFromSameGrave': {
      const pos = part.args[1] === '-1' ? 'bottom' : 'top';
      for (const c of ch.cards) await game.moveCard(c, 'library', { cause: sa, pos });
      game.log(`${p.name} puts ${plural(ch.cards.length, 'card')} on ${pos === 'top' ? 'top' : 'the bottom'} of ${ch.cards.length && ch.cards[0].owner !== pid ? 'its owner\'s' : 'their'} library.`);
      break;
    }
    case 'ExileFromStack': for (const c of ch.cards) { paid.Exiled.push(c); await game.moveCard(c, 'exile', { cause: sa }); } break;
    case 'RevealFromExile': case 'RevealOrChoose':
      for (const c of ch.cards) paid.Revealed.push(c);
      game.log(`${p.name} ${part.type === 'RevealOrChoose' && ch.cards[0] && ch.cards[0].zone === 'battlefield' ? 'chooses' : 'reveals'} ${ch.cards.map(c => game.name(c)).join(', ')}.`);
      break;
    case 'ChooseCreatureType':
      sa.root().chosenType = ch.type;
      if (host && host.isCard) host.chosen = { ...(host.chosen || {}), type: ch.type };
      game.log(`${p.name} chooses ${ch.type}.`);
      break;
    case 'ExileCtrlOrGrave':
      for (const c of ch.cards) { paid.Exiled.push(c.zone === 'battlefield' ? game.makeLKI(c) : c); await game.moveCard(c, 'exile', { cause: sa, exiledWith: host && host.isCard ? host.id : undefined }); }
      break;
    case 'GainLife': for (const pl of ch.players) await game.gainLife(pl, ch.n, sa); break;
  }
  game.touch();
}

export function castingCostLabel(pt) {
  const n = pt.amount;
  switch (pt.type) {
    case 'CollectEvidence': return `collect evidence ${n}`;
    case 'Forage': return 'forage';
    case 'ExileFromTop': return `exile the top ${n === '1' ? 'card' : n + ' cards'} of your library`;
    case 'PutCardToLibFromHand': return `put ${n === '1' ? 'a card' : n + ' cards'} from your hand on ${pt.args[1] === '-1' ? 'the bottom' : 'top'} of your library`;
    case 'PutCardToLibFromGrave': case 'PutCardToLibFromSameGrave': return `put ${n === '1' ? 'a card' : n + ' cards'} from a graveyard on the bottom of the library`;
    case 'ExileFromStack': return `exile ${pt.args[2] || 'a spell'} from the stack`;
    case 'RevealFromExile': return `reveal a card from exile`;
    case 'ChooseCreatureType': return 'choose a creature type';
    case 'RevealOrChoose': return `reveal or choose a ${pt.args[1] || 'card'}`;
    case 'ExileCtrlOrGrave': return `exile ${n} ${pt.args[2] || humanValid(craftValid(pt))}`;
    case 'GainLife': return `${pt.args[2] === '*' ? 'each opponent gains' : 'an opponent gains'} ${n} life`;
  }
  return null;
}

// ---------------------------------------------------------------- effects
export const CASTING_EFFECTS = {
  // tribute N: an opponent of the controller's choice may put N +1/+1 counters on the entering creature
  async Tribute(game, sa) {
    const card = sa.etbCard || sa.host;
    if (!card || !card.isCard) return;
    const n = calcCtx(game, sa.p.Amount || '1', ctxOf(game, sa));
    const pid = card.controller;
    const opps = game.opponents(pid);
    if (!opps.length) return;
    const oid = opps.length === 1 ? opps[0].id : await game.ask(pid, { type: 'player', prompt: `Tribute ${n}: choose an opponent who may put ${plural(n, '+1/+1 counter')} on ${game.name(card)}`, players: opps.map(o => o.id), purpose: 'tributeOpponent', sa, cardId: card.id });
    const opp = opps.find(o => o.id === oid) || opps[0];
    const yes = await game.ask(opp.id, { type: 'confirm', prompt: `Tribute: put ${plural(n, '+1/+1 counter')} on ${game.name(card)}? (If you don't, its "tribute wasn't paid" ability triggers.)`, purpose: 'tribute', sa, cardId: card.id, amount: n });
    if (yes) {
      await game.addCounters(card, 'P1P1', n, sa, { etb: true });
      card.tributed = { zcc: card.zcc };
      game.log(`${opp.name} pays tribute: ${game.name(card)} enters with ${plural(n, '+1/+1 counter')}.`);
    } else game.log(`${opp.name} doesn't pay tribute for ${game.name(card)}.`);
  },

  // amplify N: reveal cards from your hand that share a creature type with it; N +1/+1 counters for each
  async Amplify(game, sa) {
    const card = sa.etbCard || sa.host;
    if (!card || !card.isCard) return;
    const n = calcCtx(game, sa.p.Amount || '1', ctxOf(game, sa));
    const pid = card.controller;
    const me = game.chars(card);
    const myTypes = [...me.subtypes].filter(t => !game.nonCreatureSubtypes.has(t));
    const shares = c => { const ch = game.chars(c); if (!ch.types.has('Creature') && !ch.types.has('Kindred')) return false; if (ch.allCreatureTypes) return myTypes.length > 0 || me.allCreatureTypes; if (me.allCreatureTypes) return [...ch.subtypes].some(t => !game.nonCreatureSubtypes.has(t)); return myTypes.some(t => ch.subtypes.has(t)); };
    const pool = game.players[pid].hand.filter(c => c !== card && shares(c));
    if (!pool.length) return;
    const ids = await game.ask(pid, { type: 'cards', prompt: `Amplify ${n}: reveal any number of cards from your hand that share a creature type with ${game.name(card)} (${plural(n, '+1/+1 counter')} each)`, cards: pool.map(c => c.id), min: 0, max: pool.length, purpose: 'amplify', sa, cardId: card.id });
    const shown = (ids || []).map(id => game.cardById(id)).filter(c => c && pool.includes(c));
    if (!shown.length) return;
    game.log(`${game.players[pid].name} reveals ${shown.map(c => game.name(c)).join(', ')} (amplify).`);
    await game.addCounters(card, 'P1P1', n * shown.length, sa, { etb: true });
  },

  // recover: pay the cost to return this card from your graveyard to your hand; otherwise exile it
  async Recover(game, sa) {
    const c = sa.host;
    if (!c || !c.isCard || c.zone !== 'graveyard') return;
    // "pay half your life, rounded up" (Garza's Assassin: X is the card's own SVar)
    if (/<X\b|\bX\b/.test(sa.p.Cost || '') && sa.svars.X && sa.root().x == null) sa.x = calcCtx(game, 'X', ctxOf(game, sa));
    const paid = await payTriggerCost(game, sa, sa.stackItem);
    if (c.zone !== 'graveyard') return;
    if (paid) { await game.moveCard(c, 'hand', { cause: sa }); game.log(`${game.name(c)} returns to its owner's hand (recover).`); }
    else await game.moveCard(c, 'exile', { cause: sa });
  },

  // ripple N: reveal the top N cards; cast any with the same name without paying their mana costs; the rest go to the bottom
  async Ripple(game, sa) {
    const pid = sa.controller;
    const pl = game.players[pid];
    const n = calcCtx(game, sa.p.Amount || '4', ctxOf(game, sa));
    const top = pl.library.slice(0, n);
    if (!top.length) return;
    const name = sa.host && sa.host.def ? sa.host.def.name : '';
    game.log(`${pl.name} reveals ${top.map(c => game.name(c)).join(', ')} (ripple).`);
    for (const c of top.filter(x => x.def.name === name)) {
      if (c.zone !== 'library') continue;
      const yes = await game.ask(pid, { type: 'confirm', prompt: `Ripple: cast ${game.name(c)} without paying its mana cost?`, purpose: 'castFree', sa, cards: [c.id] });
      if (!yes) continue;
      try { await castSpell(game, pid, c, {}, { free: true, fromEffect: true, effectSA: sa }); } catch (e) { if (!e.cancelled) throw e; }
    }
    for (const c of top) if (c.zone === 'library') await game.moveCard(c, 'library', { pos: 'bottom', silent: true });
  },

  // warp: the delayed exile at the next end step; the owner may cast the card from exile on a later turn
  async WarpExile(game, sa) {
    const zcc = +sa.p.WarpZcc;
    for (const c of sa.delayRemembered || []) {
      if (!c || !c.isCard || c.zone !== 'battlefield' || c.zcc !== zcc) continue;
      const r = await game.moveCard(c, 'exile', { cause: sa });
      if (r && r.zone === 'exile') { r.warped = { turn: game.turnNumber, zcc: r.zcc }; game.touch(); }
    }
  },

  // epic: each upkeep, a copy of the spell (without epic)
  async EpicCopy(game, sa) {
    const e = sa.host;
    if (!e || !e.epicItem) return;
    await copyStackItem(game, e.epicItem, sa.controller, true);
  },

  // paradigm: at the beginning of your first main phase, you may cast a copy of the exiled spell for free
  async ParadigmCast(game, sa) {
    const e = sa.host;
    if (!e || !e.paradigmDef) return;
    const pid = sa.controller;
    const yes = await game.ask(pid, { type: 'confirm', prompt: `Paradigm: cast a copy of ${e.paradigmDef.faces[e.paradigmFace || 0].name} without paying its mana cost?`, purpose: 'castFree', sa });
    if (!yes) return;
    const copy = game.newCard(e.paradigmDef, pid);
    copy.token = true; copy.isSpellCopy = true; copy.zone = 'none'; copy.face = e.paradigmFace || 0;
    let ok = false;
    try { ok = await castSpell(game, pid, copy, {}, { free: true, fromEffect: true, effectSA: sa }); } catch (err) { if (!err.cancelled) throw err; }
    if (!ok && copy.zone === 'none') { copy.zone = 'gone'; game.cards.delete(copy.id); }
  },

  // learn: "you may reveal a Lesson card you own from outside the game" (there's none in Commander) "or discard a card
  // to draw a card"; Retriever Phoenix replaces it with returning to the battlefield from your graveyard
  async Learn(game, sa) {
    const pid = sa.controller;
    const pl = game.players[pid];
    for (const c of [...pl.graveyard]) {
      for (const r of game.chars(c).replacements) {
        const p = r.parsed.p;
        if (p.Event !== 'Learn' || !/Graveyard/.test(p.ActiveZones || 'Graveyard')) continue;
        const ctx = { host: c, you: pid, svars: r.svars };
        if (p.ValidPlayer && !matchValid(game, pl, p.ValidPlayer, ctx)) continue;
        const raw = p.ReplaceWith && r.svars[p.ReplaceWith];
        if (!raw) continue;
        if (p.Optional === 'True' && !(await game.ask(pid, { type: 'confirm', prompt: `${game.name(c)}: ${(p.Description || 'instead of learning, use this?').replace(/CARDNAME/g, game.name(c))}`, purpose: 'replacement', cardId: c.id }))) continue;
        await resolveChain(game, makeSA(game, raw, r.svars, c, pid, { key: 'learn' }));
        return;
      }
    }
    if (!pl.hand.length) return;
    const ids = await game.ask(pid, { type: 'cards', prompt: 'Learn: you may discard a card to draw a card', cards: pl.hand.map(c => c.id), min: 0, max: 1, purpose: 'learnDiscard', sa });
    const c = ids && ids.length ? game.cardById(ids[0]) : null;
    if (!c || c.zone !== 'hand') return;
    await game.discard(c, sa);
    await game.drawCards(pl, 1, sa);
  },
};

// ---------------------------------------------------------------- other hooks
// cascade: "as you cascade, you may put a land card from among the exiled cards onto the battlefield tapped" (Averna)
export async function castingCascadeReplacement(game, sa, pid, exiled) {
  for (const { h, p, ctx } of game.replacementsFor('Cascade')) {
    if (p.ValidPlayer && !matchValid(game, game.players[pid], p.ValidPlayer, ctx)) continue;
    const lands = exiled.filter(c => c.zone === 'exile' && game.chars(c).types.has('Land'));
    if (!lands.length) continue;
    const ids = await game.ask(h.controller, { type: 'cards', prompt: `${game.name(h)}: you may put a land card from among the exiled cards onto the battlefield tapped`, cards: lands.map(c => c.id), min: 0, max: 1, purpose: 'searchBattlefield', sa });
    const c = ids && ids.length ? game.cardById(ids[0]) : null;
    if (c && lands.includes(c)) await game.moveCard(c, 'battlefield', { controller: pid, tapped: true, cause: sa });
  }
}

// adapt: "adapts as though it had no +1/+1 counters on it" (Biomancer's Familiar)
export function castingCanAdapt(game, card) {
  return game.activeStatics('CanAdapt').some(s => matchValid(game, card, s.p.ValidCard || 'Card', s.ctx));
}

// "this spell can't be copied"
export function castingCantBeCopied(game, item) {
  return !!item.card && game.activeStatics('CantBeCopied').some(s => matchValid(game, item.card, s.p.ValidCard || 'Card.Self', { ...s.ctx, host: s.host }));
}

// "spend only mana produced by basic lands / creatures to cast this spell", "you can't spend mana to cast this spell"
export function castingManaRestriction(game, card) {
  if (!card || !card.isCard) return null;
  const sts = card.faceDef.statics.map(s => parseAbility(s).p).filter(p => p.Mode === 'ManaRestriction');
  if (!sts.length) return null;
  return src => sts.every(p => {
    const ok = matchValid(game, src, p.ValidSource || 'Card', { host: card, you: card.controller != null ? card.controller : card.owner });
    return p.InvertValidSource === 'True' ? !ok : ok;
  });
}

// "spend only colored mana on X; no more than one mana of each color may be spent this way" (Emblazoned Golem): X is
// paid with X different colors — the first set of colors (in WUBRG order) that can be paid
function coloredX(card) { return !!card && card.faceDef.keywords.some(k => /^Spend only colored mana on X/.test(k)); }
function colorSets(n) {
  const out = [];
  const rec = (i, cur) => { if (cur.length === n) { out.push(cur.slice()); return; } for (let j = i; j < COLORS.length; j++) { cur.push(COLORS[j]); rec(j + 1, cur); cur.pop(); } };
  rec(0, []);
  return out;
}
function withColors(mana, colors) { const m = cloneCost(mana); m.x = 0; for (const c of colors) m.colored[c] = (m.colored[c] || 0) + 1; return m; }
export function castingXCost(game, pid, card, mana, x) {
  if (!coloredX(card)) return null;
  for (const set of colorSets(Math.min(5, x))) { const m = withColors(mana, set); if (canAfford(game, pid, m, { spellCard: card, exclude: new Set([card.id]) })) return m; }
  return withColors(mana, COLORS.slice(0, Math.min(5, x)));
}
export function castingMaxX(game, pid, card, mana, max) {
  if (!coloredX(card)) return max;
  let best = 0;
  for (let x = 1; x <= Math.min(5, max); x++) if (colorSets(x).some(set => canAfford(game, pid, withColors(mana, set), { spellCard: card, exclude: new Set([card.id]) }))) best = x;
  return best;
}

// abilities of the top card of your library: "you may plot nonland cards from the top of your library" (Fblthp)
export function castingLibraryActivation(game, pid, card, abil) {
  if (abil.parsed.api !== 'Plot' || card.owner !== pid) return false;
  const top = game.players[pid].library[0];
  if (top !== card) return false;
  return game.activeStatics('PlotZone').some(s => s.ctx.you === pid && matchValid(game, card, s.p.ValidCard || 'Card.TopLibrary+YouCtrl', s.ctx));
}

// "while you're searching your library, you may cast CARDNAME from your library" (Panglacial Wurm)
export async function castingWhileSearching(game, sa, pid) {
  const pl = game.players[pid];
  for (const c of pl.library.filter(x => x.faceDef.keywords.includes("While you're searching your library, you may cast CARDNAME from your library."))) {
    if (c.zone !== 'library') continue;
    const cost = c.faceDef.manaCost;
    if (!cost || !canAfford(game, pid, cost, { spellCard: c, exclude: new Set([c.id]) })) continue;
    const yes = await game.ask(pid, { type: 'confirm', prompt: `While you're searching your library, cast ${game.name(c)} from it?`, purpose: 'castFromSearch', sa, cards: [c.id] });
    if (!yes) continue;
    try { await castSpell(game, pid, c, {}, { fromEffect: true, effectSA: sa }); } catch (e) { if (!e.cancelled) throw e; }
  }
}

