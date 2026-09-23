// Buzz, reactions and bought hints.
//
// All four are jokes, and all four are enforced on the server, because a joke
// rule that only exists in the browser is not a rule.

import { assertEquals, assertThrows } from "@std/assert";
import { Room, RoomError } from "../server/room.ts";
import type { ReactionKind, ReactionTally } from "../shared/protocol.ts";
import {
  BUZZ_COOLDOWN_MS,
  REACTION_KEYS,
  REACTION_MAX_PER_SENDER,
  REACTION_WINDOW_MS,
  REACTIONS_PER_WINDOW,
} from "../shared/constants.js";
import { idFor, makeRoom } from "./helpers.ts";

const ANN = idFor("ann");
const BO = idFor("bo");
const CY = idFor("cy");

// ---------------------------------------------------------------------------
// Buzz
// ---------------------------------------------------------------------------

Deno.test("a buzz reaches the whole room, buzzer included", async () => {
  const t = await makeRoom({}, ["ann", "bo", "cy"]);
  const { nickname, recipients } = t.room.buzz(ANN);
  assertEquals(nickname, "ann");
  // Ann is in her own list: a button that visibly does nothing on your own
  // screen reads as broken, and you cannot see anyone else's window jump.
  assertEquals(recipients.sort(), [ANN, BO, CY].sort());
});

Deno.test("buzzing alone does nothing at all", async () => {
  const t = await makeRoom({}, ["ann"]);
  assertThrows(() => t.room.buzz(ANN), RoomError, "nobody else here");
});

Deno.test("a disconnected player is not buzzed", async () => {
  const t = await makeRoom({ mode: "rounds" }, ["ann", "bo", "cy"]);
  t.room.start(ANN);
  t.room.disconnect(BO);
  assertEquals(t.room.buzz(ANN).recipients.sort(), [ANN, CY].sort());
});

Deno.test("buzz has a cooldown, and it expires", async () => {
  const t = await makeRoom({}, ["ann", "bo"]);
  t.room.buzz(ANN);
  assertThrows(() => t.room.buzz(ANN), RoomError, "before buzzing again");
  // Somebody else's buzz is their own business.
  t.room.buzz(BO);
  t.advance(BUZZ_COOLDOWN_MS);
  t.room.buzz(ANN);
});

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

/**
 * What one kind has landed on somebody, as a plain array.
 *
 * A kind nobody has thrown is absent from the wire rather than an empty array —
 * the common case is three of the four — so the tests say `[]` and this is where
 * that translation happens.
 */
function thrown(room: Room, playerId: string, kind: ReactionKind): ReactionTally[] {
  const player = room.publicPlayers().find((p) => p.id === playerId);
  if (!player) throw new Error(`no player ${playerId}`);
  return player.reactions[kind] ?? [];
}

Deno.test("roses and eggs land on the target and name the sender", async () => {
  const t = await makeRoom({}, ["ann", "bo", "cy"]);
  t.room.react(ANN, BO, "rose");
  t.room.react(CY, BO, "egg");
  assertEquals(thrown(t.room, BO, "rose"), [{ nickname: "ann", count: 1 }]);
  assertEquals(thrown(t.room, BO, "egg"), [{ nickname: "cy", count: 1 }]);
  // Nobody else picked anything up.
  assertEquals(thrown(t.room, ANN, "rose"), []);
  assertEquals(thrown(t.room, ANN, "egg"), []);
});

Deno.test("the work reactions tally separately from the pantomime ones", async () => {
  const t = await makeRoom({}, ["ann", "bo", "cy"]);
  t.room.react(ANN, BO, "escalated");
  t.room.react(ANN, BO, "escalated");
  t.room.react(CY, BO, "blocker");
  t.room.react(CY, BO, "rose");
  const bo = t.room.publicPlayers().find((p) => p.id === BO)!;
  assertEquals(bo.reactions.escalated, [{ nickname: "ann", count: 2 }]);
  assertEquals(bo.reactions.blocker, [{ nickname: "cy", count: 1 }]);
  assertEquals(bo.reactions.rose, [{ nickname: "cy", count: 1 }]);
  // Four kinds declared, but only what was actually thrown is on the wire.
  assertEquals(Object.keys(bo.reactions).sort(), ["blocker", "escalated", "rose"]);
  assertEquals(t.room.publicPlayers().find((p) => p.id === ANN)!.reactions, {});
});

Deno.test("every declared reaction is throwable, and nothing else is", async () => {
  const t = await makeRoom({}, ["ann", "bo"]);
  for (const kind of REACTION_KEYS) {
    t.advance(REACTION_WINDOW_MS);
    t.room.react(ANN, BO, kind);
    assertEquals(thrown(t.room, BO, kind), [{ nickname: "ann", count: 1 }]);
  }
  assertThrows(
    () => t.room.react(ANN, BO, "trophy" as ReactionKind),
    RoomError,
    "No such reaction",
  );
});

Deno.test("throwing is unlimited, and the tally counts per sender", async () => {
  const t = await makeRoom({}, ["ann", "bo", "cy"]);
  for (let i = 0; i < 3; i++) t.room.react(ANN, BO, "egg");
  t.room.react(CY, BO, "egg");
  // Sorted by count, so the hover detail leads with whoever is worst.
  assertEquals(thrown(t.room, BO, "egg"), [
    { nickname: "ann", count: 3 },
    { nickname: "cy", count: 1 },
  ]);
  assertThrows(() => t.room.react(ANN, ANN, "rose"), RoomError, "at yourself");
});

