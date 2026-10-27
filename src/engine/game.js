// Core game state and flow: zones, turns, priority, the stack, state-based actions and triggers.
import { Card, Player, newTimestamp } from './cards.js';
import { RNG, COLORS, BASIC_LAND_TYPES, NAME_TO_COLOR, sleep, compare } from './util.js';
import { computeAll, charsOutside, isRoom } from './chars.js';
import { matchValid, resolveDefined, calcCtx, checkPresence, ctrlOf, zoneMap, findTargets } from './filters.js';
import { synthesizeKeywords, keywordInfo } from './keywords.js';
import { SA, castSpell, activateAbility, resolveStackItem, chooseTargetsForSA, getActions, playLand, manaSourcesFor, activateManaAbility, resolveChain, castAlternative } from './abilities.js';
import { triggerMatches } from './triggers.js';
import * as combat from './combat.js';
import { parseAbility } from './forge.js';
import { untapPrevented as paramUntapPrevented, noteTurnEnd, noteTargeted, applyStaticEffect, heldPersistentMana, damageRedirect, dealRedirected, loseManaColor } from './mech-params.js';

export const STEPS = ['untap', 'upkeep', 'draw', 'main1', 'beginCombat', 'declareAttackers', 'declareBlockers', 'firstStrikeDamage', 'combatDamage', 'endCombat', 'main2', 'end', 'cleanup'];
export const STEP_NAMES = { untap: 'Untap', upkeep: 'Upkeep', draw: 'Draw', main1: 'Main 1', beginCombat: 'Beginning of Combat', declareAttackers: 'Declare Attackers', declareBlockers: 'Declare Blockers', firstStrikeDamage: 'First-Strike Damage', combatDamage: 'Combat Damage', endCombat: 'End of Combat', main2: 'Main 2', end: 'End Step', cleanup: 'Cleanup' };
const FORGE_PHASE = { untap: 'Untap', upkeep: 'Upkeep', draw: 'Draw', main1: 'Main1', beginCombat: 'BeginCombat', declareAttackers: 'Declare Attackers', declareBlockers: 'Declare Blockers', firstStrikeDamage: 'First Strike Damage', combatDamage: 'Combat Damage', endCombat: 'EndCombat', main2: 'Main2', end: 'End of Turn', cleanup: 'Cleanup' };

export class GameOver extends Error { constructor() { super('game over'); } }

export class Game {
  constructor({ db, players, seed = (Date.now() ^ (Math.random() * 1e9)) >>> 0, onUpdate = null, aiDelay = 0, maxTurns = 200 }) {
    this.db = db;
    this.rng = new RNG(seed);
    this.seed = seed;
    this.nextId = 1;
    this.version = 0;
    this._charsVersion = -1;
    this._charMap = new Map();
    this._lazyChars = new Map();
    this._computing = false;
    this.cards = new Map();
    this.players = [];
    this.agents = [];
    this.battlefield = [];
    this.stack = [];
    this.effects = [];
    this.delayed = [];
    this.pendingTriggers = [];
    this.lookback = [];
    this.logs = [];
    this.turnNumber = 0;
    this.activePlayer = 0;
    this.step = 'untap';
    this.priority = null;
    this.combat = null;
    this.monarch = null;
    this.initiative = null;
    this.extraTurns = []; // pids, last one taken first
    this.winner = null;
    this.over = false;
    this.onUpdate = onUpdate;
    this.aiDelay = aiDelay;
    this.maxTurns = maxTurns;
    this.nonCreatureSubtypes = new Set(['Aura', 'Equipment', 'Vehicle', 'Saga', 'Treasure', 'Clue', 'Food', 'Blood', 'Map', 'Gold', 'Powerstone', 'Shard', 'Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Desert', 'Gate', 'Lair', 'Locus', 'Mine', 'Power-Plant', 'Tower', 'Urza\'s', 'Cave', 'Sphere', 'Shrine', 'Cartouche', 'Curse', 'Rune', 'Shard', 'Background', 'Class', 'Role', 'Room', 'Case', 'Fortification', 'Contraption', 'Attraction', 'Junk', 'Incubator', 'Lesson', 'Adventure', 'Arcane', 'Trap', 'Omen', 'Chorus', 'Ajani', 'Jace', 'Liliana', 'Chandra', 'Garruk', 'Nissa', 'Gideon', 'Sorin', 'Elspeth', 'Vehicle', 'Spacecraft', 'Planet']);
    this.turnState = this.freshTurnState();
    this.stopRequested = false;
    this.uid = 1;
    this.askCount = 0;
    this.activeRepl = new Set();
    for (const [i, cfg] of players.entries()) this.addPlayer(i, cfg);
  }

  // ---------------------------------------------------------------- setup
  addPlayer(i, cfg) {
    const p = new Player(i, cfg.name || `Player ${i + 1}`);
    p.deckName = cfg.deck.name;
    p.deckId = cfg.deck.id || null;
    p.isHuman = !!cfg.human;
    this.players.push(p);
    this.agents.push(cfg.agent);
    const ci = new Set();
    for (const name of cfg.deck.commanders) {
      const def = this.db.get(name);
      if (!def) continue;
      const c = this.newCard(def, i);
      c.isCommander = true;
      c.zone = 'command';
      p.command.push(c);
      p.commanders.push(c.id);
      p.commanderCasts[c.id] = 0;
      for (const col of def.colorIdentity()) ci.add(col);
    }
    p.colorIdentity = COLORS.filter(c => ci.has(c));
    for (const [name, count] of cfg.deck.cards) {
      const def = this.db.get(name);
      if (!def) continue;
      for (let k = 0; k < count; k++) {
        const c = this.newCard(def, i);
        c.zone = 'library';
        p.library.push(c);
      }
    }
  }

  newCard(def, owner) {
    const c = new Card(this, def, owner);
    this.cards.set(c.id, c);
    return c;
  }

  freshTurnState() {
    return { spellsCast: [], moves: [], damagedPlayers: {}, combatDamagedPlayers: {}, combatDamageSources: {}, damagedCards: {}, dealtDamage: {}, creaturesDied: 0, permanentLeft: {}, attackedWith: [], turnsTaken: this.turnState ? this.turnState.turnsTaken : {}, landsEntered: {}, abilityResolved: {}, triggerCounts: {}, tokenBatches: {}, loopCounts: {}, resolutions: 0, blocks: [], damageLog: [], attackedBattles: [] };
  }

  // ---------------------------------------------------------------- queries
  touch() { this.version++; }
  cardById(id) { return this.cards.get(id) || null; }
  allCards() { return [...this.cards.values()].filter(c => c.zone !== 'gone'); }
  livingPlayers() { return this.players.filter(p => !p.lost); }
  isOpponent(a, b) { return a != null && b != null && a !== b; }
  opponents(pid) { return this.livingPlayers().filter(p => p.id !== pid); }
  nextPlayer(pid) {
    const n = this.players.length, dir = this.turnDir || 1;
    for (let k = 1; k <= n; k++) { const q = this.players[(pid + dir * k + n * 2) % n]; if (!q.lost) return q.id; }
    return pid;
  }
  prevPlayer(pid) {
    const n = this.players.length;
    for (let k = 1; k <= n; k++) { const q = this.players[(pid - k + n * 2) % n]; if (!q.lost) return q.id; }
    return pid;
  }
  apnap() {
    const out = [];
    let p = this.activePlayer;
    for (let k = 0; k < this.players.length; k++) {
      const q = this.players[(p + (this.turnDir || 1) * k + this.players.length * 2) % this.players.length];
      if (!q.lost) out.push(q.id);
    }
    return out;
  }
  zone(pid, z) {
    const p = this.players[pid];
    switch (z) {
      case 'battlefield': return this.battlefield.filter(c => c.controller === pid);
      case 'stack': return this.stack.filter(s => s.card && s.controller === pid).map(s => s.card);
      default: return p[z] || [];
    }
  }
  cardsInZone(z) {
    if (z === 'battlefield') return this.battlefield;
    if (z === 'stack') return this.stack.filter(s => s.card && s.kind === 'spell').map(s => s.card);
    if (z === 'all') return [...this.battlefield, ...this.players.flatMap(p => [...p.hand, ...p.graveyard, ...p.exile, ...p.command, ...p.library])];
    if (z === 'any') return this.cardsInZone('all');
    return this.players.flatMap(p => p[z] || []);
  }
  chars(card) {
    if (card.lki) return card.chars;
    if (card.stackItem) return card.card ? this.chars(card.card) : (card.source ? this.chars(card.source) : null);
    if (card.isPlayer) return null;
    if (card.isEffect) return card.effectChars;
    this.ensureChars();
    const ch = this._charMap.get(card.id);
    if (ch && (card.zone === 'battlefield' || card.zone === 'stack')) return ch;
    const out = charsOutside(this, card);
    synthesizeKeywords(this, card, out);
    return out;
  }
  playerChars(pid) {
    this.ensureChars();
    const pc = (this._playerChars || [])[pid] || { maxHandSize: 7, extraLands: 0, keywords: [] };
    const extra = (this.players[pid].temp || []).flatMap(t => t.keywords || []);
    return extra.length ? { ...pc, keywords: [...pc.keywords, ...extra] } : pc;
  }
  ensureChars() {
    if (this._computing || this._charsVersion === this.version) return;
    this._computing = true;
    this._lazyChars = new Map();
    try {
      const map = computeAll(this);
      for (const [id, ch] of map) synthesizeKeywords(this, this.cards.get(id), ch);
      this._charMap = map;
    } finally { this._computing = false; }
    this._charsVersion = this.version;
  }
  hasKeyword(card, kw) { return this.hasKeywordIn(this.chars(card), kw); }
  hasKeywordIn(ch, kw) {
    if (!ch || !ch.keywords) return false;
    const k = kw.toLowerCase();
    for (const x of ch.keywords) {
      const l = x.toLowerCase();
      if (l === k || l.startsWith(k + ':') || l.startsWith(k + ' ')) return true;
    }
    return false;
  }
  keywordArgs(card, kw) {
    const ch = this.chars(card);
    return ch.keywords.filter(x => x === kw || x.startsWith(kw + ':')).map(x => x.split(':').slice(1));
  }
  activeStatics(mode) {
    this.ensureChars();
    const key = mode + ':' + this.version;
    if (!this._staticCache || this._staticCache.version !== this.version) this._staticCache = { version: this.version, map: new Map() };
    let list = this._staticCache.map.get(mode);
    if (list) return list;
    list = [];
    const consider = (host, statics, zone) => {
      for (const st of statics) {
        if (st.parsed.p.Mode == null) continue;
        if (!st.parsed.p.Mode.split(',').includes(mode)) continue;
        const ez = st.parsed.p.EffectZone || (host.isEffect ? 'Command' : 'Battlefield');
        if (ez !== 'All' && !ez.split(',').some(z => (zoneMap[z] || z.toLowerCase()) === zone)) continue;
        const you = host.isEffect ? host.controller : (zone === 'battlefield' ? host.controller : host.owner);
        const ctx = { host, you, svars: st.svars, sa: { svars: st.svars, host, controller: you, root() { return { x: host.xPaid || 0, paid: {} }; } } };
        if (!checkPresence(this, st.parsed.p, ctx)) continue;
        list.push({ st, host, ctx, p: st.parsed.p });
      }
    };
    for (const c of this.battlefield) if (!c.phasedOut) consider(c, this.chars(c).statics, 'battlefield');
    for (const e of this.effects) consider(e, e.effectChars.statics, 'command');
    for (const p of this.players) for (const z of ['hand', 'graveyard', 'exile', 'command']) for (const c of p[z]) {
      const f = c.faceDef;
      if (f.statics.length && f.statics.some(s => /EffectZone\$/.test(s))) consider(c, this.chars(c).statics, z);
    }
    for (const s of this.stack) if (s.card && s.kind === 'spell') { const f = s.card.faceDef; if (f.statics.some(x => /EffectZone\$ (All|Stack)/.test(x))) consider(s.card, this.chars(s.card).statics, 'stack'); }
    this._staticCache.map.set(mode, list);
    return list;
  }
  attachmentsOf(card) { return this.battlefield.filter(c => c.attachedTo === card.id); }
  // players who goaded it: by an effect ("goad target creature") or for as long as a static says so
  goaders(card) {
    const st = card.zone === 'battlefield' ? (this.chars(card).goadedBy || []) : [];
    return st.length ? [...new Set([...(card.goadedBy || []), ...st])] : (card.goadedBy || []);
  }
  isAttacking(card) { return !!(this.combat && this.combat.attackers.some(a => a.card === card.id)); }
  isBlocking(card) { return !!(this.combat && this.combat.blockers.has(card.id)); }
  isBlocked(card) { const a = this.combat && this.combat.attackers.find(x => x.card === card.id); return !!(a && a.blocked); }
  attackTargetOf(card) { const a = this.combat && this.combat.attackers.find(x => x.card === card.id); return a ? a.defenderPlayer : null; }
  isMainPhase() { return this.step === 'main1' || this.step === 'main2'; }
  canSorcery(pid) { return this.activePlayer === pid && this.isMainPhase() && this.stack.length === 0; }
  commanderTax(card) { const p = this.players[card.owner]; return 2 * (p.commanderCasts[card.id] || 0); }
  isCreature(card) { return this.chars(card).types.has('Creature'); }

  // ---------------------------------------------------------------- logging / UI
  log(text, extra = {}) {
    const entry = { id: this.uid++, turn: this.turnNumber, text, ...extra };
    this.logs.push(entry);
    if (this.logs.length > 600) this.logs.splice(0, this.logs.length - 600);
    if (this.debugLog) console.log(`[T${this.turnNumber}] ${text}`);
    this.notify();
  }
  notify() { if (this.onUpdate) this.onUpdate(this); }
  name(o) {
    if (!o) return '?';
    if (o.isPlayer) return o.name;
    if (o.stackItem) return o.description || 'ability';
    if (o.lki) return o.chars.name || 'face-down card';
    if (o.isEffect) return o.effectName;
    const ch = this.chars(o);
    return ch.name || (o.faceDown ? 'face-down creature' : o.faceDef.name);
  }

  async ask(pid, req) {
    if (this.over) throw new GameOver();
    if (++this.askCount % 100 === 0) await new Promise(r => setTimeout(r, 0));
    const agent = this.agents[pid];
    req.player = pid;
    this.pendingAsk = { pid, req };
    this.notify();
    let ans;
    try {
      ans = await agent.ask(this, pid, req);
    } finally { this.pendingAsk = null; }
    if (this.over) throw new GameOver();
    return sanitizeAnswer(req, ans);
  }

  // ---------------------------------------------------------------- game start
  async start() {
    try {
      for (const p of this.players) this.rng.shuffle(p.library);
      this.activePlayer = this.rng.int(this.players.length);
      this.log(`${this.players[this.activePlayer].name} goes first.`);
      for (const p of this.players) await this.drawCards(p, 7, null, true);
      await this.mulligans();
      while (!this.over) {
        await this.takeTurn();
        if (this.turnNumber >= this.maxTurns) { this.endGame(null, 'Turn limit reached'); }
      }
    } catch (e) {
      if (!(e instanceof GameOver)) { this.error = e; this.over = true; this.log('Engine error: ' + e.message, { type: 'error' }); if (this.throwErrors) throw e; console.error(e); }
    }
    this.notify();
    return this.winner;
  }

