// Mode-specific trigger matching against event run-params.
import { matchValid, ctrlOf, resolveDefined, matchCastSA } from './filters.js';
import { normalizeCounter } from './game.js';
import { UNSETS_TRIGGER_MODES, unsetsTriggerMatches } from './mech-unsets-rules.js';
import { triggerExt } from './ext.js';
import { NEWSETS_TRIGGER_MODES, triggerMatches as newsetsTriggerMatches } from './mech-newsets.js';

function vc(game, obj, valid, ctx) {
  if (!valid) return true;
  if (obj == null) return false;
  return matchValid(game, obj, valid, ctx);
}

function zoneIn(spec, zone) {
  if (!spec || spec === 'Any') return true;
  return spec.split(',').map(s => s.trim()).includes(zone);
}

function playerObj(game, id) { return id == null ? null : (typeof id === 'object' ? id : game.players[id]); }

export const SUPPORTED_TRIGGER_MODES = new Set(['ChangesZone', 'ChangesZoneAll', 'Phase', 'Attacks', 'AttackersDeclared', 'AttackersDeclaredOneTarget', 'SpellCast', 'SpellCastOrCopy', 'AbilityCast', 'SpellAbilityCast', 'DamageDone', 'DamageDoneOnce', 'DamageDealtOnce', 'DamageAll', 'Drawn', 'Sacrificed', 'Destroyed', 'LifeGained', 'LifeLost', 'LifeLostAll', 'TapsForMana', 'Cycled', 'Discarded', 'DiscardedAll', 'BecomesTarget', 'BecomesTargetOnce', 'Taps', 'Untaps', 'Blocks', 'AttackerBlocked', 'AttackerBlockedByCreature', 'AttackerUnblocked', 'AttackerUnblockedOnce', 'CounterAdded', 'CounterAddedOnce', 'CounterRemoved', 'LandPlayed', 'Always', 'TokenCreated', 'TokenCreatedOnce', 'TurnBegin', 'Milled', 'MilledAll', 'Exiled', 'LosesGame', 'BecomeMonarch', 'TakesInitiative', 'RoomEntered', 'DungeonCompleted', 'Explores', 'Connives', 'Surveil', 'Scry', 'Investigated', 'Fight', 'Attached', 'Unattached', 'ChangesController', 'Transformed', 'SpellCopy', 'BecomesCrewed', 'TurnFaceUp', 'Mutates', 'BecomeMonstrous', 'Evolved', 'CommitCrime', 'FlippedCoin', 'RolledDie', 'RolledDieOnce', 'Exploited', 'AbilityTriggered', 'AbilityResolves', 'CounterPlayerAddedAll', 'ManaAdded',
  'ClassLevelGained', 'Clashed', 'DamagePrevented', 'DamagePreventedOnce', 'GiveGift', 'UnlockDoor', 'FullyUnlock', 'ManaExpend', 'Exerted', 'Vote', 'BecomeRenowned', 'MilledOnce', 'Shuffled', 'CounterTypeAddedAll', 'CounterRemovedOnce', 'SearchedLibrary', 'PhaseOutAll']);
// Un-sets (mech-unsets.js): stickers and Attractions
for (const m of UNSETS_TRIGGER_MODES) SUPPORTED_TRIGGER_MODES.add(m);
// casting (mech-casting.js): plotting, foretelling, collecting evidence, foraging, adapting, copies of spells and abilities
for (const m of ['BecomesPlotted', 'Foretell', 'CollectEvidence', 'Forage', 'Adapt', 'SpellAbilityCopy']) SUPPORTED_TRIGGER_MODES.add(m);
// new sets (mech-newsets.js): bending, day/night, the Ring, and the "one or more" batch triggers
for (const m of NEWSETS_TRIGGER_MODES) SUPPORTED_TRIGGER_MODES.add(m);
// combat (mech-combat.js): blocks, excess damage, crew / saddle / enlist
for (const m of ['AttackerBlockedOnce', 'BlockersDeclared', 'ExcessDamage', 'ExcessDamageAll', 'Crewed', 'Saddled', 'BecomesSaddled', 'Enlisted']) SUPPORTED_TRIGGER_MODES.add(m);

