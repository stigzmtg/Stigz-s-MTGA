// Un-set mechanics in a real browser: a custom deck with sticker and Attraction cards starts a game (the deck step
// loads the sticker sheets and Attractions), the player's tickets, sticker sheets and Attraction deck show on their
// mat, putting a sticker is chosen in dialogs and shows on the card, an opened Attraction shows its lights, and the
// junkyard opens like a graveyard.
// Usage: node tools/unsetsui.mjs [out dir] [port]   (serve dist/ first: node tools/serve-test.mjs 8815)
import fs from 'node:fs';
import { chromium } from 'playwright';

const OUT = process.argv[2] || '/tmp/unsetsui';
const PORT = process.argv[3] || 8815;
fs.mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };
const DECK = {
  id: 'custom-unsetst1', name: 'Un-sets test', commanders: ['The Most Dangerous Gamer'], custom: true, updated: 1,
  cards: [['Swamp', 45], ['Forest', 44], ['Chicken Troupe', 1], ['Lineprancers', 1], ['Carnival Carnivore', 1], ['Scampire', 1], ['Stiltstrider', 1], ['_____-o-saurus', 1], ['Deadbeat Attendant', 1], ['Petting Zookeeper', 1], ['Squirrel Squatters', 1], ['Clandestine Chameleon', 1]],
};
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
await page.addInitScript(deck => {
  window.__paAutoplay = 3; window.__paExpose = true;
  try {
    localStorage.setItem('pa-settings', JSON.stringify({ aiSpeed: 'instant' }));
    localStorage.setItem('pa-tips', JSON.stringify({ mtg: { off: true, seen: [] } }));
    localStorage.setItem('pa-custom-decks', JSON.stringify([deck]));
    localStorage.setItem('pa-lobby', JSON.stringify({ mine: deck.id, numOpp: 1, opps: ['random', 'random', 'random'], level: 'normal' }));
  } catch { /* blocked */ }
}, DECK);
await page.goto(`http://localhost:${PORT}/#mtg`);
await page.waitForSelector('text=Pick a deck, take a seat', { timeout: 60000 });
await page.click('button:has-text("Shuffle up")');
const S = (fn, arg) => page.evaluate(fn, arg);
const myMain = () => page.waitForFunction(() => {
  const s = window.__paSession, g = s && s.game;
  return g && g.turnNumber >= 3 && g.activePlayer === s.human.pid && g.isMainPhase() && !g.stack.length && s.human.pending && s.human.pending.req.type === 'priority';
}, null, { timeout: 240000 }).catch(async e => {
  console.log('state:', await S(() => { const s = window.__paSession, g = s && s.game; return g && { turn: g.turnNumber, active: g.activePlayer, step: g.step, stack: g.stack.length, pending: s.human.pending && s.human.pending.req.type, over: g.over }; }));
  await page.screenshot({ path: `${OUT}/stuck.png` });
  throw e;
});
await myMain();
const me = await S(() => window.__paSession.human.pid);

// ---- the mat: tickets and sticker sheets, the Attraction deck
const setup = await S(() => { const s = window.__paSession, g = s.game, p = g.players[s.human.pid]; return { sheets: (p.stickerSheets || []).map(x => x.name), attractions: (p.AttractionDeck || []).length, lib: p.library.some(c => c.attraction) }; });
ok(setup.sheets.length === 3, `three sticker sheets for the player (${setup.sheets})`);
ok(setup.attractions + (await S(() => window.__paSession.game.battlefield.filter(c => c.attraction).length)) === 10 && !setup.lib, `a ten-card Attraction deck (${setup.attractions})`);
const chip = await page.$('.mat.bottom [data-unsets="stickers"]');
ok(!!chip, 'a tickets / stickers chip on your mat');
ok(!!(await page.$('.mat.bottom [data-unsets="attractions"]')), 'an Attraction deck chip on your mat');
await page.screenshot({ path: `${OUT}/1-mat.png` });
if (chip) {
  await chip.click();
  await page.waitForSelector('.dialog .sheets', { timeout: 5000 }).catch(() => {});
  const sheets = await page.$$eval('.dialog .sheet', xs => xs.map(x => ({ name: x.querySelector('b').textContent, n: x.querySelectorAll('li').length })));
  ok(sheets.length === 3 && sheets.every(x => x.n === 10), `the sheets dialog lists three sheets of ten stickers (${JSON.stringify(sheets)})`);
  await page.screenshot({ path: `${OUT}/2-sheets.png` });
  await page.click('.dialog .dlg-actions .btn.primary');
}

