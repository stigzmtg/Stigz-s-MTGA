// Bridges engine prompts ("asks") for the human player to the React UI.
import { getActions } from '../engine/abilities.js';

let uid = 1;

export class HumanAgent {
  constructor(onChange, settings) {
    this.onChange = onChange;
    this.settings = settings;
    this.stack = [];
    this.passUntilTurn = null;
    this.passUntilMine = false;
    this.shown = new Set();
  }

  // how long an opponent's stack object stays visible before auto-passing
  showFor(item) {
    const base = { slow: 1500, normal: 950, fast: 500, instant: 0 }[this.settings.aiSpeed] ?? 950;
    if (item.kind === 'spell') return base;
    const targets = item.sa ? item.sa.chain().some(s => (s.targets || []).length) : false;
    return targets ? Math.round(base * 0.6) : 0;
  }

  get pending() { return this.stack.length ? this.stack[this.stack.length - 1] : null; }

  ask(game, pid, req) {
    this.game = game;
    this.pid = pid;
    const auto = this.autoAnswer(game, pid, req);
    if (auto !== undefined) {
      // let opponents' spells sit on the stack for a moment so you can see them (and what they target)
      const top = req.type === 'priority' && game.stack[game.stack.length - 1];
      const wait = top && top.controller !== pid && !this.shown.has(top.id) ? this.showFor(top) : 0;
      if (top) this.shown.add(top.id);
      if (wait > 0) return new Promise(r => setTimeout(() => r(auto), wait));
      return Promise.resolve(auto);
    }
    return new Promise(resolve => {
      this.stack.push({ id: uid++, req, resolve });
      this.onChange();
    });
  }

  respond(value) {
    const p = this.stack.pop();
    if (!p) return;
    p.resolve(value);
    this.onChange();
  }

  // abandon every outstanding prompt (game ended / left)
  cancelAll() {
    const all = this.stack.splice(0);
    for (const p of all) p.resolve(p.req.type === 'priority' ? { type: 'pass' } : null);
  }

  autoAnswer(game, pid, req) {
    const s = this.settings;
    switch (req.type) {
      case 'priority': return this.autoPriority(game, pid) ? { type: 'pass' } : undefined;
      case 'confirm':
        if (req.purpose === 'commanderReturn' && s.autoCommander) return true;
        return undefined;
      case 'cards':
        if (req.cards.length && req.min === req.cards.length && req.max === req.cards.length && !req.reveal) return req.cards.slice();
        if (!req.cards.length) return [];
        return undefined;
      case 'targets':
        if (!req.cands.length) return [];
        return undefined;
      case 'attackers':
        if (this.passUntilTurn === game.turnNumber && s.skipAttacksOnEndTurn) return [];
        return undefined;
      default: return undefined;
    }
  }

  autoPriority(game, pid) {
    const s = this.settings;
    const myTurn = game.activePlayer === pid;
    const top = game.stack[game.stack.length - 1];
    const respondable = () => top && top.controller !== pid && s.stopForOpponentSpells && getActions(game, pid).length;
    if (this.passUntilMine) {
      if (!myTurn) { if (!respondable()) return true; }
      else this.passUntilMine = false;
    }
    if (this.passUntilTurn != null) {
      if (game.turnNumber === this.passUntilTurn) { if (!respondable()) return true; }
      else this.passUntilTurn = null;
    }
    const actions = getActions(game, pid);
    if (!actions.length) return true;
    if (s.fullControl) return false;
    if (top) {
      if (top.controller === pid) return true;
      return false; // opponent's spell or ability and we can respond
    }
    if (myTurn) {
      if (game.step === 'main1' || game.step === 'main2') return false;
      // (after blocks, a spell to sneak in — returning an unblocked attacker — is worth a stop)
      if (game.step === 'declareBlockers' && actions.some(a => /^Sneak:/.test(a.optionKey || ''))) return false;
      if (game.step === 'declareBlockers' || game.step === 'beginCombat') return !s.stopOwnCombat;
      return true;
    }
    if (game.step === 'end') return !s.stopOppEnd;
    // attacked: a window before blocks when there's a spell to cast (flash in a blocker, remove an attacker), and one
    // after blocks (combat tricks)
    const attacked = game.combat && game.combat.attackers.some(a => a.defenderPlayer === pid);
    if (attacked && game.step === 'declareAttackers') return !(s.stopOppCombat && actions.some(a => a.type === 'cast'));
    if (attacked && game.step === 'declareBlockers') return !s.stopOppCombat;
    return true;
  }
}
