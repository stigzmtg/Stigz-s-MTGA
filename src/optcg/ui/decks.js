// One Piece decks by id. An Ultra Deck's box holds three Leaders that all work with its 50 cards, so a deck id can name
// the Leader picked: "st13@ST13-001" is ST-13 led by Sabo. That one string is what rooms, records and replays carry.
export const baseDeckId = id => String(id || '').split('@')[0];

export function deckById(data, id) {
  const [base, lead] = String(id || '').split('@');
  const d = data.decks.find(x => x.id === base);
  if (!d) return null;
  if (!lead || lead === d.leader || !(d.leaders || []).includes(lead) || !data.cards[lead]) return d;
  return { ...d, id: `${d.id}@${lead}`, leader: lead, colors: data.cards[lead].colors, featured: lead };
}

// the deck's id with this Leader (the plain id for the deck's own Leader)
export const withLeader = (d, lead) => (!lead || lead === d.leader || !(d.leaders || []).includes(lead) ? d.id : `${d.id}@${lead}`);

// "ST-13 Ultra Deck: The Three Brothers" or, with another Leader, "... (Sabo)"
export function deckLabel(data, d) {
  const base = data.decks.find(x => x.id === baseDeckId(d.id));
  const other = base && d.leader !== base.leader && data.cards[d.leader];
  return `${d.code} ${d.name}${other ? ` (${other.name})` : ''}`;
}
