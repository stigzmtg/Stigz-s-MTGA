// The Pokémon battle screen: both sides of the table (Prizes, Bench, Active, deck and discard), the hand, an action
// bar for the turn (attacks, Retreat, Abilities, End turn), dialogs for every choice an effect asks for, and
// short animations for attacks, damage, coin flips and Knock Outs.
import { Energy, Cost, TYPE_COLORS } from './energy.jsx';
import { pkImage, subscribePk, pkImagesVersion } from './images.js';
import { Modal } from '../../ui/dialogs.jsx';
import { secondPerson } from '../../ui/table.jsx';
import { RoomStatus } from '../../ui/online.jsx';

const { useState, useEffect, useRef, useSyncExternalStore } = React;
const COND_LABEL = { asleep: 'Asleep', confused: 'Confused', paralyzed: 'Paralyzed' };

// ---------------------------------------------------------------- a card picture (with a drawn fallback)
function CardArt({ def, cls = '', onClick, onEnter, onLeave, title }) {
  const img = def && pkImage(def.key);
  return (
    <div className={`pk-card ${cls}`} onClick={onClick} onMouseEnter={onEnter} onMouseLeave={onLeave} title={title}
      role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e); } }) : undefined}
      style={{ '--t': TYPE_COLORS[def && (def.type || def.provides)] || '#c9c1a8' }}>
      {img ? <img src={img} alt={def.name} draggable="false" /> : (
        <div className="drawn">
          <b>{def ? def.name : ''}</b>
          {def && def.cat === 'P' ? <span>HP {def.hp}</span> : <span>{def ? (def.trainer || (def.cat === 'E' ? 'Energy' : '')) : ''}</span>}
        </div>
      )}
    </div>
  );
}
const CardBack = ({ cls = '' }) => <div className={`pk-card back ${cls}`}><span className="ball" /></div>;

// ---------------------------------------------------------------- a Pokémon in play
function MonView({ game, mon, big, state, fx, onClick, onHover }) {
  const max = game.maxHp(mon), left = Math.max(0, max - mon.damage);
  const pct = Math.max(0, Math.min(100, (left / max) * 100));
  const hit = fx.hits.get(mon.id);
  const cls = ['pk-mon', big ? 'big' : '', state || '', hit ? 'hit' : '', fx.lunge === mon.id ? (mon.owner === fx.me ? 'lunge-up' : 'lunge-down') : '', fx.entered.has(mon.id) ? 'enter' : ''].filter(Boolean).join(' ');
  const conds = [mon.special && COND_LABEL[mon.special], mon.poisoned && 'Poisoned', mon.burned && 'Burned'].filter(Boolean);
  return (
    <div className={cls} data-mon={mon.id}>
      <CardArt def={mon.def} onClick={onClick} onEnter={() => onHover({ mon: mon.id })} onLeave={() => onHover(null)} title={`${mon.name} · ${left}/${max} HP`} />
      {mon.damage ? <span className="pk-dmg" title={`${mon.damage} damage`}>{mon.damage}</span> : null}
      {hit ? <span key={hit.key} className="pk-float">−{hit.amount}</span> : null}
      {conds.length ? <span className="pk-conds">{conds.map(c => <span key={c} className={`c ${c.toLowerCase()}`}>{c}</span>)}</span> : null}
      <div className="pk-hp" title={`${left} / ${max} HP`}><i style={{ width: pct + '%' }} className={pct <= 30 ? 'low' : pct <= 60 ? 'mid' : ''} /><span>{left}</span></div>
      <div className="pk-attached">
        {mon.energy.map(c => <Energy key={c.id} type={c.def.provides || 'Colorless'} size={big ? 18 : 14} title={c.name} />)}
        {mon.tool ? <span className="pk-tool" title={mon.tool.name}>{mon.tool.name.replace('Technical Machine: ', 'TM ')}</span> : null}
      </div>
    </div>
  );
}

function EmptySlot({ big }) { return <div className={`pk-mon empty ${big ? 'big' : ''}`}><div className="pk-card slot" /></div>; }

function Prizes({ n, label }) {
  return (
    <div className="pk-prizes" title={`${n} Prize card${n === 1 ? '' : 's'} left`} aria-label={`${label}: ${n} Prize cards left`}>
      <div className="grid">{Array.from({ length: 6 }, (_, i) => i < n ? <CardBack key={i} cls="tiny" /> : <span key={i} className="taken" />)}</div>
      <div className="cap"><b>{n}</b> Prize{n === 1 ? '' : 's'}</div>
    </div>
  );
}

