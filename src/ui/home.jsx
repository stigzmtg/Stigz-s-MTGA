// The front door: a title under drifting card art, the two games as arched gates with everything each one offers,
// shelves of decks you can jump straight into, a box for joining a friend's room, and what makes the tables play well.
import { initPkImages, pkImage, subscribePk, pkImagesVersion, preloadPk } from '../ptcg/ui/images.js';
import { initImages, lobbyImages, subscribeImages, imagesVersion } from './images.js';
import { Pip } from './cardview.jsx';
import { Energy } from '../ptcg/ui/energy.jsx';
import { codeFromInput } from '../ptcg/ui/friends.jsx';
import { isRoomCode } from '../net/roomclient.js';
import { safeStorage, fetchJSON } from './common.js';
import { loadRecords, tally } from './records.js';
import { subscribeInstall, canInstall, install } from './install.js';
import { SizeButton } from './dialogs.jsx';

const { useState, useEffect, useSyncExternalStore } = React;

// every Commander deck shown here has its commander art in the same image pack, so the page loads one MTG pack
const MTG_FAN = ['cma-heavenly-inferno', 'cm2-breed-lethality', 'c17-draconic-domination', 'c17-vampiric-bloodlust', 'c17-feline-ferocity'];
const MTG_DRIFT = ['c19-merciless-rage', 'c18-nature-s-vengeance', 'c20-arcane-maelstrom', 'cmr-reap-the-tides', 'khc-elven-empire', 'cma-plunder-the-graves', 'c18-adaptive-enchantment', 'cm2-devour-for-power', 'c16-entropic-uprising', 'afc-draconic-rage'];
const PK_FAN = ['SVI-81', 'SVI-86', 'OBF-125', 'TWM-130', 'TEF-123'];
const PK_DRIFT = ['PAR-139', 'MEG-86', 'PAL-61', 'PAR-124', 'LOR-79', 'MEG-104', 'TWM-25', 'SSP-57', 'PAL-60', 'OBF-164', 'MEW-151', 'SSP-76'];
// [deck id, name, commander, color identity, set, year, what it does]
const MTG_FEATURED = [
  ['cma-heavenly-inferno', 'Heavenly Inferno', 'Kaalia of the Vast', 'WBR', 'Commander Anthology', 2017, 'Kaalia attacks and drops Angels, Demons and Dragons from your hand straight into the fight.'],
  ['c16-breed-lethality', 'Breed Lethality', "Atraxa, Praetors' Voice", 'WUBG', 'Commander 2016', 2016, 'Proliferate at every end step: +1/+1 counters, loyalty and poison all keep growing.'],
  ['c17-draconic-domination', 'Draconic Domination', 'The Ur-Dragon', 'WUBRG', 'Commander 2017', 2017, 'Five-color Dragons cost less, and every Dragon attack draws cards and drops more permanents.'],
  ['c17-vampiric-bloodlust', 'Vampiric Bloodlust', 'Edgar Markov', 'WBR', 'Commander 2017', 2017, 'Every Vampire spell you cast brings a 1/1 Vampire token along with it.'],
  ['cma-plunder-the-graves', 'Plunder the Graves', 'Meren of Clan Nel Toth', 'BG', 'Commander Anthology', 2017, 'Creatures die for value, and Meren brings one back from your graveyard every end step.'],
  ['c18-adaptive-enchantment', 'Adaptive Enchantment', 'Estrid, the Masked', 'WUG', 'Commander 2018', 2018, 'Enchant your own permanents, then untap every one of them with a single loyalty ability.'],
  ['c20-arcane-maelstrom', 'Arcane Maelstrom', 'Kalamax, the Stormsire', 'URG', 'Commander 2020', 2020, 'Copies the first instant you cast each turn while it is tapped, growing with every copy.'],
  ['afc-planar-portal', 'Planar Portal', 'Prosper, Tome-Bound', 'BR', 'Forgotten Realms Commander', 2021, 'Play cards from exile and make a Treasure every time you do.'],
  ['c17-feline-ferocity', 'Feline Ferocity', 'Arahbo, Roar of the World', 'WG', 'Commander 2017', 2017, 'At the start of every combat on your turn, another Cat gets +3/+3.'],
  ['c18-nature-s-vengeance', "Nature's Vengeance", 'Lord Windgrace', 'BRG', 'Commander 2018', 2018, 'A planeswalker commander that brings lands back from the graveyard and turns them into value.'],
];
const PK_TYPES = ['Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal'];

