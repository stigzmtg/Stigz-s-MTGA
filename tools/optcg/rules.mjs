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
  T.a.on('pay-cost', () => true); T.a.on('discard-opp', req => { req0 = req; return req.options.slice(-2); });
  await T.play(T.hand(0, 'ST10-010'));
  expect(T.B.hand.length === 5 && T.B.trash.length === 2 && req0.from === 'opp-hand' && req0.min === 2, 'A picked 2 from B\'s hand');
  expect(!T.b.asked.some(r => r.hint === 'discard'), 'B wasn\'t asked');
});

// ================================================================ ST-11 to ST-20
test('"If X, A. Then, B.": when X fails, B isn\'t resolved either (4-10-1): ST15-004 Thatch with a non-Whitebeard Leader', async () => {
  const T = setup();
  T.life(0, [FILLER, FILLER]);
  T.don(0, 1);
  await T.play(T.hand(0, 'ST15-004'));
  expect(T.A.life.length === 2, 'no Life card added to the hand');
  const T2 = setup({ leaders: ['OP02-001', 'ST01-001'] });
  T2.life(0, [FILLER, FILLER]);
  const t = T2.char(1, FILLER);
  T2.don(0, 1);
  T2.a.on('debuff', () => [t.uid]);
  await T2.play(T2.hand(0, 'ST15-004'));
  expect(T2.A.life.length === 1 && T2.g.power(t) === 3000, 'Whitebeard Leader: −2000 and a Life card to the hand');
});
test('OP01-060 Doflamingo (Leader): [DON!! x2] [When Attacking] ①: reveal the top card; a cost 4 or less Warlords Character may be played rested', async () => {
  const T = setup({ leaders: ['OP01-060', 'ST01-001'] });
  T.quiet();
  T.life(1, [FILLER]);
  T.don(0, 3); await T.give(T.A.leader, 2);
  const [law] = T.deckTop(0, ['ST03-008']);
  T.a.on('pay-cost', () => true); T.a.on('may', () => true);
  await T.attack(T.A.leader, T.B.leader);
  expect(T.A.characters.includes(law) && law.rested && T.A.donRested === 1, 'Law played rested; 1 DON!! rested');
  const T2 = setup({ leaders: ['OP01-060', 'ST01-001'] });
  T2.quiet();
  T2.life(1, [FILLER]);
  T2.don(0, 3); await T2.give(T2.A.leader, 2);
  const [big] = T2.deckTop(0, ['ST03-009']);              // Doflamingo, cost 7
  T2.a.on('pay-cost', () => true); T2.a.on('may', () => true);
  await T2.attack(T2.A.leader, T2.B.leader);
  expect(T2.A.deck[0] === big && !T2.A.characters.length, 'too expensive: it stays on top of the deck');
});
test('"You cannot add Life cards to your hand using your own effects" (OP02-023): effects and costs can\'t, damage still does', async () => {
  const T = setup({ leaders: ['OP02-001', 'ST01-001'] });
  T.life(0, [FILLER, FILLER, FILLER]);
  T.don(0, 1);
  await T.play(T.hand(0, 'OP02-023'));
  const d = T.char(0, 'ST07-005'); T.don(0, 1); await T.give(d);
  T.quiet(); T.life(1, [FILLER]);
  T.a.asked = [];
  await T.attack(d, T.B.leader);
  expect(!T.a.asked.some(r => r.hint === 'pay-cost'), 'Daifuku\'s Life cost can\'t be paid');
  T.don(0, 1);
  await T.play(T.hand(0, 'ST15-004'));
  expect(T.A.life.length === 3, 'Thatch doesn\'t add a Life card');
  T.g.current = 1; T.B.turns = 3; T.quiet(0);
  await T.attack(T.char(1, 'ST04-003'), T.A.leader);
  expect(T.A.life.length === 2, 'damage still adds one');
});
test('OP02-035 Law: ① and return it to the hand: play a cost-3 Character', async () => {
  const T = setup();
  const law = T.char(0, 'OP02-035');
  T.don(0, 1);
  const c = T.hand(0, FILLER);
  await T.activate(law);
  expect(T.A.hand.includes(law) && T.A.characters.includes(c) && T.A.donRested === 1, 'Law back in hand, Robin played for free');
});
test('OP02-045 Oni Giri: [Counter] +6000, then play a cost 3 or less Character with no base effect (2-8-5)', async () => {
  const T = setup();
  T.life(1, [FILLER]);
  const v = T.hand(1, 'ST03-011'), nv = T.hand(1, 'ST03-008');
  T.hand(1, 'OP02-045'); T.don(1, 3);
  T.b.on('blocker', () => null);
  let n = 0, opts;
  T.b.on('counter', req => (n++ ? null : req.options.find(o => o.kind === 'event')));
  T.b.on('buff', () => [T.B.leader.uid]);
  T.b.on('play', req => { opts = req.options; return req.options; });
  await T.attack(T.char(0, FILLER), T.B.leader);
  expect(T.B.characters.includes(v) && opts.length === 1 && T.B.hand.includes(nv), 'only the vanilla Buggy');
});
test('P-057 Fleeting Lullaby: the opponent\'s rested Characters stay rested in their next Refresh Phase only', async () => {
  const T = setup({ leaders: ['ST11-001', 'ST01-001'] });
  const r = T.char(1, FILLER, { rested: true });
  T.don(0, 3);
  T.a.on('main', () => ({ t: 'end' })); T.b.on('main', () => ({ t: 'end' }));
  await T.play(T.hand(0, 'P-057'));
  await T.nextTurn();
  expect(r.rested, 'still rested in B\'s turn');
  await T.nextTurn(); await T.nextTurn();
  expect(!r.rested, 'active in the Refresh Phase after that');
});
test('P-058 Where the Wind Blows: set your {FILM} Characters as active at the end of the turn', async () => {
  const T = setup({ leaders: ['ST11-001', 'ST01-001'] });
  const u = T.char(0, 'ST11-002', { rested: true });
  T.don(0, 2);
  await T.play(T.hand(0, 'P-058'));
  expect(u.rested, 'not yet');
  await T.g.endPhase(0);
  expect(!u.rested, 'active at the end of the turn');
});
test('P-059 The World\'s Continuation: return any number of your Characters, +2000 for each', async () => {
  const T = setup({ leaders: ['ST01-001', 'ST11-001'] });
  T.life(1, [FILLER]);
  const a = T.char(1, FILLER), b2 = T.char(1, FILLER);
  T.hand(1, 'P-059'); T.don(1, 2);
  T.b.on('blocker', () => null);
  let n = 0;
  T.b.on('counter', req => (n++ ? null : req.options.find(o => o.kind === 'event')));
  T.b.on('bounce-own', () => [a.uid, b2.uid]); T.b.on('buff', () => [T.B.leader.uid]);
  const att = T.char(0, FILLER); T.don(0, 3); await T.give(att, 3);     // 8000 vs 5000 + 4000
  await T.attack(att, T.B.leader);
  expect(T.B.hand.includes(a) && T.B.hand.includes(b2) && T.B.life.length === 1, 'both returned, the Leader survives at 9000');
});
test('ST11-001 Uta (Leader): [When Attacking] reveal the top card: a {FILM} card to the hand, else to the bottom', async () => {
  for (const [id, toHand] of [['ST11-002', true], [FILLER, false]]) {
    const T = setup({ leaders: ['ST11-001', 'ST01-001'] });
    T.quiet(); T.life(1, [FILLER]);
    T.don(0, 1); await T.give(T.A.leader);
    const [c] = T.deckTop(0, [id]);
    await T.attack(T.A.leader, T.B.leader);
    expect(toHand ? T.A.hand.includes(c) : T.A.deck[T.A.deck.length - 1] === c, toHand ? 'Uta to hand' : 'Robin to the bottom');
    expect(T.g.events.some(e => e.kind === 'reveal' && e.card === c.uid), 'revealed');
  }
});
test('ST12-010 Ivankov: [On Play] reveal the top card and play it if it is a cost-2 Character; else top or bottom', async () => {
  const T = setup();
  T.don(0, 3);
  const [c] = T.deckTop(0, ['ST05-003']);                    // Ann, cost 2
  await T.play(T.hand(0, 'ST12-010'));
  expect(T.A.characters.includes(c), 'Ann played');
  const T2 = setup();
  T2.don(0, 3);
  const [c2] = T2.deckTop(0, [FILLER]);
  T2.a.on('keep-top', () => []);
  await T2.play(T2.hand(0, 'ST12-010'));
  expect(T2.A.deck[T2.A.deck.length - 1] === c2, 'Robin to the bottom');
});
test('ST13-003 Luffy (Leader): face-up Life cards go to the bottom of the deck instead of the hand by damage, not by effects; [Activate: Main] at 0 Life add 2 cost-5 Characters face-up', async () => {
  const T = setup({ leaders: ['ST01-001', 'ST13-003'] });
  T.quiet();
  const l = [...T.life(1, ['ST13-008', 'ST13-015'])];
  l[0].faceUp = true;
  await T.attack(T.A.leader, T.B.leader);
  expect(T.B.deck[T.B.deck.length - 1] === l[0] && !T.B.hand.includes(l[0]), 'face-up Life card to the bottom of the deck');
  l[1].faceUp = true;
  T.g.current = 1;
  await T.g.lifeToHand(1, l[1], { byEffect: true });
  expect(T.B.hand.includes(l[1]), 'an effect adds it to the hand ("according to the rules")');
  const T2 = setup({ leaders: ['ST13-003', 'ST01-001'] });
  T2.life(0, []);
  T2.don(0, 2); await T2.give(T2.A.leader, 2);
  const a = T2.hand(0, 'ST13-011'), x = T2.hand(0, FILLER), s = T2.trash(0, 'ST13-008');
  T2.a.on('discard', () => [x.uid]); T2.a.on('to-life', req => { expect(req.options.length === 2, 'Ace in the hand and Sabo in the trash'); return req.options; });
  await T2.activate(T2.A.leader, 1);
  expect(T2.A.life.length === 2 && T2.A.life.every(c => c.faceUp) && T2.A.life.includes(a) && T2.A.life.includes(s), '2 face-up Life cards');
});
test('ST13-004 Newgate: add a deck card to Life, then look at all Life cards: 1 to the top of the deck, the rest back in any order', async () => {
  const T = setup();
  const l = [...T.life(0, ['ST01-012', FILLER])];
  T.don(0, 6);
  const [top] = T.deckTop(0, ['ST13-008']);
  T.a.on('topdeck', () => [l[0].uid]); T.a.on('order-life', req => [...req.options].reverse());
  await T.play(T.hand(0, 'ST13-004'));
  expect(T.A.deck[0] === l[0] && T.A.life.length === 2 && T.A.life[0] === l[1] && T.A.life[1] === top, `Luffy to the deck top; Life reordered (${T.A.life.map(c => c.name)})`);
});
test('ST13-006 Dadan: play up to 1 each of cost-2 [Sabo], [Portgas.D.Ace] and [Monkey.D.Luffy] from the hand', async () => {
  const T = setup();
  T.don(0, 5);
  const s = T.hand(0, 'ST13-007'), a = T.hand(0, 'ST13-010'), l = T.hand(0, 'ST13-014'), big = T.hand(0, 'ST13-008');
  await T.play(T.hand(0, 'ST13-006'));
  expect([s, a, l].every(c => T.A.characters.includes(c)) && T.A.hand.includes(big), 'the three cost-2 brothers');
});
test('ST13-007 Sabo: trash it: reveal the top Life card; a cost-5 [Sabo] may be played, and then the Leader gets +2000', async () => {
  const T = setup();
  const s = T.char(0, 'ST13-007');
  const [l] = T.life(0, ['ST13-008']);
  T.a.on('may', () => true);
  await T.activate(s);
  expect(T.A.characters.includes(l) && T.A.trash.includes(s) && T.g.power(T.A.leader) === 7000, 'Sabo played from Life, Leader +2000');
  const T2 = setup();
  const s2 = T2.char(0, 'ST13-007');
  const [l2] = T2.life(0, [FILLER]);
  await T2.activate(s2);
  expect(T2.A.life[0] === l2 && T2.g.power(T2.A.leader) === 5000, 'not a Sabo: stays in Life, no boost');
});
test('ST13-011 Ace: [On Play] [Rush] with 2 or less Life (no duration: while it stays)', async () => {
  const T = setup();
  T.life(0, [FILLER, FILLER]);
  T.don(0, 5);
  const a = T.hand(0, 'ST13-011');
  await T.play(a);
  expect(T.g.has(a, 'Rush') && T.can({ t: 'attack', card: a.uid }), '[Rush]');
});
test('ST14-001 Luffy (Leader): +1 cost to your Characters applies before "If you have a Character with a cost of 8 or more" is checked', async () => {
  const T = setup({ leaders: ['ST14-001', 'ST01-001'] });
  const z = T.char(0, 'ST14-010');                 // Brook, cost 5
  T.don(0, 1); await T.give(T.A.leader);
  expect(T.g.cost(z) === 6 && T.g.power(T.A.leader) === 6000, `cost 6, Leader 5000 + 1000 DON!! (${T.g.cost(z)}, ${T.g.power(T.A.leader)})`);
  const c7 = T.char(0, 'ST14-013'); T.g.addEffect({ kind: 'cost', card: c7, n: 1 }, 'turn', 0);    // Zoro 6 + 1 + 1 = 8
  expect(T.g.cost(c7) === 8 && T.g.power(T.A.leader) === 7000, `Zoro at 8: Leader +1000 (${T.g.cost(c7)}, ${T.g.power(T.A.leader)})`);
});
test('ST14-009 Franky: [DON!! x1] [Opponent\'s Turn] with a cost 6+ Character: can\'t be K.O.\'d by the opponent\'s effects, +2000', async () => {
  const T = setup({ leaders: ['ST01-001', 'ST14-001'] });
  const f = T.char(1, 'ST14-009'); f.don = 1; T.B.donDeck = 9;
  T.char(1, 'ST14-013');
  expect(T.g.power(f) === 8000 && !T.g.canBeKOd(f, { by: 'effect', pid: 0 }), `8000, protected (${T.g.power(f)})`);
  expect(T.g.canBeKOd(f, { by: 'battle', pid: 0 }), 'battle still K.O.s it');
});
test('ST16-002 Gordon: [On Your Opponent\'s Attack] trash any number of {Music} cards: +1000 power each this battle', async () => {
  const T = setup();
  T.life(1, [FILLER]);
  T.char(1, 'ST16-002');
  const m1 = T.hand(1, 'ST11-002'), m2 = T.hand(1, 'ST11-003'), other = T.hand(1, FILLER);
  T.b.on('blocker', () => null); T.b.on('counter', () => null);
  let opts;
  T.b.on('discard-any', req => { opts = req.options; return req.options; }); T.b.on('buff', () => [T.B.leader.uid]);
  const att = T.char(0, FILLER); T.don(0, 1); await T.give(att);     // 6000 vs 5000 + 2000
  await T.attack(att, T.B.leader);
  expect(opts.length === 2 && T.B.trash.includes(m1) && T.B.trash.includes(m2) && T.B.hand.includes(other) && T.B.life.length === 1, 'two Music cards trashed, the Leader holds');
});
test('ST16-003 Katakuri: "6 or more rested cards" counts rested DON!! cards in the cost area (6-2-4)', async () => {
  const T = setup({ leaders: ['ST05-001', 'ST01-001'] });
  const k = T.char(0, 'ST16-003');
  T.don(0, 0, 5);
  expect(T.g.power(k) === 4000, '5 rested: no boost');
  T.A.leader.rested = true; T.g.touch();
  expect(T.g.power(k) === 6000, `5 DON!! + the Leader: +2000 (${T.g.power(k)})`);
});
test('ST16-005 Luffy: +1000 with a rested [Uta]', async () => {
  const T = setup();
  const l = T.char(0, 'ST16-005');
  const u = T.char(0, 'ST16-001');
  expect(T.g.power(l) === 3000, 'Uta active');
  u.rested = true; T.g.touch();
  expect(T.g.power(l) === 4000, 'Uta rested');
});
test('ST17-001 Crocodile: reveal the top card; a Warlords card: draw 2 and put 1 from the hand on top of the deck', async () => {
  const T = setup();
  T.don(0, 4);
  T.deckTop(0, ['ST03-008']);
  const h = T.hand(0, 'ST01-012');
  T.a.on('topdeck', () => [h.uid]);
  const before = T.A.hand.length;
  await T.play(T.hand(0, 'ST17-001'));
  expect(T.A.deck[0] === h && T.A.hand.length === before + 1, 'drew 2 and put Luffy back on top');
});
test('ST19-003 Tashigi: trash a cost-0 Character the turn she\'s played; trashing isn\'t a K.O.', async () => {
  const T = setup();
  const t = T.char(0, 'ST19-003', { played: 3 });
  const c = T.char(1, 'ST06-004');        // Smoker can't be K.O.'d by effects, but can be trashed
  T.g.addEffect({ kind: 'cost', card: c, n: -5 }, 'turn', 0);
  await T.activate(t, 1);
  expect(T.B.trash.includes(c) && !T.g.events.some(e => e.kind === 'ko'), 'trashed, not K.O.\'d');
});
test('ST15-005 Ace: [Once Per Turn] if it would be removed from the field by the opponent\'s effect, −2000 power instead', async () => {
  const T = setup();
  const a = T.char(1, 'ST15-005');
  T.don(0, 7);
  T.b.on('replace', () => true);
  T.a.on('bounce', () => [a.uid]);
  await T.play(T.hand(0, 'ST03-009'));          // Doflamingo: return up to 1 cost 7 or less
  expect(T.B.characters.includes(a) && T.g.power(a) === 4000, `stays at 4000 (${T.g.power(a)})`);
});
test('ST20-002 Cracker: the replacement covers K.O. by effects only, not in battle', async () => {
  const T = setup();
  T.quiet();
  const c = T.char(1, 'ST20-002', { rested: true });
  T.life(1, [FILLER, FILLER]);
  T.b.on('replace', () => true);
  await T.attack(T.char(0, 'ST04-003'), c);
  expect(T.B.trash.includes(c) && T.B.life.length === 2, 'K.O.\'d in battle');
});
test('ST12-001 Zoro & Sanji (Leader): [When Attacking] return a cost 2+ Character: set a 7000-or-less Character as active', async () => {
  const T = setup({ leaders: ['ST12-001', 'ST01-001'] });
  T.quiet(); T.life(1, [FILLER]);
  const back = T.char(0, 'ST12-002');
  const r = T.char(0, FILLER, { rested: true });
  T.don(0, 1); await T.give(T.A.leader);
  T.a.on('pay-cost', () => true); T.a.on('bounce-cost', () => [back.uid]); T.a.on('set-active', () => [r.uid]);
  await T.attack(T.A.leader, T.B.leader);
  expect(T.A.hand.includes(back) && !r.rested, 'Kuina returned, Robin active');
});

