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
  { name: 'Slowking', id: 'slowking', featured: 'SCR-58', blurb: 'Seek Inspiration discards the top card of the deck and uses that Pokémon’s attack. Academy at Night and Ciphermaniac’s Codebreaking line up Kyurem, Metagross and Zeraora on top.' },
  { name: "N's Zoroark ex", id: 'ns-zoroark', featured: 'JTG-98', blurb: 'Trade draws two cards every turn, and Night Joker copies the attacks of N’s Zekrom and N’s Reshiram on the Bench. Munkidori moves damage around.' },
  { name: 'Festival Lead', id: 'festival-lead', featured: 'PRE-21', blurb: 'With Festival Grounds in play Seaking attacks twice a turn. Thwackey’s Boom Boom Groove finds any card, and Gladion’s Final Battle adds 80 damage to every hit.' },
  { name: 'Alakazam Dusknoir', id: 'alakazam', featured: 'MEG-56', blurb: 'Kadabra and Alakazam draw cards as they evolve, then Powerful Hand places 2 damage counters for each card in your hand. Dusknoir’s Cursed Blast finishes the job.' },
  { name: 'Hydrapple ex', id: 'hydrapple', featured: 'SCR-14', blurb: 'Meganium’s Wild Growth makes every Grass Energy count twice, so Hydrapple ex’s Syrup Storm grows fast. Ripening Charge and Teal Mask Ogerpon ex pile on the Energy.' },
  { name: 'Dhelmise', id: 'dhelmise', featured: 'PBL-39', blurb: 'Shuppet, Banette, Poltchageist and Sinistcha ignore attack effects with Hide ’n’ Sneak. Once four of them are in the discard pile, Vengeful Anchor hits for 170.' },
  { name: 'Mega Lopunny ex', id: 'mega-lopunny', featured: 'PFL-84', blurb: 'Gale Thrust hits for 230 when Mega Lopunny ex comes off the Bench. Dusknoir’s Cursed Blast and Mega Kangaskhan ex add damage and cards, and Bronzong jams evolutions.' },
  { name: 'Crustle', id: 'crustle', featured: 'DRI-12', blurb: 'Crustle takes no damage from Pokémon ex. Mist Energy and Spiky Energy protect it, Pokémon Center Lady and Jumbo Ice Cream heal it, and Eri strips Items from the opponent’s hand.' },
  { name: 'Basic Box', id: 'basic-box', featured: 'MEG-104', blurb: 'All Basic Pokémon ex: Mega Kangaskhan ex draws cards and hits for 200 and up, Teal Mask Ogerpon ex and Crispin pile on the Energy, and Iron Crown ex’s Twin Shotels picks off the Bench.' },
  { name: 'Mega Excadrill ex', id: 'mega-excadrill', featured: 'PBL-65', blurb: 'Metang’s Metal Maker digs Metal Energy out of the deck, so Mega Excadrill ex’s Maximum Drilling hits for 330. Mega Skarmory ex snipes and Team Rocket’s Watchtower shuts off Colorless Abilities.' },
  { name: 'Mega Lucario ex', id: 'mega-lucario', featured: 'MEG-77', blurb: 'Aura Jab recycles Fighting Energy onto the Bench, then Mega Brave hits for 270. Hariyama drags up a target as it evolves, and Premium Power Pro adds 30 damage.' },
  { name: 'Mega Sharpedo ex', id: 'mega-sharpedo', featured: 'PFL-61', blurb: 'Hungry Jaws does 270 once Mega Sharpedo ex has a damage counter on it: Toxtricity’s Sinister Surge and Pecharunt ex’s poison see to that, and Binding Mochi adds 40.' },
  { name: "Rocket's Honchkrow", id: 'rockets-honchkrow', featured: 'ASC-127', blurb: 'Team Rocket’s Honchkrow discards Team Rocket Supporters for 60 damage each. Ariana refills the hand, Giovanni drags up targets, and Team Rocket’s Energy counts double.' },
  { name: "Cynthia's Garchomp ex", id: 'cynthias-garchomp', featured: 'DRI-104', blurb: 'Draconic Buster hits for 260, and each Cynthia’s Roserade adds 30 more. Gabite searches the line, Corkscrew Dive refills the hand and Rocky Fighting Energy blocks attack effects.' },
  { name: 'Mew Box', id: 'mew-box', featured: '30C-66', blurb: 'A box of Pokémon ex built around Mew ex, with Mega Kangaskhan ex, Jirachi ex’s Wish Granter and Koraidon ex’s revenge hits. Area Zero Underdepths gives room for all of them.' },
  { name: "Marnie's Grimmsnarl ex", id: 'marnies-grimmsnarl', featured: 'DRI-136', blurb: 'Punk Up attaches 5 Darkness Energy as Grimmsnarl ex evolves, then Shadow Bullet hits for 180 and 30 on the Bench. Froslass puts a damage counter on every Pokémon with an Ability each turn.' },
  { name: "Hop's Trevenant", id: 'hops-trevenant', featured: 'ASC-96', blurb: 'Every Hop’s Pokémon hits harder with Postwick, Hop’s Choice Band and Snorlax. Trevenant’s Horrifying Revenge does 160 after a Knock Out, and Dubwool drags up a target as it evolves.' },
  { name: 'Beedrill ex', id: 'beedrill', featured: 'CRI-3', blurb: 'Rumbling Bees does 110 damage for each Beedrill and Beedrill ex in play, so fill the Bench with Weedle. Forest of Vitality lets them evolve the turn they come into play, and Kakuna takes 20 less damage.' },
  { name: 'Mega Venusaur ex', id: 'mega-venusaur', featured: 'MEG-3', blurb: 'Solar Transfer moves Grass Energy around as often as you like, and Jungle Dump hits for 240 and heals. Meganium makes every Grass Energy count twice, and Mega Meganium ex grows with each one.' },
  { name: 'Yanmega ex', id: 'yanmega', featured: 'DRI-3', blurb: 'Yanmega ex attaches 3 Grass Energy from the deck when it moves up from the Bench, then Jet Cyclone hits for 210 and passes the Energy on. Mega Kangaskhan ex draws cards, and Battle Cage keeps damage counters off the Bench.' },
  { name: "Steven's Metagross ex", id: 'stevens-metagross', featured: 'DRI-145', blurb: 'X-Boot attaches a Psychic and a Metal Energy from the deck every turn, powering Metal Stomp for 200, Deoxys’s Psyspear and Empoleon ex. Team Rocket’s Petrel and Transceiver find the pieces.' },
  { name: 'Archaludon ex', id: 'archaludon', featured: 'SSP-130', blurb: 'Archaludon ex attaches Metal Energy from the discard pile as it evolves, then Metal Defender hits for 220 and leaves it with no Weakness. N’s Zoroark ex draws cards, and Archaludon’s Metal Bridge lets everyone retreat for free.' },
  { name: "Hop's Zacian ex", id: 'hops-zacian', featured: 'JTG-111', blurb: 'Insta-Strike costs one Energy and hits the Active and the Bench; Postwick, Hop’s Choice Band and Snorlax add 30 each. Munkidori moves damage counters around and Cramorant cleans up at 3 or 4 Prizes.' },
  { name: 'Regidrago VSTAR', id: 'regidrago', featured: 'SIT-136', blurb: 'Apex Dragon uses the attack of any Dragon Pokémon in your discard pile: Dragapult ex’s Phantom Dive, Giratina VSTAR’s Lost Impact, Kyurem’s Trifrost. Teal Mask Ogerpon ex and Energy Switch power it up, and Legacy Star brings back two cards.' },
  { name: 'Giratina VSTAR', id: 'giratina', featured: 'LOR-131', blurb: 'Comfey and Colress’s Experiment fill the Lost Zone and Mirage Gate attaches the Energy, then Lost Impact hits for 280. With 10 cards in the Lost Zone, Star Requiem knocks out the Active Pokémon outright.' },
];

