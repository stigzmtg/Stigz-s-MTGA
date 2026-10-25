# One Piece Card Game engine: API

`src/optcg/game.js` is the rules engine (the official Comprehensive Rules v1.2.1, 2026-08-28). `src/optcg/ai.js` is the
computer player. Card effects are compiled from the card text by `src/optcg/text.js`, with overrides in
`src/optcg/cards.js`. Like the Pokémon engine, a game is deterministic for its seed and the answers its agents give,
so the lockstep net layer, replays and records work the same way (kind `'op'`).

## Creating and starting a game

```js
import { OnePieceGame } from './optcg/game.js';
import { OnePieceAI } from './optcg/ai.js';
const game = new OnePieceGame({
  db,                    // data/optcg/cards.json (an { id: card } object, or an array)
  seed,                  // any 32-bit number
  players: [{ name, deck, agent, human }, { name, deck, agent, human }],   // deck: a decks.json entry
  onUpdate,              // optional: called whenever the game changes
  maxTurns: 60,          // the game is a draw after this many turns
});
await game.start();      // resolves when the game is over
```

`new OnePieceAI({ pace })` takes the same `pace(kind)` option as `PokemonAI` (`kind`: 'attack', 'land', 'think',
'choose'). An agent is anything with `ask(game, pid, req)` returning the answer, or a promise of it.

## Game state

Top level: `seed`; `turn` (1, 2, ...; 0 during setup); `current` (whose turn, a pid); `first` (who went first);
`phase` ('setup' | 'refresh' | 'draw' | 'don' | 'main' | 'end'); `over`; `winner` (pid, or null for a draw);
`result` (a sentence, e.g. "Gus's Leader took damage with no Life cards left"); `maxTurns`; `events`; `logs`;
`pendingAsk` (`{ pid, req }` while an agent is being asked); `problems` (undefined, or a list of effects the engine
couldn't resolve).

Fail-safe: a card effect the engine can't carry out (an unknown cost, step or condition, or an error inside an
effect) never ends the game: it is skipped, logged and added to `problems`, the same way on every peer. Tests set
`game.throwErrors = true`, which makes it throw instead, so sim, invariants, chaos and rules runs fail on it (nettest
fails on any `problems`).

`battle` is null outside a battle, else `{ attacker, target, step, blocker }`: uids, and `step` is
'attack' | 'block' | 'counter' | 'damage'. `target` becomes the blocker after a block.

`players[pid]`:

| field | |
|---|---|
| `id`, `name`, `deckId`, `deckName`, `human` | |
| `lost` | true once this player has lost (both, if both met a defeat condition at once) |
| `leader` | the Leader card |
| `characters` | Characters in play, in play order (at most 5) |
| `stage` | the Stage card, or null |
| `hand`, `deck`, `trash` | arrays of cards; `deck[0]` is the top |
| `life` | Life cards, `life[0]` is the top; `card.faceUp` for face-up ones |
| `donDeck`, `donActive`, `donRested` | DON!! counts: the DON!! deck, and the cost area's active and rested cards |
| `turns` | how many turns this player has started |

DON!! cards given to a Leader or Character are counted on that card (`card.don`). The four always add up to 10.

### Cards

Every card is an instance `{ uid, id, def, owner }`: `uid` is unique in the game and stable (the same physical card
keeps it as it moves); `id` is the card number ('ST01-012'); `def` is its cards.json entry. On the field a card also
has `rested`, `don` (DON!! given to it) and `playedTurn`; `zone` says where it is ('leader', 'characters', 'stage',
'hand', 'deck', 'trash', 'life', or 'limbo' for a [Trigger] card while its effect resolves).

### Helpers

