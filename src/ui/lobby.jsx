// Deck selection: pick your precon and your AI opponents.
import { CardFace, viewOfDef, Pip } from './cardview.jsx';
import { DeckRecord } from './replaybar.jsx';
import { HelpDialog, SizeButton } from './dialogs.jsx';
import { FriendsPanel } from './online.jsx';
import { lobbyImages, subscribeImages, imagesVersion, cardImage } from './images.js';
import { DeckStyleButton, subscribeDeckStyles, deckStylesVersion } from './deckstyle.jsx';
import { identityStyle } from './board.jsx';

const { useState, useMemo, useEffect, useSyncExternalStore } = React;

function storageGet(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }
function storageSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } }

export function deckIdentity(db, deck) {
  const s = new Set();
  for (const n of deck.commanders) { const d = db.get(n); if (d) for (const c of d.colorIdentity()) s.add(c); }
  return ['W', 'U', 'B', 'R', 'G'].filter(c => s.has(c));
}

function Identity({ colors }) {
  if (!colors.length) return <span className="mana"><Pip s="C" /></span>;
  return <span className="mana">{colors.map(c => <Pip key={c} s={c} />)}</span>;
}

const NO_SYMBOL = new Set(['frc']);
function SetMark({ set, name }) {
  if (set === 'YOU') return <span className="mine-mark" title="Your deck" aria-label="Your deck">★</span>;
  const code = set.toLowerCase();
  if (NO_SYMBOL.has(code)) return <span className="setcode" title={name}>{set}</span>;
  return <i className={`ss ss-${code} setsym`} title={`${name} (${set})`} aria-label={name} />;
}

// the commander's art, cropped, in front of each deck's name (its colors until the pictures load)
function DeckArt({ deck, imagesOk }) {
  const img = imagesOk ? (deck.custom ? cardImage(deck.commanders[0]) : lobbyImages(deck.id)[0]) : null;
  return <span className={`art ${img ? 'img' : ''}`} style={img ? { backgroundImage: `url(${img})` } : undefined} aria-hidden="true" />;
}

function deckStats(db, deck, support) {
  const counts = { Creature: 0, Instant: 0, Sorcery: 0, Artifact: 0, Enchantment: 0, Planeswalker: 0, Land: 0 };
  let total = 0, flagged = 0, mv = 0, nonland = 0;
  for (const [n, k] of deck.cards) {
    const d = db.get(n);
    if (!d) continue;
    total += k;
    if (support[n]) flagged += k;
    const f = d.faces[0];
    const t = ['Creature', 'Land', 'Planeswalker', 'Instant', 'Sorcery', 'Artifact', 'Enchantment'].find(x => f.types.includes(x));
    if (t) counts[t] += k;
    if (!f.types.includes('Land')) { mv += f.cmc * k; nonland += k; }
  }
  return { counts, total, coverage: total ? Math.round(100 * (total - flagged) / total) : 100, avgMV: nonland ? (mv / nonland).toFixed(2) : '0' };
}

