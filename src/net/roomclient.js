// A friends' room: who is here, who sits where, which decks, and the host's game config.
// Everything travels in presence (any admitted viewer may set it); the host's presence carries `cfg`.
import { PROTOCOL } from './lockstep.js';

const CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
export function newRoomCode() { let s = ''; for (let i = 0; i < 6; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]; return s; }
export const isRoomCode = s => /^[a-z0-9]{6}$/.test(s || '');

// running inside the claude.ai page (rooms through its room capability) or as a standalone website (peer-to-peer)
export const onClaude = () => typeof window !== 'undefined' && !!(window.claude && window.claude.use);

// the room API: a test double injected before the page loads, the claude.ai capability, or peer-to-peer rooms
export async function roomApi() {
  if (typeof window !== 'undefined' && window.__paRoomMock) return window.__paRoomMock;
  if (onClaude()) { try { return await window.claude.use('room'); } catch { return null; } }
  if (typeof RTCPeerConnection === 'undefined') return null;
  try { return (await import('./p2proom.js')).p2pRoomApi; } catch { return null; }
}

export class RoomClient {
  // kind: '' for Commander rooms, 'pk' for Pokémon rooms (a separate set of room names)
  constructor(api, { cid, nick, deck, kind = '', storage = null }) {
    this.api = api;
    this.cid = cid;
    this.nick = nick;
    this.deck = deck;
    this.kind = kind;
    this.storage = storage;
    this.want = null;
    this.room = null;
    this.code = null;
    this.cfg = null;        // latest config (host's)
    this.version = 0;
    this.listeners = new Set();
    this.error = null;
    this.subscribe = this.subscribe.bind(this);
    this.getVersion = () => this.version;
  }

  subscribe(f) { this.listeners.add(f); return () => this.listeners.delete(f); }
  bump() { this.version++; for (const f of this.listeners) f(); }

  get isHost() { return !!this.cfg && this.cfg.host === this.cid; }

  async enter(code, asHost) {
    this.error = null;
    try {
      this.room = await this.api.join((this.kind ? this.kind + '-' : 'pa-') + code);
    } catch (e) {
      this.error = e && e.code === 'not_permitted' ? 'not_permitted' : 'join_failed';
      this.bump();
      return false;
    }
    this.code = code;
    if (asHost) this.cfg = { code, kind: this.kind, game: 0, seed: 0, host: this.cid, started: false, subs: {}, seats: [{ k: 'h', c: this.cid, n: this.nick, d: this.deck }, { k: 'h', c: null, n: '', d: null }] };
    // a host coming back to its own room (a reload): pick its config up again, games and seats included
    else { const saved = this.savedCfg(code); if (saved && saved.host === this.cid) this.cfg = saved; }
    this.unsub = this.room.onPeers(() => this.sync());
    await this.announce();
    this.sync();
    return true;
  }
  create() { return this.enter(newRoomCode(), true); }
  join(code) { return this.enter(code, false); }

  async leave() {
    if (this.unsub) this.unsub();
    if (this.room) { try { await this.room.leave(); } catch { /* already gone */ } }
    this.room = null; this.code = null; this.cfg = null; this.want = null;
    this.bump();
  }

  cfgKey(code) { return `pa-roomcfg-${this.kind ? this.kind + '-' : ''}${code}`; }
  savedCfg(code) { try { return JSON.parse(this.storage && this.storage.getItem(this.cfgKey(code)) || 'null'); } catch { return null; } }

  announce(extra = {}) {
    if (!this.room) return Promise.resolve();
    if (this.isHost && this.storage) { try { this.storage.setItem(this.cfgKey(this.code), JSON.stringify(this.cfg)); } catch { /* storage blocked */ } }
    const patch = { pa: PROTOCOL, code: this.code, cid: this.cid, nick: this.nick, deck: this.deck, want: this.want, ...extra };
    if (this.isHost) patch.cfg = this.cfg;
    return Promise.resolve(this.room.presence(patch)).catch(() => {});
  }

  // everyone in the room who speaks our protocol, keyed by client id (the newest tab wins)
  members() {
    const out = new Map();
    if (!this.room) return out;
    for (const p of this.room.peers() || []) {
      const pr = p.presence || {};
      if (pr.pa !== PROTOCOL || pr.code !== this.code || !pr.cid) continue;
      out.set(pr.cid, { cid: pr.cid, nick: String(pr.nick || 'Player').slice(0, 24), deck: pr.deck || null, want: typeof pr.want === 'number' ? pr.want : null, me: pr.cid === this.cid, presence: pr });
    }
    return out;
  }

  sync() {
    if (!this.room) return;
    const members = this.members();
    // follow the host's config
    if (!this.isHost) {
      let best = null;
      for (const m of members.values()) { const c = m.presence.cfg; if (c && c.code === this.code && c.host === m.cid && (!best || c.game >= best.game)) best = c; }
      if (best) this.cfg = best;
    } else if (!this.cfg.started) {
      // host: seat people who asked for an open seat, and keep names and decks current
      const seats = this.cfg.seats.map(s => ({ ...s }));
      for (const m of members.values()) {
        if (m.me || m.want == null || !seats[m.want] || seats[m.want].k !== 'h') continue;
        if (seats.some(s => s.c === m.cid)) { const cur = seats.findIndex(s => s.c === m.cid); if (cur !== m.want && !seats[m.want].c) { seats[cur] = { k: 'h', c: null, n: '', d: null }; seats[m.want] = { k: 'h', c: m.cid, n: m.nick, d: m.deck }; } continue; }
        if (!seats[m.want].c) seats[m.want] = { k: 'h', c: m.cid, n: m.nick, d: m.deck };
      }
      for (const s of seats) { const m = s.c && members.get(s.c); if (m) { s.n = m.nick; s.d = m.deck; } }
      seats[0] = { ...seats[0], n: this.nick, d: this.deck };
      if (JSON.stringify(seats) !== JSON.stringify(this.cfg.seats)) { this.cfg = { ...this.cfg, seats }; this.announce(); }
    }
    this.bump();
  }

  // ---- what this viewer does in the room
  setNick(nick) { this.nick = nick; if (this.isHost && this.cfg && !this.cfg.started) this.cfg = { ...this.cfg, seats: this.cfg.seats.map((s, i) => i === 0 ? { ...s, n: nick } : s) }; this.announce(); this.bump(); }
  setDeck(deck) { this.deck = deck; if (this.isHost && this.cfg && !this.cfg.started) this.cfg = { ...this.cfg, seats: this.cfg.seats.map((s, i) => i === 0 ? { ...s, d: deck } : s) }; this.announce(); this.bump(); }
  sit(i) { this.want = i; this.announce(); this.bump(); }
  stand() { this.want = null; this.announce(); this.bump(); }
  mySeat() { return this.cfg ? this.cfg.seats.findIndex(s => s.k === 'h' && s.c === this.cid) : -1; }

  // ---- host controls
  setCfg(cfg) { this.cfg = cfg; this.announce(); this.bump(); }
  setSeatCount(n) {
    const seats = this.cfg.seats.slice(0, n);
    while (seats.length < n) seats.push({ k: 'h', c: null, n: '', d: null });
    this.setCfg({ ...this.cfg, seats });
  }
  setSeat(i, patch) { this.setCfg({ ...this.cfg, seats: this.cfg.seats.map((s, k) => k === i ? { ...s, ...patch } : s) }); }
  start({ seed, seats }) { this.setCfg({ ...this.cfg, seats, seed, game: this.cfg.game + 1, started: true, subs: {} }); }
  stop() { this.setCfg({ ...this.cfg, started: false }); }
}
