// Forge "Valid" filters, "Defined" references, numeric expressions and conditions.
import { compare, CAP_COLOR, COLORS, BASIC_LAND_TYPES, NAME_TO_COLOR, PERMANENT_TYPES } from './util.js';
import { cmc, manaColorsFromProduced } from './mana.js';

export const unknownProps = new Set(); // collected for coverage diagnostics

// ---------- helpers on objects (live cards, LKI snapshots, players)
export function isPlayer(o) { return o && o.isPlayer; }
export function isCard(o) { return o && (o.isCard || o.lki); }

export function ctrlOf(game, o) {
  if (!o) return null;
  if (o.isPlayer) return o.id;
  if (o.lki) return o.controller;
  if (o.zone === 'battlefield' || o.zone === 'stack') return o.controller;
  return o.owner;
}

function splitTop(str, sep) {
  // split on sep, but not inside parentheses
  const out = []; let depth = 0, cur = '';
  for (const ch of str) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function hasType(game, ch, t, obj) {
  switch (t) {
    case 'Card': case 'Any': return true;
    case 'Permanent': return ch.types.has('Artifact') || ch.types.has('Creature') || ch.types.has('Enchantment') || ch.types.has('Land') || ch.types.has('Planeswalker') || ch.types.has('Battle');
    case 'Spell': return obj && !obj.lki && obj.zone === 'stack';
    case 'Historic': return ch.types.has('Artifact') || ch.supertypes.has('Legendary') || ch.subtypes.has('Saga');
    case 'Outlaw': return ['Assassin', 'Mercenary', 'Pirate', 'Rogue', 'Warlock'].some(x => ch.subtypes.has(x));
    case 'Party': return ['Cleric', 'Rogue', 'Warrior', 'Wizard'].some(x => ch.subtypes.has(x));
    case 'Tribal': return ch.types.has('Kindred');
    case 'Emblem': return ch.types.has('Emblem');
    case 'Effect': return !!(obj && obj.isEffect);
  }
  if (ch.types.has(t) || ch.supertypes.has(t) || ch.subtypes.has(t)) return true;
  if (ch.allCreatureTypes && ch.types.has('Creature') && /^[A-Z]/.test(t) && !game.nonCreatureSubtypes.has(t)) return true;
  if (ch.allCreatureTypes && ch.types.has('Kindred') && /^[A-Z]/.test(t) && !game.nonCreatureSubtypes.has(t)) return true;
  return false;
}

export function charsOf(game, o) {
  if (o.lki) return o.chars;
  if (o.stackItem) return o.card ? game.chars(o.card) : (o.source ? charsOf(game, o.source) : null);
  return game.chars(o);
}

// ---------- Valid matching
export function matchValid(game, obj, valid, ctx) {
  if (valid == null || valid === '') return true;
  if (!obj) return false;
  for (const alt of splitTop(String(valid), ',')) {
    if (matchOne(game, obj, alt.trim(), ctx)) return true;
  }
  return false;
}

function matchOne(game, obj, spec, ctx) {
  if (!spec) return false;
  let neg = false;
  if (spec.startsWith('!')) { neg = true; spec = spec.slice(1); }
  if (spec === 'Self') spec = 'Card.Self'; // "ValidCards$ Self"
  const dot = spec.indexOf('.');
  const typePart = dot < 0 ? spec : spec.slice(0, dot);
  const props = dot < 0 ? [] : splitTop(spec.slice(dot + 1), '+');
  let r;
  if (obj.isPlayer) r = matchPlayer(game, obj, typePart, props, ctx);
  else if (obj.stackItem) r = matchStackItem(game, obj, typePart, props, ctx);
  else r = matchCard(game, obj, typePart, props, ctx);
  return neg ? !r : r;
}

function matchStackItem(game, item, typePart, props, ctx) {
  const isSpell = item.kind === 'spell';
  if (typePart === 'Spell' && !isSpell) return false;
  if ((typePart === 'Activated' || typePart === 'Ability') && item.kind !== 'ability') return false;
  if (typePart === 'Triggered' && item.kind !== 'trigger') return false;
  const rest = [];
  for (const prop of props) {
    let m;
    if ((m = prop.match(/^IsTargeting (.+)$/))) {
      const spec = m[1].replace(/^Valid /, '');
      const ts = item.sa ? item.sa.chain().flatMap(s => s.targets || []) : [];
      if (!ts.some(t => matchValid(game, t, spec, ctx))) return false;
      continue;
    }
    if (prop === 'YouCtrl') { if (item.controller !== ctx.you) return false; continue; }
    if (prop === 'OppCtrl') { if (!game.isOpponent(item.controller, ctx.you)) return false; continue; }
    rest.push(prop);
  }
  const card = item.card || item.source;
  if (!card) return rest.length === 0;
  if (['Spell', 'Activated', 'Ability', 'Triggered', 'Card', 'SpellAbility'].includes(typePart)) return rest.every(pr => cardProp(game, card, charsOf(game, card), pr, ctx));
  return matchCard(game, card, typePart, rest, ctx);
}

function matchPlayer(game, p, typePart, props, ctx) {
  const you = ctx.you;
  switch (typePart) {
    case 'Player': case 'Any': break;
    case 'Opponent': if (!game.isOpponent(p.id, you)) return false; break;
    case 'You': if (p.id !== you) return false; break;
    default: return false;
  }
  for (const prop of props) if (!playerProp(game, p, prop, ctx)) return false;
  return true;
}

function playerProp(game, p, prop, ctx) {
  const you = ctx.you;
  if (prop.startsWith('!')) return !playerProp(game, p, prop.slice(1), ctx);
  switch (prop) {
    case 'isMonarch': return game.monarch === p.id;
    case 'hasInitiative': return game.initiative === p.id;
    case 'LostLifeThisTurn': return p.lifeLostThisTurn > 0;
    case 'attackedWithCreaturesThisTurn': return game.activePlayer === p.id && (game.turnState.attackedWith || []).length > 0;
    case 'castSpellThisTurn': return p.spellsCastThisTurn.length > 0;
    case 'descended': return false;
    case 'wasDealtCombatDamageThisTurnBySource': {
      const list = (game.turnState.combatDamageSources || {})[p.id];
      if (!list) return !!game.turnState.combatDamagedPlayers[p.id] && !ctx.host;
      return !!ctx.host && list.some(x => x.id === ctx.host.id);
    }
    case 'CardOwner': return !!ctx.host && ctx.host.owner === p.id;
    case 'EnchantedController': { const t = ctx.host && ctx.host.attachedTo; const c = typeof t === 'number' ? game.cardById(t) : null; return !!c && c.controller === p.id; }
    case 'OpponentToActive': return game.isOpponent(p.id, game.activePlayer);
    case 'TriggeredActivator': return ctx.trig && ctx.trig.Player === p.id;
    case 'TriggeredTarget': return !!(ctx.trig && ctx.trig.Target && ctx.trig.Target.isPlayer && ctx.trig.Target.id === p.id);
    case 'Creature': return false;
    case 'Opponent': return game.isOpponent(p.id, you);
    case 'You': return p.id === you;
    case 'Other': case 'NonYou': return p.id !== you;
    case 'IsRemembered': return refList(game, ctx, 'Remembered').some(x => x && x.isPlayer && x.id === p.id);
    case 'IsNotRemembered': return !refList(game, ctx, 'Remembered').some(x => x && x.isPlayer && x.id === p.id);
    case 'IsTriggerRemembered': return !!(ctx.sa && ctx.sa.trigRemembered && ctx.sa.trigRemembered.some(x => x.isPlayer && x.id === p.id));
    case 'Chosen': return ctx.host && ctx.host.chosen && ctx.host.chosen.player === p.id;
    case 'Active': return game.activePlayer === p.id;
    case 'NonActive': return game.activePlayer !== p.id;
    case 'Defending': return !!(game.combat && game.combat.attackers.some(a => a.defenderPlayer === p.id));
    case 'EnchantedBy': return ctx.host && ctx.host.attachedTo === 'p' + p.id;
    case 'Monarch': return game.monarch === p.id;
    case 'withMostLife': return game.livingPlayers().every(q => q.life <= p.life);
    case 'withLowestLife': return game.livingPlayers().every(q => q.life >= p.life);
    case 'withMostCardsInHand': return game.livingPlayers().every(q => q.hand.length <= p.hand.length);
    case 'attackedThisTurn': case 'attackedBySourceThisCombat': return !!(game.combat && game.combat.attackers.some(a => a.defenderPlayer === p.id));
    case 'wasDealtDamageThisTurn': return !!game.turnState.damagedPlayers[p.id];
    case 'wasDealtCombatDamageThisTurn': return !!game.turnState.combatDamagedPlayers[p.id];
    case 'Opponent+wasDealtDamageThisTurn': return false;
  }
  let m;
  if ((m = prop.match(/^controls(.+)$/))) {
    const us = m[1].match(/^(.+)_((?:EQ|GE|LE|GT|LT|NE)\d+)$/);
    const [filter, cmp] = us ? [us[1], us[2]] : m[1].split(/(?=EQ|GE|LE|GT|LT|NE)/);
    const n = game.battlefield.filter(c => c.controller === p.id && matchValid(game, c, filter, { ...ctx, you: ctx.you })).length;
    if (cmp) { const mm = cmp.match(/^(EQ|GE|LE|GT|LT|NE)(\d+)$/); if (mm) return compare(n, mm[1], +mm[2]); }
    return n > 0;
  }
  if ((m = prop.match(/^(Life|Hand|Cards)(EQ|GE|LE|GT|LT|NE)(\d+)$/))) {
    const v = m[1] === 'Life' ? p.life : p.hand.length;
    return compare(v, m[2], +m[3]);
  }
  if ((m = prop.match(/^LifeGained(EQ|GE|LE|GT|LT)(\d+)$/))) return compare(p.lifeGainedThisTurn, m[1], +m[2]);
  if ((m = prop.match(/^life(EQ|NE|GE|LE|GT|LT)(.+)$/i))) return compare(p.life, m[1], calcCtx(game, m[2], ctx));
  if (prop === 'IsCorrupted') return (p.counters.POISON || 0) >= 3;
  if (prop === 'IsPoisoned') return (p.counters.POISON || 0) >= 1;
  if (prop === 'hasNoCardsInHand' || prop === 'Hellbent') return p.hand.length === 0;
  if (prop === 'IsTargeted' || prop === 'Targeted') return refList(game, ctx, 'Targeted').some(x => x.isPlayer && x.id === p.id);
  if ((m = prop.match(/^OpponentOf (.+)$/))) return resolveDefined(game, m[1], ctx).some(x => x.isPlayer && x.id !== p.id);
  if ((m = prop.match(/^NotedFor/))) return false;
  if ((m = prop.match(/^HasCardsIn(Hand|Graveyard|Library|Exile)_(.+?)_(EQ|NE|LT|LE|GT|GE)(.+)$/))) { const z = zoneMap[m[1]]; const n = p[z].filter(c => matchValid(game, c, m[2], ctx)).length; return compare(n, m[3], calcCtx(game, m[4], ctx)); }
  if (prop.startsWith('withMost') || prop.startsWith('withLeast') || prop.startsWith('with')) return true;
  // "that player attacked you during their last turn" / "a player it has already attacked this turn"
  // "a player who was dealt combat damage by three or more Pirates this turn"
  if ((m = prop.match(/^wasDealtCombatDamageThisTurnBy (\S+) (EQ|GE|LE|GT|LT|NE)(\d+)$/))) {
    const list = (game.turnState.combatDamageSources || {})[p.id] || [];
    const valid = m[1].replace(/^Card\.Self/, 'Card.Self');
    return compare(list.filter(x => matchValid(game, x.lki && x.card && x.card.zcc === x.zcc ? x.card : x, valid, ctx) || (valid.split(',').includes('Card.Self') && ctx.host && x.id === ctx.host.id)).length, m[2], +m[3]);
  }
  if (prop === 'attackedYouTheirLastTurn') return (p.attackedPlayers || []).includes(you);
  // (no teams here: your team is you, and you have no allies)
  if (prop === 'YourTeam') return p.id === you;
  if (prop === 'Allies') return false;
  if (prop === 'MaxSpeed') return (p.speed || 0) >= 4;
  if ((m = prop.match(/^LostLifeThisTurn (EQ|NE|LT|LE|GT|GE)(.+)$/))) return compare(p.lifeLostThisTurn, m[1], calcCtx(game, m[2], ctx));
  // compared with the active player (the Oaths)
  if (prop === 'hasMoreLifeThanActive') return p.life > game.players[game.activePlayer].life;
  if (prop === 'hasMoreCardsInHandThanActive') return p.hand.length > game.players[game.activePlayer].hand.length;
  // compared with you (Goblin Goon: "can't attack unless you control more creatures than defending player")
  if ((m = prop.match(/^has(Fewer|More)(Creatures|Lands)InPlayThanYou$/))) {
    const t = m[2] === 'Creatures' ? 'Creature' : 'Land';
    const n = pid => game.battlefield.filter(c => c.controller === pid && game.chars(c).types.has(t)).length;
    return m[1] === 'Fewer' ? n(p.id) < n(ctx.you) : n(p.id) > n(ctx.you);
  }
  if (prop === 'hasFewerCreaturesInYardThanActive') { const n = q => q.graveyard.filter(c => game.chars(c).types.has('Creature')).length; return n(p) < n(game.players[game.activePlayer]); }
  if (prop === 'CardsInHandAtBeginningOfTurn') return (p.handAtTurnStart || 0) > 0;
  if (prop === 'TappedLandForManaThisTurn') return p.landManaTurn === game.turnNumber;
  // damage history: "a player this creature has dealt damage to this game", "a source you controlled dealt 5 or more damage this turn"
  if (prop === 'wasDealtDamageThisGameBy Self') return !!ctx.host && !!ctx.host.damageHistory && ctx.host.damageHistory.players.includes(p.id);
  if (prop === 'wasDealtDamageThisTurnBySource') return !!ctx.host && game.turnState.damageLog.some(e => e.player === p.id && e.source === ctx.host.id);
  if ((m = prop.match(/^wasDealtCombatDamageThisTurnBySourceTimes (EQ|NE|LT|LE|GT|GE)(\d+)$/))) return !!ctx.host && compare(game.turnState.damageLog.filter(e => e.combat && e.player === p.id && e.source === ctx.host.id).length, m[1], +m[2]);
  if ((m = prop.match(/^damageDoneSingleSource (EQ|NE|LT|LE|GT|GE)(.+)$/))) {
    const by = {};
    for (const e of game.turnState.damageLog) if (e.source != null && e.controller === p.id) by[e.source] = (by[e.source] || 0) + e.amount;
    return compare(Math.max(0, ...Object.values(by)), m[1], calcCtx(game, m[2], ctx));
  }
  if (/^Triggered\w+$/.test(prop)) return resolveDefined(game, prop, ctx).some(x => x && x.isPlayer && x.id === p.id);
  if (prop === 'attackedBySourceThisTurn') { const rec = ctx.host && ctx.host.attackedPlayers; return !!rec && rec.turn === game.turnNumber && rec.pids.includes(p.id); }
  unknownProps.add('player:' + prop);
  return false;
}

// "Targeted.sameName", "Remembered.Creature+Other", "Triggered.YouOwn+sameName": a filter relative to the
// card that names it (the first one targeted / remembered, the triggering one) instead of the source;
// a bare "TriggeredCard" is that card itself
const RELATIVE_TO = { Targeted: 'Targeted', TargetedCard: 'Targeted', Remembered: 'Remembered', Triggered: 'TriggeredCard', TriggeredCard: 'TriggeredCard', TriggeredObject: 'TriggeredCard', TriggeredAttacker: 'TriggeredAttacker', TriggeredBlocker: 'TriggeredBlocker' };

function matchCard(game, card, typePart, props, ctx) {
  if (RELATIVE_TO[typePart] && (props.length || typePart.startsWith('Triggered'))) {
    const ref = resolveDefined(game, RELATIVE_TO[typePart], ctx).map(x => x && x.stackItem ? x.card : x).find(x => x && !x.isPlayer);
    if (!ref) return false;
    return matchCard(game, card, 'Card', props.length ? props : ['Self'], { ...ctx, host: ref });
  }
  const ch = charsOf(game, card);
  if (!ch) return false;
  if (typePart !== 'Card' && typePart !== 'Any') {
    if (typePart === 'Player' || typePart === 'Opponent' || typePart === 'You') return false;
    if (typePart.startsWith('non')) { if (hasType(game, ch, typePart.slice(3), card)) return false; }
    else if (!hasType(game, ch, typePart, card)) return false;
    if (typePart === 'Permanent' && !card.lki && card.zone !== 'battlefield' && ctx.zoneLess !== true && ctx.requireBattlefield) return false;
  }
  for (const prop of props) if (!cardProp(game, card, ch, prop, ctx)) return false;
  return true;
}

function cardProp(game, card, ch, prop, ctx) {
  if (!prop) return true;
  if (prop.startsWith('!')) return !cardProp(game, card, ch, prop.slice(1), ctx);
  const you = ctx.you;
  const ctrl = ctrlOf(game, card);
  const host = ctx.host;
  switch (prop) {
    case 'YouCtrl': return ctrl === you;
    case 'YouDontCtrl': return ctrl !== you;
    case 'OppCtrl': return game.isOpponent(ctrl, you);
    case 'YouOwn': return card.owner === you;
    case 'YouDontOwn': return card.owner !== you;
    case 'OppOwn': return game.isOpponent(card.owner, you);
    case 'Other': case 'StrictlyOther': return !host || card.id !== host.id;
    case 'Self': case 'StrictlySelf': return !!host && card.id === host.id;
    case 'token': case 'Token': return !!card.token;
    case 'nonToken': case 'nontoken': return !card.token;
    case 'tapped': case 'Tapped': return !!card.tapped;
    case 'untapped': case 'Untapped': return !card.tapped;
    // last known information: a creature that left combat by leaving the battlefield "was attacking"
    case 'attacking': return card.lki ? !!card.wasAttacking : game.isAttacking(card);
    case 'notattacking': return card.lki ? !card.wasAttacking : !game.isAttacking(card);
    case 'blocking': return card.lki ? !!card.wasBlocking : game.isBlocking(card);
    case 'blocked': return game.isBlocked(card);
    case 'unblocked': return game.isAttacking(card) && !game.isBlocked(card);
    case 'attackingYou': return game.attackTargetOf(card) === you;
    case 'attackingOrBlocking': return game.isAttacking(card) || game.isBlocking(card);
    case 'IsCommander': return !!card.isCommander;
    case 'nonCommander': case 'IsNotCommander': return !card.isCommander;
    case 'IsRemembered': return refList(game, ctx, 'Remembered').some(x => x && !x.isPlayer && x.id === card.id);
    case 'IsNotRemembered': return !refList(game, ctx, 'Remembered').some(x => x && !x.isPlayer && x.id === card.id);
    case 'IsImprinted': return refList(game, ctx, 'Imprinted').some(x => x && x.id === card.id);
    case 'IsTriggerRemembered': return !!(ctx.sa && ctx.sa.trigRemembered && ctx.sa.trigRemembered.some(x => x.id === card.id));
    // (mech-newsets.js) your Ring-bearer, while it's the same object; a blocker with greater power than the attacker
    case 'IsRingbearer': { const c0 = card.lki ? card.card : card, rb = game.players[ctrl] && game.players[ctrl].ringBearer; return !!rb && !!c0 && rb.id === c0.id && rb.zcc === card.zcc; }
    case 'powerGTAttacker': return !!ctx.attacker && ch.power > charsOf(game, ctx.attacker).power;
    case 'EquippedBy': case 'EnchantedBy': case 'AttachedBy':
      if (!host) return false;
      if (card.lki && card.attachments) return card.attachments.includes(host.id);
      return host.attachedTo === card.id || (host.lki && host.attachedTo === card.id);
    case 'enchanted': case 'Enchanted': return game.attachmentsOf(card).some(a => game.chars(a).subtypes.has('Aura'));
    case 'tokenCreated': case 'createdThisTurn': return !!card.token && card.enteredTurn === game.turnNumber;
    case 'Equipped': return game.attachmentsOf(card).some(a => game.chars(a).subtypes.has('Equipment'));
    case 'Attached': return !!card.attachedTo;
    case 'AttachedTo': return !!host && card.attachedTo === host.id;
    case 'HasCounters': return Object.values(card.counters || {}).some(n => n > 0);
    case 'TopLibrary': { const lib = game.players[card.owner].library; return lib.length > 0 && lib[0].id === card.id; }
    case 'BottomLibrary': { const lib = game.players[card.owner].library; return lib.length > 0 && lib[lib.length - 1].id === card.id; }
    case 'faceDown': case 'FaceDown': return !!card.faceDown;
    case 'faceUp': case 'FaceUp': return !card.faceDown;
    case 'Colorless': return ch.colors.size === 0;
    case 'nonColorless': return ch.colors.size > 0;
    case 'MultiColor': case 'Multicolor': return ch.colors.size > 1;
    case 'MonoColor': case 'Monocolor': return ch.colors.size === 1;
    case 'nonMultiColor': return ch.colors.size <= 1;
    case 'ChosenColor': return !!host && !!host.chosen && (host.chosen.colors || []).some(c => ch.colors.has(c));
    case 'ChosenType': return !!host && !!host.chosen && !!host.chosen.type && hasType(game, ch, host.chosen.type, card);
    case 'ChosenCard': case 'ChosenCardStrict': return !!host && !!host.chosen && (host.chosen.cards || []).includes(card.id);
    case 'Defending': return !!(game.combat && game.combat.attackers.some(a => a.defenderCard === card.id));
    case 'Historic': return hasType(game, ch, 'Historic', card);
    case 'Modified': return Object.values(card.counters || {}).some(n => n > 0) || game.attachmentsOf(card).some(a => game.chars(a).subtypes.has('Equipment') || (game.chars(a).subtypes.has('Aura') && a.controller === ctrl));
    case 'wasCast': return !!card.castFrom;
    case 'wasNotCast': return !card.castFrom;
    case 'wasCastFromHand': case 'wasCastFromTheirHand': case 'wasCastFromYourHand': return card.castFrom === 'hand';
    case 'wasCastFromGraveyard': return card.castFrom === 'graveyard';
    case 'wasCastFromExile': return card.castFrom === 'exile';
    case 'wasCastFromCommand': return card.castFrom === 'command';
    case 'ThisTurnEntered': case 'enteredThisTurn': case 'enteredBattlefieldThisTurn': return card.enteredTurn === game.turnNumber;
    case 'notEnteredThisTurn': return card.enteredTurn !== game.turnNumber;
    case 'Defender': return false;
    case 'DefenderCtrl': case 'DefendingPlayerCtrl': return ctrl === defendingPlayer(game, ctx);
    case 'AttackingPlayerCtrl': return ctrl === game.activePlayer;
    case 'ActivePlayerCtrl': return ctrl === game.activePlayer;
    case 'NonActivePlayerCtrl': return ctrl !== game.activePlayer;
    case 'IsGoaded': case 'goaded': return card.lki ? (card.goadedBy || []).length > 0 || ((card.chars && card.chars.goadedBy) || []).length > 0 : game.goaders(card).length > 0;
    case 'kicked': case 'Kicked': return card.kicked > 0;
    case 'Transformed': return !!card.transformed;
    case 'Monstrous': return !!card.monstrous;
    case 'Suspected': return !!card.suspected;
    case 'powerGTtoughness': return ch.power > ch.toughness;
    case 'powerLTtoughness': return ch.power < ch.toughness;
    case 'hasManaAbility': return ch.abilities.some(a => a.parsed.api === 'Mana');
    case 'hasNonManaActivatedAbility': return ch.abilities.some(a => a.parsed.kind === 'AB' && a.parsed.api !== 'Mana');
    case 'Commander': return !!card.isCommander;
    case 'inZoneBattlefield': case 'OnBattlefield': return !card.lki && card.zone === 'battlefield';
    case 'IsTargeted': case 'targeted': return refList(game, ctx, 'Targeted').some(x => x.id === card.id);
    case 'TargetedBy': return false;
    case 'DamagedThisTurn': case 'wasDealtDamageThisTurn': return !!game.turnState.damagedCards[card.id];
    case 'dealtDamageThisTurn': case 'dealtDamageToYouThisTurn': return !!game.turnState.dealtDamage[card.id];
    case 'Cycled': return false;
    case 'Blocked': return game.isBlocked(card);
    case 'hasNoCounters': return !Object.values(card.counters || {}).some(n => n > 0);
    case 'Outlaw': return hasType(game, ch, 'Outlaw', card);
    case 'Party': return hasType(game, ch, 'Party', card);
    case 'nonBasic': return !ch.supertypes.has('Basic');
    case 'nonLegendary': return !ch.supertypes.has('Legendary');
    case 'Legendary': return ch.supertypes.has('Legendary');
    case 'Basic': return ch.supertypes.has('Basic');
    case 'Snow': return ch.supertypes.has('Snow');
    case 'Permanent': return hasType(game, ch, 'Permanent', card);
    case 'nonPermanent': return !hasType(game, ch, 'Permanent', card);
    case 'Spell': return !card.lki && card.zone === 'stack';
    case 'Other+YouCtrl': return (!host || card.id !== host.id) && ctrl === you;
    case 'Attacking': return game.isAttacking(card);
    case 'sharesNameWith Remembered': return refList(game, ctx, 'Remembered').some(x => x && !x.isPlayer && charsOf(game, x).name === ch.name);
    case 'cmcEven': return ch.cmc % 2 === 0;
    case 'cmcOdd': return ch.cmc % 2 === 1;
    case 'greatestPower': case 'greatestPowerControlledByYou': {
      const pool = game.battlefield.filter(c => game.chars(c).types.has('Creature') && (prop === 'greatestPower' || c.controller === ctrl));
      return pool.every(c => game.chars(c).power <= ch.power);
    }
    case 'leastPower': {
      const pool = game.battlefield.filter(c => game.chars(c).types.has('Creature'));
      return pool.every(c => game.chars(c).power >= ch.power);
    }
    case 'greatestCMC': case 'greatestCMCControlledByYou': {
      const pool = game.battlefield.filter(c => c.controller === ctrl);
      return pool.every(c => game.chars(c).cmc <= ch.cmc);
    }
    case 'withTotalPowerGE4': return ch.power >= 4;
    case 'Creature': return ch.types.has('Creature');
    case 'modified': return cardProp(game, card, ch, 'Modified', ctx);
    case 'equipped': return cardProp(game, card, ch, 'Equipped', ctx);
    case 'white': case 'blue': case 'black': case 'red': case 'green': return ch.colors.has({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' }[prop]);
    case 'powerOdd': return ch.power % 2 !== 0;
    case 'powerEven': return ch.power % 2 === 0;
    case 'hasXCost': return !!(ch.manaCost && ch.manaCost.x);
    case 'attackedThisTurn': return !!(game.turnState.attackedWith || []).includes(card.id);
    case 'wasCastByYou': case 'wasCastFromYourHandByYou': return !!card.castFrom && (prop === 'wasCastByYou' || card.castFrom === 'hand') && ctrlOf(game, card) === ctx.you;
    case 'wasCastFromYourGraveyard': return card.castFrom === 'graveyard';
    case 'wasCastFromYourLibrary': return card.castFrom === 'library';
    case 'numTypesGE2': return ch.types.size >= 2;
    case 'hasABasicLandType': return [...ch.subtypes].some(t => BASIC_LAND_TYPES[t]);
    case 'attackingYouOrYourPW': case 'attackingYouOrYourPWLKI': return game.attackTargetOf(card) === ctx.you;
    case 'suspended': return card.zone === 'exile' && (card.counters.TIME || 0) > 0;
    case 'madness': return false;
    case 'CastSaSource': return !!host && card.id === host.id;
    case 'ChosenSector': return !!host && !!host.chosen && !!host.chosen.sector && card.sector === host.chosen.sector;
    case 'DifferentSector': return !!ctx.attacker && card.sector !== ctx.attacker.sector;
    case 'escaped': return card.altCost === 'Escape' || (!!card.castSA && card.castSA.altCost === 'Escape');
    case 'phasedOutIsRemembered': return !!card.phasedOut && !!host && (host.remembered || []).some(r => r && r.id === card.id);
    case 'phasedOutOther': return !!card.phasedOut && (!host || host.id !== card.id);
    case 'cmcChosenEvenOdd': return !!host && !!host.chosen && !!host.chosen.evenOdd && (ch.cmc % 2 === 0) === (host.chosen.evenOdd === 'Even');
    case 'FortifiedBy': return !!host && host.attachedTo === card.id;
    case 'enlistedThisCombat': return card.enlistedTurn === game.turnNumber;
    case 'unpaired': return !card.lki && !game.pairedPartner(card);
    case 'Paired': return !card.lki && !!game.pairedPartner(card);
    case 'PairedWith': { const p = host && !host.lki ? game.pairedPartner(host) : null; return !!p && p.id === card.id; }
    case 'notExertedThisTurn': return card.exertedTurn !== game.turnNumber;
    case 'exertedThisTurn': return card.exertedTurn === game.turnNumber;
    case 'EffectSource': return !!host && !!host.hostCard && host.hostCard.id === card.id;
    case 'prowled': return card.altCost === 'Prowl' || !!(card.castSA && card.castSA.altCost === 'Prowl');
    case 'PromisedGift': return card.promisedGift != null;
    case 'copiedSpell': return !!card.isSpellCopy;
    case 'milledThisTurn': return game.turnState.moves.some(m => m.card === card && m.from === 'library' && m.to === 'graveyard');
    case 'wasDealtExcessDamageThisTurn': return false;
    case 'blockedBySource': return !!(ctx.host && game.combat && game.combat.blockers.get(ctx.host.id) === card.id);
    case 'canReceiveCounters P1P1': return !card.lki && card.zone === 'battlefield';
    case 'canBeTurnedFaceUp': return !!card.faceDown && card.faceDef && card.def.faces[0].types.includes('Creature');
    case 'targetedBy': return false;
    case 'sameName': return !!host && namesMatch(ch, charsOf(game, host));
    // combat history: this combat, this turn, its controller's last turn
    case 'blockingSource': return !!host && blockedAttacker(game, card) === host.id;
    case 'blockedBySourceLKI': { const src = host && !host.lki && host.zone !== 'battlefield' ? sourceLKI(game, host, ctx) : host; return !!src && blockedAttacker(game, src) === card.id; }
    case 'attackedThisCombat': return !!game.combat && (game.combat.attackedIds || []).includes(card.id);
    case 'blockedThisCombat': return !!game.combat && (game.combat.blockedIds || []).includes(card.id);
    case 'blockedThisTurn': return blocksThisTurn(game, card, 'blocker').length > 0;
    case 'blockedByThisTurn': case 'gotBlockedThisTurn': return blocksThisTurn(game, card, 'attacker').length > 0;
    case 'attackingAlone': return card.lki ? !!card.attackingAlone : game.isAttacking(card) && game.combat.attackers.length === 1;
    case 'blockingAlone': return card.lki ? !!card.blockingAlone : game.isBlocking(card) && game.combat.blockers.size === 1;
    case 'attackedYouThisTurn': return !!card.attackedPlayers && card.attackedPlayers.turn === game.turnNumber && card.attackedPlayers.pids.includes(you);
    case 'attackedLastTurn': {
      const turns = game.players[ctrl] ? game.players[ctrl].turns : [];
      const last = turns[turns.length - (game.activePlayer === ctrl ? 2 : 1)];
      return last != null && (card.attackTurns || []).includes(last);
    }
    case 'startedTheTurnUntapped': return card.untappedTurn === game.turnNumber;
    // hasn't been under its controller's control continuously since their most recent turn began
    case 'firstTurnControlled': return !!card.sick;
    case 'dealtDamageToOppThisTurn': return game.turnState.damageLog.some(e => e.source === card.id && e.player != null && game.isOpponent(e.player, ctrl));
    case 'wasDealtNonCombatDamageThisTurn': return game.turnState.damageLog.some(e => e.card === card.id && !e.combat);
    case 'dealtDamagetoAny': return !!card.damageHistory;
    case 'dealtCombatDamagetoAny': return !!card.damageHistory && card.damageHistory.combat;
    case 'attackedBattleThisTurn': return game.turnState.attackedBattles.includes(card.id);
    case 'equalPT': return ch.power === ch.toughness;
    case 'noName': return !ch.name;
    case 'sharesPermanentTypeWith': return !!host && [...ch.types].some(t => PERMANENT_TYPES.includes(t) && charsOf(game, host).types.has(t));
    // "lands that could produce the same type of mana as it" (Mana Web)
    case 'canProduceSameManaTypeWith': { const made = c => new Set(c.abilities.filter(a => a.parsed.api === 'Mana').flatMap(a => manaColorsFromProduced(a.parsed.p.Produced).flat())); const theirs = host ? made(charsOf(game, host)) : new Set(); return [...made(ch)].some(x => theirs.has(x)); }
    // "protection from the colors of permanents you control" (Pledge of Loyalty)
    case 'ColorsYouCtrl': return game.battlefield.some(c => c.controller === you && [...game.chars(c).colors].some(x => ch.colors.has(x)));
    // how it was cast
    case 'bargained': return !!(card.castSA && card.castSA.bargained);
    case 'surged': return castAltCost(card) === 'Surge';
    case 'spectacle': return castAltCost(card) === 'Spectacle';
    // (casting for sneak / web-slinging isn't implemented yet: these hold once it is)
    case 'sneaked': return castAltCost(card) === 'Sneak';
    case 'webSlinged': return castAltCost(card) === 'Web-slinging';
    case 'isCastFaceDown': return !!(card.castSA && card.castSA.faceDown);
    case 'wasCastFromYourGraveyardByYou': case 'wasCastFromGraveyardByYou': return card.castFrom === 'graveyard' && (prop === 'wasCastFromGraveyardByYou' || card.owner === you) && (card.castSA ? card.castSA.controller : ctrl) === you;
    case 'leastToughness': return game.battlefield.filter(c => game.chars(c).types.has('Creature')).every(c => game.chars(c).toughness >= ch.toughness);
    case 'leastToughnessControlledByOpponent': {
      const pool = game.battlefield.filter(c => game.isOpponent(c.controller, you) && game.chars(c).types.has('Creature'));
      return pool.some(c => c.id === card.id) && pool.every(c => game.chars(c).toughness >= ch.toughness);
    }
    case 'lowestRememberedCMC': {
      const rem = refList(game, ctx, 'Remembered').filter(x => x && !x.isPlayer);
      return rem.some(x => x.id === card.id) && rem.every(x => charsOf(game, x).cmc >= ch.cmc);
    }
    case 'lowestCMC': return game.battlefield.every(c => game.chars(c).types.has('Land') || game.chars(c).cmc >= ch.cmc);
    case 'cmcNotChosenEvenOdd': return !!host && !!host.chosen && !!host.chosen.evenOdd && (ch.cmc % 2 === 0) !== (host.chosen.evenOdd === 'Even');
  }
  if (CAP_COLOR[prop]) return ch.colors.has(CAP_COLOR[prop]);
  let m;
  if ((m = prop.match(/^non(White|Blue|Black|Red|Green)$/))) return !ch.colors.has(CAP_COLOR[m[1]]);
  if ((m = prop.match(/^(cmc|power|toughness|CMC)(EQ|NE|LT|LE|GT|GE)(.+)$/))) {
    const v = m[1] === 'power' ? ch.power : m[1] === 'toughness' ? ch.toughness : ch.cmc;
    return compare(v, m[2], calcCtx(game, m[3], ctx));
  }
  // "cmcM20" / "cmcM21": an even / odd mana value
  if ((m = prop.match(/^(cmc|power|toughness)M2(\d)$/))) return Math.abs(m[1] === 'power' ? ch.power : m[1] === 'toughness' ? ch.toughness : ch.cmc) % 2 === +m[2];
  if ((m = prop.match(/^totalPT_?(EQ|NE|LT|LE|GT|GE)(.+)$/))) return compare(ch.power + ch.toughness, m[1], calcCtx(game, m[2], ctx));
  if ((m = prop.match(/^numColors(EQ|NE|LT|LE|GT|GE)(.+)$/))) return compare(ch.colors.size, m[1], calcCtx(game, m[2], ctx));
  // "blocked or was blocked by a legendary creature this turn", "creatures blocked by target Wall this turn"
  if ((m = prop.match(/^(blockedValidThisTurn|blockedByValidThisTurn) (.+)$/))) {
    const [side, other] = m[1] === 'blockedValidThisTurn' ? ['blocker', 'attacker'] : ['attacker', 'blocker'];
    const refs = lookupDefined(game, m[2], ctx) || [];
    return blocksThisTurn(game, card, side).some(b => { const o = blockPartner(game, b, other); return !!o && (refs.some(r => r && r.id === o.id) || matchValid(game, o, m[2], ctx)); });
  }
  // "if no mana was spent to cast it" (Nix, Satoru), "cast using its warp ability" (Full Bore)
  if ((m = prop.match(/^ManaSpent (EQ|NE|LT|LE|GT|GE)(.+)$/))) return card.castSA ? castSAProp(game, card.castSA, card, prop, ctx) : compare(0, m[1], calcCtx(game, m[2], ctx));
  if ((m = prop.match(/^CastSa (.+)$/))) return !!card.castSA && matchCastSA(game, card.castSA, card, m[1], ctx);
  if ((m = prop.match(/^canProduceManaColor (\w+)$/))) {
    const col = NAME_TO_COLOR[m[1].toLowerCase()];
    return ch.abilities.some(a => a.parsed.api === 'Mana' && manaColorsFromProduced(a.parsed.p.Produced).some(u => u.includes(col)));
  }
  // "as long as black is the most common color among all permanents or is tied for most common" (Goham Djinn)
  if ((m = prop.match(/^MostProminentColor (\w+)$/))) return mostProminentColors(game).includes(NAME_TO_COLOR[m[1].toLowerCase()]);
  // "whose controller controls an Island", "if that player controls more lands than you"
  if ((m = prop.match(/^ControllerControls(More|AtLeastAsMany)?([A-Za-z]+)(?:_(EQ|NE|LT|LE|GT|GE)(\w+))?$/))) {
    const count = pid => game.battlefield.filter(c => c.controller === pid && hasType(game, game.chars(c), m[2], c)).length;
    const n = count(ctrl);
    if (m[1] === 'More') return n > count(you);
    if (m[1] === 'AtLeastAsMany') return n >= count(you);
    return m[3] ? compare(n, m[3], calcCtx(game, m[4], ctx)) : n > 0;
  }
  // "a creature that has an activated ability with {T} in its cost" (Magewright's Stone)
  if ((m = prop.match(/^hasAbility (.+)$/))) return ch.abilities.some(a => abilityMatches(a, m[1], ctx));
  // "if equipped creature didn't deal combat damage to a creature this turn" (Thirsting Axe)
  if ((m = prop.match(/^dealtCombatDamageThisTurn (.+)$/))) return game.turnState.damageLog.some(e => e.combat && e.source === card.id && matchValid(game, e.player != null ? game.players[e.player] : game.cardById(e.card), m[1], ctx));
  // "one of the top two cards of its owner's graveyard"
  if ((m = prop.match(/^TopGraveyard(\d+)$/))) { const gy = game.players[card.owner].graveyard; return gy.slice(-+m[1]).includes(card); }
  if ((m = prop.match(/^EquippedByValid (.+)$/))) return game.attachmentsOf(card).some(a => game.chars(a).subtypes.has('Equipment') && matchValid(game, a, m[1], ctx));
  if ((m = prop.match(/^counters_(EQ|NE|LT|LE|GT|GE)(\w+?)_(\w+)$/))) {
    const n = m[3] === 'ANY' ? Object.values(card.counters || {}).reduce((a, b) => a + b, 0) : ((card.counters || {})[m[3]] || 0);
    return compare(n, m[1], calcCtx(game, m[2], ctx));
  }
  if ((m = prop.match(/^with(out)?(.+)$/))) {
    const kw = m[2].replace(/([a-z])([A-Z])/g, '$1 $2');
    const has = game.hasKeywordIn(ch, kw) || game.hasKeywordIn(ch, m[2]);
    return m[1] ? !has : has;
  }
  if ((m = prop.match(/^named(.+)$/))) { const nm = m[1].replace(/;/g, ','); return ch.name === nm || card.def.name === nm; }
  if ((m = prop.match(/^base(Power|Toughness)(EQ|NE|LT|LE|GT|GE)(.+)$/))) { const b = m[1] === 'Power' ? card.faceDef.power : card.faceDef.toughness; return compare(/^\d+$/.test(b || '') ? +b : 0, m[2], calcCtx(game, m[3], ctx)); }
  if ((m = prop.match(/^kicked (\d)$/))) return (card.kicked || 0) >= +m[1];
  if ((m = prop.match(/^ClassLevel(EQ|GE|LE|GT|LT)(\d+)$/))) return compare(card.classLevel || 1, m[1], +m[2]);
  if ((m = prop.match(/^attacking (.+)$/))) { const d = game.attackTargetOf(card); if (d == null) return false; return resolveDefined(game, m[1], ctx).some(x => x.isPlayer && x.id === d); }
  if ((m = prop.match(/^notnamed(.+)$/))) return ch.name !== m[1];
  if ((m = prop.match(/^non(.+)$/))) return !hasType(game, ch, m[1], card);
  if ((m = prop.match(/^(ControlledBy|OwnedBy) (.+)$/))) {
    const who = resolveDefined(game, m[2], ctx).map(x => x.isPlayer ? x.id : ctrlOf(game, x));
    return who.includes(m[1] === 'ControlledBy' ? ctrl : card.owner);
  }
  if (prop === 'SharesColorWith TriggeredProduced' || prop === 'sharesColorWith TriggeredProduced') {
    const produced = String((ctx.trig && ctx.trig.Produced) || (ctx.sa && ctx.sa.trig && ctx.sa.trig.Produced) || '').split(/\s+/);
    return produced.some(c => ch.colors.has(c));
  }
  // "sharesNameWith YourGraveyard", "SharesColorWith MostProminentColor", "sharesCreatureTypeWithAll Tapped" (with each
  // of them), "sharesCardTypeWithOther Remembered" (with another one of them)
  if ((m = prop.match(/^[sS]hares(CreatureType|Color|CardType|Name|LandType)With(All|Other)? ?(.*)$/))) {
    const kind = `shares${m[1]}With`;
    if (m[3] === 'MostProminentColor') return mostProminentColors(game).some(c => ch.colors.has(c));
    const others = sharesPool(game, m[3], ctx).filter(o => o && !o.isPlayer && !(m[2] === 'Other' && o.id === card.id));
    const test = o => shares(game, ch, charsOf(game, o), kind);
    return m[2] === 'All' ? others.length > 0 && others.every(test) : others.some(test);
  }
  if ((m = prop.match(/^sharesControllerWith ?(.*)$/))) return (m[1] ? resolveDefined(game, m[1], ctx) : [host]).some(o => o && !o.isPlayer && ctrlOf(game, o) === ctrl);
  // "two cards that share all their card types" (Demonic Covenant): same set of card types as another one
  if ((m = prop.match(/^sharesAllCardTypesWith(Other)? ?(.*)$/))) {
    const key = c => [...c.types].sort().join(',');
    const others = (m[2] ? resolveDefined(game, m[2], ctx) : [host]).filter(o => o && !o.isPlayer && o.id !== card.id);
    return others.some(o => key(charsOf(game, o)) === key(ch));
  }
  if ((m = prop.match(/^in(?:Real)?Zone ?(\w+)$/))) return !card.lki && card.zone === (zoneMap[m[1]] || m[1].toLowerCase());
  if ((m = prop.match(/^ThisTurnEnteredFrom_(\w+)$/))) return card.movedTurn === game.turnNumber && card.enteredFrom === (zoneMap[m[1]] || m[1].toLowerCase());
  if (prop === 'turnedFaceUpThisTurn') return card.turnedFaceUpTurn === game.turnNumber;
  if ((m = prop.match(/^hasKeyword(.+)$/))) return game.hasKeywordIn(ch, m[1].replace(/([a-z])([A-Z])/g, '$1 $2')) || game.hasKeywordIn(ch, m[1]);
  if ((m = prop.match(/^SharesCMCWith (.+)$/))) return resolveDefined(game, m[1], ctx).some(o => o && !o.isPlayer && charsOf(game, o).cmc === ch.cmc);
  if ((m = prop.match(/^Is(\w+)$/)) && hasType(game, ch, m[1], card)) return true;
  if ((m = prop.match(/^AttachedTo (.+)$/))) { const t = card.attachedTo != null && typeof card.attachedTo === 'number' ? game.cardById(card.attachedTo) : null; return !!t && matchValid(game, t, m[1], ctx); }
  if ((m = prop.match(/^(EquippedBy|EnchantedBy|AttachedBy) (.+)$/))) {
    const atts = game.attachmentsOf(card);
    return atts.some(a => matchValid(game, a, m[2], ctx));
  }
  if ((m = prop.match(/^Devotion/))) return false;
  if ((m = prop.match(/^namedCard$/))) return !!host && host.chosen && host.chosen.name === ch.name;
  if ((m = prop.match(/^ExiledWith(Source|Effect)?$/))) return !!host && card.exiledWith === host.id;
  // exiled by an effect of a permanent / spell you controlled (Haldan, Avid Arcanist)
  if (prop === 'ExiledByYou') { const h = card.zone === 'exile' && card.exiledWith != null ? game.cardById(card.exiledWith) : null; return !!h && (h.zone === 'battlefield' ? h.controller : h.owner) === you; }
  // "Card.TriggeredNewCard", "Card.TriggeredSources": the object(s) the trigger refers to
  if (/^Triggered\w+$/.test(prop)) return resolveDefined(game, prop, ctx).some(x => x && !x.isPlayer && x.id === card.id);
  if ((m = prop.match(/^(\w+)Ctrl$/))) {
    const who = resolveDefined(game, m[1], ctx).map(x => x.isPlayer ? x.id : ctrlOf(game, x));
    if (who.length) return who.includes(ctrl);
  }
  if (/^[A-Z][a-zA-Z'-]*$/.test(prop)) return hasType(game, ch, prop, card);
  // "the artifact with the highest mana value", "a creature with the highest mana value among those that player controls"
  if ((m = prop.match(/^greatestCMC_(NonLandPermanent|[A-Za-z]+?)(ControlledByRemembered)?$/))) {
    const props = [];
    if (m[1] === 'NonLandPermanent') props.push('nonLand');
    if (m[2]) props.push('RememberedPlayerCtrl');
    const valid = (m[1] === 'NonLandPermanent' ? 'Permanent' : m[1]) + (props.length ? '.' + props.join('+') : '');
    return game.battlefield.filter(x => matchValid(game, x, valid, ctx)).every(x => charsOf(game, x).cmc <= ch.cmc);
  }
  // "the creature with the greatest power among creatures that player controls"
  if ((m = prop.match(/^greatestPowerControlledBy(\w+)$/))) {
    const pids = resolveDefined(game, m[1], ctx).map(x => x.isPlayer ? x.id : ctrlOf(game, x));
    if (!pids.includes(ctrl)) return false;
    return game.battlefield.filter(x => x.controller === ctrl && charsOf(game, x).types.has('Creature')).every(x => charsOf(game, x).power <= ch.power);
  }
  // "the card with the greatest mana value among cards discarded / revealed this way"
  if (prop === 'greatestRememberedCMC') {
    const rem = refList(game, ctx, 'Remembered').filter(x => x && !x.isPlayer);
    if (!rem.some(x => x.id === card.id)) return false;
    return rem.every(x => charsOf(game, x).cmc <= ch.cmc);
  }
  // "if it doesn't have the same name as another creature you control or a creature card in your graveyard"
  if ((m = prop.match(/^doesNotShareNameWith (YourGraveyard|OtherYourBattlefield|YourBattlefield)$/))) {
    const nm = ch.name;
    const pool = m[1] === 'YourGraveyard' ? game.players[you].graveyard : game.battlefield.filter(x => x.controller === you && (m[1] !== 'OtherYourBattlefield' || x.id !== card.id));
    return !pool.some(x => x.id !== card.id && charsOf(game, x).name === nm);
  }
  // "if there are no tokens with the same name as it" (The Apprentice's Folly), "... as a remembered card"
  if ((m = prop.match(/^doesNotShareNameWith (.+)$/))) {
    const pool = /^(Remembered|Imprinted)/.test(m[1]) ? resolveDefined(game, m[1], ctx) : game.battlefield.filter(x => matchValid(game, x, m[1], ctx));
    return !pool.some(x => x && !x.isPlayer && namesMatch(ch, charsOf(game, x)));
  }
  // "if it and at least two other creatures attacked this combat"
  if ((m = prop.match(/^attackedThisCombat (EQ|GE|LE|GT|LT|NE)(\d+)$/))) {
    const att = game.turnState.attackedWith || [];
    return att.includes(card.id) && compare(att.length, m[1], +m[2]);
  }
  if (prop === 'EnteredUnder You') return (card.enteredController != null ? card.enteredController : ctrl) === you;
  if (prop === 'surveilledThisTurn') return card.zone === 'graveyard' && card.surveilledTurn === game.turnNumber;
  if (prop === 'hadToAttackThisCombat') { const c0 = card.lki ? card.card : card; const h = c0 && c0.hadToAttack; return !!h && h.turn === game.turnNumber && h.combat === (game.combatsThisTurn || 0); }
  // "Aura.Other.YouOwn": dotted properties
  if (/^[A-Za-z]+(\.[A-Za-z]+)+$/.test(prop)) return prop.split('.').every(pr => cardProp(game, card, ch, pr, ctx));
  if (prop === 'yardGreatestPower') return game.players[card.owner].graveyard.filter(x => charsOf(game, x).types.has('Creature')).every(x => charsOf(game, x).power <= ch.power);
  if (prop === 'blockingTriggeredAttacker') {
    const t = ctx.trig || (ctx.sa && ctx.sa.trig) || {};
    const a = t.Attacker || t.Card;
    return !!game.combat && !!a && game.combat.blockers.get(card.id) === a.id;
  }
  // "blocking equipped creature", "blocking enchanted creature", "blocking a creature you control", "blocking a Goblin"
  if ((m = prop.match(/^blocking([A-Z].*)$/))) {
    const att = blockedAttacker(game, card);
    if (att == null) return false;
    if (m[1] === 'CreatureYouCtrl') { const a = game.cardById(att); return !!a && a.controller === you; }
    return resolveDefined(game, m[1], ctx).some(o => o && !o.isPlayer && o.id === att);
  }
  if (prop === 'otherAbility') { const r = ctx.sa && (ctx.sa.root ? ctx.sa.root() : ctx.sa); return !(r && r.stackItem === card); }
  // two-word creature types ("Time Lord")
  if (/^[A-Z][a-zA-Z'-]* [A-Z][a-zA-Z'-]*$/.test(prop)) return hasType(game, ch, prop, card);
  unknownProps.add(prop);
  return false;
}

function shares(game, a, b, kind) {
  if (kind === 'sharesCreatureTypeWith') {
    if (a.allCreatureTypes && b.subtypes.size) return [...b.subtypes].some(t => !game.nonCreatureSubtypes.has(t)) || b.allCreatureTypes;
    if (b.allCreatureTypes && a.subtypes.size) return [...a.subtypes].some(t => !game.nonCreatureSubtypes.has(t));
    for (const t of a.subtypes) if (b.subtypes.has(t) && !game.nonCreatureSubtypes.has(t)) return true;
    return false;
  }
  if (kind === 'sharesColorWith') { for (const c of a.colors) if (b.colors.has(c)) return true; return false; }
  if (kind === 'sharesCardTypeWith') { for (const t of a.types) if (b.types.has(t)) return true; return false; }
  if (kind === 'sharesNameWith') return namesMatch(a, b);
  if (kind === 'sharesLandTypeWith') { for (const t of a.subtypes) if (BASIC_LAND_TYPES[t] && b.subtypes.has(t)) return true; return false; }
  return false;
}

// (a face-down card has no name to share)
function namesMatch(a, b) { return !!a.name && a.name === b.name; }

// what "shares a name / color / type with <restriction>" compares against
function sharesPool(game, restriction, ctx) {
  const you = game.players[ctx.you];
  switch (restriction) {
    case '': return [ctx.host];
    case 'Commander': case 'YourCommander': return you.commanders.map(id => game.cardById(id)).filter(Boolean);
    case 'YourGraveyard': return you.graveyard;
    case 'Graveyard': return game.cardsInZone('graveyard');
    case 'Battlefield': return game.battlefield;
    case 'NonToken': return game.battlefield.filter(c => !c.token);
    case 'ThisTurnCast': return game.turnState.spellsCast.map(s => s.lki);
    case 'LastCastThisTurn': return game.turnState.spellsCast.slice(-1).map(s => s.lki);
  }
  return resolveDefined(game, restriction, ctx);
}

// the most common color(s) among all permanents, ties included
function mostProminentColors(game) {
  const n = {};
  for (const c of game.battlefield) for (const col of game.chars(c).colors) n[col] = (n[col] || 0) + 1;
  const max = Math.max(0, ...Object.values(n));
  return max ? COLORS.filter(col => n[col] === max) : [];
}

// combat history. The attacker a creature is blocking (as it last was in combat, for one that has left the battlefield)
function blockedAttacker(game, card) {
  if (card.lki) return card.blocking;
  return game.combat && game.combat.blockers.has(card.id) ? game.combat.blockers.get(card.id) : null;
}
// blocks declared this turn with this object as the blocker or as the attacker that was blocked
function blocksThisTurn(game, card, side) {
  return game.turnState.blocks.filter(b => b[side] === card.id && b[side + 'Zcc'] === card.zcc);
}
// the other side of a block: the card while it's still the same object, otherwise how it was when it blocked
function blockPartner(game, b, side) {
  const c = game.cardById(b[side]);
  return c && c.zcc === b[side + 'Zcc'] ? c : b[side + 'LKI'];
}
// how the source was as it left the battlefield (sacrificed to pay for this ability: Tinder Wall)
function sourceLKI(game, host, ctx) {
  const paid = ctx.sa && ctx.sa.root ? ctx.sa.root().paid : null;
  const sac = paid && (paid.Sacrificed || []).find(l => l.lki && l.id === host.id);
  if (sac) return sac;
  for (let i = game.lookback.length - 1; i >= 0; i--) if (game.lookback[i].id === host.id) return game.lookback[i];
  return null;
}

// how a spell was cast: its alternative cost, the mana spent on it, where that mana came from
function castAltCost(card) { return (card.castSA && card.castSA.altCost) || card.altCost || null; }
function manaTotal(spent) { return spent ? Object.values(spent).reduce((a, b) => a + b, 0) : 0; }
const ALT_COSTS = new Set(['Blitz', 'Dash', 'Disturb', 'Emerge', 'Escape', 'Evoke', 'Flashback', 'Foretell', 'Harmonize', 'Impending', 'Mayhem', 'Offering', 'Overload', 'Plot', 'Prowl', 'Retrace', 'Spectacle', 'Surge', 'Warp', 'Sneak', 'Web-slinging']);

// "Spell.ManaSpent EQ0", "Spell.Warp", "SpellAbility.!ManaAbility+ManaSpent GE4": a spell or ability as it was cast or
// activated; properties that aren't about the casting are the card's
export function matchCastSA(game, sa, card, spec, ctx) {
  return splitTop(String(spec), ',').some(alt => {
    alt = alt.trim();
    const dot = alt.indexOf('.');
    const type = dot < 0 ? alt : alt.slice(0, dot);
    const props = dot < 0 ? [] : splitTop(alt.slice(dot + 1), '+');
    if (!['Spell', 'SpellAbility', 'Card'].includes(type) && !matchValid(game, card, type, ctx)) return false;
    return props.every(pr => { const r = castSAProp(game, sa, card, pr, ctx); return r === undefined ? cardProp(game, card, charsOf(game, card), pr, ctx) : r; });
  });
}

function castSAProp(game, sa, card, prop, ctx) {
  if (prop.startsWith('!')) { const r = castSAProp(game, sa, card, prop.slice(1), ctx); return r === undefined ? undefined : !r; }
  const root = sa.root ? sa.root() : sa;
  const from = root.manaFrom || [];
  let m;
  if ((m = prop.match(/^ManaSpent (EQ|NE|LT|LE|GT|GE)(.+)$/))) return compare(manaTotal(root.manaSpent), m[1], calcCtx(game, m[2], ctx));
  if ((m = prop.match(/^ManaFromCreature_(\d+)$/))) return from.filter(x => x.creature).reduce((a, x) => a + x.n, 0) >= +m[1];
  if (ALT_COSTS.has(prop)) return root.altCost === prop;
  switch (prop) {
    case 'ManaFromTreasure': return !!root.manaFromTreasure;
    case 'ManaFromArtifact': return from.some(x => x.artifact);
    case 'ManaFromCard.StrictlySelf': return !!ctx.host && from.some(x => x.id === ctx.host.id);
    // cast thanks to this source's may-play permission (Jaya's emblem, Edgar, Serra Paragon)
    case 'MayPlaySource': return card.castMayPlayHost != null && (!ctx.host || card.castMayPlayHost === ctx.host.id);
    case 'Bargain': case 'Bargained': return !!root.bargained;
    case 'Kicked': return (root.kicked || 0) > 0;
    case 'ManaAbility': return root.api === 'Mana';
    case 'hasTapCost': return /(^|\s)T(\s|$)/.test((root.p && root.p.Cost) || '');
    case 'Modal': return root.api === 'Charm';
    case 'singleTarget': return root.chain().flatMap(s => s.targets || []).length === 1;
  }
  if ((m = prop.match(/^numTargets (EQ|NE|LT|LE|GT|GE)(\d+)$/))) return compare(root.chain().flatMap(s => s.targets || []).length, m[1], +m[2]);
  if ((m = prop.match(/^IsTargeting (?:Valid )?(.+)$/))) return root.chain().flatMap(s => s.targets || []).some(t => matchValid(game, t, m[1], ctx));
  return undefined;
}

// "hasAbility Activated.hasTapCost": one of a card's abilities ("otherAbility": not the one being checked for)
function abilityMatches(a, spec, ctx) {
  const [type, ...props] = spec.split('.');
  const kind = a.parsed.kind;
  if (type === 'Activated' && kind !== 'AB') return false;
  if (type === 'Static' && kind !== 'S') return false;
  return props.join('.').split('+').filter(Boolean).every(pr => {
    const neg = pr.startsWith('!'); const p0 = neg ? pr.slice(1) : pr;
    let r;
    if (p0 === 'hasTapCost') r = /(^|\s)T(\s|$)/.test(a.parsed.p.Cost || '');
    else if (p0 === 'ManaAbility') r = a.parsed.api === 'Mana';
    else if (p0 === 'otherAbility') r = !(ctx.sa && ctx.sa.key === a.key);
    else r = false;
    return neg ? !r : r;
  });
}

function defendingPlayer(game, ctx) {
  const t = ctx.trig;
  if (t && t.DefendingPlayer != null) return t.DefendingPlayer;
  if (t && t.Attacker && game.combat) { const d = game.attackTargetOf(t.Attacker); if (d != null) return d; }
  if (ctx.host && game.combat) { const d = game.attackTargetOf(ctx.host); if (d != null) return d; }
  return null;
}

// ---------- references ("Defined$")
function refList(game, ctx, kind) {
  const host = ctx.host;
  if (kind === 'Remembered') {
    if (ctx.sa && ctx.sa.rememberedOverride) return ctx.sa.rememberedOverride;
    return host ? (host.remembered || []) : [];
  }
  if (kind === 'Imprinted') return host ? (host.imprinted || []) : [];
  if (kind === 'Targeted') return ctx.sa ? findTargets(ctx.sa) : [];
  return [];
}

export function findTargets(sa) {
  for (let s = sa; s; s = s.parent) if (s.targets && s.targets.length) return s.targets;
  return [];
}

export function liveOrLki(game, o) {
  // map LKI snapshot to the live card if it is still the same object in the same zone
  if (!o) return null;
  if (o.lki) {
    const c = o.card;
    if (c && c.zcc === o.newZcc) return c;
    return o;
  }
  return o;
}

export function resolveDefined(game, defined, ctx) {
  const r = lookupDefined(game, defined, ctx);
  if (r) return r;
  unknownDefined.add(defined);
  return [];
}
export const unknownDefined = new Set();

// what a reference names, or null when it isn't one this engine knows
function lookupDefined(game, defined, ctx) {
  if (!defined) return [];
  if (defined.includes(' & ')) {
    const out = [];
    for (const part of defined.split(' & ')) for (const x of resolveDefined(game, part.trim(), ctx)) if (!out.includes(x)) out.push(x);
    return out;
  }
  // "Player.Chosen,You" (also written ".Chosen,You"): the union of the parts
  if (defined.startsWith('.')) defined = 'Player' + defined;
  if (/^[^\s$]+,[^\s$]+$/.test(defined) && !/^(Valid|Remembered\$)/.test(defined)) {
    const out = [];
    // ("Player.controlsEnchantment,controlsArtifact": the later parts are more player properties)
    const player = defined.startsWith('Player.');
    for (const part of defined.split(',')) for (const x of resolveDefined(game, part.startsWith('.') ? 'Player' + part : player && /^[a-z]/.test(part) ? 'Player.' + part : part, ctx)) if (!out.includes(x)) out.push(x);
    return out;
  }
  const { host, sa } = ctx;
  const you = game.players[ctx.you];
  const trig = ctx.trig || (sa && sa.trig) || {};
  const P = id => (id == null ? null : game.players[id]);
  const ctrlP = o => o ? P(ctrlOf(game, o)) : null;
  const ownerP = o => o ? (o.isPlayer ? o : P(o.owner)) : null;
  const flat = arr => arr.filter(Boolean);
  let m;
  switch (defined) {
    case 'Self': case 'CardUID': case 'OriginalHost':
      if (!host) return [];
      if (host.lki) return [host];
      if (sa && sa.hostZcc != null && host.zcc !== sa.hostZcc) return [];
      return [host];
    case 'You': return you ? [you] : [];
    case 'Opponent': case 'Player.Opponent': case 'Opponents': return game.livingPlayers().filter(p => game.isOpponent(p.id, ctx.you));
    case 'Player': case 'Players': return game.livingPlayers();
    case 'Player.Other': case 'Player.NonYou': return game.livingPlayers().filter(p => p.id !== ctx.you);
    case 'Targeted': case 'TargetedCard': case 'TargetedObjects': return sa ? findTargets(sa).map(x => liveOrLki(game, x)) : [];
    case 'TargetedPlayer': return sa ? findTargets(sa).filter(isPlayer) : [];
    case 'TargetedController': return flat(uniqP(sa ? findTargets(sa).map(x => x.isPlayer ? x : (x.stackItem ? P(x.stackItem.controller) : ctrlP(x))) : []));
    case 'TargetedOwner': return flat(uniqP(sa ? findTargets(sa).map(x => ownerP(x.stackItem ? x.card || x : x)) : []));
    case 'TargetedAndYou': return [...(sa ? findTargets(sa) : []), you];
    case 'ParentTarget': case 'ParentTargeted': return sa && sa.parent ? findTargets(sa.parent) : [];
    case 'ParentTargetedController': return sa && sa.parent ? flat(findTargets(sa.parent).map(ctrlP)) : [];
    case 'Remembered': case 'RememberedCard': case 'RememberedLKI': case 'RememberedObjects': case 'DirectRemembered': case 'RememberedCards': return refList(game, ctx, 'Remembered').map(x => x && x.isPlayer ? x : liveOrLki(game, x)).filter(Boolean);
    case 'RememberedPlayer': return refList(game, ctx, 'Remembered').filter(isPlayer);
    case 'RememberedController': return flat(uniqP(refList(game, ctx, 'Remembered').map(x => x.isPlayer ? x : ctrlP(x))));
    case 'RememberedOwner': return flat(uniqP(refList(game, ctx, 'Remembered').map(x => ownerP(x))));
    case 'RememberedFirst': return refList(game, ctx, 'Remembered').slice(0, 1);
    case 'Imprinted': case 'ImprintedLKI': case 'DirectImprinted': return refList(game, ctx, 'Imprinted').map(x => liveOrLki(game, x));
    case 'ImprintedController': return flat(uniqP(refList(game, ctx, 'Imprinted').map(ctrlP)));
    case 'Enchanted': case 'Equipped': case 'Attached': case 'Fortified': case 'AttachedTo': {
      if (!host || !host.attachedTo) return [];
      if (typeof host.attachedTo === 'string') return [P(+host.attachedTo.slice(1))];
      const c = game.cardById(host.attachedTo); return c ? [c] : [];
    }
    case 'EnchantedController': case 'EquippedController': case 'AttachedController': {
      if (!host || !host.attachedTo) return [];
      if (typeof host.attachedTo === 'string') return [P(+host.attachedTo.slice(1))];
      const c = game.cardById(host.attachedTo); return c ? [P(c.controller)] : [];
    }
    case 'EnchantedPlayer': return host && typeof host.attachedTo === 'string' ? [P(+host.attachedTo.slice(1))] : [];
    case 'EnchantedOwner': case 'EquippedOwner': { const c = host && game.cardById(host.attachedTo); return c ? [P(c.owner)] : []; }
    case 'TopOfLibrary': return you && you.library.length ? [you.library[0]] : [];
    case 'BottomOfLibrary': return you && you.library.length ? [you.library[you.library.length - 1]] : [];
    case 'ChosenCard': case 'ChosenCards': return host && host.chosen && host.chosen.cards ? host.chosen.cards.map(id => game.cardById(id)).filter(Boolean) : [];
    case 'ChosenPlayer': return host && host.chosen && host.chosen.player != null ? [P(host.chosen.player)] : [];
    case 'ChosenAndYou': return [...(host && host.chosen && host.chosen.player != null ? [P(host.chosen.player)] : []), you];
    case 'Sacrificed': case 'SacrificedCards': return (sa && sa.root().paid.Sacrificed) || [];
    case 'Discarded': case 'DiscardedCards': return (sa && sa.root().paid.Discarded) || [];
    case 'Exiled': case 'ExiledCards': return (sa && sa.root().paid.Exiled) || [];
    case 'Tapped': case 'TappedCards': return (sa && sa.root().paid.Tapped) || [];
    case 'Revealed': case 'RevealedCards': return (sa && sa.root().paid.Revealed) || [];
    // evidence collected as a cost (none unless it was)
    case 'Collected': return (sa && sa.root().paid.Collected) || [];
    case 'ExiledWith': case 'ExiledWithSource': case 'ExiledWithEffect': return host ? game.allCards().filter(c => c.zone === 'exile' && c.exiledWith === host.id) : [];
    case 'DelayTriggerRemembered': case 'DelayTriggerRememberedLKI': return (sa && sa.delayRemembered || []).map(x => x.isPlayer ? x : liveOrLki(game, x));
    case 'DelayTriggerRememberedController': return flat((sa && sa.delayRemembered || []).map(x => x.isPlayer ? x : ctrlP(x)));
    case 'ReplacedCard': case 'ReplacedNewCard': return trig.Card ? [trig.Card] : [];
    case 'ReplacedPlayer': case 'ReplacedTarget': return trig.Affected ? [trig.Affected] : (trig.Player != null ? [P(trig.Player)] : []);
    case 'ActivePlayer': return [P(game.activePlayer)];
    case 'DefendingPlayer': { const d = defendingPlayer(game, ctx); return d != null ? [P(d)] : []; }
    case 'AttackingPlayer': return [P(game.activePlayer)];
    case 'Parent': case 'OriginalHostCard': return host ? [host] : [];
    case 'CardOwner': return host ? [P(host.owner)] : [];
    case 'CardController': return host ? [P(ctrlOf(game, host))] : [];
    case 'TargetedOrController': return sa ? findTargets(sa).map(x => x.isPlayer ? x : P(ctrlOf(game, x))) : [];
    case 'ThisTargetedCard': return sa ? (sa.targets || []).filter(x => !x.isPlayer) : [];
    case 'ThisTargetedPlayer': return sa ? (sa.targets || []).filter(isPlayer) : [];
    case 'Chosen': case 'ChosenPlayers': return host && host.chosen && host.chosen.player != null ? [P(host.chosen.player)] : [];
    case 'NonChosenPlayer': return game.livingPlayers().filter(p => !(host && host.chosen && host.chosen.player === p.id));
    case 'ChosenCardController': return host && host.chosen && host.chosen.cards ? host.chosen.cards.map(id => game.cardById(id)).filter(Boolean).map(ctrlP) : [];
    case 'ImprintedOwner': return flat(uniqP(refList(game, ctx, 'Imprinted').map(ownerP)));
    case 'NextPlayerToYourRight': return [P(game.prevPlayer(ctx.you))];
    case 'Caster': return trig.Player != null ? [P(trig.Player)] : [you];
    case 'NonTargeted': return game.livingPlayers().filter(p => !(sa && findTargets(sa).includes(p)));
    case 'NonRememberedController': case 'OppNonRememberedController': { const r = refList(game, ctx, 'Remembered').map(x => x.isPlayer ? x.id : ctrlOf(game, x)); return game.livingPlayers().filter(p => !r.includes(p.id) && (defined.startsWith('Opp') ? p.id !== ctx.you : true)); }
    case 'Returned': return (sa && sa.root().returned) || [];
    case 'TargetedSource': return sa ? findTargets(sa).map(t => (t && t.stackItem ? (t.card || t.source) : t)).filter(Boolean) : [];
    case 'EffectSource': return host && host.hostCard ? [host.hostCard] : [];
    case 'Championed': return host && host.championed ? host.championed.map(r => { const c = game.cardById(r.id); return c && c.zcc === r.zcc && c.zone === 'exile' ? c : null; }).filter(Boolean) : [];
    case 'Promised': { const r = sa && sa.root ? sa.root() : null; const g = r && r.promisedGift != null ? r.promisedGift : host && host.promisedGift; return g != null ? [P(g)] : []; }
    case 'CorrectedSelf': return host ? [host] : [];
    case 'Convoked': return host ? (host.convokedBy || []).map(id => game.cardById(id)).filter(Boolean) : [];
    case 'Commander': case 'YourCommander': return you ? you.commanders.map(id => game.cardById(id)).filter(Boolean) : [];
    case 'Monarch': return game.monarch != null ? [P(game.monarch)] : [];
    case 'NextPlayerToYourLeft': case 'PlayerToYourLeft': return [P(game.nextPlayer(ctx.you))];
    case 'PlayerToYourRight': return [P(game.prevPlayer(ctx.you))];
    // (no teams here: every other player is an opponent, your team is you)
    case 'NextOpponentToYourLeft': { const p = game.nextPlayer(ctx.you); return p != null && p !== ctx.you ? [P(p)] : []; }
    case 'YourTeam': return you ? [you] : [];
    case 'SourceController': return host ? [P(ctrlOf(game, host))] : [];
    case 'ThisTargetedController': return flat(uniqP(sa ? (sa.targets || []).filter(x => !x.isPlayer).map(x => x.stackItem ? P(x.controller) : ctrlP(x)) : []));
    case 'ReplacedSource': return trig.Source || trig.DamageSource ? [trig.Source || trig.DamageSource] : [];
    // the player who chose the modes ("an opponent chooses one": Fatal Lore)
    case 'ChoosingPlayer': { const r = sa && sa.root ? sa.root() : null; return [P(r && r.choosingPlayer != null ? r.choosingPlayer : ctx.you)]; }
    // each player whose coin came up tails / heads (Goblin Assassin, Mana Clash)
    case 'FlippedTails': case 'FlippedHeads': { const fr = (host && host.flipResults) || {}; return game.livingPlayers().filter(p => fr[p.id] === defined.slice(7)); }
  }
  // "Spawner>TriggeredCard": as the ability that set up this delayed trigger saw it; "CastSA>Collected": as the spell
  // this permanent was cast as saw it
  if ((m = defined.match(/^(Spawner|CastSA)>(.+)$/))) return lookupDefined(game, m[2], shiftedContext(m[1], ctx));
  if ((m = defined.match(/^Triggered(\w+?)(LKICopy)?$/))) {
    return triggeredRef(game, m[1], trig, !!m[2], ctx);
  }
  // "AttachedTo Targeted.Aura,Equipment": what's attached to them (of those types)
  if ((m = defined.match(/^AttachedTo (\S+?)(?:\.(.+))?$/))) {
    const atts = resolveDefined(game, m[1], ctx).flatMap(o => attachedTo(game, o));
    return m[2] ? atts.filter(a => matchValid(game, a, m[2].split(',').map(v => 'Card.' + v).join(','), ctx)) : atts;
  }
  // "NonTriggeredCardController", "NonReplacedPlayer": every player but those ("OppNon...": every opponent but those)
  if ((m = defined.match(/^(Opp)?Non([A-Z]\w+)$/))) {
    const not = lookupDefined(game, m[2], ctx);
    if (not) { const ids = not.map(x => x.isPlayer ? x.id : null); return game.livingPlayers().filter(p => !ids.includes(p.id) && (!m[1] || game.isOpponent(p.id, ctx.you))); }
  }
  // "Top_4_OfLibrary": the top cards of your library
  if ((m = defined.match(/^Top_(\w+)_OfLibrary$/))) return you ? you.library.slice(0, calcCtx(game, m[1], ctx)) : [];
  if ((m = defined.match(/^(Valid|ValidAll|ValidGraveyard|ValidHand|ValidExile|ValidLibrary|ValidStack|ValidCommand) (.+)$/))) {
    const zone = { Valid: 'battlefield', ValidAll: 'all', ValidGraveyard: 'graveyard', ValidHand: 'hand', ValidExile: 'exile', ValidLibrary: 'library', ValidStack: 'stack', ValidCommand: 'command' }[m[1]];
    if (/^(Player|Opponent|You)/.test(m[2])) return game.livingPlayers().filter(p => matchValid(game, p, m[2], ctx));
    return game.cardsInZone(zone).filter(c => matchValid(game, c, m[2], ctx));
  }
  if ((m = defined.match(/^(Player|Opponent)\.(.+)$/)) || (m = defined.match(/^(Player|Opponent)$/))) {
    return game.livingPlayers().filter(p => matchValid(game, p, defined, ctx));
  }
  if ((m = defined.match(/^Remembered\$/))) return refList(game, ctx, 'Remembered');
  // "AttachedBy Self": what the source is attached to
  if ((m = defined.match(/^(AttachedBy|EnchantedBy|EquippedBy) (.+)$/))) {
    return resolveDefined(game, m[2], ctx).filter(o => o && o.isCard && o.attachedTo != null).map(o => typeof o.attachedTo === 'string' && o.attachedTo.startsWith('p') ? game.players[+o.attachedTo.slice(1)] : game.cardById(o.attachedTo)).filter(Boolean);
  }
  if ((m = defined.match(/^(\w+)\.(.+)$/)) && !/^(Player|Opponent|Valid)/.test(m[1])) {
    const base = lookupDefined(game, m[1], ctx);
    if (base) return base.filter(o => o.isPlayer ? matchValid(game, o, 'Player.' + m[2], ctx) : matchValid(game, o, 'Card.' + m[2], ctx));
  }
  return null;
}

// what's attached to a player or permanent; to one that has left the battlefield, what was as it left (Fumble)
function attachedTo(game, o) {
  if (!o || o.stackItem) return [];
  if (o.isPlayer) return game.battlefield.filter(a => a.attachedTo === 'p' + o.id);
  let lki = o.lki ? o : null;
  if (!lki && o.zone !== 'battlefield') for (let i = game.turnState.moves.length - 1; i >= 0 && !lki; i--) { const mv = game.turnState.moves[i]; if (mv.card === o && mv.from === 'battlefield') lki = mv.lki; }
  return lki ? (lki.attachments || []).map(id => game.cardById(id)).filter(a => a && a.zone === 'battlefield') : game.attachmentsOf(o);
}

function shiftedContext(kind, ctx) {
  const r = ctx.sa && ctx.sa.root ? ctx.sa.root() : ctx.sa;
  const other = kind === 'Spawner' ? r && r.spawner : ctx.host && ctx.host.castSA;
  return other ? { ...ctx, sa: other, trig: other.trig } : ctx;
}

function uniqP(arr) {
  const out = [];
  for (const x of arr) if (x && !out.includes(x)) out.push(x);
  return out;
}

function triggeredRef(game, what, trig, lkiCopy, ctx) {
  const P = id => (id == null ? null : game.players[id]);
  const asCard = (o) => {
    if (!o) return null;
    if (o.isPlayer) return o;
    if (o.lki) return liveOrLki(game, o);
    return o;
  };
  const cardKeys = { Card: 'Card', NewCard: 'Card', Attacker: 'Attacker', Blocker: 'Blocker', Source: 'Source', Spell: 'Card', Object: 'Card', Defender: 'Defender', SpellAbilityTargets: 'Targets', Sacrificed: 'Card', Cards: 'Cards', Attackers: 'Attackers', Blockers: 'Blockers', Exploited: 'Card', Crew: 'Crew', AttachSource: 'AttachSource', AttachTarget: 'AttachTarget', Equipment: 'AttachSource', Token: 'Card', Discarded: 'Card' };
  switch (what) {
    case 'Player': case 'Activator': case 'ActivatingPlayer': case 'Caster': case 'Drawer': return trig.Player != null ? [P(trig.Player)] : [];
    case 'Target': {
      const t = trig.Target;
      if (t == null) return [];
      return Array.isArray(t) ? t.map(asCard) : [asCard(t)];
    }
    case 'Defender': case 'DefendingPlayer': {
      if (trig.DefendingPlayer != null) return [P(trig.DefendingPlayer)];
      if (trig.Defender) return [asCard(trig.Defender)];
      return [];
    }
    case 'AttackingPlayer': return trig.AttackingPlayer != null ? [P(trig.AttackingPlayer)] : [P(game.activePlayer)];
    case 'CardController': case 'NewCardController': case 'SpellAbilityController': case 'SourceController': case 'AttackerController': case 'ObjectController': case 'BlockerController': {
      const k = what.replace('Controller', '');
      const o = trig[cardKeys[k] || k] || trig.Card;
      if (!o) return trig.Player != null ? [P(trig.Player)] : [];
      return [P(ctrlOf(game, o.lki ? o : o))];
    }
    case 'CardOwner': case 'NewCardOwner': case 'SourceOwner': { const o = trig.Source && what === 'SourceOwner' ? trig.Source : trig.Card; return o ? [P(o.owner)] : []; }
    case 'TargetController': { const t = trig.Target; if (!t) return []; return [t.isPlayer ? t : P(ctrlOf(game, t))]; }
    case 'SpellAbility': case 'SA': case 'SourceSA': return trig.StackItem ? [trig.StackItem] : (trig.Card ? [trig.Card] : []);
    case 'Remembered': return ctx.sa && ctx.sa.trigRemembered || [];
    case 'OpponentVotedSame': case 'OpponentVotedDiff': {
      const votes = trig.Votes || {}, mine = votes[ctx.you] || [];
      return game.livingPlayers().filter(p => game.isOpponent(p.id, ctx.you) && votes[p.id] && (what === 'OpponentVotedSame' ? votes[p.id].some(v => mine.includes(v)) : votes[p.id].some(v => !mine.includes(v))));
    }
  }
  const key = cardKeys[what] || what;
  const v = trig[key];
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(asCard).filter(Boolean);
  if (typeof v === 'number') return [P(v)];
  return [lkiCopy && v.lki ? v : asCard(v)].filter(Boolean);
}

// ---------- numeric expressions
export function calc(game, expr, sa, extra) {
  const ctx = sa ? ctxOf(game, sa) : extra;
  return calcCtx(game, expr, ctx);
}

export function ctxOf(game, sa) {
  return { host: sa.host, you: sa.controller, sa, trig: sa.trig };
}

// values written by StoreSVar live on the host card for as long as it stays the same object (zone change resets them)
function storedSVar(ctx, name) {
  const h = ctx && (ctx.host || (ctx.sa && ctx.sa.host));
  const st = h && h.storedSVars;
  return st && st.zcc === h.zcc && st.v[name] != null ? st.v[name] : null;
}
function svarLookup(ctx, name) {
  const stored = storedSVar(ctx, name);
  if (stored != null) return stored;
  return ctx && ctx.sa && ctx.sa.svars ? ctx.sa.svars[name] : undefined;
}

export function calcCtx(game, expr, ctx) {
  if (expr == null || expr === '') return 0;
  if (typeof expr === 'number') return expr;
  let s = String(expr).trim();
  if (/^[+-]?\d+$/.test(s)) return parseInt(s, 10);
  let sign = 1;
  if (s.startsWith('+')) s = s.slice(1);
  else if (s.startsWith('-')) { sign = -1; s = s.slice(1); }
  const sv = svarLookup(ctx, s);
  if (sv != null && sv !== s) return sign * evalExpr(game, sv, ctx, 0);
  if (ctx && ctx.svars && ctx.svars[s] != null) return sign * evalExpr(game, ctx.svars[s], ctx, 0);
  if (s === 'X') return sign * xPaid(ctx);
  if (s === 'Y' || s === 'Z') return 0;
  return sign * evalExpr(game, s, ctx, 0);
}

function xPaid(ctx) {
  const sa = ctx && ctx.sa;
  if (sa) { const r = sa.root(); if (r.x != null) return r.x; }
  if (ctx && ctx.host && ctx.host.xPaid) return ctx.host.xPaid;
  return 0;
}

function applyMath(n, math, game, ctx) {
  if (!math) return n;
  for (const op of math.split('/').filter(Boolean)) {
    const [name, argRaw] = op.split('.');
    const arg = argRaw != null ? (/^-?\d+$/.test(argRaw) ? +argRaw : calcCtx(game, argRaw, ctx)) : null;
    switch (name) {
      case 'Times': n = n * arg; break;
      case 'Plus': n = n + arg; break;
      case 'Minus': n = n - arg; break;
      case 'Twice': n = n * 2; break;
      case 'Thrice': n = n * 3; break;
      case 'HalfUp': n = Math.ceil(n / 2); break;
      case 'HalfDown': n = Math.floor(n / 2); break;
      case 'DivideEvenlyDown': n = Math.floor(n / arg); break;
      case 'DivideEvenlyUp': n = Math.ceil(n / arg); break;
      case 'Negative': n = -n; break;
      case 'LimitMax': n = Math.min(n, arg); break;
      case 'LimitMin': n = Math.max(n, arg); break;
      case 'Mod': n = n % arg; break;
      case 'Abs': n = Math.abs(n); break;
      case 'NMinus': n = arg - n; break;
      case 'Double': n = n * 2; break;
      default: break;
    }
  }
  return n;
}

function cardStat(game, card, stat, ctx) {
  if (!card) return 0;
  if (card.isPlayer) {
    if (stat === 'LifeTotal') return card.life;
    if (stat === 'CardsInHand') return card.hand.length;
    return 0;
  }
  const ch = charsOf(game, card.stackItem ? card.card : card);
  if (!ch) return 0;
  let m;
  switch (stat) {
    case 'CardPower': case 'Power': return ch.power;
    case 'CardToughness': case 'Toughness': return ch.toughness;
    case 'CardManaCost': case 'CardManaCostLKI': case 'CMC': return ch.cmc;
    case 'CardNumColors': return ch.colors.size;
    case 'CardNumTypes': return ch.types.size;
    case 'Amount': return 1;
    case 'CardLoyalty': return (card.counters || {}).LOYALTY || 0;
    case 'CardSumPower': return ch.power;
  }
  if ((m = stat.match(/^CardCounters\.(\w+)$/))) return m[1] === 'ALL' ? Object.values(card.counters || {}).reduce((a, b) => a + b, 0) : ((card.counters || {})[m[1]] || 0);
  // "TriggeredCard$Valid Creature.attacking": 1 if the object matches
  if ((m = stat.match(/^Valid (.+)$/))) return matchValid(game, card, m[1], ctx) ? 1 : 0;
  return 0;
}

const zoneMap = { BottomOfLibrary: 'library', TopOfLibrary: 'library', Hand: 'hand', Graveyard: 'graveyard', Exile: 'exile', Library: 'library', Battlefield: 'battlefield', Command: 'command', Stack: 'stack' };

export function evalExpr(game, expr, ctx, depth) {
  if (depth > 12) return 0;
  expr = String(expr).trim();
  if (/^-?\d+$/.test(expr)) return +expr;
  let m;
  if ((m = expr.match(/^Number\$(-?\d+)$/))) return +m[1];
  if ((m = expr.match(/^SVar\$(\w+)(.*)$/))) return applyMath(calcCtx(game, m[1], ctx), m[2], game, ctx);
  // split "Head$Rest/Math"
  const d = expr.indexOf('$');
  if (d < 0) {
    const sv = svarLookup(ctx, expr);
    if (sv != null && sv !== expr) return evalExpr(game, sv, ctx, depth + 1);
    return 0;
  }
  const head = expr.slice(0, d);
  if ((m = head.match(/^(Spawner|CastSA)>(.+)$/))) return evalExpr(game, m[2] + expr.slice(d), shiftedContext(m[1], ctx || {}), depth + 1);
  let rest = expr.slice(d + 1);
  // math suffix: last "/Op" segments (only when they look like math ops)
  let math = '';
  const mm = rest.match(/((?:\/(?:Times|Plus|Minus|Twice|Thrice|HalfUp|HalfDown|DivideEvenlyDown|DivideEvenlyUp|Negative|LimitMax|LimitMin|Mod|Abs|NMinus|Double)(?:\.[-\w]+)?)+)$/);
  if (mm) { math = mm[1]; rest = rest.slice(0, rest.length - math.length); }
  const host = ctx && ctx.host;
  const you = ctx ? game.players[ctx.you] : null;
  const sa = ctx && ctx.sa;
  const trig = (ctx && ctx.trig) || (sa && sa.trig) || {};
  let n = 0;
  switch (head) {
    case 'Count': n = countExpr(game, rest, ctx, depth); break;
    case 'DungeonsCompleted': n = you ? you.dungeonsCompleted.length : 0; break;
    case 'Targeted': case 'ParentTargeted': {
      const ts = head === 'ParentTargeted' && sa && sa.parent ? findTargets(sa.parent) : (sa ? findTargets(sa) : []);
      if (rest === 'Amount') n = ts.length;
      else n = ts.reduce((a, t) => a + cardStat(game, t, rest, ctx), 0);
      break;
    }
    case 'TargetedPlayer': {
      const ts = sa ? findTargets(sa).filter(isPlayer) : [];
      const p = ts[0];
      if (!p) { n = 0; break; }
      if (rest === 'LifeTotal') n = p.life;
      else if (rest === 'CardsInHand') n = p.hand.length;
      else if (rest === 'Amount') n = ts.length;
      else if (rest.startsWith('CardsInGraveyard')) n = p.graveyard.length;
      else n = 0;
      break;
    }
    case 'TargetedController': { const ts = sa ? findTargets(sa) : []; const p = ts[0] && game.players[ctrlOf(game, ts[0])]; n = p ? playerProperty(game, p, rest, ctx) : 0; break; }
    case 'TriggeredCard': case 'TriggeredNewCard': case 'TriggeredCardLKICopy': case 'TriggeredNewCardLKICopy': case 'TriggeredAttacker': case 'TriggeredBlocker': case 'TriggeredSource': case 'TriggeredSpellAbility': case 'TriggeredObject': case 'TriggeredCards': case 'TriggeredSacrificed': {
      const key = { TriggeredAttacker: 'Attacker', TriggeredBlocker: 'Blocker', TriggeredSource: 'Source' }[head] || 'Card';
      let o = trig[key];
      if (head === 'TriggeredCards') { n = rest === 'Amount' ? (trig.Cards || []).length : (trig.Cards || []).reduce((a, c) => a + cardStat(game, c, rest, ctx), 0); break; }
      if (o && o.lki == null && trig.CardLKI && key === 'Card') o = trig.CardLKI;
      n = rest === 'Amount' ? (o ? 1 : 0) : cardStat(game, o, rest, ctx);
      break;
    }
    case 'TriggerCount': n = +(trig[rest] != null ? trig[rest] : 0) || 0; break;
    case 'TriggeredPlayersOpponentVotedSame': case 'TriggeredPlayersOpponentVotedDiff': n = resolveDefined(game, head.replace('TriggeredPlayers', 'Triggered'), ctx).length; break;
    case 'ReplaceCount': n = +(trig[rest] != null ? trig[rest] : 0) || 0; break;
    case 'TriggeredPlayer': { const p = trig.Player != null ? game.players[trig.Player] : null; n = p ? (rest === 'LifeTotal' ? p.life : rest === 'CardsInHand' ? p.hand.length : 0) : 0; break; }
    case 'TriggerRemembered': n = (sa && sa.trigRemembered || []).length; break;
    case 'Remembered': case 'RememberedLKI': {
      const list = refList(game, ctx, 'Remembered');
      if (rest === 'Amount' || rest === 'Size') n = list.length;
      else if (rest === 'Valid') n = list.length;
      else if (rest.startsWith('Valid ')) {
        const [v, st] = rest.slice(6).split('$');
        const l2 = list.filter(x => matchValid(game, x, v, ctx));
        n = st ? l2.reduce((a, c) => a + cardStat(game, c, st, ctx), 0) : l2.length;
      }
      else n = list.reduce((a, c) => a + cardStat(game, c, rest, ctx), 0);
      break;
    }
    case 'Imprinted': { const list = refList(game, ctx, 'Imprinted'); n = rest === 'Amount' ? list.length : list.reduce((a, c) => a + cardStat(game, c, rest, ctx), 0); break; }
    case 'Emerged': { const r = sa && sa.root ? sa.root() : null; const lki = (r && r.emerged) || (host && host.castSA && host.castSA.emerged); n = lki ? cardStat(game, lki, rest, ctx) : 0; break; }
    case 'Sacrificed': case 'Discarded': case 'Exiled': case 'Tapped': case 'Revealed': {
      const list = sa ? (sa.root().paid[head] || []) : [];
      n = rest === 'Amount' ? list.length : list.reduce((a, c) => a + cardStat(game, c, rest, ctx), 0);
      break;
    }
    case 'Enchanted': case 'Equipped': {
      const c = host && host.attachedTo && typeof host.attachedTo !== 'string' ? game.cardById(host.attachedTo) : null;
      n = cardStat(game, c, rest, ctx);
      break;
    }
    case 'PlayerCountOpponents': case 'PlayerCountPlayers': case 'PlayerCountOtherPlayers': case 'PlayerCountDefinedOpponents': {
      const list = head === 'PlayerCountPlayers' ? game.livingPlayers() : head === 'PlayerCountOtherPlayers' ? game.livingPlayers().filter(p => p.id !== ctx.you) : game.livingPlayers().filter(p => game.isOpponent(p.id, ctx.you));
      n = playerCount(game, list, rest, ctx);
      break;
    }
    case 'PlayerCountPropertyYou': n = playerCount(game, [you], rest, ctx); break;
    case 'ChosenNumber': n = host && host.chosen ? (host.chosen.number || 0) : 0; break;
    case 'Defined': case 'DefinedCard': n = 0; break;
    default: n = head.startsWith('PlayerCountDefined') ? playerCount(game, resolveDefined(game, head.slice(18), ctx).filter(isPlayer), rest, ctx) : 0;
  }
  return applyMath(n, math, game, ctx);
}

function playerCount(game, list, rest, ctx) {
  let m;
  if (rest === 'Amount') return list.length;
  if ((m = rest.match(/^(Highest|Lowest)(.+)$/))) {
    const vals = list.map(p => playerProperty(game, p, m[2], ctx));
    if (!vals.length) return 0;
    return m[1] === 'Highest' ? Math.max(...vals) : Math.min(...vals);
  }
  if ((m = rest.match(/^Sum(.+)$/))) return list.reduce((a, p) => a + playerProperty(game, p, m[1], ctx), 0);
  return list.reduce((a, p) => a + playerProperty(game, p, rest, ctx), 0);
}

function playerProperty(game, p, prop, ctx) {
  let m;
  if (prop === 'LifeTotal') return p.life;
  if (prop === 'CardsInHand') return p.hand.length;
  if (prop === 'CardsInGraveyard') return p.graveyard.length;
  if (prop === 'LifeLostThisTurn') return p.lifeLostThisTurn;
  if (prop === 'LifeGainedThisTurn') return p.lifeGainedThisTurn;
  if (prop === 'RingTemptedYou') return p.ringTempted || 0;
  if (prop === 'Speed') return p.speed || 0;
  if ((m = prop.match(/^Valid([\w,]*) (.+)$/))) {
    const zones = m[1] ? m[1].split(',').map(z => zoneMap[z] || 'battlefield') : ['battlefield'];
    let n = 0;
    for (const zone of zones) {
      const pool = zone === 'battlefield' ? game.battlefield.filter(c => c.controller === p.id) : game.zone(p.id, zone);
      n += pool.filter(c => matchValid(game, c, m[2], { ...ctx, you: p.id })).length;
    }
    return n;
  }
  if (prop === 'DamageThisTurn' || prop === 'DamageDoneThisTurn') return game.turnState.damagedPlayers[p.id] || 0;
  if (prop === 'OppsAtLifeTotal') return 0;
  return 0;
}

function countExpr(game, rest, ctx, depth) {
  const host = ctx && ctx.host;
  const youId = ctx ? ctx.you : 0;
  const you = game.players[youId];
  const sa = ctx && ctx.sa;
  let m;
  switch (rest) {
    case 'xPaid': case 'XPaid': return xPaid(ctx);
    case 'TriggerRememberAmount': { const r = sa && sa.root ? sa.root() : sa; return (r && r.triggerRememberAmount) || (sa && sa.triggerRememberAmount) || 0; }
    case 'CardPower': return host ? charsOf(game, host).power : 0;
    case 'CardToughness': return host ? charsOf(game, host).toughness : 0;
    case 'CardManaCost': return host ? charsOf(game, host).cmc : 0;
    case 'CardsInYourHand': case 'InYourHand': return you.hand.length;
    case 'InYourLibrary': return you.library.length;
    case 'InYourYard': case 'CardsInYourGraveyard': return you.graveyard.length;
    case 'YourLifeTotal': return you.life;
    case 'OppLifeTotal': { const opps = game.livingPlayers().filter(p => game.isOpponent(p.id, youId)); return opps.length ? Math.max(...opps.map(p => p.life)) : 0; }
    case 'YourStartingLife': return 40;
    case 'LifeYouGainedThisTurn': return you.lifeGainedThisTurn;
    case 'LifeYouLostThisTurn': return you.lifeLostThisTurn;
    case 'LifeOppsLostThisTurn': return game.livingPlayers().filter(p => game.isOpponent(p.id, youId)).reduce((a, p) => a + p.lifeLostThisTurn, 0);
    case 'TimesKicked': return host ? host.kicked || 0 : 0;
    case 'ChosenNumber': return host && host.chosen ? host.chosen.number || 0 : 0;
    case 'CommanderCastFromCommandZone': return host ? (you.commanderCasts[host.id] || 0) : 0;
    case 'TotalCommanderCastFromCommandZone': return Object.values(you.commanderCasts).reduce((a, b) => a + b, 0);
    case 'YourTurns': return game.turnState.turnsTaken ? game.turnState.turnsTaken[youId] || 0 : 0;
    case 'Domain': { const types = new Set(); for (const c of game.battlefield) if (c.controller === youId) for (const t of game.chars(c).subtypes) if (BASIC_LAND_TYPES[t]) types.add(t); return types.size; }
    case 'RememberedSize': case 'RememberedNumber': return (host && host.remembered || []).length;
    case 'ImprintedSize': return (host && host.imprinted || []).length;
    case 'CardNumColors': return host ? charsOf(game, host).colors.size : 0;
    case 'NumColorsCommander': case 'CommanderColors': return you.colorIdentity.length;
    case 'Monarch': return game.monarch === youId ? 1 : 0;
    case 'IsMonarch': return game.monarch === youId ? 1 : 0;
    case 'YouCtrlCommander': return game.battlefield.some(c => c.isCommander && c.controller === youId) ? 1 : 0;
    case 'Converge': return host && host.manaSpent ? Object.keys(host.manaSpent).filter(k => k !== 'C' && host.manaSpent[k] > 0).length : 0;
    case 'Threshold': return you.graveyard.length >= 7 ? 1 : 0;
    case 'Delirium': return graveyardTypes(game, you) >= 4 ? 1 : 0;
    case 'Metalcraft': return game.battlefield.filter(c => c.controller === youId && game.chars(c).types.has('Artifact')).length >= 3 ? 1 : 0;
    case 'Hellbent': return you.hand.length === 0 ? 1 : 0;
    case 'Revolt': return game.turnState.permanentLeft && game.turnState.permanentLeft[youId] ? 1 : 0;
    case 'Ferocious': return game.battlefield.some(c => c.controller === youId && game.chars(c).types.has('Creature') && game.chars(c).power >= 4) ? 1 : 0;
    case 'DescendedThisTurn': return 0;
    case 'CardsDrawnThisTurn': case 'YouDrewThisTurn': return you.cardsDrawnThisTurn;
    case 'SpellsCastThisTurn': return game.turnState.spellsCast.length;
    case 'YouCastThisTurn': return you.spellsCastThisTurn.length;
    case 'StormCount': return Math.max(0, game.turnState.spellsCast.length - 1);
    case 'Night': return game.dayNight === 'Night' ? 1 : 0;
    case 'Day': return game.dayNight === 'Day' ? 1 : 0;
    case 'CardCounters.ALL': return host ? Object.values(host.counters || {}).reduce((a, b) => a + b, 0) : 0;
    case 'YourDamageThisTurn': return 0;
    case 'Devotion': return 0;
    case 'NumOpponents': return game.livingPlayers().filter(p => game.isOpponent(p.id, youId)).length;
    case 'CreaturesDiedThisTurn': return game.turnState.creaturesDied || 0;
    case 'Initiative': return game.initiative === youId ? 1 : 0;
    case 'ManaPool:All': return Object.values(you.pool).reduce((a, b) => a + b, 0);
    case 'CardNumAttacksThisTurn': return host ? ((game.turnState.attackCounts || {})[host.id] || 0) : 0;
    case 'Speed': return you.speed || 0;
    case 'CardTypesInGraveyard': return graveyardTypes(game, you);
    case 'OpponentsAttacked': return game.combat ? Math.max(1, new Set(game.combat.attackers.map(a => a.defenderPlayer)).size) : 1;
    case 'SquadCount': return host ? host.squad || 0 : 0;
    case 'OffspringPaid': return host ? host.offspring || 0 : 0;
    case 'Evoked': return host && (host.evoked || host.altCost === 'Evoke') ? 1 : 0;
    case 'Blitzed': return host && (host.blitzed || host.altCost === 'Blitz') ? 1 : 0;
    case 'EchoDue': return host && !host.echoPaid && host.enteredTurn < game.turnNumber ? 1 : 0;
    case 'Renowned': return host && host.renowned ? 1 : 0;
    case 'HighestCMC_Creature.YouCtrl': return Math.max(0, ...game.battlefield.filter(c => c.controller === youId && game.chars(c).types.has('Creature')).map(c => game.chars(c).cmc));
  }
  if ((m = rest.match(/^CardCounters\.(\w+)$/))) return host ? ((host.counters || {})[m[1]] || 0) : 0;
  if ((m = rest.match(/^Initiative\.(\d+)\.(\d+)$/))) return game.initiative === youId ? +m[1] : +m[2];
  if ((m = rest.match(/^(Night|Day|AllFourBend)\.(\d+)\.(\d+)$/))) return (m[1] === 'AllFourBend' ? !!you.bends && you.bends.turn === game.turnNumber && you.bends.kinds.length >= 4 : game.dayNight === m[1]) ? +m[2] : +m[3];
  // Urza's Mine / Power-Plant / Tower: more mana with the full set
  if ((m = rest.match(/^UrzaLands\.(\d+)\.(\d+)$/))) {
    const mine = game.battlefield.filter(c => c.controller === youId && game.chars(c).subtypes.has("Urza's"));
    const has = t => mine.some(c => game.chars(c).subtypes.has(t));
    return has('Mine') && has('Power-Plant') && has('Tower') ? +m[1] : +m[2];
  }
  if ((m = rest.match(/^Kicked\.(\d+)\.(\d+)$/))) return host && host.kicked ? +m[1] : +m[2];
  // "<flag>.A.B": A if the flag holds for this spell (or the permanent it became), else B (values may be SVars)
  if ((m = rest.match(/^(PromisedGift|OptionalGenericCostPaid|Emerged|Presence_(\w+))\.([-\w]+)\.([-\w]+)$/))) {
    const r = sa && sa.root ? sa.root() : null;
    const cast = host && host.castSA;
    const flag = m[1] === 'PromisedGift' ? ((r && r.promisedGift != null) || (host && host.promisedGift != null))
      : m[1] === 'OptionalGenericCostPaid' ? !!((r && r.optionalCostPaid) || (cast && cast.optionalCostPaid))
      : m[1] === 'Emerged' ? !!((r && r.emerged) || (cast && cast.emerged))
      : [r, cast].some(x => x && (x.castPresence || []).includes(m[2]));
    return calcCtx(game, flag ? m[3] : m[4], ctx);
  }
  if ((m = rest.match(/^AltCost\.(\d+)\.(\d+)$/))) { const r = sa && sa.root(); return (r && r.altCost) || (host && host.altCost) ? +m[1] : +m[2]; }
  // "ValidGraveyard Card.YouOwn$CardTypes", "ValidBattlefield,Graveyard Card.YouCtrl$CardTypes", "ThisTurnCast_Card.YouCtrl$CardTypes"
  if ((m = rest.match(/^(?:Valid(Hand|Graveyard|Exile|Library|Battlefield(?:,Graveyard)?)? |ThisTurnCast_)(.+?)\$(Colors|CardTypes|CardTypesPermanent|DifferentColorPair|DifferentCardNames|DifferentCardPower|DifferentCardManaCost|CreatureType|GreatestCardManaCost|LeastCardPower|CardToughness|CardPower|CardManaCost|SumCMC)$/))) {
    const pool = rest.startsWith('ThisTurnCast_') ? game.turnState.spellsCast.map(s => s.lki) : (m[1] || 'Battlefield').split(',').flatMap(z => game.cardsInZone(zoneMap[z]));
    const chs = pool.filter(c => matchValid(game, c, m[2], ctx)).map(c => charsOf(game, c));
    switch (m[3]) {
      case 'Colors': { const s = new Set(); chs.forEach(c => c.colors.forEach(x => s.add(x))); return s.size; }
      case 'CardTypes': { const s = new Set(); chs.forEach(c => c.types.forEach(x => s.add(x))); return s.size; }
      case 'CardTypesPermanent': { const s = new Set(); chs.forEach(c => c.types.forEach(x => { if (PERMANENT_TYPES.includes(x)) s.add(x); })); return s.size; }
      // "the number of different two-color combinations among permanents you control" (Niv-Mizzet, Guildpact)
      case 'DifferentColorPair': { const s = new Set(); chs.forEach(c => { const cs = COLORS.filter(x => c.colors.has(x)); cs.forEach((a, i) => cs.slice(i + 1).forEach(b => s.add(a + b))); }); return s.size; }
      case 'LeastCardPower': return chs.length ? Math.min(...chs.map(c => c.power)) : 0;
      case 'DifferentCardNames': return new Set(chs.map(c => c.name)).size;
      case 'DifferentCardPower': return new Set(chs.map(c => c.power)).size;
      case 'DifferentCardManaCost': return new Set(chs.map(c => c.cmc)).size;
      case 'CreatureType': { const counts = {}; chs.forEach(c => c.subtypes.forEach(t => counts[t] = (counts[t] || 0) + 1)); return Math.max(0, ...Object.values(counts)); }
      case 'GreatestCardManaCost': return chs.length ? Math.max(...chs.map(c => c.cmc)) : 0;
      case 'CardToughness': return chs.reduce((a, c) => a + c.toughness, 0);
      case 'CardPower': return chs.reduce((a, c) => a + c.power, 0);
      case 'CardManaCost': case 'SumCMC': return chs.reduce((a, c) => a + c.cmc, 0);
    }
  }
  if ((m = rest.match(/^Compare (\w+) ?(EQ|NE|LT|LE|GT|GE)([-\w]+)\.([-\w]+)\.([-\w]+)$/))) {
    const a = calcCtx(game, m[1], ctx), b = calcCtx(game, m[3], ctx);
    return compare(a, m[2], b) ? calcCtx(game, m[4], ctx) : calcCtx(game, m[5], ctx);
  }
  if ((m = rest.match(/^(Valid|ValidHand|ValidGraveyard|ValidExile|ValidLibrary|ValidBattlefield|ValidStack|ValidCommand|ValidAll) (.+?)(\$(CardPower|CardToughness|CardManaCost|SumPower|SumToughness|GreatestCardPower|GreatestCardToughness|GreatestCardManaCost|GreatestCMC|CardCounters\.\w+))?$/))) {
    const zone = { Valid: 'battlefield', ValidBattlefield: 'battlefield', ValidHand: 'hand', ValidGraveyard: 'graveyard', ValidExile: 'exile', ValidLibrary: 'library', ValidStack: 'stack', ValidCommand: 'command', ValidAll: 'all' }[m[1]];
    const list = game.cardsInZone(zone).filter(c => matchValid(game, c, m[2], ctx));
    if (!m[4]) return list.length;
    const st = m[4];
    if (st.startsWith('Greatest')) { const s2 = st.replace('Greatest', '').replace('CMC', 'CardManaCost'); return list.length ? Math.max(...list.map(c => cardStat(game, c, s2.startsWith('Card') ? s2 : 'Card' + s2, ctx))) : 0; }
    if (st.startsWith('Sum')) return list.reduce((a, c) => a + cardStat(game, c, 'Card' + st.slice(3), ctx), 0);
    return list.reduce((a, c) => a + cardStat(game, c, st, ctx), 0);
  }
  if ((m = rest.match(/^(GreatestPower|GreatestToughness|GreatestCMC|SumPower|SumToughness|SumCMC|HighestCMC|LowestLife)_(.+)$/))) {
    const list = game.battlefield.filter(c => matchValid(game, c, m[2], ctx));
    const stat = c => { const ch = game.chars(c); return /Power/.test(m[1]) ? ch.power : /Toughness/.test(m[1]) ? ch.toughness : ch.cmc; };
    if (m[1].startsWith('Sum')) return list.reduce((a, c) => a + stat(c), 0);
    return list.length ? Math.max(...list.map(stat)) : 0;
  }
  if ((m = rest.match(/^ThisTurnEntered_([A-Za-z]+)_(?:from_([A-Za-z]+)_)?(.+)$/))) {
    const dest = zoneMap[m[1]] || m[1].toLowerCase();
    const orig = m[2] ? (zoneMap[m[2]] || m[2].toLowerCase()) : null;
    return game.turnState.moves.filter(e => e.to === dest && (!orig || e.from === orig) && matchValid(game, e.lki || e.card, m[3], ctx)).length;
  }
  if ((m = rest.match(/^ThisTurnCast_(.+)$/))) return game.turnState.spellsCast.filter(s => matchValid(game, s.lki, m[1], ctx)).length;
  if ((m = rest.match(/^Devotion(?:Dual)?((?:\.\w+)+)/))) {
    // Devotion.Blue, DevotionDual.Black.Red, Devotion.Chosen
    const colors = [...new Set(m[1].split('.').filter(Boolean).flatMap(x => x === 'Chosen' ? ((host && host.chosen && host.chosen.colors) || []) : [CAP_COLOR[x]]).filter(c => COLORS.includes(c)))];
    let n = 0;
    for (const c of game.battlefield) if (c.controller === youId) {
      const cost = game.chars(c).manaCost;
      if (!cost) continue;
      for (const col of colors) { n += cost.colored[col] || 0; n += cost.hybrid.filter(h => h.includes(col)).length; n += cost.phyrexian.filter(x => x === col).length; }
    }
    n += game.activeStatics('Devotion').filter(s => matchValid(game, you, s.p.ValidPlayer || 'You', s.ctx)).length;
    return n;
  }
  if ((m = rest.match(/^ColorsCtrl (.+)$/))) {
    const s = new Set();
    for (const c of game.battlefield) if (matchValid(game, c, m[1], ctx)) for (const col of game.chars(c).colors) s.add(col);
    return s.size;
  }
  if ((m = rest.match(/^DifferentCardNames_(.+)$/))) return new Set(game.cardsInZone('all').filter(c => matchValid(game, c, m[1], ctx)).map(c => game.chars(c).name)).size;
  if ((m = rest.match(/^CardTypes_?(.*)$/))) return graveyardTypes(game, you);
  if ((m = rest.match(/^Valid(Hand|Graveyard|Library|Exile) (.+)$/))) return game.zone(youId, zoneMap[m[1]]).filter(c => matchValid(game, c, m[2], ctx)).length;
  if ((m = rest.match(/^Calculate/))) return 0;
  if ((m = rest.match(/^(\w+)$/)) && svarLookup(ctx, m[1])) return evalExpr(game, svarLookup(ctx, m[1]), ctx, depth + 1);
  return 0;
}

function graveyardTypes(game, p) {
  const s = new Set();
  for (const c of p.graveyard) for (const t of game.chars(c).types) s.add(t);
  return s.size;
}

// "GE3", "EQ0", "GTX" -> boolean against value
export function compareSpec(game, value, spec, ctx) {
  if (!spec) return value >= 1;
  const m = String(spec).match(/^(EQ|NE|LT|LE|GT|GE)(.+)$/);
  if (!m) return value >= 1;
  return compare(value, m[1], calcCtx(game, m[2], ctx));
}

// Conditions on a sub ability (Condition$, ConditionPresent$, ConditionCheckSVar$ ...)
export function checkConditions(game, p, ctx) {
  if (p.Condition) {
    const c = p.Condition;
    const you = game.players[ctx.you];
    const host = ctx.host;
    const root = ctx.sa ? ctx.sa.root() : null;
    let ok = true;
    switch (c) {
      case 'Kicked': ok = !!(host && host.kicked) || !!(root && root.kicked); break;
      case 'NotKicked': ok = !(host && host.kicked) && !(root && root.kicked); break;
      case 'AltCost': ok = !!(root && root.altCost); break;
      case 'NotAltCost': ok = !(root && root.altCost); break;
      case 'Metalcraft': ok = countExpr(game, 'Metalcraft', ctx, 0) > 0; break;
      case 'Delirium': ok = countExpr(game, 'Delirium', ctx, 0) > 0; break;
      case 'Threshold': ok = you.graveyard.length >= 7; break;
      case 'Hellbent': ok = you.hand.length === 0; break;
      case 'EnduringStory': ok = !!you.enduringStory; break;
      case 'Day': case 'Night': ok = game.dayNight === c; break;
      case 'Revolt': ok = countExpr(game, 'Revolt', ctx, 0) > 0; break;
      case 'PlayerTurn': ok = game.activePlayer === ctx.you; break;
      case 'NotPlayerTurn': ok = game.activePlayer !== ctx.you; break;
      case 'Ferocious': ok = countExpr(game, 'Ferocious', ctx, 0) > 0; break;
      case 'Blessing': ok = game.battlefield.filter(x => x.controller === ctx.you).length >= 10; break;
      case 'Monarch': ok = game.monarch === ctx.you; break;
      case 'Initiative': ok = game.initiative === ctx.you; break;
      case 'OptionalCost': ok = !!(root && root.optionalCostPaid); break;
      case 'Foretold': ok = false; break;
      case 'Bargain': case 'Bargained': ok = !!(root && root.optionalCostPaid); break;
      case 'Surge': case 'Spectacle': case 'Prowl': ok = !!(root && root.altCost); break;
      case 'Evoke': case 'Evoked': ok = !!(root && root.altCost === 'Evoke'); break;
      case 'Desert': ok = false; break;
      default: ok = true;
    }
    if (!ok) return false;
  }
  if (p.ConditionDefined || p.ConditionPresent) {
    let n;
    if (p.ConditionDefined) {
      const objs = resolveDefined(game, p.ConditionDefined, ctx);
      n = p.ConditionPresent ? objs.filter(o => matchValid(game, o, p.ConditionPresent, ctx)).length : objs.length;
    } else {
      const zone = p.ConditionZone ? (zoneMap[p.ConditionZone] || p.ConditionZone.toLowerCase()) : 'battlefield';
      n = game.cardsInZone(zone).filter(c => matchValid(game, c, p.ConditionPresent, ctx)).length;
    }
    if (!compareSpec(game, n, p.ConditionCompare || 'GE1', ctx)) return false;
  }
  if (p.ConditionCheckSVar) {
    const v = calcCtx(game, p.ConditionCheckSVar, ctx);
    if (!compareSpec(game, v, p.ConditionSVarCompare || 'GE1', ctx)) return false;
  }
  if (p.ConditionPlayerTurn === 'True' && game.activePlayer !== ctx.you) return false;
  if (p.ConditionNotPresent) {
    const n = game.battlefield.filter(c => matchValid(game, c, p.ConditionNotPresent, ctx)).length;
    if (n > 0) return false;
  }
  if (p.ConditionLifeTotal) {
    const pl = resolveDefined(game, p.ConditionLifeTotal, ctx)[0];
    if (pl && p.ConditionLifeAmount && !compareSpec(game, pl.life, p.ConditionLifeAmount, ctx)) return false;
  }
  return true;
}

// Trigger / static "IsPresent" + "CheckSVar" checks
export function checkPresence(game, p, ctx) {
  if (p.IsPresent) {
    const zone = p.PresentZone ? (zoneMap[p.PresentZone] || p.PresentZone.toLowerCase()) : 'battlefield';
    let pool;
    if (p.PresentDefined) pool = resolveDefined(game, p.PresentDefined, ctx).map(o => liveOrLki(game, o)).filter(o => o && !o.isPlayer);
    else if (p.PresentPlayer) {
      const who = p.PresentPlayer === 'You' ? [ctx.you] : p.PresentPlayer === 'Opponent' ? game.livingPlayers().filter(x => game.isOpponent(x.id, ctx.you)).map(x => x.id) : game.players.map(x => x.id);
      pool = zone === 'battlefield' ? game.battlefield.filter(c => who.includes(c.controller)) : who.flatMap(id => game.zone(id, zone));
    } else pool = game.cardsInZone(zone);
    const n = pool.filter(c => matchValid(game, c, p.IsPresent, ctx)).length;
    if (!compareSpec(game, n, p.PresentCompare || 'GE1', ctx)) return false;
  }
  if (p.IsPresent2) {
    const n = game.cardsInZone('battlefield').filter(c => matchValid(game, c, p.IsPresent2, ctx)).length;
    if (!compareSpec(game, n, p.PresentCompare2 || 'GE1', ctx)) return false;
  }
  if (p.CheckSVar) {
    const v = calcCtx(game, p.CheckSVar, ctx);
    if (!compareSpec(game, v, p.SVarCompare || 'GE1', ctx)) return false;
  }
  if (p.CheckSecondSVar) {
    const v = calcCtx(game, p.CheckSecondSVar, ctx);
    if (!compareSpec(game, v, p.SecondSVarCompare || 'GE1', ctx)) return false;
  }
  if (p.PlayerTurn === 'True' && game.activePlayer !== ctx.you) return false;
  // "If it's neither day nor night" (DayTime$ Neither | Day | Night); "EnduringStory$ False" (Storied)
  if (p.DayTime && (game.dayNight || 'Neither') !== p.DayTime) return false;
  if (p.EnduringStory && (p.EnduringStory === 'True') !== !!(game.players[ctx.you] && game.players[ctx.you].enduringStory)) return false;
  if (p.OpponentTurn === 'True' && !game.isOpponent(game.activePlayer, ctx.you)) return false;
  // "if you're the monarch" (Faramir, Champions of Minas Tirith)
  if (p.CheckDefinedPlayer && !resolveDefined(game, p.CheckDefinedPlayer, ctx).length) return false;
  if (p.NotPlayerTurn === 'True' && game.activePlayer === ctx.you) return false;
  if (p.Condition) {
    switch (p.Condition) {
      case 'PlayerTurn': if (game.activePlayer !== ctx.you) return false; break;
      case 'NotPlayerTurn': if (game.activePlayer === ctx.you) return false; break;
      case 'Metalcraft': if (!countExpr(game, 'Metalcraft', ctx, 0)) return false; break;
      case 'Threshold': if (game.players[ctx.you].graveyard.length < 7) return false; break;
      case 'Delirium': if (!countExpr(game, 'Delirium', ctx, 0)) return false; break;
      case 'Hellbent': if (game.players[ctx.you].hand.length) return false; break;
      case 'Monarch': if (game.monarch !== ctx.you) return false; break;
      case 'MaxSpeed': if (!(game.players[ctx.you].speed >= 4)) return false; break;
      case 'EnduringStory': if (!game.players[ctx.you].enduringStory) return false; break;
      case 'Day': case 'Night': if (game.dayNight !== p.Condition) return false; break;
      default: break;
    }
  }
  if (p.Metalcraft === 'True' && !countExpr(game, 'Metalcraft', ctx, 0)) return false;
  if (p.Delirium === 'True' && !countExpr(game, 'Delirium', ctx, 0)) return false;
  if (p.Revolt === 'True' && !countExpr(game, 'Revolt', ctx, 0)) return false;
  if (p.Threshold === 'True' && game.players[ctx.you].graveyard.length < 7) return false;
  return true;
}

export { zoneMap, cmc as _cmc };
