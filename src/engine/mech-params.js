// Card-script parameters that cards rely on but the rest of the engine did not read (see tools/paramaudit.mjs).
// Each section is called from a small hook in the module that owns the event (game.js, triggers.js, effects.js,
// chars.js, abilities.js). This module imports only leaf modules statically: it is loaded from chars.js before
// abilities.js / effects.js exist, so those are reached with import() inside async functions (already loaded by then).
import { matchValid, resolveDefined, calcCtx, compareSpec, ctxOf, zoneMap, matchCastSA } from './filters.js';
import { parseMana, cloneCost, addCosts, cmc } from './mana.js';
import { parseAbility } from './forge.js';
import { abilityList } from './cards.js';

const engine = () => import('./abilities.js');
const effectsModule = () => import('./effects.js');

// ---------------------------------------------------------------- untapping
// "doesn't untap during its controller's untap step": Event$ Untap replacements apply to whatever ValidCard names
// (Mana Vault's own card, Charmed Sleep's enchanted creature, Intruder Alarm's creatures, Back to Basics' lands), and
// ValidStepTurnToController$ limits them to that untap step (you = the untapping permanent's controller, as in Forge;
// "Player.Activator" = whoever made the effect). Outside an untap step (stepPlayer null) only replacements without
// ValidStepTurnToController stop it ("can't become untapped": Frozen in Ice, Spider-Woman).
export function untapReplacements(game, card, stepPlayer) {
  const out = [];
  for (const rep of game.replacementsFor('Untap')) {
    const { h, p, ctx } = rep;
    if (p.Layer !== 'CantHappen' && !p.ReplaceWith) continue;
    if (p.ValidCard && !matchValid(game, card, p.ValidCard, ctx)) continue;
    if (p.ValidStepTurnToController) {
      if (stepPlayer == null) continue;
      const activator = /Activator/.test(p.ValidStepTurnToController);
      const spec = activator ? 'You' : p.ValidStepTurnToController;
      if (!matchValid(game, game.players[stepPlayer], spec, { ...ctx, you: activator ? h.controller : card.controller })) continue;
    }
    out.push(rep);
  }
  return out;
}

// true when the card stays tapped: a can't-happen replacement applies, or one that does something else instead
// (Freyalise's Winds: "remove all wind counters from it instead") was applied
export async function untapPrevented(game, card, stepPlayer) {
  const reps = untapReplacements(game, card, stepPlayer);
  if (!reps.length) return false;
  if (reps.some(r => r.p.Layer === 'CantHappen')) return true;
  const { h, r, p } = reps[0];
  const raw = r.svars[p.ReplaceWith];
  if (!raw) return false;
  const { SA } = await engine();
  const s = new SA(game, { raw, parsed: parseAbility(raw), svars: r.svars, src: h, key: r.key }, h, h.controller, { trig: { Card: card, Affected: card } });
  await game.resolveSAChain(s);
  return true;
}

// ---------------------------------------------------------------- turn records
// what happened last turn, read by conditions that look back one turn (werewolves)
export function noteTurnEnd(game) {
  game.lastTurnSpellCounts = game.players.map(pl => (pl.spellsCastThisTurn || []).length);
}

// a card became the target of a spell or ability: valiant counts the first time each turn per controller
export function noteTargeted(game, obj, pid) {
  if (!obj || !obj.isCard) return;
  const ts = game.turnState;
  const rec = ts.targetedBy || (ts.targetedBy = {});
  const k = `${obj.id}:${obj.zcc}`;
  (rec[k] = rec[k] || []).push(pid);
}
function timesTargetedBy(game, card, pid) {
  const rec = (game.turnState.targetedBy || {})[`${card.id}:${card.zcc}`] || [];
  return rec.filter(x => x === pid).length;
}

// ---------------------------------------------------------------- triggers
// extra conditions on trigger params, checked before the mode-specific matching (triggers.js)
export function triggerParamsOk(game, p, host, rp, ctx) {
  // old-style werewolves: "if no spells were cast last turn, transform" / "if a player cast two or more spells last turn"
  if (p.WerewolfTransformCondition) {
    const last = game.lastTurnSpellCounts || [];
    if (last.some(n => n > 0)) return false;
  }
  if (p.WerewolfUntransformCondition) {
    const last = game.lastTurnSpellCounts || [];
    if (!last.some(n => n > 1)) return false;
  }
  // valiant: "whenever this creature becomes the target of a spell or ability you control for the first time each turn"
  if (p.Valiant && rp.Mode === 'BecomesTarget') {
    const t = rp.Target;
    if (!t || !t.isCard || t.controller !== rp.Player || timesTargetedBy(game, t, rp.Player) > 0) return false;
  }
  // "a spell that targets only a single creature" (Zada, Leyline of Resonance, Ivy)
  if (p.IsSingleTarget && /^(SpellCast|SpellCastOrCopy|SpellCopy|SpellAbilityCast|AbilityCast)$/.test(rp.Mode)) {
    const seen = new Set();
    for (const t of rp.Targets || []) if (t) seen.add(t.isPlayer ? 'p' + t.id : t.id);
    if (seen.size !== 1) return false;
  }
  return true;
}

// ---------------------------------------------------------------- effects: before / after hooks (effects.js runEffect)
const Z = z => (z ? (zoneMap[z] || z.toLowerCase()) : z);
const playersIn = list => list.filter(o => o && o.isPlayer);
const cardsIn = list => list.filter(o => o && o.isCard);
// the same ability with some parameters replaced (reads fall through to the original)
function withParams(sa, over) {
  const clone = Object.create(sa);
  clone.p = { ...sa.p, ...over };
  return clone;
}

// Runs before an effect: may hand back the ability with parameters settled ("search your library and/or graveyard",
// "its owner puts it on the top or bottom of their library") and notes what the after hook compares against.
export async function beforeEffect(game, sa) {
  const p = sa.p;
  let over = null;
  if (sa.api === 'ChangeZone' || sa.api === 'ChangeZoneAll') {
    // OriginAlternative: Finale of Devastation, Tower Winder ("search your library and/or graveyard"): one search over every zone
    if (p.OriginAlternative) {
      const zones = [...String(p.Origin || 'Library').split(','), ...p.OriginAlternative.split(',')].map(z => z.trim()).filter(z => z && z !== 'Sideboard');
      over = { ...over, Origin: [...new Set(zones)].join(',') };
      if (sa.api === 'ChangeZone' && !p.Defined && !p.ValidTgts) over.Hidden = 'True';
    }
    // DestinationAlternative: top or bottom (Subtlety, Endless Detour), hand or battlefield (Emeria Shepherd)
    if (p.DestinationAlternative && await chooseAltDestination(game, sa)) {
      over = { ...over, Destination: p.DestinationAlternative, LibraryPosition: p.LibraryPositionAlternative ?? '0' };
    }
  }
  // "creatures you control gain each of those keywords that a creature you control has" (Odric, Majestic Myriarch)
  if (p.SharedKeywordsZone && p.KW && (sa.api === 'Pump' || sa.api === 'PumpAll')) over = { ...over, KW: sharedKeywords(game, p.KW.split(' & '), p.SharedKeywordsZone, p.SharedRestrictions, ctxOf(game, sa)).join(' & ') };
  if (p.PersistentMana === 'True' && sa.api === 'Mana') sa._poolBefore = { ...game.players[sa.controller].pool };
  if (p.RememberDrawn && sa.api === 'Draw') sa._handsBefore = game.players.map(pl => new Set(pl.hand.map(c => c.id)));
  if (p.RememberDamaged === 'True' && sa.api === 'DamageAll') sa._damageFrom = game.turnState.damageLog.length;
  return over ? withParams(sa, over) : sa;
}

async function chooseAltDestination(game, sa) {
  const p = sa.p;
  const ctx = ctxOf(game, sa);
  let optional = true;
  if (p.DestAltSVar) {
    let sv = p.DestAltSVar;
    if (sv.startsWith('MANDATORY ')) { optional = false; sv = sv.slice(10); }
    if (!compareSpec(game, calcCtx(game, sv, ctx), p.DestAltSVarCompare || 'GE1', ctx)) return false;
  }
  if (!optional) return true;
  const dest1 = Z(p.Destination || 'Graveyard'), dest2 = Z(p.DestinationAlternative);
  const topBottom = dest1 === 'library' && dest2 === 'library';
  let decider = sa.controller;
  if (p.AlternativeDecider) {
    const who = resolveDefined(game, p.AlternativeDecider.split(' ')[0], ctx).map(o => (o && (o.isCard || o.lki) ? game.players[o.owner] : o));
    const pl = playersIn(who);
    if (!pl.length) return false;
    decider = pl[0].id;
  }
  const cards = (sa.targets || []).map(t => (t && t.stackItem ? t.card : t)).filter(c => c && c.isCard).map(c => c.id);
  const pos = n => (+n === -1 ? 'Bottom of the library' : +n > 0 ? `${+n + 1}${['st', 'nd', 'rd'][+n] || 'th'} from the top of the library` : 'Top of the library');
  const names = { library: 'Library', hand: 'Hand', battlefield: 'Battlefield', graveyard: 'Graveyard', exile: 'Exile' };
  const options = topBottom
    ? [{ label: pos(p.LibraryPosition || 0), value: 'first' }, { label: pos(p.LibraryPositionAlternative ?? 0), value: 'alt' }]
    : [{ label: names[dest1] || dest1, value: 'first' }, { label: names[dest2] || dest2, value: 'alt' }];
  const ans = await game.ask(decider, { type: 'option', prompt: `${game.name(sa.host)}: where does it go?`, options, purpose: 'altDestination', sa, cards, dests: topBottom ? [+(p.LibraryPosition || 0) === -1 ? 'bottom' : 'top', +(p.LibraryPositionAlternative ?? 0) === -1 ? 'bottom' : 'top'] : [dest1, dest2] });
  return ans === 'alt';
}

