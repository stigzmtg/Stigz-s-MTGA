// The front door: choose Magic: The Gathering Commander or the Pokémon TCG battle simulator.
import { initPkImages, pkImage, subscribePk, pkImagesVersion, preloadPk } from '../ptcg/ui/images.js';
import { initImages, lobbyImages, subscribeImages, imagesVersion } from './images.js';

const { useEffect, useSyncExternalStore } = React;
const PK_FAN = ['OBF-125', 'TWM-130', 'SVI-86'];
const MTG_FAN = ['c17-draconic-domination', 'cm2-breed-lethality', 'c17-vampiric-bloodlust'];

export function Home({ onPick }) {
  useSyncExternalStore(subscribePk, pkImagesVersion);
  useSyncExternalStore(subscribeImages, imagesVersion);
  useEffect(() => { initPkImages().then(ok => { if (ok) preloadPk(); }); initImages(); }, []);
  const mtgFan = MTG_FAN.map(id => lobbyImages(id)[0] || null);
  return (
    <div className="app home">
      <header className="topbar"><span className="brand">Precon Arena</span></header>
      <main className="home-main">
        <h1>Choose your game</h1>
        <p className="lede">Two card battle simulators in one place. Play against the computer, or with friends.</p>
        <div className="home-tiles">
          <button className="home-tile mtg" onClick={() => onPick('mtg')}>
            <span className="art">
              {mtgFan.some(Boolean) ? mtgFan.map((u, i) => (u ? <img key={i} src={u} alt="" style={{ '--i': i - 1 }} /> : <span key={i} className="ph" style={{ '--i': i - 1 }} />)) : <span className="sigil">✦</span>}
            </span>
            <span className="txt">
              <b>Magic: The Gathering</b>
              <span className="sub">Commander</span>
              <span className="desc">All 194 preconstructed Commander decks, full rules automation, 1v1 or up to 4 players against AI or friends.</span>
              <span className="go">Play Commander →</span>
            </span>
          </button>
          <button className="home-tile pk" onClick={() => onPick('pokemon')}>
            <span className="art">
              {PK_FAN.map((k, i) => { const u = pkImage(k); return u ? <img key={k} src={u} alt="" style={{ '--i': i - 1 }} /> : <span key={k} className="ph" style={{ '--i': i - 1 }} />; })}
            </span>
            <span className="txt">
              <b>Pokémon TCG</b>
              <span className="sub">Battle simulator</span>
              <span className="desc">Ten of the most popular tournament decks, Charizard ex to Dragapult ex, played by the rules against a computer opponent.</span>
              <span className="go">Play Pokémon →</span>
            </span>
          </button>
        </div>
      </main>
    </div>
  );
}
