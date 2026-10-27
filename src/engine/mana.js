// Mana costs, mana pools and the automatic payment solver.
import { COLORS } from './util.js';

const COLOR_SET = new Set(['W', 'U', 'B', 'R', 'G']);

export function emptyCost() {
  return { generic: 0, colored: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }, hybrid: [], twobrid: [], phyrexian: [], x: 0, snow: 0 };
}

// Parse a Forge mana string such as "2 G G", "X 1 R", "WU", "RP", "2W", "2/B", "CW".
export function parseMana(str) {
  const cost = emptyCost();
  if (!str || str === 'no cost' || str === '0') return cost;
  for (let tok of String(str).trim().split(/\s+/)) {
    if (!tok) continue;
    tok = tok.replace(/[{}]/g, '');
    if (/^\d+$/.test(tok)) { cost.generic += +tok; continue; }
    if (tok === 'X') { cost.x++; continue; }
    if (tok === 'S') { cost.snow++; continue; }
    if (tok === 'C') { cost.colored.C++; continue; }
    if (tok.length === 1 && COLOR_SET.has(tok)) { cost.colored[tok]++; continue; }
    const t = tok.replace('/', '');
    if (/^[WUBRG]P$/.test(t)) { cost.phyrexian.push(t[0]); continue; }
    if (/^2[WUBRG]$/.test(t)) { cost.twobrid.push(t[1]); continue; }
    if (/^[WUBRGC][WUBRG]$/.test(t)) { cost.hybrid.push([t[0], t[1]]); continue; }
    if (/^[WUBRG][WUBRG]P$/.test(t)) { cost.hybrid.push([t[0], t[1]]); continue; }
    // unknown symbol: treat as generic 1
    cost.generic += 1;
  }
  return cost;
}

export function isManaToken(tok) {
  tok = tok.replace(/[{}]/g, '');
  return /^\d+$/.test(tok) || tok === 'X' || tok === 'S' || /^[WUBRGC]$/.test(tok) || /^[WUBRG]\/?P$/.test(tok) || /^2\/?[WUBRG]$/.test(tok) || /^[WUBRGC]\/?[WUBRG]$/.test(tok);
}

export function cloneCost(c) {
  const r = { generic: c.generic, colored: { ...c.colored }, hybrid: c.hybrid.map(h => [...h]), twobrid: [...c.twobrid], phyrexian: [...c.phyrexian], x: c.x, snow: c.snow };
  if (c.waterbend) r.waterbend = c.waterbend; // (how much of the generic part is a waterbend cost: mech-newsets.js)
  return r;
}

export function addCosts(a, b) {
  const r = cloneCost(a);
  r.generic += b.generic;
  for (const k in b.colored) r.colored[k] += b.colored[k];
  r.hybrid.push(...b.hybrid.map(h => [...h]));
  r.twobrid.push(...b.twobrid);
  r.phyrexian.push(...b.phyrexian);
  r.x += b.x;
  r.snow += b.snow;
  if (b.waterbend) r.waterbend = r.waterbend === 'X' || b.waterbend === 'X' ? 'X' : (+r.waterbend || 0) + +b.waterbend;
  return r;
}

export function cmc(c) {
  if (!c) return 0;
  let n = c.generic + c.hybrid.length + c.twobrid.length * 2 + c.phyrexian.length + c.snow;
  for (const k in c.colored) n += c.colored[k];
  return n;
}

export function costColors(c) {
  const s = new Set();
  if (!c) return s;
  for (const k of COLORS) if (c.colored[k]) s.add(k);
  for (const h of c.hybrid) for (const x of h) if (COLOR_SET.has(x)) s.add(x);
  for (const x of c.twobrid) s.add(x);
  for (const x of c.phyrexian) s.add(x);
  return s;
}

export function isFree(c) { return cmc(c) === 0 && !c.x; }

// Symbols for display: ["2","G","G"], hybrid "W/U", phyrexian "B/P"
export function costSymbols(c, xValue = null) {
  if (!c) return [];
  const out = [];
  for (let i = 0; i < c.x; i++) out.push(xValue != null ? String(xValue) : 'X');
  if (c.generic || (!out.length && cmc(c) === 0 && !c.x)) out.push(String(c.generic));
  for (let i = 0; i < c.snow; i++) out.push('S');
  for (let i = 0; i < c.colored.C; i++) out.push('C');
  for (const h of c.hybrid) out.push(h.join('/'));
  for (const x of c.twobrid) out.push('2/' + x);
  for (const x of c.phyrexian) out.push(x + '/P');
  for (const k of COLORS) for (let i = 0; i < c.colored[k]; i++) out.push(k);
  return out;
}

export function costString(c) { return costSymbols(c).map(s => `{${s}}`).join(''); }

// Reduce generic portion (cost reduction effects). Never below 0.
export function reduceGeneric(c, n) {
  const r = cloneCost(c);
  r.generic = Math.max(0, r.generic - n);
  return r;
}

