// Per-card smoke test: cast / activate / play out each card in a live game with AI choices.
// Usage: node tools/cardtest.mjs [--shard=i/n] [--card=Name] [--out=file.json] [--verbose] [--extra | --all]
import fs from 'node:fs';
import { CardDB } from '../src/engine/cards.js';
import { Game } from '../src/engine/game.js';
import { AIAgent } from '../src/ai/ai.js';
import { getActions, castSpell, activateAbility, activatedAbilities, canActivate } from '../src/engine/abilities.js';
import { unknownProps, unknownDefined } from '../src/engine/filters.js';

const flags = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const cards = JSON.parse(fs.readFileSync('data/cards.json', 'utf8'));
// --extra: the cards beyond the page's own (data/more, from tools/build-allcards.mjs); --all: every card
const moreN = fs.existsSync('data/more.json') ? JSON.parse(fs.readFileSync('data/more.json', 'utf8')).shards : 0;
const extra = Object.assign({}, ...Array.from({ length: moreN }, (_, i) => JSON.parse(fs.readFileSync(`data/more/cards-${i}.json`, 'utf8'))));
const testing = flags.extra ? Object.keys(extra) : flags.all ? [...Object.keys(cards), ...Object.keys(extra)] : Object.keys(cards);
Object.assign(cards, extra);
const tokens = JSON.parse(fs.readFileSync('data/tokens.json', 'utf8'));
const decks = JSON.parse(fs.readFileSync('data/decks.json', 'utf8'));
const db = new CardDB(cards, tokens);
let names = testing.sort();
if (flags.card) names = names.filter(n => n.toLowerCase().includes(String(flags.card).toLowerCase()));
if (flags.shard) { const [i, n] = flags.shard.split('/').map(Number); names = names.filter((_, k) => k % n === i); }

const SETUP = {
  lands: ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Command Tower'],
  creatures: ['Llanowar Elves', 'Serra Angel', 'Hill Giant', 'Grizzly Bears', 'Wall of Omens'],
  other: ['Sol Ring', 'Arcane Signet'],
  grave: ['Lightning Bolt', 'Grizzly Bears', 'Divination', 'Wall of Omens'],
};
const pick = list => list.map(n => db.get(n) ? n : null).filter(Boolean);
const deckA = decks[0], deckB = decks[1];

async function runOne(name, seed) {
  const game = new Game({ db, seed, players: [{ name: 'A', deck: deckA, agent: new AIAgent() }, { name: 'B', deck: deckB, agent: new AIAgent() }], maxTurns: 99 });
  game.throwErrors = true;
  const res = { name, errors: [], unsupported: [], ok: true };
  try {
    for (const p of game.players) { game.rng.shuffle(p.library); await game.drawCards(p, 5, null, true); }
    game.turnNumber = 3; game.activePlayer = 0; game.step = 'main1'; game.priority = 0;
    const put = async (pid, n, zone = 'battlefield') => {
      const def = db.get(n); if (!def) return null;
      const c = game.newCard(def, pid); c.zone = 'none';
      if (zone === 'battlefield') { await game.moveCard(c, 'battlefield', { controller: pid, silent: true }); c.sick = false; }
      else { c.zone = zone; game.players[pid][zone].push(c); }
      return c;
    };
    for (const pid of [0, 1]) {
      for (const n of pick(SETUP.lands)) { await put(pid, n); await put(pid, n); }
      for (const n of pick(SETUP.creatures)) await put(pid, n);
      for (const n of pick(SETUP.other)) await put(pid, n);
      for (const n of pick(SETUP.grave)) await put(pid, n, 'graveyard');
    }
    await game.processTriggersAndSBA();
    game.pendingTriggers = [];
    game.stack = [];
    const p0 = game.players[0];
    p0.pool = { W: 8, U: 8, B: 8, R: 8, G: 8, C: 8 };
    const card = game.newCard(db.get(name), 0);
    card.zone = 'hand'; p0.hand.push(card);
    game.touch();
    const resolveAll = async () => {
      for (let i = 0; i < 40 && (game.stack.length || game.pendingTriggers.length); i++) {
        await game.processTriggersAndSBA();
        if (game.stack.length) await game.resolveTop();
        if (game.over) break;
      }
    };
    // 1. cast / play it
    const acts = getActions(game, 0).filter(a => a.cardId === card.id);
    if (acts.length) { await game.performAction(0, acts[0]); await resolveAll(); res.cast = true; }
    else {
      // instants needing targets etc. - try forcing a cast from effect
      try { res.cast = await castSpell(game, 0, card, {}, { free: true, fromEffect: true }); await resolveAll(); } catch (e) { if (!e.cancelled) throw e; }
    }
    // 2. activate every ability once (permanent on battlefield or card in hand/graveyard)
    if (card.zone !== 'gone') {
      for (const abil of activatedAbilities(game, card.controller != null ? card.controller : 0, card)) {
        if (game.over) break;
        p0.pool = { W: 8, U: 8, B: 8, R: 8, G: 8, C: 8 };
        card.sick = false;
        if (canActivate(game, 0, card, abil, { ignoreTiming: true })) { await activateAbility(game, 0, card, abil.key, { ignoreTiming: true }); await resolveAll(); }
      }
    }
    // 3. play two more full turns so triggers (upkeep, attacks, end step) fire
    game.priority = 0;
    if (!game.over) { game.activePlayer = 1; await game.takeTurn(); }
    if (!game.over) await game.takeTurn();
  } catch (e) {
    if (e.message !== 'game over') { res.ok = false; res.errors.push((e.stack || e.message).split("\n").slice(0, 40).join(' | ')); }
  }
  for (const l of game.logs) {
    if (l.type === 'unsupported') res.unsupported.push(l.text);
    if (l.type === 'error') { res.ok = false; res.errors.push(l.text); }
  }
  if (flags.verbose) for (const l of game.logs) console.log(`[T${l.turn}] ${l.text}`);
  return res;
}

const results = [];
const t0 = Date.now();
let i = 0;
for (const n of names) {
  if (flags.progress) fs.appendFileSync(flags.progress, n + '\n');
  const r = await Promise.race([runOne(n, 1000 + i++), new Promise(res => setTimeout(() => res({ name: n, ok: false, errors: ['timeout'], unsupported: [] }), 20000))]);
  results.push(r);
  if (!r.ok && !flags.out) console.log(`FAIL ${n}: ${r.errors.slice(0, 2).join(' || ')}`);
}
const failed = results.filter(r => !r.ok);
const summary = { total: results.length, failed: failed.length, secs: (Date.now() - t0) / 1000, unknownProps: [...unknownProps], unknownDefined: [...unknownDefined] };
if (flags.out) fs.writeFileSync(flags.out, JSON.stringify({ summary, failed, unsupported: results.filter(r => r.unsupported.length).map(r => ({ name: r.name, u: r.unsupported })) }));
console.log(JSON.stringify(summary).slice(0, 2000));
process.exit(0);
