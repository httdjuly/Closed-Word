// The AI runtime for builds with no `claude` in them.
//
// This is what `ai_runtime.ts` loads when the production build has dropped
// `ai.ts`, or when `CLOSEWORD_AI=off` says not to look. It implements the same
// `AiRuntime` contract by declining every call, which is exactly what the rest of
// the program already copes with: `claudeAvailable()` returning false is the
// same state as "the binary is not installed", a case the server has handled
// since before this split existed.
//
// Declining is not the same as pretending. Nothing here returns a plausible
// fake clue or a canned assistant reply — a made-up clue would be worse than no
// clue, because a player cannot tell the difference and would trust it.

import type { AiRuntime, AssistRequest, AssistResult, ClaudeOptions } from "./ai_core.ts";
import { ClaudeUnavailableError } from "./ai_core.ts";
import type { ClueProvider } from "./room.ts";

/** Names this module as the backend in use, for the boot banner. */
export const kind = "off" as const;

const REASON = "this build has no claude integration";

export function claudePrompt(_prompt: string, _options: ClaudeOptions = {}): Promise<string> {
  return Promise.reject(new ClaudeUnavailableError(REASON));
}

/**
 * Always false, and cheap.
 *
 * The live implementation shells out to `claude --version` to find this out. Here
 * the answer is known, so boot does not pay for a subprocess that cannot exist.
 */
export function claudeAvailable(_options: ClaudeOptions = {}): Promise<boolean> {
  return Promise.resolve(false);
}

export function assist(
  _request: AssistRequest,
  _options: ClaudeOptions = {},
): Promise<AssistResult> {
  return Promise.reject(new ClaudeUnavailableError(REASON));
}

/**
 * Present so the contract is complete, and never reached in practice: the server
 * only builds a clue provider when `claudeAvailable()` said yes, which here it
 * never does.
 */
export function createClaudeClueProvider(_options: ClaudeOptions = {}): ClueProvider {
  return {
    clue: () => Promise.reject(new ClaudeUnavailableError(REASON)),
  };
}

// A compile-time check that this module still satisfies the contract. Without it
// the two implementations could drift and nothing would notice until runtime.
const _contract: AiRuntime = {
  kind,
  claudePrompt,
  claudeAvailable,
  assist,
  createClaudeClueProvider,
};
void _contract;