export function emptyPool() { return { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }; }
export function poolTotal(p) { return p.W + p.U + p.B + p.R + p.G + p.C; }

// Requirements list from a cost: each requirement is an array of acceptable colors or 'any'.
// Phyrexian shards are returned separately so the caller can pay life when needed.
function requirements(cost) {
  const reqs = [];
  for (const k of ['W', 'U', 'B', 'R', 'G', 'C']) for (let i = 0; i < cost.colored[k]; i++) reqs.push([k]);
  for (const h of cost.hybrid) reqs.push(h[0] === 'C' ? ['C', h[1]] : [...h]);
  for (const x of cost.twobrid) reqs.push({ twobrid: x });
  for (let i = 0; i < cost.generic + cost.snow; i++) reqs.push('any');
  return reqs;
}

// Pay entirely out of a pool. Returns { pool, life } or null.
export function payFromPool(cost, pool, { lifeAvailable = 0 } = {}) {
  const phy = cost.phyrexian;
  if (!phy.length) return payNonPhyrexian(cost, { ...pool }, 0);
  // Phyrexian: prefer mana, but pay life for any shard whose mana the rest of the cost needs
  const masks = Array.from({ length: 1 << phy.length }, (_, m) => m).sort((a, b) => bits(a) - bits(b));
  for (const mask of masks) {
    const life = bits(mask) * 2;
    if (life > lifeAvailable) continue;
    const p = { ...pool };
    let ok = true;
    for (let i = 0; i < phy.length && ok; i++) { if (mask & (1 << i)) continue; if (p[phy[i]] > 0) p[phy[i]]--; else ok = false; }
    if (!ok) continue;
    const r = payNonPhyrexian(cost, p, life);
    if (r) return r;
  }
  return null;
}
function bits(m) { let n = 0; for (; m; m >>= 1) n += m & 1; return n; }

function payNonPhyrexian(cost, p, life) {
  const reqs = requirements(cost);
  // order: single color, hybrid, twobrid, generic
  const single = reqs.filter(r => Array.isArray(r) && r.length === 1);
  const multi = reqs.filter(r => Array.isArray(r) && r.length > 1);
  const two = reqs.filter(r => r && r.twobrid);
  const generic = reqs.filter(r => r === 'any');
  for (const r of single) { if (p[r[0]] > 0) p[r[0]]--; else return null; }
  // hybrid symbols: small backtracking search so an early choice can't starve a later symbol
  const assignHybrid = (i) => {
    if (i >= multi.length) return true;
    const opts = multi[i].filter(c => p[c] > 0).sort((a, b) => p[b] - p[a]);
    for (const c of opts) { p[c]--; if (assignHybrid(i + 1)) return true; p[c]++; }
    return false;
  };
  if (!assignHybrid(0)) return null;
  let genericNeed = generic.length;
  for (const r of two) {
    if (p[r.twobrid] > 0) p[r.twobrid]--; else genericNeed += 2;
  }
  // generic: spend colorless first, then most abundant colors
  for (let i = 0; i < genericNeed; i++) {
    if (p.C > 0) { p.C--; continue; }
    const best = COLORS.filter(c => p[c] > 0).sort((a, b) => p[b] - p[a])[0];
    if (!best) return null;
    p[best]--;
  }
  return { pool: p, life };
}

/*
 * Plan which mana sources to activate to pay a cost.
 * sources: [{ key, units: [[colors...], ...], penalty, extraCost: cost|null, sig, noGeneric }]
 *   noGeneric: its mana can't pay generic costs (Jegantha)
 *   units: each produced mana unit's acceptable colors (e.g. [['G']], [['C'],['C']], [['W','U','B','R','G']])
 * Returns { activations: [{ key, colors: [...] }], life } or null.
 */
