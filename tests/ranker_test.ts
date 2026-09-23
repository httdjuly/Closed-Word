import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { decodePack, encodePack, normaliseRow } from "../server/vectorpack.ts";
import { Ranker } from "../server/ranker.ts";
import { loadTestPack } from "./helpers.ts";

Deno.test("pack round-trips words, dims and the sample flag", () => {
  const dim = 4;
  const words = ["alpha", "beta", "gamma"];
  const matrix = new Float32Array([
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0.5,
    0.5,
    0,
    0,
  ]);
  for (let i = 0; i < words.length; i++) normaliseRow(matrix, i * dim, dim);

  const decoded = decodePack(encodePack(words, matrix, dim, true));
  assertEquals(decoded.words, words);
  assertEquals(decoded.dim, dim);
  assertEquals(decoded.count, 3);
  assertEquals(decoded.sample, true);
  assertEquals(decoded.index.get("gamma"), 2);
  // Rows survive normalisation and the round trip.
  assertAlmostEquals(decoded.matrix[0], 1, 1e-6);
  assertAlmostEquals(decoded.matrix[8], Math.SQRT1_2, 1e-6);
});

Deno.test("pack rejects corrupt input", () => {
  assertThrows(() => decodePack(new Uint8Array(8)), Error, "truncated");
  const bad = encodePack(["a", "b"], new Float32Array([1, 0, 0, 1]), 2, false);
  bad[0] = 0x58; // clobber the magic
  assertThrows(() => decodePack(bad), Error, "not a vector pack");
});

Deno.test("ranks are a total order with the secret at rank 1", async () => {
  const ranker = new Ranker(await loadTestPack());
  const secret = "cat";
  assertEquals(ranker.rank(secret, secret), 1);

  const table = ranker.table(secret);
  const seen = new Set<number>();
  for (let i = 0; i < table.rankOf.length; i++) {
    const rank = table.rankOf[i];
    assert(rank >= 1 && rank <= table.rankOf.length, `rank ${rank} out of range`);
    assert(!seen.has(rank), `duplicate rank ${rank}`);
    seen.add(rank);
  }
  assertEquals(seen.size, ranker.vocabSize);
});

Deno.test("semantically related words outrank unrelated ones", async () => {
  const ranker = new Ranker(await loadTestPack());
  const near = ranker.rank("cat", "kitten")!;
  const sameDomain = ranker.rank("cat", "eagle")!;
  const far = ranker.rank("cat", "firewall")!;
  assert(near < sameDomain, `kitten (${near}) should beat eagle (${sameDomain})`);
  assert(sameDomain < far, `eagle (${sameDomain}) should beat firewall (${far})`);
});

Deno.test("unknown words rank as null rather than throwing", async () => {
  const ranker = new Ranker(await loadTestPack());
  assertEquals(ranker.rank("cat", "zzzzzqqqq"), null);
  assertEquals(ranker.knows("zzzzzqqqq"), false);
  assertEquals(ranker.knows("cat"), true);
});

Deno.test("nearest excludes the secret and is ordered", async () => {
  const ranker = new Ranker(await loadTestPack());
  const nearest = ranker.nearest("coffee", 6);
  assertEquals(nearest.length, 6);
  assert(!nearest.includes("coffee"));
  const ranks = nearest.map((w) => ranker.rank("coffee", w)!);
  for (let i = 1; i < ranks.length; i++) {
    assert(ranks[i] > ranks[i - 1], `nearest not ordered: ${ranks.join(",")}`);
  }
});

Deno.test("hints get closer, never repeat, and never exceed the ceiling", async () => {
  const ranker = new Ranker(await loadTestPack());
  const secret = "coffee";
  const taken = new Set<string>();
  let ceiling = 300;
  let previous = Infinity;

  for (let i = 0; i < 3; i++) {
    const target = Math.max(2, Math.round(ceiling * 0.5));
    const word = ranker.hintAt(secret, target, taken, ceiling);
    assert(word, `hint ${i} should exist`);
    const rank = ranker.rank(secret, word)!;
    assert(rank >= 2, "a hint must never be the answer");
    assert(rank < ceiling, `hint rank ${rank} must beat the ceiling ${ceiling}`);
    assert(rank < previous, `hint ${i} (${rank}) should be closer than the last (${previous})`);
    taken.add(word);
    previous = rank;
    ceiling = rank;
  }
});

Deno.test("hintAt returns null when there is no room below the ceiling", async () => {
  const ranker = new Ranker(await loadTestPack());
  assertEquals(ranker.hintAt("cat", 5, new Set(), 2), null);
});

Deno.test("wordAtRank agrees with rank", async () => {
  const ranker = new Ranker(await loadTestPack());
  for (const rank of [1, 2, 17, 120]) {
    const word = ranker.wordAtRank("cat", rank);
    assert(word);
    assertEquals(ranker.rank("cat", word), rank);
  }
  assertEquals(ranker.wordAtRank("cat", 0), null);
  assertEquals(ranker.wordAtRank("cat", 1e9), null);
});

Deno.test("secret pool honours difficulty and the exclude set", async () => {
  const pack = await loadTestPack();
  // A token no corpus contains. "alpha" used to serve here, but it is a real word
  // and appears in the full fastText pack, so the assertion only held while the
  // tests happened to run on the tiny sample pack.
  const notAWord = "qqzzxnotaword";
  const ranker = new Ranker(pack, { secretPool: [notAWord, "cat", "dog", "coffee"] });
  // Words outside the vocabulary are dropped from a supplied pool.
  const picks = new Set<string>();
  for (let i = 0; i < 60; i++) picks.add(ranker.pickSecret("easy"));
  assert(!picks.has(notAWord), "a word absent from the pack must never be picked");

  const excluded = ranker.pickSecret("easy", ["cat", "dog"]);
  assertEquals(excluded, "coffee");
});

Deno.test("rank table cache evicts oldest entries", async () => {
  const ranker = new Ranker(await loadTestPack(), { cacheSize: 2 });
  ranker.table("cat");
  ranker.table("dog");
  assertEquals(ranker.stats().cachedTables, 2);
  ranker.table("coffee");
  assertEquals(ranker.stats().cachedTables, 2);
  // Still correct after eviction — the table is simply rebuilt.
  assertEquals(ranker.rank("cat", "cat"), 1);
});
