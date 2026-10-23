// Invariant checker for the Pokémon engine: plays computer-vs-computer games across every pairing of decks and checks
// the game state after every action, attack, Knock Out check and turn end, and at every main-phase decision:
//  - each player always has exactly their 60 cards across all zones (deck, hand, discard, Lost Zone, Prizes, the
//    card being played, Stadium, and every Pokémon's evolution stack, Energy and Tool), and no card is in two places
//  - every Pokémon in play is well formed: a real evolution stack, only Energy attached as Energy, only a Tool as Tool
//  - damage is never negative and always in 10s; no Pokémon is left in play at 0 HP once Knock Outs are checked
//  - Prize cards only go down, never below 0, and a Knock Out gives the opponent the Prizes it's worth (2 for ex,
//    3 for Mega ex, give or take the cards that change that)
//  - the Bench is never over its limit and both players have an Active Pokémon whenever a decision is made;
//    Special Conditions only on Active Pokémon (none on Pokémon with Energy under Festival Grounds)
//  - once-per-turn limits hold: one Supporter, one Energy from hand, one Stadium, one retreat, one attack (two with
//    Festival Lead), once-per-turn Abilities once per Pokémon (or once per player), the Stadium's action once,
//    no evolving a Pokémon twice or the turn it came into play (unless Forest of Vitality), no attack or Supporter
//    on the first turn for the player going first (Carmine and Team Rocket's Proton excepted)
//  - every question a player is asked can be answered (options exist and are real cards or Pokémon, sane limits)
//  - every game ends (a win, a draw or the turn cap) without hanging, and replaying the same seed gives the same game
// and, for the choices people make (most of all with --chaos):
//  - every question fits its limits: options exist, no duplicates, 1 <= max, min <= max <= options, cards offered
//    from the zone the question names, and the main phase never offers what the turn's limits have used up
//  - a Trainer, Ability or Stadium action that does nothing at all (no question, no coin flip, no change) isn't
//    playable: it would use up the card or the once-per-turn use for nothing
//  - nothing is done without limit in one turn: at most 120 main-phase actions, 30 of the same kind
//
// --chaos=one: one seat (alternating) clicks uniformly at random among everything the screen allows, against the AI;
// --chaos=both: both seats do; --chaos=mixed: both seats hand each decision to the AI or to chance, half and half;
// --chaos=all: the three in turn. --odd=0.02: that share of chaos answers are ones the screen can't send (nothing,
// an empty pick, unknown ids, duplicates), which the engine must shrug off. --busy=0.9: chaos players do something
// else instead of attacking or ending the turn that often (long turns that try everything).
// Usage: node tools/ptcg/invariants.mjs [games per pairing=12] [--deck=id] [--seed=N] [--max-reports=5] [--replay=50]
//        [--chaos=one|both|mixed|all] [--odd=0.02] [--busy=0.9]
import fs from 'node:fs';
import { PokemonGame } from '../../src/ptcg/game.js';
import { PokemonAI } from '../../src/ptcg/ai.js';
import { ABILITIES } from '../../src/ptcg/cards.js';
import { ChaosAgent } from './chaos.mjs';

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const PER = +(args.find(a => !a.startsWith('--')) || 12);
const MAX_REPORTS = +(flags['max-reports'] || 5);
const REPLAY_EVERY = +(flags.replay || 50);
const db = JSON.parse(fs.readFileSync('data/ptcg/cards.json', 'utf8'));
const decks = JSON.parse(fs.readFileSync('data/ptcg/decks.json', 'utf8'));
// Abilities you may use as often as you like
const MULTI_USE = new Set(['Super Cold', 'Psychic Embrace', 'Solar Transfer']);

class Violation extends Error {}

// everything a Trainer or an Ability could change (the card being played left out): cards in every zone and their
// order, Pokémon, the Stadium, effects, and the players' other state
const TURN_FLAGS = new Set(['supporter', 'supporterName', 'energyDone', 'retreated', 'stadiumDone', 'turns']);
function signature(g, skip) {
  const ids = l => l.filter(c => c.id !== skip).map(c => c.id).join(',');
  const mon = m => `${m.id}:${m.stack.map(c => c.id).join('>')}:${m.damage}:${ids(m.energy)}:${m.tool ? m.tool.id : ''}:${m.special || ''}${m.poisoned ? 'P' : ''}${m.burned ? 'B' : ''}`;
  let fx;
  try { fx = JSON.stringify(g.effects); } catch { fx = String(g.effects.length); }
  return [g.stadium ? `${g.stadium.card.id}@${g.stadium.owner}` : '-', fx, ...g.players.map(p => [
    ids(p.hand), ids(p.deck), ids(p.discard), ids(p.lost), ids(p.prizes), p.active ? mon(p.active) : '-', p.bench.map(mon).join(';'),
    Object.entries(p).filter(([k, v]) => (v === null || typeof v !== 'object') && !TURN_FLAGS.has(k)).map(([k, v]) => `${k}=${v}`).join(','),
  ].join('|'))].join('#');
}

