// One Piece Card Game rules engine, following the official Comprehensive Rules (v1.2.1, 2026-08-28): setup and the
// redraw, the five phases of a turn, DON!! (costs, giving, DON!! −X), playing Characters, Events and Stages, battles
// (Attack, Block, Counter and Damage Steps), Life and [Trigger], K.O., keywords, effect timing and durations, and
// rule processing (defeat). Rule numbers in comments refer to that document. The interface is described in API.md.
//
// Like the Pokémon engine it is deterministic for a seed and the answers its agents give (agent.ask(game, pid, req)),
// so every browser in an online game runs the same game. Card effects come from the card text, compiled by text.js
// (with hand-written overrides in cards.js); this file interprets them.
import { RNG } from '../engine/util.js';
import { compileCard } from './cards.js';

export const COLORS = ['Red', 'Green', 'Blue', 'Purple', 'Black', 'Yellow'];
export const KEYWORDS = ['Rush', 'Rush: Character', 'Blocker', 'Double Attack', 'Banish', 'Unblockable'];
const FIELD = new Set(['leader', 'characters', 'stage']);
// card questions about these areas show the player cards they couldn't see before
const HIDDEN_ZONES = new Set(['deck', 'life', 'opp-hand']);

// Everything this interpreter understands. tools/optcg/coverage.mjs checks every compiled card against these lists,
// so a card whose compiled text uses something not handled here fails the check instead of misbehaving in a game.
export const HANDLED = {
  timings: ['onPlay', 'whenAttacking', 'onOppAttack', 'onBlock', 'ko', 'endOfYourTurn', 'endOfOppTurn', 'startOfTurn', 'startOfMain',
    'startOfGame', 'endOfBattle', 'battling', 'charKO', 'charPlayed', 'blockerActivated', 'donReturned', 'eventActivated', 'rested',
    'handTrashed', 'lifeToHand'],
  when: ['self', 'who', 'byEffect', 'byYou', 'byOpp', 'sel', 'minN', 'withChar', 'battleSel', 'srcSel'],
  steps: ['select', 'power', 'basePower', 'cost', 'ko', 'rest', 'setActive', 'giveDon', 'donActive', 'restDon', 'addDon', 'draw',
    'discard', 'bounce', 'bottom', 'grant', 'noBlocker', 'noBlockerIfAttacks', 'restrict', 'playerFlag', 'playSelf', 'selfToHand',
    'runEffect', 'look', 'play', 'toHand', 'deckToLife', 'trashLife', 'lifeToHand', 'handToLife', 'fieldToLife', 'lookLife', 'choose',
    'may', 'reveal', 'delayed', 'custom', 'playThat', 'freeze', 'bounceAny', 'discardAny', 'handToDeck', 'trashField', 'revealedToDeck', 'restDonOrChar', 'lookOppDeck', 'chooseCostReveal', 'mill', 'redirect'],
  costs: ['restDon', 'returnDon', 'returnDonAny', 'restSelf', 'trashSelf', 'trashHand', 'revealHand', 'lifeToHand', 'trashLife',
    'restOwn', 'bounceOwn', 'handToDeck', 'trashToDeck', 'millSelf', 'lifeFaceUp', 'lifeFaceDown', 'charToLife', 'returnGivenDon', 'bounceSelf', 'restLeaderOrDon'],
  conds: ['and', 'or', 'not', 'cmp', 'exists', 'self', 'leader', 'turn', 'did', 'that', 'chosenCost', 'handTrashedThisTurn'],
  filters: ['rested', 'active', 'cost', 'baseCost', 'costRange', 'power', 'basePower', 'trait', 'traitHas', 'name', 'notName', 'notSelf',
    'color', 'multicolor', 'attr', 'kw', 'hasTrigger', 'vanilla', 'cat', 'playedThisTurn', 'battledChar', 'faceUp', 'or', 'not'],
  amounts: ['life', 'lifeTotal', 'hand', 'trash', 'donField', 'donRested', 'restedCards', 'givenDon', 'eventN', 'count', 'per', 'neg', 'var'],
  refs: ['self', 'leader', 'oppLeader', 'selected', 'replaced', 'battleOpp'],
  durations: ['battle', 'turn', 'startOfYourNextTurn', 'endOfYourNextTurn', 'endOfOppNextTurn', 'oppNextRefresh', 'game'],
  // static mods and effect flags something in here reads
  mods: ['power', 'cost', 'grant', 'noKO', 'canAttackActive', 'cantAttack', 'cantAttackChar', 'cantBlock', 'cantRest', 'faceUpLifeToDeck', 'negateOnPlay'],
  playerFlags: ['noKOAll', 'noOwnLifeToHand', 'negateOnPlay'],
  zones: ['field', 'hand', 'trash', 'deck', 'life', 'handOrTrash'],
};

// a physical card: uid (unique in the game, stable), id (the card number), def (its cards.json entry), owner.
// On the field it carries its state. Moving to another area makes it a new card for the rules (3-1-6): `inst`
// changes, so effects on it end, its given DON!! go back to the cost area, and its state is cleared.
export class OCard {
  constructor(def, owner, uid) { this.uid = uid; this.id = def.id; this.def = def; this.owner = owner; this.inst = 0; this.zone = null; this.faceUp = false; this.reset(); }
  reset() { this.rested = false; this.don = 0; this.playedTurn = -1; this.used = {}; }
  get name() { return this.def.name; }
  get cat() { return this.def.cat; }
}

const sleep0 = () => Promise.resolve();
const cards = n => `${n} card${n === 1 ? '' : 's'}`;
const dons = n => `${n} DON!! card${n === 1 ? '' : 's'}`;
const signed = n => `${n >= 0 ? '+' : '−'}${Math.abs(n)}`;
// "You" (each browser names its own player so) reads "Your"
const poss = name => (name === 'You' ? 'Your' : `${name}'s`);

export class OnePieceGame {
  constructor({ db, players, seed = (Date.now() ^ (Math.random() * 1e9)) >>> 0, onUpdate = null, maxTurns = 60 }) {
    this.db = Array.isArray(db) ? Object.fromEntries(db.map(c => [c.id, c])) : db;
    this.seed = seed;
    this.rng = new RNG(seed);
    this.uid = 1;
    this.turn = 0;
    this.current = 0;
    this.first = 0;
    this.phase = 'setup';         // 'setup' | 'refresh' | 'draw' | 'don' | 'main' | 'end'
    this.battle = null;           // the battle in progress, for the table: { attacker, target, step, blocker } (uids)
    this.fight = null;            // the same, for the engine (cards, battle-long boosts)
    this.effects = [];            // continuous effects: { id, kind, card?, inst?, pid, ends, ... }
    this.pending = [];            // auto effects waiting to resolve: { pid, card, inst, ab, kind, data, batch }
    this.batch = 0;
    this.limbo = null;            // a [Trigger] card while its effect resolves (10-1-5-3)
    this.logs = [];
    this.events = [];             // for the table's animations and sounds: { id, kind, at, ... }
    this.over = false;
    this.winner = null;
    this.result = '';
    this.maxTurns = maxTurns;
    this.onUpdate = onUpdate;
    this.version = 0;
    this.pendingAsk = null;
    this.agents = players.map(p => p.agent);
    this.players = players.map((p, i) => {
      const deck = p.deck;
      const leaderDef = this.db[deck.leader];
      if (!leaderDef) throw new Error(`unknown leader ${deck.leader}`);
      const leader = new OCard(leaderDef, i, this.uid++);
      const list = [];
      for (const [key, n] of deck.cards) {
        const d = this.db[key];
        if (!d) throw new Error(`unknown card ${key}`);
        for (let k = 0; k < n; k++) list.push(new OCard(d, i, this.uid++));
      }
      return {
        id: i, name: p.name, deckId: deck.id, deckName: deck.name, human: !!p.human, lost: false,
        leader, characters: [], stage: null, hand: [], deck: list, trash: [], life: [],
        donDeck: 10, donActive: 0, donRested: 0,
        turns: 0, redrew: null, deckOut: false, damagedAtZero: false,
      };
    });
    for (const p of this.players) { p.leader.zone = 'leader'; for (const c of p.deck) c.zone = 'deck'; }
  }

  // ------------------------------------------------------------ plumbing
  touch() { this.version++; }
  notify() { this.version++; if (this.onUpdate) this.onUpdate(this); }
  log(text, opts = {}) { this.logs.push({ text, turn: this.turn, ...opts }); if (this.logs.length > 800) this.logs.splice(0, 100); this.touch(); }
  event(kind, data = {}) { this.events.push({ id: this.uid++, kind, at: this.turn, ...data }); if (this.events.length > 300) this.events.splice(0, 60); }
  opp(pid) { return 1 - pid; }
  pl(pid) { return this.players[pid]; }
  abilities(card) { return compileCard(card.def).abilities; }
  cardByUid(uid) {
    for (const p of this.players) {
      if (p.leader.uid === uid) return p.leader;
      if (p.stage && p.stage.uid === uid) return p.stage;
      for (const z of ['characters', 'hand', 'deck', 'trash', 'life']) { const c = p[z].find(x => x.uid === uid); if (c) return c; }
    }
    if (this.limbo && this.limbo.uid === uid) return this.limbo;
    return null;
  }
  ownerOf(uid) { const c = this.cardByUid(uid); return c ? c.owner : null; }
  field(pid) { const p = this.players[pid]; return [p.leader, ...p.characters, ...(p.stage ? [p.stage] : [])]; }
  fighters(pid) { const p = this.players[pid]; return [p.leader, ...p.characters]; }
  onField(card) { return !!card && FIELD.has(card.zone); }
  // DON!! cards on a player's field: the cost area and those given to cards (3-1-2)
  donOnField(pid) { const p = this.players[pid]; return p.donActive + p.donRested + this.givenDon(pid); }
  givenDon(pid) { return this.fighters(pid).reduce((s, c) => s + c.don, 0); }
  keywords(card) { return new Set(KEYWORDS.filter(k => this.has(card, k))); }
  canAttack(card) { return this.phase === 'main' && !this.fight && card.owner === this.current && this.players[card.owner].turns > 1 && this.attackTargets(card).length > 0; }

  async ask(pid, req) {
    if (this.over) return null;
    this.asked = (this.asked || 0) + 1;
    if (req.type === 'cards' && (req.shown || HIDDEN_ZONES.has(req.from))) this.peeked = (this.peeked || 0) + 1;
    this.pendingAsk = { pid, req };
    this.notify();
    let v;
    try { v = await this.agents[pid].ask(this, pid, req); } finally { this.pendingAsk = null; }
    this.touch();
    return v;
  }

