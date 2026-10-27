// The deck builder without a browser. The card guide (src/ui/deckguide.js) on every precon: each is a legal deck
// (100 cards, in colors, one of each), its checklist and color advice read sensibly, and card details and ranking
// work. Then pasted lists (src/ui/decktext.js) in every common format: Moxfield, Archidekt, MTG Arena, MTGO, TappedOut,
// typed by hand, with typos, curly quotes and accents, cards the game doesn't have, sideboards and no commander marked.
// Usage: node tools/buildertest.mjs
import fs from 'node:fs';
import { buildIndex, deckProblems, BASICS } from '../src/ui/customdecks.js';
import { createDeckGuide } from '../src/ui/deckguide.js';
import { parseDeckText, findCardName, deckToText, countCards } from '../src/ui/decktext.js';

// the whole card pool, as the builder has it once everything has loaded (tools/build-allcards.mjs)
const more = JSON.parse(fs.readFileSync('data/more.json', 'utf8'));
const raw = Object.assign(JSON.parse(fs.readFileSync('data/cards.json', 'utf8')), ...Array.from({ length: more.shards }, (_, i) => JSON.parse(fs.readFileSync(`data/more/cards-${i}.json`, 'utf8'))));
const meta = JSON.parse(fs.readFileSync('data/cardmeta.json', 'utf8'));
const precons = JSON.parse(fs.readFileSync('data/decks.json', 'utf8'));
const community = JSON.parse(fs.readFileSync('data/community.json', 'utf8'));
const decks = [...community, ...precons];
const support = JSON.parse(fs.readFileSync('data/support.json', 'utf8'));
const t0 = performance.now();
const index = buildIndex(raw);
const byName = new Map(index.map(c => [c.name, c]));
const H = createDeckGuide(index, decks, support, n => meta[n] || null);
const setupMs = performance.now() - t0;
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };
const toMap = cards => { const m = new Map(); for (const [n, k] of cards) m.set(n, (m.get(n) || 0) + k); return m; };

ok(index.length > 30000, `the whole card pool is there (${index.length} cards)`);
ok(setupMs < 8000, `reading every card takes ${setupMs.toFixed(0)} ms`);
// ranking a deck (every change in the builder does it) stays quick with the whole pool
{
  const d = precons[0], cards = toMap(d.cards), state = { commanders: d.commanders, cards };
  const t = performance.now(); H.rank(state); const ms = performance.now() - t;
  ok(ms < 400, `ranking the pool for a deck takes ${ms.toFixed(0)} ms`);
}
ok(!H.feats.get('Dockside Extortionist').legal && H.feats.get('Sol Ring').legal, 'the banned list comes from Scryfall');
ok(H.feats.get('Sol Ring').popular > 0.9, 'Sol Ring is among the most played cards');
ok(community.length >= 30 && community.every(d => d.community && d.url && d.source), `community decks with credit (${community.length})`);

// ---- every precon and community deck through the guide
let landsGood = 0, shortColors = 0;
for (const d of decks) {
  const cards = toMap(d.cards);
  const state = { commanders: d.commanders, cards };
  const identity = [...new Set(d.commanders.flatMap(n => (byName.get(n) || { ci: [] }).ci))];
  const problems = deckProblems({ commanders: d.commanders, cards: [...cards] }, byName, identity).filter(p => !/can’t fully play/.test(p));
  // (Upgrades Unleashed lists Mossfire Valley twice in the precon data)
  ok(d.community ? !problems.length && !deckProblems({ commanders: d.commanders, cards: [...cards] }, byName, identity).length : true, `${d.name}: a community deck is fully legal`);
  ok(!problems.filter(p => !(d.name === 'Upgrades Unleashed' && /Mossfire Valley/.test(p))).length, `${d.name}: ${problems.join(' ')}`);
  const rec = H.recipe(state);
  ok(rec.rows.length >= 6 && rec.rows.every(r => r.have >= 0 && r.want > 0), `${d.name}: a checklist`);
  if (rec.rows.find(x => x.id === 'land').state === 'good') landsGood++;
  shortColors += H.manaStats(state).colors.filter(c => c.short).length;
  for (const [n] of [...cards].slice(0, 2)) ok(H.info(n, state) && Array.isArray(H.info(n, state).roles), `${d.name}: info for ${n}`);
  ok(H.rank(state).size > 50, `${d.name}: ranking`);
  // a precon written out and pasted back is the same deck
  const back = parseDeckText(deckToText({ commanders: d.commanders, cards: [...cards] }), byName);
  ok(JSON.stringify(back.commanders) === JSON.stringify(d.commanders) && (countCards(back.cards) === countCards(cards) || d.name === 'Upgrades Unleashed') && !back.missing.length, `${d.name}: copied and pasted back the same`);
}
ok(landsGood / decks.length > 0.6, `most precons' land counts read as right (${landsGood}/${decks.length})`);
ok(shortColors <= decks.length * 0.25, `color advice is quiet for most precons' lands (${shortColors} short colors in ${decks.length} decks)`);

