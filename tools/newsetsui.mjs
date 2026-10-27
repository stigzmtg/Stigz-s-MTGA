// The recent sets' mechanics at the table, in a real browser (src/engine/mech-newsets.js): day / night, the Ring and
// an enduring story show in the players' status chips, and a waterbend cost asks which artifacts and creatures to tap.
// Usage: node tools/newsetsui.mjs [port=8813] [out dir]   (serve dist/ first: node tools/serve-test.mjs 8813)
import fs from 'node:fs';
import { chromium } from 'playwright';

const PORT = +(process.argv[2] || 8813);
const OUT = process.argv[3] || '/tmp/newsetsui';
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
await page.goto(`http://localhost:${PORT}/#mtg`);
await page.waitForSelector('text=Pick a deck, take a seat', { timeout: 60000 });
await page.click('.seg button:has-text("1 vs 1")');
await page.click('button:has-text("Shuffle up")');
const myMain = () => page.waitForFunction(() => {
  const s = window.__paSession, g = s && s.game;
  return g && g.turnNumber >= 4 && g.activePlayer === s.human.pid && g.isMainPhase() && !g.stack.length && s.human.pending && s.human.pending.req.type === 'priority';
}, null, { timeout: 180000 }).catch(async e => { await page.screenshot({ path: `${OUT}/stuck.png` }); throw e; });
await myMain();
await page.evaluate(() => { window.__paAutoplay = 0; });
// the rest of the card pool (the Avatar cards aren't in the precons' data)
await page.evaluate(async () => {
  const db = window.__paSession.game.db;
  const m = await (await fetch('data/more.json')).json();
  for (let i = 0; i < m.shards; i++) db.add(await (await fetch(`data/more/cards-${i}.json`)).json());
});
const bump = () => page.evaluate(() => { const s = window.__paSession; s.game.touch(); s.human.pending && s.human.pending.req && (s.human.pending.req = { ...s.human.pending.req }); s.store.bump(); });

// ---- night in the top bar; status chips for the Ring and its Ring-bearer, an enduring story (an opponent's plate shows them)
await page.evaluate(() => {
  const s = window.__paSession, g = s.game, me = s.human.pid, p = g.players[me];
  const c = g.newCard(g.db.get('Grizzly Bears'), me); c.zone = 'battlefield'; c.controller = me; g.battlefield.push(c);
  g.dayNight = 'Night'; p.ringTempted = 2; p.ringBearer = { id: c.id, zcc: c.zcc }; p.enduringStory = true;
  const o = g.players.find(x => x.id !== me); o.ringTempted = 1; o.enduringStory = true;
});
await bump();
await page.waitForTimeout(400);
const chips = await page.$$eval('.status .chip', xs => xs.map(x => ({ text: x.textContent, title: x.getAttribute('title') || '' })));
const dn = await page.evaluate(() => { const el = document.querySelector('.topbar .turninfo .daynight'); return el && { text: el.textContent, title: el.getAttribute('title') }; });
ok(dn && /Night/.test(dn.text) && /two or more spells/.test(dn.title), `night shows in the top bar (${JSON.stringify(dn)})`);
ok(chips.some(c => /Ring 2/.test(c.text) && /Grizzly Bears/.test(c.text) && /draw a card, then discard/.test(c.title)), 'a Ring chip with its level, Ring-bearer and abilities');
ok(chips.some(c => /Enduring story/.test(c.text)), 'an enduring story chip');
const oppChips = await page.$$eval('.mat:not(.bottom) .status .chip', xs => xs.filter(x => x.offsetParent !== null).map(x => x.textContent));
ok(oppChips.some(t => /Ring 1/.test(t)) && oppChips.some(t => /Enduring story/.test(t)), `an opponent's Ring and story chips are visible on their plate (${JSON.stringify(oppChips)})`);
await page.screenshot({ path: `${OUT}/1-chips.png` });

