// Classic mechanics, the pure part (the effects and turn-level hooks are in mech-classic.js): keyword definitions
// (Soulshift, Modular, Fading, Haunt, Ingest, Phasing, Aura swap), filter properties, trigger matching and the
// "can't ..." / "ignore ..." static checks. It only imports filters.js and nothing here runs at load, so any engine
// module (keywords.js, filters.js, triggers.js) can import it without import-order trouble.
import { matchValid, resolveDefined, calcCtx, zoneMap } from './filters.js';

// ---------------------------------------------------------------- keywords (keywords.js defFor)
// Fills A / T / R / S (activated abilities, triggers, replacements, svars) like defFor does; true when handled.
export function classicKeywordDef(name, parts, face, A, T, R, S) {
  const a = parts[1];
  const etbSelf = 'Mode$ ChangesZone | Origin$ Any | Destination$ Battlefield | ValidCard$ Card.Self';
  const diesSelf = 'Mode$ ChangesZone | Origin$ Battlefield | Destination$ Graveyard | ValidCard$ Card.Self';
  // "CARDNAME enters with N [kind] counters on it" (modular, fading)
  const etbCounters = (key, type, n, desc) => {
    R.push(`Event$ Moved | ValidCard$ Card.Self | Destination$ Battlefield | ReplacementResult$ Updated | ReplaceWith$ ${key} | Description$ ${desc}`);
    S[key] = `DB$ PutCounter | Defined$ Self | CounterType$ ${type} | CounterNum$ ${n} | ETB$ True`;
  };
  switch (name) {
    // Soulshift N: when this dies, you may return target Spirit card with mana value N or less from your graveyard to your hand
    case 'Soulshift':
      T.push(`${diesSelf} | OptionalDecider$ You | Execute$ KWSoulshift | TriggerDescription$ Soulshift ${a} — you may return target Spirit card with mana value ${a} or less from your graveyard to your hand`);
      S.KWSoulshift = `DB$ ChangeZone | Origin$ Graveyard | Destination$ Hand | ValidTgts$ Spirit.YouOwn+cmcLE${a} | TgtPrompt$ Select target Spirit card with mana value ${a} or less in your graveyard`;
      return true;
    // Modular N: enters with N +1/+1 counters; when it dies, you may put its +1/+1 counters on target artifact creature
    // ("Modular—Sunburst": one for each color of mana spent to cast it)
    case 'Modular':
      etbCounters('KWModularETB', 'P1P1', a === 'Sunburst' ? 'KWModularSun' : a, `Modular ${a === 'Sunburst' ? '— Sunburst' : a}`);
      if (a === 'Sunburst') S.KWModularSun = 'Count$Converge';
      T.push(`${diesSelf} | OptionalDecider$ You | Execute$ KWModular | TriggerDescription$ Modular — when CARDNAME dies, you may put a +1/+1 counter on target artifact creature for each +1/+1 counter on CARDNAME`);
      S.KWModular = 'DB$ PutCounter | ValidTgts$ Artifact.Creature | TgtPrompt$ Select target artifact creature | CounterType$ P1P1 | CounterNum$ KWModularX';
      S.KWModularX = 'TriggeredCard$CardCounters.P1P1';
      return true;
    // Fading N: enters with N fade counters; at the beginning of your upkeep, remove one, and if you can't, sacrifice it
    case 'Fading':
      etbCounters('KWFadingETB', 'FADE', a, `Fading ${a}`);
      T.push('Mode$ Phase | Phase$ Upkeep | ValidPlayer$ You | TriggerZones$ Battlefield | Execute$ KWFading | TriggerDescription$ Fading — remove a fade counter from CARDNAME. If you can\'t, sacrifice it.');
      S.KWFading = 'DB$ FadingUpkeep';
      return true;
    // Ingest: whenever this deals combat damage to a player, that player exiles the top card of their library
    case 'Ingest':
      T.push('Mode$ DamageDone | ValidSource$ Card.Self | ValidTarget$ Player | CombatDamage$ True | TriggerZones$ Battlefield | Execute$ KWIngest | TriggerDescription$ Ingest — that player exiles the top card of their library');
      S.KWIngest = 'DB$ IngestExile';
      return true;
    // Haunt: a creature's ability also works when it enters; when it dies (or, for an instant or sorcery, after it
    // resolves: mech-classic.js), exile it haunting target creature, and the ability works again when that creature dies
    case 'Haunt': {
      const exec = a;
      if (!face.svars || !face.svars[exec]) return true;
      const what = (String(face.svars[exec]).match(/SpellDescription\$ ([^|]+)/) || [])[1] || 'its haunt ability';
      if ((face.types || []).includes('Creature')) {
        T.push(`${etbSelf} | Execute$ ${exec} | TriggerDescription$ When CARDNAME enters or the creature it haunts dies, ${what.trim()}`);
        T.push(`${diesSelf} | Execute$ KWHauntExile | TriggerDescription$ Haunt — exile CARDNAME haunting target creature`);
        S.KWHauntExile = 'DB$ HauntExile | ValidTgts$ Creature | TgtPrompt$ Choose target creature to haunt';
      }
      return true;
    }
    // Aura swap [cost]: exchange this Aura with an Aura card in your hand
    case 'Aura swap': {
      const cost = parts.slice(1).join(':');
      A.push(`AB$ AuraSwap | Cost$ ${cost} | SpellDescription$ Aura swap (exchange this Aura with an Aura card in your hand)`);
      return true;
    }
    // handled elsewhere: phasing in the untap step; the rest only matter outside a Commander game
    case 'Phasing': case 'MayEffectFromOpeningDeck': case 'DeckLimit': case 'A deck can have any number of cards named CARDNAME.':
      return true;
    default: return false;
  }
}

