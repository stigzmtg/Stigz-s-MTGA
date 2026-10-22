// Copy the built site (dist/: page, app, data, packed card images) into docs/, which GitHub Pages serves.
// Usage: node tools/build.mjs && node tools/site.mjs
import fs from 'node:fs';
import path from 'node:path';

const DIST = path.resolve('dist'), OUT = path.resolve('docs');
if (!fs.existsSync(path.join(DIST, 'img'))) { console.error('dist/img is missing: run tools/pack-images.mjs first'); process.exit(1); }
fs.rmSync(OUT, { recursive: true, force: true });
for (const dir of ['', 'data', 'img']) fs.mkdirSync(path.join(OUT, dir), { recursive: true });
let bytes = 0, files = 0;
const copy = rel => { fs.copyFileSync(path.join(DIST, rel), path.join(OUT, rel)); bytes += fs.statSync(path.join(OUT, rel)).size; files++; };
copy('index.html');
copy('app.js');
for (const f of fs.readdirSync(path.join(DIST, 'data'))) copy(path.join('data', f));
for (const f of fs.readdirSync(path.join(DIST, 'img'))) copy(path.join('img', f));
// serve files as they are (no Jekyll processing)
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
console.log(`docs/: ${files} files, ${(bytes / 1048576).toFixed(1)} MB`);
