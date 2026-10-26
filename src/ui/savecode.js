// Save codes: take your progress to another device without an account. Everything the site keeps in this browser
// (records and replays, your own decks, avatar, name, sleeves and deck boxes, settings, last-picked decks) is packed
// into one compressed string and kept on the site's server (worker/index.js) under a short code like K7QM-4ZP2.
// A device that made or loaded a code stays linked to it: it saves again after every game and every deck change,
// and when the site opens it brings in what other devices saved since. Records and decks from both sides are
// combined, never overwritten. Where the server can't be reached (the claude.ai copy of the site, no internet),
// the same save works as a long text to copy and paste.
import { findRelay } from '../net/relayroom.js';
import { REC_KEY, KEEP_RECORDS, KEEP_REPLAYS } from './records.js';
import { registerDeck } from './customdecks.js';

const LINK = 'pa-savecode';                 // { code, rev, at, hash }: this device's code (not part of any save)
const OURS = /^(pa|pk|op)-/;
// what stays with each device: its id in friends' rooms, the rooms it's in, screen size and animations, its link,
// and its login (account.js)
const LOCAL = /^pa-(cid|savecode|account|open-replay|home-join|uisize|motion)$|^pa-room(cfg)?-/;
const REPLAY = /^pa-replay-(.+)$/;
const DECKS = 'pa-custom-decks', GONE = 'pa-deleted-decks', SEEN = 'pa-deck-cache';
const MAX_PACKED = 2_400_000;               // the server takes up to 2,500,000 characters
export const TEXT_PREFIX = 'TCGSAVE:';
export const CODE_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

// ---- codes: 8 characters with no 0/O or 1/I, shown as K7QM-4ZP2; typed in any case, with or without the dash
export const normCode = s => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
export const isCode = s => new RegExp(`^[${CODE_CHARS}]{8}$`).test(normCode(s));
export const showCode = c => (c ? `${c.slice(0, 4)}-${c.slice(4)}` : '');

// ---- what's saved
const store = typeof localStorage !== 'undefined' ? localStorage : null;
function localItems() {
  const out = {};
  if (!store) return out;
  try {
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (!k || !OURS.test(k) || LOCAL.test(k)) continue;
      const v = store.getItem(k);
      if (v) out[k] = v;
    }
  } catch { /* storage blocked */ }
  return out;
}
// only the site's own keys, as strings (a save is data from anyone who has the code)
function cleanItems(items) {
  const out = {};
  if (!items || typeof items !== 'object') return out;
  for (const [k, v] of Object.entries(items)) if (OURS.test(k) && !LOCAL.test(k) && typeof v === 'string' && v && k.length < 80) out[k] = v;
  return out;
}
function writeLocal(items) {
  if (!store) return false;
  try {
    for (const k of Object.keys(localItems())) if (!(k in items)) store.removeItem(k);
    for (const [k, v] of Object.entries(items)) if (store.getItem(k) !== v) store.setItem(k, v);
    return true;
  } catch { return false; }
}
const list = v => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };

// two saves made one: every game and every deck from both; for single things (avatar, name, settings) `winner`'s
export function mergeSaves(a, b, winner = 'b') {
  const [lose, win] = winner === 'b' ? [a, b] : [b, a];
  const out = { ...lose, ...win };
  // games: everyone's, newest first; the same game on both sides is one game (with its replay if either has it)
  const recs = new Map();
  for (const r of [...list(win[REC_KEY]), ...list(lose[REC_KEY])]) {
    if (!r || typeof r.id !== 'string') continue;
    const had = recs.get(r.id);
    if (!had || (!had.replay && r.replay)) recs.set(r.id, r);
  }
  for (const k of Object.keys(out)) if (REPLAY.test(k)) delete out[k];
  const kept = {};
  const games = [...recs.values()].sort((x, y) => (y.at || 0) - (x.at || 0)).slice(0, KEEP_RECORDS).map(r => {
    const rep = win['pa-replay-' + r.id] || lose['pa-replay-' + r.id];
    if (r.replay && rep && (kept[r.kind] = (kept[r.kind] || 0) + 1) <= KEEP_REPLAYS) { out['pa-replay-' + r.id] = rep; return r; }
    return r.replay ? { ...r, replay: false } : r;
  });
  if (games.length) out[REC_KEY] = JSON.stringify(games); else delete out[REC_KEY];
  // your own decks: the latest version of each, except ones deleted on either side
  const gone = [...new Set([...list(lose[GONE]), ...list(win[GONE])].filter(x => typeof x === 'string'))].slice(-300);
  const decks = new Map();
  for (const d of [...list(win[DECKS]), ...list(lose[DECKS])]) {
    if (!d || typeof d.id !== 'string' || gone.includes(d.id)) continue;
    const had = decks.get(d.id);
    if (!had || (d.updated || 0) > (had.updated || 0)) decks.set(d.id, d);
  }
  if (decks.size) out[DECKS] = JSON.stringify([...decks.values()].sort((x, y) => (y.updated || 0) - (x.updated || 0)));
  else delete out[DECKS];
  if (gone.length) out[GONE] = JSON.stringify(gone);
  // others' decks met in rooms and replays
  const seen = new Map();
  for (const d of [...list(win[SEEN]), ...list(lose[SEEN])]) if (d && typeof d.id === 'string' && !seen.has(d.id)) seen.set(d.id, d);
  if (seen.size) out[SEEN] = JSON.stringify([...seen.values()].slice(0, 40));
  return out;
}

