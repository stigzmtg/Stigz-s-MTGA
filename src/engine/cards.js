// Card definitions built from Forge scripts, and the runtime Card / Player objects.
import { parseCardScript, parseAbility } from './forge.js';
import { parseMana, cmc, costColors } from './mana.js';
import { CARD_TYPES, SUPERTYPES, NAME_TO_COLOR, COLORS } from './util.js';

const TYPE_SET = new Set(CARD_TYPES);
const SUPER_SET = new Set(SUPERTYPES);

export function parseTypeLine(line) {
  const supertypes = [], types = [], subtypes = [];
  for (const t of (line || '').split(/\s+/).filter(Boolean)) {
    if (SUPER_SET.has(t)) supertypes.push(t);
    else if (TYPE_SET.has(t)) types.push(t === 'Tribal' ? 'Kindred' : t);
    else subtypes.push(t);
  }
  return { supertypes, types, subtypes };
}

export class FaceDef {
  constructor(raw, idx) {
    this.idx = idx;
    this.name = raw.name;
    this.manaCostStr = raw.manaCost;
    this.manaCost = raw.manaCost ? parseMana(raw.manaCost) : null;
    this.typeLine = raw.types;
    Object.assign(this, parseTypeLine(raw.types));
    if (raw.colors) {
      this.colors = raw.colors.split(',').map(c => NAME_TO_COLOR[c.trim()]).filter(c => c && c !== 'C');
      if (raw.colors.includes('multicolor')) this.colors = [];
    } else {
      this.colors = [...costColors(this.manaCost)];
    }
    if (raw.pt) {
      const [p, t] = raw.pt.split('/');
      this.power = p; this.toughness = t;
    } else { this.power = null; this.toughness = null; }
    this.loyalty = raw.loyalty;
    this.defense = raw.defense;
    this.keywords = raw.K;
    this.abilities = raw.A;
    this.triggers = raw.T;
    this.statics = raw.S;
    this.replacements = raw.R;
    this.svars = raw.svars;
    this.oracle = raw.oracle || raw.text || '';
  }
  get cmc() { return cmc(this.manaCost); }
}

export class CardDef {
  constructor(script, { token = false, scriptName = null } = {}) {
    const parsed = parseCardScript(script);
    this.faces = parsed.faces.map((f, i) => new FaceDef(f, i));
    this.altMode = parsed.altMode;
    this.name = (['Split', 'Modal', 'Adventure', 'Omen', 'Prepare'].includes(this.altMode) && this.faces.length > 1)
      ? this.faces.map(f => f.name).join(' // ') : this.faces[0].name;
    this.token = token;
    this.scriptName = scriptName;
  }
  get front() { return this.faces[0]; }
  get isDFC() { return this.altMode === 'DoubleFaced' || this.altMode === 'Modal' || this.altMode === 'Meld'; }
  get isSplit() { return this.altMode === 'Split'; }

