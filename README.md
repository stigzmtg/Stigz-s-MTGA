# Precon Arena

Two card battle simulators in one site:

- **Magic: The Gathering Commander** against AI opponents, or with friends, using any of the **194 preconstructed Commander decks** (Commander 2013 through 2026, including Universes Beyond and Secret Lair precons). 1v1 or up to 4-player free-for-all.
- **Pokémon TCG battles** against a computer opponent with **10 of the most-played tournament decks** (Dragapult ex, Charizard ex, Gardevoir ex, Raging Bolt ex, Gholdengo ex, Miraidon ex, Mega Absol Box, Chien-Pao Baxcalibur, Roaring Moon ex, Lost Zone Box), card for card from Limitless decklists.

**Play it:** https://stigzmtg.github.io/Stigz-s-MTGA/ (GitHub Pages; see [Hosting](#hosting) to put it on a non-GitHub address)

## How it works

- **Rules engine** (`src/engine/`): a JavaScript interpreter for [Forge](https://github.com/Card-Forge/forge)'s card-script language. Every card's abilities, triggers, static effects and replacement effects are read from its Forge script, so rules text isn't hand-coded per card. It implements the turn structure, priority and the stack, state-based actions, combat (first strike, trample, deathtouch, menace, flying…), the command zone, commander tax and commander damage, ~120 effect types and ~110 keywords.
- **AI** (`src/ai/ai.js`): heuristic opponents that sequence lands and spells, pick targets, evaluate attacks and blocks, and answer every in-game choice.
- **UI** (`src/ui/`): React (loaded from cdnjs) on a felt table. Each player has a mat (battlefield rows, command zone, library/graveyard/exile piles, life and status); the table center shows the stack and recent plays; arrows show targets, attacks and blocks. Cards auto-shrink to fit each mat. Hover a card for full text; click to play; right-click any card or your life total for manual tools (move cards, counters, life, tokens) to fix anything the engine doesn't automate.
- **Online play** (`src/net/`): rooms for friends. Every browser runs the same deterministic game (same seed, same decks); players exchange only their decisions — each one the answer to an engine prompt, numbered in order — through room presence (`lockstep.js`): on the website, browsers find each other through public Nostr relays and connect directly over WebRTC ([Trystero](https://github.com/dmotz/trystero), `p2proom.js`; no accounts or game server); inside claude.ai, the artifact's room capability. The host's browser also decides for AI seats and can let the AI take over a player who left. Everyone keeps the full decision log in local storage, so a reload replays the game and rejoins; late spectators catch up from history served by the host. `roomclient.js` handles seats, decks and the host's config.
- **AI pacing** (`src/ui/pacing.js`): computer players think before each play, drop lands and tap them one at a time, and pause before attacks and blocks, at a tempo set by the AI speed setting. Headless games run with no delays.
- **Pokémon TCG** (`src/ptcg/`): its own rules engine (`game.js`: setup and mulligans, the once-per-turn actions, evolution and Rare Candy, retreat, Weakness and Resistance, special conditions and the Pokémon Checkup, Knock Outs and Prizes including ex and Mega Evolution ex, the win conditions), every card's attacks, Abilities and Trainers (`cards.js`), a computer opponent (`ai.js`) and the battle screen (`ui/`). Card text and pictures from [TCGdex](https://tcgdex.dev), decklists from [Limitless](https://limitlesstcg.com).
- **Symbols**: mana and card-type symbols from [mana-font](https://github.com/andrewgioia/mana) (MIT) and set symbols from [Keyrune](https://github.com/andrewgioia/keyrune) (font OFL-1.1), subsetted and inlined by `tools/build-symbols.mjs`.
- **Data** (`data/`): decklists from [taw/magic-preconstructed-decks](https://github.com/taw/magic-preconstructed-decks), card scripts from Forge. `support.json` lists the ~260 cards (about 4%) that use a mechanic the engine doesn't implement; those show a `!` badge in game.

## Build & run

```sh
npm install
node tools/build-data.mjs <path-to-magic-preconstructed-decks> <path-to-forge/forge-gui/res>   # regenerate data/
node tools/build.mjs        # bundle into dist/ (index.html, app.js, data/*.json)
npx serve dist              # any static file server works
npm run site                # build, then copy the site with its card images into docs/ for GitHub Pages
```

`docs/` is the website (page, app, data and the packed card images, about 240 MB). To update the live site: `npm run site`, commit `docs/`, push `main`, then `sh tools/deploy-pages.sh`, which publishes that folder as the `gh-pages` branch GitHub Pages serves (the images are the same files, so this push is tiny).

### Pokémon data

```sh
NODE_USE_ENV_PROXY=1 node tools/ptcg/scrape-decks.mjs <cache>/lists.json '{"Dragapult ex":284,...}'   # one top list per archetype
NODE_USE_ENV_PROXY=1 node tools/ptcg/fetch-cards.mjs <cache> '["Dragapult ex",...]'                  # TCGdex card records
node tools/ptcg/build-data.mjs <cache>                                                               # → data/ptcg/{cards,decks}.json
NODE_USE_ENV_PROXY=1 node tools/ptcg/fetch-images.mjs <cache>                                        # → dist/img/ptcg-*.avif + data/ptcg/images.json
```

### Card images

Card images are downloaded once, shrunk to 480px-wide AVIF and packed into files served next to the page (the claude.ai version can't load images from other sites). Each image is stored once: lobby packs of every deck's commanders, staples in 6+ decks (one printing each, grouped by color identity), packs of printings several decks share, one pack per deck for its own printings, and token packs. A game loads only the packs its decks use. Scryfall identifies each printing and its TCGplayer product; the picture is TCGplayer's product image, with Scryfall's image as the fallback and for back faces. Tokens are matched to Scryfall tokens by name, colors, power/toughness and keywords.

```sh
NODE_USE_ENV_PROXY=1 node tools/fetch-images.mjs <cache dir>   # → <cache>/img/*.avif (resumable)
NODE_USE_ENV_PROXY=1 node tools/fetch-tokens.mjs <cache dir>   # → <cache>/tokens/*.avif
node tools/pack-images.mjs <cache dir>    # → dist/img/*.avif + data/images.json
node tools/build.mjs
```

Without packs, cards render as drawn frames with full rules text.

To regenerate the symbol fonts: `node tools/build-symbols.mjs <mana-font package dir> <keyrune package dir> <path to pyftsubset>`.

## Testing

```sh
node tools/sim.mjs 50 2          # 50 headless AI-vs-AI games (2 players)
node tools/sim.mjs 20 4          # 4-player games
./tools/cardtest-all.sh 4 out/   # cast/activate every one of the 6,422 cards in a live game
node tools/coverage.mjs          # static report of unimplemented mechanics
node tools/staples.mjs           # behaviour tests for ~120 commonly played cards
node tools/serve-test.mjs &      # local server on :8765 for the browser tests
node tools/uitest.mjs out/ 80 1280 800 4-player   # click through a game in headless Chromium
node tools/shot.mjs out.png 14   # screenshot a mid-game table (an AI plays your seat first)
node tools/replaytest.mjs 30 4   # determinism: record an AI game, replay its decisions into a fresh engine, compare
node tools/nettest.mjs 5         # online play: host, guest (who reloads), late spectator and an AI seat in one room
node tools/mptest.mjs out/ 8     # online play in real browsers: create a room, join by code, play, reload, watch
P2P=1 node tools/mptest.mjs out/ 8   # the same over the website's real peer-to-peer rooms (needs internet)
```

Pokémon side:

```sh
node tools/ptcg/rules.mjs            # rules tests: Weakness/Resistance, Prizes, retreat, conditions, evolution, tricky cards
node tools/ptcg/sim.mjs 300          # headless computer-vs-computer games across every matchup
node tools/ptcg/uitest.mjs out/ 14   # click through a battle in headless Chromium like a person
node tools/ptcg/shot.mjs out/ 6      # screenshots: home, lobby, battle
```

## Hosting

`docs/` is a complete static site, so any static host can serve it. If GitHub's domains are blocked where you play (some schools block github.io), put it on another address. Both of these are free and redeploy automatically every time `main` is pushed:

**Cloudflare Pages** (address like `precon-arena.pages.dev`)
1. Sign in at dash.cloudflare.com, open **Workers & Pages**, then **Create → Pages → Connect to Git**.
2. Pick this repository. Framework preset: **None**. Build command: leave empty. Build output directory: **docs**.
3. **Save and Deploy**.

**Netlify** (address like `precon-arena.netlify.app`)
1. Sign in at app.netlify.com, then **Add new site → Import an existing project → GitHub**, and pick this repository.
2. The settings come from `netlify.toml` (publish `docs`, no build). **Deploy**, then rename the site under Site configuration if you like.

Online play works the same on any host (browsers connect peer to peer). A custom domain on either host is the least likely to be caught by school filters.

Unofficial fan project, not affiliated with Wizards of the Coast, Nintendo, Creatures or GAME FREAK. Magic: The Gathering is a trademark of Wizards of the Coast; Pokémon and the Pokémon TCG are trademarks of Nintendo, Creatures and GAME FREAK. Forge card scripts are GPL-3.0.