  async mulligans() {
    for (const pid of this.apnap()) {
      const p = this.players[pid];
      let count = 0;
      while (count < 4) {
        const keep = await this.ask(pid, { type: 'mulligan', hand: p.hand.map(c => c.id), count });
        if (keep) break;
        count++;
        for (const c of [...p.hand]) await this.moveCard(c, 'library', { silent: true });
        this.rng.shuffle(p.library);
        await this.drawCards(p, 7, null, true);
        this.log(`${p.name} mulligans.`);
      }
      const bottom = Math.max(0, count - 1); // first mulligan is free in Commander
      if (bottom > 0) {
        const ids = await this.ask(pid, { type: 'cards', prompt: `Put ${bottom} card(s) on the bottom of your library`, cards: p.hand.map(c => c.id), min: bottom, max: bottom, purpose: 'mulliganBottom' });
        for (const id of ids) { const c = this.cardById(id); if (c) await this.moveCard(c, 'library', { pos: 'bottom', silent: true }); }
      }
    }
    // "if this card is in your opening hand, you may begin the game with it on the battlefield"
    for (const pid of this.apnap()) {
      for (const c of [...this.players[pid].hand]) {
        const k = c.faceDef.keywords.find(x => /^MayEffectFromOpeningHand:/.test(x));
        const raw = k && c.faceDef.svars[k.split(':')[1]];
        if (!raw || c.zone !== 'hand') continue;
        if (!(await this.ask(pid, { type: 'confirm', prompt: `Begin the game with ${this.name(c)} on the battlefield?`, purpose: 'openingHand', cards: [c.id] }))) continue;
        await this.resolveSAChain(new SA(this, { raw, parsed: parseAbility(raw), svars: c.faceDef.svars, src: c, key: 'openingHand' }, c, pid));
      }
    }
  }

  // ---------------------------------------------------------------- turns
  async takeTurn() {
    this.turnNumber++;
    const ap = this.activePlayer;
    const p = this.players[ap];
    // day / night: night if the previous turn's active player cast no spells, day again after two or more
    if (this.dayNight && this.lastActive != null && this.players[this.lastActive]) {
      const cast = this.players[this.lastActive].spellsCastThisTurn.length;
      if (this.dayNight === 'Day' && cast === 0) this.setDayNight('Night');
      else if (this.dayNight === 'Night' && cast >= 2) this.setDayNight('Day');
    }
    this.lastActive = ap;
    noteTurnEnd(this);
    this.turnState = this.freshTurnState();
    this.turnState.turnsTaken[ap] = (this.turnState.turnsTaken[ap] || 0) + 1;
    for (const pl of this.players) { pl.landsPlayed = 0; pl.lifeGainedThisTurn = 0; pl.lifeLostThisTurn = 0; pl.cardsDrawnThisTurn = 0; pl.spellsCastThisTurn = []; pl.manaExpended = 0; pl.handAtTurnStart = pl.hand.length; }
    p.attackedPlayers = []; p.attackedPlayersTurn = this.turnNumber;
    p.turns = [...p.turns.slice(-2), this.turnNumber];
    for (const c of this.battlefield) { c.abilityUses = {}; if (!c.tapped) c.untappedTurn = this.turnNumber; }
    this.log(`Turn ${this.turnNumber}: ${p.name}`, { type: 'turn' });
    // effects lasting "until your next turn"
    await this.expireDurations('UntilYourNextTurn', ap);
    this.extraCombats = 0;
    this.combatsThisTurn = 0;
    this.endTurnNow = false; this.endCombatNow = false;
    for (let i = 0; i < STEPS.length; i++) {
      if (this.over) return;
      const step = STEPS[i];
      const skip = this.skipEntry(p, step) || this.beginPhaseSkip(p, step);
      if (skip) {
        if (!skip.thisTurn) p.skips = p.skips.filter(e => e !== skip);
        this.log(`${p.name} skips ${skip.label}.`);
        if (step === 'beginCombat') i = STEPS.indexOf('endCombat');
        continue;
      }
      if (this.endTurnNow) { this.endTurnNow = false; this.endCombatNow = false; if (step !== 'cleanup') { i = STEPS.indexOf('cleanup') - 1; continue; } }
      if (this.endCombatNow && ['declareAttackers', 'declareBlockers', 'firstStrikeDamage', 'combatDamage'].includes(step)) continue;
      if (step === 'endCombat') this.endCombatNow = false;
      if (step === 'firstStrikeDamage' && !(this.combat && combat.needsFirstStrike(this))) continue;
      if ((step === 'declareBlockers' || step === 'firstStrikeDamage' || step === 'combatDamage') && !(this.combat && this.combat.attackers.length)) continue;
      await this.runStep(step);
      if ((step === 'endCombat' || step === 'main2') && this.extraCombats > 0) { this.extraCombats--; i = STEPS.indexOf('beginCombat') - 1; }
      if (this.players[ap].lost) break;
    }
    this.combat = null;
    if (!this.currentExtra) this.turnBase = ap;
    this.currentExtra = false;
    while (this.extraTurns.length) {
      const nx = this.extraTurns.pop();
      if (this.players[nx].lost) continue;
      // "If a player would begin an extra turn, that player skips that turn instead."
      const skipper = this.replacementsFor('BeginTurn').find(({ p, ctx }) => p.ExtraTurn === 'True' && p.Skip === 'True' && (!p.ValidPlayer || matchValid(this, this.players[nx], p.ValidPlayer, ctx)));
      if (skipper) { this.log(`${this.players[nx].name} skips an extra turn (${this.name(skipper.h)}).`); continue; }
      this.activePlayer = nx;
      this.currentExtra = true;
      this.log(`${this.players[nx].name} takes an extra turn.`);
      this.touch();
      return;
    }
    this.activePlayer = this.nextPlayer(this.turnBase ?? ap);
    this.touch();
  }

  skipEntry(p, step) {
    if (!p.skips || !p.skips.length) return null;
    p.skips = p.skips.filter(e => !e.thisTurn || e.turn === this.turnNumber);
    return p.skips.find(e => e.steps.includes(step)) || null;
  }

  // active replacement effects of one event type on permanents and effects: [{ h, r, p, ctx }]
  replacementsFor(event) {
    const out = [];
    for (const h of [...this.battlefield, ...this.effects]) {
      if (h.phasedOut) continue;
      const ch = h.isEffect ? h.effectChars : this.chars(h);
      for (const r of ch.replacements) {
        const p = r.parsed.p;
        if (p.Event !== event) continue;
        const ctx = { host: h, you: h.controller, svars: r.svars, sa: { svars: r.svars, host: h, controller: h.controller, root() { return { x: 0, paid: {} }; } } };
        if (!checkPresence(this, p, ctx)) continue;
        out.push({ h, r, p, ctx });
      }
    }
    return out;
  }

  // "Skip your draw step." (Event$ BeginPhase | Skip$ True)
  beginPhaseSkip(p, step) {
    const forge = { untap: 'Untap', upkeep: 'Upkeep', draw: 'Draw', main1: 'Main1', beginCombat: 'BeginCombat', end: 'End of Turn' }[step];
    if (!forge) return null;
    for (const { h, p: rp, ctx } of this.replacementsFor('BeginPhase')) {
      if (rp.Skip !== 'True') continue;
      if (rp.Phase && !rp.Phase.split(',').map(s => s.trim()).some(x => x === forge || (x === 'Main' && /^Main/.test(forge)))) continue;
      if (rp.ValidPlayer && !matchValid(this, p, rp.ValidPlayer, ctx)) continue;
      return { label: `their ${STEP_NAMES[step].toLowerCase().replace(/ step$/, '')} step (${this.name(h)})`, thisTurn: true };
    }
    return null;
  }

  async runStep(step) {
    this.step = step;
    this.touch();
    const ap = this.activePlayer;
    const p = this.players[ap];
    this.emptyPools();
    this.notify();
    switch (step) {
      case 'untap': {
        for (const c of [...this.battlefield]) {
          if (c.phasedOut && c.controller === ap) {
            if (!this.activeStatics('CantPhaseIn').some(s => matchValid(this, c, s.p.ValidCard || 'Card', s.ctx))) { c.phasedOut = false; this.touch(); }
            continue;
          }
          if (c.controller === ap) {
            c.sick = false;
            if (c.skipNextUntap) { c.skipNextUntap = false; continue; } // exerted
            if (c.tapped && this.hasKeyword(c, 'You may choose not to untap CARDNAME during your untap step.') && await this.ask(ap, { type: 'confirm', prompt: `Keep ${this.name(c)} tapped?`, purpose: 'keepTapped', cardId: c.id })) continue;
            if (c.tapped && !this.hasKeyword(c, "CARDNAME doesn't untap during your untap step.") && !c.doesntUntap && !(await this.untapPrevented(c))) await this.untap(c);
          } else if (c.tapped && this.activeStatics('UntapOtherPlayer').some(s => s.ctx.you === c.controller && matchValid(this, c, s.p.ValidCard || 'Permanent.YouCtrl', s.ctx)) && !(await this.untapPrevented(c))) await this.untap(c);
        }
        // goad wears off at goader's next turn
        for (const c of this.battlefield) if (c.goadedBy.includes(ap)) c.goadedBy = c.goadedBy.filter(x => x !== ap);
        return; // no priority
      }
      case 'upkeep': {
        this.fire('Phase', { Phase: 'Upkeep', Player: ap });
        if (this.initiative === ap) { this.log(`${p.name} has the initiative.`); await this.venture(ap, { undercity: true }); }
        // suspend: remove a time counter from each suspended card you own
        for (const c of [...p.exile]) {
          if ((c.counters.TIME || 0) > 0 && (c.suspended || this.hasKeyword(c, 'Suspend'))) {
            this.pendingTriggers.push({ host: c, t: { parsed: { p: { Execute: 'SuspendTick', TriggerDescription: `Suspend — remove a time counter from ${this.name(c)}` } }, svars: { SuspendTick: 'DB$ SuspendTick' }, key: 'suspend' }, rp: { Card: c }, controller: ap });
          }
        }
        break;
      }
      case 'draw': {
        const skip = this.turnNumber === 1 && this.players.length === 2;
        if (!skip) { this.turnDrawFor = p.id; try { await this.drawCards(p, 1, null); } finally { this.turnDrawFor = null; } }
        this.fire('Phase', { Phase: 'Draw', Player: ap });
        break;
      }
      case 'main1': {
        if ((p.counters.RAD || 0) > 0) {
          const milled = await this.mill(p, p.counters.RAD, null);
          const nonland = milled.filter(c => !this.chars(c).types.has('Land')).length;
          if (nonland) {
            this.log(`Radiation: ${p.name} milled ${nonland} nonland card${nonland > 1 ? 's' : ''}.`);
            if (this.activeStatics('GainLifeRadiation').some(s => matchValid(this, p, s.p.ValidPlayer || 'You', s.ctx))) await this.gainLife(p, nonland, null);
            else await this.loseLife(p, nonland, null);
            await this.removeCounters(p, 'RAD', nonland);
          }
        }
        // saga lore counters
        for (const c of this.battlefield.filter(x => x.controller === ap && this.chars(x).subtypes.has('Saga'))) await this.addCounters(c, 'LORE', 1, null);
        this.fire('Phase', { Phase: 'Main1', Player: ap });
        break;
      }
      case 'beginCombat': this.combat = { attackers: [], blockers: new Map(), firstStrikeDone: new Set() }; this.combatsThisTurn = (this.combatsThisTurn || 0) + 1; this.fire('Phase', { Phase: 'BeginCombat', Player: ap }); break;
      case 'declareAttackers': {
        if (!this.combat) this.combat = { attackers: [], blockers: new Map(), firstStrikeDone: new Set() };
        await combat.declareAttackers(this);
        if (!this.combat.attackers.length) { await this.processTriggersAndSBA(); this.combat.skipped = true; return this.priorityLoop(); }
        break;
      }
      case 'declareBlockers': await combat.declareBlockers(this); break;
      case 'firstStrikeDamage': await combat.combatDamage(this, true); break;
      case 'combatDamage': await combat.combatDamage(this, false); break;
      case 'endCombat': this.fire('Phase', { Phase: 'EndCombat', Player: ap }); break;
      case 'main2': this.combat = null; this.fire('Phase', { Phase: 'Main2', Player: ap }); break;
      case 'end': {
        this.fire('Phase', { Phase: 'End of Turn', Player: ap });
        if (this.monarch != null && !this.players[this.monarch].lost) this.queueMonarchDraw = this.monarch;
        break;
      }
      case 'cleanup': {
        // "at the beginning of the next cleanup step" (MayFlashSac)
        this.fire('Phase', { Phase: 'Cleanup', Player: ap });
        // discard to hand size
        const max = this.playerChars(ap).maxHandSize;
        if (p.hand.length > max) {
          const n = p.hand.length - max;
          const ids = await this.ask(ap, { type: 'cards', prompt: `Discard ${n} card(s) to hand size`, cards: p.hand.map(c => c.id), min: n, max: n, purpose: 'discard' });
          for (const id of ids) { const c = this.cardById(id); if (c && c.zone === 'hand') await this.discard(c, null); }
        }
        for (const c of this.battlefield) { c.damage = 0; c.deathtouchHit = false; }
        await this.expireDurations('EOT');
        this.touch();
        await this.processTriggersAndSBA();
        if (this.stack.length) await this.priorityLoop();
        return;
      }
    }
    if (step === 'end' && this.queueMonarchDraw != null) {
      const m = this.queueMonarchDraw; this.queueMonarchDraw = null;
      if (this.monarch === m) await this.drawCards(this.players[m], 1, null);
    }
    await this.priorityLoop();
    if (step === 'endCombat') {
      await this.expireDurations('UntilEndOfCombat');
      this.combat = null;
      this.touch();
    }
  }

  // mana empties between steps, except what "you don't lose unspent mana" keeps; Omnath turns lost mana colorless
  emptyPools() {
    for (const pl of this.players) {
      const held = heldPersistentMana(this, pl); // "you don't lose this mana as steps and phases end" (mech-params.js)
      const keep = {};
      for (const s of this.activeStatics('UnspentMana')) {
        if (!matchValid(this, pl, s.p.ValidPlayer || 'You', s.ctx)) continue;
        const t = s.p.ManaType;
        for (const k of Object.keys(pl.pool)) if (!t || t === 'All' || t.split(',').some(x => (NAME_TO_COLOR[x.trim().toLowerCase()] || x.trim()) === k)) keep[k] = true;
      }
      const lost = Object.keys(pl.pool).filter(k => !keep[k]).reduce((a, k) => a + (pl.pool[k] || 0), 0);
      const np = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
      for (const k of Object.keys(np)) if (keep[k]) np[k] = pl.pool[k] || 0;
      if (lost > 0 && this.replacementsFor('LoseMana').some(({ p, ctx }) => !p.ValidPlayer || matchValid(this, pl, p.ValidPlayer, ctx))) np[loseManaColor(this, pl)] += lost;
      if (held) for (const k of Object.keys(held)) np[k] += held[k];
      pl.pool = np;
    }
    this.touch();
  }

  async expireDurations(kind, pid = null) {
    const match = d => d === kind || (kind === 'EOT' && (d == null || d === 'EOT' || d === 'UntilEndOfTurn'));
    let changed = false;
    for (const pl of this.players) if (pl.temp && pl.temp.length) { const k = pl.temp.filter(t => !(match(t.until) && (pid == null || t.owner === pid))); if (k.length !== pl.temp.length) { pl.temp = k; changed = true; } }
    for (const c of this.allCards()) {
      const keepT = c.temp.filter(t => !(match(t.until) && (pid == null || t.owner === pid)));
      if (keepT.length !== c.temp.length) { c.temp = keepT; changed = true; }
      const keepM = c.mods.filter(m => !(match(m.until) && (pid == null || m.owner === pid)));
      if (keepM.length !== c.mods.length) { c.mods = keepM; changed = true; }
    }
    const remain = [];
    for (const e of this.effects) {
      if (match(e.duration) && (pid == null || e.controller === pid)) { changed = true; continue; }
      remain.push(e);
    }
    this.effects = remain;
    // temporary control changes
    for (const c of this.battlefield) {
      if (c.tempControl && match(c.tempControl.until) && (pid == null || c.tempControl.owner === pid)) {
        c.controller = c.tempControl.prev; c.tempControl = null; changed = true;
        c.sick = true;
      }
    }
    if (kind === 'EOT') for (const c of this.battlefield) c.goadedBy = c.goadedBy || [];
    if (changed) this.touch();
  }

