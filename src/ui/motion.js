// Motion: cards glide from where they were to where they are, instead of jumping.
// After every render a table calls runFlights(): it measures every card on screen (elements marked
// data-fly="<card ids>") and compares with the last render, using a map of every card's zone ("1:graveyard",
// "bf", "mon:12") to know where cards went:
//  - a card element that moved within its row glides from its old place (FLIP);
//  - a card that turns up in a new element (cast, drawn, put onto the battlefield) flies there as a copy, from its
//    old element or from the pile of its old zone (data-pile="<zone>"), and the real one shows when it lands;
//  - a card that left the screen flies, as a copy of how it last looked, to the pile of the zone it went to;
//  - a hidden move between two piles (an opponent's draw, a mill) sends a card between the piles.
// Copies fly in one fixed layer over the page, so no scrolling box clips them.
// Players choose On / Reduced / Off (html[data-motion]); Reduced keeps fades and drops flights and shakes.
import { safeStorage, uiScale } from './common.js';

export const MOTIONS = [['full', 'On'], ['reduced', 'Reduced'], ['off', 'Off']];
const KEY = 'pa-motion';
const listeners = new Set();
let version = 0;
const prefersReduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
export function motionPref() { const v = safeStorage.getItem(KEY); return MOTIONS.some(m => m[0] === v) ? v : (prefersReduced() ? 'reduced' : 'full'); }
export const subscribeMotion = f => { listeners.add(f); return () => listeners.delete(f); };
export const motionVersion = () => version;
export function applyMotion() { if (typeof document !== 'undefined') document.documentElement.dataset.motion = motionPref(); }
export function setMotion(v) { safeStorage.setItem(KEY, v); applyMotion(); version++; for (const f of listeners) f(); }
export const motionOn = () => typeof document !== 'undefined' && document.documentElement.dataset.motion === 'full';

const DUR = 460;
const EASE = 'cubic-bezier(0.22, 0.8, 0.25, 1)';
const MAX_PER_RENDER = 24;

let layerEl = null;
function layer() {
  if (!layerEl || !layerEl.isConnected) {
    layerEl = document.createElement('div');
    layerEl.className = 'flylayer';
    layerEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(layerEl);
  }
  return layerEl;
}

const rectOf = el => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; };
const center = r => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
const near = (a, b) => Math.abs(a.left - b.left) < 2 && Math.abs(a.top - b.top) < 2;
const onScreen = r => r.width > 1 && r.left < innerWidth + 200 && r.top < innerHeight + 200 && r.left + r.width > -200 && r.top + r.height > -200;

export function createFlights() { return { game: null, prev: new Map(), prevEls: new Map(), zones: null, flips: new Map(), reveals: new Map(), ghosts: new Map(), lunging: new Set() }; }
// attackers lean in with their own CSS transform: a card that is or was leaning doesn't glide as well
const LEAN = '.lunge, .lunge-up, .lunge-down';

// a copy of a card element to fly; what CSS variables sized is written onto it, and nothing in it can be found by
// the table's own lookups
function cloneOf(el, r) {
  const g = el.cloneNode(true);
  for (const n of [g, ...g.querySelectorAll('[data-fly],[data-ref],[data-mon],[data-stack],[id]')]) { n.removeAttribute('data-fly'); n.removeAttribute('data-ref'); n.removeAttribute('data-mon'); n.removeAttribute('data-stack'); n.removeAttribute('id'); }
  g.classList.remove('enter', 'hit', 'lunge', 'guard', 'evolving', 'lunge-up', 'lunge-down', 'targetable', 'selected');
  for (const n of g.querySelectorAll('.playable, .targetable, .selected, .attacking, .blocking')) n.classList.remove('playable', 'targetable', 'selected', 'attacking', 'blocking');
  const cw = g.classList.contains('tapped') ? r.height : r.width;
  g.style.setProperty('--cw', `${cw}px`);
  return g;
}

// a plain card for a hidden move: its picture, its name, or a back
function plainCard(look) {
  const g = document.createElement('div');
  g.className = `flycard ${look.back ? 'back' : ''} ${look.cls || ''}`;
  if (!look.back) {
    if (look.img) { const im = document.createElement('img'); im.src = look.img; im.alt = ''; g.appendChild(im); }
    else { const b = document.createElement('b'); b.textContent = look.name || ''; g.appendChild(b); }
  }
  return g;
}

