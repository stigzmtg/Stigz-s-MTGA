// Bridges the Pokémon engine's questions for the person at the table to the battle screen.
let uid = 1;
export class PtcgHuman {
  constructor(onChange) { this.onChange = onChange; this.pending = null; }
  ask(game, pid, req) {
    // nothing to decide: one forced choice
    if (req.type === 'mon' && req.options.length === 1 && req.min >= 1) return Promise.resolve([req.options[0]]);
    if (req.type === 'cards' && !req.options.length) return Promise.resolve([]);
    return new Promise(resolve => { this.pending = { id: uid++, pid, req, resolve }; this.onChange(); });
  }
  respond(v) { const p = this.pending; if (!p) return; this.pending = null; p.resolve(v); this.onChange(); }
  cancel() { const p = this.pending; this.pending = null; if (p) p.resolve(p.req.type === 'main' ? { t: 'end' } : null); }
}
