// Un-set rules data that the characteristics, filters and triggers code reads (stickers on cards, Attraction lights,
// "a stickered permanent", ...), and that the UI shows. It imports no other engine module, so chars.js, filters.js,
// triggers.js and the UI can use it without import cycles. The effects and the game flow (putting stickers,
// opening and visiting Attractions, nudging dice) are in mech-unsets.js.
import { parseAbility } from './forge.js';

// ---------------------------------------------------------------- the pool's sticker sheets and Attractions
// (fixed lists, so every browser in a room builds the same sheets and Attraction decks whatever else it has loaded)
export const STICKER_SHEETS = ['Ancestral Hot Dog Minotaur', 'Carnival Elephant Meteor', 'Contortionist Otter Storm', 'Cool Fluffy Loxodon', 'Cursed Firebreathing Yogurt', 'Deep-Fried Plague Myr', 'Demonic Tourist Laser', 'Eldrazi Guacamole Tightrope', 'Elemental Time Flamingo', 'Eternal Acrobat Toast', 'Familiar Beeble Mascot', 'Geek Lotus Warrior', 'Giant Mana Cake', 'Goblin Coward Parade', 'Happy Dead Squirrel', 'Jetpack Death Seltzer', 'Misunderstood Trapeze Elf', 'Mystic Doom Sandwich', 'Narrow-Minded Baloney Fireworks', 'Night Brushwagg Ringmaster', 'Notorious Sliver War', 'Phyrexian Midway Bamboozle', 'Playable Delusionary Hydra', 'Primal Elder Kitty', 'Sassy Gremlin Blood', 'Slimy Burrito Illusion', 'Snazzy Aether Homunculus', 'Space Fungus Snickerdoodle', 'Spooky Clown Mox', 'Squid Fire Knight', 'Squishy Sphinx Ninja', 'Sticky Kavu Daredevil', 'Trained Blessed Mind', 'Trendy Circus Pirate', 'Unassuming Gelatinous Serpent', 'Unglued Pea-Brained Dinosaur', 'Unhinged Beast Hunt', 'Unique Charmed Pants', 'Unsanctioned Ancient Juggler', 'Unstable Robot Dragon', "Urza's Dark Cannonball", 'Vampire Champion Fury', 'Weird Angel Flame', 'Werewolf Lightning Mage', 'Wild Ogre Bupkis', 'Wrinkly Monkey Shenanigans', 'Yawgmoth Merfolk Soul', 'Zombie Cheese Magician'];

// An Attraction's lit numbers depend on its printing (Forge's variants; the scripts here don't carry them):
// rolling one of them while you roll to visit your Attractions visits it.
const TWO = ['2 6', '3 6', '4 6', '5 6'], THREE = ['2 3 6', '2 4 6', '2 5 6', '3 4 6', '3 5 6', '4 5 6'];
export const ATTRACTION_LIGHTS = {
  'Balloon Stand': TWO, 'Bounce Chamber': TWO, 'Bumper Cars': THREE, 'Clown Extruder': TWO, 'Concession Stand': TWO, 'Costume Shop': THREE,
  'Drop Tower': THREE, 'Ferris Wheel': ['4 5 6'], 'Foam Weapons Kiosk': TWO, 'Fortune Teller': THREE, 'Hall of Mirrors': ['2 6', '4 6'],
  'Haunted House': ['3 6', '4 6'], 'Information Booth': TWO, 'Kiddie Coaster': THREE, 'Merry-Go-Round': ['2 6', '5 6'], 'Pick-a-Beeble': THREE,
  'Roller Coaster': TWO, 'Spinny Ride': THREE, 'Storybook Ride': ['2 5 6', '3 4 6'], 'Swinging Ship': ['2 6', '4 6'], 'Trash Bin': TWO, 'Tunnel of Love': ['2 6', '3 6'],
};
export const ATTRACTIONS = Object.keys(ATTRACTION_LIGHTS);

export const isSheetDef = def => !!def && def.faces[0].keywords.some(k => k.startsWith('StickerSheet:'));
export const isAttractionDef = def => !!def && def.faces[0].subtypes.includes('Attraction');

