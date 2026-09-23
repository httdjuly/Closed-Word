#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * Teach the embedding pack the words our corpus never contained.
 *
 *   deno task pack:terms            # review: what would be added, and where it lands
 *   deno task pack:terms --write    # append to data/vectors.bin and data/words-custom.txt
 *   deno task pack:terms --pool-only # skip the pack, only refresh the answer pool
 *
 * ## The problem this solves
 *
 * Somebody in a custom room typed `rma` and got "not in the word list". The
 * obvious diagnosis — that the custom *pool* is missing the word — is wrong, and
 * knowing why matters for every future report of the same shape:
 *
 *   - a **pool** (data/words-*.txt) decides what the secret can be;
 *   - the **pack** (data/vectors.bin) decides what a guess can be.
 *
 * Guesses are ranked against the pack's 50,000 rows, so a word absent from the
 * pack is unguessable no matter which pool is loaded. And it has to be that way:
 * ranking a guess means taking its vector, and a word with no vector has no rank.
 *
 * The pack came from fastText wiki-news, a general web-and-news corpus, so it
 * knows `firmware`, `kiosk` and `endpoint` but not `rma`, `sso`, `edr` or
 * `metadefender`. Re-ingesting will not help — no general corpus contains our
 * acronyms often enough to survive a 50k frequency cut.
 *
 * ## What it does instead
 *
 * For each term, average the vectors of the words a person would use to explain
 * it, and normalise. `rma = return merchandise authorization warranty repair`
 * becomes a point in the middle of that cluster, which is precisely where a
 * player's intuition puts it. The centroid trick is ordinary practice for
 * out-of-vocabulary terms; it is weaker than a learned vector but it is right
 * about the neighbourhood, and a neighbourhood is all a semantic guessing game
 * reads.
 *
 * One known artefact, so nobody re-discovers it as a bug: composed vectors sit
 * closer to each other than real words do. An average of five vectors is shorter
 * and blander than any of them, so all of these terms drift toward the same
 * middle-of-the-corporate-vocabulary point — which is why `sla` and `oauth` come
 * out as near neighbours of `rma`. It only shows up when a composed term is
 * itself the secret, and those are tail-of-pool secrets, so in practice a room
 * meets them as guesses and the ranks are honest.
 *
 * Rows are appended, never rewritten:
 *
 *   - a term the pack already knows is left completely alone, learned vector and
 *     all, and reported as skipped. So `apt` keeps meaning the package manager
 *     rather than being redefined to the security sense — it was already
 *     guessable, which was the whole requirement;
 *   - new rows land at the end of the vocabulary, which the pack treats as
 *     *least* frequent. That is what we want: the frequency order is what
 *     `difficulty` slices, so a composed acronym can never turn up as an easy
 *     secret;
 *   - running twice is a no-op, because everything added the first time is now
 *     "already in the pack".
 *
 * The rank scale shifts from 50,000 words to a few dozen more. `REFERENCE_VOCAB`
 * in shared/constants.js stays where it is: a 0.1% change to the denominator is
 * far below the resolution of a heat bar, and moving it would silently restate
 * every score anybody has ever seen.
 */

import { decodePack, encodePack, normaliseRow } from "../server/vectorpack.ts";
import { config } from "../server/config.ts";

const TERMS_PATH = "data/terms-custom.txt";
const META_PATH = "data/pack.json";
const POOL_PATH = "data/words-custom.txt";
/** Below this, an average is one word wearing a disguise rather than a meaning. */
const MIN_ANCHORS = 2;
/** Two-letter answers are miserable to guess at. They stay guessable, just not answers. */
const MIN_ANSWER_LENGTH = 3;
const POOL_MARKER = "# --- domain terms, appended by scripts/extend_pack.ts ---";

interface Term {
  word: string;
  expansion: string[];
  line: number;
}

function parseTerms(text: string): { terms: Term[]; problems: string[] } {
  const terms: Term[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at < 0) {
      problems.push(`line ${i + 1}: no "=" — expected "term = word word word"`);
      continue;
    }
    const word = line.slice(0, at).trim().toLowerCase();
    const expansion = line.slice(at + 1).trim().toLowerCase().split(/\s+/).filter(Boolean);
    // Anything outside this shape would either break the "\n"-joined vocab blob
    // or be unreachable through the guess box.
    if (!/^[a-z0-9]{2,}$/.test(word) || !/[a-z]/.test(word)) {
      problems.push(`line ${i + 1}: "${word}" is not 2+ letters and digits with a letter in it`);
      continue;
    }
    if (seen.has(word)) {
      problems.push(`line ${i + 1}: "${word}" is defined twice`);
      continue;
    }
    seen.add(word);
    terms.push({ word, expansion, line: i + 1 });
  }
  return { terms, problems };
}

const args = new Set(Deno.args);
const write = args.has("--write");
const poolOnly = args.has("--pool-only");

const termText = await Deno.readTextFile(TERMS_PATH);
const { terms, problems } = parseTerms(termText);
if (problems.length) {
  for (const p of problems) console.error(`${TERMS_PATH}: ${p}`);
  if (write) Deno.exit(1);
}

