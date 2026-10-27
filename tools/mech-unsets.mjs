// Behavioural tests for the Un-set mechanics legal in Commander (src/engine/mech-unsets.js): stickers and tickets,
// Attractions and the junkyard, Contraptions, and dice you may change after rolling.
// Usage: node tools/mech-unsets.mjs [name-filter]
import { setup, expect, run, db } from './lib/testkit.mjs';
import { Game } from '../src/engine/game.js';
import { AIAgent } from '../src/ai/ai.js';
import { matchValid, calcCtx } from '../src/engine/filters.js';
import { analyzeCard } from '../src/engine/support.js';
import { giveStickerSheets, giveAttractionDeck, availableStickers, visitAttractions, rollToVisitAtMain, setupUnsets } from '../src/engine/mech-unsets.js';
import { STICKER_SHEETS, ATTRACTIONS, ATTRACTION_LIGHTS, sheetStickers, stickerSheetsView, unsetsCardInfo, unsetsMissingExtras } from '../src/engine/mech-unsets-rules.js';

const tests = [];
const test = (name, fn, opts) => tests.push({ name, fn, opts });
const SHEETS = ['Ancestral Hot Dog Minotaur', 'Familiar Beeble Mascot', 'Demonic Tourist Laser'];
// sticker ids: <sheet index>/<slot>
const ANCESTRAL = '0/STK1', HOT_DOG = '0/STK2', MINOTAUR = '0/STK3', FLYING = '0/STK8', PT_8_6 = '0/STK10', PT_1_4 = '0/STK9';
const UNTAP_ON_ATTACK = '1/STK7', DIES_TICKETS = '2/STK8';
const sheets = (T, pid = 0, tickets = 0) => { giveStickerSheets(T.game, pid, SHEETS); T.game.players[pid].counters.TICKET = tickets; };
const answer = (T, purpose, ...values) => { const q = [...values]; T.a.on(purpose, () => (q.length ? q.shift() : undefined)); };
// the next d6 results (then the game's own dice again)
function rig(game, ...results) {
  const int = game.rng.int.bind(game.rng);
  const q = [...results];
  game.rng.int = n => (q.length && n === 6 ? q.shift() - 1 : int(n));
}
const deckWith = (names, cmd = 'Llanowar Elves') => ({ name: 'U', commanders: [cmd], cards: [['Forest', 40], ['Island', 30], ...names.map(n => [n, 1])] });
function newGame(decks, seed = 11) {
  const g = new Game({ db, seed, players: decks.map((d, i) => ({ name: 'P' + i, deck: d, agent: new AIAgent() })) });
  g.throwErrors = true;
  return g;
}

// ------------------------------------------------------------ support
test('Every Un-set card in the pool is understood (no unsupported stickers, Attractions, Contraptions or dice)', async () => {
  const re = /Sticker|Attraction|Visit|Prize|Contraption|reroll|roll a die/i;
  const bad = [];
  for (const n of db.names()) { const issues = analyzeCard(db.raw[n]).filter(x => re.test(x)); if (issues.length) bad.push(`${n}: ${issues.join(', ')}`); }
  expect(!bad.length, `no flagged cards (${bad.slice(0, 5).join(' / ')})`);
});
test('Sticker sheets: every sheet has three name, three art, two ability and two power/toughness stickers', async () => {
  expect(STICKER_SHEETS.every(n => db.has(n)), 'every sheet is in the pool');
  for (const n of STICKER_SHEETS) {
    const list = sheetStickers(db.get(n));
    const k = kind => list.filter(s => s.kind === kind).length;
    expect(list.length === 10 && k('Name') === 3 && k('Art') === 3 && k('Ability') === 2 && k('PT') === 2, `${n}: ${list.map(s => s.kind).join(',')}`);
    expect(list.filter(s => s.kind === 'Ability').every(s => s.keywords || s.ability || s.triggers || s.statics), `${n}: its ability stickers do something`);
    expect(list.filter(s => s.kind !== 'Name' && s.kind !== 'Art').every(s => s.tickets > 0), `${n}: ticket costs`);
  }
  expect(ATTRACTIONS.every(n => db.has(n) && db.get(n).faces[0].subtypes.includes('Attraction')), 'every Attraction is in the pool');
});

