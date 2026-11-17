// Small rooms mix in answers saved from earlier games at this venue (same prompt), with the
// earlier hosts' grouping. Venue-local: they live in DATA_DIR and survive a restart.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { answerAll, setupRoom, sleep, startServer } from "../harness.mjs";

let server;
let dataDir;
after(async () => {
  await server?.stop();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

const PROMPT = "Name a pet.";

test("answers are saved per prompt, with the host's merges, and mixed into a small room after a restart", async () => {
  server = await startServer();
  dataDir = server.dataDir;
  {
    const { host, players } = await setupRoom(server, [
      { name: "Ann", team: 0 },
      { name: "Bob", team: 0 },
      { name: "Cat", team: 1 },
      { name: "Dan", team: 1 },
      { name: "Eve", team: 1 },
    ]);
    await host.ok("updateSettings", { profanityFilter: false });
    await host.ok("startGame");
    await host.ok("setPrompt", { text: PROMPT });
    await answerAll(players, ["Dog", "dog", "Cat", "Hamster", "shit"]);
    let s = await host.waitFor((v) => v.phase === "group");
    assert.equal(s.savedAvailable, 0, "this round's own answers don't count");
    assert.match((await host.emit("mixSaved")).error, /no saved answers/i);
    // The host decides hamsters count as cats (for this prompt).
    const g = (label) => s.groups.find((x) => x.label === label);
    await host.ok("mergeGroups", { ids: [g("Cat").id, g("Hamster").id] });
    await host.ok("goLive");
  }
  await sleep(300);
  const saved = JSON.parse(readFileSync(path.join(dataDir, "answers.json"), "utf8"));
  const entry = Object.values(saved.prompts)[0];
  assert.equal(entry.prompt, PROMPT);
  assert.deepEqual(entry.answers, ["Dog", "dog", "Cat", "Hamster", "shit"]);
  assert.deepEqual(entry.merges, { hamster: "cat" });
  assert.ok(!JSON.stringify(saved).includes("Ann"), "no names are kept");

  await server.stop({ keepData: true });
  server = await startServer({}, dataDir);

  const { host, players } = await setupRoom(server, [
    { name: "Fay", team: 0 },
    { name: "Gus", team: 1 },
  ]);
  await host.ok("startGame");
  await host.ok("setPrompt", { text: "name a PET" });
  await answerAll(players, ["Parrot", "hamsters"]);
  let s = await host.waitFor((v) => v.phase === "group");
  assert.equal(s.liveAnswerCount, 2);
  assert.deepEqual(
    s.groups.map((g) => g.label),
    ["Parrot", "Hamsters"],
  );
  assert.equal(s.savedAvailable, 4, "the profane one stays out while the filter is on");
  assert.equal((await host.ok("mixSaved")).added, 4);
  s = await host.waitFor((v) => v.mixedIn);
  assert.equal(s.answerCount, 6);
  assert.equal(s.savedAvailable, 0);
  const byLabel = Object.fromEntries(s.groups.map((g) => [g.label, g]));
  assert.equal(byLabel.Dog.count, 2);
  assert.ok(byLabel.Dog.answers.every((a) => a.saved));
  // The saved merge put "Cat" with the live "hamsters" (and the old "Hamster").
  const pets = s.groups.find((g) => g.answers.some((a) => a.text === "Cat"));
  assert.equal(pets.count, 3);
  assert.ok(pets.answers.some((a) => a.text === "Hamsters" && !a.saved));
  assert.match((await host.emit("mixSaved")).error, /already/);
  await host.ok("goLive");
  s = await players[0].waitFor((v) => v.phase === "guess");
  assert.equal(s.board.length, 3);
});

test("big rooms can't mix in saved answers", async () => {
  const names = ["A", "B", "C", "D", "E", "F", "G", "H"].map((n, i) => ({ name: `P${n}`, team: i % 2 }));
  const { host, players } = await setupRoom(server, names);
  await host.ok("startGame");
  await host.ok("setPrompt", { text: PROMPT });
  await answerAll(players, ["dog", "cat", "fish", "bird", "dog", "cat", "rabbit", "snake"]);
  const s = await host.waitFor((v) => v.phase === "group");
  assert.equal(s.liveAnswerCount, 8);
  assert.match((await host.emit("mixSaved")).error, /small rooms/);
});

test("a split is remembered: next time those answers stay apart", async () => {
  const { host, players } = await setupRoom(server, [
    { name: "Ida", team: 0 },
    { name: "Jo", team: 1 },
    { name: "Kim", team: 1 },
  ]);
  await host.ok("startGame");
  await host.ok("setPrompt", { text: "Name something for a sunny day." });
  await answerAll(players, ["sunscreen", "sunscreen", "sunblock"]);
  let s = await host.waitFor((v) => v.phase === "group");
  assert.equal(s.groups.length, 1, "built-in synonyms");
  const sunblock = s.groups[0].answers.find((a) => a.text === "Sunblock");
  await host.ok("splitAnswer", { answerId: sunblock.id });
  s = await host.waitFor((v) => v.groups.length === 2);
  await host.ok("goLive");
  await host.ok("endGame");
  await host.ok("startGame");
  await host.ok("setPrompt", { text: "Name something for a sunny day." });
  await answerAll(players, ["sunscreen", "Sunblock", "sun block"]);
  s = await host.waitFor((v) => v.phase === "group" && v.round === 1);
  assert.deepEqual(
    s.groups.map((g) => [g.label, g.count]),
    [
      ["Sunscreen", 1],
      ["Sunblock", 2],
    ],
  );
});
