// Lockstep online play. Every browser runs the same deterministic game (same seed, same decks) and the
// players only exchange their decisions. Each decision is the answer to one engine "ask"; asks happen in the
// same order everywhere, so the n-th ask is identified by its sequence number.
//
// Transport: the artifact room's presence, which every admitted viewer may set. Each peer publishes a sliding
// window of the decisions it produced ("o"), the first sequence number it is missing ("n"), and history it
// serves to peers that fell behind ("h"). The host also publishes the room config ("cfg") and produces the
// decisions of AI seats and of seats it took over. Everyone keeps the full log, so a reload replays locally.

import { GAME_VERSION, BUILD_TIME } from './version.js';

export const PROTOCOL = 1;
const PRESENCE_BUDGET = 3900; // presence objects are capped at 4 KiB of JSON (the room's other fields included)

// ---- compact decision encoding
const ACTION_KEYS = ['type', 'cardId', 'optionKey', 'abilityKey', 'color'];
// a Pokémon or One Piece main-phase move (what matchAction compares)
const PK_ACTION_KEYS = ['t', 'card', 'target', 'mon', 'name', 'to', 'src', 'ability', 'n'];
export function packValue(v, type) {
  if (v === undefined) return null;
  if (type === 'main' && v && typeof v === 'object' && !Array.isArray(v) && typeof v.t === 'string') {
    const o = {};
    for (const k of PK_ACTION_KEYS) if (v[k] !== undefined) o[k] = v[k];
    return o;
  }
  if (type === 'priority' && v && typeof v === 'object' && !Array.isArray(v) && typeof v.type === 'string') {
    if (v.type === 'pass') return 0;
    const o = {};
    for (const k of ACTION_KEYS) if (v[k] !== undefined) o[k] = v[k];
    return o;
  }
  return JSON.parse(JSON.stringify(v));
}
// 0 means "pass" only for priority decisions (elsewhere 0 is a real answer, e.g. player 0)
export function unpackValue(x, type) { return x === 0 && type === 'priority' ? { type: 'pass' } : x; }

const jsonSize = o => JSON.stringify(o).length * 1.1; // close enough for mostly-ASCII payloads

// A short fingerprint of the game at an ask, sent with each decision: whoever plays that decision compares it with
// its own copy of the game at the same ask, so two games that drifted apart show at once instead of as a silent
// wait on a move the other side never asks for. (The turn, life totals and zone sizes, the stack, and the id
// counter: one card too many or too few anywhere changes it.)
const PLAYER_KEYS = ['life', 'hand', 'library', 'graveyard', 'exile', 'command', 'deck', 'discard', 'lost', 'prizes', 'bench', 'trash', 'characters', 'donDeck', 'don'];
export function syncCheck(game, req, raw = false) {
  let s = `${req && req.type}:${game.turnNumber ?? game.turn ?? ''}`;
  for (const p of game.players || []) {
    s += ';';
    for (const k of PLAYER_KEYS) { const v = p[k]; if (typeof v === 'number') s += v + ','; else if (Array.isArray(v)) s += v.length + ','; }
  }
  for (const k of ['battlefield', 'stack']) if (Array.isArray(game[k])) s += `|${game[k].length}`;
  if (typeof game.nextId === 'number') s += `|${game.nextId}`;
  if (raw) return s;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36).slice(-5);
}

