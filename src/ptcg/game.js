// Pokémon TCG rules engine: setup and mulligans, turns, the once-per-turn actions, evolution, retreat, attacks with
// Weakness and Resistance, special conditions and the Pokémon Checkup, Knock Outs and Prizes, and the ways to win.
// Like the Commander engine it is deterministic for a seed and the answers its agents give (agent.ask(game, pid, req)),
// so every browser in an online game can run the same game.
import { RNG } from '../engine/util.js';
import { ATTACKS, ABILITIES, TRAINERS, ENERGIES } from './cards.js';

export const TYPES = ['Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal', 'Dragon', 'Colorless'];

export class PCard {
  constructor(def, owner, id) { this.def = def; this.owner = owner; this.id = id; }
  get name() { return this.def.name; }
}

// a Pokémon in play: its evolution stack (top card last), attached Energy and Tool, damage and conditions
export class Mon {
  constructor(game, card) {
    this.id = game.uid++;
    this.stack = [card];
    this.energy = [];
    this.tool = null;
    this.damage = 0;
    this.special = null;          // 'asleep' | 'confused' | 'paralyzed'
    this.poisoned = false;
    this.burned = false;
    this.playedTurn = game.turn;
    this.evolvedTurn = -1;
    this.movedActiveTurn = -1;    // moved from the Bench to the Active Spot this turn (Gale Thrust)
    this.noEvolveTurn = -1;       // devolved this turn by Strange Timepiece: it can't evolve again this turn
    this.used = {};               // ability name -> turn used
  }
  get card() { return this.stack[this.stack.length - 1]; }
  get def() { return this.card.def; }
  get owner() { return this.card.owner; }
  get name() { return this.def.name; }
  allCards() { return [...this.stack, ...this.energy, ...(this.tool ? [this.tool] : [])]; }
}

const sleep0 = () => Promise.resolve();

// card questions about these zones show the player cards they couldn't see before
const HIDDEN_ZONES = new Set(['deck', 'deck-top', 'deck-bottom', 'prizes', 'opp-hand']);

export class PokemonGame {
  constructor({ db, players, seed = (Date.now() ^ (Math.random() * 1e9)) >>> 0, onUpdate = null, maxTurns = 120 }) {
    this.db = db;
    this.seed = seed;
    this.rng = new RNG(seed);
    this.uid = 1;
    this.turn = 0;
    this.current = 0;
    this.first = 0;
    this.stadium = null;          // { card, owner }
    this.effects = [];            // { kind, mon?, pid?, turn, ... } active during `turn`
    this.logs = [];
    this.events = [];             // for the table's animations: { id, kind, ... }
    this.over = false;
    this.winner = null;
    this.result = '';
    this.maxTurns = maxTurns;
    this.onUpdate = onUpdate;
    this.version = 0;
    this.pendingAsk = null;
    this.moveTriggers = [];       // Pokémon that moved from the Bench to the Active Spot this turn (Buzzing Boost)
    this.agents = players.map(p => p.agent);
    this.players = players.map((p, i) => {
      const deck = [];
      for (const [key, n] of p.deck.cards) for (let k = 0; k < n; k++) deck.push(new PCard(db[key], i, this.uid++));
      return {
        id: i, name: p.name, deckId: p.deck.id, deckName: p.deck.name, human: !!p.human,
        deck, hand: [], discard: [], lost: [], prizes: [], active: null, bench: [],
        turns: 0, supporter: false, supporterName: null, energyDone: false, retreated: false, stadiumDone: false,
        once: {}, koTurn: -99, mulligans: 0, inPlay: null, legacyUsed: false, vstarUsed: false,
        koLog: [],                    // this player's Pokémon Knocked Out: { turn, name, byAttack } (the last few)
      };
    });
  }

  // ------------------------------------------------------------ plumbing
  touch() { this.version++; }
  notify() { this.version++; if (this.onUpdate) this.onUpdate(this); }
  log(text, opts = {}) { this.logs.push({ text, turn: this.turn, ...opts }); if (this.logs.length > 600) this.logs.splice(0, 100); this.touch(); }
  event(kind, data = {}) { this.events.push({ id: this.uid++, kind, at: this.turn, ...data }); if (this.events.length > 200) this.events.splice(0, 50); }
  opp(pid) { return 1 - pid; }
  pl(pid) { return this.players[pid]; }
  monById(id) { for (const p of this.players) for (const m of this.inPlay(p.id)) if (m.id === id) return m; return null; }
  cardById(id) {
    for (const p of this.players) {
      for (const z of ['deck', 'hand', 'discard', 'lost', 'prizes']) { const c = p[z].find(x => x.id === id); if (c) return c; }
      for (const m of this.inPlay(p.id)) { const c = m.allCards().find(x => x.id === id); if (c) return c; }
    }
    if (this.stadium && this.stadium.card.id === id) return this.stadium.card;
    return null;
  }
  inPlay(pid) { const p = this.players[pid]; return p.active ? [p.active, ...p.bench] : [...p.bench]; }
  monClass() { return Mon; }
  ownerOf(mon) { return mon.owner; }
  isActive(mon) { return this.players[mon.owner].active === mon; }

  async ask(pid, req) {
    if (this.over) return null;
    // for telling a card backed out of from one that did something: questions asked, and ones that showed hidden
    // cards (the deck, Prize cards, the opponent's hand)
    this.asked = (this.asked || 0) + 1;
    if (req.type === 'cards' && (req.shown || HIDDEN_ZONES.has(req.from))) this.peeked = (this.peeked || 0) + 1;
    this.pendingAsk = { pid, req };
    this.notify();
    let v;
    try { v = await this.agents[pid].ask(this, pid, req); } finally { this.pendingAsk = null; }
    this.touch();
    return v;
  }

  // ------------------------------------------------------------ choices (validated, with sensible fallbacks)
  // hint tells a computer player what the choice is for ('take', 'discard', 'bench', 'attach', 'lose', ...)
  async chooseCards(pid, cards, { min = 0, max = 1, prompt = 'Choose cards', reveal = false, from = 'list', hint = 'take', shown = null } = {}) {
    if (!cards.length || max <= 0) return [];
    min = Math.min(min, cards.length); max = Math.min(max, cards.length);
    const v = await this.ask(pid, { type: 'cards', options: cards.map(c => c.id), min, max, prompt, from, hint, shown: shown && shown.map(c => c.id) });
    const ids = Array.isArray(v) ? [...new Set(v)] : [];
    let out = ids.map(id => cards.find(c => c.id === id)).filter(Boolean).slice(0, max);
    if (out.length < min) out = out.concat(cards.filter(c => !out.includes(c)).slice(0, min - out.length));
    if (reveal && out.length) this.log(`${this.players[pid].name} reveals ${out.map(c => c.name).join(', ')}.`);
    return out;
  }
  async chooseMon(pid, mons, { min = 1, max = 1, prompt = 'Choose a Pokémon', hint = '' } = {}) {
    if (!mons.length || max <= 0) return [];
    min = Math.min(min, mons.length); max = Math.min(max, mons.length);
    const v = await this.ask(pid, { type: 'mon', options: mons.map(m => m.id), min, max, prompt, hint });
    const ids = Array.isArray(v) ? [...new Set(v)] : [v];
    let out = ids.map(id => mons.find(m => m.id === id)).filter(Boolean).slice(0, max);
    if (out.length < min) out = out.concat(mons.filter(m => !out.includes(m)).slice(0, min - out.length));
    return out;
  }
  async chooseOneMon(pid, mons, prompt, hint = '') { return (await this.chooseMon(pid, mons, { min: 1, max: 1, prompt, hint }))[0] || null; }
  async confirm(pid, prompt, hint = '') { return !!(await this.ask(pid, { type: 'confirm', prompt, hint })); }
  async chooseOption(pid, options, prompt, hint = '') {
    if (!options.length) return null;
    const v = await this.ask(pid, { type: 'option', options, prompt, hint });
    return options.some(o => o.value === v) ? v : options[0].value;
  }
  // damage counters spread "in any way you like": { monId: count }
  async distribute(pid, total, mons, prompt, hint = 'damage') {
    if (!mons.length || total <= 0) return new Map();
    const v = await this.ask(pid, { type: 'distribute', total, options: mons.map(m => m.id), prompt, hint });
    const out = new Map();
    let left = total;
    if (v && typeof v === 'object') for (const [k, n] of Object.entries(v)) {
      const m = mons.find(x => x.id === +k);
      const c = Math.max(0, Math.min(left, Math.floor(+n || 0)));
      if (m && c) { out.set(m, (out.get(m) || 0) + c); left -= c; }
    }
    if (left > 0) out.set(mons[0], (out.get(mons[0]) || 0) + left);
    return out;
  }

  // ------------------------------------------------------------ card movement
  shuffle(pid) { this.rng.shuffle(this.players[pid].deck); }
  draw(pid, n = 1) {
    const p = this.players[pid];
    const got = p.deck.splice(0, Math.min(n, p.deck.length));
    p.hand.push(...got);
    if (got.length) this.event('draw', { pid, n: got.length });
    return got;
  }
  removeFromZones(card) {
    const p = this.players[card.owner];
    for (const z of ['deck', 'hand', 'discard', 'lost', 'prizes']) { const i = p[z].indexOf(card); if (i >= 0) { p[z].splice(i, 1); return z; } }
    if (p.inPlay === card) { p.inPlay = null; return 'play'; }
    for (const m of this.inPlay(card.owner)) {
      let i = m.energy.indexOf(card);
      if (i >= 0) { m.energy.splice(i, 1); return 'energy'; }
      if (m.tool === card) { m.tool = null; return 'tool'; }
    }
    if (this.stadium && this.stadium.card === card) { this.stadium = null; return 'stadium'; }
    return null;
  }
  moveTo(card, zone, { top = false } = {}) {
    this.removeFromZones(card);
    const p = this.players[card.owner];
    if (zone === 'deck' && top) p.deck.unshift(card); else p[zone].push(card);
  }
  discard(card) { this.moveTo(card, 'discard'); }
  // a Pokémon leaves play: every card under and attached goes to `zone` (default: its owner's discard pile)
  removeMon(mon, zone = 'discard') {
    const p = this.players[mon.owner];
    if (p.active === mon) p.active = null;
    p.bench = p.bench.filter(m => m !== mon);
    this.effects = this.effects.filter(e => e.mon !== mon.id);
    for (const c of mon.allCards()) { if (zone === 'deck') p.deck.push(c); else p[zone].push(c); }
    mon.stack = []; mon.energy = []; mon.tool = null;
  }

