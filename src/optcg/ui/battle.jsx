// The One Piece battle screen: two sides laid out like the playmat (Characters and Stage nearest the middle, the
// Leader and the DON!! cost area behind them, Life beside the player's card, deck and trash on the right), the bar
// across the middle (what to do now, and the fight in progress), your hand, and a side panel with the card you point
// at and the battle log. Cards glide between zones (ui/motion.js); attacks, Counters, Triggers and K.O.s are animated.
import { opImage, subscribeOp, opImagesVersion, preloadOpCards } from './images.js';
import { ColorDot, COLOR_HEX } from './colors.jsx';
import { EffectText } from './lobby.jsx';
import { Modal, SoundToggle, SizeButton, Confetti, Menu } from '../../ui/dialogs.jsx';
import { secondPerson } from '../../ui/table.jsx';
import { RoomStatus } from '../../ui/online.jsx';
import { useGameSounds } from '../../ui/sound.js';
import { recordGame } from '../../ui/records.js';
import { ReplayBar } from '../../ui/replaybar.jsx';
import { useEmotes, EmoteButton, EmoteBubble, WatcherEmotes } from '../../ui/emotes.jsx';
import { Coach } from '../../ui/coach.jsx';
import { AnimalAvatar, myAvatar } from '../../ui/avatar.jsx';
import { Sleeve, savedStyle } from '../../ui/deckstyle.jsx';
import { createFlights, runFlights, shake, strike, motionOn } from '../../ui/motion.js';
import { uiScale } from '../../ui/common.js';

const { useState, useEffect, useLayoutEffect, useRef, useMemo, useSyncExternalStore } = React;
// the log and prompts in the second person ("You add a Life card to your hand", not "... to their hand")
const youText = t => secondPerson(String(t || '')).replace(/DON!!/g, 'DON\u2060\u2060').replace(/(^|[.!?]\s+)(You\b[^.!?]*)/g, (m, pre, sent) => pre + sent.replace(/\btheir\b/g, 'your').replace(/\bthemselves\b/g, 'yourself').replace(/\b(and|then) (activate|draw|add|play|place|rest|give|return|reveal|look|put|take|set|trash|shuffle|attack|use|turn|choose)s\b/g, '$1 $2').replace(/\b(and|then) (trash|push)es\b/g, '$1 $2')).replace(/([a-z,] )Your\b/g, '$1your').replace(/DON\u2060\u2060/g, 'DON!!');
// an [Activate: Main] action's button: short, with the effect's words as the tooltip
const effectWords = a => String(a.label || '').replace(/^[^:]*?: (?=\[)/, '');
const shortWords = (t, n = 46) => { const w = t.replace(/\[(Activate: Main|Once Per Turn)\]\s*/g, '').replace(/[{}]/g, '').trim(); return w.length > n ? w.slice(0, n - 1).trimEnd() + '…' : w; };
// option buttons fit in the bar only when they're few and short; otherwise they get a list of their own
const barOptions = req => req.options.length <= 4 && req.options.every(o => String(o.label).length <= 34);

// ---------------------------------------------------------------- cards
export function OpCard({ card, def, cls = '', onClick, onEnter, onLeave, fly, title }) {
  const d = def || (card && card.def);
  const img = d && opImage(d.id);
  return (
    <div className={`op-card ${img ? '' : 'drawn'} ${cls}`} data-fly={fly} onClick={onClick} onMouseEnter={onEnter} onMouseLeave={onLeave} title={title}
      role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e); } }) : undefined}
      style={d && !img ? { background: `linear-gradient(160deg, #f6ead0, ${COLOR_HEX[(d.colors || [])[0]] || '#d8c49a'})` } : undefined}>
      {img ? <img src={img} alt={d.name} draggable="false" /> : d ? <><b>{d.name}</b><span>{d.cat === 'L' ? `Leader · ${d.life} Life` : d.cost != null ? `Cost ${d.cost}` : ''}</span>{d.power != null ? <span>{d.power} power</span> : null}</> : null}
    </div>
  );
}
const CardBack = ({ cls = '', sleeve, fly }) => (sleeve && sleeve.code
  ? <div className={`op-card back sleeved ${cls}`} data-fly={fly}><Sleeve code={sleeve.code} avatar={sleeve.av} /></div>
  : <div className={`op-card back ${cls}`} data-fly={fly}><span className="op-mark" /></div>);

// where every card is, for the card flights: "1:hand", "1:trash", "1:field" (Leader, Characters, Stage)
function cardZones(game) {
  const z = new Map();
  for (const p of game.players) {
    for (const zone of ['hand', 'deck', 'trash', 'life']) for (const c of p[zone] || []) z.set(String(c.uid), `${p.id}:${zone}`);
    for (const c of [p.leader, ...(p.characters || []), p.stage].filter(Boolean)) z.set(String(c.uid), `${p.id}:field`);
  }
  return z;
}