// what each deck attacks with, for the lobby's type filter: its main attackers' types, in order
const TYPES = {
  dragapult: ['Dragon'], charizard: ['Darkness'], gardevoir: ['Psychic'], 'raging-bolt': ['Dragon'], gholdengo: ['Metal'],
  miraidon: ['Lightning'], 'mega-absol': ['Darkness'], 'chien-pao': ['Water'], 'roaring-moon': ['Darkness'], 'lost-zone': ['Darkness', 'Colorless'],
  slowking: ['Water'], 'ns-zoroark': ['Darkness'], 'festival-lead': ['Water', 'Grass'], alakazam: ['Psychic'], hydrapple: ['Grass'],
  dhelmise: ['Grass', 'Psychic'], 'mega-lopunny': ['Colorless'], crustle: ['Grass'], 'basic-box': ['Colorless', 'Grass'], 'mega-excadrill': ['Metal'],
  'mega-lucario': ['Fighting'], 'mega-sharpedo': ['Darkness'], 'rockets-honchkrow': ['Darkness'], 'cynthias-garchomp': ['Fighting'], 'mew-box': ['Colorless', 'Psychic'],
  'marnies-grimmsnarl': ['Darkness'], 'hops-trevenant': ['Psychic', 'Metal'],
  beedrill: ['Grass'], 'mega-venusaur': ['Grass'], yanmega: ['Grass'], 'stevens-metagross': ['Metal'], archaludon: ['Metal', 'Darkness'],
  'hops-zacian': ['Metal'], regidrago: ['Dragon'], giratina: ['Dragon'],
};