// ---- waterbend: Geyser Leaper's "Waterbend {4}: draw a card, then discard a card", paid with two creatures and {2}
await page.evaluate(() => {
  const s = window.__paSession, g = s.game, me = s.human.pid, p = g.players[me];
  for (const c of g.battlefield) if (c.controller === me) c.tapped = true;
  for (const n of ['Geyser Leaper', 'Grizzly Bears', 'Llanowar Elves']) { const c = g.newCard(g.db.get(n), me); c.zone = 'battlefield'; c.controller = me; c.sick = false; g.battlefield.push(c); }
  p.pool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 2 };
});
await bump();
await page.waitForTimeout(400);
await page.evaluate(() => { const el = [...document.querySelectorAll('.card')].find(x => x.getAttribute('aria-label') === 'Geyser Leaper'); el && el.click(); });
await page.waitForSelector('.menu', { timeout: 5000 }).catch(() => {});
const items = await page.$$eval('.menu .mi', xs => xs.map(x => x.textContent));
ok(items.some(t => /Draw a card/.test(t)), `the Leaper offers its waterbend ability (${JSON.stringify(items)})`);
await page.evaluate(() => { const b = [...document.querySelectorAll('.menu .mi')].find(x => /Draw a card/.test(x.textContent)); b && b.click(); });
await page.waitForSelector('.dialog h2:has-text("Waterbend")', { timeout: 5000 }).catch(() => {});
const dlg = await page.evaluate(() => { const m = document.querySelector('.dialog'); return m ? { h: m.querySelector('h2').textContent, sub: m.querySelector('.sub').textContent, n: m.querySelectorAll('.dlg-cards > *').length } : null; });
ok(dlg && /Waterbend/.test(dlg.h) && /tap artifacts and creatures/.test(dlg.sub) && dlg.n >= 3, `the waterbend dialog asks which to tap (${JSON.stringify(dlg)})`);
await page.screenshot({ path: `${OUT}/2-waterbend.png` });
// pick the Bears and the Leaper itself
await page.evaluate(() => {
  const picks = [...document.querySelectorAll('.dialog .dlg-cards > *')];
  for (const name of ['Grizzly Bears', 'Geyser Leaper']) { const el = picks.find(x => (x.querySelector('[aria-label]') || x).getAttribute('aria-label') === name || x.textContent.includes(name)); el && (el.querySelector('.card') || el).click(); }
});
await page.waitForTimeout(200);
await page.click('.dialog .btn.primary:not([disabled])', { timeout: 3000 }).catch(() => {});
// the ability goes on the stack: let it resolve (discard what it asks)
for (let k = 0; k < 12; k++) {
  const st = await page.evaluate(() => { const s = window.__paSession; const r = s.human.pending && s.human.pending.req; return { type: r && r.type, stack: s.game.stack.length }; });
  if (st.type === 'cards') { await page.evaluate(() => { const el = document.querySelector('.dialog .dlg-cards > *'); el && (el.querySelector('.card') || el).click(); }); await page.waitForTimeout(150); await page.click('.dialog .btn.primary:not([disabled])', { timeout: 3000 }).catch(() => {}); }
  else if (st.type === 'priority' && st.stack) await page.click('.prompt .acts .btn.primary:not([disabled])', { timeout: 3000 }).catch(() => {});
  else if (st.type === 'priority') break;
  await page.waitForTimeout(300);
}
const res = await page.evaluate(() => { const s = window.__paSession, g = s.game, me = s.human.pid; const by = n => g.battlefield.find(c => c.controller === me && c.def.name === n); return { bears: g.battlefield.filter(c => c.controller === me && c.def.name === 'Grizzly Bears').map(c => c.tapped), leaper: by('Geyser Leaper').tapped, elf: by('Llanowar Elves').tapped, pool: g.players[me].pool.C, log: g.logs.slice(-12).map(l => l.text) }; });
ok(res.leaper && res.bears.some(Boolean) && !res.elf && res.pool === 0, `the chosen creatures tapped, {2} paid from the pool (${JSON.stringify(res)})`);
ok(res.log.some(l => /waterbends/.test(l)) && res.log.some(l => /draws|discards/.test(l)), 'the log tells the story');
await page.screenshot({ path: `${OUT}/3-after.png` });

ok(!errors.length, `no page errors (${errors.slice(0, 3).join(' | ')})`);
await browser.close();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
