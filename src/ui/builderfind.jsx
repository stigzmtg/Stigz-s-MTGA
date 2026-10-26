// Finding cards in the deck builder: the card search (filters for each job a card can do, mana value, type and the
// commander's plan, sorted by how much each card would help this deck), the commander browser (by color, most-played
// first, with pictures) and the list of precons to start from.
import { Pip } from './cardview.jsx';
import { Modal } from './dialogs.jsx';
import { ROLES } from './deckai.js';
import { Cost, RoleTags, CardTile, SHORT_ROLE } from './buildercard.jsx';

const { useState, useMemo, useEffect } = React;
const TYPES = [['all', 'All'], ['Creature', 'Creatures'], ['spell', 'Instants & sorceries'], ['Artifact', 'Artifacts'], ['Enchantment', 'Enchantments'], ['Planeswalker', 'Planeswalkers'], ['Land', 'Lands']];
const JOBS = ['ramp', 'draw', 'removal', 'wipe', 'counter', 'tutor', 'protect', 'recursion'];
const MV = [['0–1', c => c.cmc <= 1], ['2', c => c.cmc === 2], ['3', c => c.cmc === 3], ['4', c => c.cmc === 4], ['5', c => c.cmc === 5], ['6+', c => c.cmc >= 6]];
const SORTS = [['fit', 'Best for this deck'], ['popular', 'Most played'], ['mv', 'Mana value'], ['name', 'A to Z']];
const toggle = (set, k) => { const n = new Set(set); if (n.has(k)) n.delete(k); else n.add(k); return n; };

function ViewSwitch({ view, setView }) {
  return (
    <div className="seg view-switch" role="group" aria-label="Show as">
      <button className={view === 'list' ? 'on' : ''} aria-pressed={view === 'list'} onClick={() => setView('list')} title="List"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z" /></svg>List</button>
      <button className={view === 'grid' ? 'on' : ''} aria-pressed={view === 'grid'} onClick={() => setView('grid')} title="Pictures"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h7v9H4zm9 0h7v9h-7zM4 15h7v5H4zm9 0h7v5h-7z" /></svg>Pictures</button>
    </div>
  );
}

