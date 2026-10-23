// Card sleeves and deck boxes, chosen per deck. A sleeve is what the backs of your cards look like at the table (your
// library, Prize cards, and your hand as other players see it); a deck box shows your deck in the lobby and in
// friends' rooms. Both are short codes ("pattern.color.trim.emblem", "material.color.trim.emblem") drawn as SVG,
// saved on this device per deck and carried in room presence so friends see them too.
import { safeStorage } from './common.js';
import { Modal } from './dialogs.jsx';
import { AnimalAvatar, Swatches, Choices, myAvatar, shade } from './avatar.jsx';

const { useState, useId, memo } = React;

const COLORS = ['#b3262e', '#d9682b', '#d9a520', '#6aa832', '#2f7d4a', '#1f8a8a', '#3b8fd9', '#233e8b', '#6b3fa0', '#d6538f', '#e9e6df', '#9aa1ab', '#22232a', '#6e4a2e'];
const TRIMS = ['#f3c34a', '#d9dde3', '#ffffff', '#15161a', '#e04848', '#4a90e2', '#4caf6a', '#9b6ad6', '#f08cb8', '#f39a3a'];
const PATTERNS = ['Matte', 'Glossy', 'Stripes', 'Argyle', 'Polka dots', 'Starry', 'Waves', 'Dragon scales', 'Plaid', 'Checkers'];
const MATERIALS = ['Plastic', 'Leather', 'Wood', 'Metal', 'Crystal', 'Velvet'];
const EMBLEMS = ['None', 'Star', 'Moon', 'Sun', 'Flame', 'Leaf', 'Drop', 'Bolt', 'Skull', 'Crown', 'Sword', 'Shield', 'Heart', 'Paw', 'Gem', 'My avatar'];
const AVATAR = EMBLEMS.length - 1;
const ICONS = {
  1: 'M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5-4.8-4.6 6.6-.9z',
  2: 'M15 2.5A9.5 9.5 0 1 0 21.5 17 7.5 7.5 0 0 1 15 2.5z',
  3: 'M12 1l2 4.5 4.8-1.6-1.6 4.8L21.7 12l-4.5 2 1.6 4.8-4.8-1.6L12 21.7l-2-4.5-4.8 1.6 1.6-4.8L1 12l4.5-2-1.6-4.8 4.8 1.6z',
  4: 'M12 2c1 4 5.5 6 5.5 11.5a5.5 5.5 0 0 1-11 0c0-3.2 2-4.5 2.2-7.5 1.6 1.1 2.2 2.7 2.3 4.3 1.2-2.3 1.2-5.3 1-8.3z',
  5: 'M20.5 3.5C9.5 3.5 4 8.5 4 15.5c0 1.6.3 3 1 4.2 1-5 4.8-9 10-11.2-4 3-6.9 6.3-8 11.3 9.2 0 13.5-6.2 13.5-16.3z',
  6: 'M12 2s7 8 7 13a7 7 0 0 1-14 0c0-5 7-13 7-13z',
  7: 'M13.5 1.5L4 14h6.5l-1.5 8.5L19 9.5h-6.5z',
  8: 'M12 2a8 8 0 0 0-8 8c0 3 1.5 5 3 6v3.5h2.2V17h1.7v2.5h2.2V17h1.7v2.5H17V16c1.5-1 3-3 3-6a8 8 0 0 0-8-8zM8.6 9a2.1 2.1 0 1 1 0 4.2 2.1 2.1 0 0 1 0-4.2zm6.8 0a2.1 2.1 0 1 1 0 4.2 2.1 2.1 0 0 1 0-4.2z',
  9: 'M3 18.5h18l1-11-5.5 4.5L12 4l-4.5 8L2 7.5zM3 20h18v2H3z',
  10: 'M11 2h2l.6 12.5h-3.2zM6.5 14.5h11v2h-11zM11 16.5h2v4h-2zM12 20.2a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4z',
  11: 'M12 2l8.5 3.2v6.2c0 5.2-3.6 9.3-8.5 10.9-4.9-1.6-8.5-5.7-8.5-10.9V5.2z',
  12: 'M12 21.3s-8.5-5.6-8.5-11.4A4.6 4.6 0 0 1 12 7.3a4.6 4.6 0 0 1 8.5 2.6c0 5.8-8.5 11.4-8.5 11.4z',
  13: 'M12 12.5c-3 0-5.5 3.2-5.5 5.5 0 1.7 1.4 2.8 3 2.8 1 0 1.6-.5 2.5-.5s1.5.5 2.5.5c1.6 0 3-1.1 3-2.8 0-2.3-2.5-5.5-5.5-5.5zM5.8 7.8a2.1 2.5 0 1 0 0 5 2.1 2.5 0 0 0 0-5zm12.4 0a2.1 2.5 0 1 0 0 5 2.1 2.5 0 0 0 0-5zM9.4 3.2a2.1 2.6 0 1 0 0 5.2 2.1 2.6 0 0 0 0-5.2zm5.2 0a2.1 2.6 0 1 0 0 5.2 2.1 2.6 0 0 0 0-5.2z',
  14: 'M7 3h10l5 6-10 13L2 9z',
};