export const CLASSIC_KEYWORDS = ['Soulshift', 'Modular', 'Fading', 'Haunt', 'Ingest', 'Phasing', 'Aura swap', 'MayEffectFromOpeningDeck', 'DeckLimit', 'A deck can have any number of cards named CARDNAME.'];

// a Haunt instant or sorcery has no spell ability of its own: the spell is its haunt ability (cards.js FaceDef)
export function hauntSpellAbilities(raw) {
  const hk = (raw.K || []).find(k => /^Haunt:/.test(k));
  if (!hk || !/\b(Instant|Sorcery)\b/.test(raw.types || '') || (raw.A || []).some(x => /^SP\$/.test(x))) return raw.A;
  const sv = raw.svars[hk.split(':')[1]];
  return sv ? [sv.replace(/^DB\$/, 'SP$'), ...raw.A] : raw.A;
}

// ---------------------------------------------------------------- phasing in filters (filters.js matchCard)
// A phased-out permanent is treated as though it doesn't exist: it matches nothing unless the filter asks for phased-out
// things ("Card.phasedOutIsRemembered", "Card.phasedOutSelf"), and then the rest of that property applies. Returns the
// properties to check, or null for no match.
export function phasedOutProps(props) {
  if (!props.some(p => p.startsWith('phasedOut'))) return null;
  return props.map(p => (p.startsWith('phasedOut') ? p.slice(9) : p));
}

