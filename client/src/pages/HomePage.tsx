import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { BackToGames } from "@bargames/gamekit/client";
import type { JoinResult } from "@crowdsays/shared";
import { call } from "../socket";
import { lastName, loadSession, rememberName, saveSession } from "../session";
import { useGameName, useVenue } from "../venue";

interface TeamInfo {
  index: number;
  name: string;
  color: string;
  players: number;
}

export function HomePage() {
  const navigate = useNavigate();
  const params = useParams();
  const [search] = useSearchParams();
  const gameName = useGameName();
  const venue = useVenue();
  const [code, setCode] = useState((params.code ?? "").toUpperCase());
  const [name, setName] = useState(lastName());
  const [team, setTeam] = useState(-1);
  const [teams, setTeams] = useState<TeamInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const autoTable = useRef(false);
  // /join/ABCD?cohost=<invite>: the host's (or the box's) "Add a co-host" QR. Single use.
  const cohostInvite = search.get("cohost") ?? undefined;

  // The room's teams, for the picker.
  useEffect(() => {
    setTeams([]);
    if (code.length !== 4 || cohostInvite) return;
    let live = true;
    call<{ teams: TeamInfo[] }>("roomInfo", { code })
      .then((r) => live && setTeams(r.teams))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [code, cohostInvite]);

  const enter = (r: JoinResult) => {
    saveSession({ roomCode: r.code, token: r.token, name: r.name, role: r.role });
    navigate(`/room/${r.code}`, { replace: true });
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const host = () =>
    run(async () => {
      enter(await call<JoinResult>("createRoom", {}));
    });

  const join = (role: "player" | "table") =>
    run(async () => {
      const roomCode = code.trim().toUpperCase();
      if (roomCode.length !== 4) throw new Error("Room codes are 4 letters.");
      const existing = loadSession();
      const token =
        existing?.roomCode === roomCode && (existing.role === role || (cohostInvite && role === "player")) ? existing.token : undefined;
      if (role === "player") rememberName(name.trim());
      enter(
        await call<JoinResult>("joinRoom", {
          code: roomCode,
          role,
          name: role === "player" ? name.trim() : undefined,
          token,
          team: team >= 0 ? team : undefined,
          cohost: role === "player" ? cohostInvite : undefined,
        }),
      );
    });

  // /join/ABCD?as=table opens straight into the TV view (the box casts this link).
  // /join/ABCD?host=<key>: the host link (the box's "Open the host controls", or a take-over).
  useEffect(() => {
    const hostToken = search.get("host");
    if (hostToken && code.length === 4) {
      saveSession({ roomCode: code, token: hostToken, name: "Venue", role: "host" });
      navigate(`/room/${code}`, { replace: true });
      return;
    }
    if (search.get("as") === "table" && code.length === 4 && !autoTable.current) {
      autoTable.current = true;
      join("table");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onJoin = (e: FormEvent) => {
    e.preventDefault();
    join("player");
  };

  if (search.get("as") === "table" && !error) {
    return (
      <main className="center-page">
        <p className="muted">Opening the TV view…</p>
      </main>
    );
  }

  return (
    <main className="home">
      <header className="home-hero">
        <div className="hero-board" aria-hidden>
          <span className="hero-slot hero-slot-open">
            <b>1</b>Sunscreen<i>14</i>
          </span>
          <span className="hero-slot">
            <b>2</b>
          </span>
          <span className="hero-slot">
            <b>3</b>
          </span>
        </div>
        <h1>{gameName}</h1>
        <p className="muted">Everyone answers on their phone. Then teams guess what the crowd said most.</p>
      </header>

      <form className="panel join-panel" onSubmit={onJoin}>
        <h2>{cohostInvite ? "Join as a co-host" : "Join a game"}</h2>
        {cohostInvite && (
          <p className="muted small">You'll be able to run the game: deal prompts, check the answers and judge guesses. This link works once.</p>
        )}
        <label>
          Room code
          <input
            value={code}
            onChange={(e) =>
              setCode(
                e.target.value
                  .toUpperCase()
                  .replace(/[^A-Z]/g, "")
                  .slice(0, 4),
              )
            }
            placeholder="ABCD"
            autoCapitalize="characters"
            autoComplete="off"
            maxLength={4}
            className="code-input"
          />
        </label>
        <label>
          Your name
          <input value={name} onChange={(e) => setName(e.target.value.slice(0, 24))} maxLength={24} placeholder="Name" autoComplete="nickname" />
        </label>
        {teams.length > 0 && (
          <fieldset className="team-pick">
            <legend>Team</legend>
            <button type="button" className={`chip ${team < 0 ? "chip-on" : ""}`} onClick={() => setTeam(-1)}>
              Any team
            </button>
            {teams.map((t) => (
              <button
                type="button"
                key={t.index}
                className={`chip chip-team ${team === t.index ? "chip-on" : ""}`}
                style={{ "--team": t.color } as React.CSSProperties}
                onClick={() => setTeam(t.index)}
              >
                {t.name} <span className="muted">({t.players})</span>
              </button>
            ))}
          </fieldset>
        )}
        <button className="btn btn-primary btn-big" disabled={busy || code.length !== 4 || !name.trim()}>
          {cohostInvite ? "Join as co-host" : "Join"}
        </button>
        {!cohostInvite && (
          <button type="button" className="btn btn-ghost" disabled={busy || code.length !== 4} onClick={() => join("table")}>
            Open as the TV view
          </button>
        )}
      </form>

      {!cohostInvite && (
        <section className="panel">
          <h2>Host a game</h2>
          <p className="muted">You'll deal the prompts, tidy up the answers and run the board. Players join with the room code.</p>
          <button className="btn btn-secondary btn-big" disabled={busy} onClick={host}>
            Host a game
          </button>
        </section>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <footer className="home-foot">
        <Link to="/admin" className="muted small">
          Admin
        </Link>
      </footer>

      {/* Bar Games: back to the venue's games list. Landing page only; nothing standalone. */}
      {!search.get("host") && !cohostInvite && <BackToGames ctx={venue} />}
    </main>
  );
}
