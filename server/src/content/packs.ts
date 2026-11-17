// Prompt packs: the built-in starter pack plus the venue's own packs (DATA_DIR/packs.json),
// uploaded as CSV or JSON on the admin page.

import { log, newId } from "@bargames/gamekit/server";
import { parsePack, SAMPLE_PACK_ID, SAMPLE_PACK_NAME, SAMPLE_PROMPTS, type PackSummary } from "@crowdsays/shared";
import { store } from "../config.js";

const FILE = "packs.json";
export const MAX_PACKS = 50;

export interface VenuePack {
  id: string;
  name: string;
  prompts: string[];
  createdAt: string;
}

interface PacksFile {
  packs: VenuePack[];
}

const isPacksFile = (v: unknown): v is PacksFile =>
  !!v && typeof v === "object" && Array.isArray((v as PacksFile).packs);

let packs: VenuePack[] = [];

export async function initPacks(): Promise<void> {
  const r = await store.readResult<PacksFile>(FILE, isPacksFile);
  packs =
    r.kind === "ok"
      ? r.value.packs.filter(
          (p) => typeof p?.id === "string" && typeof p.name === "string" && Array.isArray(p.prompts) && p.prompts.length > 0,
        )
      : [];
}

const save = () => store.write(FILE, { packs } satisfies PacksFile);

/** Every pack a host can pick, the starter pack first. */
export function packList(): PackSummary[] {
  return [
    { id: SAMPLE_PACK_ID, name: SAMPLE_PACK_NAME, prompts: SAMPLE_PROMPTS.length, builtIn: true },
    ...packs.map((p) => ({ id: p.id, name: p.name, prompts: p.prompts.length, builtIn: false })),
  ];
}

export const hasPack = (id: string): boolean => id === SAMPLE_PACK_ID || packs.some((p) => p.id === id);

/** A pack's prompts; the starter pack when the id is unknown (a pack deleted mid-game). */
export function packPrompts(id: string): string[] {
  return packs.find((p) => p.id === id)?.prompts ?? SAMPLE_PROMPTS;
}

export const getPack = (id: string): VenuePack | undefined => packs.find((p) => p.id === id);

/** Adds a pack from an upload. Throws an Error with a readable message. */
export async function addPack(text: string, name: string): Promise<VenuePack> {
  if (packs.length >= MAX_PACKS) throw new Error(`There are already ${MAX_PACKS} packs. Delete one first.`);
  const parsed = parsePack(text, name || "Venue pack");
  const pack: VenuePack = { id: newId(), name: parsed.name, prompts: parsed.prompts, createdAt: new Date().toISOString() };
  packs = [...packs, pack];
  await save();
  log.info("admin", "pack added", { id: pack.id, prompts: pack.prompts.length });
  return pack;
}

export async function removePack(id: string): Promise<boolean> {
  const before = packs.length;
  packs = packs.filter((p) => p.id !== id);
  if (packs.length === before) return false;
  await save();
  return true;
}