// ---- the session
export class Lockstep {
  // channel: { presence(patch), peers(), onPeers(fn) }  (a named room, or a test double)
  constructor({ channel, cid, nick, cfg, seat, onChange, storage }) {
    this.channel = channel;
    this.cid = cid;
    this.nick = nick;
    this.cfg = cfg;               // { code, game, seed, seats: [{ k: 'h'|'a', c: cid, n: nick, d: deckId }], host: cid, subs: { pid: seq } }
    this.seat = seat;             // local seat (pid) or null for spectators
    this.onChange = onChange || (() => {});
    this.storage = storage || null;
    this.seq = 0;                 // next ask
    this.log = new Map();         // seq -> [seq, pid, value, ops?]
    this.mine = [];               // entries this peer produced, newest last
    this.waiting = null;          // { seq, pid, resolve }
    this.need = null;
    this.serve = null;            // seq we are serving history from
    this.peerState = new Map();   // cid -> { peer, presence }
    this.saveTimer = null;
    this.desync = null;           // { seq, pid, at } once a decision came from a game that differs from ours
    this.clash = null;            // { cid, nick, newer } while a player here runs another version of the rules
    this.onDesync = null;         // set by the screen: what to do about it (see the agents below)
    this.restore();
    this.unsub = channel.onPeers(() => this.ingest());
    this.flush();
    this.ingest();
    // while waiting, every second: re-check (a stalled wait turns into a history request even if nobody else changes)
    // and send our presence again. Rooms can drop an update or deliver two out of order (the older one overwriting
    // the newer), and a peer that's waiting sends nothing more on its own: without the resend each side could sit
    // waiting on the other, the one holding the decision the other needs having last been seen before it made it.
    this.timer = setInterval(() => { if (this.waiting) { this.ingest(); this.flush(); } }, 1000);
  }

  get isHost() { return this.cfg.host === this.cid; }
  // after closing, nothing more goes out: leaving cancels the open prompt, and that answer must not become a move
  close() { this.closed = true; if (this.unsub) this.unsub(); clearInterval(this.timer); this.persist(); }
  // close and drop the saved log: the next copy of this game replays the room's history instead
  forget() { this.forgotten = true; this.close(); try { if (this.storage) this.storage.removeItem(this.key()); } catch { /* storage blocked */ } }

  // who produces the decision for `pid` at `seq`
  producerOf(pid, seq) {
    const s = this.cfg.seats[pid];
    if (!s || s.k === 'a') return this.cfg.host;
    const sub = this.cfg.subs && this.cfg.subs[pid];
    if (sub != null && seq >= sub) return this.cfg.host;
    return s.c;
  }

  nextSeq() { return this.seq++; }
  liveEdge() { let m = -1; for (const k of this.log.keys()) if (k > m) m = k; return m; }
  catchingUp() { return this.seq <= this.liveEdge(); }

  // a decision this peer made (its human seat, or an AI seat / takeover on the host)
  publish(seq, pid, value, ops, type, check) {
    if (this.closed) return;
    const e = [seq, pid, packValue(value, type)];
    if (ops && ops.length) e.push(ops);
    if (check) { if (e.length === 3) e.push(0); e.push(check); }
    this.log.set(seq, e);
    this.mine.push(e);
    if (this.mine.length > 400) this.mine.splice(0, this.mine.length - 400);
    this.flush();
    this.schedulePersist();
  }

  // resolve with the entry for `seq` (from the log, or when a peer publishes it), or with null when it's ours to
  // decide after all (a takeover; for one of our own decisions we wait to get back from history, `history`: once
  // nobody is past it any more)
  wait(seq, pid, history = false) {
    const have = this.log.get(seq);
    if (have) return Promise.resolve(have);
    return new Promise(resolve => {
      this.waiting = { seq, pid, resolve, since: Date.now(), history };
      this.ingest();
      this.onChange();
    });
  }

  // the logged decision for `seq`, if it's one for `seat`. One for another seat means the game that produced it
  // asked someone else at this point: the games differ. The host's game is the reference: the host drops the stray
  // decision and carries on; anyone else reports it and stops (the screen then rebuilds the game from the host's
  // history, see onDesync).
  entryFor(seq, seat) {
    const e = this.log.get(seq);
    if (!e || e[1] === seat) return e || null;
    this.mismatch(seq, e);
    if (this.isHost) { this.log.delete(seq); return null; }
    return STOP;
  }
  // a decision whose game differs from ours at `seq` (another seat, or another fingerprint)
  mismatch(seq, e, ours) {
    if (this.desync && Date.now() - this.desync.at < 10000) return;
    this.desync = { seq, pid: e[1], at: Date.now(), theirs: e[4], ours };
    if (this.onDesync) this.onDesync(this.desync);
    this.onChange();
  }
  // check a decision against our game at the same ask; false: this copy of the game has to stop (not the host)
  agrees(e, check) {
    if (!e || e[4] == null || e[4] === check) return true;
    this.mismatch(e[0], e, check);
    return this.isHost;
  }

