// The emoji beside a word.
//
// The interesting property is not that it labels things — it is that it stays
// quiet. Every test here is really the same assertion from a different angle: a
// word only gets an icon when the embedding space is confident, because a
// confident mistake in a game about meaning is worse than a blank space.

import { assert, assertEquals } from "@std/assert";
import { createIconPicker, ICON_THRESHOLD, iconAnchors } from "../server/wordicon.ts";
import { Ranker } from "../server/ranker.ts";
import { idFor, loadTestPack, makeRoom } from "./helpers.ts";

async function picker() {
  return createIconPicker(new Ranker(await loadTestPack()));
}

Deno.test("every anchor word is one the pack can rank", async () => {
  const ranker = new Ranker(await loadTestPack());
  const missing = iconAnchors().filter((word) => !ranker.knows(word));
  // On the synthetic sample pack almost everything is missing and that is fine —
  // the picker drops them and simply yields fewer icons. On the real pack a
  // missing anchor is dead weight in the table, so it is worth knowing about.
  if (ranker.vocabSize >= 40_000) {
    assertEquals(missing, [], `anchors not in the pack: ${missing.join(" ")}`);
  }
});

Deno.test("no anchor word is claimed by two different emoji", () => {
  const seen = new Set<string>();
  const twice: string[] = [];
  for (const word of iconAnchors()) {
    if (seen.has(word)) twice.push(word);
    seen.add(word);
  }
  assertEquals(twice, [], `anchored twice, so the tie is decided by table order: ${twice}`);
});

Deno.test("a word that is its own anchor gets that anchor's emoji", async () => {
  const pick = await picker();
  const ranker = new Ranker(await loadTestPack());
  if (!ranker.knows("fire")) return; // sample pack
  assertEquals(pick("fire"), "🔥");
  assertEquals(pick("guitar"), "🎸");
});

Deno.test("a word with no plausible anchor gets nothing", async () => {
  const ranker = new Ranker(await loadTestPack());
  if (ranker.vocabSize < 40_000) return;
  const pick = createIconPicker(ranker);
  // Real words, all in the pack, none of them near an anchor. A picker that
  // labelled these would be labelling everything.
  for (const word of ["warranty", "democracy", "sundial", "whether"]) {
    assertEquals(pick(word), null, `${word} should have no icon`);
  }
});

Deno.test("the threshold is high enough to exclude mere association", async () => {
  const ranker = new Ranker(await loadTestPack());
  if (ranker.vocabSize < 40_000) return;
  // Pairs that produced wrong icons during calibration and that the *threshold* is
  // what stops: if it ever drops below these, `content` gets a spider and `page`
  // gets a chain.
  for (const [a, b] of [["content", "web"], ["page", "link"], ["fire", "democracy"]]) {
    const sim = ranker.similarity(a, b);
    assert(sim !== null, `${a}/${b} should both be in the pack`);
    assert(
      sim < ICON_THRESHOLD,
      `${a}/${b} at ${sim.toFixed(2)} is above the ${ICON_THRESHOLD} threshold`,
    );
  }
});

Deno.test("words with a second meaning are not used as anchors", async () => {
  const ranker = new Ranker(await loadTestPack());
  const anchors = new Set(iconAnchors());
  // These are the ones no threshold can save, which is the point of the test.
  // `saw` scores 0.68 against `took` — well inside the synonym band — because it
  // is the past tense of `see` as well as a tool. Each of these was tried, put a
  // confidently wrong icon on a common word, and was replaced by an unambiguous
  // cousin.
  for (const word of ["saw", "web", "key", "boot", "rock", "slow", "hot", "cold", "dark"]) {
    assert(!anchors.has(word), `"${word}" has a second meaning and cannot be an anchor`);
  }
  if (ranker.vocabSize >= 40_000) {
    const sim = ranker.similarity("took", "saw");
    assert(sim !== null && sim > ICON_THRESHOLD, "the trap this guards against is real");
  }
});

Deno.test("the same call twice is the same answer", async () => {
  const pick = await picker();
  // Memoised, so this is really checking the memo does not corrupt itself — a
  // null result has to be remembered as "no icon" rather than as "not asked yet".
  assertEquals(pick("democracy"), pick("democracy"));
  assertEquals(pick("fire"), pick("fire"));
});

Deno.test("a guess row carries its icon, and a room without a picker carries none", async () => {
  const plain = await makeRoom({ mode: "race" }, ["ann"]);
  plain.room.start(idFor("ann"));
  plain.room.guess(idFor("ann"), "fire");
  const noIcon = plain.room.viewFor(idFor("ann")).board!.guesses.at(-1)!;
  assertEquals(noIcon.icon, undefined, "no picker was wired in, so no icon");

  const withIcons = await makeRoom({ mode: "race" }, ["ann"], {
    icon: createIconPicker(new Ranker(await loadTestPack())),
  });
  withIcons.room.start(idFor("ann"));
  withIcons.room.guess(idFor("ann"), "fire");
  const row = withIcons.room.viewFor(idFor("ann")).board!.guesses.at(-1)!;
  if (withIcons.ranker.vocabSize >= 40_000) assertEquals(row.icon, "🔥");
});
