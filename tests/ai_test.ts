import { assert, assertEquals } from "@std/assert";
import { clueLeaksSecret } from "../server/ai_core.ts";
import { idFor, makeRoom } from "./helpers.ts";
import type { ClueProvider } from "../server/room.ts";

Deno.test("the leak guard catches a clue containing the answer", () => {
  assert(clueLeaksSecret("It is a mountain range", "mountain"));
  assert(clueLeaksSecret("Think about MOUNTAINS", "mountain"), "case and plural");
  assert(clueLeaksSecret("mountainous terrain", "mountain"), "shared stem");
  assert(clueLeaksSecret("Coffee is the answer", "coffee"));
});

Deno.test("the leak guard allows a genuine clue", () => {
  assertEquals(
    clueLeaksSecret("A tall landform you might climb at the weekend", "mountain"),
    false,
  );
  assertEquals(clueLeaksSecret("The drink that gets offices moving", "coffee"), false);
  assertEquals(clueLeaksSecret("A small domestic predator that purrs", "cat"), false);
});

Deno.test("the leak guard does not flag short unrelated words", () => {
  // "cat" is only three characters, so prefix matching must not fire on "cart".
  assertEquals(clueLeaksSecret("Push the cart along", "cat"), false);
});

Deno.test("a clue reaches the board that asked for it", async () => {
  const provider: ClueProvider = {
    clue: () => Promise.resolve("A drink that gets offices moving"),
  };
  const t = await makeRoom({ aiClues: true, hintsPerBoard: 2 }, ["ann"]);
  // makeRoom does not wire a provider, so install one for this test.
  const room = new (await import("../server/room.ts")).Room("CLUE01", {
    aiClues: true,
    hintsPerBoard: 2,
  }, {
    ranker: t.ranker,
    clueProvider: provider,
    onChange: () => {},
  });
  const ann = idFor("ann");
  room.join(ann, "ann");
  room.start(ann);
  room.hint(ann);
  // The provider is intentionally fire-and-forget, so let the microtask land.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assertEquals(room.viewFor(ann).board?.clue, "A drink that gets offices moving");
});

Deno.test("a failing clue provider never breaks the hint", async () => {
  const provider: ClueProvider = {
    clue: () => Promise.reject(new Error("claude exploded")),
  };
  const t = await makeRoom();
  const room = new (await import("../server/room.ts")).Room("CLUE02", {
    aiClues: true,
    hintsPerBoard: 2,
  }, {
    ranker: t.ranker,
    clueProvider: provider,
    onChange: () => {},
  });
  const ann = idFor("ann");
  room.join(ann, "ann");
  room.start(ann);
  // The hint itself must still succeed and land on the board.
  const hint = room.hint(ann);
  assert(hint.rank > 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assertEquals(room.viewFor(ann).board?.clue, null);
  assertEquals(room.viewFor(ann).board?.guesses.length, 1);
});

Deno.test("clues are not requested when the setting is off", async () => {
  let calls = 0;
  const provider: ClueProvider = {
    clue: () => {
      calls++;
      return Promise.resolve("nope");
    },
  };
  const t = await makeRoom();
  const room = new (await import("../server/room.ts")).Room("CLUE03", {
    aiClues: false,
    hintsPerBoard: 2,
  }, {
    ranker: t.ranker,
    clueProvider: provider,
    onChange: () => {},
  });
  const ann = idFor("ann");
  room.join(ann, "ann");
  room.start(ann);
  room.hint(ann);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assertEquals(calls, 0);
});
