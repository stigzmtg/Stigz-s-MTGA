// Quick emotes in friends' games. Each person's room presence carries their latest emote as [n, which]; a larger n
// is a new one, so the same emote can be sent twice. Bubbles appear over the sender's name plate for a few seconds
// (people watching show up as a line at the top).
import { play } from './sound.js';

const { useState, useEffect, useRef } = React;

export const EMOTES = [['👋', 'Hi!'], ['👍', 'Nice play!'], ['😮', 'Whoa!'], ['🤔', 'Thinking…'], ['⏳', 'One sec'], ['😅', 'Oops'], ['🎉', 'GG!']];
const SHOW_MS = 3600;

// bubbles by seat (pid -> { text, key }), watchers' emotes, and a way to send one
export function useEmotes(session) {
  const on = session.online;
  const st = useRef({ seen: new Map(), n: 0 });
  const [bubbles, setBubbles] = useState(() => new Map());
  const [watchers, setWatchers] = useState([]);
  useEffect(() => {
    if (!on) return;
    for (const [cid, { presence }] of on.net.peerState) {
      const e = presence.emo;
      const prev = st.current.seen.get(cid);
      // someone seen without an emote yet: their first one counts
      if (!Array.isArray(e) || !EMOTES[e[1]]) { if (prev == null) st.current.seen.set(cid, 0); continue; }
      st.current.seen.set(cid, Math.max(prev || 0, e[0]));
      if (prev == null || e[0] <= prev) continue;   // emotes from before we arrived don't replay
      const [icon, text] = EMOTES[e[1]];
      const key = cid + ':' + e[0];
      const pid = on.net.cfg.seats.findIndex(s => s.c === cid);
      play('emote');
      if (pid >= 0) {
        setBubbles(m => new Map(m).set(pid, { icon, text, key }));
        setTimeout(() => setBubbles(m => { if (!m.get(pid) || m.get(pid).key !== key) return m; const n = new Map(m); n.delete(pid); return n; }), SHOW_MS);
      } else {
        setWatchers(w => [...w.slice(-2), { icon, text, key, name: String(presence.nick || 'Someone').slice(0, 24) }]);
        setTimeout(() => setWatchers(w => w.filter(x => x.key !== key)), SHOW_MS);
      }
    }
  });
  const send = which => {
    if (!on) return;
    st.current.n = Math.max(st.current.n + 1, Math.floor(Date.now() / 100));
    Promise.resolve(on.net.channel.presence({ emo: [st.current.n, which] })).catch(() => {});
  };
  return { bubbles, watchers, send, online: !!on };
}

export function EmoteBubble({ b }) {
  return b ? <span key={b.key} className="emote-bubble" role="status"><span className="ei" aria-hidden="true">{b.icon}</span>{b.text}</span> : null;
}

export function WatcherEmotes({ list }) {
  return list.length ? <div className="emote-watchers" role="status">{list.map(w => <span key={w.key} className="emote-line"><b>{w.name}</b> {w.icon} {w.text}</span>)}</div> : null;
}

// the top-bar button and its picker
export function EmoteButton({ emotes }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const key = e => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', close); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', key); };
  }, [open]);
  if (!emotes.online) return null;
  return (
    <span className="emote-wrap" ref={ref}>
      <button className="btn sm icon" onClick={() => setOpen(o => !o)} aria-expanded={open} aria-label="Send an emote" title="Send an emote">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path fillRule="evenodd" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM8.5 9a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm7 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM7.5 14h9a4.5 4.5 0 0 1-9 0z" /></svg>
      </button>
      {open ? (
        <span className="emote-pick" role="menu">
          {EMOTES.map(([icon, text], i) => <button key={i} role="menuitem" onClick={() => { emotes.send(i); setOpen(false); }}><span aria-hidden="true">{icon}</span>{text}</button>)}
        </span>
      ) : null}
    </span>
  );
}