// ---- codes
const parse = (code, sizes) => { const v = String(code || '').split('.').map(n => parseInt(n, 10)); return sizes.map((n, i) => (Number.isInteger(v[i]) && v[i] >= 0 && v[i] < n ? v[i] : 0)); };
const SLEEVE = [PATTERNS.length, COLORS.length, TRIMS.length, EMBLEMS.length];
const BOX = [MATERIALS.length, COLORS.length, TRIMS.length, EMBLEMS.length];
export const isStyleCode = c => typeof c === 'string' && /^\d{1,2}(\.\d{1,2}){3}$/.test(c);
const hash = s => { let h = 7; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; };

// a deck's box until you pick one: its colors and an emblem to match
const COLOR_OF = { W: [10, 3], U: [6, 6], B: [12, 8], R: [0, 4], G: [4, 5], Grass: [4, 5], Fire: [0, 4], Water: [6, 6], Lightning: [2, 7], Psychic: [8, 2], Fighting: [13, 11], Darkness: [12, 8], Metal: [11, 14], Dragon: [2, 9], Colorless: [10, 1] };
export function defaultBox(id, colors = []) {
  const [c, e] = COLOR_OF[colors[0]] || [7, 14];
  return [hash(id) % 2, c, c === 2 || c === 10 ? 3 : 0, colors.length >= 3 ? 14 : e].join('.');
}

