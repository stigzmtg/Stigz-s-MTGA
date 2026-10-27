// The table: player mats (plate + battlefield rows), the table center (stack, recent plays, prompt),
// the arrow layer (targets, attacks, blocks), the hand fan and small motion cues (enter, damage, life change).
import { CardFace, CardBack, viewOf, ManaCost, Pip, RulesText } from './cardview.jsx';
import { UnsetsSlot } from './unsets.jsx';
import { imageOf } from './images.js';
import { EmoteBubble } from './emotes.jsx';
import { AnimalAvatar } from './avatar.jsx';
import { cssPx, uiScale } from './common.js';
import { shake } from './motion.js';
import { VerifiedMark } from './badge.jsx';

const { useState, useEffect, useLayoutEffect, useRef } = React;

// per-game memory for one-shot animations
const seenOnField = new WeakMap();
const lastDamage = new WeakMap();
function memo(map, game, make) { let m = map.get(game); if (!m) { m = make(); map.set(game, m); } return m; }

const IDENTITY_HEX = { W: '#efe3b8', U: '#4f8fd6', B: '#8a7c84', R: '#e0663f', G: '#4fa86a' };
export function identityStyle(colors) {
  const cs = colors.length ? colors : ['C'];
  const hex = cs.map(c => IDENTITY_HEX[c] || '#a9b2b6');
  return { '--id-a': hex[0], '--id-b': hex[hex.length - 1], '--id-grad': `linear-gradient(90deg, ${hex.map((h, i) => `${h} ${Math.round(100 * i / Math.max(1, hex.length - 1))}%`).join(', ')})` };
}

// ------------------------------------------------------------------ battlefield grouping
export function groupBattlefield(game, pid, groupSame, groupLands = groupSame) {
  const mine = game.battlefield.filter(c => c.controller === pid);
  const isAttachedToBf = c => typeof c.attachedTo === 'number' && game.battlefield.some(h => h.id === c.attachedTo);
  const creatures = [], other = [], lands = [];
  for (const c of mine) {
    if (isAttachedToBf(c)) continue;
    const ch = game.chars(c);
    if (ch.types.has('Creature')) creatures.push(c);
    else if (ch.types.has('Land')) lands.push(c);
    else other.push(c);
  }
  const keyOf = c => {
    const ch = game.chars(c);
    return `${game.name(c)}|${c.tapped}|${ch.power}/${ch.toughness}|${c.sick && ch.types.has('Creature') ? 's' : ''}`;
  };
  // identical lands and identical tokens (same name, state, nothing on them) share one stack
  const group = (list, canStack, on) => {
    const out = [];
    const byKey = new Map();
    for (const c of list) {
      const plain = on && canStack(c) && !Object.values(c.counters).some(n => n > 0) && !game.attachmentsOf(c).length && !c.damage && !game.isAttacking(c) && !game.isBlocking(c);
      const k = keyOf(c);
      if (plain && byKey.has(k)) { byKey.get(k).cards.push(c); continue; }
      const g = { key: k, cards: [c] };
      if (plain) byKey.set(k, g);
      out.push(g);
    }
    return out;
  };
  lands.sort((a, b) => game.name(a).localeCompare(game.name(b)) || (a.tapped - b.tapped));
  return {
    creatures: group(creatures, c => c.token, groupSame),
    other: group(other, c => c.token, groupSame),
    lands: group(lands, () => true, groupLands),
  };
}

// ------------------------------------------------------------------ one permanent (with attachments tucked under)
// a number that floats off a card when its damage or +1/+1 counters go up
function useRises(value) {
  const prev = useRef(value);
  const [rises, setRises] = useState([]);
  useEffect(() => {
    const d = value - prev.current;
    prev.current = value;
    if (d <= 0) return;
    const id = Math.random();
    setRises(r => [...r.slice(-2), { id, d }]);
    const t = setTimeout(() => setRises(r => r.filter(x => x.id !== id)), 1300);
    return () => clearTimeout(t);
  }, [value]);
  return rises;
}

