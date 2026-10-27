// Your deck in the Pokémon deck builder: the rules check (each rule a deck must keep, ticked off or explained in
// plain words, with tips that don't stop it playing), a box to add a card by typing its name (or to paste several),
// the card list with a count to step up or down on every card, the numbers (kinds of cards, Energy for the attacks,
// how often an opening hand has a Basic Pokémon) and test hands.
import { Energy } from './energy.jsx';
import { normName, setLabel, isBasicEnergy } from '../decktext.js';
import { deckRules, deckTips, deckCounts, energyMade, energyMissing, handChance, DECK_SIZE } from '../customdecks.js';
import { CardTile, cardKind, cardType } from './buildercard.jsx';

const { useState, useMemo, useRef } = React;

// ---- the rules check: one tile per rule; tap one to read it in plain words
export function RulesCheck({ cards, db, onFind }) {
  const [open, setOpen] = useState(null);
  const rules = useMemo(() => deckRules(cards, db), [cards]);
  const tips = useMemo(() => deckTips(cards, db), [cards]);
  const c = deckCounts(cards, db);
  const row = rules.find(r => r.id === open);
  const done = rules.filter(r => r.ok).length;
  // what to look for to fix a rule
  const find = { basic: ['P', 'Basic', 'Find Basic Pokémon'], size: c.total < DECK_SIZE ? ['all', null, 'Find cards to add'] : null };
  return (
    <div className="checklist pkb-rules">
      <div className="ck-head"><span>Deck rules</span><small>{done === rules.length ? 'Every rule kept' : `${done} of ${rules.length} kept`} · tap one to read it</small></div>
      <div className="ck-grid" role="list">
        {rules.map(r => (
          <button key={r.id} type="button" role="listitem" className={`ckp ${r.ok ? 'good' : 'low'} ${open === r.id ? 'open' : ''}`} onClick={() => setOpen(o => (o === r.id ? null : r.id))} aria-expanded={open === r.id} title={r.text}>
            <span className="ckp-top"><span className="ck-mark" aria-hidden="true">{r.ok ? '✓' : '!'}</span><span className="ckp-label">{r.label}</span></span>
            <span className="ck-num"><b>{r.have}</b></span>
          </button>
        ))}
      </div>
      {row ? (
        <div className="ck-detail">
          <p>{row.text}</p>
          {find[row.id] ? <button type="button" className="btn sm" onClick={() => onFind({ kind: find[row.id][0], sub: find[row.id][1] })}>{find[row.id][2]}</button> : null}
        </div>
      ) : null}
      <div className="pkb-kinds" aria-label="Cards by kind">
        <span className="tchip"><b>{c.P}</b> Pokémon</span>
        <span className="tchip"><b>{c.T}</b> Trainers</span>
        <span className="tchip"><b>{c.E}</b> Energy</span>
      </div>
      {tips.length ? <ul className="pkb-tips">{tips.map(t => <li key={t.id}>{t.text}</li>)}</ul> : null}
    </div>
  );
}