  // ------------------------------------------------------------ choices (validated, with fallbacks)
  // cards: in an area (hand, deck, trash, life) or on the field (from: 'field')
  async chooseCards(pid, list, { min = 0, max = 1, prompt = 'Choose cards', from = 'hand', hint = 'take', shown = null } = {}) {
    if (!list.length || max <= 0) return [];
    min = Math.max(0, Math.min(min, list.length)); max = Math.min(max, list.length);
    const v = await this.ask(pid, { type: 'cards', options: list.map(c => c.uid), min, max, prompt, from, hint, ...(shown ? { shown: shown.map(c => c.uid) } : {}) });
    return this.pickFrom(list, v, min, max);
  }
  chooseOnField(pid, list, { min = 0, max = 1, prompt = 'Choose', hint = '' } = {}) { return this.chooseCards(pid, list, { min, max, prompt, from: 'field', hint }); }
  pickFrom(list, v, min, max) {
    const ids = Array.isArray(v) ? [...new Set(v)] : [];
    let out = ids.map(id => list.find(c => c.uid === id)).filter(Boolean).slice(0, max);
    if (out.length < min) out = out.concat(list.filter(c => !out.includes(c)).slice(0, min - out.length));
    return out;
  }
  async confirm(pid, prompt, hint = '', extra = {}) { return (await this.ask(pid, { type: 'confirm', prompt, hint, ...extra })) === true; }
  async chooseOption(pid, options, prompt, hint = '') {
    if (!options.length) return null;
    if (options.length === 1) return options[0].value;
    const v = await this.ask(pid, { type: 'option', options, prompt, hint });
    return options.some(o => o.value === v) ? v : options[0].value;
  }
  async chooseNumber(pid, min, max, prompt, hint = 'number') {
    if (max <= min) return Math.max(min, max);
    const v = await this.ask(pid, { type: 'number', min, max, prompt, hint });
    const n = Math.floor(+v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : max;
  }
  // the order of several cards (the first one ends up on top)
  async chooseOrder(pid, list, prompt, hint = 'order') {
    if (list.length < 2) return [...list];
    const v = await this.ask(pid, { type: 'order', options: list.map(c => c.uid), prompt, hint });
    const ids = Array.isArray(v) ? [...new Set(v)] : [];
    const out = ids.map(id => list.find(c => c.uid === id)).filter(Boolean);
    for (const c of list) if (!out.includes(c)) out.push(c);
    return out;
  }

  // ------------------------------------------------------------ card movement
  shuffle(pid) { this.rng.shuffle(this.players[pid].deck); this.event('shuffle', { pid }); }
  // take a card out of wherever it is
  detach(card) {
    const p = this.players[card.owner];
    switch (card.zone) {
      case 'characters': p.characters.splice(p.characters.indexOf(card), 1); break;
      case 'stage': if (p.stage === card) p.stage = null; break;
      case 'hand': case 'deck': case 'trash': case 'life': { const i = p[card.zone].indexOf(card); if (i >= 0) p[card.zone].splice(i, 1); break; }
      case 'limbo': if (this.limbo === card) this.limbo = null; break;
    }
  }
  // move a card to one of its owner's areas (cards always go to their owner's areas). Leaving the field, given DON!!
  // go to the cost area rested (6-5-5-4) and it becomes a new card (3-1-6). Leaders never move (3-6-3).
  moveCard(card, to, { top = true, faceUp = false, rested = false } = {}) {
    if (card.cat === 'L') return false;
    const p = this.players[card.owner];
    const from = card.zone;
    this.detach(card);
    if (FIELD.has(from) && card.don) { p.donRested += card.don; this.event('don', { pid: card.owner, n: card.don, kind: 'unattach', from: card.uid }); }
    card.reset();
    card.inst = this.uid++;
    card.faceUp = to === 'life' ? faceUp : false;
    if (to === 'characters') { p.characters.push(card); card.rested = rested; card.playedTurn = this.turn; }
    else if (to === 'stage') { p.stage = card; card.rested = rested; card.playedTurn = this.turn; }
    else if (to === 'deck' || to === 'life') { if (top) p[to].unshift(card); else p[to].push(card); }
    else if (to === 'limbo') this.limbo = card;
    else p[to].push(card);
    card.zone = to;
    if (from === 'deck') this.checkDeck(card.owner);
    return true;
  }
  draw(pid, n = 1, { quiet = false } = {}) {
    const p = this.players[pid];
    let got = 0;
    for (let k = 0; k < n && p.deck.length; k++) {
      const c = p.deck.shift(); p.hand.push(c); c.zone = 'hand'; c.inst = this.uid++; got++;
      // 0 cards in the deck is a defeat condition, checked at once (9-1-2, 9-2-1-2)
      this.checkDeck(pid);
    }
    if (got) { this.event('draw', { pid, n: got }); if (!quiet) this.log(`${p.name} draws ${cards(got)}.`, { pid }); }
    return got;
  }
  checkDeck(pid) {
    if (this.phase === 'setup') return;
    if (!this.players[pid].deck.length) { this.players[pid].deckOut = true; this.ruleCheck(); }
  }

  // ------------------------------------------------------------ rule processing (9)
  ruleCheck() {
    if (this.over) return;
    const losers = this.players.filter(p => p.deckOut || p.damagedAtZero);
    if (!losers.length) return;
    // 9-2-1: every player who meets a defeat condition loses
    for (const p of losers) p.lost = true;
    if (losers.length === 2) return this.endGame(null, 'Both players met a defeat condition at the same time');
    const l = losers[0];
    this.endGame(this.opp(l.id), l.damagedAtZero ? `${poss(l.name)} Leader took damage with no Life cards left` : `${l.name === 'You' ? 'You have' : `${l.name} has`} no cards left in ${l.name === 'You' ? 'your' : 'their'} deck`);
  }
  endGame(winner, reason) {
    if (this.over) return;
    this.over = true;
    this.winner = winner;
    this.result = reason;
    if (winner != null) this.players[this.opp(winner)].lost = true;
    this.log(winner == null ? `The game is a draw: ${reason}.` : `${this.players[winner].name} wins! ${reason}.`, { type: 'end' });
    this.event('end', { winner });
    this.notify();
    const e = new Error('game over'); e.gameOver = true; throw e;
  }

  // ------------------------------------------------------------ DON!!
  addDon(pid, n, { rested = false } = {}) {
    const p = this.players[pid];
    const k = Math.min(n, p.donDeck);
    if (k <= 0) return 0;
    p.donDeck -= k;
    if (rested) p.donRested += k; else p.donActive += k;
    this.event('don', { pid, n: k, kind: rested ? 'add-rested' : 'add' });
    return k;
  }
  // pay a cost of N: rest N active DON!! in the cost area (2-7-2)
  payDon(pid, n) {
    const p = this.players[pid];
    if (n <= 0) return true;
    if (p.donActive < n) return false;
    p.donActive -= n; p.donRested += n;
    this.event('don', { pid, n, kind: 'rest' });
    return true;
  }
  // DON!! −X: return X DON!! cards from the field (the cost area, or given ones) to the DON!! deck (8-3-1-6), the
  // player choosing which, one at a time
  async returnDon(pid, n) {
    const p = this.players[pid];
    if (this.donOnField(pid) < n) return false;
    if (n <= 0) return true;
    for (let k = 0; k < n; k++) {
      const opts = [];
      if (p.donRested) opts.push({ value: 'rested', label: 'A rested DON!! card in your cost area' });
      if (p.donActive) opts.push({ value: 'active', label: 'An active DON!! card in your cost area' });
      for (const c of this.fighters(pid)) if (c.don) opts.push({ value: c.uid, label: `A DON!! card given to ${c.name}` });
      const v = await this.chooseOption(pid, opts, `DON!! −${n}: return which DON!! card to your DON!! deck? (${n - k} left)`, 'don-return');
      if (v === 'rested') p.donRested--; else if (v === 'active') p.donActive--; else { const c = this.cardByUid(v); c.don--; }
      p.donDeck++;
    }
    this.log(`${p.name} returns ${dons(n)} to their DON!! deck.`, { pid });
    this.event('don', { pid, n, kind: 'return' });
    this.fire('donReturned', { pid, n });
    return true;
  }
  // give DON!! cards from the cost area (active ones, or rested ones for effects) to a Leader or Character (6-5-5)
  giveDon(pid, card, n = 1, { rested = false } = {}) {
    const p = this.players[pid];
    const k = Math.min(n, rested ? p.donRested : p.donActive);
    if (k <= 0 || !this.onField(card) || card.cat === 'S' || card.owner !== pid) return 0;
    if (rested) p.donRested -= k; else p.donActive -= k;
    card.don += k;
    this.event('give', { pid, target: card.uid, n: k });
    return k;
  }

  // ------------------------------------------------------------ continuous effects and their durations
  nextTurnOf(pid) { return this.turn + (this.current === pid ? 2 : 1); }
  ends(dur, pid) {
    switch (dur) {
      case 'battle': return { battle: true };
      case 'turn': return { at: 'end', turn: this.turn };
      case 'startOfYourNextTurn': return { at: 'start', turn: this.nextTurnOf(pid) };
      case 'endOfYourNextTurn': return { at: 'end', turn: this.nextTurnOf(pid) };
      case 'endOfOppNextTurn': return { at: 'end', turn: this.nextTurnOf(this.opp(pid)) };
      case 'oppNextRefresh': return { at: 'refresh', turn: this.nextTurnOf(this.opp(pid)) };
      case 'game': return { never: true };
      default: this.unhandled(`duration "${dur}"`); return { at: 'end', turn: this.turn };
    }
  }
  addEffect(e, dur, pid) {
    const fx = { id: this.uid++, pid, ...e, ends: this.ends(dur, pid), dur };
    if (fx.card) fx.inst = fx.card.inst;
    this.effects.push(fx);
    this.touch();
    return fx;
  }
  // effects on a card only last while it stays where it was (3-1-6)
  liveEffects(kind, card = null) {
    return this.effects.filter(e => e.kind === kind && (!card || e.card === card) && (!e.card || e.card.inst === e.inst));
  }
  expire(test) { this.effects = this.effects.filter(e => !test(e)); }

  // ------------------------------------------------------------ static (permanent) effects (8-1-3-3)
  // every static ability on the field whose conditions hold: [{ src, ab }]
  // what static conditions can depend on, so the list is worked out again whenever any of it changes
  staticKey() {
    const fx = this.effects;
    let k = `${this.turn}:${this.current}:${this.phase}:${fx.length}:${fx.length ? fx[fx.length - 1].id : 0}:${this.fight ? this.fight.boosts.length : '-'}`;
    for (const p of this.players) {
      k += `|${p.life.length}.${p.life.filter(c => c.faceUp).length},${p.hand.length},${p.trash.length},${p.deck.length},${p.donActive},${p.donRested},${p.donDeck}`;
      for (const c of this.field(p.id)) k += `,${c.inst}${c.rested ? 'r' : ''}${c.don}`;
    }
    return k;
  }
  statics() {
    if (this.inStatics) return this.inStatics;
    const key = this.staticKey();
    if (this.statCache && this.statCache.key === key) return this.statCache.list;
    // while the conditions are checked, the effects found so far apply: the unconditional ones first, so "All of your
    // Characters gain +1 cost. If you have a Character with a cost of 8 or more, ..." sees the +1
    const list = [];
    this.inStatics = list;
    // a power or cost being worked out when this started doesn't count as "in progress" for the conditions
    const guards = [this.powerGuard, this.costGuard];
    this.powerGuard = new Set(); this.costGuard = new Set();
    try {
      const conditional = [];
      for (const p of this.players) for (const c of this.field(p.id)) for (const ab of this.abilities(c)) {
        if (ab.kind !== 'static' || ab.hand) continue;
        if (!this.abilityConditions(c, ab)) continue;
        if (ab.cond) conditional.push({ src: c, ab }); else list.push({ src: c, ab });
      }
      for (const x of conditional) if (this.test(x.ab.cond, { pid: x.src.owner, src: x.src, ab: x.ab, vars: {} })) list.push(x);
    } finally { this.inStatics = null; [this.powerGuard, this.costGuard] = guards; }
    this.statCache = { key, list };
    return list;
  }
  // the [DON!! xX], [Your Turn], [Opponent's Turn] conditions of an ability (8-3-2)
  abilityConditions(card, ab) {
    if (ab.don && card.don < ab.don) return false;
    if (ab.turn === 'you' && this.current !== card.owner) return false;
    if (ab.turn === 'opp' && this.current === card.owner) return false;
    return true;
  }
  staticMods(kind, card) {
    const out = [];
    for (const { src, ab } of this.statics()) for (const m of ab.mods) if (m.k === kind && this.modApplies(m, src, card)) out.push({ m, src });
    return out;
  }
  modApplies(m, src, card) {
    const sel = m.sel;
    if (!sel || sel.ref === 'self') return card === src;
    if (sel.ref === 'leader') return card === this.players[src.owner].leader;
    if (!this.onField(card)) return false;
    return this.matches(card, sel, { pid: src.owner, src, vars: {} });
  }

  // ------------------------------------------------------------ card values
  basePower(card) {
    const sets = this.liveEffects('basePower', card);
    return sets.length ? Math.max(...sets.map(e => e.value)) : (card.def.power || 0);    // 4-9-2-1: the highest
  }
  power(card) {
    if (!card || (card.cat !== 'L' && card.cat !== 'C')) return 0;
    if (!this.onField(card)) return card.def.power || 0;
    if (this.powerGuard && this.powerGuard.has(card)) return this.basePower(card);
    (this.powerGuard ||= new Set()).add(card);
    try {
      let n = this.basePower(card);
      if (this.current === card.owner) n += 1000 * card.don;      // 6-5-5-2
      for (const { m, src } of this.staticMods('power', card)) n += this.amount(m.n, { pid: src.owner, src, vars: {} });
      for (const e of this.liveEffects('power', card)) n += e.n;
      if (this.fight) for (const c of this.fight.boosts) if (c.card === card && c.inst === card.inst) n += c.n;
      return n;
    } finally { this.powerGuard.delete(card); }
  }
  baseCost(card) { return card.def.cost || 0; }
  cost(card) {
    if (!card || card.cat === 'L') return 0;
    if (this.costGuard && this.costGuard.has(card)) return this.baseCost(card);
    (this.costGuard ||= new Set()).add(card);
    try {
      let n = this.baseCost(card);
      if (this.onField(card)) {
        for (const { m, src } of this.staticMods('cost', card)) n += this.amount(m.n, { pid: src.owner, src, vars: {} });
        for (const e of this.liveEffects('cost', card)) n += e.n;
      } else if (card.zone === 'hand') {
        // "give this card in your hand −N cost": static abilities that work in the hand (2-8-2)
        for (const ab of this.abilities(card)) if (ab.kind === 'static' && ab.hand && (!ab.cond || this.test(ab.cond, { pid: card.owner, src: card, ab, vars: {} }))) for (const m of ab.mods) if (m.k === 'cost') n += this.amount(m.n, { pid: card.owner, src: card, vars: {} });
      }
      return Math.max(0, n);            // 1-3-6-2
    } finally { this.costGuard.delete(card); }
  }
  counterValue(card) { return card.cat === 'C' ? (card.def.counter || 0) : 0; }
  // keywords: printed (with their conditions), granted by static abilities, and granted for a while
  has(card, kw) {
    if (!this.onField(card)) return false;
    for (const ab of this.abilities(card)) if (ab.kind === 'keyword' && ab.kw === kw && this.abilityConditions(card, ab) && (!ab.cond || this.test(ab.cond, { pid: card.owner, src: card, ab, vars: {} }))) return true;
    for (const { m } of this.staticMods('grant', card)) if (m.kw === kw) return true;
    return this.liveEffects('grant', card).some(e => e.kw === kw);
  }
  // restrictions and protections, from static abilities and effects
  flag(card, k, test = () => true) {
    for (const { m, src } of this.staticMods(k, card)) if (test(m, src)) return true;
    return this.liveEffects(k, card).some(e => test(e, null));
  }
  // what's changing a card, for the table
  modsOf(card) {
    const out = [];
    if (!this.onField(card)) return out;
    if (card.don) out.push({ text: `DON!! ×${card.don}${this.current === card.owner ? ` (+${card.don * 1000})` : ''}` });
    for (const e of this.effects) {
      if (e.card !== card || e.inst !== card.inst) continue;
      const when = e.dur === 'battle' ? 'this battle' : e.dur === 'turn' ? 'this turn' : 'for a while';
      if (e.kind === 'power') out.push({ text: `${signed(e.n)} power ${when}` });
      else if (e.kind === 'cost') out.push({ text: `${signed(e.n)} cost ${when}` });
      else if (e.kind === 'basePower') out.push({ text: `base power ${e.value} ${when}` });
      else if (e.kind === 'grant') out.push({ text: `[${e.kw}] ${when}` });
      else if (e.text) out.push({ text: e.text });
    }
    if (this.fight) for (const b of this.fight.boosts) if (b.card === card && b.inst === card.inst) out.push({ text: `${signed(b.n)} power this battle` });
    return out;
  }

  // ------------------------------------------------------------ matching cards against a description
  // sel: { who, cats, f: [filters], zone } (see text.js); ctx: { pid, src }
  matches(card, sel, ctx) {
    if (sel.who === 'you' && card.owner !== ctx.pid) return false;
    if (sel.who === 'opp' && card.owner === ctx.pid) return false;
    if (sel.cats && !sel.cats.includes(card.cat)) return false;
    for (const f of sel.f || []) if (!this.filter(card, f, ctx)) return false;
    return true;
  }
  cmp(a, op, b) { return op === '<=' ? a <= b : op === '>=' ? a >= b : op === '<' ? a < b : op === '>' ? a > b : a === b; }
  filter(card, f, ctx) {
    switch (f.k) {
      case 'rested': return this.onField(card) && card.rested;
      case 'active': return this.onField(card) && !card.rested;
      case 'cost': return card.cat !== 'L' && this.cmp(this.cost(card), f.op, this.amount(f.n, ctx));
      case 'baseCost': return card.cat !== 'L' && this.cmp(this.baseCost(card), f.op, this.amount(f.n, ctx));
      case 'costRange': { const c = this.cost(card); return card.cat !== 'L' && c >= f.lo && c <= f.hi; }
      case 'power': return (card.cat === 'L' || card.cat === 'C') && this.cmp(this.power(card), f.op, this.amount(f.n, ctx));
      case 'basePower': return (card.cat === 'L' || card.cat === 'C') && this.cmp(this.onField(card) ? this.basePower(card) : (card.def.power || 0), f.op, this.amount(f.n, ctx));
      case 'trait': return f.any.some(t => (card.def.traits || []).includes(t));
      case 'traitHas': return f.any.some(t => (card.def.traits || []).some(x => x.includes(t)));
      case 'name': return f.any.includes(card.name);
      case 'notName': return !f.any.includes(card.name);
      case 'notSelf': return card !== ctx.src;
      case 'color': return f.any.some(c => (card.def.colors || []).includes(c));
      case 'multicolor': return (card.def.colors || []).length > 1;
      case 'attr': return f.any.some(a => (card.def.attr || []).includes(a));
      case 'kw': return this.onField(card) ? this.has(card, f.kw) : compileCard(card.def).abilities.some(a => a.kind === 'keyword' && a.kw === f.kw);
      case 'hasTrigger': return !!card.def.trigger;
      case 'vanilla': return !card.def.text && !card.def.trigger;
      case 'cat': return f.any.includes(card.cat);
      case 'playedThisTurn': return this.onField(card) && card.playedTurn === this.turn;
      // OP12-020: "If this Leader battles your opponent's Character during this turn"
      case 'battledChar': return this.onField(card) && card.battledCharTurn === this.turn && card.battledCharInst === card.inst;
      case 'faceUp': return card.zone === 'life' && card.faceUp === f.v;
      case 'or': return f.any.some(g => g.every(h => this.filter(card, h, ctx)));
      case 'not': return !this.filter(card, f.f, ctx);
      default: this.unhandled(`filter "${f.k}"`); return false;
    }
  }
  // a number in card text: a constant, or something to count ("the number of your opponent's Life cards")
  amount(n, ctx) {
    if (typeof n === 'number') return n;
    if (n == null) return 0;
    const p = this.players[ctx.pid], o = this.players[this.opp(ctx.pid)];
    const q = n.who === 'opp' ? o : p;
    switch (n.k) {
      case 'life': return q.life.length;
      case 'lifeTotal': return p.life.length + o.life.length;
      case 'hand': return q.hand.length;
      case 'trash': return q.trash.length;
      case 'donField': return this.donOnField(q.id);
      case 'donRested': return q.donRested;
      case 'restedCards': return q.donRested + this.field(q.id).filter(c => c.rested).length;
      case 'givenDon': return this.givenDon(q.id);
      // "draw cards equal to the number of cards trashed": the count from the event that activated the effect
      case 'eventN': return (ctx.data && ctx.data.n) || 0;
      case 'count': return this.candidates(n.sel, ctx).length;
      case 'per': return n.each * Math.floor(this.amount(n.of, ctx) / (n.div || 1));
      case 'neg': return -this.amount(n.v, ctx);
      case 'var': return (ctx.vars && ctx.vars[n.name]) || 0;
      default: this.unhandled(`amount "${n.k}"`); return 0;
    }
  }

  // ------------------------------------------------------------ conditions ("If ...", 8-3-3)
  test(c, ctx) {
    if (!c) return true;
    const p = this.players[ctx.pid], o = this.players[this.opp(ctx.pid)];
    switch (c.k) {
      case 'and': return c.all.every(x => this.test(x, ctx));
      case 'or': return c.any.some(x => this.test(x, ctx));
      case 'not': return !this.test(c.c, ctx);
      case 'cmp': return this.cmp(this.amount(c.a, ctx), c.op, this.amount(c.b, ctx));
      case 'exists': return this.candidates(c.sel, ctx).length >= (c.n || 1);
      case 'self': return !!ctx.src && this.onField(ctx.src) && (c.f || []).every(f => this.filter(ctx.src, f, ctx));
      case 'leader': return this.matches((c.who === 'opp' ? o : p).leader, { f: c.f }, ctx);
      case 'turn': return c.who === 'you' ? this.current === ctx.pid : this.current !== ctx.pid;
      case 'did': return !!ctx.vars.did;
      // "If that card is a Character": the card just revealed or chosen
      case 'that': return (ctx.vars.that || []).some(x => this.matches(x, { f: c.f, cats: c.cats }, ctx));
      // "If the revealed card has the chosen cost"
      case 'chosenCost': return !!ctx.vars.revealed && ctx.vars.chosenCost != null && this.baseCost(ctx.vars.revealed) === ctx.vars.chosenCost;
      case 'handTrashedThisTurn': return (c.who === 'opp' ? o : p).handTrashedTurn === this.turn;
      default: this.unhandled(`condition "${c.k}"`); return false;
    }
  }

  // ------------------------------------------------------------ the cards an effect can choose from
  candidates(sel, ctx) {
    const pid = ctx.pid;
    const owners = sel.who === 'you' ? [pid] : sel.who === 'opp' ? [this.opp(pid)] : [pid, this.opp(pid)];
    const pool = [];
    const zone = sel.zone || 'field';
    for (const o of owners) {
      const p = this.players[o];
      if (zone === 'field') pool.push(...this.field(o));
      else if (zone === 'handOrTrash') pool.push(...p.hand, ...p.trash);
      else pool.push(...p[zone]);
    }
    const cats = sel.cats || (zone === 'field' ? ['L', 'C'] : null);
    return pool.filter(c => (!cats || cats.includes(c.cat)) && (sel.f || []).every(f => this.filter(c, f, ctx)));
  }

  // ------------------------------------------------------------ setup (5-2)
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
    for (const p of this.players) { this.log(`${p.name}'s Leader is ${p.leader.name}.`, { pid: p.id }); this.event('play', { pid: p.id, card: p.leader.uid }); }
    // one player decides whether to go first or second (5-2-1-4): a coin flip picks who
    const heads = this.rng.next() < 0.5;
    const chooser = heads ? 0 : 1;
    this.log(`Coin flip: ${heads ? 'heads' : 'tails'}. ${this.players[chooser].name} chooses who goes first.`);
    this.event('coin', { heads, pid: chooser, reason: 'Who goes first' });
    const go = await this.chooseOption(chooser, [{ value: 'first', label: 'Go first' }, { value: 'second', label: 'Go second' }], 'You won the coin flip. Go first or second?', 'first');
    this.first = go === 'second' ? this.opp(chooser) : chooser;
    this.log(`${this.players[this.first].name} goes first.`);
    this.event('first', { pid: this.first });
    // "At the start of the game" Leader effects (5-2-1-5-1): the chooser's first; the deck is shuffled after
    for (const pid of [chooser, this.opp(chooser)]) {
      const p = this.players[pid];
      for (const ab of this.abilities(p.leader)) if (ab.kind === 'auto' && ab.timings.includes('startOfGame')) { await this.runAbility(p.leader, ab, {}); this.shuffle(pid); }
    }
    // opening hands; then each player may redraw once, the first player deciding first (5-2-1-6)
    for (const p of this.players) this.draw(p.id, 5, { quiet: true });
    for (const pid of [this.first, this.opp(this.first)]) {
      const p = this.players[pid];
      const v = await this.ask(pid, { type: 'mulligan', hand: p.hand.map(c => c.uid), prompt: 'Keep this hand, or return it and draw 5 new cards?', hint: 'mulligan' });
      p.redrew = v === true;
      if (p.redrew) {
        for (const c of [...p.hand]) { this.detach(c); p.deck.push(c); c.zone = 'deck'; }
        this.shuffle(pid);
        this.draw(pid, 5, { quiet: true });
        this.log(`${p.name} redraws their hand.`, { pid });
        this.event('mulligan', { pid });
      } else this.log(`${p.name} keeps their hand.`, { pid });
    }
    // Life: cards from the top of the deck, the top card ending up at the bottom of the Life area (5-2-1-7, 2-9-2-1)
    for (const p of this.players) {
      const n = p.leader.def.life || 0;
      for (let k = 0; k < n && p.deck.length; k++) { const c = p.deck.shift(); p.life.unshift(c); c.zone = 'life'; c.faceUp = false; }
      this.event('life-setup', { pid: p.id, n: p.life.length });
    }
    this.notify();
  }