export function triggerMatches(game, p, host, rp, ctx) {
  const mode = rp.Mode;
  switch (mode) {
    case 'ChangesZone': {
      if (!zoneIn(p.Origin, rp.Origin)) return false;
      if (!zoneIn(p.Destination, rp.Destination)) return false;
      if (p.ExcludedDestinations && p.ExcludedDestinations.split(',').includes(rp.Destination)) return false;
      const obj = rp.Origin === 'Battlefield' && rp.CardLKI ? rp.CardLKI : rp.Card;
      if (p.ValidCard && !vc(game, obj, p.ValidCard, ctx)) return false;
      if (p.ValidCause) return false;
      // "sacrifice it unless {W} was spent to cast it" (Court Hussar, Patagia Viper, Plaxmanta)
      if (p.ManaNotSpent && p.ManaNotSpent.split(/\s+/).every(c => ((obj && obj.manaSpent) || {})[c] > 0)) return false;
      if (p.Evolve) {
        const me = game.chars(host), it = obj.lki ? obj.chars : game.chars(obj);
        if (!(it.power > me.power || it.toughness > me.toughness)) return false;
      }
      return true;
    }
    case 'ChangesZoneAll': {
      if (!zoneIn(p.Origin, rp.Origin)) return false;
      if (!zoneIn(p.Destination, rp.Destination)) return false;
      const list = (rp.Origin === 'Battlefield' ? rp.CardsLKI : rp.Cards) || [];
      const matching = list.filter(c => c && vc(game, c, p.ValidCards || p.ValidCard, ctx));
      if (!matching.length) return false;
      rp.Amount = matching.length;
      rp.Cards = matching;
      return true;
    }
    case 'Phase': {
      const phases = (p.Phase || '').split(',').map(s => s.trim());
      // "at the beginning of your second main phase" (Phase$ Main | PhaseCount$ 2)
      const mainN = rp.Phase === 'Main1' ? 1 : rp.Phase === 'Main2' ? 2 : 0;
      if (!phases.includes(rp.Phase) && !(phases.includes('Main') && mainN && (!p.PhaseCount || +p.PhaseCount === mainN))) return false;
      if (p.ValidPlayer && !vc(game, playerObj(game, rp.Player), p.ValidPlayer, ctx)) return false;
      return true;
    }
    case 'TurnBegin': return !p.ValidPlayer || vc(game, playerObj(game, rp.Player), p.ValidPlayer, ctx);
    case 'Attacks': {
      if (!vc(game, rp.Attacker, p.ValidCard, ctx)) return false;
      if (p.Alone === 'True' && rp.AttackerCount !== 1) return false;
      if (p.Attacked) {
        const def = rp.DefenderCard ? rp.DefenderCard : playerObj(game, rp.DefendingPlayer);
        if (!vc(game, def, p.Attacked.replace('Player.Defending', 'Player'), ctx)) return false;
      }
      if (p.ValidDefender && !vc(game, playerObj(game, rp.DefendingPlayer), p.ValidDefender, ctx)) return false;
      if (p.FirstAttack === 'True' && !rp.FirstAttack) return false;
      // "if it's the first combat phase of the turn" (Finest Hour, Hexplate Wallbreaker: else endless combats)
      if (p.FirstCombat === 'True' && (game.combatsThisTurn || 1) > 1) return false;
      return true;
    }
    case 'AttackersDeclared': case 'AttackersDeclaredOneTarget': {
      if (p.AttackingPlayer && !vc(game, playerObj(game, rp.AttackingPlayer), p.AttackingPlayer, ctx)) return false;
      if (p.ValidAttackers) {
        const n = (rp.Attackers || []).filter(a => vc(game, a, p.ValidAttackers, ctx)).length;
        const need = p.ValidAttackersAmount || 'GE1';
        const m = need.match(/^(EQ|NE|LT|LE|GT|GE)(\d+)$/);
        if (m) { const v = +m[2]; if (!({ EQ: n === v, NE: n !== v, LT: n < v, LE: n <= v, GT: n > v, GE: n >= v })[m[1]]) return false; }
        else if (!n) return false;
      }
      if (p.AttackedTarget) {
        if (mode === 'AttackersDeclaredOneTarget') { if (!vc(game, playerObj(game, rp.DefendingPlayer), p.AttackedTarget, ctx)) return false; }
        else if (!(rp.Defenders || []).some(d => vc(game, playerObj(game, d), p.AttackedTarget, ctx))) return false;
      }
      return true;
    }
    case 'SpellCast': case 'SpellCastOrCopy': case 'SpellCopy': case 'AbilityCast': case 'SpellAbilityCast': {
      const isSpell = !!rp.IsSpell;
      if ((mode === 'SpellCast' || mode === 'SpellCastOrCopy' || mode === 'SpellCopy') && !isSpell) return false;
      if (mode === 'AbilityCast' && isSpell) return false;
      if (p.ValidCard && !vc(game, rp.Card, p.ValidCard, ctx)) return false;
      if (p.ValidActivatingPlayer && !vc(game, playerObj(game, rp.Player), p.ValidActivatingPlayer, ctx)) return false;
      if (p.ValidSA && !validSA(game, rp, p.ValidSA, ctx)) return false;
      if (p.ValidSAonCard && !validSA(game, rp, p.ValidSAonCard, ctx)) return false;
      // "a spell with {X} in its mana cost" (Brass Infiniscope, Unbound Flourishing)
      if (p.HasXManaCost === 'True' && !(rp.Card && rp.Card.def && game.chars(rp.Card).manaCost && game.chars(rp.Card).manaCost.x)) return false;
      if (p.ActivatorThisTurnCast) {
        const n = game.players[rp.Player].spellsCastThisTurn.length;
        const m = p.ActivatorThisTurnCast.match(/^(EQ|NE|LT|LE|GT|GE)(\d+)$/);
        if (m && !({ EQ: n === +m[2], NE: n !== +m[2], LT: n < +m[2], LE: n <= +m[2], GT: n > +m[2], GE: n >= +m[2] })[m[1]]) return false;
      }
      if (p.TargetsValid) {
        const ts = rp.Targets || [];
        if (!ts.some(t => vc(game, t, p.TargetsValid, ctx))) return false;
      }
      if (p.NoResolvingCheck) return true;
      return true;
    }
    case 'DamageDone': case 'DamageDoneOnce': case 'DamageDealtOnce': {
      if (p.ValidSource) {
        if (mode === 'DamageDoneOnce') { if (!(rp.Sources || [rp.Source]).some(s => vc(game, s, p.ValidSource, ctx))) return false; }
        else if (!vc(game, rp.Source, p.ValidSource, ctx)) return false;
      }
      if (p.ValidTarget) {
        if (mode === 'DamageDealtOnce') { if (!(rp.Targets || [rp.Target]).some(t => vc(game, t, p.ValidTarget, ctx))) return false; }
        else if (!vc(game, rp.Target, p.ValidTarget, ctx)) return false;
      }
      if (p.CombatDamage === 'True' && !rp.IsCombatDamage) return false;
      if (p.CombatDamage === 'False' && rp.IsCombatDamage) return false;
      if (p.DamageAmount) { const m = p.DamageAmount.match(/^(GE|GT|EQ)(\d+)$/); if (m && !({ GE: rp.DamageAmount >= +m[2], GT: rp.DamageAmount > +m[2], EQ: rp.DamageAmount === +m[2] })[m[1]]) return false; }
      return true;
    }
    case 'DamageAll': return !p.CombatDamage || (p.CombatDamage === 'True') === !!rp.IsCombatDamage;
    case 'Drawn': {
      if (!vc(game, rp.Card, p.ValidCard, ctx)) return false;
      if (p.ValidPlayer && !vc(game, playerObj(game, rp.Player), p.ValidPlayer, ctx)) return false;
      if (p.Number && rp.Number !== +p.Number) return false;
      if (p.FirstCardInDrawStep === 'True' && !(game.step === 'draw' && rp.Number === 1)) return false;
      return true;
    }
    case 'Sacrificed': case 'Destroyed': case 'Exiled': {
      const obj = rp.CardLKI || rp.Card;
      if (!vc(game, obj, p.ValidCard, ctx)) return false;
      if (p.ValidPlayer && !vc(game, playerObj(game, rp.Player), p.ValidPlayer, ctx)) return false;
      if (p.Origin && mode === 'Exiled' && !zoneIn(p.Origin, rp.Origin)) return false;
      return true;
    }
    case 'LifeGained': case 'LifeLost': case 'LifeLostAll': {
      if (p.ValidPlayer && !vc(game, playerObj(game, rp.Player), p.ValidPlayer, ctx)) return false;
      if (p.ValidSource && !vc(game, rp.Source, p.ValidSource, ctx)) return false;
      if (p.FirstTime === 'True') { const pl = game.players[rp.Player]; if (pl && (mode === 'LifeGained' ? pl.lifeGainedThisTurn : pl.lifeLostThisTurn) !== rp.LifeAmount) return false; }
      return true;
    }
    case 'TapsForMana': {
      if (!vc(game, rp.Card, p.ValidCard, ctx)) return false;
      if (p.Activator && !vc(game, playerObj(game, rp.Player), p.Activator, ctx)) return false;
      if (p.Produced && !rp.Produced.split(' ').some(x => p.Produced.includes(x))) return false;
      return true;
    }
    case 'BecomeRenowned': case 'Exerted': case 'Cycled': case 'Discarded': case 'Milled': case 'Investigated': case 'Explores': case 'Connives': case 'Exploited': case 'TurnFaceUp': case 'Mutates': case 'BecomeMonstrous': case 'Transformed': case 'Evolved': {
      if (!vc(game, rp.Card, p.ValidCard, ctx)) return false;
      if (p.ValidPlayer && !vc(game, playerObj(game, rp.Player), p.ValidPlayer, ctx)) return false;
      return true;
    }
    case 'DiscardedAll': case 'MilledAll': {
      if (p.ValidPlayer && !vc(game, playerObj(game, rp.Player), p.ValidPlayer, ctx)) return false;
      const cards = (rp.Cards || []).filter(c => vc(game, c, p.ValidCard || p.ValidCards, ctx));
      if (!cards.length) return false;
      rp.Amount = cards.length;
      return true;
    }
    case 'FlippedCoin':
      // "whenever you win a coin flip" / "lose a coin flip"
      if (p.ValidResult && (p.ValidResult === 'Win') !== !!rp.Result) return false;
      return !p.ValidPlayer || vc(game, playerObj(game, rp.Player), p.ValidPlayer, ctx);
    case 'RolledDie': case 'RolledDieOnce': {
      // "whenever you roll a 4 or higher" / "a die's highest natural result" / "whenever you roll to visit your Attractions"
      if (p.RolledToVisitAttractions === 'True' && !rp.ToVisit) return false;
      const m = (p.ValidResult || '').replace(/^(\d+)$/, 'EQ$1').match(/^(EQ|NE|LT|LE|GT|GE)(\d+)$/);
      if (m && !({ EQ: rp.Result === +m[2], NE: rp.Result !== +m[2], LT: rp.Result < +m[2], LE: rp.Result <= +m[2], GT: rp.Result > +m[2], GE: rp.Result >= +m[2] })[m[1]]) return false;
      if (p.ValidResult === 'Highest' && rp.Result !== rp.Sides) return false;
      return !p.ValidPlayer || vc(game, playerObj(game, rp.Player), p.ValidPlayer, ctx);
    }
    case 'GiveGift': case 'Surveil': case 'Scry': case 'BecomeMonarch': case 'TakesInitiative': case 'RoomEntered': case 'DungeonCompleted': case 'LosesGame': case 'CommitCrime':
      return !p.ValidPlayer || vc(game, playerObj(game, rp.Player), p.ValidPlayer, ctx);
    case 'BecomesTarget': case 'BecomesTargetOnce': {
      if (!vc(game, rp.Target, p.ValidTarget, ctx)) return false;
      if (p.ValidSource && !vc(game, rp.Source, p.ValidSource, ctx)) return false;
      if (p.SourceType === 'Spell' && !(rp.StackItem && rp.StackItem.kind === 'spell')) return false;
      return true;
    }
    case 'Taps': case 'Untaps': return vc(game, rp.Card, p.ValidCard, ctx) && (!p.Attacker || (p.Attacker === 'True') === !!rp.Attacker);
    case 'Blocks': return vc(game, rp.Blocker, p.ValidCard, ctx) && (!p.ValidBlocked || (rp.Attackers || [rp.Attacker]).some(a => vc(game, a, p.ValidBlocked, ctx)));
    case 'AttackerBlocked': case 'AttackerBlockedByCreature': return vc(game, rp.Attacker, p.ValidCard, ctx) && (!p.ValidBlocker || (rp.Blockers || [rp.Blocker]).some(b => vc(game, b, p.ValidBlocker, ctx)));
    case 'AttackerUnblocked': return vc(game, rp.Attacker, p.ValidCard, ctx);
    case 'AttackerUnblockedOnce': {
      if (p.ValidAttackingPlayer && !vc(game, playerObj(game, rp.AttackingPlayer), p.ValidAttackingPlayer, ctx)) return false;
      const list = (rp.Attackers || []).filter(a => vc(game, a, p.ValidCard || 'Creature', ctx));
      return list.length > 0;
    }
    // combat (mech-combat.js): "whenever one or more creatures you control become blocked", "whenever one or more
    // creatures block", excess damage
    case 'AttackerBlockedOnce': return (rp.Attackers || []).some(a => vc(game, a, p.ValidCard || 'Creature', ctx));
    case 'BlockersDeclared': return true;
    case 'ExcessDamage': return vc(game, rp.Target, p.ValidTarget, ctx) && (!p.CombatDamage || (p.CombatDamage === 'True') === !!rp.IsCombatDamage);
    case 'ExcessDamageAll': {
      if (p.CombatDamage && (p.CombatDamage === 'True') !== !!rp.IsCombatDamage) return false;
      const list = (rp.DamageTargets || []).filter(t => vc(game, t, p.ValidTarget, ctx));
      rp.Targets = list;
      return list.length > 0;
    }
    case 'CounterAdded': case 'CounterAddedOnce': {
      const obj = rp.Card || playerObj(game, rp.Player);
      if (p.ValidCard && !vc(game, rp.Card, p.ValidCard, ctx)) return false;
      if (p.ValidPlayer && !vc(game, playerObj(game, rp.Player), p.ValidPlayer, ctx)) return false;
      if (p.ValidObject && !vc(game, obj, p.ValidObject, ctx)) return false;
      if (p.CounterType && normalizeCounter(p.CounterType) !== rp.CounterType) return false;
      if (p.ValidSource && !vc(game, rp.Source, p.ValidSource, ctx)) return false;
      if (p.CounterAmount) { const m = p.CounterAmount.match(/^(EQ|GE)(\d+)$/); if (m && !(m[1] === 'EQ' ? rp.Previous + 1 === +m[2] : rp.Previous + 1 >= +m[2])) return false; }
      return true;
    }
    case 'CounterRemoved': return vc(game, rp.Card, p.ValidCard, ctx) && (!p.CounterType || normalizeCounter(p.CounterType) === rp.CounterType) && (p.NewCounterAmount == null || +p.NewCounterAmount === rp.NewCounterAmount);
    case 'Vote': return true;
    case 'Shuffled': return !p.ValidPlayer || vc(game, playerObj(game, rp.Player), p.ValidPlayer, ctx);
    case 'CounterTypeAddedAll': return (!p.ValidObject || vc(game, rp.Object, p.ValidObject, ctx)) && (!p.CounterType || normalizeCounter(p.CounterType) === rp.CounterType);
    case 'CounterRemovedOnce': return (!p.ValidCard || vc(game, rp.Card, p.ValidCard, ctx)) && (!p.CounterType || normalizeCounter(p.CounterType) === rp.CounterType);
    case 'SearchedLibrary': return (!p.ValidPlayer || vc(game, playerObj(game, rp.Player), p.ValidPlayer, ctx)) && (p.SearchOwnLibrary !== 'True' || rp.SearchOwn);
    case 'PhaseOutAll': return !p.ValidCards || (rp.Cards || []).some(c => vc(game, c, p.ValidCards, ctx));
    case 'MilledOnce': {
      if (p.ValidPlayer && !vc(game, playerObj(game, rp.Player), p.ValidPlayer, ctx)) return false;
      return !p.ValidCard || (rp.Cards || []).some(c => vc(game, c, p.ValidCard, ctx));
    }
    case 'ManaExpend': return (!p.Player || vc(game, playerObj(game, rp.Player), p.Player, ctx)) && (!p.Amount || +p.Amount === rp.Amount);
    case 'CounterPlayerAddedAll': return true;
    case 'LandPlayed': return vc(game, rp.Card, p.ValidCard, ctx) && (!p.ValidSA || validSA(game, rp, p.ValidSA, ctx));
    case 'TokenCreated': case 'TokenCreatedOnce': {
      if (!vc(game, rp.Card, p.ValidToken || p.ValidCard, ctx)) return false;
      if (p.ValidPlayer && !vc(game, playerObj(game, rp.Player), p.ValidPlayer, ctx)) return false;
      if (p.OnlyFirst) {
        if (!vc(game, playerObj(game, rp.Player), p.OnlyFirst, ctx)) return false;
        if ((game.turnState.tokenBatches[rp.Player] || 0) > 1) return false;
      }
      return true;
    }
    case 'Always': return true;
    case 'Fight': return vc(game, rp.Fighter, p.ValidCard, ctx);
    case 'Attached': return vc(game, rp.AttachSource, p.ValidSource, ctx) && vc(game, rp.AttachTarget, p.ValidTarget, ctx);
    case 'Unattached': return vc(game, rp.AttachSource, p.ValidAttachment, ctx) && vc(game, rp.AttachTarget, p.ValidObject, ctx);
    case 'ChangesController': return vc(game, rp.Card, p.ValidCard, ctx);
    case 'BecomesCrewed': return vc(game, rp.Card, p.ValidVehicle || p.ValidCard, ctx);
    // combat (mech-combat.js): "whenever this creature crews a Vehicle / saddles a Mount", "becomes saddled for the first
    // time each turn", "enlists a creature"
    case 'Crewed': case 'Saddled': return vc(game, rp.Card, p.ValidCard, ctx) && (!p.ValidCrew || [].concat(rp.Crew || []).some(c => vc(game, c, p.ValidCrew, ctx)));
    case 'BecomesSaddled': return vc(game, rp.Card, p.ValidSaddled || p.ValidCard, ctx) && (p.FirstTimeSaddled !== 'True' || rp.TimesSaddled === 1);
    case 'Enlisted': return vc(game, rp.Card, p.ValidCard, ctx) && vc(game, rp.Enlisted, p.ValidEnlisted, ctx);
    case 'UnlockDoor': case 'FullyUnlock':
      if (!vc(game, rp.Card, p.ValidCard, ctx)) return false;
      if (p.ValidPlayer && !vc(game, playerObj(game, rp.Player), p.ValidPlayer, ctx)) return false;
      if (mode === 'UnlockDoor' && p.ThisDoor === 'True' && ctx.door != null && rp.Door !== ctx.door) return false;
      return true;
    case 'ClassLevelGained': return vc(game, rp.Card, p.ValidCard, ctx) && (!p.ClassLevel || +p.ClassLevel === rp.ClassLevel);
    case 'Clashed': {
      if (p.ValidPlayer && !vc(game, playerObj(game, rp.Player), p.ValidPlayer, ctx)) return false;
      if (p.Won && (p.Won === 'True') !== !!rp.Won) return false;
      return true;
    }
    case 'DamagePrevented': case 'DamagePreventedOnce': {
      if (p.ValidTarget && !vc(game, rp.Target, p.ValidTarget, ctx)) return false;
      if (p.ValidSource && !(rp.Sources || [rp.Source]).some(s => vc(game, s, p.ValidSource, ctx))) return false;
      if (p.CombatDamage === 'True' && !rp.IsCombatDamage) return false;
      if (p.CombatDamage === 'False' && rp.IsCombatDamage) return false;
      return true;
    }
    case 'StickerPlaced': case 'VisitAttraction': case 'ClaimPrize': return unsetsTriggerMatches(game, p, rp, ctx, vc);
    case 'AbilityTriggered': case 'AbilityResolves': return false;
    case 'ManaAdded': return false;
    default: return triggerExt[mode] ? triggerExt[mode](game, p, host, rp, ctx) : newsetsTriggerMatches(game, p, host, rp, ctx);
  }
}

