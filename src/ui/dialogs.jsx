// Modal dialogs for engine prompts and app-level panels.
import { CardFace, viewOf, Pip, RulesText } from './cardview.jsx';
import { fromRef } from '../engine/abilities.js';
import { onClaude } from '../net/roomclient.js';

const { useState, useEffect, useRef } = React;

export function Modal({ children, narrow, onClose, label }) {
  useEffect(() => {
    if (!onClose) return;
    const k = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget && onClose) onClose(); }}>
      <div className={`dialog ${narrow ? 'narrow' : ''}`} role="dialog" aria-modal="true" aria-label={label}>{children}</div>
    </div>
  );
}

function CardPick({ game, card, picked, onClick, onHover, order }) {
  const v = viewOf(game, card);
  return (
    <div className="pick">
      <div className="cardwrap"><CardFace v={v} size="hand" cls={picked ? 'selected' : 'targetable'} onClick={onClick} onEnter={() => onHover && onHover(card.id)} /></div>
      {picked ? <span className="tick">{order || '✓'}</span> : null}
    </div>
  );
}

const PURPOSE_TITLES = {
  discard: 'Discard', mulliganBottom: 'Mulligan', scryBottom: 'Scry', surveilGrave: 'Surveil', sacrifice: 'Sacrifice', costSac: 'Sacrifice',
  legendKeep: 'Legend rule', crew: 'Crew', searchBattlefield: 'Search your library', searchHand: 'Search your library', search: 'Choose cards',
  digHand: 'Look at the top of your library', dig: 'Look at the top of your library', digBattlefield: 'Look at the top of your library', chooseCard: 'Choose', clone: 'Choose a card to copy',
};

export function CardsDialog({ game, req, respond, onHover }) {
  const [sel, setSel] = useState([]);
  const cards = req.cards.map(id => game.cardById(id)).filter(Boolean);
  const toggle = id => setSel(s => s.includes(id) ? s.filter(x => x !== id) : (s.length >= req.max ? (req.max === 1 ? [id] : s) : [...s, id]));
  const ok = sel.length >= req.min && sel.length <= req.max;
  const title = PURPOSE_TITLES[req.purpose] || 'Choose cards';
  const range = req.min === req.max ? `${req.min}` : req.min === 0 ? `up to ${req.max}` : `${req.min}–${req.max}`;
  return (
    <Modal label={title}>
      <h2>{title}</h2>
      <div className="sub">{req.prompt} · choose {range}</div>
      <div className="dlg-cards">
        {cards.map(c => <CardPick key={c.id} game={game} card={c} picked={sel.includes(c.id)} order={req.purpose === 'scryBottom' ? null : null} onClick={() => toggle(c.id)} onHover={onHover} />)}
      </div>
      <div className="dlg-actions">
        <span className="note">{sel.length} selected</span>
        {req.cancellable ? <button className="btn ghost" onClick={() => respond(null)}>Cancel</button> : null}
        {req.max > 1 && cards.length <= req.max ? <button className="btn" onClick={() => setSel(cards.map(c => c.id))}>Select all</button> : null}
        <button className="btn primary" disabled={!ok} onClick={() => respond(sel)}>Confirm</button>
      </div>
    </Modal>
  );
}

export function TargetsDialog({ game, req, respond, onHover }) {
  const [sel, setSel] = useState([]);
  const objs = req.cands.map(r => ({ r, o: fromRef(game, r) })).filter(x => x.o);
  const toggle = r => setSel(s => s.includes(r) ? s.filter(x => x !== r) : (s.length >= req.max ? (req.max === 1 ? [r] : s) : [...s, r]));
  const ok = sel.length >= req.min && sel.length <= req.max;
  return (
    <Modal label="Choose targets">
      <h2>{req.purpose === 'proliferate' ? 'Proliferate' : 'Choose targets'}</h2>
      <div className="sub">{req.prompt} · {req.min === req.max ? req.min : `${req.min}–${req.max}`}</div>
      <div className="dlg-cards">
        {objs.map(({ r, o }) => o.isPlayer
          ? <button key={r} className={`btn ${sel.includes(r) ? 'primary' : ''}`} onClick={() => toggle(r)}>{o.name} ({o.life} life)</button>
          : o.stackItem
            ? <button key={r} className={`btn ${sel.includes(r) ? 'primary' : ''}`} onClick={() => toggle(r)} style={{ maxWidth: 260, whiteSpace: 'normal', textAlign: 'left' }}>{o.description}<br /><small>{game.players[o.controller].name}</small></button>
            : <CardPick key={r} game={game} card={o} picked={sel.includes(r)} onClick={() => toggle(r)} onHover={onHover} />)}
      </div>
      <div className="dlg-actions">
        <span className="note">{sel.length} selected</span>
        {req.cancellable ? <button className="btn ghost" onClick={() => respond(null)}>Cancel</button> : null}
        <button className="btn primary" disabled={!ok} onClick={() => respond(sel)}>Confirm</button>
      </div>
    </Modal>
  );
}

