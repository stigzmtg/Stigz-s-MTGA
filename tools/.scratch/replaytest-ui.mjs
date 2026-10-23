// finish a game, watch its replay at 4x, and require the same ending
import { chromium } from 'playwright';
const browser = await chromium.launch();
let failed = false;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed = true; };
const errs = [];
// ---- Pokémon: the computer plays your whole battle
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 800 } });
  await ctx.addInitScript(() => { window.__pkAutoplay = 999; localStorage.setItem('pa-settings', JSON.stringify({ aiSpeed: 'instant', sound: false })); });
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push('pk: ' + e.message));
  await p.goto('http://localhost:8765/#pokemon'); await p.waitForSelector('.pk-lobby');
  await p.click('button:has-text("Battle!")');
  await p.waitForSelector('.dialog[aria-label="Game over"]', { timeout: 240000 });
  const end = async () => p.evaluate(() => ({ title: document.querySelector('.dialog[aria-label="Game over"] h2').textContent, sub: document.querySelector('.dialog[aria-label="Game over"] .sub').textContent, sides: [...document.querySelectorAll('.pk-side')].map(s => s.querySelector('.pk-prizes .cap b').textContent + '|' + [...s.querySelectorAll('.pk-mon:not(.empty) .pk-card')].map(c => c.getAttribute('title')).join(',') + '|' + [...s.querySelectorAll('.pk-piles .pile b')].map(b => b.textContent).join('/')) }));
  const a = await end();
  console.log('pokemon original:', a.title, '·', a.sub);
  await p.click('.dialog button:has-text("Watch replay")');
  await p.waitForSelector('.replaybar');
  check(true, 'pokemon replay opens with its controls');
  await p.click('.replaybar .seg button:has-text("4×")');
  const t0 = Date.now();
  await p.waitForSelector('.dialog[aria-label="Game over"]', { timeout: 600000 });
  const b = await end();
  console.log(`pokemon replay finished in ${((Date.now() - t0) / 1000).toFixed(0)}s:`, b.title, '·', b.sub);
  check(JSON.stringify(a) === JSON.stringify(b), 'pokemon replay ends exactly like the battle');
  const rec = await p.evaluate(() => JSON.parse(localStorage.getItem('pa-records') || '[]'));
  check(rec.length === 1 && rec[0].kind === 'pk' && rec[0].replay, `one Pokémon record saved (${rec.length}), not a second one for the replay`);
  await ctx.close();
}
// ---- Commander: two turns by the computer, then you take 40 life off yourself with the manual tool
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 800 } });
  await ctx.addInitScript(() => { window.__paAutoplay = 3; localStorage.setItem('pa-settings', JSON.stringify({ aiSpeed: 'instant', sound: false })); });
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push('mtg: ' + e.message));
  await p.goto('http://localhost:8765/#mtg'); await p.waitForSelector('text=Pick a precon', { timeout: 90000 });
  await p.click('button:has-text("Shuffle up")'); await p.waitForSelector('.topbar .turninfo');
  await p.waitForFunction(() => +((document.querySelector('.topbar .turninfo b') || {}).textContent || 0) >= 3, null, { timeout: 180000 });
  // wait until it's your decision, then use the tool
  await p.waitForSelector('.prompt .acts .btn', { timeout: 120000 });
  const mine = p.locator('section.mat', { has: p.locator('.pname', { hasText: /^You/ }) });
  for (let i = 0; i < 8; i++) {
    await mine.locator('.lifetotal').first().click();
    await p.click('.menu button:has-text("−5 life")');
    await p.waitForTimeout(150);
  }
  // pass so the game checks the life total
  for (let i = 0; i < 20 && !(await p.$('.dialog[aria-label="Game over"]')); i++) { const b = await p.$('.prompt .acts .btn.primary, .prompt .acts .btn'); if (b) await b.click().catch(() => {}); await p.waitForTimeout(400); }
  await p.waitForSelector('.dialog[aria-label="Game over"]', { timeout: 60000 });
  const end = async () => p.evaluate(() => ({ title: document.querySelector('.dialog[aria-label="Game over"] h2').textContent, standings: [...document.querySelectorAll('.standings li')].map(li => li.textContent) }));
  const a = await end();
  console.log('commander original:', JSON.stringify(a));
  await p.click('.dialog button:has-text("Watch replay")');
  await p.waitForSelector('.replaybar');
  await p.click('.replaybar .seg button:has-text("4×")');
  const t0 = Date.now();
  await p.waitForSelector('.dialog[aria-label="Game over"]', { timeout: 600000 });
  const b = await end();
  console.log(`commander replay finished in ${((Date.now() - t0) / 1000).toFixed(0)}s:`, JSON.stringify(b));
  check(JSON.stringify(a) === JSON.stringify(b), 'commander replay, including the manual life changes, ends exactly like the game');
  await ctx.close();
}
check(!errs.length, errs.length ? errs.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
