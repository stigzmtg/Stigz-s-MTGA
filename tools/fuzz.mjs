// Chaos-player fuzzer for the Commander engine: some seats answer every prompt with uniformly random
// legal choices (random actions, targets, modes, X, cancels, attacks and blocks), the rest are the AI.
// Every prompt, every offered action and every state is checked; failures are grouped and printed.
// Usage: node tools/fuzz.mjs [games=50] [players=2|4|mix] [seed=1] [--chaos=N] [--turns=25] [--timeout=60000]
//        [--out=report.json] [--stop] [--verbose] [--quiet]
import fs from 'node:fs';
import { CardDB } from '../src/engine/cards.js';
import { Game } from '../src/engine/game.js';
import { AIAgent } from '../src/ai/ai.js';
import { getActions, manaSourcesFor, parseCost, fromRef, spellOptions } from '../src/engine/abilities.js';
import { matchValid } from '../src/engine/filters.js';

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const pos = args.filter(a => !a.startsWith('--'));
const N = +(pos[0] || 50);
const NPspec = pos[1] || 'mix';
const SEED = +(pos[2] || 1);
const MAX_TURNS = +(flags.turns || 25);
const TIMEOUT = +(flags.timeout || 60000);
const MAX_ASKS = +(flags.asks || 60000);
const PASS = +(flags.pass || 0.3);
const CONCEDE = +(flags.concede ?? 0.0015);

const db = new CardDB(JSON.parse(fs.readFileSync('data/cards.json', 'utf8')), JSON.parse(fs.readFileSync('data/tokens.json', 'utf8')));
const decks = JSON.parse(fs.readFileSync('data/decks.json', 'utf8'));

// a small seeded PRNG of our own: the chaos player must never touch the game's RNG
function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// ------------------------------------------------------------------ failure bookkeeping
const failures = new Map(); // key -> { count, samples: [] }
const totals = { games: 0, asks: 0, prompts: 0, actionsChecked: 0, actionsTaken: 0, cancels: 0, invariantChecks: 0, errors: 0, timeouts: 0, turns: 0 };
let cur = null; // { seed, gameIndex, game }
function fail(kind, detail, extra = {}) {
  const key = kind + ' :: ' + String(detail).slice(0, 180);
  let f = failures.get(key);
  if (!f) { f = { kind, detail: String(detail).slice(0, 400), count: 0, samples: [] }; failures.set(key, f); }
  f.count++;
  if (f.samples.length < 3) f.samples.push({ seed: cur && cur.seed, turn: cur && cur.game.turnNumber, step: cur && cur.game.step, ...extra });
  if (flags.verbose && f.count === 1) console.log(`  FAIL [${kind}] ${detail} (seed ${cur && cur.seed} T${cur && cur.game.turnNumber} ${cur && cur.game.step})`);
  if (flags.stop) throw new Error(`stop: ${kind}: ${detail}`);
}

const name = (game, id) => { const c = game.cardById(id); return c ? game.name(c) || c.def.name : '#' + id; };

