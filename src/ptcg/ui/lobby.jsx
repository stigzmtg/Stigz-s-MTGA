// Pokémon lobby: pick one of the tournament decks, pick (or randomize) the opponent's, start the battle.
import { Energy } from './energy.jsx';
import { DeckRecord } from '../../ui/replaybar.jsx';
import { pkImage, subscribePk, pkImagesVersion } from './images.js';
import { PkFriendsPanel } from './friends.jsx';

const { useState, useEffect, useSyncExternalStore } = React;

function DeckTile({ deck, cards, selected, onClick }) {
  const img = pkImage(deck.featured);
  const f = cards[deck.featured];
  return (
    <button className={`pk-deck ${selected ? 'sel' : ''}`} onClick={onClick} aria-pressed={selected}>
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
  const deck = data.decks.find(d => d.id === mine);
  const friends = online.mode === 'friends';
  // in a room, the deck picked here is the one you bring
  useEffect(() => {
    try { localStorage.setItem('pk-lobby', JSON.stringify({ mine, opp })); } catch { /* storage unavailable */ }
    online.onDeck(mine);
  }, [mine, online.room]);
  const start = () => {
    try { localStorage.setItem('pk-lobby', JSON.stringify({ mine, opp })); } catch { /* storage unavailable */ }
    const pool = data.decks.filter(d => d.id !== mine);
    const o = opp === 'random' ? pool[Math.floor(Math.random() * pool.length)] : data.decks.find(d => d.id === opp);
    onStart({ mine: deck, opp: o });
  };
  const preview = hover ? pkImage(hover) : pkImage(deck.featured);
  return (
    <div className="app pk">
      <header className="topbar">
        <button className="brand linklike" onClick={onHome} title="Choose a game">Stigz’s TCG Arena</button>
        <span className="chip pk-chip">Pokémon TCG</span>
        <span className="spacer" />
        <button className="btn sm" onClick={onHome}>Switch game</button>
        <button className="btn sm" onClick={onHelp}>How to play</button>
      </header>
      <main className="lobby pk-lobby">
        <section className="intro">
          <h1>Pick a deck, start a battle</h1>
          <p>Eighteen of the most-played decks from top Pokémon TCG tournaments, card for card as their players built them. Battle the computer or a friend, with every attack, Ability and Trainer working by the rules.</p>
        </section>
        <div className="pk-lobby-grid">
          <section className="panel" aria-label="Your deck">
            <h2>Your deck</h2>
            <div className="pk-decks">
              {data.decks.map(d => <DeckTile key={d.id} deck={d} cards={data.cards} selected={d.id === mine} onClick={() => setMine(d.id)} />)}
            </div>
          </section>
          <div className="setup">
            <section className="panel pk-chosen" aria-label="Selected deck">
              <h2>{deck.name}</h2>
              <div className="pk-chosen-body">
                <div className="pk-feature">{preview ? <img src={preview} alt={hover ? data.cards[hover].name : deck.name} /> : null}</div>
                <div>
                  <p className="blurb">{deck.blurb}</p>
                  <p className="credit">List: {deck.list}{deck.player ? `, played by ${deck.player}` : ''}. <a href={deck.source} target="_blank" rel="noopener">Limitless</a></p>
                  <DeckRecord kind="pk" id={deck.id} />
                  <DeckList deck={deck} cards={data.cards} onHover={setHover} />
                </div>
              </div>
            </section>
            <div className="seg modeswitch" role="tablist" aria-label="Game mode">
              <button role="tab" aria-selected={!friends} className={!friends ? 'on' : ''} onClick={() => online.setMode('solo')}>Vs the computer</button>
              <button role="tab" aria-selected={friends} className={friends ? 'on' : ''} onClick={() => online.setMode('friends')}>Play with friends</button>
            </div>
            {friends ? <PkFriendsPanel data={data} online={online} deck={deck} /> : (
              <section className="panel" aria-label="Opponent">
                <h2>Opponent</h2>
                <label className="label" htmlFor="pk-opp">Computer's deck</label>
                <select id="pk-opp" className="input" value={opp} onChange={e => setOpp(e.target.value)}>
                  <option value="random">Random deck</option>
                  {data.decks.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
                <button className="btn primary big" onClick={start}>Battle!</button>
              </section>
            )}
          </div>
        </div>
        <p className="foot">Unofficial fan project. Pokémon and the Pokémon TCG are trademarks of Nintendo, Creatures and GAME FREAK. Card data from TCGdex, decklists from Limitless.</p>
      </main>
    </div>
  );
}
