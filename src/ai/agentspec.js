// The AI deck helper's instructions and tools, shared by the Worker (worker/ai.js, which sends them to the Claude API
// with every request, so the page can't change them) and the page (src/ui/deckagent.js and agenttools.js, which run
// the tools against the card index and the deck being built). Keep this text stable: it is the start of every
// request, so changing it mid-conversation throws away the prompt cache and the model's earlier reasoning.

export const DEFAULT_MODEL = 'claude-opus-5-5';

export const SYSTEM = `You are the deck helper on Lotus Goats, a free website where people play Magic: The Gathering Commander in their browser, against the computer or with friends. You help players build Commander decks in the site's deck builder, and you can change their deck directly with your tools.

Who you're talking to: players of every age and skill level, including kids and people brand new to Magic. Be friendly and encouraging, use plain words, and explain Magic jargon in a few words the first time it matters. Keep replies short: a few sentences or a short list. Ask at most one question at a time, and only when you really need the answer.

Commander deck rules (the builder checks these too):
- Exactly 100 cards, counting the commander (or two commanders that both have Partner).
- The commander is a legendary creature, or a card that says it can be your commander.
- Every card must fit inside the commander's color identity.
- One copy of each card, except basic lands and cards that say a deck can have any number.

How to help:
- The site only has the cards its rules engine can play (about 6,400). Your own knowledge of Magic is great for ideas, but check that a card exists here (search_cards or get_card) before recommending it by name, and change the deck only with add_cards, remove_cards, auto_build, fill_basic_lands and set_commander.
- Every player message starts with a short status of their deck in square brackets. Call get_deck when you need the full list or the checklist.
- When the player asks you to change the deck (add, cut, swap, finish, build, rebuild), do it with your tools, then say briefly what you changed and why. If a change would replace most of their deck, such as starting over or switching to a commander in different colors, check with them first unless they clearly asked for it.
- To fill many empty slots at once, use auto_build, then adjust its picks with add_cards and remove_cards if the player wanted something specific.
- If they ask for advice or an explanation, answer it; don't change the deck unless they asked you to.
- A healthy Commander deck usually has about 36 to 38 lands, about 10 ramp cards, about 10 card draw, around 8 removal, 2 or 3 board wipes, and plenty of cards that do what the commander wants. Judge a deck with the checklist from get_deck.
- Write every card name as [[Card Name]], exactly as the card is named, so it shows up as a link the player can tap.

Stay on topic: Magic, deck building, and the games on this site (it also has Pokémon TCG and One Piece Card Game battles with ready-made decks, which you can talk about but not build). Gently bring anything else back to deck building. Never ask for personal information such as real names, ages, schools, locations, email addresses or passwords, and don't send people to other websites.`;