// ------------------------------------------------------------------ prompt validation
function validatePrompt(game, pid, req) {
  const t = req.type;
  const num = v => typeof v === 'number' && Number.isFinite(v);
  const range = (min, max, avail, what) => {
    if (!num(min) || !num(max)) return fail('prompt', `${t}/${req.purpose || '-'}: min/max not numbers (${min}, ${max})`, { prompt: req.prompt });
    if (min > max) fail('prompt', `${t}/${req.purpose || '-'}: min ${min} > max ${max}`, { prompt: req.prompt });
    if (avail != null && min > avail) fail('prompt', `${t}/${req.purpose || '-'}: needs ${min} but only ${avail} ${what} offered`, { prompt: req.prompt });
    if (min < 0) fail('prompt', `${t}/${req.purpose || '-'}: negative min`, { prompt: req.prompt });
  };
  switch (t) {
    case 'priority': case 'mulligan': case 'confirm': return;
    case 'cards': {
      if (!Array.isArray(req.cards)) return fail('prompt', `cards/${req.purpose}: no card list`);
      for (const id of req.cards) if (!game.cardById(id)) fail('prompt', `cards/${req.purpose}: unknown card id offered`);
      if (new Set(req.cards).size !== req.cards.length) fail('prompt', `cards/${req.purpose}: duplicate card offered`);
      return range(req.min, req.max, req.cards.length, 'cards');
    }
    case 'targets': {
      if (!Array.isArray(req.cands)) return fail('prompt', `targets/${req.purpose}: no candidate list`);
      for (const r of req.cands) if (!fromRef(game, r)) fail('prompt', `targets/${req.purpose}: unresolvable candidate ${r}`);
      if (new Set(req.cands).size !== req.cands.length) fail('prompt', `targets/${req.purpose}: duplicate candidate`);
      return range(req.min, req.max, req.cands.length, 'candidates');
    }
    case 'modes': {
      if (!Array.isArray(req.options) || !req.options.length) return fail('prompt', `modes/${req.purpose}: no options`);
      return range(req.min, req.max, req.repeat ? null : req.options.length, 'modes');
    }
    case 'option': {
      if (!Array.isArray(req.options) || !req.options.length) return fail('prompt', `option/${req.purpose}: no options`, { prompt: req.prompt });
      const vals = req.options.map(o => JSON.stringify(o.value));
      if (new Set(vals).size !== vals.length) fail('prompt', `option/${req.purpose}: duplicate option values`, { prompt: req.prompt });
      for (const o of req.options) if (o.label == null || o.label === '') fail('prompt', `option/${req.purpose}: option without a label`);
      return;
    }
    case 'number': return range(req.min, req.max, null, '');
    case 'color': if (!Array.isArray(req.colors) || !req.colors.length) fail('prompt', `color/${req.purpose}: no colors`); return;
    case 'player': if (!Array.isArray(req.players) || !req.players.length || req.players.some(p => !game.players[p])) fail('prompt', `player/${req.purpose}: bad player list`); return;
    case 'attackers': {
      if (!Array.isArray(req.candidates) || !Array.isArray(req.defenders)) return fail('prompt', 'attackers: malformed');
      if (req.candidates.length && !req.defenders.length) fail('prompt', 'attackers: candidates but no defenders');
      return;
    }
    case 'blockers': if (!Array.isArray(req.candidates) || !Array.isArray(req.attackers)) fail('prompt', 'blockers: malformed'); return;
    default: fail('prompt', `unknown prompt type ${t}`);
  }
}

// ------------------------------------------------------------------ invariants
const ZONES = ['library', 'hand', 'graveyard', 'exile', 'command'];
function checkInvariants(game, initial, atPriority) {
  totals.invariantChecks++;
  const seen = new Map();
  const place = (c, where) => {
    if (!c) return fail('state', `null card in ${where}`);
    if (seen.has(c.id)) fail('state', `${c.def.name} is in two places (${seen.get(c.id)} and ${where})`);
    seen.set(c.id, where);
  };
  const gone = c => c && game.players[c.owner] && game.players[c.owner].lost; // a player who leaves takes their cards along
  for (const p of game.players) for (const z of ZONES) for (const c of p[z]) {
    place(c, `${p.name}:${z}`);
    if (c.zone !== z) fail('state', `${c.def.name} listed in ${z} but its zone is ${c.zone}`);
    if (c.owner !== p.id) fail('state', `${c.def.name} in someone else's ${z}`);
  }
  for (const c of game.battlefield) {
    place(c, 'battlefield');
    if (c.zone !== 'battlefield') fail('state', `${c.def.name} on the battlefield list with zone ${c.zone}`);
    if (game.cardById(c.id) !== c) { fail('state', `${c.def.name}${c.token ? ' (token)' : ''} is on the battlefield but not registered in the game (id ${c.id} → ${game.cardById(c.id) ? game.cardById(c.id).def.name : 'nothing'})`); if (flags.verbose && !cur.dumped) { cur.dumped = true; console.log(game.logs.slice(-40).map(l => `    [T${l.turn}] ${l.text}`).join('\n')); } }
  }
  for (const it of game.stack) if (it.card && it.kind === 'spell') { place(it.card, 'stack'); if (it.card.zone !== 'stack') fail('state', `stack spell ${it.card.def.name} has zone ${it.card.zone}`); }
  const counts = game.players.map(() => 0);
  for (const c of game.cards.values()) {
    if (c.token || c.isSpellCopy) {
      if (c.zone !== 'battlefield' && c.zone !== 'stack' && c.zone !== 'gone' && c.zone !== 'none') fail('state', `token ${c.def.name} survives in ${c.zone}`);
      continue;
    }
    if (gone(c)) continue;
    counts[c.owner]++;
    if (!seen.has(c.id) && c.zone !== 'stack') fail('state', `${c.def.name} (zone ${c.zone}) is in no zone list`);
    if (c.zone === 'stack' && !seen.has(c.id) && !game.stack.some(s => s.card === c)) {
      // a card can sit in "stack" only while being cast
      if (atPriority) fail('state', `${c.def.name} is on the stack without a stack object`);
    }
  }
  counts.forEach((n, i) => { if (!game.players[i].lost && n !== initial[i]) fail('state', `${game.players[i].name}: ${n} cards, started with ${initial[i]}`); });
  for (const c of game.cards.values()) {
    for (const [k, v] of Object.entries(c.counters || {})) if (!(Number.isFinite(v) && v >= 0)) fail('state', `${c.def.name} has ${v} ${k} counters`);
    if (!(c.damage >= 0)) fail('state', `${c.def.name} has ${c.damage} damage`);
  }
  for (const p of game.players) {
    if (!Number.isFinite(p.life)) fail('state', `${p.name} life is ${p.life}`);
    for (const [k, v] of Object.entries(p.counters || {})) if (!(Number.isFinite(v) && v >= 0)) fail('state', `${p.name} has ${v} ${k} counters`);
    for (const [k, v] of Object.entries(p.pool || {})) if (!(Number.isFinite(v) && v >= 0)) fail('state', `${p.name} has ${v} ${k} mana`);
  }
  if (atPriority && !game.over) {
    // state-based actions have just been checked
    for (const c of game.battlefield) {
      if (c.phasedOut) continue;
      const ch = game.chars(c);
      if (ch.types.has('Creature') && ch.toughness <= 0) fail('sba', `${ch.name} is on the battlefield with toughness ${ch.toughness}`);
      if (ch.types.has('Planeswalker') && !(c.counters.LOYALTY > 0) && !ch.types.has('Creature')) fail('sba', `${ch.name} is on the battlefield with 0 loyalty`);
      if (ch.subtypes.has('Aura') && c.attachedTo == null && !ch.types.has('Creature')) fail('sba', `${ch.name} is an Aura attached to nothing`);
      const offField = ch.keywords.some(k => /^Enchant:.*inZone/.test(k)); // Animate Dead: "enchant creature card in a graveyard"
      if (typeof c.attachedTo === 'number' && !offField) { const t = game.cardById(c.attachedTo); if (!t || t.zone !== 'battlefield') fail('sba', `${ch.name} is attached to something not on the battlefield`); }
    }
    for (const p of game.players) if (!p.lost && p.life <= 0 && !game.cantHappen?.('GameLoss', p)) fail('sba', `${p.name} is alive at ${p.life} life`);
  }
}

