// What each card does: attacks (by name), abilities (by name) and Trainer cards (by name), for every card in the
// Pokémon decks on offer. Vanilla attacks need no entry: they just do their printed damage.
//   ATTACKS[name]   = { base(ctx) -> damage, after(ctx), run(ctx) (does everything), can(game, mon, atk) -> reason it can't, opts }
//   ABILITIES[name] = { use(game, mon, pid) | onBench | onEvolve, can(game, mon, pid), oncePerPlayer, selfKO }
//   TRAINERS[name]  = { can(game, pid, card), play(game, pid, card), canAttach(game, mon), stadiumUse(game, pid), stadiumCan }
//   ENERGIES[name]  = { onAttach(game, mon, pid) when attached from the hand, can(game, mon, pid) }
// Passive Abilities, Tools, Stadiums and Special Energy (Skyliner, Festival Lead, Wild Growth, Hide 'n' Sneak,
// Mysterious Rock Inn, Cobalt Command, Jamming Tower, Mist Energy, Legacy Energy...) are read by the engine in game.js.
export const ATTACKS = {};
export const ABILITIES = {};
export const TRAINERS = {};
export const ENERGIES = {};

// ---------------------------------------------------------------- helpers
const isBasicEnergy = (c, type) => c.def.cat === 'E' && c.def.energy === 'Basic' && (!type || c.def.provides === type);
const isMon = c => c.def.cat === 'P';
const isBasicMon = c => isMon(c) && c.def.stage === 'Basic';
const ruleBox = d => !!(d.ex || d.radiant || d.v);
const STAGE1_OF = { Pidgeotto: 'Pidgey' }; // evolution lines whose middle card isn't in any deck here

function draw(g, pid, n) {
  const got = g.draw(pid, n);
  g.log(`${g.pl(pid).name} draws ${got.length} card${got.length === 1 ? '' : 's'}.`, { pid });
  return got;
}
function shuffleHandIn(g, pid) { const p = g.pl(pid); p.deck.push(...p.hand.splice(0)); g.shuffle(pid); }
// look through the deck for cards matching `filter`; the deck is shuffled afterwards
async function search(g, pid, filter, { min = 0, max = 1, prompt = 'Search your deck', to = 'hand', hint = 'take' } = {}) {
  const p = g.pl(pid);
  if (to === 'bench') max = Math.min(max, g.benchLimit(pid) - p.bench.length);
  const opts = p.deck.filter(filter);
  const got = max > 0 ? await g.chooseCards(pid, opts, { min: Math.min(min, max), max, prompt, from: 'deck', reveal: to === 'hand', hint, shown: p.deck }) : [];
  for (const c of got) {
    if (to === 'hand') g.moveTo(c, 'hand');
    else if (to === 'bench') benchFromEffect(g, pid, c);
  }
  if (!got.length) g.log(`${p.name} searches their deck${opts.length ? '' : ' and finds nothing'}.`);
  else if (to === 'bench') g.log(`${p.name} puts ${got.map(c => c.name).join(', ')} onto the Bench.`);
  g.shuffle(pid);
  return got;
}
function benchFromEffect(g, pid, card) {
  const p = g.pl(pid);
  g.removeFromZones(card);
  const m = new (g.monClass())(g, card);
  p.bench.push(m);
  g.event('enter', { mon: m.id });
  if (g.stadiumName() === 'Risky Ruins' && m.def.stage === 'Basic' && m.def.type !== 'Darkness' && g.current === pid) g.addCounters(m, 2);
  return m;
}
// pay a "discard N other cards" cost
async function discardCost(g, pid, n, card, prompt) {
  const p = g.pl(pid);
  const opts = p.hand.filter(c => c !== card);
  const got = await g.chooseCards(pid, opts, { min: n, max: n, prompt: prompt || `Discard ${n} card${n > 1 ? 's' : ''} from your hand`, from: 'hand', hint: 'discard' });
  for (const c of got) g.discard(c);
  if (got.length) g.log(`${p.name} discards ${got.map(c => c.name).join(', ')}.`);
  return got;
}
async function attachEach(g, pid, cards, mons, prompt) {
  for (const c of cards) {
    if (!mons.length) break;
    const m = await g.chooseOneMon(pid, mons, `${prompt || 'Attach'} ${c.name} to which Pokémon?`, 'attach:' + c.def.provides);
    if (m) await g.attachEnergy(pid, m, c);
  }
}
const oppBench = (g, pid) => g.pl(g.opp(pid)).bench;
const gustable = (g, pid) => oppBench(g, pid).length > 0;
async function gust(g, pid, { basicOnly = false } = {}) {
  const opts = oppBench(g, pid).filter(m => !basicOnly || m.def.stage === 'Basic');
  const m = await g.chooseOneMon(pid, opts, "Choose one of your opponent's Benched Pokémon to switch into the Active Spot", 'gust');
  if (m) g.gust(pid, m);
  return m;
}
async function switchOwn(g, pid, prompt = 'Choose a Benched Pokémon to switch with your Active Pokémon', filter = () => true) {
  const p = g.pl(pid);
  const m = await g.chooseOneMon(pid, p.bench.filter(filter), prompt, 'switch');
  if (m) { g.log(`${p.name} switches ${p.active ? p.active.name : 'their Active Pokémon'} with ${m.name}.`); g.switchActive(pid, m); }
  return m;
}
// "Put N damage counters on your opponent's Pokémon in any way you like"
async function spreadCounters(g, pid, n, mons, ctx, prompt) {
  if (!mons.length) return;
  const plan = await g.distribute(pid, n, mons, prompt || `Put ${n} damage counters on your opponent's Pokémon in any way you like`);
  for (const [m, k] of plan) { const put = g.addCounters(m, k, { ctx }); if (put) g.log(`${put} damage counter${put > 1 ? 's' : ''} on ${m.name}.`); }
}
async function discardEnergyFrom(g, pid, mon, n, prompt, filter = () => true) {
  const opts = mon.energy.filter(filter);
  const got = await g.chooseCards(pid, opts, { min: Math.min(n, opts.length), max: Math.min(n, opts.length), prompt: prompt || `Discard ${n} Energy from ${mon.name}`, from: 'energy', hint: 'discard' });
  for (const c of got) g.discard(c);
  if (got.length) g.log(`${got.length} Energy discarded from ${mon.name}.`);
  return got;
}
function lookTop(g, pid, n) { return g.pl(pid).deck.slice(0, n); }
const turnOne = (g, pid) => g.pl(pid).turns === 1;
const koLastTurn = (g, pid) => g.pl(pid).koTurn === g.turn - 1;
const usedThisTurn = (m, name, g) => m.used[name] === g.turn;
const playerUsed = (g, pid, name) => g.pl(pid).once[name] === g.turn;
// Stage 2 cards in hand that a Basic in play could Rare Candy into
function basicOfStage2(g, def) {
  const s1 = def.from;
  if (STAGE1_OF[s1]) return STAGE1_OF[s1];
  const d = Object.values(g.db).find(x => x.cat === 'P' && x.name === s1);
  return d ? d.from : null;
}
const tera = (g, pid) => g.inPlay(pid).some(m => m.def.tera);
// Rare Candy: the Stage 2 cards in hand and the Basic Pokémon in play (not new this turn) they can evolve
function candyPairs(g, pid) {
  const pairs = [];
  for (const c of g.pl(pid).hand) if (isMon(c) && c.def.stage === 'Stage2') for (const m of g.inPlay(pid)) if (m.def.stage === 'Basic' && m.playedTurn !== g.turn && m.noEvolveTurn !== g.turn && m.name === basicOfStage2(g, c.def)) pairs.push({ c, m });
  return pairs;
}
const isNs = m => /^N's /.test(m.name);
// Pokémon cards with the Hide 'n' Sneak Ability in a player's discard pile (what Dhelmise, Sinistcha and Spiritomb count)
const sneakers = (g, pid) => g.pl(pid).discard.filter(c => isMon(c) && (c.def.abilities || []).some(a => a.name === "Hide 'n' Sneak")).length;
// "Switch out your opponent's Active Pokémon to the Bench" (the opponent picks the new one)
async function switchOutDefender(ctx) {
  const g = ctx.game, o = g.pl(ctx.opp), d = o.active;
  if (!d || !d.stack.length || g.hpLeft(d) <= 0 || !o.bench.length || g.effectsBlocked(ctx, d)) return;
  const m = await g.chooseOneMon(ctx.opp, o.bench, 'Your Active Pokémon is switched out: choose your new Active Pokémon', 'promote');
  if (m) { g.switchActive(ctx.opp, m); g.log(`${d.name} is switched to the Bench; ${m.name} comes in.`); }
}
// use one of another Pokémon's attacks as this attack (Seek Inspiration, Night Joker): its cost is not paid
async function useAttackOf(ctx, choices, prompt) {
  const g = ctx.game;
  if (!choices.length) return;
  const opts = choices.map(({ def, atk }, i) => ({ value: i, label: `${choices.some(x => x.def !== def) ? def.name + ': ' : ''}${atk.name}${atk.damage ? ` (${atk.damage})` : ''}`, key: def.key, atk: atk.name }));
  const v = await g.chooseOption(ctx.pid, opts, prompt, 'copy-attack');
  const { atk } = choices[v] || choices[0];
  g.log(`${ctx.attacker.name} uses ${atk.name}.`);
  ctx.atk = atk;
  ctx.printed = parseInt(atk.damage, 10) || 0;
  await g.runAttack(ctx);
}
const nightJokerChoices = (g, pid) => g.pl(pid).bench.filter(isNs).flatMap(m => (m.def.attacks || []).filter(a => a.name !== 'Night Joker').map(atk => ({ def: m.def, atk })));
// discard every Energy attached to the attacker
function discardAllEnergy(g, mon) {
  if (!mon.energy.length) return;
  const n = mon.energy.length;
  for (const c of [...mon.energy]) g.discard(c);
  g.log(`${n} Energy discarded from ${mon.name}.`);
}
// {G} Energy attached to all of a player's Pokémon, counting what Wild Growth doubles
const grassEnergyInPlay = (g, pid) => g.inPlay(pid).reduce((s, m) => s + g.energyTypes(m).filter(t => t === 'Grass' || t === 'Any').length, 0);

// ---------------------------------------------------------------- attacks
// damage to one of the opponent's Pokémon (Active or Benched)
async function hitOne(ctx, n, prompt) {
  const g = ctx.game;
  const opts = g.inPlay(ctx.opp);
  const m = await g.chooseOneMon(ctx.pid, opts, prompt || `Choose one of your opponent's Pokémon to take ${n} damage`, 'opp-damage:' + n);
  if (m) ctx.damageTo(m, n);
  return m;
}
const nextTurnNoAttack = ctx => ctx.game.addEffect({ kind: 'cantAttack', mon: ctx.attacker.id, turn: ctx.game.turn + 2 });
const defenderNoRetreat = ctx => { if (ctx.defender && !ctx.game.effectsBlocked(ctx, ctx.defender)) ctx.effect('cantRetreat', { mon: ctx.defender.id }); };
const itemLock = ctx => ctx.effect('itemLock', { pid: ctx.opp });
const prizesTakenByOpp = ctx => ctx.game.prizesTaken(ctx.opp);