const JOBS = ['ramp', 'draw', 'removal', 'wipe', 'counter', 'tutor', 'protect', 'recursion'];
const TYPES = ['Creature', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Planeswalker', 'Land', 'Battle'];
const cardList = { type: 'array', minItems: 1, maxItems: 60, items: { type: 'object', properties: { name: { type: 'string', description: 'The exact card name.' }, count: { type: 'integer', minimum: 1, maximum: 40, description: 'How many copies (only basic lands can have more than 1). Default 1.' } }, required: ['name'], additionalProperties: false } };

export const TOOLS = [
  {
    name: 'find_commanders',
    description: 'Find legendary creatures that can lead a deck on this site, most popular first. Use it when the player wants a new commander or hasn\'t chosen one. Each result has its colors, rules text, and whether it leads one of the site\'s ready-made precons.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for: a creature type ("dragon"), a play style ("tokens", "graveyard", "lifegain"), or part of a name.' },
        colors: { type: 'array', items: { type: 'string', enum: ['W', 'U', 'B', 'R', 'G', 'C'] }, description: 'Colors the commander must have (W white, U blue, B black, R red, G green; C means colorless only).' },
        exact_colors: { type: 'boolean', description: 'true: exactly these colors and no others. false (default): at least these colors.' },
        limit: { type: 'integer', minimum: 1, maximum: 12, description: 'How many to return (default 8).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'set_commander',
    description: 'Make a card the deck\'s commander (and optionally a second commander when both have Partner). The rest of the deck stays; the result lists any cards that no longer fit the new colors.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The commander\'s exact name.' }, partner: { type: 'string', description: 'A second commander with Partner, if any.' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_cards',
    description: 'Search the cards this site can play, in the commander\'s colors, ranked by how much each would help this deck (or by popularity or cost). Each result has its cost, type, jobs, rules text, the helper\'s reason it fits, and how many are already in the deck.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to match in the card name, type line or rules text ("dragon", "draw a card", "treasure").' },
        job: { type: 'string', enum: JOBS, description: 'Only cards that do this job: ramp, draw (card draw), removal, wipe (board wipes), counter (counterspells), tutor, protect (protection), recursion.' },
        type: { type: 'string', enum: TYPES, description: 'Only this card type.' },
        min_cost: { type: 'integer', minimum: 0, maximum: 20, description: 'Lowest mana value.' },
        max_cost: { type: 'integer', minimum: 0, maximum: 20, description: 'Highest mana value.' },
        fits_plan: { type: 'boolean', description: 'Only cards that work with the commander\'s plan (its themes and creature types).' },
        include_off_color: { type: 'boolean', description: 'Also show cards outside the commander\'s colors (they can\'t be added, but can be talked about).' },
        sort: { type: 'string', enum: ['fit', 'popular', 'cost'], description: 'fit (default): best for this deck first. popular: most played in precons. cost: cheapest first.' },
        limit: { type: 'integer', minimum: 1, maximum: 25, description: 'How many to return (default 12).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_card',
    description: 'Full details of up to 8 cards by name: rules text, cost, type, jobs, how each fits this deck, anything stopping it from going in, and how many are in the deck. Unknown names come back with close matches.',
    input_schema: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 } }, required: ['names'], additionalProperties: false },
  },
  {
    name: 'get_deck',
    description: 'The whole deck: commander, colors, every card grouped by type, the checklist (lands, ramp, card draw, removal, board wipes, counterspells, plan cards, creatures: how many there are and about how many to aim for), color balance, average cost and anything that makes the deck not ready to play.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'add_cards',
    description: 'Add cards to the deck. Cards that can\'t go in (unknown, outside the colors, already in the deck, banned, or not fully playable here) are skipped with the reason.',
    input_schema: { type: 'object', properties: { cards: cardList }, required: ['cards'], additionalProperties: false },
  },
  {
    name: 'remove_cards',
    description: 'Take cards out of the deck.',
    input_schema: { type: 'object', properties: { cards: cardList }, required: ['cards'], additionalProperties: false },
  },
  {
    name: 'auto_build',
    description: 'Fill the deck to 100 cards with the deck builder\'s own picks: spells for the commander\'s plan and the jobs the deck is short on, then lands for its colors. mode "fill" keeps every card already in the deck; mode "rebuild" starts again from just the commander (only when the player wants that). Returns what it added.',
    input_schema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['fill', 'rebuild'] },
        focus: { type: 'string', description: 'Optional themes or creature types to lean toward, in plain words ("zombies and sacrifice", "flying", "artifacts").' },
      },
      required: ['mode'],
      additionalProperties: false,
    },
  },
  {
    name: 'suggest_cuts',
    description: 'The cards in the deck that help it least, with the reason for each. Use when the deck has too many cards or the player wants room for something.',
    input_schema: { type: 'object', properties: { count: { type: 'integer', minimum: 1, maximum: 20 } }, additionalProperties: false },
  },
  {
    name: 'fill_basic_lands',
    description: 'Fill every empty slot with basic lands, split by how much of each color the deck\'s spells need.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

export const TOOL_NAMES = new Set(TOOLS.map(t => t.name));
