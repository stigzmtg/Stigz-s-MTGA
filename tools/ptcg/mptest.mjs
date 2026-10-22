// Pokémon battles with a friend, in real browsers: the host makes a room, the guest opens the invite link and takes
// the second seat, the host starts, and both play (a computer player makes their choices for the first turns). Both
// boards must match. Then the guest reloads mid-battle, a third person watches, the host ends the battle and starts
// another one.
// Usage: node tools/ptcg/mptest.mjs [out dir] [turns=8]   (serve dist/ on :8765 first; P2P=1 uses real peer-to-peer rooms)
import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT = process.argv[2] || '/tmp/pkmp';
const TURNS = +(process.argv[3] || 8);
fs.mkdirSync(OUT, { recursive: true });
const mock = fs.readFileSync(new URL('../lib/mockroom-browser.js', import.meta.url), 'utf8');
const P2P = !!process.env.P2P;
const BASE = process.env.BASE || 'http://localhost:8765/'; // BASE=https://... to test a live copy of the site
const browser = await chromium.launch(P2P ? { args: ['--proxy-server=' + process.env.HTTPS_PROXY, '--disable-features=WebRtcHideLocalIpsWithMdns'] } : {});
const pages = [];
const errors = [];
let failed = false;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed = true; };
async function newPlayer(label, deck) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  if (!P2P) {
    await ctx.exposeBinding('__relay', async (src, name, msg) => {
      for (const p of pages) if (p !== src.page) p.evaluate(([n, m]) => window.__relayIn && window.__relayIn(n, m), [name, msg]).catch(() => {});
    });
    await ctx.addInitScript(mock);
  }
  await ctx.addInitScript(([t, d]) => {
    window.__pkAutoplay = t;
    try { localStorage.setItem('pa-settings', JSON.stringify({ aiSpeed: 'fast' })); if (!localStorage.getItem('pk-lobby')) localStorage.setItem('pk-lobby', JSON.stringify({ mine: d, opp: 'random' })); } catch {}
  }, [TURNS, deck]);
  const page = await ctx.newPage();
  page.label = label;
  page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_TUNNEL|WebSocket connection to 'wss:/.test(m.text())) errors.push(`${label}: ${m.text()}`); }); // a public relay being down isn't a page error
  pages.push(page);
  return page;
}
const turnOf = p => p.evaluate(() => +(document.querySelector('.topbar .turninfo b') || {}).textContent || 0).catch(() => 0);
// both sides of the table as this browser shows them, keyed by player name ("You" -> the local name)
const summary = (p, myName) => p.evaluate(nm => [...document.querySelectorAll('.pk-side')].map(s => {
  const name = s.querySelector('.pk-plate .who b').textContent.replace(/^You$/, nm);
  const mons = sel => [...s.querySelectorAll(sel)].map(m => m.querySelector('.pk-card').getAttribute('title'));
  const bottom = s.classList.contains('me');
  return {
    name, deck: s.querySelector('.pk-plate .deck').textContent,
    prizes: s.querySelector('.pk-prizes .cap b').textContent,
    active: mons('.pk-activespot .pk-mon:not(.empty)').join(), bench: mons('.pk-bench .pk-mon:not(.empty)').join(';'),
    piles: [...s.querySelectorAll('.pk-piles .pile b')].map(b => b.textContent).join('/'),
    hand: bottom ? document.querySelectorAll('.pk-hand .pk-handslot').length : +s.querySelector('.opphand b').textContent,
  };
}).sort((a, b) => a.name.localeCompare(b.name)), myName);
// answer whatever this browser's player is being asked, so a battle never waits on a person
async function nudge(p) {
  const pick = await p.$('.dialog .pk-pick:not(.off):not(.on) .pk-card');
  const ok = await p.$('.dialog .btn.primary:not([disabled])');
  if (ok) return ok.click().catch(() => {});
  if (pick) return pick.click().catch(() => {});
  const opt = await p.$('.dialog .pk-optlist .btn');
  if (opt) return opt.click().catch(() => {});
  const mon = await p.$('.pk-mon.targetable .pk-card');
  if (mon) return mon.click().catch(() => {});
  const end = await p.$('.pk-prompt .acts .btn:has-text("End")');
  if (end) return end.click().catch(() => {});
  const any = await p.$('.pk-prompt .acts .btn:not([disabled])');
  if (any) return any.click().catch(() => {});
}
async function playUntil(players, target, ms = 240000) {
  const t0 = Date.now();
  let ts = [];
  while (Date.now() - t0 < ms) {
    ts = await Promise.all(players.map(turnOf));
    if (ts.every(t => t >= target)) break;
    if (await players[0].$('.dialog[aria-label="Game over"]')) break;
    for (const p of players) if (p.label !== 'watcher') await nudge(p);
    await players[0].waitForTimeout(400);
  }
  return ts;
}