// ---- the card search
export function CardSearch({ H, index, db, state, identity, rank, onAdd, onOpen, hv, req }) {
  const [q, setQ] = useState('');
  const [type, setType] = useState('all');
  const [jobs, setJobs] = useState(() => new Set());
  const [mv, setMv] = useState(() => new Set());
  const [planOnly, setPlanOnly] = useState(false);
  const [inColors, setInColors] = useState(true);
  const [sort, setSort] = useState('fit');
  const [view, setView] = useState(() => { try { return localStorage.getItem('pa-builder-view') || 'list'; } catch { return 'list'; } });
  const [limit, setLimit] = useState(60);
  const [more, setMore] = useState(false);   // the extra filters, folded away on small screens
  const pickView = v => { setView(v); try { localStorage.setItem('pa-builder-view', v); } catch { /* storage blocked */ } };
  // the checklist's "Find" buttons ask for one kind of card
  useEffect(() => {
    if (!req) return;
    setQ(''); setSort('fit'); setLimit(60); setMv(new Set()); setInColors(true);
    setPlanOnly(req.kind === 'plan');
    setType(req.kind === 'land' ? 'Land' : req.kind === 'creatures' ? 'Creature' : 'all');
    setJobs(JOBS.includes(req.kind) ? new Set([req.kind]) : new Set());
  }, [req]);

  const qq = q.trim().toLowerCase();
  const results = useMemo(() => {
    const out = [];
    for (const c of index) {
      if (c.main === 'Other' || state.commanders.includes(c.name)) continue;
      if (inColors && c.ci.some(x => !identity.includes(x))) continue;
      if (type === 'spell' ? !(c.main === 'Instant' || c.main === 'Sorcery') : type !== 'all' && c.main !== type) continue;
      if (mv.size && (c.main === 'Land' || !MV.some(([k, f]) => mv.has(k) && f(c)))) continue;
      if (jobs.size && !H.roleOf(c.name).some(r => jobs.has(r))) continue;
      if (planOnly) { const r = rank && rank.get(c.name); if (!r || !r.plan) continue; }
      if (qq && !(c.lower.includes(qq) || c.type.toLowerCase().includes(qq) || (qq.length > 2 && c.text.toLowerCase().includes(qq)))) continue;
      out.push(c);
    }
    const fit = c => { const r = rank && rank.get(c.name); return r ? r.s : -99; };
    if (sort === 'fit' && rank) out.sort((a, b) => fit(b) - fit(a));
    else if (sort === 'popular') out.sort((a, b) => (H.feats.get(b.name).pop - H.feats.get(a.name).pop) || a.name.localeCompare(b.name));
    else if (sort === 'mv') out.sort((a, b) => (a.main === 'Land') - (b.main === 'Land') || a.cmc - b.cmc || a.name.localeCompare(b.name));
    return out;
  }, [qq, type, jobs, mv, planOnly, inColors, sort, rank, identity, state.commanders]);

  const filtersOn = jobs.size + mv.size + (planOnly ? 1 : 0) + (type !== 'all' ? 1 : 0);
  const clear = () => { setJobs(new Set()); setMv(new Set()); setPlanOnly(false); setType('all'); setQ(''); };
  const addBtn = c => {
    const have = state.cards.get(c.name) || 0;
    const off = c.ci.some(x => !identity.includes(x));
    if (have && !c.anyNumber) return <button className="btn sm in" onClick={() => onOpen(c.name)} title="In your deck">✓ In deck</button>;
    return <button className="btn sm" disabled={off} title={off ? 'Outside your commander’s colors' : 'Add to deck'} onClick={() => onAdd(c.name)}>{have ? `+ Add (${have})` : '+ Add'}</button>;
  };
  return (
    <div className="bfind">
      <div className="bfind-top">
        <label className="searchbox">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 3a7 7 0 015.6 11.2l4.6 4.6-1.4 1.4-4.6-4.6A7 7 0 1110 3zm0 2a5 5 0 100 10 5 5 0 000-10z" /></svg>
          <input className="input" placeholder="Search names, types or rules text (“dragon”, “draw a card”)" value={q} onChange={e => { setQ(e.target.value); setLimit(60); }} aria-label="Search cards" />
        </label>
        <select className="input sortsel" value={sort} onChange={e => setSort(e.target.value)} aria-label="Sort by">{SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <ViewSwitch view={view} setView={pickView} />
      </div>
      <div className="seg btypes" role="group" aria-label="Card type">{TYPES.map(([k, l]) => <button key={k} className={type === k ? 'on' : ''} aria-pressed={type === k} onClick={() => { setType(k); setLimit(60); }}>{l}</button>)}</div>
      <button className={`btn sm ghost morefilters ${more ? 'open' : ''}`} onClick={() => setMore(m => !m)} aria-expanded={more}>{more ? 'Fewer filters' : `More filters${jobs.size + mv.size + (planOnly ? 1 : 0) ? ` (${jobs.size + mv.size + (planOnly ? 1 : 0)})` : ''}`}</button>
      <div className={`bfilters ${more ? 'open' : ''}`}>
        <div className="frow" role="group" aria-label="What the card does">
          <span className="flabel">Job</span>
          {JOBS.map(r => <button key={r} className={`fchip r-${r} ${jobs.has(r) ? 'on' : ''}`} aria-pressed={jobs.has(r)} onClick={() => { setJobs(s => toggle(s, r)); setLimit(60); }} title={ROLES[r]}>{SHORT_ROLE[r]}</button>)}
          {rank ? <button className={`fchip plan ${planOnly ? 'on' : ''}`} aria-pressed={planOnly} onClick={() => setPlanOnly(v => !v)} title="Cards that work with your commander">✦ Fits my plan</button> : null}
        </div>
        <div className="frow" role="group" aria-label="Mana value">
          <span className="flabel">Cost</span>
          {MV.map(([k]) => <button key={k} className={`fchip mv ${mv.has(k) ? 'on' : ''}`} aria-pressed={mv.has(k)} onClick={() => { setMv(s => toggle(s, k)); setLimit(60); }}>{k}</button>)}
          <label className="checkline"><input type="checkbox" checked={inColors} onChange={e => setInColors(e.target.checked)} /> Only my colors {identity.length ? <span className="mana">{identity.map(x => <Pip key={x} s={x} />)}</span> : null}</label>
        </div>
      </div>
      <div className="bcount"><span>{results.length.toLocaleString('en-US')} card{results.length === 1 ? '' : 's'}{sort === 'fit' && rank ? ', best for your deck first' : ''}</span>{filtersOn || q ? <button className="linkish" onClick={clear}>Clear filters</button> : null}</div>
      <div className={`bresults ${view}`} role="list">
        {view === 'grid'
          ? results.slice(0, limit).map(c => {
            const have = state.cards.get(c.name) || 0;
            return (
              <CardTile key={c.name} def={db.get(c.name)} cls={have ? 'in' : ''} onOpen={() => onOpen(c.name)} onEnter={hv.enter(c.name)} onLeave={hv.leave}>
                <div className="tile-foot">{addBtn(c)}</div>
              </CardTile>
            );
          })
          : results.slice(0, limit).map(c => {
            const have = state.cards.get(c.name) || 0;
            const r = rank && rank.get(c.name);
            const why = r && r.why.filter(w => !/can’t fully play/.test(w)).map(w => w.replace(/: you have (\d+), aim for about (\d+)$/, ' ($1 of $2)'))[0];
            return (
              <div key={c.name} role="listitem" className={`bres ${have ? 'in' : ''}`} onMouseEnter={hv.enter(c.name)} onMouseLeave={hv.leave}>
                <button type="button" className="bname as-btn" onClick={() => onOpen(c.name)}><b>{c.name}</b><small>{c.type}</small>{why ? <em className="why">{why}</em> : null}</button>
                <RoleTags roles={H.roleOf(c.name)} />
                <Cost cost={c.cost} />
                {addBtn(c)}
              </div>
            );
          })}
        {!results.length ? <div className="empty">Nothing matches. {filtersOn || q ? <button className="linkish" onClick={clear}>Clear the filters</button> : null}</div> : null}
      </div>
      {results.length > limit ? <button className="btn ghost more" onClick={() => setLimit(l => l + (view === 'grid' ? 48 : 80))}>Show more ({(results.length - limit).toLocaleString('en-US')} left)</button> : null}
    </div>
  );
}

// ---- the commander browser
const COLOR_CHIPS = [['W', 'White'], ['U', 'Blue'], ['B', 'Black'], ['R', 'Red'], ['G', 'Green'], ['C', 'Colorless']];
export function CommanderPicker({ H, index, db, partnerOf, onOpen, onChoose, hv }) {
  const [q, setQ] = useState('');
  const [colors, setColors] = useState(() => new Set());
  const [exact, setExact] = useState(false);
  const [sort, setSort] = useState('popular');
  const [view, setView] = useState('grid');
  const [limit, setLimit] = useState(48);
  const qq = q.trim().toLowerCase();
  const list = useMemo(() => {
    const out = index.filter(c => {
      if (!c.commander || !H.feats.get(c.name).legal) return false;
      if (partnerOf && (!c.partner || c.name === partnerOf)) return false;
      if (colors.size) {
        const want = [...colors];
        if (want.includes('C')) { if (c.ci.length) return false; }
        else if (exact ? c.ci.length !== want.length || want.some(x => !c.ci.includes(x)) : want.some(x => !c.ci.includes(x))) return false;
      }
      return !qq || c.lower.includes(qq) || c.type.toLowerCase().includes(qq) || (qq.length > 2 && c.text.toLowerCase().includes(qq));
    });
    const score = c => (H.leadsPrecon(c.name) ? 1000 : 0) + H.feats.get(c.name).pop - (H.feats.get(c.name).flagged ? 5000 : 0);
    if (sort === 'popular') out.sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
    else if (sort === 'mv') out.sort((a, b) => a.cmc - b.cmc || a.name.localeCompare(b.name));
    return out;
  }, [qq, colors, exact, sort, partnerOf]);
  return (
    <div className="bfind">
      <p className="note">{partnerOf ? `Commanders with Partner can share the command zone with ${partnerOf}. Their colors add together.` : 'Your commander is a legendary creature that starts every game ready to cast. Its colors decide which cards your deck can use, and its abilities give the deck a plan.'}</p>
      <div className="bfind-top">
        <label className="searchbox">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 3a7 7 0 015.6 11.2l4.6 4.6-1.4 1.4-4.6-4.6A7 7 0 1110 3zm0 2a5 5 0 100 10 5 5 0 000-10z" /></svg>
          <input className="input" placeholder="Search commanders (“dragon”, “tokens”, “Atraxa”)" value={q} onChange={e => { setQ(e.target.value); setLimit(48); }} aria-label="Search commanders" />
        </label>
        <select className="input sortsel" value={sort} onChange={e => setSort(e.target.value)} aria-label="Sort by"><option value="popular">Precon leaders first</option><option value="name">A to Z</option><option value="mv">Mana value</option></select>
        <ViewSwitch view={view} setView={setView} />
      </div>
      <div className="frow" role="group" aria-label="Colors">
        <span className="flabel">Colors</span>
        {COLOR_CHIPS.map(([k, l]) => <button key={k} className={`fchip pipchip ${colors.has(k) ? 'on' : ''}`} aria-pressed={colors.has(k)} onClick={() => { setColors(s => (k === 'C' ? (s.has('C') ? new Set() : new Set(['C'])) : toggle(new Set([...s].filter(x => x !== 'C')), k))); setLimit(48); }} title={l}><Pip s={k} /><span>{l}</span></button>)}
        {colors.size && !colors.has('C') ? <label className="checkline"><input type="checkbox" checked={exact} onChange={e => setExact(e.target.checked)} /> Exactly these</label> : null}
      </div>
      <div className="bcount"><span>{list.length.toLocaleString('en-US')} commander{list.length === 1 ? '' : 's'}</span></div>
      <div className={`bresults ${view}`} role="list">
        {view === 'grid'
          ? list.slice(0, limit).map(c => (
            <CardTile key={c.name} def={db.get(c.name)} onOpen={() => onOpen(c.name)} onEnter={hv.enter(c.name)} onLeave={hv.leave} label={`${c.name}: details`}>
              <div className="tile-foot">{H.leadsPrecon(c.name) ? <span className="tile-tag">Precon</span> : null}<button className="btn sm primary" onClick={() => onChoose(c.name)}>Choose</button></div>
            </CardTile>
          ))
          : list.slice(0, limit).map(c => (
            <div key={c.name} role="listitem" className="bres" onMouseEnter={hv.enter(c.name)} onMouseLeave={hv.leave}>
              <button type="button" className="bname as-btn" onClick={() => onOpen(c.name)}><b>{c.name}</b><small>{c.type}</small></button>
              {H.leadsPrecon(c.name) ? <span className="tile-tag">Precon</span> : <span />}
              <Cost cost={c.cost} />
              <button className="btn sm primary" onClick={() => onChoose(c.name)}>Choose</button>
            </div>
          ))}
        {!list.length ? <div className="empty">No commander matches.</div> : null}
      </div>
      {list.length > limit ? <button className="btn ghost more" onClick={() => setLimit(l => l + 48)}>Show more ({list.length - limit} left)</button> : null}
    </div>
  );
}

// ---- a precon to start from
export function PreconPicker({ decks, onPick, onClose }) {
  const [q, setQ] = useState('');
  const qq = q.trim().toLowerCase();
  const list = decks.filter(d => !d.custom && (!qq || d.name.toLowerCase().includes(qq) || d.commanders.some(c => c.toLowerCase().includes(qq)) || (d.setName || '').toLowerCase().includes(qq)));
  return (
    <Modal label="Upgrade a precon" onClose={onClose} cls="precon-pick">
      <h2>Upgrade a precon</h2>
      <p className="sub">Start from a ready-made deck and make it yours. The original stays as it is.</p>
      <input className="input" placeholder="Search by deck, commander or set" value={q} onChange={e => setQ(e.target.value)} aria-label="Search precons" autoFocus />
      <div className="pp-list" role="list">
        {list.map(d => (
          <button key={d.id} role="listitem" className="pp-row" onClick={() => onPick(d)}>
            <b>{d.name}</b><small>{d.commanders.join(' & ')}{d.setName ? ` · ${d.setName}` : ''}</small>
          </button>
        ))}
        {!list.length ? <div className="empty">No precon matches.</div> : null}
      </div>
      <div className="dlg-actions"><button className="btn" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}