// ---- names
const name = (s, want, fixed = false) => { const r = findCardName(s, byName); ok(r.name === want && !!r.fixed === fixed, `"${s}" -> ${JSON.stringify(r)} (want ${want})`); };
name('sol ring', 'Sol Ring');
name('SOL RING', 'Sol Ring');
name('Lim-Dul’s Vault', "Lim-Dûl's Vault");
name('Gilraen, Dunedain Protector', 'Gilraen, Dúnedain Protector');
name('Muldrotha', 'Muldrotha, the Gravetide');
ok(findCardName('Atraxa', byName).suggestions.includes("Atraxa, Praetors' Voice"), 'a first name two cards share gets both as suggestions');
name('Esika, God of the Tree // The Prismatic Bridge', 'Esika, God of the Tree');
name('Esika, God of the Tree / The Prismatic Bridge', 'Esika, God of the Tree');
name('Sol Rnig', 'Sol Ring', true);
name('Swords to Plowshare', 'Swords to Plowshares', true);
name('Atraxa Praetors Voice', "Atraxa, Praetors' Voice", true);
ok(!findCardName('Blarg the Mighty', byName).name, 'a made-up card isn’t matched');
ok(findCardName('Llanowar Elve', byName).name === 'Llanowar Elves', 'one letter missing');
ok(findCardName('Llanowar', byName).suggestions.length > 0, 'part of a name gets suggestions');