// fly a ghost: it is laid out at `home` (its natural size) and moves from `from` to `to`, fitted into each
function launch(st, key, g, home, from, to, { kind = 'move', delay = 0, hold = null, onLand = null } = {}) {
  const old = key != null && st.ghosts.get(key);
  if (old) { old.remove(); st.ghosts.delete(key); }
  Object.assign(g.style, { position: 'fixed', left: `${home.left}px`, top: `${home.top}px`, width: `${home.width}px`, height: `${home.height}px`, margin: '0', pointerEvents: 'none' });
  g.classList.add('flyghost');
  layer().appendChild(g);
  const hc = center(home);
  const at = (r, extra = 1) => {
    const c = center(r);
    const s = Math.max(0.12, Math.min(3, Math.min(r.width / home.width, r.height / home.height))) * extra;
    return `translate(${(c.x - hc.x).toFixed(1)}px, ${(c.y - hc.y).toFixed(1)}px) scale(${s.toFixed(3)})`;
  };
  const a = center(from), b = center(to);
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  // an arc: the midpoint lifts a little, more for longer flights
  const lift = Math.min(60, dist * 0.12);
  const mid = { left: (from.left + to.left) / 2, top: (from.top + to.top) / 2 - lift, width: (from.width + to.width) / 2, height: (from.height + to.height) / 2 };
  let frames, duration = DUR + Math.min(220, dist * 0.18);
  if (kind === 'die' || kind === 'ko') {
    frames = [
      { transform: at(from), filter: 'none', opacity: 1, offset: 0 },
      { transform: `${at(from)} rotate(-3deg)`, filter: 'brightness(1.7) sepia(0.7) hue-rotate(-35deg) saturate(2)', offset: 0.12 },
      { transform: `${at(from)} rotate(3deg)`, filter: 'brightness(1.3) sepia(0.5) hue-rotate(-35deg) saturate(1.6)', offset: 0.24 },
      { transform: `${at(from, 0.94)} rotate(0deg)`, filter: 'grayscale(0.85) brightness(0.8)', opacity: 1, offset: 0.4 },
      { transform: `${at(to)} rotate(-8deg)`, filter: 'grayscale(1) brightness(0.6)', opacity: 0.2, offset: 1 },
    ];
    duration += 380;
  } else if (kind === 'exile') {
    frames = [
      { transform: at(from), filter: 'none', opacity: 1 },
      { transform: at(from, 1.06), filter: 'brightness(2.2) saturate(0.3)', opacity: 0.95, offset: 0.3 },
      { transform: at(to, 0.6), filter: 'brightness(2.6) saturate(0)', opacity: 0 },
    ];
    duration += 160;
  } else if (kind === 'showinto' && hold) {
    // the other player's card shown big in the middle of the table, then set down where it was played
    frames = [
      { transform: at(from, 0.6), opacity: 0, offset: 0 },
      { transform: at(hold), opacity: 1, offset: 0.22 },
      { transform: at(hold, 1.02), opacity: 1, offset: 0.66 },
      { transform: at(to), opacity: 1, offset: 1 },
    ];
    duration = 1500;
  } else if (kind === 'show' && hold) {
    // a played card shown big in the middle of the table, then put away
    frames = [
      { transform: at(from), opacity: 1, offset: 0 },
      { transform: at(hold), opacity: 1, offset: 0.24 },
      { transform: at(hold, 1.02), opacity: 1, offset: 0.72 },
      { transform: at(to), opacity: 0.25, offset: 1 },
    ];
    duration = 1700;
  } else {
    frames = [
      { transform: at(from), opacity: 1 },
      { transform: at(mid, 1.06), opacity: 1, offset: 0.5 },
      { transform: at(to), opacity: kind === 'into' ? 1 : 0.35 },
    ];
  }
  const anim = g.animate(frames, { duration, delay, easing: kind === 'show' || kind === 'showinto' ? 'ease-in-out' : EASE, fill: 'both' });
  if (key != null) st.ghosts.set(key, g);
  const done = () => { g.remove(); if (key != null && st.ghosts.get(key) === g) st.ghosts.delete(key); if (onLand) onLand(); };
  anim.onfinish = done;
  anim.oncancel = done;
  setTimeout(() => { if (g.isConnected) done(); }, duration + delay + 400);
  return duration + delay;
}