export function OptionDialog({ game, req, respond }) {
  return (
    <Modal narrow label="Choose">
      <h2>{req.prompt || 'Choose one'}</h2>
      <div className="optlist">
        {req.options.map(o => <button key={o.value} className="btn" onClick={() => respond(o.value)}><RulesText text={o.label} /></button>)}
      </div>
      {req.cancellable ? <div className="dlg-actions"><button className="btn ghost" onClick={() => respond(null)}>Cancel</button></div> : null}
    </Modal>
  );
}

export function ModesDialog({ game, req, respond }) {
  const [sel, setSel] = useState([]);
  const toggle = v => setSel(s => req.repeat ? (s.length < req.max ? [...s, v] : s) : s.includes(v) ? s.filter(x => x !== v) : (s.length >= req.max ? s : [...s, v]));
  const ok = sel.length >= req.min && sel.length <= req.max;
  return (
    <Modal narrow label="Choose modes">
      <h2>{req.prompt}</h2>
      <div className="optlist">
        {req.options.map(o => <button key={o.value} className={`btn ${sel.includes(o.value) ? 'on' : ''}`} onClick={() => toggle(o.value)}>{sel.includes(o.value) ? '● ' : '○ '}<RulesText text={o.label} />{req.repeat && sel.filter(x => x === o.value).length > 1 ? ` ×${sel.filter(x => x === o.value).length}` : ''}</button>)}
      </div>
      <div className="dlg-actions">
        {req.repeat ? <button className="btn ghost" onClick={() => setSel([])}>Clear</button> : null}
        {req.cancellable ? <button className="btn ghost" onClick={() => respond(null)}>Cancel</button> : null}
        <button className="btn primary" disabled={!ok} onClick={() => respond(sel)}>Confirm</button>
      </div>
    </Modal>
  );
}

export function ConfirmDialog({ game, req, respond, onHover }) {
  const cards = (req.cards || []).map(id => game.cardById(id)).filter(Boolean);
  return (
    <Modal narrow label="Confirm">
      <h2><RulesText text={req.prompt} /></h2>
      {cards.length ? <div className="dlg-cards">{cards.map(c => <div className="cardwrap" key={c.id}><CardFace v={viewOf(game, c)} size="hand" onEnter={() => onHover && onHover(c.id)} /></div>)}</div> : null}
      <div className="dlg-actions">
        {req.cancellable ? <button className="btn ghost" onClick={() => respond(null)}>Cancel</button> : null}
        <button className="btn" onClick={() => respond(false)}>No</button>
        <button className="btn primary" onClick={() => respond(true)} autoFocus>Yes</button>
      </div>
    </Modal>
  );
}

export function NumberDialog({ req, respond }) {
  const [n, setN] = useState(req.max);
  return (
    <Modal narrow label="Choose a number">
      <h2>{req.prompt}</h2>
      <div className="numrow">
        <button className="btn" onClick={() => setN(Math.max(req.min, n - 1))} aria-label="decrease">−</button>
        <span className="val">{n}</span>
        <button className="btn" onClick={() => setN(Math.min(req.max, n + 1))} aria-label="increase">+</button>
      </div>
      <input id="numrange" type="range" min={req.min} max={req.max} value={n} onChange={e => setN(+e.target.value)} />
      <div className="dlg-actions">
        <span className="note">Range {req.min}–{req.max}</span>
        {req.cancellable ? <button className="btn ghost" onClick={() => respond(null)}>Cancel</button> : null}
        <button className="btn primary" onClick={() => respond(n)}>Confirm</button>
      </div>
    </Modal>
  );
}

export function ColorDialog({ req, respond }) {
  return (
    <Modal narrow label="Choose a color">
      <h2>{req.prompt || 'Choose a color'}</h2>
      <div className="colorrow">
        {req.colors.map(c => <button key={c} onClick={() => respond(c)} aria-label={c}><Pip s={c} /></button>)}
      </div>
      {req.cancellable ? <div className="dlg-actions"><button className="btn ghost" onClick={() => respond(null)}>Cancel</button></div> : null}
    </Modal>
  );
}

export function PlayerDialog({ game, req, respond }) {
  return (
    <Modal narrow label="Choose a player">
      <h2>{req.prompt || 'Choose a player'}</h2>
      <div className="optlist">{req.players.map(id => <button key={id} className="btn" onClick={() => respond(id)}>{game.players[id].name} — {game.players[id].life} life</button>)}</div>
    </Modal>
  );
}

