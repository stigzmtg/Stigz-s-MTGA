// The Commander deck builder: pick a commander, then 99 more cards from the 6,400 the rules engine has scripts for,
// within the commander's colors and one copy each (basic lands excepted). Decks are saved on this device and play
// like any precon, solo or with friends.
import { CardFace, viewOfDef, Pip } from './cardview.jsx';
import { cardImage, subscribeImages, imagesVersion } from './images.js';
import { buildIndex, BASICS, deckProblems, loadCustomDecks, saveCustomDeck, deleteCustomDeck, newDeckId } from './customdecks.js';
import { Modal } from './dialogs.jsx';
import { createDeckHelper } from './deckai.js';
import { DeckHelper } from './deckhelper.jsx';

const { useState, useMemo, useSyncExternalStore } = React;
const TYPE_FILTERS = [['all', 'All'], ['Creature', 'Creatures'], ['spell', 'Instants & sorceries'], ['Artifact', 'Artifacts'], ['Enchantment', 'Enchantments'], ['Planeswalker', 'Planeswalkers'], ['Land', 'Lands']];
const GROUPS = ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land', 'Other'];
const BASIC_FOR = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' };
const costPip = t => (/^\d+$/.test(t) || t === 'X' ? t : t.length === 2 && /^[WUBRG2][WUBRGP]$/.test(t) ? `${t[0]}/${t[1]}` : t);

export function Cost({ cost }) {
  return cost.length ? <span className="mana">{cost.map((t, i) => <Pip key={i} s={costPip(t)} />)}</span> : null;
}

// "1 Sol Ring", "1x Sol Ring", "Sol Ring"; a "Commander" heading (or *CMDR*) marks the commander
export function parseDeckText(text, byName) {
  const out = { commanders: [], cards: new Map(), missing: [] };
  let section = '';
  const lower = new Map([...byName.keys()].map(k => [k.toLowerCase(), k]));
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;
    if (/^(commanders?|command zone)\s*:?$/i.test(line)) { section = 'cmd'; continue; }
    if (/^(deck|mainboard|main|library|sideboard|maybeboard|creatures?|lands?|spells?|artifacts?|enchantments?|instants?|sorcer(y|ies)|planeswalkers?)\b.*:?$/i.test(line) && !/^\d/.test(line)) { section = /^(sideboard|maybeboard)/i.test(line) ? 'skip' : ''; continue; }
    if (section === 'skip') continue;
    let m = /^(\d+)\s*x?\s+(.+?)\s*(\*cmdr\*|\(commander\))?$/i.exec(line);
    const n = m ? +m[1] : 1;
    let name = (m ? m[2] : line).replace(/\s*\([A-Z0-9]{2,6}\)\s*[\w-]*$/, '').replace(/\s*\*[A-Z]+\*$/, '').trim();
    const isCmd = section === 'cmd' || /\*cmdr\*|\(commander\)/i.test(line);
    const key = lower.get(name.toLowerCase()) || lower.get(name.split(' // ')[0].toLowerCase());
    if (!key) { out.missing.push(name); continue; }
    if (isCmd && out.commanders.length < 2) out.commanders.push(key);
    else out.cards.set(key, (out.cards.get(key) || 0) + n);
  }
  return out;
}

function ImportDialog({ byName, onImport, onClose }) {
  const [text, setText] = useState('');
  const parsed = useMemo(() => (text.trim() ? parseDeckText(text, byName) : null), [text]);
  return (
    <Modal label="Import a decklist" onClose={onClose}>
      <h2>Import a decklist</h2>
      <p className="sub">Paste a list, one card per line (“1 Sol Ring”). Put the commander under a “Commander” line, or mark it *CMDR*. Cards the game can’t play yet are left out.</p>
      <textarea className="input builder-import" value={text} onChange={e => setText(e.target.value)} placeholder={'Commander\n1 Atraxa, Praetors\' Voice\n\nDeck\n1 Sol Ring\n1 Arcane Signet\n…'} aria-label="Decklist" />
      {parsed ? <p className="note">{parsed.commanders.length ? `Commander: ${parsed.commanders.join(' & ')}. ` : 'No commander marked. '}{[...parsed.cards.values()].reduce((a, b) => a + b, 0)} other cards found{parsed.missing.length ? `; not available: ${parsed.missing.slice(0, 6).join(', ')}${parsed.missing.length > 6 ? ` and ${parsed.missing.length - 6} more` : ''}` : ''}.</p> : null}
      <div className="dlg-actions"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!parsed} onClick={() => onImport(parsed)}>Import</button></div>
    </Modal>
  );
}

