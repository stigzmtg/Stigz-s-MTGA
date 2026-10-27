// What the AI deck helper's tools do (their descriptions are in src/ai/agentspec.js). They run in the page, on the same
// card index and deck helper as the rest of the builder, against a working copy of the deck that `commit` hands to the
// builder after every change (so each change is one step the player can undo). Every result is a small plain object
// the model reads as JSON.
import { BASICS, deckProblems } from './customdecks.js';
import { parseAsk, COLOR_NAMES } from './deckai.js';

const BASIC_FOR = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' };
const COLORS = ['W', 'U', 'B', 'R', 'G'];
const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
const costText = c => (c.cost.length ? c.cost.map(t => `{${t.length === 2 && /^[WUBRG2][WUBRGP]$/.test(t) ? `${t[0]}/${t[1]}` : t}}`).join('') : '');
const colorWords = ci => (ci.length ? ci.map(x => COLOR_NAMES[x]).join('-') : 'colorless');

// edit distance, for "did you mean"
function distance(a, b) {
  if (Math.abs(a.length - b.length) > 6) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = prev[j]; prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1)); diag = t; }
  }
  return prev[b.length];
}

export function createAgentTools({ H, index, byName, getDeck, commit }) {
  const lower = new Map(index.map(c => [c.lower, c]));
  // the deck as the tools see it: read at the start of each call, written back with commit()
  const identityOf = commanders => { const s = new Set(); for (const n of commanders) for (const x of (byName.get(n) || { ci: [] }).ci) s.add(x); return COLORS.filter(x => s.has(x)); };

  function resolve(name) {
    const q = String(name || '').trim().toLowerCase();
    if (!q) return { card: null, near: [] };
    const hit = lower.get(q) || lower.get(q.split(' // ')[0]) || index.find(c => c.lower.split(' // ')[0] === q);
    if (hit) return { card: hit, near: [] };
    // closest first: names that start with it, then names containing it, then small typos; shorter names first
    const near = index.map(c => [c, c.lower.startsWith(q) ? 0 : c.lower.includes(q) ? 1 : 2 + distance(q, c.lower.slice(0, q.length + 2))])
      .filter(([, d]) => d <= 2 + Math.max(2, Math.floor(q.length / 4))).sort((a, b) => a[1] - b[1] || Math.abs(a[0].name.length - q.length) - Math.abs(b[0].name.length - q.length)).slice(0, 3).map(([c]) => c.name);
    return { card: null, near };
  }
  const why = (r, n = 2) => (r ? r.why.filter(w => !/can’t fully play/.test(w)).map(w => w.replace(/: you have (\d+), aim for about (\d+)$/, ' ($1 of $2)')).slice(0, n) : []);
  const summary = c => ({ name: c.name, cost: costText(c), type: c.type, colors: c.ci.join('') || 'C' });

  const tools = {
    find_commanders({ query = '', colors = null, exact_colors = false, limit = 8 }) {
      const want = Array.isArray(colors) ? colors.filter(x => [...COLORS, 'C'].includes(x)) : [];
      const fitsColors = c => {
        if (!want.length) return true;
        if (want.includes('C')) return !c.ci.length;
        return exact_colors ? c.ci.length === want.length && want.every(x => c.ci.includes(x)) : want.every(x => c.ci.includes(x));
      };
      const ok = c => c.commander && H.feats.get(c.name).legal && !H.feats.get(c.name).flagged && fitsColors(c);
      const q = String(query).toLowerCase().trim();
      const words = q.split(/\s+/).filter(w => w.length > 1).map(w => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      const scored = new Map();
      const add = (c, v) => scored.set(c.name, (scored.get(c.name) || 0) + v);
      if (q) {
        // the themes and creature types it rewards ("dragons", "tokens") first, in the helper's order
        const a = parseAsk(q, H.typeWords);
        if (a.themes.length || a.tribes.length) for (const [i, r] of H.findCommanders({ themes: a.themes, tribes: a.tribes, limit: 60 }).entries()) { const c = byName.get(r.name); if (c && ok(c)) add(c, 600 - i * 8); }
        for (const c of index) {
          if (!ok(c)) continue;
          if (q.length >= 3 && c.lower.startsWith(q)) add(c, 1000);          // a name ("atraxa")
          else if (words.length && words.every(w => w.test(c.lower) || w.test(c.type.toLowerCase()) || w.test(c.text.toLowerCase()))) add(c, 30 + Math.min(10, H.feats.get(c.name).pop));
        }
      } else for (const c of index) if (ok(c)) add(c, (H.leadsPrecon(c.name) ? 50 : 0) + Math.min(20, H.feats.get(c.name).pop));
      const list = [...scored].sort((a, b) => b[1] - a[1]).slice(0, Math.min(12, limit || 8)).map(([n]) => byName.get(n));
      return { found: scored.size, commanders: list.map(c => ({ ...summary(c), text: clip(c.text, 320), partner: c.partner || undefined, leads_a_precon: H.leadsPrecon(c.name) || undefined })) };
    },

    set_commander({ name, partner = null }) {
      const a = resolve(name);
      if (!a.card) return { error: `No card named "${name}" here.`, did_you_mean: a.near };
      if (!a.card.commander) return { error: `${a.card.name} can't be a commander (it isn't a legendary creature).` };
      const names = [a.card.name];
      if (partner) {
        const b = resolve(partner);
        if (!b.card) return { error: `No card named "${partner}" here.`, did_you_mean: b.near };
        if (!a.card.partner || !b.card.partner) return { error: 'Two commanders both need Partner.' };
        names.push(b.card.name);
      }
      const d = getDeck();
      const cards = new Map(d.cards);
      for (const n of names) cards.delete(n);
      commit({ commanders: names, cards });
      const identity = identityOf(names);
      const off = [...cards.keys()].filter(n => { const c = byName.get(n); return c && c.ci.some(x => !identity.includes(x)); });
      const plan = H.recipe({ commanders: names, cards }).planNames;
      return { commanders: names, colors: colorWords(identity), plan: plan.length ? plan : ['no single theme: strong cards that do their jobs'], cards_in_deck: [...cards.values()].reduce((x, y) => x + y, 0), now_outside_colors: off.length ? off.slice(0, 15) : undefined };
    },

    search_cards({ query = '', job = null, type = null, min_cost = null, max_cost = null, fits_plan = false, include_off_color = false, sort = 'fit', limit = 12 }) {
      const d = getDeck();
      const identity = identityOf(d.commanders);
      const rank = d.commanders.length ? H.rank(d) : null;
      const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
      const out = [];
      for (const c of index) {
        if (c.main === 'Other' || d.commanders.includes(c.name) || (BASICS.has(c.name) && !words.length)) continue;
        const off = d.commanders.length && c.ci.some(x => !identity.includes(x));
        if (off && !include_off_color) continue;
        if (type && c.main !== type) continue;
        if (min_cost != null && (c.main === 'Land' || c.cmc < min_cost)) continue;
        if (max_cost != null && (c.main === 'Land' || c.cmc > max_cost)) continue;
        if (job && !H.roleOf(c.name).includes(job)) continue;
        if (fits_plan && !(rank && rank.get(c.name) && rank.get(c.name).plan)) continue;
        if (words.length && !words.every(w => c.lower.includes(w) || c.type.toLowerCase().includes(w) || c.text.toLowerCase().includes(w))) continue;
        if (!H.feats.get(c.name).legal) continue;
        out.push(c);
      }
      const fit = c => { const r = rank && rank.get(c.name); return r ? r.s : -99; };
      if (sort === 'popular') out.sort((a, b) => H.feats.get(b.name).pop - H.feats.get(a.name).pop);
      else if (sort === 'cost') out.sort((a, b) => a.cmc - b.cmc || fit(b) - fit(a));
      else out.sort((a, b) => fit(b) - fit(a) || H.feats.get(b.name).pop - H.feats.get(a.name).pop);
      return {
        matches: out.length,
        cards: out.slice(0, Math.min(25, limit || 12)).map(c => ({
          ...summary(c), jobs: H.roleOf(c.name), why: why(rank && rank.get(c.name)), text: clip(c.text, 220),
          in_deck: d.cards.get(c.name) || undefined, off_color: (d.commanders.length && c.ci.some(x => !identity.includes(x))) || undefined,
          not_fully_playable: H.feats.get(c.name).flagged || undefined,
        })),
      };
    },

    get_card({ names = [] }) {
      const d = getDeck();
      return {
        cards: names.slice(0, 8).map(n => {
          const r = resolve(n);
          if (!r.card) return { name: n, found: false, did_you_mean: r.near };
          const c = r.card, info = H.info(c.name, d);
          return { ...summary(c), found: true, text: c.text, jobs: info.roles, fits_plan: info.plans, helper_reasons: why(info, 3), cant_go_in: info.problems.length ? info.problems : undefined, in_deck: d.cards.get(c.name) || undefined, is_commander: d.commanders.includes(c.name) || undefined, can_be_commander: c.commander || undefined, in_precons: info.pop || undefined };
        }),
      };
    },

    get_deck() {
      const d = getDeck();
      const identity = identityOf(d.commanders);
      const list = [...d.cards].filter(([, k]) => k > 0).sort((a, b) => a[0].localeCompare(b[0]));
      const groups = {};
      for (const [n, k] of list) { const c = byName.get(n); const t = c ? c.main : 'Other'; (groups[t] = groups[t] || []).push(k > 1 ? `${k}x ${n}` : n); }
      const total = d.commanders.length + list.reduce((a, [, k]) => a + k, 0);
      const rec = H.recipe(d);
      const mana = H.manaStats(d);
      return {
        commanders: d.commanders, colors: colorWords(identity), total, empty_slots: Math.max(0, 100 - total),
        cards_by_type: groups,
        checklist: rec.rows.map(r => ({ part: r.label, have: r.have, aim: r.want, status: r.state })),
        average_cost: Math.round(rec.avg * 10) / 10,
        colors_balance: mana.colors.map(c => ({ color: c.name, share_of_symbols: Math.round(c.share * 100) + '%', lands_that_make_it: c.sources, aim: c.want })),
        problems: deckProblems({ commanders: d.commanders, cards: list }, byName, identity),
      };
    },

    add_cards({ cards = [] }) {
      const d = getDeck();
      if (!d.commanders.length) return { error: 'Choose a commander first (set_commander).' };
      const identity = identityOf(d.commanders);
      const next = new Map(d.cards), added = [], skipped = [];
      for (const item of cards.slice(0, 60)) {
        const r = resolve(item.name);
        const k = Math.max(1, Math.min(40, Math.floor(item.count || 1)));
        if (!r.card) { skipped.push({ name: item.name, reason: 'not on this site', did_you_mean: r.near.length ? r.near : undefined }); continue; }
        const c = r.card, f = H.feats.get(c.name);
        if (d.commanders.includes(c.name)) { skipped.push({ name: c.name, reason: 'it is the commander' }); continue; }
        if (c.ci.some(x => !identity.includes(x))) { skipped.push({ name: c.name, reason: `outside the commander's colors (needs ${c.ci.filter(x => !identity.includes(x)).map(x => COLOR_NAMES[x]).join(' and ')})` }); continue; }
        if (!f.legal) { skipped.push({ name: c.name, reason: c.main === 'Other' ? 'not a card a deck can use' : 'banned in Commander' }); continue; }
        if (f.flagged) { skipped.push({ name: c.name, reason: "the game can't fully play this card yet" }); continue; }
        const have = next.get(c.name) || 0;
        if (!c.anyNumber && (have || k > 1)) { if (have) { skipped.push({ name: c.name, reason: 'already in the deck (one copy each)' }); continue; } }
        const n = c.anyNumber ? k : 1;
        next.set(c.name, have + n);
        added.push(n > 1 ? `${n}x ${c.name}` : c.name);
      }
      if (added.length) commit({ commanders: d.commanders, cards: next });
      const total = d.commanders.length + [...next.values()].reduce((a, b) => a + b, 0);
      return { added, skipped: skipped.length ? skipped : undefined, total, note: total > 100 ? `${total - 100} over 100: suggest cuts` : undefined };
    },

    remove_cards({ cards = [] }) {
      const d = getDeck();
      const next = new Map(d.cards), removed = [], not_in_deck = [];
      for (const item of cards.slice(0, 60)) {
        const r = resolve(item.name);
        const name = r.card ? r.card.name : item.name;
        const have = next.get(name) || 0;
        if (!have) { not_in_deck.push(item.name); continue; }
        const k = Math.min(have, Math.max(1, Math.floor(item.count || 1)));
        if (have - k > 0) next.set(name, have - k); else next.delete(name);
        removed.push(k > 1 ? `${k}x ${name}` : name);
      }
      if (removed.length) commit({ commanders: d.commanders, cards: next });
      return { removed, not_in_deck: not_in_deck.length ? not_in_deck : undefined, total: d.commanders.length + [...next.values()].reduce((a, b) => a + b, 0) };
    },

    auto_build({ mode = 'fill', focus = '' }) {
      const d = getDeck();
      if (!d.commanders.length) return { error: 'Choose a commander first (set_commander).' };
      const a = focus ? parseAsk(focus, H.typeWords) : { themes: [], tribes: [] };
      const r = H.build({ ...d, focus: { themes: a.themes, tribes: a.tribes } }, { fresh: mode === 'rebuild', seed: (Math.random() * 2 ** 31) >>> 0 });
      commit({ commanders: d.commanders, cards: r.cards });
      const spells = r.added.filter(n => (byName.get(n) || {}).main !== 'Land');
      const lands = r.added.length - spells.length;
      const rec = H.recipe({ commanders: d.commanders, cards: r.cards });
      return { mode, added_spells: spells, added_lands: lands, total: d.commanders.length + [...r.cards.values()].reduce((x, y) => x + y, 0), checklist: rec.rows.map(x => `${x.label} ${x.have}/${x.want} ${x.state}`) };
    },

    suggest_cuts({ count = 8 }) {
      const d = getDeck();
      return { cuts: H.cuts(d, Math.min(20, count || 8)).map(c => ({ name: c.name, why: c.why })) };
    },

    fill_basic_lands() {
      const d = getDeck();
      if (!d.commanders.length) return { error: 'Choose a commander first (set_commander).' };
      const total = d.commanders.length + [...d.cards.values()].reduce((a, b) => a + b, 0);
      const need = 100 - total;
      if (need <= 0) return { added: {}, total, note: 'The deck already has 100 cards.' };
      const identity = identityOf(d.commanders);
      const colors = identity.length ? identity : ['C'];
      const share = Object.fromEntries(H.manaStats(d).colors.map(c => [c.color, c.share]));
      const w = colors.map(x => 0.25 + (share[x] || 0)), sw = w.reduce((a, b) => a + b, 0);
      const n = w.map(v => Math.floor((need * v) / sw));
      for (let i = 0, left = need - n.reduce((a, b) => a + b, 0); left > 0; i++, left--) n[i % n.length]++;
      const next = new Map(d.cards), added = {};
      colors.forEach((x, i) => { const land = x === 'C' ? 'Wastes' : BASIC_FOR[x]; if (n[i]) { next.set(land, (next.get(land) || 0) + n[i]); added[land] = n[i]; } });
      commit({ commanders: d.commanders, cards: next });
      return { added, total: 100 };
    },
  };

  // run one tool call; a tool that throws comes back as an error result for the model to read
  return function run(name, input) {
    const f = tools[name];
    if (!f) return { error: `There's no tool called ${name}.` };
    try { return f(input && typeof input === 'object' ? input : {}); } catch (e) { return { error: `That didn't work: ${e && e.message ? e.message : e}` }; }
  };
}

// one line about the deck, put at the start of each message the player sends
export function deckStatus(H, byName, d) {
  if (!d.commanders.length) return 'No commander chosen yet; the deck is empty.';
  const s = new Set(); for (const n of d.commanders) for (const x of (byName.get(n) || { ci: [] }).ci) s.add(x);
  const total = d.commanders.length + [...d.cards.values()].reduce((a, b) => a + b, 0);
  const rows = H.recipe(d).rows.map(r => `${r.label} ${r.have}/${r.want}`).join(', ');
  return `Commander: ${d.commanders.join(' & ')} (${colorWords(COLORS.filter(x => s.has(x)))}). ${total}/100 cards. Checklist: ${rows}.`;
}
