// The Pokémon deck builder: 60 cards from the 441 the rules engine plays. Start from nothing, from a copy of a
// tournament deck or from a pasted list (Pokémon TCG Live, Limitless, or typed by hand), then add cards by search,
// by name or by pasting more. The rules check says what the deck still needs, in plain words; every card opens to
// show what it does; the numbers and test hands show how the deck will play. Every change can be undone, and the
// deck saves on this device as you go. Decks play like the tournament ones, against the computer or with friends.
import { Modal } from '../../ui/dialogs.jsx';
import { Energy } from './energy.jsx';
import { subscribePk, pkImagesVersion } from './images.js';
import { cardIndex, parseDeckList, deckToText, twinIn, setLabel, ENERGY_TYPES } from '../decktext.js';
import { loadCustomDecks, saveCustomDeck, deleteCustomDeck, newDeckId, deckRules, deckLook, cantAdd, sortDeck, DECK_SIZE } from '../customdecks.js';
import { CardSheet, HoverCard, useHoverPreview, CardTile } from './buildercard.jsx';
import { CardSearch, DeckPicker, searchIndex } from './builderfind.jsx';
import { RulesCheck, DeckList, DeckNumbers, TestHand, QuickAdd } from './builderdeck.jsx';

const { useState, useMemo, useEffect, useRef, useSyncExternalStore } = React;
// a decklist as a map, adding up a card listed more than once
const toMap = cards => { const m = new Map(); for (const [k, n] of cards) m.set(k, (m.get(k) || 0) + n); return m; };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---- pasting a list: what it holds shows as you paste, near-miss names read as the card they're closest to, and
// suggestions for cards the game doesn't have
function ImportDialog({ ix, hasDeck, initial = '', initialMode = 'replace', onImport, onClose }) {
  const [text, setText] = useState(initial);
  const [mode, setMode] = useState(hasDeck ? initialMode : 'replace');
  const [swaps, setSwaps] = useState(() => new Map());   // a name the game doesn't have -> the suggestion used instead
  const parsed = useMemo(() => (text.trim() ? parseDeckList(text, ix) : null), [text]);
  const result = useMemo(() => {
    if (!parsed) return null;
    const cards = new Map(parsed.cards);
    for (const m of parsed.missing) { const to = swaps.get(m.name); if (to) cards.set(to, (cards.get(to) || 0) + Math.min(m.n, 4)); }
    return { name: parsed.name, cards, mode };
  }, [parsed, swaps, mode]);
  const n = result ? [...result.cards.values()].reduce((a, b) => a + b, 0) : 0;
  const left = parsed ? parsed.missing.filter(m => !swaps.has(m.name)) : [];
  const kinds = result ? ['P', 'T', 'E'].map(c => [...result.cards].filter(([k]) => ix.db[k].cat === c).reduce((a, [, x]) => a + x, 0)) : [];
  const nameOf = k => `${ix.db[k].name}${ix.versions.has(k) ? ` (${setLabel(k)})` : ''}`;
  const readFile = e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    f.text().then(t => setText(t.slice(0, 100000)), () => {});
    e.target.value = '';
  };
  return (
    <Modal label="Paste a decklist" onClose={onClose}>
      <h2>Paste a decklist</h2>
      <p className="sub">Copy a deck from Pokémon TCG Live (My Decks, then Export) or from Limitless (Export, then Copy to clipboard) and paste it here. Lists typed by hand work too: one card per line, like “4 Pikachu ex”.</p>
      <div className="imp-grid">
        <div className="imp-in">
          <textarea className="input builder-import" value={text} onChange={e => setText(e.target.value)} placeholder={'Pokémon: 12\n4 Dreepy TWM 128\n4 Drakloak TWM 129\n…\n\nTrainer: 33\n4 Ultra Ball SVI 196\n…\n\nEnergy: 15\n6 Basic {P} Energy SVE 5\n…'} aria-label="Decklist" autoFocus spellCheck={false} />
          <label className="btn sm ghost filebtn">Open a text file<input type="file" accept=".txt,text/plain" onChange={readFile} /></label>
        </div>
        <div className="imp-out" aria-live="polite">
          {!parsed ? <p className="muted">What the list holds shows here as you paste.</p> : <>
            <p className="imp-sum"><b>{n}</b> card{n === 1 ? '' : 's'} read{parsed.name ? <> from <q>{parsed.name}</q></> : null}</p>
            {n ? <p className="imp-note pkb-imp-kinds">{kinds[0]} Pokémon · {kinds[1]} Trainers · {kinds[2]} Energy</p> : null}
            {parsed.fixed.length ? <div className="imp-note"><p>Read as the closest card:</p><ul>{parsed.fixed.map(f => <li key={f.from}>{f.from} → <b>{nameOf(f.to)}</b></li>)}</ul></div> : null}
            {parsed.swapped.length ? <div className="imp-note"><p>The game has another version of these, which may play a little differently:</p><ul>{parsed.swapped.map(f => <li key={f.from}>{f.from} → <b>{nameOf(f.to)}</b></li>)}</ul></div> : null}
            {parsed.clamped.length ? <p className="imp-note">Up to 4 cards with the same name: kept 4 {parsed.clamped.slice(0, 4).join(', ')}{parsed.clamped.length > 4 ? ` and ${parsed.clamped.length - 4} more` : ''}.</p> : null}
            {parsed.missing.length ? (
              <div className="imp-missing">
                <p><b>{left.length ? `${left.length} not in the game yet` : 'All replaced'}</b>{left.length ? ' (left out)' : ''}{parsed.missing.some(m => m.suggestions.length) ? '. Tap a suggestion to use it instead:' : '.'}</p>
                <ul>
                  {parsed.missing.slice(0, 40).map(m => (
                    <li key={m.name} className={swaps.has(m.name) ? 'swapped' : ''}>
                      <span className="imp-gone">{m.n > 1 ? `${m.n} ` : ''}{m.name}</span>
                      {m.suggestions.map(sg => <button key={sg} type="button" className={`chip sm ${swaps.get(m.name) === sg ? 'on' : ''}`} aria-pressed={swaps.get(m.name) === sg} onClick={() => setSwaps(w => { const x = new Map(w); if (x.get(m.name) === sg) x.delete(m.name); else x.set(m.name, sg); return x; })}>{nameOf(sg)}</button>)}
                    </li>
                  ))}
                  {parsed.missing.length > 40 ? <li>and {parsed.missing.length - 40} more</li> : null}
                </ul>
              </div>
            ) : null}
          </>}
        </div>
      </div>
      {hasDeck ? (
        <div className="seg imp-mode" role="group" aria-label="What to do with your deck">
          <button type="button" className={mode === 'replace' ? 'on' : ''} aria-pressed={mode === 'replace'} onClick={() => setMode('replace')}>Replace my deck</button>
          <button type="button" className={mode === 'add' ? 'on' : ''} aria-pressed={mode === 'add'} onClick={() => setMode('add')}>Add to my deck</button>
        </div>
      ) : null}
      <div className="dlg-actions"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!n} onClick={() => onImport(result)}>{mode === 'add' && hasDeck ? `Add ${plural(n, 'card')}` : 'Use this list'}</button></div>
    </Modal>
  );
}

