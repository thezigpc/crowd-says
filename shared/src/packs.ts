// Prompt packs: the original starter pack, and the venue's own packs (CSV or JSON) parsed here
// for the admin upload. The crowd writes every answer board; packs are prompts only.

import { MAX_PROMPT_LENGTH } from "./protocol.js";

export const SAMPLE_PACK_ID = "sample";
export const SAMPLE_PACK_NAME = "Crowd Says starter pack";
export const MAX_PACK_PROMPTS = 1000;

/** Written for Crowd Says. */
export const SAMPLE_PROMPTS: string[] = [
  "Name something you bring to the beach.",
  "Name a snack you'd order at a bar.",
  "Name something people lose all the time.",
  "Name a job you'd be terrible at.",
  "Name something that's always in a junk drawer.",
  "Name a good reason to leave a party early.",
  "Name a sound that wakes you up at night.",
  "Name something you'd find in a car's glovebox.",
  "Name a word that describes this place tonight.",
  "Name a pizza topping that starts arguments.",
  "Name something you'd pack for a camping trip.",
  "Name an excuse for being late to work.",
  "Name something people do while stuck in traffic.",
  "Name a thing you'd grab on your way out of a fire drill.",
  "Name a smell that reminds you of being a kid.",
  "Name a board game everybody knows.",
  "Name something that comes in a pair.",
  "Name a superpower that would help on a Monday.",
  "Name a place people hide a spare key.",
  "Name something you'd see at a wedding reception.",
  "Name a chore nobody wants to do.",
  "Name something that's hard to do with gloves on.",
  "Name an animal you'd want as a sidekick.",
  "Name something fans shout at a game.",
  "Name a reason a phone battery runs out.",
  "Name something you'd put on a hot dog.",
  "Name a gift that's easy to buy at the last minute.",
  "Name something people collect.",
  "Name the first thing you do after waking up.",
  "Name a kind of weather that ruins plans.",
  "Name something you'd see at a county fair.",
  "Name a landmark people take selfies with.",
  "Name a breakfast food.",
  "Name something that's always sticky.",
  "Name something you'd find in a grandparent's house.",
  "Name a reason to call in sick.",
  "Name a drink you'd order at a coffee shop.",
  "Name an instrument you'd learn if you had the time.",
  "Name something that makes a good first date.",
  "Name a holiday tradition.",
  "Name a thing you'd never lend to a friend.",
  "Name a fruit you'd put in a cocktail.",
  "Name something people forget to pack.",
  "Name a dance move everyone knows.",
  "Name the room in a house where people hang out.",
  "Name something you'd see at an airport.",
  "Name a good name for a goldfish.",
  "Name a food that's better cold.",
  "Name something you can't do quietly.",
  "Name a song everyone sings along to.",
];

export interface ParsedPack {
  name: string;
  prompts: string[];
}

/** A prompt cleaned for storage: single spaces, length-capped. Empty: not a prompt. */
export function cleanPrompt(s: unknown): string {
  if (typeof s !== "string") return "";
  return s.replace(/\s+/g, " ").trim().slice(0, MAX_PROMPT_LENGTH);
}

/** The first field of one CSV line ("quoted, with commas" and "" escapes handled). */
function firstCsvField(line: string): string {
  const t = line.trim();
  if (!t.startsWith('"')) return t.split(",")[0];
  let out = "";
  for (let i = 1; i < t.length; i++) {
    if (t[i] === '"') {
      if (t[i + 1] === '"') {
        out += '"';
        i++;
      } else break;
    } else out += t[i];
  }
  return out;
}

function promptsFrom(list: unknown[]): string[] {
  return list.map((p) => cleanPrompt(typeof p === "object" && p ? (p as { prompt?: unknown }).prompt : p));
}

/**
 * A venue's pack from an upload. JSON: ["prompt", …], [{ "prompt": "…" }, …] or
 * { "name": "…", "prompts": [ … ] }. Anything else is read as CSV: one prompt per line, the
 * first column only, an optional "prompt" header row. Duplicates and blanks are dropped.
 * Throws an Error with a readable message when nothing usable is in it.
 */
export function parsePack(text: string, fallbackName: string): ParsedPack {
  const body = text.replace(/^﻿/, "").trim();
  let name = fallbackName;
  let prompts: string[];
  if (body.startsWith("[") || body.startsWith("{")) {
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      throw new Error("That file looks like JSON but couldn't be read. Check its brackets and quotes.");
    }
    if (Array.isArray(data)) prompts = promptsFrom(data);
    else {
      const o = data as { name?: unknown; prompts?: unknown };
      if (!Array.isArray(o.prompts)) throw new Error('A JSON pack needs a "prompts" list.');
      if (typeof o.name === "string" && o.name.trim()) name = o.name;
      prompts = promptsFrom(o.prompts);
    }
  } else {
    const lines = body.split(/\r?\n/).map(firstCsvField).map(cleanPrompt);
    if (lines[0] && /^prompts?$/i.test(lines[0])) lines.shift();
    prompts = lines;
  }
  const seen = new Set<string>();
  const unique = prompts.filter((p) => {
    const k = p.toLowerCase();
    if (!p || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!unique.length) throw new Error("No prompts found. Put one prompt per line (CSV) or a JSON list.");
  if (unique.length > MAX_PACK_PROMPTS) throw new Error(`A pack can hold up to ${MAX_PACK_PROMPTS} prompts.`);
  return { name: name.replace(/\s+/g, " ").trim().slice(0, 60) || "Untitled pack", prompts: unique };
}

/** Saved answers are filed under this key, so "Name a fruit." and "name a fruit" share them. */
export function promptKey(prompt: string): string {
  return prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
