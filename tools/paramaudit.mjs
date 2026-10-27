// Audit: card-script parameters that cards use but the engine never reads.
// For every static ability (S:Mode$), effect (A: / SVar with AB$|SP$|DB$), trigger (T:Mode$) and replacement (R:Event$)
// in every card script, collect each parameter name per mode / API, and report the ones src/engine never mentions
// (a parameter counts as read if src/engine has it as `.Name`, `'Name'` or `"Name"`). Description and AI-hint
// parameters are ignored. Cards are listed most-played first (EDHREC rank from data/cardmeta.json).
//
// Each row: cards using it, how many of those support.js does not already flag as not automated ("silent" gaps,
// the ones that matter), the mode/API and parameter, and example cards.
//
// Usage: node tools/paramaudit.mjs [--section=S|E|T|R] [--min=N] [--examples=N] [--forge] [--json] [--all]
//   --forge     also say whether Forge's own game code reads the parameter (needs the Forge source, FORGE_SRC=...)
//   --all       also list parameters whose every card is already flagged (default: only rows with silent cards)
//   --json      machine-readable output
import fs from 'node:fs';
import path from 'node:path';
import { allCardScripts } from './lib/allcards.mjs';
import { parseCardScript, parseAbility } from '../src/engine/forge.js';

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : (process.argv.includes(`--${k}`) ? true : d); };
const SECTION = arg('section', null), MIN = +arg('min', 1), NEX = +arg('examples', 4), JSON_OUT = arg('json', false), FORGE = arg('forge', false), ALL = arg('all', false);

// parameters that only describe the ability, steer the AI or prompt the player
const IGNORE = /^(Description|SpellDescription|TriggerDescription|StackDescription|PrecostDesc|CostDesc|TgtPrompt|AILogic|AI[A-Z].*|AITgts.*|IsCurse|ChoiceTitle|ChoicePrompt|SelectPrompt|Prompt|PromptIfHasRight|SpellDescriptionPrefix|.*Desc|.*Description|Secondary|ActivationLimitDesc|DescriptionStack|AnnounceTitle|ListTitle|OptionPrompt|MenuText|ShowCardInChatPanel|StaticAbilityDescription|InfoText|ToolTip|Ultimate|Image|ShowChoice|ForceRevealToController|ShowCurrentCard|ShowCardToActivator|PromptToSkipOptionalAbility|PrimaryPrompt|OptionalAbilityPrompt|ChoiceTitleAppend|RevealTitle|VoteMessage|RepeatOptionalMessage|MayPlayText|NoLooking|NoPeek)$/;
// (Ultimate: the AI's hint for a planeswalker's last ability; Image, MayPlayText and the prompts: what the UI shows;
// NoLooking / NoPeek: whether the searcher looks first, which the engine doesn't model)

