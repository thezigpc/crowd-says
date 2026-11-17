import type { Server, Socket } from "socket.io";
import { ERRORS, type ClientToServerEvents, type JoinResult, type RoomSettings, type ServerToClientEvents } from "@crowdsays/shared";
import { log } from "@bargames/gamekit/server";
import { clientIp, HOST_CLOSE_REASON } from "../bargames.js";
import { GameError } from "../rooms/errors.js";
import { cohostPath, type Member, type Room } from "../rooms/Room.js";
import type { Rooms } from "../rooms/registry.js";

interface SocketData {
  code?: string;
  memberId?: string;
  lastEvent?: string;
}
export type IO = Server<ClientToServerEvents, ServerToClientEvents, object, SocketData>;
type S = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;
type AckFn = (res: { ok: boolean; [k: string]: unknown }) => void;

// Failed join/resume attempts per IP: the room code is the only gate on the join URL, so
// guessing codes must not be free.
const JOIN_WINDOW_MS = 60_000;
const JOIN_FAILS_ALLOWED = 20;
const joinFails = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (joinFails.get(ip) ?? []).filter((t) => now - t < JOIN_WINDOW_MS);
  joinFails.set(ip, recent);
  return recent.length >= JOIN_FAILS_ALLOWED;
}
function noteJoinFail(ip: string): void {
  const list = joinFails.get(ip) ?? [];
  list.push(Date.now());
  joinFails.set(ip, list);
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of joinFails) if (list.every((t) => now - t >= JOIN_WINDOW_MS)) joinFails.delete(ip);
}, JOIN_WINDOW_MS).unref();

