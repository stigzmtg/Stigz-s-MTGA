// Unfinity and other Un-set mechanics that are legal in Commander:
//  - stickers (CR 123): each player who plays sticker cards brings three sticker sheets, chosen from the game's seed;
//    {TK} ticket counters pay for ability and power/toughness stickers; name, art, ability and P/T stickers stay on
//    their object in public zones (mech-unsets-rules.js applies them to its characteristics)
//  - Attractions (CR 717, 701.51): an Attraction deck built from the seed for players whose cards open Attractions;
//    "open an Attraction", rolling to visit at the start of the precombat main phase, Visit and Prize abilities, the
//    junkyard
//  - Contraptions: "assemble a Contraption" (no Contraption card is Commander-legal, so there's never a deck to
//    assemble from, but Steamflogger Boss's replacement is understood)
//  - dice you may change after rolling: Monitor Monitor's reroll, Night Shift of the Living Dead's and
//    Xenosquirrels' +1/-1
// Load order: effects.js registers UNSETS_EFFECTS as it loads, so this module imports nothing that imports effects.js:
// abilities.js hands over the few functions of its own used here as it loads (bindAbilities). chars.js, filters.js,
// triggers.js and the UI use mech-unsets-rules.js.
import { RNG } from './util.js';
import { parseMana } from './mana.js';
import { matchValid, resolveDefined, calc, ctxOf, zoneMap } from './filters.js';
import { parseAbility } from './forge.js';
import {
  STICKER_SHEETS, ATTRACTION_LIGHTS, ATTRACTIONS, isSheetDef, isAttractionDef, usesStickers, usesAttractions, sheetStickers,
  usedStickerIds, uniqueVowels, stickerLetters, stickerKindWord, addStickerWord, hasNameBlank, lightsOf,
} from './mech-unsets-rules.js';

export const UNSETS_KEYWORDS = ['StickerSheet', 'Visit', 'Prize'];
export const REROLL_KW = 'Once each turn, you may pay {1} to reroll one or more dice you rolled.';
export const NIGHT_SHIFT_KW = 'After you roll a die, you may pay 1 life. If you do, increase or decrease the result by 1. Do this only once each turn.';
export const XENO_KW = 'After you roll a die, you may remove a +1/+1 counter from Xenosquirrels. If you do, increase or decrease the result by 1.';
export const DICE_KEYWORDS = [REROLL_KW, NIGHT_SHIFT_KW, XENO_KW];

const ATTRACTION_DECK_SIZE = 10, SHEETS_PER_PLAYER = 3;
// abilities.js's SA, rollDice, payManaCost, canAfford, chooseTargetsForSA and resolveChain (it imports this module)
const AB = {};
export function bindAbilities(fns) { Object.assign(AB, fns); }

// ---------------------------------------------------------------- game setup
// A separate generator per player and purpose: the game's own rng (shuffles, dice) is untouched, so adding sheets or
// an Attraction deck never changes how the rest of a game plays out.
function setupRng(game, pid, salt) {
  let s = ((game.seed >>> 0) ^ Math.imul(pid + 1, 0x9E3779B1) ^ salt) >>> 0;
  s = Math.imul(s ^ (s >>> 16), 0x45d9f3b) >>> 0;
  return new RNG(s || 1);
}

// Players whose cards put stickers or open Attractions get sticker sheets / an Attraction deck. Sticker sheets and
// Attractions in a deck list aren't library cards: they're that player's sheets and Attraction deck.
export function setupUnsets(game) {
  for (const p of game.players) {
    const brought = { sheets: [], attractions: [] };
    for (const c of [...p.library]) {
      if (isSheetDef(c.def)) brought.sheets.push(c);
      else if (isAttractionDef(c.def)) brought.attractions.push(c);
      else continue;
      p.library.splice(p.library.indexOf(c), 1);
    }
    for (const c of brought.sheets) { c.zone = 'gone'; game.cards.delete(c.id); }
    const own = [...p.library, ...p.command];
    if (brought.sheets.length || own.some(c => usesStickers(c.def))) ensureStickerSheets(game, p.id, brought.sheets.map(c => c.def.name));
    if (brought.attractions.length || own.some(c => usesAttractions(c.def))) ensureAttractionDeck(game, p.id, brought.attractions);
  }
}

