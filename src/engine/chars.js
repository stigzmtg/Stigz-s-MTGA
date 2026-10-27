// Characteristic computation ("layers"): base face -> copy -> types -> colors -> abilities -> P/T.
import { abilityList } from './cards.js';
import { parseAbility } from './forge.js';
import { cmc } from './mana.js';
import { BASIC_LAND_TYPES, NAME_TO_COLOR, COLORS } from './util.js';
import { matchValid, resolveDefined, calcCtx, checkPresence, zoneMap } from './filters.js';
import { applyStickers, gainStickerAbilities } from './mech-unsets-rules.js';

const FACE_DOWN = { name: '', manaCost: null, supertypes: [], types: ['Creature'], subtypes: [], colors: [], power: '2', toughness: '2', loyalty: null, keywords: [], abilities: [], triggers: [], statics: [], replacements: [], svars: {}, oracle: '' };

export function baseChars(game, card) {
  const f = card.faceDown ? FACE_DOWN : card.faceDef;
  const ch = {
    name: f.name,
    face: card.face,
    types: new Set(f.types),
    supertypes: new Set(f.supertypes),
    subtypes: new Set(f.subtypes),
    colors: new Set(f.colors),
    manaCost: f.manaCost,
    cmc: cmc(f.manaCost),
    powerStr: f.power,
    toughnessStr: f.toughness,
    power: 0,
    toughness: 0,
    loyalty: f.loyalty,
    keywords: [...f.keywords],
    abilities: abilityList(f.abilities, f.svars, card, `${card.face}A`),
    triggers: abilityList(f.triggers, f.svars, card, `${card.face}T`),
    statics: abilityList(f.statics, f.svars, card, `${card.face}S`),
    replacements: abilityList(f.replacements, f.svars, card, `${card.face}R`),
    svars: f.svars,
    allCreatureTypes: false,
    oracle: f.oracle,
    granted: [],
  };
  // split cards outside the stack have the combined mana value
  if (card.def.isSplit && card.zone !== 'stack' && !card.faceDown) {
    ch.cmc = card.def.faces.reduce((a, x) => a + cmc(x.manaCost), 0);
  }
  if (card.zone === 'battlefield' && card.unlocked && !card.faceDown && !card.copyOf) roomChars(card, ch);
  // impending: not a creature while it has time counters
  if (card.impending && card.zone === 'battlefield' && (card.counters.TIME || 0) > 0) ch.types.delete('Creature');
  if (card.copyOf && card.copyOf.extra) applyCopyExtras(ch, card.copyOf.extra);
  if (card.textSwap && card.zone === 'battlefield' && !card.faceDown) swapTextBox(game, card, ch);
  if (card.textChanges && card.textChanges.length && !card.faceDown) applyTextChanges(ch, card.textChanges);
  if (card.stickers && card.stickers.length) applyStickers(game, card, ch); // Un-sets: name, ability and P/T stickers
  return ch;
}

// exchanged text boxes: abilities, keywords and rules text come from the other creature's printed face
function swapTextBox(game, card, ch) {
  const ts = card.textSwap;
  const o = game.cardById(ts.other);
  const h = ts.host != null ? game.cardById(ts.host) : null;
  if (!o || o.zone !== 'battlefield' || o.zcc !== ts.otherZcc || o.faceDown) return;
  if (ts.host != null && (!h || h.zone !== 'battlefield' || h.zcc !== ts.hostZcc)) return;
  const of = o.faceDef;
  ch.keywords = [...of.keywords];
  ch.abilities = abilityList(of.abilities, of.svars, card, `${card.face}xA`);
  ch.triggers = abilityList(of.triggers, of.svars, card, `${card.face}xT`);
  ch.statics = abilityList(of.statics, of.svars, card, `${card.face}xS`);
  ch.replacements = abilityList(of.replacements, of.svars, card, `${card.face}xR`);
  ch.svars = of.svars;
  ch.oracle = of.oracle;
}