// ------------------------------------------------------------ game setup
test('Setup: players with sticker cards get three sheets from the seed, players with Attraction cards a ten-card Attraction deck', async () => {
  const a = newGame([deckWith(['Aerialephant', 'Deadbeat Attendant']), deckWith(['Grizzly Bears'])]);
  const b = newGame([deckWith(['Aerialephant', 'Deadbeat Attendant']), deckWith(['Grizzly Bears'])]);
  const P = a.players[0];
  expect(P.stickerSheets.length === 3 && new Set(P.stickerSheets.map(s => s.name)).size === 3, `three different sheets (${P.stickerSheets.map(s => s.name)})`);
  expect(JSON.stringify(P.stickerSheets) === JSON.stringify(b.players[0].stickerSheets), 'the same seed, the same sheets');
  expect(!a.players[1].stickerSheets && !a.players[1].AttractionDeck, 'a player without such cards gets none');
  const deck = P.AttractionDeck;
  expect(deck.length === 10 && new Set(deck.map(c => c.def.name)).size === 10, `ten different Attractions (${deck.length})`);
  expect(deck.every(c => c.zone === 'AttractionDeck' && ATTRACTION_LIGHTS[c.def.name].includes(c.lights.join(' '))), 'each with one of its printings\' lights');
  expect(deck.map(c => c.def.name + c.lights).join() === b.players[0].AttractionDeck.map(c => c.def.name + c.lights).join(), 'the same seed, the same Attraction deck');
  expect(!P.library.some(c => ATTRACTIONS.includes(c.def.name)), 'Attractions are not in the library');
  const c = newGame([deckWith(['Aerialephant']), deckWith(['Grizzly Bears'])], 12);
  expect(JSON.stringify(c.players[0].stickerSheets) !== JSON.stringify(P.stickerSheets) || c.players[0].stickerSheets.length === 3, 'another seed: sheets of its own');
  // the game's own dice / shuffles are untouched by the extra decks
  const plain = newGame([deckWith(['Grizzly Bears']), deckWith(['Grizzly Bears'])]);
  expect(a.rng.s === plain.rng.s, 'the game rng is not used for setup');
});
test('Setup: sticker sheets and Attractions in a deck list are that player\'s sheets and Attraction deck, not library cards', async () => {
  const g = newGame([deckWith(['Ancestral Hot Dog Minotaur', 'Giant Mana Cake', 'Balloon Stand', 'Kiddie Coaster', 'Ride Guide']), deckWith(['Grizzly Bears'])]);
  const P = g.players[0];
  expect(!P.library.some(c => ['Ancestral Hot Dog Minotaur', 'Giant Mana Cake', 'Balloon Stand', 'Kiddie Coaster'].includes(c.def.name)), 'none of them in the library');
  const names = P.stickerSheets.map(s => s.name);
  expect(names.length === 3 && names.includes('Ancestral Hot Dog Minotaur') && names.includes('Giant Mana Cake'), `the brought sheets are used (${names})`);
  const att = P.AttractionDeck.map(c => c.def.name);
  expect(att.length === 10 && att.includes('Balloon Stand') && att.includes('Kiddie Coaster'), `the brought Attractions are in the Attraction deck (${att})`);
});
test('Deck loading: decks with sticker or Attraction cards need the sheets and Attractions loaded', async () => {
  const partial = { has: n => n !== 'Balloon Stand' && db.has(n), get: n => db.get(n) };
  expect(unsetsMissingExtras(partial, [deckWith(['Deadbeat Attendant'])]), 'an Attraction is missing');
  expect(!unsetsMissingExtras(partial, [deckWith(['Grizzly Bears'])]), 'not needed without such cards');
  expect(!unsetsMissingExtras(db, [deckWith(['Deadbeat Attendant', 'Aerialephant'])]), 'all there');
});