export function MulliganDialog({ game, req, respond, onHover }) {
  const p = game.players[req.player];
  const lands = p.hand.filter(c => game.chars(c).types.has('Land')).length;
  return (
    <Modal label="Opening hand">
      <h2>Your opening hand</h2>
      <div className="sub">{lands} land{lands === 1 ? '' : 's'} · {req.count === 0 ? 'Your first mulligan is free in Commander.' : `Mulligans so far: ${req.count}. You will put ${req.count} card${req.count > 1 ? 's' : ''} on the bottom.`}</div>
      <div className="dlg-cards">{p.hand.map(c => <div className="cardwrap" key={c.id}><CardFace v={viewOf(game, c)} size="hand" onEnter={() => onHover(c.id)} /></div>)}</div>
      <div className="dlg-actions">
        <button className="btn" onClick={() => respond(false)}>Mulligan</button>
        <button className="btn primary" onClick={() => respond(true)} autoFocus>Keep</button>
      </div>
    </Modal>
  );
}

export function ZoneDialog({ game, pid, zone, onClose, onHover, onMenu }) {
  const p = game.players[pid];
  const cards = zone === 'library' ? [] : [...(p[zone] || [])].reverse();
  const title = { graveyard: 'Graveyard', exile: 'Exile', library: 'Library', command: 'Command zone' }[zone];
  return (
    <Modal label={title} onClose={onClose}>
      <h2>{p.name} — {title} ({(p[zone] || []).length})</h2>
      {zone === 'library' ? <div className="sub">Libraries are hidden. {p.library.length} cards remain.</div> : null}
      <div className="dlg-cards">
        {cards.length ? cards.map(c => <div className="cardwrap" key={c.id}><CardFace v={c.faceDown && c.owner !== 0 ? { ...viewOf(game, c), name: 'Face-down card', oracle: '' } : viewOf(game, c)} size="hand" onEnter={() => onHover(c.id)} onContextMenu={e => { e.preventDefault(); onMenu(e, c); }} onClick={e => onMenu(e, c)} /></div>) : <div className="empty">Empty</div>}
      </div>
      <div className="dlg-actions"><button className="btn primary" onClick={onClose}>Close</button></div>
    </Modal>
  );
}

export function SettingsDialog({ settings, onChange, onClose }) {
  const set = (k, v) => onChange({ ...settings, [k]: v });
  const Toggle = ({ k, title, note }) => (
    <label htmlFor={'set-' + k}><input id={'set-' + k} type="checkbox" checked={!!settings[k]} onChange={e => set(k, e.target.checked)} /><span>{title}<small>{note}</small></span></label>
  );
  return (
    <Modal narrow label="Settings" onClose={onClose}>
      <h2>Table settings</h2>
      <div className="settings">
        <label htmlFor="set-speed"><span style={{ minWidth: 90 }}>AI speed</span>
          <select id="set-speed" className="input" value={settings.aiSpeed} onChange={e => set('aiSpeed', e.target.value)}>
            <option value="slow">Relaxed</option><option value="normal">Like a real player</option><option value="fast">Quick</option><option value="instant">Instant</option>
          </select>
        </label>
        <Toggle k="stopOppEnd" title="Stop at opponents' end steps" note="Only when you have instant-speed plays." />
        <Toggle k="stopOppCombat" title="Stop after blockers on opponents' attacks" note="Gives you a window for combat tricks." />
        <Toggle k="stopOwnCombat" title="Stop at your own combat steps" note="For tricks before attacks and after blocks." />
        <Toggle k="stopForOpponentSpells" title="Let me respond during “End turn”" note="Stops auto-pass when an opponent casts something you can answer." />
        <Toggle k="fullControl" title="Full control" note="Stop at every priority window where you could act." />
        <Toggle k="autoCommander" title="Always return my commander to the command zone" note="Otherwise you'll be asked each time." />
        <Toggle k="images" title="Show card images" note="Turn off for drawn card frames with the full rules text on every card." />
      </div>
      <div className="dlg-actions"><button className="btn primary" onClick={onClose}>Done</button></div>
    </Modal>
  );
}