// ---- saved choices
const KEY = 'pa-deckstyle';
let version = 0;
const subs = new Set();
export const subscribeDeckStyles = f => { subs.add(f); return () => subs.delete(f); };
export const deckStylesVersion = () => version;
const readAll = () => { try { const v = JSON.parse(safeStorage.getItem(KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
// { s: sleeve code or null (plain card backs), b: box code or null (the default box) }
export function savedStyle(kind, id) { const v = readAll()[`${kind}:${id}`] || {}; return { s: isStyleCode(v.s) ? v.s : null, b: isStyleCode(v.b) ? v.b : null }; }
export function saveDeckStyle(kind, id, style) {
  const all = readAll();
  all[`${kind}:${id}`] = style;
  safeStorage.setItem(KEY, JSON.stringify(all));
  version++;
  for (const f of subs) f();
}

// ---- drawing
function Emblem({ e, cx, cy, r, color, trim, avatar }) {
  if (!e) return null;
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} fill={shade(color, -0.32)} stroke={trim} strokeWidth={r * 0.08} />
      {e === AVATAR
        ? <g transform={`translate(${cx - r * 0.92} ${cy - r * 0.92})`}><AnimalAvatar code={avatar || myAvatar()} size={r * 1.84} /></g>
        : <g transform={`translate(${cx - r * 0.62} ${cy - r * 0.62}) scale(${(r * 1.24) / 24})`}><path d={ICONS[e]} fill={trim} fillRule="evenodd" /></g>}
    </g>
  );
}

function pattern(p, id, trim, color) {
  const P = (w, h, kids, extra = {}) => <pattern id={id} width={w} height={h} patternUnits="userSpaceOnUse" {...extra}>{kids}</pattern>;
  switch (p) {
    case 2: return P(7, 7, <rect width="3" height="7" fill={trim} opacity="0.28" />, { patternTransform: 'rotate(45)' });
    case 3: return P(14, 18, <g><path d="M7 0L14 9L7 18L0 9Z" fill={trim} opacity="0.22" /><path d="M0 0L14 18M14 0L0 18" stroke={trim} strokeWidth="0.5" opacity="0.45" /></g>);
    case 4: return P(7, 7, <circle cx="3.5" cy="3.5" r="1.3" fill={trim} opacity="0.42" />);
    case 5: return P(16, 16, <g fill={trim} opacity="0.55"><path d={ICONS[1]} transform="translate(1.5 1.5) scale(0.22)" /><path d={ICONS[1]} transform="translate(10 9.5) scale(0.15)" /><circle cx="13" cy="3" r="0.5" /><circle cx="4" cy="12" r="0.45" /></g>);
    case 6: return P(12, 7, <path d="M0 3.5 Q3 0.5 6 3.5 T12 3.5" stroke={trim} fill="none" strokeWidth="0.9" opacity="0.5" />);
    case 7: return P(8, 7, <path d="M0 7A4 4 0 0 1 8 7M-4 3.5A4 4 0 0 1 4 3.5M4 3.5A4 4 0 0 1 12 3.5" stroke={trim} fill={shade(color, -0.12)} strokeWidth="0.7" opacity="0.55" />);
    case 8: return P(16, 16, <g><rect y="5" width="16" height="4" fill={trim} opacity="0.2" /><rect x="5" width="4" height="16" fill={trim} opacity="0.2" /><rect y="12.5" width="16" height="1" fill="#000" opacity="0.22" /><rect x="12.5" width="1" height="16" fill="#000" opacity="0.22" /></g>);
    case 9: return P(10, 10, <g fill={trim} opacity="0.2"><rect width="5" height="5" /><rect x="5" y="5" width="5" height="5" /></g>);
    default: return null;
  }
}

// the back of a sleeved card (fills whatever box it's in)
export const Sleeve = memo(function Sleeve({ code, avatar }) {
  const uid = useId().replace(/:/g, '');
  const [p, c, t, e] = parse(code, SLEEVE);
  const color = COLORS[c], trim = TRIMS[t];
  return (
    <svg className="sleeve" viewBox="0 0 63 88" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id={`b${uid}`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={shade(color, 0.18)} /><stop offset="1" stopColor={shade(color, -0.28)} /></linearGradient>
        {pattern(p, `p${uid}`, trim, color)}
      </defs>
      <rect width="63" height="88" fill={`url(#b${uid})`} />
      {p >= 2 ? <rect width="63" height="88" fill={`url(#p${uid})`} /> : null}
      <rect x="3.3" y="3.3" width="56.4" height="81.4" rx="2.4" fill="none" stroke={trim} strokeWidth="1.1" opacity="0.9" />
      <Emblem e={e} cx={31.5} cy={44} r={11.5} color={color} trim={trim} avatar={avatar} />
      {p === 1 ? <path d="M-5 34L68 -8V10L-5 52Z" fill="#fff" opacity="0.14" /> : null}
    </svg>
  );
});

// a deck box, lid open, the sleeved deck showing at the top
export const DeckBox = memo(function DeckBox({ code, sleeve, label = '', size = 120, avatar }) {
  const uid = useId().replace(/:/g, '');
  const [m, c, t, e] = parse(code, BOX);
  const color = COLORS[c], trim = TRIMS[t];
  const [, sc, st] = sleeve ? parse(sleeve, SLEEVE) : [0, 7, 1];
  const scol = sleeve ? COLORS[sc] : '#3a2a1c', strim = sleeve ? TRIMS[st] : '#c9a46a';
  const front = m === 3 ? `url(#m${uid})` : m === 5 ? `url(#v${uid})` : `url(#f${uid})`;
  const name = label.length > 16 ? label.slice(0, 15) + '…' : label;
  return (
    <svg className="deckbox" width={size} height={(size * 112) / 104} viewBox="0 0 104 112" role="img" aria-label={`${label} deck box`}>
      <defs>
        <linearGradient id={`f${uid}`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={shade(color, m === 1 ? 0.02 : 0.16)} /><stop offset="1" stopColor={shade(color, m === 1 ? -0.35 : -0.22)} /></linearGradient>
        <linearGradient id={`m${uid}`} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor={shade(color, 0.35)} /><stop offset="0.45" stopColor={color} /><stop offset="0.6" stopColor={shade(color, 0.42)} /><stop offset="1" stopColor={shade(color, -0.2)} /></linearGradient>
        <radialGradient id={`v${uid}`} cx="45%" cy="40%" r="75%"><stop offset="0" stopColor={shade(color, 0.12)} /><stop offset="1" stopColor={shade(color, -0.42)} /></radialGradient>
      </defs>
      <ellipse cx="54" cy="105" rx="42" ry="4.5" fill="rgba(0,0,0,0.35)" />
      {/* the lid, flipped open behind */}
      <path d="M30 28L90 28L95 5L35 5Z" fill={shade(color, -0.45)} stroke={shade(color, -0.6)} strokeWidth="0.6" />
      <path d="M35 5L95 5" stroke={trim} strokeWidth="1" opacity="0.8" />
      <path d="M14 38L30 28L90 28L74 38Z" fill="#120e0a" />
      {/* the deck inside: three sleeved cards at different depths */}
      {[0.72, 0.46, 0.2].map(k => <g key={k}><path d={`M${16 + 16 * k} ${25 - 10 * k}H${72 + 16 * k}V46H${16 + 16 * k}Z`} fill={shade(scol, -0.12 + k * 0.1)} /><path d={`M${16 + 16 * k} ${25 - 10 * k}H${72 + 16 * k}`} stroke={strim} strokeWidth="0.8" opacity="0.85" /></g>)}
      {m === 4 ? <rect x="16" y="40" width="56" height="60" fill={scol} /> : null}
      <path d="M74 38L90 28L90 92L74 102Z" fill={shade(color, m === 4 ? -0.1 : -0.38)} opacity={m === 4 ? 0.6 : 1} />
      <rect x="14" y="38" width="60" height="64" fill={front} opacity={m === 4 ? 0.5 : 1} />
      {m === 0 ? <path d="M14 70L74 44V54L14 80Z" fill="#fff" opacity="0.12" /> : null}
      {m === 1 ? <g fill="none" stroke={trim} strokeWidth="0.7" strokeDasharray="2 1.4" opacity="0.8"><rect x="17.5" y="41.5" width="53" height="57" rx="2" /><path d="M77 39.5L87.5 33V89.5L77 96" /></g> : null}
      {m === 2 ? <g fill="none" stroke={shade(color, -0.4)} strokeWidth="0.6" opacity="0.6"><path d="M14 48C30 45 50 52 74 47M14 59C34 62 52 55 74 60M14 73C28 70 48 77 74 72M14 88C36 85 52 91 74 87" /><path d="M80 40C84 52 79 64 85 80" /></g> : null}
      {m === 3 ? <g fill={trim}><circle cx="18" cy="42" r="1.3" /><circle cx="70" cy="42" r="1.3" /><circle cx="18" cy="98" r="1.3" /><circle cx="70" cy="98" r="1.3" /></g> : null}
      {m === 4 ? <path d="M16 44L40 40V98L16 100Z" fill="#fff" opacity="0.12" /> : null}
      <path d="M14 38H74L90 28" fill="none" stroke={shade(color, 0.45)} strokeWidth="0.8" opacity="0.7" />
      <path d="M14 102H74L90 92" fill="none" stroke={shade(color, -0.6)} strokeWidth="0.8" opacity="0.6" />
      <Emblem e={e} cx={44} cy={63} r={12.5} color={color} trim={trim} avatar={avatar} />
      {name ? <g><rect x="19" y="84" width="50" height="11" rx="2" fill={trim} opacity="0.95" /><text x="44" y="91.6" textAnchor="middle" fontSize="6" fontWeight="700" fontFamily="system-ui, sans-serif" fill={t === 3 ? '#f4f1ea' : '#1c1712'} {...(name.length > 12 ? { textLength: 46, lengthAdjust: 'spacingAndGlyphs' } : {})}>{name}</text></g> : null}
    </svg>
  );
});

// ---- choosing them
function EmblemPicker({ value, onPick, color, trim }) {
  return (
    <div className="ds-emblems" role="radiogroup" aria-label="Emblem">
      {EMBLEMS.map((n, i) => (
        <button key={n} role="radio" aria-checked={value === i} className={value === i ? 'on' : ''} title={n} aria-label={n} onClick={() => onPick(i)}>
          {i ? <svg viewBox="0 0 30 30" width="30" height="30"><Emblem e={i} cx={15} cy={15} r={13} color={color} trim={trim} /></svg> : <span>None</span>}
        </button>
      ))}
    </div>
  );
}

export function DeckStyleEditor({ kind, deck, colors, onClose }) {
  const saved = savedStyle(kind, deck.id);
  const box0 = saved.b || defaultBox(deck.id, colors);
  const [b, setB] = useState(() => parse(box0, BOX));
  // no sleeves yet: start from ones that match the box
  const [s, setS] = useState(() => (saved.s ? parse(saved.s, SLEEVE) : [0, parse(box0, BOX)[1], parse(box0, BOX)[2], parse(box0, BOX)[3]]));
  const [plain, setPlain] = useState(!saved.s);
  const [tab, setTab] = useState('sleeves');
  const sc = s.join('.'), bc = b.join('.');
  const setSl = (i, v) => { setPlain(false); setS(cur => cur.map((x, k) => (k === i ? v : x))); };
  const setBx = (i, v) => setB(cur => cur.map((x, k) => (k === i ? v : x)));
  const surprise = () => {
    const r = n => Math.floor(Math.random() * n);
    const col = r(COLORS.length), tr = r(TRIMS.length), em = r(EMBLEMS.length - 1);
    setPlain(false);
    setS([r(PATTERNS.length), col, tr, em]);
    setB([r(MATERIALS.length), col, tr, em]);
  };
  return (
    <Modal label="Sleeves and deck box" onClose={onClose}>
      <h2>Sleeves and deck box</h2>
      <p className="sub">For <b>{deck.name}</b>. Your sleeves are the backs of your cards at the table; friends in a room see both.</p>
      <div className="ds-editor">
        <div className="ds-preview">
          <DeckBox code={bc} sleeve={plain ? null : sc} label={deck.name} size={176} />
          <div className="ds-fan" aria-label="Your sleeves">
            {[-1, 0, 1].map(i => <div key={i} className={`ds-back ${plain ? 'plain' : ''}`} style={{ '--r': `${i * 9}deg`, '--x': `${i * 34}px` }}>{plain ? <div className={kind === 'pk' ? 'pk-card back' : 'card back'}>{kind === 'pk' ? <span className="ball" /> : <div className="oval" />}</div> : <Sleeve code={sc} />}</div>)}
          </div>
          <button className="btn sm" onClick={surprise}>Surprise me</button>
        </div>
        <div className="ds-options">
          <div className="seg ds-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'sleeves'} className={tab === 'sleeves' ? 'on' : ''} onClick={() => setTab('sleeves')}>Sleeves</button>
            <button role="tab" aria-selected={tab === 'box'} className={tab === 'box' ? 'on' : ''} onClick={() => setTab('box')}>Deck box</button>
          </div>
          {tab === 'sleeves' ? <>
            <div className="av-row"><span className="label">Pattern</span><Choices list={PATTERNS} value={plain ? -1 : s[0]} onPick={v => setSl(0, v)} label="Sleeve pattern" /></div>
            <div className="av-row"><span className="label">Color</span><Swatches list={COLORS} value={plain ? -1 : s[1]} onPick={v => setSl(1, v)} label="Sleeve color" /></div>
            <div className="av-row"><span className="label">Trim</span><Swatches list={TRIMS} value={plain ? -1 : s[2]} onPick={v => setSl(2, v)} label="Sleeve trim" /></div>
            <div className="av-row"><span className="label">Emblem</span><EmblemPicker value={plain ? -1 : s[3]} onPick={v => setSl(3, v)} color={COLORS[s[1]]} trim={TRIMS[s[2]]} /></div>
            <label className="checkline"><input type="checkbox" checked={plain} onChange={e => setPlain(e.target.checked)} /> No sleeves (plain card backs)</label>
          </> : <>
            <div className="av-row"><span className="label">Material</span><Choices list={MATERIALS} value={b[0]} onPick={v => setBx(0, v)} label="Box material" /></div>
            <div className="av-row"><span className="label">Color</span><Swatches list={COLORS} value={b[1]} onPick={v => setBx(1, v)} label="Box color" /></div>
            <div className="av-row"><span className="label">Trim</span><Swatches list={TRIMS} value={b[2]} onPick={v => setBx(2, v)} label="Box trim" /></div>
            <div className="av-row"><span className="label">Emblem</span><EmblemPicker value={b[3]} onPick={v => setBx(3, v)} color={COLORS[b[1]]} trim={TRIMS[b[2]]} /></div>
            {!plain ? <button className="btn sm ghost ds-match" onClick={() => setB(cur => [cur[0], s[1], s[2], s[3]])}>Match my sleeves</button> : null}
          </>}
        </div>
      </div>
      <div className="dlg-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={() => { saveDeckStyle(kind, deck.id, { s: plain ? null : sc, b: bc }); onClose(); }}>Save</button>
      </div>
    </Modal>
  );
}

// the deck's box in a lobby, with the button that opens the editor
export function DeckStyleButton({ kind, deck, colors }) {
  const [open, setOpen] = useState(false);
  React.useSyncExternalStore(subscribeDeckStyles, deckStylesVersion);
  const st = savedStyle(kind, deck.id);
  return (
    <div className="ds-lobby">
      <button className="ds-boxbtn" onClick={() => setOpen(true)} title="Change sleeves and deck box"><DeckBox code={st.b || defaultBox(deck.id, colors)} sleeve={st.s} label={deck.name} size={92} /></button>
      <div className="ds-lobby-side">
        <button className="btn sm" onClick={() => setOpen(true)}>Sleeves &amp; box</button>
        <span className="note">{st.s ? 'Sleeved' : 'No sleeves yet'}</span>
      </div>
      {open ? <DeckStyleEditor kind={kind} deck={deck} colors={colors} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
