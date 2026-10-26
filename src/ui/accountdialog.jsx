// The account dialog (account.js does the work): log in (with a code from the email too, on a new device, when the
// account has login codes on), make an account (a username nobody else has, an email confirmed with a code, a
// password), get back in with an emailed code or the recovery code, and, once logged in, your account: email (confirm
// it, change it), login codes, password, logging out (and forgetting this device's progress on a shared computer),
// deleting the account.
import { Modal } from './dialogs.jsx';
import { AnimalAvatar, myAvatar } from './avatar.jsx';
import { savedWhen } from './savedialog.jsx';
import { saveStatus, subscribeSave } from './savecode.js';
import { findRelay } from '../net/relayroom.js';
import {
  currentLogin, subscribeAccount, accountConfig, checkName, startSignUp, signUp, logIn, logOut, recover, sendResetCode, resetWithCode,
  changePassword, deleteAccount, sendVerifyCode, verifyEmail, setLoginCodes, sendEmailChange, changeEmail, accountErrorText, USERNAME,
} from './account.js';

const { useState, useEffect, useRef, useSyncExternalStore } = React;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const AGE_BLOCK = 'pa-age-block';   // (sessionStorage: a "too young" answer holds for this visit)

// a form's busy flag and error, with one way to run its action
function useAction() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const run = async f => {
    setBusy(true); setErr(null);
    try { await f(); } catch (e) { setErr(accountErrorText(e)); }
    setBusy(false);
  };
  return { busy, err, setErr, run };
}

