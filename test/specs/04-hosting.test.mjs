// Co-hosts (single-use invites), take-overs, reconnecting, leaving and kicking.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupRoom, startServer } from "../harness.mjs";

let server;
before(async () => (server = await startServer()));
after(async () => server.stop());

const inviteToken = (path) => new URL(path, "http://x").searchParams.get("cohost");

test("a co-host invite works once; co-hosts run the game but can't end the room or remove anyone", async () => {
  const { code, host, players } = await setupRoom(server, [{ name: "Ann", team: 0 }]);
  const inv = await host.ok("cohostInvite");
  assert.match(inv.path, new RegExp(`^/join/${code}\\?cohost=`));
  assert.ok(Date.parse(inv.expiresAt) > Date.now());
  assert.match((await players[0].emit("cohostInvite")).error, /host/i);

  const co = await server.client();
  const joined = await co.ok("joinRoom", { code, role: "player", name: "Cora", cohost: inviteToken(inv.path) });
  assert.equal(joined.role, "cohost");
  const again = await server.client();
  assert.match((await again.emit("joinRoom", { code, role: "player", name: "Dee", cohost: inviteToken(inv.path) })).error, /already used/);

  let s = await co.waitFor((v) => v.you.role === "cohost");
  assert.equal(s.you.canRun, true);
  assert.equal(s.you.team, null, "co-hosts aren't on a team");
  await co.ok("updateSettings", { rounds: 3 });
  await co.ok("startGame");
  await co.ok("closeAnswers");
  assert.match((await co.emit("closeRoom")).error, /host/i);
  assert.match((await co.emit("kickPlayer", s.teams[0].players[0].id)).error, /host/i);

  // The host makes them a player again.
  s = await host.waitFor((v) => v.cohosts.length === 1);
  await host.ok("removeCohost", s.cohosts[0].id);
  s = await co.waitFor((v) => v.you.role === "player");
  assert.equal(s.you.canRun, false);
  assert.ok(s.you.team !== null);
  assert.ok(co.notices.some((n) => /not a co-host/.test(n)));
  // A player already in the room can be promoted with an invite (and keeps their seat).
  const inv2 = await host.ok("cohostInvite");
  const p = players[0];
  const promoted = await p.ok("joinRoom", { code, role: "player", token: p.token, cohost: inviteToken(inv2.path) });
  assert.equal(promoted.role, "cohost");
});

test("reconnecting resumes the same seat; leaving and kicking", async () => {
  const { code, host, players } = await setupRoom(server, [
    { name: "Ann", team: 0 },
    { name: "Bob", team: 1 },
  ]);
  const [ann, bob] = players;
  // A new socket with Ann's token: the same seat, no second Ann.
  ann.socket.close();
  const ann2 = await server.client();
  const r = await ann2.ok("resume", { code, token: ann.token });
  assert.equal(r.name, "Ann");
  let s = await host.waitFor((v) => v.playerCount === 2 && v.teams[0].players[0].connected);
  assert.match((await (await server.client()).emit("resume", { code, token: "nope" })).error, /seat is gone/);
  assert.match((await (await server.client()).emit("joinRoom", { code, role: "player", name: "ann" })).error, /already has that name/);

  await bob.ok("leaveRoom");
  s = await host.waitFor((v) => v.playerCount === 1);
  await host.ok("kickPlayer", s.teams[0].players[0].id);
  for (let i = 0; i < 40 && !ann2.closedReason; i++) await new Promise((r) => setTimeout(r, 25));
  assert.match(ann2.closedReason ?? "", /removed you/);
  // The host leaving ends the room for everyone.
  const tv = await server.client();
  await tv.ok("joinRoom", { code, role: "table" });
  await host.ok("leaveRoom");
  for (let i = 0; i < 40 && !tv.closedReason; i++) await new Promise((r) => setTimeout(r, 25));
  assert.match(tv.closedReason, /host ended/);
});

test("the TV joins display-only and gets the full state", async () => {
  const { code, host } = await setupRoom(server, [{ name: "Ann", team: 0 }]);
  const tv = await server.client();
  const j = await tv.ok("joinRoom", { code, role: "table" });
  assert.equal(j.role, "table");
  const s = await tv.waitFor((v) => v.code === code);
  assert.equal(s.you.canRun, false);
  assert.equal(s.teams[0].players[0].name, "Ann");
  assert.match((await tv.emit("startGame")).error, /host/i);
  assert.match((await tv.emit("submitAnswer", { text: "x" })).error, /players/i);
  await host.ok("startGame");
  await tv.waitFor((v) => v.phase === "answer");
});