Deno.test("a barrage is rate limited, not banned", async () => {
  const t = await makeRoom({}, ["ann", "bo"]);
  for (let i = 0; i < REACTIONS_PER_WINDOW; i++) t.room.react(ANN, BO, "egg");
  assertThrows(() => t.room.react(ANN, BO, "egg"), RoomError, "Out of ammunition");
  // The limit is a rhythm, not a quota: it lets go again once the window passes.
  t.advance(REACTION_WINDOW_MS);
  t.room.react(ANN, BO, "egg");
  assertEquals(thrown(t.room, BO, "egg")[0].count, REACTIONS_PER_WINDOW + 1);
});

Deno.test("one sender's tally stops climbing at the cap", async () => {
  const t = await makeRoom({}, ["ann", "bo"]);
  // Well past the cap, in bursts the rate limit allows, so the only thing that
  // can stop the number is the cap itself.
  for (let i = 0; i < REACTION_MAX_PER_SENDER + 20; i++) {
    if (i % REACTIONS_PER_WINDOW === 0) t.advance(REACTION_WINDOW_MS);
    t.room.react(ANN, BO, "rose");
  }
  assertEquals(thrown(t.room, BO, "rose"), [
    { nickname: "ann", count: REACTION_MAX_PER_SENDER },
  ]);
});

Deno.test("reactions clear when the next round starts", async () => {
  const t = await makeRoom({ mode: "rounds", totalRounds: 3, finish: "everyone" }, ["ann", "bo"]);
  t.room.start(ANN);
  t.room.react(ANN, BO, "egg");
  assertEquals(thrown(t.room, BO, "egg"), [{ nickname: "ann", count: 1 }]);
  t.room.endRound(ANN);
  t.room.next(ANN);
  assertEquals(thrown(t.room, BO, "egg"), []);
});

Deno.test("a departing player takes their reactions with them", async () => {
  const t = await makeRoom({ mode: "rounds", finish: "everyone" }, ["ann", "bo", "cy"]);
  t.room.start(ANN);
  t.room.react(ANN, BO, "rose");
  t.room.react(CY, BO, "rose");
  assertEquals(thrown(t.room, BO, "rose").length, 2);
  t.room.remove(ANN);
  // Not merely unresolvable — actually gone, so a long-lived room does not
  // accumulate ids belonging to nobody.
  assertEquals(thrown(t.room, BO, "rose"), [{ nickname: "cy", count: 1 }]);
});

// ---------------------------------------------------------------------------
// Extra hints
// ---------------------------------------------------------------------------

Deno.test("an extra hint costs a drink, but only once the free ones are gone", async () => {
  const t = await makeRoom(
    { mode: "race", finish: "everyone", hintsPerBoard: 1, extraHints: true },
    ["ann", "bo"],
  );
  t.room.start(ANN);
  assertThrows(() => t.room.extraHint(ANN), RoomError, "use those first");
  t.room.hint(ANN);
  const bought = t.room.extraHint(ANN);
  assertEquals(bought.drinks, 1);
  assertEquals(t.room.publicPlayers().find((p) => p.id === ANN)!.drinks, 1);
  assertEquals(t.room.extraHint(ANN).drinks, 2);
  // The tab is personal: buying one does not put a drink on anyone else.
  assertEquals(t.room.publicPlayers().find((p) => p.id === BO)!.drinks, 0);
});

Deno.test("extra hints can be switched off for the match", async () => {
  const t = await makeRoom(
    { mode: "race", finish: "everyone", hintsPerBoard: 0, extraHints: false },
    ["ann", "bo"],
  );
  t.room.start(ANN);
  assertThrows(() => t.room.extraHint(ANN), RoomError, "switched off");
});

Deno.test("the drinks tab survives the round but not the match", async () => {
  const t = await makeRoom(
    { mode: "rounds", totalRounds: 3, finish: "everyone", hintsPerBoard: 0 },
    ["ann", "bo"],
  );
  t.room.start(ANN);
  t.room.extraHint(ANN);
  t.room.endRound(ANN);
  t.room.next(ANN);
  assertEquals(
    t.room.publicPlayers().find((p) => p.id === ANN)!.drinks,
    1,
    "a tab you can round-trip away is not a tab",
  );
  t.room.reset(ANN);
  assertEquals(t.room.publicPlayers().find((p) => p.id === ANN)!.drinks, 0);
});

// ---------------------------------------------------------------------------
// Who sees a throw
// ---------------------------------------------------------------------------

Deno.test("a throw is announced to the whole room, thrower included", async () => {
  const t = await makeRoom({}, ["ann", "bo", "cy"]);
  const out = t.room.react(ANN, BO, "egg");
  assertEquals(out.actorNickname, "ann");
  assertEquals(out.targetNickname, "bo");
  // Both counters go out with the event: the browser needs them to decide how
  // big to make it, and neither can be inferred from the snapshot in time.
  assertEquals(out.count, 1);
  assertEquals(out.total, 1);
  // Everyone animates the same throw: the target because it is aimed at them,
  // the thrower because watching it land is the point, and the rest because a
  // room where things fly past is more fun than a room of quiet counters.
  assertEquals(out.audience.sort(), [ANN, BO, CY].sort());
});

Deno.test("a throw is not announced to somebody who has dropped off", async () => {
  const t = await makeRoom({ mode: "rounds" }, ["ann", "bo", "cy"]);
  t.room.start(ANN);
  t.room.disconnect(CY);
  assertEquals(t.room.react(ANN, BO, "rose").audience.sort(), [ANN, BO].sort());
});