// Runs after an effect resolved (before its sub-abilities).
export async function afterEffect(game, sa) {
  const p = sa.p;
  // RememberDamaged on DamageAll (Anger of the Gods: "exile it instead" names the creatures dealt damage this way)
  if (sa._damageFrom != null) {
    const hit = game.turnState.damageLog.slice(sa._damageFrom).map(d => (d.card != null ? game.cardById(d.card) : d.player != null ? game.players[d.player] : null)).filter(Boolean);
    sa._damageFrom = null;
    const h = sa.host;
    if (h) { h.remembered = h.remembered || []; for (const o of hit) if (!h.remembered.includes(o)) h.remembered.push(o); }
  }
  // "If that creature would die this turn, exile it instead." (Anger of the Gods, Magma Spray, Red Sun's Zenith)
  if ((p.ReplaceDyingDefined || p.ReplaceDyingValid) && /^(DealDamage|DamageAll|DamageEach|DamageResolve|Pump|PumpAll|Fight)$/.test(sa.api)) await replaceDying(game, sa);
  // "Until end of turn, you don't lose this mana as steps and phases end." (Savage Ventmaw, Neheb, Klauth)
  if (sa._poolBefore) {
    const pl = game.players[sa.controller];
    if (pl.persistentManaTurn !== game.turnNumber) pl.persistentMana = {};
    for (const k of Object.keys(pl.pool)) { const n = (pl.pool[k] || 0) - (sa._poolBefore[k] || 0); if (n > 0) pl.persistentMana[k] = (pl.persistentMana[k] || 0) + n; }
    pl.persistentManaTurn = game.turnNumber;
    sa._poolBefore = null;
  }
  // RememberDrawn: the cards drawn (Fa'adiyah Seer "if it isn't a land, discard it", Cut a Deal, Truce, Kwain)
  if (sa._handsBefore) {
    const drawn = [];
    game.players.forEach((pl, i) => { for (const c of pl.hand) if (!sa._handsBefore[i].has(c.id) && c.enteredFrom === 'library') drawn.push(c); });
    sa._handsBefore = null;
    const h = sa.host;
    if (h && drawn.length) { h.remembered = h.remembered || []; for (const c of drawn) if (!h.remembered.includes(c)) h.remembered.push(c); }
  }
}

async function replaceDying(game, sa) {
  const p = sa.p;
  if (p.ReplaceDyingCondition === 'Kicked' && !(sa.root().kicked || (sa.host && sa.host.kicked))) return;
  let cards = null;
  if (p.ReplaceDyingDefined) {
    cards = cardsIn(resolveDefined(game, p.ReplaceDyingDefined, ctxOf(game, sa)).map(o => (o && o.lki ? game.cardById(o.id) : o))).filter(c => c.zone === 'battlefield');
    if (!cards.length) return;
  }
  const svars = {
    ...sa.svars,
    PADyingRepl: `Event$ Moved | ValidCard$ ${p.ReplaceDyingValid || 'Card.IsRemembered'} | Origin$ Battlefield | Destination$ Graveyard | ReplaceWith$ PADyingMove | Description$ If that creature would die this turn, exile it instead.`,
    PADyingMove: `DB$ ChangeZone | Defined$ ReplacedCard | Origin$ Battlefield | Destination$ ${p.ReplaceDyingZone || 'Exile'}`,
  };
  const e = await makeEffect(game, sa, `DB$ Effect | Name$ ${game.name(sa.host)}'s effect | ReplacementEffects$ PADyingRepl`, svars);
  if (e && cards) e.remembered = cards;
}

// an Effect object made the way the Effect API makes one (it goes to game.effects); returns it
async function makeEffect(game, sa, raw, svars) {
  const { makeSA } = await engine();
  const { E } = await effectsModule();
  const before = game.effects.length;
  await E.Effect(game, makeSA(game, raw, svars, sa.host, sa.controller, { key: (sa.key || '') + '>pa' }));
  return game.effects.length > before ? game.effects[game.effects.length - 1] : null;
}

// StaticEffect$ on a zone change (CR 611.2e): "return it to the battlefield. It's an enchantment. (It's not a creature.)"
// (the Enduring cycle), "That creature is a black Zombie in addition to its other colors and types" (Liliana, Death's
// Majesty). The static applies to the card while it stays on the battlefield; called from moveCard as it enters.
export async function applyStaticEffect(game, card, cause) {
  const p = cause.p;
  const raw = cause.svars && cause.svars[p.StaticEffect];
  if (!raw) return;
  const ctx = ctxOf(game, cause);
  if (p.StaticEffectCheckSVar && !compareSpec(game, calcCtx(game, p.StaticEffectCheckSVar, ctx), p.StaticEffectSVarCompare || 'GE1', ctx)) return;
  const svars = { ...cause.svars, PAStaticEffect: raw };
  const e = await makeEffect(game, cause, `DB$ Effect | Name$ ${game.name(cause.host)}'s effect | StaticAbilities$ PAStaticEffect | Duration$ Permanent`, svars);
  if (!e) return;
  e.remembered = [card];
  e.exileOnMoved = 'battlefield'; // gone once that permanent leaves (moveCard drops effects whose only remembered card left)
  game.touch();
}

// the mana a "you don't lose this mana" ability made, kept as pools empty this turn (game.js emptyPools)
export function heldPersistentMana(game, pl) {
  if (!pl.persistentMana) return null;
  if (pl.persistentManaTurn !== game.turnNumber) { pl.persistentMana = null; return null; }
  const out = {};
  for (const [k, n] of Object.entries(pl.persistentMana)) { const m = Math.min(n, pl.pool[k] || 0); pl.persistentMana[k] = m; if (m > 0) { out[k] = m; pl.pool[k] -= m; } }
  return out;
}

