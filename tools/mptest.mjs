// Multiplayer in real browsers: two separate profiles (host + guest) share a stand-in room relayed by this
// script. The host creates a room with an AI seat, the guest joins with the room code, the host starts,
// both play (an AI makes their choices for the first turns), and both boards must match.
// Usage: node tools/mptest.mjs <out dir> [turns=10]
import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT = process.argv[2] || '/tmp/mptest';
const TURNS = +(process.argv[3] || 10);
fs.mkdirSync(OUT, { recursive: true });
const mock = fs.readFileSync(new URL('./lib/mockroom-browser.js', import.meta.url), 'utf8');
// P2P=1: no stand-in; the website's real peer-to-peer rooms (public Nostr relays through the proxy, WebRTC between profiles)
const P2P = !!process.env.P2P;
const BASE = process.env.BASE || 'http://localhost:8765/';
// RELAY=1: the site's own relay (run the Worker locally: wrangler dev --assets dist --port 8787, and BASE=http://localhost:8787/);
// RELAY=poll: the same, with WebSockets treated as blocked
const RELAY = process.env.RELAY || '';
const browser = await chromium.launch(P2P || RELAY ? { args: ['--proxy-server=' + process.env.HTTPS_PROXY, '--proxy-bypass-list=localhost;127.0.0.1', '--disable-features=WebRtcHideLocalIpsWithMdns'] } : {});
const pages = [];
const errors = [];
async function newPlayer(label) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  await ctx.addInitScript(([p2p, relay]) => { if (p2p) window.__paTransport = 'p2p'; if (relay) window.__paTransport = 'relay'; if (relay === 'poll') window.__paRelayPoll = true; }, [P2P, RELAY]);
  if (!P2P && !RELAY) {
    await ctx.exposeBinding('__relay', async (src, name, msg) => {
      for (const p of pages) if (p !== src.page) p.evaluate(([n, m]) => window.__relayIn && window.__relayIn(n, m), [name, msg]).catch(() => {});
    });
    await ctx.addInitScript(mock);
  }
  await ctx.addInitScript(t => { window.__paAutoplay = t; try { localStorage.setItem('pa-settings', JSON.stringify({ aiSpeed: 'fast' })); } catch {} }, TURNS);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_TUNNEL/.test(m.text())) errors.push(`${label}: ${m.text()}`); });
  pages.push(page);
  return page;
}
const host = await newPlayer('host');
const guest = await newPlayer('guest');
for (const p of [host, guest]) { await p.goto(BASE + '#mtg'); await p.waitForSelector('text=Pick a deck, take a seat', { timeout: 60000 }); }

await host.click('button:has-text("Play with friends")');
await host.fill('#nick', 'Hana');
await host.click('button:has-text("Create a room")');
await host.waitForSelector('#invite-link');
const link = await host.inputValue('#invite-link');
const code = link.split('#')[1];
console.log('room code', code, 'link', link);
await host.click('.seg[aria-label="Number of seats"] button:has-text("3")');
await host.selectOption('#seat-kind-2', 'ai');
await host.screenshot({ path: `${OUT}/1-host-room.png` });

await guest.click('button:has-text("Play with friends")');
await guest.fill('#nick', 'Gus');
await guest.fill('#room-code', code);
await guest.click('button:has-text("Join")');
await guest.waitForSelector('button:has-text("Sit here")', { timeout: 20000 });
await guest.click('button:has-text("Sit here")');
await host.waitForSelector('.seat-row:has-text("Gus")', { timeout: 20000 });
await guest.screenshot({ path: `${OUT}/2-guest-room.png` });
await host.waitForSelector('button:has-text("Start game"):not([disabled])', { timeout: 20000 });
await host.click('button:has-text("Start game")');

