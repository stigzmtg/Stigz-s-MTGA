// Recent sets' mechanics and common effects: the Avatar bending actions (earthbend, airbend, waterbend costs,
// firebending's combat mana), losing abilities (Debuff), endure, recruit, detain, day and night, the Ring
// tempting you, speed changes, "tap or untap all", and the triggers and replacements that watch for them.
// Effect handlers are merged into effects.js's E; the hooks below are called from the shared engine files.
// (Only imported bindings used inside functions: this module sits in an import cycle with effects.js.)
import { matchValid, resolveDefined, calc, ctxOf, liveOrLki } from './filters.js';
import { makeSA, canAfford } from './abilities.js';
import { runEffect } from './effects.js';
import { cloneCost } from './mana.js';
import { parseAbility } from './forge.js';

const hasTgtSpec = sa => !!(sa.p.ValidTgts || sa.p.TargetType);
const isCard = o => !!o && (o.isCard || o.lki);
const live = (game, o) => (o && o.lki ? liveOrLki(game, o) : o);

function objs(game, sa, def = null) {
  if (hasTgtSpec(sa)) return sa.targets.map(t => (t.isCard || t.lki) ? liveOrLki(game, t) : t);
  const d = sa.p.Defined || def;
  if (!d) return [];
  if (d === 'Self' && sa.etbCard) return [sa.etbCard];
  return resolveDefined(game, d, ctxOf(game, sa));
}
function num(game, sa, key, d = 0) { const v = sa.p[key]; return v == null || v === '' ? d : calc(game, v, sa); }
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

async function askCards(game, pid, cards, min, max, prompt, sa, purpose, extra = {}) {
  if (!cards.length) return [];
  max = Math.min(max, cards.length); min = Math.min(min, max);
  if (max <= 0) return [];
  const ids = await game.ask(pid, { type: 'cards', prompt, cards: cards.map(c => c.id), min, max, sa, purpose, ...extra });
  return (ids || []).map(id => game.cardById(id)).filter(c => c && cards.includes(c)).slice(0, max);
}

// an effect object in the command zone (like effects.js's Effect), with statics / triggers built from raw strings
function makeEffectObject(game, { name, controller, statics = [], triggers = [], svars = {}, remembered = [], duration = 'Permanent', hostCard = null, desc = '' }) {
  const e = {
    isEffect: true, id: game.nextId++, effectName: name, controller, owner: controller, zone: 'command', duration,
    remembered, imprinted: [], chosen: {}, counters: {}, timestamp: game.uid++, temp: [], mods: [], hostCard, xPaid: 0, abilityUses: {}, description: desc,
  };
  setEffectAbilities(e, statics, triggers, svars);
  return e;
}
function setEffectAbilities(e, statics, triggers, svars) {
  const mk = (raw, i, kind) => ({ raw, parsed: parseAbility(raw), svars, src: e, key: `e${e.id}${kind}${i}` });
  e.effectChars = { name: e.effectName, types: new Set(['Effect']), subtypes: new Set(), supertypes: new Set(), colors: new Set(), keywords: [], abilities: [], triggers: triggers.map((r, i) => mk(r, i, 'T')), statics: statics.map((r, i) => mk(r, i, 'S')), replacements: [], svars, power: 0, toughness: 0, cmc: 0 };
}
// ------------------------------------------------------------------ the four bending actions (Avatar: TLA)
// "whenever you waterbend, earthbend, firebend, or airbend" (Avatar Aang): which ones this turn, and the trigger
export function noteBend(game, pid, kind) {
  const p = game.players[pid];
  if (!p) return;
  if (!p.bends || p.bends.turn !== game.turnNumber) p.bends = { turn: game.turnNumber, kinds: [] };
  if (!p.bends.kinds.includes(kind)) p.bends.kinds.push(kind);
  game.fire('ElementalBend', { Player: pid, Bend: kind });
  game.fire(kind, { Player: pid });
}
export function allFourBends(game, pid) {
  const b = game.players[pid] && game.players[pid].bends;
  return !!b && b.turn === game.turnNumber && b.kinds.length >= 4;
}

