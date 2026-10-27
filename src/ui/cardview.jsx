// Card rendering: mana symbols (Mana font), rules text, card faces (real card images when packed, drawn frames otherwise).
import { costSymbols } from '../engine/mana.js';
import { counterName } from '../engine/game.js';
import { KEYWORD_COUNTERS } from '../engine/chars.js';
import { imageOf, cardImage, imageFailed, imageBroken } from './images.js';
import { Sleeve } from './deckstyle.jsx';

const HYBRID = ['wu', 'wb', 'ub', 'ur', 'br', 'bg', 'rw', 'rg', 'gw', 'gu'];
function msClass(sym) {
  const s = String(sym).toLowerCase();
  if (/^\d+$/.test(s)) return +s <= 20 ? 'ms-' + s : null;
  if (/^[wubrgcsxyze]$/.test(s)) return 'ms-' + s;
  if (s === 't') return 'ms-tap';
  if (s === 'q') return 'ms-untap';
  if (s === 'chaos') return 'ms-chaos';
  const parts = s.split('/');
  const phy = parts[parts.length - 1] === 'p';
  const core = phy ? parts.slice(0, -1) : parts;
  if (core.length === 1 && phy) return /^[wubrg]$/.test(core[0]) ? `ms-${core[0]}p` : null;
  if (core.length === 2) {
    if (core[0] === '2' || core[0] === 'c') return `ms-${core[0]}${core[1]}`;
    const pair = HYBRID.find(h => (h[0] === core[0] && h[1] === core[1]) || (h[0] === core[1] && h[1] === core[0]));
    if (pair) return `ms-${pair}${phy ? 'p' : ''}`;
  }
  return null;
}

export function Pip({ s }) {
  const cls = msClass(s);
  const label = `{${String(s).toUpperCase()}}`;
  // "spend mana as though it were any color" turns a symbol into one any color pays for
  if (/^w\/u\/b\/r\/g$/i.test(s)) return <span className="pip anycolor" title="Any color" aria-label="any color" />;
  if (cls) return <i className={`ms ${cls} ms-cost ms-shadow`} title={label} aria-label={label} />;
  return <span className="pip" title={label}>{String(s).toUpperCase()}</span>;
}

export function ManaCost({ cost, x }) {
  if (!cost) return null;
  const syms = costSymbols(cost, x);
  if (!syms.length || (syms.length === 1 && syms[0] === '0' && cost.generic === 0)) return syms[0] === '0' ? <span className="mana"><Pip s="0" /></span> : null;
  return <span className="mana">{syms.map((s, i) => <Pip key={i} s={s} />)}</span>;
}

export function ManaString({ str }) {
  const parts = String(str || '').split(/(\{[^}]+\})/);
  return <>{parts.map((p, i) => /^\{[^}]+\}$/.test(p) ? <Pip key={i} s={p.slice(1, -1)} /> : <span key={i}>{p}</span>)}</>;
}

export function RulesText({ text }) {
  if (!text) return null;
  return <ManaString str={text} />;
}

const TYPE_ICON = ['Planeswalker', 'Battle', 'Creature', 'Land', 'Artifact', 'Enchantment', 'Instant', 'Sorcery'];
export function TypeGlyph({ types }) {
  const t = TYPE_ICON.find(x => types.includes(x)) || 'Artifact';
  return <i className={`ms ms-${t.toLowerCase()} glyph`} aria-hidden="true" />;
}

export function LandArt({ v }) {
  const cols = v.produces || [];
  if (!cols.length) return <TypeGlyph types={v.types} />;
  return <span className="landpips">{cols.slice(0, 3).map(c => <Pip key={c} s={c} />)}</span>;
}

const KW_ABBR = { Flying: 'FLY', Trample: 'TRM', Deathtouch: 'DTH', Lifelink: 'LNK', Vigilance: 'VIG', Haste: 'HST', 'First Strike': '1ST', 'Double Strike': '2×', Menace: 'MEN', Reach: 'RCH', Hexproof: 'HEX', Indestructible: 'IND', Defender: 'DEF', Shroud: 'SHR', Infect: 'INF', Ward: 'WRD', Flash: 'FL', Protection: 'PRO', Prowess: 'PRW', Fear: 'FEAR', Intimidate: 'INT', Wither: 'WTH', Toxic: 'TOX', Changeling: 'CHG' };

export function kwAbbrs(keywords) {
  const out = [];
  for (const k of keywords) {
    const base = k.split(':')[0].replace(/^Protection.*/, 'Protection').replace(/^Hexproof.*/, 'Hexproof');
    const a = KW_ABBR[base];
    if (a && !out.includes(a)) out.push(a);
  }
  return out;
}

