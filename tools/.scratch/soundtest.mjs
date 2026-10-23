import { chromium } from 'playwright';
const browser = await chromium.launch();
for (const game of ['pk', 'mtg']) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 800 } });
  await ctx.addInitScript(() => { window.__pkAutoplay = 6; window.__paAutoplay = 4; window.__paSoundTest = []; localStorage.setItem('pa-settings', JSON.stringify({ aiSpeed: 'fast' })); });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  if (game === 'pk') {
    await p.goto('http://localhost:8765/#pokemon'); await p.waitForSelector('.pk-lobby');
    await p.click('button:has-text("Battle!")'); await p.waitForSelector('.pk-board');
    await p.waitForFunction(() => +((document.querySelector('.topbar .turninfo b') || {}).textContent || 0) >= 6, null, { timeout: 120000 }).catch(() => {});
  } else {
    await p.goto('http://localhost:8765/#mtg'); await p.waitForSelector('text=Pick a precon', { timeout: 90000 });
    await p.click('button:has-text("Shuffle up")'); await p.waitForSelector('.topbar .turninfo');
    await p.waitForFunction(() => +((document.querySelector('.topbar .turninfo b') || {}).textContent || 0) >= 4, null, { timeout: 180000 }).catch(() => {});
  }
  const kinds = await p.evaluate(() => window.__paSoundTest);
  const counts = {}; for (const k of kinds) counts[k] = (counts[k] || 0) + 1;
  console.log(game, 'sounds played:', kinds.length, JSON.stringify(counts));
  await p.click('.soundbtn'); const before = await p.evaluate(() => window.__paSoundTest.length); await p.waitForTimeout(4000);
  const after = await p.evaluate(() => window.__paSoundTest.length);
  console.log(game, 'muted: sounds during 4s after muting:', after - before, '| speaker shows', await p.getAttribute('.soundbtn', 'aria-pressed'), '| saved', await p.evaluate(() => JSON.parse(localStorage.getItem('pa-settings')).sound));
  console.log(game, errs.length ? errs : 'no page errors');
  await ctx.close();
}
await browser.close();
