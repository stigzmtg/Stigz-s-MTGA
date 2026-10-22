// What each card does: attacks (by name), abilities (by name) and Trainer cards (by name), for every card in the
// Pokémon decks on offer. Vanilla attacks need no entry: they just do their printed damage.
//   ATTACKS[name]   = { base(ctx) -> damage, after(ctx), run(ctx) (does everything), can(game, mon, atk) -> reason it can't, opts }
//   ABILITIES[name] = { use(game, mon, pid) | onBench | onEvolve, can(game, mon, pid), oncePerPlayer, selfKO }
//   TRAINERS[name]  = { can(game, pid, card), play(game, pid, card), canAttach(game, mon), stadiumUse(game, pid), stadiumCan }
export const ATTACKS = {};
export const ABILITIES = {};
export const TRAINERS = {};

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
  'Myriad Leaf Shower': { base(ctx) { const g = ctx.game; const n = ctx.attacker.energy.length + (ctx.defender ? ctx.defender.energy.length : 0); return ctx.printed + 30 * n; } },
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
    can: (g, m) => !usedThisTurn(m, 'Cursed Blast', g),
    async use(g, m, pid) {
      const n = m.name === 'Dusknoir' ? 13 : 5;
      const t = await g.chooseOneMon(pid, g.inPlay(g.opp(pid)), `Put ${n} damage counters on which Pokémon?`, 'opp-counters:' + n);
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
    can: (g, m, pid) => !usedThisTurn(m, 'Adrena-Brain', g) && m.energy.some(c => c.def.provides === 'Darkness') && g.inPlay(pid).some(x => x.damage > 0),
    async use(g, m, pid) {
      const from = await g.chooseOneMon(pid, g.inPlay(pid).filter(x => x.damage > 0), 'Move damage counters from which of your Pokémon?', 'own-damaged');
      const to = await g.chooseOneMon(pid, g.inPlay(g.opp(pid)), "Move them to which of your opponent's Pokémon?", 'opp-counters:3');
      const n = Math.min(3, g.counters(from));
      const k = await g.chooseOption(pid, Array.from({ length: n }, (_, i) => ({ value: n - i, label: `${n - i} damage counter${n - i > 1 ? 's' : ''}` })), 'Move how many damage counters?', 'max');
      from.damage -= 10 * k;
      g.addCounters(to, k);
      g.log(`${k} damage counter${k > 1 ? 's' : ''} moved from ${from.name} to ${to.name}.`);
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
      }
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
    can(g, pid) {
      const p = g.pl(pid);
      if (p.turns <= 1) return false;
      return p.hand.some(c => isMon(c) && c.def.stage === 'Stage2' && g.inPlay(pid).some(m => m.def.stage === 'Basic' && m.playedTurn !== g.turn && m.name === basicOfStage2(g, c.def)));
    },
    async play(g, pid) {
      const p = g.pl(pid);
      const pairs = [];
      for (const c of p.hand) if (isMon(c) && c.def.stage === 'Stage2') for (const m of g.inPlay(pid)) if (m.def.stage === 'Basic' && m.playedTurn !== g.turn && m.name === basicOfStage2(g, c.def)) pairs.push({ c, m });
      const v = await g.chooseOption(pid, pairs.map((x, i) => ({ value: i, label: `${x.m.name} → ${x.c.name}` })), 'Rare Candy: evolve which Pokémon?', 'candy');
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