// ================================================================ ST-21 to ST-30
test('Resting: an already rested card isn\'t offered; setting active: an active one isn\'t', async () => {
  const T = setup();
  const r = T.char(1, 'ST01-012', { rested: true }), a = T.char(1, FILLER);
  T.don(0, 2);
  let opts;
  T.a.on('rest', req => { opts = req.options; return []; });
  await T.play(T.hand(0, 'ST02-017'));
  expect(opts.length === 1 && opts[0] === a.uid, 'only the active Character');
  void r;
});
test('OP07-031 Bartolomeo: [Your Turn] [Once Per Turn] when a Character is rested by your effect, draw 1 and trash 1', async () => {
  const T = setup();
  T.char(0, 'OP07-031');
  const t = T.char(1, 'ST01-006');            // Usopp, cost 2? any cost-2 or less Character
  T.g.addEffect({ kind: 'cost', card: t, n: -5 }, 'turn', 0);
  const x = T.hand(0, FILLER);
  T.a.on('discard', () => [x.uid]);
  T.don(0, 1);
  await T.play(T.hand(0, 'EB01-015'));
  expect(t.rested && T.A.trash.includes(x), 'Apoo rested it: Bartolomeo drew and trashed');
  const n = T.A.hand.length;
  const t2 = T.char(1, FILLER); T.g.addEffect({ kind: 'cost', card: t2, n: -5 }, 'turn', 0);
  T.don(0, 1);
  await T.play(T.hand(0, 'EB01-015'));
  expect(t2.rested && T.A.hand.length === n, 'once per turn');
});
test('OP09-001 Shanks (Leader): [Once Per Turn] may give -1000 when the opponent attacks', async () => {
  const T = setup({ leaders: ['ST01-001', 'OP09-001'] });
  T.life(1, [FILLER]);
  T.b.on('blocker', () => null); T.b.on('counter', () => null);
  T.b.on('pay-cost', () => true);
  const att = T.char(0, FILLER);                   // 5000 vs 5000: -1000 makes it lose
  T.b.on('debuff', () => [att.uid]);
  await T.attack(att, T.B.leader);
  expect(T.B.life.length === 1 && T.g.power(att) === 4000, 'the attack failed');
  T.g.current = 0;
  const att2 = T.char(0, FILLER);
  T.b.asked = [];
  await T.attack(att2, T.B.leader);
  expect(T.B.life.length === 0 && !T.b.asked.some(r => r.hint === 'pay-cost'), 'once per turn');
});
test('OP09-012 Monster: if your [Bonk Punch] would be K.O.\'d by an effect, trash Monster instead', async () => {
  const T = setup();
  const bp = T.char(1, 'OP09-010'), m = T.char(1, 'OP09-012');
  T.b.on('replace', () => true);
  await T.g.ko(bp, { by: 'effect', pid: 0 });
  expect(T.B.characters.includes(bp) && T.B.trash.includes(m), 'Monster trashed instead');
});
test('OP09-014 Limejuice: the opponent can\'t activate up to 1 [Blocker] with 4000 power or less this turn', async () => {
  const T = setup();


  const ts = T.char(1, 'ST06-007');                // Tsuru, [Blocker], 2000
  T.don(0, 3);
  await T.play(T.hand(0, 'OP09-014'));
  T.life(1, [FILLER]);
  T.b.asked = []; T.b.on('counter', () => null);
  await T.attack(T.A.leader, T.B.leader);
  expect(!T.b.asked.some(r => r.type === 'blocker' && r.options.includes(ts.uid)), 'Tsuru can\'t block');
});
test('OP09-051 Buggy: bottom an opponent\'s Character, then Buggy goes to the bottom too without 5 cost-5+ Characters', async () => {
  const T = setup();
  const t = T.char(1, FILLER);
  T.don(0, 10);
  const bg = T.hand(0, 'OP09-051');
  T.a.on('bottom', () => [t.uid]);
  await T.play(bg);
  expect(T.B.deck[T.B.deck.length - 1] === t && T.A.deck[T.A.deck.length - 1] === bg, 'both to the bottom');
  const T2 = setup();
  for (let i = 0; i < 4; i++) T2.char(0, 'ST03-003');            // 4 cost-5 Crocodiles
  T2.don(0, 10);
  const bg2 = T2.hand(0, 'OP09-051');
  T2.a.on('trash-for-room', req => [req.options[0]]);
  await T2.play(bg2);
  expect(T2.A.characters.includes(bg2), 'with Buggy, 5 Characters of cost 5 or more: it stays');
});
test('OP09-061 Luffy (Leader): [Your Turn] [Once Per Turn] when 2+ DON!! are returned: 1 active and 1 rested DON!! from the DON!! deck', async () => {
  const T = setup({ leaders: ['OP09-061', 'ST01-001'] });
  T.don(0, 5);
  T.char(1, FILLER);
  await T.play(T.hand(0, 'OP09-077'));          // Gum-Gum Lightning: [Main] DON!! -2 (cost 2)
  expect(T.A.donDeck === 5 && T.A.donActive === 4 && T.A.donRested === 1, `returned 2, got 1 active and 1 rested back (${T.A.donDeck}, ${T.A.donActive}, ${T.A.donRested})`);
});
test('OP09-081 Teach (Leader): your [On Play] effects are negated; [Activate: Main] negates the opponent\'s until the end of their next turn', async () => {
  const T = setup({ leaders: ['OP09-081', 'ST01-001'] });
  T.don(0, 4);
  const before = T.A.deck.length;
  await T.play(T.hand(0, 'ST08-009'));         // Makino: [On Play] draw if a cost-0 Character
  T.g.addEffect({ kind: 'cost', card: T.A.characters[0], n: -5 }, 'turn', 0);
  await T.play(T.hand(0, 'ST08-009'));
  expect(T.A.deck.length === before, 'no draw');
  const x = T.hand(0, FILLER);
  T.a.on('discard', () => [x.uid]);
  await T.activate(T.A.leader, 1);
  T.a.on('main', () => ({ t: 'end' }));
  await T.nextTurn();
  T.B.donActive = 5;
  const t = T.char(0, FILLER);
  T.b.on('ko', () => [t.uid]);
  await T.play(T.hand(1, 'ST02-005'));          // Killer: [On Play] K.O. a rested cost 3 or less
  expect(T.A.characters.includes(t), 'B\'s [On Play] did nothing');
});
test('OP09-086 Burgess: +1000 power for every 4 cards in your trash (Blackbeard Leader)', async () => {
  const T = setup({ leaders: ['OP09-081', 'ST01-001'] });
  const b = T.char(0, 'OP09-086');
  for (let i = 0; i < 9; i++) T.trash(0, FILLER);
  expect(T.g.power(b) === 7000, `5000 + 2 x 1000 (${T.g.power(b)})`);
});
test('P-084 Buggy: can\'t attack; with a [Buggy] Leader, no Character with a cost of 3 or 4 can attack', async () => {
  const T = setup({ leaders: ['OP09-042', 'ST01-001'] });
  const bg = T.char(0, 'P-084');
  const c3 = T.char(0, FILLER), c5 = T.char(0, 'ST03-003');
  T.life(1, [FILLER]);
  expect(!T.g.canAttack(bg) && !T.g.canAttack(c3) && T.g.canAttack(c5), 'Buggy and the cost-3 can\'t, the cost-5 can');
});
test('ST21-003 Sanji: the selected Character can\'t be blocked if it attacks this turn', async () => {
  const T = setup();
  const z = T.char(0, 'ST01-012');               // Luffy 6000, Straw Hat Crew
  T.don(0, 2);
  T.a.on('select', () => [z.uid]);
  await T.play(T.hand(0, 'ST21-003'));
  T.char(1, 'ST06-007'); T.life(1, [FILLER]);
  T.b.asked = []; T.b.on('counter', () => null);
  await T.attack(z, T.B.leader);
  expect(!T.b.asked.some(r => r.type === 'blocker') && T.B.life.length === 0, 'unblockable this turn');
});
test('ST22-001 Ace & Newgate (Leader): reveal a Whitebeard card from the hand: draw 1, the revealed card goes on top of the deck', async () => {
  const T = setup({ leaders: ['ST22-001', 'ST01-001'] });
  const w = T.hand(0, 'ST22-009');
  await T.activate(T.A.leader);
  expect(T.A.deck[0] === w && !T.A.hand.includes(w) && T.A.hand.length === 1, 'Vista on top, a new card in hand');
});
test('ST22-015 I Am Whitebeard!!: play Newgate, then may take a Life card: Leader +2000', async () => {
  const T = setup({ leaders: ['ST22-001', 'ST01-001'] });
  T.don(0, 8);
  const n = T.hand(0, 'ST22-003');
  T.life(0, [FILLER, FILLER]);
  T.a.on('may', () => true);
  await T.play(T.hand(0, 'ST22-015'));
  expect(T.A.characters.includes(n) && T.A.life.length === 1 && T.g.power(T.A.leader) === 7000, 'Newgate played, Leader at 7000');
});
test('ST26-002 Chopper: DON!! −2: rest an opponent\'s DON!! card or a cost 1 or less Character', async () => {
  const T = setup();
  T.don(0, 5); T.don(1, 3);
  T.a.on('pay-cost', () => true); T.a.on('rest-don-or-char', () => 'don');
  await T.play(T.hand(0, 'ST26-002'));
  expect(T.B.donActive === 2 && T.B.donRested === 1, 'one of B\'s DON!! rested');
});
test('ST27-004 Wolf: [Blocker] and +1 cost per 4 cards in the trash (Blackbeard Leader)', async () => {
  const T = setup({ leaders: ['OP09-081', 'ST01-001'] });
  const w = T.char(0, 'ST27-004');
  for (let i = 0; i < 8; i++) T.trash(0, FILLER);
  expect(T.g.has(w, 'Blocker') && T.g.cost(w) === 6, `Blocker, cost 4 + 2 (${T.g.cost(w)})`);
});
test('ST28-002 Izo: your {Land of Wano} Leader gains [Banish] this turn', async () => {
  const T = setup({ leaders: ['OP06-022', 'ST01-001'] });
  T.don(0, 2);
  await T.play(T.hand(0, 'ST28-002'));
  expect(T.g.has(T.A.leader, 'Banish'), '[Banish]');
  const T2 = setup();
  T2.don(0, 2);
  await T2.play(T2.hand(0, 'ST28-002'));
  expect(!T2.g.has(T2.A.leader, 'Banish'), 'not for another Leader');
});
test('ST30-009 LittleOars Jr.: a 6000-base-power Character removed by the opponent: trash LittleOars and draw 1 instead', async () => {
  const T = setup();
  const lo = T.char(1, 'ST30-009'), j = T.char(1, 'ST30-006');      // Jinbe 6000
  T.b.on('replace', () => true);
  const before = T.B.hand.length;
  await T.g.ko(j, { by: 'effect', pid: 0 });
  expect(T.B.characters.includes(j) && T.B.trash.includes(lo) && T.B.hand.length === before + 1, 'Jinbe stays; LittleOars trashed; drew 1');
});
test('ST30-014 Mr.3: rest it: give up to 2 rested DON!! each to up to 2 Characters with 6000 base power', async () => {
  const T = setup();
  const m = T.char(0, 'ST30-014'), a = T.char(0, 'ST30-006'), b = T.char(0, 'ST30-007');
  T.don(0, 0, 4);
  T.a.on('give-don', () => [a.uid, b.uid]); T.a.on('don-n', req => req.max);
  await T.activate(m);
  expect(a.don === 2 && b.don === 2 && T.A.donRested === 0, '2 each');
});

