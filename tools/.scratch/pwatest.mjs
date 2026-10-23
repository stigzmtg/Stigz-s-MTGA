import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.goto('http://localhost:8765/'); await p.waitForSelector('.gate');
await p.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.ready.then(() => true), null, { timeout: 30000 });
await p.reload(); await p.waitForSelector('.gate');
console.log('service worker controls the page:', await p.evaluate(() => !!navigator.serviceWorker.controller));
const cdp = await ctx.newCDPSession(p);
const m = await cdp.send('Page.getAppManifest');
console.log('manifest errors:', JSON.stringify(m.errors), '| name:', JSON.parse(m.data || '{}').name);
const inst = await cdp.send('Page.getInstallabilityErrors').catch(e => ({ installabilityErrors: [{ errorId: 'n/a ' + e.message }] }));
console.log('installability errors:', JSON.stringify(inst.installabilityErrors.map(e => e.errorId)));
// use the Pokémon side once online, so its data and pictures are saved
await p.click('.gate.pk .cta'); await p.waitForSelector('.pk-lobby'); await p.waitForFunction(() => [...document.querySelectorAll('.pk-deck img')].filter(i => i.complete && i.naturalWidth).length >= 10, null, { timeout: 30000 });
await p.waitForTimeout(1500);
console.log('caches:', JSON.stringify(await p.evaluate(async () => { const out = {}; for (const k of await caches.keys()) out[k] = (await (await caches.open(k)).keys()).length; return out; })));
// now with no connection at all
await ctx.setOffline(true);
await p.goto('http://localhost:8765/#pokemon'); await p.reload();
await p.waitForSelector('.pk-lobby', { timeout: 20000 });
const pics = await p.evaluate(() => [...document.querySelectorAll('.pk-deck img')].filter(i => i.complete && i.naturalWidth).length);
console.log('offline: Pokémon lobby loads with', pics, 'deck pictures');
await p.click('button:has-text("Battle!")'); await p.waitForSelector('.pk-board', { timeout: 20000 });
await p.waitForTimeout(2000);
console.log('offline: battle started:', !!(await p.$('.pk-hand .pk-card img, .dialog .pk-card img')));
await ctx.setOffline(false);
console.log(errs.length ? errs : 'no page errors');
await browser.close();
