// The combat decisions from src/engine/mech-combat.js in a real browser: a 1 vs 1 game where the AI plays your seat
// except for attacks, blocks and the choices below. Your side gets Avatar of Hope ("can block any number of
// creatures"), Benalish Hero (banding) and a Bear; the opponent three creatures that must attack you and a Craw Wurm.
// On their turn you click the Avatar, then each attacker: the prompt says it can block any number, all three light
// up, and the engine records the Avatar blocking all three; then you divide its 4 damage in the number dialog (2 to
// two of them). On your turn you attack with the Hero and the Bear, put them in a band in the cards dialog, and when
// the Wurm blocks the band you (the banding player) put all 6 of its damage on the Hero, so the Bear lives.
// Usage: node tools/mech-combatui.mjs [out dir] [site, default http://localhost:8765/]   (serve dist/ there first)
import fs from 'node:fs';
import { chromium } from 'playwright';

const OUT = process.argv[2] || '/tmp/mech-combatui';
const BASE = process.argv[3] || 'http://localhost:8765/';
fs.mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
await page.addInitScript(() => {
  window.__paAutoplay = -1; window.__paHumanTypes = ['blockers', 'attackers', 'mulligan', 'cards', 'number']; window.__paExpose = true;
  try { localStorage.setItem('pa-settings', JSON.stringify({ aiSpeed: 'instant' })); localStorage.setItem('pa-tips', JSON.stringify({ mtg: { off: true, seen: [] } })); } catch { /* blocked */ }
});
await page.goto(BASE + '#mtg');
await page.waitForSelector('text=Pick a deck, take a seat', { timeout: 60000 });
await page.click('.seg button:has-text("1 vs 1")');
await page.click('button:has-text("Shuffle up")');
await page.waitForFunction(() => window.__paSession && window.__paSession.human.pending && window.__paSession.human.pending.req.type === 'mulligan', null, { timeout: 120000 });

// the line-up (the rest of the card pool is loaded for the cards beyond the precons'), put in while the game waits on
// your opening hand
const ids = await page.evaluate(async () => {
  const s = window.__paSession, g = s.game, me = s.human.pid, opp = g.players.find(p => p.id !== me).id;
  const n = (await (await fetch('data/more.json')).json()).shards;
  for (let i = 0; i < n; i++) g.db.add(await (await fetch(`data/more/cards-${i}.json`)).json());
  const put = async (pid, def, token) => { const c = g.newCard(def, pid); c.zone = 'none'; c.token = !!token; await g.moveCard(c, 'battlefield', { controller: pid, silent: true }); c.sick = false; c.tapped = false; return c; };
  const avatar = await put(me, g.db.get('Avatar of Hope')), hero = await put(me, g.db.get('Benalish Hero')), bear = await put(me, g.db.token('g_2_2_bear'), true);
  const atks = [];
  for (const t of ['b_2_2_zombie', 'r_2_2_goblin', 'u_2_2_bird_flying']) { const c = await put(opp, g.db.token(t) || g.db.token('r_1_1_goblin'), true); c.mustAttack = me; atks.push(c.id); }
  const wurm = await put(opp, g.db.get('Craw Wurm'));
  g.touch(); s.store.bump();
  return { me, avatar: avatar.id, hero: hero.id, bear: bear.id, atks, wurm: wurm.id };
});
await page.click('.dialog >> text=Keep');