// text-changing effects (New Blood): every instance of a word in the type line and abilities is replaced
function applyTextChanges(ch, changes) {
  const swap = s => changes.reduce((t, { from, to }) => t.replace(new RegExp(`\\b${from}\\b`, 'g'), to), String(s));
  for (const { from, to } of changes) if (ch.subtypes.has(from)) { ch.subtypes.delete(from); ch.subtypes.add(to); }
  const svars = {};
  for (const [k, v] of Object.entries(ch.svars || {})) svars[k] = swap(v);
  const remap = list => list.map(e => {
    const raw = swap(e.raw);
    return { ...e, raw, parsed: raw === e.raw ? e.parsed : parseAbility(raw), svars: e.svars === ch.svars ? svars : e.svars };
  });
  ch.abilities = remap(ch.abilities); ch.triggers = remap(ch.triggers); ch.statics = remap(ch.statics); ch.replacements = remap(ch.replacements);
  ch.keywords = ch.keywords.map(swap);
  ch.svars = svars;
  ch.oracle = swap(ch.oracle || '');
}

// A Room permanent has the characteristics of its unlocked doors; each locked door can be unlocked
// as a sorcery by paying its mana cost.
export function isRoom(def) { return def.altMode === 'Split' && def.faces.length > 1 && def.faces.every(f => f.subtypes.includes('Room')); }
function roomChars(card, ch) {
  const faces = card.def.faces;
  const open = faces.filter((_, i) => card.unlocked.includes(i));
  ch.name = open.map(f => f.name).join(' // ') || faces.map(f => f.name).join(' // ');
  ch.cmc = open.reduce((a, f) => a + cmc(f.manaCost), 0);
  ch.colors = new Set(open.flatMap(f => f.colors));
  ch.svars = Object.assign({}, ...faces.map(f => f.svars).reverse());
  ch.keywords = open.flatMap(f => f.keywords);
  ch.oracle = open.map(f => f.oracle).join('\n');
  for (const [kind, prop] of [['abilities', 'abilities'], ['triggers', 'triggers'], ['statics', 'statics'], ['replacements', 'replacements']]) {
    ch[kind] = [];
    faces.forEach((f, i) => { if (card.unlocked.includes(i)) ch[kind].push(...abilityList(f[prop], f.svars, card, `${i}${kind[0].toUpperCase()}`).map(e => ({ ...e, door: i }))); });
  }
  faces.forEach((f, i) => {
    if (card.unlocked.includes(i) || !f.manaCostStr) return;
    const raw = `AB$ UnlockDoor | Cost$ ${f.manaCostStr} | SorcerySpeed$ True | Static$ True | Door$ ${i} | SpellDescription$ Unlock ${f.name}`;
    ch.abilities.push({ raw, parsed: parseAbility(raw), svars: f.svars, src: card, key: `unlock${i}` });
  });
}

function applyCopyExtras(ch, extra) {
  if (extra.addTypes) for (const t of extra.addTypes) addTypeWord(ch, t);
  if (extra.nonLegendary) ch.supertypes.delete('Legendary');
  if (extra.power != null) ch.powerStr = String(extra.power);
  if (extra.toughness != null) ch.toughnessStr = String(extra.toughness);
  if (extra.keywords) ch.keywords.push(...extra.keywords);
  if (extra.colors) ch.colors = new Set(extra.colors);
  if (extra.addColors) for (const c of extra.addColors) ch.colors.add(c);
  if (extra.name) ch.name = extra.name;
}

const CARD_TYPES = new Set(['Artifact', 'Battle', 'Creature', 'Enchantment', 'Instant', 'Land', 'Planeswalker', 'Sorcery', 'Kindred']);
const SUPER = new Set(['Legendary', 'Basic', 'Snow', 'World']);
function addTypeWord(ch, t) {
  if (t === 'AllCreatureTypes') { ch.allCreatureTypes = true; return; }
  if (CARD_TYPES.has(t)) ch.types.add(t);
  else if (SUPER.has(t)) ch.supertypes.add(t);
  else ch.subtypes.add(t);
}

