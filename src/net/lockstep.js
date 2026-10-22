// Lockstep online play. Every browser runs the same deterministic game (same seed, same decks) and the
// players only exchange their decisions. Each decision is the answer to one engine "ask"; asks happen in the
// same order everywhere, so the n-th ask is identified by its sequence number.
//
// Transport: the artifact room's presence, which every admitted viewer may set. Each peer publishes a sliding
// window of the decisions it produced ("o"), the first sequence number it is missing ("n"), and history it
// serves to peers that fell behind ("h"). The host also publishes the room config ("cfg") and produces the
// decisions of AI seats and of seats it took over. Everyone keeps the full log, so a reload replays locally.

export const PROTOCOL = 1;
const PRESENCE_BUDGET = 3900; // presence objects are capped at 4 KiB of JSON

// ---- compact decision encoding
const ACTION_KEYS = ['type', 'cardId', 'optionKey', 'abilityKey', 'color'];
const PK_ACTION_KEYS = ['t', 'card', 'target', 'mon', 'name', 'to', 'src']; // a Pokémon main-phase move (what matchAction compares)
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
    this.restore();
    this.unsub = channel.onPeers(() => this.ingest());
    this.flush();
    this.ingest();
    // re-check while waiting: a stalled wait turns into a history request even if nobody else changes
    this.timer = setInterval(() => { if (this.waiting) this.ingest(); }, 1000);
  }

  get isHost() { return this.cfg.host === this.cid; }
  // after closing, nothing more goes out: leaving cancels the open prompt, and that answer must not become a move
  close() { this.closed = true; if (this.unsub) this.unsub(); clearInterval(this.timer); this.persist(); }

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
  publish(seq, pid, value, ops, type) {
    if (this.closed) return;
    const e = ops && ops.length ? [seq, pid, packValue(value, type), ops] : [seq, pid, packValue(value, type)];
    this.log.set(seq, e);
    this.mine.push(e);
    if (this.mine.length > 400) this.mine.splice(0, this.mine.length - 400);
    this.flush();
    this.schedulePersist();
  }

  // resolve with the entry for `seq` (from the log, or when a peer publishes it)
  wait(seq, pid) {
    const have = this.log.get(seq);
    if (have) return Promise.resolve(have);
    return new Promise(resolve => {
      this.waiting = { seq, pid, resolve, since: Date.now() };
      this.ingest();
      this.onChange();
    });
  }

  // read every peer's presence: decisions, history, needs
  ingest() {
    const peers = this.channel.peers() || [];
    this.peerState.clear();
    let serveFrom = null;
    for (const p of peers) {
      const pr = p.presence || {};
      if (pr.pa !== PROTOCOL || pr.code !== this.cfg.code) continue;
      this.peerState.set(pr.cid, { peer: p, presence: pr });
      if (pr.cid === this.cfg.host && pr.cid !== this.cid && pr.cfg && pr.cfg.code === this.cfg.code && pr.cfg.game === this.cfg.game) this.cfg = pr.cfg;
      if (pr.g !== this.cfg.game) continue;
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
    // someone fell behind: serve history from the oldest need we can satisfy
    const serve = serveFrom != null && this.log.has(serveFrom) ? serveFrom : null;
    let changed = serve !== this.serve;
    this.serve = serve;
    // our own wait: if the seat we wait on is now ours to decide (a takeover), wake the agent
    if (this.waiting && this.producerOf(this.waiting.pid, this.waiting.seq) === this.cid && !this.log.has(this.waiting.seq)) {
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
        // the producer has moved past what we need (we missed it): ask for history
        const missing = oldest != null && oldest > this.waiting.seq;
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
    const base = { pa: PROTOCOL, code: this.cfg.code, cid: this.cid, nick: this.nick, seat: this.seat, g: this.cfg.game, a: this.seq - 1, n: this.need, ...extra };
    if (this.isHost) base.cfg = this.cfg;
    let size = jsonSize(base);
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
    if (!this.storage) return;
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

// apply the manual-tool operations carried with a decision, then hand back the decision
async function play(game, entry, applyOps, type) {
  if (entry[3] && applyOps) for (const op of entry[3]) await applyOps(game, op);
  return unpackValue(entry[2], type);
}

// your own seat: the UI decides (or the log, while replaying after a reload)
export class LocalSeatAgent {
  constructor(net, inner, applyOps, takeOps) { this.net = net; this.inner = inner; this.applyOps = applyOps; this.takeOps = takeOps; }
  async ask(game, pid, req) {
    const seq = this.net.nextSeq();
    const logged = this.net.log.get(seq);
    if (logged) return play(game, logged, this.applyOps, req.type);
    if (this.net.producerOf(pid, seq) !== this.net.cid) { // the host took over this seat
      for (;;) { const e = await this.net.wait(seq, pid); if (e) return play(game, e, this.applyOps, req.type); }
    }
    const v = await this.inner.ask(game, pid, req);
    const ops = this.takeOps ? this.takeOps() : null; // already applied here when clicked
    this.net.publish(seq, pid, v, ops, req.type);
    return unpackValue(packValue(v, req.type), req.type);
  }
}

// a seat decided elsewhere: wait for its producer (with the host's AI standing in where it took over)
export class RemoteSeatAgent {
  constructor(net, applyOps, ai) { this.net = net; this.applyOps = applyOps; this.ai = ai; }
  async ask(game, pid, req) {
    const seq = this.net.nextSeq();
    const logged = this.net.log.get(seq);
    if (logged) return play(game, logged, this.applyOps, req.type);
    for (;;) {
      if (this.ai && this.net.producerOf(pid, seq) === this.net.cid) return decideWithAI(this.net, this.ai, game, pid, req, seq);
      const entry = await this.net.wait(seq, pid);
      if (entry) return play(game, entry, this.applyOps, req.type);
    }
  }
}

// AI seats on the host: decide, then publish so everyone else plays the same move
export class HostAIAgent {
  constructor(net, ai) { this.net = net; this.ai = ai; }
  async ask(game, pid, req) {
    const seq = this.net.nextSeq();
    const logged = this.net.log.get(seq);
    if (logged) return unpackValue(logged[2], req.type);
    return decideWithAI(this.net, this.ai, game, pid, req, seq);
  }
}

async function decideWithAI(net, ai, game, pid, req, seq) {
  // the AI only reads the game; guard the id counters anyway so every copy stays identical
  const uid = game.uid, nextId = game.nextId;
  const v = await ai.ask(game, pid, req);
  game.uid = uid; game.nextId = nextId;
  net.publish(seq, pid, v, null, req.type);
  return unpackValue(packValue(v, req.type), req.type);
}
