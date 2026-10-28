// The Pokémon side of the site: load the card pool and decks, then lobby <-> battle (and the deck builder).
import { PokemonGame } from '../game.js';
import { PokemonAI } from '../ai.js';
import { PtcgHuman } from './human.js';
import { PkLobby } from './lobby.jsx';
import { Battle } from './battle.jsx';
import { PkDeckBuilder } from './builder.jsx';
import { initPkImages, preloadPk } from './images.js';
import { createStore, loadSettings, fetchJSON, safeStorage } from '../../ui/common.js';
import { makePace } from '../../ui/pacing.js';
import { Modal } from '../../ui/dialogs.jsx';
import { watchDesync } from '../../ui/online.jsx';
import { Lockstep, LocalSeatAgent, RemoteSeatAgent } from '../../net/lockstep.js';
import { RoomClient, roomApi, isRoomCode, onClaude } from '../../net/roomclient.js';
import { Recorder, ReplayControl, ReplayAgent, pkDelay, loadReplay } from '../../ui/records.js';
import { resetTips } from '../../ui/coach.jsx';
import { myAvatar } from '../../ui/avatar.jsx';
import { savedStyle } from '../../ui/deckstyle.jsx';
import { loadCustomDecks, deleteCustomDeck, deckLook, deckReady, findDeck, registerPacked, packDeck, unpackDeck, deckRef } from '../customdecks.js';

const { useState, useEffect, useMemo, useSyncExternalStore } = React;

// a Pokémon room invite in the address: #pk-abc123
export const pkRoomFromHash = () => { const m = /^pk-([a-z0-9]{6})$/.exec(location.hash.slice(1)); return m ? m[1] : null; };
const setHash = h => { try { history.replaceState(null, '', '#' + h); } catch { /* sandboxed frame */ } };

function storedId() {
  let id = safeStorage.getItem('pa-cid');
  if (!id) { id = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6); safeStorage.setItem('pa-cid', id); }
  return id;
}

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
    db: data.cards, onUpdate: () => store.bump(), seed: cfg.seed,
    players: [{ name: 'You', deck: cfg.mine, agent, human: true }, { name: cfg.opp.name, deck: cfg.opp, agent: ai }],
  });
  // every decision is recorded so the battle can be replayed (ui/records.js)
  const recorder = new Recorder();
  game.agents = game.agents.map(a => recorder.wrap(a));
  game.start().then(() => store.bump(), e => { console.error(e); store.bump(); });
  return { game, human, ai, store, settings, cfg, me: 0, recorder, decks: [cfg.mine, cfg.opp] };
}

// watching a replay: the same seed and decks, both seats answering from the recorded decisions (a deck of your own
// travels in the replay, as it was when the battle was played)
function newReplayBattle(data, rep) {
  const store = createStore();
  const human = new PtcgHuman(() => store.bump());
  const ctl = new ReplayControl(rep.log.length, () => store.bump());
  const agent = new ReplayAgent(rep.log, ctl, null, pkDelay);
  const deckOf = p => (p.deck && unpackDeck(p.deck, data.cards)) || findDeck(data.decks, p.deckId) || data.decks[0];
  const game = new PokemonGame({
    db: data.cards, seed: rep.seed, onUpdate: () => store.bump(), maxTurns: rep.maxTurns || 120,
    players: rep.players.map(p => ({ name: p.name, deck: deckOf(p), agent, human: p.human })),
  });
  game.start().then(() => { ctl.end(); store.bump(); }, e => { console.error(e); store.bump(); });
  return { game, human, store, settings: loadSettings(), cfg: null, me: rep.seat || 0, replay: ctl, replayId: rep.id };
}

