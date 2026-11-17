import { useEffect, useMemo, useState, type FormEvent } from "react";
import { basePath } from "@bargames/gamekit/client";
import { joinUrl as venueJoinUrl } from "@bargames/sdk/client";
import {
  MAX_ANSWER_LENGTH,
  MAX_PROMPT_LENGTH,
  SETTINGS_LIMITS,
  SMALL_ROOM_ANSWERS,
  type GroupView,
  type GuessResult,
  type RoomSettings,
  type RoomView,
} from "@crowdsays/shared";
import { Board, Countdown, GuessLog, QrCode, RoundResult, Scores, Strikes, TurnLine, Winners, joinUrl, teamStyle } from "../components/bits";
import { useVenue } from "../venue";
import type { Act } from "./RoomPage";

interface Props {
  view: RoomView;
  skew: number;
  act: Act;
  setToast: (s: string) => void;
}

export function HostView({ view, skew, act, setToast }: Props) {
  const isHost = view.you.role === "host";
  const playing = view.phase !== "lobby" && view.phase !== "gameOver";
  const endGame = () => {
    if (window.confirm("End this game now and show the final scores?")) act("endGame");
  };
  return (
    <main className="host">
      {view.phase === "lobby" && <LobbyControls view={view} act={act} />}
      {view.phase === "answer" && <AnswerControls view={view} skew={skew} act={act} />}
      {view.phase === "group" && <GroupControls view={view} act={act} />}
      {view.phase === "guess" && <GuessControls view={view} act={act} setToast={setToast} />}
      {view.phase === "roundEnd" && (
        <section className="panel">
          <RoundResult view={view} />
          <p className="prompt prompt-sm">{view.prompt}</p>
          <Board view={view} />
          <Scores view={view} />
          <button className="btn btn-primary btn-big" onClick={() => act("nextRound")}>
            {view.round >= view.settings.rounds ? "See the final scores" : `Next round (${view.round + 1} of ${view.settings.rounds})`}
          </button>
        </section>
      )}
      {view.phase === "gameOver" && (
        <section className="panel">
          <Winners view={view} />
          <Scores view={view} />
          <div className="row">
            <button className="btn btn-primary btn-big" onClick={() => act("startGame")}>
              New game, same teams
            </button>
            <button className="btn btn-ghost" onClick={() => act("playAgain")}>
              Back to the lobby
            </button>
          </div>
        </section>
      )}
      {playing && (
        <div className="row row-end">
          <button className="btn btn-ghost btn-small" onClick={endGame}>
            End game
          </button>
        </div>
      )}
      <JoinPanel view={view} />
      <TeamsPanel view={view} act={act} />
      {isHost && <CohostPanel view={view} act={act} />}
    </main>
  );
}

// ------------------------------------------------------------------- lobby

function NumberSetting({
  label,
  value,
  limits,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  limits: { min: number; max: number };
  onChange: (n: number) => void;
  disabled?: boolean;
}) {
  return (
    <label className="setting">
      <span>{label}</span>
      <select value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))}>
        {Array.from({ length: limits.max - limits.min + 1 }, (_, i) => limits.min + i).map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </label>
  );
}

const SECONDS = [15, 20, 30, 45, 60, 90, 120, 180];

function SettingsForm({ view, act }: { view: RoomView; act: Act }) {
  const s = view.settings;
  const set = (patch: Partial<RoomSettings>) => act("updateSettings", patch);
  const between = view.phase === "lobby" || view.phase === "gameOver";
  return (
    <div className="settings">
      <label className="setting setting-wide">
        <span>Prompts</span>
        <select value={s.packId} onChange={(e) => set({ packId: e.target.value })}>
          {view.packs.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.prompts})
            </option>
          ))}
        </select>
      </label>
      <NumberSetting label="Teams" value={s.teamCount} limits={SETTINGS_LIMITS.teamCount} disabled={!between} onChange={(n) => set({ teamCount: n })} />
      <NumberSetting label="Rounds" value={s.rounds} limits={{ min: Math.max(1, view.round), max: SETTINGS_LIMITS.rounds.max }} onChange={(n) => set({ rounds: n })} />
      <label className="setting">
        <span>Answer time</span>
        <select value={s.answerSeconds} onChange={(e) => set({ answerSeconds: Number(e.target.value) })}>
          {[...new Set([...SECONDS, s.answerSeconds])]
            .sort((a, b) => a - b)
            .map((n) => (
              <option key={n} value={n}>
                {n} s
              </option>
            ))}
        </select>
      </label>
      <NumberSetting label="Board size" value={s.boardSize} limits={SETTINGS_LIMITS.boardSize} onChange={(n) => set({ boardSize: n })} />
      <NumberSetting label="Strikes" value={s.strikes} limits={SETTINGS_LIMITS.strikes} onChange={(n) => set({ strikes: n })} />
      <label className="setting setting-check">
        <input type="checkbox" checked={s.profanityFilter} onChange={(e) => set({ profanityFilter: e.target.checked })} />
        <span>Profanity filter</span>
      </label>
    </div>
  );
}