// A player who comes to put a sticker or open an Attraction without having any (a card they took control of, or
// put onto the battlefield some other way) gets them then, chosen the same way.
export function ensureStickerSheets(game, pid, brought = []) {
  const p = game.players[pid];
  if (p.stickerSheets) return;
  const rng = setupRng(game, pid, 0x57C1);
  let names = [...new Set(brought)];
  if (names.length > SHEETS_PER_PLAYER) names = rng.shuffle(names).slice(0, SHEETS_PER_PLAYER);
  const pool = STICKER_SHEETS.filter(n => !names.includes(n) && game.db.has(n));
  while (names.length < SHEETS_PER_PLAYER && pool.length) names.push(pool.splice(rng.int(pool.length), 1)[0]);
  giveStickerSheets(game, pid, names);
}
export function ensureAttractionDeck(game, pid, brought = []) {
  const p = game.players[pid];
  if (p.AttractionDeck) return;
  const rng = setupRng(game, pid, 0xA77A);
  const have = new Set(brought.map(c => c.def.name));
  const pool = ATTRACTIONS.filter(n => !have.has(n) && game.db.has(n));
  const extra = [];
  while (have.size + extra.length < ATTRACTION_DECK_SIZE && pool.length) extra.push(pool.splice(rng.int(pool.length), 1)[0]);
  const lit = name => { const v = ATTRACTION_LIGHTS[name] || ['6']; return v[rng.int(v.length)]; };
  giveAttractionDeck(game, pid, [...brought.map(c => [c, lit(c.def.name)]), ...extra.map(n => [n, lit(n)])], { rng });
}

// (tests and setup) the player's sticker sheets, by name
export function giveStickerSheets(game, pid, names) {
  const p = game.players[pid];
  p.stickerSheets = names.filter(n => game.db.get(n)).map(name => ({ name }));
  p.counters.TICKET = p.counters.TICKET || 0;
  if (p.stickerSheets.length) game.log(`${p.name}'s sticker sheets: ${p.stickerSheets.map(s => s.name).join(', ')}.`, { type: 'info' });
  game.touch();
}

// (tests and setup) the player's Attraction deck: [name | Card, "2 6"] (lit numbers), first entry on top unless shuffled
export function giveAttractionDeck(game, pid, entries, { rng = null } = {}) {
  const p = game.players[pid];
  p.AttractionDeck = p.AttractionDeck || [];
  p.Junkyard = p.Junkyard || [];
  for (const [what, lights] of entries) {
    let c = what;
    if (typeof what === 'string') { const def = game.db.get(what); if (!def) continue; c = game.newCard(def, pid); }
    c.zone = 'AttractionDeck';
    c.attraction = true;
    c.lights = String(lights || (ATTRACTION_LIGHTS[c.def.name] || ['6'])[0]).split(/\s+/).map(Number);
    p.AttractionDeck.push(c);
  }
  if (rng) rng.shuffle(p.AttractionDeck);
  game.touch();
}

// ---------------------------------------------------------------- stickers
// the stickers this player can put on something now: [{ sid, sheet, slot, kind, tickets, ... }]
export function availableStickers(game, pid, { kind = null, maxTickets = Infinity, noTicketCost = false } = {}) {
  const p = game.players[pid];
  if (!p || !p.stickerSheets || !p.stickerSheets.length) return [];
  const used = usedStickerIds(game, pid);
  const budget = noTicketCost ? maxTickets : Math.min(maxTickets, (p.counters && p.counters.TICKET) || 0);
  const out = [];
  p.stickerSheets.forEach((sh, i) => {
    for (const s of sheetStickers(game.db.get(sh.name))) {
      const sid = `${i}/${s.slot}`;
      if (used.has(sid) || s.tickets > budget) continue;
      if (kind && s.kind.toLowerCase() !== String(kind).toLowerCase()) continue;
      out.push({ ...s, sid, sheet: sh.name });
    }
  });
  return out;
}

// the values a sub-ability reads after a sticker goes on ("the number of unique vowels on that sticker", "when you do"):
// on the host for Count$ expressions and on the rest of the chain for ImmediateTrigger's RememberSVarAmount
function setStickerSVars(sa, placed, vowels) {
  const h = sa.host;
  if (h && h.isCard) {
    if (!h.storedSVars || h.storedSVars.zcc !== h.zcc) h.storedSVars = { zcc: h.zcc, v: {} };
    h.storedSVars.v.StickersPlaced = String(placed);
    h.storedSVars.v.StickerUniqueVowels = String(vowels);
  }
  for (let s = sa.sub; s; s = s.sub) s.svars = { ...s.svars, StickersPlaced: `Number$${placed}`, StickerUniqueVowels: `Number$${vowels}` };
}

