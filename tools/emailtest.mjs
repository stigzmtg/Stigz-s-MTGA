// Email codes (worker/accounts.js) against a local server whose emails land in a mailbox this test keeps, instead of
// Resend: making an account takes the emailed code, an email that already has an account gets a note (and the page
// can't tell the difference), login codes on new devices, a new email, a new password, and what happens when email
// is down. Start the server with the mailbox as its email service, then run the test:
//   npx wrangler dev --port 8787 --var RESEND_API_KEY:test --var MAIL_API:http://127.0.0.1:8799/emails
//   node tools/emailtest.mjs [origin, default http://localhost:8787]
import http from 'node:http';

const BASE = (process.argv[2] || 'http://localhost:8787').replace(/\/$/, '');
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };

// ---- the mailbox
export const mail = [];
let down = false;
const box = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    if (down) { res.writeHead(500); return res.end('{}'); }
    const m = JSON.parse(body || '{}');
    mail.push({ ...m, auth: req.headers.authorization, to: m.to && m.to[0] });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'm' + mail.length }));
  });
});
await new Promise(r => box.listen(8799, '127.0.0.1', r));
const inbox = to => mail.filter(m => m.to && m.to.toLowerCase() === to.toLowerCase());
const last = to => inbox(to).at(-1) || null;
const codeIn = m => (m && /\b(\d{6})\b/.exec(m.text) || [])[1] || null;