// does a card do something with stickers / tickets, or open Attractions? (its abilities, not its name or rules text)
function scriptText(def) {
  if (!def) return '';
  if (def._unsetsText == null) def._unsetsText = def.faces.map(f => [...f.abilities, ...f.triggers, ...f.statics, ...f.replacements, ...f.keywords, ...Object.values(f.svars || {})].join('\n')).join('\n');
  return def._unsetsText;
}
export const usesStickers = def => /PutSticker|CounterType\$ TICKET|stickered|CardStickers|StickerPower|StickerToughness|GainsStickerAbilities/.test(scriptText(def));
export const usesAttractions = def => /OpenAttraction/.test(scriptText(def));

// For the deck-loading step: do these decks need sticker sheets or Attractions whose scripts aren't in db yet?
// (decks: [{ commanders, cards: [[name, n]] }]; db: a CardDB)
export function unsetsMissingExtras(db, decks) {
  let stickers = false, attractions = false;
  for (const d of decks) for (const n of [...(d.commanders || []), ...(d.cards || []).map(([x]) => x)]) {
    const def = db.has(n) ? db.get(n) : null;
    if (!def) continue;
    if (isSheetDef(def) || usesStickers(def)) stickers = true;
    if (isAttractionDef(def) || usesAttractions(def)) attractions = true;
  }
  return (stickers && STICKER_SHEETS.some(n => !db.has(n))) || (attractions && ATTRACTIONS.some(n => !db.has(n)));
}

// ---------------------------------------------------------------- stickers (CR 123)
const VOWELS = 'AEIOUY'; // the Un-cards that count vowels count Y
const sheetCache = new WeakMap();

