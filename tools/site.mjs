// Copy the built site (dist/: page, app, data, packed card images) into docs/, which GitHub Pages serves.
// Usage: node tools/build.mjs && node tools/site.mjs
import fs from 'node:fs';
import path from 'node:path';

const DIST = path.resolve('dist'), OUT = path.resolve('docs');
if (!fs.existsSync(path.join(DIST, 'img'))) { console.error('dist/img is missing: run tools/pack-images.mjs first'); process.exit(1); }
fs.rmSync(OUT, { recursive: true, force: true });
for (const dir of ['', 'data', 'data/ptcg', 'img']) fs.mkdirSync(path.join(OUT, dir), { recursive: true });
let bytes = 0, files = 0;
const copy = rel => { fs.copyFileSync(path.join(DIST, rel), path.join(OUT, rel)); bytes += fs.statSync(path.join(OUT, rel)).size; files++; };
copy('index.html');
copy('app.js');
for (const f of ['manifest.webmanifest', 'sw.js']) if (fs.existsSync(path.join(DIST, f))) copy(f);
for (const f of fs.readdirSync(path.join(DIST, 'data'))) if (fs.statSync(path.join(DIST, 'data', f)).isFile()) copy(path.join('data', f));
for (const f of fs.readdirSync(path.join(DIST, 'data', 'ptcg'))) copy(path.join('data', 'ptcg', f));
for (const f of fs.readdirSync(path.join(DIST, 'img'))) copy(path.join('img', f));
// serve files as they are (no Jekyll processing on GitHub Pages)
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
// caching hints for hosts that read them (Cloudflare, Netlify). The app asks for data and picture packs with a
// version in the address, but browsers and the CDN still check back for the page, the app and the data every time
// (a quick "not modified" when nothing changed), so a new deck shows up on the next reload, not an hour later
fs.writeFileSync(path.join(OUT, '_headers'), `/img/*
  Cache-Control: public, max-age=86400

/data/*
  Cache-Control: no-cache

/app.js
  Cache-Control: no-cache

/
  Cache-Control: no-cache

/index.html
  Cache-Control: no-cache

/sw.js
  Cache-Control: no-cache
`);
console.log(`docs/: ${files} files, ${(bytes / 1048576).toFixed(1)} MB`);