export function CardSlot({ card, ctx, size = 'mini', count = 1, ids = null }) {
  const { game } = ctx;
  const v = viewOf(game, card);
  const onField = card.zone === 'battlefield';
  const atts = onField ? game.attachmentsOf(card) : [];
  const ref = 'c' + card.id;
  const cls = [];
  const badges = [];
  const wrapCls = [];
  const atk = onField && game.combat && game.combat.attackers.find(a => a.card === card.id);
  if (atk) { cls.push('attacking'); wrapCls.push('lunge'); }
  if (onField && game.combat && game.combat.blockers.has(card.id)) { cls.push('blocking'); wrapCls.push('guard'); }
  if (ctx.playable && ctx.playable.has(card.id)) cls.push('playable');
  if (ctx.targetable && ctx.targetable.has(ref)) cls.push(ctx.chosen && ctx.chosen.includes(ref) ? 'selected' : 'targetable');
  if (ctx.attack) {
    if (ctx.attack.assigned.has(card.id)) { cls.push('selected'); wrapCls.push('lunge'); }
    else if (ctx.attack.candidates.has(card.id)) cls.push('targetable');
  }
  if (ctx.block) {
    if (ctx.block.assigned.has(card.id)) { cls.push('blocking'); wrapCls.push('guard'); }
    else if (ctx.block.picked === card.id) cls.push('selected');
    else if (ctx.block.candidates.has(card.id)) cls.push('targetable');
    // with a blocker picked, only the attackers it may block light up
    if (ctx.block.attackers.has(card.id)) cls.push(!ctx.block.picked ? 'attacking' : ctx.block.canBlock(ctx.block.picked, card.id) ? 'attacker-target' : 'attacking no-block');
  }
  // phased out: treated as though it doesn't exist until its controller's next untap step
  if (onField && card.phasedOut) { wrapCls.push('phased'); badges.push(<span key="ph" className="badge ctr" title="Phased out: it's treated as though it doesn't exist until its controller's next untap step">Phased out</span>); }
  if (ctx.support && ctx.support[card.def.name]) badges.push(<span key="w" className="badge warn" title={`Not fully automated: ${ctx.support[card.def.name].join(', ')}`}>!</span>);
  if (card.isCommander && onField) badges.push(<span key="cmd" className="badge cmdr" title="Commander">★</span>);
  if (count > 1) badges.push(<span key="cnt" className="badge cnt" title={`${count} identical`}>×{count}</span>);
  // one-shot motion: entering the battlefield, taking damage
  if (onField) {
    const seen = memo(seenOnField, game, () => new Set());
    if (!seen.has(card.id)) { seen.add(card.id); if (game.turnNumber > 0) wrapCls.push('enter'); }
    const dm = memo(lastDamage, game, () => new Map());
    const before = dm.get(card.id) || 0;
    if ((card.damage || 0) > before) wrapCls.push('hit');
    dm.set(card.id, card.damage || 0);
  }
  const hurt = useRises(onField ? card.damage || 0 : 0);
  const grow = useRises(onField ? (card.counters && card.counters.P1P1) || 0 : 0);
  return (
    <div className={`cardwrap ${v.tapped && onField ? 'tapped' : ''} ${atts.length ? 'has-att' : ''} ${count > 1 ? 'stacked' : ''} ${wrapCls.join(' ')}`} data-ref={ref} data-fly={(ids || [card.id]).join(' ')} style={atts.length ? { '--atts': atts.length } : undefined}>
      {count > 1 ? <div className="stackshadow" aria-hidden="true" /> : null}
      {hurt.map(f => <span key={f.id} className="rise hurt" aria-hidden="true">−{f.d}</span>)}
      {grow.map(f => <span key={f.id} className="rise grow" aria-hidden="true">+{f.d}/+{f.d}</span>)}
      {atts.map((a, i) => (
        <div key={a.id} className="under" data-ref={'c' + a.id} data-fly={a.id} style={{ '--i': i + 1 }}>
          <CardFace v={viewOf(game, a)} cls={ctx.targetable && ctx.targetable.has('c' + a.id) ? (ctx.chosen && ctx.chosen.includes('c' + a.id) ? 'selected' : 'targetable') : (ctx.playable && ctx.playable.has(a.id) ? 'playable' : '')}
            onClick={e => ctx.onCardClick(a, e)} onContextMenu={e => ctx.onCardMenu(a, e)} onEnter={() => ctx.onHover(a.id)} />
        </div>
      ))}
      <CardFace v={v} size={size} cls={cls.join(' ')} badges={badges.length ? badges : null}
        onClick={e => ctx.onCardClick(card, e)} onContextMenu={e => ctx.onCardMenu(card, e)} onEnter={() => ctx.onHover(card.id)} />
    </div>
  );
}