// the stickers printed on a sheet: [{ slot, kind: 'Name'|'Art'|'Ability'|'PT', tickets, word, text, ability, keywords, triggers, statics, power, toughness }]
export function sheetStickers(def) {
  if (!def) return [];
  let list = sheetCache.get(def);
  if (list) return list;
  list = [];
  const f = def.faces[0];
  for (const k of f.keywords) {
    if (!k.startsWith('StickerSheet:')) continue;
    for (const slot of k.slice(13).split(',').map(s => s.trim())) {
      const raw = f.svars[slot];
      if (!raw) continue;
      const p = {};
      for (const part of raw.split('|')) { const i = part.indexOf('$'); if (i > 0) p[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
      const kind = { name: 'Name', art: 'Art', ability: 'Ability', pt: 'PT' }[String(p.Kind || '').toLowerCase()];
      if (!kind) continue;
      list.push({ slot, kind, tickets: +p.Tickets || 0, word: p.Word || null, text: p.Text || null, ability: p.Ability || null, keywords: p.Keywords || null, triggers: p.Triggers || null, statics: p.Statics || null, power: +p.Power || 0, toughness: +p.Toughness || 0 });
    }
  }
  sheetCache.set(def, list);
  return list;
}

export const stickerLetters = s => String((s && s.word) || '').replace(/[^A-Za-z]/g, '');
export function uniqueVowels(s) { const l = stickerLetters(s).toUpperCase(); return [...VOWELS].filter(v => l.includes(v)).length; }

const KIND_WORD = { Name: 'name', Art: 'art', Ability: 'ability', PT: 'power/toughness' };
export const stickerKindWord = k => KIND_WORD[k] || String(k).toLowerCase();
export function stickerText(s) {
  if (s.kind === 'Name') return `“${s.word}”`;
  if (s.kind === 'PT') return `${s.power}/${s.toughness}`;
  if (s.kind === 'Ability') return s.text || 'an ability';
  return 'art';
}

// CR 123.6a: a name sticker fills the leftmost blank; on a name without blanks it goes where its player chose
const BLANK = /_{2,}/;
export const hasNameBlank = name => BLANK.test(name || '');
export function addStickerWord(name, word, pos = 0) {
  name = name || '';
  const m = BLANK.exec(name);
  if (m) return name.slice(0, m.index) + word + name.slice(m.index + m[0].length);
  const words = name ? name.split(' ') : [];
  words.splice(Math.max(0, Math.min(pos, words.length)), 0, word);
  return words.join(' ');
}

// the sheet's svars hold the abilities its ability stickers grant
function sheetSvars(game, s) { const d = game.db.get(s.sheet); return d ? d.faces[0].svars : {}; }

function grantStickerAbility(game, card, ch, s, prefix = 'stk') {
  if (s.keywords) ch.keywords.push(...s.keywords.split(',').map(x => x.trim()).filter(Boolean));
  const svars = sheetSvars(game, s);
  const add = (names, kind) => {
    if (!names) return;
    for (const n of names.split(',').map(x => x.trim())) {
      const raw = svars[n];
      if (!raw) continue;
      ch[kind].push({ raw, parsed: parseAbility(raw), svars, src: card, key: `${prefix}:${s.sheet}:${s.slot}:${n}` });
    }
  };
  add(s.ability, 'abilities'); add(s.triggers, 'triggers'); add(s.statics, 'statics');
}

// baseChars: a card's stickers, in timestamp order (CR 123.6c, 123.7, 123.8): names, granted abilities, base P/T
export function applyStickers(game, card, ch) {
  const list = [...card.stickers].sort((a, b) => a.ts - b.ts);
  let name = ch.name;
  for (const s of list) {
    if (s.kind === 'Name') name = addStickerWord(name, s.word, s.pos || 0);
    else if (s.kind === 'PT') { ch.powerStr = String(s.power); ch.toughnessStr = String(s.toughness); }
    else if (s.kind === 'Ability') grantStickerAbility(game, card, ch, s);
  }
  ch.name = name;
}

// "has all abilities of ability stickers on ..." (Clandestine Chameleon, Pin Collection): layer 6, from computeAll
// active: [{ st, ctx }] continuous statics; affected(st, ctx) -> cards; matchValid from filters.js
export function gainStickerAbilities(game, active, map, affected, matchValid) {
  for (const { st, ctx } of active) {
    const p = st.parsed.p;
    if (!p.GainsStickerAbilitiesOf && !p.GainsStickerAbilitiesOfDefined) continue;
    let sources;
    if (p.GainsStickerAbilitiesOfDefined) sources = p.GainsStickerAbilitiesOfDefined === 'Self' ? [st.host] : [];
    else {
      const zones = (p.GainsAbilitiesOfZones || 'Battlefield').split(',').map(z => z.trim().toLowerCase());
      sources = [];
      for (const z of zones) for (const c of (z === 'battlefield' ? game.battlefield : game.players.flatMap(pl => pl[z] || []))) if (matchValid(game, c, p.GainsStickerAbilitiesOf, ctx)) sources.push(c);
    }
    const stickers = sources.flatMap(c => (c.stickers || []).filter(s => s.kind === 'Ability').map(s => ({ c, s })));
    if (!stickers.length) continue;
    for (const c of affected(st, ctx)) {
      const ch = map.get(c.id);
      if (!ch) continue;
      for (const { c: from, s } of stickers) grantStickerAbility(game, c, ch, s, `gstk${from.id}`);
    }
  }
}

const stickersOf = card => (card ? (card.lki ? card.stickers || (card.card && card.card.stickers) : card.stickers) : null) || [];

// card properties: "stickered", "stickeredWith Name" (null: not a sticker property)
export function stickerCardProp(card, prop) {
  if (prop === 'stickered') return stickersOf(card).length > 0;
  const m = /^stickeredWith (\w+)$/.exec(prop);
  if (!m) return null;
  const want = { name: 'Name', art: 'Art', ability: 'Ability', pt: 'PT' }[m[1].toLowerCase()];
  return stickersOf(card).some(s => s.kind === want);
}

// Count$ expressions (null when it isn't one of these):
//   CardStickers[.<Kind>|.NameMinLetters.N|.NameMaxLetters.N|.NameLetter.x|.NameStartsWith.x|ChosenType]
//   Valid <filter>$StickerPower / $StickerToughness: the total power / toughness of P/T stickers on those permanents
export function stickerCount(game, rest, ctx, matchValid) {
  if (rest.startsWith('CardStickers')) {
    const host = ctx && ctx.host;
    const list = stickersOf(host);
    const [, kind, arg] = rest.split('.');
    if (!kind) return list.length;
    let n = 0;
    for (const s of list) {
      if (s.kind === 'Name' && arg != null) {
        const letters = stickerLetters(s);
        if (kind === 'NameStartsWith') { const want = arg === 'ChosenType' ? (host.chosen && host.chosen.type) : arg; if (letters && want && letters[0].toUpperCase() === String(want)[0].toUpperCase()) n++; }
        else if (kind === 'NameLetter') { for (const ch of letters) if (ch.toUpperCase() === arg[0].toUpperCase()) n++; }
        else if (kind === 'NameMinLetters') { if (letters.length >= +arg) n++; }
        else if (kind === 'NameMaxLetters') { if (letters.length <= +arg) n++; }
        continue;
      }
      if (s.kind.toLowerCase() === kind.toLowerCase()) n++;
    }
    return n;
  }
  const m = /^Valid (.+)\$Sticker(Power|Toughness)$/.exec(rest);
  if (!m) return null;
  let n = 0;
  for (const c of game.battlefield) if (matchValid(game, c, m[1], ctx)) for (const s of stickersOf(c)) if (s.kind === 'PT') n += m[2] === 'Power' ? s.power : s.toughness;
  return n;
}

// ---------------------------------------------------------------- Attractions (CR 717, 701.51)
export const lightsOf = card => (card && (card.lki ? card.card && card.card.lights : card.lights)) || [];

// "If a card with an Astrotorium card back would be put into a zone other than the battlefield, exile, or the command
// zone from anywhere, instead its owner puts it into the junkyard." (CR 717.6)
export function attractionDestination(game, card, dest) {
  if (!card.attraction || dest === 'battlefield' || dest === 'exile' || dest === 'command' || dest === 'Junkyard' || dest === 'stack' || dest === 'gone') return dest;
  const owner = game.players[card.owner];
  if (!owner.Junkyard) owner.Junkyard = [];
  game.log(`${game.name(card)} is put into its owner's junkyard.`, { cardId: card.id, type: 'move' });
  return 'Junkyard';
}

// PlayerCountPropertyYou$AttractionsVisitedThisTurn (null: not this property)
export function unsetsPlayerProperty(game, p, prop) {
  if (prop !== 'AttractionsVisitedThisTurn') return null;
  const v = p.attractionsVisited;
  return v && v.turn === game.turnNumber ? v.n : 0;
}

// ---------------------------------------------------------------- triggers
export const UNSETS_TRIGGER_MODES = ['StickerPlaced', 'VisitAttraction', 'ClaimPrize'];
// vc(game, obj, valid, ctx) is triggers.js's "no filter or it matches"
export function unsetsTriggerMatches(game, p, rp, ctx, vc) {
  const pl = rp.Player == null ? null : game.players[rp.Player];
  if (p.ValidCard && !vc(game, rp.Card, p.ValidCard, ctx)) return false;
  if (p.ValidPlayer && !vc(game, pl, p.ValidPlayer, ctx)) return false;
  if (rp.Mode === 'StickerPlaced' && p.StickerKind && !p.StickerKind.split(',').some(k => k.trim().toLowerCase() === String(rp.StickerKind).toLowerCase())) return false;
  return true;
}

// ---------------------------------------------------------------- for the table
// what to show on a card: its stickers and an Attraction's lights
export function unsetsCardInfo(game, card) {
  const stickers = (card.stickers || []).map(s => ({ kind: s.kind, text: stickerText(s), sheet: s.sheet }));
  const lights = card.attraction || lightsOf(card).length ? lightsOf(card) : null;
  if (!stickers.length && !lights) return null;
  const lines = [];
  if (lights) lines.push(`Lit: ${lights.join(', ')} (roll one of these to visit it)`);
  if (stickers.length) lines.push(`Stickers: ${stickers.map(s => `${s.text} (${stickerKindWord(s.kind)})`).join(' · ')}`);
  return { stickers, lights, text: lines.join('\n') };
}

// a player's sticker sheets, each sticker marked used or not, and their tickets
export function stickerSheetsView(game, pid) {
  const p = game.players[pid];
  if (!p || !p.stickerSheets || !p.stickerSheets.length) return null;
  const used = usedStickerIds(game, pid);
  return {
    tickets: (p.counters && p.counters.TICKET) || 0,
    sheets: p.stickerSheets.map((sh, i) => ({ name: sh.name, stickers: sheetStickers(game.db.get(sh.name)).map(s => ({ ...s, id: `${i}/${s.slot}`, used: used.has(`${i}/${s.slot}`) })) })),
  };
}

// CR 123.3c: a sticker that's on an object its player owns (in a public zone) can't be put on anything else
export function usedStickerIds(game, pid) {
  const out = new Set();
  for (const c of game.cards.values()) {
    if (c.owner !== pid || !c.stickers || c.zone === 'gone' || c.zone === 'hand' || c.zone === 'library') continue;
    for (const s of c.stickers) out.add(s.sid);
  }
  return out;
}