// ---------------------------------------------------------------- card / player properties and counts (filters.js)
// Arabian Nights ("a name originally printed in the Arabian Nights expansion": City in a Bottle)
const ARABIAN_NIGHTS = new Set(['Abu Ja\'far', 'Aladdin', 'Aladdin\'s Lamp', 'Aladdin\'s Ring', 'Ali Baba', 'Ali from Cairo', 'Army of Allah', 'Bazaar of Baghdad', 'Bird Maiden', 'Bottle of Suleiman', 'Brass Man', 'Camel', 'City in a Bottle', 'City of Brass', 'Cuombajj Witches', 'Cyclone', 'Dancing Scimitar', 'Dandân', 'Desert', 'Desert Nomads', 'Desert Twister', 'Diamond Valley', 'Drop of Honey', 'Ebony Horse', 'El-Hajjâj', 'Elephant Graveyard', 'Erg Raiders', 'Erhnam Djinn', 'Eye for an Eye', 'Fishliver Oil', 'Flying Carpet', 'Flying Men', 'Ghazbán Ogre', 'Giant Tortoise', 'Guardian Beast', 'Hasran Ogress', 'Hurr Jackal', 'Ifh-Bíff Efreet', 'Island Fish Jasconius', 'Island of Wak-Wak', 'Jandor\'s Ring', 'Jandor\'s Saddlebags', 'Jeweled Bird', 'Jihad', 'Junún Efreet', 'Juzám Djinn', 'Khabál Ghoul', 'King Suleiman', 'Kird Ape', 'Library of Alexandria', 'Magnetic Mountain', 'Merchant Ship', 'Metamorphosis', 'Mijae Djinn', 'Moorish Cavalry', 'Nafs Asp', 'Oasis', 'Old Man of the Sea', 'Oubliette', 'Piety', 'Pyramids', 'Repentant Blacksmith', 'Ring of Ma\'rûf', 'Rukh Egg', 'Sandals of Abdallah', 'Sandstorm', 'Serendib Djinn', 'Serendib Efreet', 'Shahrazad', 'Sindbad', 'Singing Tree', 'Sorceress Queen', 'Stone-Throwing Devils', 'Unstable Mutation', 'War Elephant', 'Wyluli Wolf', 'Ydwen Efreet']);

export const CLASSIC_CARD_PROPS = new Set(['HauntedBy', 'DamagedBy', 'setARN', 'NamedCard', 'IsSuspected', 'phasedOut', 'phasedOutSelf', 'phasedOutCreature', 'phasedOutPermanent']);
export function classicCardProp(game, card, ch, prop, ctx) {
  const host = ctx.host;
  switch (prop) {
    // the creature this haunter (or its haunt effect) haunts
    case 'HauntedBy': { const h = host && (host.haunting || (host.hostCard && host.hostCard.haunting)); return !!h && h.id === card.id && h.zcc === card.zcc; }
    // dealt damage by the source this turn (Bone Shaman)
    case 'DamagedBy': return !!host && game.turnState.damageLog.some(e => e.card === card.id && e.source === host.id);
    case 'setARN': return ARABIAN_NIGHTS.has(ch.name || card.def.name);
    case 'NamedCard': return !!host && !!host.chosen && !!host.chosen.name && host.chosen.name === ch.name;
    case 'IsSuspected': return !!card.suspected;
    // (a phased-out permanent's "phasedOut..." properties were already turned into the plain ones by phasedOutProps)
    default: return false;
  }
}
// "Creature.DamagedBy Remembered" (Runesword): dealt damage this turn by one of those
export function classicCardPropArg(game, card, prop, ctx) {
  const m = prop.match(/^DamagedBy (.+)$/);
  if (!m) return undefined;
  const srcs = resolveDefined(game, m[1], ctx).filter(o => o && !o.isPlayer).map(o => o.id);
  return game.turnState.damageLog.some(e => e.card === card.id && srcs.includes(e.source));
}

export const CLASSIC_PLAYER_PROPS = new Set(['VenturedThisTurn', 'withMoreLandsThanYou']);
export function classicPlayerProp(game, p, prop, ctx) {
  switch (prop) {
    case 'VenturedThisTurn': return p.venturedTurn === game.turnNumber;
    case 'withMoreLandsThanYou': {
      const lands = pid => game.battlefield.filter(c => c.controller === pid && !c.phasedOut && game.chars(c).types.has('Land')).length;
      return lands(p.id) > lands(ctx.you);
    }
    default: return false;
  }
}

// counts: "Count$YouFlipThisTurn", "Count$ThisTurnActivated_Activated.Exhaust+YouCtrl"; undefined when not ours
export function classicCount(game, rest, ctx) {
  if (rest === 'YouFlipThisTurn') return ((game.turnState.coinFlips || {})[ctx.you]) || 0;
  let m = rest.match(/^ThisTurnActivated_(.+)$/);
  if (m) return (game.turnState.activations || []).filter(e => abilityMatches(game, e, m[1], ctx)).length;
  // "for each {B} or {R} spent this way" (Balduvian Fallen's cumulative upkeep)
  if ((m = rest.match(/^TriggeredPayingMana\.(.+)$/))) {
    const t = (ctx && (ctx.trig || (ctx.sa && ctx.sa.trig))) || {};
    const spent = t.PayingMana || {};
    return m[1].split('.').reduce((a, c) => a + (spent[c] || 0), 0);
  }
  return undefined;
}

