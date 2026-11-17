// Answers saved from earlier games at this venue (DATA_DIR/answers.json), filed by prompt.
// Small rooms can mix them in. Venue-local only: nothing here leaves the server. Kept with
// each prompt too: the host's merges and splits, so the next game groups the same way.
// No names are kept, only the answers' text.

import { log } from "@bargames/gamekit/server";
import { promptKey, type KeyMap } from "@crowdsays/shared";
import { store } from "../config.js";

const FILE = "answers.json";
export const MAX_PROMPTS_SAVED = 1000;
export const MAX_ANSWERS_PER_PROMPT = 300;
export const MAX_MERGES_PER_PROMPT = 300;

interface PromptEntry {
  prompt: string;
  answers: string[];
  merges: KeyMap;
  updatedAt: number;
}

interface SavedFile {
  prompts: Record<string, PromptEntry>;
}

const isSavedFile = (v: unknown): v is SavedFile =>
  !!v && typeof v === "object" && !!(v as SavedFile).prompts && typeof (v as SavedFile).prompts === "object";

let prompts: Record<string, PromptEntry> = {};
let writing: Promise<void> = Promise.resolve();

export async function initSaved(): Promise<void> {
  const r = await store.readResult<SavedFile>(FILE, isSavedFile);
  prompts = {};
  if (r.kind !== "ok") return;
  for (const [k, e] of Object.entries(r.value.prompts)) {
    if (!e || typeof e.prompt !== "string" || !Array.isArray(e.answers)) continue;
    prompts[k] = {
      prompt: e.prompt,
      answers: e.answers.filter((a): a is string => typeof a === "string"),
      merges: e.merges && typeof e.merges === "object" ? e.merges : {},
      updatedAt: Number(e.updatedAt) || 0,
    };
  }
}

/** Writes in order, never two at once; a failed write is logged, not thrown. */
function persist(): void {
  const snapshot: SavedFile = { prompts: structuredClone(prompts) };
  writing = writing
    .then(() => store.write(FILE, snapshot))
    .catch((err) => log.error("saved", "couldn't save answers", { err: String(err) }));
}

/** Waits for pending writes (shutdown). */
export const flushSaved = (): Promise<void> => writing;

function entry(prompt: string): PromptEntry {
  const k = promptKey(prompt);
  let e = prompts[k];
  if (!e) {
    const keys = Object.keys(prompts);
    if (keys.length >= MAX_PROMPTS_SAVED) {
      // Make room: drop the prompt used longest ago.
      const oldest = keys.reduce((a, b) => (prompts[a].updatedAt <= prompts[b].updatedAt ? a : b));
      delete prompts[oldest];
    }
    e = prompts[k] = { prompt, answers: [], merges: {}, updatedAt: Date.now() };
  }
  return e;
}

/** What earlier games at this venue said for this prompt, and how their hosts grouped it. */
export function savedFor(prompt: string): { answers: string[]; merges: KeyMap } {
  const e = prompts[promptKey(prompt)];
  return e ? { answers: [...e.answers], merges: { ...e.merges } } : { answers: [], merges: {} };
}

/** Keeps this round's answers (newest last, capped). */
export function saveAnswers(prompt: string, answers: string[]): void {
  if (!answers.length) return;
  const e = entry(prompt);
  e.answers = [...e.answers, ...answers].slice(-MAX_ANSWERS_PER_PROMPT);
  e.updatedAt = Date.now();
  persist();
}

/** The host's grouping for this prompt: key → key (a key to itself: keep apart); null removes one. */
export function saveMerges(prompt: string, changes: Record<string, string | null>): void {
  const keys = Object.keys(changes);
  if (!keys.length) return;
  const e = entry(prompt);
  const merges: KeyMap = { ...e.merges };
  for (const k of keys) {
    const v = changes[k];
    if (v === null) delete merges[k];
    else merges[k] = v;
  }
  const all = Object.keys(merges);
  for (const k of all.slice(0, Math.max(0, all.length - MAX_MERGES_PER_PROMPT))) delete merges[k];
  e.merges = merges;
  e.updatedAt = Date.now();
  persist();
}

export function savedSummary(): { prompts: number; answers: number } {
  const list = Object.values(prompts);
  return { prompts: list.length, answers: list.reduce((n, e) => n + e.answers.length, 0) };
}

export function clearSaved(): void {
  prompts = {};
  persist();
}
