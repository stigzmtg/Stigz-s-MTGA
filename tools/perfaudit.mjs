// Smoothness audit on a slow machine: the CPU is throttled (default 4x, roughly a school Chromebook) and we record
// every animation frame and every main-thread task over 50 ms while the home page animates and scrolls, and while
// each game plays itself at normal speed.
// Usage: node tools/perfaudit.mjs [cpu slowdown=4] [turns=5]   (serve dist/ on :8765 first; ONLY=home, pk, op or mtg runs one part)
import { chromium } from 'playwright';
const RATE = +(process.argv[2] || 4), TURNS = +(process.argv[3] || 5);
const BASE = process.env.BASE || 'http://localhost:8765/';
const browser = await chromium.launch({ args: ['--enable-gpu-rasterization'] });

const probe = () => {
  window.__perf = { frames: [], long: [], on: false };
  try { new PerformanceObserver(l => { if (window.__perf.on) for (const e of l.getEntries()) window.__perf.long.push(e.duration); }).observe({ type: 'longtask', buffered: false }); } catch { /* unsupported */ }
  let last = 0;
  const tick = t => { if (window.__perf.on && last) window.__perf.frames.push(t - last); last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
};
const start = p => p.evaluate(() => { window.__perf.frames = []; window.__perf.long = []; window.__perf.on = true; });
const stop = async (p, label, extra = '') => {
  const d = await p.evaluate(() => { window.__perf.on = false; return window.__perf; });
  const f = d.frames.slice().sort((a, b) => a - b);
  const q = k => f.length ? f[Math.min(f.length - 1, Math.floor(f.length * k))] : 0;
  const janky = d.frames.filter(x => x > 50).length;
  const total = d.frames.reduce((a, b) => a + b, 0) / 1000;
  const lt = d.long.slice().sort((a, b) => b - a);
  console.log(`${label.padEnd(30)} ${total.toFixed(1)}s · ${(d.frames.length / Math.max(total, 0.001)).toFixed(0)} fps · frame p50 ${q(0.5).toFixed(0)}ms p95 ${q(0.95).toFixed(0)}ms worst ${(f[f.length - 1] || 0).toFixed(0)}ms · ${janky} hitches >50ms · long tasks ${lt.length} (sum ${lt.reduce((a, b) => a + b, 0).toFixed(0)}ms, worst ${(lt[0] || 0).toFixed(0)}ms)${extra}`);
  return d;
};

async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1366, height: 768 } });
  await ctx.addInitScript(probe);
  await ctx.addInitScript(([t, speed]) => { window.__pkAutoplay = t; window.__paAutoplay = t; window.__opAutoplay = t; try { localStorage.setItem('pa-settings', JSON.stringify({ aiSpeed: speed })); } catch {} }, [opts.turns || TURNS, opts.speed || 'normal']);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: RATE });
  page.on('pageerror', e => console.log('  page error:', e.message));
  return page;
}
const turnOf = p => p.evaluate(() => +((document.querySelector('.topbar .turninfo b') || {}).textContent || 0));

const ONLY = process.env.ONLY || '';
console.log(`CPU slowed ${RATE}x\n`);
// home: the drifting art, then a scroll down the whole page
if (!ONLY || ONLY === 'home') {
  const p = await newPage();
  await p.goto(BASE); await p.waitForSelector('.deck-tile.pk', { timeout: 60000 }); await p.waitForTimeout(3000);
  await start(p); await p.waitForTimeout(5000); await stop(p, 'home: idle (drifting art)');
  await start(p);
  await p.evaluate(async () => { const H = document.documentElement.scrollHeight - innerHeight; const t0 = performance.now(); await new Promise(res => { const step = t => { const k = Math.min(1, (t - t0) / 4000); scrollTo(0, H * k); if (k < 1) requestAnimationFrame(step); else res(); }; requestAnimationFrame(step); }); });
  await stop(p, 'home: scrolling down');
  await p.context().close();
}
// Pokémon: lobby to a battle the computer plays for you
if (!ONLY || ONLY === 'pk') {
  const p = await newPage();
  const t0 = Date.now();
  await p.goto(BASE + '#pokemon'); await p.waitForSelector('.pk-lobby', { timeout: 60000 });
  console.log(`pokemon lobby ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await start(p);
  await p.click('button:has-text("Battle!")'); await p.waitForSelector('.pk-board');
  const t1 = Date.now();
  await p.waitForFunction(t => +((document.querySelector('.topbar .turninfo b') || {}).textContent || 0) >= t || document.querySelector('.dialog[aria-label="Game over"]'), TURNS, { timeout: 300000, polling: 500 }).catch(() => {});
  await stop(p, `pokemon battle (${await turnOf(p)} turns)`, ` · ${((Date.now() - t1) / 1000).toFixed(0)}s`);
  await p.context().close();
}
// One Piece: lobby to a battle the computer plays for you
if (!ONLY || ONLY === 'op') {
  const p = await newPage();
  const t0 = Date.now();
  await p.goto(BASE + '#onepiece'); await p.waitForSelector('.op-lobby', { timeout: 60000 });
  console.log(`one piece lobby ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await start(p);
  await p.click('button:has-text("Battle!")'); await p.waitForSelector('.op-board');
  const t1 = Date.now();
  await p.waitForFunction(t => +((document.querySelector('.topbar .turninfo b') || {}).textContent || 0) >= t || document.querySelector('.dialog[aria-label="Game over"]'), TURNS, { timeout: 300000, polling: 500 }).catch(() => {});
  await stop(p, `one piece battle (${await turnOf(p)} turns)`, ` · ${((Date.now() - t1) / 1000).toFixed(0)}s`);
  await p.context().close();
}
// Commander: a 4-player game (the heaviest table) the computer plays for you
if (!ONLY || ONLY === 'mtg') {
  const p = await newPage({ turns: Math.max(3, TURNS - 2) });
  const t0 = Date.now();
  await p.goto(BASE + '#mtg'); await p.waitForSelector('text=Pick a deck, take a seat', { timeout: 120000 });
  console.log(`commander lobby ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await p.click('.seg[aria-label="Number of opponents"] button:has-text("4-player")');
  await start(p);
  await p.click('button:has-text("Shuffle up")'); await p.waitForSelector('.topbar .turninfo', { timeout: 60000 });
  const t1 = Date.now();
  const target = Math.max(3, TURNS - 2);
  await p.waitForFunction(t => { const m = /Turn\s*(\d+)/.exec((document.querySelector('.topbar') || {}).textContent || ''); return m && +m[1] >= t; }, target, { timeout: 400000, polling: 500 }).catch(() => {});
  await stop(p, `commander 4-player (to turn ${target})`, ` · ${((Date.now() - t1) / 1000).toFixed(0)}s`);
  await p.context().close();
}
await browser.close();
