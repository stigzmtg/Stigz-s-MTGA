// Customizable avatars for friends' games: little animals with human bodies, drawn as SVG (sharp at any size, nothing
// to download). An avatar is a short code "animal.fur.outfit.color.hat.extra.bg" (indexes into the lists below) that
// travels in room presence and seats; each person picks theirs in the friends panel.
import { safeStorage } from './common.js';
import { Modal } from './dialogs.jsx';

const { useState, useId } = React;

const ANIMALS = [
  { id: 'cat', name: 'Cat', fur: ['#e8a05a', '#9aa0a8', '#3d3a40', '#f1dfc0'] },
  { id: 'dog', name: 'Dog', fur: ['#c9965f', '#8a5a3c', '#f2ede4', '#e3b45c'] },
  { id: 'fox', name: 'Fox', fur: ['#e5793a', '#eef0f2', '#8d8f99'] },
  { id: 'bear', name: 'Bear', fur: ['#8b5e3c', '#f4f4f0', '#3b3330'] },
  { id: 'rabbit', name: 'Rabbit', fur: ['#f3efe8', '#b8b4ae', '#a7795a'] },
  { id: 'panda', name: 'Panda', fur: ['#f7f6f2'] },
  { id: 'raccoon', name: 'Raccoon', fur: ['#8e9097', '#a59a8c'] },
  { id: 'frog', name: 'Frog', fur: ['#6cc070', '#5fb4d9', '#e9cf4a'] },
  { id: 'owl', name: 'Owl', fur: ['#9a6b45', '#eeeeea', '#7f7f86'] },
  { id: 'mouse', name: 'Mouse', fur: ['#b5b2ad', '#a68161', '#f2efe9'] },
];
const OUTFITS = ['T-shirt', 'Hoodie', 'Jacket', 'Sweater', 'Wizard robe', 'Knight armor'];
const COLORS = ['#d94b4b', '#f08c2e', '#f2c230', '#4caf6a', '#2fa3a3', '#3f7fd9', '#8b5cd6', '#e86aa6', '#35383f'];
const HATS = ['No hat', 'Cap', 'Beanie', 'Wizard hat', 'Crown', 'Flower crown', 'Headphones', 'Top hat'];
const EXTRAS = ['Nothing', 'Glasses', 'Sunglasses', 'Bow tie', 'Scarf', 'Medal'];
const BGS = ['#2c5d47', '#2d4c8a', '#6b3a7a', '#8a3b3b', '#b07a2a', '#3a6f7a', '#45474f'];
const PARTS = [['a', ANIMALS.length], ['f', 4], ['o', OUTFITS.length], ['c', COLORS.length], ['h', HATS.length], ['x', EXTRAS.length], ['b', BGS.length]];

// ---- codes
export function parseAvatar(code) {
  const v = String(code || '').split('.').map(n => parseInt(n, 10));
  const out = {};
  PARTS.forEach(([k, n], i) => { out[k] = Number.isInteger(v[i]) && v[i] >= 0 && v[i] < n ? v[i] : 0; });
  out.f = Math.min(out.f, ANIMALS[out.a].fur.length - 1);
  return out;
}
export const avatarCode = a => PARTS.map(([k]) => a[k] || 0).join('.');
export const isAvatarCode = c => typeof c === 'string' && /^\d+(\.\d+){6}$/.test(c);
// a random one, or one picked from a seed (so everyone starts out different)
export function randomAvatar(seed = Math.random() * 1e9) {
  let s = Math.floor(seed) >>> 0;
  const r = n => { s = (s * 1103515245 + 12345) >>> 0; return (s >>> 8) % n; };
  const a = r(ANIMALS.length);
  return avatarCode({ a, f: r(ANIMALS[a].fur.length), o: r(OUTFITS.length), c: r(COLORS.length), h: r(3) === 0 ? r(HATS.length) : 0, x: r(3) === 0 ? r(EXTRAS.length) : 0, b: r(BGS.length) });
}

// yours: the one you saved, or one picked from your player id until you choose
export function myAvatar(cid = safeStorage.getItem('pa-cid')) {
  const saved = safeStorage.getItem('pa-avatar');
  if (isAvatarCode(saved)) return saved;
  let h = 7; for (const ch of String(cid || 'guest')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return randomAvatar(h);
}
export const saveAvatar = code => safeStorage.setItem('pa-avatar', code);

// ---- drawing
export function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.max(0, Math.min(255, Math.round(amt < 0 ? v * (1 + amt) : v + (255 - v) * amt)));
  return '#' + [n >> 16, (n >> 8) & 255, n & 255].map(ch).map(v => v.toString(16).padStart(2, '0')).join('');
}
const INK = '#2a2220';
const EYES = { frog: [[45, 41], [75, 41]], rabbit: [[52, 55], [68, 55]], mouse: [[52, 55], [68, 55]] };
const HAT_DY = { frog: -9, owl: -2, rabbit: 2, mouse: 2 };

