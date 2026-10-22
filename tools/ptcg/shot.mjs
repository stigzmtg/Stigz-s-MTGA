// Screenshot the Pokémon side: home, lobby, and a battle after N turns (a computer plays your seat until then).
// Usage: node tools/ptcg/shot.mjs <out dir> [turns=6] [width=1440] [height=900]   (serve dist/ on :8765 first)
import { chromium } from 'playwright';
import fs from 'node:fs';
const [out = '/tmp/pkshot', turns = '6', w = '1440', h = '900'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: +(process.env.DPR || 1) });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_TUNNEL/.test(m.text())) errors.push(m.text()); });
await page.addInitScript(t => { window.__pkAutoplay = t; try { localStorage.setItem('pa-settings', JSON.stringify({ aiSpeed: process.env ? 'fast' : 'fast' })); } catch {} }, +turns);
await page.goto('http://localhost:8765/');
await page.waitForSelector('.app.home .gate');
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/1-home.png` });
await page.click('.gate.pk .cta');
await page.waitForSelector('text=Pick a deck, start a battle');
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/2-lobby.png` });
if (process.env.DECK) await page.click(`.pk-deck:has-text("${process.env.DECK}")`);
await page.click('button:has-text("Battle!")');
await page.waitForSelector('.pk-board');
await page.waitForFunction(t => { const el = document.querySelector('.topbar .turninfo b'); return (el && +el.textContent >= t) || document.querySelector('.dialog h2.win, .dialog[aria-label="Game over"]'); }, +turns, { timeout: 120000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/3-battle.png` });
console.log('saved', out, errors.length ? 'ERRORS: ' + errors.join(' | ') : 'no errors');
await browser.close();