// put cards where we want them (the table updates as after any move)
const setUp = (cards) => S(cs => {
  const s = window.__paSession, g = s.game, me = s.human.pid;
  for (const [name, zone] of cs) {
    const c = g.newCard(g.db.get(name), me);
    if (zone === 'battlefield') { c.zone = 'battlefield'; c.controller = me; g.battlefield.push(c); }
    else { c.zone = zone; g.players[me][zone].push(c); }
  }
  g.players[me].pool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
  g.touch(); s.human.pending && s.human.pending.req && (s.human.pending.req = { ...s.human.pending.req }); s.store.bump();
}, cards);
// (leftover floating mana fills the side panel, which then drops its status line: empty it after each test spell)
const emptyPool = () => S(() => { const s = window.__paSession, g = s.game; g.players[s.human.pid].pool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }; g.touch(); s.store.bump(); });
// answer the prompts that follow until it's your main phase again with an empty stack: pick(req) says what to click
async function playThrough(pick, label) {
  const seen = [];
  for (let k = 0; k < 40; k++) {
    await page.waitForTimeout(250);
    const st = await S(() => { const s = window.__paSession, g = s.game, r = s.human.pending && s.human.pending.req; return { type: r && r.type, purpose: r && r.purpose, prompt: r && r.prompt, stack: g.stack.length, options: r && r.options && r.options.map(o => o.label) }; });
    if (st.type === 'priority' && !st.stack) return seen;
    if (!st.type) continue;
    seen.push(st);
    if (st.type === 'priority') { await page.click('.prompt .acts .btn.primary'); continue; }
    if (await pick(st, seen.length)) continue;
    if (st.type === 'confirm') { await page.click('.dialog .dlg-actions .btn.primary'); continue; }
    if (st.type === 'cards') { await page.click('.dialog .dlg-cards .card'); await page.click('.dialog .dlg-actions .btn.primary'); continue; }
    if (st.type === 'option') { await page.click('.dialog .optlist .btn'); continue; }
    if (st.type === 'targets') { const b = await page.$('.prompt .acts .btn.primary:not([disabled])'); if (b) await b.click(); continue; }
    console.log('unhandled prompt', label, JSON.stringify(st));
    await page.screenshot({ path: `${OUT}/unhandled-${label}.png` });
    return seen;
  }
  return seen;
}
async function castFromHand(name) {
  await page.waitForTimeout(300);
  const slot = await page.$(`.hand .handslot .card[aria-label="${name}"], .hand .handslot .card[title="${name}"]`);
  const any = slot || (await page.$$('.hand .handslot .card.playable')).pop();
  await any.click();
  await page.waitForTimeout(300);
  const item = await page.$('.menu .item.primary, .menu button.primary');
  if (item) await item.click();
}

// ---- a sticker: Chicken Troupe gives a ticket, then you choose a permanent and a sticker
await setUp([['Grizzly Bears', 'battlefield'], ['Chicken Troupe', 'hand']]);
const before = await S(() => { const s = window.__paSession; return s.game.players[s.human.pid].counters.TICKET || 0; });
await castFromHand('Chicken Troupe');
let shot = 0;
const seen = await playThrough(async (st) => {
  if (st.purpose === 'stickerObject') {
    await page.screenshot({ path: `${OUT}/3-choose-permanent.png` });
    const bear = await page.$('.dialog .dlg-cards .card[aria-label="Grizzly Bears"]') || await page.$('.dialog .dlg-cards .card');
    await bear.click(); await page.click('.dialog .dlg-actions .btn.primary');
    return true;
  }
  if (st.purpose === 'sticker') {
    await page.screenshot({ path: `${OUT}/4-choose-sticker.png` });
    shot++;
    const btns = await page.$$('.dialog .optlist .btn');
    const labels = await Promise.all(btns.map(b => b.textContent()));
    const i = labels.findIndex(l => /^Name sticker/.test(l));
    await btns[i >= 0 ? i : 0].click();
    return true;
  }
  if (st.purpose === 'stickerNamePosition') { await page.screenshot({ path: `${OUT}/5-name-position.png` }); await page.click('.dialog .optlist .btn'); return true; }
  return false;
}, 'sticker');
await emptyPool();
ok(seen.some(x => x.purpose === 'stickerObject'), `asked which permanent (${JSON.stringify(seen.map(x => x.purpose))})`);
ok(seen.some(x => x.purpose === 'sticker' && x.options.some(l => /Name sticker/.test(l)) && x.options.some(l => /Art sticker/.test(l))), 'asked which sticker, name and art stickers offered');
const stuck = await S(() => { const s = window.__paSession, g = s.game; const c = g.battlefield.find(x => (x.stickers || []).length && x.owner === s.human.pid); return c && { id: c.id, name: g.name(c), printed: c.def.name, stickers: c.stickers.map(x => x.kind) }; });
ok(stuck && stuck.stickers.includes('Name') && stuck.name !== stuck.printed, `a name sticker went on (${JSON.stringify(stuck)})`);
ok(await S(() => { const s = window.__paSession; return s.game.players[s.human.pid].counters.TICKET || 0; }) === before + 1, 'a ticket gained (name stickers are free)');
if (stuck) {
  const badge = await page.$$eval(`.mat.bottom .card[aria-label="${stuck.name}"] .badge, .mat.bottom .card[title="${stuck.name}"] .badge`, xs => xs.map(x => ({ t: x.textContent, title: x.getAttribute('title') })));
  ok(badge.some(b => /★/.test(b.t) && /Stickers:/.test(b.title || '')), `the card shows its sticker (${JSON.stringify(badge)})`);
  await page.hover(`.mat.bottom .card[aria-label="${stuck.name}"], .mat.bottom .card[title="${stuck.name}"]`).catch(() => {});
  await page.waitForTimeout(300);
  const preview = await page.$eval('.preview', x => x.textContent).catch(() => '');
  ok(/Stickers:/.test(preview) && preview.includes(stuck.name), `the card's text lists its stickers and its new name (${preview.slice(0, 160)})`);
  await page.screenshot({ path: `${OUT}/6-stickered.png` });
}

