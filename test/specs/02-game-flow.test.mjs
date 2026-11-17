// A whole game over real sockets: answers, grouping, the board, strikes, a steal, rounds, the end.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { answerAll, setupRoom, sleep, startServer } from "../harness.mjs";

let server;
before(async () => (server = await startServer()));
after(async () => server.stop());

const TEAMS = [
  { name: "Ann", team: 0 },
  { name: "Bob", team: 0 },
  { name: "Cat", team: 1 },
  { name: "Dan", team: 1 },
  { name: "Eve", team: 1 },
];

test("a full game", async () => {
  const { host, players } = await setupRoom(server, TEAMS);
  const [ann, bob, cat, dan, eve] = players;

  // Lobby: settings, team names, the filter on team names.
  await host.ok("updateSettings", { boardSize: 3, strikes: 2, rounds: 2 });
  await host.ok("setTeamName", { team: 0, name: "Sharks" });
  assert.match((await host.emit("setTeamName", { team: 1, name: "Shit Kickers" })).error, /clean/);
  assert.match((await ann.emit("startGame")).error, /host/i, "players can't start");
  await host.ok("startGame");
  let s = await ann.waitFor((v) => v.phase === "answer", "answer phase");
  assert.equal(s.round, 1);
  assert.ok(s.prompt);
  assert.ok(s.deadline > s.serverTime);

  // Answers: one per phone, changeable, filtered.
  assert.match((await ann.emit("submitAnswer", { text: "shit" })).error, /clean/);
  assert.match((await ann.emit("submitAnswer", { text: "   " })).error, /Type/);
  await ann.ok("submitAnswer", { text: "Hat" });
  await ann.ok("submitAnswer", { text: "Sunscreen" });
  s = await host.waitFor((v) => v.answeredCount === 1, "one answer");
  assert.equal(s.playerCount, 5);
  await answerAll([bob, cat, dan, eve], ["sunblock", "Towel", "towels", "Umbrella"]);

  // Everyone answered: grouping, on the host's screen only.
  s = await host.waitFor((v) => v.phase === "group", "group phase");
  assert.equal(s.answerCount, 5);
  const label = (g) => g.label.toLowerCase();
  const byLabel = Object.fromEntries(s.groups.map((g) => [label(g), g]));
  assert.equal(byLabel.sunscreen.count, 2, "sunblock joined sunscreen");
  assert.equal(byLabel.towel.count, 2);
  assert.equal(byLabel.umbrella.count, 1);
  assert.equal((await ann.waitFor((v) => v.phase === "group")).groups, null, "players don't see the groups");

  // Merge, then split back out; rename; leave a group off and put it back.
  await host.ok("mergeGroups", { ids: [byLabel.towel.id, byLabel.umbrella.id] });
  s = await host.waitFor((v) => v.groups.length === 2, "merged");
  const towel = s.groups.find((g) => g.count === 3);
  assert.equal(towel.label, "Towel", "the bigger group keeps its label");
  const umbrella = towel.answers.find((a) => a.text === "Umbrella");
  await host.ok("splitAnswer", { answerId: umbrella.id });
  s = await host.waitFor((v) => v.groups.length === 3, "split");
  const tw = s.groups.find((g) => g.label === "Towel");
  // "Towel" and "towels" are one way of writing it (same key): one variant.
  assert.deepEqual(
    tw.answers.map((a) => [a.text, a.count]),
    [["Towel", 2]],
  );
  await host.ok("renameGroup", { groupId: tw.id, label: "Beach towel" });
  await host.ok("dropGroup", { groupId: tw.id, dropped: true });
  await host.ok("dropGroup", { groupId: tw.id, dropped: false });

  // The board goes up: most popular first; players see hidden slots, the host sees labels.
  await host.ok("goLive");
  s = await ann.waitFor((v) => v.phase === "guess", "guess phase");
  assert.equal(s.board.length, 3);
  assert.deepEqual(
    s.board.map((b) => [b.rank, b.revealed, b.label]),
    [
      [1, false, null],
      [2, false, null],
      [3, false, null],
    ],
  );
  assert.deepEqual(s.turn, { team: 0, guessing: 0, stealing: false, strikes: 0, bank: 0 });
  const hs = await host.waitFor((v) => v.phase === "guess");
  assert.deepEqual(
    hs.board.map((b) => [b.label, b.count]),
    [
      ["Sunscreen", 2],
      ["Beach towel", 2],
      ["Umbrella", 1],
    ],
  );

  // Team 0 guesses: the other team can't.
  assert.match((await cat.emit("guess", { text: "towel" })).error, /turn/);
  assert.equal((await ann.ok("guess", { text: "sun block" })).result, "hit");
  s = await cat.waitFor((v) => v.board[0].revealed, "slot 1 up");
  assert.deepEqual([s.board[0].label, s.board[0].count, s.board[0].by], ["Sunscreen", 2, 0]);
  assert.equal(s.turn.bank, 2);
  assert.match((await ann.emit("guess", { text: "hat" })).error, /Slow down/, "a phone's guesses are spaced out");
  assert.equal((await bob.ok("guess", { text: "Sunscreen" })).result, "repeat", "no strike for a repeat");
  await sleep(1600);
  assert.equal((await bob.ok("guess", { text: "hat" })).result, "miss");
  s = await host.waitFor((v) => v.turn.strikes === 1, "one strike");
  // The host types a spoken guess: second strike, steal to team 1.
  assert.equal((await host.ok("hostGuess", { text: "chair" })).result, "miss");
  s = await cat.waitFor((v) => v.turn.stealing, "steal");
  assert.equal(s.turn.guessing, 1);
  assert.match((await ann.emit("guess", { text: "towel" })).error, /turn/);
  // The steal: "towels" matches the renamed group.
  assert.equal((await cat.ok("guess", { text: "towels" })).result, "hit");
  s = await ann.waitFor((v) => v.phase === "roundEnd", "round end");
  assert.equal(s.roundWinner, 1);
  assert.equal(s.roundPoints, 4);
  assert.deepEqual(
    s.teams.map((t) => t.score),
    [0, 4],
  );
  assert.ok(s.board.every((b) => b.revealed && b.label), "the whole board shows at the end");
  assert.equal(s.board[2].by, null, "shown, not won");
  assert.deepEqual(
    s.log.map((g) => [g.team, g.result, g.steal]),
    [
      [0, "hit", false],
      [0, "repeat", false],
      [0, "miss", false],
      [0, "miss", false],
      [1, "hit", true],
    ],
  );

  // Round 2 (the last): the starting team alternates; End game mid-round.
  await host.ok("nextRound");
  s = await ann.waitFor((v) => v.phase === "answer" && v.round === 2, "round 2");
  assert.equal(s.myAnswer, null, "answers reset");
  const firstPrompt = s.prompt;
  await host.ok("skipPrompt");
  s = await ann.waitFor((v) => v.prompt !== firstPrompt, "new prompt");
  assert.equal(s.round, 2, "a different prompt keeps the round");
  await host.ok("setPrompt", { text: "Name something you'd find in a bar." });
  await ann.waitFor((v) => v.prompt === "Name something you'd find in a bar.", "own prompt");
  await host.ok("extendTimer");
  await host.ok("endGame");
  s = await ann.waitFor((v) => v.phase === "gameOver", "game over");
  assert.deepEqual(s.winners, [1]);
  assert.match((await host.emit("nextRound")).error, /over/);

  // New game with the same teams.
  await host.ok("playAgain");
  s = await ann.waitFor((v) => v.phase === "lobby", "lobby");
  assert.deepEqual(
    s.teams.map((t) => t.score),
    [0, 0],
  );
  assert.equal(s.teams[0].name, "Sharks");
});

