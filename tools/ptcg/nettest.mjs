// Headless online-play test for Pokémon battles: a host and a guest share an in-memory room and play one battle in
// lockstep (an AI clicks for each person). A spectator joins mid-battle and catches up from history; the guest
// "reloads" mid-battle and replays from storage. TAKEOVER=1: the guest never comes back and the host's AI takes over.
// CHAOS=1: the host and the guest click anything the screen allows, at random (tools/ptcg/chaos.mjs), not the AI.
// Usage: node tools/ptcg/nettest.mjs [games=4] [seed=1]
import fs from 'node:fs';
import { PokemonGame } from '../../src/ptcg/game.js';
import { PokemonAI } from '../../src/ptcg/ai.js';
import { Lockstep, LocalSeatAgent, RemoteSeatAgent } from '../../src/net/lockstep.js';
import { MockHub } from '../lib/mockroom.mjs';
import { ChaosAgent } from './chaos.mjs';

const [G = 4, SEED = 1] = process.argv.slice(2).map(Number);
const db = JSON.parse(fs.readFileSync('data/ptcg/cards.json', 'utf8'));
const decks = JSON.parse(fs.readFileSync('data/ptcg/decks.json', 'utf8'));
const byId = Object.fromEntries(decks.map(d => [d.id, d]));
const memStore = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };
const ids = list => list.map(c => c.id).join(',');
const monStr = m => `${m.id}:${m.name}:${m.damage}:${ids(m.energy)}:${m.tool ? m.tool.id : ''}:${m.special || ''}${m.poisoned ? 'P' : ''}${m.burned ? 'B' : ''}`;
function hash(g) {
  const parts = [g.turn, g.winner, g.uid, g.first, g.stadium ? g.stadium.card.id : ''];
  for (const p of g.players) parts.push(ids(p.hand), ids(p.deck), ids(p.discard), ids(p.prizes), ids(p.lost), p.active ? monStr(p.active) : '-', p.bench.map(monStr).join(';'));
  return parts.join('|');
}

function client(hub, { cid, nick, cfg, seat, storage }) {
  const ch = hub.connect();
  const net = new Lockstep({ channel: ch, cid, nick, cfg, seat, storage });
  const isHost = cfg.host === cid;
  // a person takes a moment over each decision, so the battle is still going when the guest reloads
  const ai = process.env.CHAOS ? new ChaosAgent(cfg.seed * 7 + seat + 1) : new PokemonAI(), slow = { ask: async (g, pid, req) => { await new Promise(r => setTimeout(r, 12)); return ai.ask(g, pid, req); } };
  const agents = cfg.seats.map((s, pid) => pid === seat ? new LocalSeatAgent(net, slow) : new RemoteSeatAgent(net, null, isHost ? new PokemonAI() : null));
  // each browser names its own player "You": names only appear in text
  const game = new PokemonGame({ db, seed: cfg.seed, players: cfg.seats.map((s, pid) => ({ name: pid === seat ? 'You' : s.n, deck: byId[s.d], agent: agents[pid], human: true })) });
  return { ch, net, game, done: game.start() };
}

let failures = 0;
for (let gi = 0; gi < G; gi++) {
  const seed = SEED * 100 + gi;
  const a = decks[(seed * 7) % decks.length].id, b = decks[(seed * 7 + 3 + gi) % decks.length].id;
  const hub = new MockHub({ latency: 12 });
  const cfg = { code: 'abc123', kind: 'pk', game: 1, seed, host: 'H', seats: [{ k: 'h', c: 'H', n: 'Hana', d: a }, { k: 'h', c: 'G', n: 'Gus', d: b }], subs: {} };
  const guestStore = memStore();
  const host = client(hub, { cid: 'H', nick: 'Hana', cfg, seat: 0, storage: memStore() });
  const guest = client(hub, { cid: 'G', nick: 'Gus', cfg, seat: 1, storage: guestStore });
  const t0 = Date.now();
  await new Promise(r => setTimeout(r, 900));
  const spectator = client(hub, { cid: 'S', nick: 'Sam', cfg, seat: null, storage: null });
  await new Promise(r => setTimeout(r, 500));
  const at = { turn: guest.game.turn, seq: guest.net.seq };
  guest.net.close(); guest.game.over = true; guest.ch.leave();
  let reloaded;
  if (process.env.TAKEOVER) {
    reloaded = host;
    const iv = setInterval(() => { const w = host.net.waitingOn(); if (w && !w.present && w.seconds >= 1) { host.net.setSubstitute(w.pid, w.seq); clearInterval(iv); console.log(`  host's AI took over seat ${w.pid} at decision ${w.seq}`); } }, 300);
  } else reloaded = client(hub, { cid: 'G', nick: 'Gus', cfg, seat: 1, storage: guestStore });
  const timeout = new Promise(r => setTimeout(() => r('timeout'), +(process.env.TMO || 180000)));
  const res = await Promise.race([Promise.all([host.done, reloaded.done]), timeout]);
  for (let i = 0; i < 200 && !spectator.game.over; i++) await new Promise(r => setTimeout(r, 50));
  if (res === 'timeout') for (const [nm, c] of [['host', host], ['guest', reloaded], ['spec', spectator]]) {
    const w = c.net.waiting;
    console.log(nm, 'seq', c.net.seq, 'log', c.net.log.size, 'edge', c.net.liveEdge(), 'waiting', w && { seq: w.seq, pid: w.pid, prod: c.net.producerOf(w.pid, w.seq) }, 'need', c.net.need, 'serve', c.net.serve, 'pending', c.game.pendingAsk && c.game.pendingAsk.req.type);
  }
  const hs = [hash(host.game), hash(reloaded.game), hash(spectator.game)];
  const same = hs.every(h => h === hs[0]) && res !== 'timeout';
  if (!same) failures++;
  console.log(`battle ${gi} seed ${seed} ${a} vs ${b}: ${same ? 'all peers identical' : 'MISMATCH'} · ${host.net.log.size} decisions · ${host.game.turn} turns · ${host.game.over ? (host.game.result || 'over') : 'running'} · reload at turn ${at.turn} (decision ${at.seq}) · ${((Date.now() - t0) / 1000).toFixed(1)}s${res === 'timeout' ? ' · TIMEOUT' : ''}${same ? '' : '\n  ' + hs.map(h => h.slice(0, 160)).join('\n  ')}`);
  for (const c of [host, reloaded, spectator, guest]) { c.game.over = true; c.net.close(); c.ch.leave(); }
}
console.log(failures ? `${failures} battle(s) failed` : 'all battles identical across peers');
process.exit(failures ? 1 : 0);
