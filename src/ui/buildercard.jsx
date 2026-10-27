// Cards in the deck builder: mana costs, picture tiles that only load their picture once they scroll into view (the
// pictures come in packs of about forty, so a whole search page can't load at once), a large preview that follows
// the mouse, and the card sheet: tap any card to see what it does in your deck, why it fits (or what stops
// it going in), and other cards for the same job.
import { CardFace, viewOfDef, Pip } from './cardview.jsx';
import { subscribeImages, imagesVersion } from './images.js';
import { Modal } from './dialogs.jsx';
import { ROLES, ROLE_HELP } from './deckguide.js';

const { useState, useEffect, useRef, useSyncExternalStore } = React;
const costPip = t => (/^\d+$/.test(t) || t === 'X' ? t : t.length === 2 && /^[WUBRG2][WUBRGP]$/.test(t) ? `${t[0]}/${t[1]}` : t);
export const SHORT_ROLE = { ramp: 'Ramp', draw: 'Draw', removal: 'Removal', wipe: 'Wipe', counter: 'Counter', tutor: 'Tutor', protect: 'Protect', recursion: 'Recursion' };

export function Cost({ cost }) {
  return cost && cost.length ? <span className="mana">{cost.map((t, i) => <Pip key={i} s={costPip(t)} />)}</span> : null;
}
export function RoleTags({ roles, max = 2 }) {
  return roles && roles.length ? <span className="rtags">{roles.slice(0, max).map(r => <span key={r} className={`rtag r-${r}`}>{SHORT_ROLE[r]}</span>)}</span> : null;
}

// true once the element has come near the screen
function useSeen(ref) {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen || !ref.current) return;
    if (typeof IntersectionObserver === 'undefined') { setSeen(true); return; }
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { setSeen(true); io.disconnect(); } }, { rootMargin: '300px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen]);
  return seen;
}

// a card as a picture (or its drawn frame), loaded when it comes into view
export function CardTile({ def, onOpen, onEnter, onLeave, children, cls = '', label }) {
  const ref = useRef(null);
  const seen = useSeen(ref);
  useSyncExternalStore(subscribeImages, imagesVersion);
  return (
    <div ref={ref} className={`tile ${cls}`} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <button type="button" className="tile-card" onClick={onOpen} aria-label={label || (def ? `${def.name}: details` : 'Card')}>
        <span className="cardwrap">{seen && def ? <CardFace v={viewOfDef(def)} size="hand" /> : <span className="tile-ph" />}</span>
      </button>
      {children}
    </div>
  );
}

// the big preview beside whatever the mouse is on (mouse and trackpad only; a tap opens the card sheet instead)
const canHover = () => typeof matchMedia !== 'undefined' && matchMedia('(hover: hover) and (pointer: fine)').matches;
export function useHoverPreview() {
  const [hover, setHover] = useState(null);
  const enter = name => e => { if (canHover()) setHover({ name, rect: e.currentTarget.getBoundingClientRect() }); };
  const leave = () => setHover(null);
  return { hover, enter, leave, clear: leave };
}
export function HoverCard({ hover, db }) {
  useSyncExternalStore(subscribeImages, imagesVersion);
  if (!hover) return null;
  const def = db.get(hover.name);
  if (!def) return null;
  // (the page's size scale makes the card bigger on big screens)
  const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--s')) || 1;
  const W = 250 * scale, H = W * 1.4, r = hover.rect, vw = window.innerWidth, vh = window.innerHeight;
  const left = r.right + 14 + W < vw ? r.right + 14 : r.left - 14 - W > 0 ? r.left - 14 - W : Math.max(8, vw - W - 8);
  const top = Math.max(8, Math.min(vh - H - 8, r.top + r.height / 2 - H / 2));
  return <div className="hovercard bigcard" style={{ left, top }} aria-hidden="true"><div className="cardwrap"><CardFace v={viewOfDef(def)} size="big" /></div></div>;
}

