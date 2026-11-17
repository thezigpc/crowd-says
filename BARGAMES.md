# Crowd Says on Bar Games

Crowd Says is a game module for the Bar Games box that also runs standalone. Off a box (no
`BG_*` environment) every SDK call is a no-op.

- **Level:** 3 (controllable).
- **SDK:** `@bargames/sdk` 0.16.0 (`vendor/bargames-sdk-0.16.0.tgz`).
- **GameKit:** 0.10.6 (`vendor/bargames-gamekit-0.10.6.tgz`): RoomRegistry, HostSeats, wireBarGames,
  JoinAddress, admin auth (`bodyLimit` for pack uploads), serveSpa, OnScreenKeyboard.
- **Port:** 3013. **Routing:** `routing.basePath: true` (served under `/crowdsays/` on a box).
- **Image:** `ghcr.io/thezigpc/crowdsays:0.1.1`.

## The game

1. **Answer.** Every phone gets a prompt and types one short answer (changeable until answers
   close). A timer closes the answers, or they close when every connected player has answered.
2. **Group.** The server groups matching answers. It ignores case, punctuation, leading
   "a/the/my", plurals and spacing, and forgives small typos on longer words. A short built-in
   synonym list does the rest ("sunscreen" = "sunblock"). The host then merges groups, splits an
   answer out, renames a group or leaves one off, and puts the board up.
3. **Guess.** Teams take turns. The team in control guesses from any of its phones, or the host
   types the guess called out, or taps a slot to reveal it. A hit reveals the slot and adds its
   count to the bank. A miss is a strike. After the last strike (3 by default) the next team gets
   one steal guess: right takes the bank, wrong gives it to the team in control. Clearing the
   board banks it too. The starting team alternates by round.

**Content:** no survey data ships. Prompts come from the original starter pack
(`shared/src/packs.ts`, written for this game) or the venue's own packs (CSV or JSON, uploaded on
`/admin`). The answers on every board are the room's own.

**Small rooms:** with fewer than 8 answers, the host can mix in up to 30 answers saved from
earlier games at this venue for the same prompt. They are marked "saved" on the host's screen.
Saved answers live only in `DATA_DIR/answers.json` (text only, no names). The host's merges and
splits for that prompt are saved with them, so the next game groups the same way. Admin can
clear them.

**Profanity filter:** on by default; the host can switch it off per room. It covers answers,
guesses, team names, player names and custom prompts. Saved answers that fail it are never
mixed into a filtered room.

## Manifest

`bargames.json`. `npx bargames validate .` passes, with the expected "not pinned by digest"
warning.

| Field | Value |
|---|---|
| routes | player `/`, table `/join/{code}?as=table`, host `/`, admin `/admin` |
| events | `room_created`, `room_closed`, `players_changed`, `round_started`, `round_ended`, `winner`, `game_over` |
| commands | `create_room`, `start`, `next_round`, `end`, `host_link`, `cohost_link`, `remove_cohost` |
| results | `bg.reportResults` with teams as the players, `player.team: true` (SDK 0.16.0); `game_result` is sent by the SDK |

## Events

| Event | Where | `data` |
|---|---|---|
| `room_created`, `room_closed`, `players_changed` | the kit (`wireBarGames` on the RoomRegistry) | kit shapes |
| `round_started` | `server/src/rooms/Room.ts:482` (`beginRound`) | `{ round, prompt }` |
| `round_ended` | `Room.ts:865` (`finishRound`); a skipped round at `Room.ts:917` | `{ round, prompt, winner, points, scores: [{ team, score }], skipped? }` |
| `winner` | `Room.ts:935` (`finishGame`), only when someone scored | `{ name, score, tie }` (tied teams joined with " & ") |
| `game_over` | `Room.ts:936` | `{ winners: [team names], scores, rounds }` |
| results | `Room.ts:943` | `results: [{ player: { name: team, team: true }, place, score }]`; teams with players or points; ties share a place |

## Commands

All of them run the same Room method as the host's button, then broadcast (`server/src/bargames.ts`).

| Command | Room method | Refused when |
|---|---|---|
| `create_room` | `createVenueRoom` (an empty "Venue" host seat, `HostSeats({ firstJoinerHosts })`) | the room cap is reached |
| `start` | `startGame` | a game is already being played; no players yet |
| `next_round` | `nextRound`: from the results; mid-round it skips the round (nobody scores); after the last round it's the final scores | lobby; game over |
| `end` | the kit closes the room like the host's "End room" | unknown room |
| `host_link` / `cohost_link` / `remove_cohost` | kit 0.8.0 `HostSeats`, then `takeOver` / `demoteCohost` | not a co-host (remove) |

**`firstJoinerHosts`:** the first phone to join becomes the host. Any attach to the host seat
closes the offer, staff opening the host link included (`noteAttached` → `HostSeats.hostAttached`).

**A room nobody hosts runs itself.** With no host or co-host phone connected:
- the board goes up as soon as answers close, mixing in saved answers first when the room is small;
- phones guess;
- the results move on to the next round after 20 s.

`start`, `next_round` and `end` drive the rest.

## Status

