// AI-vs-AI games with random decks from the whole card pool (data/cards.json + data/more, tools/build-allcards.mjs):
// a random commander, 36 lands in its colors, 63 random spells in its colors, one of each. Most cards only ever
// meet the engine this way, so this finds the errors and stuck games precon games never reach. Errors are grouped
// by message, with the cards involved.
// Usage: node tools/poolsim.mjs [games=40] [players=4] [seed=1] [--turns=25] [--timeout=60000] [--where] [--verbose]
import fs from 'node:fs';
import { CardDB } from '../src/engine/cards.js';
import { Game } from '../src/engine/game.js';
import { AIAgent } from '../src/ai/ai.js';
import { buildIndex, BASICS } from '../src/ui/customdecks.js';

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const pos = args.filter(a => !a.startsWith('--'));
const N = +(pos[0] || 40), NP = +(pos[1] || 4), SEED = +(pos[2] || 1);

const more = JSON.parse(fs.readFileSync('data/more.json', 'utf8'));
const cards = Object.assign(JSON.parse(fs.readFileSync('data/cards.json', 'utf8')), ...Array.from({ length: more.shards }, (_, i) => JSON.parse(fs.readFileSync(`data/more/cards-${i}.json`, 'utf8'))));
const meta = JSON.parse(fs.readFileSync('data/cardmeta.json', 'utf8'));
const db = new CardDB(cards, JSON.parse(fs.readFileSync('data/tokens.json', 'utf8')));
const index = buildIndex(cards).filter(c => !(meta[c.name] && meta[c.name][2]));
const commanders = index.filter(c => c.commander);
const BASIC_FOR = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' };

function rng(seed) { let s = seed >>> 0 || 1; return () => { s = (s * 1103515245 + 12345) >>> 0; return ((s >>> 8) % 1e6) / 1e6; }; }
function randomDeck(r, i) {
  const cmd = commanders[Math.floor(r() * commanders.length)];
  const id = cmd.ci;
  const fits = c => c.ci.every(x => id.includes(x)) && c.name !== cmd.name && c.main !== 'Other' && !BASICS.has(c.name);
  const lands = index.filter(c => c.main === 'Land' && fits(c)), spells = index.filter(c => c.main !== 'Land' && fits(c));
  const take = (list, n) => { const out = new Set(); for (let k = 0; out.size < Math.min(n, list.length) && k < n * 20; k++) out.add(list[Math.floor(r() * list.length)].name); return [...out]; };
  const nonbasic = take(lands, 10), picks = take(spells, 63);
  const basics = 99 - picks.length - nonbasic.length;
  const colors = id.length ? id : ['C'];
  const cardsOut = [...picks.map(n => [n, 1]), ...nonbasic.map(n => [n, 1])];
  colors.forEach((x, k) => { const n = Math.floor(basics / colors.length) + (k < basics % colors.length ? 1 : 0); if (n) cardsOut.push([x === 'C' ? 'Wastes' : BASIC_FOR[x], n]); });
  return { id: `pool-${i}`, name: `Random ${cmd.name}`, commanders: [cmd.name], cards: cardsOut };
}

const errors = new Map(), stuck = [];
// the engine reports what it caught with console.error: keep where it happened, not the noise
const stacks = new Map();
if (!flags.verbose) console.error = e => { if (e && e.message && e.stack) stacks.set(e.message, e.stack.split('\n').slice(1, 3).map(x => x.trim()).join(' | ')); };
let games = 0, turns = 0, casts = 0;
const t0 = Date.now();
const seen = new Set();
for (let g = 0; g < N; g++) {
  const r = rng(SEED * 7919 + g);
  const decks = Array.from({ length: NP }, (_, i) => randomDeck(r, g * NP + i));
  for (const d of decks) for (const [n] of d.cards) seen.add(n);
  const game = new Game({ db, seed: SEED * 1000 + g, players: decks.map((d, i) => ({ name: `AI${i + 1}`, deck: d, agent: new AIAgent() })), maxTurns: +(flags.turns || 25) });
  game.debugLog = !!flags.verbose;
  let timer;
  try {
    await Promise.race([game.start(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), +(flags.timeout || 60000)); })]);
  } catch (e) {
    const k = e.message === 'timeout' ? `TIMEOUT at ${game.step} (stack ${game.stack.length}: ${game.stack.map(s => s.card ? game.name(s.card) : '?').join(', ')})` : (e.stack || e.message).split('\n').slice(0, 3).join(' | ');
    if (e.message === 'timeout') stuck.push(`game ${g}: ${k}`);
    const v = errors.get(k) || { n: 0, cards: new Set() };
    v.n++; errors.set(k, v);
  }
  clearTimeout(timer);
  game.over = true;
  games++; turns += game.turnNumber;
  casts += game.logs.filter(l => l.type === 'cast').length;
  for (const l of game.logs) {
    if (l.type !== 'error') continue;
    // "Effect error (Api) on Card: message", "Error resolving Card's ability: message": grouped by message, cards listed
    let card = null, msg = l.text;
    let m = /^Effect error \((\w+)\) on (.+?): (.*)$/.exec(l.text);
    if (m) { card = m[2]; msg = `Effect error (${m[1]}): ${m[3]}`; }
    else if ((m = /^Error resolving (.+?): (.*)$/.exec(l.text))) { card = m[1]; msg = `Error resolving: ${m[2]}`; }
    const k = msg.replace(/\d+/g, '#').slice(0, 170);
    const v = errors.get(k) || { n: 0, cards: new Set(), where: l.detail || stacks.get(msg.split(': ').slice(1).join(': ')) || '' };
    v.n++;
    if (card) v.cards.add(card);
    errors.set(k, v);
  }
  if (flags.verbose || g % 10 === 9) console.log(`${g + 1}/${N} games, ${errors.size} distinct errors, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
console.log(`\n${games} games, ${turns} turns, ${casts} spells cast, ${seen.size} different cards in the decks, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
const total = [...errors.values()].reduce((a, v) => a + v.n, 0);
for (const [k, v] of [...errors].sort((a, b) => b[1].n - a[1].n).slice(0, 60)) console.log(`${String(v.n).padStart(4)}  ${k}${v.cards.size ? `  [${[...v.cards].slice(0, 6).join('; ')}]` : ''}${v.where && flags.where ? `\n        at ${v.where}` : ''}`);
if (stuck.length) console.log('stuck:\n' + stuck.join('\n'));
console.log(`\n${errors.size} distinct errors, ${total} in all, ${stuck.length} stuck games`);
process.exit(errors.size ? 1 : 0);
