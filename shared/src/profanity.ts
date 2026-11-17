// The profanity filter (on by default; the host can turn it off for a room). It checks whole
// words, so "class" and "Scunthorpe" pass, plus a few unambiguous stems anywhere in the text
// so "f.u.c.k" or "shitshow" don't slip through. Leetspeak digits are read as letters.

import { normalizeText, singular } from "./answers.js";

const WORDS = new Set([
  "ass", "asshole", "arse", "arsehole", "bastard", "bitch", "bollock", "bullshit", "cock", "cocksucker",
  "cum", "cunt", "dick", "dickhead", "dildo", "douche", "douchebag", "fag", "faggot", "fuck", "fucker",
  "fucking", "fuckin", "fucked", "jizz", "kike", "motherfucker", "nigga", "nigger", "piss", "pissed",
  "prick", "pussy", "retard", "retarded", "shit", "shitty", "slut", "spic", "twat", "wank", "wanker",
  "whore", "chink", "tranny", "skank", "tit", "titty", "boner", "porn", "cooter", "jackass", "dumbass",
  "goddamn", "damnit",
]);

/** Stems that are rude wherever they appear. */
const STEMS = ["fuck", "shit", "nigg", "fagg", "motherf", "whore", "bitch", "cocksuck", "asshole", "dickhead"];

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i" };

/** True when the text has a word the filter turns away. */
export function isProfane(text: string): boolean {
  const plain = normalizeText(text);
  const unleet = normalizeText(text.replace(/[013457@$!]/g, (c) => LEET[c] ?? c));
  for (const variant of [plain, unleet]) {
    for (const w of variant.split(" ")) {
      if (w && (WORDS.has(w) || WORDS.has(singular(w)))) return true;
    }
    const compact = variant.replace(/ /g, "");
    if (STEMS.some((s) => compact.includes(s))) return true;
  }
  return false;
}
