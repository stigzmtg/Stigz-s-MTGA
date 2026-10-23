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
// caching hints for hosts that read them (Cloudflare Pages, Netlify): card images change rarely, data and code more often
fs.writeFileSync(path.join(OUT, '_headers'), `/img/*
  Cache-Control: public, max-age=86400

/data/*
  Cache-Control: public, max-age=3600

/app.js
  Cache-Control: public, max-age=300

/sw.js
  Cache-Control: no-cache
`);
console.log(`docs/: ${files} files, ${(bytes / 1048576).toFixed(1)} MB`);
