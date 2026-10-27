// The One Piece deck builder: a Leader, then exactly 50 cards from the ones the rules engine implements, at most 4 of
// any card number, every card sharing a color with the Leader, no Leaders among them. Start by picking a Leader (all of
// them, by color, with pictures), from a copy of a starter deck, or from a pasted list (OPTCGSim, Egman Events,
// Limitless, or typed by hand), then add cards by searching, by typing a name or number, or by pasting more. The rules
// check says what's left in plain words as you go; the numbers show the cost curve and the Counters; test hands show a
// first draw. Every change can be undone, and the deck saves on this device as you go. Your decks play like the
// starter decks, against the computer or with friends (mydecks.js).
import { KwTip } from './glossary.jsx';
import { ColorDot } from './colors.jsx';
import { subscribeOp, opImagesVersion } from './images.js';
import { Modal, SizeButton } from '../../ui/dialogs.jsx';
import { parseDeckList, resolveList, countCards, deckToText, MAX_COPIES, DECK_SIZE, NAME_MAX } from './decktext.js';
import { loadMyDecks, saveMyDeck, deleteMyDeck, newDeckId, rulesCheck } from './mydecks.js';
import { deckById, baseDeckId } from './decks.js';
import { CardSearch, LeaderPicker, StarterPicker, CardSheet, CardTile, HoverCard, useHoverPreview } from './builderfind.jsx';
import { RulesCheck, QuickAdd, DeckCards, DeckNumbers, TestHand } from './builderdeck.jsx';

const { useState, useMemo, useEffect, useRef, useSyncExternalStore } = React;
// a decklist as a map, adding up a card listed more than once
const toMap = list => { const m = new Map(); for (const [id, n] of list) m.set(id, (m.get(id) || 0) + n); return m; };
const byNumber = (a, b) => a[0].localeCompare(b[0], 'en', { numeric: true });
// a starter deck's copy: "Straw Hat Crew (my version)", or for an Ultra Deck led by another of its Leaders "... (Sabo) (my version)"
const myVersion = (box, lead, cards) => `${box.name}${lead !== box.leader ? ` (${cards[lead].name})` : ''} (my version)`.slice(0, NAME_MAX);