export function frameFor(colors, types) {
  if (types.includes('Land') && colors.length === 0) return 'frame-L';
  if (colors.length === 0) return 'frame-C';
  if (colors.length > 1) return 'frame-M';
  return 'frame-' + colors[0];
}

// Build a view model from a live card in a game
export function viewOf(game, card) {
  const ch = game.chars(card);
  const face = card.faceDef;
  const types = [...ch.types];
  const isCreature = types.includes('Creature');
  const typeLine = card.faceDown ? 'Face-down creature' : [[...ch.supertypes, ...types].join(' '), [...ch.subtypes].join(' ')].filter(Boolean).join(' — ');
  let oracle = card.faceDown ? 'A face-down 2/2 creature.' : (face.oracle || '');
  if (!oracle && card.token) oracle = ch.keywords.filter(k => !k.includes('$')).join(', ');
  const bp = /^\d+$/.test(face.power || '') ? +face.power : null, bt = /^\d+$/.test(face.toughness || '') ? +face.toughness : null;
  const kws = kwAbbrs(ch.keywords);
  const printed = kwAbbrs(face.keywords || []);
  return {
    id: card.id, name: game.name(card) || 'Face-down card', cost: card.faceDown ? null : ch.manaCost, typeLine, types, colors: [...ch.colors],
    oracle, power: isCreature ? ch.power : null, toughness: isCreature ? ch.toughness : null,
    ptState: isCreature && bp != null ? (ch.power > bp || ch.toughness > bt ? 'up' : ch.power < bp || ch.toughness < bt ? 'down' : '') : '',
    loyalty: types.includes('Planeswalker') && !isCreature ? (card.counters.LOYALTY || 0) : null,
    defense: types.includes('Battle') ? (card.counters.DEFENSE || 0) : null,
    keywords: kws, granted: kws.filter(k => !printed.includes(k)),
    counters: Object.entries(card.counters || {}).filter(([k, n]) => n > 0 && k !== 'LOYALTY' && k !== 'DEFENSE'),
    damage: card.damage || 0, tapped: !!card.tapped, token: !!card.token, faceDown: !!card.faceDown,
    sick: isCreature && card.zone === 'battlefield' && card.sick && !game.hasKeywordIn(ch, 'Haste'),
    produces: types.includes('Land') && !isCreature ? landColors(ch, game, card) : null,
    isCommander: !!card.isCommander, xPaid: card.xPaid, onField: card.zone === 'battlefield',
    img: imageOf(game, card),
  };
}

function landColors(ch, game, card) {
  const out = new Set();
  for (const a of ch.abilities) {
    if (a.parsed.api !== 'Mana' && a.parsed.api !== 'ManaReflected') continue;
    const pr = a.parsed.p.Produced || '';
    if (a.parsed.api === 'ManaReflected' || /Any|ColorIdentity|Chosen/.test(pr)) { (pr.includes('ColorIdentity') ? game.players[card.controller].colorIdentity : ['W', 'U', 'B', 'R', 'G']).forEach(c => out.add(c)); if (pr.includes('Chosen') && card.chosen && card.chosen.colors) card.chosen.colors.forEach(c => out.add(c)); continue; }
    for (const t of pr.split(/\s+/)) if (/^[WUBRGC]$/.test(t)) out.add(t);
  }
  const arr = ['W', 'U', 'B', 'R', 'G', 'C'].filter(c => out.has(c));
  return arr.length === 5 ? ['W', 'U', 'B', 'R', 'G'] : arr;
}

// View model from a card definition (lobby / dialogs without a live card)
export function viewOfDef(def, face = 0, deckId = null) {
  const f = def.faces[face] || def.faces[0];
  return {
    id: 'def:' + def.name, name: f.name, cost: f.manaCost, typeLine: [[...f.supertypes, ...f.types].join(' '), f.subtypes.join(' ')].filter(Boolean).join(' — '),
    types: f.types, colors: f.colors, oracle: f.oracle, power: f.power, toughness: f.toughness, loyalty: f.loyalty, keywords: kwAbbrs(f.keywords), counters: [], damage: 0,
    img: cardImage(def.name, deckId, face),
  };
}