// ---- the card sheet
export function CardSheet({ name, H, db, byName, state, onClose, onOpen, onAdd, onRemove, onCommander, choosing }) {
  useSyncExternalStore(subscribeImages, imagesVersion);
  const def = db.get(name), c = byName.get(name);
  if (!def || !c) return null;
  const info = H.info(name, state) || { roles: [], plans: [], why: [], problems: [] };
  const have = state.cards.get(name) || 0;
  const isCommander = state.commanders.includes(name);
  const nonland = c.main !== 'Land';
  const ready = state.commanders.length > 0;
  // other cards for the same job (or the same kind of card)
  const similar = ready && !isCommander && !choosing && (info.roles.length || c.main === 'Land' || c.main === 'Creature')
    ? H.suggest(state, info.roles.length ? { role: info.roles[0], limit: 7 } : c.main === 'Land' ? { role: 'land', limit: 7 } : { type: 'Creature', limit: 7 }).filter(x => x.name !== name).slice(0, 6)
    : [];
  const blocked = info.problems.some(p => !/can’t fully play/.test(p));
  return (
    <Modal label={name} onClose={onClose} cls="card-sheet">
      <div className="cs-grid">
        <div className="cs-card bigcard"><div className="cardwrap"><CardFace v={viewOfDef(def)} size="big" /></div></div>
        <div className="cs-info">
          <div className="cs-head">
            <h2>{name}</h2>
            <div className="cs-type"><span>{c.type}</span><Cost cost={c.cost} /></div>
          </div>
          {isCommander ? <p className="cs-ok">Your commander. It starts in the command zone, so you can cast it every game.</p> : null}
          {info.problems.length ? <ul className="cs-problems">{info.problems.map(p => <li key={p}>{p}</li>)}</ul> : null}
          {choosing ? (
            <div className="cs-sec">
              <h4>As your commander</h4>
              {(() => {
                const plan = H.recipe({ commanders: [name], cards: new Map() }).planNames;
                const colors = c.ci.map(x => ({ W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' })[x]);
                const list = colors.length > 1 ? `${colors.slice(0, -1).join(', ')} and ${colors[colors.length - 1]}` : colors[0];
                return <>
                  <p>{plan.length ? <>Leads a deck about <b>{plan.slice(0, 3).join(', ')}</b>. </> : 'A flexible leader: fill the deck with strong cards that do their jobs. '}{H.leadsPrecon(name) ? 'It leads a precon, so you can also start from that deck.' : ''}</p>
                  <p>{c.ci.length === 5 ? 'Your deck can use cards of all five colors.' : c.ci.length ? `Your deck can use ${list} cards, plus colorless ones.` : 'A colorless commander: your deck can only use colorless cards.'}</p>
                </>;
              })()}
            </div>
          ) : null}
          {info.roles.length ? (
            <div className="cs-sec">
              <h4>Its job in a deck</h4>
              {info.roles.map(r => <p key={r}><span className={`rtag r-${r}`}>{SHORT_ROLE[r]}</span> {ROLE_HELP[r]}</p>)}
            </div>
          ) : null}
          {ready && !isCommander && !choosing && nonland ? (
            <div className="cs-sec">
              <h4>With your commander</h4>
              <p>{info.plans.length ? info.plans.join(' · ') : info.roles.length ? 'Not part of your commander’s plan: it’s here for its job.' : 'Doesn’t do much for your commander’s plan.'}</p>
            </div>
          ) : null}
          {ready && !isCommander && !choosing && (info.why.length || info.pop) ? (
            <div className="cs-sec">
              <h4>Why it fits this deck</h4>
              <p>{[...info.why.filter(w => !/can’t fully play/.test(w)), ...(info.pop && !info.why.some(w => /precons?$/.test(w)) ? [`In ${info.pop} precon${info.pop === 1 ? '' : 's'}`] : [])].join(' · ') || 'A solid card for its job.'}</p>
            </div>
          ) : null}
          <div className="cs-acts">
            {choosing ? <button className="btn primary" disabled={!c.commander} onClick={() => { onCommander(name); onClose(); }}>Make it my commander</button>
              : isCommander ? null
                : have ? <>
                  <span className="cs-count">{have > 1 ? `${have} in your deck` : 'In your deck'}</span>
                  {have < c.maxCopies ? <button className="btn" onClick={() => onAdd(name)}>+ One more</button> : null}
                  <button className="btn" onClick={() => onRemove(name)}>{have > 1 ? '− One fewer' : 'Remove from deck'}</button>
                </>
                  : <button className="btn primary" disabled={!ready || blocked} onClick={() => onAdd(name)}>{ready ? 'Add to deck' : 'Choose a commander first'}</button>}
            {!choosing && c.commander && !isCommander && !state.commanders.length ? <button className="btn" onClick={() => { onCommander(name); onClose(); }}>Make it my commander</button> : null}
          </div>
          {similar.length ? (
            <div className="cs-sec">
              <h4>{have ? 'Other picks for the same job' : info.roles.length ? `More ${ROLES[info.roles[0]].toLowerCase()} for this deck` : 'Similar picks for this deck'}</h4>
              <div className="cs-similar">
                {similar.map(x => {
                  const xc = byName.get(x.name);
                  const inDeck = state.cards.get(x.name);
                  return (
                    <div key={x.name} className="cs-sim">
                      <button type="button" className="bname as-btn" onClick={() => onOpen(x.name)}><b>{x.name}</b><small>{x.why.map(w => w.replace(/: you have \d+, aim for about \d+$/, '')).join(' · ') || (xc && xc.type)}</small></button>
                      <Cost cost={xc ? xc.cost : []} />
                      <button className="btn sm" disabled={!!inDeck} onClick={() => onAdd(x.name)}>{inDeck ? 'In deck' : '+ Add'}</button>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      </div>
      <div className="dlg-actions"><button className="btn" onClick={onClose}>Close</button></div>
    </Modal>
  );
}
