// Build the Pokémon TCG data the site uses from the scraped decklists and TCGdex card records:
// data/ptcg/cards.json (one compact definition per card) and data/ptcg/decks.json.
// Usage: node tools/ptcg/build-data.mjs <cache dir>   (the dir holding lists.json and cards/)
import fs from 'node:fs';
import path from 'node:path';

const CACHE = process.argv[2];
if (!CACHE) { console.error('usage: node tools/ptcg/build-data.mjs <cache dir>'); process.exit(1); }
const lists = JSON.parse(fs.readFileSync(path.join(CACHE, 'lists.json'), 'utf8'));

// the decks on offer, in lobby order, with a featured card and a line on how each plays
const DECKS = [
  { name: 'Dragapult ex', id: 'dragapult', featured: 'TWM-130', blurb: 'Phantom Dive hits the Active for 200 and spreads 6 damage counters across the Bench. Drakloak digs for pieces while Munkidori moves damage around.' },
  { name: 'Charizard ex', id: 'charizard', featured: 'OBF-125', blurb: 'Rare Candy into Charizard ex, whose Infernal Reign attaches 3 Fire Energy at once. Burning Darkness grows with every Prize your opponent takes.' },
  { name: 'Gardevoir ex', id: 'gardevoir', featured: 'SVI-86', blurb: 'Psychic Embrace powers up the team from the discard pile. Drifloon and Scream Tail turn the damage they take into big attacks.' },
  { name: 'Raging Bolt ex', id: 'raging-bolt', featured: 'TEF-123', blurb: 'Teal Mask Ogerpon charges the Bench, then Bellowing Thunder discards Energy for 70 damage each. Mega Kangaskhan draws cards and hits hard.' },
  { name: 'Gholdengo ex', id: 'gholdengo', featured: 'PAR-139', blurb: 'Make It Rain discards Basic Energy from your hand for 50 damage each. Lunatone, Solrock and Coin Bonus keep the cards coming.' },
  { name: 'Miraidon ex', id: 'miraidon', featured: 'SVI-81', blurb: 'Tandem Unit fills the Bench with Lightning attackers. Iron Hands ex takes extra Prizes and Magneton recharges Energy from the discard pile.' },
  { name: 'Mega Absol Box', id: 'mega-absol', featured: 'MEG-86', blurb: 'Dark disruption: Munkidori moves damage counters so Terminal Period can knock out a Pokémon in one hit, with Team Rocket tricks for support.' },
  { name: 'Chien-Pao Baxcalibur', id: 'chien-pao', featured: 'PAL-61', blurb: 'Baxcalibur attaches any number of Water Energy from your hand, then Hail Blade discards them for 60 damage each.' },
  { name: 'Roaring Moon ex', id: 'roaring-moon', featured: 'PAR-124', blurb: 'Frenzied Gouging knocks out any Active Pokémon outright. Dudunsparce draws cards and Professor Sada’s Vitality fuels the Ancient attackers.' },
  { name: 'Lost Zone Box', id: 'lost-zone', featured: 'LOR-79', blurb: 'Comfey and Colress’s Experiment fill the Lost Zone, then Cramorant attacks for free and Sableye’s Lost Mine places 12 damage counters.' },
];

// trait lists the card records don't carry
const TERA = new Set(['OBF-125', 'TWM-130', 'TWM-25', 'TWM-64', 'TWM-112', 'SSP-76', 'SSP-57']);
const ANCIENT = new Set(['Roaring Moon', 'Roaring Moon ex', 'Raging Bolt ex', 'Scream Tail', "Explorer's Guidance", "Professor Sada's Vitality", 'Ancient Booster Energy Capsule', 'Earthen Vessel']);
const FUTURE = new Set(['Iron Hands ex', 'Iron Bundle', 'Iron Leaves ex', 'Miraidon ex']);
const ACE_SPEC = new Set(['Unfair Stamp', 'Secret Box', 'Prime Catcher', 'Sparkling Crystal']);
const BASIC_TYPES = ['Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal'];
// basic Energy pictures: the Mega Evolution Energies printings (numbers 9-16 in type order)
const ENERGY_IMAGE = t => `https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/tpci/MEE/MEE_${String(9 + BASIC_TYPES.indexOf(t)).padStart(3, '0')}_R_EN_LG.png`;

