// Readability audit: every visible piece of text on the main screens, checked for size, contrast against what is
// actually drawn behind it (sampled from a screenshot), and for blur-prone rendering: text under a scale or a
// fractional translate, or under filter / backdrop-filter layers.
// Usage: node tools/textaudit.mjs [out dir]   (serve dist/ on :8765 first; ONLY=op, pk or mtg audits one game)
import { chromium } from 'playwright';
import sharp from 'sharp';
import fs from 'node:fs';
const OUT = process.argv[2] || '/tmp/textaudit';
fs.mkdirSync(OUT, { recursive: true });
const BASE = process.env.BASE || 'http://localhost:8765/';
const browser = await chromium.launch();

// collect text elements with their styles and the transforms/filters above them
const collect = () => {
  const out = [];
  const parse = t => { const m = /matrix\(([^)]+)\)/.exec(t); return m ? m[1].split(',').map(Number) : null; };
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || seen.has(el) || !n.textContent.trim()) continue;
    seen.add(el);
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || el.closest('[aria-hidden="true"]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    let op = 1, scaled = null, frac = null, filt = null;
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const s = getComputedStyle(a);
      op *= +s.opacity;
      if (s.display === 'none') { op = 0; break; }
      const m = s.transform !== 'none' ? parse(s.transform) : null;
      if (m) {
        const [sa, sb, sc, sd, tx, ty] = m;
        if (Math.abs(sa - 1) > 1e-3 || Math.abs(sd - 1) > 1e-3 || Math.abs(sb) > 1e-3 || Math.abs(sc) > 1e-3) scaled = scaled || (a.className || a.tagName) + ' ' + s.transform;
        else if (Math.abs(tx - Math.round(tx)) > 0.01 || Math.abs(ty - Math.round(ty)) > 0.01) frac = frac || (a.className || a.tagName) + ' ' + s.transform;
      }
      if ((s.filter && s.filter !== 'none') || (s.backdropFilter && s.backdropFilter !== 'none')) filt = filt || (a.className || a.tagName) + ' ' + (s.filter !== 'none' ? s.filter : 'backdrop ' + s.backdropFilter);
    }
    if (op < 0.05) continue;
    const sx = window.scrollX, sy = window.scrollY;
    out.push({
      text: n.textContent.trim().slice(0, 40), cls: String(el.className || el.tagName).slice(0, 40),
      size: parseFloat(cs.fontSize), weight: +cs.fontWeight || 400, color: cs.color, op,
      x: r.left + sx, y: r.top + sy, w: r.width, h: r.height, scaled, frac, filt,
    });
  }
  return out;
};

