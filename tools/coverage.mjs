// Static coverage report: which rules features used by precon cards the engine doesn't implement.
import fs from 'node:fs';
import { parseCardScript, parseAbility } from '../src/engine/forge.js';
import { SUPPORTED_APIS } from '../src/engine/effects.js';
import { SUPPORTED_TRIGGER_MODES } from '../src/engine/triggers.js';
import { SUPPORTED_KEYWORDS } from '../src/engine/keywords.js';

const cards = JSON.parse(fs.readFileSync('data/cards.json', 'utf8'));
const decks = JSON.parse(fs.readFileSync('data/decks.json', 'utf8'));
const usage = {};
for (const d of decks) { for (const c of d.commanders) usage[c] = (usage[c] || 0) + 1; for (const [c] of d.cards) usage[c] = (usage[c] || 0) + 1; }
const STATIC_MODES = new Set(['Continuous', 'ReduceCost', 'RaiseCost', 'CantBlockBy', 'CantAttack', 'CantAttackUnless', 'CastWithFlash', 'CantBlock', 'Panharmonicon', 'CantBeCast', 'CantSacrifice', 'MinMaxBlocker', 'CantGainLife', 'IgnoreLegendRule', 'CanAttackDefender', 'CombatDamageToughness', 'CantTarget', 'ActivateAbilityAsIfHaste', 'CantPreventDamage', 'CantBeActivated', 'AssignCombatDamageAsUnblocked', 'CantPutCounter', 'NumLoyaltyAct', 'CantBeCountered', 'MustAttack', 'AlternativeCost', 'UntapOtherPlayer']);
const REPL = new Set(['Moved', 'DamageDone', 'AddCounter', 'CreateToken', 'Draw', 'GainLife', 'Counter', 'Untap', 'GameLoss', 'GameWin']);
const COSTS = new Set(['T', 'Q', 'Sac', 'SubCounter', 'AddCounter', 'PayLife', 'Discard', 'Exile', 'ExileFromGrave', 'ExileFromHand', 'tapXType', 'untapYType', 'Return', 'PayEnergy', 'RemoveAnyCounter', 'Mill', 'Reveal', 'Draw', 'Exert', 'Unattach', 'Crew', 'ExileAnyGrave']);
const miss = {};
const add = (cat, key, card) => { miss[cat] ??= new Map(); const e = miss[cat].get(key) || { w: 0, cards: [] }; e.w += usage[card] || 0; if (e.cards.length < 4) e.cards.push(card); miss[cat].set(key, e); };
let full = 0, weightedFull = 0, totalW = 0;
for (const [name, text] of Object.entries(cards)) {
  const { faces } = parseCardScript(text);
  let ok = true;
  const w = usage[name] || 0;
  totalW += w;
  for (const f of faces) {
    for (const k of f.K) { const kn = k.split(':')[0]; if (!SUPPORTED_KEYWORDS.has(kn) && !/^Protection|^Hexproof|walk$|^Landwalk|^CARDNAME|^HIDDEN/.test(kn)) { add('keyword', kn, name); ok = false; } }
    const abil = [...f.A, ...Object.values(f.svars).filter(v => /^(DB|AB|SP)\$/.test(v))];
    for (const a of abil) {
      const p = parseAbility(a);
      if (p.api && !SUPPORTED_APIS.has(p.api) && !/^Permanent/.test(p.api)) { add('api', p.api, name); ok = false; }
      if (p.p.Cost) for (const tok of p.p.Cost.match(/\w+<[^>]*>|\S+/g) || []) { const t = tok.replace(/<.*/, ''); if (/^[\dWUBRGCXSP\/]+$/.test(t) || t === 'XMin1' || t === 'Mandatory') continue; if (!COSTS.has(t)) { add('cost', t, name); ok = false; } }
    }
    const trigs = [...f.T, ...Object.values(f.svars).filter(v => /^Mode\$/.test(v) && /Execute\$/.test(v))];
    for (const t of trigs) { const p = parseAbility(t); if (!SUPPORTED_TRIGGER_MODES.has(p.p.Mode)) { add('trigger', p.p.Mode, name); ok = false; } }
    const stats = [...f.S, ...Object.values(f.svars).filter(v => /^Mode\$/.test(v) && !/Execute\$/.test(v))];
    for (const s of stats) { const p = parseAbility(s); for (const m of (p.p.Mode || '').split(',')) if (!STATIC_MODES.has(m)) { add('static', m, name); ok = false; } }
    const repl = [...f.R, ...Object.values(f.svars).filter(v => /^Event\$/.test(v))];
    for (const r of repl) { const p = parseAbility(r); if (!REPL.has(p.p.Event)) { add('replacement', p.p.Event, name); ok = false; } }
  }
  if (ok) { full++; weightedFull += w; }
}
console.log(`Cards with every feature recognized: ${full}/${Object.keys(cards).length} (${(100 * full / Object.keys(cards).length).toFixed(1)}%), weighted by deck usage ${(100 * weightedFull / totalW).toFixed(1)}%`);
for (const [cat, m] of Object.entries(miss)) {
  const arr = [...m].sort((a, b) => b[1].w - a[1].w);
  console.log(`\n== ${cat} (${arr.length})`);
  console.log(arr.slice(0, +(process.argv[2] || 30)).map(([k, e]) => `${k}:${e.w} [${e.cards.slice(0, 2).join('; ')}]`).join('\n'));
}