// ---------------------------------------------------------------- effects replaced outright (registered in effects.js)
export const PARAMS_EFFECTS = {
  // "An opponent separates those cards into two piles" (Fact or Fiction, Liliana of the Veil, Epiphany at the Drownyard,
  // Make an Example): Separator makes the piles, Chooser (default: the player it's for) picks one; ChosenPile /
  // UnchosenPile run with that pile remembered.
  async TwoPiles(game, sa) {
    const p = sa.p;
    const host = sa.host;
    const ctx = ctxOf(game, sa);
    const { makeSA, resolveChain } = await engine();
    const tgtPlayers = p.ValidTgts ? playersIn(sa.targets || []) : playersIn(resolveDefined(game, p.Defined || 'You', ctx));
    const pickPlayer = async (spec, fallback, what) => {
      if (!spec) return fallback;
      const list = playersIn(resolveDefined(game, spec, ctx)).filter(pl => !pl.lost);
      if (!list.length) return fallback;
      if (list.length === 1) return list[0];
      const id = await game.ask(sa.controller, { type: 'player', prompt: `${game.name(host)}: choose who ${what}`, players: list.map(pl => pl.id), sa, purpose: 'pileChooser' });
      return list.find(pl => pl.id === id) || list[0];
    };
    const separator = await pickPlayer(p.Separator, game.players[sa.controller], 'separates the piles');
    const fixedChooser = p.Chooser ? await pickPlayer(p.Chooser, null, 'chooses a pile') : null;
    const saved = (host.remembered || []).slice();
    for (const pl of tgtPlayers.length ? tgtPlayers : [game.players[sa.controller]]) {
      if (pl.lost) continue;
      const chooser = fixedChooser || pl;
      let pile1, pile2;
      if (p.DefinedPiles) {
        const [a, b] = p.DefinedPiles.split(',');
        pile1 = cardsIn(resolveDefined(game, a, ctx)); pile2 = cardsIn(resolveDefined(game, b, ctx));
      } else {
        let pool = p.DefinedCards ? cardsIn(resolveDefined(game, p.DefinedCards, ctx)) : (p.Zone && Z(p.Zone) !== 'battlefield' ? (pl[Z(p.Zone)] || []).slice() : game.battlefield.filter(c => c.controller === pl.id));
        pool = pool.filter(c => matchValid(game, c, p.ValidCards || 'Card', ctx));
        if (!pool.length) break;
        const ids = await game.ask(separator.id, { type: 'cards', prompt: `${game.name(host)}: separate these cards into two piles. Choose the cards for pile 1 (the rest are pile 2); ${chooser.name} picks a pile.`, cards: pool.map(c => c.id), min: 0, max: pool.length, sa, purpose: 'separatePiles', chooser: chooser.id, good: pileIsGood(sa, p.ChosenPile), reveal: true });
        const set = new Set((ids || []).filter(id => pool.some(c => c.id === id)));
        pile1 = pool.filter(c => set.has(c.id)); pile2 = pool.filter(c => !set.has(c.id));
      }
      const label = (n, pile) => `Pile ${n}: ${pile.length ? pile.map(c => game.name(c)).join(', ') : '(empty)'}`;
      const ans = await game.ask(chooser.id, { type: 'option', prompt: `${game.name(host)}: choose a pile`, options: [{ label: label(1, pile1), value: 1 }, { label: label(2, pile2), value: 2 }], purpose: 'choosePile', sa, piles: [pile1.map(c => c.id), pile2.map(c => c.id)], good: pileIsGood(sa, p.ChosenPile) });
      const chosen = ans === 2 ? pile2 : pile1, unchosen = ans === 2 ? pile1 : pile2;
      game.log(`${chooser.name} chooses ${chosen.length ? chosen.map(c => game.name(c)).join(', ') : 'the empty pile'}.`);
      if (p.RememberChosen === 'True') { host.remembered = host.remembered || []; for (const c of chosen) if (!host.remembered.includes(c)) host.remembered.push(c); }
      for (const [name, pile] of [[p.ChosenPile, chosen], [p.UnchosenPile, unchosen]]) {
        if (!name || !sa.svars[name]) continue;
        const keep = (host.remembered || []).slice();
        host.remembered = pile.slice();
        await resolveChain(game, makeSA(game, sa.svars[name], sa.svars, host, sa.controller, { parent: sa, key: (sa.key || '') + '>' + name }));
        host.remembered = keep;
      }
    }
    if (p.KeepRemembered !== 'True' && p.RememberChosen !== 'True') host.remembered = [];
    else if (p.KeepRemembered === 'True' && p.RememberChosen !== 'True') host.remembered = saved;
    game.touch();
  },

  // ChooseCard, every chooser in turn (Defined$ Player: Cataclysmic Gearhulk, Tragic Arrogance, Single Combat, Divine
  // Reckoning), from what that player controls (ControlledByPlayer$ Chooser / a defined player), one of each type
  // (ChooseEach$ Artifact & Creature & ...), one of each basic land type (EachBasicType).
  async ChooseCard(game, sa) {
    const p = sa.p;
    const host = sa.host;
    const ctx = ctxOf(game, sa);
    const target = sa.etbCard || host;
    let choosers;
    if (p.Chooser) choosers = playersIn(resolveDefined(game, p.Chooser, ctx));
    else if (p.ValidTgts && (sa.targets || []).some(t => t && t.isPlayer)) choosers = playersIn(sa.targets);
    else choosers = playersIn(resolveDefined(game, p.Defined || 'You', ctx));
    choosers = choosers.filter(pl => !pl.lost);
    if (!choosers.length) choosers = [game.players[sa.controller]];
    const zones = (p.ChoiceZone || 'Battlefield').split(',').map(Z);
    let choices = [];
    for (const z of zones) choices.push(...(z === 'battlefield' ? game.battlefield : game.cardsInZone(z)));
    if (p.Choices) choices = choices.filter(c => matchValid(game, c, p.Choices, { ...ctx, you: sa.controller }));
    if (p.TargetControls) { const ids = new Set(choosers.map(pl => pl.id)); choices = choices.filter(c => ids.has(c.controller)); }
    if (p.DefinedCards) choices = cardsIn(resolveDefined(game, p.DefinedCards, ctx));
    if (p.IncludeSpellsOnStack) choices = [...game.stack.map(s => s.card).filter(Boolean), ...choices];
    const amount = p.Amount === 'All' ? choices.length : p.Amount ? calcCtx(game, p.Amount, ctx) : 1;
    if (amount <= 0) return;
    const mandatory = p.Mandatory === 'True';
    const all = [];
    for (const pl of choosers) {
      let pool = choices;
      if (p.ControlledByPlayer) {
        const cb = p.ControlledByPlayer;
        let ids;
        if (cb === 'Chooser') ids = [pl.id];
        else if (cb === 'Left' || cb === 'Right') { const { playerInDirection } = await import('./combat.js'); const q = playerInDirection(game, pl.id, cb); ids = q == null ? [] : [typeof q === 'object' ? q.id : q]; }
        else ids = playersIn(resolveDefined(game, cb, ctx)).map(q => q.id);
        pool = pool.filter(c => ids.includes(c.controller));
      }
      const chosen = [];
      const pickFrom = async (list, min, max, prompt) => {
        if (!list.length || max <= 0) return [];
        const ids = await game.ask(pl.id, { type: 'cards', prompt, cards: list.map(c => c.id), min: Math.min(min, list.length), max: Math.min(max, list.length), sa, purpose: 'chooseCard', ai: p.AILogic, reveal: true });
        return (ids || []).map(id => game.cardById(id)).filter(c => c && list.includes(c)).slice(0, max);
      };
      if (p.EachBasicType) {
        for (const t of ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest']) {
          const list = pool.filter(c => game.chars(c).subtypes.has(t) && !chosen.includes(c));
          chosen.push(...await pickFrom(list, 1, 1, `${game.name(host)}: choose a ${t}`));
        }
      } else if (p.ChooseEach) {
        const types = p.ChooseEach === 'Party' ? ['Cleric', 'Rogue', 'Warrior', 'Wizard'] : p.ChooseEach.split(' & ').map(s => s.trim());
        for (const t of types) {
          const list = pool.filter(c => { const ch = game.chars(c); return (ch.types.has(t) || ch.subtypes.has(t)) && !chosen.includes(c); });
          chosen.push(...await pickFrom(list, mandatory ? 1 : 0, 1, `${game.name(host)}: choose ${/^[AEIOU]/.test(t) ? 'an' : 'a'} ${t.toLowerCase()}${p.ControlledByPlayer === 'Chooser' ? ' you control' : ''}`));
        }
      } else if (p.AtRandom === 'True') {
        const tmp = pool.slice(); game.rng.shuffle(tmp); chosen.push(...tmp.slice(0, amount));
      } else {
        const min = mandatory || p.MinAmount == null ? Math.min(amount, pool.length) : Math.min(+p.MinAmount, pool.length);
        chosen.push(...await pickFrom(pool, min, amount, p.ChoiceTitle || `${game.name(host)}: choose ${amount === 1 ? 'a card' : amount + ' cards'}`));
      }
      if (chosen.length) game.log(`${pl.name} chooses ${chosen.map(c => game.name(c)).join(', ')}.`);
      all.push(...chosen);
    }
    target.chosen = { ...(target.chosen || {}), cards: all.map(c => c.id) };
    if (p.ForgetOtherRemembered === 'True') host.remembered = [];
    if (p.RememberChosen === 'True') { host.remembered = host.remembered || []; for (const c of all) if (!host.remembered.includes(c)) host.remembered.push(c); }
    if (p.ForgetChosen === 'True' && host.remembered) host.remembered = host.remembered.filter(c => !all.includes(c));
    if (p.ImprintChosen === 'True') { host.imprinted = host.imprinted || []; host.imprinted.push(...all); }
    game.touch();
  },
};

// does the chosen pile's ability help whoever chooses it? (to hand: yes; sacrifice / graveyard: no)
function pileIsGood(sa, name) {
  const raw = name && sa.svars[name];
  if (!raw) return true;
  const q = parseAbility(raw);
  if (/^(Sacrifice|SacrificeAll|Destroy|DestroyAll|Discard|Mill)$/.test(q.api)) return false;
  if (q.api === 'ChangeZone' || q.api === 'ChangeZoneAll') return !/Graveyard|Exile/.test(q.p.Destination || '');
  return true;
}