  // ------------------------------------------------------------ turns (6)
  async takeTurn() {
    this.turn++;
    this.current = this.turn === 1 ? this.first : this.opp(this.current);
    const pid = this.current, p = this.players[pid];
    p.turns++;
    this.log(`Turn ${this.turn}: ${p.name}`, { type: 'turn', pid });
    this.event('turn', { pid });
    if (this.turn > this.maxTurns) return this.endGame(null, 'Turn limit reached');
    // Refresh Phase (6-2)
    this.phase = 'refresh';
    this.expire(e => e.ends.at === 'start' && e.ends.turn <= this.turn);
    await this.fireAndResolve('startOfTurn', { pid });
    const given = this.givenDon(pid);
    for (const c of this.fighters(pid)) c.don = 0;
    p.donRested += given;
    if (given) this.event('don', { pid, n: given, kind: 'unattach' });
    // "will not become active in your opponent's next Refresh Phase"
    const frozen = new Set(this.effects.filter(e => e.kind === 'noRefresh' && e.ends.turn === this.turn && e.card && e.card.inst === e.inst).map(e => e.card));
    for (const c of this.field(pid)) if (c.rested && !frozen.has(c)) { c.rested = false; }
    p.donActive += p.donRested; p.donRested = 0;
    this.expire(e => e.ends.at === 'refresh' && e.ends.turn <= this.turn);
    this.event('refresh', { pid });
    // Draw Phase (6-3): not the first player's first turn
    this.phase = 'draw';
    if (!(this.turn === 1 && pid === this.first)) this.draw(pid, 1);
    // DON!! Phase (6-4)
    this.phase = 'don';
    const k = this.addDon(pid, this.turn === 1 && pid === this.first ? 1 : 2);
    if (k) this.log(`${p.name} places ${dons(k)} in their cost area.`, { pid });
    this.notify();
    // Main Phase (6-5)
    this.phase = 'main';
    await this.fireAndResolve('startOfMain', { pid });
    for (let guard = 0; guard < 500 && !this.over; guard++) {
      const actions = this.legalActions(pid);
      const a = await this.ask(pid, { type: 'main', actions, prompt: 'Your Main Phase', hint: 'main' });
      if (this.over) return;
      const act = this.matchAction(actions, a);
      // an answer that isn't one of the choices (a stale click) asks again rather than ending the turn
      if (!act) continue;
      if (act.t === 'end') break;
      await this.doAction(pid, act);
    }
    if (this.over) return;
    await this.endPhase(pid);
  }

  // End Phase (6-6)
  async endPhase(pid) {
    this.phase = 'end';
    // [End of Your Turn] effects of the turn player, then [End of Your Opponent's Turn] effects (6-6-1-1)
    await this.fireAndResolve('endOfYourTurn', { pid });
    await this.fireAndResolve('endOfOppTurn', { pid });
    // effects due "at the end of this turn", the turn player's first (6-6-1-2)
    const due = this.effects.filter(e => e.kind === 'delayed' && e.ends.turn === this.turn);
    for (const who of [pid, this.opp(pid)]) for (const e of due.filter(x => x.pid === who)) {
      this.effects = this.effects.filter(x => x !== e);
      await this.runSteps(e.steps, { pid: e.pid, src: e.src, ab: e.ab, vars: {} });
      await this.resolvePending();
    }
    // durations that end with the turn (6-6-1-2, 6-6-1-3)
    this.expire(e => e.ends.at === 'end' && e.ends.turn <= this.turn);
    this.notify();
    await sleep0();
  }

  matchAction(actions, a) {
    if (!a || typeof a !== 'object') return null;
    return actions.find(x => x.t === a.t && x.card === a.card && x.target === a.target && x.ability === a.ability) || null;
  }

  // every legal Main Phase action (6-5-2), for the agents and the table
  legalActions(pid) {
    const p = this.players[pid];
    const out = [];
    // 6-5-3: play a Character or Stage, or activate a [Main] Event
    for (const c of p.hand) if (this.canPlayFromHand(pid, c)) out.push({ t: 'play', card: c.uid, label: `Play ${c.name} (${this.cost(c)})` });
    // 6-5-4: [Activate: Main] effects
    for (const c of this.field(pid)) for (const ab of this.abilities(c)) {
      if (ab.kind === 'activate' && this.canActivate(c, ab)) out.push({ t: 'activate', card: c.uid, ability: ab.idx, label: `${c.name}: ${ab.text}` });
    }
    // 6-5-5: give DON!!
    if (p.donActive > 0) for (const c of this.fighters(pid)) out.push({ t: 'don', target: c.uid, n: 1, label: `Give a DON!! card to ${c.name}` });
    // 6-5-6: battle; neither player can battle on their first turn (6-5-6-1)
    if (p.turns > 1) for (const a of this.fighters(pid)) for (const t of this.attackTargets(a)) out.push({ t: 'attack', card: a.uid, target: t.uid, label: `${a.name} attacks ${t.name}` });
    out.push({ t: 'end', label: 'End the turn' });
    return out;
  }
  eventAbility(card, timing) { return this.abilities(card).find(a => a.kind === 'event' && a.timings.includes(timing)) || null; }
  canPlayFromHand(pid, c) {
    const p = this.players[pid];
    if (c.cat === 'L' || c.zone !== 'hand') return false;
    const cost = this.cost(c);
    if (cost > p.donActive) return false;
    if (c.cat === 'E') {
      const ab = this.eventAbility(c, 'main');
      return !!ab && this.costPayable(c, ab, { extraDon: cost });
    }
    return c.cat === 'C' || c.cat === 'S';
  }
  // what this Leader or Character can attack now (7-1, 3-7-4, 10-1-1, 10-1-6)
  attackTargets(a) {
    const pid = a.owner;
    if (!this.onField(a) || a.rested || (a.cat !== 'L' && a.cat !== 'C')) return [];
    // attacking rests the attacker (7-1-1-1): a card that can't be rested can't attack
    if (this.flag(a, 'cantAttack') || this.flag(a, 'cantRest')) return [];
    let vsLeader = true;
    if (a.cat === 'C' && a.playedTurn === this.turn) {
      if (this.has(a, 'Rush')) { /* anything */ }
      else if (this.has(a, 'Rush: Character')) vsLeader = false;
      else return [];
    }
    const o = this.players[this.opp(pid)];
    const out = [];
    if (vsLeader) out.push(o.leader);
    for (const c of o.characters) {
      if (!c.rested && !this.flag(a, 'canAttackActive')) continue;
      if (this.flag(a, 'cantAttackChar', m => !m.f || this.matches(c, { f: m.f }, { pid, src: a, vars: {} }))) continue;
      out.push(c);
    }
    return out;
  }