const clean = s => (s || '').replace(/é/g, 'é').replace(/\s+\n/g, '\n').trim();
const cards = {};
function def(entry) {
  const basic = /^(\w+) Energy$/.exec(entry.name);
  if (basic && BASIC_TYPES.includes(basic[1])) {
    const key = `${basic[1]} Energy`;
    cards[key] = cards[key] || { key, name: key, cat: 'E', energy: 'Basic', provides: basic[1], img: ENERGY_IMAGE(basic[1]) };
    return key;
  }
  const key = `${entry.set}-${parseInt(entry.num, 10)}`;
  if (cards[key]) return key;
  const file = path.join(CACHE, 'cards', `${entry.set}-${entry.num}.json`);
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  const img = c.image ? `${c.image}/high.webp` : `https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/tpci/${entry.set}/${entry.set}_${String(entry.num).padStart(3, '0')}_R_EN_LG.png`;
  if (c.category === 'Pokemon') {
    const ex = / ex$/.test(c.name);
    cards[key] = {
      key, name: c.name, cat: 'P', stage: c.stage, hp: c.hp, type: c.types[0], from: c.evolveFrom || null,
      ex, mega: ex && /^Mega /.test(c.name), tera: TERA.has(key), ancient: ANCIENT.has(c.name), future: FUTURE.has(c.name),
      weak: (c.weaknesses && c.weaknesses[0] && c.weaknesses[0].type) || null,
      resist: (c.resistances && c.resistances[0] && c.resistances[0].type) || null,
      retreat: c.retreat || 0,
      abilities: (c.abilities || []).map(a => ({ name: a.name, text: clean(a.effect) })),
      attacks: (c.attacks || []).map(a => ({ name: a.name, cost: a.cost || [], damage: a.damage == null ? '' : String(a.damage), text: clean(a.effect) })),
      img,
    };
  } else if (c.category === 'Trainer') {
    cards[key] = { key, name: c.name, cat: 'T', trainer: c.trainerType, text: clean(c.effect), ancient: ANCIENT.has(c.name), ace: ACE_SPEC.has(c.name), img };
    if (c.attacks) cards[key].attacks = c.attacks.map(a => ({ name: a.name, cost: a.cost || [], damage: a.damage == null ? '' : String(a.damage), text: clean(a.effect) }));
  } else {
    cards[key] = { key, name: c.name, cat: 'E', energy: 'Special', provides: 'Colorless', text: clean(c.effect), img };
  }
  return key;
}

const decks = [];
for (const d of DECKS) {
  const l = lists.find(x => x.name === d.name);
  if (!l) throw new Error('no list for ' + d.name);
  const counts = new Map();
  for (const e of l.cards) { const k = def(e); counts.set(k, (counts.get(k) || 0) + e.n); }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total !== 60) throw new Error(`${d.name}: ${total} cards`);
  const [, archetype, player] = /^(.*?) by (.*?) – Limitless$/.exec(l.title) || [];
  const energyTypes = [...new Set([...counts.keys()].map(k => cards[k]).filter(c => c.cat === 'E' && c.energy === 'Basic').map(c => c.provides))];
  decks.push({ id: d.id, name: d.name, featured: d.featured, blurb: d.blurb, list: archetype || d.name, player: player || '', source: `https://limitlesstcg.com/decks/list/${l.list}`, energy: energyTypes, cards: [...counts] });
}
if (!cards[DECKS[0].featured]) throw new Error('featured card missing');
fs.mkdirSync('data/ptcg', { recursive: true });
fs.writeFileSync('data/ptcg/cards.json', JSON.stringify(cards));
fs.writeFileSync('data/ptcg/decks.json', JSON.stringify(decks));
console.log(`${Object.keys(cards).length} cards, ${decks.length} decks`);
