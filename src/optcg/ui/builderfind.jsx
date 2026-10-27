// Finding cards in the One Piece deck builder: the card search (by name or words on the card, type, cost, color,
// power, keyword and Counter, as a list or as pictures), the Leader browser (every Leader, by color, with pictures),
// the starter decks to copy, and the cards themselves: pictures that load as they scroll into view (they come in
// packs of about thirty), a big preview beside the mouse, and the card sheet: tap any card to read it, with its
// keywords explained, see how many your deck has, and find the other cards with the same name.
import { opImage, opThumb, subscribeOp, opImagesVersion } from './images.js';
import { OP_COLORS, COLOR_HEX, ColorDot } from './colors.jsx';
import { EffectText, Kw, explain } from './glossary.jsx';
import { Modal } from '../../ui/dialogs.jsx';
import { compileCard } from '../cards.js';
import { MAX_COPIES, normName } from './decktext.js';
import { withLeader } from './decks.js';

const { useState, useMemo, useEffect, useRef, useSyncExternalStore } = React;
const toggle = (set, k) => { const n = new Set(set); if (n.has(k)) n.delete(k); else n.add(k); return n; };
export const CAT_NAME = { L: 'Leader', C: 'Character', E: 'Event', S: 'Stage' };

// ---- what each card is, for searching: its keywords (printed ones, and when its effects happen), worked out once
// from the compiled text (text.js)
export const KEYWORDS = ['Blocker', 'Rush', 'Double Attack', 'Banish', 'On Play', 'When Attacking', 'Activate: Main', 'On K.O.', 'Counter', 'Trigger'];
const TIMING_KW = { onPlay: 'On Play', whenAttacking: 'When Attacking', ko: 'On K.O.' };
function keywordsOf(def) {
  const out = new Set();
  if (def.trigger) out.add('Trigger');
  let abs = [];
  try { abs = compileCard(def).abilities || []; } catch { /* an effect the compiler can't read: no keywords from it */ }
  for (const a of abs) {
    if (a.kind === 'keyword') out.add(a.kw === 'Rush: Character' ? 'Rush' : a.kw);
    if (a.kind === 'auto') for (const t of a.timings || []) if (TIMING_KW[t]) out.add(TIMING_KW[t]);
    if (a.kind === 'activate') out.add('Activate: Main');
    if (a.kind === 'event' && (a.timings || []).includes('counter')) out.add('Counter');
  }
  return out;
}
const indexes = new WeakMap();
export function cardIndex(cards) {
  let ix = indexes.get(cards);
  if (ix) return ix;
  ix = Object.values(cards).map(c => ({
    id: c.id, c, key: normName(c.name), lower: c.id.toLowerCase(), traits: (c.traits || []).join(' / '),
    words: `${c.text || ''} ${c.trigger || ''}`.toLowerCase(), kws: keywordsOf(c),
  })).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  indexes.set(cards, ix);
  return ix;
}
// "Character · Cost 4 · 5000 power · +1000 Counter"
export function cardLine(c) {
  if (c.cat === 'L') return `Leader · ${c.life} Life · ${c.power} power`;
  return [CAT_NAME[c.cat], `Cost ${c.cost}`, c.power != null ? `${c.power} power` : '', c.counter ? `+${c.counter} Counter` : ''].filter(Boolean).join(' · ');
}

