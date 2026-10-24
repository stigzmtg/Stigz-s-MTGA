// Rules tests for the One Piece engine: set up a board, take an action, check the result. Rule numbers refer to the
// Comprehensive Rules v1.2.1 (2026-08-28). Usage: node tools/optcg/rules.mjs [filter]
import { OnePieceGame, OCard } from '../../src/optcg/game.js';
import { OnePieceAI } from '../../src/optcg/ai.js';
import { packValue, unpackValue } from '../../src/net/lockstep.js';
import { loadDb, loadDecks } from './lib.mjs';

const db = loadDb();
const decks = loadDecks();
const FILLER = 'ST01-008';     // Nico Robin: a vanilla 3-cost 5000 Character
const deckOf = (leader, card = FILLER) => ({ id: 'test', name: 'Test', leader, cards: [[card, 50]] });

// a scripted player: answers from handlers by hint or type, else the AI's choice
class Scripted {
  constructor() { this.ai = new OnePieceAI(); this.h = {}; this.asked = []; }
  on(k, f) { this.h[k] = f; return this; }
  async ask(g, pid, req) {
    this.asked.push(req);
    const f = this.h[req.hint] || this.h[req.type];
    if (f) { const v = f(req, g); if (v !== undefined) return v; }
    return this.ai.ask(g, pid, req);
  }
}

// a game in the middle of turn 3 (player 0's second turn, player 0 went first), Main Phase, empty boards
function setup({ leaders = ['ST01-001', 'ST02-001'], seed = 5 } = {}) {
  const a = new Scripted(), b = new Scripted();
  const g = new OnePieceGame({ db, seed, players: [{ name: 'A', deck: deckOf(leaders[0]), agent: a }, { name: 'B', deck: deckOf(leaders[1]), agent: b }] });
  g.throwErrors = true; lastGame = g;
  g.turn = 3; g.current = 0; g.first = 0; g.phase = 'main';
  for (const p of g.players) { p.turns = 2; p.donDeck = 10; }
  const mk = (pid, id) => { const d = db[id]; if (!d) throw new Error('no card ' + id); const c = new OCard(d, pid, g.uid++); c.inst = g.uid++; return c; };
  const T = {
    g, a, b, A: g.players[0], B: g.players[1],
    card: mk,
    char(pid, id, { rested = false, don = 0, played = 1 } = {}) {
      const c = mk(pid, id); c.zone = 'characters'; c.rested = rested; c.don = don; c.playedTurn = played;
      g.players[pid].characters.push(c); return c;
    },
    hand(pid, id) { const c = mk(pid, id); c.zone = 'hand'; g.players[pid].hand.push(c); return c; },
    life(pid, ids) { const p = g.players[pid]; p.life = ids.map(id => { const c = mk(pid, id); c.zone = 'life'; return c; }); return p.life; },
    trash(pid, id) { const c = mk(pid, id); c.zone = 'trash'; g.players[pid].trash.push(c); return c; },
    stage(pid, id) { const c = mk(pid, id); c.zone = 'stage'; c.playedTurn = 1; g.players[pid].stage = c; return c; },
    deckTop(pid, ids) { const p = g.players[pid]; const cs = ids.map(id => { const c = mk(pid, id); c.zone = 'deck'; return c; }); p.deck.unshift(...cs); return cs; },
    // DON!!: active and rested in the cost area; the rest stays in the DON!! deck
    don(pid, active, rested = 0) { const p = g.players[pid]; p.donActive = active; p.donRested = rested; p.donDeck = 10 - active - rested - g.givenDon(pid); },
    actions(pid = 0) { return g.legalActions(pid); },
    can(match, pid = 0) { return g.legalActions(pid).some(x => Object.entries(match).every(([k, v]) => x[k] === v)); },
    async act(match, pid = 0) {
      const act = g.legalActions(pid).find(x => Object.entries(match).every(([k, v]) => x[k] === v));
      if (!act) throw new Error(`no legal action ${JSON.stringify(match)}: ${JSON.stringify(g.legalActions(pid).map(x => x.label))}`);
      try { await g.doAction(pid, act); } catch (e) { if (!e.gameOver) throw e; }
    },
    play(c, pid = c.owner) { return T.act({ t: 'play', card: c.uid }, pid); },
    attack(att, tgt) { return T.act({ t: 'attack', card: att.uid, target: tgt.uid }, att.owner); },
    give(c, n = 1) { return (async () => { for (let k = 0; k < n; k++) await T.act({ t: 'don', target: c.uid }, c.owner); })(); },
    activate(c, ability = 0) { return T.act({ t: 'activate', card: c.uid, ability }, c.owner); },
    // the opponent never blocks or counters unless a test says so
    quiet(pid = 1) { const s = pid ? b : a; s.on('blocker', () => null); s.on('counter', () => null); s.on('trigger', () => false); },
    // start the next turn for real (Refresh, Draw, DON!! Phases); stops at the Main Phase question
    async nextTurn() {
      const pid = g.opp(g.current);
      const s = pid ? b : a;
      let resolveMain;
      const atMain = new Promise(r => { resolveMain = r; });
      const prev = s.h.main;
      s.on('main', () => { resolveMain(); return new Promise(() => {}); });
      await g.endPhase(g.current);
      g.takeTurn().catch(e => { if (!e.gameOver) throw e; resolveMain(); });
      await atMain;
      s.h.main = prev;
    },
  };
  return T;
}

const tests = [];
let lastGame = null;      // the newest test game, for DEBUG=1 logs
const test = (name, fn) => tests.push({ name, fn });
const expect = (c, msg) => { if (!c) throw new Error('expected: ' + msg); };
const ONLY = process.argv[2] ? new RegExp(process.argv[2], 'i') : null;

