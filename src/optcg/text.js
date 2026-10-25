// Card text compiler: One Piece card text (cards.json `text` and `trigger`) into abilities the engine interprets.
// Card text is very regular, so it is read with a small grammar: an ability is a header of bracketed keywords
// (conditions, timing), an optional activation cost before a colon, and effect sentences; sentences are clauses
// ("Then, ...", "... and ...") built from verbs ("K.O.", "Rest", "gains +N power") and card descriptions ("up to 1 of
// your opponent's rested Characters with a cost of 3 or less"). Anything it can't read is reported as an error:
// a card with an error isn't fully implemented (tools/optcg/coverage.mjs fails), never silently ignored.
//
// Ability: { idx, kind, text, ...}
//   kind 'keyword':  { kw, don, turn, cond }                       [Blocker], [Rush], "[DON!! x2] This Character gains [Rush]"
//   kind 'static':   { mods: [{ k, sel, n | kw | how }], don, turn, cond, hand }   permanent effects
//   kind 'auto':     { timings: [...], when, don, turn, once, cost, optional, steps }
//   kind 'activate': { don, turn, once, cost, optional, need, steps }   [Activate: Main]
//   kind 'event':    { timings: ['main'|'counter'], cost, optional, steps }
//   kind 'trigger':  { cost, optional, steps }
//   kind 'replace':  { replace: { events, sel|self, byOpp, cost, steps }, once, don, turn }

const KW = ['Rush: Character', 'Double Attack', 'Unblockable', 'Blocker', 'Banish', 'Rush'];
const TIMING = {
  'On Play': 'onPlay', 'When Attacking': 'whenAttacking', 'On Block': 'onBlock', 'On K.O.': 'ko',
  'End of Your Turn': 'endOfYourTurn', "End of Your Opponent's Turn": 'endOfOppTurn', "On Your Opponent's Attack": 'onOppAttack',
  'Activate: Main': 'activate', 'Main': 'main', 'Counter': 'counter',
};
const COLORS = ['red', 'green', 'blue', 'purple', 'black', 'yellow'];
const cap = s => s[0].toUpperCase() + s.slice(1);
const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5 };

