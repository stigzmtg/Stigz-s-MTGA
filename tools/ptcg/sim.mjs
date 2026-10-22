// Headless Pokémon TCG games between computer players, to find rules and AI bugs.
// Usage: node tools/ptcg/sim.mjs [games=40] [--deck=id] [--seed=N] [--verbose]
import fs from 'node:fs';
import { PokemonGame } from '../../src/ptcg/game.js';
import { PokemonAI } from '../../src/ptcg/ai.js';

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const N = +(args.find(a => !a.startsWith('--')) || 40);
const db = JSON.parse(fs.readFileSync('data/ptcg/cards.json', 'utf8'));
const decks = JSON.parse(fs.readFileSync('data/ptcg/decks.json', 'utf8'));
const seed0 = +(flags.seed || 1);

const stats = { games: 0, errors: 0, timeouts: 0, turns: 0, wins: {}, games_by: {}, reasons: {} };
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const seed = seed0 + i;
  const a = flags.deck ? decks.find(d => d.id === flags.deck) : decks[i % decks.length];
  const b = flags.opp ? decks.find(d => d.id === flags.opp) : decks[(i * 7 + Math.floor(i / decks.length) + 3) % decks.length];
  const g = new PokemonGame({ db, seed, players: [{ name: a.name, deck: a, agent: new PokemonAI() }, { name: b.name + (a === b ? ' 2' : ''), deck: b, agent: new PokemonAI() }], maxTurns: 90 });
  g.throwErrors = true;
  let err = null;
  const run = g.start().catch(e => { err = e; });
  const timer = new Promise(r => setTimeout(() => r('timeout'), 20000));
  const r = await Promise.race([run.then(() => 'done'), timer]);
  stats.games++;
  stats.turns += g.turn;
  for (const d of [a, b]) stats.games_by[d.id] = (stats.games_by[d.id] || 0) + 1;
  if (r === 'timeout') { stats.timeouts++; console.log(`game ${i} seed ${seed}: TIMEOUT at turn ${g.turn}`, g.pendingAsk && JSON.stringify(g.pendingAsk.req).slice(0, 200)); continue; }
  if (err) { stats.errors++; console.log(`game ${i} seed ${seed} ${a.id} vs ${b.id}: ERROR turn ${g.turn}: ${err.stack.split('\n').slice(0, 4).join(' | ')}`); continue; }
  const w = g.winner == null ? 'draw' : [a, b][g.winner].id;
  stats.wins[w] = (stats.wins[w] || 0) + 1;
  const reason = g.result.replace(/^.*?(took all|has no Pokémon|can't draw|Turn limit|Both|Neither).*$/, '$1');
  stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
  if (flags.log) console.log(g.logs.map(l => (l.type === 'turn' ? '\n' : '  ') + l.text).join('\n'));
  if (flags.verbose) console.log(`game ${i} seed ${seed}: ${a.id} vs ${b.id} -> ${w} in ${g.turn} turns (${g.result})`);
}
console.log(`\n${stats.games} games, ${stats.errors} errors, ${stats.timeouts} timeouts, avg ${(stats.turns / stats.games).toFixed(1)} turns, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('win reasons', JSON.stringify(stats.reasons));
console.log('wins', Object.entries(stats.wins).map(([k, v]) => `${k} ${v}/${stats.games_by[k] || '-'}`).join(', '));