Object.assign(ATTACKS, {
  'Cruel Arrow': { run: ctx => hitOne(ctx, 100) },
  'Itchy Pollen': { after: itemLock },
  'Oceanic Gloom': { after: itemLock },
  'Kaleidowaltz': {
    async run(ctx) {
      const g = ctx.game;
      let heads = 0;
      for (let i = 0; i < 3; i++) if (g.flip('Kaleidowaltz')) heads++;
      if (!heads) return;
      const got = await search(g, ctx.pid, c => isBasicEnergy(c), { max: 2 * heads, prompt: `Search your deck for up to ${2 * heads} Basic Energy to attach`, to: 'none', hint: 'attach' });
      await attachEach(g, ctx.pid, got, g.inPlay(ctx.pid), 'Attach');
    },
  },
  'Ear Force': { base: ctx => ctx.printed + 80 * (ctx.defender ? ctx.defender.energy.length : 0) },
  'Moonlight Shuriken': {
    async run(ctx) {
      const g = ctx.game;
      await discardEnergyFrom(g, ctx.pid, ctx.attacker, 2, 'Discard 2 Energy from Radiant Greninja');
      const targets = await g.chooseMon(ctx.pid, g.inPlay(ctx.opp), { min: 2, max: 2, prompt: "Choose 2 of your opponent's Pokémon to take 90 damage each", hint: 'opp-damage:90' });
      for (const m of targets) ctx.damageTo(m, 90);
    },
  },
  'Voltage Burst': {
    base: ctx => ctx.printed + 50 * prizesTakenByOpp(ctx),
    after(ctx) { ctx.game.addCounters(ctx.attacker, 3); ctx.game.log(`${ctx.attacker.name} does 30 damage to itself.`); },
  },
  'Protect Charge': { after: ctx => ctx.game.addEffect({ kind: 'protect', mon: ctx.attacker.id, turn: ctx.game.turn + 1 }) },
  'Lost Mine': {
    can: (g, mon) => (g.pl(mon.owner).lost.length >= 10 ? null : 'Needs 10 cards in the Lost Zone'),
    run: ctx => spreadCounters(ctx.game, ctx.pid, 12, ctx.game.inPlay(ctx.opp), ctx),
  },
  'Rapid-Fire Combo': {
    base(ctx) { let h = 0; while (ctx.game.flip('Rapid-Fire Combo')) { h++; if (h > 40) break; } return ctx.printed + 50 * h; },
  },
  'Charm': { after: ctx => { if (ctx.defender && !ctx.game.effectsBlocked(ctx, ctx.defender)) ctx.effect('charm', { mon: ctx.defender.id }); } },
  'Collect': { after: ctx => draw(ctx.game, ctx.pid, 1) },
  'Call Sign': { run: ctx => search(ctx.game, ctx.pid, isMon, { max: 3, prompt: 'Search your deck for up to 3 Pokémon' }) },
  'Cosmic Beam': {
    base: ctx => (ctx.game.pl(ctx.pid).bench.some(m => m.name === 'Lunatone') ? ctx.printed : 0),
    opts: { noWeakness: true, noResistance: true },
  },
  'Terminal Period': {
    run(ctx) {
      const d = ctx.defender;
      if (d && ctx.game.counters(d) === 6 && !ctx.game.effectsBlocked(ctx, d)) { ctx.game.log(`Terminal Period knocks out ${d.name}!`); d.damage = Math.max(d.damage, ctx.game.maxHp(d)); }
      else ctx.game.log('Terminal Period has no effect.');
    },
  },
  'Claw of Darkness': {
    async after(ctx) {
      const g = ctx.game, o = g.pl(ctx.opp);
      if (!o.hand.length) return;
      g.log(`${o.name} reveals their hand: ${o.hand.map(c => c.name).join(', ')}.`);
      const [c] = await g.chooseCards(ctx.pid, o.hand, { min: 1, max: 1, prompt: "Discard a card from your opponent's hand", from: 'opp-hand', hint: 'opp-discard' });
      if (c) { g.discard(c); g.log(`${c.name} is discarded from ${o.name}'s hand.`); }
    },
  },
  'Clutch': { after: defenderNoRetreat },
  'Sob': { after: defenderNoRetreat },
  'Shadow Bind': { after: defenderNoRetreat },
  'Call for Family': { run: ctx => search(ctx.game, ctx.pid, isBasicMon, { max: 2, prompt: 'Search your deck for up to 2 Basic Pokémon to put onto your Bench', to: 'bench', hint: 'bench' }) },
  'Burning Darkness': { base: ctx => ctx.printed + 30 * prizesTakenByOpp(ctx) },
  'Blustery Wind': { async after(ctx) { const g = ctx.game; if (g.stadium && await g.confirm(ctx.pid, `Discard ${g.stadium.card.name}?`, 'discard-stadium')) discardStadium(g); } },
  'Blazing Destruction': { run: ctx => { if (ctx.game.stadium) discardStadium(ctx.game); } },
  'Find a Friend': { run: ctx => search(ctx.game, ctx.pid, isMon, { max: 1, prompt: 'Search your deck for a Pokémon' }) },
  'Motivate': {
    async after(ctx) {
      const g = ctx.game, p = g.pl(ctx.pid);
      if (!p.bench.length) return;
      const got = await g.chooseCards(ctx.pid, p.discard.filter(c => isBasicEnergy(c)), { max: 2, prompt: 'Attach up to 2 Basic Energy from your discard pile', from: 'discard', hint: 'attach' });
      if (!got.length) return;
      const m = await g.chooseOneMon(ctx.pid, p.bench, 'Attach them to which Benched Pokémon?', 'attach');
      for (const c of got) await g.attachEnergy(ctx.pid, m, c);
    },
  },
  'Magnetic Charge': {
    async run(ctx) {
      const g = ctx.game, p = g.pl(ctx.pid);
      if (!p.bench.length) return;
      const got = await g.chooseCards(ctx.pid, p.discard.filter(c => isBasicEnergy(c, 'Lightning')), { max: 2, prompt: 'Attach up to 2 Basic {L} Energy from your discard pile', from: 'discard', hint: 'attach' });
      if (!got.length) return;
      const m = await g.chooseOneMon(ctx.pid, p.bench, 'Attach them to which Benched Pokémon?', 'attach:Lightning');
      for (const c of got) await g.attachEnergy(ctx.pid, m, c);
    },
  },
  'Hail Blade': {
    async base(ctx) {
      const g = ctx.game;
      let n = 0;
      for (const m of g.inPlay(ctx.pid)) {
        const ws = m.energy.filter(c => c.def.provides === 'Water');
        if (!ws.length) continue;
        const got = await g.chooseCards(ctx.pid, ws, { min: 0, max: ws.length, prompt: `Hail Blade: discard {W} Energy from ${m.name} (60 damage each)`, from: 'energy', hint: 'fuel:60' });
        for (const c of got) g.discard(c);
        n += got.length;
      }
      if (n) g.log(`${n} {W} Energy discarded.`);
      return 60 * n;
    },
  },
  'Frenzied Gouging': {
    run(ctx) {
      const g = ctx.game, d = ctx.defender;
      if (!d || g.effectsBlocked(ctx, d)) { g.log('Frenzied Gouging has no effect.'); return; }
      g.log(`Frenzied Gouging knocks out ${d.name}!`);
      d.damage = Math.max(d.damage, g.maxHp(d));
      ctx.attacker.damage += 200;
      g.log(`${ctx.attacker.name} does 200 damage to itself.`);
      g.event('damage', { mon: ctx.attacker.id, amount: 200 });
    },
  },
  'Calamity Storm': {
    async base(ctx) {
      const g = ctx.game;
      if (g.stadium && await g.confirm(ctx.pid, `Discard ${g.stadium.card.name} for 120 more damage?`, 'discard-stadium-bonus')) { discardStadium(g); return ctx.printed + 120; }
      return ctx.printed;
    },
  },
  'Make It Rain': {
    async base(ctx) {
      const g = ctx.game, p = g.pl(ctx.pid);
      const opts = p.hand.filter(c => isBasicEnergy(c));
      const got = await g.chooseCards(ctx.pid, opts, { min: 0, max: opts.length, prompt: 'Make It Rain: discard Basic Energy from your hand (50 damage each)', from: 'hand', hint: 'fuel:50' });
      for (const c of got) g.discard(c);
      if (got.length) g.log(`${got.length} Energy discarded from hand.`);
      return 50 * got.length;
    },
  },
  'Refrigerated Stream': { after(ctx) { const d = ctx.defender; if (d && d.stack.length && d.def.stage !== 'Basic' && !ctx.game.effectsBlocked(ctx, d)) ctx.effect('cantAttack', { mon: d.id }); } },
  'Amp You Very Much': { after(ctx) { if (ctx.defender) ctx.extraPrize.add(ctx.defender); } },
  'Roaring Scream': { run: ctx => hitOne(ctx, 20 * ctx.game.counters(ctx.attacker)) },
  'Gale Thrust': { base: ctx => ctx.printed + (ctx.attacker.movedActiveTurn === ctx.game.turn ? 170 : 0) },
  'Spiky Hopper': { opts: { ignoreEffects: true } },
  'Demolish': { opts: { noWeakness: true, noResistance: true, ignoreEffects: true } },
  'Spit Innocently': { opts: { noWeakness: true } },
  'Tuck Tail': {
    after(ctx) {
      const g = ctx.game, m = ctx.attacker;
      if (!m.stack.length) return;
      g.log(`${m.name} and its attached cards return to ${g.pl(ctx.pid).name}'s hand.`);
      g.removeMon(m, 'hand');
    },
  },
  'Come and Get You': {
    async run(ctx) {
      const g = ctx.game, p = g.pl(ctx.pid);
      const room = g.benchLimit(ctx.pid) - p.bench.length;
      const got = await g.chooseCards(ctx.pid, p.discard.filter(c => c.name === 'Duskull'), { max: Math.min(3, room), prompt: 'Put up to 3 Duskull from your discard pile onto your Bench', from: 'discard', hint: 'bench' });
      for (const c of got) benchFromEffect(g, ctx.pid, c);
    },
  },
  'Jewel Breaker': { base: ctx => ctx.printed + (ctx.defender && ctx.defender.def.tera ? 230 : 0) },
  'Triple Stab': { base(ctx) { let h = 0; for (let i = 0; i < 3; i++) if (ctx.game.flip('Triple Stab')) h++; return 10 * h; } },
  'Assault Landing': { base: ctx => (ctx.game.stadium ? ctx.printed : 0) },
  'Silent Wing': { after(ctx) { const o = ctx.game.pl(ctx.opp); ctx.game.log(`${o.name} reveals their hand: ${o.hand.map(c => c.name).join(', ') || 'nothing'}.`); } },
  'Irritated Outburst': { base: ctx => 60 * prizesTakenByOpp(ctx) },
  'Icicle Loop': {
    async after(ctx) {
      const g = ctx.game, m = ctx.attacker;
      if (!m.energy.length) return;
      const [c] = await g.chooseCards(ctx.pid, m.energy, { min: 1, max: 1, prompt: 'Put an Energy attached to Chien-Pao into your hand', from: 'energy', hint: 'return' });
      if (c) { g.moveTo(c, 'hand'); g.log(`${c.name} returns to ${g.pl(ctx.pid).name}'s hand.`); }
    },
  },
  'Topaz Bolt': { after: ctx => discardEnergyFrom(ctx.game, ctx.pid, ctx.attacker, 3) },
  'Eon Blade': { after: nextTurnNoAttack },
  'Photon Blaster': { after: nextTurnNoAttack },
  'Prism Edge': { after: nextTurnNoAttack },
  'Blood Moon': { after: nextTurnNoAttack },
  'Minor Errand-Running': { run: ctx => search(ctx.game, ctx.pid, c => isBasicEnergy(c), { max: 2, prompt: 'Search your deck for up to 2 Basic Energy' }) },
  'Miracle Force': { after: ctx => ctx.game.clearConditions(ctx.attacker) },
  'Balloon Blast': { base: ctx => 30 * ctx.game.counters(ctx.attacker) },
  'Vengeance Fletching': { base: ctx => ctx.printed + 10 * ctx.game.pl(ctx.pid).discard.filter(c => c.def.ancient).length },
  'Burst Roar': { run(ctx) { const g = ctx.game, p = g.pl(ctx.pid); for (const c of [...p.hand]) g.discard(c); draw(g, ctx.pid, 6); } },
  'Bellowing Thunder': {
    async base(ctx) {
      const g = ctx.game;
      let n = 0;
      for (const m of g.inPlay(ctx.pid)) {
        const es = m.energy.filter(c => isBasicEnergy(c));
        if (!es.length) continue;
        const got = await g.chooseCards(ctx.pid, es, { min: 0, max: es.length, prompt: `Bellowing Thunder: discard Basic Energy from ${m.name} (70 damage each)`, from: 'energy', hint: 'fuel:70' });
        for (const c of got) g.discard(c);
        n += got.length;
      }
      if (n) g.log(`${n} Energy discarded.`);
      return 70 * n;
    },
  },
  'Dig': { after(ctx) { if (ctx.game.flip('Dig')) ctx.game.addEffect({ kind: 'dig', mon: ctx.attacker.id, turn: ctx.game.turn + 1 }); } },
  'Phantom Dive': { after: ctx => spreadCounters(ctx.game, ctx.pid, 6, ctx.game.pl(ctx.opp).bench, ctx, "Put 6 damage counters on your opponent's Benched Pokémon in any way you like") },
  'Torrential Pump': {
    async after(ctx) {
      const g = ctx.game, m = ctx.attacker;
      if (m.energy.length < 3 || !oppBench(g, ctx.pid).length) return;
      if (!(await g.confirm(ctx.pid, 'Shuffle 3 Energy from this Pokémon into your deck to do 120 damage to a Benched Pokémon?', 'bench-snipe'))) return;
      const got = await g.chooseCards(ctx.pid, m.energy, { min: 3, max: 3, prompt: 'Shuffle 3 Energy into your deck', from: 'energy', hint: 'discard' });
      for (const c of got) g.moveTo(c, 'deck');
      g.shuffle(ctx.pid);
      const t = await g.chooseOneMon(ctx.pid, oppBench(g, ctx.pid), 'Choose a Benched Pokémon to take 120 damage', 'opp-damage:120');
      if (t) ctx.damageTo(t, 120);
    },
  },
  'Love Resonance': {
    base(ctx) {
      const g = ctx.game;
      const mine = new Set(g.inPlay(ctx.pid).map(m => m.def.type));
      return ctx.printed + (g.inPlay(ctx.opp).some(m => mine.has(m.def.type)) ? 120 : 0);
    },
  },
  'Mind Bend': { after: ctx => ctx.condition('confused') },
  'Myriad Leaf Shower': { base(ctx) { const g = ctx.game; const n = g.energyTypes(ctx.attacker).length + (ctx.defender ? g.energyTypes(ctx.defender).length : 0); return ctx.printed + 30 * n; } },
  'Full Moon Rondo': { base: ctx => ctx.printed + 20 * (ctx.game.pl(ctx.pid).bench.length + ctx.game.pl(ctx.opp).bench.length) },
  // Technical Machine: Evolution
  'Evolution': {
    async run(ctx) {
      const g = ctx.game, p = g.pl(ctx.pid);
      const can = p.bench.filter(m => p.deck.some(c => isMon(c) && c.def.from === m.name));
      const picks = await g.chooseMon(ctx.pid, can, { min: 0, max: 2, prompt: 'Choose up to 2 Benched Pokémon to evolve', hint: 'evolve' });
      for (const m of picks) {
        const opts = p.deck.filter(c => isMon(c) && c.def.from === m.name);
        const [c] = await g.chooseCards(ctx.pid, opts, { min: 1, max: 1, prompt: `Evolve ${m.name} into`, from: 'deck', hint: 'take', shown: p.deck });
        if (c) await g.evolve(ctx.pid, m, c);
      }
      g.shuffle(ctx.pid);
    },
  },
});

function discardStadium(g) {
  const s = g.stadium;
  if (!s) return;
  g.stadium = null;
  g.pl(s.card.owner).discard.push(s.card);
  g.log(`${s.card.name} is discarded.`);
}