export function DeckBuilder({ data, editId, onDone, onPlay, onHome }) {
  useSyncExternalStore(subscribeImages, imagesVersion);
  const index = useMemo(() => buildIndex(data.db.raw), [data]);
  const byName = useMemo(() => new Map(index.map(c => [c.name, c])), [index]);
  const helper = useMemo(() => createDeckHelper(index, data.decks, data.support || {}), [index]);
  const [tab, setTab] = useState('helper');
  const start = editId ? loadCustomDecks().find(d => d.id === editId) : null;
  const [id] = useState(() => (start ? start.id : newDeckId()));
  const [name, setName] = useState(start ? start.name : '');
  const [commanders, setCommanders] = useState(start ? start.commanders : []);
  const [cards, setCards] = useState(() => new Map(start ? start.cards : []));
  const [q, setQ] = useState('');
  const [type, setType] = useState('all');
  const [inColors, setInColors] = useState(true);
  const [limit, setLimit] = useState(60);
  const [hover, setHover] = useState(null);
  const [picking, setPicking] = useState(!start);
  const [importing, setImporting] = useState(false);
  const [toast, setToast] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const identity = useMemo(() => { const s = new Set(); for (const n of commanders) for (const c of (byName.get(n) || { ci: [] }).ci) s.add(c); return ['W', 'U', 'B', 'R', 'G'].filter(c => s.has(c)); }, [commanders]);
  const list = useMemo(() => [...cards].filter(([, n]) => n > 0).sort((a, b) => a[0].localeCompare(b[0])), [cards]);
  const deck = { id, name: name.trim() || (commanders[0] ? `${commanders[0].split(',')[0]} deck` : 'New deck'), commanders, cards: list };
  const total = commanders.length + list.reduce((a, [, n]) => a + n, 0);
  const problems = deckProblems(deck, byName, identity);
  const flash = t => { setToast(t); setTimeout(() => setToast(x => (x === t ? null : x)), 2600); };

  const choosingCommander = picking || !commanders.length;
  const qq = q.trim().toLowerCase();
  const results = useMemo(() => {
    const ok = c => {
      if (choosingCommander) return c.commander && (picking !== 'partner' || (c.partner && !commanders.includes(c.name)));
      if (commanders.includes(c.name)) return false;
      if (inColors && c.ci.some(x => !identity.includes(x))) return false;
      if (type === 'spell') return c.main === 'Instant' || c.main === 'Sorcery';
      if (type !== 'all') return c.main === type;
      return true;
    };
    return index.filter(c => ok(c) && (!qq || c.lower.includes(qq) || c.type.toLowerCase().includes(qq) || (qq.length > 3 && c.text.toLowerCase().includes(qq))));
  }, [qq, type, inColors, identity, choosingCommander, index]);

  const add = (n, k = 1) => setCards(m => {
    const c = byName.get(n), next = new Map(m);
    const have = next.get(n) || 0;
    if (k > 0 && have && !c.anyNumber) { flash(`${n} is already in your deck: one copy of each card.`); return m; }
    const v = have + k;
    if (v <= 0) next.delete(n); else next.set(n, v);
    return next;
  });
  const setCommander = n => {
    const c = byName.get(n);
    if (commanders.length === 1 && picking === 'partner') { if (!c.partner || !byName.get(commanders[0]).partner) { flash('Both commanders need Partner.'); return; } setCommanders([commanders[0], n]); }
    else setCommanders([n]);
    setCards(m => { const next = new Map(m); next.delete(n); return next; });
    setPicking(false); setQ(''); setType('all');
  };
  const fillBasics = () => {
    const need = 100 - total;
    if (need <= 0) return flash('Your deck already has 100 cards.');
    const colors = identity.length ? identity : ['C'];
    setCards(m => {
      const next = new Map(m);
      colors.forEach((c, i) => { const land = c === 'C' ? 'Wastes' : BASIC_FOR[c]; const k = Math.floor(need / colors.length) + (i < need % colors.length ? 1 : 0); if (k) next.set(land, (next.get(land) || 0) + k); });
      return next;
    });
  };
  const save = () => { saveCustomDeck(deck); flash('Saved on this device.'); return deck; };
  const copyList = () => {
    const text = ['Commander', ...commanders.map(n => `1 ${n}`), '', 'Deck', ...list.map(([n, k]) => `${k} ${n}`)].join('\n');
    try { navigator.clipboard.writeText(text).then(() => flash('Decklist copied.'), () => flash('Couldn’t copy here.')); } catch { flash('Couldn’t copy here.'); }
  };
  const doImport = parsed => {
    if (parsed.commanders.length) setCommanders(parsed.commanders);
    setCards(new Map(parsed.cards));
    setPicking(false); setImporting(false);
    flash(`Imported ${[...parsed.cards.values()].reduce((a, b) => a + b, 0) + parsed.commanders.length} cards${parsed.missing.length ? `; ${parsed.missing.length} not available` : ''}.`);
  };

  // mana curve of the nonland cards
  const curve = Array(8).fill(0);
  for (const [n, k] of list) { const c = byName.get(n); if (c && c.main !== 'Land') curve[Math.min(7, c.cmc)] += k; }
  const peak = Math.max(1, ...curve);
  const groups = GROUPS.map(g => [g, list.filter(([n]) => (byName.get(n) || { main: 'Other' }).main === g)]).filter(([, l]) => l.length);
  const preview = hover && data.db.get(hover);

  return (
    <div className="app builder">
      <header className="topbar">
        <button className="brand linklike" onClick={onHome} title="Choose a game">Lotus Goats<small>Commander</small></button>
        <span className="chip gold">Deck builder</span>
        <span className="spacer" />
        <button className="btn sm" onClick={() => setImporting(true)}>Import list</button>
        <button className="btn sm" onClick={onDone}>Back to decks</button>
      </header>
      <div className="builder-grid">
        <section className="panel builder-search" aria-label={tab === 'helper' ? 'AI deck helper' : choosingCommander ? 'Choose a commander' : 'Add cards'}>
          <div className="builder-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'helper'} className={tab === 'helper' ? 'on' : ''} onClick={() => setTab('helper')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l1.8 4.6L18.5 8l-4.7 1.5L12 14l-1.8-4.5L5.5 8l4.7-1.4z" /><path d="M18.5 13l.9 2.3 2.3.8-2.3.8-.9 2.3-.9-2.3-2.3-.8 2.3-.8z" /></svg>AI deck helper</button>
            <button role="tab" aria-selected={tab === 'search'} className={tab === 'search' ? 'on' : ''} onClick={() => setTab('search')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 3a7 7 0 015.6 11.2l4.6 4.6-1.4 1.4-4.6-4.6A7 7 0 1110 3zm0 2a5 5 0 100 10 5 5 0 000-10z" /></svg>{choosingCommander ? (picking === 'partner' ? 'Choose a partner' : 'Choose a commander') : 'Search cards'}</button>
          </div>
          <DeckHelper H={helper} commanders={commanders} cards={cards} setCards={setCards} onChooseCommander={setCommander} onHover={setHover} byName={byName} hidden={tab !== 'helper'} />
          <div className="builder-searchpane" hidden={tab !== 'search'}>
            <p className="note">{choosingCommander ? 'Any legendary creature can lead a deck. Its colors decide which cards the deck can use.' : `Only cards the game can play are listed. ${identity.length ? 'Your colors: ' : 'Colorless commander: colorless cards only.'}`}{!choosingCommander && identity.length ? <span className="mana">{identity.map(c => <Pip key={c} s={c} />)}</span> : null}</p>
            <div className="filters">
              <input className="input search" placeholder={choosingCommander ? 'Search commanders by name or type' : 'Search by name, type or rules text'} value={q} onChange={e => { setQ(e.target.value); setLimit(60); }} aria-label="Search cards" />
              {!choosingCommander ? <label className="checkline"><input type="checkbox" checked={inColors} onChange={e => setInColors(e.target.checked)} /> Commander’s colors only</label> : null}
            </div>
            {!choosingCommander ? <div className="seg builder-types" role="group" aria-label="Card type">{TYPE_FILTERS.map(([k, l]) => <button key={k} className={type === k ? 'on' : ''} aria-pressed={type === k} onClick={() => { setType(k); setLimit(60); }}>{l}</button>)}</div> : null}
            <div className="builder-results" role="list">
              {results.slice(0, limit).map(c => {
                const have = cards.get(c.name) || 0;
                const off = c.ci.some(x => !identity.includes(x));
                return (
                  <div key={c.name} role="listitem" className={`bres ${have ? 'in' : ''}`} onMouseEnter={() => setHover(c.name)} onFocus={() => setHover(c.name)}>
                    <span className="bname"><b>{c.name}</b><small>{c.type}</small></span>
                    <Cost cost={c.cost} />
                    {choosingCommander
                      ? <button className="btn sm primary" onClick={() => setCommander(c.name)}>Choose</button>
                      : <button className="btn sm" disabled={(have && !c.anyNumber) || (!inColors && off)} title={off ? 'Outside your commander’s colors' : have && !c.anyNumber ? 'Already in your deck' : 'Add to deck'} onClick={() => add(c.name)}>{have && !c.anyNumber ? 'In deck' : '+ Add'}</button>}
                  </div>
                );
              })}
              {!results.length ? <div className="empty">Nothing matches.</div> : null}
              {results.length > limit ? <button className="btn ghost more" onClick={() => setLimit(l => l + 80)}>Show more ({results.length - limit} left)</button> : null}
            </div>
          </div>
        </section>
        <aside className="builder-side">
          <section className="panel builder-preview" aria-label="Card preview">
            {preview ? <div className="bigcard"><CardFace v={{ ...viewOfDef(preview), img: cardImage(preview.name) }} size="big" /></div> : <div className="empty">Point at a card to see it here.</div>}
          </section>
          <section className="panel builder-deck" aria-label="Your deck">
            <input className="input deckname" value={name} placeholder={deck.name} onChange={e => setName(e.target.value)} aria-label="Deck name" maxLength={60} />
            <div className="cmd-row">
              {commanders.map(n => (
                <span key={n} className="cmd-chip" onMouseEnter={() => setHover(n)}><b>{n}</b><small>Commander</small></span>
              ))}
              {commanders.length ? <button className="btn sm ghost" onClick={() => { setPicking(true); setQ(''); setTab('search'); }}>Change</button> : null}
              {commanders.length === 1 && (byName.get(commanders[0]) || {}).partner ? <button className="btn sm ghost" onClick={() => { setPicking('partner'); setQ(''); setTab('search'); }}>Add a partner</button> : null}
            </div>
            <div className="count-row">
              <span className={`count ${total === 100 ? 'full' : total > 100 ? 'over' : ''}`}><b>{total}</b> / 100 cards</span>
              <span className="meter"><i style={{ width: Math.min(100, total) + '%' }} /></span>
              <button className="btn sm" onClick={fillBasics} disabled={!commanders.length || total >= 100}>Fill with basic lands</button>
            </div>
            <div className="curve" aria-label="Mana curve">
              {curve.map((n, i) => <span key={i} className="bar" title={`${n} card${n === 1 ? '' : 's'} with mana value ${i}${i === 7 ? '+' : ''}`}><i style={{ height: `${(100 * n) / peak}%` }} /><small>{i === 7 ? '7+' : i}</small></span>)}
            </div>
            <div className="basics">
              {(identity.length ? identity.map(c => BASIC_FOR[c]) : ['Wastes']).map(land => (
                <span key={land} className="basic"><span>{land}</span><button className="btn sm" onClick={() => add(land, -1)} disabled={!cards.get(land)} aria-label={`One fewer ${land}`}>−</button><b>{cards.get(land) || 0}</b><button className="btn sm" onClick={() => add(land, 1)} aria-label={`One more ${land}`}>+</button></span>
              ))}
            </div>
            <div className="deck-groups">
              {groups.map(([g, l]) => (
                <div key={g} className="dgroup">
                  <div className="label">{g === 'Other' ? 'Other' : g + (g === 'Sorcery' ? '' : 's')} · {l.reduce((a, [, k]) => a + k, 0)}</div>
                  {l.filter(([n]) => !BASICS.has(n)).map(([n, k]) => (
                    <div key={n} className="drow" onMouseEnter={() => setHover(n)}>
                      <span>{k > 1 ? `${k}× ` : ''}{n}</span>
                      <Cost cost={(byName.get(n) || { cost: [] }).cost} />
                      <button className="btn sm ghost" onClick={() => add(n, -1)} aria-label={`Remove ${n}`}>−</button>
                    </div>
                  ))}
                </div>
              ))}
              {!list.length && commanders.length ? <div className="empty">Search on the left and add cards. Most decks run 35 to 38 lands.</div> : null}
            </div>
            {problems.length ? <ul className="problems">{problems.map(p => <li key={p}>{p}</li>)}</ul> : <p className="ready">Ready to play: 100 cards, all in your commander’s colors.</p>}
            <div className="dlg-actions builder-acts">
              {start ? (confirmDelete ? <button className="btn danger" onClick={() => { deleteCustomDeck(id); onDone(); }}>Delete for good?</button> : <button className="btn ghost" onClick={() => setConfirmDelete(true)}>Delete</button>) : null}
              <button className="btn" onClick={copyList} disabled={!list.length}>Copy list</button>
              <button className="btn" onClick={save} disabled={!commanders.length}>Save</button>
              <button className="btn primary" onClick={() => onPlay(save())} disabled={problems.length > 0}>Save and play</button>
            </div>
          </section>
        </aside>
      </div>
      {importing ? <ImportDialog byName={byName} onImport={doImport} onClose={() => setImporting(false)} /> : null}
      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </div>
  );
}
