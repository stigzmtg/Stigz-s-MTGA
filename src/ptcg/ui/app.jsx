// The Pokémon side of the site: load the card pool and decks, then lobby <-> battle.
import { PokemonGame } from '../game.js';
import { PokemonAI } from '../ai.js';
import { PtcgHuman } from './human.js';
import { PkLobby } from './lobby.jsx';
import { Battle } from './battle.jsx';
import { initPkImages, preloadPk } from './images.js';
import { createStore, loadSettings, fetchJSON } from '../../ui/common.js';
import { makePace } from '../../ui/pacing.js';
import { Modal } from '../../ui/dialogs.jsx';

const { useState, useEffect } = React;

function newBattle(data, cfg) {
  const store = createStore();
  const settings = loadSettings();
  const human = new PtcgHuman(() => store.bump());
  const ai = new PokemonAI({ pace: makePace(settings) });
  let agent = human;
  // browser tests: a computer player takes your seat for the first N turns (window.__pkAutoplay)
  if (typeof window !== 'undefined' && window.__pkAutoplay) {
    const bot = new PokemonAI();
    agent = { ask: (g, pid, req) => (g.turn < window.__pkAutoplay ? bot.ask(g, pid, req) : human.ask(g, pid, req)) };
  }
  const game = new PokemonGame({
    db: data.cards, onUpdate: () => store.bump(),
    players: [{ name: 'You', deck: cfg.mine, agent, human: true }, { name: cfg.opp.name, deck: cfg.opp, agent: ai }],
  });
  game.start().then(() => store.bump(), e => { console.error(e); store.bump(); });
  return { game, human, ai, store, settings, cfg };
}

export function HowToPlayPk({ onClose }) {
  return (
    <Modal label="How to play" onClose={onClose}>
      <h2>How to play</h2>
      <div className="help">
        <section><h3>Goal</h3><p>Take all 6 of your Prize cards by Knocking Out your opponent's Pokémon (Pokémon ex give 2, Mega Evolution ex give 3), or leave your opponent with no Pokémon in play, or with no cards to draw.</p></section>
        <section><h3>Your turn</h3><p>Draw, then in any order: put Basic Pokémon on your Bench, evolve, attach <b>one</b> Energy, play any Items, <b>one</b> Supporter and one Stadium, use Abilities and Retreat once. Then attack, which ends your turn. The player who goes first can't attack or play a Supporter on their first turn.</p></section>
        <section><h3>Playing cards</h3><p>Glowing cards in your hand can be played: click them. Energy, Tools and Evolutions then ask which Pokémon to put them on. Attacks, Retreat and Abilities are buttons in the bar across the middle of the table. Point at any card to read it in the side panel.</p></section>
        <section><h3>Damage</h3><p>Weakness doubles damage and Resistance takes 30 off, for the Active Pokémon only. Asleep and Paralyzed Pokémon can't attack or retreat, Confused ones may hurt themselves, and Poison and Burns add damage between turns.</p></section>
      </div>
      <div className="row"><button className="btn primary" onClick={onClose}>Got it</button></div>
    </Modal>
  );
}

export function PokemonApp({ onHome }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [session, setSession] = useState(null);
  const [help, setHelp] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const [cards, decks] = await Promise.all([fetchJSON('data/ptcg/cards.json'), fetchJSON('data/ptcg/decks.json')]);
        setData({ cards, decks });
      } catch (e) { setError(e.message); }
    })();
    initPkImages().then(ok => { if (ok) preloadPk(); });
  }, []);
  useEffect(() => () => { if (session) { session.game.over = true; session.human.cancel(); } }, [session]);
  if (error) return <div className="app pk"><div className="loading"><h2>Couldn't load the Pokémon cards</h2><p>{error}</p><button className="btn" onClick={onHome}>Back</button></div></div>;
  if (!data) return <div className="app pk"><div className="loading"><div className="label">Shuffling decks</div><div className="bar"><i style={{ width: '60%' }} /></div></div></div>;
  const end = () => { if (session) { session.game.over = true; session.human.cancel(); } };
  if (!session) return <>
    <PkLobby data={data} onStart={cfg => setSession(newBattle(data, cfg))} onHome={onHome} onHelp={() => setHelp(true)} />
    {help ? <HowToPlayPk onClose={() => setHelp(false)} /> : null}
  </>;
  return <Battle key={session.game.seed} session={session}
    onExit={() => { end(); setSession(null); }}
    onLobby={() => { end(); setSession(null); }}
    onRematch={() => { end(); setSession(newBattle(data, session.cfg)); }} />;
}