// an activated ability against "Activated.Boast", "Activated.Exhaust+YouCtrl", "Activated.PowerUp": e = { card, p, controller }
export function abilityMatches(game, e, spec, ctx) {
  return String(spec).split(',').some(alt => {
    const [type, rest] = alt.trim().split(/\.(.*)/s);
    if (type !== 'Activated' && type !== 'SpellAbility' && type !== 'Card') return false;
    return (rest ? rest.split('+') : []).every(pr => {
      const neg = pr.startsWith('!'); const q = neg ? pr.slice(1) : pr;
      let r;
      if (q === 'YouCtrl') r = e.controller === ctx.you;
      else if (q === 'OppCtrl') r = game.isOpponent(e.controller, ctx.you);
      else if (q === 'ManaAbility') r = e.api === 'Mana';
      else r = !!e.p[q] && e.p[q] !== 'False';
      return neg ? !r : r;
    });
  });
}

// ---------------------------------------------------------------- trigger modes (triggers.js)
export const CLASSIC_TRIGGER_MODES = ['PhaseIn', 'PhaseOut', 'PayCumulativeUpkeep', 'PayEcho'];
export function classicTriggerMatches(game, p, rp, vc) {
  switch (rp.Mode) {
    case 'PhaseIn': return vc(rp.Card, p.ValidCard);
    // fired just before it phases out (a phased-out permanent's triggers wouldn't see it): "Card.phasedOutSelf" is itself
    case 'PhaseOut': return vc(rp.Card, p.ValidCard && p.ValidCard.replace(/phasedOut/g, ''));
    case 'PayCumulativeUpkeep': case 'PayEcho':
      if (!vc(rp.Card, p.ValidCard)) return false;
      return p.Paid == null || (p.Paid === 'True') === !!rp.Paid;
    default: return false;
  }
}

// ---------------------------------------------------------------- static abilities
export const CLASSIC_STATIC_MODES = ['CantRegenerate', 'CantPlayLand', 'CantAttach', 'CantTransform', 'CantDiscard', 'CantGainControl', 'CantBeSuspected', 'CantBecomeMonarch', 'CantVenture', 'CantPayLife', 'CantPhaseOut', 'IgnoreHexproof', 'IgnoreShroud', 'MustTarget', 'Activations', 'IgnorePlaneswalkerZeroLoyaltyRule', 'FlipCoinMod', 'ManaBurn'];
export const CLASSIC_REPLACEMENT_EVENTS = ['Destroy', 'PayLife'];

const statics = (game, mode) => game.activeStatics(mode);
const zoneIs = (spec, zone) => spec.split(',').map(z => zoneMap[z.trim()] || z.trim().toLowerCase()).includes(zone);

// what a spell or ability is, for "ValidCause$ Spell,Activated.!ManaAbility" and "ValidSA$ Spell.OppCtrl"
export function causeMatches(game, sa, spec, ctx) {
  if (!sa) return false;
  const root = sa.root ? sa.root() : sa;
  return String(spec).split(',').some(alt => {
    const [type, rest] = alt.trim().split(/\.(.*)/s);
    const isSpell = !!(root.isSpell || (root.stackItem && root.stackItem.kind === 'spell'));
    const isTrig = !!(root.isTrigger || sa.isTrigger);
    const isMana = root.api === 'Mana' || root.api === 'ManaReflected';
    if (type === 'Spell' && !isSpell) return false;
    if (type === 'Activated' && (isSpell || isTrig)) return false;
    if (type === 'Triggered' && !isTrig) return false;
    return (rest ? rest.split('+') : []).every(pr => {
      const neg = pr.startsWith('!'); const q = neg ? pr.slice(1) : pr;
      let r = true;
      if (q === 'OppCtrl') r = game.isOpponent(root.controller, ctx.you);
      else if (q === 'YouCtrl') r = root.controller === ctx.you;
      else if (q === 'ManaAbility') r = isMana;
      return neg ? !r : r;
    });
  });
}