function cardsOf(g, pid) {
  const p = g.players[pid];
  const out = [...p.deck, ...p.hand, ...p.discard, ...p.lost, ...p.prizes];
  if (p.inPlay) out.push(p.inPlay);
  for (const m of g.inPlay(pid)) out.push(...m.allCards());
  if (g.stadium && g.stadium.owner === pid) out.push(g.stadium.card);
  return out;
}

// the stage-by-stage chain a Pokémon's stack must follow (Rare Candy may skip the Stage 1)
function chainOk(g, stack) {
  if (!stack.length || stack.some(c => c.def.cat !== 'P')) return false;
  for (let i = 1; i < stack.length; i++) {
    const below = stack[i - 1].def, top = stack[i].def;
    if (top.from === below.name) continue;
    const s1 = Object.values(g.db).find(x => x.cat === 'P' && x.name === top.from);
    if (top.stage === 'Stage2' && below.stage === 'Basic' && ((s1 && s1.from === below.name) || (top.from === 'Pidgeotto' && below.name === 'Pidgey'))) continue;
    return false;
  }
  return true;
}

class Checker {
  constructor(g, label) {
    this.g = g; this.label = label;
    this.ids = g.players.map(p => new Set(p.deck.map(c => c.id)));
    this.prizes = [6, 6];
    this.turnCounts = {};
    this.legacy = [false, false];
    this.checks = 0;
    this.decisions = 0;
    this.flips = 0;
    this.looks = 0;
    this.reveals = 0;
    this.peeks = 0;
    this.wrap();
  }
  fail(msg) {
    const g = this.g;
    const e = new Violation(msg);
    const zones = g.players.map(p => `${p.name}: deck ${p.deck.length}, hand ${p.hand.length}, discard ${p.discard.length}, bench ${p.bench.length}`).join(' / ');
    e.detail = `${this.label} turn ${g.turn}: ${msg}\n    [${zones}]\n    ` + g.logs.slice(-12).map(l => l.text).join('\n    ');
    throw e;
  }
  uncount(key) { const k = `${this.g.turn}:${key}`; if (this.turnCounts[k]) this.turnCounts[k]--; }
  count(key, max, what) {
    const k = `${this.g.turn}:${key}`;
    this.turnCounts[k] = (this.turnCounts[k] || 0) + 1;
    if (this.turnCounts[k] > max) this.fail(`${what} more than ${max} time${max > 1 ? 's' : ''} in a turn`);
  }

