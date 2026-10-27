// The Pokémon deck builder in a real browser (against `node tools/serve-test.mjs`): the start screen, building a deck
// by hand (search, the Basic Pokémon the rules check asks for, adding by typing a name, the limit of 4 and of one
// ACE SPEC, undo and redo), pasting a Pokémon TCG Live list with a typo and a card the game doesn't have, filling the
// rest with basic Energy, the numbers and test hands, the card sheet and the deck's picture, saving as you go, copying
// the list and pasting it back, then playing the deck against the computer to the end (its record and a replay that
// carries the deck), editing and deleting it from the lobby, a copy of a tournament deck, and the same on a phone
// with no sideways scrolling. Usage: node tools/ptcg/builderui.mjs [out dir] [site]   (BASE=… works too)
import fs from 'node:fs';
import { chromium } from 'playwright';

const OUT = process.argv[2] || '/tmp/pkbuilderui';
const BASE = process.argv[3] || process.env.BASE || 'http://localhost:8765/';
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const errors = [];
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };
async function page(name, width, height, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, ...opts });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE).origin });
  // (a computer player plays your seat in battles here: the battle is played to the end at once)
  await ctx.addInitScript(() => { window.__pkAutoplay = 999; try { localStorage.setItem('pa-settings', JSON.stringify({ aiSpeed: 'instant' })); localStorage.setItem('pa-tips', JSON.stringify({ pk: { off: true } })); } catch { /* blocked */ } });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_TUNNEL/.test(m.text())) errors.push(`${name} console: ${m.text()}`); });
  await p.goto(BASE + '#pokemon');
  await p.waitForSelector('text=Pick a deck, start a battle', { timeout: 60000 });
  return p;
}
const total = p => p.$eval('.b-total b', e => +e.textContent);
// a message that says this (another one may still be on screen from before)
const toast = (p, text) => p.waitForSelector(`.toast:has-text("${text}")`, { timeout: 5000 }).then(() => true, () => false);
const quickAdd = async (p, text) => { await p.fill('.quickadd input', text); await p.waitForSelector('.qa-list li'); await p.keyboard.press('Enter'); };
const noSideways = p => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

