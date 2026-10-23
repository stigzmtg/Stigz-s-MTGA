// Mana-source audit: every permanent card and token with a mana ability is put onto the battlefield and
// tapped by hand the way the table does it (manaSourcesFor with no options, then activateManaAbility).
// Unrestricted sources must be offered and must add mana; restricted ones (Powerstones, "spend this mana
// only to cast creature spells") must not be offered for tapping by hand.
// Usage: node tools/manacheck.mjs [--verbose] [--card=Name]
import fs from 'node:fs';
import { setup } from './lib/testkit.mjs';
import { manaSourcesFor, manaAbilitiesOf, activateManaAbility, parseCost, producedUnits } from '../src/engine/abilities.js';

const flags = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const cards = JSON.parse(fs.readFileSync('data/cards.json', 'utf8'));
const tokens = JSON.parse(fs.readFileSync('data/tokens.json', 'utf8'));

const subjects = [];
for (const [name, text] of Object.entries(cards)) if (/AB\$ Mana\b/.test(text.split('\nALTERNATE')[0])) subjects.push({ name, token: false });
for (const [script, text] of Object.entries(tokens)) if (/AB\$ Mana\b/.test(text)) subjects.push({ name: script, token: true });
const only = flags.card ? String(flags.card).toLowerCase() : null;

const out = { checked: 0, ok: 0, restricted: 0, conditional: 0, failures: [], neverSpendable: [] };
// one of each nonland card in the precons, as spells to spend restricted mana on (made once per game)
const deckNames = [...new Set(JSON.parse(fs.readFileSync('data/decks.json', 'utf8')).flatMap(d => [...d.cards.map(c => c[0]), ...d.commanders]))];
const pools = new WeakMap();
function spellPool(game) {
  if (!pools.has(game)) pools.set(game, deckNames.map(n => game.db.get(n)).filter(d => d && !d.faces[0].types.includes('Land')).map(d => { const c = game.newCard(d, 0); c.zone = 'hand'; return c; }));
  return pools.get(game);
}
const failure = (name, why) => { out.failures.push(`${name}: ${why}`); if (flags.verbose) console.log(`FAIL ${name}: ${why}`); };

