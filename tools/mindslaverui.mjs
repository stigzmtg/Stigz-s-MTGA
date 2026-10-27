// Controlling another player's turn (Mindslaver) in a real browser: during the opponent's turn you control, the
// hand row shows their hand, the prompt says whose decisions you're making, clicking their land plays it for them
// and the turn's decisions are yours; afterwards your own hand is back. Then a life bid (Pain's Reward) runs through
// the number and confirm dialogs.
// Usage: node tools/mindslaverui.mjs [port] [out dir]   (serve dist/ first: node tools/serve-test.mjs <port>)
import fs from 'node:fs';
import { chromium } from 'playwright';

const PORT = +(process.argv[2] || 8814);
const OUT = process.argv[3] || '/tmp/mindslaverui';
fs.mkdirSync(OUT, { recursive: true });
// a card beyond the precons' for the bid (the page loads those only when a deck needs them)
const more = JSON.parse(fs.readFileSync('data/more.json', 'utf8')).shards;
const extra = Object.assign({}, ...Array.from({ length: more }, (_, i) => JSON.parse(fs.readFileSync(`data/more/cards-${i}.json`, 'utf8'))));
const PAINS = extra["Pain's Reward"];
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
const state = () => page.evaluate(() => { const s = window.__paSession, g = s && s.game; const r = s && s.human.pending && s.human.pending.req; return g && { turn: g.turnNumber, active: g.activePlayer, me: s.human.pid, step: g.step, stack: g.stack.length, req: r && { type: r.type, player: r.player, decider: r.decider, prompt: r.prompt, purpose: r.purpose }, over: g.over }; });
// answer whatever is asked the plain way: pass, no attack / blocks, the fewest cards a dialog needs, "no"
async function step(st) {
  const r = st && st.req;
  if (!r) { await page.waitForTimeout(150); return; }
  if (r.type === 'attackers' || r.type === 'blockers') { const b = await page.$('.prompt .acts .btn.primary'); if (b) await b.click().catch(() => {}); }
  else if (r.type === 'priority' || r.type === 'targets') { const b = await page.$('.prompt .acts .btn.primary:not([disabled])'); if (b) await b.click().catch(() => {}); else { const d = await page.$('.overlay .dialog .btn.primary:not([disabled])'); if (d) await d.click().catch(() => {}); } }
  else {
    if (r.type === 'cards') { const cs = await page.$$('.overlay .dialog .dlg-cards .card'); for (const c of cs) { if (await page.$('.overlay .dialog .btn.primary:not([disabled])')) break; await c.click().catch(() => {}); } }
    if (r.type === 'targets') { const cs = await page.$$('.overlay .dialog .dlg-cards .card, .overlay .dialog .tgt'); if (cs[0]) await cs[0].click().catch(() => {}); }
    const d = await page.$('.overlay .dialog .btn.primary:not([disabled])'); if (d) await d.click().catch(() => {});
  }
  await page.waitForTimeout(220);
}
await page.waitForFunction(() => {
  const s = window.__paSession, g = s && s.game;
  return g && g.turnNumber >= 4 && g.activePlayer === s.human.pid && g.isMainPhase() && !g.stack.length && s.human.pending && s.human.pending.req.type === 'priority';
}, null, { timeout: 180000 }).catch(async e => { console.log('state:', await state()); await page.screenshot({ path: `${OUT}/stuck.png` }); throw e; });

