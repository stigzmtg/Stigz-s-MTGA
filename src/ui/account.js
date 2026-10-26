// Accounts (worker/accounts.js): make one with a username and an email, then log in on any device. This browser
// keeps the login ('pa-account': a session token and who you are; it's never part of a save). A logged-in device
// saves its progress to the account's save code (savecode.js), so logging in somewhere new brings your record,
// replays, decks and avatar there, and your username becomes your name in friends' rooms.
import { findRelay } from '../net/relayroom.js';
import { safeStorage } from './common.js';
import { savedLink, saveNow, fetchSave, loadCode, subscribeSave, saveStatus, forgetCode, clearProgress } from './savecode.js';
import { setBadgeProvider } from '../net/roomclient.js';

const KEY = 'pa-account';
export const USERNAME = /^[A-Za-z0-9_]{3,20}$/;   // (the server has the full rules: reserved and rude names)

function readLogin() {
  try { const v = JSON.parse(safeStorage.getItem(KEY) || 'null'); return v && typeof v.token === 'string' && v.user && typeof v.user.username === 'string' ? v : null; } catch { return null; }
}
let login = readLogin();
const subs = new Set();
function setLogin(v) {
  login = v;
  try { if (v) localStorage.setItem(KEY, JSON.stringify(v)); else localStorage.removeItem(KEY); } catch { /* storage blocked */ }
  subs.forEach(f => f());
}
// { token, user: { username, email, verified, saveCode, created, emailOn } } or null
export const currentLogin = () => login;
export const subscribeAccount = f => { subs.add(f); return () => subs.delete(f); };

export class AccountError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function accountErrorText(e) {
  switch (e && e.code) {
    case 'offline': return 'Accounts need the website itself (stigz-s-mtga.stigzrblx.workers.dev). Check your connection and try again.';
    case 'name-taken': return 'Someone already has that username. Try another one.';
    case 'email-taken': return 'There’s already an account with that email. Log in instead, or use “Forgot your password?”.';
    case 'bad-name': return 'Usernames are 3 to 20 letters, numbers or _ (no spaces).';
    case 'reserved-name': return 'That username is reserved. Try another one.';
    case 'rude-name': return 'That username isn’t allowed. Try another one.';
    case 'bad-email': return 'That doesn’t look like an email address.';
    case 'short-password': return 'Passwords need at least 8 characters.';
    case 'long-password': return 'That password is too long (200 characters at most).';
    case 'same-password': return 'Your password can’t be your username or your email.';
    case 'bad-login': return 'That username or email and password don’t match.';
    case 'limited': return 'Too many tries for now. Wait a few minutes and try again.';
    case 'bad-recovery': return 'That recovery code doesn’t match this account.';
    case 'bad-code': return 'That code is wrong or has run out. Ask for a new one.';
    case 'bad-password': return 'That password isn’t right.';
    case 'email-off': return 'Codes by email aren’t set up on this site yet. Use your recovery code.';
    case 'email-failed': return 'The email couldn’t be sent just now. Try again in a minute.';
    case 'logged-out': return 'You were logged out. Log in again.';
    default: return 'Something went wrong. Try again in a moment.';
  }
}

