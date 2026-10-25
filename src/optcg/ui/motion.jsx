// One Piece table motion, on top of ui/motion.js (which glides the cards themselves):
//  - DON!! cards keep an identity in the cost area, so a paid one turns sideways where it is, a new one flies in from
//    the DON!! deck, a given one flies over to its Leader or Character, and a returned one flies back to the deck;
//  - power changes (Counters, DON!! given, effects) float up from the card they change;
//  - the attack in progress is drawn as an arrow from the attacker to its target (and a dashed one while you aim).
import { motionOn } from '../../ui/motion.js';

const EASE = 'cubic-bezier(0.22, 0.8, 0.25, 1)';
let seq = 0;

// the cost area's DON!! cards, as ids that persist between renders: { act: [id], rest: [id] }, drawn active first
export function donSlots(store, p) {
  const s = store[p.id] || { act: [], rest: [] };
  const act = p.donActive || 0, rest = p.donRested || 0;
  if (s.act.length === act && s.rest.length === rest) { store[p.id] = s; return s; }
  const A = [...s.act], R = [...s.rest];
  while (A.length < act && R.length > rest) A.push(R.shift());   // set active: the first rested card stands up where it is
  while (R.length < rest && A.length > act) R.unshift(A.pop());  // paid: the last active card turns where it is
  while (A.length > act) A.pop();                                // given to a card, or back to the DON!! deck
  while (R.length > rest) R.pop();
  while (A.length < act) A.push('d' + ++seq);                    // new: from the DON!! deck (or back from a card)
  while (R.length < rest) R.push('d' + ++seq);
  return (store[p.id] = { act: A, rest: R });
}

let layerEl = null;
function layer() {
  if (!layerEl || !layerEl.isConnected) layerEl = document.querySelector('.flylayer');
  if (!layerEl) { layerEl = document.createElement('div'); layerEl.className = 'flylayer'; layerEl.setAttribute('aria-hidden', 'true'); document.body.appendChild(layerEl); }
  return layerEl;
}
const rectOf = el => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; };
const mid = r => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

export function createTableMotion() { return { game: null, last: 0, primed: false, dons: new Map(), cardDon: new Map() }; }

