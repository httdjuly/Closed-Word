#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * Build a themed word pool by tag-filtering the embedding lexicon.
 *
 *   deno task tag:adult              # print the pool that would be written
 *   deno task tag:adult --write      # write data/words-adult.txt
 *   deno task tag:adult --candidates # print near neighbours for review
 *
 * ## Why this is not just a list
 *
 * The "after dark" pool exists because somebody asked for one, and a pool like
 * that is the one place in this codebase where *what is left out* matters more
 * than what is in. So the design is deliberately two-layered:
 *
 *   1. A **tag list** — the `TAGS` table below — hand-written, grouped by what
 *      each word is (anatomy, sex, euphemism, romance, nightlife). Every word in
 *      the shipped pool comes from here. Nothing is generated into the pool.
 *   2. A **filter** that keeps only tags the embedding pack can actually rank,
 *      because an unrankable secret is an unplayable round. That is the same
 *      rule every other pool obeys; it is applied here at build time so the
 *      committed file is already known-good.
 *
 * `--candidates` runs the nearest-neighbour expansion *without* writing
 * anything: it prints what the embedding space thinks is adjacent to the tags,
 * for a person to read and cherry-pick by hand. That asymmetry is the point.
 * Automatic expansion in a category like this reliably surfaces slurs and
 * degrading terms, because that is what sits next to sex words in a web corpus,
 * and no similarity threshold distinguishes a slur from a synonym. A human
 * picks; the machine only suggests.
 *
 * ## The rule the tag list follows
 *
 * Anatomy, sex, euphemism and flirtation. Nothing that insults a person, no
 * slurs, nothing about anyone who cannot consent, nothing violent. The test for
 * a candidate is whether it could be the answer in a room of colleagues who
 * opted into a rude round — cheeky, not nasty. `DENY` below is a backstop for
 * the candidate lister, not a substitute for that judgement.
 */

import { loadRanker } from "../server/ranker.ts";
import { config } from "../server/config.ts";

const OUT_PATH = "data/words-adult.txt";

/**
 * The tag list. Grouped so a reader can audit a category at a glance, and so a
 * category can be dropped wholesale if a room finds it too much.
 *
 * Single words only: the ranker scores one word against one word, so anything
 * with a space cannot be a secret.
 */
const TAGS: Record<string, string[]> = {
  anatomy: [
    "thigh",
    "hip",
    "waist",
    "navel",
    "collarbone",
    "shoulder",
    "neck",
    "nape",
    "lips",
    "tongue",
    "breast",
    "bosom",
    "cleavage",
    "nipple",
    "buttock",
    "bottom",
    "groin",
    "loins",
    "pelvis",
    "curves",
    "skin",
    "sweat",
    "breath",
    "pulse",
  ],
  sex: [
    "sex",
    "desire",
    "lust",
    "arousal",
    "orgasm",
    "climax",
    "foreplay",
    "intercourse",
    "seduction",
    "seduce",
    "flirt",
    "kiss",
    "caress",
    "embrace",
    "fondle",
    "intimacy",
    "passion",
    "libido",
    "aphrodisiac",
    "condom",
    "contraception",
    "consent",
    "celibacy",
    "abstinence",
    "virginity",
    "fertility",
    "hormone",
    "pheromone",
  ],
  euphemism: [
    "birds",
    "bees",
    "nightcap",
    "canoodle",
    "smooch",
    "snog",
    "hanky",
    "panky",
    "romp",
    "tryst",
    "liaison",
    "dalliance",
    "affair",
    "rendezvous",
    "conquest",
    "escapade",
    "frolic",
    "tickle",
    "spooning",
    "cuddle",
    "honeymoon",
    "consummate",
  ],
  romance: [
    "romance",
    "lover",
    "sweetheart",
    "valentine",
    "courtship",
    "wooing",
    "infatuation",
    "crush",
    "chemistry",
    "attraction",
    "temptation",
    "flirtation",
    "yearning",
    "longing",
    "swoon",
    "blush",
    "whisper",
    "candlelight",
    "moonlight",
    "silk",
    "lace",
    "lingerie",
    "negligee",
    "corset",
    "stiletto",
    "perfume",
  ],
  nightlife: [
    "midnight",
    "cocktail",
    "champagne",
    "tequila",
    "hangover",
    "cabaret",
    "burlesque",
    "striptease",
    "nightclub",
    "boudoir",
    "bedroom",
    "mattress",
    "bedsheet",
    "pillow",
    "hotel",
    "motel",
    "sauna",
    "jacuzzi",
    "skinny",
    "dipping",
    "tattoo",
    "leather",
    "handcuffs",
    "blindfold",
  ],
};

/**
 * A backstop for `--candidates`, not for the pool.
 *
 * Substring matching on purpose: it is meant to be blunt, because its only job
 * is to keep the *suggestion* list readable rather than to be the safety
 * mechanism. The safety mechanism is that suggestions are never written.
 */
const DENY = [
  "rape",
  "molest",
  "incest",
  "pedo",
  "paedo",
  "child",
  "minor",
  "teen",
  "underage",
  "slut",
  "whore",
  "hooker",
  "prostitut",
  "bitch",
  "cunt",
  "fag",
  "tranny",
  "porn",
  "abuse",
  "assault",
  "victim",
  "traffick",
  "bestial",
  "necro",
];

function denied(word: string): boolean {
  return DENY.some((bad) => word.includes(bad));
}

const args = new Set(Deno.args);
const write = args.has("--write");
const candidates = args.has("--candidates");

const ranker = await loadRanker(config.packPath, null, { cacheSize: 8 });

const tagged: string[] = [];
const missing: string[] = [];
for (const [group, words] of Object.entries(TAGS)) {
  for (const word of words) {
    // `knows` is the same membership test the pool loader applies, so a word that
    // survives here is one the game can actually rank a guess against.
    if (ranker.knows(word)) tagged.push(word);
    else missing.push(`${word} (${group})`);
  }
}

if (candidates) {
  // Suggestions only. Printed, never written — see the header.
  const seen = new Set(tagged);
  const found: { word: string; near: string }[] = [];
  for (const seed of tagged) {
    for (const word of ranker.nearest(seed, 12)) {
      if (seen.has(word) || denied(word)) continue;
      seen.add(word);
      found.push({ word, near: seed });
    }
  }
  console.log(`# ${found.length} candidates near ${tagged.length} tags — REVIEW BY HAND`);
  for (const { word, near } of found) console.log(`${word.padEnd(22)} # near ${near}`);
  Deno.exit(0);
}

const header = [
  "# After-dark secret-word pool for CloseWord Party.",
  "#",
  "# Built by scripts/tag_words.ts from its own hand-written tag list, filtered to",
  "# words the embedding pack can rank. Anatomy, sex, euphemism and flirtation",
  "# only: nothing that insults a person, no slurs, nothing violent.",
  "#",
  "# Edit the TAGS table in the script rather than this file, so the two cannot",
  "# drift apart. `--candidates` suggests neighbours for a human to pick from.",
  "",
];

const body = tagged.join("\n") + "\n";
if (write) {
  await Deno.writeTextFile(OUT_PATH, header.join("\n") + body);
  console.log(`wrote ${tagged.length} words to ${OUT_PATH}`);
} else {
  console.log(header.join("\n") + body);
  console.log(`# ${tagged.length} rankable, ${missing.length} dropped as unrankable`);
}
if (missing.length) console.error(`not in the pack: ${missing.join(", ")}`);