// ================================================================ setup and turn structure (5, 6)
test('Setup: 5 cards, one redraw, Life from the top of the deck with the top card at the bottom (5-2-1-6, 5-2-1-7, 2-9-2-1)', async () => {
  const a = new Scripted(), b = new Scripted();
  const d0 = decks.find(d => d.id === 'st01'), d1 = decks.find(d => d.id === 'st02');
  const g = new OnePieceGame({ db, seed: 11, players: [{ name: 'A', deck: d0, agent: a }, { name: 'B', deck: d1, agent: b }] });
  g.throwErrors = true;
  a.on('first', () => 'first'); b.on('first', () => 'first');
  a.on('mulligan', () => true); b.on('mulligan', () => false);
  let deckTop = null;
  const orig = g.draw.bind(g);
  g.draw = (pid, n, o) => { const r = orig(pid, n, o); if (pid === 1 && g.players[1].hand.length === 5) deckTop = g.players[1].deck.slice(0, 5); return r; };
  await g.setup();
  for (const p of g.players) expect(p.hand.length === 5 && p.life.length === p.leader.def.life && p.deck.length === 50 - 5 - p.life.length, `${p.name}: 5 in hand, Life = ${p.leader.def.life}, the rest in the deck`);
  expect(g.players[0].redrew === true && g.players[1].redrew === false, 'A redrew, B kept');
  expect(deckTop && g.players[1].life[g.players[1].life.length - 1] === deckTop[0] && g.players[1].life[0] === deckTop[4], 'the top card of the deck is the bottom Life card');
  const chooser = g.events.find(e => e.kind === 'coin').pid;
  expect(g.first === chooser, 'the coin-flip winner chose to go first');
  expect(g.players.every(p => p.donDeck === 10 && p.donActive === 0), '10 DON!! in each DON!! deck');
});
test('First turn: no draw for the first player, 1 DON!!; then 1 card and 2 DON!! (6-3-1, 6-4-1)', async () => {
  const a = new Scripted(), b = new Scripted();
  const d0 = decks.find(d => d.id === 'st01'), d1 = decks.find(d => d.id === 'st02');
  const g = new OnePieceGame({ db, seed: 3, players: [{ name: 'A', deck: d0, agent: a }, { name: 'B', deck: d1, agent: b }] });
  g.throwErrors = true;
  const seen = [];
  for (const s of [a, b]) { s.on('first', () => 'first'); s.on('mulligan', () => false); s.on('main', (req, gg) => { seen.push({ turn: gg.turn, pid: gg.current, hand: gg.players[gg.current].hand.length, don: gg.players[gg.current].donActive, attack: req.actions.some(x => x.t === 'attack') }); if (gg.turn >= 4) gg.over = true; return { t: 'end' }; }); }
  await g.start();
  const t1 = seen.find(x => x.turn === 1), t2 = seen.find(x => x.turn === 2), t3 = seen.find(x => x.turn === 3);
  expect(t1.hand === 5 && t1.don === 1, `turn 1: 5 cards (no draw), 1 DON!! (${t1.hand}, ${t1.don})`);
  expect(t2.hand === 6 && t2.don === 2, `turn 2: drew 1, 2 DON!! (${t2.hand}, ${t2.don})`);
  expect(t3.hand === 6 && t3.don === 3, `turn 3: drew 1, 3 DON!! (${t3.hand}, ${t3.don})`);
  expect(!t1.attack && !t2.attack, 'neither player can battle on their first turn (6-5-6-1)');
  expect(t3.attack, 'the first player can attack on their second turn');
});
test('Refresh Phase: given DON!! return to the cost area, then everything becomes active (6-2-3, 6-2-4)', async () => {
  const T = setup();
  const c = T.char(0, FILLER, { rested: true });
  T.don(0, 2, 0); await T.give(c); await T.give(T.A.leader);
  T.A.leader.rested = true;
  T.a.on('main', () => ({ t: 'end' }));
  await T.nextTurn(); await T.nextTurn();
  expect(T.g.current === 0 && c.don === 0 && T.A.leader.don === 0, 'given DON!! returned');
  expect(!c.rested && !T.A.leader.rested, 'everything active');
  expect(T.A.donActive === 4 && T.A.donRested === 0, `all 4 DON!! active (2 old + 2 new: ${T.A.donActive})`);
});
test('DON!! Phase with an almost empty DON!! deck places what is left (6-4-2, 6-4-3)', async () => {
  const T = setup();
  T.B.donDeck = 1; T.B.donActive = 9;
  await T.nextTurn();
  expect(T.B.donActive === 10 && T.B.donDeck === 0, `1 placed (${T.B.donActive})`);
  T.a.on('main', () => ({ t: 'end' }));
  await T.nextTurn(); await T.nextTurn();
  expect(T.B.donActive === 10, 'none from an empty DON!! deck');
});
test('Drawing the last card loses at once (1-2-1-1-2, 9-2-1-2)', async () => {
  const T = setup();
  T.B.deck.splice(1);
  await T.nextTurn();
  expect(T.g.over && T.g.winner === 0 && T.B.lost, `B drew its last card and lost (${T.g.result})`);
});

