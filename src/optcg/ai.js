// A computer opponent for the One Piece Card Game: it develops the board (Characters by value per cost, Events when
// they have something to hit), spends Leader and Character abilities, powers up its attackers with DON!! so they
// beat the defender with room for Counters, attacks the Leader and the rested Characters it can K.O., and defends
// with [Blocker] and Counters when the hit matters (low Life, a valuable Character). Every other choice is answered
// from what it's for (the request's hint).
// It only reads the game: every answer is computed from the state it is shown, so it can run on one peer of an
// online game.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isChar = c => c.def.cat === 'C';

export class OnePieceAI {
  constructor({ pace = null } = {}) { this.pace = pace; this.turnKey = ''; this.counts = {}; }
  async pause(kind) { const ms = this.pace ? this.pace(kind) : 0; if (ms > 0) await sleep(ms); }

  async ask(g, pid, req) {
    try {
      const v = this.answer(g, pid, req);
      if (req.type === 'main') { if (v && v.t === 'attack') await this.pause('attack'); else if (v && v.t !== 'end') await this.pause(v.t === 'don' ? 'land' : 'think'); }
      else await this.pause('choose');
      return v;
    } catch (e) {
      if (g.throwErrors) throw e;
      console.error('One Piece AI error', e);
      return fallback(req);
    }
  }
  answer(g, pid, req) {
    switch (req.type) {
      case 'main': return this.main(g, pid, req.actions);
      case 'cards': return this.cards(g, pid, req);
      case 'confirm': return this.confirm(g, pid, req);
      case 'option': return this.option(g, pid, req);
      case 'number': return this.number(g, pid, req);
      case 'order': return this.order(g, pid, req);
      case 'blocker': return this.blocker(g, pid, req);
      case 'counter': return this.counter(g, pid, req);
      case 'trigger': return this.trigger(g, pid, req);
      case 'mulligan': return this.mulligan(g, pid);
      default: return fallback(req);
    }
  }

  // ------------------------------------------------------------ how good things are
  // a card's worth (in hand or on the field), about 1 point per 1000 power
  value(g, c) {
    const d = c.def;
    if (d.cat === 'L') return 100;
    let v = 0;
    if (d.cat === 'C') {
      v = (g.onField(c) ? g.power(c) : d.power || 0) / 1000 + (d.cost || 0) * 0.6;
      const abs = g.abilities(c);
      v += abs.length * 0.8;
      if (abs.some(a => a.kind === 'keyword' && a.kw === 'Blocker')) v += 0.7;
      if (abs.some(a => a.kind === 'keyword' && (a.kw === 'Rush' || a.kw === 'Double Attack'))) v += 1;
    } else if (d.cat === 'E') v = 2 + (d.cost || 0) * 0.5;
    else v = 2.5;
    return v;
  }
  // a card in hand as a defensive resource
  counterWorth(c) { return c.def.cat === 'C' ? (c.def.counter || 0) / 1000 : 0; }
  oppHandCounters(g, pid) { return g.players[g.opp(pid)].hand.length; }