// ---- pasting a list: what it holds shows as you paste; a Leader or a card name several cards share is asked about,
// near-miss names are read as the card they're closest to, and cards the game doesn't have come with suggestions
const chipLabel = c => `${c.id} · ${c.cat === 'L' ? `${c.colors.join('/')} · ${c.life} Life` : `Cost ${c.cost}${c.power != null ? ` · ${c.power}` : ''}${c.counter ? ` · +${c.counter}` : ''}`}`;
function Pick({ c, on, onClick }) {
  return <button type="button" className={`chip opb-pickchip ${on ? 'on' : ''}`} aria-pressed={on} onClick={onClick} title={c.text || c.name}><ColorDot colors={c.colors} size={11} />{chipLabel(c)}</button>;
}
function ImportDialog({ cards, leader, inDeck, hasDeck, initial = '', initialMode = 'replace', onImport, onClose }) {
  const [text, setText] = useState(initial);
  const [mode, setMode] = useState(hasDeck ? initialMode : 'replace');
  const [picks, setPicks] = useState(() => new Map());     // a name several cards share -> the number meant ('none': left out)
  const [swaps, setSwaps] = useState(() => new Map());     // a card the game doesn't have -> the one used instead
  const [leadPick, setLeadPick] = useState(null);          // the Leader, when the list's could be one of a few ('none': not one of them)
  // (adding to the deck: a name several cards share means the one the deck already has, if the copies fit)
  const parsed = useMemo(() => (text.trim() ? parseDeckList(text, cards, { leader, prefer: mode === 'add' ? inDeck : null }) : null), [text, mode]);
  useEffect(() => { setPicks(new Map()); setLeadPick(null); }, [parsed]);
  const keepLeader = mode === 'add' && !!leader;
  const result = useMemo(() => (parsed ? resolveList(parsed, { picks, swaps, leader: leadPick !== 'none' ? leadPick : null }) : null), [parsed, picks, swaps, leadPick]);
  const n = result ? countCards(result.cards) : 0;
  const asks = parsed ? parsed.ambiguous.filter(a => !picks.has(a.key)).length + (parsed.leaderOptions.length && !leadPick && !keepLeader ? 1 : 0) : 0;
  const newLeader = result && !keepLeader ? result.leader : null;
  const lead = cards[newLeader || leader];
  const off = result && lead ? [...result.cards.keys()].filter(id => !cards[id].colors.some(k => lead.colors.includes(k))) : [];
  const left = parsed ? parsed.missing.filter(m => !swaps.has(m.label)) : [];
  const nm = id => (cards[id] || {}).name || id;
  const readFile = e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    f.text().then(t => setText(t.slice(0, 100000)), () => {});
    e.target.value = '';
  };
  const setIn = (set, k, v) => set(m => { const x = new Map(m); if (x.get(k) === v) x.delete(k); else x.set(k, v); return x; });
  return (
    <Modal label="Paste a decklist" onClose={onClose}>
      <h2>Paste a decklist</h2>
      <p className="sub">Copy a list from OPTCGSim, Egman Events, Limitless or anywhere and paste it here, one card per line: “4xOP01-016”, “4 Nami (OP01-016)” or just “4 Nami”. Put the Leader first.</p>
      <div className="opb-impgrid">
        <div className="opb-impin">
          <textarea className="input opb-imptext" value={text} onChange={e => setText(e.target.value)} placeholder={'1xST01-001\n4xST01-007\n4xOP01-016\n4 Roronoa Zoro\n…'} aria-label="Decklist" autoFocus spellCheck={false} />
          <label className="btn sm ghost opb-filebtn">Open a text file<input type="file" accept=".txt,text/plain" onChange={readFile} /></label>
        </div>
        <div className="opb-impout" aria-live="polite">
          {!parsed ? <p className="muted">What the list holds shows here as you paste.</p> : <>
            <p className="opb-impsum"><b>{n}</b> card{n === 1 ? '' : 's'} read{parsed.name ? <> from <q>{parsed.name}</q></> : null}{n > DECK_SIZE && mode === 'replace' ? ` (a deck has ${DECK_SIZE})` : ''}</p>
            {keepLeader ? <p className="opb-impnote">Your Leader stays: {nm(leader)}.</p>
              : parsed.leader ? <p className="opb-implead">Leader: <b>{nm(parsed.leader)}</b> <span className="opb-num">{parsed.leader}</span> <ColorDot colors={cards[parsed.leader].colors} size={12} /></p>
                : parsed.leaderOptions.length ? (
                  <div className="opb-ask">
                    <p>Which {nm(parsed.leaderOptions[0])} is your Leader?</p>
                    <div className="opb-chips">
                      {parsed.leaderOptions.map(id => <Pick key={id} c={cards[id]} on={leadPick === id} onClick={() => setLeadPick(p => (p === id ? null : id))} />)}
                      <button type="button" className={`chip opb-pickchip ${leadPick === 'none' ? 'on' : ''}`} aria-pressed={leadPick === 'none'} onClick={() => setLeadPick(p => (p === 'none' ? null : 'none'))}>{leader ? 'Keep mine' : 'Choose later'}</button>
                    </div>
                  </div>
                ) : <p className="opb-impwarn">No Leader in this list{leader ? `: yours (${nm(leader)}) stays.` : '. You can choose one after.'}</p>}
            {parsed.extraLeaders.length ? <p className="opb-impnote">One Leader per deck: {parsed.extraLeaders.map(nm).join(', ')} left out.</p> : null}
            {parsed.leadersOut.length ? <p className="opb-impnote">Leaders can’t be in the 50: {parsed.leadersOut.map(nm).join(', ')} left out.</p> : null}
            {parsed.ambiguous.map(a => (
              <div key={a.key} className="opb-ask">
                <p>Which <b>{a.label}</b> do you mean? <span className="muted">({a.n} {a.n === 1 ? 'copy' : 'copies'}: the game has {a.options.length} cards by that name{lead ? ` in ${lead.colors.join(' or ')}` : ''})</span></p>
                <div className="opb-chips">
                  {a.options.map(id => <Pick key={id} c={cards[id]} on={picks.get(a.key) === id} onClick={() => setIn(setPicks, a.key, id)} />)}
                  <button type="button" className={`chip opb-pickchip ${picks.get(a.key) === 'none' ? 'on' : ''}`} aria-pressed={picks.get(a.key) === 'none'} onClick={() => setIn(setPicks, a.key, 'none')}>Leave it out</button>
                </div>
              </div>
            ))}
            {parsed.fixed.length ? <div className="opb-impnote"><p>Read as the closest name:</p><ul>{parsed.fixed.map(f => <li key={f.from}>{f.from} → <b>{f.to}</b></li>)}</ul></div> : null}
            {parsed.clamped.length ? <p className="opb-impnote">Up to 4 of each card: kept 4 of {parsed.clamped.map(nm).join(', ')}.</p> : null}
            {parsed.skipped ? <p className="opb-impnote">DON!! cards left out: every deck brings its own 10.</p> : null}
            {off.length ? <p className="opb-impwarn">Not {lead.colors.join(' or ')}: {off.slice(0, 3).map(nm).join(', ')}{off.length > 3 ? ` and ${off.length - 3} more` : ''}. They’ll be marked in your deck.</p> : null}
            {parsed.missing.length ? (
              <div className="opb-impmissing">
                <p><b>{left.length ? `${left.length} not in the game yet` : 'All replaced'}</b>{left.length ? ' (left out)' : ''}{parsed.missing.some(m => m.suggestions.length) ? '. Tap a card to use it instead:' : '.'}</p>
                <ul>
                  {parsed.missing.slice(0, 30).map(m => (
                    <li key={m.label} className={swaps.has(m.label) ? 'swapped' : ''}>
                      <span className="opb-gone">{m.n > 1 ? `${m.n} ` : ''}{m.label}</span>
                      {m.suggestions.map(id => <button key={id} type="button" className={`chip sm opb-pickchip ${swaps.get(m.label) === id ? 'on' : ''}`} aria-pressed={swaps.get(m.label) === id} onClick={() => setIn(setSwaps, m.label, id)} title={cards[id].text || ''}>{nm(id)} · {id}</button>)}
                    </li>
                  ))}
                  {parsed.missing.length > 30 ? <li>and {parsed.missing.length - 30} more</li> : null}
                </ul>
              </div>
            ) : null}
          </>}
        </div>
      </div>
      {hasDeck ? (
        <div className="seg opb-impmode" role="group" aria-label="What to do with your deck">
          <button type="button" className={mode === 'replace' ? 'on' : ''} aria-pressed={mode === 'replace'} onClick={() => setMode('replace')}>Replace my deck</button>
          <button type="button" className={mode === 'add' ? 'on' : ''} aria-pressed={mode === 'add'} onClick={() => setMode('add')}>Add to my deck</button>
        </div>
      ) : null}
      <div className="dlg-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!!asks || !(n || newLeader)} onClick={() => onImport({ ...result, leader: newLeader, name: parsed.name, mode })}>
          {asks ? `Answer ${asks === 1 ? 'the question' : `${asks} questions`} first` : mode === 'add' && hasDeck ? `Add ${n} card${n === 1 ? '' : 's'}` : 'Use this list'}
        </button>
      </div>
    </Modal>
  );
}

