import {
  DEFAULT_SETTINGS,
  DEFAULT_TEAM_NAMES,
  MAX_ANSWER_LENGTH,
  MAX_NAME_LENGTH,
  MAX_TEAM_NAME_LENGTH,
  MIX_LIMIT,
  SETTINGS_LIMITS,
  SMALL_ROOM_ANSWERS,
  TEAM_COLORS,
  answerKey,
  cleanPrompt,
  displayAnswer,
  isProfane,
  keptApart,
  keyFromRaw,
  keysMatch,
  rawKey,
  type AnswerView,
  type GroupView,
  type GuessLogEntry,
  type GuessResult,
  type KeyMap,
  type Phase,
  type Role,
  type RoomSettings,
  type RoomView,
  type SlotView,
  type TeamView,
} from "@crowdsays/shared";
import {
  HostSeats,
  cryptoRand,
  log,
  newId,
  newToken,
  type CloseCause,
  type KitRoom,
  type RoomOverview,
  type SessionKind,
} from "@bargames/gamekit/server";
import { bg } from "../bargames.js";
import { HOSTLESS_ADVANCE_MS, MAX_PLAYERS_PER_ROOM, MAX_TABLES_PER_ROOM } from "../config.js";
import { hasPack, packList, packPrompts } from "../content/packs.js";
import { saveAnswers, saveMerges, savedFor } from "../content/saved.js";
import { GameError } from "./errors.js";

export interface Member {
  id: string;
  token: string;
  role: Role;
  name: string;
  /** Players: their team. Everyone else: null. */
  team: number | null;
  socketIds: Set<string>;
  lastGuessAt: number;
}

interface Answer {
  id: string;
  /** The player who gave it; null for an answer mixed in from an earlier game. */
  memberId: string | null;
  text: string;
  /** rawKey(text): what the host splits by. */
  raw: string;
  /** answerKey(text, the venue's merges): what groups by. */
  key: string;
  saved: boolean;
  at: number;
}

interface Group {
  id: string;
  answers: Answer[];
  /** The host's own label. */
  label?: string;
  dropped: boolean;
}

interface Slot {
  groupId: string;
  label: string;
  count: number;
  keys: Set<string>;
  raws: Set<string>;
  revealed: boolean;
  by: number | null;
}

interface Turn {
  team: number;
  guessing: number;
  stealing: boolean;
  strikes: number;
  bank: number;
}

interface Team {
  name: string;
  score: number;
}

/** How the room talks to sockets - injected so Room has no socket.io dependency. */
export interface RoomTransport {
  sendState(socketId: string, view: RoomView): void;
  sendClosed(socketId: string, reason: string): void;
  /** A one-off message for one phone (a take-over, or a co-host made a player again). */
  sendNotice(socketId: string, message: string): void;
}

/** The links the host key and co-host invites go in (the box's host_link / cohost_link too). */
export const hostPath = (room: { code: string }, token: string) => `/join/${room.code}?host=${encodeURIComponent(token)}`;
export const cohostPath = (room: { code: string }, token: string) => `/join/${room.code}?cohost=${encodeURIComponent(token)}`;

export const TAKEOVER_NOTICE = "Staff took over hosting. You're a co-host now: you can still run the game.";
export const COHOST_REMOVED_NOTICE = "You're not a co-host any more.";

/** Seconds the host's "+15 s" adds. */
const EXTEND_SECONDS = 15;
/** A phone's guesses are at least this far apart. */
const GUESS_COOLDOWN_MS = 1500;
const LOG_KEPT = 12;

const clampInt = (v: unknown, lim: { min: number; max: number }): number => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < lim.min || n > lim.max) throw new GameError("BAD_REQUEST");
  return n;
};

export class Room implements KitRoom {
  readonly members = new Map<string, Member>();
  hostId = "";
  phase: Phase = "lobby";
  round = 0;
  settings: RoomSettings = { ...DEFAULT_SETTINGS };
  teams: Team[] = DEFAULT_TEAM_NAMES.slice(0, DEFAULT_SETTINGS.teamCount).map((name) => ({ name, score: 0 }));
  prompt: string | null = null;
  private usedPrompts = new Set<string>();
  /** This round's answers from phones, by member. */
  private live = new Map<string, Answer>();
  private groups: Group[] = [];
  /** The venue's saved merges for this round's prompt. */
  private merges: KeyMap = {};
  /** Keys the host split out this round (saved as "keep apart"). */
  private splitRaws = new Set<string>();
  mixedIn = false;
  private board: Slot[] = [];
  turn: Turn | null = null;
  private log: GuessLogEntry[] = [];
  private guessSeq = 0;
  roundWinner: number | null = null;
  roundPoints = 0;
  winners: number[] = [];
  deadline: number | null = null;
  advanceAt: number | null = null;
  private answerTimer: NodeJS.Timeout | null = null;
  private advanceTimer: NodeJS.Timeout | null = null;
  lastActivityAt = Date.now();
  readonly createdAt = Date.now();
  closed = false;
  /** Bar Games session kind: "patron" for rooms a phone creates, "venue" for the box's create_room. */
  kind: SessionKind;
  /** Optional title from the box's create_room. */
  title?: string;
  /**
   * Who may host (the game kit's HostSeats): the host link's key, the box's "first joiner
   * hosts" offer (closed on ANY attach to the host seat), take-overs and single-use co-host
   * invites. A venue room replaces it at creation (createVenueRoom).
   */
  seats = new HostSeats();

