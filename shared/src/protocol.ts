// The wire protocol between the Crowd Says server and its clients (phones, host, TV).

export const DEFAULT_GAME_NAME = "Crowd Says";

export type Role = "host" | "cohost" | "player" | "table";

/**
 * lobby → answer (phones type answers) → group (the host checks the groups) → guess (the
 * board is live, teams guess) → roundEnd → answer (next round) … → gameOver.
 */
export type Phase = "lobby" | "answer" | "group" | "guess" | "roundEnd" | "gameOver";

export interface RoomSettings {
  /** 2-4 teams. */
  teamCount: number;
  /** Seconds phones get to answer. */
  answerSeconds: number;
  /** Most groups on the board. */
  boardSize: number;
  /** Wrong guesses before the other team gets a steal. */
  strikes: number;
  /** Rounds in a game. */
  rounds: number;
  /** Turns away rude answers, guesses and team names. On by default. */
  profanityFilter: boolean;
  /** The prompt pack ("sample", or a venue pack's id). */
  packId: string;
}

export const DEFAULT_SETTINGS: RoomSettings = {
  teamCount: 2,
  answerSeconds: 45,
  boardSize: 8,
  strikes: 3,
  rounds: 5,
  profanityFilter: true,
  packId: "sample",
};

export const SETTINGS_LIMITS = {
  teamCount: { min: 2, max: 4 },
  answerSeconds: { min: 15, max: 180 },
  boardSize: { min: 3, max: 10 },
  strikes: { min: 1, max: 5 },
  rounds: { min: 1, max: 20 },
} as const;

/** Under this many answers, the host may mix in answers saved from earlier games. */
export const SMALL_ROOM_ANSWERS = 8;
/** At most this many saved answers are mixed into one round. */
export const MIX_LIMIT = 30;
export const MAX_ANSWER_LENGTH = 40;
export const MAX_NAME_LENGTH = 24;
export const MAX_TEAM_NAME_LENGTH = 20;
export const MAX_PROMPT_LENGTH = 120;
/** Seconds a room with nobody running it waits on the round's results before moving on. */
export const HOSTLESS_ADVANCE_SECONDS = 20;

/** Team colours carry meaning (whose turn, whose score), so they never take the venue's colours. */
export const TEAM_COLORS = ["#ef476f", "#3a86ff", "#06d6a0", "#ffbe0b"] as const;
export const DEFAULT_TEAM_NAMES = ["Red Team", "Blue Team", "Green Team", "Gold Team"] as const;

export interface MemberBrief {
  id: string;
  name: string;
  connected: boolean;
}

export interface TeamView {
  index: number;
  name: string;
  color: string;
  score: number;
  players: MemberBrief[];
}

/** One answer inside a group (runners only). */
/** One way of writing an answer inside a group (runners only): "sunblock ×2". */
export interface AnswerView {
  /** Any one answer of this variant (splitAnswer takes it). */
  id: string;
  text: string;
  count: number;
  /** All of them mixed in from earlier games at this venue. */
  saved: boolean;
}

/** An answer group, as the host sees it before (and while) the board is live. */
export interface GroupView {
  id: string;
  label: string;
  count: number;
  answers: AnswerView[];
  /** Left off the board by the host. */
  dropped: boolean;
}

/** One slot on the board. Players and TVs only see a label once it's revealed. */
export interface SlotView {
  rank: number;
  revealed: boolean;
  label: string | null;
  count: number | null;
  /** Team that revealed it; null when it was only shown at the end of the round. */
  by: number | null;
}

export type GuessResult = "hit" | "miss" | "repeat";

export interface GuessLogEntry {
  id: number;
  team: number;
  text: string;
  result: GuessResult;
  /** Board rank, for hits and repeats. */
  rank?: number;
  steal: boolean;
}

export interface TurnView {
  /** The team whose round it is. */
  team: number;
  /** The team guessing right now (the other team during a steal). */
  guessing: number;
  stealing: boolean;
  strikes: number;
  bank: number;
}

export interface PackSummary {
  id: string;
  name: string;
  prompts: number;
  builtIn: boolean;
}

export interface RoomView {
  code: string;
  title: string | null;
  you: { id: string; role: Role; name: string; team: number | null; canRun: boolean };
  cohosts: MemberBrief[];
  phase: Phase;
  round: number;
  settings: RoomSettings;
  packs: PackSummary[];
  prompt: string | null;
  /** Answer phase: when answers close (server ms). */
  deadline: number | null;
  /** Hostless rooms: when the round's results move on by themselves (server ms). */
  advanceAt: number | null;
  serverTime: number;
  playerCount: number;
  answeredCount: number;
  myAnswer: string | null;
  teams: TeamView[];
  /** Runners: the groups (group phase on). */
  groups: GroupView[] | null;
  /** Runners, group phase: answers saved from earlier games at this venue for this prompt. */
  savedAvailable: number;
  /** Answers this round (saved ones mixed in included). */
  answerCount: number;
  liveAnswerCount: number;
  mixedIn: boolean;
  board: SlotView[];
  turn: TurnView | null;
  log: GuessLogEntry[];
  /** roundEnd: the team that banked the round's points (null: nobody). */
  roundWinner: number | null;
  roundPoints: number;
  /** gameOver: the team(s) with the top score. */
  winners: number[];
  hostConnected: boolean;
}

