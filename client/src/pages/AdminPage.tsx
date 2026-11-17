import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import type { AdminSettings, PackSummary } from "@crowdsays/shared";
import { BoxAdminLink, staffSignIn } from "@bargames/gamekit/client";
import { serverUrl } from "../socket";
import { useVenue } from "../venue";

const TOKEN_KEY = "crowdsays_admin_token";
const loadToken = () => {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
};
const saveToken = (t: string) => {
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: the session lasts this page */
  }
};

async function api<T>(path: string, token: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${serverUrl}/api/admin${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? `Request failed (${res.status}).`), { status: res.status });
  return body as T;
}

/** The kit's /api/admin/status. */
interface AdminStatus {
  setupNeeded: boolean;
  authenticated: boolean;
  trusted?: boolean;
  venueLogin?: boolean;
  setupAllowed?: boolean;
}

interface RoomRow {
  code: string;
  kind: string;
  players: number;
  phase?: string;
  title?: string;
  hostConnected?: boolean;
  tables: number;
  lastActivityAt: string;
}

interface Overview {
  rooms: RoomRow[];
  settings: AdminSettings;
  packs: PackSummary[];
  saved: { prompts: number; answers: number };
}

export function AdminPage() {
  const [token, setToken] = useState(loadToken);
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [error, setError] = useState("");
  // After a manual sign-out, don't sign venue staff straight back in.
  const [signedOut, setSignedOut] = useState(false);
  const venue = useVenue();

  const refreshStatus = useCallback(() => {
    api<AdminStatus>("/status", token)
      .then(async (s) => {
        // Venue staff (the box vouches for this browser): a session without the password.
        // Never true off a box.
        if (!s.authenticated && s.trusted && !signedOut) {
          const t = await staffSignIn(serverUrl);
          if (t) {
            saveToken(t);
            setToken(t);
            return;
          }
        }
        setStatus(s);
      })
      .catch((e: Error) => setError(e.message));
  }, [token, signedOut]);
  useEffect(refreshStatus, [refreshStatus]);

  const signedIn = (t: string) => {
    saveToken(t);
    setToken(t);
  };
  const signOut = async () => {
    await api("/logout", token, { method: "POST" }).catch(() => {});
    setSignedOut(true);
    signedIn("");
  };

  return (
    <main className="admin">
      {/* "← Box admin" for staff who came from the venue box; nothing standalone. */}
      <BoxAdminLink ctx={venue} />
      <header className="admin-head">
        <h1>Admin</h1>
        <Link to="/" className="muted">
          ← Home
        </Link>
      </header>
      {error && <p className="error">{error}</p>}
      {!status ? (
        <p className="muted">Loading…</p>
      ) : status.authenticated ? (
        <Dashboard token={token} onSignOut={signOut} onExpired={() => signedIn("")} />
      ) : (
        <PasswordForm status={status} onToken={signedIn} />
      )}
    </main>
  );
}

function PasswordForm({ status, onToken }: { status: AdminStatus; onToken: (t: string) => void }) {
  // On a box the box's admin password signs in here too, even before the game has its own.
  const onBox = status.venueLogin === true;
  const setupNeeded = status.setupNeeded;
  const canSetOwn = onBox && setupNeeded && status.setupAllowed === true;
  const [ownPassword, setOwnPassword] = useState(false);
  const setup = setupNeeded && (!onBox || (canSetOwn && ownPassword));
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (setup && password !== confirm) {
      setError("The passwords don't match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const r = await api<{ token: string }>(setup ? "/setup" : "/login", "", { method: "POST", body: { password } });
      onToken(r.token);
    } catch (err) {
      const msg = (err as Error).message;
      setError(onBox && setupNeeded && !setup && /set up/i.test(msg) ? "That isn't the venue's admin password." : msg);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="panel admin-login" onSubmit={submit}>
      <h2>{setup ? "Set the admin password" : "Sign in"}</h2>
      {onBox && !setup && (
        <p className="muted small">{setupNeeded ? "Use the venue's admin password." : "Use this game's admin password, or the venue's admin password."}</p>
      )}
      {setup && (
        <p className="warning">
          No admin password has been set yet. Whoever sets it first becomes the admin, so do this now. The <code>ADMIN_PASSWORD</code>{" "}
          environment variable overrides it.
        </p>
      )}
      <label>
        Password
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={200} autoComplete={setup ? "new-password" : "current-password"} autoFocus />
      </label>
      {setup && (
        <label>
          Confirm password
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} maxLength={200} autoComplete="new-password" />
        </label>
      )}
      {error && <p className="error">{error}</p>}
      <button className="btn btn-primary btn-big" disabled={busy || password.length === 0}>
        {setup ? "Set password" : "Sign in"}
      </button>
      {canSetOwn && (
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            setOwnPassword(!ownPassword);
            setError("");
          }}
        >
          {ownPassword ? "Sign in with the venue's password instead" : "Set a separate password for this game instead"}
        </button>
      )}
    </form>
  );
}