// every identifier src/engine mentions as .Name, 'Name' or "Name"
const ENGINE_DIR = 'src/engine';
const engineSrc = fs.readdirSync(ENGINE_DIR).filter(f => f.endsWith('.js')).map(f => fs.readFileSync(path.join(ENGINE_DIR, f), 'utf8')).join('\n');
const read = new Set();
for (const m of engineSrc.matchAll(/\.([A-Za-z_]\w*)/g)) read.add(m[1]);
for (const m of engineSrc.matchAll(/(['"])([A-Za-z_]\w*)\1/g)) read.add(m[2]);

// Forge's own game code (optional): a parameter Forge never reads is dead script text or an AI hint
const FORGE_DIR = process.env.FORGE_SRC || '/tmp/claude-0/-home-user/c7951bb0-2eab-52cb-96d1-4ea2a7466e6c/scratchpad/dl/forge-src/forge-game/src/main/java/forge/game';
let forgeSrc = null;
if (FORGE && fs.existsSync(FORGE_DIR)) {
  const parts = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.java')) parts.push(fs.readFileSync(p, 'utf8')); } };
  walk(FORGE_DIR);
  forgeSrc = parts.join('\n');
}
const forgeReads = name => forgeSrc == null ? null : forgeSrc.includes(`"${name}"`) || new RegExp(`"${name}[A-Z]?\\w*"|"\\w*${name}"`).test(forgeSrc);

const meta = JSON.parse(fs.readFileSync('data/cardmeta.json', 'utf8'));
const rank = n => { const r = meta[n]?.[1]; return r > 0 ? r : 1e6; };


// section -> mode -> param -> Set(card)
const usage = { S: new Map(), E: new Map(), T: new Map(), R: new Map() };
const add = (sec, mode, param, card) => {
  const byMode = usage[sec];
  if (!byMode.has(mode)) byMode.set(mode, new Map());
  const m = byMode.get(mode);
  if (!m.has(param)) m.set(param, new Set());
  m.get(param).add(card);
};

const cards = allCardScripts();
const { analyzeCard } = await import('../src/engine/support.js');
const flaggedCards = new Set(Object.keys(cards).filter(n => analyzeCard(cards[n]).length));
for (const [name, text] of Object.entries(cards)) {
  const { faces } = parseCardScript(text);
  for (const f of faces) {
    const svars = Object.values(f.svars);
    const items = [
      ...f.S.map(s => ['S', s]),
      ...f.T.map(s => ['T', s]),
      ...f.R.map(s => ['R', s]),
      ...f.A.map(s => ['E', s]),
      ...svars.filter(v => /^(AB|SP|DB)\$/.test(v)).map(s => ['E', s]),
      ...svars.filter(v => /^Mode\$/.test(v)).map(s => [/Execute\$/.test(s) ? 'T' : 'S', s]),
      ...svars.filter(v => /^Event\$/.test(v)).map(s => ['R', s]),
    ];
    for (const [sec, str] of items) {
      const p = parseAbility(str);
      const modes = sec === 'E' ? [p.api || '?'] : sec === 'R' ? [p.p.Event || '?'] : String(p.p.Mode || '?').split(',');
      for (const mode of modes) for (const k of Object.keys(p.p)) {
        if ((sec === 'S' || sec === 'T') && k === 'Mode') continue;
        if (sec === 'R' && k === 'Event') continue;
        if (IGNORE.test(k)) continue;
        add(sec, mode, k, name);
      }
    }
  }
}

const SECTIONS = { S: 'Static abilities', E: 'Effects', T: 'Triggers', R: 'Replacements' };
const out = {};
for (const sec of Object.keys(usage)) {
  if (SECTION && SECTION !== sec) continue;
  const rows = [];
  for (const [mode, params] of usage[sec]) for (const [param, set] of params) {
    if (read.has(param)) continue;
    const list = [...set].sort((a, b) => rank(a) - rank(b));
    const silent = list.filter(c => !flaggedCards.has(c));
    if (list.length < MIN || (!ALL && !silent.length)) continue;
    rows.push({ mode, param, count: list.length, silent: silent.length, best: rank((silent[0] ?? list[0])), examples: (silent.length ? silent : list).slice(0, NEX), forge: forgeReads(param) });
  }
  rows.sort((a, b) => b.silent - a.silent || b.count - a.count || a.best - b.best);
  out[sec] = rows;
}

if (JSON_OUT) { console.log(JSON.stringify(out, null, 1)); }
else {
  for (const [sec, rows] of Object.entries(out)) {
    console.log(`\n== ${SECTIONS[sec]}: ${rows.length} unread parameters, ${rows.reduce((n, r) => n + r.silent, 0)} uses on cards not flagged (${rows.reduce((n, r) => n + r.count, 0)} in all)`);
    console.log('  all silent  mode / API + parameter');
    for (const r of rows) console.log(`${String(r.count).padStart(5)} ${String(r.silent).padStart(6)}  ${(r.mode + ' ' + r.param).padEnd(52)} ${r.forge === false ? '[Forge: unread] ' : ''}${r.examples.map(e => `${e}${rank(e) < 1e6 ? ` #${rank(e)}` : ''}`).join(', ')}`);
  }
}
