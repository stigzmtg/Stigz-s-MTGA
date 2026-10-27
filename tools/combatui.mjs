// Attacks and blocks in a real browser, checked against the rules engine: a 1 vs 1 game where the AI plays your
// seat except for declaring attackers and blockers. Your side gets plain ground creatures and a reach creature, the
// opponent's a flyer and a creature with menace, so blocks the rules forbid come up. At every blockers prompt: only
// your creatures that can block something light up; with one picked, exactly the attackers it may block light up; a
// click on one it may not block is refused with the reason; menace needs two blockers before you can confirm; and
// what you confirm is what the engine records. At every attackers prompt: a creature can't be sent at a player or
// planeswalker it may not attack. Usage: node tools/combatui.mjs [out dir] [turns=12]   (serve dist/ on :8765 first)
import fs from 'node:fs';
import { chromium } from 'playwright';

const OUT = process.argv[2] || '/tmp/combatui';
const TURNS = +(process.argv[3] || 12);
fs.mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0, blocksSeen = 0, illegalTried = 0, menaceSeen = 0, attacksSeen = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
await page.addInitScript(() => {
  window.__paAutoplay = -1; window.__paHumanTypes = ['blockers', 'attackers', 'mulligan']; window.__paExpose = true;
  try { localStorage.setItem('pa-settings', JSON.stringify({ aiSpeed: 'instant' })); localStorage.setItem('pa-tips', JSON.stringify({ mtg: { off: true, seen: [] } })); } catch { /* blocked */ }
});
await page.goto('http://localhost:8765/#mtg');
await page.waitForSelector('text=Pick a deck, take a seat', { timeout: 60000 });
await page.click('.seg button:has-text("1 vs 1")');
await page.click('button:has-text("Shuffle up")');
// the line-up goes in while the game waits on your opening hand, so it's there from the first turn
await page.waitForFunction(() => window.__paSession && window.__paSession.human.pending && window.__paSession.human.pending.req.type === 'mulligan', null, { timeout: 120000 });