function Piles({ game, p, onOpen }) {
  const top = p.discard[p.discard.length - 1];
  return (
    <div className="pk-piles">
      <div className="pile" title={`Deck: ${p.deck.length} cards`}><CardBack cls="tiny" /><span><b>{p.deck.length}</b> Deck</span></div>
      <button className="pile" onClick={() => onOpen('discard')} title="See the discard pile">{top ? <CardArt def={top.def} cls="tiny" /> : <span className="pk-card tiny slot" />}<span><b>{p.discard.length}</b> Discard</span></button>
      {p.lost.length ? <button className="pile" onClick={() => onOpen('lost')} title="See the Lost Zone"><span className="pk-card tiny lostz" /><span><b>{p.lost.length}</b> Lost Zone</span></button> : null}
    </div>
  );
}

// ---------------------------------------------------------------- animations driven by the engine's events
function useFx(game, me, watching) {
  const [, force] = useState(0);
  const st = useRef({ last: 0, hits: new Map(), lunge: null, entered: new Set(), coin: null, banner: null, timers: [] });
  const s = st.current;
  s.me = me;
  const later = (ms, f) => { const t = setTimeout(() => { f(); force(x => x + 1); }, ms); s.timers.push(t); };
  useEffect(() => () => s.timers.forEach(clearTimeout), []);
  const fresh = game.events.filter(e => e.id > s.last);
  if (fresh.length) {
    s.last = fresh[fresh.length - 1].id;
    let coinDelay = 0;
    for (const e of fresh) {
      if (e.kind === 'damage') { s.hits.set(e.mon, { amount: e.amount, key: e.id }); later(1100, () => { const h = s.hits.get(e.mon); if (h && h.key === e.id) s.hits.delete(e.mon); }); }
      if (e.kind === 'attack') { s.lunge = e.mon; later(420, () => { if (s.lunge === e.mon) s.lunge = null; }); s.banner = { text: e.name, key: e.id, kind: 'attack' }; later(1300, () => { if (s.banner && s.banner.key === e.id) s.banner = null; }); }
      if (e.kind === 'enter' || e.kind === 'evolve') { s.entered.add(e.mon); later(600, () => s.entered.delete(e.mon)); }
      if (e.kind === 'coin') {
        const at = coinDelay; coinDelay += 900;
        later(at, () => { s.coin = { heads: e.heads, reason: e.reason, key: e.id }; });
        later(at + 1500, () => { if (s.coin && s.coin.key === e.id) s.coin = null; });
      }
      if (e.kind === 'ko') { s.banner = { text: `${e.name} is Knocked Out!`, key: e.id, kind: 'ko' }; later(1600, () => { if (s.banner && s.banner.key === e.id) s.banner = null; }); }
      if (e.kind === 'turn') { s.banner = { text: e.pid === me && !watching ? 'Your turn' : `${game.players[e.pid].name}'s turn`, key: e.id, kind: 'turn' }; later(1200, () => { if (s.banner && s.banner.key === e.id) s.banner = null; }); }
    }
  }
  return s;
}