// ================================================================ ST-31 to ST-36
test('OP11-062 Katakuri (Leader): DON!! −1: look at the top card of the opponent\'s deck (only this player is told), +1000 this battle', async () => {
  const T = setup({ leaders: ['OP11-062', 'ST01-001'] });
  T.quiet(); T.life(1, [FILLER]);
  T.don(0, 1);
  const [top] = T.deckTop(1, ['ST01-012']);
  let seen;
  T.a.on('pay-cost', () => true); T.a.on('look', req => { seen = req; return true; });
  await T.attack(T.A.leader, T.B.leader);
  expect(seen && seen.card === top.uid && /Luffy/.test(seen.prompt) && T.B.deck[0] === top, 'A saw it; it stays on top');
  expect(T.A.donDeck === 10 && !T.b.asked.some(r => r.hint === 'look'), 'DON!! returned; B not asked');
});
test('"Choose a cost and reveal the top card of your opponent\'s deck" (OP11-081): the K.O. happens only on a match', async () => {
  for (const [guess, hit] of [[3, true], [4, false]]) {
    const T = setup();
    const t = T.char(1, FILLER);
    T.deckTop(1, ['ST01-008']);                     // cost 3
    T.don(0, 6);
    T.a.on('choose-cost', () => guess); T.a.on('ko', () => [t.uid]);
    await T.play(T.hand(0, 'OP11-081'));
    expect(hit ? T.B.trash.includes(t) : T.B.characters.includes(t), `guess ${guess}: ${hit ? 'K.O.' : 'nothing'}`);
  }
});
test('OP12-020 Zoro (Leader): [DON!! x3] after battling a Character, set active; then it can\'t attack Characters with a base cost of 7 or less', async () => {
  const T = setup({ leaders: ['OP12-020', 'ST01-001'] });
  T.quiet();
  T.don(0, 3); await T.give(T.A.leader, 3);
  const r = T.char(1, FILLER, { rested: true });
  const big = T.char(1, 'ST04-003', { rested: true });     // Kaido, cost 9
  const small = T.char(1, 'ST03-002', { rested: true });   // Weevil, cost 3
  await T.attack(T.A.leader, r);
  await T.activate(T.A.leader);
  expect(!T.A.leader.rested, 'active again');
  const targets = T.g.attackTargets(T.A.leader).map(c => c.uid);
  expect(targets.includes(big.uid) && !targets.includes(small.uid) && targets.includes(T.B.leader.uid), 'can attack Kaido and the Leader, not Weevil');
});
test('OP12-020 Zoro (Leader): without a battle against a Character this turn, nothing', async () => {
  const T = setup({ leaders: ['OP12-020', 'ST01-001'] });
  T.quiet(); T.life(1, [FILLER, FILLER]);
  T.don(0, 3); await T.give(T.A.leader, 3);
  await T.attack(T.A.leader, T.B.leader);
  await T.activate(T.A.leader);
  expect(T.A.leader.rested, 'stays rested');
});
test('OP12-028 Hiyori: "<Slash> attribute card or green Event"', async () => {
  const T = setup({ leaders: ['OP12-020', 'ST01-001'] });
  const h = T.char(0, 'OP12-028');
  T.don(0, 1);
  const top = T.deckTop(0, ['ST03-002', 'ST02-017', 'ST01-016', FILLER, FILLER]);   // Slash char, green Event, red Event
  let opts;
  T.a.on('take', req => { opts = req.options; return []; });
  await T.activate(h);
  expect(opts.length === 2 && opts.includes(top[0].uid) && opts.includes(top[1].uid), `Weevil and Straw Sword (${opts.length})`);
});
test('OP12-040 Kuzan (Leader): a card trashed from your hand by your {Navy} card\'s effect: draw that many', async () => {
  const T = setup({ leaders: ['OP12-040', 'ST01-001'] });
  T.don(0, 5);
  const a = T.hand(0, FILLER), b = T.hand(0, FILLER);
  T.a.on('discard', () => [a.uid, b.uid]);
  await T.play(T.hand(0, 'OP12-046'));          // Zephyr (Navy): [On Play] trash 2 cards from your hand
  expect(T.A.trash.includes(a) && T.A.trash.includes(b) && T.A.hand.length === 2, `drew 2 (${T.A.hand.length})`);
  const T2 = setup({ leaders: ['OP12-040', 'ST01-001'] });
  T2.don(0, 6);
  const x = T2.hand(0, FILLER);
  T2.a.on('pay-cost', () => true); T2.a.on('discard', () => [x.uid]);
  await T2.play(T2.hand(0, 'ST04-005'));         // Queen (not Navy): DON!! −1: draw 2, trash 1
  expect(T2.A.trash.includes(x) && T2.A.hand.length === 2, `no extra draw (${T2.A.hand.length})`);
});
test('OP12-098 Hair Removal Fist: "that card gains an additional +2000" with a cost-8 Revolutionary Army Character', async () => {
  const T = setup({ leaders: ['ST01-001', 'OP13-004'] });
  T.char(1, 'ST35-004'); T.g.addEffect({ kind: 'cost', card: T.B.characters[0], n: 1 }, 'turn', 1);   // Koala 7 + 1 + 1 = 9
  T.life(1, [FILLER]);
  T.hand(1, 'OP12-098'); T.don(1, 1);
  T.b.on('blocker', () => null);
  let n = 0;
  T.b.on('counter', req => (n++ ? null : req.options.find(o => o.kind === 'event')));
  T.b.on('buff', () => [T.B.leader.uid]);
  const att = T.char(0, FILLER); T.don(0, 3); await T.give(att, 3);     // 8000
  T.b.on('main', () => ({ t: 'end' }));
  await T.attack(att, T.B.leader);
  expect(T.B.life.length === 1, 'Leader 4000 + 1000 (Sabo) + 2000 + 2000 = 9000 holds');
});
test('OP13-004 Sabo (Leader): −1000 with 4+ Life; [DON!! x1] with a cost-8 Character, the Leader and all Characters +1000', async () => {
  const T = setup({ leaders: ['OP13-004', 'ST01-001'] });
  T.life(0, [FILLER, FILLER, FILLER, FILLER]);
  expect(T.g.power(T.A.leader) === 4000, `4000 (${T.g.power(T.A.leader)})`);
  const k = T.char(0, 'ST35-004');             // Koala, 7 + 1 = 8
  const c = T.char(0, FILLER);
  T.A.leader.don = 1; T.A.donDeck = 9;
  expect(T.g.power(T.A.leader) === 6000 && T.g.power(c) === 6000 && T.g.power(k) === 7000, `${T.g.power(T.A.leader)}, ${T.g.power(c)}, ${T.g.power(k)}`);
});
test('P-088 Law: [Trigger] plays it with a {Supernovas} Leader and 5 or less Life in total', async () => {
  const T = setup({ leaders: ['ST01-001', 'OP10-099'] });
  T.quiet(); T.b.on('trigger', () => true);
  T.life(1, ['P-088', FILLER]); T.life(0, [FILLER, FILLER]);
  await T.attack(T.char(0, FILLER), T.B.leader);
  expect(T.B.characters.some(c => c.id === 'P-088'), 'played (1 + 2 Life left)');
});
test('ST31-003 Brook and ST31-004 Luffy: "a total of 3 or more given DON!! cards"; -1000 for every {Straw Hat Crew} card on your field', async () => {
  const T = setup({ leaders: ['ST21-001', 'ST01-001'] });
  const b = T.char(0, 'ST31-003');
  T.don(0, 6); await T.give(T.A.leader, 2);
  T.g.current = 1; T.g.touch();
  expect(!T.g.has(b, 'Blocker'), '2 given: no');
  T.g.current = 0; await T.give(b);
  T.g.current = 1; T.g.touch();
  expect(T.g.has(b, 'Blocker') && T.g.power(b) === 6000, `3 given: [Blocker] and 3000 + 3000 (${T.g.power(b)})`);
  T.g.current = 0;
  const t = T.char(1, 'ST04-003');
  T.don(0, 7);
  T.a.on('debuff', () => [t.uid]);
  const l = T.hand(0, 'ST31-004');
  await T.play(l);
  expect(T.g.power(t) === 10000 - 3000 && T.g.has(l, 'Rush'), `Leader, Brook, Luffy: −3000 (${T.g.power(t)}); [Rush]`);
});
test('ST31-002 Jinbe: "play up to 1 {Straw Hat Crew} type card with a cost of 1" includes a Stage', async () => {
  const T = setup();
  T.don(0, 5);
  const s = T.hand(0, 'ST31-005');
  await T.play(T.hand(0, 'ST31-002'));
  expect(T.A.stage === s, 'Thousand Sunny played');
});
test('ST32-001 Kin\'emon: rest your <Slash> Leader or 1 DON!!: draw 2, trash 1', async () => {
  const T = setup({ leaders: ['OP12-020', 'ST01-001'] });
  T.don(0, 1);
  T.a.on('pay-cost', () => true); T.a.on('rest-leader-or-don', () => 'leader');
  await T.play(T.hand(0, 'ST32-001'));
  expect(T.A.leader.rested && T.A.hand.length === 1 && T.A.trash.length === 1, 'Leader rested, drew 2, trashed 1');
});
test('ST32-002 Oden: "cannot be rested": that Character can\'t attack, block or be rested by effects (decided: attacking and blocking rest it, 7-1-1-1, 10-1-2)', async () => {
  const T = setup();
  const t = T.char(1, 'ST06-007');                // Tsuru, [Blocker]
  T.don(0, 5);
  T.a.on('cantRest', () => [t.uid]);
  await T.play(T.hand(0, 'ST32-002'));
  T.life(1, [FILLER]);
  T.b.asked = []; T.b.on('counter', () => null);
  await T.attack(T.A.leader, T.B.leader);
  expect(!T.b.asked.some(r => r.type === 'blocker'), 'can\'t block');
  T.don(0, 2);
  await T.play(T.hand(0, 'ST02-017'));             // Straw Sword: rest up to 1
  expect(!t.rested, 'can\'t be rested');
  T.g.current = 1; T.B.turns = 3;
  expect(!T.g.attackTargets(t).length, 'can\'t attack');
});
test('ST33-004 Borsalino: −3 cost in the hand during a turn in which a card was trashed from your hand by an effect', async () => {
  const T = setup({ leaders: ['OP12-040', 'ST01-001'] });
  const b = T.hand(0, 'ST33-004');
  expect(T.g.cost(b) === 6, 'cost 6');
  T.don(0, 2);
  const x = T.hand(0, FILLER);
  T.a.on('pay-cost', () => true); T.a.on('discard', () => [x.uid]);
  await T.play(T.hand(0, 'ST33-001'));             // Koby: may trash 1: draw 1
  expect(T.g.cost(b) === 3, `cost 3 (${T.g.cost(b)})`);
});
test('ST36-005 Kid: [On Your Opponent\'s Attack] turn a face-up Life card face-down: the attack now targets Kid', async () => {
  const T = setup({ leaders: ['ST01-001', 'OP10-099'] });
  const k = T.char(1, 'ST36-005');
  const l = T.life(1, [FILLER, FILLER]); l[0].faceUp = true;
  T.b.on('pay-cost', () => true); T.b.on('blocker', () => null); T.b.on('counter', () => null);
  const att = T.char(0, FILLER);
  await T.attack(att, T.B.leader);
  expect(T.B.life.length === 2 && !l[0].faceUp && T.B.characters.includes(k), 'Kid (7000) took the attack instead of the Leader');
});

