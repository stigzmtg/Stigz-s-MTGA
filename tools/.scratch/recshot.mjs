import { chromium } from 'playwright';
const OUT = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
await ctx.addInitScript(() => { window.__pkAutoplay = 999; localStorage.setItem('pa-settings', JSON.stringify({ aiSpeed: 'instant', sound: false })); });
const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
for (let g = 0; g < 2; g++) {
  await p.goto('http://localhost:8765/#pokemon'); await p.reload(); await p.waitForSelector('.pk-lobby');
  if (g) await p.click('.pk-deck:has-text("Gardevoir")');
  await p.click('button:has-text("Battle!")'); await p.waitForSelector('.dialog[aria-label="Game over"]', { timeout: 240000 });
}
await p.goto('http://localhost:8765/'); await p.reload(); await p.waitForSelector('.rec-list li');
await p.locator('#record').scrollIntoViewIfNeeded(); await p.waitForTimeout(500);
await p.locator('section.record').screenshot({ path: `${OUT}/record.png` });
console.log('records listed:', await p.locator('.rec-list li').count());
await p.click('.rec-list li >> nth=0 >> button:has-text("Watch replay")');
await p.waitForSelector('.replaybar', { timeout: 60000 }); await p.waitForTimeout(2500);
await p.locator('.topbar').screenshot({ path: `${OUT}/replaybar.png` });
console.log('replay opened from home');
await p.click('.replaybar button[aria-label="Pause"]'); const a = await p.textContent('.replaypos'); await p.waitForTimeout(2500); const b = await p.textContent('.replaypos');
console.log('paused keeps position:', a === b, a);
await p.click('.replaybar button:has-text("Next move")'); await p.waitForTimeout(1200); console.log('next move advances:', await p.textContent('.replaypos'));
await p.click('.topbar button:has-text("Close replay")'); await p.waitForSelector('.pk-lobby');
console.log('deck record in lobby:', await p.textContent('.deckrec').catch(() => 'none'));
console.log(errs.length ? errs : 'no page errors');
await browser.close();