  // tests (globalThis.__paSyncTrace): keep what each ask's fingerprint was made from, to compare two copies
  trace(seq, game, req) { if (globalThis.__paSyncTrace) (this.traced = this.traced || new Map()).set(seq, syncCheck(game, req, true)); }

  // has the decision at `seq` already been made (a peer of this game is past it)? Then we came back without our
  // log (another device, cleared storage, a rebuilt game, the last moves not yet saved): the answer comes from
  // history, never from asking again (a second, different answer would split the game in two). Just after loading,
  // before any peer of this game shows up, wait a moment for one.
  async madeElsewhere(seq) {
    if (this.isHost && this.desync) return false; // (the host's game is the reference)
    if (!this.looked && this.cfg.seats.some(s => s.k === 'h' && s.c !== this.cid)) {
      const t0 = Date.now();
      while (!this.closed && !this.othersInGame().length && Date.now() - t0 < 3000) await new Promise(r => setTimeout(r, 100));
      this.looked = true;
    }
    return this.behind(seq);
  }
  othersInGame() { return [...this.peerState.values()].filter(st => st.presence.cid !== this.cid && st.presence.g === this.cfg.game); }
  behind(seq) { return this.liveEdge() > seq || this.othersInGame().some(st => typeof st.presence.a === 'number' && st.presence.a > seq); }

  // read every peer's presence: decisions, history, needs
  ingest() {
    const peers = this.channel.peers() || [];
    this.peerState.clear();
    let serveFrom = null, clash = null;
    for (const p of peers) {
      const pr = p.presence || {};
      if (pr.pa !== PROTOCOL || pr.code !== this.cfg.code) continue;
      this.peerState.set(pr.cid, { peer: p, presence: pr });
      if (pr.cid === this.cfg.host && pr.cid !== this.cid && pr.cfg && pr.cfg.code === this.cfg.code && pr.cfg.game === this.cfg.game) this.cfg = pr.cfg;
      if (pr.g !== this.cfg.game) continue;
      if (pr.cid !== this.cid && pr.gv && pr.gv !== GAME_VERSION && !clash) clash = { cid: pr.cid, nick: pr.nick, newer: (pr.bt || 0) > BUILD_TIME };
      for (const list of [pr.o, pr.h]) {
        if (!Array.isArray(list)) continue;
        for (const e of list) {
          if (!Array.isArray(e) || typeof e[0] !== 'number' || this.log.has(e[0])) continue;
          if (this.producerOf(e[1], e[0]) !== pr.cid && list === pr.o) continue; // only the seat's producer speaks for it
          this.log.set(e[0], e);
        }
      }
      if (pr.cid !== this.cid && typeof pr.n === 'number' && this.shouldServe(pr.cid)) serveFrom = serveFrom == null ? pr.n : Math.min(serveFrom, pr.n);
    }
    this.clash = clash;
    // someone fell behind: serve history from the oldest need we can satisfy
    const serve = serveFrom != null && this.log.has(serveFrom) ? serveFrom : null;
    let changed = serve !== this.serve;
    this.serve = serve;
    // our own wait: if the seat we wait on is now ours to decide (a takeover), wake the agent
    // (waiting on history for our own seat: once we've caught up, or as the host whose game is the reference)
    const w0 = this.waiting;
    if (w0 && this.producerOf(w0.pid, w0.seq) === this.cid && !this.log.has(w0.seq) && (!w0.history || !this.behind(w0.seq) || (this.isHost && this.desync))) {
      const w = this.waiting;
      this.waiting = null;
      w.resolve(null);
    }
    if (this.waiting) {
      const e = this.log.get(this.waiting.seq);
      if (e) {
        const w = this.waiting;
        this.waiting = null;
        if (this.need != null) { this.need = null; changed = true; }
        w.resolve(e);
      } else {
        const prod = this.peerState.get(this.producerOf(this.waiting.pid, this.waiting.seq));
        const o = prod && prod.presence.g === this.cfg.game && Array.isArray(prod.presence.o) ? prod.presence.o : [];
        const oldest = o.length ? o[0][0] : null;
        // the producer has moved past what we need (we missed it), or someone is past it (we came back without
        // our log): ask for history
        const missing = (oldest != null && oldest > this.waiting.seq) || this.behind(this.waiting.seq);
        const want = missing || (Date.now() - this.waiting.since > 4000 && prod) ? this.waiting.seq : null;
        if (want !== this.need) { this.need = want; changed = true; }
      }
    }
    if (changed) this.flush();
    this.onChange();
  }