// ================================================================ the computer player
test('AI: no DON!! −4 (ST03-001 Crocodile) with only 4 DON!! on the field; with 10 it uses it', async () => {
  const T = setup({ leaders: ['ST03-001', 'ST01-001'] });
  T.char(1, 'ST03-003');
  T.don(0, 4);
  const acts = T.g.legalActions(0);
  const a = new OnePieceAI().main(T.g, 0, acts);
  expect(!(a.t === 'activate' && a.card === T.A.leader.uid), 'keeps the DON!!');
  T.don(0, 10);
  const b = new OnePieceAI().main(T.g, 0, T.g.legalActions(0));
  expect(b.t === 'activate' && b.card === T.A.leader.uid, 'uses it at 10');
});
test('AI: a [Counter] Event\'s boost goes to the attacked card', async () => {
  const T = setup();
  T.life(1, [FILLER, FILLER]);
  const other = T.char(1, 'ST04-003');
  T.hand(1, 'ST03-017'); T.don(1, 2);
  T.b.on('blocker', () => null);
  let picked;
  T.b.on('counter', req => req.options.find(o => o.kind === 'event') || null);
  const orig = T.b.ai.cards.bind(T.b.ai);
  T.b.ai.cards = (g, pid, req) => { const v = orig(g, pid, req); if (req.hint === 'buff') picked = v; return v; };
  await T.attack(T.char(0, FILLER), T.B.leader);
  expect(picked && picked[0] === T.B.leader.uid && picked[0] !== other.uid, 'the Leader, not Kaido');
});
test('AI: pays DON!! −1 for +1000 in a battle only when it changes the result (OP11-062 Katakuri)', async () => {
  const T = setup({ leaders: ['ST01-001', 'OP11-062'] });
  T.life(1, [FILLER, FILLER]);
  T.don(1, 8);
  T.b.on('blocker', () => null); T.b.on('counter', () => null);
  const big = T.char(0, 'ST04-003');            // 10000 vs 5000: +1000 doesn't help
  await T.attack(big, T.B.leader);
  expect(T.B.donDeck === 2, `no DON!! returned (${T.B.donDeck})`);
  const T2 = setup({ leaders: ['ST01-001', 'OP11-062'] });
  T2.life(1, [FILLER, FILLER]);
  T2.don(1, 8);
  T2.b.on('blocker', () => null); T2.b.on('counter', () => null);
  await T2.attack(T2.A.leader, T2.B.leader);     // 5000 vs 5000: +1000 holds
  expect(T2.B.donDeck === 3 && T2.B.life.length === 2, 'paid, and the Leader held');
});