async function call(method, path, body, withLogin = true) {
  const origin = await findRelay();
  if (!origin) throw new AccountError('offline');
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (withLogin && login) headers.Authorization = 'Bearer ' + login.token;
  let r;
  try {
    r = await fetch(`${origin}/account/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  } catch { throw new AccountError('offline'); }
  let j = {};
  try { j = await r.json(); } catch { /* not JSON */ }
  if (!r.ok) {
    // the session ended (a password change or "log out everywhere" on another device)
    if (j.error === 'logged-out' && withLogin && login) setLogin(null);
    throw new AccountError(j.error || 'server');
  }
  return j;
}

let config = null;
// what the site's accounts can do: { emailOn }
export function accountConfig() { return config || (config = call('GET', 'config', null, false).catch(e => { config = null; throw e; })); }
export const checkName = name => call('GET', `name?u=${encodeURIComponent(name)}`, null, false);

// ---- in and out
function loggedIn(r) {
  setLogin({ token: r.token, user: r.user });
  safeStorage.setItem('pa-nick', r.user.username);   // your name in friends' rooms
}
export async function signUp({ username, email, password }) {
  const r = await call('POST', 'signup', { username: username.trim(), email: email.trim(), password }, false);
  loggedIn(r);
  const reload = await bringProgress(r.user).catch(() => false);
  return { recovery: r.recovery, user: r.user, reload };
}
export async function logIn({ login: name, password }) {
  const r = await call('POST', 'login', { login: name.trim(), password }, false);
  loggedIn(r);
  return { reload: await bringProgress(r.user).catch(() => false) };
}
export async function recover({ login: name, recovery, password }) {
  const r = await call('POST', 'recover', { login: name.trim(), recovery, password }, false);
  loggedIn(r);
  return { recovery: r.recovery, reload: await bringProgress(r.user).catch(() => false) };
}
export const sendResetCode = name => call('POST', 'reset/send', { login: name.trim() }, false);
export async function resetWithCode({ login: name, code, password }) {
  const r = await call('POST', 'reset', { login: name.trim(), code, password }, false);
  loggedIn(r);
  return { reload: await bringProgress(r.user).catch(() => false) };
}
// out: this device stops saving to the account (on a shared computer, it can also forget your progress)
export async function logOut({ everywhere = false, removeProgress = false } = {}) {
  try { await call('POST', 'logout', { everywhere }); } catch (e) { if (e.code !== 'offline' && e.code !== 'logged-out') throw e; }
  setLogin(null);
  forgetCode();
  if (removeProgress) clearProgress();
}
export const changePassword = (old, password) => call('POST', 'password', { old, password });
export async function deleteAccount(password) {
  await call('POST', 'delete', { password });
  setLogin(null);
  forgetCode();
}
export const sendVerifyCode = () => call('POST', 'verify/send', {});
export async function verifyEmail(code) {
  const r = await call('POST', 'verify', { code });
  setLogin({ ...login, user: r.user });
}

// ---- the account's progress is its save code
// the account's progress comes to this device and this device's joins it; true if the page should reload
async function bringProgress(user) {
  const link = savedLink();
  if (user.saveCode && !(link && link.code === user.saveCode)) {
    try {
      await loadCode(await fetchSave(user.saveCode));
      return true;
    } catch (e) { if (!e || e.code !== 'missing') throw e; /* that save ran out: this device's becomes the account's */ }
  }
  const mine = savedLink() || await saveNow();
  if (mine && mine.code !== user.saveCode) await attach(mine.code);
  else saveNow().catch(() => {});
  return false;
}
async function attach(code) {
  const r = await call('POST', 'save', { code });
  if (login) setLogin({ ...login, user: r.user });
}

// a verified badge for a friends' room (null when logged out or the server can't be reached)
export async function requestBadge(room, cid) {
  if (!login) return null;
  try { return (await call('POST', 'badge', { room, cid })).badge || null; } catch { return null; }
}

// when the site opens: check the login still holds, bring in the account's progress, and keep the account pointing
// at this device's save code if that ever changes (a save unused for over a year starts a fresh code)
export function initAccounts() {
  if (typeof window === 'undefined') return;
  setBadgeProvider(requestBadge);
  if (login) {
    call('GET', 'me').then(r => {
      setLogin({ ...login, user: r.user });
      const link = savedLink();
      if (!link || link.code !== r.user.saveCode) bringProgress(r.user).catch(() => {});
    }, () => { /* offline: try next time; logged out: already cleared */ });
  }
  subscribeSave(() => {
    const link = savedLink();
    if (login && link && saveStatus().state === 'saved' && link.code !== login.user.saveCode && !attaching) {
      attaching = true;
      attach(link.code).catch(() => {}).finally(() => { attaching = false; });
    }
  });
}
let attaching = false;