function stickerOption(game, s, card) {
  const tk = s.tickets ? `, ${s.tickets} ticket${s.tickets > 1 ? 's' : ''}` : '';
  let label;
  if (s.kind === 'Name') label = `Name sticker “${s.word}”${hasNameBlank(game.name(card)) ? ` → ${addStickerWord(game.name(card), s.word)}` : ''} (${s.sheet})`;
  else if (s.kind === 'Art') label = 'Art sticker';
  else if (s.kind === 'PT') label = `Power/toughness sticker${tk}: ${s.power}/${s.toughness}`;
  else label = `Ability sticker${tk}: ${s.text}`;
  return { label, value: s.sid, sticker: { kind: s.kind, word: s.word, power: s.power, toughness: s.toughness, keywords: s.keywords, tickets: s.tickets, text: s.text, hasAbility: !!(s.ability || s.triggers || s.statics) } };
}

async function putSticker(game, sa, card, opts, optional) {
  const pid = sa.controller, me = game.players[pid];
  const avail = availableStickers(game, pid, opts);
  if (!avail.length) return null;
  // (art stickers are all alike: offer one)
  const firstArt = avail.find(s => s.kind === 'Art');
  const options = avail.filter(s => s.kind !== 'Art' || s === firstArt).map(s => stickerOption(game, s, card));
  if (optional) options.push({ label: 'Don’t put a sticker', value: 'none' });
  const tickets = (me.counters && me.counters.TICKET) || 0;
  const v = await game.ask(pid, { type: 'option', prompt: `Put a sticker on ${game.name(card)} (you have ${tickets} ticket${tickets === 1 ? '' : 's'})`, options, sa, purpose: 'sticker', cardId: card.id, cards: [card.id] });
  const s = avail.find(x => x.sid === v);
  if (!s) return null;
  if (s.tickets && opts.noTicketCost !== true) { me.counters.TICKET = Math.max(0, (me.counters.TICKET || 0) - s.tickets); }
  let pos = 0;
  if (s.kind === 'Name' && !hasNameBlank(game.name(card))) {
    const cur = game.name(card);
    const n = cur ? cur.split(' ').length : 0;
    if (n > 0) {
      const choices = Array.from({ length: n + 1 }, (_, i) => ({ label: addStickerWord(cur, s.word, i), value: i }));
      pos = await game.ask(pid, { type: 'option', prompt: `Where does “${s.word}” go in ${cur}'s name?`, options: choices, sa, purpose: 'stickerNamePosition', cardId: card.id });
      pos = +pos || 0;
    }
  }
  const before = game.name(card);
  card.stickers = [...(card.stickers || []), { sid: s.sid, sheet: s.sheet, slot: s.slot, kind: s.kind, word: s.word, text: s.text, power: s.power, toughness: s.toughness, keywords: s.keywords, ability: s.ability, triggers: s.triggers, statics: s.statics, tickets: s.tickets, ts: game.uid++, pos, owner: pid }];
  game.touch();
  const what = s.kind === 'Name' ? `the name sticker “${s.word}”` : s.kind === 'Art' ? 'an art sticker' : s.kind === 'PT' ? `a ${s.power}/${s.toughness} sticker` : `an ability sticker (“${s.text}”)`;
  game.log(`${me.name} puts ${what} on ${before}${s.kind === 'Name' ? ` (now ${game.name(card)})` : ''}${s.tickets && opts.noTicketCost !== true ? ` for ${s.tickets} ticket${s.tickets > 1 ? 's' : ''}` : ''}.`, { cardId: card.id });
  game.fire('StickerPlaced', { Card: card, Player: pid, StickerKind: s.kind });
  return s;
}

// ---------------------------------------------------------------- Attractions
export const isAttraction = (game, c) => !!c && game.chars(c).subtypes.has('Attraction');

