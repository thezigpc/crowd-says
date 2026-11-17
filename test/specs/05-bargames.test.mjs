// Bar Games: standalone stays plain; on a (fake) box the commands, status, events, results,
// hosting from the box and a room with nobody hosting it all work.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { io } from "socket.io-client";
import { answerAll, connect, fakeCore, sleep, startServer } from "../harness.mjs";

const TOKEN = "test-token";
const param = (url, name) => new URL(url, "http://x").searchParams.get(name);

describe("standalone (no BG_* env)", () => {
  let server;
  before(async () => (server = await startServer({ GAME_NAME: "" })));
  after(async () => server.stop());

  test("/api/config is the game's own name; venue.json says standalone", async () => {
    assert.deepEqual(await (await fetch(`${server.url}/api/config`)).json(), { gameName: "Crowd Says" });
    const venue = await (await fetch(`${server.url}/__bargames/venue.json`)).json();
    assert.equal(venue.standalone, true);
  });

  test("box endpoints are closed", async () => {
    const status = await fetch(`${server.url}/__bargames/status`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(status.status, 401);
    const cmd = await fetch(`${server.url}/__bargames/command`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ command: "start", roomCode: "ABCD" }),
    });
    assert.equal(cmd.status, 401);
  });

  test("spoofed gateway headers are ignored: staff and client IP", async () => {
    const staff = { "x-bargames-via": "1", "x-bargames-staff": "1" };
    const st = await (await fetch(`${server.url}/api/admin/status`, { headers: staff })).json();
    assert.equal(st.trusted, false);
    // Rate limiting reads the real address, not x-bargames-client-ip: 20 bad codes from
    // "different" spoofed IPs still lock this one client out.
    let last;
    for (let i = 0; i < 21; i++) {
      const s = io(server.url, { transports: ["websocket"], reconnection: false, forceNew: true, extraHeaders: { "x-bargames-via": "1", "x-bargames-client-ip": `10.0.0.${i}` } });
      await new Promise((r) => s.once("connect", r));
      last = await new Promise((r) => s.emit("roomInfo", { code: "ZZZZ" }, r));
      s.close();
    }
    assert.match(last.error, /Slow down/);
  });
});

