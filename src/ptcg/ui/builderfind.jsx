// Finding cards in the Pokémon deck builder: the card search (by name or by what a card says, Pokémon by stage,
// Trainers by kind, Energy, and by type), as pictures or a list, most played first; and the tournament decks to start from.
import { Modal } from '../../ui/dialogs.jsx';
import { Energy } from './energy.jsx';
import { pkImage, subscribePk, pkImagesVersion } from './images.js';
import { normName, setLabel, isBasicEnergy } from '../decktext.js';
import { CardTile, cardKind, cardType } from './buildercard.jsx';

const { useState, useMemo, useEffect, useSyncExternalStore } = React;
const KINDS = [['all', 'All cards'], ['P', 'Pokémon'], ['T', 'Trainers'], ['E', 'Energy']];
// the finer kinds of each
const SUBS = {
  P: [['Basic', 'Basic'], ['Stage1', 'Stage 1'], ['Stage2', 'Stage 2'], ['rule', 'ex, V and Mega']],
  T: [['Supporter', 'Supporter'], ['Item', 'Item'], ['Tool', 'Tool'], ['Stadium', 'Stadium'], ['ace', 'ACE SPEC']],
  E: [['basic', 'Basic Energy'], ['special', 'Special Energy']],
};
const SUB_HELP = {
  Basic: 'Basic Pokémon go straight onto the table', Stage1: 'Evolve from a Basic Pokémon', Stage2: 'Evolve from a Stage 1 Pokémon', rule: 'Strong Pokémon that give your opponent extra Prize cards',
  Supporter: 'One Supporter a turn', Item: 'As many Items a turn as you like', Tool: 'Attach to a Pokémon to help it', Stadium: 'Stays in play for both players', ace: 'Extra strong: only 1 in a deck',
  basic: 'As many as you like', special: 'Energy with an extra effect',
};
export const TYPES = ['Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal', 'Dragon', 'Colorless'];
const SORTS = [['popular', 'Most played'], ['name', 'A to Z'], ['hp', 'Most HP']];
const toggle = (set, k) => { const n = new Set(set); if (n.has(k)) n.delete(k); else n.add(k); return n; };
const subOf = (d, s) => (d.cat === 'P' ? (s === 'rule' ? !!(d.ex || d.v || d.mega) : d.stage === s || (s === 'Stage2' && d.stage === 'VSTAR'))
  : d.cat === 'T' ? (s === 'ace' ? !!d.ace : d.trainer === s) : s === 'basic' ? isBasicEnergy(d) : !isBasicEnergy(d));

function ViewSwitch({ view, setView }) {
  return (
    <div className="seg view-switch" role="group" aria-label="Show as">
      <button className={view === 'grid' ? 'on' : ''} aria-pressed={view === 'grid'} onClick={() => setView('grid')} title="Pictures"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h7v9H4zm9 0h7v9h-7zM4 15h7v5H4zm9 0h7v5h-7z" /></svg>Pictures</button>
      <button className={view === 'list' ? 'on' : ''} aria-pressed={view === 'list'} onClick={() => setView('list')} title="List"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z" /></svg>List</button>
    </div>
  );
}

// one entry per card the search can show: reprints (the same card printed again) show once, as the print most decks play
export function searchIndex(ix) {
  const out = [], done = new Set();
  for (const def of Object.values(ix.db)) {
    if (done.has(def.key)) continue;
    const twins = ix.twins.get(def.key) || [def.key];
    twins.forEach(k => done.add(k));
    const key = twins.slice().sort((a, b) => (ix.plays.get(b) || 0) - (ix.plays.get(a) || 0))[0];
    const d = ix.db[key];
    const words = [d.type, d.provides, cardKind(d), ...(d.abilities || []).flatMap(a => [a.name, a.text]), ...(d.attacks || []).flatMap(a => [a.name, a.text]), d.text].filter(Boolean).join(' ');
    out.push({ key, twins, def: d, name: normName(d.name), text: normName(words), plays: twins.reduce((a, k) => a + (ix.plays.get(k) || 0), 0) });
  }
  return out.sort((a, b) => a.def.name.localeCompare(b.def.name));
}

