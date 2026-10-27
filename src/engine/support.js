// Static analysis of a Forge card script: which features the engine does not implement.
import { parseCardScript, parseAbility } from './forge.js';
import { paramIssues } from './mech-params.js';
import { SUPPORTED_APIS } from './effects.js';
import { SUPPORTED_TRIGGER_MODES } from './triggers.js';
import { SUPPORTED_KEYWORDS } from './keywords.js';
import { combatSupportIssues } from './mech-combat.js';
import { CLASSIC_STATIC_MODES, CLASSIC_REPLACEMENT_EVENTS } from './mech-classic-rules.js';

export const STATIC_MODES = new Set(['Continuous', 'ReduceCost', 'RaiseCost', 'CantBlockBy', 'CantAttack', 'CantAttackUnless', 'CastWithFlash', 'CantBlock', 'Panharmonicon', 'CantBeCast', 'CantSacrifice', 'MinMaxBlocker', 'CantGainLife', 'IgnoreLegendRule', 'CanAttackDefender', 'CombatDamageToughness', 'CantTarget', 'ActivateAbilityAsIfHaste', 'CantPreventDamage', 'CantBeActivated', 'AssignCombatDamageAsUnblocked', 'CantPutCounter', 'NumLoyaltyAct', 'CantBeCountered', 'MustAttack', 'AlternativeCost', 'UntapOtherPlayer', 'CantChangeLife', 'WitherDamage', 'MustBlock', 'AttackRestrict', 'BlockRestrict', 'CantBlockUnless', 'OptionalCost', 'OptionalAttackCost', 'UnspentMana', 'PlayerMustAttack', 'CountersRemain', 'Devotion', 'SurveilNum', 'DisableTriggers', 'FlipCoinDoubler', 'CantDraw', 'GainLifeRadiation', 'CantLoseLife', 'DrawFromBottom', 'CantExile', 'CantPhaseIn', 'ManaConvert']);
// new sets (mech-newsets.js)
for (const k of ['MaxCounter']) STATIC_MODES.add(k);
export const REPLACEMENT_EVENTS = new Set(['Moved', 'DamageDone', 'AddCounter', 'CreateToken', 'Draw', 'GainLife', 'Counter', 'Untap', 'GameLoss', 'GameWin', 'BeginPhase', 'BeginTurn', 'TurnFaceUp', 'LoseMana', 'ProduceMana', 'CopySpell', 'DrawCards', 'LifeReduced', 'RollDice', 'Transform', 'Attached', 'Proliferate', 'Explore', 'RollPlanarDice', 'RemoveCounter', 'Planeswalk']);
// Un-sets (mech-unsets.js): Steamflogger Boss (no Commander-legal card assembles a Contraption)
REPLACEMENT_EVENTS.add('AssembleContraption');
// combat (mech-combat.js): blocking, attacking and combat damage statics; Camouflage replaces declaring blockers
for (const m of ['IgnoreLandWalk', 'CanBlockIfShadow', 'CanBlockIfReach', 'BlockTapped', 'AttackRequirement', 'AttackVigilance', 'CanAttackIfHaste', 'AssignNoCombatDamage', 'CombatDamageNegatePower', 'NoCleanupDamage', 'InfectDamage', 'ColorlessDamageSource', 'CantCrew', 'TapPowerValue']) STATIC_MODES.add(m);
REPLACEMENT_EVENTS.add('DeclareBlocker');
// classic (mech-classic.js): "can't" and "ignore" statics, destroy and pay-life replacements
for (const m of CLASSIC_STATIC_MODES) STATIC_MODES.add(m);
for (const e of CLASSIC_REPLACEMENT_EVENTS) REPLACEMENT_EVENTS.add(e);
const COSTS = new Set(['T', 'Q', 'Sac', 'SubCounter', 'AddCounter', 'PayLife', 'Discard', 'Exile', 'ExileFromGrave', 'ExileFromHand', 'tapXType', 'untapYType', 'Return', 'PayEnergy', 'RemoveAnyCounter', 'Mill', 'Reveal', 'Draw', 'Exert', 'Unattach', 'Crew', 'ExileAnyGrave', 'Blight', 'RevealChosen', 'ExiledMoveToGrave', 'ExileSameGrave', 'RollDice', 'Behold', 'PutCardToLibFromBattlefield', 'Mana']);
// casting (mech-casting.js): cost types, statics and replacements
for (const m of ['CanAdapt', 'ManaRestriction', 'SetCost', 'PlotZone', 'CantBeCopied']) STATIC_MODES.add(m);
for (const e of ['Cascade', 'Learn']) REPLACEMENT_EVENTS.add(e);
for (const c of ['CollectEvidence', 'Forage', 'ExileFromTop', 'PutCardToLibFromHand', 'PutCardToLibFromGrave', 'PutCardToLibFromSameGrave', 'ExileFromStack', 'RevealFromExile', 'ChooseCreatureType', 'RevealOrChoose', 'ExileCtrlOrGrave', 'GainLife']) COSTS.add(c);
// new sets (mech-newsets.js)
for (const k of ['Connive', 'Mill', 'Scry']) REPLACEMENT_EVENTS.add(k);
// new sets (mech-newsets.js): waterbend {N}
for (const k of ['Waterbend']) COSTS.add(k);

