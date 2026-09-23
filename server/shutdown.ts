// Stopping the server on Ctrl-C.
//
// This is its own module for one reason: the interesting behaviour is "the
// process actually exits", and that is untestable while it is tangled up with a
// live listener, a registry and a set of sockets.
//
// The bug it exists to prevent has already happened once. Registering *any*
// SIGINT listener replaces Deno's default "terminate on Ctrl-C", so a handler
// that logs but never calls `Deno.exit` produces a server that acknowledges
// Ctrl-C and then keeps running — and no amount of pressing it again helps.

export interface ShutdownDeps {
  /** Record the stop. Must be synchronous: the process is about to go. */
  onStop: (signal: string) => void;
  /** Best-effort tidying. Anything that throws here must not prevent the exit. */
  cleanup: () => void;
  /** Injected so a test can observe it instead of dying. */
  exit: (code: number) => never;
}

/**
 * Build the signal handler.
 *
 * Guarantees, in order of importance:
 *   1. It always exits, even if logging or cleanup throws.
 *   2. A second signal exits immediately, so an operator who thinks it has hung
 *      is never made to reach for the task manager.
 */
export function createShutdownHandler(deps: ShutdownDeps): (signal: string) => void {
  let shuttingDown = false;
  return function shutdown(signal: string): void {
    if (shuttingDown) {
      deps.exit(1);
      // `exit` is typed `never`, but control flow here is too important to rest
      // on a type: if it ever returns, the guard has to hold anyway.
      return;
    }
    shuttingDown = true;
    try {
      deps.onStop(signal);
      deps.cleanup();
    } finally {
      deps.exit(0);
    }
  };
}

/**
 * Attach a handler to every termination signal the platform admits.
 *
 * Registering each separately because the set differs per platform — SIGTERM
 * does not exist on some Windows builds and registering it throws — and one
 * unsupported name must not cost us the others.
 *
 * Returns the signals that took, which the caller can log.
 */
export function attachSignalHandlers(
  handler: (signal: string) => void,
  signals: readonly Deno.Signal[] = ["SIGINT", "SIGTERM", "SIGBREAK"],
): Deno.Signal[] {
  const attached: Deno.Signal[] = [];
  for (const signal of signals) {
    try {
      Deno.addSignalListener(signal, () => handler(signal));
      attached.push(signal);
    } catch {
      // Not supported here; the others still apply.
    }
  }
  return attached;
}