// open the top card of a player's Attraction deck: it goes onto the battlefield
async function openAttraction(game, pid, sa) {
  const pl = game.players[pid];
  ensureAttractionDeck(game, pid);
  const deck = pl.AttractionDeck || [];
  if (!deck.length) { game.log(`${pl.name} has no Attraction to open.`); return null; }
  const c = deck[0];
  const moved = await game.moveCard(c, 'battlefield', { controller: pid, cause: sa, silent: true });
  if (moved && moved.zone === 'battlefield') game.log(`${pl.name} opens ${game.name(moved)} (lit: ${lightsOf(moved).join(', ')}).`, { cardId: moved.id, type: 'resolve' });
  return moved;
}

// Visit each Attraction the player controls with a light of that number (CR 701.51b).
export async function visitAttractions(game, pid, result) {
  const pl = game.players[pid];
  const list = game.battlefield.filter(c => c.controller === pid && !c.phasedOut && isAttraction(game, c) && lightsOf(c).includes(result));
  if (!list.length) return;
  for (const c of list) {
    if (c.visitedTurn !== game.turnNumber) {
      const v = pl.attractionsVisited && pl.attractionsVisited.turn === game.turnNumber ? pl.attractionsVisited : { turn: game.turnNumber, n: 0 };
      v.n++;
      pl.attractionsVisited = v;
    }
    c.visitedTurn = game.turnNumber;
    game.log(`${pl.name} visits ${game.name(c)}.`, { cardId: c.id });
    // its Visit ability triggers
    const ch = game.chars(c);
    for (const k of ch.keywords) {
      const m = /^Visit:(\w+)/.exec(k);
      if (!m || !ch.svars[m[1]]) continue;
      const d = parseAbility(ch.svars[m[1]]).p.SpellDescription || '';
      game.pendingTriggers.push({ host: c, t: { parsed: { p: { Execute: m[1], TriggerDescription: `Visit — ${d.replace(/^Visit — /, '')}` } }, svars: ch.svars, key: `visit:${m[1]}` }, rp: { Card: c, Player: pid }, controller: c.controller });
    }
    game.fire('VisitAttraction', { Card: c, Player: pid });
  }
  game.touch();
}

// CR 505.4: at the beginning of the precombat main phase, the active player rolls to visit their Attractions
// if they control one (a turn-based action).
export async function rollToVisitAtMain(game, pid) {
  if (!game.battlefield.some(c => c.controller === pid && !c.phasedOut && isAttraction(game, c))) return;
  const { rollDice } = AB;
  await rollDice(game, pid, 1, 6, 0, null, { toVisit: true });
}

