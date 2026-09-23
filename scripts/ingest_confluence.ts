#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env
/**
 * Build the custom word pool from a Confluence space.
 *
 * Walks every page in the space, strips markup, and writes the survivors to
 * data/words-custom.txt ordered by *document frequency* — how many distinct
 * pages a word appears on. That is the order the game's difficulty setting
 * slices, so it decides what "easy" means.
 *
 *   CONFLUENCE_EMAIL=you@example.com          # in .env
 *   CONFLUENCE_API_TOKEN=...                 # id.atlassian.com/manage-profile/security/api-tokens
 *   deno task ingest:custom
 *
 *   deno task ingest:custom --space ENG --limit 400
 *   deno task ingest:custom --report data/custom-report.tsv   # inspect the corpus
 *
 * Document frequency rather than total occurrences, because total occurrences
 * measure how repetitive one page is. A word stamped 400 times into a single
 * release-notes table outranked words the whole team actually uses; counting each
 * word once per page asks the question we mean, which is "is this shared
 * vocabulary".
 *
 * Only word *counts* leave Confluence — no page text is written anywhere. Words
 * missing from the embedding pack are dropped, since a secret we cannot rank
 * against is unplayable, and so are function words and markup residue (see
 * STOPWORDS): they are real English, but as puzzle targets they are dead ends
 * with no semantic neighbourhood to close in on.
 */

import { readWordList } from "../server/ranker.ts";
import { decodePack } from "../server/vectorpack.ts";

const OUT_PATH = "data/words-custom.txt";

/**
 * The mechanical harvest, written alongside the pool the game reads.
 *
 * Two files rather than one so that the optional `claude -p` curation pass always
 * has an untouched input. Curating a file in place narrows it a little more on
 * every run — a word rejected once is gone, and the next pass judges only the
 * survivors — which turns "re-run the curation" into "shrink the pool".
 */
const RAW_SUFFIX = ".raw.txt";

/**
 * Words that survive every other filter and still make hopeless secrets.
 *
 * Two kinds. Function words — "with", "this", "will" — are in the embedding pack
 * and were top of the list on the first real harvest, but a semantic game needs a
 * target with neighbours, and nothing is meaningfully "close to" the word `this`.
 * The rest is what a wiki leaves behind: URL parts, markup and storage-format
 * fragments, and the vocabulary Confluence itself contributes to every page.
 *
 * Tokens shorter than four characters are dropped before this, so no entry here
 * needs to be.
 *
 * Deliberately not on the list: `jira`, `confluence`, `firmware`, `endpoint`,
 * `license` and friends. They look like jargon but they are exactly the shared
 * custom vocabulary this word source exists to celebrate.
 */
