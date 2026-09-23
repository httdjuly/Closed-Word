// The journey view — one player's path to the word, round by round.
//
// The assertions that matter most here are the negative ones. A journey is the
// only thing in the app that hands you somebody else's guesses, so every test
// that says "you can see it" is paired with one that says "not yet".

import { assert, assertEquals, assertThrows } from "@std/assert";
import { RoomError } from "../server/room.ts";
import { idFor, makeRoom } from "./helpers.ts";

const ANN = idFor("ann");
const BO = idFor("bo");

/** Guess a couple of ordinary words that are not the secret. */
function play(t: Awaited<ReturnType<typeof makeRoom>>, playerId: string, words: string[]): number {
  let n = 0;
  for (const w of words) {
    if (w === t.room.secret) continue;
    if (t.room.guess(playerId, w).accepted) n++;
  }
  return n;
}

Deno.test("you can always see your own journey, mid-round", async () => {
  const t = await makeRoom({ mode: "race", finish: "everyone" }, ["ann", "bo"]);
  t.room.start(ANN);
  const n = play(t, ANN, ["cat", "dog", "salt"]);

  const journey = t.room.journeyFor(ANN, ANN)!;
  assertEquals(journey.playerId, ANN);
  assertEquals(journey.rounds.length, 1);
  const round = journey.rounds[0];
  assertEquals(round.hidden, false);
  assertEquals(round.steps.length, n);
  assertEquals(round.guesses, n);
  assertEquals(round.secret, null, "the answer is never in a live round");
});

Deno.test("a rival's guesses are withheld mid-round but their counts are not", async () => {
  const t = await makeRoom({ mode: "race", finish: "everyone" }, ["ann", "bo"]);
  t.room.start(ANN);
  const n = play(t, BO, ["cat", "dog", "salt"]);
  assert(n > 0);

  const seen = t.room.journeyFor(ANN, BO)!;
  const round = seen.rounds[0];
  assertEquals(round.hidden, true);
  assertEquals(round.steps, [], "another board's words must not leave the server");
  // Counts and best rank are already on every snapshot, so withholding them here
  // would only make the view lie.
  assertEquals(round.guesses, n);
  assert(round.bestRank !== null);
});

Deno.test("once the round is over, everyone's journey is open", async () => {
  const t = await makeRoom({ mode: "race", finish: "everyone", revealOnEnd: true }, ["ann", "bo"]);
  t.room.start(ANN);
  const n = play(t, BO, ["cat", "dog", "salt"]);
  t.room.endRound(ANN);

  const seen = t.room.journeyFor(ANN, BO)!;
  assertEquals(seen.rounds.length, 1);
  const round = seen.rounds[0];
  assertEquals(round.hidden, false);
  assertEquals(round.steps.length, n);
  assertEquals(round.secret, t.room.roundView()?.secret);
  assert(round.steps.every((s) => typeof s.word === "string" && s.rank > 0));
});

Deno.test("teammates see each other's guesses while the round runs", async () => {
  const t = await makeRoom({ mode: "teams", teamCount: 2, finish: "everyone" }, ["ann", "bo"]);
  t.room.setTeam(ANN, ANN, 0);
  t.room.setTeam(ANN, BO, 0);
  t.room.start(ANN);
  const n = play(t, BO, ["cat", "dog"]);

  // Same board, so this is not a leak — it is the board they are both looking at.
  const round = t.room.journeyFor(ANN, BO)!.rounds[0];
  assertEquals(round.hidden, false);
  assertEquals(round.steps.length, n);
});

Deno.test("opponents on another team are still withheld", async () => {
  const t = await makeRoom({ mode: "teams", teamCount: 2, finish: "everyone" }, ["ann", "bo"]);
  t.room.setTeam(ANN, ANN, 0);
  t.room.setTeam(ANN, BO, 1);
  t.room.start(ANN);
  play(t, BO, ["cat", "dog"]);

  const round = t.room.journeyFor(ANN, BO)!.rounds[0];
  assertEquals(round.hidden, true);
  assertEquals(round.steps, []);
});

