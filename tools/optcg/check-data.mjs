// Check the One Piece data: every deck is 1 Leader + 50 cards, no more than 4 copies of a card number, every card in
// the Leader's colors and defined in cards.json with all its fields, each list confirmed by two sources, and every
// card pictured. Exits with an error (and lists every problem) when anything is off.
// Usage: node tools/optcg/check-data.mjs
import fs from 'node:fs';

const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const cards = read('data/optcg/cards.json');
const decks = read('data/optcg/decks.json');
const sources = fs.existsSync('data/optcg/sources.json') ? read('data/optcg/sources.json') : null;
const images = fs.existsSync('data/optcg/images.json') ? read('data/optcg/images.json') : null;
const errors = [];
const err = m => errors.push(m);

const COLORS = ['Red', 'Green', 'Blue', 'Purple', 'Black', 'Yellow'];
const ATTRS = ['Strike', 'Slash', 'Special', 'Ranged', 'Wisdom'];
const RARITIES = ['L', 'C', 'UC', 'R', 'SR', 'SEC', 'P', 'SP', 'TR'];
const FIELDS = ['id', 'name', 'cat', 'colors', 'cost', 'life', 'power', 'counter', 'attr', 'traits', 'text', 'trigger', 'rarity', 'set'];
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const ODD = /[‼−–－‘’“”＜＞➀-➉ 　]|<br|&[a-z]+;|&#\d+;|[぀-ヿ一-鿿]/;

// ---- cards --------------------------------------------------------------------------------------------------------
for (const [key, c] of Object.entries(cards)) {
  const where = `card ${key}`;
  const keys = Object.keys(c);
  for (const f of FIELDS) if (!(f in c)) err(`${where}: missing field ${f}`);
  for (const f of keys) if (!FIELDS.includes(f)) err(`${where}: unexpected field ${f}`);
  if (c.id !== key) err(`${where}: id ${c.id} differs from its key`);
  if (!/^(ST|OP|EB|PRB)\d{2}-\d{3}$|^P-\d{3}$/.test(key)) err(`${where}: odd card number`);
  if (typeof c.name !== 'string' || !c.name) err(`${where}: no name`);
  if (!['L', 'C', 'E', 'S'].includes(c.cat)) err(`${where}: category ${c.cat}`);
  if (!Array.isArray(c.colors) || !c.colors.length || c.colors.length > 2 || c.colors.some(x => !COLORS.includes(x))) err(`${where}: colors ${JSON.stringify(c.colors)}`);
  if (c.cat === 'L') {
    if (c.cost !== null) err(`${where}: a Leader has no cost`);
    if (!isNum(c.life)) err(`${where}: Leader without life`);
    if (!isNum(c.power)) err(`${where}: Leader without power`);
    if (c.counter !== null) err(`${where}: a Leader has no counter`);
  } else {
    if (!isNum(c.cost)) err(`${where}: no cost`);
    if (c.life !== null) err(`${where}: only Leaders have life`);
    if (c.cat === 'C' && !isNum(c.power)) err(`${where}: Character without power`);
    if (c.cat !== 'C' && c.power !== null) err(`${where}: only Characters and Leaders have power`);
    if (c.counter !== null && !(c.cat === 'C' && [1000, 2000].includes(c.counter))) err(`${where}: counter ${c.counter}`);
  }
  if (!Array.isArray(c.attr) || c.attr.some(a => !ATTRS.includes(a))) err(`${where}: attr ${JSON.stringify(c.attr)}`);
  if ((c.cat === 'L' || c.cat === 'C') && !c.attr.length) err(`${where}: Leader/Character without attribute`);
  if (!Array.isArray(c.traits) || c.traits.some(t => typeof t !== 'string' || !t || t !== t.trim())) err(`${where}: traits ${JSON.stringify(c.traits)}`);
  if (typeof c.text !== 'string') err(`${where}: text is not a string`);
  if (c.trigger !== null && (typeof c.trigger !== 'string' || !c.trigger || /\[Trigger\]/.test(c.trigger))) err(`${where}: trigger ${JSON.stringify(c.trigger)}`);
  if (/(^|\n)\[Trigger\]/.test(c.text)) err(`${where}: the trigger is still in the text`);
  for (const f of ['name', 'text', 'trigger']) if (c[f] && ODD.test(c[f])) err(`${where}: odd characters in ${f}: ${JSON.stringify(c[f].match(ODD)[0])}`);
  if (c.text !== c.text.trim() || /  |\n\n| \n|\n /.test(c.text)) err(`${where}: untidy whitespace in text`);
  if (!RARITIES.includes(c.rarity)) err(`${where}: rarity ${c.rarity}`);
  const set = key.startsWith('P-') ? 'P' : key.replace(/^([A-Z]+)(\d+)-\d+$/, '$1-$2');
  if (c.set !== set) err(`${where}: set ${c.set}, expected ${set}`);
}