const RUN_IP = `198.51.100.${1 + Math.floor(Math.random() * 250)}`;
async function call(method, path, body, token) {
  const headers = { 'CF-Connecting-IP': RUN_IP };
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(`${BASE}/account/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = {};
  try { j = await r.json(); } catch { /* not JSON */ }
  return { status: r.status, ...j };
}
const tag = 'e' + Math.random().toString(36).slice(2, 7);
const tokens = [];
const devA = 'deviceA_' + tag + 'xxxxxxxx', devB = 'deviceB_' + tag + 'xxxxxxxx', devC = 'deviceC_' + tag + 'xxxxxxxx';

ok((await call('GET', 'config')).emailOn === true, 'email codes are on (start the server with RESEND_API_KEY and MAIL_API: see the top of this file)');

// ---- making an account takes the code
const name = `${tag}_Goat`, email = `${tag}.goat@example.com`, password = 'lotus goat 12';
const st = await call('POST', 'signup/start', { username: name, email, password });
ok(st.status === 200 && st.code === true, `step one asks for a code (${st.status} ${st.error || ''})`);
const first = last(email);
ok(first && /Your Lotus Goats code: \d{6}/.test(first.subject) && codeIn(first), `a code arrives (${first && first.subject})`);
ok(first && first.auth === 'Bearer test' && /Lotus Goats <codes@lotusgoats\.com>/.test(first.from), `sent from codes@lotusgoats.com with the key (${first && first.from})`);
ok(first && first.html.includes(codeIn(first)) && first.html.includes('https://lotusgoats.com/img/icon-192.png') && /Never give this code to anyone/.test(first.text), 'the email has the code, the logo and the safety line');
ok(first && first.html.includes(name) && !first.html.includes(password), 'it greets the new name and never carries the password');
ok((await call('POST', 'signup', { username: name, email, password })).error === 'code-needed', 'no account without the code');
const wrong = codeIn(first) === '111111' ? '222222' : '111111';
ok((await call('POST', 'signup', { username: name, email, password, code: wrong })).error === 'bad-code', 'a wrong code is refused');
ok((await call('GET', `name?u=${name}`)).available === true, 'the name is still free until the code is in');
const made = await call('POST', 'signup', { username: name, email, password, code: codeIn(first) });
ok(made.status === 200 && made.token && made.user.verified === true && made.recovery, `the right code makes the account, email confirmed (${made.status} ${made.error || ''})`);
if (made.token) tokens.push([made.token, password]);
ok((await call('POST', 'signup', { username: name + 'x', email, password, code: codeIn(first) })).error, 'a used code doesn\'t work again');

// five wrong guesses use a code up
{
  const e2 = `${tag}.guess@example.com`;
  await call('POST', 'signup/start', { username: `${tag}_Guess`, email: e2, password });
  const c = codeIn(last(e2));
  for (let i = 0; i < 5; i++) await call('POST', 'signup', { username: `${tag}_Guess`, email: e2, password, code: String(100000 + i) === c ? '999999' : String(100000 + i) });
  ok((await call('POST', 'signup', { username: `${tag}_Guess`, email: e2, password, code: c })).error === 'bad-code', 'after 5 wrong guesses even the right code is refused');
  await call('POST', 'signup/start', { username: `${tag}_Guess`, email: e2, password });
  const fresh = await call('POST', 'signup', { username: `${tag}_Guess`, email: e2, password, code: codeIn(last(e2)) });
  ok(fresh.status === 200, 'a new code works');
  if (fresh.token) tokens.push([fresh.token, password]);
}

// an email that already has an account: the same answer, and a note to that email instead of a code
{
  const before = inbox(email).length;
  const r = await call('POST', 'signup/start', { username: `${tag}_Other`, email: email.toUpperCase(), password });
  ok(r.status === 200 && r.code === true, `the page sees the same answer for an email in use (${r.status} ${r.error || ''})`);
  const note = last(email);
  ok(inbox(email).length === before + 1 && /already have a Lotus Goats account/.test(note.subject) && note.text.includes(name) && !codeIn(note), `that email gets a note naming its account, no code (${note && note.subject})`);
  ok((await call('POST', 'signup', { username: `${tag}_Other`, email, password, code: '123456' })).error === 'bad-code', 'and no code can make a second account on it');
}
ok((await call('POST', 'signup/start', { username: name.toUpperCase(), email: `${tag}.new@example.com`, password })).error === 'name-taken', 'a taken name is said at once (names are public)');
// one address can't be flooded with codes
{
  const e3 = `${tag}.flood@example.com`;
  const rs = [];
  for (let i = 0; i < 6; i++) rs.push((await call('POST', 'signup/start', { username: `${tag}_Fl${i}`, email: e3, password })).status);
  ok(rs.filter(s => s === 429).length >= 2 && inbox(e3).length === 4, `at most 4 emails an hour to one address (${rs.join(',')}, ${inbox(e3).length} sent)`);
}

// ---- logging in, with and without login codes
const tok = made.token;
ok((await call('POST', 'login', { login: name, password, device: devB })).token, 'login codes off: the password is enough');
ok((await call('POST', 'twostep', { on: true, password: 'wrong one 99', device: devA }, tok)).error === 'bad-password', 'turning login codes on needs the password');
const on = await call('POST', 'twostep', { on: true, password, device: devA }, tok);
ok(on.user && on.user.twostep === true, `login codes on (${on.error || ''})`);
const viaA = await call('POST', 'login', { login: name, password, device: devA });
ok(viaA.token, 'the device that turned them on logs in with the password');
const nB = inbox(email).length;
const needB = await call('POST', 'login', { login: name, password, device: devB });
ok(needB.error === 'code-needed' && needB.to === `${tag[0]}•••@example.com`, `a new device needs the code (${needB.error} ${needB.to})`);
ok(inbox(email).length === nB + 1 && /log in to your Lotus Goats account on a new device/.test(last(email).text), 'the code is emailed, saying what it\'s for');
ok((await call('POST', 'login', { login: name, password: 'wrong one 99', device: devB })).error === 'bad-login', 'a wrong password still says just "wrong" (no code sent)');
ok(inbox(email).length === nB + 1, 'and sends nothing');
const codeB = codeIn(last(email));
ok((await call('POST', 'login', { login: name, password, device: devC, code: codeB })).error === 'bad-code', 'device B\'s code doesn\'t let device C in');
ok((await call('POST', 'login', { login: name, password: 'wrong one 99', device: devB, code: codeB })).error === 'bad-login', 'the code doesn\'t replace the password');
const inB = await call('POST', 'login', { login: name, password, device: devB, code: codeB });
ok(inB.token, `with the code, device B is in (${inB.error || ''})`);
ok((await call('POST', 'login', { login: name, password, device: devB })).token, 'and next time device B needs no code');
ok((await call('POST', 'login', { login: name, password })).error === 'code-needed', 'a browser without a device id always needs one');
const off = await call('POST', 'twostep', { on: false, password }, tok);
ok(off.user && off.user.twostep === false && /Login codes are off/.test(last(email).subject), 'turning them off tells the email');
ok((await call('POST', 'login', { login: name, password, device: devC })).token, 'then any device logs in with the password');

// ---- a new password by email
{
  const n0 = mail.length;
  ok((await call('POST', 'reset/send', { login: `${tag}_Nobody` })).ok && mail.length === n0, 'no account: the same "sent", and nothing is sent');
  await call('POST', 'reset/send', { login: email });
  const rc = codeIn(last(email));
  ok(rc && /set a new password/.test(last(email).text), 'a reset code arrives');
  await call('POST', 'twostep', { on: true, password, device: devA }, tok);
  const reset = await call('POST', 'reset', { login: email, code: rc, password: 'new lotus 34', device: devC });
  ok(reset.token && reset.user.verified, 'the code sets a new password');
  ok((await call('POST', 'login', { login: email, password: 'new lotus 34', device: devC })).token, 'and lets that device in from then on');
  ok((await call('GET', 'me', null, tok)).error === 'logged-out', 'other devices are logged out');
  tokens.push([reset.token, 'new lotus 34']);
}
const pw2 = 'new lotus 34';
const tok2 = tokens.at(-1)[0];

// ---- a new email
{
  const other = `${tag}.guess@example.com`;   // (the second account's)
  ok((await call('POST', 'email/send', { password: 'nope nope 1', email: `${tag}.moved@example.com` }, tok2)).error === 'bad-password', 'a new email needs the password');
  ok((await call('POST', 'email/send', { password: pw2, email: email.toUpperCase() }, tok2)).error === 'same-email', 'the same email is refused');
  ok((await call('POST', 'email/send', { password: pw2, email: other }, tok2)).error === 'email-taken', 'another account\'s email is refused');
  const moved = `${tag}.moved@example.com`;
  const s = await call('POST', 'email/send', { password: pw2, email: moved }, tok2);
  ok(s.sent === true && codeIn(last(moved)) && /move your Lotus Goats account to this email/.test(last(moved).text), 'a code goes to the new email');
  const mc = codeIn(last(moved));
  ok((await call('POST', 'email', { email: `${tag}.elsewhere@example.com`, code: mc }, tok2)).error === 'bad-code', 'the code only moves the account to that email');
  const done = await call('POST', 'email', { email: moved, code: mc }, tok2);
  ok(done.user && done.user.email === moved && done.user.verified, 'the right code moves it, confirmed');
  ok(/email was changed/.test(last(email).subject) && last(email).text.includes(`${tag[0]}•••@example.com`), 'the old email hears about it');
  ok((await call('POST', 'login', { login: moved, password: pw2, device: devC })).token, 'logging in with the new email works');
}

// ---- email down: a clear error, nothing made
down = true;
const outage = await call('POST', 'signup/start', { username: `${tag}_Down`, email: `${tag}.down@example.com`, password });
ok(outage.status === 502 && outage.error === 'email-failed', `email down: "couldn't send" (${outage.status} ${outage.error})`);
down = false;

// ---- tidy up
for (const [t, pw] of tokens) await call('POST', 'delete', { password: pw }, t);
ok((await call('GET', `name?u=${name}`)).available === true, 'test accounts deleted');
console.log(`\n${pass} passed, ${fail} failed (${mail.length} emails)`);
box.close();
process.exit(fail ? 1 : 0);
