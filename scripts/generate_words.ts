#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env
/**
 * Generate a themed secret-word pool with `claude -p`, for the "AI-generated
 * words" source.
 *
 *   deno task words:ai                              # general-knowledge pool
 *   deno task words:ai --theme "cybersecurity"
 *   deno task words:ai --theme "food and cooking" --count 300
 *   deno task words:ai --append                     # add to the existing pool
 *
 * Writes data/words-ai.txt. Words are emitted roughly easiest-first, because the
 * game's difficulty setting slices a prefix of the file — so we ask for the most
 * familiar words first and keep that order.
 */

import { claudeAvailable, claudePrompt } from "../server/ai.ts";
import { readWordList } from "../server/ranker.ts";
import { decodePack } from "../server/vectorpack.ts";

const OUT_PATH = "data/words-ai.txt";
/** Words per call. Large batches drift off-format; small ones waste calls. */
const BATCH = 60;

interface Args {
  theme: string;
  count: number;
  out: string;
  append: boolean;
  pack: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    theme: "everyday general knowledge",
    count: 240,
    out: OUT_PATH,
    append: false,
    pack: "data/vectors.bin",
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--theme":
        args.theme = argv[++i];
        break;
      case "--count":
        args.count = Number(argv[++i]);
        break;
      case "--out":
        args.out = argv[++i];
        break;
      case "--pack":
        args.pack = argv[++i];
        break;
      case "--append":
        args.append = true;
        break;
      case "-h":
      case "--help":
        console.log(
          "usage: deno task words:ai [--theme TEXT] [--count N] [--append]\n" +
            "                          [--out FILE] [--pack FILE]",
        );
        Deno.exit(0);
        break;
      default:
        throw new Error(`unknown flag ${flag}`);
    }
  }
  if (!Number.isFinite(args.count) || args.count < 10) {
    throw new Error("--count must be at least 10");
  }
  return args;
}

const args = parseArgs(Deno.args);

if (!(await claudeAvailable())) {
  console.error("The `claude` CLI is not available on PATH — this source needs it.");
  Deno.exit(1);
}

// The pack decides what is playable: a word we cannot rank against is useless as
// a secret, so filter before writing rather than discovering it mid-game.
let vocab: Set<string> | null = null;
try {
  const pack = decodePack(await Deno.readFile(args.pack));
  vocab = new Set(pack.words);
  console.log(
    `pack: ${pack.count} words${pack.sample ? " (SAMPLE — most suggestions will be dropped)" : ""}`,
  );
} catch (err) {
  if (err instanceof Deno.errors.NotFound) {
    console.warn(`No pack at ${args.pack}; skipping the playability filter.`);
  } else {
    throw err;
  }
}

function promptFor(theme: string, count: number, avoid: string[]): string {
  const avoidLine = avoid.length
    ? `\nDo NOT repeat any of these, which are already in the list:\n${avoid.join(", ")}\n`
    : "";
  return `Produce secret words for a semantic word-guessing game. Players guess \
words and are told only how semantically close each guess is to the secret.

Theme: ${theme}

Give exactly ${count} words. Requirements:
- single English words, lowercase, letters only, 4 to 14 characters
- concrete and self-contained, with clear semantic neighbours
- no proper nouns, acronyms, abbreviations or hyphenated words
- no plurals or "-ing"/"-ed" inflections; use the base form
- nothing offensive
- ORDER THEM most familiar first, so that early words suit casual players and \
later ones are harder
${avoidLine}
Reply with ONLY the words, one per line. No numbering, no commentary.`;
}

const WORD_RE = /^[a-z]{4,14}$/;

const existing = args.append ? (await readWordList(args.out)) ?? [] : [];
const kept: string[] = [...existing];
const seen = new Set(kept);
let dropped = 0;
let rejected = 0;

while (kept.length < args.count + existing.length) {
  const want = Math.min(BATCH, args.count + existing.length - kept.length);
  // Show the model a sample of what we already have; the full list would bloat
  // the prompt once the pool gets large.
  const avoid = kept.slice(-120);
  let reply: string;
  try {
    reply = await claudePrompt(promptFor(args.theme, want, avoid), { timeoutMs: 120_000 });
  } catch (err) {
    console.error(`\nclaude -p failed: ${err instanceof Error ? err.message : err}`);
    break;
  }

  let added = 0;
  for (const line of reply.split("\n")) {
    const word = line.trim().toLowerCase().replace(/^[-*\d.\s]+/, "");
    if (!WORD_RE.test(word)) {
      if (word) rejected++;
      continue;
    }
    if (seen.has(word)) continue;
    if (vocab && !vocab.has(word)) {
      dropped++;
      continue;
    }
    seen.add(word);
    kept.push(word);
    added++;
  }
  console.log(`  +${added} (total ${kept.length}/${args.count + existing.length})`);
  // No progress means another identical round will not help either.
  if (added === 0) {
    console.warn("  no new usable words in that batch — stopping");
    break;
  }
}

const total = kept.length - existing.length;
console.log(
  `\ngenerated ${total} new words` +
    (dropped ? `, dropped ${dropped} not in the embedding pack` : "") +
    (rejected ? `, ignored ${rejected} malformed lines` : ""),
);

if (kept.length === 0) {
  console.error("Nothing usable was produced — not writing.");
  Deno.exit(1);
}

const header = [
  "# AI-generated secret-word pool for CloseWord Party.",
  `# Theme: ${args.theme}`,
  "# Generated by scripts/generate_words.ts via `claude -p`.",
  "#",
  "# ORDER MATTERS: most familiar first. Difficulty picks from a prefix of this",
  '# list, so re-sorting changes what "easy" means.',
  `# ${kept.length} words.`,
  "",
].join("\n");

await Deno.mkdir("data", { recursive: true });
await Deno.writeTextFile(args.out, header + kept.join("\n") + "\n");
console.log(`wrote ${args.out} — ${kept.length} words total`);
console.log("Restart the server to pick it up.");