function Eye({ x, y }) {
  return <g><ellipse cx={x} cy={y} rx="3.3" ry="4.1" fill={INK} /><circle cx={x + 1.1} cy={y - 1.4} r="1.2" fill="#fff" /></g>;
}
const smile = (y = 65) => <path d={`M55 ${y} Q60 ${y + 4} 65 ${y}`} fill="none" stroke={INK} strokeWidth="1.7" strokeLinecap="round" />;
const whiskers = y => <g stroke="rgba(0,0,0,0.35)" strokeWidth="1" strokeLinecap="round"><path d={`M48 ${y} L36 ${y - 3} M48 ${y + 3} L36 ${y + 4} M72 ${y} L84 ${y - 3} M72 ${y + 3} L84 ${y + 4}`} /></g>;

// ears and the like behind the head, the head, then the face
function animal(id, fur) {
  const dark = shade(fur, -0.3), light = shade(fur, 0.45), pink = '#f2a3b3';
  const eyes = (EYES[id] || [[51, 53], [69, 53]]).map(([x, y], i) => <Eye key={i} x={x} y={y} />);
  switch (id) {
    case 'cat': return { back: <g><path d="M37 44 L39 17 L57 32 Z" fill={fur} /><path d="M83 44 L81 17 L63 32 Z" fill={fur} /><path d="M41 38 L42 24 L51 32 Z" fill={pink} /><path d="M79 38 L78 24 L69 32 Z" fill={pink} /></g>,
      head: <circle cx="60" cy="54" r="25" fill={fur} />,
      face: <g>{eyes}<ellipse cx="60" cy="63" rx="9" ry="6" fill={light} /><path d="M57.4 59.5 H62.6 L60 62.4 Z" fill="#e98a9a" />{whiskers(62)}<path d="M60 62.4 Q57.5 66 55 64 M60 62.4 Q62.5 66 65 64" fill="none" stroke={INK} strokeWidth="1.4" strokeLinecap="round" /></g> };
    case 'dog': return { back: null, head: <circle cx="60" cy="54" r="25" fill={fur} />,
      face: <g><ellipse cx="36" cy="54" rx="8" ry="17" transform="rotate(16 36 54)" fill={dark} /><ellipse cx="84" cy="54" rx="8" ry="17" transform="rotate(-16 84 54)" fill={dark} />{eyes}<ellipse cx="60" cy="64" rx="11" ry="8" fill={light} /><ellipse cx="60" cy="60" rx="4.2" ry="3" fill={INK} /><path d="M60 63 V66 M60 66 Q56 69 53 66 M60 66 Q64 69 67 66" fill="none" stroke={INK} strokeWidth="1.4" strokeLinecap="round" /><ellipse cx="62.5" cy="69.5" rx="2.6" ry="2" fill={pink} /></g> };
    case 'fox': return { back: <g><path d="M36 44 L39 13 L56 30 Z" fill={fur} /><path d="M84 44 L81 13 L64 30 Z" fill={fur} /><path d="M39 13 L38 24 L46 21 Z" fill="#3a2a22" /><path d="M81 13 L82 24 L74 21 Z" fill="#3a2a22" /><path d="M41 37 L41 25 L50 31 Z" fill="#f7f3ec" /><path d="M79 37 L79 25 L70 31 Z" fill="#f7f3ec" /></g>,
      head: <g><ellipse cx="60" cy="54" rx="27" ry="24" fill={fur} /><path d="M34 57 Q60 86 86 57 Q73 67 60 67 Q47 67 34 57 Z" fill="#f7f3ec" /></g>,
      face: <g>{eyes}<ellipse cx="60" cy="63" rx="3.2" ry="2.5" fill={INK} />{smile(66)}</g> };
    case 'bear': return { back: <g><circle cx="38" cy="33" r="9.5" fill={fur} /><circle cx="82" cy="33" r="9.5" fill={fur} /><circle cx="38" cy="33" r="5" fill={dark} /><circle cx="82" cy="33" r="5" fill={dark} /></g>,
      head: <circle cx="60" cy="55" r="26" fill={fur} />,
      face: <g>{eyes}<ellipse cx="60" cy="64" rx="10.5" ry="8" fill={light} /><ellipse cx="60" cy="60.5" rx="4.6" ry="3.1" fill={INK} />{smile(66)}</g> };
    case 'rabbit': return { back: <g><ellipse cx="49" cy="19" rx="6.5" ry="19" transform="rotate(-8 49 19)" fill={fur} /><ellipse cx="71" cy="19" rx="6.5" ry="19" transform="rotate(8 71 19)" fill={fur} /><ellipse cx="49" cy="20" rx="3" ry="13" transform="rotate(-8 49 20)" fill={pink} /><ellipse cx="71" cy="20" rx="3" ry="13" transform="rotate(8 71 20)" fill={pink} /></g>,
      head: <circle cx="60" cy="57" r="24" fill={fur} />,
      face: <g>{eyes}<circle cx="56.5" cy="64" r="4.5" fill={light} /><circle cx="63.5" cy="64" r="4.5" fill={light} /><path d="M58 61 H62 L60 63 Z" fill="#e98a9a" /><rect x="58" y="66.5" width="4" height="4" rx="0.8" fill="#fff" stroke="rgba(0,0,0,0.25)" strokeWidth="0.6" /></g> };
    case 'panda': return { back: <g><circle cx="38" cy="33" r="9.5" fill="#26262b" /><circle cx="82" cy="33" r="9.5" fill="#26262b" /></g>,
      head: <circle cx="60" cy="55" r="26" fill={fur} />,
      face: <g><ellipse cx="50" cy="53" rx="7" ry="9" transform="rotate(-28 50 53)" fill="#26262b" /><ellipse cx="70" cy="53" rx="7" ry="9" transform="rotate(28 70 53)" fill="#26262b" /><circle cx="51" cy="52.5" r="2.8" fill="#fff" /><circle cx="69" cy="52.5" r="2.8" fill="#fff" /><circle cx="51.6" cy="52.8" r="1.4" fill={INK} /><circle cx="68.4" cy="52.8" r="1.4" fill={INK} /><ellipse cx="60" cy="61.5" rx="4.4" ry="3" fill="#26262b" />{smile(66)}</g> };
    case 'raccoon': return { back: <g><path d="M36 42 Q36 20 52 30 Z" fill={fur} stroke="#f1eee8" strokeWidth="2" /><path d="M84 42 Q84 20 68 30 Z" fill={fur} stroke="#f1eee8" strokeWidth="2" /></g>,
      head: <circle cx="60" cy="55" r="25.5" fill={fur} />,
      face: <g><path d="M34 52 Q47 43 60 51 Q73 43 86 52 Q85 61 72 59 Q60 55 48 59 Q35 61 34 52 Z" fill="#36363d" /><path d="M42 45 Q50 40 57 45 M63 45 Q70 40 78 45" stroke="#f1eee8" strokeWidth="2" fill="none" strokeLinecap="round" /><circle cx="51" cy="52.5" r="2.6" fill="#fff" /><circle cx="69" cy="52.5" r="2.6" fill="#fff" /><circle cx="51.4" cy="52.8" r="1.3" fill={INK} /><circle cx="68.6" cy="52.8" r="1.3" fill={INK} /><ellipse cx="60" cy="65" rx="9" ry="6.5" fill="#f1eee8" /><ellipse cx="60" cy="61.5" rx="3.8" ry="2.7" fill={INK} />{smile(66)}</g> };
    case 'frog': return { back: <g><circle cx="45" cy="41" r="10.5" fill={fur} /><circle cx="75" cy="41" r="10.5" fill={fur} /></g>,
      head: <ellipse cx="60" cy="60" rx="30" ry="20" fill={fur} />,
      face: <g><circle cx="45" cy="41" r="7" fill="#fff" /><circle cx="75" cy="41" r="7" fill="#fff" /><circle cx="46" cy="42" r="3.6" fill={INK} /><circle cx="74" cy="42" r="3.6" fill={INK} /><circle cx="47" cy="40.6" r="1.1" fill="#fff" /><circle cx="75" cy="40.6" r="1.1" fill="#fff" /><path d="M44 64 Q60 75 76 64" fill="none" stroke={shade(fur, -0.55)} strokeWidth="2" strokeLinecap="round" /><circle cx="40" cy="62" r="3.5" fill={pink} opacity="0.7" /><circle cx="80" cy="62" r="3.5" fill={pink} opacity="0.7" /></g> };
    case 'owl': return { back: <g><path d="M37 38 L35 20 L50 30 Z" fill={dark} /><path d="M83 38 L85 20 L70 30 Z" fill={dark} /></g>,
      head: <circle cx="60" cy="55" r="27" fill={fur} />,
      face: <g><path d="M46 36 L60 44 L74 36" fill="none" stroke={dark} strokeWidth="2" strokeLinecap="round" /><circle cx="50" cy="53" r="10" fill={light} /><circle cx="70" cy="53" r="10" fill={light} /><circle cx="50" cy="53" r="5.6" fill="#f3c23a" /><circle cx="70" cy="53" r="5.6" fill="#f3c23a" /><circle cx="50" cy="53" r="3" fill={INK} /><circle cx="70" cy="53" r="3" fill={INK} /><circle cx="51" cy="51.8" r="1" fill="#fff" /><circle cx="71" cy="51.8" r="1" fill="#fff" /><path d="M56.5 61 H63.5 L60 68 Z" fill="#f08c2e" /></g> };
    case 'mouse': return { back: <g><circle cx="36" cy="33" r="13.5" fill={fur} /><circle cx="84" cy="33" r="13.5" fill={fur} /><circle cx="36" cy="33" r="8.5" fill={pink} /><circle cx="84" cy="33" r="8.5" fill={pink} /></g>,
      head: <circle cx="60" cy="57" r="23" fill={fur} />,
      face: <g>{eyes}<circle cx="60" cy="63.5" r="2.6" fill="#e98a9a" />{whiskers(64)}<path d="M57 66.5 Q60 69 63 66.5" fill="none" stroke={INK} strokeWidth="1.3" strokeLinecap="round" /></g> };
    default: return { back: null, head: <circle cx="60" cy="54" r="25" fill={fur} />, face: eyes };
  }
}

