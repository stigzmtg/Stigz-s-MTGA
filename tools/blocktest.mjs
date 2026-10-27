// Who can block whom, for every card in the game: each creature whose rules text says something about blocking
// (flying, can't be blocked, fear, intimidate, shadow, horsemanship, skulk, landwalk, protection from a color,
// menace, "can't block", "can block only creatures with flying") attacks a line-up of plain creature tokens (or
// blocks a plain attacker), and the engine's answer (canBlock, blockRules) has to match what the card's own words
// say. The words are read here independently of the card's script, so a script or engine slip shows up. Then the
// reasons the table shows for a refused block read right, and a declared illegal block never happens.
// Usage: node tools/blocktest.mjs [name filter]
import { setup, db } from './lib/testkit.mjs';
import { canBlock, canBlockAny, blockRules, blockProblem, declareBlockers } from '../src/engine/combat.js';

const ONLY = process.argv[2] ? new RegExp(process.argv[2], 'i') : null;
let pass = 0, fail = 0, cards = 0;
const fails = [];
const ok = (c, msg) => { if (c) pass++; else { fail++; fails.push(msg); } };

// the line-up: plain tokens, each one thing a blocking rule can care about
const REFS = {
  bear: 'g_2_2_bear',              // green 2/2, nothing else
  zombie: 'b_2_2_zombie',          // black
  robot: 'c_2_2_a_robot',          // colorless artifact
  angel: 'w_4_4_angel_flying',     // white flyer
  spider: 'g_1_2_spider_reach',    // reach
  thopter: 'c_1_1_a_thopter_flying', // artifact flyer
  wurm: 'g_6_6_wurm',              // big
  goblin: 'r_1_1_goblin',          // red
  merfolk: 'u_1_1_merfolk',        // blue
  soldier: 'w_1_1_soldier',        // white
};
const COLOR = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
const KEYWORDS = /^(?:flying|reach|menace|fear|intimidate|shadow|horsemanship|skulk|vigilance|trample|haste|deathtouch|lifelink|first strike|double strike|defender|hexproof|indestructible|ward \{\d+\}|protection from [a-z]+|(?:forest|island|swamp|mountain|plains)walk|changeling|flash|prowess)(?:, (?:flying|reach|menace|fear|intimidate|shadow|horsemanship|skulk|vigilance|trample|haste|deathtouch|lifelink|first strike|double strike|defender|hexproof|indestructible|ward \{\d+\}|protection from [a-z]+|(?:forest|island|swamp|mountain|plains)walk|changeling|flash|prowess))*$/;

async function token(T, pid, script) {
  const def = db.token(script);
  if (!def) throw new Error('no token ' + script);
  const c = T.game.newCard(def, pid);
  c.zone = 'none'; c.token = true;
  await T.game.moveCard(c, 'battlefield', { controller: pid, silent: true });
  c.sick = false; c.tapped = false;   // (Kinjalli's Sunwing: opponents' creatures enter tapped)
  return c;
}

// what a creature's words say about blocking it: keyword lines only (a keyword in a sentence is usually conditional
// or given to something else), and "can't be blocked." as a whole sentence
function rulesFromText(name, text) {
  const t = text.replace(/\([^)]*\)/g, '').split(name).join('this').split(name.split(',')[0]).join('this').toLowerCase();
  const lines = t.split('\n').map(l => l.trim()).filter(Boolean);
  const kws = new Set();
  for (const l of lines) if (KEYWORDS.test(l)) for (const k of l.split(', ')) kws.add(k);
  const out = {
    flying: kws.has('flying'), reach: kws.has('reach'), menace: kws.has('menace'), fear: kws.has('fear'), intimidate: kws.has('intimidate'),
    shadow: kws.has('shadow'), horsemanship: kws.has('horsemanship'), skulk: kws.has('skulk'),
    walk: [...kws].map(k => /^(forest|island|swamp|mountain|plains)walk$/.exec(k)).filter(Boolean).map(m => m[1][0].toUpperCase() + m[1].slice(1))[0] || null,
    pro: [...kws].map(k => /^protection from (white|blue|black|red|green)$/.exec(k)).filter(Boolean).map(m => COLOR[m[1]]),
    unblockable: lines.some(l => /^this (?:creature )?can't be blocked\.$/.test(l)),
    cantBlock: lines.some(l => /^this (?:creature )?can't block\.$/.test(l)) || lines.some(l => /^this (?:creature )?can't attack or block\.$/.test(l)),
    onlyFlyers: lines.some(l => /^this (?:creature )?can block only creatures with flying\.$/.test(l)),
    // anything that might change these in play, or that the line-up would trip: leave the card out
    murky: /as long as|during your turn|during each|if you control|unless|except by|by more than|can't be blocked by|can block|gets? \+|have flying|has flying|gains? flying|can't attack|attacks each|blocks each|transform|for each|creatures you control|other creatures|enchanted|equipped|crew|station|power or toughness|changeling|all creatures|level|chosen|choose/.test(t),
  };
  return out;
}