export function Lobby({ data, onStart, imagesOk, online, onHome, onBuild }) {
  const { db, decks, support } = data;
  useSyncExternalStore(subscribeImages, imagesVersion);
  const saved = storageGet('pa-lobby', {});
  const [q, setQ] = useState('');
  const [colors, setColors] = useState([]);
  const [mine, setMine] = useState(saved.mine && decks.find(d => d.id === saved.mine) ? saved.mine : decks[0].id);
  const [numOpp, setNumOpp] = useState(saved.numOpp || 1);
  const [opps, setOpps] = useState(saved.opps || ['random', 'random', 'random']);
  const [help, setHelp] = useState(false);
  const identities = useMemo(() => Object.fromEntries(decks.map(d => [d.id, deckIdentity(db, d)])), [decks]);
  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return decks.filter(d => {
      if (colors.length && !colors.every(c => identities[d.id].includes(c))) return false;
      if (!qq) return true;
      return d.name.toLowerCase().includes(qq) || d.commanders.some(c => c.toLowerCase().includes(qq)) || d.setName.toLowerCase().includes(qq) || d.set.toLowerCase() === qq;
    });
  }, [q, colors, decks]);
  const groups = useMemo(() => {
    const out = [];
    for (const d of filtered) {
      const last = out[out.length - 1];
      if (last && last.set === d.setName) last.decks.push(d); else out.push({ set: d.setName, year: (d.date || '').slice(0, 4), decks: [d] });
    }
    return out;
  }, [filtered]);
  const deck = decks.find(d => d.id === mine) || decks[0];
  const stats = useMemo(() => deckStats(db, deck, support), [deck]);
  const sortedDecks = useMemo(() => decks.slice().sort((a, b) => a.name.localeCompare(b.name)), [decks]);
  useEffect(() => { storageSet('pa-lobby', { mine, numOpp, opps }); }, [mine, numOpp, opps]);
  const styles = useSyncExternalStore(subscribeDeckStyles, deckStylesVersion);
  useEffect(() => { if (online && online.onDeck) online.onDeck(mine); }, [mine, online && online.room, styles]);
  const friends = online && online.mode === 'friends';

  const start = () => {
    const pickRandom = (exclude) => { const pool = decks.filter(d => !d.custom && !exclude.includes(d.id)); return pool[Math.floor(Math.random() * pool.length)]; };
    const chosen = [];
    for (let i = 0; i < numOpp; i++) {
      const id = opps[i];
      chosen.push(id === 'random' ? pickRandom([deck.id, ...chosen.map(x => x.id)]) : decks.find(d => d.id === id));
    }
    onStart({ mine: deck, opps: chosen });
  };

  return (
    <div className="app">
      <header className="topbar">{onHome ? <button className="brand linklike" onClick={onHome} title="Choose a game">Lotus Goats<small>Commander</small></button> : <span className="brand">Lotus Goats<small>Commander vs AI</small></span>}<span className="spacer" /><span className="chip">{decks.length} preconstructed decks</span>{onHome ? <button className="btn sm" onClick={onHome}>Switch game</button> : null}<SizeButton /><button className="btn sm" onClick={() => setHelp(true)}>How to play</button></header>
      {help ? <HelpDialog onClose={() => setHelp(false)} /> : null}
      <div className="lobby">
        <div className="intro" data-eyebrow="Magic: The Gathering · Commander">
          <h1>Pick a precon, take a seat</h1>
          <p>Every Commander precon from Commander 2013 to today, played with full rules automation. Face computer opponents, or open a room and play with friends. Choose your deck and shuffle up.</p>
        </div>
        <section className="panel" aria-label="Your deck">
          <div className="panel-head"><h2>Your deck</h2>{onBuild ? <button className="btn sm" onClick={() => onBuild(null)}>+ Build a deck</button> : null}</div>
          <div className="filters">
            <input id="deck-search" className="input search" placeholder="Search by deck, commander or set" value={q} onChange={e => setQ(e.target.value)} />
            <div className="colorfilter" role="group" aria-label="Filter by color">
              {['W', 'U', 'B', 'R', 'G'].map(c => <button key={c} className={colors.includes(c) ? 'on' : ''} onClick={() => setColors(cs => cs.includes(c) ? cs.filter(x => x !== c) : [...cs, c])} aria-pressed={colors.includes(c)} aria-label={`Filter ${c}`}><Pip s={c} /></button>)}
            </div>
          </div>
          <div className="decklist">
            {groups.map(g => (
              <div key={g.set + g.decks[0].id}>
                <div className="setgroup"><SetMark set={g.decks[0].set} name={g.set} /> {g.set} {g.year ? `· ${g.year}` : ''}</div>
                {g.decks.map(d => (
                  <button key={d.id} className={`deckrow ${d.id === mine ? 'sel' : ''}`} onClick={() => setMine(d.id)} style={identityStyle(identities[d.id] || [])}>
                    <DeckArt deck={d} imagesOk={imagesOk} />
                    <span className="dn">{d.name}</span>
                    <span className="dc">{d.commanders.join(' & ')}</span>
                    <span className="ds"><Identity colors={identities[d.id]} /><SetMark set={d.set} name={d.setName} /></span>
                  </button>
                ))}
              </div>
            ))}
            {!groups.length ? <div className="empty">No decks match.</div> : null}
          </div>
        </section>
        <div className="setup">
          <div className="seg modeswitch" role="tablist" aria-label="Game mode">
            <button role="tab" aria-selected={!friends} className={!friends ? 'on' : ''} onClick={() => online && online.setMode('solo')}>Solo vs AI</button>
            <button role="tab" aria-selected={friends} className={friends ? 'on' : ''} onClick={() => online && online.setMode('friends')}>Play with friends</button>
          </div>
          {friends ? <FriendsPanel data={data} api={online.api} room={online.room} deck={deck} onCreate={online.onCreate} onJoin={online.onJoin} onLeave={online.onLeave} onStart={online.onStart} onWatch={online.onWatch} session={null} /> : (
          <section className="panel" aria-label="Opponents">
            <h2>Opponents</h2>
            <div className="filters"><span className="label">Players</span>
              <div className="seg" role="group" aria-label="Number of opponents">{[1, 2, 3].map(n => <button key={n} className={numOpp === n ? 'on' : ''} onClick={() => setNumOpp(n)}>{n === 1 ? '1 vs 1' : `${n + 1}-player`}</button>)}</div>
            </div>
            <div className="oppslots">
              {Array.from({ length: numOpp }, (_, i) => (
                <div className="oppslot" key={i}>
                  <span className="label">AI {i + 1}</span>
                  <select id={`opp-${i}`} className="input" value={opps[i]} onChange={e => setOpps(o => { const n = o.slice(); n[i] = e.target.value; return n; })}>
                    <option value="random">Random precon</option>
                    {sortedDecks.filter(d => !d.custom).map(d => <option key={d.id} value={d.id}>{d.name} — {d.commanders.join(' & ')}</option>)}
                  </select>
                </div>
              ))}
            </div>
            <div className="dlg-actions" style={{ marginTop: 14 }}>
              <span className="note">You start at 40 life. Commander damage, tax and the command zone are tracked for you.</span>
              <button className="btn primary" onClick={start}>Shuffle up</button>
            </div>
          </section>
          )}
          <section className="panel" aria-label="Selected deck">
            <div className="panel-head"><h2>{deck.name}</h2>{onBuild ? (deck.custom ? <button className="btn sm" onClick={() => onBuild(deck.id)}>Edit this deck</button> : <button className="btn sm" onClick={() => onBuild(null, deck.id)} title="Open a copy of this precon in the deck builder to change it">Edit a copy</button>) : null}</div>
            <div className="commander-showcase bigcard" style={{ '--cw': deck.commanders.length > 1 ? 'calc(190px * var(--s))' : 'calc(250px * var(--s))' }}>
              {(() => {
                const imgs = imagesOk ? (deck.custom ? deck.commanders.map(n => cardImage(n)) : lobbyImages(deck.id)) : [];
                return deck.commanders.map((n, i) => { const d = db.get(n); return d ? <div className="cardwrap" key={n}><CardFace v={{ ...viewOfDef(d), img: imgs[i] || null }} size="big" /></div> : null; });
              })()}
            </div>
            <DeckStyleButton kind="mtg" deck={deck} colors={identities[deck.id] || []} />
            <div className="deckstats" style={{ marginTop: 10 }}>
              <span className="chip">{deck.setName}</span>
              {Object.entries(stats.counts).filter(([, n]) => n).map(([t, n]) => <span key={t} className="chip">{n} {t === 'Sorcery' ? 'Sorceries' : t + 's'}</span>)}
              <span className="chip">Avg MV {stats.avgMV}</span>
            </div>
            <p className="coverage">Rules automation: <b>{stats.coverage}%</b> of cards fully automated.</p>
            <DeckRecord kind="mtg" id={deck.id} />
          </section>
          <p className="fineprint">Unofficial fan project, not affiliated with Wizards of the Coast. Magic: The Gathering and its card names are trademarks of Wizards of the Coast. Card rules come from the open-source <a href="https://github.com/Card-Forge/forge" target="_blank" rel="noopener">Forge</a> project (GPL-3.0); decklists from <a href="https://github.com/taw/magic-preconstructed-decks" target="_blank" rel="noopener">taw/magic-preconstructed-decks</a>; card images from <a href="https://www.tcgplayer.com" target="_blank" rel="noopener">TCGplayer</a> and <a href="https://scryfall.com" target="_blank" rel="noopener">Scryfall</a>; mana and set symbols from Andrew Gioia's <a href="https://github.com/andrewgioia/mana" target="_blank" rel="noopener">Mana</a> and <a href="https://github.com/andrewgioia/keyrune" target="_blank" rel="noopener">Keyrune</a> fonts.</p>
        </div>
      </div>
    </div>
  );
}
