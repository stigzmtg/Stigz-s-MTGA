// Your deck in the One Piece deck builder: the rules check (a Leader and exactly 50 cards, up to 4 of each card number,
// every card in the Leader's colors, no Leaders in the 50: each in plain words, live), a box to add a card by typing
// its name or number (or to paste several), the card list (by type or by cost), the numbers One Piece players look
// at (the cost curve, how many +1000 and +2000 Counters, Triggers, Blockers) and test hands of five.
import { ColorDot } from './colors.jsx';
import { MAX_COPIES, normName } from './decktext.js';
import { cardIndex, keywordsOfCard, CardTile, Cost, CounterTag, CAT_NAME } from './builderfind.jsx';

const { useState, useMemo, useRef } = React;
const sum = (list, f = () => true) => list.reduce((a, [id, n]) => a + (f(id) ? n : 0), 0);

// ---- the rules check: what's still to do in words, one line each; the rules already met as ticks
export function RulesCheck({ rows }) {
  const done = rows.filter(r => r.ok), todo = rows.filter(r => !r.ok);
  return (
    <div className="opb-rules" role="list" aria-label="Deck rules">
      <div className="opb-ruleshead"><span>Deck rules</span><small>{todo.length ? `${done.length} of ${rows.length} done` : 'All good: ready to play'}</small></div>
      {todo.map(r => (
        <div key={r.id} role="listitem" className="opb-rule no" data-rule={r.id}>
          <span className="opb-mark" aria-label="not yet">!</span>
          <span><b>{r.label}</b> <span>{r.text}</span></span>
        </div>
      ))}
      {done.length ? (
        <div className="opb-rulesok">
          {done.map(r => <span key={r.id} role="listitem" className="opb-rule ok" data-rule={r.id} title={r.text}><span className="opb-mark" aria-label="done">✓</span>{r.label}</span>)}
        </div>
      ) : null}
    </div>
  );
}

