// Drive the UI in headless Chromium: start a game and play through several turns by clicking.
import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT = process.argv[2] || '/tmp/uitest';
const STEPS = +(process.argv[3] || 120);
const width = +(process.argv[4] || 1400), height = +(process.argv[5] || 900);
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width, height } });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto('http://localhost:8765/');
await page.waitForSelector('text=Pick a precon', { timeout: 60000 });
await page.screenshot({ path: `${OUT}/01-lobby.png` });
if (process.argv[6]) { await page.click(`.seg button:has-text("${process.argv[6]}")`); }
await page.click('button:has-text("Shuffle up")');
await page.waitForSelector('text=Your opening hand', { timeout: 30000 });
await page.screenshot({ path: `${OUT}/02-mulligan.png` });
await page.click('.dialog >> text=Keep');
let shots = 3, lastTurn = -1;
const log = [];
let stuck = 0;
for (let i = 0; i < STEPS; i++) {
  await page.waitForTimeout(250);
  try {
  const state = await page.evaluate(() => {
    const dlg = document.querySelector('.overlay .dialog');
    const prompt = document.querySelector('.prompt');
    return {
      dialog: dlg ? dlg.querySelector('h2')?.textContent : null,
      prompt: prompt ? prompt.innerText.replace(/\s+/g, ' ').slice(0, 160) : null,
      turn: document.querySelector('.turninfo b')?.textContent,
      playable: document.querySelectorAll('.hand .card.playable').length,
      over: !!document.querySelector('.dialog h2') && /win|Game over|wins/.test(document.querySelector('.dialog h2').textContent),
    };
  });
  if (state.turn !== lastTurn) { lastTurn = state.turn; if (shots < 14) await page.screenshot({ path: `${OUT}/${String(shots++).padStart(2, '0')}-turn${state.turn}.png` }); }
  log.push(`${i}: T${state.turn} dialog=${state.dialog} | ${state.prompt}`);
  if (state.over) { await page.screenshot({ path: `${OUT}/99-over.png` }); break; }
  if (state.dialog) {
    // pick required cards, then confirm
    const picks = await page.$$('.overlay .dlg-cards .pick .card');
    const confirm = await page.$('.overlay .dialog .btn.primary');
    if (picks.length && confirm && await confirm.isDisabled()) { for (const p of picks) { await p.click(); if (!(await confirm.isDisabled())) break; } }
    const opts = await page.$$('.overlay .optlist .btn');
    if (opts.length && !(await page.$('.overlay .dialog .btn.primary'))) { await opts[0].click(); continue; }
    if (opts.length && confirm && await confirm.isDisabled()) { for (const o of opts) { await o.click(); if (!(await confirm.isDisabled())) break; } }
    const color = await page.$('.overlay .colorrow button');
    if (color) { await color.click(); continue; }
    const btn = await page.$('.overlay .dialog .btn.primary:not([disabled])');
    if (btn) { await btn.click(); continue; }
    const any = await page.$('.overlay .dialog .btn');
    if (any) await any.click();
    continue;
  }
  if (/Declare attackers/i.test(state.prompt || '')) {
    await page.click('.prompt .acts >> text=All').catch(() => {});
    await page.waitForTimeout(150);
    await page.click('.prompt .acts .btn.primary', { timeout: 3000 });
    continue;
  }
  if (/Declare blockers/i.test(state.prompt || '')) {
    const b = await page.$('.mat.bottom .card.targetable');
    const a = await page.$('.opponents .card.attacking');
    if (b && a && Math.random() < 0.6) { await b.click(); await page.waitForTimeout(100); const a2 = await page.$('.opponents .card.attacker-target'); if (a2) await a2.click(); await page.waitForTimeout(100); }
    await page.click('.prompt .acts .btn.primary', { timeout: 3000 });
    continue;
  }
  if (/Choose targets/i.test(state.prompt || '')) {
    const t = await page.$('.card.targetable, .mat.targetable .plate');
    if (t) await t.click();
    await page.waitForTimeout(100);
    const c = await page.$('.prompt .btn.primary:not([disabled])');
    if (c) await c.click();
    continue;
  }
  if (state.playable > 0) {
    const cards = await page.$$('.hand .card.playable');
    await cards[0].click();
    await page.waitForTimeout(200);
    const mi = await page.$('.menu .mi.cast');
    if (mi) await mi.click();
    continue;
  }
  const primary = await page.$('.prompt .btn.primary:not([disabled])');
  if (primary) { await primary.click(); continue; }
  const cancel = await page.$('.prompt .btn.ghost');
  if (cancel) { await cancel.click(); continue; }
  } catch (e) {
    stuck++;
    log.push('DRIVER ERROR: ' + e.message.split('\n')[0]);
    await page.screenshot({ path: `${OUT}/stuck-${stuck}.png` });
    if (stuck > 5) break;
  }
}
await page.screenshot({ path: `${OUT}/98-final.png` });
const html = await page.content();
fs.writeFileSync(`${OUT}/log.txt`, log.join('\n') + '\n\nERRORS:\n' + errors.join('\n'));
console.log('errors:', errors.length); for (const e of errors.slice(0, 20)) console.log(e);
console.log(log.slice(-8).join('\n'));
await browser.close();
