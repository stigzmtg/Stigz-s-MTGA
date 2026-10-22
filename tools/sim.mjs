// Headless AI-vs-AI simulation for stress-testing the engine.
// Usage: node tools/sim.mjs [games=20] [players=2] [seed] [--deck=<id>] [--verbose] [--throw]
import fs from 'node:fs';
import { CardDB } from '../src/engine/cards.js';
import { Game } from '../src/engine/game.js';
import { AIAgent } from '../src/ai/ai.js';
import { unknownProps } from '../src/engine/filters.js';

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const pos = args.filter(a => !a.startsWith('--'));
const N = +(pos[0] || 20), NP = +(pos[1] || 2);
let seed = +(pos[2] || 12345);

const cards = JSON.parse(fs.readFileSync('data/cards.json', 'utf8'));
const tokens = JSON.parse(fs.readFileSync('data/tokens.json', 'utf8'));
const decks = JSON.parse(fs.readFileSync('data/decks.json', 'utf8'));
const db = new CardDB(cards, tokens);

const stats = { games: 0, errors: 0, turns: 0, unsupported: new Map(), errorMsgs: new Map(), timeouts: 0, winners: {} };
const t0 = Date.now();
for (let g = 0; g < N; g++) {
  const s = seed + g;
  const rnd = (k) => { let x = Math.sin(s * 9301 + k * 49297) * 233280; return x - Math.floor(x); };
  const chosen = [];
  for (let i = 0; i < NP; i++) {
    let d = decks[Math.floor(rnd(i + 1) * decks.length)];
    if (flags.deck && i === 0) d = decks.find(x => x.id.includes(flags.deck)) || d;
    chosen.push(d);
  }
  const game = new Game({ db, seed: s, players: chosen.map((d, i) => ({ name: `AI${i + 1} (${d.name})`, deck: d, agent: new AIAgent() })), maxTurns: +(flags.turns || 40) });
  game.throwErrors = !!flags.throw;
  game.debugLog = !!flags.verbose;
  game.debugMana = !!flags.mana;
  const gs = Date.now();
  let timer;
  try {
    await Promise.race([game.start(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), +(flags.timeout || 60000)); })]);
  } catch (e) {
    stats.errors++;
    const k = (e.stack || e.message).split('\n').slice(0, 4).join(' | ');
    stats.errorMsgs.set(k, (stats.errorMsgs.get(k) || 0) + 1);
    if (e.message === 'timeout') { stats.timeouts++; console.log(`game ${g} seed ${s}: TIMEOUT at turn ${game.turnNumber} step ${game.step} stack=${game.stack.length}`); }
    else console.log(`game ${g} seed ${s} ERROR: ${e.stack}`);
    game.over = true;
  }
  clearTimeout(timer);
  game.over = true;
  if (game.error) { stats.errors++; const k = (game.error.stack || '').split('\n').slice(0, 4).join(' | '); stats.errorMsgs.set(k, (stats.errorMsgs.get(k) || 0) + 1); }
  stats.games++;
  stats.turns += game.turnNumber;
  for (const l of game.logs) {
    if (l.type === 'unsupported') { const k = l.text.replace(/^Not automated: /, '').replace(/.*\[(\w+)\]$/, '$1'); stats.unsupported.set(k, (stats.unsupported.get(k) || 0) + 1); }
    if (l.type === 'error' && flags.details) console.log(`  [seed ${s} T${l.turn ?? '?'}] ${l.text} ${l.detail || ''}`);
    if (l.type === 'error') { stats.errorMsgs.set(l.text.slice(0, 160), (stats.errorMsgs.get(l.text.slice(0, 160)) || 0) + 1); }
  }
  const w = game.winner != null ? game.players[game.winner].name : 'none';
  console.log(`game ${g} seed ${s}: ${chosen.map(d => d.name).join(' vs ')} -> ${w} in ${game.turnNumber} turns (${((Date.now() - gs) / 1000).toFixed(1)}s) ${game.resultText || ''}`);
}
console.log(`\n${stats.games} games, ${stats.errors} errors, ${stats.timeouts} timeouts, avg ${(stats.turns / stats.games).toFixed(1)} turns, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (stats.errorMsgs.size) { console.log('\nErrors:'); for (const [k, v] of [...stats.errorMsgs].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(v, k); }
if (stats.unsupported.size) { console.log('\nUnsupported:'); console.log([...stats.unsupported].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => `${k}:${v}`).join('  ')); }
if (unknownProps.size) console.log('\nUnknown filter props:', [...unknownProps].slice(0, 60).join(', '));
