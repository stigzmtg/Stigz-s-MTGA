// Card abilities for the One Piece engine: compiled from the card text (text.js), with hand-written overrides for
// the few texts the grammar doesn't cover. An override replaces the card's compiled abilities (or one of them) with
// the same structures text.js produces, so the engine treats every card alike.
import { compileText } from './text.js';

// id -> (def, compiled) => abilities. Kept small: prefer extending the grammar in text.js.
export const OVERRIDES = {};

const cache = new Map();
export function compileCard(def) {
  let c = cache.get(def);
  if (c) return c;
  c = compileText(def);
  const o = OVERRIDES[def.id];
  if (o) c = o(def, c);
  cache.set(def, c);
  return c;
}
