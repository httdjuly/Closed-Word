// Everything about the AI features that does not need `claude` to exist.
//
// This file is the reason a production build can drop `ai.ts` entirely. The AI
// integration splits in two:
//
//   - here: the prompts, the contract, the error types, and the validation that
//     decides what model output is allowed to do. Pure functions over strings.
//     No subprocess, no `Deno.Command`, no dependency on a binary being present.
//   - `ai.ts`: the part that actually spawns `claude -p`.
//
// The split is not tidiness. `ai.ts` is excluded from the production build
// (`deno task build:prod`), and the server has to keep type-checking, running and
// reporting honestly with that file absent — so anything the rest of the program
// references by name has to live on this side of the line. `ai_off.ts` implements
// the same contract by declining, and `ai_runtime.ts` picks between the two.
//
// Both player-facing paths run model output back to a browser, so both validate
// it here: a clue that leaks the secret is rejected rather than shown, and an
// appearance change is filtered through shared/prefs.js down to a fixed set of
// enums, clamped numbers and hex colours.

import { sanitisePrefs } from "../shared/prefs.js";
import type { ClueProvider } from "./room.ts";

export interface ClaudeOptions {
  /** Binary to invoke; override for testing or a pinned install. */
  bin?: string;
  /** Hard timeout per call. A slow model must never hold up a round. */
  timeoutMs?: number;
  model?: string;
}

export class ClaudeUnavailableError extends Error {}

/**
 * The call was killed for taking too long, as opposed to failing.
 *
 * Worth its own type: a killed subprocess just reports a non-zero exit with empty
 * stderr, which is indistinguishable from a real crash. Telling a player "it did
 * not work, try again" when the truth is "it needed longer" sends them round the
 * same loop forever.
 */
export class ClaudeTimeoutError extends Error {}

/**
 * A real `claude -p` answer of a few sentences takes ~25 s on a normal machine,
 * so anything tighter than this mostly measures how impatient we are. Callers
 * that genuinely cannot wait — the in-round clue path — pass their own.
 */
export const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * What the optional half of the AI integration has to provide.
 *
 * Named as an interface rather than left implicit because two modules implement
 * it — `ai.ts` and `ai_off.ts` — and they are selected at runtime, so nothing
 * else would catch the two drifting apart.
 */
export interface AiRuntime {
  /** Which implementation answered, for the boot banner and `/api/info`. */
  readonly kind: "claude" | "off";
  claudePrompt(prompt: string, options?: ClaudeOptions): Promise<string>;
  claudeAvailable(options?: ClaudeOptions): Promise<boolean>;
  assist(request: AssistRequest, options?: ClaudeOptions): Promise<AssistResult>;
  createClaudeClueProvider(options?: ClaudeOptions): ClueProvider;
}

export const CLUE_PROMPT = `You are the clue-giver in a word game. Players are hunting a \
secret word, guided only by semantic closeness scores.

Write ONE short clue (at most 20 words) that nudges players toward the secret word.

Hard rules:
- Never write the secret word, its plural, or any word sharing its first five letters.
- Do not spell it out, rhyme it, or give its first letter.
- Describe its meaning, category, or a typical context instead.
- Output only the clue sentence. No preamble, no quotes, no explanation.`;

/**
 * Guard against the model leaking the answer. We reject on exact match, on a
 * shared five-character prefix (catches plurals and simple inflections), and on
 * substring containment either way.
 */
export function clueLeaksSecret(clue: string, secret: string): boolean {
  const lower = clue.toLowerCase();
  if (lower.includes(secret)) return true;
  const stem = secret.slice(0, 5);
  for (const token of lower.match(/[a-z]+/g) ?? []) {
    if (token === secret) return true;
    if (secret.length >= 5 && token.startsWith(stem)) return true;
    if (token.length >= 5 && secret.startsWith(token.slice(0, 5))) return true;
  }
  return false;
}

/**
 * Framing per word source, so a clue in a themed game leans on the working
 * context the room shares rather than a generic dictionary gloss.
 */
export const SOURCE_FRAMING: Record<string, string> = {
  closeword: "Players are a mixed group; assume general knowledge only.",
  custom: "The word came from an internal product-documentation vocabulary, and the " +
    "players are colleagues who share it. Prefer a clue that leans on how the word " +
    "is used at work, in software or security or business operations.",
  ai: "The word came from a themed word list. Keep the clue in that register.",
};

// ---------------------------------------------------------------------------
// The per-player assistant
// ---------------------------------------------------------------------------

/** Mirrors DEFAULT_PREFS in shared/prefs.js. Declared because that file is
 * plain JS, so its exports would otherwise widen to `any` at this boundary. */
export interface AppearancePrefs {
  mode: string;
  accent: string;
  background: string;
  backgroundColor: string;
  backgroundImage: string | null;
  layout: string;
  density: string;
  font: string;
  glass: boolean;
  radius: number;
  motion: boolean;
}

interface SanitiseResult {
  prefs: AppearancePrefs;
  rejected: string[];
  applied: string[];
}

export const sanitise = sanitisePrefs as (patch: unknown, base?: unknown) => SanitiseResult;

export interface AssistTurn {
  role: string;
  text: string;
}

export interface AssistRequest {
  text: string;
  /** The asker's current look, for context. Never stored. */
  prefs?: Record<string, unknown>;
  history?: AssistTurn[];
}

