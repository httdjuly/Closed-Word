import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import { isAdultSource, WORD_SOURCE_KEYS, WORD_SOURCES } from "../shared/constants.js";
import { Ranker, readWordList } from "../server/ranker.ts";
import { Room, RoomError, wordSourceStatuses } from "../server/room.ts";
import { idFor, loadTestPack } from "./helpers.ts";

/** A ranker with all three pools populated from words the sample pack contains. */
async function rankerWithPools() {
  return new Ranker(await loadTestPack(), {
    pools: {
      custom: ["password", "firewall", "encryption", "malware", "server", "database", "network"],
      ai: ["guitar", "violin", "piano", "trumpet"],
    },
  });
}

function roomWith(ranker: Ranker, config: Record<string, unknown>) {
  const room = new Room("SRC001", config, { ranker, onChange: () => {} });
  return room;
}

Deno.test("pools drop words the embedding pack cannot rank", async () => {
  const ranker = new Ranker(await loadTestPack(), {
    pools: { custom: ["firewall", "notarealwordxyz", "malware"] },
  });
  assertEquals(ranker.pool("custom"), ["firewall", "malware"]);
});

Deno.test("pools dedupe and normalise but keep frequency order", async () => {
  const ranker = new Ranker(await loadTestPack(), {
    pools: { custom: ["  Firewall ", "malware", "FIREWALL", "server"] },
  });
  assertEquals(ranker.pool("custom"), ["firewall", "malware", "server"]);
});

Deno.test("an unknown or empty source reports unavailable rather than throwing", async () => {
  const ranker = await rankerWithPools();
  assertEquals(ranker.hasPool("closeword"), true);
  assertEquals(ranker.hasPool("custom"), true);
  assertEquals(ranker.hasPool("nonsense"), false);
  assertThrows(() => ranker.pickSecret("normal", [], "nonsense"), Error, "no usable words");
});

Deno.test("secrets come from the selected pool, for every game mode", async () => {
  const ranker = await rankerWithPools();
  const customWords = new Set(ranker.pool("custom"));

  for (const mode of ["race", "rounds", "teams", "coop"] as const) {
    const room = roomWith(ranker, { mode, wordSource: "custom", graceSeconds: 0 });
    room.join(idFor("ann"), "ann");
    room.join(idFor("bo"), "bo");
    room.start(idFor("ann"));
    assert(
      customWords.has(room.secret!),
      `${mode}: secret ${room.secret} is not from the custom pool`,
    );
    room.endRound();
  }
});

Deno.test("the AI pool works across modes too", async () => {
  const ranker = await rankerWithPools();
  const aiWords = new Set(ranker.pool("ai"));
  for (const mode of ["race", "teams", "coop"] as const) {
    const room = roomWith(ranker, { mode, wordSource: "ai", graceSeconds: 0 });
    room.join(idFor("ann"), "ann");
    room.start(idFor("ann"));
    assert(aiWords.has(room.secret!), `${mode}: ${room.secret} is not from the AI pool`);
  }
});

Deno.test("starting on an unavailable source fails in the lobby with advice", async () => {
  const ranker = new Ranker(await loadTestPack());
  const room = roomWith(ranker, { wordSource: "custom" });
  room.join(idFor("ann"), "ann");
  assertThrows(
    () => room.start(idFor("ann")),
    RoomError,
    "Pick a different word source",
  );
  // The room is still usable — nothing was half-started.
  assertEquals(room.phase, "lobby");
  room.setConfig(idFor("ann"), { wordSource: "closeword" });
  room.start(idFor("ann"));
  assertEquals(room.phase, "playing");
});

Deno.test("an invalid word source falls back to closeword", async () => {
  const ranker = await rankerWithPools();
  // deno-lint-ignore no-explicit-any
  const room = roomWith(ranker, { wordSource: "sabotage" as any });
  assertEquals(room.config.wordSource, "closeword");
});

Deno.test("word source survives a config change and is reported to clients", async () => {
  const ranker = await rankerWithPools();
  const room = roomWith(ranker, {});
  const ann = idFor("ann");
  room.join(ann, "ann");
  room.setConfig(ann, { wordSource: "custom" });
  const view = room.viewFor(ann);
  assertEquals(view.config.wordSource, "custom");
  const custom = view.wordSources.find((s) => s.key === "custom")!;
  assertEquals(custom.available, true);
  assertEquals(custom.size, 7);
});

