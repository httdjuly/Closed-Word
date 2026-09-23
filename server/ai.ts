// The half of the AI integration that actually spawns `claude -p`.
//
// **This file is excluded from the production build.** `deno task build:prod`
// emits a tree without it, and the server is required to boot, type-check and
// behave correctly when it is absent — `ai_runtime.ts` falls back to `ai_off.ts`
// and every AI feature reports itself unavailable. Nothing outside this file may
// import it directly except the offline word scripts, which are also excluded.
//
// Everything that does not need the binary — prompts, validation, error types,
// the `AiRuntime` contract — lives in `ai_core.ts` and always ships.
//
// Three uses, all strictly optional and all fail-soft:
//
//   1. In-game prose clues (`aiClues` room setting). A hint normally reveals a
//      nearby word; with clues on, the board also gets a sentence of context.
//   2. Offline secret-word curation (scripts/curate_words.ts), which filters a
//      frequency-derived pool down to words that make good puzzle targets.
//   3. The per-player assistant behind the floating chat button, which answers
//      questions and can restyle that one player's workspace.

import { config } from "./config.ts";
import { log } from "./log.ts";
import type { ClueProvider } from "./room.ts";
import {
  type AssistRequest,
  type AssistResult,
  buildAssistPrompt,
  type ClaudeOptions,
  ClaudeTimeoutError,
  ClaudeUnavailableError,
  CLUE_PROMPT,
  clueLeaksSecret,
  DEFAULT_TIMEOUT_MS,
  interpretAssistReply,
  sanitise,
  SOURCE_FRAMING,
} from "./ai_core.ts";

// Re-exported so the offline scripts and anything else holding an `ai.ts` import
// keep working against one module rather than having to know about the split.
export * from "./ai_core.ts";

/** Names this module as the live backend, for the boot banner. */
export const kind = "claude" as const;

/** Run `claude -p` with a prompt on stdin and return its text output. */
export async function claudePrompt(prompt: string, options: ClaudeOptions = {}): Promise<string> {
  const bin = options.bin ?? config.claude.bin;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const args = ["-p"];
  const model = options.model ?? config.claude.model;
  if (model) args.push("--model", model);

  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(bin, {
      args,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (err) {
    throw new ClaudeUnavailableError(
      `could not run ${bin}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(prompt));
  await writer.close();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // Already exited.
    }
  }, timeoutMs);

  // Every outbound call is logged with its duration and outcome — never its
  // prompt, which carries a player's private question or the round's secret.
  const startedAt = Date.now();
  try {
    const { code, stdout, stderr } = await child.output();
    const ms = Date.now() - startedAt;
    if (code !== 0) {
      // A killed child reports a non-zero exit and empty stderr, so without the
      // flag this would be reported as a crash.
      if (timedOut) {
        log.warn("webhook", "claude timed out", { bin, model, ms, timeoutMs });
        throw new ClaudeTimeoutError(`${bin} did not answer within ${timeoutMs}ms`);
      }
      const detail = new TextDecoder().decode(stderr).trim().slice(0, 400);
      log.warn("webhook", "claude failed", { bin, model, ms, exit: code, detail });
      throw new Error(`${bin} exited ${code}${detail ? `: ${detail}` : ""}`);
    }
    const text = new TextDecoder().decode(stdout).trim();
    log.debug("webhook", "claude replied", { bin, model, ms, chars: text.length });
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** True if the CLI looks usable, so the server can report it at boot. */
export async function claudeAvailable(options: ClaudeOptions = {}): Promise<boolean> {
  const bin = options.bin ?? config.claude.bin;
  try {
    const out = await new Deno.Command(bin, {
      args: ["--version"],
      stdout: "piped",
      stderr: "null",
    })
      .output();
    return out.code === 0;
  } catch {
    return false;
  }
}

/**
 * Answer one assistant message.
 *
 * The player's own words go into the prompt, so in principle they can steer the
 * model however they like. That is harmless here: the only thing the model can
 * act on is a preference patch, every field of which is bounded by
 * shared/prefs.js, and it only ever changes that same player's own browser.
 */
export async function assist(
  request: AssistRequest,
  options: ClaudeOptions = {},
): Promise<AssistResult> {
  const base = sanitise(request.prefs ?? {}).prefs;
  const prompt = buildAssistPrompt(request, base);
  // Generous, because a chat reply blocks nothing: the player is looking at a
  // "thinking…" bubble, not waiting to guess. 25 s was not enough — a couple of
  // considered sentences measured 23 s, so ordinary answers were being killed
  // mid-flight and reported as failures.
  const raw = await claudePrompt(prompt, { timeoutMs: config.claude.assistTimeoutMs, ...options });
  return interpretAssistReply(raw, base);
}

export function createClaudeClueProvider(options: ClaudeOptions = {}): ClueProvider {
  return {
    async clue(secret, context) {
      const guessed = context.guesses.length
        ? `Words already tried (all wrong): ${context.guesses.join(", ")}.`
        : "No guesses yet.";
      const framing = SOURCE_FRAMING[context.wordSource ?? "closeword"] ??
        SOURCE_FRAMING.closeword;
      const prompt = `${CLUE_PROMPT}\n\n${framing}\n\nThe secret word is: ${secret}\n${guessed}`;
      // Unlike the assistant, a clue is only worth having while the round is
      // still on, so this one stays impatient. It asks for a single sentence,
      // which comes back well inside this.
      const raw = await claudePrompt(prompt, {
        timeoutMs: config.claude.clueTimeoutMs,
        ...options,
      });
      const clue = raw.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "";
      const cleaned = clue.replace(/^["'“”]|["'“”]$/g, "").trim();
      if (!cleaned) throw new Error("empty clue");
      if (clueLeaksSecret(cleaned, secret)) {
        // Neither the clue nor the secret is logged: the rejected clue contains
        // the answer, which is exactly why it was rejected.
        log.warn("webhook", "clue rejected for leaking the secret", {
          source: context.wordSource,
        });
        throw new Error(`clue leaked the secret: ${cleaned}`);
      }
      log.debug("webhook", "clue accepted", { source: context.wordSource });
      return cleaned;
    },
  };
}