// ------------------------------------------------------------------ player plate
function Avatar({ game, p, av }) {
  const cmd = p.commanders.map(id => game.cardById(id)).filter(Boolean)[0];
  const img = cmd ? imageOf(game, cmd) : null;
  // a friend online: their animal, with their commander in a small badge
  if (av) return <span className="avatar animal" aria-hidden="true"><AnimalAvatar code={av} size={46} />{img ? <span className="cmd-badge" style={{ backgroundImage: `url(${img})` }} /> : null}</span>;
  const initials = (p.name === 'You' ? (cmd ? game.name(cmd) : 'You') : p.name).replace(/[^A-Za-z ]/g, '').split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  return (
    <span className="avatar" style={img ? { backgroundImage: `url(${img})` } : undefined} aria-hidden="true">
      {img ? null : <span className="ini">{initials}</span>}
    </span>
  );
}

function LifeTotal({ p, onClick }) {
  const prev = useRef(p.life);
  const box = useRef(null);
  const [floats, setFloats] = useState([]);
  useEffect(() => {
    const d = p.life - prev.current;
    prev.current = p.life;
    if (!d) return;
    if (d < 0 && box.current) { shake(box.current, Math.min(1.6, 0.6 + -d / 8)); box.current.animate([{ boxShadow: '0 0 0 0 rgba(255, 80, 60, 0)' }, { boxShadow: '0 0 0 3px rgba(255, 90, 70, 0.75), 0 0 22px rgba(255, 70, 50, 0.6)' }, { boxShadow: '0 0 0 0 rgba(255, 80, 60, 0)' }], { duration: 700, easing: 'ease-out' }); }
    if (d > 0 && box.current) box.current.animate([{ boxShadow: '0 0 0 0 rgba(120, 220, 120, 0)' }, { boxShadow: '0 0 0 3px rgba(140, 230, 140, 0.7), 0 0 22px rgba(120, 220, 120, 0.55)' }, { boxShadow: '0 0 0 0 rgba(120, 220, 120, 0)' }], { duration: 700, easing: 'ease-out' });
    const id = Math.random();
    setFloats(f => [...f.slice(-3), { id, d }]);
    const t = setTimeout(() => setFloats(f => f.filter(x => x.id !== id)), 1600);
    return () => clearTimeout(t);
  }, [p.life]);
  return (
    <span ref={box} className={`lifetotal ${p.life <= 10 ? 'low' : ''}`} title="Life total" onClick={onClick} role={onClick ? 'button' : undefined} style={onClick ? { cursor: 'pointer' } : undefined}>
      <b>{p.life}</b>
      {floats.map(f => <span key={f.id} className={`float ${f.d > 0 ? 'gain' : 'loss'}`}>{f.d > 0 ? '+' : '−'}{Math.abs(f.d)}</span>)}
    </span>
  );
}

// small line icons for the zones (an empty graveyard or exile shows its icon instead of a top card)
export const ZoneIcon = ({ zone }) => (
  <svg className="zicon" viewBox="0 0 24 24" aria-hidden="true">
    {zone === 'graveyard' ? <path d="M7 21V10a5 5 0 0 1 10 0v11M5 21h14M12 9v6M9.5 11.5h5" />
      : zone === 'exile' ? <><circle cx="12" cy="12" r="8" /><path d="M12 4a5 5 0 0 1 0 10 3 3 0 0 0 0 6" /></>
        : zone === 'hand' ? <path d="M4.5 8.5 9 6.2l3.6 10.9-4.5 2.3zM11 5.5l4.8-.9 2.1 11.3-4.8.9" />
          : <path d="M6 4h10v16H6zM9 2h10v16" />}
  </svg>
);

function Piles({ game, pid, ctx, compact }) {
  const p = game.players[pid];
  const top = p.graveyard[p.graveyard.length - 1];
  const ex = p.exile[p.exile.length - 1];
  const open = z => e => { e.stopPropagation(); ctx.openZone(pid, z); };
  return (
    <div className="piles">
      {compact ? null : <button className="pile" data-pile={`${pid}:library`} onClick={open('library')} title={`Library: ${p.library.length} cards`}><span className="pc"><CardBack sleeve={ctx.sleeves && ctx.sleeves[pid]} /></span><span className="pl">Library</span><b>{p.library.length}</b></button>}
      <button className={`pile ${top ? '' : 'none'}`} data-pile={`${pid}:graveyard`} onClick={open('graveyard')} title={`Graveyard: ${p.graveyard.length} cards`} onMouseEnter={() => top && ctx.onHover(top.id)}>
        <span className="pc"><span className="slot"><ZoneIcon zone="graveyard" /></span></span><span className="pl">Graveyard</span><b>{p.graveyard.length}</b>
      </button>
      <button className={`pile ${ex ? '' : 'none'}`} data-pile={`${pid}:exile`} onClick={open('exile')} title={`Exile: ${p.exile.length} cards`} onMouseEnter={() => ex && ctx.onHover(ex.id)}>
        <span className="pc"><span className="slot"><ZoneIcon zone="exile" /></span></span><span className="pl">Exile</span><b>{p.exile.length}</b>
      </button>
    </div>
  );
}