function parseColors(str) {
  const s = new Set();
  for (const part of String(str).split(/[\s,]+/)) {
    const c = NAME_TO_COLOR[part.toLowerCase()];
    if (c && c !== 'C') s.add(c);
    if (part.toLowerCase() === 'all') COLORS.forEach(x => s.add(x));
  }
  return s;
}

function grantAbilities(ch, names, svars, src, kind, keyPrefix) {
  for (const n of String(names).split(/\s*&\s*|,/).map(x => x.trim()).filter(Boolean)) {
    const raw = svars[n] || n;
    if (!/\$/.test(raw)) continue;
    const entry = { raw, parsed: parseAbility(raw), svars, src, key: `${keyPrefix}:${n}` };
    if (kind === 'A') ch.abilities.push(entry);
    else if (kind === 'T') ch.triggers.push(entry);
    else if (kind === 'S') ch.statics.push(entry);
    else if (kind === 'R') ch.replacements.push(entry);
  }
}

// Apply "mods" (Animate/become effects) and temporary pumps owned by the card.
function applyOwnMods(game, card, ch, layer) {
  for (const m of card.mods) {
    if (layer === 4) {
      if (m.removeCardTypes) for (const t of [...ch.types]) if (!(m.keepTypes || []).includes(t)) ch.types.delete(t);
      if (m.removeCreatureTypes) for (const t of [...ch.subtypes]) if (!game.nonCreatureSubtypes.has(t)) ch.subtypes.delete(t);
      if (m.removeSubTypes) ch.subtypes.clear();
      if (m.removeSuperTypes) ch.supertypes.clear();
      if (m.removeLandTypes) for (const t of [...ch.subtypes]) if (BASIC_LAND_TYPES[t] || ['Desert', 'Gate', 'Locus', 'Lair', 'Urza\'s', 'Mine', 'Tower', 'Power-Plant', 'Cave', 'Sphere'].includes(t)) ch.subtypes.delete(t);
      if (m.types) for (const t of m.types) addTypeWord(ch, t);
      if (m.removeTypes) for (const t of m.removeTypes) { ch.types.delete(t); ch.subtypes.delete(t); ch.supertypes.delete(t); }
    } else if (layer === 5) {
      if (m.colors) ch.colors = new Set(m.colors);
    } else if (layer === 6) {
      if (m.removeAll) { ch.abilities = []; ch.triggers = []; ch.statics = []; ch.replacements = []; ch.keywords = []; }
      if (m.keywords) ch.keywords.push(...m.keywords);
      if (m.removeKeywords) ch.keywords = ch.keywords.filter(k => !m.removeKeywords.some(r => k === r || k.startsWith(r + ':')));
      if (m.abilities) grantAbilities(ch, m.abilities.join(' & '), m.svars || {}, m.src || card, 'A', 'm' + m.id);
      if (m.triggers) grantAbilities(ch, m.triggers.join(' & '), m.svars || {}, m.src || card, 'T', 'm' + m.id);
      if (m.statics) grantAbilities(ch, m.statics.join(' & '), m.svars || {}, m.src || card, 'S', 'm' + m.id);
      if (m.replacements) grantAbilities(ch, m.replacements.join(' & '), m.svars || {}, m.src || card, 'R', 'm' + m.id);
    } else if (layer === 7) {
      if (m.power != null) ch.powerStr = String(m.power);
      if (m.toughness != null) ch.toughnessStr = String(m.toughness);
    }
  }
  if (layer === 6) for (const t of card.temp) if (t.keywords) ch.keywords.push(...t.keywords);
  if (layer === 6) for (const t of card.temp) if (t.removeKeywords) ch.keywords = ch.keywords.filter(k => !t.removeKeywords.includes(k));
}

