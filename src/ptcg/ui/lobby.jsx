// Pokémon lobby: pick one of the tournament decks, pick (or randomize) the opponent's, start the battle.
import { Energy } from './energy.jsx';

const TYPE_ORDER = ['Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal', 'Dragon', 'Colorless'];
import { DeckRecord } from '../../ui/replaybar.jsx';
import { SizeButton } from '../../ui/dialogs.jsx';
import { DeckStyleButton, subscribeDeckStyles, deckStylesVersion } from '../../ui/deckstyle.jsx';
import { pkImage, subscribePk, pkImagesVersion } from './images.js';
import { PkFriendsPanel } from './friends.jsx';

const { useState, useEffect, useSyncExternalStore } = React;

function DeckTile({ deck, cards, selected, onClick, i = 0 }) {
  const img = pkImage(deck.featured);
  const f = cards[deck.featured];
  return (
    <button className={`pk-deck ${selected ? 'sel' : ''}`} onClick={onClick} aria-pressed={selected} style={{ '--i': Math.min(i, 30) }}>
      <span className="art" style={{ '--t': `var(--pk-${(f && f.type || 'Colorless').toLowerCase()})` }}>
        {img ? <img src={img} alt="" draggable="false" /> : <span className="ph">{deck.name}</span>}
      </span>
      <span className="meta">
        <span className="nm">{deck.name}</span>
        <span className="en">{deck.energy.map(t => <Energy key={t} type={t} size={16} />)}</span>
      </span>
    </button>
  );
}