function OppHand({ n, sleeve, pid }) {
  const shown = Math.min(n, 7);
  return (
    <span className="opphand" data-pile={`${pid}:hand`} title={`${n} card${n === 1 ? '' : 's'} in hand`}>
      <span className="fan" style={{ '--n': shown }}>{Array.from({ length: shown }, (_, i) => <span key={i} className="fb" style={{ '--k': i - (shown - 1) / 2 }}><CardBack sleeve={sleeve} /></span>)}</span>
      <b>{n}</b>
    </span>
  );
}

function StatusChips({ game, pid }) {
  const p = game.players[pid];
  const cmdDmg = Object.entries(p.commanderDamage).filter(([, d]) => d > 0);
  const poison = p.counters.POISON || 0;
  const energy = p.counters.ENERGY || 0;
  // Auras attached to the player (Curses): the card sits with its controller, so say it here too
  const curses = game.battlefield.filter(c => c.attachedTo === 'p' + pid);
  return (
    <>
      {game.monarch === pid ? <span className="chip gold" title="The monarch draws a card at the end of their turn">♛ Monarch</span> : null}
      {game.initiative === pid ? <span className="chip gold" title="At the beginning of your upkeep, venture into Undercity. Deal combat damage to this player to take the initiative.">⚑ Initiative</span> : null}
      {p.dungeon ? <span className="chip" title={`${p.dungeon.obj.effectName} — ${p.dungeon.roomLabel}: ${p.dungeon.roomDesc}`}>⛫ {p.dungeon.roomLabel}</span> : null}
      {p.dungeonsCompleted.length ? <span className="chip" title={`Completed: ${p.dungeonsCompleted.join(', ')}`}>⛫ ×{p.dungeonsCompleted.length}</span> : null}
      {poison ? <span className="chip poison" title="Poison counters (10 loses)">☣ {poison}</span> : null}
      {energy ? <span className="chip" title="Energy counters"><Pip s="E" /> {energy}</span> : null}
      {curses.map(c => <span key={c.id} className="chip" title={`${game.name(c)} (${game.players[c.controller].name}'s) is attached to ${p.name}`}>☍ {game.name(c)}</span>)}
      {cmdDmg.map(([id, d]) => <span key={id} className={`chip ${d >= 15 ? 'danger' : ''}`} title={`Commander damage taken from ${game.name(game.cardById(+id))} (21 loses)`}>⚔ {game.name(game.cardById(+id)).split(',')[0]} {d}/21</span>)}
      {p.lost ? <span className="chip danger">Eliminated</span> : null}
    </>
  );
}

function CommandSlot({ game, pid, ctx }) {
  const p = game.players[pid];
  const cmds = p.command.filter(c => c.isCommander);
  if (!cmds.length) return null;
  return (
    <div className="cmdslot" title="Command zone" data-pile={`${pid}:command`}>
      {cmds.map(c => {
        const tax = game.commanderTax(c);
        return (
          <div key={c.id} className="cmdcard">
            <CardSlot card={c} ctx={ctx} />
            {tax ? <span className="tax" title={`Commander tax: costs {${tax}} more`}>+{tax}</span> : null}
          </div>
        );
      })}
      <span className="slotlabel">Command</span>
    </div>
  );
}

function attackSummary(game, pid) {
  if (!game.combat) return null;
  const at = game.combat.attackers.filter(a => a.defenderPlayer === pid && !a.defenderCard);
  if (!at.length) return null;
  const power = at.reduce((s, a) => { const c = game.cardById(a.card); return s + (c ? Math.max(0, game.chars(c).power) : 0); }, 0);
  return { n: at.length, power };
}

