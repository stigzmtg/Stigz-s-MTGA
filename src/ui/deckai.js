// The deck helper: an assistant for building Commander decks that runs right in the page (no account and no server,
// so it works offline and on school Wi-Fi). It reads every card's rules text for the job it does in a deck (ramp,
// card draw, removal, ...) and the plans it belongs to (tokens, +1/+1 counters, a creature type, ...), reads the
// commander the same way, and scores each legal card for the deck: does it fit the commander's plan, fill a job the
// deck is short on, show up in many precons (or in this commander's own precon), cost a sensible amount.
import { BASICS } from './customdecks.js';

const COLORS = ['W', 'U', 'B', 'R', 'G'];
const BASIC_FOR = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' };
const BANNED = new Set(['Mana Crypt', 'Jeweled Lotus', 'Dockside Extortionist', 'Nadu, Winged Wisdom', 'Paradox Engine', 'Primeval Titan', 'Prophet of Kruphix', 'Recurring Nightmare', 'Sylvan Primordial', 'Biorhythm', 'Coalition Victory', 'Emrakul, the Aeons Torn', 'Fastbond', 'Flash', 'Golos, Tireless Pilgrim', 'Griselbrand', 'Hullbreacher', 'Iona, Shield of Emeria', 'Leovold, Emissary of Trest', 'Limited Resources', 'Lutri, the Spellchaser', 'Panoptic Mirror', 'Rofellos, Llanowar Emissary', 'Sundering Titan', 'Sway of the Stars', 'Tinker', 'Tolarian Academy', 'Trade Secrets', 'Upheaval', 'Worldfire', "Yawgmoth's Bargain", 'Channel', 'Erayo, Soratami Ascendant', 'Gifts Ungiven', 'Karakas', 'Braids, Cabal Minion', 'Black Lotus', 'Ancestral Recall', 'Time Walk', 'Timetwister', 'Library of Alexandria', 'Balance', 'Shahrazad', 'Chaos Orb', 'Falling Star']);

// ---- what a card does in a deck
export const ROLES = { ramp: 'Ramp', draw: 'Card draw', removal: 'Removal', wipe: 'Board wipe', counter: 'Counterspell', tutor: 'Tutor', protect: 'Protection', recursion: 'Recursion' };
// what each job means, for players new to building decks (the checklist and the card details show these)
export const ROLE_HELP = {
  land: 'Lands make your mana. Too few and you get stuck with cards you can’t cast; too many and you run out of things to do. Most Commander decks play 35 to 38.',
  ramp: 'Ramp gives you extra mana early: mana rocks, creatures that tap for mana, spells that fetch lands. Your big cards come down turns sooner.',
  draw: 'Card draw keeps your hand full. Games with three opponents run long, and the player who runs out of cards first falls behind.',
  removal: 'Removal answers one threat: the creature or card that’s about to beat you. Cheap removal is the best kind.',
  wipe: 'Board wipes clear lots of creatures at once. They’re how you come back when everyone else is ahead on the board.',
  counter: 'Counterspells stop a spell before it happens. Blue decks often keep one or two ready for the scariest spells.',
  tutor: 'Tutors find a specific card in your deck, so your best card shows up more often.',
  protect: 'Protection keeps your commander or key creatures alive through removal.',
  recursion: 'Recursion brings cards back from your graveyard, so a destroyed card isn’t gone for good.',
  plan: 'Cards that do what your commander wants. The more you run, the more often your plan actually happens.',
  creatures: 'Creatures attack, block and win most games. Decks built around spells run fewer.',
};
const LANDISH = /^(?:basic |snow )*(?:land|lands|forest|plains|island|swamp|mountain|basic)\b/;
const ROLE_TESTS = {
  ramp: (t, c) => c.main !== 'Land' && (/\{t\}[^:\n]*: add\b/.test(t) || /search your library for [^.]*\b(?:land|forest|plains|island|swamp|mountain)s?\b[^.]*onto the battlefield/.test(t) || /put (?:a|up to \w+) land cards? from your hand onto the battlefield/.test(t) || /play an additional land/.test(t) || /create (?:a|an|one|two|three|x) (?:tapped )?treasure/.test(t) || /spells you cast cost \{\d\} less/.test(t)),
  draw: t => /\bdraws? (?:a card|an additional card|(?:two|three|four|five|six|seven|x|that many) cards|cards equal)/.test(t) || /exile the top [^.]*of your library[^.]*\.[^.]*you may (?:play|cast)/.test(t) || /(?:look at|reveal) the top [^.]*\.[^.]*into your hand/.test(t) || /\binvestigate\b/.test(t),
  removal: t => /(?:destroy|exile) (?:another |up to \w+ )?target (?:[\w-]+ ){0,3}?(?:permanent|creature|artifact|enchantment|planeswalker|battle)s?\b(?! cards?)/.test(t) || /deals? [^.]*?damage[^.]*?to (?:any (?:other )?target|(?:another |up to \w+ )?target (?:[\w-]+ ){0,2}?(?:creature|planeswalker))/.test(t) || /target creature (?:an opponent controls )?gets -(?:\d+|x)\/-(?:\d+|x)/.test(t) || /fights? (?:another |up to one )?target creature/.test(t) || /(?:target|each) opponent sacrifices (?:a|an|one) (?:creature|attacking|nonland|permanent)/.test(t) || /return (?:another |up to \w+ )?target (?:nonland permanent|creature|permanent|artifact|enchantment)s? to (?:its|their) owners?'?s?'? hands?/.test(t) || /enchanted creature can't attack/.test(t) || /(?:owner of|put) (?:another )?target (?:[\w-]+ ){0,2}?(?:permanent|creature|artifact|enchantment)[^.]*(?:shuffles it into|on (?:the )?(?:top|bottom) of) (?:its owner's|their) library/.test(t),
  wipe: t => /(?:destroy|exile) all (?:other )?(?:[\w-]+ ){0,2}?(?:permanents|creatures|artifacts|enchantments|planeswalkers)/.test(t) || /all (?:other )?creatures get -(?:\d+|x)\/-(?:\d+|x)/.test(t) || /deals? (?:\d+|x) damage to each (?:other )?(?:creature|non[\w-]+ creature)/.test(t) || /each player sacrifices (?:all|\w+ creatures)/.test(t) || /return all (?:nonland permanents|creatures|other creatures) to their owners'? hands/.test(t),
  counter: t => /counter target (?:[\w-]+ ){0,3}?spell/.test(t),
  tutor: (t) => { const m = /search your library for (?:a|an|up to \w+) ([^.,]*?)cards?\b/.exec(t); return !!m && !LANDISH.test(m[1]) && !/\b(?:land|forest|plains|island|swamp|mountain)\b/.test(m[1]); },
  protect: t => /(?:creatures|permanents|other creatures) you control (?:gain|have) (?:hexproof|indestructible|shroud|protection)|target (?:creature|permanent) you control gains (?:hexproof|indestructible|shroud|protection)|commander (?:has|gains) (?:hexproof|indestructible|protection)|(?:equipped|enchanted) creature has (?:hexproof|indestructible|shroud|protection)|phase out/.test(t),
  recursion: t => /return [^.]*cards? from your graveyard (?:to|onto) (?:your hand|the battlefield)/.test(t) || /from your graveyard onto the battlefield/.test(t),
};

