// "Who are we waiting on" with a friend, in two real browsers (Commander, 1 vs 1, a stand-in room relayed by this
// script as in mptest.mjs). Throughout the game, on both screens:
//  - while the game waits on the other player, the bar names that player (never you);
//  - while it waits on you, you have the question in front of you (no waiting bar);
//  - the two never sit waiting on each other.
// An AI plays both seats for the first turns; after that this script answers each question like a person would.
// Usage: node tools/waitingmp.mjs [out dir] [turns=8]   (serve dist/ on :8765 first)
import fs from 'node:fs';
import { chromium } from 'playwright';

const OUT = process.argv[2] || '/tmp/waitingmp';
const TURNS = +(process.argv[3] || 8);
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
  await ctx.addInitScript(t => { window.__paAutoplay = t; window.__paExpose = true; window.__paSyncTrace = true; try { localStorage.setItem('pa-settings', JSON.stringify({ aiSpeed: 'fast' })); localStorage.setItem('pa-tips', JSON.stringify({ mtg: { off: true, seen: [] } })); } catch { /* blocked */ } }, TURNS);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
  pages.push(page);
  return page;
}
const host = await player('host'), guest = await player('guest');
for (const p of [host, guest]) { await p.goto(BASE + '#mtg'); await p.waitForSelector('text=Pick a deck, take a seat', { timeout: 60000 }); }
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
await host.waitForSelector('button:has-text("Start game"):not([disabled])', { timeout: 20000 });
await host.click('button:has-text("Start game")');
for (const p of [host, guest]) await p.waitForFunction(() => window.__paSession && window.__paSession.game && window.__paSession.online, null, { timeout: 60000 });

// one screen's state: its seat, who its engine is asking, what its bar says, whether it shows a question
const read = p => p.evaluate(() => {
  const S = window.__paSession, g = S.game, a = g.pendingAsk;
  const bar = document.querySelector('.prompt.waiting .txt.thinking');
  return {
    seat: S.human.pid, turn: g.turnNumber, over: !!g.over,
    decider: a ? (a.req.decider != null ? a.req.decider : a.pid) : null, type: a ? a.req.type : null,
    asking: !!S.human.pending, barText: bar ? bar.textContent : null, barTag: bar ? bar.getAttribute('data-waiting') : null,
    names: g.players.map(x => x.name), seq: S.online.net.seq, waitOn: S.online.net.waiting ? S.online.net.waiting.pid : null,
    size: Math.max(0, ...(S.online.net.channel.peers() || []).filter(p => p.isMe).map(p => JSON.stringify(p.presence).length)),
  };
}).catch(() => null);
// answer what's in front of you like a person: the dialog's main button (picking cards first where it needs some,
// such as a discard down to hand size), else the prompt's
const answer = async p => {
  const d = await p.$('.overlay .dialog .btn.primary:not([disabled])');
  if (d) return d.click().catch(() => {});
  const pick = await p.$('.overlay .dialog .dlg-cards .pick:not(:has(.tick)) .targetable');
  if (pick) return pick.click().catch(() => {});
  const b = await p.$('.prompt .acts .btn.primary:not([disabled])');
  if (b) return b.click().catch(() => {});
};