// ---------------------------------------------------------------- dialogs for the engine's questions
function CardsDialog({ game, req, respond, onHover }) {
  const [sel, setSel] = useState([]);
  const opts = new Set(req.options);
  const shown = (req.shown || req.options).map(id => game.cardById(id)).filter(Boolean);
  const pickable = shown.filter(c => opts.has(c.id));
  const toggle = id => setSel(s => s.includes(id) ? s.filter(x => x !== id) : s.length >= req.max ? (req.max === 1 ? [id] : s) : [...s, id]);
  const ok = sel.length >= req.min && sel.length <= req.max;
  const title = { deck: 'Your deck', discard: 'Your discard pile', 'deck-top': 'Top of your deck', prizes: 'Your Prize cards', energy: 'Attached Energy', 'opp-hand': "Your opponent's hand", hand: 'Your hand' }[req.from] || 'Choose';
  return (
    <Modal label={req.prompt}>
      <h2>{title}</h2>
      <p className="sub">{req.prompt}{req.max > 1 ? ` (${req.min === req.max ? req.min : `${req.min}–${req.max}`})` : ''}</p>
      {req.from === 'deck' && !pickable.length ? <p className="sub">No card in your deck fits.</p> : null}
      <div className="pk-picks">
        {(req.from === 'deck' ? [...pickable, ...shown.filter(c => !opts.has(c.id))] : shown).map(c => {
          const can = opts.has(c.id);
          const on = sel.includes(c.id);
          return (
            <div key={c.id} className={`pk-pick ${can ? '' : 'off'} ${on ? 'on' : ''}`}>
              <CardArt def={c.def} onClick={can ? () => toggle(c.id) : undefined} onEnter={() => onHover({ card: c.id })} onLeave={() => onHover(null)} />
              {on ? <span className="tick">{req.max > 1 ? sel.indexOf(c.id) + 1 : '✓'}</span> : null}
            </div>
          );
        })}
      </div>
      <div className="row">
        <button className="btn primary" disabled={!ok} onClick={() => respond(sel)}>{sel.length ? 'Confirm' : req.min === 0 ? 'Take nothing' : 'Confirm'}</button>
        {req.min === 0 && sel.length ? <button className="btn" onClick={() => setSel([])}>Clear</button> : null}
      </div>
    </Modal>
  );
}

function DistributeDialog({ game, req, respond, onHover }) {
  const mons = req.options.map(id => game.monById(id)).filter(Boolean);
  const [plan, setPlan] = useState({});
  const used = Object.values(plan).reduce((a, b) => a + b, 0);
  const left = req.total - used;
  const add = (id, d) => setPlan(p => { const v = Math.max(0, (p[id] || 0) + d); if (d > 0 && left <= 0) return p; return { ...p, [id]: v }; });
  return (
    <Modal label={req.prompt}>
      <h2>Place damage counters</h2>
      <p className="sub">{req.prompt}. <b>{left}</b> left to place (10 damage each).</p>
      <div className="pk-picks">
        {mons.map(m => {
          const n = plan[m.id] || 0;
          return (
            <div key={m.id} className={`pk-pick dist ${n ? 'on' : ''}`}>
              <CardArt def={m.def} onClick={() => add(m.id, 1)} onEnter={() => onHover({ mon: m.id })} onLeave={() => onHover(null)} />
              <div className="hpline">{game.hpLeft(m)} HP left{n * 10 >= game.hpLeft(m) ? <b className="ko"> · KO</b> : null}</div>
              <div className="ctr"><button className="btn sm" onClick={() => add(m.id, -1)} disabled={!n}>−</button><b>{n}</b><button className="btn sm" onClick={() => add(m.id, 1)} disabled={left <= 0}>+</button></div>
            </div>
          );
        })}
      </div>
      <div className="row"><button className="btn primary" disabled={left !== 0} onClick={() => respond(plan)}>Done</button></div>
    </Modal>
  );
}

function ZoneDialog({ game, p, mine, zone, onClose, onHover }) {
  const cards = p[zone];
  return (
    <Modal label={zone} onClose={onClose}>
      <h2>{mine ? 'Your' : `${p.name}'s`} {zone === 'lost' ? 'Lost Zone' : 'discard pile'} · {cards.length}</h2>
      <div className="pk-picks">{[...cards].reverse().map(c => <div key={c.id} className="pk-pick"><CardArt def={c.def} onEnter={() => onHover({ card: c.id })} onLeave={() => onHover(null)} /></div>)}</div>
      <div className="row"><button className="btn" onClick={onClose}>Close</button></div>
    </Modal>
  );
}