// ================================================================ fail-safe
test('Fail-safe: in a game, an effect step, cost or condition the engine can\'t do is skipped and logged, never thrown; tests (throwErrors) throw', async () => {
  const T = setup();
  T.g.throwErrors = false;
  const ctx = { pid: 0, src: T.A.leader, vars: {} };
  await T.g.runSteps([{ op: 'noSuchStep' }, { op: 'draw', n: 1 }], ctx);
  expect(T.A.hand.length === 1 && T.g.problems.length === 1, 'the bad step skipped, the next one ran');
  expect(T.g.costPayable(T.A.leader, { cost: [{ op: 'noSuchCost' }] }) === false, 'an unknown cost can\'t be paid');
  expect(T.g.test({ k: 'noSuchCondition' }, ctx) === false, 'an unknown condition is false');
  await T.g.runSteps([{ op: 'draw', n: 1, cond: { k: 'cmp', a: { k: 'noSuchAmount' }, op: '>=', b: 0 } }], ctx);
  expect(T.A.hand.length === 2, 'an unknown amount counts as 0');
  T.g.throwErrors = true;
  let threw = false;
  try { await T.g.runSteps([{ op: 'noSuchStep' }], ctx); } catch { threw = true; }
  expect(threw, 'with throwErrors it throws');
});

// ================================================================
let pass = 0, fail = 0;
for (const t of tests) {
  if (ONLY && !ONLY.test(t.name)) continue;
  try { await t.fn(); pass++; } catch (e) { fail++; console.log(`FAIL ${t.name}: ${e.message}${e.message.startsWith("expected") ? "" : "\n" + (e.stack || "").split("\n").slice(1, 5).join("\n")}`); if (process.env.DEBUG && lastGame) console.log(lastGame.logs.slice(-25).map(l => "    | " + l.text).join("\n")); }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