function LobbyControls({ view, act }: { view: RoomView; act: Act }) {
  return (
    <section className="panel">
      <h2>Set up the game</h2>
      <SettingsForm view={view} act={act} />
      <button className="btn btn-primary btn-big" disabled={view.playerCount === 0} onClick={() => act("startGame")}>
        {view.playerCount === 0 ? "Waiting for players…" : `Start (${view.playerCount} player${view.playerCount === 1 ? "" : "s"})`}
      </button>
    </section>
  );
}

// ------------------------------------------------------------------ answers

function AnswerControls({ view, skew, act }: { view: RoomView; skew: number; act: Act }) {
  const [own, setOwn] = useState("");
  const [writing, setWriting] = useState(false);
  const setPrompt = async (e: FormEvent) => {
    e.preventDefault();
    if (await act("setPrompt", { text: own })) {
      setOwn("");
      setWriting(false);
    }
  };
  return (
    <section className="panel">
      <div className="answer-head">
        <span className="muted small">Round {view.round} · answers open</span>
        <Countdown at={view.deadline} skew={skew} />
      </div>
      <p className="prompt">{view.prompt}</p>
      <p className="progress">
        {view.answeredCount} of {view.playerCount} answered
      </p>
      <div className="row">
        <button className="btn btn-primary" onClick={() => act("closeAnswers")}>
          Close answers now
        </button>
        <button className="btn btn-ghost" onClick={() => act("extendTimer")}>
          +15 s
        </button>
        <button className="btn btn-ghost" onClick={() => act("skipPrompt")}>
          Different prompt
        </button>
        <button className="btn btn-ghost" onClick={() => setWriting((w) => !w)}>
          Write my own
        </button>
      </div>
      {writing && (
        <form className="row" onSubmit={setPrompt}>
          <input
            value={own}
            onChange={(e) => setOwn(e.target.value.slice(0, MAX_PROMPT_LENGTH))}
            maxLength={MAX_PROMPT_LENGTH}
            placeholder="Name something you…"
            autoFocus
          />
          <button className="btn btn-secondary" disabled={!own.trim()}>
            Use it
          </button>
        </form>
      )}
    </section>
  );
}

// ------------------------------------------------------------------- groups

function GroupControls({ view, act }: { view: RoomView; act: Act }) {
  const groups = view.groups ?? [];
  const [picked, setPicked] = useState<string[]>([]);
  // Forget picks of groups that are gone (merged).
  useEffect(() => setPicked((p) => p.filter((id) => groups.some((g) => g.id === id))), [groups]);
  const onBoard = useMemo(() => {
    const ranked = groups
      .map((g, i) => ({ g, i }))
      .filter(({ g }) => !g.dropped)
      .sort((a, b) => b.g.count - a.g.count || a.i - b.i)
      .slice(0, view.settings.boardSize);
    return new Map(ranked.map(({ g }, i) => [g.id, i + 1]));
  }, [groups, view.settings.boardSize]);
  const sorted = useMemo(
    () => groups.map((g, i) => ({ g, i })).sort((a, b) => b.g.count - a.g.count || a.i - b.i).map(({ g }) => g),
    [groups],
  );
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const merge = async () => {
    if (await act("mergeGroups", { ids: picked })) setPicked([]);
  };
  const small = view.liveAnswerCount < SMALL_ROOM_ANSWERS;
  return (
    <section className="panel">
      <h2>Check the answers</h2>
      <p className="prompt prompt-sm">{view.prompt}</p>
      <p className="muted small">
        {view.answerCount} answers in {groups.length} groups. Tick groups that mean the same thing and merge them; split out an
        answer that doesn't belong. The top {view.settings.boardSize} go on the board.
      </p>
      {small && view.savedAvailable > 0 && !view.mixedIn && (
        <div className="notice">
          <span>
            Only {view.liveAnswerCount} answer{view.liveAnswerCount === 1 ? "" : "s"}. Mix in {Math.min(view.savedAvailable, 30)} saved from earlier games
            here?
          </span>
          <button className="btn btn-secondary btn-small" onClick={() => act("mixSaved")}>
            Mix them in
          </button>
        </div>
      )}
      {view.mixedIn && <p className="muted small">Saved answers from earlier games are mixed in (marked “saved”).</p>}
      <div className="row sticky-actions">
        <button className="btn btn-ghost" disabled={picked.length < 2} onClick={merge}>
          Merge {picked.length >= 2 ? picked.length : ""} groups
        </button>
        <button className="btn btn-primary" disabled={onBoard.size === 0} onClick={() => act("goLive")}>
          Put the board up
        </button>
      </div>
      <ul className="groups">
        {sorted.map((g) => (
          <GroupRow key={g.id} g={g} rank={onBoard.get(g.id)} picked={picked.includes(g.id)} onPick={() => toggle(g.id)} act={act} />
        ))}
      </ul>
      {groups.length === 0 && (
        <div className="row">
          <p className="muted">No answers this time.</p>
          <button className="btn btn-ghost" onClick={() => act("nextRound")}>
            Skip to the next round
          </button>
        </div>
      )}
    </section>
  );
}

