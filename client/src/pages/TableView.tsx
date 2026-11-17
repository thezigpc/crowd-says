import { JoinAddress } from "@bargames/gamekit/client";
import { isOnBox, joinDisplay } from "@bargames/sdk/client";
import type { RoomView } from "@crowdsays/shared";
import { Board, Countdown, GuessLog, QrCode, RoundResult, Scores, Strikes, TurnLine, Winners, secondsLeft, teamStyle, useNow } from "../components/bits";
import { useGameName, useVenue } from "../venue";

/**
 * The TV board (routes.table: /join/{code}?as=table). Display only: nothing here needs a
 * pointer. Built for 1080p seen from across a room: big type, safe margins, a static board.
 */
export function TableView({ view, skew, onHostControls }: { view: RoomView; skew: number; onHostControls?: () => void }) {
  const venue = useVenue();
  const gameName = useGameName();
  const join = joinDisplay(venue, `/join/${view.code}`, view.code);
  // Box 0.15.6's short room link (play.<venue>/AB12) when there is one, else the game's address.
  const address = join.roomShort ?? join.short;
  const logo = isOnBox(venue) ? venue?.game.theme.logoUrl : undefined;
  const lobby = view.phase === "lobby";

  return (
    <div className="tv">
      <header className="tv-head">
        <div className="tv-title">
          {logo && <img className="tv-logo" src={logo} alt="" />}
          <span>{gameName}</span>
        </div>
        {view.round > 0 && (
          <span className="tv-round">
            Round {view.round} of {view.settings.rounds}
          </span>
        )}
        {onHostControls && (
          <button className="btn btn-ghost tv-host-btn" onClick={onHostControls}>
            Host controls
          </button>
        )}
      </header>

      <div className={`tv-body ${lobby ? "tv-body-lobby" : ""}`}>
        <main className="tv-main">
          {lobby && <TvLobby view={view} />}
          {view.phase === "answer" && <TvAnswer view={view} skew={skew} />}
          {view.phase === "group" && (
            <div className="tv-center">
              <p className="prompt prompt-tv">{view.prompt}</p>
              <p className="tv-big">Counting {view.answerCount} answers…</p>
            </div>
          )}
          {view.phase === "guess" && view.turn && (
            <>
              <p className="prompt prompt-tv-sm">{view.prompt}</p>
              <Board view={view} size="tv" />
              <div className="tv-turn">
                <TurnLine view={view} />
                <Strikes n={view.turn.strikes} max={view.settings.strikes} />
              </div>
            </>
          )}
          {view.phase === "roundEnd" && (
            <>
              <p className="prompt prompt-tv-sm">{view.prompt}</p>
              <Board view={view} size="tv" />
              <RoundResult view={view} />
              <AdvanceNote view={view} skew={skew} />
            </>
          )}
          {view.phase === "gameOver" && (
            <div className="tv-center">
              <Winners view={view} />
              <Scores view={view} />
            </div>
          )}
        </main>

        <aside className="tv-side">
          {!lobby && view.phase !== "gameOver" && <Scores view={view} />}
          {view.phase === "guess" && <GuessLog view={view} max={3} />}
          <div className={`join-box ${lobby ? "join-box-big" : ""}`}>
            <QrCode text={join.url} size={lobby ? 280 : 150} />
            {/* The kit's JoinAddress: breaks after "." and "/", shrinks long addresses. */}
            <JoinAddress url={address} className="muted" minScale={0.8} lines={2} />
            <div className="join-code">{view.code}</div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function TvLobby({ view }: { view: RoomView }) {
  return (
    <div className="tv-lobby">
      <p className="tv-big">Scan to play!</p>
      <p className="muted tv-sub">Everyone answers a prompt on their phone. Then teams guess what the crowd said most.</p>
      <div className="tv-teams">
        {view.teams.map((t) => (
          <div key={t.index} className="tv-team" style={teamStyle(t)}>
            <h3>{t.name}</h3>
            <ul>
              {t.players.slice(0, 12).map((p) => (
                <li key={p.id} className={p.connected ? "" : "muted"}>
                  {p.name}
                </li>
              ))}
              {t.players.length > 12 && <li className="muted">+{t.players.length - 12} more</li>}
              {t.players.length === 0 && <li className="muted">Nobody yet</li>}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function TvAnswer({ view, skew }: { view: RoomView; skew: number }) {
  return (
    <div className="tv-center">
      <p className="prompt prompt-tv">{view.prompt}</p>
      <Countdown at={view.deadline} skew={skew} className="countdown-tv" />
      <p className="tv-big">
        {view.answeredCount} of {view.playerCount} answered
      </p>
      <p className="muted tv-sub">Answer on your phone. What would most people say?</p>
    </div>
  );
}

/** A room nobody is running moves on by itself: say when. */
function AdvanceNote({ view, skew }: { view: RoomView; skew: number }) {
  const now = useNow(1000);
  const s = secondsLeft(view.advanceAt, now, skew);
  if (s === null) return null;
  return <p className="muted tv-sub center">{view.round >= view.settings.rounds ? "Final scores" : "Next round"} in {s}…</p>;
}
