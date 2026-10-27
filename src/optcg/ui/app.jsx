// The One Piece side of the site: load the starter decks and their cards, then lobby <-> battle (and the deck builder).
import { OnePieceGame } from '../game.js';
import { OnePieceAI } from '../ai.js';
import { OpHuman } from './human.js';
import { OpLobby } from './lobby.jsx';
import { OpBattle } from './battle.jsx';
import { OpBuilder } from './builder.jsx';
import { HowToPlayOp } from './howto.jsx';
import { initOpImages } from './images.js';
import { baseDeckId, deckOfSeat } from './decks.js';
import { isCustomId, customDeck, packDeck, unpackDeck, rememberDeck } from './mydecks.js';
import { createStore, loadSettings, fetchJSON, safeStorage } from '../../ui/common.js';
import { makePace } from '../../ui/pacing.js';
import { Lockstep, LocalSeatAgent, RemoteSeatAgent } from '../../net/lockstep.js';
import { RoomClient, roomApi, isRoomCode } from '../../net/roomclient.js';
import { Recorder, ReplayControl, ReplayAgent, opDelay, loadReplay } from '../../ui/records.js';
import { myAvatar } from '../../ui/avatar.jsx';
import { savedStyle } from '../../ui/deckstyle.jsx';

const { useState, useEffect, useSyncExternalStore } = React;

// a One Piece room invite in the address: #op-abc123
export const opRoomFromHash = () => { const m = /^op-([a-z0-9]{6})$/.exec(location.hash.slice(1)); return m ? m[1] : null; };
const setHash = h => { try { history.replaceState(null, '', '#' + h); } catch { /* sandboxed frame */ } };

function storedId() {
  let id = safeStorage.getItem('pa-cid');
  if (!id) { id = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6); safeStorage.setItem('pa-cid', id); }
  return id;
}

function newBattle(data, cfg) {
  const store = createStore();
  const settings = loadSettings();
  const human = new OpHuman(() => store.bump());
  const ai = new OnePieceAI({ pace: makePace(settings) });
  let agent = human;
  // browser tests: a computer player takes your seat for the first N turns (window.__opAutoplay)
  if (typeof window !== 'undefined' && window.__opAutoplay) {
    const bot = new OnePieceAI();
    agent = { ask: (g, pid, req) => (g.turn < window.__opAutoplay ? bot.ask(g, pid, req) : human.ask(g, pid, req)) };
  }
  const game = new OnePieceGame({
    db: data.cards, onUpdate: () => store.bump(),
    players: [{ name: 'You', deck: cfg.mine, agent, human: true }, { name: cfg.opp.name, deck: cfg.opp, agent: ai }],
  });
  // every decision is recorded so the battle can be replayed (ui/records.js)
  const recorder = new Recorder();
  game.agents = game.agents.map(a => recorder.wrap(a));
  game.start().then(() => store.bump(), e => { console.error(e); store.bump(); });
  return { game, human, ai, store, settings, cfg, me: 0, recorder, decks: [cfg.mine, cfg.opp] };
}

// a deck as a list that travelled with it (a replay, a battle's config), else by its id
const deckFrom = (data, packed, id) => deckOfSeat(data, packed, id) || data.decks[0];