const BODY = 'M16 124 C16 98 33 86 60 86 C87 86 104 98 104 124 Z';
function outfit(o, color) {
  const dark = shade(color, -0.28), light = shade(color, 0.35);
  switch (o) {
    case 1: return { behind: <ellipse cx="60" cy="84" rx="27" ry="12" fill={dark} />, front: <g><path d={BODY} fill={color} /><path d="M46 88 Q60 99 74 88" fill="none" stroke={dark} strokeWidth="4" /><path d="M55 92 L54 106 M65 92 L66 106" stroke="#f5f2ea" strokeWidth="1.8" strokeLinecap="round" /><path d="M40 114 Q60 107 80 114" fill="none" stroke={dark} strokeWidth="2" /></g> };
    case 2: return { front: <g><path d={BODY} fill={color} /><path d="M49 86 L60 108 L71 86 Z" fill="#f5f2ea" /><path d="M49 86 L60 108 L44 100 Z M71 86 L60 108 L76 100 Z" fill={dark} /><circle cx="60" cy="113" r="1.8" fill={dark} /><circle cx="60" cy="119" r="1.8" fill={dark} /></g> };
    case 3: return { front: <g><path d={BODY} fill={color} /><path d="M45 88 Q60 100 75 88" fill="none" stroke={dark} strokeWidth="6" /><path d="M28 108 L36 102 L44 108 L52 102 L60 108 L68 102 L76 108 L84 102 L92 108" fill="none" stroke={light} strokeWidth="3" strokeLinejoin="round" /></g> };
    case 4: return { front: <g><path d={BODY} fill={color} /><path d="M47 86 L60 112 L73 86" fill="none" stroke="#f3c34a" strokeWidth="3.5" strokeLinejoin="round" /><path d="M82 104 l2 4.2 4.6 0.6 -3.4 3.2 0.9 4.6 -4.1 -2.3 -4.1 2.3 0.9 -4.6 -3.4 -3.2 4.6 -0.6 Z" fill="#f3c34a" /></g> };
    case 5: return { front: <g><path d={BODY} fill="#a9b1bb" /><path d="M24 104 Q60 94 96 104" fill="none" stroke="#7d8692" strokeWidth="2" /><path d="M60 92 V124" stroke="#7d8692" strokeWidth="2" /><ellipse cx="26" cy="100" rx="11" ry="8" fill="#c3cad3" /><ellipse cx="94" cy="100" rx="11" ry="8" fill="#c3cad3" /><path d="M34 90 L86 124 L74 124 L28 96 Z" fill={color} opacity="0.95" /></g> };
    default: return { front: <g><path d={BODY} fill={color} /><path d="M47 87 Q60 98 73 87" fill="none" stroke={dark} strokeWidth="3" /></g> };
  }
}