export const cantRegenerate = (game, card) => statics(game, 'CantRegenerate').some(s => matchValid(game, card, s.p.ValidCard || 'Card', s.ctx));
export const cantPhaseOut = (game, card) => statics(game, 'CantPhaseOut').some(s => matchValid(game, card, s.p.ValidCard || 'Card', s.ctx));
export const cantPhaseIn = (game, card) => statics(game, 'CantPhaseIn').some(s => matchValid(game, card, s.p.ValidCard || 'Card.phasedOut', s.ctx));
export const cantTransform = (game, card) => statics(game, 'CantTransform').some(s => matchValid(game, card, s.p.ValidCard || 'Card', s.ctx));
export const cantGainControl = (game, card) => statics(game, 'CantGainControl').some(s => matchValid(game, card, s.p.ValidCard || 'Card', s.ctx));
export const cantBeSuspected = (game, card) => statics(game, 'CantBeSuspected').some(s => matchValid(game, card, s.p.ValidCard || 'Card', s.ctx));
export const cantBecomeMonarch = (game, pid) => pid != null && statics(game, 'CantBecomeMonarch').some(s => matchValid(game, game.players[pid], s.p.ValidPlayer || 'Player', s.ctx));
export const cantVenture = (game, pid) => statics(game, 'CantVenture').some(s => matchValid(game, game.players[pid], s.p.ValidPlayer || 'Player', s.ctx));
export const ignoresZeroLoyalty = (game, card) => statics(game, 'IgnorePlaneswalkerZeroLoyaltyRule').some(s => matchValid(game, card, s.p.ValidCard || 'Planeswalker', s.ctx));
export const manaBurns = (game, pid) => statics(game, 'ManaBurn').some(s => !s.p.ValidPlayer || matchValid(game, game.players[pid], s.p.ValidPlayer, s.ctx));

// the static that stops pid playing this land now (Aggressive Mining, Moonhold, City in a Bottle, Experimental Frenzy)
export function cantPlayLand(game, pid, card) {
  for (const s of statics(game, 'CantPlayLand')) {
    if (s.p.Player && !matchValid(game, game.players[pid], s.p.Player, s.ctx)) continue;
    if (s.p.ValidCard && !(card && matchValid(game, card, s.p.ValidCard, s.ctx))) continue;
    if (s.p.Origin && !(card && zoneIs(s.p.Origin, card.zone))) continue;
    return s;
  }
  return null;
}

// "can't be attached to" / "can't be enchanted": attaching `attach` to `target` (a card or player) isn't allowed
export function cantAttach(game, attach, target) {
  if (!attach || !target) return false;
  for (const s of statics(game, 'CantAttach')) {
    if (s.p.ValidCard && !matchValid(game, attach, s.p.ValidCard, s.ctx)) continue;
    if (s.p.Target && !matchValid(game, target, s.p.Target, s.ctx)) continue;
    if (s.p.ValidCardToTarget) {
      // "Aura.!Attached": a new Aura; one already attached to it stays (Guardian Beast)
      if (target.isPlayer) continue;
      const spec = s.p.ValidCardToTarget;
      if (/!Attached/.test(spec) && attach.attachedTo === target.id) continue;
      if (!matchValid(game, attach, spec.replace(/\+?!Attached/g, '').replace(/\.$/, ''), s.ctx)) continue;
    }
    if (s.p.Exceptions && matchValid(game, attach, s.p.Exceptions, s.ctx)) continue;
    return true;
  }
  return false;
}

// "Spells and abilities your opponents control can't cause you to discard cards" (Tamiyo)
export function cantDiscard(game, pid, cause, forCost) {
  return statics(game, 'CantDiscard').some(s => {
    if (!matchValid(game, game.players[pid], s.p.ValidPlayer || 'Player', s.ctx)) return false;
    if (s.p.ForCost && (s.p.ForCost === 'True') !== !!forCost) return false;
    if (s.p.ValidCause && !causeMatches(game, cause, s.p.ValidCause, s.ctx)) return false;
    return true;
  });
}

