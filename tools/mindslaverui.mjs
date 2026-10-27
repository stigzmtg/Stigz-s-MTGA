// Controlling another player's turn (Mindslaver) in a real browser: during the opponent's turn you control, the
// hand row shows their hand, the prompt says whose decisions you're making, clicking their land plays it for them
// and the turn's decisions are yours; afterwards your own hand is back.
// Usage: node tools/mindslaverui.mjs [port] [out dir]   (serve dist/ first: node tools/serve-test.mjs <port>)
import fs from 'node:fs';
import { chromium } from 'playwright';

const PORT = +(process.argv[2] || 8814);
const OUT = process.argv[3] || '/tmp/mindslaverui';
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
const state = () => page.evaluate(() => { const s = window.__paSession, g = s && s.game; const r = s && s.human.pending && s.human.pending.req; return g && { turn: g.turnNumber, active: g.activePlayer, me: s.human.pid, step: g.step, stack: g.stack.length, req: r && { type: r.type, player: r.player, decider: r.decider, prompt: r.prompt }, over: g.over }; });
await page.waitForFunction(() => {
  const s = window.__paSession, g = s && s.game;
  return g && g.turnNumber >= 4 && g.activePlayer === s.human.pid && g.isMainPhase() && !g.stack.length && s.human.pending && s.human.pending.req.type === 'priority';
}, null, { timeout: 180000 }).catch(async e => { console.log('state:', await state()); await page.screenshot({ path: `${OUT}/stuck.png` }); throw e; });

// you control the opponent during their next turn (as Mindslaver's ability would set up), and they hold a land
const opp = await page.evaluate(() => {
  const s = window.__paSession, g = s.game, me = s.human.pid, opp = g.opponents(me)[0].id;
  g.controlPlans = [{ target: opp, by: me, combat: false, fromTurn: g.turnNumber, fromStep: g.step, fromCombats: 0, ts: g.uid++ }];
  const land = g.newCard(g.db.get('Swamp'), opp); land.zone = 'hand'; g.players[opp].hand.push(land);
  g.players[opp].landsPlayed = 0;
  g.touch(); s.store.bump();
  return { id: opp, name: g.players[opp].name, land: land.id };
});
// pass until it's their turn and you're asked to decide for them
for (let k = 0; k < 40; k++) {
  const st = await state();
  if (st.active === opp.id && st.req && st.req.player === opp.id && st.req.decider === st.me && st.req.type === 'priority' && /main/.test(st.step)) break;
  const b = await page.$('.prompt .acts .btn.primary:not([disabled])');
  if (b) await b.click().catch(() => {});
  else { const d = await page.$('.overlay .dialog .btn.primary:not([disabled])'); if (d) await d.click().catch(() => {}); }
  await page.waitForTimeout(250);
}
const st1 = await state();
ok(st1.active === opp.id && st1.req && st1.req.player === opp.id && st1.req.decider === st1.me, `you are asked to decide for ${opp.name} on their turn (${JSON.stringify(st1)})`);
const ui1 = await page.evaluate(() => ({ note: (document.querySelector('.prompt .ctl') || {}).textContent || '', whose: (document.querySelector('.hand .whose') || {}).textContent || '', controlled: !!document.querySelector('.hand.controlled'), cards: document.querySelectorAll('.hand .handslot').length }));
ok(/You control .* this turn/.test(ui1.note), `the prompt says you control them (${ui1.note})`);
ok(ui1.controlled && ui1.whose.includes(opp.name), `the hand row shows ${opp.name}'s hand (${JSON.stringify(ui1)})`);
await page.screenshot({ path: `${OUT}/1-controlling.png` });
// play their land for them
const landSel = `.hand [data-ref="c${opp.land}"]`;
const land = await page.$(landSel);
ok(!!land, 'their land is in the hand row');
if (land) {
  await land.click();
  await page.waitForTimeout(400);
  const item = await page.$('.menu .item.primary, .menu button.primary');
  if (item) await item.click();
  await page.waitForTimeout(500);
}
const played = await page.evaluate(id => { const g = window.__paSession.game; const c = g.cardById(id); return { zone: c.zone, controller: c.controller }; }, opp.land);
ok(played.zone === 'battlefield' && played.controller === opp.id, `the land is played for them (${JSON.stringify(played)})`);
await page.screenshot({ path: `${OUT}/2-played-their-land.png` });
// finish their turn: no attacks, pass on
for (let k = 0; k < 60; k++) {
  const st = await state();
  if (st.over || st.active !== opp.id) break;
  const atk = await page.$('.prompt .acts .btn.primary:has-text("No attack")');
  if (atk) { await atk.click().catch(() => {}); await page.waitForTimeout(250); continue; }
  const b = await page.$('.prompt .acts .btn.primary:not([disabled])');
  if (b) await b.click().catch(() => {});
  else {
    // a choice in a dialog (discarding to hand size for them): pick what it needs, then confirm
    const need = st.req && st.req.type === 'cards';
    if (need) { const cs = await page.$$('.overlay .dialog .dlg-cards .card'); for (const c of cs.slice(0, 3)) { await c.click().catch(() => {}); if (await page.$('.overlay .dialog .btn.primary:not([disabled])')) break; } }
    const d = await page.$('.overlay .dialog .btn.primary:not([disabled])'); if (d) await d.click().catch(() => {});
  }
  await page.waitForTimeout(250);
}
const st2 = await state();
ok(st2.active !== opp.id || st2.over, `their turn ended (${JSON.stringify(st2)})`);
const ui2 = await page.evaluate(() => ({ note: !!document.querySelector('.prompt .ctl'), controlled: !!document.querySelector('.hand.controlled') }));
ok(!ui2.note && !ui2.controlled, `your own view is back (${JSON.stringify(ui2)})`);
ok(await page.evaluate(n => window.__paSession.game.logs.some(l => l.text.includes(`controls ${n} this turn`)), opp.name), 'the log says who controlled the turn');
await page.screenshot({ path: `${OUT}/3-back.png` });
// on a phone, the borrowed hand fits
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
ok(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), 'no sideways scrolling on a phone');

console.log(errors.length ? `errors:\n${errors.join('\n')}` : 'no page errors');
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail || errors.length ? 1 : 0);