const ICONS = {
  hand: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 3a7 7 0 015.6 11.2l4.6 4.6-1.4 1.4-4.6-4.6A7 7 0 1110 3zm0 2a5 5 0 100 10 5 5 0 000-10z" /></svg>,
  trophy: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h10v2h4v3a4 4 0 01-4 4h-.4A5 5 0 0113 15.9V18h3v3H8v-3h3v-2.1A5 5 0 017.4 12H7a4 4 0 01-4-4V5h4zm10 4v3a2 2 0 002-2V7zM5 7v1a2 2 0 002 2V7z" /></svg>,
  paste: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 2h6a1 1 0 011 1v1h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2V3a1 1 0 011-1zm1 2v2h4V4zM8 10v2h8v-2zm0 4v2h6v-2z" /></svg>,
  undo: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7V3L2 9l6 6v-4h6a4 4 0 010 8h-3v2h3a6 6 0 000-12z" /></svg>,
  redo: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 7V3l6 6-6 6v-4h-6a4 4 0 000 8h3v2h-3a6 6 0 010-12z" /></svg>,
};

// ---- an empty deck: the ways to start, and the rules in a few lines
function StartPanel({ onPick, onDeck, onImport, count }) {
  return (
    <section className="panel b-start" aria-label="Start a deck">
      <h2>Build a Pokémon deck</h2>
      <p className="sub">Choose how to start. You can change anything later, and every change can be undone.</p>
      <div className="b-ways">
        <button className="b-way" onClick={onPick}>{ICONS.hand}<b>Pick cards myself</b><span>Search all {count} cards the game has, with pictures, and add the ones you like.</span></button>
        <button className="b-way" onClick={onDeck}>{ICONS.trophy}<b>Start from a tournament deck</b><span>Copy a deck top players used, then make it yours.</span></button>
        <button className="b-way" onClick={onImport}>{ICONS.paste}<b>Paste a decklist</b><span>From Pokémon TCG Live, Limitless, or typed by hand.</span></button>
      </div>
      <div className="b-rules">
        <h3>How a Pokémon deck works</h3>
        <ul>
          <li><b>60 cards</b>, no more and no less.</li>
          <li><b>Up to 4 cards with the same name.</b> Basic Energy can be as many as you like.</li>
          <li><b>At least one Basic Pokémon</b>, so you have one to start the game with.</li>
          <li><b>Only 1 ACE SPEC card</b> and <b>only 1 Radiant Pokémon</b>: they’re extra strong.</li>
          <li>Most decks have Pokémon, Trainers to find and help them, and the Energy their attacks need.</li>
        </ul>
      </div>
    </section>
  );
}

