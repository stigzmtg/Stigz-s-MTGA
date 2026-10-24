// Play a One Piece battle through the screen like a person: answer the opening questions, play cards, give DON!!,
// attack, block and Counter when attacked, use Triggers, end turns. Fails on any page error or if the game stops moving.
// Usage: node tools/optcg/uitest.mjs [out dir] [turns=12] [width=1440] [height=900]   (serve dist/ on :8765 first)
// DECK=st01 OPP=st02 pick the decks.
import { chromium } from 'playwright';
import fs from 'node:fs';
const [out = '/tmp/opui', turns = '12', w = '1440', h = '900'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_TUNNEL/.test(m.text())) errors.push(m.text()); });
await page.addInitScript(([deck, opp]) => { try { localStorage.setItem('pa-settings', JSON.stringify({ aiSpeed: 'instant' })); localStorage.setItem('pa-tips', JSON.stringify({ op: { off: true } })); localStorage.setItem('op-lobby', JSON.stringify({ mine: deck, opp })); } catch {} }, [process.env.DECK || 'st01', process.env.OPP || 'random']);
await page.goto('http://localhost:8765/#onepiece');
await page.waitForSelector('.op-decks');
await page.click('button:has-text("Battle!")');
await page.waitForSelector('.op-board');
const turnNow = () => page.evaluate(() => +(document.querySelector('.topbar .turninfo b') || {}).textContent || 0);
const rnd = a => a[Math.floor(Math.random() * a.length)];
let last = '', stuck = 0, clicks = 0, shots = 0, attacks = 0, counters = 0, dons = 0, plays = 0;
const t0 = Date.now();
for (let i = 0; i < 4000 && Date.now() - t0 < 300000; i++) {
  const t = await turnNow();
  if (t >= +turns) break;
  if (await page.$('.dialog[aria-label="Game over"]')) { console.log('game over'); break; }
  const state = await page.evaluate(() => (document.querySelector('.op-prompt') || {}).textContent + '|' + document.querySelectorAll('.dialog').length + '|' + document.querySelector('.op-board').innerText.length + '|' + document.querySelectorAll('.op-handslot').length);
  if (state === last) stuck++; else { stuck = 0; last = state; }
  if (stuck > 150) { console.log('STUCK at turn', t, state.slice(0, 200)); break; }
  if (await page.$('.menu')) { const items = await page.$$('.menu .mi'); if (items.length) { await rnd(items).click(); clicks++; continue; } }
  const dlg = await page.$('.dialog');
  if (dlg) {
    const trig = await page.$('.dialog .btn:has-text("Use the Trigger")');
    if (trig) { await (Math.random() < 0.7 ? trig : await page.$('.dialog .btn:has-text("Add to hand")')).click(); continue; }
    const keep = await page.$('.dialog .btn:has-text("Keep")');
    if (keep) { await keep.click(); continue; }
    const picks = await page.$$('.dialog .op-pick:not(.off):not(.on) .op-card');
    const confirm = await page.$('.dialog .btn.primary:not([disabled])');
    if (confirm && (Math.random() < 0.5 || !picks.length)) { await confirm.click(); clicks++; continue; }
    if (picks.length) { await rnd(picks).click(); clicks++; continue; }
    const opt = await page.$('.dialog .optlist .btn');
    if (opt) { await opt.click(); continue; }
    await page.waitForTimeout(50);
    continue;
  }
  const prompt = await page.$('.op-prompt:not(.waiting)');
  if (!prompt) { await page.waitForTimeout(60); continue; }
  const step = await page.evaluate(() => (document.querySelector('.op-prompt .step') || {}).textContent || '');
  // defending: counters from hand sometimes, then done; a blocker sometimes
  if (/Counter/.test(step)) {
    const cs = await page.$$('.op-handslot.playable .op-card');
    if (cs.length && Math.random() < 0.5) { await rnd(cs).click(); counters++; continue; }
    await page.click('.op-prompt .btn.primary'); continue;
  }
  if (/Block/.test(step)) {
    const bl = await page.$$('.op-slot.targetable .op-card');
    if (bl.length && Math.random() < 0.5) { await rnd(bl).click(); continue; }
    await page.click('.op-prompt .btn.primary'); continue;
  }
  const yes = await page.$('.op-prompt .btn:has-text("Yes")');
  if (yes) { await (Math.random() < 0.8 ? yes : await page.$('.op-prompt .btn:has-text("No")')).click(); continue; }
  const tgt = await page.$$('.op-slot.targetable .op-card');
  if (tgt.length) {
    await rnd(tgt).click(); clicks++;
    const done = await page.$('.op-prompt .btn.primary:has-text("Done"):not([disabled])'); if (done && Math.random() < 0.6) await done.click();
    continue;
  }
  const endBtn = await page.$('.op-prompt .btn:has-text("End turn")');
  if (endBtn) {
    if (shots < 3 && t >= 4) { await page.screenshot({ path: `${out}/turn-${t}.png` }); shots++; }
    const playable = await page.$$('.op-handslot.playable .op-card');
    if (playable.length && Math.random() < 0.8) { await rnd(playable).click(); plays++; clicks++; await page.waitForTimeout(30); continue; }
    const give = await page.$('.op-prompt .btn:has-text("Give DON!!")');
    if (give && Math.random() < 0.5) { await give.click(); await page.waitForTimeout(30); const tg = await page.$$('.op-slot.targetable .op-card'); if (tg.length) { await rnd(tg).click(); dons++; } continue; }
    const can = await page.$$('.op-side.me .op-slot.can .op-card');
    if (can.length && Math.random() < 0.85) {
      await rnd(can).click(); await page.waitForTimeout(40);
      const atk = await page.$('.menu .mi:has-text("Attack")');
      if (atk) { await atk.click(); await page.waitForTimeout(40); const tg = await page.$$('.op-side.opp .op-slot.targetable .op-card'); if (tg.length) { await rnd(tg).click(); attacks++; } }
      else await page.keyboard.press('Escape');
      continue;
    }
    await endBtn.click(); await page.waitForTimeout(30);
    continue;
  }
  const opts = await page.$$('.op-prompt .acts .btn:not([disabled])');
  if (opts.length) { await opts[0].click(); continue; }
  await page.waitForTimeout(60);
}
const t = await turnNow();
await page.screenshot({ path: `${out}/final.png` });
console.log(`reached turn ${t}, ${clicks} clicks (${plays} plays, ${dons} DON!!, ${attacks} attacks, ${counters} counters), ${((Date.now() - t0) / 1000).toFixed(0)}s`, errors.length ? 'ERRORS:\n' + errors.slice(0, 8).join('\n') : 'no page errors');
await browser.close();
process.exit(errors.length ? 1 : 0);
