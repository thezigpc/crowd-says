// The admin page's API: sign-in, rooms, prompt packs (CSV/JSON uploads) and saved answers.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { answerAll, setupRoom, sleep, startServer } from "../harness.mjs";

let server;
let token = "";
before(async () => (server = await startServer()));
after(async () => server.stop());

const api = async (path, { method = "GET", body, auth = true } = {}) => {
  const res = await fetch(`${server.url}/api/admin${path}`, {
    method,
    headers: { "content-type": "application/json", ...(auth && token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

test("first-run setup, then sign-in; everything else needs it", async () => {
  assert.equal((await api("/overview", { auth: false })).status, 401);
  const st = await api("/status");
  assert.equal(st.body.setupNeeded, true);
  const setup = await api("/setup", { method: "POST", body: { password: "correct horse" } });
  assert.equal(setup.status, 200);
  token = setup.body.token;
  const o = await api("/overview");
  assert.equal(o.status, 200);
  assert.deepEqual(o.body.rooms, []);
  assert.equal(o.body.packs[0].id, "sample");
  assert.deepEqual(o.body.saved, { prompts: 0, answers: 0 });
});

test("packs: a big CSV upload, a JSON one, bad ones refused; a room plays from a venue pack", async () => {
  const lines = ["prompt", ...Array.from({ length: 600 }, (_, i) => `Name thing number ${i + 1} that you'd see at the venue`)];
  const csv = lines.join("\r\n");
  assert.ok(csv.length > 16 * 1024, "bigger than the admin router's own body limit");
  const up = await api("/packs", { method: "POST", body: { name: "Big pack", text: csv } });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.pack.prompts, 600);

  const json = await api("/packs", { method: "POST", body: { name: "ignored", text: JSON.stringify({ name: "Tiny", prompts: ["Name a lucky number."] }) } });
  assert.equal(json.body.pack.name, "Tiny");
  assert.equal((await api("/packs", { method: "POST", body: { text: "" } })).status, 400);
  assert.match((await api("/packs", { method: "POST", body: { text: "[1," } })).body.error, /JSON/);

  const o = await api("/overview");
  assert.deepEqual(
    o.body.packs.map((p) => [p.name, p.prompts, p.builtIn]).slice(1),
    [
      ["Big pack", 600, false],
      ["Tiny", 1, false],
    ],
  );
  const tiny = o.body.packs.find((p) => p.name === "Tiny");
  assert.deepEqual((await api(`/packs/${tiny.id}`)).body.pack.prompts, ["Name a lucky number."]);

  // A host picks the venue's pack.
  const { host, players } = await setupRoom(server, [{ name: "Ann", team: 0 }]);
  let s = await host.waitFor((v) => v.packs.length === 3);
  await host.ok("updateSettings", { packId: tiny.id });
  assert.match((await host.emit("updateSettings", { packId: "nope" })).error, /didn't work/);
  await host.ok("startGame");
  s = await players[0].waitFor((v) => v.phase === "answer");
  assert.equal(s.prompt, "Name a lucky number.");
  assert.deepEqual(s.packs, [], "players don't get the pack list");

  // Deleting a pack mid-game falls back to the starter pack for the next prompt.
  assert.equal((await api(`/packs/${tiny.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await api(`/packs/${tiny.id}`, { method: "DELETE" })).status, 404);
  await host.ok("skipPrompt");
  s = await players[0].waitFor((v) => v.prompt !== "Name a lucky number.");
  assert.ok(s.prompt);
});

test("rooms, saved answers, settings", async () => {
  const { code, host, players } = await setupRoom(server, [{ name: "Bea", team: 0 }]);
  await host.ok("startGame");
  await answerAll(players, ["Seven"]);
  await host.waitFor((v) => v.phase === "group");
  await sleep(200);
  let o = await api("/overview");
  assert.ok(o.body.saved.answers >= 1);
  const room = o.body.rooms.find((r) => r.code === code);
  assert.equal(room.phase, "group");
  assert.equal(room.players, 1);

  assert.equal((await api("/saved", { method: "DELETE" })).status, 200);
  o = await api("/overview");
  assert.deepEqual(o.body.saved, { prompts: 0, answers: 0 });

  assert.equal((await api("/settings", { method: "PUT", body: { roomIdleMinutes: 1 } })).status, 400);
  assert.equal((await api("/settings", { method: "PUT", body: { roomIdleMinutes: 30 } })).body.settings.roomIdleMinutes, 30);

  assert.equal((await api(`/rooms/${code}/close`, { method: "POST" })).status, 200);
  for (let i = 0; i < 40 && !players[0].closedReason; i++) await sleep(25);
  assert.match(players[0].closedReason, /administrator/);
});
