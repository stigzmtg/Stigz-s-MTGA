// Headless online-play test: several peers share an in-memory room and play one game in lockstep.
// Seat 0 = host (decisions by an AI standing in for the person), seat 1 = guest, seat 2 = AI run by the host.
// A spectator joins mid-game and catches up from history; the guest "reloads" mid-game and replays from storage.
// FRESH=1: the guest comes back without its saved game (another device, cleared storage) and gets its own past
// decisions from history, never asked again. Every copy's check of every decision must agree (no drift reported).
// DRIFT=1: the guest comes back with a game that differs (another deck for the AI seat, as if its copy of the cards
// differed): it must notice at once, drop its copy and rebuild it from the host's history, ending identical.
// Usage: node tools/nettest.mjs [games=3] [seed=1]
import fs from 'node:fs';
import { CardDB } from '../src/engine/cards.js';
import { Game } from '../src/engine/game.js';
import { AIAgent } from '../src/ai/ai.js';
import { Lockstep, LocalSeatAgent, RemoteSeatAgent, HostAIAgent } from '../src/net/lockstep.js';
import { MockHub } from './lib/mockroom.mjs';

const [G = 3, SEED = 1] = process.argv.slice(2).map(Number);
const db = new CardDB(JSON.parse(fs.readFileSync('data/cards.json', 'utf8')), JSON.parse(fs.readFileSync('data/tokens.json', 'utf8')));
const decks = JSON.parse(fs.readFileSync('data/decks.json', 'utf8'));
const byId = Object.fromEntries(decks.map(d => [d.id, d]));
const memStore = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };
function hash(g) { const parts = [g.turnNumber, g.winner, g.uid, g.nextId]; for (const p of g.players) parts.push(p.life, p.lost, ...['hand', 'library', 'graveyard', 'exile', 'command'].map(z => p[z].map(c => c.id).join(','))); for (const c of g.battlefield) parts.push(`${c.id}:${c.tapped}:${JSON.stringify(c.counters)}`); return parts.join('|'); }

function client(hub, { cid, nick, cfg, seat, storage, other }) {
  const ch = hub.connect();
  const net = new Lockstep({ channel: ch, cid, nick, cfg, seat, storage });
  const isHost = cfg.host === cid;
  // (`other`: the person would now answer differently, here by always passing: a decision asked again would split the game)
  const me = other ? (ai => ({ ask: (g, pid, req) => (req.type === 'priority' ? { type: 'pass' } : ai.ask(g, pid, req)) }))(new AIAgent()) : new AIAgent();
  const agents = cfg.seats.map((s, pid) => {
    if (pid === seat) return new LocalSeatAgent(net, me);          // an AI clicks for the person
    if (s.k === 'a' && isHost) return new HostAIAgent(net, new AIAgent());
    return new RemoteSeatAgent(net, null, isHost ? new AIAgent() : null);
  });
  const game = new Game({ db, seed: cfg.seed, maxTurns: 50, players: cfg.seats.map((s, pid) => ({ name: s.n, deck: byId[s.d], agent: agents[pid], human: s.k === 'h' })) });
  if (process.env.DBG) game.debugLog = false, game.debugChoose = true;
  return { ch, net, game, done: game.start() };
}