const STOPWORDS = new Set([
  // Function words and other grammatical filler.
  "about",
  "above",
  "after",
  "again",
  "against",
  "all",
  "also",
  "although",
  "always",
  "among",
  "another",
  "any",
  "anyone",
  "anything",
  "are",
  "aren",
  "around",
  "because",
  "been",
  "before",
  "being",
  "below",
  "besides",
  "better",
  "between",
  "both",
  "but",
  "cannot",
  "could",
  "couldn",
  "did",
  "didn",
  "does",
  "doesn",
  "doing",
  "don",
  "done",
  "down",
  "due",
  "during",
  "each",
  "either",
  "else",
  "enough",
  "etc",
  "even",
  "ever",
  "every",
  "everything",
  "except",
  "few",
  "following",
  "for",
  "from",
  "further",
  "had",
  "hadn",
  "has",
  "hasn",
  "have",
  "haven",
  "having",
  "hence",
  "her",
  "here",
  "hers",
  "herself",
  "him",
  "himself",
  "his",
  "how",
  "however",
  "into",
  "isn",
  "its",
  "itself",
  "just",
  "let",
  "like",
  "made",
  "make",
  "makes",
  "many",
  "may",
  "maybe",
  "might",
  "more",
  "most",
  "much",
  "must",
  "myself",
  "neither",
  "never",
  "next",
  "nor",
  "not",
  "nothing",
  "now",
  "off",
  "once",
  "one",
  "only",
  "onto",
  "other",
  "others",
  "our",
  "ours",
  "ourselves",
  "out",
  "over",
  "own",
  "per",
  "please",
  "rather",
  "really",
  "same",
  "shall",
  "she",
  "should",
  "shouldn",
  "since",
  "some",
  "someone",
  "something",
  "still",
  "such",
  "than",
  "that",
  "the",
  "their",
  "theirs",
  "them",
  "themselves",
  "then",
  "there",
  "therefore",
  "these",
  "they",
  "thing",
  "things",
  "this",
  "those",
  "though",
  "through",
  "thus",
  "too",
  "toward",
  "towards",
  "under",
  "unless",
  "until",
  "upon",
  "using",
  "very",
  "want",
  "was",
  "wasn",
  "well",
  "were",
  "weren",
  "what",
  "when",
  "where",
  "whether",
  "which",
  "while",
  "who",
  "whom",
  "whose",
  "why",
  "will",
  "with",
  "within",
  "without",
  "won",
  "would",
  "wouldn",
  "yet",
  "you",
  "your",
  "yours",
  "yourself",
  // Web and markup residue that survives stripMarkup.
  "align",
  "atlassian",
  "attachment",
  "attachments",
  "body",
  "border",
  "class",
  "colspan",
  "com",
  "content",
  "css",
  "div",
  "font",
  "gif",
  "height",
  "href",
  "html",
  "http",
  "https",
  "iframe",
  "img",
  "jpeg",
  "jpg",
  "json",
  "layout",
  "macro",
  "markup",
  "nbsp",
  "png",
  "quot",
  "rowspan",
  "span",
  "src",
  "storage",
  "style",
  "svg",
  "table",
  "tbody",
  "thead",
  "url",
  "utf",
  "webp",
  "width",
  "www",
  "xml",
  "xmlns",
  // Confluence's own furniture, present on pages regardless of subject.
  "breadcrumb",
  "childpages",
  "comment",
  "comments",
  "edited",
  "excerpt",
  "expand",
  "jiveon",
  "pageid",
  "panel",
  "placeholder",
  "sidebar",
  "toc",
  "wiki",
]);

interface Args {
  site: string;
  space: string;
  limit: number;
  out: string;
  /** Minimum distinct pages a word must appear on. */
  minDocs: number;
  pack: string;
  /** Optional TSV of the whole corpus, for looking at what came back. */
  report: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    site: Deno.env.get("CONFLUENCE_SITE") ?? "your-team.atlassian.net",
    space: "DOCS",
    // Above the page count of any ordinary space, so the default reads all of it.
    limit: 2000,
    out: OUT_PATH,
    minDocs: 3,
    pack: "data/vectors.bin",
    report: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--site":
        args.site = argv[++i];
        break;
      case "--space":
        args.space = argv[++i];
        break;
      case "--limit":
        args.limit = Number(argv[++i]);
        break;
      case "--out":
        args.out = argv[++i];
        break;
      case "--min-docs":
      // The old name, kept working: it meant the same thing badly.
      case "--min-count":
        args.minDocs = Number(argv[++i]);
        break;
      case "--pack":
        args.pack = argv[++i];
        break;
      case "--report":
        args.report = argv[++i];
        break;
      case "-h":
      case "--help":
        console.log(
          "usage: deno task ingest:custom [--space KEY] [--site HOST] [--limit N]\n" +
            "                              [--min-docs N] [--out FILE] [--pack FILE]\n" +
            "                              [--report FILE]",
        );
        Deno.exit(0);
        break;
      default:
        throw new Error(`unknown flag ${flag}`);
    }
  }
  return args;
}

const args = parseArgs(Deno.args);

const email = Deno.env.get("CONFLUENCE_EMAIL");
const token = Deno.env.get("CONFLUENCE_API_TOKEN");
if (!email || !token) {
  console.error(
    "Set CONFLUENCE_EMAIL and CONFLUENCE_API_TOKEN first.\n\n" +
      "  Create a token at https://id.atlassian.com/manage-profile/security/api-tokens\n\n" +
      `A seed pool built from page titles is already committed at ${OUT_PATH},\n` +
      "so the custom word source works without running this.",
  );
  Deno.exit(1);
}

