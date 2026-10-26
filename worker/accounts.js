// Accounts: make one with a username and an email, then log in with either (and a password) on any device.
// One Durable Object (SQLite) holds every account, so each username can only ever belong to one person, whatever
// its capitals (K7Fox and k7fox are the same name), and each email to one account (UNIQUE columns).
//
// Passwords are kept as PBKDF2-SHA256 hashes (100,000 rounds, the most Workers allow, with a salt per account).
// A login gets a random session token the browser keeps; only the token's SHA-256 is stored here, so a copy of
// this database logs nobody in. Every account gets a recovery code when it's made (a spare key for setting a new
// password). Attempts are rate limited. An account's progress is its save code (worker/index.js SaveSlot): logging
// in on another device brings it there.
//
// Email codes (with RESEND_API_KEY set, see README): 6-digit codes, good for 20 minutes and 5 guesses, kept only as
// hashes. Making an account needs the code sent to its email, so nobody can take someone else's address; an email
// that already has an account gets a note saying so instead (the page shows the same thing either way, so it can't
// be used to find out who plays here). Codes also reset passwords, move an account to a new email, and, for
// accounts that turn on login codes, let a new device in: a correct password on a browser this account hasn't
// confirmed before also needs the code from the email.
//
// Verified badges in friends' rooms: a logged-in player gets a badge signed by this server (ECDSA P-256, a key made
// here the first time and never sent out) that says "this account, in this room, as this player id, until then".
// Everyone else's browser checks the signature with the public key (GET /account/badgekey), so a typed name never
// shows the badge, and a copied badge fails anywhere else (another room, another player id, after it runs out).
import { DurableObject } from 'cloudflare:workers';

const ROUNDS = 100_000;
const BADGE_HOURS = 24;
// what a badge signs (the page checks the same string: src/ui/badge.jsx)
export const badgeText = (u, room, cid, x) => `tcg-badge-v1|${u}|${room}|${cid}|${x}`;
const SESSION_DAYS = 180;
const MAX_SESSIONS = 20;
const CODE_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_MINUTES = 20;
const DEVICE_DAYS = 180;
export const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const fail = (error, status = 400, extra = {}) => json({ error, ...extra }, status);

// ---- the rules for names, emails and passwords (the page checks the same ones as you type)
export const USERNAME = /^[A-Za-z0-9_]{3,20}$/;
const RESERVED = new Set(['admin', 'administrator', 'mod', 'moderator', 'staff', 'support', 'help', 'system', 'official', 'owner', 'root', 'null', 'undefined', 'anonymous', 'guest', 'you', 'me', 'everyone', 'server', 'host', 'computer', 'ai', 'bot', 'claude', 'anthropic', 'wizards', 'pokemon', 'bandai']);
// words a name can't contain (anywhere) or be made of (as a whole part between _ and digits)
// (the short ones only as whole parts, so Torpedo, Grapes, Peacock and Swanky are fine)
const RUDE_ANYWHERE = ['fuck', 'shit', 'bitch', 'cunt', 'nigg', 'faggot', 'porn', 'nazi', 'hitler', 'whore', 'slut', 'pussy', 'penis', 'vagina', 'dildo', 'jizz', 'twat', 'retard', 'molest', 'kkk'];
const RUDE_WHOLE = new Set(['cum', 'anal', 'sex', 'sexy', 'tits', 'titty', 'dick', 'cock', 'ass', 'arse', 'piss', 'boob', 'boobs', 'nude', 'nudes', 'kys', 'rape', 'rapist', 'pedo', 'fag', 'fags', 'wank', 'wanker']);
function rude(name) {
  const plain = name.toLowerCase().replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't').replace(/8/g, 'b');
  const joined = plain.replace(/_/g, '');
  if (RUDE_ANYWHERE.some(w => joined.includes(w))) return true;
  return name.toLowerCase().split(/[_0-9]+/).some(w => RUDE_WHOLE.has(w));
}
export function nameProblem(name) {
  if (typeof name !== 'string' || !USERNAME.test(name)) return 'bad-name';
  const lc = name.toLowerCase();
  if (RESERVED.has(lc) || /^(admin|mod_|moderator|staff|official)/.test(lc)) return 'reserved-name';
  if (rude(name)) return 'rude-name';
  return null;
}
const EMAIL = /^[^\s@<>()",;:]{1,64}@[^\s@<>()",;:]{1,185}\.[A-Za-z]{2,24}$/;
const emailOk = e => typeof e === 'string' && e.length <= 254 && EMAIL.test(e);
const passwordProblem = (p, name, email) => (typeof p !== 'string' || p.length < 8 ? 'short-password' : p.length > 200 ? 'long-password' : [name, email].some(x => x && p.toLowerCase() === String(x).toLowerCase()) ? 'same-password' : null);

