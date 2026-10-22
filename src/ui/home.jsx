// The front door: the arena's two gates, Magic: The Gathering Commander and the Pokémon TCG, under a title with
// both games' card art drifting behind it.
import { initPkImages, pkImage, subscribePk, pkImagesVersion, preloadPk } from '../ptcg/ui/images.js';
import { initImages, lobbyImages, subscribeImages, imagesVersion } from './images.js';
import { Pip } from './cardview.jsx';
import { Energy } from '../ptcg/ui/energy.jsx';

const { useEffect, useSyncExternalStore } = React;

// every commander here lives in the same image pack, so the page loads one MTG pack and the small Pokémon set
const MTG_FAN = ['cma-heavenly-inferno', 'cm2-breed-lethality', 'c17-draconic-domination', 'c17-vampiric-bloodlust', 'c17-feline-ferocity'];
const MTG_DRIFT = ['c19-merciless-rage', 'c18-nature-s-vengeance', 'c20-arcane-maelstrom', 'cmr-reap-the-tides', 'khc-elven-empire', 'cma-plunder-the-graves', 'c18-adaptive-enchantment', 'cm2-devour-for-power', 'c16-entropic-uprising', 'afc-draconic-rage'];
const PK_FAN = ['SVI-81', 'SVI-86', 'OBF-125', 'TWM-130', 'TEF-123'];
const PK_DRIFT = ['PAR-139', 'MEG-86', 'PAL-61', 'PAR-124', 'LOR-79', 'MEG-104', 'TWM-25', 'SSP-57', 'PAL-60', 'OBF-164', 'MEW-151', 'SSP-76'];

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
  ai: 'M12 3a4 4 0 0 1 4 4v1h1a2 2 0 0 1 2 2v7a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4v-7a2 2 0 0 1 2-2h1V7a4 4 0 0 1 4-4zm-2.5 9a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm5 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM12 5a2 2 0 0 0-2 2v1h4V7a2 2 0 0 0-2-2z',
  friends: 'M8 11a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7zm8 0a3 3 0 1 1 0-6 3 3 0 0 1 0 6zM2 20c0-3.3 2.7-6 6-6s6 2.7 6 6H2zm13.5 0a7.4 7.4 0 0 0-2-5 4.6 4.6 0 0 1 2.5-.8c2.8 0 5 2.4 5 5.8h-5.5z',
  art: 'M5 3h10l4 4v14H5V3zm2 2v14h10V8h-3V5H7zm2 11 2.5-3.5 2 2.5 1.5-2 2 3H9z',
  rules: 'M4 4h7a3 3 0 0 1 1 .2A3 3 0 0 1 13 4h7v15h-7a2 2 0 0 0-1 .3 2 2 0 0 0-1-.3H4V4zm2 2v11h5l.5.1V7a1 1 0 0 0-1-1H6zm12 0h-4.5a1 1 0 0 0-1 1v10.1L13 17h5V6z',
};
const FEATURES = [
  ['ai', 'Opponents that think', 'Computer players take a moment before each play, put lands down and tap them one at a time.'],
  ['friends', 'Rooms for friends', 'Make a Commander room and send the link. Nobody needs an account.'],
  ['art', 'Real card art', 'Every card shows its real printed picture, so the table looks like the real thing.'],
  ['rules', 'Rules handled for you', 'Attacks, triggers, Abilities and Prize cards resolve by the rules while you play.'],
];

export function Home({ onPick }) {
  useSyncExternalStore(subscribePk, pkImagesVersion);
  useSyncExternalStore(subscribeImages, imagesVersion);
  useEffect(() => { initPkImages().then(ok => { if (ok) preloadPk(); }); initImages(); }, []);
  const mtg = id => lobbyImages(id)[0] || null;
  const mtgFan = MTG_FAN.map(mtg);
  const pkFan = PK_FAN.map(pkImage);
  // two mixed bands: each alternates the games
  const a = [], b = [];
  for (let i = 0; i < 10; i++) { a.push(i % 2 ? pkImage(PK_DRIFT[i]) : mtg(MTG_DRIFT[i])); b.push(i % 2 ? mtg(MTG_DRIFT[(i + 5) % 10]) : pkImage(PK_DRIFT[(i + 2) % 12])); }
  return (
    <div className="app home">
      <header className="hero">
        <Drift rows={[a, b]} />
        <div className="hero-copy">
          <div className="eyebrow">Two card battle simulators</div>
          <h1 className="title">Precon Arena</h1>
          <p className="lede">Bring a ready-made deck, take your seat, and battle the computer or your friends. Every card plays by the rules.</p>
        </div>
      </header>
      <main className="gates">
        <button className="gate mtg" onClick={() => onPick('mtg')} aria-label="Play Magic: The Gathering Commander">
          <span className="arch"><span className="keystone" aria-hidden="true">✦</span><Fan urls={mtgFan} label="Commanders: Kaalia, Atraxa, The Ur-Dragon, Edgar Markov, Arahbo" /></span>
          <span className="plaque">
            <span className="pips" aria-hidden="true">{['W', 'U', 'B', 'R', 'G'].map(s => <Pip key={s} s={s} />)}</span>
            <span className="name">Magic: The Gathering</span>
            <span className="kind">Commander</span>
            <span className="facts">
              <span><b>194</b> precon decks</span>
              <span><b>2–4</b> players a table</span>
              <span><b>6,422</b> cards scripted</span>
            </span>
            <span className="cta">Play Commander</span>
          </span>
        </button>
        <button className="gate pk" onClick={() => onPick('pokemon')} aria-label="Play the Pokémon TCG">
          <span className="arch"><span className="keystone" aria-hidden="true"><span className="ball" /></span><Fan urls={pkFan} label="Miraidon ex, Gardevoir ex, Charizard ex, Dragapult ex, Raging Bolt ex" /></span>
          <span className="plaque">
            <span className="pips" aria-hidden="true">{['Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal'].map(t => <Energy key={t} type={t} size={19} />)}</span>
            <span className="name">Pokémon TCG</span>
            <span className="kind">Tournament decks</span>
            <span className="facts">
              <span><b>10</b> top decks</span>
              <span><b>1v1</b> against the computer</span>
              <span><b>148</b> cards coded</span>
            </span>
            <span className="cta">Play Pokémon</span>
          </span>
        </button>
      </main>
      <section className="features" aria-label="What you get">
        {FEATURES.map(([icon, title, text]) => (
          <div key={icon} className="feature">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d={ICONS[icon]} /></svg>
            <div><b>{title}</b><span>{text}</span></div>
          </div>
        ))}
      </section>
      <footer className="home-foot">Unofficial fan project. Magic: The Gathering is a trademark of Wizards of the Coast; Pokémon and the Pokémon TCG are trademarks of Nintendo, Creatures and GAME FREAK.</footer>
    </div>
  );
}
