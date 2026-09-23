// Pronunciation, part of speech and a Vietnamese gloss, on request.
//
// This exists because the room is half Vietnamese speakers. A rank tells you that
// `warranty` was close; it does not tell you how to say it, whether it is a noun,
// or what it means — and without those a guessing game in a second language is a
// game of luck. So any word on your board can be asked about.
//
// ## Why it is a request rather than part of the snapshot
//
// Everything else in this protocol is server-authoritative state pushed as a full
// snapshot. A definition deliberately is not, for two reasons that both matter:
//
//   - a round can produce fifty words and a player will look up two. Fetching all
//     fifty costs fifty subprocesses to answer one question;
//   - it is reference data about the English language, not state about this room.
//     Putting it in the snapshot would mean re-sending it every time anybody
//     guesses anything.
//
// ## What is stored, and where
//
// A process-wide cache keyed by word, capped, in memory, never written to disk. It
// holds nothing about who asked or which room they were in — a definition of
// `warranty` is the same fact for everybody, which is exactly why it is safe to
// share and pointless to scope. It outlives a room on purpose: the next room
// asking the same question should not pay for it again.
//
// The audio half of the feature is not here at all. The browser speaks the word
// with `speechSynthesis`, so pronunciation *works* — offline, instantly, with no
// server and no `claude` — even when this whole file is unavailable.

import { type AiRuntime, ClaudeTimeoutError, ClaudeUnavailableError } from "./ai_core.ts";
import { config } from "./config.ts";
import { log } from "./log.ts";
import { cleanText } from "../shared/text.js";
import type { WordNote } from "../shared/protocol.ts";

/**
 * How many words to remember.
 *
 * A word note is a few hundred bytes, so this is well under a megabyte. The cap
 * exists because the cache is keyed by a client-supplied string: without it,
 * somebody could ask about 50,000 words and make us hold all of them.
 */
const CACHE_MAX = 1000;

/** Parts of speech we will pass on. Anything else is dropped rather than shown. */
const PARTS = new Set([
  "noun",
  "verb",
  "adjective",
  "adverb",
  "pronoun",
  "preposition",
  "conjunction",
  "interjection",
  "determiner",
  "abbreviation",
]);

const PROMPT = `You are a bilingual dictionary for a word game played by English \
and Vietnamese speakers together.

Given one English word, reply with ONLY a JSON object, no fence and no commentary:

{"ipa":"...","pos":"...","meaning":"...","vi":"..."}

- "ipa": the General American pronunciation in IPA, without surrounding slashes, \
e.g. "ˈwɔːrənti".
- "pos": the single most common part of speech, spelled out in full: noun, verb, \
adjective, adverb, pronoun, preposition, conjunction, interjection, determiner, \
or abbreviation.
- "meaning": the everyday sense, in at most 12 English words. Do not begin with \
"the word means" or repeat the word itself.
- "vi": the Vietnamese translation. One or two words where one exists, a short \
phrase where it does not. Correct Vietnamese diacritics.

If the word is an abbreviation or a product name, say so in "pos" and expand it in \
"meaning". If you genuinely do not know the word, reply exactly {"unknown":true}.`;

const cleanString = cleanText as (raw: string, max: number) => string;

interface CacheEntry {
  note: WordNote | null;
  /** Set while a lookup is in flight, so two askers share one subprocess. */
  pending?: Promise<WordNote | null>;
}

const cache = new Map<string, CacheEntry>();

/**
 * Trim a model string to something safe to render, or undefined if unusable.
 *
 * The same `cleanText` every chat line goes through: it folds whitespace, strips
 * control characters and bidi overrides, and counts its limit in user-perceived
 * characters — which matters here, because Vietnamese and IPA are both full of
 * combining marks that a naive `slice` would cut in half.
 */
function field(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = cleanString(value, max);
  return clean.length > 0 ? clean : undefined;
}

