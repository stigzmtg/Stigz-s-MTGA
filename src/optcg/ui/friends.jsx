// One Piece "Play with friends": make or join a room, send the invite link, the friend takes the second seat, each
// player brings the deck picked on the left, and the host starts the battle. Others in the room watch.
import { CopyLink } from '../../ui/online.jsx';
import { isRoomCode, onClaude } from '../../net/roomclient.js';
import { ColorDot } from './colors.jsx';
import { AnimalAvatar, Lineup, Watchers, MyAvatarRow, AvatarButton, myAvatar } from '../../ui/avatar.jsx';
import { DeckBox, defaultBox } from '../../ui/deckstyle.jsx';

const { useState } = React;

// the code from whatever was typed or pasted: "abc123", "op-abc123" or a whole invite link
export const codeFromInput = v => v.toLowerCase().trim().replace(/^.*#/, '').replace(/^op-/, '').replace(/[^a-z0-9]/g, '').slice(0, 6);

function SeatDeck({ decks, id, bx }) {
  const d = decks.find(x => x.id === id);
  if (!d) return <span className="seat-deck muted">Choosing a deck…</span>;
  return <span className="seat-deck"><DeckBox code={bx || defaultBox(d.id, d.colors)} size={22} /><ColorDot colors={d.colors} size={13} /> {d.code} {d.name}</span>;
}

export function OpFriendsPanel({ data, online, deck }) {
  const { api, room, onCreate, onJoin, onLeave, onStart, onWatch, invite } = online;
  const [code, setCode] = useState(invite || '');
  const [nick, setNick] = useState(room ? room.nick : online.nick || '');
  const [busy, setBusy] = useState(false);
  const [av, setAv] = useState(() => (room && room.extra.av) || myAvatar());
  const changeAv = c => { setAv(c); if (room) room.setAvatar(c); };

  if (api === undefined) return <section className="panel"><h2>Play with friends</h2><p className="note">Connecting…</p></section>;
  if (!api) {
    return (
      <section className="panel" aria-label="Play with friends">
        <h2>Play with friends</h2>
        <p className="note">{onClaude() ? 'Rooms need the page opened on claude.ai, signed in. Open this game’s claude.ai link (not a downloaded copy) to create or join a room.' : 'Couldn’t reach the room server from here. Check your connection and reload the page.'}</p>
      </section>
    );
  }

  if (!room || !room.code) {
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
              <input id="nick" className="input" maxLength={24} value={nick} placeholder="Name shown to the other player" onChange={e => setNick(e.target.value)} />
            </div>
          </div>
          <div className="friends-actions">
            <button className="btn primary" disabled={busy || !nick.trim()} onClick={() => go(() => onCreate(nick.trim()))}>Create a room</button>
          </div>
          <div className="or"><span>or join one</span></div>
          <label className="label" htmlFor="room-code">Room code</label>
          <div className="invite-row">
            <input id="room-code" className="input" value={code} placeholder="6 letters or digits" autoComplete="off" onChange={e => setCode(codeFromInput(e.target.value))} />
            <button className="btn" disabled={busy || !isRoomCode(code) || !nick.trim()} onClick={() => go(() => onJoin(code, nick.trim()))}>Join</button>
          </div>
          {invite && !nick.trim() ? <p className="note">You were invited to room <b className="code">{invite}</b>. Type your name, then Join.</p> : null}
          {err ? <p className="warnline">{err === 'not_permitted' ? 'This page can’t open rooms for you. Ask the owner to share it with you by email from the Share menu.' : 'Couldn’t reach the room. Check your connection and try again.'}</p> : null}
          {onClaude()
            ? <p className="note">You each play in your own browser on claude.ai. Your friend must be signed in and invited to this page from its Share menu (by email; a public link can’t join rooms).</p>
            : <p className="note">You each play in your own browser, and nobody needs an account. Send your friend the invite link; each of you brings the deck you picked. Rooms run through this site’s own server, so they work on school and office Wi-Fi too.</p>}
        </div>
      </section>
    );
  }

  const cfg = room.cfg;
  if (!cfg) {
    return (
      <section className="panel" aria-label={`Room ${room.code}`}>
        <h2>Room {room.code}</h2>
        <p className="note">Looking for the host… If nobody made One Piece room <b className="code">{room.code}</b>, check the code (Commander and Pokémon room codes don’t work here).</p>
        <div className="dlg-actions"><button className="btn ghost" onClick={onLeave}>Leave room</button></div>
      </section>
    );
  }
  const members = room.members();
  const isHost = room.isHost;
  const mySeat = room.mySeat();
  const seated = new Set(cfg.seats.filter(s => s.c).map(s => s.c));
  const watchers = [...members.values()].filter(m => !seated.has(m.cid));
  const ready = cfg.seats.every(s => s.c && members.has(s.c) && s.d);
  const hostNick = (members.get(cfg.host) || {}).nick || 'the host';
  const inGame = cfg.started;
  const friend = cfg.seats[1];

  return (
    <section className="panel room op-room" aria-label={`Room ${room.code}`}>
      <div className="room-head">
        <h2>Room {room.code}</h2>
        <span className="chip">{members.size} here</span>
        {isHost ? <span className="chip gold">You host</span> : null}
        {inGame ? <span className="chip op-chip">Battle on</span> : null}
      </div>
      <CopyLink code={room.code} kind="op" />
      <Lineup seats={cfg.seats} cid={room.cid} host={cfg.host} vs />
      <ol className="seats">
        {cfg.seats.map((s, i) => {
          const m = s.c ? members.get(s.c) : null;
          const mine = s.c === room.cid;
          return (
            <li key={i} className={`seat-row ${mine ? 'mine' : ''}`}>
              {s.c ? <AnimalAvatar code={s.a} size={34} /> : <span className="seat-no">{i + 1}</span>}
              <span className="seat-who">
                {s.c ? <b>{s.n || 'Player'}{s.c === cfg.host ? ' (host)' : ''}{mine ? ' · you' : ''}</b> : <b className="muted">Open seat</b>}
                {s.c ? <SeatDeck decks={data.decks} id={s.d} bx={s.bx} /> : <span className="seat-deck muted">Waiting for a friend</span>}
              </span>
              <span className="seat-act">
                {s.c && !m ? <span className="chip">away</span> : null}
                {!inGame && isHost && i > 0 && s.c ? <button className="btn sm ghost" onClick={() => room.setSeat(i, { c: null, n: '', d: null, a: null })}>Open seat</button> : null}
                {!inGame && !isHost && !s.c ? <button className="btn sm" onClick={() => room.sit(i)}>Sit here</button> : null}
                {!inGame && !isHost && mine ? <button className="btn sm ghost" onClick={() => room.stand()}>Stand up</button> : null}
              </span>
            </li>
          );
        })}
      </ol>
      <Watchers list={watchers} />
      <MyAvatarRow code={av} onChange={changeAv} />
      {mySeat >= 0 || (!inGame && !isHost) ? <p className="note">Your deck: <b>{deck.name}</b>. Tap another deck to switch{inGame ? ' for the next battle' : ''}.</p> : null}
      <div className="dlg-actions">
        <button className="btn ghost" onClick={onLeave}>Leave room</button>
        {inGame ? (
          <button className="btn primary" onClick={onWatch}>{mySeat >= 0 ? 'Rejoin the battle' : 'Watch the battle'}</button>
        ) : isHost ? (
          <button className="btn primary" disabled={!ready} onClick={onStart} title={ready ? '' : 'Your friend needs to take seat 2'}>{ready ? 'Start battle' : friend.c ? `Waiting for ${friend.n || 'your friend'}…` : 'Waiting for a friend…'}</button>
        ) : (
          <span className="note">{mySeat >= 0 ? `Waiting for ${hostNick} to start…` : friend.c ? 'Both seats are taken. Stay to watch the battle.' : 'Take the open seat to play, or stay to watch.'}</span>
        )}
      </div>
    </section>
  );
}