// ================================================================ playing cards, DON!!, attacking (6-5, 7)
test('Playing a Character rests DON!! equal to its cost; it can\'t attack the turn it is played (2-7-2, 3-7-4)', async () => {
  const T = setup();
  const c = T.hand(0, FILLER);
  T.don(0, 3);
  expect(T.can({ t: 'play', card: c.uid }), 'playable with 3 DON!!');
  await T.play(c);
  expect(T.A.donActive === 0 && T.A.donRested === 3 && T.A.characters.includes(c) && !c.rested, 'paid 3, in play, active');
  expect(!T.can({ t: 'attack', card: c.uid }), "can't attack this turn");
  const d = T.hand(0, FILLER);
  expect(!T.can({ t: 'play', card: d.uid }), 'not playable without DON!!');
});
test('A 6th Character: one already in play is trashed first, by rule, not K.O.\'d (3-7-6-1)', async () => {
  const T = setup();
  const old = [];
  for (let i = 0; i < 4; i++) old.push(T.char(0, FILLER));
  const bonney = T.char(0, 'ST02-007');
  T.don(0, 5);
  const c = T.hand(0, FILLER);
  T.a.on('trash-for-room', () => [old[0].uid]);
  await T.play(c);
  expect(T.A.characters.length === 5 && !T.A.characters.includes(old[0]) && T.A.trash.includes(old[0]) && T.A.characters.includes(c), 'trashed one, played the new one');
  expect(!T.g.events.some(e => e.kind === 'ko'), 'not a K.O.');
  void bonney;
});
test('A new Stage replaces the old one (3-8-5-1)', async () => {
  const T = setup();
  const s1 = T.stage(0, 'ST01-017');
  const s2 = T.hand(0, 'ST01-017');
  T.don(0, 2);
  await T.play(s2);
  expect(T.A.stage === s2 && T.A.trash.includes(s1), 'replaced');
});
test('Given DON!!: +1000 power each during your turn only (6-5-5-2)', async () => {
  const T = setup();
  const c = T.char(0, FILLER);
  T.don(0, 2);
  await T.give(c, 2);
  expect(T.g.power(c) === 7000 && T.A.donActive === 0 && c.don === 2, `7000 on your turn (${T.g.power(c)})`);
  T.g.current = 1;
  expect(T.g.power(c) === 5000, `5000 on the opponent's turn (${T.g.power(c)})`);
});
test("Attack targets: the opponent's Leader or rested Characters (7-1, 7-1-1-2)", async () => {
  const T = setup();
  const att = T.char(0, FILLER);
  const act = T.char(1, FILLER), rest = T.char(1, FILLER, { rested: true });
  const targets = T.actions().filter(x => x.t === 'attack' && x.card === att.uid).map(x => x.target);
  expect(targets.includes(T.B.leader.uid) && targets.includes(rest.uid) && !targets.includes(act.uid), 'Leader and the rested one');
  expect(T.actions().some(x => x.t === 'attack' && x.card === T.A.leader.uid), 'the Leader can attack too');
});
test('Battle: a tie goes to the attacker; a Character that loses is K.O.\'d; the loser of a Leader attack takes 1 damage (7-1-4)', async () => {
  const T = setup();
  T.quiet();
  const att = T.char(0, FILLER);                      // 5000
  const tgt = T.char(1, FILLER, { rested: true });    // 5000
  await T.attack(att, tgt);
  expect(T.B.trash.includes(tgt) && att.rested, 'tie: K.O.\'d, the attacker is rested');
  T.life(1, [FILLER, FILLER]);
  await T.attack(T.A.leader, T.B.leader);
  expect(T.B.life.length === 1 && T.B.hand.length === 1, 'Leader hit: 1 Life card to the hand');
});
test('An attack that loses does nothing (7-1-4-2)', async () => {
  const T = setup();
  T.quiet();
  const att = T.char(0, 'ST01-006');                  // Chopper 1000
  const tgt = T.char(1, FILLER, { rested: true });
  await T.attack(att, tgt);
  expect(T.B.characters.includes(tgt) && T.A.characters.includes(att), 'nothing K.O.\'d');
});
test('[Blocker]: rest an active Blocker to become the target, once per battle (10-1-4, 7-1-2-1)', async () => {
  const T = setup();
  const att = T.char(0, FILLER);
  const chopper = T.char(1, 'ST01-006');
  const chopper2 = T.char(1, 'ST01-006');
  T.life(1, [FILLER]);
  T.b.on('blocker', req => req.options[0]); T.b.on('counter', () => null);
  await T.attack(att, T.B.leader);
  const blocked = [chopper, chopper2].find(c => T.B.trash.includes(c));
  expect(blocked && T.B.life.length === 1, 'the blocker was K.O.\'d instead of the Leader taking damage');
  const left = [chopper, chopper2].find(c => c !== blocked);
  left.rested = true;
  const att2 = T.char(0, FILLER);
  T.b.asked = [];
  await T.attack(att2, T.B.leader);
  expect(!T.b.asked.some(r => r.type === 'blocker'), 'a rested Blocker can\'t block');
});
test('Counter Step: Counter values from the hand, for this battle only (7-1-3-1-1)', async () => {
  const T = setup();
  const att = T.char(0, FILLER);
  T.life(1, [FILLER]);
  const usopp = T.hand(1, 'ST01-002');                 // +1000 Counter
  const brook = T.hand(1, 'ST01-011');                 // +2000 Counter
  T.b.on('blocker', () => null);
  let n = 0;
  T.b.on('counter', req => (n++ === 0 ? req.options.find(o => o.card === brook.uid) : null));
  await T.attack(att, T.B.leader);
  expect(T.B.trash.includes(brook) && T.B.hand.includes(usopp), 'Brook trashed for its Counter');
  expect(T.B.life.length === 1 && T.g.power(T.B.leader) === 5000, 'the Leader (5000 + 2000) survived, and the boost is gone after the battle');
});
test('[Counter] Events: pay the cost with DON!!, then the effect (7-1-3-1-2); Guard Point', async () => {
  const T = setup();
  const att = T.char(0, FILLER);
  T.life(1, [FILLER]);
  const gp = T.hand(1, 'ST01-014');
  T.don(1, 1);
  T.b.on('blocker', () => null);
  T.b.on('counter', req => req.options.find(o => o.kind === 'event') || null);
  T.b.on('buff', req => [T.B.leader.uid]);
  await T.attack(att, T.B.leader);
  expect(T.B.trash.includes(gp) && T.B.donRested === 1 && T.B.life.length === 1, 'Guard Point: +3000, no damage');
  T.don(1, 0);
  const gp2 = T.hand(1, 'ST01-014');
  T.b.asked = [];
  await T.attack(T.char(0, FILLER), T.B.leader);
  expect(T.B.hand.includes(gp2) && T.B.life.length === 0, "without DON!! it can't be used");
});
test('[Trigger]: reveal and activate instead of adding to the hand; then it goes to the trash (10-1-5)', async () => {
  const T = setup();
  T.quiet(); T.b.on('trigger', () => true);
  const opp = T.char(0, FILLER, { rested: true });
  const [lc] = T.life(1, ['ST01-015']);                // Gum-Gum Jet Pistol: [Trigger] activate its [Main]: K.O. <=6000
  T.b.on('ko', req => [opp.uid]);
  await T.attack(T.char(0, FILLER), T.B.leader);
  expect(T.A.trash.includes(opp) && T.B.trash.includes(lc) && !T.B.hand.includes(lc), 'its [Main] K.O.\'d a Character; the card is trashed');
});
test('[Trigger] "Play this card" puts it on the field (ST01-002 Usopp)', async () => {
  const T = setup();
  T.quiet(); T.b.on('trigger', () => true);
  const [lc] = T.life(1, ['ST01-002']);
  await T.attack(T.char(0, FILLER), T.B.leader);
  expect(T.B.characters.includes(lc), 'played');
});
test('Declining a [Trigger] adds the card to the hand (10-1-5-2)', async () => {
  const T = setup();
  T.quiet();
  const [lc] = T.life(1, ['ST01-002']);
  await T.attack(T.char(0, FILLER), T.B.leader);
  expect(T.B.hand.includes(lc), 'in hand');
});
test('Damage with 0 Life cards wins the game (7-1-4-1-1-1)', async () => {
  const T = setup();
  T.quiet();
  T.life(1, []);
  await T.attack(T.A.leader, T.B.leader);
  expect(T.g.over && T.g.winner === 0 && T.B.lost, `A wins (${T.g.result})`);
});
test('[Double Attack] deals 2 damage; against 1 Life card it takes that card and the game goes on (10-1-2, 7-1-4-1-1-3)', async () => {
  const T = setup();
  T.quiet();
  const att = T.char(0, FILLER);
  T.g.addEffect({ kind: 'grant', card: att, kw: 'Double Attack' }, 'turn', 0);
  T.life(1, [FILLER, FILLER, FILLER]);
  await T.attack(att, T.B.leader);
  expect(T.B.life.length === 1 && T.B.hand.length === 2, '2 Life cards taken');
  const att2 = T.char(0, FILLER);
  T.g.addEffect({ kind: 'grant', card: att2, kw: 'Double Attack' }, 'turn', 0);
  await T.attack(att2, T.B.leader);
  expect(!T.g.over && T.B.life.length === 0, 'the last Life card taken, no defeat');
});
test('[Banish]: the Life card is trashed and its [Trigger] doesn\'t activate (10-1-3)', async () => {
  const T = setup();
  T.quiet(); T.b.on('trigger', () => true);
  const att = T.char(0, FILLER);
  T.g.addEffect({ kind: 'grant', card: att, kw: 'Banish' }, 'turn', 0);
  const [lc] = T.life(1, ['ST01-002']);
  T.b.asked = [];
  await T.attack(att, T.B.leader);
  expect(T.B.trash.includes(lc) && !T.b.asked.some(r => r.type === 'trigger'), 'trashed, no Trigger');
});
test('[Rush] lets a Character attack the turn it is played (10-1-1); [DON!! x2] Sanji gains it', async () => {
  const T = setup();
  T.don(0, 7);
  const luffy = T.hand(0, 'ST01-012');
  await T.play(luffy);
  expect(T.can({ t: 'attack', card: luffy.uid }), 'Luffy (Rush) can attack');
  T.don(0, 4);
  const sanji = T.hand(0, 'ST01-004');
  await T.play(sanji);
  expect(!T.can({ t: 'attack', card: sanji.uid }), "Sanji can't yet");
  await T.give(sanji, 2);
  expect(T.can({ t: 'attack', card: sanji.uid }), 'with 2 DON!! he can');
});
test('Power boosts "during this turn" end with the turn; "during this battle" with the battle (6-6-1-3, 7-1-5-3)', async () => {
  const T = setup();
  const c = T.char(0, FILLER);
  T.g.addEffect({ kind: 'power', card: c, n: 2000 }, 'turn', 0);
  expect(T.g.power(c) === 7000, '+2000');
  await T.g.endPhase(0);
  expect(T.g.power(c) === 5000, 'gone at the end of the turn');
});
test('Effects on a card end when it changes areas (3-1-6)', async () => {
  const T = setup();
  const c = T.char(0, FILLER);
  T.g.addEffect({ kind: 'power', card: c, n: 2000 }, 'turn', 0);
  T.g.moveCard(c, 'hand');
  T.g.moveCard(c, 'characters');
  expect(T.g.power(c) === 5000, 'a new card');
});
test('Cards leaving the field drop their given DON!! into the cost area, rested (6-5-5-4)', async () => {
  const T = setup();
  T.quiet();
  const c = T.char(1, FILLER, { rested: true });
  c.don = 2; T.B.donDeck = 8;
  await T.attack(T.char(0, 'ST01-010'), c);              // Franky 6000
  expect(T.B.trash.includes(c) && T.B.donRested === 2, 'K.O.\'d, 2 DON!! rested in the cost area');
});
test('Determinism: the same seed and the same choices give the same game', async () => {
  const run = async () => {
    const d0 = decks.find(d => d.id === 'st01'), d1 = decks.find(d => d.id === 'st02');
    const g = new OnePieceGame({ db, seed: 77, players: [{ name: 'A', deck: d0, agent: new OnePieceAI() }, { name: 'B', deck: d1, agent: new OnePieceAI() }] });
    await g.start();
    return g.logs.map(l => l.text).join('\n');
  };
  const x = await run(), y = await run();
  expect(x === y && x.length > 1000, 'identical logs');
});
test('Main Phase actions survive the network encoding (lockstep packValue)', async () => {
  const T = setup();
  T.don(0, 2);
  T.char(0, FILLER);
  const acts = T.actions();
  for (const a of acts) {
    const back = unpackValue(packValue(a, 'main'), 'main');
    expect(T.g.matchAction(acts, back) === a, `${a.label} round-trips`);
  }
});

