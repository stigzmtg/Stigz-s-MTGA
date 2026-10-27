// The Commander deck builder in a real browser (against `node tools/serve-test.mjs`): the start screen, picking a
// commander by color, the card sheet, the checklist's Find buttons and the search filters (list and pictures),
// adding, undo and redo, adding by typing a name, pasting a list (to start a deck and to add to one: set codes, a
// typo, a card the game doesn't have, no commander marked), grouping by job, the numbers, test hands, saving as you
// go, a copy of a precon, and the same on a phone. Usage: node tools/builderui.mjs [out dir] [site]
import fs from 'node:fs';
import { chromium } from 'playwright';

const OUT = process.argv[2] || '/tmp/builderui';
const BASE = process.argv[3] || 'http://localhost:8765/';
fs.mkdirSync(OUT, { recursive: true });
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await chromium.launch(/^https:/.test(BASE) && proxy ? { proxy: { server: proxy } } : {});
const errors = [];
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };
async function page(name, width, height) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.addInitScript(() => { try { localStorage.setItem('pa-settings', JSON.stringify({ aiSpeed: 'fast' })); } catch { /* blocked */ } });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${name} console: ${m.text()}`); });
  await p.goto(BASE + '#mtg');
  await p.waitForSelector('text=Pick a precon', { timeout: 60000 });
  return p;
}
const total = p => p.$eval('.b-total b', e => +e.textContent);
const decks = JSON.parse(fs.readFileSync('data/decks.json', 'utf8'));

// ---- desktop
const D = await page('desktop', 1440, 900);
await D.click('button:has-text("+ Build a deck")');
await D.waitForSelector('.b-start');
await D.waitForTimeout(900);
ok((await D.$$('.b-way')).length === 3, 'three ways to start');
ok(!(await D.$('.builder-tabs button:has-text("helper")')), 'no helper tab');
ok(/100 cards/.test(await D.textContent('.b-rules')), 'the rules in a few lines');
await D.screenshot({ path: `${OUT}/01-start.png` });

// a commander by color
await D.click('.b-way:has-text("Pick a commander myself")');
await D.waitForSelector('.bresults.grid .tile');
await D.click('.fchip.pipchip[title="Red"]');
await D.click('.fchip.pipchip[title="Green"]');
await D.check('.frow .checkline input');
await D.waitForTimeout(300);
const rg = await D.$$eval('.bresults .tile', ts => ts.length);
ok(rg > 5, `red-green commanders listed (${rg})`);
await D.waitForTimeout(1500);
await D.screenshot({ path: `${OUT}/02-commanders.png` });
// the card sheet for one, then choose it
await D.fill('.bfind .searchbox input', 'Atarka, World Render');
await D.waitForTimeout(300);
await D.click('.bresults .tile .tile-card');
await D.waitForSelector('.card-sheet');
ok(/Make it my commander/.test(await D.textContent('.card-sheet')), 'the sheet offers to make it the commander');
await D.waitForTimeout(800);
await D.screenshot({ path: `${OUT}/03-commander-sheet.png` });
await D.click('.card-sheet button:has-text("Make it my commander")');
await D.waitForSelector('.b-deck');
ok(await total(D) === 1, 'the deck starts with the commander');
ok((await D.$$('.checklist .ckp')).length >= 6, 'the checklist is there');

// the checklist finds ramp
await D.click('.ckp:has-text("Ramp")');
ok(/Ramp gives you extra mana/.test(await D.textContent('.ck-detail')), 'a checklist part explains itself');
await D.click('.ck-detail button');
await D.waitForSelector('.bfind .fchip.r-ramp.on');
ok(/best for your deck first/.test(await D.textContent('.bcount')), 'sorted by fit');
const firstRows = await D.$$eval('.bres .bname b', bs => bs.slice(0, 5).map(b => b.textContent));
ok(firstRows.includes('Sol Ring') || firstRows.includes('Arcane Signet') || firstRows.length === 5, `ramp results (${firstRows.join(', ')})`);
await D.screenshot({ path: `${OUT}/04-find-ramp.png` });
// add three, undo one, redo it
for (let i = 0; i < 3; i++) await D.click('.bres:not(.in) .btn.sm:has-text("+ Add")');
ok(await total(D) === 4, 'three added');
await D.click('button[aria-label="Undo"]');
ok(await total(D) === 3, 'undo');
await D.click('button[aria-label="Redo"]');
ok(await total(D) === 4, 'redo');
await D.keyboard.press('Control+z');
ok(await total(D) === 3, 'Ctrl+Z undoes');
// pictures
await D.click('.view-switch button:has-text("Pictures")');
await D.waitForSelector('.bresults.grid .tile');
await D.waitForTimeout(2500);
await D.screenshot({ path: `${OUT}/05-pictures.png` });
await D.click('.view-switch button:has-text("List")');
// the card sheet for a card
await D.fill('.bfind .searchbox input', 'Cultivate');
await D.waitForTimeout(300);
await D.click('.bres .bname');
await D.waitForSelector('.card-sheet');
const sheet = await D.textContent('.card-sheet');
ok(/Its job in a deck/.test(sheet) && /Ramp/.test(sheet), 'the sheet says its job');
ok((await D.$$('.cs-sim')).length > 0, 'and other picks for the job');
await D.waitForTimeout(800);
await D.screenshot({ path: `${OUT}/06-card-sheet.png` });
await D.click('.card-sheet button:has-text("Add to deck")');
await D.waitForSelector('.card-sheet .cs-count');
await D.click('.card-sheet .dlg-actions button:has-text("Close")');
ok(await total(D) === 4, 'added from the sheet');
// off-color cards are refused in the sheet
await D.click('.bcount button:has-text("Clear filters")');
await D.fill('.bfind .searchbox input', 'Counterspell');
await D.uncheck('.bfilters .checkline input');
await D.waitForTimeout(300);
await D.click('.bres .bname:has-text("Counterspell")');
ok(/outside your commander’s colors/.test(await D.textContent('.card-sheet .cs-problems')), 'an off-color card says why it can’t go in');
await D.click('.card-sheet .dlg-actions button:has-text("Close")');
await D.check('.bfilters .checkline input');

// add a card by typing its name
await D.fill('.quickadd input', 'sol ri');
await D.waitForSelector('.qa-list li');
ok(/Sol Ring/.test(await D.textContent('.qa-list li.on')), 'typing a name finds the card');
await D.keyboard.press('Enter');
ok(await total(D) === 5, 'Enter adds it');
ok(await D.inputValue('.quickadd input') === '', 'and clears the box for the next one');
await D.fill('.quickadd input', 'counterspe');
await D.waitForSelector('.qa-list li');
ok(/Not your colors/.test(await D.textContent('.qa-list')), 'an off-color card shows why it can’t go in');
await D.keyboard.press('Enter');
ok(await total(D) === 5, 'and isn’t added');
await D.fill('.quickadd input', '');
await D.screenshot({ path: `${OUT}/07-quick-add.png` });
// paste several cards into the box: the paste dialog opens to add them
await D.focus('.quickadd input');
await D.evaluate(() => { const i = document.querySelector('.quickadd input'); const dt = new DataTransfer(); dt.setData('text/plain', '1 Rampant Growth\n1 Kodama\'s Reach (C21) 199\n1 Harmonize\n1 Chaos Warp\n1 Llanowar Elve\n1 Blarg the Mighty\n1 Sol Ring'); i.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
await D.waitForSelector('.imp-out .imp-sum');
ok(await D.$('.imp-mode button.on:has-text("Add to my deck")') != null, 'pasting a list into the box opens the paste dialog, set to add');
ok(/Llanowar Elve → Llanowar Elves/.test(await D.textContent('.imp-out')), 'a typo is read as the closest card');
ok(/Blarg the Mighty/.test(await D.textContent('.imp-missing')), 'a card the game doesn’t have is listed');
await D.waitForTimeout(400);
await D.screenshot({ path: `${OUT}/08-paste-add.png` });
await D.click('.dialog .dlg-actions .btn.primary');
ok(await total(D) === 10, `five new cards added, Sol Ring already in (${await total(D)})`);
ok(/already in your deck/.test(await D.textContent('.toast')), 'it says one was already in');
// the rest with basics
await D.click('.dlist-top button:has-text("Fill the rest with basic lands")');
ok(await total(D) === 100, 'filled to 100 with basic lands');
ok(/Ready to play/.test(await D.textContent('.b-foot')), 'ready to play');
await D.waitForTimeout(800);
await D.screenshot({ path: `${OUT}/09-built.png` });
// explain a checklist row
await D.click('.ckp:has-text("Card draw")');
ok(/hand full/.test(await D.textContent('.ck-detail')), 'the checklist explains card draw');
await D.click('.dlist-top .seg button:has-text("Job")');
ok((await D.$$('.dgroup')).length >= 4, 'grouped by job');
await D.screenshot({ path: `${OUT}/10-by-job.png` });
await D.click('.b-tabs button:has-text("Numbers")');
await D.waitForSelector('.curve2');
ok(/of opening hands have 2 to 4 lands/.test(await D.textContent('.dstats')), 'opening-hand odds');
await D.screenshot({ path: `${OUT}/11-numbers.png` });
await D.click('.dstats button:has-text("Draw a test hand")');
await D.waitForSelector('.th-cards .tile');
ok((await D.$$('.th-cards .tile')).length === 7, 'a test hand of seven');
await D.click('.th-top button:has-text("Draw a card")');
ok((await D.$$('.th-cards .tile')).length === 8, 'draw an eighth');
await D.waitForTimeout(2500);
await D.screenshot({ path: `${OUT}/12-test-hand.png` });
// saved as it goes
await D.waitForSelector('.b-status .saved:has-text("Saved on this device")', { timeout: 5000 });
const saved = await D.evaluate(() => JSON.parse(localStorage.getItem('pa-custom-decks') || '[]'));
ok(saved.length === 1 && saved[0].commanders[0] === 'Atarka, World Render' && saved[0].cards.reduce((a, [, n]) => a + n, 0) === 99, 'saved on this device without pressing save');
await D.click('button:has-text("Back to decks")');
await D.waitForSelector('text=Pick a precon');

// ---- a copy of a precon, from the deck list
const P = await page('precon', 1440, 900);
await P.click('button:has-text("Edit a copy")');
await P.waitForSelector('.b-deck');
ok(await total(P) === 100, 'a precon copy has all 100 cards');
ok(/\(my version\)/.test(await P.inputValue('.deckname')), 'named as your version');
await P.waitForTimeout(800);
await P.screenshot({ path: `${OUT}/13-precon-copy.png` });

// ---- a pasted list to start a deck: printings, foil marks and categories, a typo, a card the game doesn't have
const typoable = n => n.length > 12 && !/[^a-z ,']/i.test(n) && n[5] !== n[6] && !/[ ,']/.test(n[5] + n[6]);
const pre = decks.find(d => d.commanders.length === 1 && d.cards.length > 60 && d.cards.some(([n]) => typoable(n)));
const typo = pre.cards.find(([n]) => typoable(n))[0];
const lines = ['About', 'Name Pasted Deck', '', 'Commander', `1 ${pre.commanders[0]} (CMM) 12 *F*`, '', 'Deck', ...pre.cards.map(([n, k], i) => (n === typo ? `${k} ${n.slice(0, 5)}${n[6]}${n[5]}${n.slice(7)}` : i % 3 === 0 ? `${k}x ${n} (c21) ${100 + i} [Ramp]` : i % 3 === 1 ? `${k} ${n}` : `${n} x${k}`)), '1 Blarg the Mighty', '', 'Sideboard', '1 Lightning Bolt'];
const I = await page('paste', 1440, 900);
await I.click('button:has-text("+ Build a deck")');
await I.click('.b-way:has-text("Paste a decklist")');
await I.fill('.builder-import', lines.join('\n'));
await I.waitForSelector('.imp-out .imp-sum');
const out = await I.textContent('.imp-out');
ok(/^100 cards read from “?Pasted Deck/.test(out.replace(/\s+/g, ' ')), `the whole list is read (${out.slice(0, 60)})`);
ok(out.includes(`Commander: ${pre.commanders[0]}`), 'the commander is found');
ok(out.includes(`→ ${typo}`), `the typo is read as ${typo}`);
ok(/1 not in the game yet/.test(out) && /sideboard or maybeboard card left out/.test(out), 'the missing card and the sideboard are reported');
ok(!(await I.$('.imp-mode')), 'no replace-or-add choice for a new deck');
await I.waitForTimeout(400);
await I.screenshot({ path: `${OUT}/14-paste-start.png` });
await I.click('.dialog .dlg-actions .btn.primary');
await I.waitForSelector('.b-deck');
ok(await total(I) === 100, 'the pasted deck has 100 cards');
ok(await I.inputValue('.deckname') === 'Pasted Deck', 'and the list’s name');
// replace it with a list that marks no commander: the dialog asks which card leads
await I.click('.topbar button:has-text("Paste a list")');
await I.fill('.builder-import', ['1 Sol Ring', `1 ${pre.commanders[0]}`, '1 Arcane Signet', '1 Command Tower'].join('\n'));
await I.waitForSelector('.imp-pick');
ok(await I.$('.imp-mode button.on:has-text("Replace my deck")') != null, 'a deck already there: replace is the default');
ok(await I.$(`.imp-pick .chip.on:has-text("${pre.commanders[0].split(',')[0]}")`) != null, 'the likely commander is picked');
await I.screenshot({ path: `${OUT}/15-paste-pick.png` });
await I.click('.dialog .dlg-actions .btn.primary');
ok(await total(I) === 4, `the deck is replaced (${await total(I)})`);

// ---- a phone
const M = await page('phone', 390, 844);
await M.click('button:has-text("+ Build a deck")');
await M.waitForSelector('.b-start');
await M.waitForTimeout(900);
await M.screenshot({ path: `${OUT}/16-phone-start.png`, fullPage: true });
await M.click('.b-way:has-text("Pick a commander myself")');
await M.waitForSelector('.bresults .tile');
await M.waitForTimeout(1500);
await M.screenshot({ path: `${OUT}/17-phone-commanders.png` });
ok(await M.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scrolling (commanders)');
await M.click('.bresults .tile .btn:has-text("Choose")');
await M.waitForSelector('.b-deck');
await M.click('.ckp:has-text("Lands")');
await M.click('.ck-detail button');
await M.waitForSelector('.bres');
await M.click('.bres:not(.in) .btn.sm:has-text("+ Add")');
await M.click('.b-switch button:nth-child(2)');
await M.click('.dlist-top button:has-text("Fill the rest with basic lands")');
ok(await total(M) === 100, 'filled with basic lands');
await M.waitForTimeout(3200);
await M.screenshot({ path: `${OUT}/18-phone-deck.png`, fullPage: true });
ok(await M.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scrolling (deck)');
await M.click('.drow .dname');
await M.waitForSelector('.card-sheet');
await M.waitForTimeout(900);
await M.screenshot({ path: `${OUT}/19-phone-sheet.png` });

console.log(errors.length ? `errors:\n${errors.join('\n')}` : 'no page errors');
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail || errors.length ? 1 : 0);
