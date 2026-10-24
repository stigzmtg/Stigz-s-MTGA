// Invariant checker for the One Piece engine: plays games across every pairing of decks and checks the game state
// after every action, battle and turn end, and at every Main Phase decision:
//  - each player always has exactly their cards (Leader + 50) across their areas, and no card is in two places;
//    every card's area matches the list it's in; Leaders stay in the Leader area
//  - DON!!: each player has exactly 10 (DON!! deck + cost area active and rested + given), none negative, given only
//    to Leaders and Characters on the field
//  - at most 5 Characters and 1 Stage; nothing in limbo, no battle and no pending effects between actions
//  - the turn's rules hold as offered: no attack on a player's first turn (6-5-6-1), attackers active and allowed
//    (Rush for Characters played this turn), targets the opponent's Leader or rested Characters (or what an effect
//    allows), plays only within the active DON!!, [Activate: Main] effects within [Once Per Turn]
//  - every question a player is asked can be answered: options exist and are real cards, no duplicates,
//    0 <= min <= max <= options, cards offered from the area the question names
//  - every game ends (a win, a draw or the turn cap) without hanging, the loser is marked, and replaying the same
//    seed gives the same game
// Usage: node tools/optcg/invariants.mjs [games per pairing=6] [--deck=id] [--decks=a,b] [--seed=N]
//        [--chaos=one|both|mixed|all] [--odd=0.02] [--busy=0.9] [--max-reports=5] [--replay=50] [--selftest]
import { OnePieceGame } from '../../src/optcg/game.js';
import { OnePieceAI } from '../../src/optcg/ai.js';
import { ChaosAgent } from './chaos.mjs';
import { loadDb, loadDecks } from './lib.mjs';

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const PER = +(args.find(a => !a.startsWith('--')) || 6);
const MAX_REPORTS = +(flags['max-reports'] || 5);
const REPLAY_EVERY = +(flags.replay || 50);
const db = loadDb();
let decks = loadDecks();
if (flags.decks) decks = decks.filter(d => flags.decks.split(',').includes(d.id));

class Violation extends Error {}
const ZONES = ['hand', 'deck', 'trash', 'life'];