// ---------------------------------------------------------------- modes (abilities.js chooseModes)
// ChoiceRestriction$ ThisTurn / ThisGame: "choose one that hasn't been chosen this turn" (Monument to Endurance, Gala
// Greeters, Galadriel), "... that hasn't been chosen" (Silent Hallcreeper): per object and ability
function charmKey(sa) { const h = sa.host; return `${h ? h.id : ''}:${h ? h.zcc : ''}:${String(sa.key || '').replace(/#.*$/, '')}`; }
function charmRecord(game, sa, create) {
  const r = sa.p.ChoiceRestriction;
  if (!r) return null;
  const store = r === 'ThisGame' ? (game.charmModesGame || (create ? (game.charmModesGame = {}) : {})) : (game.turnState.charmModes || (create ? (game.turnState.charmModes = {}) : {}));
  const k = charmKey(sa);
  if (create && !store[k]) store[k] = [];
  return store[k] || [];
}
export function charmModeAllowed(game, sa, mode) {
  const rec = charmRecord(game, sa, false);
  return !rec || !rec.includes(mode);
}
export function noteCharmModes(game, sa, modes) {
  if (!sa.p.ChoiceRestriction || !modes) return;
  charmRecord(game, sa, true).push(...modes);
}

// ---------------------------------------------------------------- costs (abilities.js spellCost / castSpell / activation)
// ReduceCost / RaiseCost statics need things the base cost code doesn't have: the spell's own context (Relative$: its
// X, its targets, a number announced as it's cast), its targets (ValidTarget$, UnlessValidTarget$), RaiseCost's Cost$
// (an additional {B}, 3 life, "sacrifice a Swamp", "tap any number of creatures"), ForEachShard$, IgnoreGeneric$ and
// MinMana$; and Type$ Ability statics change activated abilities (Training Grounds, Zirda, Power Artifact, Kopala).
// The base loop skips the statics handled here (paramCostStatic). Before targets are chosen the result is an estimate
// (target-dependent reductions apply, target-dependent raises don't); castSpell / activateAbility settle it after.
export function paramCostStatic(s, kind) {
  const p = s.p || s.parsed.p;
  if (p.Relative || p.ValidTarget || p.IgnoreGeneric || p.MinMana) return true;
  if (kind === 'raise' && (p.Cost || p.ForEachShard || p.ValidSpell)) return true;
  return false;
}

const ANY = ['W', 'U', 'B', 'R', 'G'];
const isManaStr = s => /^[\dWUBRGCXS/ ]+$/.test(String(s).trim()) && String(s).trim() !== '';
// what an activated ability is ("Activated.Equip", "Activated.!ManaAbility", "Activated.Loyalty")
function abilityIs(game, sa, spec, ctx) {
  return String(spec).split(',').some(alt => {
    const [type, ...rest] = alt.trim().split('.');
    if (!['Activated', 'SpellAbility', 'Ability'].includes(type)) return false;
    if (sa.isTrigger || (sa.def && sa.def.kind && sa.def.kind !== 'AB')) return false;
    const p = sa.p;
    return rest.join('.').split('+').filter(Boolean).every(pr => {
      const neg = pr.startsWith('!'); const q = neg ? pr.slice(1) : pr;
      let r;
      switch (q) {
        case 'ManaAbility': r = sa.api === 'Mana'; break;
        case 'Equip': r = p.IsEquip === 'True'; break;
        case 'Loyalty': r = p.Planeswalker === 'True'; break;
        case 'Ninjutsu': r = sa.api === 'Ninjutsu'; break;
        case 'Crew': r = p.IsCrew === 'True' || sa.api === 'Crew'; break;
        case 'Cycling': r = p.IsCycling === 'True'; break;
        case 'Boast': r = p.Boast === 'True'; break;
        case 'Exhaust': r = p.Exhaust === 'True'; break;
        case 'hasTapCost': r = /(^|\s)T(\s|$)/.test(p.Cost || ''); break;
        default: r = sa.host ? matchValid(game, sa.host, 'Card.' + q, ctx) : false;
      }
      return neg ? !r : r;
    });
  });
}
function spellIs(game, sa, card, opt, spec, ctx) {
  const root = sa.root ? sa.root() : sa;
  if (opt && opt.altCost && !root.altCost) root.altCost = opt.altCost;
  return matchCastSA(game, sa, card, spec, ctx);
}

function costCtx(s) {
  return { host: s.host, you: s.ctx.you, svars: s.st.svars, sa: { ...s.ctx.sa, svars: s.st.svars } };
}
// Relative$: amounts are worked out for the spell or ability being paid for (its X, targets, announced numbers)
function relCtx(s, sa, pid) {
  const svars = { ...(sa.svars || {}), ...s.st.svars };
  for (const k of Object.keys(sa.svars || {})) if (/^Number\$/.test(sa.svars[k])) svars[k] = sa.svars[k]; // announced values win
  return { host: s.host, you: pid, svars, sa: Object.assign(Object.create(sa), { svars }), trig: sa.trig };
}

// does a ReduceCost / RaiseCost static apply to this spell or ability? final: its targets are known
function costApplies(game, s, { kind, pid, card, sa, opt, final }) {
  const p = s.p;
  if (p.Type) {
    if (p.Type === 'Spell') { if (kind !== 'spell') return false; }
    else if (p.Type === 'Ability') { if (kind !== 'ability') return false; }
    else if (p.Type !== 'Any') return false;
  } else if (kind === 'ability' && !p.ValidSpell) return false;
  if (p.ValidCard && !matchValid(game, card, p.ValidCard.replace(/CARDNAME/g, 'Card.Self'), { ...s.ctx, host: s.host })) return false;
  if (p.Activator && !matchValid(game, game.players[pid], p.Activator, s.ctx)) return false;
  if (p.ValidSpell) {
    if (kind === 'ability') { if (!abilityIs(game, sa, p.ValidSpell, s.ctx)) return false; }
    else if (!/^(Spell|SpellAbility|Card)\b/.test(p.ValidSpell) || !spellIs(game, sa, card, opt, p.ValidSpell, s.ctx)) return false;
  }
  if (p.OnlyFirstSpell === 'True' && kind === 'spell' && game.players[pid].spellsCastThisTurn.length > 0) return false;
  if (p.AffectedZone) {
    const from = kind === 'spell' ? (opt && opt.from) || card.zone : card.zone;
    if (!p.AffectedZone.split(',').map(Z).includes(from)) return false;
  }
  if (p.ValidTarget) {
    const ts = (sa.chain ? sa.chain() : [sa]).flatMap(x => x.targets || []);
    if (!final && !ts.length) return p.Mode === 'ReduceCost'; // (an estimate: reductions are hoped for, raises wait)
    const hit = ts.some(t => t && matchValid(game, t, p.ValidTarget, s.ctx));
    return p.UnlessValidTarget ? !hit : hit;
  }
  return true;
}

// how many times a static's change applies
function costAmount(game, s, sa, pid, card) {
  const p = s.p;
  let n;
  if (p.ForEachShard) {
    const col = { White: 'W', Blue: 'U', Black: 'B', Red: 'R', Green: 'G' }[p.ForEachShard] || p.ForEachShard[0];
    const m = sa.isSpell ? game.chars(card).manaCost : (sa.p && sa.p.Cost ? parseMana(String(sa.p.Cost).split(/\s+/).filter(isManaStr).join(' ')) : null);
    n = m ? (m.colored[col] || 0) + m.hybrid.filter(h => h.includes(col)).length + m.twobrid.filter(x => x === col).length + m.phyrexian.filter(x => x === col).length : 0;
  } else if (p.Amount == null) n = 1;
  else if (/^\d+$/.test(p.Amount)) n = +p.Amount;
  else n = calcCtx(game, p.Amount, p.Relative ? relCtx(s, sa, pid) : costCtx(s));
  if (p.UpTo) { /* "up to {2} less": nobody pays more than they must, so the whole reduction */ }
  return Math.max(0, n || 0);
}

