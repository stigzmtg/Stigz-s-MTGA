// Play a One Piece battle through the screen like a person: answer the opening questions, play cards, give DON!!,
// attack, block and Counter when attacked, use Triggers, end turns. Fails on any page error or if the game stops moving.
// Usage: node tools/optcg/uitest.mjs [out dir] [turns=12] [width=1440] [height=900]   (serve dist/ on :8765 first)
// DECK=st01 OPP=st02 pick the decks. MOBILE=1 plays on a touch screen (taps open menus). REPLAY=1 also checks the replay.
import { chromium } from 'playwright';
import fs from 'node:fs';
const [out = '/tmp/opui', turns = '12', w = '1440', h = '900'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: +w, height: +h }, ...(process.env.MOBILE ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
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
// a card a person can't click (covered by something) is a bug: report what covers it, with a screenshot
let covered = 0;
const safeClick = async el => {
  try { await el.click({ timeout: 4000 }); return true; } catch (e) {
    const info = await el.evaluate(n => { const b = n.getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + b.height / 2; const top = document.elementFromPoint(x, y); const side = n.closest('.op-side'); const sb = side && side.getBoundingClientRect(); return `card ${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}x${Math.round(b.height)} in ${side && side.className} (${sb && `${Math.round(sb.top)}..${Math.round(sb.bottom)}`}) covered by ${top && top.className} ${top && top.closest('.op-mid') ? `mid ${Math.round(top.closest('.op-mid').getBoundingClientRect().top)}..${Math.round(top.closest('.op-mid').getBoundingClientRect().bottom)}` : ''}`; }).catch(() => 'gone');
    if (info !== 'gone') { covered++; errors.push('covered: ' + info); await page.screenshot({ path: `${out}/covered-${covered}.png` }); }
    return false;
  }
};
const seenKinds = new Set();
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
  if (process.env.SHOTS) {
    const kind = await page.evaluate(() => { const d = document.querySelector('.dialog'); if (d) return 'dialog-' + (d.querySelector('h2') || {}).textContent; const st = (document.querySelector('.op-prompt .step') || {}).textContent || ''; const txt = (document.querySelector('.op-prompt .txt') || {}).textContent || ''; if (document.querySelector('.op-prompt .op-num')) return 'number'; if (/Yes/.test((document.querySelector('.op-prompt .acts') || {}).textContent || '')) return 'confirm'; if (st) return 'bar-' + st.split(' ·')[0]; return txt ? 'bar-other' : ''; });
    const key = kind.replace(/[^\w-]+/g, '_').slice(0, 40);
    if (key && !seenKinds.has(key)) { seenKinds.add(key); await page.waitForTimeout(700); await page.screenshot({ path: `${process.env.SHOTS}/${key}.png` }); }
  }
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
    if (cs.length && Math.random() < 0.5) { await rnd(cs).click({ position: { x: 8, y: 30 } }); counters++; continue; }
    await page.click('.op-prompt .btn.primary'); continue;
  }
  if (/Block/.test(step)) {
    const bl = await page.$$('.op-slot.targetable .op-card');
    if (bl.length && Math.random() < 0.5) { await safeClick(rnd(bl)); continue; }
    await page.click('.op-prompt .btn.primary'); continue;
  }
  if (await page.$('.op-prompt .op-num')) {
    if (Math.random() < 0.3) await page.click(`.op-prompt .op-num .btn[aria-label="${Math.random() < 0.5 ? 'Less' : 'More'}"]`);
    else await page.click('.op-prompt .op-num .btn.primary');
    continue;
  }
  const yes = await page.$('.op-prompt .btn:has-text("Yes")');
  if (yes) { await (Math.random() < 0.8 ? yes : await page.$('.op-prompt .btn:has-text("No")')).click(); continue; }
  const tgt = await page.$$('.op-slot.targetable .op-card');
  if (tgt.length) {
    await safeClick(rnd(tgt)); clicks++;
    const done = await page.$('.op-prompt .btn.primary:has-text("Done"):not([disabled])'); if (done && Math.random() < 0.6) await done.click();
    continue;
  }
  const endBtn = await page.$('.op-prompt .btn:has-text("End turn")');
  if (endBtn) {
    if (shots < 3 && t >= 4) { await page.screenshot({ path: `${out}/turn-${t}.png` }); shots++; }
    const playable = await page.$$('.op-handslot.playable .op-card');
    if (playable.length && Math.random() < 0.8) { await rnd(playable).click({ position: { x: 8, y: 30 } }); plays++; clicks++; await page.waitForTimeout(30); continue; }
    const give = await page.$('.op-prompt .btn:has-text("Give DON!!")');
    if (give && Math.random() < 0.5) { await give.click(); await page.waitForTimeout(30); const tg = await page.$$('.op-slot.targetable .op-card'); if (tg.length && await safeClick(rnd(tg))) dons++; continue; }
    const can = await page.$$('.op-side.me .op-slot.can .op-card');
    if (can.length && Math.random() < 0.85) {
      await safeClick(rnd(can)); await page.waitForTimeout(40);
      const atk = await page.$('.menu .mi:has-text("Attack")');
      if (atk) { await atk.click(); await page.waitForTimeout(40); const tg = await page.$$('.op-side.opp .op-slot.targetable .op-card'); if (tg.length && await safeClick(rnd(tg))) attacks++; }
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
// REPLAY=1: watch the finished game's replay and check it ends exactly the same way
const boardSummary = () => page.evaluate(() => [...document.querySelectorAll('.op-side')].map(s => [s.querySelector('.op-life .cap b').textContent, [...s.querySelectorAll('.op-piles .pile b')].map(b => b.textContent).join('/'), [...s.querySelectorAll('.op-slot:not(.empty)')].length].join(' ')).join(' | ') + ' :: ' + (document.querySelector('.dialog[aria-label="Game over"] h2') || {}).textContent);
let replayNote = '';
if (process.env.REPLAY && await page.$('.dialog[aria-label="Game over"]')) {
  const before = await boardSummary();
  await page.click('.dialog .btn:has-text("Watch replay")');
  await page.waitForSelector('.replaybar, [aria-label="Replay speed"]');
  await page.click('[aria-label="Replay speed"] button:has-text("4×")');
  await page.waitForSelector('.dialog[aria-label="Game over"]', { timeout: 600000 });
  await page.waitForTimeout(1500);
  const after = await boardSummary();
  replayNote = before === after ? 'replay matches' : `REPLAY DIFFERS:\n  game   ${before}\n  replay ${after}`;
  if (before !== after) errors.push('replay differs');
}
if (replayNote) console.log(replayNote);
console.log(`reached turn ${t}, ${clicks} clicks (${plays} plays, ${dons} DON!!, ${attacks} attacks, ${counters} counters), ${((Date.now() - t0) / 1000).toFixed(0)}s`, errors.length ? 'ERRORS:\n' + errors.slice(0, 8).join('\n') : 'no page errors');
await browser.close();
process.exit(errors.length ? 1 : 0);
