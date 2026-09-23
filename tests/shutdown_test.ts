// Tests for the Ctrl-C handler.
//
// One property matters above all the others: it exits. Registering a SIGINT
// listener takes Deno's default "terminate on Ctrl-C" away, so a handler that
// forgets to exit leaves a server that cannot be stopped with Ctrl-C at all —
// which is exactly what happened before this file existed.

import { assert, assertEquals } from "@std/assert";
import { createShutdownHandler } from "../server/shutdown.ts";

/** A handler whose exit is recorded instead of taken. */
function harness(overrides: { onStop?: () => void; cleanup?: () => void } = {}) {
  const exits: number[] = [];
  const calls: string[] = [];
  const handler = createShutdownHandler({
    onStop: (signal) => {
      calls.push(`stop:${signal}`);
      overrides.onStop?.();
    },
    cleanup: () => {
      calls.push("cleanup");
      overrides.cleanup?.();
    },
    // Not really `never` here — the point is to carry on and inspect it.
    exit: ((code: number) => {
      exits.push(code);
    }) as unknown as (code: number) => never,
  });
  return { handler, exits, calls };
}

Deno.test("a signal exits the process", () => {
  const { handler, exits } = harness();
  handler("SIGINT");
  assertEquals(exits, [0]);
});

Deno.test("the stop is recorded before cleanup", () => {
  const { handler, calls } = harness();
  handler("SIGTERM");
  assertEquals(calls, ["stop:SIGTERM", "cleanup"]);
});

Deno.test("it still exits when recording the stop throws", () => {
  // A broken log must not be the reason a server cannot be stopped.
  const { handler, exits } = harness({
    onStop: () => {
      throw new Error("log is on fire");
    },
  });
  let threw = false;
  try {
    handler("SIGINT");
  } catch {
    threw = true;
  }
  assertEquals(exits, [0], "exited despite the failure");
  assert(threw, "the original error is not swallowed");
});

Deno.test("it still exits when cleanup throws", () => {
  const { handler, exits } = harness({
    cleanup: () => {
      throw new Error("socket close blew up");
    },
  });
  try {
    handler("SIGINT");
  } catch {
    // Expected.
  }
  assertEquals(exits, [0]);
});

Deno.test("a second signal exits immediately without redoing the work", () => {
  // Someone who thinks it has hung will press Ctrl-C again; that must not run
  // cleanup twice, and must never leave them reaching for the task manager.
  const { handler, exits, calls } = harness();
  handler("SIGINT");
  handler("SIGINT");
  assertEquals(exits, [0, 1]);
  assertEquals(calls, ["stop:SIGINT", "cleanup"], "the work happened exactly once");
});
