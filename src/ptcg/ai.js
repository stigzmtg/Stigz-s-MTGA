// A computer opponent for the Pokémon TCG: it plays its turn the way a person would — dig for cards, fill the
// Bench, evolve, power up the Pokémon that will attack (the one that can take a Knock Out, ideally), use draw
// Abilities and Supporters, switch or gust when that wins a trade, then attack. Every choice an effect asks for
// is answered from what that choice is for (the request's hint).
// It only reads the game: every answer is computed from the state it is shown, so it can run on one peer of an
// online game. The one thing it remembers is the card it put on top of its own deck (Academy at Night).
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isBasicEnergy = c => c.def.cat === 'E' && c.def.energy === 'Basic';
const isMon = c => c.def.cat === 'P';
const ruleBox = d => !!(d.ex || d.radiant || d.v);
const hasAbil = (d, name) => (d.abilities || []).some(a => a.name === name);
const isNs = m => /^N's /.test(m.name);
const SNEAK = "Hide 'n' Sneak";
const DRAW_SUPPORTERS = new Set(["Professor's Research", "Lillie's Determination", 'Iono', 'Carmine', 'Judge', 'Roxanne', "Colress's Experiment", "Explorer's Guidance", 'Gwynn', 'Naveen', 'Surfer', 'Harlequin', "Iris's Fighting Spirit", "Team Rocket's Ariana", "Team Rocket's Archer", 'Hassel', 'Lucian', "Morty's Conviction"]);
const SETUP_SUPPORTERS = new Set(['Arven', 'Dawn', "Team Rocket's Petrel", 'Cyrano', 'Crispin', "Professor Sada's Vitality", "Rosa's Encouragement", "Ciphermaniac's Codebreaking", "Lana's Aid", 'Hilda', "Brock's Scouting", "Janine's Secret Art", "Team Rocket's Proton", "Larry's Skill", "Ethan's Adventure", "Colress's Tenacity", 'Salvatore', 'Penny']);
const trSupporter = c => c.def.trainer === 'Supporter' && /Team Rocket/.test(c.name);
// "This Pokémon also does N damage to itself"
const SELF_DAMAGE = { 'Iron Tackle': 10, 'Wild Press': 70, 'Reckless Charge': 10, 'Dynamic Press': 80, 'Take Down': 10 };
// attacks that develop the board rather than deal damage: worth something while the Bench is thin
const SETUP_ATTACKS = new Set(['Jolting Charge', 'Summoning Jutsu', 'Call for Support', 'Celestial Roar', 'Abyss Seeking', 'Call for Family', 'Call Sign', 'Find a Friend', 'Minor Errand-Running', 'Kaleidowaltz', 'Collect', 'Burst Roar', 'Magnetic Charge', 'Evolution', 'Come and Get You', 'Ascension', 'Traverse Time', 'Dangle Tail']);
// attacks that place damage counters (no Weakness, Resistance or damage reduction; stopped by effect protection)
const COUNTER_ATTACKS = new Set(['Powerful Hand', 'Furtive Drop', 'Matcha Spin', 'Spiritual End']);
// what attacks with no printed damage (or a small one) are really worth, for deciding where Energy goes
const NOMINAL = { 'Seek Inspiration': 130, 'Night Joker': 170, 'Powerful Hand': 120, 'Trifrost': 110, 'Thunder Raid': 60, 'Lost Mine': 120, 'Vengeful Anchor': 170, 'Syrup Storm': 180, 'Twin Shotels': 100, 'Coordinated Throwing': 120, 'Apex Dragon': 280, 'Rumbling Bees': 330, 'Giant Bouquet': 220, 'Gobble Down': 160, 'Buddy Blast': 220, 'Abyssal Flames': 200, 'Rocket Rush': 150, 'Resentful Refrain': 200, 'Mad Bite': 190, 'Verdant Storm': 180, 'Solar Beatdown': 150, 'Erasure Ball': 280 };
// "As often as you like" Abilities of Pokémon that power the others up from the Bench (not Mega Venusaur ex, an attacker)
const isEngineAbility = a => /As often as you like/.test(a.text) && a.name !== 'Solar Transfer';
// Items whose net effect on the hand is known (cards spent minus cards gained), for Powerful Hand turns
const ITEM_HAND_COST = { 'Poké Pad': 0, 'Night Stretcher': 0, 'Pokégear 3.0': 0, 'Buddy-Buddy Poffin': 1, 'Nest Ball': 1, 'Ultra Ball': 2, 'Rare Candy': 2, 'Special Red Card': 1, 'Prime Catcher': 1, 'Sacred Ash': 1, 'Switch': 1, 'Strange Timepiece': 1, 'Earthen Vessel': 0, 'Super Rod': 1, 'Secret Box': 0 };

export class PokemonAI {
  constructor({ pace = null } = {}) { this.pace = pace; this.turnKey = ''; this.counts = {}; this.topCard = null; this.fuel = null; }
  async pause(kind) { const ms = this.pace ? this.pace(kind) : 0; if (ms > 0) await sleep(ms); }

  async ask(g, pid, req) {
    try {
      const v = this.answer(g, pid, req);
      if (req.type === 'main') {
        if (v && v.t === 'attack') await this.pause('attack');
        else if (v && v.t !== 'end') await this.pause(v.t === 'energy' || v.t === 'bench' ? 'land' : 'think');
      } else await this.pause('choose');
      return v;
    } catch (e) {
      if (g.throwErrors) throw e;
      console.error('Pokémon AI error', e);
      return fallback(req);
    }
  }

  answer(g, pid, req) {
    switch (req.type) {
      case 'main': return this.main(g, pid, req.actions);
      case 'cards': return this.cards(g, pid, req);
      case 'mon': return this.mons(g, pid, req);
      case 'confirm': return this.confirm(g, pid, req);
      case 'option': return this.option(g, pid, req);
      case 'distribute': return this.distribute(g, pid, req);
      default: return fallback(req);
    }
  }