// ---- add a card by typing its name or number: matches show as you type (in your Leader's colors first); Enter adds
// the one picked. Pasting several lines opens the paste dialog with them, to add to the deck.
export function QuickAdd({ cards, leader, deck, onAdd, onOpen, onPasteList }) {
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const [open, setOpen] = useState(false);
  const input = useRef(null);
  const index = useMemo(() => cardIndex(cards).filter(x => x.c.cat !== 'L'), [cards]);
  const lead = cards[leader];
  const fits = c => !lead || c.colors.some(k => lead.colors.includes(k));
  const k = normName(q), low = q.trim().toLowerCase();
  const matches = useMemo(() => {
    if (k.length < 2 && low.length < 2) return [];
    const out = [];
    for (const x of index) {
      const r = (low.length >= 2 && x.lower.startsWith(low)) || x.key.startsWith(k) ? 0 : x.key.includes(' ' + k) ? 1 : k && x.key.includes(k) ? 2 : -1;
      if (r >= 0) out.push([r, x.c]);
    }
    out.sort((a, b) => a[0] - b[0] || fits(b[1]) - fits(a[1]) || a[1].name.localeCompare(b[1].name) || a[1].id.localeCompare(b[1].id, 'en', { numeric: true }));
    return out.slice(0, 8).map(([, c]) => c);
  }, [k, low, leader]);
  const why = c => (!fits(c) ? 'Not your colors' : (deck.get(c.id) || 0) >= MAX_COPIES ? '4 in your deck' : null);
  const pickOne = c => {
    if (!c || why(c)) return;
    onAdd(c.id);
    setQ(''); setAt(0);
    if (input.current) input.current.focus();
  };
  const key = e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setAt(i => Math.min(matches.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt(i => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); pickOne(matches[at]); }
    else if (e.key === 'Escape') { setQ(''); setOpen(false); }
  };
  const paste = e => {
    const t = e.clipboardData && e.clipboardData.getData('text');
    if (t && /\n\s*\S/.test(t.trim())) { e.preventDefault(); setQ(''); onPasteList(t); }
  };
  const show = open && matches.length > 0;
  return (
    <div className="opb-quickadd">
      <label className="opb-searchbox">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7z" /></svg>
        <input ref={input} className="input" value={q} placeholder="Add a card: type its name or number, or paste a list" aria-label="Add a card by name or number"
          role="combobox" aria-expanded={show} aria-controls="opb-qa-list" aria-autocomplete="list" aria-activedescendant={show ? `opb-qa-${at}` : undefined}
          onChange={e => { setQ(e.target.value); setAt(0); setOpen(true); }} onKeyDown={key} onPaste={paste} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} />
      </label>
      {show ? (
        <ul className="opb-qalist" id="opb-qa-list" role="listbox">
          {matches.map((c, i) => {
            const no = why(c);
            return (
              <li key={c.id} id={`opb-qa-${i}`} role="option" aria-selected={i === at} aria-disabled={!!no} className={`${i === at ? 'on' : ''} ${no ? 'no' : ''}`}
                onMouseDown={e => { e.preventDefault(); if (no) onOpen(c.id); else pickOne(c); }} onMouseEnter={() => setAt(i)}>
                <Cost c={c} />
                <span className="opb-qaname"><b>{c.name}</b><small><ColorDot colors={c.colors} size={10} /> {c.id} · {CAT_NAME[c.cat]}{c.power != null ? ` · ${c.power}` : ''}{c.counter ? ` · +${c.counter}` : ''}</small></span>
                {no ? <em>{no}</em> : deck.get(c.id) ? <em>{deck.get(c.id)} in deck</em> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

// ---- the card list
const TYPE_ORDER = [['C', 'Characters'], ['E', 'Events'], ['S', 'Stages'], ['L', 'Leaders (can’t be in the 50)'], ['?', 'Not in the game']];
const COST_ORDER = ['0–1', '2', '3', '4', '5', '6', '7+'];
const costGroup = c => (!c ? '?' : c.cat === 'L' ? 'L' : c.cost <= 1 ? '0–1' : c.cost >= 7 ? '7+' : String(c.cost));
export function DeckCards({ cards, leader, list, groupBy, setGroupBy, onOpen, onAdd, onRemove, hv }) {
  const lead = cards[leader];
  const groups = useMemo(() => {
    const out = new Map();
    const put = (k, item) => { if (!out.has(k)) out.set(k, []); out.get(k).push(item); };
    const cost = id => (cards[id] && cards[id].cost) || 0;
    for (const [id, n] of list.slice().sort((a, b) => cost(a[0]) - cost(b[0]) || ((cards[a[0]] || {}).name || '').localeCompare((cards[b[0]] || {}).name || '') || a[0].localeCompare(b[0]))) {
      const c = cards[id];
      put(groupBy === 'cost' ? costGroup(c) : c ? c.cat : '?', [id, n]);
    }
    const order = groupBy === 'cost' ? [...COST_ORDER, 'L', '?'] : TYPE_ORDER.map(([k]) => k);
    return order.filter(k => out.has(k)).map(k => [k, out.get(k)]);
  }, [list, groupBy]);
  const label = k => (groupBy === 'cost' && COST_ORDER.includes(k) ? `Cost ${k}` : (TYPE_ORDER.find(([x]) => x === k) || [k, k])[1]);
  return (
    <div className="opb-dlist">
      <div className="opb-dlisttop">
        <div className="seg" role="group" aria-label="Group cards by">
          {[['type', 'Type'], ['cost', 'Cost']].map(([k, l]) => <button key={k} className={groupBy === k ? 'on' : ''} aria-pressed={groupBy === k} onClick={() => setGroupBy(k)}>{l}</button>)}
        </div>
      </div>
      {groups.map(([k, items]) => (
        <div key={k} className="opb-dgroup">
          <div className="opb-dgrouphead"><span>{label(k)}</span><b>{items.reduce((a, [, n]) => a + n, 0)}</b></div>
          {items.map(([id, n]) => {
            const c = cards[id];
            const off = c && lead && c.cat !== 'L' && !c.colors.some(x => lead.colors.includes(x));
            const bad = !c || c.cat === 'L' || off || n > MAX_COPIES;
            return (
              <div key={id} className={`opb-drow ${bad ? 'bad' : ''}`} onMouseEnter={c ? hv.enter(id) : undefined} onMouseLeave={hv.leave}
                title={!c ? 'This game doesn’t have this card' : c.cat === 'L' ? 'Leaders can’t be in the 50' : off ? `Not your Leader’s colors (${lead.colors.join(' or ')})` : n > MAX_COPIES ? 'Up to 4 of each card' : undefined}>
                <b className="opb-n">{n}×</b>
                {c ? <Cost c={c} /> : <span className="opb-cost none" />}
                <button type="button" className="as-btn opb-dname" onClick={() => c && onOpen(id)}>{bad ? <span className="opb-badmark" aria-hidden="true">!</span> : null}{c ? c.name : id}<small>{id}</small></button>
                <span className="opb-pow">{c && c.power != null ? c.power : ''}</span>
                {c ? <CounterTag c={c} /> : <span />}
                <span className="opb-pm">
                  <button className="btn sm ghost" onClick={() => onRemove(id)} aria-label={`One fewer ${c ? c.name : id} (${id})`} title="One fewer">−</button>
                  <button className="btn sm ghost" onClick={() => onAdd(id)} disabled={bad || n >= MAX_COPIES} aria-label={`One more ${c ? c.name : id} (${id})`} title={n >= MAX_COPIES ? '4 is the most' : 'One more'}>+</button>
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ---- the numbers
export function DeckNumbers({ cards, leader, list, starters, onTest }) {
  const lead = cards[leader];
  const of = id => cards[id] || {};
  const curve = Array.from({ length: 11 }, () => [0, 0]);
  for (const [id, n] of list) { const c = of(id); if (c.cost == null) continue; curve[Math.min(10, c.cost)][c.cat === 'C' ? 0 : 1] += n; }
  const peak = Math.max(1, ...curve.map(([a, b]) => a + b));
  const total = sum(list), known = sum(list, id => cards[id] && cards[id].cost != null);
  const avg = known ? list.reduce((a, [id, n]) => a + (of(id).cost || 0) * n, 0) / known : 0;
  const c2 = sum(list, id => of(id).counter === 2000), c1 = sum(list, id => of(id).counter === 1000);
  const none = total - c1 - c2;
  const kw = k => sum(list, id => keywordsOfCard(cards, id).has(k));
  const triggers = sum(list, id => !!of(id).trigger);
  const types = [['C', 'Characters'], ['E', 'Events'], ['S', 'Stages']].map(([k, l]) => [l, sum(list, id => of(id).cat === k)]).filter(([, n]) => n);
  const powers = [['0–2000', c => c.power <= 2000], ['3000–4000', c => c.power >= 3000 && c.power <= 4000], ['5000', c => c.power === 5000], ['6000+', c => c.power >= 6000]]
    .map(([l, f]) => [l, sum(list, id => of(id).cat === 'C' && of(id).power != null && f(of(id)))]);
  return (
    <div className="opb-stats">
      <div className="opb-stat">
        <h4>Cost curve <small>how many cards cost each amount of DON!!</small></h4>
        <div className="opb-curve" aria-label="Cost curve">
          {curve.map(([ch, ot], i) => (
            <span key={i} className="bar" title={`Cost ${i}${i === 10 ? '+' : ''}: ${ch} Character${ch === 1 ? '' : 's'}, ${ot} Event${ot === 1 ? '' : 's'} or Stage${ot === 1 ? '' : 's'}`}>
              <em>{ch + ot || ''}</em>
              <span className="stack" style={{ height: `${(100 * (ch + ot)) / peak}%` }}><i className="ch" style={{ flexGrow: ch }} /><i className="ot" style={{ flexGrow: ot }} /></span>
              <small>{i === 10 ? '10' : i}</small>
            </span>
          ))}
        </div>
        <p className="opb-legend"><i className="ch" /> Characters <i className="ot" /> Events and Stages · Average cost <b>{avg ? avg.toFixed(1) : '–'}</b>. You get 1 or 2 more DON!! each turn, so cheap cards come out first.</p>
      </div>
      <div className="opb-stat">
        <h4>Counters <small>what keeps your Leader safe when you’re attacked</small></h4>
        <div className="opb-ctrbar" aria-hidden="true">{c2 ? <i className="c2" style={{ flexGrow: c2 }} /> : null}{c1 ? <i className="c1" style={{ flexGrow: c1 }} /> : null}{none ? <i className="c0" style={{ flexGrow: none }} /> : null}</div>
        <div className="opb-ctrs">
          <span><b>{c2}</b> with <span className="opb-ctr c2">+2k</span></span>
          <span><b>{c1}</b> with <span className="opb-ctr c1">+1k</span></span>
          <span><b>{none}</b> with no Counter</span>
          <span><b>{kw('Counter')}</b> Counter Event{kw('Counter') === 1 ? '' : 's'}</span>
        </div>
        <p>When you’re attacked you can trash cards from your hand for the +1000 or +2000 on their side. {starters ? <>The starter decks have about <b>{starters.counter}</b> cards with a Counter, <b>{starters.c2}</b> of them +2000.</> : null} {c1 + c2 < 20 && total >= 40 ? 'More Counters would help you survive attacks.' : ''}</p>
      </div>
      <div className="opb-stat">
        <h4>Card types and keywords</h4>
        <div className="opb-chips">
          {types.map(([l, n]) => <span key={l} className="opb-pill"><b>{n}</b> {l}</span>)}
          <span className="opb-pill" title="Cards with a [Trigger]: when one is taken from your Life, you can use it for free"><b>{triggers}</b> Trigger{triggers === 1 ? '' : 's'}</span>
          <span className="opb-pill" title="[Blocker]: can take an attack instead of your Leader"><b>{kw('Blocker')}</b> Blocker{kw('Blocker') === 1 ? '' : 's'}</span>
          <span className="opb-pill" title="[Rush]: can attack the turn it's played"><b>{kw('Rush')}</b> Rush</span>
          {kw('Double Attack') ? <span className="opb-pill"><b>{kw('Double Attack')}</b> Double Attack</span> : null}
        </div>
      </div>
      <div className="opb-stat">
        <h4>Characters by power</h4>
        <div className="opb-chips">{powers.map(([l, n]) => <span key={l} className="opb-pill"><b>{n}</b> at {l}</span>)}</div>
        {lead ? <p>Your Leader has <b>{lead.power}</b> power and <b>{lead.life}</b> Life. An attack hits when its power is at least the defender’s, and most Leaders have 5000, so Characters with 5000 or more can hit a Leader on their own.</p> : null}
      </div>
      <div className="opb-stat">
        <h4>Opening hand</h4>
        <p>You start with 5 cards (and can redraw them once).</p>
        <button className="btn sm" onClick={onTest} disabled={total < 5}>Draw a test hand</button>
      </div>
    </div>
  );
}

// ---- test hands: shuffle, draw five, keep drawing
const shuffle = a => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
export function TestHand({ cards, list, onOpen, hv }) {
  const library = useMemo(() => list.filter(([id]) => cards[id]).flatMap(([id, n]) => Array(n).fill(id)), [list]);
  const key = library.join('|');
  const [shuffled, setShuffled] = useState(() => ({ key, order: shuffle(library) }));
  const [drawn, setDrawn] = useState(5);
  const fresh = () => { setShuffled({ key, order: shuffle(library) }); setDrawn(5); };
  if (library.length < 5) return <div className="empty">Add at least 5 cards to draw a test hand.</div>;
  const stale = shuffled.key !== key;
  const ids = (stale ? [] : shuffled.order).slice(0, drawn);
  const hand = ids.slice(0, 5).map(id => cards[id]);
  const cheap = hand.filter(c => c.cost <= 2).length, ctr = hand.filter(c => c.counter).length;
  const verdict = cheap === 0 ? 'Nothing costs 2 or less: your first turns would be quiet. Many players would redraw this one.'
    : `${cheap} card${cheap === 1 ? '' : 's'} you can play early (cost 2 or less) and ${ctr} with a Counter. ${cheap >= 2 && ctr >= 2 ? 'A good start.' : 'Keepable.'}`;
  return (
    <div className="opb-testhand">
      <div className="opb-thtop">
        <p className={`opb-verdict ${cheap ? 'good' : 'bad'}`}>{stale ? 'Your deck changed: draw a new hand.' : verdict}</p>
        <div className="row">
          <button className="btn sm primary" onClick={fresh}>New hand</button>
          <button className="btn sm" onClick={() => setDrawn(d => d + 1)} disabled={stale || drawn >= library.length}>Draw a card</button>
        </div>
      </div>
      <div className="opb-thcards">
        {ids.map((id, i) => (
          <div key={i} className={`opb-thcard ${i >= 5 ? 'drawn' : ''}`}>
            {i === 5 ? <span className="opb-thturn">Draws</span> : null}
            <CardTile c={cards[id]} onOpen={() => onOpen(id)} onEnter={hv.enter(id)} onLeave={hv.leave} />
          </div>
        ))}
      </div>
      {drawn > 5 ? <p className="note">You’ve drawn {drawn - 5} card{drawn - 5 === 1 ? '' : 's'} after your opening hand: one each turn (the player who goes first doesn’t draw on their first turn).</p> : <p className="note">Your Leader isn’t in the shuffle: it starts in front of you.</p>}
    </div>
  );
}