function Dashboard({ token, onSignOut, onExpired }: { token: string; onSignOut: () => void; onExpired: () => void }) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const load = useCallback(() => {
    api<Overview>("/overview", token)
      .then((d) => {
        setData(d);
        setError("");
      })
      .catch((e: Error & { status?: number }) => (e.status === 401 ? onExpired() : setError(e.message)));
  }, [token, onExpired]);
  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setError("");
    setNote("");
    try {
      await fn();
      if (done) setNote(done);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!data) return <p className="muted">{error || "Loading…"}</p>;
  return (
    <>
      {error && <p className="error">{error}</p>}
      {note && <p className="note">{note}</p>}

      <section className="panel">
        <h2>Rooms ({data.rooms.length})</h2>
        {data.rooms.length === 0 ? (
          <p className="muted">No rooms open.</p>
        ) : (
          <ul className="admin-rooms">
            {data.rooms.map((r) => (
              <li key={r.code}>
                <span className="room-code">{r.code}</span>
                <span>
                  {r.title ?? r.phase} · {r.players} player{r.players === 1 ? "" : "s"} · {r.kind}
                  {r.hostConnected ? "" : " · host away"}
                </span>
                <button
                  className="btn btn-small btn-ghost"
                  onClick={() => window.confirm(`Close room ${r.code}?`) && run(() => api(`/rooms/${r.code}/close`, token, { method: "POST" }))}
                >
                  Close
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <PacksPanel token={token} packs={data.packs} run={run} />

      <section className="panel">
        <h2>Saved answers</h2>
        <p className="muted small">
          Every round's answers are kept here (text only, no names) so small rooms can mix them in later. They never leave this
          server. {data.saved.answers} answers for {data.saved.prompts} prompts.
        </p>
        <button
          className="btn btn-ghost"
          disabled={data.saved.answers === 0}
          onClick={() => window.confirm("Delete every saved answer and grouping?") && run(() => api("/saved", token, { method: "DELETE" }), "Saved answers cleared.")}
        >
          Clear saved answers
        </button>
      </section>

      <SettingsPanel token={token} settings={data.settings} run={run} />

      <button className="btn btn-ghost" onClick={onSignOut}>
        Sign out
      </button>
    </>
  );
}

type Run = (fn: () => Promise<unknown>, done?: string) => Promise<void>;

function PacksPanel({ token, packs, run }: { token: string; packs: PackSummary[]; run: Run }) {
  const [name, setName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const upload = async (e: FormEvent) => {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    const text = await file.text();
    await run(
      () => api("/packs", token, { method: "POST", body: { name: name.trim() || file.name.replace(/\.(csv|json|txt)$/i, ""), text } }),
      "Pack added.",
    );
    setName("");
    if (fileRef.current) fileRef.current.value = "";
  };
  return (
    <section className="panel">
      <h2>Prompt packs</h2>
      <ul className="admin-packs">
        {packs.map((p) => (
          <li key={p.id}>
            <span>
              {p.name} <span className="muted">({p.prompts} prompts{p.builtIn ? ", built in" : ""})</span>
            </span>
            {!p.builtIn && (
              <button
                className="btn btn-small btn-ghost"
                onClick={() => window.confirm(`Delete the pack “${p.name}”?`) && run(() => api(`/packs/${p.id}`, token, { method: "DELETE" }))}
              >
                Delete
              </button>
            )}
          </li>
        ))}
      </ul>
      <form onSubmit={upload} className="pack-upload">
        <h3>Add a pack</h3>
        <p className="muted small">
          CSV: one prompt per line (the first column; a “prompt” header row is fine). JSON: a list of prompts, or{" "}
          <code>{'{ "name": "…", "prompts": ["…"] }'}</code>. Write your own prompts: the crowd writes the answers.
        </p>
        <label>
          Name (optional)
          <input value={name} onChange={(e) => setName(e.target.value.slice(0, 60))} maxLength={60} placeholder="Friday night pack" />
        </label>
        <input type="file" ref={fileRef} accept=".csv,.json,.txt,text/csv,application/json,text/plain" />
        <button className="btn btn-secondary">Upload</button>
      </form>
    </section>
  );
}

function SettingsPanel({ token, settings, run }: { token: string; settings: AdminSettings; run: Run }) {
  const [idle, setIdle] = useState(String(settings.roomIdleMinutes));
  useEffect(() => setIdle(String(settings.roomIdleMinutes)), [settings.roomIdleMinutes]);
  return (
    <form
      className="panel"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => api("/settings", token, { method: "PUT", body: { roomIdleMinutes: Number(idle) } }), "Saved.");
      }}
    >
      <h2>Settings</h2>
      <label>
        Close rooms after this many idle minutes
        <input type="number" inputMode="numeric" min={5} max={1440} maxLength={4} value={idle} onChange={(e) => setIdle(e.target.value)} />
      </label>
      <button className="btn btn-secondary">Save</button>
    </form>
  );
}