function Field({ label, hint, children, id }) {
  return (
    <label className="ac-field" htmlFor={id}>
      <span className="ac-label">{label}</span>
      {children}
      {hint ? <span className="ac-hint">{hint}</span> : null}
    </label>
  );
}
function PasswordInput({ id, value, onChange, autoComplete, placeholder }) {
  const [show, setShow] = useState(false);
  return (
    <span className="ac-pw">
      <input id={id} className="input" type={show ? 'text' : 'password'} value={value} onChange={e => onChange(e.target.value)} autoComplete={autoComplete} placeholder={placeholder} spellCheck="false" />
      <button type="button" className="btn sm ghost" onClick={() => setShow(s => !s)} aria-pressed={show}>{show ? 'Hide' : 'Show'}</button>
    </span>
  );
}
function Err({ text }) { return text ? <p className="ac-err" role="alert">{text}</p> : null; }
// the 6-digit codes the emails carry
const sixDigits = c => /^\d{6}$/.test(c);
function CodeInput({ id, value, onChange }) {
  return <input id={id} className="input ac-mono ac-otp" value={value} onChange={e => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="000000" autoFocus />;
}
const CODE_HINT = 'It works for 20 minutes. Not there? Check your spam or junk folder.';
const RESENT_HINT = 'A new code is on its way: use the newest email.';
function useEmailOn() {
  const [on, setOn] = useState(null);
  useEffect(() => { let live = true; accountConfig().then(c => { if (live) setOn(!!c.emailOn); }, () => {}); return () => { live = false; }; }, []);
  return on;
}

// ---- log in
// (`hold` keeps the form on screen while logging in finishes: bringing your progress over takes a moment)
async function held(hold, f) {
  hold(true);
  try { return await f(); } catch (e) { hold(false); throw e; }
}
function LogIn({ go, onDone, hold }) {
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [need, setNeed] = useState(null);   // where the login code went (an account with login codes on, a new device)
  const [code, setCode] = useState('');
  const [resent, setResent] = useState(false);
  const a = useAction();
  const attempt = withCode => a.run(async () => {
    try {
      const r = await held(hold, () => logIn({ login: name, password: pw, code: withCode ? code : undefined }));
      onDone(r.reload);
    } catch (e) {
      if (e.code !== 'code-needed') throw e;
      if (need) setResent(true);
      setNeed(e.to || 'your email');
      setCode('');
    }
  });
  if (need) {
    return (
      <form className="ac-form" onSubmit={e => { e.preventDefault(); attempt(true); }}>
        <p className="ac-sent">This account asks for a code when it logs in on a new device. We emailed one to <b>{need}</b>.</p>
        <Field label="Code from the email" id="ac-lcode" hint={resent ? RESENT_HINT : CODE_HINT}><CodeInput id="ac-lcode" value={code} onChange={setCode} /></Field>
        <Err text={a.err} />
        <button className="btn primary ac-go" type="submit" disabled={a.busy || !sixDigits(code)}>{a.busy ? 'Logging in…' : 'Log in'}</button>
        <div className="ac-links">
          <button type="button" className="linkish" disabled={a.busy} onClick={() => attempt(false)}>Send a new code</button>
          <button type="button" className="linkish" onClick={() => go('recover')}>No email? Use your recovery code</button>
        </div>
      </form>
    );
  }
  return (
    <form className="ac-form" onSubmit={e => { e.preventDefault(); attempt(false); }}>
      <Field label="Username or email" id="ac-login"><input id="ac-login" className="input" value={name} onChange={e => setName(e.target.value)} autoComplete="username" spellCheck="false" autoCapitalize="none" autoFocus /></Field>
      <Field label="Password" id="ac-pw"><PasswordInput id="ac-pw" value={pw} onChange={setPw} autoComplete="current-password" /></Field>
      <Err text={a.err} />
      <button className="btn primary ac-go" type="submit" disabled={a.busy || !name.trim() || !pw}>{a.busy ? 'Logging in…' : 'Log in'}</button>
      <div className="ac-links">
        <button type="button" className="linkish" onClick={() => go('forgot')}>Forgot your password?</button>
        <button type="button" className="linkish" onClick={() => go('signup')}>New here? Make an account</button>
      </div>
    </form>
  );
}

// ---- make an account
function nameNote(name, check) {
  if (!name) return { cls: '', text: '3 to 20 letters, numbers or _. Other players see it, and it’s yours alone.' };
  if (!USERNAME.test(name)) return { cls: 'bad', text: 'Use 3 to 20 letters, numbers or _ (no spaces).' };
  if (!check || check.name !== name) return { cls: '', text: 'Checking…' };
  if (check.error) return { cls: '', text: '' };
  if (check.problem === 'reserved-name') return { cls: 'bad', text: 'That username is reserved.' };
  if (check.problem === 'rude-name') return { cls: 'bad', text: 'That username isn’t allowed.' };
  if (check.problem) return { cls: 'bad', text: 'Use 3 to 20 letters, numbers or _ (no spaces).' };
  return check.available ? { cls: 'good', text: `✓ ${name} is free` } : { cls: 'bad', text: `✗ Someone already has ${name}` };
}
function SignUp({ go, onMade, hold }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [month, setMonth] = useState('');
  const [year, setYear] = useState('');
  const [check, setCheck] = useState(null);
  const [young, setYoung] = useState(() => { try { return sessionStorage.getItem(AGE_BLOCK) === '1'; } catch { return false; } });
  const [step, setStep] = useState('form');   // then 'code', when the email gets one
  const [code, setCode] = useState('');
  const [resent, setResent] = useState(false);
  const emailOn = useEmailOn();
  const a = useAction();
  // is the name free? asked a moment after typing stops
  useEffect(() => {
    if (!USERNAME.test(name)) return;
    let live = true;
    const t = setTimeout(() => checkName(name).then(r => { if (live) setCheck({ name, ...r }); }, () => { if (live) setCheck({ name, error: true }); }), 350);
    return () => { live = false; clearTimeout(t); };
  }, [name]);
  const now = new Date();
  const years = Array.from({ length: 100 }, (_, i) => now.getFullYear() - i);
  const age = year && month !== '' ? now.getFullYear() - +year - (now.getMonth() < +month ? 1 : 0) : null;
  const note = nameNote(name, check);
  const taken = check && check.name === name && (check.available === false);
  const details = { username: name, email, password: pw };
  const submit = e => {
    e.preventDefault();
    if (age != null && age < 13) { try { sessionStorage.setItem(AGE_BLOCK, '1'); } catch { /* blocked */ } setYoung(true); return; }
    a.run(async () => {
      if (step === 'form') {
        if ((await startSignUp(details)).code) { setStep('code'); setCode(''); setResent(false); return; }
      }
      onMade(await held(hold, () => signUp({ ...details, code: step === 'code' ? code : undefined })));
    });
  };
  const resend = () => a.run(async () => { await startSignUp(details); setCode(''); setResent(true); });
  if (young) {
    return (
      <div className="ac-form">
        <p className="ac-young">Accounts are for players 13 and older. You can still play every game, battle friends in rooms, and use a <b>save code</b> to take your progress to another device.</p>
        <button type="button" className="btn" onClick={() => go('login')}>Back</button>
      </div>
    );
  }
  if (step === 'code') {
    return (
      <form className="ac-form" onSubmit={submit}>
        <p className="ac-sent">We emailed a 6-digit code to <b>{email.trim()}</b>. Enter it to finish making <b>{name}</b>.</p>
        <Field label="Code from the email" id="ac-scode" hint={resent ? RESENT_HINT : CODE_HINT}><CodeInput id="ac-scode" value={code} onChange={setCode} /></Field>
        <Err text={a.err} />
        <button className="btn primary ac-go" type="submit" disabled={a.busy || !sixDigits(code)}>{a.busy ? 'Making your account…' : 'Make my account'}</button>
        <div className="ac-links">
          <button type="button" className="linkish" disabled={a.busy} onClick={resend}>Send a new code</button>
          <button type="button" className="linkish" onClick={() => { setStep('form'); a.setErr(null); }}>Change my email or details</button>
        </div>
      </form>
    );
  }
  return (
    <form className="ac-form" onSubmit={submit}>
      <Field label="Username" id="ac-name" hint={<span className={`ac-namecheck ${note.cls}`} aria-live="polite">{note.text}</span>}>
        <input id="ac-name" className="input" value={name} onChange={e => setName(e.target.value.replace(/\s/g, '').slice(0, 20))} autoComplete="username" spellCheck="false" autoCapitalize="none" maxLength={20} autoFocus />
      </Field>
      <Field label="Email" id="ac-email" hint={emailOn ? 'We’ll send it a code to check it’s yours. It’s only for logging in and getting back into your account; other players never see it.' : 'Only for logging in and getting back into your account. Other players never see it.'}>
        <input id="ac-email" className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" spellCheck="false" autoCapitalize="none" />
      </Field>
      <Field label="Password" id="ac-newpw" hint="At least 8 characters.">
        <PasswordInput id="ac-newpw" value={pw} onChange={setPw} autoComplete="new-password" />
      </Field>
      <fieldset className="ac-field ac-born">
        <legend className="ac-label">When were you born?</legend>
        <div className="ac-row">
          <select className="input" value={month} onChange={e => setMonth(e.target.value)} aria-label="Month"><option value="">Month</option>{MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}</select>
          <select className="input" value={year} onChange={e => setYear(e.target.value)} aria-label="Year"><option value="">Year</option>{years.map(y => <option key={y} value={y}>{y}</option>)}</select>
        </div>
        <span className="ac-hint">Not saved anywhere.</span>
      </fieldset>
      <Err text={a.err} />
      <button className="btn primary ac-go" type="submit" disabled={a.busy || !USERNAME.test(name) || taken || !email.trim() || pw.length < 8 || age == null}>{a.busy ? 'One moment…' : emailOn ? 'Email me a code' : 'Make my account'}</button>
      <div className="ac-links"><button type="button" className="linkish" onClick={() => go('login')}>Already have an account? Log in</button></div>
    </form>
  );
}

// ---- the recovery code, shown once
function RecoveryCode({ code }) {
  const [copied, setCopied] = useState(null);
  const copy = () => { try { navigator.clipboard.writeText(code).then(() => setCopied('yes'), () => setCopied('no')); } catch { setCopied('no'); } };
  return (
    <div className="ac-recovery">
      <div className="ac-label">Your recovery code</div>
      <div className="ac-coderow"><output className="ac-code">{code}</output><button type="button" className="btn sm" onClick={copy}>{copied === 'yes' ? 'Copied' : 'Copy'}</button></div>
      {copied === 'no' ? <p className="ac-hint">Copying isn’t allowed here: select the code and copy it yourself.</p> : null}
      <p className="ac-hint">Write it down or keep it somewhere safe. If you ever forget your password, this code lets you set a new one. It works once; you then get a new one.</p>
    </div>
  );
}

// ---- forgot the password
function Forgot({ go, onBack, initial = null }) {
  const [chosen, setHow] = useState(initial);
  const emailOn = useEmailOn();
  const how = chosen || (emailOn ? 'email' : 'recovery');   // (an emailed code first, when there are any)
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [sent, setSent] = useState(false);
  const [fresh, setFresh] = useState(null);   // { recovery, reload } after a recovery
  const [resent, setResent] = useState(false);
  const a = useAction();
  if (fresh) {
    return (
      <div className="ac-form">
        <p className="ac-ok">Your new password is set and you’re logged in.</p>
        <RecoveryCode code={fresh.recovery} />
        <button type="button" className="btn primary ac-go" onClick={() => onBack(fresh.reload)}>Done</button>
      </div>
    );
  }
  const submit = e => {
    e.preventDefault();
    a.run(async () => {
      if (how === 'recovery') setFresh(await recover({ login: name, recovery: code, password: pw }));
      else if (!sent) { await sendResetCode(name); setSent(true); }
      else onBack((await resetWithCode({ login: name, code, password: pw })).reload);
    });
  };
  return (
    <form className="ac-form" onSubmit={submit}>
      {emailOn ? (
        <div className="seg ac-seg" role="group" aria-label="How to get back in">
          <button type="button" className={how === 'email' ? 'on' : ''} aria-pressed={how === 'email'} onClick={() => { setHow('email'); setCode(''); a.setErr(null); }}>Code by email</button>
          <button type="button" className={how === 'recovery' ? 'on' : ''} aria-pressed={how === 'recovery'} onClick={() => { setHow('recovery'); setCode(''); a.setErr(null); }}>Recovery code</button>
        </div>
      ) : null}
      <Field label="Username or email" id="ac-fname"><input id="ac-fname" className="input" value={name} onChange={e => setName(e.target.value)} autoComplete="username" spellCheck="false" autoCapitalize="none" /></Field>
      {how === 'recovery' ? (
        <Field label="Recovery code" id="ac-rcode" hint="The code you got when you made your account (or last used one).">
          <input id="ac-rcode" className="input ac-mono" value={code} onChange={e => setCode(e.target.value)} placeholder="XXXX-XXXX-XXXX-XXXX" spellCheck="false" autoCapitalize="characters" autoComplete="off" />
        </Field>
      ) : sent ? (
        <Field label="Code from the email" id="ac-ecode" hint={resent ? RESENT_HINT : 'If an account has that username or email, a 6-digit code is on its way to its email. It works for 20 minutes.'}>
          <CodeInput id="ac-ecode" value={code} onChange={setCode} />
        </Field>
      ) : null}
      {how === 'recovery' || sent ? <Field label="New password" id="ac-fpw" hint="At least 8 characters."><PasswordInput id="ac-fpw" value={pw} onChange={setPw} autoComplete="new-password" /></Field> : null}
      <Err text={a.err} />
      <button className="btn primary ac-go" type="submit" disabled={a.busy || !name.trim() || (how === 'recovery' && (!code.trim() || pw.length < 8)) || (how === 'email' && sent && (!sixDigits(code) || pw.length < 8))}>
        {a.busy ? 'One moment…' : how === 'email' && !sent ? 'Email me a code' : 'Set my new password'}
      </button>
      <div className="ac-links">
        {how === 'email' && sent ? <button type="button" className="linkish" disabled={a.busy} onClick={() => a.run(async () => { await sendResetCode(name); setCode(''); setResent(true); })}>Send a new code</button> : null}
        <button type="button" className="linkish" onClick={() => go('login')}>Back to logging in</button>
      </div>
    </form>
  );
}

// ---- logged in: your account
function Collapsible({ title, children, danger }) {
  return <details className={`ac-more ${danger ? 'danger' : ''}`}><summary>{title}</summary><div className="ac-morebody">{children}</div></details>;
}
function ChangePassword() {
  const [old, setOld] = useState('');
  const [pw, setPw] = useState('');
  const [done, setDone] = useState(false);
  const a = useAction();
  const submit = e => { e.preventDefault(); a.run(async () => { await changePassword(old, pw); setDone(true); setOld(''); setPw(''); }); };
  return (
    <form className="ac-form" onSubmit={submit}>
      <Field label="Current password" id="ac-old"><PasswordInput id="ac-old" value={old} onChange={setOld} autoComplete="current-password" /></Field>
      <Field label="New password" id="ac-new" hint="At least 8 characters. Your other devices will need to log in again."><PasswordInput id="ac-new" value={pw} onChange={v => { setPw(v); setDone(false); }} autoComplete="new-password" /></Field>
      <Err text={a.err} />
      {done ? <p className="ac-ok" role="status">Password changed.</p> : null}
      <button className="btn" type="submit" disabled={a.busy || !old || pw.length < 8}>{a.busy ? 'Changing…' : 'Change password'}</button>
    </form>
  );
}
function ConfirmEmail({ user }) {
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const a = useAction();
  if (user.verified) return <span className="ac-chip good">Confirmed</span>;
  if (!user.emailOn) return null;
  return (
    <div className="ac-confirm">
      <span className="ac-chip">Not confirmed yet</span>
      {sent ? (
        <form className="ac-row" onSubmit={e => { e.preventDefault(); a.run(() => verifyEmail(code)); }}>
          <input className="input ac-mono" value={code} onChange={e => setCode(e.target.value)} placeholder="6-digit code" inputMode="numeric" autoComplete="one-time-code" aria-label="Code from the email" maxLength={8} />
          <button className="btn sm" type="submit" disabled={a.busy || code.replace(/\D/g, '').length !== 6}>Confirm</button>
        </form>
      ) : <button type="button" className="btn sm" onClick={() => a.run(async () => { await sendVerifyCode(); setSent(true); })} disabled={a.busy}>Email me a code</button>}
      <Err text={a.err} />
    </div>
  );
}
function ChangeEmail({ user }) {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [done, setDone] = useState(false);
  const a = useAction();
  const submit = e => {
    e.preventDefault();
    a.run(async () => {
      if (!sent) {
        const r = await sendEmailChange(pw, email);
        if (r.sent) { setSent(true); setCode(''); return; }
      } else await changeEmail(email, code);
      setDone(true); setSent(false); setEmail(''); setPw(''); setCode('');
    });
  };
  return (
    <form className="ac-form" onSubmit={submit}>
      {sent ? <>
        <p className="ac-sent">We emailed a 6-digit code to <b>{email.trim()}</b>. Enter it to move your account there.</p>
        <Field label="Code from the email" id="ac-mcode" hint={CODE_HINT}><CodeInput id="ac-mcode" value={code} onChange={setCode} /></Field>
      </> : <>
        <Field label="New email" id="ac-memail"><input id="ac-memail" className="input" type="email" value={email} onChange={e => { setEmail(e.target.value); setDone(false); }} autoComplete="email" spellCheck="false" autoCapitalize="none" /></Field>
        <Field label="Your password" id="ac-mpw"><PasswordInput id="ac-mpw" value={pw} onChange={setPw} autoComplete="current-password" /></Field>
      </>}
      <Err text={a.err} />
      {done ? <p className="ac-ok" role="status">Your email is changed{user.verified ? ' and confirmed' : ''}.</p> : null}
      <div className="row">
        <button className="btn" type="submit" disabled={a.busy || (sent ? !sixDigits(code) : !email.trim() || !pw)}>{a.busy ? 'One moment…' : sent || !user.emailOn ? 'Change my email' : 'Email me a code'}</button>
        {sent ? <button type="button" className="btn ghost" onClick={() => { setSent(false); a.setErr(null); }}>Back</button> : null}
      </div>
    </form>
  );
}
// login codes: a new device needs the password and a code from the email
function LoginCodes({ user }) {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState('');
  const a = useAction();
  if (!user.emailOn) return null;
  const on = user.twostep;
  return (
    <div className="ac-line">
      <span className="ac-label">Login codes</span>
      <span>{on ? 'On: logging in on a new device takes your password and a code from your email.' : 'Ask for a code from your email whenever your account logs in on a new device, so a password alone can’t get in.'}</span>
      {open ? (
        <form className="ac-row" onSubmit={e => { e.preventDefault(); a.run(async () => { await setLoginCodes(!on, pw); setOpen(false); setPw(''); }); }}>
          <PasswordInput id="ac-2pw" value={pw} onChange={setPw} autoComplete="current-password" placeholder="Your password" />
          <button className="btn sm" type="submit" disabled={a.busy || !pw}>{on ? 'Turn off' : 'Turn on'}</button>
          <button type="button" className="btn sm ghost" onClick={() => { setOpen(false); a.setErr(null); }}>Cancel</button>
        </form>
      ) : (
        <span className="ac-row">
          {on ? <span className="ac-chip good">On</span> : null}
          <button type="button" className="btn sm" disabled={!on && !user.verified} onClick={() => setOpen(true)}>{on ? 'Turn off' : 'Turn on'}</button>
        </span>
      )}
      {!on && !user.verified ? <span className="ac-hint">Confirm your email first (above).</span> : null}
      <Err text={a.err} />
    </div>
  );
}
function Account({ user, onLeft }) {
  useSyncExternalStore(subscribeSave, saveStatus);
  const st = saveStatus();
  const [shared, setShared] = useState(false);
  const [pw, setPw] = useState('');
  const out = useAction();
  const del = useAction();
  const saveLine = st.state === 'saving' ? 'Saving…' : st.state === 'error' ? 'Couldn’t save just now; it tries again after your next game.' : st.at ? `Saved ${savedWhen(st.at)}.` : '';
  return (
    <div className="ac-account">
      <div className="ac-who">
        <AnimalAvatar code={myAvatar()} size={64} />
        <div>
          <b className="ac-username">{user.username}</b>
          <span>Playing since {new Date(user.created).toLocaleDateString([], { month: 'long', year: 'numeric' })}</span>
        </div>
      </div>
      <div className="ac-line"><span className="ac-label">Email</span><span className="ac-email">{user.email}</span><ConfirmEmail user={user} /></div>
      <LoginCodes user={user} />
      <div className="ac-line"><span className="ac-label">Progress</span><span>Your record, replays, decks, avatar and settings save to your account by themselves, so they’re there wherever you log in. {saveLine}</span></div>
      <Collapsible title="Change email"><ChangeEmail user={user} /></Collapsible>
      <Collapsible title="Change password"><ChangePassword /></Collapsible>
      <div className="ac-logout">
        <label className="ac-check"><input type="checkbox" checked={shared} onChange={e => setShared(e.target.checked)} /> This is a shared computer: also remove my progress from it</label>
        <Err text={out.err} />
        <div className="row">
          <button type="button" className="btn" disabled={out.busy} onClick={() => out.run(async () => { await logOut({ removeProgress: shared }); onLeft(shared); })}>Log out</button>
          <button type="button" className="btn ghost" disabled={out.busy} onClick={() => out.run(async () => { await logOut({ everywhere: true, removeProgress: shared }); onLeft(shared); })} title="Every device logged in to this account has to log in again">Log out everywhere</button>
        </div>
      </div>
      <Collapsible title="Delete my account" danger>
        <p className="ac-hint">Your account, username, email and the progress saved online for it are deleted for good, and the username becomes free for someone else. Progress already on your devices stays on them.</p>
        <form className="ac-form" onSubmit={e => { e.preventDefault(); del.run(async () => { await deleteAccount(pw); onLeft(false); }); }}>
          <Field label="Your password, to be sure" id="ac-delpw"><PasswordInput id="ac-delpw" value={pw} onChange={setPw} autoComplete="current-password" /></Field>
          <Err text={del.err} />
          <button className="btn danger" type="submit" disabled={del.busy || !pw}>{del.busy ? 'Deleting…' : 'Delete my account'}</button>
        </form>
      </Collapsible>
    </div>
  );
}

const TITLES = { login: 'Log in', signup: 'Make an account', forgot: 'Get back into your account', recover: 'Get back into your account', welcome: 'Welcome!', account: 'Your account' };
export function AccountDialog({ onClose, start = 'login' }) {
  const login = useSyncExternalStore(subscribeAccount, currentLogin);
  const [view, setView] = useState(login ? 'account' : start);
  const [made, setMade] = useState(null);     // { recovery, user, reload } right after signing up
  const [hold, setHold] = useState(false);
  const [online, setOnline] = useState(null);   // can this copy of the site reach the account server?
  const reloadAfter = useRef(false);
  useEffect(() => { let live = true; findRelay().then(o => { if (live) setOnline(!!o); if (o) accountConfig().catch(() => {}); }); return () => { live = false; }; }, []);
  const close = () => { if (reloadAfter.current) location.reload(); else onClose(); };
  const done = reload => { if (reload) location.reload(); else onClose(); };
  const shown = login && !hold && view !== 'welcome' && view !== 'forgot' && view !== 'recover' ? 'account' : view;
  return (
    <Modal label={TITLES[shown]} onClose={close} cls="acctdlg">
      <h2>{shown === 'welcome' && made ? `Welcome, ${made.user.username}!` : TITLES[shown]}</h2>
      {shown === 'login' ? <p className="sub">Your progress follows you to every device you log in on.</p> : null}
      {shown === 'signup' ? <p className="sub">Pick a username nobody else has. Your record, decks and avatar will save to your account.</p> : null}
      {online === false && !login ? <p className="sv-note">Accounts need the website itself: lotusgoats.com. Here you can still use a save code’s save text to move your progress.</p> : null}
      {online === false && !login ? null : <>
      {shown === 'login' ? <LogIn go={setView} onDone={done} hold={setHold} /> : null}
      {shown === 'signup' ? <SignUp go={setView} hold={setHold} onMade={m => { setMade(m); reloadAfter.current = m.reload; setView('welcome'); setHold(false); }} /> : null}
      {shown === 'forgot' || shown === 'recover' ? <Forgot key={shown} go={setView} initial={shown === 'recover' ? 'recovery' : null} onBack={reload => done(reload)} /> : null}
      {shown === 'welcome' && made ? (
        <div className="ac-form">
          <p className="ac-ok">Your account is ready, and your progress on this device now saves to it.{made.user.emailOn && !made.user.verified ? ' We emailed you a code to confirm your email (you can do that from your account any time).' : ''}</p>
          <RecoveryCode code={made.recovery} />
          <button type="button" className="btn primary ac-go" onClick={close}>I’ve saved it, let’s play</button>
        </div>
      ) : null}
      {shown === 'account' && login ? <Account user={login.user} onLeft={removed => (removed ? location.reload() : onClose())} /> : null}
      </>}
      <div className="dlg-actions"><button className="btn" onClick={close}>Close</button></div>
    </Modal>
  );
}