Deno.test("status reporting explains why a source is unavailable", async () => {
  const ranker = new Ranker(await loadTestPack());
  const statuses = wordSourceStatuses(ranker);
  // One per declared source, whether or not this server has words for it — the
  // lobby needs to show an unavailable set as unavailable, not omit it.
  assertEquals(statuses.length, WORD_SOURCE_KEYS.length);
  const closeword = statuses.find((s) => s.key === "closeword")!;
  assertEquals(closeword.available, true);
  const custom = statuses.find((s) => s.key === "custom")!;
  assertEquals(custom.available, false);
  assertEquals(custom.size, 0);
  assert(custom.note.includes("data/words-custom.txt"), custom.note);
});

// ---------------------------------------------------------------------------
// Hints must stay relevant to the source in play
// ---------------------------------------------------------------------------

Deno.test("hints prefer the themed pool when a themed source is in play", async () => {
  const ranker = await rankerWithPools();
  // "malware" sits in the computing cluster of the sample pack, as do the other
  // custom pool words, so an on-theme hint is genuinely available.
  const themed = ranker.hintAt("malware", 40, new Set(), Number.POSITIVE_INFINITY, "custom");
  assert(themed, "expected a hint");
  assert(
    ranker.pool("custom").includes(themed),
    `hint "${themed}" should have come from the custom pool`,
  );
});

Deno.test("hints fall back to the full vocabulary when the pool has nothing in range", async () => {
  const ranker = await rankerWithPools();
  // A secret from a completely different domain: no AI-pool word is near it.
  const hint = ranker.hintAt("kitten", 5, new Set(), Number.POSITIVE_INFINITY, "ai");
  assert(hint, "a hint must still be produced");
  assert(!ranker.pool("ai").includes(hint), "this one should be off-pool by necessity");
});

Deno.test("a themed hint still respects the ceiling and never leaks the answer", async () => {
  const ranker = await rankerWithPools();
  const secret = "firewall";
  const taken = new Set<string>();
  let ceiling = 200;
  for (let i = 0; i < 3; i++) {
    const word = ranker.hintAt(secret, Math.round(ceiling / 2), taken, ceiling, "custom");
    if (!word) break;
    const rank = ranker.rank(secret, word)!;
    assert(rank >= 2, "a hint must never be the answer");
    assert(rank < ceiling, `hint rank ${rank} must beat ceiling ${ceiling}`);
    taken.add(word);
    ceiling = rank;
  }
});

Deno.test("hints in shared modes are spent from the board's allowance", async () => {
  const ranker = await rankerWithPools();
  const room = roomWith(ranker, { mode: "coop", wordSource: "custom", hintsPerBoard: 2 });
  room.join(idFor("ann"), "ann");
  room.join(idFor("bo"), "bo");
  room.start(idFor("ann"));
  room.hint(idFor("ann"));
  // Bo sees the allowance already reduced, because it is the board's, not theirs.
  assertEquals(room.viewFor(idFor("bo")).board?.hintsLeft, 1);
  room.hint(idFor("bo"));
  assertThrows(() => room.hint(idFor("ann")), RoomError, "No hints left");
});

Deno.test("the clue provider is told which source the word came from", async () => {
  const ranker = await rankerWithPools();
  let sawSource: string | undefined;
  const room = new Room("SRC002", {
    wordSource: "custom",
    aiClues: true,
    hintsPerBoard: 1,
  }, {
    ranker,
    clueProvider: {
      clue: (_secret, context) => {
        sawSource = context.wordSource;
        return Promise.resolve("a themed clue");
      },
    },
    onChange: () => {},
  });
  const ann = idFor("ann");
  room.join(ann, "ann");
  room.start(ann);
  room.hint(ann);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assertEquals(sawSource, "custom");
});

Deno.test("the after-dark pool is declared, tagged, and free of the deny list", async () => {
  const words = await readWordList(WORD_SOURCES.adult.file!);
  assert(words && words.length > 0, "data/words-adult.txt should ship with the repo");
  assertEquals(isAdultSource("adult"), true);
  assertEquals(isAdultSource("closeword"), false);

  // The pool is hand-tagged, so this is a guard against a careless edit rather
  // than a filter: anything here means somebody added a word the category rules
  // out, and the point of the file is what it leaves out.
  const banned = [
    "rape",
    "molest",
    "incest",
    "pedo",
    "child",
    "teen",
    "slut",
    "whore",
    "prostitute",
    "porn",
    "abuse",
    "assault",
  ];
  for (const word of words) {
    assertEquals(word, word.trim().toLowerCase(), "pool words are normalised");
    assertFalse(word.includes(" "), `"${word}" has a space; the ranker scores single words`);
    for (const bad of banned) {
      assertFalse(word.includes(bad), `"${word}" must not be in the after-dark pool`);
    }
  }
});
