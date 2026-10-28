// TEST ONLY: injected into pages by the multiplayer browser test. A stand-in for the artifact room's presence
// arm, shared between tabs of the same browser context with BroadcastChannel.
(() => {
  const me = 'p' + Math.random().toString(36).slice(2, 10);
  function namedRoom(name) {
    // transport: a relay through the test harness (separate browser profiles), else BroadcastChannel
    const bc = window.__relay ? (() => {
      const ch = { onmessage: null, postMessage: m => window.__relay(name, m), close() {} };
      (window.__relayHandlers = window.__relayHandlers || {})[name] = m => ch.onmessage && ch.onmessage({ data: m });
      return ch;
    })() : new BroadcastChannel('mockroom-' + name);
    const peers = new Map(); // peer -> { presence, updatedAt }
    peers.set(me, { presence: Object.freeze({}), updatedAt: Date.now() });
    const listeners = new Set();
    let scheduled = false, snapshot = null;
    const snap = () => {
      if (!snapshot) snapshot = Object.freeze([...peers].map(([peer, v]) => Object.freeze({ peer, presence: v.presence, updatedAt: v.updatedAt, isMe: peer === me, sameTab: peer === me, kind: 'viewer', guest: false, by: null })));
      return snapshot;
    };
    const notify = () => {
      snapshot = null;
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => { scheduled = false; const s = snap(); for (const f of listeners) f({ peers: s, joined: [], left: [], updated: [] }); }, 20);
    };
    const send = () => bc.postMessage({ t: 'state', peer: me, presence: peers.get(me).presence });
    bc.onmessage = (ev) => {
      const m = ev.data;
      if (m.t === 'hello') { send(); return; }
      if (m.t === 'state') { peers.set(m.peer, { presence: Object.freeze(m.presence), updatedAt: Date.now() }); notify(); }
      if (m.t === 'bye') { peers.delete(m.peer); notify(); }
    };
    bc.postMessage({ t: 'hello' });
    addEventListener('beforeunload', () => bc.postMessage({ t: 'bye', peer: me }));
    return {
      name,
      presence(patch) {
        const next = { ...peers.get(me).presence };
        for (const [k, v] of Object.entries(patch)) { if (v === null) delete next[k]; else next[k] = v; }
        const size = JSON.stringify(next).length;
        window.__maxPresence = Math.max(window.__maxPresence || 0, size); // (tests read the largest presence sent)
        if (size > 4096) { window.__presenceRejected = (window.__presenceRejected || 0) + 1; return Promise.reject({ code: 'invalid_argument', message: 'presence over 4 KiB' }); }
        peers.set(me, { presence: Object.freeze(next), updatedAt: Date.now() });
        send(); notify();
        return Promise.resolve();
      },
      peers: () => snap(),
      onPeers(f) { listeners.add(f); setTimeout(() => f({ peers: snap(), joined: snap(), left: [], updated: [] }), 0); return () => listeners.delete(f); },
      emit: () => Promise.reject({ code: 'not_permitted' }),
      on: () => () => {},
      connected: () => true,
      onConnection(f) { setTimeout(() => f(true), 0); return () => {}; },
      leave() { bc.postMessage({ t: 'bye', peer: me }); bc.close(); return Promise.resolve(); },
    };
  }
  const rooms = new Map();
  window.__paRoomMock = { join: async (name) => { if (!rooms.has(name)) rooms.set(name, namedRoom(name)); return rooms.get(name); } };
  window.__relayIn = (name, m) => { const h = window.__relayHandlers && window.__relayHandlers[name]; if (h) h(m); };
})();