const host = await newPlayer('host', 'charizard');
const guest = await newPlayer('guest', 'dragapult');
await host.goto(BASE + '#pokemon');
await host.waitForSelector('text=Pick a deck, start a battle', { timeout: 60000 });
await host.click('.modeswitch button:has-text("Play with friends")');
await host.fill('#nick', 'Hana');
await host.click('button:has-text("Create a room")');
await host.waitForSelector('#invite-link', { timeout: 30000 });
const link = await host.inputValue('#invite-link');
const hash = link.split('#')[1];
const code = hash.replace(/^pk-/, '');
check(/^pk-[a-z0-9]{6}$/.test(hash), `invite link ${link}`);
check((await host.evaluate(() => location.hash)) === '#' + hash, 'the host\'s address carries the room');
await host.screenshot({ path: `${OUT}/1-host-room.png` });

// the guest opens the invite link: Pokémon side, friends tab, code filled in
await guest.goto(BASE + '#' + hash);
await guest.waitForSelector('#room-code', { timeout: 60000 });
check((await guest.inputValue('#room-code')) === code, 'invite link fills in the room code');
await guest.fill('#nick', 'Gus');
await guest.click('button:has-text("Join")');
await guest.waitForSelector('button:has-text("Sit here")', { timeout: 30000 });
await guest.click('button:has-text("Sit here")');
await host.waitForSelector('.seat-row:has-text("Gus")', { timeout: 30000 });
await host.waitForSelector('.seat-row:has-text("Dragapult")', { timeout: 30000 });
await guest.screenshot({ path: `${OUT}/2-guest-room.png` });
await host.waitForSelector('button:has-text("Start battle"):not([disabled])', { timeout: 30000 });
await host.click('button:has-text("Start battle")');
for (const p of [host, guest]) await p.waitForSelector('.pk-board', { timeout: 30000 });
check(true, 'both browsers are in the battle');

let ts = await playUntil([host, guest], TURNS);
await host.waitForTimeout(1500);
let [sa, sb] = await Promise.all([summary(host, 'Hana'), summary(guest, 'Gus')]);
await host.screenshot({ path: `${OUT}/3-host-battle.png` });
await guest.screenshot({ path: `${OUT}/4-guest-battle.png` });
console.log('turns', ts.join(', '));
console.log('host view ', JSON.stringify(sa));
console.log('guest view', JSON.stringify(sb));
check(JSON.stringify(sa) === JSON.stringify(sb), 'host and guest boards match');
check(sa.length === 2 && sa.some(s => s.name === 'Gus' && /Dragapult/.test(s.deck)) && sa.some(s => s.name === 'Hana' && /Charizard/.test(s.deck)), 'each player brought their own deck');