export interface AssistResult {
  text: string;
  /**
   * The validated fields to change, if any.
   *
   * A patch rather than a whole preference set, because the server does not have
   * the full picture: a player's uploaded background never leaves their machine,
   * so returning a complete object would overwrite the image with a default and
   * wipe out something we were never told about.
   */
  patch?: Partial<AppearancePrefs>;
}

export const ASSISTANT_PROMPT =
  `You are the assistant inside CloseWord Party, a semantic word-guessing game a \
team plays together on their own network. You sit behind a small chat button in \
the corner. You are talking to ONE player, privately.

You do two things:

1. Restyle that player's workspace when they ask. Their appearance settings are \
personal — nobody else in the room sees them.
2. Talk about anything else they raise: how the game works, tactics for getting \
closer to a word, or just chat while they wait for the next round.

How the game works, so your advice is correct: there is a secret word. Players \
guess words and each guess comes back with a RANK — how semantically close it is \
to the secret, where rank 1 is the answer. Low rank is good. Guessing is about \
meaning, not spelling: anagrams and rhymes tell you nothing. Good tactics are to \
probe with broad words from different domains to find which area is warm, then \
narrow down inside it. Hints reveal a genuinely nearby word and are limited.

You do NOT know the secret word — it is never given to you. If asked for it, say \
so plainly; never invent one and never pretend to know.

APPEARANCE
If, and only if, the player asks for a visual change, end your reply with a \
fenced json block containing ONLY the fields you are changing:

\`\`\`json
{"mode":"dark","accent":"#7c9cff"}
\`\`\`

Allowed fields and values — anything else is discarded:
- "preset": one of claude, midnight, meadow, focus, arcade (a whole look at once)
- "mode": "light" | "dark" | "system"
- "accent": a hex colour like "#c96442"
- "background": one of clay, aurora, dusk, forest, skyline, paper, solid
- "backgroundColor": a hex colour, used when background is "solid"
- "layout": "columns" (three panels) | "focus" (one centred column) | "wide"
- "density": "compact" | "cozy" | "roomy"
- "font": "system" | "rounded" | "serif" | "mono"
- "glass": true | false  (frosted translucent panels)
- "radius": a number from 2 to 28 (corner rounding, px)
- "motion": true | false  (animations)

You cannot set a background photograph — only the player can, by uploading one \
in the Look tab. Point them there if they ask.

STYLE
Warm, brief, unfussy. One or two sentences unless they asked something that \
genuinely needs more. No preamble, no bullet lists for simple answers, and do not \
restate the json block in prose. If they ask for something you cannot do, say what \
you can do instead.`;

/**
 * Pull a trailing json block out of a reply, returning the prose separately.
 *
 * Models are inconsistent about fencing, so a bare object at the very end is
 * accepted too — but only when it starts at the beginning of a line, so a brace
 * inside a sentence is never mistaken for a patch.
 */
export function extractPatch(raw: string): { text: string; patch: unknown } {
  const fence = raw.match(/```(?:json|closeword(?:-prefs)?)?[ \t]*\r?\n([\s\S]*?)```/i);
  if (fence) {
    const text = (raw.slice(0, fence.index) + raw.slice((fence.index ?? 0) + fence[0].length))
      .trim();
    return { text, patch: parseJson(fence[1]) };
  }

  const bare = raw.match(/(?:^|\n)(\{[\s\S]*\})\s*$/);
  if (bare) {
    const patch = parseJson(bare[1]);
    if (patch !== null) {
      return { text: raw.slice(0, bare.index).trim(), patch };
    }
  }
  return { text: raw.trim(), patch: null };
}

function parseJson(text: string): unknown {
  try {
    const value = JSON.parse(text.trim());
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Compose the full prompt for one assistant turn. Separate from `assist` so it
 * can be inspected and tested without spawning anything.
 */
export function buildAssistPrompt(
  request: AssistRequest,
  base: AppearancePrefs,
): string {
  const look = [
    `theme=${base.mode}`,
    `accent=${base.accent}`,
    `background=${base.background}`,
    `layout=${base.layout}`,
    `density=${base.density}`,
    `font=${base.font}`,
    `glass=${base.glass}`,
    `radius=${base.radius}`,
  ].join(", ");

  const history = (request.history ?? [])
    .slice(-8)
    .filter((turn) => typeof turn.text === "string" && turn.text.trim())
    .map((turn) => `${turn.role === "you" ? "Player" : "You"}: ${turn.text.slice(0, 500)}`)
    .join("\n");

  return `${ASSISTANT_PROMPT}\n\nTheir current look: ${look}\n` +
    (history ? `\nRecent conversation:\n${history}\n` : "") +
    `\nPlayer: ${request.text}\nYou:`;
}

/**
 * Turn a raw model reply into the prose and the validated patch to apply.
 *
 * Shared by every implementation of `assist`, so the rule about what a model is
 * allowed to change lives in one place rather than once per backend.
 */
export function interpretAssistReply(raw: string, base: AppearancePrefs): AssistResult {
  const { text, patch } = extractPatch(raw);

  if (!patch) {
    return { text: text || "I did not have anything useful to say to that, sorry." };
  }

  // Validated against the asker's current look so "applied" means "actually
  // different", then narrowed to just those fields.
  const result = sanitise(patch, base);
  const applied = result.applied.filter((key) => key !== "backgroundImage");
  if (applied.length === 0) {
    return {
      text: text ||
        "That is not something I can change — have a look at the Look tab for what is available.",
    };
  }
  const validated = result.prefs as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of applied) out[key] = validated[key];
  return { text, patch: out as Partial<AppearancePrefs> };
}