// rollDice (abilities.js) calls this once the dice are rolled (the "ignore the lowest" ones already set aside):
// Monitor Monitor rerolls first, then Night Shift of the Living Dead / Xenosquirrels may change each result by 1.
// Changes rolls in place. toVisit: rolling to visit Attractions (the AI aims for lit numbers).
export async function adjustDiceRolls(game, pid, rolls, sides, sa, toVisit) {
  if (!rolls.length) return;
  const pl = game.players[pid];
  const mine = game.battlefield.filter(c => c.controller === pid && !c.phasedOut && c.zone === 'battlefield');
  if (!mine.length) return;
  const has = (c, kw) => game.chars(c).keywords.includes(kw);
  const usedThisTurn = c => (c.unsetsUse && c.unsetsUse.turn === game.turnNumber && c.unsetsUse.zcc === c.zcc ? c.unsetsUse.n : 0);
  const markUsed = c => { c.unsetsUse = { turn: game.turnNumber, zcc: c.zcc, n: usedThisTurn(c) + 1 }; };
  const lit = toVisit ? [...new Set(game.battlefield.filter(c => c.controller === pid && isAttraction(game, c)).flatMap(lightsOf))] : [];
  const one = parseMana('1');
  const rerollers = mine.filter(x => has(x, REROLL_KW));
  const { payManaCost, canAfford } = AB;
  for (const c of rerollers) {
    if (usedThisTurn(c) >= 1 || !canAfford(game, pid, one)) continue;
    let pick;
    if (rolls.length === 1) pick = (await game.ask(pid, { type: 'confirm', prompt: `You rolled ${rolls[0]}. Pay {1} (${game.name(c)}) to reroll it?`, purpose: 'dieReroll', cards: [c.id], rolls: rolls.slice(), sides, toVisit, lit })) ? [0] : [];
    else pick = await game.ask(pid, { type: 'modes', prompt: `You rolled ${rolls.join(', ')}. Pay {1} (${game.name(c)}) to reroll which dice?`, options: rolls.map((r, i) => ({ label: `Die ${i + 1}: ${r}`, value: i })), min: 0, max: rolls.length, purpose: 'dieReroll', rolls: rolls.slice(), sides, toVisit, lit });
    pick = (pick || []).filter(i => i >= 0 && i < rolls.length);
    if (!pick.length) continue;
    if (!(await payManaCost(game, pid, one, { abilityHost: c }))) continue;
    markUsed(c);
    for (const i of pick) rolls[i] = 1 + game.rng.int(sides);
    game.log(`${pl.name} pays {1} to reroll (${game.name(c)}): ${rolls.join(', ')}.`, { cardId: c.id });
  }
  for (let i = 0; i < rolls.length; i++) {
    for (const c of mine) {
      if (c.zone !== 'battlefield') continue;
      const night = has(c, NIGHT_SHIFT_KW), xeno = !night && has(c, XENO_KW);
      if (!night && !xeno) continue;
      if (night && (usedThisTurn(c) >= 1 || pl.life < 1)) continue;
      if (xeno && !((c.counters.P1P1 || 0) > 0)) continue;
      const r = rolls[i];
      const cost = night ? 'Pay 1 life' : `Remove a +1/+1 counter from ${game.name(c)}`;
      const v = await game.ask(pid, { type: 'option', prompt: `You rolled ${r}${rolls.length > 1 ? ` (die ${i + 1})` : ''}. ${game.name(c)}: ${cost.toLowerCase()} to change it by 1?`, options: [{ label: `Keep ${r}`, value: 0 }, { label: `${cost}: make it ${r + 1}`, value: 1 }, { label: `${cost}: make it ${r - 1}`, value: -1 }], purpose: 'dieModify', cards: [c.id], roll: r, sides, toVisit, lit, cost: night ? 'life' : 'counter' });
      if (v !== 1 && v !== -1) continue;
      if (night) { pl.life -= 1; pl.lifeLostThisTurn += 1; game.touch(); game.fire('LifeLost', { Player: pid, LifeAmount: 1 }); }
      else if (!(await game.removeCounters(c, 'P1P1', 1))) continue;
      markUsed(c);
      rolls[i] = r + v;
      game.log(`${pl.name} ${night ? 'pays 1 life' : `removes a +1/+1 counter from ${game.name(c)}`}: the ${r} becomes ${rolls[i]}.`, { cardId: c.id });
    }
  }
}

// ---------------------------------------------------------------- effects (registered in effects.js)
const Z = z => (z ? (zoneMap[z] || z.toLowerCase()) : z);

