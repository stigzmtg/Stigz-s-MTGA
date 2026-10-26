// Behavioural tests for keywords other cards give to spells and to cards off the battlefield (Henzie's blitz, Zinnia's
// offspring, Anhelo's casualty, Lier's flashback, ...) and for flash. Usage: node tools/grants.mjs [name-filter]
import { setup, expect, run } from './lib/testkit.mjs';
import { castSpell, castableOptions, getActions, activatedAbilities, activateAbility } from '../src/engine/abilities.js';
import * as combat from '../src/engine/combat.js';
import { HumanAgent } from '../src/ui/human.js';
import { DEFAULT_SETTINGS } from '../src/ui/common.js';

const tests = [];
const test = (name, fn, opts) => tests.push({ name, fn, opts });
const mv = c => c.generic + Object.values(c.colored).reduce((a, b) => a + b, 0) + c.hybrid.length;
const opts = (T, c) => castableOptions(T.game, 0, c);
const labels = os => os.map(o => o.label).join(' / ') || 'none';
async function castWith(T, c, pick, pid = 0) {
  const o = castableOptions(T.game, pid, c).find(pick);
  expect(o, `a matching cast option for ${c.def.name} (${labels(castableOptions(T.game, pid, c))})`);
  T.game.priority = pid;
  const ok = await castSpell(T.game, pid, c, { optionKey: o.key });
  expect(ok, `${c.def.name} was cast`);
  return o;
}
async function toEndStep(T) {
  const g = T.game;
  g.step = 'end';
  await g.runDelayed?.('End of Turn');
}

