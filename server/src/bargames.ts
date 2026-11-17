// The game's single connection to a Bar Games box (see BARGAMES.md).
//
// Off a box (no BG_CORE_URL / BG_GAME_TOKEN env) every call here is a no-op and the game runs
// standalone: that's guaranteed by the SDK.

import { wireBarGames } from "@bargames/gamekit/bargames";
import { createBarGames, type CommandResult } from "@bargames/sdk/server";
import type { IncomingMessage } from "node:http";
import { DEFAULT_GAME_NAME } from "@crowdsays/shared";
import { createVenueRoom, type Rooms } from "./rooms/registry.js";
import { cohostPath, hostPath, type Room } from "./rooms/Room.js";

export const bg = createBarGames({
  gameId: "crowdsays",
  defaultName: process.env.GAME_NAME || DEFAULT_GAME_NAME,
});

/** True when running on a box. Guards anything box-only. */
export const onBox = bg.connected;

/** Real player IP for rate limits and logs (cf-connecting-ip or the socket's address off a box). */
export const clientIp = (req: IncomingMessage): string => bg.clientIp(req);

/** Display name: the venue's rename on a box, otherwise GAME_NAME. */
export async function displayName(fallback: string): Promise<string> {
  return onBox ? (await bg.venue()).game.displayName : fallback;
}

/** Same text the host's own "End room" sends to everyone in the room. */
export const HOST_CLOSE_REASON = "The host ended this room.";

/**
 * Level 3 through the game kit's wireBarGames: status, room_created / room_closed /
 * players_changed, "end", create_room, the hosting commands, and start / next_round. Each
 * command runs the same Room method as the host's button, then broadcasts.
 */
export function registerBarGames(rooms: Rooms): void {
  /** fn returns a refusal message, or runs the host's Room method and returns nothing. */
  const asHost =
    (fn: (room: Room) => string | void) =>
    (room: Room): CommandResult => {
      const refused = fn(room);
      if (refused) return { ok: false, message: refused };
      room.broadcast();
      return { ok: true };
    };

  wireBarGames(bg, rooms, {
    // The box starts a room for its TVs. No host phone: the room runs itself (answers close on
    // the timer, the board goes up, phones guess) and the commands drive the rest. hostUrl opens
    // the empty host seat on the staff iPad. firstJoinerHosts: the first phone in hosts.
    createVenueRoom: ({ kind, title, firstJoinerHosts }) => {
      const { room, hostToken } = createVenueRoom(rooms, kind ?? "venue", title, firstJoinerHosts === true);
      room.broadcast();
      return { room, hostUrl: hostPath(room, hostToken) };
    },
    commands: {
      start: asHost((room) =>
        room.phase !== "lobby" && room.phase !== "gameOver" ? "A game is already being played." : room.startGame(),
      ),
      // The host's "Next round": from the results, or skipping the round in progress.
      next_round: asHost((room) =>
        room.phase === "lobby"
          ? "The game hasn't started yet."
          : room.phase === "gameOver"
            ? "This game is over. Use start for a new one."
            : room.nextRound(),
      ),
    },
    // SDK 0.14.0 / kit 0.8.0: host_link (staff take over; the old host stays on as a co-host),
    // cohost_link (a single-use, expiring invite) and remove_cohost.
    seats: {
      of: (room) => room.seats,
      hostPath,
      cohostPath,
      onTakeover: (room, previous) => {
        room.takeOver(previous);
        room.broadcast();
      },
      onCohostRemoved: (room, memberId) => {
        room.demoteCohost(memberId);
        room.broadcast();
      },
    },
    endReason: HOST_CLOSE_REASON,
    endCause: "host",
  });
}
