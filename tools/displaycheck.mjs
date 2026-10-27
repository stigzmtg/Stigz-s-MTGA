// Is everything the game knows on the screen? A 4-player game where AIs play every seat, checked again and again
// while it runs: each player's life, hand, library, graveyard and exile counts, poison and commander damage; every
// permanent on the battlefield (alone, in a stack of identical tokens or lands, or under the card it's attached to),
// with its counters and damage, tapped or not, and marked when phased out; the stack's size; whose turn it is.
// A difference only counts when it stays while the game is idle (the screen can be a frame behind).
// Usage: node tools/displaycheck.mjs [out dir] [turns=14] [players=4]   (serve dist/ on :8765 first; SPEED=fast for a quicker game)
import fs from 'node:fs';
import { chromium } from 'playwright';

const OUT = process.argv[2] || '/tmp/displaycheck';
const TURNS = +(process.argv[3] || 14), PLAYERS = +(process.argv[4] || 4);
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
await page.addInitScript(speed => {
  window.__speed = speed;
  window.__paAutoplay = 999; window.__paExpose = true;
  try { localStorage.setItem('pa-settings', JSON.stringify({ aiSpeed: window.__speed || 'fast' })); localStorage.setItem('pa-tips', JSON.stringify({ mtg: { off: true, seen: [] } })); } catch { /* blocked */ }
}, process.env.SPEED || 'normal');
await page.goto('http://localhost:8765/#mtg');
await page.waitForSelector('text=Pick a deck, take a seat', { timeout: 60000 });
await page.click(`.seg button:has-text("${PLAYERS === 2 ? '1 vs 1' : `${PLAYERS}-player`}")`);
await page.click('button:has-text("Shuffle up")');
await page.waitForFunction(() => window.__paSession && window.__paSession.game && window.__paSession.game.turnNumber >= 1, null, { timeout: 120000 });

// one look: what the engine says against what the page shows
const look = () => page.evaluate(async () => {
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const s = window.__paSession, g = s.game, me = s.human.pid;
  const out = [];
  const num = el => (el ? +(el.textContent.match(/-?\d+/) || [NaN])[0] : NaN);
  for (const p of g.players) {
    const mat = document.querySelector(`section.mat[aria-label="${CSS.escape ? p.name.replace(/"/g, '\\"') : p.name}'s battlefield"]`);
    if (!mat) { out.push(`${p.name}: no mat`); continue; }
    const life = num(mat.querySelector('.lifetotal b'));
    if (life !== p.life) out.push(`${p.name}: life ${p.life}, shown ${life}`);
    for (const z of ['library', 'graveyard', 'exile']) {
      const el = document.querySelector(`[data-pile="${p.id}:${z}"] b`);
      if (el && num(el) !== p[z].length) out.push(`${p.name}: ${z} ${p[z].length}, shown ${num(el)}`);
      if (!el && z !== 'library') out.push(`${p.name}: no ${z} pile`);
    }
    if (p.id === me) { const n = document.querySelectorAll('.hand .handslot').length; if (n !== p.hand.length) out.push(`you: hand ${p.hand.length}, shown ${n}`); }
    else { const el = document.querySelector(`[data-pile="${p.id}:hand"] b`); if (num(el) !== p.hand.length) out.push(`${p.name}: hand ${p.hand.length}, shown ${num(el)}`); }
    const poison = p.counters.POISON || 0;
    if (poison && !mat.querySelector('.chip.poison')) out.push(`${p.name}: ${poison} poison not shown`);
    for (const [id, d] of Object.entries(p.commanderDamage)) if (d > 0 && ![...mat.querySelectorAll('.status .chip')].some(c => c.textContent.includes(`${d}/21`))) out.push(`${p.name}: ${d} commander damage from ${g.name(g.cardById(+id))} not shown`);
    if (!p.lost && (g.activePlayer === p.id) !== !!mat.querySelector('.turnmark')) out.push(`${p.name}: turn mark wrong`);
  }
  // every permanent
  const flyIds = new Set();
  for (const el of document.querySelectorAll('[data-fly]')) for (const id of el.dataset.fly.split(' ')) flyIds.add(+id);
  for (const c of g.battlefield) {
    if (!flyIds.has(c.id)) { out.push(`${g.name(c)} (#${c.id}, ${g.players[c.controller].name}) is on the battlefield but not on screen`); continue; }
    const el = document.querySelector(`[data-ref="c${c.id}"]`);
    if (!el) continue;   // shown in a stack of identical ones
    const face = el.matches('.under') ? el.querySelector('.card') : el.querySelector(':scope > .card');
    if (!face) continue;
    for (const [k, n] of Object.entries(c.counters || {})) {
      if (n <= 0 || k === 'LOYALTY' || k === 'DEFENSE') continue;
      if (!face.querySelector('.badges .badge.plus, .badges .badge.minus, .badges .badge.ctr')) out.push(`${g.name(c)}: ${n} ${k} counter(s) not shown`);
    }
    if (c.damage && !face.querySelector('.badge.dmg')) out.push(`${g.name(c)}: ${c.damage} damage not shown`);
    if (!el.matches('.under') && !!c.tapped !== el.classList.contains('tapped')) out.push(`${g.name(c)}: ${c.tapped ? 'tapped' : 'untapped'}, shown ${c.tapped ? 'untapped' : 'tapped'}`);
    if (c.phasedOut && !el.classList.contains('phased')) out.push(`${g.name(c)}: phased out, not shown as such`);
  }
  const st = document.querySelector('.stackview .label');
  const shown = st ? num(st) : 0;
  if (shown !== g.stack.length) out.push(`stack ${g.stack.length}, shown ${shown}`);
  return { out, v: g.logs.length + ':' + g.stack.length, turn: g.turnNumber, over: !!g.over };
});

let checks = 0, problems = new Map(), lastTurn = 0, shots = 0;
const deadline = Date.now() + 8 * 60 * 1000;
while (Date.now() < deadline) {
  const a = await look();
  checks++;
  if (a.over || a.turn > TURNS) { lastTurn = a.turn; break; }
  if (a.turn !== lastTurn) { lastTurn = a.turn; if (shots < 6 && a.turn % 3 === 0) await page.screenshot({ path: `${OUT}/turn-${a.turn}.png` }); }
  if (a.out.length) {
    await page.waitForTimeout(450);
    const b = await look();
    // (only while nothing happened in between: then the screen has had time to catch up)
    if (a.v === b.v) for (const p of a.out.filter(x => b.out.includes(x))) { if (!problems.has(p)) { problems.set(p, a.turn); if (problems.size <= 4) await page.screenshot({ path: `${OUT}/problem-${problems.size}.png` }); } }
  }
  await page.waitForTimeout(60);
}
console.log(`${checks} looks over ${lastTurn} turns`);
for (const [p, t] of problems) console.log(`T${t}: ${p}`);
console.log(errors.length ? `errors:\n${errors.join('\n')}` : 'no page errors');
console.log(problems.size ? `\n${problems.size} things not shown right` : '\nall shown');
await browser.close();
process.exit(problems.size || errors.length ? 1 : 0);