// ---- desktop: building a deck by hand
const D = await page('desktop', 1440, 900);
await D.click('button:has-text("+ Build a deck")');
await D.waitForSelector('.b-start');
ok((await D.$$('.b-way')).length === 3, 'three ways to start');
ok(/60 cards/.test(await D.textContent('.b-rules')) && /ACE SPEC/.test(await D.textContent('.b-rules')), 'the rules in a few lines');
await D.waitForTimeout(1200);
await D.screenshot({ path: `${OUT}/01-start.png` });
await D.click('.b-way:has-text("Pick cards myself")');
await D.fill('.pkb-find .searchbox input', 'ultra ball');
await D.click('.pkb-tile:has(.tile-card[aria-label^="Ultra Ball"]) .btn:has-text("+ Add")');
await D.waitForSelector('.b-deck');
ok(await total(D) === 1, 'the first card starts the deck');
// the rules check: no Basic Pokémon yet, and a button to find them
await D.click('.pkb-rules .ckp:has-text("A Basic Pokémon")');
ok(/need at least one Basic Pokémon/.test(await D.textContent('.ck-detail')), 'the rules check says a Basic Pokémon is needed, in plain words');
ok(await D.$('.pkb-rules .ckp.low:has-text("60 cards")') != null, 'and that 60 cards aren’t there yet');
await D.click('.ck-detail button:has-text("Find Basic Pokémon")');
await D.waitForSelector('.btypes button.on:has-text("Pokémon")');
ok(await D.$('.bfilters .fchip.on:has-text("Basic")') != null, 'Find shows Basic Pokémon');
const kinds = await D.$$eval('.bresults .tile-card', ts => ts.slice(0, 12).map(t => t.getAttribute('aria-label')));
ok(kinds.length === 12, `Basic Pokémon listed (${kinds.slice(0, 4).join(', ')}…)`);
// filter by type: Psychic Pokémon
await D.click('.bfilters .fchip.pipchip[title^="Psychic"]');
await D.waitForTimeout(200);
const psy = await D.$$eval('.bresults .tile-card', ts => ts.map(t => t.getAttribute('aria-label').replace(': details', '')));
ok(psy.includes('Munkidori') && !psy.includes('Dreepy'), `Psychic Basic Pokémon (${psy.slice(0, 5).join(', ')}…)`);
await D.screenshot({ path: `${OUT}/02-find-basic.png` });
await D.click('.bcount button:has-text("Clear filters")');
// Dreepy: four from its tile
await D.fill('.pkb-find .searchbox input', 'dreepy');
await D.click('.pkb-tile:has(.tile-card[aria-label^="Dreepy"]) .btn:has-text("+ Add")');
for (let i = 0; i < 3; i++) await D.click('.pkb-tile:has(.tile-card[aria-label^="Dreepy"]) .pkb-step button[aria-label^="One more"]');
ok(await total(D) === 5, 'four Dreepy');
ok(await D.$('.pkb-tile:has(.tile-card[aria-label^="Dreepy"]) .pkb-step button[aria-label^="One more"][disabled]') != null, 'no fifth Dreepy from its tile');
ok(await D.$('.pkb-rules .ckp.good:has-text("A Basic Pokémon")') != null, 'the Basic Pokémon rule is kept now');
// by typing names: Enter adds the one picked
for (let i = 0; i < 4; i++) await quickAdd(D, 'drakl');
for (let i = 0; i < 3; i++) await quickAdd(D, 'dragapult e');
ok(await total(D) === 12, `Drakloak and Dragapult ex typed in (${await total(D)})`);
await quickAdd(D, 'dreepy');
ok(await toast(D, 'up to 4 cards called Dreepy'), 'a fifth Dreepy says why it can’t go in');
await D.fill('.quickadd input', '');
await quickAdd(D, 'prime catcher');
await quickAdd(D, 'unfair stamp');
ok(await toast(D, 'Only 1 ACE SPEC card per deck: you already have Prime Catcher'), 'a second ACE SPEC says why it can’t go in');
await D.fill('.quickadd input', '');
ok(await total(D) === 13, 'one ACE SPEC');
// undo and redo
await D.click('button[aria-label="Undo"]');
ok(await total(D) === 12, 'undo');
await D.click('button[aria-label="Redo"]');
ok(await total(D) === 13, 'redo');
await D.click('.b-deckhead .b-total');
await D.keyboard.press('Control+z');
ok(await total(D) === 12, 'Ctrl+Z undoes');
await D.keyboard.press('Control+y');
ok(await total(D) === 13, 'Ctrl+Y redoes');
await D.waitForTimeout(800);
await D.screenshot({ path: `${OUT}/03-building.png` });