  /** Set by the room registry: closes just this room if one of its timers throws. */
  onFatalError: (err: unknown) => void = () => {};
  /** Set by the room registry: a debounced Bar Games players_changed (joins, leaves, kicks). */
  onPlayersChanged: () => void = () => {};

  constructor(
    readonly code: string,
    private readonly transport: RoomTransport,
    kind: SessionKind = "patron",
  ) {
    this.kind = kind;
  }

  // ------------------------------------------------------------- members

  addHost(name: string): Member {
    const m = this.newMember("host", name || "Host", null);
    this.hostId = m.id;
    return m;
  }

  /** The first phone to join a "first joiner hosts" room becomes its host, under the name it typed. */
  claimHostSeat(rawName: string | undefined): Member {
    const host = this.members.get(this.hostId);
    if (!host || this.seats.claimForJoiner() !== "host") throw new GameError("BAD_REQUEST");
    host.name = this.cleanName(rawName) || "Host";
    return host;
  }

  /** The seat a token opens: a member's own token, or the host link's key (the host seat). */
  seatFor(token: unknown): Member | undefined {
    if (typeof token !== "string" || !token) return undefined;
    return this.findByToken(token) ?? (this.seats.isHostToken(token) ? this.members.get(this.hostId) : undefined);
  }

  /** Anyone attached to a seat. For the host seat this closes the first-joiner offer. */
  noteAttached(member: Member): void {
    if (member.role === "host") this.seats.hostAttached(member.id);
  }

  cohosts(): Member[] {
    return [...this.members.values()].filter((m) => m.role === "cohost");
  }

  /** A co-host invite was redeemed: a new co-host, or a player already here promoted. */
  seatCohost(existing: Member | undefined, rawName: string | undefined): Member {
    if (existing && existing.role !== "player") return existing;
    let m = existing;
    if (m) {
      m.role = "cohost";
      m.team = null;
      this.live.delete(m.id);
      this.playersChanged();
    } else {
      const name = this.cleanName(rawName);
      if (!name) throw new GameError("NAME_REQUIRED");
      if (this.nameTaken(name)) throw new GameError("NAME_TAKEN");
      if (this.cohosts().length >= MAX_PLAYERS_PER_ROOM) throw new GameError("ROOM_FULL");
      m = this.newMember("cohost", name, null);
    }
    this.seats.addCohost(m.id);
    return m;
  }

  /** Staff took over (the box's host_link): the previous host's phone stays on as a co-host. */
  takeOver(previous: string | undefined): void {
    const old = previous ? this.members.get(previous) : undefined;
    if (!old || old.role !== "host") return;
    old.role = "cohost";
    this.hostId = this.newMember("host", "Venue", null).id;
    this.notify(old, TAKEOVER_NOTICE);
  }

  /** A co-host is a player again, on the smallest team. */
  demoteCohost(memberId: string): void {
    const m = this.members.get(memberId);
    this.seats.removeCohost(memberId);
    if (!m || m.role !== "cohost") return;
    m.role = "player";
    m.team = this.smallestTeam();
    this.playersChanged();
    this.notify(m, COHOST_REMOVED_NOTICE);
  }