Object.assign(ATTACKS, {
  // ---- Slowking
  'Dangle Tail': {
    async run(ctx) {
      const g = ctx.game, p = g.pl(ctx.pid);
      const [c] = await g.chooseCards(ctx.pid, p.discard.filter(isMon), { min: 1, max: 1, prompt: 'Put a Pokémon from your discard pile into your hand', from: 'discard' });
      if (c) { g.moveTo(c, 'hand'); g.log(`${p.name} puts ${c.name} into their hand.`); }
    },
  },
  'Seek Inspiration': {
    async run(ctx) {
      const g = ctx.game, p = g.pl(ctx.pid);
      const top = p.deck[0];
      if (!top) { g.log('There is no card to discard.'); return; }
      g.discard(top);
      g.log(`${p.name} discards ${top.name} from the top of their deck.`);
      if (!isMon(top) || ruleBox(top.def) || !(top.def.attacks || []).length) { g.log('Seek Inspiration has no effect.'); return; }
      await useAttackOf(ctx, top.def.attacks.map(atk => ({ def: top.def, atk })), `Choose one of ${top.name}'s attacks to use`);
    },
  },
  'Bounce Back': { after: switchOutDefender },
  'Metallic Hammer': {
    async base(ctx) {
      const g = ctx.game, m = ctx.attacker;
      const ms = m.energy.filter(c => c.def.provides === 'Metal' || c.def.anyType);
      if (ms.length < 3 || !(await g.confirm(ctx.pid, 'Discard 3 {M} Energy from this Pokémon for 150 more damage?', 'more-damage'))) return ctx.printed;
      const got = await g.chooseCards(ctx.pid, ms, { min: 3, max: 3, prompt: 'Discard 3 {M} Energy', from: 'energy', hint: 'discard' });
      for (const c of got) g.discard(c);
      g.log(`${got.length} {M} Energy discarded from ${m.name}.`);
      return ctx.printed + 150;
    },
  },
  'Trifrost': {
    async run(ctx) {
      const g = ctx.game;
      discardAllEnergy(g, ctx.attacker);
      const ts = await g.chooseMon(ctx.pid, g.inPlay(ctx.opp), { min: 3, max: 3, prompt: "Choose 3 of your opponent's Pokémon to take 110 damage each", hint: 'opp-damage:110' });
      for (const t of ts) ctx.damageTo(t, 110);
    },
  },
  'Ghostly Blow': {
    async after(ctx) {
      const g = ctx.game;
      const t = await g.chooseOneMon(ctx.pid, oppBench(g, ctx.pid), "Put 5 damage counters on which of your opponent's Benched Pokémon?", 'opp-counters:5');
      if (t && g.addCounters(t, 5, { ctx })) g.log(`5 damage counters on ${t.name}.`);
    },
  },
  'Thunder Raid': {
    async run(ctx) {
      const g = ctx.game;
      discardAllEnergy(g, ctx.attacker);
      const t = await g.chooseOneMon(ctx.pid, oppBench(g, ctx.pid).filter(m => m.def.ex), "Choose one of your opponent's Benched Pokémon ex to take 210 damage", 'opp-damage:210');
      if (t) ctx.damageTo(t, 210);
    },
  },
  // ---- N's Zoroark ex
  'Night Joker': {
    can: (g, mon) => (nightJokerChoices(g, mon.owner).length ? null : "No Benched N's Pokémon attack to use"),
    run: ctx => useAttackOf(ctx, nightJokerChoices(ctx.game, ctx.pid), "Choose one of your Benched N's Pokémon's attacks to use"),
  },
  'Shred': { opts: { ignoreEffects: true } },
  'Rampaging Thunder': { after: nextTurnNoAttack },
  'Powerful Rage': { base: ctx => 20 * ctx.game.counters(ctx.attacker) },
  'Thieving Swipe': {
    async after(ctx) {
      const g = ctx.game, o = g.pl(ctx.opp);
      g.log(`${o.name} reveals their hand: ${o.hand.map(c => c.name).join(', ') || 'nothing'}.`);
      if (!o.hand.length) return;
      const [c] = await g.chooseCards(ctx.pid, o.hand, { min: 1, max: 1, prompt: "Put a card from your opponent's hand on the bottom of their deck", from: 'opp-hand', hint: 'opp-discard' });
      if (c) { g.moveTo(c, 'deck'); g.log(`${c.name} goes to the bottom of ${o.name}'s deck.`); }
    },
  },
  // ---- Festival Lead
  'Whirlpool': {
    async after(ctx) {
      const g = ctx.game, d = ctx.defender;
      if (!d || !d.stack.length || !d.energy.length || !g.flip('Whirlpool') || g.effectsBlocked(ctx, d)) return;
      const [c] = await g.chooseCards(ctx.pid, d.energy, { min: 1, max: 1, prompt: `Discard an Energy from ${d.name}`, from: 'energy', hint: 'opp-discard' });
      if (c) { g.discard(c); g.log(`${c.name} is discarded from ${d.name}.`); }
    },
  },
  'Rapid Draw': { after: ctx => draw(ctx.game, ctx.pid, 2) },
  'Fighting Wings': { base: ctx => ctx.printed + (ctx.defender && ctx.defender.def.ex ? 90 : 0) },
  // ---- Alakazam Dusknoir
  'Teleportation Attack': { after: ctx => (ctx.attacker.stack.length && ctx.game.isActive(ctx.attacker) ? switchOwn(ctx.game, ctx.pid, 'Switch Abra with which Benched Pokémon?') : null) },
  'Powerful Hand': {
    run(ctx) {
      const g = ctx.game, d = ctx.defender, n = 2 * g.pl(ctx.pid).hand.length;
      if (!d || !n) return;
      if (g.addCounters(d, n, { ctx })) g.log(`${n} damage counters on ${d.name}.`);
      else g.log(`Powerful Hand has no effect on ${d.name}.`);
    },
  },
  // ---- Hydrapple ex
  'Push Down': { after: switchOutDefender },
  'Tumbling Attack': { base: ctx => ctx.printed + (ctx.game.flip('Tumbling Attack') ? 20 : 0) },
  'Do the Wave': { base: ctx => 20 * ctx.game.pl(ctx.pid).bench.length },
  'Syrup Storm': { base: ctx => ctx.printed + 30 * grassEnergyInPlay(ctx.game, ctx.pid) },
  'Traverse Time': { run: ctx => search(ctx.game, ctx.pid, c => (isMon(c) && c.def.type === 'Grass') || c.def.trainer === 'Stadium', { max: 3, prompt: 'Search your deck for up to 3 {G} Pokémon and Stadium cards' }) },
  // ---- Dhelmise
  'Puppet Pull': { after: ctx => search(ctx.game, ctx.pid, () => true, { max: 1, prompt: 'You may search your deck for a card' }) },
  'Furtive Drop': { run(ctx) { const d = ctx.defender; if (d && ctx.game.addCounters(d, 1, { ctx })) ctx.game.log(`1 damage counter on ${d.name}.`); } },
  'Matcha Spin': {
    run(ctx) {
      const g = ctx.game;
      if (sneakers(g, ctx.pid) < 6) return;
      for (const m of g.inPlay(ctx.opp)) if (g.addCounters(m, 4, { ctx })) g.log(`4 damage counters on ${m.name}.`);
    },
  },
  'Vengeful Anchor': { base: ctx => ctx.printed + (sneakers(ctx.game, ctx.pid) >= 4 ? 140 : 0) },
  'Spiritual End': {
    async run(ctx) {
      const g = ctx.game;
      if (sneakers(g, ctx.pid) < 13) return;
      const ts = await g.chooseMon(ctx.pid, g.inPlay(ctx.opp), { min: 2, max: 2, prompt: "Choose 2 of your opponent's Pokémon: quadruple their damage counters", hint: 'quadruple' });
      for (const t of ts) { const n = 3 * g.counters(t); if (n && g.addCounters(t, n, { ctx })) g.log(`${t.name} now has ${g.counters(t)} damage counters.`); }
    },
  },
  // ---- Mega Lopunny ex
  'Mirror Attack': { base: ctx => ctx.printed + (ctx.defender && ctx.defender.def.type === 'Psychic' ? 30 : 0) },
  'Evolution Jammer': { after: ctx => ctx.effect('evoLock', { pid: ctx.opp }) },
  'Run Around': { run: ctx => switchOwn(ctx.game, ctx.pid, 'Switch Buneary with which Benched Pokémon?') },
  // ---- Crustle
  'Ascension': {
    async run(ctx) {
      const g = ctx.game, p = g.pl(ctx.pid), m = ctx.attacker;
      const [c] = await g.chooseCards(ctx.pid, p.deck.filter(x => isMon(x) && x.def.from === m.name), { min: 0, max: 1, prompt: `Search your deck for a card that evolves from ${m.name}`, from: 'deck', hint: 'take', shown: p.deck });
      if (c) await g.evolve(ctx.pid, m, c);
      else g.log(`${p.name} searches their deck and finds nothing.`);
      g.shuffle(ctx.pid);
    },
  },
  'Superb Scissors': { opts: { ignoreEffects: true } },
  'Boundless Power': { after: nextTurnNoAttack },
  'Ready to Ram': { after: ctx => ctx.game.addEffect({ kind: 'readyToRam', mon: ctx.attacker.id, turn: ctx.game.turn + 1 }) },
  'Smashing Headbutt': { after: ctx => discardEnergyFrom(ctx.game, ctx.pid, ctx.attacker, 2) },
  // ---- Basic Box
  'Twin Shotels': {
    async run(ctx) {
      const g = ctx.game;
      const ts = await g.chooseMon(ctx.pid, g.inPlay(ctx.opp), { min: 2, max: 2, prompt: "Choose 2 of your opponent's Pokémon to take 50 damage each", hint: 'opp-damage-pierce:50' });
      for (const t of ts) ctx.damageTo(t, 50, { noWeakness: true, noResistance: true, ignoreEffects: true });
    },
  },
  'Coordinated Throwing': { base: ctx => 20 * ctx.game.inPlay(ctx.pid).filter(m => m.def.stage === 'Basic').length },
});

