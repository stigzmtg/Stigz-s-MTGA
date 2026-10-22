// Split dist/img packs into publish batches (each publish takes at most 64 MB and 255 files).
// Prints one JSON object per line: { "img/x.bin": "/abs/dist/img/x.bin", ... }
import fs from 'node:fs';
import path from 'node:path';
const dir = path.resolve('dist/img');
const LIMIT = +(process.argv[2] || 56) * 1048576;
const groups = [];
let cur = {}, size = 0, n = 0;
for (const f of fs.readdirSync(dir).sort()) {
  const s = fs.statSync(path.join(dir, f)).size;
  if (n && (size + s > LIMIT || n >= 240)) { groups.push(cur); cur = {}; size = 0; n = 0; }
  cur[`img/${f}`] = path.join(dir, f); size += s; n++;
}
if (n) groups.push(cur);
for (const g of groups) console.log(JSON.stringify(g));
console.error(`${groups.length} batches`);
