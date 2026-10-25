// One Piece lobby: pick a starter deck, pick (or randomize) the computer's, set sail.
import { DeckRecord } from '../../ui/replaybar.jsx';
import { SizeButton } from '../../ui/dialogs.jsx';
import { DeckStyleButton, subscribeDeckStyles, deckStylesVersion } from '../../ui/deckstyle.jsx';
import { opImage, opThumb, subscribeOp, opImagesVersion } from './images.js';
import { OpFriendsPanel } from './friends.jsx';
import { OP_COLORS, COLOR_HEX, ColorDot } from './colors.jsx';
import { deckById, withLeader, baseDeckId } from './decks.js';
import { EffectText, KwTip } from './glossary.jsx';

const { useState, useEffect, useSyncExternalStore } = React;

function DeckTile({ deck, cards, selected, onClick, i = 0 }) {
  const img = opThumb(deck.featured || deck.leader);
  const lead = cards[deck.leader] || {};
  return (
    <button className={`op-deck ${selected ? 'sel' : ''}`} onClick={onClick} aria-pressed={selected} style={{ '--i': Math.min(i, 30), '--c1': COLOR_HEX[deck.colors[0]], '--c2': COLOR_HEX[deck.colors[1] || deck.colors[0]] }}>
      <span className="art">{img ? <img src={img} alt="" draggable="false" /> : <span className="ph">{lead.name || deck.name}</span>}</span>
      <span className="meta">
        <span className="code">{deck.code}</span>
        <span className="nm">{deck.name}</span>
        <span className="cl"><ColorDot colors={deck.colors} size={13} /><span>{deck.colors.join(' / ')}</span></span>
      </span>
    </button>
  );
}