// ---------------------------------------------------------------- effects: hits, K.O.s, banners
function useFx(game, me, watching) {
  const [, force] = useState(0);
  const st = useRef({ last: 0, hits: new Map(), lunge: null, banner: null, timers: [], shake: null, coin: null });
  const s = st.current;
  const later = (ms, f) => { const t = setTimeout(() => { f(); force(x => x + 1); }, ms); s.timers.push(t); };
  useEffect(() => () => s.timers.forEach(clearTimeout), []);
  const fresh = (game.events || []).filter(e => e.id > s.last);
  if (fresh.length) {
    s.last = fresh[fresh.length - 1].id;
    const name = pid => (pid === me && !watching ? 'Your' : `${game.players[pid].name}'s`);
    for (const e of fresh) {
      if (e.kind === 'attack') { s.lunge = { card: e.card, key: e.id }; later(480, () => { if (s.lunge && s.lunge.key === e.id) s.lunge = null; }); }
      if (e.kind === 'damage') { s.shake = { key: e.id, strength: e.n >= 2 ? 1.6 : 1 }; s.banner = { text: e.pid === me && !watching ? `You take ${e.n > 1 ? `${e.n} damage` : 'a hit'}!` : `${game.players[e.pid].name} takes ${e.n > 1 ? `${e.n} damage` : 'a hit'}!`, key: e.id, kind: 'hit' }; later(1300, () => { if (s.banner && s.banner.key === e.id) s.banner = null; }); }
      if (e.kind === 'ko') { s.hits.set(e.card, e.id); s.shake = { key: e.id, strength: 1.2 }; later(900, () => s.hits.delete(e.card)); }
      if (e.kind === 'trigger') { const c = game.cardByUid && game.cardByUid(e.card); s.banner = { text: `Trigger! ${c ? c.def.name : ''}`, key: e.id, kind: 'trigger' }; later(1500, () => { if (s.banner && s.banner.key === e.id) s.banner = null; }); }
      if (e.kind === 'turn') { s.banner = { text: e.pid === me && !watching ? 'Your turn' : `${game.players[e.pid].name}'s turn`, key: e.id, kind: 'turn' }; later(1200, () => { if (s.banner && s.banner.key === e.id) s.banner = null; }); }
      if (e.kind === 'redirect') { const c = game.cardByUid && game.cardByUid(e.card); s.banner = { text: `The attack is redirected${c ? ` to ${c.def.name}` : ''}!`, key: e.id, kind: 'trigger' }; later(1400, () => { if (s.banner && s.banner.key === e.id) s.banner = null; }); }
      if (e.kind === 'coin' || e.kind === 'first') { s.coin = { text: e.kind === 'first' ? `${name(e.pid)} turn first` : e.heads ? 'Heads' : 'Tails', key: e.id }; later(1600, () => { if (s.coin && s.coin.key === e.id) s.coin = null; }); }
    }
    // cards the other player reveals (and their Life [Trigger]s) are shown for a moment
    const shown = [...new Set(fresh.filter(e => (e.kind === 'reveal' || e.kind === 'trigger') && e.card != null && (e.pid !== me || watching)).map(e => e.card))].slice(0, 6);
    if (shown.length) { const key = s.last; s.reveal = { cards: shown, key }; later(1800, () => { if (s.reveal && s.reveal.key === key) s.reveal = null; }); }
  }
  return s;
}

// ---------------------------------------------------------------- one card in play
function InPlay({ game, card, lead, state = '', fx, onClick, onHover, me }) {
  const pw = game.power ? game.power(card) : card.def.power;
  const base = card.def.power;
  const kws = game.keywords ? [...game.keywords(card)] : [];
  const lunge = fx.lunge && fx.lunge.card === card.uid ? (game.ownerOf ? game.ownerOf(card.uid) : card.owner) === me ? 'lunge-up' : 'lunge-down' : '';
  const cls = ['op-slot', lead ? 'lead' : '', card.rested ? 'rested' : '', state, lunge, fx.hits.has(card.uid) ? 'hit' : ''].filter(Boolean).join(' ');
  const tag = k => ({ Blocker: 'blocker', Rush: 'rush', 'Double Attack': 'double', Banish: 'banish' }[k]);
  return (
    <div className={cls} data-fly={card.uid} data-ref={'c' + card.uid}>
      <OpCard card={card} onClick={onClick} onEnter={() => onHover(card.uid)} onLeave={() => onHover(null)} title={`${card.def.name} · ${pw} power${card.don ? ` · ${card.don} DON!!` : ''}${card.rested ? ' · rested' : ''}`} />
      {pw != null ? <span key={pw} className={`op-pow ${pw > base ? 'up' : pw < base ? 'down' : ''}`}>{pw}</span> : null}
      {card.don ? <span key={'d' + card.don} className="op-dons" title={`${card.don} DON!! given`}>+{card.don}</span> : null}
      {kws.some(tag) ? <span className="op-tags">{kws.filter(tag).map(k => <span key={k} className={tag(k)}>{k}</span>)}</span> : null}
    </div>
  );
}

function EmptySlot({ label }) { return <div className="op-slot empty"><div className="op-card slot"><span className="slotname">{label}</span></div></div>; }

function DonArea({ p, pick, onPick }) {
  const act = p.donActive || 0, rest = p.donRested || 0;
  return (
    <div className={`op-cost ${act + rest * 1.5 > 6 ? 'tight' : ''}`} data-pile={`${p.id}:don`} title={`${act} active, ${rest} rested DON!! in the cost area; ${p.donDeck} in the DON!! deck`}>
      <span className="label">DON!!</span>
      {Array.from({ length: act }, (_, i) => <span key={'a' + i} className={`op-don ${pick ? 'pick' : ''}`} onClick={pick ? onPick : undefined} role={pick ? 'button' : undefined} aria-label={pick ? 'Give a DON!! card' : undefined} />)}
      {Array.from({ length: rest }, (_, i) => <span key={'r' + i} className="op-don rested" />)}
      {!act && !rest ? <span className="note">none yet</span> : <span className="cnt"><b>{act}</b> active{rest ? <><br /><b>{rest}</b> rested</> : null}</span>}
    </div>
  );
}

function Life({ p, sleeve, setup }) {
  const n = p.life.length;
  return (
    <div className={`op-life ${n <= 1 && !setup ? 'low' : ''}`} data-pile={`${p.id}:life`} title={setup && !n ? 'Life cards are dealt once both hands are kept' : `${n} Life card${n === 1 ? '' : 's'} left`}>
      <div className="stack" style={{ '--n': Math.max(n, 1) }}>{p.life.map((c, i) => <div key={c.uid} style={{ '--i': i, zIndex: 10 - i }}>{c.faceUp ? <OpCard card={c} fly={c.uid} /> : <CardBack sleeve={sleeve} fly={c.uid} />}</div>)}</div>
      <div className="cap"><b>{setup && !n ? '–' : n}</b>Life</div>
    </div>
  );
}

