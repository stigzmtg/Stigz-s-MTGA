// The save code dialog (savecode.js does the work): make this device's code or save to it again, bring in a code
// from another device, and the copy-and-paste save text for when the save server can't be reached.
import { Modal } from './dialogs.jsx';
import { AnimalAvatar } from './avatar.jsx';
import { findRelay } from '../net/relayroom.js';
import {
  savedLink, saveStatus, subscribeSave, saveNow, fetchSave, loadCode, forgetCode, saveText, readText, loadText,
  summarize, currentSummary, showCode, normCode, isCode, saveErrorText, TEXT_PREFIX,
} from './savecode.js';
import { currentLogin } from './account.js';

const { useState, useEffect, useSyncExternalStore } = React;

const plural = (n, one, many = one + 's') => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
export function savedWhen(t) {
  if (!t) return '';
  const s = (Date.now() - t) / 1000;
  if (s < 50) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  const d = new Date(t), now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `today at ${time}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `yesterday at ${time}`;
  return `on ${d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })}`;
}

// "12 games (8 Commander, 3 Pokémon, 1 One Piece), 5 replays, 2 decks of your own, your avatar"
function What({ s }) {
  const parts = [];
  const per = [['mtg', 'Commander'], ['pk', 'Pokémon'], ['op', 'One Piece']].filter(([k]) => s[k]).map(([k, n]) => `${s[k]} ${n}`);
  if (s.games) parts.push(`${plural(s.games, 'game')}${per.length > 1 ? ` (${per.join(', ')})` : per.length ? ` of ${per[0].replace(/^\d+ /, '')}` : ''}`);
  if (s.replays) parts.push(plural(s.replays, 'replay'));
  if (s.decks) parts.push(plural(s.decks, 'deck') + ' of your own');
  if (s.avatar) parts.push('your avatar');
  if (s.sleeves) parts.push('sleeves and deck boxes');
  parts.push(parts.length ? 'settings' : 'your settings');
  return parts.length === 1 ? <>{parts[0]}</> : <>{parts.slice(0, -1).join(', ')} and {parts[parts.length - 1]}</>;
}

function statusLine(st, link) {
  if (st.state === 'saving') return 'Saving…';
  if (st.state === 'error') return st.error === 'offline' ? 'Couldn’t reach the save server just now. It tries again after your next game.' : 'The last save didn’t go through. It tries again after your next game.';
  const at = st.at || (link && link.at);
  return `Saved ${savedWhen(at)}. It saves by itself after every game.`;
}

export function SaveDialog({ onClose }) {
  useSyncExternalStore(subscribeSave, saveStatus);
  const link = savedLink();
  const st = saveStatus();
  const [online, setOnline] = useState(null);       // can this copy of the site reach the save server?
  const [input, setInput] = useState('');
  const [found, setFound] = useState(null);         // { kind: 'code' | 'text', save, sum }
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const [copied, setCopied] = useState(null);
  const [text, setText] = useState(null);
  const [textOpen, setTextOpen] = useState(false);
  const mine = currentSummary();
  const login = currentLogin();
  useEffect(() => { let live = true; findRelay().then(o => { if (live) { setOnline(!!o); if (!o) setTextOpen(true); } }); return () => { live = false; }; }, []);

  const run = async (what, f) => {
    setBusy(what); setErr(null);
    try { await f(); } catch (e) { setErr(saveErrorText(e)); }
    setBusy(null);
  };
  const make = () => run('make', () => saveNow());
  const look = e => {
    e.preventDefault();
    setFound(null);
    const v = input.trim();
    if (v.startsWith(TEXT_PREFIX)) return run('look', async () => { const s = await readText(v); setFound({ kind: 'text', save: s, sum: summarize(s.items) }); });
    if (!isCode(v)) { setErr('A save code has 8 letters and numbers, like K7QM-4ZP2.'); return; }
    if (link && normCode(v) === link.code) { setErr('That’s this device’s own code: it’s already saving here.'); return; }
    return run('look', async () => { const s = await fetchSave(v); setFound({ kind: 'code', save: s, sum: summarize(s.items) }); });
  };
  const bring = () => run('load', async () => {
    if (found.kind === 'code') await loadCode(found.save); else loadText(found.save);
    location.reload();
    await new Promise(() => {});   // (the page reloads)
  });
  // (the clipboard only takes text written while handling the click itself)
  const copy = (str, what) => {
    const done = () => { setCopied(what); setTimeout(() => setCopied(c => (c === what ? null : c)), 1800); };
    try { navigator.clipboard.writeText(str).then(done, () => setCopied('select')); } catch { setCopied('select'); }
  };
  const makeText = () => run('text', async () => setText(await saveText()));

  return (
    <Modal label="Save code" onClose={busy === 'load' ? null : onClose} cls="savedlg">
      <h2>Save code</h2>
      <p className="sub">Take your progress to another computer, tablet or phone. No account or email needed.</p>

      <section className="sv-mine" aria-label="This device's save code">
        {login ? <p className="sv-note">You’re logged in as <b>{login.user.username}</b>, so your progress saves to your account by itself. This code is your account’s save, and works on its own too.</p> : null}
        {link ? (
          <>
            <div className="sv-label">Your save code</div>
            <div className="sv-coderow">
              <output className="sv-code" aria-label={`Save code ${link.code.split('').join(' ')}`}>{showCode(link.code)}</output>
              <button className="btn sm" onClick={() => copy(showCode(link.code), 'code')}>{copied === 'code' ? 'Copied' : 'Copy'}</button>
            </div>
            <p className={`sv-status ${st.state}`} aria-live="polite">{statusLine(st, link)}</p>
            <p className="sv-what">It keeps <What s={mine} />. Type it on another device to bring them there; from then on both devices save to it, and your games and decks from each are kept.</p>
            <div className="row">
              <button className="btn sm" onClick={make} disabled={!!busy || st.state === 'saving'}>Save now</button>
              {login ? null : <button className="btn sm ghost" onClick={() => { forgetCode(); setFound(null); }} disabled={!!busy} title="This device stops saving to the code; the save itself stays on the server">Stop saving on this device</button>}
            </div>
          </>
        ) : (
          <>
            <p className="sv-what">A save code keeps your record and replays, your own decks, avatar, sleeves and settings{mine.games ? <> (right now: <What s={mine} />)</> : null}. Type it on another device to bring everything there. After that, this device saves to it by itself after every game.</p>
            {online === false
              ? <p className="sv-note">Save codes need the website itself (lotusgoats.com). Here, use a save text instead (below).</p>
              : <button className="btn primary sv-make" onClick={make} disabled={!!busy || online === null}>{busy === 'make' ? 'Making your code…' : 'Make my save code'}</button>}
          </>
        )}
        <p className="fine">Keep your code to yourself, like a password: anyone who has it can load your progress.</p>
      </section>

      <form className="sv-load" onSubmit={look} aria-label="Load a save code">
        <h3>Got a code from another device?</h3>
        <div className="sv-row">
          <label className="sr" htmlFor="sv-input">Save code or save text</label>
          <input id="sv-input" className={`input ${input.trim().startsWith(TEXT_PREFIX) ? 'text' : ''}`} value={input} placeholder="e.g. K7QM-4ZP2" autoComplete="off" autoCapitalize="characters" spellCheck="false"
            onChange={e => { setInput(e.target.value); setFound(null); setErr(null); }} />
          <button className="btn primary" type="submit" disabled={!!busy || !input.trim()}>{busy === 'look' ? 'Looking…' : 'Find save'}</button>
        </div>
        {found ? (
          <div className="sv-found" ref={el => { if (el && !el.dataset.shown) { el.dataset.shown = '1'; el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } }}>
            <div className="sv-who">
              {found.sum.avatar ? <AnimalAvatar code={found.sum.avatar} size={52} /> : null}
              <div>
                <b>{found.sum.name || (found.kind === 'code' ? `Save ${showCode(found.save.code)}` : 'Save text')}</b>
                <span>{found.save.at ? `Saved ${savedWhen(found.save.at)}` : ''}</span>
              </div>
            </div>
            <p>It has <What s={found.sum} />.</p>
            <p className="fine">The games and decks already on this device stay, and the ones in the save join them. The avatar, name, sleeves and settings come from the save.{found.kind === 'code' ? ' This device then saves to this code too.' : ''}</p>
            <div className="row">
              <button type="button" className="btn" onClick={() => setFound(null)} disabled={busy === 'load'}>Cancel</button>
              <button type="button" className="btn primary" onClick={bring} disabled={!!busy}>{busy === 'load' ? 'Loading…' : 'Load it onto this device'}</button>
            </div>
          </div>
        ) : null}
      </form>

      <details className="sv-text" open={textOpen} onToggle={e => setTextOpen(e.currentTarget.open)}>
        <summary>No connection to the save server?</summary>
        <p>Use a save text instead: make one here, copy it somewhere you can reach from the other device (a note, an email to yourself), then paste it into the box above there.</p>
        {text ? (
          <>
            <textarea className="input sv-textarea" readOnly value={text} aria-label="Your save text" onFocus={e => e.target.select()} />
            <div className="row">
              <span className="fine">{plural(text.length, 'character')}</span>
              <button className="btn sm" onClick={() => copy(text, 'text')}>{copied === 'text' ? 'Copied' : 'Copy save text'}</button>
            </div>
          </>
        ) : <button className="btn sm" onClick={makeText} disabled={!!busy}>{busy === 'text' ? 'Making it…' : 'Make a save text'}</button>}
      </details>

      {copied === 'select' ? <p className="sv-note" role="status">Copying isn’t allowed here: select the code or text and copy it yourself.</p> : null}
      {err ? <p className="sv-err" role="alert">{err}</p> : null}
      <div className="dlg-actions"><button className="btn" onClick={onClose} disabled={busy === 'load'}>Close</button></div>
    </Modal>
  );
}
