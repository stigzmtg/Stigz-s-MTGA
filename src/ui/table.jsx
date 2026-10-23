// The game table: seats, battlefield, hand, prompt bar, rail (preview / stack / log) and interactions.
import { CardFace, viewOf, ManaCost, Pip, RulesText } from './cardview.jsx';
import { Mat, Hand, StackView, RecentPlays, useRecentPlays, ArrowLayer, TurnBanner } from './board.jsx';
import { imagesAvailable, subscribeImages, imagesVersion } from './images.js';
import { Modal, CardsDialog, TargetsDialog, OptionDialog, ModesDialog, ConfirmDialog, NumberDialog, ColorDialog, PlayerDialog, MulliganDialog, ZoneDialog, SettingsDialog, TokenDialog, HelpDialog, Menu, SoundToggle, SizeButton } from './dialogs.jsx';
import { getActions, refOf, fromRef, manaAbilitiesOf, manaSourcesFor, activateManaAbility, parseCost } from '../engine/abilities.js';
import { STEP_NAMES } from '../engine/game.js';
import { blockRules } from '../engine/combat.js';
import { applyOp, cardMenuItems, playerMenuItems } from './manual.js';
import { RoomStatus } from './online.jsx';
import { useGameSounds } from './sound.js';
import { recordGame } from './records.js';
import { ReplayBar } from './replaybar.jsx';
import { useEmotes, EmoteButton, WatcherEmotes } from './emotes.jsx';
import { Coach } from './coach.jsx';
import { savedStyle } from './deckstyle.jsx';
import { myAvatar } from './avatar.jsx';

const { useState, useEffect, useRef, useMemo, useSyncExternalStore } = React;

export function useStore(store) { return useSyncExternalStore(store.subscribe, store.get); }

const PHASES = [
  ['untap', 'Untap'], ['upkeep', 'Upkeep'], ['draw', 'Draw'], '|', ['main1', 'Main 1'], '|',
  ['beginCombat', 'Combat'], ['declareAttackers', 'Attack'], ['declareBlockers', 'Block'], ['combatDamage', 'Damage'], ['endCombat', 'End combat'], '|', ['main2', 'Main 2'], '|', ['end', 'End'], ['cleanup', 'Cleanup'],
];

function PhaseTracker({ game }) {
  const step = game.step === 'firstStrikeDamage' ? 'combatDamage' : game.step;
  const steps = PHASES.filter(p => p !== '|').map(p => p[0]);
  const at = steps.indexOf(step);
  const near = k => { const j = steps.indexOf(k); return at >= 0 && Math.abs(j - at) <= 1; };
  return (
    <div className="phases" aria-label="Turn structure">
      {PHASES.map((p, i) => p === '|' ? <span key={i} className="ph sep" /> : <span key={p[0]} className={`ph ${step === p[0] ? 'on' : ''} ${near(p[0]) ? 'near' : ''}`}>{p[1]}</span>)}
    </div>
  );
}

