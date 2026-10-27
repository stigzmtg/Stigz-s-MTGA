// The One Piece deck builder in a real browser (against `node tools/serve-test.mjs`): the start screen, picking a
// Leader by color from its card sheet, the card search (type, cost, color, power, Counter, keyword, words), adding by
// hand up to 4 of a card, undo and redo, adding by name or number, pasting a list with a typo, a name several cards
// share and a card the game doesn't have, the live rules check (a Leader of other colors, a 5th copy), the numbers
// (cost curve, Counters), test hands, the card sheet, copying the list, saving as you go; then the deck in the lobby,
// a battle with it against the computer to the end, its record, and its replay after the deck was changed; editing it,
// a copy of an Ultra Deck with another Leader, deleting it; and the same builder on a phone, one panel at a time with
// no sideways scrolling. Usage: node tools/optcg/builderui.mjs [out dir]   (BASE=http://localhost:8765/)
import fs from 'node:fs';
import { chromium } from 'playwright';

const OUT = process.argv[2] || '/tmp/opbuilderui';
const BASE = process.env.BASE || 'http://localhost:8765/';
fs.mkdirSync(OUT, { recursive: true });
const cards = JSON.parse(fs.readFileSync('data/optcg/cards.json', 'utf8'));
const starters = JSON.parse(fs.readFileSync('data/optcg/decks.json', 'utf8'));
const browser = await chromium.launch();
const errors = [];
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };
async function page(name, opts) {
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript(() => { try { if (!localStorage.getItem('pa-settings')) localStorage.setItem('pa-settings', JSON.stringify({ aiSpeed: 'instant' })); localStorage.setItem('pa-tips', JSON.stringify({ op: { off: true } })); } catch { /* blocked */ } });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${name} console: ${m.text()}`); });
  await p.goto(BASE + '#onepiece');
  await p.waitForSelector('.op-decks', { timeout: 60000 });
  return p;
}
const total = p => p.$eval('.opb-total b', e => +e.textContent);
const texts = (p, sel) => p.$$eval(sel, es => es.map(e => e.textContent));
const noSideways = p => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const saved = p => p.evaluate(() => JSON.parse(localStorage.getItem('op-custom-decks') || '[]'));
const count = list => list.reduce((a, [, n]) => a + n, 0);
// a screenshot once things have settled: dialogs and panels fade in, messages fade out, pictures load
async function shot(p, name) {
  await p.waitForTimeout(700);
  await p.waitForSelector('.toast', { state: 'detached', timeout: 5000 }).catch(() => {});
  await p.screenshot({ path: `${OUT}/${name}.png` });
}

// ================================================================ desktop
const D = await page('desktop', { viewport: { width: 1440, height: 900 } });
await D.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE).origin });
await D.click('button:has-text("+ Build a deck")');
await D.waitForSelector('.opb-start');
ok((await D.$$('.opb-way')).length === 3, 'three ways to start');
ok(/exactly 50 cards/i.test(await D.textContent('.opb-howto')) && /Up to 4 of each card/.test(await D.textContent('.opb-howto')), 'the rules in a few lines');
await shot(D, '01-start');

// ---- a Leader, by color, from its card sheet
await D.click('.opb-way:has-text("Pick a Leader")');
await D.waitForSelector('.opb-results.leaders .opb-tile');
const leaders = Object.values(cards).filter(c => c.cat === 'L');
ok((await D.$$('.opb-results.leaders .opb-tile')).length === leaders.length, `every Leader is there (${leaders.length})`);
await D.click('.opb-colors .opb-chip:has-text("Red")');
const redInfo = await texts(D, '.opb-leadinfo > span');
ok(redInfo.length === leaders.filter(c => c.colors.includes('Red')).length && redInfo.every(t => /Red/.test(t)), `Red Leaders only (${redInfo.length})`);
await D.waitForTimeout(1500);
await shot(D, '02-leaders');
await D.click('.opb-tilecard[aria-label^="Monkey.D.Luffy (ST01-001)"]');
await D.waitForSelector('.opb-sheet');
ok(/Make it my Leader/.test(await D.textContent('.opb-sheet')), 'a Leader\'s sheet offers to make it the Leader');
await D.click('.opb-sheet button:has-text("Make it my Leader")');
await D.waitForSelector('.opb-deck');
ok(await total(D) === 0, 'the deck starts empty');
ok(/0 of 50: 50 more to go/.test(await D.textContent('.opb-rule.no[data-rule="size"]')), 'the rules check says 50 more to go');

// ---- the card search
await D.click('.opb-view button:has-text("List")');
const all = await D.$eval('.opb-countn', e => parseInt(e.textContent, 10));
const redPool = Object.values(cards).filter(c => c.cat !== 'L' && c.colors.includes('Red')).length;
ok(all === redPool, `the search starts with the Leader's colors (${all} of ${redPool})`);
await D.click('.opb-types button:has-text("Characters")');
ok((await texts(D, '.opb-res .opb-name small')).every(t => /Character/.test(t)), 'Characters only');
await D.click('.opb-costrow .opb-chip:has-text("2")');
ok((await texts(D, '.opb-res .opb-cost')).every(t => t === '2'), 'cost 2 only');
await D.click('.opb-costrow .opb-chip:has-text("2")');
await D.click('.opb-more');
await D.click('.opb-filters .opb-chip:has-text("Blocker")');
const blockers = await texts(D, '.opb-res .opb-tags');
ok(blockers.length > 0 && blockers.every(t => /Blocker/.test(t)), `Blockers only (${blockers.length})`);
await D.click('.opb-filters .opb-chip:has-text("Blocker")');
await D.click('.opb-filters .opb-chip:has-text("+2000")');
const c2 = await texts(D, '.opb-res .opb-ctr');
ok(c2.length > 0 && c2.every(t => t === '+2k'), `+2000 Counters only (${c2.length})`);
await D.click('.opb-filters .opb-chip:has-text("+2000")');
await D.click('.opb-filters .opb-chip:has-text("6000+")');
const pows = (await texts(D, '.opb-res .opb-pow')).map(Number);
ok(pows.length > 0 && pows.every(n => n >= 6000), `6000 power or more (${pows.length})`);
await D.click('.opb-count button:has-text("Clear filters")');
await D.fill('.opb-find .opb-searchbox input', 'straw hat');
const straw = await D.$eval('.opb-countn', e => parseInt(e.textContent, 10));
ok(straw > 0 && straw < all, `searching words on the cards (${straw})`);
await D.fill('.opb-find .opb-searchbox input', '');
await D.click('.opb-more');

// ---- adding by hand: up to 4, undo and redo
const row = id => `.opb-res:has(small:has-text("${id}"))`;
await D.fill('.opb-find .opb-searchbox input', 'OP01-016');
for (let i = 0; i < 4; i++) await D.click(`${row('OP01-016')} .btn:has-text("+ Add")`);
ok(await total(D) === 4, '4 Nami (OP01-016) added by hand');
ok(/4 in deck/.test(await D.textContent(`${row('OP01-016')} .btn`)), 'a 5th can\'t be added');
await D.click('button[aria-label="Undo"]');
ok(await total(D) === 3, 'undo');
await D.click('button[aria-label="Redo"]');
ok(await total(D) === 4, 'redo');
await D.click('.opb-deckhead');
await D.keyboard.press('Control+z');
ok(await total(D) === 3, 'Ctrl+Z undoes');
await D.keyboard.press('Control+y');
ok(await total(D) === 4, 'Ctrl+Y redoes');
// a card of another color can't go in
await D.fill('.opb-find .opb-searchbox input', 'ST02-005');
await D.click('.opb-colors .opb-chip:has-text("Green")');
ok(await D.$eval(`${row('ST02-005')} .btn`, b => b.disabled && /Not your Leader’s colors/.test(b.title)), 'a Green card can\'t be added to a Red deck, and says why');
await D.click('.opb-colors .opb-chip:has-text("Green")');
await D.fill('.opb-find .opb-searchbox input', '');

// ---- adding by name or number
await D.fill('.opb-quickadd input', 'guard poi');
await D.waitForSelector('.opb-qalist li');
ok(/Guard Point/.test(await D.textContent('.opb-qalist li.on')), 'typing a name finds the card');
await D.keyboard.press('Enter');
ok(await total(D) === 5 && await D.inputValue('.opb-quickadd input') === '', 'Enter adds it and clears the box');
await D.fill('.opb-quickadd input', 'st01-012');
await D.waitForSelector('.opb-qalist li');
ok(/Monkey\.D\.Luffy/.test(await D.textContent('.opb-qalist li.on')), 'typing a number finds the card');
await D.keyboard.press('Enter');
ok(await total(D) === 6, 'and adds it');
await D.fill('.opb-deckname', 'Test Crew');

// ---- pasting a list: a typo, a name several cards share, a card the game doesn't have, DON!!
const st01 = starters.find(d => d.id === 'st01');
const pasted = ['// from OPTCGSim', '1xST01-001', ...st01.cards.map(([k, n]) => (k === 'ST01-007' ? `${n} Nmai` : `${n}x${k}`)), '2 Shanks (OP99-002)', '10 DON!!'].join('\n');
await D.click('.topbar button:has-text("Paste a list")');
await D.fill('.opb-imptext', pasted);
await D.waitForSelector('.opb-impout .opb-ask');
const out = await D.textContent('.opb-impout');
ok(/Nmai → Nami/.test(out), 'the typo is read as the closest name');
ok(/Which Nami do you mean/.test(out), 'the reader asks which Nami');
ok(/Shanks \(OP99-002\)/.test(await D.textContent('.opb-impmissing')) && /1 not in the game yet/.test(out), 'the card the game doesn\'t have is named');
ok(/DON!! cards left out/.test(out), 'DON!! cards are left out');
ok(await D.$eval('.dialog .dlg-actions .btn.primary', b => b.disabled && /Answer the question/.test(b.textContent)), 'the list waits for the answer');
await shot(D, '03-paste');
await D.click('.opb-ask .opb-pickchip:has-text("ST01-007")');
await D.click('.opb-impmode button:has-text("Replace my deck")');
await D.click('.dialog .dlg-actions .btn.primary:has-text("Use this list")');
await D.waitForSelector('.opb-ready');
ok(await total(D) === 50, 'the pasted list makes 50 cards');
ok(!(await D.$('.opb-rule.no')) && /All good/.test(await D.textContent('.opb-ruleshead')), 'every rule is met');
ok(await D.inputValue('.opb-deckname') === 'Test Crew', 'the deck keeps its name');

// ---- the rules check, live
await D.click('.opb-drow:has-text("ST01-014") .btn[title="One fewer"]');
ok(/49 of 50: 1 more to go/.test(await D.textContent('.opb-rule.no[data-rule="size"]')), '49 cards: one more to go');
ok(!(await D.$('.btn.primary:has-text("Play this deck"):not([disabled])')), 'and it can\'t be played');
await D.click('button[aria-label="Undo"]');
await D.click('.opb-tabs button:has-text("Leaders")');
await D.click('.opb-tile:has(.opb-tilecard[aria-label^="Eustass\\"Captain\\"Kid (ST02-001)"]) .btn:has-text("Choose")');
await D.waitForSelector('.opb-rule.no[data-rule="colors"]');
ok(/Not Green: /.test(await D.textContent('.opb-rule.no[data-rule="colors"]')), 'a Green Leader: the Red cards are named');
ok(/Take them out/.test(await D.textContent('.opb-foot')), 'and can be taken out');
await D.click('button[aria-label="Undo"]');
await D.waitForSelector('.opb-ready');
ok(/Monkey\.D\.Luffy/.test(await D.textContent('.opb-leadline')), 'undo brings the Leader back');

// ---- the numbers and a test hand
await D.waitForSelector('.opb-saved:has-text("Saved on this device")');
await D.click('.opb-dtabs button:has-text("Numbers")');
const curve = (await texts(D, '.opb-curve .bar em')).map(t => +t || 0);
ok(curve.reduce((a, b) => a + b, 0) === 50, 'the cost curve counts 50 cards');
const deckNow = (await saved(D))[0];
const want2 = deckNow.cards.reduce((a, [k, n]) => a + (cards[k].counter === 2000 ? n : 0), 0), want1 = deckNow.cards.reduce((a, [k, n]) => a + (cards[k].counter === 1000 ? n : 0), 0);
const ctrs = await D.textContent('.opb-ctrs');
ok(ctrs.includes(`${want2} with +2k`) && ctrs.includes(`${want1} with +1k`), `the Counters: ${want2} +2000 and ${want1} +1000`);
await shot(D, '04-numbers');
await D.click('.opb-dtabs button:has-text("Test hand")');
ok((await D.$$('.opb-thcard')).length === 5, 'a test hand of 5');
await D.click('.opb-testhand button:has-text("Draw a card")');
ok((await D.$$('.opb-thcard')).length === 6, 'and a draw');
await D.click('.opb-dtabs button:has-text("Cards")');

// ---- the card sheet: keywords explained, the other cards with its name
await D.click('.opb-drow:has-text("ST01-007") .opb-dname');
await D.waitForSelector('.opb-sheet');
ok(/Other cards named Nami/.test(await D.textContent('.opb-sheet')) && (await D.$$('.opb-other')).length === 5, 'the sheet lists the other five Namis');
await D.hover('.opb-sheet .kw.has-tip');
ok(await D.waitForSelector('.op-kwtip', { timeout: 3000 }).then(() => true, () => false), 'a keyword explains itself');
await D.click('.opb-sheet .dlg-actions .btn');

// ---- copy the list, saved as you go
await D.click('.opb-acts button:has-text("Copy list")');
await D.waitForTimeout(300);
const copied = (await D.evaluate(() => navigator.clipboard.readText())).split('\n');
ok(copied[0] === '1xST01-001' && copied.slice(1).every(l => /^[1-4]x[A-Z]+\d*-\d{3}$/.test(l)) && copied.slice(1).reduce((a, l) => a + +l[0], 0) === 50, 'the list copies as "4xOP01-016" lines, Leader first');
await D.waitForSelector('.opb-saved:has-text("Saved on this device")');
const mine = (await saved(D))[0];
ok(mine && mine.name === 'Test Crew' && mine.leader === 'ST01-001' && count(mine.cards) === 50, 'saved on this device');
await D.$eval('.opb-deck', e => { e.scrollTop = 0; });
await D.click('.opb-view button:has-text("Pictures")');
await shot(D, '05-builder-desktop');

// ================================================================ the deck in the lobby, in a battle, in the record and replay
await D.click('.opb-acts button:has-text("Play this deck")');
await D.waitForSelector('.op-decks .op-deckgroup');
ok(/Your decks/.test(await D.textContent('.op-decks')) && await D.$('.op-deck.mine.sel:has-text("Test Crew")') != null, 'the deck is in the lobby, picked');
ok(/Test Crew/.test(await D.textContent('.op-chosen .panel-head')) && await D.$('.op-chosen-acts button:has-text("Edit")') != null && await D.$('.op-chosen-acts button:has-text("Delete")') != null, 'with Edit and Delete');
ok(await D.$('#op-opp optgroup[label="Your decks"] option:has-text("Test Crew")') != null, 'the computer can play it too');
await shot(D, '06-lobby');
// the battle: a computer player takes your seat so it plays to the end
await D.evaluate(() => { window.__opAutoplay = 999; });
await D.selectOption('#op-opp', 'st02');
await D.click('button:has-text("Battle!")');
await D.waitForSelector('.op-board');
ok(await D.textContent('.op-side.me .op-plate .deck') === 'Test Crew', 'the battle shows your deck');
const dealt = await D.evaluate(() => { const p = window.__opDebug.session.game.players[0]; return [p.leader.def.id, ...[...p.hand, ...p.deck, ...p.life, ...p.trash, ...p.characters, ...(p.stage ? [p.stage] : [])].map(c => c.def.id).sort()].join(','); });
ok(dealt === [mine.leader, ...mine.cards.flatMap(([k, n]) => Array(n).fill(k)).sort()].join(','), 'the battle deals exactly your 50 cards');
const t0 = Date.now();
const over = await D.waitForSelector('.dialog[aria-label="Game over"]', { timeout: 400000 }).then(() => true, () => false);
ok(over, `the battle plays to the end (${Math.round((Date.now() - t0) / 1000)}s)`);
const boardSummary = () => D.evaluate(() => [...document.querySelectorAll('.op-side')].map(s => [s.querySelector('.op-life .cap b').textContent, [...s.querySelectorAll('.op-piles .pile b')].map(b => b.textContent).join('/'), [...s.querySelectorAll('.op-slot:not(.empty)')].length].join(' ')).join(' | ') + ' :: ' + (document.querySelector('.dialog[aria-label="Game over"] h2') || {}).textContent);
if (over) {
  const before = await boardSummary();
  const rep = await D.evaluate(() => { const r = JSON.parse(localStorage.getItem('pa-records'))[0]; return { rec: r, rep: JSON.parse(localStorage.getItem('pa-replay-' + r.id)) }; });
  ok(rep.rec.kind === 'op' && rep.rec.deck.id === mine.id && rep.rec.deck.name === 'Test Crew', 'the record names your deck');
  ok(rep.rep && rep.rep.players[0].opDeck && rep.rep.players[0].opDeck.c.split('|').length === mine.cards.length, 'the replay keeps the deck it was played with');
  // the deck changes afterwards: the replay still plays the battle as it was
  await D.evaluate(() => { const l = JSON.parse(localStorage.getItem('op-custom-decks')); l[0].cards = l[0].cards.slice().reverse().map(([k, n], i) => [i ? k : 'ST01-012', n]); localStorage.setItem('op-custom-decks', JSON.stringify(l)); });
  await D.click('.dialog .btn:has-text("Watch replay")');
  await D.waitForSelector('[aria-label="Replay speed"]');
  await D.click('[aria-label="Replay speed"] button:has-text("4×")');
  await D.waitForSelector('.dialog[aria-label="Game over"]', { timeout: 400000 });
  await D.waitForTimeout(1500);
  const after = await boardSummary();
  ok(before === after, `the replay ends exactly as the battle did${before === after ? '' : `\n  battle ${before}\n  replay ${after}`}`);
  await D.click('.dialog .btn:has-text("Close replay")');
  await D.evaluate(own => { localStorage.setItem('op-custom-decks', JSON.stringify([own])); }, mine);
}
await D.goto(BASE + '#onepiece');
await D.reload();
await D.waitForSelector('.op-decks');
ok(/Your record with this deck/.test(await D.textContent('.op-chosen')), 'the lobby shows your record with the deck');

// ---- edit it, a copy of an Ultra Deck with another Leader, delete it
await D.click('.op-chosen-acts button:has-text("Edit")');
await D.waitForSelector('.opb-deck');
ok(await D.inputValue('.opb-deckname') === 'Test Crew' && await total(D) === 50, 'Edit opens your deck');
await D.click('.topbar button:has-text("Back to decks")');
await D.waitForSelector('.op-decks');
await D.click('.op-deck:has-text("ST-13")');
await D.click('.op-leaderpick button[title^="Sabo"]');
await D.click('.op-chosen-acts button:has-text("Edit a copy")');
await D.waitForSelector('.opb-deck');
ok(/\(Sabo\) \(my version\)/.test(await D.inputValue('.opb-deckname')) && /Sabo/.test(await D.textContent('.opb-leadline')) && await total(D) === 50 && await D.$('.opb-ready') != null, 'a copy of the Ultra Deck, led by Sabo, ready to play');
await D.click('.topbar button:has-text("Back to decks")');
await D.waitForSelector('.op-decks');
ok((await saved(D)).length === 1, 'an unchanged copy isn\'t saved');
await D.click('.op-deck.mine:has-text("Test Crew")');
await D.click('.op-chosen-acts button:has-text("Delete")');
await D.click('.op-chosen-acts button:has-text("Delete for good?")');
ok(!(await saved(D)).length && !(await D.$('.op-deckgroup')), 'deleted');

// ================================================================ phone
const P = await page('phone', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
ok(await noSideways(P), 'phone lobby: no sideways scrolling');
await P.click('button:has-text("+ Build a deck")');
await P.waitForSelector('.opb-start');
ok(await P.isVisible('.opb-switch') && await P.isHidden('.opb-left'), 'phone: one panel at a time, switched at the top');
ok(await noSideways(P), 'phone start: no sideways scrolling');
await shot(P, '07-phone-start');
await P.click('.opb-way:has-text("Copy a starter deck")');
await P.click('.opb-pickrow:has-text("ST-01")');
await P.waitForSelector('.opb-deck');
ok(await total(P) === 50 && /Straw Hat Crew \(my version\)/.test(await P.inputValue('.opb-deckname')), 'phone: a starter deck copied in');
ok(await noSideways(P), 'phone deck: no sideways scrolling');
await P.waitForTimeout(800);
await shot(P, '08-phone-deck');
await P.click('.opb-switch button:has-text("Find cards")');
ok(await P.isVisible('.opb-left') && await P.isHidden('.opb-right') && await P.isHidden('.opb-filters') && await P.isHidden('.opb-costrow'), 'phone: the search, filters folded');
await P.click('.opb-more');
ok(await P.isVisible('.opb-filters') && await P.isVisible('.opb-costrow'), 'phone: "More filters" opens them');
await P.click('.opb-more');
ok(await noSideways(P), 'phone search: no sideways scrolling');
await P.waitForTimeout(1500);
await shot(P, '09-phone-find');
await P.tap('.opb-results .opb-tilecard');
await P.waitForSelector('.opb-sheet');
ok(await noSideways(P), 'phone card sheet: no sideways scrolling');
await shot(P, '10-phone-sheet');
await P.click('.opb-sheet .dlg-actions .btn');
await P.click('.topbar button:has-text("Paste a list")');
await P.fill('.opb-imptext', '1xST01-001\n4 Nami\n4xOP99-001');
await P.waitForSelector('.opb-impout .opb-ask');
ok(await noSideways(P), 'phone paste dialog: no sideways scrolling');
await shot(P, '11-phone-paste');
await P.click('.dialog .dlg-actions .btn:has-text("Cancel")');
await P.click('.opb-switch button:has-text("Your deck")');
await P.click('.opb-dtabs button:has-text("Numbers")');
ok(await noSideways(P), 'phone numbers: no sideways scrolling');
await P.click('.topbar button:has-text("Back to decks")');
await P.waitForSelector('.op-deckgroup');
ok(await P.$('.op-deck.mine:has-text("Straw Hat Crew (my version)")') != null && await noSideways(P), 'phone lobby with your decks: no sideways scrolling');
await shot(P, '12-phone-lobby');

ok(!errors.length, errors.length ? 'page errors:\n  ' + errors.slice(0, 8).join('\n  ') : 'no page errors');
console.log(`${pass} passed, ${fail} failed · screenshots in ${OUT}`);
await browser.close();
process.exit(fail ? 1 : 0);