  benchLimit(pid) {
    if (this.stadium && this.stadium.card.name === 'Area Zero Underdepths' && this.inPlay(pid).some(m => m.def.tera)) return 8;
    return 5;
  }
  // Area Zero Underdepths leaving play or the last Tera Pokémon leaving: back down to 5 on the Bench
  async trimBench(pid) {
    const p = this.players[pid];
    while (p.bench.length > this.benchLimit(pid)) {
      const extra = p.bench.length - this.benchLimit(pid);
      const pick = await this.chooseMon(pid, p.bench, { min: extra, max: extra, prompt: `Discard ${extra} Pokémon from your Bench (limit ${this.benchLimit(pid)})` });
      for (const m of pick) { this.log(`${p.name} discards ${m.name} from the Bench.`); this.removeMon(m); }
    }
  }

  // ------------------------------------------------------------ queries
  isBasic(def) { return def.cat === 'P' && def.stage === 'Basic'; }
  isEvolution(def) { return def.cat === 'P' && def.stage !== 'Basic'; }
  ruleBox(def) { return !!(def.ex || def.radiant || def.v); }
  // Prizes for a Knock Out: 3 for a Mega Evolution ex, 2 for another ex or a Pokémon V, 1 otherwise (Radiant Pokémon too)
  prizeValue(mon) { return mon.def.mega ? 3 : mon.def.ex || mon.def.v ? 2 : 1; }
  isTera(mon) { return !!mon.def.tera; }
  typeOf(mon) { return mon.def.type; }
  prizesLeft(pid) { return this.players[pid].prizes.length; }
  prizesTaken(pid) { return 6 - this.players[pid].prizes.length; }
  // a Pokémon's Tool, unless Jamming Tower switches Tools off
  toolName(mon) { return mon.tool && this.stadiumName() !== 'Jamming Tower' ? mon.tool.name : null; }
  maxHp(mon) {
    let hp = mon.def.hp;
    const t = this.toolName(mon);
    const basic = mon.def.stage === 'Basic';
    if (t === 'Bravery Charm' && basic) hp += 50;
    if (t === 'Luxurious Cape' && !this.ruleBox(mon.def)) hp += 100;
    if (t === 'Ancient Booster Energy Capsule' && mon.def.ancient) hp += 60;
    if (t === "Hero's Cape") hp += 100;
    if (t === "Cynthia's Power Weight" && /^Cynthia's /.test(mon.name)) hp += 70;
    if (mon.def.type === 'Grass') hp += 20 * this.liveEnergy(mon, 'Growing Grass Energy').length;
    if (this.adrenaPower(mon)) hp += 100;
    if (this.stadium && this.stadium.card.name === 'Lively Stadium' && basic) hp += 30;
    if (this.stadium && this.stadium.card.name === 'Gravity Mountain' && mon.def.stage === 'Stage2') hp -= 30;
    return hp;
  }
  // Knocked Out during the given turn (default: the opponent's last turn), optionally by damage from an attack
  koDuring(pid, { turn = this.turn - 1, byAttack = false, filter = () => true } = {}) {
    return this.players[pid].koLog.some(k => k.turn === turn && (!byAttack || k.byAttack) && filter(k.name));
  }
  hpLeft(mon) { return this.maxHp(mon) - mon.damage; }
  counters(mon) { return Math.floor(mon.damage / 10); }
  hasEffect(kind, { mon, pid } = {}) { return this.effects.some(e => e.kind === kind && e.turn === this.turn && (mon == null || e.mon === mon.id) && (pid == null || e.pid === pid)); }
  addEffect(e) { this.effects.push(e); }
  stadiumName() { return this.stadium ? this.stadium.card.name : null; }

  // abilities: printed, and not switched off by Team Rocket's Watchtower, Canceling Cologne (the opponent's Active this
  // turn), Spiritomb's Fettered in Misfortune (Basic Pokémon V) or Flutter Mane's Midnight Fluttering (the Active
  // facing it keeps only a Midnight Fluttering of its own). (Psyduck's Damp stops self-KO abilities in legalActions.)
  baseAbilities(mon) {
    if (this.stadiumName() === "Team Rocket's Watchtower" && mon.def.type === 'Colorless') return [];
    if (this.effects.length && this.isActive(mon) && this.hasEffect('cologne', { pid: mon.owner })) return [];
    return mon.def.abilities || [];
  }
  abilitiesOf(mon) {
    let list = this.baseAbilities(mon);
    if (!list.length) return list;
    // Iron Thorns ex's Initialization (in the Active Spot): Pokémon with a Rule Box have no Abilities, except Future
    // Pokémon (Iron Thorns ex is one, so asking about its own Abilities doesn't come back here)
    if (this.ruleBox(mon.def) && !mon.def.future && this.players.some(p => p.active && p.active !== mon && this.baseAbilities(p.active).some(a => a.name === 'Initialization') && this.hasAbility(p.active, 'Initialization'))) return [];
    // Ting-Lu ex's Cursed Land (in the Active Spot): the opponent's Pokémon with damage counters have no Abilities,
    // except Pokémon ex
    if (mon.damage > 0 && !mon.def.ex) {
      const o = this.players[this.opp(mon.owner)].active;
      if (o && this.baseAbilities(o).some(a => a.name === 'Cursed Land') && this.hasAbility(o, 'Cursed Land')) return [];
    }
    if (mon.def.v && mon.def.stage === 'Basic' && this.players.some(p => this.inPlay(p.id).some(m => m !== mon && !m.def.v && this.abilitiesOf(m).some(a => a.name === 'Fettered in Misfortune')))) return [];
    if (this.isActive(mon)) {
      const o = this.players[this.opp(mon.owner)].active;
      if (o && this.baseAbilities(o).some(a => a.name === 'Midnight Fluttering')) list = list.filter(a => a.name === 'Midnight Fluttering');
    }
    return list;
  }
  hasAbility(mon, name) { return this.abilitiesOf(mon).some(a => a.name === name); }
  anyInPlayHasAbility(name, pid = null) { return this.players.some(p => (pid == null || p.id === pid) && this.inPlay(p.id).some(m => this.hasAbility(m, name))); }
  dampActive() { return this.anyInPlayHasAbility('Damp'); }
  // Jellicent ex's Oceanic Curse: while it's the opponent's Active Pokémon, no Items or Tools from this player's hand
  oceanicCurse(pid) { const o = this.players[this.opp(pid)].active; return !!o && this.hasAbility(o, 'Oceanic Curse'); }
  // Milotic's Mentally Calm: this player's Pokémon in play and their attached cards can't be put into their hand
  handLocked(pid) { return this.anyInPlayHasAbility('Mentally Calm', this.opp(pid)); }
  // Sandshrew's Sand Screen: this player's Items and Supporters can't put Trainer cards from their discard pile
  // into their deck
  sandScreen(pid) { return this.anyInPlayHasAbility('Sand Screen', this.opp(pid)); }
  // Patrat's Watchful Eye: damage counters can't be moved
  countersLocked() { return this.anyInPlayHasAbility('Watchful Eye'); }

  weaknessOf(mon) {
    // Archaludon ex's Metal Defender: no Weakness during the opponent's next turn
    if (this.effects.length && this.hasEffect('noWeakness', { mon })) return null;
    // Lillie's Clefairy ex: the opponent's Dragon Pokémon are weak to Psychic
    if (mon.def.type === 'Dragon' && this.anyInPlayHasAbility('Fairy Zone', this.opp(mon.owner))) return 'Psychic';
    return mon.def.weak;
  }
  // the Energy a Pokémon has, as a list of types, one entry per Energy it provides: Special Energy provides its
  // printed type (Colorless for most), Legacy Energy 'Any' type, and with Meganium's Wild Growth each Basic {G}
  // Energy provides {G}{G}
  // Team Rocket's Energy provides 2, each {P} or {D} (an entry 'Psychic/Darkness'); Ignition Energy {C}{C}{C} on an
  // Evolution Pokémon
  energyTypes(mon) {
    const out = [];
    for (const c of mon.energy) {
      if (!this.energyLive(c)) { out.push('Colorless'); continue; }
      const t = this.everyType(mon, c) ? 'Any' : c.def.either ? c.def.either.types.join('/') : c.def.provides || 'Colorless';
      for (let k = this.energyUnits(mon, c); k > 0; k--) out.push(t);
    }
    return out;
  }
  // Energy that provides every type: Legacy Energy; Prism Energy on a Basic Pokémon; Neo Upper Energy on a Stage 2
  everyType(mon, card) {
    if (card.def.anyType) return true;
    if (card.name === 'Prism Energy') return mon.def.stage === 'Basic' && this.energyLive(card);
    if (card.name === 'Neo Upper Energy') return mon.def.stage === 'Stage2' && this.energyLive(card);
    return false;
  }
  // does this Energy card, attached to this Pokémon, provide this type?
  cardProvides(mon, card, type) {
    if (!this.energyLive(card)) return type === 'Colorless';
    if (this.everyType(mon, card)) return true;
    if (card.def.either) return card.def.either.types.includes(type);
    return (card.def.provides || 'Colorless') === type;
  }
  // Temple of Sinnoh: Special Energy attached to Pokémon provides {C} and has no other effect
  energyLive(card) { return card.def.energy !== 'Special' || this.stadiumName() !== 'Temple of Sinnoh'; }
  // attached Energy with this name that still has its effect
  liveEnergy(mon, name) { return mon.energy.filter(c => c.name === name && this.energyLive(c)); }
  energyUnits(mon, card) {
    if (!this.energyLive(card)) return 1;
    if (card.def.either) return card.def.either.units;
    if (card.name === 'Ignition Energy') return mon.def.stage !== 'Basic' ? 3 : 1;
    if (card.name === 'Neo Upper Energy') return mon.def.stage === 'Stage2' ? 2 : 1;
    return card.def.energy === 'Basic' && card.def.provides === 'Grass' && this.wildGrowth(mon.owner) ? 2 : 1;
  }
  // does one Energy entry (from energyTypes) provide this type?
  provides(entry, type) { return entry === type || entry === 'Any' || (entry.includes('/') && entry.split('/').includes(type)); }
  isTeamRocket(mon) { return /^Team Rocket's /.test(mon.name); }
  wildGrowth(pid) { return this.inPlay(pid).some(m => this.hasAbility(m, 'Wild Growth')); }
  retreatCost(mon) {
    const p = mon.owner;
    if (mon.def.stage === 'Basic' && this.anyInPlayHasAbility('Skyliner', p)) return 0;
    if (this.hasAbility(mon, 'Agile') && !mon.energy.length) return 0;
    if (this.stadiumName() === "N's Castle" && /^N's /.test(mon.name)) return 0;
    // Archaludon's Metal Bridge: Pokémon with {M} Energy attached
    if (this.anyInPlayHasAbility('Metal Bridge', p) && this.energyTypes(mon).some(t => this.provides(t, 'Metal'))) return 0;
    const t = this.toolName(mon);
    // Future Booster Energy Capsule: a Future Pokémon has no Retreat Cost
    if (t === 'Future Booster Energy Capsule' && mon.def.future) return 0;
    let n = mon.def.retreat;
    if (t === 'Air Balloon') n -= 2;
    if (t === 'Rescue Board') { if (this.hpLeft(mon) <= 30) return 0; n -= 1; }
    // Mega Chandelure ex's Binding Flame: the opponent's Active Pokémon's Retreat Cost is {C} more (for each)
    if (this.isActive(mon)) n += this.inPlay(this.opp(p)).filter(m => this.hasAbility(m, 'Binding Flame')).length;
    return Math.max(0, n);
  }
  // Okidogi's Adrena-Power: with any {D} Energy attached, 100 more HP and 100 more damage
  adrenaPower(mon) { return this.hasAbility(mon, 'Adrena-Power') && mon.energy.some(c => this.cardProvides(mon, c, 'Darkness')); }
  // attack costs after reductions, as a list of types
  attackCost(mon, atk) {
    let cost = [...atk.cost];
    if (this.hasAbility(mon, 'Lost Provisions') && this.players[mon.owner].lost.length >= 4) return [];
    // Kyurem's Plasma Bane: Trifrost costs {C} once the opponent has discarded a Colress card
    if (atk.name === 'Trifrost' && this.hasAbility(mon, 'Plasma Bane') && this.players[this.opp(mon.owner)].discard.some(c => /Colress/.test(c.name))) return ['Colorless'];
    // Hop's Choice Band: attacks by the Hop's Pokémon it's attached to cost {C} less
    if (this.toolName(mon) === "Hop's Choice Band" && /^Hop's /.test(mon.name)) { const i = cost.lastIndexOf('Colorless'); if (i >= 0) cost.splice(i, 1); }
    // Nighttime Mine: attacks by Tera Pokémon cost {C} more
    if (this.stadiumName() === 'Nighttime Mine' && this.isTera(mon)) cost.push('Colorless');
    // Conkeldurr's Gutsy Swing: free while it's affected by a Special Condition
    if (atk.name === 'Gutsy Swing' && (mon.special || mon.poisoned || mon.burned)) return [];
    // Radiant Charizard's Excited Heart: {C} less for each Prize card the opponent has taken
    if (this.hasAbility(mon, 'Excited Heart')) for (let k = 0; k < this.prizesTaken(this.opp(mon.owner)); k++) { const i = cost.lastIndexOf('Colorless'); if (i < 0) break; cost.splice(i, 1); }
    if (atk.name === 'Blood Moon' && this.hasAbility(mon, 'Seasoned Skill')) {
      for (let k = 0; k < this.prizesTaken(this.opp(mon.owner)) && cost.length; k++) { const i = cost.lastIndexOf('Colorless'); if (i < 0) break; cost.splice(i, 1); }
    }
    return cost;
  }
  canPay(mon, cost, minus = 0) {
    const have = this.energyTypes(mon);
    const tryPay = (c) => {
      const pool = [...have];
      const typed = c.filter(t => t !== 'Colorless');
      // the exact type first, then Energy that provides one of a few types, then Energy that provides any type
      for (const t of typed) {
        let i = pool.indexOf(t);
        if (i < 0) i = pool.findIndex(e => e.includes('/') && e.split('/').includes(t));
        if (i < 0) i = pool.indexOf('Any');
        if (i < 0) return false;
        pool.splice(i, 1);
      }
      return pool.length >= c.length - typed.length;
    };
    if (!minus) return tryPay(cost);
    // Sparkling Crystal: one Energy less, of any type
    for (let i = 0; i < cost.length; i++) { const c = cost.slice(0, i).concat(cost.slice(i + 1)); if (tryPay(c)) return true; }
    return tryPay(cost);
  }
  costMinus(mon) { return this.toolName(mon) === 'Sparkling Crystal' && this.isTera(mon) ? 1 : 0; }

  // every attack a Pokémon can use: printed, from a Technical Machine, or copied by Genome Hacking
  attacksOf(mon) {
    const out = (mon.def.attacks || []).map(a => ({ ...a, src: 'own' }));
    if (this.toolName(mon) && mon.tool.def.attacks) for (const a of mon.tool.def.attacks) out.push({ ...a, src: 'tm' });
    // Relicanth's Memory Dive: evolved Pokémon can use the attacks of their previous Evolutions
    if (mon.stack.length > 1 && this.anyInPlayHasAbility('Memory Dive', mon.owner)) {
      for (const card of mon.stack.slice(0, -1)) for (const a of card.def.attacks || []) if (!out.some(x => x.name === a.name)) out.push({ ...a, src: 'prev' });
    }
    // Mew ex's Memory Helix: the attacks of any of your Benched Pokémon (with this Pokémon's own Energy)
    if (this.hasAbility(mon, 'Memory Helix')) {
      for (const b of this.players[mon.owner].bench) if (b !== mon) for (const a of b.def.attacks || []) out.push({ ...a, src: 'b' + b.id });
    }
    return out;
  }
  // Festival Lead: with Festival Grounds in play, this Pokémon may attack twice each turn
  festivalLead(mon) { return this.stadiumName() === 'Festival Grounds' && this.hasAbility(mon, 'Festival Lead'); }
  // can this Pokémon evolve now? Not the turn it came into play or evolved, unless Forest of Vitality lets a {G}
  // Pokémon evolve into a {G} Pokémon; never right after Strange Timepiece devolved it
  canEvolveNow(mon, def) {
    if (mon.noEvolveTurn === this.turn) return false;
    if (mon.playedTurn !== this.turn && mon.evolvedTurn !== this.turn) return true;
    // Eevee's Boosted Evolution: in the Active Spot it can evolve the turn it's played (or the first turn)
    if (this.boostedEvolution(mon) && mon.evolvedTurn !== this.turn) return true;
    return this.stadiumName() === 'Forest of Vitality' && mon.def.type === 'Grass' && def.type === 'Grass';
  }
  boostedEvolution(mon) { return this.isActive(mon) && this.hasAbility(mon, 'Boosted Evolution'); }
  // does this card evolve from this Pokémon? (Eevee ex's Rainbow DNA: into any Pokémon ex that evolves from Eevee)
  evolvesFrom(mon, def) { return def.from === mon.name || (!!def.ex && def.from === 'Eevee' && this.hasAbility(mon, 'Rainbow DNA')); }
  // Bronzong's Evolution Jammer: no evolving from the hand this turn
  evolutionJammed(pid) { return this.hasEffect('evoLock', { pid }); }
  attackBlock(mon, atk) {
    const pid = mon.owner;
    const p = this.players[pid];
    if (this.turn === 1 && pid === this.first) return 'No attacks on the first turn of the game';
    if (!this.isActive(mon)) return 'Only your Active Pokémon can attack';
    if (mon.special === 'asleep' || mon.special === 'paralyzed') return `${mon.name} is ${mon.special}`;
    if (this.hasEffect('cantAttack', { mon })) return `${mon.name} can't attack this turn`;
    // Team Rocket's Mewtwo ex's Power Saver
    if (this.hasAbility(mon, 'Power Saver') && this.inPlay(pid).filter(m => this.isTeamRocket(m)).length < 4) return "Needs 4 or more Team Rocket's Pokémon in play";
    if (this.effects.some(e => e.kind === 'cantUse' && e.turn === this.turn && e.mon === mon.id && e.name === atk.name)) return `${mon.name} can't use ${atk.name} this turn`;
    if (!this.canPay(mon, this.attackCost(mon, atk), this.costMinus(mon))) return 'Not enough Energy';
    const fx = ATTACKS[atk.name];
    if (fx && fx.can) { const why = fx.can(this, mon, atk); if (why) return why; }
    if (atk.name === 'Genome Hacking') { const d = this.players[this.opp(pid)].active; if (!d || !(d.def.attacks || []).length) return 'Nothing to copy'; }
    return p ? null : 'No player';
  }

  // ------------------------------------------------------------ setup
  async start() {
    try {
      await this.setup();
      while (!this.over) await this.takeTurn();
    } catch (e) {
      if (e && e.gameOver) return;
      throw e;
    }
  }

  async setup() {
    for (const p of this.players) this.shuffle(p.id);
    this.log('Both players shuffle their decks and draw 7 cards.', { type: 'turn' });
    // draw 7, mulligan until there is a Basic Pokémon
    for (const p of this.players) {
      for (;;) {
        this.draw(p.id, 7);
        if (p.hand.some(c => this.isBasic(c.def))) break;
        p.mulligans++;
        this.log(`${p.name} has no Basic Pokémon and takes a mulligan.`);
        this.event('mulligan', { pid: p.id });
        p.deck.push(...p.hand.splice(0));
        this.shuffle(p.id);
        if (p.mulligans > 30) throw new Error('deck without Basic Pokémon');
      }
    }
    // coin flip for the first turn
    const heads = this.flipRaw();
    const winner = heads ? 0 : 1;
    this.log(`Coin flip: ${heads ? 'heads' : 'tails'}. ${this.players[winner].name} wins the flip.`);
    this.event('coin', { heads, pid: winner, reason: 'Who goes first' });
    const goFirst = await this.chooseOption(winner, [{ value: 'first', label: 'Go first' }, { value: 'second', label: 'Go second' }], 'You won the coin flip. Go first or second?');
    this.first = goFirst === 'second' ? 1 - winner : winner;
    this.log(`${this.players[this.first].name} goes first.`);
    // Active and Bench, face down
    for (const p of this.players) {
      const basics = p.hand.filter(c => this.isBasic(c.def));
      const [act] = await this.chooseCards(p.id, basics, { min: 1, max: 1, prompt: 'Choose your Active Pokémon', from: 'hand', hint: 'setup-active' });
      p.hand.splice(p.hand.indexOf(act), 1);
      p.active = new Mon(this, act);
      const rest = p.hand.filter(c => this.isBasic(c.def));
      const bench = await this.chooseCards(p.id, rest, { min: 0, max: 5, prompt: 'Put up to 5 Basic Pokémon on your Bench', from: 'hand', hint: 'setup-bench' });
      for (const c of bench) { p.hand.splice(p.hand.indexOf(c), 1); p.bench.push(new Mon(this, c)); }
    }
    // extra cards for the opponent's mulligans
    for (const p of this.players) {
      const extra = this.players[this.opp(p.id)].mulligans;
      if (!extra) continue;
      const n = await this.chooseOption(p.id, Array.from({ length: extra + 1 }, (_, k) => ({ value: k, label: k ? `Draw ${k}` : "Don't draw" })), `Your opponent took ${extra} mulligan${extra > 1 ? 's' : ''}. Draw up to ${extra} extra card${extra > 1 ? 's' : ''}?`);
      if (n > 0) { this.draw(p.id, n); this.log(`${p.name} draws ${n} extra card${n > 1 ? 's' : ''}.`); }
    }
    for (const p of this.players) p.prizes = p.deck.splice(0, 6);
    for (const p of this.players) this.log(`${p.name} reveals ${p.active.name}${p.bench.length ? ` with ${p.bench.map(m => m.name).join(', ')} on the Bench` : ''}.`);
    this.notify();
  }

  // ------------------------------------------------------------ turns
  async takeTurn() {
    this.turn++;
    this.current = this.turn === 1 ? this.first : this.opp(this.current);
    const pid = this.current;
    const p = this.players[pid];
    p.turns++;
    p.supporter = false; p.supporterName = null; p.energyDone = false; p.retreated = false; p.stadiumDone = false; p.briar = false;
    this.effects = this.effects.filter(e => e.turn >= this.turn);
    this.moveTriggers = [];
    this.log(`Turn ${this.turn}: ${p.name}`, { type: 'turn', pid });
    this.event('turn', { pid });
    if (this.turn > this.maxTurns) return this.endGame(null, 'Turn limit reached');
    // draw for turn
    if (!p.deck.length) return this.endGame(this.opp(pid), `${p.name} can't draw a card`);
    this.draw(pid, 1);
    this.notify();
    for (let guard = 0; guard < 400 && !this.over; guard++) {
      const actions = this.legalActions(pid);
      const a = await this.ask(pid, { type: 'main', actions });
      if (this.over) return;
      const act = this.matchAction(actions, a);
      // an answer that isn't one of the choices (a stale click) asks again rather than ending the turn
      if (!act) continue;
      if (act.t === 'end') break;
      if (act.t === 'attack') {
        const mon = p.active;
        await this.attack(pid, act);
        if (!this.over) await this.attackAgain(pid, mon);
        if (!this.over) await this.runMoveTriggers();
        break;
      }
      await this.doAction(pid, act);
      await this.checkKOs();
      if (this.over) return;
    }
    if (this.over) return;
    await this.endTurn(pid);
  }

  // Festival Lead: a second attack by the same Pokémon, if it is still Active (after the opponent replaces a
  // Knocked Out Active Pokémon)
  async attackAgain(pid, mon) {
    const p = this.players[pid];
    if (!mon || p.active !== mon || !mon.stack.length || !this.festivalLead(mon) || !this.players[this.opp(pid)].active) return;
    const actions = this.attacksOf(mon).filter(atk => !this.attackBlock(mon, atk)).map(atk => ({ t: 'attack', mon: mon.id, name: atk.name, src: atk.src }));
    if (!actions.length) return;
    actions.push({ t: 'end' });
    this.log(`Festival Lead: ${mon.name} may attack again.`, { pid });
    const a = await this.ask(pid, { type: 'main', actions, again: true });
    if (this.over) return;
    const act = this.matchAction(actions, a);
    if (act && act.t === 'attack') await this.attack(pid, act);
  }

  matchAction(actions, a) {
    if (!a || typeof a !== 'object') return { t: 'end' };
    return actions.find(x => x.t === a.t && x.card === a.card && x.target === a.target && x.mon === a.mon && x.name === a.name && x.to === a.to && x.src === a.src) || null;
  }

  // every legal move in the main phase, for the agents and the table
  legalActions(pid) {
    const g = this;
    const p = this.players[pid];
    const out = [];
    const firstTurn = p.turns === 1;
    const mons = this.inPlay(pid);
    // Frillish's Oceanic Gloom (this turn), Jellicent ex's Oceanic Curse (while it's the opponent's Active Pokémon)
    const itemLock = this.hasEffect('itemLock', { pid }) || this.oceanicCurse(pid);
    const evoLock = this.evolutionJammed(pid);
    // Genesect's ACE Nullifier (with a Tool attached): no ACE SPEC cards from the hand
    const aceLocked = this.inPlay(this.opp(pid)).some(m => m.tool && this.hasAbility(m, 'ACE Nullifier'));
    for (const c of p.hand) {
      const d = c.def;
      if (d.cat === 'P' && d.stage === 'Basic' && p.bench.length < this.benchLimit(pid)) out.push({ t: 'bench', card: c.id });
      if (d.cat === 'P' && d.stage !== 'Basic' && !evoLock) {
        for (const m of mons) if ((!firstTurn || this.boostedEvolution(m)) && this.evolvesFrom(m, d) && this.canEvolveNow(m, d)) out.push({ t: 'evolve', card: c.id, target: m.id });
      }
      if (d.ace && aceLocked) continue;
      if (d.cat === 'E' && !p.energyDone) for (const m of mons) if (d.name !== "Team Rocket's Energy" || this.isTeamRocket(m)) out.push({ t: 'energy', card: c.id, target: m.id });
      if (d.cat === 'T') {
        const fx = TRAINERS[d.name] || {};
        if (d.trainer === 'Tool') {
          if (itemLock) continue;
          for (const m of mons) if (!m.tool && (!fx.canAttach || fx.canAttach(g, m))) out.push({ t: 'tool', card: c.id, target: m.id });
          continue;
        }
        if (d.trainer === 'Supporter') {
          if (p.supporter) continue;
          if (this.turn === 1 && pid === this.first && d.name !== 'Carmine' && d.name !== "Team Rocket's Proton") continue;
        }
        if (d.trainer === 'Item' && itemLock) continue;
        if (d.trainer === 'Stadium' && (p.stadiumDone || (this.stadium && this.stadium.card.name === d.name))) continue;
        if (fx.can && !fx.can(g, pid, c)) continue;
        // nothing to search or draw
        if (fx.needsDeck && !p.deck.length) continue;
        out.push({ t: 'trainer', card: c.id });
      }
    }
    // abilities
    for (const m of mons) {
      for (const a of this.abilitiesOf(m)) {
        const fx = ABILITIES[a.name];
        if (!fx || !fx.use) continue;
        if (fx.selfKO && this.dampActive()) continue;
        if (fx.can && !fx.can(g, m, pid)) continue;
        if (fx.needsDeck && !p.deck.length) continue;
        out.push({ t: 'ability', mon: m.id, name: a.name });
      }
    }
    // stadium actions (Artazon, Surfing Beach, Mystery Garden, Academy at Night)
    if (this.stadium) {
      const fx = TRAINERS[this.stadium.card.name];
      if (fx && fx.stadiumUse && !(p.once['stadium'] === this.turn) && (!fx.stadiumCan || fx.stadiumCan(g, pid)) && !(fx.needsDeck && !p.deck.length)) out.push({ t: 'stadium', name: this.stadium.card.name });
    }
    // retreat
    const a = p.active;
    if (a && p.bench.length && !p.retreated && a.special !== 'asleep' && a.special !== 'paralyzed' && !this.hasEffect('cantRetreat', { mon: a }) && this.energyTypes(a).length >= this.retreatCost(a)) {
      for (const b of p.bench) out.push({ t: 'retreat', to: b.id });
    }
    // attacks
    if (a) for (const atk of this.attacksOf(a)) if (!this.attackBlock(a, atk)) out.push({ t: 'attack', mon: a.id, name: atk.name, src: atk.src });
    out.push({ t: 'end' });
    return out;
  }

  async doAction(pid, act) {
    const p = this.players[pid];
    const card = act.card != null ? p.hand.find(c => c.id === act.card) : null;
    const target = act.target != null ? this.monById(act.target) : null;
    switch (act.t) {
      case 'bench': {
        p.hand.splice(p.hand.indexOf(card), 1);
        const m = new Mon(this, card);
        p.bench.push(m);
        this.log(`${p.name} puts ${card.name} on the Bench.`, { pid });
        this.event('enter', { mon: m.id });
        await this.onBenchFromHand(pid, m);
        break;
      }
      case 'evolve': await this.evolve(pid, target, card, { fromHand: true }); break;
      case 'energy': {
        p.energyDone = true;
        await this.attachEnergy(pid, target, card, { fromHand: true });
        break;
      }
      case 'tool': {
        p.hand.splice(p.hand.indexOf(card), 1);
        target.tool = card;
        this.log(`${p.name} attaches ${card.name} to ${target.name}.`, { pid });
        if (card.name === 'Ancient Booster Energy Capsule' && target.def.ancient) this.clearConditions(target);
        break;
      }
      case 'trainer': {
        // a Trainer backed out of (nothing chosen, nothing changed, nothing shuffled or revealed) goes back to the hand
        const t = card.def.trainer, undo = t !== 'Stadium' && !(TRAINERS[card.name] || {}).reveals ? this.snapshot(card.id) : null;
        const flags = { supporter: p.supporter, supporterName: p.supporterName };
        await this.playTrainer(pid, card);
        if (undo && !this.over && this.unchanged(undo, card.id)) {
          this.removeFromZones(card);
          p.hand.push(card);
          Object.assign(p, flags);
          this.log(`${card.name} does nothing and goes back to ${p.name}'s hand.`, { pid });
        }
        break;
      }
      case 'ability': {
        const m = this.monById(act.mon);
        const fx = ABILITIES[act.name];
        this.log(`${p.name} uses ${m.name}'s ${act.name}.`, { pid, type: 'ability' });
        this.event('ability', { mon: m.id, name: act.name });
        const undo = this.snapshot(), was = [m.used[act.name], p.once[act.name]];
        m.used[act.name] = this.turn;
        if (fx.oncePerPlayer) p.once[act.name] = this.turn;
        await fx.use(this, m, pid);
        // backed out of: the Ability isn't used up
        if (!this.over && this.unchanged(undo)) {
          m.used[act.name] = was[0];
          p.once[act.name] = was[1];
          this.log(`${act.name} does nothing; it can still be used this turn.`, { pid });
        }
        break;
      }
      case 'stadium': {
        const fx = TRAINERS[act.name];
        const undo = this.snapshot(), was = p.once['stadium'];
        p.once['stadium'] = this.turn;
        this.log(`${p.name} uses ${act.name}.`, { pid });
        await fx.stadiumUse(this, pid);
        if (!this.over && this.unchanged(undo)) {
          p.once['stadium'] = was;
          this.log(`${act.name} does nothing; it can still be used this turn.`, { pid });
        }
        break;
      }
      case 'retreat': {
        const a = p.active;
        const to = this.monById(act.to);
        const n = this.retreatCost(a);
        if (n > 0) for (const c of await this.chooseEnergyToPay(pid, a, n, `Discard ${n} Energy to retreat ${a.name}`)) this.discard(c);
        p.retreated = true;
        this.log(`${p.name} retreats ${a.name}${to ? ` and sends out ${to.name}` : ''}.`, { pid });
        this.switchActive(pid, to);
        break;
      }
    }
    await this.runMoveTriggers();
    this.festivalSweep();
    this.notify();
  }

  // a picture of everything a Trainer or an Ability could change (`skip`: the card being played), and the random
  // generator's state: to tell when one was backed out of without anything happening
  snapshot(skip = null) {
    const ids = l => l.filter(c => c.id !== skip).map(c => c.id).join(',');
    const mon = m => `${m.id}:${m.stack.map(c => c.id).join('>')}:${m.damage}:${ids(m.energy)}:${m.tool ? m.tool.id : ''}:${m.special || ''}${m.poisoned ? 'P' : ''}${m.burned ? 'B' : ''}`;
    let fx;
    try { fx = JSON.stringify(this.effects); } catch { fx = String(this.effects.length); }
    const key = [this.stadium ? `${this.stadium.card.id}@${this.stadium.owner}` : '-', fx, ...this.players.map(p => [
      ids(p.hand), ids(p.deck), ids(p.discard), ids(p.lost), ids(p.prizes), p.active ? mon(p.active) : '-', p.bench.map(mon).join(';'),
      p.koTurn, p.legacyUsed, p.briar, p.mulligans,
    ].join('|'))].join('#');
    return { key, rng: this.rng.s, asked: this.asked || 0, peeked: this.peeked || 0 };
  }
  // backed out of: the player was asked something, chose nothing, saw no hidden card, and nothing changed or was
  // shuffled. (A card that asks nothing and does nothing, like a search that finds nothing, is still used up.)
  unchanged(snap, skip = null) {
    return (this.asked || 0) > snap.asked && (this.peeked || 0) === snap.peeked && this.rng.s === snap.rng && this.snapshot(skip).key === snap.key;
  }

  // Festival Grounds: each Pokémon with Energy attached recovers from all Special Conditions
  festivalSweep() {
    // Team Rocket's Energy attached to anything other than a Team Rocket's Pokémon is discarded
    for (const p of this.players) for (const m of this.inPlay(p.id)) for (const c of this.liveEnergy(m, "Team Rocket's Energy")) {
      if (!this.isTeamRocket(m)) { this.discard(c); this.log(`Team Rocket's Energy is discarded from ${m.name}.`); }
    }
    if (this.stadiumName() !== 'Festival Grounds') return;
    for (const p of this.players) for (const m of this.inPlay(p.id)) {
      if (!m.energy.length || !(m.special || m.poisoned || m.burned)) continue;
      this.clearConditions(m);
      this.log(`${m.name} recovers from its Special Conditions (Festival Grounds).`);
    }
  }

  // Energy cards that pay `n` Energy (a Retreat Cost): one card each, or fewer when Wild Growth makes a card provide 2
  async chooseEnergyToPay(pid, mon, n, prompt) {
    const units = c => this.energyUnits(mon, c);
    if (mon.energy.every(c => units(c) === 1)) return this.chooseCards(pid, mon.energy, { min: n, max: n, prompt, from: 'energy', hint: 'retreat-cost' });
    const pay = await this.chooseCards(pid, mon.energy, { min: 1, max: Math.min(n, mon.energy.length), prompt, from: 'energy', hint: 'retreat-cost' });
    const sum = list => list.reduce((s, c) => s + units(c), 0);
    for (const c of mon.energy) if (sum(pay) < n && !pay.includes(c)) pay.push(c);
    while (pay.length > 1 && sum(pay) - units(pay[pay.length - 1]) >= n) pay.pop();
    return pay;
  }

  // ------------------------------------------------------------ actions
  async onBenchFromHand(pid, m) {
    // Risky Ruins: 2 damage counters on a Basic non-{D} Pokémon benched during its owner's turn
    if (this.stadiumName() === 'Risky Ruins' && m.def.stage === 'Basic' && m.def.type !== 'Darkness' && this.current === pid) {
      this.addCounters(m, 2, {});
      this.log(`Risky Ruins puts 2 damage counters on ${m.name}.`);
    }
    for (const a of this.abilitiesOf(m)) {
      const fx = ABILITIES[a.name];
      if (fx && fx.onBench && (!fx.can || fx.can(this, m, pid)) && !(fx.needsDeck && !this.players[pid].deck.length)) {
        if (!(await this.confirm(pid, `Use ${m.name}'s ${a.name}?`))) continue;
        this.log(`${this.players[pid].name} uses ${m.name}'s ${a.name}.`, { pid, type: 'ability' });
        m.used[a.name] = this.turn;
        if (fx.oncePerPlayer) this.players[pid].once[fx.oncePerPlayer === true ? a.name : fx.oncePerPlayer] = this.turn;
        await fx.onBench(this, m, pid);
      }
    }
  }

  async evolve(pid, mon, card, { fromHand = false } = {}) {
    this.removeFromZones(card);
    mon.stack.push(card);
    mon.evolvedTurn = this.turn;
    this.clearConditions(mon);
    this.effects = this.effects.filter(e => e.mon !== mon.id);
    this.log(`${this.players[pid].name} evolves ${mon.stack[mon.stack.length - 2].name} into ${card.name}.`, { pid });
    this.event('evolve', { mon: mon.id });
    if (!fromHand) return;
    for (const a of this.abilitiesOf(mon)) {
      const fx = ABILITIES[a.name];
      if (fx && fx.onEvolve && (!fx.can || fx.can(this, mon, pid)) && !(fx.needsDeck && !this.players[pid].deck.length)) {
        if (!(await this.confirm(pid, `Use ${card.name}'s ${a.name}?`))) continue;
        this.log(`${this.players[pid].name} uses ${card.name}'s ${a.name}.`, { pid, type: 'ability' });
        mon.used[a.name] = this.turn;
        await fx.onEvolve(this, mon, pid);
      }
    }
  }

  async attachEnergy(pid, mon, card, { fromHand = false, quiet = false } = {}) {
    this.removeFromZones(card);
    mon.energy.push(card);
    if (!quiet) this.log(`${this.players[pid].name} attaches ${card.name} to ${mon.name}.`, { pid });
    this.event('energy', { mon: mon.id, type: card.def.provides });
    // Jet Energy: attached from hand to a Benched Pokémon, it switches in
    if (fromHand && card.name === 'Jet Energy' && this.energyLive(card) && !this.isActive(mon) && this.players[pid].active) {
      this.log(`Jet Energy switches ${mon.name} into the Active Spot.`);
      this.switchActive(pid, mon);
    }
    if (card.name === 'Bubbly Water Energy' && mon.def.type === 'Water' && this.energyLive(card) && (mon.special || mon.poisoned || mon.burned)) { this.clearConditions(mon); this.log(`${mon.name} recovers from its Special Conditions (Bubbly Water Energy).`); }
    // Special Energy that does something when attached from hand (Enriching Energy, Telepathic Psychic Energy)
    const fx = ENERGIES[card.name];
    if (fromHand && fx && fx.onAttach && this.energyLive(card) && (!fx.can || fx.can(this, mon, pid))) await fx.onAttach(this, mon, pid);
  }

  async playTrainer(pid, card) {
    const p = this.players[pid];
    const d = card.def;
    const fx = TRAINERS[d.name] || {};
    p.hand.splice(p.hand.indexOf(card), 1);
    if (d.trainer === 'Supporter') { p.supporter = true; p.supporterName = d.name; }
    if (d.trainer === 'Stadium') {
      p.stadiumDone = true;
      const old = this.stadium;
      if (old) { this.players[old.card.owner].discard.push(old.card); this.log(`${old.card.name} is discarded.`); }
      this.stadium = { card, owner: pid };
      this.log(`${p.name} plays ${d.name}.`, { pid, type: 'trainer' });
      this.event('trainer', { pid, card: card.id });
      if (old && old.card.name === 'Area Zero Underdepths') { await this.trimBench(old.card.owner); await this.trimBench(this.opp(old.card.owner)); }
      return;
    }
    p.inPlay = card;
    this.log(`${p.name} plays ${d.name}.`, { pid, type: 'trainer' });
    this.event('trainer', { pid, card: card.id });
    if (fx.play) await fx.play(this, pid, card);
    if (p.inPlay === card) { p.inPlay = null; p.discard.push(card); }
  }

  switchActive(pid, benchMon) {
    const p = this.players[pid];
    if (!benchMon || !p.bench.includes(benchMon)) return;
    const old = p.active;
    p.bench = p.bench.filter(m => m !== benchMon);
    if (old) {
      this.clearConditions(old);
      this.effects = this.effects.filter(e => e.mon !== old.id);
      p.bench.push(old);
    }
    p.active = benchMon;
    benchMon.movedActiveTurn = this.turn;
    this.event('switch', { pid, mon: benchMon.id });
    this.movedUp(pid, benchMon);
  }
  // a Pokémon moved from the Bench to the Active Spot: Abilities that trigger on that during your turn run once the
  // current action is done (runMoveTriggers)
  movedUp(pid, mon) {
    if (this.current === pid && this.turn > 0 && this.hasAbility(mon, 'Buzzing Boost') && mon.used['Buzzing Boost'] !== this.turn) this.moveTriggers.push(mon);
  }
  async runMoveTriggers() {
    while (this.moveTriggers.length && !this.over) {
      const m = this.moveTriggers.shift();
      const pid = m.owner, p = this.players[pid];
      if (!m.stack.length || p.active !== m || this.current !== pid || m.used['Buzzing Boost'] === this.turn || !this.hasAbility(m, 'Buzzing Boost')) continue;
      const fx = ABILITIES['Buzzing Boost'];
      if (fx.can && !fx.can(this, m, pid)) continue;
      if (!(await this.confirm(pid, `Use ${m.name}'s Buzzing Boost?`))) continue;
      this.log(`${p.name} uses ${m.name}'s Buzzing Boost.`, { pid, type: 'ability' });
      m.used['Buzzing Boost'] = this.turn;
      await fx.onMoveUp(this, m, pid);
    }
    this.moveTriggers = [];
  }
  // the opponent's Benched Pokémon is dragged into the Active Spot (Boss's Orders and friends)
  gust(pid, benchMon) {
    const o = benchMon.owner;
    this.log(`${benchMon.name} is switched into ${this.players[o].name}'s Active Spot.`);
    this.switchActive(o, benchMon);
  }
  // a player's Active Pokémon is gone: they pick a new one, or lose
  async promote(pid) {
    const p = this.players[pid];
    if (p.active || this.over) return;
    if (!p.bench.length) return this.endGame(this.opp(pid), `${p.name} has no Pokémon left in play`);
    const m = await this.chooseOneMon(pid, p.bench, 'Choose your new Active Pokémon', 'promote');
    p.bench = p.bench.filter(x => x !== m);
    p.active = m;
    m.movedActiveTurn = this.turn;
    this.log(`${p.name} sends out ${m.name}.`, { pid });
    this.event('switch', { pid, mon: m.id });
    this.movedUp(pid, m);
    await this.runMoveTriggers();
  }

  clearConditions(mon) { mon.special = null; mon.poisoned = false; mon.burned = false; }
  // special conditions: Ancient Booster Energy Capsule, Flare Veil and Dig keep them off
  conditionImmune(mon, cond) {
    if (this.toolName(mon) === 'Ancient Booster Energy Capsule' && mon.def.ancient) return true;
    // Bubbly Water Energy: the {W} Pokémon it's attached to can't be affected by Special Conditions
    if (mon.def.type === 'Water' && this.liveEnergy(mon, 'Bubbly Water Energy').length) return true;
    if (this.stadiumName() === 'Festival Grounds' && mon.energy.length) return true;
    // Hoothoot's Insomnia
    if (cond === 'asleep' && this.hasAbility(mon, 'Insomnia')) return true;
    return false;
  }
  setCondition(mon, cond, ctx = null) {
    if (this.conditionImmune(mon, cond)) return false;
    if (ctx && this.effectsBlocked(ctx, mon)) return false;
    if (cond === 'poisoned') mon.poisoned = true;
    else if (cond === 'burned') mon.burned = true;
    else mon.special = cond;
    this.log(`${mon.name} is now ${cond === 'poisoned' ? 'Poisoned' : cond === 'burned' ? 'Burned' : cond[0].toUpperCase() + cond.slice(1)}.`);
    this.event('condition', { mon: mon.id, cond });
    return true;
  }
  // effects of an opponent's attack can be stopped (Charmeleon's Flare Veil, Dunsparce's Dig, Hide 'n' Sneak,
  // Mist Energy); damage is not an effect
  effectsBlocked(ctx, mon) {
    if (!ctx || mon.owner === ctx.pid) return false;
    if (this.hasAbility(mon, 'Flare Veil') || this.hasAbility(mon, "Hide 'n' Sneak")) return true;
    if (this.hasEffect('dig', { mon })) return true;
    if (this.liveEnergy(mon, 'Mist Energy').length) return true;
    // Rocky Fighting Energy protects the {F} Pokémon it's attached to
    if (mon.def.type === 'Fighting' && this.liveEnergy(mon, 'Rocky Fighting Energy').length) return true;
    // Empoleon ex's Emperor's Stance
    if (this.hasAbility(mon, "Emperor's Stance")) return true;
    // Team Rocket's Articuno's Repelling Veil protects its owner's Basic Team Rocket's Pokémon
    if (mon.def.stage === 'Basic' && this.isTeamRocket(mon) && this.anyInPlayHasAbility('Repelling Veil', mon.owner)) return true;
    return false;
  }
  // effects of the opponent's Abilities can be stopped too (Hide 'n' Sneak)
  abilityBlocked(pid, mon) { return mon.owner !== pid && this.hasAbility(mon, "Hide 'n' Sneak"); }

  addCounters(mon, n, { ctx = null, from = null } = {}) {
    if (n <= 0 || !mon.stack.length) return 0;
    if (ctx && this.effectsBlocked(ctx, mon)) return 0;
    // Battle Cage: no damage counters on Benched Pokémon from the opponent's attacks' effects and Abilities
    const src = ctx ? ctx.pid : from;
    if (src != null && src !== mon.owner && this.stadiumName() === 'Battle Cage' && !this.isActive(mon)) return 0;
    mon.damage += 10 * n;
    this.event('damage', { mon: mon.id, amount: 10 * n, counters: true });
    return n;
  }
  heal(mon, amount) {
    const h = Math.min(mon.damage, amount);
    if (h > 0) { mon.damage -= h; this.log(`${mon.name} heals ${h} damage.`); this.event('heal', { mon: mon.id, amount: h }); }
    return h;
  }

  // coin flips go through the game's seeded generator so every copy of a game sees the same result
  flipRaw() { return this.rng.next() < 0.5; }
  flip(reason = '') {
    const heads = this.flipRaw();
    this.log(`Coin flip${reason ? ` (${reason})` : ''}: ${heads ? 'heads' : 'tails'}.`);
    this.event('coin', { heads, reason });
    return heads;
  }

  // ------------------------------------------------------------ attacking
  async attack(pid, act) {
    const p = this.players[pid];
    const mon = p.active;
    const atk = this.attacksOf(mon).find(a => a.name === act.name && a.src === act.src);
    const defender = this.players[this.opp(pid)].active;
    this.log(`${mon.name} uses ${atk.name}${defender ? ` on ${defender.name}` : ''}.`, { pid, type: 'attack' });
    this.event('attack', { mon: mon.id, target: defender && defender.id, name: atk.name });
    this.notify();
    if (mon.special === 'confused' && !this.flip(`${mon.name} is Confused`)) {
      this.log(`${mon.name} hurts itself in its confusion.`);
      this.addCounters(mon, 3);
      await this.checkKOs();
      return;
    }
    let use = atk;
    if (atk.name === 'Genome Hacking' && defender) {
      const opts = (defender.def.attacks || []).map(a => ({ value: a.name, label: `${a.name}${a.damage ? ` (${a.damage})` : ''}` }));
      const pick = await this.chooseOption(pid, opts, `Choose one of ${defender.name}'s attacks to use`);
      use = defender.def.attacks.find(a => a.name === pick);
      this.log(`${mon.name} copies ${use.name}.`);
    }
    const ctx = this.attackContext(pid, mon, use);
    const boomerang = this.liveEnergy(mon, 'Boomerang Energy');
    await this.runAttack(ctx);
    // Boomerang Energy discarded by this Pokémon's own attack comes back after attacking
    for (const c of boomerang) if (mon.stack.length && p.discard.includes(c)) { p.discard.splice(p.discard.indexOf(c), 1); mon.energy.push(c); this.log(`Boomerang Energy returns to ${mon.name}.`); }
    if (ctx.fans && !this.over) await this.handheldFan(ctx);
    this.festivalSweep();
    await this.checkKOs(ctx);
  }

  attackContext(pid, mon, atk) {
    const g = this;
    const ctx = {
      game: g, pid, opp: g.opp(pid), attacker: mon, atk, defender: g.players[g.opp(pid)].active, dealt: new Map(), extraPrize: new Set(),
      printed: parseInt(atk.damage, 10) || 0,
      damage(n, opts = {}) { return ctx.defender ? g.attackDamage(ctx, ctx.defender, n, opts) : 0; },
      damageTo(m, n, opts = {}) { return g.attackDamage(ctx, m, n, opts); },
      condition(cond) { return ctx.defender ? g.setCondition(ctx.defender, cond, ctx) : false; },
      effect(kind, extra = {}) { g.addEffect({ kind, turn: g.turn + 1, ...extra }); },
    };
    return ctx;
  }

  async runAttack(ctx) {
    const fx = ATTACKS[ctx.atk.name];
    if (fx && fx.run) return fx.run(ctx);
    let n = ctx.printed;
    if (fx && fx.base) n = await fx.base(ctx);
    if (n > 0) ctx.damage(n, (fx && fx.opts) || {});
    if (fx && fx.after) await fx.after(ctx);
  }

  // damage from an attack: the attacker's modifiers, Weakness and Resistance (Active only), then the defender's
  attackDamage(ctx, target, amount, { noWeakness = false, noResistance = false, ignoreEffects = false } = {}) {
    if (!target || !target.stack.length || amount <= 0) return 0;
    const attacker = ctx.attacker;
    const active = this.isActive(target) && target.owner === ctx.opp;
    let dmg = amount;
    if (active) {
      dmg += this.attackBonus(ctx, attacker, target);
      if (this.hasEffect('charm', { mon: attacker })) dmg -= 20;
      dmg = Math.max(0, dmg);
      if (!noWeakness && this.weaknessOf(target) === attacker.def.type) dmg *= 2;
      if (!noResistance && target.def.resist === attacker.def.type) dmg -= 30;
      if (!ignoreEffects) {
        if (this.hasEffect('protect', { mon: target })) dmg -= 30;
        if (this.hasEffect('dig', { mon: target })) dmg = 0;
        if (this.hasAbility(target, 'Cornerstone Stance') && this.abilitiesOf(attacker).length) dmg = 0;
        dmg = this.damageGuard(target, attacker, dmg);
      }
    } else if (target.owner !== ctx.pid && !ignoreEffects) {
      // Tera Pokémon ex on the Bench take no damage from attacks
      if (this.isTera(target) && target.def.ex) dmg = 0;
      if (this.hasEffect('dig', { mon: target })) dmg = 0;
      // Shaymin's Flower Curtain: Benched Pokémon without a Rule Box take no damage
      if (!this.ruleBox(target.def) && this.anyInPlayHasAbility('Flower Curtain', target.owner)) dmg = 0;
      // Manaphy's Wave Veil: no damage to Benched Pokémon
      if (this.anyInPlayHasAbility('Wave Veil', target.owner)) dmg = 0;
      dmg = this.damageGuard(target, attacker, dmg);
    }
    dmg = Math.max(0, dmg);
    if (!dmg) { if (amount > 0 && active) this.log(`${target.name} takes no damage.`); return 0; }
    // Pikachu ex's Resolute Heart: from full HP it survives with 10
    if (target.damage === 0 && dmg >= this.maxHp(target) && this.hasAbility(target, 'Resolute Heart')) {
      dmg = this.maxHp(target) - 10;
      this.log(`${target.name}'s Resolute Heart keeps it in the fight.`);
    }
    // Annihilape's Durable Body: a coin flip to survive with 10 HP
    if (dmg >= this.hpLeft(target) && this.hasAbility(target, 'Durable Body') && this.flip(`${target.name}'s Durable Body`)) {
      dmg = Math.max(0, this.hpLeft(target) - 10);
      this.log(`${target.name}'s Durable Body keeps it in the fight with 10 HP.`);
    }
    target.damage += dmg;
    ctx.dealt.set(target, (ctx.dealt.get(target) || 0) + dmg);
    this.log(`${target.name} takes ${dmg} damage.`, { type: 'damage' });
    this.event('damage', { mon: target.id, amount: dmg });
    if (dmg > 0 && target.owner === ctx.opp) this.afterDamaged(ctx, target, active);
    return dmg;
  }
  // more damage to the opponent's Active Pokémon, before Weakness and Resistance: the attacker's Tool, Supporters
  attackBonus(ctx, attacker, target) {
    let n = 0;
    const t = this.toolName(attacker);
    const plain = !this.ruleBox(attacker.def);
    if (t === 'Vitality Band') n += 10;
    if (t === 'Defiance Band' && this.prizesLeft(ctx.pid) > this.prizesLeft(ctx.opp)) n += 30;
    if (t === 'Brave Bangle' && plain && target.def.ex) n += 30;
    if (t === 'Binding Mochi' && attacker.poisoned) n += 40;
    if (target.def.ex && this.hasEffect('blackBelt', { pid: ctx.pid })) n += 40;
    if (plain && this.hasEffect('gladion', { pid: ctx.pid })) n += 80;
    // Iron Crown ex's Cobalt Command: +20 for each one in play, on attacks by the other Future Pokémon
    if (attacker.def.future && attacker.name !== 'Iron Crown ex') n += 20 * this.inPlay(ctx.pid).filter(m => this.hasAbility(m, 'Cobalt Command')).length;
    // Premium Power Pro: this turn, {F} Pokémon
    if (attacker.def.type === 'Fighting' && this.hasEffect('premiumPower', { pid: ctx.pid })) n += 30;
    // Cynthia's Roserade's Cheer On to Glory: +30 each, on attacks by Cynthia's Pokémon
    if (/^Cynthia's /.test(attacker.name)) n += 30 * this.inPlay(ctx.pid).filter(m => this.hasAbility(m, 'Cheer On to Glory')).length;
    // Galvantula's Compound Eyes: +50 against an Active Pokémon that has an Ability
    if (this.hasAbility(attacker, 'Compound Eyes') && this.abilitiesOf(target).length) n += 50;
    // Light Ball (on Pikachu ex), Maximum Belt, Kieran: more against Pokémon ex (and V)
    if (target.def.ex && t === 'Light Ball' && attacker.name === 'Pikachu ex') n += 50;
    if (target.def.ex && t === 'Maximum Belt') n += 50;
    if ((target.def.ex || target.def.v) && this.hasEffect('kieran', { pid: ctx.pid })) n += 30;
    // Victini's Victory Cheer: +10 each, on attacks by Evolution {R} Pokémon
    if (attacker.def.type === 'Fire' && attacker.def.stage !== 'Basic') n += 10 * this.inPlay(ctx.pid).filter(m => this.hasAbility(m, 'Victory Cheer')).length;
    // Okidogi's Adrena-Power; Future Booster Energy Capsule on a Future Pokémon
    if (this.adrenaPower(attacker)) n += 100;
    if (t === 'Future Booster Energy Capsule' && attacker.def.future) n += 20;
    if (/^Hop's /.test(attacker.name)) {
      // Hop's Snorlax's Extra Helpings (doesn't stack), Hop's Choice Band, Postwick
      if (this.anyInPlayHasAbility('Extra Helpings', ctx.pid)) n += 30;
      if (t === "Hop's Choice Band") n += 30;
      if (this.stadiumName() === 'Postwick') n += 30;
    }
    return n;
  }
  // the defender's own protection, after Weakness and Resistance: Crustle's Mysterious Rock Inn, Bouffalant's Curly Wall
  damageGuard(target, attacker, dmg) {
    if (attacker.def.ex && this.hasAbility(target, 'Mysterious Rock Inn')) return 0;
    if (target.def.stage === 'Basic' && target.def.type === 'Colorless' && this.curlyWall(target.owner)) dmg -= 60;
    // Kakuna's Exoskeleton; "takes N less damage during your opponent's next turn" (Iron Feathers, Rolling Iron)
    if (this.hasAbility(target, 'Exoskeleton')) dmg -= 20;
    for (const e of this.effects) if (e.kind === 'guard' && e.turn === this.turn && e.mon === target.id) dmg -= e.n;
    // Terapagos ex's Crown Opal: no damage from Basic non-{C} Pokémon during the opponent's next turn
    if (attacker.def.stage === 'Basic' && attacker.def.type !== 'Colorless' && this.hasEffect('crownOpal', { mon: target })) return 0;
    // Mega Diancie ex's Diamond Coat; Defiance Vest (while behind on Prizes); Sacred Charm (attackers with an Ability)
    if (this.hasAbility(target, 'Diamond Coat')) dmg -= 30;
    const t = this.toolName(target);
    if (t === 'Defiance Vest' && this.prizesLeft(target.owner) > this.prizesLeft(attacker.owner)) dmg -= 40;
    if (t === 'Sacred Charm' && this.abilitiesOf(attacker).length) dmg -= 30;
    return Math.max(0, dmg);
  }
  curlyWall(pid) { const bs = this.inPlay(pid).filter(m => m.name === 'Bouffalant'); return bs.length >= 2 && bs.some(m => this.hasAbility(m, 'Curly Wall')); }
  // the opponent's Pokémon was damaged by this attack: Lucky Helmet, Spiky Energy, Ready to Ram (once per attack)
  afterDamaged(ctx, target, active) {
    ctx.hit = ctx.hit || new Set();
    if (ctx.hit.has(target)) return;
    ctx.hit.add(target);
    const owner = target.owner, attacker = ctx.attacker;
    if (active && this.toolName(target) === 'Lucky Helmet') {
      const got = this.draw(owner, 2);
      this.log(`Lucky Helmet: ${this.players[owner].name} draws ${got.length} card${got.length === 1 ? '' : 's'}.`, { pid: owner });
    }
    const spiky = active ? this.liveEnergy(target, 'Spiky Energy').length : 0;
    if (spiky && attacker.stack.length && this.addCounters(attacker, 2 * spiky)) this.log(`Spiky Energy puts ${2 * spiky} damage counters on ${attacker.name}.`);
    if (this.hasEffect('readyToRam', { mon: target }) && attacker.stack.length && this.addCounters(attacker, 6, { ctx: { pid: owner } })) this.log(`Ready to Ram puts 6 damage counters on ${attacker.name}.`);
    // Handheld Fan: an Energy moves from the attacker to one of its owner's Benched Pokémon once the attack is done
    if (active && this.toolName(target) === 'Handheld Fan') (ctx.fans = ctx.fans || []).push(target);
  }
  async handheldFan(ctx) {
    const attacker = ctx.attacker, p = this.players[ctx.pid];
    for (const holder of ctx.fans) {
      if (!attacker.stack.length || !attacker.energy.length || !p.bench.length) return;
      const owner = holder.owner;
      const [c] = await this.chooseCards(owner, attacker.energy, { min: 1, max: 1, prompt: `Handheld Fan: move which Energy from ${attacker.name} to one of your opponent's Benched Pokémon?`, from: 'energy', hint: 'opp-discard' });
      const to = c && await this.chooseOneMon(owner, p.bench, `Handheld Fan: move ${c.name} to which of your opponent's Benched Pokémon?`, 'opp-energy-to');
      if (!c || !to) continue;
      this.removeFromZones(c);
      to.energy.push(c);
      this.log(`Handheld Fan moves ${c.name} from ${attacker.name} to ${to.name}.`);
    }
  }

  // ------------------------------------------------------------ Knock Outs and Prizes
  async checkKOs(ctx = null) {
    for (let loop = 0; loop < 6; loop++) {
      const kos = [];
      for (const p of this.players) for (const m of this.inPlay(p.id)) if (m.stack.length && m.damage >= this.maxHp(m)) kos.push(m);
      if (!kos.length) break;
      const prizes = [0, 0];
      for (const m of kos) {
        const owner = m.owner, taker = this.opp(owner);
        let n = this.prizeValue(m);
        const byAttack = ctx && ctx.dealt.has(m) && owner === ctx.opp;
        if (byAttack && this.toolName(m) === 'Luxurious Cape' && !this.ruleBox(m.def)) n += 1;
        if (byAttack && ctx.extraPrize.has(m)) n += 1;
        if (byAttack && this.players[ctx.pid].briar && this.isActive(m) && this.isTera(ctx.attacker)) n += 1;
        // Lillie's Pearl on a Lillie's Pokémon: one fewer Prize card
        if (byAttack && this.toolName(m) === "Lillie's Pearl" && /^Lillie's /.test(m.name)) {
          n = Math.max(0, n - 1);
          this.log(`Lillie's Pearl: ${this.players[taker].name} takes 1 fewer Prize card.`);
        }
        // Legacy Energy: one fewer Prize card, once per game
        if (byAttack && !this.players[owner].legacyUsed && this.liveEnergy(m, 'Legacy Energy').length) {
          n = Math.max(0, n - 1);
          this.players[owner].legacyUsed = true;
          this.log(`Legacy Energy: ${this.players[taker].name} takes 1 fewer Prize card.`);
        }
        this.log(`${m.name} is Knocked Out!`, { type: 'ko', pid: owner });
        this.event('ko', { mon: m.id, name: m.name, pid: owner });
        if (this.current !== owner) this.players[owner].koTurn = this.turn;
        const log = this.players[owner].koLog;
        log.push({ turn: this.turn, name: m.name, byAttack: !!byAttack });
        if (log.length > 12) log.shift();
        this.removeMon(m);
        prizes[taker] += n;
      }
      for (const pid of [this.current, this.opp(this.current)]) if (prizes[pid]) await this.takePrizes(pid, prizes[pid]);
      const won = this.players.filter(p => !p.prizes.length && prizes[p.id]);
      if (won.length === 2) return this.endGame(null, 'Both players took their last Prize card');
      if (won.length === 1) return this.endGame(won[0].id, `${won[0].name} took all of their Prize cards`);
      // new Active Pokémon (the player whose turn it is chooses first)
      const empty = this.players.filter(p => !p.active);
      const lost = empty.filter(p => !p.bench.length);
      if (lost.length === 2) return this.endGame(null, 'Neither player has a Pokémon left');
      if (lost.length === 1) return this.endGame(this.opp(lost[0].id), `${lost[0].name} has no Pokémon left in play`);
      for (const pid of [this.current, this.opp(this.current)]) if (!this.players[pid].active) await this.promote(pid);
      if (this.over) return;
      ctx = null;
    }
    await this.ensureActives();
    await this.enforceBenchLimits();
  }

  // a Pokémon left the Active Spot without a Knock Out (Tuck Tail, Professor Turo's Scenario...): fill it, or lose
  async ensureActives() {
    if (this.over) return;
    const empty = this.players.filter(p => !p.active);
    const lost = empty.filter(p => !p.bench.length);
    if (lost.length === 2) return this.endGame(null, 'Neither player has a Pokémon left');
    if (lost.length === 1) return this.endGame(this.opp(lost[0].id), `${lost[0].name} has no Pokémon left in play`);
    for (const pid of [this.current, this.opp(this.current)]) if (!this.players[pid].active) await this.promote(pid);
  }

  // a Bench over the limit (Area Zero Underdepths gone, or the last Tera Pokémon gone) is trimmed back to 5
  async enforceBenchLimits() {
    for (const pid of [this.current, this.opp(this.current)]) if (this.players[pid].bench.length > this.benchLimit(pid)) await this.trimBench(pid);
  }

  async takePrizes(pid, n) {
    const p = this.players[pid];
    const k = Math.min(n, p.prizes.length);
    if (!k) return;
    // Prize cards are face down: which ones you take is a blind pick, so take them from the top
    const got = p.prizes.splice(0, k);
    p.hand.push(...got);
    this.log(`${p.name} takes ${k} Prize card${k > 1 ? 's' : ''} (${p.prizes.length} left).`, { type: 'prize', pid });
    this.event('prize', { pid, n: k });
  }

  endGame(winner, reason) {
    if (this.over) return;
    this.over = true;
    this.winner = winner;
    this.result = reason;
    this.log(winner == null ? `The game is a draw: ${reason}.` : `${this.players[winner].name} wins! ${reason}.`, { type: 'end' });
    this.notify();
    const e = new Error('game over'); e.gameOver = true; throw e;
  }

  // ------------------------------------------------------------ end of turn and the Pokémon Checkup
  async endTurn(pid) {
    const p = this.players[pid];
    // Technical Machines are discarded at the end of the turn (unless Jamming Tower switches Tools off)
    for (const m of this.inPlay(pid)) if (/^Technical Machine/.test(this.toolName(m) || '')) { this.log(`${m.tool.name} is discarded.`); this.discard(m.tool); }
    p.briar = false;
    // Ignition Energy attached to this player's Pokémon is discarded at the end of their turn
    for (const m of this.inPlay(pid)) for (const c of this.liveEnergy(m, 'Ignition Energy')) { this.discard(c); this.log(`Ignition Energy is discarded from ${m.name}.`); }
    // Powerglass: the Active Pokémon may get a Basic Energy from the discard pile
    const a = p.active;
    if (a && this.toolName(a) === 'Powerglass' && p.discard.some(c => c.def.cat === 'E' && c.def.energy === 'Basic')
      && await this.confirm(pid, `Powerglass: attach a Basic Energy card from your discard pile to ${a.name}?`, 'powerglass')) {
      const [c] = await this.chooseCards(pid, p.discard.filter(x => x.def.cat === 'E' && x.def.energy === 'Basic'), { min: 1, max: 1, prompt: `Attach which Basic Energy to ${a.name}?`, from: 'discard', hint: 'attach' });
      if (c && a.stack.length) await this.attachEnergy(pid, a, c);
    }
    this.festivalSweep();
    // checkup: both Active Pokémon
    for (const q of [this.players[pid], this.players[this.opp(pid)]]) {
      const m = q.active;
      if (!m) continue;
      if (m.poisoned) {
        // Pecharunt's Toxic Subjugation (the opponent's Active Pokémon): 5 more damage counters
        const o = this.players[this.opp(q.id)].active;
        const more = o && this.hasAbility(o, 'Toxic Subjugation') ? 5 : 0;
        this.addCounters(m, 1 + more);
        this.log(`${m.name} takes ${10 + 10 * more} poison damage.`);
      }
      if (m.burned) { this.addCounters(m, 2); this.log(`${m.name} takes 20 burn damage.`); if (this.flip(`${m.name} is Burned`)) { m.burned = false; this.log(`${m.name} is no longer Burned.`); } }
      if (m.special === 'asleep' && this.flip(`${m.name} is Asleep`)) { m.special = null; this.log(`${m.name} wakes up.`); }
      if (m.special === 'paralyzed' && q.id === pid) { m.special = null; this.log(`${m.name} is no longer Paralyzed.`); }
    }
    // Froslass's Freezing Shroud: 1 damage counter on each Pokémon with an Ability (except Froslass), per Froslass
    for (const q of this.players) for (const f of this.inPlay(q.id)) {
      if (!this.hasAbility(f, 'Freezing Shroud')) continue;
      for (const r of this.players) for (const m of this.inPlay(r.id)) {
        if (m.name === 'Froslass' || !this.abilitiesOf(m).length || this.abilityBlocked(q.id, m)) continue;
        this.addCounters(m, 1);
        this.log(`Freezing Shroud puts 1 damage counter on ${m.name}.`);
      }
    }
    await this.checkKOs();
    this.notify();
    await sleep0();
  }
}
