// What the One Piece card keywords mean: point at one (or tap it) in any card's text to read it. One tooltip, drawn
// over everything (dialogs included), serves the whole screen.
const { useSyncExternalStore, useEffect } = React;

export const GLOSSARY = {
  'Blocker': 'When your opponent attacks, you may rest this card to make it the new target of the attack.',
  'Rush': 'This card can attack in the turn it is played.',
  'Rush: Character': 'This card can attack your opponent’s Characters in the turn it is played.',
  'Double Attack': 'When this card damages the Leader, it deals 2 damage: 2 Life cards.',
  'Banish': 'When this card deals damage, the Life card goes to the trash instead: no [Trigger], no card in hand.',
  'Unblockable': 'Your opponent can’t use [Blocker] against this card’s attacks.',
  'Trigger': 'When this card is taken from your Life by damage, you may show it and use this effect for free, instead of adding it to your hand.',
  'Counter': 'An Event you can play when your Leader or a Character is attacked (pay its cost in DON!!).',
  'On Play': 'Happens when you play this card.',
  'When Attacking': 'Happens when this card attacks.',
  'Activate: Main': 'You choose when to use this, during your Main Phase.',
  'Main': 'Use this Event during your Main Phase (pay its cost in DON!!).',
  'On K.O.': 'Happens when this Character is K.O.’d.',
  'On Block': 'Happens when this card blocks with [Blocker].',
  'On Your Opponent\'s Attack': 'Happens when your opponent attacks.',
  'End of Your Turn': 'Happens at the end of your turn.',
  'End of Your Opponent\'s Turn': 'Happens at the end of your opponent’s turn.',
  'Your Turn': 'Works only during your turn.',
  'Opponent\'s Turn': 'Works only during your opponent’s turn.',
  'Once Per Turn': 'Can be used only once each turn.',
};
// keywords with a number in them
export function explain(label) {
  if (GLOSSARY[label]) return GLOSSARY[label];
  let m;
  if ((m = /^DON!! x(\d+)$/.exec(label))) return `Works only while this card has at least ${m[1]} DON!! card${m[1] === '1' ? '' : 's'} given to it.`;
  if ((m = /^DON!! [-−](\d+)$/.exec(label))) return `A cost: return ${m[1]} DON!! card${m[1] === '1' ? '' : 's'} from your field (your cost area or cards they were given to) to your DON!! deck.`;
  if ((m = /^[①-⑩]$/.exec(label))) { const n = label.charCodeAt(0) - 0x245f; return `A cost: rest ${n} of your active DON!! card${n === 1 ? '' : 's'}.`; }
  return null;
}

// the one tooltip
const tip = { cur: null, subs: new Set(), v: 0 };
const setTip = t => { tip.cur = t; tip.v++; tip.subs.forEach(f => f()); };
const subscribe = f => { tip.subs.add(f); return () => tip.subs.delete(f); };
const version = () => tip.v;

export function Kw({ label, cls = '', children }) {
  const text = explain(label);
  if (!text) return <span className={`kw ${cls}`}>{children}</span>;
  const show = e => setTip({ label, text, el: e.currentTarget });
  const hide = e => { if (tip.cur && tip.cur.el === e.currentTarget) setTip(null); };
  return (
    <span className={`kw has-tip ${cls}`} tabIndex={0} role="button" aria-label={`${label}: ${text}`}
      onPointerEnter={e => { if (e.pointerType !== 'touch') show(e); }} onPointerLeave={e => { if (e.pointerType !== 'touch') hide(e); }}
      onFocus={show} onBlur={hide}
      onClick={e => { e.stopPropagation(); show(e); }}>{children}</span>
  );
}

export function KwTip() {
  useSyncExternalStore(subscribe, version);
  useEffect(() => {
    // the page or a panel scrolling (the battle log does, on every new line): the tooltip follows its keyword
    const follow = () => { if (tip.cur) { tip.v++; tip.subs.forEach(f => f()); } };
    const outside = e => { if (tip.cur && !(tip.cur.el && tip.cur.el.contains(e.target))) setTip(null); };
    window.addEventListener('scroll', follow, true); window.addEventListener('resize', follow); document.addEventListener('pointerdown', outside, true);
    return () => { window.removeEventListener('scroll', follow, true); window.removeEventListener('resize', follow); document.removeEventListener('pointerdown', outside, true); };
  }, []);
  const t = tip.cur;
  if (!t || !t.el.isConnected) return null;
  const r = t.el.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight || !r.width) return null;
  // above the keyword if there's room, else below; kept on screen
  const w = Math.min(300, innerWidth - 16), above = r.top > 120;
  const left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2));
  const style = above ? { left, width: w, bottom: innerHeight - r.top + 8 } : { left, width: w, top: r.bottom + 8 };
  return <div className="op-kwtip" role="tooltip" style={style}><b>{t.label}</b>{t.text}</div>;
}

// a card's printed words, with its keywords picked out (and explained)
export function EffectText({ text }) {
  if (!text) return null;
  const parts = String(text).split(/(\[[^\]]+\]|DON!! [-−]\d+|[①-⑩])/);
  return <>{parts.map((p, i) => {
    if (/^\[[^\]]+\]$/.test(p)) { const k = p.slice(1, -1); return <Kw key={i} label={k} cls={/Trigger/.test(k) ? 'trigger' : /Counter/.test(k) ? 'counter' : /DON!!/.test(k) ? 'don' : ''}>{k}</Kw>; }
    if (/^DON!! [-−]\d+$|^[①-⑩]$/.test(p)) return <Kw key={i} label={p} cls="cost">{p}</Kw>;
    return <span key={i}>{p}</span>;
  })}</>;
}
