// Save codes (src/ui/savecode.js): how saves combine, packing round trips, and, against a running server, two
// devices sharing one code. Usage: node tools/savetest.mjs [server origin, e.g. http://localhost:8787 from
// `wrangler dev`] (without a server only the offline parts run)
const SERVER = process.argv[2] || null;

// a stand-in for one browser's localStorage, swapped in per "device"
class MemStorage {
  constructor() { this.m = new Map(); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}
const devA = new MemStorage(), devB = new MemStorage();
let current = devA;   // the device being used: localStorage points at it
globalThis.localStorage = new Proxy({}, { get: (_, k) => { const v = current[k]; return typeof v === 'function' ? v.bind(current) : v; } });
globalThis.window = new EventTarget();
globalThis.location = { protocol: 'http:', hostname: 'localhost', port: '8787', origin: SERVER || 'http://localhost:1' };

const S = await import('../src/ui/savecode.js');
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };
const recs = (...rs) => JSON.stringify(rs.map(([id, at, kind = 'mtg', replay = false]) => ({ id, at, kind, replay, result: 'win', deck: { name: 'd' }, opps: [] })));

// ---- merging
{
  const a = { 'pa-records': recs(['a1', 3, 'mtg', true], ['s1', 2]), 'pa-replay-a1': '{"r":1}', 'pa-avatar': 'AAA', 'pa-nick': 'Ann', 'pa-custom-decks': JSON.stringify([{ id: 'custom-aaaa', name: 'A', updated: 5 }, { id: 'custom-cccc', name: 'C old', updated: 1 }]) };
  const b = { 'pa-records': recs(['b1', 4, 'pk'], ['s1', 2]), 'pa-avatar': 'BBB', 'pa-custom-decks': JSON.stringify([{ id: 'custom-cccc', name: 'C new', updated: 9 }, { id: 'custom-dddd', name: 'D', updated: 2 }]), 'pa-deleted-decks': '["custom-aaaa"]' };
  const m = S.mergeSaves(a, b, 'b');
  const r = JSON.parse(m['pa-records']);
  ok(r.map(x => x.id).join() === 'b1,a1,s1', `games from both, newest first, the shared one once (${r.map(x => x.id)})`);
  ok(m['pa-replay-a1'] === '{"r":1}' && r.find(x => x.id === 'a1').replay, 'a replay comes along');
  ok(m['pa-avatar'] === 'BBB' && m['pa-nick'] === 'Ann', 'single things: the winner\'s, else whoever has one');
  const d = JSON.parse(m['pa-custom-decks']);
  ok(d.map(x => x.name).join() === 'C new,D', `latest version of each deck, deleted ones gone (${d.map(x => x.name)})`);
  const m2 = S.mergeSaves(a, b, 'a');
  ok(m2['pa-avatar'] === 'AAA', 'the other way round keeps this device\'s avatar');
  // replay caps: only the newest 8 per game keep theirs
  const many = {}; const list = [];
  for (let i = 0; i < 12; i++) { list.push([`r${i}`, i, 'op', true]); many[`pa-replay-r${i}`] = 'x'; }
  many['pa-records'] = recs(...list);
  const m3 = S.mergeSaves(many, {}, 'b');
  ok(Object.keys(m3).filter(k => k.startsWith('pa-replay-')).length === 8, 'at most 8 replays per game');
  ok(!JSON.parse(m3['pa-records']).find(x => x.id === 'r0').replay, 'older games lose their replay flag');
  // device-only keys never travel
  const s = await S.unpack(await S.pack({ 'pa-cid': 'me', 'pa-savecode': 'x', 'pa-uisize': 'big', 'pa-room-ab': '1', 'pk-lobby': '{}', 'evil': 'x' }));
  ok(Object.keys(s.items).join() === 'pk-lobby', `only shareable keys come out of a save (${Object.keys(s.items)})`);
}