function hat(h, color, dy) {
  const dark = shade(color, -0.3);
  const g = c => <g transform={`translate(0 ${dy})`}>{c}</g>;
  switch (h) {
    case 1: return g(<g><path d="M35 41 Q35 21 60 21 Q85 21 85 41 Z" fill={color} /><path d="M33 41 Q60 35 87 41 Q90 46 60 45 Q30 46 33 41 Z" fill={dark} /><circle cx="60" cy="22" r="2.2" fill={dark} /></g>);
    case 2: return g(<g><path d="M34 43 Q34 16 60 16 Q86 16 86 43 Z" fill={color} /><rect x="33" y="37" width="54" height="8" rx="3" fill={dark} /><circle cx="60" cy="14" r="5.5" fill={shade(color, 0.4)} /></g>);
    case 3: return g(<g><path d="M38 38 L63 -2 L83 38 Z" fill="#5b3fa6" /><ellipse cx="60" cy="38" rx="30" ry="5.5" fill="#4a3290" /><path d="M64 18 l1.5 3.2 3.5 0.5 -2.6 2.4 0.7 3.5 -3.1 -1.7 -3.1 1.7 0.7 -3.5 -2.6 -2.4 3.5 -0.5 Z" fill="#f3c34a" /></g>);
    case 4: return g(<g><path d="M41 36 L41 19 L50 28 L60 14 L70 28 L79 19 L79 36 Z" fill="#f2c230" stroke="#c99a1b" strokeWidth="1.5" strokeLinejoin="round" /><circle cx="60" cy="30" r="2.6" fill="#d94b4b" /><circle cx="49" cy="32" r="1.8" fill="#3f7fd9" /><circle cx="71" cy="32" r="1.8" fill="#3f7fd9" /></g>);
    case 5: return g(<g>{[[38, 36], [46, 30], [55, 27], [65, 27], [74, 30], [82, 36]].map(([x, y], i) => <g key={i}><circle cx={x} cy={y} r="4.6" fill={['#f7a6c4', '#fff4c2', '#f7a6c4', '#ffffff', '#fff4c2', '#f7a6c4'][i]} /><circle cx={x} cy={y} r="1.6" fill="#f2c230" /></g>)}<path d="M42 33 l-3 -4 M78 33 l3 -4" stroke="#4caf6a" strokeWidth="2" strokeLinecap="round" /></g>);
    case 6: return g(<g><path d="M33 52 Q33 22 60 22 Q87 22 87 52" fill="none" stroke="#2f3136" strokeWidth="4.5" /><rect x="27" y="45" width="10" height="16" rx="4" fill={color} stroke="#2f3136" strokeWidth="1.5" /><rect x="83" y="45" width="10" height="16" rx="4" fill={color} stroke="#2f3136" strokeWidth="1.5" /></g>);
    case 7: return g(<g><rect x="45" y="6" width="30" height="28" rx="2" fill="#26262b" /><rect x="45" y="25" width="30" height="5" fill={color} /><ellipse cx="60" cy="34" rx="24" ry="4.5" fill="#26262b" /></g>);
    default: return null;
  }
}