// ---------------------------------------------------------------- small pieces
// the arena's mark: two cards fanned, one per game
function Crest({ size = 30 }) {
  return (
    <svg className="crest" width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <rect x="9" y="7" width="17" height="24" rx="2.5" transform="rotate(-14 17 19)" fill="#1d4bb0" stroke="#ffd23f" strokeWidth="1.6" />
      <rect x="14" y="8" width="17" height="24" rx="2.5" transform="rotate(10 22 20)" fill="#2e1f0d" stroke="#f3d488" strokeWidth="1.6" />
      <path d="M22.6 14.5l2.4 4.4-2.4 4.4-2.4-4.4z" fill="#f3d488" transform="rotate(10 22 20)" />
    </svg>
  );
}

function Ornament() {
  return (
    <svg className="ornament" viewBox="0 0 220 14" aria-hidden="true">
      <path d="M0 7h92M128 7h92" stroke="currentColor" strokeWidth="1" />
      <path d="M110 1l6 6-6 6-6-6z" fill="currentColor" /><path d="M97 7l4-3v6zM123 7l-4-3v6z" fill="currentColor" opacity="0.7" />
    </svg>
  );
}

function SectionHead({ id, eyebrow, title, children }) {
  return (
    <header className="sec-head">
      <div className="eyebrow">{eyebrow}</div>
      <h2 id={id}>{title}</h2>
      <Ornament />
      {children ? <p>{children}</p> : null}
    </header>
  );
}

function Fan({ urls, label }) {
  const mid = (urls.length - 1) / 2;
  return (
    <span className="fan" aria-hidden="true">
      {urls.map((u, i) => <span key={i} className="fc" style={{ '--k': i - mid, '--a': Math.abs(i - mid) }}>{u ? <img src={u} alt="" draggable="false" /> : null}</span>)}
      <span className="sr">{label}</span>
    </span>
  );
}

// two bands of real card art drifting in opposite directions behind the title
function Drift({ rows }) {
  return (
    <div className="drift" aria-hidden="true">
      {rows.map((row, r) => (
        <div key={r} className={`band b${r}`}>
          <div className="track">{[...row, ...row].map((u, i) => <span key={i} className="dc">{u ? <img src={u} alt="" draggable="false" /> : null}</span>)}</div>
        </div>
      ))}
    </div>
  );
}

const ICONS = {
  ai: 'M11 2h2v4h-2zM6 6h12a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3zm3 4.5a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6zm6 0a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6zM9 16.2h6v1.4H9zM0.5 11H2v4H.5zM22 11h1.5v4H22z',
  friends: 'M8 11a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7zm8 0a3 3 0 1 1 0-6 3 3 0 0 1 0 6zM2 20c0-3.3 2.7-6 6-6s6 2.7 6 6H2zm13.5 0a7.4 7.4 0 0 0-2-5 4.6 4.6 0 0 1 2.5-.8c2.8 0 5 2.4 5 5.8h-5.5z',
  art: 'M5 3h10l4 4v14H5V3zm2 2v14h10V8h-3V5H7zm2 11 2.5-3.5 2 2.5 1.5-2 2 3H9z',
  rules: 'M4 4h7a3 3 0 0 1 1 .2A3 3 0 0 1 13 4h7v15h-7a2 2 0 0 0-1 .3 2 2 0 0 0-1-.3H4V4zm2 2v11h5l.5.1V7a1 1 0 0 0-1-1H6zm12 0h-4.5a1 1 0 0 0-1 1v10.1L13 17h5V6z',
  rejoin: 'M12 4a8 8 0 0 1 7.4 5H22l-3.5 4.5L15 9h2.2A6 6 0 0 0 6 12H4a8 8 0 0 1 8-8zm-6.5 6.5L9 15H6.8A6 6 0 0 0 18 12h2a8 8 0 0 1-15.4 3H2z',
  device: 'M3 5h14v9H3V5zm2 2v5h10V7H5zM1 16h18v2H1v-2zm19-9h3v12h-5v-3h2V7zm1 9.5a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6z',
  check: 'M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6 11-11-1.4-1.4z',
};
const Icon = ({ name, className }) => <svg className={className} viewBox="0 0 24 24" aria-hidden="true"><path d={ICONS[name]} fillRule={name === 'ai' ? 'evenodd' : undefined} /></svg>;