// ------------------------------------------------------------ stickers
test('Tickets: Blorbian Buddy gives you {TK}', async T => {
  const b = await T.put(0, 'Blorbian Buddy');
  await T.activate(b);
  expect(T.A.counters.TICKET === 1, `one ticket (${T.A.counters.TICKET})`);
});
test('Ambassador Blorpityblorpboop: three tickets, a power/toughness sticker, then its base P/T from stickers', async T => {
  sheets(T);
  const bear = await T.put(0, 'Grizzly Bears');
  answer(T, 'stickerObject', [bear.id]);
  answer(T, 'sticker', PT_1_4);
  const amb = await T.cast('Ambassador Blorpityblorpboop');
  expect(T.game.chars(bear).power === 1 && T.game.chars(bear).toughness === 4, `the bear is 1/4 (${T.game.chars(bear).power}/${T.game.chars(bear).toughness})`);
  expect(T.A.counters.TICKET === 1, `two of three tickets spent (${T.A.counters.TICKET})`);
  expect(matchValid(T.game, bear, 'Creature.stickeredWith PT', { you: 0 }) && matchValid(T.game, bear, 'Permanent.stickered', { you: 0 }) && !matchValid(T.game, bear, 'Creature.stickeredWith Name', { you: 0 }), 'stickered with a P/T sticker');
  expect(calcCtx(T.game, 'Count$Valid Permanent.YouCtrl$StickerPower', { you: 0, host: amb }) === 1 && calcCtx(T.game, 'Count$Valid Permanent.YouCtrl$StickerToughness', { you: 0, host: amb }) === 4, 'sticker power and toughness counted');
  // a sticker that's on something can't be used again
  expect(!availableStickers(T.game, 0, { noTicketCost: true }).some(s => s.sid === PT_1_4), 'that sticker is used');
  expect(availableStickers(T.game, 0, { kind: 'PT' }).length === 0, 'one ticket buys no P/T sticker');
});
test('Name stickers: a blank is filled; vowels add mana (_____ Goblin); letters count (_____ Balls of Fire)', async T => {
  sheets(T);
  T.a.on('optionalTrigger', () => true);
  answer(T, 'sticker', ANCESTRAL);
  const gob = await T.cast('_____ Goblin', 0, { resolve: false });
  const red = T.A.pool.R;
  await T.resolve();
  expect(T.game.name(gob) === 'Ancestral Goblin', `named (${T.game.name(gob)})`);
  expect(T.A.pool.R === red + 2, `{R}{R} for A and E (${T.A.pool.R - red})`);
  expect(matchValid(T.game, gob, 'Creature.stickeredWith Name', { you: 0 }), 'a name sticker');
  answer(T, 'sticker', HOT_DOG);
  const opp = await T.put(1, 'Grizzly Bears');
  T.a.on('targets', req => req.cands.includes('c' + opp.id) ? ['c' + opp.id] : undefined);
  const balls = await T.cast('_____ Balls of Fire');
  expect(T.game.name(balls) === 'Hot Dog Balls of Fire', `named (${T.game.name(balls)})`);
  expect(opp.zone === 'graveyard', `the two o's in "Hot Dog": 2 damage to the 2/2 (${opp.zone}, damage ${opp.damage})`);
});
test('Name stickers on a full name: the player chooses where the word goes', async T => {
  sheets(T);
  const bear = await T.put(0, 'Grizzly Bears');
  T.a.on('optionalTrigger', () => true);
  answer(T, 'stickerObject', [bear.id]);
  answer(T, 'sticker', MINOTAUR);
  answer(T, 'stickerNamePosition', 2);
  await T.cast('Sword-Swallowing Seraph');
  expect(T.game.name(bear) === 'Grizzly Bears Minotaur', `named (${T.game.name(bear)})`);
  expect(T.logged(/puts the name sticker “Minotaur” on Grizzly Bears/), 'logged');
});
test('Ability stickers: keywords and triggers from the sheet; StickerPlaced triggers (Tusk and Whiskers)', async T => {
  sheets(T, 0, 3);
  const tusk = await T.put(0, 'Tusk and Whiskers');
  const bear = await T.put(0, 'Grizzly Bears');
  answer(T, 'stickerObject', [bear.id]);
  answer(T, 'sticker', FLYING);
  await T.activate(tusk, 0, a => a.parsed.api === 'PutCounter');
  expect(T.game.hasKeyword(bear, 'Flying'), 'the bear flies');
  expect((bear.counters.P1P1 || 0) === 1, `Tusk and Whiskers: +1/+1 counter for an ability sticker (${bear.counters.P1P1})`);
  expect(T.A.counters.TICKET === 1, `3 + 1 - 3 tickets (${T.A.counters.TICKET})`);
  // a triggered ability sticker
  const elf = await T.put(0, 'Llanowar Elves');
  T.A.counters.TICKET = 2;
  answer(T, 'stickerObject', [elf.id]);
  answer(T, 'sticker', UNTAP_ON_ATTACK);
  tusk.tapped = false;
  await T.activate(tusk, 0, a => a.parsed.api === 'PutCounter');
  expect(T.game.chars(elf).triggers.some(t => t.parsed.p.Mode === 'Attacks'), 'the elf has "whenever this creature attacks, untap target permanent"');
});
test('Stickers stay on cards in public zones (and their abilities work there), and come off in hidden zones', async T => {
  sheets(T, 0, 5);
  const bear = await T.put(0, 'Grizzly Bears');
  answer(T, 'stickerObject', [bear.id]);
  answer(T, 'sticker', DIES_TICKETS);
  await T.cast('Bioluminary', 0, { resolve: true }).catch(() => null);
  // put it directly with the ability of Prize Wall instead (Bioluminary needs combat damage)
  const wall = await T.put(0, 'Prize Wall');
  T.A.counters.TICKET = 3;
  await T.activate(wall, 0, a => a.parsed.api === 'PutSticker');
  expect((bear.stickers || []).length === 1, 'the sticker is on the bear');
  await T.game.destroy(bear, null); await T.resolve();
  expect(bear.zone === 'graveyard' && bear.stickers.length === 1, 'still stickered in the graveyard');
  expect(T.A.counters.TICKET === 7, `"when this permanent dies, you get seven {TK}" (${T.A.counters.TICKET})`);
  expect(!availableStickers(T.game, 0, { noTicketCost: true }).some(s => s.sid === DIES_TICKETS), 'still in use');
  await T.game.moveCard(bear, 'hand');
  expect(!bear.stickers, 'no stickers in hand');
  expect(availableStickers(T.game, 0, { noTicketCost: true }).some(s => s.sid === DIES_TICKETS), 'the sticker can be used again');
});
test('StickerPlaced: Wee Champion (+1/+1, or a counter for an art sticker) and Goblin Airbrusher (Treasures)', async T => {
  sheets(T);
  const wee = await T.put(0, 'Wee Champion');
  await T.put(0, 'Goblin Airbrusher');
  T.a.on('optionalTrigger', () => true);
  answer(T, 'stickerObject', [wee.id]);
  answer(T, 'sticker', '0/STK4');
  await T.cast('Proficient Pyrodancer');
  expect((wee.counters.P1P1 || 0) === 1, `art sticker: a +1/+1 counter (${wee.counters.P1P1})`);
  expect(T.tokens(0).filter(c => T.game.chars(c).subtypes.has('Treasure')).length === 2, 'two Treasures for an art sticker');
  answer(T, 'sticker', HOT_DOG);
  await T.cast('_____ Goblin');
  expect(T.game.chars(wee).power === 2, `name sticker: +1/+1 until end of turn (${T.game.chars(wee).power})`);
  expect(T.tokens(0).filter(c => T.game.chars(c).subtypes.has('Treasure')).length === 3, 'one Treasure for a name sticker');
});
test('A Good Day to Pie returns from the graveyard when you put a name sticker on a creature', async T => {
  sheets(T);
  const pie = await T.put(0, 'A Good Day to Pie', 'graveyard');
  T.a.on('optionalTrigger', () => true);
  answer(T, 'sticker', HOT_DOG);
  await T.cast('_____ Goblin');
  expect(pie.zone === 'hand', `back in hand (${pie.zone})`);
});
test('Vowels and "when you do": Wizards of the _____ digs, Wolf in _____ Clothing shrinks, _____-o-saurus grows', async T => {
  sheets(T);
  T.a.on('optionalTrigger', () => true);
  answer(T, 'sticker', ANCESTRAL, HOT_DOG, MINOTAUR);
  const hand = T.A.hand.length;
  const wiz = await T.cast('Wizards of the _____');
  expect(T.game.name(wiz) === 'Wizards of the Ancestral' && T.A.hand.length === hand + 1, `named and a card from the top two (${T.game.name(wiz)}, hand ${T.A.hand.length - hand})`);
  const opp = await T.put(1, 'Llanowar Elves'), opp2 = await T.put(1, 'Wall of Omens');
  T.a.on('targets', req => req.cands.filter(r => r === 'c' + opp.id || r === 'c' + opp2.id));
  await T.cast('Wolf in _____ Clothing');
  expect(opp.zone === 'graveyard' && T.game.chars(opp2).toughness === 4, `Hot Dog (one vowel): only one creature gets -1/-1 (${opp.zone}, wall ${T.game.chars(opp2).toughness})`);
  const dino = await T.cast('_____-o-saurus');
  expect(T.game.name(dino) === 'Minotaur-o-saurus' && dino.counters.P1P1 === 4, `I, O, A, U: four counters (${T.game.name(dino)}, ${dino.counters.P1P1})`);
});
test('Fight the _____ Fight: an Aura named by a sticker, toughness for long names, and a fight', async T => {
  sheets(T);
  const bear = await T.put(0, 'Grizzly Bears');
  const opp = await T.put(1, 'Llanowar Elves');
  answer(T, 'sticker', ANCESTRAL);
  T.a.on('targets', req => (req.cands.includes('c' + opp.id) ? ['c' + opp.id] : req.cands.includes('c' + bear.id) ? ['c' + bear.id] : undefined));
  const aura = await T.cast('Fight the _____ Fight');
  expect(T.game.name(aura) === 'Fight the Ancestral Fight', `named (${T.game.name(aura)})`);
  expect(aura.attachedTo === bear.id && T.game.chars(bear).toughness === 2 + 2, `+0/+2 for a name sticker of eight or more letters (${T.game.chars(bear).toughness})`);
  expect(opp.zone === 'graveyard', `the bear fought the elf (${opp.zone})`);
});
test('Clandestine Chameleon has the abilities of ability stickers on your other permanents and graveyard cards', async T => {
  sheets(T, 0, 3);
  const bear = await T.put(0, 'Grizzly Bears');
  bear.stickers = [{ sid: FLYING, sheet: SHEETS[0], slot: 'STK8', kind: 'Ability', keywords: 'Flying', text: 'Flying', tickets: 3, ts: 1, owner: 0 }];
  T.game.touch();
  T.a.on('sticker', req => 'none');
  const cham = await T.cast('Clandestine Chameleon');
  expect(T.game.hasKeyword(cham, 'Flying'), 'flying from the bear\'s sticker');
  await T.game.destroy(bear, null); await T.resolve();
  expect(T.game.hasKeyword(cham, 'Flying'), 'still, from the graveyard');
});
test('Pin Collection: an ability sticker with ticket cost X or less for free, given to the equipped creature', async T => {
  sheets(T, 0, 0);
  answer(T, 'sticker', FLYING);
  T.game.players[0].pool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
  const pin = await T.cast('Pin Collection', 0, { action: { x: 3 } });
  expect((pin.stickers || []).length === 1 && T.A.counters.TICKET === 0, `the Flying sticker for free (${(pin.stickers || []).length})`);
  const bear = await T.put(0, 'Grizzly Bears');
  pin.attachedTo = bear.id; T.game.touch();
  expect(T.game.hasKeyword(bear, 'Flying') && T.game.chars(bear).power === 3, 'equipped: +1/+1 and flying');
});
test('Scampire: a sticker on a creature card in your graveyard, then back to the battlefield', async T => {
  sheets(T);
  const dead = await T.put(0, 'Serra Angel', 'graveyard');
  answer(T, 'stickerObject', [dead.id]);
  answer(T, 'sticker', '0/STK5');
  const sc = await T.cast('Scampire');
  expect((dead.stickers || []).length === 1 && T.A.counters.TICKET === 1, 'an art sticker on the graveyard card');
  T.a.on('targets', req => (req.cands.includes('c' + dead.id) ? ['c' + dead.id] : undefined));
  await T.activate(sc, 0, a => a.parsed.api === 'ChangeZone');
  expect(dead.zone === 'battlefield' && T.game.hasKeyword(dead, 'Haste') && dead.stickers.length === 1, `back with haste and its sticker (${dead.zone})`);
});
test('Optional stickers can be declined; mandatory ones can\'t; Roxi counts art stickers; Big Winner has trample', async T => {
  sheets(T);
  const bear = await T.put(0, 'Grizzly Bears');
  T.a.on('sticker', req => (req.options.some(o => o.value === 'none') ? 'none' : undefined));
  const winner = await T.put(0, 'Big Winner');
  await T.cast('Aerialephant');
  expect(!(bear.stickers || []).length && T.A.counters.TICKET === 1, 'declined');
  expect(!T.game.hasKeyword(winner, 'Trample'), 'no stickered permanent yet');
  T.a.on('sticker', () => undefined);
  answer(T, 'stickerObject', [bear.id], [winner.id]);
  const roxi = await T.cast('Roxi, Publicist to the Stars');
  const arts = T.game.battlefield.filter(c => (c.stickers || []).some(s => s.kind === 'Art')).length;
  expect(arts === 2 && T.game.chars(roxi).power === 2, `two art stickers: Roxi is 2/4 (${arts}, ${T.game.chars(roxi).power})`);
  expect(T.game.hasKeyword(winner, 'Trample'), 'Big Winner: trample with a stickered permanent');
});
test('_____ _____ Rocketship: two name stickers, letter choice on attack', async T => {
  sheets(T);
  answer(T, 'sticker', HOT_DOG, '1/STK2');
  const ship = await T.cast('_____ _____ Rocketship');
  expect(T.game.name(ship) === 'Hot Dog Beeble Rocketship', `named (${T.game.name(ship)})`);
  expect(calcCtx(T.game, 'Count$CardStickers.Name', { you: 0, host: ship }) === 2, 'two name stickers');
  ship.chosen = { type: 'H' };
  expect(calcCtx(T.game, 'Count$CardStickers.NameStartsWith.ChosenType', { you: 0, host: ship }) === 1, 'one begins with H');
});
test('Card view: stickers and lights are shown, and the sheets with what\'s used', async T => {
  sheets(T, 0, 2);
  const bear = await T.put(0, 'Grizzly Bears');
  bear.stickers = [{ sid: HOT_DOG, sheet: SHEETS[0], slot: 'STK2', kind: 'Name', word: 'Hot Dog', ts: 1, pos: 0, owner: 0 }];
  T.game.touch();
  const info = unsetsCardInfo(T.game, bear);
  expect(info && /“Hot Dog” \(name\)/.test(info.text), `sticker text (${info && info.text})`);
  const v = stickerSheetsView(T.game, 0);
  expect(v.tickets === 2 && v.sheets.length === 3 && v.sheets[0].stickers.find(s => s.slot === 'STK2').used, 'the sheet view marks it used');
});