export function HelpDialog({ onClose }) {
  return (
    <Modal label="How to play" onClose={onClose}>
      <h2>How to play</h2>
      <div className="help">
        <section>
          <h3>Your turn</h3>
          <p>Cards that glow gold are things you can do right now: a land to play, a spell you can afford, or an ability to activate. Click one to use it. Mana is tapped for you, picking lands so you keep the colors you still need.</p>
          <p>Your commander waits in the command zone chip next to your name. Commander tax is added automatically each time you recast it.</p>
        </section>
        <section>
          <h3>The prompt bar</h3>
          <p>The bar between the opponents and your board always says what the game is waiting for. Its gold button moves things along: <b>Go to combat</b>, <b>End turn</b>, <b>Resolve</b> or <b>Pass</b>. Press <kbd>Space</kbd> or <kbd>Enter</kbd> to click it.</p>
          <p><b>End turn</b> and <b>Skip to my turn</b> auto-pass, but still stop when you need to block or answer something. Change when it stops in Settings.</p>
        </section>
        <section>
          <h3>Combat</h3>
          <p>To attack, click your creatures, then confirm. With several opponents, choose who each creature attacks using the target buttons in the bar. To block, click one of your creatures and then the attacker it should block.</p>
        </section>
        <section>
          <h3>Targets and choices</h3>
          <p>When a spell needs targets, legal ones light up. Click them, or click a player's area to target that player, then confirm. Other choices open in a dialog.</p>
        </section>
        <section>
          <h3>Looking closer and fixing things</h3>
          <p>Hover a card to read it in the side panel. On a touch screen, tap it. Right-click any card, or your life total, for more: inspect it, move it, tap or untap it, add counters, or create tokens. Use these to handle the rare card the rules engine doesn't fully automate. The deck screen shows how much of each deck is automated.</p>
        </section>
        <section>
          <h3>Playing with friends</h3>
          <p>Choose <b>Play with friends</b>, enter your name and create a room. Send your friends the invite link. Each friend opens it, takes an open seat and picks a deck, then the host presses <b>Start game</b>. Empty seats can be filled by AI players.</p>
          <p>{onClaude() ? 'Friends need to be signed in to claude.ai and invited to this page from its Share menu. ' : 'No accounts needed, and rooms run through this site’s own server, so they work on school Wi-Fi too. '}If someone's connection drops, they can reopen the link to rejoin, and the host can let the AI play their seat meanwhile.</p>
        </section>
        <section>
          <h3>Winning</h3>
          <p>Everyone starts at 40 life. A player loses at 0 life, at 21 combat damage from a single commander, at 10 poison counters, or by drawing from an empty library. Be the last one standing.</p>
        </section>
      </div>
      <div className="dlg-actions"><button className="btn primary" onClick={onClose}>Got it</button></div>
    </Modal>
  );
}

const TOKENS = [
  ['w_1_1_soldier', '1/1 Soldier'], ['b_2_2_zombie', '2/2 Zombie'], ['g_1_1_saproling', '1/1 Saproling'], ['r_1_1_goblin', '1/1 Goblin'], ['u_2_2_drake_flying', '2/2 Drake (flying)'],
  ['w_1_1_spirit_flying', '1/1 Spirit (flying)'], ['g_3_3_beast', '3/3 Beast'], ['c_1_1_a_thopter_flying', '1/1 Thopter (flying)'], ['c_a_treasure_sac', 'Treasure'], ['c_a_clue_draw', 'Clue'], ['c_a_food_sac', 'Food'],
];

export function TokenDialog({ game, onMake, onClose }) {
  const [n, setN] = useState(1);
  const [pt, setPt] = useState('2/2');
  return (
    <Modal narrow label="Create a token" onClose={onClose}>
      <h2>Create tokens</h2>
      <div className="sub">For effects the engine doesn't automate.</div>
      <div className="numrow"><span>Amount</span><button className="btn sm" onClick={() => setN(Math.max(1, n - 1))}>−</button><span className="val" style={{ fontSize: 22 }}>{n}</span><button className="btn sm" onClick={() => setN(n + 1)}>+</button></div>
      <div className="optlist" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
        {TOKENS.filter(([k]) => game.db.rawTokens[k]).map(([k, l]) => <button key={k} className="btn" onClick={() => onMake(k, n)}>{l}</button>)}
      </div>
      <div className="filters"><label htmlFor="custom-pt">Custom creature</label><input id="custom-pt" className="input" style={{ width: 80 }} value={pt} onChange={e => setPt(e.target.value)} /><button className="btn" onClick={() => onMake('custom:' + pt, n)}>Create</button></div>
      <div className="dlg-actions"><button className="btn primary" onClick={onClose}>Close</button></div>
    </Modal>
  );
}

export function Menu({ menu, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: menu.x, top: menu.y });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = menu.x, top = menu.y;
    if (left + r.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - r.width - 8);
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - r.height - 8);
    setPos({ left, top });
    const k = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [menu]);
  return (
    <div className="overlay" style={{ background: 'transparent' }} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }} onContextMenu={e => { e.preventDefault(); onClose(); }}>
      <div className="menu" ref={ref} style={pos} role="menu">
        {menu.title ? <div className="mh">{menu.title}</div> : null}
        {menu.items.map((it, i) => it === '-' ? <hr key={i} /> : it.header ? <div key={i} className="mh">{it.header}</div> :
          <button key={i} className={`mi ${it.primary ? 'cast' : ''}`} role="menuitem" onClick={() => { onClose(); it.run(); }}><RulesText text={it.label} /></button>)}
      </div>
    </div>
  );
}