// trait lists the card records don't carry
const TERA = new Set(['OBF-125', 'TWM-130', 'TWM-25', 'TWM-64', 'TWM-112', 'SSP-57', 'ASC-121']);
const ANCIENT = new Set(['Roaring Moon', 'Roaring Moon ex', 'Raging Bolt ex', 'Scream Tail', "Explorer's Guidance", "Professor Sada's Vitality", 'Ancient Booster Energy Capsule', 'Earthen Vessel']);
const FUTURE = new Set(['Iron Hands ex', 'Iron Bundle', 'Iron Leaves ex', 'Miraidon ex', 'Iron Crown ex']);
const ACE_SPEC = new Set(['Unfair Stamp', 'Secret Box', 'Prime Catcher', 'Sparkling Crystal', "Hero's Cape", 'Legacy Energy', 'Enriching Energy']);
// Special Energy that provides a type (Legacy Energy provides every type, one at a time)
const SPECIAL_PROVIDES = { 'Telepathic Psychic Energy': 'Psychic', 'Growing Grass Energy': 'Grass', 'Rocky Fighting Energy': 'Fighting', "Team Rocket's Energy": 'Darkness' };
// Special Energy that provides more than one Energy, each of one of these types (Team Rocket's Energy: 2, {P} or {D})
const PROVIDES_EITHER = { "Team Rocket's Energy": { units: 2, types: ['Psychic', 'Darkness'] } };
// ACE SPEC cards: the hand-kept list, and any card printed at ACE SPEC rarity
const isAce = c => ACE_SPEC.has(c.name) || /ACE SPEC/i.test(c.rarity || '');
const ANY_TYPE = new Set(['Legacy Energy']);
// Abilities the TCGdex records leave out (VSTAR Power Abilities)
const EXTRA_ABILITIES = {
  'SIT-136': [{ name: 'Legacy Star', text: 'During your turn, you may discard the top 7 cards of your deck. Then, put up to 2 cards from your discard pile into your hand. (You can\'t use more than 1 VSTAR Power in a game.)' }],
  'LOR-136': [{ name: 'Moisture Star', text: 'During your turn, you may heal all damage from this Pokémon. (You can\'t use more than 1 VSTAR Power in a game.)' }],
};
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
      abilities: [...(c.abilities || []).map(a => ({ name: a.name, text: clean(a.effect) })), ...(EXTRA_ABILITIES[key] || [])],
      attacks: (c.attacks || []).map(a => ({ name: a.name, cost: a.cost || [], damage: a.damage == null ? '' : String(a.damage), text: clean(a.effect) })),
      img,
    };
    // Pokémon V and VSTAR (Rule Box, 2 Prizes), Radiant Pokémon (Rule Box, 1 Prize)
    if (c.suffix === 'V' || / (?:V|VSTAR|VMAX)$/.test(c.name)) cards[key].v = true;
    if (c.stage === 'VSTAR') cards[key].vstar = true;
    if (/^Radiant /.test(c.name)) cards[key].radiant = true;
  } else if (c.category === 'Trainer') {
    cards[key] = { key, name: c.name, cat: 'T', trainer: c.trainerType, text: clean(c.effect), ancient: ANCIENT.has(c.name), ace: isAce(c), img };
    if (c.attacks) cards[key].attacks = c.attacks.map(a => ({ name: a.name, cost: a.cost || [], damage: a.damage == null ? '' : String(a.damage), text: clean(a.effect) }));
  } else {
    cards[key] = { key, name: c.name, cat: 'E', energy: 'Special', provides: SPECIAL_PROVIDES[c.name] || 'Colorless', text: clean(c.effect), img };
    if (ANY_TYPE.has(c.name)) cards[key].anyType = true;
    if (isAce(c)) cards[key].ace = true;
    if (PROVIDES_EITHER[c.name]) cards[key].either = PROVIDES_EITHER[c.name];
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
  // the deck's Energy types: Basic Energy, then Special Energy that provides a type
  const energyTypes = [...new Set([...counts.keys()].map(k => cards[k]).filter(c => c.cat === 'E' && (c.energy === 'Basic' || (c.provides !== 'Colorless' && !c.anyType))).sort((a, b) => (a.energy !== 'Basic') - (b.energy !== 'Basic')).map(c => c.provides))];
  if (!TYPES[d.id]) throw new Error('no types for ' + d.id);
  decks.push({ id: d.id, name: d.name, featured: d.featured, blurb: d.blurb, list: archetype || d.name, player: player || '', source: `https://limitlesstcg.com/decks/list/${l.list}`, types: TYPES[d.id], energy: energyTypes, cards: [...counts] });
}
if (!cards[DECKS[0].featured]) throw new Error('featured card missing');
fs.mkdirSync('data/ptcg', { recursive: true });
fs.writeFileSync('data/ptcg/cards.json', JSON.stringify(cards));
fs.writeFileSync('data/ptcg/decks.json', JSON.stringify(decks));
console.log(`${Object.keys(cards).length} cards, ${decks.length} decks`);