export function PkDeckBuilder({ data, editId, fromId, onDone, onPlay, onHome }) {
  useSyncExternalStore(subscribePk, pkImagesVersion);
  const db = data.cards;
  const builtIn = useMemo(() => data.decks.filter(d => !d.custom), [data]);
  const ix = useMemo(() => cardIndex(db, builtIn), [data]);
  const entries = useMemo(() => searchIndex(ix), [ix]);
  // where it starts: a saved deck, a copy of a tournament deck, or nothing
  const [start] = useState(() => {
    const mine = editId && loadCustomDecks().find(d => d.id === editId);
    if (mine) return { id: mine.id, name: mine.name, cards: mine.cards.filter(([k]) => db[k]), featured: mine.featured, saved: true };
    const pre = fromId && builtIn.find(d => d.id === fromId);
    if (pre) return { id: newDeckId(), name: `${pre.name} (my version)`, cards: pre.cards, featured: pre.featured, saved: false };
    return { id: newDeckId(), name: '', cards: [], saved: false };
  });
  const id = start.id;
  const [name, setNameRaw] = useState(start.name);
  const [featured, setFeaturedRaw] = useState(start.featured || null);

  // ---- the deck, with undo and redo
  const [hist, setHist] = useState(() => ({ past: [], now: toMap(start.cards), future: [], rev: 0 }));
  const cards = hist.now;
  const dirty = useRef(false);   // (a copy of a tournament deck saves once you change something, or play it)
  const setCards = f => setHist(h => {
    const next = typeof f === 'function' ? f(h.now) : f;
    if (!next || next === h.now) return h;
    dirty.current = true;
    return { past: [...h.past.slice(-100), h.now], now: next, future: [], rev: h.rev + 1 };
  });
  const undo = () => setHist(h => (h.past.length ? { past: h.past.slice(0, -1), now: h.past[h.past.length - 1], future: [h.now, ...h.future], rev: h.rev + 1 } : h));
  const redo = () => setHist(h => (h.future.length ? { past: [...h.past, h.now], now: h.future[0], future: h.future.slice(1), rev: h.rev + 1 } : h));
  const setName = v => { dirty.current = true; setNameRaw(v); };
  const setFeatured = k => { dirty.current = true; setFeaturedRaw(k); };
  useEffect(() => { if (hist.rev) dirty.current = true; }, [hist.rev]);

  const list = useMemo(() => sortDeck([...cards].filter(([, n]) => n > 0), db), [cards]);
  const total = list.reduce((a, [, n]) => a + n, 0);
  const look = deckLook({ cards: list, featured: featured && cards.get(featured) ? featured : null }, db);
  const deck = { id, name: name.trim() || (look.featured && db[look.featured] && list.length ? `${db[look.featured].name} deck` : 'New deck'), cards: list, ...(featured && cards.get(featured) ? { featured } : {}) };
  const rules = useMemo(() => deckRules(list, db), [list]);
  const ready = rules.every(r => r.ok);
  // why one more of a card can't go in (a reprint already in the deck counts as the same card)
  const target = key => twinIn(ix, key, cards) || key;
  const problemFor = key => cantAdd(list, db, target(key));

  // ---- saving as you go (once there's a card), and once more on the way out
  const [savedAt, setSavedAt] = useState(start.saved ? Date.now() : null);
  const latest = useRef(deck);
  latest.current = deck;
  const saveNow = () => { if (!latest.current.cards.length) return null; saveCustomDeck(latest.current); dirty.current = false; setSavedAt(Date.now()); return latest.current; };
  useEffect(() => {
    if (!dirty.current || !list.length) return;
    const t = setTimeout(saveNow, 700);
    return () => clearTimeout(t);
  }, [hist.rev, name, featured]);
  useEffect(() => () => { if (dirty.current && latest.current.cards.length) saveCustomDeck(latest.current); }, []);

  // ---- what's on screen
  const [right, setRight] = useState('cards');      // cards, stats, test
  const [pane, setPane] = useState('deck');         // (phones: one side at a time; the start screen is on the deck side)
  const [sheet, setSheet] = useState(null);
  const [req, setReq] = useState(null);
  const [importing, setImporting] = useState(null); // null, or { text, mode } to open the paste dialog with
  const [picking, setPicking] = useState(false);
  const [toast, setToast] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const hv = useHoverPreview();
  const flash = t => { setToast(t); setTimeout(() => setToast(x => (x === t ? null : x)), 2800); };

  // keyboard: undo and redo (not while typing)
  useEffect(() => {
    const k = e => {
      if (!(e.ctrlKey || e.metaKey) || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName)) return;
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  // ---- changes
  const add = (key, k = 1) => {
    if (!db[key]) return;
    const t = target(key);
    if (k > 0) { const why = cantAdd(list, db, t); if (why) { flash(why); return; } }
    setCards(m => { const next = new Map(m); const v = (next.get(t) || 0) + k; if (v <= 0) next.delete(t); else next.set(t, v); return next; });
    if (k > 0 && total + 1 === DECK_SIZE) flash('That’s 60 cards: your deck is full.');
  };
  const remove = key => { if (cards.get(key)) add(key, -1); };
  // the empty spots filled with basic Energy, split by the Energy symbols in the Pokémon's attacks
  const fillEnergy = () => {
    const need = DECK_SIZE - total;
    if (need <= 0) return flash('Your deck already has 60 cards.');
    const w = new Map();
    for (const [k, n] of list) for (const a of (db[k].cat === 'P' && db[k].attacks) || []) for (const t of a.cost) if (ENERGY_TYPES.includes(t)) w.set(t, (w.get(t) || 0) + n);
    if (!w.size) for (const [k, n] of list) if (db[k].cat === 'P' && ENERGY_TYPES.includes(db[k].type)) w.set(db[k].type, (w.get(db[k].type) || 0) + n);
    if (!w.size) return flash('Your Pokémon’s attacks only need Colorless Energy: add any basic Energy you like.');
    const types = [...w.keys()], sum = [...w.values()].reduce((a, b) => a + b, 0);
    const got = types.map(t => Math.floor((need * w.get(t)) / sum));
    const order = types.map((t, i) => [i, (need * w.get(t)) / sum - got[i]]).sort((a, b) => b[1] - a[1]);
    for (let i = 0, rest = need - got.reduce((a, b) => a + b, 0); rest > 0; i++, rest--) got[order[i % order.length][0]]++;
    setCards(m => { const next = new Map(m); types.forEach((t, i) => { if (got[i]) next.set(`${t} Energy`, (next.get(`${t} Energy`) || 0) + got[i]); }); return next; });
    flash(`Added ${plural(need, 'basic Energy card')}: ${types.map((t, i) => (got[i] ? `${got[i]} ${t}` : null)).filter(Boolean).join(', ')}.`);
  };
  const copyList = () => {
    const text = deckToText(list, db);
    try { navigator.clipboard.writeText(text).then(() => flash('Decklist copied: paste it into Pokémon TCG Live or anywhere.'), () => flash('Copying isn’t allowed here.')); } catch { flash('Copying isn’t allowed here.'); }
  };
  // a pasted list replaces the deck, or adds to it (keeping to the rules: 4 of a name, 1 ACE SPEC, 1 Radiant)
  const doImport = r => {
    const adding = r.mode === 'add' && list.length > 0;
    let m;
    let added = 0, refused = 0;
    if (adding) {
      m = new Map(cards);
      for (const [k, n] of r.cards) for (let i = 0; i < n; i++) {
        const t = twinIn(ix, k, m) || k;
        if (cantAdd([...m], db, t)) { refused += n - i; break; }
        m.set(t, (m.get(t) || 0) + 1); added++;
      }
    } else { m = new Map(r.cards); added = [...m.values()].reduce((a, b) => a + b, 0); }
    setCards(m);
    if (r.name && !name.trim()) setName(r.name);
    setImporting(null); setPane('deck');
    flash(adding ? `Added ${plural(added, 'card')}${refused ? ` (${refused} left out to keep to the rules)` : ''}.` : `Read ${plural(added, 'card')}.`);
  };
  const usePrecon = d => {
    setCards(toMap(d.cards));
    if (!name.trim()) setName(`${d.name} (my version)`);
    if (!featured) setFeatured(d.featured);
    setPicking(false); setPane('deck');
    flash(`${d.name} copied in. Change anything you like: the tournament deck stays as it is.`);
  };
  const find = r => { setReq({ ...r, at: Date.now() }); setPane('find'); };
  const open = k => { hv.clear(); setSheet(k); };

  const savedLine = savedAt && !dirty.current ? 'Saved on this device' : dirty.current && list.length ? 'Saving…' : list.length ? 'Saves on this device when you change something' : 'Not saved yet: add a card';
  // what's left to do, in short (the rules check above says it in full)
  const SHORT = { copies: 'more than 4 of a card', basic: 'needs a Basic Pokémon', ace: 'only 1 ACE SPEC allowed', radiant: 'only 1 Radiant Pokémon allowed' };
  const todo = rules.filter(r => !r.ok).map(r => (r.id === 'size' ? (total < DECK_SIZE ? `${DECK_SIZE - total} more card${DECK_SIZE - total === 1 ? '' : 's'} to go` : `${total - DECK_SIZE} card${total - DECK_SIZE === 1 ? '' : 's'} too many`) : SHORT[r.id]));

  return (
    <div className="app builder pk pkb">
      <header className="topbar">
        <button className="brand linklike" onClick={onHome} title="Choose a game">Lotus Goats</button>
        <span className="chip pk-chip">Pokémon TCG</span>
        <span className="chip gold">Deck builder</span>
        <span className="spacer" />
        <span className="undo-group">
          <button className="btn sm iconbtn" onClick={undo} disabled={!hist.past.length} title="Undo (Ctrl+Z)" aria-label="Undo">{ICONS.undo}<span>Undo</span></button>
          <button className="btn sm iconbtn" onClick={redo} disabled={!hist.future.length} title="Redo (Ctrl+Y)" aria-label="Redo">{ICONS.redo}<span>Redo</span></button>
        </span>
        <button className="btn sm" onClick={() => setImporting({ text: '', mode: 'replace' })}>Paste a list</button>
        <button className="btn sm" onClick={() => { if (dirty.current) saveNow(); onDone(); }}>Back to decks</button>
      </header>
      <div className="b-switch" role="tablist" aria-label="Builder sections">
        <button role="tab" aria-selected={pane === 'find'} className={pane === 'find' ? 'on' : ''} onClick={() => setPane('find')}>Find cards</button>
        <button role="tab" aria-selected={pane === 'deck'} className={pane === 'deck' ? 'on' : ''} onClick={() => setPane('deck')}>{list.length ? <>Your deck <b className={total === DECK_SIZE ? 'full' : total > DECK_SIZE ? 'over' : ''}>{total}/60</b></> : 'Start'}</button>
      </div>
      <div className={`b-grid pane-${pane}`}>
        <section className="panel b-left" aria-label="Find cards">
          <CardSearch ix={ix} entries={entries} have={cards} onAdd={add} onRemove={remove} onOpen={open} problemFor={problemFor} hv={hv} req={req} />
        </section>

        <div className="b-right">
          {!list.length ? (
            <StartPanel count={entries.length} onPick={() => find({ kind: 'all' })} onDeck={() => setPicking(true)} onImport={() => setImporting({ text: '', mode: 'replace' })} />
          ) : (
            <section className="panel b-deck" aria-label="Your deck">
              <div className="b-deckhead">
                <div className="b-cmdart">
                  {look.featured && db[look.featured] ? <CardTile def={db[look.featured]} onOpen={() => open(look.featured)} onEnter={hv.enter(look.featured)} onLeave={hv.leave} label={`${db[look.featured].name}, your deck’s picture: details`} /> : null}
                </div>
                <div className="b-deckmeta">
                  <input className="input deckname" value={name} placeholder={deck.name} onChange={e => setName(e.target.value)} aria-label="Deck name" maxLength={60} />
                  <div className="b-cmdline">
                    {look.energy.length ? <span className="pkb-energy" aria-label={`Energy: ${look.energy.join(', ')}`}>{look.energy.map(t => <Energy key={t} type={t} size={18} />)}</span> : <span className="muted">No Energy yet</span>}
                    <span className="muted">Tap any card to read it</span>
                  </div>
                </div>
                <div className={`b-total ${total === DECK_SIZE ? 'full' : total > DECK_SIZE ? 'over' : ''}`} aria-label={`${total} of 60 cards`}>
                  <b>{total}</b><span>/ 60</span>
                  <i className="b-ring" style={{ '--p': Math.min(100, Math.round((100 * total) / DECK_SIZE)) }} />
                </div>
              </div>
              <QuickAdd entries={entries} have={cards} problemFor={problemFor} onAdd={add} onOpen={open} onPasteList={text => setImporting({ text, mode: 'add' })} />
              <RulesCheck cards={list} db={db} onFind={find} />
              <div className="b-tabs" role="tablist">
                <button role="tab" aria-selected={right === 'cards'} className={right === 'cards' ? 'on' : ''} onClick={() => setRight('cards')}>Cards <small>{total}</small></button>
                <button role="tab" aria-selected={right === 'stats'} className={right === 'stats' ? 'on' : ''} onClick={() => setRight('stats')}>Numbers</button>
                <button role="tab" aria-selected={right === 'test'} className={right === 'test' ? 'on' : ''} onClick={() => setRight('test')}>Test hand</button>
              </div>
              <div className="b-tabbody">
                {right === 'cards' ? <DeckList list={list} ix={ix} problemFor={problemFor} onOpen={open} onAdd={add} onRemove={remove} onFillEnergy={fillEnergy} total={total} hv={hv} /> : null}
                {right === 'stats' ? <DeckNumbers list={list} db={db} total={total} onTest={() => setRight('test')} /> : null}
                {right === 'test' ? <TestHand list={list} db={db} onOpen={open} hv={hv} /> : null}
              </div>
              <div className="b-foot">
                <div className="b-status">
                  {ready ? <p className="ready">✓ Ready to play</p> : <p className="todo">{todo.join(' · ').replace(/^./, c => c.toUpperCase())}</p>}
                  <span className="saved">{savedLine}</span>
                </div>
                <div className="b-acts">
                  {start.saved || savedAt ? (confirmDelete ? <button className="btn sm danger" onClick={() => { dirty.current = false; deleteCustomDeck(id); onDone(); }}>Delete for good?</button> : <button className="btn sm ghost" onClick={() => setConfirmDelete(true)}>Delete</button>) : null}
                  <button className="btn sm" onClick={copyList}>Copy list</button>
                  <button className="btn primary" onClick={() => onPlay(saveNow())} disabled={!ready} title={ready ? 'Play a battle with this deck' : 'Finish the deck first'}>Play this deck</button>
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
      <HoverCard hover={hv.hover} db={db} />
      {sheet ? <CardSheet cardKey={sheet} ix={ix} have={cards} featured={look.featured} problem={problemFor(sheet)} onClose={() => setSheet(null)} onOpen={setSheet} onAdd={add} onRemove={remove} onFeature={k => { setFeatured(k); flash(`${db[k].name} is your deck’s picture now.`); }} /> : null}
      {importing ? <ImportDialog ix={ix} hasDeck={list.length > 0} initial={importing.text} initialMode={importing.mode} onImport={doImport} onClose={() => setImporting(null)} /> : null}
      {picking ? <DeckPicker decks={builtIn} db={db} onPick={usePrecon} onClose={() => setPicking(false)} /> : null}
      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </div>
  );
}
