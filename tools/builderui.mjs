// The Commander deck builder in a real browser (against `node tools/serve-test.mjs`): the start screen, picking a
// commander by color, the card sheet, the checklist's Find buttons and the search filters (list and pictures),
// adding, undo and redo, the AI helper building the rest, grouping by job, the numbers, test hands, saving as you
// go, a copy of a precon, and the same on a phone. Usage: node tools/builderui.mjs [out dir] [site]
import fs from 'node:fs';
import { chromium } from 'playwright';

const OUT = process.argv[2] || '/tmp/builderui';
const BASE = process.argv[3] || 'http://localhost:8765/';
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
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

// ---- desktop
const D = await page('desktop', 1440, 900);
await D.click('button:has-text("+ Build a deck")');
await D.waitForSelector('.b-start');
await D.waitForTimeout(900);
ok((await D.$$('.b-way')).length === 4, 'four ways to start');
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

// the helper builds the rest
await D.click('.builder-tabs button:has-text("AI helper")');
await D.click('.helper-chips button:has-text("Build the rest for me")');
await D.waitForFunction(() => +document.querySelector('.b-total b').textContent === 100, null, { timeout: 20000 });
ok(true, 'the helper filled it to 100');
ok(/Ready to play/.test(await D.textContent('.b-foot')), 'ready to play');
const states = await D.$$eval('.ckp', cs => cs.map(c => c.className.replace('ckp ', '').trim()));
ok(states.filter(s => s === 'good').length >= 4, `the checklist is mostly green (${states.join(',')})`);
await D.waitForTimeout(800);
await D.screenshot({ path: `${OUT}/07-built.png` });
// explain a checklist row
await D.click('.ckp:has-text("Card draw")');
ok(/hand full/.test(await D.textContent('.ck-detail')), 'the helper text for card draw');
await D.click('.dlist-top .seg button:has-text("Job")');
ok((await D.$$('.dgroup')).length >= 4, 'grouped by job');
await D.screenshot({ path: `${OUT}/08-by-job.png` });
await D.click('.b-tabs button:has-text("Numbers")');
await D.waitForSelector('.curve2');
ok(/of opening hands have 2 to 4 lands/.test(await D.textContent('.dstats')), 'opening-hand odds');
await D.screenshot({ path: `${OUT}/09-numbers.png` });
await D.click('.dstats button:has-text("Draw a test hand")');
await D.waitForSelector('.th-cards .tile');
ok((await D.$$('.th-cards .tile')).length === 7, 'a test hand of seven');
await D.click('.th-top button:has-text("Draw a card")');
ok((await D.$$('.th-cards .tile')).length === 8, 'draw an eighth');
await D.waitForTimeout(2500);
await D.screenshot({ path: `${OUT}/10-test-hand.png` });
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
await P.screenshot({ path: `${OUT}/11-precon-copy.png` });

// ---- a phone
const M = await page('phone', 390, 844);
await M.click('button:has-text("+ Build a deck")');
await M.waitForSelector('.b-start');
await M.waitForTimeout(900);
await M.screenshot({ path: `${OUT}/12-phone-start.png`, fullPage: true });
await M.click('.b-way:has-text("Pick a commander myself")');
await M.waitForSelector('.bresults .tile');
await M.waitForTimeout(1500);
await M.screenshot({ path: `${OUT}/13-phone-commanders.png` });
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
await M.screenshot({ path: `${OUT}/14-phone-deck.png`, fullPage: true });
ok(await M.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scrolling (deck)');
await M.click('.drow .dname');
await M.waitForSelector('.card-sheet');
await M.waitForTimeout(900);
await M.screenshot({ path: `${OUT}/15-phone-sheet.png` });

console.log(errors.length ? `errors:\n${errors.join('\n')}` : 'no page errors');
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail || errors.length ? 1 : 0);