// ---- cards as pictures
// true once the element has come near the screen
function useSeen(ref) {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen || !ref.current) return;
    if (typeof IntersectionObserver === 'undefined') { setSeen(true); return; }
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { setSeen(true); io.disconnect(); } }, { rootMargin: '300px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen]);
  return seen;
}
// a card's face: its picture, or its name and numbers on a frame in its color while the picture loads
export function Face({ c, load = true }) {
  useSyncExternalStore(subscribeOp, opImagesVersion);
  const img = c && (load ? opImage(c.id) || opThumb(c.id) : opThumb(c.id));
  if (img) return <div className="op-card"><img src={img} alt={c.name} draggable="false" /></div>;
  return (
    <div className="op-card drawn opb-drawn" style={c ? { background: `linear-gradient(160deg, #f6ead0 30%, ${COLOR_HEX[c.colors[0]] || '#d8c49a'})` } : undefined}>
      {c ? <><b>{c.name}</b><span>{c.cat === 'L' ? `Leader · ${c.life} Life` : `Cost ${c.cost}`}</span>{c.power != null ? <span>{c.power} power</span> : null}</> : null}
    </div>
  );
}
// a card as a picture, loaded when it comes into view
export function CardTile({ c, onOpen, onEnter, onLeave, children, cls = '', label, role }) {
  const ref = useRef(null);
  const seen = useSeen(ref);
  return (
    <div ref={ref} className={`opb-tile ${cls}`} role={role} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <button type="button" className="opb-tilecard" onClick={onOpen} aria-label={label || `${c.name} (${c.id}): details`}>
        {seen ? <Face c={c} /> : <div className="op-card opb-ph" />}
      </button>
      {children}
    </div>
  );
}

// the big preview beside whatever the mouse is on (mouse and trackpad only; a tap opens the card sheet instead)
const canHover = () => typeof matchMedia !== 'undefined' && matchMedia('(hover: hover) and (pointer: fine)').matches;
export function useHoverPreview() {
  const [hover, setHover] = useState(null);
  const enter = id => e => { if (canHover()) setHover({ id, rect: e.currentTarget.getBoundingClientRect() }); };
  const leave = () => setHover(null);
  return { hover, enter, leave, clear: leave };
}
export function HoverCard({ hover, cards }) {
  useSyncExternalStore(subscribeOp, opImagesVersion);
  if (!hover || !cards[hover.id]) return null;
  const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--s')) || 1;
  const W = 250 * scale, H = W * 88 / 63, r = hover.rect, vw = window.innerWidth, vh = window.innerHeight;
  const left = r.right + 14 + W < vw ? r.right + 14 : r.left - 14 - W > 0 ? r.left - 14 - W : Math.max(8, vw - W - 8);
  const top = Math.max(8, Math.min(vh - H - 8, r.top + r.height / 2 - H / 2));
  return <div className="opb-hover" style={{ left, top, width: W }} aria-hidden="true"><Face c={cards[hover.id]} /></div>;
}

function ViewSwitch({ view, setView }) {
  return (
    <div className="seg opb-view" role="group" aria-label="Show as">
      <button className={view === 'grid' ? 'on' : ''} aria-pressed={view === 'grid'} onClick={() => setView('grid')} title="Pictures" aria-label="Pictures"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h7v9H4zm9 0h7v9h-7zM4 15h7v5H4zm9 0h7v5h-7z" /></svg><span>Pictures</span></button>
      <button className={view === 'list' ? 'on' : ''} aria-pressed={view === 'list'} onClick={() => setView('list')} title="List" aria-label="List"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z" /></svg><span>List</span></button>
    </div>
  );
}
const SEARCH_ICON = <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 3a7 7 0 015.6 11.2l4.6 4.6-1.4 1.4-4.6-4.6A7 7 0 1110 3zm0 2a5 5 0 100 10 5 5 0 000-10z" /></svg>;
export const Cost = ({ c }) => (c.cost != null ? <span className="opb-cost" title={`Costs ${c.cost} DON!!`}>{c.cost}</span> : <span className="opb-cost none" />);
// (an empty one keeps its place in a row)
export const CounterTag = ({ c }) => (c.counter ? <span className={`opb-ctr c${c.counter / 1000}`} title={`Counter +${c.counter}: trash it from your hand when you're attacked for +${c.counter} power`}>+{c.counter / 1000}k</span> : <span className="opb-ctr none" />);