const auth = `Basic ${btoa(`${email}:${token}`)}`;
const base = `https://${args.site}/wiki/api/v2`;

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    headers: { authorization: auth, accept: "application/json" },
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`GET ${path} -> ${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`);
  }
  return await res.json() as T;
}

// --- resolve the space -----------------------------------------------------

interface SpaceList {
  results: { id: string; key: string; name: string }[];
}
const spaces = await api<SpaceList>(`/spaces?keys=${encodeURIComponent(args.space)}`);
const space = spaces.results[0];
if (!space) throw new Error(`no space with key ${args.space}`);
console.log(`space: ${space.name} (${space.key}, id ${space.id})`);

// --- walk the pages --------------------------------------------------------

interface PageList {
  results: { id: string; title: string; body?: { storage?: { value?: string } } }[];
  _links?: { next?: string };
}

/**
 * Strip Confluence storage-format markup down to prose. We are only counting
 * words, so this can be crude — it just must not leave tag names behind.
 */
function stripMarkup(html: string): string {
  return html
    .replace(/<(script|style|ac:parameter)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;|&#\d+;/gi, " ");
}

/** Pages a word appears on, which is what the ranking uses. */
const docs = new Map<string, number>();
/** Total occurrences, kept only for the report — see the header comment. */
const total = new Map<string, number>();
let pagesRead = 0;
let cursor: string | null =
  `/pages?space-id=${space.id}&body-format=storage&limit=100&status=current`;

while (cursor && pagesRead < args.limit) {
  const page: PageList = await api<PageList>(cursor);
  for (const item of page.results) {
    if (pagesRead >= args.limit) break;
    pagesRead++;
    const text = `${item.title}\n${stripMarkup(item.body?.storage?.value ?? "")}`;
    const onThisPage = new Set<string>();
    for (const raw of text.toLowerCase().match(/[a-z]+/g) ?? []) {
      if (raw.length < 4 || raw.length > 14) continue;
      total.set(raw, (total.get(raw) ?? 0) + 1);
      onThisPage.add(raw);
    }
    for (const word of onThisPage) docs.set(word, (docs.get(word) ?? 0) + 1);
  }
  if (pagesRead % 100 === 0) console.log(`  read ${pagesRead} pages…`);
  const next = page._links?.next;
  // The API returns next as an absolute-ish path including /wiki/api/v2.
  cursor = next ? next.replace(/^.*\/api\/v2/, "") : null;
}
console.log(`read ${pagesRead} pages, ${docs.size} distinct words`);

// --- filter against the embedding pack -------------------------------------

let vocab: Set<string> | null = null;
try {
  const pack = decodePack(await Deno.readFile(args.pack));
  vocab = new Set(pack.words);
  console.log(`pack: ${pack.count} words${pack.sample ? " (SAMPLE — expect a tiny result)" : ""}`);
} catch (err) {
  if (err instanceof Deno.errors.NotFound) {
    console.warn(
      `No pack at ${args.pack}; writing every candidate. Words missing from the\n` +
        "pack are ignored at load time anyway, so this is safe.",
    );
  } else {
    throw err;
  }
}

/**
 * Fold a plural into its singular when both appear in the corpus.
 *
 * The first real harvest produced 627 singular/plural pairs — user and users,
 * ticket and tickets, priority and priorities. Two problems with keeping both. A
 * plural secret is trivially broken: guess "user" against the secret "users" and
 * the rank comes back 1 or 2, which is a scoreboard accident rather than a
 * deduction. And the pair is one puzzle counted twice, so it inflates the pool
 * without adding anything to play.
 *
 * The safe signal is that the singular is *also* in this corpus. That is what
 * keeps `status`, `access` and `business` intact: nobody here writes "statu".
 */
function singularOf(word: string, present: Map<string, number>): string | null {
  if (!word.endsWith("s") || word.endsWith("ss")) return null;
  const candidates: string[] = [];
  if (word.endsWith("ies")) candidates.push(`${word.slice(0, -3)}y`);
  if (word.endsWith("es")) candidates.push(word.slice(0, -2));
  candidates.push(word.slice(0, -1));
  for (const candidate of candidates) {
    if (candidate.length >= 4 && present.has(candidate)) return candidate;
  }
  return null;
}

/** plural -> singular it was merged into, for the report. */
const foldedInto = new Map<string, string>();
for (const [word, pages] of [...docs.entries()]) {
  const singular = singularOf(word, docs);
  if (singular === null) continue;
  // A word appearing on page A in the plural and page B in the singular is
  // shared vocabulary on both, so the counts add.
  docs.set(singular, (docs.get(singular) ?? 0) + pages);
  docs.delete(word);
  foldedInto.set(word, singular);
}
if (foldedInto.size > 0) {
  console.log(`folded ${foldedInto.size} plural(s) into their singular`);
}

// Why each candidate was dropped, so the run explains itself instead of just
// reporting a smaller number than last time.
const dropped = { rare: 0, stopword: 0, offPack: 0 };
const ranked = [...docs.entries()]
  .filter(([word, pages]) => {
    if (pages < args.minDocs) return dropped.rare++, false;
    if (STOPWORDS.has(word)) return dropped.stopword++, false;
    if (vocab && !vocab.has(word)) return dropped.offPack++, false;
    return true;
  })
  // Document frequency descending; alphabetical only to break ties
  // deterministically, so two runs of the same corpus produce the same file.
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .map(([word]) => word);

console.log(
  `dropped: ${dropped.rare} on fewer than ${args.minDocs} pages, ` +
    `${dropped.stopword} stopwords, ${dropped.offPack} not in the pack`,
);

if (args.report) {
  // Everything, including what was dropped and why — the point of the report is
  // to see the corpus, not the decision.
  const rows = [
    ...[...docs.entries()].map(([word, pages]): [string, number, string] => [
      word,
      pages,
      pages < args.minDocs
        ? "rare"
        : STOPWORDS.has(word)
        ? "stopword"
        : vocab && !vocab.has(word)
        ? "off-pack"
        : "kept",
    ]),
    ...[...foldedInto.entries()].map(([plural, singular]): [string, number, string] => [
      plural,
      0,
      `folded into ${singular}`,
    ]),
  ]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([word, pages, verdict]) => `${word}\t${pages}\t${total.get(word) ?? 0}\t${verdict}`);
  await Deno.writeTextFile(
    args.report,
    `word\tpages\toccurrences\tverdict\n${rows.join("\n")}\n`,
  );
  console.log(`report: ${args.report} (${rows.length} rows)`);
}