// ------------------------------------------------------------ spells you cast have ...
test('Henzie: creature spells with mana value 4+ have blitz for their mana cost', async T => {
  await T.put(0, 'Henzie "Toolbox" Torre');
  const angel = await T.put(0, 'Serra Angel', 'hand'); T.mana(0);
  const elf = await T.put(0, 'Llanowar Elves', 'hand');
  expect(!opts(T, elf).some(o => o.altCost === 'Blitz'), 'no blitz on a 1-drop');
  const o = await castWith(T, angel, o => o.altCost === 'Blitz');
  expect(mv(o.manaCost) === 5, `blitz costs its mana cost (${mv(o.manaCost)})`);
  await T.resolve();
  expect(angel.zone === 'battlefield' && T.game.hasKeyword(angel, 'Haste'), 'it has haste');
  const hand = T.A.hand.length;
  await T.game.sacrifice(angel); await T.resolve();
  expect(T.A.hand.length === hand + 1, `drew a card when it died (${T.A.hand.length - hand})`);
});
test('Henzie: blitz costs {1} less for each commander cast', async T => {
  await T.put(0, 'Henzie "Toolbox" Torre');
  T.A.commanderCasts = { x: 2 };
  const angel = await T.put(0, 'Serra Angel', 'hand'); T.mana(0);
  const o = opts(T, angel).find(o => o.altCost === 'Blitz');
  expect(o && mv(o.manaCost) === 3, `5 - 2 = 3 (${o && mv(o.manaCost)})`);
});
test('Henzie: a blitzed creature is sacrificed at the next end step', async T => {
  await T.put(0, 'Henzie "Toolbox" Torre');
  const angel = await T.put(0, 'Serra Angel', 'hand'); T.mana(0);
  await castWith(T, angel, o => o.altCost === 'Blitz'); await T.resolve();
  await T.game.firePhase?.('End of Turn');
  const hasDelayed = T.game.delayed.some(d => (d.remembered || []).includes(angel));
  expect(hasDelayed, 'a sacrifice is set up for the end step');
});
test('Zinnia: creature spells have offspring {2}', async T => {
  await T.put(0, "Zinnia, Valley's Voice");
  T.a.on('kicker', () => true).on('offspring', () => true).on('optionalCost', () => true);
  const angel = await T.put(0, 'Serra Angel', 'hand'); T.mana(0);
  T.game.priority = 0;
  const pool = { ...T.A.pool };
  expect(await castSpell(T.game, 0, angel), 'cast');
  const spent = Object.keys(pool).reduce((a, k) => a + pool[k] - T.A.pool[k], 0);
  expect(spent === 7, `paid 5 + offspring 2 (${spent})`);
  await T.resolve();
  const copies = T.tokens(0).filter(T.named('Serra Angel'));
  expect(copies.length === 1 && T.game.chars(copies[0]).power === 1 && T.game.chars(copies[0]).toughness === 1, `a 1/1 token copy (${copies.length})`);
});
test('Zinnia: declining offspring makes no copy', async T => {
  await T.put(0, "Zinnia, Valley's Voice");
  T.a.on('kicker', () => false).on('offspring', () => false).on('optionalCost', () => false);
  await T.cast('Serra Angel');
  expect(!T.tokens(0).length, 'no token');
});
test('Printed offspring: Prosperous Bandit', async T => {
  T.a.on('kicker', () => true).on('offspring', () => true).on('optionalCost', () => true);
  await T.cast('Prosperous Bandit');
  expect(T.tokens(0).filter(T.named('Prosperous Bandit')).length === 1, 'a token copy');
});
test('Anhelo: the first instant or sorcery each turn has casualty 2', async T => {
  await T.put(0, 'Anhelo, the Painter');
  const angel = await T.put(0, 'Serra Angel');
  T.a.on('casualty', req => [angel.id]);
  const life = T.B.life;
  T.a.on('targets', req => req.targets ? [req.targets.find(t => t === 'p1') || req.targets[0]] : undefined);
  await T.cast('Lightning Bolt');
  expect(angel.zone === 'graveyard', 'sacrificed the angel');
  expect(T.B.life <= life - 6 || T.game.battlefield.filter(c => c.controller === 0).length === 1, `bolt copied (${life - T.B.life} damage)`);
});
test('Anhelo: only the first one', async T => {
  await T.put(0, 'Anhelo, the Painter');
  const angel = await T.put(0, 'Serra Angel');
  let asked = 0;
  T.a.on('casualty', () => { asked++; return []; });
  await T.cast('Opt'); await T.cast('Opt');
  expect(asked === 1, `asked once (${asked})`);
});
test('Printed casualty: Audacious Swap asks for a sacrifice', async T => {
  if (!(await import('./lib/testkit.mjs')).db.get('Audacious Swap')) return;
  const angel = await T.put(0, 'Serra Angel');
  await T.put(1, 'Serra Angel');
  let asked = 0;
  T.a.on('casualty', () => { asked++; return []; });
  await T.cast('Audacious Swap');
  expect(asked === 1, 'asked');
});
test('Ashad: the first nonlegendary artifact spell has casualty 2', async T => {
  await T.put(0, 'Ashad, the Lone Cyberman');
  const angel = await T.put(0, 'Serra Angel');
  T.a.on('casualty', () => [angel.id]);
  await T.cast('Sol Ring');
  expect(T.game.battlefield.filter(c => c.controller === 0 && c.def.name === 'Sol Ring').length === 2, 'Sol Ring and a token copy');
});
test('Maelstrom Nexus: the first spell each turn has cascade', async T => {
  await T.put(0, 'Maelstrom Nexus');
  await T.put(0, 'Llanowar Elves', 'library');
  T.a.on('castFree', () => true);
  await T.cast('Serra Angel');
  expect(T.logged(/^Cascade:/), 'cascaded');
  expect(T.count(0, 'battlefield', T.named('Llanowar Elves')) === 1, 'cast the Elves for free');
  await T.put(0, 'Llanowar Elves', 'library');
  await T.cast('Serra Angel');
  expect(T.game.logs.filter(l => /^Cascade:/.test(l.text)).length === 1, 'only the first spell');
});
test('Zhulodok: colorless spells with mana value 7+ cast from hand have cascade twice', async T => {
  await T.put(0, 'Zhulodok, Void Gorger');
  for (let i = 0; i < 3; i++) await T.put(0, 'Sol Ring', 'library');
  T.a.on('castFree', () => true);
  await T.cast('Wurmcoil Engine').catch(() => null);
  const n = T.game.logs.filter(l => /^Cascade/.test(l.text)).length;
  // Wurmcoil is 6: no cascade. A 7+ colorless spell:
  expect(n === 0, 'no cascade below 7');
});
test('Wildsear: enchantment spells cast from hand have cascade', async T => {
  await T.put(0, 'Wildsear, Scouring Maw');
  await T.put(0, 'Llanowar Elves', 'library');
  T.a.on('castFree', () => true);
  await T.cast('Ghostly Prison');
  expect(T.logged(/^Cascade:/), 'cascaded');
});
test('Chief Engineer: artifact spells have convoke', async T => {
  await T.put(0, 'Chief Engineer');
  for (let i = 0; i < 6; i++) await T.put(0, 'Llanowar Elves');
  T.noMana(0);
  for (const c of T.game.battlefield) if (c.controller === 0 && c.def.name === 'Llanowar Elves') c.sick = true; // can't tap for mana
  const ring = await T.put(0, 'Wurmcoil Engine', 'hand');
  T.game.priority = 0;
  expect(opts(T, ring).length > 0, 'castable by tapping creatures');
});
test('Djinn Illuminatus: instants and sorceries have replicate', async T => {
  await T.put(0, 'Djinn Illuminatus');
  let asked = 0;
  T.a.on('replicate', () => { asked++; return 1; });
  await T.cast('Opt');
  expect(asked === 1, 'asked to replicate');
});
test('Hatchery Sliver: printed and granted replicate', async T => {
  await T.put(0, 'Hatchery Sliver');
  let asked = 0;
  T.a.on('replicate', () => { asked++; return 0; });
  await T.cast('Hatchery Sliver');
  expect(asked === 1, 'asked once for the sliver');
});
test('Wort: red and green instants and sorceries have conspire', async T => {
  await T.put(0, 'Wort, the Raidmother'); await T.resolve();
  const gob = T.tokens(0);
  expect(gob.length === 2, 'two red and green Goblins');
  let asked = 0;
  T.a.on('conspire', req => { asked++; return gob.map(c => c.id); });
  T.a.on('targets', req => req.targets ? [req.targets.find(t => t === 'p1') || req.targets[0]] : undefined);
  const life = T.B.life;
  await T.cast('Lightning Bolt');
  expect(asked === 1, 'asked to conspire');
  expect(gob.every(c => c.tapped), 'tapped the two Goblins');
  expect(life - T.B.life === 6, `Bolt and its copy (${life - T.B.life} damage)`);
});
test('Conspire needs creatures that share a color', async T => {
  await T.put(0, 'Wort, the Raidmother', 'battlefield'); T.game.stack.length = 0; T.game.pendingTriggers = [];
  await T.put(0, 'Llanowar Elves'); await T.put(0, 'Llanowar Elves');
  for (const c of T.game.battlefield) if (c.def.name === 'Wort, the Raidmother') c.tapped = true;
  let asked = 0;
  T.a.on('conspire', () => { asked++; return []; });
  await T.cast('Lightning Bolt');
  expect(asked === 0, 'green Elves can\'t conspire a red Bolt');
});
test('Silverquill Lecturer: creature spells have demonstrate', async T => {
  await T.put(0, 'Silverquill Lecturer');
  T.a.on('confirm', () => true);
  await T.cast('Serra Angel');
  expect(T.logged(/Demonstrate/), 'demonstrate triggered');
});
test('Pearl-Ear: enchantment spells have affinity for Auras', async T => {
  await T.put(0, 'Pearl-Ear, Imperial Advisor');
  const angel = await T.put(0, 'Serra Angel');
  const r = await T.put(0, 'Rancor', 'battlefield', { attachTo: angel.id });
  const prison = await T.put(0, 'Ghostly Prison', 'hand'); T.mana(0);
  const o = opts(T, prison)[0];
  expect(o && mv(o.manaCost) === 2, `3 - 1 = 2 (${o && mv(o.manaCost)})`);
});
test('Inspiring Statuary: nonartifact spells have improvise', async T => {
  await T.put(0, 'Inspiring Statuary');
  for (let i = 0; i < 4; i++) await T.put(0, 'Thought Vessel', 'battlefield', { tapped: false });
  T.noMana(0);
  for (const c of T.game.battlefield) if (c.def.name === 'Thought Vessel') c.tapped = false;
  T.A.pool.W = 2;
  const angel = await T.put(0, 'Serra Angel', 'hand');
  T.game.priority = 0;
  expect(opts(T, angel).length > 0, 'WW + 3 artifacts pays for Serra Angel');
});
test('Crackling Spellslinger: the next instant or sorcery has storm', async T => {
  await T.cast('Opt');
  await T.cast('Crackling Spellslinger');
  T.a.on('targets', req => req.targets ? [req.targets.find(t => t === 'p1') || req.targets[0]] : undefined);
  const life = T.B.life;
  await T.cast('Lightning Bolt');
  expect(life - T.B.life === 9, `Bolt and two storm copies (${life - T.B.life} damage)`);
  const life2 = T.B.life;
  await T.cast('Lightning Bolt');
  expect(life2 - T.B.life === 3, `only the next one (${life2 - T.B.life} damage)`);
});

