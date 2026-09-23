// Semantic ranking engine.
//
// The whole game reduces to one question: "given secret word S, what is the
// rank of guess G among all words ordered by similarity to S?" We answer it by
// building, once per secret word, a full ranking of the vocabulary. That costs
// one matrix-vector product plus one sort (~20 ms for a 50k x 300 table) and
// turns every subsequent guess into a single array lookup — which is what makes
// ten people hammering the same room cheap.
//
// Rank tables are cached because a room reuses its secret for the whole round,
// and `rounds` mode replays the same secrets across many guesses.

import { decodePack, type VectorPack } from "./vectorpack.ts";
import { DIFFICULTIES, WORD_SOURCES } from "../shared/constants.js";

/** Function words and other poor secret-word candidates. */
const SECRET_STOPWORDS = new Set(
  (`the be to of and that have with this from they which will would there their what about
  when make like time just know take into your some could them than then now look only come
  over also back after well because most give most very what does doing done been being
  should shall might must were was are had has his her its our ours yours mine theirs
  such same other another each every either neither both much many more less least
  here where while whom whose why how any all none one two three four five six seven
  eight nine ten first second third next last more still even ever never always often
  sometimes perhaps maybe rather quite almost enough indeed however therefore thus
  although though unless until since before during without within between among against
  above below under upon across along around behind beyond beside besides despite
  toward towards through throughout regarding concerning according including
  said says saying went going gone got gets getting made making makes want wants wanted
  need needs needed seem seems seemed become becomes became let lets thing things
  something anything nothing everything someone anyone everyone nobody
  yes no not nor but for so yet if or an as at by in on it he she we you i me my
  who they them us am is do did doing having` as string)
    .split(/\s+/)
    .filter(Boolean),
);

export interface RankTable {
  secret: string;
  secretId: number;
  /** rankOf[wordId] = 1-based rank; rank 1 is the secret itself. */
  rankOf: Int32Array;
  /** Vocabulary ordered by descending similarity to the secret. */
  order: Int32Array;
}

export interface RankerStats {
  vocabSize: number;
  dim: number;
  sample: boolean;
  secretPoolSize: number;
  cachedTables: number;
  pools: Record<string, number>;
}

export interface RankerOptions {
  /** How many rank tables to keep resident. Each is 4 bytes per vocabulary word. */
  cacheSize?: number;
  /** Optional curated pool for the default `closeword` source. */
  secretPool?: string[];
  /**
   * Additional named secret pools, in descending corpus frequency. Words absent
   * from the embedding pack are dropped: a secret we cannot rank against is
   * unplayable, so it must never reach a room.
   */
  pools?: Record<string, string[]>;
}

export const DEFAULT_SOURCE = "closeword";

export class Ranker {
  #pack: VectorPack;
  #cache = new Map<string, RankTable>();
  #cacheSize: number;
  /** Named candidate pools, each in descending corpus frequency. */
  #pools = new Map<string, string[]>();
  /** Membership sets for the same pools, for on-domain hint selection. */
  #poolSets = new Map<string, Set<string>>();

  constructor(pack: VectorPack, options: RankerOptions = {}) {
    this.#pack = pack;
    this.#cacheSize = Math.max(1, options.cacheSize ?? 48);

    const base = options.secretPool?.length ? options.secretPool : derivePool(pack.words);
    this.#addPool(DEFAULT_SOURCE, base);
    for (const [key, words] of Object.entries(options.pools ?? {})) {
      if (key === DEFAULT_SOURCE) continue;
      this.#addPool(key, words);
    }

    if (this.pool(DEFAULT_SOURCE).length === 0) {
      throw new Error("secret word pool is empty — vocabulary too small or over-filtered");
    }
  }

  /** Keep only words we can actually rank against, preserving frequency order. */
  #addPool(key: string, words: string[]): void {
    const seen = new Set<string>();
    const usable: string[] = [];
    for (const raw of words) {
      const word = raw.trim().toLowerCase();
      if (!word || seen.has(word) || !this.#pack.index.has(word)) continue;
      seen.add(word);
      usable.push(word);
    }
    this.#pools.set(key, usable);
    this.#poolSets.set(key, seen);
  }

  /** The named pool, or an empty array if the server has no words for it. */
  pool(source: string): string[] {
    return this.#pools.get(source) ?? [];
  }

  hasPool(source: string): boolean {
    return this.pool(source).length > 0;
  }

