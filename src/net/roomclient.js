// A friends' room: who is here, who sits where, which decks, and the host's game config.
// Everything travels in presence (any admitted viewer may set it); the host's presence carries `cfg`.
import { PROTOCOL } from './lockstep.js';
import { GAME_VERSION, BUILD_TIME } from './version.js';

const CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
export function newRoomCode() { let s = ''; for (let i = 0; i < 6; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]; return s; }
export const isRoomCode = s => /^[a-z0-9]{6}$/.test(s || '');

// how a player looks in a room: an avatar (ui/avatar.jsx, seven small numbers), and the sleeves and deck box of the
// deck they bring (ui/deckstyle.jsx, four). Read from presence, kept in their seat.
const isAvatar = v => typeof v === 'string' && /^\d{1,2}(\.\d{1,2}){6}$/.test(v);
const isStyle = v => typeof v === 'string' && /^\d{1,2}(\.\d{1,2}){3}$/.test(v);
// a verified-account badge (ui/badge.jsx checks its signature before showing it): { u, r, c, x, s }
export const isBadge = b => !!b && typeof b === 'object' && typeof b.u === 'string' && b.u.length <= 20 && typeof b.r === 'string' && b.r.length <= 12
  && typeof b.c === 'string' && b.c.length <= 40 && Number.isFinite(b.x) && typeof b.s === 'string' && /^[A-Za-z0-9_-]{80,100}$/.test(b.s);
const badgeOf = b => (isBadge(b) ? { u: b.u, r: b.r, c: b.c, x: b.x, s: b.s } : undefined);
const lookOf = p => ({ a: isAvatar(p.av) ? p.av : undefined, sl: isStyle(p.sl) ? p.sl : undefined, bx: isStyle(p.bx) ? p.bx : undefined, vb: badgeOf(p.vb) });

// a logged-in player's badge for a room (set by ui/account.js): (room key, player id) -> Promise<badge | null>
let badgeProvider = null;
export function setBadgeProvider(fn) { badgeProvider = fn; }

// running inside the claude.ai page (rooms through its room capability) or as a standalone website
export const onClaude = () => typeof window !== 'undefined' && !!(window.claude && window.claude.use);

// the room API: a test double injected before the page loads, the claude.ai capability, the site's own relay
// (works wherever the site loads, school Wi-Fi included), or peer-to-peer rooms if the relay can't be reached.
// Tests can pick a transport with window.__paTransport = 'relay' | 'p2p'.
export async function roomApi() {
  if (typeof window !== 'undefined' && window.__paRoomMock) return window.__paRoomMock;
  if (onClaude()) { try { return await window.claude.use('room'); } catch { return null; } }
  const want = typeof window !== 'undefined' ? window.__paTransport : null;
  try { return (await import('./relayroom.js')).websiteRoomApi(want); } catch { return null; }
}

export class RoomClient {
  // kind: '' for Commander rooms, 'pk' for Pokémon rooms (a separate set of room names)
  constructor(api, { cid, nick, deck, kind = '', storage = null, avatar = null }) {
    this.api = api;
    this.cid = cid;
    this.nick = nick;
    this.deck = deck;
    this.kind = kind;
    this.storage = storage;
    this.want = null;
    this.extra = avatar ? { av: avatar } : {};   // more presence fields (an avatar, a custom deck everyone needs)
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
    this.key = (this.kind ? this.kind : 'pa') + '-' + code;   // the room as badges name it
    this.address(`${this.kind ? this.kind + '-' : ''}${code}`);
    if (asHost) this.cfg = { code, kind: this.kind, game: 0, seed: 0, host: this.cid, started: false, subs: {}, seats: [{ k: 'h', c: this.cid, n: this.nick, d: this.deck, ...lookOf(this.extra) }, { k: 'h', c: null, n: '', d: null }] };
    // a host coming back to its own room (a reload): pick its config up again, games and seats included
    else { const saved = this.savedCfg(code); if (saved && saved.host === this.cid) this.cfg = saved; }
    this.unsub = this.room.onPeers(() => this.sync());
    await this.announce();
    this.sync();
    // logged in: a verified badge for this room joins this player's presence
    if (badgeProvider) {
      const key = this.key;
      Promise.resolve(badgeProvider(key, this.cid)).then(vb => { if (vb && this.room && this.key === key) this.setExtra({ vb }); }, () => {});
    }
    return true;
  }
  create() { return this.enter(newRoomCode(), true); }
  join(code) { return this.enter(code, false); }