// ---- formats
const parse = t => parseDeckText(t, byName);
const has = (r, n, k = 1) => r.cards.get(n) === k;
{
  // MTG Arena / Moxfield
  const r = parse(`About\nName My Atraxa\n\nCommander\n1 Atraxa, Praetors' Voice (2X2) 190 *F*\n\nDeck\n1 Sol Ring (C21) 263\n1 Arcane Signet (CMM) 1015 *E*\n10 Forest (UNF) 240\n\nSideboard\n1 Counterspell (DMR) 45`);
  ok(r.name === 'My Atraxa', 'Arena: the deck name');
  ok(r.commanders[0] === "Atraxa, Praetors' Voice", 'Arena: the commander');
  ok(has(r, 'Sol Ring') && has(r, 'Arcane Signet') && has(r, 'Forest', 10), 'Arena: printings and foil marks dropped');
  ok(!r.cards.has('Counterspell') && r.skipped === 1, 'Arena: the sideboard left out');
}
{
  // Archidekt with categories and labels
  const r = parse(`1x Atraxa, Praetors' Voice (cm2) 10 [Commander{top}]\n1x Sol Ring (c21) 263 [Ramp] ^Have,#37d67a^\n1x Cultivate (m21) 177 [Ramp,Land]`);
  ok(r.commanders[0] === "Atraxa, Praetors' Voice" && has(r, 'Sol Ring') && has(r, 'Cultivate'), 'Archidekt: [Commander] category, other categories and labels');
}
{
  // Archidekt and Moxfield by category, with counts in the headings
  const r = parse(`Commander (1)\n1 Atraxa, Praetors' Voice\n\nRamp (2)\n1 Sol Ring\n1 Cultivate\n\nCard Advantage (1)\n1 Rhystic Study\n\nMaybeboard (1)\n1 Llanowar Elves`);
  ok(r.commanders.length === 1 && has(r, 'Sol Ring') && has(r, 'Cultivate') && !r.cards.has('Llanowar Elves'), 'categories with counts; the maybeboard left out');
  ok(!r.missing.some(m => /card advantage/i.test(m.name)), 'a category heading isn’t read as a card');
}
{
  // MTGO: the commander is the sideboard
  const r = parse(`1 Sol Ring\n1 Command Tower\n\nSIDEBOARD:\n1 Atraxa, Praetors' Voice`);
  ok(r.commanders[0] === "Atraxa, Praetors' Voice" && r.skipped === 0, 'MTGO: the commander from the sideboard');
  const r2 = parse(`1 Sol Ring\nSB: 1 Atraxa, Praetors' Voice`);
  ok(r2.commanders[0] === "Atraxa, Praetors' Voice", 'MTGO: SB: lines');
  const r3 = parse(`1 Sol Ring\n1 Llanowar Elves\n\n1 Atraxa, Praetors' Voice`);
  ok(!r3.commanders.length && r3.guess === "Atraxa, Praetors' Voice", 'MTGO without a heading: the last paragraph is the likely commander');
}
{
  // TappedOut and hand-typed
  const r = parse(`1x Atraxa, Praetors' Voice *CMDR*\nSol Ring\nCultivate x1\n2 Swamp\n// Lands\n1 Command Tower`);
  ok(r.commanders[0] === "Atraxa, Praetors' Voice" && has(r, 'Sol Ring') && has(r, 'Cultivate') && has(r, 'Swamp', 2) && has(r, 'Command Tower'), 'TappedOut *CMDR*, no count, "x1", comments');
  const r2 = parse(`1 Atraxa, Praetors' Voice (Commander)\n1 Sol Ring`);
  ok(r2.commanders.length === 1, '(Commander) after the name');
}
{
  // one copy each; any number of basics and of cards that say so
  const r = parse(`Commander\n1 Atraxa, Praetors' Voice\nDeck\n2 Sol Ring\n1 Sol Ring\n12 Forest`);
  ok(has(r, 'Sol Ring', 1) && r.clamped.includes('Sol Ring') && has(r, 'Forest', 12), 'one Sol Ring kept, twelve Forests');
  const rats = [...byName.values()].find(c => c.anyNumber && !BASICS.has(c.name));
  if (rats) ok(has(parse(`20 ${rats.name}`), rats.name, 20), `any number of ${rats.name}`);
}
{
  // no commander marked: the cards that could lead, the one whose colors cover the deck first
  const r = parse(`1 Llanowar Elves\n1 Esika, God of the Tree\n1 Atraxa, Praetors' Voice\n1 Counterspell`);
  ok(!r.commanders.length && r.candidates.includes("Atraxa, Praetors' Voice") && r.candidates.includes('Esika, God of the Tree'), 'candidates listed');
  ok(r.candidates[0] === 'Esika, God of the Tree' || r.candidates[0] === "Atraxa, Praetors' Voice", 'candidates covering the colors first');
  const r2 = parse(`Commander\n1 Sol Ring\n1 Atraxa, Praetors' Voice\nDeck\n1 Cultivate`);
  ok(r2.commanders[0] === "Atraxa, Praetors' Voice" && r2.notCommander.includes('Sol Ring') && has(r2, 'Sol Ring'), 'a marked card that can’t lead stays in the deck');
}
{
  // two commanders need Partner
  const partners = [...byName.values()].filter(c => c.commander && c.pairing && c.pairing.any).slice(0, 2).map(c => c.name);
  const r = parse(`Commander\n1 ${partners[0]}\n1 ${partners[1]}\nDeck\n1 Sol Ring`);
  ok(r.commanders.length === 2, `two partners (${partners.join(' & ')})`);
  const r2 = parse(`Commander\n1 Atraxa, Praetors' Voice\n1 Esika, God of the Tree`);
  ok(r2.commanders.length === 1 && has(r2, 'Esika, God of the Tree'), 'a second commander without Partner goes in the deck');
  // Partner with, Choose a Background (the Background listed first), Doctor's companion, a Spacecraft
  const r3 = parse(`Commander\n1 Frodo, Adventurous Hobbit\n1 Sam, Loyal Attendant`);
  ok(r3.commanders.length === 2, 'Partner with');
  const bg = [...byName.values()].find(c => c.pairing && c.pairing.isBackground), chooser = [...byName.values()].find(c => c.commander && c.pairing && c.pairing.background);
  const r4 = parse(`Commander\n1 ${bg.name}\n1 ${chooser.name}`);
  ok(r4.commanders.length === 2 && r4.commanders[0] === chooser.name, `Choose a Background (${chooser.name} with ${bg.name})`);
  const doc = [...byName.values()].find(c => c.commander && c.pairing && c.pairing.isDoctor), comp = [...byName.values()].find(c => c.commander && c.pairing && c.pairing.companion);
  ok(parse(`Commander\n1 ${doc.name}\n1 ${comp.name}`).commanders.length === 2, `Doctor's companion (${doc.name} with ${comp.name})`);
  ok(parse(`Commander\n1 Inspirit, Flagship Vessel`).commanders.length === 1, 'a legendary Spacecraft can lead');
}
{
  // typos and missing cards
  const r = parse(`1 Sol Rnig\n1 Blarg the Mighty\n1 Blarg the Mighty\n1 Swords to Plowshare`);
  ok(has(r, 'Sol Ring') && has(r, 'Swords to Plowshares') && r.fixed.length === 2, 'typos read as the closest card');
  ok(r.missing.length === 1 && r.missing[0].n === 2, 'a missing card listed once, with its count');
}
{
  // a big paste is quick, even full of names the game doesn't know
  const t0 = performance.now();
  parse(Array.from({ length: 120 }, (_, i) => `1 Not A Real Card Number ${i}`).join('\n'));
  const ms = performance.now() - t0;
  ok(ms < 1500, `120 unknown names read in ${ms.toFixed(0)} ms`);
}
console.log(`${decks.length} decks checked\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
