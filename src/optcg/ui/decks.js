// One Piece decks by id. An Ultra Deck's box holds three Leaders that all work with its 50 cards, so a deck id can name
// the Leader picked: "st13@ST13-001" is ST-13 led by Sabo. That one string is what rooms, records and replays carry.
// Your own decks (mydecks.js) have ids like "opd-k2x9q4ab" and are found the same way.
import { isCustomId, customDeck, asDeck, unpackDeck } from './mydecks.js';

export const baseDeckId = id => String(id || '').split('@')[0];

export function deckById(data, id) {
  if (isCustomId(id)) return asDeck(data.cards, customDeck(id));
  const [base, lead] = String(id || '').split('@');
  const d = data.decks.find(x => x.id === base);
  if (!d) return null;
  if (!lead || lead === d.leader || !(d.leaders || []).includes(lead) || !data.cards[lead]) return d;
  return { ...d, id: `${d.id}@${lead}`, leader: lead, colors: data.cards[lead].colors, featured: lead };
}

// a seat's deck: the list that travelled with it (a battle's config, a replay), else by its id. Every browser in a room
// builds the battle from the list in the host's config, so a deck changed since can't make them differ.
export const deckOfSeat = (data, packed, id) => (packed && asDeck(data.cards, unpackDeck(packed))) || deckById(data, id);

// the deck's id with this Leader (the plain id for the deck's own Leader)
export const withLeader = (d, lead) => (!lead || lead === d.leader || !(d.leaders || []).includes(lead) ? d.id : `${d.id}@${lead}`);

// "ST-13 Ultra Deck: The Three Brothers" or, with another Leader, "... (Sabo)"; your own deck by its name and Leader
export function deckLabel(data, d) {
  if (d.custom) return `${d.name} (${(data.cards[d.leader] || {}).name || 'no Leader'})`;
  const base = data.decks.find(x => x.id === baseDeckId(d.id));
  const other = base && d.leader !== base.leader && data.cards[d.leader];
  return `${d.code} ${d.name}${other ? ` (${other.name})` : ''}`;
}
