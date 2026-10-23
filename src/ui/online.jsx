// "Play with friends": create or join a room, share the invite link, take seats, pick decks, start.
import { Pip } from './cardview.jsx';
import { findDeck } from './customdecks.js';
import { isRoomCode, onClaude } from '../net/roomclient.js';
import { AnimalAvatar, Lineup, Watchers, MyAvatarRow, AvatarButton, myAvatar } from './avatar.jsx';

const { useState } = React;

// on claude.ai, the page's own link (the page can't read it from inside its frame); on the website, this page
export const ARTIFACT_URL = 'https://claude.ai/artifact/8rchJZPk18aNQxnKKrsKts';
// kind 'pk' links to a Pokémon room (#pk-abc123); Commander rooms are the bare code
export const inviteLink = (code, kind = '') => `${onClaude() ? ARTIFACT_URL : location.origin + location.pathname}#${kind ? kind + '-' : ''}${code}`;

export function CopyLink({ code, kind = '' }) {
  const [state, setState] = useState('');
  const link = inviteLink(code, kind);
  const copy = (e) => {
    const sel = () => { const el = document.getElementById('invite-link'); if (el) { el.focus(); el.select(); } };
    try {
      navigator.clipboard.writeText(link).then(() => setState('Copied'), () => { sel(); setState('Press Ctrl+C to copy'); });
    } catch { sel(); setState('Press Ctrl+C to copy'); }
  };
  return (
    <div className="invite">
      <label className="label" htmlFor="invite-link">Invite link</label>
      <div className="invite-row">
        <input id="invite-link" className="input" readOnly value={link} onFocus={e => e.target.select()} />
        <button className="btn primary" onClick={copy}>{state === 'Copied' ? 'Copied' : 'Copy link'}</button>
      </div>
      <div className="note">{state && state !== 'Copied' ? state + '. ' : ''}Room code <b className="code">{code}</b>. Friends can also type the code under “Join a room”.</div>
    </div>
  );
}

function DeckName({ decks, id }) {
  const d = findDeck(decks, id);
  return d ? <span className="seat-deck" title={d.commanders.join(' & ')}>{d.name}</span> : <span className="seat-deck muted">Choosing a deck…</span>;
}