class Checker {
  constructor(g, label) {
    this.g = g; this.label = label;
    this.ids = g.players.map(p => new Set([p.leader.uid, ...p.deck.map(c => c.uid)]));
    this.checks = 0; this.decisions = 0;
    this.wrap();
  }
  fail(msg) {
    const g = this.g;
    const e = new Violation(msg);
    const zones = g.players.map(p => `${p.name}: deck ${p.deck.length}, hand ${p.hand.length}, trash ${p.trash.length}, life ${p.life.length}, chars ${p.characters.length}, DON ${p.donDeck}/${p.donActive}/${p.donRested}`).join(' / ');
    e.detail = `${this.label} turn ${g.turn}: ${msg}\n    [${zones}]\n    ` + g.logs.slice(-12).map(l => l.text).join('\n    ');
    throw e;
  }
  structure() {
    const g = this.g;
    this.checks++;
    const seen = new Map();
    for (const p of g.players) {
      const all = [p.leader, ...p.characters, ...(p.stage ? [p.stage] : []), ...p.hand, ...p.deck, ...p.trash, ...p.life];
      if (g.limbo && g.limbo.owner === p.id) all.push(g.limbo);
      if (all.length !== this.ids[p.id].size) this.fail(`${p.name} has ${all.length} cards, not ${this.ids[p.id].size}`);
      for (const c of all) {
        if (seen.has(c.uid)) this.fail(`card ${c.name} #${c.uid} is in two places`);
        seen.set(c.uid, p.id);
        if (c.owner !== p.id || !this.ids[p.id].has(c.uid)) this.fail(`card ${c.name} #${c.uid} is in ${p.name}'s areas but isn't theirs`);
      }
      if (p.leader.zone !== 'leader') this.fail(`${p.name}'s Leader left the Leader area`);
      for (const z of ZONES) for (const c of p[z]) if (c.zone !== z) this.fail(`${c.name} is in ${z} but thinks it is in ${c.zone}`);
      for (const c of p.characters) { if (c.zone !== 'characters' || c.cat !== 'C') this.fail(`${c.name} in the Character area (${c.zone}, ${c.cat})`); }
      if (p.stage && (p.stage.zone !== 'stage' || p.stage.cat !== 'S')) this.fail(`${p.stage.name} in the Stage area`);
      if (p.characters.length > 5) this.fail(`${p.name} has ${p.characters.length} Characters`);
      if (new Set(p.characters).size !== p.characters.length) this.fail('a Character in play twice');
      const given = g.givenDon(p.id);
      if ([p.donDeck, p.donActive, p.donRested].some(n => n < 0 || !Number.isInteger(n))) this.fail(`${p.name}'s DON!! counts ${p.donDeck}/${p.donActive}/${p.donRested}`);
      if (p.donDeck + p.donActive + p.donRested + given !== 10) this.fail(`${p.name} has ${p.donDeck + p.donActive + p.donRested + given} DON!! cards, not 10`);
      for (const c of [...p.hand, ...p.deck, ...p.trash, ...p.life]) if (c.don) this.fail(`${c.name} in ${c.zone} has DON!! given`);
      if (p.stage && p.stage.don) this.fail('a Stage has DON!! given');
      for (const c of [p.leader, ...p.characters]) if (c.don < 0) this.fail(`${c.name} has ${c.don} DON!!`);
    }
    if (g.over && g.winner != null && !g.players[g.opp(g.winner)].lost) this.fail('the loser is not marked as lost');
  }
  settled() {
    const g = this.g;
    this.structure();
    if (g.over) return;
    if (g.limbo) this.fail(`${g.limbo.name} is still in limbo`);
    if (g.fight || g.battle) this.fail('a battle is still going on');
    if (g.pending.length) this.fail(`${g.pending.length} effects still pending`);
  }
  request(pid, req) {
    const g = this.g;
    if (pid !== 0 && pid !== 1) this.fail(`a question for player ${pid}`);
    if (typeof req.prompt !== 'string' || !req.prompt) this.fail(`a ${req.type} question without a prompt`);
    const opts = req.options || [];
    switch (req.type) {
      case 'main': {
        const p = g.players[pid];
        if (pid !== g.current) this.fail('a Main Phase question for the other player');
        if (!req.actions.some(a => a.t === 'end')) this.fail('a Main Phase question without "end"');
        if (new Set(req.actions.map(a => JSON.stringify(a))).size !== req.actions.length) this.fail('the same action offered twice');
        for (const a of req.actions) {
          if (a.t === 'end') continue;
          if (typeof a.label !== 'string') this.fail(`an action without a label: ${JSON.stringify(a)}`);
          if (a.t === 'play') {
            const c = p.hand.find(x => x.uid === a.card);
            if (!c) this.fail('a play for a card not in hand');
            if (g.cost(c) > p.donActive) this.fail(`${c.name} offered with ${p.donActive} DON!! for cost ${g.cost(c)}`);
            if (c.cat === 'L') this.fail('a Leader offered from the hand');
          }
          if (a.t === 'don') { if (!p.donActive) this.fail('DON!! giving offered without active DON!!'); const c = g.cardByUid(a.target); if (!c || c.owner !== pid || (c.cat !== 'L' && c.cat !== 'C') || !g.onField(c)) this.fail('DON!! offered to a card that can\'t take it'); }
          if (a.t === 'attack') {
            const at = g.cardByUid(a.card), tg = g.cardByUid(a.target);
            if (g.turn === (pid === g.first ? 1 : 2)) this.fail('an attack offered on the player\'s first turn (6-5-6-1)');
            if (!at || at.owner !== pid || !g.onField(at) || at.rested) this.fail('an attack by a card that can\'t attack');
            if (at.cat === 'C' && at.playedTurn === g.turn && !g.has(at, 'Rush') && !g.has(at, 'Rush: Character')) this.fail(`${at.name} attacks the turn it was played without [Rush]`);
            if (!tg || tg.owner === pid || !g.onField(tg) || (tg.cat === 'C' && !tg.rested && !g.flag(at, 'canAttackActive')) || tg.cat === 'S') this.fail(`${at.name} offered an attack on ${tg && tg.name}`);
          }
          if (a.t === 'activate') {
            const c = g.cardByUid(a.card);
            const ab = c && g.abilities(c).find(x => x.idx === a.ability);
            if (!ab || ab.kind !== 'activate' || c.owner !== pid || !g.onField(c)) this.fail('an activate action for something that isn\'t an [Activate: Main] effect on the field');
            if (ab.once && c.used[ab.idx] === g.turn) this.fail(`${c.name}'s [Once Per Turn] effect offered again`);
          }
        }
        break;
      }
      case 'cards': case 'order': {
        if (!opts.length) this.fail(`a ${req.type} question with no options (${req.prompt})`);
        if (req.type === 'cards' && (req.min < 0 || req.max < 1 || req.min > req.max || req.max > opts.length)) this.fail(`a card choice with ${opts.length} options, min ${req.min}, max ${req.max} (${req.prompt})`);
        if (new Set(opts).size !== opts.length) this.fail(`a card listed twice (${req.prompt})`);
        for (const id of [...opts, ...(req.shown || [])]) if (!g.cardByUid(id)) this.fail(`card #${id} is nowhere (${req.prompt})`);
        if (req.shown && opts.some(id => !req.shown.includes(id))) this.fail(`a card offered that isn't shown (${req.prompt})`);
        if (req.type === 'cards') {
          const zoneOk = { hand: c => c.zone === 'hand' && c.owner === pid, 'opp-hand': c => c.zone === 'hand' && c.owner !== pid, trash: c => c.zone === 'trash', deck: c => c.zone === 'deck', life: c => c.zone === 'life', field: c => g.onField(c) }[req.from];
          if (!zoneOk) this.fail(`a card choice from "${req.from}"`);
          for (const id of opts) { const c = g.cardByUid(id); if (!zoneOk(c) && !(req.from === 'hand' && c.zone === 'trash')) this.fail(`a card choice from ${req.from} offering ${c.name} from ${c.zone} (${req.prompt})`); }
        }
        break;
      }
      case 'option':
        if (opts.length < 2 || new Set(opts.map(o => o.value)).size !== opts.length || opts.some(o => typeof o.label !== 'string')) this.fail(`an option choice with ${opts.length} options (${req.prompt})`);
        break;
      case 'number': if (!(req.min <= req.max) || req.min < 0) this.fail(`a number from ${req.min} to ${req.max}`); break;
      case 'blocker': {
        if (!opts.length) this.fail('a blocker question with no blockers');
        for (const id of opts) { const c = g.cardByUid(id); if (!c || c.owner !== pid || c.rested || !g.has(c, 'Blocker')) this.fail(`${c && c.name} offered as a blocker`); }
        break;
      }
      case 'counter': {
        if (!opts.length) this.fail('a counter question with no options');
        const p = g.players[pid];
        for (const o of opts) {
          const c = p.hand.find(x => x.uid === o.card);
          if (!c) this.fail('a counter from outside the hand');
          if (o.kind === 'counter' && !(c.def.counter > 0)) this.fail(`${c.name} offered as a Counter`);
          if (o.kind === 'event' && g.cost(c) > p.donActive) this.fail(`${c.name} offered without the DON!! to pay`);
        }
        break;
      }
      case 'trigger': { const c = g.cardByUid(req.card); if (!c || !c.def.trigger) this.fail('a trigger question for a card without [Trigger]'); break; }
      case 'confirm': case 'mulligan': break;
      default: this.fail(`a question of unknown type ${req.type}`);
    }
  }
  wrap() {
    const g = this.g, self = this;
    const doAction = g.doAction.bind(g);
    g.doAction = async (pid, act) => {
      if (pid !== g.current) self.fail('an action on the other player\'s turn');
      await doAction(pid, act);
      self.settled();
    };
    const endPhase = g.endPhase.bind(g);
    g.endPhase = async pid => { await endPhase(pid); self.settled(); };
    const ask = g.ask.bind(g);
    let asks = 0;
    g.ask = async (pid, req) => {
      self.decisions++;
      if (++asks > 40000) self.fail('more than 40000 decisions: the game is not ending');
      self.request(pid, req);
      if (req.type === 'main') self.settled(); else self.structure();
      return ask(pid, req);
    };
  }
}

