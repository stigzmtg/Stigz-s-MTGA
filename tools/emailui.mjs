// Email codes in real browsers (the account dialog), against the same local server as tools/emailtest.mjs (email on,
// emails landing in this test's mailbox on 127.0.0.1:8799): making an account with the emailed code (a wrong code,
// a new code), turning on login codes, a new device asked for the code, a new email, a forgotten password by email,
// and the code screen on a phone. Usage: node tools/emailui.mjs [out dir] [site, default http://localhost:8787/]
import fs from 'node:fs';
import http from 'node:http';
import { chromium } from 'playwright';

const OUT = process.argv[2] || '/tmp/emailui';
const URL = process.argv[3] || 'http://localhost:8787/';
fs.mkdirSync(OUT, { recursive: true });
const mail = [];
const box = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => { const m = JSON.parse(body || '{}'); mail.push({ ...m, to: m.to && m.to[0] }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"id":"m"}'); });
});
await new Promise(r => box.listen(8799, '127.0.0.1', r));
const codeFor = to => { const m = mail.filter(x => x.to && x.to.toLowerCase() === to.toLowerCase()).at(-1); return m && (/\b(\d{6})\b/.exec(m.text) || [])[1]; };
const waitMail = async (to, n) => { for (let i = 0; i < 50 && mail.filter(x => x.to === to).length < n; i++) await new Promise(r => setTimeout(r, 100)); };

