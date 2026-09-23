// House rules: what ends a round, the guess budget, and the host's stop
// controls. These change the shape of a round rather than any one guess, so the
// assertions are all about phase and timing rather than ranks.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { RoomError } from "../server/room.ts";
import { idFor, makeRoom } from "./helpers.ts";

/**
 * Ordinary words to burn a budget on. Any that happens to be the secret is
 * skipped by the caller, so no test accidentally solves the round it is trying
 * to starve.
 */
const FILLER = ["cat", "dog", "salt", "coffee", "table", "river", "music", "paper", "green"];

/** Spend `n` guesses for `playerId` without solving. Returns what was accepted. */
function burn(
  t: Awaited<ReturnType<typeof makeRoom>>,
  playerId: string,
  n: number,
): number {
  let spent = 0;
  for (const word of FILLER) {
    if (spent >= n) break;
    if (word === t.room.secret) continue;
    if (t.room.guess(playerId, word).accepted) spent++;
  }
  return spent;
}

// ---------------------------------------------------------------------------
// Finish rule
// ---------------------------------------------------------------------------

Deno.test("sudden death ends the round the moment one board solves", async () => {
  const t = await makeRoom({ mode: "race", finish: "first" }, ["ann", "bo", "cy"]);
  t.room.start(idFor("ann"));
  assertEquals(t.room.phase, "playing");
  t.solve(idFor("ann"));
  assertEquals(t.room.phase, "matchEnd"); // race is a single round
  // The other two never got the chance, and the room is told why.
  const bo = t.room.publicPlayers().find((p) => p.nickname === "bo")!;
  assertEquals(bo.solved, false);
});

Deno.test("sudden death does not fire when there is only one board", async () => {
  const t = await makeRoom({ mode: "coop", finish: "first", totalRounds: 3 }, ["ann", "bo"]);
  t.room.start(idFor("ann"));
  t.solve(idFor("ann"));
  // Co-op has a single shared board, so solving it ends the round on its own
  // merits — via "everyone is done", not via the sudden-death branch. The match
  // still has rounds left, which is what proves it took the ordinary path.
  assertEquals(t.room.phase, "roundEnd");
  assertEquals(t.room.round, 1);
});

Deno.test("the grace clock only runs under the grace rule", async () => {
  const graced = await makeRoom(
    { mode: "race", finish: "grace", graceSeconds: 60, roundSeconds: 0 },
    ["ann", "bo"],
  );
  graced.room.start(idFor("ann"));
  graced.solve(idFor("ann"));
  assertEquals(graced.room.phase, "playing");
  assert(graced.room.roundEndsAt !== null, "grace should have set a deadline");
  assert(graced.room.graceStartedAt !== null);

  const open = await makeRoom(
    { mode: "race", finish: "everyone", graceSeconds: 60, roundSeconds: 0 },
    ["ann", "bo"],
  );
  open.room.start(idFor("ann"));
  open.solve(idFor("ann"));
  assertEquals(open.room.phase, "playing");
  assertEquals(open.room.roundEndsAt, null, "everyone-finishes must not start a clock");
  assertEquals(open.room.graceStartedAt, null);
});

Deno.test("everyone-finishes still ends once the last board solves", async () => {
  const t = await makeRoom({ mode: "race", finish: "everyone" }, ["ann", "bo"]);
  t.room.start(idFor("ann"));
  t.solve(idFor("ann"));
  assertEquals(t.room.phase, "playing");
  t.solve(idFor("bo"));
  assertEquals(t.room.phase, "matchEnd");
});

Deno.test("the host can end a stuck everyone-finishes round by hand", async () => {
  const t = await makeRoom({ mode: "race", finish: "everyone" }, ["ann", "bo"]);
  t.room.start(idFor("ann"));
  t.solve(idFor("ann"));
  assertThrows(() => t.room.endRound(idFor("bo")), RoomError, "Only the host");
  t.room.endRound(idFor("ann"));
  assertEquals(t.room.phase, "matchEnd");
});

// ---------------------------------------------------------------------------
// Guess budget
// ---------------------------------------------------------------------------

Deno.test("a board out of budget is refused, and told the number", async () => {
  const t = await makeRoom({ mode: "race", finish: "everyone", guessLimit: 2 }, ["ann", "bo"]);
  t.room.start(idFor("ann"));
  assertEquals(burn(t, idFor("ann"), 2), 2);
  const refused = t.room.guess(idFor("ann"), "window");
  assertEquals(refused.accepted, false);
  assert(refused.accepted === false && refused.message.includes("2"));
  // The other board is untouched by its neighbour's spending.
  assert(t.room.guess(idFor("bo"), "window").accepted);
});

