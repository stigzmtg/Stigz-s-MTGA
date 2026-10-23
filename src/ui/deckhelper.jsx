// The AI deck helper in the deck builder: a chat where you say what you want ("dragons", "build the rest for me",
// "more removal", "what should I cut?") and it answers with commanders, cards and whole builds you can add or undo.
// The thinking is in deckai.js; this file is the conversation.
import { parseAsk, ROLES, THEME_NAMES, COLOR_NAMES } from './deckai.js';
import { Cost } from './builder.jsx';
import { BASICS } from './customdecks.js';

const { useState, useEffect, useRef } = React;

const and = list => (list.length <= 1 ? list.join('') : list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1]);
const pluralType = ty => (ty === 'Elf' ? 'Elves' : ty === 'Dwarf' ? 'Dwarves' : ty === 'Wolf' ? 'Wolves' : /y$/.test(ty) ? ty.slice(0, -1) + 'ies' : /(?:s|x|ch|sh)$/.test(ty) ? ty + 'es' : ty + 's');
const START_CHIPS = ['Dragons', 'Elves', 'Zombies', 'Tokens', 'Graveyard', 'Big creatures', 'Surprise me'];
const DECK_CHIPS = ['Build the rest for me', 'What does my deck need?', 'Suggest cards', 'What should I cut?', 'Make it cheaper', 'More removal'];

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