// earthbend N: target land you control becomes a 0/0 creature with haste that's still a land, gets N +1/+1
// counters, and when it dies or is exiled it returns to the battlefield tapped (under the earthbender's control)
async function earthbend(game, sa) {
  const pid = sa.controller;
  const n = num(game, sa, 'Num', 1);
  for (const c of objs(game, sa).filter(isCard).map(o => live(game, o))) {
    if (!c || c.lki || c.zone !== 'battlefield') continue;
    c.mods.push({ id: game.uid++, src: sa.host, svars: {}, power: 0, toughness: 0, types: ['Creature'], keywords: ['Haste'], until: 'Permanent', owner: pid, earthbent: true });
    game.touch();
    game.log(`${game.players[pid].name} earthbends ${n}: ${game.name(c)} becomes a 0/0 creature with haste.`);
    if (n > 0) await game.addCounters(c, 'P1P1', n, sa);
    game.delayed.push({
      id: game.uid++, host: sa.host, controller: pid, remembered: [c], turn: game.turnNumber,
      p: { Mode: 'ChangesZone', Origin: 'Battlefield', Destination: 'Graveyard,Exile', ValidCard: 'Card.IsTriggerRemembered', Execute: 'NSEarthbendReturn', TriggerDescription: `When ${game.name(c)} dies or is exiled, return it to the battlefield tapped (earthbend).` },
      svars: { NSEarthbendReturn: 'DB$ ChangeZone | Defined$ DelayTriggerRemembered | Origin$ Graveyard,Exile | Destination$ Battlefield | Tapped$ True | GainControl$ True' },
    });
  }
  noteBend(game, pid, 'Earthbend');
}

// airbend: exile it; while it's exiled, its owner may cast it for {2} rather than its mana cost
async function airbend(game, sa) {
  const moved = [];
  for (const t of objs(game, sa)) {
    if (!t) continue;
    let card = null;
    if (t.stackItem) {
      if (!game.stack.includes(t)) continue;
      game.stack.splice(game.stack.indexOf(t), 1);
      game.touch();
      if (!t.card) continue;
      if (t.isCopy) { t.card.zone = 'gone'; game.cards.delete(t.card.id); continue; }
      card = t.card;
    } else if (isCard(t)) {
      card = live(game, t);
      if (!card || card.lki || (card.zone !== 'battlefield' && card.zone !== 'stack')) continue;
      if (card.zone === 'stack') { const it = game.stack.find(s => s.card === card); if (it) game.stack.splice(game.stack.indexOf(it), 1); }
    } else continue;
    const was = game.name(card);
    const r = await game.moveCard(card, 'exile', { cause: sa });
    if (!r || r.zone !== 'exile' || r.token) continue;
    moved.push(r);
    const owner = r.owner;
    const e = makeEffectObject(game, {
      name: `Airbend ${was}`, controller: owner, remembered: [r], hostCard: sa.host,
      statics: [`Mode$ Continuous | MayPlay$ True | MayPlayAltManaCost$ 2 | EffectZone$ Command | Affected$ Card.IsRemembered+nonLand | AffectedZone$ Exile | Description$ ${game.players[owner].name} may cast ${was} for {2} rather than its mana cost.`],
      triggers: ['Mode$ ChangesZone | Origin$ Exile | Destination$ Any | ValidCard$ Card.IsRemembered | Static$ True | Execute$ NSAirbendEnd | TriggerDescription$ The airbend effect ends.'],
      svars: { NSAirbendEnd: 'DB$ ChangeZone | Defined$ Self | Origin$ Command | Destination$ Exile' },
      desc: `${was} was airbent: its owner may cast it for {2} while it's exiled.`,
    });
    e.forgetOnCast = 'Card.IsRemembered';
    game.effects.push(e);
    game.touch();
  }
  if (moved.length) {
    game.log(`${game.players[sa.controller].name} airbends ${moved.map(c => game.name(c)).join(', ')} (${moved.length > 1 ? 'their owners' : 'its owner'} may cast ${moved.length > 1 ? 'them' : 'it'} for {2}).`);
    noteBend(game, sa.controller, 'Airbend');
  }
}