  poolNames(): string[] {
    return [...this.#pools.keys()];
  }

  get vocabSize(): number {
    return this.#pack.count;
  }

  get isSample(): boolean {
    return this.#pack.sample;
  }

  stats(): RankerStats {
    const pools: Record<string, number> = {};
    for (const [key, words] of this.#pools) pools[key] = words.length;
    return {
      vocabSize: this.#pack.count,
      dim: this.#pack.dim,
      sample: this.#pack.sample,
      secretPoolSize: this.pool(DEFAULT_SOURCE).length,
      cachedTables: this.#cache.size,
      pools,
    };
  }

  knows(word: string): boolean {
    return this.#pack.index.has(word);
  }

  /**
   * Pick a secret word from `source`. `difficulty` selects how deep into the
   * frequency-ordered pool we are willing to reach; `exclude` keeps a round match
   * from repeating itself.
   *
   * Small pools (Custom, AI) are usually shorter than a difficulty's window, in
   * which case difficulty simply has less to bite on — which is correct, not a
   * bug: there is no deeper tail to reach for.
   */
  pickSecret(
    difficulty: keyof typeof DIFFICULTIES,
    exclude: Iterable<string> = [],
    source = DEFAULT_SOURCE,
  ): string {
    const pool = this.pool(source);
    if (pool.length === 0) throw new Error(`word source "${source}" has no usable words`);
    const limit = DIFFICULTIES[difficulty]?.poolLimit ?? DIFFICULTIES.normal.poolLimit;
    const excluded = new Set(exclude);
    const window = pool.slice(0, Math.min(limit, pool.length));
    const candidates = window.filter((w) => !excluded.has(w));
    const from = candidates.length > 0 ? candidates : window;
    return from[Math.floor(Math.random() * from.length)];
  }

  /**
   * The first `limit` candidate secrets in descending corpus frequency. The
   * ordering is load-bearing: `difficulty` works by slicing a prefix of this
   * list, so anything that rewrites the pool must preserve it.
   */
  candidates(limit = Number.POSITIVE_INFINITY, source = DEFAULT_SOURCE): string[] {
    const pool = this.pool(source);
    return pool.slice(0, Math.min(limit, pool.length));
  }

  /**
   * Cosine similarity between two words, or null if either is out of vocabulary.
   *
   * Unlike `rank`, this builds nothing and caches nothing: rows are already
   * unit-normalised, so it is one dot product. That is what makes it usable for
   * scoring a word against a couple of hundred anchors on every guess, where a
   * rank table per anchor would be absurd.
   */
  similarity(a: string, b: string): number | null {
    const ia = this.#pack.index.get(a);
    const ib = this.#pack.index.get(b);
    if (ia === undefined || ib === undefined) return null;
    const { matrix, dim } = this.#pack;
    const oa = ia * dim;
    const ob = ib * dim;
    let acc = 0;
    for (let i = 0; i < dim; i++) acc += matrix[oa + i] * matrix[ob + i];
    return acc;
  }

  /** Rank of `guess` against `secret`, or null if the guess is out of vocabulary. */
  rank(secret: string, guess: string): number | null {
    const id = this.#pack.index.get(guess);
    if (id === undefined) return null;
    return this.table(secret).rankOf[id];
  }

  /** The `count` words closest to `secret`, nearest first, excluding the secret. */
  nearest(secret: string, count: number): string[] {
    const table = this.table(secret);
    const out: string[] = [];
    for (let r = 0; r < table.order.length && out.length < count; r++) {
      const id = table.order[r];
      if (id === table.secretId) continue;
      out.push(this.#pack.words[id]);
    }
    return out;
  }

  /** The word at exactly `rank` (1-based), or null if out of range. */
  wordAtRank(secret: string, rank: number): string | null {
    const table = this.table(secret);
    if (rank < 1 || rank > table.order.length) return null;
    return this.#pack.words[table.order[rank - 1]];
  }

  /**
   * Find a hint word sitting near `targetRank`. Walks outward from the target
   * until it finds a word the board has not already seen, preferring words
   * closer to the secret when both directions are equally far. Never returns the
   * secret itself, and never returns anything at or beyond `maxRank` — that
   * guarantees a hint is always an improvement on what the board already has.
   *
   * When `source` names a pool, we first look for a hint drawn from that pool
   * within a band around the target, so a custom game hints with custom
   * vocabulary rather than dropping an unrelated everyday word into a room full
   * of product language. If the pool has nothing suitable in range we fall back
   * to the whole vocabulary — a slightly off-theme hint beats no hint.
   */
  hintAt(
    secret: string,
    targetRank: number,
    taken: Set<string>,
    maxRank: number = Number.POSITIVE_INFINITY,
    source?: string,
  ): string | null {
    const table = this.table(secret);
    const total = table.order.length;
    // Rank 1 is the answer, so hints live in [2, cap].
    const cap = Math.min(Math.floor(maxRank) - 1, total);
    if (cap < 2) return null;
    const start = Math.min(Math.max(2, Math.round(targetRank)), cap);

    // Pass one: stay inside the themed pool, within a 3x band of the target so
    // the hint is still roughly the strength the caller asked for.
    if (source && source !== DEFAULT_SOURCE) {
      const preferred = this.#poolSets.get(source);
      if (preferred && preferred.size > 0) {
        const low = Math.max(2, Math.floor(start / 3));
        const high = Math.min(cap, start * 3);
        const hit = this.#scanOutward(table, start, low, high, taken, preferred);
        if (hit) return hit;
      }
    }

    return this.#scanOutward(table, start, 2, cap, taken, null);
  }

  /** Walk outward from `start` within [low, high], nearest-to-the-answer first. */
  #scanOutward(
    table: RankTable,
    start: number,
    low: number,
    high: number,
    taken: Set<string>,
    restrictTo: Set<string> | null,
  ): string | null {
    const span = Math.max(high - start, start - low);
    for (let spread = 0; spread <= span; spread++) {
      const probes = spread === 0 ? [start] : [start - spread, start + spread];
      for (const r of probes) {
        if (r < low || r > high) continue;
        const id = table.order[r - 1];
        if (id === table.secretId) continue;
        const word = this.#pack.words[id];
        if (taken.has(word)) continue;
        if (restrictTo && !restrictTo.has(word)) continue;
        return word;
      }
    }
    return null;
  }

  /** Build (or fetch) the rank table for `secret`. */
  table(secret: string): RankTable {
    const cached = this.#cache.get(secret);
    if (cached) {
      // Refresh LRU position.
      this.#cache.delete(secret);
      this.#cache.set(secret, cached);
      return cached;
    }

    const secretId = this.#pack.index.get(secret);
    if (secretId === undefined) throw new Error(`secret word not in vocabulary: ${secret}`);

    const table = this.#build(secret, secretId);
    this.#cache.set(secret, table);
    while (this.#cache.size > this.#cacheSize) {
      const oldest = this.#cache.keys().next();
      if (oldest.done) break;
      this.#cache.delete(oldest.value);
    }
    return table;
  }

  #build(secret: string, secretId: number): RankTable {
    const { matrix, dim, count } = this.#pack;
    const sims = new Float32Array(count);
    const base = secretId * dim;

    // Rows are unit-normalised at ingest time, so cosine == dot product.
    for (let w = 0; w < count; w++) {
      const off = w * dim;
      let acc = 0;
      for (let i = 0; i < dim; i++) acc += matrix[off + i] * matrix[base + i];
      sims[w] = acc;
    }

    const order = new Int32Array(count);
    for (let i = 0; i < count; i++) order[i] = i;
    // Descending similarity; ties broken by frequency (lower id = more common).
    order.sort((a, b) => {
      const d = sims[b] - sims[a];
      return d !== 0 ? d : a - b;
    });

    const rankOf = new Int32Array(count);
    for (let r = 0; r < count; r++) rankOf[order[r]] = r + 1;

    return { secret, secretId, rankOf, order };
  }
}

/**
 * Default secret pool: keep the vocabulary's frequency order (so `difficulty`
 * means something) but drop function words, very short words, and adverbs, which
 * all make frustrating targets.
 */
function derivePool(words: string[]): string[] {
  const pool: string[] = [];
  for (const w of words) {
    if (w.length < 4 || w.length > 14) continue;
    if (SECRET_STOPWORDS.has(w)) continue;
    if (w.endsWith("ly")) continue;
    pool.push(w);
  }
  return pool;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export const DEFAULT_PACK_PATH = "data/vectors.bin";
export const SECRET_POOL_PATH = "data/secret-words.txt";

export class MissingPackError extends Error {
  constructor(public path: string) {
    super(
      `No embedding pack at ${path}.\n\n` +
        `  Quick start (synthetic vectors, instant):   deno task ingest --sample\n` +
        `  Real vectors (large one-time download):     deno task ingest\n`,
    );
    this.name = "MissingPackError";
  }
}

/**
 * Load the pack and, if present, the curated pool. Pass `poolPath: null` to
 * force the frequency-derived pool — which is what the curation script wants, so
 * that re-running it curates the original pool rather than its own output.
 */
export async function loadRanker(
  packPath = DEFAULT_PACK_PATH,
  poolPath: string | null = SECRET_POOL_PATH,
  options: { cacheSize?: number } = {},
): Promise<Ranker> {
  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(packPath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) throw new MissingPackError(packPath);
    throw err;
  }
  const pack = decodePack(bytes);

  const secretPool = poolPath === null ? undefined : await readWordList(poolPath);

  // Named pools for the non-default word sources. A missing file simply means
  // that source is unavailable; the lobby disables it rather than erroring.
  const pools: Record<string, string[]> = {};
  for (const [key, source] of Object.entries(WORD_SOURCES)) {
    const file = (source as { file: string | null }).file;
    if (!file || key === DEFAULT_SOURCE) continue;
    const words = await readWordList(file);
    if (words) pools[key] = words;
  }

  return new Ranker(pack, { secretPool, pools, cacheSize: options.cacheSize });
}

/** Read a `# comment`-tolerant word list, preserving order. Null if absent. */
export async function readWordList(path: string): Promise<string[] | undefined> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return undefined;
    throw err;
  }
  const words = text
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  return words.length > 0 ? words : undefined;
}
