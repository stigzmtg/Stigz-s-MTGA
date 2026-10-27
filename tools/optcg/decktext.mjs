// Unit checks for the One Piece deck builder's lists and rules (src/optcg/ui/decktext.js, mydecks.js): pasted lists in
// every format people share (OPTCGSim / Egman "4xOP01-016", Limitless "4 Nami OP01-016", "4 Nami (OP01-016)", plain
// "4 Nami"), the Leader however it's marked, typos, names several cards share, cards the game doesn't have, the 4-copy
// limit; every starter deck written out and read back; the rules check; the compact form rooms and replays carry.
// Usage: node tools/optcg/decktext.mjs
import { parseDeckList, resolveList, deckToText, normNumber, normName, findName, countCards } from '../../src/optcg/ui/decktext.js';
import { packDeck, unpackDeck, rulesCheck, deckReady, isCustomId, asDeck } from '../../src/optcg/ui/mydecks.js';
import { loadDb, loadDecks, loadPlayableDecks } from './lib.mjs';

const cards = loadDb();
let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('FAIL', msg, extra !== undefined ? JSON.stringify(extra) : ''); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg, { got: a, want: b });
const read = (t, ctx) => parseDeckList(t, cards, ctx);
const list = r => [...r.cards].sort((a, b) => a[0].localeCompare(b[0]));
const sorted = l => l.slice().sort((a, b) => a[0].localeCompare(b[0]));

// ---- card numbers and names
eq([normNumber('op1-16'), normNumber('OP01-016'), normNumber('st01-1'), normNumber('P-1'), normNumber('EB01-001'), normNumber('OP01016'), normNumber('nami'), normNumber('P001')], ['OP01-016', 'OP01-016', 'ST01-001', 'P-001', 'EB01-001', 'OP01-016', null, null], 'card numbers however they are written');
eq([normName('Monkey.D.Luffy'), normName('Monkey D. Luffy'), normName('Eustass"Captain"Kid'), normName('Ace & Newgate')], ['monkey d luffy', 'monkey d luffy', 'eustass captain kid', 'ace and newgate'], 'names whatever their dots and quotes');
eq(findName('Guard Pont', cards), { keys: ['guard point'], fixed: true }, 'a typo is read as the closest name');
eq(findName('Mr.3', cards).keys, ['mr 3 galdino'], 'a name without its part in brackets');
eq(findName('Nami (Parallel)', cards).keys, ['nami'], 'a name with an art note in brackets');
ok(!findName('Zzyzx Qwerty', cards).keys.length, 'gibberish is not a card');

// ---- every format people share, for one card
const FORMATS = ['4xOP01-016', '4x OP01-016', '4 x OP01-016', '4 OP01-016', '4X op01-16', 'OP01-016 x4', '4xOP01-016_p1', '4 OP01-016-P1', '4 Nami (OP01-016)', '4 Nami [OP01-016]', '4 OP01-016 Nami', '4x Nami - OP01-016', '4 Nami OP01-016', 'Nami OP01-016 x4', '4 Nami (OP01-016) (Parallel)'];
for (const f of FORMATS) {
  const r = read(f);
  eq(list(r), [['OP01-016', 4]], `"${f}" is 4 OP01-016`);
  ok(!r.missing.length && !r.ambiguous.length, `"${f}" has nothing missing or to ask`);
}

// ---- every starter deck, written out and read back (an Ultra Deck with each of its Leaders)
for (const d of loadPlayableDecks(cards)) {
  const text = deckToText(d, cards);
  ok(text.split('\n')[0] === `1x${d.leader}`, `${d.id}: the Leader comes first`);
  ok(text.split('\n').slice(1).every(l => /^[1-4]x[A-Z]+\d*-\d{3}$/.test(l)), `${d.id}: every line is "4xOP01-016"`);
  const r = read(text);
  eq([r.leader, list(r)], [d.leader, sorted(d.cards)], `${d.id}: read back exactly`);
  ok(deckReady({ ...d, cards: d.cards }, cards), `${d.id}: passes the rules`);
}
// the same lists as Limitless writes them ("4 Name NUMBER"), with headings, and as plain names where that's enough
const st01 = loadDecks().find(d => d.id === 'st01');
const limitless = ['Leader', `1 ${cards[st01.leader].name} ${st01.leader}`, '', 'Characters (40)', ...st01.cards.filter(([k]) => cards[k].cat === 'C').map(([k, n]) => `${n} ${cards[k].name} ${k}`), '', 'Events (8)', ...st01.cards.filter(([k]) => cards[k].cat !== 'C').map(([k, n]) => `${n} ${cards[k].name} ${k}`), '', 'DON!! (10)', '10 DON!! Card'].join('\n');
{
  const r = read(limitless);
  eq([r.leader, list(r)], [st01.leader, sorted(st01.cards)], 'a Limitless-style list with headings and DON!!');
  ok(r.skipped > 0, 'DON!! cards are left out');
}