function hash(g) {
  const ids = l => l.map(c => c.uid).join(',');
  return [g.turn, g.winner, g.result, ...g.players.map(p => [ids(p.hand), ids(p.deck), ids(p.trash), ids(p.life), p.characters.map(c => `${c.uid}:${c.rested ? 'r' : ''}${c.don}`).join(';'), p.donDeck, p.donActive, p.donRested].join('|'))].join('#');
}

const ODD = flags.odd != null ? +flags.odd : 0.02;
const BUSY = flags.busy != null ? +flags.busy : 0;
function agentsFor(mode, seed) {
  const chaos = (pid, ai = null) => new ChaosAgent(seed * 2 + pid + 1, { ai, aiShare: ai ? 0.5 : 0, odd: ODD, busy: BUSY });
  if (mode === 'one') return seed % 2 ? [new OnePieceAI(), chaos(1)] : [chaos(0), new OnePieceAI()];
  if (mode === 'both') return [chaos(0), chaos(1)];
  if (mode === 'mixed') return [chaos(0, new OnePieceAI()), chaos(1, new OnePieceAI())];
  return [new OnePieceAI(), new OnePieceAI()];
}
const MODES = flags.chaos === 'all' ? ['one', 'both', 'mixed'] : [flags.chaos && flags.chaos !== true ? flags.chaos : flags.chaos ? 'one' : 'ai'];

