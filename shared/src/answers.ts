// Answer matching: turns what people typed into keys, so "Sunscreen", "sun screen",
// "sunblock" and "the sunscreens" all land in one group. Used by the server to group answers
// and to match guesses against the board, and by tests.

/** Lowercase, accents and punctuation gone, "&" as "and", single spaces. */
export function normalizeText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Leading filler words that don't change the answer ("a towel", "my phone"). */
const LEADING = new Set(["a", "an", "the", "some", "my", "your", "his", "her", "their", "our", "lots", "of", "many"]);

const IRREGULAR: Record<string, string> = {
  children: "child",
  people: "person",
  men: "man",
  women: "woman",
  feet: "foot",
  teeth: "tooth",
  mice: "mouse",
  geese: "goose",
  knives: "knife",
  wives: "wife",
  lives: "life",
  leaves: "leaf",
  loaves: "loaf",
  shelves: "shelf",
  wolves: "wolf",
  halves: "half",
  calves: "calf",
  dice: "die",
};
/** Words ending in "oes" whose singular ends in "oe". */
const OE = new Set(["shoes", "toes", "canoes", "hoes", "foes", "oboes"]);
/** Words that only look plural. */
const KEEP = new Set(["news", "series", "species", "chess", "glass", "gas", "bus", "yes", "this", "is", "was", "his", "its", "us", "plus", "less", "dress", "boss", "pass", "kiss", "mess", "class", "grass"]);

/** A rough English singular, applied the same way to both sides of every comparison. */
export function singular(w: string): string {
  if (w.length < 3 || KEEP.has(w)) return w;
  if (IRREGULAR[w]) return IRREGULAR[w];
  if (/(ss|us|is)$/.test(w)) return w;
  if (OE.has(w)) return w.slice(0, -1);
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (/(ch|sh|x|z|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("oes")) return w.slice(0, -2);
  if (w.endsWith("s")) return w.slice(0, -1);
  return w;
}

/** The words that matter, singular, leading filler dropped. */
export function answerWords(s: string): string[] {
  const words = normalizeText(s).split(" ").filter(Boolean);
  while (words.length > 1 && LEADING.has(words[0])) words.shift();
  return words.map(singular);
}

/** The compact key two answers share when they're "the same": "sun screen" = "sunscreen". */
export function rawKey(s: string): string {
  return answerWords(s).join("");
}

/**
 * A small built-in synonym list (the host merges anything else by hand). Each group's first
 * entry is the canonical one. Generic everyday words only: Crowd Says ships no survey data.
 */
export const SYNONYMS: string[][] = [
  ["sunscreen", "sunblock", "suntan lotion", "sun cream", "sun lotion", "spf"],
  ["tv", "television", "telly"],
  ["couch", "sofa"],
  ["soda", "pop", "soft drink"],
  ["phone", "cell phone", "cellphone", "mobile", "mobile phone", "smartphone", "iphone"],
  ["car", "automobile"],
  ["sneakers", "trainers", "running shoes", "tennis shoes"],
  ["bathroom", "restroom", "washroom", "loo"],
  ["mom", "mum", "mother", "mommy", "mummy"],
  ["dad", "father", "daddy"],
  ["kid", "child", "kiddo"],
  ["refrigerator", "fridge"],
  ["bike", "bicycle"],
  ["sunglasses", "shades", "sunnies"],
  ["hamburger", "burger"],
  ["pants", "trousers"],
  ["sweater", "jumper", "pullover"],
  ["vacation", "holiday"],
  ["movie", "film"],
  ["money", "cash"],
  ["dog", "puppy", "doggy", "doggo"],
  ["cat", "kitty", "kitten"],
  ["french fries", "fries"],
  ["flip flops", "thongs"],
  ["swimsuit", "bathing suit", "swimming costume", "swimwear", "swim trunks"],
  ["beer", "brew", "brewski"],
  ["coffee", "cup of coffee", "joe"],
  ["laptop", "notebook computer"],
  ["headphones", "earphones", "earbuds"],
  ["wallet", "billfold"],
];

const BUILT_IN: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const group of SYNONYMS) {
    const canon = rawKey(group[0]);
    for (const w of group) m.set(rawKey(w), canon);
  }
  return m;
})();

/** Extra key → key merges (a venue's own, learned from its hosts' merges for one prompt). */
export type KeyMap = Record<string, string>;

/**
 * The key an answer groups by: the venue's merges first, then the built-in synonyms. A key
 * the venue maps to itself was split out by a host: it stays apart, built-in synonyms too.
 */
export function answerKey(s: string, extra?: KeyMap): string {
  return keyFromRaw(rawKey(s), extra);
}

/** answerKey for a key already made by rawKey. */
export function keyFromRaw(raw: string, extra?: KeyMap): string {
  let k = raw;
  // A few hops at most (a → b → c), never a loop.
  for (let i = 0; i < 3 && extra && Object.hasOwn(extra, k); i++) {
    if (extra[k] === k) return k;
    k = extra[k];
  }
  return BUILT_IN.get(k) ?? k;
}

/** True when a host split this key out on purpose (no typo matching for it either). */
export function keptApart(raw: string, extra?: KeyMap): boolean {
  return !!extra && Object.hasOwn(extra, raw) && extra[raw] === raw;
}

/** Edit distance, capped: returns max+1 as soon as it's clearly further. */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Typos allowed for a key this long: none under 5 letters, 1 from 5, 2 from 9. */
export function typoAllowance(len: number): number {
  return len >= 9 ? 2 : len >= 5 ? 1 : 0;
}

/** True when two keys are the same answer, give or take a typo. */
export function keysMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const allow = typoAllowance(Math.min(a.length, b.length));
  return allow > 0 && editDistance(a, b, allow) <= allow;
}

/** How an answer is shown on the board: trimmed, single spaces, first letter capitalised. */
export function displayAnswer(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}