// ------------------------------------------------------------------ legality oracle for offered actions
const PHASE_ORDER = ['untap', 'upkeep', 'draw', 'main1', 'beginCombat', 'declareAttackers', 'declareBlockers', 'firstStrikeDamage', 'combatDamage', 'endCombat', 'main2', 'end', 'cleanup'];
const PHASE_NAME = { Untap: 'untap', Upkeep: 'upkeep', Draw: 'draw', Main1: 'main1', BeginCombat: 'beginCombat', 'Declare Attackers': 'declareAttackers', 'Declare Blockers': 'declareBlockers', 'First Strike Damage': 'firstStrikeDamage', 'Combat Damage': 'combatDamage', EndCombat: 'endCombat', Main2: 'main2', 'End of Turn': 'end', Cleanup: 'cleanup' };
function phaseIn(game, spec) {
  const at = PHASE_ORDER.indexOf(game.step);
  return spec.split(',').some(part => {
    if (part.includes('->')) { const [a, b] = part.split('->').map(x => PHASE_ORDER.indexOf(PHASE_NAME[x.trim()])); return a >= 0 && b >= 0 && at >= a && at <= b; }
    return PHASE_NAME[part.trim()] === game.step;
  });
}
function hasteLike(game, c) {
  return game.hasKeyword(c, 'Haste') || game.activeStatics('ActivateAbilityAsIfHaste').some(s => matchValid(game, c, s.p.ValidCard || 'Card', s.ctx));
}
function oracle(game, pid, actions) {
  const p = game.players[pid];
  const sorcery = game.activePlayer === pid && game.isMainPhase() && game.stack.length === 0;
  for (const a of actions) {
    totals.actionsChecked++;
    const card = game.cardById(a.cardId);
    if (!card) { fail('oracle', `${a.type} offered for a card that doesn't exist`); continue; }
    const nm = game.name(card) || card.def.name;
    if (a.type === 'land') {
      if (!sorcery) fail('oracle', `land play offered outside your main phase with an empty stack (${nm})`);
      if (p.landsPlayed >= 1 + game.playerChars(pid).extraLands) fail('oracle', `land play offered after the land drop was used (${nm})`);
      if (!['hand', 'library', 'graveyard', 'exile', 'command'].includes(card.zone)) fail('oracle', `land play offered from ${card.zone} (${nm})`);
      continue;
    }
    if (a.type === 'cast') {
      const ch = game.chars(card);
      const opt = spellOptions(game, pid, card).find(o => o.key === a.optionKey);
      if (!opt) { fail('oracle', `cast option ${a.optionKey} not among the card's options (${nm})`); continue; }
      const face = card.def.faces[opt.face || 0] || card.def.faces[0];
      const instant = face.types.includes('Instant') || game.hasKeywordIn(ch, 'Flash') || face.keywords.includes('Flash') || opt.mayFlash || opt.flash || opt.altCost === 'Ninjutsu';
      const flashStatic = game.activeStatics('CastWithFlash').length > 0;
      if (!sorcery && !instant && !flashStatic && !/flash|instant/i.test(a.label || '')) fail('oracle', `sorcery-speed spell offered at instant speed (${nm}, ${a.label})`);
      if (game.stack.some(s => s.splitSecond)) fail('oracle', `spell offered while a split second spell is on the stack (${nm})`);
      continue;
    }
    if (a.type === 'activate') {
      const abil = game.chars(card).abilities.find(x => x.key === a.abilityKey);
      if (!abil) { fail('oracle', `activate offered for an ability the card doesn't have (${nm})`); continue; }
      const ap = abil.parsed.p;
      const cost = parseCost(ap.Cost);
      const zones = ap.ActivationZone ? ap.ActivationZone.toLowerCase().split(',').map(z => z.trim()) : ['battlefield'];
      if (!zones.includes(card.zone)) fail('oracle', `ability usable only from ${zones.join('/')} offered from ${card.zone} (${nm}: ${a.label})`);
      if (abil.parsed.api === 'Ninjutsu' && !(game.combat && game.combat.attackers.some(x => !x.blocked && (game.cardById(x.card) || {}).controller === pid) && ['declareBlockers', 'firstStrikeDamage', 'combatDamage', 'endCombat'].includes(game.step))) fail('oracle', `ninjutsu offered without an unblocked attacker after blocks (${nm})`);
      if (card.zone === 'battlefield' && card.controller !== pid && ap.AnyPlayer !== 'True' && !/Player|Opponent/.test(ap.Activator || '')) fail('oracle', `another player's ability offered (${nm})`);
      if (card.zone !== 'battlefield' && card.owner !== pid) fail('oracle', `ability of another player's card in ${card.zone} offered (${nm})`);
      if (card.zone === 'battlefield' && card.phasedOut) fail('oracle', `phased-out permanent's ability offered (${nm})`);
      if (cost.tap || cost.untap) {
        if (card.zone !== 'battlefield') fail('oracle', `{T} ability offered off the battlefield (${nm})`);
        if (cost.tap && card.tapped) fail('oracle', `{T} ability offered on a tapped permanent (${nm}: ${a.label})`);
        if (cost.untap && !card.tapped) fail('oracle', `{Q} ability offered on an untapped permanent (${nm})`);
        if (game.chars(card).types.has('Creature') && card.sick && !hasteLike(game, card)) fail('oracle', `{T}/{Q} ability offered on a summoning-sick creature (${nm}: ${a.label})`);
      }
      if (ap.Planeswalker === 'True') {
        const limit = 1 + game.activeStatics('NumLoyaltyAct').length;
        if ((card.abilityUses.__pw || 0) >= limit) fail('oracle', `second loyalty ability offered this turn (${nm})`);
        if (!sorcery) fail('oracle', `loyalty ability offered at instant speed (${nm})`);
        const sub = cost.parts.find(pt => pt.type === 'SubCounter' && /LOYALTY/i.test(pt.counter || ''));
        if (sub && /^\d+$/.test(sub.amount) && +sub.amount > (card.counters.LOYALTY || 0)) fail('oracle', `minus ${sub.amount} loyalty ability offered with ${card.counters.LOYALTY || 0} loyalty (${nm})`);
      }
      if ((ap.SorcerySpeed === 'True' || ap.IsEquip === 'True') && !sorcery) fail('oracle', `sorcery-speed ability offered at instant speed (${nm}: ${a.label})`);
      if (ap.ActivationLimit && /^\d+$/.test(ap.ActivationLimit) && (card.abilityUses[abil.key] || 0) >= +ap.ActivationLimit) fail('oracle', `ability offered past its activation limit (${nm}: ${a.label})`);
      if (ap.PlayerTurn === 'True' && game.activePlayer !== pid) fail('oracle', `"only during your turn" ability offered on another turn (${nm})`);
      if (ap.OpponentTurn === 'True' && game.activePlayer === pid) fail('oracle', `"only during an opponent's turn" ability offered on your turn (${nm})`);
      if (ap.ActivationPhases && !phaseIn(game, ap.ActivationPhases)) fail('oracle', `ability limited to ${ap.ActivationPhases} offered during ${game.step} (${nm})`);
      for (const pt of cost.parts) {
        if (pt.type === 'PayLife' && /^\d+$/.test(pt.amount) && p.life < +pt.amount) fail('oracle', `ability offered that costs ${pt.amount} life with ${p.life} life (${nm})`);
        if ((pt.type === 'Sac' || pt.type === 'Exile' || pt.type === 'Discard' || pt.type === 'Return') && /CARDNAME|Card\.Self/.test(pt.valid || '') && pt.type !== 'Discard' && card.zone !== 'battlefield' && pt.type !== 'Exile') fail('oracle', `self-sacrifice ability offered off the battlefield (${nm})`);
      }
      continue;
    }
    fail('oracle', `unknown action type ${a.type}`);
  }
}

