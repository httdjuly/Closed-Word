#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run
/**
 * Curate a secret-word pool with `claude -p`.
 *
 * A pool derived mechanically from corpus frequency lets through plenty of words
 * that make miserable puzzle targets: abbreviations, proper-noun fragments, bare
 * inflections, jargon. This walks the pool in batches and asks Claude to keep
 * only words that work as a semantic guessing target.
 *
 * By default it curates the CloseWord pool derived from the embedding pack and
 * writes data/secret-words.txt, which the server prefers over the derived pool
 * when present:
 *
 *   deno task curate                      # curate the top 1500 candidates
 *   deno task curate --limit 4000         # go deeper
 *   deno task curate --batch 120          # bigger batches, fewer calls
 *   deno task curate --dry-run            # print, don't write
 *
 * With --in it curates any word list, which is how the custom pool gets its final
 * pass after `deno task ingest:custom`:
 *
 *   deno task curate --in data/words-custom.raw.txt --out data/words-custom.txt \
 *     --profile custom
 *
 * Read the raw harvest, not the pool the game uses. Curating a file in place
 * narrows it a little further every run: a word rejected once is gone, and the next
 * pass only judges the survivors.
 *
 * The profile matters. The general rubric throws out anything most people would
 * not know, which is right for a mixed dictionary pool and quite wrong for the
 * custom source, where shared work vocabulary is the entire point — it would
 * discard `firmware` and `license` and leave a pool indistinguishable from the
 * default one.
 *
 * Entirely optional. Skip it and the game plays fine on the derived pools.
 */

import { loadRanker, readWordList, SECRET_POOL_PATH } from "../server/ranker.ts";
import { claudeAvailable, claudePrompt } from "../server/ai.ts";
import { config } from "../server/config.ts";

type Profile = "general" | "custom";

interface Args {
  limit: number;
  batch: number;
  dryRun: boolean;
  out: string | null;
  /** Read candidates from this list instead of the pack-derived pool. */
  input: string | null;
  profile: Profile;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    limit: 1500,
    batch: 80,
    dryRun: false,
    out: null,
    input: null,
    profile: "general",
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--limit":
        args.limit = Number(argv[++i]);
        break;
      case "--batch":
        args.batch = Number(argv[++i]);
        break;
      case "--out":
        args.out = argv[++i];
        break;
      case "--in":
        args.input = argv[++i];
        break;
      case "--profile": {
        const value = argv[++i];
        if (value !== "general" && value !== "custom") {
          throw new Error(`--profile must be general or custom, got ${value}`);
        }
        args.profile = value;
        break;
      }
      case "--dry-run":
        args.dryRun = true;
        break;
      case "-h":
      case "--help":
        console.log(
          "usage: deno task curate [--limit N] [--batch N] [--dry-run]\n" +
            "                        [--in FILE] [--out FILE] [--profile general|custom]",
        );
        Deno.exit(0);
        break;
      default:
        throw new Error(`unknown flag ${flag}`);
    }
  }
  // Curating a list writes back to it unless told otherwise; curating the derived
  // pool writes the file the server looks for.
  args.out ??= args.input ?? SECRET_POOL_PATH;
  return args;
}

const SHARED_RULES = `Players guess words and are told only how semantically close \
each guess is to the secret, so a good secret has a clear semantic neighbourhood \
to close in on.

REJECT a word if it is:
- an abbreviation, acronym, or fragment of a proper noun
- a function word, pronoun, or bare inflection (plurals, "-ing", "-ed" forms)
- vague and abstract with no obvious neighbours
- markup, a file extension, or web boilerplate
- offensive, or a slur

Reply with ONLY the words you keep, one per line, lowercase, no numbering, no \
commentary. If you keep none, reply with the single word NONE.

Candidates:`;

const PROMPTS: Record<Profile, string> = {
  general: `You are vetting candidate secret words for a semantic word-guessing \
game. A good secret word is a reasonably common, concrete, self-contained English \
word.

KEEP everyday nouns, verbs and adjectives that a mixed group of colleagues would \
all recognise. Also REJECT narrow jargon and technical terms most people would not \
know.

${SHARED_RULES}`,

  // Deliberately the opposite instinct on jargon. This pool is harvested from an
  // team product wiki and used in an custom-pool game mode: the words
  // colleagues share at work are the good ones, and stripping them would leave a
  // pool no different from the general one.
  custom: `You are vetting candidate secret words for a semantic word-guessing \
game played by colleagues at your own company. The words were \
harvested from their internal product wiki.

KEEP words these colleagues would recognise from work — product, security, \
software, support and business vocabulary — as well as ordinary English nouns, \
verbs and adjectives.

Also REJECT a word if it is:
- meaningful only inside one team (an internal codename, a ticket prefix, a \
system name)
- so generic in a workplace that it says nothing: "item", "type", "detail"
- a job-title or process fragment rather than a thing anyone can picture

${SHARED_RULES}`,
};

const args = parseArgs(Deno.args);

if (!(await claudeAvailable())) {
  console.error(
    "The `claude` CLI is not available on PATH.\n" +
      "This script is optional — the server derives a usable pool without it.",
  );
  Deno.exit(1);
}

/**
 * Candidates in their existing order. Never reorder: the difficulty settings
 * slice a prefix of the pool, so alphabetising would turn "easy" into "words
 * beginning with A".
 */
let candidates: string[];
/** Words past --limit, which are kept as they are rather than thrown away. */
let untouched: string[] = [];