export function planPayment(cost, pool, sources, { lifeAvailable = 0, maxNodes = 40000 } = {}) {
  // Fast path: pool alone
  const direct = payFromPool(cost, pool, { lifeAvailable });
  if (direct) return { activations: [], life: direct.life };

  const reqs0 = requirements(cost);
  // phyrexian requirements become optional colored reqs (handled by trying mana first, then life)
  const phy = cost.phyrexian;

  const srcs = sources.slice().sort((a, b) => a.penalty - b.penalty || flex(a) - flex(b));
  let nodes = 0;

  for (let lifeShards = 0; lifeShards <= phy.length; lifeShards++) {
    if (lifeShards * 2 > lifeAvailable) break;
    const reqs = reqs0.map(r => (r && r.twobrid) ? [r.twobrid] : r);
    // phyrexian shards paid with mana (the last ones get paid with life)
    for (let i = 0; i < phy.length - lifeShards; i++) reqs.unshift([phy[i]]);
    sortReqs(reqs);
    const poolLeft = { ...pool };
    const leftovers = []; // { colors, srcIdx, unitIdx }
    const used = new Array(srcs.length).fill(false);
    const exclUsed = new Set();
    const chosen = srcs.map(s => s.units.map(() => null));
    const pending = reqs.slice();

    const dfs = (i) => {
      if (++nodes > maxNodes) return false;
      if (i >= pending.length) return true;
      const raw = pending[i];
      const req = raw && raw.extra ? raw.r : raw;
      const notFrom = raw && raw.extra ? raw.from : -1;
      const ok = c => req === 'any' ? true : req.includes(c);
      // 1. floating pool
      const poolColors = req === 'any' ? ['C', ...COLORS] : req;
      for (const c of poolColors) {
        if (poolLeft[c] > 0 && ok(c)) {
          poolLeft[c]--;
          if (dfs(i + 1)) return true;
          poolLeft[c]++;
          if (req === 'any') break; // any pool color is as good for generic
        }
      }
      // 2. leftover units from already-activated sources
      const triedLeft = new Set();
      for (let li = 0; li < leftovers.length; li++) {
        const u = leftovers[li];
        if (u.taken || u.srcIdx === notFrom) continue;
        if (req === 'any' && srcs[u.srcIdx].noGeneric) continue; // Jegantha: "can't be spent to pay generic mana costs"
        if (notFrom >= 0 && srcs[u.srcIdx].extraCost) continue; // filter costs are paid by non-filter mana
        const color = pickColor(u.colors, req);
        if (!color) continue;
        const sig = u.colors.join('');
        if (triedLeft.has(sig)) continue;
        triedLeft.add(sig);
        u.taken = true; chosen[u.srcIdx][u.unitIdx] = color;
        if (dfs(i + 1)) return true;
        u.taken = false; chosen[u.srcIdx][u.unitIdx] = null;
      }
      // 3. activate a new source
      const triedSig = new Set();
      for (let si = 0; si < srcs.length; si++) {
        if (used[si]) continue;
        const s = srcs[si];
        if (notFrom >= 0 && s.extraCost) continue;
        if (req === 'any' && s.noGeneric) continue;
        if (s.excl && exclUsed.has(s.excl)) continue;
        const sig = s.sig || (s.units.map(u => u.join('')).join('|') + ':' + s.penalty + (s.extraCost ? 'x' : ''));
        if (triedSig.has(sig)) continue;
        const unitIdx = s.units.findIndex(u => pickColor(u, req));
        if (unitIdx < 0) continue;
        triedSig.add(sig);
        used[si] = true;
        if (s.excl) exclUsed.add(s.excl);
        const added = [];
        s.units.forEach((u, ui) => { if (ui !== unitIdx) { const lo = { colors: u, srcIdx: si, unitIdx: ui, taken: false }; leftovers.push(lo); added.push(lo); } });
        chosen[si][unitIdx] = pickColor(s.units[unitIdx], req);
        let extra = [];
        if (s.extraCost) { extra = requirements(s.extraCost).map(r => ({ extra: true, from: si, r: (r && r.twobrid) ? [r.twobrid] : r })); pending.push(...extra); }
        if (dfs(i + 1)) return true;
        if (extra.length) pending.splice(pending.length - extra.length, extra.length);
        for (const lo of added) leftovers.splice(leftovers.indexOf(lo), 1);
        chosen[si] = s.units.map(() => null);
        used[si] = false;
        if (s.excl) exclUsed.delete(s.excl);
      }
      return false;
    };

    if (dfs(0)) {
      const activations = [];
      srcs.forEach((s, si) => {
        if (!used[si]) return;
        activations.push({ key: s.key, colors: s.units.map((u, ui) => chosen[si][ui] || defaultColor(u)) });
      });
      return { activations, life: lifeShards * 2 };
    }
  }
  return null;
}

function flex(s) { return s.units.reduce((a, u) => a + u.length, 0) / Math.max(1, s.units.length) + (s.extraCost ? 10 : 0) - (s.units.length - 1) * 0.5; }

function sortReqs(reqs) {
  const rank = r => r === 'any' ? 100 : r.length;
  reqs.sort((a, b) => rank(a) - rank(b));
}

function pickColor(unitColors, req) {
  if (req === 'any') return unitColors.includes('C') ? 'C' : unitColors[0];
  for (const c of req) if (unitColors.includes(c)) return c;
  return null;
}

function defaultColor(u) { return u.includes('C') ? 'C' : u[0]; }

export function manaColorsFromProduced(produced) {
  // returns array of units; each unit = array of options
  // "C", "G", "W B" (two units), "Combo W B" (one unit, choice), "Any"
  if (!produced) return [['C']];
  const p = produced.trim();
  if (p === 'Any' || p === 'Combo Any') return [['W', 'U', 'B', 'R', 'G']];
  if (p.startsWith('Combo ')) {
    const opts = p.slice(6).split(/\s+/).filter(x => /^[WUBRGC]$/.test(x));
    return [opts.length ? opts : ['C']];
  }
  return p.split(/\s+/).filter(x => /^[WUBRGC]$/.test(x)).map(x => [x]);
}