// ---------------------------------------------------------------- abilities
Object.assign(ABILITIES, {
  'Flip the Script': { oncePerPlayer: true, can: (g, m, pid) => !playerUsed(g, pid, 'Flip the Script') && koLastTurn(g, pid), use: (g, m, pid) => draw(g, pid, 3) },
  'Concealed Cards': {
    can: (g, m, pid) => !usedThisTurn(m, 'Concealed Cards', g) && g.pl(pid).hand.some(c => c.def.cat === 'E'),
    async use(g, m, pid) {
      const [c] = await g.chooseCards(pid, g.pl(pid).hand.filter(x => x.def.cat === 'E'), { min: 1, max: 1, prompt: 'Discard an Energy card from your hand', from: 'hand', hint: 'discard' });
      g.discard(c);
      draw(g, pid, 2);
    },
  },
  'Metallic Signal': {
    can: (g, m) => !usedThisTurn(m, 'Metallic Signal', g),
    use: (g, m, pid) => search(g, pid, c => isMon(c) && c.def.stage !== 'Basic' && c.def.type === 'Metal', { max: 2, prompt: 'Search your deck for up to 2 Evolution {M} Pokémon' }),
  },
  'Flower Selecting': {
    can: (g, m, pid) => !usedThisTurn(m, 'Flower Selecting', g) && g.isActive(m) && g.pl(pid).deck.length > 0,
    async use(g, m, pid) {
      const top = lookTop(g, pid, 2);
      const [keep] = await g.chooseCards(pid, top, { min: 1, max: 1, prompt: 'Put 1 card into your hand (the other goes to the Lost Zone)', from: 'deck-top', hint: 'take' });
      g.moveTo(keep, 'hand');
      for (const c of top) if (c !== keep) { g.moveTo(c, 'lost'); g.log(`${c.name} goes to the Lost Zone.`); }
    },
  },
  'Run Errand': { oncePerPlayer: true, can: (g, m, pid) => !playerUsed(g, pid, 'Run Errand') && g.isActive(m), use: (g, m, pid) => draw(g, pid, 2) },
  'Lunar Cycle': {
    oncePerPlayer: true,
    can: (g, m, pid) => !playerUsed(g, pid, 'Lunar Cycle') && g.inPlay(pid).some(x => x.name === 'Solrock') && g.pl(pid).hand.some(c => isBasicEnergy(c, 'Fighting')),
    async use(g, m, pid) {
      const [c] = await g.chooseCards(pid, g.pl(pid).hand.filter(x => isBasicEnergy(x, 'Fighting')), { min: 1, max: 1, prompt: 'Discard a Basic {F} Energy', from: 'hand', hint: 'discard' });
      g.discard(c);
      draw(g, pid, 3);
    },
  },
  'Transformative Start': {
    can: (g, m, pid) => turnOne(g, pid) && g.isActive(m) && !usedThisTurn(m, 'Transformative Start', g),
    async use(g, m, pid) {
      const p = g.pl(pid);
      const [c] = await g.chooseCards(pid, p.deck.filter(x => isBasicMon(x) && x.name !== 'Ditto'), { min: 0, max: 1, prompt: 'Choose a Basic Pokémon to replace Ditto', from: 'deck', hint: 'take', shown: p.deck });
      if (c) {
        g.removeFromZones(c);
        const nm = new (g.monClass())(g, c);
        g.removeMon(m);
        p.active = nm;
        g.log(`Ditto transforms into ${c.name}.`);
        g.event('enter', { mon: nm.id });
      }
      g.shuffle(pid);
    },
  },
  'Restart': { can: (g, m, pid) => !usedThisTurn(m, 'Restart', g) && g.pl(pid).hand.length < 3 && g.pl(pid).deck.length > 0, use: (g, m, pid) => draw(g, pid, 3 - g.pl(pid).hand.length) },
  'Infernal Reign': {
    async onEvolve(g, m, pid) {
      const got = await search(g, pid, c => isBasicEnergy(c, 'Fire'), { max: 3, prompt: 'Search your deck for up to 3 Basic {R} Energy', to: 'none', hint: 'attach' });
      await attachEach(g, pid, got, g.inPlay(pid), 'Attach');
    },
  },
  'Quick Search': { oncePerPlayer: true, can: (g, m, pid) => !playerUsed(g, pid, 'Quick Search') && g.pl(pid).deck.length > 0, use: (g, m, pid) => search(g, pid, () => true, { min: 1, max: 1, prompt: 'Search your deck for any card' }) },
  'Squawk and Seize': {
    oncePerPlayer: true,
    can: (g, m, pid) => turnOne(g, pid) && !playerUsed(g, pid, 'Squawk and Seize'),
    use(g, m, pid) { const p = g.pl(pid); for (const c of [...p.hand]) g.discard(c); draw(g, pid, 6); },
  },
  'Super Cold': {
    can: (g, m, pid) => g.pl(pid).hand.some(c => isBasicEnergy(c, 'Water')),
    async use(g, m, pid) {
      const [c] = await g.chooseCards(pid, g.pl(pid).hand.filter(x => isBasicEnergy(x, 'Water')), { min: 1, max: 1, prompt: 'Attach a Basic {W} Energy from your hand', from: 'hand', hint: 'attach' });
      const t = await g.chooseOneMon(pid, g.inPlay(pid), `Attach ${c.name} to which Pokémon?`, 'attach:Water');
      await g.attachEnergy(pid, t, c);
    },
  },
  'Shivery Chill': {
    can: (g, m, pid) => !usedThisTurn(m, 'Shivery Chill', g) && g.isActive(m),
    use: (g, m, pid) => search(g, pid, c => isBasicEnergy(c, 'Water'), { max: 2, prompt: 'Search your deck for up to 2 Basic {W} Energy' }),
  },
  'Coin Bonus': { can: (g, m) => !usedThisTurn(m, 'Coin Bonus', g), use: (g, m, pid) => draw(g, pid, g.isActive(m) ? 2 : 1) },
  'Hyper Blower': {
    can: (g, m, pid) => !usedThisTurn(m, 'Hyper Blower', g) && !g.isActive(m) && g.pl(g.opp(pid)).bench.length > 0,
    async use(g, m, pid) {
      const o = g.opp(pid), op = g.pl(o);
      const old = op.active;
      const nm = await g.chooseOneMon(o, op.bench, 'Your Active Pokémon is blown away: choose your new Active Pokémon', 'promote');
      g.switchActive(o, nm);
      g.log(`${old.name} is switched to the Bench; ${nm.name} comes in.`);
      g.log('Iron Bundle is discarded.');
      g.removeMon(m);
    },
  },
  'Last-Ditch Catch': {
    oncePerPlayer: 'Last-Ditch',
    can: (g, m, pid) => g.pl(pid).once['Last-Ditch'] !== g.turn,
    onBench: (g, m, pid) => search(g, pid, c => c.def.trainer === 'Supporter', { max: 1, prompt: 'Search your deck for a Supporter card' }),
  },
  'Cursed Blast': {
    selfKO: true,
    can: (g, m, pid) => !usedThisTurn(m, 'Cursed Blast', g) && g.inPlay(g.opp(pid)).some(x => !g.abilityBlocked(pid, x)),
    async use(g, m, pid) {
      const n = m.name === 'Dusknoir' ? 13 : 5;
      const t = await g.chooseOneMon(pid, g.inPlay(g.opp(pid)).filter(x => !g.abilityBlocked(pid, x)), `Put ${n} damage counters on which Pokémon?`, 'opp-counters:' + n);
      if (t) { g.addCounters(t, n); g.log(`${n} damage counters on ${t.name}.`); }
      m.damage = Math.max(m.damage, g.maxHp(m));
    },
  },
  'Jewel Seeker': { can: (g, m, pid) => tera(g, pid), onEvolve: (g, m, pid) => search(g, pid, c => c.def.cat === 'T', { max: 2, prompt: 'Search your deck for up to 2 Trainer cards' }) },
  'Fan Call': {
    oncePerPlayer: true,
    can: (g, m, pid) => turnOne(g, pid) && !playerUsed(g, pid, 'Fan Call'),
    use: (g, m, pid) => search(g, pid, c => isMon(c) && c.def.type === 'Colorless' && c.def.hp <= 100, { max: 3, prompt: 'Search your deck for up to 3 {C} Pokémon with 100 HP or less' }),
  },
  'Subjugating Chains': {
    oncePerPlayer: true,
    can: (g, m, pid) => !playerUsed(g, pid, 'Subjugating Chains') && g.pl(pid).bench.some(x => x.def.type === 'Darkness' && x.name !== 'Pecharunt ex'),
    async use(g, m, pid) {
      const t = await switchOwn(g, pid, 'Switch which Benched {D} Pokémon into the Active Spot?', x => x.def.type === 'Darkness' && x.name !== 'Pecharunt ex');
      if (t) g.setCondition(t, 'poisoned');
    },
  },
  'Snow Sink': { can: g => !!g.stadium, onBench(g) { discardStadium(g); } },
  'Overvolt Discharge': {
    selfKO: true,
    can: (g, m, pid) => !usedThisTurn(m, 'Overvolt Discharge', g) && g.pl(pid).discard.some(c => isBasicEnergy(c)),
    async use(g, m, pid) {
      const p = g.pl(pid);
      const got = await g.chooseCards(pid, p.discard.filter(c => isBasicEnergy(c)), { max: 3, prompt: 'Attach up to 3 Basic Energy from your discard pile', from: 'discard', hint: 'attach' });
      await attachEach(g, pid, got, g.inPlay(pid).filter(x => x.def.type === 'Lightning' && x !== m), 'Attach');
      m.damage = Math.max(m.damage, g.maxHp(m));
    },
  },
  'Tandem Unit': {
    can: (g, m, pid) => !usedThisTurn(m, 'Tandem Unit', g) && g.pl(pid).bench.length < g.benchLimit(pid),
    use: (g, m, pid) => search(g, pid, c => isBasicMon(c) && c.def.type === 'Lightning', { max: 2, prompt: 'Search your deck for up to 2 Basic {L} Pokémon to bench', to: 'bench', hint: 'bench' }),
  },
  'Psychic Embrace': {
    can: (g, m, pid) => g.pl(pid).discard.some(c => isBasicEnergy(c, 'Psychic')) && g.inPlay(pid).some(x => x.def.type === 'Psychic' && g.hpLeft(x) > 20),
    async use(g, m, pid) {
      const p = g.pl(pid);
      const [c] = await g.chooseCards(pid, p.discard.filter(x => isBasicEnergy(x, 'Psychic')), { min: 1, max: 1, prompt: 'Choose a Basic {P} Energy from your discard pile', from: 'discard', hint: 'attach' });
      const t = await g.chooseOneMon(pid, g.inPlay(pid).filter(x => x.def.type === 'Psychic' && g.hpLeft(x) > 20), 'Attach it to which {P} Pokémon? (2 damage counters go on it)', 'attach-embrace');
      await g.attachEnergy(pid, t, c);
      g.addCounters(t, 2);
    },
  },
  'Run Away Draw': {
    can: (g, m, pid) => !usedThisTurn(m, 'Run Away Draw', g) && g.pl(pid).deck.length > 0 && (!g.isActive(m) || g.pl(pid).bench.length > 0),
    async use(g, m, pid) {
      const got = draw(g, pid, 3);
      if (!got.length) return;
      const wasActive = g.isActive(m);
      g.log(`${m.name} and its attached cards are shuffled into the deck.`);
      g.removeMon(m, 'deck');
      g.shuffle(pid);
      if (wasActive) await g.promote(pid);
    },
  },
  'Rapid Vernier': {
    can: (g, m, pid) => !!g.pl(pid).active,
    async onBench(g, m, pid) {
      g.switchActive(pid, m);
      g.log(`${m.name} switches into the Active Spot.`);
      for (const o of g.inPlay(pid)) {
        if (o === m || !o.energy.length) continue;
        const got = await g.chooseCards(pid, o.energy, { min: 0, max: o.energy.length, prompt: `Move Energy from ${o.name} to ${m.name}?`, from: 'energy', hint: 'move-to-active' });
        for (const c of got) { o.energy.splice(o.energy.indexOf(c), 1); m.energy.push(c); }
        if (got.length) g.log(`${got.length} Energy moved from ${o.name} to ${m.name}.`);
      }
    },
  },
  'Recon Directive': {
    can: (g, m, pid) => !usedThisTurn(m, 'Recon Directive', g) && g.pl(pid).deck.length > 0,
    async use(g, m, pid) {
      const top = lookTop(g, pid, 2);
      const [keep] = await g.chooseCards(pid, top, { min: 1, max: 1, prompt: 'Put 1 card into your hand (the other goes on the bottom of your deck)', from: 'deck-top', hint: 'take' });
      g.moveTo(keep, 'hand');
      for (const c of top) if (c !== keep) { const p = g.pl(pid); p.deck.splice(p.deck.indexOf(c), 1); p.deck.push(c); }
    },
  },
  'Teal Dance': {
    can: (g, m, pid) => !usedThisTurn(m, 'Teal Dance', g) && g.pl(pid).hand.some(c => isBasicEnergy(c, 'Grass')),
    async use(g, m, pid) {
      const c = g.pl(pid).hand.find(x => isBasicEnergy(x, 'Grass'));
      await g.attachEnergy(pid, m, c);
      draw(g, pid, 1);
    },
  },
  'Adrena-Brain': {
    can: (g, m, pid) => !usedThisTurn(m, 'Adrena-Brain', g) && m.energy.some(c => c.def.provides === 'Darkness' || c.def.anyType) && g.inPlay(pid).some(x => x.damage > 0) && g.inPlay(g.opp(pid)).some(x => !g.abilityBlocked(pid, x)),
    async use(g, m, pid) {
      const from = await g.chooseOneMon(pid, g.inPlay(pid).filter(x => x.damage > 0), 'Move damage counters from which of your Pokémon?', 'own-damaged');
      const to = await g.chooseOneMon(pid, g.inPlay(g.opp(pid)).filter(x => !g.abilityBlocked(pid, x)), "Move them to which of your opponent's Pokémon?", 'opp-counters:3');
      const n = Math.min(3, g.counters(from));
      const k = await g.chooseOption(pid, Array.from({ length: n }, (_, i) => ({ value: n - i, label: `${n - i} damage counter${n - i > 1 ? 's' : ''}` })), 'Move how many damage counters?', 'max');
      from.damage -= 10 * k;
      g.addCounters(to, k);
      g.log(`${k} damage counter${k > 1 ? 's' : ''} moved from ${from.name} to ${to.name}.`);
    },
  },
  // ---- the newer decks
  'Trade': {
    can: (g, m, pid) => !usedThisTurn(m, 'Trade', g) && g.pl(pid).hand.length > 0 && g.pl(pid).deck.length > 0,
    async use(g, m, pid) {
      const [c] = await g.chooseCards(pid, g.pl(pid).hand, { min: 1, max: 1, prompt: 'Discard a card from your hand', from: 'hand', hint: 'discard' });
      if (c) { g.discard(c); g.log(`${g.pl(pid).name} discards ${c.name}.`); }
      draw(g, pid, 2);
    },
  },
  'Boom Boom Groove': {
    can: (g, m, pid) => !usedThisTurn(m, 'Boom Boom Groove', g) && !!g.pl(pid).active && g.hasAbility(g.pl(pid).active, 'Festival Lead') && g.pl(pid).deck.length > 0,
    use: (g, m, pid) => search(g, pid, () => true, { max: 1, prompt: 'Search your deck for a card' }),
  },
  'Teleporter': {
    can: (g, m, pid) => !usedThisTurn(m, 'Teleporter', g) && g.isActive(m) && g.pl(pid).bench.length > 0,
    async use(g, m, pid) {
      g.log(`${m.name} and its attached cards are shuffled into the deck.`);
      g.removeMon(m, 'deck');
      g.shuffle(pid);
      await g.promote(pid);
    },
  },
  // Kadabra draws 2, Alakazam 3, when evolved from the hand
  'Psychic Draw': { onEvolve: (g, m, pid) => draw(g, pid, m.name === 'Alakazam' ? 3 : 2) },
  'Ripening Charge': {
    can: (g, m, pid) => !usedThisTurn(m, 'Ripening Charge', g) && g.pl(pid).hand.some(c => isBasicEnergy(c, 'Grass')),
    async use(g, m, pid) {
      const [c] = await g.chooseCards(pid, g.pl(pid).hand.filter(x => isBasicEnergy(x, 'Grass')), { min: 1, max: 1, prompt: 'Attach a Basic {G} Energy from your hand', from: 'hand', hint: 'attach' });
      const t = await g.chooseOneMon(pid, g.inPlay(pid), `Attach ${c.name} to which Pokémon? (it heals 30 damage)`, 'attach-heal:Grass');
      await g.attachEnergy(pid, t, c);
      g.heal(t, 30);
    },
  },
});

// ---------------------------------------------------------------- trainers
const supporterSearch = (filter, max, prompt) => ({ can: g => true, play: (g, pid) => search(g, pid, filter, { max, prompt }) });
function iono(g) {
  const before = g.players.map(p => p.hand.length);
  for (const p of g.players) { g.rng.shuffle(p.hand); p.deck.push(...p.hand.splice(0)); }
  for (const p of g.players) if (before.some(n => n > 0)) { g.draw(p.id, p.prizes.length); }
  g.log('Each player shuffles their hand to the bottom of their deck and draws a card for each remaining Prize card.');
}
function healOwnActive(g, pid, n) { const a = g.pl(pid).active; if (a) g.heal(a, n); }

