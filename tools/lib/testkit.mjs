// Shared harness for behavioural engine tests (same board setup as tools/staples.mjs):
// a two-player game frozen in A's first main phase, scripted answers per prompt type/purpose, AI for the rest.
import fs from 'node:fs';
import { CardDB } from '../../src/engine/cards.js';
import { Game } from '../../src/engine/game.js';
import { AIAgent } from '../../src/ai/ai.js';
import { castSpell, activateAbility, activatedAbilities } from '../../src/engine/abilities.js';

export const db = new CardDB(JSON.parse(fs.readFileSync('data/cards.json', 'utf8')), JSON.parse(fs.readFileSync('data/tokens.json', 'utf8')));
const basics = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];
const deck = (name, cmd) => ({ name, commanders: [cmd], cards: basics.map(b => [b, 12]).concat([['Llanowar Elves', 4], ['Serra Angel', 4], ['Wall of Omens', 4]]) });

export class Scripted {
  constructor() { this.ai = new AIAgent(); this.h = {}; this.asked = []; }
  on(type, fn) { this.h[type] = fn; return this; }
  async ask(game, pid, req) {
    this.asked.push(req);
    const f = this.h[req.purpose] || this.h[req.type];
    if (f) { const r = f(req, game); if (r !== undefined) return r; }
    return this.ai.ask(game, pid, req);
  }
}

export async function setup({ players = 2 } = {}) {
  const agents = Array.from({ length: players }, () => new Scripted());
  const cmds = ["Atraxa, Praetors' Voice", 'Sun Titan', 'Serra Angel', 'Llanowar Elves'];
  const game = new Game({ db, seed: 7, players: agents.map((ag, i) => ({ name: 'ABCD'[i], deck: deck('ABCD'[i], cmds[i]), agent: ag })) });
  game.throwErrors = true;
  for (const p of game.players) game.rng.shuffle(p.library);
  game.turnNumber = 3; game.activePlayer = 0; game.step = 'main1'; game.priority = 0;
  const T = {
    game, a: agents[0], b: agents[1], c: agents[2], agents, A: game.players[0], B: game.players[1], C: game.players[2],
    async put(pid, name, zone = 'battlefield', opts = {}) {
      const def = db.get(name);
      if (!def) throw new Error('no card ' + name);
      const c = game.newCard(def, pid); c.zone = 'none';
      if (zone === 'battlefield') { await game.moveCard(c, 'battlefield', { controller: pid, silent: true, ...opts }); c.sick = false; }
      else if (zone === 'library') { c.zone = 'library'; game.players[pid].library.unshift(c); }
      else { c.zone = zone; game.players[pid][zone].push(c); }
      return c;
    },
    async resolve() {
      for (let i = 0; i < 60; i++) {
        await game.processTriggersAndSBA();
        if (!game.stack.length) break;
        await game.resolveTop();
      }
    },
    mana(pid = 0, n = 9) { game.players[pid].pool = { W: n, U: n, B: n, R: n, G: n, C: n }; },
    noMana(pid = 0) { game.players[pid].pool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }; },
    async cast(name, pid = 0, { resolve = true, zone = 'hand', mana = true, action = {} } = {}) {
      const c = await T.put(pid, name, zone);
      if (mana) T.mana(pid);
      game.priority = pid;
      const ok = await castSpell(game, pid, c, action);
      if (!ok) throw new Error(`could not cast ${name}`);
      if (resolve) await T.resolve();
      return c;
    },
    async activate(card, pid = 0, idx = 0, { resolve = true } = {}) {
      T.mana(pid);
      card.sick = false;
      const list = activatedAbilities(game, pid, card);
      const abil = typeof idx === 'function' ? list.find(idx) : list[idx];
      if (!abil) throw new Error('no ability on ' + card.def.name);
      game.priority = pid;
      const ok = await activateAbility(game, pid, card, abil.key, { ignoreTiming: true });
      if (!ok) throw new Error('could not activate ' + card.def.name);
      if (resolve) await T.resolve();
    },
    // set up a combat directly: attacks = [[card, defenderPid | defenderCard]], blocks = [[blocker, attacker]]
    combatWith(attacks, blocks = []) {
      game.combat = {
        attackers: attacks.map(([a, d]) => ({ card: a.id, defenderPlayer: typeof d === 'number' ? d : d.controller, defenderCard: typeof d === 'number' ? null : d.id, blockers: blocks.filter(([, x]) => x === a).map(([b]) => b.id), blocked: blocks.some(([, x]) => x === a) })),
        blockers: new Map(blocks.map(([b, a]) => [b.id, a.id])), firstStrikeDone: new Set(),
      };
      game.touch();
    },
    count(pid, zone, pred = () => true) { return (zone === 'battlefield' ? game.battlefield.filter(c => c.controller === pid) : game.players[pid][zone]).filter(pred).length; },
    tokens(pid) { return game.battlefield.filter(c => c.token && c.controller === pid); },
    named(n) { return c => c.def.name === n || game.name(c) === n; },
    isLand: c => game.chars(c).types.has('Land'),
    isCreature: c => game.chars(c).types.has('Creature'),
    logged(re) { return game.logs.some(l => re.test(l.text)); },
  };
  return T;
}

export const expect = (cond, msg) => { if (!cond) throw new Error('expected: ' + msg); };

export async function run(tests) {
  const ONLY = process.argv[2] ? new RegExp(process.argv[2], 'i') : null;
  let pass = 0, fail = 0;
  for (const t of tests) {
    if (ONLY && !ONLY.test(t.name)) continue;
    try {
      const T = await setup(t.opts);
      await t.fn(T);
      pass++;
    } catch (e) {
      fail++;
      console.log(`FAIL ${t.name}: ${e.message}${e.message.startsWith('expected') ? '' : '\n' + (e.stack || '').split('\n').slice(1, 5).join('\n')}`);
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  return fail;
}