Deno.test("hints are free — they do not spend the budget", async () => {
  const t = await makeRoom(
    { mode: "race", finish: "everyone", guessLimit: 3, hintsPerBoard: 2 },
    ["ann", "bo"],
  );
  t.room.start(idFor("ann"));
  t.room.hint(idFor("ann"));
  t.room.hint(idFor("ann"));
  assertEquals(burn(t, idFor("ann"), 3), 3, "two hints must not have eaten the budget");
  assertEquals(t.room.guess(idFor("ann"), "window").accepted, false);
});

Deno.test("the round ends when every board has spent its budget", async () => {
  const t = await makeRoom({ mode: "race", finish: "everyone", guessLimit: 1 }, ["ann", "bo"]);
  t.room.start(idFor("ann"));
  burn(t, idFor("ann"), 1);
  assertEquals(t.room.phase, "playing", "one board out is not the whole room");
  burn(t, idFor("bo"), 1);
  assertEquals(t.room.phase, "matchEnd");
});

Deno.test("a solved board plus a starved board still ends the round", async () => {
  const t = await makeRoom({ mode: "race", finish: "everyone", guessLimit: 1 }, ["ann", "bo"]);
  t.room.start(idFor("ann"));
  burn(t, idFor("bo"), 1);
  assertEquals(t.room.phase, "playing");
  t.solve(idFor("ann"));
  assertEquals(t.room.phase, "matchEnd");
});

Deno.test("guessLimit 0 means unlimited", async () => {
  const t = await makeRoom({ mode: "race", guessLimit: 0 }, ["ann"]);
  t.room.start(idFor("ann"));
  assertEquals(burn(t, idFor("ann"), 6), 6);
  assertEquals(t.room.phase, "playing");
});

// ---------------------------------------------------------------------------
// Host controls
// ---------------------------------------------------------------------------

Deno.test("stopping the match scores the round in progress first", async () => {
  const t = await makeRoom({ mode: "rounds", totalRounds: 5 }, ["ann", "bo"]);
  t.room.start(idFor("ann"));
  t.solve(idFor("ann"));
  assertEquals(t.room.phase, "playing", "grace clock keeps the round open");
  t.room.endMatch(idFor("ann"));
  assertEquals(t.room.phase, "matchEnd");
  const ann = t.room.publicPlayers().find((p) => p.nickname === "ann")!;
  assert(ann.score > 0, "the round they won before the stop still counts");
});

Deno.test("only the host can stop the match or reset the room", async () => {
  const t = await makeRoom({ mode: "rounds" }, ["ann", "bo"]);
  t.room.start(idFor("ann"));
  assertThrows(() => t.room.endMatch(idFor("bo")), RoomError, "Only the host");
  assertThrows(() => t.room.reset(idFor("bo")), RoomError, "Only the host");
});

Deno.test("stopping a match that never started is refused", async () => {
  const t = await makeRoom({}, ["ann"]);
  assertThrows(() => t.room.endMatch(idFor("ann")), RoomError, "No match is running");
});

Deno.test("reset clears scores and history and returns to the lobby", async () => {
  const t = await makeRoom({ mode: "rounds", totalRounds: 3 }, ["ann", "bo"]);
  t.room.start(idFor("ann"));
  t.solve(idFor("ann"));
  t.room.endRound(idFor("ann"));
  assert(t.room.publicPlayers().every((p) => p.score >= 0));
  assert(t.room.journeyFor(idFor("ann"), idFor("ann"))!.rounds.length > 0);

  t.room.reset(idFor("ann"));
  assertEquals(t.room.phase, "lobby");
  assertEquals(t.room.round, 0);
  assertEquals(t.room.boards.size, 0);
  for (const p of t.room.publicPlayers()) assertEquals(p.score, 0);
  assertEquals(t.room.journeyFor(idFor("ann"), idFor("ann"))!.rounds.length, 0);
});

// ---------------------------------------------------------------------------
// Sanitising
// ---------------------------------------------------------------------------

Deno.test("the new rules are sanitised like every other setting", async () => {
  const t = await makeRoom({}, ["ann"]);
  t.room.setConfig(idFor("ann"), {
    // deno-lint-ignore no-explicit-any
    finish: "whenever-i-say" as any,
    guessLimit: 99999,
  });
  assertEquals(t.room.config.finish, "grace");
  assertEquals(t.room.config.guessLimit, 200);

  t.room.setConfig(idFor("ann"), { finish: "first", guessLimit: -4 });
  assertEquals(t.room.config.finish, "first");
  assertEquals(t.room.config.guessLimit, 0);
});