  // the host serves history; if the host itself is behind, the lowest other player serves it
  shouldServe(needer) {
    if (this.isHost) return true;
    if (needer !== this.cfg.host) return false;
    const others = [...this.peerState.keys()].filter(c => c !== this.cfg.host).sort();
    return others[0] === this.cid;
  }

  // build and send our presence within the size budget
  flush(extra = {}) {
    if (this.closed) return;
    const base = { pa: PROTOCOL, code: this.cfg.code, cid: this.cid, nick: this.nick, seat: this.seat, g: this.cfg.game, a: this.seq - 1, n: this.need, gv: GAME_VERSION, bt: BUILD_TIME, ...extra };
    if (this.isHost) base.cfg = this.cfg;
    // (the room's own fields — deck, avatar, a custom decklist — share the same presence object and its cap)
    let size = jsonSize(base) + this.othersSize(base);
    const o = [];
    for (let i = this.mine.length - 1; i >= 0; i--) {
      const s = jsonSize(this.mine[i]) + 1;
      if (size + s > 2600 && o.length >= 4) break;
      o.unshift(this.mine[i]);
      size += s;
    }
    const h = [];
    if (this.serve != null) {
      for (let k = this.serve; this.log.has(k); k++) {
        const e = this.log.get(k);
        const s = jsonSize(e) + 1;
        if (size + s > PRESENCE_BUDGET) break;
        h.push(e);
        size += s;
      }
    }
    const patch = { ...base, o, h: h.length ? h : null };
    this.lastPresence = patch;
    Promise.resolve(this.channel.presence(patch)).catch(() => {});
  }

  // the size of what else is in our presence (set by the room, not by us)
  othersSize(base) {
    const me = (this.channel.peers() || []).find(p => p.isMe);
    const pr = me && me.presence;
    if (!pr) return 0;
    let n = 0;
    for (const k of Object.keys(pr)) if (!(k in base) && k !== 'o' && k !== 'h' && pr[k] != null) n += jsonSize(pr[k]) + k.length + 4;
    return n;
  }

  // seat a takeover: from `seq` on, the host decides for `pid`
  setSubstitute(pid, seq) {
    this.cfg = { ...this.cfg, subs: { ...(this.cfg.subs || {}), [pid]: seq } };
    this.flush();
    this.ingest();
  }
  updateCfg(cfg) {
    if (cfg.code !== this.cfg.code || cfg.game !== this.cfg.game) return;
    this.cfg = cfg;
    this.ingest();
  }

  // who are we waiting on right now (for the status line)
  waitingOn() {
    if (!this.waiting) return null;
    const cid = this.producerOf(this.waiting.pid, this.waiting.seq);
    const st = this.peerState.get(cid);
    return { pid: this.waiting.pid, cid, present: !!st, seconds: Math.round((Date.now() - this.waiting.since) / 1000), seq: this.waiting.seq };
  }

  // ---- local persistence so a reload can replay the game
  key() { return `pa-room-${this.cfg.kind ? this.cfg.kind + '-' : ''}${this.cfg.code}-${this.cfg.game}`; }
  schedulePersist() {
    if (!this.storage || this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.persist(); }, 800);
  }
  persist() {
    if (!this.storage || this.forgotten) return;
    try { this.storage.setItem(this.key(), JSON.stringify({ cfg: this.cfg, log: [...this.log.values()], mine: this.mine.map(e => e[0]) })); } catch { /* storage full or blocked */ }
  }
  restore() {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(this.key());
      if (!raw) return;
      const d = JSON.parse(raw);
      for (const e of d.log || []) this.log.set(e[0], e);
      const mineSet = new Set(d.mine || []);
      this.mine = [...this.log.values()].filter(e => mineSet.has(e[0])).sort((a, b) => a[0] - b[0]);
      if (d.cfg && d.cfg.subs) this.cfg = { ...this.cfg, subs: { ...d.cfg.subs, ...(this.cfg.subs || {}) } };
    } catch { /* corrupt entry: start clean */ }
  }
}