// what this device would save
export const currentSummary = () => summarize(localItems());

// what a save holds, for showing before it's loaded
export function summarize(items) {
  const recs = list(items[REC_KEY]);
  const n = k => recs.filter(r => r.kind === k).length;
  return {
    games: recs.length, mtg: n('mtg'), pk: n('pk'), op: n('op'),
    wins: recs.filter(r => r.result === 'win').length,
    replays: Object.keys(items).filter(k => REPLAY.test(k)).length,
    decks: list(items[DECKS]).length,
    name: typeof items['pa-nick'] === 'string' ? items['pa-nick'].slice(0, 40) : null,
    avatar: typeof items['pa-avatar'] === 'string' ? items['pa-avatar'] : null,
    sleeves: !!items['pa-deckstyle'],
  };
}

// ---- packing: JSON, deflated where the browser can, as URL-safe base64 ("z..." compressed, "j..." plain)
function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
const through = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

export async function pack(items) {
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, at: Date.now(), items }));
  if (typeof CompressionStream === 'function') { try { return 'z' + b64(await through(bytes, new CompressionStream('deflate-raw'))); } catch { /* fall back to plain */ } }
  return 'j' + b64(bytes);
}
export async function unpack(str) {
  const s = String(str || '').replace(/\s+/g, '');
  if (!/^[zj][A-Za-z0-9_-]+$/.test(s)) throw new SaveError('notasave');
  let bytes;
  try {
    bytes = unb64(s.slice(1));
    if (s[0] === 'z') bytes = await through(bytes, new DecompressionStream('deflate-raw'));
  } catch { throw new SaveError('notasave'); }
  let v;
  try { v = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new SaveError('notasave'); }
  if (!v || v.v !== 1 || !v.items || typeof v.items !== 'object') throw new SaveError('notasave');
  return { at: +v.at || null, items: cleanItems(v.items) };
}
// packed small enough for the server: the oldest replays go first if it's too big
async function packToFit(items) {
  let cur = items;
  for (;;) {
    const p = await pack(cur);
    const reps = list(cur[REC_KEY]).filter(r => r.replay && cur['pa-replay-' + r.id]);
    if (p.length <= MAX_PACKED || !reps.length) return p;
    const drop = new Set(reps.slice(-Math.max(1, Math.ceil(reps.length / 4))).map(r => r.id));
    cur = { ...cur };
    for (const id of drop) delete cur['pa-replay-' + id];
    cur[REC_KEY] = JSON.stringify(list(cur[REC_KEY]).map(r => (drop.has(r.id) ? { ...r, replay: false } : r)));
  }
}
// a fingerprint of a save's contents, to skip uploading what the server already has
function fingerprint(items) {
  let h = 0x811c9dc5;
  for (const k of Object.keys(items).sort()) {
    const s = k + '\u0000' + items[k] + '\u0001';
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  }
  return (h >>> 0).toString(36);
}

// ---- this device's link
export function savedLink() {
  try { const v = JSON.parse((store && store.getItem(LINK)) || 'null'); return v && isCode(v.code) ? v : null; } catch { return null; }
}
function setLink(v) {
  try { if (v) store.setItem(LINK, JSON.stringify(v)); else store.removeItem(LINK); } catch { /* storage blocked */ }
  emit();
}
export function forgetCode() { setLink(null); setStatus({ state: 'idle' }); }
// everything saved on this device goes (logging out of a shared computer); device settings stay
export function clearProgress() { writeLocal({}); emit(); }

// ---- status, for the dialog and the home page
let status = { state: 'idle' };
const subs = new Set();
const emit = () => { status = { ...status }; subs.forEach(f => f()); };
const setStatus = s => { status = s; subs.forEach(f => f()); };
export const saveStatus = () => status;
export const subscribeSave = f => { subs.add(f); return () => subs.delete(f); };

export class SaveError extends Error {
  constructor(code) { super(code); this.code = code; }
}
// what went wrong, in words
export function saveErrorText(e) {
  switch (e && e.code) {
    case 'offline': return 'The save server can’t be reached from here. Check your connection, or use a save text instead.';
    case 'missing': return 'There’s no save with that code. Check the letters and numbers (there are no zeros or ones in a code).';
    case 'notasave': return 'That isn’t a save code or a save text.';
    case 'toobig': return 'This save is too big to keep on the server.';
    default: return 'Something went wrong talking to the save server. Try again in a moment.';
  }
}

