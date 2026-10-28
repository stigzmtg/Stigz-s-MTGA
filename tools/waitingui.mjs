// "Who are we waiting on" in a real browser, for all three games: while the game waits on another player's decision
// (blocks, a Trigger, a "pay or ..." question, the opponent's turn), the prompt bar names exactly that player: never
// you, never the player whose turn it is when someone else was asked. The bar is sampled through whole games against
// the computer (an AI also plays your seat, so both sides' questions come up).
// Usage: node tools/waitingui.mjs [out dir] [site]   (serve dist/ on :8765 first)
import fs from 'node:fs';
import { chromium } from 'playwright';

const OUT = process.argv[2] || '/tmp/waitingui';
const BASE = process.argv[3] || 'http://localhost:8765/';
fs.mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await chromium.launch(/^https:/.test(BASE) && proxy ? { proxy: { server: proxy } } : {});
const errors = [];

// one game: start it, then read (asked player, bar) many times while it plays
async function sample({ name, hash, ready, start, sess, autoplay, turns, mePid = 0 }) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  await page.addInitScript(([k, t]) => {
    window.__paExpose = true; window[k] = t;
    try {
      localStorage.setItem('pa-settings', JSON.stringify({ aiSpeed: 'fast' }));
      localStorage.setItem('pa-tips', JSON.stringify({ mtg: { off: true, seen: [] }, pk: { off: true, seen: [] }, op: { off: true, seen: [] } }));
    } catch { /* blocked */ }
  }, [autoplay, turns]);
  await page.goto(BASE + hash);
  await page.waitForSelector(ready, { timeout: 60000 });
  await start(page);
  await page.waitForFunction(k => window[k] && window[k].game, sess, { timeout: 60000 });
  const seen = { samples: 0, others: 0, bad: [] };
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    const s = await page.evaluate(([k, me]) => {
      const S = window[k]; if (!S || !S.game) return null;
      const g = S.game, ask = g.pendingAsk;
      const el = document.querySelector('.prompt.waiting .txt.thinking, .prompt.waiting .thinking');
      if (!ask || !el) return { idle: true, over: !!g.over };
      const decider = ask.req && ask.req.decider != null ? ask.req.decider : ask.pid;
      return { decider, me, text: el.textContent, tag: el.getAttribute('data-waiting'), name: g.players[decider].name, over: !!g.over };
    }, [sess, mePid]).catch(() => null);
    if (s && s.over) break;
    if (s && !s.idle) {
      seen.samples++;
      if (s.decider !== s.me) {
        seen.others++;
        // the bar may lag one render behind the engine: read again before calling it wrong
        const wrong = String(s.tag) !== String(s.decider) || /\bYou are\b/.test(s.text) || !s.text.includes(s.name);
        if (wrong) {
          await page.waitForTimeout(120);
          const again = await page.evaluate(([k, d]) => { const g = window[k].game; const el = document.querySelector('.prompt.waiting .txt.thinking, .prompt.waiting .thinking'); const a = g.pendingAsk; const dd = a ? (a.req && a.req.decider != null ? a.req.decider : a.pid) : null; return { same: dd === d, tag: el && el.getAttribute('data-waiting'), text: el && el.textContent }; }, [sess, s.decider]).catch(() => null);
          if (again && again.same && (String(again.tag) !== String(s.decider) || /\bYou are\b/.test(again.text || '') || !(again.text || '').includes(s.name))) {
            if (seen.bad.length < 3) { seen.bad.push(`waiting on ${s.name} but the bar says "${again.text}"`); await page.screenshot({ path: `${OUT}/${name.replace(/\W/g, '')}-wrong-${seen.bad.length}.png` }); }
          }
        }
      }
    }
    await page.waitForTimeout(40);
  }
  await page.close();
  return seen;
}

const games = [
  { name: 'Commander', hash: '#mtg', ready: 'text=Pick a deck, take a seat', sess: '__paSession', autoplay: '__paAutoplay', turns: 99,
    start: async p => { await p.click('.seg button:has-text("1 vs 1")'); await p.click('button:has-text("Shuffle up")'); } },
  { name: 'Pokémon', hash: '#pokemon', ready: 'text=Pick a deck, start a battle', sess: '__pkSession', autoplay: '__pkAutoplay', turns: 99,
    start: async p => { await p.click('button.btn.primary.big:has-text("Battle!")'); } },
  { name: 'One Piece', hash: '#onepiece', ready: 'text=Choose your crew, set sail', sess: '__opSession', autoplay: '__opAutoplay', turns: 99,
    start: async p => { await p.click('button:has-text("Battle!")'); } },
];
for (const G of games) {
  const r = await sample(G);
  ok(r.others > 5, `${G.name}: the game waited on the other player often enough to check (${r.others} of ${r.samples} samples)`);
  ok(!r.bad.length, `${G.name}: the bar always names the player being waited on${r.bad.length ? '\n  ' + r.bad.join('\n  ') : ''}`);
}
console.log(errors.length ? `errors:\n${errors.join('\n')}` : 'no page errors');
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail || errors.length ? 1 : 0);
