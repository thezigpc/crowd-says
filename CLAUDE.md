# Crowd Says: notes for Claude

A Bar Games game module that also runs standalone. Read [BARGAMES.md](BARGAMES.md) for the box
integration and [README.md](README.md) for running it.

## Rules

- **Don't edit** GameBroker, GameKit or other game repos. Platform needs go to the GameBroker
  session as "SDK requests" (and into BARGAMES.md).
- **Standalone must not depend on a box:** box-only behaviour goes behind `bg.connected`
  (server) or `isOnBox(ctx)` (client).
- **No survey data:** never add answers from a TV show or published game. Prompts are original
  (`shared/src/packs.ts`) or the venue's own.
- **Versions are immutable on a box:** any change that should reach a box needs a new
  `version` and the matching `image` tag in `bargames.json`, in the same commit.
- **Testing on this PC:** several sessions run mock boxes and game servers. Check ports first,
  and stop only the PIDs on ports you started, never by process name.
  - My usual ports: game 3013, mock gateway 7113, mock core 7213.
  - Mock box: `MSYS_NO_PATHCONV=1 npx bargames mock-box . --base /crowdsays --port 7113 --core-port 7213`.
  - Check: `npx bargames check . --game http://127.0.0.1:3013 --port 7113 --core-port 7213`.

## Code map

- `server/src/rooms/Room.ts`: every rule, in one class.
  - Phases: `lobby → answer → group → guess → roundEnd → … → gameOver`.
  - `viewFor` decides what each role sees. Hidden answers go only to runners.
- `server/src/content/`: venue prompt packs (`packs.json`) and saved answers (`answers.json`,
  per prompt, with the host's merges and splits).
- `shared/src/answers.ts`: the answer keys (normalise, singular, synonyms, typos). Grouping and
  guess matching both use them.
- `test/specs/*.test.mjs`: run `npm run build` first. Each spec starts its own server on a free
  port with its own data directory.