// after every render: DON!! flights and power floats for the events since the last one
export function runTableMotion(st, root, game) {
  if (!root) return;
  // a table opened mid-game (a reload, a watcher, a replay) shows what's there without flying it all in
  if (st.game !== game) { st.game = game; st.last = (game.events || []).reduce((m, e) => Math.max(m, e.id), 0); st.dons = new Map(); st.cardDon = new Map(); st.primed = false; }
  const on = motionOn() && !document.hidden && st.primed;
  st.primed = true;
  const fresh = (game.events || []).filter(e => e.id > st.last);
  if (fresh.length) st.last = fresh[fresh.length - 1].id;
  const card = uid => root.querySelector(`[data-ref="c${uid}"]`);
  const pile = (pid, z) => root.querySelector(`[data-pile="${pid}:${z}"]`);

  // where DON!! went to, and came back from, in this update
  const givenTo = [], backFrom = [];
  for (const e of fresh) if (e.kind === 'give') for (let i = 0; i < (e.n || 1); i++) givenTo.push({ pid: e.pid, uid: e.target });
  const cardDon = new Map();
  for (const p of game.players) for (const c of [p.leader, ...(p.characters || [])].filter(Boolean)) {
    cardDon.set(c.uid, c.don || 0);
    const was = st.cardDon.get(c.uid) || 0;
    for (let i = (c.don || 0); i < was; i++) backFrom.push({ pid: p.id, uid: c.uid });
  }
  // cards that left the field took their DON!! with them
  for (const [uid, n] of st.cardDon) if (!cardDon.has(uid)) for (let i = 0; i < n; i++) backFrom.push({ pid: game.ownerOf ? game.ownerOf(uid) : null, uid });
  st.cardDon = cardDon;

  const now = new Map();
  for (const el of root.querySelectorAll('[data-don]')) now.set(el.dataset.don, { el, r: rectOf(el), pid: +el.dataset.pid, rested: el.classList.contains('rested') });

  if (on) {
    // DON!! that left the cost area
    let k = 0;
    for (const [id, was] of st.dons) {
      if (now.has(id)) continue;
      const i = givenTo.findIndex(g => g.pid === was.pid);
      const target = i >= 0 ? card(givenTo.splice(i, 1)[0].uid) : pile(was.pid, 'dondeck');
      if (target) flyDon(was, rectOf(target), k++ * 70, i >= 0);
    }
    // DON!! that arrived: back from a card, or from the DON!! deck
    k = 0;
    for (const [id, cur] of now) {
      if (st.dons.has(id)) continue;
      const j = backFrom.findIndex(b => b.pid === cur.pid);
      const src = j >= 0 ? card(backFrom.splice(j, 1)[0].uid) : pile(cur.pid, 'dondeck');
      if (!src) continue;
      const a = mid(rectOf(src)), b = mid(cur.r);
      cur.el.animate([
        { transform: `translate(${(a.x - b.x).toFixed(1)}px, ${(a.y - b.y).toFixed(1)}px) scale(0.6)`, opacity: 0.2 },
        { transform: `translate(${((a.x - b.x) * 0.45).toFixed(1)}px, ${((a.y - b.y) * 0.45 - 26).toFixed(1)}px) scale(1.12)`, opacity: 1, offset: 0.55 },
        { transform: 'none', opacity: 1 },
      ], { duration: 560, delay: k++ * 90, easing: EASE, fill: 'backwards', composite: 'add' });
    }
    // power changes float up from their card
    for (const e of fresh) {
      let uid = null, n = 0;
      if (e.kind === 'counter' && e.value) { uid = e.target != null ? e.target : game.battle ? game.battle.blocker || game.battle.target : null; n = e.value; }
      else if (e.kind === 'give' && game.current === e.pid) { uid = e.target; n = 1000 * (e.n || 1); }
      else if (e.kind === 'power' && e.n) { uid = e.card; n = e.n; }
      const el = uid != null && card(uid);
      if (el && n) floatText(rectOf(el), `${n > 0 ? '+' : '−'}${Math.abs(n)}`, n > 0 ? 'up' : 'down');
    }
  }
  st.dons = now;
}

// a DON!! card copy flying from where it was to a card (given) or the DON!! deck (returned)
function flyDon(was, to, delay, given) {
  const g = document.createElement('span');
  g.className = `op-don op-don-ghost ${was.rested ? 'rested' : ''}`;
  const w = was.rested ? was.r.height : was.r.width, h = was.rested ? was.r.width : was.r.height;
  Object.assign(g.style, { position: 'fixed', left: `${was.r.left + was.r.width / 2 - w / 2}px`, top: `${was.r.top + was.r.height / 2 - h / 2}px`, width: `${w}px`, height: `${h}px`, margin: '0', fontSize: `${w * 0.24}px` });
  layer().appendChild(g);
  const a = mid(was.r), b = given ? { x: to.left + to.width * 0.82, y: to.top + to.height * 0.2 } : mid(to);
  const dx = b.x - a.x, dy = b.y - a.y, lift = Math.min(70, Math.hypot(dx, dy) * 0.2);
  const rot = was.rested ? 'rotate(90deg)' : 'rotate(0deg)';
  const anim = g.animate([
    { transform: `translate(0, 0) ${rot} scale(1)`, opacity: 1 },
    { transform: `translate(${(dx * 0.5).toFixed(1)}px, ${(dy * 0.5 - lift).toFixed(1)}px) rotate(-8deg) scale(1.15)`, opacity: 1, offset: 0.5 },
    { transform: `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) rotate(0deg) scale(${given ? 0.55 : 0.8})`, opacity: given ? 0 : 0.3 },
  ], { duration: 620, delay, easing: EASE, fill: 'both' });
  const done = () => g.remove();
  anim.onfinish = done; anim.oncancel = done;
  setTimeout(done, 620 + delay + 400);
}