Object.assign(TRAINERS, {
  // ---- Items
  'Night Stretcher': {
    can: (g, pid) => g.pl(pid).discard.some(c => isMon(c) || isBasicEnergy(c)),
    async play(g, pid) {
      const [c] = await g.chooseCards(pid, g.pl(pid).discard.filter(c => isMon(c) || isBasicEnergy(c)), { min: 1, max: 1, prompt: 'Put a Pokémon or Basic Energy from your discard pile into your hand', from: 'discard' });
      if (c) { g.moveTo(c, 'hand'); g.log(`${g.pl(pid).name} puts ${c.name} into their hand.`); }
    },
  },
  'Hisuian Heavy Ball': {
    can: (g, pid) => g.pl(pid).prizes.length > 0,
    async play(g, pid, card) {
      const p = g.pl(pid);
      const [c] = await g.chooseCards(pid, p.prizes.filter(isBasicMon), { min: 0, max: 1, prompt: 'Your Prize cards: take a Basic Pokémon?', from: 'prizes', hint: 'take', shown: p.prizes });
      if (c) {
        p.prizes.splice(p.prizes.indexOf(c), 1);
        p.hand.push(c);
        p.inPlay = null;
        p.prizes.push(card);
        g.log(`${p.name} takes ${c.name} from their Prize cards and puts Hisuian Heavy Ball in its place.`);
      } else g.log(`${p.name} looks at their Prize cards.`);
      g.rng.shuffle(p.prizes);
    },
  },
  'Switch Cart': {
    can: (g, pid) => { const p = g.pl(pid); return p.bench.length > 0 && p.active && p.active.def.stage === 'Basic'; },
    async play(g, pid) { const old = g.pl(pid).active; if (await switchOwn(g, pid)) g.heal(old, 30); },
  },
  'Special Red Card': {
    can: (g, pid) => g.prizesLeft(g.opp(pid)) <= 3,
    play(g, pid) {
      const o = g.pl(g.opp(pid));
      const n = o.hand.length;
      g.rng.shuffle(o.hand); o.deck.push(...o.hand.splice(0));
      if (n) g.draw(o.id, 3);
      g.log(`${o.name} puts their hand on the bottom of their deck${n ? ' and draws 3 cards' : ''}.`);
    },
  },
  "Team Rocket's Transceiver": supporterSearch(c => c.def.trainer === 'Supporter' && /Team Rocket/.test(c.name), 1, 'Search your deck for a Team Rocket Supporter'),
  'Lost Vacuum': {
    can: (g, pid, card) => g.pl(pid).hand.some(c => c !== card) && (!!g.stadium || g.players.some(p => g.inPlay(p.id).some(m => m.tool))),
    async play(g, pid, card) {
      const p = g.pl(pid);
      const [cost] = await g.chooseCards(pid, p.hand.filter(c => c !== card), { min: 1, max: 1, prompt: 'Put a card from your hand in the Lost Zone', from: 'hand', hint: 'discard' });
      g.moveTo(cost, 'lost');
      const opts = [];
      if (g.stadium) opts.push({ value: 's', label: `Stadium: ${g.stadium.card.name}` });
      for (const q of g.players) for (const m of g.inPlay(q.id)) if (m.tool) opts.push({ value: 't' + m.id, label: `${m.tool.name} on ${q.id === pid ? 'your' : "your opponent's"} ${m.name}` });
      const v = await g.chooseOption(pid, opts, 'Put which Tool or Stadium in the Lost Zone?', 'remove');
      if (v === 's') { const s = g.stadium; g.stadium = null; g.pl(s.card.owner).lost.push(s.card); g.log(`${s.card.name} goes to the Lost Zone.`); }
      else { const m = g.monById(+String(v).slice(1)); if (m && m.tool) { const t = m.tool; m.tool = null; g.pl(t.owner).lost.push(t); g.log(`${t.name} goes to the Lost Zone.`); } }
    },
  },
  'Mirage Gate': {
    can: (g, pid) => g.pl(pid).lost.length >= 7,
    async play(g, pid) {
      const p = g.pl(pid);
      const first = await g.chooseCards(pid, p.deck.filter(c => isBasicEnergy(c)), { max: 1, prompt: 'Search your deck for a Basic Energy (1 of 2, different types)', from: 'deck', hint: 'attach', shown: p.deck });
      let got = first;
      if (first.length) got = got.concat(await g.chooseCards(pid, p.deck.filter(c => isBasicEnergy(c) && c.def.provides !== first[0].def.provides && !first.includes(c)), { max: 1, prompt: 'Search for a second Basic Energy of a different type', from: 'deck', hint: 'attach', shown: p.deck }));
      await attachEach(g, pid, got, g.inPlay(pid), 'Attach');
      g.shuffle(pid);
    },
  },
  'Energy Switch': {
    can: (g, pid) => g.inPlay(pid).length > 1 && g.inPlay(pid).some(m => m.energy.some(c => isBasicEnergy(c))),
    async play(g, pid) {
      const from = await g.chooseOneMon(pid, g.inPlay(pid).filter(m => m.energy.some(c => isBasicEnergy(c))), 'Move a Basic Energy from which Pokémon?', 'energy-from');
      const [c] = await g.chooseCards(pid, from.energy.filter(x => isBasicEnergy(x)), { min: 1, max: 1, prompt: 'Which Energy?', from: 'energy', hint: 'move' });
      const to = await g.chooseOneMon(pid, g.inPlay(pid).filter(m => m !== from), `Move ${c.name} to which Pokémon?`, 'attach:' + c.def.provides);
      from.energy.splice(from.energy.indexOf(c), 1);
      to.energy.push(c);
      g.log(`${c.name} moves from ${from.name} to ${to.name}.`);
    },
  },
  'Fighting Gong': supporterSearch(c => isBasicEnergy(c, 'Fighting') || (isBasicMon(c) && c.def.type === 'Fighting'), 1, 'Search your deck for a Basic {F} Energy or Basic {F} Pokémon'),
  'Rare Candy': {
    can: (g, pid) => g.pl(pid).turns > 1 && !g.evolutionJammed(pid) && candyPairs(g, pid).length > 0,
    async play(g, pid) {
      const pairs = candyPairs(g, pid);
      const v = await g.chooseOption(pid, pairs.map((x, i) => ({ value: i, label: `${g.isActive(x.m) ? 'Active' : 'Benched'} ${x.m.name} → ${x.c.name}`, mon: x.m.id, key: x.c.def.key })), 'Rare Candy: evolve which Pokémon?', 'candy');
      const { c, m } = pairs[v] || pairs[0];
      await g.evolve(pid, m, c, { fromHand: true });
    },
  },
  'Switch': { can: (g, pid) => g.pl(pid).bench.length > 0 && !!g.pl(pid).active, play: (g, pid) => switchOwn(g, pid) },
  'Ultra Ball': {
    can: (g, pid, card) => g.pl(pid).hand.filter(c => c !== card).length >= 2,
    async play(g, pid, card) { await discardCost(g, pid, 2, card); await search(g, pid, isMon, { max: 1, prompt: 'Search your deck for a Pokémon' }); },
  },
  'Super Rod': {
    can: (g, pid) => g.pl(pid).discard.some(c => isMon(c) || isBasicEnergy(c)),
    async play(g, pid) {
      const p = g.pl(pid);
      const got = await g.chooseCards(pid, p.discard.filter(c => isMon(c) || isBasicEnergy(c)), { min: 1, max: 3, prompt: 'Shuffle up to 3 Pokémon and Basic Energy from your discard pile into your deck', from: 'discard', hint: 'recover' });
      for (const c of got) g.moveTo(c, 'deck');
      g.shuffle(pid);
      g.log(`${p.name} shuffles ${got.map(c => c.name).join(', ')} into their deck.`);
    },
  },
  'Superior Energy Retrieval': {
    can: (g, pid, card) => g.pl(pid).hand.filter(c => c !== card).length >= 2 && g.pl(pid).discard.some(c => isBasicEnergy(c)),
    async play(g, pid, card) {
      const p = g.pl(pid);
      const before = new Set(p.discard.filter(c => isBasicEnergy(c)));
      await discardCost(g, pid, 2, card);
      const got = await g.chooseCards(pid, [...before], { min: 0, max: 4, prompt: 'Put up to 4 Basic Energy from your discard pile into your hand', from: 'discard' });
      for (const c of got) g.moveTo(c, 'hand');
      g.log(`${p.name} puts ${got.length} Energy into their hand.`);
    },
  },
  'Counter Catcher': { can: (g, pid) => g.prizesLeft(pid) > g.prizesLeft(g.opp(pid)) && gustable(g, pid), play: (g, pid) => gust(g, pid) },
  'Earthen Vessel': {
    can: (g, pid, card) => g.pl(pid).hand.some(c => c !== card),
    async play(g, pid, card) { await discardCost(g, pid, 1, card); await search(g, pid, c => isBasicEnergy(c), { max: 2, prompt: 'Search your deck for up to 2 Basic Energy' }); },
  },
  'Jumbo Ice Cream': { can: (g, pid) => { const a = g.pl(pid).active; return a && a.damage > 0 && a.energy.length >= 3; }, play: (g, pid) => healOwnActive(g, pid, 80) },
  'Crushing Hammer': {
    can: (g, pid) => g.inPlay(g.opp(pid)).some(m => m.energy.length),
    async play(g, pid) {
      if (!g.flip('Crushing Hammer')) return;
      const m = await g.chooseOneMon(pid, g.inPlay(g.opp(pid)).filter(x => x.energy.length), 'Discard an Energy from which of your opponent\'s Pokémon?', 'opp-energy');
      const [c] = await g.chooseCards(pid, m.energy, { min: 1, max: 1, prompt: 'Which Energy?', from: 'energy', hint: 'opp-discard' });
      g.discard(c);
      g.log(`${c.name} is discarded from ${m.name}.`);
    },
  },
  'Energy Search': supporterSearch(c => isBasicEnergy(c), 1, 'Search your deck for a Basic Energy'),
  'Poké Pad': supporterSearch(c => isMon(c) && !ruleBox(c.def), 1, 'Search your deck for a Pokémon without a Rule Box'),
  'Glass Trumpet': {
    can: (g, pid) => tera(g, pid) && g.pl(pid).bench.some(m => m.def.type === 'Colorless') && g.pl(pid).discard.some(c => isBasicEnergy(c)),
    async play(g, pid) {
      const p = g.pl(pid);
      const ts = await g.chooseMon(pid, p.bench.filter(m => m.def.type === 'Colorless'), { min: 1, max: 2, prompt: 'Choose up to 2 Benched {C} Pokémon', hint: 'attach' });
      for (const m of ts) {
        const [c] = await g.chooseCards(pid, p.discard.filter(x => isBasicEnergy(x)), { min: 1, max: 1, prompt: `Attach a Basic Energy from your discard pile to ${m.name}`, from: 'discard', hint: 'attach' });
        if (c) await g.attachEnergy(pid, m, c);
      }
    },
  },
  'Precious Trolley': {
    can: (g, pid) => g.pl(pid).bench.length < g.benchLimit(pid),
    play: (g, pid) => search(g, pid, isBasicMon, { max: 8, prompt: 'Put any number of Basic Pokémon onto your Bench', to: 'bench', hint: 'bench' }),
  },
  'Electric Generator': {
    can: (g, pid) => g.pl(pid).bench.some(m => m.def.type === 'Lightning'),
    async play(g, pid) {
      const p = g.pl(pid);
      const top = lookTop(g, pid, 5);
      g.log(`${p.name} looks at the top 5 cards: ${top.map(c => c.name).join(', ')}.`);
      const got = await g.chooseCards(pid, top.filter(c => isBasicEnergy(c, 'Lightning')), { max: 2, prompt: 'Attach up to 2 Basic {L} Energy to your Benched {L} Pokémon', from: 'deck-top', hint: 'attach', shown: top });
      await attachEach(g, pid, got, p.bench.filter(m => m.def.type === 'Lightning'), 'Attach');
      g.shuffle(pid);
    },
  },
  'Nest Ball': {
    can: (g, pid) => g.pl(pid).bench.length < g.benchLimit(pid),
    play: (g, pid) => search(g, pid, isBasicMon, { max: 1, prompt: 'Search your deck for a Basic Pokémon to put onto your Bench', to: 'bench', hint: 'bench' }),
  },
  'Picnic Basket': { can: g => g.players.some(p => g.inPlay(p.id).some(m => m.damage)), play(g) { for (const p of g.players) for (const m of g.inPlay(p.id)) g.heal(m, 30); } },
  'Pokégear 3.0': {
    can: (g, pid) => g.pl(pid).deck.length > 0,
    async play(g, pid) {
      const top = lookTop(g, pid, 7);
      const got = await g.chooseCards(pid, top.filter(c => c.def.trainer === 'Supporter'), { max: 1, prompt: 'Take a Supporter from the top 7 cards?', from: 'deck-top', shown: top });
      for (const c of got) { g.moveTo(c, 'hand'); g.log(`${g.pl(pid).name} reveals ${c.name} and puts it into their hand.`); }
      g.shuffle(pid);
    },
  },
  'Buddy-Buddy Poffin': {
    can: (g, pid) => g.pl(pid).bench.length < g.benchLimit(pid),
    play: (g, pid) => search(g, pid, c => isBasicMon(c) && c.def.hp <= 70, { max: 2, prompt: 'Search your deck for up to 2 Basic Pokémon with 70 HP or less', to: 'bench', hint: 'bench' }),
  },
  'Prime Catcher': {
    can: (g, pid) => gustable(g, pid),
    async play(g, pid) { if (await gust(g, pid)) await switchOwn(g, pid); },
  },
  'Secret Box': {
    can: (g, pid, card) => g.pl(pid).hand.filter(c => c !== card).length >= 3,
    async play(g, pid, card) {
      await discardCost(g, pid, 3, card);
      for (const [kind, label] of [['Item', 'an Item'], ['Tool', 'a Pokémon Tool'], ['Supporter', 'a Supporter'], ['Stadium', 'a Stadium']]) {
        await search(g, pid, c => c.def.trainer === kind, { max: 1, prompt: `Search your deck for ${label} card` });
      }
    },
  },
  'Unfair Stamp': {
    can: (g, pid) => koLastTurn(g, pid),
    play(g, pid) {
      for (const p of g.players) { p.deck.push(...p.hand.splice(0)); g.shuffle(p.id); }
      g.draw(pid, 5); g.draw(g.opp(pid), 2);
      g.log(`Each player shuffles their hand into their deck; ${g.pl(pid).name} draws 5 and ${g.pl(g.opp(pid)).name} draws 2.`);
    },
  },
  // ---- Supporters
  'Roxanne': {
    can: (g, pid) => g.prizesLeft(g.opp(pid)) <= 3,
    play(g, pid) { for (const p of g.players) shuffleHandIn(g, p.id); g.draw(pid, 6); g.draw(g.opp(pid), 2); g.log(`${g.pl(pid).name} draws 6 cards; ${g.pl(g.opp(pid)).name} draws 2.`); },
  },
  "Team Rocket's Petrel": supporterSearch(c => c.def.cat === 'T', 1, 'Search your deck for a Trainer card'),
  "Professor's Research": { play(g, pid) { const p = g.pl(pid); for (const c of [...p.hand]) g.discard(c); draw(g, pid, 7); } },
  "Colress's Experiment": {
    can: (g, pid) => g.pl(pid).deck.length > 0,
    async play(g, pid) {
      const top = lookTop(g, pid, 5);
      const keep = await g.chooseCards(pid, top, { min: Math.min(3, top.length), max: Math.min(3, top.length), prompt: 'Put 3 cards into your hand (the rest go to the Lost Zone)', from: 'deck-top' });
      for (const c of keep) g.moveTo(c, 'hand');
      for (const c of top) if (!keep.includes(c)) g.moveTo(c, 'lost');
      g.log(`${g.pl(pid).name} puts ${top.length - keep.length} card${top.length - keep.length === 1 ? '' : 's'} in the Lost Zone.`);
    },
  },
  "Boss's Orders": { can: (g, pid) => gustable(g, pid), play: (g, pid) => gust(g, pid) },
  "Lillie's Determination": { play(g, pid) { shuffleHandIn(g, pid); draw(g, pid, g.prizesLeft(pid) === 6 ? 8 : 6); } },
  'Arven': {
    async play(g, pid) {
      await search(g, pid, c => c.def.trainer === 'Item', { max: 1, prompt: 'Search your deck for an Item card' });
      await search(g, pid, c => c.def.trainer === 'Tool', { max: 1, prompt: 'Search your deck for a Pokémon Tool card' });
    },
  },
  'Iono': { play: g => iono(g) },
  "Professor Sada's Vitality": {
    can: (g, pid) => g.inPlay(pid).some(m => m.def.ancient) && g.pl(pid).discard.some(c => isBasicEnergy(c)),
    async play(g, pid) {
      const p = g.pl(pid);
      const ts = await g.chooseMon(pid, g.inPlay(pid).filter(m => m.def.ancient), { min: 1, max: 2, prompt: 'Choose up to 2 of your Ancient Pokémon', hint: 'attach' });
      let any = false;
      for (const m of ts) {
        const [c] = await g.chooseCards(pid, p.discard.filter(x => isBasicEnergy(x)), { min: 1, max: 1, prompt: `Attach a Basic Energy from your discard pile to ${m.name}`, from: 'discard', hint: 'attach' });
        if (c) { await g.attachEnergy(pid, m, c); any = true; }
      }
      if (any) draw(g, pid, 3);
    },
  },
  "Professor Turo's Scenario": {
    can: (g, pid) => g.inPlay(pid).length > 0,
    async play(g, pid) {
      const p = g.pl(pid);
      const m = await g.chooseOneMon(pid, g.inPlay(pid).filter(x => p.bench.length || !g.isActive(x)), 'Put which of your Pokémon into your hand?', 'scoop');
      if (!m) return;
      const wasActive = g.isActive(m), name = m.name;
      for (const c of [...m.energy, ...(m.tool ? [m.tool] : [])]) p.discard.push(c);
      for (const c of m.stack) p.hand.push(c);
      m.energy = []; m.tool = null; m.stack = [];
      if (p.active === m) p.active = null;
      p.bench = p.bench.filter(x => x !== m);
      g.effects = g.effects.filter(e => e.mon !== m.id);
      g.log(`${p.name} returns ${name} to their hand.`);
      if (wasActive) await g.promote(pid);
    },
  },
  'Dawn': {
    async play(g, pid) {
      for (const [st, label] of [['Basic', 'a Basic'], ['Stage1', 'a Stage 1'], ['Stage2', 'a Stage 2']]) await search(g, pid, c => isMon(c) && c.def.stage === st, { max: 1, prompt: `Search your deck for ${label} Pokémon` });
    },
  },
  'Judge': { play(g) { for (const p of g.players) { shuffleHandIn(g, p.id); g.draw(p.id, 4); } g.log('Each player shuffles their hand into their deck and draws 4 cards.'); } },
  "Rosa's Encouragement": {
    can: (g, pid) => g.prizesLeft(pid) > g.prizesLeft(g.opp(pid)) && g.inPlay(pid).some(m => m.def.stage === 'Stage2') && g.pl(pid).discard.some(c => isBasicEnergy(c)),
    async play(g, pid) {
      const p = g.pl(pid);
      const m = await g.chooseOneMon(pid, g.inPlay(pid).filter(x => x.def.stage === 'Stage2'), 'Attach up to 2 Basic Energy to which Stage 2 Pokémon?', 'attach');
      const got = await g.chooseCards(pid, p.discard.filter(c => isBasicEnergy(c)), { max: 2, prompt: 'Choose up to 2 Basic Energy from your discard pile', from: 'discard', hint: 'attach' });
      for (const c of got) await g.attachEnergy(pid, m, c);
    },
  },
  'Briar': { can: (g, pid) => g.prizesLeft(g.opp(pid)) === 2, play(g, pid) { g.pl(pid).briar = true; } },
  'Crispin': {
    async play(g, pid) {
      const p = g.pl(pid);
      const a = await g.chooseCards(pid, p.deck.filter(c => isBasicEnergy(c)), { max: 1, prompt: 'Search your deck for a Basic Energy (you may take 2 of different types)', from: 'deck', hint: 'attach', shown: p.deck });
      let got = a;
      if (a.length) got = got.concat(await g.chooseCards(pid, p.deck.filter(c => isBasicEnergy(c) && c.def.provides !== a[0].def.provides), { max: 1, prompt: 'A second Basic Energy of a different type?', from: 'deck', hint: 'attach', shown: p.deck }));
      if (got.length === 2) {
        const [toHand] = await g.chooseCards(pid, got, { min: 1, max: 1, prompt: 'Put which one into your hand? (the other is attached)', from: 'list', hint: 'hand-energy' });
        g.moveTo(toHand, 'hand');
        const other = got.find(c => c !== toHand);
        await attachEach(g, pid, [other], g.inPlay(pid), 'Attach');
      } else if (got.length === 1) g.moveTo(got[0], 'hand');
      g.shuffle(pid);
    },
  },
  "Xerosic's Machinations": {
    can: (g, pid) => g.pl(g.opp(pid)).hand.length > 3,
    async play(g, pid) {
      const o = g.pl(g.opp(pid));
      const n = o.hand.length - 3;
      const got = await g.chooseCards(o.id, o.hand, { min: n, max: n, prompt: `Discard ${n} card${n > 1 ? 's' : ''} from your hand`, from: 'hand', hint: 'discard' });
      for (const c of got) g.discard(c);
      g.log(`${o.name} discards ${got.map(c => c.name).join(', ')}.`);
    },
  },
  'Cyrano': supporterSearch(c => isMon(c) && c.def.ex, 3, 'Search your deck for up to 3 Pokémon ex'),
  "Lisia's Appeal": {
    can: (g, pid) => oppBench(g, pid).some(m => m.def.stage === 'Basic'),
    async play(g, pid) { const m = await gust(g, pid, { basicOnly: true }); if (m) g.setCondition(m, 'confused'); },
  },
  "Ciphermaniac's Codebreaking": {
    can: (g, pid) => g.pl(pid).deck.length > 0,
    async play(g, pid) {
      const p = g.pl(pid);
      const got = await g.chooseCards(pid, [...p.deck], { min: Math.min(2, p.deck.length), max: 2, prompt: 'Choose 2 cards to put on top of your deck (first chosen ends up on top)', from: 'deck', hint: 'topdeck', shown: p.deck });
      for (const c of got) p.deck.splice(p.deck.indexOf(c), 1);
      g.shuffle(pid);
      p.deck.unshift(...got);
      g.log(`${p.name} puts 2 cards on top of their deck.`);
    },
  },
  "Explorer's Guidance": {
    can: (g, pid) => g.pl(pid).deck.length > 0,
    async play(g, pid) {
      const top = lookTop(g, pid, 6);
      const keep = await g.chooseCards(pid, top, { min: Math.min(2, top.length), max: Math.min(2, top.length), prompt: 'Put 2 cards into your hand (the others are discarded)', from: 'deck-top' });
      for (const c of keep) g.moveTo(c, 'hand');
      for (const c of top) if (!keep.includes(c)) g.discard(c);
    },
  },
  'Carmine': { play(g, pid) { const p = g.pl(pid); for (const c of [...p.hand]) g.discard(c); draw(g, pid, 5); } },
  "Lana's Aid": {
    can: (g, pid) => g.pl(pid).discard.some(c => (isMon(c) && !ruleBox(c.def)) || isBasicEnergy(c)),
    async play(g, pid) {
      const p = g.pl(pid);
      const got = await g.chooseCards(pid, p.discard.filter(c => (isMon(c) && !ruleBox(c.def)) || isBasicEnergy(c)), { max: 3, prompt: 'Put up to 3 Pokémon without a Rule Box and Basic Energy into your hand', from: 'discard' });
      for (const c of got) g.moveTo(c, 'hand');
    },
  },
  // ---- Tools (passive: read by the engine)
  'Air Balloon': {}, 'Bravery Charm': {}, 'Luxurious Cape': {}, 'Defiance Band': {}, 'Vitality Band': {}, 'Rescue Board': {}, 'Sparkling Crystal': {},
  'Ancient Booster Energy Capsule': {},
  'Technical Machine: Evolution': {},
  // ---- Stadiums
  'Artazon': {
    stadiumCan: (g, pid) => g.pl(pid).bench.length < g.benchLimit(pid),
    stadiumUse: (g, pid) => search(g, pid, c => isBasicMon(c) && !ruleBox(c.def), { max: 1, prompt: 'Search your deck for a Basic Pokémon without a Rule Box to bench', to: 'bench', hint: 'bench' }),
  },
  'Mystery Garden': {
    stadiumCan: (g, pid) => { const p = g.pl(pid); return p.hand.some(c => c.def.cat === 'E') && g.inPlay(pid).filter(m => m.def.type === 'Psychic').length > p.hand.length - 1; },
    async stadiumUse(g, pid) {
      const p = g.pl(pid);
      const [c] = await g.chooseCards(pid, p.hand.filter(x => x.def.cat === 'E'), { min: 1, max: 1, prompt: 'Discard an Energy card', from: 'hand', hint: 'discard' });
      g.discard(c);
      const n = g.inPlay(pid).filter(m => m.def.type === 'Psychic').length - p.hand.length;
      if (n > 0) draw(g, pid, n);
    },
  },
  'Surfing Beach': {
    stadiumCan: (g, pid) => { const p = g.pl(pid); return p.active && p.active.def.type === 'Water' && p.bench.some(m => m.def.type === 'Water'); },
    stadiumUse: (g, pid) => switchOwn(g, pid, 'Switch your Active {W} Pokémon with which Benched {W} Pokémon?', m => m.def.type === 'Water'),
  },
  'Academy at Night': {
    stadiumCan: (g, pid) => g.pl(pid).hand.length > 0,
    async stadiumUse(g, pid) {
      const p = g.pl(pid);
      const [c] = await g.chooseCards(pid, p.hand, { min: 1, max: 1, prompt: 'Put a card from your hand on top of your deck', from: 'hand', hint: 'topdeck' });
      g.moveTo(c, 'deck', { top: true });
    },
  },
  'Risky Ruins': {}, "Team Rocket's Watchtower": {}, 'Area Zero Underdepths': {}, 'Lively Stadium': {},
});

