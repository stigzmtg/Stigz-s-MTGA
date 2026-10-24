// Your record and replays. Every finished game is remembered (deck, opponents, result, turns); the most recent ones
// also keep a replay. Both engines are deterministic, so a replay is just the seed, the seats and every decision in
// order: solo games record them with a Recorder around each seat, online games already have them in the room's
// decision log. Playing one back runs a fresh game whose seats all answer from that list (ReplayAgent), paced and
// paused by a ReplayControl.
import { packValue, unpackValue } from '../net/lockstep.js';
import { safeStorage } from './common.js';
import { customDeck, packDeck } from './customdecks.js';

const REC_KEY = 'pa-records';
const REPLAY_KEY = id => `pa-replay-${id}`;
const KEEP_RECORDS = 300, KEEP_REPLAYS = 8;   // replays per game

export function loadRecords() {
  try { const r = JSON.parse(safeStorage.getItem(REC_KEY) || '[]'); return Array.isArray(r) ? r : []; } catch { return []; }
}
export function loadReplay(id) { try { return JSON.parse(safeStorage.getItem(REPLAY_KEY(id)) || 'null'); } catch { return null; } }

// wins, losses and draws, for one deck or a whole game
export function tally(kind, deckId = null) {
  const t = { win: 0, loss: 0, draw: 0, games: 0 };
  for (const r of loadRecords()) if (r.kind === kind && (!deckId || r.deck.id === deckId)) { t[r.result]++; t.games++; }
  return t;
}

// ---- recording a solo game: wrap every seat before the game starts
export class Recorder {
  constructor() { this.log = []; this.ops = []; }
  wrap(inner) {
    return {
      ask: async (game, pid, req) => {
        const i = this.log.length;
        this.log.push(null);
        const v = await inner.ask(game, pid, req);
        const packed = packValue(v, req.type);
        const ops = this.ops.length ? this.ops.splice(0) : null;
        this.log[i] = ops ? [i, pid, packed, ops] : [i, pid, packed];
        // the game sees exactly what a replay will hand it
        return unpackValue(packed, req.type);
      },
    };
  }
  entries() { const out = []; for (const e of this.log) { if (!e) break; out.push(e); } return out; }
}

function resultOf(game, me) {
  if (game.winner == null) return game.players[me] && game.players[me].lost ? 'loss' : 'draw';
  return game.winner === me ? 'win' : 'loss';
}

// call when a game is over: remembers it once (not for replays or for people watching)
const saved = new WeakSet();
export function recordGame(session, kind) {
  const { game } = session;
  if (!game.over || saved.has(game) || session.replay || session.spectator || game.error) return null;
  saved.add(game);
  const side = kind === 'pk' || kind === 'op';   // the Pokémon and One Piece games share field names (turn, result, human)
  const me = side ? (session.me || 0) : (session.human.pid != null ? session.human.pid : 0);
  const p = game.players[me];
  const log = session.online
    ? [...session.online.net.log.values()].sort((a, b) => a[0] - b[0]).filter((e, i) => e[0] === i)
    : session.recorder ? session.recorder.entries() : null;
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const rec = {
    id, kind, at: Date.now(), mode: session.online ? 'online' : 'solo', seat: me,
    deck: { id: p.deckId, name: p.deckName },
    opps: game.players.filter((_, i) => i !== me).map(o => ({ name: o.name, deck: o.deckName })),
    result: resultOf(game, me), turns: side ? game.turn : game.turnNumber,
    reason: side ? game.result || '' : game.resultText || '',
    replay: !!(log && log.length),
  };
  if (rec.replay) {
    const rep = {
      v: 1, kind, seed: game.seed, seat: me, maxTurns: game.maxTurns, cal: !!game.continueAfterHumanLoss,
      players: game.players.map(q => ({ name: q.name, deckId: q.deckId, human: side ? !!q.human : !!q.isHuman, ...(customDeck(q.deckId) ? { deck: packDeck(customDeck(q.deckId)) } : {}) })),
      log,
    };
    if (!store(REPLAY_KEY(id), rep)) rec.replay = false;
  }
  const all = [rec, ...loadRecords()];
  // keep the newest replays of each game, and a long history of results
  const kept = { mtg: 0, pk: 0, op: 0 };
  for (const r of all) if (r.replay && ++kept[r.kind] > KEEP_REPLAYS) { safeStorage.setItem(REPLAY_KEY(r.id), ''); try { localStorage.removeItem(REPLAY_KEY(r.id)); } catch { /* blocked */ } r.replay = false; }
  store(REC_KEY, all.slice(0, KEEP_RECORDS));
  return rec;
}

function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch {
    // full: drop the oldest replays and try once more
    try {
      const recs = loadRecords();
      for (const r of recs.slice().reverse()) if (r.replay) { localStorage.removeItem(REPLAY_KEY(r.id)); r.replay = false; break; }
      localStorage.setItem(REC_KEY, JSON.stringify(recs));
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch { return false; }
  }
}

// ---- playing one back
const sleep = ms => new Promise(r => setTimeout(r, ms));
export class ReplayControl {
  constructor(total, onChange) {
    this.total = total; this.pos = 0; this.speed = 1; this.paused = false; this.ended = false;
    this.onChange = onChange || (() => {});
    this.wakers = [];
  }
  // wait out a move's pause, and for as long as the replay is paused
  async gate(ms) {
    if (ms > 0) await sleep(ms / this.speed);
    while (this.paused && !this.stepping) await new Promise(r => this.wakers.push(r));
    this.stepping = false;
  }
  wake() { const w = this.wakers; this.wakers = []; w.forEach(f => f()); }
  setPaused(p) { this.paused = p; if (!p) this.wake(); this.onChange(); }
  setSpeed(s) { this.speed = s; this.onChange(); }
  step() { this.stepping = true; this.wake(); }
  end() { if (!this.ended) { this.ended = true; this.onChange(); } }
}

export class ReplayAgent {
  // delayOf(req, packedValue): how long the move takes at normal speed
  constructor(log, ctl, applyOps, delayOf) { this.log = log; this.ctl = ctl; this.applyOps = applyOps; this.delayOf = delayOf; }
  async ask(game, pid, req) {
    const e = this.log[this.ctl.pos];
    // the recording ends here (a game left early), or no longer matches: stop quietly
    if (!e || e[1] !== pid) { this.ctl.end(); return new Promise(() => {}); }
    this.ctl.pos++;
    await this.ctl.gate(this.delayOf(req, e[2]));
    if (e[3] && this.applyOps) for (const op of e[3]) await this.applyOps(game, op);
    this.ctl.onChange();
    return unpackValue(e[2], req.type);
  }
}

// how long each kind of move takes on screen at normal speed
export const mtgDelay = (req, v) => (req.type === 'priority' ? (v === 0 ? 12 : 650) : req.type === 'attackers' || req.type === 'blockers' ? 700 : 320);
export const pkDelay = (req, v) => (req.type === 'main' ? (v && v.t === 'end' ? 450 : 800) : 500);
export const opDelay = (req, v) => (req.type === 'main' ? (v && v.t === 'end' ? 450 : v && v.t === 'don' ? 350 : 800) : req.type === 'counter' ? 650 : 500);
