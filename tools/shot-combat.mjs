// Screenshot the table while you are being attacked: the bot plays your seat, you only declare blockers.
// Usage: node tools/shot-combat.mjs <out.png> [fromTurn=10] [width=1440] [height=900] [players="4-player"]
import { chromium } from 'playwright';
const [out, from = '10', w = '1440', h = '900', players = ''] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL|Failed to load resource/.test(m.text())) errors.push(m.text()); });
await page.addInitScript(t => { window.__paAutoplay = t; window.__paHumanTypes = ['blockers']; try { localStorage.setItem('pa-settings', JSON.stringify({ aiSpeed: 'fast' })); } catch {} }, +from);
await page.goto('http://localhost:8765/#mtg');
await page.waitForSelector('text=Pick a deck, take a seat', { timeout: 60000 });
if (players) await page.click(`.seg button:has-text("${players}")`);
await page.click('button:has-text("Shuffle up")');
try { await page.waitForSelector('.prompt .step:has-text("Declare blockers")', { timeout: +(process.env.WAIT || 240000) }); } catch (e) { await page.screenshot({ path: out }); console.log("timeout; saved state", errors); await browser.close(); process.exit(1); }
await page.waitForTimeout(800);
// pick the first blocker and the first attacker so a block arrow shows too
const blocker = await page.$('.mat.bottom .card.targetable');
if (blocker) { await blocker.click(); await page.waitForTimeout(200); const atk = await page.$('.card.attacker-target'); if (atk) await atk.click(); }
await page.waitForTimeout(600);
if (process.env.FITDBG) console.log(JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.mat')].map(m => { const f = m.querySelector('.field'); return { fit: m.style.getPropertyValue('--fit'), fieldH: f.clientHeight, rows: [...f.children].map(r => r.className + ':' + r.offsetHeight + 'x' + r.offsetWidth) }; }))));
await page.screenshot({ path: out });
console.log('saved', out, errors.length ? 'ERRORS: ' + errors.join(' | ') : 'no errors');
await browser.close();
