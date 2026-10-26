# Cardforge

Three card battle simulators in one site:

- **Magic: The Gathering Commander** against AI opponents, or with friends, using any of the **194 preconstructed Commander decks** (Commander 2013 through 2026, including Universes Beyond and Secret Lair precons). 1v1 or up to 4-player free-for-all.
- **Pokémon TCG battles** against a computer opponent or a friend with **54 of the most-played tournament decks** (Dragapult ex, Charizard ex, Gardevoir ex, Raging Bolt ex, Gholdengo ex, Miraidon ex, Mega Absol Box, Chien-Pao Baxcalibur, Roaring Moon ex, Lost Zone Box, Slowking, N's Zoroark ex, Festival Lead, Alakazam Dusknoir, Hydrapple ex, Dhelmise, Mega Lopunny ex, Crustle, Basic Box, Mega Excadrill ex, Mega Lucario ex, Mega Sharpedo ex, Rocket's Honchkrow, Cynthia's Garchomp ex, Mew Box, Marnie's Grimmsnarl ex, Hop's Trevenant, Beedrill ex, Mega Venusaur ex, Yanmega ex, Steven's Metagross ex, Archaludon ex, Hop's Zacian ex, Regidrago VSTAR, Giratina VSTAR, Joltik Box, Froslass Munkidori, Ceruledge ex, Rocket's Mewtwo ex, Flareon ex, Greninja ex, Mega Starmie ex, Ethan's Typhlosion, Bloodmoon Ursaluna, Pidgeot Control, Okidogi, Toxtricity Box, Ho-Oh Armarouge, Terapagos ex, Conkeldurr, Mega Chandelure ex, Mega Greninja ex, Mega Diancie ex, Iron Thorns ex), card for card from Limitless decklists.
- **One Piece Card Game battles** against a computer opponent or a friend with **all 36 English starter decks** (ST-01 Straw Hat Crew to ST-36 Yellow Eustass"Captain"Kid, including the color-themed decks and the Ultra Decks, which let you pick any of the three Leaders in their box), each exactly as it comes in the box: a Leader, 50 cards and 10 DON!!. Point at or tap a keyword in any card's text to see what it does.

**Play it:** https://lotusgoats.com (the same site is also at https://stigz-s-mtga.stigzrblx.workers.dev and https://stigzmtg.github.io/Stigz-s-MTGA/)

## How it works

- **Rules engine** (`src/engine/`): a JavaScript interpreter for [Forge](https://github.com/Card-Forge/forge)'s card-script language. Every card's abilities, triggers, static effects and replacement effects are read from its Forge script, so rules text isn't hand-coded per card. It implements the turn structure, priority and the stack, state-based actions, combat (first strike, trample, deathtouch, menace, flying…), the command zone, commander tax and commander damage, ~120 effect types and ~110 keywords.
- **Engine tests**: `node tools/staples.mjs` (the most-played staples), `node tools/mechanics.mjs` (behavioural tests of keywords and mechanics) and `node tools/grants.mjs` (keywords given to spells by commanders like Henzie, Zinnia and Anhelo, and flash), harness in `tools/lib/testkit.mjs`.
- **AI** (`src/ai/ai.js`): heuristic opponents that sequence lands and spells, pick targets, evaluate attacks and blocks, and answer every in-game choice.
- **UI** (`src/ui/`): React (loaded from cdnjs) on a felt table. Each player has a mat (battlefield rows, command zone, library/graveyard/exile piles, life and status); the table center shows the stack and recent plays; arrows show targets, attacks and blocks. Cards auto-shrink to fit each mat. Hover a card for full text; click to play; right-click any card or your life total for manual tools (move cards, counters, life, tokens) to fix anything the engine doesn't automate.
- **Online play** (`src/net/`): rooms for friends. Every browser runs the same deterministic game (same seed, same decks); players exchange only their decisions — each one the answer to an engine prompt, numbered in order — through room presence (`lockstep.js`): on the website, through the site's own relay (`worker/index.js`, a Cloudflare Durable Object per room; `relayroom.js` connects by WebSocket, or by HTTP polling where WebSockets are blocked), so rooms work on school and office Wi-Fi; if no relay can be reached, browsers connect directly over WebRTC ([Trystero](https://github.com/dmotz/trystero), `p2proom.js`); inside claude.ai, the artifact's room capability. The host's browser also decides for AI seats and can let the AI take over a player who left. Everyone keeps the full decision log in local storage, so a reload replays the game and rejoins; late spectators catch up from history served by the host. `roomclient.js` handles seats, decks and the host's config (the host keeps a copy, so it can reload and pick its room back up). Commander, Pokémon and One Piece rooms use the same layer; Pokémon room links look like `#pk-abc123` and One Piece ones like `#op-abc123`.
- **Deck builder and AI deck helper** (`src/ui/builder.jsx`, `deckai.js`, `deckhelper.jsx`): build your own Commander decks from the scripted cards. The helper is a chat that runs in the page (no server or account): it reads every card's rules text for the job it does (ramp, card draw, removal, board wipes, counterspells, tutors, protection, recursion) and the plans it belongs to (tokens, +1/+1 counters, graveyard, spells, artifacts, enchantments, lifegain, sacrifice, landfall, attacking, flying, Equipment/Auras, big creatures, creature types), reads the commander the same way, and scores every card in its colors by fit with the plan, the jobs the deck is short on, how many precons play it and its cost. It finds commanders for what you like ("dragons", "golgari graveyard"), builds or finishes a deck (lands and basics included, with undo), reviews it, suggests cards for one job or plan, picks cuts and swaps in cheaper cards.
- **Avatars** (`src/ui/avatar.jsx`): in friends' rooms everyone is a little animal with a human body (10 animals, outfits, colors, hats, extras, backgrounds), drawn as SVG from a short code that travels in room presence and seats.
- **Save codes** (`src/ui/savecode.js`, `savedialog.jsx`, the `/save/` part of `worker/index.js`): take your progress to another device with no account. Everything kept in the browser (records and replays, your own decks, avatar, name, sleeves, settings) is packed and compressed into one string and stored on the site's server (a Cloudflare Durable Object per code) under a code like `K7QM-4ZP2`. A device that made or loaded a code saves to it again after each game or deck change, and when the site opens it brings in what other devices saved since; games and decks from every device are combined, never overwritten (a deleted deck stays deleted). Screen size, animations and the device's id in rooms stay with each device. Where the server can't be reached (the claude.ai copy), the same save works as a long `TCGSAVE:` text to copy and paste. Codes nobody uses for 400 days are deleted.
- **Accounts** (`worker/accounts.js`, `src/ui/account.js`, `accountdialog.jsx`): make one with a username, an email and a password, then log in with the username or the email on any device. Each username belongs to one person only, whatever its capitals (one Durable Object holds every account, with the username and email as UNIQUE columns, so two people asking for the same name at once can't both get it); reserved and rude names are refused. Passwords are PBKDF2-SHA256 hashed (100,000 rounds, a salt each); a login is a random session token kept in the browser, of which the server only stores a hash. Every account gets a recovery code (shown once, renewed when used) to set a new password; if an email service is set up (below), emails can also be confirmed and passwords reset with a 6-digit code. Logins, sign-ups and codes are rate limited. A logged-in device saves its progress to the account's save code, so logging in anywhere brings your record, decks and avatar, and your username becomes your name in rooms; logging out can also clear a shared computer. Accounts are for players 13 and older (a birth month and year question, not stored). You can delete your account (the name becomes free again).
- **Verified badges in friends' rooms** (`src/ui/badge.jsx`, `POST /account/badge`): a logged-in player plays under their account name, and their presence carries a badge the server signs with its own ECDSA P-256 key ("this account, in this room, as this player id, for 24 hours"). Every other browser checks the signature with the server's public key (`GET /account/badgekey`) before showing a blue ✓ next to that name, in room seat lists, lineups and watcher lists and on the table in all three games. A typed name never gets the ✓, and a copied badge fails on another player, in another room or once it runs out.
- **Sleeves and deck boxes** (`src/ui/deckstyle.jsx`): each deck can have its own card sleeves (the backs of your cards at the table) and deck box (shown in the lobby and in friends' rooms), drawn as SVG from short codes saved per deck and carried in room presence.
- **AI pacing** (`src/ui/pacing.js`): computer players think before each play, drop lands and tap them one at a time, and pause before attacks and blocks, at a tempo set by the AI speed setting. Headless games run with no delays.
- **Pokémon TCG** (`src/ptcg/`): its own rules engine (`game.js`: setup and mulligans, the once-per-turn actions, evolution and Rare Candy, retreat, Weakness and Resistance, special conditions and the Pokémon Checkup, Knock Outs and Prizes including ex and Mega Evolution ex, the win conditions), every card's attacks, Abilities and Trainers (`cards.js`), a computer opponent (`ai.js`) and the battle screen (`ui/`). Card text and pictures from [TCGdex](https://tcgdex.dev), decklists from [Limitless](https://limitlesstcg.com).
- **One Piece Card Game** (`src/optcg/`): its own rules engine (`game.js`, by the Comprehensive Rules v1.2.1: the coin flip, mulligan and Life setup, Refresh/Draw/DON!!/Main/End phases, DON!! paying costs and given to cards, attacks with the Block and Counter steps, [Trigger]s on Life cards, Rush, Blocker, Double Attack, Banish, rested Characters, the 5-Character limit and the win conditions; no battles on either player's first turn). Card effects are compiled from each card's printed text (`text.js`, with a few overrides in `cards.js`), so every [On Play], [When Attacking], [Activate: Main], [DON!! xN], [Counter] and [Trigger] works; an effect the compiler can't read never stops a game. A computer opponent (`ai.js`), the battle screen (`ui/`) and the engine's interface for the table (`API.md`). Card text from the official English card list, decklists checked against several published lists (see [One Piece data](#one-piece-data)).
- **Symbols**: mana and card-type symbols from [mana-font](https://github.com/andrewgioia/mana) (MIT) and set symbols from [Keyrune](https://github.com/andrewgioia/keyrune) (font OFL-1.1), subsetted and inlined by `tools/build-symbols.mjs`.
- **Data** (`data/`): decklists from [taw/magic-preconstructed-decks](https://github.com/taw/magic-preconstructed-decks), card scripts from Forge. `support.json` lists the cards that use a mechanic the engine doesn't implement (one left, Cruel Entertainment, which would need one player to make another's decisions for a turn); such cards show a `!` badge in game.

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

### One Piece data

The 36 English starter decks (ST-01 to ST-36), card for card. Card text comes from the official English card list (en.onepiece-cardgame.com), with [optcgapi](https://optcgapi.com) as a cross-check. Each decklist is accepted only when at least two independent published lists give the same 50 cards. The sources are Limitless, Egman Events, Tier One Media, yuyu-tei, LaughTale, TCGplayer and photos of opened decks; `tools/optcg/decklists.mjs` names them and reads them. `data/optcg/sources.json` records what each source said, every card number it got wrong, and the list that was used. An Ultra Deck (ST-10, ST-13) holds three Leaders that all work with its 50 cards: its entry lists them in `leaders`, and a deck id like `st13@ST13-001` (in rooms, records and replays) means that deck led by that Leader.

```sh
NODE_USE_ENV_PROXY=1 node tools/optcg/fetch-cards.mjs <cache>    # official card lists, product pages, optcgapi, every decklist page
node tools/optcg/build-data.mjs <cache> [--diffs]                # → data/optcg/{cards,decks,sources}.json (--diffs: where optcgapi's text differs)
NODE_USE_ENV_PROXY=1 node tools/optcg/fetch-images.mjs <cache>   # → docs/img/optcg-*.avif (and dist/img/) + data/optcg/images.json
node tools/optcg/check-data.mjs                                  # every deck is 1 Leader + 50 cards, ≤4 copies, in the Leader's colors, fully defined and pictured
node tools/optcg/pack-thumbs.mjs                                 # → img/optcg-thumbs.avif: Leaders and featured cards at 240px for the menus (fetch-images.mjs runs it)
```

The official card pictures carry a "SAMPLE" watermark, and so do most of TCGplayer's. `fetch-images.mjs` uses a TCGplayer scan when it finds one with no watermark and the same art. Otherwise it uses the official picture. Its choices are kept in `tools/optcg/tcg-ids.json`. Deck blurbs live in `tools/optcg/blurbs.mjs`.

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
node tools/grants.mjs            # keywords other cards give spells and cards in hand/graveyard (blitz, offspring, casualty, flashback, ...) and flash windows
node tools/serve-test.mjs &      # local server on :8765 for the browser tests
node tools/uitest.mjs out/ 80 1280 800 4-player   # click through a game in headless Chromium
node tools/shot.mjs out.png 14   # screenshot a mid-game table (an AI plays your seat first)
node tools/replaytest.mjs 30 4   # determinism: record an AI game, replay its decisions into a fresh engine, compare
node tools/nettest.mjs 5         # online play: host, guest (who reloads), late spectator and an AI seat in one room
node tools/mptest.mjs out/ 8     # online play in real browsers: create a room, join by code, play, reload, watch
node tools/savetest.mjs http://localhost:8787   # save codes: merging, packing, two devices sharing a code (server from `npx wrangler dev`)
node tools/saveui.mjs out/       # save codes in real browsers against `npx wrangler dev` (make a code, load it elsewhere, save text)
node tools/accounttest.mjs       # accounts API against `npx wrangler dev`: unique names (also when asked at the same moment), logins, sessions, recovery, limits
node tools/accountui.mjs out/    # accounts in real browsers: sign up, log in elsewhere, taken names, the age question, recovery, shared-computer log out
node tools/badgeui.mjs out/      # verified badges in real rooms (Commander and Pokémon), against `npx wrangler dev`
P2P=1 node tools/mptest.mjs out/ 8   # the same over the website's real peer-to-peer rooms (needs internet)
```

Readability and smoothness (all games):

```sh
node tools/textaudit.mjs out/        # every visible text: size, contrast against what is drawn behind it, blur-prone transforms
node tools/perfaudit.mjs 4 6         # frame times and long tasks with the CPU slowed 4x (home page, a battle, a 4-player game)
NOMINIFY=1 node tools/build.mjs      # readable function names for profiling
```

Pokémon side:

```sh
node tools/ptcg/rules.mjs            # rules tests: Weakness/Resistance, Prizes, retreat, conditions, evolution, tricky cards
node tools/ptcg/sim.mjs 300          # headless computer-vs-computer games across every matchup
node tools/ptcg/invariants.mjs 4     # every pairing of decks N times, checking the game state after every action (60 cards each, no negative damage, Prizes, Bench, once-per-turn rules, replays); --selftest injects faults
node tools/ptcg/uitest.mjs out/ 14   # click through a battle in headless Chromium like a person
node tools/ptcg/nettest.mjs 6        # battles with a friend, headless: every peer identical after a reload, a late watcher, an AI takeover (TAKEOVER=1)
node tools/ptcg/mptest.mjs out/ 8    # the same in real browsers: invite link, seats, battle, reload, watcher, end and restart (P2P=1 for real rooms)
node tools/ptcg/shot.mjs out/ 6      # screenshots: home, lobby, battle
```

One Piece side:

```sh
node tools/optcg/rules.mjs              # rules tests: phases, DON!!, battles, Counters, Triggers, keywords and the tricky cards
node tools/optcg/coverage.mjs           # every card's text compiles to effects (fails on anything the compiler can't read)
node tools/optcg/sim.mjs 40             # headless computer-vs-computer games (--deck=st01 --opp=st02, --log)
node tools/optcg/invariants.mjs 6       # every pairing of decks, checking the game state after every action (--chaos: random clicks, --odd, --busy, --selftest)
node tools/optcg/nettest.mjs 4          # battles with a friend, headless: peers identical after a reload, a late watcher (CHAOS=1, TAKEOVER=1)
DECK=st01 OPP=st02 node tools/optcg/uitest.mjs out/ 12   # click through a battle like a person (MOBILE=1 on a touch phone, REPLAY=1 checks the replay, SHOTS=dir screenshots every kind of question)
node tools/optcg/mptest.mjs out/ 8      # in real browsers: invite link, seats, battle, reload, watcher, end and restart
```

## Hosting

`docs/` is a complete static site, so any static host can serve it. If GitHub's domains are blocked where you play (some schools block github.io), put it on another address. Both of these are free and redeploy automatically every time `main` is pushed:

**Cloudflare Pages** (address like `precon-arena.pages.dev`)
1. Sign in at dash.cloudflare.com, open **Workers & Pages**, then **Create → Pages → Connect to Git**.
2. Pick this repository. Framework preset: **None**. Build command: leave empty. Build output directory: **docs**.
3. **Save and Deploy**.

The Cloudflare Worker also runs the room relay and save codes (`worker/index.js`, see `wrangler.toml`; save codes only work on a host with the Worker, and the GitHub Pages copy uses the Worker's address for both); test it locally with `npx wrangler dev --assets dist --port 8787` and `RELAY=1 BASE=http://localhost:8787/ node tools/ptcg/mptest.mjs` (`RELAY=poll` treats WebSockets as blocked). If Cloudflare sets it up as a Worker instead (an address like `stigz-s-mtga.<account>.workers.dev`), `wrangler.toml` tells it to serve `docs/`; its `name` must match the Worker's name. The live copy is at https://lotusgoats.com (a custom domain on the Worker: the domain's DNS is on Cloudflare, attached under the Worker's **Settings → Domains & Routes**), and still at https://stigz-s-mtga.stigzrblx.workers.dev.

**Email codes for accounts (optional).** Accounts work without email: forgotten passwords use the recovery code. To also confirm emails and send password-reset codes, make a free account at [resend.com](https://resend.com), add a domain you own there (it needs a domain to send from), create an API key, then in the Cloudflare dashboard open the Worker, **Settings → Variables and Secrets**, and add a secret `RESEND_API_KEY` (the key) and a variable `MAIL_FROM` (for example `Cardforge <codes@yourdomain.com>`). The site notices by itself.

**Netlify** (address like `precon-arena.netlify.app`)
1. Sign in at app.netlify.com, then **Add new site → Import an existing project → GitHub**, and pick this repository.
2. The settings come from `netlify.toml` (publish `docs`, no build). **Deploy**, then rename the site under Site configuration if you like.

Online play works the same on any host (browsers connect peer to peer). A custom domain on either host is the least likely to be caught by school filters.

Unofficial fan project, not affiliated with the Forge project (Card-Forge), Wizards of the Coast, Nintendo, Creatures or GAME FREAK. Magic: The Gathering is a trademark of Wizards of the Coast; Pokémon and the Pokémon TCG are trademarks of Nintendo, Creatures and GAME FREAK. Forge card scripts are GPL-3.0.