The kit's `rooms.overviews()`:
- `phase` (lobby, answer, group, guess, roundEnd, gameOver);
- `round`;
- `title` ("Round 2: Name something…");
- `hostConnected`, `hostName`, `maxPlayers`, `tables`;
- `joinPath` `/join/CODE` (the games list's Join button, and box 0.15.6's short room links).

## TV view (`/join/{code}?as=table`)

- [x] The URL alone joins as a display: no name, no tap.
- [x] No audio.
- [x] 1080p with no scrolling, text 3vh or larger, safe margins from `tableMode` (`--bg-safe-x/y`).
- [x] Reconnects by itself (`useRoomConnection` re-sends `resume`); `tableMode` shows "Reconnecting…" and "Room closed".
- [x] Light animation: one flip when a slot is revealed; none with reduced motion.
- [x] No pointer needed. The pointer is hidden by `tableMode` on a box.
- The TV shows the join QR code with the kit's `JoinAddress` (the short room link
  `play.<venue>/CODE` when the box has one) and the room code, team scores, whose turn it is,
  strikes, the bank and the last guesses. It never gets hidden answers: those are sent to
  runners only.
- Staff announcements hide on the TV (`tableMode` marks it shared); the host's own
  "board on this screen" is marked with `markSharedScreen`.

## On-screen keyboard (kit 0.10.0, box 0.21.0 touchscreens)

- `<OnScreenKeyboard />` is mounted once in `client/src/main.tsx`. The game is one app, so that
  covers every page: join, player, host, "board on this screen" and admin.
- Every text field is a real `<input>` with `maxLength`, inside a `<form onSubmit>`, so Enter
  submits. The admin's idle-minutes field is `type="text" inputMode="numeric"` (number pad; kit
  0.10.4 advises against `type="number"`). The room code has `autoCapitalize="none"` (it
  uppercases itself).
- Dropdowns (the host's settings, moving a player) open the kit's big-button list on keyboard
  screens (kit 0.10.6). There is no global `white-space: nowrap` on buttons to leak into it.
- **Covered:** the error toast is the only thing fixed to the bottom. It sits above the open
  keyboard with `var(--bargames-keyboard, 0px)` (kit 0.10.2).
- **Big screens:** at 2400 px wide and up (a 4K kiosk) the phone pages are drawn at twice the
  size. The TV view sizes itself in vh and is unaffected.
- **Tested** on the mock box with `?bg_keyboard=1` at 1080p and 4K, all typed on the keyboard
  with real pointer presses:
  - the room code and a name, then Enter to join;
  - a rude answer: refused, and the message shows above the keyboard;
  - backspace, then a real answer, then Enter to send it;
  - host (0.1.1): the Teams dropdown opens the kit's list and choosing "3" makes 3 teams; on the
    grouping screen the rename field (autoFocus) opens the keyboard, and Enter saves the label.

  At phone width without the flag, focusing a field shows no keyboard.

## Container

- **Writes** only under `DATA_DIR` (`/data`): `admin.json`, `settings.json`, `packs.json` and
  `answers.json`.
- **Image:** runs as `node` with `/data` owned by it. `docker-compose.yml` runs it `read_only`
  with a `/tmp` tmpfs and `cap_drop: ALL`.
- **Not tested here:** the read-only `docker run` and the clean-checkout build. Docker isn't
  installed on the development PC, so the publish workflow's build is the first one.

## Standalone

- **No change to check:** this is a new game, so there was no earlier behaviour.
- **Off a box:**
  - `/api/config` returns `GAME_NAME` (default "Crowd Says");
  - `venue.json` says `standalone: true`;
  - `/__bargames/status` and `/command` answer 401;
  - spoofed `x-bargames-*` headers are ignored for staff sign-in and for the join rate limit.

  Tests: `test/specs/05-bargames.test.mjs`.

## Checks

`npx bargames check` against the mock box, with the game on 3013, the gateway on 7113, the core
on 7213 and `--base /crowdsays`:

```
✓ health /health → 200
✓ /__bargames/venue.json returns the box's branding ("Crowd Says (mock)")
✓ /__bargames/theme.css served
✓ "room_closed" declared (the box takes a closed room off the TVs at once)
✓ status refuses requests without the game token
✓ status → 0 room(s)
✓ unknown commands are rejected
✓ command "start" is wired (and refuses a missing room)
✓ command "next_round" is wired (and refuses a missing room)
✓ command "end" is wired (and refuses a missing room)
✓ command "host_link" is wired (and refuses a missing room)
✓ command "cohost_link" is wired (and refuses a missing room)
✓ command "remove_cohost" is wired (and refuses a missing room)
✓ create_room → room FUQF (with hostUrl)
✓ status lists FUQF as a venue room
✓ table view /join/FUQF?as=table → 200
✓ host_link answers a new host link each time (take-over)
✓ cohost_link answers single-use invites that expire
✓ end closes FUQF
✓ FUQF left status after "end"

all checks passed
```

`npm test` runs 29 tests in 6 files, each against its own server:
- answer matching, the filter and pack parsing;
- a full game;
- small rooms and saved answers across a restart;
- co-hosts, reconnects and the TV;
- the box: commands, events, results, take-over, first joiner, a hostless room;
- admin: packs (including a 24 kB CSV), saved answers and rooms.

## SDK requests

None for 0.1.0.