function extra(x, id, color) {
  const [[lx, ly], [rx, ry]] = EYES[id] || [[51, 53], [69, 53]];
  switch (x) {
    case 1: return <g fill="rgba(255,255,255,0.18)" stroke="#2a2a2e" strokeWidth="1.8"><circle cx={lx} cy={ly} r="6.5" /><circle cx={rx} cy={ry} r="6.5" /><path d={`M${lx + 6.5} ${ly} Q60 ${ly - 3} ${rx - 6.5} ${ry}`} fill="none" /></g>;
    case 2: return <g fill="#1d1d22" stroke="#1d1d22" strokeWidth="1.6"><rect x={lx - 7.5} y={ly - 5} width="15" height="10" rx="4" /><rect x={rx - 7.5} y={ry - 5} width="15" height="10" rx="4" /><path d={`M${lx + 7.5} ${ly - 1} H${rx - 7.5}`} /><path d={`M${lx - 4} ${ly - 2.5} l4 -1`} stroke="rgba(255,255,255,0.5)" strokeWidth="1.2" /></g>;
    case 3: return <g><path d="M60 90 L49 84 L49 96 Z M60 90 L71 84 L71 96 Z" fill="#d94b4b" stroke="#a42f2f" strokeWidth="1" /><circle cx="60" cy="90" r="3" fill="#a42f2f" /></g>;
    case 4: return <g><path d="M43 81 Q60 93 77 81 L79 89 Q60 101 41 89 Z" fill={shade(color === '#d94b4b' ? '#3f7fd9' : '#d94b4b', 0)} /><rect x="64" y="90" width="9" height="20" rx="2" fill={shade(color === '#d94b4b' ? '#3f7fd9' : '#d94b4b', -0.15)} transform="rotate(-10 68 100)" /></g>;
    case 5: return <g><path d="M52 86 L60 100 L68 86" fill="none" stroke="#3f7fd9" strokeWidth="3" /><circle cx="60" cy="104" r="6" fill="#f2c230" stroke="#c99a1b" strokeWidth="1.5" /><path d="M60 100.8 l1 2.1 2.3 0.3 -1.7 1.6 0.4 2.3 -2 -1.1 -2 1.1 0.4 -2.3 -1.7 -1.6 2.3 -0.3 Z" fill="#fff6c8" /></g>;
    default: return null;
  }
}

