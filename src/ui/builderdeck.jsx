// Your deck in the deck builder: the checklist (each part of a good Commander deck, how many you have and about how
// many to aim for, with what it means and a button to find more), a box to add a card by typing its name (or to paste
// several), the card list (by type, by job or by cost), the numbers (mana curve, color balance, how often an opening hand has the right number of lands) and test hands.
import { BASICS } from './customdecks.js';
import { Pip } from './cardview.jsx';
import { Cost, RoleTags, CardTile, SHORT_ROLE } from './buildercard.jsx';
import { normName } from './decktext.js';

const { useState, useMemo, useRef } = React;
const BASIC_FOR = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' };
const TYPE_ORDER = ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land', 'Other'];
const TYPE_LABEL = { Creature: 'Creatures', Planeswalker: 'Planeswalkers', Battle: 'Battles', Instant: 'Instants', Sorcery: 'Sorceries', Artifact: 'Artifacts', Enchantment: 'Enchantments', Land: 'Lands', Other: 'Other' };
const JOB_ORDER = ['ramp', 'draw', 'removal', 'wipe', 'counter', 'tutor', 'protect', 'recursion'];
const JOB_LABEL = { ramp: 'Ramp', draw: 'Card draw', removal: 'Removal', wipe: 'Board wipes', counter: 'Counterspells', tutor: 'Tutors', protect: 'Protection', recursion: 'Recursion', plan: 'Your commander’s plan', other: 'Everything else', land: 'Lands' };
const STATE_MARK = { good: '✓', short: '•', low: '!', over: '↑' };

// ---- the checklist: one tile per part of the deck; tap one to see what it means and find cards for it
export function Checklist({ recipe, onFind }) {
  const [open, setOpen] = useState(null);
  const row = recipe.rows.find(r => r.id === open);
  const tip = r => (r.state === 'good' ? (r.id === 'land' ? 'Right where it should be.' : 'Covered.') : r.state === 'over' ? 'A few fewer would leave room for spells.' : `Aim for about ${r.want}${r.id === 'plan' ? ' or more' : ''}: ${r.want - r.have} to go.`);
  const done = recipe.rows.filter(r => r.state === 'good').length;
  return (
    <div className="checklist">
      <div className="ck-head"><span>Deck checklist</span><small>{done === recipe.rows.length ? 'Every part covered' : `${done} of ${recipe.rows.length} covered`} · tap one for help</small></div>
      <div className="ck-grid" role="list">
        {recipe.rows.map(r => (
          <button key={r.id} type="button" role="listitem" className={`ckp ${r.state} ${open === r.id ? 'open' : ''}`} onClick={() => setOpen(o => (o === r.id ? null : r.id))} aria-expanded={open === r.id} title={`${r.label}: ${r.have} of about ${r.want}`}>
            <span className="ckp-top"><span className="ck-mark" aria-hidden="true">{STATE_MARK[r.state]}</span><span className="ckp-label">{r.label}</span></span>
            <span className="ckp-low"><span className="ck-num"><b>{r.have}</b>/{r.want}</span><span className="ck-bar" aria-hidden="true"><i style={{ width: Math.min(100, (100 * r.have) / Math.max(1, r.want)) + '%' }} /></span></span>
          </button>
        ))}
      </div>
      {row ? (
        <div className="ck-detail">
          <p><b>{row.label}.</b> {row.help} <b>{tip(row)}</b></p>
          <button type="button" className="btn sm" onClick={() => onFind(row.id)}>Find {row.id === 'plan' ? 'cards for the plan' : row.label.toLowerCase()}</button>
        </div>
      ) : null}
    </div>
  );
}