export const UNSETS_EFFECTS = {
  // "you may put a [name / art / ...] sticker on a nonland permanent you own" (CR 123.3)
  async PutSticker(game, sa) {
    const p = sa.p, pid = sa.controller, me = game.players[pid];
    const ctx = ctxOf(game, sa);
    const optional = p.Optional === 'True';
    const opts = { kind: p.Kind || null, noTicketCost: p.NoTicketCost === 'True', maxTickets: p.MaxTickets ? calc(game, p.MaxTickets, sa) : Infinity };
    setStickerSVars(sa, 0, 0);
    ensureStickerSheets(game, pid);
    if (!availableStickers(game, pid, opts).length) { game.log(`${me.name} has no ${opts.kind ? stickerKindWord(opts.kind) + ' ' : ''}sticker to put on anything${opts.noTicketCost ? '' : ` (${me.counters.TICKET || 0} ticket${me.counters.TICKET === 1 ? '' : 's'})`}.`); return; }
    let objects;
    if (p.Choices) {
      const zone = Z(p.ChoiceZone || 'Battlefield');
      // CR 123.3b: only on objects you own
      const pool = (zone === 'battlefield' ? game.battlefield : (me[zone] || [])).filter(c => c.owner === pid && !c.phasedOut && matchValid(game, c, p.Choices, ctx));
      if (!pool.length) return;
      const ids = await game.ask(pid, { type: 'cards', prompt: p.ChoiceTitle || 'Choose a permanent to put a sticker on', cards: pool.map(c => c.id), min: optional ? 0 : 1, max: 1, sa, purpose: 'stickerObject', stickerKind: opts.kind });
      objects = (ids || []).map(id => game.cardById(id)).filter(c => c && pool.includes(c));
    } else {
      objects = resolveDefined(game, p.Defined || 'Self', ctx).filter(o => o && o.isCard && !o.lki);
      // (the same object it was: a card that left and came back is a new one)
      if (sa.hostZcc != null) objects = objects.filter(c => c !== sa.host || c.zcc === sa.hostZcc);
    }
    let placed = 0, vowels = 0;
    for (const c of objects) {
      if (c.owner !== pid || ['gone', 'hand', 'library', 'AttractionDeck'].includes(c.zone)) continue;
      const s = await putSticker(game, sa, c, opts, optional);
      if (!s) continue;
      placed++;
      if (s.kind === 'Name') vowels = uniqueVowels(s);
    }
    setStickerSVars(sa, placed, vowels);
  },

  // "open an Attraction" (CR 701.51a): the top card of your Attraction deck onto the battlefield
  async OpenAttraction(game, sa) {
    const ctx = ctxOf(game, sa);
    const players = sa.p.Defined ? resolveDefined(game, sa.p.Defined, ctx).filter(o => o && o.isPlayer) : [game.players[sa.controller]];
    const n = sa.p.Amount ? calc(game, sa.p.Amount, sa) : 1;
    for (const pl of players) {
      if (pl.lost) continue;
      for (let i = 0; i < n; i++) {
        const c = await openAttraction(game, pl.id, sa);
        if (!c) break;
        if (sa.p.Remember === 'True' && sa.host) (sa.host.remembered = sa.host.remembered || []).push(c);
      }
    }
  },

  // "claim the prize!" (CR 701.52): the Attraction's Prize ability happens, then "whenever you claim the prize" triggers
  async ClaimThePrize(game, sa) {
    const ctx = ctxOf(game, sa);
    const cards = resolveDefined(game, sa.p.Defined || 'Self', ctx).filter(o => o && o.isCard && !o.lki);
    const { SA, chooseTargetsForSA, resolveChain } = AB;
    for (const c of cards) {
      game.log(`${game.players[sa.controller].name} claims the prize of ${game.name(c)}!`, { cardId: c.id });
      const ch = game.chars(c);
      for (const k of ch.keywords) {
        const m = /^Prize:(\w+)/.exec(k);
        const raw = m && ch.svars[m[1]];
        if (!raw) continue;
        const prize = new SA(game, { raw, parsed: parseAbility(raw), svars: ch.svars, src: c, key: `prize:${m[1]}` }, c, sa.controller, { trig: { Card: c, Player: sa.controller } });
        if (await chooseTargetsForSA(game, prize, { optional: true })) await resolveChain(game, prize);
      }
      game.fire('ClaimPrize', { Card: c, Player: sa.controller });
    }
  },

  // "assemble a Contraption": the top card of the Contraption deck onto the battlefield. No Commander-legal card is a
  // Contraption, so no player has a Contraption deck.
  async AssembleContraption(game, sa) {
    const pl = game.players[sa.controller];
    const n = sa.p.Amount ? calc(game, sa.p.Amount, sa) : 1;
    for (let i = 0; i < n; i++) {
      const deck = pl.ContraptionDeck || [];
      if (!deck.length) { game.log(`${pl.name} has no Contraption to assemble.`); return; }
      await game.moveCard(deck[0], 'battlefield', { controller: pl.id, cause: sa });
    }
  },
};