export function DeckHelper({ H, commanders, cards, setCards, onChooseCommander, onHover, byName, hidden }) {
  const [msgs, setMsgs] = useState(() => (commanders.length ? [] : [{ from: 'ai', text: 'Hi! I’m your deck helper. Tell me what you like to play: a creature type (dragons, elves, zombies), a style (tokens, graveyard, big creatures, flying) or colors, and I’ll find you a commander. Then I can build the whole deck, or help you build it card by card.' }]));
  const [text, setText] = useState('');
  const [focus, setFocus] = useState({ themes: [], tribes: [] });
  const threadRef = useRef(null);
  const live = useRef({});
  live.current = { commanders, cards, focus };
  const state = () => ({ commanders: live.current.commanders, cards: live.current.cards, focus: live.current.focus });
  const say = m => setMsgs(list => [...list, { from: 'ai', ...m }]);

  useEffect(() => { const el = threadRef.current; if (el) el.scrollTop = el.scrollHeight; }, [msgs]);

  // a new commander: say what its deck is about and offer to build it
  const cmdKey = commanders.join('|');
  useEffect(() => {
    if (!commanders.length) return;
    const { text: plan } = planWords(H, state());
    const total = commanders.length + [...cards.values()].reduce((a, b) => a + b, 0);
    say({ text: `${commanders.join(' & ')} leads ${plan}. ${total >= 100 ? 'Your deck has all 100 cards: ask me to check it, or what to cut.' : total > commanders.length ? `You have ${total} of 100 cards. I can build the rest around what you picked.` : 'Want me to build the whole deck? You can undo it, change any card, or ask me for one kind of card at a time.'}`, acts: total < 100 ? [['Build the rest for me', () => build(false)], ['Suggest cards', () => suggest({})]] : [['Check my deck', review]] });
  }, [cmdKey]);

  const addCard = n => setCards(m => { if (m.get(n) && !BASICS.has(n)) return m; const next = new Map(m); next.set(n, (next.get(n) || 0) + 1); return next; });
  const cutCard = n => setCards(m => { const next = new Map(m); const k = (next.get(n) || 0) - 1; if (k > 0) next.set(n, k); else next.delete(n); return next; });
  const undoTo = snap => () => { setCards(snap); say({ text: 'Undone: your deck is back the way it was.' }); };

  // base: build from these cards instead of the deck as it is (for "build again")
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
      : { text: `I couldn’t find a commander for that. Try a creature type (dragons, elves, angels), a style (tokens, graveyard, lifegain) or a color.` });
  }

  function surprise() {
    const list = H.findCommanders({ limit: 40 });
    const pick = list[Math.floor(Math.random() * list.length)];
    say({ text: `How about ${pick.name}?`, commanders: [pick] });
  }

  function respond(raw) {
    const q = raw.trim();
    if (!q) return;
    setMsgs(list => [...list, { from: 'me', text: q }]);
    setText('');
    const a = parseAsk(q, H.typeWords);
    const st = state();
    if (!st.commanders.length || a.intent === 'commander') {
      if (a.intent === 'surprise') return surprise();
      if (a.themes.length || a.tribes.length || a.colors) return commandersFor(a);
      if (a.intent === 'commander') return say({ text: 'Tell me what you like (a creature type, a style or colors) and I’ll find commanders for it.' });
      return say({ text: 'First, a commander: it decides your colors and your plan. Tell me what you like, like “dragons”, “elves”, “tokens”, “graveyard” or “red and green”, or say “surprise me”. You can also search on the Search tab.' });
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

  const chips = commanders.length ? DECK_CHIPS : START_CHIPS;
  return (
    <div className="helper" hidden={hidden}>
      {focus.themes.length || focus.tribes.length ? (
        <div className="helper-focus"><span className="label">Leaning toward</span>
          {focus.tribes.map(ty => <button key={ty} className="chip" onClick={() => setFocus(f => ({ ...f, tribes: f.tribes.filter(x => x !== ty) }))} title="Stop leaning this way">{pluralType(ty)} ×</button>)}
          {focus.themes.map(th => <button key={th} className="chip" onClick={() => setFocus(f => ({ ...f, themes: f.themes.filter(x => x !== th) }))} title="Stop leaning this way">{THEME_NAMES[th]} ×</button>)}
        </div>
      ) : null}
      <div className="helper-thread" ref={threadRef} aria-live="polite">
        {msgs.map((m, i) => (
          <div key={i} className={`hmsg ${m.from}`}>
            {m.from === 'ai' ? <span className="hbot" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 2l1.8 4.6L18.5 8l-4.7 1.5L12 14l-1.8-4.5L5.5 8l4.7-1.4z" /><path d="M18.5 13l.9 2.3 2.3.8-2.3.8-.9 2.3-.9-2.3-2.3-.8 2.3-.8z" /><path d="M6 15l.7 1.8 1.8.7-1.8.6L6 20l-.7-1.9-1.8-.6 1.8-.7z" /></svg></span> : null}
            <div className="hbody">
              {m.text ? <p>{m.text}</p> : null}
              {m.notes ? <ul className="hnotes">{m.notes.map((n, k) => <li key={k} className={n.level}><span>{n.text}</span>{n.act ? <button className="btn sm" onClick={n.act[1]}>{n.act[0]}</button> : null}</li>)}</ul> : null}
              {m.commanders ? <div className="hcards">{m.commanders.map(c => (
                <div key={c.name} className="hcard" onMouseEnter={() => onHover(c.name)} onFocus={() => onHover(c.name)}>
                  <span className="bname"><b>{c.name}</b><small>{c.why.join(' · ') || (byName.get(c.name) || {}).type}</small></span>
                  <Cost cost={(byName.get(c.name) || { cost: [] }).cost} />
                  <button className="btn sm primary" disabled={commanders.includes(c.name)} onClick={() => onChooseCommander(c.name)}>{commanders.includes(c.name) ? 'Chosen' : 'Choose'}</button>
                </div>
              ))}</div> : null}
              {m.cards ? <div className="hcards">{m.cards.map(c => {
                const have = cards.get(c.name) || 0;
                return (
                  <div key={c.name} className={`hcard ${have && !m.cut ? 'in' : ''}`} onMouseEnter={() => onHover(c.name)} onFocus={() => onHover(c.name)}>
                    <span className="bname"><b>{c.name}</b>{c.why && c.why.length ? <small>{c.why.join(' · ')}</small> : null}</span>
                    <Cost cost={(byName.get(c.name) || { cost: [] }).cost} />
                    {m.cut
                      ? <button className="btn sm ghost" disabled={!have} onClick={() => cutCard(c.name)}>{have ? 'Cut' : 'Cut ✓'}</button>
                      : <button className="btn sm" disabled={!!have} onClick={() => addCard(c.name)}>{have ? 'In deck' : '+ Add'}</button>}
                  </div>
                );
              })}</div> : null}
              {m.acts ? <div className="hacts">{m.acts.map(([label, fn]) => <button key={label} className={`btn sm ${label === 'Undo' ? 'ghost' : ''}`} onClick={fn}>{label}</button>)}</div> : null}
            </div>
          </div>
        ))}
      </div>
      <div className="helper-chips">{chips.map(c => <button key={c} className="btn sm ghost" onClick={() => respond(c)}>{c}</button>)}</div>
      <form className="helper-ask" onSubmit={e => { e.preventDefault(); respond(text); }}>
        <input className="input" value={text} onChange={e => setText(e.target.value)} placeholder={commanders.length ? 'Ask for anything: “more card draw”, “zombies”, “finish my deck”…' : 'What do you like to play? “dragons”, “tokens”, “black and green”…'} aria-label="Ask the deck helper" />
        <button className="btn primary" type="submit" disabled={!text.trim()}>Ask</button>
      </form>
    </div>
  );
}
