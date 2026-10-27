// Un-set things at the table: a player's Attraction deck and junkyard, and their tickets and sticker sheets (with
// what's still free to stick). The engine side is src/engine/mech-unsets.js.
import { Modal } from './dialogs.jsx';
import { CardFace, CardBack, viewOf } from './cardview.jsx';
import { stickerSheetsView, stickerKindWord, stickerText } from '../engine/mech-unsets-rules.js';

const { useState } = React;

const stop = f => e => { e.stopPropagation(); f(); };

// Slots on the player's side of the table, next to the command zone, sized like its cards: the Attraction deck and
// the junkyard (click to look through it); tickets and sticker sheets (click for the sheets).
const tile = { position: 'relative', width: 'var(--cw)', height: 'calc(var(--cw) * 1.4)', flex: 'none', padding: 0, border: 0, background: 'none', cursor: 'pointer', font: 'inherit', color: 'inherit' };
const count = { position: 'absolute', left: '50%', bottom: 4, transform: 'translateX(-50%)', zIndex: 5 };
// (room for the command zone's label, which is wider than one small card)
const slotGap = { marginLeft: 12 };
const sheetTile = { ...tile, borderRadius: 'calc(var(--cw) * 0.06)', border: '1px solid rgba(243, 212, 136, 0.45)', background: 'linear-gradient(160deg, #3d2f59, #24384d 55%, #2b4a37)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, fontWeight: 800, fontSize: 'max(10px, calc(var(--cw) * 0.15))', lineHeight: 1.15 };
export function UnsetsSlot({ game, pid, ctx }) {
  const [open, setOpen] = useState(false);
  const p = game.players[pid];
  const view = stickerSheetsView(game, pid);
  const tickets = (p.counters && p.counters.TICKET) || 0;
  const deck = p.AttractionDeck, junk = p.Junkyard || [];
  const free = view ? view.sheets.reduce((a, s) => a + s.stickers.filter(x => !x.used).length, 0) : 0;
  const top = junk[junk.length - 1];
  return (
    <>
      {deck || junk.length ? (
        <div className="cmdslot" style={slotGap} data-pile={`${pid}:attractions`}>
          {deck ? (
            <div style={tile} data-unsets="attractions" title={`Attraction deck: ${deck.length} left. "Open an Attraction" puts its top card onto the battlefield; at the start of ${p.name}'s precombat main phase they roll a six-sided die and visit each of their Attractions with that number lit.`}>
              <CardBack /><span className="badge cnt" style={count}>🎡 {deck.length}</span>
            </div>
          ) : null}
          {junk.length ? (
            <button type="button" style={tile} data-unsets="junkyard" onClick={stop(() => ctx.openZone(pid, 'Junkyard'))} onMouseEnter={() => top && ctx.onHover(top.id)} title={`Junkyard: ${junk.length} Attraction${junk.length === 1 ? '' : 's'} that left the battlefield`}>
              <CardFace v={viewOf(game, top)} /><span className="badge cnt" style={count}>Junk {junk.length}</span>
            </button>
          ) : null}
          <span className="slotlabel">Attractions</span>
        </div>
      ) : null}
      {view || tickets ? (
        <div className="cmdslot" style={slotGap} data-pile={`${pid}:stickers`}>
          <button type="button" style={sheetTile} data-unsets="stickers" onClick={stop(() => setOpen(true))}
            title={`${tickets} ticket${tickets === 1 ? '' : 's'}: they pay for ability and power/toughness stickers.${view ? ` ${free} sticker${free === 1 ? '' : 's'} left on the sheets: click to see them.` : ''}`}>
            <span>🎟 {tickets}</span>{view ? <span>★ {free}</span> : null}<span style={{ fontSize: '0.7em', opacity: 0.8, fontWeight: 700 }}>{view ? 'Sheets' : 'Tickets'}</span>
          </button>
          <span className="slotlabel">Stickers</span>
          {open ? <StickerSheetsDialog game={game} pid={pid} onClose={() => setOpen(false)} /> : null}
        </div>
      ) : null}
    </>
  );
}

const KIND_ORDER = ['Name', 'Art', 'Ability', 'PT'];
export function StickerSheetsDialog({ game, pid, onClose }) {
  const view = stickerSheetsView(game, pid);
  const p = game.players[pid];
  const tickets = view ? view.tickets : (p.counters.TICKET || 0);
  return (
    <Modal label="Sticker sheets" onClose={onClose}>
      <h2>{p.name} — Sticker sheets</h2>
      <div className="sub">{tickets} ticket{tickets === 1 ? '' : 's'}. Name and art stickers are free; ability and power/toughness stickers cost the tickets shown. A sticker that's on something can't be used again until that card leaves for a hand or library.</div>
      {!view ? <div className="empty">No sticker sheets.</div> : (
        <div className="sheets" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, margin: '10px 0' }}>
          {view.sheets.map(sh => (
            <div key={sh.name} className="sheet" style={{ border: '1px solid rgba(255,255,255,0.18)', borderRadius: 8, padding: '8px 10px', background: 'rgba(0,0,0,0.25)' }}>
              <b>{sh.name}</b>
              <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, fontSize: 13, lineHeight: 1.45 }}>
                {sh.stickers.slice().sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)).map(s => {
                  const afford = s.tickets <= tickets;
                  return (
                    <li key={s.slot} data-sticker={s.id} style={{ opacity: s.used ? 0.45 : 1, textDecoration: s.used ? 'line-through' : 'none' }}
                      title={s.used ? 'On one of your cards' : !afford ? `Needs ${s.tickets} tickets` : 'Available'}>
                      <small style={{ opacity: 0.7 }}>{stickerKindWord(s.kind)}</small>{s.kind === 'Art' ? null : <> {stickerText(s)}</>}{s.tickets ? <span style={{ opacity: afford ? 0.85 : 0.5 }}> · 🎟{s.tickets}</span> : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
      <div className="dlg-actions"><button className="btn primary" onClick={onClose}>Close</button></div>
    </Modal>
  );
}
