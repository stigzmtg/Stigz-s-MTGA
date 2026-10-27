// Taking a move back in a real browser: a solo game where an AI plays your seat for the first turns; then you play a
// land or cast a spell, press Take back, and the table is exactly as it was before that move (hand, battlefield,
// life, library), with the same decision waiting; it works twice in a row, and the game carries on after.
// Usage: node tools/takebackui.mjs [out dir]   (serve dist/ on :8765 first)
import fs from 'node:fs';
import { chromium } from 'playwright';

const OUT = process.argv[2] || '/tmp/takebackui';
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
await page.goto('http://localhost:8765/#mtg');
await page.waitForSelector('text=Pick a deck, take a seat', { timeout: 60000 });
await page.click('.seg button:has-text("1 vs 1")');
await page.click('button:has-text("Shuffle up")');

// the table as the engine has it, for you
const snap = () => page.evaluate(() => {
  const s = window.__paSession, g = s.game, me = g.players[s.human.pid];
  const names = list => list.map(c => g.name(c)).sort().join('|');
  return { turn: g.turnNumber, step: g.step, life: g.players.map(p => p.life).join(','), hand: names(me.hand), field: names(g.battlefield.filter(c => c.controller === me.id)), library: me.library.length, pending: s.human.pending && s.human.pending.req.type };
});
// your main phase with something to play
const myMain = () => page.waitForFunction(() => {
  const s = window.__paSession, g = s && s.game;
  return g && g.turnNumber >= 4 && g.activePlayer === s.human.pid && g.isMainPhase() && !g.stack.length && s.human.pending && s.human.pending.req.type === 'priority' && document.querySelector('.hand .card.playable');
}, null, { timeout: 180000 });

await myMain();
await page.waitForTimeout(400);
const before = await snap();
ok(await page.$('.topbar button:has-text("Take back")') != null, 'a Take back button in solo games');
// play something from your hand
await page.click('.hand .card.playable');
await page.waitForTimeout(300);
const menu = await page.waitForSelector('.menu .mi.cast', { timeout: 1500 }).catch(() => null);
if (menu) await menu.click();
await page.waitForFunction(b => { const s = window.__paSession, g = s.game, me = g.players[s.human.pid]; return me.hand.length !== b; }, (await snap()).hand.split('|').length, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(600);
const after = await snap();
ok(after.hand !== before.hand, `a card left your hand (${before.hand.split('|').length} → ${after.hand.split('|').length})`);
await page.screenshot({ path: `${OUT}/1-after-move.png` });
// take it back
const rev0 = await page.evaluate(() => window.__paSession.rev);
await page.click('.topbar button:has-text("Take back")');
await page.waitForFunction(rev => window.__paSession && window.__paSession.rev !== rev, rev0, { timeout: 30000 });
await page.waitForFunction(() => window.__paSession.human.pending, null, { timeout: 30000 });
await page.waitForTimeout(500);
const back = await snap();
ok(back.hand === before.hand && back.field === before.field && back.life === before.life && back.library === before.library && back.turn === before.turn, `the table is as it was before the move\n  before ${JSON.stringify(before)}\n  back   ${JSON.stringify(back)}`);
ok(back.pending === 'priority', 'and the same decision is waiting');
await page.screenshot({ path: `${OUT}/2-taken-back.png` });
// twice: play again, take back again
await page.click('.hand .card.playable');
await page.waitForTimeout(300);
const menu2 = await page.waitForSelector('.menu .mi.cast', { timeout: 1500 }).catch(() => null);
if (menu2) await menu2.click();
await page.waitForTimeout(800);
await page.click('.topbar button:has-text("Take back")');
await page.waitForTimeout(2500);
const back2 = await snap();
ok(back2.hand === before.hand && back2.field === before.field, 'taking back works again');
// and the game goes on: pass to the next turn
await page.evaluate(() => { window.__paAutoplay = 99; });
await page.click('.prompt .acts .btn.primary').catch(() => {});
await page.waitForFunction(t => window.__paSession.game.turnNumber > t, back2.turn, { timeout: 120000 }).catch(() => {});
ok((await snap()).turn > back2.turn, 'the game carries on after');
console.log(errors.length ? `errors:\n${errors.join('\n')}` : 'no page errors');
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail || errors.length ? 1 : 0);