| | |
|---|---|
| `cardByUid(uid)` | the card, wherever it is (or null) |
| `ownerOf(uid)` | its owner's pid |
| `power(card)` | current power: base, DON!! (+1000 each during its owner's turn), effects, battle Counters |
| `cost(card)` | current cost (on the field, or the cost to play it from the hand) |
| `keywords(card)` | a Set of its current keywords: 'Rush', 'Rush: Character', 'Blocker', 'Double Attack', 'Banish', 'Unblockable' |
| `canAttack(card)` | it can attack something right now |
| `modsOf(card)` | what is changing it, for display: `[{ text: '+2000 power this turn' }, { text: 'DON!! ×2 (+2000)' }, ...]` |
| `legalActions(pid)` | the Main Phase actions (what the 'main' request lists) |
| `abilities(card)` | its compiled abilities (`{ idx, kind, text, ... }`) |
| `counterOptions(pid)` | what the 'counter' request would offer now |

## Requests: `agent.ask(game, pid, req)`

Every request has `type`, `prompt` (a sentence for the person) and `hint` (what the choice is for: the AI answers by
it, and the table can use it). Answers that aren't one of the choices are handled safely (a stale Main Phase answer
asks again; elsewhere the engine falls back to a legal choice).

| type | fields | answer |
|---|---|---|
| `main` | `actions` | one of the actions (matched by `t`, `card`, `target`, `ability`) |
| `cards` | `options: [uid]`, `min`, `max`, `from`, `shown?` | `[uid]` |
| `confirm` | | true / false |
| `option` | `options: [{ value, label }]` | a value |
| `number` | `min`, `max` | a number |
| `order` | `options: [uid]` | the same uids in order (first = top) |
| `blocker` | `options: [uid]`, `attacker`, `target` | a uid, or null |
| `counter` | `options`, `attacker`, `target` | one option object, or null when done |
| `trigger` | `card` | true = activate the [Trigger], false = add the card to the hand |
| `mulligan` | `hand: [uid]` | true = return the hand and draw 5 new cards |

### Main Phase actions

| action | |
|---|---|
| `{ t: 'play', card, label }` | play a Character or Stage, or activate a [Main] Event, from the hand. With 5 Characters in play the engine then asks which to trash (a `cards` request, `from: 'field'`, hint 'trash-for-room') |
| `{ t: 'don', target, n: 1, label }` | give 1 active DON!! to your Leader or a Character (send it again for more) |
| `{ t: 'attack', card, target, label }` | one per legal attacker and target |
| `{ t: 'activate', card, ability, label }` | an [Activate: Main] effect of your Leader, a Character or the Stage; `ability` is its index (`abilities(card)[].idx`) |
| `{ t: 'end', label }` | end the turn |

No battle on either player's first turn (6-5-6-1): attack actions start on each player's second turn.

### `cards`