if (ranked.length === 0) {
  console.error(
    "\nNo words survived. If the pack is the synthetic sample, that is expected —\n" +
      "run `deno task ingest` for real vectors and try again.",
  );
  Deno.exit(1);
}

const previous = await readWordList(args.out);
const header = [
  `# custom word pool — harvested from the "${space.name}" Confluence space`,
  `# (https://${args.site}/wiki/spaces/${space.key}).`,
  "#",
  `# Generated by scripts/ingest_confluence.ts from ${pagesRead} pages.`,
  "#",
  "# ORDER MATTERS: ranked by how many pages each word appears on, most-shared",
  "# first. Difficulty picks from a prefix of this list, so re-sorting changes",
  '# what "easy" means.',
  `# ${ranked.length} words.`,
  "",
].join("\n");

await Deno.mkdir("data", { recursive: true });
await Deno.writeTextFile(args.out, header + ranked.join("\n") + "\n");
console.log(
  `\nwrote ${args.out} — ${ranked.length} words` +
    (previous ? ` (was ${previous.length})` : ""),
);

// The same list again under .raw.txt, as the curation pass's permanent input.
const rawPath = args.out.replace(/\.txt$/, "") + RAW_SUFFIX;
await Deno.writeTextFile(
  rawPath,
  header.replace("# custom word pool", "# custom word pool, before curation") +
    ranked.join("\n") + "\n",
);
console.log(`wrote ${rawPath} — the input for \`deno task curate --in\``);

console.log(`first 25: ${ranked.slice(0, 25).join(", ")}`);
console.log("Restart the server to pick it up.");
console.log(
  `\nOptional: vet the pool with claude -p, which drops participles, internal\n` +
    `codenames and words too generic to picture:\n\n` +
    `  deno task curate --in ${rawPath} --out ${args.out} --profile custom\n`,
);
