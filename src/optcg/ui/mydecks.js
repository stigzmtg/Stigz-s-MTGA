// Your own One Piece decks: a Leader and 50 cards from the ones the engine implements, built in the deck builder
// (builder.jsx) or pasted. They have the starter decks' shape ({ id, name, leader, cards: [[number, n]] }, as in
// data/optcg/decks.json) plus custom: true, so the lobby, the table, records and replays treat them alike. Saved on
// this device (save codes carry them: ui/savecode.js). In friends' rooms each player's presence carries their deck
// (packDeck), and the host writes every seat's deck into the battle's config when it starts, so every browser builds
// the battle from the identical list. A replay keeps the decks it was played with.
import { safeStorage, progressChanged } from '../../ui/common.js';
import { DECK_SIZE, MAX_COPIES, NAME_MAX } from './decktext.js';

const MINE = 'op-custom-decks';
const GONE = 'op-deleted-decks';    // (a deleted deck is remembered, so a save code from another device doesn't bring it back)
const SEEN = 'op-deck-cache';       // other people's decks met in rooms and replays
const NUMBER = /^[A-Z]{1,4}\d{0,2}-\d{3}$/;

export const isCustomId = id => /^opd-[a-z0-9]{4,16}$/.test(String(id || ''));
export const newDeckId = () => 'opd-' + Math.random().toString(36).slice(2, 10);