const all = db.names().filter(n => !ONLY || ONLY.test(n));
for (const name of all) {
  const def = db.get(name);
  if (!def || !/\bCreature\b/.test(def.types ? [...(def.types || [])].join(' ') : (def.typeLine || def.type || ''))) {
    // (CardDef keeps the type line in different shapes; read it from the script)
    const raw = db.raw[name] || '';
    if (!/^Types:.*\bCreature\b/m.test(raw)) continue;
  }
  const raw = db.raw[name] || '';
  if (/^AlternateMode:/m.test(raw)) continue;   // double-faced, split, adventurers: the front face's words are mixed in
  const oracle = ((/^Oracle:(.*)$/m.exec(raw) || [])[1] || '').replace(/\\n/g, '\n');
  const r = rulesFromText(name, oracle);
  const evasive = r.flying || r.menace || r.fear || r.intimidate || r.shadow || r.horsemanship || r.skulk || r.walk || r.pro.length || r.unblockable;
  if (r.murky || !(evasive || r.cantBlock || r.onlyFlyers)) continue;
  cards++;
  try {
    const T = await setup();
    const g = T.game;
    // ---- as an attacker
    if (evasive) {
      const a = await T.put(0, name);
      if (!g.chars(a).types.has('Creature')) continue;
      if (r.walk) await T.put(1, r.walk);
      const refs = {};
      for (const [k, s] of Object.entries(REFS)) refs[k] = await token(T, 1, s);
      const ach = g.chars(a);
      const apow = ach.power;
      for (const [k, b] of Object.entries(refs)) {
        const bch = g.chars(b);
        const bFly = bch.keywords.includes('Flying'), bReach = bch.keywords.includes('Reach');
        let want = true;
        if (r.unblockable) want = false;
        if (r.flying && !bFly && !bReach) want = false;
        if (r.shadow || r.horsemanship) want = false;   // no token in the line-up has them
        if (r.fear && !bch.types.has('Artifact') && !bch.colors.has('B')) want = false;
        if (r.intimidate && !bch.types.has('Artifact') && ![...ach.colors].some(c => bch.colors.has(c))) want = false;
        if (r.skulk && bch.power > apow) want = false;
        if (r.walk) want = false;
        if (r.pro.some(c => bch.colors.has(c))) want = false;
        const got = canBlock(g, b, a);
        ok(got === want, `${name} vs ${k}: the engine says ${got ? 'can' : 'can’t'} block, its words say ${want ? 'can' : 'can’t'}${got ? '' : ` (${blockProblem(g, b, a)})`}`);
        if (!got) ok(typeof blockProblem(g, b, a) === 'string' && blockProblem(g, b, a).length > 10, `${name} vs ${k}: a reason is given`);
      }
      if (r.menace) ok(blockRules(g, a).min === 2, `${name}: menace needs two blockers (${blockRules(g, a).min})`);
    }
    // ---- as a blocker
    if (r.cantBlock || r.onlyFlyers) {
      const b = await T.put(1, name);
      const walker = await token(T, 0, 'w_1_1_soldier'), flyer = await token(T, 0, 'u_1_1_bird_flying');
      if (r.cantBlock) ok(!canBlockAny(g, b) && !canBlock(g, b, walker), `${name} can't block`);
      if (r.onlyFlyers) {
        ok(!canBlock(g, b, walker), `${name} can't block a creature without flying`);
        ok(canBlock(g, b, flyer), `${name} can block a flyer`);
      }
    }
  } catch (e) {
    ok(false, `${name}: ${e.message}`);
  }
}

// ---- a declared block the rules don't allow never happens (the engine drops it), a legal one does
{
  const T = await setup();
  const g = T.game;
  const angel = await token(T, 0, 'w_4_4_angel_flying'), soldier = await token(T, 0, 'w_1_1_soldier');
  const bear = await token(T, 1, 'g_2_2_bear');
  T.combatWith([[angel, 1], [soldier, 1]]);
  g.combat.attackers.forEach(x => { x.blockers = []; x.blocked = false; });
  g.combat.blockers = new Map();
  g.step = 'declareBlockers';
  T.b.on('blockers', () => [{ blocker: bear.id, attacker: angel.id }]);
  await declareBlockers(g);
  ok(!g.combat.blockers.has(bear.id), 'a ground creature declared blocking a flyer doesn’t block');
  ok(/flying/.test(blockProblem(g, bear, angel)), `the reason names flying (${blockProblem(g, bear, angel)})`);
  T.combatWith([[angel, 1], [soldier, 1]]);
  g.combat.attackers.forEach(x => { x.blockers = []; x.blocked = false; });
  g.combat.blockers = new Map();
  T.b.on('blockers', () => [{ blocker: bear.id, attacker: soldier.id }]);
  await declareBlockers(g);
  ok(g.combat.blockers.get(bear.id) === soldier.id, 'a legal block happens');
  // menace with one blocker: dropped
  const ogre = await token(T, 0, 'r_2_2_spirit_menace');
  T.combatWith([[ogre, 1]]);
  g.combat.attackers.forEach(x => { x.blockers = []; x.blocked = false; });
  g.combat.blockers = new Map();
  T.b.on('blockers', () => [{ blocker: bear.id, attacker: ogre.id }]);
  await declareBlockers(g);
  ok(!g.combat.blockers.has(bear.id), 'one blocker on a creature with menace doesn’t block');
  // tapped creatures can't block
  bear.tapped = true;
  ok(!canBlock(g, bear, soldier) && /tapped/.test(blockProblem(g, bear, soldier)), 'a tapped creature can’t block, and says so');
}

for (const f of fails.slice(0, 60)) console.log('FAIL', f);
if (fails.length > 60) console.log(`… and ${fails.length - 60} more`);
console.log(`\n${cards} cards checked\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
