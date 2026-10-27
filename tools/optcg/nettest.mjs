// Headless online-play test for One Piece battles: a host and a guest share an in-memory room and play one battle in
// lockstep (an AI clicks for each person). A spectator joins mid-battle and catches up from history; the guest
// "reloads" mid-battle and replays from storage. TAKEOVER=1: the guest never comes back and the host's AI takes over.
// CHAOS=1: the host and the guest click anything the screen allows, at random (tools/optcg/chaos.mjs), not the AI.
// --custom: both players bring decks of their own (as the deck builder makes them: a Leader and 50 cards in its colors).
// Their lists travel in the host's config, and every peer builds its battle from there (src/optcg/ui/decks.js
// deckOfSeat): each player's own copy of their deck is changed after the start, and nobody may notice.
// Usage: node tools/optcg/nettest.mjs [games=4] [seed=1] [--decks=st01,st02] [--custom]
import { OnePieceGame } from '../../src/optcg/game.js';
import { OnePieceAI } from '../../src/optcg/ai.js';
import { Lockstep, LocalSeatAgent, RemoteSeatAgent } from '../../src/net/lockstep.js';
import { MockHub } from '../lib/mockroom.mjs';
import { ChaosAgent, mulberry32 } from './chaos.mjs';
import { deckOfSeat } from '../../src/optcg/ui/decks.js';
import { packDeck, rulesCheck } from '../../src/optcg/ui/mydecks.js';
import { loadDb, loadDecks, loadPlayableDecks } from './lib.mjs';

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const [G = 4, SEED = 1] = args.filter(a => !a.startsWith('--')).map(Number);
const db = loadDb();
let decks = loadPlayableDecks();
if (flags.decks) decks = decks.filter(d => flags.decks.split(',').includes(d.id));
const byId = Object.fromEntries(decks.map(d => [d.id, d]));
const data = { cards: db, decks: loadDecks() };
// a deck of one's own, made up for the test: a random Leader and 50 cards that share its colors, up to 4 of each
function madeUpDeck(rnd, tag) {
  const leaders = Object.values(db).filter(c => c.cat === 'L');
  const lead = leaders[Math.floor(rnd() * leaders.length)];
  const pool = Object.values(db).filter(c => c.cat !== 'L' && c.colors.some(k => lead.colors.includes(k)));
  const m = new Map();
  for (let n = 0; n < 50;) { const c = pool[Math.floor(rnd() * pool.length)]; if ((m.get(c.id) || 0) < 4) { m.set(c.id, (m.get(c.id) || 0) + 1); n++; } }
  const d = { id: `opd-${tag}`, name: `Made-up ${lead.name}`, leader: lead.id, cards: [...m] };
  if (!rulesCheck(d, db).every(r => r.ok)) throw new Error(`made-up deck ${tag} breaks the rules`);
  return d;
}
// the seat's deck as a browser in the room builds it
const seatDeck = s => (s.dk ? deckOfSeat(data, s.dk, s.d) : byId[s.d]);
// a player's deck in a battle: the Leader and the 50, sorted
const dealt = p => [p.leader.def.id, ...[...p.hand, ...p.deck, ...p.trash, ...p.life, ...p.characters, ...(p.stage ? [p.stage] : [])].map(c => c.def.id).sort()].join(',');
const memStore = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };
const ids = list => list.map(c => c.uid).join(',');
const cardStr = c => `${c.uid}:${c.rested ? 'r' : ''}${c.don}`;
function hash(g) {
  const parts = [g.turn, g.winner, g.uid, g.first];
  for (const p of g.players) parts.push(ids(p.hand), ids(p.deck), ids(p.trash), ids(p.life), cardStr(p.leader), p.characters.map(cardStr).join(';'), p.stage ? p.stage.uid : '-', p.donDeck, p.donActive, p.donRested);
  return parts.join('|');
}