// ---- the card search
const TYPES = [['all', 'All'], ['C', 'Characters'], ['E', 'Events'], ['S', 'Stages']];
const COSTS = [['0–1', c => c.cost <= 1], ['2', c => c.cost === 2], ['3', c => c.cost === 3], ['4', c => c.cost === 4], ['5', c => c.cost === 5], ['6', c => c.cost === 6], ['7+', c => c.cost >= 7]];
const POWERS = [['0–2000', c => c.power <= 2000], ['3000', c => c.power === 3000], ['4000', c => c.power === 4000], ['5000', c => c.power === 5000], ['6000+', c => c.power >= 6000]];
const COUNTERS = [['2000', '+2000'], ['1000', '+1000'], ['none', 'No Counter']];
const SORTS = [['cost', 'Cost'], ['power', 'Power'], ['counter', 'Counter'], ['name', 'A to Z'], ['number', 'Card number']];
const KW_LABEL = { Counter: 'Counter Event' };
const kwHelp = k => (k === 'Counter' ? 'Events you can play when you’re attacked' : explain(k));

export function CardSearch({ cards, leader, deck, onAdd, onRemove, onOpen, hv }) {
  const lead = cards[leader];
  const index = useMemo(() => cardIndex(cards), [cards]);
  const [q, setQ] = useState('');
  const [type, setType] = useState('all');
  const [colors, setColors] = useState(() => new Set(lead ? lead.colors : []));
  const [costs, setCosts] = useState(() => new Set());
  const [powers, setPowers] = useState(() => new Set());
  const [kws, setKws] = useState(() => new Set());
  const [counter, setCounter] = useState(() => new Set());
  const [sort, setSort] = useState('cost');
  const [view, setView] = useState(() => { try { return localStorage.getItem('op-builder-view') || 'grid'; } catch { return 'grid'; } });
  const [limit, setLimit] = useState(60);
  const [more, setMore] = useState(false);   // the extra filters, folded away on small screens
  const pickView = v => { setView(v); try { localStorage.setItem('op-builder-view', v); } catch { /* storage blocked */ } };
  // a new Leader: its colors
  useEffect(() => { setColors(new Set(lead ? lead.colors : [])); setLimit(60); }, [leader]);
  const qq = q.trim().toLowerCase(), qn = normName(q);
  const results = useMemo(() => {
    const out = [];
    for (const x of index) {
      const c = x.c;
      if (c.cat === 'L') continue;
      if (type !== 'all' && c.cat !== type) continue;
      if (colors.size && !c.colors.some(k => colors.has(k))) continue;
      if (costs.size && !COSTS.some(([k, f]) => costs.has(k) && f(c))) continue;
      if (powers.size && (c.power == null || !POWERS.some(([k, f]) => powers.has(k) && f(c)))) continue;
      if (counter.size && !counter.has(c.counter ? String(c.counter) : 'none')) continue;
      if (kws.size && ![...kws].every(k => x.kws.has(k))) continue;
      if (qq && !((qn && x.key.includes(qn)) || x.lower.includes(qq) || x.traits.toLowerCase().includes(qq) || (qq.length > 2 && x.words.includes(qq)))) continue;
      out.push(c);
    }
    const by = { cost: (a, b) => a.cost - b.cost, power: (a, b) => (b.power || 0) - (a.power || 0), counter: (a, b) => (b.counter || 0) - (a.counter || 0), name: (a, b) => a.name.localeCompare(b.name), number: () => 0 }[sort];
    return out.sort((a, b) => by(a, b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id, 'en', { numeric: true }));
  }, [qq, type, colors, costs, powers, kws, counter, sort]);
  const extra = costs.size + powers.size + kws.size + counter.size;
  const offColors = lead && [...colors].some(k => !lead.colors.includes(k));
  const clear = () => { setQ(''); setType('all'); setCosts(new Set()); setPowers(new Set()); setKws(new Set()); setCounter(new Set()); setColors(new Set(lead ? lead.colors : [])); setLimit(60); };
  const filtered = extra || q || type !== 'all' || offColors || (lead && colors.size !== lead.colors.length);
  const reset = f => (...a) => { f(...a); setLimit(60); };
  const why = c => (deck.get(c.id) || 0) >= MAX_COPIES ? '4 is the most a deck can have' : lead && !c.colors.some(k => lead.colors.includes(k)) ? `Not your Leader’s colors (${lead.colors.join(' or ')})` : null;
  const addBtn = c => {
    const have = deck.get(c.id) || 0, no = why(c);
    if (have >= MAX_COPIES) return <button className="btn sm in" onClick={() => onOpen(c.id)} title="4 in your deck: the most it can have">✓ 4 in deck</button>;
    return <button className="btn sm" disabled={!!no} title={no || `Add ${c.name} to your deck`} onClick={() => onAdd(c.id)}>{have ? `+ Add (${have})` : '+ Add'}</button>;
  };
  return (
    <div className="opb-find">
      <div className="opb-findtop">
        <label className="opb-searchbox">
          {SEARCH_ICON}
          <input className="input" placeholder="Search names, numbers or words (“Straw Hat”, “draw”)" value={q} onChange={e => reset(setQ)(e.target.value)} aria-label="Search cards" />
        </label>
        <select className="input opb-sort" value={sort} onChange={e => setSort(e.target.value)} aria-label="Sort by" title="Sort by">{SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      </div>
      <div className="opb-frow">
        <div className="seg opb-types" role="group" aria-label="Card type">{TYPES.map(([k, l]) => <button key={k} className={type === k ? 'on' : ''} aria-pressed={type === k} onClick={() => reset(setType)(k)}>{l}</button>)}</div>
        <div className="opb-colors" role="group" aria-label="Colors" title="Cards of these colors">
          {OP_COLORS.map(k => <button key={k} className={`opb-chip color ${colors.has(k) ? 'on' : ''} ${lead && !lead.colors.includes(k) ? 'off' : ''}`} aria-pressed={colors.has(k)} onClick={() => reset(setColors)(s => toggle(s, k))} title={lead && !lead.colors.includes(k) ? `${k} cards (not your Leader’s color: they can’t go in this deck)` : `${k} cards`}><ColorDot colors={k} size={13} /><span>{k}</span></button>)}
        </div>
      </div>
      <div className={`opb-frow opb-costrow ${more ? 'open' : ''}`} role="group" aria-label="Cost">
        <span className="opb-flabel">Cost</span>
        {COSTS.map(([k]) => <button key={k} className={`opb-chip ${costs.has(k) ? 'on' : ''}`} aria-pressed={costs.has(k)} onClick={() => reset(setCosts)(s => toggle(s, k))}>{k}</button>)}
      </div>
      <div className={`opb-filters ${more ? 'open' : ''}`}>
        <div className="opb-frow" role="group" aria-label="Power">
          <span className="opb-flabel">Power</span>
          {POWERS.map(([k]) => <button key={k} className={`opb-chip ${powers.has(k) ? 'on' : ''}`} aria-pressed={powers.has(k)} onClick={() => reset(setPowers)(s => toggle(s, k))}>{k}</button>)}
        </div>
        <div className="opb-frow" role="group" aria-label="Counter">
          <span className="opb-flabel">Counter</span>
          {COUNTERS.map(([k, l]) => <button key={k} className={`opb-chip ${counter.has(k) ? 'on' : ''}`} aria-pressed={counter.has(k)} onClick={() => reset(setCounter)(s => toggle(s, k))} title={k === 'none' ? 'Cards with no Counter on their side' : `Cards you can trash from your hand for ${l} power when you’re attacked`}>{l}</button>)}
        </div>
        <div className="opb-frow" role="group" aria-label="Keywords">
          <span className="opb-flabel">Keyword</span>
          {KEYWORDS.map(k => <button key={k} className={`opb-chip kwchip ${kws.has(k) ? 'on' : ''}`} aria-pressed={kws.has(k)} onClick={() => reset(setKws)(s => toggle(s, k))} title={kwHelp(k)}>{KW_LABEL[k] || k}</button>)}
        </div>
      </div>
      <div className="opb-count">
        <button className={`btn sm ghost opb-more ${more ? 'open' : ''}`} onClick={() => setMore(m => !m)} aria-expanded={more} title="Power, Counter and keywords (Blocker, Rush, Trigger…)">{more ? 'Fewer filters' : `More filters${extra - costs.size > 0 ? ` (${extra - costs.size} on)` : ''}`}</button>
        <span className="opb-countn">{results.length} card{results.length === 1 ? '' : 's'}{filtered ? <> · <button className="linkish" onClick={clear}>Clear filters</button></> : null}</span>
        <ViewSwitch view={view} setView={pickView} />
      </div>
      <div className={`opb-results ${view}`} role="list">
        {view === 'grid'
          ? results.slice(0, limit).map(c => {
            const have = deck.get(c.id) || 0, no = why(c);
            return (
              <CardTile key={c.id} c={c} role="listitem" cls={have ? 'in' : no && !have ? 'no' : ''} onOpen={() => onOpen(c.id)} onEnter={hv.enter(c.id)} onLeave={hv.leave}>
                <div className="opb-tilefoot">
                  {have ? <>
                    <button className="btn sm" onClick={() => onRemove(c.id)} aria-label={`One fewer ${c.name} (${c.id})`}>−</button>
                    <b className="opb-have" aria-label={`${have} in your deck`}>{have}</b>
                    <button className="btn sm" onClick={() => onAdd(c.id)} disabled={!!no} title={no || 'One more'} aria-label={`One more ${c.name} (${c.id})`}>+</button>
                  </> : addBtn(c)}
                </div>
              </CardTile>
            );
          })
          : results.slice(0, limit).map(c => {
            const have = deck.get(c.id) || 0;
            const tags = KEYWORDS.filter(k => cardIndexOf(cards, c.id).kws.has(k) && k !== 'Counter' && k !== 'Trigger').slice(0, 2);
            return (
              <div key={c.id} role="listitem" className={`opb-res ${have ? 'in' : ''}`} onMouseEnter={hv.enter(c.id)} onMouseLeave={hv.leave}>
                <Cost c={c} />
                <button type="button" className="opb-name as-btn" onClick={() => onOpen(c.id)}><b>{c.name}</b><small><ColorDot colors={c.colors} size={10} /> {c.id} · {CAT_NAME[c.cat]}{c.traits && c.traits.length ? ` · ${c.traits.join(' / ')}` : ''}</small></button>
                <span className="opb-tags">{tags.map(k => <span key={k} className="opb-tag">{k}</span>)}{c.trigger ? <span className="opb-tag trig">Trigger</span> : null}</span>
                <span className="opb-pow">{c.power != null ? c.power : ''}</span>
                <CounterTag c={c} />
                {addBtn(c)}
              </div>
            );
          })}
        {!results.length ? <div className="empty">Nothing matches. {filtered ? <button className="linkish" onClick={clear}>Clear the filters</button> : null}</div> : null}
      </div>
      {results.length > limit ? <button className="btn ghost opb-showmore" onClick={() => setLimit(l => l + 60)}>Show more ({results.length - limit} left)</button> : null}
    </div>
  );
}
const byIdIx = new WeakMap();
function cardIndexOf(cards, id) {
  let m = byIdIx.get(cards);
  if (!m) { m = new Map(cardIndex(cards).map(x => [x.id, x])); byIdIx.set(cards, m); }
  return m.get(id);
}
export const keywordsOfCard = (cards, id) => (cardIndexOf(cards, id) || { kws: new Set() }).kws;

// ---- the Leader browser
export function LeaderPicker({ cards, decks, current, onOpen, onChoose, hv }) {
  const [q, setQ] = useState('');
  const [colors, setColors] = useState(() => new Set());
  const starters = useMemo(() => { const m = new Map(); for (const d of decks) for (const l of d.leaders || [d.leader]) if (!m.has(l)) m.set(l, d.code); return m; }, [decks]);
  const qq = normName(q);
  const order = c => OP_COLORS.indexOf(c.colors[0]) * 10 + c.colors.length;
  const list = useMemo(() => Object.values(cards).filter(c => c.cat === 'L'
    && (!colors.size || c.colors.some(k => colors.has(k)))
    && (!qq || normName(c.name).includes(qq) || c.id.toLowerCase().includes(q.trim().toLowerCase()) || (qq.length > 2 && normName(`${c.text} ${(c.traits || []).join(' ')}`).includes(qq))))
    .sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name)), [qq, colors]);
  return (
    <div className="opb-find">
      <p className="note">Your Leader starts the game in front of you, with its Life cards. Its colors decide which cards your deck can use, and its effect gives the deck a plan.</p>
      <div className="opb-findtop">
        <label className="opb-searchbox">
          {SEARCH_ICON}
          <input className="input" placeholder="Search Leaders (“Luffy”, “Navy”, “draw”)" value={q} onChange={e => setQ(e.target.value)} aria-label="Search Leaders" />
        </label>
      </div>
      <div className="opb-colors" role="group" aria-label="Colors">
        {OP_COLORS.map(k => <button key={k} className={`opb-chip color ${colors.has(k) ? 'on' : ''}`} aria-pressed={colors.has(k)} onClick={() => setColors(s => toggle(s, k))} title={`${k} Leaders`}><ColorDot colors={k} size={13} /><span>{k}</span></button>)}
      </div>
      <div className="opb-count"><span>{list.length} Leader{list.length === 1 ? '' : 's'}</span>{colors.size || q ? <button className="linkish" onClick={() => { setQ(''); setColors(new Set()); }}>Show all</button> : null}</div>
      <div className="opb-results grid leaders" role="list">
        {list.map(c => (
          <CardTile key={c.id} c={c} role="listitem" cls={c.id === current ? 'in' : ''} onOpen={() => onOpen(c.id)} onEnter={hv.enter(c.id)} onLeave={hv.leave} label={`${c.name} (${c.id}), Leader: details`}>
            <div className="opb-leadinfo">
              <b>{c.name}</b>
              <span><ColorDot colors={c.colors} size={11} /> {c.colors.join('/')} · {c.life} Life{starters.has(c.id) ? <em className="opb-tag">{starters.get(c.id)}</em> : null}</span>
              <button className="btn sm primary" onClick={() => onChoose(c.id)} disabled={c.id === current}>{c.id === current ? 'Your Leader' : 'Choose'}</button>
            </div>
          </CardTile>
        ))}
        {!list.length ? <div className="empty">No Leader matches.</div> : null}
      </div>
    </div>
  );
}