// ------------------------------------------------------------------ waterbend {N}: tap artifacts and creatures to pay {1} each
// parseCost turns "Waterbend<N>" into N generic mana marked mana.waterbend = N (or 'X'); the planner may count
// untapped artifacts and creatures for it, and paying asks which ones to tap.
const tapCost = (game, pid, c) => {
  const ch = game.chars(c);
  let v = ch.types.has('Creature') ? 4 + Math.max(0, ch.power) : 1;
  if (ch.abilities.some(a => a.parsed.api === 'Mana' && /(^|\s)T(\s|$)/.test(a.parsed.p.Cost || ''))) v += 3; // it could make mana itself
  if (ch.types.has('Creature') && c.sick && game.activePlayer === pid) v -= 2; // it can't attack this turn anyway
  if (c.token) v -= 0.5;
  return v;
};
function waterbendCap(manaCost, sa = null) {
  const wb = manaCost && manaCost.waterbend;
  if (!wb) return 0;
  const n = wb === 'X' ? (sa && sa.root ? (sa.root().x ?? manaCost.generic) : manaCost.generic) : +wb || 0;
  return Math.max(0, Math.min(n, manaCost.generic));
}
function waterbendCands(game, pid, exclude) {
  return game.battlefield.filter(c => c.controller === pid && !c.tapped && !c.phasedOut && !(exclude && exclude.has(c.id)) && (game.chars(c).types.has('Creature') || game.chars(c).types.has('Artifact')))
    .sort((a, b) => tapCost(game, pid, a) - tapCost(game, pid, b) || a.id - b.id);
}
// extra payment sources for the planner (canAfford): each untapped artifact / creature pays {1}, at most N of them
export function waterbendSources(game, pid, manaCost, exclude, opts = {}) {
  const cap = waterbendCap(manaCost) || (opts.waterbend ? Math.min(+opts.waterbend || manaCost.generic, manaCost.generic) : 0);
  if (!cap) return [];
  return waterbendCands(game, pid, exclude).slice(0, cap).map(c => ({ key: 'waterbend:' + c.id, card: c, waterbend: true, units: [['C']], penalty: 4 + tapCost(game, pid, c) / 10, sig: 'wb' + c.id, excl: 'tap' + c.id }));
}
export function waterbendCount(game, pid, opts = {}) {
  if (!opts.waterbend) return 0;
  return waterbendCands(game, pid, opts.exclude).length;
}
// before the mana is paid: the player taps artifacts / creatures for part of the waterbend cost (each pays {1});
// returns the rest of the cost to pay with mana
export async function payWaterbend(game, pid, manaCost, opts = {}) {
  const { exclude = new Set(), sa = null } = opts;
  noteBend(game, pid, 'Waterbend');
  const cap = waterbendCap(manaCost, sa);
  const rest = k => { const m = cloneCost(manaCost); m.generic -= k; delete m.waterbend; return m; };
  const afford = (k, ex) => canAfford(game, pid, rest(k), { exclude: new Set([...exclude, ...ex]), spellCard: opts.spellCard, abilityHost: opts.abilityHost, costHasX: opts.costHasX });
  const cands = waterbendCands(game, pid, exclude);
  const max = Math.min(cap, cands.length);
  if (!max) return rest(0);
  // the fewest taps that leave the rest payable (tapping the cheapest ones)
  let need = 0;
  while (need < max && !afford(need, cands.slice(0, need).map(c => c.id))) need++;
  let chosen = null;
  let why = '';
  for (let tries = 0; tries < 3 && !chosen; tries++) {
    const picked = await askCards(game, pid, cands, need, max, `${why}Waterbend {${cap}}: tap artifacts and creatures you control to pay {1} each${need ? ` (at least ${need})` : ''}; mana pays the rest`, sa, 'waterbend', { cancellable: false });
    if (afford(picked.length, picked.map(c => c.id))) chosen = picked;
    else why = "That leaves too much to pay with mana. ";
  }
  if (!chosen) chosen = cands.slice(0, need);
  for (const c of chosen) {
    c.tapped = true; game.touch();
    game.fire('Taps', { Card: c, Player: pid });
  }
  if (chosen.length) game.log(`${game.players[pid].name} waterbends, tapping ${chosen.map(c => game.name(c)).join(', ')} (${chosen.length === 1 ? 'it pays' : 'they pay'} {${chosen.length}}).`, { type: 'mana' });
  return rest(chosen.length);
}

// ------------------------------------------------------------------ firebending's mana lasts until end of combat
const COMBAT_STEPS = ['beginCombat', 'declareAttackers', 'declareBlockers', 'firstStrikeDamage', 'combatDamage', 'endCombat'];
export async function afterMana(game, sa, colors) {
  const pid = sa.controller;
  const pl = game.players[pid];
  if (sa.p.CombatMana === 'True' && game.combat && COMBAT_STEPS.includes(game.step)) {
    if (!pl.combatMana || pl.combatMana.turn !== game.turnNumber || pl.combatMana.combat !== game.combatsThisTurn) pl.combatMana = { turn: game.turnNumber, combat: game.combatsThisTurn, pool: {} };
    for (const c of colors) pl.combatMana.pool[c] = (pl.combatMana.pool[c] || 0) + 1;
  }
  if (sa.p.Firebending === 'True') noteBend(game, pid, 'Firebend');
}
// emptying mana pools between steps: combat mana stays until combat ends
export function keepCombatMana(game, pl, np) {
  const cm = pl.combatMana;
  if (!cm) return;
  if (!COMBAT_STEPS.includes(game.step) || cm.turn !== game.turnNumber || cm.combat !== game.combatsThisTurn) { pl.combatMana = null; return; }
  for (const [k, n] of Object.entries(cm.pool)) {
    const keep = Math.min(n, pl.pool[k] || 0);
    cm.pool[k] = keep;
    np[k] = Math.max(np[k] || 0, keep);
  }
}