  // ------------------------------------------------------------ the main phase
  main(g, pid, actions) {
    const key = `${g.turn}`;
    if (key !== this.turnKey) { this.turnKey = key; this.counts = {}; this.plan = null; }
    const once = (k, max = 1) => { this.counts[k] = (this.counts[k] || 0) + 1; return this.counts[k] <= max; };
    const me = g.players[pid], o = g.players[g.opp(pid)];
    const by = t => actions.filter(a => a.t === t);
    const card = uid => g.cardByUid(uid);

    // 1. play cards: the best value for the DON!! (Characters first, Events with targets, a Stage)
    const plays = by('play').map(a => ({ a, c: card(a.card) })).filter(x => x.c);
    const scored = plays.map(x => ({ ...x, v: this.playValue(g, pid, x.c) })).filter(x => x.v > 0).sort((x, y) => y.v - x.v);
    for (const x of scored) if (once('play:' + x.c.uid)) return x.a;

    // 2. abilities that help
    for (const a of by('activate')) {
      const c = card(a.card);
      const ab = g.abilities(c).find(b => b.idx === a.ability);
      if (ab && this.abilityGood(g, pid, c, ab) && once('act:' + c.uid + ':' + ab.idx, 3)) return a;
    }

    // 3. attacks, each with the DON!! it needs first
    const atk = this.bestAttack(g, pid, actions);
    if (atk) {
      const need = atk.need;
      if (need > 0 && me.donActive > 0) {
        const give = actions.find(a => a.t === 'don' && a.target === atk.a.card);
        if (give && once('give:' + atk.a.card + ':' + g.turn, 12)) return give;
      }
      return atk.a;
    }
    // 4. leftover DON!!: to the cards whose [DON!! xN] effects it switches on, else the Leader (power on our turn)
    if (me.donActive > 0) {
      const gives = by('don');
      const dn = gives.map(a => ({ a, c: card(a.target) })).find(x => x.c && g.abilities(x.c).some(ab => ab.don && x.c.don < ab.don && (ab.kind !== 'auto' || !ab.timings.includes('whenAttacking'))));
      if (dn && once('dongive:' + dn.c.uid, 3)) return dn.a;
    }
    return { t: 'end' };
  }
  // what playing this card is worth now (0 = don't)
  playValue(g, pid, c) {
    const me = g.players[pid];
    const cost = g.cost(c);
    if (c.def.cat === 'C') {
      if (me.characters.length >= 5) {
        const worst = Math.min(...me.characters.map(x => this.value(g, x)));
        return this.value(g, c) > worst + 2 ? this.value(g, c) - worst : 0;
      }
      // keep a card with a big Counter when the hand is small and it's cheap to hold
      if ((c.def.counter || 0) >= 2000 && me.hand.length <= 3 && cost <= 2 && g.abilities(c).length === 0) return 0.5;
      return this.value(g, c) + 1;
    }
    if (c.def.cat === 'S') return me.stage ? 0 : 2;
    if (c.def.cat === 'E') {
      const ab = g.eventAbility(c, 'main');
      if (!ab) return 0;
      if (!this.donReturnOk(g, pid, returnedBy(ab))) return 0;
      // [Counter] events are kept for defence; [Main] events when they have a target
      const useful = this.stepsUseful(g, pid, ab.steps, c);
      return useful ? 3 + cost * 0.3 : 0;
    }
    return 0;
  }
  // do these effect steps have something worthwhile to do now?
  stepsUseful(g, pid, steps, src) {
    const ctx = { pid, src, vars: {}, ab: null };
    for (const s of steps) {
      switch (s.op) {
        case 'ko': case 'rest': case 'bounce': case 'bottom': case 'cost': case 'fieldToLife':
          if (s.sel && !s.sel.ref && g.candidates(s.sel, ctx).some(x => x.owner !== pid)) return true; break;
        case 'power': if (s.n < 0 && s.sel && !s.sel.ref && g.candidates(s.sel, ctx).some(x => x.owner !== pid && x.cat === 'C')) return true; break;
        case 'draw': case 'look': case 'addDon': case 'deckToLife': case 'toHand': case 'trashLife': case 'play': return true;
        case 'choose': return true;
        case 'restDon': if (g.players[g.opp(pid)].donActive > 0) return true; break;
        case 'giveDon': case 'donActive': if (g.players[pid].donRested > 0) return true; break;
        default: break;
      }
    }
    return false;
  }
  abilityGood(g, pid, c, ab) {
    if (!this.donReturnOk(g, pid, returnedBy(ab))) return false;
    // a cost that trashes cards or Life is worth it only for strong effects
    for (const k of ab.cost || []) {
      if ((k.op === 'trashHand' && g.players[pid].hand.length <= 2) || k.op === 'trashSelf' && this.value(g, c) > 6) return false;
      if (k.op === 'restDon' && g.players[pid].donActive - k.n < 0) return false;
    }
    if (!this.lifeCostOk(g, pid, c, ab)) return false;
    // resting a Character to activate: not one that could still attack this turn
    if ((ab.cost || []).some(k => k.op === 'restSelf') && c.cat === 'C' && g.attackTargets(c).length && g.power(c) >= g.power(g.players[g.opp(pid)].leader)) return false;
    // "Reveal 1 card from the top of your Life cards. If that card is ...": only when we can see it's a hit (face-up)
    const rv = ab.steps.findIndex(s => s.op === 'reveal' && s.from === 'life');
    if (rv >= 0) {
      const top = g.players[pid].life[0], next = ab.steps.slice(rv + 1).find(s => s.cond && s.cond.k === 'that');
      return !!top && (top.faceUp || top.known) && (!next || g.matches(top, { f: next.cond.f, cats: next.cond.cats }, { pid, src: c, vars: {} }));
    }
    if (ab.steps.some(s => s.op === 'setActive' && s.sel && s.sel.ref === 'self')) return c.rested;
    if (ab.steps.some(s => s.op === 'giveDon')) return g.players[pid].donRested > 0;
    if (this.stepsUseful(g, pid, ab.steps, c)) return true;
    // a power boost for this turn: worth it for cards that can still attack (more of them for a DON!! −3 or more)
    const boost = ab.steps.find(s => s.op === 'power' && typeof s.n === 'number' && s.n > 0);
    if (boost) {
      const ctx = { pid, src: c, ab, vars: {} };
      const who = boost.sel.ref === 'self' ? [c] : boost.sel.ref === 'leader' ? [g.players[pid].leader] : g.candidates(boost.sel, ctx);
      const attackers = who.filter(x => x.owner === pid && g.attackTargets(x).length && g.players[pid].turns > 1).length;
      const returned = (ab.cost || []).filter(k => k.op === 'returnDon').reduce((s, k) => s + k.n, 0);
      return attackers >= (boost.sel.all && returned >= 3 ? 2 : 1);
    }
    return false;
  }
  // the attack to make next, and how many more DON!! the attacker wants for it
  bestAttack(g, pid, actions) {
    const o = g.players[g.opp(pid)], me = g.players[pid];
    const atks = actions.filter(a => a.t === 'attack');
    if (!atks.length) return null;
    let best = null;
    const oppHand = o.hand.length;
    for (const a of atks) {
      const at = g.cardByUid(a.card), tg = g.cardByUid(a.target);
      const ap = g.power(at), tp = g.power(tg);
      // power to spare against Counters: more when their hand is big, and on a Leader at low Life
      const buffer = tg.cat === 'L' ? (oppHand >= 4 ? 2000 : oppHand >= 2 ? 1000 : 0) : (oppHand >= 3 ? 1000 : 0);
      const want = tp + buffer;
      const short = Math.max(0, Math.ceil((want - ap) / 1000));
      const reach = Math.max(0, Math.ceil((tp - ap) / 1000));
      if (reach > me.donActive) continue;             // can't even get there
      // keep [Blocker] Characters home, unless the hit wins
      const blocker = at.cat === 'C' && g.has(at, 'Blocker');
      let v;
      if (tg.cat === 'L') {
        v = 5 + (o.life.length <= 1 ? 20 : 0) + (at.cat === 'L' ? 2 : 0);
        if (blocker && o.life.length > 1) v -= 6;
      } else {
        v = 3 + this.value(g, tg);
        if (blocker) v -= 3;
      }
      const need = Math.min(short, me.donActive);
      v -= need * 0.3;
      // characters that would be left rested and exposed: a little worse
      if (at.cat === 'C' && tg.cat === 'L') v -= 0.5;
      if (v <= 0) continue;
      if (!best || v > best.v) best = { a, v, need: ap + need * 1000 < want || need > 0 ? need : 0 };
    }
    return best;
  }