// ================================================================ ST-01 Straw Hat Crew
test('ST01-001 Luffy (Leader): [Activate: Main] [Once Per Turn] give up to 1 rested DON!! to this Leader or 1 Character', async () => {
  const T = setup();
  const c = T.char(0, FILLER);
  T.don(0, 0, 2);
  T.a.on('give-don', () => [c.uid]);
  await T.activate(T.A.leader);
  expect(c.don === 1 && T.A.donRested === 1, 'given');
  expect(!T.can({ t: 'activate', card: T.A.leader.uid }), 'once per turn');
});
test('ST01-002 Usopp: [DON!! x2] [When Attacking] the opponent can\'t activate [Blocker] Characters with 5000 or more power', async () => {
  const T = setup();
  const u = T.char(0, 'ST01-002');
  T.don(0, 2); await T.give(u, 2);
  const big = T.char(1, 'ST02-013'); big.rested = false;      // Kid 7000 Blocker
  const small = T.char(1, 'ST01-006');                         // Chopper 1000 Blocker
  T.life(1, [FILLER]);
  let opts = null;
  T.b.on('blocker', req => { opts = req.options; return null; }); T.b.on('counter', () => null);
  await T.attack(u, T.B.leader);
  expect(opts && opts.includes(small.uid) && !opts.includes(big.uid), 'only Chopper may block');
});
test('ST01-005 Jinbe: [DON!! x1] [When Attacking] +1000 to another Leader or Character this turn', async () => {
  const T = setup();
  T.quiet();
  const j = T.char(0, 'ST01-005');
  T.don(0, 1); await T.give(j);
  T.a.on('buff', req => { expect(!req.options.includes(j.uid), 'not Jinbe itself'); return [T.A.leader.uid]; });
  T.life(1, [FILLER]);
  await T.attack(j, T.B.leader);
  expect(T.g.power(T.A.leader) === 6000, `Leader 6000 (${T.g.power(T.A.leader)})`);
  const j2 = T.char(0, 'ST01-005');
  T.a.asked = [];
  await T.attack(j2, T.B.leader);
  expect(!T.a.asked.some(r => r.hint === 'buff'), 'without a DON!! nothing happens');
});
test('ST01-007 Nami: [Activate: Main] [Once Per Turn] give up to 1 rested DON!! to your Leader or a Character', async () => {
  const T = setup();
  const n = T.char(0, 'ST01-007');
  T.don(0, 0, 1);
  T.a.on('give-don', () => [T.A.leader.uid]);
  await T.activate(n);
  expect(T.A.leader.don === 1, 'given');
});
test('ST01-011 Brook: [On Play] give up to 2 rested DON!! to your Leader or 1 Character', async () => {
  const T = setup();
  T.don(0, 2, 1);
  const b = T.hand(0, 'ST01-011');
  T.a.on('give-don', () => [T.A.leader.uid]);
  T.a.on('don-n', req => req.max);
  await T.play(b);
  expect(T.A.leader.don === 2, `2 given (${T.A.leader.don})`);
});
test('ST01-012 Luffy: [DON!! x2] [When Attacking] the opponent can\'t activate [Blocker] this battle', async () => {
  const T = setup();
  const l = T.char(0, 'ST01-012');
  T.don(0, 2); await T.give(l, 2);
  T.char(1, 'ST01-006');
  T.life(1, [FILLER]);
  T.b.asked = [];
  T.b.on('counter', () => null);
  await T.attack(l, T.B.leader);
  expect(!T.b.asked.some(r => r.type === 'blocker') && T.B.life.length === 0, 'no block');
});
test('ST01-013 Zoro: [DON!! x1] +1000 power', async () => {
  const T = setup();
  const z = T.char(0, 'ST01-013');
  T.don(0, 1);
  expect(T.g.power(z) === 5000, '5000');
  await T.give(z);
  expect(T.g.power(z) === 7000, `5000 + 1000 (DON!!) + 1000 (effect) (${T.g.power(z)})`);
});
test('ST01-014 Guard Point: [Trigger] +1000 to your Leader or a Character during this turn', async () => {
  const T = setup();
  T.quiet(); T.b.on('trigger', () => true); T.b.on('buff', () => [T.B.leader.uid]);
  T.life(1, ['ST01-014']);
  await T.attack(T.char(0, FILLER), T.B.leader);
  expect(T.g.power(T.B.leader) === 6000, `+1000 (${T.g.power(T.B.leader)})`);
});
test('ST01-015 Gum-Gum Jet Pistol: [Main] K.O. up to 1 Character with 6000 power or less', async () => {
  const T = setup();
  const big = T.char(1, 'ST01-012');                    // 6000
  const bigger = T.char(1, 'ST02-013');                 // 7000
  T.don(0, 4);
  const e = T.hand(0, 'ST01-015');
  let opts;
  T.a.on('ko', req => { opts = req.options; return [big.uid]; });
  await T.play(e);
  expect(T.B.trash.includes(big) && opts && !opts.includes(bigger.uid) && T.A.trash.includes(e), 'K.O.\'d the 6000 one; the Event is trashed');
});
test('ST01-016 Diable Jambe: [Main] a {Straw Hat Crew} Leader or Character can\'t be blocked if it attacks this turn; [Trigger] K.O. a cost 3 or less [Blocker]', async () => {
  const T = setup();
  T.don(0, 1);
  const e = T.hand(0, 'ST01-016');
  T.a.on('select', () => [T.A.leader.uid]);
  await T.play(e);
  T.char(1, 'ST01-006');
  T.life(1, [FILLER]);
  T.b.asked = []; T.b.on('counter', () => null);
  await T.attack(T.A.leader, T.B.leader);
  expect(!T.b.asked.some(r => r.type === 'blocker') && T.B.life.length === 0, 'no block');
  const T2 = setup();
  T2.quiet(); T2.b.on('trigger', () => true);
  const bl = T2.char(0, 'ST01-006');
  const nb = T2.char(0, FILLER);
  let opts;
  T2.b.on('ko', req => { opts = req.options; return req.options; });
  T2.life(1, ['ST01-016']);
  await T2.attack(T2.A.leader, T2.B.leader);
  expect(T2.A.trash.includes(bl) && opts && !opts.includes(nb.uid), 'the Blocker K.O.\'d');
});
test('ST01-017 Thousand Sunny: [Activate: Main] rest this Stage: +1000 to a {Straw Hat Crew} Leader or Character this turn', async () => {
  const T = setup();
  const s = T.stage(0, 'ST01-017');
  T.a.on('buff', () => [T.A.leader.uid]);
  await T.activate(s);
  expect(s.rested && T.g.power(T.A.leader) === 6000, 'rested, +1000');
  expect(!T.can({ t: 'activate', card: s.uid }), 'only while active');
});

