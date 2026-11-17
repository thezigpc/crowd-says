import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useOnScreenKeyboard, useRoomConnection } from "@bargames/gamekit/client";
import { isOnBox, markSharedScreen, tableMode, type TableModeController } from "@bargames/sdk/client";
import type { RoomView } from "@crowdsays/shared";
import { call, socket } from "../socket";
import { clearSession, getBoardHere, sessions, setBoardHere, type StoredSession } from "../session";
import { useVenue } from "../venue";
import { HostView } from "./HostView";
import { PlayerView } from "./PlayerView";
import { TableView } from "./TableView";

/** Runs a server intent, surfacing a rejection as a short-lived toast. */
export function useAction() {
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);
  const act = useCallback(async <T = object,>(event: Parameters<typeof call>[0], ...args: unknown[]) => {
    try {
      return await call<T>(event, ...args);
    } catch (err) {
      setToast(err instanceof Error ? err.message : "Something went wrong.");
      return null;
    }
  }, []);
  return { act, toast, setToast };
}

export type Act = ReturnType<typeof useAction>["act"];

export function RoomPage() {
  const { code = "" } = useParams();
  const navigate = useNavigate();
  const upper = code.toUpperCase();
  // Re-sends `resume` on every socket connect (a reconnect is a brand-new server socket).
  const { view, status, closedReason, skew, reconnect } = useRoomConnection<RoomView, StoredSession>(upper, {
    socket: socket as unknown as Parameters<typeof useRoomConnection>[1]["socket"],
    call,
    sessions,
    // The host link's key resumes the host seat, and the server answers with that seat's own
    // token: keep it, so a later take-over (a new key) leaves this phone on as a co-host.
    onResumed: (ack, session) =>
      sessions.save({
        ...session,
        token: typeof ack.token === "string" ? ack.token : session.token,
        name: typeof ack.name === "string" ? ack.name : session.name,
        role: typeof ack.role === "string" ? (ack.role as StoredSession["role"]) : session.role,
      }),
  });
  const { act, toast, setToast } = useAction();
  // On a touchscreen with the on-screen keyboard, a toast at the bottom would sit under it.
  const keyboardScreen = useOnScreenKeyboard();
  // One-off messages: "Staff took over hosting…", "You're not a co-host any more."
  useEffect(() => {
    const onNotice = (n: { message: string }) => setToast(n.message);
    socket.on("notice", onNotice);
    return () => {
      socket.off("notice", onNotice);
    };
  }, [setToast]);
  const [boardHere, setBoard] = useState(() => getBoardHere(upper));
  const showBoard = (on: boolean) => {
    setBoardHere(upper, on);
    setBoard(on);
    window.scrollTo(0, 0);
  };

  // Bar Games box TV: tableMode hides the pointer, keeps the screen awake, sets the safe
  // margins and shows the standard "Reconnecting…" / "Room closed". Off a box nothing changes.
  const venue = useVenue();
  const role = view?.you.role;
  const onBox = isOnBox(venue);
  const boxTv = onBox && role === "table";
  const tm = useRef<TableModeController | null>(null);
  useEffect(() => {
    if (!boxTv) return;
    tm.current = tableMode(venue);
    return () => {
      tm.current?.stop();
      tm.current = null;
    };
    // tableMode only needs the venue once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxTv]);
  const runner = !!view?.you.canRun;
  // The host's own screen showing the board (an iPad on a TV) is a shared screen too.
  const sharedScreen = onBox && !boxTv && runner && boardHere;
  useEffect(() => (sharedScreen ? markSharedScreen() : undefined), [sharedScreen]);
  useEffect(() => {
    tm.current?.setState(closedReason ? "closed" : status === "offline" ? "reconnecting" : "connected", closedReason ?? undefined);
  }, [boxTv, status, closedReason]);

  if (closedReason) {
    return (
      <main className="center-page">
        <div className="panel">
          <h2>Room closed</h2>
          <p>{closedReason}</p>
          <Link className="btn btn-primary" to="/">
            Back to home
          </Link>
        </div>
      </main>
    );
  }

  if (!view) {
    return (
      <main className="center-page">
        <p className="muted">Connecting to room {upper}…</p>
      </main>
    );
  }

  const tv = role === "table" || (runner && boardHere);
  const leave = async () => {
    const msg = role === "host" ? "End this room for everyone?" : "Leave this room?";
    if (!window.confirm(msg)) return;
    await call("leaveRoom").catch(() => {});
    clearSession();
    navigate("/");
  };

  return (
    <div className={`room role-${role} ${tv ? "room-tv" : ""}`}>
      {status !== "online" && !boxTv && (
        <div className={`banner ${tv ? "banner-float" : ""}`} role="status">
          {status === "offline" ? "Connection lost. Reconnecting…" : "Connecting…"}
        </div>
      )}
      {!tv && (
        <header className="room-header">
          <div className="room-id">
            <span className="room-code">{view.code}</span>
            <span className="muted">
              {role === "host" ? "Host" : view.you.name}
              {view.round > 0 ? ` · Round ${view.round} of ${view.settings.rounds}` : ""}
            </span>
            {role === "cohost" && <span className="badge">Co-host</span>}
          </div>
          <div className="header-actions">
            {runner && (
              <button className="icon-btn" onClick={() => showBoard(true)} title="Show the TV board here" aria-label="Show the TV board here">
                📺
              </button>
            )}
            <button className="icon-btn" onClick={reconnect} title="Reconnect" aria-label="Reconnect">
              ⟳
            </button>
            <button className="icon-btn" onClick={leave} title={role === "host" ? "End room" : "Leave"} aria-label="Leave">
              ✕
            </button>
          </div>
        </header>
      )}
      {runner && !boardHere && <HostView view={view} skew={skew} act={act} setToast={setToast} />}
      {runner && boardHere && <TableView view={view} skew={skew} onHostControls={() => showBoard(false)} />}
      {role === "player" && <PlayerView view={view} skew={skew} act={act} setToast={setToast} />}
      {role === "table" && <TableView view={view} skew={skew} />}
      {toast && (
        <div className={`toast ${keyboardScreen ? "toast-top" : ""}`} role="alert" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </div>
  );
}