  // Color identity per Commander rules: mana symbols in costs and rules text, color indicators, both faces.
  colorIdentity() {
    const ci = new Set();
    for (const f of this.faces) {
      for (const c of f.colors) ci.add(c);
      for (const c of costColors(f.manaCost)) ci.add(c);
      const text = (f.oracle || '').replace(/\([^)]*\)/g, '');
      for (const m of text.matchAll(/\{([^}]+)\}/g)) for (const ch of m[1].split('/')) if (COLORS.includes(ch)) ci.add(ch);
      // basic land types imply mana abilities
      for (const [t, c] of Object.entries({ Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' })) if (f.subtypes.includes(t) && f.types.includes('Land')) ci.add(c);
    }
    return COLORS.filter(c => ci.has(c));
  }
}

export class CardDB {
  constructor(cards, tokens) {
    this.raw = cards;
    this.rawTokens = tokens;
    this.cache = new Map();
    this.tokenCache = new Map();
    this.lower = null;
  }
  get(name) {
    let d = this.cache.get(name);
    if (d) return d;
    let script = this.raw[name];
    if (!script) {
      if (!this.lower) { this.lower = new Map(); for (const k of Object.keys(this.raw)) this.lower.set(k.toLowerCase(), k); }
      const k = this.lower.get(String(name).toLowerCase());
      if (k) script = this.raw[k];
    }
    if (!script) return null;
    d = new CardDef(script);
    this.cache.set(name, d);
    return d;
  }
  token(scriptName) {
    let d = this.tokenCache.get(scriptName);
    if (d) return d;
    const script = this.rawTokens[scriptName];
    if (!script) return null;
    d = new CardDef(script, { token: true, scriptName });
    this.tokenCache.set(scriptName, d);
    return d;
  }
  names() { return Object.keys(this.raw); }
  has(name) { return !!this.raw[name]; }
  // more card scripts (the rest of the card pool, loaded later)
  add(cards) { Object.assign(this.raw, cards); this.lower = null; }
}

// timestamps come from the game's own counter so two copies of a game (online play) order effects identically
let nextTimestamp = 1;
export function newTimestamp(game) { return game ? game.uid++ : nextTimestamp++; }

export class Card {
  constructor(game, def, owner) {
    this.isCard = true;
    this.id = game.nextId++;
    this.def = def;
    this.owner = owner;
    this.controller = owner;
    this.zone = 'library';
    this.token = !!def.token;
    this.isCommander = false;
    this.zcc = 0; // zone change counter: identifies "the same object"
    Object.defineProperty(this, 'game', { value: game, enumerable: false, writable: true });
    this.reset();
  }
  reset() {
    this.face = 0;
    this.tapped = false;
    this.sick = false;
    this.damage = 0;
    this.deathtouchHit = false;
    this.counters = {};
    this.attachedTo = null;
    this.temp = [];       // until-end-of-turn / duration modifications
    this.mods = [];       // animate / become effects with durations
    this.remembered = [];
    this.imprinted = [];
    this.chosen = {};
    this.faceDown = false;
    this.copyOf = null;   // { def, face } when copying another card
    this.kicked = 0;
    this.xPaid = 0;
    this.castFrom = null;
    this.castMayPlayHost = null;
    this.castSA = null;
    this.castGrants = null; // keywords other cards gave it as it was cast (Henzie's blitz), kept while it's a spell
    this.offspring = 0;
    this.timestamp = newTimestamp(this.game);
    this.regenShields = 0;
    this.goadedBy = [];
    this.phasedOut = false;
    this.abilityUses = {};
    this.enteredTurn = -1;
    this.mustBeExiled = false; // flashback / unearth style "exile instead if it would leave"
    this.attackingSince = null;
    this.monstrous = false;
    this.transformed = false;
    this.convokedBy = [];
    this.manaSpent = null;
    this.optionalCosts = [];
    this.lkiCause = null;
    this.promisedGift = null;
    this.unlocked = null; // Room doors unlocked on the battlefield (face indices)
    this.manifested = false; // face-down via manifest / cloak: can be turned up for its mana cost
    this.cloaked = false;
    this.disguised = false;
    this.pairedWith = null;
    this.impending = false;
    this.textChanges = null; // "change the text by replacing all instances of one creature type with another"
    this.textSwap = null; // exchanged text boxes (Exchange of Words)
    this.sector = null; // Space sculptor: 'Alpha' | 'Beta' | 'Gamma'
    this.attackedPlayers = null; // { turn, pids } players this creature attacked this turn
    this.attackTurns = []; // the last few turn numbers it attacked in
    this.untappedTurn = null; // the turn number it started untapped ("if it started the turn untapped")
    this.damageHistory = null; // { players, combat }: who it has dealt damage to, and whether combat damage
    this.hadToAttack = null; // { turn, combat } it was required to attack
    this.surveilledTurn = null;
    this.enteredController = null;
    this.meldedWith = null; // melded permanent: the other card it's made of
  }
  get faceDef() {
    if (this.copyOf && this.copyOf.def) return this.copyOf.def.faces[this.copyOf.face || 0] || this.copyOf.def.faces[0];
    return this.def.faces[this.face] || this.def.faces[0];
  }
  toString() { return `${this.faceDef.name}#${this.id}`; }
}

export class Player {
  constructor(id, name) {
    this.isPlayer = true;
    this.id = id;
    this.name = name;
    this.life = 40;
    this.library = [];
    this.hand = [];
    this.graveyard = [];
    this.exile = [];
    this.command = [];
    this.pool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    this.poison = 0;
    this.counters = {}; // energy, experience, poison, etc.
    this.commanderDamage = {}; // commanderCardId -> damage
    this.landsPlayed = 0;
    this.lost = false;
    this.lossReason = null;
    this.drewFromEmpty = false;
    this.commanders = []; // card ids
    this.dungeon = null; // { obj, room, next } while venturing
    this.dungeonsCompleted = [];
    this.commanderCasts = {}; // cardId -> times cast from command zone
    this.colorIdentity = [];
    this.lifeGainedThisTurn = 0;
    this.lifeLostThisTurn = 0;
    this.cardsDrawnThisTurn = 0;
    this.spellsCastThisTurn = [];
    this.turns = []; // the last few turn numbers this player took
    this.remembered = [];
    this.deckName = '';
    this.maxHandSize = 7;
  }
  toString() { return this.name; }
}

export function abilityList(raws, svars, src, prefix) {
  return raws.map((raw, i) => ({ raw, parsed: parseAbility(raw), svars, src, key: `${prefix}${i}` }));
}
