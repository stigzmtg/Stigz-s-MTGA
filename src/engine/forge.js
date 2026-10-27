// Parser for Forge card scripts (https://github.com/Card-Forge/forge, GPL-3.0).
// Card scripts are line-based "Key:Value" files; abilities are "Api$ Name | Key$ Value | ..." strings.

const KEEP_KEYS = new Set(['Name', 'ManaCost', 'Types', 'PT', 'Loyalty', 'Defense', 'Colors', 'K', 'A', 'T', 'S', 'R', 'SVar', 'Oracle', 'AlternateMode', 'Text', 'MeldPair']);

// Strip AI hints and deck-building metadata that the engine never uses.
export function compactScript(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line === 'ALTERNATE') { out.push(line); continue; }
    if (line.startsWith('SPECIALIZE')) break; // Alchemy specialize faces are not used
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i);
    if (!KEEP_KEYS.has(key)) continue;
    if (key === 'SVar') {
      const rest = line.slice(i + 1);
      const name = rest.slice(0, rest.indexOf(':'));
      if (/^(AIPreference|PlayMain1|BuffedBy|HasCombatEffect|HasAttackEffect|HasBlockEffect|MustBeBlocked|SacMe|NonStackingEffect|Picture|AIEvaluationModifier|AICastPreference|AIPriorityModifier|MustAttack|EndOfTurnLeavePlay|ChosenProtection|RemAIDeck|DiscardMe|AIPreferenceOverride|NeedsToPlay|NeedsToPlayVar|IsReanimatorCard|ManaNeededToAvoidNegativeEffect|AmbushAI|MoveOnSac|SacrificeEndCombat|Targeting|AIManaPref|ETBEffect|Retain|Ultimate|DontHavePermanentAI)$/.test(name)) continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

export function parseCardScript(text) {
  const faces = [];
  let face = newFace();
  let altMode = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line === 'ALTERNATE') { faces.push(face); face = newFace(); continue; }
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i);
    const val = line.slice(i + 1);
    switch (key) {
      case 'Name': face.name = val; break;
      case 'ManaCost': face.manaCost = val === 'no cost' ? null : val; break;
      case 'Types': face.types = val; break;
      case 'PT': face.pt = val; break;
      case 'Loyalty': face.loyalty = val; break;
      case 'Defense': face.defense = val; break;
      case 'Colors': face.colors = val; break;
      case 'K': face.K.push(val); break;
      case 'A': face.A.push(val); break;
      case 'T': face.T.push(val); break;
      case 'S': face.S.push(val); break;
      case 'R': face.R.push(val); break;
      case 'SVar': {
        const j = val.indexOf(':');
        if (j > 0) face.svars[val.slice(0, j)] = val.slice(j + 1);
        break;
      }
      case 'Oracle': face.oracle = val.replace(/\\n/g, '\n'); break;
      case 'Text': face.text = val.replace(/\\n/g, '\n'); break;
      case 'AlternateMode': altMode = val; break;
      default: break;
    }
  }
  faces.push(face);
  return { faces, altMode };
}

function newFace() {
  return { name: '', manaCost: null, types: '', pt: null, loyalty: null, defense: null, colors: null, K: [], A: [], T: [], S: [], R: [], svars: {}, oracle: '', text: '' };
}

// "AB$ Mana | Cost$ T | Produced$ C" -> { kind: 'AB', api: 'Mana', p: { Cost: 'T', Produced: 'C' } }
// Trigger / static / replacement strings have no "Api$" head: "Mode$ ChangesZone | ..." -> { p: {Mode:...} }
const abilityCache = new Map();
export function parseAbility(str) {
  if (str == null) return null;
  let r = abilityCache.get(str);
  if (r) return r;
  const parts = str.split('|');
  const p = {};
  let kind = null, api = null;
  for (let idx = 0; idx < parts.length; idx++) {
    const part = parts[idx].trim();
    if (!part) continue;
    const d = part.indexOf('$');
    if (d < 0) continue;
    const k = part.slice(0, d).trim();
    const v = part.slice(d + 1).trim();
    if (idx === 0 && (k === 'SP' || k === 'AB' || k === 'DB' || k === 'ST')) { kind = k; api = v; continue; }
    p[k] = v;
  }
  // earthbend's target is part of the action: "target land you control" (mech-newsets.js)
  if (api === 'Earthbend' && !p.ValidTgts && !p.Defined) { p.ValidTgts = 'Land.YouCtrl'; p.TgtPrompt = p.TgtPrompt || 'Select target land you control'; }
  r = { kind, api, p, raw: str };
  abilityCache.set(str, r);
  return r;
}

export function normName(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
}
