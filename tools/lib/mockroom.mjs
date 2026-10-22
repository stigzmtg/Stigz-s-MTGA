// In-memory stand-in for the artifact room's presence arm (tests only): per-peer presence objects,
// field-wise merges, deliveries coalesced and delayed like the real platform.
export class MockHub {
  constructor({ latency = 15 } = {}) { this.latency = latency; this.channels = new Set(); this.n = 0; }
  connect() { const ch = new MockChannel(this, `peer${++this.n}`); this.channels.add(ch); this.broadcast(); return ch; }
  snapshot() { return Object.freeze([...this.channels].map(c => Object.freeze({ peer: c.peer, presence: c.state, kind: 'viewer', isMe: false, sameTab: false, guest: false, by: null, updatedAt: c.updatedAt }))); }
  broadcast() {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      const snap = this.snapshot();
      for (const c of this.channels) for (const f of c.listeners) f({ peers: snap, joined: [], left: [], updated: [] });
    }, this.latency);
  }
}
class MockChannel {
  constructor(hub, peer) { this.hub = hub; this.peer = peer; this.state = Object.freeze({}); this.listeners = new Set(); this.updatedAt = Date.now(); }
  presence(patch) {
    const next = { ...this.state };
    for (const [k, v] of Object.entries(patch)) { if (v === null) delete next[k]; else next[k] = v; }
    if (JSON.stringify(next).length > 4096) return Promise.reject({ code: 'invalid_argument', message: 'presence over 4 KiB' });
    this.state = Object.freeze(next);
    this.updatedAt = Date.now();
    this.hub.broadcast();
    return Promise.resolve();
  }
  peers() { return this.hub.snapshot(); }
  onPeers(f) { this.listeners.add(f); return () => this.listeners.delete(f); }
  leave() { this.hub.channels.delete(this); this.listeners.clear(); this.hub.broadcast(); return Promise.resolve(); }
}