const GROUPS = [['C', 'Characters'], ['E', 'Events'], ['S', 'Stages']];
function DeckList({ deck, cards, onHover }) {
  const groups = { C: [], E: [], S: [] };
  for (const [k, n] of deck.cards) { const c = cards[k]; if (c && groups[c.cat]) groups[c.cat].push([c, n]); }
  for (const g of Object.values(groups)) g.sort((a, b) => (a[0].cost || 0) - (b[0].cost || 0) || a[0].name.localeCompare(b[0].name));
  const total = list => list.reduce((s, [, n]) => s + n, 0);
  return (
    <div className="op-list">
      {GROUPS.filter(([k]) => groups[k].length).map(([k, label]) => (
        <div key={k} className="grp">
          <div className="label">{label} · {total(groups[k])}</div>
          {groups[k].map(([c, n]) => (
            <div key={c.id} className="op-row" onMouseEnter={() => onHover(c.id)} onMouseLeave={() => onHover(null)}>
              <b>{n}</b>
              <span className="cost" title={`Cost ${c.cost}`}>{c.cost}</span>
              <span className="nm">{c.name}</span>
              {c.power != null ? <span className="pw">{c.power}</span> : null}
              {c.counter ? <span className="ctr" title={`Counter +${c.counter}`}>+{c.counter / 1000}k</span> : null}
              {c.trigger ? <span className="trg" title="Has a Trigger">Trigger</span> : null}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// the Leader's printed words, keywords explained on hover or tap (glossary.jsx)
export { EffectText };

export function OpLobby({ data, online, onStart, onHome, onHelp }) {
  useSyncExternalStore(subscribeOp, opImagesVersion);
  const saved = (() => { try { return JSON.parse(localStorage.getItem('op-lobby') || '{}'); } catch { return {}; } })();
  const [mine, setMine] = useState(data.decks.some(d => d.id === baseDeckId(saved.mine)) ? baseDeckId(saved.mine) : data.decks[0].id);
  const [opp, setOpp] = useState(saved.opp && (saved.opp === 'random' || deckById(data, saved.opp)) ? saved.opp : 'random');
  // the Leader picked for each Ultra Deck (decks with more than one Leader in the box)
  const [leads, setLeads] = useState(() => (saved.leads && typeof saved.leads === 'object' ? saved.leads : {}));
  const [hover, setHover] = useState(null);
  const [q, setQ] = useState('');
  const [color, setColor] = useState('all');
  const base = data.decks.find(d => d.id === mine);
  const deck = deckById(data, withLeader(base, leads[mine])) || base;
  const lead = data.cards[deck.leader] || {};
  const qq = q.trim().toLowerCase();
  const shown = data.decks.filter(d => (color === 'all' || d.colors.includes(color)) && (!qq || `${d.code} ${d.name}`.toLowerCase().includes(qq) || ((data.cards[d.leader] || {}).name || '').toLowerCase().includes(qq) || d.cards.some(([k]) => ((data.cards[k] || {}).name || '').toLowerCase().includes(qq))));
  const friends = online.mode === 'friends';
  // in a room, the deck picked here is the one you bring (with its sleeves and box)
  const styles = useSyncExternalStore(subscribeDeckStyles, deckStylesVersion);
  useEffect(() => {
    try { localStorage.setItem('op-lobby', JSON.stringify({ mine, opp, leads })); } catch { /* storage unavailable */ }
    online.onDeck(deck.id);
  }, [deck.id, online.room, styles]);
  const start = () => {
    // a random opponent: any other deck, and for an Ultra Deck any of its Leaders
    const pool = data.decks.filter(d => d.id !== mine);
    const pickRandom = () => { const d = pool[Math.floor(Math.random() * pool.length)]; const ls = d.leaders || [d.leader]; return deckById(data, withLeader(d, ls[Math.floor(Math.random() * ls.length)])); };
    const o = opp === 'random' ? pickRandom() : deckById(data, opp);
    onStart({ mine: deck, opp: o });
  };
  const preview = hover ? opImage(hover) : opImage(deck.leader) || opThumb(deck.leader);
  const hovered = hover ? data.cards[hover] : lead;
  return (
    <div className="app op">
      <KwTip />
      <header className="topbar">
        <button className="brand linklike" onClick={onHome} title="Choose a game">Stigz’s TCG Arena</button>
        <span className="chip op-chip">One Piece Card Game</span>
        <span className="spacer" />
        <button className="btn sm" onClick={onHome}>Switch game</button>
        <SizeButton />
        <button className="btn sm" onClick={onHelp}>How to play</button>
      </header>
      <main className="lobby op-lobby">
        <section className="intro" data-eyebrow="One Piece Card Game · Starter decks">
          <h1>Choose your crew, set sail</h1>
          <p>{data.decks.length} starter decks, each one exactly as it comes in the box: a Leader and 50 cards. Battle the computer or a friend, with every [On Play], [Trigger] and Counter working by the official rules.</p>
        </section>
        <div className="op-lobby-grid">
          <section className="panel" aria-label="Your deck">
            <div className="panel-head"><h2>Your deck</h2><span className="note">{shown.length === data.decks.length ? `${data.decks.length} decks` : `${shown.length} of ${data.decks.length} decks`}</span></div>
            <div className="op-deckfilter">
              <input className="input search" placeholder="Search decks, Leaders or cards" value={q} onChange={e => setQ(e.target.value)} aria-label="Search decks" />
              <div className="op-colors" role="group" aria-label="Filter by color">
                <button className={color === 'all' ? 'on' : ''} aria-pressed={color === 'all'} onClick={() => setColor('all')}>All</button>
                {OP_COLORS.filter(c => data.decks.some(d => d.colors.includes(c))).map(c => <button key={c} className={color === c ? 'on' : ''} aria-pressed={color === c} onClick={() => setColor(color === c ? 'all' : c)} title={`${c} decks`}><ColorDot colors={c} size={14} /><span>{c}</span></button>)}
              </div>
            </div>
            <div className="op-decks">
              {shown.map((d, i) => <DeckTile key={d.id} i={i} deck={d} cards={data.cards} selected={d.id === mine} onClick={() => setMine(d.id)} />)}
              {!shown.length ? <div className="empty">No deck matches.</div> : null}
            </div>
          </section>
          <div className="setup">
            <div className="seg modeswitch" role="tablist" aria-label="Game mode">
              <button role="tab" aria-selected={!friends} className={!friends ? 'on' : ''} onClick={() => online.setMode('solo')}>Vs the computer</button>
              <button role="tab" aria-selected={friends} className={friends ? 'on' : ''} onClick={() => online.setMode('friends')}>Play with friends</button>
            </div>
            {friends ? <OpFriendsPanel data={data} online={online} deck={deck} /> : (
              <section className="panel op-start" aria-label="Opponent">
                <div className="op-start-row">
                  <div className="op-start-opp">
                    <label className="label" htmlFor="op-opp">Computer's deck</label>
                    <select id="op-opp" className="input" value={opp} onChange={e => setOpp(e.target.value)}>
                      <option value="random">Random deck</option>
                      {data.decks.flatMap(d => (d.leaders || [d.leader]).map(l => { const id = withLeader(d, l); return <option key={id} value={id}>{d.code} · {d.name}{d.leaders ? ` (${(data.cards[l] || {}).name})` : ''}</option>; }))}
                    </select>
                  </div>
                  <button className="btn primary big" onClick={start}>Battle!</button>
                </div>
                <p className="note">You lead <b>{lead.name || deck.name}</b> ({deck.code} {deck.name}).</p>
              </section>
            )}
            <section className="panel op-chosen" aria-label="Selected deck">
              <div className="panel-head"><h2>{deck.code} · {deck.name}</h2><ColorDot colors={deck.colors} size={16} /></div>
              <div className="op-chosen-body" key={mine}>
                <div className="op-feature">
                  {preview ? <img key={preview} src={preview} alt={hovered ? hovered.name : deck.name} /> : <div className="op-card big drawn"><b>{hovered ? hovered.name : deck.name}</b></div>}
                </div>
                <div className="op-chosen-info">
                  <DeckStyleButton kind="op" deck={base} colors={deck.colors} />
                  <p className="blurb">{deck.blurb}</p>
                  {base.leaders ? (
                    <div className="op-leaderpick" role="radiogroup" aria-label="Choose the Leader">
                      <div className="label">This box has {base.leaders.length} Leaders: pick one</div>
                      <div className="opts">
                        {base.leaders.map(l => { const c = data.cards[l] || {}; const on = l === deck.leader; const img = opThumb(l) || opImage(l); return (
                          <button key={l} role="radio" aria-checked={on} className={on ? 'on' : ''} onClick={() => setLeads(x => ({ ...x, [mine]: l }))} onMouseEnter={() => setHover(l)} onMouseLeave={() => setHover(null)} title={`${c.name} · ${(c.colors || []).join('/')} · ${c.life} Life`}>
                            <span className="pic">{img ? <img src={img} alt="" draggable="false" /> : null}</span>
                            <span className="nm">{(/[^.\s"]+$/.exec(c.name || '') || [c.name])[0]}</span>
                            <ColorDot colors={c.colors || []} size={11} />
                          </button>
                        ); })}
                      </div>
                    </div>
                  ) : null}
                  <div className="op-leader">
                    <div className="label">Leader · {lead.name}</div>
                    <div className="stats"><span><b>{lead.life}</b> Life</span><span><b>{lead.power}</b> Power</span>{lead.attr && lead.attr.length ? <span>{lead.attr.join(' / ')}</span> : null}</div>
                    <p className="fx"><EffectText text={lead.text} /></p>
                  </div>
                  <DeckRecord kind="op" id={deck.id} />
                </div>
              </div>
              <DeckList key={mine} deck={deck} cards={data.cards} onHover={setHover} />
            </section>
          </div>
        </div>
        <p className="foot">Unofficial fan project, not affiliated with Bandai, Shueisha or Toei Animation. ONE PIECE and the ONE PIECE CARD GAME are trademarks of Eiichiro Oda/Shueisha, Toei Animation and Bandai. Card data from optcgapi.com, decklists from Limitless.</p>
      </main>
    </div>
  );
}