// ------------------------------------------------------------------ a player's mat
export function Mat({ game, pid, ctx, side, compact }) {
  const p = game.players[pid];
  const isMe = side === 'bottom';
  const groupSame = !ctx.targetable && !ctx.attack && !ctx.block;
  const landsTargetable = !!ctx.targetable && game.battlefield.some(c => c.controller === pid && ctx.targetable.has('c' + c.id) && game.chars(c).types.has('Land'));
  const { creatures, other, lands } = groupBattlefield(game, pid, groupSame, !landsTargetable);
  const ref = 'p' + pid;
  const targetable = ctx.targetable && ctx.targetable.has(ref);
  const chosen = ctx.chosen && ctx.chosen.includes(ref);
  const attackTarget = ctx.attack && ctx.attack.defenders.some(d => d.ref === ref);
  const incoming = attackSummary(game, pid);
  const onSeat = e => {
    if (targetable) { e.stopPropagation(); ctx.toggleTarget(ref); }
    else if (attackTarget) { e.stopPropagation(); ctx.attack.setCurrent(ref); }
  };
  // fit: the largest card size (whole pixels, so images and text stay sharp) at which the battlefield fits its mat.
  // Searched in one layout effect before the browser paints: each try sets the size on the mat and measures, so
  // React renders once per change instead of once per try. Starting from the current size, a card entering or
  // leaving usually settles in two or three measurements.
  const fieldRef = useRef(null);
  const [fit, setFit] = useState(1);
  const search = useRef({ sig: '', done: false });
  const sig = `${game.battlefield.filter(c => c.controller === pid).length}:${game.battlefield.filter(c => c.controller === pid && c.tapped).length}:${creatures.length}:${other.length}:${lands.length}:${p.command.length}`;
  useLayoutEffect(() => {
    const el = fieldRef.current;
    if (!el) return;
    const s = search.current;
    if (s.sig === sig && s.done) return;
    s.sig = sig; s.done = true;
    const mat = el.parentNode;
    const base = cssPx(mat, '--cw-base', 80);
    const cs = getComputedStyle(el);
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const tried = new Map();
    // layout boxes only: transforms (enter animations, attackers leaning in) must not count
    const fits = w => {
      if (tried.has(w)) return tried.get(w);
      mat.style.setProperty('--fit', String(w / base));
      let top = Infinity, bottom = -Infinity;
      for (const r of el.children) { top = Math.min(top, r.offsetTop); bottom = Math.max(bottom, r.offsetTop + r.offsetHeight); }
      const ok = !el.children.length || bottom - top + pad - el.clientHeight <= 2;
      tried.set(w, ok);
      return ok;
    };
    // the answer lies in [lo, hi]; the smallest size is used even if nothing fits
    // big screens have room for bigger cards
    let lo = Math.round(base * 0.55), hi = Math.round(base * (uiScale() >= 1.2 ? 1.75 : 1.5));
    const w0 = Math.min(hi, Math.max(lo, Math.round(base * fit)));
    // a sparse battlefield takes the largest size at once
    if (fits(w0)) { lo = w0; if (fits(hi)) lo = hi; else { hi--; for (let step = 1; lo < hi; step *= 2) { const t = Math.min(hi, lo + step); if (fits(t)) lo = t; else { hi = t - 1; break; } } } }
    else { hi = w0 - 1; for (let step = 1; lo < hi; step *= 2) { const t = Math.max(lo, hi - step + 1); if (fits(t)) { lo = t; break; } hi = t - 1; } }
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (fits(mid)) lo = mid; else hi = mid - 1; }
    const want = lo / base;
    mat.style.setProperty('--fit', String(want));
    if (Math.abs(want - fit) > 1e-6) setFit(want);
  });
  useEffect(() => {
    const el = fieldRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let last = 0;
    const ro = new ResizeObserver(() => { if (Math.abs(el.clientHeight - last) < 2 && Math.abs(el.clientWidth - (ro.w || 0)) < 2) return; last = el.clientHeight; ro.w = el.clientWidth; search.current.done = false; setFit(f => f + 1e-9); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // your side panel: when the mat is short, drop the least needed lines until it fits (see styles.css)
  const plateRef = useRef(null);
  const [tight, setTight] = useState(0);
  useLayoutEffect(() => {
    const el = plateRef.current;
    if (!el || !isMe) return;
    let lvl = 0;
    for (; lvl < 3; lvl++) { el.dataset.tight = lvl; if (el.scrollHeight <= el.clientHeight + 1) break; }
    el.dataset.tight = lvl;
    if (lvl !== tight) setTight(lvl);
  });
  const classes = ['mat', side, game.activePlayer === pid ? 'active' : '', p.lost ? 'lost' : '', targetable ? (chosen ? 'targeted' : 'targetable') : '', attackTarget ? (ctx.attack.current === ref ? 'targeted' : 'targetable') : '', compact ? 'compact' : ''];
  const plate = (
    <div className="plate" ref={plateRef} data-tight={isMe ? tight : undefined}>
      <EmoteBubble b={ctx.emotes && ctx.emotes.get(pid)} />
      <span className="who" data-ref={ref}>
        <span title={`${p.name} · library ${p.library.length} · hand ${p.hand.length}`}><Avatar game={game} p={p} av={ctx.avatars && ctx.avatars[pid]} /></span>
        <LifeTotal p={p} onClick={isMe ? (e => { e.stopPropagation(); ctx.onPlayerMenu(pid, e); }) : undefined} />
      </span>
      <span className="ident">
        <span className="pname" title={p.name}><span className="pn">{p.name}</span>{ctx.badges && ctx.badges[pid] ? <VerifiedMark {...ctx.badges[pid]} /> : null}{game.activePlayer === pid ? <span className="turnmark" title="Active player">turn</span> : null}</span>
        <span className="status"><StatusChips game={game} pid={pid} />{incoming ? <span className="chip danger" title="Attacking this player">⚔ {incoming.n} attacking · {incoming.power} power</span> : null}<span className="pdeck">{p.deckName}</span></span>
      </span>
      {!isMe ? <span className="plate-extras"><OppHand n={p.hand.length} pid={pid} sleeve={ctx.sleeves && ctx.sleeves[pid]} /><Piles game={game} pid={pid} ctx={ctx} compact={compact} /></span> : null}
      {isMe && Object.values(p.pool).some(n => n > 0) ? <span className="pool" title="Mana pool">{Object.entries(p.pool).flatMap(([k, n]) => Array.from({ length: n }, (_, i) => <Pip key={k + i} s={k} />))}</span> : null}
      {isMe ? <Piles game={game} pid={pid} ctx={ctx} /> : null}
    </div>
  );
  const front = (
    <div className="row front">
      {creatures.map(g => <CardSlot key={g.cards[0].id} card={g.cards[0]} count={g.cards.length} ids={g.cards.map(c => c.id)} ctx={ctx} />)}
    </div>
  );
  const back = (
    <div className="row back">
      <CommandSlot game={game} pid={pid} ctx={ctx} />
      <UnsetsSlot game={game} pid={pid} ctx={ctx} />
      {other.map(g => <CardSlot key={g.cards[0].id} card={g.cards[0]} count={g.cards.length} ids={g.cards.map(c => c.id)} ctx={ctx} />)}
      {other.length && lands.length ? <span className="divider" /> : null}
      <div className="lands">{lands.map(g => <CardSlot key={g.cards[0].id} card={g.cards[0]} count={g.cards.length} ids={g.cards.map(c => c.id)} ctx={ctx} />)}</div>
    </div>
  );
  return (
    <section className={classes.filter(Boolean).join(' ')} onClick={onSeat} style={{ ...identityStyle(p.colorIdentity), '--fit': fit }} aria-label={`${p.name}'s battlefield`}>
      {plate}
      <div className="field" ref={fieldRef}>{front}{back}</div>
    </section>
  );
}

// ------------------------------------------------------------------ hand fan
// cards you can play from elsewhere sit after your hand with where they are (table.jsx: elsewhere)
const FROM_LABEL = { graveyard: 'Graveyard', exile: 'Exile', library: 'Top of library' };

export function Hand({ game, pid, ctx }) {
  const p = game.players[pid];
  const box = useRef(null);
  const [w, setW] = useState(800);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const extra = ctx.elsewhere || [];
  const n = p.hand.length + extra.length;
  const cw = cssPx(document.documentElement, '--hand-w', 112);
  const gap = 8;
  // whole pixels everywhere so card images and text are never resampled at a fractional offset
  // (inside the hand's padding; the cards from elsewhere start after a fixed break of SEP instead of one overlap)
  const SEP = 14;
  const room = w - 16 - (extra.length && p.hand.length ? SEP : 0);
  const joins = n - 1 - (extra.length && p.hand.length ? 1 : 0);
  const overlap = joins > 0 && n * cw + joins * gap > room ? Math.floor(Math.max(-cw * 0.72, (room - n * cw) / joins)) : gap;
  return (
    <div className="hand" ref={box} aria-label="Your hand" style={{ '--gap': `${overlap}px`, '--lift': `${Math.round(cw * 0.5)}px`, '--grow': `${Math.round(cw * 1.3)}px`, '--shift': `${-Math.round(cw * 0.15)}px` }}>
      {p.hand.map(c => <div key={c.id} className="handslot"><CardSlot card={c} ctx={ctx} size="hand" /></div>)}
      {extra.map(({ card, from }, i) => <div key={card.id} className={`handslot elsewhere ${i === 0 ? 'first' : ''}`} title={FROM_LABEL[from]}><span className="from">{FROM_LABEL[from]}</span><CardSlot card={card} ctx={ctx} size="hand" /></div>)}
      {!n ? <span className="empty">Your hand is empty</span> : null}
    </div>
  );
}

// ------------------------------------------------------------------ table center: stack + recent plays
function targetsOf(game, it) {
  if (!it.sa) return [];
  const out = [];
  for (const s of it.sa.chain()) {
    for (const t of s.targets || []) out.push(t);
    for (const m of s.modes || []) for (const t of m.targets || []) out.push(t);
  }
  return out;
}

export function StackView({ game, ctx, me }) {
  const items = game.stack;
  if (!items.length) return null;
  return (
    <div className="stackview" aria-label="The stack">
      <div className="label">Stack · {items.length}</div>
      <div className="stackfan">
        {items.map((it, i) => {
          const top = i === items.length - 1;
          const who = it.controller === me ? 'You' : game.players[it.controller].name;
          const tg = targetsOf(game, it).map(t => game.name(t)).filter(Boolean);
          const src = it.card || it.source;
          return (
            <div key={it.id} className={`sitem ${top ? 'top' : ''} ${it.kind}`} data-stack={it.id} onMouseEnter={() => src && src.id != null && game.cardById(src.id) && ctx.onHover(src.id)}>
              {it.kind === 'spell' && it.card ? <div className="cardwrap" data-fly={it.card.id}><CardFace v={viewOf(game, it.card)} size="stack" /></div> : (
                <div className="abil">
                  {src && !src.isEffect && game.cardById(src.id) ? <div className="abil-src"><CardFace v={viewOf(game, game.cardById(src.id))} /></div> : null}
                  <div className="abil-txt"><b>{src ? game.name(src) : 'Ability'}</b><RulesText text={it.description} /></div>
                </div>
              )}
              <div className="scap">{who}{tg.length ? <> → {tg.join(', ')}</> : null}</div>
              {top ? <div className="next">Resolves next</div> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// recent spells and abilities from other players, so plays that resolve instantly are still seen
export function useRecentPlays(game, me) {
  const [items, setItems] = useState([]);
  const last = useRef(null);
  const logs = game.logs;
  const lastId = logs.length ? logs[logs.length - 1].id : 0;
  useEffect(() => {
    if (last.current == null) { last.current = lastId; return; }
    const fresh = logs.filter(l => l.id > last.current && (l.type === 'cast' || l.type === 'activate') && l.player != null && l.player !== me && l.cardId != null);
    last.current = lastId;
    if (!fresh.length) return;
    const now = Date.now();
    setItems(xs => [...xs, ...fresh.map(l => ({ id: l.id, cardId: l.cardId, text: l.text, at: now }))].slice(-2));
  }, [lastId]);
  useEffect(() => {
    if (!items.length) return;
    const t = setTimeout(() => setItems(xs => xs.filter(x => Date.now() - x.at < 4200)), 900);
    return () => clearTimeout(t);
  }, [items]);
  return items;
}

export function RecentPlays({ game, items, ctx }) {
  const shown = items.filter(x => !game.stack.some(s => s.card && s.card.id === x.cardId));
  if (!shown.length) return null;
  return (
    <div className="recent" aria-live="polite">
      {shown.map(x => {
        const c = game.cardById(x.cardId);
        return (
          <div key={x.id} className="rplay" onMouseEnter={() => c && ctx.onHover(c.id)}>
            {c ? <div className="cardwrap"><CardFace v={viewOf(game, c)} /></div> : null}
            <span><RulesText text={x.text} /></span>
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ arrows: targets, attacks, blocks
export function ArrowLayer({ game, ctx, boardRef, tick }) {
  const [paths, setPaths] = useState([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [, force] = useState(0);
  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const on = () => force(x => x + 1);
    window.addEventListener('resize', on);
    el.addEventListener('scroll', on, true);
    return () => { window.removeEventListener('resize', on); el.removeEventListener('scroll', on, true); };
  }, []);
  useLayoutEffect(() => {
    const root = boardRef.current;
    if (!root) return;
    const R = root.getBoundingClientRect();
    const find = sel => root.querySelector(sel);
    const center = (el, edge) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.bottom < R.top || r.top > R.bottom) return null;
      return { x: r.left - R.left + r.width / 2, y: r.top - R.top + (edge === 'top' ? r.height * 0.25 : edge === 'bottom' ? r.height * 0.75 : r.height / 2), r };
    };
    const refEl = ref => find(`[data-ref="${ref}"]`);
    const out = [];
    const add = (a, b, kind) => { if (a && b && Math.hypot(a.x - b.x, a.y - b.y) > 24) out.push({ a, b, kind }); };
    for (const it of game.stack) {
      const from = center(find(`[data-stack="${it.id}"]`));
      for (const t of targetsOf(game, it)) {
        const ref = t.isPlayer ? 'p' + t.id : t.isCard ? 'c' + t.id : null;
        if (ref) add(from, center(refEl(ref)), 'target');
      }
    }
    const combat = game.combat;
    const pendingAtk = ctx.attack ? ctx.attack.assigned : null;
    if (combat) {
      for (const a of combat.attackers) add(center(refEl('c' + a.card)), center(refEl(a.defenderCard ? 'c' + a.defenderCard : 'p' + a.defenderPlayer)), 'attack');
      for (const [b, a] of combat.blockers) add(center(refEl('c' + b)), center(refEl('c' + a)), 'block');
    }
    if (pendingAtk) for (const [id, d] of pendingAtk) add(center(refEl('c' + id)), center(refEl(d)), 'attack pending');
    if (ctx.block) for (const [b, a] of ctx.block.assigned) add(center(refEl('c' + b)), center(refEl('c' + a)), 'block pending');
    const key = JSON.stringify(out.map(p => [Math.round(p.a.x), Math.round(p.a.y), Math.round(p.b.x), Math.round(p.b.y), p.kind]));
    setPaths(prev => (prev.key === key ? prev : Object.assign(out.map(p => ({ ...p, a: { x: p.a.x, y: p.a.y }, b: { x: p.b.x, y: p.b.y } })), { key })));
    if (size.w !== root.scrollWidth || size.h !== root.scrollHeight) setSize({ w: root.scrollWidth, h: root.scrollHeight });
  });
  if (!paths.length) return null;
  return (
    <svg className="arrows" width={size.w} height={size.h} aria-hidden="true">
      <defs>
        {['target', 'attack', 'block'].map(k => (
          <marker key={k} id={`ah-${k}`} viewBox="0 0 10 10" refX="7" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" className={`ahead ${k}`} />
          </marker>
        ))}
      </defs>
      {paths.map((p, i) => {
        const mx = (p.a.x + p.b.x) / 2, my = (p.a.y + p.b.y) / 2;
        const dx = p.b.x - p.a.x, dy = p.b.y - p.a.y;
        const len = Math.hypot(dx, dy) || 1;
        const bend = Math.min(80, len * 0.22);
        const cx = mx - (dy / len) * bend, cy = my + (dx / len) * bend;
        const kind = p.kind.split(' ')[0];
        return <path key={i} className={`arrow ${p.kind}`} d={`M${p.a.x},${p.a.y} Q${cx},${cy} ${p.b.x},${p.b.y}`} markerEnd={`url(#ah-${kind})`} />;
      })}
    </svg>
  );
}

// ------------------------------------------------------------------ turn banner
export function TurnBanner({ game, me }) {
  const [shown, setShown] = useState(null);
  const key = `${game.turnNumber}:${game.activePlayer}`;
  useEffect(() => {
    if (!game.turnNumber || game.over) return;
    const mine = game.activePlayer === me;
    setShown({ key, text: mine ? 'Your turn' : `${game.players[game.activePlayer].name}'s turn`, mine });
    const t = setTimeout(() => setShown(null), 1500);
    return () => clearTimeout(t);
  }, [key]);
  if (!shown) return null;
  return <div key={shown.key} className={`turnbanner ${shown.mine ? 'mine' : ''}`} aria-hidden="true"><span>{shown.text}</span><small>Turn {game.turnNumber}</small></div>;
}