// ---- the Leader
eq(read('1xST01-001\n4xOP01-016').leader, 'ST01-001', 'a "1x" Leader line');
eq(read('Leader: Monkey.D.Luffy (ST01-001)\n4xOP01-016').leader, 'ST01-001', '"Leader:" with a number');
eq(read('Leader: Uta\n4xST11-002').leader, 'ST11-001', '"Leader:" with a name only one Leader has');
eq(read('1 Crocodile\n4 Crocodile (ST03-003)\n4xST03-004').leader, 'ST03-001', 'a list of names: its first line names the Leader');
{
  const r = read('Leader\n1 Monkey.D.Luffy\n\nMain deck\n4xOP01-016\n4xST01-014');
  eq([r.leader, r.leaderOptions], [null, ['ST01-001', 'ST10-002', 'ST21-001']], 'a name several Leaders share: the ones in the list\'s colors are asked about');
  eq(resolveList(r, { leader: 'ST21-001' }).leader, 'ST21-001', 'and the one picked leads');
}
{
  const r = read('1xST01-001\n1xST02-001\n4xOP01-016');
  eq([r.leader, r.extraLeaders, list(r)], ['ST01-001', ['ST02-001'], [['OP01-016', 4]]], 'one Leader per deck: a second one is left out');
}
ok(!read('4xOP01-016\n4xST01-014').leader, 'a list with no Leader has none');

// ---- names several cards share
{
  const r = read('1xST01-001\n4 Nami');
  eq(r.ambiguous.map(a => [a.label, a.n, a.options]), [['Nami', 4, ['OP01-016', 'ST01-007', 'ST21-009']]], 'six Namis, three of them Red: those are asked about');
  eq(list(resolveList(r, { picks: new Map([[r.ambiguous[0].key, 'OP01-016']]) })), [['OP01-016', 4]], 'the one picked goes in');
  eq(countCards(resolveList(r, { picks: new Map([[r.ambiguous[0].key, 'none']]) }).cards), 0, '"Leave it out" leaves it out');
}
eq(list(read('2 Nami', { leader: 'ST01-001', prefer: new Map([['OP01-016', 2]]) })), [['OP01-016', 2]], 'the Nami already in your deck, when adding');
eq(read('2 Nami', { leader: 'ST01-001', prefer: new Map([['OP01-016', 4]]) }).ambiguous.length, 1, 'but not when your deck already has 4 of it');
eq(list(read('1xST01-001\n2xST01-007\n2 Nami')), [['ST01-007', 4]], 'the Nami already in the list, when the copies fit');
eq(read('1xST01-001\n4xST01-007\n4 Nami').ambiguous.length, 1, 'but not when the list already has 4 of it');
eq(list(read('1xST03-001\n4 Nefeltari Vivi')), [], 'a name with no card in the Leader\'s colors...');
eq(read('1xST03-001\n4 Nefeltari Vivi').ambiguous[0].options, ['ST01-009', 'ST08-007'], '...asks among all of them');
eq(list(read('1xST01-001\n4 Nefeltari Vivi')), [['ST01-009', 4]], 'a name with one card in the Leader\'s colors is that card');
eq(list(read('1xST04-001\n4 X.Drake')), [['ST04-013', 4]], '"4 X.Drake": the X is part of the name, not "4x"');
{
  const r = read('1xST01-001\n2 Zoro');
  ok(r.ambiguous.length === 1 && r.ambiguous[0].options.includes('OP01-025') && r.ambiguous[0].options.every(id => cards[id].colors.includes('Red')), 'a short name ("Zoro") asks among the Red Zoros', r.ambiguous);
}

// ---- typos and cards the game doesn't have
{
  const r = read('1xST01-001\n4 Guard Pont\n4 Nmai\n2xOP99-001\n1 Shanks (OP99-002)\n3 Zzyzx Qwerty');
  eq(r.fixed, [{ from: 'Guard Pont', to: 'Guard Point' }, { from: 'Nmai', to: 'Nami' }], 'typos are read as the closest name');
  eq(r.cards.get('ST01-014'), 4, 'Guard Pont is Guard Point');
  eq(r.ambiguous.map(a => a.label), ['Nami'], 'Nmai is a Nami, which one is asked');
  eq(r.missing.map(m => [m.label, m.n]), [['OP99-001', 2], ['Shanks (OP99-002)', 1], ['Zzyzx Qwerty', 3]], 'cards the game doesn\'t have');
  eq(r.missing[1].suggestions[0], 'ST23-002', 'a missing card\'s suggestions start with its name in the Leader\'s colors');
  eq(resolveList(r, { swaps: new Map([['Shanks (OP99-002)', 'ST23-002']]) }).cards.get('ST23-002'), 1, 'a suggestion can be used instead');
}