function GroupRow({ g, rank, picked, onPick, act }: { g: GroupView; rank?: number; picked: boolean; onPick: () => void; act: Act }) {
  const [label, setLabel] = useState(g.label);
  const [editing, setEditing] = useState(false);
  useEffect(() => setLabel(g.label), [g.label]);
  const rename = async (e: FormEvent) => {
    e.preventDefault();
    if (await act("renameGroup", { groupId: g.id, label })) setEditing(false);
  };
  return (
    <li className={`group ${picked ? "group-picked" : ""} ${g.dropped ? "group-dropped" : ""} ${rank ? "group-on" : ""}`}>
      <div className="group-head">
        <input type="checkbox" checked={picked} onChange={onPick} aria-label={`Pick ${g.label}`} />
        <span className="group-rank">{rank ? `#${rank}` : g.dropped ? "off" : "–"}</span>
        {editing ? (
          <form onSubmit={rename} className="group-rename">
            <input value={label} onChange={(e) => setLabel(e.target.value.slice(0, MAX_ANSWER_LENGTH))} maxLength={MAX_ANSWER_LENGTH} autoFocus />
            <button className="btn btn-small btn-secondary">Save</button>
          </form>
        ) : (
          <button className="group-label" onClick={() => setEditing(true)} title="Rename">
            {g.label}
          </button>
        )}
        <span className="group-count">{g.count}</span>
        <button className="btn btn-small btn-ghost" onClick={() => act("dropGroup", { groupId: g.id, dropped: !g.dropped })}>
          {g.dropped ? "Put back" : "Leave off"}
        </button>
      </div>
      {g.answers.length > 1 && (
        <ul className="variants">
          {g.answers.map((a) => (
            <li key={a.id}>
              <span>
                {a.text} <span className="muted">×{a.count}</span>
                {a.saved && <span className="tag">saved</span>}
              </span>
              <button className="link-btn" onClick={() => act("splitAnswer", { answerId: a.id })}>
                split out
              </button>
            </li>
          ))}
        </ul>
      )}
      {g.answers.length === 1 && g.answers[0].saved && <span className="tag">saved</span>}
    </li>
  );
}

// ------------------------------------------------------------------ guessing

const SAID: Record<GuessResult, string> = {
  hit: "On the board!",
  miss: "Not there: strike.",
  repeat: "Already on the board.",
};

function GuessControls({ view, act, setToast }: { view: RoomView; act: Act; setToast: (s: string) => void }) {
  const [text, setText] = useState("");
  const turn = view.turn!;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    const r = await act<{ result: GuessResult }>("hostGuess", { text: text.trim() });
    if (r) {
      setText("");
      setToast(SAID[r.result]);
    }
  };
  const reveal = (rank: number) => {
    const s = view.board[rank - 1];
    if (s && !s.revealed && window.confirm(`Reveal #${rank} “${s.label}” for ${view.teams[turn.guessing]?.name}?`)) act("revealSlot", { rank });
  };
  return (
    <section className="panel">
      <p className="prompt prompt-sm">{view.prompt}</p>
      <TurnLine view={view} />
      <Strikes n={turn.strikes} max={view.settings.strikes} />
      <form className="row" onSubmit={submit}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, MAX_ANSWER_LENGTH))}
          maxLength={MAX_ANSWER_LENGTH}
          placeholder={`Type ${view.teams[turn.guessing]?.name}'s guess`}
          autoComplete="off"
        />
        <button className="btn btn-primary" disabled={!text.trim()}>
          Check
        </button>
      </form>
      <p className="muted small">Phones on the guessing team can send guesses too. Tap a hidden answer to reveal it for them.</p>
      <div className="host-board">
        <Board view={view} />
        <div className="reveal-grid">
          {view.board.map((s) => (
            <button key={s.rank} className="btn btn-small btn-ghost" disabled={s.revealed} onClick={() => reveal(s.rank)}>
              Reveal #{s.rank}
            </button>
          ))}
        </div>
      </div>
      <div className="row">
        <button className="btn btn-danger" onClick={() => act("addStrike")}>
          ✕ {turn.stealing ? "Steal missed" : "Strike"}
        </button>
        <button className="btn btn-ghost" onClick={() => window.confirm("End the round now? The team in control keeps the bank.") && act("endRound")}>
          End round
        </button>
      </div>
      <GuessLog view={view} max={6} />
      <Scores view={view} compact />
    </section>
  );
}