for (const s of subjects) {
  if (only && !s.name.toLowerCase().includes(only)) continue;
  const T = await setup();
  const { game } = T;
  let card;
  if (s.token) {
    const def = T.game.db.token(s.name);
    if (!def) continue;
    card = await game.createToken(def, 0, null);
  } else {
    const def = T.game.db.get(s.name);
    if (!def) continue;
    const f = def.faces[0];
    if (f.types.includes('Instant') || f.types.includes('Sorcery')) continue;
    card = await T.put(0, s.name);
  }
  if (!card || card.zone !== 'battlefield') continue;
  await T.resolve();
  if (card.zone !== 'battlefield') continue;
  card.sick = false; card.tapped = false; // (enters-tapped lands: test the tap itself)
  game.touch();
  T.noMana(0);
  out.checked++;
  const abils = manaAbilitiesOf(game, card).filter(a => a.parsed.kind === 'AB');
  if (!abils.length) continue;
  // filter abilities ({1},{T}: ...) get mana to work with
  if (abils.some(a => parseCost(a.parsed.p.Cost).hasMana)) T.mana(0, 3);
  const listed = manaSourcesFor(game, 0).filter(x => x.card === card);
  // restricted mana ("spend this mana only to cast creature spells", Powerstones) is never tapped by hand,
  // but the spells and abilities it allows can spend it, and it doesn't pay for everything
  for (const a of abils.filter(a => a.parsed.p.RestrictValid)) {
    const p = a.parsed.p;
    out.restricted++;
    if (listed.some(x => x.abil.key === a.key)) failure(s.name, `restricted mana (${p.RestrictValid}) is offered for tapping by hand`);
    if (/ChosenType/.test(p.RestrictValid) && !card.chosen?.type) card.chosen = { ...card.chosen, type: 'Human' };
    if (/ChosenColor/.test(p.RestrictValid) && !card.chosen?.colors) card.chosen = { ...card.chosen, colors: ['G'] };
    const offeredFor = opts => manaSourcesFor(game, 0, opts).some(x => x.card === card && x.abil.key === a.key);
    const pool = spellPool(game);
    let spells = pool.filter(sp => offeredFor({ spellCard: sp })).length;
    const spellsInHand = spells;
    // "cast from your graveyard", "spells you don't own"
    for (const [k, v] of [['zone', 'graveyard'], ['owner', 1]]) if (!spells) { for (const sp of pool) sp[k] = v; spells = pool.filter(sp => offeredFor({ spellCard: sp })).length; for (const sp of pool) { sp.zone = 'hand'; sp.owner = 0; } }
    for (const h of pool) h.zone = 'battlefield';
    const abilities = pool.filter(h => offeredFor({ abilityHost: h, costHasX: true })).length;
    for (const h of pool) h.zone = 'hand';
    const amountOk = !p.Amount || /^\d+$/.test(p.Amount) || producedUnits(game, card, a).length > 0;
    if (flags.verbose) console.log(`  restricted ${s.name} (${p.RestrictValid}): ${spells} spells, ${abilities} ability hosts of ${pool.length}`);
    const cost = parseCost(p.Cost);
    const conditional = p.IsPresent || p.Planeswalker || cost.parts.some(pt => pt.type === 'Sac' && !/^(CARDNAME|Card\.Self)$/.test(pt.valid || ''));
    if (!spells && !abilities && amountOk && !conditional) out.neverSpendable.push(`${s.name} (${p.RestrictValid})`);
    if (spellsInHand === pool.length && p.RestrictValid !== 'Spell') failure(s.name, `restricted mana (${p.RestrictValid}) pays for any spell`);
  }
  let good = false;
  for (const a of abils) {
    const p = a.parsed.p;
    const cost = parseCost(p.Cost);
    const restricted = !!p.RestrictValid;
    const sacOther = cost.parts.some(pt => pt.type === 'Sac' && !/^(CARDNAME|Card\.Self)$/.test(pt.valid || ''));
    const conditional = !!(p.IsPresent || p.CheckSVar || p.Condition || p.ConditionPresent || p.ActivationLimit || p.ActivationZone || (p.Amount && !/^\d+$/.test(p.Amount)) || cost.untap || sacOther || cost.parts.some(pt => pt.type !== 'Sac' && pt.type !== 'PayLife'));
    const src = listed.find(x => x.abil.key === a.key);
    if (restricted) continue;
    if (!src) {
      if (conditional) { out.conditional++; continue; }
      failure(s.name, `"${(p.SpellDescription || p.Produced || '').slice(0, 60)}" isn't offered as a mana source`);
      continue;
    }
    const before = Object.values(game.players[0].pool).reduce((x, y) => x + y, 0) - (cost.hasMana ? 0 : 0);
    const spent = cost.hasMana ? Object.values(cost.mana.colored).reduce((x, y) => x + y, 0) + cost.mana.generic + cost.mana.hybrid.length : 0;
    let ok = false;
    try { ok = await activateManaAbility(game, 0, card, a.key, src.units[0][0]); } catch (e) { failure(s.name, `activating threw ${e.message}`); continue; }
    if (!ok) { failure(s.name, `offered but activateManaAbility returned false (${p.Produced})`); continue; }
    const after = Object.values(game.players[0].pool).reduce((x, y) => x + y, 0);
    if (after - before + spent <= 0) failure(s.name, `activated but no mana was added (${p.Produced})`);
    if (cost.tap && card.zone === 'battlefield' && !card.tapped) failure(s.name, 'tapped for mana but not tapped');
    if (cost.parts.some(pt => pt.type === 'Sac' && /^(CARDNAME|Card\.Self)$/.test(pt.valid || '')) && card.zone === 'battlefield') failure(s.name, 'sacrifice-for-mana left it on the battlefield');
    good = true;
    break;
  }
  if (good) out.ok++;
}
console.log(`${out.checked} mana permanents/tokens checked: ${out.ok} tapped by hand fine, ${out.restricted} restricted abilities (not offered by hand; spendable where allowed), ${out.conditional} conditional abilities skipped, ${out.failures.length} failures`);
for (const f of out.failures.slice(0, 80)) console.log('  ' + f);
if (out.neverSpendable.length) console.log(`restricted mana never spendable (rules not implemented): ${out.neverSpendable.join(', ')}`);
process.exit(out.failures.length ? 1 : 0);