let failures = 0;
for (let gi = 0; gi < G; gi++) {
  const seed = SEED * 100 + gi;
  const pick = k => decks[(seed * 13 + k * 37) % decks.length].id;
  const hub = new MockHub({ latency: 12 });
  const cfg = { code: 'abc123', game: 1, seed, host: 'H', seats: [{ k: 'h', c: 'H', n: 'Hana', d: pick(0) }, { k: 'h', c: 'G', n: 'Gus', d: pick(1) }, { k: 'a', c: null, n: 'Bot', d: pick(2) }], subs: {} };
  const guestStore = memStore();
  const host = client(hub, { cid: 'H', nick: 'Hana', cfg, seat: 0, storage: memStore() });
  let guest = client(hub, { cid: 'G', nick: 'Gus', cfg, seat: 1, storage: guestStore });
  let spectator = null;
  const t0 = Date.now();
  // mid-game: a spectator arrives, and the guest reloads (same id, same storage)
  await new Promise(r => setTimeout(r, 1500));
  spectator = client(hub, { cid: 'S', nick: 'Sam', cfg, seat: null, storage: null });
  await new Promise(r => setTimeout(r, 800));
  guest.net.close(); guest.game.over = true; guest.ch.leave();
  let reloaded;
  if (process.env.TAKEOVER) {
    // the guest never comes back: once the host is stuck waiting on them, its AI takes the seat
    reloaded = host;
    const iv = setInterval(() => { const w = host.net.waitingOn(); if (w && !w.present && w.seconds >= 1) { host.net.setSubstitute(w.pid, w.seq); clearInterval(iv); console.log(`  host's AI took over seat ${w.pid} at decision ${w.seq}`); } }, 300);
  } else if (process.env.DRIFT) {
    const wrong = { ...cfg, seats: cfg.seats.map((s, i) => (i === 2 ? { ...s, d: pick(5) === s.d ? pick(6) : pick(5) } : s)) };
    reloaded = client(hub, { cid: 'G', nick: 'Gus', cfg: wrong, seat: 1, storage: guestStore });
    const first = reloaded;
    // what the screen does (ui/online.jsx watchDesync): drop this copy, build a fresh one from the room's history
    reloaded = await new Promise(resolve => {
      first.net.onDesync = d => { console.log(`  the guest's copy drifted at decision ${d.seq}: rebuilding it`); first.net.forget(); first.game.over = true; first.ch.leave(); resolve(client(hub, { cid: 'G', nick: 'Gus', cfg, seat: 1, storage: guestStore })); };
      setTimeout(() => resolve(first), 30000);
    });
    if (reloaded === first) console.log('  DRIFT NOT NOTICED');
  } else reloaded = client(hub, { cid: 'G', nick: 'Gus', cfg, seat: 1, storage: process.env.FRESH ? memStore() : guestStore, other: !!process.env.FRESH });
  const timeout = new Promise(r => setTimeout(() => r('timeout'), +(process.env.TMO || 240000)));
  const res = await Promise.race([Promise.all([host.done, reloaded.done]), timeout]);
  // let the spectator finish replaying
  for (let i = 0; i < 200 && !spectator.game.over; i++) await new Promise(r => setTimeout(r, 50));
  if (res === 'timeout') for (const [nm, c] of [['host', host], ['guest', reloaded], ['spec', spectator]]) {
    const w = c.net.waiting;
    console.log(nm, 'seq', c.net.seq, 'log', c.net.log.size, 'edge', c.net.liveEdge(), 'waiting', w && { seq: w.seq, pid: w.pid, prod: c.net.producerOf(w.pid, w.seq) }, 'need', c.net.need, 'serve', c.net.serve, 'o', (c.net.lastPresence && c.net.lastPresence.o || []).map(e => e[0]).slice(0, 3), '...', (c.net.lastPresence && c.net.lastPresence.o || []).map(e => e[0]).slice(-3), 'pending human', c.game.pendingAsk && c.game.pendingAsk.req.type);
  }
  const hs = [hash(host.game), hash(reloaded.game), hash(spectator.game)];
  const drift = [['host', host], ['guest', reloaded], ['spec', spectator]].filter(([, c]) => c.net.desync).map(([nm, c]) => `${nm} at ${c.net.desync.seq}`);
  const same = hs.every(h => h === hs[0]) && res !== 'timeout' && !drift.length;
  if (!same) failures++;
  if (drift.length) console.log('  drift reported:', drift.join(', '));
  console.log(`game ${gi} seed ${seed}: ${same ? 'all peers identical' : 'MISMATCH'} · ${host.net.log.size} decisions · ${host.game.turnNumber} turns · ${((Date.now() - t0) / 1000).toFixed(1)}s${res === 'timeout' ? ' · TIMEOUT' : ''}${same ? '' : '\n  ' + hs.map(h => h.slice(0, 120)).join('\n  ')}`);
  for (const c of [host, reloaded, spectator, guest]) { c.game.over = true; c.net.close(); c.ch.leave(); }
}
console.log(failures ? `${failures} game(s) failed` : 'all games identical across peers');
process.exit(failures ? 1 : 0);
