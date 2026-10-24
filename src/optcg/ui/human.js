// Bridges the One Piece engine's questions for the person at the table to the battle screen.
let uid = 1;
export class OpHuman {
  constructor(onChange) { this.onChange = onChange; this.pending = null; }
  ask(game, pid, req) {
    // nothing to decide: no options at all
    if (req.type === 'cards' && !req.options.length) return Promise.resolve([]);
    return new Promise(resolve => { this.pending = { id: uid++, pid, req, resolve }; this.onChange(); });
  }
  respond(v) { const p = this.pending; if (!p) return; this.pending = null; p.resolve(v); this.onChange(); }
  cancel() {
    const p = this.pending;
    this.pending = null;
    if (!p) return;
    const t = p.req.type;
    p.resolve(t === 'main' ? { t: 'end' } : t === 'confirm' || t === 'trigger' || t === 'mulligan' ? false : t === 'cards' ? [] : null);
  }
}