// ------------------------------------------------------------------ combat legality, checked at the first priority after declarations
function combatOracle(game) {
  const cb = game.combat;
  if (!cb || !cur) return;
  const key = `${game.turnNumber}:${game.combatsThisTurn || 0}:${game.step}`;
  if (cur.combatChecked === key) return;
  cur.combatChecked = key;
  if (game.step === 'declareAttackers') {
    for (const a of cb.attackers) {
      const c = game.cardById(a.card);
      if (!c || c.zone !== 'battlefield') continue;
      const ch = game.chars(c);
      totals.actionsChecked++;
      if (!ch.types.has('Creature')) fail('combat', `non-creature ${ch.name} is attacking`);
      if (c.sick && !game.hasKeyword(c, 'Haste') && !c.token) fail('combat', `summoning-sick ${ch.name} is attacking`);
      if (game.hasKeyword(c, 'Defender') && !game.activeStatics('CanAttackDefender').length) fail('combat', `${ch.name} with defender is attacking`);
      if (a.defenderPlayer === c.controller) fail('combat', `${ch.name} is attacking its own controller`);
      if (a.defenderPlayer != null && game.players[a.defenderPlayer] && game.players[a.defenderPlayer].lost) fail('combat', `${ch.name} is attacking a player who left`);
    }
  }
  if (game.step === 'declareBlockers') {
    const byAttacker = new Map();
    for (const [b, a] of cb.blockers) {
      const bc = game.cardById(b), ac = game.cardById(a);
      if (!bc || !ac || bc.zone !== 'battlefield' || ac.zone !== 'battlefield') continue;
      totals.actionsChecked++;
      const bch = game.chars(bc), ach = game.chars(ac);
      byAttacker.set(a, (byAttacker.get(a) || 0) + 1);
      if (!bch.types.has('Creature')) fail('combat', `non-creature ${bch.name} is blocking`);
      if (bc.controller === ac.controller) fail('combat', `${bch.name} blocks its own controller's attacker`);
      if (game.hasKeyword(ac, 'Flying') && !game.hasKeyword(bc, 'Flying') && !game.hasKeyword(bc, 'Reach')) fail('combat', `${bch.name} (no flying/reach) blocks ${ach.name} (flying)`);
      if (game.hasKeyword(ac, 'Shadow') && !game.hasKeyword(bc, 'Shadow')) fail('combat', `${bch.name} blocks ${ach.name} (shadow)`);
      const atk = cb.attackers.find(x => x.card === a);
      if (atk && atk.defenderPlayer != null && bc.controller !== atk.defenderPlayer && !atk.defenderCard) fail('combat', `${bch.name} blocks an attacker that isn't attacking its controller`);
    }
    for (const [a, n] of byAttacker) {
      const ac = game.cardById(a);
      if (ac && game.hasKeyword(ac, 'Menace') && n < 2) fail('combat', `${game.name(ac)} (menace) is blocked by one creature`);
    }
  }
}