// ---- a starter deck to copy
export function StarterPicker({ data, onPick, onClose }) {
  const [q, setQ] = useState('');
  const qq = q.trim().toLowerCase();
  const rows = data.decks.flatMap(d => (d.leaders || [d.leader]).map(l => ({ d, l, id: withLeader(d, l) })))
    .filter(({ d, l }) => !qq || `${d.code} ${d.name} ${(data.cards[l] || {}).name}`.toLowerCase().includes(qq));
  return (
    <Modal label="Copy a starter deck" onClose={onClose} cls="opb-pick">
      <h2>Copy a starter deck</h2>
      <p className="sub">Start from a deck as it comes in the box and make it yours. The starter deck stays as it is.</p>
      <input className="input" placeholder="Search by deck, Leader or color" value={q} onChange={e => setQ(e.target.value)} aria-label="Search starter decks" autoFocus />
      <div className="opb-picklist" role="list">
        {rows.map(({ d, l, id }) => { const c = data.cards[l] || {}; return (
          <button key={id} role="listitem" className="opb-pickrow" onClick={() => onPick(d, l)}>
            <ColorDot colors={c.colors || d.colors} size={16} />
            <span><b>{d.code} · {d.name}</b><small>{c.name}{d.leaders ? ' (one of its three Leaders)' : ''} · {(c.colors || d.colors).join('/')}</small></span>
          </button>
        ); })}
        {!rows.length ? <div className="empty">No starter deck matches.</div> : null}
      </div>
      <div className="dlg-actions"><button className="btn" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}

// ---- the card sheet
export function CardSheet({ id, cards, leader, deck, choosing, onClose, onOpen, onAdd, onRemove, onLeader }) {
  const c = cards[id];
  if (!c) return null;
  const lead = cards[leader];
  const have = deck.get(id) || 0;
  const isLeader = c.cat === 'L';
  const off = lead && !isLeader && !c.colors.some(k => lead.colors.includes(k));
  // other cards with the same name: different cards, each with its own number
  const others = Object.values(cards).filter(x => x.name === c.name && x.id !== c.id).sort((a, b) => (a.cat === 'L') - (b.cat === 'L') || a.id.localeCompare(b.id, 'en', { numeric: true }));
  return (
    <Modal label={`${c.name} (${c.id})`} onClose={onClose} cls="opb-sheet">
      <div className="opb-sheetgrid">
        <div className="opb-sheetcard"><Face c={c} /></div>
        <div className="opb-sheetinfo">
          <div>
            <h2>{c.name}</h2>
            <p className="opb-sheetline"><span className="opb-num">{c.id}</span><ColorDot colors={c.colors} size={14} /><span>{c.colors.join(' / ')}</span></p>
            <p className="opb-sheetline">{cardLine(c)}</p>
            {c.traits && c.traits.length ? <p className="opb-sheetline dim">{c.traits.join(' / ')}{c.attr && c.attr.length ? ` · ${c.attr.join(' / ')}` : ''}</p> : null}
          </div>
          {c.text ? <p className="opb-text"><EffectText text={c.text} /></p> : <p className="opb-text dim">No effect: a card for its power{c.counter ? ' and its Counter' : ''}.</p>}
          {c.trigger ? <p className="opb-text"><Kw label="Trigger" cls="trigger">Trigger</Kw> {c.trigger}</p> : null}
          {c.counter ? <p className="opb-explain">Counter +{c.counter}: when you’re attacked, you can trash this card from your hand to give the attacked card +{c.counter} power for that battle.</p> : null}
          {off ? <p className="opb-problem">Not your Leader’s colors ({lead.colors.join(' or ')}), so it can’t go in this deck.</p> : null}
          {isLeader && !choosing && leader !== id ? <p className="opb-explain">This is a Leader: it can lead a deck, but it can’t be one of the 50 cards.</p> : null}
          <div className="opb-sheetacts">
            {isLeader ? (leader === id ? <span className="opb-havecount">Your Leader</span> : <button className="btn primary" onClick={() => { onLeader(id); onClose(); }}>Make it my Leader</button>)
              : !leader ? <span className="note">Choose a Leader first.</span>
                : have ? <>
                  <span className="opb-havecount">{have} in your deck</span>
                  <button className="btn" onClick={() => onRemove(id)}>{have > 1 ? '− One fewer' : 'Take it out'}</button>
                  {have < MAX_COPIES ? <button className="btn" onClick={() => onAdd(id)} disabled={off}>+ One more</button> : <span className="note">4 is the most a deck can have.</span>}
                </> : <button className="btn primary" disabled={off} onClick={() => onAdd(id)}>Add to deck</button>}
          </div>
          {others.length ? (
            <div className="opb-sec">
              <h4>Other cards named {c.name}</h4>
              <p className="note">Each is a different card with its own number and effect.</p>
              <div className="opb-others">
                {others.slice(0, 14).map(x => (
                  <button key={x.id} type="button" className="opb-other" onClick={() => onOpen(x.id)}>
                    <ColorDot colors={x.colors} size={11} /><span className="opb-num">{x.id}</span><span>{x.cat === 'L' ? 'Leader' : `Cost ${x.cost}`}{x.power != null ? ` · ${x.power}` : ''}</span>{deck.get(x.id) ? <b>{deck.get(x.id)} in deck</b> : null}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
      <div className="dlg-actions"><button className="btn" onClick={onClose}>Close</button></div>
    </Modal>
  );
}