const ICONS = {
  flag: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 2h2v20H5zm3 1h11l-3 4.5 3 4.5H8z" /></svg>,
  box: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l9 4.5v11L12 22l-9-4.5v-11zm0 2.2L5.5 7.5 12 10.8l6.5-3.3zM5 9.1v7.2l6 3v-7.2zm8 10.2l6-3V9.1l-6 3z" /></svg>,
  paste: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 2h6a1 1 0 011 1v1h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2V3a1 1 0 011-1zm1 2v2h4V4zM8 10v2h8v-2zm0 4v2h6v-2z" /></svg>,
  search: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 3a7 7 0 015.6 11.2l4.6 4.6-1.4 1.4-4.6-4.6A7 7 0 1110 3zm0 2a5 5 0 100 10 5 5 0 000-10z" /></svg>,
  undo: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7V3L2 9l6 6v-4h6a4 4 0 010 8h-3v2h3a6 6 0 000-12z" /></svg>,
  redo: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 7V3l6 6-6 6v-4h-6a4 4 0 000 8h3v2h-3a6 6 0 010-12z" /></svg>,
};

// ---- before there's a Leader: the ways to start, and the rules in four lines
function StartPanel({ leaders, starters, waiting, onPick, onStarter, onImport }) {
  return (
    <section className="panel opb-start" aria-label="Start a deck">
      <h2>Build a One Piece deck</h2>
      <p className="sub">Choose how to start. You can change anything later, and every change can be undone.</p>
      {waiting ? <p className="opb-waiting">{waiting} card{waiting === 1 ? ' is' : 's are'} ready from your list. <button className="linkish" onClick={onPick}>Choose your Leader</button> to see {waiting === 1 ? 'it' : 'them'}.</p> : null}
      <div className="opb-ways">
        <button className="opb-way" onClick={onPick}>{ICONS.flag}<b>Pick a Leader</b><span>Browse all {leaders} Leaders by color, then add the cards you like.</span></button>
        <button className="opb-way" onClick={onStarter}>{ICONS.box}<b>Copy a starter deck</b><span>Start from one of the {starters} decks as it comes in the box, and make it yours.</span></button>
        <button className="opb-way" onClick={onImport}>{ICONS.paste}<b>Paste a decklist</b><span>From OPTCGSim, Egman Events, Limitless or anywhere: “4xOP01-016” or “4 Nami”.</span></button>
      </div>
      <div className="opb-howto">
        <h3>How a One Piece deck works</h3>
        <ul>
          <li><b>1 Leader and exactly 50 cards.</b> Every deck also gets 10 DON!! cards: you don’t add those.</li>
          <li><b>Up to 4 of each card</b>, counted by its number (like OP01-016). Two cards with the same name but different numbers are different cards.</li>
          <li><b>Your Leader’s colors are your colors.</b> Every card must share a color with your Leader.</li>
          <li><b>No Leaders in the 50.</b> Your Leader starts the game in front of you.</li>
        </ul>
      </div>
    </section>
  );
}

