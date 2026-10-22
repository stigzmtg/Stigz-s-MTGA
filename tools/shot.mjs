// Screenshot a realistic mid-game table: an AI plays your seat for N turns, then the board is captured.
// Usage: node tools/shot.mjs <out.png> [turns=14] [width=1440] [height=900] [players="4-player"]
import { chromium } from 'playwright';
const [out, turns = '14', w = '1440', h = '900', players = ''] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: +(process.env.DPR || 1) });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL|Failed to load resource/.test(m.text())) errors.push(m.text()); });
await page.addInitScript(t => { window.__paAutoplay = t; try { localStorage.setItem('pa-settings', JSON.stringify({ aiSpeed: 'instant' })); } catch {} }, +turns);
await page.goto('http://localhost:8765/');
await page.waitForSelector('text=Pick a precon', { timeout: 60000 });
if (players) await page.click(`.seg button:has-text("${players}")`);
await page.click('button:has-text("Shuffle up")');
await page.waitForFunction(t => { const el = document.querySelector('.topbar .turninfo b'); return (el && +el.textContent >= t) || document.querySelector('.standings'); }, +turns, { timeout: 180000 });
await page.waitForTimeout(2500);
// HOVER=hand|field: point at a card first so the preview shows it
if (process.env.HOVER) { const el = await page.$(process.env.HOVER === 'hand' ? '.handslot .card' : '.mat.me .field .card'); if (el) { await el.hover(); await page.waitForTimeout(600); } }
await page.screenshot({ path: out });
console.log('saved', out, errors.length ? 'ERRORS: ' + errors.join(' | ') : 'no errors');
await browser.close();