test("a team clears the board, the host reveals and strikes, and the round ends on time", async () => {
  const { host, players } = await setupRoom(server, [
    { name: "Ann", team: 0 },
    { name: "Bob", team: 1 },
  ]);
  const [ann, bob] = players;
  await host.ok("updateSettings", { boardSize: 3, rounds: 1, strikes: 1 });
  await host.ok("startGame");
  await answerAll([ann, bob], ["dog", "cat"]);
  await host.waitFor((v) => v.phase === "group");
  await host.ok("goLive");
  let s = await host.waitFor((v) => v.phase === "guess");
  assert.equal(s.board.length, 2);
  // The host reveals the slot the team called out.
  await host.ok("revealSlot", { rank: 1 });
  assert.match((await host.emit("revealSlot", { rank: 1 })).error, /didn't work/);
  assert.equal((await ann.ok("guess", { text: s.board[1].label })).result, "hit");
  s = await bob.waitFor((v) => v.phase === "roundEnd", "cleared");
  assert.equal(s.roundWinner, 0);
  assert.equal(s.roundPoints, 2);
  // Last round: next is the final scores.
  await host.ok("nextRound");
  s = await bob.waitFor((v) => v.phase === "gameOver");
  assert.deepEqual(s.winners, [0]);

  // Strike from the host with 1 strike allowed: straight to the steal; a missed steal pays the team in control.
  await host.ok("startGame");
  await answerAll([ann, bob], ["sun", "sand"]);
  await host.waitFor((v) => v.phase === "group" && v.round === 1);
  await host.ok("goLive");
  await host.ok("revealSlot", { rank: 1 });
  await host.ok("addStrike");
  s = await host.waitFor((v) => v.turn?.stealing, "steal");
  await host.ok("addStrike");
  s = await host.waitFor((v) => v.phase === "roundEnd", "missed steal");
  assert.equal(s.roundWinner, 0);
  assert.equal(s.teams[0].score, 1);
});

test("teams: picking, moving, resizing; filter off lets anything through", async () => {
  const { host, players } = await setupRoom(server, [{ name: "Ann" }, { name: "Bob" }, { name: "Cat" }]);
  let s = await host.waitFor((v) => v.playerCount === 3);
  assert.deepEqual(
    s.teams.map((t) => t.players.length),
    [2, 1],
    "no pick: the smallest team",
  );
  await players[0].ok("chooseTeam", { team: 1 });
  await host.ok("updateSettings", { teamCount: 4 });
  s = await host.waitFor((v) => v.teams.length === 4);
  assert.equal(s.teams[3].name, "Gold Team");
  await host.ok("movePlayer", { memberId: s.teams[1].players[0].id, team: 3 });
  await host.ok("updateSettings", { teamCount: 2 });
  s = await host.waitFor((v) => v.teams.length === 2);
  assert.equal(s.teams.reduce((n, t) => n + t.players.length, 0), 3, "nobody lost");
  assert.match((await host.emit("updateSettings", { boardSize: 99 })).error, /didn't work/);

  await host.ok("updateSettings", { profanityFilter: false });
  await host.ok("startGame");
  assert.match((await host.emit("updateSettings", { teamCount: 3 })).error, /right now/, "teams are fixed mid-game");
  await players[0].ok("submitAnswer", { text: "shit" });
  assert.match((await players[0].emit("chooseTeam", { team: 0 })).error, /right now/);
});