  // ------------------------------------------------------------ evaluation
  // Pokémon with Hide 'n' Sneak in a discard pile (Dhelmise, Sinistcha and Spiritomb count them)
  sneakers(g, pid) { return g.pl(pid).discard.filter(c => isMon(c) && hasAbil(c.def, SNEAK)).length; }
  // the top card of our deck, when we put it there ourselves
  knownTop(g, pid) { const top = g.pl(pid).deck[0]; return top && this.topCard === top.id ? top : null; }
  // what a Pokémon's attack is worth against the opponent's Active right now (depth > 0: an attack being copied)
  estimate(g, pid, mon, atk, target, depth = 0) {
    if (!target) return 0;
    const me = g.pl(pid), opp = g.opp(pid);
    const printed = parseInt(atk.damage, 10) || 0;
    const energiesInPlay = type => g.inPlay(pid).reduce((s, m) => s + m.energy.filter(c => isBasicEnergy(c) && (!type || c.def.provides === type)).length, 0);
    const units = m => g.energyTypes(m).length;
    const sneak = () => this.sneakers(g, pid);
    const blocked = g.effectsBlocked({ pid }, target);
    let d = printed;
    switch (atk.name) {
      // Hail Blade: the {W} Energy in play, plus what Baxcalibur's Super Cold can still attach from hand this turn
      case 'Hail Blade': d = 60 * Math.min(energiesInPlay('Water') + (g.current === pid && g.inPlay(pid).some(m => g.hasAbility(m, 'Super Cold')) ? me.hand.filter(c => isBasicEnergy(c) && c.def.provides === 'Water').length : 0), 6); break;
      case 'Bellowing Thunder': d = 70 * Math.min(energiesInPlay(), 6); break;
      case 'Make It Rain': d = 50 * me.hand.filter(isBasicEnergy).length; break;
      case 'Burning Darkness': d = printed + 30 * g.prizesTaken(opp); break;
      case 'Voltage Burst': d = printed + 50 * g.prizesTaken(opp); break;
      case 'Irritated Outburst': d = 60 * g.prizesTaken(opp); break;
      case 'Rapid-Fire Combo': d = printed + 50; break;
      case 'Ear Force': d = printed + 80 * target.energy.length; break;
      case 'Myriad Leaf Shower': d = printed + 30 * (units(mon) + units(target)); break;
      case 'Full Moon Rondo': d = printed + 20 * (me.bench.length + g.pl(opp).bench.length); break;
      // Gale Thrust: a Benched Pokémon would be moving in this turn
      case 'Gale Thrust': d = printed + (mon.movedActiveTurn === g.turn || !g.isActive(mon) ? 170 : 0); break;
      case 'Calamity Storm': d = printed + (g.stadium ? 120 : 0); break;
      case 'Vengeance Fletching': d = printed + 10 * me.discard.filter(c => c.def.ancient).length; break;
      case 'Jewel Breaker': d = printed + (target.def.tera ? 230 : 0); break;
      case 'Balloon Blast': d = 30 * g.counters(mon); break;
      case 'Roaring Scream': d = 20 * g.counters(mon); break;
      case 'Triple Stab': d = 15; break;
      case 'Cosmic Beam': d = me.bench.some(m => m.name === 'Lunatone') ? printed : 0; break;
      case 'Assault Landing': d = g.stadium ? printed : 0; break;
      case 'Frenzied Gouging': return blocked ? 0 : g.hpLeft(target) + 1000;
      case 'Terminal Period': return !blocked && g.counters(target) === 6 ? g.hpLeft(target) + 1000 : 0;
      case 'Lost Mine': return 120;
      case 'Cruel Arrow': d = 100; break;
      case 'Genome Hacking': d = Math.max(0, ...(target.def.attacks || []).map(a => parseInt(a.damage, 10) || 0)); break;
      // the newer decks
      case 'Seek Inspiration': return depth ? 0 : this.seekValue(g, pid, mon, target).dmg;
      case 'Night Joker': return depth ? 0 : this.copyBest(g, pid, mon, target, this.jokerChoices(g, pid)).dmg;
      case 'Thunder Raid': return 0;
      case 'Metallic Hammer': d = printed + (mon.energy.filter(c => c.def.provides === 'Metal' || c.def.anyType).length >= 3 ? 150 : 0); break;
      case 'Powerful Rage': d = 20 * g.counters(mon); break;
      case 'Fighting Wings': d = printed + (target.def.ex ? 90 : 0); break;
      case 'Powerful Hand': d = 20 * me.hand.length; break;
      case 'Furtive Drop': d = 10; break;
      case 'Matcha Spin': d = sneak() >= 6 ? 40 : 0; break;
      case 'Spiritual End': d = sneak() >= 13 ? 3 * target.damage : 0; break;
      case 'Vengeful Anchor': d = printed + (sneak() >= 4 ? 140 : 0); break;
      case 'Do the Wave': d = 20 * me.bench.length; break;
      case 'Syrup Storm': d = printed + 30 * g.inPlay(pid).reduce((s, m) => s + g.energyTypes(m).filter(t => t === 'Grass' || t === 'Any').length, 0); break;
      case 'Tumbling Attack': d = printed + 10; break;
      case 'Mirror Attack': d = printed + (target.def.type === 'Psychic' ? 30 : 0); break;
      case 'Twin Shotels': d = 50; break;
      case 'Coordinated Throwing': d = 20 * g.inPlay(pid).filter(m => m.def.stage === 'Basic').length; break;
      // Grass, Metal and Dragon decks
      case 'Apex Dragon': return depth ? 0 : this.copyBest(g, pid, mon, target, this.apexChoices(g, pid)).dmg;
      case 'Rumbling Bees': d = 110 * g.inPlay(pid).filter(m => m.name === 'Beedrill' || m.name === 'Beedrill ex').length; break;
      case 'Giant Bouquet': d = printed + 50 * g.energyTypes(mon).filter(t => g.provides(t, 'Grass')).length; break;
      case 'Gobble Down': d = 80 * g.prizesTaken(pid); break;
      case 'Huge Bite': d = target.damage > 0 ? 30 : printed; break;
      case 'Raging Hammer': d = printed + 10 * g.counters(mon); break;
      case 'Surprise Attack': d = 15; break;
      case 'Star Requiem': return blocked ? 0 : g.hpLeft(target) + 1000;
      case 'Shocking Web': d = printed + (g.energyTypes(mon).some(t => g.provides(t, 'Lightning')) ? 80 : 0); break;
      case 'Comet Punch': d = 60; break;
      case 'Wicked Impact': d = printed + (/Team Rocket/.test(me.supporterName || '') ? 100 : 0); break;
      case 'Resentful Refrain': d = 50 * g.pl(opp).hand.length; break;
      case 'Abyssal Flames': d = printed + 20 * me.discard.filter(c => c.def.cat === 'E').length; break;
      case 'Rocket Rush': d = 30 * g.inPlay(pid).filter(m => /^Team Rocket's /.test(m.name)).length; break;
      case 'Erasure Ball': d = printed + 60 * Math.min(2, me.bench.reduce((s2, m) => s2 + m.energy.length, 0)); break;
      case 'Verdant Storm': d = 60 * g.inPlay(opp).reduce((s2, m) => s2 + g.energyTypes(m).length, 0); break;
      case 'Solar Beatdown': d = 30 * g.inPlay(pid).length; break;
      case 'Spirited Tackle': d = printed + (target.def.stage === 'Stage1' ? 90 : 0); break;
      case 'Buddy Blast': d = printed + 60 * me.discard.filter(c => c.name === "Ethan's Adventure").length; break;
      case 'Mad Bite': d = printed + 30 * g.counters(target); break;
      case 'Ninja Spinner': d = printed + (mon.energy.some(c => c.def.provides === 'Water') ? 80 : 0); break;
      case 'Mirage Barrage': d = 120; break;
      // the third wave of decks
      case 'Maximum Drilling': d = printed + (g.energyTypes(mon).length - g.attackCost(mon, atk).length >= 2 ? 130 : 0); break;
      case 'Hungry Jaws': d = printed + (mon.damage > 0 ? 150 : 0); break;
      case 'Rocket Feathers': d = 60 * me.hand.filter(trSupporter).length; break;
      case 'R Command': d = 20 * me.discard.filter(trSupporter).length; break;
      case 'Dark Frost': d = printed + (mon.energy.some(c => c.name === "Team Rocket's Energy") ? 60 : 0); break;
      case 'Raging Curse': d = 10 * me.bench.filter(m => m.name.startsWith("Cynthia's ")).reduce((s, m) => s + g.counters(m), 0); break;
      case 'Orichalcum Fang': d = printed + (g.koDuring(pid, { byAttack: true }) ? 120 : 0); break;
      case 'Horrifying Revenge': d = printed + (g.koDuring(pid, { byAttack: true, filter: n => n.startsWith("Hop's ") }) ? 100 : 0); break;
      case 'Fickle Spitting': d = [3, 4].includes(g.prizesLeft(opp)) ? printed : 0; break;
      case 'Sonic Ripper': d = 220; break;
      case 'Gemstone Mimicry': return depth || !target.def.tera ? 0 : this.copyBest(g, pid, mon, target, target.def.attacks || []).dmg;
    }
    if (COUNTER_ATTACKS.has(atk.name)) return blocked ? 0 : Math.max(0, d);
    if (d > 0) d += g.attackBonus({ pid, opp }, mon, target);
    if (d > 0 && !['Cosmic Beam', 'Demolish', 'Spit Innocently', 'Twin Shotels', 'Swift'].includes(atk.name)) {
      if (g.weaknessOf(target) === mon.def.type && atk.name !== 'Raging Curse') d *= 2;
      if (target.def.resist === mon.def.type && atk.name !== 'Rock Hurl') d -= 30;
    }
    // protections on the target
    const ignore = ['Spiky Hopper', 'Demolish', 'Shred', 'Superb Scissors', 'Twin Shotels', 'Swift'].includes(atk.name);
    if (!ignore && g.hasAbility(target, 'Cornerstone Stance') && g.abilitiesOf(mon).length) return 0;
    if (!ignore && g.hasEffect('dig', { mon: target })) return 0;
    if (!ignore && g.hasEffect('protect', { mon: target })) d -= 30;
    if (!ignore) d = g.damageGuard(target, mon, Math.max(0, d));
    // Festival Lead: two attacks this turn
    if (!depth && g.festivalLead(mon) && g.isActive(mon)) d *= 2;
    return Math.max(0, d);
  }
  // the best of several attacks to copy: its damage to the Active and what it's worth on the Bench
  copyBest(g, pid, mon, target, attacks) {
    let best = { dmg: 0, bench: 0, score: 0 };
    for (const a of attacks) {
      const dmg = this.estimate(g, pid, mon, a, target, 1), bench = this.benchValue(g, pid, mon, a, 1);
      const score = dmg + (target && dmg >= g.hpLeft(target) ? 200 * g.prizeValue(target) : 0) + bench;
      if (score > best.score) best = { dmg, bench, score };
    }
    return best;
  }
  // Seek Inspiration: the attack of the card on top (when we know it), or what the deck offers on average
  seekValue(g, pid, mon, target) {
    const me = g.pl(pid);
    const val = c => (isMon(c) && !ruleBox(c.def) ? this.copyBest(g, pid, mon, target, c.def.attacks || []) : { dmg: 0, bench: 0, score: 0 });
    const top = this.knownTop(g, pid);
    if (top) return val(top);
    if (!me.deck.length) return { dmg: 0, bench: 0, score: 0 };
    const vals = me.deck.map(val);
    let v = { dmg: vals.reduce((s, x) => s + x.dmg, 0) / vals.length, bench: vals.reduce((s, x) => s + x.bench, 0) / vals.length };
    v.score = v.dmg + v.bench;
    // we can still choose the top card: Academy at Night (a card from hand) or Ciphermaniac's Codebreaking (from the deck)
    const pick = list => { for (const x of list.map(val)) if (x.score > v.score) v = x; };
    if (g.stadiumName() === 'Academy at Night' && me.once.stadium !== g.turn) pick(me.hand);
    if (!me.supporter && me.hand.some(c => c.name === "Ciphermaniac's Codebreaking") && !(g.turn === 1 && g.first === pid)) pick(me.deck);
    return v;
  }
  jokerChoices(g, pid) { return g.pl(pid).bench.filter(isNs).flatMap(m => (m.def.attacks || []).filter(a => a.name !== 'Night Joker')); }
  // damage an attack can do to a Benched Pokémon
  benchHit(g, pid, attacker, m, n, counters = false) {
    if (counters) return g.effectsBlocked({ pid }, m) ? 0 : n;
    if (g.isTera(m) && m.def.ex) return 0;
    if (g.hasEffect('dig', { mon: m })) return 0;
    if (!ruleBox(m.def) && g.anyInPlayHasAbility('Flower Curtain', m.owner)) return 0;
    return g.damageGuard(m, attacker, n);
  }
  // what an attack's damage to the Bench is worth (snipes, spreads, Knock Outs there)
  benchValue(g, pid, mon, atk, depth = 0) {
    const ob = g.pl(g.opp(pid)).bench;
    if (!ob.length) return 0;
    // an attack being copied doesn't copy again (Seek Inspiration discarding a Slowking)
    if (depth && (atk.name === 'Seek Inspiration' || atk.name === 'Night Joker')) return 0;
    const score = (m, n) => (n >= g.hpLeft(m) && n > 0 ? 150 * g.prizeValue(m) : n / 3);
    const best = (n, filter = () => true, counters = false) => Math.max(0, ...ob.filter(filter).map(m => score(m, this.benchHit(g, pid, mon, m, n, counters))));
    const sum = (n, k, counters = false) => ob.map(m => score(m, this.benchHit(g, pid, mon, m, n, counters))).sort((a, b) => b - a).slice(0, k).reduce((s, v) => s + v, 0);
    switch (atk.name) {
      case 'Thunder Raid': return best(210, m => m.def.ex);
      case 'Trifrost': return sum(110, 2);
      case 'Ghostly Blow': return best(50, () => true, true);
      case 'Moonlight Shuriken': return best(90);
      case 'Phantom Dive': return Math.min(60, ob.length * 30) + (ob.some(m => g.hpLeft(m) <= 60) ? 100 : 0);
      case 'Matcha Spin': return this.sneakers(g, pid) >= 6 ? sum(40, 5, true) : 0;
      case 'Torrential Pump': return mon.energy.length >= 3 ? best(120) / 2 : 0;
      // Twin Shotels: 50 to a second Pokémon, through any protection on it
      case 'Twin Shotels': return Math.max(0, ...ob.map(m => score(m, 50)));
      case 'Seek Inspiration': return this.seekValue(g, pid, mon, g.pl(g.opp(pid)).active).bench;
      case 'Night Joker': return this.copyBest(g, pid, mon, g.pl(g.opp(pid)).active, this.jokerChoices(g, pid)).bench;
      default: return 0;
    }
  }
  bestAttack(g, pid, mon, { needReady = true } = {}) {
    const target = g.pl(g.opp(pid)).active;
    let best = null;
    for (const atk of g.attacksOf(mon)) {
      if (needReady && g.attackBlock(mon, atk)) continue;
      if (!needReady && !atk.cost) continue;
      let v = this.estimate(g, pid, mon, atk, target);
      // setup attacks are worth something early on
      if (SETUP_ATTACKS.has(atk.name)) v = Math.max(v, g.pl(pid).bench.length < 3 ? 60 : 15);
      if (['Itchy Pollen', 'Oceanic Gloom'].includes(atk.name)) v += 25;
      const ko = target && v >= g.hpLeft(target);
      let score = v + (ko ? 200 * g.prizeValue(target) : 0) + this.benchValue(g, pid, mon, atk);
      // attacks that also damage the attacker: don't Knock Out our own Pokémon unless it wins the game
      const self = SELF_DAMAGE[atk.name];
      if (self && g.hpLeft(mon) <= self && !(ko && g.prizesLeft(pid) <= g.prizeValue(target))) score -= 100 + 200 * g.prizeValue(mon);
      if (!best || score > best.score) best = { atk, v, ko, score };
    }
    return best;
  }
  // how many more Energy (and of what types) a Pokémon needs for its strongest attack
  needs(g, mon) {
    let best = null;
    // the attacks this deck's Energy can pay for (N's Zekrom's Rampaging Thunder needs {R}{L}{L} a {D} deck doesn't have)
    const types = this.deckTypes(g, mon.owner);
    const payable = atk => types.has('Any') || atk.cost.every(t => types.has(t)) || !g.attackCost(mon, atk).length;
    // and not the ones blocked for another reason (Lost Mine before 10 cards in the Lost Zone)
    const usable = atk => { const why = g.attackBlock(mon, { ...atk, src: 'own' }); return !why || /Energy|Active|first turn|asleep|paralyzed|can't attack/i.test(why); };
    // Mew ex's Memory Helix: the Benched Pokémon's attacks count too
    const printed = [...(mon.def.attacks || []), ...(g.hasAbility(mon, 'Memory Helix') ? g.pl(mon.owner).bench.filter(b => b !== mon).flatMap(b => b.def.attacks || []) : [])];
    const atks = printed.filter(a => payable(a) && usable(a));
    for (const atk of atks.length ? atks : printed) {
      // what the attack can reach: "60×" attacks scale with what you pay into them, "200+" ones grow
      const n = parseInt(atk.damage, 10) || 0;
      const dmg = NOMINAL[atk.name] || (/×/.test(atk.damage) ? n * 3 : /\+/.test(atk.damage) ? n + 60 : n || 30);
      if (!best || dmg > best.dmg) best = { atk, dmg };
    }
    if (!best) return { missing: [], dmg: 0 };
    const cost = g.attackCost(mon, best.atk);
    const pool = g.energyTypes(mon);
    const missing = [];
    for (const t of cost.filter(t => t !== 'Colorless')) { let i = pool.indexOf(t); if (i < 0) i = pool.indexOf('Any'); if (i >= 0) pool.splice(i, 1); else missing.push(t); }
    const colorless = cost.filter(t => t === 'Colorless').length;
    for (let i = 0; i < colorless; i++) { if (pool.length) pool.pop(); else missing.push('Colorless'); }
    return { missing, dmg: best.dmg, atk: best.atk };
  }
  attackerValue(g, mon) { const n = this.needs(g, mon); return n.dmg + (mon.def.ex ? 40 : 0) + (mon.def.stage === 'Stage2' ? 30 : 0); }
  canAttackNow(g, mon) { return g.attacksOf(mon).some(atk => !g.attackBlock(mon, atk)); }
  // does this player's deck have a card with this attack?
  plays(g, pid, name, kind = 'attack') {
    const p = g.pl(pid);
    const k = `${pid}:${kind}:${name}`;
    if (this.playsGame !== g) { this.playsGame = g; this.playsCache = {}; }
    const has = c => (kind === 'attack' ? (c.def.attacks || []).some(a => a.name === name) : c.name === name);
    if (!(k in this.playsCache)) this.playsCache[k] = [...p.deck, ...p.hand, ...p.discard, ...p.prizes, ...p.lost, ...g.inPlay(pid).flatMap(m => m.allCards())].some(has);
    return this.playsCache[k];
  }
  // the Energy types this player's deck can attach (its basic Energy and typed Special Energy, plus Colorless)
  deckTypes(g, pid) {
    if (this.playsGame !== g) { this.playsGame = g; this.playsCache = {}; }
    const k = `types:${pid}`;
    if (!this.playsCache[k]) {
      const p = g.pl(pid);
      const all = [...p.deck, ...p.hand, ...p.discard, ...p.prizes, ...p.lost, ...g.inPlay(pid).flatMap(m => m.energy)];
      this.playsCache[k] = new Set(['Colorless', ...all.filter(c => c.def.cat === 'E').map(c => (c.def.anyType ? 'Any' : c.def.provides))]);
    }
    return this.playsCache[k];
  }
  // a Basic Pokémon that's only good as a card to copy (Seek Inspiration): it can't pay for its real attacks
  copyFodder(g, pid, c) {
    if (!c.def.attacks || !c.def.attacks.length || (c.def.abilities || []).length) return false;
    if (!this.plays(g, pid, 'Seek Inspiration')) return false;
    const types = this.deckTypes(g, pid);
    const payable = a => types.has('Any') || a.cost.every(t => types.has(t));
    return c.def.attacks.some(a => !payable(a)) && Math.max(0, ...c.def.attacks.filter(payable).map(a => parseInt(a.damage, 10) || 0)) <= 30;
  }

  // ------------------------------------------------------------ the main phase
  main(g, pid, actions) {
    const key = `${g.turn}`;
    if (key !== this.turnKey) { this.turnKey = key; this.counts = {}; this.fuel = null; }
    const me = g.pl(pid), opp = g.opp(pid);
    const by = t => actions.filter(a => a.t === t);
    const card = id => me.hand.find(c => c.id === id);
    const once = (k, max = 1) => { this.counts[k] = (this.counts[k] || 0) + 1; return this.counts[k] <= max; };
    const active = me.active;
    const oppActive = g.pl(opp).active;
    // Powerful Hand turns: every card kept in hand is 2 more damage counters, so only spend cards that pay back
    const handAttack = active && g.attacksOf(active).some(x => x.name === 'Powerful Hand' && !g.attackBlock(active, x)) && oppActive && !g.effectsBlocked({ pid }, oppActive);
    const spare = handAttack ? me.hand.length - Math.ceil(g.hpLeft(oppActive) / 20) : 99;
    const affordable = cost => cost <= 0 || spare >= cost;
    // Gladion's Final Battle is playable only as the last card in hand: on a turn our attacker can use it, empty the
    // hand first (no draws, no other Supporter; Ultra Ball dumps what can't be played)
    const gladion = this.gladionPlan(g, pid);
    this.gplan = gladion ? g.turn : null;

    // 1. abilities that draw, search or accelerate
    const abil = by('ability');
    const pickAbility = names => abil.find(a => names.includes(a.name) && once('ab:' + a.mon + a.name, a.name === 'Psychic Embrace' || a.name === 'Super Cold' ? 6 : 1));
    const deckLow = me.deck.length <= 8;
    const finds = (name) => {
      const has = f => me.deck.some(f);
      switch (name) {
        case 'Tandem Unit': return has(c => isMon(c) && c.def.stage === 'Basic' && c.def.type === 'Lightning');
        case 'Metallic Signal': return has(c => isMon(c) && c.def.stage !== 'Basic' && c.def.type === 'Metal');
        case 'Fan Call': return has(c => isMon(c) && c.def.type === 'Colorless' && c.def.hp <= 100);
        case 'Shivery Chill': return has(c => isBasicEnergy(c) && c.def.provides === 'Water');
        // Metang: more {M} Energy is never wasted on Mega Excadrill ex (Maximum Drilling wants 2 extra)
        case 'Metal Maker': return !deckLow && has(c => isBasicEnergy(c) && c.def.provides === 'Metal');
        // Steven's Metagross ex: a {P} and a {M} Energy from the deck, while a {P} or {M} Pokémon needs Energy
        case 'Bonded by the Journey': return has(c => c.name === "Ethan's Adventure") && !me.hand.some(c => c.name === "Ethan's Adventure");
        case 'Charging Up': return me.discard.some(c => isBasicEnergy(c));
        case 'X-Boot': return has(c => isBasicEnergy(c) && (c.def.provides === 'Psychic' || c.def.provides === 'Metal')) && g.inPlay(pid).some(m => (m.def.type === 'Psychic' || m.def.type === 'Metal') && this.needs(g, m).missing.length);
        case "Champion's Call": return has(c => isMon(c) && c.name.startsWith("Cynthia's ") && this.wantsFromDeck(g, pid, c));
        // Tatsugiri in the Active Spot: dig for a Supporter when there's none to play
        case 'Attract Customers': return !me.supporter && !me.hand.some(c => c.def.trainer === 'Supporter') && !deckLow;
        case 'Trade': return me.hand.length >= 1 && me.deck.length > 10 && !handAttack;
        // Gladion decks keep the hand small: search when it is small, or for Gladion itself
        case 'Boom Boom Groove': return !this.plays(g, pid, "Gladion's Final Battle", 'trainer') || me.hand.length <= 3 || (!me.supporter && !me.hand.some(c => c.name === "Gladion's Final Battle"));
        default: return true;
      }
    };
    const DRAWS = ['Recon Directive', 'Flower Selecting', 'Run Errand', 'Coin Bonus', 'Flip the Script', 'Lunar Cycle', 'Quick Search', 'Teal Dance', 'Boom Boom Groove', 'Trade'];
    let a = pickAbility(['Fan Call', 'Squawk and Seize', 'Transformative Start']);
    if (a && finds(a.name) && (a.name !== 'Squawk and Seize' || me.hand.length <= 5)) return a;
    a = abil.find(x => ['Tandem Unit', 'Metallic Signal', 'Shivery Chill', 'Metal Maker', 'X-Boot', 'Bonded by the Journey', 'Charging Up', "Champion's Call", 'Attract Customers', ...DRAWS].includes(x.name) && finds(x.name) && !(deckLow && DRAWS.includes(x.name) && x.name !== 'Teal Dance' && me.hand.length > 1) && !(gladion && DRAWS.includes(x.name)) && once('ab:' + x.mon + x.name));
    if (a) return a;
    if (me.hand.length <= 2 && !deckLow) { a = pickAbility(['Restart', 'Run Away Draw', 'Concealed Cards']); if (a) return a; }
    // Regidrago VSTAR's Legacy Star (once a game): two cards back from the discard pile once there are good ones
    a = abil.find(x => x.name === 'Legacy Star');
    if (a && this.legacyUseful(g, pid) && once('legacy')) return a;
    // Mega Venusaur ex's Solar Transfer: Grass Energy from the Bench onto the Active attacker that needs it
    a = abil.find(x => x.name === 'Solar Transfer');
    if (a) { const plan = this.solarPlan(g, pid); if (plan && once('solar', 4)) { this.eswitch = { turn: g.turn, ...plan }; return a; } }
    // Lost Zone: bring a Benched Comfey up to use Flower Selecting when we can switch back afterwards
    const pivot = this.comfeyPivot(g, pid, actions);
    if (pivot && once('pivot')) return pivot;

    // 2. search and setup Items
    const trainers = by('trainer').map(x => ({ ...x, c: card(x.card) }));
    // Rare Candy into Alakazam draws 3 (Psychic Draw)
    const itemCost = c => (c.name === 'Rare Candy' && me.hand.some(x => x.name === 'Alakazam') ? -1 : ITEM_HAND_COST[c.name] ?? 1);
    const item = names => trainers.find(x => x.c && x.c.def.trainer === 'Item' && names.includes(x.c.name) && affordable(itemCost(x.c)) && once('it:' + x.c.name, 4));
    const benchRoom = me.bench.length < g.benchLimit(pid);
    let t = item(['Rare Candy']);
    if (t) return t;
    if (benchRoom && me.bench.length < 4) { t = item(['Buddy-Buddy Poffin', 'Nest Ball', 'Precious Trolley', "Hop's Bag"]); if (t) return t; }
    // Supporter finders: when there's no Supporter to play (Rocket Feathers decks always want more Team Rocket ones)
    const feathers = this.plays(g, pid, 'Rocket Feathers');
    if (!me.supporter && (!me.hand.some(c => c.def.trainer === 'Supporter') || feathers)) { t = item(["Team Rocket's Transceiver", 'Roto-Stick', 'Miracle Headset']); if (t) return t; }
    t = item(['Poké Pad', 'Fighting Gong', 'Energy Search', 'Pokégear 3.0', 'Electric Generator', 'Mirage Gate', 'Glass Trumpet', 'Bug Catching Set', 'Wondrous Patch', "N's PP Up", 'Dusk Ball', 'Tera Orb']);
    if (t && (t.c.name !== 'Wondrous Patch' || g.inPlay(pid).some(m => m.def.type === 'Psychic' && !g.isActive(m) && this.needs(g, m).missing.length))) return t;
    if (me.hand.length >= 4) { t = item(['Ultra Ball', 'Earthen Vessel']); if (t && this.hasJunk(g, pid, t.c, t.c.name === 'Ultra Ball' ? 2 : 1)) return t; }
    if (me.hand.length >= 5) { t = item(['Secret Box', 'Superior Energy Retrieval']); if (t && this.hasJunk(g, pid, t.c, t.c.name === 'Secret Box' ? 3 : 2)) return t; }
    // Superior Energy Retrieval when we're out of Energy: 2 cards for up to 4 Energy back
    if (me.hand.length >= 3 && !me.hand.some(c => c.def.cat === 'E') && me.discard.filter(isBasicEnergy).length >= 2 && g.inPlay(pid).some(m => this.needs(g, m).missing.length)) { t = item(['Superior Energy Retrieval']); if (t) return t; }
    if (oppActive) { t = item(['Crushing Hammer']); if (t && oppActive.energy.length) return t; }
    t = item(['Jumbo Ice Cream']);
    if (t && active && active.damage >= 80) return t;
    if (me.discard.some(isMon) && me.deck.length < 25) { t = item(['Super Rod']); if (t) return t; }
    if (me.discard.filter(isMon).length >= 3 && me.deck.length < 20 && !me.deck.some(isMon)) { t = item(['Sacred Ash']); if (t) return t; }
    if (me.hand.filter(isMon).length === 0 && me.discard.some(c => isMon(c) && (ruleBox(c.def) || this.wantsFromDeck(g, pid, c)))) { t = item(['Night Stretcher']); if (t) return t; }
    // Special Red Card (the opponent is down to 3 Prizes or fewer): a big hand goes to the bottom for 3 new cards
    if (g.pl(opp).hand.length >= 5) { t = item(['Special Red Card']); if (t) return t; }
    // Brilliant Blender: Energy into the discard pile for Abyssal Flames
    if (this.plays(g, pid, 'Abyssal Flames') && me.discard.filter(c => c.def.cat === 'E').length < 12) { t = item(['Brilliant Blender']); if (t) return t; }
    // Energy Retrieval: Basic Energy back when the hand has none and something needs it
    if (!me.hand.some(c => c.def.cat === 'E') && g.inPlay(pid).some(m => this.needs(g, m).missing.length)) { t = item(['Energy Retrieval']); if (t) return t; }
    // Pokémon Catcher: a coin flip for a gust, when there's a Benched target to Knock Out
    if (active && this.gustTarget(g, pid)) { t = item(['Pokémon Catcher']); if (t) return t; }
    // Unfair Stamp after a Knock Out: when we'd rather have 5 new cards and the opponent 2
    if (me.hand.length <= 4 || g.pl(opp).hand.length >= 5) { t = item(['Unfair Stamp']); if (t) return t; }
    // Picnic Basket heals 30 from every Pokémon: when ours have more damage to heal
    t = trainers.find(x => x.c && x.c.name === 'Picnic Basket');
    if (t) { const healed = q => g.inPlay(q).reduce((s2, m) => s2 + Math.min(30, m.damage), 0); if (healed(pid) >= healed(opp) + 40 && once('picnic')) return t; }
    // Energy Recycler: Energy back into a deck running out of it
    if (me.deck.filter(isBasicEnergy).length <= 3 && me.discard.filter(isBasicEnergy).length >= 3) { t = item(['Energy Recycler']); if (t) return t; }
    // Premium Power Pro: +30 for a {F} attacker about to attack
    if (active && active.def.type === 'Fighting' && this.canAttackNow(g, active) && !g.hasEffect('premiumPower', { pid })) { t = item(['Premium Power Pro']); if (t) return t; }
    // Hisuian Heavy Ball: a Basic Pokémon from the Prize cards when we have none to play
    if (!me.hand.some(c => isMon(c) && c.def.stage === 'Basic') && me.bench.length < 4) { t = item(['Hisuian Heavy Ball']); if (t) return t; }
    // Lost Vacuum: the opponent's Tool or Stadium goes, and a card from hand fills the Lost Zone
    t = item(['Lost Vacuum']);
    if (t && this.vacuumUseful(g, pid, t.c)) return t;
    // Energy Switch: one Basic Energy from another Pokémon makes the Active ready to attack this turn
    t = trainers.find(x => x.c && x.c.name === 'Energy Switch');
    if (t && affordable(1)) { const plan = this.energySwitchPlan(g, pid); if (plan && once('eswitch', 2)) { this.eswitch = { turn: g.turn, ...plan }; return t; } }
    // Strange Timepiece on a Powerful Hand turn: devolve a healthy Benched Pokémon for more cards in hand
    if (handAttack) { t = trainers.find(x => x.c && x.c.name === 'Strange Timepiece'); if (t && this.timepieceTarget(g, pid) && once('timepiece')) return t; }

    // 3. Bench Basic Pokémon, the most useful first (keep Seek Inspiration's copy targets in hand; on Powerful Hand
    // turns only for backup; once three are down, leave the rest of the room for attackers and evolution lines)
    const benchOrder = by('bench').map(x => ({ x, c: card(x.card) })).filter(y => y.c).sort((p, q) => this.benchScore(g, pid, q.c) - this.benchScore(g, pid, p.c));
    for (const { x: b, c } of benchOrder) {
      if (me.bench.length >= 3 && this.benchScore(g, pid, c) < 40) continue;
      if (!c || this.copyFodder(g, pid, c) && me.bench.length >= 1) continue;
      if (handAttack && me.bench.length >= 2 && !affordable(1)) continue;
      // Gladion decks leave a Bench spot for what they draw later (emptying the hand)
      const cap = this.plays(g, pid, "Gladion's Final Battle", 'trainer') && me.bench.length >= 2 ? 4 : 5;
      if (once('bench:' + c.id) && me.bench.length < Math.min(g.benchLimit(pid), cap)) return b;
    }

    // 4. evolve (Stage 2 first)
    // engines (Baxcalibur, Gardevoir ex...) evolve on the Bench when there's a choice
    const isEngine = d => (d.abilities || []).some(isEngineAbility);
    const evoKey = x => (x.c.def.stage === 'Stage2' ? 2 : 0) + (isEngine(x.c.def) && x.target === (active && active.id) && by('evolve').some(y => y.card === x.card && y.target !== x.target) ? -3 : 0);
    const evo = by('evolve').map(x => ({ ...x, c: card(x.card) })).filter(x => affordable(x.c.def.name === 'Alakazam' ? -2 : x.c.def.name === 'Kadabra' ? -1 : 1)).sort((x, y) => evoKey(y) - evoKey(x));
    if (evo.length) return evo[0];

    // 5. Supporter
    const sup = trainers.filter(x => x.c && x.c.def.trainer === 'Supporter');
    if (sup.length && !gladion && once('sup', 3)) {
      const s = this.pickSupporter(g, pid, sup, { handAttack, affordable });
      if (s) return s;
    }
    // 6. Stadium: replace the opponent's, or play ours on an empty table
    const st = trainers.find(x => x.c && x.c.def.trainer === 'Stadium' && (!g.stadium || g.stadium.owner !== pid) && this.stadiumGood(g, pid, x.c) && affordable(1));
    if (st && once('stadium')) return st;
    // stadium actions
    const sa = by('stadium')[0];
    if (sa && this.stadiumUseGood(g, pid, sa.name) && once('stadium-use')) return sa;

    // 7. Tools
    for (const x of by('tool')) {
      const c = card(x.card), m = g.monById(x.target);
      if (c && m && affordable(1) && (this.toolFits(g, pid, c, m) || gladion) && once('tool:' + c.id)) return x;
    }
    // emptying the hand for Gladion: whatever else can still be played, then Ultra Ball for the rest
    if (gladion) {
      const left = me.hand.filter(c => c.name !== "Gladion's Final Battle");
      const ub = trainers.find(x => x.c && x.c.name === 'Ultra Ball');
      if (ub && left.length >= 3 && left.length - 1 <= 2 * left.filter(c => c.name === 'Ultra Ball').length && me.bench.length < g.benchLimit(pid) && once('gl-ub', 2)) return ub;
      const dump = trainers.find(x => x.c && x.c.def.trainer === 'Item' && x.c.name !== 'Ultra Ball' && ['Buddy-Buddy Poffin', 'Nest Ball', 'Switch', 'Energy Switch'].includes(x.c.name) && once('gl:' + x.c.id));
      if (dump && (dump.c.name !== 'Switch' || left.length === 1)) return dump;
    }

    // 8. energy attachment (a stuck Active Pokémon may need it to retreat)
    const switchTo = this.betterAttacker(g, pid);
    // nothing on the Bench can attack yet, but the Active is stuck for good: switch to the best prospect
    const prospect = !switchTo && this.stuckProspect(g, pid);
    if (prospect) {
      const sw = trainers.find(x => x.c && ['Switch', 'Switch Cart'].includes(x.c.name));
      if (sw && once('sw')) { this.switchPlan = { turn: g.turn, id: prospect.id }; return sw; }
      const r = by('retreat').find(x => x.to === prospect.id);
      if (r && once('retreat')) return r;
    }
    const en = by('energy');
    if (en.length && !(handAttack && !affordable(1))) {
      const choice = this.chooseEnergy(g, pid, en, switchTo);
      if (choice) return choice;
    }
    // more acceleration abilities once there is something to power
    a = pickAbility(['Psychic Embrace', 'Super Cold', 'Overvolt Discharge', 'Ripening Charge', 'Sinister Surge']);
    if (a && this.accelUseful(g, pid, a)) return a;

    // Mega Greninja ex's Mortal Shuriken: a Water Energy from the hand for 6 damage counters, when they Knock Out
    // something or there's Water Energy to spare
    a = abil.find(x => x.name === 'Mortal Shuriken' && once('ab:' + x.mon + x.name));
    if (a && (g.inPlay(opp).some(m => g.hpLeft(m) <= 60 && !g.abilityBlocked(pid, m)) || me.hand.filter(c => isBasicEnergy(c, 'Water')).length >= 2)) return a;
    // 9. damage tricks: Munkidori, Cursed Blast, Hyper Blower, Teleporter
    a = abil.find(x => x.name === 'Adrena-Brain' && this.adrenaUseful(g, pid) && once('ab:' + x.mon + x.name));
    if (a) return a;
    a = abil.find(x => x.name === 'Cursed Blast' && this.blastUseful(g, pid, g.monById(x.mon)) && once('ab:' + x.mon + x.name));
    if (a) return a;
    a = abil.find(x => x.name === 'Teleporter' && switchTo && once('ab:' + x.mon + x.name));
    if (a) return a;

    // 10. gust a Benched Pokémon we can Knock Out for more Prizes
    const gusts = trainers.filter(x => x.c && ['Prime Catcher', 'Counter Catcher'].includes(x.c.name));
    if (gusts.length && active && affordable(1) && this.gustTarget(g, pid)) return gusts[0];

    // 11. retreat or switch to a better attacker
    if (switchTo) {
      const sw = trainers.find(x => x.c && ['Switch', 'Switch Cart'].includes(x.c.name));
      if (sw && once('sw')) { this.switchPlan = { turn: g.turn, id: switchTo.id }; return sw; }
      const r = by('retreat').find(x => x.to === switchTo.id);
      if (r && once('retreat')) return r;
      const surf = sa && sa.name === 'Surfing Beach' && switchTo.def.type === 'Water' && active && active.def.type === 'Water' ? sa : null;
      if (surf && once('surf')) return surf;
    }
    // Slowking: put the best Pokémon to copy on top of the deck before Seek Inspiration
    if (sa && sa.name === 'Academy at Night' && this.academyCard(g, pid) && once('academy')) return sa;
    // Gladion's Final Battle is only playable as the last card in hand: play it right before attacking
    const gl = trainers.find(x => x.c && x.c.name === "Gladion's Final Battle");
    if (gl && active && this.canAttackNow(g, active) && !ruleBox(active.def) && once('gladion')) return gl;

    // 12. attack
    const atks = by('attack');
    if (atks.length && active) {
      let best = null;
      for (const x of atks) {
        const atk = g.attacksOf(active).find(y => y.name === x.name && y.src === x.src);
        let v = this.estimate(g, pid, active, atk, oppActive);
        if (SETUP_ATTACKS.has(atk.name) || atk.name === 'Motivate') v = Math.max(v, me.bench.length < 3 || me.hand.length < 3 ? 70 : 10);
        if (atk.name === 'Tuck Tail' && active.damage > 0) v += 60;
        if (atk.name === 'Rapid Draw' || atk.name === 'Puppet Pull') v += 10;
        const ko = oppActive && v >= g.hpLeft(oppActive);
        // an attack that draws cards must not deck us out
        if ((atk.name === 'Rapid Draw' && me.deck.length < 2 || atk.name === 'Collect' && !me.deck.length) && !ko) continue;
        const score = v + (ko ? 300 * g.prizeValue(oppActive) : 0) + this.benchValue(g, pid, active, atk);
        if (!best || score > best.score) best = { x, score };
      }
      if (best) return best.x;
    }
    return { t: 'end' };
  }

  // Lost Zone Box: Comfey's Flower Selecting only works in the Active Spot. Retreat (or switch) into a Benched
  // Comfey when another switch is in hand to bring the attacker back
  comfeyPivot(g, pid, actions) {
    const me = g.pl(pid), a = me.active;
    if (!a || hasAbil(a.def, 'Flower Selecting') || me.deck.length <= 10) return null;
    const comfey = me.bench.find(m => g.hasAbility(m, 'Flower Selecting') && m.used['Flower Selecting'] !== g.turn);
    if (!comfey) return null;
    const switches = me.hand.filter(c => c.name === 'Switch' || c.name === 'Switch Cart');
    const r = actions.find(x => x.t === 'retreat' && x.to === comfey.id);
    if (r && switches.length >= 1 && (g.retreatCost(a) === 0 || !this.canAttackNow(g, a))) return r;
    const sw = actions.find(x => x.t === 'trainer' && me.hand.find(c => c.id === x.card && (c.name === 'Switch' || (c.name === 'Switch Cart' && a.def.stage === 'Basic'))));
    if (sw && switches.length >= 2 && this.canAttackNow(g, a)) return sw;
    return null;
  }
  // how much a Basic Pokémon in hand is worth putting on the Bench: evolution lines, attackers, useful Abilities
  benchScore(g, pid, c) {
    const d = c.def;
    let best = 0;
    for (const atk of d.attacks || []) { const n = parseInt(atk.damage, 10) || 0; best = Math.max(best, NOMINAL[atk.name] || (/×/.test(atk.damage) ? n * 3 : /\+/.test(atk.damage) ? n + 60 : n)); }
    let s = best / 2 + (d.ex ? 10 : 0);
    // the start of an evolution line: first while fewer than two of that line are in play
    if (this.lineStart(g, pid, d)) s += g.inPlay(pid).filter(m => m.stack[0].def.name === d.name).length < 2 ? 120 : 40;
    if ((d.abilities || []).some(a => /draw|search your deck|into your hand|attach|no Retreat Cost|Energy/i.test(a.text))) s += 30;
    if (this.copyFodder(g, pid, c)) s -= 100;
    return s;
  }
  // a Gladion's Final Battle turn: it's in hand, no Supporter played yet, and the Active (no Rule Box) can attack
  gladionPlan(g, pid) {
    const me = g.pl(pid), a = me.active;
    if (me.supporter || !a || ruleBox(a.def) || !me.hand.some(c => c.name === "Gladion's Final Battle")) return false;
    if (g.turn === 1 && g.first === pid) return false;
    if (!(this.canAttackNow(g, a) || (!me.energyDone && me.hand.some(c => c.def.cat === 'E') && this.needs(g, a).missing.length <= 1))) return false;
    // can the rest of the hand be played out this turn? count what can't, and what Ultra Ball can discard
    const mons = g.inPlay(pid);
    let room = g.benchLimit(pid) - me.bench.length, energy = me.energyDone ? 0 : 1, stadium = me.stadiumDone ? 0 : 1, gl = 0, stuck = 0, balls = 0;
    const toolSpots = mons.filter(m => !m.tool).length;
    let tools = 0;
    for (const c of me.hand) {
      const d = c.def;
      if (c.name === "Gladion's Final Battle") { if (gl++) stuck++; continue; }
      if (c.name === 'Ultra Ball') { balls++; continue; }
      if (d.cat === 'E') { if (energy) energy--; else stuck++; }
      else if (d.cat === 'P') { if (d.stage === 'Basic' && room > 0) room--; else if (d.stage === 'Basic' || !mons.some(m => m.name === d.from && g.canEvolveNow(m, d))) stuck++; }
      else if (d.trainer === 'Supporter') stuck++;
      else if (d.trainer === 'Stadium') { if (stadium && g.stadiumName() !== c.name) stadium--; else stuck++; }
      else if (d.trainer === 'Tool') { if (tools < toolSpots) tools++; else stuck++; }
      else if (!g.legalActions(pid).some(x => x.card === c.id)) stuck++;
    }
    // each Ultra Ball discards 2 and brings a Pokémon, which needs room on the Bench (a Thwackey can search one)
    if (!balls && me.deck.some(c => c.name === 'Ultra Ball') && g.inPlay(pid).some(m => g.hasAbility(m, 'Boom Boom Groove') && m.used['Boom Boom Groove'] !== g.turn)) balls = 1;
    return stuck <= 2 * Math.min(balls, Math.max(0, room));
  }
  // the Active can't attack this turn or next (Energy far off, Retreat Cost it can't pay): the Benched Pokémon
  // closest to attacking, or one with an Active-only Ability (Comfey's Flower Selecting)
  stuckProspect(g, pid) {
    const me = g.pl(pid), a = me.active;
    if (!a || !me.bench.length || this.canAttackNow(g, a)) return null;
    const na = this.needs(g, a);
    if (na.missing.length <= 1 && !(a.special === 'asleep' || a.special === 'paralyzed')) return null;
    const activeOnly = m => (m.def.abilities || []).some(x => /Active Spot/.test(x.text) && g.hasAbility(m, x.name) && m.used[x.name] !== g.turn);
    const value = m => {
      const n = this.needs(g, m);
      return (n.missing.length <= 1 ? 100 : 0) - 25 * n.missing.length + n.dmg / 10 + (activeOnly(m) ? 60 : 0) - (m.def.ex && n.missing.length > 1 ? 30 : 0);
    };
    // only a Pokémon one Energy from attacking, or one that does something up front
    const opts = me.bench.filter(m => this.needs(g, m).missing.length <= 1 || activeOnly(m));
    const best = opts.sort((x, y) => value(y) - value(x))[0];
    return best && value(best) > value(a) + 20 ? best : null;
  }
  vacuumUseful(g, pid, vac) {
    const me = g.pl(pid), o = g.opp(pid);
    if (!me.hand.some(c => c !== vac && this.cardScore(g, pid, c) < 45)) return false;
    if (g.inPlay(o).some(m => m.tool) || (g.stadium && g.stadium.owner === o)) return true;
    // our own Stadium, just to fill the Lost Zone for Lost Mine
    return !!(g.stadium && this.plays(g, pid, 'Lost Mine') && me.lost.length < 10);
  }
  // Energy Switch for the Active: which Pokémon gives which Energy (null when it doesn't make the Active ready)
  energySwitchPlan(g, pid) {
    const me = g.pl(pid), a = me.active;
    if (!a || this.canAttackNow(g, a) || g.turn === 1 && g.first === pid) return null;
    const need = this.needs(g, a);
    if (!need.missing.length || !need.atk) return null;
    const fits = c => isBasicEnergy(c) && (need.missing.includes(c.def.provides) || need.missing.includes('Colorless'));
    // the manual attachment still to come covers one more
    const handFits = !me.energyDone && me.hand.some(c => c.def.cat === 'E' && (need.missing.includes(c.def.provides) || need.missing.includes('Colorless') || c.def.anyType));
    if (need.missing.length - 1 - (handFits ? 1 : 0) > 0) return null;
    let best = null;
    for (const m of me.bench) for (const c of m.energy) {
      if (!fits(c)) continue;
      // take it from the Pokémon that loses the least: one that isn't ready anyway, or has Energy to spare
      const v = (this.needs(g, m).missing.length ? 0 : -20) + this.attackerValue(g, m) / 10;
      if (!best || v < best.v) best = { v, from: m.id, card: c.id, to: a.id };
    }
    return best;
  }
  // Apex Dragon: the attacks of the Dragon Pokémon in the discard pile it can use
  apexChoices(g, pid) {
    const me = g.pl(pid);
    return me.discard.filter(c => isMon(c) && c.def.type === 'Dragon').flatMap(c => (c.def.attacks || []).filter(a => a.name !== 'Apex Dragon' && !(a.name === 'Star Requiem' && (me.lost.length < 10 || me.vstarUsed))));
  }
  // Legacy Star: worth the once-a-game VSTAR Power when the hand is small and the discard pile has good cards
  legacyUseful(g, pid) {
    const me = g.pl(pid);
    if (me.vstarUsed) return false;
    const good = me.discard.filter(c => this.cardScore(g, pid, c) >= 55).length;
    return (me.hand.length <= 3 && good >= 2) || (g.turn >= 9 && good >= 2);
  }
  // Solar Transfer: a Basic {G} Energy from a Pokémon that can spare it onto the Active Pokémon that needs it
  solarPlan(g, pid) {
    const me = g.pl(pid), a = me.active;
    if (!a || this.canAttackNow(g, a)) return null;
    const need = this.needs(g, a);
    if (!need.missing.some(t => t === 'Grass' || t === 'Colorless')) return null;
    let best = null;
    for (const m of me.bench) {
      const c = m.energy.find(x => isBasicEnergy(x, 'Grass'));
      if (!c) continue;
      const v = (this.needs(g, m).missing.length ? 0 : -20) + this.attackerValue(g, m) / 10;
      if (!best || v < best.v) best = { v, from: m.id, card: c.id, to: a.id };
    }
    return best;
  }
  // Strange Timepiece target: an evolved {P} Pokémon on the Bench that survives devolving
  timepieceTarget(g, pid) {
    return g.pl(pid).bench.filter(m => m.stack.length > 1 && m.def.type === 'Psychic' && m.damage < m.stack[0].def.hp).sort((x, y) => y.stack.length - x.stack.length)[0] || null;
  }
  // Academy at Night: the card from hand that Seek Inspiration should copy next
  academyCard(g, pid) {
    const me = g.pl(pid), a = me.active;
    if (!a || !g.attacksOf(a).some(x => x.name === 'Seek Inspiration' && !g.attackBlock(a, x))) return null;
    const target = g.pl(g.opp(pid)).active;
    const val = c => (isMon(c) && !ruleBox(c.def) ? this.copyBest(g, pid, a, target, c.def.attacks || []).score : 0);
    const top = this.knownTop(g, pid);
    const now = top ? val(top) : (() => { const d = me.deck.map(val); return d.length ? d.reduce((s, x) => s + x, 0) / d.length : 0; })();
    const best = me.hand.filter(c => isMon(c) && !ruleBox(c.def)).sort((x, y) => val(y) - val(x))[0];
    return best && val(best) > now + 20 ? best : null;
  }

  stadiumUseGood(g, pid, name) {
    const me = g.pl(pid);
    if (name === 'Artazon') return me.bench.length < 4;
    if (name === 'Mystery Garden') return me.hand.length <= 3;
    if (name === 'Surfing Beach') { const b = this.betterAttacker(g, pid); return !!(b && b.def.type === 'Water'); }
    if (name === 'Prism Tower') return me.deck.length > 10 && this.junk(g, pid, me.hand).length >= 2 && !(me.active && g.attacksOf(me.active).some(a => a.name === 'Powerful Hand'));
    if (name === "Team Rocket's Factory") return me.deck.length > 8;
    if (name === 'Spikemuth Gym') return me.deck.some(c => isMon(c) && /^Marnie's /.test(c.name)) && me.hand.filter(isMon).length <= 1;
    return false;
  }
  hasJunk(g, pid, except, n) { return g.pl(pid).hand.filter(c => c !== except).length >= n; }
  // cards in hand worth the least right now
  junk(g, pid, cards) { return this.rankCards(g, pid, cards, { hint: 'discard' }).reverse().filter(c => this.cardScore(g, pid, c) < 40); }
  stadiumGood(g, pid, c) {
    const n = c.name, me = g.pl(pid);
    const all = [...me.hand, ...me.deck, ...g.inPlay(pid).map(m => m.card)];
    if (n === 'Area Zero Underdepths') return g.inPlay(pid).some(m => m.def.tera);
    if (n === 'Surfing Beach') return g.inPlay(pid).filter(m => m.def.type === 'Water').length >= 2;
    if (n === 'Festival Grounds') return g.inPlay(pid).some(m => g.hasAbility(m, 'Festival Lead'));
    if (n === 'Forest of Vitality') return me.hand.some(x => isMon(x) && x.def.stage !== 'Basic' && x.def.type === 'Grass');
    if (n === "N's Castle") return g.inPlay(pid).some(isNs);
    if (n === 'Jamming Tower') { const tools = q => g.inPlay(q).filter(m => m.tool).length; return tools(g.opp(pid)) > tools(pid) && !all.some(x => x.def.trainer === 'Tool'); }
    // Stadiums that hit both sides: only when they hurt the opponent more
    const count = (q, f) => g.inPlay(q).filter(f).length;
    if (n === 'Gravity Mountain') return count(g.opp(pid), m => m.def.stage === 'Stage2') > count(pid, m => m.def.stage === 'Stage2');
    if (n === "Team Rocket's Watchtower") { const c = m => m.def.type === 'Colorless' && (m.def.abilities || []).length; return count(g.opp(pid), c) >= count(pid, c); }
    if (n === 'Postwick') return g.inPlay(pid).some(m => /^Hop's /.test(m.name));
    if (n === 'Spikemuth Gym') return all.some(x => isMon(x) && /^Marnie's /.test(x.name));
    return true;
  }
  toolFits(g, pid, c, m) {
    const n = c.name, me = g.pl(pid);
    if (g.stadiumName() === 'Jamming Tower') return false;
    if (n === 'Bravery Charm') return m.def.stage === 'Basic' && this.needs(g, m).dmg >= 60;
    if (n === 'Air Balloon') return me.active === m && g.retreatCost(m) >= 2;
    if (n === 'Rescue Board') return me.active === m;
    if (n === 'Luxurious Cape') return !ruleBox(m.def);
    if (n === 'Sparkling Crystal') return m.def.tera;
    if (n === 'Ancient Booster Energy Capsule') return m.def.ancient;
    // a Technical Machine is discarded at the end of the turn: only when its attack can be used this turn
    if (n === 'Technical Machine: Evolution') return me.active === m && !(g.turn === 1 && g.first === pid) && !g.attackBlock(m, { ...c.def.attacks[0], src: 'tm' }) && me.bench.some(b => me.deck.some(x => isMon(x) && x.def.from === b.name)) && !(this.bestAttack(g, pid, m) || {}).ko;
    if (n === 'Defiance Band' || n === 'Vitality Band') return this.needs(g, m).dmg >= 100;
    if (n === 'Lucky Helmet') return me.active === m;
    if (n === 'Brave Bangle') return !ruleBox(m.def) && this.needs(g, m).dmg >= 50;
    if (n === 'Binding Mochi') return me.active === m && (m.poisoned || g.inPlay(pid).some(x => g.hasAbility(x, 'Subjugating Chains')));
    if (n === "Hero's Cape") return this.needs(g, m).dmg >= 100 && (me.active === m || m.def.stage !== 'Basic');
    if (n === "Cynthia's Power Weight") return /^Cynthia's /.test(m.name) && (m.def.stage !== 'Basic' || me.active === m);
    if (n === "Hop's Choice Band") return /^Hop's /.test(m.name) && this.needs(g, m).dmg >= 50;
    return true;
  }
  pickSupporter(g, pid, sup, { handAttack = false, affordable = () => true } = {}) {
    const me = g.pl(pid), opp = g.opp(pid);
    const named = n => sup.find(x => x.c.name === n);
    const oppActive = g.pl(opp).active;
    // Powerful Hand turns: only Supporters that leave more cards in hand (or win the game)
    if (handAttack) {
      // what each one costs in cards (negative: the hand grows)
      const spareMons = Math.min(2, me.hand.filter(c => isMon(c) && !ruleBox(c.def)).length);
      const cost = { Hilda: -1, Dawn: -2, Gwynn: 1 - 2 * spareMons, Naveen: me.hand.length - 5 };
      for (const n of ['Dawn', 'Gwynn', 'Hilda', 'Naveen']) { const x = named(n); if (x && cost[n] < 0) return x; }
      const boss = named("Boss's Orders");
      if (boss && affordable(1) && this.gustTarget(g, pid)) return boss;
      return null;
    }
    // Boss's Orders when a Benched target can be Knocked Out for more Prizes than the Active
    const boss = named("Boss's Orders") || named("Lisia's Appeal") || named("Team Rocket's Giovanni");
    if (boss && this.gustTarget(g, pid)) return boss;
    // Wally's Compassion: a badly damaged Mega Evolution Pokémon ex is healed (its Energy comes back to hand)
    const wally = named("Wally's Compassion");
    if (wally && g.inPlay(pid).some(m => m.def.mega && m.damage >= 150)) return wally;
    // Professor Turo's Scenario: pick up a badly damaged Pokémon ex before it gives up Prizes
    const turo = named("Professor Turo's Scenario");
    if (turo && g.inPlay(pid).some(m => ruleBox(m.def) && m.damage >= g.maxHp(m) / 2 && g.hpLeft(m) <= 120 && (me.bench.length || !g.isActive(m))) && me.bench.length >= 2) return turo;
    if (named('Briar')) return named('Briar');
    // Kieran: 30 more damage when that turns a hit on a Pokémon ex (or V) into a Knock Out
    const kieran = named('Kieran');
    if (kieran && oppActive && (oppActive.def.ex || oppActive.def.v) && me.active) { const b = this.bestAttack(g, pid, me.active); if (b && !b.ko && b.v + 30 >= g.hpLeft(oppActive)) return kieran; }
    // Lost Zone decks: Colress's Experiment fills the Lost Zone (Cramorant at 4, Mirage Gate at 7, Lost Mine at 10)
    const colress = named("Colress's Experiment");
    if (colress && me.lost.length < 10 && me.deck.length > 6 && (this.plays(g, pid, 'Lost Mine') || g.inPlay(pid).some(m => g.hasAbility(m, 'Lost Provisions')))) return colress;
    // Black Belt's Training when it turns a hit on a Pokémon ex into a Knock Out
    const belt = named("Black Belt's Training");
    if (belt && oppActive && oppActive.def.ex && me.active) { const b = this.bestAttack(g, pid, me.active); if (b && !b.ko && b.v + 40 >= g.hpLeft(oppActive)) return belt; }
    const xero = named("Xerosic's Machinations");
    if (xero && g.pl(opp).hand.length >= 6) return xero;
    const eri = named('Eri');
    if (eri && g.pl(opp).hand.length >= 5 && me.hand.length >= 3) return eri;
    // Pokémon Center Lady: save a damaged attacker
    const lady = named('Pokémon Center Lady');
    if (lady && me.active && me.active.damage >= 60 && g.hpLeft(me.active) <= 120) return lady;
    const deckLow = me.deck.length <= 8;
    // a huge hand and a thin deck (Rapid Draw every turn): shuffle the hand back in before decking out
    const reset = named("Lillie's Determination") || named('Judge');
    if (reset && me.hand.length >= 9 && me.deck.length <= 15) return reset;
    const iono = named('Iono');
    if (iono && !deckLow && (g.pl(opp).hand.length >= 5 && g.prizesLeft(opp) <= g.prizesLeft(pid) || me.hand.length <= 3)) return iono;
    if (me.turns <= 3) for (const x of sup) if (SETUP_SUPPORTERS.has(x.c.name) && this.setupUseful(g, pid, x.c)) return x;
    const rox = named('Roxanne');
    if (rox && !deckLow && me.hand.length <= 5) return rox;
    // Surfer: a switch and cards
    const surfer = named('Surfer');
    if (surfer && me.hand.length <= 4 && this.betterAttacker(g, pid)) return surfer;
    if (!deckLow) for (const x of sup) if (DRAW_SUPPORTERS.has(x.c.name) && !['Roxanne', 'Iono', 'Surfer'].includes(x.c.name) && this.drawUseful(g, pid, x.c)) return x;
    for (const x of sup) if (SETUP_SUPPORTERS.has(x.c.name) && this.setupUseful(g, pid, x.c)) return x;
    if (deckLow && me.hand.length <= 1) return sup.find(x => DRAW_SUPPORTERS.has(x.c.name)) || null;
    return null;
  }
  drawUseful(g, pid, c) {
    const me = g.pl(pid);
    if (c.name === "Lillie's Determination") return true;
    // Rocket Feathers decks keep Team Rocket Supporters in hand as fuel: draw only with a small hand
    if (c.name === "Team Rocket's Ariana") return me.hand.length <= (this.plays(g, pid, 'Rocket Feathers') ? 3 : 4);
    if (c.name === "Team Rocket's Archer" || c.name === 'Harlequin') return me.hand.length <= 3 || g.pl(g.opp(pid)).hand.length >= 6;
    if (c.name === "Iris's Fighting Spirit") return me.hand.length <= 4;
    if (c.name === 'Hassel') return true;
    if (c.name === 'Gwynn') return me.hand.some(x => isMon(x) && !ruleBox(x.def) && this.cardScore(g, pid, x) < 60) || me.hand.length <= 3;
    if (c.name === 'Naveen') return me.hand.length <= 3;
    if (c.name === "Colress's Experiment" && g.inPlay(pid).some(m => g.hasAbility(m, 'Lost Provisions') || (m.def.attacks || []).some(a => a.name === 'Lost Mine'))) return me.hand.length <= 8;
    return me.hand.length <= 6;
  }
  setupUseful(g, pid, c) {
    const me = g.pl(pid);
    if (c.name === 'Salvatore') return g.inPlay(pid).some(m => me.deck.some(x => isMon(x) && x.def.stage !== 'Basic' && g.evolvesFrom(m, x.def) && !(x.def.abilities || []).length));
    if (c.name === 'Penny') return false;
    if (c.name === "Ethan's Adventure") return me.deck.some(x => (isMon(x) && /^Ethan's /.test(x.name)) || isBasicEnergy(x, 'Fire'));
    if (c.name === "Larry's Skill") return me.hand.length <= 3;
    if (c.name === "Janine's Secret Art") return g.inPlay(pid).some(m => m.def.type === 'Darkness' && this.needs(g, m).missing.length) && me.deck.some(x => isBasicEnergy(x) && x.def.provides === 'Darkness');
    return true;
  }
  // the opponent's Benched Pokémon our Active (or best ready attacker) can Knock Out, worth more than the Active
  gustTarget(g, pid) {
    const me = g.pl(pid), opp = g.pl(g.opp(pid));
    if (!me.active || !opp.bench.length) return null;
    let best = null;
    for (const t of opp.bench) {
      let dmg = 0;
      for (const atk of g.attacksOf(me.active)) {
        if (g.attackBlock(me.active, atk) && !/Not enough Energy/.test(g.attackBlock(me.active, atk) || '')) continue;
        if (!g.canPay(me.active, g.attackCost(me.active, atk), g.costMinus(me.active)) && !(me.energyDone === false && this.oneShort(g, me.active, atk))) continue;
        dmg = Math.max(dmg, this.estimate(g, pid, me.active, atk, t));
      }
      if (dmg >= g.hpLeft(t)) {
        const v = g.prizeValue(t) * 10 + (t.def.ex ? 5 : 0) + this.needs(g, t).dmg / 100;
        if (!best || v > best.v) best = { t, v };
      }
    }
    if (!best) return this.wallTarget(g, pid);
    const act = opp.active;
    const actKO = act && this.bestAttack(g, pid, me.active) && this.bestAttack(g, pid, me.active).ko;
    if (actKO && g.prizeValue(act) >= g.prizeValue(best.t)) return null;
    return best.t;
  }
  // our Active can't hurt the Defending Pokémon (Crustle against Pokémon ex, Dig...): the Benched Pokémon it hurts most
  wallTarget(g, pid) {
    const me = g.pl(pid), opp = g.pl(g.opp(pid));
    if (!me.active || !opp.active || !opp.bench.length) return null;
    const ready = g.attacksOf(me.active).filter(atk => !g.attackBlock(me.active, atk));
    if (!ready.length) return null;
    const vs = t => Math.max(0, ...ready.map(atk => this.estimate(g, pid, me.active, atk, t)));
    if (vs(opp.active) > 0) return null;
    const best = [...opp.bench].sort((x, y) => vs(y) - vs(x))[0];
    return best && vs(best) >= 60 ? best : null;
  }
  oneShort(g, mon, atk) { return this.needs(g, mon).missing.length <= 1; }
  // a Benched Pokémon to switch in: ready to attack and clearly better than the Active, or any ready attacker
  // when the Active can't attack at all (no Energy for it, Asleep, Paralyzed, can't attack this turn)
  betterAttacker(g, pid) {
    const me = g.pl(pid);
    const a = me.active;
    const cur = a ? this.bestAttack(g, pid, a) : null;
    let best = null;
    for (const b of me.bench) {
      const ba = this.bestAttack(g, pid, b, { needReady: false });
      const ready = (b.def.attacks || []).some(atk => g.canPay(b, g.attackCost(b, atk), g.costMinus(b))) || this.superColdReady(g, pid, b);
      if (!ready || !ba) continue;
      const v = ba.score;
      if (!best || v > best.v) best = { b, v };
    }
    if (!best) return null;
    // the Active can't attack this turn, not even after one more Energy: any decent ready attacker is better
    const n = a ? this.needs(g, a) : null;
    const stuck = !cur && (!a || a.special === 'asleep' || a.special === 'paralyzed' || g.hasEffect('cantAttack', { mon: a }) || n.missing.length > 1 || (n.missing.length && me.energyDone));
    if (stuck && best.v >= 40) return best.b;
    if (!cur) return n && n.missing.length <= 1 && !me.energyDone ? null : best.v >= 40 ? best.b : null;
    if (cur.v <= 0 && !cur.ko && best.v > 30) return best.b;
    // Confused attackers hit themselves half the time
    const curScore = a.special === 'confused' ? cur.score / 2 : cur.score;
    // an engine in the Active Spot (Baxcalibur) gives way to a ready attacker
    if ((a.def.abilities || []).some(isEngineAbility) && !(best.b.def.abilities || []).some(isEngineAbility) && best.v >= curScore - 20) return best.b;
    if (!cur.ko && best.v > curScore + 150) return best.b;
    if (a.special === 'confused' && best.v >= curScore + 40) return best.b;
    return null;
  }
  chooseEnergy(g, pid, en, switchTo = null) {
    const me = g.pl(pid);
    const handE = [...new Set(en.map(x => x.card))].map(id => me.hand.find(c => c.id === id));
    const a = me.active;
    // a stuck Active Pokémon one Energy short of its Retreat Cost: pay for the retreat
    if (switchTo && a && !me.retreated && !me.hand.some(c => c.name === 'Switch' || (c.name === 'Switch Cart' && a.def.stage === 'Basic'))
      && g.retreatCost(a) - g.energyTypes(a).length === 1 && !this.canAttackNow(g, a)) {
      const c = handE.find(x => x.name !== 'Jet Energy') || handE[0];
      if (c && c.name === 'Jet Energy') { const x = en.find(e => e.card === c.id && e.target === switchTo.id); if (x) return x; }
      if (c) { const x = en.find(e => e.card === c.id && e.target === a.id); if (x) return x; }
    }
    // best target: the Active if this attachment lets it attack (or attack better), else the most valuable attacker missing Energy
    const mons = g.inPlay(pid);
    let best = null;
    for (const c of handE) {
      for (const m of mons) {
        const need = this.needs(g, m);
        let v;
        if (!need.missing.length) {
          // Energy that does something on its own still has a use
          if (c.name === 'Telepathic Psychic Energy' && m.def.type === 'Psychic' && me.bench.length < g.benchLimit(pid) && me.deck.some(x => isMon(x) && x.def.stage === 'Basic' && x.def.type === 'Psychic')) v = 12;
          else if (c.name === 'Enriching Energy' && me.deck.length > 8) v = 10;
          else continue;
        } else {
          const fits = need.missing.includes(c.def.provides) || need.missing.includes('Colorless') || c.def.anyType;
          if (!fits) continue;
          // Jet Energy switches a Benched Pokémon in: only one it makes ready to attack, and better than the Active
          if (c.name === 'Jet Energy' && m !== me.active) {
            if (need.missing.length !== 1) continue;
            const cur = a && this.bestAttack(g, pid, a);
            const mine = this.bestAttack(g, pid, m, { needReady: false });
            if (cur && (!mine || mine.score <= cur.score + 40)) continue;
          }
          v = need.dmg / 10 + (m.def.ex ? 6 : 0) + (m.def.stage !== 'Basic' ? 4 : 0);
          if (m === me.active) v += need.missing.length === 1 ? 25 : 8;
          if (need.missing.length === 1) v += 6;
          if (m.def.retreat === 0 && need.dmg < 60) v -= 10;
          if (this.copyFodder(g, pid, m.card)) v -= 20;
        }
        if (c.name === 'Telepathic Psychic Energy' && m.def.type === 'Psychic' && me.bench.length < g.benchLimit(pid) - 1) v += 10;
        if (c.name === 'Enriching Energy' && me.deck.length > 8) v += 8;
        if (c.name === 'Mist Energy' || c.name === 'Spiky Energy') v += m === me.active ? 4 : 0;
        if (!best || v > best.v) best = { c, m, v };
      }
    }
    if (!best) {
      // nothing needs Energy: hold Jet Energy; put a basic on the Active for retreat money if it has none
      const c = handE.find(x => x.name !== 'Jet Energy');
      if (c && a && !a.energy.length && g.retreatCost(a) > 0 && me.bench.length) best = { c, m: a };
    }
    if (!best) return null;
    return en.find(x => x.card === best.c.id && x.target === best.m.id) || null;
  }
  accelUseful(g, pid, a) {
    if (a.name === 'Overvolt Discharge') return g.inPlay(pid).some(m => m.def.type === 'Lightning' && m.name !== 'Magneton' && this.needs(g, m).missing.length);
    if (a.name === 'Psychic Embrace') return g.inPlay(pid).some(m => m.def.type === 'Psychic' && this.needs(g, m).missing.length && g.hpLeft(m) > 60);
    if (a.name === 'Super Cold') return g.inPlay(pid).some(m => m.energy.filter(c => c.def.provides === 'Water').length < 4 && (this.needs(g, m).dmg >= 100 || m.name === 'Chien-Pao ex'));
    if (a.name === 'Ripening Charge') return true;
    // Toxtricity: the Benched {D} Pokémon takes 2 damage counters, so only onto one that needs it and survives well
    if (a.name === 'Sinister Surge') return g.pl(pid).bench.some(m => m.def.type === 'Darkness' && this.needs(g, m).missing.length && g.hpLeft(m) > 60);
    return true;
  }
  // a Pokémon worth taking from the deck: something to evolve into, or a Basic for an empty Bench spot
  wantsFromDeck(g, pid, c) {
    const me = g.pl(pid);
    if (me.hand.some(x => x.name === c.name)) return false;
    if (c.def.stage === 'Basic') return me.bench.length < g.benchLimit(pid) && g.inPlay(pid).filter(m => m.name === c.name).length < 2;
    return g.inPlay(pid).some(m => m.name === c.def.from);
  }
  adrenaUseful(g, pid) {
    const opp = g.pl(g.opp(pid));
    if (!g.inPlay(pid).some(m => m.damage >= 10)) return false;
    // set up Terminal Period (exactly 6 counters) or finish something off
    if (opp.active && g.inPlay(pid).some(m => (m.def.attacks || []).some(x => x.name === 'Terminal Period'))) { const c = g.counters(opp.active); if (c >= 3 && c < 6) return true; }
    return true;
  }
  blastUseful(g, pid, mon) {
    const n = mon.name === 'Dusknoir' ? 130 : 50;
    const opp = g.pl(g.opp(pid));
    const targets = g.inPlay(g.opp(pid)).filter(m => !g.abilityBlocked(pid, m));
    if (targets.some(m => g.hpLeft(m) <= n && g.prizeValue(m) >= g.prizeValue(mon))) return true;
    // Dusknoir's 13 counters plus this turn's attack on the Active
    const me = g.pl(pid);
    if (n === 130 && opp.active && targets.includes(opp.active) && me.active && me.active !== mon && g.prizeValue(opp.active) >= 2) {
      const b = this.bestAttack(g, pid, me.active);
      if (b && !b.ko && b.v + n >= g.hpLeft(opp.active)) return true;
    }
    return false;
  }

  // ------------------------------------------------------------ choices
  cards(g, pid, req) {
    const me = g.pl(pid);
    const opts = req.options.map(id => g.cardById(id)).filter(Boolean);
    const want = n => this.rankCards(g, pid, opts, req).slice(0, n).map(c => c.id);
    const hint = req.hint || 'take';
    if (hint === 'setup-active') return [this.starter(g, pid, opts).id];
    if (hint === 'setup-bench') return this.setupBench(g, pid, opts, req.max);
    if (hint === 'discard' || hint === 'retreat-cost') {
      let order = this.rankCards(g, pid, opts, req).reverse();
      // keep Gladion's Final Battle while emptying the hand for it
      if (this.gplan === g.turn) order = [...order.filter(c => c.name !== "Gladion's Final Battle"), ...order.filter(c => c.name === "Gladion's Final Battle")];
      return order.slice(0, req.min || 1).map(c => c.id);
    }
    if (hint.startsWith('fuel:')) return this.fuelCards(g, pid, opts, req, +hint.slice(5));
    if (hint === 'opp-discard') return [this.rankCards(g, g.opp(pid), opts, { hint: 'take' })[0].id];
    if (hint === 'opp-discard-n') return this.rankCards(g, g.opp(pid), opts, { hint: 'take' }).slice(0, req.max).map(c => c.id);
    if (hint === 'move-to-active') return opts.map(c => c.id).slice(0, req.max);
    if (hint === 'move' && this.eswitch && this.eswitch.turn === g.turn && opts.some(c => c.id === this.eswitch.card)) return [this.eswitch.card];
    if (hint === 'discard-draw') {
      // Gwynn: Pokémon we can spare, 3 cards each
      const ranked = this.rankCards(g, pid, opts, req).reverse();
      const spare = ranked.filter(c => this.cardScore(g, pid, c) < 70 || hasAbil(c.def, SNEAK));
      // nothing to spare: Gwynn was still worth playing for a small hand, so the least useful Pokémon goes
      const pool = spare.length ? spare : ranked.slice(0, 1);
      return pool.slice(0, Math.max(req.min, Math.min(req.max, pool.length))).map(c => c.id);
    }
    if (hint === 'discard-any') return this.junk(g, pid, opts).slice(0, Math.max(0, opts.length - 2)).map(c => c.id);
    // Brilliant Blender, Drilbur's Dig Dig Dig: Energy from the deck into the discard pile (Abyssal Flames counts it)
    if (hint === 'discard-deck') return opts.filter(c => c.def.cat === 'E').slice(0, req.max).map(c => c.id);
    if (hint === 'topdeck') return this.topdeck(g, pid, opts, req);
    const n = Math.max(req.min, Math.min(req.max, req.max));
    return want(n);
  }
  // Hail Blade, Bellowing Thunder, Make It Rain: discard what the Knock Out needs (counting what earlier prompts of
  // the same attack already discarded), everything when no Knock Out is in reach
  fuelCards(g, pid, opts, req, per) {
    const me = g.pl(pid);
    const target = g.pl(g.opp(pid)).active;
    const key = `${g.turn}:${per}`;
    if (!this.fuel || this.fuel.key !== key) this.fuel = { key, n: 0 };
    let n = opts.length;
    if (target && me.active) {
      const weak = g.weaknessOf(target) === me.active.def.type;
      const bonus = g.attackBonus({ pid, opp: g.opp(pid) }, me.active, target);
      const dmg = k => { let d = per * k + bonus; if (weak) d *= 2; if (target.def.resist === me.active.def.type) d -= 30; if (g.hasEffect('protect', { mon: target })) d -= 30; return g.damageGuard(target, me.active, Math.max(0, d)); };
      let k = 1;
      while (k < 30 && dmg(k) < g.hpLeft(target)) k++;
      n = Math.max(0, k - this.fuel.n);
    }
    n = Math.max(req.min, Math.min(req.max, n, opts.length));
    this.fuel.n += n;
    return opts.slice(0, n).map(c => c.id);
  }
  // Academy at Night and Ciphermaniac's Codebreaking: what Seek Inspiration should copy goes on top
  topdeck(g, pid, opts, req) {
    const me = g.pl(pid);
    const seeker = g.inPlay(pid).find(m => (m.def.attacks || []).some(a => a.name === 'Seek Inspiration'));
    const n = Math.max(req.min, Math.min(req.max, 1));
    let order, copyAt = 0;
    if (seeker) {
      const target = g.pl(g.opp(pid)).active;
      const val = c => (isMon(c) && !ruleBox(c.def) ? this.copyBest(g, pid, seeker, target, c.def.attacks || []).score : -1);
      order = [...opts].sort((x, y) => val(y) - val(x));
      if (req.min >= 2) {
        // Ciphermaniac's: the top card is discarded by Seek Inspiration this turn if Slowking attacks now, else it's
        // next turn's draw and the second one is copied then
        const a = me.active;
        const now = a && a === seeker && (this.canAttackNow(g, a) || (!me.energyDone && me.hand.some(c => c.def.cat === 'E') && this.needs(g, a).missing.length <= 1));
        const rest = this.rankCards(g, pid, order.slice(1), { hint: 'take' });
        if (now) order = [order[0], ...rest];
        else { order = [rest[0], order[0], ...rest.slice(1)].filter(Boolean); copyAt = 1; }
      }
    } else order = req.from === 'hand' ? this.rankCards(g, pid, opts, req).reverse() : this.rankCards(g, pid, opts, req);
    const pick = order.slice(0, Math.max(n, req.min)).map(c => c.id);
    if (pick.length) this.topCard = pick[Math.min(copyAt, pick.length - 1)];
    return pick;
  }
  // how much a card helps right now (higher first)
  cardScore(g, pid, c) {
    const me = g.pl(pid);
    const inPlay = g.inPlay(pid);
    const names = new Set(inPlay.map(m => m.name));
    // other cards in hand (a card being ranked from the hand is not its own duplicate)
    const handNames = new Set(me.hand.filter(x => x !== c).map(x => x.name));
    const d = c.def;
    let s = 0;
    if (d.cat === 'P') {
      s = 40;
      if (d.stage !== 'Basic' && names.has(d.from)) s += 60;              // evolves something we have
      if (d.stage === 'Basic' && inPlay.length < 4) s += 30;
      if (d.ex) s += 20;
      if (d.stage === 'Stage2' && inPlay.some(m => m.def.stage === 'Basic') && handNames.has('Rare Candy')) s += 40;
      // Rare Candy is in hand and the Basic is down: this Stage 2 completes the line now
      if (d.stage === 'Stage2' && handNames.has('Rare Candy') && inPlay.some(m => m.def.stage === 'Basic' && m.name === this.basicOf(g, d)) && !inPlay.some(m => m.name === d.name)) s += 40;
      if (handNames.has(d.name)) s -= 25;
      if (inPlay.filter(m => m.name === d.name).length >= 2) s -= 20;
      // the start of an evolution line we play (Frigibax, Duskull, Chikorita...): early on, more of them
      if (d.stage === 'Basic' && this.lineStart(g, pid, d) && inPlay.filter(m => m.stack[0].def.name === d.name).length < 2 && me.turns <= 6) s += 25;
      // Pokémon whose Ability drives the deck (Comfey, Thwackey...), while we have none in play
      if ((d.abilities || []).some(a => /draw|search your deck|into your hand/i.test(a.text)) && !inPlay.some(m => m.name === d.name)) s += 10;
      // Dhelmise wants Hide 'n' Sneak Pokémon in the discard pile
      if (hasAbil(d, SNEAK) && this.wantsSneakers(g, pid)) s -= 25;
      // Seek Inspiration's copy targets are worth keeping in hand (Academy at Night puts them on top)
      if (this.copyFodder(g, pid, c)) s += 10;
      // Apex Dragon copies the attacks of Dragon Pokémon in the discard pile: those are worth discarding (once each)
      if (d.type === 'Dragon' && !/^Regidrago/.test(d.name) && this.plays(g, pid, 'Apex Dragon') && !me.discard.some(x => x.name === d.name)) s -= 45;
    } else if (d.cat === 'E') {
      s = 30;
      const needed = inPlay.some(m => this.needs(g, m).missing.some(t => t === d.provides || t === 'Colorless' || d.anyType));
      if (needed) s += 25;
      if (me.hand.filter(x => x.def.cat === 'E').length >= 3) s -= 25;
    } else if (d.cat === 'T') {
      s = 35;
      if (d.trainer === 'Supporter') s += me.hand.some(x => x.def.trainer === 'Supporter') ? -5 : 25;
      if (d.name === 'Rare Candy') {
        s += me.hand.some(x => x.def.stage === 'Stage2') ? 30 : -10;
        // a Basic of a Stage 2 line is down and the Stage 2 is still to come: Candy is how it gets there next turn
        if (!handNames.has('Rare Candy') && inPlay.some(m => m.def.stage === 'Basic' && [...me.deck, ...me.hand].some(x => x.def.stage === 'Stage2' && this.basicOf(g, x.def) === m.name) && !inPlay.some(y => y.def.stage === 'Stage2'))) s += 35;
      }
      if (d.name === "Boss's Orders" && g.pl(g.opp(pid)).bench.length) s += 10;
      if (d.name === "Gladion's Final Battle" && me.active && !ruleBox(me.active.def) && g.festivalLead(me.active) && !handNames.has(d.name)) s += 40;
      // Rocket Feathers: each Team Rocket Supporter in hand is 60 damage
      if (trSupporter(c) && this.plays(g, pid, 'Rocket Feathers')) s += 30;
      if (handNames.has(d.name)) s -= 15;
    }
    return s;
  }
  rankCards(g, pid, cards, req) {
    const sc = new Map(cards.map(c => [c, this.cardScore(g, pid, c)]));
    return [...cards].sort((a, b) => sc.get(b) - sc.get(a));
  }
  // the Basic Pokémon a Stage 2 card comes from (Rare Candy)
  basicOf(g, d) {
    const s1 = Object.values(g.db).find(x => x.cat === 'P' && x.name === d.from);
    return s1 ? s1.from : d.from === 'Pidgeotto' ? 'Pidgey' : null;
  }
  // a Basic that evolves into something in our deck or hand
  lineStart(g, pid, d) {
    const me = g.pl(pid);
    return [...me.deck, ...me.hand].some(c => isMon(c) && c.def.from === d.name);
  }
  wantsSneakers(g, pid) { return this.plays(g, pid, 'Vengeful Anchor') && this.sneakers(g, pid) < 13; }
  starter(g, pid, basics) {
    const score = c => {
      const d = c.def;
      let s = 0;
      if (!d.ex) s += 20;
      if (d.retreat <= 1) s += 10;
      if ((d.abilities || []).some(a => /first turn|Active Spot/.test(a.text))) s += 15;
      // an Ability that only works in the Active Spot, every turn (Shivery Chill, Flower Selecting, Run Errand)
      if ((d.abilities || []).some(a => /if this Pokémon is in the Active Spot/.test(a.text))) s += 25;
      if (['Budew', 'Dunsparce', 'Comfey', 'Pidgey', 'Fan Rotom', 'Squawkabilly ex', 'Mega Kangaskhan ex', 'Teal Mask Ogerpon ex', 'Gimmighoul', 'Hoothoot', 'Frigibax', 'Duskull', 'Dwebble', 'Poltchageist', 'Shuppet', 'Grookey', 'Applin'].includes(d.name)) s += 15;
      if (hasAbil(d, 'Festival Lead')) s += 25;
      if (hasAbil(d, 'Flower Selecting')) s += 20;
      // keep the Pokémon that evolve into the deck's stars off the front line
      if (g.pl(pid).hand.some(x => x.def.from === d.name) || ['Dreepy', 'Charmander', 'Ralts', 'Buneary', 'Abra'].includes(d.name)) s -= 10;
      if (this.copyFodder(g, pid, c)) s -= 30;
      return s;
    };
    return [...basics].sort((a, b) => score(b) - score(a))[0];
  }
  // the Basic Pokémon to put on the Bench at the start: all of them, except Seek Inspiration's copy targets
  setupBench(g, pid, opts, max) {
    const keep = opts.filter(c => !this.copyFodder(g, pid, c));
    return keep.slice(0, max).map(c => c.id);
  }

  mons(g, pid, req) {
    const opts = req.options.map(id => g.monById(id)).filter(Boolean);
    const hint = req.hint || '';
    const pickN = list => list.slice(0, Math.max(req.min, Math.min(req.max, list.length))).map(m => m.id);
    if (hint === 'gust') {
      const t = this.gustTarget(g, pid);
      if (t && opts.includes(t)) return [t.id];
      // otherwise drag up something that can't fight back (retreat cost, no Energy)
      return [opts.sort((a, b) => (b.def.retreat - a.def.retreat) * 10 + (a.energy.length - b.energy.length) * 5)[0].id];
    }
    // our own Switch: the Pokémon we played it for
    if (hint === 'switch' && this.switchPlan && this.switchPlan.turn === g.turn && opts.some(m => m.id === this.switchPlan.id) && g.current === pid) return [this.switchPlan.id];
    if (hint === 'promote' || hint === 'switch') {
      const ranked = [...opts].sort((a, b) => this.switchScore(g, pid, b) - this.switchScore(g, pid, a));
      // the opponent switching our Active out (Bounce Back, Push Down) picks what we'd promote
      return [ranked[0].id];
    }
    if (hint.startsWith('opp-damage') || hint.startsWith('opp-counters')) {
      const n = +(hint.split(':')[1] || 30) * (hint.startsWith('opp-counters') ? 10 : 1);
      const counters = hint.startsWith('opp-counters');
      const attacker = g.pl(pid).active;
      // 'pierce': the damage ignores every effect on the target (Twin Shotels)
      const hit = m => (attacker && !g.isActive(m) && !hint.includes('pierce') ? this.benchHit(g, pid, attacker, m, n, counters) : n);
      const kos = opts.filter(m => hit(m) >= g.hpLeft(m) && hit(m) > 0).sort((a, b) => g.prizeValue(b) - g.prizeValue(a));
      if (kos.length) return pickN([...kos, ...opts.filter(m => !kos.includes(m)).sort((a, b) => (hit(b) > 0) - (hit(a) > 0))]);
      return pickN([...opts].sort((a, b) => ((hit(b) > 0) - (hit(a) > 0)) * 1000 + (g.prizeValue(b) - g.prizeValue(a)) * 100 + (b.damage - a.damage)));
    }
    if (hint === 'quadruple') return pickN([...opts].sort((a, b) => ((4 * b.damage >= g.maxHp(b)) - (4 * a.damage >= g.maxHp(a))) * 1000 + (b.damage - a.damage)));
    if (hint.startsWith('attach') || hint === 'attach-embrace') {
      const type = hint.split(':')[1];
      // Sinister Surge's 2 damage counters: never onto a Pokémon they'd Knock Out
      const safe = opts.filter(m => !hint.startsWith('attach-surge') || g.hpLeft(m) > 20);
      const ranked = [...(safe.length ? safe : opts)].sort((a, b) => this.attachScore(g, pid, b, type) - this.attachScore(g, pid, a, type));
      return pickN(ranked);
    }
    if (hint === 'own-damaged' || hint === 'scoop') return [opts.sort((a, b) => b.damage - a.damage)[0].id];
    const es = this.eswitch && this.eswitch.turn === g.turn && g.current === pid ? this.eswitch : null;
    if (hint === 'energy-from' && es && opts.some(m => m.id === es.from)) return [es.from];
    if (hint.startsWith('attach') && es && opts.some(m => m.id === es.to) && g.pl(pid).active && g.pl(pid).active.id === es.to && !g.pl(pid).active.energy.some(c => c.id === es.card)) { this.eswitch = null; return [es.to]; }
    if (hint === 'energy-from') return [opts.sort((a, b) => this.needs(g, a).dmg - this.needs(g, b).dmg)[0].id];
    if (hint === 'opp-energy') return [opts.sort((a, b) => b.energy.length - a.energy.length)[0].id];
    if (hint === 'devolve') { const t = this.timepieceTarget(g, pid); return [(t && opts.includes(t) ? t : opts[0]).id]; }
    if (hint === 'evolve') return pickN(opts);
    return pickN(opts);
  }
  switchScore(g, pid, m) {
    const ba = this.bestAttack(g, pid, m, { needReady: false });
    const ready = (m.def.attacks || []).some(atk => g.canPay(m, g.attackCost(m, atk), g.costMinus(m))) || this.superColdReady(g, pid, m);
    // Pokémon that power the others up every turn (Baxcalibur, Gardevoir ex) stay on the Bench when they can
    const engine = (m.def.abilities || []).some(isEngineAbility) ? 60 : 0;
    return (ready ? 200 : 0) + (ba ? ba.score : 0) + g.hpLeft(m) / 10 - (m.def.ex && !ready ? 50 : 0) - engine;
  }
  // an attacker that can be powered up this turn by an Ability that attaches as often as you like: Baxcalibur's
  // Super Cold ({W} from the hand) or Gardevoir ex's Psychic Embrace ({P} from the discard pile, 2 counters each)
  superColdReady(g, pid, m) {
    if (g.current !== pid) return false;
    const me = g.pl(pid);
    // Yanmega ex's Buzzing Boost: moving up from the Bench attaches 3 {G} Energy from the deck
    if (!g.isActive(m) && g.hasAbility(m, 'Buzzing Boost') && m.used['Buzzing Boost'] !== g.turn) {
      const n = Math.min(3, me.deck.filter(c => isBasicEnergy(c, 'Grass')).length);
      if (n && (m.def.attacks || []).some(atk => { const cost = g.attackCost(m, atk); return g.energyTypes(m).length + n >= cost.length && cost.filter(t => t !== 'Colorless').length <= g.energyTypes(m).filter(t => t === 'Grass').length + n; })) return true;
    }
    let type = null, n = 0;
    if (m.def.type === 'Water' && g.inPlay(pid).some(x => x !== m && g.hasAbility(x, 'Super Cold'))) { type = 'Water'; n = me.hand.filter(c => isBasicEnergy(c) && c.def.provides === 'Water').length; }
    else if (m.def.type === 'Psychic' && g.inPlay(pid).some(x => g.hasAbility(x, 'Psychic Embrace'))) { type = 'Psychic'; n = Math.min(me.discard.filter(c => isBasicEnergy(c) && c.def.provides === 'Psychic').length, Math.floor((g.hpLeft(m) - 1) / 20)); }
    if (!type || !n) return false;
    return (m.def.attacks || []).some(atk => { const cost = g.attackCost(m, atk); return g.energyTypes(m).length + n >= cost.length && cost.every(t => t === type || t === 'Colorless'); });
  }
  attachScore(g, pid, m, type) {
    const need = this.needs(g, m);
    let s = need.dmg / 10;
    if (need.missing.some(t => t === type || t === 'Colorless')) s += 20;
    if (!need.missing.length) s -= 30;
    if (g.pl(pid).active === m) s += 5;
    if (this.copyFodder(g, pid, m.card)) s -= 25;
    // Hail Blade and Bellowing Thunder spend Energy from every Pokémon: keep the spare on the Bench, out of reach
    if (!need.missing.length && type && g.inPlay(pid).some(x => (x.def.attacks || []).some(a => a.name === 'Hail Blade' || a.name === 'Bellowing Thunder')) && g.pl(pid).active !== m) s += 25;
    return s;
  }

  confirm(g, pid, req) {
    const hint = req.hint || '';
    if (hint === 'discard-stadium') return !!(g.stadium && g.stadium.owner !== pid);
    if (hint === 'discard-stadium-bonus') return true;
    if (hint === 'bench-snipe') return g.pl(g.opp(pid)).bench.some(m => g.hpLeft(m) <= 120);
    if (hint === 'more-damage') return true;
    if (/Snow Sink/.test(req.prompt)) return !!(g.stadium && g.stadium.owner !== pid);
    // Corkscrew Dive: draw up to 6 unless the deck is about to run out
    if (hint === 'draw-to-6') { const me = g.pl(pid); return me.deck.length - Math.max(0, 6 - me.hand.length) >= 4; }
    // Teleportation Burst: switch only to something better placed in the Active Spot
    if (hint === 'teleport') { const me = g.pl(pid); return !!me.active && me.bench.some(b => this.switchScore(g, pid, b) > this.switchScore(g, pid, me.active) + 20); }
    return true;
  }
  option(g, pid, req) {
    const opts = req.options;
    const me = g.pl(pid);
    if (/coin flip/.test(req.prompt)) {
      const all = [...me.deck, ...me.hand];
      return all.some(c => c.def.stage === 'Stage2' || c.def.stage === 'Stage1') ? 'second' : 'first';
    }
    if (/extra card/.test(req.prompt)) return opts[opts.length - 1].value;
    if (req.hint === 'max') return opts[0].value;
    if (req.hint === 'candy') {
      // the Stage 2 with the strongest attack; Pokémon that power the team (Baxcalibur, Gardevoir ex, Meganium)
      // evolve on the Bench, attackers in the Active Spot
      let best = opts[0].value, bv = -Infinity;
      for (const o of opts) {
        const d = g.db[o.key] || Object.values(g.db).find(x => x.name === (/→ (.*)$/.exec(o.label) || [])[1]);
        const m = g.monById(o.mon);
        if (!d) continue;
        let v = Math.max(0, ...(d.attacks || []).map(a => parseInt(a.damage, 10) || 0)) + (d.ex ? 100 : 0) + ((d.abilities || []).length ? 60 : 0);
        const engine = (d.abilities || []).some(a => /As often as you like|Each Basic|this Pokémon is Knocked Out/.test(a.text));
        if (m) v += (g.isActive(m) ? 1 : -1) * (engine ? -15 : 15);
        if (v > bv) { bv = v; best = o.value; }
      }
      return best;
    }
    if (req.hint === 'remove') { const o = opts.find(x => /opponent/.test(x.label)) || opts.find(x => x.value === 's' && g.stadium && g.stadium.owner !== pid); return (o || opts[0]).value; }
    if (req.hint === 'copy-attack') {
      // Seek Inspiration and Night Joker: the attack worth the most now
      const a = me.active, target = g.pl(g.opp(pid)).active;
      let best = opts[0].value, bv = -1;
      for (const o of opts) {
        const d = g.db[o.key], atk = d && (d.attacks || []).find(x => x.name === o.atk);
        if (!atk || !a) continue;
        const v = this.estimate(g, pid, a, atk, target, 1);
        const score = v + (target && v >= g.hpLeft(target) ? 300 * g.prizeValue(target) : 0) + this.benchValue(g, pid, a, atk);
        if (score > bv) { bv = score; best = o.value; }
      }
      return best;
    }
    if (req.hint === 'brock') {
      // an Evolution card for something in play, unless the Bench is still thin
      const evoNeeded = g.inPlay(pid).some(m => me.deck.some(c => isMon(c) && c.def.from === m.name) && !me.hand.some(c => c.def.from === m.name));
      const want = evoNeeded && me.bench.length >= 2 ? 'evo' : 'basic';
      return (opts.find(o => o.value === want) || opts[0]).value;
    }
    if (req.hint === 'devolve-n') return opts[opts.length - 1].value;
    // Kieran: the switch only for a stuck Active with a better attacker on the Bench
    if (req.hint === 'kieran') { const sw = opts.find(o => o.value === 'switch'); return sw && me.active && !this.canAttackNow(g, me.active) && this.betterAttacker(g, pid) ? 'switch' : 'boost'; }
    if (req.hint === 'torment') {
      // Torment: lock the attack the opponent's Active would most want to use next turn
      const opp = g.opp(pid), d = g.pl(opp).active, target = me.active;
      let best = opts[0].value, bv = -Infinity;
      for (const o of opts) {
        const atk = d && (d.def.attacks || []).find(x => x.name === o.atk);
        if (!atk) continue;
        const missing = g.attackCost(d, atk).length - g.energyTypes(d).length;
        const v = this.estimate(g, opp, d, atk, target, 1) + (missing <= 1 ? 100 : 0) - 20 * Math.max(0, missing);
        if (v > bv) { bv = v; best = o.value; }
      }
      return best;
    }
    if (/attacks to use/.test(req.prompt)) {
      let best = opts[0].value, bv = -1;
      for (const o of opts) { const d = parseInt((/\((\d+)/.exec(o.label) || [])[1], 10) || 0; if (d > bv) { bv = d; best = o.value; } }
      return best;
    }
    return opts[0].value;
  }
  // spread damage counters: finish off whatever can be Knocked Out (most Prizes first), the rest on the biggest threat
  distribute(g, pid, req) {
    const mons = req.options.map(id => g.monById(id)).filter(Boolean);
    let left = req.total;
    const out = {};
    const live = mons.filter(m => !g.effectsBlocked({ pid }, m));
    const ko = [...live].sort((a, b) => g.prizeValue(b) * 1000 - g.hpLeft(b) - (g.prizeValue(a) * 1000 - g.hpLeft(a)));
    for (const m of ko) {
      const need = Math.ceil(g.hpLeft(m) / 10);
      if (need <= left) { out[m.id] = need; left -= need; }
    }
    if (left > 0) {
      const t = [...(live.length ? live : mons)].filter(m => !out[m.id]).sort((a, b) => (g.prizeValue(b) - g.prizeValue(a)) * 100 + (b.damage - a.damage))[0] || live[0] || mons[0];
      out[t.id] = (out[t.id] || 0) + left;
    }
    return out;
  }
}

function fallback(req) {
  switch (req.type) {
    case 'main': return { t: 'end' };
    case 'cards': return req.options.slice(0, req.min);
    case 'mon': return req.options.slice(0, Math.max(1, req.min));
    case 'confirm': return false;
    case 'option': return req.options[0] && req.options[0].value;
    case 'distribute': return { [req.options[0]]: req.total };
    default: return null;
  }
}