// ---------------------------------------------------------------- the side panel: the card you point at, and the log
function Preview({ game, hover }) {
  let def = null, mon = null;
  if (hover && hover.mon != null) { mon = game.monById(hover.mon); def = mon && mon.def; }
  if (hover && hover.card != null) { const c = game.cardById(hover.card); def = c && c.def; }
  if (hover && hover.key) def = game.db[hover.key];
  if (!def) return <div className="empty">Point at any card to read it here.</div>;
  const img = pkImage(def.key);
  return (
    <div className="pk-preview">
      {img ? <img src={img} alt={def.name} /> : <CardArt def={def} cls="big" />}
      <div className="facts">
        {def.cat === 'P' ? <>
          {(def.abilities || []).map(a => <p key={a.name}><b className="ab">Ability · {a.name}</b> {a.text}</p>)}
          {(def.attacks || []).map(a => <p key={a.name}><Cost cost={a.cost} size={14} /> <b>{a.name}</b>{a.damage ? <b className="dmg"> {a.damage}</b> : null} {a.text}</p>)}
          <p className="wr">{def.weak ? <>Weakness <Energy type={def.weak} size={13} /> ×2 · </> : null}{def.resist ? <>Resistance <Energy type={def.resist} size={13} /> −30 · </> : null}Retreat {def.retreat}{def.ex ? ` · Knocked Out: opponent takes ${def.mega ? 3 : 2} Prizes` : ''}</p>
        </> : <p>{def.text || (def.cat === 'E' ? `Provides ${def.provides} Energy.` : '')}</p>}
        {mon ? <p className="state">{game.hpLeft(mon)}/{game.maxHp(mon)} HP{mon.energy.length ? ` · ${mon.energy.length} Energy` : ''}{mon.tool ? ` · ${mon.tool.name}` : ''}</p> : null}
      </div>
    </div>
  );
}

// engine text names your player "You": make it read as English ("You has" -> "You have", "their" -> "your")
const youText = t => secondPerson(t).replace(/^You (\w+) (all of )?their /, 'You $1 $2your ').replace(/ into You's /, ' into your ');

function Log({ game, me }) {
  const ref = useRef(null);
  useEffect(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }, [game.logs.length]);
  return (
    <div className="log pk-log" ref={ref}>
      {game.logs.slice(-200).map((l, i) => { const t = youText(l.text); return <div key={i} className={`e ${l.type || ''} ${me != null && l.pid === me ? 'mine' : ''}`}>{l.type === 'turn' ? <b>{t}</b> : t}</div>; })}
    </div>
  );
}

