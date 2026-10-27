// Cards in the Pokémon deck builder: picture tiles, a large preview that follows the mouse, what a card is in a few
// words ("Stage 2 · from Drakloak · 320 HP"), and the card sheet: tap any card to read it, see its evolution line and
// other versions, how many tournament decks play it, and add or take out copies.
import { Modal } from '../../ui/dialogs.jsx';
import { Energy, Cost, TYPE_COLORS } from './energy.jsx';
import { pkImage, subscribePk, pkImagesVersion } from './images.js';
import { isBasicEnergy, setLabel, normName } from '../decktext.js';

const { useState, useSyncExternalStore } = React;
const STAGE = { Basic: 'Basic', Stage1: 'Stage 1', Stage2: 'Stage 2', VSTAR: 'VSTAR' };

// what a card is, in a few words
export function cardKind(d) {
  if (!d) return '';
  if (d.cat === 'P') return [`${STAGE[d.stage] || d.stage} Pokémon${d.mega ? ' (Mega)' : d.ex ? ' ex' : d.v ? ' V' : ''}`, d.from ? `from ${d.from}` : null, `${d.hp} HP`, d.radiant ? 'Radiant' : null].filter(Boolean).join(' · ');
  if (d.cat === 'T') return [d.trainer === 'Tool' ? 'Pokémon Tool' : d.trainer, d.ace ? 'ACE SPEC' : null].filter(Boolean).join(' · ');
  return [isBasicEnergy(d) ? 'Basic Energy' : 'Special Energy', d.ace ? 'ACE SPEC' : null].filter(Boolean).join(' · ');
}
// the Energy symbol that stands for a card: a Pokémon's type, the Energy an Energy card makes
export const cardType = d => (!d ? null : d.cat === 'P' ? d.type : d.cat === 'E' ? (d.anyType ? 'Any' : d.provides) : null);

// a card picture (or a drawn stand-in until the pictures load)
export function PkCardArt({ def, cls = '' }) {
  useSyncExternalStore(subscribePk, pkImagesVersion);
  const img = def && pkImage(def.key);
  return (
    <span className={`pk-card ${cls}`} style={{ '--t': TYPE_COLORS[cardType(def)] || '#c9c1a8' }}>
      {img ? <img src={img} alt="" draggable="false" /> : (
        <span className="drawn"><b>{def ? def.name : ''}</b><span>{def && def.cat === 'P' ? `HP ${def.hp}` : cardKind(def)}</span></span>
      )}
    </span>
  );
}

// a card as a tile you can tap to read, with whatever goes under it (an Add button, a count)
export function CardTile({ def, onOpen, onEnter, onLeave, children, cls = '', count = 0, label }) {
  return (
    <div className={`tile pkb-tile ${cls}`} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <button type="button" className="tile-card" onClick={onOpen} aria-label={label || (def ? `${def.name}: details` : 'Card')}>
        <PkCardArt def={def} />
        {count ? <span className="pkb-count" aria-label={`${count} in your deck`}>×{count}</span> : null}
      </button>
      {children}
    </div>
  );
}

// the big preview beside whatever the mouse is on (mouse and trackpad only; a tap opens the card sheet instead)
const canHover = () => typeof matchMedia !== 'undefined' && matchMedia('(hover: hover) and (pointer: fine)').matches;
export function useHoverPreview() {
  const [hover, setHover] = useState(null);
  const enter = key => e => { if (canHover()) setHover({ key, rect: e.currentTarget.getBoundingClientRect() }); };
  const leave = () => setHover(null);
  return { hover, enter, leave, clear: leave };
}
export function HoverCard({ hover, db }) {
  if (!hover || !db[hover.key]) return null;
  // (the page's size scale makes the card bigger on big screens)
  const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--s')) || 1;
  const W = 250 * scale, H = W * 88 / 63, r = hover.rect, vw = window.innerWidth, vh = window.innerHeight;
  const left = r.right + 14 + W < vw ? r.right + 14 : r.left - 14 - W > 0 ? r.left - 14 - W : Math.max(8, vw - W - 8);
  const top = Math.max(8, Math.min(vh - H - 8, r.top + r.height / 2 - H / 2));
  return <div className="hovercard pkb-hover" style={{ left, top, width: W }} aria-hidden="true"><PkCardArt def={db[hover.key]} /></div>;
}

// a card's rules: Abilities and attacks for a Pokémon, the text of a Trainer or Energy
export function CardFacts({ def }) {
  if (def.cat !== 'P') return <p className="pkb-text">{def.text || (def.anyType ? 'Provides Energy of every type.' : `Provides ${def.provides} Energy.`)}</p>;
  return <>
    {(def.abilities || []).map(a => <p key={a.name} className="pkb-text"><b className="ab">Ability · {a.name}</b> {a.text}</p>)}
    {(def.attacks || []).map(a => <p key={a.name} className="pkb-text"><Cost cost={a.cost} size={15} /> <b>{a.name}</b>{a.damage ? <b className="dmg"> {a.damage}</b> : null} {a.text}</p>)}
    <p className="pkb-wr">{def.weak ? <>Weakness <Energy type={def.weak} size={14} /> ×2 · </> : null}{def.resist ? <>Resistance <Energy type={def.resist} size={14} /> −30 · </> : null}Retreat {def.retreat}</p>
  </>;
}

