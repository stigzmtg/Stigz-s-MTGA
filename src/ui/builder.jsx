// The Commander deck builder: pick a commander, then 99 more cards from the 6,400 the rules engine has scripts for,
// within the commander's colors and one copy each (basic lands excepted). Start from nothing, from the AI helper,
// from a copy of a precon or from a pasted list. The checklist says what a deck still needs and why; every card
// opens to show its job and how it fits; the numbers and test hands show how the deck will play. Every change can be
// undone, and the deck saves on this device as you go. Decks play like any precon, solo or with friends.
import { Pip } from './cardview.jsx';
import { subscribeImages, imagesVersion } from './images.js';
import { buildIndex, BASICS, deckProblems, loadCustomDecks, saveCustomDeck, deleteCustomDeck, newDeckId } from './customdecks.js';
import { Modal } from './dialogs.jsx';
import { createDeckHelper } from './deckai.js';
import { DeckHelper } from './deckhelper.jsx';
import { CardSheet, HoverCard, useHoverPreview, CardTile } from './buildercard.jsx';
import { CardSearch, CommanderPicker, PreconPicker } from './builderfind.jsx';
import { Checklist, DeckList, DeckStats, TestHand } from './builderdeck.jsx';
export { Cost } from './buildercard.jsx';

const { useState, useMemo, useEffect, useRef, useSyncExternalStore } = React;
const BASIC_FOR = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' };
// a decklist as a map, adding up a card listed more than once (precons list each printing)
const toMap = cards => { const m = new Map(); for (const [n, k] of cards) m.set(n, (m.get(n) || 0) + k); return m; };

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
      <h2>Paste a decklist</h2>
      <p className="sub">One card per line (“1 Sol Ring”), copied from Moxfield, Archidekt, EDHREC or anywhere. Put the commander under a “Commander” line, or mark it *CMDR*. Cards the game can’t play yet are left out.</p>
      <textarea className="input builder-import" value={text} onChange={e => setText(e.target.value)} placeholder={'Commander\n1 Atraxa, Praetors\' Voice\n\nDeck\n1 Sol Ring\n1 Arcane Signet\n…'} aria-label="Decklist" autoFocus />
      {parsed ? <p className="note">{parsed.commanders.length ? `Commander: ${parsed.commanders.join(' & ')}. ` : 'No commander marked. '}{[...parsed.cards.values()].reduce((a, b) => a + b, 0)} other cards found{parsed.missing.length ? `; not available: ${parsed.missing.slice(0, 6).join(', ')}${parsed.missing.length > 6 ? ` and ${parsed.missing.length - 6} more` : ''}` : ''}.</p> : null}
      <div className="dlg-actions"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!parsed} onClick={() => onImport(parsed)}>Use this list</button></div>
    </Modal>
  );
}

const ICONS = {
  spark: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l1.8 4.6L18.5 8l-4.7 1.5L12 14l-1.8-4.5L5.5 8l4.7-1.4z" /><path d="M18.5 13l.9 2.3 2.3.8-2.3.8-.9 2.3-.9-2.3-2.3-.8 2.3-.8z" /></svg>,
  crown: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7l4.5 4L12 4l4.5 7L21 7l-2 11H5z" /></svg>,
  box: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l9 4.5v11L12 22l-9-4.5v-11zm0 2.2L5.5 7.5 12 10.8l6.5-3.3zM5 9.1v7.2l6 3v-7.2zm8 10.2l6-3V9.1l-6 3z" /></svg>,
  paste: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 2h6a1 1 0 011 1v1h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2V3a1 1 0 011-1zm1 2v2h4V4zM8 10v2h8v-2zm0 4v2h6v-2z" /></svg>,
  search: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 3a7 7 0 015.6 11.2l4.6 4.6-1.4 1.4-4.6-4.6A7 7 0 1110 3zm0 2a5 5 0 100 10 5 5 0 000-10z" /></svg>,
  undo: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7V3L2 9l6 6v-4h6a4 4 0 010 8h-3v2h3a6 6 0 000-12z" /></svg>,
  redo: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 7V3l6 6-6 6v-4h-6a4 4 0 000 8h3v2h-3a6 6 0 010-12z" /></svg>,
};

