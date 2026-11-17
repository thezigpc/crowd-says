import { useEffect, useState, type FormEvent } from "react";
import { MAX_ANSWER_LENGTH, type GuessResult, type RoomView } from "@crowdsays/shared";
import { Board, Countdown, GuessLog, RoundResult, Scores, Strikes, TurnLine, Winners, teamStyle } from "../components/bits";
import type { Act } from "./RoomPage";

interface Props {
  view: RoomView;
  skew: number;
  act: Act;
  setToast: (s: string) => void;
}

export function PlayerView({ view, skew, act, setToast }: Props) {
  const myTeam = view.you.team === null ? undefined : view.teams[view.you.team];
  return (
    <main className="player" style={teamStyle(myTeam)}>
      <div className="my-team">
        You're on <strong>{myTeam?.name ?? "a team"}</strong>
      </div>
      {view.phase === "lobby" && <Lobby view={view} act={act} />}
      {view.phase === "answer" && <AnswerForm view={view} skew={skew} act={act} />}
      {view.phase === "group" && (
        <section className="panel center">
          <h2>Answers are in!</h2>
          <p className="muted">{view.answerCount} answers. The host is checking them before the board goes up.</p>
        </section>
      )}
      {view.phase === "guess" && <Guessing view={view} act={act} setToast={setToast} />}
      {view.phase === "roundEnd" && (
        <section className="panel">
          <RoundResult view={view} />
          <p className="prompt prompt-sm">{view.prompt}</p>
          <Board view={view} />
          <Scores view={view} compact />
          <p className="muted small center">{view.you.canRun ? "" : "Waiting for the next round…"}</p>
        </section>
      )}
      {view.phase === "gameOver" && (
        <section className="panel">
          <Winners view={view} />
          <Scores view={view} />
          <Lobby view={view} act={act} />
        </section>
      )}
    </main>
  );
}

/** Between games: pick your team, wait for the host. */
function Lobby({ view, act }: { view: RoomView; act: Act }) {
  return (
    <section className="panel">
      <h2>{view.phase === "gameOver" ? "Next game" : "Waiting for the host to start"}</h2>
      <p className="muted">Pick your team:</p>
      <div className="team-pick">
        {view.teams.map((t) => (
          <button
            key={t.index}
            className={`chip chip-team ${view.you.team === t.index ? "chip-on" : ""}`}
            style={teamStyle(t)}
            onClick={() => act("chooseTeam", { team: t.index })}
          >
            {t.name} <span className="muted">({t.players.length})</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function AnswerForm({ view, skew, act }: { view: RoomView; skew: number; act: Act }) {
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(!view.myAnswer);
  // A new prompt (skipped, or the next round) clears the form.
  useEffect(() => {
    setText("");
    setEditing(true);
  }, [view.prompt, view.round]);
  useEffect(() => {
    if (!view.myAnswer) setEditing(true);
  }, [view.myAnswer]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    if (await act("submitAnswer", { text: text.trim() })) setEditing(false);
  };
  return (
    <section className="panel">
      <div className="answer-head">
        <span className="muted small">Round {view.round}</span>
        <Countdown at={view.deadline} skew={skew} />
      </div>
      <p className="prompt">{view.prompt}</p>
      {view.myAnswer && !editing ? (
        <div className="answered">
          <p>
            Your answer: <strong>{view.myAnswer}</strong>
          </p>
          <button className="btn btn-ghost" onClick={() => setEditing(true)}>
            Change it
          </button>
          <p className="muted small">
            {view.answeredCount} of {view.playerCount} answered
          </p>
        </div>
      ) : (
        <form onSubmit={submit} className="answer-form">
          <input
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, MAX_ANSWER_LENGTH))}
            maxLength={MAX_ANSWER_LENGTH}
            placeholder="Your answer"
            autoFocus
            autoComplete="off"
            enterKeyHint="send"
          />
          <button className="btn btn-primary btn-big" disabled={!text.trim()}>
            {view.myAnswer ? "Change answer" : "Send"}
          </button>
          <p className="muted small">Say what you think most people would say. Short answers group best.</p>
        </form>
      )}
    </section>
  );
}

const SAID: Record<GuessResult, string> = {
  hit: "It's on the board!",
  miss: "Not on the board.",
  repeat: "That one's already up.",
};

function Guessing({ view, act, setToast }: { view: RoomView; act: Act; setToast: (s: string) => void }) {
  const [text, setText] = useState("");
  const turn = view.turn!;
  const mine = view.you.team === turn.guessing;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    const r = await act<{ result: GuessResult }>("guess", { text: text.trim() });
    if (r) {
      setText("");
      setToast(SAID[r.result]);
    }
  };
  return (
    <section className="panel">
      <p className="prompt prompt-sm">{view.prompt}</p>
      <TurnLine view={view} />
      <Strikes n={turn.strikes} max={view.settings.strikes} />
      {mine ? (
        <form onSubmit={submit} className="answer-form">
          <input
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, MAX_ANSWER_LENGTH))}
            maxLength={MAX_ANSWER_LENGTH}
            placeholder={turn.stealing ? "One guess to steal…" : "Your team's guess"}
            autoComplete="off"
            enterKeyHint="send"
          />
          <button className="btn btn-primary btn-big" disabled={!text.trim()}>
            {turn.stealing ? "Steal!" : "Guess"}
          </button>
          <p className="muted small">Talk it over: anyone on your team can send the guess.</p>
        </form>
      ) : (
        <p className="muted center">{view.teams[turn.guessing]?.name} is guessing. Watch the board!</p>
      )}
      <Board view={view} />
      <GuessLog view={view} />
      <Scores view={view} compact />
    </section>
  );
}
