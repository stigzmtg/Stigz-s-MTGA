// Card-script parameters that cards rely on but the rest of the engine did not read (see tools/paramaudit.mjs).
// Each section is called from a small hook in the module that owns the event (game.js, triggers.js, effects.js,
// chars.js, abilities.js). This module imports only leaf modules statically: it is loaded from chars.js before
// abilities.js / effects.js exist, so those are reached with import() inside async functions (already loaded by then).
import { matchValid, resolveDefined, calcCtx, compareSpec, ctxOf, zoneMap } from './filters.js';
import { parseAbility } from './forge.js';

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