// ---- the 50: copies, Leaders, lines that add up, the bits around the cards
{
  const r = read('Name: Red Rush\n// made in OPTCGSim\n1xST01-001\n5xST01-012\n2xOP01-016\n2xOP01-016\nTotal: 50\n4 Uta');
  eq(r.name, 'Red Rush', 'the deck\'s name');
  eq([r.cards.get('ST01-012'), r.clamped], [4, ['ST01-012']], 'up to 4 of each card number');
  eq(r.cards.get('OP01-016'), 4, 'lines for the same card add up');
  ok(!r.ambiguous.length && r.cards.get('ST23-001') === 4 && !r.leadersOut.length, 'Uta in a Red deck is the Red Uta, not the Leader', [...r.cards]);
}
eq(read('Red Luffy aggro\n1xST01-001\n4xOP01-016').name, 'Red Luffy aggro', 'a first line that isn\'t a card is the deck\'s name');
eq(read('1xST01-001\n4xST02-001').extraLeaders, ['ST02-001'], 'a Leader in the 50 is left out');
eq(read('1xST11-001\n4 Kaido').ambiguous[0].options.length >= 1, true, 'no Kaido in Green: all of them are asked about');

// ---- written out
{
  const t = deckToText({ leader: 'ST01-001', cards: [['ST01-014', 2], ['OP01-016', 4], ['ST01-012', 3]] }, cards);
  eq(t, '1xST01-001\n4xOP01-016\n2xST01-014\n3xST01-012', 'the Leader, then the 50 by cost, as "4xOP01-016"');
}

// ---- the rules check
const mine = { id: 'opd-test1234', name: 'Mine', leader: st01.leader, cards: st01.cards.map(e => e.slice()) };
ok(rulesCheck(mine, cards).every(r => r.ok), 'a starter deck\'s list passes every rule');
const fails = d => rulesCheck(d, cards).filter(r => !r.ok).map(r => r.id);
eq(fails({ ...mine, leader: null }), ['leader', 'colors'], 'no Leader');
eq(fails({ ...mine, cards: [...mine.cards.slice(1), [mine.cards[0][0], mine.cards[0][1] - 1]] }), ['size'], '49 cards');
ok(/49 of 50: 1 more to go/.test(rulesCheck({ ...mine, cards: [...mine.cards.slice(1), [mine.cards[0][0], mine.cards[0][1] - 1]] }, cards).find(r => r.id === 'size').text), 'and says how many more, in words');
eq(fails({ ...mine, cards: [...mine.cards.slice(1), [mine.cards[0][0], 5]] }), ['size', 'copies'], '5 copies');
eq(fails({ ...mine, cards: [...mine.cards.slice(1), ['ST02-002', 4]] }), ['colors'], 'a Green card with a Red Leader');
ok(/Not Red: /.test(rulesCheck({ ...mine, cards: [...mine.cards.slice(1), ['ST02-002', 4]] }, cards).find(r => r.id === 'colors').text), 'names the card that isn\'t Red');
eq(fails({ ...mine, cards: [...mine.cards.slice(1), ['ST21-001', 4]] }), ['leaders'], 'a Leader in the 50');
eq(fails({ ...mine, cards: [...mine.cards.slice(1), ['OP99-001', 4]] }), ['unknown'], 'a card the game doesn\'t have');
ok(rulesCheck({ ...mine, leader: 'ST10-002' }, cards).every(r => r.ok), 'a two-color Leader: cards of either color');

// ---- the compact form rooms, battle configs and replays carry
{
  const p = packDeck(mine);
  ok(JSON.stringify(p).length < 400, `a 50-card deck packs small (${JSON.stringify(p).length} characters)`);
  eq(unpackDeck(JSON.parse(JSON.stringify(p))), { id: mine.id, name: mine.name, leader: mine.leader, cards: mine.cards }, 'and unpacks to the same deck, in the same order');
  ok(unpackDeck({ ...p, i: 'custom-abc123' }) === null && unpackDeck({ ...p, c: 'OP01-016*99' }) === null && unpackDeck({ ...p, l: 'not a card' }) === null && unpackDeck(null) === null, 'bad packs are refused');
  ok(isCustomId('opd-k2x9q4ab') && !isCustomId('st01') && !isCustomId('st13@ST13-001'), 'your decks\' ids');
  eq(asDeck(cards, mine).colors, ['Red'], 'a deck takes its Leader\'s colors');
}

// ---- save codes carry your decks (src/ui/savecode.js): both devices' combined, the newest version of each, a deleted one gone
{
  globalThis.window ??= new EventTarget();
  globalThis.location ??= { protocol: 'http:', hostname: 'localhost', port: '1', origin: 'http://localhost:1' };
  const S = await import('../../src/ui/savecode.js');
  const a = { 'op-custom-decks': JSON.stringify([{ id: 'opd-aaaa1', name: 'A', updated: 5 }, { id: 'opd-cccc1', name: 'C old', updated: 1 }]) };
  const b = { 'op-custom-decks': JSON.stringify([{ id: 'opd-cccc1', name: 'C new', updated: 9 }, { id: 'opd-dddd1', name: 'D', updated: 2 }]), 'op-deleted-decks': '["opd-aaaa1"]' };
  eq(JSON.parse(S.mergeSaves(a, b, 'a')['op-custom-decks']).map(d => `${d.id}:${d.name}`), ['opd-cccc1:C new', 'opd-dddd1:D'], 'save codes combine two devices\' decks');
  eq(S.summarize({ ...b, 'pa-custom-decks': '[{"id":"custom-x"}]' }).decks, 3, 'and count them with the Commander decks');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