`from` is 'hand' | 'trash' | 'deck' | 'life' | 'field'. With 'field' the options are Leaders, Characters or Stages in
play (either player's): show the choice on the board. Otherwise show a dialog; `shown` lists every card the player
gets to see (for example all 5 cards looked at from the deck), of which `options` are the ones they may pick.
"Up to" choices have `min: 0`. A few effects pick from two areas at once (Koala's "from your hand or trash"): those
come with `from: 'hand'` and options from both.

`from: 'opp-hand'` (hint 'discard-opp'): the player picks cards from the opponent's hand without seeing them
(ST10-010 Law's "trash 2 cards from your opponent's hand": the player of the effect chooses, 8-4-4-3, and can't see
the opponent's hand, 3-4-3). Show the options as card backs.

### `counter`

`options` lists `{ card, kind: 'counter', value }` (a Character card's Counter from the hand) and
`{ card, kind: 'event', cost }` (a [Counter] Event the player can pay for). Answer one option (or null to stop); the
engine applies it and asks again with the updated options until the answer is null or nothing is left. A Counter value
goes to the attacked card; add `to: uid` to give it to another of your Leader or Characters instead (7-1-3-1-1 allows
it, though it rarely helps). Read the live powers from `game.battle` and `power()`.

### Who goes first

The coin-flip winner gets an `option` request with `hint: 'first'` and the values 'first' / 'second'.

### Hints

- `cards`: 'take' (to the hand), 'discard', 'discard-opp', 'discard-any' (any number, maybe none), 'play', 'reveal',
  'topdeck', 'recycle', 'to-life', 'keep-top', and for `from: 'field'` 'ko', 'rest', 'buff', 'debuff', 'cost-up',
  'cost-down', 'bounce', 'bottom', 'grant', 'give-don', 'set-active', 'select', 'freeze' (stays rested in the next
  Refresh Phase), 'trash-char' (trashed, not K.O.'d), 'bounce-own' (any number of your own Characters to your hand),
  'trash-for-room', 'rest-cost', 'bounce-cost', 'don-unattach'
- `option`: 'first', 'don-return' (which DON!! card goes back for a DON!! −X), 'life-end' (top or bottom Life card),
  'life-whose', 'choose-one', 'order-effects' (which of several simultaneous effects resolves first)
- `number`: 'don-n' (how many DON!! cards), 'don-return-n'
- `order`: 'order-top', 'order-bottom', 'order-life'
- `confirm`: 'pay-cost' ("You may ..." costs of effects that activate on their own, including ① and DON!! −X, whose
  printed reminder says "You may"; the request also carries `card` and `ability`, the effect's card uid and index),
  'may' (with `card` when it is about one card, e.g. "you may play that card"), 'replace' ("instead" effects)
- 'main', 'block', 'counter', 'trigger', 'mulligan' for those types

## Events

`events` is a rolling list of `{ id, kind, at (turn), ... }` (ids increase). Card fields are uids.

| kind | fields | |
|---|---|---|
| `turn` | `pid` | a turn starts |
| `coin` | `heads`, `pid`, `reason` | who chooses first or second |
| `first` | `pid` | who goes first |
| `mulligan` | `pid` | a player redrew their hand |
| `shuffle` | `pid` | |
| `refresh` | `pid` | the Refresh Phase set everything active |
| `draw` | `pid`, `n` | |
| `don` | `pid`, `n`, `kind` | DON!! moved: 'add' / 'add-rested' (from the DON!! deck), 'rest' (paid or rested), 'active', 'return' (to the DON!! deck), 'unattach' (given DON!! back to the cost area) |
| `give` | `pid`, `target`, `n` | DON!! given to a card |
| `play` | `pid`, `card`, `from?` | a card played (Leaders at the start, Characters, Stages, Events) |
| `activate` | `pid`, `card`, `timing?` | an effect activates |
| `attack` | `pid`, `card`, `target` | |
| `block` | `pid`, `card` | |
| `counter` | `pid`, `card`, `value`, `target?`, `event?` | |
| `damage` | `pid`, `n` | a Leader takes damage |
| `life` | `pid`, `card` | a Life card goes to the hand |
| `life-add`, `life-turn`, `life-reorder`, `life-setup` | `pid`, `card?` | Life cards added, turned face-up/down, reordered, dealt |
| `trigger` | `pid`, `card` | a [Trigger] activates |
| `ko` | `pid`, `card`, `name`, `by` | 'battle' or 'effect' |
| `trash` | `pid`, `card`, `from?` | |
| `return` | `card`, `to` | to the hand or the bottom of the deck |
| `rest`, `active` | `card` | |
| `power`, `cost` | `card`, `n?` | a power or cost change |
| `look`, `reveal` | `pid`, `n` / `card` | |
| `battle-end` | | |
| `end` | `winner` | the game is over |

## Logs

`logs` is a rolling list of `{ text, type?, pid?, turn }`; `type` is 'turn', 'play', 'attack', 'block', 'counter',
'damage', 'trigger', 'ko', 'effect' or 'end' for lines worth highlighting.

## Tests

`tools/optcg/rules.mjs` (rules tests), `sim.mjs` (AI games), `invariants.mjs` (state checks, `--chaos`, `--odd`,
`--busy`, `--selftest`), `nettest.mjs` (lockstep: `CHAOS=1`, `TAKEOVER=1`), `coverage.mjs` (every card's text must
compile). In tests, call the agents directly; the human agent lives with the table (`src/optcg/ui/human.js`).