// can't pay life (Angel of Jubilation, Karn's Sylex, Yasharn), and anyone who can't lose life can't pay it either
export function cantPayLife(game, pid, cause, forCost = true) {
  const p = game.players[pid];
  for (const mode of ['CantPayLife', 'CantLoseLife', 'CantChangeLife']) {
    for (const s of statics(game, mode)) {
      if (!matchValid(game, p, s.p.ValidPlayer || 'You', s.ctx)) continue;
      if (mode === 'CantPayLife') {
        if (s.p.ForCost && (s.p.ForCost === 'True') !== !!forCost) continue;
        if (s.p.ValidCause && !causeMatches(game, cause, s.p.ValidCause, s.ctx)) continue;
      }
      return true;
    }
  }
  return false;
}

// life a player may pay for Phyrexian mana in a spell's or ability's cost (none while they can't pay life for costs)
export function lifeForMana(game, pid) {
  const p = game.players[pid];
  const blocked = ['CantPayLife', 'CantLoseLife', 'CantChangeLife'].some(mode => statics(game, mode).some(s => matchValid(game, p, s.p.ValidPlayer || 'You', s.ctx) && (mode !== 'CantPayLife' || s.p.ForCost !== 'False')));
  return blocked ? 0 : p.life - 1;
}

// as though it didn't have hexproof / shroud (Glaring Spotlight, Kaya, Detection Tower, Autumn Willow)
export function ignoresHexproof(game, obj, sa, mode = 'IgnoreHexproof') {
  return statics(game, mode).some(s => (!s.p.Activator || matchValid(game, game.players[sa.controller], s.p.Activator, s.ctx)) && (!s.p.ValidEntity || matchValid(game, obj, s.p.ValidEntity, s.ctx)));
}

// "must choose at least one Flagbearer on the battlefield if able" (Coalition Flag, Standard Bearer): the kinds still
// to be satisfied for this spell or ability
export function mustTargetKinds(game, root) {
  if (!root || !(root.isSpell || root.isActivated) || root.isCopy) return [];
  const out = [];
  for (const s of statics(game, 'MustTarget')) {
    if (s.p.ValidSA && !causeMatches(game, root, s.p.ValidSA, s.ctx)) continue;
    const kind = { type: s.p.ValidTarget, zone: zoneMap[s.p.ValidZone] || (s.p.ValidZone || 'battlefield').toLowerCase() };
    if (!out.some(k => k.type === kind.type && k.zone === kind.zone)) out.push(kind);
  }
  return out;
}
export const fitsKind = (game, o, k) => !!o && o.isCard && o.zone === k.zone && matchValid(game, o, k.type, { you: null });

// the result of a coin flip fixed by a static ("those coins come up heads": Edgar), or null
export function flipCoinFixed(game, pid) {
  const s = statics(game, 'FlipCoinMod').find(x => matchValid(game, game.players[pid], x.p.ValidPlayer || 'You', x.ctx));
  return s ? s.p.Result !== 'False' : null;
}

// how many times this activated ability may be activated (boast: once each turn; exhaust and power-up: once), raised by
// "Activations" statics (Birgi, Elvish Refueler, Wonder Man). null when it has no such limit.
export function activationLimit(game, pid, card, abil) {
  const p = abil.parsed.p;
  if (!(p.Boast || p.Exhaust || p.PowerUp)) return null;
  let limit = 1, extra = 0;
  const e = { card, p, controller: pid, api: abil.parsed.api };
  for (const s of statics(game, 'Activations')) {
    if (s.p.ValidCard && !matchValid(game, card, s.p.ValidCard, s.ctx)) continue;
    if (s.p.ValidSA && !abilityMatches(game, e, s.p.ValidSA, s.ctx)) continue;
    if (s.p.ValidPlayer && !matchValid(game, game.players[pid], s.p.ValidPlayer, s.ctx)) continue;
    if (s.p.PlayerTurn === 'You' && game.activePlayer !== s.ctx.you) continue;
    if (s.p.MinLimit) { const min = calcCtx(game, s.p.MinLimit, s.ctx); if (min === -1) return Infinity; limit = Math.max(limit, min); }
    if (s.p.Additional) extra += calcCtx(game, s.p.Additional, s.ctx);
  }
  return limit + extra;
}
