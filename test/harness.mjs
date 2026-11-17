// Test harness: every spec file gets its own throwaway server on its own free port (never
// 3013), with its own data directory. Specs talk to it over real sockets, like the client.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { io } from "socket.io-client";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export async function startServer(env = {}, dataDir = mkdtempSync(path.join(os.tmpdir(), "crowdsays-test-"))) {
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(root, "server/dist/index.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      LOG_LEVEL: "warn",
      CLIENT_DIST_PATH: path.join(root, "nonexistent"),
      DATA_DIR: dataDir,
      ADMIN_PASSWORD: "",
      BG_GAME_ID: "",
      BG_CORE_URL: "",
      BG_GAME_TOKEN: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  proc.stdout.on("data", (d) => (output += d));
  proc.stderr.on("data", (d) => (output += d));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) break;
    } catch {}
    await sleep(100);
  }
  const clients = [];
  return {
    url,
    dataDir,
    proc,
    port,
    get output() {
      return output;
    },
    async client() {
      const c = await connect(url);
      clients.push(c);
      return c;
    },
    /** Stops the server; keepData leaves the data dir for a second server. */
    async stop({ keepData = false } = {}) {
      for (const c of clients) c.socket.close();
      proc.kill();
      await new Promise((r) => (proc.exitCode !== null ? r() : proc.once("exit", r)));
      if (!keepData) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** A socket wrapper that remembers the latest state and lets specs await conditions. */
export async function connect(url) {
  const socket = io(url, { transports: ["websocket"], reconnection: false, forceNew: true });
  const c = {
    socket,
    state: null,
    closedReason: null,
    notices: [],
    waiters: [],
    emit(event, ...args) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`ack timeout: ${event}`)), 5000);
        socket.emit(event, ...args, (res) => {
          clearTimeout(t);
          resolve(res);
        });
      });
    },
    /** Emits and asserts ok, returning the ack payload. */
    async ok(event, ...args) {
      const res = await c.emit(event, ...args);
      if (!res?.ok) throw new Error(`${event} failed: ${res?.error}`);
      return res;
    },
    waitFor(pred, label = "condition", ms = 5000) {
      if (c.state && pred(c.state)) return Promise.resolve(c.state);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        c.waiters.push(w);
        setTimeout(() => {
          c.waiters = c.waiters.filter((x) => x !== w);
          reject(new Error(`timed out waiting for ${label}; last state: ${JSON.stringify(c.state)?.slice(0, 600)}`));
        }, ms);
      });
    },
  };
  socket.on("state", (s) => {
    c.state = s;
    for (const w of [...c.waiters]) {
      if (w.pred(s)) {
        c.waiters = c.waiters.filter((x) => x !== w);
        w.resolve(s);
      }
    }
  });
  socket.on("closed", ({ reason }) => (c.closedReason = reason));
  socket.on("notice", ({ message }) => c.notices.push(message));
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return c;
}

/** Host + players in one room. players: [{ name, team }]. */
export async function setupRoom(server, players = [{ name: "Ann", team: 0 }]) {
  const host = await server.client();
  const created = await host.ok("createRoom", {});
  const out = [];
  for (const { name, team } of players) {
    const p = await server.client();
    const joined = await p.ok("joinRoom", { code: created.code, role: "player", name, team });
    p.token = joined.token;
    p.name = name;
    out.push(p);
  }
  return { code: created.code, host, players: out };
}

/** Everyone answers; the last answer closes the answer phase (all connected players answered). */
export async function answerAll(players, answers) {
  for (let i = 0; i < players.length; i++) await players[i].ok("submitAnswer", { text: answers[i] });
}

/**
 * A fake box core: serves the venue context, records every event and result, answers the
 * venue-password check.
 */
export async function fakeCore(token, gameId = "crowdsays") {
  const events = [];
  const results = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(401).end();
      if (req.url === "/internal/events") {
        events.push(JSON.parse(body));
        return void res.writeHead(204).end();
      }
      if (req.url === "/internal/results") {
        results.push(JSON.parse(body));
        return void res.writeHead(204).end();
      }
      if (req.url === "/internal/venue-password") {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ ok: JSON.parse(body).password === "box-password" }));
      }
      if (req.url === "/internal/venue") {
        res.writeHead(200, { "content-type": "application/json" });
        const theme = { colors: { background: "#0b2a2a", surface: "#12403f", text: "#f2fffd", primary: "#ff4fa3", accent: "#ffd23f" } };
        return void res.end(
          JSON.stringify({
            protocol: 1,
            venue: { name: "Test Bar", theme },
            game: { id: gameId, displayName: "Crowd Says at Test Bar", theme },
            standalone: false,
            generatedAt: new Date().toISOString(),
          }),
        );
      }
      res.writeHead(404).end();
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${srv.address().port}`,
    events,
    results,
    of: (type, code) => events.filter((e) => e.type === type && (!code || e.roomCode === code)),
    async waitFor(pred, label, ms = 5000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const hit = events.find(pred);
        if (hit) return hit;
        await sleep(25);
      }
      throw new Error(`no event: ${label}; got ${JSON.stringify(events.map((e) => e.type))}`);
    },
    close: () => new Promise((r) => srv.close(r)),
  };
}