function DeckList({ deck, cards, onHover }) {
  const groups = { P: [], T: [], E: [] };
  for (const [k, n] of deck.cards) { const c = cards[k]; if (c) groups[c.cat].push([c, n]); }
  const total = list => list.reduce((s, [, n]) => s + n, 0);
  return (
    <div className="pk-list">
      {[['P', 'Pokémon'], ['T', 'Trainers'], ['E', 'Energy']].map(([k, label]) => (
        <div key={k} className="grp">
          <div className="label">{label} · {total(groups[k])}</div>
          {groups[k].map(([c, n]) => (
            <div key={c.key} className="pk-row" onMouseEnter={() => onHover(c.key)} onMouseLeave={() => onHover(null)}>
              <b>{n}</b> <span>{c.name}</span>{c.cat === 'P' && c.stage !== 'Basic' ? <span className="st">{c.stage === 'Stage1' ? 'Stage 1' : 'Stage 2'}</span> : null}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function PkLobby({ data, online, onStart, onHome, onHelp }) {
  useSyncExternalStore(subscribePk, pkImagesVersion);
  const saved = (() => { try { return JSON.parse(localStorage.getItem('pk-lobby') || '{}'); } catch { return {}; } })();
  const [mine, setMine] = useState(data.decks.some(d => d.id === saved.mine) ? saved.mine : data.decks[0].id);
  const [opp, setOpp] = useState(saved.opp || 'random');
  const [hover, setHover] = useState(null);
  const [q, setQ] = useState('');
  const [type, setType] = useState('all');
  const deck = data.decks.find(d => d.id === mine);
  // a deck's attacking types (decks.json `types`, else its featured Pokémon's type)
  const typesOf = d => d.types || [(data.cards[d.featured] || {}).type].filter(Boolean);
  const allTypes = TYPE_ORDER.filter(t => data.decks.some(d => typesOf(d).includes(t)));
  const qq = q.trim().toLowerCase();
  const shown = data.decks.filter(d => (type === 'all' || typesOf(d).includes(type)) && (!qq || d.name.toLowerCase().includes(qq) || (d.list || '').toLowerCase().includes(qq) || d.cards.some(([k]) => ((data.cards[k] || {}).name || '').toLowerCase().includes(qq))));
  const friends = online.mode === 'friends';
  // in a room, the deck picked here is the one you bring (with its sleeves and box)
  const styles = useSyncExternalStore(subscribeDeckStyles, deckStylesVersion);
  useEffect(() => {
    try { localStorage.setItem('pk-lobby', JSON.stringify({ mine, opp })); } catch { /* storage unavailable */ }
    online.onDeck(mine);
  }, [mine, online.room, styles]);
  const start = () => {
    try { localStorage.setItem('pk-lobby', JSON.stringify({ mine, opp })); } catch { /* storage unavailable */ }
    const pool = data.decks.filter(d => d.id !== mine);
    const o = opp === 'random' ? pool[Math.floor(Math.random() * pool.length)] : data.decks.find(d => d.id === opp);
    onStart({ mine: deck, opp: o });
  };
  const preview = hover ? pkImage(hover) : pkImage(deck.featured);
  // how you'll play, and the button to start: first in the column, so it's always on screen
  const modeAndStart = <>
    <div className="seg modeswitch" role="tablist" aria-label="Game mode">
      <button role="tab" aria-selected={!friends} className={!friends ? 'on' : ''} onClick={() => online.setMode('solo')}>Vs the computer</button>
      <button role="tab" aria-selected={friends} className={friends ? 'on' : ''} onClick={() => online.setMode('friends')}>Play with friends</button>
    </div>
    {friends ? <PkFriendsPanel data={data} online={online} deck={deck} /> : (
      <section className="panel pk-start" aria-label="Opponent">
        <div className="pk-start-row">
          <div className="pk-start-opp">
            <label className="label" htmlFor="pk-opp">Computer's deck</label>
            <select id="pk-opp" className="input" value={opp} onChange={e => setOpp(e.target.value)}>
              <option value="random">Random deck</option>
              {data.decks.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <button className="btn primary big" onClick={start}>Battle!</button>
        </div>
        <p className="note">You play <b>{deck.name}</b>.</p>
      </section>
    )}
  </>;
  return (
    <div className="app pk">
      <header className="topbar">
        <button className="brand linklike" onClick={onHome} title="Choose a game">Cardforge</button>
        <span className="chip pk-chip">Pokémon TCG</span>
        <span className="spacer" />
        <button className="btn sm" onClick={onHome}>Switch game</button>
        <SizeButton />
        <button className="btn sm" onClick={onHelp}>How to play</button>
      </header>
      <main className="lobby pk-lobby">
        <section className="intro" data-eyebrow="Pokémon TCG · Tournament decks">
          <h1>Pick a deck, start a battle</h1>
          <p>{data.decks.length} of the most-played decks from top Pokémon TCG tournaments, card for card as their players built them. Battle the computer or a friend, with every attack, Ability and Trainer working by the rules.</p>
        </section>
        <div className="pk-lobby-grid">
          <section className="panel" aria-label="Your deck">
            <div className="panel-head"><h2>Your deck</h2><span className="note">{shown.length === data.decks.length ? `${data.decks.length} decks` : `${shown.length} of ${data.decks.length} decks`}</span></div>
            <div className="pk-deckfilter">
              <input className="input search" placeholder="Search decks or cards" value={q} onChange={e => setQ(e.target.value)} aria-label="Search decks" />
              <div className="pk-types" role="group" aria-label="Filter by type">
                <button className={type === 'all' ? 'on' : ''} aria-pressed={type === 'all'} onClick={() => setType('all')}>All</button>
                {allTypes.map(t => <button key={t} className={type === t ? 'on' : ''} aria-pressed={type === t} onClick={() => setType(type === t ? 'all' : t)} title={`${t} decks`}><Energy type={t} size={18} /><span>{t}</span></button>)}
              </div>
            </div>
            <div className="pk-decks">
              {shown.map((d, i) => <DeckTile key={d.id} i={i} deck={d} cards={data.cards} selected={d.id === mine} onClick={() => setMine(d.id)} />)}
              {!shown.length ? <div className="empty">No deck matches.</div> : null}
            </div>
          </section>
          <div className="setup">
            {modeAndStart}
            <section className="panel pk-chosen" aria-label="Selected deck">
              <h2>{deck.name}</h2>
              <div className="pk-chosen-body">
                <div className="pk-feature">{preview ? <img src={preview} alt={hover ? data.cards[hover].name : deck.name} /> : null}</div>
                <div>
                  <DeckStyleButton kind="pk" deck={deck} colors={deck.energy} />
                  <p className="blurb">{deck.blurb}</p>
                  <p className="credit">List: {deck.list}{deck.player ? `, played by ${deck.player}` : ''}. <a href={deck.source} target="_blank" rel="noopener">Limitless</a></p>
                  <DeckRecord kind="pk" id={deck.id} />
                  <DeckList deck={deck} cards={data.cards} onHover={setHover} />
                </div>
              </div>
            </section>
          </div>
        </div>
        <p className="foot">Unofficial fan project. Pokémon and the Pokémon TCG are trademarks of Nintendo, Creatures and GAME FREAK. Card data from TCGdex, decklists from Limitless.</p>
      </main>
    </div>
  );
}
