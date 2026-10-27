// Verified badges in friends' rooms, in real browsers against a local server (`npx wrangler dev` on :8787, rooms
// through its relay): a logged-in host's name is fixed to the account and shows ✓ to everyone, in the room and at
// the table, and a guest who types the same name gets none. (A badge copied onto another player or into another
// room failing its check is covered by tools/accounttest.mjs.) Usage: node tools/badgeui.mjs [out dir] [site]
import fs from 'node:fs';
import { chromium } from 'playwright';

const OUT = process.argv[2] || '/tmp/badgeui';
const BASE = process.argv[3] || 'http://localhost:8787/';
fs.mkdirSync(OUT, { recursive: true });
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await chromium.launch(/^https:/.test(BASE) && proxy ? { proxy: { server: proxy } } : {});
const errors = [];
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };
const API = /\.github\.io$/.test(new URL(BASE).hostname) ? 'https://stigz-s-mtga.stigzrblx.workers.dev' : new URL(BASE).origin;

async function browserFor(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => { window.__paTransport = 'relay'; try { localStorage.setItem('pa-settings', JSON.stringify({ aiSpeed: 'fast' })); } catch { /* blocked */ } });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${name} console: ${m.text()}`); });
  return page;
}
const username = 'Badge_' + Math.random().toString(36).slice(2, 7);
const password = 'badge password 1';

// ---- the host has an account (made through the API, then logged in on the page)
const host = await browserFor('host');
await host.goto(BASE);
const made = await host.evaluate(async ([api, u, pw]) => (await fetch(`${api}/account/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, email: `${u.toLowerCase()}@example.com`, password: pw }) })).json(), [API, username, password]);
ok(made && made.token, 'host account made');
await host.evaluate(m => localStorage.setItem('pa-account', JSON.stringify({ token: m.token, user: m.user })), made);
await host.reload();
const guest = await browserFor('guest');
for (const p of [host, guest]) { await p.goto(BASE + '#mtg'); await p.waitForSelector('text=Pick a deck, take a seat', { timeout: 60000 }); }

await host.click('button:has-text("Play with friends")');
ok(await host.inputValue('#nick') === username && await host.$eval('#nick', e => e.readOnly), 'the host\'s room name is the account name, fixed');
await host.click('button:has-text("Create a room")');
await host.waitForSelector('#invite-link');
const code = (await host.inputValue('#invite-link')).split('#').pop();
// the guest types the host's name: no badge for them
await guest.click('button:has-text("Play with friends")');
await guest.fill('#nick', username);
await guest.fill('#room-code', code);
await guest.click('button:has-text("Join")');
await guest.waitForSelector('button:has-text("Sit here")', { timeout: 20000 });
await guest.click('button:has-text("Sit here")');
await host.waitForSelector('.seat-row:nth-child(2) .seat-who b:not(.muted)', { timeout: 20000 });
await host.waitForSelector('.seat-row:nth-child(1) .vbadge', { timeout: 15000 });
await guest.waitForSelector('.seat-row:nth-child(1) .vbadge', { timeout: 15000 });
const badges = p => p.evaluate(() => [...document.querySelectorAll('.seat-row')].map(r => !!r.querySelector('.vbadge')));
ok(JSON.stringify(await badges(host)) === '[true,false]', `the host sees ✓ on their seat only (${JSON.stringify(await badges(host))})`);
ok(JSON.stringify(await badges(guest)) === '[true,false]', `the guest sees ✓ on the host only, not on their own copy of the name (${JSON.stringify(await badges(guest))})`);
ok((await host.$$('.lineup-card .vbadge')).length === 1, 'one ✓ in the lineup');
await host.screenshot({ path: `${OUT}/01-room.png`, clip: await host.$eval('.panel.room', e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 700) }; }) });

// ---- at the table
await host.waitForSelector('button:has-text("Start game"):not([disabled])', { timeout: 20000 });
await host.click('button:has-text("Start game")');
for (const p of [host, guest]) await p.waitForSelector('.topbar .turninfo', { timeout: 30000 });
await host.waitForTimeout(2000);
const tableBadges = p => p.evaluate(() => [...document.querySelectorAll('.mat')].map(m => [m.querySelector('.pname .pn')?.textContent, !!m.querySelector('.pname .vbadge')]));
const tb = await tableBadges(guest);
ok(tb.filter(([, v]) => v).length === 1, `one ✓ at the table (${JSON.stringify(tb)})`);
await guest.screenshot({ path: `${OUT}/02-table.png` });

// ---- a Pokémon room (the host still logged in, a fresh guest)
const pkHost = await browserFor('pk host');
await pkHost.goto(BASE);
await pkHost.evaluate(m => localStorage.setItem('pa-account', JSON.stringify({ token: m.token, user: m.user })), made);
await pkHost.reload();
await pkHost.goto(BASE + '#pokemon');
await pkHost.waitForSelector('text=Pick a deck, start a battle', { timeout: 60000 });
await pkHost.click('.modeswitch button:has-text("Play with friends")');
await pkHost.click('button:has-text("Create a room")');
await pkHost.waitForSelector('#invite-link', { timeout: 30000 });
const pkHash = (await pkHost.inputValue('#invite-link')).split('#').pop();
const pkGuest = await browserFor('pk guest');
await pkGuest.goto(BASE + '#' + pkHash);
await pkGuest.waitForSelector('#room-code', { timeout: 60000 });
await pkGuest.fill('#nick', 'Gus');
await pkGuest.click('button:has-text("Join")');
await pkGuest.waitForSelector('.seat-row .vbadge', { timeout: 20000 });
ok((await pkGuest.$$('.seat-row .vbadge')).length === 1, 'the Pokémon room shows the host\'s ✓ to the guest');

console.log(errors.length ? `errors:\n${errors.join('\n')}` : 'no page errors');
// tidy up: delete the test account
await host.evaluate(async ([api, t, pw]) => fetch(`${api}/account/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: JSON.stringify({ password: pw }) }), [API, made.token, password]);
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail || errors.length ? 1 : 0);