// ------------------------------------------------------------------ snapshots (for cancelled / failed actions)
function snapshot(game) {
  return {
    players: game.players.map(p => ({ life: p.life, pool: { ...p.pool }, counters: { ...p.counters }, landsPlayed: p.landsPlayed })),
    cards: new Map([...game.cards.values()].map(c => [c.id, `${c.zone}|${c.tapped ? 1 : 0}|${JSON.stringify(c.counters)}|${c.controller}|${c.attachedTo}`])),
    stack: game.stack.length,
  };
}
function diffSnap(game, a, b) {
  const out = [];
  a.players.forEach((p, i) => {
    const q = b.players[i];
    if (p.life !== q.life) out.push(`${game.players[i].name} life ${p.life}→${q.life}`);
    for (const k of new Set([...Object.keys(p.pool), ...Object.keys(q.pool)])) if ((p.pool[k] || 0) !== (q.pool[k] || 0)) out.push(`${game.players[i].name} ${k} mana ${p.pool[k] || 0}→${q.pool[k] || 0}`);
    for (const k of new Set([...Object.keys(p.counters), ...Object.keys(q.counters)])) if ((p.counters[k] || 0) !== (q.counters[k] || 0)) out.push(`${game.players[i].name} ${k} counters`);
    if (p.landsPlayed !== q.landsPlayed) out.push(`${game.players[i].name} land drop used`);
  });
  for (const [id, s] of b.cards) { const s0 = a.cards.get(id); if (s0 !== s) out.push(`${name(game, id)}: ${s0 || 'new'} → ${s}`); }
  for (const [id] of a.cards) if (!b.cards.has(id)) out.push(`${name(game, id)} vanished`);
  if (a.stack !== b.stack) out.push(`stack ${a.stack}→${b.stack}`);
  return out;
}