  // ---------------------------------------------------------------- priority
  async priorityLoop() {
    let passes = 0;
    this.priority = this.activePlayer;
    while (!this.over) {
      await this.processTriggersAndSBA();
      if (this.over) return;
      if (this.endTurnNow || (this.endCombatNow && this.combat && !this.stack.length)) return;
      const living = this.livingPlayers().length;
      const pid = this.priority;
      if (this.players[pid].lost) { this.priority = this.nextPlayer(pid); continue; }
      const action = await this.ask(pid, { type: 'priority' });
      if (!action || action.type === 'pass') {
        passes++;
        if (passes >= living) {
          if (!this.stack.length) return;
          await this.resolveTop();
          passes = 0;
          this.priority = this.activePlayer;
          continue;
        }
        this.priority = this.nextPlayer(pid);
        continue;
      }
      const did = await this.performAction(pid, action);
      if (did) passes = 0;
    }
  }

  async performAction(pid, action) {
    try {
      switch (action.type) {
        case 'land': return await playLand(this, pid, this.cardById(action.cardId), action);
        case 'cast': return await castSpell(this, pid, this.cardById(action.cardId), action);
        case 'activate': return await activateAbility(this, pid, this.cardById(action.cardId), action.abilityKey, action);
        case 'mana': return await activateManaAbility(this, pid, this.cardById(action.cardId), action.abilityKey, action.color);
        case 'concede': this.playerLoses(this.players[pid], 'conceded'); await this.checkSBA(); return true;
        default: return false;
      }
    } catch (e) {
      if (e instanceof GameOver) throw e;
      if (e && e.cancelled) return false;
      this.log(`Error performing action: ${e.message}`, { type: 'error' });
      if (this.throwErrors) throw e;
      console.error(e);
      return false;
    }
  }

  async resolveTop() {
    if (++this.turnState.resolutions > 600) {
      this.log('Too many objects resolved this turn; clearing the stack to break a loop.', { type: 'error' });
      for (const it of this.stack) if (it.card && it.card.zone === 'stack') await this.moveCard(it.card, 'graveyard', { silent: true });
      this.stack = [];
      return;
    }
    const item = this.stack.pop();
    this.touch();
    try {
      await resolveStackItem(this, item);
    } catch (e) {
      if (e instanceof GameOver) throw e;
      this.log(`Error resolving ${item.description || 'ability'}: ${e.message}`, { type: 'error' });
      if (this.throwErrors) throw e;
      console.error(e);
      if (item.card && item.card.zone === 'stack') await this.moveCard(item.card, 'graveyard');
    }
    this.touch();
    this.notify();
  }

  getActions(pid) { return getActions(this, pid); }

  // ---------------------------------------------------------------- triggers
  fire(mode, rp = {}) {
    if (this.over) return;
    rp.Mode = mode;
    if ((mode === 'ChangesZone' || mode === 'ChangesZoneAll') && rp.Destination === 'Battlefield' && this.battlefield.length) {
      const off = this.activeStatics('DisableTriggers').filter(s => (!s.p.ValidMode || s.p.ValidMode.split(',').includes(mode)) && (!s.p.Destination || s.p.Destination === 'Battlefield'));
      if (off.length) {
        const blocked = c => c && off.some(s => matchValid(this, c, s.p.ValidCause || 'Creature', s.ctx));
        if (mode === 'ChangesZone' && blocked(rp.Card)) return;
        if (mode === 'ChangesZoneAll') { rp.Cards = (rp.Cards || []).filter(c => !blocked(c)); if (!rp.Cards.length) return; rp.Amount = rp.Cards.length; }
      }
    }
    const sources = this.triggerHosts(mode, rp);
    for (const { host, t, zone } of sources) {
      const p = t.parsed.p;
      if (p.Mode !== mode && !(mode === 'SpellCast' && p.Mode === 'SpellCastOrCopy') && !(mode === 'SpellCopy' && p.Mode === 'SpellCastOrCopy')) continue;
      const controller = t.delayed && t.delayed.controller != null ? t.delayed.controller : host.isEffect ? host.controller : (host.lki ? host.controller : (zone === 'battlefield' || zone === 'stack' ? host.controller : host.owner));
      if (!this.triggerZoneOk(p, zone, host, rp)) continue;
      // "When CARDNAME enters during the declare attackers step, ..." (Phase$ on a non-phase trigger)
      if (p.Phase && mode !== 'Phase' && !p.Phase.split(',').map(s => s.trim()).includes(FORGE_PHASE[this.step])) continue;
      const ctx = { host, you: controller, trig: rp, svars: t.svars, door: t.door, sa: { svars: t.svars, host, controller, trig: rp, root() { return { x: host.xPaid || 0, paid: {} }; }, parent: null, targets: [] } };
      try {
        if (!triggerMatches(this, p, host, rp, ctx)) continue;
        if (!checkPresence(this, p, ctx)) continue;
      } catch (e) { if (this.throwErrors) throw e; continue; }
      if (p.ActivationLimit || p.ResolvedLimit || p.FirstTime) {
        const k = `${host.id}:${t.key}`;
        const n = this.turnState.triggerCounts[k] || 0;
        const lim = +(p.ActivationLimit || p.ResolvedLimit || 1);
        if (n >= lim) continue;
        this.turnState.triggerCounts[k] = n + 1;
      }
      // "when you NEXT cast a spell this turn" (Ride the Avalanche, Brass Infiniscope, Solar Array): once
      if (p.OneOff === 'True') {
        const k = `${host.id}:${t.key}`;
        const fired = this.turnState.oneOffFired || (this.turnState.oneOffFired = {});
        if (fired[k]) continue;
        fired[k] = true;
      }
      const lk = `${host.id}:${t.key}`;
      const lc = (this.turnState.loopCounts[lk] = (this.turnState.loopCounts[lk] || 0) + 1);
      if (lc > 80) { if (lc === 81) this.log(`Stopped a possible infinite loop from ${this.name(host)}.`, { type: 'info' }); continue; }
      this.pendingTriggers.push({ host, t, rp: { ...rp }, controller, delayed: t.delayed });
      // Panharmonicon-style doubling
      if (mode === 'ChangesZone' && rp.Destination === 'Battlefield') {
        for (const s of this.activeStatics('Panharmonicon')) {
          if (s.ctx.you !== controller) continue;
          if (s.p.ValidCard && !matchValid(this, rp.Card, s.p.ValidCard, s.ctx)) continue;
          if (s.p.ValidCause && !matchValid(this, host, s.p.ValidCause, s.ctx)) continue;
          this.pendingTriggers.push({ host, t, rp: { ...rp }, controller });
        }
      }
      if (t.delayed) { t.delayed.fired = true; }
    }
    if (this.delayed.some(d => d.fired)) this.delayed = this.delayed.filter(d => !d.fired);
  }

  triggerZoneOk(p, zone, host, rp) {
    const tz = p.TriggerZones ? p.TriggerZones.split(',').map(z => zoneMap[z.trim()] || z.trim().toLowerCase()) : null;
    // delayed triggers exist apart from their source: they fire wherever (and whether) that card is now
    if (host.isEffect || host.isDelayed || zone === 'delayed') return true;
    if (zone === 'lookback') {
      // leaves-the-battlefield triggers "look back in time"
      return !tz || tz.includes('battlefield');
    }
    if (tz) return tz.includes(zone);
    if (zone === 'battlefield') return true;
    // self triggers that work from other zones
    if (zone === 'stack' && rp.Card && rp.Card.id === host.id) return true;
    if (rp.Card && rp.Card.id === host.id && (p.Mode === 'ChangesZone' || p.Mode === 'Discarded' || p.Mode === 'Cycled' || p.Mode === 'Drawn' || p.Mode === 'Milled' || p.Mode === 'Exiled' || p.Mode === 'SpellCast' || p.Mode === 'TurnFaceUp')) {
      if (p.Mode === 'ChangesZone') return (p.Destination || 'Any') !== 'Battlefield' || zone === 'battlefield';
      return true;
    }
    return false;
  }

  triggerHosts(mode, rp) {
    const out = [];
    const seen = new Set();
    const add = (host, zone, triggers) => {
      for (const t of triggers) out.push({ host, t, zone });
    };
    for (const c of this.battlefield) {
      if (c.phasedOut) continue;
      seen.add(c.id);
      add(c, 'battlefield', this.chars(c).triggers);
    }
    if (rp.Origin === 'Battlefield' || mode === 'ChangesZoneAll' || mode === 'Sacrificed' || mode === 'Destroyed' || mode === 'Exiled' || mode === 'Unattached') {
      for (const l of this.lookback) { if (seen.has(l.id)) continue; seen.add(l.id); add(l, 'lookback', l.chars.triggers); }
    }
    for (const p of this.players) {
      for (const z of ['hand', 'graveyard', 'exile', 'command', 'library']) {
        for (const c of p[z]) {
          if (seen.has(c.id)) continue;
          const f = c.faceDef;
          if (!f.triggers.length && !(c.def.faces.length > 1)) continue;
          const isSelf = rp.Card && rp.Card.id === c.id;
          if (!isSelf && !f.triggers.some(t => /TriggerZones\$/.test(t))) continue;
          if (z === 'library' && !isSelf) continue;
          add(c, z, this.chars(c).triggers);
        }
      }
    }
    for (const s of this.stack) if (s.card && s.kind === 'spell' && !seen.has(s.card.id)) { seen.add(s.card.id); add(s.card, 'stack', this.chars(s.card).triggers); }
    for (const e of this.effects) add(e, 'command', e.effectChars.triggers);
    for (const d of this.delayed) {
      if (d.fired) continue;
      if (d.thisTurnOnly && d.turn !== this.turnNumber) continue;
      if (d.afterCombats && (this.combatsThisTurn || 0) < d.afterCombats) continue;
      if (d.nextTurn && d.turn === this.turnNumber) continue;
      out.push({ host: d.host, t: { parsed: { p: d.p }, svars: d.svars, key: 'delayed' + d.id, delayed: d }, zone: 'delayed', delayed: d });
    }
    return out;
  }

  async processTriggersAndSBA() {
    if (this.pendingMadness && this.pendingMadness.length) {
      const list = this.pendingMadness; this.pendingMadness = [];
      for (const m of list) await castAlternative(this, m.pid, m.card, m.cost, 'Madness', true);
    }
    if (this.pendingMiracle) {
      const m = this.pendingMiracle; this.pendingMiracle = null;
      if (m.card.zone === 'hand') await castAlternative(this, m.pid, m.card, m.cost, 'Miracle', false);
    }
    if (this.pendingInitiative != null) {
      const to = this.pendingInitiative; this.pendingInitiative = null;
      if (!this.players[to].lost) await this.takeInitiative(to);
    }
    await this.assignSectors();
    for (let guard = 0; guard < 50 && !this.over; guard++) {
      await this.checkSBA();
      if (this.over) return;
      if (!this.pendingTriggers.length) { this.lookback = []; return; }
      const pend = this.pendingTriggers;
      this.pendingTriggers = [];
      const order = this.apnap();
      pend.sort((a, b) => order.indexOf(a.controller) - order.indexOf(b.controller));
      for (const pt of pend) {
        if (this.players[pt.controller] && this.players[pt.controller].lost) continue;
        await this.putTriggerOnStack(pt);
      }
      this.lookback = [];
    }
  }

  // ---------------------------------------------------------------- dungeons & initiative
  async venture(pid, { undercity = false } = {}) {
    const p = this.players[pid];
    if (!p || p.lost) return;
    if (p.dungeon && !p.dungeon.next.length) this.completeDungeon(p);
    let room;
    if (!p.dungeon) {
      const names = undercity ? ['undercity'] : ['lost_mine_of_phandelver', 'dungeon_of_the_mad_mage', 'tomb_of_annihilation'];
      const defs = names.map(n => this.db.token(n)).filter(Boolean);
      if (!defs.length) return;
      let def = defs[0];
      if (defs.length > 1) {
        const i = await this.ask(pid, { type: 'option', prompt: 'Venture into which dungeon?', options: defs.map((d, i) => ({ label: `${d.faces[0].name} (${d.faces[0].keywords.find(k => k.startsWith("Dungeon:")).split(':')[1].split(',').length} rooms)`, value: i })), purpose: 'dungeon' });
        def = defs[i] || defs[0];
      }
      const face = def.faces[0];
      const rooms = face.keywords.find(k => k.startsWith("Dungeon:")).split(':')[1].split(',');
      const svars = { ...face.svars };
      const obj = {
        isEffect: true, isDungeon: true, id: this.nextId++, effectName: face.name, controller: pid, owner: pid, zone: 'command',
        duration: 'Permanent', remembered: [], imprinted: [], chosen: {}, counters: {}, timestamp: this.uid++, temp: [], mods: [], abilityUses: {}, xPaid: 0,
        description: face.oracle || '',
      };
      obj.effectChars = { name: face.name, types: new Set(['Dungeon']), subtypes: new Set(face.subtypes || []), supertypes: new Set(), colors: new Set(), keywords: [], abilities: [], triggers: [], statics: [], replacements: [], svars, power: 0, toughness: 0, cmc: 0 };
      p.dungeon = { obj, room: null, next: [], rooms, svars };
      room = rooms[0];
    } else {
      const d = p.dungeon;
      room = d.next[0];
      if (d.next.length > 1) {
        const i = await this.ask(pid, { type: 'option', prompt: `${d.obj.effectName}: choose the next room`, options: d.next.map((r, i) => ({ label: `${roomName(d.svars, r)} — ${roomText(d.svars, r)}`, value: i })), purpose: 'room' });
        room = d.next[i] || d.next[0];
      }
    }
    const d = p.dungeon;
    d.room = room;
    const rp = parseAbility(d.svars[room]).p;
    d.next = rp.NextRoom ? rp.NextRoom.split(',') : [];
    d.roomLabel = roomName(d.svars, room);
    d.roomDesc = `${roomText(d.svars, room)}${d.next.length ? ` Leads to: ${d.next.map(r => roomName(d.svars, r)).join(', ')}.` : ' Last room.'}`;
    this.log(`${p.name} enters ${roomName(d.svars, room)} (${d.obj.effectName}).`);
    const times = 1 + (this.activeStatics('Panharmonicon').some(s => s.p.ValidMode === 'RoomEntered' && s.ctx.you === pid) ? 1 : 0);
    for (let k = 0; k < times; k++) this.pendingTriggers.push({ host: d.obj, t: { parsed: { p: { Execute: room, TriggerDescription: `${roomName(d.svars, room)} — ${roomText(d.svars, room)}` } }, svars: d.svars, key: `room${d.obj.id}${room}` }, rp: { Player: pid }, controller: pid });
    this.fire('RoomEntered', { Player: pid, Room: room });
    this.touch();
  }

  completeDungeon(p) {
    const d = p.dungeon;
    if (!d) return;
    p.dungeon = null;
    p.dungeonsCompleted.push(d.obj.effectName);
    this.log(`${p.name} completes ${d.obj.effectName}.`);
    this.fire('DungeonCompleted', { Player: p.id, Card: d.obj });
    this.touch();
  }

  async takeInitiative(pid) {
    const p = this.players[pid];
    if (!p || p.lost) return;
    this.initiative = pid;
    this.log(`${p.name} takes the initiative.`);
    this.fire('TakesInitiative', { Player: pid });
    await this.venture(pid, { undercity: true });
  }

