// Verified badges in friends' rooms. A logged-in player's presence carries a badge the site's server signed
// (worker/accounts.js): this account, in this room, as this player id, until then. Everyone else's browser checks it
// with the server's public key before showing ✓, and only next to that exact name, so typing someone's name, or
// copying their badge into another room or onto another player, shows nothing.
import { findRelay } from '../net/relayroom.js';
import { isBadge } from '../net/roomclient.js';

const { useSyncExternalStore } = React;

// what the server signs (the same string as badgeText in worker/accounts.js)
const badgeText = (u, room, cid, x) => `tcg-badge-v1|${u}|${room}|${cid}|${x}`;
// the room a game or a room panel is in, as badges name it ("pa-k7m2qa", "pk-…", "op-…")
export const roomKeyOf = cfg => (cfg && cfg.code ? `${cfg.kind ? cfg.kind : 'pa'}-${cfg.code}` : null);

let keyP = null;
function publicKey() {
  if (!keyP) keyP = (async () => {
    const origin = await findRelay();
    if (!origin) return null;
    const r = await fetch(`${origin}/account/badgekey`, { cache: 'no-store' });
    if (!r.ok) throw new Error('no key');
    const { key } = await r.json();
    return crypto.subtle.importKey('jwk', { ...key, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  })().catch(() => { keyP = null; return null; });
  return keyP;
}
const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

// checked badges: signature → true/false (a badge is checked once; its room and player id are compared every time)
const checked = new Map();
const subs = new Set();
let version = 0;
const subscribe = f => { subs.add(f); return () => subs.delete(f); };
const getVersion = () => version;
function check(b) {
  if (checked.has(b.s)) return checked.get(b.s);
  checked.set(b.s, null);   // (being checked)
  publicKey().then(async key => {
    let good = false;
    if (key) { try { good = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unb64(b.s), new TextEncoder().encode(badgeText(b.u, b.r, b.c, b.x))); } catch { good = false; } }
    checked.set(b.s, good);
    if (!key) checked.delete(b.s);   // (no server to ask right now: try again next time)
    version++; subs.forEach(f => f());
  });
  return null;
}

// the verified username for a name shown in a room, or null: the badge must be the server's, for this room and this
// player id, not run out, and for this very name
export function verifiedName(badge, room, cid, name) {
  if (!isBadge(badge) || !room || badge.r !== room || badge.c !== cid || badge.x < Date.now()) return null;
  if (name != null && String(name).trim().toLowerCase() !== badge.u.toLowerCase()) return null;
  return check(badge) ? badge.u : null;
}
export function useVerified(badge, room, cid, name) {
  useSyncExternalStore(subscribe, getVersion);
  return verifiedName(badge, room, cid, name);
}

// the ✓ next to a name
export function VerifiedMark({ badge, room, cid, name, size = 'sm' }) {
  const u = useVerified(badge, room, cid, name);
  if (!u) return null;
  return <span className={`vbadge ${size}`} title={`Verified account: ${u}`} aria-label="verified account" role="img"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 .8l1.9 1.4 2.3-.2.8 2.2 2 1.2-.6 2.3.6 2.3-2 1.2-.8 2.2-2.3-.2L8 15.2l-1.9-1.4-2.3.2-.8-2.2-2-1.2.6-2.3-.6-2.3 2-1.2.8-2.2 2.3.2z" /><path d="M5 8.2l2 2 4-4.2" fill="none" /></svg></span>;
}
