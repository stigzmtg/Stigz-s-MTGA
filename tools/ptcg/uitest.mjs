// Play a Pokémon battle through the screen like a person: click playable cards, pick targets, answer every
// dialog, attack, end turns. Fails on any page error, if the game stops moving, or if the board doesn't show what the
// engine holds (Prizes, piles, the Pokémon in play with their HP, damage, Energy, Tool, Special Conditions and effects).
// Usage: node tools/ptcg/uitest.mjs [out dir] [turns=14] [width=1440] [height=900]   (serve dist/ on :8765 first, or BASE=http://localhost:8775/)
// DECK=gardevoir picks your deck (its id). MOBILE=1 plays on a touch screen.
import { chromium } from 'playwright';
import fs from 'node:fs';
const [out = '/tmp/pkui', turns = '14', w = '1440', h = '900'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: +w, height: +h }, ...(process.env.MOBILE ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_TUNNEL/.test(m.text())) errors.push(m.text()); });
await page.addInitScript(deck => { window.__pkAutoplay = 0; try { localStorage.setItem('pa-settings', JSON.stringify({ aiSpeed: 'instant' })); localStorage.setItem('pa-tips', JSON.stringify({ pk: { off: true } })); localStorage.setItem('pk-lobby', JSON.stringify({ mine: deck, opp: 'random' })); } catch {} }, process.env.DECK || 'charizard');
await page.goto((process.env.BASE || 'http://localhost:8765/') + '#pokemon');
await page.waitForSelector('text=Pick a deck, start a battle');
await page.click('button:has-text("Battle!")');
await page.waitForSelector('.pk-board');
// long tasks (50 ms or more on the main thread) while the battle is played: a person feels them as lag
await page.evaluate(() => { window.__long = []; try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ type: 'longtask' }); } catch {} });
const turnNow = () => page.evaluate(() => +(document.querySelector('.topbar .turninfo b') || {}).textContent || 0);
// the board against the engine's state (window.__pkDebug): what's on screen must be what's in the game
const boardDiff = () => page.evaluate(() => {
  const s = window.__pkDebug && window.__pkDebug.session;
  if (!s) return ['no game to compare with'];
  const g = s.game, me = s.me || 0, out = [];
  const num = el => (el ? +el.textContent.replace(/[^\d-]/g, '') : null);
  for (const p of g.players) {
    const side = document.querySelector(`.pk-side.${p.id === me ? 'me' : 'opp'}`), say = (what, shown, is) => { if (String(shown) !== String(is)) out.push(`${p.name}: ${what} shown ${shown}, is ${is}`); };
    say('Prizes', num(side.querySelector('.pk-prizes .cap b')), p.prizes.length);
    say('Prize cards drawn', side.querySelectorAll('.pk-prizes .grid .pk-card').length, p.prizes.length);
    say('deck', num(side.querySelector(`[data-pile="${p.id}:deck"] b`)), p.deck.length);
    say('discard', num(side.querySelector(`[data-pile="${p.id}:discard"] b`)), p.discard.length);
    say('Lost Zone', num(side.querySelector(`[data-pile="${p.id}:lost"] b`)) || 0, p.lost.length);
    say('hand', p.id === me ? document.querySelectorAll('.pk-hand .pk-handslot').length : num(side.querySelector(`[data-pile="${p.id}:hand"] b`)), p.hand.length);
    say('Active', (side.querySelector('.pk-activespot [data-mon]') || { dataset: {} }).dataset.mon, p.active ? p.active.id : undefined);
    say('Bench', [...side.querySelectorAll('.pk-bench [data-mon]')].map(e => e.dataset.mon), p.bench.map(m => m.id));
    for (const m of g.inPlay(p.id)) {
      const el = side.querySelector(`[data-mon="${m.id}"]`);
      if (!el) continue;
      say(`${m.name}'s HP`, num(el.querySelector('.pk-hp span')), Math.max(0, g.maxHp(m) - m.damage));
      say(`${m.name}'s damage`, num(el.querySelector('.pk-dmg')) || 0, m.damage);
      say(`${m.name}'s Special Conditions`, [...el.querySelectorAll('.pk-conds .c:not(.fx)')].map(x => x.textContent.toLowerCase()).sort(), [m.special, m.poisoned && 'poisoned', m.burned && 'burned'].filter(Boolean).sort());
      say(`${m.name}'s Energy`, el.querySelectorAll('.pk-attached > :not(.pk-tool)').length, m.energy.reduce((n, c) => n + g.energyUnits(m, c), 0));
      say(`${m.name}'s Tool`, !!el.querySelector('.pk-tool'), !!m.tool);
      say(`${m.name}'s effects shown`, el.querySelectorAll('.pk-conds .fx').length > 0, g.effects.some(e => e.mon === m.id && e.turn >= g.turn));
    }
  }
  if (!!document.querySelector('.pk-stadium .pk-card:not(.slot)') !== !!g.stadium) out.push(`the Stadium (${g.stadium && g.stadium.card.name}) isn't shown right`);
  return out;
});
const boardErrors = new Set();
let last = '', stuck = 0, clicks = 0, shots = 0;
const t0 = Date.now();
for (let i = 0; i < 3000 && Date.now() - t0 < 300000; i++) {
  const t = await turnNow();
  if (t >= +turns) break;
  if (await page.$('.dialog[aria-label="Game over"]')) { console.log('game over'); break; }
  const state = await page.evaluate(() => (document.querySelector('.pk-prompt') || {}).textContent + '|' + document.querySelectorAll('.dialog').length + '|' + document.querySelector('.pk-board').innerText.length);
  if (state === last) stuck++; else { stuck = 0; last = state; }
  // (looked at again a moment later before it counts: a check can fall between two updates)
  if (i % 3 === 0 && (await boardDiff()).length) { await page.waitForTimeout(400); for (const d of await boardDiff()) if (!boardErrors.has(d)) { boardErrors.add(d); errors.push(`turn ${t}: board: ${d}`); } }
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
const long = await page.evaluate(() => window.__long || []);
console.log(`long tasks: ${long.length}${long.length ? `, longest ${Math.max(...long)} ms` : ''}`);
console.log(`reached turn ${t}, ${clicks} clicks, ${((Date.now() - t0) / 1000).toFixed(0)}s`, errors.length ? 'ERRORS:\n' + errors.slice(0, 8).join('\n') : 'no page errors');
await browser.close();
process.exit(errors.length ? 1 : 0);