// ------------------------------------------------------------------ the Ring tempts you (LTR)
const RING_LEVELS = [
  { statics: ['Mode$ Continuous | EffectZone$ Command | Affected$ Card.YouCtrl+IsRingbearer | AddType$ Legendary | Description$ Your Ring-bearer is legendary and can\'t be blocked by creatures with greater power.',
    'Mode$ CantBlockBy | EffectZone$ Command | ValidAttacker$ Card.YouCtrl+IsRingbearer | ValidBlockerRelative$ Creature.powerGTAttacker | Description$ Your Ring-bearer can\'t be blocked by creatures with greater power.'] },
  { triggers: ['Mode$ Attacks | ValidCard$ Card.YouCtrl+IsRingbearer | TriggerZones$ Command | Execute$ RingLoot | TriggerDescription$ Whenever your Ring-bearer attacks, draw a card, then discard a card.'] },
  { triggers: ['Mode$ AttackerBlockedByCreature | ValidCard$ Card.YouCtrl+IsRingbearer | ValidBlocker$ Creature | TriggerZones$ Command | Execute$ RingSac | TriggerDescription$ Whenever your Ring-bearer becomes blocked by a creature, that creature\'s controller sacrifices it at end of combat.'] },
  { triggers: ['Mode$ DamageDone | ValidSource$ Card.YouCtrl+IsRingbearer | ValidTarget$ Player | CombatDamage$ True | TriggerZones$ Command | Execute$ RingDrain | TriggerDescription$ Whenever your Ring-bearer deals combat damage to a player, each opponent loses 3 life.'] },
];
const RING_SVARS = {
  RingLoot: 'DB$ Draw | Defined$ You | NumCards$ 1 | SubAbility$ RingLootDiscard',
  RingLootDiscard: 'DB$ Discard | Defined$ You | NumCards$ 1 | Mode$ TgtChoose',
  RingSac: 'DB$ DelayedTrigger | Mode$ Phase | Phase$ EndCombat | RememberObjects$ TriggeredBlockerLKICopy | Execute$ RingSacNow | TriggerDescription$ At end of combat, the creature that blocked the Ring-bearer is sacrificed.',
  RingSacNow: 'DB$ SacrificeAll | Defined$ DelayTriggerRememberedLKI',
  RingDrain: 'DB$ LoseLife | Defined$ Opponent | LifeAmount$ 3',
};
export const RING_TEXT = ['Your Ring-bearer is legendary and can\'t be blocked by creatures with greater power.', 'Whenever your Ring-bearer attacks, draw a card, then discard a card.', 'Whenever your Ring-bearer becomes blocked by a creature, that creature\'s controller sacrifices it at end of combat.', 'Whenever your Ring-bearer deals combat damage to a player, each opponent loses 3 life.'];
function updateRing(game, pid) {
  const pl = game.players[pid];
  const level = Math.min(4, pl.ringTempted || 0);
  let e = game.effects.find(x => x.isRing && x.controller === pid);
  if (!e) { e = makeEffectObject(game, { name: 'The Ring', controller: pid, desc: '' }); e.isRing = true; e.isEmblem = true; game.effects.push(e); }
  const lv = RING_LEVELS.slice(0, level);
  setEffectAbilities(e, lv.flatMap(l => l.statics || []), lv.flatMap(l => l.triggers || []), RING_SVARS);
  e.description = RING_TEXT.slice(0, level).join('\n');
  game.touch();
}
export function ringBearerOf(game, pid) {
  const rb = game.players[pid] && game.players[pid].ringBearer;
  if (!rb) return null;
  const c = game.cardById(rb.id);
  return c && c.zone === 'battlefield' && c.zcc === rb.zcc && c.controller === pid ? c : null;
}
export function isRingBearer(game, card) {
  const c = card && card.lki ? card.card : card;
  if (!c) return false;
  const ctrl = card.controller;
  const rb = game.players[ctrl] && game.players[ctrl].ringBearer;
  return !!rb && rb.id === c.id && rb.zcc === (card.lki ? card.zcc : c.zcc);
}

// "CARDNAME can't have more than seven dream counters on it" (Rasputin Dreamweaver)
export function capCounters(game, obj, type, n) {
  if (!obj || !obj.isCard || n <= 0) return n;
  for (const s of game.activeStatics('MaxCounter')) {
    if (String(s.p.CounterType || '').toUpperCase() !== type) continue;
    if (!matchValid(game, obj, s.p.ValidCard || 'Card', s.ctx)) continue;
    n = Math.min(n, Math.max(0, (+s.p.MaxNum || 0) - (obj.counters[type] || 0)));
  }
  return n;
}

