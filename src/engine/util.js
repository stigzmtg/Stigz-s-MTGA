export const COLORS = ['W', 'U', 'B', 'R', 'G'];
export const COLOR_NAMES = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green', C: 'colorless' };
export const NAME_TO_COLOR = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G', colorless: 'C' };
export const CAP_COLOR = { White: 'W', Blue: 'U', Black: 'B', Red: 'R', Green: 'G' };

export const CARD_TYPES = ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Instant', 'Land', 'Planeswalker', 'Sorcery', 'Kindred', 'Tribal', 'Dungeon', 'Conspiracy', 'Emblem', 'Plane', 'Phenomenon', 'Scheme', 'Vanguard'];
export const SUPERTYPES = ['Basic', 'Legendary', 'Snow', 'World', 'Ongoing'];
export const PERMANENT_TYPES = ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Land', 'Planeswalker'];
export const BASIC_LAND_TYPES = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };

// Small fast seeded PRNG (mulberry32)
export class RNG {
  constructor(seed = Date.now()) { this.s = seed >>> 0; }
  next() {
    let t = (this.s += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n) { return Math.floor(this.next() * n); }
  pick(arr) { return arr[this.int(arr.length)]; }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

export function compare(a, op, b) {
  switch (op) {
    case 'EQ': return a === b;
    case 'NE': return a !== b;
    case 'LT': return a < b;
    case 'LE': return a <= b;
    case 'GT': return a > b;
    case 'GE': return a >= b;
    default: return false;
  }
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
// let the page breathe during a long run of decisions (a message to ourselves: unlike a timer, not slowed in a hidden tab)
export const yieldTask = () => new Promise(r => {
  if (typeof MessageChannel === 'undefined') { setTimeout(r, 0); return; }
  const c = new MessageChannel();
  c.port1.onmessage = () => { c.port1.close(); r(); };
  c.port2.postMessage(0);
});

export function uniq(arr) { return [...new Set(arr)]; }

export function sum(arr, f = x => x) { let s = 0; for (const x of arr) s += f(x); return s; }

export function maxBy(arr, f) {
  let best = null, bv = -Infinity;
  for (const x of arr) { const v = f(x); if (v > bv) { bv = v; best = x; } }
  return best;
}

export function minBy(arr, f) {
  let best = null, bv = Infinity;
  for (const x of arr) { const v = f(x); if (v < bv) { bv = v; best = x; } }
  return best;
}

export class Unsupported extends Error {
  constructor(what) { super('Unsupported: ' + what); this.what = what; }
}