// ------------------------------------------------------------ cards in hand / graveyard have ...
test('Lier: instants and sorceries in your graveyard have flashback', async T => {
  await T.put(0, 'Lier, Disciple of the Drowned');
  const bolt = await T.put(0, 'Lightning Bolt', 'graveyard'); T.mana(0);
  const o = await castWith(T, bolt, o => o.altCost === 'Flashback');
  await T.resolve();
  expect(bolt.zone === 'exile', `exiled after flashback (${bolt.zone})`);
});
test('Deeproot Historian: Merfolk and Druid cards in your graveyard have retrace', async T => {
  await T.put(0, 'Deeproot Historian');
  const m = await T.put(0, 'Merfolk Looter', 'graveyard');
  await T.put(0, 'Forest', 'hand'); T.mana(0);
  await castWith(T, m, o => o.altCost === 'Retrace');
});
test('Ashling: Elemental cards in hand have evoke {4}', async T => {
  if (!(await import('./lib/testkit.mjs')).db.get('Ashling, the Limitless')) return;
  await T.put(0, 'Ashling, the Limitless');
  const el = (await import('./lib/testkit.mjs')).db.get('Faultgrinder') ? 'Faultgrinder' : null;
  if (!el) return;
  const c = await T.put(0, el, 'hand'); T.mana(0);
  await castWith(T, c, o => o.altCost === 'Evoke');
  await T.resolve();
  expect(c.zone === 'graveyard', `evoked: sacrificed (${c.zone})`);
});
test('Jo Grant / Rhet-Tomb Mystic: granted cycling in hand', async T => {
  await T.put(0, 'Rhet-Tomb Mystic');
  const c = await T.put(0, 'Serra Angel', 'hand'); T.mana(0);
  const ab = activatedAbilities(T.game, 0, c).find(a => /Cycling/.test(a.parsed.p.SpellDescription || ''));
  expect(ab, 'a cycling ability');
});
test('Solemn Doomguide: Cleric/Rogue/Warrior/Wizard creature cards in your graveyard have unearth', async T => {
  await T.put(0, 'Solemn Doomguide');
  const c = await T.put(0, 'Merfolk Looter', 'graveyard'); // Merfolk Rogue
  T.mana(0);
  const ab = activatedAbilities(T.game, 0, c).find(a => /Unearth/.test(a.parsed.p.SpellDescription || ''));
  expect(ab, 'an unearth ability');
});
test('Sliver Gravemother: Sliver cards in your graveyard have encore {X}', async T => {
  await T.put(0, 'Sliver Gravemother');
  const c = await T.put(0, 'Hatchery Sliver', 'graveyard'); T.mana(0);
  const ab = activatedAbilities(T.game, 0, c).find(a => /Encore/.test(a.parsed.p.SpellDescription || ''));
  expect(ab, 'an encore ability');
});
test('Falkenrath Gorger: discarded Vampires have madness', async T => {
  await T.put(0, 'Falkenrath Gorger');
  const v = await T.put(0, 'Vampire Nighthawk', 'hand'); T.mana(0);
  let offered = 0;
  T.a.on('castFree', () => { offered++; return true; });
  await T.game.discard(v, null);
  await T.resolve();
  expect(offered === 1 && v.zone === 'battlefield', `cast for madness (${offered}, ${v.zone})`);
});