  async doAction(pid, act) {
    const p = this.players[pid];
    switch (act.t) {
      case 'play': await this.playFromHand(pid, this.cardByUid(act.card)); break;
      case 'don': {
        const c = this.cardByUid(act.target);
        if (this.giveDon(pid, c, 1)) this.log(`${p.name} gives a DON!! card to ${c.name}.`, { pid });
        break;
      }
      case 'activate': {
        const c = this.cardByUid(act.card);
        const ab = this.abilities(c).find(a => a.idx === act.ability);
        this.log(`${p.name} activates ${c.name}'s effect.`, { pid, type: 'effect' });
        this.event('activate', { pid, card: c.uid });
        await this.activateAbility(c, ab);
        break;
      }
      case 'attack': await this.attack(pid, this.cardByUid(act.card), this.cardByUid(act.target)); break;
    }
    await this.resolvePending();
    this.notify();
  }

  // ------------------------------------------------------------ playing cards (6-5-3, 2-7)
  async playFromHand(pid, c) {
    const p = this.players[pid];
    const cost = this.cost(c);
    if (c.cat === 'E') {
      // 2-7-3: reveal, pay, trash it, then activate and resolve
      const ab = this.eventAbility(c, 'main');
      this.payDon(pid, cost);
      this.moveCard(c, 'trash');
      this.log(`${p.name} activates ${c.name}.`, { pid, type: 'play' });
      this.event('play', { pid, card: c.uid });
      this.fire('eventActivated', { pid, card: c });
      await this.activateEvent(c, ab);
      return;
    }
    this.payDon(pid, cost);
    await this.putIntoPlay(pid, c, { from: 'hand' });
  }
  // a Character or Stage card enters the field (from the hand, the trash, the deck, or a [Trigger])
  async putIntoPlay(pid, c, { from = 'hand', rested = false } = {}) {
    const p = this.players[pid];
    if (c.cat === 'C') {
      // 3-7-6-1: with 5 Characters already, trash one first (a rule, not a K.O.: 3-7-6-1-1)
      if (p.characters.length >= 5) {
        const [old] = await this.chooseOnField(pid, p.characters, { min: 1, max: 1, prompt: `You have 5 Characters: trash one to play ${c.name}`, hint: 'trash-for-room' });
        this.moveCard(old, 'trash');
        this.log(`${p.name} trashes ${old.name} to make room.`, { pid });
        this.event('trash', { pid, card: old.uid });
      }
      this.moveCard(c, 'characters', { rested });
    } else if (c.cat === 'S') {
      if (p.stage) { const old = p.stage; this.moveCard(old, 'trash'); this.log(`${old.name} is trashed.`, { pid }); this.event('trash', { pid, card: old.uid }); }     // 3-8-5-1
      this.moveCard(c, 'stage', { rested });
    } else return false;
    this.log(`${p.name} plays ${c.name}${rested ? ' rested' : ''}${from !== 'hand' ? ` from their ${from}` : ''}.`, { pid, type: 'play' });
    this.event('play', { pid, card: c.uid, from });
    this.fire('onPlay', { pid, card: c });
    this.fire('charPlayed', { pid, card: c, from });
    return true;
  }

  // ------------------------------------------------------------ abilities: costs, activation, resolution (8)
  oncePerTurnUsed(card, ab) { return !!ab.once && card.used[ab.idx] === this.turn; }
  canActivate(card, ab) {
    if (this.phase !== 'main' || this.fight || this.current !== card.owner) return false;      // 10-2-2-1
    if (!this.abilityConditions(card, ab) || this.oncePerTurnUsed(card, ab)) return false;
    if (ab.need && !this.test(ab.need, { pid: card.owner, src: card, ab, vars: {} })) return false;
    return this.costPayable(card, ab);
  }
  // can every part of an activation cost be paid (8-3-1-3)? extraDon: a card cost paid at the same time
  costPayable(card, ab, { extraDon = 0 } = {}) {
    const pid = card.owner, p = this.players[pid];
    const ctx = { pid, src: card, ab, vars: {} };
    const hand = (c) => this.candidates({ zone: 'hand', who: 'you', cats: c.cats, f: c.f }, ctx).filter(x => x !== card);
    let rest = extraDon;
    for (const c of ab.cost || []) {
      switch (c.op) {
        case 'restDon': rest += c.n; break;
        case 'returnDon': if (this.donOnField(pid) - extraDon < c.n) return false; break;
        case 'returnDonAny': if (this.donOnField(pid) < 1) return false; break;
        case 'restSelf': if (!this.onField(card) || card.rested || this.flag(card, 'cantRest')) return false; break;
        case 'restLeaderOrDon': if (!this.restableLeader(card, c)) rest += 1; break;
        case 'trashSelf': if (!this.onField(card)) return false; break;
        case 'trashHand': case 'revealHand': if (hand(c).length < c.n) return false; break;
        case 'lifeToHand': if (!p.life.length || this.ownLifeLocked(pid)) return false; break;
        case 'trashLife': if (!p.life.length) return false; break;
        case 'bounceSelf': if (!this.onField(card) || card.cat !== 'C') return false; break;
        case 'restOwn': if (this.candidates({ who: 'you', cats: c.cats || ['C'], f: [...(c.f || []), { k: 'active' }] }, ctx).filter(x => (!c.notSelf || x !== card) && !this.flag(x, 'cantRest')).length < (c.n || 1)) return false; break;
        case 'bounceOwn': if (this.candidates({ who: 'you', cats: ['C'], f: c.f }, ctx).filter(x => !c.notSelf || x !== card).length < c.n) return false; break;
        case 'handToDeck': if (p.hand.filter(x => x !== card).length < c.n) return false; break;
        case 'trashToDeck': if (p.trash.length < c.n) return false; break;
        case 'millSelf': if (p.deck.length < c.n) return false; break;
        case 'lifeFaceUp': if (!p.life.some(x => !x.faceUp)) return false; break;
        case 'lifeFaceDown': if (!p.life.some(x => x.faceUp)) return false; break;
        case 'charToLife': if (!this.candidates({ who: 'you', cats: ['C'], f: c.f }, ctx).length) return false; break;
        case 'returnGivenDon': if (this.givenDon(pid) < c.n) return false; break;
        default: this.unhandled(`cost "${c.op}"`); return false;
      }
    }
    return p.donActive >= rest;
  }
  // pay an activation cost. `ask`: confirm an optional ("You may") cost first. Returns false if not paid.
  async payCost(card, ab, ctx, { ask = true } = {}) {
    const pid = card.owner, p = this.players[pid];
    if (!(ab.cost || []).length) return true;
    if (!this.costPayable(card, ab)) return false;
    if (ab.optional && ask && !(await this.confirm(pid, `${card.name}: ${ab.costText || 'pay the cost'}?`, 'pay-cost', { card: card.uid, ability: ab.idx }))) return false;
    for (const c of ab.cost) {
      switch (c.op) {
        case 'restDon': this.payDon(pid, c.n); break;
        case 'returnDon': if (!(await this.returnDon(pid, c.n))) return false; break;
        case 'returnDonAny': {
          const n = await this.chooseNumber(pid, 1, this.donOnField(pid), 'Return how many DON!! cards to your DON!! deck?', 'don-return-n');
          await this.returnDon(pid, n);
          ctx.vars.returned = n;
          break;
        }
        case 'restSelf': card.rested = true; this.event('rest', { card: card.uid }); this.fire('rested', { pid, card, byEffect: true, by: pid }); break;
        case 'restLeaderOrDon': {
          // ST32-001: "rest your <Slash> attribute Leader or 1 of your DON!! cards"
          const L = p.leader, opts = [];
          if (this.restableLeader(card, c)) opts.push({ value: 'leader', label: `Rest ${L.name}` });
          if (p.donActive) opts.push({ value: 'don', label: 'Rest 1 of your DON!! cards' });
          const v = await this.chooseOption(pid, opts, 'Rest your Leader or 1 of your DON!! cards?', 'rest-leader-or-don');
          if (v === 'leader') { L.rested = true; this.event('rest', { card: L.uid }); this.fire('rested', { pid, card: L, byEffect: true, by: pid }); }
          else if (v === 'don') this.payDon(pid, 1);
          else return false;
          break;
        }
        case 'trashSelf': this.moveCard(card, 'trash'); this.log(`${p.name} trashes ${card.name}.`, { pid }); this.event('trash', { pid, card: card.uid }); break;
        case 'bounceSelf': this.moveCard(card, 'hand'); this.log(`${card.name} returns to ${p.name}'s hand.`, { pid }); this.event('return', { card: card.uid, to: 'hand' }); break;
        case 'trashHand': case 'revealHand': {
          const opts = this.candidates({ zone: 'hand', who: 'you', cats: c.cats, f: c.f }, ctx).filter(x => x !== card);
          const trash = c.op === 'trashHand';
          const got = await this.chooseCards(pid, opts, { min: c.n, max: c.n, prompt: `${trash ? 'Trash' : 'Reveal'} ${cards(c.n)} from your hand`, from: 'hand', hint: trash ? 'discard' : 'reveal' });
          if (trash) {
            for (const x of got) { this.moveCard(x, 'trash'); this.event('trash', { pid, card: x.uid }); }
            this.log(`${p.name} trashes ${got.map(x => x.name).join(', ')} from their hand.`, { pid });
            this.handTrashed(pid, got.length, card);
          } else { this.log(`${p.name} reveals ${got.map(x => x.name).join(', ')}.`, { pid }); ctx.vars.revealedHand = got; }
          break;
        }
        case 'lifeToHand': { const x = await this.pickLife(pid, c.where, 'Add which Life card to your hand?'); if (x) await this.lifeToHand(pid, x, { byEffect: true }); break; }
        case 'trashLife': { const x = await this.pickLife(pid, c.where, 'Trash which Life card?'); if (x) { this.moveCard(x, 'trash'); this.log(`${p.name} trashes a card from their Life.`, { pid }); this.event('trash', { pid, card: x.uid, from: 'life' }); } break; }
        case 'restOwn': {
          const opts = this.candidates({ who: 'you', cats: c.cats || ['C'], f: [...(c.f || []), { k: 'active' }] }, ctx).filter(x => (!c.notSelf || x !== card) && !this.flag(x, 'cantRest'));
          const got = await this.chooseOnField(pid, opts, { min: c.n || 1, max: c.n || 1, prompt: 'Rest which of your cards?', hint: 'rest-cost' });
          for (const x of got) { x.rested = true; this.event('rest', { card: x.uid }); this.fire('rested', { pid, card: x, byEffect: true, by: pid }); }
          break;
        }
        case 'bounceOwn': {
          const opts = this.candidates({ who: 'you', cats: ['C'], f: c.f }, ctx).filter(x => !c.notSelf || x !== card);
          const got = await this.chooseOnField(pid, opts, { min: c.n, max: c.n, prompt: "Return which of your Characters to the owner's hand?", hint: 'bounce-cost' });
          for (const x of got) { this.moveCard(x, 'hand'); this.log(`${x.name} returns to ${p.name}'s hand.`, { pid }); this.event('return', { card: x.uid, to: 'hand' }); }
          break;
        }
        case 'handToDeck': {
          const got = await this.chooseCards(pid, p.hand.filter(x => x !== card), { min: c.n, max: c.n, prompt: `Place ${cards(c.n)} from your hand at the ${c.bottom ? 'bottom' : 'top'} of your deck`, from: 'hand', hint: 'topdeck' });
          for (const x of got) this.moveCard(x, 'deck', { top: !c.bottom });
          this.log(`${p.name} places ${cards(got.length)} from their hand at the ${c.bottom ? 'bottom' : 'top'} of their deck.`, { pid });
          break;
        }
        case 'trashToDeck': {
          const got = await this.chooseCards(pid, [...p.trash], { min: c.n, max: c.n, prompt: `Place ${cards(c.n)} from your trash at the bottom of your deck`, from: 'trash', hint: 'recycle' });
          for (const x of got) this.moveCard(x, 'deck', { top: false });
          this.log(`${p.name} places ${got.map(x => x.name).join(', ')} from their trash at the bottom of their deck.`, { pid });
          break;
        }
        case 'millSelf': {
          const got = p.deck.slice(0, c.n);
          for (const x of got) this.moveCard(x, 'trash');
          this.log(`${p.name} trashes ${cards(got.length)} from the top of their deck.`, { pid });
          break;
        }
        case 'lifeFaceUp': case 'lifeFaceDown': {
          const up = c.op === 'lifeFaceUp';
          const x = await this.pickLife(pid, c.where || 'top', `Turn which Life card face-${up ? 'up' : 'down'}?`, l => l.faceUp !== up);
          if (x) { x.faceUp = up; this.log(`${p.name} turns a Life card face-${up ? 'up' : 'down'}.`, { pid }); this.event('life-turn', { pid, card: x.uid, faceUp: up }); }
          break;
        }
        case 'charToLife': {
          const opts = this.candidates({ who: 'you', cats: ['C'], f: c.f }, ctx);
          const [x] = await this.chooseOnField(pid, opts, { min: 1, max: 1, prompt: 'Add which of your Characters to the top of your Life cards face-up?', hint: 'to-life' });
          if (x) { this.moveCard(x, 'life', { top: true, faceUp: true }); this.log(`${p.name} adds ${x.name} to the top of their Life cards face-up.`, { pid }); this.event('life-add', { pid, card: x.uid }); }
          break;
        }
        case 'returnGivenDon': {
          for (let left = c.n; left > 0; left--) {
            const opts = this.fighters(pid).filter(x => x.don);
            const [x] = await this.chooseOnField(pid, opts, { min: 1, max: 1, prompt: `Return a given DON!! card to your cost area rested (${left} left)`, hint: 'don-unattach' });
            if (!x) break;
            x.don--; p.donRested++;
          }
          this.event('don', { pid, n: c.n, kind: 'unattach' });
          break;
        }
      }
    }
    return true;
  }
  // the top card of the Life area, or the top or bottom one when the text allows either (3-10-2)
  async pickLife(pid, where, prompt, ok = () => true) {
    const p = this.players[pid];
    if (!p.life.length) return null;
    const top = p.life[0], bot = p.life[p.life.length - 1];
    if (where === 'topOrBottom' && p.life.length > 1) {
      const opts = [ok(top) && { value: 'top', label: 'The top Life card' }, ok(bot) && { value: 'bottom', label: 'The bottom Life card' }].filter(Boolean);
      if (!opts.length) return null;
      return (await this.chooseOption(pid, opts, prompt, 'life-end')) === 'bottom' ? bot : top;
    }
    return ok(top) ? top : null;
  }
  // a Life card goes to its owner's hand. Under ST13-003's Leader, face-up ones that damage (the rules) would add to
  // the hand go to the bottom of the deck instead; effects still add them to the hand ("according to the rules")
  async lifeToHand(pid, c, { byEffect = false } = {}) {
    const p = this.players[pid];
    if (c.faceUp && !byEffect && this.flag(p.leader, 'faceUpLifeToDeck')) {
      this.moveCard(c, 'deck', { top: false });
      this.log(`${p.name}'s face-up Life card ${c.name} goes to the bottom of their deck.`, { pid });
    } else {
      this.moveCard(c, 'hand');
      this.log(`${p.name} adds a Life card to their hand.`, { pid });
    }
    this.event('life', { pid, card: c.uid });
    this.fire('lifeToHand', { pid, byEffect });
  }