// ---- add a card by name: matches show as you type (names that start with it first, then the most played); Enter
// adds the one picked. Pasting several lines opens the paste dialog with them, to add to the deck.
export function QuickAdd({ entries, have, problemFor, onAdd, onOpen, onPasteList }) {
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const [open, setOpen] = useState(false);
  const input = useRef(null);
  const k = normName(q);
  const matches = useMemo(() => {
    if (k.length < 2) return [];
    const out = [];
    for (const e of entries) {
      const r = e.name.startsWith(k) ? 0 : e.name.includes(' ' + k) ? 1 : e.name.includes(k) ? 2 : -1;
      if (r >= 0) out.push([r, e]);
    }
    out.sort((a, b) => a[0] - b[0] || b[1].plays - a[1].plays || a[1].def.name.localeCompare(b[1].def.name));
    return out.slice(0, 8).map(([, e]) => e);
  }, [k, entries]);
  // (a card that can't go in says why, and stays in the box)
  const pickOne = e => {
    if (!e) return;
    const why = problemFor(e.key);
    onAdd(e.key);
    if (!why) { setQ(''); setAt(0); }
    if (input.current) input.current.focus();
  };
  const key = ev => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); setOpen(true); setAt(i => Math.min(matches.length - 1, i + 1)); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); setAt(i => Math.max(0, i - 1)); }
    else if (ev.key === 'Enter') { ev.preventDefault(); pickOne(matches[at]); }
    else if (ev.key === 'Escape') { setQ(''); setOpen(false); }
  };
  const paste = ev => {
    const t = ev.clipboardData && ev.clipboardData.getData('text');
    if (t && /\n\s*\S/.test(t.trim())) { ev.preventDefault(); setQ(''); onPasteList(t); }
  };
  const show = open && matches.length > 0;
  return (
    <div className="quickadd">
      <label className="searchbox">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7z" /></svg>
        <input ref={input} className="input" value={q} placeholder="Add a card: type its name, or paste a list" aria-label="Add a card by name"
          role="combobox" aria-expanded={show} aria-controls="pk-quickadd-list" aria-autocomplete="list" aria-activedescendant={show ? `pkqa-${at}` : undefined}
          onChange={e => { setQ(e.target.value); setAt(0); setOpen(true); }} onKeyDown={key} onPaste={paste} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} />
      </label>
      {show ? (
        <ul className="qa-list" id="pk-quickadd-list" role="listbox">
          {matches.map((e, i) => {
            const why = problemFor(e.key);
            const n = e.twins.reduce((a, x) => a + (have.get(x) || 0), 0);
            return (
              <li key={e.key} id={`pkqa-${i}`} role="option" aria-selected={i === at} aria-disabled={!!why} className={`${i === at ? 'on' : ''} ${why ? 'no' : ''}`}
                onMouseDown={ev => { ev.preventDefault(); if (why) onOpen(e.key); else pickOne(e); }} onMouseEnter={() => setAt(i)} title={why || ''}>
                <span className="qa-name"><b>{e.def.name}</b><small>{cardKind(e.def)}</small></span>
                {why ? <em>{n ? `${n} in your deck` : 'Can’t add'}</em> : cardType(e.def) ? <Energy type={cardType(e.def)} size={18} /> : <em>{n ? `${n} in deck` : ''}</em>}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

// ---- the card list, in groups, with a count to step on every card
const GROUPS = [['P', 'Pokémon'], ['Supporter', 'Supporters'], ['Item', 'Items'], ['Tool', 'Pokémon Tools'], ['Stadium', 'Stadiums'], ['E', 'Energy']];
const groupOf = d => (d.cat === 'T' ? d.trainer : d.cat);
export function DeckList({ list, ix, problemFor, onOpen, onAdd, onRemove, onFillEnergy, total, hv }) {
  const db = ix.db;
  const makes = useMemo(() => energyMade(list, db), [list]);
  // (more than 4 with one name shows in red)
  const byName = new Map();
  for (const [k, n] of list) if (db[k] && !isBasicEnergy(db[k])) byName.set(db[k].name, (byName.get(db[k].name) || 0) + n);
  const groups = GROUPS.map(([g, label]) => [g, label, list.filter(([k]) => db[k] && groupOf(db[k]) === g)]).filter(([, , rows]) => rows.length);
  const hasMons = list.some(([k]) => db[k] && db[k].cat === 'P');
  return (
    <div className="dlist pkb-list">
      {total < DECK_SIZE && hasMons ? (
        <div className="dlist-top">
          <span className="note">{DECK_SIZE - total} to go.</span>
          <button className="btn sm" onClick={onFillEnergy} title="Fill the empty spots with basic Energy, split by the types your Pokémon’s attacks need">Fill the rest with basic Energy</button>
        </div>
      ) : null}
      {groups.map(([g, label, rows]) => (
        <div key={g} className="dgroup">
          <div className="dgroup-head"><span>{label}</span><b>{rows.reduce((a, [, n]) => a + n, 0)}</b></div>
          {rows.map(([k, n]) => {
            const d = db[k], why = problemFor(k), short = energyMissing(d, makes);
            return (
              <div key={k} className="pkb-row" onMouseEnter={hv.enter(k)} onMouseLeave={hv.leave}>
                <span className="pkb-step">
                  <button className="btn sm" onClick={() => onRemove(k)} aria-label={`One fewer ${d.name}`} title="One fewer">−</button>
                  <b className={(byName.get(d.name) || 0) > 4 ? 'over' : ''}>{n}</b>
                  <button className="btn sm" onClick={() => onAdd(k)} disabled={!!why} aria-label={`One more ${d.name}`} title={why || 'One more'}>+</button>
                </span>
                <button type="button" className="as-btn dname" onClick={() => onOpen(k)}>{d.name}{ix.versions.has(k) ? <small className="pkb-set"> {setLabel(k)}</small> : null}{d.ace ? <small className="pkb-tag">ACE SPEC</small> : d.radiant ? <small className="pkb-tag">Radiant</small> : null}</button>
                {short.length ? <span className="pkb-needs" title={`Its attacks need ${short.join(' and ')} Energy, and nothing in your deck makes it`}>needs {short.map(t => <Energy key={t} type={t} size={14} />)}</span> : <span />}
                {cardType(d) ? <Energy type={cardType(d)} size={17} /> : <span />}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ---- the numbers
export function DeckNumbers({ list, db, total, onTest }) {
  const c = deckCounts(list, db);
  const makes = energyMade(list, db);
  // the Energy each type of attack needs, and the Energy cards that make it
  const need = new Map();
  for (const [k, n] of list) {
    const d = db[k];
    if (!d || d.cat !== 'P') continue;
    for (const t of new Set((d.attacks || []).flatMap(a => a.cost).filter(t => t !== 'Colorless'))) { if (!need.has(t)) need.set(t, []); if (!need.get(t).includes(d.name)) need.get(t).push(d.name); }
  }
  const makers = t => list.filter(([k]) => { const d = db[k]; return d && d.cat === 'E' && (d.provides === t || d.anyType || (d.either && d.either.types.includes(t))); }).reduce((a, [, n]) => a + n, 0);
  const chance = handChance(total, c.basics);
  const kinds = [['basics', 'Basic Pokémon'], ['evo', 'Evolution Pokémon'], ['Supporter', 'Supporters'], ['Item', 'Items'], ['Tool', 'Tools'], ['Stadium', 'Stadiums'], ['basicEnergy', 'Basic Energy'], ['specialEnergy', 'Special Energy']];
  const val = k => (k === 'evo' ? c.P - c.basics : c[k] || 0);
  return (
    <div className="dstats">
      <div className="stat-block">
        <h4>Kinds of cards</h4>
        <div className="typechips">{kinds.filter(([k]) => val(k)).map(([k, l]) => <span key={k} className="tchip"><b>{val(k)}</b> {l}</span>)}</div>
      </div>
      <div className="stat-block">
        <h4>Energy <small>what your attacks need, and the Energy cards that make it</small></h4>
        {need.size ? [...need].map(([t, who]) => {
          const n = makers(t);
          return (
            <div key={t} className={`crow pkb-crow ${makes.has(t) ? '' : 'short'}`}>
              <Energy type={t} size={20} />
              <span className="ctext"><b>{n}</b> Energy card{n === 1 ? '' : 's'} make {t} · needed by {who.slice(0, 3).join(', ')}{who.length > 3 ? ` and ${who.length - 3} more` : ''}{makes.has(t) ? null : <em> Nothing in your deck makes {t} Energy yet.</em>}</span>
            </div>
          );
        }) : <p>Your Pokémon’s attacks only need Colorless Energy{c.P ? '' : ' (add some Pokémon to see more)'}: any Energy pays for those.</p>}
      </div>
      <div className="stat-block">
        <h4>Opening hands</h4>
        {total >= 7 && c.basics ? <p>With <b>{c.basics}</b> Basic Pokémon in {total} cards, about <b>{Math.round(chance * 100)}%</b> of opening hands have one to start with. Without one, you shuffle and draw 7 again (a mulligan), and your opponent may draw an extra card.</p>
          : <p>{c.basics ? 'Add more cards to see this.' : 'Add a Basic Pokémon: you need one to start the game.'}</p>}
        <button className="btn sm" onClick={onTest} disabled={total < 7}>Draw a test hand</button>
      </div>
    </div>
  );
}

// ---- test hands: shuffle, draw seven, keep drawing
const shuffle = a => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
export function TestHand({ list, db, onOpen, hv }) {
  const library = useMemo(() => list.flatMap(([k, n]) => Array(n).fill(k)), [list]);
  const key = library.join('|');
  const [shuffled, setShuffled] = useState(() => ({ key, order: shuffle(library) }));
  const [drawn, setDrawn] = useState(7);
  const fresh = () => { setShuffled({ key, order: shuffle(library) }); setDrawn(7); };
  if (library.length < 7) return <div className="empty">Add at least 7 cards to draw a test hand.</div>;
  // (the deck changed since the shuffle: shuffle again)
  const stale = shuffled.key !== key;
  const cards = (stale ? [] : shuffled.order).slice(0, drawn);
  const hand = cards.slice(0, 7);
  const basics = [...new Set(hand.filter(k => db[k].cat === 'P' && db[k].stage === 'Basic').map(k => db[k].name))];
  const energy = hand.filter(k => db[k].cat === 'E').length;
  const verdict = !basics.length ? 'No Basic Pokémon: this hand is a mulligan (shuffle it back and draw 7 again).'
    : `You can start with ${basics.length > 2 ? `${basics.slice(0, 2).join(', ')} or another Basic Pokémon` : basics.join(' or ')}${energy ? `, and you have ${energy} Energy` : ', but no Energy yet'}.`;
  return (
    <div className="testhand">
      <div className="th-top">
        <p className={`th-verdict ${basics.length ? 'good' : 'bad'}`}>{stale ? 'Your deck changed: draw a new hand.' : verdict}</p>
        <div className="row">
          <button className="btn sm primary" onClick={fresh}>New hand</button>
          <button className="btn sm" onClick={() => setDrawn(d => d + 1)} disabled={stale || drawn >= library.length}>Draw a card</button>
        </div>
      </div>
      <div className="th-cards">
        {cards.map((k, i) => (
          <div key={i} className={`th-card ${i >= 7 ? 'drawn' : ''}`}>
            {i === 7 ? <span className="th-turn">Draws</span> : null}
            <CardTile def={db[k]} onOpen={() => onOpen(k)} onEnter={hv.enter(k)} onLeave={hv.leave} />
          </div>
        ))}
      </div>
      {drawn > 7 ? <p className="note">You’ve drawn {drawn - 7} card{drawn - 7 === 1 ? '' : 's'} after your opening hand, one each turn.</p> : <p className="note">In a game, the next 6 cards would be your Prize cards.</p>}
    </div>
  );
}