export function registerSocketHandlers(io: IO, rooms: Rooms): void {
  io.on("connection", (socket: S) => {
    // On a Bar Games box: the gateway's x-bargames-client-ip; standalone: cf-connecting-ip or
    // the socket address. clientIp() picks the right one.
    const ip = clientIp(socket.request);
    socket.onAny((event: string) => {
      socket.data.lastEvent = event;
    });

    const fail = (ack: AckFn | undefined, err: unknown) => {
      if (!(err instanceof GameError)) {
        log.error("socket", "handler threw", { event: socket.data.lastEvent, err: String(err) });
      }
      log.warn("socket", "rejected", {
        event: socket.data.lastEvent,
        code: socket.data.code,
        member: socket.data.memberId,
        error: err instanceof GameError ? err.code : "INTERNAL",
      });
      if (typeof ack === "function") ack({ ok: false, error: err instanceof GameError ? err.message : ERRORS.BAD_REQUEST });
    };

    const unbind = () => {
      const { code, memberId } = socket.data;
      socket.data.code = undefined;
      socket.data.memberId = undefined;
      if (code && memberId) {
        const room = rooms.get(code);
        if (room) {
          room.detachSocket(memberId, socket.id);
          room.broadcast();
        }
      }
    };

    const bind = (room: Room, member: Member): JoinResult => {
      if (socket.data.code !== room.code || socket.data.memberId !== member.id) unbind();
      room.attachSocket(member, socket.id);
      // "First joiner hosts": once anyone holds the host seat (the staff's host link, or the
      // first phone), the next phone is a player (the kit's HostSeats.hostAttached).
      room.noteAttached(member);
      socket.data.code = room.code;
      socket.data.memberId = member.id;
      return { code: room.code, token: member.token, memberId: member.id, role: member.role, name: member.name };
    };

    /** Runs a room-scoped intent, then broadcasts the new state to everyone. */
    function on<A>(event: keyof ClientToServerEvents, fn: (room: Room, memberId: string, arg: A) => object | void) {
      (socket.on as (e: string, h: (...args: unknown[]) => void) => void)(event, (...args: unknown[]) => {
        const ack = args[args.length - 1] as AckFn;
        const arg = (args.length > 1 ? args[0] : undefined) as A;
        try {
          const { code, memberId } = socket.data;
          const room = code ? rooms.get(code) : undefined;
          if (!room || !memberId || !room.members.has(memberId)) throw new GameError("NOT_IN_ROOM");
          const result = fn(room, memberId, arg) ?? {};
          room.broadcast();
          if (typeof ack === "function") ack({ ok: true, ...result });
        } catch (err) {
          fail(ack, err);
        }
      });
    }

    /** A runner's (host or co-host) intent. */
    function onRunner<A>(event: keyof ClientToServerEvents, fn: (room: Room, arg: A, memberId: string) => object | void) {
      on<A>(event, (room, id, arg) => {
        room.requireRunner(id);
        return fn(room, arg, id);
      });
    }

    socket.on("createRoom", (req, ack) => {
      try {
        const room = rooms.create("patron", (r) => {
          r.addHost(String(req?.name ?? "").trim().slice(0, 24));
        });
        const host = room.members.get(room.hostId)!;
        const result = bind(room, host);
        ack({ ok: true, ...result });
        room.broadcast();
      } catch (err) {
        fail(ack as AckFn, err);
      }
    });

    // The join page asks which teams there are before the player picks one.
    socket.on("roomInfo", (req, ack) => {
      try {
        if (rateLimited(ip)) throw new GameError("RATE_LIMITED");
        const room = rooms.get(String(req?.code ?? ""));
        if (!room) {
          noteJoinFail(ip);
          throw new GameError("ROOM_NOT_FOUND");
        }
        const view = room.viewFor({ id: "", token: "", role: "table", name: "", team: null, socketIds: new Set(), lastGuessAt: 0 });
        ack({ ok: true, teams: view.teams.map((t) => ({ index: t.index, name: t.name, color: t.color, players: t.players.length })) });
      } catch (err) {
        fail(ack as AckFn, err);
      }
    });

    socket.on("joinRoom", (req, ack) => {
      try {
        if (rateLimited(ip)) throw new GameError("RATE_LIMITED");
        const room = rooms.get(String(req?.code ?? ""));
        if (!room) {
          noteJoinFail(ip);
          throw new GameError("ROOM_NOT_FOUND");
        }
        if (req.role !== "player" && req.role !== "table") throw new GameError("BAD_REQUEST");
        // A known token means "same seat again", never a second seat.
        const existing = room.seatFor(req.token);
        let member: Member;
        if (req.cohost !== undefined) {
          // A co-host invite (the host's or the box's "Add a co-host" QR): single use.
          if (req.role !== "player" || !room.seats.redeem(req.cohost)) throw new GameError("BAD_INVITE");
          member = room.seatCohost(existing, req.name);
        } else {
          // A box room with nobody hosting yet ("first joiner hosts"): the first phone in takes
          // the host seat instead of a player seat.
          member =
            existing ??
            (req.role === "player" && room.seats.offerOpen
              ? room.claimHostSeat(req.name)
              : room.addMember(req.role, req.name, typeof req.team === "number" ? req.team : undefined));
        }
        const result = bind(room, member);
        log.info("room", existing ? "rejoined" : "joined", { code: room.code, role: member.role, name: member.name });
        ack({ ok: true, ...result });
        room.broadcast();
      } catch (err) {
        fail(ack as AckFn, err);
      }
    });

    // Sent by the client on EVERY socket connect: socket.io's reconnect gives the server a new
    // socket with no room binding.
    socket.on("resume", (req, ack) => {
      try {
        if (rateLimited(ip)) throw new GameError("RATE_LIMITED");
        const room = rooms.get(String(req?.code ?? ""));
        if (!room) {
          noteJoinFail(ip);
          throw new GameError("ROOM_NOT_FOUND");
        }
        const member = room.seatFor(req?.token);
        if (!member) {
          noteJoinFail(ip);
          throw new GameError("BAD_TOKEN");
        }
        const result = bind(room, member);
        ack({ ok: true, ...result });
        room.broadcast();
      } catch (err) {
        fail(ack as AckFn, err);
      }
    });

    socket.on("leaveRoom", (ack) => {
      const { code, memberId } = socket.data;
      const room = code ? rooms.get(code) : undefined;
      socket.data.code = undefined;
      socket.data.memberId = undefined;
      if (room && memberId) {
        if (memberId === room.hostId) {
          rooms.closeRoom(room.code, HOST_CLOSE_REASON, "host");
        } else {
          room.detachSocket(memberId, socket.id);
          room.removeMember(memberId, "You left the room.");
          room.broadcast();
        }
      }
      if (typeof ack === "function") ack({ ok: true });
    });

    socket.on("closeRoom", (ack) => {
      try {
        const { code, memberId } = socket.data;
        const room = code ? rooms.get(code) : undefined;
        if (!room || !memberId) throw new GameError("NOT_IN_ROOM");
        room.requireHost(memberId);
        rooms.closeRoom(room.code, HOST_CLOSE_REASON, "host");
        ack({ ok: true });
      } catch (err) {
        fail(ack as AckFn, err);
      }
    });

    // ----------------------------------------------------- runners (host, co-host)
    onRunner<Partial<RoomSettings>>("updateSettings", (room, patch) => room.updateSettings(patch ?? {}));
    onRunner<{ team: number; name: string }>("setTeamName", (room, req) => room.setTeamName(Number(req?.team), req?.name));
    onRunner<{ memberId: string; team: number }>("movePlayer", (room, req) => room.movePlayer(String(req?.memberId ?? ""), Number(req?.team)));
    onRunner("startGame", (room) => room.startGame());
    onRunner("closeAnswers", (room) => room.closeAnswers());
    onRunner("extendTimer", (room) => room.extendTimer());
    onRunner("skipPrompt", (room) => room.skipPrompt());
    onRunner<{ text: string }>("setPrompt", (room, req) => room.setPrompt(req?.text));
    onRunner<{ ids: string[] }>("mergeGroups", (room, req) => room.mergeGroups(req?.ids));
    onRunner<{ answerId: string }>("splitAnswer", (room, req) => room.splitAnswer(req?.answerId));
    onRunner<{ groupId: string; label: string }>("renameGroup", (room, req) => room.renameGroup(req?.groupId, req?.label));
    onRunner<{ groupId: string; dropped: boolean }>("dropGroup", (room, req) => room.dropGroup(req?.groupId, Boolean(req?.dropped)));
    onRunner("mixSaved", (room) => ({ added: room.mixSaved() }));
    onRunner("goLive", (room) => room.goLive());
    onRunner<{ rank: number }>("revealSlot", (room, req) => room.revealSlot(req?.rank));
    onRunner<{ text: string }>("hostGuess", (room, req) => ({ result: room.hostGuess(req?.text) }));
    onRunner("addStrike", (room) => room.addStrike());
    onRunner("endRound", (room) => room.endRound());
    onRunner("nextRound", (room) => room.nextRound());
    onRunner("endGame", (room) => room.endGame());
    onRunner("playAgain", (room) => room.playAgain());

    // ------------------------------------------------------------ host only
    on("cohostInvite", (room, id) => {
      room.requireHost(id);
      const inv = room.seats.invite();
      log.info("room", "co-host invite", { code: room.code, expiresAt: inv.expiresAt });
      return { path: cohostPath(room, inv.token), expiresAt: inv.expiresAt };
    });
    on<string>("removeCohost", (room, id, target) => {
      room.requireHost(id);
      if (!room.seats.isCohost(String(target))) throw new GameError("BAD_REQUEST");
      room.demoteCohost(String(target));
    });
    on<string>("kickPlayer", (room, id, target) => {
      room.requireHost(id);
      if (target === room.hostId || !room.members.has(target)) throw new GameError("BAD_REQUEST");
      room.removeMember(target, "The host removed you from the room.");
    });

    // --------------------------------------------------------------- players
    on<{ team: number }>("chooseTeam", (room, id, req) => room.chooseTeam(id, Number(req?.team)));
    on<{ text: string }>("submitAnswer", (room, id, req) => room.submitAnswer(id, req?.text));
    on<{ text: string }>("guess", (room, id, req) => ({ result: room.guess(id, req?.text) }));

    socket.on("disconnect", () => unbind());
  });
}