  activateAbility(card, ab) { return this.guarded(card, () => this.activateAbilityNow(card, ab)); }
  async activateAbilityNow(card, ab) {
    const ctx = { pid: card.owner, src: card, ab, vars: {} };
    // the player chose to activate it: an optional ("You may") cost isn't asked about again
    if (!(await this.payCost(card, ab, ctx, { ask: false }))) { this.log(`${card.name}'s effect is not activated.`, { pid: card.owner }); return; }
    if (ab.once) card.used[ab.idx] = this.turn;
    await this.runSteps(ab.steps, ctx);
  }
  activateEvent(card, ab, opts = {}) { return this.guarded(card, () => this.activateEventNow(card, ab, opts)); }
  async activateEventNow(card, ab, { counter = false } = {}) {
    const ctx = { pid: card.owner, src: card, ab, vars: {}, counter };
    // the player chose to activate it: its cost isn't asked about again
    if (!(await this.payCost(card, ab, ctx, { ask: false }))) { this.log(`${card.name}'s effect does nothing.`, { pid: card.owner }); return; }
    await this.runSteps(ab.steps, ctx);
  }
  // an auto effect resolving (or an effect run for a card: [Trigger], "activate this card's [Main] effect")
  runAbility(card, ab, data = {}) { return this.guarded(card, () => this.runAbilityNow(card, ab, data)); }
  async runAbilityNow(card, ab, data = {}) {
    const ctx = { pid: card.owner, src: card, ab, vars: {}, data };
    if (!(await this.payCost(card, ab, ctx))) return false;
    if (ab.once) card.used[ab.idx] = this.turn;
    await this.runSteps(ab.steps, ctx);
    return true;
  }

  // ------------------------------------------------------------ auto effects (8-1-3-1, 8-6)
  // an event happened: queue the auto effects whose activation timing it fulfils
  fire(kind, data = {}) {
    const batch = ++this.batch;
    for (const p of this.players) for (const c of this.field(p.id)) for (const ab of this.abilities(c)) {
      if (ab.kind !== 'auto' || !ab.timings.includes(kind)) continue;
      // OP09-081: "[On Play] effects are negated" (8-2-1-1: they don't activate)
      if (kind === 'onPlay' && this.onPlayNegated(c.owner)) continue;
      if (!this.autoMatches(c, ab, kind, data)) continue;
      // 8-3-2-3: [DON!! xX] and the other conditions must hold when the timing is met
      if (!this.abilityConditions(c, ab)) continue;
      this.pending.push({ pid: c.owner, card: c, inst: c.inst, ab, kind, data, batch });
    }
  }
  // does this auto effect care about this occurrence of the event?
  autoMatches(c, ab, kind, data) {
    const pid = c.owner;
    switch (kind) {
      case 'onPlay': return data.card === c;
      case 'whenAttacking': return data.attacker === c;
      case 'onOppAttack': return data.pid !== pid;
      case 'onBlock': return data.blocker === c;
      case 'endOfYourTurn': return this.current === pid;
      case 'endOfOppTurn': return this.current !== pid;
      case 'startOfTurn': case 'startOfMain': return ab.when ? this.whenMatches(c, ab, data) : this.current === pid;
      case 'endOfBattle': case 'battling': return data.cards.includes(c) && (!ab.when || this.whenMatches(c, ab, data));
      default: return !ab.when || this.whenMatches(c, ab, data);
    }
  }
  whenMatches(c, ab, data) {
    const w = ab.when, pid = c.owner;
    if (w.self && data.card !== c) return false;
    if (w.who === 'you' && data.pid !== pid) return false;
    if (w.who === 'opp' && data.pid === pid) return false;
    if (w.byEffect && !data.byEffect) return false;
    if (w.byYou && data.by !== pid) return false;
    if (w.byOpp && data.by !== this.opp(pid)) return false;
    if (w.sel && !(data.card && this.matches(data.card, w.sel, { pid, src: c, vars: {} }))) return false;
    if (w.minN && (data.n || 0) < w.minN) return false;
    // "by your {Navy} type card's effect": the card whose effect did it
    if (w.srcSel && !(data.src && this.matches(data.src, w.srcSel, { pid, src: c, vars: {} }))) return false;
    // "If this Character battles your opponent's Character": the other card in the battle
    if (w.withChar || w.battleSel) {
      const other = data.attacker === c ? data.target : data.attacker;
      if (!other || other.owner === pid) return false;
      if (w.withChar && other.cat !== 'C') return false;
      if (w.battleSel && !this.matches(other, w.battleSel, { pid, src: c, vars: {} })) return false;
    }
    return true;
  }
  async fireAndResolve(kind, data) { this.fire(kind, data); await this.resolvePending(); }
  // resolve queued auto effects: the earliest batch first, the turn player's before the non-turn player's, each
  // player choosing the order of their own (8-6-1); during damage processing they wait (8-6-2)
  async resolvePending() {
    for (let guard = 0; this.pending.length && guard < 300 && !this.over; guard++) {
      if (this.inDamage) return;
      const b = Math.min(...this.pending.map(x => x.batch));
      const now = this.pending.filter(x => x.batch === b);
      const tp = now.filter(x => x.pid === this.current);
      const mine = tp.length ? tp : now;
      let item = mine[0];
      if (mine.length > 1) {
        const v = await this.chooseOption(item.pid, mine.map((x, i) => ({ value: i, label: `${x.card.name}: ${x.ab.text}` })), 'Several of your effects activate at once: which resolves first?', 'order-effects');
        item = mine[v] || mine[0];
      }
      this.pending.splice(this.pending.indexOf(item), 1);
      await this.resolveAuto(item);
    }
  }
  // run a card's effect so that a failure in it (a bug, or something the engine can't do) skips the effect instead of
  // ending the game
  async guarded(card, fn) {
    try { return await fn(); } catch (e) {
      if (e && e.gameOver) throw e;
      this.unhandled(`${card ? card.name + ': ' : ''}${e && e.message}`, e);
      return false;
    }
  }
  resolveAuto(item) { return this.guarded(item.card, () => this.resolveAutoNow(item)); }
  async resolveAutoNow(item) {
    const { card, ab, data } = item;
    // 8-1-3-1-3: a card that left its area doesn't activate (but [On K.O.] resolves from the trash, 10-2-17-1)
    if (item.kind === 'ko') { if (card.inst !== item.inst || card.zone !== 'trash') return; }
    else if (card.inst !== item.inst || !this.onField(card)) return;
    if (this.oncePerTurnUsed(card, ab)) return;
    const ctx = { pid: card.owner, src: card, ab, vars: {}, data };
    if (ab.need && !this.test(ab.need, ctx)) return;
    if (!this.costPayable(card, ab)) return;
    if (ab.optional && !(await this.confirm(card.owner, `${card.name}: ${ab.costText || 'activate this effect'}?`, 'pay-cost', { card: card.uid, ability: ab.idx }))) return;
    this.log(`${card.name}'s effect activates.`, { pid: card.owner, type: 'effect' });
    this.event('activate', { pid: card.owner, card: card.uid, timing: item.kind });
    if (!(await this.payCost(card, ab, ctx, { ask: false }))) return;
    if (ab.once) card.used[ab.idx] = this.turn;
    await this.runSteps(ab.steps, ctx);
  }