// ---- pasting a Pokémon TCG Live list into the deck: a typo, cards the game doesn't have
const LIVE = `Pokémon: 5
2 Munkidori TWM 95
1 Fezandipiti ex SFA 38
2 Charizard VMAX DAA 20

Trainer: 17
4 Lillie's Determination MEG 119
3 Bosss Orders PAL 172
4 Buddy-Buddy Poffin TEF 144
3 Rare Candy SVI 191
1 Battle VIP Pass FST 225
2 Night Stretcher SFA 61

Energy: 8
4 Basic {P} Energy SVE 5
4 Basic {R} Energy SVE 2

Total Cards: 30`;
await D.click('.topbar button:has-text("Paste a list")');
await D.fill('.builder-import', LIVE);
await D.waitForSelector('.imp-out .imp-sum');
const imp = (await D.textContent('.imp-out')).replace(/\s+/g, ' ');
ok(/^27 cards read/.test(imp), `the list is read (${imp.slice(0, 40)})`);
ok(/Bosss Orders PAL 172 → Boss's Orders/.test(imp), 'the typo is read as the closest card');
ok(/2 not in the game yet/.test(imp) && /Charizard VMAX DAA 20/.test(imp) && /Battle VIP Pass FST 225/.test(imp), 'cards the game doesn’t have are listed');
ok(await D.$('.imp-mode button.on:has-text("Replace my deck")') != null, 'replace is the default for a deck that has cards');
await D.click('.imp-missing li:has-text("Charizard VMAX") .chip:has-text("Charizard ex")');
ok(await D.$('.imp-missing li.swapped:has-text("Charizard VMAX")') != null && /29 cards read/.test(await D.textContent('.imp-sum')), 'a suggestion is used instead');
await D.click('.imp-mode button:has-text("Add to my deck")');
await D.waitForTimeout(400);
await D.screenshot({ path: `${OUT}/04-paste-add.png` });
await D.click('.dialog .dlg-actions .btn.primary');
ok(await total(D) === 42, `29 cards added (${await total(D)})`);
ok(await toast(D, 'Added 29 cards'), 'it says how many were added');
// the rest with basic Energy
await D.click('.dlist-top button:has-text("Fill the rest with basic Energy")');
ok(await total(D) === 60, 'filled to 60 with basic Energy');
ok(/Ready to play/.test(await D.textContent('.b-foot')), 'ready to play');
ok((await D.$$('.pkb-rules .ckp.good')).length === 5, 'every rule kept');
const kindsText = await D.textContent('.pkb-kinds');
ok(/Pokémon/.test(kindsText) && /Trainers/.test(kindsText) && /Energy/.test(kindsText), `counts by Pokémon, Trainers and Energy (${kindsText})`);
// the numbers and a test hand
await D.click('.b-tabs button:has-text("Numbers")');
ok(/of opening hands have one to start with/.test(await D.textContent('.dstats')), 'how often an opening hand has a Basic Pokémon');
ok(/make Psychic/.test(await D.textContent('.dstats')), 'the Energy the attacks need');
await D.screenshot({ path: `${OUT}/05-numbers.png` });
await D.click('.dstats button:has-text("Draw a test hand")');
await D.waitForSelector('.th-cards .pkb-tile');
ok((await D.$$('.th-cards .pkb-tile')).length === 7, 'a test hand of seven');
await D.click('.th-top button:has-text("Draw a card")');
ok((await D.$$('.th-cards .pkb-tile')).length === 8, 'and an eighth card');
await D.click('.b-tabs button:has-text("Cards")');
// the card sheet, and the deck's picture
await D.click('.pkb-row .dname:has-text("Dragapult ex")');
await D.waitForSelector('.card-sheet');
const sheet = await D.textContent('.card-sheet');
ok(/Evolves from Drakloak/.test(sheet) && /Phantom Dive/.test(sheet) && /3 in your deck/.test(sheet), 'the sheet: evolution, attacks, count');
await D.click('.card-sheet button:has-text("Use as your deck’s picture")');
await D.waitForTimeout(600);
await D.screenshot({ path: `${OUT}/06-sheet.png` });
await D.click('.card-sheet .dlg-actions button:has-text("Close")');
await D.fill('.deckname', 'My Dragon Deck');
// saved as it goes
await D.waitForSelector('.b-status .saved:has-text("Saved on this device")', { timeout: 5000 });
const saved = await D.evaluate(() => JSON.parse(localStorage.getItem('pk-custom-decks') || '[]'));
ok(saved.length === 1 && saved[0].name === 'My Dragon Deck' && saved[0].cards.reduce((a, [, n]) => a + n, 0) === 60 && saved[0].featured === 'TWM-130', 'saved on this device without pressing save');
const myId = saved[0].id;
await D.waitForTimeout(600);
await D.screenshot({ path: `${OUT}/07-built.png` });
// copy the list (Pokémon TCG Live's format) and paste it back
await D.click('.b-acts button:has-text("Copy list")');
ok(await toast(D, 'Decklist copied'), 'copied');
const copied = await D.evaluate(() => navigator.clipboard.readText());
ok(/^Pokémon: \d+\n4 Dreepy TWM 128\n/.test(copied) && /\nTrainer: \d+\n/.test(copied) && /Basic \{P\} Energy SVE 5/.test(copied) && /Total Cards: 60$/.test(copied), `the list in Live's format (${copied.split('\n').slice(0, 2).join(' / ')}…)`);
await D.click('.topbar button:has-text("Paste a list")');
await D.fill('.builder-import', copied);
await D.waitForSelector('.imp-out .imp-sum');
ok(/^60 cards read/.test((await D.textContent('.imp-out')).trim()) && !(await D.$('.imp-missing')), 'the copied list reads back whole');
await D.click('.dialog .dlg-actions button:has-text("Cancel")');

// ---- playing it against the computer, to the end
await D.click('.b-acts button:has-text("Play this deck")');
await D.waitForSelector('text=Pick a deck, start a battle');
ok(/Your decks/.test(await D.textContent('.pk-group')), 'the lobby lists your decks');
ok((await D.textContent('.pk-deck.sel .nm')) === 'My Dragon Deck' && (await D.textContent('.pk-chosen h2')) === 'My Dragon Deck', 'and has yours picked');
ok(await D.$('.pk-chosen button:has-text("Edit")') != null && await D.$('.pk-chosen button:has-text("Delete")') != null, 'with Edit and Delete');
await D.waitForTimeout(800);
await D.screenshot({ path: `${OUT}/08-lobby.png` });
await D.selectOption('#pk-opp', 'charizard');
await D.click('button:has-text("Battle!")');
await D.waitForSelector('.pk-board');
ok((await D.textContent('.pk-side.me .pk-plate .deck').catch(() => '')) === 'My Dragon Deck', 'the battle is played with your deck');
await D.waitForSelector('.dialog[aria-label="Game over"]', { timeout: 300000 });
await D.screenshot({ path: `${OUT}/09-battle-over.png` });
const rec = await D.evaluate(() => JSON.parse(localStorage.getItem('pa-records') || '[]')[0]);
ok(rec && rec.kind === 'pk' && rec.deck.id === myId && rec.deck.name === 'My Dragon Deck' && rec.replay, `the battle is in your record (${rec && JSON.stringify(rec.deck)})`);
const rep = await D.evaluate(id => JSON.parse(localStorage.getItem('pa-replay-' + id) || 'null'), rec && rec.id);
ok(rep && rep.players[0].deckId === myId && rep.players[0].deck && /TWM-130\*3/.test(rep.players[0].deck.l), 'its replay carries your deck');
await D.click('.dialog button:has-text("Watch replay")');
await D.waitForSelector('.replaybar, .pk-board', { timeout: 30000 });
await D.waitForTimeout(2500);
ok((await D.textContent('.pk-side .pk-plate .deck').catch(() => '')) === 'My Dragon Deck' || (await D.textContent('.pk-board')).includes('My Dragon Deck'), 'the replay plays your deck');
await D.click('.topbar button:has-text("Close replay")');
await D.waitForSelector('text=Pick a deck, start a battle');
ok(/1 win|0 wins/.test(await D.textContent('.pk-chosen')), 'your record with the deck');
// edit it from the lobby, then delete it
await D.click('.pk-chosen button:has-text("Edit")');
await D.waitForSelector('.b-deck');
ok(await total(D) === 60 && (await D.inputValue('.deckname')) === 'My Dragon Deck', 'Edit opens your deck');
await D.click('.topbar button:has-text("Back to decks")');
await D.waitForSelector('text=Pick a deck, start a battle');
await D.click('.pk-chosen button:has-text("Delete")');
await D.click('.pk-chosen button:has-text("Delete for good?")');
await D.waitForTimeout(300);
ok(!(await D.$('.pk-group')) && (await D.evaluate(() => JSON.parse(localStorage.getItem('pk-custom-decks') || '[]').length)) === 0, 'Delete removes it');
ok((await D.evaluate(() => JSON.parse(localStorage.getItem('pk-deleted-decks') || '[]'))).includes(myId), 'and remembers it was deleted (for save codes)');

// ---- a copy of a tournament deck, and a pasted list to start one
const P = await page('copy', 1440, 900);
await P.click('.pk-deck:has-text("Gardevoir ex")');
await P.click('.pk-chosen button:has-text("Edit a copy")');
await P.waitForSelector('.b-deck');
ok(await total(P) === 60 && /Gardevoir ex \(my version\)/.test(await P.inputValue('.deckname')), 'a copy of a tournament deck has all 60 cards');
ok(/Ready to play/.test(await P.textContent('.b-foot')), 'and is ready to play');
await P.click('.topbar button:has-text("Back to decks")');
await P.waitForSelector('text=Pick a deck, start a battle');
ok(!(await P.$('.pk-group')), 'an untouched copy isn’t saved');
await P.click('button:has-text("+ Build a deck")');
await P.click('.b-way:has-text("Paste a decklist")');
const drag = JSON.parse(fs.readFileSync('data/ptcg/decks.json', 'utf8')).find(d => d.id === 'dragapult');
const cards = JSON.parse(fs.readFileSync('data/ptcg/cards.json', 'utf8'));
await P.fill('.builder-import', drag.cards.map(([k, n]) => `${n} ${cards[k].name} ${cards[k].energy === 'Basic' ? '' : k.replace('-', ' ')}`.trim()).join('\n'));
await P.waitForSelector('.imp-out .imp-sum');
ok(/^60 cards read/.test((await P.textContent('.imp-out')).trim()), 'a pasted list to start a deck');
ok(!(await P.$('.imp-mode')), 'no replace-or-add choice for a new deck');
await P.click('.dialog .dlg-actions .btn.primary');
await P.waitForSelector('.b-deck');
ok(await total(P) === 60 && /Ready to play/.test(await P.textContent('.b-foot')), 'the pasted deck is ready');
await P.waitForTimeout(1200);
await P.screenshot({ path: `${OUT}/10-pasted.png` });

// ---- a phone: one panel at a time, nothing scrolls sideways
const M = await page('phone', 390, 844, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await M.click('button:has-text("+ Build a deck")');
await M.waitForSelector('.b-start');
ok(await noSideways(M), 'no sideways scrolling (start)');
await M.screenshot({ path: `${OUT}/11-phone-start.png` });
await M.click('.b-way:has-text("Start from a tournament deck")');
await M.waitForSelector('.pkb-pick');
ok(await noSideways(M), 'no sideways scrolling (tournament decks)');
await M.click('.pkb-pp:has-text("Charizard ex")');
await M.waitForSelector('.b-deck');
ok(await total(M) === 60, 'a tournament deck copied in');
await M.waitForTimeout(1500);
await M.screenshot({ path: `${OUT}/12-phone-deck.png`, fullPage: true });
ok(await noSideways(M), 'no sideways scrolling (deck)');
ok(!(await M.isVisible('.b-left')), 'one panel at a time: the deck');
await M.click('.b-switch button:has-text("Find cards")');
await M.waitForSelector('.pkb-find .pkb-tile');
ok(!(await M.isVisible('.b-right')), 'one panel at a time: finding cards');
await M.click('.morefilters');
await M.click('.btypes button:has-text("Trainers")');
await M.click('.bfilters .fchip:has-text("Supporter")');
await M.waitForTimeout(1500);
await M.screenshot({ path: `${OUT}/13-phone-find.png` });
ok(await noSideways(M), 'no sideways scrolling (find cards)');
await M.click('.pkb-tile .tile-card');
await M.waitForSelector('.card-sheet');
await M.waitForTimeout(800);
await M.screenshot({ path: `${OUT}/14-phone-sheet.png` });
ok(await noSideways(M), 'no sideways scrolling (card sheet)');
await M.click('.card-sheet .dlg-actions button:has-text("Close")');
await M.click('.b-switch button:nth-child(2)');
await M.click('.b-tabs button:has-text("Test hand")');
await M.waitForSelector('.th-cards .pkb-tile');
ok(await noSideways(M), 'no sideways scrolling (test hand)');
await M.click('.topbar button:has-text("Paste a list")');
await M.fill('.builder-import', LIVE);
await M.waitForSelector('.imp-out .imp-sum');
await M.waitForTimeout(300);
await M.screenshot({ path: `${OUT}/15-phone-paste.png` });
ok(await noSideways(M), 'no sideways scrolling (paste)');

console.log(errors.length ? `errors:\n${errors.join('\n')}` : 'no page errors');
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail || errors.length ? 1 : 0);