// generated art for drawn frames: soft color fields from the card's colors, placed by a hash of its name
const HUE = { W: 46, U: 212, B: 285, R: 12, G: 128 };
function artStyle(v) {
  let h = 2166136261;
  for (const ch of v.name || '') { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const r = k => ((h >>> (k * 3)) & 255) / 255;
  const cols = (v.colors || []).length ? v.colors : (v.types || []).includes('Land') ? [] : ['C'];
  const base = cols.length ? cols.map(c => HUE[c] ?? 200) : [34];
  const h1 = (base[0] + Math.round((r(1) - 0.5) * 40) + 360) % 360;
  const h2 = (base[base.length - 1] + Math.round((r(2) - 0.5) * 60) + 360) % 360;
  const sat = cols.includes('C') || !cols.length ? 12 : 48;
  return {
    '--h1': h1, '--h2': h2, '--sat': sat + '%',
    '--ax': `${Math.round(15 + r(3) * 70)}%`, '--ay': `${Math.round(20 + r(4) * 60)}%`,
    '--bx': `${Math.round(15 + r(5) * 70)}%`, '--by': `${Math.round(30 + r(6) * 60)}%`,
    '--ang': `${Math.round(r(7) * 360)}deg`,
  };
}

// sleeve: { code, av } when the owner sleeved their deck (see deckstyle.jsx)
export function CardBack({ cls = '', sleeve }) {
  if (sleeve && sleeve.code) return <div className={`card back sleeved ${cls}`} aria-label="Card back"><Sleeve code={sleeve.code} avatar={sleeve.av} /></div>;
  return <div className={`card back ${cls}`} aria-label="Card back"><div className="oval" /></div>;
}

export function CardFace({ v, size = 'mini', cls = '', onClick, onContextMenu, onEnter, onLeave, badges = null, title }) {
  if (!v) return null;
  const img = v.img && !v.faceDown && !imageBroken(v.img) ? v.img : null;
  const showText = size !== 'mini' && size !== 'stack';
  const frame = v.faceDown ? 'facedown' : frameFor(v.colors, v.types);
  const classes = ['card', img ? 'has-img' : frame, v.token ? 'token' : '', v.sick ? 'sick' : '', cls].filter(Boolean).join(' ');
  const handlers = {
    onClick, onContextMenu, onMouseEnter: onEnter, onMouseLeave: onLeave, title: title || (img ? v.name : undefined),
    role: onClick ? 'button' : undefined, tabIndex: onClick ? 0 : undefined,
    onKeyDown: onClick ? (e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e); } }) : undefined,
  };
  // on a card picture the printed P/T shows; the badge is for small battlefield cards and changed values
  const showPT = v.power != null && v.toughness != null && (!img || (v.onField && size !== 'big') || v.ptState);
  const extraKw = img ? (v.granted || []) : (v.keywords || []);
  return (
    <div className={classes} {...handlers} aria-label={handlers.role ? v.name : undefined}>
      {img ? <img className="cimg" src={img} alt={v.name} draggable="false" onError={() => imageFailed(img)} /> : (
        <div className="inner">
          <div className="cname"><span className="nm">{v.name}</span>{v.cost ? <ManaCost cost={v.cost} /> : null}</div>
          <div className="art" style={artStyle(v)}>{v.produces ? <LandArt v={v} /> : <TypeGlyph types={v.types} />}</div>
          <div className="ctype">{v.typeLine}</div>
          {showText ? <div className="text"><RulesText text={v.oracle} /></div> : null}
        </div>
      )}
      {extraKw.length && size !== 'big' ? <div className="kws">{extraKw.slice(0, size === 'mini' ? 3 : 6).map(k => <span key={k} className="kw">{k}</span>)}</div> : null}
      {showPT ? <div key={`${v.power}/${v.toughness}`} className={`pt ${v.ptState || ''}`}>{v.power}/{v.toughness}</div> : null}
      {v.loyalty != null && (!img || v.onField) ? <div key={`l${v.loyalty}`} className="loyal">{v.loyalty}</div> : null}
      {v.defense != null && (!img || v.onField) ? <div className="loyal">{v.defense}</div> : null}
      <div className="badges">
        {v.counters && v.counters.map(([k, n]) => <span key={`${k}${n}`} className={`badge ${k === 'M1M1' ? 'minus' : k === 'P1P1' ? 'plus' : 'ctr'}`} title={`${n} ${counterName(k)} counter(s)`}>{k === 'P1P1' ? `+${n}` : k === 'M1M1' ? `−${n}` : KEYWORD_COUNTERS[k] ? (KW_ABBR[KEYWORD_COUNTERS[k]] || counterName(k)) : `${n} ${counterName(k).slice(0, 6)}`}</span>)}
        {v.damage ? <span key={`dmg${v.damage}`} className="badge dmg" title={`${v.damage} damage`}>{v.damage} dmg</span> : null}
        {badges}
      </div>
    </div>
  );
}