if (args.input) {
  const list = await readWordList(args.input);
  if (!list || list.length === 0) {
    console.error(`No words in ${args.input}. Run the ingest that builds it first.`);
    Deno.exit(1);
  }
  candidates = list.slice(0, args.limit);
  // Curating the top of a list and dropping the tail would quietly shrink the
  // pool to the reviewed prefix, which is not what --limit asks for.
  untouched = list.slice(args.limit);
  console.log(
    `input: ${args.input} — ${list.length} words, curating the first ${candidates.length}`,
  );
} else {
  // Pool path null: always curate the frequency-derived pool, so re-running does
  // not narrow a previously curated file further and further.
  const ranker = await loadRanker(undefined, null);
  const stats = ranker.stats();
  console.log(`pack: ${stats.vocabSize} words, derived pool ${stats.secretPoolSize}`);
  if (stats.sample) {
    console.warn(
      "\nWarning: this is the synthetic sample pack. Curating it is not very useful —\n" +
        "run `deno task ingest` for real vectors first.\n",
    );
  }
  candidates = ranker.candidates(args.limit);
}

const PROMPT = PROMPTS[args.profile];
console.log(
  `curating ${candidates.length} candidates in batches of ${args.batch} ` +
    `(${args.profile} profile)\n`,
);

/**
 * Vetting 100 words is a bigger job than answering a chat message, so this is
 * generous. Configurable because "how long will the model take" is a property of
 * the machine, not of this script.
 */
const TIMEOUT_MS = config.curateTimeoutMs;

/**
 * Vet one batch, returning the words to keep, or null if the call failed.
 *
 * Split on timeout rather than giving up. A timeout is almost always about batch
 * size, and the alternative — keeping all 100 unvetted — silently puts exactly
 * the words this script exists to remove back into the pool. Two batches did time
 * out on the first full custom run, and 200 unreviewed words is a sixth of
 * everything it rejected.
 */
async function vet(batch: string[], label: string, depth = 0): Promise<string[] | null> {
  try {
    const reply = await claudePrompt(`${PROMPT}\n${batch.join("\n")}`, { timeoutMs: TIMEOUT_MS });
    if (reply.trim().toUpperCase() === "NONE") return [];
    const allowed = new Set(batch);
    // Intersecting with the batch is the trust boundary: a reply can only ever
    // remove words, never introduce one nobody harvested.
    return reply
      .split("\n")
      .map((line) => line.trim().toLowerCase().replace(/^[-*\d.\s]+/, ""))
      .filter((word) => allowed.has(word));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Halve and retry, twice at most: 100 -> 50 -> 25 is enough to get under a
    // timeout without turning one slow batch into dozens of calls.
    if (batch.length > 12 && depth < 2) {
      console.warn(`${label}: ${message} — splitting into two`);
      const mid = Math.ceil(batch.length / 2);
      const halves = await Promise.all([
        vet(batch.slice(0, mid), `${label}a`, depth + 1),
        vet(batch.slice(mid), `${label}b`, depth + 1),
      ]);
      // Either half may still have failed; a null half keeps its own words.
      return [
        ...(halves[0] ?? batch.slice(0, mid)),
        ...(halves[1] ?? batch.slice(mid)),
      ];
    }
    console.warn(`${label}: failed (${message})`);
    return null;
  }
}

const kept: string[] = [];
/** Words no call ever managed to judge, reported at the end rather than hidden. */
const unvetted: string[] = [];
const batchCount = Math.ceil(candidates.length / args.batch);

for (let b = 0; b < batchCount; b++) {
  const batch = candidates.slice(b * args.batch, (b + 1) * args.batch);
  const label = `batch ${b + 1}/${batchCount}`;
  const survivors = await vet(batch, label);
  if (survivors === null) {
    // Keep them rather than silently shrinking the pool on a transient failure.
    console.warn(`${label}: keeping all ${batch.length} unvetted`);
    kept.push(...batch);
    unvetted.push(...batch);
    continue;
  }
  kept.push(...survivors);
  console.log(`${label}: kept ${survivors.length} / ${batch.length}`);
}

// Dedupe while preserving frequency order.
const unique = [...new Set([...kept, ...untouched])];
console.log(
  `\nkept ${kept.length} of ${candidates.length} candidates` +
    (untouched.length > 0 ? `, plus ${untouched.length} beyond --limit left as they were` : ""),
);
if (unvetted.length > 0) {
  // Never let a partial run read as a complete one.
  console.warn(
    `${unvetted.length} word(s) went unvetted and were kept as-is. Re-run to try them again,\n` +
      `or raise CLOSEWORD_CURATE_TIMEOUT_MS (currently ${TIMEOUT_MS}ms).`,
  );
}

if (args.dryRun) {
  console.log("\n--dry-run, not writing. First 40 survivors:");
  console.log(unique.slice(0, 40).join(" "));
  Deno.exit(0);
}

const out = args.out as string;
const header = [
  `# Curated secret-word pool for CloseWord Party (${args.profile} profile).`,
  "# Generated by scripts/curate_words.ts; edit freely, one word per line.",
  ...(args.input
    ? [
      `# Vetted from ${args.input}, which the ingest script writes and this never`,
      "# touches — rebuild that, then re-run the curation.",
    ]
    : ["# Delete this file to fall back to the frequency-derived pool."]),
  "#",
  "# ORDER MATTERS: most common first. Difficulty picks from a prefix of this",
  "# list, so re-sorting the file changes what 'easy' means.",
  `# ${unique.length} words, from ${candidates.length + untouched.length} candidates.`,
  "",
].join("\n");

await Deno.mkdir("data", { recursive: true });
await Deno.writeTextFile(out, header + unique.join("\n") + "\n");
console.log(`wrote ${out}`);
console.log("Restart the server to pick it up.");
