// Save codes in real browsers, against a local server (`npx wrangler dev` serves docs/ and the save API on :8787):
// device A makes a code, device B loads it (both keep their games), A reopens and gets B's, a phone loads a save
// text. Usage: node tools/saveui.mjs [out dir] [site, default http://localhost:8787/]
import fs from 'node:fs';
import { chromium } from 'playwright';
const OUT = process.argv[2] || '/tmp/saveui';
const URL = process.argv[3] || 'http://localhost:8787/';
fs.mkdirSync(OUT, { recursive: true });
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await chromium.launch(/^https:/.test(URL) && proxy ? { proxy: { server: proxy } } : {});
const errors = [];
const rec = (id, at, kind, deck) => ({ id, at, kind, mode: 'solo', seat: 0, deck: { id: 'x', name: deck }, opps: [{ name: 'AI', deck: 'Other' }], result: 'win', turns: 9, reason: '', replay: false });
async function device(name, seed, width = 1280, height = 860) {
  const ctx = await browser.newContext({ viewport: { width, height }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${name} console: ${m.text()}`); });
  await page.goto(URL);
  await page.evaluate(s => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, seed);
  await page.reload();
  await page.waitForSelector('.home-nav');
  return { ctx, page };
}
const A = await device('A', { 'pa-records': JSON.stringify([rec('a1', Date.now() - 86400000, 'mtg', 'Riveteers Rampage'), rec('a2', Date.now() - 3600000, 'op', 'ST-01 Straw Hat Crew')]), 'pa-nick': 'Stigz', 'pa-avatar': 'f2o1c3h2x1b4' });
await A.page.screenshot({ path: `${OUT}/01-home-record.png`, clip: await A.page.locator('#record').evaluate(el => { el.scrollIntoView(); const r = el.closest('section').getBoundingClientRect(); return { x: 0, y: Math.max(0, r.top - 10), width: 1280, height: Math.min(520, r.height + 20) }; }) });
await A.page.click('.navbtn.savebtn');
await A.page.waitForSelector('.savedlg');
await A.page.waitForSelector('.sv-make:not([disabled])');
await A.page.screenshot({ path: `${OUT}/02-dialog-new.png` });
await A.page.click('.sv-make');
await A.page.waitForSelector('.sv-code', { timeout: 15000 });
const code = (await A.page.textContent('.sv-code')).trim();
await A.page.waitForSelector('.sv-status.saved');
await A.page.screenshot({ path: `${OUT}/03-dialog-code.png` });
console.log('A code', code, '| status:', await A.page.textContent('.sv-status'));
await A.page.click('.sv-coderow .btn');
console.log('copy button:', await A.page.textContent('.sv-coderow .btn'), '| clipboard:', await A.page.evaluate(() => navigator.clipboard.readText()));
await A.page.click('.savedlg .dlg-actions .btn');
console.log('nav after link:', await A.page.textContent('.navbtn.savebtn'), '| record line:', await A.page.textContent('.rec-save .rs-text'));

// device B: its own game, then loads A's code
const B = await device('B', { 'pa-records': JSON.stringify([rec('b1', Date.now() - 7200000, 'pk', 'Gardevoir ex')]), 'pa-uisize': 'large', 'pa-cid': 'device-b' });
await B.page.click('.rec-save .btn:not(.primary)');
await B.page.waitForSelector('.savedlg');
await B.page.fill('#sv-input', code.toLowerCase());
await B.page.click('.sv-load button[type=submit]');
await B.page.waitForSelector('.sv-found', { timeout: 15000 });
await B.page.screenshot({ path: `${OUT}/04-dialog-found.png` });
console.log('found:', (await B.page.textContent('.sv-found')).slice(0, 220));
await Promise.all([B.page.waitForNavigation({ timeout: 20000 }), B.page.click('.sv-found .btn.primary')]);
await B.page.waitForSelector('.home-nav');
await B.page.waitForTimeout(2500);
const bState = await B.page.evaluate(() => ({ recs: JSON.parse(localStorage.getItem('pa-records')).map(r => r.id), nick: localStorage.getItem('pa-nick'), size: localStorage.getItem('pa-uisize'), cid: localStorage.getItem('pa-cid'), link: JSON.parse(localStorage.getItem('pa-savecode')) }));
console.log('B after load:', JSON.stringify(bState));
console.log('B record line:', await B.page.textContent('.rec-save .rs-text'));
// A opens the site again: B's game comes in
await A.page.reload(); await A.page.waitForSelector('.home-nav'); await A.page.waitForTimeout(3500);
console.log('A after reopening:', JSON.stringify(await A.page.evaluate(() => JSON.parse(localStorage.getItem('pa-records')).map(r => r.id))));
// a mistyped code, and a save text
await A.page.click('.navbtn.savebtn');
await A.page.fill('#sv-input', 'ZZZZ-ZZZ2');
await A.page.click('.sv-load button[type=submit]');
await A.page.waitForSelector('.sv-err');
console.log('wrong code:', await A.page.textContent('.sv-err'));
await A.page.click('.sv-text summary');
await A.page.click('.sv-text .btn');
await A.page.waitForSelector('.sv-textarea');
const text = await A.page.inputValue('.sv-textarea');
console.log('save text length', text.length, text.slice(0, 20));
await A.page.screenshot({ path: `${OUT}/05-dialog-text.png` });
// phone
const P = await device('P', {}, 390, 800);
await P.page.click('.rec-save .btn:not(.primary)');
await P.page.waitForSelector('.savedlg');
await P.page.fill('#sv-input', text);
await P.page.click('.sv-load button[type=submit]');
await P.page.waitForSelector('.sv-found');
await P.page.screenshot({ path: `${OUT}/06-phone-found.png`, fullPage: false });
const overflow = await P.page.evaluate(() => document.documentElement.scrollWidth > innerWidth || [...document.querySelectorAll('.savedlg *')].some(e => e.getBoundingClientRect().right > innerWidth + 1));
console.log('phone overflow:', overflow);
await Promise.all([P.page.waitForNavigation({ timeout: 20000 }), P.page.click('.sv-found .btn.primary')]);
await P.page.waitForSelector('.home-nav');
console.log('phone after text load:', JSON.stringify(await P.page.evaluate(() => ({ recs: JSON.parse(localStorage.getItem('pa-records') || '[]').map(r => r.id), link: localStorage.getItem('pa-savecode') }))));
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