const browser = await chromium.launch();
const errors = [];
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };
async function device(name, width = 1280, height = 900) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${name} console: ${m.text()}`); });
  await page.goto(URL);
  await page.waitForSelector('.home-nav');
  return page;
}
const dialogShot = async (p, f) => { const el = await p.$('.acctdlg'); if (el) await el.screenshot({ path: `${OUT}/${f}` }); };
const username = 'Mail_' + Math.random().toString(36).slice(2, 7);
const email = `${username.toLowerCase()}@example.com`;
const pw = 'goat lotus 12';

// ---- A makes an account: the code step
const A = await device('A');
await A.click('.navbtn.acctbtn');
await A.click('.acctdlg button:has-text("New here? Make an account")');
await A.fill('#ac-name', username);
await A.fill('#ac-email', email);
await A.fill('#ac-newpw', pw);
await A.selectOption('.ac-born select[aria-label=Month]', '3');
await A.selectOption('.ac-born select[aria-label=Year]', '2000');
ok((await A.textContent('.ac-go')).includes('Email me a code'), 'the sign-up button says a code comes next');
await A.click('.ac-go');
await A.waitForSelector('#ac-scode', { timeout: 15000 });
ok((await A.textContent('.ac-sent')).includes(email), 'the code screen names the email');
await A.fill('#ac-scode', '000000');
await A.click('.ac-go');
await A.waitForSelector('.acctdlg .ac-err');
ok(/wrong or has run out/.test(await A.textContent('.acctdlg .ac-err')), 'a wrong code says so');
await A.click('.acctdlg button:has-text("Send a new code")');
await A.waitForSelector('.acctdlg .ac-hint:has-text("A new code is on its way")');
await waitMail(email, 2);
ok(mail.filter(m => m.to === email).length === 2, 'a second code was sent');
await A.fill('#ac-scode', codeFor(email));
await dialogShot(A, '01-signup-code.png');
await A.click('.ac-go');
await A.waitForSelector('.ac-recovery', { timeout: 20000 });
ok(!/We emailed you a code to confirm/.test(await A.textContent('.acctdlg')), 'the welcome doesn\'t ask to confirm again (it\'s confirmed)');
await A.click('.acctdlg button:has-text("I’ve saved it, let’s play")');
await A.waitForSelector('.navbtn.acctbtn.in', { timeout: 15000 });

// ---- A turns on login codes
await A.click('.navbtn.acctbtn');
await A.waitForSelector('.ac-account');
ok(await A.$('.ac-chip.good:has-text("Confirmed")') != null, 'the email shows as confirmed');
await A.click('.ac-line:has-text("Login codes") button:has-text("Turn on")');
await A.fill('#ac-2pw', pw);
await A.click('.ac-line:has-text("Login codes") button[type=submit]');
await A.waitForSelector('.ac-line:has-text("Login codes") .ac-chip.good', { timeout: 10000 });
ok((await A.textContent('.ac-line:has-text("Login codes")')).includes('On: logging in on a new device'), 'login codes are on');
await dialogShot(A, '02-account.png');
await A.click('.acctdlg .dlg-actions button:has-text("Close")');

// ---- B, a new device: the password, then the code
const B = await device('B');
await B.click('.navbtn.acctbtn');
await B.fill('#ac-login', username);
await B.fill('#ac-pw', pw);
const before = mail.filter(m => m.to === email).length;
await B.click('.ac-go');
await B.waitForSelector('#ac-lcode', { timeout: 15000 });
ok((await B.textContent('.ac-sent')).includes(`${email[0]}•••@example.com`), 'B is told a code went to the (hidden) email');
await waitMail(email, before + 1);
ok(mail.filter(m => m.to === email).length === before + 1, 'one login code sent');
await B.fill('#ac-lcode', codeFor(email));
await dialogShot(B, '03-login-code.png');
await Promise.all([B.waitForNavigation({ timeout: 25000 }), B.click('.ac-go')]);
await B.waitForSelector('.navbtn.acctbtn.in', { timeout: 15000 });
ok(true, 'B logged in with the code');

// ---- B moves the account to a new email
const email2 = `${username.toLowerCase()}.new@example.com`;
await B.click('.navbtn.acctbtn');
await B.click('.ac-more summary:has-text("Change email")');
await B.fill('#ac-memail', email2);
await B.fill('#ac-mpw', pw);
await B.click('.ac-more:has-text("Change email") button[type=submit]');
await B.waitForSelector('#ac-mcode', { timeout: 15000 });
await waitMail(email2, 1);
await B.fill('#ac-mcode', codeFor(email2));
await B.click('.ac-more:has-text("Change email") button[type=submit]');
await B.waitForSelector('.ac-more .ac-ok:has-text("Your email is changed")', { timeout: 10000 });
ok((await B.textContent('.ac-email')).trim() === email2, 'the account shows the new email');
ok(mail.some(m => m.to === email && /email was changed/.test(m.subject)), 'the old email was told');
await dialogShot(B, '04-email-changed.png');
await B.click('.ac-logout .btn:not(.ghost)');
await B.waitForSelector('.navbtn.acctbtn:not(.in)', { timeout: 15000 });

// ---- B forgot the password: an emailed code comes first
await B.click('.navbtn.acctbtn');
await B.click('.acctdlg button:has-text("Forgot your password?")');
await B.waitForSelector('.ac-seg button[aria-pressed=true]:has-text("Code by email")', { timeout: 10000 });
ok(true, 'the emailed code is the first choice');
await B.fill('#ac-fname', username);
await B.click('.ac-go');
await B.waitForSelector('#ac-ecode', { timeout: 15000 });
await waitMail(email2, 2);
await B.fill('#ac-ecode', codeFor(email2));
await B.fill('#ac-fpw', 'another pass 34');
await dialogShot(B, '05-forgot-code.png');
await Promise.all([B.waitForNavigation({ timeout: 25000 }), B.click('.ac-go')]);
await B.waitForSelector('.navbtn.acctbtn.in', { timeout: 15000 });
ok(true, 'a new password by email, logged in');

// ---- a phone: the code screen fits
const P = await device('P', 390, 820);
await P.click('.navbtn.acctbtn');
await P.fill('#ac-login', username);
await P.fill('#ac-pw', 'another pass 34');
await P.click('.ac-go');
await P.waitForSelector('#ac-lcode', { timeout: 15000 });
ok(await P.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scrolling on a phone');
await P.screenshot({ path: `${OUT}/06-phone-code.png` });

console.log(errors.length ? `errors:\n${errors.join('\n')}` : 'no page errors');
// tidy up: delete the test account
const token = JSON.parse(await B.evaluate(() => localStorage.getItem('pa-account'))).token;
await B.evaluate(async t => fetch('/account/delete', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: JSON.stringify({ password: 'another pass 34' }) }), token);
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
box.close();
process.exit(fail || errors.length ? 1 : 0);