const pack = decodePack(await Deno.readFile(config.packPath));
const { dim } = pack;
console.log(`${config.packPath}: ${pack.count} words, dim ${dim}`);
console.log(`${TERMS_PATH}: ${terms.length} terms\n`);

const added: { term: Term; used: string[]; vector: Float32Array }[] = [];
const known: string[] = [];
const rejected: string[] = [];

for (const term of terms) {
  if (pack.index.has(term.word)) {
    known.push(term.word);
    continue;
  }
  const used: string[] = [];
  const absent: string[] = [];
  const vector = new Float32Array(dim);
  for (const anchor of term.expansion) {
    const row = pack.index.get(anchor);
    if (row === undefined) {
      absent.push(anchor);
      continue;
    }
    const off = row * dim;
    for (let i = 0; i < dim; i++) vector[i] += pack.matrix[off + i];
    used.push(anchor);
  }
  if (used.length < MIN_ANCHORS) {
    rejected.push(
      `${term.word} (line ${term.line}): only ${used.length} of its words are in the pack` +
        (absent.length ? ` — missing ${absent.join(", ")}` : ""),
    );
    continue;
  }
  normaliseRow(vector, 0, dim);
  if (absent.length) {
    console.log(`  ${term.word}: ignoring ${absent.join(", ")} (not in the pack)`);
  }
  added.push({ term, used, vector });
}

if (rejected.length) {
  console.error(`\ncannot compose:`);
  for (const r of rejected) console.error(`  ${r}`);
}

// Where each new term lands. This is the review: if a term's neighbours read
// wrong, its expansion is wrong, and no amount of writing will fix that.
if (!write && !poolOnly && added.length) {
  console.log(`\nwould add ${added.length} terms. Nearest existing words:\n`);
  for (const { term, vector } of added) {
    const best: { word: string; sim: number }[] = [];
    for (let w = 0; w < pack.count; w++) {
      const off = w * dim;
      let acc = 0;
      for (let i = 0; i < dim; i++) acc += pack.matrix[off + i] * vector[i];
      if (best.length < 6 || acc > best[best.length - 1].sim) {
        best.push({ word: pack.words[w], sim: acc });
        best.sort((a, b) => b.sim - a.sim);
        if (best.length > 6) best.pop();
      }
    }
    const near = best.map((b) => `${b.word} ${b.sim.toFixed(2)}`).join("  ");
    console.log(`  ${term.word.padEnd(14)} ${near}`);
  }
}

console.log(
  `\n${added.length} to add, ${known.length} already in the pack, ${rejected.length} rejected`,
);
if (known.length) console.log(`already known: ${known.join(" ")}`);

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

if (write && added.length && !poolOnly) {
  const count = pack.count + added.length;
  const words = [...pack.words, ...added.map((a) => a.term.word)];
  const matrix = new Float32Array(count * dim);
  matrix.set(pack.matrix, 0);
  for (let i = 0; i < added.length; i++) {
    matrix.set(added[i].vector, (pack.count + i) * dim);
  }

  const bytes = encodePack(words, matrix, dim, pack.sample);
  // Write beside the real file and rename, so a crash mid-write cannot leave the
  // server holding a truncated pack it will refuse to load.
  const temp = `${config.packPath}.new`;
  await Deno.writeFile(temp, bytes);
  await Deno.rename(temp, config.packPath);
  console.log(`\nwrote ${count} words to ${config.packPath} (${bytes.length} bytes)`);

  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(await Deno.readTextFile(META_PATH));
  } catch {
    // A missing or unreadable pack.json is metadata only; the pack itself is
    // self-describing, so rebuild what we can rather than failing the write.
  }
  meta.words = count;
  meta.bytes = bytes.length;
  meta.composedTerms = added.length;
  meta.composedFrom = TERMS_PATH;
  await Deno.writeTextFile(META_PATH, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`updated ${META_PATH}`);
}

if (write) {
  // Append to the answer pool too, so a custom round can land on `rma` and not
  // just accept it. At the end of the file on purpose: the pool is
  // frequency-ordered and difficulty reads a prefix of it.
  const pool = await Deno.readTextFile(POOL_PATH);
  const listed = new Set(
    pool.split("\n").map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith("#")),
  );
  const fresh = terms
    .map((t) => t.word)
    .filter((w) =>
      w.length >= MIN_ANSWER_LENGTH && !listed.has(w) &&
      !rejected.some((r) => r.startsWith(`${w} `))
    );

  if (fresh.length === 0) {
    console.log(`${POOL_PATH}: nothing to add`);
  } else {
    const block = pool.includes(POOL_MARKER) ? `${fresh.join("\n")}\n` : `\n${POOL_MARKER}\n` +
      `# Composed vectors rather than learned ones, so they sit at the tail of the\n` +
      `# frequency order: past the 'easy' window, and never the first thing a room meets.\n` +
      `${fresh.join("\n")}\n`;
    await Deno.writeTextFile(POOL_PATH, pool.replace(/\n*$/, "\n") + block);
    console.log(`${POOL_PATH}: added ${fresh.length} terms — ${fresh.join(" ")}`);
  }
}

if (!write) console.log(`\nnothing written. Re-run with --write.`);
