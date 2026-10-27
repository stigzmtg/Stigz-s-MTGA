// The whole card pool in a real browser (against `node tools/serve-test.mjs`): community decks list with credit and
// pictures; the deck builder loads every card and finds ones no precon plays, with Scryfall pictures; a deck built
// from them plays in a fresh page, which loads the extra cards before the game starts; a community deck plays with
// its pictures; the page's first load stays small. Usage: node tools/allcardsui.mjs [out dir] [site]
import fs from 'node:fs';
import { chromium } from 'playwright';
import sharp from 'sharp';

const OUT = process.argv[2] || '/tmp/allcardsui';
const BASE = process.argv[3] || 'http://localhost:8765/';
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const errors = [];
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
// Scryfall's pictures: answered here with a stand-in picture (the test machine may not reach Scryfall), counted
const scry = [];
const stand = await sharp({ create: { width: 488, height: 680, channels: 3, background: { r: 90, g: 70, b: 40 } } }).jpeg().toBuffer();
await ctx.route('https://cards.scryfall.io/**', r => { scry.push(r.request().url()); return r.fulfill({ status: 200, contentType: 'image/jpeg', body: stand, headers: { 'access-control-allow-origin': '*' } }); });
await ctx.addInitScript(() => { window.__paExpose = true; try { localStorage.setItem('pa-settings', JSON.stringify({ aiSpeed: 'instant' })); localStorage.setItem('pa-tips', JSON.stringify({ mtg: { off: true, seen: [] } })); } catch { /* blocked */ } });
const open = async () => {
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  return p;
};
const EXTRA = 'Illusionist\'s Bracers';   // a card no precon or community deck plays (data/more)

// ---- the first load: the card pool's pieces aren't fetched
const P = await open();
const fetched = [];
P.on('request', r => fetched.push(r.url()));
await P.goto(BASE + '#mtg');
await P.waitForSelector('text=Pick a deck, take a seat', { timeout: 60000 });
await P.waitForTimeout(1500);
ok(!fetched.some(u => /data\/more\/|cardmeta/.test(u)), 'the lobby loads without the rest of the card pool');
// ---- community decks
const groups = await P.$$eval('.setgroup', g => g.map(x => x.textContent));
ok(groups.some(g => /EDHREC average decks/.test(g)) && groups.some(g => /Popular on Archidekt/.test(g)), `community decks are listed (${groups.slice(0, 4).join(' | ')})`);
await P.click('.deckrow:has-text("the EDHREC average deck")');
await P.waitForTimeout(400);
ok(/on EDHREC/.test(await P.textContent('section[aria-label="Selected deck"]')), 'an EDHREC deck links to its page');
const art = await P.$eval('.deckrow.sel .art', e => e.style.backgroundImage).catch(() => '');
ok(/cards\.scryfall\.io/.test(art), `its commander's picture comes from Scryfall (${art.slice(0, 60)})`);
await P.click('.deckrow:has-text("Popular on Archidekt"), .setgroup:has-text("Popular on Archidekt") + .deckrow').catch(() => {});
const arch = await P.$$('.deckrow');
for (const r of arch) { if (/Archidekt/.test(await r.textContent())) { await r.click(); break; } }
await P.waitForTimeout(300);
ok(/by .+ on Archidekt/.test(await P.textContent('section[aria-label="Selected deck"]')), 'an Archidekt deck names its builder');
await P.screenshot({ path: `${OUT}/01-lobby-community.png` });