async function api(method, path, body) {
  const origin = await findRelay();
  if (!origin) throw new SaveError('offline');
  let r;
  try {
    r = await fetch(`${origin}/save/${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  } catch { throw new SaveError('offline'); }
  let j = {};
  try { j = await r.json(); } catch { /* not JSON */ }
  if (r.status === 413) throw new SaveError('toobig');
  if (r.status >= 500) throw new SaveError('server');
  return { status: r.status, ...j };
}

// the save under a code, unpacked: { code, rev, at, items }
export async function fetchSave(code) {
  const c = normCode(code);
  if (!isCode(c)) throw new SaveError('missing');
  const r = await api('GET', c);
  if (r.status === 404) throw new SaveError('missing');
  if (r.status !== 200 || typeof r.data !== 'string') throw new SaveError('server');
  const s = await unpack(r.data);
  return { code: c, rev: r.rev, at: r.at, items: s.items };
}

// other devices' games and decks into this one (when the site opens, or before saving over a newer save)
function bringIn(remote) {
  const merged = mergeSaves(localItems(), remote.items, 'a');
  writeLocal(merged);
  for (const d of list(merged[DECKS])) registerDeck(d);
}

// save this device's progress under its code (making one the first time). If another device saved since, its
// games and decks come in first, so the save holds both.
let running = null, again = false;
export function saveNow() {
  if (running) { again = true; return running; }
  running = (async () => {
    try { return await sync(); } finally {
      running = null;
      if (again) { again = false; saveNow().catch(() => {}); }
    }
  })();
  return running;
}
async function sync() {
  setStatus({ ...status, state: 'saving' });
  try {
    let link = savedLink();
    if (!link) {
      const items = localItems();
      const r = await api('POST', 'new', { data: await packToFit(items) });
      if (r.status !== 200 || !isCode(r.code)) throw new SaveError('server');
      setLink({ code: r.code, rev: r.rev, at: r.at, hash: fingerprint(items) });
      setStatus({ state: 'saved', at: r.at });
      return savedLink();
    }
    for (let tries = 0; tries < 4; tries++) {
      // what's on the server: newer than what this device last saw means another device saved
      const info = await api('GET', link.code + '/info');
      if (info.status === 404) {
        // the code is gone (unused for over a year): start a fresh one
        setLink(null);
        return await sync();
      }
      if (info.status !== 200) throw new SaveError('server');
      if (info.rev !== link.rev) {
        const remote = await fetchSave(link.code);
        bringIn(remote);
        link = { ...link, rev: remote.rev, hash: null };
        setLink(link);
      }
      const items = localItems();
      const hash = fingerprint(items);
      if (hash === link.hash) { setStatus({ state: 'saved', at: link.at }); return link; }
      const r = await api('PUT', link.code, { data: await packToFit(items), baseRev: link.rev });
      if (r.status === 200) {
        link = { ...link, rev: r.rev, at: r.at, hash };
        setLink(link);
        setStatus({ state: 'saved', at: r.at });
        return link;
      }
      if (r.status === 404) { setLink(null); return await sync(); }
      if (r.status !== 409) throw new SaveError('server');
      // another device saved in between: go round again, bringing that in
    }
    throw new SaveError('server');
  } catch (e) {
    setStatus({ state: 'error', error: e instanceof SaveError ? e.code : 'server' });
    throw e;
  }
}

// load a code's save onto this device: its games and decks join this device's, and its avatar, name and settings
// replace this device's. The device then keeps saving to that code. (The caller reloads the page after.)
export async function loadCode(remote) {
  const merged = mergeSaves(localItems(), remote.items, 'b');
  if (!writeLocal(merged)) throw new SaveError('storage');
  setLink({ code: remote.code, rev: remote.rev, at: remote.at, hash: null });
  try { await saveNow(); } catch { /* it saves next time */ }
}

// ---- the long text, for when the server can't be reached
export async function saveText() { return TEXT_PREFIX + await pack(localItems()); }
export async function readText(text) {
  const s = String(text || '').trim();
  if (!s.startsWith(TEXT_PREFIX)) throw new SaveError('notasave');
  return unpack(s.slice(TEXT_PREFIX.length));
}
export function loadText(save) {
  if (!writeLocal(mergeSaves(localItems(), save.items, 'b'))) throw new SaveError('storage');
}

// ---- automatic saving for a linked device: when the site opens, and a moment after progress changes
let timer = null;
export function queueSave(ms = 2500) {
  if (!savedLink()) return;
  clearTimeout(timer);
  timer = setTimeout(() => saveNow().catch(() => {}), ms);
}
export function initSaveCodes() {
  if (typeof window === 'undefined') return;
  window.addEventListener('pa-progress', () => queueSave());
  if (savedLink()) queueSave(1500);
}
