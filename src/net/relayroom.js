// Rooms through the site's own relay (worker/index.js on Cloudflare): every browser talks to the server the site
// came from, so rooms work wherever the site itself loads, including school and office networks that block
// browser-to-browser connections. A WebSocket where possible, plain HTTP polling where even that is blocked.
// Same presence API as p2proom.js and the claude.ai room: presence(patch), peers(), onPeers(fn), leave().

export const RELAY_HOST = 'stigz-s-mtga.stigzrblx.workers.dev';
const OPEN_TIMEOUT = 6000;   // a WebSocket that hasn't opened by then means polling
const POLL_EVERY = 700;

let found = null;
// the relay on this site's own server if it has one (the Cloudflare site), else the main site's (other copies)
export function findRelay() {
  if (found) return found;
  const ok = async origin => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    try { const r = await fetch(origin + '/relay/health', { signal: ctl.signal, cache: 'no-store' }); return r.ok && (await r.text()).trim() === 'ok'; } catch { return false; } finally { clearTimeout(t); }
  };
  found = (async () => {
    // only the Cloudflare site (and a local `wrangler dev` on :8787) has a relay at its own address
    const own = typeof location !== 'undefined' && /^https?:$/.test(location.protocol) && (/\.workers\.dev$/.test(location.hostname) || location.port === '8787') ? location.origin : null;
    if (own && await ok(own)) return own;
    if (own !== 'https://' + RELAY_HOST && await ok('https://' + RELAY_HOST)) return 'https://' + RELAY_HOST;
    return null;
  })();
  return found;
}

export function relayRoom(origin, name) {
  const others = new Map();          // peer id -> { presence, updatedAt }
  let mine = Object.freeze({}), myId = null, left = false;
  const listeners = new Set();
  let snapshot = null, scheduled = false;
  const snap = () => snapshot || (snapshot = Object.freeze([
    Object.freeze({ peer: myId || 'me', presence: mine, updatedAt: Date.now(), isMe: true }),
    ...[...others].map(([peer, v]) => Object.freeze({ peer, presence: v.presence, updatedAt: v.updatedAt, isMe: false })),
  ]));
  const notify = () => {
    snapshot = null;
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; const s = snap(); for (const f of listeners) f({ peers: s }); }, 16);
  };
  const setOther = (peer, p) => { if (peer === myId || !p || typeof p !== 'object') return; others.set(peer, { presence: Object.freeze(p), updatedAt: Date.now() }); };

  // ---- WebSocket
  let ws = null, wsOpened = false, retry = 0, sendTimer = null, mode = 'ws', dirty = false;
  const sendWs = () => { sendTimer = null; if (ws && ws.readyState === 1) ws.send('P' + JSON.stringify(mine)); };
  const connect = () => {
    if (left || mode !== 'ws') return;
    const sock = new WebSocket(origin.replace(/^http/, 'ws') + '/relay/' + name);
    ws = sock;
    const giveUp = setTimeout(() => { if (sock.readyState !== 1 && !wsOpened) { mode = 'poll'; try { sock.close(); } catch { /* never opened */ } startPolling(); } }, OPEN_TIMEOUT);
    sock.onopen = () => { clearTimeout(giveUp); wsOpened = true; retry = 0; };
    sock.onmessage = ev => {
      if (ev.data === 'pong') return;
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'hello') { myId = m.id; others.clear(); for (const x of m.peers || []) setOther(x.peer, x.p); sendWs(); notify(); }
      else if (m.t === 's') { setOther(m.peer, m.p); notify(); }
      else if (m.t === 'bye') { others.delete(m.peer); notify(); }
      else if (m.t === 'resync') sendWs();
    };
    sock.onclose = () => {
      clearTimeout(giveUp);
      if (ws === sock) ws = null;
      if (left || mode !== 'ws') return;
      // dropped: try again, backing off; members' last known state stays until the room says hello again
      setTimeout(connect, Math.min(8000, 400 * 2 ** retry++));
    };
    sock.onerror = () => {};
  };
  const ping = setInterval(() => { if (ws && ws.readyState === 1) ws.send('ping'); }, 25000);

  // ---- HTTP polling (where WebSockets are blocked)
  let pollId = null, since = 0, polling = false;
  const startPolling = () => {
    if (polling || left) return;
    polling = true; dirty = true;
    const tick = async () => {
      if (left) return;
      const body = { id: pollId, since };
      if (dirty) { body.p = mine; dirty = false; }
      try {
        const r = await fetch(origin + '/relay/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
        if (r.ok) {
          const d = await r.json();
          if (pollId && d.id !== pollId) since = 0;
          pollId = myId = d.id;
          for (const x of d.peers || []) setOther(x.peer, x.p);
          const here = new Set(d.here || []);
          for (const peer of [...others.keys()]) if (!here.has(peer)) others.delete(peer);
          since = d.v;
          if (d.need) dirty = true;
          notify();
        } else if (body.p) dirty = true;
      } catch { if (body.p) dirty = true; }
      setTimeout(tick, POLL_EVERY);
    };
    tick();
  };

  // tests: window.__paRelayPoll pretends WebSockets are blocked
  if (typeof window !== 'undefined' && window.__paRelayPoll) { mode = 'poll'; startPolling(); } else connect();
  return {
    name,
    get transport() { return mode; },
    presence(patch) {
      const next = { ...mine };
      for (const [k, v] of Object.entries(patch)) { if (v === null) delete next[k]; else next[k] = v; }
      mine = Object.freeze(next);
      notify();
      if (mode === 'ws') { if (!sendTimer) sendTimer = setTimeout(sendWs, 30); } else dirty = true;
      return Promise.resolve();
    },
    peers: () => snap(),
    onPeers(f) { listeners.add(f); setTimeout(() => f({ peers: snap() }), 0); return () => listeners.delete(f); },
    leave() {
      left = true; listeners.clear(); clearInterval(ping);
      if (ws) { try { ws.close(1000, 'left'); } catch { /* closed */ } }
      // a polling member says goodbye by going quiet; the room drops it after a few seconds
      return Promise.resolve();
    },
  };
}

// rooms for the website: the relay when it can be reached, else direct connections; nothing is looked up until a
// room is actually opened. want: 'relay' or 'p2p' to force one (tests)
export function websiteRoomApi(want) {
  return {
    kind: 'website',
    async join(name) {
      const origin = want === 'p2p' ? null : await findRelay();
      if (origin) return relayRoom(origin, name);
      if (want === 'relay' || typeof RTCPeerConnection === 'undefined') throw Object.assign(new Error('no room server'), { code: 'join_failed' });
      return (await import('./p2proom.js')).p2pRoomApi.join(name);
    },
  };
}
