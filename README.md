# Crowd Says

A party game built on the room's own answers. Everyone answers a prompt on their phone
("Name something you bring to the beach"). The game groups matching answers, and teams take
turns guessing the most popular ones while the TV reveals them, from most to least popular,
with counts.

The crowd writes every answer board: the game ships prompts only, never survey answers.

It runs standalone or as a game module on a Bar Games box (see [BARGAMES.md](BARGAMES.md)).

## Run it

```bash
npm install
npm run dev        # server on :3013, Vite client on :5183
npm run build && npm start -w server   # production: the server serves the built client on :3013
npm run test:build # build, then run the tests (`npm test` alone uses the last build)
```

With Docker: `docker compose up -d --build` (publishes on `127.0.0.1:3013`; `HOST_PORT` changes it).

## Environment

| Variable | Default | |
|---|---|---|
| `PORT` | 3013 | |
| `DATA_DIR` | `./data` | admin password, settings, prompt packs, saved answers |
| `GAME_NAME` | Crowd Says | the name on every screen |
| `ADMIN_PASSWORD` | (unset) | overrides the password set on `/admin` |
| `BASE_PATH` | (unset) | serve under a path prefix behind your own proxy, e.g. `/crowdsays` |
| `ROOM_IDLE_MINUTES`, `MAX_ROOMS`, `MAX_PLAYERS_PER_ROOM`, `LOG_LEVEL` | | |

## Playing

1. The host taps **Host a game**, picks a prompt pack and the settings, and puts the TV view
   (`/join/CODE?as=table`) on a big screen. Players scan the QR code and pick a team.
2. Each round, everyone answers the prompt before the timer runs out.
3. The host checks the groups (merge, split, rename, leave off) and puts the board up.
4. The team in control guesses; strikes hand the other team a steal. The bank goes to whoever
   wins the round.

**Prompt packs:** upload CSV (one prompt per line) or JSON (`["…"]` or
`{ "name": "…", "prompts": ["…"] }`) on `/admin`.

## Layout

| | |
|---|---|
| `shared/` | protocol types, answer matching, profanity filter, packs and the starter pack |
| `server/` | Express + socket.io: rooms (`rooms/Room.ts` holds the rules), admin API, Bar Games wiring |
| `client/` | React: home/join, player, host, TV and admin screens |
| `test/` | `node:test` specs against real servers |
| `vendor/` | the Bar Games SDK and GameKit tarballs |
