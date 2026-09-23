// The domain terms we composed vectors for, and the guess box that has to accept
// them.
//
// The bug these guard against was reported as "rebuild the custom word list,
// because rma is a word people guess". The list was never the problem: guesses
// are ranked against data/vectors.bin, so a word missing from the pack is
// unguessable whatever any pool says. scripts/extend_pack.ts appends a composed
// vector for each term in data/terms-custom.txt; these tests fail if that pack
// is ever rebuilt from the raw corpus without re-running it.

import { assert, assertEquals } from "@std/assert";
import { Ranker, readWordList } from "../server/ranker.ts";
import { DIFFICULTIES } from "../shared/constants.js";
import { idFor, loadTestPack, makeRoom } from "./helpers.ts";

const TERMS_PATH = "data/terms-custom.txt";

async function termList(): Promise<string[]> {
  const text = await Deno.readTextFile(TERMS_PATH);
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.slice(0, line.indexOf("=")).trim().toLowerCase());
}

Deno.test("every domain term can be guessed", async () => {
  const ranker = new Ranker(await loadTestPack());
  const terms = await termList();
  assert(terms.length > 20, `${TERMS_PATH} looks empty: ${terms.length} terms`);

  const missing = terms.filter((term) => !ranker.knows(term));
  assertEquals(
    missing,
    [],
    `not in the pack — run: deno task pack:terms --write\n  ${missing.join(" ")}`,
  );
});

Deno.test("a composed term ranks near the words that explain it", async () => {
  const ranker = new Ranker(await loadTestPack());
  // rma = return merchandise authorization warranty repair. Guessed against a
  // secret drawn from its own expansion it should be close, and a word from
  // nowhere near it should not be. Asserted as an ordering rather than an
  // absolute rank, because the sample pack ranks everything differently.
  const near = ranker.rank("warranty", "rma");
  const far = ranker.rank("warranty", "banana");
  assert(near !== null && far !== null, "both guesses should be in the pack");
  assert(near < far, `rma (${near}) should beat banana (${far}) for "warranty"`);
});

Deno.test("the terms are answers as well as guesses, past the easy window", async () => {
  const words = await readWordList("data/words-custom.txt");
  assert(words, "the custom pool should exist");
  const listed = new Set(words);
  const terms = (await termList()).filter((t) => t.length >= 3);
  const absent = terms.filter((t) => !listed.has(t));
  assertEquals(absent, [], `missing from the custom pool: ${absent.join(" ")}`);

  // Frequency order is load-bearing: difficulty reads a prefix of the pool, so an
  // acronym we composed a vector for must not be reachable as an easy secret. A
  // handful of these terms — `ticket`, `patch`, `usb` — were curated into the
  // pool from Confluence long before this file existed and keep their earned
  // place; the appended ones are what has to sit past the window.
  const easy = new Set(words.slice(0, DIFFICULTIES.easy.poolLimit));
  const appended = (await Deno.readTextFile("data/words-custom.txt"))
    .split("scripts/extend_pack.ts")[1]
    ?.split("\n")
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l && !l.startsWith("#")) ?? [];
  assert(appended.length > 20, `expected an appended block, found ${appended.length} words`);
  const tooEarly = appended.filter((w) => easy.has(w));
  assertEquals(tooEarly, [], `appended terms inside the easy window: ${tooEarly.join(" ")}`);
});

Deno.test("the guess box takes digits, but not digits alone", async () => {
  const { room } = await makeRoom({ mode: "race" }, ["Ann"]);
  const id = idFor("Ann");
  room.start(id);

  const withDigits = room.guess(id, "2fa");
  assert(
    withDigits.accepted,
    `"2fa" should be a legal guess, got ${!withDigits.accepted && withDigits.reason}`,
  );

  const digitsOnly = room.guess(id, "42");
  assert(!digitsOnly.accepted, `"42" is not a word`);
  assertEquals(digitsOnly.reason, "invalid");

  const punctuation = room.guess(id, "k8s!");
  assert(!punctuation.accepted, `"k8s!" is not a word`);
  assertEquals(punctuation.reason, "invalid");
});