function addIntrinsicMana(ch, card) {
  if (!ch.types.has('Land')) return;
  for (const [t, c] of Object.entries(BASIC_LAND_TYPES)) {
    if (ch.subtypes.has(t)) {
      const raw = `AB$ Mana | Cost$ T | Produced$ ${c} | SpellDescription$ Add {${c}}.`;
      if (!ch.abilities.some(a => a.raw === raw)) ch.abilities.push({ raw, parsed: parseAbility(raw), svars: {}, src: card, key: `basic${c}` });
    }
  }
}

export function finalizePT(game, card, ch) {
  const ctx = { host: card, you: card.lki ? card.controller : (card.zone === 'battlefield' ? card.controller : card.owner), svars: ch.svars };
  const val = s => {
    if (s == null) return 0;
    if (/^-?\d+$/.test(s)) return +s;
    if (s === '*' || s.includes('*')) return 0;
    return calcCtx(game, s, ctx);
  };
  ch.power = val(ch.powerStr);
  ch.toughness = val(ch.toughnessStr);
}

export const KEYWORD_COUNTERS = { FLYING: 'Flying', FIRSTSTRIKE: 'First Strike', DOUBLESTRIKE: 'Double Strike', DEATHTOUCH: 'Deathtouch', HEXPROOF: 'Hexproof', INDESTRUCTIBLE: 'Indestructible', LIFELINK: 'Lifelink', MENACE: 'Menace', REACH: 'Reach', TRAMPLE: 'Trample', VIGILANCE: 'Vigilance', HASTE: 'Haste', SHADOW: 'Shadow' };

function counterPT(counters) {
  let p = 0, t = 0;
  for (const [k, n] of Object.entries(counters || {})) {
    if (!n) continue;
    const m = k.match(/^([PM])(\d)([PM])(\d)$/);
    if (!m) continue;
    p += (m[1] === 'P' ? 1 : -1) * +m[2] * n;
    t += (m[3] === 'P' ? 1 : -1) * +m[4] * n;
  }
  return [p, t];
}

// Collect continuous statics that are currently in effect.
export function collectStatics(game, baseMap) {
  const out = [];
  const consider = (host, ch, zone) => {
    for (const st of ch.statics) {
      const p = st.parsed.p;
      const ez = p.EffectZone || (host.isEffect ? 'Command' : 'Battlefield');
      if (ez !== 'All' && !ez.split(',').some(z => (zoneMap[z] || z.toLowerCase()) === zone)) continue;
      out.push({ ...st, host, ch });
    }
  };
  for (const c of game.battlefield) { if (c.phasedOut) continue; const ch = baseMap.get(c.id); if (ch) consider(c, ch, 'battlefield'); }
  for (const e of game.effects) consider(e, e.effectChars, 'command');
  for (const p of game.players) {
    for (const z of ['hand', 'graveyard', 'exile', 'command', 'library']) {
      for (const c of p[z]) {
        const f = c.faceDef;
        if (!f.statics.length) continue;
        if (!f.statics.some(s => /EffectZone\$/.test(s))) continue;
        consider(c, { statics: abilityList(f.statics, f.svars, c, `${c.face}S`), svars: f.svars }, z);
      }
    }
  }
  for (const c of game.stack.map(s => s.card).filter(Boolean)) {
    const f = c.faceDef;
    if (f.statics.some(s => /EffectZone\$ (All|Stack)/.test(s))) consider(c, { statics: abilityList(f.statics, f.svars, c, `${c.face}S`), svars: f.svars }, 'stack');
  }
  return out;
}

function staticActive(game, st) {
  const host = st.host;
  const you = host.isEffect ? host.controller : (host.zone === 'battlefield' ? host.controller : host.owner);
  const ctx = { host, you, svars: st.svars, sa: { svars: st.svars, root() { return { x: host.xPaid || 0, paid: {} }; }, host, controller: you } };
  return checkPresence(game, st.parsed.p, ctx) ? ctx : null;
}

