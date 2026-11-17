// The room registry (the game kit's RoomRegistry): codes, the room cap, the idle sweep (a
// box's venue room stays open while a TV shows it), close causes, crash containment and
// debounced players_changed.

import { HostSeats, RoomRegistry, type SessionKind } from "@bargames/gamekit/server";
import { getAdminSettings } from "../admin/settings.js";
import { MAX_ROOMS, ROOM_SWEEP_INTERVAL_MS } from "../config.js";
import { GameError } from "./errors.js";
import { Room, type RoomTransport } from "./Room.js";

export const IDLE_CLOSE_REASON = "This room was closed after a long period of inactivity.";
export const ADMIN_CLOSE_REASON = "An administrator closed this room.";
export const ERROR_CLOSE_REASON = "Something went wrong and this room had to close.";

export type Rooms = RoomRegistry<Room>;

export function createRooms(transport: RoomTransport): Rooms {
  const rooms: Rooms = new RoomRegistry<Room>({
    create: (code, kind, ctx) => {
      const room = new Room(code, transport, kind);
      // A throw in one room's timer closes only that room.
      room.onFatalError = () => ctx.close(ERROR_CLOSE_REASON, "error");
      room.onPlayersChanged = () => rooms.notePlayers(room);
      return room;
    },
    maxRooms: MAX_ROOMS,
    // 4 letters from the kit's alphabet (no 0/O, 1/I/L); typed codes trimmed and uppercased.
    normalizeCode: (code) => code.trim().toUpperCase(),
    idleMinutes: () => getAdminSettings().roomIdleMinutes,
    sweepIntervalMs: ROOM_SWEEP_INTERVAL_MS,
    idleReason: IDLE_CLOSE_REASON,
    errorReason: ERROR_CLOSE_REASON,
    fullError: () => new GameError("ROOM_FULL"),
    // A "Join" button on the venue's games list, and the box's short room links.
    joinPath: (r) => `/join/${r.code}`,
  });
  return rooms;
}

/**
 * Bar Games create_room: a room the box starts for its TVs, with no host phone. It gets an
 * empty host seat ("Venue") that staff open with the host link. With firstJoinerHosts the
 * first phone in takes the seat instead, until anyone attaches to it.
 */
export function createVenueRoom(
  rooms: Rooms,
  kind: SessionKind = "venue",
  title?: string,
  firstJoinerHosts = false,
): { room: Room; hostToken: string } {
  let hostToken = "";
  const room = rooms.create(kind, (r) => {
    r.title = title?.trim().slice(0, 60) || undefined;
    r.addHost("Venue");
    r.seats = new HostSeats({ firstJoinerHosts });
    hostToken = r.seats.hostToken;
  });
  return { room, hostToken };
}
