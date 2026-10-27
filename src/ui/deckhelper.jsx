// The AI deck helper in the deck builder: a chat where you ask for anything in your own words ("make me a zombie deck",
// "why is my deck slow?", "swap the weakest cards for more removal") and Claude answers, changing the deck with the
// builder's tools as it goes (deckagent.js talks to it; agenttools.js does what it asks). Every answer that changed the
// deck can be undone in one step. Without the AI (offline, the claude.ai page, or switched off on the server) the
// built-in helper answers instead: it understands simpler requests and does the same jobs (deckai.js).
// (deckagent.js loads separately, through aiload.js, so the AI's code only downloads for players who use it.)
import { parseAsk, ROLES, THEME_NAMES, COLOR_NAMES } from './deckai.js';
import { Cost } from './buildercard.jsx';
import { BASICS } from './customdecks.js';
import { aiStatus } from './aiload.js';
import { createAgentTools, deckStatus } from './agenttools.js';

const { useState, useEffect, useRef } = React;

const and = list => (list.length <= 1 ? list.join('') : list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1]);
const pluralType = ty => (ty === 'Elf' ? 'Elves' : ty === 'Dwarf' ? 'Dwarves' : ty === 'Wolf' ? 'Wolves' : /y$/.test(ty) ? ty.slice(0, -1) + 'ies' : /(?:s|x|ch|sh)$/.test(ty) ? ty + 'es' : ty + 's');
const START_CHIPS = ['Dragons', 'Elves', 'Zombies', 'Tokens', 'Graveyard', 'Big creatures', 'Surprise me'];
const DECK_CHIPS = ['Build the rest for me', 'What does my deck need?', 'Suggest cards', 'What should I cut?', 'Make it cheaper', 'More removal'];
const AI_START_CHIPS = ['I love dragons', 'Build me a deck that makes lots of tokens', 'Surprise me with a fun commander', 'What makes a good commander?'];
const AI_DECK_CHIPS = ['Finish my deck for me', 'What does my deck need most?', 'How does this deck win?', 'Swap my weakest cards for better ones', 'Make the deck faster'];
const SPARK = <svg viewBox="0 0 24 24"><path d="M12 2l1.8 4.6L18.5 8l-4.7 1.5L12 14l-1.8-4.5L5.5 8l4.7-1.4z" /><path d="M18.5 13l.9 2.3 2.3.8-2.3.8-.9 2.3-.9-2.3-2.3-.8 2.3-.8z" /><path d="M6 15l.7 1.8 1.8.7-1.8.6L6 20l-.7-1.9-1.8-.6 1.8-.7z" /></svg>;

// the commander's plan in a sentence
function planWords(H, state) {
  const p = H.plan(state);
  const tribes = [...p.tribes].filter(([, w]) => w >= 4).map(([ty]) => pluralType(ty));
  const main = Object.entries(p.weights).filter(([, w]) => w >= 3).map(([th]) => THEME_NAMES[th]);
  const lean = Object.entries(p.weights).filter(([, w]) => w > 0 && w < 3).map(([th]) => THEME_NAMES[th]);
  const colors = p.identity.length ? p.identity.map(c => COLOR_NAMES[c]).join('-') : 'colorless';
  const parts = [...tribes, ...main];
  return { p, text: parts.length ? `a ${colors} deck about ${and(parts)}${lean.length ? `, leaning on ${and(lean.slice(0, 2))}` : ''}` : lean.length ? `a ${colors} deck that leans on ${and(lean.slice(0, 3))}` : `a ${colors} good-stuff deck: strong cards that do their job` };
}

// ---- the AI's words: short paragraphs, "- " lists, **bold**, and [[Card Name]] links that open the card
function Inline({ text, onOpen, byName }) {
  const out = [];
  const rx = /\[\[([^\]]{1,80})\]\]|\*\*([^*]{1,200})\*\*/g;
  let at = 0, m, k = 0;
  while ((m = rx.exec(text))) {
    if (m.index > at) out.push(text.slice(at, m.index));
    if (m[1]) {
      const name = m[1].trim();
      const card = byName.get(name) || [...byName.values()].find(c => c.lower === name.toLowerCase());
      out.push(card ? <button key={k++} type="button" className="cardlink" onClick={() => onOpen(card.name)}>{card.name}</button> : <b key={k++}>{name}</b>);
    } else out.push(<b key={k++}>{m[2]}</b>);
    at = rx.lastIndex;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}