// ------------------------------------------------------------------ batched triggers ("one or more ...")
// TapAll, SacrificedOnce, FightOnce and CounterAddedAll are fired from the single events (Taps, Sacrificed, Fight,
// counters put on one object); the triggers of one batch (until they go on the stack) are merged into one
const BATCH = { Taps: 'TapAll', Sacrificed: 'SacrificedOnce', Fight: 'FightOnce', CounterTypeAddedAll: 'CounterAddedAll' };
function modesPresent(game) {
  if (game._nsModes && game._nsModes.version === game.version) return game._nsModes.set;
  const set = new Set();
  for (const c of game.battlefield) for (const t of game.chars(c).triggers) set.add(t.parsed.p.Mode);
  for (const e of game.effects) for (const t of e.effectChars.triggers) set.add(t.parsed.p.Mode);
  for (const d of game.delayed) set.add(d.p.Mode);
  game._nsModes = { version: game.version, set };
  return set;
}
export function onFire(game, mode, rp) {
  const batch = BATCH[mode];
  if (!batch || !modesPresent(game).has(batch)) return;
  let rp2;
  if (mode === 'Taps') rp2 = { Cards: [rp.Card], Amount: 1, Player: rp.Card ? rp.Card.controller : rp.Player };
  else if (mode === 'Sacrificed') rp2 = { Cards: [rp.CardLKI || rp.Card], Amount: 1, Player: rp.Player, Cause: rp.Cause };
  else if (mode === 'Fight') rp2 = { Fighters: rp.Fighters || [rp.Fighter] };
  else rp2 = { Objects: [rp.Object], Amount: rp.Amount, CounterType: rp.CounterType, Source: rp.Source, SourcePlayer: rp.SourcePlayer, Player: rp.Player };
  const before = game.pendingTriggers.length;
  game.fire(batch, rp2);
  if (mode === 'Fight') return;
  const fresh = game.pendingTriggers.slice(before);
  for (const pt of fresh) {
    const old = game.pendingTriggers.slice(0, before).find(o => o.rp && o.rp.Mode === batch && o.host === pt.host && o.t.key === pt.t.key && o.controller === pt.controller);
    if (!old) continue;
    if (batch === 'CounterAddedAll') { old.rp.Objects = [...(old.rp.Objects || []), ...(pt.rp.Objects || [])]; old.rp.Amount = (old.rp.Amount || 0) + (pt.rp.Amount || 0); }
    else { old.rp.Cards = [...(old.rp.Cards || []), ...(pt.rp.Cards || [])]; old.rp.Amount = old.rp.Cards.length; }
    game.pendingTriggers.splice(game.pendingTriggers.indexOf(pt), 1);
  }
}

// ------------------------------------------------------------------ trigger modes
function vc(game, obj, valid, ctx) { if (!valid) return true; if (obj == null) return false; return matchValid(game, obj, valid, ctx); }
const pl = (game, id) => (id == null ? null : typeof id === 'object' ? id : game.players[id]);
const CARD_TYPES = new Set(['Artifact', 'Creature', 'Enchantment', 'Instant', 'Sorcery', 'Planeswalker', 'Land', 'Battle', 'Kindred', 'Permanent']);
// "SpellAbility.YouCtrl": the spell or ability that did it, by its controller
function causeOk(game, cause, spec, ctx) {
  if (!spec) return true;
  if (!cause) return false;
  return spec.split(',').some(alt => {
    const [type, ...rest] = alt.trim().split('.');
    if (type === 'Spell' && !cause.isSpell) return false;
    if (type === 'Activated' && (cause.isSpell || cause.isTrigger)) return false;
    return rest.join('.').split('+').filter(Boolean).every(pr => pr === 'YouCtrl' ? cause.controller === ctx.you : pr === 'OppCtrl' ? game.isOpponent(cause.controller, ctx.you) : true);
  });
}
// "Spell.Creature+wasCastByYou": the countered object was a spell, and the card's properties
function spellOk(game, rp, spec, ctx) {
  if (!spec) return true;
  return spec.split(',').some(alt => {
    const [type, ...rest] = alt.trim().split('.');
    if ((type === 'Spell' || type === 'Card') && !rp.Card) return false;
    if (type === 'Activated' || type === 'Triggered') return !rp.Card;
    return rest.join('.').split('+').filter(Boolean).every(pr => CARD_TYPES.has(pr) ? matchValid(game, rp.Card, pr, ctx) : matchValid(game, rp.Card, 'Card.' + pr, ctx));
  });
}
export const NEWSETS_TRIGGER_MODES = ['ElementalBend', 'Earthbend', 'Waterbend', 'Firebend', 'Airbend', 'DayTimeChanges', 'RingTemptsYou', 'Discover', 'ManifestDread', 'CaseSolved', 'Trains', 'Mentored', 'Championed', 'FightOnce', 'SacrificedOnce', 'CounterAddedAll', 'Proliferate', 'Countered', 'PayLife', 'UntapAll', 'TapAll'];
export function triggerMatches(game, p, host, rp, ctx) {
  switch (rp.Mode) {
    case 'ElementalBend': case 'Earthbend': case 'Waterbend': case 'Firebend': case 'Airbend':
    case 'Discover': case 'ManifestDread': case 'Proliferate': case 'PayLife':
      return vc(game, pl(game, rp.Player), p.ValidPlayer, ctx);
    case 'RingTemptsYou': case 'CaseSolved':
      return vc(game, pl(game, rp.Player), p.ValidPlayer, ctx) && vc(game, rp.Card, p.ValidCard, ctx);
    case 'DayTimeChanges': return true;
    case 'Trains': return vc(game, rp.Card, p.ValidCard, ctx);
    case 'Mentored': return vc(game, rp.Card, p.ValidCard, ctx) && vc(game, rp.Source, p.ValidSource, ctx);
    case 'Championed': return vc(game, rp.Championed, p.ValidCard, ctx) && vc(game, rp.Card, p.ValidSource, ctx);
    case 'FightOnce': return !p.ValidCard || (rp.Fighters || []).some(c => c && vc(game, c, p.ValidCard, ctx));
    case 'SacrificedOnce': {
      if (!vc(game, pl(game, rp.Player), p.ValidPlayer, ctx)) return false;
      if (p.ValidCause && !causeOk(game, rp.Cause, p.ValidCause, ctx)) return false;
      const cards = (rp.Cards || []).filter(c => c && vc(game, c, p.ValidCard, ctx));
      if (!cards.length) return false;
      rp.Cards = cards; rp.Amount = cards.length;
      return true;
    }
    case 'TapAll': {
      const cards = (rp.Cards || []).filter(c => c && vc(game, c, p.ValidCards, ctx));
      if (!cards.length) return false;
      rp.Cards = cards; rp.Amount = cards.length;
      return true;
    }
    case 'UntapAll': {
      if (!vc(game, pl(game, rp.Player), p.ValidPlayer, ctx)) return false;
      const cards = (rp.Cards || []).filter(c => c && vc(game, c, p.ValidCards, ctx));
      if (!cards.length) return false;
      rp.Cards = cards; rp.Amount = cards.length;
      return true;
    }
    case 'CounterAddedAll': {
      if (p.CounterType && String(p.CounterType).toUpperCase().replace(/[^A-Z0-9]/g, '') !== rp.CounterType) return false;
      if (p.Valid && !(rp.Objects || []).some(o => o && vc(game, o, p.Valid, ctx))) return false;
      if (p.ValidSource) {
        const who = /^(You|Player|Opponent)/.test(p.ValidSource) ? pl(game, rp.SourcePlayer) : rp.Source;
        if (!vc(game, who, p.ValidSource, ctx)) return false;
      }
      return true;
    }
    case 'Countered':
      return vc(game, rp.Card, p.ValidCard, ctx) && causeOk(game, rp.Cause, p.ValidCause, ctx) && spellOk(game, rp, p.ValidSA, ctx);
    default: return false;
  }
}