// ================================================================ ST-02 Worst Generation
test('ST02-001 Kid (Leader): [Activate: Main] [Once Per Turn] ③ and trash 1 card: set this Leader as active', async () => {
  const T = setup({ leaders: ['ST02-001', 'ST01-001'] });
  T.quiet();
  T.life(1, [FILLER, FILLER]);
  T.don(0, 3);
  const h = T.hand(0, FILLER);
  await T.attack(T.A.leader, T.B.leader);
  await T.activate(T.A.leader);
  expect(!T.A.leader.rested && T.A.trash.includes(h) && T.A.donRested === 3, 'active again: 3 DON!! rested, a card trashed');
  expect(T.can({ t: 'attack', card: T.A.leader.uid }) && !T.can({ t: 'activate', card: T.A.leader.uid }), 'can attack again; once per turn');
});
test('ST02-003 Urouge: [DON!! x1] with 3 or more Characters, +2000 power', async () => {
  const T = setup();
  const u = T.char(0, 'ST02-003');
  T.char(0, FILLER); T.char(0, FILLER);
  T.don(0, 1);
  expect(T.g.power(u) === 3000, '3000 without DON!!');
  await T.give(u);
  expect(T.g.power(u) === 6000, `3000 + 1000 + 2000 (${T.g.power(u)})`);
  T.A.characters.pop();
  T.g.touch();
  expect(T.g.power(u) === 4000, `only 2 Characters: 4000 (${T.g.power(u)})`);
});
test('ST02-005 Killer: [On Play] K.O. up to 1 rested Character with a cost of 3 or less', async () => {
  const T = setup();
  const r = T.char(1, FILLER, { rested: true });          // cost 3
  const a = T.char(1, FILLER);                             // active
  const big = T.char(1, 'ST02-013', { rested: true });    // cost 7
  T.don(0, 3);
  let opts;
  T.a.on('ko', req => { opts = req.options; return [r.uid]; });
  await T.play(T.hand(0, 'ST02-005'));
  expect(T.B.trash.includes(r) && opts.length === 1, 'only the rested cost-3 one');
  void a; void big;
});
test('ST02-007 Bonney: [Activate: Main] ① and rest it: look at 5, reveal a {Supernovas} card, the rest to the bottom', async () => {
  const T = setup();
  const b = T.char(0, 'ST02-007');
  T.don(0, 1);
  const top = T.deckTop(0, ['ST02-009', FILLER, FILLER, FILLER, FILLER]);
  T.a.on('take', req => { expect(req.options.length === 1 && req.options[0] === top[0].uid, 'only Law qualifies'); return req.options; });
  await T.activate(b);
  expect(T.A.hand.includes(top[0]) && b.rested && T.A.donRested === 1, 'Law to hand, Bonney rested, 1 DON!! rested');
  expect(T.A.deck.slice(-4).every(c => top.includes(c)), 'the other 4 at the bottom');
});
test('ST02-008 Apoo: [DON!! x1] [When Attacking] rest up to 1 of the opponent\'s DON!!', async () => {
  const T = setup();
  T.quiet();
  const a = T.char(0, 'ST02-008');
  T.don(0, 1); await T.give(a);
  T.don(1, 2);
  T.life(1, [FILLER]);
  await T.attack(a, T.B.leader);
  expect(T.B.donActive === 1 && T.B.donRested === 1, 'one rested');
});
test('ST02-009 Law: [On Play] set up to 1 rested {Supernovas} or {Heart Pirates} Character with a cost of 5 or less as active', async () => {
  const T = setup();
  const k = T.char(0, 'ST02-005', { rested: true });     // Killer, Supernovas, cost 3
  const n = T.char(0, FILLER, { rested: true });          // Robin, Straw Hat Crew
  T.don(0, 5);
  let opts;
  T.a.on('set-active', req => { opts = req.options; return [k.uid]; });
  await T.play(T.hand(0, 'ST02-009'));
  expect(!k.rested && n.rested && opts.length === 1, 'Killer set as active');
});
test('ST02-010 Hawkins: [DON!! x1] [Your Turn] [Once Per Turn] after battling an opponent\'s Character, set it as active', async () => {
  const T = setup();
  T.quiet();
  const h = T.char(0, 'ST02-010');
  T.don(0, 1); await T.give(h);
  const t = T.char(1, FILLER, { rested: true });
  await T.attack(h, t);
  expect(T.B.trash.includes(t) && !h.rested, 'K.O.\'d it and is active again');
  const t2 = T.char(1, FILLER, { rested: true });
  await T.attack(h, t2);
  expect(h.rested, 'once per turn');
  const T2 = setup();
  T2.quiet();
  const h2 = T2.char(0, 'ST02-010');
  T2.don(0, 1); await T2.give(h2);
  T2.life(1, [FILLER]);
  await T2.attack(h2, T2.B.leader);
  expect(h2.rested, 'not after attacking a Leader');
});
test('ST02-013 Kid: [Blocker]; [DON!! x1] [End of Your Turn] set this card as active', async () => {
  const T = setup();
  T.quiet();
  const k = T.char(0, 'ST02-013');
  T.don(0, 1); await T.give(k);
  T.life(1, [FILLER]);
  await T.attack(k, T.B.leader);
  expect(k.rested, 'rested by attacking');
  await T.g.endPhase(0);
  expect(!k.rested, 'active at the end of the turn');
});
test('ST02-014 X.Drake: [DON!! x1] [Your Turn] while rested, your {Supernovas} and {Navy} Leaders and Characters get +1000', async () => {
  const T = setup({ leaders: ['ST02-001', 'ST01-001'] });
  const d = T.char(0, 'ST02-014');
  const k = T.char(0, 'ST02-005');
  T.don(0, 1); await T.give(d);
  expect(T.g.power(k) === 3000, 'not while Drake is active');
  d.rested = true; T.g.touch();
  expect(T.g.power(k) === 4000 && T.g.power(T.A.leader) === 6000 && T.g.power(d) === 7000, `+1000 to Killer, the Leader and Drake (${T.g.power(k)}, ${T.g.power(T.A.leader)}, ${T.g.power(d)})`);
  T.g.current = 1; T.g.touch();
  expect(T.g.power(k) === 3000, "not on the opponent's turn");
});
test('ST02-015 Scalpel: [Counter] +2000 this battle, then set up to 1 DON!! as active; [Trigger] set up to 2 DON!! as active', async () => {
  const T = setup();
  T.life(1, [FILLER]);
  T.hand(1, 'ST02-015');
  T.don(1, 1, 1);
  T.b.on('blocker', () => null);
  let n = 0;
  T.b.on('counter', req => (n++ ? null : req.options.find(o => o.kind === 'event')));
  T.b.on('buff', () => [T.B.leader.uid]);
  await T.attack(T.char(0, FILLER), T.B.leader);
  expect(T.B.life.length === 1 && T.B.donActive === 1 && T.B.donRested === 1, 'blocked the hit; paid 1 then set 1 active again');
  const T2 = setup();
  T2.quiet(); T2.b.on('trigger', () => true);
  T2.life(1, ['ST02-015']);
  T2.don(1, 0, 3);
  await T2.attack(T2.char(0, FILLER), T2.B.leader);
  expect(T2.B.donActive === 2 && T2.B.donRested === 1, '2 set as active');
});
test('ST02-017 Straw Sword: [Main] rest up to 1 of the opponent\'s Characters', async () => {
  const T = setup();
  const c = T.char(1, FILLER);
  T.don(0, 2);
  await T.play(T.hand(0, 'ST02-017'));
  expect(c.rested, 'rested');
});