/**
 * Turn a model reply into a note, keeping only fields that look right.
 *
 * Exported for the tests: this is where a bad answer becomes a blank field rather
 * than something odd on somebody's screen, and it is worth being able to feed it
 * rubbish directly.
 */
export function parseNote(word: string, raw: string): WordNote | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.unknown === true) return null;

  const note: WordNote = { word };
  const pos = field(obj.pos, 20)?.toLowerCase();
  if (pos && PARTS.has(pos)) note.pos = pos;
  // The client draws the slashes, so a model that included them would double up.
  const ipa = field(obj.ipa, 60)?.replace(/^\/+|\/+$/g, "");
  if (ipa) note.ipa = ipa;
  const meaning = field(obj.meaning, 160);
  if (meaning) note.meaning = meaning;
  const vi = field(obj.vi, 120);
  if (vi) note.vi = vi;

  // A note with nothing in it is worse than no note: the panel would render an
  // empty box and look broken rather than honest.
  return note.ipa || note.pos || note.meaning || note.vi ? note : null;
}

export interface Definer {
  /**
   * Look a word up. Resolves to null when the word is unknown, and rejects only
   * when the lookup itself failed — the caller tells those apart because "we do
   * not know that word" and "the dictionary is down" need different words on
   * screen.
   */
  lookUp(word: string): Promise<WordNote | null>;
  /** True when a lookup could conceivably succeed. */
  available: boolean;
  cached(): number;
}

/** A definer that admits it cannot do anything, for when `claude` is absent. */
export function unavailableDefiner(): Definer {
  return {
    available: false,
    cached: () => 0,
    lookUp: () => Promise.reject(new ClaudeUnavailableError("no claude binary")),
  };
}

/**
 * The backend arrives as an argument rather than an import, so this file never
 * names `ai.ts` — which is what lets the production build drop that file and
 * still type-check. The caller has already resolved which one it holds.
 */
export function createDefiner(ai: AiRuntime): Definer {
  return {
    available: true,
    cached: () => cache.size,

    lookUp(word: string): Promise<WordNote | null> {
      const hit = cache.get(word);
      if (hit) {
        // Refresh the LRU position even on a hit, so the words a room keeps
        // asking about are the last to be dropped.
        cache.delete(word);
        cache.set(word, hit);
        return hit.pending ?? Promise.resolve(hit.note);
      }

      const entry: CacheEntry = { note: null };
      const pending = (async () => {
        const startedAt = Date.now();
        try {
          const raw = await ai.claudePrompt(`${PROMPT}\n\nWord: ${word}\n`, {
            // The assistant's timeout, not the clue's.
            //
            // A clue is impatient because it is only useful while the round is
            // still running. A definition holds nothing up: the asker is looking
            // at a spinner in a panel and can keep guessing around it. And the
            // clue budget is genuinely too tight for this — measured at 30.1 s for
            // a one-line JSON answer on an ordinary laptop, which is a *timeout*
            // rather than a slow answer, and it reads to the asker as broken.
            timeoutMs: config.claude.assistTimeoutMs,
          });
          const note = parseNote(word, raw);
          entry.note = note;
          delete entry.pending;
          log.debug("webhook", "word looked up", {
            word,
            ms: Date.now() - startedAt,
            found: note !== null,
          });
          return note;
        } catch (err) {
          // Failures are not cached. A timeout is a fact about the machine, not
          // about the word, and caching it would make one bad moment permanent.
          cache.delete(word);
          if (err instanceof ClaudeTimeoutError) {
            log.warn("webhook", "word lookup timed out", { word });
          } else {
            log.warn("webhook", "word lookup failed", {
              word,
              detail: err instanceof Error ? err.message.slice(0, 200) : String(err),
            });
          }
          throw err;
        }
      })();

      entry.pending = pending;
      cache.set(word, entry);
      while (cache.size > CACHE_MAX) {
        const oldest = cache.keys().next();
        if (oldest.done) break;
        cache.delete(oldest.value);
      }
      return pending;
    },
  };
}