async function play(a, b, seed, check = true, mode = 'ai') {
  const agents = agentsFor(mode, seed);
  const g = new OnePieceGame({ db, seed, players: [{ name: a.name, deck: a, agent: agents[0] }, { name: b.name + (a === b ? ' 2' : ''), deck: b, agent: agents[1] }], maxTurns: 80 });
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

// --selftest: break the game on purpose and make sure the checker notices each one
if (flags.selftest) {
  const faults = {
    'a card in two places': g => { const p = g.players[g.current]; if (p.hand.length) p.trash.push(p.hand[0]); },
    'a card lost': g => { const p = g.players[g.current]; if (p.deck.length) p.deck.pop(); },
    'a DON!! card created': g => { g.players[g.current].donActive++; },
    'a 6th Character': g => { const p = g.players[g.current]; while (p.characters.length < 6) { const c = p.deck.find(x => x.cat === 'C'); if (!c) break; p.deck.splice(p.deck.indexOf(c), 1); c.zone = 'characters'; p.characters.push(c); } },
    'a card in the wrong area': g => { const p = g.players[g.current]; if (p.hand.length) p.hand[0].zone = 'trash'; },
    'an attack on the first turn': (g, req) => { if (g.turn <= 2) { g.players[g.current].turns = 5; return undefined; } },
    'a [Once Per Turn] effect twice': (g, req) => { for (const c of g.field(g.current)) c.used = {}; const a = req.actions.find(x => x.t === 'activate' && g.abilities(g.cardByUid(x.card)).find(b => b.idx === x.ability).once); if (a) { const c = g.cardByUid(a.card); const ab = g.abilities(c).find(b => b.idx === a.ability); c.used[ab.idx] = g.turn; } },
    'a play without the DON!!': g => { const p = g.players[g.current]; p.donRested += p.donActive; p.donActive = 0; p.hand.forEach(c => { c.def = { ...c.def, cost: 0 }; }); setTimeout(() => p.hand.forEach(c => { c.def = g.db[c.id]; }), 0); },
    'a game that never ends': g => { g.maxTurns = 1e9; g.endGame = () => {}; g.ruleCheck = () => {}; },
  };
  let caught = 0;
  for (const [name, fault] of Object.entries(faults)) {
    let found = null;
    for (let s = 1; s <= 30 && !found; s++) {
      const g = new OnePieceGame({ db, seed: 9000 + s, players: [{ name: 'A', deck: decks[s % decks.length], agent: new OnePieceAI() }, { name: 'B', deck: decks[(s + 1) % decks.length], agent: new OnePieceAI() }], maxTurns: 80 });
      g.throwErrors = true;
      new Checker(g, name);
      const ask = g.ask.bind(g);
      const early = /first turn/.test(name);
      const repeat = /twice/.test(name);
      let n = 0;
      g.ask = async (pid, req) => {
        if (req.type === 'main' && (early ? g.turn <= 2 : g.turn >= 4) && (repeat || early || (g.turn === 4 && ++n === 2))) {
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
      g.over = true;
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
      if (timeout) { stats.timeouts++; console.log(`TIMEOUT seed ${seed} ${mode} ${x.id} vs ${y.id} at turn ${g.turn}: ${g.pendingAsk ? JSON.stringify(g.pendingAsk.req).slice(0, 200) : ''}`); continue; }
      if (err instanceof Violation) {
        const kind = err.message.replace(/[0-9#]+/g, 'N').replace(/(has|of|by|from|on|for|offered) .*$/, '$1 …');
        stats.violations[kind] = (stats.violations[kind] || 0) + 1;
        reports[kind] = reports[kind] || [];
        if (reports[kind].length < MAX_REPORTS) { reports[kind].push(err.detail); console.log('VIOLATION ' + err.detail); }
        continue;
      }
      if (err) { stats.errors++; console.log(`ERROR seed ${seed} ${mode} ${x.id} vs ${y.id} turn ${g.turn}: ${err.stack.split('\n').slice(0, 6).join(' | ')}`); continue; }
      if (!g.over) { stats.unfinished++; console.log(`UNFINISHED seed ${seed} ${mode} ${x.id} vs ${y.id}`); continue; }
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
console.log('win rate: ' + Object.keys(stats.byDeck).map(k => `${k} ${(100 * (stats.wins[k] || 0) / stats.byDeck[k]).toFixed(0)}%`).join(', '));
process.exit(nv || stats.errors || stats.timeouts || stats.unfinished || stats.replayMismatch ? 1 : 0);