// ------------------------------------------------------------- side panels

function JoinPanel({ view }: { view: RoomView }) {
  const venue = useVenue();
  const url = joinUrl(view.code, venue);
  const tvLink = `${location.origin}${basePath()}/join/${view.code}?as=table`;
  return (
    <details className="panel" open={view.phase === "lobby"}>
      <summary>Join and TV</summary>
      <div className="join-row">
        <QrCode text={url} size={140} />
        <div>
          <div className="join-code">{view.code}</div>
          <p className="small break">{url}</p>
          <a className="btn btn-ghost btn-small" href={tvLink} target="_blank" rel="noreferrer">
            Open the TV view
          </a>
          <p className="muted small">Open it on the computer or TV that shows the board.</p>
        </div>
      </div>
    </details>
  );
}

function TeamsPanel({ view, act }: { view: RoomView; act: Act }) {
  const isHost = view.you.role === "host";
  const [names, setNames] = useState(view.teams.map((t) => t.name));
  useEffect(() => setNames(view.teams.map((t) => t.name)), [view.teams]);
  const kick = (id: string, name: string) => {
    if (window.confirm(`Remove ${name} from the room?`)) act("kickPlayer", id);
  };
  return (
    <details className="panel" open={view.phase === "lobby"}>
      <summary>
        Teams and players ({view.playerCount})
      </summary>
      <div className="teams-edit">
        {view.teams.map((t, i) => (
          <div key={t.index} className="team-card" style={teamStyle(t)}>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                act("setTeamName", { team: t.index, name: names[i] });
              }}
            >
              <input
                className="team-name-input"
                maxLength={20}
                value={names[i] ?? ""}
                onChange={(e) => setNames((n) => n.map((x, j) => (j === i ? e.target.value.slice(0, 20) : x)))}
                onBlur={() => names[i] !== t.name && act("setTeamName", { team: t.index, name: names[i] })}
                aria-label="Team name"
              />
            </form>
            <ul>
              {t.players.map((p) => (
                <li key={p.id} className={p.connected ? "" : "muted"}>
                  <span>{p.name}</span>
                  <span className="player-actions">
                    <select value={t.index} onChange={(e) => act("movePlayer", { memberId: p.id, team: Number(e.target.value) })} aria-label={`Move ${p.name}`}>
                      {view.teams.map((o) => (
                        <option key={o.index} value={o.index}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                    {isHost && (
                      <button className="link-btn" onClick={() => kick(p.id, p.name)} aria-label={`Remove ${p.name}`}>
                        ✕
                      </button>
                    )}
                  </span>
                </li>
              ))}
              {t.players.length === 0 && <li className="muted">Nobody yet</li>}
            </ul>
          </div>
        ))}
      </div>
      {view.phase !== "lobby" && <SettingsForm view={view} act={act} />}
    </details>
  );
}

/** "Add a co-host": a single-use QR (10 minutes), and the co-hosts with Remove. */
function CohostPanel({ view, act }: { view: RoomView; act: Act }) {
  const venue = useVenue();
  const [invite, setInvite] = useState<{ url: string; expiresAt: string } | null>(null);
  const make = async () => {
    const r = await act<{ path: string; expiresAt: string }>("cohostInvite");
    if (r) setInvite({ url: venueJoinUrl(venue, r.path), expiresAt: r.expiresAt });
  };
  return (
    <details className="panel">
      <summary>Co-hosts ({view.cohosts.length})</summary>
      <p className="muted small">A co-host can run the game from their phone, but can't end the room or remove anyone.</p>
      <ul className="cohosts">
        {view.cohosts.map((c) => (
          <li key={c.id} className={c.connected ? "" : "muted"}>
            {c.name}
            <button className="link-btn" onClick={() => act("removeCohost", c.id)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      {invite ? (
        <div className="join-row">
          <QrCode text={invite.url} size={140} />
          <div>
            <p className="small">Scan once to join as a co-host. Expires at {new Date(invite.expiresAt).toLocaleTimeString()}.</p>
            <p className="small break">{invite.url}</p>
            <button className="btn btn-ghost btn-small" onClick={() => setInvite(null)}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <button className="btn btn-ghost" onClick={make}>
          Add a co-host
        </button>
      )}
    </details>
  );
}