// a battle with a friend: both browsers run the same game from the host's seed and swap only their decisions
// (see net/lockstep.js). Anyone else in the room watches.
function newOnlineBattle(data, room, cfg) {
  const store = createStore();
  const settings = loadSettings();
  const seat = cfg.seats.findIndex(s => s.c === room.cid);
  const me = seat >= 0 ? seat : null;
  const human = new PtcgHuman(() => store.bump());
  const net = new Lockstep({ channel: room.room, cid: room.cid, nick: room.nick, cfg, seat: me, onChange: () => store.bump(), storage: safeStorage });
  const isHost = cfg.host === room.cid;
  let inner = human;
  // browser tests: a computer player makes your decisions for the first N turns (window.__pkAutoplay)
  if (typeof window !== 'undefined' && window.__pkAutoplay) {
    const bot = new PokemonAI();
    inner = { ask: (g, pid, req) => (g.turn < window.__pkAutoplay ? bot.ask(g, pid, req) : human.ask(g, pid, req)) };
  }
  // the host's computer player stands in for a friend who left, once the host asks it to
  const agents = cfg.seats.map((s, pid) => pid === me ? new LocalSeatAgent(net, inner, null, null) : new RemoteSeatAgent(net, null, isHost ? new PokemonAI({ pace: makePace(settings) }) : null));
  // (a seat's own deck is named with a fingerprint of its cards: the battle only starts here once this browser has
  // exactly that deck, see decksKnown below)
  const decks = cfg.seats.map(s => findDeck(data.decks, s.d) || data.decks[0]);
  // player names only appear in text, so each browser can call its own player "You"
  const players = cfg.seats.map((s, pid) => ({ name: pid === me ? 'You' : s.n || `Player ${pid + 1}`, deck: decks[pid], agent: agents[pid], human: true }));
  const game = new PokemonGame({ db: data.cards, seed: cfg.seed, players, onUpdate: () => store.bump() });
  game.start().then(() => store.bump(), e => { console.error(e); store.bump(); });
  return { game, human, store, settings, cfg, me: me == null ? 0 : me, spectator: me == null, online: { net, code: cfg.code, game: cfg.game }, decks };
}

function endBattle(session) {
  if (!session) return;
  session.game.over = true;
  session.human.cancel();
  if (session.online) session.online.net.close();
}

export function HowToPlayPk({ onClose }) {
  return (
    <Modal label="How to play" onClose={onClose}>
      <h2>How to play</h2>
      <div className="help">
        <section><h3>Goal</h3><p>Take all 6 of your Prize cards by Knocking Out your opponent's Pokémon (Pokémon ex give 2, Mega Evolution ex give 3), or leave your opponent with no Pokémon in play, or with no cards to draw.</p></section>
        <section><h3>Your turn</h3><p>Draw, then in any order: put Basic Pokémon on your Bench, evolve, attach <b>one</b> Energy, play any Items, <b>one</b> Supporter and one Stadium, use Abilities and Retreat once. Then attack, which ends your turn. The player who goes first can't attack or play a Supporter on their first turn.</p></section>
        <section><h3>Playing cards</h3><p>Glowing cards in your hand can be played: click them. Energy, Tools and Evolutions then ask which Pokémon to put them on. Attacks, Retreat and Abilities are buttons in the bar across the middle of the table. Point at any card to read it in the side panel.</p></section>
        <section><h3>Playing a friend</h3><p>Pick your deck, choose <b>Play with friends</b>, make a room and send your friend the invite link. They pick their own deck and take the second seat, then you start the battle. Anyone else who opens the link can watch. If a connection drops, opening the link again puts that player back in their seat where the battle left off.</p></section>
        <section><h3>Your own decks</h3><p>Choose <b>+ Build a deck</b> to make your own, or <b>Edit a copy</b> of any tournament deck, or paste a list from Pokémon TCG Live or Limitless. A deck has exactly 60 cards, up to 4 cards with the same name (basic Energy as many as you like) and at least one Basic Pokémon. Your decks save on this device and play against the computer and with friends.</p></section>
        <section><h3>Damage</h3><p>Weakness doubles damage and Resistance takes 30 off, for the Active Pokémon only. Asleep and Paralyzed Pokémon can't attack or retreat, Confused ones may hurt themselves, and Poison and Burns add damage between turns.</p></section>
      </div>
      <div className="row"><button className="btn ghost" onClick={() => { resetTips('pk'); onClose(); }}>Show tips again</button><button className="btn primary" onClick={onClose}>Got it</button></div>
    </Modal>
  );
}