const FEATURES = [
  ['ai', 'Opponents that think', 'Computer players take a moment over each play, put lands down and tap them one at a time, and pick their attacks to win.'],
  ['rules', 'Every rule handled', 'Commander damage, tax and the command zone. Weakness, Resistance, special conditions and Prize cards. The table applies them as you play.'],
  ['art', 'Real card art', 'Every card shows its real printed picture, and pointing at one shows its full text in the side panel.'],
  ['friends', 'Rooms for friends', 'Make a room for either game and send the link. Everyone shows up as an animal avatar they dress up themselves, with their own card sleeves and deck box. Rooms run through this site’s own server, so they work on school Wi-Fi, and nobody needs an account.'],
  ['rejoin', 'Rejoin and watch', 'Reload or lose your connection and the room link puts you back in your seat. Anyone else with the link can watch.'],
  ['device', 'Plays anywhere', 'Runs in the browser on laptops, Chromebooks, tablets and phones. Nothing to install and nothing to sign up for.'],
];

// ---------------------------------------------------------------- the two games
function Gate({ game, title, kind, pips, fan, fanLabel, keystone, blurb, facts, points, onPlay }) {
  return (
    <article className={`gate ${game}`} aria-labelledby={`gate-${game}`}>
      <button className="arch" onClick={() => onPlay('solo')} aria-label={`Play ${title} against the computer`}>
        <span className="keystone" aria-hidden="true">{keystone}</span>
        <Fan urls={fan} label={fanLabel} />
      </button>
      <div className="plaque">
        <span className="pips" aria-hidden="true">{pips}</span>
        <h3 className="name" id={`gate-${game}`}>{title}</h3>
        <span className="kind">{kind}</span>
        <p className="blurb">{blurb}</p>
        <div className="facts">{facts.map(([n, l]) => <span key={l}><b>{n}</b>{l}</span>)}</div>
        <ul className="points">{points.map(p => <li key={p}><Icon name="check" />{p}</li>)}</ul>
        <div className="gate-acts">
          <button className="cta" onClick={() => onPlay('solo')}>Play vs computer</button>
          <button className="cta2" onClick={() => onPlay('friends')}><Icon name="friends" />Play with friends</button>
        </div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------- deck shelves
function MtgTile({ d, onPick }) {
  const [id, name, commander, colors, set, year, text] = d;
  const img = lobbyImages(id)[0] || null;
  return (
    <button className="deck-tile mtg" onClick={() => onPick(id)} aria-label={`${name}, ${commander}. Pick this deck`}>
      <span className="dt-art mtg">{img ? <img src={img} alt="" draggable="false" /> : <span className="dt-ph">{commander}</span>}<span className="dt-badge">{set}</span></span>
      <span className="dt-body">
        <span className="dt-top"><span className="dt-colors">{colors.split('').map(c => <Pip key={c} s={c} />)}</span><span className="dt-set">{year}</span></span>
        <b className="dt-name">{name}</b>
        <span className="dt-sub">{commander}</span>
        <span className="dt-text">{text}</span>
        <span className="dt-go">Pick this deck</span>
      </span>
    </button>
  );
}

function PkTile({ d, onPick }) {
  const img = pkImage(d.featured);
  return (
    <button className="deck-tile pk" onClick={() => onPick(d.id)} aria-label={`${d.name}. Pick this deck`}>
      <span className="dt-art pk">{img ? <img src={img} alt="" draggable="false" /> : <span className="dt-ph">{d.name}</span>}</span>
      <span className="dt-body">
        <span className="dt-top"><span className="dt-colors">{d.energy.map(t => <Energy key={t} type={t} size={17} />)}</span><span className="dt-set">60 cards</span></span>
        <b className="dt-name">{d.name}</b>
        <span className="dt-sub">{d.player ? `Played by ${d.player}` : d.list}</span>
        <span className="dt-text">{d.blurb}</span>
        <span className="dt-go">Pick this deck</span>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------- joining a friend's room
function JoinBox({ onJoin }) {
  const [game, setGame] = useState(() => safeStorage.getItem('pa-home-join') || 'mtg');
  const [code, setCode] = useState('');
  const change = v => {
    // a pasted invite link says which game it is for
    if (/#pk-/i.test(v)) setGame('pokemon'); else if (v.includes('#')) setGame('mtg');
    setCode(codeFromInput(v));
  };
  const go = e => { e.preventDefault(); if (!isRoomCode(code)) return; safeStorage.setItem('pa-home-join', game); onJoin(game, code); };
  return (
    <form className="joinbox" onSubmit={go} aria-label="Join a friend's room">
      <h3>Got a room code?</h3>
      <p>Type the 6-letter code your friend sees in their room, or paste their invite link.</p>
      <div className="seg" role="group" aria-label="Which game">
        <button type="button" className={game === 'mtg' ? 'on' : ''} aria-pressed={game === 'mtg'} onClick={() => setGame('mtg')}>Commander</button>
        <button type="button" className={game === 'pokemon' ? 'on' : ''} aria-pressed={game === 'pokemon'} onClick={() => setGame('pokemon')}>Pokémon</button>
      </div>
      <div className="join-row">
        <label className="sr" htmlFor="home-code">Room code</label>
        <input id="home-code" className="input" value={code} placeholder="e.g. k7m2qa" autoComplete="off" spellCheck="false" onChange={e => change(e.target.value)} />
        <button className="cta" type="submit" disabled={!isRoomCode(code)}>Join room</button>
      </div>
      <p className="fine">Opening the invite link itself works too. You'll pick a name and a deck once you're in.</p>
    </form>
  );
}

// ---------------------------------------------------------------- your record
const when = t => {
  const d = new Date(t), now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Today ${time}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};
const RESULT = { win: 'Win', loss: 'Loss', draw: 'Draw' };

function Summary({ kind, label }) {
  const t = tally(kind);
  if (!t.games) return <div className={`rec-sum ${kind}`}><b>{label}</b><span className="none">No games yet</span></div>;
  const counts = {};
  for (const r of loadRecords()) if (r.kind === kind) counts[r.deck.name] = (counts[r.deck.name] || 0) + 1;
  const fav = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const pct = Math.round((100 * t.win) / t.games);
  return (
    <div className={`rec-sum ${kind}`}>
      <b>{label}</b>
      <span className="wl"><em>{t.win}</em>–<em>{t.loss}</em>{t.draw ? <>–<em>{t.draw}</em></> : null}</span>
      <span className="meter" aria-label={`${pct}% wins`}><i style={{ width: pct + '%' }} /></span>
      <span className="fine">{pct}% wins over {t.games} game{t.games === 1 ? '' : 's'}{fav ? ` · most played: ${fav[0]}` : ''}</span>
    </div>
  );
}

function RecordSection({ onWatch }) {
  const recs = loadRecords();
  return (
    <section className="home-sec record" aria-labelledby="record">
      <SectionHead id="record" eyebrow="Your games" title="Your record">{recs.length ? 'Every game you finish is kept on this device, and the latest ones come with a replay you can watch move by move.' : 'Finish a game and it shows up here, with a replay you can watch move by move.'}</SectionHead>
      <div className="rec-grid">
        <Summary kind="mtg" label="Commander" />
        <Summary kind="pk" label="Pokémon" />
      </div>
      {recs.length ? (
        <ol className="rec-list" aria-label="Recent games">
          {recs.slice(0, 8).map(r => (
            <li key={r.id} className={r.kind}>
              <span className={`res ${r.result}`}>{RESULT[r.result]}</span>
              <span className="what"><b>{r.deck.name}</b><span>vs {r.opps.map(o => o.deck || o.name).join(', ')}</span></span>
              <span className="meta">{r.kind === 'pk' ? 'Pokémon' : 'Commander'} · {r.mode === 'online' ? 'with friends' : 'vs computer'} · {r.turns} turns · {when(r.at)}</span>
              {r.replay ? <button className="btn sm" onClick={() => onWatch(r)}>Watch replay</button> : <span className="noreplay">No replay</span>}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- the page
export function Home({ onPick, onJoin }) {
  useSyncExternalStore(subscribePk, pkImagesVersion);
  useSyncExternalStore(subscribeImages, imagesVersion);
  const [pkDecks, setPkDecks] = useState(null);
  const installable = useSyncExternalStore(subscribeInstall, canInstall);
  useEffect(() => {
    initPkImages().then(ok => { if (ok) preloadPk(); });
    initImages();
    fetchJSON('data/ptcg/decks.json').then(setPkDecks, () => setPkDecks([]));
  }, []);
  const mtg = id => lobbyImages(id)[0] || null;
  // two mixed bands: each alternates the games
  const a = [], b = [];
  for (let i = 0; i < 10; i++) { a.push(i % 2 ? pkImage(PK_DRIFT[i]) : mtg(MTG_DRIFT[i])); b.push(i % 2 ? mtg(MTG_DRIFT[(i + 5) % 10]) : pkImage(PK_DRIFT[(i + 2) % 12])); }
  const scrollTo = id => { const el = document.getElementById(id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  // open a game, in a mode, optionally with a deck already picked in its lobby
  const open = (game, mode = 'solo', deck = null) => {
    const [modeKey, lobbyKey] = game === 'mtg' ? ['pa-mode', 'pa-lobby'] : ['pk-mode', 'pk-lobby'];
    safeStorage.setItem(modeKey, mode);
    if (deck) { let s = {}; try { s = JSON.parse(safeStorage.getItem(lobbyKey) || '{}') || {}; } catch { /* corrupt entry */ } safeStorage.setItem(lobbyKey, JSON.stringify({ ...s, mine: deck })); }
    onPick(game);
  };

  return (
    <div className="app home">
      <nav className="home-nav" aria-label="Main">
        <button className="brandmark linklike" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}><Crest />Stigz’s TCG Arena</button>
        <span className="links">
          <button onClick={() => scrollTo('games')}>Games</button>
          <button onClick={() => scrollTo('decks')}>Decks</button>
          <button onClick={() => scrollTo('friends')}>Friends</button>
          <button onClick={() => scrollTo('record')}>Record</button>
          <button onClick={() => scrollTo('why')}>Features</button>
        </span>
        <span className="spacer" />
        {installable ? <button className="navbtn install" onClick={install} title="Add Stigz’s TCG Arena to your home screen or shelf">Install app</button> : null}
        <SizeButton cls="navbtn sizebtn" />
        <button className="navbtn mtg" onClick={() => open('mtg')}>Commander</button>
        <button className="navbtn pk" onClick={() => open('pokemon')}>Pokémon</button>
      </nav>

      <header className="hero">
        <Drift rows={[a, b]} />
        <div className="hero-copy">
          <button className="newpill" onClick={() => scrollTo('friends')}><b>New</b>Pokémon battles with friends</button>
          <div className="eyebrow">Two card battle simulators</div>
          <h1 className="title">Stigz’s TCG Arena</h1>
          <p className="lede">Bring a ready-made deck, take your seat, and battle the computer or your friends. Every card plays by the rules, right in your browser.</p>
          <dl className="stats">
            <div><dt>Decks ready to play</dt><dd>238</dd></div>
            <div><dt>Cards with rules</dt><dd>6,807</dd></div>
            <div><dt>Players a table</dt><dd>2–4</dd></div>
            <div><dt>Accounts needed</dt><dd>0</dd></div>
          </dl>
        </div>
      </header>

      <section className="home-sec games" aria-labelledby="games">
        <SectionHead id="games" eyebrow="Choose your table" title="Two games, one arena">Each game has its own rules engine, its own computer opponent and its own rooms for friends.</SectionHead>
        <div className="gates">
          <Gate game="mtg" title="Magic: The Gathering" kind="Commander" keystone="✦"
            pips={['W', 'U', 'B', 'R', 'G'].map(s => <Pip key={s} s={s} />)}
            fan={MTG_FAN.map(mtg)} fanLabel="Commanders: Kaalia, Atraxa, The Ur-Dragon, Edgar Markov, Arahbo"
            blurb="Every preconstructed Commander deck from Commander 2013 to today, 100 cards each, played with full rules automation."
            facts={[['194', 'precon decks'], ['2–4', 'players a table'], ['6,422', 'cards scripted']]}
            points={['1v1 or a 4-player free-for-all', 'Commander damage, tax and the command zone tracked', 'Lands, mana and triggers handled for you', 'Every card’s rules handled, down to the last trigger']}
            onPlay={mode => open('mtg', mode)} />
          <Gate game="pk" title="Pokémon TCG" kind="Tournament decks" keystone={<span className="ball" />}
            pips={PK_TYPES.map(t => <Energy key={t} type={t} size={19} />)}
            fan={PK_FAN.map(pkImage)} fanLabel="Miraidon ex, Gardevoir ex, Charizard ex, Dragapult ex, Raging Bolt ex"
            blurb="Forty-four of the most-played decks from top tournaments, card for card as their players built them. One on one, six Prize cards each."
            facts={[['44', 'top decks'], ['1v1', 'vs computer or a friend'], ['385', 'cards coded']]}
            points={['Weakness, Resistance and special conditions', 'Coin flips, Abilities and every Trainer', 'Evolution, Rare Candy and retreat', 'Knock Out an ex for 2 Prizes, a Mega ex for 3']}
            onPlay={mode => open('pokemon', mode)} />
        </div>
      </section>

      <section className="home-sec decks" aria-labelledby="decks">
        <SectionHead id="decks" eyebrow="Jump straight in" title="Pick a deck">Choose any deck below and it is waiting for you in the lobby. These are a few favorites; the Commander lobby has all 194.</SectionHead>
        <div className="shelf-head mtg">
          <h3><span className="sh-pips" aria-hidden="true"><Pip s="W" /><Pip s="U" /><Pip s="B" /><Pip s="R" /><Pip s="G" /></span>Commander favorites</h3>
          <button className="linkbtn" onClick={() => open('mtg')}>Browse all 194 precons</button>
        </div>
        <div className="shelf">{MTG_FEATURED.map(d => <MtgTile key={d[0]} d={d} onPick={id => open('mtg', 'solo', id)} />)}</div>
        <div className="shelf-head pk">
          <h3><span className="sh-pips" aria-hidden="true"><Energy type="Lightning" size={18} /><Energy type="Psychic" size={18} /><Energy type="Fire" size={18} /></span>Pokémon tournament decks</h3>
          <button className="linkbtn" onClick={() => open('pokemon')}>Open the Pokémon lobby</button>
        </div>
        <div className="shelf">{(pkDecks || []).map(d => <PkTile key={d.id} d={d} onPick={id => open('pokemon', 'solo', id)} />)}</div>
      </section>

      <section className="home-sec friends" aria-labelledby="friends">
        <div className="friends-grid">
          <div className="friends-copy">
            <div className="eyebrow">Play together</div>
            <h2 id="friends">Battle your friends</h2>
            <Ornament />
            <p>Everyone plays on their own screen, in their own browser. Rooms work for both games, and late arrivals can watch.</p>
            <ol className="steps">
              <li><b>Make a room</b><span>Open a game, choose <i>Play with friends</i> and press <i>Create a room</i>.</span></li>
              <li><b>Send the link</b><span>Copy the invite link and send it in a chat. Friends open it and take a seat.</span></li>
              <li><b>Battle</b><span>Each player brings their own deck. The host starts, and every move shows up on both screens.</span></li>
            </ol>
          </div>
          <JoinBox onJoin={onJoin} />
        </div>
      </section>

      <RecordSection onWatch={r => { try { sessionStorage.setItem('pa-open-replay', r.id); } catch { /* storage blocked */ } onPick(r.kind === 'pk' ? 'pokemon' : 'mtg'); }} />

      <section className="home-sec why" aria-labelledby="why">
        <SectionHead id="why" eyebrow="Built for real games" title="Why it plays well" />
        <div className="features">
          {FEATURES.map(([icon, title, text]) => (
            <div key={icon} className="feature">
              <span className="fi"><Icon name={icon} /></span>
              <div><b>{title}</b><span>{text}</span></div>
            </div>
          ))}
        </div>
      </section>

      <footer className="home-foot">
        <div className="foot-grid">
          <div className="foot-brand"><span className="brandmark"><Crest size={26} />Stigz’s TCG Arena</span><p>A free fan-made arena for playing preconstructed decks by the rules.</p></div>
          <div><h4>Play</h4><button className="linkbtn" onClick={() => open('mtg')}>Commander</button><button className="linkbtn" onClick={() => open('pokemon')}>Pokémon TCG</button><button className="linkbtn" onClick={() => scrollTo('friends')}>Join a room</button></div>
          <div><h4>Credits</h4>
            <span>Commander rules from <a href="https://github.com/Card-Forge/forge" target="_blank" rel="noopener">Forge</a> (GPL-3.0)</span>
            <span>Decklists from <a href="https://github.com/taw/magic-preconstructed-decks" target="_blank" rel="noopener">taw</a> and <a href="https://limitlesstcg.com" target="_blank" rel="noopener">Limitless</a></span>
            <span>Card data from <a href="https://scryfall.com" target="_blank" rel="noopener">Scryfall</a> and <a href="https://tcgdex.dev" target="_blank" rel="noopener">TCGdex</a></span>
          </div>
        </div>
        <p className="legal">Unofficial fan project. Magic: The Gathering is a trademark of Wizards of the Coast; Pokémon and the Pokémon TCG are trademarks of Nintendo, Creatures and GAME FREAK.</p>
      </footer>
    </div>
  );
}