// ---------------------------------------------------------------- the battle
// session.me is your seat (the bottom of the table); watchers of a friends' battle see the host's seat at the bottom
export function Battle({ session, host, onExit, onRematch, onLobby }) {
  const { game, human, store } = session;
  useSyncExternalStore(store.subscribe, store.get);
  useSyncExternalStore(subscribePk, pkImagesVersion);
  const me = session.me || 0, opp = 1 - me;
  const watching = !!session.spectator, online = !!session.online;
  const whose = p => (!watching && p.id === me ? 'Your' : `${p.name}'s`);
  const P = game.players[me], O = game.players[opp];
  const pend = human.pending;
  const req = pend ? pend.req : null;
  const [hover, setHover] = useState(null);
  const [mode, setMode] = useState(null);       // picking a target for a hand card / retreat
  const [sel, setSel] = useState([]);           // multi-select for 'mon' questions
  const [zone, setZone] = useState(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [flash, setFlash] = useState(null);
  const fx = useFx(game, me, watching);
  useEffect(() => { setMode(null); setSel([]); setConfirmEnd(false); }, [pend && pend.id]);
  useEffect(() => { if (!flash) return; const t = setTimeout(() => setFlash(null), 2200); return () => clearTimeout(t); }, [flash]);
  useEffect(() => {
    const k = e => { if (e.key === 'Escape') setMode(null); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const respond = v => { setMode(null); setSel([]); human.respond(v); };
  const actions = req && req.type === 'main' ? req.actions : [];
  const myTurn = game.current === me && !game.over && !watching;
  const monReq = req && req.type === 'mon' ? req : null;
  const targets = new Set(monReq ? monReq.options : mode ? mode.options : []);

  const onMon = mon => {
    if (monReq && targets.has(mon.id)) {
      if (monReq.max <= 1) return respond([mon.id]);
      return setSel(s => s.includes(mon.id) ? s.filter(x => x !== mon.id) : s.length < monReq.max ? [...s, mon.id] : s);
    }
    if (mode && targets.has(mon.id)) {
      if (mode.kind === 'retreat') return respond({ t: 'retreat', to: mon.id });
      return respond(actions.find(a => a.t === mode.kind && a.card === mode.card && a.target === mon.id));
    }
    setHover({ mon: mon.id });
  };
  const onHand = card => {
    if (!actions.length) return;
    const acts = actions.filter(a => a.card === card.id);
    if (!acts.length) {
      const d = card.def;
      const why = d.cat === 'E' && P.energyDone ? 'You already attached an Energy this turn.'
        : d.trainer === 'Supporter' && P.supporter ? 'You already played a Supporter this turn.'
        : d.trainer === 'Supporter' && game.turn === 1 && game.first === me ? "The player who goes first can't play a Supporter on their first turn."
        : d.cat === 'P' && d.stage !== 'Basic' && P.turns === 1 ? "You can't evolve on your first turn."
        : d.cat === 'P' && d.stage !== 'Basic' ? `Needs a ${d.from} that has been in play since before this turn.`
        : d.cat === 'P' ? 'Your Bench is full.'
        : game.hasEffect('itemLock', { pid: me }) && d.trainer === 'Item' ? "You can't play Item cards this turn."
        : "You can't play that right now.";
      return setFlash(why);
    }
    const t = acts[0].t;
    if (t === 'bench' || t === 'trainer') return respond(acts[0]);
    if (acts.length === 1) return respond(acts[0]);
    setMode(mode && mode.card === card.id ? null : { kind: t, card: card.id, options: acts.map(a => a.target) });
  };

  const active = P.active;
  const attackRows = active && myTurn && req && req.type === 'main' ? game.attacksOf(active).map(atk => {
    const act = actions.find(a => a.t === 'attack' && a.name === atk.name && a.src === atk.src);
    return { atk, act, why: act ? null : game.attackBlock(active, atk) };
  }) : [];
  const retreatActs = actions.filter(a => a.t === 'retreat');
  const abilityActs = actions.filter(a => a.t === 'ability');
  const stadiumAct = actions.find(a => a.t === 'stadium');
  const canAttack = attackRows.some(r => r.act);

  const stateOf = mon => (targets.has(mon.id) ? (sel.includes(mon.id) ? 'selected' : 'targetable') : '');
  const side = (p, bottom) => {
    const isMe = bottom && !watching;
    const limit = game.benchLimit(p.id);
    const bench = (
      <div className="pk-bench" style={{ '--slots': Math.max(5, limit) }}>
        {p.bench.map(m => <MonView key={m.id} game={game} mon={m} state={stateOf(m)} fx={fx} onClick={() => onMon(m)} onHover={setHover} />)}
        {Array.from({ length: Math.max(0, Math.min(5, limit) - p.bench.length) }, (_, i) => <EmptySlot key={'e' + i} />)}
      </div>
    );
    const act = <div className="pk-activespot">{p.active ? <MonView game={game} mon={p.active} big state={stateOf(p.active)} fx={fx} onClick={() => onMon(p.active)} onHover={setHover} /> : <EmptySlot big />}</div>;
    return (
      <section className={`pk-side ${bottom ? 'me' : 'opp'} ${game.current === p.id && !game.over ? 'turn' : ''}`} aria-label={`${whose(p)} side`}>
        <div className="pk-plate">
          <div className="who"><b>{p.name}</b>{game.current === p.id && !game.over ? <span className="turnmark">turn</span> : null}</div>
          <div className="deck">{p.deckName}</div>
          <Prizes n={p.prizes.length} label={p.name} />
          {!bottom ? <div className="opphand" title={`${p.hand.length} cards in hand`}><span className="fan">{Array.from({ length: Math.min(p.hand.length, 8) }, (_, i) => <CardBack key={i} cls="micro" />)}</span><b>{p.hand.length}</b> in hand</div> : null}
        </div>
        <div className="pk-field">{act}{bench}</div>
        <Piles game={game} p={p} onOpen={z => setZone({ p, z, mine: isMe })} />
      </section>
    );
  };

  // the bar between the two sides: what to do now
  let bar;
  const result = game.over ? (game.winner == null ? 'Draw' : game.winner === me && !watching ? 'You win!' : `${game.players[game.winner].name} wins`) : null;
  if (game.over) {
    bar = <div className="msg"><div className="step">Game over</div><div className="txt">{result}{result === 'You win!' ? ' ' : '. '}{youText(game.result || '')}</div></div>;
  } else if (req && req.type === 'confirm') {
    bar = <><div className="msg"><div className="txt">{req.prompt}</div></div><div className="acts"><button className="btn primary" onClick={() => respond(true)}>Yes</button><button className="btn" onClick={() => respond(false)}>No</button></div></>;
  } else if (req && req.type === 'option' && req.options.length <= 6) {
    bar = <><div className="msg"><div className="txt">{req.prompt}</div></div><div className="acts">{req.options.map(o => <button key={String(o.value)} className="btn" onClick={() => respond(o.value)}>{o.label}</button>)}</div></>;
  } else if (monReq) {
    bar = <><div className="msg"><div className="step">Choose</div><div className="txt">{monReq.prompt}</div></div>
      <div className="acts">{monReq.max > 1 || monReq.min === 0 ? <button className="btn primary" disabled={sel.length < monReq.min} onClick={() => respond(sel)}>Done{sel.length ? ` (${sel.length})` : ''}</button> : null}</div></>;
  } else if (mode) {
    const c = P.hand.find(x => x.id === mode.card);
    bar = <><div className="msg"><div className="step">{mode.kind === 'retreat' ? 'Retreat' : c ? c.name : ''}</div><div className="txt">{mode.kind === 'retreat' ? 'Choose the Benched Pokémon to switch in.' : mode.kind === 'evolve' ? 'Choose the Pokémon to evolve.' : mode.kind === 'tool' ? 'Choose the Pokémon to attach the Tool to.' : 'Choose the Pokémon to attach the Energy to.'}</div></div>
      <div className="acts"><button className="btn" onClick={() => setMode(null)}>Cancel</button></div></>;
  } else if (req && req.type === 'main') {
    bar = <>
      <div className="msg"><div className="step">Your turn · {P.turns === 1 && game.first === me ? 'first turn: no attack' : 'play cards, then attack'}</div>
        <div className="txt">{flash || (P.energyDone ? 'Energy attached. ' : 'Attach one Energy, ') + (P.supporter ? 'Supporter played.' : 'play one Supporter, any Items.')}</div></div>
      <div className="acts pk-acts">
        {attackRows.map(r => (
          <button key={r.atk.name + r.atk.src} className={`btn atk ${r.act ? 'primary' : ''}`} disabled={!r.act} title={r.why || r.atk.text || r.atk.name} onClick={() => respond(r.act)}>
            <Cost cost={game.attackCost(active, r.atk)} size={15} /> <span>{r.atk.name}</span>{r.atk.damage ? <b>{r.atk.damage}</b> : null}
          </button>
        ))}
        {retreatActs.length ? <button className="btn" onClick={() => setMode({ kind: 'retreat', options: retreatActs.map(a => a.to) })} title="Discard Energy equal to the Retreat Cost">Retreat <Cost cost={Array(game.retreatCost(active)).fill('Colorless')} size={13} /></button> : null}
        {[...new Map(abilityActs.map(a => [a.name, a])).values()].map(a => {
          const m = game.monById(a.mon);
          const n = abilityActs.filter(x => x.name === a.name).length;
          return <button key={a.name} className="btn ability" onClick={() => respond(a)} title={(m.def.abilities.find(x => x.name === a.name) || {}).text}>{a.name} <small>{m.name}{n > 1 ? ` ×${n}` : ''}</small></button>;
        })}
        {stadiumAct ? <button className="btn" onClick={() => respond(stadiumAct)}>Use {stadiumAct.name}</button> : null}
        <button className={`btn ${confirmEnd ? 'danger' : ''}`} onClick={() => { if (canAttack && !confirmEnd) return setConfirmEnd(true); respond({ t: 'end' }); }}>{confirmEnd ? 'End without attacking?' : 'End turn'}</button>
      </div>
    </>;
  } else {
    // someone else decides: the player whose turn it is, or whoever an effect asked
    const asked = game.players[game.pendingAsk ? game.pendingAsk.pid : game.current];
    const doing = !game.turn ? 'Setting up' : online && asked && (watching || asked.id !== me) ? `${asked.name} ${asked.id === game.current ? 'is playing' : 'is choosing'}` : 'Thinking';
    bar = <div className="msg waiting"><div className="step">{game.turn ? `${whose(game.players[game.current])} turn` : 'Getting ready'}</div><div className="txt thinking">{doing}</div></div>;
  }

  const handActs = new Set(actions.filter(a => a.card != null).map(a => a.card));
  const [dismissed, setDismissed] = useState(false);
  return (
    <div className="app table pk">
      <header className="topbar">
        <button className="brand linklike" onClick={onExit} title="Leave the battle">Precon Arena</button>
        <span className="chip pk-chip">Pokémon TCG</span>
        <span className="turninfo">Turn <b>{game.turn}</b> · <b>{game.players[game.current].name}</b></span>
        <RoomStatus session={session} />
        <span className="spacer" />
        <button className="btn sm danger" onClick={onExit} title={online && host && !game.over ? 'Ends the battle for both players' : undefined}>{game.over ? (online ? 'Back to room' : 'New battle') : online ? (host ? 'End battle' : watching ? 'Stop watching' : 'Leave battle') : 'Leave battle'}</button>
      </header>
      <div className="game pk-game">
        <main className="pk-board" onClick={e => { if (e.target === e.currentTarget) setMode(null); }}>
          {side(O, false)}
          <div className="pk-mid">
            <div className="pk-stadium" title={game.stadium ? game.stadium.card.name : 'No Stadium in play'}>
              {game.stadium ? <CardArt def={game.stadium.card.def} cls="small" onEnter={() => setHover({ card: game.stadium.card.id })} onLeave={() => setHover(null)} /> : <span className="none">No Stadium</span>}
            </div>
            <div className={`prompt pk-prompt ${req ? '' : 'waiting'}`}>{bar}</div>
            <div className="pk-coinbox">{fx.coin ? <div key={fx.coin.key} className={`pk-coin ${fx.coin.heads ? 'heads' : 'tails'}`}><span className="face">{fx.coin.heads ? 'H' : 'T'}</span><span className="lbl">{fx.coin.heads ? 'Heads' : 'Tails'}{fx.coin.reason ? <small>{fx.coin.reason}</small> : null}</span></div> : null}</div>
          </div>
          {side(P, true)}
          <div className="pk-hand" aria-label={`${whose(P)} hand`} style={{ '--n': P.hand.length }}>
            {watching ? P.hand.map(c => <div key={c.id} className="pk-handslot"><CardBack /></div>) : P.hand.map(c => (
              <div key={c.id} className={`pk-handslot ${handActs.has(c.id) ? 'playable' : ''} ${mode && mode.card === c.id ? 'chosen' : ''}`}>
                <CardArt def={c.def} onClick={() => onHand(c)} onEnter={() => setHover({ card: c.id })} onLeave={() => setHover(null)} />
              </div>
            ))}
            {!P.hand.length ? <span className="empty">{whose(P)} hand is empty</span> : null}
          </div>
          {fx.banner ? <div key={fx.banner.key} className={`pk-banner ${fx.banner.kind}`}>{fx.banner.text}</div> : null}
        </main>
        <aside className="rail">
          <section className="preview-sec"><Preview game={game} hover={hover || (P.active ? { mon: P.active.id } : null)} /></section>
          <section className="log-sec"><h3>Battle log</h3><Log game={game} me={watching ? null : me} /></section>
        </aside>
      </div>
      {req && req.type === 'cards' ? <CardsDialog key={pend.id} game={game} req={req} respond={respond} onHover={setHover} /> : null}
      {req && req.type === 'distribute' ? <DistributeDialog key={pend.id} game={game} req={req} respond={respond} onHover={setHover} /> : null}
      {req && req.type === 'option' && req.options.length > 6 ? (
        <Modal label={req.prompt}><h2>{req.prompt}</h2><div className="pk-optlist">{req.options.map(o => <button key={String(o.value)} className="btn" onClick={() => respond(o.value)}>{o.label}</button>)}</div></Modal>
      ) : null}
      {zone ? <ZoneDialog game={game} p={zone.p} mine={zone.mine} zone={zone.z} onClose={() => setZone(null)} onHover={setHover} /> : null}
      {result && !dismissed ? (
        <Modal narrow label="Game over">
          <h2 className={result === 'You win!' ? 'win' : ''}>{result}</h2>
          <p className="sub">{youText(game.result || '')}. {game.turn} turns.{online && !host ? ' The host can start a rematch from here.' : ''}</p>
          <div className="row">
            <button className="btn" onClick={() => setDismissed(true)}>View board</button>
            <button className="btn" onClick={onLobby}>{online ? 'Back to room' : 'New battle'}</button>
            {!online || host ? <button className="btn primary" onClick={onRematch}>Rematch</button> : null}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