// ---------------------------------------------------------------- AI (ai.js asks here first; undefined: not ours)
const KW_VALUE = { Flying: 3, 'Double Strike': 4, Indestructible: 3, Hexproof: 2, Deathtouch: 2, Lifelink: 2, Trample: 1.5, Menace: 1.5, 'First Strike': 1.5, Vigilance: 1, Haste: 1, Reach: 0.5, Infect: 2, Shadow: 2, Skulk: 1, Undying: 2, Persist: 2, Ward: 1.5, Prowess: 1 };
function stickerScore(ai, game, pid, card, o) {
  const s = o.sticker;
  if (!s) return 0;
  const ch = game.chars(card);
  const creature = ch.types.has('Creature') && card.zone === 'battlefield';
  const text = card.def.faces.map(f => Object.values(f.svars || {}).join('\n')).join('\n');
  if (s.kind === 'PT') return creature ? (s.power + s.toughness) - (Math.max(0, ch.power) + Math.max(0, ch.toughness)) - s.tickets * 0.1 : 0.05;
  if (s.kind === 'Ability') {
    let v = 0;
    for (const k of String(s.keywords || '').split(',').map(x => x.trim().split(':')[0]).filter(Boolean)) v += KW_VALUE[k] != null ? KW_VALUE[k] : 1;
    if (s.hasAbility) v += 1.5;
    return (creature ? v : v * 0.3) - s.tickets * 0.1;
  }
  if (s.kind === 'Name') {
    const letters = stickerLetters(s);
    let v = 0.5 + uniqueVowels(s) * 0.1;
    if (/StickerUniqueVowels/.test(text) || (o.vowelsMatter)) v += uniqueVowels(s) * 2;
    let m;
    if ((m = /NameLetter\.(\w)/.exec(text))) v += [...letters.toUpperCase()].filter(x => x === m[1].toUpperCase()).length * 2;
    if ((m = /NameMinLetters\.(\d+)/.exec(text))) v += letters.length >= +m[1] ? 3 : 0;
    if ((m = /NameMaxLetters\.(\d+)/.exec(text))) v += letters.length <= +m[1] ? 3 : 0;
    return v;
  }
  return 0.3; // art
}

export function unsetsAI(ai, game, pid, req) {
  switch (req.purpose) {
    case 'sticker': {
      const card = game.cardById(req.cardId);
      const sa = req.sa;
      const vowelsMatter = !!(sa && sa.chain && sa.chain().some(s => /StickerUniqueVowels/.test(JSON.stringify(s.p))));
      let best = null, bs = -Infinity;
      for (const o of req.options) {
        const v = o.value === 'none' ? 0 : card ? stickerScore(ai, game, pid, card, { ...o, vowelsMatter }) : 0.1;
        if (v > bs) { bs = v; best = o.value; }
      }
      return best;
    }
    case 'stickerObject': {
      const cards = (req.cards || []).map(id => game.cardById(id)).filter(Boolean);
      if (!cards.length) return [];
      const kind = req.stickerKind;
      const score = c => (game.chars(c).types.has('Creature') ? 5 : 0) + (c.controller === pid ? 2 : -10) + (c.zone === 'battlefield' ? ai.value(c) * 0.3 : 0) + (kind === 'PT' && game.chars(c).types.has('Creature') ? -Math.max(0, game.chars(c).power) * 0.2 : 0);
      const best = cards.slice().sort((a, b) => score(b) - score(a))[0];
      return req.min === 0 && score(best) < 0 ? [] : [best.id];
    }
    case 'stickerNamePosition': return req.options[0].value;
    case 'dieReroll': {
      if (!req.toVisit) return req.type === 'confirm' ? false : [];
      const lit = req.lit || [];
      if (req.type === 'confirm') return !lit.includes(req.rolls[0]) && lit.length > 0;
      return req.rolls.map((r, i) => (lit.includes(r) ? -1 : i)).filter(i => i >= 0);
    }
    case 'dieModify': {
      const r = req.roll;
      const pl = game.players[pid];
      if (req.cost === 'life' && pl.life <= 10) return 0;
      if (req.cost === 'counter') { const c = game.cardById(req.cards && req.cards[0]); if (!c || (c.counters.P1P1 || 0) <= 1) return 0; }
      if (req.toVisit) {
        const lit = req.lit || [];
        if (lit.includes(r)) return 0;
        if (lit.includes(r + 1)) return 1;
        if (lit.includes(r - 1)) return -1;
        return 0;
      }
      // Night Shift of the Living Dead: a 6 makes a Zombie
      if (req.cost === 'life' && r === req.sides - 1 && game.battlefield.some(c => c.controller === pid && /ValidResult\$ (EQ)?6/.test(game.chars(c).triggers.map(t => t.raw).join('\n')))) return 1;
      return 0;
    }
    case 'chooseType': {
      if (req.kind !== 'Letter') return undefined;
      const host = req.sa && req.sa.host;
      const counts = {};
      for (const s of (host && host.stickers) || []) if (s.kind === 'Name') { const l = stickerLetters(s)[0]; if (l) counts[l.toUpperCase()] = (counts[l.toUpperCase()] || 0) + 1; }
      const best = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
      return best && req.options.some(o => o.value === best) ? best : req.options[0].value;
    }
    default: return undefined;
  }
}