// ---- the card sheet
export function CardSheet({ cardKey, ix, have, featured, problem, onClose, onOpen, onAdd, onRemove, onFeature }) {
  const db = ix.db, def = db[cardKey];
  if (!def) return null;
  // (a reprint of it is the same card: in the deck, and in the tournament decks)
  const twins = ix.twins.get(cardKey) || [cardKey];
  const n = twins.reduce((a, k) => a + (have.get(k) || 0), 0);
  const inDeck = twins.find(k => have.get(k)) || cardKey;
  const plays = twins.reduce((a, k) => a + (ix.plays.get(k) || 0), 0);
  // its evolution line, and other cards with its name that do something else
  const from = def.from ? Object.values(db).find(x => x.cat === 'P' && x.name === def.from) : null;
  const into = def.cat === 'P' ? [...new Map(Object.values(db).filter(x => x.cat === 'P' && x.from === def.name).map(x => [x.name, x])).values()] : [];
  const others = (ix.byName.get(normName(def.name)) || []).filter(k => !twins.includes(k));
  const rule = def.mega ? 'Mega Evolution Pokémon ex: when it’s Knocked Out, your opponent takes 3 Prize cards.'
    : def.ex ? 'Pokémon ex: when it’s Knocked Out, your opponent takes 2 Prize cards.' : def.v ? 'Pokémon V: when it’s Knocked Out, your opponent takes 2 Prize cards.' : null;
  const link = d => <button key={d.key} type="button" className="linkish" onClick={() => onOpen(d.key)}>{d.name}</button>;
  return (
    <Modal label={def.name} onClose={onClose} cls="card-sheet pkb-sheet">
      <div className="cs-grid">
        <div className="cs-card pkb-big"><PkCardArt def={def} /></div>
        <div className="cs-info">
          <div className="cs-head">
            <h2>{def.name}</h2>
            <div className="cs-type">{cardType(def) ? <Energy type={cardType(def)} size={18} /> : null}<span>{cardKind(def)}</span><span className="pkb-set">{isBasicEnergy(def) ? 'Basic Energy' : setLabel(def.key)}</span></div>
          </div>
          <div className="cs-acts">
            {n ? <>
              <span className="cs-count">{n} in your deck</span>
              <button className="btn" onClick={() => onRemove(inDeck)}>{n > 1 ? '− One fewer' : 'Take it out'}</button>
              <button className="btn" onClick={() => onAdd(cardKey)} disabled={!!problem} title={problem || ''}>+ One more</button>
            </> : <button className="btn primary" onClick={() => onAdd(cardKey)} disabled={!!problem}>Add to deck</button>}
          </div>
          {problem ? (n ? <p className="pkb-note">{problem}</p> : <ul className="cs-problems"><li>{problem}</li></ul>) : null}
          <div className="cs-sec pkb-facts"><CardFacts def={def} /></div>
          {rule || def.ace || def.radiant ? (
            <div className="cs-sec">
              <h4>Special rules</h4>
              {rule ? <p>{rule}</p> : null}
              {def.ace ? <p>ACE SPEC: a deck can have only 1 ACE SPEC card.</p> : null}
              {def.radiant ? <p>Radiant Pokémon: a deck can have only 1 Radiant Pokémon. When it’s Knocked Out, your opponent takes 1 Prize card.</p> : null}
            </div>
          ) : null}
          {from || into.length ? (
            <div className="cs-sec">
              <h4>Evolution</h4>
              <p>{from ? <>Evolves from {link(from)}. </> : null}{into.length ? <>Evolves into {into.map((d, i) => <React.Fragment key={d.key}>{i ? ', ' : ''}{link(d)}</React.Fragment>)}.</> : null}</p>
            </div>
          ) : null}
          {others.length ? (
            <div className="cs-sec">
              <h4>Other cards called {def.name}</h4>
              <p>They do different things: {others.map((k, i) => <React.Fragment key={k}>{i ? ', ' : ''}<button type="button" className="linkish" onClick={() => onOpen(k)}>{setLabel(k)}</button></React.Fragment>)}.</p>
            </div>
          ) : null}
          <p className="pkb-plays">{plays ? `Played in ${plays} of the ${ix.deckCount} tournament decks.` : 'Not in any of the tournament decks: try something new!'}</p>
          {n && def.cat === 'P' && onFeature ? <div className="cs-acts"><button className="btn sm ghost" onClick={() => onFeature(inDeck)} disabled={featured === inDeck}>{featured === inDeck ? '★ Your deck’s picture' : '☆ Use as your deck’s picture'}</button></div> : null}
        </div>
      </div>
      <div className="dlg-actions"><button className="btn" onClick={onClose}>Close</button></div>
    </Modal>
  );
}
