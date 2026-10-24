// A player for headless One Piece tests who clicks anything the screen allows, uniformly at random: any Main Phase
// action, any number of cards between a question's min and max, any option or number, yes or no, any blocker or
// counter (or none). Used by tools/optcg/invariants.mjs --chaos and tools/optcg/nettest.mjs (CHAOS=1).

// a seeded generator of its own: chaos players never touch the game's RNG (the same seed replays the same game)
export function mulberry32(a) {
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// with `ai`, a share of the decisions goes to the computer player instead; `busy` is the chance of doing something
// else when the turn could end or attack; `odd` is the share of answers the screen can't send
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
      case 'cards': return this.subset(req.options, req.min, req.max);
      case 'order': return this.subset(req.options, req.options.length, req.options.length);
      case 'option': return this.pick(req.options).value;
      case 'number': return req.min + this.int(req.max - req.min + 1);
      case 'confirm': case 'trigger': case 'mulligan': return this.r() < 0.5;
      case 'blocker': return this.r() < 0.5 ? this.pick(req.options) : null;
      case 'counter': return this.r() < 0.6 ? this.pick(req.options) : null;
    }
    return null;
  }
  // answers the screen can't send: nothing, an empty pick, unknown ids, the same id twice, out-of-range numbers
  oddAnswer(req) {
    const k = this.int(4);
    if (k === 0) return null;
    if (k === 1) return req.type === 'main' ? { t: 'attack', card: -1, target: -2 } : [];
    if (k === 2) return req.type === 'option' ? '__nope__' : req.type === 'number' ? 999 : req.type === 'counter' ? { card: -5, kind: 'counter' } : [987654321];
    return req.options && req.options.length ? [req.options[0], req.options[0]] : req.type === 'number' ? -3 : undefined;
  }
}
