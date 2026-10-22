// Builds data/cards.json, data/tokens.json and data/decks.json from
//  - taw/magic-preconstructed-decks (precon decklists)
//  - Card-Forge/forge res/cardsfolder + res/tokenscripts (card rules scripts)
// Usage: node tools/build-data.mjs <decks-repo-dir> <forge-res-dir>
import fs from 'node:fs';
import path from 'node:path';
import { compactScript, parseCardScript, normName } from '../src/engine/forge.js';

const SCRATCH = '/tmp/claude-0/-home-user/c7951bb0-2eab-52cb-96d1-4ea2a7466e6c/scratchpad/dl';
const DECKS_REPO = process.argv[2] || path.join(SCRATCH, 'magic-preconstructed-decks');
const FORGE_RES = process.argv[3] || path.join(SCRATCH, 'forge/forge-gui/res');
const OUT = path.resolve('data');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.txt')) out.push(p);
  }
  return out;
}

// ---- set names
const setNames = {};
for (const m of fs.readFileSync(path.join(DECKS_REPO, 'lib/sets.rb'), 'utf8').matchAll(/"([^"]+)" => "([^"]+)"/g)) setNames[m[1]] = m[2];

// ---- forge card index
const byName = new Map(); // normName -> { file, script }
let nFiles = 0;
for (const file of walk(path.join(FORGE_RES, 'cardsfolder'))) {
  const text = fs.readFileSync(file, 'utf8');
  const parsed = parseCardScript(text);
  const names = parsed.faces.map(f => f.name).filter(Boolean);
  if (!names.length) continue;
  nFiles++;
  const entry = { file, text, parsed };
  const full = names.length > 1 && ['Split', 'Modal', 'DoubleFaced', 'Adventure', 'Flip', 'Omen', 'Prepare'].includes(parsed.altMode) ? names.join(' // ') : names[0];
  for (const n of [full, names[0]]) {
    const k = normName(n);
    if (!byName.has(k)) byName.set(k, entry);
  }
}
console.log('forge card files:', nFiles);

// ---- decks
// Universes Within names used in some decklists -> Forge card names
const ALIASES = { 'Baldin, Century Herdmaster': 'E. Honda, Sumo Champion', 'Arvinox, the Mind Flail': 'Mind Flayer, the Shadow' };
const DECK_DIRS = ['cmd', 'cmd-pc', 'cmd-arc'];
const decks = [];
const needed = new Map(); // canonical name -> entry
const missing = new Map();
for (const dd of DECK_DIRS) {
  const base = path.join(DECKS_REPO, 'data', dd);
  if (!fs.existsSync(base)) continue;
  for (const file of walk(base)) {
    const setCode = path.basename(path.dirname(file)).replace(/_$/, '');
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    let name = path.basename(file, '.txt'), date = null;
    const commanders = [], cards = [];
    let inMain = true;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('//')) {
        const m = line.match(/^\/\/\s*(NAME|DATE):\s*(.*)$/);
        if (m && m[1] === 'NAME') name = m[2].trim();
        if (m && m[1] === 'DATE') date = m[2].trim();
        continue;
      }
      const isCmd = line.startsWith('COMMANDER:');
      const body = isCmd ? line.slice(10).trim() : line;
      const m = body.match(/^(\d+)\s+(.+)$/);
      if (!m) { inMain = false; continue; } // section header (Sideboard, Display Commander, Planar Deck, ...)
      if (!inMain && !isCmd) continue;
      if (/\[token\]/.test(body)) continue;
      const count = +m[1];
      const cname = m[2].replace(/\s*\[[^\]]*\]/g, '').trim();
      const alias = ALIASES[cname] || cname;
      const entry = byName.get(normName(alias)) || byName.get(normName(alias.split(' // ')[0]));
      if (!entry) { missing.set(cname, (missing.get(cname) || 0) + 1); continue; }
      const canon = entry.parsed.faces[0].name;
      needed.set(canon, entry);
      (isCmd ? commanders : cards).push(isCmd ? canon : [canon, count]);
    }
    if (!commanders.length) continue;
    const total = cards.reduce((a, c) => a + c[1], 0) + commanders.length;
    decks.push({
      id: `${setCode}-${name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      name, set: setCode.toUpperCase(), setName: setNames[setCode] || setCode.toUpperCase(), date, commanders, cards, total,
    });
  }
}
decks.sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.name.localeCompare(b.name));
console.log('decks:', decks.length, 'unique cards:', needed.size);
console.log('incomplete decks:', decks.filter(d => d.total !== 100).map(d => `${d.name} (${d.total})`).join(', ') || 'none');
console.log('missing cards:', [...missing.entries()].map(([n, c]) => `${n} x${c}`).join('; ') || 'none');

// ---- tokens: include every token script (small) so Token$ effects can resolve any TokenScript
const tokens = {};
for (const file of walk(path.join(FORGE_RES, 'tokenscripts'))) {
  tokens[path.basename(file, '.txt')] = compactScript(fs.readFileSync(file, 'utf8'));
}

const cards = {};
for (const [canon, entry] of [...needed.entries()].sort()) cards[canon] = compactScript(entry.text);

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'cards.json'), JSON.stringify(cards));
fs.writeFileSync(path.join(OUT, 'tokens.json'), JSON.stringify(tokens));
fs.writeFileSync(path.join(OUT, 'decks.json'), JSON.stringify(decks));
for (const f of ['cards.json', 'tokens.json', 'decks.json']) console.log(f, (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0) + 'KB');