function flip(st, el, from, to) {
  const dx = from.left - to.left, dy = from.top - to.top;
  if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
  const anim = el.animate([{ transform: `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)` }, { transform: 'translate(0, 0)' }], { duration: 360, easing: EASE, composite: 'add' });
  st.flips.set(el, anim);
  anim.onfinish = () => { if (st.flips.get(el) === anim) st.flips.delete(el); };
}

function hideUntil(st, el, ms) {
  const prev = st.reveals.get(el);
  if (prev) prev.cancel();
  const anim = el.animate([{ opacity: 0 }, { opacity: 0, offset: 0.97 }, { opacity: 1 }], { duration: Math.max(60, ms) });
  st.reveals.set(el, anim);
  anim.onfinish = () => { if (st.reveals.get(el) === anim) st.reveals.delete(el); };
}

function popIn(el, delay = 0) {
  el.animate([
    { transform: 'scale(0.35)', opacity: 0, filter: 'brightness(2)' },
    { transform: 'scale(1.12)', opacity: 1, filter: 'brightness(1.4)', offset: 0.6 },
    { transform: 'scale(1)', opacity: 1, filter: 'none' },
  ], { duration: 520, delay, easing: 'cubic-bezier(0.3, 1.3, 0.5, 1)', fill: 'backwards', composite: 'add' });
}

