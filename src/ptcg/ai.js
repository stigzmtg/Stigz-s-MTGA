// A computer opponent for the Pokémon TCG: it plays its turn the way a person would — dig for cards, fill the
// Bench, evolve, power up the Pokémon that will attack (the one that can take a Knock Out, ideally), use draw
// Abilities and Supporters, switch or gust when that wins a trade, then attack. Every choice an effect asks for
// is answered from what that choice is for (the request's hint).
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isBasicEnergy = c => c.def.cat === 'E' && c.def.energy === 'Basic';
const isMon = c => c.def.cat === 'P';
const ruleBox = d => !!(d.ex || d.radiant || d.v);
const DRAW_SUPPORTERS = new Set(["Professor's Research", "Lillie's Determination", 'Iono', 'Carmine', 'Judge', 'Roxanne', "Colress's Experiment", "Explorer's Guidance"]);
const SETUP_SUPPORTERS = new Set(['Arven', 'Dawn', "Team Rocket's Petrel", 'Cyrano', 'Crispin', "Professor Sada's Vitality", "Rosa's Encouragement", "Ciphermaniac's Codebreaking", "Lana's Aid"]);

export class PokemonAI {
  constructor({ pace = null } = {}) { this.pace = pace; this.turnKey = ''; this.counts = {}; }
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
  // what a Pokémon's best attack is worth against the opponent's Active right now
  estimate(g, pid, mon, atk, target) {
    if (!target) return 0;
    const me = g.pl(pid), opp = g.opp(pid);
    const printed = parseInt(atk.damage, 10) || 0;
    const energiesInPlay = type => g.inPlay(pid).reduce((s, m) => s + m.energy.filter(c => isBasicEnergy(c) && (!type || c.def.provides === type)).length, 0);
    let d = printed;
    switch (atk.name) {
      case 'Hail Blade': d = 60 * Math.min(energiesInPlay('Water'), 6); break;
      case 'Bellowing Thunder': d = 70 * Math.min(energiesInPlay(), 6); break;
      case 'Make It Rain': d = 50 * me.hand.filter(isBasicEnergy).length; break;
      case 'Burning Darkness': d = printed + 30 * g.prizesTaken(opp); break;
      case 'Voltage Burst': d = printed + 50 * g.prizesTaken(opp); break;
      case 'Irritated Outburst': d = 60 * g.prizesTaken(opp); break;
      case 'Rapid-Fire Combo': d = printed + 50; break;
      case 'Ear Force': d = printed + 80 * target.energy.length; break;
      case 'Myriad Leaf Shower': d = printed + 30 * (mon.energy.length + target.energy.length); break;
      case 'Full Moon Rondo': d = printed + 20 * (me.bench.length + g.pl(opp).bench.length); break;
      case 'Gale Thrust': d = printed + (mon.movedActiveTurn === g.turn ? 170 : 0); break;
      case 'Calamity Storm': d = printed + (g.stadium ? 120 : 0); break;
      case 'Vengeance Fletching': d = printed + 10 * me.discard.filter(c => c.def.ancient).length; break;
      case 'Jewel Breaker': d = printed + (target.def.tera ? 230 : 0); break;
      case 'Balloon Blast': d = 30 * g.counters(mon); break;
      case 'Roaring Scream': d = 20 * g.counters(mon); break;
      case 'Triple Stab': d = 15; break;
      case 'Cosmic Beam': d = me.bench.some(m => m.name === 'Lunatone') ? printed : 0; break;
      case 'Assault Landing': d = g.stadium ? printed : 0; break;
      case 'Frenzied Gouging': return g.hpLeft(target) + 1000;
      case 'Terminal Period': return g.counters(target) === 6 ? g.hpLeft(target) + 1000 : 0;
      case 'Lost Mine': return 120;
      case 'Cruel Arrow': d = 100; break;
      case 'Genome Hacking': d = Math.max(0, ...(target.def.attacks || []).map(a => parseInt(a.damage, 10) || 0)); break;
    }
    if (d > 0 && !['Cosmic Beam', 'Demolish', 'Spit Innocently'].includes(atk.name)) {
      if (g.weaknessOf(target) === mon.def.type) d *= 2;
      if (target.def.resist === mon.def.type) d -= 30;
    }
    if (d > 0 && mon.tool && mon.tool.name === 'Vitality Band') d += 10;
    // protections on the target
    const ignore = ['Spiky Hopper', 'Demolish'].includes(atk.name);
    if (!ignore && g.hasAbility(target, 'Cornerstone Stance') && g.abilitiesOf(mon).length) return 0;
    if (!ignore && g.hasEffect('dig', { mon: target })) return 0;
    if (!ignore && g.hasEffect('protect', { mon: target })) d -= 30;
    if (g.hasAbility(target, 'Flare Veil') && ['Terminal Period', 'Frenzied Gouging'].includes(atk.name)) return 0;
    return Math.max(0, d);
  }
  bestAttack(g, pid, mon, { needReady = true } = {}) {
    const target = g.pl(g.opp(pid)).active;
    let best = null;
    for (const atk of g.attacksOf(mon)) {
      if (needReady && g.attackBlock(mon, atk)) continue;
      if (!needReady && !atk.cost) continue;
      let v = this.estimate(g, pid, mon, atk, target);
      // setup attacks are worth something early on
      if (['Call for Family', 'Call Sign', 'Find a Friend', 'Minor Errand-Running', 'Kaleidowaltz', 'Collect', 'Burst Roar', 'Magnetic Charge', 'Evolution', 'Come and Get You'].includes(atk.name)) v = Math.max(v, g.pl(pid).bench.length < 3 ? 60 : 15);
      if (['Itchy Pollen', 'Oceanic Gloom'].includes(atk.name)) v += 25;
      const ko = target && v >= g.hpLeft(target);
      const score = v + (ko ? 200 * g.prizeValue(target) : 0);
      if (!best || score > best.score) best = { atk, v, ko, score };
    }
    return best;
  }
  // how many more Energy (and of what types) a Pokémon needs for its strongest attack
  needs(g, mon) {
    let best = null;
    for (const atk of mon.def.attacks || []) {
      // what the attack can reach: "60×" attacks scale with what you pay into them, "200+" ones grow
      const n = parseInt(atk.damage, 10) || 0;
      const dmg = /×/.test(atk.damage) ? n * 3 : /\+/.test(atk.damage) ? n + 60 : n || 30;
      if (!best || dmg > best.dmg) best = { atk, dmg };
    }
    if (!best) return { missing: [], dmg: 0 };
    const cost = g.attackCost(mon, best.atk);
    const pool = g.energyTypes(mon);
    const missing = [];
    for (const t of cost.filter(t => t !== 'Colorless')) { const i = pool.indexOf(t); if (i >= 0) pool.splice(i, 1); else missing.push(t); }
    const colorless = cost.filter(t => t === 'Colorless').length;
    for (let i = 0; i < colorless; i++) { if (pool.length) pool.pop(); else missing.push('Colorless'); }
    return { missing, dmg: best.dmg, atk: best.atk };
  }
  attackerValue(g, mon) { const n = this.needs(g, mon); return n.dmg + (mon.def.ex ? 40 : 0) + (mon.def.stage === 'Stage2' ? 30 : 0); }