const state = () => page.evaluate(() => { const s = window.__paSession, g = s.game, p = s.human.pending; return { turn: g.turnNumber, over: !!g.over, type: p ? p.req.type : null, purpose: p ? p.req.purpose : null, active: g.activePlayer, step: g.step }; });
const cls = id => page.$eval(`[data-ref="c${id}"]`, e => e.className + ' ' + (e.querySelector('.card') || e).className).catch(() => '');
let blockDone = false, bandDone = false, divides = { block: 0, band: 0 }, shots = 0;
const deadline = Date.now() + 300000;
while (Date.now() < deadline && !(blockDone && bandDone)) {
  const st = await state();
  if (st.over || st.turn > 14) break;
  if (!st.type) { await page.waitForTimeout(100); continue; }
  if (st.type === 'blockers') {
    const req = await page.evaluate(() => window.__paSession.human.pending.req);
    const mine = req.attackers.filter(a => ids.atks.includes(a));
    if (!blockDone && req.candidates.includes(ids.avatar) && mine.length >= 2) {
      ok(req.caps && req.caps[ids.avatar] >= 99, `the prompt knows the Avatar can block any number (${JSON.stringify(req.caps)})`);
      await page.click(`[data-ref="c${ids.avatar}"]`);
      ok(/any number/.test(await page.textContent('.prompt')), 'the prompt says it can block any number');
      for (const a of mine) ok(/attacker-target/.test(await cls(a)), `attacker ${a} is lit up`);
      for (const a of mine) await page.click(`[data-ref="c${a}"]`);
      ok(/selected/.test(await cls(ids.avatar)), 'the Avatar stays picked while it can block more');
      // one more click on an attacker takes that block off, and another puts it back
      await page.click(`[data-ref="c${mine[0]}"]`);
      const n1 = await page.evaluate(() => document.querySelectorAll('svg.arrows path.block.pending, svg.arrows .block.pending').length);
      await page.click(`[data-ref="c${mine[0]}"]`);
      const n2 = await page.evaluate(() => document.querySelectorAll('svg.arrows path.block.pending, svg.arrows .block.pending').length);
      ok(n2 === n1 + 1 || n2 >= mine.length, `a pending block arrow per attacker (${n1} then ${n2})`);
      await page.click(`[data-ref="c${ids.avatar}"]`);   // done
      await page.screenshot({ path: `${OUT}/multiblock-${shots++}.png` });
      await page.click('.prompt .acts .btn.primary');
      await page.waitForTimeout(200);
      const rec = await page.evaluate(av => { const g = window.__paSession.game; return g.combat ? g.combat.attackers.filter(r => r.blockers.includes(av)).map(r => r.card) : null; }, ids.avatar);
      ok(rec && rec.length === mine.length, `the engine has the Avatar blocking ${mine.length} (${JSON.stringify(rec)})`);
      blockDone = true;
    } else {
      await page.click('.prompt .acts .btn.primary');
    }
    continue;
  }
  if (st.type === 'attackers') {
    const req = await page.evaluate(() => window.__paSession.human.pending.req);
    if (!bandDone && req.candidates.includes(ids.hero) && req.candidates.includes(ids.bear) && blockDone) {
      await page.click(`[data-ref="c${ids.hero}"]`);
      await page.click(`[data-ref="c${ids.bear}"]`);
      await page.click('.prompt .acts .btn.primary');
    } else {
      await page.click('.prompt .acts button:has-text("Clear")').catch(() => {});
      await page.click('.prompt .acts .btn.primary');
    }
    continue;
  }
  if (st.type === 'cards' && st.purpose === 'band') {
    const req = await page.evaluate(() => window.__paSession.human.pending.req);
    ok(/band/i.test(await page.textContent('.dialog')), 'the band dialog is up');
    const i = req.cards.indexOf(ids.bear);
    ok(i >= 0, 'the Bear is offered to the band');
    // (the dialog may still be opening: click until the Bear shows as picked)
    for (let k = 0; k < 5 && !(await page.$(`.dialog .dlg-cards .pick >> nth=${i} >> .tick`)); k++) { await page.click(`.dialog .dlg-cards .pick >> nth=${i} >> .cardwrap`); await page.waitForTimeout(100); }
    ok(!!(await page.$(`.dialog .dlg-cards .pick >> nth=${i} >> .tick`)), 'the Bear is picked in the dialog');
    await page.screenshot({ path: `${OUT}/band-${shots++}.png` });
    await page.click('.dialog .dlg-actions .btn.primary');
    await page.waitForTimeout(150);
    const band = await page.evaluate(([h, b]) => { const g = window.__paSession.game; const r = id => g.combat.attackers.find(x => x.card === id); return r(h) && r(b) && r(h).band != null && r(h).band === r(b).band; }, [ids.hero, ids.bear]);
    ok(band, 'the Hero and the Bear attack in a band');
    continue;
  }
  if (st.type === 'number' && st.purpose === 'divide') {
    const req = await page.evaluate(() => window.__paSession.human.pending.req);
    const target = +req.target.slice(1);
    console.log('divide:', req.prompt);
    ok(await page.$('.dialog .dlg-cards .cardwrap') !== null, 'the dialog shows the creature this damage is for');
    let want;
    if (ids.atks.includes(target)) { want = Math.min(req.max, 2); divides.block++; }
    else { want = target === ids.hero ? req.max : 0; divides.band++; }
    await page.$eval('#numrange', (el, v) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, String(v)); el.dispatchEvent(new Event('input', { bubbles: true })); }, want);
    if (shots < 8) await page.screenshot({ path: `${OUT}/divide-${shots++}.png` });
    await page.click('.dialog .dlg-actions .btn.primary');
    await page.waitForTimeout(150);
    if (divides.band && !bandDone) {
      // (until the damage is dealt: the step moves on, or the Hero is gone)
      await page.waitForFunction(h => { const g = window.__paSession.game, c = g.cardById(h); return g.step !== 'combatDamage' || !c || c.zone !== 'battlefield'; }, ids.hero, { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(200);
      const res = await page.evaluate(([h, b]) => { const g = window.__paSession.game, z = id => (g.cardById(id) ? g.cardById(id).zone : 'gone'); return { hero: z(h), bear: z(b) }; }, [ids.hero, ids.bear]);
      ok(res.hero !== 'battlefield' && res.bear === 'battlefield', `the Hero took the Wurm's damage, the Bear lives (${JSON.stringify(res)})`);
      if (res.hero === 'battlefield') console.log(await page.evaluate(() => window.__paSession.game.logs.slice(-25).map(l => l.text).join('\n')));
      bandDone = true;
    }
    continue;
  }
  // anything else this seat is asked: the first legal answer
  await page.evaluate(() => { const s = window.__paSession, r = s.human.pending.req; s.human.respond(r.type === 'cards' ? r.cards.slice(0, r.min || 0) : r.type === 'number' ? r.min : r.type === 'mulligan' ? true : null); });
}
ok(blockDone, 'the multiple block came up and was made');
ok(divides.block >= 1, `the Avatar's damage was divided in the dialog (${divides.block} prompts)`);
const after = await page.evaluate(a => a.map(id => { const c = window.__paSession.game.cardById(id); return c ? c.zone : 'gone'; }), ids.atks);
ok(after.filter(z => z !== 'battlefield').length >= 2, `two of the attackers died to the Avatar's divided damage (${after})`);
ok(bandDone, 'the band attacked and its damage was divided');
console.log(errors.length ? `errors:\n${errors.join('\n')}` : 'no page errors');
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail || errors.length ? 1 : 0);