function Piles({ p, onOpen, sleeve, hand }) {
  const top = p.trash[p.trash.length - 1];
  return (
    <div className="op-piles">
      {hand ? <div className="pile hand" data-pile={`${p.id}:hand`} title={`${p.hand.length} cards in hand`}><span className="op-card back" style={{ width: 24 }}><span className="op-mark" /></span><span><b>{p.hand.length}</b> in hand</span></div> : null}
      <div className="pile" data-pile={`${p.id}:deck`} title={`Deck: ${p.deck.length} cards`}><CardBack sleeve={sleeve} /><span><b>{p.deck.length}</b> Deck</span></div>
      <button className="pile" data-pile={`${p.id}:trash`} onClick={() => onOpen('trash')} title="See the trash">{top ? <OpCard card={top} /> : <span className="op-card slot" />}<span><b>{p.trash.length}</b> Trash</span></button>
      <div className="pile" title={`${p.donDeck} DON!! cards left in the DON!! deck`}><span className="op-don" style={{ '--op-don': '24px' }} /><span><b>{p.donDeck}</b> DON!! deck</span></div>
    </div>
  );
}

// ---------------------------------------------------------------- dialogs
const ZONE_NAME = { hand: 'hand', trash: 'trash', deck: 'deck', life: 'Life cards', limbo: 'card', leader: 'Leader', characters: 'Characters', stage: 'Stage' };
function CardsDialog({ game, req, respond, onHover, me, sleeves }) {
  const hidden = req.from === 'opp-hand';
  const [sel, setSel] = useState([]);
  const opts = new Set(req.options);
  const shown = (req.shown || req.options).map(id => game.cardByUid(id)).filter(Boolean);
  const toggle = id => setSel(s => s.includes(id) ? s.filter(x => x !== id) : s.length >= req.max ? (req.max === 1 ? [id] : s) : [...s, id]);
  const ok = sel.length >= req.min && sel.length <= req.max;
  // the title names where the cards are (a few effects pick from the hand and the trash at once)
  const where = [...new Set(shown.map(c => `${c.owner === me ? 'Your' : `${game.players[c.owner].name}'s`} ${ZONE_NAME[c.zone] || c.zone}`))];
  const title = where.length === 1 ? where[0] : where.length === 2 ? `${where[0]} or ${where[1].replace(/^Your /, '')}` : 'Choose';
  return (
    <Modal label={req.prompt}>
      <h2>{title}</h2>
      <p className="sub">{youText(req.prompt)}{req.max > 1 ? ` (${req.min === req.max ? req.min : `${req.min}–${req.max}`})` : ''}</p>
      {!req.options.length ? <p className="sub">Nothing fits.</p> : null}
      <div className="op-picks">
        {shown.map(c => {
          const can = opts.has(c.uid), on = sel.includes(c.uid);
          return (
            <div key={c.uid} className={`op-pick ${can ? '' : 'off'} ${on ? 'on' : ''}`}>
              {hidden
                ? <div className="op-pickback" onClick={can ? () => toggle(c.uid) : undefined} role="button" tabIndex={0} aria-label="A card from their hand" onKeyDown={e => { if (can && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(c.uid); } }}><CardBack sleeve={sleeves && sleeves[c.owner]} /></div>
                : <OpCard card={c} onClick={can ? () => toggle(c.uid) : undefined} onEnter={() => onHover(c.uid)} onLeave={() => onHover(null)} />}
              {on ? <span className="tick">{req.max > 1 ? sel.indexOf(c.uid) + 1 : '✓'}</span> : null}
            </div>
          );
        })}
      </div>
      <div className="row">
        <button className="btn primary" disabled={!ok} onClick={() => respond(sel)}>{sel.length ? 'Confirm' : req.min === 0 ? 'Choose none' : 'Confirm'}</button>
        {req.min === 0 && sel.length ? <button className="btn" onClick={() => setSel([])}>Clear</button> : null}
      </div>
    </Modal>
  );
}

// put cards in order: click them in the order you want them (the first one goes on top)
function OrderDialog({ game, req, respond, onHover }) {
  const [seq, setSeq] = useState([]);
  const cards = req.options.map(id => game.cardByUid(id)).filter(Boolean);
  const toggle = id => setSeq(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  const done = seq.length === cards.length;
  const how = req.hint === 'order-bottom' ? 'Card 1 sits highest of them, at the bottom of your deck.' : req.hint === 'order-life' ? 'Card 1 becomes your top Life card.' : 'Card 1 becomes the top card of your deck.';
  return (
    <Modal label={req.prompt}>
      <h2>Put them in order</h2>
      <p className="sub">{youText(req.prompt).replace(/\s*\(first = [^)]*\)/, '')}.</p>
      <p className="sub">Click the cards in the order you want. {how}</p>
      <div className="op-picks">
        {cards.map(c => {
          const n = seq.indexOf(c.uid);
          return (
            <div key={c.uid} className={`op-pick ${n >= 0 ? 'on' : ''}`}>
              <OpCard card={c} onClick={() => toggle(c.uid)} onEnter={() => onHover(c.uid)} onLeave={() => onHover(null)} />
              {n >= 0 ? <span className="tick">{n + 1}</span> : null}
            </div>
          );
        })}
      </div>
      <div className="row">
        <button className="btn primary" onClick={() => respond(done ? seq : [...seq, ...req.options.filter(id => !seq.includes(id))])}>{done ? 'Confirm' : seq.length ? 'Confirm (rest in this order)' : 'Keep this order'}</button>
        {seq.length ? <button className="btn" onClick={() => setSeq([])}>Clear</button> : null}
      </div>
    </Modal>
  );
}

function ZoneDialog({ game, p, zone, onClose, onHover }) {
  const cards = [...(p[zone] || [])].reverse();
  return (
    <Modal label={zone} onClose={onClose}>
      <h2>{p.name === 'You' ? 'Your' : `${p.name}'s`} {zone}</h2>
      <p className="sub">{cards.length} card{cards.length === 1 ? '' : 's'}, newest first.</p>
      <div className="op-picks">{cards.map(c => <div key={c.uid} className="op-pick"><OpCard card={c} onEnter={() => onHover(c.uid)} onLeave={() => onHover(null)} /></div>)}</div>
      <div className="row"><button className="btn" onClick={onClose}>Close</button></div>
    </Modal>
  );
}

// ---------------------------------------------------------------- side panel
function Preview({ game, uid, me }) {
  const c = uid != null ? game.cardByUid(uid) : null;
  if (!c) return <div className="preview-empty"><span className="ghostcard" aria-hidden="true" /><span>Point at any card to read it here.</span></div>;
  const d = c.def;
  const img = opImage(d.id);
  const inPlay = c.rested !== undefined && game.players.some(p => p.leader === c || p.characters.includes(c) || p.stage === c);
  const pw = inPlay && game.power ? game.power(c) : d.power;
  return (
    <div className="op-preview">
      {img ? <img src={img} alt={d.name} /> : <OpCard card={c} />}
      <div className="facts">
        <p className="nm">{d.name} <ColorDot colors={d.colors} size={13} /></p>
        <p>{d.cat === 'L' ? `Leader · ${d.life} Life` : d.cat === 'C' ? `Character · Cost ${d.cost}` : d.cat === 'E' ? `Event · Cost ${d.cost}` : `Stage · Cost ${d.cost}`}{d.power != null ? ` · ${d.power} power` : ''}{d.counter ? ` · Counter +${d.counter}` : ''}</p>
        {d.traits && d.traits.length ? <p>{d.traits.join(' / ')}{d.attr && d.attr.length ? ` · ${d.attr.join(' / ')}` : ''}</p> : null}
        {d.text ? <p><EffectText text={d.text} /></p> : null}
        {d.trigger ? <p><span className="kw trigger">Trigger</span> {d.trigger}</p> : null}
        {inPlay ? <p className="state">{pw} power now{c.don ? ` · ${c.don} DON!! given` : ''}{c.rested ? ' · rested' : ''}{(game.modsOf ? game.modsOf(c) : []).filter(m => !/^DON!!/.test(m.text)).map(m => ` · ${m.text}`).join('')}</p> : null}
      </div>
    </div>
  );
}

function Log({ game, me }) {
  const ref = useRef(null);
  useEffect(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }, [game.logs.length]);
  return (
    <div className="log op-log" ref={ref}>
      {game.logs.slice(-220).map((l, i) => { const t = youText(l.text); return <div key={i} className={`e ${l.type || ''} ${me != null && l.pid === me ? 'mine' : ''}`}>{l.type === 'turn' ? <b>{t}</b> : t}</div>; })}
    </div>
  );
}

// ---------------------------------------------------------------- the battle
// session.me is your seat (the bottom of the table); watchers of a friends' battle see the host's seat at the bottom
export function OpBattle({ session, host, onExit, onRematch, onLobby, onReplay }) {
  const { game, human, store } = session;
  useSyncExternalStore(store.subscribe, store.get);
  useSyncExternalStore(subscribeOp, opImagesVersion);
  const me = session.me || 0, opp = 1 - me;
  const watching = !!session.spectator, online = !!session.online;
  const P = game.players[me], O = game.players[opp];
  const pend = human.pending;
  const req = pend ? pend.req : null;
  const [hover, setHover] = useState(null);
  const [mode, setMode] = useState(null);       // { kind: 'attack', card } | { kind: 'don' }
  const [sel, setSel] = useState([]);           // choices on the board for a 'cards' question about cards in play
  const [zone, setZone] = useState(null);
  const [menu, setMenu] = useState(null);
  const [flash, setFlash] = useState(null);
  const [num, setNum] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const fx = useFx(game, me, watching);
  const boardRef = useRef(null);
  const donMode = useRef(false);                 // giving DON!! one by one: stays on until you stop or run out
  const [zoom, setZoom] = useState(null);       // a card shown big (touch screens have no pointing at cards)
  const touch = useMemo(() => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(hover: none)').matches, []);

  // cards glide between hand, field, trash and Life; a played Event is shown big before it goes to the trash
  const flights = useRef(null);
  if (!flights.current) flights.current = createFlights();
  useLayoutEffect(() => {
    const mine = watching ? null : me;
    runFlights(flights.current, boardRef.current, game, {
      zones: cardZones(game),
      isPublic: z => !(z.endsWith(':deck') || z.endsWith(':life') || (z.endsWith(':hand') && z !== `${mine}:hand`)),
      look: (id, face) => { const c = game.cardByUid(+id); return face && c ? { img: opImage(c.def.id), name: c.def.name, cls: 'op' } : { back: true, cls: 'op' }; },
      kindOf: (id, from, to) => {
        if (!to || !from) return 'move';
        if (from.endsWith(':field') && to.endsWith(':trash')) return 'die';
        const c = game.cardByUid(+id);
        if (from.endsWith(':hand') && to.endsWith(':trash') && c && c.def.cat === 'E') return 'show';
        return 'move';
      },
      showAt: () => {
        const b = boardRef.current && boardRef.current.getBoundingClientRect();
        if (!b) return null;
        const w = Math.min(190 * uiScale(), b.height * 0.42 / 1.4), h = w * 1.4;
        return { left: b.left + b.width / 2 - w / 2, top: b.top + b.height / 2 - h / 2, width: w, height: h };
      },
    });
  });
  // this battle's pictures: the packs holding both decks (once the decks are on the table)
  const preloaded = useRef(false);
  useEffect(() => {
    if (preloaded.current) return;
    const ids = game.players.flatMap(p => [p.leader, ...p.deck, ...p.hand, ...p.life].filter(Boolean).map(c => c.id));
    if (ids.length) { preloaded.current = true; preloadOpCards(ids); }
  });
  useEffect(() => { if (fx.shake && motionOn()) shake(boardRef.current, fx.shake.strength); }, [fx.shake && fx.shake.key]);
  // the damage step: the attacker swings at its target
  const strikeKey = game.battle && game.battle.step === 'damage' ? `${game.battle.attacker}:${game.battle.target}:${game.turn}` : null;
  useLayoutEffect(() => {
    const root = boardRef.current;
    if (!strikeKey || !root || !game.battle) return;
    strike(root.querySelector(`[data-ref="c${game.battle.attacker}"]`), root.querySelector(`[data-ref="c${game.battle.blocker || game.battle.target}"]`));
  }, [strikeKey]);
  useGameSounds(game, { kind: 'op', me, watching });
  useEffect(() => { if (game.over && !session.record) session.record = recordGame(session, 'op'); }, [game.over]);
  const replay = session.replay;
  const emotes = useEmotes(session);
  const avatarOf = pid => (session.online && session.cfg.seats[pid] ? session.cfg.seats[pid].a : null);
  const sleeves = useMemo(() => game.players.map((p, pid) => (session.online
    ? (session.cfg.seats[pid] && session.cfg.seats[pid].sl ? { code: session.cfg.seats[pid].sl, av: session.cfg.seats[pid].a } : null)
    : pid === session.me ? { code: savedStyle('op', p.deckId).s, av: myAvatar() } : null)), [session]);
  useEffect(() => { setSel([]); setMenu(null); if (req && req.type === 'number') setNum(req.max); if (!req || req.type !== 'main') setMode(null); }, [pend && pend.id]);
  useEffect(() => { if (!flash) return; const t = setTimeout(() => setFlash(null), 2400); return () => clearTimeout(t); }, [flash]);
  useEffect(() => {
    const k = e => { if (e.key === 'Escape') { setMode(null); donMode.current = false; } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const respond = v => { setMenu(null); setSel([]); human.respond(v); };
  const actions = req && req.type === 'main' ? req.actions : [];
  const myTurn = game.current === me && !game.over && !watching;
  const fieldReq = req && req.type === 'cards' && req.from === 'field' ? req : null;
  const blockReq = req && req.type === 'blocker' ? req : null;
  const counterReq = req && req.type === 'counter' ? req : null;
  const donActs = actions.filter(a => a.t === 'don');
  // giving DON!!: stays on while there's DON!! to give
  const giving = (mode && mode.kind === 'don') || (donMode.current && donActs.length > 0);
  if (donMode.current && !donActs.length && req && req.type === 'main') donMode.current = false;
  const targets = new Set(fieldReq ? fieldReq.options : blockReq ? blockReq.options : mode && mode.kind === 'attack' ? actions.filter(a => a.t === 'attack' && a.card === mode.card).map(a => a.target) : giving ? donActs.map(a => a.target) : []);
  const attackers = new Set(actions.filter(a => a.t === 'attack').map(a => a.card));

  const stateOf = c => {
    if (req && req.type === 'confirm' && req.card === c.uid) return 'selected';
    if (game.battle && game.battle.attacker === c.uid) return 'attacking';
    if (game.battle && (game.battle.blocker || game.battle.target) === c.uid) return 'defending';
    if (targets.has(c.uid)) return sel.includes(c.uid) ? 'selected' : 'targetable';
    if (mode && mode.card === c.uid) return 'selected';
    if (myTurn && !mode && !giving && attackers.has(c.uid)) return 'can';
    return '';
  };

  // a card in play was clicked
  const onField = (c, e) => {
    if (fieldReq && targets.has(c.uid)) {
      if (fieldReq.max <= 1) return respond([c.uid]);
      return setSel(s => s.includes(c.uid) ? s.filter(x => x !== c.uid) : s.length < fieldReq.max ? [...s, c.uid] : s);
    }
    if (blockReq && targets.has(c.uid)) return respond(c.uid);
    if (mode && mode.kind === 'attack' && targets.has(c.uid)) { setMode(null); return respond(actions.find(a => a.t === 'attack' && a.card === mode.card && a.target === c.uid)); }
    if (giving && targets.has(c.uid)) { donMode.current = true; setMode(null); return respond(donActs.find(a => a.target === c.uid)); }
    setHover(c.uid);
    // your own card in your main phase: what it can do
    const mine = actions.filter(a => (a.t === 'attack' || a.t === 'activate') && a.card === c.uid);
    const don = donActs.find(a => a.target === c.uid);
    if (!mine.length && !don) { if (touch) setZoom(c.uid); return; }
    const items = [];
    if (mine.some(a => a.t === 'attack')) items.push({ label: 'Attack…', primary: true, run: () => { donMode.current = false; setMode({ kind: 'attack', card: c.uid }); } });
    const acts = mine.filter(x => x.t === 'activate');
    for (const a of acts) items.push({ label: acts.length === 1 ? 'Use its [Activate: Main]' : `Use: ${shortWords(effectWords(a))}`, title: effectWords(a), run: () => respond(a) });
    if (don) items.push({ label: `Give 1 DON!! (+1000 power)`, run: () => respond(don) });
    if (touch) items.push({ label: 'Look at the card', run: () => setZoom(c.uid) });
    const r = e && e.currentTarget ? e.currentTarget.getBoundingClientRect() : null;
    setMenu({ x: r ? r.right : 200, y: r ? r.top : 200, title: c.def.name, items });
  };

  // a card in your hand was clicked
  const onHand = (c, e) => {
    if (touch && !watching) {
      setHover(c.uid);
      const items = [];
      const co = counterReq && counterReq.options.find(x => x.card === c.uid);
      const a = actions.find(x => x.t === 'play' && x.card === c.uid);
      if (co) items.push({ label: co.kind === 'event' ? `Play it (${co.cost} DON!!)` : `Use as Counter (+${co.value})`, primary: true, run: () => respond(co) });
      if (a) items.push({ label: c.def.cat === 'E' ? 'Use this Event' : 'Play it', primary: true, run: () => { donMode.current = false; setMode(null); respond(a); } });
      items.push({ label: 'Look at the card', run: () => setZoom(c.uid) });
      const r = e && e.currentTarget ? e.currentTarget.getBoundingClientRect() : null;
      return setMenu({ x: r ? r.left : 100, y: r ? r.top - 120 : 300, title: c.def.name, items });
    }
    if (counterReq) {
      const o = counterReq.options.find(x => x.card === c.uid);
      if (o) return respond(o);
      return setFlash(c.def.counter ? 'That card can’t be used as a Counter right now.' : 'Only cards with a Counter value or [Counter] Events help in a battle.');
    }
    if (!actions.length) return;
    const a = actions.find(x => x.t === 'play' && x.card === c.uid);
    if (a) { donMode.current = false; setMode(null); return respond(a); }
    const d = c.def;
    const cost = game.cost ? game.cost(c) : d.cost;
    const why = d.cat === 'E' && !/\[Main\]/.test(d.text || '') ? 'This Event can only be used when its timing comes ([Counter] Events: when you’re attacked).'
      : cost > (P.donActive || 0) ? `It costs ${cost} DON!! and you have ${P.donActive || 0} active.`
      : "You can't play that right now.";
    setFlash(why);
  };

  // the bar between the two sides: what to do now
  const result = game.over ? (game.winner == null ? 'Draw' : game.winner === me && !watching ? 'You win!' : `${game.players[game.winner].name} wins`) : null;
  const cardName = uid => { const c = uid != null && game.cardByUid(uid); return c ? c.def.name : ''; };
  let bar;
  if (game.over) {
    bar = <div className="msg"><div className="step">Game over</div><div className="txt">{result}{result === 'You win!' ? ' ' : '. '}{youText(game.result || '')}</div></div>;
  } else if (req && req.type === 'confirm' && !(req.cards && req.cards.length)) {
    bar = <><div className="msg"><div className="txt">{youText(req.prompt)}</div></div><div className="acts"><button className="btn primary" onClick={() => respond(true)}>Yes</button><button className="btn" onClick={() => respond(false)}>No</button></div></>;
  } else if (req && req.type === 'option' && barOptions(req)) {
    bar = <><div className="msg"><div className="txt">{youText(req.prompt)}</div></div><div className="acts">{req.options.map(o => <button key={String(o.value)} className="btn" onClick={() => respond(o.value)}>{o.label}</button>)}</div></>;
  } else if (req && req.type === 'number') {
    bar = <><div className="msg"><div className="txt">{youText(req.prompt)}</div></div><div className="acts op-num"><button className="btn" onClick={() => setNum(n => Math.max(req.min, n - 1))} aria-label="Less">−</button><b>{num}</b><button className="btn" onClick={() => setNum(n => Math.min(req.max, n + 1))} aria-label="More">+</button><button className="btn primary" onClick={() => respond(num)}>OK</button></div></>;
  } else if (fieldReq) {
    bar = <><div className="msg"><div className="step">Choose</div><div className="txt">{youText(fieldReq.prompt)}</div></div>
      <div className="acts">{fieldReq.max > 1 || fieldReq.min === 0 ? <button className="btn primary" disabled={sel.length < fieldReq.min} onClick={() => respond(sel)}>{sel.length ? `Done (${sel.length})` : fieldReq.min === 0 ? 'Choose none' : 'Done'}</button> : null}</div></>;
  } else if (blockReq) {
    bar = <><div className="msg"><div className="step">Block?</div><div className="txt">{cardName(blockReq.attacker)} attacks your {cardName(blockReq.target)}. Click a [Blocker] to take the hit instead.</div></div>
      <div className="acts"><button className="btn primary" onClick={() => respond(null)}>No block</button></div></>;
  } else if (counterReq) {
    bar = <><div className="msg"><div className="step">Counter</div><div className="txt">Click cards in your hand to add their Counter power to {cardName(game.battle ? game.battle.blocker || game.battle.target : counterReq.target)}, or play a [Counter] Event.</div></div>
      <div className="acts"><button className="btn primary" onClick={() => respond(null)}>{counterReq.options.length ? 'Done' : 'No Counter'}</button></div></>;
  } else if (req && req.type === 'main' && myTurn) {
    const firstTurn = game.turn <= 2;
    bar = <>
      <div className="msg"><div className="step">Your turn{mode && mode.kind === 'attack' ? ` · ${cardName(mode.card)} attacks` : giving ? ' · giving DON!!' : ''}</div>
        <div className="txt">{flash || (mode && mode.kind === 'attack' ? 'Click the Leader or rested Character to attack.' : giving ? 'Click your Leader or a Character to give it 1 DON!! (+1000 power this turn).' : `Play cards, give DON!!, then attack${firstTurn ? ' (nobody can attack on their first turn)' : ''}.`)}</div></div>
      <div className="acts op-acts">
        {mode || giving ? <button className="btn" onClick={() => { setMode(null); donMode.current = false; }}>Cancel</button> : null}
        {!mode && !giving && donActs.length ? <button className="btn" onClick={() => setMode({ kind: 'don' })}>Give DON!!</button> : null}
        {actions.filter(a => a.t === 'activate' && game.cardByUid(a.card) === P.stage).map(a => <button key={a.card + ':' + a.ability} className="btn" title={effectWords(a)} onMouseEnter={() => setHover(a.card)} onClick={() => respond(a)}>Use {P.stage.def.name}</button>)}
        <button className="btn primary" onClick={() => { setMode(null); donMode.current = false; respond(actions.find(a => a.t === 'end') || { t: 'end' }); }}>End turn</button>
      </div>
    </>;
  } else if (req && !watching) {
    // a question answered in a window of its own
    bar = <div className="msg"><div className="step">Choose</div><div className="txt">{youText(req.prompt)}</div></div>;
  } else {
    const who = game.current === me && !watching ? 'You are' : `${game.players[game.current].name} is`;
    const doing = game.battle ? `${cardName(game.battle.attacker)} attacks ${cardName(game.battle.blocker || game.battle.target)}` : `${who} ${game.phase === 'main' ? 'thinking' : 'getting ready'}`;
    bar = <div className="msg waiting"><div className="step">{game.turn ? `${game.current === me && !watching ? 'Your' : `${game.players[game.current].name}'s`} turn` : 'Getting ready'}</div><div className="txt thinking">{doing}</div></div>;
  }

  // the fight in progress: attacker's power against the defender's, live through Counters
  let fight = null;
  if (game.battle && game.power) {
    const a = game.cardByUid(game.battle.attacker), t = game.cardByUid(game.battle.blocker || game.battle.target);
    if (a && t) {
      const ap = game.power(a), tp = game.power(t);
      fight = (
        <div className="op-fight" aria-live="polite">
          <span className={`side ${ap >= tp ? 'win' : ''}`}><small>{a.def.name}</small><b>{ap}</b></span>
          <span className="vs">VS</span>
          <span className={`side ${tp > ap ? 'win' : ''}`}><small>{t.def.name}{game.battle.blocker ? ' (blocking)' : ''}</small><b>{tp}</b></span>
        </div>
      );
    }
  }

  const side = (p, bottom) => {
    const chars = p.characters || [];
    const front = (
      <div className="op-front">
        <div className="op-chars">
          {chars.map(c => <InPlay key={c.uid} game={game} card={c} state={stateOf(c)} fx={fx} me={me} onClick={e => onField(c, e)} onHover={setHover} />)}
          {Array.from({ length: Math.max(0, 5 - chars.length) }, (_, i) => <EmptySlot key={'e' + i} label="Character" />)}
        </div>
      </div>
    );
    const back = (
      <div className="op-back">
        {p.leader ? <InPlay game={game} card={p.leader} lead state={stateOf(p.leader)} fx={fx} me={me} onClick={e => onField(p.leader, e)} onHover={setHover} /> : <EmptySlot label="Leader" />}
        {p.stage ? <InPlay game={game} card={p.stage} state={stateOf(p.stage)} fx={fx} me={me} onClick={e => onField(p.stage, e)} onHover={setHover} /> : <EmptySlot label="Stage" />}
        <DonArea p={p} pick={bottom && myTurn && !watching && donActs.length > 0 && !mode} onPick={() => setMode({ kind: 'don' })} />
      </div>
    );
    const ld = p.leader ? p.leader.def : null;
    return (
      <section className={`op-side ${bottom ? 'me' : 'opp'} ${game.current === p.id && !game.over && game.turn ? 'turn' : ''}`} aria-label={`${!watching && p.id === me ? 'Your' : `${p.name}'s`} side`}
        style={ld ? { '--c1': COLOR_HEX[ld.colors[0]], '--c2': COLOR_HEX[ld.colors[1] || ld.colors[0]] } : undefined}>
        <div className="op-plate">
          <EmoteBubble b={emotes.bubbles.get(p.id)} />
          <div className="who">{avatarOf(p.id) ? <AnimalAvatar code={avatarOf(p.id)} size={34} /> : null}<b title={p.name}>{p.name}</b>{game.current === p.id && !game.over && game.turn ? <span className="turnmark">turn</span> : null}</div>
          {p.deckName && p.deckName !== p.name ? <div className="deck">{p.deckName}</div> : null}
          <Life p={p} sleeve={sleeves[p.id]} setup={!game.turn} />
        </div>
        <div className="op-field">{front}{back}</div>
        <Piles p={p} onOpen={z => setZone({ p, z })} sleeve={sleeves[p.id]} hand={!bottom} />
      </section>
    );
  };

  const hand = P.hand;
  const counterCards = new Map(counterReq ? counterReq.options.map(o => [o.card, o]) : []);
  const playable = new Set(actions.filter(a => a.t === 'play').map(a => a.card));
  const dialog = (() => {
    if (!req || game.over) return null;
    if (req.type === 'cards' && req.from !== 'field') return <CardsDialog key={pend.id} game={game} req={req} respond={respond} onHover={setHover} me={me} sleeves={sleeves} />;
    if (req.type === 'confirm' && req.cards && req.cards.length) {
      const look = req.hint === 'look';
      return (
        <Modal narrow label={look ? 'Look' : 'Choose'}>
          <h2>{look ? 'Only you can see this' : 'Choose'}</h2>
          <p className="sub">{youText(req.prompt)}</p>
          <div className="op-picks">{req.cards.map(id => game.cardByUid(id)).filter(Boolean).map(c => <div key={c.uid} className="op-pick"><OpCard card={c} onEnter={() => setHover(c.uid)} onLeave={() => setHover(null)} /></div>)}</div>
          <div className="row">{look ? <button className="btn primary" onClick={() => respond(true)}>OK</button> : <><button className="btn" onClick={() => respond(false)}>No</button><button className="btn primary" onClick={() => respond(true)}>Yes</button></>}</div>
        </Modal>
      );
    }
    if (req.type === 'order') return <OrderDialog key={pend.id} game={game} req={req} respond={respond} onHover={setHover} />;
    if (req.type === 'option' && !barOptions(req)) return <Modal label={req.prompt}><h2>Choose</h2><p className="sub">{youText(req.prompt)}</p><div className="optlist">{req.options.map(o => <button key={String(o.value)} className="btn" onClick={() => respond(o.value)}>{youText(o.label)}</button>)}</div></Modal>;
    if (req.type === 'trigger') {
      const c = game.cardByUid(req.card);
      return (
        <Modal narrow label="Trigger">
          <h2>Trigger!</h2>
          <p className="sub">Your Life card {c ? <b>{c.def.name}</b> : null} has a [Trigger]. Use it now instead of adding the card to your hand?</p>
          {c ? <div className="op-picks"><div className="op-pick on" style={{ width: 150 }}><OpCard card={c} /></div></div> : null}
          {c && c.def.trigger ? <p className="op-trigtext"><span className="kw trigger">Trigger</span> {c.def.trigger}</p> : null}
          <div className="row"><button className="btn" onClick={() => respond(false)}>Add to hand</button><button className="btn primary" onClick={() => respond(true)}>Use the Trigger</button></div>
        </Modal>
      );
    }
    if (req.type === 'mulligan') {
      return (
        <Modal label="Opening hand">
          <h2>Your opening hand</h2>
          <p className="sub">Keep these 5 cards, or shuffle them back and draw 5 new ones (once).</p>
          <div className="op-picks">{P.hand.map(c => <div key={c.uid} className="op-pick"><OpCard card={c} onEnter={() => setHover(c.uid)} onLeave={() => setHover(null)} /></div>)}</div>
          <div className="row"><button className="btn" onClick={() => respond(true)}>Redraw</button><button className="btn primary" onClick={() => respond(false)}>Keep</button></div>
        </Modal>
      );
    }
    return null;
  })();

  const tips = [
    { id: 'mulligan', when: req && req.type === 'mulligan', text: 'Your opening hand: keep it, or shuffle it away and draw 5 new cards. You can redraw only once.' },
    { id: 'don', when: req && req.type === 'main' && myTurn && game.turn <= 2, text: 'DON!! cards pay for your cards: a card costing 3 rests 3 DON!!. You can also give DON!! to your Leader or a Character for +1000 power each this turn.' },
    { id: 'attack', when: req && req.type === 'main' && myTurn && attackers.size > 0, text: 'Click a glowing Leader or Character, then Attack… and pick the opponent’s Leader or a rested Character. Each hit on the Leader takes a Life card.' },
    { id: 'counter', when: !!counterReq, text: 'You’re being attacked! Click cards in your hand to add their Counter power (shown on them) to your defender, then press Done. Power equal to the attacker’s still loses: you need more.' },
    { id: 'block', when: !!blockReq, text: 'A [Blocker] can take this hit instead: click it, or press No block.' },
    { id: 'trigger', when: req && req.type === 'trigger', text: 'A Life card with a [Trigger] can be used for free right now instead of going to your hand.' },
  ];

  return (
    <div className="app table op">
      <header className="topbar">
        <button className="brand linklike" onClick={onExit} title="Leave the battle">Stigz’s<span className="brand-rest"> TCG Arena</span></button>
        <span className="chip op-chip">One Piece</span>
        <span className="turninfo">{game.turn ? <>Turn <b>{game.turn}</b> · <b>{game.players[game.current].name}</b></> : <b>Getting ready</b>}</span>
        {online ? <RoomStatus session={session} /> : null}
        {replay ? <ReplayBar ctl={replay} /> : null}
        <span className="spacer" />
        <EmoteButton emotes={emotes} />
        <SizeButton />
        <SoundToggle session={session} />
        <button className="btn sm danger" onClick={onExit} title={online && host && !game.over ? 'Ends the battle for both players' : undefined}>{replay ? 'Close replay' : game.over ? (online ? 'Back to room' : 'New battle') : online ? (host ? 'End battle' : watching ? 'Stop watching' : 'Leave battle') : 'Leave battle'}</button>
      </header>
      <div className="game op-game">
        <main className={`op-board ${game.over && !watching && result !== 'You win!' ? 'lost-game' : ''}`} ref={boardRef} onClick={e => { if (e.target === e.currentTarget) { setMode(null); donMode.current = false; } }}>
          {side(O, false)}
          <div className="op-mid">
            <div className={`prompt op-prompt ${req ? '' : 'waiting'}`}>{bar}{fight}</div>
            {fx.coin ? <div key={fx.coin.key} className="op-coin">{fx.coin.text}</div> : null}
          </div>
          {side(P, true)}
          <div className="op-hand" aria-label={`${watching ? `${P.name}'s` : 'Your'} hand`} style={{ '--n': hand.length }}>
            {watching ? hand.map(c => <div key={c.uid} className="op-handslot"><CardBack sleeve={sleeves[P.id]} /></div>) : hand.map(c => {
              const co = counterCards.get(c.uid);
              return (
                <div key={c.uid} className={`op-handslot ${playable.has(c.uid) || co ? 'playable' : ''}`}>
                  <OpCard card={c} fly={c.uid} onClick={e => onHand(c, e)} onEnter={() => setHover(c.uid)} onLeave={() => setHover(null)} />
                  {co ? <span className="ctrv">{co.kind === 'event' ? `Event · ${co.cost} DON!!` : `+${co.value}`}</span> : null}
                </div>
              );
            })}
            {!hand.length ? <span className="empty">{watching ? `${P.name}'s` : 'Your'} hand is empty</span> : null}
          </div>
          {fx.banner ? <div key={fx.banner.key} className={`op-banner ${fx.banner.kind}`}>{fx.banner.text}</div> : null}
          {fx.reveal ? <div key={fx.reveal.key} className="op-reveal" aria-hidden="true">{fx.reveal.cards.map(uid => { const c = game.cardByUid(uid); return c ? <OpCard key={uid} card={c} /> : null; })}</div> : null}
          <WatcherEmotes list={emotes.watchers} />
          {!replay && !watching ? <Coach kind="op" tips={tips} /> : null}
        </main>
        <aside className="rail">
          <section className="preview-sec"><Preview game={game} uid={hover != null ? hover : req && req.card != null && req.type !== 'trigger' ? req.card : P.leader ? P.leader.uid : null} me={me} /></section>
          <section className="log-sec"><h3>Battle log</h3><Log game={game} me={watching ? null : me} /></section>
        </aside>
      </div>
      {dialog}
      {menu ? <Menu menu={menu} onClose={() => setMenu(null)} /> : null}
      {zoom != null && game.cardByUid(zoom) ? <Modal narrow label="Card" onClose={() => setZoom(null)} cls="op-zoom"><Preview game={game} uid={zoom} me={me} /><div className="row"><button className="btn primary" onClick={() => setZoom(null)}>Close</button></div></Modal> : null}
      {zone ? <ZoneDialog game={game} p={zone.p} zone={zone.z} onClose={() => setZone(null)} onHover={setHover} /> : null}
      {result && !dismissed ? (
        <>{result === 'You win!' ? <Confetti /> : null}<Modal narrow label="Game over" cls={result === 'You win!' ? 'win' : ''}>
          <h2 className={result === 'You win!' ? 'win' : ''}>{result}</h2>
          <p className="sub">{youText(game.result || '')}. {game.turn} turns.{online && !host ? ' The host can start a rematch from here.' : ''}</p>
          <div className="row">
            <button className="btn" onClick={() => setDismissed(true)}>View board</button>
            {replay ? <>
              <button className="btn" onClick={() => onReplay && onReplay(session.replayId)}>Watch again</button>
              <button className="btn primary" onClick={onExit}>Close replay</button>
            </> : <>
              {session.record && session.record.replay && onReplay ? <button className="btn" onClick={() => onReplay(session.record.id)}>Watch replay</button> : null}
              <button className="btn" onClick={onLobby}>{online ? 'Back to room' : 'New battle'}</button>
              {!online || host ? <button className="btn primary" onClick={onRematch}>Rematch</button> : null}
            </>}
          </div>
        </Modal></>
      ) : null}
      {flash && !(req && req.type === 'main' && myTurn) ? <div className="toast" role="status">{flash}</div> : null}
    </div>
  );
}