// ================================================================ ST-03 to ST-10
test('DON!! −X costs are optional ("You may return ...", 8-3-1-4): ST04-003 Kaido [On Play] DON!! −5 declined does nothing', async () => {
  const T = setup();
  const t = T.char(1, FILLER);
  T.don(0, 9, 1);
  T.a.on('pay-cost', () => false);
  const k = T.hand(0, 'ST04-003');
  await T.play(k);
  expect(T.B.characters.includes(t) && !T.g.has(k, 'Rush') && T.A.donDeck === 0, 'no K.O., no [Rush], no DON!! returned');
  const T2 = setup();
  const t2 = T2.char(1, FILLER);
  T2.don(0, 10);
  T2.a.on('pay-cost', () => true);
  const k2 = T2.hand(0, 'ST04-003');
  await T2.play(k2);
  expect(T2.B.trash.includes(t2) && T2.g.has(k2, 'Rush') && T2.A.donDeck === 5 && T2.A.donRested + T2.A.donActive === 5, 'paid: 5 DON!! back to the DON!! deck, K.O. and [Rush]');
});
test('AI: doesn\'t pay DON!! −1 for ST04-004 King\'s K.O. when there is nothing to K.O.', async () => {
  const T = setup();
  T.don(0, 7);
  await T.play(T.hand(0, 'ST04-004'));
  expect(T.A.donDeck === 3, `no DON!! returned (${T.A.donDeck} in the DON!! deck)`);
});
test('ST03-001 Crocodile (Leader): DON!! −4 counts given DON!! too (8-3-1-6); return a cost 5 or less Character to the hand', async () => {
  const T = setup({ leaders: ['ST03-001', 'ST01-001'] });
  const mine = T.char(0, FILLER);
  T.don(0, 4); await T.give(mine); await T.give(mine);
  const t = T.char(1, 'ST03-003');                       // cost 5
  const asked = [];
  T.a.on('don-return', req => { asked.push(req.options.map(o => o.value)); return req.options.find(o => o.value === mine.uid) ? mine.uid : req.options[0].value; });
  T.a.on('bounce', () => [t.uid]);
  await T.activate(T.A.leader);
  expect(T.B.hand.includes(t) && T.A.donDeck === 10 && mine.don === 0 && T.A.donActive === 0, `bounced; all 4 DON!! back in the DON!! deck (${T.A.donDeck}, given ${mine.don})`);
  expect(asked.length === 2 && asked[0].includes(mine.uid), 'asked per DON!! card while there is a choice, given ones offered');
});
test('ST03-007 Sentomaru: [DON!! x1] ②: play a [Pacifista] with a cost of 4 or less from the deck, then shuffle', async () => {
  const T = setup();
  const s = T.char(0, 'ST03-007');
  T.don(0, 3);
  expect(!T.can({ t: 'activate', card: s.uid }), 'needs [DON!! x1]');
  await T.give(s);
  const [p] = T.deckTop(0, ['ST03-012']);
  let req0;
  T.a.on('play', req => { req0 = req; return [p.uid]; });
  await T.activate(s);
  expect(T.A.characters.includes(p) && req0.options.length === 1 && req0.shown.length === T.A.deck.length + 1, 'Pacifista played from the deck (the whole deck shown)');
  expect(T.g.events.some(e => e.kind === 'shuffle' && e.pid === 0), 'deck shuffled');
});
test('ST03-010 Kuma: [On Play] look at 3, put them back at the top or bottom in any order', async () => {
  const T = setup();
  T.don(0, 2);
  const top = T.deckTop(0, ['ST03-012', 'ST03-002', 'ST03-006']);
  T.a.on('keep-top', () => [top[2].uid, top[0].uid]);
  T.a.on('order-top', () => [top[2].uid, top[0].uid]);
  await T.play(T.hand(0, 'ST03-010'));
  expect(T.A.deck[0] === top[2] && T.A.deck[1] === top[0] && T.A.deck[T.A.deck.length - 1] === top[1], 'Jinbe, Pacifista on top; Weevil at the bottom');
});
test('ST04-001 Kaido (Leader): DON!! −7: trash the top card of the opponent\'s Life', async () => {
  const T = setup({ leaders: ['ST04-001', 'ST01-001'] });
  T.don(0, 7);
  const l = [...T.life(1, [FILLER, 'ST01-012'])];
  await T.activate(T.A.leader);
  expect(T.B.trash.includes(l[0]) && T.B.life.length === 1 && T.A.donDeck === 10, 'top Life card trashed');
});
test('ST05-010 Zephyr: when it battles a <Strike> Character, +3000 this turn; not against others (decided: when the battle\'s two cards are settled, after the Block Step)', async () => {
  const T = setup();
  T.quiet();
  const z = T.char(0, 'ST05-010');
  const strike = T.char(1, 'ST03-006', { rested: true });     // Jinbe <Strike>
  const slash = T.char(1, 'ST03-002', { rested: true });      // Weevil <Slash>
  await T.attack(z, slash);
  expect(T.g.power(z) === 8000, `no boost vs <Slash> (${T.g.power(z)})`);
  z.rested = false;
  await T.attack(z, strike);
  expect(T.g.power(z) === 11000 && T.B.trash.includes(strike), `+3000 vs <Strike> (${T.g.power(z)})`);
  // attacked by a <Strike> Character on the opponent's turn: 8000 + 3000 beats 10000
  const T2 = setup();
  T2.quiet(0);
  const z2 = T2.char(0, 'ST05-010', { rested: true });
  const big = T2.char(1, 'ST04-003');                           // Kaido 10000 <Strike>
  T2.g.current = 1; T2.B.turns = 3;
  await T2.attack(big, z2);
  expect(T2.A.characters.includes(z2) && T2.g.power(z2) === 11000, `Zephyr survives at 11000 (${T2.g.power(z2)})`);
});
test('ST05-017 Union Armada: +4000; if the chosen card is a Character it can\'t be K.O.\'d this turn', async () => {
  for (const pickLeader of [false, true]) {
    const T = setup({ leaders: ['ST01-001', 'ST05-001'] });
    const bins = T.char(1, 'ST05-013', { rested: true });    // FILM, 6000
    T.hand(1, 'ST05-017'); T.don(1, 2);
    T.b.on('blocker', () => null);
    let n = 0;
    T.b.on('counter', req => (n++ ? null : req.options.find(o => o.kind === 'event')));
    T.b.on('buff', () => [pickLeader ? T.B.leader.uid : bins.uid]);
    const att = T.char(0, FILLER); T.don(0, 3); await T.give(att, 3);   // 8000
    await T.attack(att, bins);
    if (pickLeader) expect(T.B.trash.includes(bins), 'Leader chosen: Bins is K.O.\'d');
    else expect(T.B.characters.includes(bins) && !T.g.canBeKOd(bins, { by: 'effect', pid: 0 }), 'Bins survives at 10000 and can\'t be K.O.\'d this turn');
  }
});
test('ST05-008 Shiki: with 8 or more DON!! on your field, can\'t be K.O.\'d in battle', async () => {
  const T = setup();
  T.quiet(0);
  const s = T.char(1, 'ST05-008', { rested: true });
  T.don(1, 8);
  const att = T.char(0, FILLER); T.don(0, 2); await T.give(att, 2);
  T.B.donActive = 8; T.B.donDeck = 2;
  await T.attack(att, s);
  expect(T.B.characters.includes(s), 'not K.O.\'d with 8 DON!!');
  T.B.donActive = 7; T.B.donDeck = 3; T.g.touch();
  const att2 = T.char(0, 'ST04-003');
  await T.attack(att2, s);
  expect(T.B.trash.includes(s), 'K.O.\'d with 7');
});
test('ST06-004 Smoker: can\'t be K.O.\'d by effects; [DON!! x1] [Double Attack] while there is a Character with a cost of 0', async () => {
  const T = setup();
  const s = T.char(0, 'ST06-004');
  T.don(0, 1); await T.give(s);
  expect(!T.g.has(s, 'Double Attack'), 'no cost-0 Character yet');
  const c = T.char(1, FILLER);
  T.g.addEffect({ kind: 'cost', card: c, n: -3 }, 'turn', 0);
  expect(T.g.has(s, 'Double Attack'), 'Double Attack with a cost-0 Character on the field');
  expect(!(await T.g.ko(s, { by: 'effect', pid: 1 })) && T.A.characters.includes(s), 'an effect can\'t K.O. it');
});
test('ST06-016 White Out: [Trigger] none of your Characters can be K.O.\'d during this turn', async () => {
  const T = setup();
  T.quiet(); T.b.on('trigger', () => true);
  T.life(1, ['ST06-016', FILLER]);
  const r = T.char(1, FILLER, { rested: true });
  await T.attack(T.A.leader, T.B.leader);
  const big = T.char(0, 'ST04-003');
  await T.attack(big, r);
  expect(T.B.characters.includes(r), 'not K.O.\'d in battle this turn');
});
test('ST07-001 Linlin (Leader): [DON!! x2] [When Attacking] Life card to hand (top or bottom), then with 2 or less Life add a card from the hand to the top of Life', async () => {
  const T = setup({ leaders: ['ST07-001', 'ST01-001'] });
  T.quiet();
  T.life(1, [FILLER]);
  const l = [...T.life(0, [FILLER, FILLER, 'ST01-012'])];
  const h = T.hand(0, 'ST07-002');
  T.don(0, 2); await T.give(T.A.leader, 2);
  T.a.on('pay-cost', () => true); T.a.on('life-end', () => 'bottom'); T.a.on('to-life', () => [h.uid]);
  await T.attack(T.A.leader, T.B.leader);
  expect(T.A.hand.includes(l[2]) && T.A.life[0] === h && T.A.life.length === 3, 'bottom Life card to hand, Anana to the top of Life');
});
test('ST07-003 Katakuri: [On Play] look at the top Life card of either player, then [Rush] if you have less Life', async () => {
  const T = setup();
  T.life(0, [FILLER, FILLER]);
  const bl = [...T.life(1, ['ST01-012', FILLER, FILLER])];
  T.don(0, 4);
  T.a.on('life-whose', () => 1); T.a.on('life-end', () => 'bottom');
  const k = T.hand(0, 'ST07-003');
  await T.play(k);
  expect(T.B.life[2] === bl[0] && T.g.has(k, 'Rush') && T.can({ t: 'attack', card: k.uid }), 'B\'s top Life card moved to the bottom; [Rush]');
});
test('ST07-010 Linlin: [On Play] the opponent chooses: trash the top of their Life, or you add a card to your Life', async () => {
  for (const pick of [0, 1]) {
    const T = setup();
    T.life(0, [FILLER]); T.life(1, [FILLER, FILLER]);
    T.don(0, 7);
    T.b.on('choose-one', req => req.options[pick].value);
    await T.play(T.hand(0, 'ST07-010'));
    expect(pick === 0 ? T.B.life.length === 1 && T.A.life.length === 1 : T.B.life.length === 2 && T.A.life.length === 2, `option ${pick}`);
  }
});
test('ST07-017 Queen Mama Chanter: rest it and take a Life card: a cost-3 Character goes to the top of your Life face-up', async () => {
  const T = setup();
  const s = T.stage(0, 'ST07-017');
  const c = T.char(0, FILLER);
  T.life(0, ['ST01-012']);
  await T.activate(s);
  expect(T.A.life[0] === c && c.faceUp && s.rested && T.A.hand.length === 1, 'Robin is the top Life card, face-up');
});
test('ST08-001 Luffy (Leader): [Your Turn] when a Character is K.O.\'d, give up to 1 rested DON!! to this Leader', async () => {
  const T = setup({ leaders: ['ST08-001', 'ST01-001'] });
  T.quiet();
  T.don(0, 0, 2);
  await T.attack(T.char(0, 'ST04-003'), T.char(1, FILLER, { rested: true }));
  expect(T.A.leader.don === 1 && T.A.donRested === 1, `1 rested DON!! given (${T.A.leader.don})`);
  T.g.current = 1;
  await T.g.ko(T.char(1, FILLER), { by: 'effect', pid: 1 }); await T.g.resolvePending();
  expect(T.A.leader.don === 1, 'not on the opponent\'s turn');
});
test('ST08-002 Uta: can\'t be K.O.\'d in battle by Leaders', async () => {
  const T = setup();
  T.quiet();
  const u = T.char(1, 'ST08-002', { rested: true });
  await T.attack(T.A.leader, u);
  expect(T.B.characters.includes(u), 'the Leader doesn\'t K.O. it');
  await T.attack(T.char(0, FILLER), u);
  expect(T.B.trash.includes(u), 'a Character does');
});
test('ST08-013 Mr.2: [DON!! x1] at the end of a battle with a Character, may K.O. it; if you do, K.O. Mr.2', async () => {
  const T = setup();
  T.quiet();
  const m = T.char(0, 'ST08-013');
  T.don(0, 1); await T.give(m);
  const big = T.char(1, 'ST05-011', { rested: true });     // 10000
  T.a.on('may', () => true);
  await T.attack(m, big);
  expect(T.B.trash.includes(big) && T.A.trash.includes(m), 'lost the battle, then K.O.\'d both');
  const T2 = setup();
  T2.quiet();
  const m2 = T2.char(0, 'ST08-013');
  T2.don(0, 1); await T2.give(m2);
  const small = T2.char(1, FILLER, { rested: true });
  T2.a.on('may', () => true);
  await T2.attack(m2, small);
  expect(T2.B.trash.includes(small) && T2.A.characters.includes(m2), 'won: nothing left to K.O., so Mr.2 stays');
});
test('ST09-001 Yamato (Leader): [DON!! x1] [Opponent\'s Turn] +1000 with 2 or less Life (no DON!! bonus on the opponent\'s turn)', async () => {
  const T = setup({ leaders: ['ST01-001', 'ST09-001'] });
  T.B.leader.don = 1; T.B.donDeck = 9;
  T.life(1, [FILLER, FILLER]);
  expect(T.g.power(T.B.leader) === 6000, `6000 (${T.g.power(T.B.leader)})`);
  T.life(1, [FILLER, FILLER, FILLER]); T.g.touch();
  expect(T.g.power(T.B.leader) === 5000, `5000 with 3 Life (${T.g.power(T.B.leader)})`);
});
test('ST09-010 Ace: [Once Per Turn] if it would be K.O.\'d, trash a top or bottom Life card instead', async () => {
  const T = setup();
  const ace = T.char(1, 'ST09-010');
  const l = [...T.life(1, [FILLER, 'ST01-012'])];
  T.b.on('replace', () => true); T.b.on('life-end', () => 'bottom');
  await T.g.ko(ace, { by: 'effect', pid: 0 });
  expect(T.B.characters.includes(ace) && T.B.trash.includes(l[1]), 'stays; the bottom Life card is trashed');
  await T.g.ko(ace, { by: 'effect', pid: 0 });
  expect(T.B.trash.includes(ace), 'K.O.\'d the second time this turn');
});
test('ST09-015 Thunder Bagua: [Counter] +4000; with 2 or less Life, the attacker (cost 3) goes to its owner\'s Life face-up and the battle ends', async () => {
  const T = setup();
  T.life(1, [FILLER, FILLER]);
  T.hand(1, 'ST09-015'); T.don(1, 2);
  T.b.on('blocker', () => null);
  let n = 0;
  T.b.on('counter', req => (n++ ? null : req.options.find(o => o.kind === 'event')));
  T.b.on('buff', () => [T.B.leader.uid]);
  const att = T.char(0, FILLER);
  T.a.on('life-end', () => 'top');
  T.b.on('to-life', () => [att.uid]);
  T.b.on('life-end', () => 'top');
  await T.attack(att, T.B.leader);
  expect(T.A.life[0] === att && att.faceUp && T.B.life.length === 2 && !T.g.fight, 'the attacker is A\'s top Life card; no damage');
});
test('ST10-002 Luffy (Leader): [Activate: Main] with 0 or 8+ DON!! on the field, add 1 active DON!!', async () => {
  const T = setup({ leaders: ['ST10-002', 'ST01-001'] });
  T.don(0, 0);
  await T.activate(T.A.leader);
  expect(T.A.donActive === 1, 'added with 0');
  const T2 = setup({ leaders: ['ST10-002', 'ST01-001'] });
  T2.don(0, 5);
  await T2.activate(T2.A.leader);
  expect(T2.A.donActive === 5, 'nothing with 5');
});
test('ST10-006 Luffy: [Once Per Turn] when the opponent activates a [Blocker], K.O. a Character with 8000 power or less (the blocker: the battle ends)', async () => {
  const T = setup();
  T.life(1, [FILLER]);
  const bl = T.char(1, 'ST06-007');
  T.b.on('blocker', req => req.options[0]); T.b.on('counter', () => null);
  T.a.on('ko', () => [bl.uid]);
  const l = T.char(0, 'ST10-006');
  await T.attack(l, T.B.leader);
  expect(T.B.trash.includes(bl) && T.B.life.length === 1, 'blocker K.O.\'d, no damage');
});
test('ST10-007 Killer, ST10-011 Heat, ST10-014 Wire: when a DON!! card is returned to the DON!! deck', async () => {
  const T = setup();
  const k = T.char(0, 'ST10-007'), h = T.char(0, 'ST10-011'), w = T.char(0, 'ST10-014');
  const z = T.char(0, 'ST05-010');
  const r = T.char(1, FILLER, { rested: true });
  T.don(0, 2);
  const card = T.hand(0, 'ST01-012');
  T.a.on('ko', () => [r.uid]); T.a.on('discard', () => [card.uid]);
  const order = [];
  T.a.on('order-effects', req => { order.push(req.options.length); return req.options[0].value; });
  await T.activate(z, 1);
  expect(T.B.trash.includes(r), 'Killer K.O.\'d the rested cost-3 Character');
  expect(T.g.power(h) === 6000, `Heat +2000 (${T.g.power(h)})`);
  expect(T.A.trash.includes(card), 'Wire drew and trashed');
  expect(order[0] === 3, 'the player ordered the three effects');
  void k; void w;
});
test('ST10-010 Law: [On Play] DON!! −1: with 7+ cards in the opponent\'s hand, the player trashes 2 of them, face-down (8-4-4-3, 3-4-3)', async () => {
  const T = setup();
  for (let i = 0; i < 7; i++) T.hand(1, FILLER);
  T.don(0, 5);
  let req0;
  T.a.on('discard-opp', req => { req0 = req; return req.options.slice(-2); });
  await T.play(T.hand(0, 'ST10-010'));
  expect(T.B.hand.length === 5 && T.B.trash.length === 2 && req0.from === 'opp-hand' && req0.min === 2, 'A picked 2 from B\'s hand');
  expect(!T.b.asked.some(r => r.hint === 'discard'), 'B wasn\'t asked');
});

// ================================================================
let pass = 0, fail = 0;
for (const t of tests) {
  if (ONLY && !ONLY.test(t.name)) continue;
  try { await t.fn(); pass++; } catch (e) { fail++; console.log(`FAIL ${t.name}: ${e.message}${e.message.startsWith("expected") ? "" : "\n" + (e.stack || "").split("\n").slice(1, 5).join("\n")}`); if (process.env.DEBUG && lastGame) console.log(lastGame.logs.slice(-25).map(l => "    | " + l.text).join("\n")); }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