// ---- the builder loads every card
await P.click('button:has-text("+ Build a deck")');
await P.waitForSelector('.b-start');
ok(await P.$('.b-loading') != null || fetched.some(u => /data\/more\//.test(u)), 'the builder starts loading every card');
await P.waitForFunction(() => !document.querySelector('.b-loading'), null, { timeout: 60000 });
ok(fetched.filter(u => /data\/more\/cards-\d+\.json/.test(u)).length >= 4, 'the card pool loaded in pieces');
const commanders = await P.textContent('.b-way:has-text("Pick a commander myself")');
const nCmd = +(commanders.match(/all ([\d,]+) commanders/) || [, '0'])[1].replace(/,/g, '');
ok(nCmd > 2500, `thousands of commanders to choose from (${nCmd})`);
await P.click('.b-way:has-text("Pick a commander myself")');
await P.fill('.bfind .searchbox input', 'Kozilek, the Great Distortion');
await P.waitForTimeout(400);
await P.click('.bresults .tile .btn:has-text("Choose")');
await P.waitForSelector('.b-deck');
// a card no precon plays: found by name, with its Scryfall picture
await P.fill('.quickadd input', EXTRA.slice(0, 12));
await P.waitForSelector('.qa-list li');
ok((await P.textContent('.qa-list')).includes(EXTRA), `${EXTRA} is found`);
await P.click(`.qa-list li:has-text("${EXTRA}")`);
ok(await P.$eval('.b-total b', e => +e.textContent) === 2, 'and added');
await P.click(`.drow .dname:has-text("${EXTRA}")`);
await P.waitForSelector('.card-sheet');
await P.waitForTimeout(1500);
const sheetImg = await P.$eval('.card-sheet img.cimg', e => e.src).catch(() => '');
ok(/cards\.scryfall\.io/.test(sheetImg), `its picture comes from Scryfall (${sheetImg.slice(0, 70)})`);
await P.screenshot({ path: `${OUT}/02-extra-card.png` });
await P.click('.card-sheet .dlg-actions button:has-text("Close")');
await P.click('.dlist-top button:has-text("Fill the rest with basic lands")');
ok(/Ready to play/.test(await P.textContent('.b-foot')), 'the deck is ready');
await P.waitForSelector('.b-status .saved:has-text("Saved on this device")', { timeout: 5000 });
await P.click('button:has-text("Back to decks")');
await P.close();

// ---- a fresh page plays it: the extra card loads before the game starts
const G = await open();
const got = [];
G.on('request', r => got.push(r.url()));
await G.goto(BASE + '#mtg');
await G.waitForSelector('text=Pick a deck, take a seat', { timeout: 60000 });
await G.click('.deckrow:has-text("Kozilek")');
await G.click('.seg button:has-text("1 vs 1")');
await G.click('button:has-text("Shuffle up")');
await G.waitForFunction(() => window.__paSession && window.__paSession.game && window.__paSession.game.turnNumber >= 0 && window.__paSession.game.players[0].library.length + window.__paSession.game.players[0].hand.length > 90, null, { timeout: 60000 });
ok(got.some(u => /data\/more\//.test(u)), 'the game loaded the rest of the card pool first');
const has = await G.evaluate(n => { const g = window.__paSession.game; return g.allCards().some(c => c.def.name === n && c.owner === 0); }, EXTRA);
ok(has, `${EXTRA} is in the game`);
await G.close();

// ---- a community deck plays with Scryfall pictures
const C = await open();
await C.goto(BASE + '#mtg');
await C.waitForSelector('text=Pick a deck, take a seat', { timeout: 60000 });
await C.click('.deckrow:has-text("the EDHREC average deck")');
await C.click('.seg button:has-text("1 vs 1")');
await C.click('button:has-text("Shuffle up")');
await C.waitForSelector('text=Your opening hand', { timeout: 60000 });
await C.waitForTimeout(2500);
const handImgs = await C.$$eval('.dialog img.cimg', is => is.map(i => i.src));
// (cards a precon also plays show its packed picture; the rest come from Scryfall)
ok(handImgs.length === 7, `every card in the opening hand has a picture (${handImgs.length})`);
ok(scry.length > 0, `Scryfall pictures were asked for (${scry.length})`);
await C.screenshot({ path: `${OUT}/03-community-hand.png` });

console.log(errors.length ? `errors:\n${errors.join('\n')}` : 'no page errors');
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail || errors.length ? 1 : 0);