Deno.test("a finished round survives into the next one", async () => {
  const t = await makeRoom({ mode: "rounds", totalRounds: 3, finish: "everyone" }, ["ann", "bo"]);
  t.room.start(ANN);
  const first = play(t, ANN, ["cat", "dog"]);
  t.room.endRound(ANN);
  t.room.next(ANN);
  assertEquals(t.room.round, 2);
  play(t, ANN, ["salt"]);

  const journey = t.room.journeyFor(ANN, ANN)!;
  assertEquals(journey.rounds.map((r) => r.number), [1, 2]);
  assertEquals(journey.rounds[0].steps.length, first, "round 1 kept its steps");
  assertEquals(journey.rounds[0].hidden, false);
  assertEquals(journey.rounds[1].hidden, false);
});

Deno.test("the secret stays out of history when reveal is switched off", async () => {
  const t = await makeRoom({ mode: "race", finish: "everyone", revealOnEnd: false }, ["ann", "bo"]);
  t.room.start(ANN);
  play(t, ANN, ["cat"]);
  t.room.endRound(ANN);
  assertEquals(t.room.journeyFor(ANN, ANN)!.rounds[0].secret, null);
});

Deno.test("hints appear in a journey, marked as hints", async () => {
  const t = await makeRoom(
    { mode: "race", finish: "everyone", hintsPerBoard: 2 },
    ["ann", "bo"],
  );
  t.room.start(ANN);
  play(t, ANN, ["cat"]);
  t.room.hint(ANN);

  const round = t.room.journeyFor(ANN, ANN)!.rounds[0];
  assertEquals(round.hints, 1);
  assertEquals(round.steps.filter((s) => s.hint).length, 1);
  // A hint is not a guess; counting it as one would flatter the player.
  assertEquals(round.guesses, 1);
});

Deno.test("totals add up across rounds", async () => {
  const t = await makeRoom({ mode: "rounds", totalRounds: 3, finish: "everyone" }, ["ann", "bo"]);
  t.room.start(ANN);
  const r1 = play(t, ANN, ["cat", "dog"]);
  t.solve(ANN);
  t.room.endRound(ANN);
  t.room.next(ANN);
  const r2 = play(t, ANN, ["salt"]);
  t.solve(ANN);
  t.room.endRound(ANN);

  const journey = t.room.journeyFor(ANN, ANN)!;
  assertEquals(journey.totals.solves, 2);
  assertEquals(journey.totals.guesses, r1 + r2 + 2, "the solving guess counts too");
  assertEquals(journey.totals.bestRank, 1);
  assert(journey.totals.score > 0);
});

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

Deno.test("solving opens your round to the room without being asked", async () => {
  const t = await makeRoom({ mode: "race", finish: "everyone" }, ["ann", "bo"]);
  t.room.start(ANN);
  const n = play(t, BO, ["cat", "dog"]);
  // Before they find it, their guesses are theirs.
  assertEquals(t.room.journeyFor(ANN, BO)!.rounds[0].hidden, true);
  t.solve(BO);
  // After, there is nothing left to protect — the answer is out.
  const round = t.room.journeyFor(ANN, BO)!.rounds[0];
  assertEquals(round.hidden, false);
  assertEquals(round.steps.length, n + 1);
});

Deno.test("a withheld live round says whether it is worth asking", async () => {
  const t = await makeRoom({ mode: "race", finish: "everyone" }, ["ann", "bo"]);
  t.room.start(ANN);
  play(t, BO, ["cat"]);
  assertEquals(t.room.journeyFor(ANN, BO)!.needsApproval, true);
  // Your own is never something you ask yourself for.
  assertEquals(t.room.journeyFor(ANN, ANN)!.needsApproval, false);
  // Nor is one nobody is there to answer for.
  t.room.disconnect(BO);
  assertEquals(t.room.journeyFor(ANN, BO)!.needsApproval, false);
});