// ---- the whole figure: the same head on a small body with arms, legs, shoes and a tail
const TORSO = 'M40 87 Q60 81 80 87 Q86 90 86 99 L84 146 Q60 152 36 146 L34 99 Q34 90 40 87 Z';
const ARMS = ['M42 93 Q32 112 31 132', 'M78 93 Q88 112 89 132'];
const PANTS = ['#3d4b6b', '#3d4b6b', '#33353d', '#4a4038', '#3d4b6b', '#8c949e'];
function tail(id, fur) {
  const dark = shade(fur, -0.3);
  switch (id) {
    case 'cat': return <path d="M80 140 Q104 140 101 114 Q99 104 93 106" fill="none" stroke={fur} strokeWidth="6.5" strokeLinecap="round" />;
    case 'fox': return <g><path d="M78 146 Q110 148 107 117 Q102 104 92 110 Q97 132 76 136 Z" fill={fur} /><path d="M107 117 Q102 104 92 110 Q100 110 103 121 Z" fill="#f7f3ec" /></g>;
    case 'raccoon': return <g><path d="M80 142 Q104 140 104 112" fill="none" stroke={fur} strokeWidth="11" strokeLinecap="round" /><path d="M86 140 l4 -9 M95 134 l6 -6 M101 124 l7 -2" stroke="#36363d" strokeWidth="5" /></g>;
    case 'dog': return <path d="M80 138 Q96 134 98 118" fill="none" stroke={dark} strokeWidth="6" strokeLinecap="round" />;
    case 'mouse': return <path d="M80 144 Q108 150 104 124 Q101 112 110 108" fill="none" stroke="#e8a3b0" strokeWidth="2.6" strokeLinecap="round" />;
    case 'rabbit': return <circle cx="84" cy="140" r="7.5" fill="#fbf9f5" />;
    case 'bear': case 'panda': return <circle cx="82" cy="141" r="5.5" fill={id === 'panda' ? '#26262b' : dark} />;
    default: return null;
  }
}
function body(a, fur, color) {
  const dark = shade(color, -0.28), light = shade(color, 0.35);
  const knight = a.o === 5, robe = a.o === 4;
  const cloth = knight ? '#a9b1bb' : color;
  const paw = knight ? '#c3cad3' : shade(fur, -0.06);
  const pants = PANTS[a.o];
  const sleeve = a.o === 0
    ? <g>{ARMS.map((d, i) => <path key={i} d={d} fill="none" stroke={shade(fur, -0.06)} strokeWidth="10" strokeLinecap="round" />)}<path d="M42 93 Q37 102 35.5 109 M78 93 Q83 102 84.5 109" fill="none" stroke={color} strokeWidth="14" strokeLinecap="round" /></g>
    : ARMS.map((d, i) => <path key={i} d={d} fill="none" stroke={knight ? '#b7bec7' : cloth} strokeWidth={robe ? 15 : 12} strokeLinecap="round" />);
  let torso;
  switch (a.o) {
    case 1: torso = <g><path d={TORSO} fill={color} /><path d="M46 89 Q60 99 74 89" fill="none" stroke={dark} strokeWidth="4" /><path d="M55 93 L54 107 M65 93 L66 107" stroke="#f5f2ea" strokeWidth="1.8" strokeLinecap="round" /><path d="M45 124 Q60 119 75 124 L73 138 H47 Z" fill={dark} opacity="0.55" /></g>; break;
    case 2: torso = <g><path d={TORSO} fill={color} /><path d="M50 86 L60 112 L70 86 Z" fill="#f5f2ea" /><path d="M50 86 L60 112 L45 102 Z M70 86 L60 112 L75 102 Z" fill={dark} /><path d="M60 112 V148" stroke={dark} strokeWidth="1.4" /><circle cx="57" cy="120" r="1.8" fill={dark} /><circle cx="57" cy="132" r="1.8" fill={dark} /></g>; break;
    case 3: torso = <g><path d={TORSO} fill={color} /><path d="M46 89 Q60 100 74 89" fill="none" stroke={dark} strokeWidth="6" /><path d="M35 118 L41 112 L47 118 L53 112 L60 118 L67 112 L73 118 L79 112 L85 118" fill="none" stroke={light} strokeWidth="3" strokeLinejoin="round" /><path d="M36 141 Q60 147 84 141" fill="none" stroke={dark} strokeWidth="5" /></g>; break;
    case 4: torso = <g><path d="M40 87 Q60 81 80 87 L93 185 Q60 192 27 185 Z" fill={color} /><path d="M29 180 Q60 187 91 180" fill="none" stroke="#f3c34a" strokeWidth="3" /><path d="M48 86 L60 114 L72 86" fill="none" stroke="#f3c34a" strokeWidth="3.5" strokeLinejoin="round" /><path d="M74 132 l2 4.2 4.6 0.6 -3.4 3.2 0.9 4.6 -4.1 -2.3 -4.1 2.3 0.9 -4.6 -3.4 -3.2 4.6 -0.6 Z" fill="#f3c34a" /><path d="M42 158 l1.4 3 3.2 0.4 -2.4 2.2 0.6 3.2 -2.8 -1.6 -2.8 1.6 0.6 -3.2 -2.4 -2.2 3.2 -0.4 Z" fill="#f3c34a" opacity="0.8" /></g>; break;
    case 5: torso = <g><path d={TORSO} fill="#a9b1bb" /><path d="M36 112 Q60 104 84 112" fill="none" stroke="#7d8692" strokeWidth="2" /><path d="M60 96 V146" stroke="#7d8692" strokeWidth="2" /><path d="M42 90 L84 136 L84 144 L36 98 Z" fill={color} opacity="0.95" /><rect x="35" y="136" width="50" height="7" rx="2" fill="#6d4b2e" /><rect x="56" y="135" width="8" height="9" rx="1.5" fill="#f2c230" /></g>; break;
    default: torso = <g><path d={TORSO} fill={color} /><path d="M47 88 Q60 98 73 88" fill="none" stroke={dark} strokeWidth="3" /></g>;
  }
  return {
    back: <g>
      <ellipse cx="60" cy="195" rx="36" ry="6" fill="rgba(0,0,0,0.28)" />
      {!robe ? <g><rect x="43" y="138" width="15" height="49" rx="6" fill={pants} /><rect x="62" y="138" width="15" height="49" rx="6" fill={pants} /></g> : null}
      <path d="M36 194 Q36 183 48 183 Q58 183 59 191 Q59 196 52 196 H39 Q36 196 36 194 Z" fill={knight ? '#6c737d' : '#2b2727'} />
      <path d="M84 194 Q84 183 72 183 Q62 183 61 191 Q61 196 68 196 H81 Q84 196 84 194 Z" fill={knight ? '#6c737d' : '#2b2727'} />
      {a.o === 1 ? <ellipse cx="60" cy="86" rx="23" ry="9" fill={dark} /> : null}
    </g>,
    front: <g>{torso}{sleeve}<circle cx="31" cy="134" r="6.5" fill={paw} /><circle cx="89" cy="134" r="6.5" fill={paw} />{knight ? <g><ellipse cx="39" cy="93" rx="10" ry="7" fill="#c3cad3" /><ellipse cx="81" cy="93" rx="10" ry="7" fill="#c3cad3" /></g> : null}</g>,
  };
}