// ------------------------------------------------------------------ the chaos player
class ChaosAgent {
  constructor(rng) { this.rng = rng; this.cancelled = false; this.windowActs = 0; this.lastWindow = null; }
  pick(list) { return list[Math.floor(this.rng() * list.length)]; }
  subset(list, min, max) {
    const hi = Math.min(max, list.length);
    const k = min + Math.floor(this.rng() * (hi - min + 1));
    const pool = list.slice(), out = [];
    while (out.length < k && pool.length) out.push(pool.splice(Math.floor(this.rng() * pool.length), 1)[0]);
    return out;
  }
  cancel(req) { if (req.cancellable && this.rng() < 0.12) { this.cancelled = true; totals.cancels++; return true; } return false; }
  async ask(game, pid, req) {
    const r = this.rng;
    // the engine asking again ("There's no legal target with X = 5", "You can't pay for all of those modes")
    // means our earlier answer was a mistake a person could make too: if the action fails now, it's on us
    if (/^(There's no legal target|You can't pay for all|Those creatures' total power)/.test(req.prompt || '')) this.cancelled = true;
    switch (req.type) {
      case 'priority': {
        // a handful of actions per step at most: {X} abilities could otherwise be activated for 0 forever
        const win = `${game.turnNumber}:${game.step}`;
        if (win !== this.lastWindow) { this.lastWindow = win; this.windowActs = 0; }
        if (this.windowActs > 10 || r() < PASS) return { type: 'pass' };
        // now and then someone leaves a multiplayer game (their cards leave with them)
        if (game.livingPlayers().length > 2 && r() < CONCEDE) return { type: 'concede' };
        const acts = getActions(game, pid);
        const mana = r() < 0.15 ? manaSourcesFor(game, pid).map(s => ({ type: 'mana', cardId: s.card.id, abilityKey: s.abil.key, color: this.pick([...new Set(s.units.flat())]) })) : [];
        const all = [...acts, ...mana];
        if (!all.length) return { type: 'pass' };
        this.windowActs++;
        const a = this.pick(all);
        this.cancelled = false;
        return a;
      }
      case 'mulligan': return r() < 0.75 || (req.count || 0) >= 2;
      case 'confirm': if (this.cancel(req)) return null; return r() < 0.5;
      case 'targets': if (this.cancel(req)) return null; return this.subset(req.cands, Math.min(req.min, req.cands.length), req.max);
      case 'cards': {
        if (this.cancel(req)) return null;
        const pick = this.subset(req.cards, Math.min(req.min, req.cards.length), req.max);
        // crew: a person adds creatures until the power is enough (the engine asks again otherwise)
        if (req.purpose === 'crew' && req.need) for (const id of req.cards) { if (pick.reduce((a, x) => a + Math.max(0, game.chars(game.cardById(x)).power), 0) >= req.need) break; if (!pick.includes(id)) pick.push(id); }
        return pick;
      }
      case 'option': if (this.cancel(req)) return null; return this.pick(req.options).value;
      case 'modes': {
        if (this.cancel(req)) return null;
        if (req.repeat) { const k = req.min + Math.floor(r() * (req.max - req.min + 1)); return Array.from({ length: k }, () => this.pick(req.options).value); }
        return this.subset(req.options.map(o => o.value), req.min, req.max);
      }
      case 'number': if (this.cancel(req)) return null; return req.min + Math.floor(r() * (req.max - req.min + 1));
      case 'color': if (this.cancel(req)) return null; return this.pick(req.colors);
      case 'player': if (this.cancel(req)) return null; return this.pick(req.players);
      case 'attackers': {
        const out = [];
        for (const id of req.candidates) if (r() < 0.5 && req.defenders.length) out.push({ attacker: id, defender: this.pick(req.defenders).ref });
        return out;
      }
      case 'blockers': {
        const out = [];
        for (const id of req.candidates) if (r() < 0.4 && req.attackers.length) out.push({ blocker: id, attacker: this.pick(req.attackers) });
        return out;
      }
      default: return null;
    }
  }
}

// every seat goes through this: prompts are validated, the state is checked, actions are judged
class Checked {
  constructor(inner, chaos) { this.inner = inner; this.chaos = chaos; }
  async ask(game, pid, req) {
    totals.asks++;
    if (cur) cur.asks++;
    if (cur && cur.asks > MAX_ASKS && flags.verbose) console.log(game.logs.slice(-40).map(l => `  [T${l.turn}] ${l.text}`).join('\n'));
    if (cur && cur.asks > MAX_ASKS) { fail('hang', `more than ${MAX_ASKS} prompts in one game (turn ${game.turnNumber}, ${game.step})`); game.over = true; throw new Error('fuzz: too many prompts'); }
    validatePrompt(game, pid, req);
    totals.prompts++;
    checkInvariants(game, cur.initial, req.type === 'priority');
    if (req.type === 'priority') { oracle(game, pid, getActions(game, pid)); combatOracle(game); }
    const ans = await this.inner.ask(game, pid, req);
    if (flags.verbose) { (cur.trail = cur.trail || []).push(`${req.type}/${req.purpose || ''} ${(req.prompt || '').slice(0, 60)} [${req.min ?? ''}-${req.max ?? ''}] -> ${JSON.stringify(ans)?.slice(0, 80)}`); if (cur.trail.length > 12) cur.trail.shift(); }
    return ans;
  }
}

// ------------------------------------------------------------------ run
const t0 = Date.now();
for (let g = 0; g < N; g++) {
  const seed = SEED + g;
  const rng = mulberry(seed * 7919 + 13);
  const np = NPspec === 'mix' ? (rng() < 0.5 ? 2 : 4) : +NPspec;
  const chosen = Array.from({ length: np }, () => decks[Math.floor(rng() * decks.length)]);
  const nChaos = flags.chaos != null ? Math.min(np, +flags.chaos) : 1 + Math.floor(rng() * np);
  const chaosSeats = new Set();
  while (chaosSeats.size < nChaos) chaosSeats.add(Math.floor(rng() * np));
  const agents = chosen.map((d, i) => chaosSeats.has(i) ? new Checked(new ChaosAgent(mulberry(seed * 31 + i)), true) : new Checked(new AIAgent(), false));
  const game = new Game({ db, seed, players: chosen.map((d, i) => ({ name: `${chaosSeats.has(i) ? 'Chaos' : 'AI'}${i + 1}`, deck: d, agent: agents[i], human: chaosSeats.has(i) })), maxTurns: MAX_TURNS });
  game.throwErrors = true;
  game.debugMana = !!flags.mana;
  const initial = game.players.map(p => [...game.cards.values()].filter(c => c.owner === p.id && !c.token).length);
  cur = { seed, gameIndex: g, game, initial, asks: 0, acts: new Map() };
  // wrap actions: offered-but-failed actions, cancels that leave costs paid, costs that weren't paid
  const perform = game.performAction.bind(game);
  game.performAction = async (pid, action) => {
    const agent = agents[pid];
    const chaos = agent.chaos ? agent.inner : null;
    const before = snapshot(game);
    const card = action.cardId != null ? game.cardById(action.cardId) : null;
    const nm = card ? (game.name(card) || card.def.name) : '?';
    const abil = action.type === 'activate' && card ? game.chars(card).abilities.find(x => x.key === action.abilityKey) : null;
    if (chaos) chaos.cancelled = false;
    totals.actionsTaken++;
    const diagBefore = flags.diag ? { pool: { ...game.players[pid].pool }, sources: manaSourcesFor(game, pid).map(s => `${game.name(s.card)}${s.card.tapped ? '(T)' : ''}:${s.units.map(u => u.join('')).join(',')}${s.extraCost ? '+cost' : ''}`), lands: game.battlefield.filter(c => c.controller === pid && game.chars(c).types.has('Land')).map(c => `${game.name(c)}${c.tapped ? '(T)' : ''}`) } : null;
    const ok = await perform(pid, action);
    if (!ok && action.type !== 'concede') {
      const d = diffSnap(game, before, snapshot(game));
      if (chaos && chaos.cancelled) { if (d.length) fail('cancel', `cancelling ${action.type} ${nm} left changes: ${d.slice(0, 4).join('; ')}`, { label: action.label }); }
      else {
        fail('offered', `${action.type} offered but not performed: ${nm} (${(action.label || '').slice(0, 80)})`);
        if (flags.verbose) console.log('    ' + (cur.trail || []).join('\n    '));
        if (diagBefore) console.log('    DIAG', JSON.stringify(diagBefore), 'option cost', JSON.stringify(action.manaCost), '\n    LOGS', game.logs.slice(-4).map(l => l.text).join(' | '));
        if (d.length && !d.every(x => / mana |tapped|\|1\|/.test(x))) fail('cancel', `failed ${action.type} ${nm} left changes: ${d.slice(0, 4).join('; ')}`);
      }
    }
    if (ok && abil) {
      const cost = parseCost(abil.parsed.p.Cost);
      if (cost.tap && card.zone === 'battlefield' && !card.tapped && before.cards.get(card.id)?.startsWith('battlefield|0')) fail('cost', `{T} ability activated without tapping (${nm}: ${(action.label || '').slice(0, 60)})`);
      // {X} abilities (for 0) and {0} abilities can legally be activated again and again
      // (and Basalt Monolith's "{3}: Untap": a legal, pointless loop)
      if (cost.mana.x || /\bX\b/.test(abil.parsed.p.Cost || '') || (!cost.tap && !cost.untap && !cost.parts.length && !cost.hasMana) || /^0$/.test((abil.parsed.p.Cost || '').trim()) || abil.parsed.api === 'Untap') return ok;
      const k = `${game.turnNumber}:${card.id}:${action.abilityKey}`;
      const n = (cur.acts.get(k) || 0) + 1;
      cur.acts.set(k, n);
      if (n === 25) fail('cost', `ability activated 25 times in one turn (${nm}: ${(action.label || '').slice(0, 60)})`);
    }
    if (ok && action.type === 'cast' && card && card.zone !== 'stack' && !game.stack.some(s => s.card === card) && !card.token) {
      // it may already have resolved/been countered only if something resolved in between (it can't have)
      fail('cost', `cast ${nm} returned true but the card isn't on the stack (zone ${card.zone})`);
    }
    return ok;
  };
  let timer;
  const gs = Date.now();
  try {
    await Promise.race([game.start(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), TIMEOUT); })]);
  } catch (e) {
    if (e.message === 'timeout') { totals.timeouts++; fail('hang', `game timed out at turn ${game.turnNumber} (${game.step}, stack ${game.stack.length})`); }
    else if (!/^fuzz:|^stop:/.test(e.message)) { totals.errors++; fail('error', (e.stack || e.message).split('\n').slice(0, 3).join(' | ')); }
    else if (/^stop:/.test(e.message)) { console.log(e.message); clearTimeout(timer); break; }
    game.over = true;
  }
  clearTimeout(timer);
  game.over = true;
  if (game.error) { totals.errors++; fail('error', (game.error.stack || game.error.message).split('\n').slice(0, 3).join(' | ')); }
  for (const [i, l] of game.logs.entries()) if (l.type === 'error') { fail(/^Too many objects resolved/.test(l.text) ? 'loop-guard' : 'error-log', l.text.slice(0, 160)); if (flags.verbose) console.log(game.logs.slice(Math.max(0, i - 25), i + 1).map(x => `    [T${x.turn}] ${x.text}`).join('\n')); }
  totals.games++;
  totals.turns += game.turnNumber;
  if (!flags.quiet) console.log(`game ${g} seed ${seed}: ${np}p, chaos seats ${[...chaosSeats].join(',')} · ${chosen.map(d => d.name).join(' / ')} · ${game.turnNumber} turns, ${cur.asks} prompts, ${((Date.now() - gs) / 1000).toFixed(1)}s ${game.resultText || ''}`);
}

const list = [...failures.values()].sort((a, b) => b.count - a.count);
console.log(`\n${totals.games} games (${totals.turns} turns), ${totals.prompts} prompts, ${totals.actionsChecked} offered actions checked, ${totals.actionsTaken} actions taken, ${totals.cancels} cancels, ${totals.errors} errors, ${totals.timeouts} timeouts, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log(`${list.length} distinct failures, ${list.reduce((a, f) => a + f.count, 0)} total`);
for (const f of list.slice(0, +(flags.top || 60))) console.log(`${String(f.count).padStart(5)} [${f.kind}] ${f.detail}  e.g. seed ${f.samples[0].seed} T${f.samples[0].turn} ${f.samples[0].step}`);
if (flags.out) fs.writeFileSync(flags.out, JSON.stringify({ totals, failures: list }, null, 1));
process.exit(list.length ? 1 : 0);
