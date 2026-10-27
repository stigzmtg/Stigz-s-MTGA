// Playing cards from somewhere other than your hand, in a real browser: a flashback spell in your graveyard and the
// top of your library (Elven Chorus: look at it any time, cast it if it's a creature) sit after your hand,
// marked with where they are, and play with a click; the graveyard viewer lets you cast it too.
// Usage: node tools/elsewhereui.mjs [out dir]   (serve dist/ on :8765 first)
import fs from 'node:fs';
import { chromium } from 'playwright';

const OUT = process.argv[2] || '/tmp/elsewhereui';
fs.mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
await page.addInitScript(() => {
  window.__paAutoplay = 4; window.__paExpose = true;
  try { localStorage.setItem('pa-settings', JSON.stringify({ aiSpeed: 'instant' })); localStorage.setItem('pa-tips', JSON.stringify({ mtg: { off: true, seen: [] } })); } catch { /* blocked */ }
});
await page.goto('http://localhost:8765/#mtg');
await page.waitForSelector('text=Pick a deck, take a seat', { timeout: 60000 });
await page.click('.seg button:has-text("1 vs 1")');
await page.click('button:has-text("Shuffle up")');
const myMain = () => page.waitForFunction(() => {
  const s = window.__paSession, g = s && s.game;
  return g && g.turnNumber >= 4 && g.activePlayer === s.human.pid && g.isMainPhase() && !g.stack.length && s.human.pending && s.human.pending.req.type === 'priority';
}, null, { timeout: 180000 }).catch(async e => {
  console.log('state:', await page.evaluate(() => { const s = window.__paSession, g = s && s.game; return g && { turn: g.turnNumber, active: g.activePlayer, step: g.step, stack: g.stack.length, pending: s.human.pending && s.human.pending.req.type, over: g.over }; }));
  await page.screenshot({ path: `${OUT}/stuck.png` });
  throw e;
});
await myMain();
// put cards where we want them (the table updates as after any move)
const setUp = (cards) => page.evaluate(cs => {
  const s = window.__paSession, g = s.game, me = s.human.pid;
  for (const [name, zone] of cs) {
    const c = g.newCard(g.db.get(name), me);
    if (zone === 'battlefield') { c.zone = 'battlefield'; c.controller = me; g.battlefield.push(c); }
    else if (zone === 'library') { c.zone = 'library'; g.players[me].library.unshift(c); }
    else { c.zone = zone; g.players[me][zone].push(c); }
  }
  g.players[me].pool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
  g.touch(); s.human.pending && s.human.pending.req && (s.human.pending.req = { ...s.human.pending.req }); s.store.bump();
}, cards);

// ---- flashback from the graveyard
await setUp([['Think Twice', 'graveyard']]);
await page.waitForSelector('.handslot.elsewhere', { timeout: 10000 }).catch(() => {});
const strip = await page.$$eval('.handslot.elsewhere', xs => xs.map(x => ({ from: x.querySelector('.from').textContent, playable: !!x.querySelector('.card.playable') })));
ok(strip.some(x => /Graveyard/.test(x.from) && x.playable), `Think Twice shows after your hand, from the graveyard, ready to cast (${JSON.stringify(strip)})`);
await page.screenshot({ path: `${OUT}/1-flashback-strip.png` });
const before = await page.evaluate(() => window.__paSession.game.players[window.__paSession.human.pid].graveyard.length);
await page.click('.handslot.elsewhere .card.playable');
await page.waitForTimeout(400);
const item = await page.waitForSelector('.menu .mi.cast', { timeout: 1500 }).catch(() => null);
if (item) await item.click();
await page.waitForFunction(n => { const s = window.__paSession, g = s.game; return g.players[s.human.pid].graveyard.length < n || g.stack.length > 0; }, before, { timeout: 10000 }).catch(() => {});
const cast = await page.evaluate(() => { const s = window.__paSession, g = s.game; return { stack: g.stack.map(x => g.name(x.card)), log: g.logs.slice(-6).map(l => l.text) }; });
ok(cast.stack.includes('Think Twice') || cast.log.some(l => /casts Think Twice/.test(l)), `a click casts it with flashback (${JSON.stringify(cast)})`);
await page.screenshot({ path: `${OUT}/2-flashback-cast.png` });
// let it resolve and come back to your main phase
await page.evaluate(() => { window.__paAutoplay = 0; });
for (let k = 0; k < 6; k++) { const b = await page.$('.prompt .acts .btn.primary:not([disabled])'); if (!(await page.evaluate(() => window.__paSession.game.stack.length))) break; if (b) await b.click().catch(() => {}); await page.waitForTimeout(400); }
ok(await page.evaluate(() => { const s = window.__paSession, g = s.game; return g.players[s.human.pid].exile.some(c => c.def.name === 'Think Twice'); }), 'and it is exiled after (flashback)');

