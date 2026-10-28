// Rooms for the standalone website: browsers find each other through public Nostr relays (Trystero) and then
// talk directly over WebRTC, so no accounts and no game server. Mirrors the claude.ai room's presence API that
// the lobby and lockstep layers use: every peer publishes one small state object and sees everyone else's.
import { joinRoom, selfId } from 'trystero';
import { soon } from './soon.js';

const APP_ID = 'precon-arena-v1';

function p2pRoom(name) {
  const room = joinRoom({ appId: APP_ID }, name);
  const state = room.makeAction('presence');
  const peers = new Map([[selfId, { presence: Object.freeze({}), updatedAt: Date.now() }]]);
  const listeners = new Set();
  let snapshot = null, scheduled = false, pending = false, left = false;
  const mine = () => peers.get(selfId).presence;
  const snap = () => snapshot || (snapshot = Object.freeze([...peers].map(([peer, v]) => Object.freeze({ peer, presence: v.presence, updatedAt: v.updatedAt, isMe: peer === selfId }))));
  const notify = () => {
    snapshot = null;
    if (scheduled) return;
    scheduled = true;
    soon(() => { scheduled = false; const s = snap(); for (const f of listeners) f({ peers: s }); }, 16);
  };
  // a newcomer gets our state right away; afterwards every change is broadcast (latest state wins, so sends coalesce)
  room.onPeerJoin = id => { state.send(mine(), { target: id }).catch(() => {}); };
  room.onPeerLeave = id => { peers.delete(id); notify(); };
  state.onMessage = (data, { peerId }) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    peers.set(peerId, { presence: Object.freeze(data), updatedAt: Date.now() });
    notify();
  };
  const flush = () => { pending = false; if (!left) state.send(mine()).catch(() => {}); };
  return {
    name,
    presence(patch) {
      const next = { ...mine() };
      for (const [k, v] of Object.entries(patch)) { if (v === null) delete next[k]; else next[k] = v; }
      peers.set(selfId, { presence: Object.freeze(next), updatedAt: Date.now() });
      notify();
      if (!pending) { pending = true; soon(flush, 30); }
      return Promise.resolve();
    },
    peers: () => snap(),
    onPeers(f) { listeners.add(f); setTimeout(() => f({ peers: snap() }), 0); return () => listeners.delete(f); },
    leave() { left = true; listeners.clear(); return room.leave(); },
  };
}

export const p2pRoomApi = { join: async name => p2pRoom(name) };