// ------------------------------------------------------------ Attractions
const attractions = (T, pid, list) => giveAttractionDeck(T.game, pid, list);
test('Open an Attraction: the top of the Attraction deck enters; The Most Dangerous Gamer grows', async T => {
  attractions(T, 0, [['Information Booth', '2 6'], ['Kiddie Coaster', '3 4 6'], ['Fortune Teller', '2 3 6']]);
  const gamer = await T.put(0, 'The Most Dangerous Gamer');
  await T.resolve(); // "whenever it enters or attacks, open an Attraction"
  await T.cast('Deadbeat Attendant');
  const booth = T.game.battlefield.find(c => c.def.name === 'Information Booth');
  expect(booth && booth.controller === 0 && T.game.battlefield.some(c => c.def.name === 'Kiddie Coaster') && T.A.AttractionDeck.length === 1, 'two opened');
  expect((gamer.counters.P1P1 || 0) === 2, `a +1/+1 counter for each (${gamer.counters.P1P1})`);
  expect(unsetsCardInfo(T.game, booth).lights.join() === '2,6', 'its lights');
  await T.cast('Step Right Up');
  expect(T.A.AttractionDeck.length === 0 && T.logged(/has no Attraction to open/), 'Step Right Up: one left to open, then none');
});
test('Roll to visit at the beginning of the precombat main phase: lit numbers visit; Visit abilities trigger', async T => {
  attractions(T, 0, [['Information Booth', '2 6'], ['Roller Coaster', '3 6']]);
  await T.cast('Step Right Up');
  const bear = await T.put(0, 'Grizzly Bears');
  const hand = T.A.hand.length;
  rig(T.game, 6);
  await rollToVisitAtMain(T.game, 0);
  await T.resolve();
  expect(T.A.hand.length === hand + 1, `Information Booth: draw (${T.A.hand.length - hand})`);
  expect(T.game.chars(bear).power === 4, `Roller Coaster: +2/+0 (${T.game.chars(bear).power})`);
  expect(calcCtx(T.game, 'PlayerCountPropertyYou$AttractionsVisitedThisTurn', { you: 0 }) === 2, 'two visited this turn');
  rig(T.game, 3);
  await rollToVisitAtMain(T.game, 0);
  expect(calcCtx(T.game, 'PlayerCountPropertyYou$AttractionsVisitedThisTurn', { you: 0 }) === 2, 'visiting one again doesn\'t count it twice');
  rig(T.game, 4);
  const before = T.game.pendingTriggers.length;
  await rollToVisitAtMain(T.game, 1);
  expect(T.game.pendingTriggers.length === before, 'no Attractions: no roll');
});
test('The junkyard: Attractions that would go to a graveyard, hand or library go there instead', async T => {
  attractions(T, 0, [['Information Booth', '2 6'], ['Clown Extruder', '4 6'], ['Fortune Teller', '2 3 6']]);
  await T.cast('Step Right Up');
  const [a, b] = T.game.battlefield.filter(c => c.attraction);
  await T.game.destroy(a, null);
  await T.game.moveCard(b, 'hand');
  expect(a.zone === 'Junkyard' && b.zone === 'Junkyard' && T.A.Junkyard.length === 2 && !T.A.graveyard.includes(a), `junkyard (${a.zone}, ${b.zone})`);
  // Draconian Gate-Bot: destroy target Attraction
  await T.cast('Coming Attraction');
  const c = T.game.battlefield.find(x => x.attraction);
  T.a.on('modes', req => [req.options[1].value]);
  T.a.on('targets', req => (req.cands.includes('c' + c.id) ? ['c' + c.id] : undefined));
  await T.cast('Draconian Gate-Bot');
  expect(c.zone === 'Junkyard', `destroyed into the junkyard (${c.zone})`);
});
test('Pick-a-Beeble: luck counters, a Treasure, and at six or more claim the prize (The Most Dangerous Gamer destroys)', async T => {
  attractions(T, 0, [['Pick-a-Beeble', '2 3 6'], ['Information Booth', '2 6']]);
  await T.put(0, 'The Most Dangerous Gamer');
  const victim = await T.put(1, 'Serra Angel');
  T.a.on('targets', req => (req.cands.includes('c' + victim.id) ? ['c' + victim.id] : undefined));
  await T.cast('Deadbeat Attendant');
  const beeble = T.game.battlefield.find(c => c.def.name === 'Pick-a-Beeble');
  rig(T.game, 4);
  await visitAttractions(T.game, 0, 3);
  await T.resolve();
  expect(beeble.counters.LUCK === 4 && T.tokens(0).filter(c => T.game.chars(c).subtypes.has('Treasure')).length === 1, `four luck counters and a Treasure (${beeble.counters.LUCK})`);
  rig(T.game, 5);
  await visitAttractions(T.game, 0, 3);
  await T.resolve();
  expect(beeble.zone === 'Junkyard', `prize claimed: sacrificed into the junkyard (${beeble.zone})`);
  expect(T.tokens(0).filter(c => T.game.chars(c).subtypes.has('Treasure')).length === 4, 'two more Treasures from the prize');
  expect(T.game.battlefield.some(c => c.def.name === 'Information Booth'), 'and opened another Attraction');
  expect(victim.zone === 'graveyard', `The Most Dangerous Gamer destroyed a permanent (${victim.zone})`);
});
test('Visited this turn: Soul Swindler indestructible, Squirrel Squatters\' squirrels, Black Hole\'s extra targets', async T => {
  attractions(T, 0, [['Fortune Teller', '2 3 6']]);
  const sw = await T.put(0, 'Soul Swindler');
  await T.cast('Step Right Up');
  expect(!T.game.hasKeyword(sw, 'Indestructible'), 'not yet');
  await visitAttractions(T.game, 0, 2);
  await T.resolve();
  expect(T.game.hasKeyword(sw, 'Indestructible'), 'indestructible after a visit');
});
test('Rolled to visit: "Lifetime" Pass Holder returns on a 6 (and only then); Complaints Clerk only on a 1', async T => {
  const pass = await T.put(0, '"Lifetime" Pass Holder', 'graveyard');
  const clerk = await T.put(0, 'Complaints Clerk');
  T.a.on('optionalTrigger', () => true);
  const { rollDice } = await import('../src/engine/abilities.js');
  rig(T.game, 6);
  await rollDice(T.game, 0, 1, 6, 0, null);
  await T.resolve();
  expect(pass.zone === 'graveyard', 'a 6 that isn\'t a roll to visit');
  expect(!T.tokens(0).length, 'Complaints Clerk: no token on a 6');
  rig(T.game, 6);
  await rollDice(T.game, 0, 1, 6, 0, null, { toVisit: true });
  await T.resolve();
  expect(pass.zone === 'battlefield', `back on a 6 rolled to visit (${pass.zone})`);
  rig(T.game, 1);
  await rollDice(T.game, 0, 1, 6, 0, null);
  await T.resolve();
  expect(T.tokens(0).length === 1, 'a Clown Robot on a 1');
  expect(clerk.zone === 'battlefield', 'clerk');
});
test('Line Cutter rolls to visit; Motion Sickness moves when you visit', async T => {
  attractions(T, 0, [['Information Booth', '2 6']]);
  await T.cast('Step Right Up');
  const opp = await T.put(1, 'Serra Angel'), opp2 = await T.put(1, 'Wall of Omens');
  opp2.tapped = true;
  T.a.on('targets', req => (req.cands.includes('c' + opp.id) ? ['c' + opp.id] : req.cands.includes('c' + opp2.id) ? ['c' + opp2.id] : undefined));
  const ms = await T.cast('Motion Sickness');
  expect(ms.attachedTo === opp.id && opp.tapped, 'on the angel, tapping it');
  T.a.on('optionalTrigger', () => true);
  T.a.on('targets', req => (req.cands.includes('c' + opp2.id) ? ['c' + opp2.id] : undefined));
  rig(T.game, 2);
  const hand = T.A.hand.length;
  await T.cast('Line Cutter');
  expect(T.logged(/rolls a d6 to visit Attractions: 2/), 'rolled to visit');
  expect(T.A.hand.length === hand + 1, 'visited Information Booth');
  expect(ms.attachedTo === opp2.id, `Motion Sickness moved to the tapped wall (${ms.attachedTo})`);
});