// ---------------------------------------------------------------- trainers of the newer decks
const handTotal = (g, pid) => g.pl(pid).hand.length;
Object.assign(TRAINERS, {
  // ---- Items
  'Wondrous Patch': {
    can: (g, pid) => g.pl(pid).discard.some(c => isBasicEnergy(c, 'Psychic')) && g.pl(pid).bench.some(m => m.def.type === 'Psychic'),
    async play(g, pid) {
      const p = g.pl(pid);
      const [c] = await g.chooseCards(pid, p.discard.filter(x => isBasicEnergy(x, 'Psychic')), { min: 1, max: 1, prompt: 'Attach a Basic {P} Energy from your discard pile', from: 'discard', hint: 'attach' });
      const m = await g.chooseOneMon(pid, p.bench.filter(x => x.def.type === 'Psychic'), 'Attach it to which Benched {P} Pokémon?', 'attach:Psychic');
      if (c && m) await g.attachEnergy(pid, m, c);
    },
  },
  "N's PP Up": {
    can: (g, pid) => g.pl(pid).discard.some(c => isBasicEnergy(c)) && g.pl(pid).bench.some(isNs),
    async play(g, pid) {
      const p = g.pl(pid);
      const [c] = await g.chooseCards(pid, p.discard.filter(x => isBasicEnergy(x)), { min: 1, max: 1, prompt: 'Attach a Basic Energy from your discard pile', from: 'discard', hint: 'attach' });
      const m = await g.chooseOneMon(pid, p.bench.filter(isNs), `Attach ${c.name} to which Benched N's Pokémon?`, 'attach:' + c.def.provides);
      if (c && m) await g.attachEnergy(pid, m, c);
    },
  },
  'Strange Timepiece': {
    can: (g, pid) => g.inPlay(pid).some(m => m.stack.length > 1 && m.def.type === 'Psychic'),
    async play(g, pid) {
      const p = g.pl(pid);
      const m = await g.chooseOneMon(pid, g.inPlay(pid).filter(x => x.stack.length > 1 && x.def.type === 'Psychic'), 'Devolve which of your evolved {P} Pokémon?', 'devolve');
      if (!m) return;
      const levels = m.stack.length - 1;
      const k = levels === 1 ? 1 : await g.chooseOption(pid, Array.from({ length: levels }, (_, i) => ({ value: i + 1, label: `Put ${i + 1} Evolution card${i ? 's' : ''} into your hand` })), `Devolve ${m.name} by how many stages?`, 'devolve-n');
      const off = m.stack.splice(m.stack.length - k, k);
      p.hand.push(...off);
      m.noEvolveTurn = g.turn;
      g.clearConditions(m);
      g.effects = g.effects.filter(e => e.mon !== m.id);
      g.log(`${p.name} devolves ${off[off.length - 1].name} into ${m.name}, putting ${off.map(c => c.name).join(' and ')} into their hand.`);
      g.event('evolve', { mon: m.id });
    },
  },
  'Sacred Ash': {
    can: (g, pid) => g.pl(pid).discard.some(isMon),
    async play(g, pid) {
      const p = g.pl(pid);
      const got = await g.chooseCards(pid, p.discard.filter(isMon), { min: 1, max: 5, prompt: 'Shuffle up to 5 Pokémon from your discard pile into your deck', from: 'discard', hint: 'recover' });
      for (const c of got) g.moveTo(c, 'deck');
      g.shuffle(pid);
      g.log(`${p.name} shuffles ${got.map(c => c.name).join(', ')} into their deck.`);
    },
  },
  'Bug Catching Set': {
    can: (g, pid) => g.pl(pid).deck.length > 0,
    async play(g, pid) {
      const top = lookTop(g, pid, 7);
      const got = await g.chooseCards(pid, top.filter(c => (isMon(c) && c.def.type === 'Grass') || isBasicEnergy(c, 'Grass')), { max: 2, prompt: 'Put up to 2 {G} Pokémon and Basic {G} Energy into your hand', from: 'deck-top', shown: top });
      for (const c of got) g.moveTo(c, 'hand');
      if (got.length) g.log(`${g.pl(pid).name} reveals ${got.map(c => c.name).join(', ')} and puts them into their hand.`);
      g.shuffle(pid);
    },
  },
  // ---- Supporters
  'Surfer': {
    can: (g, pid) => g.pl(pid).bench.length > 0 && !!g.pl(pid).active,
    async play(g, pid) {
      if (!(await switchOwn(g, pid))) return;
      const n = 5 - handTotal(g, pid);
      if (n > 0) draw(g, pid, n);
    },
  },
  "Black Belt's Training": { play(g, pid) { g.addEffect({ kind: 'blackBelt', pid, turn: g.turn }); g.log('This turn, attacks do 40 more damage to the opponent\'s Active Pokémon ex.'); } },
  "Janine's Secret Art": {
    can: (g, pid) => g.inPlay(pid).some(m => m.def.type === 'Darkness'),
    async play(g, pid) {
      const p = g.pl(pid);
      const ts = await g.chooseMon(pid, g.inPlay(pid).filter(m => m.def.type === 'Darkness'), { min: 0, max: 2, prompt: 'Choose up to 2 of your {D} Pokémon to attach a Basic {D} Energy to', hint: 'attach:Darkness' });
      let active = false;
      for (const m of ts) {
        const [c] = await g.chooseCards(pid, p.deck.filter(x => isBasicEnergy(x, 'Darkness')), { min: 1, max: 1, prompt: `Search your deck for a Basic {D} Energy to attach to ${m.name}`, from: 'deck', hint: 'attach', shown: p.deck });
        if (!c) continue;
        await g.attachEnergy(pid, m, c);
        if (g.isActive(m)) active = true;
      }
      g.shuffle(pid);
      if (active && p.active) g.setCondition(p.active, 'poisoned');
    },
  },
  "Gladion's Final Battle": {
    can: (g, pid, card) => { const h = g.pl(pid).hand; return h.length === 1 && h[0] === card; },
    play(g, pid) { g.addEffect({ kind: 'gladion', pid, turn: g.turn }); g.log('This turn, attacks by Pokémon without a Rule Box do 80 more damage to the opponent\'s Active Pokémon.'); },
  },
  'Hilda': {
    async play(g, pid) {
      await search(g, pid, c => isMon(c) && c.def.stage !== 'Basic', { max: 1, prompt: 'Search your deck for an Evolution Pokémon' });
      await search(g, pid, c => c.def.cat === 'E', { max: 1, prompt: 'Search your deck for an Energy card' });
    },
  },
  'Gwynn': {
    can: (g, pid) => g.pl(pid).hand.some(c => isMon(c) && !ruleBox(c.def)),
    async play(g, pid) {
      const p = g.pl(pid);
      const got = await g.chooseCards(pid, p.hand.filter(c => isMon(c) && !ruleBox(c.def)), { min: 0, max: 2, prompt: 'Discard up to 2 Pokémon without a Rule Box (draw 3 cards for each)', from: 'hand', hint: 'discard-draw' });
      for (const c of got) g.discard(c);
      if (got.length) { g.log(`${p.name} discards ${got.map(c => c.name).join(', ')}.`); draw(g, pid, 3 * got.length); }
    },
  },
  'Naveen': {
    can: (g, pid) => g.pl(pid).deck.length > 0,
    async play(g, pid) {
      const p = g.pl(pid);
      const got = await g.chooseCards(pid, p.hand, { min: 0, max: p.hand.length, prompt: 'Discard any number of cards first? (then draw until you have 5)', from: 'hand', hint: 'discard-any' });
      for (const c of got) g.discard(c);
      if (got.length) g.log(`${p.name} discards ${got.map(c => c.name).join(', ')}.`);
      const n = 5 - p.hand.length;
      if (n > 0) draw(g, pid, n);
    },
  },
  'Eri': {
    can: (g, pid) => g.pl(g.opp(pid)).hand.length > 0,
    async play(g, pid) {
      const o = g.pl(g.opp(pid));
      g.log(`${o.name} reveals their hand: ${o.hand.map(c => c.name).join(', ')}.`);
      const got = await g.chooseCards(pid, o.hand.filter(c => c.def.trainer === 'Item'), { max: 2, prompt: "Discard up to 2 Item cards from your opponent's hand", from: 'opp-hand', hint: 'opp-discard-n' });
      for (const c of got) g.discard(c);
      if (got.length) g.log(`${got.map(c => c.name).join(', ')} discarded from ${o.name}'s hand.`);
    },
  },
  "Brock's Scouting": {
    async play(g, pid) {
      const p = g.pl(pid);
      const opts = [];
      if (p.deck.some(isBasicMon)) opts.push({ value: 'basic', label: 'Up to 2 Basic Pokémon' });
      if (p.deck.some(c => isMon(c) && c.def.stage !== 'Basic')) opts.push({ value: 'evo', label: '1 Evolution Pokémon' });
      const v = opts.length > 1 ? await g.chooseOption(pid, opts, "Brock's Scouting: search for what?", 'brock') : opts.length ? opts[0].value : null;
      if (v === 'evo') await search(g, pid, c => isMon(c) && c.def.stage !== 'Basic', { max: 1, prompt: 'Search your deck for an Evolution Pokémon' });
      else await search(g, pid, isBasicMon, { max: 2, prompt: 'Search your deck for up to 2 Basic Pokémon' });
    },
  },
  'Pokémon Center Lady': {
    can: (g, pid) => g.inPlay(pid).some(m => m.damage || m.special || m.poisoned || m.burned),
    async play(g, pid) {
      const m = await g.chooseOneMon(pid, g.inPlay(pid).filter(x => x.damage || x.special || x.poisoned || x.burned), 'Heal 60 damage from which of your Pokémon?', 'own-damaged');
      if (!m) return;
      g.heal(m, 60);
      if (m.special || m.poisoned || m.burned) { g.clearConditions(m); g.log(`${m.name} recovers from its Special Conditions.`); }
    },
  },
  // ---- Tools (passive: read by the engine)
  'Lucky Helmet': {}, 'Binding Mochi': {}, 'Brave Bangle': {}, "Hero's Cape": {},
  // ---- Stadiums
  "N's Castle": {}, 'Festival Grounds': {}, 'Forest of Vitality': {}, 'Jamming Tower': {},
  'Prism Tower': {
    stadiumCan: (g, pid) => g.pl(pid).hand.length >= 2 && g.pl(pid).deck.length > 0,
    async stadiumUse(g, pid) {
      await discardCost(g, pid, 2, null, 'Discard 2 cards from your hand to draw a card');
      draw(g, pid, 1);
    },
  },
  "Team Rocket's Factory": {
    stadiumCan: (g, pid) => /Team Rocket/.test(g.pl(pid).supporterName || '') && g.pl(pid).deck.length > 0,
    stadiumUse: (g, pid) => draw(g, pid, 2),
  },
});