function validShape(d) {
  return !!d && isCustomId(d.id) && typeof d.name === 'string' && (d.leader == null || NUMBER.test(d.leader)) && Array.isArray(d.cards) && d.cards.length <= 60
    && d.cards.every(e => Array.isArray(e) && NUMBER.test(e[0]) && Number.isInteger(e[1]) && e[1] > 0 && e[1] <= DECK_SIZE);
}
const read = k => { try { const v = JSON.parse(safeStorage.getItem(k) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const write = (k, v) => safeStorage.setItem(k, JSON.stringify(v));

// your decks, newest first (read again only when storage changed: another tab, a save code coming in)
let mine = { raw: null, list: [] };
export function loadMyDecks() {
  const raw = safeStorage.getItem(MINE);
  if (raw !== mine.raw) mine = { raw, list: read(MINE).filter(validShape) };
  return mine.list;
}
export function saveMyDeck(deck) {
  const d = { id: deck.id, name: String(deck.name || '').slice(0, NAME_MAX), leader: deck.leader || null, cards: deck.cards.filter(([, n]) => n > 0), updated: Date.now() };
  if (!validShape(d)) return;
  write(MINE, [d, ...loadMyDecks().filter(x => x.id !== d.id)]);
  progressChanged();
}
export function deleteMyDeck(id) {
  write(MINE, loadMyDecks().filter(d => d.id !== id));
  write(GONE, [...read(GONE).filter(x => x !== id), id].slice(-300));
  progressChanged();
}

// decks met in rooms and replays: kept so the seat list, the battle and its record can name them
const seen = new Map(read(SEEN).filter(validShape).map(d => [d.id, d]));
export function rememberDeck(d) {
  if (!validShape(d) || loadMyDecks().some(x => x.id === d.id)) return;
  const known = seen.get(d.id);
  if (known && known.name === d.name && known.leader === d.leader && JSON.stringify(known.cards) === JSON.stringify(d.cards)) return;
  seen.set(d.id, d);
  write(SEEN, [d, ...read(SEEN).filter(x => x && x.id !== d.id)].slice(0, 40));
}
export const customDeck = id => loadMyDecks().find(d => d.id === id) || seen.get(id) || null;

// a deck as the lobby and the table use it: the Leader's colors and picture, no box code, marked as yours
export function asDeck(cards, d) {
  if (!d) return null;
  const lead = cards[d.leader];
  return { ...d, code: '', blurb: '', custom: true, colors: lead ? lead.colors : [], featured: d.leader };
}

// the compact form that travels in room presence, battle configs and replays: { i, n, l: Leader, c: 'OP01-016*4|ST01-012|…' }
export function packDeck(d) { return { i: d.id, n: String(d.name || '').slice(0, NAME_MAX), l: d.leader, c: d.cards.map(([k, n]) => (n > 1 ? `${k}*${n}` : k)).join('|') }; }
export function unpackDeck(p) {
  if (!p || typeof p.c !== 'string' || typeof p.l !== 'string') return null;
  const cards = p.c.split('|').filter(Boolean).map(s => { const m = /^(.*)\*(\d+)$/.exec(s); return m ? [m[1], +m[2]] : [s, 1]; });
  const d = { id: String(p.i), name: String(p.n || 'A custom deck').slice(0, NAME_MAX), leader: p.l, cards };
  return validShape(d) ? d : null;
}

// a replay keeps the decks it was played with, since your own can change later: ui/records.js saves the seats (as
// "pa-replay-<id>"), and this adds each player's own deck to its seat as a list
export function keepReplayDecks(rec, decks) {
  if (!rec || !rec.replay || !decks || !decks.some(d => d && d.custom)) return;
  const key = `pa-replay-${rec.id}`;
  try {
    const rep = JSON.parse(localStorage.getItem(key) || 'null');
    if (!rep || !Array.isArray(rep.players)) return;
    rep.players = rep.players.map((p, i) => (decks[i] && decks[i].custom && p.deckId === decks[i].id ? { ...p, opDeck: packDeck(decks[i]) } : p));
    localStorage.setItem(key, JSON.stringify(rep));
  } catch { /* storage full or blocked: the replay plays the deck as it is now */ }
}

// ---- the rules, in plain words: a Leader and exactly 50 cards, at most 4 of any card number, every card sharing a
// color with the Leader, no Leaders in the 50 (and every card one the game has). One row per rule:
// { id, ok, label, text, cards: [numbers that break it] }
const named = (cards, ids, n = 3) => ids.slice(0, n).map(id => `${(cards[id] || {}).name || id} (${id})`).join(', ') + (ids.length > n ? ` and ${ids.length - n} more` : '');
export function rulesCheck(deck, cards) {
  const lead = deck.leader && cards[deck.leader];
  const total = deck.cards.reduce((a, [, n]) => a + n, 0);
  const unknown = deck.cards.filter(([id]) => !cards[id]).map(([id]) => id);
  const leaders = deck.cards.filter(([id]) => cards[id] && cards[id].cat === 'L').map(([id]) => id);
  const many = deck.cards.filter(([, n]) => n > MAX_COPIES).map(([id]) => id);
  const off = lead ? deck.cards.filter(([id]) => cards[id] && cards[id].cat !== 'L' && !cards[id].colors.some(c => lead.colors.includes(c))).map(([id]) => id) : [];
  const colors = lead ? lead.colors.join(' or ') : '';
  const rows = [
    { id: 'leader', ok: !!(lead && lead.cat === 'L'), label: 'A Leader', text: lead ? `${lead.name}: ${lead.colors.join(' and ')}, ${lead.life} Life.` : 'Choose a Leader first. It decides your colors.' },
    { id: 'size', ok: total === DECK_SIZE, label: 'Exactly 50 cards', text: total === DECK_SIZE ? '50 cards, not counting the Leader.' : total < DECK_SIZE ? `${total} of 50: ${DECK_SIZE - total} more to go.` : `${total} cards: take out ${total - DECK_SIZE}.` },
    { id: 'copies', ok: !many.length, label: 'Up to 4 of each', text: many.length ? `Too many copies of ${named(cards, many)}. A deck can have 4 of each card number.` : 'No more than 4 of any card number.', cards: many },
    { id: 'colors', ok: !!lead && !off.length, label: 'Your Leader’s colors', text: !lead ? 'Every card must share a color with your Leader.' : off.length ? `Not ${colors}: ${named(cards, off)}.` : `Every card is ${colors}.`, cards: off },
    { id: 'leaders', ok: !leaders.length, label: 'No Leaders in the 50', text: leaders.length ? `Leaders can’t go in the 50: ${named(cards, leaders)}.` : 'Your Leader stays out of the 50.', cards: leaders },
  ];
  if (unknown.length) rows.push({ id: 'unknown', ok: false, label: 'Cards in the game', text: `This game doesn’t have ${unknown.slice(0, 3).join(', ')}${unknown.length > 3 ? ` and ${unknown.length - 3} more` : ''}.`, cards: unknown });
  return rows;
}
export const deckReady = (deck, cards) => !!deck && rulesCheck(deck, cards).every(r => r.ok);