function client(hub, { cid, nick, cfg, seat, storage }) {
  const ch = hub.connect();
  const net = new Lockstep({ channel: ch, cid, nick, cfg, seat, storage });
  const isHost = cfg.host === cid;
  // a person takes a moment over each decision, so the battle is still going when the guest reloads
  const ai = process.env.CHAOS ? new ChaosAgent(cfg.seed * 7 + seat + 1) : new OnePieceAI(), slow = { ask: async (g, pid, req) => { await new Promise(r => setTimeout(r, 12)); return ai.ask(g, pid, req); } };
  const agents = cfg.seats.map((s, pid) => pid === seat ? new LocalSeatAgent(net, slow) : new RemoteSeatAgent(net, null, isHost ? new OnePieceAI() : null));
  // each browser names its own player "You": names only appear in text
  const game = new OnePieceGame({ db, seed: cfg.seed, players: cfg.seats.map((s, pid) => ({ name: pid === seat ? 'You' : s.n, deck: seatDeck(s), agent: agents[pid], human: true })) });
  return { ch, net, game, done: game.start() };
}

let failures = 0;
for (let gi = 0; gi < G; gi++) {
  const seed = SEED * 100 + gi;
  let a = decks[(seed * 7) % decks.length].id, b = decks[(seed * 7 + 3 + gi) % decks.length].id;
  const seats = [{ k: 'h', c: 'H', n: 'Hana', d: a }, { k: 'h', c: 'G', n: 'Gus', d: b }];
  const own = [];
  if (flags.custom) {
    // each player's own deck: its list goes into the config when the host starts (as optcg/ui/app.jsx onStart does)
    const rnd = mulberry32(seed * 31 + 7);
    seats.forEach((s, i) => { const d = madeUpDeck(rnd, `n${seed}p${i}`); own.push(d); s.d = d.id; s.dk = packDeck(d); });
    a = own[0].name; b = own[1].name;
  }
  const hub = new MockHub({ latency: 12 });
  const cfg = { code: 'abc123', kind: 'op', game: 1, seed, host: 'H', seats, subs: {} };
  const want = own.map(d => [d.leader, ...d.cards.flatMap(([k, n]) => Array(n).fill(k)).sort()].join(','));
  // (the players change their own decks once the battle has started: the battle keeps the lists it started with)
  for (const d of own) { d.cards.reverse(); d.cards[0] = [d.cards[0][0], Math.max(1, d.cards[0][1] - 1)]; }
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
  const hs = [hash(host.game), hash(reloaded.game), hash(spectator.game)];
  // an effect the engine had to skip (it logs it instead of throwing in a real game) is a failure here too
  const problems = [host.game, reloaded.game, spectator.game].flatMap(g => g.problems || []);
  if (problems.length) console.log(`  engine problems: ${[...new Set(problems)].join('; ')}`);
  // with decks of their own: every peer dealt each player exactly the deck they brought
  const wrongDeck = want.length ? [host.game, reloaded.game, spectator.game].some(g => g.players.some((p, i) => dealt(p) !== want[i])) : false;
  if (wrongDeck) console.log('  a peer dealt a deck other than the one its player brought');
  const same = hs.every(h => h === hs[0]) && res !== 'timeout' && !problems.length && !wrongDeck;
  if (!same) failures++;
  console.log(`battle ${gi} seed ${seed} ${a} vs ${b}: ${same ? 'all peers identical' : 'MISMATCH'} · ${host.net.log.size} decisions · ${host.game.turn} turns · ${host.game.over ? (host.game.result || 'over') : 'running'} · reload at turn ${at.turn} (decision ${at.seq}) · ${((Date.now() - t0) / 1000).toFixed(1)}s${res === 'timeout' ? ' · TIMEOUT' : ''}${same ? '' : '\n  ' + hs.map(h => h.slice(0, 160)).join('\n  ')}`);
  for (const c of [host, reloaded, spectator, guest]) { c.game.over = true; c.net.close(); c.ch.leave(); }
}
console.log(failures ? `${failures} battle(s) failed` : 'all battles identical across peers');
process.exit(failures ? 1 : 0);