// you control the opponent during their next turn (as Mindslaver's ability would set up), and they hold a land
const opp = await page.evaluate(() => {
  const s = window.__paSession, g = s.game, me = s.human.pid, opp = g.opponents(me)[0].id;
  g.controlPlans = [{ target: opp, by: me, combat: false, fromTurn: g.turnNumber, fromStep: g.step, fromCombats: 0, ts: g.uid++ }];
  const land = g.newCard(g.db.get('Swamp'), opp); land.zone = 'hand'; g.players[opp].hand.push(land);
  g.touch(); s.store.bump();
  return { id: opp, name: g.players[opp].name, land: land.id };
});
// pass until it's their turn and you're asked to decide for them in their main phase
for (let k = 0; k < 80; k++) {
  const st = await state();
  if (st.active === opp.id && st.req && st.req.player === opp.id && st.req.decider === st.me && st.req.type === 'priority' && /main/.test(st.step)) break;
  await step(st);
}
const st1 = await state();
ok(st1.active === opp.id && st1.req && st1.req.player === opp.id && st1.req.decider === st1.me, `you are asked to decide for ${opp.name} on their turn (${JSON.stringify(st1)})`);
const ui1 = await page.evaluate(() => ({ note: (document.querySelector('.prompt .ctl') || {}).textContent || '', step: (document.querySelector('.prompt .step') || {}).textContent || '', whose: (document.querySelector('.hand .whose') || {}).textContent || '', controlled: !!document.querySelector('.hand.controlled'), cards: document.querySelectorAll('.hand .handslot').length }));
ok(/You control .* this turn/.test(ui1.note) && ui1.step.includes(`${opp.name}'s turn`), `the prompt says you control them (${ui1.note} / ${ui1.step})`);
ok(ui1.controlled && ui1.whose.includes(opp.name), `the hand row shows ${opp.name}'s hand (${JSON.stringify(ui1)})`);
await page.screenshot({ path: `${OUT}/1-controlling.png` });
// play their land for them (if they haven't played one yet this turn)
const canLand = await page.evaluate(id => window.__paSession.game.players[id].landsPlayed === 0, opp.id);
const land = await page.$(`.hand [data-ref="c${opp.land}"]`);
ok(!!land, 'their land is in the hand row');
if (land && canLand) {
  await land.click();
  await page.waitForTimeout(400);
  const item = await page.$('.menu .item.primary, .menu button.primary');
  if (item) await item.click();
  await page.waitForTimeout(500);
  const played = await page.evaluate(id => { const g = window.__paSession.game; const c = g.cardById(id); return { zone: c.zone, controller: c.controller }; }, opp.land);
  ok(played.zone === 'battlefield' && played.controller === opp.id, `the land is played for them (${JSON.stringify(played)})`);
}
await page.screenshot({ path: `${OUT}/2-played-their-land.png` });
// finish their turn the plain way
for (let k = 0; k < 80; k++) {
  const st = await state();
  if (st.over || st.active !== opp.id) break;
  await step(st);
}
const st2 = await state();
ok(st2.active !== opp.id || st2.over, `their turn ended (${JSON.stringify(st2)})`);
await page.waitForTimeout(300);
const ui2 = await page.evaluate(() => ({ note: !!document.querySelector('.prompt .ctl'), controlled: !!document.querySelector('.hand.controlled') }));
ok(!ui2.note && !ui2.controlled, `your own view is back (${JSON.stringify(ui2)})`);
ok(await page.evaluate(n => window.__paSession.game.logs.some(l => l.text.includes(`controls ${n} this turn`)), opp.name), 'the log says who controlled the turn');
await page.screenshot({ path: `${OUT}/3-back.png` });

// bidding life (Pain's Reward): you start the bidding in a number dialog (it starts at 0); "top the bid?" in a confirm
for (let k = 0; k < 120; k++) {
  const st = await state();
  if (st.over || (st.active === st.me && /main/.test(st.step) && !st.stack && st.req && st.req.type === 'priority')) break;
  await step(st);
}
const pr = await page.evaluate(script => {
  const s = window.__paSession, g = s.game, me = s.human.pid;
  g.db.add({ "Pain's Reward": script });
  const c = g.newCard(g.db.get("Pain's Reward"), me); c.zone = 'hand'; g.players[me].hand.push(c);
  g.players[me].pool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
  g.touch(); s.human.pending && s.human.pending.req && (s.human.pending.req = { ...s.human.pending.req }); s.store.bump();
  return c.id;
}, PAINS);
await page.waitForTimeout(300);
await page.click(`.hand [data-ref="c${pr}"]`);
await page.waitForTimeout(300);
{ const item = await page.$('.menu .item.primary, .menu button.primary'); if (item) await item.click(); }
let sawStart = null;
for (let k = 0; k < 40; k++) {
  const st = await state();
  if (st.req && st.req.type === 'number' && st.req.purpose === 'bidStart') {
    sawStart = await page.$eval('.overlay .dialog .numrow .val', x => x.textContent).catch(() => null);
    await page.click('.overlay .dialog .numrow button[aria-label="increase"]').catch(() => {});
    await page.click('.overlay .dialog .btn.primary').catch(() => {});
    await page.waitForTimeout(250);
    continue;
  }
  if (st.req && st.req.type === 'priority' && !st.stack && sawStart != null) break;
  await step(st);
}
const bid = await page.evaluate(() => window.__paSession.game.logs.slice(-14).map(l => l.text).filter(t => /bid/.test(t)));
ok(sawStart === '0', `the starting bid begins at 0 (${sawStart})`);
ok(bid.some(t => /starts the bidding at 1 life/.test(t)) && bid.some(t => /wins the bidding/.test(t)), `the bidding ran through the dialogs (${JSON.stringify(bid)})`);
await page.screenshot({ path: `${OUT}/4-bid.png` });
// on a phone it fits
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
ok(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), 'no sideways scrolling on a phone');

console.log(errors.length ? `errors:\n${errors.join('\n')}` : 'no page errors');
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail || errors.length ? 1 : 0);
