// How the deck builder opens on a slow laptop (the CPU slowed 4x): time to open, time until every card is read, and
// every main-thread task over 50 ms (the page shouldn't freeze while it reads 32,000 cards).
// Usage: node tools/builderperf.mjs [cpu slowdown=4]   (serve dist/ on :8765 first)
import { chromium } from 'playwright';
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.addInitScript(() => { window.__long = []; try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__long.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask', buffered: false }); } catch {} });
const cdp = await p.context().newCDPSession(p);
await p.goto('http://localhost:8765/#mtg');
await p.waitForSelector('text=Pick a deck, take a seat', { timeout: 60000 });
await cdp.send('Emulation.setCPUThrottlingRate', { rate: +(process.argv[2] || 4) });
const t0 = Date.now();
await p.evaluate(() => { window.__long = []; });
await p.click('button:has-text("+ Build a deck")');
await p.waitForSelector('.b-start', { timeout: 60000 });
const t1 = Date.now();
await p.waitForFunction(() => !document.querySelector('.b-loading'), null, { timeout: 120000 });
const t2 = Date.now();
const long = await p.evaluate(() => window.__long);
console.log('builder open', t1 - t0, 'ms; full pool ready', t2 - t0, 'ms; long tasks', long.length, 'worst', Math.max(0, ...long.map(x => x[1])), 'sum', long.reduce((a, x) => a + x[1], 0));
console.log(JSON.stringify(long.sort((a, b) => b[1] - a[1]).slice(0, 6)));
await b.close();
