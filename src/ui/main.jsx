// App entry: load data, lobby <-> game sessions.
import { CardDB } from '../engine/cards.js';
import { Game } from '../engine/game.js';
import { AIAgent } from '../ai/ai.js';
import { HumanAgent } from './human.js';
import { Lobby } from './lobby.jsx';
import { GameView } from './table.jsx';
import { initImages, preloadDecks } from './images.js';
import { Lockstep, LocalSeatAgent, RemoteSeatAgent, HostAIAgent } from '../net/lockstep.js';
import { RoomClient, roomApi, isRoomCode } from '../net/roomclient.js';
import { applyOp } from './manual.js';

const { useState, useEffect, useSyncExternalStore } = React;

const DEFAULT_SETTINGS = { aiSpeed: 'normal', stopOppEnd: true, stopOppCombat: true, stopOwnCombat: false, stopForOpponentSpells: true, fullControl: false, autoCommander: true, images: true };
const SPEED = { slow: 900, normal: 450, fast: 160, instant: 0 };

function loadSettings() { try { return { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem('pa-settings') || '{}')) }; } catch { return { ...DEFAULT_SETTINGS }; } }
function saveSettings(s) { try { localStorage.setItem('pa-settings', JSON.stringify(s)); } catch { /* storage unavailable */ } }

function createStore() {
  let v = 0, scheduled = false;
  const subs = new Set();
  const tick = () => { scheduled = false; v++; subs.forEach(f => f()); };
  return {
    get: () => v,
    subscribe: f => { subs.add(f); return () => subs.delete(f); },
    bump() {
      if (scheduled) return;
      scheduled = true;
      if (typeof requestAnimationFrame === 'function' && !document.hidden) requestAnimationFrame(tick); else setTimeout(tick, 16);
    },
  };
}

function shortName(n) { return n.split(',')[0].split(' // ')[0]; }

function newSession(data, cfg) {
  const store = createStore();
  const settings = loadSettings();
  const human = new HumanAgent(() => store.bump(), settings);
  const ais = cfg.opps.map(() => new AIAgent({ delay: SPEED[settings.aiSpeed] ?? 450 }));
  const used = new Set();
  const players = [{ name: 'You', deck: cfg.mine, agent: human, human: true }, ...cfg.opps.map((d, i) => {
    let nm = shortName(d.commanders[0]);
    if (used.has(nm)) nm += ` ${i + 1}`;
    used.add(nm);
    return { name: nm, deck: d, agent: ais[i] };
  })];
  const game = new Game({ db: data.db, players, onUpdate: () => store.bump(), maxTurns: 400 });
  game.continueAfterHumanLoss = false;
  human.pid = 0;
  const session = {
    game, human, store, settings, ais, cfg,
    setSettings(s) { Object.assign(settings, s); human.settings = settings; for (const a of ais) a.delay = SPEED[s.aiSpeed] ?? 450; saveSettings(settings); },
  };
  // browser tests: let an AI play your seat for the first N turns (set window.__paAutoplay before load)
  if (typeof window !== 'undefined' && window.__paAutoplay) {
    const bot = new AIAgent({ delay: 0 });
    const humanTypes = window.__paHumanTypes;
    game.agents[0] = { ask: (g, pid, req) => (g.turnNumber < window.__paAutoplay || (humanTypes && !humanTypes.includes(req.type)) ? bot.ask(g, pid, req) : human.ask(g, pid, req)) };
  }
  preloadDecks([cfg.mine.id, ...cfg.opps.map(d => d.id)]);
  game.start().then(() => store.bump());
  return session;
}

function endSession(session) {
  if (!session) return;
  session.game.over = true;
  session.human.cancelAll();
  if (session.online) session.online.net.close();
}

const safeStorage = {
  getItem(k) { try { return localStorage.getItem(k); } catch { return null; } },
  setItem(k, v) { try { localStorage.setItem(k, v); } catch { /* storage full or blocked */ } },
};
function storedId() {
  let id = safeStorage.getItem('pa-cid');
  if (!id) { id = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6); safeStorage.setItem('pa-cid', id); }
  return id;
}