export function OpBuilder({ data, editId, fromId, onDone, onPlay, onHome }) {
  useSyncExternalStore(subscribeOp, opImagesVersion);
  const cards = data.cards;
  // where it starts: one of your decks, a copy of a starter deck (an Ultra Deck with the Leader picked), or nothing
  const [start] = useState(() => {
    const mine = editId && loadMyDecks().find(d => d.id === editId);
    if (mine) return { id: mine.id, name: mine.name, leader: mine.leader, cards: mine.cards, saved: true };
    const pre = fromId && deckById(data, fromId);
    const box = pre && data.decks.find(d => d.id === baseDeckId(pre.id));
    if (pre && box) return { id: newDeckId(), name: myVersion(box, pre.leader, cards), leader: pre.leader, cards: pre.cards, saved: false, copied: true };
    return { id: newDeckId(), name: '', leader: null, cards: [], saved: false };
  });
  const id = start.id;
  const [name, setNameRaw] = useState(start.name);

  // ---- the deck, with undo and redo
  const [hist, setHist] = useState(() => ({ past: [], now: { leader: start.leader, cards: toMap(start.cards) }, future: [], rev: 0 }));
  const { leader } = hist.now;
  const deckMap = hist.now.cards;
  const dirty = useRef(false);   // (a starter deck's copy saves once you change something, or play it)
  const commit = f => setHist(h => {
    const next = f(h.now);
    if (!next || next === h.now) return h;
    dirty.current = true;
    return { past: [...h.past.slice(-100), h.now], now: next, future: [], rev: h.rev + 1 };
  });
  const setCards = upd => commit(now => { const c = upd(now.cards); return c === now.cards ? now : { ...now, cards: c }; });
  const undo = () => setHist(h => (h.past.length ? { past: h.past.slice(0, -1), now: h.past[h.past.length - 1], future: [h.now, ...h.future], rev: h.rev + 1 } : h));
  const redo = () => setHist(h => (h.future.length ? { past: [...h.past, h.now], now: h.future[0], future: h.future.slice(1), rev: h.rev + 1 } : h));
  const setName = v => { dirty.current = true; setNameRaw(v); };
  useEffect(() => { if (hist.rev) dirty.current = true; }, [hist.rev]);

  const lead = cards[leader];
  const list = useMemo(() => [...deckMap].filter(([, n]) => n > 0).sort(byNumber), [deckMap]);
  const total = list.reduce((a, [, n]) => a + n, 0);
  const deck = { id, name: name.trim() || (lead ? `${lead.colors.join('/')} ${lead.name}` : 'New deck'), leader, cards: list };
  const rows = rulesCheck(deck, cards);
  const ready = rows.every(r => r.ok);
  const starters = useMemo(() => {
    const per = data.decks.map(d => d.cards.reduce((a, [k, n]) => [a[0] + (cards[k] && cards[k].counter ? n : 0), a[1] + (cards[k] && cards[k].counter === 2000 ? n : 0)], [0, 0]));
    return { counter: Math.round(per.reduce((a, x) => a + x[0], 0) / per.length), c2: Math.round(per.reduce((a, x) => a + x[1], 0) / per.length) };
  }, [data]);

  // ---- saving as you go (once there's a Leader), and once more on the way out
  const [savedAt, setSavedAt] = useState(start.saved ? Date.now() : null);
  const latest = useRef(deck);
  latest.current = deck;
  const saveNow = () => { if (!latest.current.leader) return null; saveMyDeck(latest.current); dirty.current = false; setSavedAt(Date.now()); return latest.current; };
  useEffect(() => {
    if (!dirty.current || !leader) return;
    const t = setTimeout(saveNow, 600);
    return () => clearTimeout(t);
  }, [hist.rev, name]);
  useEffect(() => () => { if (dirty.current && latest.current.leader) saveMyDeck(latest.current); }, []);

  // ---- what's on screen
  const [left, setLeft] = useState(() => (start.leader ? 'search' : 'leader'));   // search, leader
  const [right, setRight] = useState('cards');      // cards, stats, test
  const [pane, setPane] = useState('deck');         // (phones: one side at a time; the start screen is on the deck side)
  const [groupBy, setGroupBy] = useState('type');
  const [sheet, setSheet] = useState(null);
  const [importing, setImporting] = useState(null); // null, or { text, mode } to open the paste dialog with
  const [starterPick, setStarterPick] = useState(false);
  const [toast, setToast] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const hv = useHoverPreview();
  const flash = t => { setToast(t); setTimeout(() => setToast(x => (x === t ? null : x)), 2800); };
  const choosing = left === 'leader' || !leader;

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
  const add = (cid, k = 1) => {
    const c = cards[cid];
    const have = deckMap.get(cid) || 0;
    if (k > 0) {
      if (!c) return;
      if (!leader) { flash('Choose a Leader first.'); return; }
      if (c.cat === 'L') { flash(`${c.name} is a Leader: it can lead a deck, but not be one of the 50.`); return; }
      if (have >= MAX_COPIES) { flash(`A deck can have up to 4 of each card: you have 4 ${c.name} (${cid}).`); return; }
      if (!c.colors.some(x => lead.colors.includes(x))) { flash(`${c.name} is ${c.colors.join('/')}: your Leader is ${lead.colors.join('/')}.`); return; }
    }
    setCards(m => { const next = new Map(m); const v = (next.get(cid) || 0) + k; if (v <= 0) next.delete(cid); else next.set(cid, v); return next; });
    if (k > 0 && total + 1 === DECK_SIZE) flash('That’s 50 cards: your deck is full.');
  };
  const remove = cid => add(cid, -1);
  const chooseLeader = lid => {
    const c = cards[lid];
    if (!c || c.cat !== 'L') return;
    // cards outside the new Leader's colors stay listed (marked) so nothing you picked is lost silently
    commit(now => (now.leader === lid ? now : { leader: lid, cards: now.cards }));
    if (leader && leader !== lid) {
      const off = list.filter(([x]) => cards[x] && !cards[x].colors.some(k => c.colors.includes(k))).length;
      flash(`${c.name} leads your deck now.${off ? ` ${off} card${off === 1 ? ' isn’t' : 's aren’t'} ${c.colors.join(' or ')}: they’re marked.` : ''}`);
    }
    setLeft('search'); setPane('deck');
  };
  const copyList = () => {
    const text = deckToText({ leader, cards: list }, cards);
    try { navigator.clipboard.writeText(text).then(() => flash('Decklist copied: paste it into OPTCGSim or anywhere.'), () => flash('Copying isn’t allowed here.')); } catch { flash('Copying isn’t allowed here.'); }
  };
  // a pasted list replaces the deck, or adds to it (up to 4 of each)
  const doImport = r => {
    const adding = r.mode === 'add' && (!!leader || list.length > 0);
    const nextLeader = adding && leader ? leader : r.leader || leader;
    const m = adding ? new Map(deckMap) : new Map();
    let added = 0, full = 0;
    for (const [cid, k] of r.cards) {
      const have = m.get(cid) || 0;
      const v = Math.min(MAX_COPIES, have + k);
      if (v === have) { full++; continue; }
      m.set(cid, v); added += v - have;
    }
    commit(() => ({ leader: nextLeader, cards: m }));
    if (r.name && !name.trim()) setName(r.name);
    setImporting(null); setLeft(nextLeader ? 'search' : 'leader'); setPane(nextLeader ? 'deck' : 'find');
    flash(adding
      ? `Added ${added} card${added === 1 ? '' : 's'}${full ? ` (${full} already had 4)` : ''}.`
      : `Read ${added} card${added === 1 ? '' : 's'}${r.leader ? ` and your Leader, ${cards[r.leader].name}` : ''}.${nextLeader ? '' : ' Now choose your Leader.'}`);
  };
  const copyStarter = (d, l) => {
    commit(() => ({ leader: l, cards: toMap(d.cards) }));
    if (!name.trim()) setName(myVersion(d, l, cards));
    setStarterPick(false); setLeft('search'); setPane('deck');
    flash(`${d.code} ${d.name} copied in. Change anything you like: the starter deck stays as it is.`);
  };
  const open = cid => { hv.clear(); setSheet(cid); };
  const offColor = lead ? list.filter(([x]) => cards[x] && cards[x].cat !== 'L' && !cards[x].colors.some(k => lead.colors.includes(k))).map(([x]) => x) : [];
  const savedLine = savedAt && !dirty.current ? 'Saved on this device' : dirty.current && leader ? 'Saving…' : leader ? 'Saves on this device when you change something' : 'Not saved yet: choose a Leader';
  const firstProblem = rows.find(r => !r.ok);

  return (
    <div className="app op opb">
      <KwTip />
      <header className="topbar">
        <button className="brand linklike" onClick={onHome} title="Choose a game">Lotus Goats</button>
        <span className="chip op-chip">One Piece Card Game</span>
        <span className="chip gold">Deck builder</span>
        <span className="spacer" />
        <span className="opb-undo">
          <button className="btn sm opb-iconbtn" onClick={undo} disabled={!hist.past.length} title="Undo (Ctrl+Z)" aria-label="Undo">{ICONS.undo}<span>Undo</span></button>
          <button className="btn sm opb-iconbtn" onClick={redo} disabled={!hist.future.length} title="Redo (Ctrl+Y)" aria-label="Redo">{ICONS.redo}<span>Redo</span></button>
        </span>
        <button className="btn sm" onClick={() => setImporting({ text: '', mode: 'replace' })}>Paste a list</button>
        <SizeButton />
        <button className="btn sm" onClick={() => { if (dirty.current) saveNow(); onDone(); }}>Back to decks</button>
      </header>
      <div className="opb-switch" role="tablist" aria-label="Builder sections">
        <button role="tab" aria-selected={pane === 'find'} className={pane === 'find' ? 'on' : ''} onClick={() => setPane('find')}>{choosing ? 'Choose a Leader' : 'Find cards'}</button>
        <button role="tab" aria-selected={pane === 'deck'} className={pane === 'deck' ? 'on' : ''} onClick={() => setPane('deck')}>{leader ? <>Your deck <b className={total === DECK_SIZE ? 'full' : total > DECK_SIZE ? 'over' : ''}>{total}/50</b></> : 'Start'}</button>
      </div>
      <div className={`opb-grid pane-${pane}`}>
        <section className="panel opb-left" aria-label="Find cards">
          <div className="opb-tabs" role="tablist">
            {leader ? <button role="tab" aria-selected={left === 'search'} className={left === 'search' ? 'on' : ''} onClick={() => setLeft('search')}>{ICONS.search}Find cards</button> : null}
            <button role="tab" aria-selected={choosing} className={choosing ? 'on' : ''} onClick={() => setLeft('leader')}>{ICONS.flag}{leader ? 'Leaders' : 'Choose a Leader'}</button>
          </div>
          {choosing
            ? <LeaderPicker cards={cards} decks={data.decks} current={leader} onOpen={open} onChoose={chooseLeader} hv={hv} />
            : <CardSearch cards={cards} leader={leader} deck={deckMap} onAdd={add} onRemove={remove} onOpen={open} hv={hv} />}
        </section>

        <div className="opb-right">
          {!leader ? (
            <StartPanel leaders={Object.values(cards).filter(c => c.cat === 'L').length} starters={data.decks.length} waiting={total}
              onPick={() => { setLeft('leader'); setPane('find'); }} onStarter={() => setStarterPick(true)} onImport={() => setImporting({ text: '', mode: 'replace' })} />
          ) : (
            <section className="panel opb-deck" aria-label="Your deck">
              <div className="opb-deckhead">
                <div className="opb-leadart"><CardTile c={lead} onOpen={() => open(leader)} onEnter={hv.enter(leader)} onLeave={hv.leave} label={`${lead.name}, your Leader: details`} /></div>
                <div className="opb-deckmeta">
                  <input className="input opb-deckname" value={name} placeholder={deck.name} onChange={e => setName(e.target.value)} aria-label="Deck name" maxLength={NAME_MAX} />
                  <div className="opb-leadline"><span>{lead.name}</span><ColorDot colors={lead.colors} size={14} /><span className="muted">{lead.colors.join(' / ')} · {lead.life} Life · {lead.power} power</span></div>
                  <div className="row"><button className="btn sm ghost" onClick={() => { setLeft('leader'); setPane('find'); }}>Change Leader</button></div>
                </div>
                <div className={`opb-total ${total === DECK_SIZE ? 'full' : total > DECK_SIZE ? 'over' : ''}`} aria-label={`${total} of 50 cards`}>
                  <b>{total}</b><span>/ 50</span>
                  <i className="opb-ring" style={{ '--p': Math.min(100, total * 2) }} />
                </div>
              </div>
              <QuickAdd cards={cards} leader={leader} deck={deckMap} onAdd={add} onOpen={open} onPasteList={text => setImporting({ text, mode: 'add' })} />
              <RulesCheck rows={rows} />
              <div className="opb-tabs opb-dtabs" role="tablist">
                <button role="tab" aria-selected={right === 'cards'} className={right === 'cards' ? 'on' : ''} onClick={() => setRight('cards')}>Cards <small>{total}</small></button>
                <button role="tab" aria-selected={right === 'stats'} className={right === 'stats' ? 'on' : ''} onClick={() => setRight('stats')}>Numbers</button>
                <button role="tab" aria-selected={right === 'test'} className={right === 'test' ? 'on' : ''} onClick={() => setRight('test')}>Test hand</button>
              </div>
              <div className="opb-tabbody">
                {right === 'cards' ? (list.length
                  ? <DeckCards cards={cards} leader={leader} list={list} groupBy={groupBy} setGroupBy={setGroupBy} onOpen={open} onAdd={add} onRemove={remove} hv={hv} />
                  : <div className="empty">No cards yet. Type a card’s name or number above, paste a list, or use Find cards.</div>) : null}
                {right === 'stats' ? <DeckNumbers cards={cards} leader={leader} list={list} starters={starters} onTest={() => setRight('test')} /> : null}
                {right === 'test' ? <TestHand cards={cards} list={list} onOpen={open} hv={hv} /> : null}
              </div>
              <div className="opb-foot">
                <div className="opb-status">
                  {offColor.length ? <p className="opb-warn">Not {lead.colors.join(' or ')}: {offColor.slice(0, 3).map(x => cards[x].name).join(', ')}{offColor.length > 3 ? ` and ${offColor.length - 3} more` : ''}. <button className="linkish" onClick={() => setCards(m => { const next = new Map(m); offColor.forEach(x => next.delete(x)); return next; })}>Take them out</button></p> : null}
                  {ready ? <p className="opb-ready">✓ Ready to play</p> : <p className="opb-todo">{firstProblem.id === 'size' || firstProblem.id === 'leader' ? firstProblem.text : `${firstProblem.label}: ${firstProblem.text}`}</p>}
                  <span className="opb-saved">{savedLine}</span>
                </div>
                <div className="opb-acts">
                  {start.saved || savedAt ? (confirmDelete ? <button className="btn sm danger" onClick={() => { dirty.current = false; deleteMyDeck(id); onDone(); }}>Delete for good?</button> : <button className="btn sm ghost" onClick={() => setConfirmDelete(true)}>Delete</button>) : null}
                  <button className="btn sm" onClick={copyList} disabled={!list.length}>Copy list</button>
                  <button className="btn primary" onClick={() => onPlay(saveNow())} disabled={!ready} title={ready ? 'Play a battle with this deck' : 'Finish the deck first'}>Play this deck</button>
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
      <HoverCard hover={hv.hover} cards={cards} />
      {sheet ? <CardSheet id={sheet} cards={cards} leader={leader} deck={deckMap} choosing={choosing} onClose={() => setSheet(null)} onOpen={setSheet} onAdd={add} onRemove={remove} onLeader={chooseLeader} /> : null}
      {importing ? <ImportDialog cards={cards} leader={leader} inDeck={deckMap} hasDeck={!!(leader || list.length)} initial={importing.text} initialMode={importing.mode} onImport={doImport} onClose={() => setImporting(null)} /> : null}
      {starterPick ? <StarterPicker data={data} onPick={copyStarter} onClose={() => setStarterPick(false)} /> : null}
      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </div>
  );
}