  // ------------------------------------------------------------ the main phase
  main(g, pid, actions) {
    const key = `${g.turn}`;
    if (key !== this.turnKey) { this.turnKey = key; this.counts = {}; }
    const me = g.pl(pid), opp = g.opp(pid);
    const by = t => actions.filter(a => a.t === t);
    const card = id => me.hand.find(c => c.id === id);
    const once = (k, max = 1) => { this.counts[k] = (this.counts[k] || 0) + 1; return this.counts[k] <= max; };
    const used = k => (this.counts[k] || 0);
    const active = me.active;
    const oppActive = g.pl(opp).active;

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
        default: return true;
      }
    };
    const DRAWS = ['Recon Directive', 'Flower Selecting', 'Run Errand', 'Coin Bonus', 'Flip the Script', 'Lunar Cycle', 'Quick Search', 'Teal Dance'];
    let a = pickAbility(['Fan Call', 'Squawk and Seize', 'Transformative Start']);
    if (a && finds(a.name) && (a.name !== 'Squawk and Seize' || me.hand.length <= 5)) return a;
    a = abil.find(x => ['Tandem Unit', 'Metallic Signal', 'Shivery Chill', ...DRAWS].includes(x.name) && finds(x.name) && !(deckLow && DRAWS.includes(x.name) && x.name !== 'Teal Dance' && me.hand.length > 1) && once('ab:' + x.mon + x.name));
    if (a) return a;
    if (me.hand.length <= 2 && !deckLow) { a = pickAbility(['Restart', 'Run Away Draw', 'Concealed Cards']); if (a) return a; }

    // 2. search and setup Items
    const trainers = by('trainer').map(x => ({ ...x, c: card(x.card) }));
    const item = names => trainers.find(x => x.c && x.c.def.trainer === 'Item' && names.includes(x.c.name) && once('it:' + x.c.name, 4));
    const benchRoom = me.bench.length < g.benchLimit(pid);
    let t = item(['Rare Candy']);
    if (t) return t;
    if (benchRoom && me.bench.length < 4) { t = item(['Buddy-Buddy Poffin', 'Nest Ball', 'Precious Trolley']); if (t) return t; }
    t = item(['Poké Pad', 'Fighting Gong', 'Energy Search', 'Pokégear 3.0', 'Electric Generator', 'Mirage Gate', 'Glass Trumpet']);
    if (t) return t;
    if (me.hand.length >= 4) { t = item(['Ultra Ball', 'Earthen Vessel']); if (t && this.hasJunk(g, pid, t.c, t.c.name === 'Ultra Ball' ? 2 : 1)) return t; }
    if (me.hand.length >= 5) { t = item(['Secret Box', 'Superior Energy Retrieval']); if (t && this.hasJunk(g, pid, t.c, t.c.name === 'Secret Box' ? 3 : 2)) return t; }
    if (oppActive) { t = item(['Crushing Hammer']); if (t && oppActive.energy.length) return t; }
    t = item(['Jumbo Ice Cream']);
    if (t && active && active.damage >= 80) return t;
    if (me.discard.some(isMon) && me.deck.length < 25) { t = item(['Super Rod']); if (t) return t; }
    if (me.hand.filter(isMon).length === 0 && me.discard.some(c => isMon(c) && ruleBox(c.def))) { t = item(['Night Stretcher']); if (t) return t; }

    // 3. Bench Basic Pokémon (keep a slot when Phantom Dive-style spread is coming? no: development first)
    for (const b of by('bench')) { const c = card(b.card); if (c && once('bench:' + c.id) && me.bench.length < Math.min(g.benchLimit(pid), 5)) return b; }

    // 4. evolve (Stage 2 first)
    const evo = by('evolve').map(x => ({ ...x, c: card(x.card) })).sort((x, y) => (y.c.def.stage === 'Stage2') - (x.c.def.stage === 'Stage2'));
    if (evo.length) return evo[0];

    // 5. Supporter
    const sup = trainers.filter(x => x.c && x.c.def.trainer === 'Supporter');
    if (sup.length && once('sup', 3)) {
      const s = this.pickSupporter(g, pid, sup);
      if (s) return s;
    }
    // 6. Stadium: replace the opponent's, or play ours on an empty table
    const st = trainers.find(x => x.c && x.c.def.trainer === 'Stadium' && (!g.stadium || g.stadium.owner !== pid) && this.stadiumGood(g, pid, x.c));
    if (st && once('stadium')) return st;
    // stadium actions
    const sa = by('stadium')[0];
    if (sa && once('stadium-use') && this.stadiumUseGood(g, pid, sa.name)) return sa;

    // 7. Tools
    for (const x of by('tool')) {
      const c = card(x.card), m = g.monById(x.target);
      if (c && m && this.toolFits(g, pid, c, m) && once('tool:' + c.id)) return x;
    }

    // 8. energy attachment
    const en = by('energy');
    if (en.length) {
      const choice = this.chooseEnergy(g, pid, en);
      if (choice) return choice;
    }
    // more acceleration abilities once there is something to power
    a = pickAbility(['Psychic Embrace', 'Super Cold', 'Overvolt Discharge']);
    if (a && this.accelUseful(g, pid, a)) return a;

    // 9. damage tricks: Munkidori, Cursed Blast, Hyper Blower
    a = abil.find(x => x.name === 'Adrena-Brain' && this.adrenaUseful(g, pid) && once('ab:' + x.mon + x.name));
    if (a) return a;
    a = abil.find(x => x.name === 'Cursed Blast' && this.blastUseful(g, pid, g.monById(x.mon)) && once('ab:' + x.mon + x.name));
    if (a) return a;

    // 10. gust a Benched Pokémon we can Knock Out for more Prizes
    const gusts = trainers.filter(x => x.c && ['Prime Catcher', 'Counter Catcher'].includes(x.c.name));
    if (gusts.length && active && this.gustTarget(g, pid)) return gusts[0];

    // 11. retreat or switch to a better attacker
    const switchTo = this.betterAttacker(g, pid);
    if (switchTo) {
      const sw = trainers.find(x => x.c && ['Switch', 'Switch Cart'].includes(x.c.name) && once('sw'));
      if (sw) return sw;
      const r = by('retreat').find(x => x.to === switchTo.id);
      if (r && once('retreat')) return r;
    }

    // 12. attack
    const atks = by('attack');
    if (atks.length && active) {
      let best = null;
      for (const x of atks) {
        const atk = g.attacksOf(active).find(y => y.name === x.name && y.src === x.src);
        let v = this.estimate(g, pid, active, atk, oppActive);
        if (['Call for Family', 'Call Sign', 'Find a Friend', 'Minor Errand-Running', 'Kaleidowaltz', 'Collect', 'Burst Roar', 'Magnetic Charge', 'Evolution', 'Come and Get You', 'Motivate'].includes(atk.name)) v = Math.max(v, me.bench.length < 3 || me.hand.length < 3 ? 70 : 10);
        if (atk.name === 'Tuck Tail' && active.damage > 0) v += 60;
        const ko = oppActive && v >= g.hpLeft(oppActive);
        const score = v + (ko ? 300 * g.prizeValue(oppActive) : 0);
        if (!best || score > best.score) best = { x, score };
      }
      if (best) return best.x;
    }
    return { t: 'end' };
  }

  stadiumUseGood(g, pid, name) {
    const me = g.pl(pid);
    if (name === 'Artazon') return me.bench.length < 4;
    if (name === 'Mystery Garden') return me.hand.length <= 3;
    if (name === 'Surfing Beach') { const b = this.betterAttacker(g, pid); return !!(b && b.def.type === 'Water'); }
    return false;
  }
  hasJunk(g, pid, except, n) { return g.pl(pid).hand.filter(c => c !== except).length >= n; }
  stadiumGood(g, pid, c) {
    const n = c.name;
    if (n === 'Area Zero Underdepths') return g.inPlay(pid).some(m => m.def.tera);
    if (n === 'Surfing Beach') return g.inPlay(pid).filter(m => m.def.type === 'Water').length >= 2;
    return true;
  }
  toolFits(g, pid, c, m) {
    const n = c.name, me = g.pl(pid);
    if (n === 'Bravery Charm') return m.def.stage === 'Basic' && this.needs(g, m).dmg >= 60;
    if (n === 'Air Balloon') return me.active === m && g.retreatCost(m) >= 2;
    if (n === 'Rescue Board') return me.active === m;
    if (n === 'Luxurious Cape') return !ruleBox(m.def);
    if (n === 'Sparkling Crystal') return m.def.tera;
    if (n === 'Ancient Booster Energy Capsule') return m.def.ancient;
    if (n === 'Technical Machine: Evolution') return me.active === m && me.bench.some(b => me.deck.some(x => isMon(x) && x.def.from === b.name)) && !(this.bestAttack(g, pid, m) || {}).ko;
    if (n === 'Defiance Band' || n === 'Vitality Band') return this.needs(g, m).dmg >= 100;
    return true;
  }
  pickSupporter(g, pid, sup) {
    const me = g.pl(pid), opp = g.opp(pid);
    const named = n => sup.find(x => x.c.name === n);
    // Boss's Orders when a Benched target can be Knocked Out for more Prizes than the Active
    const boss = named("Boss's Orders") || named("Lisia's Appeal");
    if (boss && this.gustTarget(g, pid)) return boss;
    if (named('Briar')) return named('Briar');
    const xero = named("Xerosic's Machinations");
    if (xero && g.pl(opp).hand.length >= 6) return xero;
    const deckLow = me.deck.length <= 8;
    const iono = named('Iono');
    if (iono && !deckLow && (g.pl(opp).hand.length >= 5 && g.prizesLeft(opp) <= g.prizesLeft(pid) || me.hand.length <= 3)) return iono;
    if (me.turns <= 3) for (const x of sup) if (SETUP_SUPPORTERS.has(x.c.name)) return x;
    const rox = named('Roxanne');
    if (rox && !deckLow && me.hand.length <= 5) return rox;
    if (!deckLow) for (const x of sup) if (DRAW_SUPPORTERS.has(x.c.name) && x.c.name !== 'Roxanne' && x.c.name !== 'Iono' && (me.hand.length <= 6 || x.c.name === "Lillie's Determination")) return x;
    for (const x of sup) if (SETUP_SUPPORTERS.has(x.c.name)) return x;
    if (deckLow && me.hand.length <= 1) return sup.find(x => DRAW_SUPPORTERS.has(x.c.name)) || null;
    return null;
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
    if (!best) return null;
    const act = opp.active;
    const actKO = act && this.bestAttack(g, pid, me.active) && this.bestAttack(g, pid, me.active).ko;
    if (actKO && g.prizeValue(act) >= g.prizeValue(best.t)) return null;
    return best.t;
  }
  oneShort(g, mon, atk) { return this.needs(g, mon).missing.length <= 1; }
  betterAttacker(g, pid) {
    const me = g.pl(pid);
    const cur = me.active ? this.bestAttack(g, pid, me.active) : null;
    let best = null;
    for (const b of me.bench) {
      const ba = this.bestAttack(g, pid, b, { needReady: false });
      const ready = (b.def.attacks || []).some(atk => g.canPay(b, g.attackCost(b, atk), g.costMinus(b)));
      if (!ready || !ba) continue;
      const v = ba.score;
      if (!best || v > best.v) best = { b, v };
    }
    if (!best) return null;
    if (!cur) return best.b;
    if (!cur.ko && best.v > cur.score + 150) return best.b;
    return null;
  }
  chooseEnergy(g, pid, en) {
    const me = g.pl(pid);
    const handE = [...new Set(en.map(x => x.card))].map(id => me.hand.find(c => c.id === id));
    // best target: the Active if this attachment lets it attack (or attack better), else the most valuable attacker missing Energy
    const mons = g.inPlay(pid);
    let best = null;
    for (const c of handE) {
      for (const m of mons) {
        const need = this.needs(g, m);
        if (!need.missing.length) continue;
        const fits = need.missing.includes(c.def.provides) || need.missing.includes('Colorless');
        if (!fits) continue;
        let v = need.dmg / 10 + (m.def.ex ? 6 : 0) + (m.def.stage !== 'Basic' ? 4 : 0);
        if (m === me.active) v += need.missing.length === 1 ? 25 : 8;
        if (need.missing.length === 1) v += 6;
        if (m.def.retreat === 0 && need.dmg < 60) v -= 10;
        if (!best || v > best.v) best = { c, m, v };
      }
    }
    if (!best) {
      // nothing needs Energy: hold Jet Energy; put a basic on the Active for retreat money if it has none
      const c = handE.find(x => x.name !== 'Jet Energy');
      if (c && me.active && !me.active.energy.length && g.retreatCost(me.active) > 0 && me.bench.length) best = { c, m: me.active };
    }
    if (!best) return null;
    return en.find(x => x.card === best.c.id && x.target === best.m.id) || null;
  }
  accelUseful(g, pid, a) {
    if (a.name === 'Overvolt Discharge') return g.inPlay(pid).some(m => m.def.type === 'Lightning' && m.name !== 'Magneton' && this.needs(g, m).missing.length);
    if (a.name === 'Psychic Embrace') return g.inPlay(pid).some(m => m.def.type === 'Psychic' && this.needs(g, m).missing.length && g.hpLeft(m) > 60);
    if (a.name === 'Super Cold') return g.inPlay(pid).some(m => m.energy.filter(c => c.def.provides === 'Water').length < 4 && (this.needs(g, m).dmg >= 100 || m.name === 'Chien-Pao ex'));
    return true;
  }
  adrenaUseful(g, pid) {
    const opp = g.pl(g.opp(pid));
    if (!g.inPlay(pid).some(m => m.damage >= 10)) return false;
    // set up Terminal Period (exactly 6 counters) or finish something off
    if (opp.active && g.inPlay(pid).some(m => (m.def.attacks || []).some(x => x.name === 'Terminal Period'))) { const c = g.counters(opp.active); if (c >= 3 && c < 6) return true; }
    return g.inPlay(g.opp(pid)).some(m => g.hpLeft(m) <= 30) || true;
  }
  blastUseful(g, pid, mon) {
    const n = mon.name === 'Dusknoir' ? 130 : 50;
    return g.inPlay(g.opp(pid)).some(m => g.hpLeft(m) <= n && g.prizeValue(m) >= g.prizeValue(mon));
  }

  // ------------------------------------------------------------ choices
  cards(g, pid, req) {
    const me = g.pl(pid);
    const opts = req.options.map(id => g.cardById(id)).filter(Boolean);
    const want = n => this.rankCards(g, pid, opts, req).slice(0, n).map(c => c.id);
    const hint = req.hint || 'take';
    if (hint === 'setup-active') return [this.starter(g, pid, opts).id];
    if (hint === 'setup-bench') return opts.slice(0, req.max).map(c => c.id);
    if (hint === 'discard' || hint === 'retreat-cost') return this.rankCards(g, pid, opts, req).reverse().slice(0, req.min || 1).map(c => c.id);
    if (hint.startsWith('fuel:')) {
      const per = +hint.slice(5);
      const target = g.pl(g.opp(pid)).active;
      let need = target ? Math.ceil(g.hpLeft(target) / (g.weaknessOf(target) === (me.active && me.active.def.type) ? per * 2 : per)) : opts.length;
      need = Math.max(req.min, Math.min(req.max, need, opts.length));
      return opts.slice(0, need).map(c => c.id);
    }
    if (hint === 'opp-discard') return [this.rankCards(g, g.opp(pid), opts, { hint: 'take' })[0].id];
    if (hint === 'move-to-active') return opts.map(c => c.id).slice(0, req.max);
    const n = Math.max(req.min, Math.min(req.max, hint === 'recover' ? req.max : req.max));
    return want(n);
  }
  // how much a card helps right now (higher first)
  rankCards(g, pid, cards, req) {
    const me = g.pl(pid);
    const inPlay = g.inPlay(pid);
    const names = new Set(inPlay.map(m => m.name));
    const handNames = new Set(me.hand.map(c => c.name));
    const score = c => {
      const d = c.def;
      let s = 0;
      if (d.cat === 'P') {
        s = 40;
        if (d.stage !== 'Basic' && names.has(d.from)) s += 60;              // evolves something we have
        if (d.stage === 'Basic' && inPlay.length < 4) s += 30;
        if (d.ex) s += 20;
        if (d.stage === 'Stage2' && inPlay.some(m => m.def.stage === 'Basic') && handNames.has('Rare Candy')) s += 40;
        if (handNames.has(d.name)) s -= 25;
        if (inPlay.filter(m => m.name === d.name).length >= 2) s -= 20;
      } else if (d.cat === 'E') {
        s = 30;
        const needed = inPlay.some(m => this.needs(g, m).missing.some(t => t === d.provides || t === 'Colorless'));
        if (needed) s += 25;
        if (me.hand.filter(c => c.def.cat === 'E').length >= 3) s -= 25;
      } else if (d.cat === 'T') {
        s = 35;
        if (d.trainer === 'Supporter') s += me.hand.some(c => c.def.trainer === 'Supporter') ? -5 : 25;
        if (d.name === 'Rare Candy') s += me.hand.some(c => c.def.stage === 'Stage2') ? 30 : -10;
        if (d.name === "Boss's Orders" && g.pl(g.opp(pid)).bench.length) s += 10;
        if (handNames.has(d.name)) s -= 15;
      }
      return s;
    };
    return [...cards].sort((a, b) => score(b) - score(a));
  }
  starter(g, pid, basics) {
    const score = c => {
      const d = c.def;
      let s = 0;
      if (!d.ex) s += 20;
      if (d.retreat <= 1) s += 10;
      if ((d.abilities || []).some(a => /first turn|Active Spot/.test(a.text))) s += 15;
      if (['Budew', 'Dunsparce', 'Comfey', 'Pidgey', 'Fan Rotom', 'Squawkabilly ex', 'Mega Kangaskhan ex', 'Teal Mask Ogerpon ex', 'Gimmighoul', 'Hoothoot', 'Frigibax', 'Duskull'].includes(d.name)) s += 15;
      // keep the Pokémon that evolve into the deck's stars off the front line
      if (g.pl(pid).hand.some(x => x.def.from === d.name) || ['Dreepy', 'Charmander', 'Ralts'].includes(d.name)) s -= 10;
      return s;
    };
    return [...basics].sort((a, b) => score(b) - score(a))[0];
  }

  mons(g, pid, req) {
    const opts = req.options.map(id => g.monById(id)).filter(Boolean);
    const hint = req.hint || '';
    const opp = g.opp(pid);
    const pickN = list => list.slice(0, Math.max(req.min, Math.min(req.max, list.length))).map(m => m.id);
    if (hint === 'gust') {
      const t = this.gustTarget(g, pid);
      if (t && opts.includes(t)) return [t.id];
      // otherwise drag up something that can't fight back (retreat cost, no Energy)
      return [opts.sort((a, b) => (b.def.retreat - a.def.retreat) * 10 + (a.energy.length - b.energy.length) * 5)[0].id];
    }
    if (hint === 'promote' || hint === 'switch') {
      const ranked = [...opts].sort((a, b) => this.switchScore(g, pid, b) - this.switchScore(g, pid, a));
      return [ranked[0].id];
    }
    if (hint.startsWith('opp-damage') || hint.startsWith('opp-counters')) {
      const n = +(hint.split(':')[1] || 30) * (hint.startsWith('opp-counters') ? 10 : 1);
      const kos = opts.filter(m => g.hpLeft(m) <= n).sort((a, b) => g.prizeValue(b) - g.prizeValue(a));
      if (kos.length) return pickN([...kos, ...opts.filter(m => !kos.includes(m))]);
      return pickN([...opts].sort((a, b) => (g.prizeValue(b) - g.prizeValue(a)) * 100 + (b.damage - a.damage)));
    }
    if (hint.startsWith('attach') || hint === 'attach-embrace') {
      const type = hint.split(':')[1];
      const ranked = [...opts].sort((a, b) => this.attachScore(g, pid, b, type) - this.attachScore(g, pid, a, type));
      return pickN(ranked);
    }
    if (hint === 'own-damaged' || hint === 'scoop') return [opts.sort((a, b) => b.damage - a.damage)[0].id];
    if (hint === 'energy-from') return [opts.sort((a, b) => this.needs(g, a).dmg - this.needs(g, b).dmg)[0].id];
    if (hint === 'opp-energy') return [opts.sort((a, b) => b.energy.length - a.energy.length)[0].id];
    if (hint === 'evolve') return pickN(opts);
    return pickN(opts);
  }
  switchScore(g, pid, m) {
    const ba = this.bestAttack(g, pid, m, { needReady: false });
    const ready = (m.def.attacks || []).some(atk => g.canPay(m, g.attackCost(m, atk), g.costMinus(m)));
    return (ready ? 200 : 0) + (ba ? ba.score : 0) + g.hpLeft(m) / 10 - (m.def.ex && !ready ? 50 : 0);
  }
  attachScore(g, pid, m, type) {
    const need = this.needs(g, m);
    let s = need.dmg / 10;
    if (need.missing.some(t => t === type || t === 'Colorless')) s += 20;
    if (!need.missing.length) s -= 30;
    if (g.pl(pid).active === m) s += 5;
    return s;
  }

  confirm(g, pid, req) {
    const hint = req.hint || '';
    if (hint === 'discard-stadium') return !!(g.stadium && g.stadium.owner !== pid);
    if (hint === 'discard-stadium-bonus') return true;
    if (hint === 'bench-snipe') return g.pl(g.opp(pid)).bench.some(m => g.hpLeft(m) <= 120);
    if (/Snow Sink/.test(req.prompt)) return !!(g.stadium && g.stadium.owner !== pid);
    return true;
  }
  option(g, pid, req) {
    const opts = req.options;
    if (/coin flip/.test(req.prompt)) {
      const deck = g.pl(pid);
      const all = [...deck.deck, ...deck.hand];
      return all.some(c => c.def.stage === 'Stage2' || c.def.stage === 'Stage1') ? 'second' : 'first';
    }
    if (/extra card/.test(req.prompt)) return opts[opts.length - 1].value;
    if (req.hint === 'max') return opts[0].value;
    if (req.hint === 'candy') {
      // the Stage 2 with the strongest attack
      let best = 0, bv = -1;
      opts.forEach((o, i) => { const m = /→ (.*)$/.exec(o.label); const d = m && Object.values(g.db).find(x => x.name === m[1]); const v = d ? Math.max(0, ...(d.attacks || []).map(a => parseInt(a.damage, 10) || 0)) + (d.ex ? 100 : 0) : 0; if (v > bv) { bv = v; best = o.value; } });
      return best;
    }
    if (req.hint === 'remove') { const o = opts.find(x => /opponent/.test(x.label)) || opts.find(x => x.value === 's' && g.stadium && g.stadium.owner !== pid); return (o || opts[0]).value; }
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
    const ko = [...mons].sort((a, b) => g.prizeValue(b) * 1000 - g.hpLeft(b) - (g.prizeValue(a) * 1000 - g.hpLeft(a)));
    for (const m of ko) {
      const need = Math.ceil(g.hpLeft(m) / 10);
      if (need <= left) { out[m.id] = need; left -= need; }
    }
    if (left > 0) {
      const t = [...mons].filter(m => !out[m.id]).sort((a, b) => (g.prizeValue(b) - g.prizeValue(a)) * 100 + (b.damage - a.damage))[0] || mons[0];
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