// host: fix the seating for a new game (AI decks drawn, names made unique)
function seatsForStart(data, cfg) {
  const used = new Set(cfg.seats.map(s => s.d).filter(d => d && d !== 'random'));
  const names = new Set();
  return cfg.seats.map(s => {
    let d = s.d;
    if (s.k === 'a' && (!d || d === 'random')) { const pool = data.decks.filter(x => !used.has(x.id)); d = pool[Math.floor(Math.random() * pool.length)].id; used.add(d); }
    let n = s.k === 'a' ? shortName(data.decks.find(x => x.id === d).commanders[0]) : (s.n || 'Player');
    while (names.has(n)) n += ' II';
    names.add(n);
    return { ...s, d, n };
  });
}

// an online game: every browser runs the same game; decisions travel through the room (see net/lockstep.js)
function newOnlineSession(data, room, cfg) {
  const store = createStore();
  const settings = loadSettings();
  const seat = cfg.seats.findIndex(s => s.k === 'h' && s.c === room.cid);
  const me = seat >= 0 ? seat : null;
  const human = new HumanAgent(() => store.bump(), settings);
  const net = new Lockstep({ channel: room.room, cid: room.cid, nick: room.nick, cfg, seat: me, onChange: () => store.bump(), storage: safeStorage });
  const online = { net, code: cfg.code, game: cfg.game, pendingOps: [] };
  const takeOps = () => { const o = online.pendingOps; online.pendingOps = []; return o; };
  const isHost = cfg.host === room.cid;
  const delay = () => SPEED[settings.aiSpeed] ?? 450;
  const ais = [];
  const mkAI = () => { const a = new AIAgent({ delay: delay() }); ais.push(a); return a; };
  // browser tests: an AI makes your decisions for the first N turns (window.__paAutoplay)
  const localInner = typeof window !== 'undefined' && window.__paAutoplay
    ? (() => { const bot = new AIAgent({ delay: 0 }); return { ask: (g, pid, req) => (g.turnNumber < window.__paAutoplay ? bot.ask(g, pid, req) : human.ask(g, pid, req)) }; })()
    : human;
  const agents = cfg.seats.map((s, pid) => {
    if (pid === me) return new LocalSeatAgent(net, localInner, applyOp, takeOps);
    if (s.k === 'a' && isHost) return new HostAIAgent(net, mkAI());
    return new RemoteSeatAgent(net, applyOp, isHost ? mkAI() : null);
  });
  const byId = Object.fromEntries(data.decks.map(d => [d.id, d]));
  const players = cfg.seats.map((s, pid) => ({ name: s.n || `Player ${pid + 1}`, deck: byId[s.d] || data.decks[0], agent: agents[pid], human: s.k === 'h' }));
  const game = new Game({ db: data.db, seed: cfg.seed, players, onUpdate: () => store.bump(), maxTurns: 400 });
  human.pid = me != null ? me : 0;
  const session = {
    game, human, store, settings, ais, cfg, online, spectator: me == null,
    setSettings(s) { Object.assign(settings, s); human.settings = settings; for (const a of ais) a.delay = SPEED[s.aiSpeed] ?? 450; saveSettings(settings); },
  };
  preloadDecks(cfg.seats.map(s => s.d));
  game.start().then(() => store.bump());
  return session;
}

function Loading({ progress, error }) {
  return (
    <div className="app">
      <header className="topbar"><span className="brand">Precon Arena<small>Commander vs AI</small></span></header>
      <div className="loading">
        {error ? <><h2>Couldn't load the card data</h2><p>{error}</p></> : <>
          <div className="label">Shuffling {progress < 1 ? 'card data' : 'decks'}</div>
          <div className="bar"><i style={{ width: `${Math.round(progress * 100)}%` }} /></div>
          <div className="empty">Loading every Commander precon and 6,400 card scripts</div>
        </>}
      </div>
    </div>
  );
}

async function fetchJSON(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const len = +res.headers.get('content-length') || 0;
  if (!res.body || !len || !onProgress) return res.json();
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    onProgress(Math.min(1, got / len));
  }
  const all = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  return JSON.parse(new TextDecoder().decode(all));
}