// ---- agents: how each seat's decisions are produced on this peer

// what an agent waits on when its game has drifted from the host's: nothing more (the screen rebuilds the game)
const STOP = Symbol('stop');
const never = () => new Promise(() => {});

// apply the manual-tool operations carried with a decision, then hand back the decision
async function play(game, entry, applyOps, type) {
  if (entry[3] && applyOps) for (const op of entry[3]) await applyOps(game, op);
  return unpackValue(entry[2], type);
}

// your own seat: the UI decides (or the log, while replaying after a reload)
// (a decision for a player whose turn another controls, req.decider, is that controller's seat's: Mindslaver)
export class LocalSeatAgent {
  constructor(net, inner, applyOps, takeOps) { this.net = net; this.inner = inner; this.applyOps = applyOps; this.takeOps = takeOps; }
  async ask(game, pid, req) {
    const net = this.net;
    const seq = net.nextSeq();
    const seat = req.decider ?? pid;
    const check = syncCheck(game, req);
    net.trace(seq, game, req);
    for (;;) {
      const logged = net.entryFor(seq, seat);
      if (logged === STOP) return never();
      if (logged) return net.agrees(logged, check) ? play(game, logged, this.applyOps, req.type) : never();
      // the host took over this seat, or this decision was made before we came back: it comes from the room
      const takenOver = net.producerOf(seat, seq) !== net.cid;
      if (!takenOver && !(await net.madeElsewhere(seq))) break;
      await net.wait(seq, seat, !takenOver);
    }
    // (whoever answers only reads the game; guard the id counters anyway, as for the AI below: only the moves may
    // change the game, or this copy would drift from everyone else's)
    const uid = game.uid, nextId = game.nextId;
    const v = await this.inner.ask(game, pid, req);
    const ops = this.takeOps ? this.takeOps() : null; // already applied here when clicked
    if (!ops || !ops.length) { game.uid = uid; game.nextId = nextId; }
    net.publish(seq, seat, v, ops, req.type, check);
    return unpackValue(packValue(v, req.type), req.type);
  }
}

// a seat decided elsewhere: wait for its producer (with the host's AI standing in where it took over)
export class RemoteSeatAgent {
  constructor(net, applyOps, ai) { this.net = net; this.applyOps = applyOps; this.ai = ai; }
  async ask(game, pid, req) {
    const net = this.net;
    const seq = net.nextSeq();
    const seat = req.decider ?? pid;
    const check = syncCheck(game, req);
    net.trace(seq, game, req);
    for (;;) {
      const logged = net.entryFor(seq, seat);
      if (logged === STOP) return never();
      if (logged) return net.agrees(logged, check) ? play(game, logged, this.applyOps, req.type) : never();
      if (this.ai && net.producerOf(seat, seq) === net.cid) return decideWithAI(net, this.ai, game, pid, req, seq, check);
      await net.wait(seq, seat);
    }
  }
}

// AI seats on the host: decide, then publish so everyone else plays the same move
export class HostAIAgent {
  constructor(net, ai) { this.net = net; this.ai = ai; }
  async ask(game, pid, req) {
    const seq = this.net.nextSeq();
    const check = syncCheck(game, req);
    const logged = this.net.entryFor(seq, req.decider ?? pid);
    if (logged && logged !== STOP) return unpackValue(logged[2], req.type);
    return decideWithAI(this.net, this.ai, game, pid, req, seq, check);
  }
}

async function decideWithAI(net, ai, game, pid, req, seq, check) {
  // the AI only reads the game; guard the id counters anyway so every copy stays identical
  const uid = game.uid, nextId = game.nextId;
  const v = await ai.ask(game, pid, req);
  game.uid = uid; game.nextId = nextId;
  net.publish(seq, req.decider ?? pid, v, null, req.type, check);
  return unpackValue(packValue(v, req.type), req.type);
}