  async putTriggerOnStack(pt) {
    const { host, t, rp, controller } = pt;
    const p = t.parsed.p;
    const svars = t.svars || {};
    const exec = p.Execute;
    const raw = exec ? svars[exec] : null;
    if (!raw) return;
    const sa = new SA(this, { raw, parsed: parseAbility(raw), svars, src: host, key: t.key }, host, controller, { trig: rp });
    sa.isTrigger = true;
    sa.triggerParams = p;
    if (pt.delayed) { sa.delayRemembered = pt.delayed.remembered || []; }
    if (t.delayed && t.delayed.remembered) sa.delayRemembered = t.delayed.remembered;
    if ((pt.delayed || t.delayed) && (pt.delayed || t.delayed).spawner) sa.spawner = (pt.delayed || t.delayed).spawner;
    sa.description = this.describeTrigger(host, p, sa);
    if (p.Static === 'True') {
      await this.resolveSAChain(sa);
      return;
    }
    const ok = await chooseTargetsForSA(this, sa, { optional: true });
    if (!ok) { this.log(`${this.name(host)}'s trigger has no legal targets.`); return; }
    const item = { id: this.uid++, kind: 'trigger', sa, card: null, source: host, controller, description: sa.description, stackItem: true };
    sa.stackItem = item;
    this.stack.push(item);
    this.touch();
    this.notifyTargets(sa, item);
    this.log(`${this.name(host)} triggers: ${sa.description}`, { type: 'trigger', cardId: host.id });
  }

  notifyTargets(sa, item) {
    for (let s = sa; s; s = s.sub) {
      for (const t of s.targets || []) {
        if (t.isCard || t.isPlayer) { this.fire('BecomesTarget', { Target: t, Source: sa.host, SourceSA: item, StackItem: item, Player: item.controller }); noteTargeted(this, t, item.controller); }
      }
      for (const m of s.modes || []) for (const t of m.targets || []) { this.fire('BecomesTarget', { Target: t, Source: sa.host, SourceSA: item, StackItem: item, Player: item.controller }); noteTargeted(this, t, item.controller); }
    }
  }

  describeTrigger(host, p, sa) {
    let d = p.TriggerDescription || sa.def.p.SpellDescription || '';
    d = d.replace(/CARDNAME|NICKNAME/g, this.name(host));
    return d;
  }

  async resolveSAChain(sa) { return resolveChain(this, sa); }

  // ---------------------------------------------------------------- state-based actions
  async checkSBA() {
    for (let guard = 0; guard < 40; guard++) {
      if (this.over) return;
      let acted = false;
      for (const p of this.livingPlayers()) {
        if (p.life <= 0) { this.playerLoses(p, 'life total reached 0'); acted = true; continue; }
        if ((p.counters.POISON || 0) >= 10) { this.playerLoses(p, '10 poison counters'); acted = true; continue; }
        if (p.drewFromEmpty) { this.playerLoses(p, 'drew from an empty library'); acted = true; continue; }
        for (const [cid, dmg] of Object.entries(p.commanderDamage)) {
          if (dmg >= 21) { this.playerLoses(p, `21 combat damage from ${this.name(this.cardById(+cid))}`); acted = true; break; }
        }
      }
      if (this.checkWinner()) return;
      for (const p of this.livingPlayers()) {
        const d = p.dungeon;
        if (d && !d.next.length && !this.stack.some(it => it.sa && it.sa.host === d.obj) && !this.pendingTriggers.some(pt => pt.host === d.obj)) { this.completeDungeon(p); acted = true; }
      }
      const toGrave = [], toDestroy = [];
      for (const c of this.battlefield) {
        if (c.phasedOut) continue;
        const ch = this.chars(c);
        if (ch.types.has('Creature')) {
          if (ch.toughness <= 0) toGrave.push(c);
          else if ((c.damage >= ch.toughness && c.damage > 0) || c.deathtouchHit) toDestroy.push(c);
        }
        if (ch.types.has('Planeswalker') && (c.counters.LOYALTY || 0) <= 0 && !c.enteringPW) toGrave.push(c);
        if (ch.types.has('Battle') && (c.counters.DEFENSE || 0) <= 0) toGrave.push(c);
        // aura legality
        if (ch.subtypes.has('Aura') && !ch.types.has('Creature')) {
          const t = c.attachedTo;
          if (t == null) toGrave.push(c);
          else if (typeof t === 'number') {
            const tc = this.cardById(t);
            const ek = ch.keywords.find(k => k.startsWith('Enchant:'));
            const offField = ek && /inZone(\w+)/.test(ek) ? RegExp.$1.toLowerCase() : null;
            if (!tc || (tc.zone !== 'battlefield' && tc.zone !== offField) || tc.phasedOut) toGrave.push(c);
          } else if (typeof t === 'string') { const pl = this.players[+t.slice(1)]; if (!pl || pl.lost) toGrave.push(c); }
        }
        if ((ch.subtypes.has('Equipment') || ch.subtypes.has('Fortification')) && c.attachedTo != null) {
          const tc = this.cardById(c.attachedTo);
          const kind = ch.subtypes.has('Fortification') ? 'Land' : 'Creature';
          if (!tc || tc.zone !== 'battlefield' || !this.chars(tc).types.has(kind) || ch.types.has('Creature')) { c.attachedTo = null; this.touch(); acted = true; }
        }
        // counter annihilation
        if (c.counters.P1P1 > 0 && c.counters.M1M1 > 0) {
          const n = Math.min(c.counters.P1P1, c.counters.M1M1);
          c.counters.P1P1 -= n; c.counters.M1M1 -= n; this.touch(); acted = true;
        }
        // sagas
        if (ch.subtypes.has('Saga') && !ch.types.has('Creature')) {
          const chapters = this.keywordArgs(c, 'Chapter')[0];
          const final = chapters ? +chapters[0] : 3;
          if ((c.counters.LORE || 0) >= final && !this.stack.some(s => s.source && s.source.id === c.id && s.chapter) && !this.pendingTriggers.some(t => t.host.id === c.id)) toGrave.push(c);
        }
      }
      // legend rule
      const legends = {};
      for (const c of this.battlefield) {
        const ch = this.chars(c);
        if (!ch.supertypes.has('Legendary') || !ch.name) continue;
        if (this.activeStatics('IgnoreLegendRule').some(s => matchValid(this, c, s.p.ValidCard || 'Card.Self', s.ctx))) continue;
        const k = c.controller + '|' + ch.name;
        (legends[k] = legends[k] || []).push(c);
      }
      for (const list of Object.values(legends)) {
        if (list.length < 2) continue;
        const pid = list[0].controller;
        const keepId = await this.ask(pid, { type: 'cards', prompt: `Legend rule: choose the ${this.name(list[0])} to keep`, cards: list.map(c => c.id), min: 1, max: 1, purpose: 'legendKeep' });
        for (const c of list) if (c.id !== keepId[0]) toGrave.push(c);
      }
      const uniqG = [...new Set(toGrave)];
      const uniqD = [...new Set(toDestroy)].filter(c => !uniqG.includes(c));
      if (uniqG.length || uniqD.length) {
        acted = true;
        this.beginBatch();
        for (const c of uniqG) if (c.zone === 'battlefield') await this.moveCard(c, 'graveyard', { sba: true });
        for (const c of uniqD) if (c.zone === 'battlefield') await this.destroy(c, null, { sba: true });
        await this.endBatch();
      }
      // commanders in graveyard / exile may return to the command zone
      for (const p of this.players) {
        for (const z of ['graveyard', 'exile']) {
          for (const c of [...p[z]]) {
            if (!c.isCommander || c.commanderChecked === c.zcc) continue;
            c.commanderChecked = c.zcc;
            const yes = await this.ask(p.id, { type: 'confirm', prompt: `Move ${this.name(c)} to the command zone?`, purpose: 'commanderReturn', cardId: c.id, defaultYes: true });
            if (yes) { await this.moveCard(c, 'command'); acted = true; }
          }
        }
      }
      // "Always" state triggers (not once the loop breaker has cleared the stack this turn: one that keeps triggering would never end)
      if (!acted && this.turnState.resolutions <= 600) {
        for (const c of this.battlefield) for (const t of this.chars(c).triggers) {
          if (t.parsed.p.Mode !== 'Always') continue;
          if (this.stack.some(s => s.sa && s.sa.host && s.sa.host.id === c.id && s.sa.key === t.key) || this.pendingTriggers.some(x => x.host.id === c.id && x.t.key === t.key)) continue;
          const ctx = { host: c, you: c.controller, svars: t.svars, sa: { svars: t.svars, host: c, controller: c.controller, root() { return { x: 0, paid: {} }; } } };
          if (checkPresence(this, t.parsed.p, ctx)) this.pendingTriggers.push({ host: c, t, rp: { Mode: 'Always' }, controller: c.controller });
        }
      }
      if (!acted) return;
    }
  }

  playerLoses(p, reason) {
    if (p.lost) return;
    // "you don't lose the game for having 0 or less life" (Transcendence) still loses to an effect
    const why = { 'life total reached 0': 'LifeReachedZero', '10 poison counters': 'Poisoned', 'drew from an empty library': 'Milled' }[reason] || (/^21 combat damage/.test(reason) ? 'CommanderDamage' : 'SpellEffect');
    if (reason !== 'conceded' && (this.cantHappen('GameLoss', p, why) || this.opponents(p.id).every(o => this.cantHappen('GameWin', o)) && this.opponents(p.id).length === 1 && this.cantHappen('GameWin', this.opponents(p.id)[0]))) {
      if (!this._cantLoseLogged || this._cantLoseLogged !== this.turnNumber) { this.log(`${p.name} can't lose the game right now.`); this._cantLoseLogged = this.turnNumber; }
      return;
    }
    p.lost = true;
    p.lossReason = reason;
    p.lostTurn = this.turnNumber;
    p.lostOrder = this.players.filter(q => q.lost).length;
    this.log(`${p.name} loses the game (${reason}).`, { type: 'loss' });
    // a player who leaves the game takes their cards with them
    for (const c of [...this.battlefield]) {
      if (c.owner === p.id) { this.removeFromZone(c); c.zone = 'gone'; }
      else if (c.controller === p.id) { c.controller = c.owner; }
    }
    this.stack = this.stack.filter(s => s.controller !== p.id);
    this.effects = this.effects.filter(e => e.controller !== p.id);
    if (this.monarch === p.id) this.monarch = this.activePlayer !== p.id ? this.activePlayer : null;
    if (this.initiative === p.id) { const to = this.activePlayer !== p.id ? this.activePlayer : this.nextPlayer(p.id); this.initiative = null; if (to !== p.id) this.pendingInitiative = to; }
    p.dungeon = null;
    this.fire('LosesGame', { Player: p.id });
    this.touch();
    this.checkWinner();
  }

  checkWinner() {
    const alive = this.livingPlayers();
    if (alive.length <= 1 && !this.over) {
      this.endGame(alive[0] ? alive[0].id : null, alive[0] ? (alive[0].name === 'You' ? 'You win!' : `${alive[0].name} wins!`) : 'Draw');
      return true;
    }
    const humans = this.players.filter(p => p.isHuman);
    if (humans.length && humans.every(p => p.lost) && !this.over && !this.continueAfterHumanLoss) {
      this.endGame(alive.length === 1 ? alive[0].id : null, 'You were eliminated.');
      return true;
    }
    return this.over;
  }

  endGame(winner, text) {
    this.over = true;
    this.winner = winner;
    this.resultText = text;
    this.log(text, { type: 'gameover' });
    this.notify();
  }

  // ---------------------------------------------------------------- zone changes
  removeFromZone(card) {
    const z = card.zone;
    if (z === 'battlefield') { const i = this.battlefield.indexOf(card); if (i >= 0) this.battlefield.splice(i, 1); }
    else if (z === 'stack') { const i = this.stack.findIndex(s => s.card === card); if (i >= 0) this.stack.splice(i, 1); }
    else if (z && this.players[card.owner] && this.players[card.owner][z]) {
      const arr = this.players[card.owner][z];
      const i = arr.indexOf(card); if (i >= 0) arr.splice(i, 1);
    }
  }

  makeLKI(card) {
    const ch = this.chars(card);
    return {
      lki: true, id: card.id, card, def: card.def, owner: card.owner, controller: card.controller,
      chars: { ...ch, types: new Set(ch.types), subtypes: new Set(ch.subtypes), supertypes: new Set(ch.supertypes), colors: new Set(ch.colors), keywords: [...ch.keywords] },
      counters: { ...card.counters }, tapped: card.tapped, token: card.token, isCommander: card.isCommander,
      remembered: [...card.remembered], imprinted: [...card.imprinted], chosen: { ...card.chosen }, attachedTo: card.attachedTo,
      zone: card.zone, zcc: card.zcc, damage: card.damage, timestamp: card.timestamp, xPaid: card.xPaid, kicked: card.kicked, faceDown: card.faceDown,
      castFrom: card.castFrom, castMayPlayHost: card.castMayPlayHost, castSA: card.castSA, exiledWith: card.exiledWith, face: card.face, faceDef: card.faceDef, goadedBy: [...(card.goadedBy || [])],
      wasAttacking: this.isAttacking(card), wasBlocking: this.isBlocking(card), blocking: this.combat && this.combat.blockers.has(card.id) ? this.combat.blockers.get(card.id) : null, attackTurns: card.attackTurns,
      attackingAlone: this.isAttacking(card) && this.combat.attackers.length === 1, blockingAlone: this.isBlocking(card) && this.combat.blockers.size === 1,
      attachments: this.battlefield.filter(a => a.attachedTo === card.id).map(a => a.id),
      blitzed: card.blitzed, evoked: card.evoked, squad: card.squad, renowned: card.renowned, monstrous: card.monstrous, championed: card.championed,
    };
  }

  beginBatch() { this.batchDepth = (this.batchDepth || 0) + 1; if (this.batchDepth === 1) this.batchMoves = []; }
  async endBatch() {
    this.batchDepth--;
    if (this.batchDepth > 0) return;
    const moves = this.batchMoves || [];
    this.batchMoves = null;
    if (moves.length) {
      const byDest = {};
      for (const m of moves) (byDest[m.Destination + '|' + m.Origin] = byDest[m.Destination + '|' + m.Origin] || []).push(m);
      for (const list of Object.values(byDest)) {
        this.fire('ChangesZoneAll', { Cards: list.map(m => m.Card), CardsLKI: list.map(m => m.CardLKI), Origin: list[0].Origin, Destination: list[0].Destination, Amount: list.length });
      }
    }
  }