// ---- the card search
export function CardSearch({ ix, entries, have, onAdd, onRemove, onOpen, problemFor, hv, req }) {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('all');
  const [subs, setSubs] = useState(() => new Set());
  const [types, setTypes] = useState(() => new Set());
  const [sort, setSort] = useState('popular');
  const [view, setView] = useState(() => { try { return localStorage.getItem('pk-builder-view') || 'grid'; } catch { return 'grid'; } });
  const [limit, setLimit] = useState(48);
  const [more, setMore] = useState(false);   // the finer filters, folded away on small screens
  const pickView = v => { setView(v); try { localStorage.setItem('pk-builder-view', v); } catch { /* storage blocked */ } };
  // a request from the deck panel: "find Basic Pokémon", "find Energy"
  useEffect(() => {
    if (!req) return;
    setQ(''); setLimit(48); setTypes(new Set()); setSort('popular');
    setKind(req.kind || 'all'); setSubs(new Set(req.sub ? [req.sub] : []));
  }, [req]);
  const countOf = e => e.twins.reduce((a, k) => a + (have.get(k) || 0), 0);
  const qq = normName(q);
  const results = useMemo(() => {
    const out = entries.filter(e => {
      const d = e.def;
      if (kind !== 'all' && d.cat !== kind) return false;
      if (subs.size && kind !== 'all' && ![...subs].some(s => subOf(d, s))) return false;
      if (types.size && !types.has(cardType(d)) && !(d.anyType && types.size)) return false;
      return !qq || e.name.includes(qq) || (qq.length > 2 && e.text.includes(qq));
    });
    // (a name match first when searching)
    const named = e => (qq && e.name.includes(qq) ? 0 : 1);
    if (sort === 'popular') out.sort((a, b) => named(a) - named(b) || b.plays - a.plays || a.def.name.localeCompare(b.def.name));
    else if (sort === 'hp') out.sort((a, b) => named(a) - named(b) || (b.def.hp || 0) - (a.def.hp || 0) || a.def.name.localeCompare(b.def.name));
    else out.sort((a, b) => named(a) - named(b) || a.def.name.localeCompare(b.def.name));
    return out;
  }, [qq, kind, subs, types, sort, entries]);

  const pickKind = k => { setKind(k); setSubs(new Set()); if (k === 'T') setTypes(new Set()); setLimit(48); };
  const filtersOn = subs.size + types.size + (kind !== 'all' ? 1 : 0);
  const clear = () => { setKind('all'); setSubs(new Set()); setTypes(new Set()); setQ(''); };
  const addBtn = e => {
    const n = countOf(e), why = problemFor(e.key);
    if (why && n) return <button className="btn sm in" onClick={() => onOpen(e.key)} title={why}>✓ {n} in deck</button>;
    return <button className="btn sm" disabled={!!why} title={why || 'Add to deck'} onClick={() => onAdd(e.key)}>{n ? `+ Add (${n})` : '+ Add'}</button>;
  };
  const twinLabel = e => (ix.versions.has(e.key) ? <span className="pkb-set">{setLabel(e.key)}</span> : null);
  return (
    <div className="bfind pkb-find">
      <div className="bfind-top">
        <label className="searchbox">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 3a7 7 0 015.6 11.2l4.6 4.6-1.4 1.4-4.6-4.6A7 7 0 1110 3zm0 2a5 5 0 100 10 5 5 0 000-10z" /></svg>
          <input className="input" placeholder="Search names or what cards do (“draw”, “Pikachu”)" value={q} onChange={e => { setQ(e.target.value); setLimit(48); }} aria-label="Search cards" />
        </label>
        <select className="input sortsel" value={sort} onChange={e => setSort(e.target.value)} aria-label="Sort by">{SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <ViewSwitch view={view} setView={pickView} />
      </div>
      <div className="seg btypes" role="group" aria-label="Kind of card">{KINDS.map(([k, l]) => <button key={k} className={kind === k ? 'on' : ''} aria-pressed={kind === k} onClick={() => pickKind(k)}>{l}</button>)}</div>
      <button className={`btn sm ghost morefilters ${more ? 'open' : ''}`} onClick={() => setMore(m => !m)} aria-expanded={more}>{more ? 'Fewer filters' : `More filters${subs.size + types.size ? ` (${subs.size + types.size})` : ''}`}</button>
      <div className={`bfilters ${more ? 'open' : ''}`}>
        {SUBS[kind] ? (
          <div className="frow" role="group" aria-label="Which kind">
            <span className="flabel">{kind === 'P' ? 'Stage' : 'Kind'}</span>
            {SUBS[kind].map(([k, l]) => <button key={k} className={`fchip ${subs.has(k) ? 'on' : ''}`} aria-pressed={subs.has(k)} title={SUB_HELP[k]} onClick={() => { setSubs(s => toggle(s, k)); setLimit(48); }}>{l}</button>)}
          </div>
        ) : null}
        {kind !== 'T' ? (
          <div className="frow" role="group" aria-label="Type">
            <span className="flabel">Type</span>
            {TYPES.filter(t => kind !== 'E' || t !== 'Dragon').map(t => <button key={t} className={`fchip pipchip ${types.has(t) ? 'on' : ''}`} aria-pressed={types.has(t)} title={`${t} ${kind === 'E' ? 'Energy' : kind === 'P' ? 'Pokémon' : 'cards'}`} onClick={() => { setTypes(s => toggle(s, t)); setLimit(48); }}><Energy type={t} size={18} /><span>{t}</span></button>)}
          </div>
        ) : null}
      </div>
      <div className="bcount"><span>{results.length} card{results.length === 1 ? '' : 's'}{sort === 'popular' ? ', most played first' : ''}</span>{filtersOn || q ? <button className="linkish" onClick={clear}>Clear filters</button> : null}</div>
      <div className={`bresults ${view}`} role="list">
        {view === 'grid'
          ? results.slice(0, limit).map(e => {
            const n = countOf(e), why = problemFor(e.key);
            return (
              <CardTile key={e.key} def={e.def} count={n} cls={n ? 'in' : ''} onOpen={() => onOpen(e.key)} onEnter={hv.enter(e.key)} onLeave={hv.leave}>
                <div className="tile-foot">
                  {n ? <span className="pkb-step">
                    <button className="btn sm" onClick={() => onRemove(e.twins.find(k => have.get(k)) || e.key)} aria-label={`One fewer ${e.def.name}`}>−</button>
                    <b>{n}</b>
                    <button className="btn sm" onClick={() => onAdd(e.key)} disabled={!!why} title={why || ''} aria-label={`One more ${e.def.name}`}>+</button>
                  </span> : addBtn(e)}
                </div>
              </CardTile>
            );
          })
          : results.slice(0, limit).map(e => (
            <div key={e.key} role="listitem" className={`bres pkb-res ${countOf(e) ? 'in' : ''}`} onMouseEnter={hv.enter(e.key)} onMouseLeave={hv.leave}>
              <button type="button" className="bname as-btn" onClick={() => onOpen(e.key)}><b>{e.def.name}</b><small>{cardKind(e.def)}</small></button>
              {twinLabel(e) || <span />}
              {cardType(e.def) ? <Energy type={cardType(e.def)} size={18} /> : <span />}
              {addBtn(e)}
            </div>
          ))}
        {!results.length ? <div className="empty">Nothing matches. {filtersOn || q ? <button className="linkish" onClick={clear}>Clear the filters</button> : null}</div> : null}
      </div>
      {results.length > limit ? <button className="btn ghost more" onClick={() => setLimit(l => l + 48)}>Show more ({results.length - limit} left)</button> : null}
    </div>
  );
}

// ---- a tournament deck to start from
export function DeckPicker({ decks, db, onPick, onClose }) {
  useSyncExternalStore(subscribePk, pkImagesVersion);
  const [q, setQ] = useState('');
  const qq = normName(q);
  const list = decks.filter(d => !d.custom && (!qq || normName(d.name).includes(qq) || d.cards.some(([k]) => db[k] && normName(db[k].name).includes(qq))));
  return (
    <Modal label="Start from a tournament deck" onClose={onClose} cls="precon-pick pkb-pick">
      <h2>Start from a tournament deck</h2>
      <p className="sub">Copy one of the decks top players used, then make it yours. The original stays as it is.</p>
      <input className="input" placeholder="Search by deck or card" value={q} onChange={e => setQ(e.target.value)} aria-label="Search decks" autoFocus />
      <div className="pp-list" role="list">
        {list.map(d => {
          const img = pkImage(d.featured);
          return (
            <button key={d.id} role="listitem" className="pp-row pkb-pp" onClick={() => onPick(d)}>
              <span className="pkb-pp-art" style={{ '--t': `var(--pk-${((db[d.featured] || {}).type || 'colorless').toLowerCase()})` }}>{img ? <img src={img} alt="" draggable="false" /> : null}</span>
              <span className="pkb-pp-name"><b>{d.name}</b><small>{d.blurb}</small></span>
              <span className="pkb-pp-en">{d.energy.map(t => <Energy key={t} type={t} size={15} />)}</span>
            </button>
          );
        })}
        {!list.length ? <div className="empty">No deck matches.</div> : null}
      </div>
      <div className="dlg-actions"><button className="btn" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}