const IRREG = { has: 'have', is: 'are', was: 'were', does: 'do', goes: 'go' };
export function secondPerson(text) {
  const verb = v => IRREG[v] || (/(ches|shes|sses|xes|zzes)$/.test(v) ? v.slice(0, -2) : /ies$/.test(v) ? v.slice(0, -3) + 'y' : /s$/.test(v) && !/ss$/.test(v) ? v.slice(0, -1) : v);
  return text
    .replace(/(^|[.:!]\s+|\()You (\w+)/g, (m, pre, v) => `${pre}You ${verb(v)}`)
    .replace(/You (search|shuffle)(?:es)? their library/g, 'You $1 your library')
    .replace(/ (to|from|of|targeting|attacking|with|by) You\b/g, ' $1 you')
    .replace(/→ You\b/g, '→ you')
    .replace(/\bYou's\b/g, 'Your');
}

function LogPanel({ game, me, onHover }) {
  const ref = useRef(null);
  const logs = game.logs.slice(-220);
  useEffect(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }, [game.logs.length, logs.length && logs[logs.length - 1].id]);
  return (
    <div className="log" ref={ref} aria-live="polite">
      {logs.map(l => <div key={l.id} className={`e ${l.type || ''}`} onMouseEnter={() => l.cardId && onHover(l.cardId)}><RulesText text={game.players[me] && game.players[me].name === 'You' ? secondPerson(l.text) : l.text} /></div>)}
    </div>
  );
}

function Preview({ game, cardId, support, images, me = 0 }) {
  const card = cardId != null ? game.cardById(cardId) : null;
  if (!card) return <div className="empty">Point at any card to read it here.</div>;
  const v = viewOf(game, card);
  const hidden = card.faceDown && card.controller !== me && card.owner !== me;
  const facts = [];
  if (card.zone === 'battlefield') {
    facts.push(`${game.players[card.controller].name}${card.controller !== card.owner ? ` (owned by ${game.players[card.owner].name})` : ''}`);
    if (card.tapped) facts.push('Tapped');
    if (v.sick) facts.push('Summoning sick');
    if (v.power != null && v.ptState) facts.push(`Currently ${v.power}/${v.toughness}`);
    if (v.damage) facts.push(`${v.damage} damage marked`);
    const att = game.attachmentsOf(card);
    if (att.length) facts.push('Attached: ' + att.map(a => game.name(a)).join(', '));
    if (card.attachedTo != null) { const h = typeof card.attachedTo === 'number' ? game.cardById(card.attachedTo) : game.players[+String(card.attachedTo).slice(1)]; if (h) facts.push('Attached to ' + game.name(h)); }
    if (card.chosen && card.chosen.colors) facts.push('Chosen color: ' + card.chosen.colors.join(', '));
    if (card.chosen && card.chosen.type) facts.push('Chosen type: ' + card.chosen.type);
    if (v.granted && v.granted.length) facts.push('Has ' + v.granted.join(', '));
  } else facts.push(`${card.zone[0].toUpperCase() + card.zone.slice(1)} · ${game.players[card.owner].name}`);
  const warn = support && support[card.def.name];
  const shown = hidden ? { ...v, name: 'Face-down creature', oracle: '', img: null, faceDown: true } : images ? v : { ...v, img: null };
  return (
    <div className="preview">
      <div className="bigcard"><div className="cardwrap"><CardFace v={shown} size="big" /></div></div>
      {/* the card's words as real text: sharp at any size, unlike the small print in the picture */}
      {shown.img ? (
        <div className="cardtext">
          <div className="ct-head"><b>{v.name}</b>{v.cost ? <ManaCost cost={v.cost} /> : null}</div>
          <div className="ct-type">{v.typeLine}</div>
          {v.oracle ? <div className="ct-rules"><RulesText text={v.oracle} /></div> : null}
          {v.power != null ? <div className="ct-pt">{v.power}/{v.toughness}</div> : v.loyalty != null ? <div className="ct-pt">Loyalty {v.loyalty}</div> : v.defense != null ? <div className="ct-pt">Defense {v.defense}</div> : null}
        </div>
      ) : null}
      <div className="facts">
        {facts.map((f, i) => <div key={i}>{f}</div>)}
        {warn ? <div className="warn">Not fully automated ({warn.join(', ')}). The game may miss part of what it does.</div> : null}
      </div>
    </div>
  );
}

function PromptBar({ game, human, me, mode, ctx, actions, onPass, onEndTurn, spectator }) {
  const pending = human.pending;
  const step = STEP_NAMES[game.step] || game.step;
  const active = game.players[game.activePlayer];
  const myTurn = !spectator && game.activePlayer === me;
  let msg = null, acts = null;
  if (game.over) msg = <><div className="step">Game over</div><div className="txt">{game.resultText}</div></>;
  else if (!pending) {
    const pr = game.priority != null ? game.players[game.priority] : null;
    const top = game.stack[game.stack.length - 1];
    const who = top && (top.controller === me ? 'Your' : `${game.players[top.controller].name}’s`);
    const what = top && (top.kind === 'spell' ? game.name(top.card) : `${top.source ? game.name(top.source) : ''} ability`.trim());
    msg = <><div className="step">{myTurn ? 'Your turn' : active.name} · {step}</div><div className="txt thinking">{top ? <>{who} <b>{what}</b> is about to resolve</> : pr && pr.id !== me ? `${pr.name} is thinking` : 'Resolving'}</div></>;
  } else if (mode === 'priority') {
    const top = game.stack[game.stack.length - 1];
    let txt;
    if (top) txt = <>{top.controller === me ? 'Your' : game.players[top.controller].name + '’s'} <b>{top.kind === 'spell' ? game.name(top.card) : 'ability'}</b> is on the stack. Respond, or let it resolve.</>;
    else if (myTurn && game.isMainPhase()) txt = actions.some(a => a.type === 'land') ? 'Play a land, cast spells, or activate abilities.' : 'Cast spells or activate abilities.';
    else txt = myTurn ? 'You have priority.' : `${active.name}'s turn. You may respond.`;
    msg = <><div className="step">{myTurn ? 'Your turn' : active.name} · {step}</div><div className="txt">{txt}</div></>;
    const nextLabel = top ? 'Resolve' : myTurn ? (game.step === 'main1' ? 'Go to combat' : game.step === 'main2' ? 'End turn' : 'Continue') : 'Pass';
    acts = <>
      <button className="btn primary" onClick={onPass}>{nextLabel}</button>
      {myTurn && !top && game.step !== 'main2' ? <button className="btn" onClick={onEndTurn} title="Pass priority until your next decision">End turn</button> : null}
      {!myTurn && !top ? <button className="btn" onClick={onEndTurn} title="Stop for blocks and decisions only">Skip to my turn</button> : null}
    </>;
  } else if (mode === 'targets-inline') {
    const req = pending.req;
    msg = <><div className="step">Choose targets · {ctx.chosen.length}/{req.max}</div><div className="txt"><RulesText text={req.prompt} /></div></>;
    acts = <>
      {req.cancellable ? <button className="btn ghost" onClick={() => human.respond(null)}>Cancel</button> : null}
      <button className="btn primary" disabled={ctx.chosen.length < req.min} onClick={() => human.respond(ctx.chosen)}>{ctx.chosen.length ? 'Confirm' : req.min === 0 ? 'No target' : 'Confirm'}</button>
    </>;
  } else if (mode === 'attackers') {
    const n = ctx.attack.assigned.size;
    msg = <><div className="step">Declare attackers</div><div className="txt">Click creatures to attack{ctx.attack.defenders.length > 1 ? <> · target: <span className="attack-targets">{ctx.attack.defenders.map(d => <button key={d.ref} className={`btn sm tgt ${ctx.attack.current === d.ref ? 'on' : ''}`} aria-pressed={ctx.attack.current === d.ref} onClick={() => ctx.attack.setCurrent(d.ref)}>{ctx.attack.label(d.ref)}</button>)}</span></> : null}</div></>;
    acts = <>
      <button className="btn" onClick={ctx.attack.all}>All</button>
      {n ? <button className="btn ghost" onClick={ctx.attack.clear}>Clear</button> : null}
      <button className="btn primary" onClick={ctx.attack.confirm}>{n ? `Attack with ${n}` : 'No attack'}</button>
    </>;
  } else if (mode === 'blockers') {
    const n = ctx.block.assigned.size;
    msg = <><div className="step">Declare blockers</div><div className="txt">{ctx.block.picked ? `Now click the attacker ${game.name(game.cardById(ctx.block.picked))} should block.` : 'Click one of your creatures, then the attacker it blocks.'}</div></>;
    acts = <>
      {n ? <button className="btn ghost" onClick={ctx.block.clear}>Clear</button> : null}
      <button className="btn primary" onClick={ctx.block.confirm}>{n ? `Block with ${n}` : 'No blocks'}</button>
    </>;
  } else {
    msg = <><div className="step">{step}</div><div className="txt">Make your choice…</div></>;
  }
  return (
    <div className={`prompt ${!pending ? 'waiting' : ''}`} role="region" aria-label="Game prompt">
      <div className="msg">{msg}</div>
      <div className="acts">{acts}</div>
    </div>
  );
}

// what the guided tips say, depending on what the table is asking you right now
function mtgTips(game, me, req) {
  const p = game.players[me];
  const myTurn = game.activePlayer === me;
  const t = req && req.type;
  const top = game.stack[game.stack.length - 1];
  return [
    { id: 'mulligan', when: t === 'mulligan', text: 'Keep this hand or take a mulligan for a new one. A good opening hand has 3 or 4 lands and a few cheap spells.' },
    { id: 'attackers', when: t === 'attackers', text: 'Click your creatures to choose attackers, then pick who each one attacks and confirm. Creatures that arrived this turn can’t attack yet.' },
    { id: 'blockers', when: t === 'blockers', text: 'You’re being attacked. Click one of your untapped creatures, then the attacker it blocks. Confirm with no blocks to take the damage instead.' },
    { id: 'targets', when: t === 'targets', text: 'Choose a target: the cards and players you can pick glow on the table. Click one, then confirm.' },
    { id: 'respond', when: t === 'priority' && top && top.controller !== me, text: 'An opponent’s spell or ability is on the stack. Respond with an instant if you have one, or let it resolve.' },
    { id: 'main', when: t === 'priority' && myTurn && game.step === 'main1', text: 'Your main phase: cards you can play glow in your hand. Play one land each turn, then cast spells you have the mana for. The game taps your lands for you.' },
    { id: 'commander', when: t === 'priority' && myTurn && game.isMainPhase() && game.turnNumber >= 5 && p.command.length > 0, text: 'Your commander waits in the command zone on your side of the table. Cast it like any spell; every time it goes back there, it costs 2 more.' },
    { id: 'combat', when: t === 'priority' && myTurn && game.step === 'main1' && game.turnNumber >= 5, text: 'Ready to attack? Press Go to combat. Your creatures without summoning sickness can attack any opponent.' },
  ];
}

// ------------------------------------------------------------------ main view
export function GameView({ session, onExit, onRematch, onReplay, support, imagesOk }) {
  useStore(session.store);
  useSyncExternalStore(subscribeImages, imagesVersion);
  const { game, human } = session;
  // browser tests can reach the running game (window.__paExpose)
  if (typeof window !== 'undefined' && window.__paExpose) window.__paSession = session;
  const me = human.pid != null ? human.pid : 0;
  const self = session.spectator ? -1 : me; // the seat that is "you" (spectators have none)
  useGameSounds(game, { kind: 'mtg', me, watching: !!session.spectator });
  // a finished game goes into your record (with a replay)
  useEffect(() => { if (game.over && !session.record) session.record = recordGame(session, 'mtg'); }, [game.over]);
  const pending = human.pending;
  const req = pending ? pending.req : null;
  const [hover, setHover] = useState(null);
  const [menu, setMenu] = useState(null);
  const [zone, setZone] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [tokenFor, setTokenFor] = useState(null);
  const [chosen, setChosen] = useState([]);
  const [attackMap, setAttackMap] = useState(new Map());
  const [attackCur, setAttackCur] = useState(null);
  const [blockMap, setBlockMap] = useState(new Map());
  const [picked, setPicked] = useState(null);
  const [confirmExit, setConfirmExit] = useState(false);
  const [toast, setToast] = useState(null);
  const [inspect, setInspect] = useState(null);
  const boardRef = useRef(null);
  const recent = useRecentPlays(game, self);
  const images = imagesAvailable() && session.settings.images !== false;
  const touch = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(hover: none)').matches;
  const pid = pending ? pending.id : 0;
  useEffect(() => {
    setChosen([]); setAttackMap(new Map()); setBlockMap(new Map()); setPicked(null);
    if (req && req.type === 'attackers') setAttackCur(req.defenders.find(d => !d.card) ? req.defenders.find(d => !d.card).ref : req.defenders[0].ref);
  }, [pid]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 3200); return () => clearTimeout(t); }, [toast]);
  useEffect(() => {
    const k = e => {
      if (e.target && /INPUT|SELECT|TEXTAREA|BUTTON/.test(e.target.tagName)) return;
      if (document.querySelector('.overlay')) return;
      if (e.key === ' ' || e.key === 'Enter') {
        const b = document.querySelector('.prompt .acts .btn.primary:not([disabled])');
        if (b) { e.preventDefault(); b.click(); }
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const actions = useMemo(() => (req && req.type === 'priority' ? getActions(game, me) : []), [pid, session.store.get()]);
  const playable = useMemo(() => {
    const m = new Map();
    for (const a of actions) { if (!m.has(a.cardId)) m.set(a.cardId, []); m.get(a.cardId).push(a); }
    return m;
  }, [actions]);

  let mode = req ? req.type : 'wait';
  const inlineTargets = req && req.type === 'targets' && req.purpose !== 'proliferate' && req.cands.every(r => { const o = fromRef(game, r); return o && (o.isPlayer || (o.isCard && o.zone === 'battlefield')); });
  if (mode === 'targets' && inlineTargets) mode = 'targets-inline';

  const run = async (fn) => { try { await fn(); } catch (e) { console.error(e); setToast(e.message); } session.store.bump(); };
  // sandbox tools (move cards, change life, …): solo games only, and only when turned on in Settings
  const tools = !session.online && !session.spectator && !session.replay && !!session.settings.sandbox;
  const use = (op) => {
    if (!tools) return;
    if (session.recorder) session.recorder.ops.push(op);
    return run(() => applyOp(game, op));
  };

  const emotes = useEmotes(session);
  // card sleeves, by seat: everyone's online; yours (and in replays the recorded player's) otherwise
  const sleeves = useMemo(() => (session.online
    ? session.cfg.seats.map(s => (s.k === 'h' && s.c && s.sl ? { code: s.sl, av: s.a } : null))
    : game.players.map((p, i) => (i === human.pid ? { code: savedStyle('mtg', p.deckId).s, av: myAvatar() } : null))), [session]);
  const ctx = {
    game, me, support, emotes: emotes.bubbles,
    // friends' avatars, by seat (online games)
    avatars: session.online ? session.cfg.seats.map(s => (s.k === 'h' && s.c ? s.a : null)) : null,
    sleeves,
    onHover: setHover,
    openZone: (p, z) => setZone({ pid: p, zone: z }),
    chosen,
    toggleTarget: (ref) => setChosen(c => c.includes(ref) ? c.filter(x => x !== ref) : (c.length >= req.max ? (req.max === 1 ? [ref] : c) : [...c, ref])),
  };
  if (mode === 'priority') ctx.playable = playable;
  if (mode === 'targets-inline') ctx.targetable = new Set(req.cands);
  if (mode === 'attackers') {
    const defenders = req.defenders;
    const label = (ref) => { const d = defenders.find(x => x.ref === ref); if (!d) return '?'; return d.card ? game.name(game.cardById(d.card)).split(',')[0] : game.players[d.player].name.split(' ')[0]; };
    ctx.attack = {
      candidates: new Set(req.candidates), assigned: attackMap, defenders, current: attackCur, label,
      setCurrent: setAttackCur,
      all: () => { const m = new Map(); for (const id of req.candidates) m.set(id, attackCur); setAttackMap(m); },
      clear: () => setAttackMap(new Map()),
      confirm: () => human.respond([...attackMap].map(([attacker, defender]) => ({ attacker, defender }))),
    };
  }
  if (mode === 'blockers') {
    ctx.block = {
      candidates: new Set(req.candidates), attackers: new Set(req.attackers), assigned: blockMap, picked,
      clear: () => { setBlockMap(new Map()); setPicked(null); },
      confirm: () => human.respond([...blockMap].map(([blocker, attacker]) => ({ blocker, attacker }))),
    };
  }

  const respondAction = (a) => human.respond(a);

  ctx.onCardClick = (card, e) => {
    e && e.stopPropagation();
    setHover(card.id);
    if (mode === 'targets-inline') {
      const r = 'c' + card.id;
      if (ctx.targetable.has(r)) ctx.toggleTarget(r);
      else if (card.zone === 'battlefield' && ctx.targetable.has('p' + card.controller)) ctx.toggleTarget('p' + card.controller);
      return;
    }
    if (mode === 'attackers') {
      if (!ctx.attack.candidates.has(card.id)) return;
      setAttackMap(m => { const n = new Map(m); if (n.has(card.id)) n.delete(card.id); else n.set(card.id, attackCur); return n; });
      return;
    }
    if (mode === 'blockers') {
      if (ctx.block.assigned.has(card.id)) { setBlockMap(m => { const n = new Map(m); n.delete(card.id); return n; }); return; }
      if (ctx.block.candidates.has(card.id)) { setPicked(p => p === card.id ? null : card.id); return; }
      if (ctx.block.attackers.has(card.id) && picked) {
        const rules = blockRules(game, card);
        setBlockMap(m => { const n = new Map(m); n.set(picked, card.id); return n; });
        setPicked(null);
        const count = [...blockMap.values()].filter(x => x === card.id).length + 1;
        if (count < rules.min) setToast(`${game.name(card)} needs at least ${rules.min} blockers.`);
      }
      return;
    }
    if (mode === 'priority') {
      const acts = playable.get(card.id) || [];
      const isMine = (card.zone === 'battlefield' ? card.controller : card.owner) === me;
      const manaAbils = card.zone === 'battlefield' && card.controller === me ? manaSourcesFor(game, me).filter(s => s.card === card) : [];
      if (acts.length === 1 && (acts[0].type === 'land' || acts[0].type === 'cast') && !manaAbils.length) { respondAction(acts[0]); return; }
      const items = [];
      for (const a of acts) items.push({ label: a.type === 'land' ? a.label : a.type === 'cast' ? a.label : a.label, primary: true, run: () => respondAction(a) });
      for (const s of manaAbils) {
        const colors = [...new Set(s.units.flat())];
        // Treasures tap and sacrifice, Gold and Eldrazi Spawn only sacrifice
        const cost = parseCost(s.abil.parsed.p.Cost);
        const sac = cost.parts.some(pt => pt.type === 'Sac');
        const verb = cost.tap && sac ? 'Tap and sacrifice' : sac ? 'Sacrifice' : 'Tap';
        if (s.units.length === 1 && colors.length > 1) for (const c of colors) items.push({ label: `${verb} for {${c}}`, run: () => respondAction({ type: 'mana', cardId: card.id, abilityKey: s.abil.key, color: c }) });
        else items.push({ label: `${verb} for ${s.units.map(u => `{${u[0]}}`).join('')}`, run: () => respondAction({ type: 'mana', cardId: card.id, abilityKey: s.abil.key }) });
      }
      // mana that can only pay for some things (a Powerstone: artifact spells and abilities) is spent for you then
      if (card.zone === 'battlefield' && card.controller === me && !card.tapped && !manaAbils.length && manaAbilitiesOf(game, card).some(a => a.parsed.p.RestrictValid)) {
        items.push({ note: `${game.name(card)}'s mana can only pay for certain things, so it's spent for you when you pay for one of them.` });
      }
      if (items.length) { items.push({ label: 'Inspect card', run: () => setInspect(card.id) }); if (isMine && tools) items.push('-', ...cardMenuItems(game, card, me, use)); setMenu({ x: e ? e.clientX : 200, y: e ? e.clientY : 200, title: game.name(card), items }); return; }
    }
    if (touch) setInspect(card.id);
  };
  ctx.onCardMenu = (card, e) => {
    e.preventDefault(); e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, title: game.name(card), items: [{ label: 'Inspect card', run: () => setInspect(card.id) }, ...(tools ? cardMenuItems(game, card, me, use) : [])] });
  };
  ctx.onPlayerMenu = (p, e) => {
    if (!tools) return;
    setMenu({ x: e.clientX, y: e.clientY, title: game.players[p].name, items: playerMenuItems(p, use, setTokenFor) });
  };

  const onPass = () => human.respond({ type: 'pass' });
  const onEndTurn = () => {
    if (game.activePlayer === me) human.passUntilTurn = game.turnNumber;
    else human.passUntilMine = true;
    human.respond({ type: 'pass' });
  };

  const makeToken = (script, n) => use({ k: 'tok', p: tokenFor, s: script, n });

  const opps = game.players.filter(p => p.id !== me);
  const dialog = (() => {
    if (!req) return null;
    const props = { game, req, respond: v => human.respond(v), onHover: setHover };
    switch (req.type) {
      case 'cards': return <CardsDialog {...props} key={pid} />;
      case 'targets': return inlineTargets ? null : <TargetsDialog {...props} key={pid} />;
      case 'option': return <OptionDialog {...props} key={pid} />;
      case 'modes': return <ModesDialog {...props} key={pid} />;
      case 'confirm': return <ConfirmDialog {...props} key={pid} />;
      case 'number': return <NumberDialog {...props} key={pid} />;
      case 'color': return <ColorDialog {...props} key={pid} />;
      case 'player': return <PlayerDialog {...props} key={pid} />;
      case 'mulligan': return <MulliganDialog {...props} key={pid} />;
      default: return null;
    }
  })();

  const resultMine = game.over && (game.winner === self ? 'You win!' : game.winner != null ? `${game.players[game.winner].name} wins.` : (game.resultText || 'Game over'));

  return (
    <div className="app table">
      <header className={`topbar ${session.online ? 'online' : ''}`}>
        <span className="brand">Stigz’s<span className="brand-rest"> TCG Arena</span></span>
        <span className="turninfo">Turn <b>{game.turnNumber}</b> · <b>{game.players[game.activePlayer].name}</b></span>
        <PhaseTracker game={game} />
        <RoomStatus session={session} />
        {session.replay ? <ReplayBar ctl={session.replay} /> : null}
        <span className="spacer" />
        <EmoteButton emotes={emotes} />
        <SizeButton />
        <SoundToggle session={session} />
        <button className="btn sm icon" onClick={() => setShowHelp(true)} title="How to play" aria-label="How to play"><svg viewBox="0 0 24 24" aria-hidden="true"><path fillRule="evenodd" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm-1 11.5h2V18h-2zM12 6a3.5 3.5 0 0 1 1.7 6.6c-.5.3-.7.6-.7 1V14h-2v-.6c0-1.1.6-2 1.6-2.6A1.5 1.5 0 1 0 10.5 9.5h-2A3.5 3.5 0 0 1 12 6z" /></svg></button>
        <button className="btn sm icon" onClick={() => setShowSettings(true)} title="Settings" aria-label="Settings"><svg viewBox="0 0 24 24" aria-hidden="true"><path fillRule="evenodd" d="M10.3 2h3.4l.5 2.6c.6.2 1.2.5 1.7.9l2.5-.9 1.7 2.9-2 1.7a7 7 0 0 1 0 1.9l2 1.7-1.7 2.9-2.5-.9c-.5.4-1.1.7-1.7.9l-.5 2.6h-3.4l-.5-2.6c-.6-.2-1.2-.5-1.7-.9l-2.5.9-1.7-2.9 2-1.7a7 7 0 0 1 0-1.9l-2-1.7 1.7-2.9 2.5.9c.5-.4 1.1-.7 1.7-.9zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z" transform="translate(0 1)" /></svg></button>
        <button className="btn sm danger" onClick={() => game.over || session.spectator || session.replay ? onExit() : setConfirmExit(true)}>{session.replay ? 'Close replay' : game.over ? (session.online ? 'Back to room' : 'New game') : session.spectator ? 'Stop watching' : 'Leave game'}</button>
      </header>
      <WatcherEmotes list={emotes.watchers} />
      {!session.replay && !session.spectator ? <Coach kind="mtg" tips={mtgTips(game, me, req)} /> : null}
      <div className="game">
        <main className={`board opp${opps.length} ${images ? 'with-images' : ''}`} ref={boardRef} onClick={() => setPicked(null)}>
          <div className="opponents">
            {opps.map(p => <Mat key={p.id} game={game} pid={p.id} ctx={ctx} side="top" compact={opps.length > 1} />)}
          </div>
          <div className="center">
            <div className="centerplay">
              <StackView game={game} ctx={ctx} me={me} />
              <RecentPlays game={game} items={recent} ctx={ctx} />
            </div>
            <PromptBar game={game} human={human} me={me} mode={mode} ctx={ctx} actions={actions} onPass={onPass} onEndTurn={onEndTurn} spectator={session.spectator} />
          </div>
          <Mat game={game} pid={me} ctx={ctx} side="bottom" />
          {session.spectator ? <div className="hand watching"><span className="empty">You're watching. Hands stay hidden.</span></div> : <Hand game={game} pid={me} ctx={ctx} />}
          <ArrowLayer game={game} ctx={ctx} boardRef={boardRef} />
          <TurnBanner game={game} me={self} />
        </main>
        <aside className="rail">
          <section className="preview-sec"><Preview game={game} cardId={hover} support={support} images={images} me={me} /></section>
          <section className="log-sec"><h3>Game log</h3><LogPanel game={game} me={me} onHover={setHover} /></section>
        </aside>
      </div>
      {dialog}
      {menu ? <Menu menu={menu} onClose={() => setMenu(null)} /> : null}
      {zone ? <ZoneDialog game={game} pid={zone.pid} me={me} zone={zone.zone} onClose={() => setZone(null)} onHover={setHover} onMenu={(e, c) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, title: game.name(c), items: [{ label: 'Inspect card', run: () => setInspect(c.id) }, ...(tools ? cardMenuItems(game, c, me, use) : [])] }); }} /> : null}
      {showHelp ? <HelpDialog onClose={() => setShowHelp(false)} /> : null}
      {showSettings ? <SettingsDialog settings={session.settings} onChange={s => { session.setSettings(s); session.store.bump(); }} onClose={() => setShowSettings(false)} /> : null}
      {tokenFor != null ? <TokenDialog game={game} onMake={makeToken} onClose={() => setTokenFor(null)} /> : null}
      {confirmExit ? (
        <Modal narrow label="Leave game" onClose={() => setConfirmExit(false)}>
          <h2>Leave this game?</h2>
          {!session.online ? <div className="sub">The current game will end and you'll return to deck selection.</div>
            : session.online.net.isHost ? <div className="sub">You're the host: leaving ends the game for everyone and returns the room to seating.</div>
            : <div className="sub">The game goes on without you. The host can let the AI take your seat, and you can rejoin from the room with the same browser.</div>}
          <div className="dlg-actions">
            <button className="btn" onClick={() => setConfirmExit(false)}>Keep playing</button>
            {session.online && !session.online.net.isHost && human.pending && human.pending.req.type === 'priority' ? <button className="btn" onClick={() => { human.respond({ type: 'concede' }); setTimeout(onExit, 600); }}>Concede and leave</button> : null}
            <button className="btn primary" onClick={onExit}>{session.online && session.online.net.isHost ? 'End game' : 'Leave game'}</button>
          </div>
        </Modal>
      ) : null}
      {game.over && !session.dismissedResult ? (
        <Modal narrow label="Game over" onClose={() => { session.dismissedResult = true; session.store.bump(); }}>
          <h2>{resultMine}</h2>
          <div className="sub">{game.turnNumber} turns played</div>
          <ol className="standings">
            {[...game.players].sort((a, b) => (a.lost ? 1 : 0) - (b.lost ? 1 : 0) || (b.lostOrder || 0) - (a.lostOrder || 0)).map((p, i) => (
              <li key={p.id} className={p.lost ? 'out' : 'won'}>
                <span className="place">{i + 1}</span>
                <span className="who"><b>{p.name}</b><small>{p.deckName}</small></span>
                <span className="why">{p.lost ? `Out on turn ${p.lostTurn}: ${p.lossReason}` : game.winner === p.id ? `Winner at ${p.life} life` : `${p.life} life`}</span>
              </li>
            ))}
          </ol>
          <div className="dlg-actions">
            <button className="btn" onClick={() => { session.dismissedResult = true; session.store.bump(); }}>View board</button>
            {session.replay ? <>
              <button className="btn" onClick={() => onReplay && onReplay(session.replayId)}>Watch again</button>
              <button className="btn primary" onClick={onExit}>Close replay</button>
            </> : <>
              {session.record && session.record.replay && onReplay ? <button className="btn" onClick={() => onReplay(session.record.id)}>Watch replay</button> : null}
              {session.online ? <button className="btn primary" onClick={onExit}>Back to room</button> : <>
                <button className="btn" onClick={onExit}>New game</button>
                <button className="btn primary" onClick={onRematch}>Rematch</button>
              </>}
            </>}
          </div>
        </Modal>
      ) : null}
      {inspect != null ? (
        <Modal narrow label="Card" onClose={() => setInspect(null)}>
          <Preview game={game} cardId={inspect} support={support} images={images} me={me} />
          <div className="dlg-actions"><button className="btn primary" onClick={() => setInspect(null)}>Close</button></div>
        </Modal>
      ) : null}
      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </div>
  );
}