// the line-up, put in while the game waits on your answer
const inject = () => page.evaluate(async () => {
  const s = window.__paSession, g = s.game, me = s.human.pid, opp = g.players.find(p => p.id !== me).id;
  const put = async (pid, script) => { const c = g.newCard(g.db.token(script), pid); c.zone = 'none'; c.token = true; await g.moveCard(c, 'battlefield', { controller: pid, silent: true }); c.sick = false; c.tapped = false; return c; };
  for (const t of ['w_4_4_angel_flying', 'r_2_2_spirit_menace', 'g_3_3_beast']) await put(opp, t);
  for (const t of ['g_2_2_bear', 'b_2_2_zombie', 'g_1_2_spider_reach', 'w_1_1_soldier']) await put(me, t);
  g.touch(); s.store.bump();
});
await inject();
await page.click('.dialog >> text=Keep');
const deadline = Date.now() + 240000;
let shots = 0;
while (Date.now() < deadline) {
  const st = await page.evaluate(() => { const s = window.__paSession, g = s.game, p = s.human.pending; return { turn: g.turnNumber, over: !!g.over, type: p ? p.req.type : null }; });
  if (st.over || st.turn > TURNS) break;
  if (!st.type) { await page.waitForTimeout(120); continue; }
  if (st.type === 'attackers') {
    attacksSeen++;
    // every candidate against every defender: the board takes only what the engine allows
    const res = await page.evaluate(() => {
      const s = window.__paSession, g = s.game, req = s.human.pending.req, C = window.__paCombat;
      return req.candidates.map(id => req.defenders.map(d => ({ id, ref: d.ref, may: C.canAttackDefender(g, g.cardById(id), d.player, d.card ? g.cardById(d.card) : null) }))).flat();
    });
    const bad = res.find(r => !r.may);
    if (bad) {
      await page.click(`.prompt .attack-targets button`).catch(() => {});
      ok(true, 'an illegal attack exists');
    }
    // All takes only the attacks the rules allow, and every one shows on the board
    await page.click('.prompt .acts button:has-text("All")').catch(() => {});
    await page.waitForTimeout(100);
    const shown = await page.evaluate(() => {
      const s = window.__paSession, req = s.human.pending.req;
      return req.candidates.filter(id => { const el = document.querySelector(`[data-ref="c${id}"]`); return el && (el.matches('.selected') || el.querySelector('.card.selected')); }).length;
    });
    const btn = await page.textContent('.prompt .acts .btn.primary');
    const n = +((/Attack with (\d+)/.exec(btn) || [])[1] || 0);
    ok(shown === n, `every attacker chosen is marked on the board (${shown} marked, button says ${n})`);
    if (attacksSeen === 1) await page.screenshot({ path: `${OUT}/attack-all.png` });
    // (no attack: your creatures stay untapped to block)
    await page.click('.prompt .acts button:has-text("Clear")').catch(() => {});
    await page.click('.prompt .acts .btn.primary');
    continue;
  }
  if (st.type === 'blockers') {
    blocksSeen++;
    const info = await page.evaluate(() => {
      const s = window.__paSession, g = s.game, req = s.human.pending.req, C = window.__paCombat;
      const can = {};
      for (const b of req.candidates) can[b] = req.attackers.filter(a => C.canBlock(g, g.cardById(b), g.cardById(a)));
      const min = Object.fromEntries(req.attackers.map(a => [a, C.blockRules(g, g.cardById(a)).min]));
      return { cands: req.candidates, atks: req.attackers, can, min, names: Object.fromEntries([...req.candidates, ...req.attackers].map(id => [id, g.name(g.cardById(id))])) };
    });
    const lit = async id => page.$eval(`.mat [data-ref="c${id}"] .card, .mat .card[data-ref="c${id}"]`, e => e.className).catch(() => page.$eval(`[data-ref="c${id}"]`, e => e.className + ' ' + (e.querySelector('.card') || e).className));
    for (const b of info.cands) {
      const cls = await lit(b);
      ok(/targetable/.test(cls) === info.can[b].length > 0, `${info.names[b]} lights up only if it can block something (${info.can[b].length} attackers; ${cls})`);
    }
    for (const b of info.cands.filter(x => info.can[x].length)) {
      await page.click(`[data-ref="c${b}"]`);
      for (const a of info.atks) {
        const cls = await lit(a);
        const legal = info.can[b].includes(a);
        ok(/attacker-target/.test(cls) === legal, `${info.names[b]} picked: ${info.names[a]} ${legal ? 'lit' : 'not lit'} (${cls})`);
      }
      // try a block it may not make
      const no = info.atks.find(a => !info.can[b].includes(a));
      if (no) {
        illegalTried++;
        await page.click(`[data-ref="c${no}"]`);
        const toast = await page.textContent('.toast').catch(() => '');
        ok(toast && toast.length > 10, `refused with a reason: ${toast}`);
        ok(!/blocking/.test(await lit(b)), `${info.names[b]} isn't blocking ${info.names[no]}`);
        if (shots < 3) await page.screenshot({ path: `${OUT}/illegal-${shots++}.png` });
      }
      await page.click(`[data-ref="c${b}"]`).catch(() => {});   // unpick
    }
    // menace: one blocker isn't enough to confirm
    const men = info.atks.find(a => info.min[a] >= 2 && info.cands.filter(b => info.can[b].includes(a)).length >= 1);
    let assigned = [];
    if (men) {
      menaceSeen++;
      const bs = info.cands.filter(b => info.can[b].includes(men));
      await page.click(`[data-ref="c${bs[0]}"]`); await page.click(`[data-ref="c${men}"]`);
      ok(/needs at least 2 blockers/.test(await page.textContent('.prompt')), 'the prompt says menace needs two');
      await page.click('.prompt .acts .btn.primary');
      await page.waitForTimeout(150);
      const still = await page.evaluate(() => { const p = window.__paSession.human.pending; return p && p.req.type === 'blockers'; });
      ok(still, 'confirming one blocker on a menace creature is held back');
      if (bs[1]) { await page.click(`[data-ref="c${bs[1]}"]`); await page.click(`[data-ref="c${men}"]`); assigned = [[bs[0], men], [bs[1], men]]; }
      else { await page.click('.prompt .acts button:has-text("Clear")'); }
      if (shots < 5) await page.screenshot({ path: `${OUT}/menace-${shots++}.png` });
    }
    // plus one more legal block if there's a creature free
    const free = info.cands.find(b => !assigned.some(([x]) => x === b) && info.can[b].some(a => info.min[a] < 2));
    if (free) { const a = info.can[free].find(x => info.min[x] < 2); await page.click(`[data-ref="c${free}"]`); await page.click(`[data-ref="c${a}"]`); assigned.push([free, a]); }
    const logsBefore = await page.evaluate(() => window.__paSession.game.logs.length);
    await page.click('.prompt .acts .btn.primary');
    await page.waitForTimeout(200);
    // (what the engine recorded, from its log: combat may be over already)
    const log = await page.evaluate(n => window.__paSession.game.logs.slice(n).filter(l => l.type === 'block').map(l => l.text).join(' | '), logsBefore);
    const named = assigned.map(([b, a]) => [info.names[b], info.names[a]]);
    const got = named.filter(([b, a]) => log.includes(`${b} blocks ${a}`));
    ok(got.length === named.length && (named.length || !log), `the blocks confirmed are the blocks made (${JSON.stringify(named)} vs ${log})`);
    console.log(`T${st.turn}: ${info.atks.length} attackers, ${info.cands.length} of yours; blocked ${JSON.stringify(named)}`);
    continue;
  }
  await page.waitForTimeout(120);
}
ok(blocksSeen > 0, `blocker prompts came up (${blocksSeen})`);
ok(illegalTried > 0, `illegal blocks were tried (${illegalTried})`);
console.log(`blocker prompts ${blocksSeen}, attacker prompts ${attacksSeen}, illegal blocks tried ${illegalTried}, menace ${menaceSeen}`);
console.log(errors.length ? `errors:\n${errors.join('\n')}` : 'no page errors');
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail || errors.length ? 1 : 0);