  // Central zone move. Returns the card (same object) in its new zone, or null if it ceased to exist.
  async moveCard(card, to, opts = {}) {
    if (!card || card.zone === 'gone') return null;
    const from = card.zone;
    let dest = to;
    const ZONE_NAME = { battlefield: 'Battlefield', graveyard: 'Graveyard', exile: 'Exile', hand: 'Hand', library: 'Library', command: 'Command', stack: 'Stack', none: 'None' };
    // commander replacement for hand / library
    if (card.isCommander && (dest === 'hand' || dest === 'library') && from !== 'library' && from !== 'command' && !opts.noCommanderReplace && opts.purpose !== 'mulligan') {
      const yes = await this.ask(card.owner, { type: 'confirm', prompt: `Move ${this.name(card)} to the command zone instead?`, purpose: 'commanderReturn', cardId: card.id, defaultYes: true });
      if (yes) dest = 'command';
    }
    // "exile instead if it would leave" (flashback, unearth, ...)
    if (card.mustBeExiled && from === 'stack' && dest !== 'exile' && dest !== 'battlefield') dest = 'exile';
    if (card.exileIfLeaves && from === 'battlefield' && dest !== 'exile') dest = 'exile';
    // replacement effects (Moved)
    if (!opts.noReplace) {
      const r = await this.applyMovedReplacements(card, from, dest, opts);
      if (r === null) return card; // replaced entirely
      dest = r;
    }
    // "triggered abilities you control can't cause you to exile creature tokens you control"
    if (dest === 'exile' && from === 'battlefield' && opts.cause && this.cantByStatic('CantExile', card, opts.cause, !!opts.forCost)) return card;
    const lki = from === 'battlefield' ? this.makeLKI(card) : (from === 'stack' ? this.makeLKI(card) : null);
    const wasFaceDown = card.faceDown;
    // leaving the battlefield
    if (from === 'battlefield') {
      if (this.combat) {
        this.combat.attackers = this.combat.attackers.filter(a => a.card !== card.id);
        this.combat.blockers.delete(card.id);
        for (const a of this.combat.attackers) a.blockers = a.blockers.filter(b => b !== card.id);
      }
      this.lookback.push(lki);
      this.turnState.permanentLeft[card.controller] = true;
      if (lki.chars.types.has('Creature') && dest === 'graveyard') this.turnState.creaturesDied++;
      // attached things fall off
      for (const a of this.battlefield) if (a.attachedTo === card.id) { a.attachedTo = null; }
      // effects that end when the host leaves
      this.effects = this.effects.filter(e => !(e.endsWhenHostLeaves === card.id) && !(e.exileOnMoved && e.remembered.some(r => r && r.id === card.id) && e.remembered.length === 1));
      for (const c of this.allCards()) {
        if (c.temp.some(t => t.untilHostLeaves === card.id)) c.temp = c.temp.filter(t => t.untilHostLeaves !== card.id);
        if (c.mods.some(m => m.untilHostLeaves === card.id)) c.mods = c.mods.filter(m => m.untilHostLeaves !== card.id);
      }
      for (const c of this.battlefield) if (c.tempControl && c.tempControl.untilHostLeaves === card.id) { c.controller = c.tempControl.prev; c.tempControl = null; }
    }
    this.removeFromZone(card);
    if (from === 'stack') { this.stack = this.stack.filter(s => s.card !== card); }
    // tokens cease to exist outside the battlefield
    const isToken = card.token;
    const prevController = card.controller;
    const countersRemain = dest !== 'hand' && dest !== 'library' && card.faceDef.statics.some(s => /Mode\$ CountersRemain/.test(s));
    const keepCounters = opts.keepCounters || countersRemain ? { ...card.counters } : null;
    const meldPartner = from === 'battlefield' && card.meldedWith != null ? this.cardById(card.meldedWith) : null;
    // (a new token made as a copy keeps what it copies, with its exceptions: "except it's 1/1", "it has haste")
    const keepCopy = from === 'none' ? card.copyOf : null;
    card.reset();
    if (keepCopy) card.copyOf = keepCopy;
    card.zcc++;
    // (a copy of a card being cast — Wondrous Crucible — is a token on the stack, not gone)
    if (isToken && dest !== 'battlefield' && !(dest === 'stack' && card.isSpellCopy)) {
      card.zone = 'gone';
      this.cards.delete(card.id);
      this.recordMove(card, lki, from, dest, opts, ZONE_NAME);
      return null;
    }
    if (keepCounters && dest !== 'battlefield') card.counters = keepCounters;
    card.enteredFrom = from; card.movedTurn = this.turnNumber;
    card.controller = dest === 'battlefield' ? (opts.controller != null ? opts.controller : (from === 'stack' ? prevController : card.owner)) : card.owner;
    card.zone = dest;
    const owner = this.players[card.owner];
    if (dest === 'battlefield') {
      this.battlefield.push(card);
      card.sick = true;
      card.enteredTurn = this.turnNumber;
      card.timestamp = newTimestamp(this);
      card.enteredController = card.controller;
      card.tapped = !!opts.tapped;
      if (opts.faceDown) card.faceDown = true;
      if (opts.setProps) Object.assign(card, opts.setProps);
      if (opts.transformed) { card.face = 1; card.transformed = true; }
      if (opts.face != null) card.face = opts.face;
      if (isRoom(card.def)) card.unlocked = opts.cast ? [opts.face || 0] : [];
      if (opts.cast) { card.castFrom = opts.cast.from; card.xPaid = opts.cast.x || 0; card.kicked = opts.cast.kicked || 0; card.castSA = opts.cast.sa || null; card.manaSpent = opts.cast.manaSpent || null; card.optionalCosts = opts.cast.optionalCosts || []; card.altCost = opts.cast.altCost || null; card.convokedBy = opts.cast.convokedBy || []; card.squad = opts.cast.squad || 0; card.evoked = card.altCost === 'Evoke'; card.blitzed = card.altCost === 'Blitz'; card.promisedGift = opts.cast.sa && opts.cast.sa.promisedGift != null ? opts.cast.sa.promisedGift : null; card.offspring = opts.cast.offspring || 0; if (opts.cast.grants && opts.cast.grants.length) card.temp.push({ keywords: opts.cast.grants, until: 'Permanent' }); }
      if (keepCounters) card.counters = keepCounters;
      if (opts.attachTo != null) card.attachedTo = opts.attachTo;
      if (opts.cause && opts.cause.p && opts.cause.p.StaticEffect) await applyStaticEffect(this, card, opts.cause); // "it's an enchantment" (mech-params.js)
      this.touch();
      await this.applyETB(card, opts);
      if (this.chars(card).types.has('Land')) this.turnState.landsEntered[card.controller] = (this.turnState.landsEntered[card.controller] || 0) + 1;
    } else if (dest === 'library') {
      if (opts.pos === 'bottom') owner.library.push(card);
      else if (typeof opts.pos === 'number') owner.library.splice(Math.min(opts.pos, owner.library.length), 0, card);
      else owner.library.unshift(card);
    } else if (dest === 'stack') {
      // caller pushes stack item
    } else {
      owner[dest].push(card);
      if (dest === 'exile' && opts.exiledWith != null) card.exiledWith = opts.exiledWith;
      if (dest === 'exile' && opts.faceDown) card.faceDown = true;
    }
    this.touch();
    if (!opts.silent && from !== 'library' || dest === 'battlefield' || dest === 'graveyard' || dest === 'exile') {
      if (!opts.silent && opts.log !== false) this.logMove(card, lki, from, dest, wasFaceDown);
    }
    this.recordMove(card, lki, from, dest, opts, ZONE_NAME);
    // a melded permanent is both cards: the other one goes along
    if (meldPartner && meldPartner.zone === 'exile') await this.moveCard(meldPartner, dest === 'command' ? (to === 'command' ? 'graveyard' : to) : dest, { silent: true, noReplace: dest === 'battlefield' });
    return card;
  }

  recordMove(card, lki, from, dest, opts, ZONE_NAME) {
    const rp = { Card: card, CardLKI: lki || (card.zone !== 'gone' ? null : null), Origin: ZONE_NAME[from] || from, Destination: ZONE_NAME[dest] || dest, Cause: opts.cause || null, CardZcc: card.zcc };
    if (!rp.CardLKI) rp.CardLKI = lki;
    this.turnState.moves.push({ card, lki, from, to: dest });
    if (lki) lki.newZcc = card.zcc;
    this.fire('ChangesZone', rp);
    if (this.batchMoves) this.batchMoves.push(rp);
    else if (from !== dest) this.fire('ChangesZoneAll', { Cards: [card], CardsLKI: [lki], Origin: rp.Origin, Destination: rp.Destination, Amount: 1 });
    if (dest === 'exile') this.fire('Exiled', rp);
  }

  logMove(card, lki, from, dest, wasFaceDown) {
    const nm = wasFaceDown && dest !== 'battlefield' ? (lki ? lki.chars.name || 'a face-down card' : this.name(card)) : this.name(card);
    const who = this.players[card.owner].name;
    let text = null;
    if (dest === 'battlefield') text = from === 'stack' ? null : `${nm} enters the battlefield${from === 'graveyard' ? ' from the graveyard' : from === 'exile' ? ' from exile' : ''}.`;
    else if (dest === 'graveyard') text = from === 'battlefield' ? (lki && lki.chars.types.has('Creature') ? `${nm} dies.` : `${nm} is put into the graveyard.`) : from === 'hand' ? null : from === 'library' ? null : from === 'stack' ? null : `${nm} goes to the graveyard.`;
    else if (dest === 'exile') text = `${nm} is exiled.`;
    else if (dest === 'hand' && from !== 'library') text = `${nm} returns to ${who}'s hand.`;
    else if (dest === 'library' && from !== 'hand') text = `${nm} is put into ${who}'s library.`;
    else if (dest === 'command') text = `${nm} moves to the command zone.`;
    if (text) this.log(text, { cardId: card.id, type: 'move' });
  }

  async applyMovedReplacements(card, from, dest, opts) {
    const ZONE_NAME = { battlefield: 'Battlefield', graveyard: 'Graveyard', exile: 'Exile', hand: 'Hand', library: 'Library', command: 'Command', stack: 'Stack' };
    const candidates = [];
    // others' replacement effects
    const hosts = [...this.battlefield, ...this.effects];
    for (const h of hosts) {
      const ch = h.isEffect ? h.effectChars : this.chars(h);
      for (const r of ch.replacements) {
        const p = r.parsed.p;
        if (p.Event !== 'Moved') continue;
        if (h.id === card.id && from !== 'battlefield') continue;
        candidates.push({ h, r, p });
      }
    }
    // the moving card's own replacements (e.g. "enters tapped")
    if (dest === 'battlefield' && from !== 'battlefield') {
      for (const r of this.chars(card).replacements) {
        const p = r.parsed.p;
        if (p.Event === 'Moved' && /Card\.Self|Self/.test(p.ValidCard || '')) candidates.push({ h: card, r, p, self: true });
      }
    }
    let curDest = dest;
    const applied = opts.appliedRepl || new Set();
    for (const { h, r, p, self } of candidates) {
      const key = h.id + ':' + r.key;
      if (applied.has(key)) continue;
      if (p.Destination && !p.Destination.split(',').includes(ZONE_NAME[curDest])) continue;
      if (p.Origin && !p.Origin.split(',').includes(ZONE_NAME[from])) continue;
      if (p.ExcludeDestination && p.ExcludeDestination.split(',').includes(ZONE_NAME[curDest])) continue;
      const you = h.isEffect ? h.controller : h.controller;
      const ctx = { host: h, you, svars: r.svars, trig: { Card: card }, sa: { svars: r.svars, host: h, controller: you, root() { return { x: 0, paid: {} }; }, trig: { Card: card } } };
      if (p.ValidCard && !self) {
        // evaluate entering card as if under its future controller
        if (!matchValid(this, card, p.ValidCard, { ...ctx, futureController: opts.controller })) continue;
      }
      if (p.ValidLKI && !matchValid(this, card, p.ValidLKI, ctx)) continue;
      if (p.ActiveZones && !h.isEffect && h.id !== card.id) {
        const zones = p.ActiveZones.split(',').map(z => zoneMap[z] || z.toLowerCase());
        if (!zones.includes(h.zone)) continue;
      }
      if (!checkPresence(this, p, ctx)) continue;
      if (p.Cause && opts.cause) { /* ignore cause restrictions */ }
      if (p.Layer === 'CantHappen') return null;
      const withRaw = p.ReplaceWith ? r.svars[p.ReplaceWith] : null;
      if (!withRaw) continue;
      const parsed = parseAbility(withRaw);
      if (p.ReplacementResult === 'Updated' || parsed.p.ETB === 'True' || ['Tap', 'PutCounter', 'ChooseColor', 'ChooseType', 'ChooseCard', 'ChoosePlayer', 'ChooseNumber', 'Clone', 'GenericChoice', 'Pump'].includes(parsed.api) && curDest === 'battlefield') {
        // ETB modifications; applied when the card actually enters
        (opts.etbMods = opts.etbMods || []).push({ raw: withRaw, svars: r.svars, host: h, self });
        applied.add(key);
        continue;
      }
      if (parsed.api === 'ChangeZone' && (parsed.p.Defined === 'ReplacedCard' || !parsed.p.Defined) && parsed.p.Destination) {
        const nd = zoneMap[parsed.p.Destination] || parsed.p.Destination.toLowerCase();
        if (p.Optional === 'True') {
          const yes = await this.ask(you, { type: 'confirm', prompt: `${this.name(h)}: ${p.Description || 'apply replacement?'}`, purpose: 'replacement' });
          if (!yes) continue;
        }
        applied.add(key);
        curDest = nd;
        if (parsed.p.LibraryPosition === '-1') opts.pos = 'bottom';
        continue;
      }
      // anything else replaces the event: run it instead
      applied.add(key);
      const sa = new SA(this, { raw: withRaw, parsed, svars: r.svars, src: h, key: r.key }, h, you, { trig: { Card: card, CardLKI: from === 'battlefield' ? this.makeLKI(card) : null } });
      await this.resolveSAChain(sa);
      return null;
    }
    opts.appliedRepl = applied;
    return curDest;
  }