// watching a replay: the same seed and decks, both seats answering from the recorded decisions
function newReplayBattle(data, rep) {
  const store = createStore();
  const human = new OpHuman(() => store.bump());
  const ctl = new ReplayControl(rep.log.length, () => store.bump());
  const agent = new ReplayAgent(rep.log, ctl, null, opDelay);
  const game = new OnePieceGame({
    db: data.cards, seed: rep.seed, onUpdate: () => store.bump(), maxTurns: rep.maxTurns || 60,
    // (your own deck may have changed since: the replay keeps the list it was played with)
    players: rep.players.map(p => ({ name: p.name, deck: deckFrom(data, p.opDeck, p.deckId), agent, human: p.human })),
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
  const human = new OpHuman(() => store.bump());
  const net = new Lockstep({ channel: room.room, cid: room.cid, nick: room.nick, cfg, seat: me, onChange: () => store.bump(), storage: safeStorage });
  const isHost = cfg.host === room.cid;
  let inner = human;
  // browser tests: a computer player makes your decisions for the first N turns (window.__opAutoplay)
  if (typeof window !== 'undefined' && window.__opAutoplay) {
    const bot = new OnePieceAI();
    inner = { ask: (g, pid, req) => (g.turn < window.__opAutoplay ? bot.ask(g, pid, req) : human.ask(g, pid, req)) };
  }
  // the host's computer player stands in for a friend who left, once the host asks it to
  const agents = cfg.seats.map((s, pid) => pid === me ? new LocalSeatAgent(net, inner, null, null) : new RemoteSeatAgent(net, null, isHost ? new OnePieceAI({ pace: makePace(settings) }) : null));
  // player names only appear in text, so each browser can call its own player "You". A player's own deck comes from
  // the list the host wrote into the config, so every browser plays the identical deck.
  const decks = cfg.seats.map(s => deckFrom(data, s.dk, s.d));
  const players = cfg.seats.map((s, pid) => ({ name: pid === me ? 'You' : s.n || `Player ${pid + 1}`, deck: decks[pid], agent: agents[pid], human: true }));
  const game = new OnePieceGame({ db: data.cards, seed: cfg.seed, players, onUpdate: () => store.bump() });
  game.start().then(() => store.bump(), e => { console.error(e); store.bump(); });
  return { game, human, store, settings, cfg, me: me == null ? 0 : me, spectator: me == null, online: { net, code: cfg.code, game: cfg.game }, decks };
}

// the deck you bring to a room: its id, sleeves and box, and (one of your own) its list, which the host writes into the
// battle's config when it starts. While a battle is on, the config carries it, so it leaves your presence (room
// messages are small and the battle's moves need the room).
function sendDeck(room, id) {
  if (!room) return;
  room.setDeck(id);
  const d = isCustomId(id) && customDeck(id);
  const st = savedStyle('op', baseDeckId(id));
  room.setExtra({ dk: d && !(room.cfg && room.cfg.started) ? packDeck(d) : null, sl: st.s, bx: st.b });
}

function endBattle(session) {
  if (!session) return;
  session.game.over = true;
  session.human.cancel();
  if (session.online) session.online.net.close();
}

export function OnePieceApp({ onHome }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [session, setSession] = useState(null);
  const [help, setHelp] = useState(false);
  const [api, setApi] = useState(undefined);
  const [room, setRoom] = useState(null);
  const [invite] = useState(opRoomFromHash);
  const [mode, setMode] = useState(() => invite ? 'friends' : (safeStorage.getItem('op-mode') || 'solo'));
  const [toast, setToast] = useState(null);
  const [builder, setBuilder] = useState(null);       // { id, from } while the deck builder is open
  const [decksVersion, setDecksVersion] = useState(0);
  useEffect(() => {
    (async () => {
      try {
        const [cards, decks] = await Promise.all([fetchJSON('data/optcg/cards.json'), fetchJSON('data/optcg/decks.json')]);
        setData({ cards, decks });
      } catch (e) { setError(e.message); }
    })();
    initOpImages();
    roomApi().then(a => setApi(a || null));
  }, []);
  useEffect(() => { safeStorage.setItem('op-mode', mode); }, [mode]);
  // a replay picked on the home screen
  useEffect(() => {
    if (!data) return;
    let id = null;
    try { id = sessionStorage.getItem('pa-open-replay'); sessionStorage.removeItem('pa-open-replay'); } catch { /* storage blocked */ }
    const rep = id && loadReplay(id);
    if (rep && rep.kind === 'op') setSession(newReplayBattle(data, { ...rep, id }));
  }, [data]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 4000); return () => clearTimeout(t); }, [toast]);
  useSyncExternalStore(room ? room.subscribe : (() => () => {}), room ? room.getVersion : (() => 0));
  // leaving the One Piece side: stop the battle and leave the room
  const latest = React.useRef({});
  latest.current = { session, room };
  useEffect(() => () => { endBattle(latest.current.session); if (latest.current.room) latest.current.room.leave(); }, []);

  const lobbyDeck = () => { try { return JSON.parse(safeStorage.getItem('op-lobby') || '{}').mine; } catch { return null; } };
  const ensureRoom = (nick) => {
    safeStorage.setItem('pa-nick', nick);
    if (room) { room.setNick(nick); return room; }
    const r = new RoomClient(api, { cid: storedId(), nick, deck: lobbyDeck() || data.decks[0].id, kind: 'op', storage: safeStorage, avatar: myAvatar() });
    setRoom(r);
    return r;
  };
  const onCreate = async (nick) => { const r = ensureRoom(nick); if (await r.create()) setHash('op-' + r.code); };
  const onJoin = async (code, nick) => { const r = ensureRoom(nick); if (await r.join(code)) setHash('op-' + code); };
  const onLeave = async () => {
    if (session && session.online) { endBattle(session); setSession(null); }
    if (room) await room.leave();
    setRoom(null);
    setHash('onepiece');
  };

  // an invite link: join the room in it (straight away when we know your name)
  useEffect(() => {
    if (!data || !api || room || !isRoomCode(invite)) return;
    const nick = safeStorage.getItem('pa-nick');
    if (nick) onJoin(invite, nick);
  }, [data, api]);

  // start, follow and end online battles as the host's config changes
  const cfg = room && room.cfg;
  // others' own decks: from their presence before a battle, and from the config (the decks in play) during one
  if (room) {
    for (const m of room.members().values()) if (m.presence.dk && !m.me) rememberDeck(unpackDeck(m.presence.dk));
    if (cfg && cfg.started) for (const s of cfg.seats) if (s.dk && s.c !== room.cid) rememberDeck(unpackDeck(s.dk));
  }
  // a battle starting or ending: your deck's list leaves or rejoins your presence
  useEffect(() => { if (room && cfg) sendDeck(room, room.deck); }, [room, cfg && cfg.started]);
  // browser tests only (__opAutoplay = 0: the battle without a computer player in your seat)
  if (typeof window !== 'undefined' && window.__opAutoplay != null) window.__opDebug = { room, session };
  useEffect(() => {
    if (!data || !room || !cfg) return;
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
    if (cfg.started && (room.mySeat() >= 0 || cur) && (cfg.game !== room.lastAutoStart || cur)) { room.lastAutoStart = cfg.game; setSession(newOnlineBattle(data, room, cfg)); }
  }, [data, room, cfg && cfg.game, cfg && cfg.started]);

  if (error) return <div className="app op"><div className="loading"><h2>Couldn't load the One Piece cards</h2><p>{error}</p><button className="btn" onClick={onHome}>Back</button></div></div>;
  if (!data) return <div className="app op"><div className="loading"><div className="label">Raising the sails</div><div className="bar"><i style={{ width: '60%' }} /></div></div></div>;

  const online = {
    api, room, mode, setMode, invite, nick: safeStorage.getItem('pa-nick') || '',
    onCreate, onJoin, onLeave,
    onStart: () => {
      // names are made unique so the log reads clearly; a player's own deck goes into the config as a list, so every
      // browser builds the battle from the same one (even if they change their deck later)
      const members = room.members();
      const seats = room.cfg.seats.map((s, i) => {
        // (the list the player sends now, else the one this browser knows)
        const sent = s.c && members.has(s.c) && unpackDeck(members.get(s.c).presence.dk);
        const d = isCustomId(s.d) ? (sent && sent.id === s.d ? sent : customDeck(s.d)) : null;
        const { dk, ...rest } = s;
        return { ...rest, n: i && s.n === room.cfg.seats[0].n ? s.n + ' II' : s.n, ...(d ? { dk: packDeck(d) } : {}) };
      });
      room.start({ seed: (Math.random() * 2 ** 32) >>> 0, seats });
    },
    onWatch: () => { room.lastAutoStart = room.cfg.game; setSession(newOnlineBattle(data, room, room.cfg)); },
    onDeck: id => sendDeck(room, id),
  };
  const toastEl = toast ? <div className="toast" role="status">{toast}</div> : null;
  if (builder) return <>
    <OpBuilder data={data} editId={builder.id} fromId={builder.from} onHome={onHome}
      onDone={() => { setBuilder(null); setDecksVersion(v => v + 1); }}
      onPlay={deck => {
        // back to the lobby with this deck picked
        if (deck) { try { const s = JSON.parse(safeStorage.getItem('op-lobby') || '{}'); safeStorage.setItem('op-lobby', JSON.stringify({ ...s, mine: deck.id })); } catch { /* storage blocked */ } }
        setBuilder(null); setDecksVersion(v => v + 1);
      }} />
    {toastEl}
  </>;
  if (!session) return <>
    <OpLobby key={decksVersion} data={data} online={online} onStart={cfg => setSession(newBattle(data, cfg))} onHome={onHome} onHelp={() => setHelp(true)} onBuild={(id, from) => setBuilder({ id, from })} />
    {help ? <HowToPlayOp onClose={() => setHelp(false)} /> : null}
    {toastEl}
  </>;
  const back = () => {
    // the host leaving a battle in progress ends it for everyone; a finished one just closes
    if (session.online && room && room.isHost && room.cfg.started) room.stop();
    endBattle(session); setSession(null);
  };
  const host = !!(session.online && room && room.isHost);
  return <>
    <OpBattle key={`${session.game.seed}:${session.online ? session.online.game : ''}`} session={session} host={host}
      onExit={back} onLobby={back}
      onReplay={id => { const rep = loadReplay(id); if (!rep) return; endBattle(session); setSession(newReplayBattle(data, { ...rep, id })); }}
      onRematch={() => {
        if (session.online) { if (host) online.onStart(); return; }
        endBattle(session); setSession(newBattle(data, session.cfg));
      }} />
    {toastEl}
  </>;
}