function affectedCards(game, st, ctx, chMap) {
  const p = st.parsed.p;
  let list;
  if (p.AffectedDefined) {
    list = resolveDefined(game, p.AffectedDefined, ctx).filter(x => x && !x.isPlayer && !x.lki);
    if (p.Affected) list = list.filter(c => matchValid(game, c, p.Affected, ctx));
    return list;
  }
  if (!p.Affected) return [];
  if (/^(You|Player|Opponent)(\.|$|,)/.test(p.Affected)) return [];
  const zones = (p.AffectedZone || 'Battlefield').split(',').map(z => zoneMap[z] || z.toLowerCase());
  list = [];
  for (const z of zones) {
    const pool = z === 'battlefield' ? game.battlefield : game.cardsInZone(z);
    for (const c of pool) if (matchValid(game, c, p.Affected, ctx)) list.push(c);
  }
  return list;
}

function affectedPlayers(game, st, ctx) {
  const p = st.parsed.p;
  if (!p.Affected || !/^(You|Player|Opponent)/.test(p.Affected)) {
    if (p.AffectedDefined && /^(You|Player|Opponent|Enchanted)/.test(p.AffectedDefined)) return resolveDefined(game, p.AffectedDefined, ctx).filter(x => x && x.isPlayer);
    return [];
  }
  return game.players.filter(pl => !pl.lost && matchValid(game, pl, p.Affected, ctx));
}