// ---- the plans a card belongs to: does it (makes tokens), or is it a payoff for it (whenever a token...)
const THEMES = [
  { id: 'tokens', name: 'tokens', does: /\bcreates? [^.]*\btokens?\b/, cares: /tokens? you control|whenever (?:a|another|one or more) [^.]*\btokens?\b|for each (?:creature )?token|\bpopulate\b|creatures you control get \+\d/ },
  { id: 'counters', name: '+1/+1 counters', does: /\+1\/\+1 counters? on/, cares: /\bproliferate\b|with (?:a|one or more) \+1\/\+1 counters? on|whenever (?:one or more )?\+1\/\+1 counters?|for each \+1\/\+1 counter|\+1\/\+1 counters? (?:are|would be) put|double the number of/ },
  { id: 'graveyard', name: 'the graveyard', does: /\bmills?\b|\bsurveil\b|put the top [^.]* into your graveyard|discard (?:a|two|that) cards?/, cares: /from your graveyard|cards? in your graveyard|\bflashback\b|\bunearth\b|\bescape\b|\bdredge\b|\bembalm\b|\beternalize\b|\bdisturb\b/ },
  { id: 'spells', name: 'instants and sorceries', does: (t, c) => c.main === 'Instant' || c.main === 'Sorcery', cares: /whenever you cast (?:an?|your (?:first|second)) (?:instant|sorcery|noncreature)|instant (?:and|or) sorcery (?:spells?|cards?)|\bmagecraft\b|\bprowess\b|copy (?:target|that) (?:instant|sorcery)/ },
  { id: 'artifacts', name: 'artifacts', does: (t, c) => c.main === 'Artifact' || /\bcreates? [^.]*\b(?:treasure|clue|food|artifact)\b/.test(t), cares: /artifacts? you control|whenever (?:an?|another|one or more) (?:nontoken )?artifacts?|for each artifact|affinity for artifacts|\bimprovise\b|\bmetalcraft\b/ },
  { id: 'enchantments', name: 'enchantments', does: (t, c) => c.main === 'Enchantment', cares: /enchantments? you control|whenever (?:an?|another) (?:nontoken )?enchantment|\bconstellation\b|for each enchantment|aura spell/ },
  { id: 'lifegain', name: 'gaining life', does: /\bgains? (?:\d+|x|that much) life|gain life equal|\blifelink\b/, cares: /whenever you gain life|if you(?:'ve| have)? gained (?:\d+ or more )?life|for each 1 life you gained/ },
  { id: 'sacrifice', name: 'sacrificing creatures', does: /\bsacrifice (?:a|an|another|two|x) (?:other )?(?:creature|artifact|permanent|token)/, cares: /whenever (?:a|another|one or more) (?:other )?(?:nontoken )?creatures? (?:you control )?(?:dies|die)\b|whenever you sacrifice/ },
  { id: 'landfall', name: 'lands', does: /play an additional land|search your library for [^.]*\bland/, cares: /\blandfall\b|whenever a land (?:you control )?enters|whenever one or more lands|for each land you control/ },
  { id: 'combat', name: 'attacking', does: /\bhaste\b|double strike|additional combat|\bmenace\b|\btrample\b/, cares: /whenever [^.]{0,40}\battacks\b|deals combat damage to (?:a player|an opponent)|attacking creatures you control/ },
  { id: 'flying', name: 'flying', does: /\bflying\b/, cares: /creatures? (?:you control )?with flying|flying creatures you control|creatures you control (?:gain|have) flying/ },
  { id: 'voltron', name: 'Equipment and Auras', does: (t, c) => (c.main === 'Artifact' && /\bequip\b/.test(t)) || (c.main === 'Enchantment' && /^enchant creature/.test(t)), cares: /equipped creature|enchanted creature you control|equipment you control|auras? you control|whenever (?:an? )?(?:equipment|aura)|attached to/ },
  { id: 'drawing', name: 'drawing cards', does: null, cares: /whenever you draw|second card each turn|maximum hand size|for each card in your hand/ },
  { id: 'big', name: 'big creatures', does: (t, c) => c.main === 'Creature' && c.cmc >= 6, cares: /power \d+ or greater|greatest power|\bferocious\b/ },
];
export const THEME_NAMES = Object.fromEntries(THEMES.map(t => [t.id, t.name]));
const test = (r, t, c) => (!r ? false : typeof r === 'function' ? r(t, c) : r.test(t));

// creature types: the words after "Creature" in a type line (Forge writes "Legendary Creature Elf Druid")
const subtypes = type => { const m = /\b(?:Creature|Kindred|Tribal)\b(.*)$/.exec(type); return m ? m[1].trim().split(/\s+/).filter(w => /^[A-Z]/.test(w) && !['Creature', 'Instant', 'Sorcery', 'Enchantment', 'Artifact', 'Land'].includes(w)) : []; };
const plural = t => (/f$/.test(t) && t !== 'Elf' ? [t + 's'] : []).concat(t === 'Elf' ? ['Elves'] : t === 'Dwarf' ? ['Dwarves'] : t === 'Wolf' ? ['Wolves'] : /y$/.test(t) ? [t.slice(0, -1) + 'ies'] : /(?:s|x|ch|sh)$/.test(t) ? [t + 'es'] : [t + 's']);
// creature types too common in ordinary rules text to mean "this deck is about them"
const NOT_TRIBES = new Set(['Wall', 'Construct', 'Army', 'Spirit', 'Thopter', 'Servo', 'Germ', 'Shapeshifter', 'Citizen', 'Treasure']);

function normalize(c) {
  let t = (c.text || '').replace(/\([^)]*\)/g, '');
  const short = c.name.split(',')[0];
  t = t.split(c.name).join('this').split(short).join('this');
  return t.toLowerCase();
}

// ---- the helper: reads every card once, then answers questions about a deck
export function createDeckHelper(index, decks, support = {}) {
  const pop = new Map(), leads = new Map();
  for (const d of decks) {
    if (d.custom) continue;
    for (const [n] of d.cards) pop.set(n, (pop.get(n) || 0) + 1);
    for (const c of d.commanders) leads.set(c, new Set(d.cards.map(([n]) => n)));
  }
  const allTypes = new Set();
  const feats = new Map();
  for (const c of index) {
    const t = normalize(c);
    const roles = new Set(Object.keys(ROLE_TESTS).filter(r => ROLE_TESTS[r](t, c)));
    if (roles.has('wipe')) roles.delete('removal');
    const themes = new Map();
    for (const th of THEMES) { const d = test(th.does, t, c), k = test(th.cares, t, c); if (d || k) themes.set(th.id, d && k ? 'both' : k ? 'cares' : 'does'); }
    const types = subtypes(c.type);
    for (const ty of types) allTypes.add(ty);
    const f = { c, t, roles, themes, types, pop: pop.get(c.name) || 0, flagged: !!support[c.name], legal: !BANNED.has(c.name) && c.main !== 'Other' };
    if (c.main === 'Land') {
      f.produces = new Set();
      for (const m of t.matchAll(/add ((?:\{[wubrgc]\})+)/g)) for (const s of m[1].matchAll(/\{([wubrg])\}/g)) f.produces.add(s[1].toUpperCase());
      if (/add (?:one mana of )?any (?:one )?color|mana of any (?:one )?color|any color in your commander/.test(t)) f.produces.add('*');
      if (/search your library for [^.]*\b(?:basic land|forest|plains|island|swamp|mountain)/.test(t)) f.produces.add('fetch');
      f.tapped = /enters (?:the battlefield )?tapped/.test(t) && !/unless|if you control/.test(t);
    }
    feats.set(c.name, f);
  }
  for (const n of NOT_TRIBES) allTypes.delete(n);
  // "Elves" and "Elf" both find Elf
  const typeWords = new Map();
  for (const ty of allTypes) { typeWords.set(ty.toLowerCase(), ty); for (const p of plural(ty)) typeWords.set(p.toLowerCase(), ty); }
  const mentions = text => { const out = new Set(); for (const w of text.match(/[a-z][a-z'-]+/g) || []) { const ty = typeWords.get(w); if (ty) out.add(ty); } return out; };
  for (const f of feats.values()) f.mentions = mentions(f.t);

  // ---- the commander's plan
  function plan(state) {
    const weights = {}, tribes = new Map(), lead = new Set();
    const identity = new Set();
    for (const n of state.commanders) {
      const f = feats.get(n);
      if (!f) continue;
      f.c.ci.forEach(x => identity.add(x));
      for (const [th, kind] of f.themes) weights[th] = Math.max(weights[th] || 0, kind === 'does' ? 1.5 : 3);
      // creature types named in its text: "other Elves you control", "an Angel, Demon, or Dragon"
      // (a commander that only makes Soldier tokens leans that way a little; one that rewards Soldiers, a lot)
      for (const ty of f.mentions) {
        const names = [ty, ...plural(ty)].join('|').toLowerCase();
        const strong = new RegExp(`\\b(?:${names})\\b[^.]{0,12}you control|(?:other|another|each|whenever an?|for each|number of) [^.]{0,20}\\b(?:${names})\\b|\\b(?:${names})\\b[^.]{0,30}?(?:creature )?(?:cards?|spells?)\\b`).test(f.t);
        tribes.set(ty, Math.max(tribes.get(ty) || 0, strong ? 4 : 1.5));
      }
      if (leads.has(n)) for (const x of leads.get(n)) lead.add(x);
    }
    for (const th of (state.focus && state.focus.themes) || []) weights[th] = (weights[th] || 0) + 3;
    for (const ty of (state.focus && state.focus.tribes) || []) tribes.set(ty, (tribes.get(ty) || 0) + 4);
    // a deck about instants and sorceries wants fewer creatures
    const creatureTarget = weights.spells >= 3 ? 14 : [...tribes.values()].some(w => w >= 4) ? 32 : weights.artifacts >= 3 || weights.enchantments >= 3 ? 20 : 26;
    return { weights, tribes, lead, identity: COLORS.filter(x => identity.has(x)), creatureTarget };
  }

  // what the deck has now
  function counts(state) {
    const roles = {}, curve = Array(8).fill(0), out = { roles, curve, lands: 0, nonland: 0, creatures: 0, cmcSum: 0, flagged: [] };
    for (const [n, k] of state.cards) {
      const f = feats.get(n);
      if (!f) continue;
      if (f.c.main === 'Land') { out.lands += k; continue; }
      out.nonland += k; out.cmcSum += f.c.cmc * k;
      curve[Math.min(7, f.c.cmc)] += k;
      if (f.c.main === 'Creature') out.creatures += k;
      for (const r of f.roles) roles[r] = (roles[r] || 0) + k;
      if (f.flagged) out.flagged.push(n);
    }
    out.avg = out.nonland ? out.cmcSum / out.nonland : 0;
    return out;
  }
  function targets(p) {
    return { ramp: 10, draw: 10, removal: 8, wipe: 2, counter: p.identity.includes('U') ? 2 : 0, creatures: p.creatureTarget };
  }
  const landTarget = (p, cnt) => (cnt.avg && cnt.avg < 2.7 ? 35 : cnt.avg > 3.7 ? 38 : 37) - ((cnt.roles.ramp || 0) >= 12 ? 1 : 0);
  const CURVE = [0.02, 0.1, 0.2, 0.22, 0.18, 0.12, 0.08, 0.08];

  // how much of the mana base a color should get from its share of the mana symbols (a floor, so a splash color still shows up)
const colorWeight = share => 0.25 + share;
const legalFor = (f, p, state) => f.legal && !state.commanders.includes(f.c.name) && f.c.ci.every(x => p.identity.includes(x));

  // how well a card fits, and why (in words)
  function score(f, p, cnt, tg, opts = {}) {
    const why = [];
    let syn = 0, planWhy = null;
    for (const [th, kind] of f.themes) {
      const w = p.weights[th];
      if (!w) continue;
      const add = w * (kind === 'both' ? 1.3 : kind === 'cares' ? 1.1 : 1);
      syn += add;
      if (!planWhy || add > planWhy[1]) planWhy = [`Fits the ${THEME_NAMES[th]} plan`, add];
    }
    for (const [ty, w] of p.tribes) {
      if (f.types.includes(ty)) { syn += w * 1.2; if (!planWhy || w * 1.2 > planWhy[1]) planWhy = [`Is ${/^[AEIOU]/.test(ty) ? 'an' : 'a'} ${ty}`, w * 1.2]; }
      else if (f.mentions.has(ty)) { syn += w * 0.8; if (!planWhy || w * 0.8 > planWhy[1]) planWhy = [`Works with your ${plural(ty)[0]}`, w * 0.8]; }
    }
    let s = Math.min(syn, 9);
    if (planWhy && syn >= 1.5) why.push(planWhy[0]);
    for (const r of f.roles) {
      const want = tg[r] || 0, have = cnt.roles[r] || 0;
      if (want && have < want) { s += 1.5 + 3 * (want - have) / want; why.push(`${ROLES[r]}: you have ${have}, aim for about ${want}`); }
      else if (want && have >= want * 1.5) s -= 1;
      else if (r === 'protect' || r === 'tutor' || r === 'recursion') s += 0.5;
      else s += 0.3;
    }
    if (f.pop) { s += 2.4 * Math.sqrt(Math.min(f.pop, 50) / 50); if (f.pop >= 8) why.push(`In ${f.pop} precons`); }
    if (p.lead.has(f.c.name)) { s += 2; why.push('In your commander’s own precon'); }
    if (f.c.main !== 'Land') {
      // expensive cards cost more the more expensive they are; a full slot of the curve pushes toward other costs
      s -= Math.max(0, f.c.cmc - 4) * 0.5 + Math.max(0, f.c.cmc - 6) * 0.8;
      if (f.c.cmc <= 2) s += 0.4;
      const b = Math.min(7, f.c.cmc), cap = Math.max(1, CURVE[b] * (opts.nonlandTarget || 63));
      if (cnt.curve[b] >= cap) s -= 1.5 + 2 * (cnt.curve[b] - cap + 1) / cap;
      if (opts.maxCmc != null && f.c.cmc > opts.maxCmc) s -= 6;
    }
    if (f.c.main === 'Creature') { if (cnt.creatures < tg.creatures) s += 1; else if (cnt.creatures >= tg.creatures + 10) s -= 2; }
    if (!f.t.trim()) s -= 1.5;
    if (f.flagged) { s -= 8; why.push('The game can’t fully play this card yet'); }
    return { s, why };
  }

  // ---- suggestions: the best cards not in the deck, optionally for one job, plan or creature type
  function suggest(state, { role = null, theme = null, tribe = null, maxCmc = null, type = null, limit = 12, query = null } = {}) {
    const p = plan(state), cnt = counts(state), tg = targets(p);
    if (theme) p.weights[theme] = (p.weights[theme] || 0) + 3;
    if (tribe) p.tribes.set(tribe, (p.tribes.get(tribe) || 0) + 5);
    const out = [];
    for (const f of feats.values()) {
      if (!legalFor(f, p, state) || state.cards.get(f.c.name) || f.flagged || BASICS.has(f.c.name)) continue;
      if (f.c.main === 'Land' && role !== 'land') continue;
      if (role === 'land' && f.c.main !== 'Land') continue;
      if (role && role !== 'land' && !f.roles.has(role)) continue;
      if (theme && !f.themes.has(theme)) continue;
      if (tribe && !f.types.includes(tribe) && !f.mentions.has(tribe)) continue;
      if (type && f.c.main !== type) continue;
      if (maxCmc != null && f.c.cmc > maxCmc) continue;
      if (query && !(f.c.lower.includes(query) || f.t.includes(query) || f.c.type.toLowerCase().includes(query))) continue;
      const r = role === 'land' ? landScore(f, p) : score(f, p, cnt, tg, { maxCmc });
      out.push({ name: f.c.name, s: r.s, why: r.why.slice(0, 2) });
    }
    out.sort((a, b) => b.s - a.s);
    return out.slice(0, limit);
  }

  function landScore(f, p) {
    const why = [];
    const colors = [...f.produces].filter(x => p.identity.includes(x));
    const any = f.produces.has('*') || (f.produces.has('fetch') && p.identity.length > 1);
    const fixes = any ? p.identity.length : colors.length;
    let s = 2.4 * Math.sqrt(Math.min(f.pop, 50) / 50);
    if (p.identity.length > 1 && fixes >= 2) { s += 3 + fixes * 0.4; why.push(`Makes ${any ? 'any of your colors' : 'two of your colors'}`); }
    else if (fixes === 0) { s -= 1.5; }
    if (f.tapped) s -= 1;
    if (f.pop >= 8) why.push(`In ${f.pop} precons`);
    if (p.lead.has(f.c.name)) { s += 1.5; why.push('In your commander’s own precon'); }
    if (f.flagged) s -= 8;
    return { s, why, fixes };
  }

  // ---- build: fill the deck to 100, keeping what's there (or start over from just the commander)
  function build(state, { fresh = false, seed = 1 } = {}) {
    const p = plan(state);
    const cards = new Map(fresh ? [] : state.cards);
    const st = { ...state, cards };
    let rnd = seed >>> 0 || 1;
    const jitter = () => { rnd = (rnd * 1103515245 + 12345) >>> 0; return ((rnd >>> 8) % 1000) / 1000; };
    const tg = targets(p);
    let cnt = counts(st);
    const total = () => state.commanders.length + [...cards.values()].reduce((a, b) => a + b, 0);
    const added = [];
    // nonland cards first
    const pool = [...feats.values()].filter(f => legalFor(f, p, st) && f.c.main !== 'Land' && !f.flagged && !cards.get(f.c.name));
    const noise = new Map(pool.map(f => [f.c.name, jitter() * 0.9]));
    let lands = Math.max(landTarget(p, cnt), cnt.lands);
    const nonlandTarget = 100 - state.commanders.length - lands;
    while (cnt.nonland < nonlandTarget && total() < 100) {
      let best = null, bs = -Infinity;
      for (const f of pool) {
        if (cards.get(f.c.name)) continue;
        const r = score(f, p, cnt, tg, { nonlandTarget });
        const v = r.s + noise.get(f.c.name);
        if (v > bs) { bs = v; best = f; }
      }
      if (!best) break;
      cards.set(best.c.name, 1);
      added.push(best.c.name);
      cnt = counts(st);
    }
    // then lands: the best nonbasic ones for these colors, then basics in proportion to the mana symbols
    cnt = counts(st);
    lands = Math.max(0, 100 - total());
    const maxNonbasic = [3, 3, 8, 12, 14, 15][p.identity.length];
    const haveNonbasic = [...cards].filter(([n]) => { const f = feats.get(n); return f && f.c.main === 'Land' && !BASICS.has(n); }).length;
    const landPool = [...feats.values()].filter(f => f.c.main === 'Land' && !BASICS.has(f.c.name) && legalFor(f, p, st) && !cards.get(f.c.name) && !f.flagged)
      .map(f => ({ f, r: landScore(f, p) })).filter(x => x.r.s > (p.identity.length > 1 ? 1.5 : 1.2)).sort((a, b) => b.r.s - a.r.s);
    let utility = 0;
    for (const { f, r } of landPool) {
      if (lands <= 0 || haveNonbasic + added.filter(n => feats.get(n).c.main === 'Land').length >= maxNonbasic) break;
      if (r.fixes < 2 && p.identity.length > 1) { if (utility >= 2) continue; utility++; }
      cards.set(f.c.name, 1); added.push(f.c.name); lands--;
    }
    if (lands > 0) {
      const pips = Object.fromEntries(p.identity.map(x => [x, 0]));
      for (const [n, k] of cards) { const f = feats.get(n); if (!f || f.c.main === 'Land') continue; for (const t of f.c.cost) for (const x of p.identity) if (t.includes(x)) pips[x] += k / (t.length > 1 && !/^\d/.test(t) ? 2 : 1); }
      // basics by share of mana symbols (every color gets a floor), at least three of each when there's room
      const colors = p.identity.length ? p.identity : ['C'];
      const allPips = Object.values(pips).reduce((a, b) => a + b, 0) || 1;
      const w = colors.map(x => colorWeight((pips[x] || 0) / allPips)), sw = w.reduce((a, b) => a + b, 0);
      const n = w.map(v => Math.floor(lands * v / sw));
      const order = colors.map((_, i) => i).sort((a, b) => (lands * w[b] / sw - n[b]) - (lands * w[a] / sw - n[a]));
      for (let k = 0, left = lands - n.reduce((a, b) => a + b, 0); left > 0; k++, left--) n[order[k % order.length]]++;
      const least = colors.length > 1 && lands >= colors.length * 3 ? 3 : 0;
      for (let i = 0; i < n.length; i++) while (n[i] < least) { const j = n.indexOf(Math.max(...n)); if (n[j] <= least) break; n[j]--; n[i]++; }
      colors.forEach((x, i) => { if (!n[i]) return; const land = x === 'C' ? 'Wastes' : BASIC_FOR[x]; cards.set(land, (cards.get(land) || 0) + n[i]); added.push(...Array(n[i]).fill(land)); });
    }
    return { cards, added };
  }

  // ---- a read of the deck: what it's good at, what it's short on
  function review(state) {
    const p = plan(state), cnt = counts(state), tg = targets(p);
    const total = state.commanders.length + [...state.cards.values()].reduce((a, b) => a + b, 0);
    const notes = [];
    const lt = landTarget(p, cnt);
    const planNames = Object.entries(p.weights).filter(([, w]) => w >= 3).map(([th]) => THEME_NAMES[th]);
    const tribeNames = [...p.tribes].filter(([, w]) => w >= 4).map(([ty]) => plural(ty)[0]);
    if (planNames.length || tribeNames.length) {
      const on = [...state.cards].filter(([n]) => { const f = feats.get(n); return f && f.c.main !== 'Land' && ([...f.themes.keys()].some(th => (p.weights[th] || 0) >= 3) || [...p.tribes].some(([ty, w]) => w >= 4 && (f.types.includes(ty) || f.mentions.has(ty)))); }).length;
      notes.push({ level: on >= 15 ? 'good' : 'tip', text: `Your commander’s plan: ${[...tribeNames, ...planNames].join(', ')}. ${on} card${on === 1 ? '' : 's'} in the deck support it${on >= 15 ? '.' : '; 15 or more makes the plan show up most games.'}`, act: on < 15 ? { kind: 'plan' } : null });
    }
    if (total < 100) notes.push({ level: 'warn', text: `${total} of 100 cards so far.`, act: { kind: 'build' } });
    if (total > 100) notes.push({ level: 'warn', text: `${total - 100} card${total - 100 === 1 ? '' : 's'} too many: a Commander deck has exactly 100.`, act: { kind: 'cut' } });
    if (cnt.lands < lt - 1) notes.push({ level: 'warn', text: `${cnt.lands} lands. Decks like this usually want about ${lt}, or you’ll miss land drops.`, act: { kind: 'role', role: 'land' } });
    else if (cnt.lands > lt + 2) notes.push({ level: 'tip', text: `${cnt.lands} lands is a lot; about ${lt} leaves room for more spells.` });
    else if (cnt.lands) notes.push({ level: 'good', text: `${cnt.lands} lands: right where it should be.` });
    for (const r of ['ramp', 'draw', 'removal', 'wipe', 'counter']) {
      const want = tg[r], have = cnt.roles[r] || 0;
      if (!want) continue;
      if (have < want * 0.7) notes.push({ level: 'warn', text: `${ROLES[r]}: ${have}. Aim for about ${want}.`, act: { kind: 'role', role: r } });
      else notes.push({ level: 'good', text: `${ROLES[r]}: ${have} (aim ${want}).` });
    }
    if (cnt.nonland) {
      const a = cnt.avg.toFixed(1);
      if (cnt.avg > 3.8) notes.push({ level: 'warn', text: `Average mana value ${a} is high: early turns can feel slow. Try cheaper cards.`, act: { kind: 'cheaper' } });
      else notes.push({ level: 'good', text: `Average mana value ${a}.` });
    }
    if (cnt.creatures < tg.creatures - 6 && cnt.nonland > 30) notes.push({ level: 'tip', text: `${cnt.creatures} creatures. Decks like this usually run about ${tg.creatures}.`, act: { kind: 'type', type: 'Creature' } });
    if (cnt.flagged.length) notes.push({ level: 'warn', text: `The game can’t fully play ${cnt.flagged.length === 1 ? 'one card' : cnt.flagged.length + ' cards'} yet: ${cnt.flagged.slice(0, 3).join(', ')}${cnt.flagged.length > 3 ? '…' : ''}.` });
    return { notes, cnt, plan: { names: [...tribeNames, ...planNames] } };
  }

  // ---- what to cut: the cards that help least
  function cuts(state, n = 8, { overCmc = null } = {}) {
    const p = plan(state), cnt = counts(state), tg = targets(p);
    const out = [];
    for (const [name] of state.cards) {
      const f = feats.get(name);
      if (!f || f.c.main === 'Land') continue;
      if (overCmc != null && f.c.cmc <= overCmc) continue;
      // score it as if it weren't in the deck yet
      const less = { ...cnt, roles: { ...cnt.roles } };
      for (const r of f.roles) less.roles[r]--;
      const r = score(f, p, less, tg, {});
      const why = [];
      if (f.flagged) why.push('The game can’t fully play it yet');
      if (f.c.cmc >= 6) why.push(`Costs ${f.c.cmc}`);
      if (!f.roles.size && ![...f.themes.keys()].some(th => p.weights[th]) && ![...p.tribes.keys()].some(ty => f.types.includes(ty))) why.push('Off your commander’s plan');
      for (const ro of f.roles) if ((cnt.roles[ro] || 0) > (tg[ro] || 99) + 2) why.push(`You have plenty of ${ROLES[ro].toLowerCase()}`);
      out.push({ name, s: r.s, why: why.length ? why.slice(0, 2) : ['Helps the least of what’s here'] });
    }
    out.sort((a, b) => a.s - b.s);
    return out.slice(0, n);
  }

  // ---- commanders for what someone likes
  function findCommanders({ themes = [], tribes = [], colors = null, limit = 6 } = {}) {
    const out = [];
    for (const f of feats.values()) {
      if (!f.c.commander || !f.legal) continue;
      if (colors && (f.c.ci.some(x => !colors.includes(x)) || (colors.length && !f.c.ci.length))) continue;
      let s = 0; const why = [];
      for (const th of themes) { const k = f.themes.get(th); if (k) { s += k === 'does' ? 2 : 4; why.push(k === 'does' ? `Does ${THEME_NAMES[th]}` : `Rewards ${THEME_NAMES[th]}`); } }
      for (const ty of tribes) { if (f.mentions.has(ty)) { s += 6; why.push(`Leads ${plural(ty)[0]}`); } else if (f.types.includes(ty)) { s += 2; why.push(`Is ${/^[AEIOU]/.test(ty) ? 'an' : 'a'} ${ty}`); } }
      if ((themes.length || tribes.length) && !s) continue;
      if (colors && colors.length) { const same = colors.every(x => f.c.ci.includes(x)); s += same ? 2 : 0; if (same) why.push(`${colors.length === 1 ? 'Mono-' : ''}${colors.map(x => COLOR_NAMES[x]).join('-')}`); }
      if (leads.has(f.c.name)) { s += 2.5; why.push('Leads a precon'); }
      s += 1.5 * Math.sqrt(Math.min(f.pop, 20) / 20);
      if (f.flagged) s -= 10;
      out.push({ name: f.c.name, s, why: why.slice(0, 3) });
    }
    out.sort((a, b) => b.s - a.s);
    return out.slice(0, limit);
  }

  // does a card belong to the commander's main plan (a theme it cares about, or its creature type)?
  const onPlan = (f, p) => [...f.themes.keys()].some(th => (p.weights[th] || 0) >= 3) || [...p.tribes].some(([ty, w]) => w >= 4 && (f.types.includes(ty) || f.mentions.has(ty)));
  // the deck's numbers without one of its cards (to judge a card that's already in)
  const without = (cnt, f) => { const less = { ...cnt, roles: { ...cnt.roles } }; for (const r of f.roles) less.roles[r] = Math.max(0, (less.roles[r] || 0) - 1); return less; };

  // ---- one card, for this deck: its jobs, how it fits, and anything stopping it from going in
  function info(name, state) {
    const f = feats.get(name);
    if (!f) return null;
    const p = plan(state);
    const problems = [];
    const missing = f.c.ci.filter(x => !p.identity.includes(x));
    if (state.commanders.length && missing.length && !state.commanders.includes(name)) problems.push(`Needs ${missing.map(x => COLOR_NAMES[x]).join(' and ')} mana: outside your commander’s colors`);
    if (BANNED.has(name)) problems.push('Banned in Commander');
    if (f.c.main === 'Other') problems.push('Not a card you can put in a deck');
    if (f.flagged) problems.push('The game can’t fully play this card yet');
    let fit = null;
    if (state.commanders.length && !BASICS.has(name) && !state.commanders.includes(name)) {
      const cnt = counts(state);
      fit = f.c.main === 'Land' ? landScore(f, p) : score(f, p, state.cards.get(name) ? without(cnt, f) : cnt, targets(p), {});
    }
    const plans = [];
    for (const [th, kind] of f.themes) if (p.weights[th]) plans.push(kind === 'does' ? `Does ${THEME_NAMES[th]}` : `Rewards ${THEME_NAMES[th]}`);
    for (const [ty] of p.tribes) if (f.types.includes(ty)) plans.push(`Is ${/^[AEIOU]/.test(ty) ? 'an' : 'a'} ${ty}`); else if (f.mentions.has(ty)) plans.push(`Works with ${plural(ty)[0]}`);
    return { roles: [...f.roles], plans: plans.slice(0, 3), onPlan: onPlan(f, p), why: fit ? fit.why : [], s: fit ? fit.s : null, pop: f.pop, lead: p.lead.has(name), problems, produces: f.produces ? [...f.produces] : null };
  }

  // ---- every playable card's score for this deck (search results sort by it)
  function rank(state) {
    const p = plan(state), cnt = counts(state), tg = targets(p);
    const out = new Map();
    for (const f of feats.values()) {
      if (!f.legal || BASICS.has(f.c.name) || state.commanders.includes(f.c.name)) continue;
      if (f.c.ci.some(x => !p.identity.includes(x))) continue;
      const r = f.c.main === 'Land' ? landScore(f, p) : score(f, p, state.cards.get(f.c.name) ? without(cnt, f) : cnt, tg, {});
      out.set(f.c.name, { s: r.s, why: r.why, plan: f.c.main !== 'Land' && onPlan(f, p) });
    }
    return out;
  }
  const roleOf = name => { const f = feats.get(name); return f ? [...f.roles] : []; };

  // ---- the deck checklist: each part of a good Commander deck, how many you have, about how many to aim for
  function recipe(state) {
    const p = plan(state), cnt = counts(state), tg = targets(p);
    const lt = landTarget(p, cnt);
    const rows = [{ id: 'land', label: 'Lands', have: cnt.lands, want: lt, lo: lt - 1, hi: lt + 2, help: ROLE_HELP.land }];
    for (const r of ['ramp', 'draw', 'removal', 'wipe', 'counter']) if (tg[r]) rows.push({ id: r, label: ROLES[r], have: cnt.roles[r] || 0, want: tg[r], lo: Math.ceil(tg[r] * 0.8), hi: Infinity, help: ROLE_HELP[r] });
    const tribeNames = [...p.tribes].filter(([, w]) => w >= 4).map(([ty]) => plural(ty)[0]);
    const planNames = [...tribeNames, ...Object.entries(p.weights).filter(([, w]) => w >= 3).map(([th]) => THEME_NAMES[th])];
    if (planNames.length) {
      let on = 0;
      for (const [n, k] of state.cards) { const f = feats.get(n); if (f && f.c.main !== 'Land' && onPlan(f, p)) on += k; }
      rows.push({ id: 'plan', label: `Plan: ${planNames.slice(0, 2).join(', ')}`, have: on, want: 15, lo: 15, hi: 99, help: ROLE_HELP.plan });
    }
    rows.push({ id: 'creatures', label: 'Creatures', have: cnt.creatures, want: tg.creatures, lo: tg.creatures - 6, hi: tg.creatures + 16, help: ROLE_HELP.creatures });
    for (const r of rows) r.state = r.have < r.lo ? (r.have < r.want * 0.6 ? 'low' : 'short') : r.have > r.hi ? 'over' : 'good';
    return { rows, avg: cnt.avg, nonland: cnt.nonland, curve: cnt.curve, planNames };
  }

  // ---- color balance: each color's share of the mana symbols in your costs, and how many lands make it
  const BASIC_COLOR = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };
  function manaStats(state) {
    const p = plan(state);
    const pips = Object.fromEntries(p.identity.map(x => [x, 0])), sources = Object.fromEntries(p.identity.map(x => [x, 0]));
    let lands = 0;
    for (const [n, k] of state.cards) {
      const f = feats.get(n);
      if (!f) continue;
      if (f.c.main === 'Land') {
        lands += k;
        const prod = BASIC_COLOR[n] ? new Set([BASIC_COLOR[n]]) : f.produces || new Set();
        for (const x of p.identity) if (prod.has(x) || prod.has('*') || prod.has('fetch')) sources[x] += k;
      } else for (const t of f.c.cost) for (const x of p.identity) if (t.includes(x)) pips[x] += k / (t.length > 1 && !/^\d/.test(t) ? 2 : 1);
    }
    const allPips = Object.values(pips).reduce((a, b) => a + b, 0);
    const sw = p.identity.reduce((a, x) => a + (pips[x] ? colorWeight(allPips ? pips[x] / allPips : 0) : 0), 0) || 1;
    const colors = p.identity.map(x => {
      const share = allPips ? pips[x] / allPips : 0;
      // about this many lands should make the color: its weighted share, and at least a dozen for any color you use
      const want = pips[x] ? Math.min(lands, Math.max(Math.round(lands * colorWeight(share) / sw), Math.min(12, Math.round(lands / 2)))) : 0;
      return { color: x, name: COLOR_NAMES[x], pips: Math.round(pips[x]), share, sources: sources[x], want, short: lands >= 20 && pips[x] > 0 && sources[x] < want - 2 };
    });
    return { colors, lands };
  }

  return { feats, plan, counts, suggest, build, review, cuts, findCommanders, typeWords, info, rank, roleOf, recipe, manaStats, leadsPrecon: n => leads.has(n), landTarget: state => landTarget(plan(state), counts(state)) };
}

// ---- reading what someone typed
const COLOR_NAMES = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' };
const COLOR_WORDS = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G', azorius: 'WU', dimir: 'UB', rakdos: 'BR', gruul: 'RG', selesnya: 'GW', orzhov: 'WB', izzet: 'UR', golgari: 'BG', boros: 'RW', simic: 'GU', bant: 'GWU', esper: 'WUB', grixis: 'UBR', jund: 'BRG', naya: 'RGW', abzan: 'WBG', jeskai: 'URW', sultai: 'BGU', mardu: 'RWB', temur: 'GUR' };
const THEME_WORDS = [
  [/tokens?|go wide|\barmy\b|armies/, 'tokens'], [/\+1\/\+1|\bcounters\b|proliferat/, 'counters'], [/graveyard|reanimat|\bmill/, 'graveyard'],
  [/\bspell ?slinger|\binstants?\b|sorcer(?:y|ies)/, 'spells'], [/artifacts?|treasures?|robots?/, 'artifacts'], [/enchantments?|\bauras?\b/, 'enchantments'],
  [/life ?gain|lifelink|gain(?:ing)? life/, 'lifegain'], [/sacrific|aristocrat|dies|death/, 'sacrifice'], [/landfall|lands matter/, 'landfall'],
  [/aggro|attack|aggressive|beat ?down|combat/, 'combat'], [/\bfly(?:ing|ers?)?\b|\bflyers\b|\bair\b/, 'flying'], [/equipment|voltron/, 'voltron'], [/\bbig\b|\bhuge\b|\bgiant\b|stomp/, 'big'],
];
const ROLE_WORDS = [
  [/ramp|mana rocks?|accelerat|more mana/, 'ramp'], [/card draw|draw(?:ing)? (?:more )?cards|card advantage|\bdraw\b/, 'draw'],
  [/wipe|wrath|sweeper|board ?clear|clear the board/, 'wipe'], [/removal|\bkill|destroy|answers?|deal with/, 'removal'],
  [/counter ?spells?|countering/, 'counter'], [/tutors?/, 'tutor'], [/protect/, 'protect'], [/recursion|get (?:things|cards) back/, 'recursion'], [/\blands?\b/, 'land'],
];
export function parseAsk(text, typeWords) {
  const t = ' ' + text.toLowerCase().replace(/[^a-z0-9+/' -]/g, ' ') + ' ';
  const out = { intent: null, roles: [], themes: [], tribes: [], colors: null, type: null, words: t.trim() };
  for (const [rx, r] of ROLE_WORDS) if (rx.test(t)) out.roles.push(r);
  for (const [rx, th] of THEME_WORDS) if (rx.test(t)) out.themes.push(th);
  const cols = new Set();
  for (const [w, cs] of Object.entries(COLOR_WORDS)) if (new RegExp(`\\b${w}\\b`).test(t)) for (const c of cs) cols.add(c);
  if (/\bcolorless\b/.test(t)) out.colors = [];
  else if (cols.size) out.colors = COLORS.filter(c => cols.has(c));
  for (const w of t.match(/[a-z][a-z'-]+/g) || []) { const ty = typeWords.get(w); if (ty && !out.tribes.includes(ty)) out.tribes.push(ty); }
  if (/\bcreatures?\b/.test(t)) out.type = 'Creature';
  if (/start over|from scratch|rebuild|new deck|redo/.test(t)) out.intent = 'rebuild';
  else if (/\b(?:build|finish|fill|complete|make (?:me |it |the )?(?:a |the )?deck|do it for me|auto|rest of)\b/.test(t)) out.intent = 'build';
  else if (/\b(?:cut|remove|weak(?:est)?|worst|swap|take out|too many)\b/.test(t)) out.intent = 'cut';
  else if (/cheap|curve|lower|faster|too slow|expensive|low cost/.test(t)) out.intent = 'cheaper';
  else if (/what.*(?:need|missing|wrong|think)|check|analy[sz]|rate|review|how(?:'s| is| good)|grade|problems?/.test(t)) out.intent = 'review';
  else if (/commander|leader|who should|which legend/.test(t)) out.intent = 'commander';
  else if (/^ *(?:help|hi|hello|hey|what can you do)\b/.test(t)) out.intent = 'help';
  else if (/plan|strategy|how (?:does|do i) (?:this|it|my deck) win|explain/.test(t)) out.intent = 'plan';
  else if (/surprise|random|anything/.test(t)) out.intent = 'surprise';
  else if (out.roles.length || out.themes.length || out.tribes.length || out.type) out.intent = 'suggest';
  else if (/suggest|recommend|ideas?|what (?:should|can|else) (?:i )?add|good cards|best cards/.test(t)) out.intent = 'suggest';
  return out;
}
export { COLOR_NAMES };
