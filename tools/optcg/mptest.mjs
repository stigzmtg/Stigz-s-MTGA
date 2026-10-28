// One Piece battles with a friend, in real browsers: the host makes a room, the guest opens the invite link and takes
// the second seat, the host starts, and both play (a computer player makes their choices for the first turns). Both
// boards must match. Then the guest reloads mid-battle, a third person watches, the host ends the battle and starts
// another one. CUSTOM=1: both bring a deck of their own from the deck builder (saved on their device, unknown to the
// other browsers): the host sees the guest's deck in the room, the watcher and the reloaded guest build the same battle
// from the room, and the guest changing their deck mid-battle doesn't change it.
// Usage: node tools/optcg/mptest.mjs [out dir] [turns=8]   (serve dist/ on :8765 first; P2P=1 uses real peer-to-peer rooms)
import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT = process.argv[2] || '/tmp/opmp';
const TURNS = +(process.argv[3] || 8);
fs.mkdirSync(OUT, { recursive: true });
const mock = fs.readFileSync(new URL('../lib/mockroom-browser.js', import.meta.url), 'utf8');
const P2P = !!process.env.P2P;
// RELAY=1: the site's own relay (run the Worker locally: wrangler dev --assets dist --port 8787, and BASE=http://localhost:8787/);
// RELAY=poll: the same, with WebSockets treated as blocked
const RELAY = process.env.RELAY || '';
const BASE = process.env.BASE || 'http://localhost:8765/'; // BASE=https://... to test a live copy of the site
const browser = await chromium.launch(P2P || RELAY ? { args: ['--proxy-server=' + process.env.HTTPS_PROXY, '--proxy-bypass-list=localhost;127.0.0.1', '--disable-features=WebRtcHideLocalIpsWithMdns'] } : {});
const pages = [];
const errors = [];
let failed = false;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed = true; };
// CUSTOM=1: decks of the players' own, as the deck builder saves them (src/optcg/ui/mydecks.js)
const CUSTOM = !!process.env.CUSTOM;
const starters = JSON.parse(fs.readFileSync(new URL('../../data/optcg/decks.json', import.meta.url), 'utf8'));
const ownDeck = (id, name, from, swap) => { const d = starters.find(x => x.id === from); return { id, name, leader: d.leader, cards: d.cards.map(([k, n]) => (swap && k === swap[0] ? [swap[1], n] : [k, n])), updated: Date.now() }; };
const OWN = { host: ownDeck('opd-hanadeck1', 'Hana’s Red Crew', 'st01', ['ST01-007', 'OP01-016']), guest: ownDeck('opd-gusdeck22', 'Gus’s Green Wall', 'st02') };
async function newPlayer(label, deck) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  await ctx.addInitScript(([p2p, relay]) => { window.__paExpose = true; if (p2p) window.__paTransport = 'p2p'; if (relay) window.__paTransport = 'relay'; if (relay === 'poll') window.__paRelayPoll = true; }, [P2P, RELAY]);
  if (!P2P && !RELAY) {
    await ctx.exposeBinding('__relay', async (src, name, msg) => {
      for (const p of pages) if (p !== src.page) p.evaluate(([n, m]) => window.__relayIn && window.__relayIn(n, m), [name, msg]).catch(() => {});
    });
    await ctx.addInitScript(mock);
  }
  const own = CUSTOM && OWN[label];
  await ctx.addInitScript(([t, d, own]) => {
    window.__opAutoplay = t;
    try {
      localStorage.setItem('pa-settings', JSON.stringify({ aiSpeed: 'fast' })); localStorage.setItem('pa-tips', JSON.stringify({ op: { off: true } }));
      if (own && !localStorage.getItem('op-custom-decks')) localStorage.setItem('op-custom-decks', JSON.stringify([own]));
      if (!localStorage.getItem('op-lobby')) { const [m, l] = (own ? own.id : d).split('@'); localStorage.setItem('op-lobby', JSON.stringify({ mine: m, opp: 'random', leads: l ? { [m]: l } : {} })); }
    } catch {}
  }, [TURNS, deck, own || null]);
  const page = await ctx.newPage();
  page.label = label;
  page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_TUNNEL|WebSocket connection to 'wss:/.test(m.text())) errors.push(`${label}: ${m.text()}`); }); // a public relay being down isn't a page error
  pages.push(page);
  return page;
}
const turnOf = p => p.evaluate(() => +(document.querySelector('.topbar .turninfo b') || {}).textContent || 0).catch(() => 0);
// both sides of the table as this browser shows them, keyed by player name ("You" -> the local name)
const summary = (p, myName) => p.evaluate(nm => [...document.querySelectorAll('.op-side')].map(s => {
  const name = s.querySelector('.op-plate .who b').textContent.replace(/^You$/, nm);
  const cards = sel => [...s.querySelectorAll(sel)].map(m => m.querySelector('.op-card').getAttribute('title'));
  const bottom = s.classList.contains('me');
  return {
    name, deck: (s.querySelector('.op-plate .deck') || {}).textContent || '',
    life: s.querySelector('.op-life .cap b').textContent,
    leader: cards('.op-back .op-slot.lead:not(.empty)').join(), chars: cards('.op-chars .op-slot:not(.empty)').join(';'),
    don: s.querySelector('.op-cost').getAttribute('title'),
    piles: [...s.querySelectorAll('.op-piles .pile:not(.hand) b')].map(b => b.textContent).join('/'),
    hand: bottom ? document.querySelectorAll('.op-hand .op-handslot').length : +s.querySelector('.op-piles .pile.hand b').textContent,
  };
}).sort((a, b) => a.name.localeCompare(b.name)), myName);
// answer whatever this browser's player is being asked, so a battle never waits on a person
async function nudge(p) {
  const pick = await p.$('.dialog .op-pick:not(.off):not(.on) .op-card');
  const ok = await p.$('.dialog .btn.primary:not([disabled])');
  if (ok) return ok.click().catch(() => {});
  if (pick) return pick.click().catch(() => {});
  const opt = await p.$('.dialog .optlist .btn');
  if (opt) return opt.click().catch(() => {});
  const tg = await p.$('.op-slot.targetable .op-card');
  if (tg) return tg.click().catch(() => {});
  const end = await p.$('.op-prompt .acts .btn:has-text("End")');
  if (end) return end.click().catch(() => {});
  const any = await p.$('.op-prompt .acts .btn:not([disabled])');
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

const guestDeck = (process.env.GUEST_DECK || 'st02').split('@')[0];
const guestCode = guestDeck.replace(/^st/, 'ST-');
const host = await newPlayer('host', 'st01');
const guest = await newPlayer('guest', process.env.GUEST_DECK || 'st02');
await host.goto(BASE + '#onepiece');
await host.waitForSelector('.op-decks', { timeout: 60000 });
await host.click('.modeswitch button:has-text("Play with friends")');
await host.fill('#nick', 'Hana');
await host.click('button:has-text("Create a room")');
await host.waitForSelector('#invite-link', { timeout: 30000 });
const link = await host.inputValue('#invite-link');
const hash = link.split('#')[1];
const code = hash.replace(/^op-/, '');
check(/^op-[a-z0-9]{6}$/.test(hash), `invite link ${link}`);
check((await host.evaluate(() => location.hash)) === '#' + hash, 'the host\'s address carries the room');
await host.screenshot({ path: `${OUT}/1-host-room.png` });

// the guest opens the invite link: One Piece side, friends tab, code filled in
await guest.goto(BASE + '#' + hash);
await guest.waitForSelector('#room-code', { timeout: 60000 });
check((await guest.inputValue('#room-code')) === code, 'invite link fills in the room code');
await guest.fill('#nick', 'Gus');
await guest.click('button:has-text("Join")');
await guest.waitForSelector('button:has-text("Sit here")', { timeout: 30000 });
await guest.click('button:has-text("Sit here")');
await host.waitForSelector('.seat-row:has-text("Gus")', { timeout: 30000 });
await host.waitForSelector(`.seat-row:has-text("${CUSTOM ? OWN.guest.name : guestCode}")`, { timeout: 30000 });
if (CUSTOM) {
  check(true, 'the host sees the guest’s own deck in the room (its list came with the guest)');
  check(await guest.waitForSelector(`.seat-row:has-text("${OWN.host.name}")`, { timeout: 30000 }).then(() => true, () => false), 'and the guest sees the host’s');
}
await guest.screenshot({ path: `${OUT}/2-guest-room.png` });
await host.waitForSelector('button:has-text("Start battle"):not([disabled])', { timeout: 30000 });
await host.click('button:has-text("Start battle")');
for (const p of [host, guest]) await p.waitForSelector('.op-board', { timeout: 30000 });
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
const deckNames = await host.evaluate(async () => { const r = await fetch('data/optcg/decks.json'); const d = await r.json(); return Object.fromEntries(d.map(x => [x.id, x.name])); });
check(sa.length === 2 && sa.some(s => s.name === 'Gus' && s.deck === (CUSTOM ? OWN.guest.name : deckNames[guestDeck])) && sa.some(s => s.name === 'Hana' && s.deck === (CUSTOM ? OWN.host.name : deckNames.st01)), 'each player brought their own deck');
if (CUSTOM) {
  // the whole decks, as each browser dealt them: the same lists on both, the ones the players brought
  const dealt = p => p.evaluate(() => window.__opDebug.session.game.players.map(q => [q.leader.def.id, ...[...q.hand, ...q.deck, ...q.trash, ...q.life, ...q.characters, ...(q.stage ? [q.stage] : [])].map(c => c.def.id).sort()].join(',')));
  const want = [OWN.host, OWN.guest].map(d => [d.leader, ...d.cards.flatMap(([k, n]) => Array(n).fill(k)).sort()].join(','));
  const [dh, dg] = await Promise.all([dealt(host), dealt(guest)]);
  check(JSON.stringify(dh) === JSON.stringify(want) && JSON.stringify(dg) === JSON.stringify(want), 'both browsers dealt each player exactly the deck they built');
  // during the battle the lists travel in the host's config, not in each player's presence
  const inPresence = await host.evaluate(() => [...window.__opDebug.room.members().values()].map(m => !!m.presence.dk));
  check(inPresence.every(x => !x), 'no deck list in anyone’s presence while the battle is on');
}
if (process.env.GUEST_LEADER) check(sa.some(s => s.name === 'Gus' && s.leader.startsWith(process.env.GUEST_LEADER)), `the guest leads with ${process.env.GUEST_LEADER} on both screens`);

// the guest reloads with the invite link (its name is remembered: straight back in), a third person watches
const LATER = TURNS + 4;
await guest.context().addInitScript(t => { window.__opAutoplay = t; }, LATER);
await host.evaluate(t => { window.__opAutoplay = t; }, LATER);
// (CUSTOM: the guest changes their deck in the builder first, taking a card out: the battle goes on as it started)
if (CUSTOM) await guest.evaluate(() => { const l = JSON.parse(localStorage.getItem('op-custom-decks')); l[0].cards = l[0].cards.slice(1); localStorage.setItem('op-custom-decks', JSON.stringify(l)); });
await guest.goto(BASE + '#' + hash);
await guest.reload();
const watcher = await newPlayer('watcher', 'st03');
await watcher.goto(link.replace(/^.*#/, BASE + '#'));
await watcher.waitForSelector('#room-code', { timeout: 60000 });
await watcher.fill('#nick', 'Wren');
await watcher.click('button:has-text("Join")');
await watcher.waitForSelector('button:has-text("Watch the battle")', { timeout: 30000 });
await watcher.click('button:has-text("Watch the battle")');
for (const p of [guest, watcher]) await p.waitForSelector('.op-board', { timeout: 60000 });
ts = await playUntil([host, guest, watcher], TURNS + 2);
console.log('turns after reload (host, guest, watcher):', ts.join(', '));
await host.waitForTimeout(2500);
const views = await Promise.all([summary(host, 'Hana'), summary(guest, 'Gus'), summary(watcher, 'Wren')]);
await watcher.screenshot({ path: `${OUT}/5-watcher.png` });
await guest.screenshot({ path: `${OUT}/6-guest-after-reload.png` });
for (const [n, v] of [['host', views[0]], ['guest', views[1]], ['watch', views[2]]]) console.log(' ', n.padEnd(6), JSON.stringify(v));
// the watcher sees no hand cards, only backs
check(views.every(v => JSON.stringify(v) === JSON.stringify(views[0])), 'host, reloaded guest and watcher boards match');
check(!(await watcher.$('.op-hand .op-handslot img')), 'the watcher sees no cards in hand');
check(await watcher.$('.roomstatus .chip:has-text("Watching")') != null, 'the watcher is marked as watching');

// the host ends the battle while its own prompt is open (leaving must not send that prompt's answer as a move):
// the guest is told and goes back to the room; then the host starts the next one
for (const p of [host, guest]) await p.evaluate(() => { window.__opAutoplay = 0; });
for (let i = 0; i < 120 && !(await host.$('.op-prompt .acts .btn')) && !(await host.$('.dialog')); i++) { await nudge(guest); await host.waitForTimeout(400); }
const over = await host.$('.dialog[aria-label="Game over"]');
if (!over) check(!!(await host.$('.op-prompt .acts .btn, .dialog')), 'the host has a prompt open when ending the battle');
if (!over) {
  await host.click('.topbar button:has-text("End battle")');
  const told = await guest.waitForSelector('.toast:has-text("The host ended the battle")', { timeout: 30000 }).then(() => true, () => false);
  if (!told) {
    const st = p => p.evaluate(() => { const d = window.__opDebug; if (!d || !d.room) return 'no room'; const r = d.room; return JSON.stringify({ cfg: r.cfg && { s: r.cfg.started, g: r.cfg.game }, session: !!d.session, over: d.session && d.session.game.over, game: d.session && d.session.online && d.session.online.game, peers: (r.room.peers() || []).map(x => ({ me: x.isMe, cid: x.presence.cid, cfg: x.presence.cfg && { s: x.presence.cfg.started, g: x.presence.cfg.game } })) }); });
    for (const p of [host, guest, watcher]) console.log(p.label, await st(p));
    await guest.screenshot({ path: `${OUT}/x-guest-not-told.png` });
  }
  check(told, 'the guest is told the host ended the battle');
} else {
  await host.click('.dialog button:has-text("Back to room")');
  check(true, 'battle was already over; host went back to the room');
  await guest.click('.topbar button:has-text("Back to room")').catch(() => {});
}
if (CUSTOM) {
  // the guest's changed deck is short of 50 cards: the next battle can't start until it's finished again
  const waiting = await host.waitForSelector('button:has-text("deck isn’t finished")[disabled]', { timeout: 30000 }).then(() => true, () => false);
  check(waiting, 'the host can’t start with the guest’s unfinished deck, and the button says why');
  await guest.evaluate(own => { localStorage.setItem('op-custom-decks', JSON.stringify([own])); }, OWN.guest);
  await guest.reload();
  await guest.waitForSelector('.op-room', { timeout: 60000 });
}
await host.waitForSelector('button:has-text("Start battle"):not([disabled])', { timeout: 30000 });
await host.evaluate(() => { window.__opAutoplay = 3; });
await guest.evaluate(() => { window.__opAutoplay = 3; });
await host.click('button:has-text("Start battle")');
for (const p of [host, guest]) await p.waitForSelector('.op-board', { timeout: 30000 });
ts = await playUntil([host, guest], 3, 120000);
await host.waitForTimeout(1500);
[sa, sb] = await Promise.all([summary(host, 'Hana'), summary(guest, 'Gus')]);
await guest.screenshot({ path: `${OUT}/7-second-battle.png` });
check(JSON.stringify(sa) === JSON.stringify(sb) && ts.every(t => t >= 1), `second battle in the same room matches (turns ${ts.join(', ')})`);

// no copy of the battle drifted from the host's along the way (each would have rebuilt itself: ui/online.jsx watchDesync)
const drift = (await Promise.all(pages.map(p => p.evaluate(() => window.__paDrift || []).catch(() => [])))).flat();
check(!drift.length, `no copy drifted${drift.length ? ': ' + JSON.stringify(drift) : ''}`);
// the largest presence each browser sent (rooms cap them: 4 KiB on claude.ai, 9,000 characters on the site's relay)
console.log('largest presence per browser:', (await Promise.all(pages.map(p => p.evaluate(() => [window.__maxPresence || 0, window.__presenceRejected || 0]).catch(() => [-1, 0])))).map(([m, r]) => m + (r ? ` (${r} refused)` : '')).join(', '));
check(!errors.length, errors.length ? 'page errors:\n' + errors.slice(0, 10).join('\n') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