// ---- the top of your library with Elven Chorus
await myMain();
await setUp([['Elven Chorus', 'battlefield'], ['Wood Elves', 'library']]);
await page.waitForTimeout(500);
const top = await page.$$eval('.handslot.elsewhere', xs => xs.map(x => ({ from: x.querySelector('.from').textContent, name: (x.querySelector('.card') || {}).getAttribute && x.querySelector('.card').getAttribute('aria-label'), playable: !!x.querySelector('.card.playable') })));
ok(top.some(x => /Top of library/.test(x.from) && x.playable), `the top card (a creature) shows and can be cast (${JSON.stringify(top)})`);
await page.screenshot({ path: `${OUT}/3-top-of-library.png` });
const geo = await page.evaluate(() => { const h = document.querySelector('.hand'), r = h.getBoundingClientRect(), kids = [...h.children].map(k => k.getBoundingClientRect()); const cs = getComputedStyle(h); return { hand: [Math.round(r.left), Math.round(r.right)], first: Math.round(kids[0].left), last: Math.round(kids[kids.length - 1].right), view: innerWidth, n: kids.length, widths: kids.map(k => Math.round(k.width)).join(','), lefts: kids.map(k => Math.round(k.left)).join(','), gap: h.style.getPropertyValue('--gap'), pad: cs.paddingLeft + ' ' + cs.paddingRight, cw: getComputedStyle(document.documentElement).getPropertyValue('--hand-w'), client: h.clientWidth }; });
ok(geo.first >= geo.hand[0] - 2 && geo.last <= geo.hand[1] + 2, `the hand and the extra cards fit in the hand's space (${JSON.stringify(geo)})`);
// a noncreature on top: you may look at it, not cast it
await setUp([['Cultivate', 'library']]);
await page.waitForTimeout(500);
const top2 = await page.$$eval('.handslot.elsewhere', xs => xs.map(x => ({ from: x.querySelector('.from').textContent, playable: !!x.querySelector('.card.playable') })));
ok(top2.some(x => /Top of library/.test(x.from) && !x.playable), `a noncreature on top is shown, not castable (${JSON.stringify(top2)})`);

// ---- the graveyard viewer plays a card too
await setUp([['Deep Analysis', 'graveyard']]);
await page.waitForTimeout(400);
await page.click(`[data-pile="${await page.evaluate(() => window.__paSession.human.pid)}:graveyard"]`);
await page.waitForSelector('.dialog .dlg-cards');
const glow = await page.$$('.dialog .dlg-cards .card.playable');
ok(glow.length >= 1, `the graveyard viewer lights up what you can play (${glow.length})`);
await page.screenshot({ path: `${OUT}/4-graveyard-dialog.png` });
if (glow[0]) await glow[0].click();
await page.waitForTimeout(400);
ok(!(await page.$('.dialog .dlg-cards')), 'clicking it closes the viewer to play it');
await page.screenshot({ path: `${OUT}/4b-after-click.png` });
console.log('after click:', JSON.stringify(await page.evaluate(() => ({ prompt: (document.querySelector('.prompt') || {}).textContent, dialog: (document.querySelector('.overlay .dialog') || {}).textContent, menu: [...document.querySelectorAll('.menu .item')].map(x => x.textContent) }))));
const it2 = await page.waitForSelector('.menu .mi.cast', { timeout: 1500 }).catch(() => null);
if (it2) await it2.click();
// (Deep Analysis targets a player: you)
const plate = await page.$('.mat.bottom.targetable .plate, .mat.targetable .plate');
if (plate) { await plate.click(); await page.waitForTimeout(200); const c = await page.$('.prompt .btn.primary:not([disabled])'); if (c) await c.click(); }
await page.waitForTimeout(800);
ok(await page.evaluate(() => { const g = window.__paSession.game; return g.stack.some(x => g.name(x.card) === 'Deep Analysis') || g.logs.slice(-8).some(l => /casts Deep Analysis/.test(l.text)); }), 'and it is cast');

// ---- on a phone the strip fits
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
ok(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), 'no sideways scrolling on a phone');
await page.screenshot({ path: `${OUT}/5-phone.png` });

console.log(errors.length ? `errors:\n${errors.join('\n')}` : 'no page errors');
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail || errors.length ? 1 : 0);
