// Pokémon TCG rules engine: setup and mulligans, turns, the once-per-turn actions, evolution, retreat, attacks with
// Weakness and Resistance, special conditions and the Pokémon Checkup, Knock Outs and Prizes, and the ways to win.
// Like the Commander engine it is deterministic for a seed and the answers its agents give (agent.ask(game, pid, req)),
// so every browser in an online game can run the same game.
import { RNG } from '../engine/util.js';
import { ATTACKS, ABILITIES, TRAINERS } from './cards.js';

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
    this.used = {};               // ability name -> turn used
  }
  get card() { return this.stack[this.stack.length - 1]; }
  get def() { return this.card.def; }
  get owner() { return this.card.owner; }
  get name() { return this.def.name; }
  allCards() { return [...this.stack, ...this.energy, ...(this.tool ? [this.tool] : [])]; }
}

const sleep0 = () => Promise.resolve();

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
    this.agents = players.map(p => p.agent);
    this.players = players.map((p, i) => {
      const deck = [];
      for (const [key, n] of p.deck.cards) for (let k = 0; k < n; k++) deck.push(new PCard(db[key], i, this.uid++));
      return {
        id: i, name: p.name, deckId: p.deck.id, deckName: p.deck.name, human: !!p.human,
        deck, hand: [], discard: [], lost: [], prizes: [], active: null, bench: [],
        turns: 0, supporter: false, energyDone: false, retreated: false, stadiumDone: false,
        once: {}, koTurn: -99, mulligans: 0, inPlay: null,
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
  prizeValue(mon) { return mon.def.mega ? 3 : this.ruleBox(mon.def) ? 2 : 1; }
  isTera(mon) { return !!mon.def.tera; }
  typeOf(mon) { return mon.def.type; }
  prizesLeft(pid) { return this.players[pid].prizes.length; }
  prizesTaken(pid) { return 6 - this.players[pid].prizes.length; }
  maxHp(mon) {
    let hp = mon.def.hp;
    const t = mon.tool && mon.tool.name;
    const basic = mon.def.stage === 'Basic';
    if (t === 'Bravery Charm' && basic) hp += 50;
    if (t === 'Luxurious Cape' && !this.ruleBox(mon.def)) hp += 100;
    if (t === 'Ancient Booster Energy Capsule' && mon.def.ancient) hp += 60;
    if (this.stadium && this.stadium.card.name === 'Lively Stadium' && basic) hp += 30;
    return hp;
  }
  hpLeft(mon) { return this.maxHp(mon) - mon.damage; }
  counters(mon) { return Math.floor(mon.damage / 10); }
  hasEffect(kind, { mon, pid } = {}) { return this.effects.some(e => e.kind === kind && e.turn === this.turn && (mon == null || e.mon === mon.id) && (pid == null || e.pid === pid)); }
  addEffect(e) { this.effects.push(e); }
  stadiumName() { return this.stadium ? this.stadium.card.name : null; }

  // abilities: printed, and not switched off by Team Rocket's Watchtower or (for self-KO abilities) Psyduck's Damp
  abilitiesOf(mon) {
    if (this.stadiumName() === "Team Rocket's Watchtower" && mon.def.type === 'Colorless') return [];
    return mon.def.abilities || [];
  }
  hasAbility(mon, name) { return this.abilitiesOf(mon).some(a => a.name === name); }
  anyInPlayHasAbility(name, pid = null) { return this.players.some(p => (pid == null || p.id === pid) && this.inPlay(p.id).some(m => this.hasAbility(m, name))); }
  dampActive() { return this.anyInPlayHasAbility('Damp'); }

  weaknessOf(mon) {
    // Lillie's Clefairy ex: the opponent's Dragon Pokémon are weak to Psychic
    if (mon.def.type === 'Dragon' && this.anyInPlayHasAbility('Fairy Zone', this.opp(mon.owner))) return 'Psychic';
    return mon.def.weak;
  }
  // the Energy a Pokémon has, as types; Special Energy provides Colorless here
  energyTypes(mon) { return mon.energy.map(c => c.def.provides || 'Colorless'); }
  retreatCost(mon) {
    const p = mon.owner;
    if (mon.def.stage === 'Basic' && this.anyInPlayHasAbility('Skyliner', p)) return 0;
    if (this.hasAbility(mon, 'Agile') && !mon.energy.length) return 0;
    let n = mon.def.retreat;
    const t = mon.tool && mon.tool.name;
    if (t === 'Air Balloon') n -= 2;
    if (t === 'Rescue Board') { if (this.hpLeft(mon) <= 30) return 0; n -= 1; }
    return Math.max(0, n);
  }
  // attack costs after reductions, as a list of types
  attackCost(mon, atk) {
    let cost = [...atk.cost];
    if (this.hasAbility(mon, 'Lost Provisions') && this.players[mon.owner].lost.length >= 4) return [];
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
      for (const t of typed) { const i = pool.indexOf(t); if (i < 0) return false; pool.splice(i, 1); }
      return pool.length >= c.length - typed.length;
    };
    if (!minus) return tryPay(cost);
    // Sparkling Crystal: one Energy less, of any type
    for (let i = 0; i < cost.length; i++) { const c = cost.slice(0, i).concat(cost.slice(i + 1)); if (tryPay(c)) return true; }
    return tryPay(cost);
  }
  costMinus(mon) { return mon.tool && mon.tool.name === 'Sparkling Crystal' && this.isTera(mon) ? 1 : 0; }

  // every attack a Pokémon can use: printed, from a Technical Machine, or copied by Genome Hacking
  attacksOf(mon) {
    const out = (mon.def.attacks || []).map(a => ({ ...a, src: 'own' }));
    if (mon.tool && mon.tool.def.attacks) for (const a of mon.tool.def.attacks) out.push({ ...a, src: 'tm' });
    return out;
  }
  attackBlock(mon, atk) {
    const pid = mon.owner;
    const p = this.players[pid];
    if (this.turn === 1 && pid === this.first) return 'No attacks on the first turn of the game';
    if (!this.isActive(mon)) return 'Only your Active Pokémon can attack';
    if (mon.special === 'asleep' || mon.special === 'paralyzed') return `${mon.name} is ${mon.special}`;
    if (this.hasEffect('cantAttack', { mon })) return `${mon.name} can't attack this turn`;
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
    p.supporter = false; p.energyDone = false; p.retreated = false; p.stadiumDone = false; p.briar = false;
    this.effects = this.effects.filter(e => e.turn >= this.turn);
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
      if (!act || act.t === 'end') break;
      if (act.t === 'attack') { await this.attack(pid, act); break; }
      await this.doAction(pid, act);
      await this.checkKOs();
      if (this.over) return;
    }
    if (this.over) return;
    await this.endTurn(pid);
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
    const itemLock = this.hasEffect('itemLock', { pid });
    for (const c of p.hand) {
      const d = c.def;
      if (d.cat === 'P' && d.stage === 'Basic' && p.bench.length < this.benchLimit(pid)) out.push({ t: 'bench', card: c.id });
      if (d.cat === 'P' && d.stage !== 'Basic' && !firstTurn) {
        for (const m of mons) if (m.name === d.from && m.playedTurn !== this.turn && m.evolvedTurn !== this.turn) out.push({ t: 'evolve', card: c.id, target: m.id });
      }
      if (d.cat === 'E' && !p.energyDone) for (const m of mons) out.push({ t: 'energy', card: c.id, target: m.id });
      if (d.cat === 'T') {
        const fx = TRAINERS[d.name] || {};
        if (d.trainer === 'Tool') {
          if (itemLock) continue;
          for (const m of mons) if (!m.tool && (!fx.canAttach || fx.canAttach(g, m))) out.push({ t: 'tool', card: c.id, target: m.id });
          continue;
        }
        if (d.trainer === 'Supporter') {
          if (p.supporter) continue;
          if (this.turn === 1 && pid === this.first && d.name !== 'Carmine') continue;
        }
        if (d.trainer === 'Item' && itemLock) continue;
        if (d.trainer === 'Stadium' && (p.stadiumDone || (this.stadium && this.stadium.card.name === d.name))) continue;
        if (fx.can && !fx.can(g, pid, c)) continue;
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
        out.push({ t: 'ability', mon: m.id, name: a.name });
      }
    }
    // stadium actions (Artazon, Surfing Beach, Mystery Garden, Academy at Night)
    if (this.stadium) {
      const fx = TRAINERS[this.stadium.card.name];
      if (fx && fx.stadiumUse && !(p.once['stadium'] === this.turn) && (!fx.stadiumCan || fx.stadiumCan(g, pid))) out.push({ t: 'stadium', name: this.stadium.card.name });
    }
    // retreat
    const a = p.active;
    if (a && p.bench.length && !p.retreated && a.special !== 'asleep' && a.special !== 'paralyzed' && !this.hasEffect('cantRetreat', { mon: a }) && a.energy.length >= this.retreatCost(a)) {
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
      case 'trainer': await this.playTrainer(pid, card); break;
      case 'ability': {
        const m = this.monById(act.mon);
        const fx = ABILITIES[act.name];
        this.log(`${p.name} uses ${m.name}'s ${act.name}.`, { pid, type: 'ability' });
        this.event('ability', { mon: m.id, name: act.name });
        m.used[act.name] = this.turn;
        if (fx.oncePerPlayer) p.once[act.name] = this.turn;
        await fx.use(this, m, pid);
        break;
      }
      case 'stadium': {
        const fx = TRAINERS[act.name];
        p.once['stadium'] = this.turn;
        this.log(`${p.name} uses ${act.name}.`, { pid });
        await fx.stadiumUse(this, pid);
        break;
      }
      case 'retreat': {
        const a = p.active;
        const to = this.monById(act.to);
        const n = this.retreatCost(a);
        if (n > 0) {
          const pay = await this.chooseCards(pid, a.energy, { min: n, max: n, prompt: `Discard ${n} Energy to retreat ${a.name}`, from: 'energy', hint: 'retreat-cost' });
          for (const c of pay) this.discard(c);
        }
        p.retreated = true;
        this.log(`${p.name} retreats ${a.name}${to ? ` and sends out ${to.name}` : ''}.`, { pid });
        this.switchActive(pid, to);
        break;
      }
    }
    this.notify();
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
      if (fx && fx.onBench && (!fx.can || fx.can(this, m, pid))) {
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
      if (fx && fx.onEvolve && (!fx.can || fx.can(this, mon, pid))) {
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
    if (fromHand && card.name === 'Jet Energy' && !this.isActive(mon) && this.players[pid].active) {
      this.log(`Jet Energy switches ${mon.name} into the Active Spot.`);
      this.switchActive(pid, mon);
    }
  }

  async playTrainer(pid, card) {
    const p = this.players[pid];
    const d = card.def;
    const fx = TRAINERS[d.name] || {};
    p.hand.splice(p.hand.indexOf(card), 1);
    if (d.trainer === 'Supporter') p.supporter = true;
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
  }

  clearConditions(mon) { mon.special = null; mon.poisoned = false; mon.burned = false; }
  // special conditions: Ancient Booster Energy Capsule, Flare Veil and Dig keep them off
  setCondition(mon, cond, ctx = null) {
    if (mon.tool && mon.tool.name === 'Ancient Booster Energy Capsule' && mon.def.ancient) return false;
    if (ctx && this.effectsBlocked(ctx, mon)) return false;
    if (cond === 'poisoned') mon.poisoned = true;
    else if (cond === 'burned') mon.burned = true;
    else mon.special = cond;
    this.log(`${mon.name} is now ${cond === 'poisoned' ? 'Poisoned' : cond === 'burned' ? 'Burned' : cond[0].toUpperCase() + cond.slice(1)}.`);
    this.event('condition', { mon: mon.id, cond });
    return true;
  }
  // effects of an opponent's attack can be stopped (Charmeleon's Flare Veil, Dunsparce's Dig)
  effectsBlocked(ctx, mon) {
    if (!ctx || mon.owner === ctx.pid) return false;
    if (this.hasAbility(mon, 'Flare Veil')) return true;
    if (this.hasEffect('dig', { mon })) return true;
    return false;
  }

  addCounters(mon, n, { ctx = null } = {}) {
    if (n <= 0 || !mon.stack.length) return 0;
    if (ctx && this.effectsBlocked(ctx, mon)) return 0;
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
    await this.runAttack(ctx);
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
      const t = attacker.tool && attacker.tool.name;
      if (t === 'Vitality Band') dmg += 10;
      if (t === 'Defiance Band' && this.prizesLeft(ctx.pid) > this.prizesLeft(ctx.opp)) dmg += 30;
      if (this.hasEffect('charm', { mon: attacker })) dmg -= 20;
      dmg = Math.max(0, dmg);
      if (!noWeakness && this.weaknessOf(target) === attacker.def.type) dmg *= 2;
      if (!noResistance && target.def.resist === attacker.def.type) dmg -= 30;
      if (!ignoreEffects) {
        if (this.hasEffect('protect', { mon: target })) dmg -= 30;
        if (this.hasEffect('dig', { mon: target })) dmg = 0;
        if (this.hasAbility(target, 'Cornerstone Stance') && this.abilitiesOf(attacker).length) dmg = 0;
      }
    } else if (target.owner !== ctx.pid) {
      // Tera Pokémon ex on the Bench take no damage from attacks
      if (this.isTera(target) && target.def.ex) dmg = 0;
      if (this.hasEffect('dig', { mon: target })) dmg = 0;
    }
    dmg = Math.max(0, dmg);
    if (!dmg) { if (amount > 0 && active) this.log(`${target.name} takes no damage.`); return 0; }
    // Pikachu ex's Resolute Heart: from full HP it survives with 10
    if (target.damage === 0 && dmg >= this.maxHp(target) && this.hasAbility(target, 'Resolute Heart')) {
      dmg = this.maxHp(target) - 10;
      this.log(`${target.name}'s Resolute Heart keeps it in the fight.`);
    }
    target.damage += dmg;
    ctx.dealt.set(target, (ctx.dealt.get(target) || 0) + dmg);
    this.log(`${target.name} takes ${dmg} damage.`, { type: 'damage' });
    this.event('damage', { mon: target.id, amount: dmg });
    return dmg;
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
        if (byAttack && m.tool && m.tool.name === 'Luxurious Cape' && !this.ruleBox(m.def)) n += 1;
        if (byAttack && ctx.extraPrize.has(m)) n += 1;
        if (byAttack && this.players[ctx.pid].briar && this.isActive(m) && this.isTera(ctx.attacker)) n += 1;
        this.log(`${m.name} is Knocked Out!`, { type: 'ko', pid: owner });
        this.event('ko', { mon: m.id, name: m.name, pid: owner });
        if (this.current !== owner) this.players[owner].koTurn = this.turn;
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
    // Technical Machines are discarded at the end of the turn they were used on
    for (const m of this.inPlay(pid)) if (m.tool && /^Technical Machine/.test(m.tool.name)) { this.log(`${m.tool.name} is discarded.`); this.discard(m.tool); }
    p.briar = false;
    // checkup: both Active Pokémon
    for (const q of [this.players[pid], this.players[this.opp(pid)]]) {
      const m = q.active;
      if (!m) continue;
      if (m.poisoned) { this.addCounters(m, 1); this.log(`${m.name} takes 10 poison damage.`); }
      if (m.burned) { this.addCounters(m, 2); this.log(`${m.name} takes 20 burn damage.`); if (this.flip(`${m.name} is Burned`)) { m.burned = false; this.log(`${m.name} is no longer Burned.`); } }
      if (m.special === 'asleep' && this.flip(`${m.name} is Asleep`)) { m.special = null; this.log(`${m.name} wakes up.`); }
      if (m.special === 'paralyzed' && q.id === pid) { m.special = null; this.log(`${m.name} is no longer Paralyzed.`); }
    }
    await this.checkKOs();
    this.notify();
    await sleep0();
  }
}
