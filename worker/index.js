// The site's own server on Cloudflare. Static files come from docs/ (assets); /relay/<room> relays friends' rooms,
// so rooms work on networks that block browser-to-browser connections (school Wi-Fi): if the site loads, the relay
// is reachable on the same address. /save/<code> keeps save codes (see SaveSlot below).
//
// Each room is one Durable Object holding every member's presence (a small JSON object, at most a few KB). Members
// connect by WebSocket, or by plain HTTP polling where WebSockets are blocked too. A member sends its whole presence
// whenever it changes; the room forwards it to everyone else. Presence lives in memory only: when the object wakes
// from hibernation it asks every connected member to send theirs again.
import { DurableObject } from 'cloudflare:workers';

const ROOM = /^\/relay\/([a-z]{2}-[a-z0-9]{6})$/;
const SAVE = /^\/save\/(new|[2-9A-HJ-NP-Z]{8})(\/info)?$/;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
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
    const sv = SAVE.exec(url.pathname);
    if (sv) {
      if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
      return saveRequest(req, env, sv[1], !!sv[2]);
    }
    return env.ASSETS.fetch(req);
  },
};

// ---- save codes: your progress (records, decks, avatar, settings) under a short code, no account needed
// The browser packs everything into one compressed string and the code is the only key: anyone with it can load or
// update that save. Each code is its own Durable Object, so saves never touch each other. A save nobody reads or
// writes for 400 days is deleted.
const CODE_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';   // no 0/O or 1/I to mix up
const MAX_SAVE = 2_500_000;    // characters of packed data
const CHUNK = 400_000;         // stored in pieces well under a stored value's limit
const KEEP_FOR = 400 * 24 * 3600 * 1000;

const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const newCode = () => [...crypto.getRandomValues(new Uint8Array(8))].map(b => CODE_CHARS[b & 31]).join('');
const validData = d => typeof d === 'string' && d.length > 1 && d.length <= MAX_SAVE && /^[zj][A-Za-z0-9_-]+$/.test(d);

async function saveRequest(req, env, code, info) {
  const slot = c => env.SAVES.get(env.SAVES.idFromName(c));
  if (req.method === 'GET') {
    if (code === 'new') return json({ error: 'no such save' }, 404);
    const r = info ? await slot(code).info() : await slot(code).read();
    return r ? json(r) : json({ error: 'no such save' }, 404);
  }
  if (req.method !== 'POST' && req.method !== 'PUT') return json({ error: 'method' }, 405);
  if (+(req.headers.get('Content-Length') || 0) > MAX_SAVE + 1000) return json({ error: 'too big' }, 413);
  let body;
  try { body = JSON.parse(await req.text()); } catch { return json({ error: 'bad request' }, 400); }
  if (!body || !validData(body.data)) return json({ error: 'bad save' }, 400);
  if (code === 'new') {
    // a fresh code; (32^8 of them, so a clash is all but impossible, but a taken one is never reused)
    for (let i = 0; i < 6; i++) {
      const c = newCode();
      const r = await slot(c).create(body.data);
      if (r) return json({ code: c, ...r });
    }
    return json({ error: 'busy' }, 503);
  }
  const r = await slot(code).update(body.data, Number.isInteger(body.baseRev) ? body.baseRev : -1, body.force === true);
  if (r.missing) return json({ error: 'no such save' }, 404);
  if (r.conflict) return json({ error: 'newer save', rev: r.rev, at: r.at }, 409);
  return json(r);
}

export class SaveSlot extends DurableObject {
  // a new code: only if nothing was ever saved under it
  async create(data) {
    if (await this.ctx.storage.get('meta')) return null;
    return this.write(data, 1, 0);
  }

  async info() {
    const meta = await this.ctx.storage.get('meta');
    if (!meta) return null;
    await this.ctx.storage.setAlarm(Date.now() + KEEP_FOR);
    return { rev: meta.rev, at: meta.at, size: meta.size };
  }

  async read() {
    const meta = await this.ctx.storage.get('meta');
    if (!meta) return null;
    const keys = Array.from({ length: meta.n }, (_, i) => 'c' + i);
    const got = await this.ctx.storage.get(keys);
    await this.ctx.storage.setAlarm(Date.now() + KEEP_FOR);
    return { rev: meta.rev, at: meta.at, size: meta.size, data: keys.map(k => got.get(k) || '').join('') };
  }

  // an update has to say which save it builds on: if another device saved since, it's told so (and can combine)
  async update(data, baseRev, force) {
    const meta = await this.ctx.storage.get('meta');
    if (!meta) return { missing: true };
    if (!force && baseRev !== meta.rev) return { conflict: true, rev: meta.rev, at: meta.at };
    return this.write(data, meta.rev + 1, meta.n);
  }

  async write(data, rev, oldN) {
    const n = Math.ceil(data.length / CHUNK);
    const meta = { rev, at: Date.now(), n, size: data.length };
    const put = { meta };
    for (let i = 0; i < n; i++) put['c' + i] = data.slice(i * CHUNK, (i + 1) * CHUNK);
    await this.ctx.storage.put(put);
    if (oldN > n) await this.ctx.storage.delete(Array.from({ length: oldN - n }, (_, i) => 'c' + (n + i)));
    await this.ctx.storage.setAlarm(Date.now() + KEEP_FOR);
    return { rev, at: meta.at };
  }

  async alarm() { await this.ctx.storage.deleteAll(); }
}

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