export function FriendsPanel({ data, api, room, deck, onCreate, onJoin, onLeave, onStart, onWatch, session }) {
  const { decks } = data;
  // an invite link (or a code typed on the home screen) puts the room code in the address
  const [code, setCode] = useState(() => (isRoomCode(location.hash.slice(1)) ? location.hash.slice(1) : ''));
  const [nick, setNick] = useState(room ? room.nick : '');
  const [busy, setBusy] = useState(false);
  const [av, setAv] = useState(() => (room && room.extra.av) || myAvatar());
  const changeAv = c => { setAv(c); if (room) room.setAvatar(c); };
  const sortedDecks = data.sortedDecks;

  if (api === undefined) return <section className="panel"><h2>Play with friends</h2><p className="note">Connecting…</p></section>;
  if (!api) {
    return (
      <section className="panel" aria-label="Play with friends">
        <h2>Play with friends</h2>
        <p className="note">{onClaude() ? 'Rooms need the page opened on claude.ai, signed in. Open this game’s claude.ai link (not a downloaded copy) to create or join a room.' : 'Couldn’t reach the room server from here. Check your connection and reload the page.'}</p>
      </section>
    );
  }

  const inRoom = room && room.code;
  if (!inRoom) {
    const go = async (fn) => { setBusy(true); try { await fn(); } finally { setBusy(false); } };
    const err = room && room.error;
    return (
      <section className="panel" aria-label="Play with friends">
        <h2>Play with friends</h2>
        <div className="friends-form">
          <div className="nick-row">
            <AvatarButton code={av} onChange={changeAv} />
            <div>
              <label className="label" htmlFor="nick">Your name</label>
              <input id="nick" className="input" maxLength={24} value={nick} placeholder="Name shown to other players" onChange={e => setNick(e.target.value)} />
            </div>
          </div>
          <div className="friends-actions">
            <button className="btn primary" disabled={busy || !nick.trim()} onClick={() => go(() => onCreate(nick.trim()))}>Create a room</button>
          </div>
          <div className="or"><span>or join one</span></div>
          <label className="label" htmlFor="room-code">Room code</label>
          <div className="invite-row">
            <input id="room-code" className="input" maxLength={6} value={code} placeholder="6 letters or digits" onChange={e => setCode(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, ''))} />
            <button className="btn" disabled={busy || !isRoomCode(code) || !nick.trim()} onClick={() => go(() => onJoin(code, nick.trim()))}>Join</button>
          </div>
          {err ? <p className="warnline">{err === 'not_permitted' ? 'This page can’t open rooms for you. Ask the owner to share it with you by email from the Share menu.' : 'Couldn’t reach the room. Check your connection and try again.'}</p> : null}
          {onClaude()
            ? <p className="note">Everyone plays in their own browser on claude.ai. Friends must be signed in and invited to this page from its Share menu (by email; a public link can’t join rooms). Each person picks their own deck from the list.</p>
            : <p className="note">Everyone plays in their own browser; no account needed. Send friends the invite link and each picks their own deck. Rooms run through this site’s own server, so they work on school and office Wi-Fi too.</p>}
        </div>
      </section>
    );
  }

  const cfg = room.cfg;
  const members = room.members();
  const isHost = room.isHost;
  const mySeat = room.mySeat();
  if (!cfg) return <section className="panel"><h2>Room {room.code}</h2><p className="note">Looking for the host… If nobody created room <b>{room.code}</b>, check the code.</p><div className="dlg-actions"><button className="btn ghost" onClick={onLeave}>Leave room</button></div></section>;
  const seated = new Set(cfg.seats.filter(s => s.c).map(s => s.c));
  const watchers = [...members.values()].filter(m => !seated.has(m.cid));
  const humanSeats = cfg.seats.filter(s => s.k === 'h');
  const ready = cfg.seats.length >= 2 && humanSeats.every(s => s.c && members.has(s.c) && s.d && findDeck(decks, s.d));
  const hostNick = (members.get(cfg.host) || {}).nick || 'the host';
  const inGame = cfg.started;

  return (
    <section className="panel room" aria-label={`Room ${room.code}`}>
      <div className="room-head">
        <h2>Room {room.code}</h2>
        <span className="chip">{members.size} here</span>
        {isHost ? <span className="chip gold">You host</span> : null}
      </div>
      <CopyLink code={room.code} />
      <Lineup seats={cfg.seats} cid={room.cid} host={cfg.host} />
      {isHost && !inGame ? (
        <div className="filters"><span className="label">Seats</span>
          <div className="seg" role="group" aria-label="Number of seats">{[2, 3, 4].map(n => <button key={n} className={cfg.seats.length === n ? 'on' : ''} onClick={() => room.setSeatCount(n)}>{n}</button>)}</div>
        </div>
      ) : null}
      <ol className="seats">
        {cfg.seats.map((s, i) => {
          const m = s.c ? members.get(s.c) : null;
          const mine = s.c === room.cid;
          return (
            <li key={i} className={`seat-row ${mine ? 'mine' : ''} ${s.k === 'a' ? 'ai' : ''}`}>
              {s.k === 'h' && s.c ? <AnimalAvatar code={s.a} size={34} /> : <span className="seat-no">{i + 1}</span>}
              <span className="seat-who">
                {s.k === 'a' ? <b>AI player</b> : s.c ? <b>{s.n || 'Player'}{s.c === cfg.host ? ' (host)' : ''}{mine ? ' · you' : ''}</b> : <b className="muted">Open seat</b>}
                {s.k === 'a' ? (isHost && !inGame ? (
                  <select id={`ai-deck-${i}`} className="input sm" value={s.d || 'random'} onChange={e => room.setSeat(i, { d: e.target.value })}>
                    <option value="random">Random precon</option>
                    {sortedDecks.filter(d => !d.custom).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                ) : <span className="seat-deck">{s.d && s.d !== 'random' ? (decks.find(d => d.id === s.d) || {}).name : 'Random precon'}</span>) : s.c ? <DeckName decks={decks} id={s.d} /> : <span className="seat-deck muted">Waiting for a friend</span>}
              </span>
              <span className="seat-act">
                {s.k === 'h' && s.c && !m ? <span className="chip">away</span> : null}
                {!inGame && isHost && i > 0 ? (
                  <select id={`seat-kind-${i}`} className="input sm" aria-label={`Seat ${i + 1}`} value={s.k === 'a' ? 'ai' : 'friend'} onChange={e => room.setSeat(i, e.target.value === 'ai' ? { k: 'a', c: null, n: '', d: 'random' } : { k: 'h', c: null, n: '', d: null })}>
                    <option value="friend">Friend</option><option value="ai">AI</option>
                  </select>
                ) : null}
                {!inGame && isHost && i > 0 && s.k === 'h' && s.c ? <button className="btn sm ghost" onClick={() => room.setSeat(i, { c: null, n: '', d: null, a: null })}>Open seat</button> : null}
                {!inGame && !isHost && s.k === 'h' && !s.c ? <button className="btn sm" onClick={() => room.sit(i)}>Sit here</button> : null}
                {!inGame && !isHost && mine ? <button className="btn sm ghost" onClick={() => room.stand()}>Stand up</button> : null}
              </span>
            </li>
          );
        })}
      </ol>
      <Watchers list={watchers} />
      <MyAvatarRow code={av} onChange={changeAv} />
      <p className="note">Your deck: <b>{deck.name}</b> — pick another from the list.{deck.custom && onClaude() ? ' Custom decks can only be used in rooms on the website, not on claude.ai.' : ''}</p>
      <div className="dlg-actions">
        <button className="btn ghost" onClick={onLeave}>Leave room</button>
        {inGame ? (
          session ? null : <button className="btn primary" onClick={onWatch}>{mySeat >= 0 ? 'Rejoin the game' : 'Watch the game'}</button>
        ) : isHost ? (
          <button className="btn primary" disabled={!ready} onClick={onStart} title={ready ? '' : 'Every friend seat needs a player who is here'}>Start game</button>
        ) : (
          <span className="note">{mySeat >= 0 ? `Waiting for ${hostNick} to start…` : 'Take an open seat, or stay to watch.'}</span>
        )}
      </div>
    </section>
  );
}

// in-game: room status and who we're waiting on
export function RoomStatus({ session }) {
  const on = session.online;
  if (!on) return null;
  const net = on.net;
  const w = net.waitingOn();
  const seat = w ? session.game.players[w.pid] : null;
  const catching = net.catchingUp();
  return (
    <span className="roomstatus">
      <span className="chip" title={`Room ${on.code}`}>Room {on.code}</span>
      {catching ? <span className="chip">Catching up…</span> : null}
      {session.spectator ? <span className="chip">Watching</span> : null}
      {w && w.seconds >= 2 && seat ? <span className={`chip ${w.present ? '' : 'danger'}`}>{w.present ? `Waiting for ${seat.name}` : `${seat.name} is away`}</span> : null}
      {w && !w.present && w.seconds >= 8 && net.isHost && seat ? <button className="btn sm" onClick={() => net.setSubstitute(w.pid, w.seq)}>Let the AI play for {seat.name}</button> : null}
    </span>
  );
}
