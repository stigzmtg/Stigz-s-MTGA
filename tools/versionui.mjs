// Friends on two versions of the game (one page opened before an update), in two real browsers (Commander, a
// stand-in room relayed by this script as in mptest.mjs). Lockstep games between two rule sets drift apart and
// freeze, so:
//  - in the room, the host can't start, and each screen says who needs to reload (the one with the older version);
//  - after that player reloads, the note goes away and the game starts;
//  - if it happens during a game (the host reloads after an update mid-game), both screens say so in the top bar.
// Usage: node tools/versionui.mjs [out dir]   (serve dist/ on :8765 first)
import fs from 'node:fs';
import { chromium } from 'playwright';

const OUT = process.argv[2] || '/tmp/versionui';
const BASE = process.env.BASE || 'http://localhost:8765/';
fs.mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };
const mock = fs.readFileSync(new URL('./lib/mockroom-browser.js', import.meta.url), 'utf8');
const browser = await chromium.launch();
const pages = [], errors = [];
async function player(label) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  await ctx.exposeBinding('__relay', async (src, name, msg) => { for (const p of pages) if (p !== src.page) p.evaluate(([n, m]) => window.__relayIn && window.__relayIn(n, m), [name, msg]).catch(() => {}); });
  await ctx.addInitScript(mock);
  await ctx.addInitScript(() => {
    window.__paExpose = true;
    // the version this page poses as (src/net/version.js), set by the steps below before a reload
    const v = sessionStorage.getItem('fake-version');
    if (v) window.__paFakeVersion = JSON.parse(v);
    try { localStorage.setItem('pa-settings', JSON.stringify({ aiSpeed: 'fast' })); localStorage.setItem('pa-tips', JSON.stringify({ mtg: { off: true, seen: [] } })); } catch { /* blocked */ }
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
  pages.push(page);
  return page;
}
const host = await player('host'), guest = await player('guest');
// the guest's page was opened before the update: an older version
await guest.goto(BASE + '#mtg');
await guest.evaluate(() => sessionStorage.setItem('fake-version', JSON.stringify({ gv: 'older0000', bt: 1 })));
await guest.reload();
for (const p of [host, guest]) { if (p === host) await p.goto(BASE + '#mtg'); await p.waitForSelector('text=Pick a deck, take a seat', { timeout: 60000 }); }
await host.click('button:has-text("Play with friends")');
await host.fill('#nick', 'Hana');
await host.click('button:has-text("Create a room")');
await host.waitForSelector('#invite-link');
const code = (await host.inputValue('#invite-link')).split('#')[1];
await guest.click('button:has-text("Play with friends")');
await guest.fill('#nick', 'Gus');
await guest.fill('#room-code', code);
await guest.click('button:has-text("Join")');
await guest.waitForSelector('button:has-text("Sit here")', { timeout: 20000 });
await guest.click('button:has-text("Sit here")');

// the room: who needs to reload, and no starting until they have
const hostNote = await host.waitForSelector('.room .note.warnline:has-text("older version")', { timeout: 15000 }).then(e => e.textContent()).catch(() => null);
ok(hostNote && hostNote.includes('Gus'), `the host's room says Gus has an older version (${hostNote})`);
await host.waitForTimeout(800);
ok(await host.$eval('button:has-text("Start game")', b => b.disabled).catch(() => false), 'the host can\'t start while the versions differ');
const guestNote = await guest.waitForSelector('.room .note.warnline:has-text("newer version")', { timeout: 15000 }).then(e => e.textContent()).catch(() => null);
ok(guestNote && guestNote.includes('Hana'), `the guest's room says there's a newer version (${guestNote})`);
await host.screenshot({ path: `${OUT}/1-host-room.png` });
await guest.screenshot({ path: `${OUT}/2-guest-room.png` });

// the guest reloads with its button and comes back with the new version
await guest.evaluate(() => sessionStorage.removeItem('fake-version'));
await Promise.all([guest.waitForNavigation({ timeout: 30000 }), guest.click('.room .note.warnline button:has-text("Reload to update")')]);
await guest.waitForSelector('.room', { timeout: 60000 });
const startable = await host.waitForSelector('button:has-text("Start game"):not([disabled])', { timeout: 30000 }).then(() => true).catch(() => false);
ok(startable, 'once the guest has reloaded, the host can start');
ok(!(await host.$('.room .note.warnline:has-text("version")')), 'and the note is gone');
if (startable) await host.click('button:has-text("Start game")');
for (const p of [host, guest]) await p.waitForFunction(() => window.__paSession && window.__paSession.game && window.__paSession.online, null, { timeout: 60000 }).catch(() => {});

// during a game: an update comes out and the host reloads, getting it (the address is the room's link: the room and
// the game pick up again on its screen)
ok(new URL(host.url()).hash === '#' + code, `while in the room, the host's address is the room's link (${host.url()})`);
await host.evaluate(() => sessionStorage.setItem('fake-version', JSON.stringify({ gv: 'newer0000', bt: Date.now() * 2 })));
await host.reload();
await host.waitForFunction(() => window.__paSession && window.__paSession.online, null, { timeout: 60000 }).catch(() => {});
const guestChip = await guest.waitForSelector('.roomstatus .chip.danger:has-text("newer version")', { timeout: 30000 }).then(e => e.textContent()).catch(() => null);
ok(guestChip && guestChip.includes('Hana'), `in the game, the guest's top bar says Hana has a newer version (${guestChip})`);
ok(!!(await guest.$('.roomstatus button:has-text("Reload to update")')), 'with a button to reload');
const hostChip = await host.waitForSelector('.roomstatus .chip.danger:has-text("needs to reload")', { timeout: 30000 }).then(e => e.textContent()).catch(() => null);
ok(hostChip && hostChip.includes('Gus'), `and the host's says Gus needs to reload (${hostChip})`);
await host.screenshot({ path: `${OUT}/3-host-game.png` });
await guest.screenshot({ path: `${OUT}/4-guest-game.png` });

console.log(errors.length ? `errors:\n${errors.slice(0, 8).join('\n')}` : 'no page errors');
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail || errors.length ? 1 : 0);