// ---- add a card by name: matches show as you type (names that start with it first, then most played); Enter adds
// the one picked. Pasting several lines opens the paste dialog with them, to add to the deck.
export function QuickAdd({ index, H, state, identity, onAdd, onOpen, onPasteList }) {
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const [open, setOpen] = useState(false);
  const input = useRef(null);
  const names = useMemo(() => index.filter(c => c.main !== 'Other').map(c => [normName(c.name), c]), [index]);
  const k = normName(q);
  const matches = useMemo(() => {
    if (k.length < 2) return [];
    const out = [];
    for (const [n, c] of names) {
      if (state.commanders.includes(c.name)) continue;
      const r = n.startsWith(k) ? 0 : n.includes(' ' + k) || n.includes(',' + k) ? 1 : n.includes(k) ? 2 : -1;
      if (r >= 0) out.push([r, c]);
    }
    const pop = c => (H.feats.get(c.name) || { pop: 0 }).pop;
    out.sort((a, b) => a[0] - b[0] || pop(b[1]) - pop(a[1]) || a[1].name.localeCompare(b[1].name));
    return out.slice(0, 8).map(([, c]) => c);
  }, [k, names, state.commanders]);
  const offColor = c => c.ci.some(x => !identity.includes(x));
  const inDeck = c => !!state.cards.get(c.name) && !c.anyNumber;
  const pickOne = c => {
    if (!c || offColor(c) || inDeck(c)) return;
    onAdd(c.name);
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
    <div className="quickadd">
      <label className="searchbox">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7z" /></svg>
        <input ref={input} className="input" value={q} placeholder="Add a card: type its name, or paste a list" aria-label="Add a card by name"
          role="combobox" aria-expanded={show} aria-controls="quickadd-list" aria-autocomplete="list" aria-activedescendant={show ? `qa-${at}` : undefined}
          onChange={e => { setQ(e.target.value); setAt(0); setOpen(true); }} onKeyDown={key} onPaste={paste} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} />
      </label>
      {show ? (
        <ul className="qa-list" id="quickadd-list" role="listbox">
          {matches.map((c, i) => {
            const why = offColor(c) ? 'Not your colors' : inDeck(c) ? 'In your deck' : null;
            return (
              <li key={c.name} id={`qa-${i}`} role="option" aria-selected={i === at} aria-disabled={!!why} className={`${i === at ? 'on' : ''} ${why ? 'no' : ''}`}
                onMouseDown={e => { e.preventDefault(); if (why) onOpen(c.name); else pickOne(c); }} onMouseEnter={() => setAt(i)}>
                <span className="qa-name"><b>{c.name}</b><small>{c.type}</small></span>
                {why ? <em>{why}</em> : <Cost cost={c.cost} />}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

// ---- the card list
export function DeckList({ H, byName, state, list, rank, groupBy, setGroupBy, identity, onOpen, onAdd, onRemove, onFillLands, total, hv }) {
  const groups = useMemo(() => {
    const out = new Map();
    const put = (k, item) => { if (!out.has(k)) out.set(k, []); out.get(k).push(item); };
    for (const [n, k] of list) {
      const c = byName.get(n) || { main: 'Other', cmc: 0, cost: [] };
      if (groupBy === 'type') put(c.main, [n, k]);
      else if (c.main === 'Land') put(groupBy === 'cost' ? 'Lands' : 'land', [n, k]);
      else if (groupBy === 'cost') put(c.cmc >= 7 ? '7+' : c.cmc <= 1 ? '0–1' : String(c.cmc), [n, k]);
      else { const roles = H.roleOf(n); const job = JOB_ORDER.find(r => roles.includes(r)); put(job || (rank && rank.get(n) && rank.get(n).plan ? 'plan' : 'other'), [n, k]); }
    }
    const order = groupBy === 'type' ? TYPE_ORDER : groupBy === 'cost' ? ['0–1', '2', '3', '4', '5', '6', '7+', 'Lands'] : ['plan', ...JOB_ORDER, 'other', 'land'];
    return order.filter(k => out.has(k)).map(k => [k, out.get(k)]);
  }, [list, groupBy, rank]);
  const label = k => (groupBy === 'type' ? TYPE_LABEL[k] : groupBy === 'cost' ? (k === 'Lands' ? 'Lands' : `Costs ${k}`) : JOB_LABEL[k]);
  const basics = identity.length ? identity.map(c => BASIC_FOR[c]) : ['Wastes'];
  const isLandGroup = k => k === 'Land' || k === 'Lands' || k === 'land';
  return (
    <div className="dlist">
      <div className="dlist-top">
        <div className="seg" role="group" aria-label="Group cards by">
          {[['type', 'Type'], ['job', 'Job'], ['cost', 'Cost']].map(([k, l]) => <button key={k} className={groupBy === k ? 'on' : ''} aria-pressed={groupBy === k} onClick={() => setGroupBy(k)}>{l}</button>)}
        </div>
        {total < 100 ? <button className="btn sm" onClick={onFillLands} title="Fill the empty slots with basic lands, split by the colors your spells need">Fill the rest with basic lands</button> : null}
      </div>
      {!groups.some(([k]) => isLandGroup(k)) ? <Basics basics={basics} state={state} onAdd={onAdd} onRemove={onRemove} /> : null}
      {groups.map(([k, items]) => (
        <div key={k} className="dgroup">
          <div className="dgroup-head"><span>{label(k)}</span><b>{items.reduce((a, [, n]) => a + n, 0)}</b></div>
          {isLandGroup(k) ? <Basics basics={basics} state={state} onAdd={onAdd} onRemove={onRemove} /> : null}
          {items.filter(([n]) => !BASICS.has(n)).map(([n, k2]) => {
            const c = byName.get(n);
            return (
              <div key={n} className="drow" onMouseEnter={hv.enter(n)} onMouseLeave={hv.leave}>
                <button type="button" className="as-btn dname" onClick={() => onOpen(n)}>{k2 > 1 ? <b>{k2}× </b> : null}{n}</button>
                {groupBy === 'job' ? null : <RoleTags roles={H.roleOf(n)} max={1} />}
                <Cost cost={c ? c.cost : []} />
                <button className="btn sm ghost dminus" onClick={() => onRemove(n)} aria-label={`Remove ${n}`} title="Remove">−</button>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
function Basics({ basics, state, onAdd, onRemove }) {
  return (
    <div className="basics">
      {basics.map(land => (
        <span key={land} className="basic">
          <span>{land}</span>
          <button className="btn sm" onClick={() => onRemove(land)} disabled={!state.cards.get(land)} aria-label={`One fewer ${land}`}>−</button>
          <b>{state.cards.get(land) || 0}</b>
          <button className="btn sm" onClick={() => onAdd(land)} aria-label={`One more ${land}`}>+</button>
        </span>
      ))}
    </div>
  );
}

// ---- the numbers
// the chance an opening hand of 7 has from `lo` to `hi` lands (drawing from `deck` cards, `lands` of them lands)
function handOdds(deck, lands, lo = 2, hi = 4) {
  const choose = (n, k) => { if (k < 0 || k > n) return 0; let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; };
  const all = choose(deck, 7);
  if (!all) return 0;
  let p = 0;
  for (let k = lo; k <= hi; k++) p += (choose(lands, k) * choose(deck - lands, 7 - k)) / all;
  return p;
}
export function DeckStats({ H, byName, state, list, recipe, total, onTest }) {
  const mana = useMemo(() => H.manaStats(state), [state]);
  const curve = Array.from({ length: 8 }, () => [0, 0]);
  const types = {};
  for (const [n, k] of list) {
    const c = byName.get(n);
    if (!c) continue;
    types[c.main] = (types[c.main] || 0) + k;
    if (c.main !== 'Land') curve[Math.min(7, c.cmc)][c.main === 'Creature' ? 0 : 1] += k;
  }
  const peak = Math.max(1, ...curve.map(([a, b]) => a + b));
  const deck = total - state.commanders.length;
  const lands = types.Land || 0;
  const odds = deck >= 7 ? handOdds(deck, lands) : 0;
  const avg = recipe.avg;
  return (
    <div className="dstats">
      <div className="stat-block">
        <h4>Mana curve <small>how many spells cost each amount</small></h4>
        <div className="curve2" aria-label="Mana curve">
          {curve.map(([cr, ot], i) => (
            <span key={i} className="bar" title={`Mana value ${i}${i === 7 ? '+' : ''}: ${cr} creature${cr === 1 ? '' : 's'}, ${ot} other`}>
              <em>{cr + ot || ''}</em>
              <span className="stack" style={{ height: `${(100 * (cr + ot)) / peak}%` }}><i className="cr" style={{ flexGrow: cr }} /><i className="ot" style={{ flexGrow: ot }} /></span>
              <small>{i === 7 ? '7+' : i}</small>
            </span>
          ))}
        </div>
        <p className="legend"><i className="cr" /> Creatures <i className="ot" /> Other spells · Average cost <b>{avg ? avg.toFixed(1) : '–'}</b> {avg ? (avg > 3.8 ? '(high: early turns may be slow)' : avg < 2.6 ? '(low and fast)' : '(about right)') : ''}</p>
      </div>
      <div className="stat-block">
        <h4>Card types</h4>
        <div className="typechips">{TYPE_ORDER.filter(t => types[t]).map(t => <span key={t} className="tchip"><b>{types[t]}</b> {TYPE_LABEL[t]}</span>)}</div>
      </div>
      {mana.colors.length ? (
        <div className="stat-block">
          <h4>Colors <small>what your spells need, and the lands that make it</small></h4>
          {mana.colors.map(c => (
            <div key={c.color} className={`crow ${c.short ? 'short' : ''}`}>
              <Pip s={c.color} />
              <span className="cshare"><i style={{ width: `${Math.round(c.share * 100)}%` }} /></span>
              <span className="ctext">{Math.round(c.share * 100)}% of your mana symbols · <b>{c.sources}</b> land{c.sources === 1 ? '' : 's'} make {c.name}{c.short ? <em> Aim for about {c.want}: swap a few other basics for {BASIC_FOR[c.color]}s, or add lands that make two colors.</em> : null}</span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="stat-block">
        <h4>Opening hands</h4>
        {deck >= 7 ? <p>With <b>{lands}</b> lands in {deck} cards, about <b>{Math.round(odds * 100)}%</b> of opening hands have 2 to 4 lands (a hand you can keep). {odds < 0.7 ? (lands < 34 ? 'More lands would help.' : 'Fewer lands would help.') : 'That’s healthy.'}</p> : <p>Add more cards to see this.</p>}
        <button className="btn sm" onClick={onTest} disabled={deck < 7}>Draw a test hand</button>
      </div>
    </div>
  );
}

// ---- test hands: shuffle, draw seven, keep drawing
const shuffle = a => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
export function TestHand({ H, db, byName, state, list, onOpen, hv }) {
  const library = useMemo(() => list.flatMap(([n, k]) => Array(k).fill(n)), [list]);
  const key = library.join('|');
  const [shuffled, setShuffled] = useState(() => ({ key, order: shuffle(library) }));
  const [drawn, setDrawn] = useState(7);
  const fresh = () => { setShuffled({ key, order: shuffle(library) }); setDrawn(7); };
  if (library.length < 7) return <div className="empty">Add at least 7 cards to draw a test hand.</div>;
  // (the deck changed since the shuffle: shuffle again)
  const stale = shuffled.key !== key;
  const cards = (stale ? [] : shuffled.order).slice(0, drawn);
  const hand = cards.slice(0, 7);
  const lands = hand.filter(n => (byName.get(n) || {}).main === 'Land').length;
  const ramp = hand.filter(n => H.roleOf(n).includes('ramp')).length;
  const verdict = lands <= 1 ? `Only ${lands} land${lands === 1 ? '' : 's'}: most players would mulligan (shuffle and draw a new seven).`
    : lands === 2 ? `2 lands${ramp ? ` and ${ramp} ramp` : ''}: keepable if your spells are cheap.`
      : lands <= 4 ? `A good hand: ${lands} lands and ${7 - lands} spells${ramp ? `, ${ramp} of them ramp` : ''}.`
        : lands === 5 ? '5 lands: a little heavy, but keepable.' : `${lands} lands: too many. Mulligan this one.`;
  return (
    <div className="testhand">
      <div className="th-top">
        <p className={`th-verdict ${lands >= 2 && lands <= 5 ? 'good' : 'bad'}`}>{stale ? 'Your deck changed: draw a new hand.' : verdict}</p>
        <div className="row">
          <button className="btn sm primary" onClick={fresh}>New hand</button>
          <button className="btn sm" onClick={() => setDrawn(d => d + 1)} disabled={stale || drawn >= library.length}>Draw a card</button>
        </div>
      </div>
      <div className="th-cards">
        {cards.map((n, i) => (
          <div key={i} className={`th-card ${i >= 7 ? 'drawn' : ''}`}>
            {i === 7 ? <span className="th-turn">Draws</span> : null}
            <CardTile def={db.get(n)} onOpen={() => onOpen(n)} onEnter={hv.enter(n)} onLeave={hv.leave} />
          </div>
        ))}
      </div>
      {drawn > 7 ? <p className="note">Turn {drawn - 7 + 1}: you’ve drawn {drawn - 7} card{drawn - 7 === 1 ? '' : 's'} after your opening hand.</p> : <p className="note">Your commander isn’t in the shuffle: it waits in the command zone.</p>}
    </div>
  );
}
export { JOB_LABEL, SHORT_ROLE };
