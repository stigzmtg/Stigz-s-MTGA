// Small pictures for the menus: each starter deck's Leader and featured card at 240px, in one pack
// (img/optcg-thumbs.avif), so the home page and the lobby don't download every card picture. Reads the full-size packs
// that tools/optcg/fetch-images.mjs wrote (docs/img/optcg-N.avif) and adds `thumbs` to data/optcg/images.json:
// { id: [pack, offset, length] }, pack being an index into `packs` like the full-size entries.
// Usage: node tools/optcg/pack-thumbs.mjs   (fetch-images.mjs runs it at the end)
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const ix = JSON.parse(fs.readFileSync('data/optcg/images.json', 'utf8'));
const decks = JSON.parse(fs.readFileSync('data/optcg/decks.json', 'utf8'));
const NAME = 'img/optcg-thumbs.avif';
ix.packs = ix.packs.map(p => p.split('?')[0]).filter(p => p !== NAME);
const ids = [];
for (const d of decks) for (const id of [d.leader, d.featured]) if (id && !ids.includes(id) && ix.cards[id]) ids.push(id);

const packs = new Map();
const full = id => {
  const [p, off, len] = ix.cards[id];
  if (!packs.has(p)) packs.set(p, fs.readFileSync(path.join('docs', ix.packs[p])));
  return packs.get(p).subarray(off, off + len);
};
const parts = [], thumbs = {};
let size = 0;
for (const id of ids) {
  const b = await sharp(full(id)).resize({ width: 240 }).avif({ quality: 55, effort: 4 }).toBuffer();
  thumbs[id] = [ix.packs.length, size, b.length];
  parts.push(b); size += b.length;
}
const buf = Buffer.concat(parts);
for (const o of ['dist/img', 'docs/img']) { fs.mkdirSync(o, { recursive: true }); fs.writeFileSync(path.join(o, path.basename(NAME)), buf); }
ix.packs.push(NAME);
ix.thumbs = thumbs;
fs.writeFileSync('data/optcg/images.json', JSON.stringify(ix));
console.log(`${ids.length} thumbnails in ${NAME}, ${(buf.length / 1024).toFixed(0)} KB`);
