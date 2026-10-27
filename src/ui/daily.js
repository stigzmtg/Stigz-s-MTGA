// The daily challenge: one game a day that is the same for everyone (your deck, the opponents and the shuffle all
// come from the date), so friends can compare how they did. Results are kept with the other game records.
import { loadRecords } from './records.js';

// today's date on this device, as 2026-10-27
export function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// the day's game, from the precons and community decks (never anyone's own): 1 vs 1, 3- or 4-player
export function dailyChallenge(decks, key = dayKey()) {
  const pool = decks.filter(d => !d.custom).slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (pool.length < 4) return null;
  let h = hash('lotus-goats-daily:' + key);
  const next = () => { h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0; h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0; h = (h ^ (h >>> 16)) >>> 0; return h; };
  const numOpp = 1 + (next() % 3);
  const picked = [];
  while (picked.length < numOpp + 1) { const d = pool[next() % pool.length]; if (!picked.includes(d)) picked.push(d); }
  return { key, seed: next(), mine: picked[0], opps: picked.slice(1), level: 'normal' };
}

// how you did: today's result (a win counts once you have one), and how many days in a row you've won,
// counting today or, while today isn't won yet, up to yesterday
export function dailyStatus(key = dayKey()) {
  const days = new Map();
  for (const r of loadRecords()) {
    if (r.kind !== 'mtg' || !r.daily) continue;
    const was = days.get(r.daily);
    if (was !== 'win') days.set(r.daily, r.result === 'win' ? 'win' : was || r.result);
  }
  let streak = 0;
  const d = new Date(key + 'T12:00:00');
  if (days.get(key) !== 'win') d.setDate(d.getDate() - 1);
  while (days.get(dayKey(d)) === 'win') { streak++; d.setDate(d.getDate() - 1); }
  const tries = loadRecords().filter(r => r.kind === 'mtg' && r.daily === key).length;
  return { today: days.get(key) || null, tries, streak, won: [...days.values()].filter(v => v === 'win').length };
}