// ------------------------------------------------------------------ the effects
async function tapOrUntapAll(game, sa) {
  const p = sa.p;
  const ctx = ctxOf(game, sa);
  const pid = sa.controller;
  let cards = game.battlefield.filter(c => !c.phasedOut && matchValid(game, c, p.ValidCards || 'Permanent', ctx));
  if (hasTgtSpec(sa) || p.Defined) {
    const who = objs(game, sa).filter(o => o && o.isPlayer).map(o => o.id);
    cards = cards.filter(c => who.includes(c.controller));
  }
  const what = p.ValidMessage || 'permanents';
  // the better choice for the one deciding comes first (a computer player takes the first)
  const worth = c => (c.controller === pid ? -1 : 1) * (game.chars(c).types.has('Creature') ? 2 : game.chars(c).types.has('Land') ? 1.5 : 1);
  const tapGain = cards.filter(c => !c.tapped).reduce((a, c) => a + worth(c), 0), untapGain = -cards.filter(c => c.tapped).reduce((a, c) => a + worth(c), 0);
  const opts = [{ label: `Tap all untapped ${what}`, value: 'tap' }, { label: `Untap all tapped ${what}`, value: 'untap' }];
  if (untapGain > tapGain) opts.reverse();
  const choice = await game.ask(pid, { type: 'option', prompt: `${game.name(sa.host)}: tap or untap ${what}?`, options: opts, purpose: 'tapOrUntapAll', sa });
  const done = [];
  for (const c of cards) {
    if (c.zone !== 'battlefield') continue;
    if (choice === 'untap') { if (c.tapped && await game.untap(c)) done.push(c); }
    else if (await game.tap(c, sa)) done.push(c);
  }
  game.log(`${game.players[pid].name} ${choice === 'untap' ? 'untaps' : 'taps'} ${done.length ? done.map(c => game.name(c)).join(', ') : 'nothing'}.`);
  if (choice === 'untap' && done.length) game.fire('UntapAll', { Player: pid, Cards: done, Amount: done.length });
}