  async applyETB(card, opts) {
    const etbStart = this.uid;
    const ch = this.chars(card);
    // keyword-based ETB modifications
    for (const k of ch.keywords) {
      let m;
      if ((m = k.match(/^etbCounter:(\w+):([^:]+)(?::(.*))?$/))) {
        const ctx = { host: card, you: card.controller, svars: ch.svars, sa: { svars: ch.svars, host: card, controller: card.controller, root() { return { x: card.xPaid || 0, paid: {} }; } } };
        let cond = true;
        if (m[3] && /^Adamant|^ValidCard|^CheckSVar/.test(m[3])) cond = true;
        if (cond) { const n = calcCtx(this, m[2], ctx); if (n > 0) await this.addCounters(card, m[1], n, null, { etb: true }); }
      }
    }
    if (ch.types.has('Planeswalker') && ch.loyalty != null) {
      const ctx = { host: card, you: card.controller, svars: ch.svars };
      let n = /^\d+$/.test(ch.loyalty) ? +ch.loyalty : calcCtx(this, ch.loyalty, ctx);
      // compleated: two fewer loyalty counters for each {P} paid with life
      if (this.hasKeywordIn(ch, 'Compleated') && card.castSA && card.castSA.phyrexianLife) n = Math.max(0, n - 2 * card.castSA.phyrexianLife);
      card.enteringPW = true;
      await this.addCounters(card, 'LOYALTY', n, null, { etb: true });
      card.enteringPW = false;
    }
    if (ch.types.has('Battle') && card.faceDef.defense) await this.addCounters(card, 'DEFENSE', +card.faceDef.defense || 0, null, { etb: true });
    if (this.hasKeywordIn(ch, 'Ravenous') && card.xPaid) await this.addCounters(card, 'P1P1', card.xPaid, null, { etb: true });
    if (card.castSA && card.castSA.chorusCounters) await this.addCounters(card, 'P1P1', card.castSA.chorusCounters, null, { etb: true });
    if (this.hasKeywordIn(ch, 'Unleash') && await this.ask(card.controller, { type: 'confirm', prompt: `Unleash: have ${this.name(card)} enter with a +1/+1 counter? (It can't block while it has one.)`, purpose: 'unleash', cardId: card.id })) await this.addCounters(card, 'P1P1', 1, null, { etb: true });
    if (this.hasKeywordIn(ch, 'Start your engines') && !(this.players[card.controller].speed > 0)) { this.players[card.controller].speed = 1; this.log(`${this.players[card.controller].name}'s speed is 1.`); }
    if (card.castSA && card.castSA.altCost === 'Impending') { const k = ch.keywords.find(x => /^Impending:/.test(x)); if (k) { card.impending = true; await this.addCounters(card, 'TIME', +k.split(':')[1] || 1, null, { etb: true }); } }
    // daybound: it becomes day if it's neither; at night it enters transformed
    if (card.def.faces.length > 1 && card.def.faces[0].keywords.includes('Daybound') && !card.faceDown) {
      if (!this.dayNight) this.setDayNight('Day');
      else if (this.dayNight === 'Night' && card.face === 0) { card.face = 1; card.transformed = true; this.touch(); }
    }
    // vanishing N: enters with N time counters; bloodthirst N: +1/+1 counters if an opponent was dealt damage this turn
    for (const k of ch.keywords) {
      let m;
      if ((m = k.match(/^Vanishing:(\d+)$/))) await this.addCounters(card, 'TIME', +m[1], null, { etb: true });
      if ((m = k.match(/^Bloodthirst:(\d+)$/)) && this.opponents(card.controller).some(o => this.turnState.damagedPlayers[o.id] > 0)) await this.addCounters(card, 'P1P1', +m[1], null, { etb: true });
    }
    // graft N: enters with N +1/+1 counters
    for (const k of ch.keywords) { const m = k.match(/^Graft:(\d+)$/); if (m) await this.addCounters(card, 'P1P1', +m[1], null, { etb: true }); }
    // sunburst: a +1/+1 (creature) or charge counter for each color of mana spent to cast it
    if (this.hasKeywordIn(ch, 'Sunburst') && opts.cast) {
      const n = COLORS.filter(c => (card.manaSpent || {})[c] > 0).length;
      if (n > 0) await this.addCounters(card, ch.types.has('Creature') ? 'P1P1' : 'CHARGE', n, null, { etb: true });
    }
    for (const k of ch.keywords) {
      let m;
      if ((m = k.match(/^ETBReplacement:(\w+):(\w+)(?::(.*))?$/))) {
        const raw = ch.svars[m[2]];
        if (!raw) continue;
        const [, zoneP, validP] = (m[3] || '').split(':');
        if (validP && zoneP) continue; // "other creatures you control enter with ..." (applied below, from the host)
        if (m[3] === 'Optional' || /Optional/.test(m[3] || '')) {
          const yes = await this.ask(card.controller, { type: 'confirm', prompt: `${this.name(card)}: ${parseAbility(raw).p.SpellDescription || 'use this ability as it enters?'}`, purpose: 'etbOptional', cardId: card.id });
          if (!yes) continue;
        }
        await this.runETBMod(card, raw, ch.svars, card);
      }
    }
    for (const mod of opts.etbMods || []) await this.runETBMod(card, mod.raw, mod.svars, mod.host);
    // permanents (or cards in other zones) whose keywords say how other cards enter
    for (const h of [...this.battlefield, ...this.players.flatMap(pl => pl.graveyard)]) {
      if (h === card || h.phasedOut) continue;
      const hk = h.zone === 'battlefield' ? this.chars(h).keywords : h.faceDef.keywords;
      for (const k of hk) {
        const m = k.match(/^ETBReplacement:(\w+):(\w+):([^:]*):(\w+):(.+)$/);
        if (!m || (zoneMap[m[4]] || m[4].toLowerCase()) !== h.zone) continue;
        const svars = h.zone === 'battlefield' ? this.chars(h).svars : h.faceDef.svars;
        const raw = svars[m[2]];
        if (!raw || !matchValid(this, card, m[5], { host: h, you: h.zone === 'battlefield' ? h.controller : h.owner })) continue;
        if (m[3] === 'Optional' && !(await this.ask(h.zone === 'battlefield' ? h.controller : h.owner, { type: 'confirm', prompt: `${this.name(h)}: ${parseAbility(raw).p.SpellDescription || 'apply to ' + this.name(card) + '?'}`, purpose: 'etbOptional', cardId: card.id }))) continue;
        await this.runETBMod(card, raw, svars, h);
      }
    }
    // replacement effects created while this permanent was entering (e.g. Spark Double's extra counter)
    for (const e of this.effects.filter(x => x.timestamp >= etbStart)) {
      for (const r of e.effectChars.replacements) {
        const p = r.parsed.p;
        if (p.Event !== 'Moved' || !/Battlefield/.test(p.Destination || '')) continue;
        if (p.ValidCard && !matchValid(this, card, p.ValidCard, { host: e, you: e.controller })) continue;
        const raw = p.ReplaceWith && r.svars[p.ReplaceWith];
        if (raw) await this.runETBMod(card, raw, r.svars, e);
      }
    }
    // saga: first lore counter (read ahead: choose the chapter to start on; earlier chapters don't trigger)
    if (this.chars(card).subtypes.has('Saga') && !this.chars(card).types.has('Creature')) {
      if (this.hasKeyword(card, 'Read ahead')) {
        const chapters = this.keywordArgs(card, 'Chapter')[0];
        const final = chapters ? +chapters[0] : 3;
        const n = final > 1 ? await this.ask(card.controller, { type: 'number', prompt: `Read ahead: start ${this.name(card)} on which chapter?`, min: 1, max: final, purpose: 'readAhead', cardId: card.id }) : 1;
        if (n > 1) { card.counters.LORE = Math.min(final, n) - 1; this.touch(); }
      }
      await this.addCounters(card, 'LORE', 1, null);
    }
    this.touch();
  }

  async runETBMod(card, raw, svars, host) {
    const parsed = parseAbility(raw);
    const sa = new SA(this, { raw, parsed, svars, src: host, key: 'etb' }, host, host.controller != null ? host.controller : card.controller, { trig: { Card: card } });
    for (const s of sa.chain()) { s.etbCard = card; s.hostZcc = null; }
    sa.trig = { ...(sa.trig || {}), Card: card };
    await this.resolveSAChain(sa);
  }

  // ---------------------------------------------------------------- basic actions
  async drawCards(p, n, sa, silent = false) {
    const drawn = [];
    // "if an opponent would draw two or more cards, instead ..."
    if (n >= 2 && this.turnNumber > 0) {
      for (const { h, r, p: rp, ctx } of this.replacementsFor('DrawCards')) {
        const key = h.id + ':' + r.key;
        if (this.activeRepl.has(key)) continue;
        if (rp.ValidPlayer && !matchValid(this, p, rp.ValidPlayer, ctx)) continue;
        const m = (rp.Number || '').match(/^(EQ|NE|LT|LE|GT|GE)(\d+)$/);
        if (m && !compare(n, m[1], +m[2])) continue;
        const raw = rp.ReplaceWith && r.svars[rp.ReplaceWith];
        if (!raw) continue;
        this.log(`${this.name(h)} replaces ${p.name}'s draw.`);
        const s = new SA(this, { raw, parsed: parseAbility(raw), svars: r.svars, src: h, key: r.key }, h, h.controller, { trig: { Affected: p, Player: p.id, Number: n } });
        this.activeRepl.add(key);
        try { await this.resolveSAChain(s); } finally { this.activeRepl.delete(key); }
        return drawn;
      }
    }
    for (let i = 0; i < n; i++) {
      // dredge N: instead of drawing, mill N and return the dredge card from the graveyard to hand
      if (this.turnNumber > 0) {
        const dredgers = p.graveyard.map(c => ({ c, k: c.faceDef.keywords.find(k => /^Dredge:\d+$/.test(k)) })).filter(x => x.k && p.library.length >= +x.k.split(':')[1]);
        if (dredgers.length) {
          const pick = await this.ask(p.id, { type: 'option', prompt: 'You would draw a card. Dredge instead?', options: [{ label: 'Draw a card', value: 0 }, ...dredgers.map(x => ({ label: `Dredge ${x.k.split(':')[1]}: mill ${x.k.split(':')[1]} and return ${this.name(x.c)} to your hand`, value: x.c.id }))], purpose: 'dredge', cards: dredgers.map(x => x.c.id) });
          const d = dredgers.find(x => x.c.id === pick);
          if (d) {
            const nm = +d.k.split(':')[1];
            this.log(`${p.name} dredges ${this.name(d.c)} (mill ${nm}).`);
            await this.mill(p, nm, sa);
            if (d.c.zone === 'graveyard') await this.moveCard(d.c, 'hand', { cause: sa });
            continue;
          }
        }
      }
      // "each opponent can't draw more than one card each turn"
      if (this.activeStatics('CantDraw').some(s => matchValid(this, p, s.p.ValidPlayer || 'Player', s.ctx) && p.cardsDrawnThisTurn >= +(s.p.DrawLimit || 0))) break;
      // draw replacements
      const repl = await this.applySimpleReplacement('Draw', { Affected: p, Player: p.id, TurnDraw: this.turnDrawFor === p.id && i === 0 }, sa);
      if (repl === null) continue;
      if (!p.library.length) { p.drewFromEmpty = true; this.touch(); break; }
      // "you draw cards from the bottom of your library rather than the top"
      const c = this.activeStatics('DrawFromBottom').some(s => matchValid(this, p, s.p.ValidPlayer || 'You', s.ctx)) ? p.library[p.library.length - 1] : p.library[0];
      await this.moveCard(c, 'hand', { silent: true, noReplace: true });
      p.cardsDrawnThisTurn++;
      drawn.push(c);
      this.fire('Drawn', { Card: c, Player: p.id, Number: p.cardsDrawnThisTurn });
      if (p.cardsDrawnThisTurn === 1 && !silent && this.turnNumber > 0) {
        const mk = this.chars(c).keywords.find(k => k.startsWith('Miracle:')); // (printed, or Molecule Man's)
        if (mk) this.pendingMiracle = { card: c, cost: mk.split(':').slice(1).join(':'), pid: p.id };
      }
    }
    if (!silent && drawn.length) this.log(`${p.name} draws ${drawn.length} card${drawn.length > 1 ? 's' : ''}.`, { type: 'draw' });
    this.touch();
    return drawn;
  }

  async applySimpleReplacement(event, rp, sa) {
    for (const h of [...this.battlefield, ...this.effects]) {
      const ch = h.isEffect ? h.effectChars : this.chars(h);
      for (const r of ch.replacements) {
        const p = r.parsed.p;
        if (p.Event !== event) continue;
        const you = h.controller;
        const ctx = { host: h, you, svars: r.svars, trig: rp };
        if (p.ValidPlayer && !(rp.Affected && matchValid(this, rp.Affected, p.ValidPlayer, ctx))) continue;
        if (p.ValidCard && !(rp.Card && matchValid(this, rp.Card, p.ValidCard, ctx))) continue;
        if (p.NotFirstCardInDrawStep === 'True' && rp.TurnDraw) continue; // Notion Thief leaves the draw-step draw alone
        if (!checkPresence(this, p, ctx)) continue;
        if (rp._applied && rp._applied.has(h.id + r.key)) continue;
        if (this.activeRepl.has(h.id + r.key)) continue;
        if (p.Prevent === 'True' || p.Layer === 'CantHappen') return null;
        const raw = p.ReplaceWith && r.svars[p.ReplaceWith];
        if (!raw) continue;
        if (p.Optional === 'True') {
          const yes = await this.ask(you, { type: 'confirm', prompt: `${this.name(h)}: ${p.Description || 'Apply?'}`, purpose: 'replacement' });
          if (!yes) continue;
        }
        (rp._applied = rp._applied || new Set()).add(h.id + r.key);
        const parsed = parseAbility(raw);
        if (parsed.api === 'ReplaceEffect' || parsed.api === 'ReplaceCounter' || parsed.api === 'ReplaceToken' || parsed.api === 'ReplaceDamage') {
          const ctx2 = { host: h, you, svars: r.svars, trig: rp, sa: { svars: r.svars, host: h, controller: you, trig: rp, root() { return { x: 0, paid: {} }; } } };
          for (let q = parsed, guard = 0; q && guard < 5; guard++) {
            if (q.p.VarName && q.p.VarValue != null) rp[q.p.VarName] = calcCtx(this, q.p.VarValue, ctx2);
            q = q.p.SubAbility && r.svars[q.p.SubAbility] ? parseAbility(r.svars[q.p.SubAbility]) : null;
            if (q && q.api !== 'ReplaceEffect') q = null;
          }
          continue;
        }
        const s = new SA(this, { raw, parsed, svars: r.svars, src: h, key: r.key }, h, you, { trig: rp });
        this.activeRepl.add(h.id + r.key);
        try { await this.resolveSAChain(s); } finally { this.activeRepl.delete(h.id + r.key); }
        return null;
      }
    }
    return rp;
  }

  // "can't lose / can't win" style replacements (Platinum Angel, Abyssal Persecutor)
  cantHappen(event, player, loseReason) {
    for (const h of [...this.battlefield, ...this.effects]) {
      const ch = h.isEffect ? h.effectChars : this.chars(h);
      for (const r of ch.replacements) {
        const p = r.parsed.p;
        if (p.Event !== event || p.Layer !== 'CantHappen') continue;
        const ctx = { host: h, you: h.controller };
        if (p.ValidPlayer && !matchValid(this, player, p.ValidPlayer, ctx)) continue;
        if (p.ValidLoseReason && !p.ValidLoseReason.split(',').includes(loseReason)) continue;
        if (!checkPresence(this, p, ctx)) continue;
        return true;
      }
    }
    return false;
  }

  async discard(card, sa) {
    const p = this.players[card.owner];
    const madness = card.zone === 'hand' ? this.chars(card).keywords.find(k => k.startsWith('Madness:')) : null; // (printed, or Falkenrath Gorger's)
    if (madness) {
      await this.moveCard(card, 'exile', { cause: sa, silent: true });
      this.log(`${p.name} discards ${this.name(card)} (madness).`, { cardId: card.id });
      this.fire('Discarded', { Card: card, Player: p.id, Cause: sa });
      this.pendingMadness = (this.pendingMadness || []).concat([{ card, cost: madness.split(':').slice(1).join(':'), pid: p.id }]);
      return;
    }
    await this.moveCard(card, 'graveyard', { cause: sa, silent: true });
    if (card.zone === 'graveyard') card.discarded = { turn: this.turnNumber, zcc: card.zcc }; // mayhem
    this.log(`${p.name} discards ${this.name(card)}.`, { cardId: card.id });
    this.fire('Discarded', { Card: card, Player: p.id, Cause: sa });
    this.fire('DiscardedAll', { Cards: [card], Player: p.id });
  }

  async mill(p, n, sa) {
    const cards = p.library.slice(0, n);
    this.beginBatch();
    for (const c of cards) { await this.moveCard(c, 'graveyard', { cause: sa, silent: true }); this.fire('Milled', { Card: c, Player: p.id }); }
    await this.endBatch();
    if (cards.length) this.log(`${p.name} mills ${cards.length} card${cards.length > 1 ? 's' : ''}.`);
    if (cards.length) this.fire('MilledAll', { Cards: cards, Player: p.id, Amount: cards.length });
    if (cards.length) this.fire('MilledOnce', { Cards: cards, Player: p.id, Amount: cards.length });
    return cards;
  }

  shuffle(p, sa = null) {
    this.rng.shuffle(p.library); this.touch();
    if (sa && sa.controller === p.id) this.fire('Shuffled', { Player: p.id, Cause: sa });
  }

  async destroy(card, sa, opts = {}) {
    if (!card || card.zone !== 'battlefield') return false;
    if (this.hasKeyword(card, 'Indestructible')) return false;
    if (card.regenShields > 0 && !opts.noRegen) {
      card.regenShields--; card.tapped = true; card.damage = 0; card.deathtouchHit = false;
      if (this.combat) { this.combat.attackers = this.combat.attackers.filter(a => a.card !== card.id); this.combat.blockers.delete(card.id); }
      this.log(`${this.name(card)} regenerates.`);
      this.touch();
      return false;
    }
    // totem armor / umbra armor
    const umbra = this.attachmentsOf(card).find(a => this.hasKeyword(a, 'Umbra armor') || this.hasKeyword(a, 'Totem armor'));
    if (umbra) {
      card.damage = 0; card.deathtouchHit = false;
      await this.moveCard(umbra, 'graveyard');
      return false;
    }
    const lki = this.makeLKI(card);
    await this.moveCard(card, 'graveyard', { cause: sa });
    this.fire('Destroyed', { Card: card, CardLKI: lki, Cause: sa });
    return true;
  }

  // Space sculptor: while one is on the battlefield, each creature's controller assigns it to a sector
  async assignSectors() {
    if (!this.battlefield.some(c => !c.phasedOut && this.hasKeyword(c, 'Space sculptor'))) return;
    const SECTORS = ['Alpha', 'Beta', 'Gamma'];
    for (const c of [...this.battlefield]) {
      if (c.sector || c.phasedOut || c.zone !== 'battlefield' || !this.chars(c).types.has('Creature')) continue;
      const v = await this.ask(c.controller, { type: 'option', prompt: `Space sculptor: assign ${this.name(c)} to a sector`, options: SECTORS.map(x => ({ label: x, value: x })), purpose: 'sector', cardId: c.id });
      c.sector = SECTORS.includes(v) ? v : 'Alpha';
      this.log(`${this.name(c)} is assigned to the ${c.sector.toLowerCase()} sector.`);
      this.touch();
    }
  }

