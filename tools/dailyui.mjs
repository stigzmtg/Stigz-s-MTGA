// The daily challenge in a real browser: the lobby shows today's game; two separate profiles get the same decks and
// the same shuffle (opening hands, libraries); a finished game is remembered with today's date, a win counts and the
// streak goes up; on a phone it fits. Usage: node tools/dailyui.mjs [out dir] [site]   (serve dist/ on :8765 first)
import fs from 'node:fs';
import { chromium } from 'playwright';

const OUT = process.argv[2] || '/tmp/dailyui';
const BASE = process.argv[3] || 'http://localhost:8765/';
fs.mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };
const browser = await chromium.launch();
const errors = [];
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();

async function profile(records, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(recs => {
    window.__paExpose = true;
    try {
      localStorage.setItem('pa-settings', JSON.stringify({ aiSpeed: 'instant' }));
      localStorage.setItem('pa-tips', JSON.stringify({ mtg: { off: true, seen: [] } }));
      if (recs && !localStorage.getItem('pa-seeded')) { localStorage.setItem('pa-records', JSON.stringify(recs)); localStorage.setItem('pa-seeded', '1'); }
    } catch { /* blocked */ }
  }, records);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(BASE + '#mtg');
  await page.waitForSelector('text=Pick a deck, take a seat', { timeout: 60000 });
  return page;
}
// the opening of today's game as the engine dealt it
const opening = page => page.evaluate(() => {
  const g = window.__paSession.game;
  return { seed: g.seed, decks: g.players.map(p => p.deckId).join(','), hands: g.players.map(p => p.hand.map(c => c.def.name).sort().join('|')).join(' / '), tops: g.players.map(p => p.library.slice(-5).map(c => c.def.name).join('|')).join(' / ') };
});
async function startDaily(page) {
  await page.click('.daily button.btn.primary');
  await page.waitForFunction(() => window.__paSession && window.__paSession.game && window.__paSession.game.players.every(p => p.hand.length === 7), null, { timeout: 60000 });
  return opening(page);
}

// ---- a profile that won yesterday's challenge
const A = await profile([{ id: 'x1', kind: 'mtg', at: Date.now() - 864e5, mode: 'solo', seat: 0, deck: { id: 'a', name: 'A' }, opps: [], result: 'win', turns: 9, reason: '', replay: false, daily: yesterday }]);
const panel = await A.textContent('.daily');
ok(/Daily challenge/.test(panel) && /You play/.test(panel) && /Against/.test(panel), `the lobby shows today's challenge (${panel.slice(0, 120)})`);
ok(/Win to make it 2 days in a row/.test(panel), 'yesterday\'s win counts towards a streak');
const seats = await A.$$eval('.dseat .dsn b', bs => bs.map(b => b.textContent));
await A.screenshot({ path: `${OUT}/1-lobby.png` });
const a = await startDaily(A);
ok(a.decks.split(',').length === seats.length, `the game has the challenge's ${seats.length} decks (${a.decks})`);

// ---- someone else, elsewhere: the same game
const B = await profile(null);
const seatsB = await B.$$eval('.dseat .dsn b', bs => bs.map(b => b.textContent));
ok(JSON.stringify(seats) === JSON.stringify(seatsB), 'another player sees the same decks');
const b = await startDaily(B);
ok(a.seed === b.seed && a.decks === b.decks, `the same seed and decks (${a.seed})`);
ok(a.hands === b.hands && a.tops === b.tops, `and the same opening hands and libraries\n  ${a.hands}\n  ${b.hands}`);
await B.screenshot({ path: `${OUT}/2-game.png` });
await B.close();

// ---- the game ends with a win: remembered with today's date, the streak goes up
await A.evaluate(async () => {
  const s = window.__paSession, g = s.game;
  for (const p of g.players) if (p.id !== s.human.pid) p.life = 0;
  try { await g.checkSBA(); } catch { /* the game is over */ }
  s.store.bump();
});
await A.waitForFunction(() => window.__paSession.game.over, null, { timeout: 30000 }).catch(() => {});
await A.waitForTimeout(1500);
const recs = await A.evaluate(() => JSON.parse(localStorage.getItem('pa-records') || '[]'));
const mine = recs.find(r => r.daily === today);
ok(mine && mine.result === 'win', `the win is remembered as today's challenge (${JSON.stringify(mine && { result: mine.result, daily: mine.daily })})`);
await A.reload();
await A.waitForSelector('text=Pick a deck, take a seat', { timeout: 60000 });
const after = await A.textContent('.daily');
ok(/You won today/.test(after) && /2 days in a row/.test(after), `the lobby says so, with the streak (${after.match(/Everyone[^]*$/)?.[0]})`);
ok(/Play it again/.test(after), 'and offers to play it again');
await A.screenshot({ path: `${OUT}/3-won.png` });
await A.close();

// ---- on a phone
const P = await profile(null, { width: 390, height: 844 });
const wide = await P.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
ok(!wide, 'no sideways scrolling on a phone');
await P.screenshot({ path: `${OUT}/4-phone.png` });
await P.close();

console.log(errors.length ? `errors:\n${errors.join('\n')}` : 'no page errors');
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail || errors.length ? 1 : 0);