const bad = [], since = new Map();
let mutual = 0, samples = 0, waitedOnOther = 0, longest = 0, biggest = [0, 0];
const t0 = Date.now();
let last = [0, 0];
while (Date.now() - t0 < 200000) {
  const states = await Promise.all([host, guest].map(read));
  if (states.some(s => !s) || states.some(s => s.over)) break;
  samples++;
  for (const [i, s] of states.entries()) {
    const who = i ? 'guest' : 'host';
    if (s.decider == null) { since.delete(who); continue; }
    if (s.decider !== s.seat) {
      waitedOnOther++;
      // the bar names the player being waited on (a render may lag a moment: only a state that lasts counts)
      const wrong = s.barText != null && (String(s.barTag) !== String(s.decider) || !s.barText.includes(s.names[s.decider]) || /\bYou are\b/.test(s.barText));
      const k = `${who}:bar:${s.seq}`;
      if (wrong) { if (!since.has(k)) since.set(k, Date.now()); else if (Date.now() - since.get(k) > 600 && bad.length < 4) { bad.push(`${who} waits on ${s.names[s.decider]} but its bar says "${s.barText}"`); await (i ? guest : host).screenshot({ path: `${OUT}/wrong-${bad.length}.png` }); since.set(k, Infinity); } }
    } else if (!s.asking) {
      // asked yourself: the question shows within a moment (the autoplay bot answers instantly in the first turns)
      const k = `${who}:own:${s.seq}`;
      if (!since.has(k)) since.set(k, Date.now());
      else if (s.turn >= TURNS && Date.now() - since.get(k) > 2500 && bad.length < 4) { bad.push(`${who} is asked (${s.type}) but shows no question; its bar says "${s.barText}"`); await (i ? guest : host).screenshot({ path: `${OUT}/noprompt-${bad.length}.png` }); since.set(k, Infinity); }
    }
  }
  // each waiting on the other, on both screens, for a while: stuck
  const [h, g] = states;
  biggest = [Math.max(biggest[0], h.size), Math.max(biggest[1], g.size)];
  // (for a moment that's normal: one's answer is on its way to the other. Stuck is when nothing moves for seconds)
  const both = h.waitOn != null && g.waitOn != null && h.waitOn === g.seat && g.waitOn === h.seat;
  const at = `${h.seq}/${g.seq}`;
  if (both && mutual && mutual.at === at) {
    if (Date.now() - mutual.since > 4000 && !mutual.told) { mutual.told = true; bad.push(`stuck: host waits on ${h.names[h.waitOn]} and guest waits on ${g.names[g.waitOn]} for ${((Date.now() - mutual.since) / 1000).toFixed(1)}s (question ${h.seq} / ${g.seq})`); await host.screenshot({ path: `${OUT}/stuck-host.png` }); await guest.screenshot({ path: `${OUT}/stuck-guest.png` }); }
  } else mutual = both ? { at, since: Date.now() } : 0;
  if (both && mutual) longest = Math.max(longest, Date.now() - mutual.since);
  if (h.turn >= TURNS + 6 && g.turn >= TURNS + 6) break;
  if (h.turn >= TURNS) { await answer(host); await answer(guest); }
  last = [h.turn, g.turn];
  await host.waitForTimeout(150);
}
console.log(`turns reached: ${last.join(', ')}; ${samples} samples, ${waitedOnOther} while waiting on the other player; longest both-waiting ${(longest / 1000).toFixed(1)}s; biggest presence host ${biggest[0]}, guest ${biggest[1]} characters`);
ok(last[0] >= TURNS + 2 && last[1] >= TURNS + 2, `the game went on past the AI's turns (${last.join(', ')})`);
if (last[0] < TURNS + 2 || last[1] < TURNS + 2) { await host.screenshot({ path: `${OUT}/end-host.png` }); await guest.screenshot({ path: `${OUT}/end-guest.png` }); console.log('  stalled on:', JSON.stringify(await Promise.all([host, guest].map(read)))); }
ok(waitedOnOther > 10, 'the screens waited on each other often enough to check');
ok(!bad.length, `both screens always agree on whom they wait for${bad.length ? '\n  ' + bad.join('\n  ') : ''}`);
// no copy of the game drifted from the other along the way (it would have rebuilt itself: ui/online.jsx watchDesync)
const drift = (await Promise.all([host, guest].map(p => p.evaluate(() => window.__paDrift || []).catch(() => [])))).flat();
ok(!drift.length, `no copy drifted${drift.length ? ': ' + JSON.stringify(drift) : ''}`);
if (drift.length && process.env.TRACE) for (const [nm, p] of [['host', host], ['guest', guest]]) console.log(nm, await p.evaluate(s => { const t = window.__paSession.online.net.traced; return t ? [s - 2, s - 1, s].map(k => `${k}: ${t.get(k)}`).join('\n  ') : 'no trace'; }, drift[0].seq).catch(e => e.message));
console.log(errors.length ? `errors:\n${errors.slice(0, 8).join('\n')}` : 'no page errors');
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail || errors.length ? 1 : 0);
