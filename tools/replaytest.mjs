// Lockstep check for online play: record every decision of an AI game, replay the decisions into a second
// engine with the same seed, and require identical logs and final state. Also flags AI asks that mutate ids.
// Usage: node tools/replaytest.mjs [games=20] [players=2] [seed=1]
import fs from 'node:fs';
import { CardDB } from '../src/engine/cards.js';
import { Game } from '../src/engine/game.js';
import { AIAgent } from '../src/ai/ai.js';

const [N = 20, NP = 2, SEED = 1] = process.argv.slice(2).map(Number);
const db = new CardDB(JSON.parse(fs.readFileSync('data/cards.json', 'utf8')), JSON.parse(fs.readFileSync('data/tokens.json', 'utf8')));
const decks = JSON.parse(fs.readFileSync('data/decks.json', 'utf8'));

function stateHash(g) {
  const parts = [g.turnNumber, g.winner, g.uid, g.nextId];
  for (const p of g.players) parts.push(p.life, p.lost, ...['hand', 'library', 'graveyard', 'exile', 'command'].map(z => p[z].map(c => c.id).join(',')));
  for (const c of g.battlefield) parts.push(`${c.id}:${c.tapped}:${JSON.stringify(c.counters)}:${c.controller}:${c.damage}`);
  return parts.join('|');
}

let bad = 0, mutating = 0, asks = 0;
for (let i = 0; i < N; i++) {
  const seed = SEED * 1000 + i;
  const chosen = Array.from({ length: NP }, (_, k) => decks[(seed * 7 + k * 31) % decks.length]);
  const rec = [];
  const recorder = (ai) => ({ async ask(game, pid, req) {
    const u = game.uid, n = game.nextId, v = game.version;
    let ans = await ai.ask(game, pid, req);
    if (game.uid !== u || game.nextId !== n) { mutating++; game.uid = u; game.nextId = n; }
    ans = ans === undefined ? null : JSON.parse(JSON.stringify(ans));
    rec.push([pid, req.type, ans]);
    return ans;
  } });
  const cfg = (agentFor) => ({ db, seed, maxTurns: 60, players: chosen.map((d, k) => ({ name: `P${k}`, deck: d, agent: agentFor(k) })) });
  const A = new Game(cfg(() => recorder(new AIAgent())));
  await A.start();
  let at = 0, mismatch = null;
  const replayer = { async ask(game, pid, req) {
    const e = rec[at++];
    if (!e) { mismatch = mismatch || `ran past the log at ask ${at}`; game.over = true; return null; }
    if (e[0] !== pid || e[1] !== req.type) { mismatch = mismatch || `ask ${at - 1}: expected P${e[0]} ${e[1]}, got P${pid} ${req.type}`; }
    return e[2];
  } };
  const B = new Game(cfg(() => replayer));
  await B.start();
  asks += rec.length;
  const la = A.logs.map(l => l.text), lb = B.logs.map(l => l.text);
  let firstDiff = la.findIndex((t, k) => t !== lb[k]);
  if (firstDiff < 0 && la.length !== lb.length) firstDiff = Math.min(la.length, lb.length);
  const same = !mismatch && firstDiff < 0 && stateHash(A) === stateHash(B);
  if (!same) { bad++; console.log(`game ${i} seed ${seed}: DIVERGED ${mismatch || ''} log@${firstDiff}: "${la[firstDiff]}" vs "${lb[firstDiff]}"`); }
  else console.log(`game ${i} seed ${seed}: identical (${rec.length} decisions, ${A.turnNumber} turns)`);
}
console.log(`\n${N} games, ${bad} diverged, ${asks} decisions replayed, ${mutating} AI asks changed ids (restored)`);