Deno.test("approval opens the round; refusal changes nothing", async () => {
  const t = await makeRoom({ mode: "race", finish: "everyone" }, ["ann", "bo"]);
  t.room.start(ANN);
  const n = play(t, BO, ["cat", "dog"]);

  t.room.requestJourney(ANN, BO);
  t.room.decideJourney(BO, ANN, false);
  assertEquals(t.room.journeyFor(ANN, BO)!.rounds[0].hidden, true, "a no is a no");

  t.room.decideJourney(BO, ANN, true);
  const round = t.room.journeyFor(ANN, BO)!.rounds[0];
  assertEquals(round.hidden, false);
  assertEquals(round.steps.length, n);
});

Deno.test("consent is for this round only", async () => {
  const t = await makeRoom({ mode: "rounds", totalRounds: 3, finish: "everyone" }, ["ann", "bo"]);
  t.room.start(ANN);
  play(t, BO, ["cat"]);
  t.room.decideJourney(BO, ANN, true);
  assertEquals(t.room.journeyFor(ANN, BO)!.rounds[0].hidden, false);

  t.room.endRound(ANN);
  t.room.next(ANN);
  play(t, BO, ["dog"]);
  // Round 1 is history and open to everyone; round 2 needs asking again.
  const rounds = t.room.journeyFor(ANN, BO)!.rounds;
  assertEquals(rounds.length, 2);
  assertEquals(rounds[0].hidden, false);
  assertEquals(rounds[1].hidden, true);
});

Deno.test("asking is refused when there is nothing to ask for", async () => {
  const t = await makeRoom({ mode: "race", finish: "everyone" }, ["ann", "bo"]);
  assertThrows(() => t.room.requestJourney(ANN, BO), RoomError, "round is over");

  t.room.start(ANN);
  assertThrows(() => t.room.requestJourney(ANN, ANN), RoomError, "your own");
  t.solve(BO);
  assertThrows(() => t.room.requestJourney(ANN, BO), RoomError, "already see");
});

Deno.test("teammates never have to ask", async () => {
  const t = await makeRoom({ mode: "teams", teamCount: 2, finish: "everyone" }, ["ann", "bo"]);
  t.room.setTeam(ANN, ANN, 0);
  t.room.setTeam(ANN, BO, 0);
  t.room.start(ANN);
  play(t, BO, ["cat"]);
  assertEquals(t.room.journeyFor(ANN, BO)!.needsApproval, false);
  assertThrows(() => t.room.requestJourney(ANN, BO), RoomError, "already see");
});

Deno.test("a player who leaves cannot still be watched", async () => {
  const t = await makeRoom({ mode: "rounds", finish: "everyone" }, ["ann", "bo"]);
  t.room.start(ANN);
  play(t, BO, ["cat"]);
  t.room.decideJourney(BO, ANN, true);
  assertEquals(t.room.journeyFor(ANN, BO)!.rounds[0].hidden, false);
  t.room.remove(BO);
  // Their board went with them, so there is no live round left to show.
  assertEquals(t.room.journeyFor(ANN, BO), null);
});

Deno.test("an unknown player has no journey at all", async () => {
  const t = await makeRoom({}, ["ann"]);
  assertEquals(t.room.journeyFor(ANN, "nobody-here"), null);
});

Deno.test("a player who left keeps the journey they already ran", async () => {
  const t = await makeRoom({ mode: "rounds", totalRounds: 3, finish: "everyone" }, ["ann", "bo"]);
  t.room.start(ANN);
  const n = play(t, BO, ["cat", "dog"]);
  t.room.endRound(ANN);
  t.room.remove(BO);

  const journey = t.room.journeyFor(ANN, BO)!;
  assertEquals(journey.nickname, "bo", "the name comes from the record they left behind");
  assertEquals(journey.rounds.length, 1);
  assertEquals(journey.rounds[0].steps.length, n);
});