// ------------------------------------------------------------ dice
test('Night Shift of the Living Dead: pay 1 life to turn a 5 into a 6 (a Zombie), once each turn', async T => {
  await T.put(0, 'Night Shift of the Living Dead');
  const { rollDice } = await import('../src/engine/abilities.js');
  answer(T, 'dieModify', 1, 1);
  const life = T.A.life;
  rig(T.game, 5);
  const r = await rollDice(T.game, 0, 1, 6, 0, null);
  await T.resolve();
  expect(r.total === 6 && T.A.life === life - 1, `5 → 6 for 1 life (${r.total}, ${life - T.A.life})`);
  expect(T.tokens(0).length === 1, 'a Zombie Employee');
  rig(T.game, 5);
  const r2 = await rollDice(T.game, 0, 1, 6, 0, null);
  expect(r2.total === 5, 'only once each turn');
  T.game.turnNumber++;
  T.a.on('dieModify', () => -1);
  rig(T.game, 5);
  const r3 = await rollDice(T.game, 0, 1, 6, 0, null);
  expect(r3.total === 4, `next turn: down by one (${r3.total})`);
});
test('Xenosquirrels: remove a +1/+1 counter to change a roll by 1, as often as it has counters', async T => {
  const x = await T.cast('Xenosquirrels');
  expect(x.counters.P1P1 === 2, 'enters with two counters');
  const { rollDice } = await import('../src/engine/abilities.js');
  T.a.on('dieModify', () => 1);
  rig(T.game, 2, 3);
  const r = await rollDice(T.game, 0, 2, 6, 0, null);
  expect(r.rolls.join() === '3,4' && x.counters.P1P1 === 0, `both dice up by one (${r.rolls}, ${x.counters.P1P1})`);
  await T.resolve();
  expect(x.zone === 'graveyard', 'a 0/0 with no counters dies');
});
test('Monitor Monitor: pay {1} to reroll, once each turn; the AI rerolls a visit roll that lights nothing', async T => {
  attractions(T, 0, [['Information Booth', '2 6']]);
  await T.cast('Monitor Monitor');
  expect(T.game.battlefield.some(c => c.def.name === 'Information Booth'), 'it opened an Attraction');
  const { rollDice } = await import('../src/engine/abilities.js');
  T.mana(0, 1);
  rig(T.game, 3, 6);
  const hand = T.A.hand.length;
  const r = await rollDice(T.game, 0, 1, 6, 0, null, { toVisit: true });
  await T.resolve();
  expect(r.total === 6 && T.A.hand.length === hand + 1, `the AI rerolled a 3 into a 6 and visited (${r.total})`);
  const spent = Object.values(T.A.pool).reduce((a, b) => a + b, 0);
  expect(spent === 5, `{1} paid (${spent} left of 6)`);
  rig(T.game, 3, 6);
  const r2 = await rollDice(T.game, 0, 1, 6, 0, null, { toVisit: true });
  expect(r2.total === 3, 'only once each turn');
});