function RichText({ text, onOpen, byName }) {
  const blocks = text.trim().split(/\n{2,}/);
  return blocks.map((b, i) => {
    const lines = b.split('\n');
    if (lines.every(l => /^\s*(?:[-*•]|\d+[.)])\s+/.test(l))) {
      const ordered = /^\s*\d/.test(lines[0]);
      const items = lines.map((l, j) => <li key={j}><Inline text={l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')} onOpen={onOpen} byName={byName} /></li>);
      return ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
    }
    return <p key={i}>{lines.map((l, j) => <React.Fragment key={j}>{j ? <br /> : null}<Inline text={l.replace(/^#+\s*/, '')} onOpen={onOpen} byName={byName} /></React.Fragment>)}</p>;
  });
}

// what a tool call did, in a few words (and the cards it touched)
function toolLine(name, input, r) {
  if (r && r.error) return { label: r.error, bad: true };
  const n = x => (x ? x.length : 0);
  switch (name) {
    case 'find_commanders': return { label: `Looked for commanders${input.query ? `: “${input.query}”` : ''}`, cards: (r.commanders || []).map(c => c.name) };
    case 'set_commander': return { label: `Made ${and(r.commanders || [])} your commander`, changed: true };
    case 'search_cards': return { label: `Searched cards${[input.job && ROLES[input.job], input.type, input.query && `“${input.query}”`, input.fits_plan && 'for the plan'].filter(Boolean).length ? `: ${[input.job && ROLES[input.job].toLowerCase(), input.type && input.type.toLowerCase() + 's', input.query && `“${input.query}”`, input.fits_plan && 'for the plan'].filter(Boolean).join(', ')}` : ''}`, cards: (r.cards || []).map(c => c.name) };
    case 'get_card': return { label: `Read ${and((input.names || []).slice(0, 3))}${n(input.names) > 3 ? ' and more' : ''}` };
    case 'get_deck': return { label: 'Looked over your deck' };
    case 'add_cards': return { label: n(r.added) ? `Added ${n(r.added)} card${n(r.added) === 1 ? '' : 's'}${n(r.skipped) ? ` (${n(r.skipped)} couldn’t go in)` : ''}` : 'Couldn’t add those cards', cards: (r.added || []).map(x => x.replace(/^\d+x /, '')), changed: n(r.added) > 0, bad: !n(r.added) };
    case 'remove_cards': return { label: `Took out ${n(r.removed)} card${n(r.removed) === 1 ? '' : 's'}`, cards: (r.removed || []).map(x => x.replace(/^\d+x /, '')), changed: n(r.removed) > 0 };
    case 'auto_build': return { label: `${input.mode === 'rebuild' ? 'Rebuilt' : 'Filled'} the deck: ${n(r.added_spells)} spells and ${r.added_lands || 0} lands`, cards: r.added_spells || [], changed: true };
    case 'suggest_cuts': return { label: 'Found the cards helping least', cards: (r.cuts || []).map(c => c.name) };
    case 'fill_basic_lands': return { label: `Added basic lands${r.added ? `: ${Object.entries(r.added).map(([l, k]) => `${k} ${l}`).join(', ')}` : ''}`, changed: !!(r.added && Object.keys(r.added).length) };
    default: return { label: name };
  }
}
function ToolStep({ step, onOpen }) {
  const [open, setOpen] = useState(false);
  const cards = step.cards || [];
  return (
    <div className={`hstep ${step.bad ? 'bad' : ''} ${step.changed ? 'changed' : ''}`}>
      <button type="button" className="hstep-line" onClick={() => setOpen(o => !o)} disabled={!cards.length} aria-expanded={open}>
        <span className="hstep-dot" aria-hidden="true" />{step.label}{cards.length ? <span className="hstep-more">{open ? 'hide' : `${cards.length} card${cards.length === 1 ? '' : 's'}`}</span> : null}
      </button>
      {open ? <div className="hstep-cards">{cards.slice(0, 60).map((c, i) => <button key={i} type="button" className="cardlink" onClick={() => onOpen(c)}>{c}</button>)}</div> : null}
    </div>
  );
}

export function DeckHelper({ H, index, commanders, cards, setCards, onChooseCommander, onHover, onOpen, byName, hidden, getDeck, onApply }) {
  const [ai, setAi] = useState({ on: null });   // null while checking; then the AI or the built-in helper
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState({ themes: [], tribes: [] });
  const [chat, setChat] = useState(0);          // a new chat greets again
  const threadRef = useRef(null);
  const inputRef = useRef(null);
  const live = useRef({});
  live.current = { commanders, cards, focus };
  const state = () => ({ commanders: live.current.commanders, cards: live.current.cards, focus: live.current.focus });
  const say = m => setMsgs(list => [...list, { from: 'ai', id: Date.now() + Math.random(), ...m }]);
  // the AI conversation as the API sees it, and the turn running now
  const history = useRef([]);
  const work = useRef(null);
  const abort = useRef(null);

  useEffect(() => { let alive = true; aiStatus().then(s => { if (alive) setAi(s); }); return () => { alive = false; }; }, []);
  // the greeting
  useEffect(() => {
    if (ai.on === null || msgs.length) return;
    if (ai.on) say({ parts: [{ kind: 'text', text: commanders.length ? `Hi! I’m your deck helper. You’re building around [[${commanders[0]}]]. Ask me anything: I can finish the deck, explain how it wins, find better cards, or fix what it’s missing. Just type it in your own words.` : 'Hi! I’m your deck helper. Tell me what you like to play, in your own words: a creature type, a play style, colors, a favorite card or even a movie vibe. I’ll find you a commander and build the deck with you, and I can explain anything along the way.' }] });
    else say({ text: 'Hi! I’m your deck helper. Tell me what you like to play: a creature type (dragons, elves, zombies), a style (tokens, graveyard, big creatures, flying) or colors, and I’ll find you a commander. Then I can build the whole deck, or help you build it card by card.', note: ai.why === 'off' ? 'The AI helper isn’t switched on for this site, so this is the simple helper: it understands short requests.' : 'The AI helper can’t be reached from here, so this is the simple helper: it understands short requests.' });
  }, [ai.on, chat]);
  useEffect(() => { const el = threadRef.current; if (el) el.scrollTop = el.scrollHeight; }, [msgs]);

  // a new commander chosen by hand: the simple helper says what its deck is about (the AI hears it in the deck status)
  const cmdKey = commanders.join('|');
  const lastCmd = useRef(cmdKey);
  useEffect(() => {
    const changed = lastCmd.current !== cmdKey;
    lastCmd.current = cmdKey;
    if (!changed || !commanders.length || ai.on !== false) return;
    const { text: plan } = planWords(H, state());
    const total = commanders.length + [...cards.values()].reduce((a, b) => a + b, 0);
    say({ text: `${commanders.join(' & ')} leads ${plan}. ${total >= 100 ? 'Your deck has all 100 cards: ask me to check it, or what to cut.' : total > commanders.length ? `You have ${total} of 100 cards. I can build the rest around what you picked.` : 'Want me to build the whole deck? You can undo it, change any card, or ask me for one kind of card at a time.'}`, acts: total < 100 ? [['Build the rest for me', () => build(false)], ['Suggest cards', () => suggest({})]] : [['Check my deck', review]] });
  }, [cmdKey]);

  // ---- asking the AI
  async function askAI(q) {
    const id = Date.now() + Math.random();
    const update = f => setMsgs(list => list.map(m => (m.id === id ? f(m) : m)));
    setMsgs(list => [...list, { from: 'me', text: q }, { from: 'ai', id, parts: [], streaming: true }]);
    setBusy(true);
    const before = getDeck();
    work.current = { commanders: before.commanders, cards: before.cards };
    const runTool = createAgentTools({ H, index, byName, getDeck: () => work.current, commit: d => { work.current = d; onApply(d); } });
    const ctl = new AbortController();
    abort.current = ctl;
    let changed = false;
    try {
      const r = await ai.runTurn({
        client: ai.client, history: history.current, status: deckStatus(H, byName, work.current), message: q, signal: ctl.signal, runTool,
        on: {
          text: d => update(m => { const parts = m.parts.slice(); const last = parts[parts.length - 1]; if (last && last.kind === 'text') parts[parts.length - 1] = { ...last, text: last.text + d }; else parts.push({ kind: 'text', text: d }); return { ...m, parts }; }),
          tool: (name, input, result) => { const step = toolLine(name, input, result); if (step.changed) changed = true; update(m => ({ ...m, parts: [...m.parts, { kind: 'tool', ...step }] })); },
          step: () => {},
        },
      });
      history.current = r.history;
      update(m => ({ ...m, streaming: false, undo: changed ? before : null, note: r.fresh ? 'This chat got long, so I started a fresh one (I still know your deck).' : r.cut ? 'I stopped there to keep things quick. Ask me to keep going if you want more.' : null }));
    } catch (e) {
      const kind = (e && e.kind) || 'error';   // (an AgentError from deckagent.js)
      const msg = e && e.kind ? e.message : 'Something went wrong. Try again in a moment.';
      update(m => ({ ...m, streaming: false, undo: changed ? before : null, error: kind === 'stopped' ? null : msg, stopped: kind === 'stopped' }));
      if (kind === 'off' || kind === 'offline') setAi({ on: false, why: kind });
    } finally {
      setBusy(false);
      abort.current = null;
      setTimeout(() => inputRef.current && inputRef.current.focus(), 0);
    }
  }
  const newChat = () => { if (abort.current) abort.current.abort(); history.current = []; setMsgs([]); setChat(c => c + 1); };

  // ---- the built-in helper (no AI)
  const addCard = n => setCards(m => { if (m.get(n) && !BASICS.has(n)) return m; const next = new Map(m); next.set(n, (next.get(n) || 0) + 1); return next; });
  const cutCard = n => setCards(m => { const next = new Map(m); const k = (next.get(n) || 0) - 1; if (k > 0) next.set(n, k); else next.delete(n); return next; });
  const undoTo = snap => () => { setCards(snap); say({ text: 'Undone: your deck is back the way it was.' }); };

  function build(fresh, base = null) {
    const st = state();
    if (base) st.cards = base;
    const total = st.commanders.length + [...st.cards.values()].reduce((a, b) => a + b, 0);
    if (!fresh && total >= 100) { say({ text: 'Your deck already has 100 cards. I can check it, or suggest swaps.', acts: [['Check my deck', review], ['What should I cut?', cut]] }); return; }
    const snap = st.cards;
    const r = H.build(st, { fresh, seed: (Math.random() * 2 ** 31) >>> 0 });
    setCards(r.cards);
    const nonland = r.added.filter(n => H.feats.get(n).c.main !== 'Land');
    const lands = r.added.length - nonland.length;
    const roleCount = {};
    for (const n of nonland) for (const ro of H.feats.get(n).roles) roleCount[ro] = (roleCount[ro] || 0) + 1;
    const creatures = nonland.filter(n => H.feats.get(n).c.main === 'Creature').length;
    const bits = ['ramp', 'draw', 'removal', 'wipe', 'counter'].filter(ro => roleCount[ro]).map(ro => `${roleCount[ro]} ${ROLES[ro].toLowerCase()}`);
    const highlights = H.suggest(fresh ? { ...st, cards: new Map() } : st, { limit: 300 }).filter(c => nonland.includes(c.name)).slice(0, 6)
      .map(c => ({ ...c, why: c.why.map(w => w.replace(/: you have \d+, aim for about \d+$/, '')) }));
    say({
      text: `${fresh ? 'Rebuilt from scratch' : 'Done'}: I added ${r.added.length} cards. ${nonland.length ? `${nonland.length} spells (${creatures} creatures; ${and(bits)})` : ''}${nonland.length && lands ? ' and ' : ''}${lands ? `${lands} lands` : ''}. Some picks and why:`,
      cards: highlights, acts: [['Undo', undoTo(snap)], ['Build again (different picks)', () => build(fresh, snap)], ['Check my deck', review]],
    });
  }
  function review() {
    const r = H.review(state());
    const acts = { build: ['Build the rest for me', () => build(false)], cut: ['What should I cut?', cut], cheaper: ['Make it cheaper', cheaper], plan: ['Cards for the plan', () => suggest({})] };
    say({
      text: 'Here’s my read of the deck:',
      notes: r.notes.map(n => ({ ...n, act: !n.act ? null : n.act.kind === 'role' ? [n.act.role === 'land' ? 'Show lands' : `Show ${ROLES[n.act.role].toLowerCase()}`, () => suggest({ role: n.act.role })] : n.act.kind === 'type' ? ['Show creatures', () => suggest({ type: 'Creature' })] : acts[n.act.kind] })),
    });
  }
  function cut() {
    const st = state();
    const list = H.cuts(st, 8);
    if (!list.length) { say({ text: 'There’s nothing to cut yet: your deck has no spells.' }); return; }
    const total = st.commanders.length + [...st.cards.values()].reduce((a, b) => a + b, 0);
    say({ text: `${total > 100 ? `You’re ${total - 100} over 100. ` : ''}These help your deck the least:`, cards: list, cut: true });
  }
  function cheaper() {
    const st = state();
    const out = H.cuts(st, 5, { overCmc: 5 });
    const cheap = H.suggest(st, { maxCmc: 3, limit: 8 });
    if (!out.length) { say({ text: 'Nothing in your deck costs 6 or more, so the curve is already in good shape. Here are cheap cards that fit anyway:', cards: cheap }); return; }
    const snap = st.cards;
    const swap = () => {
      const next = new Map(live.current.cards);
      out.forEach(c => { const k = (next.get(c.name) || 0) - 1; if (k > 0) next.set(c.name, k); else next.delete(c.name); });
      cheap.filter(c => !next.get(c.name)).slice(0, out.length).forEach(c => next.set(c.name, 1));
      setCards(next);
      say({ text: `Swapped ${out.length} expensive cards for cheaper ones.`, acts: [['Undo', undoTo(snap)]] });
    };
    say({ text: 'The most expensive cards doing the least:', cards: out, cut: true });
    say({ text: 'Cheaper cards (3 mana or less) that fit:', cards: cheap, acts: [[`Swap ${out.length} for ${out.length} cheaper cards`, swap]] });
  }
  function suggest(o) {
    const st = state();
    const list = H.suggest(st, { limit: 10, ...o });
    const what = o.role ? (o.role === 'land' ? 'lands' : ROLES[o.role].toLowerCase()) : o.theme ? `cards for ${THEME_NAMES[o.theme]}` : o.tribe ? pluralType(o.tribe) : o.type ? 'creatures' : o.query ? `cards matching “${o.query}”` : 'cards';
    if (!list.length) { say({ text: `I couldn’t find more ${what} in your commander’s colors.` }); return; }
    say({ text: `The best ${what} for this deck:`, cards: list, acts: [[`Add all ${list.length}`, () => { const snap = live.current.cards; setCards(m => { const next = new Map(m); for (const c of list) if (!next.get(c.name)) next.set(c.name, 1); return next; }); say({ text: `Added ${list.length} cards.`, acts: [['Undo', undoTo(snap)]] }); }]] });
  }
  function commandersFor(a) {
    const list = H.findCommanders({ themes: a.themes, tribes: a.tribes, colors: a.colors, limit: 6 });
    const what = [...a.tribes.map(pluralType), ...a.themes.map(th => THEME_NAMES[th])];
    const colors = a.colors ? (a.colors.length ? a.colors.map(c => COLOR_NAMES[c]).join('-') : 'colorless') : '';
    if (a.themes.length || a.tribes.length) setFocus({ themes: a.themes, tribes: a.tribes });
    say(list.length
      ? { text: `Commanders for ${what.length ? and(what) : 'you'}${colors ? ` in ${colors}` : ''}. Pick one and I’ll take it from there${what.length ? `, leaning the deck toward ${and(what)}` : ''}:`, commanders: list }
      : { text: 'I couldn’t find a commander for that. Try a creature type (dragons, elves, angels), a style (tokens, graveyard, lifegain) or a color.' });
  }
  function surprise() {
    const list = H.findCommanders({ limit: 40 });
    const pick = list[Math.floor(Math.random() * list.length)];
    say({ text: `How about ${pick.name}?`, commanders: [pick] });
  }
  function builtin(q) {
    setMsgs(list => [...list, { from: 'me', text: q }]);
    const a = parseAsk(q, H.typeWords);
    const st = state();
    if (!st.commanders.length || a.intent === 'commander') {
      if (a.intent === 'surprise') return surprise();
      if (a.themes.length || a.tribes.length || a.colors) return commandersFor(a);
      if (a.intent === 'commander') return say({ text: 'Tell me what you like (a creature type, a style or colors) and I’ll find commanders for it.' });
      return say({ text: 'First, a commander: it decides your colors and your plan. Tell me what you like, like “dragons”, “elves”, “tokens”, “graveyard” or “red and green”, or say “surprise me”. You can also browse the Commanders tab.' });
    }
    // a theme or creature type you ask about steers the next builds and suggestions too
    if (a.themes.length || a.tribes.length) setFocus(f => ({ themes: [...new Set([...f.themes, ...a.themes])], tribes: [...new Set([...f.tribes, ...a.tribes])] }));
    switch (a.intent) {
      case 'build': return build(false);
      case 'rebuild': return build(true);
      case 'review': return review();
      case 'cut': return cut();
      case 'cheaper': return cheaper();
      case 'surprise': return suggest({});
      case 'help': return say({ text: 'I can build the rest of your deck, check it, suggest cards for one job (ramp, card draw, removal, board wipes, lands), find cards for a plan (tokens, graveyard, flying, …) or a creature type, tell you what to cut, and make it cheaper. Just ask in your own words.' });
      case 'plan': { const { text: plan } = planWords(H, st); return say({ text: `${st.commanders.join(' & ')} leads ${plan}. Fill the deck with cards for that plan, about 10 ramp, 10 card draw, 8 removal and a couple of board wipes, and around 37 lands.`, acts: [['Cards for the plan', () => suggest({})]] }); }
      default:
        if (a.roles.length) return suggest({ role: a.roles[0] });
        if (a.tribes.length) return suggest({ tribe: a.tribes[0] });
        if (a.themes.length) return suggest({ theme: a.themes[0] });
        if (a.type) return suggest({ type: a.type });
        if (a.intent === 'suggest') return suggest({});
        {
          // last try: cards whose name or rules text has the words
          const word = q.toLowerCase().split(/\s+/).filter(w => w.length > 3).sort((x, y) => y.length - x.length)[0];
          if (word && H.suggest(st, { query: word, limit: 1 }).length) return suggest({ query: word });
        }
        return say({ text: 'I’m not sure what you mean. Try “build the rest for me”, “what does my deck need?”, “more card draw”, “tokens” or “what should I cut?”.' });
    }
  }

  function respond(raw) {
    const q = raw.trim();
    if (!q || busy) return;
    setText('');
    if (ai.on) askAI(q.slice(0, 2000)); else builtin(q);
  }

  const chips = ai.on ? (commanders.length ? AI_DECK_CHIPS : AI_START_CHIPS) : commanders.length ? DECK_CHIPS : START_CHIPS;
  return (
    <div className="helper" hidden={hidden}>
      <div className="helper-head">
        {ai.on ? <span className="aimode on">{SPARK}Ask in your own words</span> : <span className={`aimode ${ai.on === false ? 'off' : ''}`}>{ai.on === false ? 'Simple helper' : 'Connecting…'}</span>}
        {!ai.on && (focus.themes.length || focus.tribes.length) ? (
          <span className="helper-focus"><span className="label">Leaning toward</span>
            {focus.tribes.map(ty => <button key={ty} className="chip" onClick={() => setFocus(f => ({ ...f, tribes: f.tribes.filter(x => x !== ty) }))} title="Stop leaning this way">{pluralType(ty)} ×</button>)}
            {focus.themes.map(th => <button key={th} className="chip" onClick={() => setFocus(f => ({ ...f, themes: f.themes.filter(x => x !== th) }))} title="Stop leaning this way">{THEME_NAMES[th]} ×</button>)}
          </span>
        ) : null}
        <span className="spacer" />
        {ai.on && msgs.length > 1 ? <button className="btn sm ghost" onClick={newChat} disabled={busy}>New chat</button> : null}
      </div>
      <div className="helper-thread" ref={threadRef} aria-live="polite">
        {msgs.map((m, i) => (
          <div key={m.id || i} className={`hmsg ${m.from} ${m.streaming ? 'streaming' : ''}`}>
            {m.from === 'ai' ? <span className="hbot" aria-hidden="true">{SPARK}</span> : null}
            <div className="hbody">
              {m.parts ? m.parts.map((p, j) => (p.kind === 'text' ? <div key={j} className="htext"><RichText text={p.text} onOpen={onOpen} byName={byName} /></div> : <ToolStep key={j} step={p} onOpen={onOpen} />)) : null}
              {m.streaming && !(m.parts && m.parts.length && m.parts[m.parts.length - 1].kind === 'text') ? <div className="htyping" aria-label="Thinking"><i /><i /><i /></div> : null}
              {m.error ? <p className="herr">{m.error}</p> : null}
              {m.stopped ? <p className="hnote">Stopped.</p> : null}
              {m.text ? <p>{m.text}</p> : null}
              {m.note ? <p className="hnote">{m.note}</p> : null}
              {m.notes ? <ul className="hnotes">{m.notes.map((n, k) => <li key={k} className={n.level}><span>{n.text}</span>{n.act ? <button className="btn sm" onClick={n.act[1]}>{n.act[0]}</button> : null}</li>)}</ul> : null}
              {m.commanders ? <div className="hcards">{m.commanders.map(c => (
                <div key={c.name} className="hcard" onMouseEnter={() => onHover(c.name)} onFocus={() => onHover(c.name)}>
                  <button type="button" className="bname as-btn" onClick={() => onOpen && onOpen(c.name)}><b>{c.name}</b><small>{c.why.join(' · ') || (byName.get(c.name) || {}).type}</small></button>
                  <Cost cost={(byName.get(c.name) || { cost: [] }).cost} />
                  <button className="btn sm primary" disabled={commanders.includes(c.name)} onClick={() => onChooseCommander(c.name)}>{commanders.includes(c.name) ? 'Chosen' : 'Choose'}</button>
                </div>
              ))}</div> : null}
              {m.cards ? <div className="hcards">{m.cards.map(c => {
                const have = cards.get(c.name) || 0;
                return (
                  <div key={c.name} className={`hcard ${have && !m.cut ? 'in' : ''}`} onMouseEnter={() => onHover(c.name)} onFocus={() => onHover(c.name)}>
                    <button type="button" className="bname as-btn" onClick={() => onOpen && onOpen(c.name)}><b>{c.name}</b>{c.why && c.why.length ? <small>{c.why.join(' · ')}</small> : null}</button>
                    <Cost cost={(byName.get(c.name) || { cost: [] }).cost} />
                    {m.cut
                      ? <button className="btn sm ghost" disabled={!have} onClick={() => cutCard(c.name)}>{have ? 'Cut' : 'Cut ✓'}</button>
                      : <button className="btn sm" disabled={!!have} onClick={() => addCard(c.name)}>{have ? 'In deck' : '+ Add'}</button>}
                  </div>
                );
              })}</div> : null}
              {m.acts ? <div className="hacts">{m.acts.map(([label, fn]) => <button key={label} className={`btn sm ${label === 'Undo' ? 'ghost' : ''}`} onClick={fn}>{label}</button>)}</div> : null}
              {m.undo && !m.streaming ? <div className="hacts"><button className="btn sm ghost" onClick={() => { onApply(m.undo); setMsgs(list => list.map(x => (x.id === m.id ? { ...x, undo: null, note: 'Undone: your deck is back the way it was before this answer.' } : x))); }}>Undo these changes</button></div> : null}
            </div>
          </div>
        ))}
      </div>
      {!busy ? <div className="helper-chips">{chips.map(c => <button key={c} className="btn sm ghost" onClick={() => respond(c)}>{c}</button>)}</div> : null}
      <form className="helper-ask" onSubmit={e => { e.preventDefault(); respond(text); }}>
        <textarea ref={inputRef} className="input" rows={1} value={text} maxLength={2000} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); respond(text); } }}
          placeholder={ai.on ? (commanders.length ? 'Ask anything: “why is my deck slow?”, “add more dragons”, “swap the weakest cards”…' : 'What do you like? “a zombie army”, “big dinosaurs”, “something sneaky with blue”…') : commanders.length ? 'Ask for anything: “more card draw”, “zombies”, “finish my deck”…' : 'What do you like to play? “dragons”, “tokens”, “black and green”…'} aria-label="Ask the deck helper" />
        {busy ? <button className="btn" type="button" onClick={() => abort.current && abort.current.abort()}>Stop</button> : <button className="btn primary" type="submit" disabled={!text.trim() || ai.on === null}>Ask</button>}
      </form>
    </div>
  );
}