  // the state checks
  structure() {
    const g = this.g;
    this.checks++;
    const seen = new Map();
    for (const p of g.players) {
      const cards = cardsOf(g, p.id);
      if (cards.length !== 60) this.fail(`${p.name} has ${cards.length} cards, not 60`);
      for (const c of cards) {
        if (seen.has(c.id)) this.fail(`card ${c.name} #${c.id} is in two places`);
        seen.set(c.id, p.id);
        if (c.owner !== p.id || !this.ids[p.id].has(c.id)) this.fail(`card ${c.name} #${c.id} is in ${p.name}'s zones but isn't theirs`);
      }
      if (p.prizes.length > this.prizes[p.id]) this.fail(`${p.name}'s Prize cards went up from ${this.prizes[p.id]} to ${p.prizes.length}`);
      if (p.prizes.length < 0 || p.prizes.length > 6) this.fail(`${p.name} has ${p.prizes.length} Prize cards`);
      for (const m of g.inPlay(p.id)) {
        if (!chainOk(g, m.stack)) this.fail(`${m.name} #${m.id} has a broken evolution stack: ${m.stack.map(c => c.name).join(' > ')}`);
        if (m.owner !== p.id) this.fail(`${m.name} is on ${p.name}'s side but belongs to the other player`);
        if (m.damage < 0 || m.damage % 10) this.fail(`${m.name} has ${m.damage} damage`);
        if (g.maxHp(m) <= 0 && m.stack.length) this.fail(`${m.name} has ${g.maxHp(m)} HP`);
        if (m.energy.some(c => c.def.cat !== 'E')) this.fail(`${m.name} has a non-Energy card attached as Energy`);
        if (m.tool && m.tool.def.trainer !== 'Tool') this.fail(`${m.name} has ${m.tool.name} attached as a Tool`);
        if (m.energy.some(c => c.name === "Team Rocket's Energy") && !/^Team Rocket's /.test(m.name)) this.fail(`Team Rocket's Energy stays on ${m.name}`);
      }
      if (p.active && p.bench.includes(p.active)) this.fail(`${p.active.name} is both Active and Benched`);
      for (const m of p.bench) if (m.special || m.poisoned || m.burned) this.fail(`Benched ${m.name} has a Special Condition`);
      if (new Set(p.bench).size !== p.bench.length) this.fail(`a Pokémon is on ${p.name}'s Bench twice`);
    }
    if (g.over) return;
    for (const p of g.players) if (!p.prizes.length && this.prizes[p.id] > 0 && !g.over) this.fail(`${p.name} took their last Prize card but the game goes on`);
  }
  // at a settled point (between actions): Knock Outs done, Bench within its limit, both Active Spots filled
  settled() {
    const g = this.g;
    this.structure();
    if (g.over) return;
    for (const p of g.players) {
      for (const m of g.inPlay(p.id)) if (m.damage >= g.maxHp(m)) this.fail(`${m.name} has ${g.maxHp(m) - m.damage} HP left but is still in play`);
      if (p.bench.length > g.benchLimit(p.id)) this.fail(`${p.name} has ${p.bench.length} Benched Pokémon (limit ${g.benchLimit(p.id)})`);
      if (!p.active) this.fail(`${p.name} has no Active Pokémon`);
      if (p.inPlay) this.fail(`${p.name} still has ${p.inPlay.name} being played`);
      if (g.stadiumName() === 'Festival Grounds') for (const m of g.inPlay(p.id)) if (m.energy.length && (m.special || m.poisoned || m.burned)) this.fail(`${m.name} has a Special Condition under Festival Grounds`);
    }
    this.prizes = g.players.map(p => p.prizes.length);
  }

  // every question a player is asked can be answered: options exist and resolve, and the limits make sense
  request(pid, req) {
    const g = this.g;
    if (pid !== 0 && pid !== 1) this.fail(`a question for player ${pid}`);
    if (req.type !== 'main' && typeof req.prompt !== 'string') this.fail(`a ${req.type} question without a prompt`);
    const opts = req.options || [];
    switch (req.type) {
      case 'main': {
        const p = g.players[pid];
        if (!req.actions.some(a => a.t === 'end')) this.fail('a main-phase question without "end turn"');
        if (new Set(req.actions.map(a => JSON.stringify(a))).size !== req.actions.length) this.fail('a main-phase question offering the same action twice');
        for (const a of req.actions) {
          const c = a.card != null ? p.hand.find(x => x.id === a.card) : null;
          if (a.card != null && !c) this.fail(`a ${a.t} action for a card not in hand`);
          if (a.target != null && !g.monById(a.target)) this.fail(`a ${a.t} action targeting a Pokémon not in play`);
          if ((a.t === 'attack' || a.t === 'ability') && !g.monById(a.mon)) this.fail(`a ${a.t} action for a Pokémon not in play`);
          if (req.again && a.t !== 'attack' && a.t !== 'end') this.fail(`a ${a.t} action offered with a second attack`);
          // the turn's limits, as offered (not only as used)
          if (a.t === 'energy' && p.energyDone) this.fail('an Energy attachment offered after one this turn');
          if (a.t === 'retreat' && p.retreated) this.fail('a retreat offered after one this turn');
          if (a.t === 'stadium' && p.once.stadium === g.turn) this.fail(`${a.name}'s action offered after it was used this turn`);
          if (a.t === 'trainer' && c && c.def.trainer === 'Supporter' && p.supporter) this.fail(`${c.name} offered after a Supporter this turn`);
          if (a.t === 'trainer' && c && c.def.trainer === 'Stadium' && p.stadiumDone) this.fail(`${c.name} offered after a Stadium this turn`);
          if (a.t === 'ability' && !MULTI_USE.has(a.name)) { const m = g.monById(a.mon); if (m && m.used[a.name] === g.turn) this.fail(`${a.name} offered again on the same Pokémon this turn`); }
          if (a.t === 'attack' && g.turn === 1 && pid === g.first) this.fail('an attack offered on the first turn of the player going first');
          if (a.t === 'retreat' && !p.bench.some(m => m.id === a.to)) this.fail('a retreat offered to a Pokémon not on the Bench');
        }
        break;
      }
      case 'cards': {
        if (!opts.length || req.min < 0 || req.max < 1 || req.min > req.max || req.max > opts.length) this.fail(`a card choice with ${opts.length} options, min ${req.min}, max ${req.max} (${req.prompt})`);
        if (new Set(opts).size !== opts.length) this.fail(`a card choice listing a card twice (${req.prompt})`);
        for (const id of [...opts, ...(req.shown || [])]) if (!g.cardById(id)) this.fail(`a card choice with card #${id}, which is nowhere (${req.prompt})`);
        if (req.shown && opts.some(id => !req.shown.includes(id))) this.fail(`a card choice offering a card it doesn't show (${req.prompt})`);
        // the cards are where the question says they are
        const want = { hand: [pid, 'hand'], discard: [pid, 'discard'], deck: [pid, 'deck'], 'deck-top': [pid, 'deck'], 'deck-bottom': [pid, 'deck'], prizes: [pid, 'prizes'], 'opp-hand': [g.opp(pid), 'hand'] }[req.from];
        if (want) for (const id of opts) if (!g.players[want[0]][want[1]].some(c => c.id === id)) this.fail(`a card choice from ${req.from} offering ${(g.cardById(id) || {}).name} from elsewhere (${req.prompt})`);
        if (req.from === 'energy') for (const id of opts) if (!g.players.some(q => g.inPlay(q.id).some(m => m.energy.some(c => c.id === id)))) this.fail(`a choice of attached Energy offering a card that isn't attached (${req.prompt})`);
        break;
      }
      case 'mon':
        if (!opts.length || req.min < 0 || req.max < 1 || req.min > req.max || req.max > opts.length) this.fail(`a Pokémon choice with ${opts.length} options, min ${req.min}, max ${req.max} (${req.prompt})`);
        if (new Set(opts).size !== opts.length) this.fail(`a Pokémon choice listing a Pokémon twice (${req.prompt})`);
        for (const id of opts) if (!g.monById(id)) this.fail(`a Pokémon choice with Pokémon #${id}, which is not in play (${req.prompt})`);
        break;
      case 'option':
        if (!opts.length || new Set(opts.map(o => o.value)).size !== opts.length || opts.some(o => typeof o.label !== 'string')) this.fail(`an option choice with ${opts.length} options (${req.prompt})`);
        break;
      case 'distribute':
        if (!opts.length || !(req.total > 0)) this.fail(`a damage-counter choice with ${opts.length} Pokémon and ${req.total} counters`);
        for (const id of opts) if (!g.monById(id)) this.fail(`a damage-counter choice with Pokémon #${id}, which is not in play`);
        break;
      case 'confirm': break;
      default: this.fail(`a question of unknown type ${req.type}`);
    }
  }

  wrap() {
    const g = this.g, self = this;
    const doAction = g.doAction.bind(g);
    g.doAction = async (pid, act) => {
      const p = g.players[pid];
      if (pid !== g.current) self.fail(`${p.name} acts on the other player's turn`);
      if (act.t === 'energy') self.count(`energy:${pid}`, 1, 'an Energy attached from hand');
      if (act.t === 'retreat') self.count(`retreat:${pid}`, 1, 'a retreat');
      if (act.t === 'stadium') self.count(`stadiumUse:${pid}`, 1, `${act.name}'s action used`);
      if (act.t === 'evolve') {
        const m = g.monById(act.target), c = p.hand.find(x => x.id === act.card);
        const forest = g.stadiumName() === 'Forest of Vitality' && m.def.type === 'Grass' && c.def.type === 'Grass';
        if (!forest && (m.playedTurn === g.turn || m.evolvedTurn === g.turn)) self.fail(`${m.name} evolves the turn it came into play or evolved`);
        if (p.turns === 1) self.fail(`${p.name} evolves on their first turn`);
      }
      if (act.t === 'ability') {
        const fx = ABILITIES[act.name] || {};
        if (!MULTI_USE.has(act.name)) self.count(`ability:${act.mon}:${act.name}`, 1, `${act.name} (the same Pokémon)`);
        if (fx.oncePerPlayer) self.count(`abilityP:${pid}:${fx.oncePerPlayer === true ? act.name : fx.oncePerPlayer}`, 1, `${act.name} (one per player)`);
      }
      // nothing without limit in one turn
      const card = act.card != null ? p.hand.find(x => x.id === act.card) : null;
      self.count(`actions:${pid}`, 120, 'a main-phase action');
      self.count(`kind:${pid}:${act.t}:${act.name || (card && card.name) || ''}`, 30, `${act.t} ${act.name || (card && card.name) || ''}`.trim());
      // a Trainer, Ability or Stadium action that can do nothing at all shouldn't be playable
      const watch = act.t === 'trainer' || act.t === 'ability' || act.t === 'stadium';
      const before = watch ? signature(g, act.card) : null;
      const asked = self.decisions, flips = self.flips, looks = self.looks, peeks = self.peeks, reveals = self.reveals, rng = g.rng.s;
      await doAction(pid, act);
      // nothing changed and nothing was shuffled or flipped
      if (watch && !g.over && g.rng.s === rng && signature(g, act.card) === before) {
        const what = act.t === 'trainer' ? card.name : act.t === 'ability' ? `${act.name} (${(g.monById(act.mon) || {}).name})` : `${act.name}'s action`;
        const m = act.t === 'ability' ? g.monById(act.mon) : null;
        const used = act.t === 'trainer' ? !p.hand.includes(card) : act.t === 'ability' ? !!m && m.used[act.name] === g.turn : p.once.stadium === g.turn;
        const seen = self.flips !== flips || self.looks !== looks || self.peeks !== peeks;   // anything shuffled, flipped, looked at or shown
        const shown = self.peeks !== peeks || self.reveals !== reveals;                     // hidden cards shown to the player
        // nothing happened and nothing could: it shouldn't have been offered
        if (!seen && self.decisions === asked) self.fail(`${what} did nothing at all (no choice, no coin flip, no change) but could be played (by ${p.name})`);
        // the player backed out (chose nothing, saw nothing hidden): the card or the once-per-turn use mustn't be gone
        if (!seen && used) self.fail(`${what} was backed out of (nothing chosen, nothing happened) but is used up (by ${p.name})`);
        // given back: it wasn't done, so it doesn't count toward the turn's limits
        if (!used) {
          if (act.t === 'trainer' && card.def.trainer === 'Supporter') self.uncount(`supporter:${pid}`);
          if (act.t === 'ability') { self.uncount(`ability:${act.mon}:${act.name}`); const fx = ABILITIES[act.name] || {}; if (fx.oncePerPlayer) self.uncount(`abilityP:${pid}:${fx.oncePerPlayer === true ? act.name : fx.oncePerPlayer}`); }
          if (act.t === 'stadium') self.uncount(`stadiumUse:${pid}`);
          self.uncount(`actions:${pid}`);
          self.uncount(`kind:${pid}:${act.t}:${act.name || (card && card.name) || ''}`);
          // given back after showing hidden cards would let a player look again and again
          if (shown) self.fail(`${what} was given back after showing hidden cards (by ${p.name})`);
        }
      }
      self.structure();
    };
    const flip = g.flip.bind(g);
    g.flip = (...a) => { self.flips++; return flip(...a); };
    // looking at hidden cards counts as doing something: searching (and shuffling) a deck that has cards, or
    // looking at or revealing cards
    const shuffle = g.shuffle.bind(g);
    g.shuffle = pid => { if (g.players[pid].deck.length) self.looks++; return shuffle(pid); };
    // and shuffling cards around (a hand going to the bottom of the deck, Prize cards)
    const rshuffle = g.rng.shuffle.bind(g.rng);
    g.rng.shuffle = arr => { if (arr.length >= 2) self.looks++; return rshuffle(arr); };
    const log = g.log.bind(g);
    g.log = (text, opts) => { if (/ looks at | reveals /.test(text)) { self.looks++; self.reveals++; } return log(text, opts); };
    const playTrainer = g.playTrainer.bind(g);
    g.playTrainer = async (pid, card) => {
      const t = card.def.trainer;
      if (t === 'Supporter') {
        self.count(`supporter:${pid}`, 1, 'a Supporter played');
        if (g.turn === 1 && pid === g.first && !['Carmine', "Team Rocket's Proton"].includes(card.name)) self.fail(`${card.name} played on the first turn by the player going first`);
      }
      if (t === 'Stadium') self.count(`stadium:${pid}`, 1, 'a Stadium played');
      await playTrainer(pid, card);
    };
    const attack = g.attack.bind(g);
    g.attack = async (pid, act) => {
      const mon = g.players[pid].active;
      self.count(`attack:${pid}`, mon && g.festivalLead(mon) ? 2 : 1, 'an attack');
      if (g.turn === 1 && pid === g.first) self.fail('an attack on the first turn by the player going first');
      await attack(pid, act);
      self.structure();
    };
    // Knock Outs: the Prizes taken match what was Knocked Out
    const checkKOs = g.checkKOs.bind(g);
    let depth = 0;
    g.checkKOs = async (ctx) => {
      const before = g.players.map(p => p.prizes.length);
      const value = new Map();
      for (const p of g.players) for (const m of g.inPlay(p.id)) value.set(m.id, { pid: p.id, v: g.prizeValue(m), legacy: m.energy.some(c => c.name === 'Legacy Energy') });
      const firstEvent = g.events.length ? g.events[g.events.length - 1].id : -1;
      const legacyBefore = g.players.map(p => p.legacyUsed);
      depth++;
      try { await checkKOs(ctx); } finally { depth--; }
      const kos = g.events.filter(e => e.id > firstEvent && e.kind === 'ko').map(e => value.get(e.mon)).filter(Boolean);
      for (const taker of [0, 1]) {
        const ko = kos.filter(k => k.pid !== taker);
        const sum = ko.reduce((s, k) => s + k.v, 0);
        const taken = before[taker] - g.players[taker].prizes.length;
        const legacy = g.players[1 - taker].legacyUsed && !legacyBefore[1 - taker] ? 1 : 0;
        const lo = Math.min(before[taker], Math.max(0, sum - legacy)), hi = Math.min(before[taker], sum + 2 * ko.length);
        if (taken < lo || taken > hi) self.fail(`${g.players[taker].name} took ${taken} Prize card(s) for Knock Outs worth ${sum} (expected ${lo}-${hi})`);
      }
      if (depth === 0) self.settled();
    };
    const endTurn = g.endTurn.bind(g);
    g.endTurn = async (pid) => { await endTurn(pid); self.settled(); };
    const ask = g.ask.bind(g);
    let asks = 0;
    g.ask = async (pid, req) => {
      self.decisions++;
      if (req.type === 'cards' && (req.shown || ['deck', 'deck-top', 'deck-bottom', 'prizes', 'opp-hand'].includes(req.from))) self.peeks++;
      if (++asks > 30000) self.fail('more than 30000 decisions: the game is not ending');
      self.request(pid, req);
      if (req.type === 'main' && !req.again) self.settled();
      return ask(pid, req);
    };
  }
}

function hash(g) {
  const ids = l => l.map(c => c.id).join(',');
  return [g.turn, g.winner, g.result, ...g.players.map(p => [ids(p.hand), ids(p.deck), ids(p.discard), ids(p.prizes), p.active && p.active.id, p.bench.map(m => m.id + ':' + m.damage).join(';')].join('|'))].join('#');
}

const ODD = flags.odd != null ? +flags.odd : 0.02;
const BUSY = flags.busy != null ? +flags.busy : 0;
// the two seats' players for a game: the AI, chaos, or chaos that hands some decisions to the AI
function agentsFor(mode, seed) {
  const chaos = (pid, ai = null) => new ChaosAgent(seed * 2 + pid + 1, { ai, aiShare: ai ? 0.5 : 0, odd: ODD, busy: BUSY });
  if (mode === 'one') return seed % 2 ? [new PokemonAI(), chaos(1)] : [chaos(0), new PokemonAI()];
  if (mode === 'both') return [chaos(0), chaos(1)];
  if (mode === 'mixed') return [chaos(0, new PokemonAI()), chaos(1, new PokemonAI())];
  return [new PokemonAI(), new PokemonAI()];
}
const MODES = flags.chaos === 'all' ? ['one', 'both', 'mixed'] : [flags.chaos && flags.chaos !== true ? flags.chaos : flags.chaos ? 'one' : 'ai'];

async function play(a, b, seed, check = true, mode = 'ai') {
  const agents = agentsFor(mode, seed);
  const g = new PokemonGame({ db, seed, players: [{ name: a.name, deck: a, agent: agents[0] }, { name: b.name + (a === b ? ' 2' : ''), deck: b, agent: agents[1] }], maxTurns: 90 });
  g.throwErrors = true;
  const checker = check ? new Checker(g, `seed ${seed} ${mode === 'ai' ? '' : mode + ' '}${a.id} vs ${b.id}`) : null;
  let err = null;
  const run = g.start().catch(e => { err = e; });
  let timer;
  const timeout = new Promise(r => { timer = setTimeout(() => r('timeout'), 30000); });
  const r = await Promise.race([run.then(() => 'done'), timeout]);
  clearTimeout(timer);
  return { g, err, timeout: r === 'timeout', checks: checker ? checker.checks : 0, decisions: checker ? checker.decisions : 0 };
}

// --selftest: break the game on purpose in each of the ways above and make sure the checker notices every one
if (flags.selftest) {
  const faults = {
    'a card in two places': g => { const p = g.players[g.current]; if (p.hand.length) p.discard.push(p.hand[0]); },
    'a card lost': g => { const p = g.players[g.current]; if (p.deck.length) p.deck.pop(); },
    'negative damage': g => { g.players[g.current].active.damage = -10; },
    'a Pokémon left at 0 HP': g => { const m = g.players[g.opp(g.current)].active; m.damage = g.maxHp(m) + 50; },
    'Prize cards going up': g => { const p = g.players[g.current]; if (p.deck.length) p.prizes.push(p.deck.shift()); },
    'an over-full Bench': g => { const p = g.players[g.current]; while (p.bench.length < 6) { const c = p.deck.find(x => x.def.cat === 'P' && x.def.stage === 'Basic'); if (!c) break; p.deck.splice(p.deck.indexOf(c), 1); p.bench.push(new (g.monClass())(g, c)); } },
    'a broken evolution stack': g => { const p = g.players[g.current]; const c = p.deck.find(x => x.def.cat === 'T'); if (c) { p.deck.splice(p.deck.indexOf(c), 1); p.active.stack.push(c); } },
    'a second Supporter': g => { g.players[g.current].supporter = false; },
    'a second Energy from hand': g => { g.players[g.current].energyDone = false; },
    // retreat whenever the (reset) flag allows it: the answer is forced, not the AI's
    'a second retreat': (g, req) => { g.players[g.current].retreated = false; const r = req.actions.find(x => x.t === 'retreat'); return r || undefined; },
    // the same, for a second Stadium and a once-per-turn Ability used twice by the same Pokémon
    'a second Stadium': (g, req) => { g.players[g.current].stadiumDone = false; return req.actions.find(x => x.t === 'trainer' && (g.cardById(x.card) || {}).def?.trainer === 'Stadium'); },
    'a second use of a once-per-turn Ability': (g, req) => { for (const m of g.inPlay(g.current)) m.used = {}; return req.actions.find(x => x.t === 'ability' && !MULTI_USE.has(x.name)); },
    'an Energy attachment offered after the one this turn': (g, req) => { if (req.actions.some(x => x.t === 'energy')) g.players[g.current].energyDone = true; },
    'a game that never ends': g => { g.maxTurns = 1e9; g.endGame = () => {}; },
  };
  let caught = 0;
  for (const [name, fault] of Object.entries(faults)) {
    let found = null;
    for (let s = 1; s <= 30 && !found; s++) {
      const g = new PokemonGame({ db, seed: 9000 + s, players: [{ name: 'A', deck: decks[s % decks.length], agent: new PokemonAI() }, { name: 'B', deck: decks[(s + 5) % decks.length], agent: new PokemonAI() }], maxTurns: 90 });
      g.throwErrors = true;
      const checker = new Checker(g, name);
      // inject the fault at the second main-phase decision of turn 4 (once-per-turn faults: at every one from then on),
      // then let the game (and the checker) run on
      const ask = g.ask.bind(g);
      const repeat = /second|offered/.test(name);
      let n = 0;
      g.ask = async (pid, req) => {
        if (req.type === 'main' && g.turn >= 4 && (repeat || (g.turn === 4 && ++n === 2))) {
          const forced = fault(g, req);
          if (forced) { g.pendingAsk = null; return forced; }
        }
        return ask(pid, req);
      };
      let timer;
      const r = await Promise.race([g.start().then(() => 'done', e => e), new Promise(res => { timer = setTimeout(() => res('timeout'), 3000); })]);
      clearTimeout(timer);
      if (r instanceof Violation) found = r.message;
      else if (r === 'timeout') found = 'timeout (caught by the harness)';
      if (checker) g.over = true;
    }
    console.log(`${found ? 'caught ' : 'MISSED '} ${name}${found ? `: ${found}` : ''}`);
    if (found) caught++;
  }
  console.log(`${caught}/${Object.keys(faults).length} injected faults caught`);
  process.exit(caught === Object.keys(faults).length ? 0 : 1);
}

const pool = flags.deck ? decks.filter(d => d.id === flags.deck) : decks;
const stats = { games: 0, checks: 0, decisions: 0, errors: 0, timeouts: 0, unfinished: 0, replays: 0, replayMismatch: 0, turnCap: 0, violations: {}, byDeck: {}, wins: {}, byMode: {} };
const reports = {};
const t0 = Date.now();
let seed = +(flags.seed || 1);
for (const a of pool) {
  for (const b of decks) {
    if (!flags.deck && decks.indexOf(b) < decks.indexOf(a)) continue;
    for (let i = 0; i < PER; i++) {
      seed++;
      const [x, y] = i % 2 ? [b, a] : [a, b];
      const mode = MODES[stats.games % MODES.length];
      const { g, err, timeout, checks, decisions } = await play(x, y, seed, true, mode);
      stats.games++; stats.checks += checks; stats.decisions += decisions;
      stats.byMode[mode] = (stats.byMode[mode] || 0) + 1;
      for (const d of [x, y]) stats.byDeck[d.id] = (stats.byDeck[d.id] || 0) + 1;
      if (g.winner != null) { const w = [x, y][g.winner].id; stats.wins[w] = (stats.wins[w] || 0) + 1; }
      if (/Turn limit/.test(g.result)) stats.turnCap++;
      if (timeout) { stats.timeouts++; console.log(`TIMEOUT seed ${seed} ${mode} ${x.id} vs ${y.id} at turn ${g.turn}`); continue; }
      if (err instanceof Violation) {
        const kind = err.message.replace(/[0-9#]+/g, 'N').replace(/(has|of|by|from|on|Active|Benched|card|for) .*$/, '$1 …');
        stats.violations[kind] = (stats.violations[kind] || 0) + 1;
        reports[kind] = reports[kind] || [];
        if (reports[kind].length < MAX_REPORTS) { reports[kind].push(err.detail); console.log('VIOLATION ' + err.detail); }
        continue;
      }
      if (err) { stats.errors++; console.log(`ERROR seed ${seed} ${mode} ${x.id} vs ${y.id} turn ${g.turn}: ${err.stack.split('\n').slice(0, 5).join(' | ')}`); continue; }
      if (!g.over) { stats.unfinished++; console.log(`UNFINISHED seed ${seed} ${mode} ${x.id} vs ${y.id}`); continue; }
      // the same seed gives the same game
      if (REPLAY_EVERY && stats.games % REPLAY_EVERY === 0) {
        const again = await play(x, y, seed, false, mode);
        stats.replays++;
        if (hash(again.g) !== hash(g)) { stats.replayMismatch++; console.log(`REPLAY MISMATCH seed ${seed} ${x.id} vs ${y.id}`); }
      }
    }
  }
}
const nv = Object.values(stats.violations).reduce((s, n) => s + n, 0);
console.log(`\n${stats.games} games (${Object.entries(stats.byMode).map(([k, n]) => `${k} ${n}`).join(', ')}), ${stats.decisions} decisions, ${stats.checks} state checks, ${nv} games with a violation, ${stats.errors} errors, ${stats.timeouts} timeouts, ${stats.unfinished} unfinished, ${stats.turnCap} hit the turn cap, ${stats.replays} replays (${stats.replayMismatch} mismatches), ${((Date.now() - t0) / 1000).toFixed(1)}s`);
for (const [k, n] of Object.entries(stats.violations)) console.log(`  ${n} x ${k}`);
console.log('games per deck: ' + Object.entries(stats.byDeck).map(([k, n]) => `${k} ${n}`).join(', '));
console.log('win rate: ' + Object.keys(stats.byDeck).map(k => `${k} ${(100 * (stats.wins[k] || 0) / stats.byDeck[k]).toFixed(0)}%`).join(', '));
process.exit(nv || stats.errors || stats.timeouts || stats.unfinished || stats.replayMismatch ? 1 : 0);