// ---------------------------------------------------------------- Special Energy that acts when attached from the hand
Object.assign(ENERGIES, {
  'Enriching Energy': { onAttach: (g, m, pid) => draw(g, pid, 4) },
  'Telepathic Psychic Energy': {
    can: (g, m, pid) => m.def.type === 'Psychic',
    onAttach: (g, m, pid) => search(g, pid, c => isBasicMon(c) && c.def.type === 'Psychic', { max: 2, prompt: 'Search your deck for up to 2 Basic {P} Pokémon to put onto your Bench', to: 'bench', hint: 'bench' }),
  },
});

// ================================================================ the third wave of decks
// helpers
// "This Pokémon also does N damage to itself" (not affected by Weakness, Resistance or effects)
function selfDamage(ctx, n) {
  const g = ctx.game, m = ctx.attacker;
  if (!m.stack.length || n <= 0) return;
  m.damage += n;
  g.log(`${m.name} does ${n} damage to itself.`);
  g.event('damage', { mon: m.id, amount: n });
}
// "During your next turn, this Pokémon can't use <this attack>"
const cantUseNext = ctx => ctx.game.addEffect({ kind: 'cantUse', mon: ctx.attacker.id, name: ctx.atk.name, turn: ctx.game.turn + 2 });
// "Draw cards until you have N cards in your hand"
function drawUntil(g, pid, n) { const k = n - g.pl(pid).hand.length; return k > 0 ? draw(g, pid, k) : []; }
// "N damage to 1 of your opponent's Benched Pokémon" (Weakness and Resistance don't apply on the Bench)
async function benchHit(ctx, n) {
  const g = ctx.game;
  const t = await g.chooseOneMon(ctx.pid, oppBench(g, ctx.pid), `Choose one of your opponent's Benched Pokémon to take ${n} damage`, 'opp-damage:' + n);
  if (t) ctx.damageTo(t, n);
  return t;
}
const isTR = c => /^Team Rocket's /.test(c.name);
const trSupporter = c => c.def.trainer === 'Supporter' && /Team Rocket/.test(c.name);
const named = prefix => c => c.name.startsWith(prefix);

Object.assign(ATTACKS, {
  // ---- Mega Excadrill ex
  'Iron Tackle': { after: ctx => selfDamage(ctx, 10) },
  'Undermine': {
    after(ctx) {
      const g = ctx.game, o = g.pl(ctx.opp);
      const got = o.deck.slice(0, 2);
      for (const c of got) g.discard(c);
      g.log(got.length ? `${got.map(c => c.name).join(' and ')} discarded from the top of ${o.name}'s deck.` : `${o.name}'s deck is empty.`);
    },
  },
  'Maximum Drilling': { base: ctx => ctx.printed + (ctx.game.energyTypes(ctx.attacker).length - ctx.game.attackCost(ctx.attacker, ctx.atk).length >= 2 ? 130 : 0) },
  'Sonic Ripper': {
    async run(ctx) {
      const g = ctx.game, m = ctx.attacker;
      if (m.energy.length) {
        const n = m.energy.length;
        for (const c of [...m.energy]) g.moveTo(c, 'deck');
        g.shuffle(ctx.pid);
        g.log(`${n} Energy from ${m.name} shuffled into the deck.`);
      }
      await hitOne(ctx, 220);
    },
  },
  // ---- Mega Lucario ex
  'Accelerating Stab': { after: cantUseNext },
  'Mega Brave': { after: cantUseNext },
  'Aura Jab': {
    async after(ctx) {
      const g = ctx.game, p = g.pl(ctx.pid);
      if (!p.bench.length) return;
      const got = await g.chooseCards(ctx.pid, p.discard.filter(c => isBasicEnergy(c, 'Fighting')), { max: 3, prompt: 'Attach up to 3 Basic {F} Energy from your discard pile to your Benched Pokémon', from: 'discard', hint: 'attach' });
      await attachEach(g, ctx.pid, got, p.bench, 'Attach');
    },
  },
  'Wild Press': { after: ctx => selfDamage(ctx, 70) },
  // ---- Mega Sharpedo ex
  'Reckless Charge': { after: ctx => selfDamage(ctx, 10) },
  'Greedy Fang': { after: ctx => draw(ctx.game, ctx.pid, 2) },
  'Hungry Jaws': { base: ctx => ctx.printed + (ctx.attacker.damage > 0 ? 150 : 0) },
  // ---- Rocket's Honchkrow
  'Deceit': { run: ctx => search(ctx.game, ctx.pid, c => c.def.trainer === 'Supporter', { max: 1, prompt: 'Search your deck for a Supporter card' }) },
  'Torment': {
    async after(ctx) {
      const g = ctx.game, d = ctx.defender;
      if (!d || !d.stack.length || g.effectsBlocked(ctx, d) || !(d.def.attacks || []).length) return;
      const name = await g.chooseOption(ctx.pid, d.def.attacks.map(a => ({ value: a.name, label: `${a.name}${a.damage ? ` (${a.damage})` : ''}`, key: d.def.key, atk: a.name })), `Choose one of ${d.name}'s attacks: it can't be used during your opponent's next turn`, 'torment');
      g.addEffect({ kind: 'cantUse', mon: d.id, name, turn: g.turn + 1 });
      g.log(`${d.name} can't use ${name} during its next turn.`);
    },
  },
  'Rocket Feathers': {
    async base(ctx) {
      const g = ctx.game, p = g.pl(ctx.pid);
      const opts = p.hand.filter(trSupporter);
      const got = await g.chooseCards(ctx.pid, opts, { min: 0, max: opts.length, prompt: 'Rocket Feathers: discard Team Rocket Supporter cards from your hand (60 damage each)', from: 'hand', hint: 'fuel:60' });
      for (const c of got) g.discard(c);
      if (got.length) g.log(`${got.length} Team Rocket Supporter card${got.length > 1 ? 's' : ''} discarded.`);
      return 60 * got.length;
    },
  },
  'Hacking': {
    async run(ctx) {
      const g = ctx.game, p = g.pl(ctx.pid), o = g.pl(ctx.opp);
      if (!p.hand.length) { g.log('Hacking has no effect.'); return; }
      const [c] = await g.chooseCards(ctx.pid, p.hand, { min: 1, max: 1, prompt: 'Discard a card from your hand', from: 'hand', hint: 'discard' });
      if (!c) return;
      g.discard(c);
      g.log(`${p.name} discards ${c.name}.`);
      if (!o.hand.length) return;
      const [x] = await g.chooseCards(ctx.opp, o.hand, { min: 1, max: 1, prompt: 'Discard a card from your hand', from: 'hand', hint: 'discard' });
      if (x) { g.discard(x); g.log(`${o.name} discards ${x.name}.`); }
    },
  },
  'R Command': { base: ctx => 20 * ctx.game.pl(ctx.pid).discard.filter(trSupporter).length },
  'Dark Frost': { base: ctx => ctx.printed + (ctx.attacker.energy.some(c => c.name === "Team Rocket's Energy") ? 60 : 0) },
  'Gemstone Mimicry': {
    can: (g, mon) => { const d = g.pl(g.opp(mon.owner)).active; return d && d.def.tera && (d.def.attacks || []).length ? null : 'Needs an opposing Active Tera Pokémon'; },
    run(ctx) {
      const d = ctx.defender;
      if (!d || !d.def.tera) return null;
      return useAttackOf(ctx, (d.def.attacks || []).map(atk => ({ def: d.def, atk })), `Choose one of ${d.name}'s attacks to use`);
    },
  },
  // ---- Cynthia's Garchomp ex
  'Rock Hurl': { opts: { noResistance: true } },
  'Corkscrew Dive': {
    async after(ctx) {
      const g = ctx.game, p = g.pl(ctx.pid);
      if (p.hand.length >= 6 || !p.deck.length) return;
      if (await g.confirm(ctx.pid, 'Draw cards until you have 6 cards in your hand?', 'draw-to-6')) drawUntil(g, ctx.pid, 6);
    },
  },
  'Draconic Buster': { after: ctx => discardAllEnergy(ctx.game, ctx.attacker) },
  'Raging Curse': {
    base: ctx => 10 * ctx.game.pl(ctx.pid).bench.filter(named("Cynthia's ")).reduce((s, m) => s + ctx.game.counters(m), 0),
    opts: { noWeakness: true },
  },
  // ---- Mew Box
  'Teleportation Burst': {
    async after(ctx) {
      const g = ctx.game, m = ctx.attacker;
      if (!m.stack.length || !g.isActive(m) || !g.pl(ctx.pid).bench.length) return;
      if (await g.confirm(ctx.pid, `Switch ${m.name} with one of your Benched Pokémon?`, 'teleport')) await switchOwn(g, ctx.pid, `Switch ${m.name} with which Benched Pokémon?`);
    },
  },
  'Orichalcum Fang': { base: ctx => ctx.printed + (ctx.game.koDuring(ctx.pid, { byAttack: true }) ? 120 : 0) },
  'Impact Blow': { after: cantUseNext },
  'Wish Granter': { run: ctx => { drawUntil(ctx.game, ctx.pid, 7); } },
  'Swift': { opts: { noWeakness: true, noResistance: true, ignoreEffects: true } },
  'Mysterious Signal': { after(ctx) { if (ctx.defender) ctx.extraPrize.add(ctx.defender); } },
  // ---- Marnie's Grimmsnarl ex
  'Filch': { run: ctx => { draw(ctx.game, ctx.pid, 1); } },
  'Shadow Bullet': { after: ctx => benchHit(ctx, 30) },
  // ---- Hop's Trevenant
  'Splashing Dodge': { after(ctx) { if (ctx.game.flip('Splashing Dodge')) { ctx.game.addEffect({ kind: 'dig', mon: ctx.attacker.id, turn: ctx.game.turn + 1 }); ctx.game.log(`${ctx.attacker.name} will dodge attacks next turn.`); } } },
  'Horrifying Revenge': { base: ctx => ctx.printed + (ctx.game.koDuring(ctx.pid, { byAttack: true, filter: n => n.startsWith("Hop's ") }) ? 100 : 0) },
  'Corner': { after: defenderNoRetreat },
  'Dynamic Press': { after: ctx => selfDamage(ctx, 80) },
  'Insta-Strike': { after: ctx => benchHit(ctx, 30) },
  'Brave Slash': { after: cantUseNext },
  'Fickle Spitting': {
    run(ctx) {
      const n = ctx.game.prizesLeft(ctx.opp);
      if (n === 3 || n === 4) ctx.damage(120);
      else ctx.game.log('Fickle Spitting does nothing.');
    },
  },
});