// ---- before there's a commander: the ways to start, and the rules in four lines
function StartPanel({ onHelper, onPick, onPrecon, onImport, commanders }) {
  return (
    <section className="panel b-start" aria-label="Start a deck">
      <h2>Build a Commander deck</h2>
      <p className="sub">Choose how to start. You can change anything later, and every change can be undone.</p>
      <div className="b-ways">
        <button className="b-way" onClick={onHelper}>{ICONS.spark}<b>Let the helper build one</b><span>Say what you like (dragons, tokens, a color) and it finds a commander, then picks all 99 cards with you.</span></button>
        <button className="b-way" onClick={onPick}>{ICONS.crown}<b>Pick a commander myself</b><span>Browse all {commanders.toLocaleString('en-US')} commanders by color, then add cards your way.</span></button>
        <button className="b-way" onClick={onPrecon}>{ICONS.box}<b>Upgrade a precon</b><span>Start from one of the ready-made decks and make it yours.</span></button>
        <button className="b-way" onClick={onImport}>{ICONS.paste}<b>Paste a decklist</b><span>From Moxfield, Archidekt, EDHREC or anywhere else.</span></button>
      </div>
      <div className="b-rules">
        <h3>How a Commander deck works</h3>
        <ul>
          <li><b>100 cards</b>, counting your commander.</li>
          <li><b>One commander</b>: a legendary creature that waits in the command zone, so you can cast it every game.</li>
          <li><b>Its colors are your colors.</b> Every card has to fit inside your commander’s colors.</li>
          <li><b>One copy of each card</b>, except basic lands.</li>
        </ul>
      </div>
    </section>
  );
}

