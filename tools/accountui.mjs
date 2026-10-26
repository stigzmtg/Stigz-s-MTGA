// Accounts in real browsers, against a local server (`npx wrangler dev` serves docs/ and the API on :8787):
// make an account on one device, log in on another (progress from both comes together), a taken name shows as
// taken, the age question, a forgotten password with the recovery code, logging out of a shared computer, deleting
// the account. Usage: node tools/accountui.mjs [out dir] [site, default http://localhost:8787/]
import fs from 'node:fs';
import { chromium } from 'playwright';

const OUT = process.argv[2] || '/tmp/accountui';
const URL = process.argv[3] || 'http://localhost:8787/';
fs.mkdirSync(OUT, { recursive: true });
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await chromium.launch(/^https:/.test(URL) && proxy ? { proxy: { server: proxy } } : {});
const errors = [];
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };
const rec = (id, kind, deck) => ({ id, at: Date.now() - 3600e3, kind, mode: 'solo', seat: 0, deck: { id: 'x', name: deck }, opps: [{ name: 'AI', deck: 'Other' }], result: 'win', turns: 9, reason: '', replay: false });
async function device(name, seed = {}, width = 1280, height = 900) {
  const ctx = await browser.newContext({ viewport: { width, height }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${name} console: ${m.text()}`); });
  await page.goto(URL);
  if (Object.keys(seed).length) { await page.evaluate(s => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, seed); await page.reload(); }
  await page.waitForSelector('.home-nav');
  return page;
}
const stored = (page, k) => page.evaluate(key => localStorage.getItem(key), k);
const username = 'Tester_' + Math.random().toString(36).slice(2, 7);
const email = `${username.toLowerCase()}@example.com`;

// ---- device A makes an account
const A = await device('A', { 'pa-records': JSON.stringify([rec('a1', 'mtg', 'Riveteers Rampage')]), 'pa-avatar': 'f2o1c3h2x1b4' });
await A.click('.navbtn.acctbtn');
await A.waitForSelector('.acctdlg');
await A.click('.acctdlg button:has-text("New here? Make an account")');
await A.fill('#ac-name', username);
await A.waitForSelector('.ac-namecheck.good', { timeout: 10000 });
ok(/is free/.test(await A.textContent('.ac-namecheck')), 'the name shows as free');
await A.fill('#ac-email', email);
await A.fill('#ac-newpw', 'a good password 1');
await A.selectOption('.ac-born select[aria-label=Month]', '4');
await A.selectOption('.ac-born select[aria-label=Year]', '2001');
await A.screenshot({ path: `${OUT}/01-signup.png` });
await A.click('.ac-go');
await A.waitForSelector('.ac-recovery', { timeout: 20000 });
const recovery = (await A.textContent('.ac-code')).trim();
ok(/^[2-9A-Z]{4}(-[2-9A-Z]{4}){3}$/.test(recovery), `a recovery code (${recovery})`);
await A.screenshot({ path: `${OUT}/02-welcome.png` });
await A.click('.acctdlg button:has-text("I’ve saved it, let’s play")');
await A.waitForSelector('.navbtn.acctbtn.in', { timeout: 15000 });
ok((await A.textContent('.navbtn.acctbtn')).includes(username), 'the nav shows the username');
const acc = JSON.parse(await stored(A, 'pa-account'));
const link = JSON.parse(await stored(A, 'pa-savecode') || 'null');
ok(acc && acc.token && link && acc.user.saveCode === link.code, `the account holds this device's save code (${acc && acc.user.saveCode} / ${link && link.code})`);
ok(await stored(A, 'pa-nick') === username, 'the username is the room name');
await A.screenshot({ path: `${OUT}/03-home-logged-in.png`, clip: { x: 0, y: 0, width: 1280, height: 80 } });

// ---- device C: the name is taken (any capitals), and the age question
const C = await device('C');
await C.click('.navbtn.acctbtn');
await C.click('.acctdlg button:has-text("New here? Make an account")');
await C.fill('#ac-name', username.toUpperCase());
await C.waitForSelector('.ac-namecheck.bad', { timeout: 10000 });
ok(/already has/.test(await C.textContent('.ac-namecheck')), 'the same name in capitals shows as taken');
await C.fill('#ac-name', username + 'x');
await C.fill('#ac-email', 'kid@example.com');
await C.fill('#ac-newpw', 'a good password 1');
await C.selectOption('.ac-born select[aria-label=Month]', '0');
await C.selectOption('.ac-born select[aria-label=Year]', String(new Date().getFullYear() - 10));
await C.click('.ac-go');
await C.waitForSelector('.ac-young');
ok(true, 'under 13: no account');
await C.screenshot({ path: `${OUT}/04-young.png` });

// ---- device B logs in: A's progress and B's come together
const B = await device('B', { 'pa-records': JSON.stringify([rec('b1', 'pk', 'Gardevoir ex')]), 'pa-uisize': 'large' });
await B.click('.navbtn.acctbtn');
await B.fill('#ac-login', username.toLowerCase());
await B.fill('#ac-pw', 'a good password 1');
await Promise.all([B.waitForNavigation({ timeout: 25000 }), B.click('.ac-go')]);
await B.waitForSelector('.navbtn.acctbtn.in');
await B.waitForTimeout(1500);
const bRecs = JSON.parse(await stored(B, 'pa-records')).map(r => r.id).sort().join();
ok(bRecs === 'a1,b1', `B has both devices' games (${bRecs})`);
ok(await stored(B, 'pa-avatar') === 'f2o1c3h2x1b4' && await stored(B, 'pa-uisize') === 'large', 'B got the avatar and kept its own screen size');
// A sees B's game next time it opens
await A.reload(); await A.waitForSelector('.navbtn.acctbtn.in'); await A.waitForTimeout(3500);
ok(JSON.parse(await stored(A, 'pa-records')).map(r => r.id).sort().join() === 'a1,b1', 'A brought in B\'s game');

// ---- B logs out of a "shared computer": its progress goes
await B.click('.navbtn.acctbtn');
await B.waitForSelector('.ac-account');
await B.screenshot({ path: `${OUT}/05-account.png` });
await B.click('.ac-check input');
await Promise.all([B.waitForNavigation({ timeout: 20000 }), B.click('.ac-logout .btn:not(.ghost)')]);
await B.waitForSelector('.navbtn.acctbtn:not(.in)');
ok(!(await stored(B, 'pa-records')) && !(await stored(B, 'pa-account')) && !(await stored(B, 'pa-savecode')), 'logged out and progress removed');
ok(await stored(B, 'pa-uisize') === 'large', 'device settings stayed');

// ---- C forgot the password: the recovery code
await C.click('.acctdlg button:has-text("Back")');
await C.click('.acctdlg button:has-text("Forgot your password?")');
await C.fill('#ac-fname', username);
await C.fill('#ac-rcode', recovery.toLowerCase());
await C.fill('#ac-fpw', 'brand new pass 2');
await C.click('.ac-go');
await C.waitForSelector('.ac-recovery', { timeout: 20000 });
const recovery2 = (await C.textContent('.ac-code')).trim();
ok(recovery2 && recovery2 !== recovery, 'a new password and a new recovery code');
await C.screenshot({ path: `${OUT}/06-recovered.png` });
await Promise.all([C.waitForNavigation({ timeout: 20000 }), C.click('.acctdlg button:has-text("Done")')]);
await C.waitForSelector('.navbtn.acctbtn.in');
ok(JSON.parse(await stored(C, 'pa-records')).length === 2, 'C got the account\'s progress');
// A was logged out by the new password; it notices next time it opens
await A.reload(); await A.waitForSelector('.home-nav'); await A.waitForTimeout(2500);
ok(!(await stored(A, 'pa-account')), 'A was logged out (the password changed)');

// ---- phone: the sign-up form fits
const P = await device('P', {}, 390, 820);
await P.click('.navbtn.acctbtn');
await P.click('.acctdlg button:has-text("New here? Make an account")');
await P.fill('#ac-name', username);
await P.waitForSelector('.ac-namecheck.bad', { timeout: 10000 });
await P.screenshot({ path: `${OUT}/07-phone-signup.png` });
ok(!(await P.evaluate(() => document.documentElement.scrollWidth > innerWidth || [...document.querySelectorAll('.acctdlg *')].some(e => e.getBoundingClientRect().right > innerWidth + 1))), 'nothing sticks out on a phone');
ok(!(await P.evaluate(() => document.querySelector('.home-nav').scrollWidth > innerWidth)), 'the nav fits on a phone');

// ---- C deletes the account: the name is free again
await C.click('.navbtn.acctbtn');
await C.click('.ac-more.danger summary');
await C.fill('#ac-delpw', 'brand new pass 2');
await C.click('.ac-more.danger .btn.danger');
await C.waitForSelector('.acctdlg', { state: 'detached', timeout: 15000 });
ok(!(await stored(C, 'pa-account')), 'account deleted, logged out');
// (the GitHub Pages copy talks to the Worker's address)
const API = /\.github\.io$/.test(new globalThis.URL(URL).hostname) ? 'https://stigz-s-mtga.stigzrblx.workers.dev' : new globalThis.URL(URL).origin;
const free = await C.evaluate(async ([api, u]) => (await (await fetch(`${api}/account/name?u=${u}`)).json()).available, [API, username]);
ok(free === true, 'the username is free again');

console.log(errors.length ? `errors:\n${errors.join('\n')}` : 'no page errors');
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail || errors.length ? 1 : 0);