  private cleanName(raw: unknown): string {
    return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH) : "";
  }

  private nameTaken(name: string, except?: string): boolean {
    const n = name.toLowerCase();
    return [...this.members.values()].some(
      (m) => m.id !== except && (m.role === "player" || m.role === "cohost") && m.name.toLowerCase() === n,
    );
  }

  private notify(m: Member, message: string): void {
    for (const sid of m.socketIds) this.transport.sendNotice(sid, message);
  }

  /** A new player (on the team they picked, or the smallest), or a TV. */
  addMember(role: "player" | "table", rawName: string | undefined, team?: number): Member {
    if (role === "table") {
      const tables = [...this.members.values()].filter((m) => m.role === "table").length;
      if (tables >= MAX_TABLES_PER_ROOM) throw new GameError("ROOM_FULL");
      return this.newMember("table", "TV", null);
    }
    const name = this.cleanName(rawName);
    if (!name) throw new GameError("NAME_REQUIRED");
    if (this.settings.profanityFilter && isProfane(name)) throw new GameError("NOT_CLEAN");
    if (this.players().length >= MAX_PLAYERS_PER_ROOM) throw new GameError("ROOM_FULL");
    if (this.nameTaken(name)) throw new GameError("NAME_TAKEN");
    const t = Number.isInteger(team) && team! >= 0 && team! < this.teams.length ? team! : this.smallestTeam();
    const m = this.newMember("player", name, t);
    this.playersChanged();
    return m;
  }

  private newMember(role: Role, name: string, team: number | null): Member {
    const m: Member = { id: newId(), token: newToken(), role, name, team, socketIds: new Set(), lastGuessAt: 0 };
    this.members.set(m.id, m);
    return m;
  }

  findByToken(token: string): Member | undefined {
    for (const m of this.members.values()) if (m.token === token) return m;
    return undefined;
  }

  attachSocket(member: Member, socketId: string): void {
    member.socketIds.add(socketId);
  }

  detachSocket(memberId: string, socketId: string): void {
    this.members.get(memberId)?.socketIds.delete(socketId);
  }

  removeMember(memberId: string, reason: string): void {
    const m = this.members.get(memberId);
    if (!m) return;
    for (const sid of m.socketIds) this.transport.sendClosed(sid, reason);
    this.members.delete(memberId);
    this.seats.removeCohost(memberId);
    if (m.role === "player") {
      // Their answer stays if the answers are already in; mid-answer it goes with them.
      if (this.phase === "answer") this.live.delete(memberId);
      this.playersChanged();
    }
  }

  players(): Member[] {
    return [...this.members.values()].filter((m) => m.role === "player");
  }

  private smallestTeam(): number {
    const sizes = this.teams.map(() => 0);
    for (const p of this.players()) if (p.team !== null && p.team < sizes.length) sizes[p.team]++;
    let best = 0;
    for (let i = 1; i < sizes.length; i++) if (sizes[i] < sizes[best]) best = i;
    return best;
  }

  /** A host or co-host has a phone connected. Without one the room runs itself. */
  runnerConnected(): boolean {
    for (const m of this.members.values()) if (m.socketIds.size > 0 && this.seats.canRun(m.id)) return true;
    return false;
  }

  // ---------------------------------------------------------- permissions

  /** Host or co-host. */
  requireRunner(memberId: string): void {
    if (!this.seats.canRun(memberId)) throw new GameError("NOT_HOST");
  }

  /** The host only: closing the room, removing people, co-host invites. */
  requireHost(memberId: string): void {
    if (this.seats.roleOf(memberId) !== "host") throw new GameError("NOT_HOST");
  }

  requirePlayer(memberId: string): Member {
    const m = this.members.get(memberId);
    if (!m || m.role !== "player") throw new GameError("NOT_PLAYER");
    return m;
  }

  // --------------------------------------------------- the kit's KitRoom

  playerCount(): number {
    return this.players().length;
  }

  tableCount(): number {
    let n = 0;
    for (const m of this.members.values()) if (m.role === "table" && m.socketIds.size > 0) n++;
    return n;
  }

  hostConnected(): boolean {
    return (this.members.get(this.hostId)?.socketIds.size ?? 0) > 0;
  }

  hostName(): string | undefined {
    return this.members.get(this.hostId)?.name;
  }

  maxPlayers(): number {
    return MAX_PLAYERS_PER_ROOM;
  }

  overviewExtra(): Partial<RoomOverview> {
    const where = this.round ? `Round ${this.round}` : "Lobby";
    return { title: `${this.title ? `${this.title} · ` : ""}${where}${this.prompt && this.phase !== "lobby" ? `: ${this.prompt}` : ""}` };
  }

  private playersChanged(): void {
    if (!this.closed) this.onPlayersChanged();
  }

  private emit(type: "round_started" | "round_ended" | "winner" | "game_over", data: Record<string, unknown>): void {
    bg.emit({ type, roomCode: this.code, sessionKind: this.kind, data });
  }

  // ------------------------------------------------------------ settings

  updateSettings(patch: Partial<RoomSettings>): void {
    const next = { ...this.settings };
    const between = this.phase === "lobby" || this.phase === "gameOver";
    if (patch.teamCount !== undefined) {
      next.teamCount = clampInt(patch.teamCount, SETTINGS_LIMITS.teamCount);
      if (next.teamCount !== this.settings.teamCount && !between) throw new GameError("WRONG_PHASE");
    }
    if (patch.answerSeconds !== undefined) next.answerSeconds = clampInt(patch.answerSeconds, SETTINGS_LIMITS.answerSeconds);
    if (patch.boardSize !== undefined) next.boardSize = clampInt(patch.boardSize, SETTINGS_LIMITS.boardSize);
    if (patch.strikes !== undefined) next.strikes = clampInt(patch.strikes, SETTINGS_LIMITS.strikes);
    if (patch.rounds !== undefined) {
      next.rounds = clampInt(patch.rounds, SETTINGS_LIMITS.rounds);
      if (next.rounds < this.round) throw new GameError("BAD_REQUEST");
    }
    if (patch.profanityFilter !== undefined) next.profanityFilter = Boolean(patch.profanityFilter);
    if (patch.packId !== undefined) {
      if (typeof patch.packId !== "string" || !hasPack(patch.packId)) throw new GameError("BAD_REQUEST");
      next.packId = patch.packId;
    }
    if (next.teamCount !== this.teams.length) this.resizeTeams(next.teamCount);
    this.settings = next;
  }

  private resizeTeams(count: number): void {
    while (this.teams.length < count) this.teams.push({ name: DEFAULT_TEAM_NAMES[this.teams.length], score: 0 });
    this.teams = this.teams.slice(0, count);
    // Players on a team that's gone are spread over the rest.
    for (const p of this.players()) if (p.team === null || p.team >= count) p.team = this.smallestTeam();
  }

  setTeamName(team: number, raw: unknown): void {
    if (!Number.isInteger(team) || team < 0 || team >= this.teams.length) throw new GameError("BAD_REQUEST");
    const name = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, MAX_TEAM_NAME_LENGTH) : "";
    if (!name) throw new GameError("EMPTY");
    if (this.settings.profanityFilter && isProfane(name)) throw new GameError("NOT_CLEAN");
    this.teams[team].name = name;
  }

  /** A player picks their team (between games only). */
  chooseTeam(memberId: string, team: number): void {
    const m = this.requirePlayer(memberId);
    if (this.phase !== "lobby" && this.phase !== "gameOver") throw new GameError("WRONG_PHASE");
    if (!Number.isInteger(team) || team < 0 || team >= this.teams.length) throw new GameError("BAD_REQUEST");
    m.team = team;
  }

  /** The host moves a player to another team (any time). */
  movePlayer(memberId: string, team: number): void {
    const m = this.members.get(memberId);
    if (!m || m.role !== "player") throw new GameError("BAD_REQUEST");
    if (!Number.isInteger(team) || team < 0 || team >= this.teams.length) throw new GameError("BAD_REQUEST");
    m.team = team;
  }

  // --------------------------------------------------------------- rounds

  /** From the lobby (or a finished game): scores to zero, round 1. */
  startGame(): void {
    if (this.phase !== "lobby" && this.phase !== "gameOver") throw new GameError("WRONG_PHASE");
    if (this.players().length === 0) throw new GameError("NO_PLAYERS");
    for (const t of this.teams) t.score = 0;
    this.round = 0;
    this.winners = [];
    log.info("game", "started", { code: this.code, players: this.players().length, teams: this.teams.length });
    this.beginRound();
  }

  private pickPrompt(): string {
    const all = packPrompts(this.settings.packId);
    let fresh = all.filter((p) => !this.usedPrompts.has(p) && p !== this.prompt);
    if (!fresh.length) {
      // Every prompt in the pack has been played: start over (but not with the same one).
      this.usedPrompts.clear();
      fresh = all.filter((p) => p !== this.prompt);
      if (!fresh.length) fresh = all;
    }
    const p = fresh[cryptoRand(fresh.length)];
    this.usedPrompts.add(p);
    return p;
  }

  private beginRound(prompt?: string): void {
    this.round += 1;
    this.prompt = prompt ?? this.pickPrompt();
    this.openAnswers();
    log.info("game", "round started", { code: this.code, round: this.round });
    this.emit("round_started", { round: this.round, prompt: this.prompt });
  }

  /** Fresh answer phase for the current prompt. */
  private openAnswers(): void {
    this.clearTimers();
    this.phase = "answer";
    this.live.clear();
    this.groups = [];
    this.board = [];
    this.turn = null;
    this.log = [];
    this.mixedIn = false;
    this.splitRaws.clear();
    this.roundWinner = null;
    this.roundPoints = 0;
    this.deadline = Date.now() + this.settings.answerSeconds * 1000;
    this.scheduleAnswerClose();
  }

  private scheduleAnswerClose(): void {
    if (this.answerTimer) clearTimeout(this.answerTimer);
    const ms = Math.max(0, (this.deadline ?? Date.now()) - Date.now());
    this.answerTimer = this.safeTimeout("answers", ms, () => {
      this.answerTimer = null;
      if (this.phase === "answer") {
        this.closeAnswers();
        this.broadcast();
      }
    });
  }

  /** A player's answer (they may change it until answers close). */
  submitAnswer(memberId: string, raw: unknown): void {
    const m = this.requirePlayer(memberId);
    if (this.phase !== "answer") throw new GameError("WRONG_PHASE");
    const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, MAX_ANSWER_LENGTH) : "";
    if (!text || !rawKey(text)) throw new GameError("EMPTY");
    if (this.settings.profanityFilter && isProfane(text)) throw new GameError("NOT_CLEAN");
    this.live.set(m.id, { id: newId(), memberId: m.id, text, raw: "", key: "", saved: false, at: Date.now() });
    // Everyone who's here has answered: no need to wait out the clock.
    const here = this.players().filter((p) => p.socketIds.size > 0);
    if (here.length > 0 && here.every((p) => this.live.has(p.id))) this.closeAnswers();
  }

  extendTimer(): void {
    if (this.phase !== "answer" || this.deadline === null) throw new GameError("WRONG_PHASE");
    this.deadline += EXTEND_SECONDS * 1000;
    this.scheduleAnswerClose();
  }

  /** Another prompt for this round (answers so far are dropped). */
  skipPrompt(): void {
    if (this.phase !== "answer") throw new GameError("WRONG_PHASE");
    this.prompt = this.pickPrompt();
    this.openAnswers();
  }

  /** The host's own prompt for this round. */
  setPrompt(raw: unknown): void {
    if (this.phase !== "answer") throw new GameError("WRONG_PHASE");
    const text = cleanPrompt(raw);
    if (!text) throw new GameError("EMPTY");
    if (this.settings.profanityFilter && isProfane(text)) throw new GameError("NOT_CLEAN");
    this.prompt = text;
    this.openAnswers();
  }

  /** Answers are in: save them for the venue and group them. Nobody running the room: straight to the board. */
  closeAnswers(): void {
    if (this.phase !== "answer" || !this.prompt) throw new GameError("WRONG_PHASE");
    if (this.answerTimer) clearTimeout(this.answerTimer);
    this.answerTimer = null;
    this.deadline = null;
    const answers = [...this.live.values()].sort((a, b) => a.at - b.at);
    saveAnswers(
      this.prompt,
      answers.map((a) => a.text),
    );
    this.merges = savedFor(this.prompt).merges;
    this.groups = [];
    for (const a of answers) this.place(a);
    this.phase = "group";
    log.info("game", "answers closed", { code: this.code, round: this.round, answers: answers.length, groups: this.groups.length });
    if (!this.runnerConnected()) this.autoLive();
  }

  /** A room nobody is running: mix in saved answers when it's small, then go live (or move on). */
  private autoLive(): void {
    if (this.liveCount() < SMALL_ROOM_ANSWERS && this.savedAvailable() > 0) this.mixSaved();
    if (this.boardGroups().length > 0) this.goLive();
    else this.finishRound(null);
  }

  /** Puts an answer into the group it matches, or a new group. */
  private place(a: Answer): void {
    a.raw = rawKey(a.text);
    a.key = keyFromRaw(a.raw, this.merges);
    const strict = keptApart(a.raw, this.merges);
    const exact = this.groups.find((g) => g.answers.some((b) => b.key === a.key));
    const fuzzy =
      exact ?? (strict ? undefined : this.groups.find((g) => g.answers.some((b) => !keptApart(b.raw, this.merges) && keysMatch(b.key, a.key))));
    if (fuzzy) fuzzy.answers.push(a);
    else this.groups.push({ id: newId(), answers: [a], dropped: false });
  }

  /** Answers from this round's phones (saved ones not counted). */
  private liveCount(): number {
    return this.live.size;
  }

  /** Saved answers for this prompt that could be mixed in. */
  savedAvailable(): number {
    if (!this.prompt || this.mixedIn) return 0;
    return this.savedPool().length;
  }

  private savedPool(): string[] {
    if (!this.prompt) return [];
    const pool = savedFor(this.prompt).answers;
    // This round's own answers were just saved: leave them out.
    const own = new Map<string, number>();
    for (const a of this.live.values()) own.set(a.text, (own.get(a.text) ?? 0) + 1);
    const rest: string[] = [];
    for (let i = pool.length - 1; i >= 0; i--) {
      const t = pool[i];
      const n = own.get(t) ?? 0;
      if (n > 0) own.set(t, n - 1);
      else rest.push(t);
    }
    return this.settings.profanityFilter ? rest.filter((t) => !isProfane(t)) : rest;
  }

  /** Small rooms: mixes in answers saved from earlier games at this venue (once a round). */
  mixSaved(): number {
    if (this.phase !== "group") throw new GameError("WRONG_PHASE");
    if (this.mixedIn) throw new GameError("ALREADY_MIXED");
    if (this.liveCount() >= SMALL_ROOM_ANSWERS) throw new GameError("NOT_SMALL");
    const pool = this.savedPool();
    if (!pool.length) throw new GameError("NONE_SAVED");
    // A random sample, so a busy venue's history doesn't swamp a tiny room.
    for (let i = pool.length - 1; i > 0; i--) {
      const j = cryptoRand(i + 1);
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const picked = pool.slice(0, MIX_LIMIT);
    const now = Date.now();
    picked.forEach((text, i) => this.place({ id: newId(), memberId: null, text, raw: "", key: "", saved: true, at: now + i }));
    this.mixedIn = true;
    log.info("game", "saved answers mixed in", { code: this.code, added: picked.length });
    return picked.length;
  }

  private group(id: unknown): Group {
    const g = this.groups.find((x) => x.id === id);
    if (!g) throw new GameError("BAD_REQUEST");
    return g;
  }

  /** The host's merge: the biggest group keeps its label and takes the others' answers. */
  mergeGroups(ids: unknown): void {
    if (this.phase !== "group") throw new GameError("WRONG_PHASE");
    if (!Array.isArray(ids)) throw new GameError("BAD_REQUEST");
    const picked = [...new Set(ids)].map((id) => this.group(id));
    if (picked.length < 2) throw new GameError("BAD_REQUEST");
    picked.sort((a, b) => b.answers.length - a.answers.length || this.groups.indexOf(a) - this.groups.indexOf(b));
    const [into, ...rest] = picked;
    for (const g of rest) {
      into.answers.push(...g.answers);
      for (const a of g.answers) this.splitRaws.delete(a.raw);
    }
    into.answers.sort((a, b) => a.at - b.at);
    into.dropped = into.dropped && rest.every((g) => g.dropped);
    this.groups = this.groups.filter((g) => !rest.includes(g));
  }

  /** The host's split: every answer written this way leaves its group for a new one. */
  splitAnswer(answerId: unknown): void {
    if (this.phase !== "group") throw new GameError("WRONG_PHASE");
    const from = this.groups.find((g) => g.answers.some((a) => a.id === answerId));
    if (!from) throw new GameError("BAD_REQUEST");
    const raw = from.answers.find((a) => a.id === answerId)!.raw;
    const moving = from.answers.filter((a) => a.raw === raw);
    if (moving.length === from.answers.length) throw new GameError("BAD_REQUEST");
    from.answers = from.answers.filter((a) => a.raw !== raw);
    this.groups.splice(this.groups.indexOf(from) + 1, 0, { id: newId(), answers: moving, dropped: false });
    this.splitRaws.add(raw);
  }

  renameGroup(groupId: unknown, raw: unknown): void {
    if (this.phase !== "group") throw new GameError("WRONG_PHASE");
    const g = this.group(groupId);
    const label = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, MAX_ANSWER_LENGTH) : "";
    if (!label) throw new GameError("EMPTY");
    if (this.settings.profanityFilter && isProfane(label)) throw new GameError("NOT_CLEAN");
    g.label = label;
  }

  /** Leaves a group off the board (a joke answer), or puts it back. */
  dropGroup(groupId: unknown, dropped: boolean): void {
    if (this.phase !== "group") throw new GameError("WRONG_PHASE");
    this.group(groupId).dropped = dropped;
  }

  private labelOf(g: Group): string {
    if (g.label) return g.label;
    const tally = new Map<string, { text: string; n: number }>();
    for (const a of g.answers) {
      const d = displayAnswer(a.text);
      const k = d.toLowerCase();
      const t = tally.get(k);
      if (t) t.n++;
      else tally.set(k, { text: d, n: 1 });
    }
    let best = { text: "", n: 0 };
    for (const t of tally.values()) if (t.n > best.n) best = t;
    return best.text;
  }

  /** The groups that would go on the board, most popular first. */
  private boardGroups(): Group[] {
    return this.groups
      .filter((g) => !g.dropped && g.answers.length > 0)
      .map((g, i) => ({ g, i }))
      .sort((a, b) => b.g.answers.length - a.g.answers.length || a.i - b.i)
      .slice(0, this.settings.boardSize)
      .map(({ g }) => g);
  }

  /** The board goes up. The host's grouping is saved for next time this prompt comes up. */
  goLive(): void {
    if (this.phase !== "group") throw new GameError("WRONG_PHASE");
    const top = this.boardGroups();
    if (!top.length) throw new GameError("NO_GROUPS");
    this.board = top.map((g) => ({
      groupId: g.id,
      label: this.labelOf(g),
      count: g.answers.length,
      keys: new Set(g.answers.map((a) => a.key)),
      raws: new Set(g.answers.map((a) => a.raw)),
      revealed: false,
      by: null,
    }));
    this.rememberGrouping();
    const team = (this.round - 1) % this.teams.length;
    this.turn = { team, guessing: team, stealing: false, strikes: 0, bank: 0 };
    this.phase = "guess";
    log.info("game", "board live", { code: this.code, round: this.round, slots: this.board.length });
  }

  /** key → the group's main key for every merged group; split-out keys kept apart. */
  private rememberGrouping(): void {
    if (!this.prompt) return;
    const changes: Record<string, string | null> = {};
    for (const g of this.groups) {
      const counts = new Map<string, number>();
      for (const a of g.answers) counts.set(a.raw, (counts.get(a.raw) ?? 0) + 1);
      const raws = [...counts.keys()];
      const main = raws.reduce((a, b) => ((counts.get(b) ?? 0) > (counts.get(a) ?? 0) ? b : a), raws[0]);
      for (const r of raws) {
        if (r === main) {
          if (this.splitRaws.has(r)) changes[r] = r;
          else if (this.merges[r] !== undefined && this.merges[r] !== r) changes[r] = null;
        } else if (keyFromRaw(r) !== keyFromRaw(main) || this.merges[r] !== undefined) {
          // Only what the built-in matching wouldn't do by itself.
          changes[r] = main;
        }
      }
    }
    saveMerges(this.prompt, changes);
  }

  // --------------------------------------------------------------- guessing

  /** The board slot a guess matches, if any. */
  private match(text: string): Slot | undefined {
    const raw = rawKey(text);
    const key = answerKey(text, this.merges);
    const exact = this.board.find((s) => s.keys.has(key) || s.raws.has(raw));
    if (exact) return exact;
    return this.board.find((s) => [...s.keys].some((k) => keysMatch(k, key)) || [...s.raws].some((r) => keysMatch(r, raw)));
  }

  /** A phone guess from the team whose turn it is. */
  guess(memberId: string, raw: unknown): GuessResult {
    const m = this.requirePlayer(memberId);
    if (this.phase !== "guess" || !this.turn) throw new GameError("WRONG_PHASE");
    if (m.team !== this.turn.guessing) throw new GameError("NOT_YOUR_TURN");
    const now = Date.now();
    if (now - m.lastGuessAt < GUESS_COOLDOWN_MS) throw new GameError("RATE_LIMITED");
    const result = this.resolveGuess(raw);
    m.lastGuessAt = now;
    return result;
  }

  /** The host types the guess a team called out. */
  hostGuess(raw: unknown): GuessResult {
    if (this.phase !== "guess" || !this.turn) throw new GameError("WRONG_PHASE");
    return this.resolveGuess(raw);
  }

  private resolveGuess(raw: unknown): GuessResult {
    const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, MAX_ANSWER_LENGTH) : "";
    if (!text || !rawKey(text)) throw new GameError("EMPTY");
    if (this.settings.profanityFilter && isProfane(text)) throw new GameError("NOT_CLEAN");
    const slot = this.match(text);
    if (slot?.revealed) {
      this.addLog(text, "repeat", slot);
      return "repeat";
    }
    if (slot) this.hit(slot, text);
    else this.miss(text);
    return slot ? "hit" : "miss";
  }

  /** The host reveals a slot the team called out (counts as a right guess). */
  revealSlot(rank: unknown): void {
    if (this.phase !== "guess" || !this.turn) throw new GameError("WRONG_PHASE");
    const slot = this.board[Number(rank) - 1];
    if (!slot || slot.revealed) throw new GameError("BAD_REQUEST");
    this.hit(slot, slot.label);
  }

  /** The host gives a strike for a wrong spoken guess. */
  addStrike(): void {
    if (this.phase !== "guess" || !this.turn) throw new GameError("WRONG_PHASE");
    this.miss("✕");
  }

  private addLog(text: string, result: GuessResult, slot?: Slot): void {
    const t = this.turn!;
    this.log.push({
      id: ++this.guessSeq,
      team: t.guessing,
      text,
      result,
      rank: slot ? this.board.indexOf(slot) + 1 : undefined,
      steal: t.stealing,
    });
    if (this.log.length > LOG_KEPT) this.log.splice(0, this.log.length - LOG_KEPT);
  }

  private hit(slot: Slot, text: string): void {
    const t = this.turn!;
    this.addLog(text, "hit", slot);
    slot.revealed = true;
    slot.by = t.guessing;
    t.bank += slot.count;
    if (t.stealing) this.finishRound(t.guessing);
    else if (this.board.every((s) => s.revealed)) this.finishRound(t.team);
  }

  private miss(text: string): void {
    const t = this.turn!;
    this.addLog(text, "miss");
    if (t.stealing) {
      // The steal failed: the team whose round it was keeps the bank.
      this.finishRound(t.team);
      return;
    }
    t.strikes += 1;
    if (t.strikes >= this.settings.strikes) {
      t.stealing = true;
      t.guessing = (t.team + 1) % this.teams.length;
    }
  }

  /** The host ends the round early: the team in control keeps what's in the bank. */
  endRound(): void {
    if (this.phase !== "guess" || !this.turn) throw new GameError("WRONG_PHASE");
    this.finishRound(this.turn.team);
  }

  /** Round over: the bank to the winner (null: nobody), the rest of the board shown. */
  private finishRound(winner: number | null): void {
    const points = this.turn?.bank ?? 0;
    if (winner !== null && this.teams[winner]) this.teams[winner].score += points;
    for (const s of this.board) if (!s.revealed) s.revealed = true;
    this.roundWinner = winner;
    this.roundPoints = winner === null ? 0 : points;
    this.phase = "roundEnd";
    this.deadline = null;
    log.info("game", "round ended", { code: this.code, round: this.round, winner, points: this.roundPoints });
    this.emit("round_ended", {
      round: this.round,
      prompt: this.prompt,
      winner: winner === null ? null : this.teams[winner]?.name,
      points: this.roundPoints,
      scores: this.scores(),
    });
    this.scheduleHostlessAdvance();
  }

  private scores(): { team: string; score: number }[] {
    return this.teams.map((t) => ({ team: t.name, score: t.score }));
  }

  /** A room nobody is running moves on from the results by itself. */
  private scheduleHostlessAdvance(): void {
    if (this.advanceTimer) clearTimeout(this.advanceTimer);
    this.advanceTimer = null;
    this.advanceAt = null;
    if (this.runnerConnected()) return;
    this.advanceAt = Date.now() + HOSTLESS_ADVANCE_MS;
    this.advanceTimer = this.safeTimeout("advance", HOSTLESS_ADVANCE_MS, () => {
      this.advanceTimer = null;
      this.advanceAt = null;
      if (this.phase === "roundEnd" && !this.runnerConnected()) {
        this.nextRound();
        this.broadcast();
      }
    });
  }

  get lastRound(): boolean {
    return this.round >= this.settings.rounds;
  }

  /**
   * On to the next round (the host's "Next round", the box's next_round). From the results
   * as usual; mid-round it drops this round (nobody scores) and deals the next prompt. After
   * the last round it's the final scores.
   */
  nextRound(): void {
    if (this.phase === "lobby") throw new GameError("WRONG_PHASE");
    if (this.phase === "gameOver") throw new GameError("GAME_OVER");
    if (this.phase !== "roundEnd") this.abandonRound();
    if (this.lastRound) this.finishGame();
    else this.beginRound();
  }

  /** Drops the round in progress without scoring it. */
  private abandonRound(): void {
    this.clearTimers();
    log.info("game", "round skipped", { code: this.code, round: this.round, phase: this.phase });
    this.emit("round_ended", { round: this.round, prompt: this.prompt, winner: null, points: 0, scores: this.scores(), skipped: true });
    this.phase = "roundEnd";
  }

  /** The host's "End game": final scores now. */
  endGame(): void {
    if (this.phase === "lobby" || this.phase === "gameOver") throw new GameError("WRONG_PHASE");
    if (this.phase !== "roundEnd") this.abandonRound();
    this.finishGame();
  }

  private finishGame(): void {
    this.clearTimers();
    this.phase = "gameOver";
    const top = Math.max(...this.teams.map((t) => t.score));
    this.winners = top > 0 ? this.teams.flatMap((t, i) => (t.score === top ? [i] : [])) : [];
    const names = this.winners.map((i) => this.teams[i].name);
    log.info("game", "game over", { code: this.code, rounds: this.round, winners: names.join(",") });
    if (names.length) this.emit("winner", { name: names.join(" & "), score: top, tie: names.length > 1 });
    this.emit("game_over", { winners: names, scores: this.scores(), rounds: this.round });
    // Leaderboards: teams are the "players". Ties share a place.
    const ranked = this.teams
      .map((t, i) => ({ t, i, players: this.players().filter((p) => p.team === i).length }))
      .filter((x) => x.players > 0 || x.t.score > 0)
      .sort((a, b) => b.t.score - a.t.score);
    if (ranked.length) {
      void bg.reportResults({
        roomCode: this.code,
        results: ranked.map(({ t }) => ({
          // SDK 0.16.0: the "player" is a team, so boards keep team seasons apart.
          player: { name: t.name, team: true },
          place: 1 + ranked.filter((o) => o.t.score > t.score).length,
          score: t.score,
        })),
      });
    }
  }

  /** From the final scores back to the lobby (same teams, scores to zero). */
  playAgain(): void {
    if (this.phase !== "gameOver") throw new GameError("WRONG_PHASE");
    this.phase = "lobby";
    this.round = 0;
    this.prompt = null;
    this.winners = [];
    this.board = [];
    this.groups = [];
    this.turn = null;
    this.log = [];
    for (const t of this.teams) t.score = 0;
  }

  // ---------------------------------------------------------------- timers

  private clearTimers(): void {
    if (this.answerTimer) clearTimeout(this.answerTimer);
    if (this.advanceTimer) clearTimeout(this.advanceTimer);
    this.answerTimer = null;
    this.advanceTimer = null;
    this.deadline = null;
    this.advanceAt = null;
  }

  /** Every room timer goes through here: a throw closes this room only. */
  private safeTimeout(label: string, ms: number, fn: () => void): NodeJS.Timeout {
    return setTimeout(() => {
      try {
        fn();
      } catch (err) {
        log.error("room", "timer threw", { code: this.code, timer: label, err: String(err) });
        this.onFatalError(err);
      }
    }, ms);
  }

  // ----------------------------------------------------------------- views

  broadcast(): void {
    this.lastActivityAt = Date.now();
    for (const m of this.members.values()) {
      if (m.socketIds.size === 0) continue;
      const view = this.viewFor(m);
      for (const sid of m.socketIds) this.transport.sendState(sid, view);
    }
  }

  private groupView(g: Group): GroupView {
    const variants = new Map<string, Answer[]>();
    for (const a of g.answers) variants.set(a.raw, [...(variants.get(a.raw) ?? []), a]);
    const answers: AnswerView[] = [...variants.values()]
      .map((list) => ({
        id: list[0].id,
        text: displayAnswer(list[0].text),
        count: list.length,
        saved: list.every((a) => a.saved),
      }))
      .sort((a, b) => b.count - a.count);
    return { id: g.id, label: this.labelOf(g), count: g.answers.length, answers, dropped: g.dropped };
  }

  viewFor(m: Member): RoomView {
    const runner = this.seats.canRun(m.id);
    const ended = this.phase === "roundEnd" || this.phase === "gameOver";
    const board: SlotView[] = this.board.map((s, i) => {
      const show = s.revealed || runner || ended;
      return { rank: i + 1, revealed: s.revealed, label: show ? s.label : null, count: show ? s.count : null, by: s.by };
    });
    const teams: TeamView[] = this.teams.map((t, i) => ({
      index: i,
      name: t.name,
      color: TEAM_COLORS[i],
      score: t.score,
      players: this.players()
        .filter((p) => p.team === i)
        .map((p) => ({ id: p.id, name: p.name, connected: p.socketIds.size > 0 })),
    }));
    const answerCount = this.phase === "answer" ? this.live.size : this.groups.reduce((n, g) => n + g.answers.length, 0);
    return {
      code: this.code,
      title: this.title ?? null,
      you: { id: m.id, role: m.role, name: m.name, team: m.team, canRun: runner },
      cohosts: this.cohosts().map((c) => ({ id: c.id, name: c.name, connected: c.socketIds.size > 0 })),
      phase: this.phase,
      round: this.round,
      settings: { ...this.settings },
      packs: runner ? packList() : [],
      prompt: this.phase === "lobby" ? null : this.prompt,
      deadline: this.deadline,
      advanceAt: this.advanceAt,
      serverTime: Date.now(),
      playerCount: this.players().length,
      answeredCount: this.live.size,
      myAnswer: this.live.get(m.id)?.text ?? null,
      teams,
      groups: runner && this.phase === "group" ? this.groups.map((g) => this.groupView(g)) : null,
      savedAvailable: runner && this.phase === "group" ? this.savedAvailable() : 0,
      answerCount,
      liveAnswerCount: this.phase === "answer" ? this.live.size : this.liveCount(),
      mixedIn: this.mixedIn,
      board,
      turn: this.turn ? { ...this.turn } : null,
      log: this.log.slice(),
      roundWinner: this.roundWinner,
      roundPoints: this.roundPoints,
      winners: this.winners.slice(),
      hostConnected: this.hostConnected(),
    };
  }

  close(reason: string, _cause?: CloseCause): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    for (const m of this.members.values()) for (const sid of m.socketIds) this.transport.sendClosed(sid, reason);
  }
}