// ---- crypto helpers
const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const fromHex = h => new Uint8Array(h.match(/../g).map(x => parseInt(x, 16)));
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256 = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations: ROUNDS }, key, 256));
}
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const randomCode = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => CODE_CHARS[b & 31]).join('');
// a recovery code: 16 characters shown as four groups (80 random bits)
const newRecovery = () => randomCode(16).replace(/(.{4})(?=.)/g, '$1-');
const normRecovery = s => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
const digits6 = () => String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
const DEVICE = /^[A-Za-z0-9_-]{16,64}$/;

// ---- the emails: a short letter, as plain text and as a page with the logo
const SITE = 'https://lotusgoats.com';
const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const masked = email => { const [a, d] = String(email).split('@'); return `${a.slice(0, 1)}•••@${d}`; };
const PURPOSE = {
  signup: 'finish making your Lotus Goats account',
  verify: 'confirm your email for Lotus Goats',
  reset: 'set a new password on your Lotus Goats account',
  login: 'log in to your Lotus Goats account on a new device',
  email: 'move your Lotus Goats account to this email',
};
const SAFETY = 'Never give this code to anyone, even a friend in a game room. Lotus Goats will never ask you for it.';
function letter({ name, lines, code, foot }) {
  const text = [`Hi ${name},`, '', ...lines.flatMap(l => [l, '']), ...(code ? [`    ${code}`, '', `It works for ${CODE_MINUTES} minutes. ${SAFETY}`, ''] : []), foot, '', `Lotus Goats · ${SITE}`].join('\n');
  const p = t => `<p style="margin:0 0 14px;font-size:16px;line-height:1.5;color:#2b2f45">${esc(t)}</p>`;
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#eef0f7">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef0f7;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:14px;overflow:hidden;font-family:Helvetica,Arial,sans-serif">
<tr><td style="background:#09132b;padding:18px 24px"><img src="${SITE}/img/icon-192.png" width="40" height="40" alt="" style="vertical-align:middle;border-radius:10px"> <span style="vertical-align:middle;font-size:20px;font-weight:bold;color:#f3d488;letter-spacing:1px;padding-left:8px">Lotus Goats</span></td></tr>
<tr><td style="padding:24px">
${p(`Hi ${name},`)}${lines.map(p).join('')}
${code ? `<div style="margin:6px 0 18px;padding:16px;border-radius:10px;background:#f4f0ff;text-align:center;font:bold 34px/1 Menlo,Consolas,monospace;letter-spacing:8px;color:#3a1f8f">${esc(code)}</div>
<p style="margin:0 0 14px;font-size:14px;line-height:1.5;color:#5b6078">It works for ${CODE_MINUTES} minutes. <b>${esc(SAFETY)}</b></p>` : ''}
<p style="margin:0;font-size:14px;line-height:1.5;color:#5b6078">${esc(foot)}</p>
</td></tr>
<tr><td style="padding:14px 24px;background:#f6f7fb;font-size:12px;color:#8a8fa6"><a href="${SITE}" style="color:#6b4fd8">lotusgoats.com</a> · free card battles in your browser</td></tr>
</table></td></tr></table></body></html>`;
  return { text, html };
}
const NOTICE = {
  exists: u => ({ subject: 'You already have a Lotus Goats account', lines: [`Someone (hopefully you) tried to make a new Lotus Goats account with this email, but it already has one: your username is ${u.name}.`, 'To get back in, choose “Log in”, then “Forgot your password?”.'], foot: 'If it wasn’t you, you can ignore this email. Nothing has changed.' }),
  'email-changed': (u, x) => ({ subject: 'Your Lotus Goats email was changed', lines: [`The email on your Lotus Goats account (${u.name}) was just changed to ${x.to}.`], foot: 'If you didn’t do this, use your recovery code (“Log in”, then “Forgot your password?”) to set a new password, then change the email back.' }),
  'twostep-off': u => ({ subject: 'Login codes are off on your Lotus Goats account', lines: [`Login codes were just turned off on your Lotus Goats account (${u.name}). New devices can now log in with just the password.`], foot: 'If you didn’t do this, change your password straight away.' }),
};

// ---- the Worker side: every /account/ request goes to the one Accounts object
export function accountRequest(req, env) {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  return env.ACCOUNTS.get(env.ACCOUNTS.idFromName('accounts')).fetch(req);
}

export class Accounts extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, name_lc TEXT NOT NULL UNIQUE, email TEXT NOT NULL, email_lc TEXT NOT NULL UNIQUE,
        salt TEXT NOT NULL, hash TEXT NOT NULL, recovery TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0, save_code TEXT,
        created INTEGER NOT NULL, changed INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user TEXT NOT NULL, created INTEGER NOT NULL, seen INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user);
      CREATE TABLE IF NOT EXISTS codes (user TEXT NOT NULL, kind TEXT NOT NULL, hash TEXT NOT NULL, expires INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user, kind));
      CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, n INTEGER NOT NULL, until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (user TEXT NOT NULL, dev TEXT NOT NULL, seen INTEGER NOT NULL, PRIMARY KEY (user, dev));`);
    // (added later: accounts made before have login codes off)
    if (!this.sql.exec('PRAGMA table_info(users)').toArray().some(c => c.name === 'twostep')) this.sql.exec('ALTER TABLE users ADD COLUMN twostep INTEGER NOT NULL DEFAULT 0');
    this.calls = 0;
  }

  // the badge signing key, made the first time it's needed and kept in this object's storage
  badgeKey() {
    if (!this.keyP) this.keyP = (async () => {
      let k = await this.ctx.storage.get('badgekey');
      if (!k) {
        const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
        k = { pub: await crypto.subtle.exportKey('jwk', pair.publicKey), priv: await crypto.subtle.exportKey('jwk', pair.privateKey) };
        await this.ctx.storage.put('badgekey', k);
      }
      const { kty, crv, x, y } = k.pub;
      return { pub: { kty, crv, x, y }, sign: await crypto.subtle.importKey('jwk', k.priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) };
    })().catch(e => { this.keyP = null; throw e; });
    return this.keyP;
  }

  one(q, ...args) { return this.sql.exec(q, ...args).toArray()[0] || null; }
  run(q, ...args) { this.sql.exec(q, ...args); }
  mailOn() { return !!this.env.RESEND_API_KEY; }

  // at most `max` tries per `ms` for a key (a login name, an address); true when that's used up
  limited(key, max, ms) {
    const now = Date.now();
    const r = this.one('SELECT n, until FROM limits WHERE key = ?', key);
    if (r && r.until > now) {
      if (r.n >= max) return true;
      this.run('UPDATE limits SET n = n + 1 WHERE key = ?', key);
      return false;
    }
    this.run('INSERT OR REPLACE INTO limits (key, n, until) VALUES (?, 1, ?)', key, now + ms);
    return false;
  }
  tidy() {
    const now = Date.now();
    this.run('DELETE FROM limits WHERE until < ?', now);
    this.run('DELETE FROM sessions WHERE seen < ?', now - SESSION_DAYS * 864e5);
    this.run('DELETE FROM codes WHERE expires < ?', now);
    this.run('DELETE FROM devices WHERE seen < ?', now - DEVICE_DAYS * 864e5);
  }

  view(u) {
    return { id: u.id, username: u.name, email: u.email, verified: !!u.verified, twostep: !!u.twostep, saveCode: u.save_code || null, created: u.created, emailOn: this.mailOn() };
  }
  async newSession(userId) {
    const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const now = Date.now();
    this.run('INSERT INTO sessions (token, user, created, seen) VALUES (?, ?, ?, ?)', await sha256(token), userId, now, now);
    // a long-forgotten device's sessions make room for new ones
    const old = this.sql.exec('SELECT token FROM sessions WHERE user = ? ORDER BY seen DESC LIMIT -1 OFFSET ?', userId, MAX_SESSIONS).toArray();
    for (const s of old) this.run('DELETE FROM sessions WHERE token = ?', s.token);
    return token;
  }
  // the account a request is logged in as: { user, token hash } or null
  async auth(req) {
    const m = /^Bearer ([A-Za-z0-9_-]{20,80})$/.exec(req.headers.get('Authorization') || '');
    if (!m) return null;
    const th = await sha256(m[1]);
    const s = this.one('SELECT * FROM sessions WHERE token = ?', th);
    if (!s) return null;
    const now = Date.now();
    if (s.seen < now - SESSION_DAYS * 864e5) { this.run('DELETE FROM sessions WHERE token = ?', th); return null; }
    const u = this.one('SELECT * FROM users WHERE id = ?', s.user);
    if (!u) { this.run('DELETE FROM sessions WHERE token = ?', th); return null; }
    if (s.seen < now - 864e5) this.run('UPDATE sessions SET seen = ? WHERE token = ?', now, th);
    return { user: u, th };
  }
  byLogin(login) {
    const l = String(login || '').trim().toLowerCase();
    if (!l || l.length > 254) return null;
    return this.one(l.includes('@') ? 'SELECT * FROM users WHERE email_lc = ?' : 'SELECT * FROM users WHERE name_lc = ?', l);
  }
  // devices that confirmed a login code (only their hashes)
  async devHash(id) { return typeof id === 'string' && DEVICE.test(id) ? sha256('dev:' + id) : null; }
  trusted(userId, dev) { return !!dev && !!this.one('SELECT 1 AS x FROM devices WHERE user = ? AND dev = ?', userId, dev); }
  trust(userId, dev) {
    if (!dev) return;
    this.run('INSERT OR REPLACE INTO devices (user, dev, seen) VALUES (?, ?, ?)', userId, dev, Date.now());
    const old = this.sql.exec('SELECT dev FROM devices WHERE user = ? ORDER BY seen DESC LIMIT -1 OFFSET 20', userId).toArray();
    for (const d of old) this.run('DELETE FROM devices WHERE user = ? AND dev = ?', userId, d.dev);
  }
  async setPassword(userId, password) {
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    this.run('UPDATE users SET salt = ?, hash = ?, changed = ? WHERE id = ?', salt, await hashPassword(password, salt), Date.now(), userId);
  }

  async sendMail(to, subject, { text, html }) {
    if (!this.mailOn()) return false;
    try {
      const r = await fetch(this.env.MAIL_API || 'https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: this.env.MAIL_FROM || 'Lotus Goats <codes@lotusgoats.com>', to: [to], subject, text, html }),
      });
      return r.ok;
    } catch { return false; }
  }
  // a code to `t.email` (t: an account, or { id, name, email } for one being made); `bind` ties it to one more thing
  // (the new email it moves to, the device it lets in), so it works for nothing else
  async mailCode(t, kind, bind = '') {
    const code = digits6();
    this.run('INSERT OR REPLACE INTO codes (user, kind, hash, expires, tries) VALUES (?, ?, ?, ?, 0)', t.id, kind, await sha256(`${t.id}:${kind}:${bind}:${code}`), Date.now() + CODE_MINUTES * 60e3);
    return this.sendMail(t.email, `Your Lotus Goats code: ${code}`, letter({ name: t.name, code, lines: [`Here’s your code to ${PURPOSE[kind]}:`], foot: 'If you didn’t ask for it, you can ignore this email. Without the code nothing happens.' }));
  }
  async checkCode(t, kind, code, bind = '') {
    const c = this.one('SELECT * FROM codes WHERE user = ? AND kind = ?', t.id, kind);
    if (!c || c.expires < Date.now() || c.tries >= 5) return false;
    if (!same(c.hash, await sha256(`${t.id}:${kind}:${bind}:${String(code || '').replace(/\D/g, '')}`))) {
      this.run('UPDATE codes SET tries = tries + 1 WHERE user = ? AND kind = ?', t.id, kind);
      return false;
    }
    this.run('DELETE FROM codes WHERE user = ? AND kind = ?', t.id, kind);
    return true;
  }
  sendNotice(u, kind, extra = {}) {
    const n = NOTICE[kind](u, extra);
    return this.sendMail(u.email, n.subject, letter({ name: u.name, lines: n.lines, foot: n.foot }));
  }
  passwordOk(u, password) { return hashPassword(String(password || ''), u.salt).then(h => same(h, u.hash)); }
  fresh(id) { return this.view(this.one('SELECT * FROM users WHERE id = ?', id)); }

  async fetch(req) {
    if (++this.calls % 100 === 1) this.tidy();
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/account\/?/, '');
    const ip = req.headers.get('CF-Connecting-IP') || 'local';
    let body = {};
    if (req.method === 'POST') {
      try { body = JSON.parse((await req.text()) || '{}') || {}; } catch { return fail('bad-request'); }
      if (typeof body !== 'object') return fail('bad-request');
    }
    try {
      return await this.route(req, path, body, ip, url);
    } catch (e) {
      if (/UNIQUE constraint failed: users\.name_lc/.test(String(e))) return fail('name-taken', 409);
      if (/UNIQUE constraint failed: users\.email_lc/.test(String(e))) return fail('email-taken', 409);
      return fail('server', 500);
    }
  }

  async route(req, path, body, ip, url) {
    const now = Date.now();
    switch (`${req.method} ${path}`) {
      // what this site's accounts can do (whether codes can be sent by email)
      case 'GET config': return json({ emailOn: this.mailOn() });
      // the public half of the badge key, for checking badges
      case 'GET badgekey': return json({ key: (await this.badgeKey()).pub });
      // is a username free? (for the sign-up form, as you type)
      case 'GET name': {
        if (this.limited('name:' + ip, 300, 60e3)) return fail('limited', 429);
        const name = url.searchParams.get('u') || '';
        const problem = nameProblem(name);
        if (problem) return json({ available: false, problem });
        return json({ available: !this.one('SELECT 1 AS x FROM users WHERE name_lc = ?', name.toLowerCase()) });
      }
      // making an account, step one: the details are checked and, with email codes on, a code goes to the email
      // (or, when that email already has an account, a note saying so: the answer here is the same either way)
      case 'POST signup/start': {
        const { username, email, password } = body;
        const problem = nameProblem(username) || (!emailOk(email) ? 'bad-email' : null) || passwordProblem(password, username, email);
        if (problem) return fail(problem);
        if (this.one('SELECT 1 AS x FROM users WHERE name_lc = ?', username.toLowerCase())) return fail('name-taken', 409);
        const lc = email.trim().toLowerCase();
        if (!this.mailOn()) return this.one('SELECT 1 AS x FROM users WHERE email_lc = ?', lc) ? fail('email-taken', 409) : json({ ok: true, code: false });
        if (this.limited('signupstart:' + ip, 30, 3600e3) || this.limited('mailto:' + lc, 4, 3600e3)) return fail('limited', 429);
        const owner = this.one('SELECT * FROM users WHERE email_lc = ?', lc);
        if (owner) { await this.sendNotice(owner, 'exists'); return json({ ok: true, code: true }); }
        return (await this.mailCode({ id: 'signup:' + lc, name: username, email: email.trim() }, 'signup')) ? json({ ok: true, code: true }) : fail('email-failed', 502);
      }
      // step two: the account is made (with email codes on, only with the code from step one)
      case 'POST signup': {
        const { username, email, password } = body;
        const problem = nameProblem(username) || (!emailOk(email) ? 'bad-email' : null) || passwordProblem(password, username, email);
        if (problem) return fail(problem);
        // (a school shares one address: enough for a class signing up together, not for a flood)
        if (this.limited('signup:' + ip, 40, 3600e3)) return fail('limited', 429);
        if (this.one('SELECT 1 AS x FROM users WHERE name_lc = ?', username.toLowerCase())) return fail('name-taken', 409);
        const lc = email.trim().toLowerCase();
        if (this.mailOn()) {
          if (!body.code) return fail('code-needed');
          if (!(await this.checkCode({ id: 'signup:' + lc }, 'signup', body.code))) return fail('bad-code', 401);
        }
        if (this.one('SELECT 1 AS x FROM users WHERE email_lc = ?', lc)) return fail('email-taken', 409);
        const id = 'u' + randomCode(12).toLowerCase();
        const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
        const recovery = newRecovery();
        const hash = await hashPassword(password, salt);
        // (the UNIQUE columns settle two people asking for the same name at the same moment: see fetch)
        this.run('INSERT INTO users (id, name, name_lc, email, email_lc, salt, hash, recovery, verified, save_code, created, changed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)',
          id, username, username.toLowerCase(), email.trim(), lc, salt, hash, await sha256(normRecovery(recovery)), this.mailOn() ? 1 : 0, now, now);
        return json({ token: await this.newSession(id), user: this.fresh(id), recovery });
      }
      case 'POST login': {
        const login = String(body.login || '').trim().toLowerCase();
        if (!login || typeof body.password !== 'string') return fail('bad-login', 401);
        if (this.limited('login:' + login, 10, 15 * 60e3) || this.limited('loginip:' + ip, 60, 15 * 60e3)) return fail('limited', 429);
        const u = this.byLogin(login);
        // (the same work whether or not the account exists, so the answer's timing says nothing)
        const hash = await hashPassword(body.password, u ? u.salt : '00000000000000000000000000000000');
        if (!u || !same(hash, u.hash)) return fail('bad-login', 401);
        // login codes: a device this account hasn't let in before also needs the code from the email
        if (u.twostep && this.mailOn()) {
          const dev = await this.devHash(body.device);
          if (!this.trusted(u.id, dev)) {
            if (!body.code) {
              if (this.limited('loginsend:' + u.id, 6, 3600e3)) return fail('limited', 429);
              if (!(await this.mailCode(u, 'login', dev || ''))) return fail('email-failed', 502);
              return fail('code-needed', 401, { to: masked(u.email) });
            }
            if (!(await this.checkCode(u, 'login', body.code, dev || ''))) return fail('bad-code', 401, { to: masked(u.email) });
          }
          this.trust(u.id, dev);
        }
        return json({ token: await this.newSession(u.id), user: this.view(u) });
      }
      // a new password with the recovery code (which is used up: a new one comes back)
      case 'POST recover': {
        const login = String(body.login || '').trim().toLowerCase();
        if (this.limited('recover:' + login, 6, 3600e3) || this.limited('recoverip:' + ip, 30, 3600e3)) return fail('limited', 429);
        const u = this.byLogin(login);
        if (!u || !same(u.recovery, await sha256(normRecovery(body.recovery)))) return fail('bad-recovery', 401);
        const problem = passwordProblem(body.password, u.name, u.email);
        if (problem) return fail(problem);
        await this.setPassword(u.id, body.password);
        const recovery = newRecovery();
        this.run('UPDATE users SET recovery = ? WHERE id = ?', await sha256(normRecovery(recovery)), u.id);
        this.run('DELETE FROM sessions WHERE user = ?', u.id);
        if (u.twostep) this.trust(u.id, await this.devHash(body.device));   // (the recovery code is a key of its own)
        return json({ token: await this.newSession(u.id), user: this.fresh(u.id), recovery });
      }
      // a password-reset code by email (always "sent", so it can't be used to find out who has an account)
      case 'POST reset/send': {
        if (!this.mailOn()) return fail('email-off', 501);
        const login = String(body.login || '').trim().toLowerCase();
        if (this.limited('resetsend:' + login, 4, 3600e3) || this.limited('resetsendip:' + ip, 20, 3600e3)) return fail('limited', 429);
        const u = this.byLogin(login);
        if (u) await this.mailCode(u, 'reset');
        return json({ ok: true });
      }
      case 'POST reset': {
        const login = String(body.login || '').trim().toLowerCase();
        if (this.limited('reset:' + login, 8, 3600e3)) return fail('limited', 429);
        const u = this.byLogin(login);
        if (!u || !(await this.checkCode(u, 'reset', body.code))) return fail('bad-code', 401);
        const problem = passwordProblem(body.password, u.name, u.email);
        if (problem) return fail(problem);
        await this.setPassword(u.id, body.password);
        this.run('UPDATE users SET verified = 1 WHERE id = ?', u.id);   // (the code came to that email)
        this.run('DELETE FROM sessions WHERE user = ?', u.id);
        if (u.twostep) this.trust(u.id, await this.devHash(body.device));
        return json({ token: await this.newSession(u.id), user: this.fresh(u.id) });
      }
    }
    // everything else needs a login
    const a = await this.auth(req);
    if (!a) return fail('logged-out', 401);
    const u = a.user;
    switch (`${req.method} ${path}`) {
      case 'GET me': return json({ user: this.view(u) });
      // a verified badge for one room and one player id in it (the name in it is always this account's own)
      case 'POST badge': {
        const room = String(body.room || ''), cid = String(body.cid || '');
        if (!/^(pa|pk|op)-[a-z0-9]{6}$/.test(room) || !/^[A-Za-z0-9_-]{4,40}$/.test(cid)) return fail('bad-request');
        if (this.limited('badge:' + u.id, 120, 3600e3)) return fail('limited', 429);
        const x = now + BADGE_HOURS * 3600e3;
        const key = await this.badgeKey();
        const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.sign, enc.encode(badgeText(u.name, room, cid, x)));
        return json({ badge: { u: u.name, r: room, c: cid, x, s: b64url(new Uint8Array(sig)) } });
      }
      case 'POST logout': {
        if (body.everywhere) this.run('DELETE FROM sessions WHERE user = ?', u.id);
        else this.run('DELETE FROM sessions WHERE token = ?', a.th);
        return json({ ok: true });
      }
      // the account's progress: the save code its devices save to
      case 'POST save': {
        const code = String(body.code || '').toUpperCase();
        if (!/^[2-9A-HJ-NP-Z]{8}$/.test(code)) return fail('bad-code');
        this.run('UPDATE users SET save_code = ? WHERE id = ?', code, u.id);
        return json({ user: this.fresh(u.id) });
      }
      case 'POST password': {
        if (this.limited('password:' + u.id, 10, 3600e3)) return fail('limited', 429);
        if (!(await this.passwordOk(u, body.old))) return fail('bad-password', 401);
        const problem = passwordProblem(body.password, u.name, u.email);
        if (problem) return fail(problem);
        await this.setPassword(u.id, body.password);
        // other devices log in again with the new password
        this.run('DELETE FROM sessions WHERE user = ? AND token != ?', u.id, a.th);
        return json({ ok: true });
      }
      case 'POST verify/send': {
        if (!this.mailOn()) return fail('email-off', 501);
        if (u.verified) return json({ ok: true, user: this.view(u) });
        if (this.limited('verifysend:' + u.id, 4, 3600e3)) return fail('limited', 429);
        return (await this.mailCode(u, 'verify')) ? json({ ok: true }) : fail('email-failed', 502);
      }
      case 'POST verify': {
        if (this.limited('verify:' + u.id, 10, 3600e3)) return fail('limited', 429);
        if (!(await this.checkCode(u, 'verify', body.code))) return fail('bad-code', 401);
        this.run('UPDATE users SET verified = 1 WHERE id = ?', u.id);
        return json({ user: this.fresh(u.id) });
      }
      // login codes on or off (the password either way; on needs a confirmed email, and this device is the first
      // one it lets in; off tells the email, in case it wasn't you)
      case 'POST twostep': {
        if (this.limited('twostep:' + u.id, 10, 3600e3)) return fail('limited', 429);
        if (!(await this.passwordOk(u, body.password))) return fail('bad-password', 401);
        this.run('DELETE FROM devices WHERE user = ?', u.id);
        if (body.on) {
          if (!this.mailOn()) return fail('email-off', 501);
          if (!u.verified) return fail('not-verified');
          this.run('UPDATE users SET twostep = 1 WHERE id = ?', u.id);
          this.trust(u.id, await this.devHash(body.device));
        } else {
          this.run('UPDATE users SET twostep = 0 WHERE id = ?', u.id);
          if (u.twostep && this.mailOn()) await this.sendNotice(u, 'twostep-off');
        }
        return json({ user: this.fresh(u.id) });
      }
      // a new email: the password, then the code sent to the new address (without email codes, straight away and
      // unconfirmed). The old address hears about it.
      case 'POST email/send': {
        if (this.limited('emailsend:' + u.id, 6, 3600e3)) return fail('limited', 429);
        if (!(await this.passwordOk(u, body.password))) return fail('bad-password', 401);
        const email = String(body.email || '').trim(), lc = email.toLowerCase();
        if (!emailOk(email)) return fail('bad-email');
        if (lc === u.email_lc) return fail('same-email');
        if (this.one('SELECT 1 AS x FROM users WHERE email_lc = ?', lc)) return fail('email-taken', 409);
        if (!this.mailOn()) {
          this.run('UPDATE users SET email = ?, email_lc = ?, verified = 0, twostep = 0 WHERE id = ?', email, lc, u.id);
          return json({ user: this.fresh(u.id) });
        }
        if (this.limited('mailto:' + lc, 4, 3600e3)) return fail('limited', 429);
        return (await this.mailCode({ ...u, email }, 'email', lc)) ? json({ ok: true, sent: true }) : fail('email-failed', 502);
      }
      case 'POST email': {
        if (this.limited('email:' + u.id, 10, 3600e3)) return fail('limited', 429);
        const email = String(body.email || '').trim(), lc = email.toLowerCase();
        if (!emailOk(email) || !(await this.checkCode(u, 'email', body.code, lc))) return fail('bad-code', 401);
        this.run('UPDATE users SET email = ?, email_lc = ?, verified = 1 WHERE id = ?', email, lc, u.id);
        if (u.verified) await this.sendNotice(u, 'email-changed', { to: masked(email) });
        return json({ user: this.fresh(u.id) });
      }
      // gone for good: the account, its sessions and codes, and the progress saved for it online (the username and
      // email become free again; progress already on devices stays there)
      case 'POST delete': {
        if (this.limited('delete:' + u.id, 10, 3600e3)) return fail('limited', 429);
        if (!(await this.passwordOk(u, body.password))) return fail('bad-password', 401);
        if (u.save_code && this.env.SAVES) { try { await this.env.SAVES.get(this.env.SAVES.idFromName(u.save_code)).wipe(); } catch { /* it expires anyway */ } }
        this.run('DELETE FROM sessions WHERE user = ?', u.id);
        this.run('DELETE FROM codes WHERE user = ?', u.id);
        this.run('DELETE FROM devices WHERE user = ?', u.id);
        this.run('DELETE FROM users WHERE id = ?', u.id);
        return json({ ok: true });
      }
    }
    return fail('not-found', 404);
  }
}