function validSA(game, rp, spec, ctx) {
  const parts = spec.split(',');
  for (const part of parts) {
    const s = part.trim();
    if (s === 'Spell' && rp.IsSpell) return true;
    if (s === 'Activated' && !rp.IsSpell && !rp.IsTrigger) return true;
    // played thanks to this source's "you may play/cast ... from your graveyard" (Serra Paragon)
    if (/^(Spell|SpellAbility)\.MayPlaySource$/.test(s)) { if ((rp.IsSpell || s.startsWith('SpellAbility')) && rp.MayPlay && (rp.MayPlayHost == null || !ctx.host || rp.MayPlayHost === ctx.host.id)) return true; continue; }
    if (s.startsWith('Spell.') && rp.IsSpell) {
      const prop = s.slice(6);
      if (prop === 'castFromHand' || prop === 'wasCastFromHand') { if (rp.CastFrom === 'hand') return true; continue; }
      if (prop === 'notCastFromHand') { if (rp.CastFrom !== 'hand') return true; continue; }
      if (prop === 'isCastFromCommandZone') { if (rp.CastFrom === 'command') return true; continue; }
      // how it was cast ("if no mana was spent to cast it", "using mana from a Treasure") or what it is
      const sa = rp.SpellAbility || (rp.Card && rp.Card.castSA);
      if (sa && rp.Card && matchCastSA(game, sa, rp.Card, s, ctx)) return true;
      continue;
    }
    if (s.startsWith('Activated.') && !rp.IsSpell) return true;
    // "SpellAbility.!ManaAbility+ManaSpent GE4": a spell or activated ability, as it was paid for
    if (s.startsWith('SpellAbility.') && rp.SpellAbility && rp.Card && matchCastSA(game, rp.SpellAbility, rp.Card, s, ctx)) return true;
    if (s === 'SpellAbility') return true;
  }
  return false;
}