// Main entry: compute characteristics for all battlefield / stack cards at once.
export function computeAll(game) {
  const map = new Map();
  const bf = game.battlefield;
  const stackCards = game.stack.map(s => s.card).filter(c => c && c.zone === 'stack');
  const all = [...bf, ...stackCards];
  for (const c of all) map.set(c.id, baseChars(game, c));
  game._charMap = map; // partial results visible to filter matching during computation
  for (const c of all) { const ch = map.get(c.id); applyOwnMods(game, c, ch, 4); addIntrinsicMana(ch, c); }

  const statics = collectStatics(game, map).filter(st => st.parsed.p.Mode === 'Continuous');
  const active = [];
  for (const st of statics) { const ctx = staticActive(game, st); if (ctx) active.push({ st, ctx }); }
  active.sort((a, b) => (a.st.host.timestamp || 0) - (b.st.host.timestamp || 0));

  // layer 4: types
  for (const { st, ctx } of active) {
    const p = st.parsed.p;
    if (!(p.AddType || p.RemoveType || p.RemoveCardTypes || p.RemoveCreatureTypes || p.RemoveSubTypes || p.AddAllCreatureTypes || p.RemoveLandTypes || p.RemoveSuperTypes)) continue;
    for (const c of affectedCards(game, st, ctx, map)) {
      const ch = map.get(c.id) || lazy(game, c);
      if (p.RemoveCardTypes) ch.types.clear();
      if (p.RemoveCreatureTypes) for (const t of [...ch.subtypes]) if (!game.nonCreatureSubtypes.has(t)) ch.subtypes.delete(t);
      if (p.RemoveSubTypes) ch.subtypes.clear();
      if (p.RemoveSuperTypes) ch.supertypes.clear();
      if (p.RemoveLandTypes) for (const t of [...ch.subtypes]) if (BASIC_LAND_TYPES[t]) ch.subtypes.delete(t);
      if (p.RemoveType) for (const t of p.RemoveType.split(' & ')) { ch.types.delete(t); ch.subtypes.delete(t); ch.supertypes.delete(t); }
      if (p.AddType) for (const t of p.AddType.split(' & ')) {
        if (t === 'ChosenType' && st.host.chosen && st.host.chosen.type) addTypeWord(ch, st.host.chosen.type);
        else addTypeWord(ch, t);
      }
      if (p.AddAllCreatureTypes) ch.allCreatureTypes = true;
      if (ch.types.has('Land')) addIntrinsicMana(ch, c);
    }
  }
  // layer 5: colors
  for (const c of all) applyOwnMods(game, c, map.get(c.id), 5);
  for (const { st, ctx } of active) {
    const p = st.parsed.p;
    if (!(p.SetColor || p.AddColor)) continue;
    for (const c of affectedCards(game, st, ctx, map)) {
      const ch = map.get(c.id) || lazy(game, c);
      if (p.SetColor) ch.colors = p.SetColor === 'ChosenColor' && st.host.chosen ? new Set(st.host.chosen.colors || []) : parseColors(p.SetColor);
      if (p.AddColor) for (const x of parseColors(p.AddColor)) ch.colors.add(x);
    }
  }
  // "equipped / enchanted creature is goaded" (Bloodthirsty Blade, Coercive Impetus, Baeloth Barrityl)
  for (const { st, ctx } of active) {
    if (st.parsed.p.Goad !== 'True') continue;
    for (const c of affectedCards(game, st, ctx, map)) { const ch = map.get(c.id) || lazy(game, c); ch.goadedBy = [...(ch.goadedBy || []), ctx.you]; }
  }
  // layer 6: abilities
  for (const c of all) applyOwnMods(game, c, map.get(c.id), 6);
  for (const c of stackCards) if (c.castGrants && c.castGrants.length) map.get(c.id).keywords.push(...c.castGrants);
  for (const { st, ctx } of active) {
    const p = st.parsed.p;
    if (!(p.AddKeyword || p.RemoveKeyword || p.RemoveAllAbilities || p.AddAbility || p.AddTrigger || p.AddStaticAbility || p.AddHiddenKeyword || p.AddReplacementEffects || p.AddSVar || p.GainsAbilitiesOf)) continue;
    const toSpells = /Stack/.test(p.AffectedZone || '') && !/Battlefield/.test(p.AffectedZone || '');
    for (const c of affectedCards(game, st, ctx, map)) {
      const ch = map.get(c.id) || lazy(game, c);
      if (p.RemoveAllAbilities) { ch.abilities = []; ch.triggers = []; ch.statics = []; ch.replacements = []; ch.keywords = []; }
      // a spell that was cast keeps what it was given as it was cast (castGrants, below), not what's true now
      const locked = toSpells && c.zone === 'stack' && c.castGrants;
      if (p.AddKeyword && !locked) for (const k of p.AddKeyword.split(' & ')) ch.keywords.push(k.replace('ChosenColor', (st.host.chosen && st.host.chosen.colors || ['W']).map(x => ({ W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' })[x]).join('')));
      if (p.AddHiddenKeyword) for (const k of p.AddHiddenKeyword.split(' & ')) ch.keywords.push(k);
      if (p.RemoveKeyword) { const rm = p.RemoveKeyword.split(' & '); ch.keywords = ch.keywords.filter(k => !rm.includes(k)); }
      if (p.AddAbility) grantAbilities(ch, p.AddAbility, st.svars, st.host, 'A', 's' + st.host.id + st.key);
      if (p.AddTrigger) grantAbilities(ch, p.AddTrigger, st.svars, st.host, 'T', 's' + st.host.id + st.key);
      if (p.AddStaticAbility) grantAbilities(ch, p.AddStaticAbility, st.svars, st.host, 'S', 's' + st.host.id + st.key);
      if (p.AddReplacementEffects) grantAbilities(ch, p.AddReplacementEffects, st.svars, st.host, 'R', 's' + st.host.id + st.key);
      if (p.AddSVar) for (const n of p.AddSVar.split(' & ')) if (st.svars[n]) ch.svars = { ...ch.svars, [n]: st.svars[n] };
      // "CARDNAME has all activated abilities of all lands on the battlefield"
      if (p.GainsAbilitiesOf) {
        const types = p.GainsAbilitiesOf.split(',').map(x => x.trim());
        for (const x of bf) {
          if (x.id === c.id || x.phasedOut) continue;
          const xch = map.get(x.id);
          if (!xch || !types.some(t => xch.types.has(t))) continue;
          for (const a of xch.abilities) if (!a.gainedFrom && !ch.abilities.some(b => b.raw === a.raw)) ch.abilities.push({ ...a, key: `g${x.id}:${a.key}`, gainedFrom: x.id });
        }
      }
    }
  }
  // Un-sets: "has all abilities of ability stickers on ..." (Clandestine Chameleon, Pin Collection)
  gainStickerAbilities(game, active, map, (st, ctx) => affectedCards(game, st, ctx, map), matchValid);
  // continuous statics granted in layer 6 (AddStaticAbility, granted by other statics) apply from layer 7 on
  const known = new Set(statics.map(st => st.raw + '|' + st.host.id));
  for (const c of bf) {
    if (c.phasedOut) continue;
    for (const st of map.get(c.id).statics) {
      const p = st.parsed.p;
      if (p.Mode !== 'Continuous' || known.has(st.raw + '|' + c.id)) continue;
      const ez = p.EffectZone || 'Battlefield';
      if (ez !== 'All' && !ez.split(',').some(z => (zoneMap[z] || z.toLowerCase()) === 'battlefield')) continue;
      known.add(st.raw + '|' + c.id);
      const entry = { ...st, host: c, ch: map.get(c.id) };
      const ctx = staticActive(game, entry);
      if (ctx) active.push({ st: entry, ctx });
    }
  }
  for (const c of all) {
    const ch = map.get(c.id);
    // keyword counters (flying, first strike, vigilance, ...) grant their keyword
    for (const [k, n] of Object.entries(c.counters || {})) { const kw = KEYWORD_COUNTERS[k]; if (n > 0 && kw && !ch.keywords.includes(kw)) ch.keywords.push(kw); }
    if (c.attachedTo != null && ch.keywords.some(k => k.startsWith('Reconfigure'))) ch.types.delete('Creature');
    if (ch.keywords.includes('Changeling')) ch.allCreatureTypes = true;
    if (ch.keywords.includes('Devoid')) ch.colors = new Set();
  }
  // layer 7a/7b: base & set P/T
  for (const c of all) { const ch = map.get(c.id); applyOwnMods(game, c, ch, 7); }
  for (const { st, ctx } of active) {
    const p = st.parsed.p;
    if (!(p.SetPower || p.SetToughness)) continue;
    if (p.CharacteristicDefining) continue;
    for (const c of affectedCards(game, st, ctx, map)) {
      const ch = map.get(c.id) || lazy(game, c);
      if (p.SetPower) ch.setPower = calcCtx(game, p.SetPower, ctx);
      if (p.SetToughness) ch.setToughness = calcCtx(game, p.SetToughness, ctx);
    }
  }
  for (const c of all) {
    const ch = map.get(c.id);
    finalizePT(game, c, ch);
    // characteristic-defining abilities on the card itself
    for (const st of ch.statics) {
      const p = st.parsed.p;
      if (p.Mode === 'Continuous' && p.CharacteristicDefining) {
        const ctx = { host: c, you: c.controller, svars: st.svars, sa: { svars: st.svars, root() { return { x: c.xPaid || 0, paid: {} }; } } };
        if (p.SetPower) ch.power = calcCtx(game, p.SetPower, ctx);
        if (p.SetToughness) ch.toughness = calcCtx(game, p.SetToughness, ctx);
      }
    }
    if (ch.setPower != null) ch.power = ch.setPower;
    if (ch.setToughness != null) ch.toughness = ch.setToughness;
  }
  // layer 7c: modifications
  for (const { st, ctx } of active) {
    const p = st.parsed.p;
    if (!(p.AddPower || p.AddToughness)) continue;
    const perCard = /^Affected/.test(p.AddPower || '') || /^Affected/.test(p.AddToughness || '');
    const ap = p.AddPower && !perCard ? calcCtx(game, p.AddPower, ctx) : 0;
    const at = p.AddToughness && !perCard ? calcCtx(game, p.AddToughness, ctx) : 0;
    for (const c of affectedCards(game, st, ctx, map)) {
      const ch = map.get(c.id);
      if (!ch) continue;
      if (perCard) {
        const cctx = { ...ctx, host: c, sa: { ...ctx.sa, host: c } };
        if (p.AddPower) ch.power += calcCtx(game, p.AddPower, cctx);
        if (p.AddToughness) ch.toughness += calcCtx(game, p.AddToughness, cctx);
      } else { ch.power += ap; ch.toughness += at; }
    }
  }
  for (const c of all) {
    const ch = map.get(c.id);
    for (const t of c.temp) { if (t.power) ch.power += t.power; if (t.toughness) ch.toughness += t.toughness; }
    const [cp, ct] = counterPT(c.counters);
    ch.power += cp; ch.toughness += ct;
    if (ch.switchPT) [ch.power, ch.toughness] = [ch.toughness, ch.power];
    ch.cmc = c.faceDown ? 0 : ch.cmc;
  }
  // players
  const pchars = game.players.map(() => ({ maxHandSize: 7, extraLands: 0, keywords: [] }));
  for (const { st, ctx } of active) {
    const p = st.parsed.p;
    for (const pl of affectedPlayers(game, st, ctx)) {
      const pc = pchars[pl.id];
      if (p.SetMaxHandSize) pc.maxHandSize = p.SetMaxHandSize === 'Unlimited' ? Infinity : calcCtx(game, p.SetMaxHandSize, ctx);
      if (p.RaiseMaxHandSize) pc.maxHandSize += calcCtx(game, p.RaiseMaxHandSize, ctx);
      if (p.AdjustLandPlays) pc.extraLands += p.AdjustLandPlays === 'Unlimited' ? 99 : calcCtx(game, p.AdjustLandPlays, ctx);
      if (p.AddKeyword) pc.keywords.push(...p.AddKeyword.split(' & '));
    }
  }
  game._playerChars = pchars;
  game._activeStatics = active;
  return map;
}

function lazy(game, c) {
  // cards outside battlefield/stack affected by statics (e.g. AffectedZone$ Hand)
  let ch = game._lazyChars.get(c.id);
  if (!ch) { ch = baseChars(game, c); finalizePT(game, c, ch); game._lazyChars.set(c.id, ch); }
  return ch;
}

export function charsOutside(game, c) {
  let ch = game._lazyChars.get(c.id);
  if (ch) return ch;
  ch = baseChars(game, c);
  if (ch.keywords.includes('Changeling')) ch.allCreatureTypes = true;
  if (ch.keywords.includes('Devoid')) ch.colors = new Set();
  addIntrinsicMana(ch, c);
  for (const t of c.temp || []) if (t.keywords) ch.keywords.push(...t.keywords);
  game._lazyChars.set(c.id, ch); // cache before evaluating expressions (they may reference this card)
  finalizePT(game, c, ch);
  for (const st of ch.statics) {
    const p = st.parsed.p;
    if (p.Mode === 'Continuous' && p.CharacteristicDefining) {
      const ctx = { host: c, you: c.owner, svars: st.svars, sa: { svars: st.svars, root() { return { x: 0, paid: {} }; } } };
      if (p.SetPower) ch.power = calcCtx(game, p.SetPower, ctx);
      if (p.SetToughness) ch.toughness = calcCtx(game, p.SetToughness, ctx);
    }
  }
  game._lazyChars.set(c.id, ch);
  return ch;
}