  // "can't be sacrificed" / "can't cause you to sacrifice or exile" statics
  cantByStatic(mode, card, sa, forCost = false) {
    return this.activeStatics(mode).some(s => {
      if (!matchValid(this, card, s.p.ValidCard || 'Card', s.ctx)) return false;
      if (s.p.ForCost === 'False' && forCost) return false;
      if (s.p.ValidCause) {
        if (!sa) return false;
        const root = sa.root ? sa.root() : sa;
        if (/^Triggered/.test(s.p.ValidCause) && !(sa.isTrigger || root.isTrigger)) return false;
        if (/YouCtrl/.test(s.p.ValidCause) && sa.controller !== s.ctx.you) return false;
      }
      return true;
    });
  }
  cantSacrifice(card, sa, forCost = false) { return this.cantByStatic('CantSacrifice', card, sa, forCost); }

  async sacrifice(card, sa) {
    if (!card || card.zone !== 'battlefield') return false;
    if (this.cantSacrifice(card, sa, !!(sa && sa.payingCost))) return false;
    const lki = this.makeLKI(card);
    const ctrl = card.controller;
    await this.moveCard(card, 'graveyard', { cause: sa, silent: true });
    this.log(`${this.players[ctrl].name} sacrifices ${lki.chars.name || 'a card'}.`, { cardId: card.id });
    this.fire('Sacrificed', { Card: card, CardLKI: lki, Player: ctrl, Cause: sa });
    return true;
  }

  async tap(card, sa, forMana = false) {
    if (card.tapped) return false;
    card.tapped = true;
    this.touch();
    this.fire('Taps', { Card: card, Attacker: null, Player: card.controller });
    return true;
  }
  async untap(card) {
    if (!card.tapped) return false;
    if (this.step !== 'untap' && await paramUntapPrevented(this, card, null)) return false; // "can't become untapped"
    // stun counters: "if it would become untapped, instead remove a stun counter from it"
    if ((card.counters.STUN || 0) > 0) {
      const r = await this.removeCounters(card, 'STUN', 1);
      this.log(r ? `${this.name(card)} stays tapped and loses a stun counter.` : `${this.name(card)} stays tapped (stunned).`);
      return false;
    }
    card.tapped = false;
    // effects and control changes that last "for as long as CARDNAME remains tapped"
    for (const c of this.battlefield) if (c.tempControl && c.tempControl.untilUntapOf === card.id) { c.controller = c.tempControl.prev; c.tempControl = null; c.sick = true; }
    if (this.effects.some(e => e.endsWhenHostUntaps === card.id)) this.effects = this.effects.filter(e => e.endsWhenHostUntaps !== card.id);
    this.touch();
    this.fire('Untaps', { Card: card });
    return true;
  }

  // during the untap step: Untap replacements on any permanent or effect (mech-params.js)
  async untapPrevented(c) { return paramUntapPrevented(this, c, this.activePlayer); }

  lifeLocked(p) { return this.activeStatics('CantChangeLife').some(s => matchValid(this, p, s.p.ValidPlayer || 'You', s.ctx)); }

  async gainLife(p, n, sa) {
    if (n <= 0 || p.lost) return 0;
    if (this.lifeLocked(p)) return 0;
    if (this.activeStatics('CantGainLife').some(s => matchValid(this, p, s.p.ValidPlayer || 'You', s.ctx))) return 0;
    const rp = await this.applySimpleReplacement('GainLife', { Affected: p, Player: p.id, LifeGained: n, Source: sa ? sa.host : null }, sa);
    if (rp === null) return 0;
    n = rp.LifeGained;
    p.life += n;
    p.lifeGainedThisTurn += n;
    this.touch();
    this.log(`${p.name} gains ${n} life.`, { type: 'life' });
    this.fire('LifeGained', { Player: p.id, LifeAmount: n, Source: sa ? sa.host : null });
    return n;
  }

  async loseLife(p, n, sa, fromDamage = false) {
    if (n <= 0 || p.lost) return 0;
    if (this.lifeLocked(p)) return 0;
    if (this.activeStatics('CantLoseLife').some(s => matchValid(this, p, s.p.ValidPlayer || 'You', s.ctx))) return 0;
    p.life -= n;
    p.lifeLostThisTurn += n;
    // start your engines!: speed rises once each of your turns when an opponent loses life
    const act = this.players[this.activePlayer];
    if (act && act.speed > 0 && act.speed < 4 && this.isOpponent(p.id, act.id) && this.turnState.speedUp !== act.id) { act.speed++; this.turnState.speedUp = act.id; this.log(`${act.name}'s speed increases to ${act.speed}.`); }
    this.touch();
    if (!fromDamage) this.log(`${p.name} loses ${n} life.`, { type: 'life' });
    this.fire('LifeLost', { Player: p.id, LifeAmount: n, Source: sa ? sa.host : null });
    this.fire('LifeLostAll', { Player: p.id, LifeAmount: n });
    return n;
  }

  // Deal damage. source: card (or LKI). target: card or player.
  async dealDamage(source, target, amount, opts = {}) {
    if (amount <= 0 || !target) return 0;
    if (target.isPlayer && target.lost) return 0;
    if (target.isCard && target.zone !== 'battlefield') return 0;
    const srcCh = source ? this.chars(source.lki ? source : source) : null;
    const srcCtrl = source ? (source.lki ? source.controller : source.controller) : null;
    // protection / prevention
    const canPrevent = !this.activeStatics('CantPreventDamage').length;
    const prevent = () => { this.notePrevented(source, target, amount, !!opts.combat); return 0; };
    if (canPrevent) {
      if (target.isCard && source && this.hasProtectionFrom(target, source)) return prevent();
      if (target.isPlayer && this.playerProtectedFrom(target, source)) return prevent();
      if (target.isCard && this.preventsDamage(this.chars(target), 'to', !!opts.combat)) return prevent();
      if (srcCh && this.preventsDamage(srcCh, 'by', !!opts.combat)) return prevent();
    }
    // "prevent the next N damage that would be dealt to it this turn"
    if (canPrevent && this.shields && this.shields.length) {
      for (const sh of this.shields) {
        if (sh.turn !== this.turnNumber || sh.amount <= 0) continue;
        if (target.isPlayer ? sh.player !== target.id : (sh.card !== target.id || sh.zcc !== target.zcc)) continue;
        const n = Math.min(sh.amount, amount);
        sh.amount -= n; amount -= n;
        this.notePrevented(source, target, n, !!opts.combat);
        if (amount <= 0) return 0;
      }
      this.shields = this.shields.filter(sh => sh.amount > 0 && sh.turn === this.turnNumber);
    }
    let rp = { Affected: target, Source: source, DamageSource: source, DamageAmount: amount, IsCombat: !!opts.combat, _applied: opts.redirectApplied };
    const prevented = await this.applyDamageReplacements(rp);
    { const red = await dealRedirected(this, source, rp, opts); if (red != null) return red; } // dealt to another object instead (mech-params.js)
    if (prevented === null) { if (rp.prevented) this.notePrevented(source, target, amount, !!opts.combat); return 0; }
    if (rp.preventedAmount > 0) this.notePrevented(source, target, rp.preventedAmount, !!opts.combat);
    amount = rp.DamageAmount;
    if (amount <= 0) return 0;
    const infect = srcCh && this.hasKeywordIn(srcCh, 'Infect');
    const wither = srcCh && (this.hasKeywordIn(srcCh, 'Wither') || this.activeStatics('WitherDamage').some(s => !s.p.ValidCard || (source && matchValid(this, source, s.p.ValidCard, s.ctx))));
    const deathtouch = srcCh && this.hasKeywordIn(srcCh, 'Deathtouch');
    const lifelink = srcCh && this.hasKeywordIn(srcCh, 'Lifelink');
    if (target.isPlayer) {
      // "as long as you're the monarch, damage doesn't cause you to lose life"
      const noLoss = this.replacementsFor('LifeReduced').some(({ p, ctx }) => p.Layer === 'CantHappen' && p.IsDamage === 'True' && (p.Monarch !== 'True' || this.monarch === target.id) && (!p.ValidPlayer || matchValid(this, target, p.ValidPlayer, ctx)));
      if (infect) await this.addCounters(target, 'POISON', amount, null);
      else if (!noLoss) await this.loseLife(target, amount, null, true);
      this.turnState.damagedPlayers[target.id] = (this.turnState.damagedPlayers[target.id] || 0) + amount;
      if (opts.combat) {
        this.turnState.combatDamagedPlayers[target.id] = true;
        if (source) { const list = (this.turnState.combatDamageSources[target.id] = this.turnState.combatDamageSources[target.id] || []); const sc = source.lki ? source.card : source; if (sc && !list.some(x => x.id === sc.id)) list.push(source.lki ? source : this.makeLKI(sc)); }
        // prowl: remember the creature types that dealt combat damage to a player this turn
        if (srcCh && srcCh.types.has('Creature') && srcCtrl != null) { const pr = (this.turnState.prowl = this.turnState.prowl || {}); (pr[srcCtrl] = pr[srcCtrl] || []).push({ types: [...srcCh.subtypes], all: !!srcCh.allCreatureTypes }); }
        const srcCard = source && (source.lki ? source.card : source);
        if (srcCard && srcCard.isCommander) target.commanderDamage[srcCard.id] = (target.commanderDamage[srcCard.id] || 0) + amount;
        const toxic = srcCh ? srcCh.keywords.filter(k => k.startsWith('Toxic:')).reduce((a, k) => a + (+k.split(':')[1] || 0), 0) : 0;
        if (toxic) await this.addCounters(target, 'POISON', toxic, null);
      }
      this.log(`${source ? this.name(source) : 'Damage'} deals ${amount} damage to ${target.name}.`, { type: 'damage' });
    } else {
      const tch = this.chars(target);
      if (tch.types.has('Planeswalker') && !tch.types.has('Creature')) {
        await this.removeCounters(target, 'LOYALTY', amount);
      } else if (tch.types.has('Battle') && !tch.types.has('Creature')) {
        await this.removeCounters(target, 'DEFENSE', amount);
      } else {
        if (infect || wither) await this.addCounters(target, 'M1M1', amount, null);
        else target.damage += amount;
        if (deathtouch) target.deathtouchHit = true;
        if (tch.types.has('Planeswalker')) await this.removeCounters(target, 'LOYALTY', amount);
      }
      this.turnState.damagedCards[target.id] = true;
      this.log(`${source ? this.name(source) : 'Damage'} deals ${amount} damage to ${this.name(target)}.`, { type: 'damage' });
    }
    if (source) this.turnState.dealtDamage[source.id] = true;
    // what dealt damage to what this turn ("if it dealt damage to an opponent this turn")
    this.turnState.damageLog.push({ source: source ? source.id : null, controller: srcCtrl, player: target.isPlayer ? target.id : null, card: target.isPlayer ? null : target.id, amount, combat: !!opts.combat });
    // and over the game, for as long as the source stays the same object ("a player it has dealt damage to this game")
    if (source && source.isCard && !source.lki) {
      const h = source.damageHistory || (source.damageHistory = { players: [], combat: false });
      if (target.isPlayer && !h.players.includes(target.id)) h.players.push(target.id);
      if (opts.combat) h.combat = true;
    }
    this.touch();
    if (lifelink && srcCtrl != null) await this.gainLife(this.players[srcCtrl], amount, null);
    const drp = { Source: source, DamageSource: source, Target: target, DamageTarget: target, DamageAmount: amount, IsCombatDamage: !!opts.combat, CombatDamage: !!opts.combat };
    this.fire('DamageDone', drp);
    if (this.damageBatch) this.damageBatch.push(drp);
    else { this.fire('DamageDoneOnce', { ...drp, Sources: [source] }); this.fire('DamageDealtOnce', { ...drp, Targets: [target] }); }
    return amount;
  }

  beginDamageBatch() { this.damageBatch = []; }
  endDamageBatch() {
    const batch = this.damageBatch || [];
    this.damageBatch = null;
    const byTarget = new Map(), bySource = new Map();
    for (const d of batch) {
      const tk = d.Target.isPlayer ? 'p' + d.Target.id : d.Target.id;
      if (!byTarget.has(tk)) byTarget.set(tk, { ...d, DamageAmount: 0, Sources: [] });
      const t = byTarget.get(tk); t.DamageAmount += d.DamageAmount; t.Sources.push(d.Source);
      const sk = d.Source ? d.Source.id : 'none';
      if (!bySource.has(sk)) bySource.set(sk, { ...d, DamageAmount: 0, Targets: [] });
      const s = bySource.get(sk); s.DamageAmount += d.DamageAmount; s.Targets.push(d.Target);
    }
    for (const t of byTarget.values()) this.fire('DamageDoneOnce', t);
    for (const s of bySource.values()) this.fire('DamageDealtOnce', s);
    if (batch.length) this.fire('DamageAll', { Amount: batch.reduce((a, d) => a + d.DamageAmount, 0), IsCombatDamage: batch[0].IsCombatDamage });
    const prevented = this.preventBatch || [];
    this.preventBatch = null;
    const byPrevTarget = new Map();
    for (const d of prevented) {
      const tk = d.Target.isPlayer ? 'p' + d.Target.id : d.Target.id;
      if (!byPrevTarget.has(tk)) byPrevTarget.set(tk, { ...d, DamageAmount: 0, Sources: [] });
      const t = byPrevTarget.get(tk); t.DamageAmount += d.DamageAmount; t.Sources.push(d.Source);
    }
    for (const t of byPrevTarget.values()) this.fire('DamagePreventedOnce', t);
  }

  async applyDamageReplacements(rp) {
    for (const h of [...this.battlefield, ...this.effects]) {
      const ch = h.isEffect ? h.effectChars : this.chars(h);
      for (const r of ch.replacements) {
        const p = r.parsed.p;
        if (p.Event !== 'DamageDone') continue;
        const you = h.controller;
        const ctx = { host: h, you, svars: r.svars, trig: rp, sa: { svars: r.svars, host: h, controller: you, trig: rp, root() { return { x: 0, paid: {} }; } } };
        if (p.ValidTarget && !matchValid(this, rp.Affected, p.ValidTarget, ctx)) continue;
        if (p.ValidSource && !(rp.Source && matchValid(this, rp.Source, p.ValidSource, ctx))) continue;
        if (p.IsCombat === 'True' && !rp.IsCombat) continue;
        if (p.IsCombat === 'False' && rp.IsCombat) continue;
        if (!checkPresence(this, p, ctx)) continue;
        if (rp._applied && rp._applied.has(h.id + r.key)) continue;
        (rp._applied = rp._applied || new Set()).add(h.id + r.key);
        if (p.Prevent === 'True' || p.PreventionEffect === 'True' && !p.ReplaceWith) {
          if (this.activeStatics('CantPreventDamage').length) continue;
          rp.prevented = true;
          return null;
        }
        const raw = p.ReplaceWith && r.svars[p.ReplaceWith];
        if (!raw) continue;
        const parsed = parseAbility(raw);
        const red = damageRedirect(this, h, r, p, parsed, ctx, rp); // Pariah, Harm's Way (mech-params.js)
        if (red === 'skip') continue;
        if (red === 'redirect') return rp;
        if (parsed.api === 'ReplaceDamage' || parsed.api === 'ReplaceEffect') {
          if (p.PreventionEffect === 'True' && this.activeStatics('CantPreventDamage').length) continue;
          const v = calcCtx(this, parsed.p.Amount || parsed.p.VarValue, ctx);
          if (p.PreventionEffect === 'True' && v < rp.DamageAmount) rp.preventedAmount = (rp.preventedAmount || 0) + rp.DamageAmount - Math.max(0, v);
          rp.DamageAmount = Math.max(0, v);
          if (parsed.p.VarName && parsed.p.VarName !== 'DamageAmount') { /* other vars ignored */ }
          if (rp.DamageAmount <= 0) return null;
          continue;
        }
        if (p.PreventionEffect === 'True' && parsed.api !== 'ReplaceSplitDamage') {
          // "prevent that damage and [do something else instead]"
          if (this.activeStatics('CantPreventDamage').length) continue;
          rp.prevented = true;
          const s = new SA(this, { raw, parsed, svars: r.svars, src: h, key: r.key }, h, you, { trig: rp });
          await this.resolveSAChain(s);
          return null;
        }
      }
    }
    return rp;
  }