// ------------------------------------------------------------ normalizing
export function normalize(s) {
  if (!s) return '';
  return s
    .replace(/\r/g, '')
    .replace(/\[Activate\s*:\s*Main\]/gi, '[Activate: Main]')
    .replace(/\[On K\.O\]/g, '[On K.O.]')
    .replace(/[\u2460-\u2469]/g, ch => `{R${ch.charCodeAt(0) - 0x245F}}`)
    .replace(/[\u2780-\u2789]/g, ch => `{R${ch.charCodeAt(0) - 0x277F}}`)
    .replace(/[\u2776-\u277F]/g, ch => `{R${ch.charCodeAt(0) - 0x2775}}`)
    .replace(/(^|[\s\]])[([](\d{1,2})[)\]](?=\s|:|$)/g, (m, a, n) => `${a}{R${n}}`)
    .replace(/\uFF1C/g, '<').replace(/\uFF1E/g, '>')
    .replace(/[\u2018\u2019\u2032]/g, "'").replace(/[\u201C\u201D]/g, '"')
    // "choose one:" options printed as "- " lines
    .replace(/^[ \t]*[-\u2212\u2013][ \t]+(?=[A-Z])/gm, '\u2022 ')
    .replace(/[\u2212\u2013\u2014]/g, '-')
    // explanatory notes (2-8-4): reminder text in parentheses
    .replace(/\s*\((?:This card|This Character|After your opponent|You may rest the specified|You may return the specified|When this card|Your opponent cannot activate|This Leader)[^()]*\)/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

// ------------------------------------------------------------ splitting text into abilities
const START = /^\[(DON!! x\d+|Your Turn|Opponent's Turn|Once Per Turn|On Play|When Attacking|On Block|On K\.O\.|Activate: Main|Main|Counter|End of Your Turn|End of Your Opponent's Turn|On Your Opponent's Attack|Blocker|Rush: Character|Rush|Double Attack|Banish|Unblockable)\]/;
export function splitAbilities(text) {
  const t = normalize(text);
  if (!t) return [];
  // bullet lines belong to the "choose one:" before them
  const lines = [];
  for (const l of t.split('\n')) { if (/^[•·]/.test(l) && lines.length) lines[lines.length - 1] += ' ' + l; else if (l.trim()) lines.push(l); }
  const out = [];
  for (const line of lines) {
    let cur = '';
    let i = 0;
    while (i < line.length) {
      const rest = line.slice(i);
      // a new ability starts at a header token at the start, or after the end of a sentence or a lone keyword
      const prev = cur.trimEnd();
      const boundary = !prev || /[.!)]$/.test(prev) || /^\[(Blocker|Rush: Character|Rush|Double Attack|Banish|Unblockable)\]$/.test(prev);
      const m = START.exec(rest);
      if (m && boundary && prev) { out.push(prev); cur = ''; }
      cur += line[i]; i++;
    }
    if (cur.trim()) out.push(cur.trim());
  }
  return out;
}

// ------------------------------------------------------------ the parser
class ParseError extends Error {}
const fail = (msg) => { throw new ParseError(msg); };

export function compileText(def) {
  const abilities = [], errors = [];
  let idx = 0;
  for (const raw of splitAbilities(def.text || '')) {
    try { for (const ab of parseAbility(raw, def)) abilities.push({ idx: idx++, text: raw, ...ab }); }
    catch (e) { if (!(e instanceof ParseError)) throw e; errors.push(`${raw} -- ${e.message}`); }
  }
  if (def.trigger) {
    const raw = normalize(def.trigger).replace(/^\[Trigger\]\s*/, '');
    try { abilities.push({ idx: idx++, text: `[Trigger] ${raw}`, kind: 'trigger', ...parseCostEffect(raw, def, 'trigger') }); }
    catch (e) { if (!(e instanceof ParseError)) throw e; errors.push(`[Trigger] ${raw} -- ${e.message}`); }
  }
  return { abilities, errors };
}

function parseAbility(raw, def) {
  let s = raw;
  const head = { don: 0, turn: null, once: false, timings: [] };
  const kws = [];
  for (;;) {
    s = s.trim();
    let m;
    if ((m = /^\[DON!! x(\d+)\]/.exec(s))) head.don = +m[1];
    else if ((m = /^\[Your Turn\]/.exec(s))) head.turn = 'you';
    else if ((m = /^\[Opponent's Turn\]/.exec(s))) head.turn = 'opp';
    else if ((m = /^\[Once Per Turn\]/.exec(s))) head.once = true;
    else if ((m = /^\[(On Play|When Attacking|On Block|On K\.O\.|Activate: Main|Main|Counter|End of Your Turn|End of Your Opponent's Turn|On Your Opponent's Attack)\]/.exec(s))) head.timings.push(TIMING[m[1]]);
    else if ((m = /^\[(Blocker|Rush: Character|Rush|Double Attack|Banish|Unblockable)\]/.exec(s))) kws.push(m[1]);
    else if ((m = /^\s*\/\s*/.exec(s)) && head.timings.length) { /* [On Play]/[When Attacking] */ }
    else break;
    s = s.slice(m[0].length);
  }
  s = s.trim().replace(/\.$/, '').trim();
  if (kws.length) {
    if (s || head.timings.length) fail('keyword with more text');
    return kws.map(kw => ({ kind: 'keyword', kw, don: head.don, turn: head.turn, cond: null }));
  }
  const t = head.timings;
  if (t.includes('main') || t.includes('counter')) {
    if (def.cat !== 'E') fail('[Main]/[Counter] on a non-Event');
    return [{ kind: 'event', timings: t, ...parseCostEffect(s, def, 'event') }];
  }
  if (t.includes('activate')) {
    if (t.length > 1) fail('mixed timings');
    return [{ kind: 'activate', don: head.don, turn: head.turn, once: head.once, ...parseCostEffect(s, def, 'activate') }];
  }
  if (t.length) return [{ kind: 'auto', timings: t, don: head.don, turn: head.turn, once: head.once, ...parseCostEffect(s, def, 'auto') }];
  // no timing: a permanent effect, a replacement effect, or an auto effect with its own "when" (8-1-3-1-1)
  return [parseNoTiming(s, def, head)].flat();
}

// ------------------------------------------------------------ costs (8-3)
function splitCost(s) {
  // the activation cost is the part before the colon (not "choose one:")
  const i = s.search(/:(?!\s*•)/);
  if (i < 0) return null;
  const before = s.slice(0, i);
  if (/chooses? one\s*$/i.test(before)) return null;
  return [before.trim(), s.slice(i + 1).trim()];
}
function parseCostEffect(s, def, kind) {
  const out = { cost: [], optional: false, steps: [] };
  const sp = splitCost(s);
  let body = s;
  if (sp) { const c = parseCost(sp[0], def); out.cost = c.cost; out.optional = c.optional; out.costText = costText(sp[0]); body = sp[1]; }
  else {
    // "{R:3} You may trash 1 card from your hand: ..." handled above; a bare "{R:1}" with no colon is unusual
    if (/\{R\d+\}/.test(s)) fail('DON!! rest cost without a colon');
  }
  out.steps = parseEffect(body, def);
  return out;
}
// the cost for prompts: "Rest 3 DON!! and trash 1 card from your hand"
function costText(s) {
  return cap(s.replace(/\{R(\d+)\}\s*/g, (m, n) => `rest ${n} DON!!, `).replace(/[Yy]ou may /g, '').replace(/,\s*$/, '').replace(/,\s*(?=\S)/g, ', ').trim());
}
function parseCost(s, def) {
  let optional = false;
  const cost = [];
  let t = s.trim();
  for (;;) {
    t = t.replace(/^,?\s*(and\s+)?/, '').trim();
    if (!t) break;
    let m;
    if ((m = /^\{R(\d+)\}/.exec(t))) cost.push({ op: 'restDon', n: +m[1] });
    else if ((m = /^DON!! -\s?(\d+)/.exec(t))) cost.push({ op: 'returnDon', n: +m[1] });
    else if ((m = /^DON!! (\d+)(?=\s*(,|$))/.exec(t))) cost.push({ op: 'returnDon', n: +m[1] });
    else if ((m = /^[Yy]ou may /.exec(t))) optional = true;
    else if ((m = /^rest (?:this (?:Character|Stage|Leader|card))/i.exec(t))) cost.push({ op: 'restSelf' });
    else if ((m = /^rest (\d+) of your DON!! cards?/i.exec(t))) cost.push({ op: 'restDon', n: +m[1] });
    else if ((m = /^rest (\d+) of your ((?:(?!\band\b|,).)+?)(?=$|,| and )/i.exec(t))) cost.push({ op: 'restOwn', n: +m[1], ...ownCards(m[2], def) });
    else if ((m = /^rest your ((?:(?!\band\b|,).)+?) or (\d+) of your DON!! cards?/i.exec(t))) cost.push({ op: 'restLeaderOrDon', ...ownCards(m[1], def) });
    else if ((m = /^trash this (?:Character|card|Stage)/i.exec(t))) cost.push({ op: 'trashSelf' });
    else if ((m = /^trash (\d+|any number of) ((?:(?!\bfrom your hand\b).)*?)\s*from your hand/i.exec(t))) cost.push({ op: 'trashHand', n: m[1] === 'any number of' ? 0 : +m[1], ...handCards(m[2], def) });
    else if ((m = /^trash (\d+) cards? from the top of your deck/i.exec(t))) cost.push({ op: 'millSelf', n: +m[1] });
    else if ((m = /^reveal (\d+) ((?:(?!\bfrom your hand\b).)*?)\s*from your hand/i.exec(t))) cost.push({ op: 'revealHand', n: +m[1], ...handCards(m[2], def) });
    else if ((m = /^add 1 card from the top( or bottom)? of your Life cards to your hand/i.exec(t))) cost.push({ op: 'lifeToHand', where: m[1] ? 'topOrBottom' : 'top' });
    else if ((m = /^trash 1 card from the top( or bottom)? of your Life cards/i.exec(t))) cost.push({ op: 'trashLife', where: m[1] ? 'topOrBottom' : 'top' });
    else if ((m = /^turn 1 card from the top( or bottom)? of your Life cards face-(up|down)/i.exec(t))) cost.push({ op: m[2] === 'up' ? 'lifeFaceUp' : 'lifeFaceDown', where: m[1] ? 'topOrBottom' : 'top' });
    else if ((m = /^turn 1 of your face-up Life cards face-down/i.exec(t))) cost.push({ op: 'lifeFaceDown', where: 'any' });
    else if ((m = /^return (\d+) of your ((?:(?!\bto the owner's hand\b).)*?) to the owner's hand/i.exec(t))) cost.push({ op: 'bounceOwn', n: +m[1], ...ownCards(m[2], def) });
    else if ((m = /^place (\d+) cards? from your hand at the (top|bottom) of your deck/i.exec(t))) cost.push({ op: 'handToDeck', n: +m[1], bottom: m[2] === 'bottom' });
    else if ((m = /^place (\d+) cards? from your trash at the bottom of your deck/i.exec(t))) cost.push({ op: 'trashToDeck', n: +m[1] });
    else if ((m = /^return 1 or more DON!! cards from your field to your DON!! deck/i.exec(t))) cost.push({ op: 'returnDonAny' });
    else if ((m = /^return (\d+) total of your currently given DON!! cards to your cost area rested/i.exec(t))) cost.push({ op: 'returnGivenDon', n: +m[1] });
    else if ((m = /^add 1 of your ((?:(?!\bto the top of your Life cards\b).)*?) to the top of your Life cards face-up/i.exec(t))) cost.push({ op: 'charToLife', ...ownCards(m[1], def) });
    else if ((m = /^return this (?:Character|card) to the owner's hand/i.exec(t))) cost.push({ op: 'bounceSelf' });
    // "rest 1 of your DON!! cards and this Character": the verb carries over
    else if ((m = /^this (?:Character|Stage|card)(?=$|,| and )/i.exec(t)) && cost.length && ['restDon', 'restOwn'].includes(cost[cost.length - 1].op)) cost.push({ op: 'restSelf' });
    else fail(`cost "${t}"`);
    t = t.slice(m[0].length);
  }
  // ① and DON!! −X: "You may rest / return the specified number of DON!! cards" (their printed reminder, 8-3-1-4)
  if (cost.some(c => c.op === 'restDon' || c.op === 'returnDon')) optional = true;
  return { cost, optional };
}
// "1 black {Navy} type card" in a hand cost: { cats, f }
function handCards(s, def) {
  const sel = parseSel(`up to 1 ${s.trim()}`, def, { zone: 'hand' });
  if (!sel) fail(`hand cards "${s}"`);
  return { cats: sel.cats, f: sel.f };
}
function ownCards(s, def) {
  const sel = parseSel(`up to 1 of your ${s.trim()}`, def);
  if (!sel) fail(`own cards "${s}"`);
  return { cats: sel.cats, f: sel.f, notSelf: sel.f.some(f => f.k === 'notSelf') };
}

// ------------------------------------------------------------ card descriptions
// "up to 1 of your opponent's rested Characters with a cost of 3 or less" -> { who, n, upTo, all, cats, f }
const CAT_NOUNS = [
  [/^Leader or Character cards?\b/, ['L', 'C']], [/^Leaders? and Characters?\b/, ['L', 'C']], [/^Leaders? or Characters?\b/, ['L', 'C']],
  [/^DON!! cards or Characters\b/, ['DON', 'C']],
  [/^Character cards?\b/, ['C']], [/^Characters?\b/, ['C']], [/^Event cards?\b/, ['E']], [/^Events?\b/, ['E']], [/^Stage cards?\b/, ['S']], [/^Stages?\b/, ['S']],
  [/^Leaders?\b/, ['L']], [/^cards?\b/, null],
];
export function parseSel(phrase, def, { zone = 'field' } = {}) {
  let s = phrase.trim();
  const sel = { who: 'any', n: 1, upTo: false, all: false, cats: null, f: [], zone };
  let m;
  if ((m = /^up to (\d+|1 each of)\s*/i.exec(s))) { sel.upTo = true; sel.n = +m[1] || 1; s = s.slice(m[0].length); }
  else if ((m = /^all of\s+|^all\s+/i.exec(s))) { sel.all = true; s = s.slice(m[0].length); }
  else if ((m = /^(\d+)\s+/.exec(s))) { sel.n = +m[1]; s = s.slice(m[0].length); }
  if ((m = /^of\s+/.exec(s))) s = s.slice(m[0].length);
  if ((m = /^your opponent's\s+/.exec(s))) { sel.who = 'opp'; s = s.slice(m[0].length); }
  else if ((m = /^your\s+/.exec(s))) { sel.who = 'you'; s = s.slice(m[0].length); }
  else if ((m = /^the opponent's\s+/.exec(s))) { sel.who = 'opp'; s = s.slice(m[0].length); }
  // adjectives and qualifiers before the noun
  for (;;) {
    if ((m = /^rested\s+/.exec(s))) sel.f.push({ k: 'rested' });
    else if ((m = /^active\s+/.exec(s))) sel.f.push({ k: 'active' });
    else if ((m = /^(red|green|blue|purple|black|yellow)\s+/.exec(s))) sel.f.push({ k: 'color', any: [cap(m[1])] });
    else if ((m = /^multicolou?red\s+/.exec(s))) sel.f.push({ k: 'multicolor' });
    else if ((m = /^face-up\s+/.exec(s))) sel.f.push({ k: 'faceUp', v: true });
    // alternatives of different kinds: "[Sanji] or {Big Mom Pirates} type", "{Muggy Kingdom} type or <Slash> attribute"
    else if ((m = /^\[([^\]]+)\] or \{([^}]+)\} type\s+/.exec(s))) sel.f.push({ k: 'or', any: [[{ k: 'name', any: [m[1]] }], [{ k: 'trait', any: [m[2]] }]] });
    else if ((m = /^\{([^}]+)\} type or <([^>]+)> attribute\s+/.exec(s))) sel.f.push({ k: 'or', any: [[{ k: 'trait', any: [m[1]] }], [{ k: 'attr', any: [m[2]] }]] });
    else if ((m = /^\{([^}]+)\} type card or card with a type including "([^"]+)"\s*/.exec(s))) { sel.f.push({ k: 'or', any: [[{ k: 'trait', any: [m[1]] }], [{ k: 'traitHas', any: [m[2]] }]] }); s = 'card ' + s.slice(m[0].length); continue; }
    // "<Slash> attribute card or green Event"
    else if ((m = /^<([^>]+)> attribute card or (red|green|blue|purple|black|yellow) (Event|Character|Stage)\b\s*/.exec(s))) { sel.f.push({ k: 'or', any: [[{ k: 'attr', any: [m[1]] }], [{ k: 'color', any: [cap(m[2])] }, { k: 'cat', any: [m[3][0]] }]] }); s = 'card ' + s.slice(m[0].length); continue; }
    else if ((m = /^((?:\{[^}]+\}|"[^"]+")(?:,? (?:or )?(?:\{[^}]+\}|"[^"]+"))*) type\s+/.exec(s))) sel.f.push({ k: 'trait', any: [...m[1].matchAll(/\{([^}]+)\}|"([^"]+)"/g)].map(x => x[1] || x[2]) });
    else if ((m = /^((?:\[[^\]]+\])(?:,? (?:and |or )?(?:\[[^\]]+\]))*)(?:\s+|$)(?=(?:type\s+)?(?:Leader|Character|card|Event|Stage|with|cards|other|$))/.exec(s))) {
      const names = [...m[1].matchAll(/\[([^\]]+)\]/g)].map(x => x[1]);
      if (names.every(n => KW.includes(n))) sel.f.push({ k: 'kw', kw: names[0] });
      else if (/^type\s/.test(s.slice(m[0].length))) { sel.f.push({ k: 'trait', any: names }); s = s.slice(m[0].length); m = /^type\s+/.exec(s); }
      else sel.f.push({ k: 'name', any: names });
    }
    else if ((m = /^<([^>]+)> attribute\s+/.exec(s))) sel.f.push({ k: 'attr', any: [m[1]] });
    else if ((m = /^"([^"]+)" attribute\s+/.exec(s))) sel.f.push({ k: 'attr', any: [m[1]] });
    else if ((m = /^attribute\s+/.exec(s))) fail('a missing attribute');
    else break;
    s = s.slice(m[0].length);
  }
  let noun = false;
  for (const [re, cats] of CAT_NOUNS) if ((m = re.exec(s))) { sel.cats = cats; s = s.slice(m[0].length).trim(); noun = true; break; }
  // "[Pacifista] with a cost of 4 or less": a name stands for the card
  if (!noun && !sel.f.some(f => f.k === 'name')) return null;
  if (sel.cats && sel.cats.includes('DON')) return null;
  // after the noun
  for (;;) {
    s = s.trim();
    if (!s) break;
    if ((m = /^on your field\b/.exec(s))) { if (sel.who === 'any') sel.who = 'you'; }
    // "your Character [Bonk Punch]"
    else if ((m = /^\[([^\]]+)\](?=\s|$)/.exec(s))) sel.f.push({ k: 'name', any: [m[1]] });
    // "with a cost of 3 or 4"
    else if ((m = /^(?:with|and) a (base )?cost of (\d+) or (\d+)\b/.exec(s))) sel.f.push({ k: 'or', any: [[{ k: m[1] ? 'baseCost' : 'cost', op: '=', n: +m[2] }], [{ k: m[1] ? 'baseCost' : 'cost', op: '=', n: +m[3] }]] });
    else if ((m = /^(?:with|and) a (base )?cost of (\d+) or (less|more)\b/.exec(s))) sel.f.push({ k: m[1] ? 'baseCost' : 'cost', op: m[3] === 'less' ? '<=' : '>=', n: +m[2] });
    else if ((m = /^(?:with|and) a (base )?cost of (\d+) to (\d+)\b/.exec(s))) sel.f.push({ k: 'costRange', lo: +m[2], hi: +m[3] });
    else if ((m = /^(?:with|and) a (base )?cost of (\d+)\b/.exec(s))) sel.f.push({ k: m[1] ? 'baseCost' : 'cost', op: '=', n: +m[2] });
    else if ((m = /^(?:with|and) a (base )?cost equal to or less than (.+?)(?= other than| from |$)/.exec(s))) sel.f.push({ k: m[1] ? 'baseCost' : 'cost', op: '<=', n: parseAmount(m[2]) });
    else if ((m = /^(?:with|and|that has|that have) (\d+) (base )?power or (less|more)\b/.exec(s))) sel.f.push({ k: m[2] ? 'basePower' : 'power', op: m[3] === 'less' ? '<=' : '>=', n: +m[1] });
    else if ((m = /^(?:with|and|that has|that have) (\d+) or (less|more) (base )?power\b/.exec(s))) sel.f.push({ k: m[3] ? 'basePower' : 'power', op: m[2] === 'less' ? '<=' : '>=', n: +m[1] });
    else if ((m = /^(?:with|and) a base power of (\d+) or (less|more)\b/.exec(s))) sel.f.push({ k: 'basePower', op: m[2] === 'less' ? '<=' : '>=', n: +m[1] });
    else if ((m = /^(?:with|and) (\d+) (base )?power\b/.exec(s))) sel.f.push({ k: m[2] ? 'basePower' : 'power', op: '=', n: +m[1] });
    else if ((m = /^(?:with|and) the ((?:\{[^}]+\}|"[^"]+")) type\b/.exec(s))) sel.f.push({ k: 'trait', any: [m[1].slice(1, -1)] });
    else if ((m = /^with a type including "([^"]+)"/.exec(s))) sel.f.push({ k: 'traitHas', any: [m[1]] });
    else if ((m = /^with a \[Trigger\]/.exec(s))) sel.f.push({ k: 'hasTrigger' });
    // "no base effect": no card text at all (2-8-5)
    else if ((m = /^(?:and|with) no base effect\b/.exec(s))) sel.f.push({ k: 'vanilla' });
    else if ((m = /^other than (?:this (?:card|Character|Leader))\b/.exec(s))) sel.f.push({ k: 'notSelf' });
    else if ((m = /^other than ((?:\[[^\]]+\])(?:,? (?:or |and )?\[[^\]]+\])*)/.exec(s))) sel.f.push({ k: 'notName', any: [...m[1].matchAll(/\[([^\]]+)\]/g)].map(x => x[1]) });
    else if ((m = /^that is either \[([^\]]+)\] or has the <([^>]+)> attribute/.exec(s))) sel.f.push({ k: 'or', any: [[{ k: 'name', any: [m[1]] }], [{ k: 'attr', any: [m[2]] }]] });
    else break;
    s = s.slice(m[0].length);
  }
  sel.rest = s.trim();
  return sel;
}
// a description that must use up the whole phrase
function sel(phrase, def, opts) {
  const x = parseSel(phrase, def, opts);
  if (!x || x.rest) fail(`description "${phrase}"${x && x.rest ? ` (left: "${x.rest}")` : ''}`);
  delete x.rest;
  return x;
}
// the cards an effect points at: a description, or "this Character", "your Leader" ...
function target(phrase, def) {
  const p = phrase.trim();
  if (/^this (Character|card|Leader|Stage)$/i.test(p)) return { ref: 'self' };
  if (/^(your Leader|this Leader)$/i.test(p)) return { ref: 'leader' };
  let m;
  if ((m = /^[Yy]our (.+?) Leader$/.exec(p))) {
    const x = parseSel(`up to 1 of your ${m[1]} Leader`, def);
    if (x && !x.rest) return { ref: 'leader', f: x.f };
  }
  if ((m = /^up to 1 of your Leader$/.exec(p))) return { ref: 'leader' };
  if (/^(?:this|your) Leader or 1 of your Characters$/i.test(p)) { const x = sel('up to 1 of your Leader or Character cards', def); x.upTo = false; return x; }
  if ((m = /^that (Leader or Character|Character|card)$/i.exec(p))) return { ref: 'selected' };
  if (/^the opponent's (Character|Leader or Character) (you battled with|this Character battled with|battling this Character)$/.test(p)) return { ref: 'battleOpp' };
  return sel(p, def);
}
function parseAmount(s) {
  const t = s.trim();
  let m;
  if ((m = /^(\d+)$/.exec(t))) return +m[1];
  if (/^the number of your opponent's Life cards$/.test(t)) return { k: 'life', who: 'opp' };
  if (/^the number of your Life cards$/.test(t)) return { k: 'life', who: 'you' };
  if (/^the total of your and your opponent's Life cards$/.test(t)) return { k: 'lifeTotal' };
  if (/^the number of DON!! cards on your opponent's field$/.test(t)) return { k: 'donField', who: 'opp' };
  fail(`amount "${s}"`);
}
function dur(s) {
  const t = (s || '').trim();
  if (!t) return null;
  if (t === 'during this turn') return 'turn';
  if (t === 'during this battle') return 'battle';
  if (t === 'until the start of your next turn') return 'startOfYourNextTurn';
  if (/^until the end of your opponent's next (turn|End Phase)$/.test(t)) return 'endOfOppNextTurn';
  if (t === 'until the end of your next turn') return 'endOfYourNextTurn';
  fail(`duration "${s}"`);
}

// ------------------------------------------------------------ conditions ("If ...")
function count(who, cats, f = []) { return { k: 'count', sel: { who, cats, f } }; }
const cmpWord = w => (w === 'less' ? '<=' : '>=');
export function parseCond(s, def) {
  let t = s.trim().replace(/^[Ii]f /, '');
  let m;
  // "A and B"
  const parts = splitTop(t, ' and ');
  if (parts.length > 1) {
    // "you have 6 or less cards in your hand and a Character with a cost of 8 or more": the subject carries over
    try { return { k: 'and', all: parts.map((x, i) => parseCond(i && /^an? /.test(x) ? `you have ${x}` : x, def)) }; } catch (e) { if (!(e instanceof ParseError)) throw e; }
    // "your Leader has the {Supernovas} type and you and your opponent have a total of ...": split where both sides read
    for (let k = 1; k < parts.length; k++) {
      try { return { k: 'and', all: [parseCond(parts.slice(0, k).join(' and '), def), parseCond(parts.slice(k).join(' and '), def)] }; } catch (e) { if (!(e instanceof ParseError)) throw e; }
    }
  }
  if ((m = /^you have a total of (\d+) or (more|less) given DON!! cards$/.exec(t))) return { k: 'cmp', a: { k: 'givenDon', who: 'you' }, op: cmpWord(m[2]), b: +m[1] };
  if ((m = /^this (Leader|Character) battles your opponent's Character during this turn$/.exec(t))) return { k: 'self', f: [{ k: 'battledChar' }] };
  if ((m = /^the revealed card has the chosen cost$/.exec(t))) return { k: 'chosenCost' };
  if ((m = /^you have (\d+) or (more|less) (rested )?Characters$/.exec(t))) return { k: 'cmp', a: count('you', ['C'], m[3] ? [{ k: 'rested' }] : []), op: cmpWord(m[2]), b: +m[1] };
  if ((m = /^you have (\d+) or (more|less) Characters with a (base )?cost of (\d+) or more$/.exec(t))) return { k: 'cmp', a: count('you', ['C'], [{ k: m[3] ? 'baseCost' : 'cost', op: '>=', n: +m[4] }]), op: cmpWord(m[2]), b: +m[1] };
  if ((m = /^you have (\d+) or (more|less) Characters with (\d+) base power$/.exec(t))) return { k: 'cmp', a: count('you', ['C'], [{ k: 'basePower', op: '=', n: +m[3] }]), op: cmpWord(m[2]), b: +m[1] };
  if ((m = /^(you|your opponent) (?:have|has) (\d+) or (more|less) Life cards$/.exec(t))) return { k: 'cmp', a: { k: 'life', who: m[1] === 'you' ? 'you' : 'opp' }, op: cmpWord(m[3]), b: +m[2] };
  if ((m = /^(you|your opponent) (?:have|has) (\d+) Life cards$/.exec(t))) return { k: 'cmp', a: { k: 'life', who: m[1] === 'you' ? 'you' : 'opp' }, op: '=', b: +m[2] };
  if ((m = /^you and your opponent have a total of (\d+) or (more|less) Life cards$/.exec(t))) return { k: 'cmp', a: { k: 'lifeTotal' }, op: cmpWord(m[2]), b: +m[1] };
  if ((m = /^(you|your opponent) (?:have|has) (\d+) or (more|less) cards in (?:your|their) hand$/.exec(t))) return { k: 'cmp', a: { k: 'hand', who: m[1] === 'you' ? 'you' : 'opp' }, op: cmpWord(m[3]), b: +m[2] };
  if ((m = /^(you|your opponent) (?:have|has) (\d+) or (more|less) DON!! cards on (?:your|their) field$/.exec(t))) return { k: 'cmp', a: { k: 'donField', who: m[1] === 'you' ? 'you' : 'opp' }, op: cmpWord(m[3]), b: +m[2] };
  if ((m = /^you have (\d+) DON!! cards on your field$/.exec(t))) return { k: 'cmp', a: { k: 'donField', who: 'you' }, op: '=', b: +m[1] };
  if ((m = /^you have (\d+) DON!! cards on your field or (\d+) or more DON!! cards on your field$/.exec(t))) return { k: 'or', any: [{ k: 'cmp', a: { k: 'donField', who: 'you' }, op: '=', b: +m[1] }, { k: 'cmp', a: { k: 'donField', who: 'you' }, op: '>=', b: +m[2] }] };
  if ((m = /^you have (\d+) or (\d+) or more DON!! cards on your field$/.exec(t))) return { k: 'or', any: [{ k: 'cmp', a: { k: 'donField', who: 'you' }, op: '=', b: +m[1] }, { k: 'cmp', a: { k: 'donField', who: 'you' }, op: '>=', b: +m[2] }] };
  if ((m = /^you have (\d+) or more rested DON!! cards$/.exec(t))) return { k: 'cmp', a: { k: 'donRested', who: 'you' }, op: '>=', b: +m[1] };
  if ((m = /^your opponent has more DON!! cards on their field than you$/.exec(t))) return { k: 'cmp', a: { k: 'donField', who: 'opp' }, op: '>', b: { k: 'donField', who: 'you' } };
  if ((m = /^the number of DON!! cards on your field is equal to or less than the number on your opponent's field$/.exec(t))) return { k: 'cmp', a: { k: 'donField', who: 'you' }, op: '<=', b: { k: 'donField', who: 'opp' } };
  if ((m = /^the number of your Life cards is equal to or less than the number of your opponent's Life cards$/.exec(t))) return { k: 'cmp', a: { k: 'life', who: 'you' }, op: '<=', b: { k: 'life', who: 'opp' } };
  if ((m = /^you have less Life cards than your opponent$/.exec(t))) return { k: 'cmp', a: { k: 'life', who: 'you' }, op: '<', b: { k: 'life', who: 'opp' } };
  if ((m = /^your Leader is \[([^\]]+)\]$/.exec(t))) return { k: 'leader', who: 'you', f: [{ k: 'name', any: [m[1]] }] };
  if ((m = /^your Leader has the (?:\{([^}]+)\}|"([^"]+)"|\[([^\]]+)\]) type$/.exec(t))) return { k: 'leader', who: 'you', f: [{ k: 'trait', any: [m[1] || m[2] || m[3]] }] };
  if ((m = /^your Leader has the <([^>]+)> attribute$/.exec(t))) return { k: 'leader', who: 'you', f: [{ k: 'attr', any: [m[1]] }] };
  if ((m = /^your Leader's type includes "([^"]+)"$/.exec(t))) return { k: 'leader', who: 'you', f: [{ k: 'traitHas', any: [m[1]] }] };
  if ((m = /^your Leader is multicolou?red$/.exec(t))) return { k: 'leader', who: 'you', f: [{ k: 'multicolor' }] };
  if ((m = /^there is a (.+)$/.exec(t))) return { k: 'exists', sel: sel(`up to 1 ${m[1]}`, def) };
  if ((m = /^you do not have (.+)$/.exec(t))) return { k: 'not', c: parseCond(`you have ${m[1]}`, def) };
  if ((m = /^your Leader has the \{([^}]+)\} type or is \[([^\]]+)\]$/.exec(t))) return { k: 'leader', who: 'you', f: [{ k: 'or', any: [[{ k: 'trait', any: [m[1]] }], [{ k: 'name', any: [m[2]] }]] }] };
  // "you have 5 Characters with a cost of 5 or more": at least that many
  if ((m = /^you have (\d+) (Characters? .+)$/.exec(t))) return { k: 'exists', sel: sel(`up to 1 of your ${m[2]}`, def), n: +m[1] };
  // rested cards: Leader, Characters, Stage and the cost area's DON!! cards
  if ((m = /^you have (\d+) or more rested cards$/.exec(t))) return { k: 'cmp', a: { k: 'restedCards', who: 'you' }, op: '>=', b: +m[1] };
  if ((m = /^(you|your opponent) (?:have|has) (an?|\d+ or more) (.+)$/.exec(t))) {
    const n = /^\d/.test(m[2]) ? parseInt(m[2], 10) : 1;
    const x = sel(`up to 1 of ${m[1] === 'you' ? 'your' : "your opponent's"} ${m[3]}`, def);
    return { k: 'exists', sel: x, n };
  }
  if ((m = /^you have (\[[^\]]+\]) and (\[[^\]]+\]) (Characters.*)$/.exec(t))) return { k: 'and', all: [m[1], m[2]].map(nm => ({ k: 'exists', sel: sel(`up to 1 of your ${nm} ${m[3].replace(/^Characters/, 'Character')}`, def) })) };
  if ((m = /^this Character is rested$/.exec(t))) return { k: 'self', f: [{ k: 'rested' }] };
  if ((m = /^this Character was played on this turn$/.exec(t))) return { k: 'self', f: [{ k: 'playedThisTurn' }] };
  // "that card": the card the effect just revealed or chose
  if ((m = /^that card is an? (.+)$/.exec(t))) { const x = sel(`up to 1 ${m[1]}`, def, { zone: 'deck' }); return { k: 'that', cats: x.cats, f: x.f }; }
  if ((m = /^that card's type includes "([^"]+)"$/.exec(t))) return { k: 'that', f: [{ k: 'traitHas', any: [m[1]] }] };
  fail(`condition "${s}"`);
}
// split at a separator outside brackets and quotes
function splitTop(s, sep) {
  const out = [];
  let depth = 0, q = false, last = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') q = !q;
    else if (!q && (ch === '[' || ch === '{' || ch === '<')) depth++;
    else if (!q && (ch === ']' || ch === '}' || ch === '>')) depth--;
    else if (!q && !depth && s.startsWith(sep, i)) { out.push(s.slice(last, i)); last = i + sep.length; i += sep.length - 1; }
  }
  out.push(s.slice(last));
  return out.map(x => x.trim()).filter(Boolean);
}

// ------------------------------------------------------------ effects: sentences and clauses
export function parseEffect(text, def) {
  const steps = [];
  let t = text.trim().replace(/\.$/, '');
  if (!t) fail('no effect');
  // "choose one: • A • B"
  let m;
  if ((m = /^(?:(.*?),\s*)?(Your opponent chooses|[Cc]hoose) one:\s*(•[\s\S]*)$/.exec(t))) {
    const options = m[3].split('•').map(x => x.trim().replace(/\.$/, '')).filter(Boolean).map(x => ({ text: x, steps: parseEffect(x, def) }));
    const step = { op: 'choose', oppChooses: /opponent/.test(m[2]), options };
    if (m[1]) { const c = parseCond(m[1], def); step.cond = c; step.gate = true; }
    return [step];
  }
  const sentences = splitSentences(t);
  for (let i = 0; i < sentences.length; i++) {
    let s = sentences[i];
    let then = false;
    if (/^Then,\s*/.test(s)) { then = true; s = cap(s.replace(/^Then,\s*/, '')); }
    // "You may X. If you do, Y."
    if (/^[Yy]ou may /.test(s) && sentences[i + 1] && /^If you do, /.test(sentences[i + 1])) {
      const body = s.replace(/^[Yy]ou may /, '');
      const nxt = sentences[i + 1].replace(/^If you do, /, '');
      steps.push({ op: 'may', text: cap(s), steps: parseClauses(body, def), then: parseClauses(nxt, def) });
      i++;
      continue;
    }
    // "If you do, Y" after an optional cost that is part of the previous clause
    if (/^If you do, /.test(s)) { const st = parseClauses(s.replace(/^If you do, /, ''), def); for (const x of st) x.cond = { k: 'did' }; steps.push(...st); continue; }
    // ST21-003: "Select ... . If the selected Character attacks during this turn, your opponent cannot activate [Blocker]."
    if (/^If the selected (?:Leader or Character|Character) attacks during this turn, your opponent cannot activate \[Blocker\]$/.test(s)) { steps.push({ op: 'noBlockerIfAttacks', sel: { ref: 'selected' }, dur: 'turn' }); continue; }
    const st = parseSentence(s, def);
    void then;
    steps.push(...st);
  }
  return mergeLook(steps);
}
function splitSentences(t) {
  // split at ". " outside brackets/quotes
  const out = [];
  let depth = 0, q = false, last = 0;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '"') q = !q;
    else if (!q && (ch === '[' || ch === '{' || ch === '<' || ch === '(')) depth++;
    else if (!q && (ch === ']' || ch === '}' || ch === '>' || ch === ')')) depth--;
    else if (!q && !depth && ch === '.' && (t[i + 1] === ' ' || t[i + 1] === '\n' || i === t.length - 1) && !/K\.O$|K$/.test(t.slice(Math.max(0, i - 3), i)) && !/\bK\.O\.$/.test(t.slice(0, i + 1)) && !/Mr\.$|Dr\.$|D\.$|Jr\.$|St\.$/.test(t.slice(Math.max(0, i - 3), i + 1))) {
      out.push(t.slice(last, i).trim()); last = i + 1;
    }
  }
  out.push(t.slice(last).trim());
  return out.filter(Boolean);
}
// a sentence: an optional "If ..., " condition, then clauses
function parseSentence(s, def) {
  let m;
  const t = s.trim();
  // "If X, Y" (4-10, 8-3-3)
  if ((m = /^If (.+?), ((?:[a-z]|K\.O\.|[A-Z][a-z]* ).*)$/.exec(t))) {
    // the condition ends at the first comma that leaves a parsable rest
    const cands = [];
    for (let i = 0; i < t.length; i++) if (t[i] === ',' && t[i + 1] === ' ') cands.push(i);
    for (const i of cands) {
      const condS = t.slice(3, i), rest = t.slice(i + 2);
      let cond;
      try { cond = parseCond(condS, def); } catch (e) { if (!(e instanceof ParseError)) throw e; continue; }
      const st = parseClauses(rest, def);
      for (const x of st) x.cond = x.cond ? { k: 'and', all: [cond, x.cond] } : cond;
      st[0].gate = false;
      return st;
    }
    fail(`condition in "${t}"`);
  }
  // ST31-004: "For every {Straw Hat Crew} type card on your field, give up to 1 of your opponent's Characters -1000
  // power during this turn": the number scales with the count
  if ((m = /^For every (.+?) on your field, (.+)$/.exec(t))) {
    const x = sel(`up to 1 of your ${m[1]}`, def);
    const of = { k: 'count', sel: { who: 'you', cats: x.cats || ['L', 'C', 'S'], f: x.f } };
    const st = parseClauses(m[2], def);
    if (st.length !== 1 || typeof st[0].n !== 'number' || st[0].op !== 'power') fail(`"for every" in "${t}"`);
    st[0].n = { k: 'per', each: st[0].n, of };
    return st;
  }
  // "X if you have N or less cards in your hand" (a trailing condition)
  if ((m = /^(.+?) if (you have .+|your opponent has .+)$/.exec(t))) {
    try { const cond = parseCond(m[2], def); const st = parseClauses(m[1], def); for (const x of st) x.cond = cond; return st; } catch (e) { if (!(e instanceof ParseError)) throw e; }
  }
  return parseClauses(t, def);
}
// one or more clauses joined by ", then", " and", ", and"
function parseClauses(text, def) {
  const t = text.trim().replace(/\.$/, '');
  const one = tryClause(t, def);
  if (one) return one;
  // split at the first joiner where both sides parse
  const joins = [', then ', ', and ', ' and ', ', '];
  for (const j of joins) {
    const parts = splitTop(t, j);
    if (parts.length < 2) continue;
    for (let k = 1; k < parts.length; k++) {
      const left = parts.slice(0, k).join(j), right = parts.slice(k).join(j);
      const a = tryClause(left, def);
      if (!a) continue;
      let b;
      try { b = parseClauses(cap(right), def); } catch (e) { if (!(e instanceof ParseError)) throw e; continue; }
      return [...a, ...b];
    }
  }
  fail(`clause "${t}"`);
}
function tryClause(t, def) {
  try { return parseClause(t, def); } catch (e) { if (e instanceof ParseError) return null; throw e; }
}

// the verbs of card text
function parseClause(text, def) {
  const t = text.trim().replace(/\.$/, '');
  let m;
  // ---- "... at the end of this turn": a delayed effect (6-6-1-2)
  if ((m = /^(.+) at the end of this turn$/.exec(t))) return [{ op: 'delayed', steps: parseClause(cap(m[1]), def) }];
  // ---- K.O.
  if ((m = /^K\.O\. (.+)$/i.exec(t))) return [{ op: 'ko', sel: target(m[1], def) }];
  // ---- rest / set active
  if ((m = /^[Rr]est up to (\d+) of your opponent's DON!! cards?$/.exec(t))) return [{ op: 'restDon', who: 'opp', n: +m[1], upTo: true }];
  if ((m = /^[Rr]est (.+?)( and that Character will not become active in your opponent's next Refresh Phase)?$/.exec(t)) && !/DON!!/.test(m[1])) return [{ op: 'rest', sel: target(m[1], def), noRefresh: !!m[2] }];
  if ((m = /^[Ss]et up to (\d+) of your DON!! cards as active$/.exec(t))) return [{ op: 'donActive', n: +m[1], upTo: true }];
  if ((m = /^[Ss]et (.+?) as active$/.exec(t))) return [{ op: 'setActive', sel: target(m[1], def) }];
  if ((m = /^(.+?) will not become active in your opponent's next Refresh Phase$/.exec(t))) return [{ op: 'freeze', sel: target(cap(m[1]).replace(/^Up to/, 'up to'), def) }];
  // ---- power
  // "+1000 power during this battle for every card trashed / returned Character"
  if ((m = /^(.+?) gains? ([+-]\d+) power (.+?) for every (card trashed|returned Character)$/.exec(t))) return [{ op: 'power', sel: target(m[1], def), n: { k: 'per', each: +m[2], of: { k: 'var', name: m[4] === 'card trashed' ? 'trashed' : 'returned' } }, dur: dur(m[3]) || fail('power with no duration') }];
  if ((m = /^(.+?) gains? (?:an additional )?([+-]\d+) power(?: (.+))?$/.exec(t)) && !/^give /i.test(t)) {
    const d = dur(m[3]);
    if (!d) fail('power with no duration in an effect');
    return [{ op: 'power', sel: target(m[1], def), n: +m[2], dur: d }];
  }
  if ((m = /^[Gg]ive (.+?) (-?\d+) power(?: (.+))?$/.exec(t))) {
    const d = dur(m[3]) || fail('power with no duration');
    return [{ op: 'power', sel: target(m[1], def), n: -Math.abs(+m[2]), dur: d }];
  }
  if ((m = /^(.+?)'s? base power becomes (\d+)(?: (.+))?$/.exec(t))) return [{ op: 'basePower', sel: target(m[1], def), value: +m[2], dur: dur(m[3]) || fail('base power with no duration') }];
  // ---- cost
  if ((m = /^[Gg]ive (.+?) ([+-]?\d+) cost(?: (.+))?$/.exec(t))) return [{ op: 'cost', sel: target(m[1], def), n: /^\+/.test(m[2]) ? +m[2] : -Math.abs(+m[2]), dur: dur(m[3]) || fail('cost with no duration') }];
  if ((m = /^(.+?) gains? \+(\d+) cost (.+)$/.exec(t))) return [{ op: 'cost', sel: target(m[1], def), n: +m[2], dur: dur(m[3]) }];
  // ---- keywords for a while
  if ((m = /^(.+?) gains? \[(Rush|Blocker|Double Attack|Banish|Unblockable|Rush: Character)\](?: and ([+-]\d+) power)? (during this (?:turn|battle)|until .+)$/.exec(t))) {
    const out = [{ op: 'grant', sel: target(m[1], def), kw: m[2], dur: dur(m[4]) }];
    if (m[3]) out.push({ op: 'power', sel: target(m[1], def), n: +m[3], dur: dur(m[4]) });
    return out;
  }
  // "[On Play] ... this Character gains [Rush]" with no duration: for as long as it stays on the field
  if ((m = /^(this Character|this Leader) gains? \[(Rush|Blocker|Double Attack|Banish|Unblockable|Rush: Character)\]$/i.exec(t))) return [{ op: 'grant', sel: target(m[1], def), kw: m[2], dur: 'game' }];
  // ---- DON!!
  if ((m = /^[Gg]ive (.+?) up to (\d+) rested DON!! cards?(?: each)?$/.exec(t))) return [{ op: 'giveDon', sel: target(m[1], def), n: +m[2], upTo: true }];
  if ((m = /^[Aa]dd up to (\d+) additional DON!! cards? and (set (?:it|them) as active|rest (?:it|them))$/.exec(t))) return [{ op: 'addDon', n: +m[1], rested: /^rest/.test(m[2]) }];
  if ((m = /^[Gg]ive up to (\d+) rested DON!! cards? to (.+)$/.exec(t))) return [{ op: 'giveDon', sel: donTarget(m[2], def), n: +m[1], upTo: true }];
  if ((m = /^[Aa]dd up to (\d+) DON!! cards? from your DON!! deck and (set (?:it|them) as active|rest (?:it|them))$/.exec(t))) return [{ op: 'addDon', n: +m[1], rested: /^rest/.test(m[2]) }];
  if ((m = /^[Aa]dd (\d+) DON!! cards? from your DON!! deck and (set (?:it|them) as active|rest (?:it|them))$/.exec(t))) return [{ op: 'addDon', n: +m[1], rested: /^rest/.test(m[2]) }];
  // ---- cards
  if ((m = /^[Dd]raw (\d+) cards?$/.exec(t))) return [{ op: 'draw', n: +m[1] }];
  if (/^[Dd]raw cards equal to the number of cards trashed$/.test(t)) return [{ op: 'draw', n: { k: 'eventN' } }];
  if ((m = /^[Tt]rash (\d+) cards? from your hand$/.exec(t))) return [{ op: 'discard', n: +m[1] }];
  if ((m = /^[Yy]our opponent trashes (\d+) cards? from their hand$/.exec(t))) return [{ op: 'discard', who: 'opp', n: +m[1] }];
  // the player of the effect chooses (8-4-4-3), without seeing them (3-4-3)
  if ((m = /^[Tt]rash (\d+) cards? from your opponent's hand$/.exec(t))) return [{ op: 'discard', who: 'opp', n: +m[1], blind: true }];
  if ((m = /^[Yy]our opponent chooses (\d+) cards? from their hand and trashes (?:it|them)$/.exec(t))) return [{ op: 'discard', who: 'opp', n: +m[1] }];
  if ((m = /^[Rr]eturn (.+?) to the owner's hand$/.exec(t))) return [{ op: 'bounce', sel: target(m[1], def) }];
  if ((m = /^[Pp]lace (.+?) at the bottom of the owner's deck$/.exec(t))) return [{ op: 'bottom', sel: target(m[1], def) }];
  if ((m = /^[Ll]ook at (\d+) cards? from the top of your deck(?:;|,) reveal up to (\d+) (.+?) and add (?:it|them) to your hand$/.exec(t))) {
    const x = sel(`up to ${m[2]} ${m[3]}`, def, { zone: 'deck' });
    return [{ op: 'look', n: +m[1], pick: { max: +m[2], cats: x.cats, f: x.f, to: 'hand' } }];
  }
  // ST13-002 Ace: "Look at 5 cards from the top of your deck and add up to 1 Character card with a cost of 5 to the top of
  // your Life cards face-up"
  if ((m = /^[Ll]ook at (\d+) cards? from the top of your deck and add up to (\d+) (.+?) to the top of your Life cards( face-up)?$/.exec(t))) {
    const x = sel(`up to ${m[2]} ${m[3]}`, def, { zone: 'deck' });
    return [{ op: 'look', n: +m[1], pick: { max: +m[2], cats: x.cats, f: x.f, to: 'life', faceUp: !!m[4] } }];
  }
  if ((m = /^[Pp]lace the rest at the (bottom|top) of your deck(?: in any order)?$/.exec(t))) return [{ op: 'rest', placeRest: m[1] }];
  if ((m = /^[Tt]rash the rest$/.exec(t))) return [{ op: 'rest', placeRest: 'trash' }];
  if ((m = /^[Pp]lace the rest at the top or bottom of (?:the|your) deck(?: in any order)?$/.exec(t))) return [{ op: 'rest', placeRest: 'topOrBottom' }];
  // "Reveal 1 card from the top of your deck and add up to 1 {FILM} type card to your hand" (or play it): a look
  // at 1 card that both players see
  if ((m = /^[Rr]eveal 1 card from the top of your deck,? and add up to 1 (.+?) to your hand$/.exec(t))) { const x = sel(`up to 1 ${m[1]}`, def, { zone: 'deck' }); return [{ op: 'look', n: 1, reveal: true, pick: { max: 1, cats: x.cats, f: x.f, to: 'hand' } }]; }
  if ((m = /^[Rr]eveal 1 card from the top of your deck(?:,| and) play up to 1 (.+?)( rested)?(?:,? and place the rest at the (top or bottom|bottom|top) of your deck)?$/.exec(t))) {
    const x = sel(`up to 1 ${m[1]}`, def, { zone: 'deck' });
    const out = { op: 'look', n: 1, reveal: true, pick: { max: 1, cats: x.cats || ['C'], f: x.f, to: 'play', rested: !!m[2] } };
    if (m[3]) out.rest = m[3] === 'top or bottom' ? 'topOrBottom' : m[3];
    return [out];
  }
  if ((m = /^[Pp]lace (\d+) cards? from your hand at the (top|bottom) of your deck$/.exec(t))) return [{ op: 'handToDeck', n: +m[1], bottom: m[2] === 'bottom' }];
  if ((m = /^[Ll]ook at (\d+) cards from the top of your deck and (?:place|return) them (?:at|to) the (top or bottom|top) of (?:the|your) deck in any order$/.exec(t))) return [{ op: 'look', n: +m[1], rest: m[2] === 'top' ? 'top' : 'topOrBottom' }];
  // ---- playing cards
  if ((m = /^[Pp]lay this card$/.exec(t))) return [{ op: 'playSelf' }];
  if ((m = /^[Pp]lay this Character card from your trash( rested)?$/.exec(t))) return [{ op: 'playSelf', fromTrash: true, rested: !!m[1] }];
  if ((m = /^[Aa]ctivate this card's \[(Main|Counter)\] effect$/.exec(t))) return [{ op: 'runEffect', which: m[1].toLowerCase() }];
  // "Play up to 1 each of [Sabo], [Portgas.D.Ace], and [Monkey.D.Luffy] with a cost of 2 from your hand"
  if ((m = /^[Pp]lay up to 1 each of ((?:\[[^\]]+\](?:,? (?:and )?)?)+)\s*(.*?) from your (hand|trash|deck|hand or trash)( rested)?$/.exec(t))) {
    const each = [...m[1].matchAll(/\[([^\]]+)\]/g)].map(x => x[1]);
    const x = m[2] ? sel(`up to 1 Character card ${m[2]}`, def, { zone: 'hand' }) : { f: [] };
    return [{ op: 'play', from: m[3] === 'hand or trash' ? 'handOrTrash' : m[3], each, cats: ['C'], f: x.f, rested: !!m[4] }];
  }
  if ((m = /^[Yy]ou may play that card( rested)?$/.exec(t))) return [{ op: 'playThat', rested: !!m[1] }];
  if ((m = /^[Pp]lay up to (\d+) (.+?) from your (hand|trash|deck|hand or trash)( rested)?(?:, then shuffle your deck)?$/.exec(t))) {
    const x = sel(`up to ${m[1]} ${m[2]}`, def, { zone: 'hand' });
    // "play up to 1 {Straw Hat Crew} type card": a Character or a Stage (Events aren't played onto the field)
    return [{ op: 'play', from: m[3] === 'hand or trash' ? 'handOrTrash' : m[3], n: +m[1], cats: x.cats || ['C', 'S'], f: x.f, rested: !!m[4] }];
  }
  if ((m = /^[Aa]dd up to (\d+) (.+?) from your trash to your hand$/.exec(t))) { const x = sel(`up to ${m[1]} ${m[2]}`, def, { zone: 'trash' }); return [{ op: 'toHand', sel: { ...x, who: 'you', zone: 'trash' } }]; }
  // ---- blockers
  if ((m = /^[Yy]our opponent cannot activate \[Blocker\] during this battle$/.exec(t))) return [{ op: 'noBlocker' }];
  if ((m = /^[Yy]our opponent cannot activate a \[Blocker\] Character that has (\d+) or (more|less) power during this battle$/.exec(t))) return [{ op: 'noBlocker', f: [{ k: 'power', op: m[2] === 'more' ? '>=' : '<=', n: +m[1] }] }];
  if ((m = /^[Yy]our opponent cannot activate \[Blocker\] if that (?:Leader or Character|Character) attacks during this turn$/.exec(t))) return [{ op: 'noBlockerIfAttacks', sel: { ref: 'selected' }, dur: 'turn' }];
  // "Your opponent cannot activate up to 1 [Blocker] Character that has 4000 power or less during this turn"
  if ((m = /^[Yy]our opponent cannot activate up to (\d+) \[Blocker\] Characters? that ha(?:s|ve) (\d+) power or (less|more) (during this turn|until .+)$/.exec(t))) return [{ op: 'restrict', flag: 'cantBlock', sel: { who: 'opp', n: +m[1], upTo: true, all: false, cats: ['C'], f: [{ k: 'kw', kw: 'Blocker' }, { k: 'power', op: m[3] === 'less' ? '<=' : '>=', n: +m[2] }], zone: 'field' }, dur: dur(m[4]), text: "can't activate [Blocker]" }];
  if ((m = /^(.+?) cannot activate \[Blocker\] (during this turn|until .+)$/.exec(t)) && !/^[Yy]our opponent /.test(t)) return [{ op: 'restrict', flag: 'cantBlock', sel: target(m[1].replace(/^Up to/, 'up to'), def), dur: dur(m[2]), text: "can't activate [Blocker]" }];
  if ((m = /^[Yy]our opponent's \[On Play\] effects are negated (during this turn|until .+)$/.exec(t))) return [{ op: 'playerFlag', flag: 'negateOnPlay', who: 'opp', dur: dur(m[1]) }];
  if ((m = /^[Ss]elect (.+)$/.exec(t))) return [{ op: 'select', sel: target(m[1], def) }];
  // ---- Life
  if ((m = /^[Tt]rash up to (\d+) of your opponent's Life cards$/.exec(t))) return [{ op: 'trashLife', who: 'opp', n: +m[1] }];
  if ((m = /^[Tt]rash (?:up to )?(\d+) cards? from the top of your opponent's Life cards$/.exec(t))) return [{ op: 'trashLife', who: 'opp', n: +m[1] }];
  if ((m = /^[Aa]dd (?:up to )?(\d+) cards? from the top of your deck to the top of your Life cards$/.exec(t))) return [{ op: 'deckToLife', n: +m[1] }];
  if ((m = /^[Aa]dd (\d+) cards? from the top of your Life cards to your hand$/.exec(t))) return [{ op: 'lifeToHand', n: +m[1] }];
  if ((m = /^[Aa]dd (\d+) cards? from the top or bottom of your Life cards to your hand$/.exec(t))) return [{ op: 'lifeToHand', n: +m[1], where: 'topOrBottom' }];
  if ((m = /^[Pp]lace the revealed card at the (top|bottom) of your deck$/.exec(t))) return [{ op: 'revealedToDeck', bottom: m[1] === 'bottom' }];
  // ST26-002: "Rest up to 1 of your opponent's DON!! cards or Characters with a cost of 1 or less"
  if ((m = /^[Rr]est up to 1 of your opponent's DON!! cards or (Characters? .+)$/.exec(t))) { const x = sel(`up to 1 of your opponent's ${m[1]}`, def); return [{ op: 'restDonOrChar', sel: x }]; }
  if ((m = /^[Ll]ook at up to 1 card from the top of your or your opponent's Life cards, and place it at the top or bottom of the Life cards$/.exec(t))) return [{ op: 'lookLife', who: 'either' }];
  if ((m = /^[Ll]ook at up to 1 card from the top of your opponent's Life cards, and place it at the top or bottom of the Life cards$/.exec(t))) return [{ op: 'lookLife', who: 'opp' }];
  if ((m = /^[Aa]dd up to (\d+) cards? from your hand to the top of your Life cards$/.exec(t))) return [{ op: 'handToLife', n: +m[1], upTo: true }];
  if ((m = /^[Aa]dd up to (\d+) (.+?) from your (hand|trash|hand or trash) to the top of your Life cards(?: face-(up|down))?$/.exec(t))) {
    const x = sel(`up to ${m[1]} ${m[2]}`, def, { zone: 'hand' });
    return [{ op: 'handToLife', from: m[3] === 'hand or trash' ? 'handOrTrash' : m[3], n: +m[1], upTo: true, cats: x.cats, f: x.f, faceUp: m[4] === 'up' }];
  }
  if ((m = /^[Rr]eveal up to (\d+) (.+?) from your hand and add (?:it|them) to the top of your Life cards(?: face-(up|down))?$/.exec(t))) {
    const x = sel(`up to ${m[1]} ${m[2]}`, def, { zone: 'hand' });
    return [{ op: 'handToLife', from: 'hand', n: +m[1], upTo: true, cats: x.cats, f: x.f, faceUp: m[3] === 'up', reveal: true }];
  }
  if ((m = /^[Tt]rash (\d+) cards? from the top of your Life cards$/.exec(t))) return [{ op: 'trashLife', who: 'you', n: +m[1] }];
  if ((m = /^[Ll]ook at all (?:of )?your Life cards and place them back in your Life area in any order$/.exec(t))) return [{ op: 'lookLife', who: 'you', all: true }];
  if ((m = /^[Ll]ook at all (?:of )?your Life cards; place 1(?: card)? at the top of your deck and place the rest back in your Life area in any order$/.exec(t))) return [{ op: 'lookLife', who: 'you', all: true, toDeckTop: 1 }];
  if ((m = /^[Rr]eveal 1 card from the top of your Life cards$/.exec(t))) return [{ op: 'reveal', from: 'life' }];
  if (/^you cannot add Life cards to your hand using your own effects during this turn$/i.test(t)) return [{ op: 'playerFlag', flag: 'noOwnLifeToHand', who: 'you', dur: 'turn' }];
  if (/^[Tt]rash all your face-up Life cards$/.test(t)) return [{ op: 'trashLife', all: true, faceUp: true }];
  if ((m = /^[Aa]dd (.+?) to the (top or bottom|top) of the owner's Life cards( face-up)?$/.exec(t))) return [{ op: 'fieldToLife', sel: target(m[1], def), where: m[2] === 'top' ? 'top' : 'topOrBottom', faceUp: !!m[3] }];
  // ---- the card itself from a [Trigger]
  if ((m = /^add this card to your hand$/i.exec(t))) return [{ op: 'selfToHand' }];
  // ---- protection for a while
  if ((m = /^(.+?) cannot be K\.O\.'d (during this turn|until .+)$/.exec(t))) return [{ op: 'restrict', flag: 'noKO', sel: target(m[1], def), dur: dur(m[2]), text: "can't be K.O.'d" }];
  if ((m = /^none of your Characters can be K\.O\.'d during this turn$/i.exec(t))) return [{ op: 'playerFlag', flag: 'noKOAll', who: 'you', dur: 'turn' }];
  if ((m = /^(.+?) cannot attack (until .+|during this turn)$/.exec(t))) return [{ op: 'restrict', flag: 'cantAttack', sel: target(m[1], def), dur: dur(m[2]), text: "can't attack" }];
  // ---- reveal
  if ((m = /^[Rr]eveal 1 card from the top of your deck$/.exec(t))) return [{ op: 'reveal' }];
  // ---- the opponent's deck
  if ((m = /^[Ll]ook at (\d+) cards? from the top of your opponent's deck$/.exec(t))) return [{ op: 'lookOppDeck', n: +m[1] }];
  if (/^[Cc]hoose a cost and reveal 1 card from the top of your opponent's deck$/.test(t)) return [{ op: 'chooseCostReveal' }];
  if ((m = /^[Tt]rash (\d+) cards? from the top of your deck$/.exec(t))) return [{ op: 'mill', n: +m[1] }];
  // ---- restrictions for a while
  if ((m = /^(.+?) cannot be rested (during this turn|until .+)$/.exec(t))) return [{ op: 'restrict', flag: 'cantRest', sel: target(m[1].replace(/^Up to/, 'up to'), def), dur: dur(m[2]), text: "can't be rested" }];
  if ((m = /^([Tt]his Leader|[Tt]his Character) cannot attack your opponent's (Characters? .+?) (during this turn|until .+)$/.exec(t))) {
    const x = sel(`up to 1 of your opponent's ${m[2]}`, def);
    return [{ op: 'restrict', flag: 'cantAttackChar', sel: target(m[1], def), f: x.f, dur: dur(m[3]), text: `can't attack Characters ${m[2].replace(/^Characters? /, '')}` }];
  }
  // ---- ST36-005: "Change the target of the attack to your [Eustass"Captain"Kid] with 5000 base power or more"
  if ((m = /^[Cc]hange the target of the attack to (.+)$/.exec(t))) { const x = sel(`up to 1 of ${m[1].replace(/^your /, 'your ')}`, def); return [{ op: 'redirect', sel: x }]; }
  // ---- "any number of"
  if ((m = /^[Yy]ou may return any number of Characters on your field to the owner's hand$/.exec(t))) return [{ op: 'bounceAny' }];
  if ((m = /^[Yy]ou may trash any number of (.+?) from your hand$/.exec(t))) return [{ op: 'discardAny', ...handCards(m[1].replace(/^(.*?)cards$/, '$1card'), def) }];
  // ---- trash from the field (not a K.O.)
  if ((m = /^[Tt]rash (up to \d+ of (?:your|your opponent's) .+)$/.exec(t))) { const x = target(m[1], def); if (x.zone && x.zone !== 'field') fail('trash from the field'); return [{ op: 'trashField', sel: x }]; }
  fail(`clause "${t}"`);
}
// "your Leader or 1 of your Characters", "1 of your {X} type Leader or Character cards", "your Leader"
function donTarget(s, def) {
  const t = s.trim();
  if (/^your Leader or 1 of your Characters$/.test(t)) return sel('up to 1 of your Leader or Character cards', def);
  if (/^your Leader$/.test(t)) return { ref: 'leader' };
  let m;
  if ((m = /^1 of your (.+)$/.exec(t))) { const x = sel(`up to 1 of your ${m[1]}`, def); x.upTo = false; return x; }
  if ((m = /^your (.+) Leader$/.exec(t))) return target(t, def);
  return target(t, def);
}
// "Then, place the rest at the bottom of your deck in any order" belongs to the "Look at" before it
function mergeLook(steps) {
  const out = [];
  for (const s of steps) {
    if (s.op === 'rest' && s.placeRest) {
      const prev = out[out.length - 1];
      if (!prev || prev.op !== 'look') fail('"the rest" without a look');
      prev.rest = s.placeRest;
      continue;
    }
    out.push(s);
  }
  return out;
}

// ------------------------------------------------------------ text without a timing
function parseNoTiming(s, def, head) {
  const base = { don: head.don, turn: head.turn, once: head.once };
  let m;
  // replacement effects (8-1-3-4): "If this Character would be K.O.'d, you may X instead"
  if ((m = /^If (this Character|your (.+?)) would be (K\.O\.'d|removed from the field)( by (?:an effect|effects|your opponent's effects?))?, you may (.+?) instead$/.exec(s))) {
    const self = m[1] === 'this Character';
    const how = m[3] === 'removed from the field' ? ['remove', 'koEffect'] : m[4] ? ['koEffect'] : ['koEffect', 'koBattle'];
    const byOpp = !!m[4] && /opponent/.test(m[4]);
    const r = { events: how, self, byOpp };
    if (!self) r.sel = sel(`up to 1 of your ${m[2]}`, def);
    const what = m[5];
    const c = tryCostLike(what, def);
    if (c) r.cost = c;
    else {
      // "you may trash this Character and draw 1 card instead": a cost, then an effect
      const parts = splitTop(what, ' and ');
      const c1 = parts.length > 1 && tryCostLike(parts[0], def);
      if (c1) { r.cost = c1; r.steps = parseClauses(cap(parts.slice(1).join(' and ')), def); }
      else r.steps = parseClauses(what, def);
    }
    return { kind: 'replace', replace: r, ...base };
  }
  // "If this Character battles your opponent's Character, ...": at the end of the battle (7-1-5-2)
  if ((m = /^(?:If this Character battles your opponent's Character|At the end of a battle in which this Character battles your opponent's Character), (.+)$/.exec(s))) return { kind: 'auto', timings: ['endOfBattle'], when: { withChar: true }, ...parseCostEffect(cap(m[1]), def, 'auto'), ...base };
  // "When X, Y": an auto effect with its own timing (8-1-3-1-1); also "If a Character is rested by your effect, Y"
  if ((m = /^(?:When|If) (.+?), (.+)$/.exec(s))) {
    const w = parseWhen(m[1], def);
    if (w) return { kind: 'auto', timings: [w.timing], when: w.when, ...parseCostEffect(cap(m[2]), def, 'auto'), ...base };
  }
  // OP09-001: "This effect can be activated when your opponent attacks. ...": the player may use it at that time
  if ((m = /^This effect can be activated when your opponent attacks\. (.+)$/.exec(s))) {
    const ce = parseCostEffect(m[1], def, 'auto');
    return { kind: 'auto', timings: ['onOppAttack'], ...ce, optional: true, costText: ce.costText || 'use this effect', ...base };
  }
  // permanent effects (8-1-3-3), one per sentence ("All of your Characters gain +1 cost. If you have ..., this Leader
  // gains +1000 power." under one [DON!! x1])
  const sentences = splitSentences(s);
  if (sentences.length > 1) return sentences.map(x => parseStatic(x, def, base));
  return parseStatic(s, def, base);
}
function parseStatic(s, def, base) {
  let m, cond = null, body = s;
  if ((m = /^If (.+?), ((?:this|This|your|Your|all|All|give) .+)$/.exec(s))) { cond = parseCond(m[1], def); body = m[2]; }
  // ST33-004: "During the turn in which a card in your hand is trashed by an effect, give this card in your hand -3 cost"
  else if ((m = /^During the turn in which a card in your hand is trashed by an effect, (.+)$/.exec(s))) { cond = { k: 'handTrashedThisTurn', who: 'you' }; body = m[1]; }
  const mods = parseMods(body, def);
  return { kind: 'static', mods, cond, ...base, hand: mods.some(x => x.hand) };
}
// the events of "When ..." auto effects: { timing, when } (the names game.js fires, the fields whenMatches reads)
function parseWhen(s, def) {
  const t = s.trim();
  let m;
  if (/^a Character is K\.O\.'d$/.test(t)) return { timing: 'charKO', when: {} };
  if ((m = /^(?:a|1) of your (.+?) is K\.O\.'d$/.exec(t)) || (m = /^your (?!opponent's)(.+?) is K\.O\.'d$/.exec(t))) return { timing: 'charKO', when: { sel: sel(`up to 1 of your ${m[1]}`, def) } };
  if ((m = /^(?:a|1) of your opponent's (.+?) is K\.O\.'d$/.exec(t)) || (m = /^your opponent's (.+?) is K\.O\.'d$/.exec(t))) return { timing: 'charKO', when: { sel: sel(`up to 1 of your opponent's ${m[1]}`, def) } };
  if (/^this Character is K\.O\.'d by an effect$/.test(t)) return { timing: 'ko', when: { byEffect: true } };
  if (/^this Character is K\.O\.'d by your opponent's effect$/.test(t)) return { timing: 'ko', when: { byEffect: true, byOpp: true } };
  if (/^your opponent activates a \[Blocker\]$/.test(t)) return { timing: 'blockerActivated', when: { who: 'opp' } };
  if (/^your opponent activates an Event$/.test(t)) return { timing: 'eventActivated', when: { who: 'opp' } };
  if (/^a DON!! card on your field is returned to your DON!! deck$/.test(t)) return { timing: 'donReturned', when: { who: 'you' } };
  if ((m = /^(\d+) or more DON!! cards on your field are returned to your DON!! deck$/.exec(t))) return { timing: 'donReturned', when: { who: 'you', minN: +m[1] } };
  if (/^this Character becomes rested$/.test(t)) return { timing: 'rested', when: { self: true } };
  if (/^a Character is rested by your effect$/.test(t)) return { timing: 'rested', when: { byEffect: true, byYou: true, sel: { who: 'any', cats: ['C'], f: [] } } };
  // OP12-040: "a card is trashed from your hand by your {Navy} type card's effect"
  if ((m = /^a card is trashed from your hand by your (.+?) card's effect$/.exec(t))) { const x = sel(`up to 1 of your ${m[1]} card`, def); return { timing: 'handTrashed', when: { who: 'you', byEffect: true, srcSel: { who: 'you', cats: x.cats, f: x.f } } }; }
  // "When this Character battles <Strike> attribute Characters": once the two cards of the battle are settled
  if ((m = /^this Character battles (.+)$/.exec(t))) return { timing: 'battling', when: { battleSel: sel(`up to 1 ${m[1]}`, def) } };
  return null;
}
function tryCostLike(s, def) {
  try { const c = parseCost(s, def); return c.cost.length ? c.cost : null; } catch (e) { if (e instanceof ParseError) return null; throw e; }
}
// "this Character gains +1000 power", "This Character gains [Rush]", "your {X} type Characters gain +1000 power",
// "This Character cannot be K.O.'d in battle", "give this card in your hand -4 cost"
function parseMods(text, def) {
  const t = text.trim().replace(/\.$/, '');
  const parts = splitTop(t, ' and ');
  let m;
  const who = s => {
    const x = s.trim();
    if (/^(this Character|this card|This Character|This card)$/.test(x)) return { ref: 'self' };
    if (/^(this Leader|This Leader|your Leader|Your Leader)$/.test(x)) return { ref: 'leader' };
    return target(x.replace(/^All /, 'all ').replace(/^Your /, 'your ').replace(/^your (?!opponent)/, 'all of your '), def);
  };
  // "this Character cannot be K.O.'d by your opponent's effects and gains +2000 power": the subject carries over
  if (parts.length > 1 && parts.slice(1).every(x => /^(?:cannot|can|gains?) /.test(x))) {
    const subj = (/^(.+?) (?:cannot|can|gains?) /.exec(parts[0]) || [])[1];
    if (subj) {
      try { return parts.flatMap((x, i) => parseMods(i ? `${subj} ${x}` : x, def)); }
      catch (e) { if (!(e instanceof ParseError)) throw e; }
    }
  }
  // "... for every 4 cards in your trash" scales the numbers
  let per = null, body = t;
  if ((m = /^(.+) for every (\d+) cards in your trash$/.exec(t))) { body = m[1]; per = { div: +m[2], of: { k: 'trash', who: 'you' } }; }
  const scaled = n => (per ? { k: 'per', each: n, of: per.of, div: per.div } : n);
  if ((m = /^(.+?) gains? (?:\[(Rush|Blocker|Double Attack|Banish|Unblockable|Rush: Character)\]|([+-]\d+) (power|cost))(?: and (?:\[(Rush|Blocker|Double Attack|Banish|Unblockable)\]|([+-]\d+) (power|cost)))?$/.exec(body))) {
    // "your Leader and all of your Characters gain +1000 power": one effect for each
    const subjects = (sm => (sm ? [{ ref: 'leader' }, who(`all of your ${sm[1]}`)] : [who(m[1])]))(/^[Yy]our Leader and all of your (.+)$/.exec(m[1]));
    const out = [];
    for (const s1 of subjects) {
      if (m[2]) out.push({ k: 'grant', sel: s1, kw: m[2] }); else out.push({ k: m[4], sel: s1, n: scaled(+m[3]) });
      if (m[5]) out.push({ k: 'grant', sel: s1, kw: m[5] }); else if (m[6]) out.push({ k: m[7], sel: s1, n: scaled(+m[6]) });
    }
    if (per && !out.some(x => x.n != null)) fail('"for every" without a number');
    return out;
  }
  if (per) fail(`permanent effect "${t}"`);
  if ((m = /^(.+?) cannot attack$/.exec(t))) return [{ k: 'cantAttack', sel: who(m[1]) }];
  // OP09-081: "Your [On Play] effects are negated" (8-2)
  if (/^Your \[On Play\] effects are negated$/.test(t)) return [{ k: 'negateOnPlay', sel: { ref: 'leader' } }];
  if ((m = /^[Gg]ive (this Leader|this Character) (-?\d+) power$/.exec(t))) return [{ k: 'power', sel: who(m[1]), n: -Math.abs(+m[2]) }];
  if ((m = /^[Gg]ive this card in your hand -(\d+) cost$/.exec(t))) return [{ k: 'cost', sel: { ref: 'self' }, n: -+m[1], hand: true }];
  if ((m = /^(.+?) cannot be K\.O\.'d( in battle| by effects| by your opponent's effects| in battle by Leaders)?$/.exec(t))) {
    const how = { ' in battle': 'battle', ' by effects': 'effect', " by your opponent's effects": 'oppEffect', ' in battle by Leaders': 'battleLeader' }[m[2] || ''] || 'any';
    return [{ k: 'noKO', sel: who(m[1]), how }];
  }
  if ((m = /^(.+?) can also attack your opponent's active Characters$/.exec(t))) return [{ k: 'canAttackActive', sel: who(m[1]) }];
  // ST13-003: damage (the rules) doesn't add face-up Life cards to the hand
  if (/^Your face-up Life cards are placed at the bottom of your deck instead of being added to your hand, according to the rules$/.test(t)) return [{ k: 'faceUpLifeToDeck', sel: { ref: 'leader' } }];
  fail(`permanent effect "${t}"`);
}