const rgba = s => { const m = /rgba?\(([^)]+)\)/.exec(s); const v = m ? m[1].split(/[ ,/]+/).filter(Boolean).map(Number) : [0, 0, 0]; return [v[0], v[1], v[2], v[3] == null ? 1 : v[3]]; };
const lum = ([r, g, b]) => { const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

async function audit(page, name) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  const items = await page.evaluate(collect);
  const shot = `${OUT}/${name}.png`;
  await page.screenshot({ path: shot, fullPage: true, animations: 'disabled' });
  const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => { x = Math.max(0, Math.min(info.width - 1, Math.round(x))); y = Math.max(0, Math.min(info.height - 1, Math.round(y))); const i = (y * info.width + x) * info.channels; return [data[i], data[i + 1], data[i + 2]]; };
  const issues = [];
  for (const it of items) {
    const [r, g, b, a] = rgba(it.color);
    // the background: of a few points around the text's box, the one least like the text
    const pts = [[it.x + 1, it.y + 1], [it.x + it.w - 2, it.y + 1], [it.x + 1, it.y + it.h - 2], [it.x + it.w - 2, it.y + it.h - 2], [it.x - 2, it.y + it.h / 2], [it.x + it.w + 2, it.y + it.h / 2]].map(([x, y]) => px(x, y));
    const bg = pts.sort((p, q) => contrast(q, [r, g, b]) - contrast(p, [r, g, b]))[0];
    const al = a * it.op;
    const fg = [r * al + bg[0] * (1 - al), g * al + bg[1] * (1 - al), b * al + bg[2] * (1 - al)];
    const c = contrast(fg, bg);
    const large = it.size >= 24 || (it.size >= 18.66 && it.weight >= 700);
    const why = [];
    if (it.size < 11) why.push(`${it.size}px`);
    if (c < (large ? 3 : 4.5)) why.push(`contrast ${c.toFixed(2)}`);
    if (it.scaled) why.push(`scaled: ${it.scaled.slice(0, 70)}`);
    if (it.frac) why.push(`half-pixel: ${it.frac.slice(0, 70)}`);
    if (it.filt) why.push(`filter: ${it.filt.slice(0, 60)}`);
    if (why.length) issues.push({ ...it, contrast: +c.toFixed(2), why });
  }
  console.log(`\n== ${name}: ${items.length} text elements, ${issues.length} flagged`);
  const groups = new Map();
  for (const i of issues) { const k = i.cls + ' | ' + i.why.map(w => w.replace(/[\d.]+/g, '#')).join('; '); const g = groups.get(k) || { n: 0, ex: i }; g.n++; groups.set(k, g); }
  for (const [, g] of [...groups].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${String(g.n).padStart(3)}× ${g.ex.cls.padEnd(28)} "${g.ex.text}" ${g.ex.size}px · ${g.ex.why.join(' · ')}`);
  return issues;
}

const views = [[1440, 900], [390, 844]];
const only = process.env.ONLY || '';
for (const [w, h] of views) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  await ctx.addInitScript(() => { window.__pkAutoplay = 4; window.__paAutoplay = 3; window.__opAutoplay = 4; try { localStorage.setItem('pa-settings', JSON.stringify({ aiSpeed: 'instant' })); } catch {} });
  const page = await ctx.newPage();
  if (!only) { await page.goto(BASE); await page.waitForSelector('.app.home .deck-tile.pk'); await page.waitForTimeout(1500); await audit(page, `home-${w}`); }
  if (!only || only === 'op') {
    await page.goto(BASE + '#onepiece'); await page.reload(); await page.waitForSelector('.op-lobby'); await page.waitForTimeout(1200);
    await audit(page, `op-lobby-${w}`);
    await page.click('.modeswitch button:has-text("Play with friends")');
    await audit(page, `op-friends-${w}`);
    await page.click('.modeswitch button:has-text("computer")');
    await page.click('button:has-text("Battle!")'); await page.waitForSelector('.op-board');
    await page.waitForFunction(() => +(document.querySelector('.topbar .turninfo b') || {}).textContent >= 4, null, { timeout: 120000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await audit(page, `op-battle-${w}`);
  }
  if (only && only !== 'pk' && only !== 'mtg') { await ctx.close(); continue; }
  if (only === 'mtg') { await page.goto(BASE); }
  else {
  await page.goto(BASE + '#pokemon'); await page.reload(); await page.waitForSelector('.pk-lobby');
  await audit(page, `pk-lobby-${w}`);
  await page.click('.modeswitch button:has-text("Play with friends")');
  await audit(page, `pk-friends-${w}`);
  await page.click('.modeswitch button:has-text("computer")');
  await page.click('button:has-text("Battle!")'); await page.waitForSelector('.pk-board');
  await page.waitForFunction(() => +(document.querySelector('.topbar .turninfo b') || {}).textContent >= 4, null, { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await audit(page, `pk-battle-${w}`);
  }
  if (only === 'pk') { await ctx.close(); continue; }
  await page.goto(BASE + '#mtg'); await page.reload(); await page.waitForSelector('text=Pick a precon', { timeout: 90000 });
  await audit(page, `mtg-lobby-${w}`);
  await page.click('button:has-text("Shuffle up")'); await page.waitForSelector('.topbar .turninfo', { timeout: 60000 });
  await page.waitForFunction(() => /Turn\s*[3-9]/.test((document.querySelector('.topbar') || {}).textContent || ''), null, { timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await audit(page, `mtg-game-${w}`);
  await ctx.close();
}
await browser.close();