// the guest reloads with the invite link (its name is remembered: straight back in), a third person watches
const LATER = TURNS + 4;
await guest.context().addInitScript(t => { window.__pkAutoplay = t; }, LATER);
await host.evaluate(t => { window.__pkAutoplay = t; }, LATER);
await guest.goto(BASE + '#' + hash);
await guest.reload();
const watcher = await newPlayer('watcher', 'miraidon');
await watcher.goto(link.replace(/^.*#/, BASE + '#'));
await watcher.waitForSelector('#room-code', { timeout: 60000 });
await watcher.fill('#nick', 'Wren');
await watcher.click('button:has-text("Join")');
await watcher.waitForSelector('button:has-text("Watch the battle")', { timeout: 30000 });
await watcher.click('button:has-text("Watch the battle")');
for (const p of [guest, watcher]) await p.waitForSelector('.pk-board', { timeout: 60000 });
ts = await playUntil([host, guest, watcher], TURNS + 2);
console.log('turns after reload (host, guest, watcher):', ts.join(', '));
await host.waitForTimeout(2500);
const views = await Promise.all([summary(host, 'Hana'), summary(guest, 'Gus'), summary(watcher, 'Wren')]);
await watcher.screenshot({ path: `${OUT}/5-watcher.png` });
await guest.screenshot({ path: `${OUT}/6-guest-after-reload.png` });
for (const [n, v] of [['host', views[0]], ['guest', views[1]], ['watch', views[2]]]) console.log(' ', n.padEnd(6), JSON.stringify(v));
// the watcher sees no hand cards, only backs
check(views.every(v => JSON.stringify(v) === JSON.stringify(views[0])), 'host, reloaded guest and watcher boards match');
check(!(await watcher.$('.pk-hand .pk-handslot img')), 'the watcher sees no cards in hand');
check(await watcher.$('.roomstatus .chip:has-text("Watching")') != null, 'the watcher is marked as watching');

// the host ends the battle while its own prompt is open (leaving must not send that prompt's answer as a move):
// the guest is told and goes back to the room; then the host starts the next one
for (const p of [host, guest]) await p.evaluate(() => { window.__pkAutoplay = 0; });
for (let i = 0; i < 120 && !(await host.$('.pk-prompt .acts .btn')) && !(await host.$('.dialog')); i++) { await nudge(guest); await host.waitForTimeout(400); }
const over = await host.$('.dialog[aria-label="Game over"]');
if (!over) check(!!(await host.$('.pk-prompt .acts .btn, .dialog')), 'the host has a prompt open when ending the battle');
if (!over) {
  await host.click('.topbar button:has-text("End battle")');
  const told = await guest.waitForSelector('.toast:has-text("The host ended the battle")', { timeout: 30000 }).then(() => true, () => false);
  if (!told) {
    const st = p => p.evaluate(() => { const d = window.__pkDebug; if (!d || !d.room) return 'no room'; const r = d.room; return JSON.stringify({ cfg: r.cfg && { s: r.cfg.started, g: r.cfg.game }, session: !!d.session, over: d.session && d.session.game.over, game: d.session && d.session.online && d.session.online.game, peers: (r.room.peers() || []).map(x => ({ me: x.isMe, cid: x.presence.cid, cfg: x.presence.cfg && { s: x.presence.cfg.started, g: x.presence.cfg.game } })) }); });
    for (const p of [host, guest, watcher]) console.log(p.label, await st(p));
    await guest.screenshot({ path: `${OUT}/x-guest-not-told.png` });
  }
  check(told, 'the guest is told the host ended the battle');
} else {
  await host.click('.dialog button:has-text("Back to room")');
  check(true, 'battle was already over; host went back to the room');
  await guest.click('.topbar button:has-text("Back to room")').catch(() => {});
}
await host.waitForSelector('button:has-text("Start battle"):not([disabled])', { timeout: 30000 });
await host.evaluate(() => { window.__pkAutoplay = 3; });
await guest.evaluate(() => { window.__pkAutoplay = 3; });
await host.click('button:has-text("Start battle")');
for (const p of [host, guest]) await p.waitForSelector('.pk-board', { timeout: 30000 });
ts = await playUntil([host, guest], 3, 120000);
await host.waitForTimeout(1500);
[sa, sb] = await Promise.all([summary(host, 'Hana'), summary(guest, 'Gus')]);
await guest.screenshot({ path: `${OUT}/7-second-battle.png` });
check(JSON.stringify(sa) === JSON.stringify(sb) && ts.every(t => t >= 1), `second battle in the same room matches (turns ${ts.join(', ')})`);

check(!errors.length, errors.length ? 'page errors:\n' + errors.slice(0, 10).join('\n') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