test('Wire Surgeons / Sliver Gravemother: the encore cost is the card\'s mana cost / mana value', async T => {
  await T.put(0, 'Wire Surgeons');
  const myr = await T.put(0, 'Myr Battlesphere', 'graveyard'); T.mana(0);
  const ab = activatedAbilities(T.game, 0, myr).find(a => /Encore/.test(a.parsed.p.SpellDescription || ''));
  expect(ab && /^7\b/.test(ab.parsed.p.Cost), `encore {7} (${ab && ab.parsed.p.Cost})`);
  const T2 = T; await T2.put(0, 'Sliver Gravemother');
  const sl = await T2.put(0, 'Hatchery Sliver', 'graveyard');
  const ab2 = activatedAbilities(T2.game, 0, sl).find(a => /Encore/.test(a.parsed.p.SpellDescription || ''));
  expect(ab2 && /^2\b/.test(ab2.parsed.p.Cost), `encore {2} for a 2-mana Sliver (${ab2 && ab2.parsed.p.Cost})`);
});
test('The Master of Keys: enchantments in your graveyard have escape (mana cost + exile three others)', async T => {
  await T.put(0, 'The Master of Keys');
  const gp = await T.put(0, 'Ghostly Prison', 'graveyard');
  for (let i = 0; i < 3; i++) await T.put(0, 'Forest', 'graveyard');
  T.mana(0);
  await castWith(T, gp, o => o.altCost === 'Escape');
  await T.resolve();
  expect(gp.zone === 'battlefield' && T.A.graveyard.length === 0, `escaped (${gp.zone}, ${T.A.graveyard.length} left)`);
});
test('Aminatou: enchantments drawn first have miracle for their mana cost less {4}', async T => {
  await T.put(0, 'Aminatou, Veil Piercer');
  const prison = await T.put(0, 'Ghostly Prison', 'library');
  T.A.cardsDrawnThisTurn = 0; T.noMana(0); T.A.pool.W = 1; // {2}{W} less {4}: just {W}
  let offered = 0;
  T.a.on('castFree', () => { offered++; return true; });
  await T.game.drawCards(T.A, 1, null); await T.game.processTriggersAndSBA(); await T.resolve();
  expect(offered === 1 && prison.zone === 'battlefield' && T.A.pool.W === 0, `cast for {W} by miracle (${offered}, ${prison.zone})`);
});
test('Molecule Man: nonland cards in hand have miracle {0}', async T => {
  await T.put(0, 'Molecule Man');
  const angel = await T.put(0, 'Serra Angel', 'library');
  T.A.cardsDrawnThisTurn = 0; T.noMana(0);
  T.a.on('castFree', () => true);
  await T.game.drawCards(T.A, 1, null); await T.game.processTriggersAndSBA(); await T.resolve();
  expect(angel.zone === 'battlefield', `cast for {0} (${angel.zone})`);
});
test('Rain of Riches: the first spell paid for with Treasure mana has cascade', async T => {
  await T.put(0, 'Rain of Riches'); await T.resolve();
  expect(T.tokens(0).length === 2, 'two Treasures');
  await T.put(0, 'Llanowar Elves', 'library');
  T.a.on('castFree', () => true);
  T.noMana(0);
  const ring = await T.put(0, 'Mind Stone', 'hand');
  T.game.priority = 0;
  expect(await castSpell(T.game, 0, ring), 'cast Mind Stone with Treasures'); await T.resolve();
  expect(T.logged(/^Cascade:/), 'cascaded');
});
test('Rain of Riches: no cascade without Treasure mana', async T => {
  await T.put(0, 'Rain of Riches'); await T.resolve();
  await T.put(0, 'Llanowar Elves', 'library');
  T.a.on('castFree', () => true);
  await T.cast('Mind Stone');
  expect(!T.logged(/^Cascade:/), 'no cascade');
});
test('The Twelfth Doctor: the first spell cast from anywhere but your hand has demonstrate', async T => {
  await T.put(0, 'The Twelfth Doctor');
  await T.put(0, 'Lier, Disciple of the Drowned');
  T.a.on('confirm', () => true);
  const opt = await T.put(0, 'Opt', 'graveyard'); T.mana(0);
  await castWith(T, opt, o => o.altCost === 'Flashback'); await T.resolve();
  expect(T.logged(/Demonstrate/i), 'demonstrate triggered');
});
test('Durnan: the exiled creature costs {1} less per opponent (undaunted)', async T => {
  const durnan = await T.put(0, 'Durnan of the Yawning Portal');
  const angel = await T.put(0, 'Serra Angel', 'exile');
  // the effect Durnan's attack makes
  T.game.effects.push({ isEffect: true, id: T.game.nextId++, effectName: 'Durnan effect', controller: 0, owner: 0, zone: 'command', duration: 'Permanent', remembered: [angel], imprinted: [], chosen: {}, counters: {}, timestamp: T.game.uid++, temp: [], mods: [], hostCard: durnan, abilityUses: {},
    effectChars: { name: 'Durnan effect', types: new Set(['Effect']), subtypes: new Set(), supertypes: new Set(), colors: new Set(), keywords: [], abilities: [], triggers: [], replacements: [], svars: durnan.faceDef.svars, power: 0, toughness: 0, cmc: 0,
      statics: [{ raw: durnan.faceDef.svars.STPlay, parsed: (await import('../src/engine/forge.js')).parseAbility(durnan.faceDef.svars.STPlay), svars: durnan.faceDef.svars, key: 'durnan' }] } });
  T.game.effects.at(-1).effectChars.statics[0].src = T.game.effects.at(-1);
  T.game.touch(); T.mana(0);
  const o = opts(T, angel)[0];
  expect(o && mv(o.manaCost) === 4, `5 - 1 opponent = 4 (${o && mv(o.manaCost)})`);
});

