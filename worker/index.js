// The site's own server on Cloudflare. Static files come from docs/ (assets); /relay/<room> relays friends' rooms,
// so rooms work on networks that block browser-to-browser connections (school Wi-Fi): if the site loads, the relay
// is reachable on the same address.
//
// Each room is one Durable Object holding every member's presence (a small JSON object, at most a few KB). Members
// connect by WebSocket, or by plain HTTP polling where WebSockets are blocked too. A member sends its whole presence
// whenever it changes; the room forwards it to everyone else. Presence lives in memory only: when the object wakes
// from hibernation it asks every connected member to send theirs again.
import { DurableObject } from 'cloudflare:workers';

const ROOM = /^\/relay\/([a-z]{2}-[a-z0-9]{6})$/;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const MAX_PRESENCE = 9000;   // characters of JSON
const MAX_MEMBERS = 24;
const POLL_TIMEOUT = 12000;  // a polling member that stops asking is gone after this long

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/relay/health') return new Response('ok', { headers: { ...CORS, 'Cache-Control': 'no-store' } });
    const m = ROOM.exec(url.pathname);
    if (m) {
      if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
      return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
};

// a presence update is accepted only as one JSON object, so it can be forwarded as is
function validPresence(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_PRESENCE) return false;
  try { const v = JSON.parse(raw); return !!v && typeof v === 'object' && !Array.isArray(v); } catch { return false; }
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.states = new Map();   // member id -> { raw, v }
    this.version = 0;
    this.polls = new Map();    // polling member id -> last request time
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    // woken from hibernation with members still connected: their presence was only in memory, so ask again
    for (const ws of this.ctx.getWebSockets()) { try { ws.send('{"t":"resync"}'); } catch { /* closing */ } }
  }

  members() { return this.ctx.getWebSockets().length + this.polls.size; }

  set(id, raw) {
    this.states.set(id, { raw, v: ++this.version });
    this.broadcast(`{"t":"s","peer":"${id}","p":${raw}}`, id);
  }

  drop(id) {
    if (!this.states.delete(id) && !this.polls.has(id)) return;
    this.polls.delete(id);
    this.version++;
    this.broadcast(`{"t":"bye","peer":"${id}"}`, id);
  }

  broadcast(msg, from) {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a && a.id === from) continue;
      try { ws.send(msg); } catch { /* closing */ }
    }
  }

  // polling members that went quiet have left
  sweep() {
    const now = Date.now();
    for (const [id, at] of this.polls) if (now - at > POLL_TIMEOUT) this.drop(id);
  }

  async fetch(req) {
    this.sweep();
    if (req.headers.get('Upgrade') === 'websocket') {
      if (this.members() >= MAX_MEMBERS) return new Response('room full', { status: 429, headers: CORS });
      const [client, server] = Object.values(new WebSocketPair());
      const id = 'w' + crypto.randomUUID().slice(0, 8);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ id });
      const peers = [...this.states].map(([peer, s]) => `{"peer":"${peer}","p":${s.raw}}`);
      server.send(`{"t":"hello","id":"${id}","peers":[${peers.join(',')}]}`);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (req.method !== 'POST') return new Response('expected a WebSocket or a POST', { status: 400, headers: CORS });
    // polling: { id?, since, p? } -> { id, v, peers: changed members since `since`, here: every member id, need? }
    let body;
    try { body = JSON.parse(await req.text()); } catch { return new Response('bad request', { status: 400, headers: CORS }); }
    let id = typeof body.id === 'string' && /^h[a-z0-9]{8}$/.test(body.id) ? body.id : null;
    if (!id) {
      if (this.members() >= MAX_MEMBERS) return new Response('room full', { status: 429, headers: CORS });
      id = 'h' + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    }
    this.polls.set(id, Date.now());
    if (body.p != null) { const raw = JSON.stringify(body.p); if (validPresence(raw)) this.set(id, raw); }
    const since = Number.isFinite(body.since) && body.since <= this.version ? body.since : 0;
    const peers = [];
    for (const [peer, s] of this.states) if (peer !== id && s.v > since) peers.push(`{"peer":"${peer}","p":${s.raw}}`);
    const here = JSON.stringify([...this.states.keys()].filter(p => p !== id));
    const need = this.states.has(id) ? '' : ',"need":true';
    return new Response(`{"id":"${id}","v":${this.version},"here":${here},"peers":[${peers.join(',')}]${need}}`, { headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }

  webSocketMessage(ws, msg) {
    if (typeof msg !== 'string' || msg[0] !== 'P') return;
    const a = ws.deserializeAttachment();
    const raw = msg.slice(1);
    if (a && a.id && validPresence(raw)) this.set(a.id, raw);
  }

  webSocketClose(ws, code, reason) {
    const a = ws.deserializeAttachment();
    if (a && a.id) this.drop(a.id);
    try { ws.close(code === 1005 ? 1000 : code, reason); } catch { /* already closed */ }
  }

  webSocketError(ws) {
    const a = ws.deserializeAttachment();
    if (a && a.id) this.drop(a.id);
  }
}