// opts: zones (Map card id -> zone), isPublic(zone), look(id, faceUp) -> { img, name, back, cls }, kindOf(id, from, to),
// intoKind(id, from, to) ('showinto' shows an arriving card big first), showAt() -> rect for a showcase (or null)
export function runFlights(st, root, game, opts) {
  if (!root || typeof document === 'undefined') return;
  if (st.game !== game) { st.game = game; st.prev = new Map(); st.prevEls = new Map(); st.zones = null; }
  const on = motionOn() && !document.hidden;
  const now = new Map();
  const els = new Map();
  const lunging = new Set();
  for (const el of root.querySelectorAll('[data-fly]')) {
    if (el.matches(LEAN)) lunging.add(el);
    // a glide still going: carry on from where the card is drawn right now
    const running = st.flips.get(el);
    let visual = null;
    if (running) { if (running.playState === 'running') visual = rectOf(el); running.cancel(); st.flips.delete(el); }
    const r = rectOf(el);
    if (r.width < 2) continue;
    els.set(el, { r, visual });
    for (const id of el.dataset.fly.split(' ')) if (id && !now.has(id)) now.set(id, { el, r });
  }
  const zones = opts.zones;
  if (on && st.zones) {
    const pileRect = z => {
      if (!z) return null;
      const el = z.startsWith('mon:') ? root.querySelector(`[data-mon="${z.slice(4)}"]`) : root.querySelector(`[data-pile="${z}"]`);
      if (!el) return null;
      const r = rectOf(el);
      return r.width > 1 ? r : null;
    };
    let n = 0;
    const delay = () => Math.min(n * 45, 500);
    const used = new Set();
    // cards on screen now
    for (const [el, { r, visual }] of els) {
      if (n >= MAX_PER_RENDER) break;
      const ids = el.dataset.fly.split(' ').filter(Boolean);
      const before = st.prevEls.get(el);
      if (before) {
        if (!near(visual || before, r) && onScreen(visual || before) && !lunging.has(el) && !st.lunging.has(el)) flip(st, el, visual || before, r);
        // a card joining an element that was already here (a land onto its stack, an evolution onto its Pokémon)
        for (const id of ids) {
          const p = st.prev.get(id);
          if (p && p.el === el) continue;
          const src = p ? p.r : pileRect(st.zones.get(id));
          if (!src || !onScreen(src)) continue;
          used.add(id);
          launch(st, id, cloneOf(el, r), r, src, r, { kind: 'into', delay: delay() }); n++;
        }
      } else {
        const id = ids[0];
        const p = st.prev.get(id);
        const ghost = st.ghosts.get(id);
        const src = ghost && ghost.isConnected ? rectOf(ghost) : p ? p.r : pileRect(st.zones.get(id));
        for (const x of ids) used.add(x);
        if (src && onScreen(src)) {
          // opts.intoKind(id, from, to) may ask for 'showinto': shown big first (the other player's card being played)
          const hold = opts.intoKind && opts.showAt && opts.intoKind(id, st.zones.get(id), zones.get(id)) === 'showinto' ? opts.showAt(r) : null;
          const ms = launch(st, id, cloneOf(el, r), r, src, r, { kind: hold ? 'showinto' : 'into', hold, delay: delay() }); n++;
          hideUntil(st, el, ms);
        } else if (!st.zones.has(id)) { popIn(el, delay()); n++; }
      }
    }
    // cards that left the screen: to the pile of where they went
    const gone = new Set();
    for (const [id, p] of st.prev) {
      if (n >= MAX_PER_RENDER) break;
      if (now.has(id) || used.has(id) || gone.has(p.el)) continue;
      const z = zones.get(id);
      const from = st.zones.get(id);
      gone.add(p.el);
      if (!onScreen(p.r)) continue;
      const dest = pileRect(z);
      const kind = opts.kindOf ? opts.kindOf(id, from, z) : 'move';
      if (dest) {
        const hold = kind === 'show' && opts.showAt ? opts.showAt(p.r) : null;
        launch(st, id, cloneOf(p.el, p.r), p.r, p.r, dest, { kind, hold, delay: delay() }); n++;
      } else if (!z) {
        // gone from the game (a token): it fades where it was
        launch(st, id, cloneOf(p.el, p.r), p.r, p.r, { left: p.r.left + p.r.width * 0.2, top: p.r.top + p.r.height * 0.2, width: p.r.width * 0.6, height: p.r.height * 0.6 }, { kind: 'exile' }); n++;
      }
    }
    // hidden moves: pile to pile
    let hidden = 0;
    for (const [id, z] of zones) {
      if (n >= MAX_PER_RENDER || hidden >= 10) break;
      const pz = st.zones.get(id);
      if (pz === undefined || pz === z || st.prev.has(id) || now.has(id)) continue;
      const a = pileRect(pz), b = pileRect(z);
      if (!a || !b) continue;
      const face = opts.isPublic(pz) || opts.isPublic(z);
      const look = opts.look ? opts.look(id, face) : { back: !face };
      const w = Math.round(58 * uiScale()), h = Math.round(w * 1.4);
      const ca = center(a);
      const home = { left: ca.x - w / 2, top: ca.y - h / 2, width: w, height: h };
      const kind = opts.kindOf ? opts.kindOf(id, pz, z) : 'move';
      const hold = kind === 'show' && opts.showAt ? opts.showAt(home) : null;
      const fit = r => ({ left: center(r).x - w * 0.36, top: center(r).y - h * 0.36, width: w * 0.72, height: h * 0.72 });
      launch(st, id, plainCard(look), home, fit(a), fit(b), { kind: kind === 'show' ? 'show' : 'move', hold, delay: hidden * 70 });
      hidden++; n++;
    }
  }
  st.prev = now;
  st.lunging = lunging;
  st.prevEls = new Map([...els].map(([el, v]) => [el, v.r]));
  st.zones = zones;
}

// a short shake of an element (a big hit)
export function shake(el, strength = 1) {
  if (!el || !motionOn()) return;
  const d = 5 * strength;
  el.animate([{ transform: 'none' }, { transform: `translate(${-d}px, ${d * 0.4}px)` }, { transform: `translate(${d}px, ${-d * 0.4}px)` }, { transform: `translate(${-d * 0.6}px, 0)` }, { transform: `translate(${d * 0.4}px, 0)` }, { transform: 'none' }], { duration: 420, easing: 'ease-out', composite: 'add' });
}

// an attacker swings at its target and comes back
export function strike(el, target) {
  if (!el || !target || !motionOn()) return;
  const a = center(rectOf(el)), b = center(rectOf(target));
  const dx = (b.x - a.x) * 0.32, dy = (b.y - a.y) * 0.32;
  el.animate([
    { transform: 'none' },
    { transform: `translate(${-dx * 0.12}px, ${-dy * 0.12}px) scale(1.04)`, offset: 0.25 },
    { transform: `translate(${dx}px, ${dy}px) scale(1.1)`, offset: 0.5 },
    { transform: 'none' },
  ], { duration: 520, easing: 'ease-in-out', composite: 'add' });
}