// ---- packing
{
  const big = { 'pa-records': recs(...Array.from({ length: 300 }, (_, i) => [`g${i}`, i])), 'pa-nick': 'Zoë ✨' };
  const p = await S.pack(big);
  ok(p[0] === 'z', 'compressed');
  const back = await S.unpack(p);
  ok(back.items['pa-nick'] === 'Zoë ✨' && back.items['pa-records'] === big['pa-records'], 'round trip, unicode too');
  ok(p.length < JSON.stringify(big).length / 3, `compresses well (${p.length} vs ${JSON.stringify(big).length})`);
  let bad = null; try { await S.unpack('zNOTVALID'); } catch (e) { bad = e.code; }
  ok(bad === 'notasave', 'garbage is refused');
  current = devA;
  devA.setItem('pa-nick', 'Text'); devA.setItem('pa-cid', 'mine');
  const t = await S.saveText();
  ok(t.startsWith(S.TEXT_PREFIX), 'save text');
  const read = await S.readText(t);
  ok(read.items['pa-nick'] === 'Text' && !read.items['pa-cid'], 'save text round trip, without the device id');
  devA.removeItem('pa-nick'); devA.removeItem('pa-cid');
  ok(S.isCode('k7qm-4zp2') && S.normCode('k7qm-4zp2') === 'K7QM4ZP2' && !S.isCode('K7QM-4ZP0') && !S.isCode('ABC'), 'code format');
}

// ---- two devices and a server
if (SERVER) {
  current = devA;
  devA.setItem('pa-records', recs(['a1', 10]));
  devA.setItem('pa-nick', 'Ann');
  devA.setItem('pa-cid', 'device-a');
  const link = await S.saveNow();
  ok(link && S.isCode(link.code) && link.rev === 1, `device A made a code (${link && link.code})`);
  // device B finds and loads it
  current = devB;
  devB.setItem('pa-records', recs(['b1', 20, 'pk']));
  devB.setItem('pa-cid', 'device-b');
  devB.setItem('pa-uisize', 'huge');
  const found = await S.fetchSave(S.showCode(link.code).toLowerCase());
  ok(found.items['pa-nick'] === 'Ann', 'B sees A\'s save');
  await S.loadCode(found);
  ok(JSON.parse(devB.getItem('pa-records')).map(r => r.id).join() === 'b1,a1', 'B has both devices\' games');
  ok(devB.getItem('pa-cid') === 'device-b' && devB.getItem('pa-uisize') === 'huge' && devB.getItem('pa-nick') === 'Ann', 'B keeps its own device id and screen size, takes the name');
  ok(S.savedLink().code === link.code, 'B is linked to the same code');
  // B plays a game and saves; A, still on the old version, plays one too and saves: nothing is lost
  devB.setItem('pa-records', recs(['b2', 30], ['b1', 20, 'pk'], ['a1', 10]));
  await S.saveNow();
  current = devA;
  devA.setItem('pa-records', recs(['a2', 40], ['a1', 10]));
  await S.saveNow();
  ok(JSON.parse(devA.getItem('pa-records')).map(r => r.id).join() === 'a2,b2,b1,a1', `A brought in B's games before saving (${JSON.parse(devA.getItem('pa-records')).map(r => r.id)})`);
  const server = await S.fetchSave(link.code);
  ok(JSON.parse(server.items['pa-records']).length === 4, 'the server has all four games');
  // nothing changed: no new upload
  const rev = server.rev;
  await S.saveNow();
  ok((await S.fetchSave(link.code)).rev === rev, 'an unchanged save isn\'t uploaded again');
  // a deck deleted on one device stays deleted
  current = devA;
  devA.setItem('pa-custom-decks', JSON.stringify([{ id: 'custom-zzzz', name: 'Z', updated: 1 }]));
  await S.saveNow();
  current = devB;
  await S.saveNow();
  ok(JSON.parse(devB.getItem('pa-custom-decks') || '[]').length === 1, 'B got the deck');
  devB.setItem('pa-custom-decks', '[]'); devB.setItem('pa-deleted-decks', '["custom-zzzz"]');
  await S.saveNow();
  current = devA;
  await S.saveNow();
  ok(JSON.parse(devA.getItem('pa-custom-decks') || '[]').length === 0, 'the deck deleted on B is gone from A too');
  // wrong code
  let miss = null; try { await S.fetchSave('ZZZZ-ZZZZ'); } catch (e) { miss = e.code; }
  ok(miss === 'missing', 'an unknown code says so');
  S.forgetCode();
  ok(!S.savedLink(), 'stop saving on this device');
} else console.log('(no server given: skipping the two-device test)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
