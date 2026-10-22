// Manual tools as plain-data operations, so an online game can replay them on every player's copy.
// `by` is the seat that used the tool (for "put onto the battlefield under my control").
import { CardDef } from '../engine/cards.js';

const note = (game, text) => game.log(`Manual: ${text}`, { type: 'manual' });
const ZONE_LABEL = { hand: 'hand', battlefield: 'the battlefield', graveyard: 'graveyard', exile: 'exile', library: 'library', command: 'the command zone' };

export async function applyOp(game, op) {
  const card = op.id != null ? game.cardById(op.id) : null;
  const pl = op.p != null ? game.players[op.p] : null;
  switch (op.k) {
    case 'mv':
      if (!card) return;
      await game.moveCard(card, op.z, { noCommanderReplace: true, noReplace: op.z !== 'battlefield', controller: op.z === 'battlefield' ? op.by : undefined, pos: op.pos });
      note(game, `${game.name(card)} moved to ${op.z === 'library' ? `the ${op.pos || 'top'} of the library` : ZONE_LABEL[op.z] || op.z}.`);
      break;
    case 'tap':
      if (!card) return;
      card.tapped = !card.tapped;
      note(game, `${game.name(card)} ${card.tapped ? 'tapped' : 'untapped'}.`);
      break;
    case 'ctr':
      if (!card) return;
      card.counters[op.t] = Math.max(0, (card.counters[op.t] || 0) + op.n);
      note(game, `${op.n > 0 ? '+' : '−'}${Math.abs(op.n)} ${op.t.toLowerCase()} counter on ${game.name(card)}.`);
      break;
    case 'dmg0':
      if (!card) return;
      card.damage = 0; card.deathtouchHit = false;
      note(game, `damage removed from ${game.name(card)}.`);
      break;
    case 'flip':
      if (!card) return;
      card.face = card.face ? 0 : 1;
      note(game, `${game.name(card)} transformed.`);
      break;
    case 'up':
      if (!card) return;
      card.faceDown = false;
      note(game, `${game.name(card)} turned face up.`);
      break;
    case 'ctl':
      if (!card) return;
      card.controller = op.to;
      note(game, `${game.players[op.to].name} controls ${game.name(card)}.`);
      break;
    case 'life':
      if (!pl) return;
      pl.life += op.n;
      note(game, `${pl.name} ${op.n > 0 ? 'gains' : 'loses'} ${Math.abs(op.n)} life.`);
      break;
    case 'draw': if (pl) await game.drawCards(pl, 1, null); break;
    case 'mill': if (pl) await game.mill(pl, 1, null); break;
    case 'shuf': if (pl) { game.shuffle(pl); note(game, `${pl.name} shuffles.`); } break;
    case 'poison': if (pl) { pl.counters.POISON = (pl.counters.POISON || 0) + 1; note(game, `${pl.name} gets a poison counter.`); } break;
    case 'untapall': if (pl) { for (const c of game.battlefield) if (c.controller === pl.id) c.tapped = false; note(game, `${pl.name} untaps everything.`); } break;
    case 'tok': {
      if (!pl) return;
      const def = op.s.startsWith('custom:')
        ? new CardDef(`Name:Creature Token\nManaCost:no cost\nTypes:Creature Token\nPT:${op.s.slice(7)}\nOracle:`, { token: true })
        : game.db.token(op.s);
      if (!def) return;
      for (let i = 0; i < op.n; i++) await game.createToken(def, pl.id, null);
      note(game, `${pl.name} creates ${op.n} token(s).`);
      break;
    }
    default: return;
  }
  game.touch();
}

// the menu entries for one card; `use(op)` applies (or queues, online) an operation
export function cardMenuItems(game, card, me, use) {
  const items = [{ header: 'Manual tools' }];
  const z = card.zone;
  const mv = (zone, label, pos) => ({ label, run: () => use({ k: 'mv', id: card.id, z: zone, pos, by: me }) });
  if (z === 'battlefield') {
    items.push({ label: card.tapped ? 'Untap' : 'Tap', run: () => use({ k: 'tap', id: card.id }) });
    items.push({ label: 'Add +1/+1 counter', run: () => use({ k: 'ctr', id: card.id, t: 'P1P1', n: 1 }) });
    if (card.counters.P1P1) items.push({ label: 'Remove +1/+1 counter', run: () => use({ k: 'ctr', id: card.id, t: 'P1P1', n: -1 }) });
    items.push({ label: 'Add -1/-1 counter', run: () => use({ k: 'ctr', id: card.id, t: 'M1M1', n: 1 }) });
    if (game.chars(card).types.has('Planeswalker')) {
      items.push({ label: 'Loyalty +1', run: () => use({ k: 'ctr', id: card.id, t: 'LOYALTY', n: 1 }) });
      items.push({ label: 'Loyalty −1', run: () => use({ k: 'ctr', id: card.id, t: 'LOYALTY', n: -1 }) });
    }
    for (const k of Object.keys(card.counters).filter(k => card.counters[k] > 0 && !['P1P1', 'M1M1', 'LOYALTY'].includes(k))) {
      items.push({ label: `${k.toLowerCase()} counter +1`, run: () => use({ k: 'ctr', id: card.id, t: k, n: 1 }) });
      items.push({ label: `${k.toLowerCase()} counter −1`, run: () => use({ k: 'ctr', id: card.id, t: k, n: -1 }) });
    }
    if (card.damage) items.push({ label: 'Remove damage', run: () => use({ k: 'dmg0', id: card.id }) });
    if (card.def.faces.length > 1 && card.def.isDFC) items.push({ label: 'Transform', run: () => use({ k: 'flip', id: card.id }) });
    if (card.faceDown) items.push({ label: 'Turn face up', run: () => use({ k: 'up', id: card.id }) });
    if (card.controller !== me) items.push({ label: 'Gain control', run: () => use({ k: 'ctl', id: card.id, to: me }) });
    else if (card.owner !== me) items.push({ label: 'Return control to owner', run: () => use({ k: 'ctl', id: card.id, to: card.owner }) });
  }
  if (z !== 'hand') items.push(mv('hand', 'Move to hand'));
  if (z !== 'battlefield') items.push(mv('battlefield', 'Put onto battlefield'));
  if (z !== 'graveyard') items.push(mv('graveyard', 'Move to graveyard'));
  if (z !== 'exile') items.push(mv('exile', 'Move to exile'));
  items.push(mv('library', 'Move to top of library', 'top'));
  items.push(mv('library', 'Move to bottom of library', 'bottom'));
  if (card.isCommander && z !== 'command') items.push(mv('command', 'Move to command zone'));
  return items;
}

export function playerMenuItems(p, use, openTokens) {
  return [
    { header: 'Manual tools' },
    { label: '+1 life', run: () => use({ k: 'life', p, n: 1 }) }, { label: '−1 life', run: () => use({ k: 'life', p, n: -1 }) },
    { label: '+5 life', run: () => use({ k: 'life', p, n: 5 }) }, { label: '−5 life', run: () => use({ k: 'life', p, n: -5 }) },
    '-',
    { label: 'Draw a card', run: () => use({ k: 'draw', p }) },
    { label: 'Mill a card', run: () => use({ k: 'mill', p }) },
    { label: 'Shuffle library', run: () => use({ k: 'shuf', p }) },
    { label: 'Create tokens…', run: () => openTokens(p) },
    { label: 'Add a poison counter', run: () => use({ k: 'poison', p }) },
    { label: 'Untap all my permanents', run: () => use({ k: 'untapall', p }) },
  ];
}