// ------------------------------------------------------------ Contraptions
test('Steamflogger Boss: other Riggers get +1/+0 and haste; there are no Contraptions to assemble', async T => {
  await T.put(0, 'Steamflogger Boss');
  const rig2 = await T.put(0, 'Steamflogger Boss');
  expect(T.game.chars(rig2).power === 4 && T.game.hasKeyword(rig2, 'Haste'), 'the other Boss is a Rigger: 4/3 with haste');
  const { makeSA, resolveChain } = await import('../src/engine/abilities.js');
  await resolveChain(T.game, makeSA(T.game, 'DB$ AssembleContraption', {}, rig2, 0));
  expect(T.logged(/has no Contraption to assemble/), 'nothing to assemble');
});

// ------------------------------------------------------------ whole games
test('AI games with sticker and Attraction decks run to the end without errors, the same way twice', async () => {
  const deck = deckWith(['Aerialephant', 'Ambassador Blorpityblorpboop', 'Glitterflitter', 'Minotaur de Force', 'Ticketomaton', '_____ Goblin', 'Wizards of the _____', 'Deadbeat Attendant', 'Ride Guide', 'Petting Zookeeper', 'Monitor Monitor', 'Night Shift of the Living Dead', 'Step Right Up', 'Wee Champion', 'Prize Wall', 'Blorbian Buddy', 'Tusk and Whiskers', 'Command Performance', 'Squirrel Squatters', 'Rad Rascal', 'Soul Swindler', 'Xenosquirrels'], 'Myra the Magnificent');
  const play = async seed => {
    const g = new Game({ db, seed, maxTurns: 14, players: [deck, deck].map((d, i) => ({ name: 'P' + i, deck: d, agent: new AIAgent() })) });
    g.throwErrors = true;
    await g.start();
    return g;
  };
  for (const seed of [3, 4]) {
    const g = await play(seed), h = await play(seed);
    expect(!g.error, `no engine error (${g.error && g.error.message})`);
    expect(g.logs.map(l => l.text).join('\n') === h.logs.map(l => l.text).join('\n'), 'deterministic');
  }
});

process.exit(await run(tests) ? 1 : 0);