async function endure(game, sa) {
  const n = num(game, sa, 'Num', 1);
  if (n < 1) return;
  for (const o of objs(game, sa, 'Self').filter(isCard)) {
    const c = live(game, o);
    const ctrl = o.controller != null ? o.controller : sa.controller;
    let counters = false;
    if (c && !c.lki && c.zone === 'battlefield' && !game.activeStatics('CantPutCounter').some(s => matchValid(game, c, s.p.ValidCard || 'Card', s.ctx))) {
      const pick = await game.ask(c.controller, { type: 'option', prompt: `${game.name(c)} endures ${n}`, options: [{ label: `Put ${plural(n, '+1/+1 counter')} on ${game.name(c)}`, value: 'counters' }, { label: `Create a ${n}/${n} white Spirit creature token`, value: 'token' }], purpose: 'endure', sa, cardId: c.id });
      counters = pick !== 'token';
    }
    if (counters) { game.log(`${game.name(c)} endures ${n}.`); await game.addCounters(c, 'P1P1', n, sa); continue; }
    game.log(`${o.lki ? o.chars.name : game.name(o)} endures ${n}: a ${n}/${n} Spirit.`);
    const tsa = makeSA(game, `DB$ Token | TokenScript$ w_x_x_spirit | TokenPower$ ${n} | TokenToughness$ ${n} | TokenOwner$ You`, {}, sa.host, c && !c.lki ? c.controller : ctrl);
    await runEffect(game, tsa);
  }
}

async function recruit(game, sa) {
  for (const who of objs(game, sa, 'You').filter(o => o && o.isPlayer)) {
    if (who.lost) continue;
    await game.drawCards(who, 1, sa);
    if (!who.hand.length) continue;
    const d = (await askCards(game, who.id, who.hand.slice(), 1, 1, 'Recruit: discard a card (a nonland card makes a 1/1 Human Soldier)', sa, 'discard'))[0];
    if (!d) continue;
    const nonland = !game.chars(d).types.has('Land');
    await game.discard(d, sa);
    if (nonland) await runEffect(game, makeSA(game, 'DB$ Token | TokenScript$ w_1_1_human_soldier | TokenOwner$ You', {}, sa.host, who.id));
  }
}

// detain: until your next turn, it can't attack or block and its activated abilities can't be activated
async function detain(game, sa) {
  const pid = sa.controller;
  const done = [];
  for (const o of objs(game, sa)) {
    const c = live(game, o);
    if (!c || c.lki || !c.isCard || c.zone !== 'battlefield') continue;
    c.mods.push({ id: game.uid++, src: c, svars: { NSDetained: `Mode$ CantAttack,CantBlock,CantBeActivated | ValidCard$ Card.Self | Description$ Detained by ${game.players[pid].name}: it can't attack or block and its activated abilities can't be activated until ${game.players[pid].name}'s next turn.` }, statics: ['NSDetained'], until: 'UntilYourNextTurn', owner: pid, detained: true });
    done.push(c);
  }
  if (done.length) { game.touch(); game.log(`${game.players[pid].name} detains ${done.map(c => game.name(c)).join(', ')}.`); }
}

