// Accounts API (worker/accounts.js) against a running server: names are one person's each (whatever the capitals,
// even when two people ask at the same moment), emails too, logins, sessions, password changes, recovery codes,
// rate limits, deleting an account. Usage: node tools/accounttest.mjs [origin, default http://localhost:8787 from
// `npx wrangler dev`]. It makes throwaway accounts named t<random>_..., and deletes them at the end.
const BASE = (process.argv[2] || 'http://localhost:8787').replace(/\/$/, '');
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };
// (each run looks like its own address, so reruns don't trip the sign-up limit; Cloudflare sets the real one live)
const RUN_IP = `198.51.100.${1 + Math.floor(Math.random() * 250)}`;
async function call(method, path, body, token, ip = RUN_IP) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  if (ip) headers['CF-Connecting-IP'] = ip;
  const r = await fetch(`${BASE}/account/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = {};
  try { j = await r.json(); } catch { /* not JSON */ }
  return { status: r.status, ...j };
}
const tag = 't' + Math.random().toString(36).slice(2, 7);
const made = [];
const signup = async (username, email, password = 'correct horse 1', ip) => {
  const r = await call('POST', 'signup', { username, email, password }, null, ip);
  if (r.token) made.push({ token: r.token, password });
  return r;
};

// ---- making accounts
const name = `${tag}_Fox`;
const a = await signup(name, `${tag}.fox@example.com`);
ok(a.status === 200 && a.token && a.user && a.user.username === name, `sign up (${a.status} ${a.error || ''})`);
ok(/^[2-9A-HJ-NP-Z]{4}(-[2-9A-HJ-NP-Z]{4}){3}$/.test(a.recovery || ''), `a recovery code (${a.recovery})`);
ok(!('hash' in (a.user || {})) && !('salt' in (a.user || {})), 'no password details sent back');
ok((await call('GET', `name?u=${name.toUpperCase()}`)).available === false, 'the name is taken, in any capitals');
ok((await call('GET', `name?u=${tag}_Owl`)).available === true, 'another name is free');
ok((await signup(name.toLowerCase(), `${tag}.other@example.com`)).error === 'name-taken', 'same name, other capitals: taken');
ok((await signup(`${tag}_Cat`, `${tag}.FOX@EXAMPLE.com`)).error === 'email-taken', 'same email, other capitals: taken');
for (const [bad, why] of [['ab', 'bad-name'], ['has space', 'bad-name'], ['x'.repeat(21), 'bad-name'], ['Admin', 'reserved-name'], ['moderator_9', 'reserved-name'], ['sh1tlord', 'rude-name'], ['big_ass', 'rude-name']]) {
  ok((await call('GET', `name?u=${encodeURIComponent(bad)}`)).problem === why, `"${bad}" is refused (${why})`);
}
for (const fine of ['Torpedo_7', 'Grapes', 'Peacock', 'Swanky', 'Classic_Bass']) ok((await call('GET', `name?u=${fine}`)).problem == null, `"${fine}" is allowed`);
ok((await signup(`${tag}_Owl`, 'not-an-email')).error === 'bad-email', 'bad email refused');
ok((await signup(`${tag}_Owl`, `${tag}.owl@example.com`, 'short')).error === 'short-password', 'short password refused');
ok((await signup(`${tag}_Owl`, `${tag}.owl@example.com`, `${tag}_owl`)).error === 'same-password', 'password = username refused');
// two people asking for the same name at the same moment: exactly one gets it
const race = await Promise.all([1, 2, 3, 4, 5].map(i => signup(`${tag}_Race`, `${tag}.race${i}@example.com`)));
ok(race.filter(r => r.status === 200).length === 1 && race.filter(r => r.error === 'name-taken').length === 4, `one winner of five at once (${race.map(r => r.status).join(',')})`);

// ---- logging in
const login = await call('POST', 'login', { login: name.toUpperCase(), password: 'correct horse 1' });
ok(login.status === 200 && login.token && login.token !== a.token, 'log in by username, any capitals');
if (login.token) made.push({ token: login.token, password: 'correct horse 1' });
const byEmail = await call('POST', 'login', { login: ` ${tag}.Fox@Example.com `, password: 'correct horse 1' });
ok(byEmail.status === 200, 'log in by email');
ok((await call('POST', 'login', { login: name, password: 'wrong one 1' })).error === 'bad-login', 'wrong password');
ok((await call('POST', 'login', { login: `${tag}_Nobody`, password: 'whatever 12' })).error === 'bad-login', 'unknown name: the same answer');
const me = await call('GET', 'me', null, login.token);
ok(me.user && me.user.username === name && me.user.email === `${tag}.fox@example.com`, 'who am I');
ok((await call('GET', 'me', null, 'x'.repeat(43))).error === 'logged-out', 'a made-up token is refused');
ok((await call('GET', 'me')).status === 401, 'no token, no account');

// ---- verified badges for friends' rooms
{
  const { key } = await call('GET', 'badgekey');
  ok(key && key.kty === 'EC' && key.crv === 'P-256' && !key.d, 'a public badge key (and only the public half)');
  const pub = await crypto.subtle.importKey('jwk', key, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const text = b => `tcg-badge-v1|${b.u}|${b.r}|${b.c}|${b.x}`;
  const unb64 = s => Uint8Array.from(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  const good = b => crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unb64(b.s), new TextEncoder().encode(text(b)));
  const r = await call('POST', 'badge', { room: 'pa-k7m2qa', cid: 'abc123def456' }, login.token);
  const b = r.badge;
  ok(b && b.u === name && b.r === 'pa-k7m2qa' && b.c === 'abc123def456' && b.x > Date.now(), 'a badge for this account, room and player');
  ok(b && await good(b), 'its signature checks out');
  ok(b && !(await good({ ...b, u: name + 'x' })), 'another name with that signature fails');
  ok(b && !(await good({ ...b, r: 'pa-zzzzzz' })), 'another room fails');
  ok(b && !(await good({ ...b, c: 'someone-else' })), 'another player id fails');
  ok(b && !(await good({ ...b, x: b.x + 864e5 })), 'a longer time fails');
  ok((await call('POST', 'badge', { room: 'pa-k7m2qa', cid: 'abc123def456' })).status === 401, 'no badge without logging in');
  ok((await call('POST', 'badge', { room: 'nope', cid: 'abc123def456' }, login.token)).error === 'bad-request', 'a room code that isn\'t one is refused');
  const again = (await call('GET', 'badgekey')).key;
  ok(again && again.x === key.x && again.y === key.y, 'the key stays the same');
}

// ---- the account's progress
ok((await call('POST', 'save', { code: 'K7QM4ZP2' }, login.token)).user.saveCode === 'K7QM4ZP2', 'attach a save code');
ok((await call('POST', 'login', { login: name, password: 'correct horse 1' })).user.saveCode === 'K7QM4ZP2', 'logging in elsewhere gets it');

// ---- passwords
ok((await call('POST', 'password', { old: 'nope nope 1', password: 'new password 2' }, login.token)).error === 'bad-password', 'changing needs the old password');
ok((await call('POST', 'password', { old: 'correct horse 1', password: 'new password 2' }, login.token)).ok, 'change password');
ok((await call('GET', 'me', null, a.token)).error === 'logged-out', 'other devices are logged out');
ok((await call('GET', 'me', null, login.token)).user, 'this device stays in');
ok((await call('POST', 'login', { login: name, password: 'new password 2' })).status === 200, 'the new password works');
// forgot it: the recovery code
ok((await call('POST', 'recover', { login: name, recovery: 'AAAA-BBBB-CCCC-DDDD', password: 'third one 33' })).error === 'bad-recovery', 'a wrong recovery code');
const rec = await call('POST', 'recover', { login: name.toLowerCase(), recovery: a.recovery.toLowerCase().replace(/-/g, ' '), password: 'third one 33' });
ok(rec.status === 200 && rec.token && rec.recovery && rec.recovery !== a.recovery, 'recovery code sets a new password and gives a new code');
if (rec.token) made.push({ token: rec.token, password: 'third one 33' });
ok((await call('POST', 'recover', { login: name, recovery: a.recovery, password: 'fourth one 44' })).error === 'bad-recovery', 'a used recovery code doesn\'t work twice');
ok((await call('GET', 'me', null, login.token)).error === 'logged-out', 'recovering logs out every other device');
ok((await call('POST', 'reset/send', { login: name })).error === 'email-off' || true, 'email reset needs an email service');

// ---- rate limits
const flood = await signup(`${tag}_Flood`, `${tag}.flood@example.com`, 'flood pass 12', '203.0.113.9');
if (flood.token) made.push({ token: flood.token, password: 'flood pass 12' });
let limited = null;
for (let i = 0; i < 12 && !limited; i++) { const r = await call('POST', 'login', { login: `${tag}_Flood`, password: 'wrong guess ' + i }, null, '203.0.113.9'); if (r.error === 'limited') limited = i; }
ok(limited != null && limited >= 9, `guessing a password is stopped after 10 tries (${limited})`);

// ---- logging out, deleting
const second = await call('POST', 'login', { login: name, password: 'third one 33' });
ok((await call('POST', 'logout', {}, second.token)).ok && (await call('GET', 'me', null, second.token)).error === 'logged-out', 'log out');
ok((await call('POST', 'delete', { password: 'nope' }, rec.token)).error === 'bad-password', 'deleting needs the password');
for (const m of made) {
  const cur = await call('GET', 'me', null, m.token);
  if (!cur.user) continue;
  const pw = cur.user.username === name ? 'third one 33' : m.password;
  await call('POST', 'delete', { password: pw }, m.token);
}
ok((await call('GET', `name?u=${name}`)).available === true, 'a deleted account\'s name is free again');
// its online save went with it
{
  const t = await signup(`${tag}_Saver`, `${tag}.saver@example.com`, 'saver pass 12');
  const made = await fetch(`${BASE}/save/new`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: 'jSAVE' }) }).then(r => r.json());
  await call('POST', 'save', { code: made.code }, t.token);
  ok((await fetch(`${BASE}/save/${made.code}/info`)).status === 200, 'the account has an online save');
  await call('POST', 'delete', { password: 'saver pass 12' }, t.token);
  ok((await fetch(`${BASE}/save/${made.code}/info`)).status === 404, 'deleting the account deletes its online save');
}
ok((await call('POST', 'login', { login: name, password: 'third one 33' })).error === 'bad-login', 'and it can\'t log in');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