// "+2000" rising from a card and fading
export function floatText(r, text, cls = 'up') {
  if (!motionOn()) return;
  const el = document.createElement('div');
  el.className = `op-float ${cls}`;
  el.textContent = text;
  Object.assign(el.style, { position: 'fixed', left: `${r.left + r.width / 2}px`, top: `${r.top + r.height * 0.32}px` });
  layer().appendChild(el);
  const anim = el.animate([
    { transform: 'translate(-50%, 6px) scale(0.6)', opacity: 0 },
    { transform: 'translate(-50%, -10px) scale(1.15)', opacity: 1, offset: 0.2 },
    { transform: 'translate(-50%, -22px) scale(1)', opacity: 1, offset: 0.65 },
    { transform: 'translate(-50%, -44px) scale(0.95)', opacity: 0 },
  ], { duration: 1250, easing: 'ease-out', fill: 'both' });
  const done = () => el.remove();
  anim.onfinish = done; anim.oncancel = done;
  setTimeout(done, 1700);
}

// the attack in progress (solid) or being aimed (dashed): a curved arrow over the board, kept on its cards while they
// move (a rAF loop that only runs while there is an arrow)
const { useLayoutEffect, useRef } = React;
export function AttackArrow({ boardRef, from, to, aim }) {
  const svg = useRef(null), path = useRef(null), glow = useRef(null), head = useRef(null);
  const key = from != null && to != null ? `${from}>${to}:${aim ? 1 : 0}` : '';
  useLayoutEffect(() => {
    const board = boardRef.current;
    if (!key || !board || !svg.current) return;
    let raf = 0, last = '', first = true;
    const draw = () => {
      const a = board.querySelector(`[data-ref="c${from}"]`), b = board.querySelector(`[data-ref="c${to}"]`);
      if (a && b) {
        const br = board.getBoundingClientRect(), ar = a.getBoundingClientRect(), tr = b.getBoundingClientRect();
        const p = { x: ar.left + ar.width / 2 - br.left, y: ar.top + ar.height / 2 - br.top };
        const q0 = { x: tr.left + tr.width / 2 - br.left, y: tr.top + tr.height / 2 - br.top };
        const dx = q0.x - p.x, dy = q0.y - p.y, len = Math.hypot(dx, dy) || 1;
        // stop short of the target's middle, so the head sits on the card
        const stop = Math.min(len * 0.25, Math.min(tr.width, tr.height) * 0.28);
        const q = { x: q0.x - dx / len * stop, y: q0.y - dy / len * stop };
        const bend = Math.min(90, len * 0.22) * (dx >= 0 ? 1 : -1);
        const c = { x: (p.x + q.x) / 2 - dy / len * bend, y: (p.y + q.y) / 2 + dx / len * bend };
        const d = `M${p.x.toFixed(1)},${p.y.toFixed(1)} Q${c.x.toFixed(1)},${c.y.toFixed(1)} ${q.x.toFixed(1)},${q.y.toFixed(1)}`;
        if (d !== last) {
          last = d;
          path.current.setAttribute('d', d); glow.current.setAttribute('d', d);
          // the head points along the curve's end
          const ang = Math.atan2(q.y - c.y, q.x - c.x) * 180 / Math.PI;
          head.current.setAttribute('transform', `translate(${q.x.toFixed(1)} ${q.y.toFixed(1)}) rotate(${ang.toFixed(1)})`);
          if (first && motionOn()) {
            first = false;
            const L = path.current.getTotalLength();
            for (const el of [path.current, glow.current]) el.animate([{ strokeDasharray: `${L} ${L}`, strokeDashoffset: L }, { strokeDasharray: `${L} ${L}`, strokeDashoffset: 0 }], { duration: 380, easing: EASE });
            head.current.animate([{ opacity: 0 }, { opacity: 0, offset: 0.7 }, { opacity: 1 }], { duration: 380 });
          }
        }
        svg.current.style.opacity = '';
      } else svg.current.style.opacity = '0';
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [key]);
  if (!key) return null;
  return (
    <svg ref={svg} className={`op-arrow ${aim ? 'aim' : ''}`} aria-hidden="true">
      <path ref={glow} className="glow" />
      <path ref={path} className="line" />
      <g ref={head}><path className="head" d="M4,0 L-14,-10 L-9,0 L-14,10 Z" /></g>
    </svg>
  );
}