async function debuff(game, sa) {
  const p = sa.p;
  const kws = p.Keywords ? p.Keywords.split(' & ').map(s => s.trim()).filter(Boolean) : [];
  for (const o of objs(game, sa, 'Self')) {
    const c = live(game, o);
    if (!c || c.lki || !c.isCard || c.zone !== 'battlefield' || c.phasedOut) continue;
    const have = game.chars(c).keywords;
    const lose = [...kws];
    const add = [];
    // "loses all landwalk abilities"
    if (p.AllSuffixKeywords === 'walk') for (const k of have) if (/^Landwalk|walk$/.test(k)) lose.push(k);
    // protection from a color: also the "Protection:Card.Blue:blue" forms; "from each color" splits into the others
    const cols = kws.map(k => (k.match(/^Protection from (white|blue|black|red|green)$/) || [])[1]).filter(Boolean);
    if (cols.length) {
      for (const k of have) if (/^Protection:/.test(k) && cols.some(col => k.includes(`${col[0].toUpperCase()}${col.slice(1)}:${col}`))) lose.push(k);
      if (have.includes('Protection from each color')) { lose.push('Protection from each color'); for (const col of ['white', 'blue', 'black', 'red', 'green']) if (!cols.includes(col)) add.push(`Protection from ${col}`); }
    }
    const rec = { loseKeywords: lose, keywords: add, debuff: true };
    const d = p.Duration;
    rec.until = !d || d === 'EndOfTurn' || d === 'UntilEndOfTurn' ? 'EOT' : d;
    rec.owner = sa.controller;
    c.temp.push(rec);
    game.touch();
    const shown = kws.length ? kws.map(k => k.replace(/^Landwalk:(\w+)$/, (m, t) => `${t.toLowerCase()}walk`).replace(/CARDNAME/g, game.name(c)).toLowerCase()) : ['landwalk'];
    game.log(`${game.name(c)} loses ${shown.join(' and ')}${rec.until === 'EOT' ? ' until end of turn' : rec.until === 'UntilYourNextTurn' ? ` until ${game.players[sa.controller].name}'s next turn` : ''}.`, { type: 'pump' });
  }
}

export const NEWSETS_EFFECTS = {
  async Earthbend(game, sa) { await earthbend(game, sa); },
  async Airbend(game, sa) { await airbend(game, sa); },
  async Debuff(game, sa) { await debuff(game, sa); },
  async Endure(game, sa) { await endure(game, sa); },
  async Recruit(game, sa) { await recruit(game, sa); },
  async Detain(game, sa) { await detain(game, sa); },
  async TapOrUntapAll(game, sa) { await tapOrUntapAll(game, sa); },
  async TaporUntapAll(game, sa) { await tapOrUntapAll(game, sa); },
  // it becomes day / night ("Switch": if it's night, day; otherwise night)
  async DayTime(game, sa) {
    const v = sa.p.Value;
    game.setDayNight(v === 'Switch' ? (game.dayNight === 'Night' ? 'Day' : 'Night') : v === 'Night' ? 'Night' : 'Day');
  },
  async HealDamage(game, sa) {
    for (const o of objs(game, sa, 'Self')) {
      const c = live(game, o);
      if (!c || c.lki || !c.isCard || c.zone !== 'battlefield') continue;
      if (c.damage || c.deathtouchHit) { c.damage = 0; c.deathtouchHit = false; game.touch(); game.log(`Damage on ${game.name(c)} is removed.`); }
    }
  },
  // start your engines: speed goes up (to 4 at most, once a turn when it's the game's doing) or down (not below 1)
  async ChangeSpeed(game, sa) {
    const dec = sa.p.Mode === 'Decrease';
    for (const who of objs(game, sa, 'You').filter(o => o && o.isPlayer)) {
      const s = who.speed || 0;
      const n = dec ? Math.max(Math.min(s, 1), s - 1) : Math.min(4, s + 1);
      if (n === s) continue;
      who.speed = n;
      game.touch();
      game.log(`${who.name}'s speed ${dec ? 'decreases' : 'increases'} to ${n}.`);
    }
  },
  // the Ring tempts you: the Ring gains its next ability, and you choose a Ring-bearer (or keep the one you have)
  async RingTemptsYou(game, sa) {
    const pid = sa.controller;
    const pl0 = game.players[pid];
    pl0.ringTempted = (pl0.ringTempted || 0) + 1;
    updateRing(game, pid);
    const mine = game.battlefield.filter(c => c.controller === pid && !c.phasedOut && game.chars(c).types.has('Creature'));
    const cur = ringBearerOf(game, pid);
    const ordered = cur ? [cur, ...mine.filter(c => c !== cur)] : mine;
    const pick = (await askCards(game, pid, ordered, 1, 1, `The Ring tempts you (${Math.min(4, pl0.ringTempted)}): choose your Ring-bearer`, sa, 'ringBearer'))[0] || null;
    // (the old marker some code still reads)
    for (const c of game.battlefield) if (c.ringBearer && c.controller === pid) { c.ringBearer = false; c.temp = c.temp.filter(t => !t.ring); }
    pl0.ringBearer = pick ? { id: pick.id, zcc: pick.zcc } : null;
    if (pick) pick.ringBearer = true;
    game.touch();
    game.log(`The Ring tempts ${pl0.name}${pick ? `; ${game.name(pick)} is the Ring-bearer` : ''}.`);
    game.fire('RingTemptsYou', { Player: pid, Card: pick });
  },
  // Storied: "you have an enduring story" for the rest of the game
  async EnduringStory(game, sa) {
    const p = game.players[sa.controller];
    if (!p || p.enduringStory) return;
    p.enduringStory = true;
    game.touch();
    game.log(`${p.name} has an enduring story.`);
  },
  // an engine event a keyword's own ability reports: "trains", "mentors" (Event$ Trains | EventCard$ ParentTarget)
  async NewsetsEvent(game, sa) {
    const ev = sa.p.Event;
    const host = sa.host && sa.host.lki ? liveOrLki(game, sa.host) : sa.host;
    if (ev === 'Trains') game.fire('Trains', { Card: host, Player: sa.controller });
    else if (ev === 'Mentored') {
      const t = resolveDefined(game, sa.p.EventCard || 'ParentTarget', ctxOf(game, sa)).find(isCard);
      if (t) game.fire('Mentored', { Card: live(game, t), Source: host, Player: sa.controller });
    }
  },
};

// ------------------------------------------------------------------ day and night
// the side of a card the table shows for the game-wide state (and its tooltip)
export function dayNightLabel(game) {
  if (!game.dayNight) return null;
  return game.dayNight === 'Day'
    ? { text: '☀ Day', title: "It's day. If the active player casts no spells during their turn, it becomes night next turn." }
    : { text: '☾ Night', title: "It's night. If the active player casts two or more spells during their turn, it becomes day next turn." };
}

