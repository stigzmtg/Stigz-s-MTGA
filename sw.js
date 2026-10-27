// Offline support and faster repeat visits for the website (never the claude.ai page). The page, the app and the
// data always try the network first, so a new version arrives at once, and fall back to what was saved when the
// connection drops. Card pictures, React and the fonts come from the cache once they've been seen.
// tools/build.mjs fills in VERSION; every build gets its own cache for the page and data.
const VERSION = 'b464c28b40f4';
const SHELL = 'tcg-arena-' + VERSION;
const IMG = 'tcg-arena-img';      // card picture packs, kept until their index changes
const LIB = 'tcg-arena-lib';      // React and fonts from their CDNs
const PRECACHE = ['./', 'index.html', 'app.js', 'manifest.webmanifest', 'data/decks.json', 'data/images.json', 'data/ptcg/cards.json', 'data/ptcg/decks.json', 'data/ptcg/images.json', 'data/optcg/cards.json', 'data/optcg/decks.json', 'data/optcg/images.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(PRECACHE)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('tcg-arena-') && k !== SHELL && k !== IMG && k !== LIB).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const lib = /(^|\.)cdnjs\.cloudflare\.com$|^fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (url.origin !== self.location.origin && !lib) return;
  if (/\/(relay|save|account)\/|\/decklink$/.test(url.pathname)) return;   // friends' rooms, save codes, accounts and deck links are live (and private)
  if (lib) return e.respondWith(cacheFirst(LIB, req));
  if (/\/img\/[^/]+\.(avif|png)$/.test(url.pathname)) return e.respondWith(cacheFirst(IMG, req));
  e.respondWith(networkFirst(req, /\/data\/((pt|op)cg\/)?images\.json$/.test(url.pathname)));
});

async function cacheFirst(name, req) {
  const c = await caches.open(name);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') c.put(req, res.clone());
  return res;
}

async function networkFirst(req, isImageIndex) {
  const c = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    if (res.ok) {
      // a new picture index means repacked pictures: the saved packs no longer match it
      if (isImageIndex) {
        const old = await findOld(req);
        if (old && (await old.text()) !== (await res.clone().text())) await caches.delete(IMG);
      }
      await c.put(req, res.clone());
    }
    return res;
  } catch (err) {
    const hit = (await caches.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? await caches.match('index.html') : null);
    if (hit) return hit;
    throw err;
  }
}

async function findOld(req) {
  for (const k of await caches.keys()) if (k.startsWith('tcg-arena-') && k !== IMG && k !== LIB) { const hit = await (await caches.open(k)).match(req, { ignoreSearch: true }); if (hit) return hit; }
  return null;
}