export function DeckBuilder({ data, editId, fromId, onDone, onPlay, onHome }) {
  useSyncExternalStore(subscribeImages, imagesVersion);
  const index = useMemo(() => buildIndex(data.db.raw), [data]);
  const byName = useMemo(() => new Map(index.map(c => [c.name, c])), [index]);
  const H = useMemo(() => createDeckHelper(index, data.decks, data.support || {}), [index]);
  const commanderCount = useMemo(() => index.filter(c => c.commander && H.feats.get(c.name).legal).length, [index]);
  // where it starts: a saved deck, a copy of a precon, or nothing
  const [start] = useState(() => {
    const mine = editId && loadCustomDecks().find(d => d.id === editId);
    if (mine) return { id: mine.id, name: mine.name, commanders: mine.commanders, cards: mine.cards, saved: true };
    const pre = fromId && data.decks.find(d => d.id === fromId);
    if (pre) return { id: newDeckId(), name: `${pre.name} (my version)`, commanders: pre.commanders, cards: pre.cards, saved: false, copied: true };
    return { id: newDeckId(), name: '', commanders: [], cards: [], saved: false };
  });
  const id = start.id;
  const [name, setNameRaw] = useState(start.name);

  // ---- the deck, with undo and redo
  const [hist, setHist] = useState(() => ({ past: [], now: { commanders: start.commanders, cards: toMap(start.cards) }, future: [], rev: 0 }));
  const { commanders, cards } = hist.now;
  const dirty = useRef(false);   // (a precon copy saves once you change something, or play it)
  const commit = f => setHist(h => {
    const next = f(h.now);
    if (!next || next === h.now) return h;
    dirty.current = true;
    return { past: [...h.past.slice(-100), h.now], now: next, future: [], rev: h.rev + 1 };
  });
  const setCards = upd => commit(now => { const c = typeof upd === 'function' ? upd(now.cards) : upd; return c === now.cards ? now : { ...now, cards: c }; });
  const undo = () => setHist(h => (h.past.length ? { past: h.past.slice(0, -1), now: h.past[h.past.length - 1], future: [h.now, ...h.future], rev: h.rev + 1 } : h));
  const redo = () => setHist(h => (h.future.length ? { past: [...h.past, h.now], now: h.future[0], future: h.future.slice(1), rev: h.rev + 1 } : h));
  const setName = v => { dirty.current = true; setNameRaw(v); };
  useEffect(() => { if (hist.rev) dirty.current = true; }, [hist.rev]);

  const identity = useMemo(() => { const s = new Set(); for (const n of commanders) for (const c of (byName.get(n) || { ci: [] }).ci) s.add(c); return ['W', 'U', 'B', 'R', 'G'].filter(c => s.has(c)); }, [commanders]);
  const list = useMemo(() => [...cards].filter(([, n]) => n > 0).sort((a, b) => a[0].localeCompare(b[0])), [cards]);
  const deck = { id, name: name.trim() || (commanders[0] ? `${commanders[0].split(',')[0]} deck` : 'New deck'), commanders, cards: list };
  const total = commanders.length + list.reduce((a, [, n]) => a + n, 0);
  const problems = deckProblems(deck, byName, identity);
  const state = useMemo(() => ({ commanders, cards }), [hist.now]);
  const deckRef = useRef(state);   // (the AI helper's tools read the deck as it is right now)
  deckRef.current = state;
  const rank = useMemo(() => (commanders.length ? H.rank(state) : null), [state]);
  const recipe = useMemo(() => H.recipe(state), [state]);

  // ---- saving as you go (once there's a commander), and once more on the way out
  const [savedAt, setSavedAt] = useState(start.saved ? Date.now() : null);
  const latest = useRef(deck);
  latest.current = deck;
  const saveNow = () => { if (!latest.current.commanders.length) return null; saveCustomDeck(latest.current); dirty.current = false; setSavedAt(Date.now()); return latest.current; };
  useEffect(() => {
    if (!dirty.current || !commanders.length) return;
    const t = setTimeout(saveNow, 700);
    return () => clearTimeout(t);
  }, [hist.rev, name]);
  useEffect(() => () => { if (dirty.current && latest.current.commanders.length) saveCustomDeck(latest.current); }, []);

  // ---- what's on screen
  const [left, setLeft] = useState(() => (start.commanders.length ? 'search' : 'helper'));   // helper, search, commander
  const [partnerMode, setPartnerMode] = useState(false);
  const [right, setRight] = useState('cards');      // cards, stats, test
  const [pane, setPane] = useState('deck');   // (phones: one side at a time; the start screen is on the deck side)
  const [groupBy, setGroupBy] = useState('type');
  const [sheet, setSheet] = useState(null);
  const [req, setReq] = useState(null);
  const [importing, setImporting] = useState(false);
  const [precons, setPrecons] = useState(false);
  const [toast, setToast] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const hv = useHoverPreview();
  const flash = t => { setToast(t); setTimeout(() => setToast(x => (x === t ? null : x)), 2800); };
  const choosing = left === 'commander' || !commanders.length;

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
  const add = (n, k = 1) => {
    const c = byName.get(n);
    if (!c) return;
    if (!commanders.length) { flash('Choose a commander first.'); return; }
    if (k > 0 && cards.get(n) && !c.anyNumber) { flash(`${n} is already in your deck: one copy of each card.`); return; }
    if (k > 0 && c.ci.some(x => !identity.includes(x))) { flash(`${n} is outside your commander’s colors.`); return; }
    setCards(m => { const next = new Map(m); const v = (next.get(n) || 0) + k; if (v <= 0) next.delete(n); else next.set(n, v); return next; });
    if (k > 0 && total + 1 === 100) flash('That’s 100 cards: your deck is full.');
  };
  const remove = n => add(n, -1);
  const chooseCommander = n => {
    const c = byName.get(n);
    if (!c) return;
    if (partnerMode && commanders.length === 1) {
      if (!c.partner || !(byName.get(commanders[0]) || {}).partner) { flash('Both commanders need Partner.'); return; }
      commit(now => ({ commanders: [now.commanders[0], n], cards: (() => { const m = new Map(now.cards); m.delete(n); return m; })() }));
    } else {
      commit(now => {
        // cards outside the new commander's colors stay listed (marked) so nothing you picked is lost silently
        const m = new Map(now.cards); m.delete(n);
        return { commanders: [n], cards: m };
      });
      if (commanders.length && commanders[0] !== n) flash(`${n} is your commander now. Cards outside its colors are marked in your deck.`);
    }
    setPartnerMode(false); setLeft('search'); setPane('deck');
  };
  const fillBasics = () => {
    const need = 100 - total;
    if (need <= 0) return flash('Your deck already has 100 cards.');
    const mana = H.manaStats(state);
    const colors = identity.length ? identity : ['C'];
    const pips = Object.fromEntries(mana.colors.map(c => [c.color, c.share]));
    const w = colors.map(x => 0.25 + (pips[x] || 0)), sw = w.reduce((a, b) => a + b, 0);
    const n = w.map(v => Math.floor((need * v) / sw));
    for (let i = 0, left2 = need - n.reduce((a, b) => a + b, 0); left2 > 0; i++, left2--) n[i % n.length]++;
    setCards(m => { const next = new Map(m); colors.forEach((x, i) => { const land = x === 'C' ? 'Wastes' : BASIC_FOR[x]; if (n[i]) next.set(land, (next.get(land) || 0) + n[i]); }); return next; });
    flash(`Added ${need} basic land${need === 1 ? '' : 's'}.`);
  };
  const copyList = () => {
    const text = ['Commander', ...commanders.map(n => `1 ${n}`), '', 'Deck', ...list.map(([n, k]) => `${k} ${n}`)].join('\n');
    try { navigator.clipboard.writeText(text).then(() => flash('Decklist copied: paste it anywhere.'), () => flash('Copying isn’t allowed here.')); } catch { flash('Copying isn’t allowed here.'); }
  };
  const doImport = parsed => {
    commit(now => ({ commanders: parsed.commanders.length ? parsed.commanders : now.commanders, cards: new Map(parsed.cards) }));
    setImporting(false); setLeft('search'); setPane('deck');
    flash(`Imported ${[...parsed.cards.values()].reduce((a, b) => a + b, 0) + parsed.commanders.length} cards${parsed.missing.length ? `; ${parsed.missing.length} not available` : ''}.${parsed.commanders.length ? '' : ' Mark the commander, or choose one.'}`);
  };
  const usePrecon = d => {
    commit(() => ({ commanders: d.commanders.slice(), cards: toMap(d.cards) }));
    if (!name.trim()) setName(`${d.name} (my version)`);
    setPrecons(false); setLeft('search'); setPane('deck');
    flash(`${d.name} copied in. Change anything you like: the original precon stays as it is.`);
  };
  const find = kind => { setReq({ kind, at: Date.now() }); setLeft('search'); setPane('find'); };
  const open = n => { hv.clear(); setSheet(n); };

  const ready = problems.length === 0;
  const counts = { have: total, over: total > 100 };
  const savedLine = savedAt && !dirty.current ? 'Saved on this device' : dirty.current && commanders.length ? 'Saving…' : commanders.length ? 'Saves on this device when you change something' : 'Not saved yet: choose a commander';
  const offColor = list.filter(([n]) => { const c = byName.get(n); return c && c.ci.some(x => !identity.includes(x)); }).map(([n]) => n);

  return (
    <div className="app builder">
      <header className="topbar">
        <button className="brand linklike" onClick={onHome} title="Choose a game">Lotus Goats<small>Commander</small></button>
        <span className="chip gold">Deck builder</span>
        <span className="spacer" />
        <span className="undo-group">
          <button className="btn sm iconbtn" onClick={undo} disabled={!hist.past.length} title="Undo (Ctrl+Z)" aria-label="Undo">{ICONS.undo}<span>Undo</span></button>
          <button className="btn sm iconbtn" onClick={redo} disabled={!hist.future.length} title="Redo (Ctrl+Y)" aria-label="Redo">{ICONS.redo}<span>Redo</span></button>
        </span>
        <button className="btn sm" onClick={() => setImporting(true)}>Import list</button>
        <button className="btn sm" onClick={() => { if (dirty.current) saveNow(); onDone(); }}>Back to decks</button>
      </header>
      <div className="b-switch" role="tablist" aria-label="Builder sections">
        <button role="tab" aria-selected={pane === 'find'} className={pane === 'find' ? 'on' : ''} onClick={() => setPane('find')}>{choosing ? 'Choose a commander' : 'Find cards'}</button>
        <button role="tab" aria-selected={pane === 'deck'} className={pane === 'deck' ? 'on' : ''} onClick={() => setPane('deck')}>{commanders.length ? <>Your deck <b className={total === 100 ? 'full' : total > 100 ? 'over' : ''}>{total}/100</b></> : 'Start'}</button>
      </div>
      <div className={`b-grid pane-${pane}`}>
        <section className="panel b-left" aria-label="Find cards">
          <div className="builder-tabs" role="tablist">
            <button role="tab" aria-selected={left === 'helper'} className={left === 'helper' ? 'on' : ''} onClick={() => setLeft('helper')}>{ICONS.spark}AI helper</button>
            {commanders.length ? <button role="tab" aria-selected={left === 'search'} className={left === 'search' ? 'on' : ''} onClick={() => setLeft('search')}>{ICONS.search}Find cards</button> : null}
            <button role="tab" aria-selected={left === 'commander'} className={left === 'commander' ? 'on' : ''} onClick={() => { setLeft('commander'); setPartnerMode(false); }}>{ICONS.crown}{commanders.length ? 'Commanders' : 'Choose a commander'}</button>
          </div>
          <DeckHelper H={H} index={index} commanders={commanders} cards={cards} setCards={setCards} onChooseCommander={chooseCommander} onHover={() => {}} onOpen={open} byName={byName} hidden={left !== 'helper'}
            getDeck={() => deckRef.current} onApply={d => commit(() => ({ commanders: d.commanders.slice(), cards: new Map(d.cards) }))} />
          {left === 'search' && commanders.length ? <CardSearch H={H} index={index} db={data.db} state={state} identity={identity} rank={rank} onAdd={add} onOpen={open} hv={hv} req={req} /> : null}
          {left === 'commander' || (left === 'search' && !commanders.length) ? <CommanderPicker H={H} index={index} db={data.db} partnerOf={partnerMode ? commanders[0] : null} onOpen={open} onChoose={chooseCommander} hv={hv} /> : null}
        </section>

        <div className="b-right">
          {!commanders.length ? (
            <StartPanel commanders={commanderCount} onHelper={() => { setLeft('helper'); setPane('find'); setTimeout(() => { const el = document.querySelector('.helper-ask input'); if (el) el.focus(); }, 50); }} onPick={() => { setLeft('commander'); setPane('find'); }} onPrecon={() => setPrecons(true)} onImport={() => setImporting(true)} />
          ) : (
            <section className="panel b-deck" aria-label="Your deck">
              <div className="b-deckhead">
                <div className="b-cmdart">
                  {commanders.map(n => <CardTile key={n} def={data.db.get(n)} onOpen={() => open(n)} onEnter={hv.enter(n)} onLeave={hv.leave} label={`${n}, your commander: details`} />)}
                </div>
                <div className="b-deckmeta">
                  <input className="input deckname" value={name} placeholder={deck.name} onChange={e => setName(e.target.value)} aria-label="Deck name" maxLength={60} />
                  <div className="b-cmdline">
                    <span>{commanders.join(' & ')}</span>
                    {identity.length ? <span className="mana">{identity.map(c => <Pip key={c} s={c} />)}</span> : <span className="muted">colorless</span>}
                  </div>
                  <div className="row">
                    <button className="btn sm ghost" onClick={() => { setLeft('commander'); setPartnerMode(false); setPane('find'); }}>Change commander</button>
                    {commanders.length === 1 && (byName.get(commanders[0]) || {}).partner ? <button className="btn sm ghost" onClick={() => { setLeft('commander'); setPartnerMode(true); setPane('find'); }}>Add a partner</button> : null}
                  </div>
                </div>
                <div className={`b-total ${total === 100 ? 'full' : counts.over ? 'over' : ''}`} aria-label={`${total} of 100 cards`}>
                  <b>{total}</b><span>/ 100</span>
                  <i className="b-ring" style={{ '--p': Math.min(100, total) }} />
                </div>
              </div>
              <Checklist recipe={recipe} onFind={find} />
              <div className="b-tabs" role="tablist">
                <button role="tab" aria-selected={right === 'cards'} className={right === 'cards' ? 'on' : ''} onClick={() => setRight('cards')}>Cards <small>{total - commanders.length}</small></button>
                <button role="tab" aria-selected={right === 'stats'} className={right === 'stats' ? 'on' : ''} onClick={() => setRight('stats')}>Numbers</button>
                <button role="tab" aria-selected={right === 'test'} className={right === 'test' ? 'on' : ''} onClick={() => setRight('test')}>Test hand</button>
              </div>
              <div className="b-tabbody">
                {right === 'cards' ? (list.length || total < 100
                  ? <DeckList H={H} byName={byName} state={state} list={list} rank={rank} groupBy={groupBy} setGroupBy={setGroupBy} identity={identity} onOpen={open} onAdd={add} onRemove={remove} onFillLands={fillBasics} total={total} hv={hv} />
                  : null) : null}
                {right === 'cards' && !list.length ? <div className="empty">No cards yet. Ask the AI helper to build the rest, use the checklist’s Find buttons, or search on the left.</div> : null}
                {right === 'stats' ? <DeckStats H={H} byName={byName} state={state} list={list} recipe={recipe} total={total} onTest={() => setRight('test')} /> : null}
                {right === 'test' ? <TestHand H={H} db={data.db} byName={byName} state={state} list={list} onOpen={open} hv={hv} /> : null}
              </div>
              <div className="b-foot">
                <div className="b-status">
                  {offColor.length ? <p className="b-warn">Outside your commander’s colors: {offColor.slice(0, 3).join(', ')}{offColor.length > 3 ? ` and ${offColor.length - 3} more` : ''}. <button className="linkish" onClick={() => setCards(m => { const next = new Map(m); offColor.forEach(n => next.delete(n)); return next; })}>Remove them</button></p> : null}
                  {ready ? <p className="ready">✓ Ready to play</p> : <p className="todo">{total < 100 ? `${100 - total} more card${100 - total === 1 ? '' : 's'} to go` : total > 100 ? `${total - 100} card${total - 100 === 1 ? '' : 's'} too many: a Commander deck has exactly 100` : ''}{problems.filter(p => !/Outside your commander|exactly 100 cards/.test(p)).map(p => ` · ${p}`).join('')}</p>}
                  <span className="saved">{savedLine}</span>
                </div>
                <div className="b-acts">
                  {start.saved || savedAt ? (confirmDelete ? <button className="btn sm danger" onClick={() => { dirty.current = false; deleteCustomDeck(id); onDone(); }}>Delete for good?</button> : <button className="btn sm ghost" onClick={() => setConfirmDelete(true)}>Delete</button>) : null}
                  <button className="btn sm" onClick={copyList} disabled={!list.length}>Copy list</button>
                  <button className="btn primary" onClick={() => onPlay(saveNow())} disabled={!ready} title={ready ? 'Play a game with this deck' : 'Finish the deck first'}>Play this deck</button>
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
      <HoverCard hover={hv.hover} db={data.db} />
      {sheet ? <CardSheet name={sheet} H={H} db={data.db} byName={byName} state={state} choosing={choosing && !!(byName.get(sheet) || {}).commander && !commanders.includes(sheet)} onClose={() => setSheet(null)} onOpen={setSheet} onAdd={add} onRemove={remove} onCommander={chooseCommander} /> : null}
      {importing ? <ImportDialog byName={byName} onImport={doImport} onClose={() => setImporting(false)} /> : null}
      {precons ? <PreconPicker decks={data.decks} onPick={usePrecon} onClose={() => setPrecons(false)} /> : null}
      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </div>
  );
}