const PRETTY = { Mode: '', api: '' };

export function analyzeCard(text) {
  const issues = new Set();
  const { faces, altMode } = parseCardScript(text);
  // prepare: the creature needs its spell face ("while it's prepared, you may cast a copy of its spell")
  if (altMode === 'Prepare' && !(faces[1] && faces[1].A.some(a => /^SP\$/.test(a)))) issues.add('Prepare');
  for (const f of faces) {
    for (const k of f.K) {
      const kn = k.split(':')[0];
      if (!SUPPORTED_KEYWORDS.has(kn) && !/^Protection|^Hexproof|walk$|^Landwalk|^CARDNAME|^HIDDEN/.test(kn)) issues.add(kn);
    }
    const abil = [...f.A, ...Object.values(f.svars).filter(v => /^(DB|AB|SP)\$/.test(v))];
    for (const a of abil) {
      const p = parseAbility(a);
      if (p.api && !SUPPORTED_APIS.has(p.api) && !/^Permanent/.test(p.api)) issues.add(p.api);
      if (p.p.Cost) for (const tok of p.p.Cost.match(/\w+<[^>]*>|\S+/g) || []) { const t = tok.replace(/<.*/, ''); if (/^[\dWUBRGCXSP\/]+$/.test(t) || t === 'XMin1' || t === 'Mandatory') continue; if (!COSTS.has(t)) issues.add(t + ' cost'); }
    }
    for (const t of [...f.T, ...Object.values(f.svars).filter(v => /^Mode\$/.test(v) && /Execute\$/.test(v))]) { const p = parseAbility(t); if (!SUPPORTED_TRIGGER_MODES.has(p.p.Mode)) issues.add(p.p.Mode + ' trigger'); }
    const delayedNames = new Set([...f.A, ...Object.values(f.svars)].flatMap(v => [...String(v).matchAll(/ExtraPhaseDelayedTrigger\$ (\w+)/g)].map(m => m[1])));
    for (const s of [...f.S, ...Object.entries(f.svars).filter(([n, v]) => /^Mode\$/.test(v) && !/Execute\$/.test(v) && !delayedNames.has(n)).map(([, v]) => v)]) { const p = parseAbility(s); for (const m of (p.p.Mode || '').split(',')) if (!STATIC_MODES.has(m)) issues.add(m); }
    for (const r of [...f.R, ...Object.values(f.svars).filter(v => /^Event\$/.test(v))]) { const p = parseAbility(r); if (!REPLACEMENT_EVENTS.has(p.p.Event)) issues.add(p.p.Event + ' replacement'); }
    for (const x of combatSupportIssues(f)) issues.add(x);
  }
  for (const i of paramIssues(faces)) issues.add(i); // card-script parameters left out on purpose (mech-params.js)
  return [...issues].map(x => x.replace(/([a-z])([A-Z])/g, '$1 $2'));
}
