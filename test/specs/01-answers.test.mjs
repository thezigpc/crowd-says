// Answer matching, the profanity filter and pack parsing (the shared package, no server).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  answerKey,
  isProfane,
  keysMatch,
  parsePack,
  promptKey,
  rawKey,
  SAMPLE_PROMPTS,
  singular,
} from "@crowdsays/shared";

const same = (a, b) => keysMatch(answerKey(a), answerKey(b));

test("case, spaces, punctuation, articles and plurals don't matter", () => {
  assert.ok(same("Sunscreen", "sun screen"));
  assert.ok(same("the towels", "Towel!"));
  assert.ok(same("A beach ball", "beach balls"));
  assert.ok(same("my phone", "Phone"));
  assert.ok(same("Flip-flops", "flip flop"));
  assert.ok(same("ice cream", "Ice-Cream"));
});

test("singulars", () => {
  for (const [w, s] of [
    ["boxes", "box"],
    ["berries", "berry"],
    ["shoes", "shoe"],
    ["potatoes", "potato"],
    ["glasses", "glass"],
    ["children", "child"],
    ["knives", "knife"],
    ["bus", "bus"],
    ["chess", "chess"],
    ["cats", "cat"],
  ])
    assert.equal(singular(w), s, w);
});

test("the built-in synonyms group everyday words", () => {
  assert.ok(same("sunscreen", "sunblock"));
  assert.ok(same("Sun cream", "SPF"));
  assert.ok(same("couch", "sofa"));
  assert.ok(same("TV", "television"));
  assert.ok(same("cell phone", "smartphone"));
  assert.ok(!same("couch", "chair"));
});

test("typos are forgiven on longer words only", () => {
  assert.ok(same("sunscren", "sunscreen"));
  assert.ok(same("umbrela", "umbrella"));
  assert.ok(!same("hat", "cat"), "short words need to match exactly");
  assert.ok(!same("sand", "hand"));
});

test("a venue's merges and kept-apart keys", () => {
  const extra = { [rawKey("beach towel")]: rawKey("towel") };
  assert.equal(answerKey("beach towel", extra), answerKey("towel"));
  // A key mapped to itself was split out by a host: the built-in synonyms don't apply.
  const apart = { [rawKey("sunblock")]: rawKey("sunblock") };
  assert.notEqual(answerKey("sunblock", apart), answerKey("sunscreen", apart));
});

test("profanity: whole words and obvious stems, but not innocent words", () => {
  for (const bad of ["shit", "Sh1t", "f.u.c.k", "bullshit", "asshole", "what the fuck"]) assert.ok(isProfane(bad), bad);
  for (const ok of ["class", "Scunthorpe", "grass", "assassin", "cocktail", "sunscreen", "hello", "shoes"]) assert.ok(!isProfane(ok), ok);
});

test("packs: CSV with a header and quotes, JSON in three shapes", () => {
  const csv = parsePack('prompt,notes\n"Name a fruit, any fruit",x\nName a colour\n\nName a colour\n', "Mine");
  assert.deepEqual(csv, { name: "Mine", prompts: ["Name a fruit, any fruit", "Name a colour"] });
  assert.deepEqual(parsePack('["Name a dog breed", " Name a sport "]', "J").prompts, ["Name a dog breed", "Name a sport"]);
  assert.deepEqual(parsePack('[{"prompt":"Name a car"}]', "J").prompts, ["Name a car"]);
  const named = parsePack('{"name":"Friday","prompts":["Name a snack"]}', "J");
  assert.equal(named.name, "Friday");
  assert.throws(() => parsePack("[]", "x"), /No prompts/);
  assert.throws(() => parsePack("{oops", "x"), /JSON/);
  assert.throws(() => parsePack('{"prompts": 3}', "x"), /prompts/);
});

test("prompt keys ignore case and punctuation; the starter pack is clean and unique", () => {
  assert.equal(promptKey("Name a FRUIT."), promptKey("name a fruit"));
  assert.ok(SAMPLE_PROMPTS.length >= 40);
  assert.equal(new Set(SAMPLE_PROMPTS.map(promptKey)).size, SAMPLE_PROMPTS.length);
  for (const p of SAMPLE_PROMPTS) assert.ok(!isProfane(p), p);
});