// both get a game; play through mulligans (keep) until the autoplay hands control back
for (const p of [host, guest]) await p.waitForSelector('.topbar .turninfo', { timeout: 30000 });
const turnOf = p => p.evaluate(() => +(document.querySelector('.topbar .turninfo b') || {}).textContent || 0);
const t0 = Date.now();
while (Date.now() - t0 < 240000) {
  const [a, b] = await Promise.all([turnOf(host), turnOf(guest)]);
  if (a >= TURNS && b >= TURNS) break;
  await host.waitForTimeout(500);
}
await host.waitForTimeout(1500);
const summary = p => p.evaluate(() => [...document.querySelectorAll('.mat')].map(m => ({ name: m.querySelector('.pname')?.firstChild?.textContent, life: m.querySelector('.lifetotal b')?.textContent, cards: m.querySelectorAll('.field .cardwrap').length })).sort((x, y) => (x.name || '').localeCompare(y.name || '')));
const [sa, sb] = await Promise.all([summary(host), summary(guest)]);
await host.screenshot({ path: `${OUT}/3-host-game.png` });
await guest.screenshot({ path: `${OUT}/4-guest-game.png` });
console.log('host view ', JSON.stringify(sa));
console.log('guest view', JSON.stringify(sb));
console.log(JSON.stringify(sa) === JSON.stringify(sb) ? 'boards match' : 'BOARDS DIFFER');
// the guest reloads mid-game with the invite link, rejoins its seat and replays from local storage;
// a third person opens the link and watches
const LATER = TURNS + 6;
await guest.context().addInitScript(t => { window.__paAutoplay = t; }, LATER);
await host.evaluate(t => { window.__paAutoplay = t; }, LATER);
await guest.goto(BASE + '#' + link.split('#')[1]);
await guest.reload(); // the link may differ from the current address only by its #, which doesn't reload the page
// the host's own pending choice is still on screen: answer it so its AI stand-in takes over again
const nudge = async (p) => {
  const dlg = await p.$('.overlay .dialog .btn.primary:not([disabled])');
  if (dlg) return dlg.click().catch(() => {});
  const b = await p.$('.prompt .acts .btn.primary:not([disabled])');
  if (b) return b.click().catch(() => {});
};
const watcher = await newPlayer('watcher');
await watcher.goto(BASE + '#mtg');
await watcher.waitForSelector('text=Pick a deck, take a seat', { timeout: 60000 });
await watcher.click('button:has-text("Play with friends")');
await watcher.fill('#nick', 'Wren');
await watcher.fill('#room-code', code);
await watcher.click('button:has-text("Join")');
await watcher.waitForSelector('button:has-text("Watch the game")', { timeout: 30000 });
await watcher.click('button:has-text("Watch the game")');
for (const p of [guest, watcher]) await p.waitForSelector('.topbar .turninfo', { timeout: 60000 });
const target = TURNS + 4;
const t1 = Date.now();
let ts = [];
while (Date.now() - t1 < 240000) {
  ts = await Promise.all([host, guest, watcher].map(turnOf));
  if (ts.every(t => t >= target)) break;
  await nudge(host); await nudge(guest);
  await host.waitForTimeout(500);
}
console.log('turns reached (host, guest, watcher):', ts.join(', '));
await host.waitForTimeout(2000);
// the game keeps going (the AI seat plays on) while three browsers are read one after another, so a mismatch can be
// a moment apart: read again a few times; a real desync stays
let views = await Promise.all([host, guest, watcher].map(summary));
for (let k = 0; k < 6 && !views.every(v => JSON.stringify(v) === JSON.stringify(views[0])); k++) { await host.waitForTimeout(1500); views = await Promise.all([host, guest, watcher].map(summary)); }
await watcher.screenshot({ path: `${OUT}/5-watcher.png` });
await guest.screenshot({ path: `${OUT}/6-guest-after-reload.png` });
console.log('after reload + watcher:');
for (const [n, v] of [['host', views[0]], ['guest', views[1]], ['watch', views[2]]]) console.log(' ', n.padEnd(6), JSON.stringify(v));
console.log(views.every(v => JSON.stringify(v) === JSON.stringify(views[0])) ? 'all three boards match' : 'BOARDS DIFFER');
console.log(errors.length ? 'errors:\n' + errors.slice(0, 10).join('\n') : 'no page errors');
await browser.close();