// ---- decks --------------------------------------------------------------------------------------------------------
const DECK_FIELDS = ['id', 'code', 'name', 'leader', 'colors', 'cards', 'released', 'blurb', 'featured'];
const used = new Set();
let prev = '';
for (const d of decks) {
  const where = `deck ${d.code || d.id}`;
  for (const f of DECK_FIELDS) if (!(f in d)) err(`${where}: missing field ${f}`);
  for (const f of Object.keys(d)) if (!DECK_FIELDS.includes(f) && f !== 'leaders') err(`${where}: unexpected field ${f}`);
  // an Ultra Deck's other Leaders: each one a Leader whose colors allow every one of the 50 cards
  if (d.leaders) {
    if (!Array.isArray(d.leaders) || d.leaders[0] !== d.leader || new Set(d.leaders).size !== d.leaders.length) err(`${where}: leaders ${JSON.stringify(d.leaders)} must start with the Leader, no repeats`);
    for (const id of d.leaders.slice(1)) {
      const L = cards[id];
      if (!L || L.cat !== 'L') { err(`${where}: other Leader ${id} is not a Leader in cards.json`); continue; }
      for (const [cid] of d.cards) if (cards[cid] && !cards[cid].colors.every(x => L.colors.includes(x))) err(`${where}: ${cid} is not in ${id}'s colors ${L.colors.join('/')}`);
    }
  }
  if (!/^ST-\d{2}$/.test(d.code) || d.id !== d.code.replace('-', '').toLowerCase()) err(`${where}: id ${d.id} / code ${d.code}`);
  if (used.has(d.id)) err(`${where}: duplicate deck id`);
  used.add(d.id);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.released)) err(`${where}: released ${d.released}`);
  if (d.released < prev) err(`${where}: not in release order`);
  prev = d.released;
  if (typeof d.name !== 'string' || !d.name || /starter deck/i.test(d.name)) err(`${where}: name ${JSON.stringify(d.name)}`);
  if (typeof d.blurb !== 'string' || d.blurb.length < 30 || d.blurb.length > 300) err(`${where}: blurb missing or odd length`);
  const leader = cards[d.leader];
  if (!leader) { err(`${where}: Leader ${d.leader} is not in cards.json`); continue; }
  if (leader.cat !== 'L') err(`${where}: ${d.leader} is not a Leader`);
  if (JSON.stringify(d.colors) !== JSON.stringify(leader.colors)) err(`${where}: colors ${JSON.stringify(d.colors)} are not the Leader's ${JSON.stringify(leader.colors)}`);
  if (!cards[d.featured]) err(`${where}: featured card ${d.featured} is not in cards.json`);
  let total = 0;
  const seen = new Set();
  for (const entry of d.cards) {
    const [id, n] = entry;
    if (entry.length !== 2 || !Number.isInteger(n) || n < 1) { err(`${where}: bad entry ${JSON.stringify(entry)}`); continue; }
    if (seen.has(id)) err(`${where}: ${id} listed twice`);
    seen.add(id);
    total += n;
    if (n > 4) err(`${where}: ${n} copies of ${id}`);
    const c = cards[id];
    if (!c) { err(`${where}: ${id} is not in cards.json`); continue; }
    if (c.cat === 'L') err(`${where}: a second Leader (${id}) among the 50`);
    const off = c.colors.filter(x => !leader.colors.includes(x));
    if (off.length) err(`${where}: ${id} ${c.name} is ${c.colors.join('/')}, not in the Leader's colors ${leader.colors.join('/')}`);
  }
  if (total !== 50) err(`${where}: ${total} cards besides the Leader, not 50`);
  if (sources) {
    const s = sources.decks[d.code];
    const agree = s ? s.sources.filter(x => x.agrees).length : 0;
    if (agree < 2) err(`${where}: confirmed by ${agree} source(s), not 2`);
    if (s && JSON.stringify(s.cards) !== JSON.stringify(d.cards)) err(`${where}: list differs from sources.json`);
  }
}

// ---- every card a deck uses is defined, and every card defined is used and pictured ------------------------
const inDecks = new Set(decks.flatMap(d => [d.leader, ...(d.leaders || []), ...d.cards.map(([id]) => id)]));
for (const id of Object.keys(cards)) if (!inDecks.has(id)) err(`card ${id} is in cards.json but in no deck`);
if (images) {
  for (const id of inDecks) if (!images.cards[id]) err(`card ${id} has no picture in images.json`);
  for (const [id, [p, off, len]] of Object.entries(images.cards)) {
    const pack = images.packs[p];
    const file = pack && ['docs', 'dist'].map(dir => `${dir}/${pack.split('?')[0]}`).find(f => fs.existsSync(f));
    if (!file) { err(`picture ${id}: pack ${pack} not found in docs/ or dist/`); continue; }
    if (off + len > fs.statSync(file).size) err(`picture ${id}: runs past the end of ${file}`);
  }
} else err('data/optcg/images.json is missing: run tools/optcg/fetch-images.mjs');

const copies = decks.reduce((a, d) => a + 1 + d.cards.reduce((s, [, n]) => s + n, 0), 0);
if (errors.length) {
  console.error(`${errors.length} problem${errors.length === 1 ? '' : 's'}:\n  ` + errors.join('\n  '));
  process.exit(1);
}
console.log(`ok: ${decks.length} decks (${copies} cards, each 1 Leader + 50), ${Object.keys(cards).length} unique cards with every field, all in their Leader's colors, at most 4 copies, each list confirmed by 2+ sources, ${images ? Object.keys(images.cards).length + ' pictures in ' + images.packs.length + ' packs' : 'no pictures'}`);