Object.assign(ABILITIES, {
  // Metang: Basic {M} Energy from the top 4 cards, attached any way you like; the rest go to the bottom
  'Metal Maker': {
    can: (g, m, pid) => !usedThisTurn(m, 'Metal Maker', g) && g.pl(pid).deck.length > 0,
    async use(g, m, pid) {
      const p = g.pl(pid);
      const top = lookTop(g, pid, 4);
      g.log(`${p.name} looks at the top ${top.length} cards of their deck.`);
      const got = await g.chooseCards(pid, top.filter(c => isBasicEnergy(c, 'Metal')), { min: 0, max: 4, prompt: 'Attach any number of Basic {M} Energy to your Pokémon', from: 'deck-top', hint: 'attach', shown: top });
      await attachEach(g, pid, got, g.inPlay(pid), 'Attach');
      const rest = top.filter(c => !got.includes(c) && p.deck.includes(c));
      for (const c of rest) p.deck.splice(p.deck.indexOf(c), 1);
      g.rng.shuffle(rest);
      p.deck.push(...rest);
      if (rest.length) g.log(`${rest.length} card${rest.length > 1 ? 's go' : ' goes'} to the bottom of the deck.`);
    },
  },
  // Toxtricity: a Basic {D} Energy from the deck onto a Benched {D} Pokémon, which takes 2 damage counters
  'Sinister Surge': {
    can: (g, m, pid) => !usedThisTurn(m, 'Sinister Surge', g) && g.pl(pid).bench.some(x => x.def.type === 'Darkness') && g.pl(pid).deck.some(c => isBasicEnergy(c, 'Darkness')),
    async use(g, m, pid) {
      const p = g.pl(pid);
      const [c] = await g.chooseCards(pid, p.deck.filter(x => isBasicEnergy(x, 'Darkness')), { min: 1, max: 1, prompt: 'Search your deck for a Basic {D} Energy', from: 'deck', hint: 'attach', shown: p.deck });
      const t = c && await g.chooseOneMon(pid, p.bench.filter(x => x.def.type === 'Darkness'), `Attach ${c.name} to which Benched {D} Pokémon? (it takes 2 damage counters)`, 'attach-surge:Darkness');
      if (c && t) { await g.attachEnergy(pid, t, c); g.addCounters(t, 2); g.log(`2 damage counters on ${t.name}.`); }
      g.shuffle(pid);
    },
  },
  // Tatsugiri: a Supporter from the top 6 cards (Active Spot only)
  'Attract Customers': {
    can: (g, m, pid) => !usedThisTurn(m, 'Attract Customers', g) && g.isActive(m) && g.pl(pid).deck.length > 0,
    async use(g, m, pid) {
      const top = lookTop(g, pid, 6);
      const got = await g.chooseCards(pid, top.filter(c => c.def.trainer === 'Supporter'), { max: 1, prompt: 'Take a Supporter from the top 6 cards?', from: 'deck-top', shown: top });
      for (const c of got) { g.moveTo(c, 'hand'); g.log(`${g.pl(pid).name} reveals ${c.name} and puts it into their hand.`); }
      g.shuffle(pid);
    },
  },
  "Champion's Call": {
    can: (g, m, pid) => !usedThisTurn(m, "Champion's Call", g) && g.pl(pid).deck.length > 0,
    use: (g, m, pid) => search(g, pid, c => isMon(c) && c.name.startsWith("Cynthia's "), { max: 1, prompt: "Search your deck for a Cynthia's Pokémon" }),
  },
  // Hariyama and Hop's Dubwool: as they evolve from the hand, drag up one of the opponent's Benched Pokémon
  'Heave-Ho Catcher': { can: (g, m, pid) => gustable(g, pid), onEvolve: (g, m, pid) => gust(g, pid) },
  'Defiant Horn': { can: (g, m, pid) => gustable(g, pid), onEvolve: (g, m, pid) => gust(g, pid) },
  // Marnie's Grimmsnarl ex: up to 5 Basic {D} Energy from the deck onto Marnie's Pokémon as it evolves
  'Punk Up': {
    can: (g, m, pid) => g.pl(pid).deck.some(c => isBasicEnergy(c, 'Darkness')),
    async onEvolve(g, m, pid) {
      const got = await search(g, pid, c => isBasicEnergy(c, 'Darkness'), { max: 5, prompt: "Search your deck for up to 5 Basic {D} Energy to attach to your Marnie's Pokémon", to: 'none', hint: 'attach' });
      await attachEach(g, pid, got, g.inPlay(pid).filter(x => x.name.startsWith("Marnie's ")), 'Attach');
    },
  },
});

Object.assign(TRAINERS, {
  // ---- Items
  'Energy Recycler': {
    can: (g, pid) => g.pl(pid).discard.some(c => isBasicEnergy(c)),
    async play(g, pid) {
      const p = g.pl(pid);
      const got = await g.chooseCards(pid, p.discard.filter(c => isBasicEnergy(c)), { min: 1, max: 5, prompt: 'Shuffle up to 5 Basic Energy from your discard pile into your deck', from: 'discard', hint: 'recover' });
      for (const c of got) g.moveTo(c, 'deck');
      g.shuffle(pid);
      g.log(`${p.name} shuffles ${got.length} Energy into their deck.`);
    },
  },
  'Premium Power Pro': { play(g, pid) { g.addEffect({ kind: 'premiumPower', pid, turn: g.turn }); g.log('This turn, attacks by {F} Pokémon do 30 more damage to the opponent\'s Active Pokémon.'); } },
  'Roto-Stick': {
    can: (g, pid) => g.pl(pid).deck.length > 0,
    async play(g, pid) {
      const top = lookTop(g, pid, 4);
      const got = await g.chooseCards(pid, top.filter(c => c.def.trainer === 'Supporter'), { min: 0, max: 4, prompt: 'Take any number of Supporters from the top 4 cards', from: 'deck-top', shown: top });
      for (const c of got) g.moveTo(c, 'hand');
      if (got.length) g.log(`${g.pl(pid).name} reveals ${got.map(c => c.name).join(', ')} and puts them into their hand.`);
      g.shuffle(pid);
    },
  },
  'Miracle Headset': {
    can: (g, pid) => g.pl(pid).discard.some(c => c.def.trainer === 'Supporter'),
    async play(g, pid) {
      const got = await g.chooseCards(pid, g.pl(pid).discard.filter(c => c.def.trainer === 'Supporter'), { min: 1, max: 2, prompt: 'Put up to 2 Supporter cards from your discard pile into your hand', from: 'discard' });
      for (const c of got) g.moveTo(c, 'hand');
      g.log(`${g.pl(pid).name} puts ${got.map(c => c.name).join(', ')} into their hand.`);
    },
  },
  'Dusk Ball': {
    can: (g, pid) => g.pl(pid).deck.length > 0,
    async play(g, pid) {
      const p = g.pl(pid);
      const bottom = p.deck.slice(-7);
      const got = await g.chooseCards(pid, bottom.filter(isMon), { max: 1, prompt: 'Take a Pokémon from the bottom 7 cards of your deck?', from: 'deck-bottom', shown: bottom });
      for (const c of got) { g.moveTo(c, 'hand'); g.log(`${p.name} reveals ${c.name} and puts it into their hand.`); }
      g.shuffle(pid);
    },
  },
  "Hop's Bag": {
    can: (g, pid) => g.pl(pid).bench.length < g.benchLimit(pid),
    play: (g, pid) => search(g, pid, c => isBasicMon(c) && c.name.startsWith("Hop's "), { max: 2, prompt: "Search your deck for up to 2 Basic Hop's Pokémon to put onto your Bench", to: 'bench', hint: 'bench' }),
  },
  // ---- Supporters
  'Harlequin': {
    play(g, pid) {
      for (const p of g.players) shuffleHandIn(g, p.id);
      const heads = g.flip('Harlequin');
      g.draw(pid, heads ? 5 : 3); g.draw(g.opp(pid), heads ? 3 : 5);
      g.log(`Each player shuffles their hand into their deck; ${g.pl(pid).name} draws ${heads ? 5 : 3} and ${g.pl(g.opp(pid)).name} draws ${heads ? 3 : 5}.`);
    },
  },
  "Wally's Compassion": {
    can: (g, pid) => g.inPlay(pid).some(m => m.def.mega && m.damage > 0),
    async play(g, pid) {
      const m = await g.chooseOneMon(pid, g.inPlay(pid).filter(x => x.def.mega && x.damage > 0), 'Heal all damage from which of your Mega Evolution Pokémon ex?', 'own-damaged');
      if (!m || !g.heal(m, m.damage)) return;
      const n = m.energy.length;
      for (const c of [...m.energy]) g.moveTo(c, 'hand');
      if (n) g.log(`${n} Energy from ${m.name} return to ${g.pl(pid).name}'s hand.`);
    },
  },
  "Iris's Fighting Spirit": {
    can: (g, pid, card) => g.pl(pid).hand.some(c => c !== card) && g.pl(pid).deck.length > 0,
    async play(g, pid, card) { await discardCost(g, pid, 1, card); drawUntil(g, pid, 6); },
  },
  "Team Rocket's Ariana": {
    can: (g, pid) => g.pl(pid).deck.length > 0,
    play(g, pid) { const all = g.inPlay(pid).every(isTR); drawUntil(g, pid, all ? 8 : 5); },
  },
  "Team Rocket's Archer": {
    can: (g, pid) => g.koDuring(pid, { filter: n => n.startsWith("Team Rocket's ") }),
    play(g, pid) {
      for (const p of g.players) shuffleHandIn(g, p.id);
      g.draw(pid, 5); g.draw(g.opp(pid), 3);
      g.log(`Each player shuffles their hand into their deck; ${g.pl(pid).name} draws 5 and ${g.pl(g.opp(pid)).name} draws 3.`);
    },
  },
  "Team Rocket's Giovanni": {
    can: (g, pid) => { const p = g.pl(pid); return !!p.active && isTR(p.active) && p.bench.some(isTR); },
    async play(g, pid) {
      if (!(await switchOwn(g, pid, "Switch your Active Pokémon with which Benched Team Rocket's Pokémon?", isTR))) return;
      if (gustable(g, pid)) await gust(g, pid);
    },
  },
  "Team Rocket's Proton": { play: (g, pid) => search(g, pid, c => isBasicMon(c) && isTR(c), { max: 3, prompt: "Search your deck for up to 3 Basic Team Rocket's Pokémon" }) },
  "Larry's Skill": {
    async play(g, pid) {
      const p = g.pl(pid);
      if (p.hand.length) { g.log(`${p.name} discards their hand (${p.hand.length} card${p.hand.length > 1 ? 's' : ''}).`); for (const c of [...p.hand]) g.discard(c); }
      await search(g, pid, isMon, { max: 1, prompt: 'Search your deck for a Pokémon' });
      await search(g, pid, c => c.def.trainer === 'Supporter', { max: 1, prompt: 'Search your deck for a Supporter card' });
      await search(g, pid, c => isBasicEnergy(c), { max: 1, prompt: 'Search your deck for a Basic Energy card' });
    },
  },
  'Hassel': {
    can: (g, pid) => koLastTurn(g, pid) && g.pl(pid).deck.length > 0,
    async play(g, pid) {
      const top = lookTop(g, pid, 8);
      const got = await g.chooseCards(pid, top, { min: 0, max: 3, prompt: 'Put up to 3 of the top 8 cards into your hand', from: 'deck-top' });
      for (const c of got) g.moveTo(c, 'hand');
      g.log(`${g.pl(pid).name} puts ${got.length} card${got.length === 1 ? '' : 's'} into their hand.`);
      g.shuffle(pid);
    },
  },
  // ---- Tools and Stadiums (passive: read by the engine)
  "Cynthia's Power Weight": {}, "Hop's Choice Band": {}, 'Gravity Mountain': {}, 'Postwick': {},
  'Spikemuth Gym': {
    stadiumCan: (g, pid) => g.pl(pid).deck.length > 0,
    stadiumUse: (g, pid) => search(g, pid, c => isMon(c) && c.name.startsWith("Marnie's "), { max: 1, prompt: "Search your deck for a Marnie's Pokémon" }),
  },
});

// ---- Cards that can't do anything aren't playable (a person could otherwise use one up for nothing)
// Trainers, Abilities and Stadium actions that only search, look at or draw from the deck: not with an empty deck.
// The engine checks `needsDeck` in legalActions and before "when you play this Pokémon" Abilities.
for (const n of ['Crispin', 'Buddy-Buddy Poffin', 'Poké Pad', 'Ultra Ball', 'Dawn', 'Nest Ball', 'Arven', 'Earthen Vessel', 'Secret Box',
  'Cyrano', 'Fighting Gong', 'Electric Generator', "Team Rocket's Petrel", "Team Rocket's Transceiver", 'Precious Trolley', 'Energy Search',
  'Mirage Gate', "Janine's Secret Art", 'Hilda', "Brock's Scouting", "Team Rocket's Proton", "Hop's Bag", 'Artazon', 'Spikemuth Gym']) TRAINERS[n].needsDeck = true;
for (const n of ['Last-Ditch Catch', 'Flip the Script', 'Infernal Reign', 'Jewel Seeker', 'Fan Call', 'Transformative Start', 'Run Errand',
  'Coin Bonus', 'Metallic Signal', 'Tandem Unit', 'Shivery Chill', 'Psychic Draw', 'Punk Up']) ABILITIES[n].needsDeck = true;
// "discard (or shuffle in) your hand and draw": not with an empty hand and an empty deck
const handOrDeck = (g, pid, card) => g.pl(pid).hand.some(c => c !== card) || g.pl(pid).deck.length > 0;
for (const n of ["Professor's Research", 'Carmine', "Lillie's Determination"]) TRAINERS[n].can = handOrDeck;
ABILITIES['Squawk and Seize'].can = (g, m, pid) => turnOne(g, pid) && !playerUsed(g, pid, 'Squawk and Seize') && handOrDeck(g, pid);
// Team Rocket's Ariana draws up to 5 (8 with only Team Rocket's Pokémon in play): not with that many in hand already
TRAINERS["Team Rocket's Ariana"].can = (g, pid, card) => g.pl(pid).deck.length > 0 && g.pl(pid).hand.filter(c => c !== card).length < (g.inPlay(pid).every(isTR) ? 8 : 5);
// Professor Turo's Scenario: the Active Pokémon can only go back with a Benched one to replace it
TRAINERS["Professor Turo's Scenario"].can = (g, pid) => g.pl(pid).bench.length > 0;
// Iono with both hands empty does nothing
TRAINERS.Iono.can = (g, pid, card) => g.players.some(q => q.hand.some(c => c !== card));
// Special Red Card does nothing to an empty hand, and into an empty deck just gives the same cards back
TRAINERS['Special Red Card'].can = (g, pid) => { const o = g.pl(g.opp(pid)); return g.prizesLeft(g.opp(pid)) <= 3 && o.hand.length > 0 && (o.deck.length > 0 || o.hand.length > 3); };
// Eri shows the opponent's hand even when there's no Item to discard: playing it is never "nothing happened"
TRAINERS.Eri.reveals = true;
// Larry's Skill with an empty hand and an empty deck does nothing
TRAINERS["Larry's Skill"].can = handOrDeck;