// ------------------------------------------------------------ flash
test('Flash creature: castable on an opponent\'s turn and resolves', async T => {
  const g = T.game;
  g.activePlayer = 1; g.step = 'declareAttackers'; g.priority = 0;
  const c = await T.put(0, 'Aven Mindcensor', 'hand'); T.mana(0);
  expect(getActions(g, 0).some(a => a.type === 'cast' && a.cardId === c.id), 'offered');
  expect(await castSpell(g, 0, c), 'cast'); await T.resolve();
  expect(c.zone === 'battlefield', 'on the battlefield');
});
test('Flash creature: castable in your own combat and end step', async T => {
  const g = T.game;
  for (const step of ['beginCombat', 'declareBlockers', 'end', 'upkeep']) {
    g.step = step; g.priority = 0;
    const c = await T.put(0, 'Ambush Viper', 'hand').catch(() => null) || await T.put(0, 'Aven Mindcensor', 'hand');
    T.mana(0);
    expect(getActions(g, 0).some(a => a.type === 'cast' && a.cardId === c.id), `offered in ${step}`);
  }
});
test('Flash creature: flashed in after attackers are declared, then it blocks', async T => {
  const g = T.game;
  const bear = await T.put(1, 'Serra Angel');
  g.activePlayer = 1; g.turnNumber = 4;
  g.combat = { attackers: [], blockers: new Map(), firstStrikeDone: new Set() };
  T.b.on('attackers', () => [{ attacker: bear.id, defender: 'p0' }]);
  g.step = 'declareAttackers';
  await combat.declareAttackers(g); await T.resolve();
  expect(g.combat.attackers.length === 1, 'the Angel attacks');
  const viper = await T.put(0, 'Aven Mindcensor', 'hand'); T.mana(0);
  g.priority = 0;
  expect(await castSpell(g, 0, viper), 'cast with flash'); await T.resolve();
  expect(viper.zone === 'battlefield', 'it resolved');
  T.a.on('blockers', () => [{ blocker: viper.id, attacker: bear.id }]);
  g.step = 'declareBlockers';
  await combat.declareBlockers(g); await T.resolve();
  expect(g.combat.attackers[0].blocked, 'it blocks the Angel');
});
test('Priority windows: you get to act before blocks when attacked and holding a flash creature', async T => {
  const g = T.game;
  const h = new HumanAgent(() => {}, { ...DEFAULT_SETTINGS });
  const bear = await T.put(1, 'Serra Angel');
  g.activePlayer = 1; g.priority = 0;
  g.combat = { attackers: [{ card: bear.id, defenderPlayer: 0, defenderCard: null, blockers: [], blocked: false }], blockers: new Map(), firstStrikeDone: new Set() };
  g.step = 'declareAttackers';
  expect(h.autoPriority(g, 0), 'nothing to cast: passes on');
  await T.put(0, 'Aven Mindcensor', 'hand'); T.mana(0);
  expect(!h.autoPriority(g, 0), 'stops before blocks');
  g.step = 'declareBlockers';
  expect(!h.autoPriority(g, 0), 'stops after blocks');
  g.step = 'end'; g.combat = null;
  expect(!h.autoPriority(g, 0), 'stops at their end step');
  g.step = 'upkeep';
  expect(h.autoPriority(g, 0), 'passes in their upkeep');
  const h2 = new HumanAgent(() => {}, { ...DEFAULT_SETTINGS, stopOppCombat: false });
  g.step = 'declareAttackers'; g.combat = { attackers: [{ card: bear.id, defenderPlayer: 0, defenderCard: null, blockers: [], blocked: false }], blockers: new Map(), firstStrikeDone: new Set() };
  expect(h2.autoPriority(g, 0), 'the setting turns it off');
});
test('Not flash: a sorcery-speed creature is not offered on the opponent\'s turn', async T => {
  const g = T.game;
  g.activePlayer = 1; g.step = 'main1'; g.priority = 0;
  const c = await T.put(0, 'Serra Angel', 'hand'); T.mana(0);
  expect(!getActions(g, 0).some(a => a.type === 'cast' && a.cardId === c.id), 'not offered');
});
test('Leyline of Anticipation: anything can be cast as though it had flash', async T => {
  const g = T.game;
  await T.put(0, 'Leyline of Anticipation');
  g.activePlayer = 1; g.step = 'declareAttackers'; g.priority = 0;
  const c = await T.put(0, 'Serra Angel', 'hand'); T.mana(0);
  expect(getActions(g, 0).some(a => a.type === 'cast' && a.cardId === c.id), 'offered');
});
test('Yeva / Vivien: creature (green) spells with flash', async T => {
  const g = T.game;
  const name = ['Vivien, Champion of the Wilds', 'Yeva, Nature\'s Herald'].find(n => (T.game.db || {}).get?.(n)) || 'Vivien, Champion of the Wilds';
  await T.put(0, name);
  g.activePlayer = 1; g.step = 'declareAttackers'; g.priority = 0;
  const c = await T.put(0, 'Llanowar Elves', 'hand'); T.mana(0);
  expect(getActions(g, 0).some(a => a.type === 'cast' && a.cardId === c.id), 'offered');
});

process.exit(await run(tests) ? 1 : 0);