  // ------------------------------------------------------------ battle (7)
  syncBattle(step) {
    const f = this.fight;
    this.battle = f ? { attacker: f.attacker.uid, target: f.target.uid, step: step || this.battle && this.battle.step, blocker: f.blocker ? f.blocker.uid : null } : null;
  }
  async attack(pid, a, t) {
    const dp = this.opp(pid);
    a.rested = true;
    this.fight = { attacker: a, ainst: a.inst, target: t, tinst: t.inst, pid, dpid: dp, boosts: [], blocker: null, noBlocker: [], noBlockerAll: false, cards: [a, t] };
    const f = this.fight;
    this.syncBattle('attack');
    this.log(`${a.name} attacks ${t.cat === 'L' ? `${this.players[dp].name}'s Leader ${t.name}` : t.name}.`, { pid, type: 'attack' });
    this.event('attack', { pid, card: a.uid, target: t.uid });
    this.event('rest', { card: a.uid });
    this.fire('rested', { pid, card: a, byEffect: false });
    this.notify();
    // Attack Step (7-1-1): [When Attacking], then the defender's [On Your Opponent's Attack] (10-2-16-1)
    this.fire('whenAttacking', { pid, attacker: a, target: t });
    await this.resolvePending();
    this.fire('onOppAttack', { pid, attacker: a, target: t });
    await this.resolvePending();
    if (this.battleBroken()) return this.endBattle();
    // Block Step (7-1-2)
    this.syncBattle('block');
    const blockers = this.blockersFor(f);
    if (blockers.length) {
      const v = await this.ask(dp, { type: 'blocker', options: blockers.map(c => c.uid), attacker: a.uid, target: f.target.uid, prompt: `${a.name} (${this.power(a)}) attacks ${f.target.cat === 'L' ? 'your Leader' : f.target.name} (${this.power(f.target)}): block with a [Blocker]?`, hint: 'block' });
      const bl = blockers.find(c => c.uid === v);
      if (bl) {
        bl.rested = true;
        f.blocker = bl; f.target = bl; f.tinst = bl.inst; f.cards = [a, bl];
        this.syncBattle('block');
        this.log(`${bl.name} blocks with [Blocker].`, { pid: dp, type: 'block' });
        this.event('block', { pid: dp, card: bl.uid });
        this.event('rest', { card: bl.uid });
        this.fire('onBlock', { pid: dp, blocker: bl, attacker: a });
        this.fire('blockerActivated', { pid: dp, card: bl });
        await this.resolvePending();
        if (this.battleBroken()) return this.endBattle();
      }
    }
    // "When this Character battles ...": the two cards of the battle are settled once the Block Step is over
    // OP12-020: remember which Leaders and Characters battle an opponent's Character this turn
    for (const [x, y] of [[a, f.target], [f.target, a]]) if (y.cat === 'C' && y.owner !== x.owner) { x.battledCharTurn = this.turn; x.battledCharInst = x.inst; }
    this.fire('battling', { pid, cards: f.cards, attacker: a, target: f.target });
    await this.resolvePending();
    if (this.battleBroken()) return this.endBattle();
    // Counter Step (7-1-3)
    this.syncBattle('counter');
    await this.counterStep();
    if (this.battleBroken()) return this.endBattle();
    // Damage Step (7-1-4)
    this.syncBattle('damage');
    const ap = this.power(a), tp = this.power(f.target);
    this.log(`${a.name} (${ap}) vs ${f.target.name} (${tp}).`, { pid });
    if (ap >= tp) {
      if (f.target.cat === 'L') await this.leaderDamage(dp, this.has(a, 'Double Attack') ? 2 : 1, { attacker: a, banish: this.has(a, 'Banish') });
      else await this.ko(f.target, { by: 'battle', pid, attacker: a });
    } else this.log(`${a.name} loses the battle.`, { pid });
    await this.endBattle();
  }
  battleBroken() {
    const f = this.fight;
    return !f || f.attacker.inst !== f.ainst || !this.onField(f.attacker) || f.target.inst !== f.tinst || !this.onField(f.target);
  }
  blockersFor(f) {
    const a = f.attacker;
    if (this.has(a, 'Unblockable') || f.noBlockerAll || this.liveEffects('noBlockerWhenAttacking', a).length) return [];
    return this.players[f.dpid].characters.filter(c => c !== f.target && !c.rested && this.has(c, 'Blocker')
      && !f.noBlocker.some(fl => this.matches(c, { f: fl }, { pid: f.pid, src: a, vars: {} }))
      && !this.flag(c, 'cantBlock') && !this.flag(c, 'cantRest'));      // blocking rests the blocker
  }
  counterOptions(dp) {
    const p = this.players[dp], out = [];
    for (const c of p.hand) {
      const v = this.counterValue(c);
      if (v > 0) out.push({ card: c.uid, kind: 'counter', value: v });
      if (c.cat === 'E') {
        const ab = this.eventAbility(c, 'counter');
        if (ab && this.cost(c) <= p.donActive && this.costPayable(c, ab, { extraDon: this.cost(c) })) out.push({ card: c.uid, kind: 'event', cost: this.cost(c) });
      }
    }
    return out;
  }
  async counterStep() {
    const f = this.fight, dp = f.dpid, p = this.players[dp];
    for (let guard = 0; guard < 60 && !this.over; guard++) {
      if (this.battleBroken()) return;
      const opts = this.counterOptions(dp);
      if (!opts.length) return;
      const v = await this.ask(dp, { type: 'counter', options: opts, attacker: f.attacker.uid, target: f.target.uid, prompt: `${f.attacker.name} (${this.power(f.attacker)}) attacks ${f.target.name} (${this.power(f.target)}): use a Counter?`, hint: 'counter' });
      if (!v || typeof v !== 'object') return;
      const o = opts.find(x => x.card === v.card && x.kind === v.kind);
      if (!o) return;
      const c = this.cardByUid(o.card);
      if (o.kind === 'counter') {
        // 7-1-3-1-1: trash it from the hand: +X power to the Leader or 1 Character during this battle
        const to = this.fighters(dp).find(x => x.uid === v.to) || f.target;
        this.moveCard(c, 'trash');
        f.boosts.push({ card: to, inst: to.inst, n: o.value });
        this.log(`${p.name} uses ${c.name}'s Counter: ${to.name} gets +${o.value} power.`, { pid: dp, type: 'counter' });
        this.event('counter', { pid: dp, card: c.uid, value: o.value, target: to.uid });
      } else {
        // 7-1-3-1-2: pay its cost, trash it, activate its [Counter] effect
        const ab = this.eventAbility(c, 'counter');
        this.payDon(dp, this.cost(c));
        this.moveCard(c, 'trash');
        this.log(`${p.name} activates ${c.name}.`, { pid: dp, type: 'counter' });
        this.event('counter', { pid: dp, card: c.uid, value: 0, event: true });
        this.fire('eventActivated', { pid: dp, card: c });
        await this.activateEvent(c, ab, { counter: true });
      }
      await this.resolvePending();
      this.notify();
    }
  }
  async endBattle() {
    const f = this.fight;
    if (!f) return;
    // 7-1-5-2: "at the end of the battle" and "if this ... battles" effects
    this.fire('endOfBattle', { pid: f.pid, cards: f.cards, attacker: f.attacker, target: f.target });
    await this.resolvePending();
    this.expire(e => e.ends.battle);
    this.fight = null;
    this.syncBattle();
    this.event('battle-end', {});
    this.notify();
  }

  // damage to a Leader (4-6, 7-1-4-1-1): Life cards go to the hand one at a time; [Trigger] may activate instead
  async leaderDamage(pid, n, { attacker = null, banish = false, byEffect = false } = {}) {
    const p = this.players[pid];
    this.event('damage', { pid, n });
    if (!p.life.length) {
      // 7-1-4-1-1-1 and 9-2-1-1: the Leader takes damage with 0 Life cards
      p.damagedAtZero = true;
      this.log(`${p.name}'s Leader takes damage with no Life cards left.`, { pid, type: 'damage' });
      return this.ruleCheck();
    }
    this.inDamage = (this.inDamage || 0) + 1;
    try {
      for (let k = 0; k < n; k++) {
        if (!p.life.length) {
          // 7-1-4-1-1-3 repeats 7-1-4-1-1-2, which needs 1 or more Life: in battle, [Double Attack] against 1 Life
          // takes that card and the game goes on. Damage from effects (4-6-2) does reach a Leader with 0 Life.
          if (byEffect) { p.damagedAtZero = true; this.ruleCheck(); }
          break;
        }
        const c = p.life[0];
        this.log(`${p.name}'s Leader takes 1 damage.`, { pid, type: 'damage' });
        if (banish) {
          // 10-1-3: the Life card is trashed instead, and its [Trigger] doesn't activate
          this.moveCard(c, 'trash');
          this.log(`Banish: ${c.name} is trashed from ${p.name}'s Life.`, { pid });
          this.event('trash', { pid, card: c.uid, from: 'life' });
          continue;
        }
        const trig = this.triggerAbility(c);
        const toDeck = c.faceUp && this.flag(p.leader, 'faceUpLifeToDeck');
        if (trig && !toDeck) {
          const yes = await this.ask(pid, { type: 'trigger', card: c.uid, prompt: `${c.name}: activate its [Trigger] (${c.def.trigger}) instead of adding it to your hand?`, hint: 'trigger' });
          if (yes === true) {
            // 10-1-5-3: the card is in no area while its [Trigger] resolves, then it's trashed unless it moved
            this.moveCard(c, 'limbo');
            this.log(`${p.name} reveals ${c.name} and activates its [Trigger].`, { pid, type: 'trigger' });
            this.event('trigger', { pid, card: c.uid });
            await this.runAbility(c, trig);
            if (c.zone === 'limbo') { this.moveCard(c, 'trash'); this.event('trash', { pid, card: c.uid }); }
            continue;
          }
        }
        await this.lifeToHand(pid, c);
      }
    } finally { this.inDamage--; }
    this.notify();
    // 8-6-2: auto effects from damage processing activate afterwards
    if (!this.inDamage) await this.resolvePending();
  }
  triggerAbility(card) { return this.abilities(card).find(a => a.kind === 'trigger') || null; }
  // "you cannot add Life cards to your hand using your own effects during this turn" (costs included, 8-2-1-1)
  ownLifeLocked(pid) { return this.effects.some(e => e.kind === 'noOwnLifeToHand' && e.pid === pid); }
  restableLeader(card, c) {
    const L = this.players[card.owner].leader;
    return !L.rested && !this.flag(L, 'cantRest') && this.matches(L, { cats: c.cats, f: c.f }, { pid: card.owner, src: card, vars: {} });
  }
  // cards were trashed from a player's hand by an effect (costs included): OP12-040's trigger, ST33-004's condition
  handTrashed(pid, n, src) {
    if (!n) return;
    this.players[pid].handTrashedTurn = this.turn;
    this.fire('handTrashed', { pid, n, byEffect: true, src });
  }
  onPlayNegated(pid) { return this.flag(this.players[pid].leader, 'negateOnPlay') || this.effects.some(e => e.kind === 'negateOnPlay' && e.pid === pid); }

  // ------------------------------------------------------------ K.O. and leaving the field (10-2-1)
  canBeKOd(card, { by, pid, attacker } = {}) {
    const test = m => !m.how || m.how === 'any' || m.how === by || (m.how === 'oppEffect' && by === 'effect' && pid !== card.owner) || (m.how === 'battleLeader' && by === 'battle' && attacker && attacker.cat === 'L');
    if (this.flag(card, 'noKO', test)) return false;
    if (this.effects.some(e => e.kind === 'noKOAll' && e.pid === card.owner)) return false;
    return true;
  }
  async ko(card, { by = 'effect', pid = null, attacker = null } = {}) {
    if (!this.onField(card) || card.cat !== 'C') return false;
    if (!this.canBeKOd(card, { by, pid, attacker })) { this.log(`${card.name} can't be K.O.'d.`, { pid: card.owner }); return false; }
    if (await this.replaceRemoval(card, by === 'battle' ? 'koBattle' : 'koEffect', pid)) return false;
    const owner = card.owner;
    // 10-2-17-1: [On K.O.] activates on the field (conditions checked there), then resolves from the trash
    const onKO = this.abilities(card).filter(ab => ab.kind === 'auto' && ab.timings.includes('ko') && this.abilityConditions(card, ab) && (!ab.when || this.whenMatches(card, ab, { pid, byEffect: by === 'effect', by: pid, card })));
    const batch = ++this.batch;
    const name = card.name;
    this.moveCard(card, 'trash');
    this.log(`${name} is K.O.'d.`, { pid: owner, type: 'ko' });
    this.event('ko', { pid: owner, card: card.uid, name, by });
    for (const ab of onKO) this.pending.push({ pid: owner, card, inst: card.inst, ab, kind: 'ko', data: { byEffect: by === 'effect' }, batch });
    this.fire('charKO', { pid: owner, card, byEffect: by === 'effect', by: pid });
    return true;
  }
  // replacement effects for a Character about to leave the field ("If this Character would be K.O.'d, you may ...
  // instead", 8-1-3-4). The turn player's apply first (8-1-3-4-2); each applies once (8-1-3-4-3).
  async replaceRemoval(card, how, byPid) {
    for (const pid of [this.current, this.opp(this.current)]) for (const src of this.field(pid)) for (const ab of this.abilities(src)) {
      if (ab.kind !== 'replace' || src.owner !== card.owner) continue;
      const r = ab.replace;
      if (!(r.events.includes(how) || (r.events.includes('remove') && how !== 'koBattle'))) continue;
      if (r.byOpp && byPid !== this.opp(card.owner)) continue;
      if (!this.abilityConditions(src, ab) || this.oncePerTurnUsed(src, ab)) continue;
      if (r.self ? card !== src : !this.matches(card, r.sel, { pid: src.owner, src, vars: {} })) continue;
      if (!this.costPayable(src, { cost: r.cost || [] })) continue;
      if (!(await this.confirm(src.owner, `${card.name} would be ${how === 'remove' ? 'removed from the field' : "K.O.'d"}. ${ab.text}`, 'replace'))) continue;
      if (ab.once) src.used[ab.idx] = this.turn;
      const ctx = { pid: src.owner, src, ab, vars: { replaced: card } };
      await this.payCost(src, { cost: r.cost || [] }, ctx, { ask: false });
      if (r.steps) await this.runSteps(r.steps, ctx);
      this.log(`${src.name}'s effect: ${card.name} stays on the field.`, { pid: src.owner });
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ effects: the step interpreter
  async runSteps(steps, ctx) {
    for (const s of steps || []) {
      if (this.over) return;
      try {
        // 4-10-1: when an "if" clause can't be resolved, the clauses after it can't be either ("If your Leader is ...,
        // A. Then, B." does neither); a "then" clause that does nothing doesn't stop the rest (4-10-2)
        if (s.cond && !this.test(s.cond, ctx)) return;
        await this.step(s, ctx);
      } catch (e) {
        // an effect that breaks never takes the game down: the step is skipped (tests set throwErrors to catch it)
        if (e && e.gameOver) throw e;
        this.unhandled(`${ctx.src ? ctx.src.name + ': ' : ''}${e && e.message}`, e);
      }
    }
  }
  // something in a card's effect the engine can't do: in a test (throwErrors) it fails loudly; in a game it is logged,
  // remembered in `problems` and skipped, so the game goes on (the same way on every peer)
  unhandled(what, err = null) {
    if (this.throwErrors) throw (err instanceof Error ? err : new Error(`unhandled ${what}`));
    (this.problems ||= []).push(what);
    this.log(`(The rules engine couldn't resolve ${what}; it is skipped.)`, { type: 'effect' });
  }
  // choose the cards an effect affects; "up to N" may choose 0 (8-4-4-1)
  async select(sel, ctx, prompt, hint) {
    switch (sel.ref) {
      case 'self': return this.onField(ctx.src) ? [ctx.src] : [];
      case 'leader': return [this.players[ctx.pid].leader].filter(c => this.matches(c, { f: sel.f }, ctx));
      case 'oppLeader': return [this.players[this.opp(ctx.pid)].leader];
      case 'selected': return (ctx.vars.selected || []).filter(c => this.onField(c));
      case 'replaced': return ctx.vars.replaced && this.onField(ctx.vars.replaced) ? [ctx.vars.replaced] : [];
      case 'battleOpp': { const d = ctx.data || {}; const other = d.attacker === ctx.src ? d.target : d.attacker; return other && this.onField(other) ? [other] : []; }
    }
    const opts = this.candidates(sel, ctx);
    const max = this.amount(sel.n == null ? 1 : sel.n, ctx);
    const got = sel.all ? opts : await this.chooseOnField(ctx.pid, opts, { min: sel.upTo ? 0 : max, max, prompt, hint });
    // later text says "that Character" / "that card" for these
    ctx.vars.selected = got; ctx.vars.that = got;
    return got;
  }
  durText(d) { return { battle: 'during this battle', turn: 'during this turn', startOfYourNextTurn: 'until the start of your next turn', endOfOppNextTurn: "until the end of your opponent's next turn", endOfYourNextTurn: 'until the end of your next turn', oppNextRefresh: '' }[d] || ''; }

  async step(s, ctx) {
    const pid = ctx.pid, p = this.players[pid], o = this.players[this.opp(pid)];
    switch (s.op) {
      case 'select': {
        const got = await this.select(s.sel, ctx, s.prompt || 'Select a card', 'select');
        ctx.vars.selected = got;
        if (got.length) this.log(`${p.name} selects ${got.map(c => c.name).join(', ')}.`, { pid });
        return;
      }
      case 'power': {
        const n = this.amount(s.n, ctx);
        const got = await this.select(s.sel, ctx, `${signed(n)} power ${this.durText(s.dur)}: choose`, n >= 0 ? 'buff' : 'debuff');
        for (const c of got) {
          if (s.dur === 'battle' && this.fight) this.fight.boosts.push({ card: c, inst: c.inst, n });
          else this.addEffect({ kind: 'power', card: c, n }, s.dur, pid);
          this.log(`${c.name} gets ${signed(n)} power ${this.durText(s.dur)}.`, { pid });
          this.event('power', { card: c.uid, n });
        }
        ctx.vars.affected = got;
        return;
      }
      case 'basePower': {
        const got = await this.select(s.sel, ctx, `Base power becomes ${s.value}: choose`, s.value ? 'buff' : 'debuff');
        for (const c of got) { this.addEffect({ kind: 'basePower', card: c, value: s.value }, s.dur, pid); this.log(`${c.name}'s base power becomes ${s.value} ${this.durText(s.dur)}.`, { pid }); this.event('power', { card: c.uid }); }
        return;
      }
      case 'cost': {
        const n = this.amount(s.n, ctx);
        const got = await this.select(s.sel, ctx, `${signed(n)} cost ${this.durText(s.dur)}: choose`, n >= 0 ? 'cost-up' : 'cost-down');
        for (const c of got) { this.addEffect({ kind: 'cost', card: c, n }, s.dur, pid); this.log(`${c.name} gets ${signed(n)} cost ${this.durText(s.dur)}.`, { pid }); this.event('cost', { card: c.uid, n }); }
        return;
      }
      case 'ko': {
        const got = await this.select(s.sel, ctx, "K.O. which Character?", 'ko');
        for (const c of got) await this.ko(c, { by: 'effect', pid });
        return;
      }
      case 'rest': {
        // only active cards can be rested (and only rested ones set as active): an already rested card isn't a choice
        const got = await this.select(s.sel.ref ? s.sel : { ...s.sel, f: [...(s.sel.f || []), { k: 'active' }] }, ctx, 'Rest which card?', 'rest');
        for (const c of got) {
          if (s.noRefresh) this.addEffect({ kind: 'noRefresh', card: c, text: 'stays rested next Refresh Phase' }, 'oppNextRefresh', pid);
          if (c.rested || this.flag(c, 'cantRest')) continue;
          c.rested = true;
          this.log(`${c.name} is rested.`, { pid });
          this.event('rest', { card: c.uid });
          this.fire('rested', { pid: c.owner, card: c, byEffect: true, by: pid });
        }
        return;
      }
      case 'setActive': {
        const got = await this.select(s.sel.ref ? s.sel : { ...s.sel, f: [...(s.sel.f || []), { k: 'rested' }] }, ctx, 'Set which card as active?', 'set-active');
        for (const c of got) { if (!c.rested) continue; c.rested = false; this.log(`${c.name} is set as active.`, { pid }); this.event('active', { card: c.uid }); }
        return;
      }
      case 'giveDon': {
        // "Give X up to N rested DON!! cards": from the rested ones in the cost area
        const got = await this.select(s.sel, ctx, 'Give rested DON!! cards to which card?', 'give-don');
        for (const c of got) {
          const max = Math.min(this.amount(s.n, ctx), p.donRested);
          if (max <= 0) break;
          const k = s.upTo && max > 1 ? await this.chooseNumber(pid, 0, max, `Give how many rested DON!! cards to ${c.name}?`, 'don-n') : max;
          const g = this.giveDon(pid, c, k, { rested: true });
          if (g) this.log(`${p.name} gives ${g} rested DON!! card${g > 1 ? 's' : ''} to ${c.name}.`, { pid });
        }
        return;
      }
      case 'donActive': {
        const max = Math.min(this.amount(s.n, ctx), p.donRested);
        const k = s.upTo && max > 0 ? await this.chooseNumber(pid, 0, max, 'Set how many of your rested DON!! cards as active?', 'don-n') : max;
        if (k > 0) { p.donRested -= k; p.donActive += k; this.log(`${p.name} sets ${dons(k)} as active.`, { pid }); this.event('don', { pid, n: k, kind: 'active' }); }
        return;
      }
      case 'restDon': {
        const q = s.who === 'opp' ? o : p;
        const max = Math.min(this.amount(s.n, ctx), q.donActive);
        const k = s.upTo && max > 0 ? await this.chooseNumber(pid, 0, max, `Rest how many of ${s.who === 'opp' ? "your opponent's" : 'your'} active DON!! cards?`, 'don-n') : max;
        if (k > 0) { q.donActive -= k; q.donRested += k; this.log(`${dons(k)} of ${q.name}'s ${k > 1 ? 'are' : 'is'} rested.`, { pid }); this.event('don', { pid: q.id, n: k, kind: 'rest' }); }
        return;
      }
      case 'addDon': {
        const k = this.addDon(pid, this.amount(s.n, ctx), { rested: !!s.rested });
        if (k) this.log(`${p.name} adds ${dons(k)} from their DON!! deck${s.rested ? ', rested' : ', set as active'}.`, { pid });
        return;
      }
      case 'draw': this.draw(pid, this.amount(s.n, ctx)); return;
      case 'discard': {
        // "trash N cards from your hand" (the player trashes from their own hand)
        const q = s.who === 'opp' ? o : p;
        const n = Math.min(this.amount(s.n, ctx), q.hand.length);
        if (n <= 0) return;
        // "trash 2 cards from your opponent's hand": the player of the effect picks them face-down
        const whose = q.name === 'You' ? 'your' : `${q.name}'s`;
        const got = s.blind
          ? await this.chooseCards(pid, [...q.hand], { min: n, max: n, prompt: `Trash ${cards(n)} from your opponent's hand (face-down)`, from: 'opp-hand', hint: 'discard-opp' })
          : await this.chooseCards(q.id, [...q.hand], { min: n, max: n, prompt: `Trash ${cards(n)} from your hand`, from: 'hand', hint: 'discard' });
        for (const c of got) { this.moveCard(c, 'trash'); this.event('trash', { pid: q.id, card: c.uid, from: 'hand' }); }
        this.log(s.blind ? `${p.name} trashes ${got.map(c => c.name).join(', ')} from ${whose} hand.` : `${q.name} trashes ${got.map(c => c.name).join(', ')} from their hand.`, { pid: q.id });
        this.handTrashed(q.id, got.length, ctx.src);
        return;
      }
      case 'bounce': case 'bottom': {
        const got = await this.select(s.sel, ctx, s.op === 'bounce' ? "Return which Character to the owner's hand?" : "Place which Character at the bottom of the owner's deck?", s.op);
        for (const c of got) {
          if (!this.onField(c) || c.cat === 'L') continue;
          if (c.owner !== pid && (await this.replaceRemoval(c, 'remove', pid))) continue;
          this.moveCard(c, s.op === 'bounce' ? 'hand' : 'deck', { top: false });
          this.log(`${c.name} ${s.op === 'bounce' ? `returns to ${this.players[c.owner].name}'s hand` : `goes to the bottom of ${this.players[c.owner].name}'s deck`}.`, { pid });
          this.event('return', { card: c.uid, to: s.op === 'bounce' ? 'hand' : 'deck' });
        }
        return;
      }
      case 'grant': {
        const got = await this.select(s.sel, ctx, `Gains [${s.kw}] ${this.durText(s.dur)}: choose`, 'grant');
        for (const c of got) { this.addEffect({ kind: 'grant', card: c, kw: s.kw }, s.dur, pid); this.log(`${c.name} gains [${s.kw}] ${this.durText(s.dur)}.`, { pid }); }
        return;
      }
      case 'noBlocker': {
        // "Your opponent cannot activate [Blocker] (Characters that have ...) during this battle"
        if (!this.fight) return;
        if (s.f) this.fight.noBlocker.push(s.f); else this.fight.noBlockerAll = true;
        this.log(`${o.name} can't activate ${s.f ? 'some ' : ''}[Blocker]${s.f ? ' Characters' : ''} during this battle.`, { pid });
        return;
      }
      case 'noBlockerIfAttacks': {
        const got = await this.select(s.sel, ctx, 'Choose', 'select');
        for (const c of got) { this.addEffect({ kind: 'noBlockerWhenAttacking', card: c, text: "can't be blocked this turn" }, s.dur || 'turn', pid); this.log(`If ${c.name} attacks this turn, ${o.name} can't activate [Blocker].`, { pid }); }
        return;
      }
      case 'restrict': {
        // a restriction or protection for a while: cantAttack, noKO, cantBlock, cantRest, canAttackActive, ...
        const got = await this.select(s.sel, ctx, 'Choose', s.flag);
        for (const c of got) { this.addEffect({ kind: s.flag, card: c, how: s.how, f: s.f, text: s.text }, s.dur, pid); this.log(`${c.name}: ${s.text || s.flag} ${this.durText(s.dur)}.`, { pid }); }
        return;
      }
      case 'playerFlag': { const who = s.who === 'opp' ? this.opp(pid) : pid; this.addEffect({ kind: s.flag, by: pid }, s.dur, who); return; }
      case 'playSelf': {
        const c = ctx.src;
        if (c.zone !== 'limbo' && !(s.fromTrash && c.zone === 'trash')) return;
        await this.putIntoPlay(c.owner, c, { from: c.zone === 'limbo' ? 'Life' : c.zone, rested: !!s.rested });
        return;
      }
      case 'selfToHand': {
        const c = ctx.src;
        if (c.zone === 'limbo') { this.moveCard(c, 'hand'); this.log(`${c.name} is added to ${p.name}'s hand.`, { pid }); }
        return;
      }
      case 'runEffect': {
        // "Activate this card's [Main] effect" (a [Trigger]); [Counter] only when the text says so (10-2-4-1-2)
        const ab = this.eventAbility(ctx.src, s.which);
        if (ab) await this.runSteps(ab.steps, { ...ctx, ab, vars: {} });
        return;
      }
      case 'look': return this.look(s, ctx);
      case 'play': return this.playFrom(s, ctx);
      case 'toHand': {
        // "Add up to 1 ... from your trash to your hand"
        const opts = this.candidates(s.sel, ctx);
        const got = await this.chooseCards(pid, opts, { min: s.sel.upTo ? 0 : 1, max: this.amount(s.sel.n || 1, ctx), prompt: 'Add which card to your hand?', from: s.sel.zone || 'trash', hint: 'take' });
        for (const c of got) this.moveCard(c, 'hand');
        if (got.length) this.log(`${p.name} adds ${got.map(c => c.name).join(', ')} to their hand.`, { pid });
        return;
      }
      case 'deckToLife': {
        const n = Math.min(this.amount(s.n, ctx), p.deck.length);
        for (let k = 0; k < n; k++) { const c = p.deck[0]; this.moveCard(c, 'life', { top: true }); this.event('life-add', { pid, card: c.uid }); }
        if (n) this.log(`${p.name} adds ${cards(n)} from the top of their deck to the top of their Life cards.`, { pid });
        return;
      }
      case 'trashLife': {
        const q = s.who === 'opp' ? o : p;
        const n = Math.min(this.amount(s.n, ctx), q.life.length);
        for (let k = 0; k < n; k++) {
          const c = await this.pickLife(q.id, s.where || 'top', 'Trash which Life card?');
          if (c) { this.moveCard(c, 'trash'); this.event('trash', { pid: q.id, card: c.uid, from: 'life' }); }
        }
        if (n) this.log(`${cards(n)} trashed from ${q.name}'s Life.`, { pid });
        return;
      }
      case 'lifeToHand': {
        if (this.ownLifeLocked(pid)) return;
        const n = Math.min(this.amount(s.n || 1, ctx), p.life.length);
        for (let k = 0; k < n; k++) { const c = await this.pickLife(pid, s.where || 'top', 'Add which Life card to your hand?'); if (c) await this.lifeToHand(pid, c, { byEffect: true }); }
        return;
      }
      case 'handToLife': {
        // "Add up to N ... from your hand (or trash) to the top of your Life cards (face-up)"
        const from = s.from || 'hand';
        const opts = this.candidates({ zone: from, who: 'you', cats: s.cats, f: s.f }, ctx);
        const where = from === 'handOrTrash' ? 'hand or trash' : from;
        const got = await this.chooseCards(pid, opts, { min: s.upTo ? 0 : 1, max: this.amount(s.n || 1, ctx), prompt: `Add which card${s.n > 1 ? 's' : ''} from your ${where} to the top of your Life cards${s.faceUp ? ' face-up' : ''}?`, from: from === 'trash' ? 'trash' : 'hand', hint: 'to-life' });
        for (const c of got) {
          if (s.reveal) { this.event('reveal', { pid, card: c.uid }); this.log(`${p.name} reveals ${c.name}.`, { pid }); }
          this.moveCard(c, 'life', { top: true, faceUp: !!s.faceUp }); this.event('life-add', { pid, card: c.uid });
        }
        if (got.length) this.log(`${p.name} adds ${cards(got.length)} from their ${where} to the top of their Life cards${s.faceUp ? ' face-up' : ''}.`, { pid });
        return;
      }
      case 'fieldToLife': {
        const got = await this.select(s.sel, ctx, "Add which Character to the owner's Life cards?", 'to-life');
        for (const c of got) {
          const top = s.where === 'top' || (await this.chooseOption(pid, [{ value: 'top', label: 'The top of the Life cards' }, { value: 'bottom', label: 'The bottom of the Life cards' }], `Add ${c.name} to the top or bottom of its owner's Life cards?`, 'life-end')) === 'top';
          if (c.owner !== pid && (await this.replaceRemoval(c, 'remove', pid))) continue;
          this.moveCard(c, 'life', { top, faceUp: !!s.faceUp });
          this.log(`${c.name} is added to the ${top ? 'top' : 'bottom'} of ${this.players[c.owner].name}'s Life cards${s.faceUp ? ' face-up' : ''}.`, { pid });
          this.event('life-add', { pid: c.owner, card: c.uid });
        }
        return;
      }
      case 'lookLife': return this.lookLife(s, ctx);
      case 'choose': {
        const chooser = s.oppChooses ? this.opp(pid) : pid;
        const v = await this.chooseOption(chooser, s.options.map((x, i) => ({ value: i, label: x.text })), s.oppChooses ? `${p.name}'s ${ctx.src.name}: choose one` : 'Choose one', 'choose-one');
        const opt = s.options[v] || s.options[0];
        this.log(`${this.players[chooser].name} chooses: ${opt.text}`, { pid: chooser });
        await this.runSteps(opt.steps, ctx);
        return;
      }
      case 'may': {
        // "You may X. If you do, Y."
        if (s.need && !this.test(s.need, ctx)) { ctx.vars.did = false; return; }
        if (!(await this.confirm(pid, s.text || 'Do it?', s.hint || 'may'))) { ctx.vars.did = false; return; }
        const before = this.snapshot();
        await this.runSteps(s.steps, ctx);
        ctx.vars.did = this.snapshot() !== before;
        if (ctx.vars.did && s.then) await this.runSteps(s.then, ctx);
        return;
      }
      case 'reveal': {
        const q = s.who === 'opp' ? o : p;
        const c = (s.from === 'life' ? q.life : q.deck)[0];
        ctx.vars.revealed = c || null; ctx.vars.that = c ? [c] : [];
        if (c) { this.log(`${q.name} reveals ${c.name} from the top of their ${s.from === 'life' ? 'Life cards' : 'deck'}.`, { pid }); this.event('reveal', { pid: q.id, card: c.uid }); }
        return;
      }
      case 'delayed': this.addEffect({ kind: 'delayed', steps: s.steps, src: ctx.src, ab: ctx.ab }, 'turn', pid); return;
      case 'playThat': {
        // "If that card is a ..., you may play that card": the card revealed from the top of the deck or Life
        const c = (ctx.vars.that || [])[0];
        ctx.vars.did = false;
        if (!c || c.cat !== 'C' && c.cat !== 'S' || (c.zone !== 'deck' && c.zone !== 'life') || c.owner !== pid) return;
        if (!(await this.confirm(pid, `Play ${c.name}${s.rested ? ' rested' : ''}?`, 'may', { card: c.uid }))) return;
        ctx.vars.did = await this.putIntoPlay(pid, c, { from: c.zone === 'life' ? 'Life' : c.zone, rested: !!s.rested });
        return;
      }
      case 'freeze': {
        // "... will not become active in your opponent's next Refresh Phase"
        const got = await this.select(s.sel, ctx, "Which Characters stay rested in the next Refresh Phase?", 'freeze');
        for (const c of got) { this.addEffect({ kind: 'noRefresh', card: c, text: 'stays rested next Refresh Phase' }, 'oppNextRefresh', pid); this.log(`${c.name} won't become active in ${this.players[c.owner].name}'s next Refresh Phase.`, { pid }); }
        return;
      }
      case 'bounceAny': {
        // "You may return any number of Characters on your field to the owner's hand"
        const got = await this.chooseOnField(pid, [...p.characters], { min: 0, max: p.characters.length, prompt: 'Return any number of your Characters to your hand', hint: 'bounce-own' });
        for (const c of got) { this.moveCard(c, 'hand'); this.event('return', { card: c.uid, to: 'hand' }); }
        if (got.length) this.log(`${p.name} returns ${got.map(c => c.name).join(', ')} to their hand.`, { pid });
        ctx.vars.returned = got.length;
        return;
      }
      case 'discardAny': {
        // "You may trash any number of {Music} type cards from your hand"
        const opts = this.candidates({ zone: 'hand', who: 'you', cats: s.cats, f: s.f }, ctx);
        const got = await this.chooseCards(pid, opts, { min: 0, max: opts.length, prompt: 'Trash any number of these cards from your hand', from: 'hand', hint: 'discard-any' });
        for (const c of got) { this.moveCard(c, 'trash'); this.event('trash', { pid, card: c.uid, from: 'hand' }); }
        if (got.length) { this.log(`${p.name} trashes ${got.map(c => c.name).join(', ')} from their hand.`, { pid }); this.handTrashed(pid, got.length, ctx.src); }
        ctx.vars.trashed = got.length;
        return;
      }
      case 'handToDeck': {
        const n = Math.min(this.amount(s.n, ctx), p.hand.length);
        const got = await this.chooseCards(pid, [...p.hand], { min: n, max: n, prompt: `Place ${cards(n)} from your hand at the ${s.bottom ? 'bottom' : 'top'} of your deck`, from: 'hand', hint: 'topdeck' });
        for (const c of got) this.moveCard(c, 'deck', { top: !s.bottom });
        if (got.length) this.log(`${p.name} places ${cards(got.length)} from their hand at the ${s.bottom ? 'bottom' : 'top'} of their deck.`, { pid });
        return;
      }
      case 'lookOppDeck': {
        // "Look at 1 card from the top of your opponent's deck": it stays where it is (11-3-2, 11-3-3)
        const seen = o.deck.slice(0, this.amount(s.n, ctx));
        if (!seen.length) return;
        this.log(`${p.name} looks at the top card of ${o.name}'s deck.`, { pid });
        this.event('look', { pid, n: seen.length, whose: o.id });
        this.peeked = (this.peeked || 0) + 1;
        // only that player sees it: a confirm (any answer) whose prompt names the card
        await this.confirm(pid, `The top card of your opponent's deck is ${seen.map(c => c.name).join(', ')}.`, 'look', { card: seen[0].uid, cards: seen.map(c => c.uid) });
        return;
      }
      case 'chooseCostReveal': {
        // "Choose a cost and reveal 1 card from the top of your opponent's deck"
        const v = await this.chooseNumber(pid, 0, 10, 'Choose a cost', 'choose-cost');
        ctx.vars.chosenCost = v;
        const c = o.deck[0] || null;
        ctx.vars.revealed = c; ctx.vars.that = c ? [c] : [];
        this.log(`${p.name} chooses cost ${v}${c ? ` and reveals ${c.name} (cost ${this.baseCost(c)}) from the top of ${o.name}'s deck` : ''}.`, { pid });
        if (c) this.event('reveal', { pid: o.id, card: c.uid });
        return;
      }
      case 'mill': {
        const got = p.deck.slice(0, this.amount(s.n, ctx));
        for (const c of got) this.moveCard(c, 'trash');
        if (got.length) this.log(`${p.name} trashes ${cards(got.length)} from the top of their deck.`, { pid });
        return;
      }
      case 'redirect': {
        // ST36-005: "Change the target of the attack to your [Eustass"Captain"Kid] ..."
        const f = this.fight;
        if (!f || f.dpid !== pid) return;
        const opts = this.candidates(s.sel, ctx).filter(c => c !== f.target && c.cat === 'C');
        const [c] = await this.chooseOnField(pid, opts, { min: opts.length ? 1 : 0, max: 1, prompt: 'Change the target of the attack to which Character?', hint: 'redirect' });
        if (!c) return;
        f.target = c; f.tinst = c.inst; f.cards = [f.attacker, c];
        this.syncBattle();
        this.log(`The attack now targets ${c.name}.`, { pid });
        this.event('redirect', { pid, card: c.uid });
        return;
      }
      case 'revealedToDeck': {
        // ST22-001: "place the revealed card at the top of your deck" (the card revealed from the hand as a cost)
        for (const c of ctx.vars.revealedHand || []) if (c.zone === 'hand' && c.owner === pid) { this.moveCard(c, 'deck', { top: !s.bottom }); this.log(`${p.name} places ${c.name} at the ${s.bottom ? 'bottom' : 'top'} of their deck.`, { pid }); }
        return;
      }
      case 'restDonOrChar': {
        // ST26-002: "Rest up to 1 of your opponent's DON!! cards or Characters with a cost of 1 or less"
        const chars = this.candidates(s.sel, ctx).filter(c => !c.rested);
        const opts = [{ value: 'none', label: 'Rest nothing' }];
        if (o.donActive) opts.push({ value: 'don', label: "Rest 1 of your opponent's active DON!! cards" });
        for (const c of chars) opts.push({ value: c.uid, label: `Rest ${c.name}` });
        if (opts.length === 1) return;
        const v = await this.chooseOption(pid, opts, "Rest 1 of your opponent's DON!! cards or Characters?", 'rest-don-or-char');
        if (v === 'don' && o.donActive) { o.donActive--; o.donRested++; this.log(`1 of ${o.name}'s DON!! cards is rested.`, { pid }); this.event('don', { pid: o.id, n: 1, kind: 'rest' }); }
        else { const c = chars.find(x => x.uid === v); if (c && !c.rested) { c.rested = true; this.log(`${c.name} is rested.`, { pid }); this.event('rest', { card: c.uid }); this.fire('rested', { pid: c.owner, card: c, byEffect: true, by: pid }); } }
        return;
      }
      case 'trashField': {
        // "Trash up to 1 of your opponent's Characters ...": leaves the field, but it isn't a K.O.
        const got = await this.select(s.sel, ctx, 'Trash which Character?', 'trash-char');
        for (const c of got) {
          if (!this.onField(c) || c.cat === 'L') continue;
          if (c.owner !== pid && (await this.replaceRemoval(c, 'remove', pid))) continue;
          this.moveCard(c, 'trash');
          this.log(`${c.name} is trashed.`, { pid });
          this.event('trash', { pid: c.owner, card: c.uid, from: 'field' });
        }
        return;
      }
      case 'custom': return s.fn(this, ctx, s);
      default: this.unhandled(`effect step "${s.op}"`); return;
    }
  }
  // a fingerprint of the board, for "If you do" (did the optional part change anything?)
  snapshot() {
    return this.players.map(p => [p.hand.length, p.deck.length, p.trash.length, p.life.length, p.characters.map(c => c.inst + (c.rested ? 'r' : '')).join(','), p.donActive, p.donRested, p.donDeck, p.leader.don].join('/')).join('|') + '#' + this.effects.length;
  }

  // "Look at N cards from the top of your deck; reveal up to M ... and add them to your hand. Then, place the rest at
  // the bottom of your deck in any order." (and variants: trash the rest, top or bottom, play it, add it to Life)
  async look(s, ctx) {
    const pid = ctx.pid, p = this.players[pid];
    const n = Math.min(this.amount(s.n, ctx), p.deck.length);
    if (!n) return;
    const seen = p.deck.slice(0, n);
    if (s.reveal) {
      // "Reveal 1 card from the top of your deck and ...": both players see it
      this.log(`${p.name} reveals ${seen.map(c => c.name).join(', ')} from the top of their deck.`, { pid });
      for (const c of seen) this.event('reveal', { pid, card: c.uid });
    } else {
      this.log(`${p.name} looks at ${cards(n)} from the top of their deck.`, { pid });
      this.event('look', { pid, n });
    }
    let taken = [];
    if (s.pick) {
      const ok = seen.filter(c => (!s.pick.cats || s.pick.cats.includes(c.cat)) && (s.pick.f || []).every(f => this.filter(c, f, ctx)));
      const to = s.pick.to || 'hand';
      taken = await this.chooseCards(pid, ok, { min: 0, max: s.pick.max || 1, prompt: s.pick.prompt || (to === 'hand' ? 'Reveal a card to add to your hand' : to === 'play' ? 'Play a card' : 'Add a card to your Life cards'), from: 'deck', hint: to === 'hand' ? 'take' : to, shown: seen });
      for (const c of taken) {
        if (to === 'play') await this.putIntoPlay(pid, c, { from: 'deck', rested: !!s.pick.rested });
        else if (to === 'life') { this.moveCard(c, 'life', { top: true, faceUp: !!s.pick.faceUp }); this.event('life-add', { pid, card: c.uid }); }
        else { this.event('reveal', { pid, card: c.uid }); this.moveCard(c, 'hand'); }
      }
      if (taken.length) this.log(`${p.name} reveals ${taken.map(c => c.name).join(', ')} and ${to === 'play' ? 'plays it' : to === 'life' ? 'adds it to the top of their Life cards' : 'adds it to their hand'}.`, { pid });
    }
    const rest = seen.filter(c => !taken.includes(c) && c.zone === 'deck');
    if (rest.length) await this.placeRest(pid, rest, s.rest || 'bottom');
  }
  async placeRest(pid, rest, where) {
    const p = this.players[pid];
    if (where === 'trash') {
      for (const c of rest) this.moveCard(c, 'trash');
      this.log(`${p.name} trashes the rest.`, { pid });
      return;
    }
    // the cards stay in the deck while the player decides (11-3-2), then move
    let top = [], bottom = rest;
    if (where === 'top') { top = rest; bottom = []; }
    else if (where === 'topOrBottom') {
      top = await this.chooseCards(pid, rest, { min: 0, max: rest.length, prompt: 'Choose the cards to place at the top of your deck (the rest go to the bottom)', from: 'deck', hint: 'keep-top', shown: rest });
      bottom = rest.filter(c => !top.includes(c));
    }
    top = await this.chooseOrder(pid, top, 'Put these cards on top of your deck in order (first = top)', 'order-top');
    bottom = await this.chooseOrder(pid, bottom, 'Put these cards at the bottom of your deck in order (first = highest)', 'order-bottom');
    for (const c of rest) this.detach(c);
    for (const c of [...top].reverse()) { p.deck.unshift(c); c.zone = 'deck'; }
    for (const c of bottom) { p.deck.push(c); c.zone = 'deck'; }
    this.log(`${p.name} places ${[top.length && `${cards(top.length)} on top`, bottom.length && `${cards(bottom.length)} at the bottom`].filter(Boolean).join(' and ')} of their deck.`, { pid });
  }
  // "Play up to 1 ... from your hand / trash / deck"
  async playFrom(s, ctx) {
    const pid = ctx.pid, p = this.players[pid];
    const zone = s.from || 'hand';
    const opts = this.candidates({ zone, who: 'you', cats: s.cats || ['C'], f: s.f }, ctx);
    if (s.each) {
      // "Play up to 1 each of [A], [B] and [C]"
      for (const nm of s.each) {
        const [c] = await this.chooseCards(pid, opts.filter(x => x.name === nm && (zone === 'handOrTrash' ? x.zone === 'hand' || x.zone === 'trash' : x.zone === zone)), { min: 0, max: 1, prompt: `Play ${nm}?`, from: zone === 'handOrTrash' ? 'hand' : zone, hint: 'play' });
        if (c) await this.putIntoPlay(pid, c, { from: c.zone, rested: !!s.rested });
      }
      return;
    }
    const max = this.amount(s.n == null ? 1 : s.n, ctx);
    const got = await this.chooseCards(pid, opts, { min: 0, max, prompt: `Play up to ${cards(max)} from your ${zone === 'handOrTrash' ? 'hand or trash' : zone}`, from: zone === 'handOrTrash' ? 'hand' : zone, hint: 'play', ...(zone === 'deck' ? { shown: p.deck } : {}) });
    for (const c of got) await this.putIntoPlay(pid, c, { from: c.zone, rested: !!s.rested });
    if (zone === 'deck') this.shuffle(pid);
  }
  // "Look at up to 1 card from the top of your or your opponent's Life cards, and place it at the top or bottom"
  async lookLife(s, ctx) {
    const pid = ctx.pid;
    const whose = s.who === 'either' ? await this.chooseOption(pid, [{ value: pid, label: 'Your Life cards' }, { value: this.opp(pid), label: "Your opponent's Life cards" }], 'Look at the top card of whose Life cards?', 'life-whose') : s.who === 'opp' ? this.opp(pid) : pid;
    const q = this.players[whose];
    if (!q.life.length) return;
    if (s.all) {
      // "Look at all of your Life cards and place them back in your Life area in any order" (ST13-004: "place 1 card at
      // the top of your deck and place the rest back ...")
      let seen = [...q.life];
      this.log(`${this.players[pid].name} looks at their Life cards.`, { pid });
      this.peeked = (this.peeked || 0) + 1;
      if (s.toDeckTop) {
        const got = await this.chooseCards(pid, seen, { min: s.toDeckTop, max: s.toDeckTop, prompt: `Place ${cards(s.toDeckTop)} from your Life at the top of your deck`, from: 'life', hint: 'topdeck', shown: seen });
        for (const c of got) { this.moveCard(c, 'deck', { top: true }); this.log(`${this.players[pid].name} places a Life card at the top of their deck.`, { pid }); }
        seen = seen.filter(c => !got.includes(c));
        if (!seen.length) return;
      }
      const order = await this.chooseOrder(pid, seen, 'Put your Life cards back in order (first = top)', 'order-life');
      q.life.splice(0, q.life.length, ...order);
      return;
    }
    const c = q.life[0];
    this.log(`${this.players[pid].name} looks at the top card of ${whose === pid ? 'their' : `${q.name}'s`} Life cards.`, { pid });
    this.peeked = (this.peeked || 0) + 1;
    const v = await this.chooseOption(pid, [{ value: 'top', label: `Leave ${c.name} on top` }, { value: 'bottom', label: `Place ${c.name} at the bottom` }], `The top Life card is ${c.name}: leave it on top or place it at the bottom?`, 'life-end');
    if (v === 'bottom') { q.life.splice(0, 1); q.life.push(c); this.event('life-reorder', { pid: whose }); }
  }
}