describe("on a box", () => {
  let server, core;
  before(async () => {
    core = await fakeCore(TOKEN);
    server = await startServer({ BG_GAME_ID: "crowdsays", BG_CORE_URL: core.url, BG_GAME_TOKEN: TOKEN, HOSTLESS_ADVANCE_MS: "300" });
  });
  after(async () => {
    await server.stop();
    await core.close();
  });

  const command = async (command, roomCode, args) => {
    const res = await fetch(`${server.url}/__bargames/command`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ command, roomCode, args }),
    });
    return { status: res.status, ...(await res.json()) };
  };
  const status = async () =>
    (await fetch(`${server.url}/__bargames/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  const createRoom = async (args = { kind: "venue" }) => {
    const r = await command("create_room", undefined, args);
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.data;
  };
  const join = async (code, name, team) => {
    const c = await server.client();
    const j = await c.ok("joinRoom", { code, role: "player", name, team });
    c.token = j.token;
    c.role = j.role;
    return c;
  };

  test("the venue's name; the token is never served or logged", async () => {
    assert.deepEqual(await (await fetch(`${server.url}/api/config`)).json(), { gameName: "Crowd Says at Test Bar" });
    const venue = await (await fetch(`${server.url}/__bargames/venue.json`)).text();
    assert.equal(JSON.parse(venue).standalone, false);
    assert.ok(!venue.includes(TOKEN));
    assert.ok(!server.output.includes(TOKEN));
  });

  test("a venue room nobody hosts runs itself: start, auto board, next round on its own, next_round, end", async () => {
    const { roomCode: code, hostUrl } = await createRoom({ kind: "venue", title: "Friday crowd" });
    assert.match(hostUrl, new RegExp(`^/join/${code}\\?host=`));
    await core.waitFor((e) => e.type === "room_created" && e.roomCode === code, "room_created");
    let st = (await status()).rooms.find((r) => r.code === code);
    assert.equal(st.kind, "venue");
    assert.equal(st.joinPath, `/join/${code}`);
    assert.equal(st.phase, "lobby");
    assert.match(st.title, /Friday crowd/);

    assert.equal((await command("start", code)).ok, false, "nobody to play yet");
    assert.equal((await command("next_round", code)).ok, false);
    assert.equal((await command("start", "ZZZZ")).ok, false);

    const tv = await server.client();
    await tv.ok("joinRoom", { code, role: "table" });
    const ann = await join(code, "Ann", 0);
    const bob = await join(code, "Bob", 1);
    assert.equal(ann.role, "player", "no first-joiner offer on a plain venue room");
    assert.equal((await command("start", code)).ok, true);
    assert.match((await command("start", code)).message, /already/);
    const started = await core.waitFor((e) => e.type === "round_started" && e.roomCode === code, "round_started");
    assert.equal(started.data.round, 1);
    assert.ok(started.data.prompt);
    assert.equal(started.sessionKind, "venue");

    // No host phone: when the answers are in, the board goes straight up.
    await answerAll([ann, bob], ["Dog", "Cat"]);
    let s = await tv.waitFor((v) => v.phase === "guess", "auto board");
    assert.equal(s.board.length, 2);
    assert.ok(s.board.every((b) => b.label === null), "the TV never sees hidden answers");
    await ann.ok("guess", { text: "dog" });
    await sleep(1600);
    await ann.ok("guess", { text: "cat" });
    const ended = await core.waitFor((e) => e.type === "round_ended" && e.roomCode === code, "round_ended");
    assert.deepEqual([ended.data.round, ended.data.winner, ended.data.points], [1, "Red Team", 2]);
    s = await tv.waitFor((v) => v.phase === "roundEnd");
    assert.ok(s.advanceAt, "it says when it moves on");
    // ...and it moves on by itself.
    s = await tv.waitFor((v) => v.phase === "answer" && v.round === 2, "round 2 on its own", 3000);
    // Staff skip a round from the box.
    assert.equal((await command("next_round", code)).ok, true);
    s = await tv.waitFor((v) => v.round === 3, "round 3");
    const skipped = await core.waitFor((e) => e.type === "round_ended" && e.roomCode === code && e.data.round === 2, "skipped round");
    assert.equal(skipped.data.skipped, true);
    st = (await status()).rooms.find((r) => r.code === code);
    assert.equal(st.phase, "answer");
    assert.equal(st.players, 2);

    assert.equal((await command("end", code)).ok, true);
    await core.waitFor((e) => e.type === "room_closed" && e.roomCode === code, "room_closed");
    assert.ok(!(await status()).rooms.some((r) => r.code === code));
    for (let i = 0; i < 40 && !ann.closedReason; i++) await sleep(25);
    assert.match(ann.closedReason, /host ended/);
  });

  test("staff host from the iPad; winner, game_over and results with teams as players", async () => {
    const { roomCode: code, hostUrl } = await createRoom();
    const staff = await server.client();
    const r = await staff.ok("resume", { code, token: param(hostUrl, "host") });
    assert.equal(r.role, "host");
    const ann = await join(code, "Ann", 0);
    const bob = await join(code, "Bob", 1);
    await staff.ok("setTeamName", { team: 0, name: "Lions" });
    await staff.ok("updateSettings", { rounds: 1 });
    await staff.ok("startGame");
    await answerAll([ann, bob], ["Dog", "Cat"]);
    await staff.waitFor((v) => v.phase === "group", "a runner checks the groups");
    await staff.ok("goLive");
    await staff.ok("revealSlot", { rank: 1 });
    await staff.ok("revealSlot", { rank: 2 });
    await staff.ok("nextRound");
    const winner = await core.waitFor((e) => e.type === "winner" && e.roomCode === code, "winner");
    assert.deepEqual(winner.data, { name: "Lions", score: 2, tie: false });
    const over = await core.waitFor((e) => e.type === "game_over" && e.roomCode === code, "game_over");
    assert.deepEqual(over.data.winners, ["Lions"]);
    await core.waitFor((e) => e.type === "game_result" && e.roomCode === code, "game_result");
    for (let i = 0; i < 40 && !core.results.some((x) => x.roomCode === code); i++) await sleep(25);
    const result = core.results.find((x) => x.roomCode === code);
    assert.deepEqual(result.results, [
      { player: { name: "Lions", team: true }, place: 1, score: 2 },
      { player: { name: "Blue Team", team: true }, place: 2, score: 0 },
    ]);
    assert.equal((await command("next_round", code)).ok, false, "game over");
    assert.equal((await command("start", code)).ok, true, "a new game");
  });

  test("host_link takes over (the old host stays as a co-host); cohost_link and remove_cohost", async () => {
    const { roomCode: code, hostUrl } = await createRoom();
    const first = await server.client();
    await first.ok("resume", { code, token: param(hostUrl, "host") });
    const link = await command("host_link", code);
    assert.equal(link.ok, true);
    const newKey = param(link.data.url, "host");
    assert.ok(newKey && newKey !== param(hostUrl, "host"));
    let s = await first.waitFor((v) => v.you.role === "cohost", "old host is a co-host");
    assert.equal(s.you.canRun, true);
    assert.ok(first.notices.some((n) => /took over/.test(n)));
    assert.match((await (await server.client()).emit("resume", { code, token: param(hostUrl, "host") })).error, /seat is gone/);
    const staff = await server.client();
    assert.equal((await staff.ok("resume", { code, token: newKey })).role, "host");

    const inv = await command("cohost_link", code, { minutes: 5 });
    assert.equal(inv.ok, true);
    const mins = (Date.parse(inv.data.expiresAt) - Date.now()) / 60000;
    assert.ok(mins > 4.5 && mins < 5.1, `expires in ${mins} min`);
    const co = await server.client();
    const j = await co.ok("joinRoom", { code, role: "player", name: "Cora", cohost: param(inv.data.url, "cohost") });
    assert.equal(j.role, "cohost");
    assert.equal((await command("remove_cohost", code, { memberId: j.memberId })).ok, true);
    s = await co.waitFor((v) => v.you.role === "player");
    assert.ok(s.you.team !== null);
    assert.equal((await command("remove_cohost", code, { memberId: j.memberId })).ok, false);
  });

  test("first joiner hosts; any attach to the host seat closes the offer", async () => {
    const a = await createRoom({ kind: "venue", firstJoinerHosts: true });
    const first = await join(a.roomCode, "Ann");
    assert.equal(first.role, "host");
    const second = await join(a.roomCode, "Bob");
    assert.equal(second.role, "player");

    // Staff opening the host link first: the next phone is a player.
    const b = await createRoom({ kind: "venue", firstJoinerHosts: true });
    const staff = await server.client();
    await staff.ok("resume", { code: b.roomCode, token: param(b.hostUrl, "host") });
    const phone = await join(b.roomCode, "Cat");
    assert.equal(phone.role, "player");
  });

  test("status during a game, and players_changed", async () => {
    const { roomCode: code } = await createRoom();
    const ann = await connect(server.url);
    await ann.ok("joinRoom", { code, role: "player", name: "Ann" });
    const ev = await core.waitFor((e) => e.type === "players_changed" && e.roomCode === code, "players_changed", 5000);
    assert.equal(ev.data.players, 1);
    ann.socket.close();
    await command("end", code);
  });
});