// the avatar itself: a round portrait, or (full) the whole little figure standing on its card
export function AnimalAvatar({ code, size = 40, title, full = false }) {
  const uid = useId().replace(/:/g, '');
  const a = parseAvatar(code);
  const an = ANIMALS[a.a];
  const fur = an.fur[a.f] || an.fur[0];
  const color = COLORS[a.c];
  const parts = animal(an.id, fur);
  if (full) {
    const b = body(a, fur, color);
    return (
      <svg className="animal-figure" width={size} height={size * 212 / 132} viewBox="-6 -10 132 212" role="img" aria-label={title || `${an.name} avatar`}>
        <defs><radialGradient id={`g${uid}`} cx="50%" cy="30%" r="80%"><stop offset="0" stopColor={shade(BGS[a.b], 0.3)} /><stop offset="1" stopColor={BGS[a.b]} /></radialGradient></defs>
        <rect x="-6" y="-10" width="132" height="212" rx="16" fill={`url(#g${uid})`} />
        {tail(an.id, fur)}
        {b.back}
        <rect x="51" y="70" width="18" height="20" rx="6" fill={shade(fur, -0.12)} />
        {b.front}
        {parts.back}
        {parts.head}
        {parts.face}
        {hat(a.h, color, HAT_DY[an.id] || 0)}
        {extra(a.x, an.id, color)}
      </svg>
    );
  }
  const out = outfit(a.o, color);
  return (
    <svg className="animal-avatar" width={size} height={size} viewBox="0 0 120 120" role="img" aria-label={title || `${an.name} avatar`}>
      <defs>
        <clipPath id={`c${uid}`}><circle cx="60" cy="60" r="60" /></clipPath>
        <radialGradient id={`g${uid}`} cx="50%" cy="35%" r="70%"><stop offset="0" stopColor={shade(BGS[a.b], 0.25)} /><stop offset="1" stopColor={BGS[a.b]} /></radialGradient>
      </defs>
      <g clipPath={`url(#c${uid})`}>
        <rect width="120" height="120" fill={`url(#g${uid})`} />
        {out.behind || null}
        <rect x="51" y="70" width="18" height="20" rx="6" fill={shade(fur, -0.12)} />
        {out.front}
        {parts.back}
        {parts.head}
        {parts.face}
        {hat(a.h, color, HAT_DY[an.id] || 0)}
        {extra(a.x, an.id, color)}
      </g>
    </svg>
  );
}

// ---- picking one
export function Swatches({ list, value, onPick, label }) {
  return <div className="av-swatches" role="radiogroup" aria-label={label}>{list.map((c, i) => <button key={i} role="radio" aria-checked={value === i} className={value === i ? 'on' : ''} style={{ background: c }} onClick={() => onPick(i)} aria-label={`${label} ${i + 1}`} />)}</div>;
}
export function Choices({ list, value, onPick, label }) {
  return <div className="av-choices" role="radiogroup" aria-label={label}>{list.map((n, i) => <button key={n} role="radio" aria-checked={value === i} className={`btn sm ${value === i ? 'on' : ''}`} onClick={() => onPick(i)}>{n}</button>)}</div>;
}

