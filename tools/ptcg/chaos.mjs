// A player for headless tests who clicks anything the screen allows, uniformly at random: any main-phase action,
// any number of cards or Pokémon between a question's min and max, any option, yes or no, any spread of damage
// counters. Used by tools/ptcg/invariants.mjs --chaos and tools/ptcg/nettest.mjs (CHAOS=1).

// a seeded generator of its own: chaos players never touch the game's RNG (the same seed replays the same game)
export function mulberry32(a) {
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// a player who clicks anything the screen allows, uniformly at random; with `ai`, a share of the decisions goes to
// the computer player instead (someone who hands over to the AI mid-turn and takes back); `busy` is the chance of
// doing something else when the turn could end or attack (a player who tries every button before moving on)
export class ChaosAgent {
  constructor(seed, { ai = null, aiShare = 0, odd = 0, busy = 0 } = {}) { this.r = mulberry32(seed); this.ai = ai; this.aiShare = aiShare; this.odd = odd; this.busy = busy; }
  int(n) { return Math.floor(this.r() * n); }
  pick(list) { return list[this.int(list.length)]; }
  subset(list, min, max) {
    const k = min + this.int(max - min + 1);
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) { const j = this.int(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
    return a.slice(0, k);
  }
  ask(g, pid, req) {
    if (this.ai && this.r() < this.aiShare) return this.ai.ask(g, pid, req);
    if (this.odd && this.r() < this.odd) return this.oddAnswer(req);
    switch (req.type) {
      case 'main': {
        const other = req.actions.filter(a => a.t !== 'end' && a.t !== 'attack');
        return other.length && this.r() < this.busy ? this.pick(other) : this.pick(req.actions);
      }
      case 'cards': case 'mon': return this.subset(req.options, req.min, req.max);
      case 'option': return this.pick(req.options).value;
      case 'confirm': return this.r() < 0.5;
      case 'distribute': { const plan = {}; for (let i = 0; i < req.total; i++) { const id = this.pick(req.options); plan[id] = (plan[id] || 0) + 1; } return plan; }
    }
    return null;
  }
  // answers the screen can't send: nothing, an empty pick, unknown ids, the same id twice, negative counters
  oddAnswer(req) {
    const k = this.int(4);
    if (k === 0) return null;
    if (k === 1) return req.type === 'main' ? { t: 'attack', mon: -1, name: 'Nothing' } : [];
    if (k === 2) return req.type === 'option' ? '__nope__' : [987654321];
    if (req.type === 'distribute') return { [req.options[0]]: -3 };
    return req.options && req.options.length ? [req.options[0], req.options[0]] : undefined;
  }
}
