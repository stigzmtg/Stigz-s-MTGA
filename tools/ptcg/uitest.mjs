// Play a Pokémon battle through the screen like a person: click playable cards, pick targets, answer every
// dialog, attack, end turns. Fails on any page error or if the game stops moving.
// Usage: node tools/ptcg/uitest.mjs [out dir] [turns=14] [width=1440] [height=900]   (serve dist/ on :8765 first)
import { chromium } from 'playwright';
import fs from 'node:fs';
const [out = '/tmp/pkui', turns = '14', w = '1440', h = '900'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_TUNNEL/.test(m.text())) errors.push(m.text()); });
await page.addInitScript(() => { try { localStorage.setItem('pa-settings', JSON.stringify({ aiSpeed: 'instant' })); localStorage.setItem('pk-lobby', JSON.stringify({ mine: process.env.DECK || 'charizard', opp: 'random' })); } catch {} });
await page.goto('http://localhost:8765/#pokemon');
await page.waitForSelector('text=Pick a deck, start a battle');
if (process.env.DECK) await page.click(`.pk-deck:has-text("${process.env.DECK}")`);
await page.click('button:has-text("Battle!")');
await page.waitForSelector('.pk-board');
const turnNow = () => page.evaluate(() => +(document.querySelector('.topbar .turninfo b') || {}).textContent || 0);
let last = '', stuck = 0, clicks = 0, shots = 0;
const t0 = Date.now();
for (let i = 0; i < 3000 && Date.now() - t0 < 300000; i++) {
  const t = await turnNow();
  if (t >= +turns) break;
  if (await page.$('.dialog[aria-label="Game over"]')) { console.log('game over'); break; }
  const state = await page.evaluate(() => (document.querySelector('.pk-prompt') || {}).textContent + '|' + document.querySelectorAll('.dialog').length + '|' + document.querySelector('.pk-board').innerText.length);
  if (state === last) stuck++; else { stuck = 0; last = state; }
  if (stuck > 120) { console.log('STUCK at turn', t, state.slice(0, 200)); break; }
  const dlg = await page.$('.dialog');
  if (dlg) {
    // distribute damage counters
    const plus = await page.$$('.dialog .ctr .btn:has-text("+"):not([disabled])');
    if (plus.length) { await plus[0].click(); clicks++; const done = await page.$('.dialog .btn.primary:not([disabled])'); if (done) await done.click(); continue; }
    const picks = await page.$$('.dialog .pk-pick:not(.off):not(.on) .pk-card');
    const confirm = await page.$('.dialog .btn.primary:not([disabled])');
    if (confirm && (Math.random() < 0.5 || !picks.length)) { await confirm.click(); clicks++; continue; }
    if (picks.length) { await picks[Math.floor(Math.random() * picks.length)].click(); clicks++; continue; }
    const opt = await page.$('.dialog .pk-optlist .btn');
    if (opt) { await opt.click(); continue; }
    await page.waitForTimeout(50);
    continue;
  }
  const yes = await page.$('.pk-prompt .btn:has-text("Yes")');
  if (yes) { await (Math.random() < 0.8 ? yes : await page.$('.pk-prompt .btn:has-text("No")')).click(); continue; }
  const tgt = await page.$$('.pk-mon.targetable .pk-card');
  if (tgt.length) { await tgt[Math.floor(Math.random() * tgt.length)].click(); clicks++; const done = await page.$('.pk-prompt .btn.primary:has-text("Done"):not([disabled])'); if (done) await done.click(); continue; }
  const endBtn = await page.$('.pk-prompt .btn:has-text("End turn"), .pk-prompt .btn:has-text("End without")');
  if (endBtn) {
    if (shots < 3 && t >= 4) { await page.screenshot({ path: `${out}/turn-${t}.png` }); shots++; }
    const playable = await page.$$('.pk-handslot.playable .pk-card');
    const abil = await page.$$('.pk-prompt .btn.ability');
    if (playable.length && Math.random() < 0.85) { await playable[Math.floor(Math.random() * playable.length)].click(); clicks++; await page.waitForTimeout(30); continue; }
    if (abil.length && Math.random() < 0.5) { await abil[0].click(); clicks++; continue; }
    const atk = await page.$('.pk-prompt .btn.atk:not([disabled])');
    if (atk) { await atk.click(); clicks++; continue; }
    await endBtn.click(); await page.waitForTimeout(30);
    const again = await page.$('.pk-prompt .btn:has-text("End without")');
    if (again) await again.click();
    continue;
  }
  const opts = await page.$$('.pk-prompt .acts .btn:not([disabled])');
  if (opts.length && !(await page.$('.pk-prompt.waiting'))) { await opts[0].click(); continue; }
  await page.waitForTimeout(60);
}
const t = await turnNow();
await page.screenshot({ path: `${out}/final.png` });
console.log(`reached turn ${t}, ${clicks} clicks, ${((Date.now() - t0) / 1000).toFixed(0)}s`, errors.length ? 'ERRORS:\n' + errors.slice(0, 8).join('\n') : 'no page errors');
await browser.close();