function App() {
  const [data, setData] = useState(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);
  const [session, setSession] = useState(null);
  const [imagesOk, setImagesOk] = useState(false);
  const [api, setApi] = useState(undefined);
  const [room, setRoom] = useState(null);
  const [mode, setMode] = useState(() => isRoomCode(location.hash.slice(1)) ? 'friends' : (safeStorage.getItem('pa-mode') || 'solo'));
  const [toast, setToast] = useState(null);
  useEffect(() => {
    (async () => {
      try {
        const [decks, tokens, support] = await Promise.all([fetchJSON('data/decks.json'), fetchJSON('data/tokens.json'), fetchJSON('data/support.json').catch(() => ({}))]);
        const cards = await fetchJSON('data/cards.json', setProgress);
        setProgress(1);
        setData({ db: new CardDB(cards, tokens), decks, support, sortedDecks: decks.slice().sort((a, b) => a.name.localeCompare(b.name)) });
      } catch (e) { setError(e.message); }
    })();
    initImages().then(ok => setImagesOk(ok));
    roomApi().then(a => setApi(a || null));
  }, []);
  useEffect(() => { safeStorage.setItem('pa-mode', mode); }, [mode]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 4000); return () => clearTimeout(t); }, [toast]);
  useSyncExternalStore(room ? room.subscribe : (() => () => {}), room ? room.getVersion : (() => 0));

  const lobbyDeck = () => { try { const s = JSON.parse(safeStorage.getItem('pa-lobby') || '{}'); return s.mine; } catch { return null; } };
  const ensureRoom = (nick) => {
    safeStorage.setItem('pa-nick', nick);
    if (room) { room.setNick(nick); return room; }
    const r = new RoomClient(api, { cid: storedId(), nick, deck: lobbyDeck() || data.decks[0].id });
    setRoom(r);
    return r;
  };
  const onCreate = async (nick) => { const r = ensureRoom(nick); await r.create(); };
  const onJoin = async (code, nick) => { const r = ensureRoom(nick); await r.join(code); };
  const onLeave = async () => { if (session) { endSession(session); setSession(null); } if (room) await room.leave(); setRoom(null); };

  // invite links: open the friends panel and join the room in the link
  useEffect(() => {
    const code = location.hash.slice(1);
    if (!data || !api || room || !isRoomCode(code)) return;
    const nick = safeStorage.getItem('pa-nick');
    if (nick) onJoin(code, nick);
  }, [data, api]);

  // start, follow and end online games as the host's config changes
  const cfg = room && room.cfg;
  useEffect(() => {
    if (!data || !room || !cfg) return;
    const cur = session && session.online;
    if (cfg.started && !cur && room.mySeat() >= 0 && cfg.game !== room.lastAutoStart) { room.lastAutoStart = cfg.game; setSession(newOnlineSession(data, room, cfg)); }
    if (cur && (cur.game !== cfg.game || !cfg.started) && !session.game.over) { endSession(session); setSession(null); setToast('The host ended the game.'); }
  }, [data, room, cfg && cfg.game, cfg && cfg.started]);

  if (!data) return <Loading progress={progress} error={error} />;
  const onlineProps = {
    api, room, mode, setMode, onCreate, onJoin, onLeave,
    onStart: () => { room.start({ seed: (Math.random() * 2 ** 32) >>> 0, seats: seatsForStart(data, room.cfg) }); },
    onWatch: () => setSession(newOnlineSession(data, room, room.cfg)),
    onDeck: id => room && room.setDeck(id),
  };
  if (!session) return <>
    <Lobby data={data} imagesOk={imagesOk} onStart={cfg => setSession(newSession(data, cfg))} online={onlineProps} />
    {toast ? <div className="toast" role="status">{toast}</div> : null}
  </>;
  return <GameView key={`${session.game.seed}:${session.online ? session.online.game : ''}`} session={session} support={data.support} imagesOk={imagesOk}
    onExit={() => {
      if (session.online && room && room.isHost && !session.game.over) room.stop();
      else if (session.online && room && room.isHost && session.game.over) room.stop();
      endSession(session); setSession(null);
    }}
    onRematch={() => { endSession(session); setSession(newSession(data, session.cfg)); }} />;
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