  // ------------------------------------------------------------ choices
  cards(g, pid, req) {
    const opts = req.options.map(id => g.cardByUid(id)).filter(Boolean);
    const hint = req.hint || '';
    const n = req.max;
    const pickN = (list, k) => list.slice(0, Math.max(req.min, Math.min(k, list.length))).map(c => c.uid);
    const mine = c => c.owner === pid;
    const byVal = (list, dir = -1) => [...list].sort((a, b) => dir * (this.value(g, a) - this.value(g, b)));
    if (req.from === 'field') {
      if (['ko', 'rest', 'debuff', 'cost-down', 'bounce', 'bottom', 'to-life', 'select-opp', 'freeze', 'trash-char', 'cantBlock', 'cantAttack', 'cantAttackChar'].includes(hint) || /opp/.test(hint)) {
        const theirs = byVal(opts.filter(c => !mine(c)));
        // for "rest", only active ones matter; for debuffs, the Characters that fight
        const list = hint === 'rest' ? [...theirs.filter(c => !c.rested), ...theirs.filter(c => c.rested)] : theirs;
        if (list.length) return pickN(list, n);
        // our own Character to our Life (Queen Mama Chanter): the cheapest one
        if (hint === 'to-life') return pickN(byVal(opts.filter(mine), 1), Math.max(req.min, 1));
        return req.min ? pickN(byVal(opts, 1), req.min) : [];
      }
      if (['trash-for-room', 'rest-cost', 'bounce-cost', 'don-unattach'].includes(hint)) return pickN(byVal(opts.filter(mine), 1), req.min || 1);
      // "return any number of your Characters": keep the board
      if (hint === 'bounce-own') return [];
      if (hint === 'set-active') return pickN(byVal(opts.filter(c => mine(c) && c.rested)), n);
      // during a battle, a boost goes to our card in it (the defender for a [Counter], the attacker otherwise)
      if (g.fight && (hint === 'buff' || hint === 'grant')) {
        const ours = g.fight.pid === pid ? g.fight.attacker : g.fight.target;
        if (opts.includes(ours)) return [ours.uid];
      }
      // our own cards that get something: the ones about to attack
      const own = opts.filter(mine).sort((a, b) => (g.attackTargets(b).length - g.attackTargets(a).length) * 10 + (g.power(b) - g.power(a)) / 1000);
      if (own.length) return pickN(own, n);
      return req.min ? pickN(opts, req.min) : [];
    }
    // face-down cards from the opponent's hand: no information to go on
    if (req.from === 'opp-hand') return pickN(opts, req.min || 1);
    // "trash any number of {Music} cards: +1000 power this battle for each": just enough to survive the attack
    if (hint === 'discard-any') {
      const b = g.battle;
      if (!b) return [];
      const need = g.power(g.cardByUid(b.attacker)) - g.power(g.cardByUid(b.target)) + 1;
      return need > 0 && need <= opts.length * 1000 ? byVal(opts, 1).slice(0, Math.ceil(need / 1000)).map(c => c.uid) : [];
    }
    if (hint === 'discard' || hint === 'topdeck' || hint === 'to-life' || hint === 'recycle') return pickN(byVal(opts, 1), req.min || 1);
    if (hint === 'keep-top') return opts.filter(c => isChar(c) && this.value(g, c) > 5).slice(0, req.max).map(c => c.uid);
    if (hint === 'play') {
      const me = g.players[pid];
      const list = byVal(opts);
      return me.characters.length >= 5 ? pickN(list, Math.min(n, 1)) : pickN(list, n);
    }
    if (hint === 'reveal') return pickN(opts, req.min || 1);
    return pickN(byVal(opts), n);
  }
  confirm(g, pid, req) {
    const hint = req.hint || '';
    if (hint === 'pay-cost') return this.costOk(g, pid, req);
    if (hint === 'replace') return true;
    return true;
  }
  // Life order: the cards our "reveal the top Life card: if it is [X], play it" effects want go on top
  order(g, pid, req) {
    if (req.hint !== 'order-life') return req.options;
    const me = g.players[pid];
    const wants = [];
    for (const c of [...g.field(pid), ...me.hand]) for (const ab of g.abilities(c)) {
      const rv = (ab.steps || []).findIndex(s => s.op === 'reveal' && s.from === 'life');
      const next = rv >= 0 && ab.steps.slice(rv + 1).find(s => s.cond && s.cond.k === 'that');
      if (next) wants.push({ f: next.cond.f, cats: next.cond.cats, src: c });
    }
    const hit = uid => { const x = g.cardByUid(uid); return wants.some(w => g.matches(x, { f: w.f, cats: w.cats }, { pid, src: w.src, vars: {} })); };
    return [...req.options.filter(hit), ...req.options.filter(u => !hit(u))];
  }
  costOk(g, pid, req) {
    const me = g.players[pid], prompt = req.prompt;
    if (/trash \d+ cards? from your hand/i.test(prompt) && me.hand.length <= 2) return false;
    const card = req.card != null && g.cardByUid(req.card);
    const ab = card && g.abilities(card).find(a => a.idx === req.ability);
    if (!ab) return !(/Life cards to your hand/i.test(prompt) && me.life.length <= 2);
    if (!this.worthPaying(g, pid, card, ab) || !this.lifeCostOk(g, pid, card, ab)) return false;
    const decisive = g.fight && ab.steps.some(s => s.op === 'power' && typeof s.n === 'number' && s.n > 0 && this.boostDecides(g, pid, card, s));
    return this.donReturnOk(g, pid, returnedBy(ab), decisive);
  }
  // Life is the clock: taking a Life card into the hand (a card, at least) needs 3 or more Life, or 2 for a strong
  // effect; trashing one needs 4, or 3 for a strong effect
  lifeCostOk(g, pid, c, ab) {
    const life = g.players[pid].life.length;
    const strong = (ab.steps || []).some(s => ['ko', 'bounce', 'bottom', 'play', 'fieldToLife', 'trashLife'].includes(s.op));
    for (const k of ab.cost || []) {
      if (k.op === 'lifeToHand' && life < (strong ? 2 : 3)) return false;
      if (k.op === 'trashLife' && life < (strong ? 3 : 4)) return false;
    }
    return true;
  }
  // DON!! −X sets the player back X DON!! cards until the DON!! deck would have run out anyway: fine with plenty on
  // the field or near the 10 cap, else only for a small decisive effect
  donReturnOk(g, pid, x, decisive = false) {
    if (!x) return true;
    const F = g.donOnField(pid);
    return F - x >= 6 || F >= 8 || (decisive && x <= 1);
  }
  // does +n power on one of our battling cards turn the battle around?
  boostDecides(g, pid, src, s) {
    const f = g.fight;
    const ours = f.pid === pid ? f.attacker : f.target;
    const to = s.sel.ref === 'self' ? src : s.sel.ref === 'leader' ? g.players[pid].leader : ours;
    if (to !== ours) return false;
    const ap = g.power(f.attacker), tp = g.power(f.target);
    // attacking: from losing (or barely winning against Counters) to winning; defending: from losing to holding
    return f.pid === pid ? ap < tp + 1000 && ap + s.n >= tp : ap >= tp && tp + s.n > ap;
  }
  // would the effect do anything? (a K.O. with nothing to K.O. only wastes the DON!!)
  worthPaying(g, pid, card, ab) {
    const ctx = { pid, src: card, ab, vars: {}, data: {} };
    const holds = c => { try { return g.test(c, ctx); } catch { return true; } };
    for (const s of ab.steps || []) {
      if (s.cond && !holds(s.cond)) return false;
      // a power boost during a battle: only if it changes who wins
      if (s.op === 'power' && typeof s.n === 'number' && s.n > 0 && g.fight) { if (this.boostDecides(g, pid, card, s)) return true; continue; }
      if (s.op === 'lookOppDeck') continue;
      if (s.sel && !s.sel.ref) { try { if (!g.candidates(s.sel, ctx).length) continue; } catch { /* count it */ } }
      if (s.op === 'play' && s.from !== 'deck' && !g.candidates({ zone: s.from, who: 'you', cats: s.cats || ['C'], f: s.f }, ctx).length) continue;
      if (s.op === 'discard' && s.who === 'opp' && !g.players[g.opp(pid)].hand.length) continue;
      return true;
    }
    return false;
  }
  option(g, pid, req) {
    const opts = req.options;
    switch (req.hint) {
      case 'first': return 'first';
      case 'don-return': return (opts.find(o => o.value === 'rested') || opts.find(o => o.value === 'active') || opts[0]).value;
      case 'life-end': return opts[0].value;
      case 'life-whose': return opts[0].value;
      // pay with a spare DON!! card, else rest the Leader
      case 'rest-leader-or-don': return (g.players[pid].donActive >= 2 && opts.find(o => o.value === 'don')) ? 'don' : opts[0].value;
      // rest an opponent's Character (the best one) rather than a DON!! card
      case 'rest-don-or-char': { const chars = opts.filter(o => typeof o.value === 'number').map(o => g.cardByUid(o.value)).sort((a, b) => this.value(g, b) - this.value(g, a)); return chars.length ? chars[0].uid : (opts.find(o => o.value === 'don') || opts[0]).value; }
      default: return opts[0].value;
    }
  }
  number(g, pid, req) {
    if (req.hint === 'don-return-n') return req.min;
    // "Choose a cost and reveal the top card of your opponent's deck": the commonest cost among the opponent's cards
    // the player has seen (their trash and field), else 4
    if (req.hint === 'choose-cost') {
      const o = g.players[g.opp(pid)], tally = {};
      for (const c of [...o.trash, ...o.characters]) { const k = c.def.cost || 0; tally[k] = (tally[k] || 0) + 1; }
      const best = Object.entries(tally).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
      return Math.max(req.min, Math.min(req.max, best ? +best[0] : 4));
    }
    return req.max;
  }
  blocker(g, pid, req) {
    const at = g.cardByUid(req.attacker), tg = g.cardByUid(req.target);
    const me = g.players[pid];
    const ap = g.power(at);
    const blockers = req.options.map(id => g.cardByUid(id)).filter(Boolean);
    const hits = ap >= g.power(tg);
    if (!hits) return null;
    const lethalish = tg.cat === 'L' && me.life.length <= (g.has(at, 'Double Attack') ? 2 : 1);
    const cheap = blockers.sort((a, b) => this.value(g, a) - this.value(g, b));
    // a blocker that survives, or one worth less than what it saves
    const survivor = cheap.find(b => g.power(b) > ap);
    if (survivor) return survivor.uid;
    if (lethalish) return cheap[0].uid;
    if (tg.cat === 'L' && me.life.length <= 2 && this.value(g, cheap[0]) < 5) return cheap[0].uid;
    if (tg.cat === 'C' && this.value(g, tg) > this.value(g, cheap[0]) + 3) return cheap[0].uid;
    return null;
  }
  counter(g, pid, req) {
    const at = g.cardByUid(req.attacker), tg = g.cardByUid(req.target);
    const me = g.players[pid];
    const ap = g.power(at), tp = g.power(tg);
    if (ap < tp) return null;
    const need = ap - tp + 1000;
    const opts = req.options.map(o => ({ o, c: g.cardByUid(o.card) })).filter(x => x.c);
    // is this hit worth stopping?
    let worth;
    if (tg.cat === 'L') {
      const dmg = g.has(at, 'Double Attack') ? 2 : 1;
      worth = me.life.length <= dmg ? 100 : me.life.length <= 2 ? 6 : me.life.length <= 3 ? 3 : 1.5;
      if (g.has(at, 'Banish')) worth += 1;
    } else worth = this.value(g, tg) * 0.8;
    // the cheapest way to get there: character counters (by counter value per card worth) and counter events
    const total = opts.reduce((s, x) => s + (x.o.kind === 'counter' ? x.o.value : this.eventBoost(g, x.c)), 0);
    if (total < need) return null;
    const cost = x => (x.o.kind === 'counter' ? this.value(g, x.c) * 0.5 : 1 + (x.o.cost || 0) * 0.6 + returnedBy(g.eventAbility(x.c, 'counter') || {}) * (this.donReturnOk(g, pid, 2) ? 0.4 : 1.2));
    const gain = x => (x.o.kind === 'counter' ? x.o.value : this.eventBoost(g, x.c));
    const sorted = opts.filter(x => gain(x) > 0).sort((a, b) => cost(a) / gain(a) - cost(b) / gain(b));
    // pick cards until the need is covered
    let left = need, spend = 0;
    const plan = [];
    for (const x of sorted) { if (left <= 0) break; plan.push(x); left -= gain(x); spend += cost(x); }
    if (left > 0 || spend > worth) return null;
    const x = plan[0];
    return x.o.kind === 'counter' ? { card: x.o.card, kind: 'counter', value: x.o.value } : { card: x.o.card, kind: 'event', cost: x.o.cost };
  }
  // the power a [Counter] Event gives in battle
  eventBoost(g, c) {
    const ab = g.eventAbility(c, 'counter');
    if (!ab) return 0;
    let n = 0;
    for (const s of ab.steps) if (s.op === 'power' && s.n > 0 && s.dur === 'battle') n += s.n;
    return n;
  }
  trigger(g, pid, req) {
    const c = g.cardByUid(req.card);
    const ab = g.triggerAbility(c);
    if (!ab) return false;
    if ((ab.cost || []).some(k => k.op === 'trashHand') && g.players[pid].hand.length <= 1) return false;
    return true;
  }
  mulligan(g, pid) {
    const hand = g.players[pid].hand;
    const cheap = hand.filter(c => isChar(c) && (c.def.cost || 0) <= 3).length;
    return cheap === 0;
  }
}

// how many DON!! cards an ability's cost returns to the DON!! deck (DON!! −X)
function returnedBy(ab) { return (ab.cost || []).filter(k => k.op === 'returnDon').reduce((s, k) => s + k.n, 0); }

function fallback(req) {
  switch (req.type) {
    case 'main': return { t: 'end' };
    case 'cards': return req.options.slice(0, req.min);
    case 'confirm': case 'trigger': case 'mulligan': return false;
    case 'option': return req.options[0] && req.options[0].value;
    case 'number': return req.min;
    case 'order': return req.options;
    case 'blocker': case 'counter': return null;
    default: return null;
  }
}