  // keyword prevention: "Prevent all [combat] damage that would be dealt to [and dealt by] CARDNAME." (Fog Bank, Guard Gomazoa)
  preventsDamage(ch, dir, combat) {
    for (const k of ch.keywords) {
      const m = k.match(/^(?:HIDDEN )?Prevent all (combat )?damage that would be dealt (to and dealt by|to|by) CARDNAME\.$/);
      if (!m || (m[1] && !combat)) continue;
      if (m[2] === 'to and dealt by' || m[2] === dir) return true;
    }
    return false;
  }

  // protection a player has from a damage source ("Protection from everything", protection from a player)
  playerProtectedFrom(pl, source) {
    for (const k of this.playerChars(pl.id).keywords) {
      if (k === 'Protection from everything') return true;
      if (source && this.protectionFromPlayerKw(k, source)) return true;
    }
    return false;
  }

  // "Protection:Player.PlayerUID_<id>:<name>": protection from everything that player controls
  protectionFromPlayerKw(k, source) {
    const m = k.match(/^Protection:Player\.(OpponentOf )?PlayerUID_(\d+)/);
    if (!m) return false;
    const ctrl = source.isPlayer ? source.id : source.stackItem ? source.controller : ctrlOf(this, source);
    return m[1] ? ctrl !== +m[2] : ctrl === +m[2];
  }

  setDayNight(v) {
    if (this.dayNight === v) return;
    this.dayNight = v;
    this.log(`It becomes ${v.toLowerCase()}.`);
    for (const c of this.battlefield) {
      const f = c.def.faces;
      if (f.length < 2 || c.faceDown) continue;
      const toBack = v === 'Night' && c.face === 0 && f[0].keywords.includes('Daybound');
      const toFront = v === 'Day' && c.face === 1 && f[1].keywords.includes('Nightbound');
      if (!toBack && !toFront) continue;
      c.face = toBack ? 1 : 0; c.transformed = toBack;
      this.log(`${this.name(c)} transforms.`);
      this.fire('Transformed', { Card: c });
    }
    this.fire('DayTimeChanges', { DayTime: v });
    this.touch();
  }

  // soulbond partner, if still paired (both on the battlefield, same controller, both creatures)
  pairedPartner(c) {
    if (!c || c.pairedWith == null) return null;
    const p = this.cardById(c.pairedWith);
    if (!p || p.zone !== 'battlefield' || p.controller !== c.controller || p.pairedWith !== c.id || !this.chars(p).types.has('Creature') || !this.chars(c).types.has('Creature')) return null;
    return p;
  }

  // Rooms: unlock a door (fires "when you unlock this door" and, once both are open, "fully unlock")
  unlockDoor(card, door, pid) {
    if (!card.unlocked || card.unlocked.includes(door) || card.zone !== 'battlefield') return false;
    card.unlocked = [...card.unlocked, door].sort();
    this.touch();
    this.log(`${this.players[pid].name} unlocks ${card.def.faces[door].name}.`, { cardId: card.id });
    this.fire('UnlockDoor', { Card: card, Player: pid, Door: door });
    if (card.unlocked.length >= card.def.faces.length) this.fire('FullyUnlock', { Card: card, Player: pid });
    return true;
  }

  // record prevented damage for "whenever damage would be dealt to you is prevented" (batched like damage)
  notePrevented(source, target, amount, combat) {
    if (amount <= 0) return;
    const e = { Source: source, DamageSource: source, Target: target, DamageTarget: target, DamageAmount: amount, IsCombatDamage: combat };
    this.fire('DamagePrevented', e);
    if (this.damageBatch) (this.preventBatch = this.preventBatch || []).push(e);
    else this.fire('DamagePreventedOnce', { ...e, Sources: [source] });
  }

  hasProtectionFrom(card, source) {
    const ch = this.chars(card);
    const sch = source.lki ? source.chars : this.chars(source);
    for (const k of ch.keywords) {
      if (!k.startsWith('Protection')) continue;
      if (k === 'Protection from everything') return true;
      if (k.startsWith('Protection:Player.')) { if (this.protectionFromPlayerKw(k, source)) return true; continue; }
      let m = k.match(/^Protection from (white|blue|black|red|green|multicolored|monocolored|colorless)$/i);
      if (m) {
        const col = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' }[m[1].toLowerCase()];
        if (col && sch.colors.has(col)) return true;
        if (/multicolored/i.test(m[1]) && sch.colors.size > 1) return true;
        if (/colorless/i.test(m[1]) && sch.colors.size === 0) return true;
        continue;
      }
      m = k.match(/^Protection from (creatures|artifacts|enchantments|planeswalkers|instants|sorceries)$/i);
      if (m) { const t = { creatures: 'Creature', artifacts: 'Artifact', enchantments: 'Enchantment', planeswalkers: 'Planeswalker', instants: 'Instant', sorceries: 'Sorcery' }[m[1].toLowerCase()]; if (sch.types.has(t)) return true; continue; }
      m = k.match(/^Protection:([^:]+)/);
      if (m) {
        const ctx = { host: card, you: card.controller };
        if (m[1] === 'ChosenColor' && card.chosen && card.chosen.colors) { if (card.chosen.colors.some(c => sch.colors.has(c))) return true; continue; }
        if (matchValid(this, source, m[1], ctx)) return true;
      }
      m = k.match(/^Protection from (\w+)$/);
      if (m && sch.subtypes.has(m[1].replace(/s$/, ''))) return true;
    }
    return false;
  }

  async addCounters(obj, type, n, sa, opts = {}) {
    if (n <= 0 || !obj) return 0;
    type = normalizeCounter(type);
    if (obj.isCard && obj.zone !== 'battlefield' && obj.zone !== 'exile' && !opts.anyZone) return 0;
    if (obj.isCard && this.activeStatics('CantPutCounter').some(s => matchValid(this, obj, s.p.ValidCard || 'Card', s.ctx))) return 0;
    // counter replacement effects (doublers, +1 extra)
    let rp = { Affected: obj, Card: obj.isCard ? obj : null, Player: obj.isPlayer ? obj.id : null, CounterType: type, CounterNum: n, Source: sa ? sa.host : null, ETB: !!opts.etb };
    for (const h of [...this.battlefield, ...this.effects]) {
      const ch = h.isEffect ? h.effectChars : this.chars(h);
      for (const r of ch.replacements) {
        const p = r.parsed.p;
        if (p.Event !== 'AddCounter') continue;
        const you = h.controller;
        const ctx = { host: h, you, svars: r.svars, trig: rp, sa: { svars: r.svars, host: h, controller: you, trig: rp, root() { return { x: 0, paid: {} }; } } };
        if (p.ValidCard && !(obj.isCard && matchValid(this, obj, p.ValidCard.replace('+inZoneBattlefield', ''), ctx))) continue;
        if (p.ValidPlayer && !(obj.isPlayer && matchValid(this, obj, p.ValidPlayer, ctx))) continue;
        if (p.ValidObject && !matchValid(this, obj, p.ValidObject, ctx)) continue;
        if (p.ValidCounterType && !p.ValidCounterType.split(',').map(normalizeCounter).includes(type)) continue;
        if (p.ValidSource && !(rp.Source && matchValid(this, rp.Source, p.ValidSource, ctx))) continue;
        if (!checkPresence(this, p, ctx)) continue;
        if (p.ETB === 'True' && !opts.etb) continue;
        const raw = p.ReplaceWith && r.svars[p.ReplaceWith];
        if (!raw) continue;
        const parsed = parseAbility(raw);
        if (parsed.api === 'ReplaceCounter' || parsed.api === 'ReplaceEffect') {
          if (parsed.p.ValidCounterType && !parsed.p.ValidCounterType.split(',').map(normalizeCounter).includes(type)) continue;
          const amt = parsed.p.Amount || parsed.p.VarValue;
          rp.CounterNum = amt ? calcCtx(this, amt, ctx) : rp.CounterNum * 2;
          ctx.trig = rp;
        }
      }
    }
    n = rp.CounterNum;
    if (n <= 0) return 0;
    const before = obj.counters[type] || 0;
    obj.counters[type] = before + n;
    this.touch();
    if (!opts.silent && !(opts.etb && type === 'LOYALTY')) this.log(`${this.name(obj)} gets ${n} ${counterName(type)} counter${n > 1 ? 's' : ''}.`, { type: 'counter' });
    const cap = Math.min(n, 30);
    for (let i = 0; i < cap; i++) this.fire('CounterAdded', { Card: obj.isCard ? obj : null, Player: obj.isPlayer ? obj.id : null, Valid: obj, CounterType: type, CounterAmount: 1, Source: sa ? sa.host : null, Previous: before + i });
    this.fire('CounterAddedOnce', { Card: obj.isCard ? obj : null, Player: obj.isPlayer ? obj.id : null, CounterType: type, Amount: n, CounterAmount: n, Source: sa ? sa.host : null, Previous: before });
    this.fire('CounterTypeAddedAll', { Object: obj, Card: obj.isCard ? obj : null, Player: obj.isPlayer ? obj.id : null, CounterType: type, Amount: n });
    // saga chapters
    if (type === 'LORE' && obj.isCard) await this.sagaChapters(obj, before, before + n);
    return n;
  }

  async removeCounters(obj, type, n) {
    type = normalizeCounter(type);
    const have = obj.counters[type] || 0;
    const r = Math.min(have, n);
    if (r <= 0) return 0;
    // "stun counters can't be removed from permanents your opponents control"
    if (obj.isCard && this.replacementsFor('RemoveCounter').some(({ p, ctx }) => p.Layer === 'CantHappen' && (!p.ValidCard || matchValid(this, obj, p.ValidCard, ctx)) && (!p.ValidCounterType || p.ValidCounterType.split(',').map(normalizeCounter).includes(type)))) return 0;
    obj.counters[type] = have - r;
    this.touch();
    this.fire('CounterRemoved', { Card: obj.isCard ? obj : null, CounterType: type, Amount: r, NewCounterAmount: obj.counters[type] });
    this.fire('CounterRemovedOnce', { Card: obj.isCard ? obj : null, Player: obj.isPlayer ? obj.id : null, CounterType: type, Amount: r });
    return r;
  }

  async sagaChapters(card, before, after) {
    const ch = this.chars(card);
    const k = ch.keywords.find(x => x.startsWith('Chapter:'));
    if (!k) return;
    const parts = k.split(':');
    const svarNames = (parts[2] || '').split(',');
    for (let i = before + 1; i <= after; i++) {
      const name = svarNames[i - 1];
      if (!name) continue;
      const raw = ch.svars[name];
      if (!raw) continue;
      this.pendingTriggers.push({ host: card, t: { parsed: { p: { Execute: name, TriggerDescription: `Chapter ${['', 'I', 'II', 'III', 'IV', 'V', 'VI'][i] || i}: ${parseAbility(raw).p.SpellDescription || ''}` } }, svars: ch.svars, key: 'chapter' + i }, rp: { Card: card }, controller: card.controller, chapter: true });
    }
  }

  async createToken(def, controller, sa, opts = {}) {
    const c = this.newCard(def, controller);
    c.token = true;
    c.zone = 'none';
    if (opts.copyOf) c.copyOf = opts.copyOf;
    await this.moveCard(c, 'battlefield', { controller, tapped: opts.tapped, silent: true, cause: sa });
    if (opts.attacking != null && this.combat) {
      this.combat.attackers.push({ card: c.id, defenderPlayer: opts.attacking, defenderCard: null, blockers: [], blocked: false });
    }
    this.fire('TokenCreated', { Card: c, Player: controller });
    return c;
  }

  noteTokenBatch(pid) { this.turnState.tokenBatches[pid] = (this.turnState.tokenBatches[pid] || 0) + 1;
  }
}

// Answers from any seat (a person, the AI, a peer online) are held to the prompt: only offered choices,
// no duplicates, within min/max (padded with the first offered choices when short), a cancel only where
// the prompt allows one. Deterministic, so every peer reaches the same answer.
export function sanitizeAnswer(req, ans) {
  const pad = (picked, offered, min, max) => {
    const out = [];
    for (const x of Array.isArray(picked) ? picked : []) if (offered.includes(x) && !out.includes(x)) out.push(x);
    out.splice(Math.max(0, max));
    for (const x of offered) { if (out.length >= Math.min(min, offered.length)) break; if (!out.includes(x)) out.push(x); }
    return out;
  };
  switch (req.type) {
    case 'cards': if (ans == null && req.cancellable) return null; return pad(ans, req.cards || [], req.min || 0, req.max ?? (req.cards || []).length);
    case 'targets': if (ans == null && req.cancellable) return null; return pad(ans, req.cands || [], req.min || 0, req.max ?? (req.cands || []).length);
    case 'option': {
      if (ans == null && req.cancellable) return null;
      const opts = req.options || [];
      return opts.some(o => o.value === ans) ? ans : (opts[0] ? opts[0].value : null);
    }
    case 'modes': {
      if (ans == null && req.cancellable) return null;
      const vals = (req.options || []).map(o => o.value);
      let out = (Array.isArray(ans) ? ans : []).filter(v => vals.includes(v));
      if (!req.repeat) out = out.filter((v, i) => out.indexOf(v) === i);
      out = out.slice(0, req.max ?? out.length);
      for (const v of vals) { if (out.length >= (req.min || 0)) break; if (req.repeat || !out.includes(v)) out.push(v); }
      return out;
    }
    case 'number': {
      if (ans == null && req.cancellable) return null;
      const lo = req.min ?? 0, hi = req.max ?? lo;
      const n = Math.floor(Number(ans));
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo;
    }
    case 'color': if (ans == null && req.cancellable) return null; return (req.colors || []).includes(ans) ? ans : (req.colors || [])[0] ?? null;
    case 'player': if (ans == null && req.cancellable) return null; return (req.players || []).includes(ans) ? ans : (req.players || [])[0] ?? null;
    case 'confirm': if (ans == null && req.cancellable) return null; return !!ans;
    case 'mulligan': return ans !== false;
    case 'priority': return ans && typeof ans === 'object' && typeof ans.type === 'string' ? ans : { type: 'pass' };
    case 'attackers': case 'blockers': return Array.isArray(ans) ? ans : [];
    default: return ans;
  }
}

export function normalizeCounter(t) {
  if (!t) return 'P1P1';
  const u = String(t).trim();
  const map = { '+1/+1': 'P1P1', '-1/-1': 'M1M1', 'Loyalty': 'LOYALTY', 'loyalty': 'LOYALTY', 'POISON': 'POISON', 'Poison': 'POISON' };
  return map[u] || u.toUpperCase().replace(/[^A-Z0-9_]/g, '') || 'P1P1';
}

export function counterName(t) {
  if (t === 'P1P1') return '+1/+1';
  if (t === 'M1M1') return '-1/-1';
  const m = t.match(/^([PM])(\d)([PM])(\d)$/);
  if (m) return `${m[1] === 'P' ? '+' : '-'}${m[2]}/${m[3] === 'P' ? '+' : '-'}${m[4]}`;
  const named = { FIRSTSTRIKE: 'first strike', DOUBLESTRIKE: 'double strike', LOYALTY: 'loyalty', DEFENSE: 'defense' };
  return named[t] || t.toLowerCase();
}

function roomName(svars, r) { return (parseAbility(svars[r] || '').p.RoomName) || r; }
function roomText(svars, r) { return (parseAbility(svars[r] || '').p.SpellDescription) || ''; }
