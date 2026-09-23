#!/usr/bin/env -S deno run --allow-read
/**
 * Inspect the ranker: see a word's semantic neighbourhood and how specific
 * guesses score against it. Useful for judging whether a secret is fair before
 * inflicting it on the room, and for sanity-checking a freshly ingested pack.
 *
 *   deno run --allow-read scripts/inspect.ts cat
 *   deno run --allow-read scripts/inspect.ts coffee --guess tea --guess laptop
 *   deno run --allow-read scripts/inspect.ts --bench
 */

import { loadRanker } from "../server/ranker.ts";

const args = [...Deno.args];
const guesses: string[] = [];
let bench = false;
const secrets: string[] = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--guess") guesses.push(args[++i]);
  else if (args[i] === "--bench") bench = true;
  else secrets.push(args[i].toLowerCase());
}

const ranker = await loadRanker();
const stats = ranker.stats();
console.log(
  `pack: ${stats.vocabSize} words, ${stats.dim} dims, ` +
    `secret pool ${stats.secretPoolSize}${stats.sample ? " [SAMPLE]" : ""}`,
);

if (bench) {
  const sample = Array.from({ length: 10 }, () => ranker.pickSecret("normal"));
  const t0 = performance.now();
  for (const s of sample) ranker.table(s);
  const total = performance.now() - t0;
  console.log(
    `\nbuilt ${sample.length} rank tables in ${total.toFixed(0)}ms ` +
      `(${(total / sample.length).toFixed(1)}ms each)`,
  );
  const t1 = performance.now();
  let sink = 0;
  for (let i = 0; i < 100_000; i++) sink += ranker.rank(sample[0], sample[i % sample.length]) ?? 0;
  console.log(
    `100k rank lookups in ${(performance.now() - t1).toFixed(0)}ms (checksum ${sink})`,
  );
}

const targets = secrets.length > 0 ? secrets : [ranker.pickSecret("normal")];

for (const secret of targets) {
  if (!ranker.knows(secret)) {
    console.error(`\n${secret}: not in vocabulary`);
    continue;
  }
  const t0 = performance.now();
  ranker.table(secret);
  console.log(`\n=== ${secret} (table in ${(performance.now() - t0).toFixed(1)}ms)`);
  console.log(`  closest: ${ranker.nearest(secret, 12).join(", ")}`);
  const hints = [200, 60, 12].map((target) => {
    const w = ranker.hintAt(secret, target, new Set());
    return w ? `${w}(~${target})` : "-";
  });
  console.log(`  hints:   ${hints.join("  ->  ")}`);
  for (const g of guesses) {
    const rank = ranker.rank(secret, g.toLowerCase());
    console.log(`  ${g.padEnd(16)} ${rank === null ? "not in vocabulary" : `rank ${rank}`}`);
  }
}