export function AvatarEditor({ code, onSave, onClose }) {
  const [a, setA] = useState(() => parseAvatar(code));
  const set = (k, v) => setA(cur => { const next = { ...cur, [k]: v }; if (k === 'a') next.f = Math.min(next.f, ANIMALS[v].fur.length - 1); return next; });
  const c = avatarCode(a);
  return (
    <Modal label="Your avatar" onClose={onClose}>
      <h2>Your avatar</h2>
      <p className="sub">Shown to your friends next to your name in rooms and at the table.</p>
      <div className="av-editor">
        <div className="av-preview">
          <AnimalAvatar code={c} size={168} full />
          <div className="av-mini"><AnimalAvatar code={c} size={44} /><span>Next to your name</span></div>
          <button className="btn sm" onClick={() => setA(parseAvatar(randomAvatar()))}>Surprise me</button>
        </div>
        <div className="av-options">
          <div className="av-row"><span className="label">Animal</span>
            <div className="av-animals" role="radiogroup" aria-label="Animal">{ANIMALS.map((an, i) => (
              <button key={an.id} role="radio" aria-checked={a.a === i} className={a.a === i ? 'on' : ''} onClick={() => set('a', i)} title={an.name} aria-label={an.name}><AnimalAvatar code={avatarCode({ ...a, a: i, f: 0, h: 0, x: 0 })} size={46} /></button>
            ))}</div>
          </div>
          {ANIMALS[a.a].fur.length > 1 ? <div className="av-row"><span className="label">Fur</span><Swatches list={ANIMALS[a.a].fur} value={a.f} onPick={v => set('f', v)} label="Fur color" /></div> : null}
          <div className="av-row"><span className="label">Outfit</span><Choices list={OUTFITS} value={a.o} onPick={v => set('o', v)} label="Outfit" /></div>
          <div className="av-row"><span className="label">Color</span><Swatches list={COLORS} value={a.c} onPick={v => set('c', v)} label="Outfit color" /></div>
          <div className="av-row"><span className="label">Hat</span><Choices list={HATS} value={a.h} onPick={v => set('h', v)} label="Hat" /></div>
          <div className="av-row"><span className="label">Extra</span><Choices list={EXTRAS} value={a.x} onPick={v => set('x', v)} label="Accessory" /></div>
          <div className="av-row"><span className="label">Background</span><Swatches list={BGS} value={a.b} onPick={v => set('b', v)} label="Background" /></div>
        </div>
      </div>
      <div className="dlg-actions"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => { saveAvatar(c); onSave(c); }}>Save avatar</button></div>
    </Modal>
  );
}

// the small "your avatar" button for the friends panels
export function AvatarButton({ code, onChange }) {
  const [open, setOpen] = useState(false);
  return <>
    <button className="av-button" onClick={() => setOpen(true)} title="Change your avatar" aria-label="Change your avatar"><AnimalAvatar code={code} size={52} /><span>Change</span></button>
    {open ? <AvatarEditor code={code} onClose={() => setOpen(false)} onSave={c => { setOpen(false); onChange(c); }} /> : null}
  </>;
}

// everyone at the table, standing in a row (friends' rooms); AI seats and open seats get a plain card
export function Lineup({ seats, cid, host, vs = false }) {
  const items = [];
  seats.forEach((s, i) => {
    if (vs && i) items.push(<span key={`vs${i}`} className="lineup-vs" aria-hidden="true">VS</span>);
    const who = s.k === 'a' ? 'AI player' : s.c ? (s.n || 'Player') + (s.c === cid ? ' (you)' : '') : 'Open seat';
    items.push(
      <figure key={i} className={`lineup-card ${s.c === cid ? 'mine' : ''} ${s.k === 'a' ? 'ai' : s.c ? '' : 'open'}`}>
        {s.k === 'h' && s.c ? <AnimalAvatar code={s.a} size={84} full title={`${s.n || 'Player'}'s avatar`} /> : <div className="lineup-empty" aria-hidden="true">{s.k === 'a' ? <svg viewBox="0 0 24 24" width="38" height="38"><rect x="5" y="7" width="14" height="11" rx="3" fill="none" stroke="currentColor" strokeWidth="1.6" /><circle cx="9.5" cy="12" r="1.5" fill="currentColor" /><circle cx="14.5" cy="12" r="1.5" fill="currentColor" /><path d="M12 7V4M10 21h4M3 12h2M19 12h2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg> : '?'}</div>}
        <figcaption>{who}{s.c && s.c === host ? <span className="lineup-host">host</span> : null}</figcaption>
      </figure>,
    );
  });
  return <div className="lineup" aria-label="Players">{items}</div>;
}

// people in the room who aren't playing
export function Watchers({ list }) {
  if (!list.length) return null;
  return <p className="note watchers">Watching: {list.map(w => <span key={w.cid} className="watcher"><AnimalAvatar code={w.av} size={22} />{w.nick}{w.me ? ' (you)' : ''}</span>)}</p>;
}

// your own avatar in a friends' panel: shows it, and opens the editor
export function MyAvatarRow({ code, onChange }) {
  return <div className="av-me"><AvatarButton code={code} onChange={onChange} /><span className="note">Your avatar. Friends see it next to your name and at the table.</span></div>;
}