export function PokemonApp({ onHome }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [session, setSession] = useState(null);
  // browser tests can read the battle (window.__paExpose)
  if (typeof window !== 'undefined' && window.__paExpose) window.__pkSession = session;
  const [help, setHelp] = useState(false);
  const [api, setApi] = useState(undefined);
  const [room, setRoom] = useState(null);
  const [invite] = useState(pkRoomFromHash);
  const [mode, setMode] = useState(() => invite ? 'friends' : (safeStorage.getItem('pk-mode') || 'solo'));
  const [toast, setToast] = useState(null);
  const [builder, setBuilder] = useState(null);     // { id, from } while the deck builder is open
  const [mineVersion, setMineVersion] = useState(0);
  useEffect(() => {
    (async () => {
      try {
        const [cards, decks] = await Promise.all([fetchJSON('data/ptcg/cards.json'), fetchJSON('data/ptcg/decks.json')]);
        setData({ cards, decks });
      } catch (e) { setError(e.message); }
    })();
    initPkImages().then(ok => { if (ok) preloadPk(); });
    roomApi().then(a => setApi(a || null));
  }, []);
  useEffect(() => { safeStorage.setItem('pk-mode', mode); }, [mode]);
  // your own decks join the tournament decks everywhere decks are listed or looked up
  const all = useMemo(() => {
    if (!data) return null;
    const mine = loadCustomDecks().map(d => ({ ...d, ...deckLook(d, data.cards), ready: deckReady(d, data.cards) }));
    return { ...data, decks: [...mine, ...data.decks] };
  }, [data, mineVersion]);
  // a replay picked on the home screen
  useEffect(() => {
    if (!all) return;
    let id = null;
    try { id = sessionStorage.getItem('pa-open-replay'); sessionStorage.removeItem('pa-open-replay'); } catch { /* storage blocked */ }
    const rep = id && loadReplay(id);
    if (rep && rep.kind === 'pk') setSession(newReplayBattle(all, { ...rep, id }));
  }, [data]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 4000); return () => clearTimeout(t); }, [toast]);
  useSyncExternalStore(room ? room.subscribe : (() => () => {}), room ? room.getVersion : (() => 0));
  // leaving the Pokémon side: stop the battle and leave the room
  const latest = React.useRef({});
  latest.current = { session, room };
  useEffect(() => () => { endBattle(latest.current.session); if (latest.current.room) latest.current.room.leave(); }, []);

  const lobbyDeck = () => { try { return JSON.parse(safeStorage.getItem('pk-lobby') || '{}').mine; } catch { return null; } };
  const ensureRoom = (nick) => {
    safeStorage.setItem('pa-nick', nick);
    if (room) { room.setNick(nick); return room; }
    const r = new RoomClient(api, { cid: storedId(), nick, deck: lobbyDeck() || data.decks[0].id, kind: 'pk', storage: safeStorage, avatar: myAvatar() });
    setRoom(r);
    return r;
  };
  const onCreate = async (nick) => { const r = ensureRoom(nick); if (await r.create()) setHash('pk-' + r.code); };
  const onJoin = async (code, nick) => { const r = ensureRoom(nick); if (await r.join(code)) setHash('pk-' + code); };
  const onLeave = async () => {
    if (session && session.online) { endBattle(session); setSession(null); }
    if (room) await room.leave();
    setRoom(null);
    setHash('pokemon');
  };

  // an invite link: join the room in it (straight away when we know your name)
  useEffect(() => {
    if (!data || !api || room || !isRoomCode(invite)) return;
    const nick = safeStorage.getItem('pa-nick');
    if (nick) onJoin(invite, nick);
  }, [data, api]);

  // decks of their own other people brought to the room (each checked: cards this browser has, by the rules)
  if (room && data) for (const m of room.members().values()) if (m.presence.dk) registerPacked(m.presence.dk, data.cards);

  // start, follow and end online battles as the host's config changes (once this browser holds every seat's deck)
  const cfg = room && room.cfg;
  const decksKnown = !!(all && cfg && cfg.seats.every(s => !s.c || (s.d && findDeck(all.decks, s.d))));
  // browser tests only (__pkAutoplay = 0: the battle without a computer player in your seat)
  if (typeof window !== 'undefined' && window.__pkAutoplay != null) window.__pkDebug = { room, session };
  useEffect(() => {
    if (!all || !room || !cfg) return;
    const cur = session && session.online;
    if (session && !cur) return; // playing the computer: the lobby offers "Rejoin" afterwards
    if (cur && cur.game === cfg.game && cfg.started) return;
    if (cur) {
      // a finished battle stays on screen until it's closed
      if (!cfg.started && session.game.over) return;
      // the host ended this battle, or started the next one (a rematch): players and watchers move on to it
      const unfinished = !session.game.over;
      endBattle(session); setSession(null);
      if (!cfg.started) { if (unfinished) setToast('The host ended the battle.'); return; }
    }
    if (cfg.started && decksKnown && (room.mySeat() >= 0 || cur) && (cfg.game !== room.lastAutoStart || cur)) { room.lastAutoStart = cfg.game; setBuilder(null); setSession(newOnlineBattle(all, room, cfg)); }
  }, [all, room, cfg && cfg.game, cfg && cfg.started, decksKnown]);
  // a copy of the battle that drifted from the host's rebuilds itself from the host's history
  useEffect(() => watchDesync(session, room, () => { endBattle(session); setSession(newOnlineBattle(all, room, room.cfg)); }), [session]);

  if (error) return <div className="app pk"><div className="loading"><h2>Couldn't load the Pokémon cards</h2><p>{error}</p><button className="btn" onClick={onHome}>Back</button></div></div>;
  if (!data) return <div className="app pk"><div className="loading"><div className="label">Shuffling decks</div><div className="bar"><i style={{ width: '60%' }} /></div></div></div>;

  const online = {
    api, room, mode, setMode, invite, nick: safeStorage.getItem('pa-nick') || '', decksKnown,
    onCreate, onJoin, onLeave,
    onStart: () => {
      // names are made unique so the log reads clearly
      const seats = room.cfg.seats.map((s, i) => ({ ...s, n: i && s.n === room.cfg.seats[0].n ? s.n + ' II' : s.n }));
      room.start({ seed: (Math.random() * 2 ** 32) >>> 0, seats });
    },
    onWatch: () => { if (!decksKnown) return; room.lastAutoStart = room.cfg.game; setSession(newOnlineBattle(all, room, room.cfg)); },
    onDeck: id => {
      if (!room) return;
      // your own deck travels with you, its seat naming exactly this version of it (not on claude.ai, whose room
      // messages are too small for a decklist); one that isn't finished stays home
      const d = findDeck(all.decks, id);
      const ok = !!d && (!d.custom || (deckReady(d, data.cards) && !onClaude()));
      const st = savedStyle('pk', id);
      room.setExtra({ dk: ok && d.custom ? packDeck(d) : null, sl: st.s, bx: st.b });
      room.setDeck(ok ? deckRef(d) : null);
    },
  };
  const toastEl = toast ? <div className="toast" role="status">{toast}</div> : null;
  const mineChanged = () => setMineVersion(v => v + 1);
  if (builder && !session) return <PkDeckBuilder data={all} editId={builder.id} fromId={builder.from} onHome={onHome}
    onDone={() => { setBuilder(null); mineChanged(); }}
    onPlay={deck => { try { const s = JSON.parse(safeStorage.getItem('pk-lobby') || '{}'); safeStorage.setItem('pk-lobby', JSON.stringify({ ...s, mine: deck.id })); } catch { /* storage blocked */ } setBuilder(null); mineChanged(); }} />;
  if (!session) return <>
    <PkLobby key={mineVersion} data={all} online={online} onStart={cfg => setSession(newBattle(all, cfg))} onHome={onHome} onHelp={() => setHelp(true)}
      onBuild={(id, from) => setBuilder({ id, from })} onDelete={id => { deleteCustomDeck(id); mineChanged(); }} />
    {help ? <HowToPlayPk onClose={() => setHelp(false)} /> : null}
    {toastEl}
  </>;
  const back = () => {
    // the host leaving a battle in progress ends it for everyone; a finished one just closes
    if (session.online && room && room.isHost && room.cfg.started) room.stop();
    endBattle(session); setSession(null);
  };
  const host = !!(session.online && room && room.isHost);
  return <>
    <Battle key={`${session.game.seed}:${session.online ? session.online.game : ''}`} session={session} host={host}
      onExit={back} onLobby={back}
      onReplay={id => { const rep = loadReplay(id); if (!rep) return; endBattle(session); setSession(newReplayBattle(all, { ...rep, id })); }}
      onRematch={() => {
        if (session.online) { if (host) online.onStart(); return; }
        endBattle(session); setSession(newBattle(all, session.cfg));
      }} />
    {toastEl}
  </>;
}