// The changes from the statics handled here: { reduce, raise, colorReduce: [{ color, n, strict }], capped, addMana, parts }
export function paramCostMods(game, { kind, pid, card, sa, opt = null, final = false }) {
  const out = { reduce: 0, raise: 0, colorReduce: [], capped: [], addMana: null, parts: [] };
  if (!card || !sa) return out;
  for (const mode of ['RaiseCost', 'ReduceCost']) {
    for (const s of game.activeStatics(mode)) {
      // the base spell code handles the others; abilities have no base code, so all of theirs are applied here
      if (kind === 'spell' && !paramCostStatic(s, mode === 'RaiseCost' ? 'raise' : 'reduce')) continue;
      if (!costApplies(game, s, { kind, pid, card, sa, opt, final })) continue;
      const p = s.p;
      const n = costAmount(game, s, sa, pid, card);
      if (!n) continue;
      if (mode === 'RaiseCost') {
        const c = p.Cost || '1';
        if (isManaStr(c)) { const m = parseMana(c); for (let i = 0; i < n; i++) out.addMana = out.addMana ? addCosts(out.addMana, m) : cloneCost(m); }
        else if (final) out.parts.push(n > 1 ? c.replace(/<(\d+)\//, (_, k) => `<${+k * n}/`) : c);
      } else if (p.Color) {
        for (const col of p.Color.split(' ')) {
          if (/^\d+$/.test(col)) out.reduce += +col * n;
          else out.colorReduce.push({ color: col, n, strict: p.IgnoreGeneric === 'True' });
        }
      } else if (p.MinMana) out.capped.push({ n, min: +p.MinMana });
      else out.reduce += n;
    }
  }
  return out;
}

// apply paramCostMods to a mana cost (generic reductions can't go below zero; MinMana keeps that much mana in it).
// Returns the new cost and what was actually changed, so it can be taken back exactly.
export function applyCostMods(mana, mods) {
  let m = cloneCost(mana);
  const applied = { addMana: mods.addMana, generic: 0, colors: {} };
  if (mods.addMana) m = addCosts(m, mods.addMana);
  m.generic += mods.raise;
  applied.raise = mods.raise;
  for (const { color, n, strict } of mods.colorReduce) {
    for (let i = 0; i < n; i++) {
      if (m.colored[color] > 0) { m.colored[color]--; applied.colors[color] = (applied.colors[color] || 0) + 1; }
      else if (!strict && m.generic > 0) { m.generic--; applied.generic++; }
    }
  }
  const r = Math.min(m.generic, mods.reduce);
  m.generic -= r; applied.generic += r;
  for (const { n, min } of mods.capped) {
    const can = Math.max(0, Math.min(n, cmc(m) - min, m.generic));
    m.generic -= can; applied.generic += can;
  }
  return { mana: m, applied };
}
function undoCostMods(mana, applied) {
  const m = cloneCost(mana);
  m.generic += applied.generic;
  for (const [k, n] of Object.entries(applied.colors)) m.colored[k] += n;
  m.generic = Math.max(0, m.generic - applied.raise);
  if (applied.addMana) {
    m.generic = Math.max(0, m.generic - applied.addMana.generic);
    for (const k of Object.keys(applied.addMana.colored)) m.colored[k] = Math.max(0, m.colored[k] - applied.addMana.colored[k]);
  }
  return m;
}

// ManaConvert statics and ManaConversion$ on what's paid for: "spend mana as though it were mana of any color / type"
// (Chromatic Orrery, Mycosynth Lattice, Vizier of the Menagerie, Agatha's Soul Cauldron, Oath of Nissa; white mana as
// any color: Celestial Dawn, False Dawn; white as red: Sunglasses of Urza)
export function convertMana(game, mana, { kind, pid, card, opt = null, extra = [] }) {
  const convs = [...extra];
  for (const s of game.activeStatics('ManaConvert')) {
    const p = s.p;
    if (!p.ManaConversion) continue;
    if (p.ValidPlayer && !matchValid(game, game.players[pid], p.ValidPlayer, s.ctx)) continue;
    if (p.ValidCard && !matchValid(game, card, p.ValidCard.replace(/CARDNAME/g, 'Card.Self'), s.ctx)) continue;
    if (p.ValidSA && !p.ValidSA.split(',').some(v => (kind === 'spell' ? /^Spell/.test(v.trim()) && (!/MayPlaySource/.test(v) || !!(opt && opt.mayPlay)) : /^Activated/.test(v.trim())))) continue;
    if (p.AffectedZone && kind === 'spell' && !p.AffectedZone.split(',').map(Z).includes((opt && opt.from) || card.zone)) continue;
    convs.push(p.ManaConversion);
  }
  if (!convs.length) return mana;
  const m = cloneCost(mana);
  const NAME = { White: 'W', Blue: 'U', Black: 'B', Red: 'R', Green: 'G', C: 'C', Colorless: 'C' };
  for (const conv of convs) {
    for (const part of conv.split(/\s+/)) {
      const mm = part.match(/^(\w+)->(\w+)$/);
      if (!mm) continue; // "nonWhite<-C": other mana only as though it were colorless (a restriction, not applied)
      const [, from, to] = mm;
      if (from === 'AnyType') {
        // any mana pays colored symbols (and {C} too when it's "as though it were mana of any type")
        for (const c of ANY) { m.generic += m.colored[c] || 0; m.colored[c] = 0; }
        if (to === 'AnyType') { m.generic += m.colored.C || 0; m.colored.C = 0; }
        m.generic += m.hybrid.length; m.hybrid = [];
        continue;
      }
      const src = NAME[from];
      if (!src) continue;
      const targets = to === 'AnyColor' ? ANY : [NAME[to]].filter(Boolean);
      for (const c of targets) {
        if (c === src) continue;
        const k = m.colored[c] || 0;
        m.colored[c] = 0;
        for (let i = 0; i < k; i++) m.hybrid.push([c, src]);
      }
      m.hybrid = m.hybrid.map(h => (h.some(x => targets.includes(x)) && !h.includes(src) ? [...h, src] : h));
    }
  }
  return m;
}

// spellCost's hook: the handled statics (an estimate before targets) and mana conversion
export function paramSpellCost(game, pid, card, opt, sa, mana) {
  if (!sa) return mana;
  const mods = paramCostMods(game, { kind: 'spell', pid, card, sa, opt, final: false });
  const { mana: m, applied } = applyCostMods(mana, mods);
  sa._paCostApplied = applied;
  return convertMana(game, m, { kind: 'spell', pid, card, opt, extra: opt && opt.manaConversion ? [opt.manaConversion] : [] });
}

// activated abilities: the cost statics and mana conversion (abilities.js manaConverted)
export function paramAbilityCost(game, sa, mana) {
  if (!sa || !sa.host || !sa.host.isCard || !mana) return mana;
  const mods = paramCostMods(game, { kind: 'ability', pid: sa.controller, card: sa.host, sa, final: false });
  const { mana: m, applied } = applyCostMods(mana, mods);
  sa._paCostApplied = applied;
  return convertMana(game, m, { kind: 'ability', pid: sa.controller, card: sa.host, extra: sa.abil && sa.abil.manaConversion ? [sa.abil.manaConversion] : [] });
}

// Once targets (and X) are chosen: announce what the cost asks for ("exile any number of blue cards", March of
// Swirling Mist; "tap any number of creatures", Explosive Singularity), then trade the estimate for the real changes.
// Returns the new { mana, extra }. kind: 'spell' | 'ability'.
export async function paramCostAfterTargets(game, kind, pid, card, opt, sa, mana, extra) {
  const applied = sa._paCostApplied;
  if (!applied) return { mana, extra };
  const { parseCost, canPayNonMana, Cancelled } = await engine();
  const st = opt && opt.mayPlay && opt.mayPlay.st;
  if (kind === 'spell' && st && st.parsed.p.ValidAfterStack && !validAfterStack(game, sa, card, st)) {
    game.log(`${game.name(card)} can't be cast this way with that X (${game.name(st.host)}).`, { type: 'info' });
    throw new Cancelled();
  }
  // announced numbers the handled cost statics depend on
  if (kind === 'spell' && sa.p.Announce) {
    for (const name of sa.p.Announce.split(',').map(s => s.trim()).filter(Boolean)) {
      if (name === 'X' || !costStaticsMention(card, name)) continue;
      const setN = n => { const svars = { ...sa.svars, [name]: `Number$${n}` }; for (const s of sa.chain()) s.svars = svars; };
      let max = 0;
      for (let n = 1; n <= 20; n++) {
        setN(n);
        const m2 = paramCostMods(game, { kind, pid, card, sa, opt, final: true });
        const parts = m2.parts.flatMap(c => parseCost(c).parts);
        if (!parts.length && !m2.addMana) break;
        if (parts.length && !canPayNonMana(game, sa, { ...parseCost(''), parts: [...(extra.parts || []), ...parts] })) break;
        max = n;
      }
      let n = 0;
      if (max > 0) {
        n = await game.ask(pid, { type: 'number', prompt: `${game.name(card)}: ${sa.p.AnnounceTitle ? 'choose ' + sa.p.AnnounceTitle : 'how many?'}`, min: 0, max, purpose: 'announce', sa, announce: name, cancellable: true });
        if (n == null) throw new Cancelled();
        n = Math.max(0, Math.min(max, n | 0));
      }
      setN(n);
    }
  }
  const fin = paramCostMods(game, { kind, pid, card, sa, opt, final: true });
  const m = applyCostMods(undoCostMods(mana, applied), fin).mana;
  sa._paCostApplied = null;
  const ex = fin.parts.length ? { ...extra, parts: [...(extra.parts || []), ...fin.parts.flatMap(c => parseCost(c).parts)] } : extra;
  return { mana: m, extra: ex };
}

// does one of the card's own cost statics depend on this announced value?
function costStaticsMention(card, name) {
  const f = card.faceDef;
  const expand = (s, d = 0) => (d > 3 ? s : String(s).replace(/\b[A-Z]\w*\b/g, w => (f.svars[w] && w !== name ? expand(f.svars[w], d + 1) : w)));
  return f.statics.some(st => { const p = parseAbility(st).p; return /^(RaiseCost|ReduceCost)$/.test(p.Mode) && new RegExp(`\\b${name}\\b`).test(expand(`${p.Cost || ''} ${p.Amount || ''}`)); });
}

// "As an additional cost to cast green permanent spells, you may pay 2 life. Those spells cost {G} less" (the Defiler
// cycle): OptionalCost statics on other permanents, offered as the spell is cast. Returns the new { mana, extra }.
export async function otherOptionalCosts(game, pid, card, sa, mana, extra) {
  const { parseCost, canPayNonMana } = await engine();
  let m = mana, ex = extra;
  for (const s of game.activeStatics('OptionalCost')) {
    const p = s.p;
    if (s.host === card || !p.Cost) continue;
    if (p.ValidCard && !matchValid(game, card, p.ValidCard, s.ctx)) continue;
    if (p.ValidSA && !/^Spell/.test(p.ValidSA)) continue;
    if (p.Activator && !matchValid(game, game.players[pid], p.Activator, s.ctx)) continue;
    const c = parseCost(p.Cost);
    if (!canPayNonMana(game, sa, { ...parseCost(''), parts: [...(ex.parts || []), ...c.parts] })) continue;
    const yes = await game.ask(pid, { type: 'confirm', prompt: `${game.name(s.host)}: ${p.Description || 'pay ' + p.Cost + '?'}`, purpose: 'optionalCost', sa, cost: p.Cost, cardId: card.id });
    if (!yes) continue;
    ex = { ...ex, parts: [...(ex.parts || []), ...c.parts] };
    if (c.hasMana) m = addCosts(m, c.mana);
    if (p.ReduceColor) { m = cloneCost(m); for (const col of p.ReduceColor.split(/\s+/)) if (m.colored[col] > 0) m.colored[col]--; }
  }
  return { mana: m, extra: ex };
}

// ---------------------------------------------------------------- casting permissions (abilities.js mayPlayFrom / spellOptions)
// MayPlayLimit$ counts per static ability and per turn, as in Forge ("once each turn": As Foretold; Muldrotha's land
// and each permanent type separately)
function mayPlayKey(st) { return `${st.host.id}:${st.host.zcc ?? ''}:${st.key}`; }
export function mayPlayUsed(game, st) { return ((game.turnState.mayPlayUses || {})[mayPlayKey(st)]) || 0; }
export function noteMayPlayUse(game, st) {
  const u = game.turnState.mayPlayUses || (game.turnState.mayPlayUses = {});
  const k = mayPlayKey(st);
  u[k] = (u[k] || 0) + 1;
}

// the alternative cost a MayPlay static sets ("pay life equal to its mana value rather than pay its mana cost":
// Bolas's Citadel; "{0}": As Foretold, Darksteel Monolith), as a cost string for this card
function altManaFor(game, card, alt) {
  const mv = game.chars(card).cmc;
  return String(alt).replace(/ConvertedManaCost/g, String(mv)).replace(/CardManaCost/g, card.faceDef.manaCostStr || '0');
}
const costWords = s => String(s).replace(/^PayLife<(\d+)>$/, '$1 life').replace(/^0$/, '{0}').replace(/^(\d+)$/, '{$1}');

// Called at the end of spellOptions. mayPlay: the permission that let this card be cast from its zone, if any.
// - that permission's own changes: its alternative cost (Citadel), flash (Elsha of the Infinite)
// - statics that only change how spells you could cast anyway are cast (MayPlayDontGrantZonePermissions: As Foretold,
//   Aluren, Dracogenesis, One with the Multiverse; and permissions for your hand: Omniscience, Darksteel Monolith):
//   each adds a way to cast it, next to the usual one
export function mayPlayOptions(game, pid, card, opts, mayPlay) {
  if (!opts.length) return opts;
  if (mayPlay && mayPlay.st) {
    const p = mayPlay.st.parsed.p;
    for (const o of opts) {
      if (p.MayPlayWithFlash === 'True') o.mayFlash = true;
      if (p.MayPlayAltManaCost != null && !o.land && !o.withoutMana && !o.altCost) {
        o.altManaStr = altManaFor(game, card, p.MayPlayAltManaCost);
        o.altCost = 'MayPlay';
        o.label = `${o.label} (pay ${costWords(o.altManaStr)} — ${game.name(mayPlay.st.host)})`;
      }
    }
  }
  const base = opts.filter(o => !o.land && !o.altCost && !o.withoutMana && !o.mayPlayExtra);
  if (!base.length) return opts;
  game.ensureChars();
  for (const { st, ctx } of game._activeStatics || []) {
    const p = st.parsed.p;
    if (!p.MayPlay || (mayPlay && mayPlay.st === st)) continue;
    const zones = (p.AffectedZone || 'Battlefield').split(',').map(Z);
    if (!zones.includes(card.zone)) continue;
    // a permission for a zone the card can be cast from anyway only changes how (your hand), or says so outright
    if (p.MayPlayDontGrantZonePermissions !== 'True' && card.zone !== 'hand') continue;
    if (p.MayPlayWithoutManaCost !== 'True' && p.MayPlayAltManaCost == null && p.MayPlayWithFlash !== 'True') continue;
    if (p.Affected && !matchValid(game, card, p.Affected, ctx)) continue;
    const player = st.host.isEffect ? st.host.controller : ctx.you;
    if (player !== pid && !/Player|Opponent/.test(p.MayPlayPlayer || '')) continue;
    if (p.MayPlayPlayer && player !== pid && !matchValid(game, game.players[pid], p.MayPlayPlayer, ctx)) continue;
    if (p.MayPlayLimit && mayPlayUsed(game, st) >= +p.MayPlayLimit) continue;
    const mp = { st, without: p.MayPlayWithoutManaCost === 'True', ignoreType: p.MayPlayIgnoreType === 'True', ignoreColor: p.MayPlayIgnoreColor === 'True' };
    for (const o of base) {
      const extra = { ...o, key: `${o.key}~mp${st.host.id}${st.key}`, mayPlay: mp, mayPlayExtra: true };
      let how;
      if (mp.without) { extra.withoutMana = true; how = 'without paying its mana cost'; }
      else if (p.MayPlayAltManaCost != null) { extra.altManaStr = altManaFor(game, card, p.MayPlayAltManaCost); extra.altCost = 'MayPlay'; how = `paying ${costWords(extra.altManaStr)} instead`; }
      if (p.MayPlayWithFlash === 'True') { extra.mayFlash = true; how = how ? `${how}, with flash` : 'as though it had flash'; }
      extra.label = `${o.label} ${how} (${game.name(st.host)})`;
      opts.push(extra);
    }
  }
  return opts;
}

// ---------------------------------------------------------------- characteristics (chars.js computeAll)
// AddKeyword lists: SharedKeywordsZone$ keeps only the keywords cards there have (Soulflayer, Cairn Wanderer, Eater of
// Virtue, Urborg Scavengers), CalcKeywordN$ fills in N (Kodama of the Center Tree), KeywordDefined$ for "protection
// from each mana value among" (Rebbec)
export function addKeywordList(game, st, ctx, addKeyword) {
  let list = String(addKeyword).split(' & ');
  const p = st.parsed ? st.parsed.p : st.p;
  if (p.CalcKeywordN) { const n = calcCtx(game, p.CalcKeywordN, ctx); list = list.map(k => k.replace(/\bN\b/, String(n))); }
  if (p.KeywordDefined) {
    const out = [];
    for (const k of list) {
      if (!/EachCMCAmongDefined/.test(k)) { out.push(k); continue; }
      const mvs = new Set(game.battlefield.filter(c => matchValid(game, c, p.KeywordDefined, ctx)).map(c => game.chars(c).cmc));
      for (const mv of mvs) out.push(`Protection:Card.cmcEQ${mv}:Protection from mana value ${mv}`);
    }
    list = out;
  }
  if (p.SharedKeywordsZone) list = sharedKeywords(game, list, p.SharedKeywordsZone, p.SharedRestrictions, ctx);
  return list;
}

// the keywords in a list that cards in those zones (matching the restrictions) have (CardFactoryUtil.sharedKeywords)
function sharedKeywords(game, list, zonesSpec, restrictions, ctx) {
  const zones = zonesSpec.split(',').map(Z);
  const cards = [];
  for (const z of zones) cards.push(...(z === 'battlefield' ? game.battlefield : game.cardsInZone(z)));
  const pool = cards.filter(c => matchValid(game, c, restrictions || 'Card', ctx));
  const have = new Set(), prot = new Set(), protColor = new Set(), walk = new Set(), hexproof = new Set(), trample = new Set();
  for (const c of pool) {
    const ch = game.chars(c);
    for (const k of ch.keywords || []) {
      const name = k.split(':')[0];
      if (/walk$/.test(name) || name === 'Landwalk') walk.add(k);
      else if (/^Protection/.test(k)) {
        prot.add(k);
        for (const col of ['white', 'blue', 'black', 'red', 'green']) if (k === `Protection from ${col}` || k.includes(`${col[0].toUpperCase() + col.slice(1)}:${col}`)) protColor.add(`Protection from ${col}`);
      } else if (/^Hexproof/.test(k)) hexproof.add(k);
      else if (name === 'Trample') trample.add(k);
      else have.add(k.toLowerCase());
    }
  }
  const out = [];
  for (const k of list) {
    if (k === 'Protection') out.push(...prot);
    else if (k === 'ProtectionColor') out.push(...protColor);
    else if (k === 'Landwalk') out.push(...walk);
    else if (k === 'Hexproof') out.push(...hexproof);
    else if (k === 'Trample') out.push(...trample);
    else if (have.has(k.toLowerCase())) out.push(k);
  }
  return [...new Set(out)];
}

// is this ability entry one of these ("Activated", "Activated.Loyalty", "Activated.!ManaAbility")?
function entryIs(entry, spec) {
  return String(spec).split(',').some(alt => {
    const [type, ...rest] = alt.trim().split('.');
    if (type !== 'Activated' && type !== 'SpellAbility') return false;
    if (entry.parsed.kind !== 'AB') return false;
    const p = entry.parsed.p;
    return rest.join('.').split('+').filter(Boolean).every(pr => {
      const neg = pr.startsWith('!'); const q = neg ? pr.slice(1) : pr;
      const r = q === 'Loyalty' ? p.Planeswalker === 'True' : q === 'ManaAbility' ? entry.parsed.api === 'Mana' : false;
      return neg ? !r : r;
    });
  });
}

// Layer 6, after the statics' own grants: abilities gained from other cards (GainsAbilitiesOf$ with
// GainsAbilitiesOfZones$, GainsAbilitiesOfDefined$, GainsValidAbilities$, GainsAbilitiesLimitPerTurn$,
// GainsTriggerAbsOf$, ManaConversion$: Necrotic Ooze, Agatha's Soul Cauldron, Drana and Linvala, Mairsil, Koh),
// AddReplacementEffect$ (Master Chef, Cloudsteel Kirin), RemoveNonManaAbilities$ (Blood Sun)
export function paramAbilitiesLayer(game, active, map, affected, chOf) {
  for (const { st, ctx } of active) {
    const p = st.parsed.p;
    if (!(p.GainsAbilitiesOf || p.GainsAbilitiesOfDefined || p.GainsTriggerAbsOf || p.AddReplacementEffect || p.RemoveNonManaAbilities)) continue;
    const targets = affected(st, ctx);
    if (!targets.length) continue;
    const sources = spec => {
      if (!spec) return [];
      if (spec === p.GainsAbilitiesOfDefined) return resolveDefined(game, spec, ctx).map(o => (o && o.lki ? game.cardById(o.id) || o : o)).filter(o => o && (o.isCard || o.lki));
      const zones = (p.GainsAbilitiesOfZones || 'Battlefield').split(',').map(Z);
      const out = [];
      for (const z of zones) for (const c of z === 'battlefield' ? game.battlefield : game.cardsInZone(z)) if (!c.phasedOut && matchValid(game, c, spec, ctx)) out.push(c);
      return out;
    };
    const abilitiesOf = (c, kind) => {
      if (c.zone === 'battlefield' && map.get(c.id)) return map.get(c.id)[kind];
      const f = c.lki ? null : c.faceDef;
      if (!f) return (c.chars && c.chars[kind]) || [];
      return abilityList(kind === 'abilities' ? f.abilities : f.triggers, f.svars, c, `${c.face}${kind === 'abilities' ? 'A' : 'T'}`);
    };
    const gainFrom = [...sources(p.GainsAbilitiesOf), ...sources(p.GainsAbilitiesOfDefined)];
    const trigFrom = sources(p.GainsTriggerAbsOf);
    for (const c of targets) {
      const ch = chOf(c);
      for (const src of gainFrom) {
        if (src.id === c.id) continue;
        for (const a of abilitiesOf(src, 'abilities')) {
          if (a.gainedFrom != null || a.parsed.kind !== 'AB') continue;
          if (p.GainsValidAbilities && !entryIs(a, p.GainsValidAbilities)) continue;
          if (ch.abilities.some(b => b.raw === a.raw && b.gainedFrom === src.id)) continue;
          if (ch.abilities.some(b => b.raw === a.raw && b.gainedFrom == null && a.src === c)) continue;
          let entry = { ...a, key: `ga${src.id}:${a.key}`, gainedFrom: src.id };
          // "you can activate each of those abilities only once each turn" (Mairsil, the Pretender)
          if (p.GainsAbilitiesLimitPerTurn) { const raw = `${a.raw} | ActivationLimit$ ${p.GainsAbilitiesLimitPerTurn}`; entry = { ...entry, raw, parsed: parseAbility(raw) }; }
          // "you may spend mana as though it were mana of any type to activate those abilities"
          if (p.ManaConversion) entry.manaConversion = p.ManaConversion;
          ch.abilities.push(entry);
        }
      }
      for (const src of trigFrom) {
        if (src.id === c.id) continue;
        for (const t of abilitiesOf(src, 'triggers')) if (!ch.triggers.some(b => b.raw === t.raw && b.gainedFrom === src.id)) ch.triggers.push({ ...t, key: `gt${src.id}:${t.key}`, gainedFrom: src.id });
      }
      if (p.AddReplacementEffect) {
        for (const n of p.AddReplacementEffect.split(' & ').map(x => x.trim())) {
          const raw = st.svars[n];
          if (raw && /\$/.test(raw) && !ch.replacements.some(r => r.key === `sr${st.host.id}${st.key}:${n}`)) ch.replacements.push({ raw, parsed: parseAbility(raw), svars: st.svars, src: st.host, key: `sr${st.host.id}${st.key}:${n}` });
        }
      }
      // "All lands lose all abilities except mana abilities." (Blood Sun: shocklands enter untapped, fetchlands do nothing)
      if (p.RemoveNonManaAbilities) {
        ch.abilities = ch.abilities.filter(a => a.parsed.api === 'Mana');
        ch.triggers = []; ch.statics = []; ch.replacements = [];
      }
    }
  }
}

// After every layer-6 grant (including keyword counters): "can't have or gain" (the Archetypes, Arcane Lighthouse),
// names set by effects (Witness Protection, Psychic Paper), artifact subtypes removed (Swift Reconfiguration)
export function paramFinalLayer(game, active, map, affected, chOf) {
  for (const { st, ctx } of active) {
    const p = st.parsed.p;
    if (!(p.CantHaveKeyword || p.SetName || p.RemoveArtifactTypes)) continue;
    for (const c of affected(st, ctx)) {
      const ch = chOf(c);
      if (p.CantHaveKeyword) {
        const no = p.CantHaveKeyword.split(' & ').map(k => k.trim());
        ch.keywords = ch.keywords.filter(k => !no.some(n => k === n || k.startsWith(n + ':') || (n === 'Hexproof' && /^Hexproof/.test(k)) || (n === 'Protection' && /^Protection/.test(k))));
        (ch.cantHave = ch.cantHave || []).push(...no);
      }
      if (p.SetName) ch.name = p.SetName === 'ChosenName' ? ((st.host.chosen && st.host.chosen.name) || ch.name) : p.SetName;
      if (p.RemoveArtifactTypes) {
        const keep = new Set(String(p.AddType || '').split(' & ').map(x => x.trim()));
        for (const t of [...ch.subtypes]) if (ARTIFACT_TYPES.has(t) && !keep.has(t)) ch.subtypes.delete(t);
      }
    }
  }
}
const ARTIFACT_TYPES = new Set(['Attraction', 'Blood', 'Bobblehead', 'Clue', 'Contraption', 'Equipment', 'Food', 'Fortification', 'Gold', 'Incubator', 'Infinity', 'Junk', 'Lander', 'Map', 'Powerstone', 'Shard', 'Spacecraft', 'Stone', 'Treasure', 'Vehicle']);


// ---------------------------------------------------------------- damage redirection (game.js applyDamageReplacements / dealDamage)
// "All damage that would be dealt to you is dealt to enchanted creature instead" (Pariah, Palisade Giant, Protector of
// the Crown: ReplaceEffect | VarName$ Affected | VarType$ Card) and "the next N damage ... is dealt to target creature
// instead" (Harm's Way, Nomads en-Kor, Martyrdom: ReplaceSplitDamage | DamageTarget$). Returns 'redirect' when the
// replacement moved some or all of the damage (rp.redirectTo / rp.splitTo, rp.DamageAmount what stays), 'skip' when it
// can't apply (no legal new target), or null when it isn't a redirection.
export function damageRedirect(game, h, r, p, parsed, ctx, rp) {
  if (parsed.api === 'ReplaceEffect' && parsed.p.VarName === 'Affected') {
    const to = resolveDefined(game, parsed.p.VarValue || p.DamageTarget || 'Self', ctx).map(o => (o && o.lki ? game.cardById(o.id) : o))[0];
    if (!damageable(to) || to === rp.Affected) return 'skip';
    rp.redirectTo = to;
    return 'redirect';
  }
  if (parsed.api === 'ReplaceSplitDamage') {
    const to = resolveDefined(game, parsed.p.DamageTarget || p.DamageTarget || 'Remembered', ctx).map(o => (o && o.lki ? game.cardById(o.id) : o))[0];
    if (!damageable(to) || to === rp.Affected) return 'skip';
    // the shield: how much is left to move (an SVar such as ShieldAmount, else 1), kept on the object that has it
    const key = `paShield:${r.key}`;
    if (h[key] == null) h[key] = parsed.p.VarName ? calcCtx(game, parsed.p.VarName, ctx) : 1;
    const n = Math.min(rp.DamageAmount, h[key]);
    if (n <= 0) return 'skip';
    h[key] -= n;
    rp.splitTo = (rp.splitTo || []).concat([{ target: to, n }]);
    rp.DamageAmount -= n;
    // a one-shot shield is used up: the effect ends (Harm's Way's 2, Nomads en-Kor's 1)
    if (h[key] <= 0 && h.isEffect) game.effects = game.effects.filter(e => e !== h);
    return 'redirect';
  }
  return null;
}
const damageable = o => !!o && ((o.isPlayer && !o.lost) || (o.isCard && o.zone === 'battlefield'));

// dealDamage's hook, once replacements ran: deal what was redirected to its new targets. Returns the damage dealt when
// nothing is left for the original target, else null (the rest is dealt as usual).
export async function dealRedirected(game, source, rp, opts) {
  if (!rp.redirectTo && !rp.splitTo) return null;
  const o2 = { ...opts, redirectApplied: rp._applied };
  let dealt = 0;
  for (const { target, n } of rp.splitTo || []) dealt += (await game.dealDamage(source, target, n, o2)) || 0;
  if (rp.redirectTo) return dealt + ((await game.dealDamage(source, rp.redirectTo, rp.DamageAmount, o2)) || 0);
  return rp.DamageAmount > 0 ? null : dealt;
}

// ---------------------------------------------------------------- targeting (abilities.js targetCandidates)
// TargetsWithDefinedController$: "target creature card in your graveyard" (Mortuary Mire), "target creature that player
// controls" (Grenzo, Chandra's Incinerator); TargetValidTargeting$: "counter target spell or ability that targets you or
// a creature you control" (Siren Stormtamer, Rebuff the Wicked, Dawn Charm)
export function paramTargetFilter(game, sa, cands) {
  const p = sa.p;
  if (!p.TargetsWithDefinedController && !p.TargetValidTargeting) return cands;
  const ctx = ctxOf(game, sa);
  let out = cands;
  if (p.TargetsWithDefinedController) {
    const ids = new Set(resolveDefined(game, p.TargetsWithDefinedController, ctx).map(o => (!o ? null : o.isPlayer ? o.id : o.stackItem ? o.controller : o.zone === 'battlefield' || o.lki ? o.controller : o.owner)).filter(x => x != null));
    out = out.filter(o => !o || o.isPlayer || o.stackItem || ids.has(o.zone === 'battlefield' ? o.controller : o.owner));
  }
  if (p.TargetValidTargeting) {
    const spec = p.TargetValidTargeting.replace(/inRealZoneBattlefield/g, 'inZoneBattlefield');
    out = out.filter(o => {
      if (!o || !o.stackItem) return true;
      const ts = o.sa ? o.sa.chain().flatMap(s => [...(s.targets || []), ...(s.modes || []).flatMap(m => m.targets || [])]) : [];
      return ts.some(t => t && matchValid(game, t.lki ? game.cardById(t.id) || t : t, spec, ctx));
    });
  }
  return out;
}

// ValidAfterStack$ on a may-play permission, checked once the spell's X and targets are known ("cast a permanent spell
// with mana value 2 or less from your graveyard": Lurrus; Serra Paragon)
export function validAfterStack(game, sa, card, st) {
  const spec = st.parsed.p.ValidAfterStack;
  const face = card.def.faces[sa.face || 0] || card.faceDef;
  const mc = face.manaCost;
  const mv = (mc ? cmc(mc) + (mc.x || 0) * (sa.x || 0) : 0);
  return spec.split(',').some(alt => {
    const [type, ...rest] = alt.trim().split('.');
    if (type !== 'Spell') return true; // abilities: not checked here
    const props = rest.join('.').split('+').filter(Boolean);
    return props.every(pr => {
      const m = pr.match(/^cmc(LE|LT|EQ|GE|GT|NE)(\d+)$/);
      if (m) return compareSpec(game, mv, m[1] + m[2], ctxOf(game, sa));
      return matchCastSA(game, sa, card, 'Spell.' + pr, ctxOf(game, sa));
    });
  });
}

// ---------------------------------------------------------------- mana produced (abilities.js producedUnits)
// ProduceMana replacements that change the mana a permanent is tapped for, not just its amount: Contamination,
// Infernal Darkness, Pale Moon, Chaos Moon, Naked Singularity (ReplaceType), Damping Sphere ("two or more mana: {C}
// instead", ManaAmount$), Harvest Mage (ReplaceMana$ Any), Hall of Gemstone (ReplaceColor$ Chosen), Quarum Trench
// Gnomes (ReplaceOnly$). Each unit is the list of colors one mana can be; the planner and the tapping both use this.
const SHORT = { White: 'W', Blue: 'U', Black: 'B', Red: 'R', Green: 'G', Colorless: 'C', W: 'W', U: 'U', B: 'B', R: 'R', G: 'G', C: 'C' };
export function replaceProducedUnits(game, card, units) {
  if (!units.length || !card || !card.isCard) return units;
  let out = units;
  // (asked for every source the payment planner considers: the replacements are looked up once per game state)
  if (!game._paProduce || game._paProduce.v !== game.version) game._paProduce = { v: game.version, list: game.replacementsFor('ProduceMana') };
  for (const { h, r, p, ctx } of game._paProduce.list) {
    if (p.ValidActivator && !matchValid(game, game.players[card.controller], p.ValidActivator, ctx)) continue;
    if (p.ValidCard && !matchValid(game, card, p.ValidCard, ctx)) continue;
    if (p.ValidSA) continue; // (spells and abilities that add mana: False Dawn)
    if (p.ManaAmount && !compareSpec(game, out.length, p.ManaAmount, ctx)) continue;
    const w = p.ReplaceWith && r.svars[p.ReplaceWith];
    const q = w ? parseAbility(w) : null;
    if (!q || q.api !== 'ReplaceMana' || q.p.ReplaceAmount) continue; // (amounts are multiplied as the mana is made)
    const any = ['W', 'U', 'B', 'R', 'G'];
    if (q.p.ReplaceMana) out = [q.p.ReplaceMana === 'Any' ? any : [SHORT[q.p.ReplaceMana] || 'C']];
    else if (q.p.ReplaceType) { const t = q.p.ReplaceType === 'Any' ? any : [SHORT[q.p.ReplaceType] || 'C']; out = out.map(() => t.slice()); }
    else if (q.p.ReplaceColor) {
      const to = q.p.ReplaceColor === 'Chosen' ? ((h.chosen && h.chosen.colors) || []).slice(0, 1) : [SHORT[q.p.ReplaceColor]].filter(Boolean);
      if (!to.length) continue;
      const only = q.p.ReplaceOnly ? SHORT[q.p.ReplaceOnly] : null;
      out = out.map(u => [...new Set(u.map(c => (only ? c === only : c !== 'C') ? to[0] : c))]);
    }
  }
  return out;
}

// "If you would lose unspent mana, that mana becomes black / red / colorless instead" (Omnath, Locus of All; Ozai;
// Kruphix): the color lost mana turns into (game.js emptyPools)
export function loseManaColor(game, pl) {
  for (const { r, p, ctx } of game.replacementsFor('LoseMana')) {
    if (p.ValidPlayer && !matchValid(game, pl, p.ValidPlayer, ctx)) continue;
    const w = p.ReplaceWith && r.svars[p.ReplaceWith];
    const q = w ? parseAbility(w) : null;
    const t = q && (q.p.ReplaceType || q.p.ReplaceMana);
    if (t && SHORT[t]) return SHORT[t];
  }
  return 'C';
}