export interface JoinResult {
  code: string;
  token: string;
  memberId: string;
  role: Role;
  name: string;
}

type Ack<T = object> = (res: ({ ok: true } & T) | { ok: false; error: string }) => void;

export interface ClientToServerEvents {
  createRoom: (req: { name?: string }, ack: Ack<JoinResult>) => void;
  roomInfo: (req: { code: string }, ack: Ack<{ teams: { index: number; name: string; color: string; players: number }[] }>) => void;
  joinRoom: (
    req: { code: string; role: "player" | "table"; name?: string; token?: string; team?: number; cohost?: string },
    ack: Ack<JoinResult>,
  ) => void;
  resume: (req: { code: string; token: string }, ack: Ack<JoinResult>) => void;
  leaveRoom: (ack: Ack) => void;
  closeRoom: (ack: Ack) => void;
  // runners (host / co-host)
  updateSettings: (patch: Partial<RoomSettings>, ack: Ack) => void;
  setTeamName: (req: { team: number; name: string }, ack: Ack) => void;
  movePlayer: (req: { memberId: string; team: number }, ack: Ack) => void;
  startGame: (ack: Ack) => void;
  closeAnswers: (ack: Ack) => void;
  extendTimer: (ack: Ack) => void;
  skipPrompt: (ack: Ack) => void;
  setPrompt: (req: { text: string }, ack: Ack) => void;
  mergeGroups: (req: { ids: string[] }, ack: Ack) => void;
  splitAnswer: (req: { answerId: string }, ack: Ack) => void;
  renameGroup: (req: { groupId: string; label: string }, ack: Ack) => void;
  dropGroup: (req: { groupId: string; dropped: boolean }, ack: Ack) => void;
  mixSaved: (ack: Ack<{ added: number }>) => void;
  goLive: (ack: Ack) => void;
  revealSlot: (req: { rank: number }, ack: Ack) => void;
  hostGuess: (req: { text: string }, ack: Ack<{ result: GuessResult }>) => void;
  addStrike: (ack: Ack) => void;
  endRound: (ack: Ack) => void;
  nextRound: (ack: Ack) => void;
  endGame: (ack: Ack) => void;
  playAgain: (ack: Ack) => void;
  // host only
  kickPlayer: (memberId: string, ack: Ack) => void;
  cohostInvite: (ack: Ack<{ path: string; expiresAt: string }>) => void;
  removeCohost: (memberId: string, ack: Ack) => void;
  // players
  chooseTeam: (req: { team: number }, ack: Ack) => void;
  submitAnswer: (req: { text: string }, ack: Ack) => void;
  guess: (req: { text: string }, ack: Ack<{ result: GuessResult }>) => void;
}

export interface ServerToClientEvents {
  state: (view: RoomView) => void;
  closed: (p: { reason: string }) => void;
  notice: (p: { message: string }) => void;
}

export const ERRORS = {
  NOT_IN_ROOM: "You're not in this room any more. Join again with the room code.",
  ROOM_NOT_FOUND: "There's no room with that code.",
  ROOM_FULL: "That room is full.",
  NAME_REQUIRED: "Type your name first.",
  NAME_TAKEN: "Someone in this room already has that name.",
  BAD_TOKEN: "That seat is gone. Join again with the room code.",
  BAD_INVITE: "That co-host link was already used or has expired. Ask the host for a new one.",
  BAD_REQUEST: "That didn't work. Please try again.",
  NOT_HOST: "Only the host can do that.",
  NOT_PLAYER: "Only players can do that.",
  WRONG_PHASE: "That can't be done right now.",
  RATE_LIMITED: "Slow down a little, then try again.",
  NOT_CLEAN: "Keep it clean: try something else.",
  NOT_YOUR_TURN: "It's not your team's turn to guess.",
  EMPTY: "Type something first.",
  NO_PLAYERS: "Wait for at least one player to join.",
  NO_GROUPS: "There are no answers to put on the board. Mix in saved answers, or skip to the next round.",
  NOT_SMALL: `Saved answers are for small rooms (fewer than ${SMALL_ROOM_ANSWERS} answers).`,
  NONE_SAVED: "There are no saved answers for this prompt yet.",
  ALREADY_MIXED: "Saved answers are already mixed in.",
  GAME_OVER: "This game is over. Start a new one.",
} as const;

export interface AdminSettings {
  roomIdleMinutes: number;
}

export const ADMIN_SETTINGS_LIMITS = {
  roomIdleMinutes: { min: 5, max: 24 * 60 },
} as const;
