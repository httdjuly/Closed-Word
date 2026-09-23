// Which AI backend this process is running with, decided once at boot.
//
// There are two, and the choice is deliberately made at runtime rather than by
// an import:
//
//   ai.ts       spawns `claude -p`. Present in a dev checkout, excluded from the
//               production build.
//   ai_off.ts   declines everything. Always present.
//
// `CLOSEWORD_AI=off` picks the stub without looking for the other one. Otherwise
// we try `ai.ts` and fall back if it simply is not there — which is what a
// production build looks like from the inside. Only a genuine "module not found"
// is swallowed; a syntax error or a broken import inside `ai.ts` still throws,
// because silently running with the assistant switched off is a much worse
// outcome than failing to start with the reason on screen.

import type { AiRuntime } from "./ai_core.ts";
import { log } from "./log.ts";

/**
 * True when the build is meant to have no Claude integration at all.
 *
 * Read straight from the environment rather than through `config.ts`, because
 * this decides which modules get loaded and has to be answerable before the rest
 * of the server is wired up.
 */
export function aiDisabledByConfig(): boolean {
  return (Deno.env.get("CLOSEWORD_AI") ?? "").trim().toLowerCase() === "off";
}

/**
 * Distinguish "the file is not in this build" from "the file is broken".
 *
 * Deno reports a missing module as `NotFound` or a TypeError naming the
 * specifier; either way the message carries the path. A failure to *evaluate*
 * ai.ts produces something else entirely and must not be mistaken for absence.
 */
function isMissingModule(err: unknown): boolean {
  if (err instanceof Deno.errors.NotFound) return true;
  if (!(err instanceof Error)) return false;
  return /Module not found|Cannot find module|ERR_MODULE_NOT_FOUND/i.test(err.message) &&
    /ai\.ts/.test(err.message);
}

let cached: AiRuntime | null = null;

/** Resolve the AI backend for this process. Safe to call more than once. */
export async function loadAi(): Promise<AiRuntime> {
  cached ??= await select();
  return cached;
}

/**
 * Split out from `loadAi` so every branch returns a value rather than assigning
 * to the module-level cache: narrowing on a `let` does not survive an `await`,
 * and the version that assigned in each branch needed a non-null assertion to
 * type-check — which is the wrong way to answer a compiler that is right.
 */
async function select(): Promise<AiRuntime> {
  if (aiDisabledByConfig()) {
    const off = await import("./ai_off.ts");
    log.service("ai backend selected", { kind: off.kind, reason: "CLOSEWORD_AI=off" });
    return off;
  }

  try {
    // The specifier goes through a variable so the type-checker does not try to
    // resolve it. That is the point of the whole arrangement: in a production
    // tree `ai.ts` is not on disk, and a literal `import("./ai.ts")` would make
    // `deno check` — and `next build` on the ported side — fail on a file that
    // is *deliberately* absent. Resolution still happens at runtime, relative to
    // this module, exactly as a literal would.
    const specifier = "./ai.ts";
    const live = await import(specifier) as AiRuntime;
    log.service("ai backend selected", { kind: live.kind, reason: "ai.ts present" });
    return live;
  } catch (err) {
    if (!isMissingModule(err)) throw err;
    const off = await import("./ai_off.ts");
    log.service("ai backend selected", { kind: off.kind, reason: "ai.ts not in this build" });
    return off;
  }
}
