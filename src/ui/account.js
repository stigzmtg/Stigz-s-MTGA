// Accounts (worker/accounts.js): make one with a username and an email, then log in on any device. This browser
// keeps the login ('pa-account': a session token and who you are; it's never part of a save). A logged-in device
// saves its progress to the account's save code (savecode.js), so logging in somewhere new brings your record,
// replays, decks and avatar there, and your username becomes your name in friends' rooms. With email codes on, making
// an account takes a code sent to the email, and an account can ask for one whenever a new device logs in: this
// browser's device id ('pa-device', never part of a save) is how the server knows it's been here before.
import { findRelay } from '../net/relayroom.js';
import { safeStorage } from './common.js';
import { savedLink, saveNow, fetchSave, loadCode, subscribeSave, saveStatus, forgetCode, clearProgress } from './savecode.js';
import { setBadgeProvider } from '../net/roomclient.js';

const KEY = 'pa-account';
const DEVICE = 'pa-device';
function deviceId() {
  let d = safeStorage.getItem(DEVICE);
  if (!d || !/^[A-Za-z0-9_-]{16,64}$/.test(d)) {
    d = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18)))).replace(/\+/g, '-').replace(/\//g, '_');
    safeStorage.setItem(DEVICE, d);
  }
  return d;
}
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
  // (`to`: where a code went, as j•••@example.com)
  constructor(code, extra = {}) { super(code); this.code = code; this.to = extra.to || null; }
}
export function accountErrorText(e) {
  switch (e && e.code) {
    case 'offline': return 'Accounts need the website itself (lotusgoats.com). Check your connection and try again.';
    case 'name-taken': return 'Someone already has that username. Try another one.';
    case 'email-taken': return 'There’s already an account with that email. Log in instead, or use “Forgot your password?”.';
    case 'same-email': return 'That’s already your email.';
    case 'not-verified': return 'Confirm your email first, then turn this on.';
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
    case 'bad-code': return 'That code is wrong or has run out. Check the newest email, or ask for a new code.';
    case 'code-needed': return 'Enter the code from the email.';
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
    throw new AccountError(j.error || 'server', j);
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
// step one: the details are checked and, with email codes on, a code goes to the email ({ code: true })
export const startSignUp = ({ username, email, password }) => call('POST', 'signup/start', { username: username.trim(), email: email.trim(), password }, false);
export async function signUp({ username, email, password, code }) {
  const r = await call('POST', 'signup', { username: username.trim(), email: email.trim(), password, code }, false);
  loggedIn(r);
  const reload = await bringProgress(r.user).catch(() => false);
  return { recovery: r.recovery, user: r.user, reload };
}
// (an account with login codes on answers a new device with AccountError 'code-needed': log in again with the code)
export async function logIn({ login: name, password, code }) {
  const r = await call('POST', 'login', { login: name.trim(), password, code: code || undefined, device: deviceId() }, false);
  loggedIn(r);
  return { reload: await bringProgress(r.user).catch(() => false) };
}
export async function recover({ login: name, recovery, password }) {
  const r = await call('POST', 'recover', { login: name.trim(), recovery, password, device: deviceId() }, false);
  loggedIn(r);
  return { recovery: r.recovery, reload: await bringProgress(r.user).catch(() => false) };
}
export const sendResetCode = name => call('POST', 'reset/send', { login: name.trim() }, false);
export async function resetWithCode({ login: name, code, password }) {
  const r = await call('POST', 'reset', { login: name.trim(), code, password, device: deviceId() }, false);
  loggedIn(r);
  return { reload: await bringProgress(r.user).catch(() => false) };
}
// out: this device stops saving to the account (on a shared computer, it can also forget your progress)
export async function logOut({ everywhere = false, removeProgress = false } = {}) {
  try { await call('POST', 'logout', { everywhere }); } catch (e) { if (e.code !== 'offline' && e.code !== 'logged-out') throw e; }
  setLogin(null);
  forgetCode();
  if (removeProgress) { clearProgress(); try { localStorage.removeItem(DEVICE); } catch { /* storage blocked */ } }
}
export const changePassword = (old, password) => call('POST', 'password', { old, password });
export async function deleteAccount(password) {
  await call('POST', 'delete', { password });
  setLogin(null);
  forgetCode();
}
export const sendVerifyCode = () => call('POST', 'verify/send', {});
const updated = r => { if (r.user && login) setLogin({ ...login, user: r.user }); return r; };
export const verifyEmail = code => call('POST', 'verify', { code }).then(updated);
// login codes on or off (this device is the first one let in)
export const setLoginCodes = (on, password) => call('POST', 'twostep', { on, password, device: deviceId() }).then(updated);
// a new email: a code goes there ({ sent: true }), or without email codes it changes at once ({ user })
export const sendEmailChange = (password, email) => call('POST', 'email/send', { password, email: email.trim() }).then(updated);
export const changeEmail = (email, code) => call('POST', 'email', { email: email.trim(), code }).then(updated);

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