  async leave() {
    if (this.unsub) this.unsub();
    if (this.room) { try { await this.room.leave(); } catch { /* already gone */ } }
    this.room = null; this.code = null; this.key = null; this.cfg = null; this.want = null;
    if (this.extra.vb) { const { vb, ...rest } = this.extra; this.extra = rest; }
    this.address(this.kind === 'pk' ? 'pokemon' : this.kind === 'op' ? 'onepiece' : 'mtg');
    this.bump();
  }
  // while you're in a room, the address is its invite link: a reload (say, of a game that seems stuck) comes straight
  // back to the room and its game instead of the game's menu
  address(hash) {
    if (typeof location === 'undefined' || location.hash === '#' + hash) return;
    try { history.replaceState(null, '', '#' + hash); } catch { /* sandboxed frame */ }
  }

  cfgKey(code) { return `pa-roomcfg-${this.kind ? this.kind + '-' : ''}${code}`; }
  savedCfg(code) { try { return JSON.parse(this.storage && this.storage.getItem(this.cfgKey(code)) || 'null'); } catch { return null; } }

  announce(extra = {}) {
    if (!this.room) return Promise.resolve();
    if (this.isHost && this.storage) { try { this.storage.setItem(this.cfgKey(this.code), JSON.stringify(this.cfg)); } catch { /* storage blocked */ } }
    const patch = { pa: PROTOCOL, code: this.code, cid: this.cid, nick: this.nick, deck: this.deck, want: this.want, gv: GAME_VERSION, bt: BUILD_TIME, ...this.extra, ...extra };
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
      out.set(pr.cid, { cid: pr.cid, nick: String(pr.nick || 'Player').slice(0, 24), deck: pr.deck || null, want: typeof pr.want === 'number' ? pr.want : null, av: isAvatar(pr.av) ? pr.av : null, vb: badgeOf(pr.vb) || null, look: lookOf(pr), me: pr.cid === this.cid, presence: pr });
    }
    return out;
  }

  // someone here runs another version of the game rules (a page opened before an update): games between the two
  // would drift apart, so the one with the older version reloads first. { nick, newer } or null
  versionClash() {
    for (const m of this.members().values()) {
      const pr = m.presence;
      if (!m.me && pr.gv && pr.gv !== GAME_VERSION) return { cid: m.cid, nick: m.nick, newer: (pr.bt || 0) > BUILD_TIME };
    }
    return null;
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
        if (seats.some(s => s.c === m.cid)) { const cur = seats.findIndex(s => s.c === m.cid); if (cur !== m.want && !seats[m.want].c) { seats[cur] = { k: 'h', c: null, n: '', d: null }; seats[m.want] = { k: 'h', c: m.cid, n: m.nick, d: m.deck, ...m.look }; } continue; }
        if (!seats[m.want].c) seats[m.want] = { k: 'h', c: m.cid, n: m.nick, d: m.deck, ...m.look };
      }
      for (const s of seats) { const m = s.c && members.get(s.c); if (m) { s.n = m.nick; s.d = m.deck; Object.assign(s, m.look); } }
      seats[0] = { ...seats[0], n: this.nick, d: this.deck, ...lookOf(this.extra) };
      if (JSON.stringify(seats) !== JSON.stringify(this.cfg.seats)) { this.cfg = { ...this.cfg, seats }; this.announce(); }
    }
    this.bump();
  }

  // ---- what this viewer does in the room
  setNick(nick) { this.nick = nick; if (this.isHost && this.cfg && !this.cfg.started) this.cfg = { ...this.cfg, seats: this.cfg.seats.map((s, i) => i === 0 ? { ...s, n: nick } : s) }; this.announce(); this.bump(); }
  setExtra(patch) {
    this.extra = { ...this.extra, ...patch };
    if (this.isHost && this.cfg && !this.cfg.started) this.cfg = { ...this.cfg, seats: this.cfg.seats.map((s, i) => (i === 0 ? { ...s, ...lookOf(this.extra) } : s)) };
    this.announce(); this.bump();
  }
  setAvatar(av) { this.setExtra({ av }); }
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