// ---- an Attraction: Deadbeat Attendant opens one; it shows its lights
await setUp([['Deadbeat Attendant', 'hand']]);
const openedBefore = await S(() => window.__paSession.game.battlefield.filter(c => c.attraction).length);
await castFromHand('Deadbeat Attendant');
await playThrough(async () => false, 'attraction');
const att = await S(() => { const s = window.__paSession, g = s.game; const l = g.battlefield.filter(c => c.attraction && c.controller === s.human.pid); return l.map(c => ({ name: g.name(c), lights: c.lights })); });
ok(att.length === openedBefore + 1, `an Attraction opened (${JSON.stringify(att)})`);
const last = att[att.length - 1];
if (last) {
  const lb = await page.$$eval(`.mat.bottom .card[aria-label="${last.name}"] .badge, .mat.bottom .card[title="${last.name}"] .badge`, xs => xs.map(x => x.textContent));
  ok(lb.some(t => t.includes('◉') && t.includes(last.lights.join('·'))), `its lights show (${JSON.stringify(lb)})`);
  await page.screenshot({ path: `${OUT}/7-attraction.png` });
  // ---- the junkyard
  await S(() => { const s = window.__paSession, g = s.game; const c = g.battlefield.filter(x => x.attraction && x.controller === s.human.pid).pop(); g.destroy(c, null).then(() => s.store.bump()); });
  await emptyPool();
  await page.waitForTimeout(500);
  const jy = await page.$('.mat.bottom [data-unsets="junkyard"]');
  ok(!!jy, 'a junkyard chip after an Attraction leaves');
  if (jy) {
    await page.screenshot({ path: `${OUT}/7b-before-junkyard.png` });
    await jy.click();
    await page.waitForSelector('.dialog h2', { timeout: 5000 }).catch(() => {});
    const h2 = await page.$eval('.dialog h2', x => x.textContent).catch(() => '');
    ok(/Junkyard \(1\)/.test(h2), `the junkyard opens (${h2})`);
    await page.screenshot({ path: `${OUT}/8-junkyard.png` });
    await page.click('.dialog .dlg-actions .btn.primary');
  }
}

// ---- your next turn: the precombat main phase starts with a roll to visit your Attractions (the AI plays for you
// through the opponent's turn)
await setUp([]);
await emptyPool();
const turn = await S(() => window.__paSession.game.turnNumber);
const lit = await S(() => { const s = window.__paSession, g = s.game; return g.battlefield.filter(c => c.attraction && c.controller === s.human.pid).length; });
if (!lit) await S(() => { const s = window.__paSession, g = s.game, p = g.players[s.human.pid]; const c = p.AttractionDeck[0]; g.moveCard(c, 'battlefield', { controller: s.human.pid, silent: true }).then(() => s.store.bump()); });
await S(t => { window.__paAutoplay = t + 2; }, turn);
await page.click('.prompt .acts .btn:not(.primary)'); // End turn
await page.waitForFunction(t => { const s = window.__paSession, g = s.game; return g.turnNumber >= t + 2 && g.activePlayer === s.human.pid && g.step === 'main1'; }, turn, { timeout: 120000 }).catch(() => {});
await page.waitForTimeout(500);
const rolled = await S(() => { const g = window.__paSession.game; return g.logs.filter(l => l.turn === g.turnNumber).map(l => l.text); });
ok(rolled.some(t => /roll a d6 to visit Attractions: \d/.test(t) || /rolls a d6 to visit Attractions: \d/.test(t)), `rolled to visit at the start of the main phase (${rolled.slice(0, 6).join(' / ')})`);
await page.screenshot({ path: `${OUT}/8b-visit-roll.png` });

// ---- on a phone the mat still fits
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
// (the mat settles its card size over a few frames after the resize)
await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth + 1, null, { timeout: 4000 }).catch(() => {});
const wide =await S(() => document.documentElement.scrollWidth > innerWidth + 1 ? [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1 && !(e.parentElement && e.parentElement.getBoundingClientRect().right > innerWidth + 1)).slice(0, 6).map(e => `${e.tagName}.${e.className} ${Math.round(e.getBoundingClientRect().right)}`) : null);
ok(!wide, `no sideways scrolling on a phone (${JSON.stringify(wide)})`);
await page.screenshot({ path: `${OUT}/9-phone.png` });

console.log(errors.length ? `errors:\n${errors.join('\n')}` : 'no page errors');
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail || errors.length ? 1 : 0);
